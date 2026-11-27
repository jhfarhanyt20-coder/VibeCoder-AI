/* ---------- model label ---------- */
async function loadModelLabel() {
  // Restore the user's own model choice first — it must survive an app restart.
  try {
    const saved = localStorage.getItem("vibecoder.model")
    if (saved) {
      state.selectedModel = saved
      $("model-label").textContent = saved.split("/").slice(1).join("/") || saved
      updateUsageRing()
    }
  } catch {}
  try {
    const info = await vibe.info()
    if (info.ok) state.mode = info.data.mode
    if (state.selectedModel) return
    const def = info.ok ? info.data?.model : null
    if (typeof def === "string" && def.includes("/")) {
      $("model-label").textContent = def.split("/")[1]
    }
  } catch {}
}

/* ---------- auth status in settings nav ---------- */
async function loadAuthInfo() {
  if (VIBECODER_ACCOUNT_COMING_SOON) {
    $("nav-avatar").textContent = "AI"
    $("nav-user").textContent = "BDCoder AI — coming soon"
    $("nav-user").title = "Your own BDCoder AI API host is coming soon"
    return
  }
  try {
    const res = await vibe.authStatus()
    if (res.ok && res.data?.connected && res.data?.email) {
      const email = res.data.email
      const initials = email.slice(0, 2).toUpperCase()
      $("nav-avatar").textContent = initials
      $("nav-user").textContent = email
      $("nav-user").title = res.data.org || ""
    } else {
      $("nav-avatar").textContent = "?"
      $("nav-user").textContent = "Not connected"
    }
  } catch {
    $("nav-avatar").textContent = "?"
    $("nav-user").textContent = "Not connected"
  }
}

/* ---------- OpenCode CLI version (ships with the app) ---------- */
// The app carries its own CLI, so it also runs on a PC without a global
// OpenCode install. The gate below only warns when an *external* CLI (dev /
// older install) is a different major version than the bundled client expects.
let cliWarned = false

async function refreshCliStatus() {
  const desc = document.getElementById("cli-desc")
  const fix = document.getElementById("cli-fix")
  if (!desc || !vibe.cliInfo) return
  const res = await vibe.cliInfo()
  if (!res || res.ok === false) {
    desc.textContent = "Status unknown"
    if (fix) fix.hidden = true
    return
  }
  const info = res.data || {}
  if (info.mode !== "cli") {
    desc.textContent = "Embedded SDK backend - no CLI in use"
    if (fix) fix.hidden = true
    return
  }
  const source =
    info.source === "bundled"
      ? "bundled with the app"
      : info.source === "local"
        ? "project dependency"
        : info.source === "env"
          ? "custom path (OPENCODE_CLI)"
          : "installed on this PC"
  const shown = info.parsed || String(info.version || "").replace(/^opencode\s*/i, "") || "unknown"
  desc.textContent = `v${shown} (${source})` + (info.compatible ? "" : ` - tested: v${info.expected}`)
  if (fix) fix.hidden = !(info.canInstall && !info.compatible)
  if (info.compatible) {
    hideError("cli")
    return
  }
  if (!cliWarned) {
    cliWarned = true
    showError(
      "OpenCode CLI version",
      `v${shown} is not the tested version (v${info.expected}). Some features (chat, sessions, provider login) may not work.`,
      { key: "cli" },
    )
  }
}

const cliFixBtn = document.getElementById("cli-fix")
if (cliFixBtn) {
  cliFixBtn.onclick = async () => {
    const desc = document.getElementById("cli-desc")
    cliFixBtn.disabled = true
    const label = cliFixBtn.textContent
    cliFixBtn.textContent = "Installing…"
    const res = await vibe.cliInstallTested()
    cliFixBtn.disabled = false
    cliFixBtn.textContent = label
    if (!res || res.ok === false) {
      showError("OpenCode CLI update failed", (res && res.error) || "unknown error", { key: "cli" })
      return
    }
    cliFixBtn.hidden = true
    if (desc) desc.textContent = "Installed - restart the app to use the new CLI"
    hideError("cli")
  }
}

/* ---------- OpenCode release check (read-only, never installs) ---------- */
// The CLI + client + SDK are pinned in package.json and ship inside the EXE.
// Upgrading is a developer action (bump the pins, test, rebuild), so the app
// only reports when npm has something newer - it never downloads anything.
function cliUpdateText(report) {
  if (!report || report.ok === false) {
    const pinned = report && report.pinned && report.pinned.cli
    return `Could not reach the npm registry${report && report.error ? ` (${report.error})` : ""}.` +
      (pinned ? ` Pinned: v${pinned}.` : "")
  }
  const when = report.checkedAt ? new Date(report.checkedAt).toLocaleString() : ""
  const changed = (report.packages || []).filter((p) => p.status === "update")
  if (!changed.length) {
    return `Up to date - pinned CLI v${report.pinned && report.pinned.cli} (checked ${when}).`
  }
  const list = changed.map((p) => `${p.name} ${p.pinned} -> ${p.latest}`).join(" · ")
  const risk = report.majorChange
    ? " Major change: the CLI can remove API endpoints the app uses - read its changelog first."
    : report.kind === "minor"
      ? " Minor release: usually safe, still run the tests."
      : " Patch release: usually safe."
  return `Update available - ${list}.${risk} Bump the three pins, run npm test, rebuild the EXE.`
}

async function refreshCliUpdates({ force = false } = {}) {
  const desc = document.getElementById("cli-update-desc")
  const btn = document.getElementById("cli-update-check")
  const dot = document.getElementById("cli-update-dot")
  if (!desc || !vibe.cliUpdateCheck) return null
  if (force && btn) {
    btn.disabled = true
    btn.textContent = "Checking…"
  }
  let report = null
  try {
    const res = await vibe.cliUpdateCheck({ force })
    if (!res || res.ok === false) throw new Error((res && res.error) || "unknown error")
    report = res.data || {}
  } catch (err) {
    desc.textContent = `Could not check for updates: ${(err && err.message) || err}`
    if (dot) dot.hidden = true
    return null
  } finally {
    if (force && btn) {
      btn.disabled = false
      btn.textContent = "Check now"
    }
  }
  desc.textContent = cliUpdateText(report)
  if (dot) dot.hidden = !(report && report.updateAvailable)
  return report
}

const cliUpdateBtn = document.getElementById("cli-update-check")
if (cliUpdateBtn) cliUpdateBtn.onclick = () => refreshCliUpdates({ force: true })

/* ---------- Settings → General → trusted project tools ---------- */
async function refreshTrustList() {
  const list = document.getElementById("trust-list")
  const btn = document.getElementById("trust-refresh")
  if (!list || !vibe.trustList) return []
  if (btn) btn.disabled = true
  let projects = []
  try {
    const res = await vibe.trustList()
    if (!res || res.ok === false) throw new Error((res && res.error) || "unknown error")
    projects = (res.data && res.data.projects) || []
  } catch (err) {
    list.innerHTML = ""
    const row = document.createElement("div")
    row.className = "trust-empty"
    row.textContent = `Could not load trusted workspaces: ${(err && err.message) || err}`
    list.appendChild(row)
    return []
  } finally {
    if (btn) btn.disabled = false
  }
  list.innerHTML = ""
  if (!projects.length) {
    const empty = document.createElement("div")
    empty.className = "trust-empty"
    empty.textContent = "No workspace is trusted yet. Approve one when BDCoder asks about project extensions, plugins or MCP servers."
    list.appendChild(empty)
    return projects
  }
  for (const project of projects) {
    const row = document.createElement("div")
    row.className = "trust-row"
    const name = document.createElement("div")
    name.className = "tr-path"
    name.textContent = project.directory
    name.title = project.directory
    const meta = document.createElement("div")
    meta.className = "tr-meta" + (project.current ? "" : " tr-stale")
    if (project.current) meta.textContent = `${project.files} file${project.files === 1 ? "" : "s"}`
    else meta.textContent = "Changed since approval"
    const revoke = document.createElement("button")
    revoke.type = "button"
    revoke.className = "save-btn ghost"
    revoke.textContent = "Revoke"
    revoke.onclick = async () => {
      revoke.disabled = true
      try {
        await vibe.trustRevoke({ directory: project.directory })
      } catch (err) {
        revoke.disabled = false
        meta.className = "tr-meta tr-stale"
        meta.textContent = `Revoke failed: ${(err && err.message) || err}`
        return
      }
      await refreshTrustList()
    }
    row.append(name, meta, revoke)
    list.appendChild(row)
  }
  return projects
}

const trustRefreshBtn = document.getElementById("trust-refresh")
if (trustRefreshBtn) trustRefreshBtn.onclick = () => refreshTrustList()

// One quiet check after startup (answers are cached for 6 h in the main
// process), plus a refresh whenever the settings page opens.
setTimeout(() => { refreshCliUpdates().catch(() => {}) }, 8000)

/* ---------- desktop app auto-updates (stable channel, production) ---------- */
// Entirely separate from the CLI update screen above. Talks only through the
// preload bridge (vibe.checkForAppUpdate / downloadAppUpdate / installAppUpdate
// / onAppUpdateEvent) - never directly to electron-updater.
let appUpdateState = { enabled: false, version: null, state: "idle", payload: null, lastCheckedAt: null, prefs: { autoCheck: true, autoDownload: true } }
let appUpdateOff = null
let appUpdateBusy = false

function fmtVersion(v) { return v ? `v${v}` : "—" }
function fmtLastChecked(ts) {
  if (!ts) return "Never"
  const d = new Date(ts)
  if (isNaN(d.getTime())) return "Never"
  return d.toLocaleString()
}
function clampPercent(p) { const n = Number(p) || 0; return Math.max(0, Math.min(100, n)) }

function setToggle(el, on) {
  if (!el) return
  el.classList.toggle("on", !!on)
  el.setAttribute("aria-checked", on ? "true" : "false")
}

function showAppUpdateRow(name, show) {
  const el = document.getElementById(name)
  if (el) el.hidden = !show
}

function renderAppUpdateStatus() {
  const status = document.getElementById("app-update-status")
  const chip = document.getElementById("app-update-version-chip")
  const installed = document.getElementById("app-update-installed")
  const latest = document.getElementById("app-update-latest")
  const last = document.getElementById("app-update-last-checked")
  const dot = document.getElementById("app-update-dot")
  const notesCard = document.getElementById("app-update-notes-card")
  const notes = document.getElementById("app-update-notes")

  const s = appUpdateState
  if (chip) chip.textContent = fmtVersion(s.version)
  if (installed) installed.textContent = fmtVersion(s.version)

  // Status line
  let statusText = "Updates unavailable (source build)."
  if (s.enabled) {
    switch (s.state) {
      case "checking": statusText = "Checking for the latest stable release…"; break
      case "update-available": statusText = `Update available: ${fmtVersion(s.payload?.version)} — click Update Now`; break
      case "update-not-available": statusText = "You're on the latest stable release."; break
      case "downloading": statusText = "Downloading update…"; break
      case "downloaded":
      case "update-downloaded": statusText = "Download complete — ready to install."; break
      case "error": statusText = "Update check could not complete."; break
      case "disabled": statusText = "Updates are only available in the packaged app."; break
      default: statusText = "Idle."
    }
  }
  if (status) status.textContent = statusText

  // Latest / dot
  if (latest) latest.textContent = s.payload?.version ? fmtVersion(s.payload.version) : "—"
  if (dot) dot.hidden = !(s.state === "update-available" || s.state === "downloading" || s.state === "update-downloaded")
  if (last) last.textContent = fmtLastChecked(s.lastCheckedAt)

  // Release notes
  const hasNotes = s.payload?.notes
  if (notesCard) notesCard.hidden = !hasNotes
  if (notes) notes.textContent = hasNotes || ""
}

function renderAppUpdateActions() {
  const actionCard = document.getElementById("app-update-action-card")
  const progressRow = document.getElementById("app-update-progress-row")
  const installRow = document.getElementById("app-update-install-row")
  const errorRow = document.getElementById("app-update-error-row")
  const progressText = document.getElementById("app-update-progress-text")
  const progressFill = document.getElementById("app-update-progress-fill")
  const checkBtn = document.getElementById("app-update-check")
  const installBtn = document.getElementById("app-update-install")
  const downloadBtn = document.getElementById("app-update-download")

  const s = appUpdateState
  if (!actionCard) return
  actionCard.hidden = !(s.state === "update-available" || s.state === "downloading" || s.state === "update-downloaded" || s.state === "error")

  showAppUpdateRow("app-update-available-row", s.state === "update-available")
  showAppUpdateRow("app-update-progress-row", s.state === "downloading")
  showAppUpdateRow("app-update-install-row", s.state === "update-downloaded")
  showAppUpdateRow("app-update-error-row", s.state === "error")

  if (progressText && progressFill) {
    const p = s.state === "downloading" ? clampPercent(s.payload?.percent) : 0
    progressText.textContent = s.state === "downloading" ? `${p}%` : ""
    progressFill.style.width = `${p}%`
  }
  if (checkBtn) checkBtn.disabled = appUpdateBusy || s.state === "downloading"
  if (installBtn) installBtn.disabled = appUpdateBusy
  if (downloadBtn) downloadBtn.disabled = appUpdateBusy || s.state === "downloading"
}

function applyAppUpdateEvent(ev) {
  if (!ev || !ev.type) return
  if (ev.type === "prefs") { if (ev.payload) appUpdateState.prefs = { ...appUpdateState.prefs, ...ev.payload }; setToggle($("toggle-app-auto-check"), appUpdateState.prefs.autoCheck); setToggle($("toggle-app-auto-download"), appUpdateState.prefs.autoDownload); renderAppUpdateStatus(); return }
  // electron-updater emits download-progress many times. Keep one stable
  // "downloading" state so the progress card never disappears mid-download.
  const type = ev.type === "download-progress" ? "downloading" : ev.type === "update-cancelled" ? "idle" : ev.type
  appUpdateState.state = type
  if (type === "downloading") appUpdateState.payload = { ...(appUpdateState.payload || {}), ...(ev.payload || {}) }
  else appUpdateState.payload = ev.payload || null
  if (type === "checking") appUpdateBusy = true
  else if (type === "error") { appUpdateBusy = false; const message = ev.payload?.message || ev.payload?.error; if (message) { const et = document.getElementById("app-update-error-text"); if (et) et.textContent = message } }
  else if (type === "update-not-available" || type === "update-available") { appUpdateBusy = false }
  else if (type === "downloading") { appUpdateBusy = true }
  else if (type === "update-downloaded" || type === "idle") { appUpdateBusy = false }
  renderAppUpdateStatus()
  renderAppUpdateActions()
}

async function refreshAppUpdateStatus() {
  if (!vibe.appUpdateStatus) return
  try {
    const res = await vibe.appUpdateStatus()
    if (!res || res.ok === false) throw new Error((res && res.error) || "unknown error")
    appUpdateState = res.data || appUpdateState
    if (!appUpdateState.prefs) appUpdateState.prefs = { autoCheck: true, autoDownload: true }
    setToggle($("toggle-app-auto-check"), appUpdateState.prefs.autoCheck)
    setToggle($("toggle-app-auto-download"), appUpdateState.prefs.autoDownload)
    renderAppUpdateStatus()
    renderAppUpdateActions()
  } catch (err) {
    const status = document.getElementById("app-update-status")
    if (status) status.textContent = `Could not load update status: ${(err && err.message) || err}`
  }
}

async function doAppUpdateCheck() {
  if (!vibe.checkForAppUpdate || appUpdateBusy) return
  appUpdateBusy = true
  const btn = document.getElementById("app-update-check")
  if (btn) { btn.disabled = true; btn.textContent = "Checking…" }
  try {
    await vibe.checkForAppUpdate({})
    // Wait for the async events (update-available / not-available / error) to
    // arrive through onAppUpdateEvent; they repaint the UI.
  } catch (err) {
    const et = document.getElementById("app-update-error-text")
    if (et) et.textContent = (err && err.message) || String(err)
    appUpdateState.state = "error"
    renderAppUpdateActions()
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Check for Updates" }
  }
}

async function doAppUpdateDownload() {
  if (!vibe.downloadAppUpdate || appUpdateBusy) return
  appUpdateBusy = true
  const btn = document.getElementById("app-update-download")
  if (btn) { btn.disabled = true; btn.textContent = "Updating…" }
  appUpdateState.state = "downloading"
  appUpdateState.payload = { ...(appUpdateState.payload || {}), percent: 0 }
  renderAppUpdateStatus()
  renderAppUpdateActions()
  try {
    const res = await vibe.downloadAppUpdate()
    if (!res || res.ok === false) throw new Error((res && res.error) || "Could not download the update")
  } catch (err) {
    const et = document.getElementById("app-update-error-text")
    if (et) et.textContent = (err && err.message) || String(err)
    appUpdateState.state = "error"
  } finally {
    appUpdateBusy = false
    if (btn) { btn.disabled = false; btn.textContent = "Update Now" }
    renderAppUpdateActions()
  }
}

async function doAppUpdateInstall() {
  if (!vibe.installAppUpdate) return
  const s = appUpdateState
  const version = s.payload?.version ? "v" + s.payload.version : ""
  // Ask for explicit consent before restarting. Never force an update.
  const ok = await showDialog({
    title: "Install & restart",
    message: `Install ${version} now? The app will close and reopen on the new version.\n\nYour data (sessions, providers, API keys, skills, plugins) is kept untouched.`,
    okText: "Install & Restart",
    cancelText: "Later",
  })
  if (!ok) return
  try {
    const res = await vibe.installAppUpdate()
    if (!res || res.ok === false) {
      const msg = (res && res.error) || "Could not install the update"
      const et = document.getElementById("app-update-error-text")
      if (et) et.textContent = msg
      appUpdateState.state = "error"
      renderAppUpdateActions()
    }
    // On success the app restarts immediately (main process refuses if a run is active).
  } catch (err) {
    const et = document.getElementById("app-update-error-text")
    if (et) et.textContent = (err && err.message) || String(err)
    appUpdateState.state = "error"
    renderAppUpdateActions()
  }
}

function wireAppUpdates() {
  if (!vibe.appUpdateStatus && !vibe.onAppUpdateEvent) return
  if (appUpdateOff) { try { appUpdateOff() } catch {}; appUpdateOff = null }
  if (vibe.onAppUpdateEvent) appUpdateOff = vibe.onAppUpdateEvent(applyAppUpdateEvent)

  const checkBtn = document.getElementById("app-update-check")
  if (checkBtn) checkBtn.onclick = doAppUpdateCheck
  const downloadBtn = document.getElementById("app-update-download")
  if (downloadBtn) downloadBtn.onclick = doAppUpdateDownload
  const installBtn = document.getElementById("app-update-install")
  if (installBtn) installBtn.onclick = doAppUpdateInstall
  const laterBtn = document.getElementById("app-update-later")
  if (laterBtn) laterBtn.onclick = () => { appUpdateState.state = "idle"; renderAppUpdateActions() }
  const dismissBtn = document.getElementById("app-update-dismiss")
  if (dismissBtn) dismissBtn.onclick = () => { if (appUpdateBusy) return; appUpdateState.state = "idle"; renderAppUpdateActions() }
  const retryBtn = document.getElementById("app-update-retry")
  if (retryBtn) retryBtn.onclick = doAppUpdateCheck

  // Toggles
  const autoCheck = document.getElementById("toggle-app-auto-check")
  if (autoCheck && vibe.appUpdateSetPrefs) autoCheck.onclick = () => {
    const on = !autoCheck.classList.contains("on")
    setToggle(autoCheck, on)
    appUpdateState.prefs.autoCheck = on
    vibe.appUpdateSetPrefs({ autoCheck: on }).catch(() => {})
  }
  const autoDownload = document.getElementById("toggle-app-auto-download")
  if (autoDownload && vibe.appUpdateSetPrefs) autoDownload.onclick = () => {
    const on = !autoDownload.classList.contains("on")
    setToggle(autoDownload, on)
    appUpdateState.prefs.autoDownload = on
    vibe.appUpdateSetPrefs({ autoDownload: on }).catch(() => {})
  }

  refreshAppUpdateStatus().catch(() => {})
}
wireAppUpdates()

/* ---------- dev-only: upgrade + rebuild from inside the app ---------- */
// scripts/upgrade-opencode.cjs bumps the three pins, patches TESTED_CLI_VERSION,
// runs npm test and npm run dist. Only available when the app runs from the
// source tree: a packaged EXE has no build toolchain (and cannot replace the
// .exe that is currently running).
let upgradeWired = false
let upgradeRunning = false

function appendUpgradeLog(line) {
  const pre = document.getElementById("upgrade-log")
  if (!pre || !line) return
  pre.textContent = (pre.textContent ? pre.textContent + "\n" : "") + line
  const lines = pre.textContent.split("\n")
  if (lines.length > 400) pre.textContent = lines.slice(-400).join("\n")
  pre.scrollTop = pre.scrollHeight
}

function setUpgradeBusy(running, label) {
  upgradeRunning = running
  const btn = document.getElementById("btn-upgrade")
  if (!btn) return
  btn.disabled = running
  btn.textContent = running ? label || "Running…" : "Upgrade & rebuild"
}

async function refreshUpgradeCard() {
  const row = document.getElementById("row-upgrade")
  const wrap = document.getElementById("upgrade-log-wrap")
  const desc = document.getElementById("upgrade-desc")
  if (!row || !vibe.upgradeInfo) return
  let info = {}
  try {
    const res = await vibe.upgradeInfo()
    info = (res && res.data) || {}
  } catch {
    row.hidden = true
    return
  }
  if (!info.canUpgrade) {
    row.hidden = true
    if (wrap) wrap.hidden = true
    return
  }
  row.hidden = false
  const log = document.getElementById("upgrade-log")
  if (wrap) wrap.hidden = false
  if (log && !log.textContent && Array.isArray(info.log) && info.log.length) {
    log.textContent = info.log.slice(-120).join("\n")
    log.scrollTop = log.scrollHeight
  }
  if (!upgradeWired) {
    upgradeWired = true
    if (vibe.onUpgradeLog) vibe.onUpgradeLog((line) => appendUpgradeLog(line))
    if (vibe.onUpgradeDone) {
      vibe.onUpgradeDone((r) => {
        setUpgradeBusy(false)
        if (desc) {
          desc.textContent = r && r.ok
            ? `Done. New installer: ${r.installer || "see the dist folder"}. Install it to run the new build.`
            : `Failed: ${(r && r.error) || "unknown error"}. The previous files are backed up in .vibecoder/upgrades.`
        }
        if (r && r.ok) refreshCliUpdates({ force: true }).catch(() => {})
        else showError("OpenCode upgrade failed", (r && r.error) || "unknown error", { key: "upgrade" })
      })
    }
  }
  if (upgradeRunning) setUpgradeBusy(true)
  else if (!info.running && desc && info.ok === false && info.error) {
    desc.textContent = `Last run failed: ${info.error}`
  }
}

const upgradeBtn = document.getElementById("btn-upgrade")
if (upgradeBtn) {
  upgradeBtn.onclick = async () => {
    const desc = document.getElementById("upgrade-desc")
    const preset = document.getElementById("cli-update-preset")
    const version = (preset && preset.value ? preset.value.trim() : "") || ""
    const ok = await showConfirm(
      `This runs, in ${"the source tree"}: npm install --save-exact @opencode/{cli,client,sdk}@${version || "latest"}, npm test and npm run dist. ` +
        "It takes roughly 10 minutes and needs about 2 GB free RAM. The app stays open - install the new installer afterwards.",
      "Upgrade OpenCode and rebuild?",
      "Upgrade",
    )
    if (!ok) return
    const log = document.getElementById("upgrade-log")
    if (log) log.textContent = ""
    if (desc) desc.textContent = "Running the upgrade script…"
    setUpgradeBusy(true, "Upgrading…")
    const res = await vibe.startUpgrade({ version })
    if (!res || res.ok === false) {
      setUpgradeBusy(false)
      const msg = (res && res.error) || "unknown error"
      if (desc) desc.textContent = `Could not start: ${msg}`
      showError("OpenCode upgrade", msg, { key: "upgrade" })
    }
  }
}

/* ---------- settings (full page) ---------- */
const settings = $("settings")

function openSettings() {
  settings.hidden = false
  refreshCliStatus()
  refreshCliUpdates().catch(() => {})
  refreshTrustList().catch(() => {})
  vibe.info().then((info) => {
    const sel = document.getElementById("setting-backend")
    if (sel && info.ok) sel.value = info.data.mode
    const def = info.data?.model
    if (typeof def === "string" && def.includes("/")) {
      const m = document.getElementById("setting-model")
      if (m) m.textContent = def.split("/")[1]
    }
  })
}

function closeSettings() {
  settings.hidden = true
}

$("btn-settings").onclick = openSettings
$("btn-back").onclick = closeSettings

// Sidebar "Marketplace": opens the settings page on the marketplace tab.
if ($("btn-marketplace")) {
  $("btn-marketplace").onclick = () => {
    openSettings()
    const nav = document.querySelector('.settings-nav .nav-item[data-page="marketplace"]')
    if (nav) nav.click()
    else showError("Marketplace", "The marketplace page is not available", { key: "marketplace" })
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settings.hidden) closeSettings()
})
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ",") {
    e.preventDefault()
    if (settings.hidden) openSettings()
  }
})

// Settings nav: switch right-hand page + active state
const settingsNav = document.querySelector(".settings-nav")
const settingsContent = $("settings-content")

settingsNav.querySelectorAll(".nav-item").forEach((item) => {
  item.onclick = () => {
    const page = item.dataset.page
    settingsNav.querySelectorAll(".nav-item").forEach((i) => i.classList.remove("active"))
    item.classList.add("active")
    settingsContent.querySelectorAll(".s-page").forEach((p) => {
      p.hidden = p.dataset.page !== page
    })
    settingsContent.scrollTop = 0
    // Load live data for pages backed by the OpenCode config
    if (page === "commands") loadCommandsPage()
    if (page === "hooks") loadHooksPage()
    if (page === "mcp") loadMcp()
    if (page === "plugins") loadPlugins()
    if (page === "marketplace") loadMarketplace()
    if (page === "memory") loadMemory()
    if (page === "subagents") loadAgents()
    if (page === "browser-use") loadBrowserUse()
    if (page === "browser-use") loadBrowserUse()
    if (page === "model-settings") { loadProviders(); loadFallbackState() }
    if (page === "general") refreshTrustList()
    if (page === "skills") loadSkills()
    if (page === "usage") loadUsage()
    if (page === "app-updates") refreshAppUpdateStatus()
  }
})



/* ---------- Settings → Commands / Hooks (read-only lists) ---------- */
function xsRow(title, sub, tags) {
  const row = document.createElement("div")
  row.className = "kbd-row"
  const left = document.createElement("div")
  const name = document.createElement("div")
  name.className = "kbd-name"
  name.textContent = title
  left.appendChild(name)
  if (sub) {
    const d = document.createElement("div")
    d.className = "kbd-desc"
    d.textContent = sub
    left.appendChild(d)
  }
  const right = document.createElement("div")
  right.className = "xs-tags"
  for (const t of tags) {
    const tag = document.createElement("code")
    tag.className = "xs-tag" + (t.bad ? " bad" : "")
    tag.textContent = t.text
    right.appendChild(tag)
  }
  row.append(left, right)
  return row
}
function xsEmpty(box, text) {
  box.textContent = ""
  const e = document.createElement("div")
  e.className = "xs-empty"
  e.textContent = text
  box.appendChild(e)
}
async function loadCommandsPage() {
  const box = $("commands-list")
  if (!box || typeof vibe.commandsList !== "function") return
  try {
    const res = await vibe.commandsList()
    const data = res && res.ok === false ? null : (res?.data ?? res)
    const list = Array.isArray(data?.list) ? data.list : []
    if (!list.length) return xsEmpty(box, "No commands yet. Add a .md file to the commands folder and it shows up here and in the / menu.")
    box.textContent = ""
    for (const c of list) box.appendChild(xsRow(`/${c.id}`, c.description || "", [{ text: c.scope === "project" ? "this project" : "every project" }]))
  } catch (e) {
    xsEmpty(box, "Could not read the commands: " + String(e?.message || e))
  }
}
async function loadHooksPage() {
  const box = $("hooks-list")
  if (!box || typeof vibe.hooksList !== "function") return
  try {
    const res = await vibe.hooksList()
    const data = res && res.ok === false ? null : (res?.data ?? res)
    const list = Array.isArray(data?.list) ? data.list : []
    if (!list.length) return xsEmpty(box, "No extensions yet. Add a .js file to the extensions folder; its hooks are listed here.")
    box.textContent = ""
    for (const h of list) {
      const tags = h.ok ? (h.hooks.length ? h.hooks.map((x) => ({ text: x })) : [{ text: "no hooks" }]) : [{ text: "failed to load", bad: true }]
      const sub = h.ok ? `${h.scope === "project" ? "This project" : "Every project"} · ${h.tools} tool${h.tools === 1 ? "" : "s"}` : h.error
      box.appendChild(xsRow(h.id, sub, tags))
    }
  } catch (e) {
    xsEmpty(box, "Could not read the extensions: " + String(e?.message || e))
  }
}
$("btn-commands-refresh")?.addEventListener("click", loadCommandsPage)
$("btn-hooks-refresh")?.addEventListener("click", loadHooksPage)
$("btn-commands-folder")?.addEventListener("click", () => vibe.openSettingsFolder?.({ kind: "commands" }).catch((e) => showError("Could not open the folder", String(e?.message || e))))
$("btn-hooks-folder")?.addEventListener("click", () => vibe.openSettingsFolder?.({ kind: "hooks" }).catch((e) => showError("Could not open the folder", String(e?.message || e))))
