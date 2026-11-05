"use strict"
// Controlled unit tests for the desktop auto-updater module (electron/updater.cjs).
// These verify the logic that does NOT require a real packaged app or a real
// GitHub release: enabled() gating, preference persistence, state pub/sub, and
// duplicate-check suppression. Real release integration is NOT run here (the
// task requires that GitHub credentials/repo are configured for that).
const assert = require("node:assert/strict")
const Module = require("node:module")

let passed = 0
let failed = false
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`) }
  catch (e) { failed = true; process.exitCode = 1; console.error(`FAIL ${name}: ${e && e.stack || e}`) }
}

// Fake electron: reports an unpackaged app (dev / SDK mode).
const fakeElectronDev = { app: { isPackaged: false } }
// Fake electron: reports a packaged app so we can exercise the lazy require.
let fakeAUEvents = {}
const fakeAutoUpdater = {
  on(ev, cb) { fakeAUEvents[ev] = cb },
  removeAllListeners() { fakeAUEvents = {} },
  checkForUpdates() { return new Promise((res) => setImmediate(() => res({ promise: true }))) },
  downloadUpdate() { return new Promise((res) => setImmediate(() => res({ downloaded: true }))) },
  quitAndInstall() {},
  set autoDownload(v) {},
  set autoInstallOnAppQuit(v) {},
  set allowPrerelease(v) {},
  set allowDowngrade(v) {},
}
const fakeElectronPackaged = { app: { isPackaged: true } }

const originalLoad = Module._load
let loadedModule = null
Module._load = function (request, parent, isMain) {
  if (request === "electron") return loadedModule
  if (request === "electron-updater") return { autoUpdater: fakeAutoUpdater }
  return originalLoad.call(this, request, parent, isMain)
}
function loadUpdater(electronStub) {
  loadedModule = electronStub
  delete require.cache[require.resolve("../electron/updater.cjs")]
  return require("../electron/updater.cjs")
}

test("enabled() is false in dev/unpackaged mode", () => {
  const u = loadUpdater(fakeElectronDev)
  assert.equal(u.enabled(), false)
})

test("checkForUpdates refuses politely in dev mode (never throws)", async () => {
  const u = loadUpdater(fakeElectronDev)
  const r = await u.checkForUpdates()
  assert.equal(r.ok, false)
})

test("installUpdate refuses politely in dev mode", async () => {
  const u = loadUpdater(fakeElectronDev)
  const r = await u.installUpdate()
  assert.equal(r.ok, false)
})

test("preferences serialize/deserialize round-trip", () => {
  const u = loadUpdater(fakeElectronDev)
  u.setPreferences({ autoCheck: false, autoDownload: false })
  const saved = u.serializePrefs()
  assert.equal(saved.autoCheck, false)
  assert.equal(saved.autoDownload, false)
  const u2 = loadUpdater(fakeElectronDev)
  u2.deserializePrefs(saved)
  assert.deepEqual(u2.serializePrefs(), { autoCheck: false, autoDownload: false })
})

test("onChange replays the last state to a late subscriber", async () => {
  const u = loadUpdater(fakeElectronPackaged)
  const seen = []
  u.onChange((type, payload) => seen.push([type, payload]))
  // downloadUpdate emits a "downloading" state through the fake autoUpdater.
  await u.downloadUpdate()
  assert.ok(seen.some(([t]) => t === "downloading"), "expected a 'downloading' event, got " + JSON.stringify(seen))
})

test("manual download works while auto-download is off and keeps the preference", async () => {
  const u = loadUpdater(fakeElectronPackaged)
  u.setPreferences({ autoDownload: false })
  const r = await u.downloadUpdate()
  assert.equal(r.ok, true)
  assert.equal(u.serializePrefs().autoDownload, false)
})

test("duplicate simultaneous checks are suppressed", async () => {
  const u = loadUpdater(fakeElectronPackaged)
  const p1 = u.checkForUpdates()
  const p2 = u.checkForUpdates()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.alreadyChecking, true)
})

test("setBusyProvider + installUpdate refuses while busy", async () => {
  const u = loadUpdater(fakeElectronPackaged)
  u.setBusyProvider(() => true)
  const r = await u.installUpdate()
  assert.equal(r.ok, false)
  assert.match(r.error, /active/i)
  u.setBusyProvider(() => false)
})

console.log(`\nall ${passed} app-updater unit tests passed`)