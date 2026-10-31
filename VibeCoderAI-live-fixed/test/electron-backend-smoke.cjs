"use strict"

// Exercise the real Electron backend adapter without launching a GUI. Only the
// native Electron shell is substituted; SDK/core modules are the real project code.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const EventEmitter = require("node:events")
const Module = require("node:module")
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-electron-backend-test-"))
process.env.VIBE_HOME = tempHome
process.env.VIBE_SERVE = "0"
// Make provider visibility deterministic: unconfigured built-ins should not be
// listed just because the test host happens to export a developer API key.
for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY"]) process.env[key] = ""
const handlers = new Map()
const sent = []
const fakeElectron = {
  app: { isPackaged: false, getPath: () => tempHome, quit() {} },
  BrowserWindow: class extends EventEmitter {},
  ipcMain: { handle(channel, fn) { assert.equal(handlers.has(channel), false, `duplicate IPC handler ${channel}`); handlers.set(channel, fn) }, removeHandler(channel) { handlers.delete(channel) } },
  dialog: { async showOpenDialog() { return { canceled: true, filePaths: [] } } },
  clipboard: { writeText() {} },
  shell: { async openPath() { return "" }, async openExternal() { return "" } },
  Notification: class { static isSupported() { return false } show() {} },
}
const originalLoad = Module._load
Module._load = function (request, parent, isMain) { if (request === "electron") return fakeElectron; return originalLoad.call(this, request, parent, isMain) }
let backend
let failed = false
async function main() {
  backend = require("../electron/backend.cjs")
  const win = new EventEmitter()
  win.isDestroyed = () => false
  win.webContents = { isDestroyed: () => false, send: (...args) => sent.push(args) }
  backend.initBackend(win, { serve: false })

  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8")
  const names = [...preload.matchAll(/call\("([^\"]+)"\)/g)].map((m) => m[1])
  const missing = [...new Set(names)].filter((name) => !handlers.has(`vibe:${name}`))
  assert.deepEqual(missing, [], `preload methods missing IPC handlers: ${missing.join(", ")}`)
  assert.ok(handlers.size >= 100, `expected >=100 IPC handlers, got ${handlers.size}`)
  assert.ok(handlers.has("vibe:browserCommandResult"), "browser renderer command-result handler must be registered")

  // Verify agent browser controls are routed through the visible renderer dock,
  // and then operate on the same webContents ID that dock registered.
  const { BrowserManager } = require("../electron/browser")
  let browserManager
  const browserCommands = []
  const fakeGuest = {
    isDestroyed: () => false,
    async loadURL(url) { this.loadedURL = url },
    getURL() { return this.loadedURL || "https://example.test/" },
    getTitle() { return "Live Mock Page" },
    async executeJavaScript(script) {
      // V-09: the wait probe returns true unless the test asks for a selector
      // that never appears (to exercise the timeout path).
      if (script.includes('const sel = "#missing"')) return false
      if (script.includes("const sel =")) return true
      if (script.includes(".click();")) return { clicked: "e1", tag: "button", generation: 1 }
      if (script.includes("data-vibe-ref")) return [{ level: 0, role: "button", name: "Submit", value: "", ref: "e1", tag: "button" }]
      if (script.includes("document.title")) return "Mock Page"
      return { executed: true }
    },
    async capturePage() { return { toPNG: () => Buffer.from("mock-png") } },
    sendInputEvent() {},
  }
  const fakeHost = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send(channel, payload) {
        assert.equal(channel, "vibe:browser-command")
        browserCommands.push(payload.action)
        setImmediate(() => {
          let data = {}
          if (payload.action === "createTab") data = { id: payload.args.id, url: payload.args.url, title: "Mock Page", contentsId: 77 }
          else if (payload.action === "listTabs") {
            const current = browserManager && [...browserManager.tabs.values()][0]
            data = current ? [{ id: current.id, url: current.url, title: "Mock Page", contentsId: 77 }] : []
          }
          else if (payload.action === "activateTab") data = { id: payload.args.tabID, contentsId: 77 }
          else if (payload.action === "closeTab") data = { closed: true }
          browserManager.resolveCommand({ requestId: payload.requestId, ok: true, data })
        })
      },
    },
  }
  browserManager = new BrowserManager({ getHostWindow: () => fakeHost, getWebContents: (id) => Number(id) === 77 ? fakeGuest : null, commandTimeoutMs: 1000 })
  const browserTab = await browserManager.createTab({ url: "https://example.test/" })
  assert.ok(browserTab.id.startsWith("agent_"))
  assert.equal(browserTab.contentsId, 77)
  const visibleTabs = await browserManager.listTabs()
  assert.equal(visibleTabs.length, 1)
  assert.equal(visibleTabs[0].id, browserTab.id)
  assert.equal(visibleTabs[0].title, "Live Mock Page", "tab title must come from the current guest webContents")
  assert.equal(visibleTabs[0].url, "https://example.test/", "tab URL must come from the current guest webContents")
  await browserManager.navigate(browserTab.id, "https://example.test/next")
  assert.equal(fakeGuest.loadedURL, "https://example.test/next")
  const screenshotMeta = await browserManager.captureScreenshot(browserTab.id)
  assert.equal(screenshotMeta.title, "Live Mock Page")
  assert.equal(screenshotMeta.url, "https://example.test/next")
  assert.equal(screenshotMeta.tabID, browserTab.id)
  assert.equal(screenshotMeta.mime, "image/png")
  assert.equal(screenshotMeta.buffer.toString(), "mock-png")
  const png = await browserManager.screenshot(browserTab.id)
  assert.equal(png.toString(), "mock-png")
  const snapshot = await browserManager.snapshot(browserTab.id)
  assert.match(snapshot, /Submit.*@e1/)
  assert.ok(browserCommands.includes("createTab") && browserCommands.includes("activateTab"))
  // V-03: a stale generation must fail fast with a guided error, before any click.
  let staleErr = ""
  try { await browserManager.click(browserTab.id, "e1", 999) } catch (e) { staleErr = e.message }
  assert.ok(/older snapshot/.test(staleErr), "stale generation yields a guided error: " + staleErr)
  const okClick = await browserManager.click(browserTab.id, "e1", undefined)
  assert.ok(okClick && okClick.clicked, "omitting generation still clicks the latest ref")
  // V-09: wait resolves as soon as the selector appears and times out cleanly.
  const waited = await browserManager.wait(browserTab.id, { selector: "#done", timeoutMs: 3000 })
  assert.ok(waited && Number.isFinite(waited.elapsedMs), "wait reports elapsed time")
  let waitTimeout = ""
  try { await browserManager.wait(browserTab.id, { selector: "#missing", timeoutMs: 200 }) } catch (e) { waitTimeout = e.message }
  assert.match(waitTimeout, /Timed out after 200 ms/, "a missing selector returns a clear timeout error")
  await browserManager.closeTab(browserTab.id)
  console.log("PASS in-app browser bridge: agent tab creation/activation uses the visible renderer dock and operates the registered guest page")

  async function invoke(name, arg = {}) {
    const fn = handlers.get(`vibe:${name}`)
    assert.equal(typeof fn, "function", `missing IPC handler ${name}`)
    const result = await fn({}, arg)
    assert.equal(result?.ok, true, `${name} failed: ${result?.error || JSON.stringify(result)}`)
    return result.data
  }

  const info = await invoke("info")
  assert.equal(info.mode, "sdk")
  assert.equal(info.home, tempHome)
  assert.equal(typeof await invoke("cwd"), "string")
  assert.ok(Array.isArray((await invoke("providerList")).custom))
  assert.ok(Array.isArray(await invoke("listAllModels")))
  const initialCatalog = await invoke("providerCatalog")
  assert.equal(initialCatalog.source.profilesFile, path.join(tempHome, "profiles.json"))
  assert.equal(initialCatalog.source.authFile, path.join(tempHome, "auth.json"))
  assert.ok(initialCatalog.models.every((row) => !row.isBuiltin || row.hasKey), "unconfigured built-in providers must not crowd the model picker")
  const session = await invoke("createSession", { directory: process.cwd(), title: "Backend smoke test" })
  assert.ok(session.id)
  assert.equal((await invoke("getMessages", { sessionID: session.id })).length, 0)
  backend.engine._emit(session.id, { type: "compaction.start", reason: "manual", summaryModel: "summary/writer" })
  backend.engine._emit(session.id, { type: "compaction.delta", reason: "manual", summaryModel: "summary/writer", text: "live checkpoint" })
  backend.engine._emit(session.id, { type: "compaction.end", reason: "manual", summaryModel: "summary/writer", summarized: true, summary: "live checkpoint" })
  assert.ok(sent.some(([channel, payload]) => channel === "vibe:event" && payload?.type === "session.compaction.started"), "compaction start must use the renderer-facing event name")
  const liveCompaction = sent.find(([channel, payload]) => channel === "vibe:event" && payload?.type === "session.compaction.delta" && payload?.text === "live checkpoint")
  assert.ok(liveCompaction, "compaction summary deltas must reach the renderer while the model writes")
  assert.ok(sent.some(([channel, payload]) => channel === "vibe:event" && payload?.type === "session.compaction.ended" && payload?.summarized === true), "a completed checkpoint must stop the renderer's compacting state")

  // A renamed/recreated provider may leave one stale provider ID in the UI for
  // a single event-loop turn. Resolve only if the model ID maps to one current
  // custom provider; ambiguous model IDs must not be guessed.
  await invoke("providerSave", {
    id: "kilo2",
    name: "Kilo 2",
    baseURL: "http://127.0.0.1:9/v1",
    apiFormat: "chat",
    models: [{ id: "kilo-auto/free", name: "Kilo Auto Free", context: 32768, output: 2048 }],
    scope: "global",
  })
  const recoveredModel = await invoke("setModel", {
    sessionID: session.id,
    providerID: "kilo",
    modelID: "kilo-auto/free",
  })
  assert.equal(recoveredModel.providerID, "kilo2", "stale provider ID should resolve to the unique live provider for this exact model")
  assert.equal(recoveredModel.selectedModel, "kilo2/kilo-auto/free")
  assert.equal(recoveredModel.recoveredStaleProvider, true)

  // Compaction controls are backed by the same config the core reads. The UI
  // can toggle auto mode and choose an exact provider/model without JSON edits.
  const defaultCompaction = await invoke("getCompactionSettings")
  assert.equal(defaultCompaction.auto, true)
  const savedCompaction = await invoke("setCompactionSettings", { auto: false, model: "kilo2/kilo-auto/free" })
  assert.equal(savedCompaction.auto, false)
  assert.equal(savedCompaction.model, "kilo2/kilo-auto/free")
  const compactionDisk = JSON.parse(fs.readFileSync(path.join(tempHome, "config.json"), "utf8"))
  assert.equal(compactionDisk.compaction.auto, false)
  assert.equal(compactionDisk.compaction.model, "kilo2/kilo-auto/free")
  assert.ok(sent.some(([channel, payload]) => channel === "vibe:event" && payload?.type === "compaction.settings.changed"), "setting changes should update the renderer live")
  await invoke("setCompactionSettings", { auto: true, model: null })

  // Provider metadata is persisted locally and can be edited by another tool.
  // Verify that the directory watcher refreshes model rows and invalidates a
  // stale selection after an external profiles.json change.
  await invoke("providerSave", {
    id: "external-live-test",
    name: "Before Rename",
    baseURL: "http://127.0.0.1:9/v1",
    apiFormat: "chat",
    models: [{ id: "model-old", name: "Old Model", context: 4096, output: 512 }],
    scope: "global",
  })
  await invoke("setModel", { sessionID: session.id, providerID: "external-live-test", modelID: "model-old" })
  const afterSaveCatalog = await invoke("providerCatalog")
  assert.ok(afterSaveCatalog.models[0] && !afterSaveCatalog.models[0].isBuiltin, "custom providers must be shown before configured built-ins")
  assert.ok(afterSaveCatalog.models.some((item) => item.providerID === "external-live-test" && item.id === "model-old"))
  const profileFile = path.join(tempHome, "profiles.json")
  const profiles = JSON.parse(fs.readFileSync(profileFile, "utf8"))
  const changed = profiles.find((item) => item.id === "external-live-test")
  assert.ok(changed)
  changed.name = changed.label = "Renamed Outside App"
  changed.model = "model-new"
  changed.models = [{ id: "model-new", name: "New Model", context: 8192, output: 1024 }]
  fs.writeFileSync(profileFile, JSON.stringify(profiles, null, 2))
  const watcherDeadline = Date.now() + 3000
  let refreshed = null
  let latestRefresh = null
  while (Date.now() < watcherDeadline) {
    const rows = await invoke("listAllModels")
    const providerList = await invoke("providerList")
    const catalog = await invoke("providerCatalog")
    refreshed = { rows, providerList, catalog }
    latestRefresh = sent.slice().reverse().find(([channel, payload]) => channel === "vibe:event" && payload?.type === "providers.changed")?.[1]
    if (providerList.custom.some((item) => item.id === "external-live-test" && item.name === "Renamed Outside App") && rows.some((item) => item.providerID === "external-live-test" && item.id === "model-new") && catalog.selectedModel === null && latestRefresh) break
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  assert.ok(refreshed.providerList.custom.some((item) => item.id === "external-live-test" && item.name === "Renamed Outside App"), "external provider rename must be re-read from profiles.json")
  assert.ok(refreshed.rows.some((item) => item.providerID === "external-live-test" && item.id === "model-new"), "external model changes must be re-read from profiles.json")
  assert.ok(sent.some(([channel, payload]) => channel === "vibe:event" && payload?.type === "providers.changed"), "provider file watcher should broadcast a live refresh event")
  assert.equal(refreshed.catalog.selectedModel, null, "selection of a removed model must be invalidated in the authoritative catalog")
  const leakedSecrets = JSON.stringify(latestRefresh || {}).match(/apiKey|maskedKey|secret/i)
  assert.equal(leakedSecrets, null, "provider change events must not broadcast credentials")

  // Delete the provider directly on disk, matching external profile editors that
  // atomically replace profiles.json. The next catalog refresh must not keep old
  // model IDs alive in ChatComposer's source data.
  await invoke("setModel", { sessionID: session.id, providerID: "external-live-test", modelID: "model-new" })
  const beforeDelete = JSON.parse(fs.readFileSync(profileFile, "utf8"))
  fs.writeFileSync(profileFile, JSON.stringify(beforeDelete.filter((item) => item.id !== "external-live-test"), null, 2))
  const deletedCatalog = await invoke("providerCatalog")
  assert.ok(!deletedCatalog.custom.some((item) => item.id === "external-live-test"), "deleted provider must disappear from provider settings catalog")
  assert.ok(!deletedCatalog.models.some((item) => item.providerID === "external-live-test"), "deleted provider models must disappear from Composer catalog")
  assert.equal(deletedCatalog.selectedModel, null, "deleting the selected provider must clear the persisted model selection")

  assert.ok(Array.isArray(await invoke("listSessions", { all: true })))
  assert.ok(Array.isArray(await invoke("listPermissionRequests")))
  assert.ok(Array.isArray((await invoke("todoList", { sessionID: session.id })).items))
  assert.ok(Array.isArray((await invoke("memoryList")).entries))
  assert.ok(Array.isArray((await invoke("listAgents")).agents))
  assert.ok(Array.isArray((await invoke("subagentList", { sessionID: session.id })).subagents))
  await invoke("setPermissions", { sessionID: session.id, permissions: [{ action: "bash", resource: "*", effect: "ask" }] })
  await invoke("clearSessionRules", { sessionID: session.id })
  assert.ok(sent.some(([channel]) => channel === "vibe:event"), "expected IPC event delivery")
  backend.shutdownBackend()
  console.log(`PASS Electron backend smoke: ${handlers.size} IPC handlers registered; preload coverage, SDK wiring, session, permissions, memory, agents and subagents verified`)
}
main().catch((err) => { failed = true; console.error("FAIL Electron backend smoke:", err?.stack || err) }).finally(() => {
  try { backend?.shutdownBackend() } catch {}
  Module._load = originalLoad
  try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
  if (failed) process.exitCode = 1
})
