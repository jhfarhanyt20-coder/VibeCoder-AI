const state = {
  sessions: [],
  activeSessionID: null,
  mode: null,
  memoryFile: "",
  // why the last run was interrupted + the real error we saw for it
  interruptReason: null,
  userStopped: false,
  lastRealError: null,
  // the last message we sent -> lets a failed/timed-out run be retried
  lastSend: null,
  retryCount: 0,
  retryTimer: null,
  retryTick: null,
  retrying: false,
  // the ONE bubble every retry countdown/label writes into (no stacked rows)
  retryBubble: null,
  // the last tool-execution error message (set on session.tool.failed).
  // If the subsequent step.failed carries the same text, the run-level bubble
  // is suppressed so the user sees the error only inline on the tool card.
  lastToolError: null,
  // Prevent generic retries for a deterministic compaction failure.
  compactionBlockedRun: false,
  pulse: null,
  rewindLatestStep: null,
  rewindLatestTurn: null,
}

// Preload API only exists inside Electron; preview-safe stub for browser design preview.
// NOTE: contextBridge exposes `vibe` as a non-configurable global, so `const vibe`
// would throw "Identifier already declared" in Electron — use var (also makes the
// preview stub safe to attach).
var vibe = window.vibe ?? {
  info: async () => ({ ok: true, data: { mode: "cli", model: "opencode/glm-5.3" } }),
  listSessions: async () => ({ ok: true, data: [
    { id: "d1", title: "Reproduce paper: Sparse Attention", time: { updated: Date.now() - 86400000 } },
    { id: "d2", title: "Bot Channel Felishu binding flow", time: { updated: Date.now() - 3 * 86400000 } },
    { id: "d3", title: "MCP, Plugin & Commands", time: { updated: Date.now() - 3 * 86400000 } },
  ] }),
  listModels: async () => ({ ok: true, data: [] }),
  listModelLimits: async () => ({ ok: true, data: [] }),
  listAllModels: async () => ({ ok: true, models: [] }),
  mcpList: async () => ({ ok: true, data: { mcp: [], files: [] } }),
  mcpAdd: async () => ({ ok: true, data: {} }),
  mcpRemove: async () => ({ ok: true, data: {} }),
  pluginList: async () => ({ ok: true, data: { plugins: [], files: [] } }),
  pluginAdd: async () => ({ ok: true, data: {} }),
  pluginRemove: async () => ({ ok: true, data: {} }),
  builtins: async () => ({ ok: true, data: { mcp: [], plugins: [], pluginDirs: [] } }),
  installBuiltinPlugin: async () => ({ ok: true, data: {} }),
  removeBuiltinPlugin: async () => ({ ok: true, data: {} }),
  marketplace: async () => ({ ok: true, data: { items: [], counts: {} } }),
  installSkill: async () => ({ ok: true, data: {} }),
  removeSkill: async () => ({ ok: true, data: {} }),
  importGitHubSkills: async () => ({ ok: false, error: "GitHub skill import requires the desktop backend." }),
  setModel: async () => ({ ok: true }),
  ensureAgent: async () => ({ ok: true }),
  setDirectory: async () => ({ ok: true }),
  getDirectory: async () => ({ ok: true, data: null }),
  gitBranch: async () => ({ ok: true, data: null }),
  revertSession: async () => ({ ok: true }),
  undoSession: async () => ({ ok: true, data: {} }),
  listSnapshots: async () => ({ ok: true, data: [] }),
  listStepSnapshots: async () => ({ ok: true, data: [] }),
  previewSnapshot: async () => ({ ok: true, data: { files: [] } }),
  undoStepSession: async () => ({ ok: true, data: {} }),
  redoSession: async () => ({ ok: true, data: {} }),
  listRedo: async () => ({ ok: true, data: [] }),
  renameSession: async () => ({ ok: true }),
  deleteSession: async () => ({ ok: true }),
  interrupt: async () => ({ ok: true }),
  setPermissions: async () => ({ ok: true }),
  getMessages: async () => ({ ok: true, data: [] }),
  compactSession: async () => ({ ok: true, data: {} }),
  getCompactionSettings: async () => ({ ok: true, data: { auto: true, model: null } }),
  setCompactionSettings: async (value) => ({ ok: true, data: { auto: value?.auto !== false, model: value?.model || null } }),
  listShells: async () => ({ ok: true, data: [] }),
  shellOutput: async () => ({ ok: true, data: { output: "" } }),
  shellInput: async () => ({ ok: true, data: { bytes: 0 } }),
  backgroundSession: async () => ({ ok: true, data: { moved: [] } }),
  cancelShell: async () => ({ ok: true, data: {} }),
  listPermissionRequests: async () => ({ ok: true, data: [] }),
  replyPermission: async () => ({ ok: true }),
  listForms: async () => ({ ok: true, data: [] }),
  replyForm: async () => ({ ok: true }),
  cancelForm: async () => ({ ok: true }),
  cwd: async () => ({ ok: true, data: "D:\\vibecoder" }),
  switchAgent: async () => ({ ok: true }),
  createSession: async () => ({ ok: true, data: { id: "preview" } }),
  pickProject: async () => ({ ok: true, data: { directory: "D:\\demo", name: "demo", branch: null } }),
  pickAttachments: async () => ({ ok: true, data: ["C:/img/photo.png"] }),
  readAttachment: async (p) => ({ ok: true, data: { path: p, name: "photo.png", kind: "file", base64: "" } }),
  authStatus: async () => ({ ok: true, data: { connected: false, email: null } }),
  authConnect: async () => ({ ok: true }),
  authDisconnect: async () => ({ ok: true }),
  cliInfo: async () => ({ ok: true, data: { mode: "cli", source: "bundled", version: "opencode v2.1.1", parsed: "2.1.1", expected: "2.1.1", compatible: true, canInstall: false } }),
  cliInstallTested: async () => ({ ok: false, error: "Not available in the preview" }),
  cliUpdateCheck: async () => ({ ok: false, error: "Not available in the preview" }),
  prompt: async () => ({ ok: true, data: {} }),
  resumeRun: async () => ({ ok: false, error: "not available in this preview" }),
  setMode: async () => ({ ok: true, data: { mode: "cli" } }),
  restartEvents: async () => ({}),
  onEvent: (cb) => {
    // The preview stub keeps the handler so it can be driven by the tests.
    window.__onEvent = cb
    return () => {}
  },
  toast: (m) => alert(m),
  memoryPath: async () => ({ ok: true, data: "" }),
  memoryList: async () => ({ ok: true, data: { path: "", entries: [] } }),
  memoryAdd: async () => ({ ok: true, data: { path: "", entries: [] } }),
  memoryRemove: async () => ({ ok: true, data: { path: "", entries: [] } }),
  openMemoryFile: async () => ({ ok: false, error: "Not available" }),
  listAgents: async () => ({ ok: true, data: { agents: [] } }),
  setAgentDisabled: async () => ({ ok: true, data: {} }),
  subagentCreate: async () => ({ ok: true, data: { id: "sub-preview", status: "running" } }),
  subagentList: async () => ({ ok: true, data: { subagents: [] } }),
  subagentStatus: async () => ({ ok: true, data: { id: "", status: "done", error: "" } }),
  subagentResult: async () => ({ ok: true, data: { id: "", status: "done", result: "", error: "" } }),
  subagentDetails: async () => ({ ok: true, data: { id: "", name: "Subagent", status: "done", messages: [], progress: [] } }),
  subagentResume: async () => ({ ok: true, data: { status: "running" } }),
  subagentStop: async () => ({ ok: true, data: { stopped: true } }),
  subagentToggle: async () => ({ ok: true, data: { enabled: true } }),
  // browser tools (the agent's browser.* tools call these through the engine)
  browserListTabs: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserCreateTab: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserCloseTab: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserNavigate: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserScreenshot: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserEvaluate: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserSnapshot: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserClick: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserFill: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserPress: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  browserScroll: async () => ({ ok: false, error: "No browser available. Browser tools only work inside the Electron app." }),
  providerList: async () => ({ ok: true, data: { custom: [], formats: [] } }),
  providerSave: async () => ({ ok: true, data: {} }),
  providerRemove: async () => ({ ok: true, data: {} }),
  providerDisabled: async () => ({ ok: true, data: {} }),
  providerModels: async () => ({ ok: true, data: { models: [], count: 0 } }),
  providerModel: async () => ({ ok: true, data: { found: false } }),
  providerMeta: async () => ({ ok: true, data: { found: false } }),
  logError: async () => ({ ok: true }),
  openErrorLog: async () => ({ ok: false, error: "Error log is not available" }),
}
window.vibe = window.vibe ?? vibe

const $ = (id) => document.getElementById(id)

/* ---------- visible error surface ----------
   Failures used to be swallowed (catch {}, console.warn) and the app could look
   idle while nothing was happening. Every important failure now lands here. */
const errorState = { key: "", title: "", short: "", full: "", tone: "error", expanded: false }
function showError(title, detail, opts = {}) {
  const full = String(detail ?? "").trim()
  const heading = String(title || "Something went wrong").trim()
  const tone = opts.tone === "warning" || opts.tone === "success" ? opts.tone : "error"
  const banner = $("error-banner")
  // "Retry" only makes sense for a run we can actually resend.
  const retryBtn = $("error-retry")
  if (retryBtn) retryBtn.hidden = !(opts.retry && state.lastSend && !state.running)
  if (!full && !heading) return
  const key = opts.key || `${heading}\n${full}`
  if (errorState.key === key && errorState.full === full && errorState.tone === tone && !banner.hidden) return
  errorState.key = key
  errorState.title = heading
  errorState.full = full
  errorState.short = full.length > 1400 ? full.slice(0, 1400) + "…" : full
  errorState.tone = tone
  errorState.expanded = false
  banner.dataset.tone = tone
  banner.setAttribute("role", tone === "error" ? "alert" : "status")
  banner.setAttribute("aria-live", tone === "error" ? "assertive" : "polite")
  $("error-title").textContent = heading
  $("error-body").textContent = errorState.short
  $("error-details").hidden = full.length <= 1400
  $("error-details").textContent = "Show details"
  $("error-open-log").hidden = tone !== "error"
  banner.hidden = false
  if (tone === "error") {
    console.error(`[VibeCoder] ${heading}`, full)
    try { window.vibe?.logError?.({ title: heading, detail: full }) } catch {}
  } else {
    console.warn(`[VibeCoder] ${heading}`, full)
  }
}
function hideError(key) {
  if (key && errorState.key !== key) return
  $("error-banner").hidden = true
  errorState.key = ""
  errorState.title = ""
  errorState.short = ""
  errorState.full = ""
  errorState.tone = "error"
  errorState.expanded = false
}
if ($("error-close")) $("error-close").onclick = () => hideError()
if ($("error-details")) $("error-details").onclick = () => {
  if (!errorState.full) return
  errorState.expanded = !errorState.expanded
  $("error-body").textContent = errorState.expanded ? errorState.full : errorState.short
  $("error-details").textContent = errorState.expanded ? "Hide details" : "Show details"
}
if ($("error-open-log")) $("error-open-log").onclick = async () => {
  try {
    const r = await vibe.openErrorLog()
    if (r && r.ok === false) alert("Could not open the error log: " + (r.error || "unknown error"))
  } catch (e) {
    alert("Could not open the error log: " + String(e))
  }
}
if ($("error-retry")) $("error-retry").onclick = () => {
  hideError()
  retryLastRun()
}

/* Last-resort visibility for renderer crashes / unhandled async failures. */
window.addEventListener("error", (e) => {
  // The browser's harmless "ResizeObserver loop" notice is not an app error.
  if (/ResizeObserver loop/i.test(String(e?.message || ""))) { e.stopImmediatePropagation?.(); return }
  showError("Unexpected UI error", e?.error?.stack || e?.message || String(e))
})
window.addEventListener("unhandledrejection", (e) => {
  const r = e?.reason
  showError("Unhandled error", r?.stack || r?.message || String(r))
})

/* ---------- background notifications ---------- */
const NOTIFY_KEY = "vibecoder.notify"
const AUTO_CONTINUE_KEY = "vibecoder.autocontinue"
const AUTO_CONTINUE_MAX = 5

/* Background run state: the agent's own plan + how many automatic
   continuations this run already used. */
const autoCont = { todos: [], count: 0, timer: null }

function notificationsEnabled() {
  try {
    return localStorage.getItem(NOTIFY_KEY) !== "off"
  } catch {
    return true
  }
}

function autoContinueEnabled() {
  try {
    return localStorage.getItem(AUTO_CONTINUE_KEY) !== "off"
  } catch {
    return true
  }
}

/** True when the user is not looking at the app (needs a toast). */
function appIsInBackground() {
  try {
    return document.hidden || !document.hasFocus()
  } catch {
    return false
  }
}

/** Short summary of the agent's last answer, for the notification body. */
function lastAnswerSummary() {
  const bubbles = [...$("messages").querySelectorAll(".msg.assistant")]
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const text = (bubbles[i].textContent || "").replace(/\s+/g, " ").trim()
    if (!text) continue
    if (/^⚠/.test(text)) continue
    return text.length > 140 ? text.slice(0, 140) + "…" : text
  }
  return ""
}

/**
 * Windows toast for a finished / blocked agent run. Only fires when the app is
 * in the background and notifications are enabled in General settings.
 */
function notifyAgent(title, body) {
  try {
    if (!notificationsEnabled()) return
    if (!appIsInBackground()) return
    if (!vibe.notify) return
    Promise.resolve(vibe.notify({ title, body: body || "" })).catch(() => {})
  } catch {}
}

/* ---------- background job indicator ---------- */
/* The agent keeps working while the app sits in the background. A chip in the
   top-left of the chat shows that; clicking it opens the list of running jobs
   and lets the user stop them. */
const bgJob = { startedAt: 0, noteShown: false, timer: null, panelSignature: "" }

/* every job that is currently running: the agent run + the open tool calls +
   the background shells ({ kind, title, at, shellId?, backgrounded?, file? }) */
const runningJobs = new Map()
const shellInputDrafts = new Map()
const shellToolOutputs = new Map()
const reconciledShellResults = new Set()
let shellRefreshInFlight = false
let shellSyncTimer = null

function terminalText(value, max = 12000) {
  const clean = String(value || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
  return clean.length > max ? clean.slice(-max) : clean
}

function bgJobPanelSignature() {
  return JSON.stringify([...runningJobs.entries()].map(([key, job]) => [
    key, job.kind, job.title, job.command, !!job.backgrounded, !!job.waitingForInput, job.writable !== false,
    Number(job.outputSize || 0), String(job.output || "").length,
  ]))
}

function refreshBgJobTimes() {
  document.querySelectorAll("#bg-job-list .bji-time[data-at]").forEach((el) => {
    const bits = [jobElapsed(Number(el.dataset.at) || Date.now())]
    if (el.dataset.backgrounded === "true") bits.push("background")
    if (el.dataset.waiting === "true") bits.push("waiting for input")
    el.textContent = bits.join(" · ")
  })
}

function updateShellOutputView(shellID, output) {
  const el = [...document.querySelectorAll("#bg-job-list .bji-output")].find((node) => node.dataset.shellId === shellID)
  if (!el) return
  el.textContent = terminalText(output) || "Waiting for output…"
  el.scrollTop = el.scrollHeight
}

async function sendRunningShellInput(shellID, { eof = false } = {}) {
  if (!state.activeSessionID || !vibe.shellInput) return
  const text = shellInputDrafts.get(shellID) || ""
  try {
    const res = await vibe.shellInput({ sessionID: state.activeSessionID, shellID, text, enter: !eof, eof })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not send input")
    shellInputDrafts.set(shellID, "")
    const job = runningJobs.get(`shell:${shellID}`)
    if (job && eof) job.writable = false
    renderBgJobPanel()
    hideError("shell-input")
  } catch (error) {
    showError("Could not send shell input", String(error?.message || error), { key: "shell-input" })
  }
}

function jobElapsed(at) {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`
}

/**
 * A job is running when the agent run is alive OR a shell command is running
 * (background or still blocking the agent). OpenCode keeps its running-task chip
 * visible for those, so the user can stop them while they run.
 */
// The chip in the top-left corner is only for commands: a shell / cmd / a
// background process. That the agent itself is working already shows in the
// composer (the Stop button), so a plain run or an ordinary tool shows no chip.
const SHELL_TOOL = /^(bash|shell|sh|cmd|powershell|pwsh|terminal|command)$/i
function shellJobs() {
  return [...runningJobs.values()].filter((j) => j.shellId || (j.kind === "Tool" && SHELL_TOOL.test(String(j.title || ""))))
}
function bgJobActive() {
  return shellJobs().length > 0
}

// Command cards the user opened (closed by default: one line each).
const bgJobOpen = new Set()

/** The panel that lists the running jobs. */
function renderBgJobPanel() {
  const list = $("bg-job-list")
  if (!list) return
  list.textContent = ""
  bgJob.panelSignature = bgJobPanelSignature()
  const now = Date.now()
  // A shell's own row (with its command, output and input) replaces the bare
  // tool row of the same call, so one command is listed once.
  const shellCalls = new Set([...runningJobs.values()].filter((j) => j.shellId && j.toolCallId).map((j) => `tool:${j.toolCallId}`))
  // Only commands are listed (the agent's own run shows in the composer).
  const jobs = [...runningJobs.entries()].filter(([key, j]) => !shellCalls.has(key) && (j.shellId || (j.kind === "Tool" && SHELL_TOOL.test(String(j.title || "")))))
  const head = document.querySelector("#bg-job-panel .bg-job-head > span")
  if (head) head.textContent = jobs.length > 1 ? `Running commands · ${jobs.length}` : "Running command"
  if (!jobs.length) {
    const empty = document.createElement("div")
    empty.className = "bg-job-item bji-empty"
    empty.textContent = "No command is running."
    list.appendChild(empty)
    return
  }
  for (const k of [...bgJobOpen]) if (!jobs.some(([key, j]) => (j.shellId || key) === k)) bgJobOpen.delete(k)
  const icon = (paths) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  // One terminal card per command, IDE style: a header line (status, name,
  // time, icon buttons), then the command, its live output and an input line.
  for (const [key, job] of jobs) {
    const row = document.createElement("div")
    row.className = "bg-job-item bji-card"
    row.dataset.kind = job.shellId && job.backgrounded ? "background" : "shell"
    const top = document.createElement("div")
    top.className = "bji-top"
    const dot = document.createElement("span")
    dot.className = "bji-dot"
    const title = document.createElement("span")
    title.className = "bji-title"
    title.textContent = job.title || job.command || key
    title.title = job.title || job.command || key
    const time = document.createElement("span")
    time.className = "bji-time"
    time.dataset.at = String(job.at || now)
    time.dataset.backgrounded = String(!!(job.shellId && job.backgrounded))
    time.dataset.waiting = String(!!(job.shellId && job.waitingForInput))
    const bits = [jobElapsed(job.at || now)]
    if (job.shellId && job.backgrounded) bits.push("background")
    if (job.shellId && job.waitingForInput) bits.push("waiting for input")
    time.textContent = bits.join(" · ")
    const acts = document.createElement("div")
    acts.className = "bji-acts"
    // A blocking shell can be sent to the background (Ctrl+B) and keeps running.
    if (job.shellId && !job.backgrounded) {
      const mv = document.createElement("button")
      mv.className = "bg-job-move bji-icon"
      mv.type = "button"
      mv.innerHTML = icon('<path d="M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10"/>')
      mv.title = "Move to the background (Ctrl+B): it keeps running"
      mv.setAttribute("aria-label", "Move to the background")
      mv.onclick = () => moveRunningJobToBackground(job.shellId)
      acts.appendChild(mv)
    }
    const stop = document.createElement("button")
    stop.className = "bg-job-stop bji-icon"
    stop.type = "button"
    stop.innerHTML = icon('<rect x="4" y="4" width="8" height="8" rx="1.5"/>')
    stop.title = "Stop this command (the agent keeps running)"
    stop.setAttribute("aria-label", "Stop this command")
    stop.onclick = () => stopRunningJob(key)
    acts.appendChild(stop)
    const chev = document.createElement("span")
    chev.className = "bji-chev"
    chev.setAttribute("aria-hidden", "true")
    chev.innerHTML = icon('<path d="m6 4 4 4-4 4"/>')
    top.prepend(chev)
    top.append(dot, title, time, acts)
    row.appendChild(top)
    // Click the line to see what the command is doing; click again to close.
    const openKey = job.shellId || key
    row.classList.toggle("open", bgJobOpen.has(openKey))
    top.setAttribute("role", "button")
    top.tabIndex = 0
    top.setAttribute("aria-expanded", String(bgJobOpen.has(openKey)))
    const toggle = () => {
      const open = !row.classList.contains("open")
      row.classList.toggle("open", open)
      top.setAttribute("aria-expanded", String(open))
      if (open) bgJobOpen.add(openKey)
      else bgJobOpen.delete(openKey)
      if (open) { const out = row.querySelector(".bji-output"); if (out) out.scrollTop = out.scrollHeight }
    }
    top.onclick = (event) => { if (!event.target.closest(".bji-acts")) toggle() }
    top.onkeydown = (event) => { if ((event.key === "Enter" || event.key === " ") && event.target === top) { event.preventDefault(); toggle() } }

    const term = document.createElement("div")
    term.className = "bji-term"
    if (job.command) {
      const command = document.createElement("div")
      command.className = "bji-command"
      const prompt = document.createElement("span")
      prompt.className = "bji-prompt"
      prompt.textContent = "$"
      const text = document.createElement("span")
      text.className = "bji-command-text"
      text.textContent = job.command
      command.title = job.command
      command.append(prompt, text)
      term.appendChild(command)
    }
    if (job.shellId) {
      const output = document.createElement("pre")
      output.className = "bji-output"
      output.dataset.shellId = job.shellId
      output.textContent = terminalText(job.output) || "Waiting for output…"
      term.appendChild(output)
      if (job.writable !== false) {
        const inputRow = document.createElement("div")
        inputRow.className = "bji-input-row"
        const prompt = document.createElement("span")
        prompt.className = "bji-prompt"
        prompt.textContent = "›"
        const field = document.createElement("input")
        field.className = "bji-input"
        field.type = "text"
        field.placeholder = "Type input for the command, Enter to send"
        field.value = shellInputDrafts.get(job.shellId) || ""
        field.oninput = () => shellInputDrafts.set(job.shellId, field.value)
        field.onkeydown = (event) => {
          if (event.key !== "Enter" || event.shiftKey) return
          event.preventDefault()
          shellInputDrafts.set(job.shellId, field.value)
          sendRunningShellInput(job.shellId)
        }
        const send = document.createElement("button")
        send.className = "bji-input-send"
        send.type = "button"
        send.textContent = "Send"
        send.onclick = () => { shellInputDrafts.set(job.shellId, field.value); sendRunningShellInput(job.shellId) }
        const eof = document.createElement("button")
        eof.className = "bji-input-eof"
        eof.type = "button"
        eof.textContent = "EOF"
        eof.title = "Close input for this command (end of input)"
        eof.onclick = () => { shellInputDrafts.set(job.shellId, field.value); sendRunningShellInput(job.shellId, { eof: true }) }
        inputRow.append(prompt, field, send, eof)
        term.appendChild(inputRow)
      }
    }
    if (term.childNodes.length) row.appendChild(term)
    list.appendChild(row)
  }
}

function toggleBgJobPanel(force) {
  const panel = $("bg-job-panel")
  if (!panel) return
  const show = force !== undefined ? force : panel.hidden
  if (show) renderBgJobPanel()
  panel.hidden = !show
}

/**
 * Stop one running job. A background shell dies alone (the agent keeps
 * running); the agent run or one of its tool calls is stopped with the run.
 */
async function stopRunningJob(key) {
  const job = runningJobs.get(key)
  try {
    if (job && job.shellId) {
      runningJobs.delete(key)
      renderBgJob()
      if (state.activeSessionID) {
        const res = await vibe.cancelShell({ sessionID: state.activeSessionID, shellID: job.shellId })
        if (res && res.ok === false) showError("Could not stop the command", res.error || "Unknown error", { key: "stopjob" })
        else hideError("stopjob")
      }
      return
    }
    if (key !== "agent" && runningJobs.has(key)) runningJobs.delete(key)
    renderBgJobPanel()
    if (state.activeSessionID) {
      const res = await vibe.interrupt({ sessionID: state.activeSessionID })
      if (res && res.ok === false) {
        showError("Could not stop the job", res.error || "Unknown error", { key: "stopjob" })
      } else {
        hideError("stopjob")
      }
    }
  } catch (e) {
    showError("Could not stop the job", String(e), { key: "stopjob" })
  }
}

/** Ctrl+B / the per-row button: keep the process, let the agent continue. */
async function moveRunningJobToBackground(shellID) {
  if (!state.activeSessionID) return
  try {
    const res = await vibe.backgroundShell({ sessionID: state.activeSessionID, shellID })
    if (res && res.ok === false) showError("Could not move the command to the background", res.error || "Unknown error", { key: "movebg" })
    else hideError("movebg")
  } catch (e) {
    showError("Could not move the command to the background", String(e), { key: "movebg" })
  }
}

/** Ctrl+B (OpenCode's session.background): move every blocking command at once. */
async function moveAllToBackground() {
  const blocking = [...runningJobs.values()].filter((j) => j.shellId && !j.backgrounded)
  if (!blocking.length || !state.activeSessionID) return
  for (const j of blocking) await vibe.backgroundShell({ sessionID: state.activeSessionID, shellID: j.shellId })
  const res = await vibe.backgroundSession({ sessionID: state.activeSessionID }).catch(() => null)
  if (res && res.ok && res.data && res.data.moved && res.data.moved.length) {
    // mark them as backgrounded in our local job registry
    for (const j of blocking) {
      const key = `shell:${j.shellId}`
      const local = runningJobs.get(key)
      if (local) local.backgrounded = true
    }
    renderBgJob()
  }
}

function renderBgJob() {
  const el = $("bg-job")
  if (!el) return
  if (!bgJobActive()) {
    el.hidden = true
    $("bg-job-panel") && ($("bg-job-panel").hidden = true)
    if (bgJob.timer) {
      clearInterval(bgJob.timer)
      bgJob.timer = null
    }
    syncTodoPosition()
    return
  }
  el.hidden = false
  syncTodoPosition()
  // Just "Shell" or "Background" (with a count when several run); the panel
  // behind the chip still lists every process as before. A shell's own row
  // wins over the bare tool row of the same call.
  const shells = shellJobs()
  const real = shells.filter((j) => j.shellId)
  const list = real.length ? real : shells
  const kind = list.every((j) => j.shellId && j.backgrounded) ? "Background" : "Shell"
  $("bg-job-text").textContent = list.length > 1 ? `${kind} · ${list.length}` : kind
  $("bg-job-btn").title = list.map((j) => j.command || j.title || "").filter(Boolean).join("\n") || "Show the running commands"
  if (!$("bg-job-panel").hidden) {
    if (bgJob.panelSignature !== bgJobPanelSignature()) renderBgJobPanel()
    else refreshBgJobTimes()
  }
  if (!bgJob.timer) {
    bgJob.timer = setInterval(() => {
      if (!bgJobActive()) {
        clearInterval(bgJob.timer)
        bgJob.timer = null
        return
      }
      renderBgJob()
    }, 1000)
  }
}

/** The window lost focus while the agent was working -> it is a background job.
 *  The running job is shown by the chip in the top-left corner of the chat
 *  (and its panel with the Stop buttons) - NOT as a message inside the chat,
 *  so the conversation only holds the real work. */
function markBackgroundJob() {
  if (state.running && !bgJob.startedAt) {
    bgJob.startedAt = Date.now()
    renderBgJob()
    if (!bgJob.noteShown) {
      bgJob.noteShown = true
      // Nothing is written into the chat: the running job is shown by the
      // chip in the top-left corner. The agent keeps working on its own; the
      // automatic continuation (autoContinueNow) handles the "user is away"
      // case when a run ends.
    }
  }
}

function clearBackgroundJob() {
  bgJob.startedAt = 0
  bgJob.noteShown = false
  // The agent run is over: its tool rows are done, but a background command keeps
  // running and must stay in the list with its Stop button.
  for (const [key, job] of [...runningJobs]) if (!job.shellId) runningJobs.delete(key)
  renderBgJob()
}

/* chip -> open/close the running job list, stop buttons */
$("bg-job-btn")?.addEventListener("click", (e) => {
  e.stopPropagation()
  toggleBgJobPanel()
})
$("bg-job-close")?.addEventListener("click", (e) => {
  e.stopPropagation()
  toggleBgJobPanel(false)
})
// The panel lists commands only, so its button stops the commands; the agent
// itself is stopped with the composer's Stop button.
$("bg-job-stop")?.addEventListener("click", (e) => {
  e.stopPropagation()
  stopAllCommands()
})
async function stopAllCommands() {
  const shells = [...runningJobs.values()].filter((j) => j.shellId)
  for (const j of shells) await moveOrStopShell(j.shellId, false)
  renderBgJob()
}
document.addEventListener("click", (e) => {
  const panel = $("bg-job-panel")
  if (panel && !panel.hidden && !(e.target.closest && e.target.closest(".bg-job"))) {
    toggleBgJobPanel(false)
  }
})

/* Ctrl+B (OpenCode's session.background): keep the commands, free the agent. */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return
  if (e.shiftKey || e.altKey) return
  if (String(e.key || "").toLowerCase() !== "b") return
  const blocking = [...runningJobs.values()].some((j) => j.shellId && !j.backgrounded)
  if (!blocking) return
  e.preventDefault()
  moveAllToBackground()
})

/** "Stop all": the agent run plus every running command of this session. */
async function stopAllJobs() {
  const shells = [...runningJobs.values()].filter((j) => j.shellId)
  for (const j of shells) await moveOrStopShell(j.shellId, false)
  if (runningJobs.has("agent") || state.running) stopRunningJob("agent")
  renderBgJob()
}

/** Shared by the per-row button: cancel one shell and drop it from the list. */
async function moveOrStopShell(shellID, move) {
  if (!state.activeSessionID) return
  const key = `shell:${shellID}`
  try {
    if (move) await vibe.backgroundShell({ sessionID: state.activeSessionID, shellID })
    else {
      runningJobs.delete(key)
      await vibe.cancelShell({ sessionID: state.activeSessionID, shellID })
    }
    hideError("stopjob")
  } catch (e) {
    showError("Could not stop the command", String(e), { key: "stopjob" })
  }
  renderBgJob()
}

/**
 * Restore the commands that are still running when the app starts or the user
 * switches the session (the job registry lives in the backend, not here).
 */
function applyFinalShellOutput(shell, output) {
  const text = terminalText(output, 30000)
  const toolCallId = shell?.toolCallId
  if (!toolCallId) return
  // Completion can arrive after the original tool event stream has closed. Keep
  // the authoritative final tail until the tool row is available, then replace
  // its streamed preview (which may have missed an IPC batch) with the snapshot.
  const final = { text, status: shell?.status || "completed", exit: shell?.exit }
  const out = actOut(`tool:${toolCallId}`)
  if (out) {
    const footer = `[process ${final.status}${final.exit !== undefined ? ` · exit ${final.exit}` : ""}]`
    out.textContent = `${text || "Process completed with no output."}${text ? "\n\n" : ""}${footer}`
    if (final.exit !== undefined) out.dataset.exitCode = String(final.exit)
    else delete out.dataset.exitCode
    const row = actEls.get(`tool:${toolCallId}`)
    if (row) {
      row.classList.remove("done", "failed")
      row.classList.add(final.status === "completed" ? "done" : "failed")
      const state = row.querySelector(".act-state")
      if (state) state.textContent = final.status === "completed" ? "✓" : "✕"
    }
    shellToolOutputs.delete(toolCallId)
  } else {
    shellToolOutputs.set(toolCallId, final)
    while (shellToolOutputs.size > 50) shellToolOutputs.delete(shellToolOutputs.keys().next().value)
  }
}

/**
 * Reconcile the renderer with the backend's authoritative shell registry.
 * Event streams are low-latency hints, not the sole source of truth: if a
 * window sleeps, an IPC event is missed, or a large burst is coalesced, this
 * snapshot heals the running panel and the associated tool output.
 */
async function refreshShellJobs() {
  if (!state.activeSessionID || typeof vibe.listShells !== "function" || shellRefreshInFlight) return
  const sessionID = state.activeSessionID
  shellRefreshInFlight = true
  try {
    const res = await vibe.listShells({ sessionID })
    if (!res || !res.ok || sessionID !== state.activeSessionID) return
    const shells = Array.isArray(res.data) ? res.data : []
    let changed = false
    for (const sh of shells) {
      // A session switch can happen while a shellOutput IPC call is pending.
      // Never let an older snapshot repopulate the newly selected session.
      if (sessionID !== state.activeSessionID) break
      if (!sh?.id) continue
      const key = `shell:${sh.id}`
      const prev = runningJobs.get(key) || {}
      if (sh.status !== "running") {
        // A completion event may have been lost while the app was suspended.
        if ((prev.shellId || sh.toolCallId) && !reconciledShellResults.has(sh.id)) {
          let finalOutput = prev.output || ""
          if (typeof vibe.shellOutput === "function") {
            const tail = await vibe.shellOutput({ sessionID, shellID: sh.id, max: 30000 }).catch(() => null)
            if (sessionID !== state.activeSessionID) return
            if (tail?.ok) finalOutput = typeof tail.data === "string" ? tail.data : (tail.data?.output || finalOutput)
          }
          if (sessionID !== state.activeSessionID) return
          applyFinalShellOutput(sh, finalOutput)
          reconciledShellResults.add(sh.id)
          while (reconciledShellResults.size > 200) reconciledShellResults.delete(reconciledShellResults.values().next().value)
          changed = true
        }
        if (prev.shellId) {
          runningJobs.delete(key)
          shellInputDrafts.delete(sh.id)
          changed = true
        }
        continue
      }
      let output = prev.output || ""
      const sizeChanged = Number(sh.size || 0) !== Number(prev.outputSize || 0)
      if (typeof vibe.shellOutput === "function" && (sizeChanged || !prev.output)) {
        const tail = await vibe.shellOutput({ sessionID, shellID: sh.id, max: 12000 }).catch(() => null)
        if (sessionID !== state.activeSessionID) return
        if (tail?.ok) output = typeof tail.data === "string" ? tail.data : (tail.data?.output || output)
      }
      if (sessionID !== state.activeSessionID) return
      runningJobs.set(key, {
        ...prev,
        kind: "Shell",
        title: String(sh.description || sh.intent || sh.command || "shell"),
        command: String(sh.command || ""),
        at: sh.started || prev.at || Date.now(),
        shellId: sh.id,
        backgrounded: !!sh.backgrounded,
        writable: sh.writable !== false,
        waitingForInput: !!sh.waitingForInput,
        toolCallId: sh.toolCallId || prev.toolCallId || "",
        output: terminalText(output),
        outputSize: Number(sh.size || 0),
      })
      changed = true
    }
    if (changed) renderBgJob()
  } catch {
    // A transient bridge failure is recovered by the next scheduled snapshot.
  } finally {
    shellRefreshInFlight = false
  }
}

function startShellJobSync() {
  if (shellSyncTimer) return
  shellSyncTimer = setInterval(() => {
    if (document.hidden || !state.activeSessionID || shellRefreshInFlight) return
    refreshShellJobs()
  }, 2200)
  if (shellSyncTimer && typeof shellSyncTimer.unref === "function") shellSyncTimer.unref()
}

startShellJobSync()
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshShellJobs()
})
window.addEventListener("focus", () => refreshShellJobs())

/* ---------- background auto-continue ---------- */

/** The agent's own plan (todowrite) — what is still open. */
function pendingTodos() {
  return (autoCont.todos || []).filter(
    (t) => t && (t.status === "pending" || t.status === "in_progress"),
  )
}

/** Does the agent still have work left? */
function agentLooksUnfinished() {
  if (pendingTodos().length) return true
  const text = lastAnswerSummary().toLowerCase()
  return /\b(next|now i|let me|remaining|still need|todo|then i|after that|continue|will now)\b/.test(text)
}

/**
 * The background run finished -> wake the agent up with a short nudge so it
 * keeps working on its own, then notifies the user when everything is done.
 */
async function autoContinueNow() {
  const sid = state.activeSessionID
  if (!sid) return
  if (!autoContinueEnabled()) return
  if (autoCont.count >= AUTO_CONTINUE_MAX) {
    showError(
      "The agent paused in the background",
      `It reached the limit of ${AUTO_CONTINUE_MAX} automatic continuations. Open the app to continue.`,
      { key: "autocontinue" },
    )
    notifyAgent(
      "Auto-continue limit reached",
      `The agent paused after ${AUTO_CONTINUE_MAX} automatic continuations. Open the app to continue.`,
    )
    return
  }
  autoCont.count++
  const n = autoCont.count
  const text =
    "Background run finished. Continue automatically with the remaining work — do not wait for confirmation, " +
    "finish every pending item, then run the final verification (build/tests, or start the app) and give a short " +
    "summary of what is done, the verification command with its real result, and anything the user still has to do."
  try {
    // keep the permission mode the user picked (ask / full access)
    await applyPermissionMode()
    // agentOnly: the nudge goes to the model only - no bubble in the chat
    const res = await vibe.prompt({ sessionID: sid, text, files: [], thinking: "low", agentOnly: true })
    if (res && res.ok === false) {
      showError("Could not continue in the background", res.error || "Unknown error", { key: "autocontinue" })
    } else {
      hideError("autocontinue")
    }
  } catch (e) {
    showError("Could not continue in the background", String(e), { key: "autocontinue" })
  }
}

/** Called when a run ends while the user is away. */
function scheduleAutoContinue() {
  if (!autoContinueEnabled()) return
  if (!agentLooksUnfinished()) return
  if (autoCont.timer) clearTimeout(autoCont.timer)
  autoCont.timer = setTimeout(() => {
    autoCont.timer = null
    autoContinueNow()
  }, 1500)
}

/* ---------- context window / token usage ring ---------- */
const U = window.VibeUsage
let usage = U.emptyUsage()
let ctxLimits = new Map() // "provider/model" -> context window (tokens)
let ctxLimitsAt = 0
let ctxLimitsStale = false

async function loadCtxLimits() {
  if (!ctxLimitsStale && (ctxLimits.size || Date.now() - ctxLimitsAt < 30000)) return
  ctxLimitsStale = false
  ctxLimitsAt = Date.now()
  try {
    const res = await vibe.listModelLimits()
    if (res && res.ok) {
      ctxLimits = U.buildLimitMap(res.data)
      updateUsageRing()
    }
  } catch {}
}

function contextKeyForRing() {
  const row = (state.models || []).find((model) => `${model.providerID}/${model.id}` === state.selectedModel)
  const lastKey = usage.last && usage.last.modelKey
  if (row?.isGroup) {
    // A fallback group owns one picker entry, but the ring must show the
    // context window of the provider/model that actually answers: the last
    // reported model during a run, else the sticky cursor's target.
    if (lastKey && ctxLimits.has(lastKey)) return lastKey
    const models = Array.isArray(row.groupModels) ? row.groupModels : []
    const cursor = Math.min(Math.max(0, Number(row.groupCursor) || 0), Math.max(0, models.length - 1))
    const activeKey = row.activeModel || models[cursor]
    if (activeKey && ctxLimits.has(activeKey)) return activeKey
    // The group row itself carries the active model's limits from the backend.
    return state.selectedModel || null
  }
  return state.selectedModel || lastKey || null
}

function updateUsageRing() {
  const btn = $("btn-ctx")
  if (!btn) return
  const fmt = (n) => Math.round(n || 0).toLocaleString("en-US")
  // Fill is measured against the model that will answer next (the picker), else the last used one.
  const key = contextKeyForRing()
  const limit = key ? ctxLimits.get(key) || 0 : 0
  const used = U.contextUsed(usage)
  const ratio = limit ? used / limit : 0
  const pct = Math.round(ratio * 100)

  btn.classList.remove("ok", "warn", "crit", "unknown")
  btn.classList.add(limit ? U.level(ratio) : "unknown")
  const C = 2 * Math.PI * 9
  $("ctx-arc").style.strokeDasharray = `${Math.min(1, ratio) * C} ${C}`
  $("ctx-pct").textContent = limit ? `${pct}%` : used ? U.shortNum(used) : "–"
  btn.title = limit
    ? `Context: ${fmt(used)} / ${fmt(limit)} tokens (${pct}%)`
    : used
      ? `Context: ${fmt(used)} tokens (window size unknown for this model)`
      : "Context window usage"

  const t = (usage.last && usage.last.tokens) || {}
  const tot = U.totals(usage)
  $("ctx-used").textContent = used ? `${fmt(used)}${limit ? ` (${pct}%)` : ""}` : "–"
  $("ctx-limit").textContent = limit ? `${fmt(limit)} tokens` : "unknown"
  $("ctx-left").textContent = limit ? fmt(Math.max(0, limit - used)) : "–"
  $("ctx-in").textContent = fmt(t.input)
  $("ctx-out").textContent = fmt(t.output)
  $("ctx-rea").textContent = fmt(t.reasoning)
  $("ctx-cr").textContent = fmt(t.cache && t.cache.read)
  $("ctx-cw").textContent = fmt(t.cache && t.cache.write)
  $("ctx-steps").textContent = fmt(tot.steps)
  $("ctx-total").textContent = fmt(tot.all)
  $("ctx-cost").textContent = tot.unknownCost && !tot.cost ? "Unknown" : `${tot.estimated ? "≈ " : ""}$${tot.cost.toFixed(6)}${tot.unknownCost ? " + unknown" : ""}`
  $("ctx-cost").title = tot.unknownCost ? "Some requests have no reported cost or reliable pricing. This is not your provider account balance." : tot.estimated ? "Estimated USD cost from model pricing, not a provider account debit." : "USD request cost reported by the provider."

  // When auto-compaction will kick in for the picked model.
  const ceiling = limit ? U.autoCompactAt(limit) : 0
  const atEl = $("ctx-auto-at")
  if (atEl) {
    atEl.textContent =
      limit && Number.isFinite(ceiling)
        ? `${fmt(ceiling)} (${Math.round((ceiling / limit) * 100)}%)`
        : "–"
  }
  renderAutoCompact()
}

function setUsageFromMessages(msgs) {
  usage = U.usageFromMessages(msgs)
  updateUsageRing()
  loadCtxLimits()
  // A long session opened from the sidebar is compacted on the spot.
  maybeAutoCompact(800)
}

function resetUsage() {
  usage = U.emptyUsage()
  updateUsageRing()
}

/* ---------- automatic context compaction ----------
 * When the window nears full, OpenCode summarizes the conversation into a
 * checkpoint ("compaction") and continues from that summary. The core does this
 * on its own when it can measure the prompt, but this app also triggers it from
 * the measured usage ring and shows the checkpoint, so long sessions never send
 * an over-full request to the model (which is what makes it repeat itself). */
const AUTO_COMPACT_KEY = "vibecoder.autocompact"
const COMPACT_RETRY_MS = 60000
const COMPACT_TIMEOUT_MS = 180000

state.autoCompact = (() => {
  try {
    return localStorage.getItem(AUTO_COMPACT_KEY) !== "0"
  } catch {
    return true
  }
})()
state.compacting = false
state.compactTimer = null
state.compactWatch = null
state.compactCooldownUntil = 0
state.compactTrigger = null
state.compactionModel = null
let liveCompactEl = null

function applyCompactionSettings(value) {
  if (!value || typeof value !== "object") return
  state.autoCompact = value.auto !== false
  state.compactionModel = value.model ? String(value.model) : null
  try { localStorage.setItem(AUTO_COMPACT_KEY, state.autoCompact ? "1" : "0") } catch {}
  renderAutoCompact()
  renderCompactionModels()
}

async function loadCompactionSettings({ silent = false } = {}) {
  if (typeof vibe.getCompactionSettings !== "function") return
  try {
    const res = await vibe.getCompactionSettings()
    if (!res || res.ok === false) throw new Error(res?.error || "Could not read compaction settings")
    applyCompactionSettings(res.data?.compaction || res.data || {})
    hideError("compaction-settings")
  } catch (error) {
    if (!silent) showError("Could not load compaction settings", String(error?.message || error), { key: "compaction-settings" })
  }
}

async function saveCompactionSettings(patch) {
  if (typeof vibe.setCompactionSettings !== "function") return true
  const res = await vibe.setCompactionSettings(patch)
  if (!res || res.ok === false) throw new Error(res?.error || "Could not save compaction settings")
  applyCompactionSettings(res.data?.compaction || res.data || {})
  hideError("compaction-settings")
  return true
}

async function setAutoCompact(on) {
  const previous = state.autoCompact
  state.autoCompact = !!on
  try {
    localStorage.setItem(AUTO_COMPACT_KEY, on ? "1" : "0")
  } catch {}
  renderAutoCompact()
  try {
    await saveCompactionSettings({ auto: state.autoCompact })
    if (state.autoCompact) maybeAutoCompact(0)
  } catch (error) {
    state.autoCompact = previous
    renderAutoCompact()
    showError("Could not save auto-compaction", String(error?.message || error), { key: "compaction-settings" })
  }
}

function renderAutoCompact() {
  const stateEl = $("ctx-auto-state")
  if (stateEl) stateEl.textContent = state.autoCompact ? "On" : "Off"
  $("ctx-auto-toggle")?.classList.toggle("off", !state.autoCompact)
}

function renderCompactionModels() {
  const label = $("ctx-summary-model-current")
  if (!label) return
  label.textContent = state.selectedModel ? modelDisplayLabel(state.selectedModel) : "ChatComposer model"
}

function usageSnapshot() {
  const key = contextKeyForRing()
  const limit = key ? ctxLimits.get(key) || 0 : 0
  return { key, limit, used: U.contextUsed(usage) }
}

async function maybeAutoCompact(delay = 1200) {
  if (!state.autoCompact || state.compacting || state.running) return
  if (!state.activeSessionID) return
  if (Date.now() < state.compactCooldownUntil) return
  const scheduledFor = state.activeSessionID // pin: never compact a different session than the one measured
  await loadCtxLimits()
  if (state.activeSessionID !== scheduledFor) return
  const snap = usageSnapshot()
  if (!snap.limit || !snap.used || !U.shouldAutoCompact(snap.used, snap.limit)) return
  if (state.compactTimer) clearTimeout(state.compactTimer)
  state.compactTimer = setTimeout(() => {
    state.compactTimer = null
    const now = usageSnapshot()
    if (!state.compacting && !state.running && state.activeSessionID === scheduledFor && now.limit &&
        U.shouldAutoCompact(now.used, now.limit)) {
      compactNow({ reason: "auto", sessionID: scheduledFor })
    }
  }, Math.max(0, delay))
}

function updateRunBadge() {
  const b = $("run-badge")
  if (!b) return
  b.hidden = true
  b.textContent = ""
}

function compactionStatusEl() {
  if (liveCompactEl && liveCompactEl.isConnected) return liveCompactEl
  const el = document.createElement("div")
  el.className = "ctxd-card running"
  el.innerHTML = `
    <div class="ctxd-head">
      <span class="ctxd-ic">⌁</span>
      <span class="ctxd-title">Compacting context…</span>
      <span class="ctxd-meta"></span>
    </div>
    <div class="ctxd-sum"></div>`
  el.querySelector(".ctxd-head").onclick = () => el.classList.toggle("open")
  $("messages").appendChild(el)
  scrollChat()
  liveCompactEl = el
  return el
}

function showCompaction(status, opts = {}) {
  const el = compactionStatusEl()
  el.className = `ctxd-card ${status}`
  const title = el.querySelector(".ctxd-title")
  const meta = el.querySelector(".ctxd-meta")
  const sum = el.querySelector(".ctxd-sum")
  sum.hidden = true
  sum.classList.remove("waiting")
  el.classList.remove("open")
  if (status === "running") {
    title.textContent = opts.reason === "manual" ? "Compacting context…" : "Context almost full — compacting…"
    const model = opts.summaryModel || "current session model"
    meta.textContent = `${opts.reason || ""} · ${model}`
    sum.textContent = `Waiting for ${model} to write the checkpoint summary…`
    sum.classList.add("waiting")
    sum.hidden = false
    el.classList.add("open")
  } else if (status === "done" || status === "overbudget") {
    title.textContent = status === "overbudget" ? "Checkpoint created — still over context budget" : "Context compacted"
    const source = opts.summarySource ? ` · ${opts.summarySource === "fallback" ? "fallback summary" : "AI summary"}` : ""
    const model = opts.summaryModel && opts.summarySource !== "fallback" ? ` · ${opts.summaryModel}` : ""
    const tokens = Number.isFinite(opts.before) && Number.isFinite(opts.after) ? ` · ${opts.before.toLocaleString()} → ${opts.after.toLocaleString()} tokens` : ""
    meta.textContent = `${opts.reason || "manual"}${source}${model}${tokens}`
    const summary = String(opts.text || opts.summary || "").trim()
    const complete = [summary, opts.projectContext || "", status === "overbudget" ? `⚠ ${opts.error || "The next request is still estimated to exceed the input budget."}` : ""].filter(Boolean).join("\n\n")
    if (window.renderMarkdownInto) window.renderMarkdownInto(sum, complete)
    else sum.textContent = complete
    sum.hidden = !complete
    // Keep the newly generated checkpoint visible immediately; users can still
    // collapse it with the header if they prefer a compact transcript.
    if (complete) el.classList.add("open")
  } else {
    title.textContent = "Context compaction failed"
    meta.textContent = opts.reason || ""
    sum.textContent = String(opts.error || "unknown error")
    sum.hidden = false
    el.classList.add("open")
  }
  scrollChat()
}

function finishCompaction(status, opts = {}) {
  if (state.compactWatch) {
    clearTimeout(state.compactWatch)
    state.compactWatch = null
  }
  state.compacting = false
  if ((status === "done" || status === "overbudget") && Number(opts.after) > 0) {
    usage.last = { tokens: { input: Number(opts.after) }, modelKey: usage.last ? usage.last.modelKey : null }
    updateUsageRing()
  }
  updateRunBadge()
  showCompaction(status, opts)
  state.compactTrigger = null
  if (status === "failed" || status === "overbudget") {
    state.compactCooldownUntil = Date.now() + COMPACT_RETRY_MS
    // A failed/over-budget checkpoint is the final status for this turn. Keep
    // it directly after the latest activity instead of leaving it stranded
    // above actions rendered while the compaction request was in flight.
    const box = $("messages")
    if (box && liveCompactEl?.isConnected && box.lastElementChild !== liveCompactEl) {
      box.appendChild(liveCompactEl)
    }
  } else state.compactCooldownUntil = Date.now() + 15000
  if ((status === "done" || status === "overbudget") && state.activeSessionID) {
    // Never re-render while the next step is already streaming into the DOM —
    // the turn end handler re-renders the canonical timeline anyway.
    if (state.running) return
    // Canonical timeline: compaction checkpoints + fresh usage numbers.
    const sid = state.activeSessionID
    setTimeout(() => {
      if (state.activeSessionID === sid && !state.running) renderSessionHistory(sid)
    }, 250)
  }
}

function quietCompactionEnd() {
  if (state.compactWatch) {
    clearTimeout(state.compactWatch)
    state.compactWatch = null
  }
  state.compacting = false
  state.compactTrigger = null
  state.compactCooldownUntil = Date.now() + COMPACT_RETRY_MS
  if (liveCompactEl) liveCompactEl.remove()
  liveCompactEl = null
  updateRunBadge()
}

async function compactNow({ reason = "manual", sessionID: pinned = null } = {}) {
  const sessionID = pinned || state.activeSessionID
  if (!sessionID || state.compacting || sessionID !== state.activeSessionID) return false
  // True when the user moved to another session while this one was compacting.
  // The backend still finishes the right session; the UI just must not touch the new one.
  const switchedAway = () => state.activeSessionID !== sessionID
  state.compacting = true
  state.compactTrigger = reason
  state.compactCooldownUntil = 0
  updateRunBadge()
  showCompaction("running", { reason, summaryModel: state.selectedModel || "current session model" })
  if (state.compactWatch) clearTimeout(state.compactWatch)
  state.compactWatch = setTimeout(() => {
    if (!state.compacting || switchedAway()) return
    finishCompaction("failed", { reason, error: "No response from the compaction step (timed out)" })
  }, COMPACT_TIMEOUT_MS)
  try {
    const res = await vibe.compactSession({ sessionID, reason })
    if (switchedAway()) return !!(res && res.ok)
    if (!res || !res.ok) {
      const error = (res && res.error) || "unknown error"
      // Auto is a hint, not a command: a session with nothing to summarize is fine.
      if (reason === "auto" && /nothing to compact/i.test(error)) {
        quietCompactionEnd()
        return false
      }
      finishCompaction("failed", { reason, error })
      return false
    }
    return true
  } catch (e) {
    if (switchedAway()) return false
    if (reason === "auto" && /nothing to compact/i.test(String(e))) {
      quietCompactionEnd()
      return false
    }
    finishCompaction("failed", { reason, error: String(e) })
    return false
  }
}

function looksLikeContextOverflow(err) {
  const s = JSON.stringify(err ?? "").toLowerCase()
  return /context.{0,24}(overflow|length|window|limit)|maximum context|too many tokens|prompt is too long|token limit/.test(s)
}

function resetCompactionUi() {
  if (state.compactTimer) clearTimeout(state.compactTimer)
  if (state.compactWatch) clearTimeout(state.compactWatch)
  state.compactTimer = null
  state.compactWatch = null
  state.compacting = false
  state.compactCooldownUntil = 0
  liveCompactEl = null
  updateRunBadge()
}

/* ---------- helpers ---------- */
const relDay = (ts) => {
  if (!ts) return ""
  const ms = Date.now() - new Date(ts).getTime()
  const d = Math.floor(ms / 86400000)
  if (d <= 0) return "Today"
  if (d === 1) return "1d"
  return `${d}d`
}

function setMainEmpty(empty) {
  $("main").classList.toggle("empty", empty)
}

/* ---------- sidebar sessions ---------- */
/** The folder a session really belongs to (sessions of other workspaces are listed too). */
function sessionDir(s) {
  return s?.location?.directory ?? s?.directory ?? projectDir ?? undefined
}

function renderSessions() {
  const ul = $("session-list")
  ul.innerHTML = ""
  for (const s of state.sessions) {
    const li = document.createElement("li")
    if (s.id === state.activeSessionID) li.classList.add("active")
    li.innerHTML = `<span class="left"></span><span class="when"></span>`
    li.dataset.id = s.id
    li.querySelector(".left").textContent = s.title || s.id.slice(0, 8)
    li.querySelector(".left").title = sessionDir(s) ?? ""
    li.querySelector(".when").textContent = relDay(s.time?.updated ?? s.time?.created)

    const acts = document.createElement("span")
    acts.className = "ws-acts"
    const ren = document.createElement("button")
    ren.textContent = "✎"
    ren.title = "Rename session"
    ren.onclick = async (e) => {
      e.stopPropagation()
      // Electron has no prompt() -> the themed dialog with a text field
      const nn = await showPrompt({
        title: "Rename session",
        message: "New session name:",
        defaultValue: s.title || "",
        okText: "Save",
      })
      if (nn === null) return // cancelled
      const name = String(nn).replace(/\s+/g, " ").trim()
      if (!name) {
        showError("Could not rename the session", "The name cannot be empty.", { key: "sessions" })
        return
      }
      const r = await vibe.renameSession({ sessionID: s.id, title: name, directory: sessionDir(s) })
      if (r.ok) {
        s.title = r.data?.title || name
        hideError("sessions")
        // Re-read the list so the server's copy (and the order) is what we show.
        await refreshSessions()
      } else {
        showError("Could not rename the session", r.error || "Unknown error", { key: "sessions" })
      }
    }
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "✕"
    del.title = "Delete session"
    del.onclick = async (e) => {
      e.stopPropagation()
      const ok = await showConfirm(
        `Delete "${s.title || s.id.slice(0, 8)}"? This session will be permanently removed.`,
        "Delete session",
        "Delete",
      )
      if (!ok) return
      const r = await vibe.deleteSession({ sessionID: s.id, directory: sessionDir(s) })
      if (r.ok) {
        // Drop it from the list immediately, then confirm with the server.
        state.sessions = state.sessions.filter((x) => x.id !== s.id)
        renderSessions()
        if (state.activeSessionID === s.id) {
          state.activeSessionID = null
          $("messages").innerHTML = ""
          resetUsage()
          setMainEmpty(true)
        }
        hideError("sessions")
        await refreshSessions()
      } else {
        showError("Could not delete the session", r.error || "Unknown error", { key: "sessions" })
      }
    }
    acts.append(ren, del)
    li.appendChild(acts)

    li.onclick = () => openSession(s.id)
    ul.appendChild(li)
  }
  if (state.sessions.length > 4) $("show-more").hidden = false
}

/* Only the newest refresh may touch the list: two overlapping calls used to
 * race and the slower (older) answer wiped the fresh one — sessions "vanished"
 * until the next refresh. */
let sessionRefreshSeq = 0
let sessionRefreshTimer = null

/** Coalesce a burst of session events into one refresh. */
function scheduleSessionsRefresh() {
  if (sessionRefreshTimer) return
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null
    refreshSessions()
  }, 500)
}

async function refreshSessions() {
  const seq = ++sessionRefreshSeq
  const res = await vibe.listSessions({ all: !projectDir, directory: projectDir })
  if (seq !== sessionRefreshSeq) return
  if (res.ok) {
    hideError("sessions")
    const d = res.data
    const list = Array.isArray(d) ? d : (Array.isArray(d?.sessions) ? d.sessions : [])
    const stamp = (s) => Number(s.time?.updated ?? s.time?.created ?? 0)
    // Newest first (the server already sorts this way; sorting again keeps the
    // order right even if a backend returns oldest-first).
    state.sessions = [...list].sort((a, b) => stamp(b) - stamp(a))
    renderSessions()
  } else {
    // Keep the sessions we already have on screen — an empty list after a
    // single failed request looked like every session had disappeared.
    showError("Could not load sessions", res.error || "Unknown error", { key: "sessions" })
  }
}

/**
 * After the session list was refreshed for a workspace: keep the active session
 * only when it actually belongs to this workspace. The old behaviour kept it
 * alive across workspace switches, so the next message went to the PREVIOUS
 * project's session and every tool (write/bash/grep) worked in the wrong folder.
 */
function resetActiveSessionForWorkspace() {
  if (!state.activeSessionID || state.running) return
  if (state.sessions.some((s) => (s.id ?? s.sessionID) === state.activeSessionID)) return
  if (state.subagentView) leaveSubagentView(false)
  state.activeSessionID = null
  $("messages").innerHTML = ""
  resetCompactionUi()
  resetUsage()
  setMainEmpty(true)
}

async function newTask() {
  if (state.subagentView) leaveSubagentView(false)
  const res = await vibe.createSession({ directory: projectDir })
  if (!res.ok) return alert(res.error)
  const s = res.data?.data ?? res.data
  state.activeSessionID = s.id ?? s.sessionID
  $("messages").innerHTML = ""
  resetCompactionUi()
  resetUsage()
  setMainEmpty(false)
  hideBranchChip()
  await refreshSessions()
}

$("btn-new-task").onclick = newTask
$("show-more").onclick = () => ($("session-list").style.maxHeight = "none")

/* ---------- sidebar collapse (click the V mark) ---------- */
const SIDEBAR_HIDDEN_KEY = "vibe.sidebarHidden"

function sidebarIsHidden() {
  return !!document.querySelector(".shell")?.classList.contains("sidebar-hidden")
}

function applySidebarHidden(hidden, moveFocus = false) {
  const shell = document.querySelector(".shell")
  if (shell) shell.classList.toggle("sidebar-hidden", !!hidden)
  const sidebar = document.querySelector(".sidebar")
  if (sidebar) {
    sidebar.setAttribute("aria-hidden", hidden ? "true" : "false")
    sidebar.toggleAttribute("inert", !!hidden)
  }
  const restore = $("btn-sidebar-restore")
  if (restore) restore.hidden = !hidden
  const toggle = $("btn-sidebar-toggle")
  if (toggle) {
    toggle.setAttribute("aria-expanded", hidden ? "false" : "true")
    // One tooltip only: the styled data-tip (a native title would show a second one).
    toggle.dataset.tip = hidden ? "Show sidebar" : "Hide sidebar"
    toggle.setAttribute("aria-label", toggle.dataset.tip)
    toggle.removeAttribute("title")
  }
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0")
  } catch {
    // Storage can be unavailable; the toggle still works for this run.
  }
  if (moveFocus) requestAnimationFrame(() => (hidden ? restore : toggle)?.focus())
}

$("btn-sidebar-toggle")?.addEventListener("click", () => applySidebarHidden(!sidebarIsHidden(), true))
$("btn-sidebar-restore")?.addEventListener("click", () => applySidebarHidden(false, true))
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
    event.preventDefault()
    applySidebarHidden(!sidebarIsHidden(), true)
  }
})
try {
  if (localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1") applySidebarHidden(true)
} catch {
  // Ignore a blocked storage read.
}

