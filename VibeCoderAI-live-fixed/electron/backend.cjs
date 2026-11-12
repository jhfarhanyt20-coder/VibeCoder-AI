"use strict"

/*
 * Electron-to-SDK adapter. This repository ships the SDK/core under the project
 * root, not inside electron/. Keep IPC responses in the {ok,data|error} shape
 * consumed by preload.cjs, and keep filesystem/provider secrets out of events.
 */
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { execFile } = require("node:child_process")
const { promisify } = require("node:util")
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Notification } = require("electron")
const { createVibe } = require("../sdk")
const { createServer } = require("../cli/server")
const { convertMessages } = require("./messages.cjs")
const updater = require("./updater.cjs")
const { homeDir } = require("../core/util")
const profileStore = require("../core/llm/profiles")
const secrets = require("../core/store/secrets")
const providerMeta = require("../core/llm/provider-meta")
const mcp = require("../core/mcp")
const plugins = require("../core/plugins")
const skills = require("../core/skills")
const catalog = require("../core/extensions/catalog")
const execFileAsync = promisify(execFile)

const home = homeDir()
fs.mkdirSync(home, { recursive: true })
const vibe = createVibe({ home, permission: "ask" })
const engine = vibe.engine
const uiStateFile = path.join(home, "electron-ui-state.json")
const memoriesFile = path.join(home, "memories.json")
const customProfilesFile = path.join(home, "profiles.json")
const authFile = path.join(home, "auth.json")
const providerDraftsFile = path.join(home, "provider-drafts.json")

let win = null
let server = null
let serverToken = process.env.VIBE_SERVE_TOKEN || null
let eventOff = null
let registered = false
let browserResultRegistered = false
let appUpdateRegistered = false
let providerWatcher = null
let providerWatchTimer = null
let providerWatcherStarted = false
let currentDirectory = process.cwd()
let activeSessionId = null
let selectedModel = null
let activeAgent = "VibeCoder AI"
let subagentsEnabled = true
const pickedAttachmentPaths = new Set()
const runState = new Map()
const subagentContinuations = new Map()
const disabledAgents = new Set()
let backendClosing = false

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
}
function providerDraftKey(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\x00-\x1F\x7F]/.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) throw new Error("Invalid provider draft key.")
  return value
}
function readProviderDrafts() {
  const entries = readJson(providerDraftsFile, {})
  return entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {}
}
function loadProviderDraft(key) {
  const entries = readProviderDrafts()
  if (!Object.prototype.hasOwnProperty.call(entries, key)) return null
  try {
    const draft = JSON.parse(secrets.decrypt(entries[key]))
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error()
    return draft
  } catch { throw new Error("The saved provider draft could not be decrypted. Remove the draft and re-enter its details.") }
}
function saveProviderDraft(a) {
  const key = providerDraftKey(a.key)
  if (!secrets.available()) throw new Error("Secure provider draft storage is unavailable on this platform. The draft was not saved.")
  if (!a.draft || typeof a.draft !== "object" || Array.isArray(a.draft)) throw new Error("Provider draft must be an object.")
  let serialized
  try { serialized = JSON.stringify(a.draft) } catch { throw new Error("Provider draft must contain JSON-compatible fields.") }
  if (serialized.length > 100000) throw new Error("Provider draft must be 100 KB or smaller.")
  const draft = JSON.parse(serialized)
  if (draft.apiKey != null && typeof draft.apiKey !== "string") throw new Error("The API key must be a string.")
  const apiKey = String(draft.apiKey || "").trim()
  if (apiKey.length > 4096) throw new Error("The API key is too long.")
  if (apiKey && !/^[\x20-\x7E]+$/.test(apiKey)) throw new Error("The API key contains non-ASCII characters. Re-enter the exact key from the provider dashboard.")
  draft.apiKey = a.clearApiKey === true ? "" : apiKey || loadProviderDraft(key)?.apiKey || ""
  const entries = readProviderDrafts()
  if (!Object.prototype.hasOwnProperty.call(entries, key) && Object.keys(entries).length >= 100) throw new Error("Remove an old provider draft before adding another.")
  // Encrypt the entire raw form so incomplete header/body text cannot leak credentials either.
  const stored = secrets.encrypt(JSON.stringify(draft))
  writeJson(providerDraftsFile, { ...entries, [key]: stored })
  return { key, saved: true }
}
function removeProviderDraft(key) {
  const entries = readProviderDrafts()
  const removed = Object.prototype.hasOwnProperty.call(entries, key)
  if (removed) {
    delete entries[key]
    writeJson(providerDraftsFile, entries)
  }
  return { key, removed }
}
function safeResolveDirectory(value) {
  const target = path.resolve(String(value || process.cwd()))
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`Directory does not exist: ${target}`)
  return target
}
function slug(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
}
const PROTECTED_PROVIDER_HEADERS = /authorization|auth|cookie|api[_-]?key|token|secret|password|credential|^user-agent$|^x-opencode-/i
function providerHeaders(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {}
  const out = {}
  for (const [rawName, rawValue] of Object.entries(source)) {
    const name = String(rawName || "").trim()
    const headerValue = String(rawValue == null ? "" : rawValue).trim()
    if (!name || !headerValue) continue
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new Error(`Invalid provider header name "${name}".`)
    if (PROTECTED_PROVIDER_HEADERS.test(name)) throw new Error(`${name} is a protected credential header. Use the API key field instead of storing secrets in provider headers.`)
    if (/\r|\n/.test(headerValue)) throw new Error(`Provider header "${name}" contains a line break.`)
    if (headerValue.length > 4096) throw new Error(`Provider header "${name}" is too long.`)
    out[name] = headerValue
  }
  return out
}
function providerBodyValue(value, pathName) {
  if (Array.isArray(value)) return value.map((item, index) => providerBodyValue(item, `${pathName}[${index}]`))
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`Unsafe request body key "${key}".`)
    if (/api[_-]?key|token|secret|password|authorization|auth|cookie|credential/i.test(key)) throw new Error(`${pathName}.${key} looks like a credential. Keep secrets in the API key field.`)
    out[key] = providerBodyValue(item, `${pathName}.${key}`)
  }
  return out
}
function providerBody(value) {
  if (value == null) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extra request body must be a JSON object.")
  const out = providerBodyValue(value, "body")
  if (JSON.stringify(out).length > 50000) throw new Error("Extra request body must be 50 KB or smaller.")
  return out
}
function publicProviderBody(value) {
  if (Array.isArray(value)) return value.map(publicProviderBody)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/api[_-]?key|token|secret|password|authorization|auth|cookie|credential/i.test(key) && !["__proto__", "prototype", "constructor"].includes(key))
    .map(([key, item]) => [key, publicProviderBody(item)]))
}
function idOf(a = {}) { return a.sessionID || a.sessionId || a.id || activeSessionId || null }
function requireSession(id) {
  if (!id) throw new Error("No active session. Create or open a session first.")
  return engine.getSession(id)
}
function persistUIState() { writeJson(uiStateFile, { directory: currentDirectory, selectedModel, activeAgent, [updater.PREF_KEY]: updater.serializePrefs() }) }
function send(channel, payload) {
  try { if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload) } catch {}
}
function emitUI(type, sessionID, data = {}) {
  const payloadData = { ...data }
  if (sessionID && !payloadData.sessionID) payloadData.sessionID = sessionID
  send("vibe:event", { type, sessionID: sessionID || payloadData.sessionID || null, data: payloadData, ...payloadData })
}
function normalizeResult(result) {
  if (result && typeof result === "object" && result.ok === false) throw new Error(result.error || "Operation failed")
  if (result && typeof result === "object" && result.ok === true && Object.prototype.hasOwnProperty.call(result, "data")) return result.data
  if (result && typeof result === "object" && result.ok === true) { const { ok, ...rest } = result; return rest }
  return result
}
function readMemory() {
  const d = readJson(memoriesFile, [])
  return Array.isArray(d) ? d.filter((x) => x && typeof x.text === "string") : []
}
function saveMemory(entries) { writeJson(memoriesFile, entries.slice(-500)) }
function selectedProfileId() {
  // Choose only a provider represented in the current Composer catalog. This
  // prevents an unconfigured built-in profile or a deleted/stale selection from
  // becoming the default for a new session.
  const rows = modelRows()
  const available = new Set(rows.map((row) => row.providerID))
  if (selectedModel) {
    const pid = selectedModel.split("/")[0]
    if (available.has(pid)) return pid
  }
  const preferred = ["openai", "groq-gpt-oss-120b"].find((id) => available.has(id))
  return preferred || rows[0]?.providerID || null
}
function profileFormat(value) {
  const fmt = String(value || "chat").toLowerCase()
  if (fmt === "chat" || fmt === "openai-chat") return "openai-chat"
  if (fmt === "responses" || fmt === "openai-responses") return "openai-responses"
  if (fmt === "anthropic") return "anthropic"
  throw new Error(`Unsupported provider format "${value}". Use chat, responses, or anthropic.`)
}
function profileApiFormat(value) { return value === "openai-responses" || value === "responses" ? "responses" : value === "anthropic" ? "anthropic" : "chat" }
function customProfiles(profileList = engine.listProfiles()) {
  const built = new Set(profileStore.BUILTIN.map((p) => p.id))
  return profileList.filter((p) => !built.has(p.id))
}
function customProviderRows(profileList = engine.listProfiles()) {
  return customProfiles(profileList).map((p) => ({
    id: p.id,
    name: p.name || p.label || p.id,
    label: p.label || p.name || p.id,
    baseURL: p.baseURL,
    apiFormat: profileApiFormat(p.format),
    format: p.format,
    hasKey: profileStore.hasKey(p, home),
    maskedKey: profileStore.hasKey(p, home) ? "••••••••" : "",
    headers: Object.fromEntries(Object.entries(p.headers || {}).filter(([name]) => !PROTECTED_PROVIDER_HEADERS.test(name))),
    body: p.quirks?.extraBody && typeof p.quirks.extraBody === "object" ? publicProviderBody(p.quirks.extraBody) : {},
    models: Array.isArray(p.models) && p.models.length
      ? p.models
      : [{ id: p.model, context: p.contextLimit, output: p.maxOutput, image: !!p.image }],
    scope: p.scope || "global",
    disabled: !!p.disabled,
  }))
}
function modelRows(profileList = engine.listProfiles()) {
  const built = new Set(profileStore.BUILTIN.map((p) => p.id))
  const custom = []
  const configuredBuiltins = []

  for (const p of profileList) {
    if (!p || !p.id || p.disabled) continue
    const isBuiltin = built.has(p.id)
    const hasKey = !!p.noAuth || profileStore.hasKey(p, home)

    // Keep public/custom endpoints available even if they need no API key.
    // Built-ins, however, should not crowd the picker unless configured; this
    // was the source of old Anthropic/OpenAI groups lingering above new custom
    // providers when those built-ins had no credentials.
    if (isBuiltin && !hasKey) continue

    const models = Array.isArray(p.models) && p.models.length
      ? p.models
      : [{ id: p.model, context: p.contextLimit, output: p.maxOutput, image: p.image }]

    for (const m of models) {
      if (!m || !m.id) continue
      const row = {
        providerID: p.id,
        id: String(m.id),
        name: String(m.name || m.id),
        providerName: String(p.name || p.label || p.id),
        context: Number(m.context || p.contextLimit) || 0,
        output: Number(m.output || p.maxOutput) || 0,
        image: !!(m.image || p.image),
        hasKey,
        isBuiltin,
      }
      ;(isBuiltin ? configuredBuiltins : custom).push(row)
    }
  }

  // Custom providers first, with configured built-ins afterwards. A new or
  // renamed provider is visible without scrolling through unrelated defaults.
  return [...custom, ...configuredBuiltins]
}
function providerCatalogData() {
  const profileList = engine.listProfiles()
  reconcileSelectedModel(profileList)
  return {
    custom: customProviderRows(profileList),
    formats: [
      { id: "chat", label: "OpenAI Chat Completions" },
      { id: "responses", label: "OpenAI Responses" },
      { id: "anthropic", label: "Anthropic Messages" },
    ],
    models: modelRows(profileList),
    selectedModel,
    source: {
      profilesFile: customProfilesFile,
      authFile,
    },
    changedAt: Date.now(),
  }
}

function reconcileSelectedModel(profileList = null) {
  if (!selectedModel) return false
  const valid = modelRows(profileList || engine.listProfiles()).some((row) => `${row.providerID}/${row.id}` === selectedModel)
  if (valid) return false
  selectedModel = null
  persistUIState()
  return true
}

function scheduleProviderRefresh(reason = "disk-change") {
  if (providerWatchTimer) clearTimeout(providerWatchTimer)
  providerWatchTimer = setTimeout(() => {
    providerWatchTimer = null
    try {
      // The model metadata catalog is also disk-backed; clear its in-memory
      // snapshot when an external editor replaces it.
      if (reason === "models.dev.json") providerMeta.reloadModelsDevFromDisk?.()
      // Profiles and auth are loaded from disk on every read. Reconcile the
      // persisted model choice before notifying the renderer; never include keys.
      const selectedReset = reconcileSelectedModel()
      const profiles = engine.listProfiles()
      emitUI("providers.changed", null, {
        reason,
        count: profiles.length,
        selectedModel,
        selectedReset,
        changedAt: Date.now(),
      })
    } catch (error) {
      emitUI("app.error", null, {
        title: "Provider refresh failed",
        message: String(error?.message || error),
      })
    }
  }, 180)
  providerWatchTimer.unref?.()
}

function startProviderWatcher() {
  if (providerWatcherStarted) return
  providerWatcherStarted = true
  try {
    // Watch the containing directory, not just the file handle: editors commonly
    // replace JSON files atomically via rename, which invalidates file watchers.
    providerWatcher = fs.watch(home, { persistent: false }, (_event, filename) => {
      const name = filename == null ? "" : String(filename)
      if (!name || ["profiles.json", "auth.json", "provider-meta.json", "models.dev.json"].includes(name)) {
        scheduleProviderRefresh(name || "directory-change")
      }
    })
    providerWatcher.on("error", (error) => {
      try { providerWatcher?.close() } catch {}
      providerWatcher = null
      providerWatcherStarted = false
      emitUI("app.error", null, {
        title: "Provider file watcher stopped",
        message: String(error?.message || error),
      })
    })
  } catch (error) {
    providerWatcherStarted = false
    // The manual refresh button and explicit provider IPC actions remain usable.
    console.warn("[vibe] provider file watcher unavailable:", error?.message || error)
  }
}

function stopProviderWatcher() {
  if (providerWatchTimer) clearTimeout(providerWatchTimer)
  providerWatchTimer = null
  try { providerWatcher?.close() } catch {}
  providerWatcher = null
  providerWatcherStarted = false
}
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function scheduleSubagentContinuation(sessionID, event) {
  const subagentID = event.subagentId
  if (!sessionID || !subagentID || event.subagentBackground === false || subagentContinuations.has(subagentID)) return
  const job = (async () => {
    const deadline = Date.now() + 5 * 60 * 1000
    while (!backendClosing && Date.now() < deadline) {
      if (engine.isBusy(sessionID)) { await waitMs(120); continue }
      const details = engine.subagentDetails(subagentID)
      if (!details) return
      try {
        const child = engine.getSession(details.childSessionId)
        if (child.subagentResultDeliveredAt) return
      } catch { return }
      try {
        runState.set(sessionID, { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null })
        emitUI("session.execution.started", sessionID, { source: "subagent-result", subagentID })
        const prompt = "A background subagent has finished. Review the attached subagent result, report the useful answer to the user now, and continue any work that depended on it. Do not say you are still waiting."
        for await (const _event of vibe.session.prompt(sessionID, prompt, { agentOnly: true, summaryModel: "session" })) {}
        return
      } catch (error) {
        if (/Session is busy/i.test(String(error?.message || error))) { await waitMs(120); continue }
        const state = runState.get(sessionID)
        if (state) state.failed = String(error?.message || error)
        flushText(sessionID); flushReasoning(sessionID)
        emitUI("session.execution.failed", sessionID, { error: { message: String(error?.message || error) }, persisted: true, source: "subagent-result", subagentID })
        runState.delete(sessionID)
        return
      }
    }
  })().finally(() => subagentContinuations.delete(subagentID))
  subagentContinuations.set(subagentID, job)
}
function flushText(sessionID) {
  const s = runState.get(sessionID)
  if (!s || !s.text) return
  emitUI("session.text.ended", sessionID, { assistantMessageID: s.assistantMessageID, ordinal: s.ordinal, text: s.text })
  s.text = ""
  s.ordinal += 1
  s.assistantMessageID = `asst_${Date.now().toString(36)}_${s.ordinal}`
}
function flushReasoning(sessionID) {
  const s = runState.get(sessionID)
  if (s?.reasoningStarted) {
    emitUI("session.reasoning.ended", sessionID, { assistantMessageID: s.assistantMessageID })
    s.reasoningStarted = false
  }
}
function onEngineEvent(ev) {
  const sid = ev.sessionId || ev.sessionID || null
  const data = { ...ev }
  delete data.sessionId
  // emitUI's first argument is the renderer-facing event name. Never let the
  // engine's raw `type` field overwrite mappings such as compaction.end ->
  // session.compaction.ended; that left a successfully saved checkpoint card
  // spinning forever in the renderer.
  delete data.type
  // Child-run events have their own timeline. Never feed their text/tool deltas
  // into the parent's streaming state; the renderer routes this envelope to the
  // clickable subagent view. Permission prompts remain parent-visible below.
  if (ev.subagentId && ev.type !== "permission.ask") {
    emitUI("subagent.event", sid, { ...data, eventType: ev.type })
    if (ev.type === "subagent.result") scheduleSubagentContinuation(sid, ev)
    return
  }
  switch (ev.type) {
    case "prompts.attached": emitUI("session.prompts.attached", sid, { ids: ev.ids }); break
    case "text.delta": {
      if (!sid) break
      const state = runState.get(sid) || { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null }
      runState.set(sid, state)
      state.text += String(ev.delta || "")
      emitUI("session.text.delta", sid, { assistantMessageID: state.assistantMessageID, ordinal: state.ordinal, delta: String(ev.delta || "") })
      break
    }
    case "reasoning.delta": {
      if (!sid) break
      const state = runState.get(sid) || { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null }
      runState.set(sid, state)
      if (!state.reasoningStarted) { state.reasoningStarted = true; emitUI("session.reasoning.started", sid, { assistantMessageID: state.assistantMessageID }) }
      emitUI("session.reasoning.delta", sid, { assistantMessageID: state.assistantMessageID, delta: String(ev.delta || "") })
      break
    }
    case "tool.start": {
      flushText(sid); flushReasoning(sid)
      const input = ev.args && typeof ev.args === "object" ? ev.args : {}
      emitUI("session.tool.input.started", sid, { id: ev.id, name: ev.name, input })
      emitUI("session.tool.input.ended", sid, { id: ev.id, name: ev.name, input })
      emitUI("session.tool.called", sid, { id: ev.id, name: ev.name, input })
      break
    }
    case "tool.end": {
      const output = String(ev.output ?? "")
      const content = [{ type: "text", text: output }]
      const shot = ev.screenshot
      if (shot && typeof shot.data === "string" && shot.data) {
        const mime = String(shot.mime || "image/png")
        content.push({
          type: "image",
          mime,
          dataUrl: `data:${mime};base64,${shot.data}`,
          url: String(shot.url || ""),
          title: String(shot.title || ""),
          tabID: String(shot.tabID || ""),
        })
      }
      const metadata = { ...(ev.stats || {}), ...(Number.isFinite(ev.durationMs) ? { durationMs: ev.durationMs } : {}), ...(Array.isArray(ev.artifacts) ? { artifacts: ev.artifacts } : {}) }
      emitUI(ev.isError ? "session.tool.failed" : "session.tool.success", sid, ev.isError
        ? { id: ev.id, name: ev.name, error: { message: output }, content, metadata }
        : { id: ev.id, name: ev.name, content, metadata })
      break
    }
    case "run.start": emitUI("session.pulse.started", sid, data); break
    case "step.start": emitUI("session.pulse.step.started", sid, data); break
    case "step.end": emitUI("session.pulse.step.ended", sid, data); break
    case "permission.lock": emitUI("session.permission.locked", sid, data); break
    case "recipe.start": emitUI("session.recipe.started", sid, data); break
    case "usage":
      emitUI("session.step.ended", sid, {
        assistantMessageID: `${runState.get(sid)?.assistantMessageID || "usage"}-step-${ev.step || 0}`,
        model: ev.model,
        cost: ev.cost,
        costSource: ev.costSource,
        tokens: {
          input: Number(ev.input) || 0,
          output: Number(ev.output) || 0,
          reasoning: Number(ev.reasoning) || 0,
          cache: {
            read: Number(ev.cache?.read) || 0,
            write: Number(ev.cache?.write) || 0,
          },
        },
      })
      break
    case "permission.ask":
      emitUI("session.permissions", sid, { permissionId: ev.permissionId, tool: ev.tool, subject: ev.subject, ...(ev.subagentId ? { subagentId: ev.subagentId } : {}) })
      break
    case "error": {
      const message = String(ev.message || "Agent step failed")
      if (sid) {
        const state = runState.get(sid) || { text: "", reasoningStarted: false }
        state.failed = message
        state.failureCode = ev.code || null
        state.retryable = ev.retryable !== false
        runState.set(sid, state)
      }
      emitUI("session.step.failed", sid, {
        error: { message, ...(ev.code ? { code: ev.code } : {}) },
        retryable: ev.retryable !== false,
        persisted: true,
      })
      break
    }
    case "done": {
      flushText(sid); flushReasoning(sid)
      const state = runState.get(sid)
      if (ev.reason === "interrupted") emitUI("session.execution.interrupted", sid, { reason: "user", ...(state?.source ? { source: state.source } : {}) })
      else if (ev.reason === "error" || state?.failed) emitUI("session.execution.failed", sid, {
        error: {
          message: state?.failed || "The run failed.",
          ...(state?.failureCode ? { code: state.failureCode } : {}),
        },
        retryable: state?.retryable !== false,
        persisted: true,
        ...(state?.source ? { source: state.source } : {}),
      })
      else emitUI("session.execution.succeeded", sid, { reason: ev.reason || "stop", ...(state?.source ? { source: state.source } : {}) })
      runState.delete(sid)
      break
    }
    case "compaction.start": emitUI("compaction.start", sid, data); emitUI("session.compaction.started", sid, data); break
    case "compaction.delta": emitUI("compaction.delta", sid, data); emitUI("session.compaction.delta", sid, data); break
    case "compaction.end": emitUI("compaction.end", sid, data); emitUI("session.compaction.ended", sid, data); break
    // V-10: `question` -> the renderer's interactive form card. The renderer
    // refreshes the pending list; these events make it instant instead of
    // waiting for the 1.5 s poll.
    case "question.ask": emitUI("form.created", sid, { form: ev.form }); break
    case "question.replied": emitUI("form.replied", sid, { form: ev.form, answers: ev.answers }); break
    case "question.cancelled": emitUI("form.cancelled", sid, { form: ev.form, message: ev.message }); break
    case "shell.started": emitUI("session.shell.started", sid, { shell: ev.shell }); break
    case "shell.output": emitUI("session.shell.output", sid, { shell: ev.shell, delta: ev.delta || "" }); break
    case "shell.input": emitUI("session.shell.input", sid, { shell: ev.shell, bytes: ev.bytes || 0, eof: !!ev.eof }); break
    case "shell.waiting": emitUI("session.shell.waiting", sid, { shell: ev.shell, prompt: ev.prompt || "" }); break
    case "shell.backgrounded": emitUI("session.shell.backgrounded", sid, { shell: ev.shell }); break
    case "shell.ended": emitUI("session.shell.ended", sid, { shell: ev.shell }); break
    case "shell.completed": emitUI("session.shell.completed", sid, { shell: ev.shell, output: ev.output || "" }); break
    case "shell.resume.started": {
      runState.set(sid, { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null, source: "shell-result" })
      emitUI("session.execution.started", sid, { source: "shell-result" })
      break
    }
    case "todo.update": emitUI("todo.updated", sid, data); break
    default: emitUI(ev.type || "engine.event", sid, data)
  }
}
function internalMessagesToUI(session) { return convertMessages(session) }

function profileDetails(id) {
  const p = engine.listProfiles().find((x) => x.id === id)
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}
function profileApiKey(p, candidate) {
  const provided = String(candidate || "").trim()
  return provided || (p.noAuth ? "" : profileStore.getKey(p, home))
}
function deleteCustomProfile(id) {
  if (profileStore.BUILTIN.some((p) => p.id === id)) throw new Error("Built-in providers cannot be deleted")
  const list = readJson(customProfilesFile, [])
  const next = list.filter((p) => p.id !== id)
  if (next.length === list.length) throw new Error(`Custom provider not found: ${id}`)
  writeJson(customProfilesFile, next)
  const auth = readJson(authFile, {})
  if (Object.prototype.hasOwnProperty.call(auth, id)) { delete auth[id]; writeJson(authFile, auth) }
  if (selectedModel?.startsWith(id + "/")) selectedModel = null
  persistUIState()
  return { removed: true }
}

function readAttachmentData(file) {
  const full = path.resolve(String(file || ""))
  if (!pickedAttachmentPaths.has(full)) throw new Error("This file was not selected in the attachment picker")
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("Attachment no longer exists")
  const stat = fs.statSync(full)
  if (stat.size > 10 * 1024 * 1024) throw new Error("Attachments must be 10 MB or smaller")
  const ext = path.extname(full).toLowerCase()
  const mimeByExt = { ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".gif":"image/gif", ".bmp":"image/bmp", ".txt":"text/plain", ".md":"text/markdown", ".json":"application/json", ".js":"text/javascript", ".ts":"text/typescript", ".py":"text/x-python", ".html":"text/html", ".css":"text/css", ".csv":"text/csv", ".xml":"application/xml", ".pdf":"application/pdf" }
  const mime = mimeByExt[ext] || "application/octet-stream"
  const data = fs.readFileSync(full)
  const base64 = data.toString("base64")
  const isImage = mime.startsWith("image/")
  return { path: full, name: path.basename(full), kind: isImage ? "image" : "file", mime, size: stat.size, base64, dataUrl: isImage ? `data:${mime};base64,${base64}` : undefined, text: mime.startsWith("text/") || mime === "application/json" ? data.toString("utf8") : undefined }
}

const handlers = {
  info: async () => {
    const id = selectedProfileId(); const p = engine.listProfiles().find((x) => x.id === id)
    return { mode: "sdk", model: `${id || ""}/${selectedModel?.split("/").slice(1).join("/") || p?.model || ""}`, home }
  },
  setMode: async ({ mode } = {}) => { if (mode && mode !== "sdk") throw new Error("This build runs the embedded Vibe SDK engine only."); return { mode: "sdk" } },
  getAllUsage: async (a = {}) => {
    const id = idOf(a)
    const sessions = id ? [engine.getSession(id)] : engine.listSessions({}).map((row) => engine.getSession(row.id))
    const rows = sessions.map((s) => ({ id: s.id, title: s.title, tokens: (Number(s.usage?.totalInput) || 0) + (Number(s.usage?.totalOutput) || 0), inputTokens: Number(s.usage?.totalInput) || 0, outputTokens: Number(s.usage?.totalOutput) || 0, estimatedCost: s.usage?.totalCost !== undefined ? Number(s.usage.totalCost) : null }))
    return { sessions: rows, totalTokens: rows.reduce((n, r) => n + r.tokens, 0), totalCost: rows.reduce((n, r) => n + (r.estimatedCost || 0), 0), unknownCost: rows.some((r) => r.estimatedCost === null), using: id ? { ...sessions[0].usage } : undefined }
  },
  clearSessionRules: async (a = {}) => { const id = idOf(a); if (id) { const s = requireSession(id); s.rules = []; engine.store.save(s) }; return { cleared: true } },
  listSessions: async (a = {}) => engine.listSessions({ dir: a.all ? undefined : (a.directory || a.dir || currentDirectory) }),
  createSession: async (a = {}) => {
    const directory = safeResolveDirectory(a.directory || a.dir || currentDirectory)
    const profile = a.profile || selectedProfileId()
    if (!profile) throw new Error("No provider is configured. Add a provider in Settings → Models first.")
    const s = engine.createSession({ dir: directory, profile, title: a.title })
    activeSessionId = s.id; currentDirectory = directory; persistUIState()
    emitUI("session.created", s.id, { session: { id: s.id, title: s.title, directory } })
    return s
  },
  getMessages: async (a = {}) => { const id = idOf(a); activeSessionId = id; return internalMessagesToUI(requireSession(id)) },
  renameSession: async (a = {}) => { const s = engine.renameSession(idOf(a), a.title || a.name || "New session"); emitUI("session.renamed", s.id, { session: { id: s.id, title: s.title } }); return s },
  deleteSession: async (a = {}) => { const id = idOf(a); engine.removeSession(id); if (activeSessionId === id) activeSessionId = null; emitUI("session.deleted", id, { sessionID: id }); return { deleted: true } },
  revertSession: async (a = {}) => engine.revertSession(idOf(a), a.messageID || a.messageId),
  undoSession: async (a = {}) => engine.undoSession(idOf(a), a.messageID || a.messageId),
  listSnapshots: async (a = {}) => engine.listSnapshots(idOf(a)),
  listStepSnapshots: async (a = {}) => engine.listStepSnapshots(idOf(a)),
  previewSnapshot: async (a = {}) => engine.previewSnapshot(idOf(a), { turn: a.turn, step: a.step }),
  undoStepSession: async (a = {}) => engine.undoStepSession(idOf(a), a.turn, a.step),
  redoSession: async (a = {}) => engine.redoSession(idOf(a)),
  listRedo: async (a = {}) => engine.listRedo(idOf(a)),
  getTrail: async (a = {}) => engine.getTrail(idOf(a), a.limit),
  prompt: async (a = {}) => {
    const id = idOf(a); requireSession(id)
    if (engine.isBusy(id)) throw new Error("Session is already running.")
    const files = []
    const attachmentText = []
    for (const f of (Array.isArray(a.files) ? a.files : [])) {
      if (!f) continue
      const uri = String(f.uri || f.dataUrl || "")
      const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(uri)
      if (dataUrl && dataUrl[1].startsWith("image/")) files.push({ mime: dataUrl[1], data: dataUrl[2] })
      else if (f.data && String(f.mime || "").startsWith("image/")) files.push({ mime: f.mime, data: f.data })
      else if (f.base64 && String(f.mime || "").startsWith("image/")) files.push({ mime: f.mime, data: f.base64 })
      else if (f.path && pickedAttachmentPaths.has(path.resolve(f.path)) && fs.existsSync(f.path)) {
        const st = fs.statSync(f.path); if (st.size <= 1024 * 1024 && !String(f.mime || "").startsWith("image/")) attachmentText.push(`\n\n[Attached file: ${path.basename(f.path)}]\n${fs.readFileSync(f.path, "utf8")}`)
      }
    }
    activeSessionId = id
    runState.set(id, { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null })
    emitUI("session.execution.started", id, {})
    setImmediate(() => {
      ;(async () => { for await (const _ev of vibe.session.prompt(id, String(a.text || "") + attachmentText.join(""), { files, thinking: a.thinking, summaryModel: "session" })) {} })().catch((e) => {
        const st = runState.get(id); if (st) st.failed = String(e?.message || e)
        flushText(id); flushReasoning(id)
        emitUI("session.execution.failed", id, { error: { message: String(e?.message || e) }, persisted: false })
        runState.delete(id)
      })
    })
    return { started: true, sessionID: id }
  },
  resumeRun: async (a = {}) => {
    const id = idOf(a); requireSession(id); if (engine.isBusy(id)) throw new Error("Session is already running.")
    runState.set(id, { assistantMessageID: `asst_${Date.now().toString(36)}`, ordinal: 0, text: "", reasoningStarted: false, failed: null })
    emitUI("session.execution.started", id, {})
    setImmediate(() => { (async () => { for await (const _ev of vibe.session.resume(id, { summaryModel: "session" })) {} })().catch((e) => { const st = runState.get(id); if (st) st.failed = String(e?.message || e); flushText(id); flushReasoning(id); emitUI("session.execution.failed", id, { error: { message: String(e?.message || e) }, persisted: true }); runState.delete(id) }) })
    return { started: true, sessionID: id }
  },
  queuePrompt: async (a = {}) => { const id = idOf(a); requireSession(id); return engine.queuePrompt(id, { id: a.id, text: a.text }) },
  interrupt: async (a = {}) => { await engine.stop(idOf(a)); return { interrupted: true } },
  compactSession: async (a = {}) => vibe.session.compact(idOf(a), { reason: a.reason === "auto" ? "auto" : "manual", summaryModel: "session" }),
  getCompactionSettings: async () => engine.getCompactionConfig(),
  setCompactionSettings: async (a = {}) => {
    const source = a.compaction && typeof a.compaction === "object" ? a.compaction : a
    const patch = {}
    if (Object.prototype.hasOwnProperty.call(source, "auto")) patch.auto = !!source.auto
    if (Object.prototype.hasOwnProperty.call(source, "model")) {
      const model = source.model == null || String(source.model).trim() === "" ? null : String(source.model).trim()
      if (model) {
        const available = new Set([
          ...engine.listProfiles().map((profile) => String(profile.id)),
          ...modelRows().map((row) => `${row.providerID}/${row.id}`),
        ])
        if (!available.has(model)) throw new Error(`Summary model "${model}" is not in the configured model catalog.`)
      }
      patch.model = model
    }
    if (Object.prototype.hasOwnProperty.call(source, "buffer")) patch.buffer = source.buffer
    if (Object.prototype.hasOwnProperty.call(source, "maxRuns")) patch.maxRuns = source.maxRuns
    if (Object.prototype.hasOwnProperty.call(source, "background")) patch.background = !!source.background
    if (source.keep && typeof source.keep === "object") patch.keep = { tokens: source.keep.tokens }
    const updated = engine.setCompactionConfig(patch)
    emitUI("compaction.settings.changed", null, { compaction: updated })
    return updated
  },
  listShells: async (a = {}) => engine.listShells(idOf(a)),
  shellOutput: async (a = {}) => engine.shellOutput(a.shellID || a.id, a.max),
  shellInput: async (a = {}) => engine.shellInput(idOf(a), a.shellID || a.shellId || a.id, a.text || "", { newline: a.enter !== false, eof: a.eof === true }),
  backgroundSession: async (a = {}) => engine.backgroundSession(idOf(a)),
  backgroundShell: async (a = {}) => engine.backgroundShell(idOf(a), a.shellID || a.id),
  cancelShell: async (a = {}) => ({ cancelled: engine.cancelShell(idOf(a), a.shellID || a.id) }),
  setPermissions: async (a = {}) => {
    const s = requireSession(idOf(a)); const permissions = Array.isArray(a.permissions) ? a.permissions : []
    s.rules = permissions.map((p) => ({ tool: String(p.action || "*"), pattern: String(p.resource || "*"), action: ["allow", "ask", "deny"].includes(String(p.effect)) ? String(p.effect) : "ask", exact: false }))
    engine.store.save(s); return { updated: s.rules.length }
  },
  listPermissionRequests: async () => [...engine.pending.entries()].map(([id, p]) => ({ id, permissionId: id, sessionID: p.session?.parentId || p.session?.id, subagentSessionID: p.session?.parentId ? p.session.id : undefined, action: p.tool, tool: p.tool, resource: p.subject, resources: p.subject ? [p.subject] : [] })),
  replyPermission: async (a = {}) => { const id = a.requestID || a.permissionId || a.id; const decision = a.decision === "reject" ? "deny" : a.decision; if (!engine.replyPermission(id, decision)) throw new Error("Permission request is no longer pending."); emitUI("session.permissions", a.sessionID, { resolved: true, requestID: id, decision }); return { replied: true } },
  listForms: async (a = {}) => engine.listForms(a.sessionID || a.sessionId || null),
  replyForm: async (a = {}) => {
    const id = String(a.formID || a.formId || a.id || "").trim()
    if (!id) throw new Error("formID is required")
    if (!engine.replyForm(id, a.answer ?? a.answers)) throw new Error("This question is no longer waiting for an answer.")
    return { replied: true }
  },
  cancelForm: async (a = {}) => {
    const id = String(a.formID || a.formId || a.id || "").trim()
    if (!id) throw new Error("formID is required")
    return { cancelled: engine.cancelForm(id, a.message ? String(a.message) : undefined) }
  },

  listModels: async () => modelRows(),
  listAllModels: async () => modelRows(),
  // One disk-backed snapshot for the provider settings page and ChatComposer.
  // Both lists come from the same profile read, so names/models cannot race.
  providerCatalog: async () => providerCatalogData(),
  listModelLimits: async () => modelRows().map((m) => ({ providerID: m.providerID, id: m.id, modelID: m.id, context: m.context, output: m.output, image: m.image })),
  setModel: async (a = {}) => {
    const sid = idOf(a)
    const requestedProviderID = String(a.model?.providerID || a.providerID || a.profile || a.id || "").trim()
    const requestedModelID = String(a.model?.id || a.modelID || a.modelId || "").trim()
    if (!requestedProviderID) throw new Error("Choose a provider before switching models.")

    // Always resolve against a fresh disk-backed catalog. A stale renderer can
    // still submit the old provider ID for one event-loop turn after a rename /
    // delete; do not let that stale identifier poison the session profile.
    const profiles = engine.listProfiles()
    const rows = modelRows(profiles)
    let providerID = requestedProviderID
    let p = profiles.find((item) => item.id === providerID && !item.disabled)
    let modelID = requestedModelID

    let row = p && modelID
      ? rows.find((item) => item.providerID === providerID && item.id === modelID)
      : null

    // The old ID can remain in the renderer/session after a provider was deleted
    // and recreated under a new ID, or after a model was moved to another profile.
    // Resolve only by a unique exact model ID; never guess when several profiles
    // expose the same model.
    if (modelID && (!p || !row)) {
      const candidates = rows.filter((item) => item.id === modelID && !item.isBuiltin)
      const uniqueProviderIDs = [...new Set(candidates.map((item) => item.providerID))]
      if (uniqueProviderIDs.length === 1) {
        const canonicalID = uniqueProviderIDs[0]
        const canonicalProfile = profiles.find((item) => item.id === canonicalID && !item.disabled)
        const canonicalRow = candidates.find((item) => item.providerID === canonicalID)
        if (canonicalProfile && canonicalRow) {
          providerID = canonicalID
          p = canonicalProfile
          row = canonicalRow
        }
      }
    }
    if (!p) {
      selectedModel = null
      persistUIState()
      throw new Error(`Provider "${requestedProviderID}" no longer exists or is disabled. The provider catalog was refreshed; choose a model from the current list.`)
    }

    modelID = modelID || String(p.model || "")
    row = row || rows.find((item) => item.providerID === providerID && item.id === modelID)
    if (!row) {
      throw new Error(`Model "${modelID || "(missing)"}" is not in the current catalog for provider "${providerID}". Refresh the model list and choose an existing model.`)
    }

    // The session's profile stores the active model too. Keep the root profile
    // metadata (image/context/output limits) consistent with the selected model.
    if (modelID !== p.model || !!p.image !== !!row.image || (row.context && row.context !== p.contextLimit) || (row.output && row.output !== p.maxOutput)) {
      const { hasKey, ...clean } = p
      engine.upsertProfile({
        ...clean,
        model: modelID,
        image: !!row.image,
        ...(row.context ? { contextLimit: row.context } : {}),
        ...(row.output ? { maxOutput: row.output } : {}),
      })
    }
    if (sid) await vibe.session.switchModel(sid, providerID)
    selectedModel = `${providerID}/${modelID}`
    persistUIState()
    scheduleProviderRefresh("model-selected")
    return { providerID, id: modelID, selectedModel, recoveredStaleProvider: providerID !== requestedProviderID }
  },
  providerList: async () => {
    const catalog = providerCatalogData()
    return {
      custom: catalog.custom,
      formats: catalog.formats,
      source: catalog.source,
      changedAt: catalog.changedAt,
    }
  },
  providerSave: async (a = {}) => {
    const name = String(a.name || "Provider").trim(); const id = String(a.id || slug(name)).trim()
    if (!id) throw new Error("Provider ID/name is required")
    if (!a.baseURL) throw new Error("Provider API base URL is required")
    const models = Array.isArray(a.models) ? a.models.filter((m) => m && m.id).map((m) => ({ id: String(m.id), name: String(m.name || m.id), context: Number(m.context) || 0, output: Number(m.output) || 0, image: !!m.image })) : []
    const current = engine.listProfiles().find((p) => p.id === id)
    const isBuiltin = profileStore.BUILTIN.some((p) => p.id === id)
    const storedCustom = readJson(customProfilesFile, [])
    if (isBuiltin && !storedCustom.some((p) => p.id === id)) throw new Error(`Provider ID "${id}" is reserved for a built-in provider`)
    const model = models[0]?.id || String(a.model || current?.model || "")
    if (!model) throw new Error("Add at least one model before saving this provider")
    const headers = providerHeaders(a.headers)
    const extraBody = providerBody(a.body)
    const profile = { ...(current || {}), id, label: name, name, baseURL: String(a.baseURL).trim(), format: profileFormat(a.apiFormat), model, models, contextLimit: models[0]?.context || Number(a.contextLimit) || 128000, maxOutput: models[0]?.output || Number(a.maxOutput) || 8192, scope: a.scope === "project" ? "project" : "global", disabled: !!a.disabled, noAuth: false, headers, quirks: { ...(current?.quirks || {}), extraBody } }
    const result = engine.upsertProfile(profile)
    if (a.apiKey) engine.setKey(id, String(a.apiKey))
    if (a.apiKey) scheduleProviderRefresh("provider-key-saved")
    const saved = engine.listProfiles().find((p) => p.id === id)
    if (!saved) throw new Error("Provider save did not persist a profile")
    scheduleProviderRefresh("provider-saved")
    return { id, name, warning: result?.hints?.filter(Boolean).join("\n") || "", scope: saved.scope || profile.scope }
  },
  providerRemove: async (a = {}) => { const result = deleteCustomProfile(String(a.id || "")); scheduleProviderRefresh("provider-removed"); return result },
  providerDraftSave: async (a = {}) => saveProviderDraft(a),
  providerDraftLoad: async (a = {}) => ({ draft: loadProviderDraft(providerDraftKey(a.key)) }),
  providerDraftRemove: async (a = {}) => removeProviderDraft(providerDraftKey(a.key)),
  providerDisabled: async (a = {}) => { const p = profileDetails(String(a.id || "")); if (profileStore.BUILTIN.some((b) => b.id === p.id)) throw new Error("Built-in providers cannot be disabled from this screen"); const { hasKey, ...clean } = p; engine.upsertProfile({ ...clean, disabled: !!a.disabled }); if (selectedModel?.startsWith(p.id + "/") && a.disabled) selectedModel = null; persistUIState(); scheduleProviderRefresh("provider-toggled"); return { id: p.id, disabled: !!a.disabled } },
  providerKey: async (a = {}) => { const p = profileDetails(String(a.id || "")); return { key: p.noAuth ? "" : profileStore.getKey(p, home) } },
  providerModels: async (a = {}) => {
    const baseURL = String(a.baseURL || "").trim(); if (!baseURL) throw new Error("Provider API base URL is required")
    const format = profileApiFormat(profileFormat(a.apiFormat))
    let key = String(a.apiKey || "")
    let savedHeaders = {}
    if (a.id) { const p = profileDetails(a.id); if (!key) key = p.noAuth ? "" : profileStore.getKey(p, home); savedHeaders = p.headers || {} }
    const models = await providerMeta.listRemoteModels({ baseURL, apiKey: key, format, headers: providerHeaders(a.headers || savedHeaders) })
    return { models: models.slice(0, 200), count: models.length }
  },
  providerModel: async (a = {}) => {
    const format = profileApiFormat(profileFormat(a.apiFormat))
    let key = String(a.apiKey || "")
    let savedHeaders = {}
    if (a.id) { const p = profileDetails(a.id); if (!key) key = p.noAuth ? "" : profileStore.getKey(p, home); savedHeaders = p.headers || {} }
    const model = await providerMeta.lookupModel({ modelId: a.modelId, baseURL: a.baseURL, apiKey: key, format, headers: providerHeaders(a.headers || savedHeaders) })
    return { ...model, model: model.found ? { id: a.modelId, context: model.context, output: model.output, image: model.image, source: model.source } : undefined }
  },
  providerMeta: async (a = {}) => providerMeta.lookupModel({ modelId: a.modelId }),

  cwd: async () => currentDirectory,
  getDirectory: async () => ({ directory: currentDirectory, name: path.basename(currentDirectory) }),
  setDirectory: async (a = {}) => { currentDirectory = safeResolveDirectory(typeof a === "string" ? a : a.directory || a.dir); persistUIState(); return { directory: currentDirectory, name: path.basename(currentDirectory) } },
  gitBranch: async (a = {}) => { const directory = safeResolveDirectory(a.directory || currentDirectory); try { const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: directory, windowsHide: true, timeout: 5000 }); return { branch: stdout.trim() || null } } catch { return { branch: null } } },
  pickProject: async () => {
    const result = await dialog.showOpenDialog(win, { title: "Choose project folder", properties: ["openDirectory", "createDirectory"] })
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true }
    const directory = safeResolveDirectory(result.filePaths[0]); currentDirectory = directory; persistUIState()
    return { directory, name: path.basename(directory), branch: null }
  },
  pickAttachments: async () => {
    const result = await dialog.showOpenDialog(win, { title: "Attach files", properties: ["openFile", "multiSelections"] })
    if (result.canceled) return []
    for (const p of result.filePaths || []) pickedAttachmentPaths.add(path.resolve(p))
    return result.filePaths || []
  },
  readAttachment: async (a = {}) => readAttachmentData(typeof a === "string" ? a : a.path),
  ensureAgent: async () => ({ agents: [{ id: "vibecoderai", name: "VibeCoder AI", enabled: !disabledAgents.has("vibecoderai") }], active: activeAgent }),
  switchAgent: async (a = {}) => { const name = String(a.name || a.id || "VibeCoder AI"); if (!name.trim()) throw new Error("Agent name is required"); activeAgent = name; engine.agentName = name; persistUIState(); return { active: name } },
  listAgents: async () => ({ agents: [{ id: "vibecoderai", name: "VibeCoder AI", enabled: !disabledAgents.has("vibecoderai") }] }),
  setAgentDisabled: async (a = {}) => { const id = String(a.id || "vibecoderai"); if (a.disabled) disabledAgents.add(id); else disabledAgents.delete(id); return { id, disabled: disabledAgents.has(id) } },
  mcpList: async (a = {}) => mcp.listServers(a.directory || currentDirectory),
  mcpAdd: async (a = {}) => mcp.addServer({ ...a, directory: a.directory || currentDirectory }),
  mcpRemove: async (a = {}) => mcp.removeServer({ ...a, directory: a.directory || currentDirectory }),
  subagentCreate: async (a = {}) => { const id = idOf(a); requireSession(id); if (!subagentsEnabled || !engine.subagentsEnabled) throw new Error("Sub-agents are disabled"); return engine.createSubagent({ sessionId: id, type: a.type || "general", agent: a.agent, task: a.task, name: a.name, maxSteps: a.maxSteps, background: a.background !== false }) },
  subagentList: async (a = {}) => ({ subagents: engine.listSubagents(a.sessionID || a.sessionId || activeSessionId) }),
  subagentStatus: async (a = {}) => engine.subagentStatus(a.id || a.subagentID),
  subagentResult: async (a = {}) => engine.subagentResult(a.id || a.subagentID),
  subagentDetails: async (a = {}) => {
    const details = engine.subagentDetails(a.id || a.subagentID)
    if (!details) throw new Error("Subagent not found")
    return { ...details, messages: internalMessagesToUI(engine.getSession(details.childSessionId)) }
  },
  subagentResume: async (a = {}) => engine.resumeSubagent(a.id || a.subagentID, a.text || a.prompt || "Continue and report the result.", { maxSteps: a.maxSteps }),
  subagentStop: async (a = {}) => ({ stopped: await engine.stopSubagent(a.id || a.subagentID) }),
  subagentToggle: async (a = {}) => { if (a.enabled !== undefined) subagentsEnabled = !!a.enabled; engine.subagentsEnabled = subagentsEnabled; return { enabled: subagentsEnabled } },
  pluginList: async (a = {}) => plugins.listPlugins(a.directory || currentDirectory),
  pluginAdd: async (a = {}) => plugins.installPlugin({ ...a, directory: a.directory || currentDirectory }),
  pluginRemove: async (a = {}) => plugins.removePlugin({ ...a, name: a.name || a.spec, directory: a.directory || currentDirectory }),
  builtins: async (a = {}) => ({ mcp: catalog.BUILTIN.mcp || [], plugins: catalog.BUILTIN.plugins || [], pluginDirs: plugins.listPlugins(a.directory || currentDirectory) }),
  installBuiltinPlugin: async (a = {}) => { const item = (catalog.BUILTIN.plugins || []).find((x) => x.id === a.id || x.name === a.id); if (!item) throw new Error(`No built-in plugin named "${a.id}" is shipped in this build`); return plugins.installPlugin({ spec: item.spec, content: item.content, directory: a.directory || currentDirectory, global: !!a.global }) },
  removeBuiltinPlugin: async (a = {}) => plugins.removePlugin({ name: a.id || a.name, directory: a.directory || currentDirectory, global: !!a.global }),
  marketplace: async (a = {}) => {
    const directory = a.directory || currentDirectory
    const builtinItems = [
      ...(catalog.BUILTIN.mcp || []).map((x) => ({ ...x, id: x.id || x.name, title: x.title || x.name, kind: "mcp", custom: false })),
      ...(catalog.BUILTIN.plugins || []).map((x) => ({ ...x, id: x.id || x.name, title: x.title || x.name, kind: "plugin", custom: false })),
      ...(catalog.BUILTIN.skills || []).map((x) => ({ ...x, title: x.title || x.id, kind: "skill", custom: false })),
    ]
    const registries = catalog.listRegistries()
    const external = []; const registryStatus = []
    for (const reg of registries) {
      const fetched = await catalog.fetchRegistry(reg, { force: !!a.refresh })
      registryStatus.push({ id: reg.id, ok: !!fetched.doc, count: fetched.doc ? ["mcp","plugins","skills"].reduce((n,k) => n + (Array.isArray(fetched.doc[k]) ? fetched.doc[k].length : 0), 0) : 0, cached: !!fetched.cached, error: fetched.error || "" })
      const doc = fetched.doc; if (!doc) continue
      for (const kind of ["mcp", "plugins", "skills"]) if (Array.isArray(doc[kind])) external.push(...doc[kind].map((x) => ({ ...x, id: x.id || x.name || x.title, title: x.title || x.name || x.id, kind: kind === "plugins" ? "plugin" : kind === "skills" ? "skill" : "mcp", custom: true, registry: reg })))
    }
    const mcpNames = new Set(mcp.listServers(directory).map((x) => x.name)); const pluginNames = new Set(plugins.listPlugins(directory).map((x) => x.name)); const skillNames = new Set(skills.listSkills(directory).map((x) => x.id))
    let items = [...builtinItems, ...external].map((x) => ({ ...x, installed: x.kind === "mcp" ? mcpNames.has(x.name) : x.kind === "plugin" ? pluginNames.has(x.name || x.id) : skillNames.has(x.id || x.name), scope: (x.kind === "mcp" ? mcp.listServers(directory) : x.kind === "plugin" ? plugins.listPlugins(directory) : skills.listSkills(directory)).find((z) => z.name === x.name || z.id === x.id)?.scope }))
    // Skills installed from a GitHub repo or an external Agent-Skills folder may
    // not exist in a marketplace registry; include them as real installed items.
    for (const skill of skills.listSkills(directory)) {
      if (items.some((item) => item.kind === "skill" && String(item.id || item.name).toLowerCase() === skill.id.toLowerCase())) continue
      items.push({ id: skill.id, name: skill.name, title: skill.name, description: skill.description, kind: "skill", custom: true, installed: true, scope: skill.scope, path: skill.file, source: "local" })
    }
    if (a.kind && a.kind !== "all") items = items.filter((x) => x.kind === a.kind)
    const counts = { all: items.length, mcp: items.filter((x) => x.kind === "mcp").length, plugin: items.filter((x) => x.kind === "plugin").length, skill: items.filter((x) => x.kind === "skill").length, installed: items.filter((x) => x.installed).length }
    return { items, counts, registries, registryStatus }
  },
  installSkill: async (a = {}) => skills.installSkillFile({ ...a, directory: a.directory || currentDirectory }),
  removeSkill: async (a = {}) => skills.removeSkillFile({ ...a, directory: a.directory || currentDirectory }),
  installCustomSkill: async (a = {}) => skills.installSkillFile({ ...a, directory: a.directory || currentDirectory }),
  removeCustomSkill: async (a = {}) => skills.removeSkillFile({ ...a, directory: a.directory || currentDirectory }),
  importGitHubSkills: async (a = {}) => {
    const directory = a.directory || currentDirectory
    const result = await skills.importGitHubSkills({ source: a.source, global: !!a.global, directory })
    emitUI("skills.changed", null, { reason: "github-import", count: result.count, scope: a.global ? "global" : "project" })
    return result
  },
  registryAdd: async (a = {}) => catalog.addRegistry(a),
  registryRemove: async (a = {}) => catalog.removeRegistry(a),
  memoryPath: async () => memoriesFile,
  memoryList: async () => ({ path: memoriesFile, entries: readMemory() }),
  memoryAdd: async (a = {}) => { const text = String(a.text || "").trim().slice(0, 2000); if (!text) throw new Error("Memory text is empty"); const entries = readMemory(); if (!entries.some((e) => e.text === text)) entries.push({ id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, text, date: new Date().toISOString().slice(0, 10) }); saveMemory(entries); return { path: memoriesFile, entries: readMemory() } },
  memoryRemove: async (a = {}) => { const entries = readMemory(); const next = entries.filter((e) => e.id !== a.id); saveMemory(next); return { path: memoriesFile, entries: next, removed: entries.length !== next.length } },
  openMemoryFile: async () => { if (!fs.existsSync(memoriesFile)) writeJson(memoriesFile, []); const e = await shell.openPath(memoriesFile); if (e) throw new Error(e); return { path: memoriesFile } },
  todoList: async (a = {}) => { const id = idOf(a); return id ? engine.todoList(id) : { items: [] } },
  todoSave: async (a = {}) => { const id = idOf(a); return id ? engine.todoSave(id, { items: a.items }) : { items: Array.isArray(a.items) ? a.items : [] } },
  cliInfo: async () => ({ installed: true, version: require("../package.json").version, path: path.join(__dirname, "..", "cli", "vibe.js"), kind: "vibe" }),
  cliInstallTested: async () => ({ installed: true, message: "The bundled Vibe CLI is available in this project." }),
  cliUpdateCheck: async () => ({ available: false, checked: true, message: "Automatic CLI updates are not configured in this build." }),
  authStatus: async () => ({ connected: false, email: null, provider: null }),
  authConnect: async () => { throw new Error("Account login is not configured for this standalone SDK build. Configure a provider in Settings → Models.") },
  authDisconnect: async () => ({ disconnected: true }),
  upgradeInfo: async () => ({ available: false, message: "In-app upgrades are not configured in this build." }),
  startUpgrade: async () => { throw new Error("In-app upgrades are not configured in this build. Install a verified release manually.") },
  ownerScan: async (a = {}) => ({ found: false, text: String(a.text || ""), message: "Owner verification is not configured in this standalone build." }),
  ownerVerify: async () => ({ verified: false, message: "Owner verification is not configured in this standalone build." }),
  notify: async (a = {}) => { if (Notification?.isSupported?.()) new Notification({ title: String(a.title || "VibeCoder AI"), body: String(a.body || a.message || "") }).show(); return { notified: true } },
  openExternal: async (a = {}) => { const url = String(a.url || a.href || ""); if (!/^https?:\/\//i.test(url)) throw new Error("Only HTTP(S) URLs can be opened externally"); await shell.openExternal(url); return { opened: true } },
  restartEvents: async () => { emitUI("host.event_stream", null, { status: "connected", attempt: 1 }); return { restarted: true } },
  logError: async (a = {}) => { const file = path.join(home, "app-error.log"); fs.appendFileSync(file, `[${new Date().toISOString()}] renderer: ${String(a.message || a.error || "unknown error").slice(0, 8000)}\n`); return { logged: true } },
  openErrorLog: async () => { const file = path.join(home, "app-error.log"); if (!fs.existsSync(file)) fs.writeFileSync(file, "VibeCoder AI error log\n"); const e = await shell.openPath(file); if (e) throw new Error(e); return { path: file } },
  browserCreateTab: async (a = {}) => normalizeResult(await engine.browserCreateTab(a)),
  browserCloseTab: async (a = {}) => normalizeResult(await engine.browserCloseTab(a)),
  browserListTabs: async () => normalizeResult(await engine.browserListTabs()),
  browserCurrent: async (a = {}) => normalizeResult(await engine.browserCurrent(a)),
  browserNavigate: async (a = {}) => normalizeResult(await engine.browserNavigate(a)),
  browserScreenshot: async (a = {}) => normalizeResult(await engine.browserScreenshot(a)),
  browserEvaluate: async (a = {}) => normalizeResult(await engine.browserEvaluate(a)),
  browserSnapshot: async (a = {}) => normalizeResult(await engine.browserSnapshot(a)),
  browserClick: async (a = {}) => normalizeResult(await engine.browserClick(a)),
  browserFill: async (a = {}) => normalizeResult(await engine.browserFill(a)),
  browserPress: async (a = {}) => normalizeResult(await engine.browserPress(a)),
  browserScroll: async (a = {}) => normalizeResult(await engine.browserScroll(a)),
  // ---- Desktop auto-update status + preferences (read-only / safe) ----
  appUpdateStatus: async () => {
    if (!updater.enabled()) {
      return { enabled: false, version: require("../package.json").version || null, channel: "stable", state: "disabled", payload: null, lastCheckedAt: null, prefs: updater.serializePrefs() }
    }
    return updater.getStatus()
  },
  appUpdateSetPrefs: async (a = {}) => {
    const saved = updater.setPreferences(a)
    persistUIState() // persist the prefs into electron-ui-state.json
    return saved
  },
}

const preloadNames = [
  "info","setMode","getAllUsage","clearSessionRules","browserCreateTab","browserCloseTab","browserListTabs","browserCurrent","browserNavigate","browserScreenshot","browserEvaluate","browserSnapshot","browserClick","browserFill","browserPress","browserScroll",
  "listSessions","createSession","getMessages","renameSession","deleteSession","revertSession","undoSession","listSnapshots","listStepSnapshots","previewSnapshot","undoStepSession","redoSession","listRedo","getTrail","prompt","queuePrompt","resumeRun","interrupt","compactSession","getCompactionSettings","setCompactionSettings",
  "listShells","shellOutput","shellInput","backgroundSession","backgroundShell","cancelShell","setPermissions","listPermissionRequests","replyPermission","listForms","replyForm","cancelForm",
  "listModels","listAllModels","listModelLimits","setModel","providerCatalog","providerList","providerSave","providerRemove","providerDraftSave","providerDraftLoad","providerDraftRemove","providerDisabled","providerKey","providerModels","providerModel","providerMeta",
  "cwd","setDirectory","getDirectory","gitBranch","pickProject","pickAttachments","readAttachment","ensureAgent","switchAgent","listAgents","setAgentDisabled","mcpList","mcpAdd","mcpRemove","subagentCreate","subagentList","subagentStatus","subagentResult","subagentDetails","subagentResume","subagentStop","subagentToggle",
  "pluginList","pluginAdd","pluginRemove","builtins","installBuiltinPlugin","removeBuiltinPlugin","marketplace","installSkill","removeSkill","installCustomSkill","removeCustomSkill","importGitHubSkills","registryAdd","registryRemove","memoryPath","memoryList","memoryAdd","memoryRemove","openMemoryFile","todoList","todoSave","cliInfo","cliInstallTested","cliUpdateCheck","authStatus","authConnect","authDisconnect","upgradeInfo","startUpgrade","ownerScan","ownerVerify","notify","openExternal","restartEvents","logError","openErrorLog","appUpdateStatus","appUpdateSetPrefs"
]

function initBackend(targetWin, { port = Number(process.env.VIBE_SERVE_PORT || 4096), serve = process.env.VIBE_SERVE !== "0" } = {}) {
  backendClosing = false
  win = targetWin
  if (!registered) {
    registered = true
    for (const name of preloadNames) ipcMain.handle(`vibe:${name}`, async (event, arg) => {
      const fn = handlers[name]
      if (!fn) return { ok: false, error: `The operation "${name}" is not implemented in this build.` }
      try {
        if (name.startsWith("providerDraft") && (!win || event?.sender !== win.webContents || (event.senderFrame && event.senderFrame !== event.sender.mainFrame))) throw new Error("Untrusted provider draft request")
        return { ok: true, data: await fn(arg || {}) }
      }
      catch (e) { return { ok: false, error: String(e?.message || e) } }
    })
  }
  if (!browserResultRegistered) {
    browserResultRegistered = true
    ipcMain.handle("vibe:browserCommandResult", (event, payload = {}) => {
      // Only the trusted app renderer may acknowledge browser-control requests.
      if (!win || event.sender !== win.webContents) throw new Error("Untrusted browser command response")
      const manager = typeof engine._browserManager === "function" ? engine._browserManager() : null
      if (!manager || typeof manager.resolveCommand !== "function") throw new Error("Browser bridge is unavailable")
      return manager.resolveCommand(payload)
    })
  }
  if (!appUpdateRegistered) {
    appUpdateRegistered = true
    // Privileged updater actions (check / download / install) are registered on
    // their own channels so the sender identity can be validated before anything
    // runs. The renderer never chooses the URL or touches electron-updater.
    const requireTrusted = (event) => {
      if (!win || !event || event.sender !== win.webContents) throw new Error("Untrusted updater request")
    }
    ipcMain.handle("vibe:appUpdateCheck", (event, a = {}) => {
      requireTrusted(event)
      return updater.checkForUpdates({ silent: !!a.silent }).then((r) => ({ ok: r.ok, error: r.error || null, alreadyChecking: !!r.alreadyChecking }))
    })
    ipcMain.handle("vibe:appUpdateDownload", (event) => {
      requireTrusted(event)
      return updater.downloadUpdate().then((r) => ({ ok: r.ok, error: r.error || null }))
    })
    ipcMain.handle("vibe:appUpdateInstall", (event) => {
      requireTrusted(event)
      return updater.installUpdate().then((r) => ({ ok: r.ok, error: r.error || null }))
    })
  }
  if (win && typeof win.on === "function") {
    win.on("focus", () => emitUI("app.focus", null, { focused: true }))
    win.on("blur", () => emitUI("app.focus", null, { focused: false }))
  }
  startProviderWatcher()
  if (!eventOff) eventOff = engine.on(onEngineEvent)
  if (serve && !server) {
    try {
      const created = createServer(engine, { token: serverToken || undefined })
      server = created.server; serverToken = created.token
      let tryPort = port
      const listen = (p) => server.listen(p, "127.0.0.1", () => {
        console.log(`[vibe] server on http://127.0.0.1:${server.address().port}`)
        // The token is a local credential. Only print it in explicit dev mode.
        if (process.env.VIBE_LOG_TOKEN === "1" || process.argv.includes("--dev")) console.log(`[vibe] token: ${serverToken}`)
      })
      server.on("error", (e) => {
        if (e.code === "EADDRINUSE" && tryPort < port + 10) { console.log(`[vibe] port ${tryPort} busy, trying ${tryPort + 1}...`); listen(++tryPort) }
        else console.error("[vibe] server failed:", e.message)
      })
      listen(tryPort)
    } catch (e) { console.error("[vibe] server init failed:", e.message) }
  }
}
function shutdownBackend() {
  backendClosing = true
  stopProviderWatcher()
  try { eventOff?.() } catch {}
  eventOff = null
  if (server) { try { server.close() } catch {}; server = null }
  for (const id of [...engine.pending.keys()]) engine.replyPermission(id, "deny")
  for (const [name, st] of engine.mcp.clients || []) {
    try { st.client?.close?.() } catch {}
    engine.mcp.clients.delete(name)
  }
  win = null
}

const persisted = readJson(uiStateFile, {})
if (persisted.directory && fs.existsSync(persisted.directory)) { try { currentDirectory = safeResolveDirectory(persisted.directory) } catch {} }
if (typeof persisted.selectedModel === "string") selectedModel = persisted.selectedModel
if (typeof persisted.activeAgent === "string") { activeAgent = persisted.activeAgent; engine.agentName = activeAgent }
// Restore the desktop auto-update preferences (persisted under VIBE_HOME, never
// inside the install directory).
if (persisted[updater.PREF_KEY]) updater.deserializePrefs(persisted[updater.PREF_KEY])

module.exports = { initBackend, shutdownBackend, getServer: () => server, getToken: () => serverToken, app, engine, vibe }
