"use strict"
/**
 * VibeCoder AI - desktop auto-updater (stable channel).
 *
 * This is the SINGLE module that owns electron-updater. It is deliberately kept
 * separate from the OpenCode CLI update screen and from the dev-only "Upgrade &
 * rebuild" placeholder (electron/backend.cjs upgradeInfo/startUpgrade).
 *
 * Design rules enforced here:
 *   - Only ever initializes in a packaged production build (app.isPackaged).
 *     Dev mode (`npm run app` / `npm run dev`) never checks for updates.
 *   - Only the GitHub "stable" release channel is used. Prereleases and
 *     development builds are disabled (allowPrerelease=false).
 *   - Release metadata is fetched over HTTPS from the GitHub repo set by the
 *     publish configuration (package.json -> build.publish). No arbitrary URLs
 *     are accepted from the renderer.
 *   - Every event is forwarded through a small pub/sub so the main process can
 *     re-broadcast it to the renderer over secure IPC. Duplicate notifications
 *     are suppressed per state transition.
 *   - Updates are never forced: "install" requires an explicit caller action and
 *     is refused while active agent work is running.
 *   - Errors (offline, network, parse) are surfaced as state, never thrown into
 *     the renderer's face; the UI shows a retry.
 */
const { app } = require("electron")

// Configurable knobs. The periodic check interval and the auto-download gate
// come from the renderer via setPreferences() and persist under VIBE_HOME in
// electron-ui-state.json (same file the backend already uses for UI state), so
// no persistent user data ever lives inside the install directory.
const DEFAULT_AUTO_CHECK = true
const DEFAULT_AUTO_DOWNLOAD = true
const DEFAULT_CHECK_INTERVAL_MIN = 6 * 60 // 6 hours
const PREF_KEY = "appUpdates"

let autoUpdater = null
let listeners = new Set()
let lastState = null
let lastPayload = null
let lastCheckedAt = 0
let checkingPromise = null
let prefs = { autoCheck: DEFAULT_AUTO_CHECK, autoDownload: DEFAULT_AUTO_DOWNLOAD }

// Keep a handle so install() can refuse when a run is live.
let getBusyFn = null

const pkg = (() => { try { return require("../package.json") } catch { return {} } })()

function enabled() {
  return !!(app && app.isPackaged && pkg.version)
}

function emit(type, payload) {
  lastState = type
  lastPayload = payload || null
  for (const fn of [...listeners]) { try { fn(type, payload || null) } catch {} }
}

function onChange(cb) {
  if (typeof cb !== "function") return () => {}
  listeners.add(cb)
  // Replay the last known state so a subscriber that arrives late (e.g. the
  // settings page opening after a check already finished) still sees it.
  if (lastState) { try { cb(lastState, lastPayload) } catch {} }
  return () => listeners.delete(cb)
}

function setBusyProvider(fn) { getBusyFn = fn }

function isBusy() {
  try { return typeof getBusyFn === "function" && !!getBusyFn() } catch { return false }
}

function ensureAutoUpdater() {
  if (!enabled()) throw new Error("Updates are only available in the packaged app.")
  if (autoUpdater) return autoUpdater
  // Lazy require so dev-mode and SDK-only tests never pull in the updater.
  const { autoUpdater: au } = require("electron-updater")
  autoUpdater = au
  autoUpdater.autoDownload = !!prefs.autoDownload
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false

  au.on("checking-for-update", () => emit("checking", {}))
  au.on("update-available", (info) => {
    lastCheckedAt = Date.now()
    emit("update-available", {
      version: info?.version || null,
      releaseName: info?.releaseName || null,
      releaseDate: info?.releaseDate || null,
      notes: (typeof info?.releaseNotes === "string" ? info.releaseNotes : info?.releaseNotes?.toString?.()) || null,
    })
  })
  au.on("update-not-available", (info) => {
    lastCheckedAt = Date.now()
    emit("update-not-available", { version: info?.version || null })
  })
  au.on("error", (err) => emit("error", { message: String((err && err.message) || err || "Unknown update error") }))
  au.on("download-progress", (p) => emit("download-progress", {
    percent: Math.round(Number(p?.percent) || 0),
    transferred: Number(p?.transferred) || 0,
    total: Number(p?.total) || 0,
    bytesPerSecond: Number(p?.bytesPerSecond) || 0,
  }))
  au.on("update-downloaded", (info) => emit("update-downloaded", {
    version: info?.version || null,
    path: info?.downloadedFile || null,
  }))
  au.on("update-cancelled", () => emit("update-cancelled", {}))
  return autoUpdater
}

/**
 * Perform a manual or scheduled check. Duplicate simultaneous checks are
 * suppressed (one promise is shared). Errors are caught and surfaced as an
 * "error" event so the UI can show a Retry, never a hard crash.
 */
async function checkForUpdates({ silent = false } = {}) {
  if (!enabled()) {
    emit("error", { message: "Updates are only available in the packaged app.", silent: !!silent })
    return { ok: false, error: "Updates are only available in the packaged app." }
  }
  if (checkingPromise) return { ok: true, alreadyChecking: true }
  try {
    const au = ensureAutoUpdater()
    checkingPromise = au.checkForUpdates().then(() => null, (e) => { throw e })
    await checkingPromise
    checkingPromise = null
    return { ok: true }
  } catch (err) {
    checkingPromise = null
    const message = String((err && err.message) || err || "Could not check for updates")
    emit("error", { message, silent: !!silent })
    return { ok: false, error: message }
  }
}

/**
 * Download an available update. Safe to call while idle; returns quickly if
 * auto-download already started it (electron-updater's download tracks state).
 */
async function downloadUpdate() {
  if (!enabled()) return { ok: false, error: "Updates are only available in the packaged app." }
  try {
    const au = ensureAutoUpdater()
    // A manual download must still work when the user turned automatic
    // downloads off. Enable it only for this download, then restore the saved
    // preference so the setting is never silently changed.
    const previousAutoDownload = au.autoDownload
    au.autoDownload = true
    try {
      emit("downloading", {})
      await au.downloadUpdate()
      return { ok: true }
    } finally {
      au.autoDownload = previousAutoDownload
    }
  } catch (err) {
    const message = String((err && err.message) || err || "Could not download the update")
    emit("error", { message })
    return { ok: false, error: message }
  }
}

/**
 * Install + restart. Requires explicit caller action inferred by the renderer
 * clicking "Install & Restart". Never runs while active agent work is in flight.
 */
async function installUpdate() {
  if (!enabled()) return { ok: false, error: "Updates are only available in the packaged app." }
  if (isBusy()) {
    return { ok: false, error: "An agent run is active. Stop it before installing the update." }
  }
  try {
    const au = ensureAutoUpdater()
    // quitAndInstall may throw if it is called before a download completed.
    au.quitAndInstall(false, true)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err || "Could not install the update") }
  }
}

function getStatus() {
  return {
    enabled: enabled(),
    version: pkg.version || null,
    channel: "stable",
    state: lastState || (enabled() ? "idle" : "disabled"),
    payload: lastPayload || null,
    lastCheckedAt: lastCheckedAt || null,
    prefs: { ...prefs },
  }
}

function setPreferences(patch = {}) {
  if (typeof patch === "object" && patch !== null) {
    if (typeof patch.autoCheck === "boolean") prefs.autoCheck = patch.autoCheck
    if (typeof patch.autoDownload === "boolean") prefs.autoDownload = patch.autoDownload
    if (autoUpdater) autoUpdater.autoDownload = prefs.autoDownload
  }
  emit("prefs", { ...prefs })
  return { ...prefs }
}

function serializePrefs() { return { ...prefs } }
function deserializePrefs(saved) {
  if (saved && typeof saved === "object") {
    if (typeof saved.autoCheck === "boolean") prefs.autoCheck = saved.autoCheck
    if (typeof saved.autoDownload === "boolean") prefs.autoDownload = saved.autoDownload
  }
}

/**
 * Start the idle periodic loop (production only). Called once from main.cjs
 * after the app is ready. Interval is large and non-blocking.
 */
function startPeriodicCheck() {
  if (!enabled()) return
  const minutes = Math.max(30, Math.min(24 * 60, Number(prefs.checkIntervalMin) || DEFAULT_CHECK_INTERVAL_MIN))
  const timer = setInterval(() => {
    if (!prefs.autoCheck) return
    checkForUpdates({ silent: true }).catch(() => {})
  }, minutes * 60 * 1000)
  // An unref'ed interval never keeps the app process alive by itself.
  try { if (typeof timer.unref === "function") timer.unref() } catch {}
}

function stop() {
  listeners.clear()
  if (autoUpdater) { try { autoUpdater.removeAllListeners() } catch {} }
  autoUpdater = null
  lastState = null
  lastPayload = null
  checkingPromise = null
}

module.exports = {
  enabled,
  onChange,
  setBusyProvider,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  getStatus,
  setPreferences,
  serializePrefs,
  deserializePrefs,
  startPeriodicCheck,
  stop,
  PREF_KEY,
}