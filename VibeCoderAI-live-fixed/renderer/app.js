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
const errorState = { key: "", title: "", short: "", full: "", expanded: false }
function showError(title, detail, opts = {}) {
  const full = String(detail ?? "").trim()
  const heading = String(title || "Something went wrong").trim()
  // "Retry" only makes sense for a run we can actually resend.
  const retryBtn = $("error-retry")
  if (retryBtn) retryBtn.hidden = !(opts.retry && state.lastSend && !state.running)
  if (!full && !heading) return
  const key = opts.key || `${heading}\n${full}`
  if (errorState.key === key && errorState.full === full && !$("error-banner").hidden) return
  errorState.key = key
  errorState.title = heading
  errorState.full = full
  errorState.short = full.length > 1400 ? full.slice(0, 1400) + "…" : full
  errorState.expanded = false
  $("error-title").textContent = heading
  $("error-body").textContent = errorState.short
  $("error-details").hidden = full.length <= 1400
  $("error-details").textContent = "Show details"
  $("error-banner").hidden = false
  console.error(`[VibeCoder] ${heading}`, full)
  try { window.vibe?.logError?.({ title: heading, detail: full }) } catch {}
}
function hideError(key) {
  if (key && errorState.key !== key) return
  $("error-banner").hidden = true
  errorState.key = ""
  errorState.title = ""
  errorState.short = ""
  errorState.full = ""
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
const bgJob = { startedAt: 0, noteShown: false, timer: null }

/* every job that is currently running: the agent run + the open tool calls +
   the background shells ({ kind, title, at, shellId?, backgrounded?, file? }) */
const runningJobs = new Map()

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
function bgJobActive() {
  if (runningJobs.size) return true
  return !!(state.running && bgJob.startedAt)
}

/** The panel that lists the running jobs. */
function renderBgJobPanel() {
  const list = $("bg-job-list")
  if (!list) return
  list.textContent = ""
  const now = Date.now()
  const jobs = [...runningJobs.entries()]
  if (!jobs.length) {
    const empty = document.createElement("div")
    empty.className = "bg-job-item"
    empty.textContent = "No running job right now."
    list.appendChild(empty)
    return
  }
  for (const [key, job] of jobs) {
    const row = document.createElement("div")
    row.className = "bg-job-item"
    const kind = document.createElement("span")
    kind.className = "bji-kind"
    kind.textContent = job.kind || "Job"
    const body = document.createElement("div")
    body.className = "bji-body"
    const title = document.createElement("div")
    title.className = "bji-title"
    title.textContent = job.title || key
    title.title = job.title || key
    const time = document.createElement("div")
    time.className = "bji-time"
    const bits = [jobElapsed(job.at || now)]
    if (job.shellId && job.backgrounded) bits.push("background")
    time.textContent = bits.join(" · ")
    body.append(title, time)
    const acts = document.createElement("div")
    acts.className = "bji-acts"
    // OpenCode's Ctrl+B: a blocking shell can be sent to the background while it
    // keeps running - only shells that still block the agent offer it.
    if (job.shellId && !job.backgrounded) {
      const mv = document.createElement("button")
      mv.className = "bg-job-move"
      mv.type = "button"
      mv.textContent = "Background"
      mv.title = "Move this command to the background (Ctrl+B) - it keeps running"
      mv.onclick = () => moveRunningJobToBackground(job.shellId)
      acts.appendChild(mv)
    }
    const stop = document.createElement("button")
    stop.className = "bg-job-stop"
    stop.type = "button"
    stop.textContent = "Stop"
    stop.title = job.shellId ? "Stop this command (the agent keeps running)" : "Stop this job (it stops the agent run)"
    stop.onclick = () => stopRunningJob(key)
    acts.appendChild(stop)
    row.append(kind, body, acts)
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
  const jobs = [...runningJobs.values()]
  const agentRun = jobs.some((j) => j.kind === "Agent")
  const shells = jobs.filter((j) => j.shellId)
  let label = "Running"
  if (!agentRun && shells.length) label = shells.length > 1 ? `Background · ${shells.length}` : "Background"
  else if (jobs.length > 1) label = `Running · ${jobs.length}`
  $("bg-job-text").textContent = label
  if (!$("bg-job-panel").hidden) renderBgJobPanel()
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
$("bg-job-stop")?.addEventListener("click", (e) => {
  e.stopPropagation()
  stopAllJobs()
})
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
async function refreshShellJobs() {
  if (!state.activeSessionID || typeof vibe.listShells !== "function") return
  try {
    const res = await vibe.listShells({ sessionID: state.activeSessionID })
    if (!res || !res.ok) return
    for (const sh of Array.isArray(res.data) ? res.data : []) {
      if (sh.status !== "running") continue
      const key = `shell:${sh.id}`
      const prev = runningJobs.get(key) || {}
      runningJobs.set(key, {
        kind: "Shell",
        title: String(sh.command || "shell"),
        at: sh.started || prev.at || Date.now(),
        shellId: sh.id,
        backgrounded: !!sh.backgrounded,
        ...prev,
      })
    }
    renderBgJob()
  } catch {}
}

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

function updateUsageRing() {
  const btn = $("btn-ctx")
  if (!btn) return
  const fmt = (n) => Math.round(n || 0).toLocaleString("en-US")
  // Fill is measured against the model that will answer next (the picker), else the last used one.
  const key = state.selectedModel || (usage.last && usage.last.modelKey) || null
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
  $("ctx-cost").textContent = tot.cost ? `$${tot.cost.toFixed(tot.cost < 1 ? 4 : 2)}` : "$0.00"

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
  const key = state.selectedModel || (usage.last && usage.last.modelKey) || null
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
  if (state.running) {
    b.hidden = false
    const pulse = state.pulse
    b.textContent = pulse?.step ? `● Step ${pulse.step}${pulse.tools ? ` · ${pulse.tools} actions` : ""}` : "● Running"
  } else if (state.compacting) {
    b.hidden = false
    b.textContent = "● Compacting"
  } else {
    b.hidden = true
    b.textContent = "● Running"
  }
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
    if (window.renderMarkdown) sum.innerHTML = window.renderMarkdown(complete)
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
        message: "Session er notun naam:",
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
        `"${s.title || s.id.slice(0, 8)}" delete korbe? Ei session ar thakbe na.`,
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

/* ---------- chat ---------- */
/* Stick to the bottom while streaming, but let the user scroll up freely.
   The floating arrow appears whenever the user is away from the newest chat,
   including after a run has finished. */
function nearBottom(slack = 90) {
  const el = $("messages")
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

function scrollChat(force = false) {
  const el = $("messages")
  if (force || nearBottom()) el.scrollTop = el.scrollHeight
  requestAnimationFrame(updateJumpButton)
}

function updateJumpButton() {
  const btn = $("jump-live")
  if (!btn) return
  const away = !nearBottom()
  btn.hidden = !away
  const label = btn.querySelector(".jump-label")
  if (label) label.textContent = state.running ? "Agent working" : "Jump to latest"
}

$("messages").addEventListener("scroll", updateJumpButton, { passive: true })
if ($("jump-live")) {
  $("jump-live").onclick = () => {
    scrollChat(true)
    updateJumpButton()
  }
}

function addMsg(role, text, cls = "", images = []) {
  const el = document.createElement("div")
  el.className = `msg ${role}`
  el.innerHTML = `<span class="who"></span><div class="bubble ${cls}"></div>`
  el.querySelector(".who").textContent = role === "user" ? "You" : "VibeCoder"
  const bubble = el.querySelector(".bubble")
  if (role === "assistant" && cls !== "thinking") {
    // Render markdown for assistant messages (not for "Thinking..." placeholder)
    bubble.innerHTML = window.renderMarkdown(text)
  } else {
    bubble.textContent = text
  }
  if (Array.isArray(images) && images.length) {
    const box = document.createElement("div")
    box.className = "msg-imgs"
    for (const src of images) {
      if (!src) continue
      const img = document.createElement("img")
      img.src = src
      img.alt = "attachment"
      img.loading = "lazy"
      box.appendChild(img)
    }
    if (box.children.length) bubble.appendChild(box)
  }
  $("messages").appendChild(el)
  scrollChat()
  return bubble
}

/** Pull image data URLs out of a stored user message (v2 media/file parts). */
function userMessageImages(m) {
  const parts = Array.isArray(m?.content) ? m.content : []
  const out = []
  for (const p of parts) {
    if (!p || typeof p !== "object") continue
    if (!["media", "file", "image"].includes(p.type)) continue
    const mime = p.mime || p.mediaType || p.media?.source?.mediaType || ""
    if (!String(mime).startsWith("image/")) continue
    let url = p.url || p.dataUrl || p.src
    if (!url && p.media?.source?.type === "base64" && p.media.source.data) {
      url = `data:${mime};base64,${p.media.source.data}`
    }
    if (!url && typeof p.data === "string") url = `data:${mime};base64,${p.data}`
    if (url) out.push(url)
  }
  return out
}

/* ---------- opencode-style assistant turn rendering ---------- */
function countDiff(patch) {
  let add = 0
  let del = 0
  for (const line of String(patch || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

function toolFiles(state, input = {}) {
  const files = state?.metadata?.files
  if (Array.isArray(files) && files.length) return files
  const md = state?.metadata
  if (md && typeof md === "object") {
    const out = []
    for (const [k, v] of Object.entries(md)) {
      if (v && typeof v === "object" && (v.patch || v.additions !== undefined)) {
        out.push({ file: k, patch: v.patch, additions: v.additions, deletions: v.deletions, hunks: v.hunks, oldLines: v.oldLines, newLines: v.newLines })
      }
    }
    if (out.length) return out
  }
  const p = input.path ?? input.filePath
  if (p) return [{
    file: p,
    patch: state?.metadata?.patch ?? input.patch,
    additions: state?.metadata?.additions,
    deletions: state?.metadata?.deletions,
    hunks: state?.metadata?.hunks,
    oldLines: state?.metadata?.oldLines,
    newLines: state?.metadata?.newLines,
  }]
  return []
}

const FILE_BADGES = {
  css: { t: "#", c: "var(--code-purple)" },
  scss: { t: "#", c: "var(--code-pink)" },
  less: { t: "#", c: "var(--code-purple)" },
  js: { t: "JS", c: "var(--code-yellow)" },
  mjs: { t: "JS", c: "var(--code-yellow)" },
  cjs: { t: "JS", c: "var(--code-yellow)" },
  jsx: { t: "JS", c: "var(--code-cyan)" },
  ts: { t: "TS", c: "var(--code-blue)" },
  tsx: { t: "TS", c: "var(--code-blue)" },
  html: { t: "<>", c: "var(--code-orange)" },
  htm: { t: "<>", c: "var(--code-orange)" },
  json: { t: "{}", c: "var(--code-yellow)" },
  md: { t: "M", c: "var(--code-steel)" },
  py: { t: "Py", c: "var(--code-navy)" },
  c: { t: "C", c: "var(--code-blue)" },
  cc: { t: "C++", c: "var(--code-blue)" },
  cpp: { t: "C++", c: "var(--code-blue)" },
  h: { t: "H", c: "var(--code-purple)" },
  hpp: { t: "H++", c: "var(--code-purple)" },
  java: { t: "J", c: "var(--code-orange)" },
  go: { t: "Go", c: "var(--code-cyan)" },
  rs: { t: "Rs", c: "var(--code-orange)" },
  bat: { t: "B", c: "var(--code-green)" },
  cmd: { t: "B", c: "var(--code-green)" },
  sh: { t: "$", c: "var(--code-green)" },
  yml: { t: "Y", c: "var(--code-red)" },
  yaml: { t: "Y", c: "var(--code-red)" },
  txt: { t: "T", c: "var(--code-gray)" },
}

const CODE_KEYWORDS = /^(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|namespace|new|null|private|protected|public|return|static|struct|switch|template|this|throw|true|try|type|typedef|typeof|undefined|using|var|virtual|void|while|yield)$/
const CODE_TOKEN = /(\/\/.*$|#\s*(?:include|define|if|ifdef|ifndef|endif|pragma|using)\b.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|namespace|new|null|private|protected|public|return|static|struct|switch|template|this|throw|true|try|type|typedef|typeof|undefined|using|var|virtual|void|while|yield)\b|\b\d+(?:\.\d+)?\b)/g

function renderCodeText(node, value) {
  const text = String(value ?? "")
  let at = 0
  CODE_TOKEN.lastIndex = 0
  let match
  while ((match = CODE_TOKEN.exec(text))) {
    if (match.index > at) node.appendChild(document.createTextNode(text.slice(at, match.index)))
    const token = document.createElement("span")
    const raw = match[0]
    token.className = raw.startsWith("//") ? "tok-comment"
      : raw.startsWith("#") ? "tok-pre"
        : /^["'`]/.test(raw) ? "tok-string"
          : /^\d/.test(raw) ? "tok-number"
            : CODE_KEYWORDS.test(raw) ? "tok-keyword" : ""
    token.textContent = raw
    node.appendChild(token)
    at = match.index + raw.length
  }
  if (at < text.length) node.appendChild(document.createTextNode(text.slice(at)))
  if (!text) node.appendChild(document.createTextNode(" "))
}

function fileBadge(file) {
  const name = String(file || "")
  const ext = name.split(".").pop().toLowerCase()
  const b = FILE_BADGES[ext] || { t: (ext || "?").slice(0, 2).toUpperCase(), c: "var(--code-gray)" }
  return b
}

function appendDiffLine(container, line = {}) {
  const type = line.type === "add" || line.type === "del" || line.type === "meta" ? line.type : "context"
  const row = document.createElement("div")
  row.className = `dl ${type === "context" ? "" : type}`.trim()
  const oldNo = document.createElement("span")
  oldNo.className = "dl-no old"
  oldNo.textContent = line.oldLine == null ? "" : String(line.oldLine)
  const newNo = document.createElement("span")
  newNo.className = "dl-no new"
  newNo.textContent = line.newLine == null ? "" : String(line.newLine)
  const mark = document.createElement("span")
  mark.className = "dl-mark"
  mark.textContent = type === "add" ? "+" : type === "del" ? "−" : type === "meta" ? "…" : ""
  const code = document.createElement("span")
  code.className = "dl-code"
  if (type === "meta") code.textContent = String(line.text ?? "") || " "
  else renderCodeText(code, line.text)
  row.append(oldNo, newNo, mark, code)
  container.appendChild(row)
}

function appendReadCode(container, output) {
  for (const raw of String(output || "").split(/\r?\n/).slice(0, 2000)) {
    const match = /^(\d+)\t(.*)$/.exec(raw)
    const row = document.createElement("div")
    row.className = match ? "code-row" : "code-row meta"
    const number = document.createElement("span")
    number.className = "code-no"
    number.textContent = match ? match[1] : ""
    const code = document.createElement("span")
    code.className = "code-text"
    if (match) renderCodeText(code, match[2])
    else code.textContent = raw || " "
    row.append(number, code)
    container.appendChild(row)
  }
}

function appendStructuredDiff(container, file) {
  const hunks = Array.isArray(file.hunks) ? file.hunks : []
  let previousOldEnd = 0
  for (const hunk of hunks) {
    const oldStart = Number(hunk.oldStart) || 1
    const omitted = Math.max(0, oldStart - previousOldEnd - 1)
    if (omitted) appendDiffLine(container, { type: "meta", text: `${omitted} unchanged line${omitted === 1 ? "" : "s"}` })
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) appendDiffLine(container, line)
    previousOldEnd = Math.max(previousOldEnd, oldStart + Math.max(0, Number(hunk.oldCount) || 0) - 1)
  }
  const trailing = Math.max(0, (Number(file.oldLines) || 0) - previousOldEnd)
  if (trailing) appendDiffLine(container, { type: "meta", text: `${trailing} unchanged line${trailing === 1 ? "" : "s"}` })
}

function fileRowEl(f, input = {}, toolName = "") {
  const full = f.file ?? input.filePath ?? input.path ?? ""
  const stats = countDiff(f.patch)
  const add = f.additions ?? stats.add
  const del = f.deletions ?? stats.del
  const badge = fileBadge(full)

  const row = document.createElement("div")
  row.className = "file-row"
  row.innerHTML = `
    <span class="fr-kind"></span>
    <span class="fr-ic"></span>
    <span class="fr-name"></span>
    <span class="fr-stats">
      <span class="fr-add"></span>
      <span class="fr-del"></span>
    </span>
    <span class="fr-expand">⇅</span>
    <div class="fr-diff"></div>`

  // Spell the action out: "Edit src/app.js", "Write ...".
  row.querySelector(".fr-kind").textContent = toolRowLabel(toolName) || "Edit"
  const ic = row.querySelector(".fr-ic")
  ic.textContent = badge.t
  ic.style.color = badge.c
  ic.style.borderColor = `color-mix(in srgb, ${badge.c} 34%, transparent)`
  row.querySelector(".fr-name").textContent = relPath(full)
  row.querySelector(".fr-add").textContent = `+${add}`
  row.querySelector(".fr-del").textContent = `-${del}`

  const pre = row.querySelector(".fr-diff")
  const patch = String(f.patch ?? "")
  if (Array.isArray(f.hunks) && f.hunks.length) {
    appendStructuredDiff(pre, f)
  } else if (patch) {
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith("@@")) appendDiffLine(pre, { type: "meta", text: line })
      else if (line.startsWith("+") && !line.startsWith("+++")) appendDiffLine(pre, { type: "add", text: line.slice(1) })
      else if (line.startsWith("-") && !line.startsWith("---")) appendDiffLine(pre, { type: "del", text: line.slice(1) })
      else appendDiffLine(pre, { type: "context", text: line.startsWith(" ") ? line.slice(1) : line })
    }
  } else {
    row.querySelector(".fr-expand").hidden = true
    pre.remove()
  }

  row.onclick = () => {
    if (!row.querySelector(".fr-diff")) return
    row.classList.toggle("open")
  }
  return row
}

/* card row for read / list / grep / shell / webfetch */
const TOOL_CARD_META = {
  read: null,
  list: { t: "📁", c: "var(--code-gray)" },
  glob: { t: "📁", c: "var(--code-gray)" },
  grep: { t: "⌕", c: "var(--code-gray)" },
  shell: { t: "$", c: "var(--code-green)" },
  bash: { t: "$", c: "var(--code-green)" },
  webfetch: { t: "↗", c: "var(--code-steel)" },
  websearch: { t: "↗", c: "var(--code-steel)" },
}

function toolCardEl(name, input = {}, output = "") {
  const meta = TOOL_CARD_META[name] ?? { t: "•", c: "var(--code-gray)" }
  const badge = name === "read" ? fileBadge(input.path ?? input.filePath ?? "") : meta
  const title =
    name === "shell" || name === "bash"
      ? input.command ?? "shell"
      : name === "grep"
        ? `${input.pattern ?? ""}${input.path ? "  " + relPath(input.path) : ""}`.trim()
        : name === "webfetch" || name === "websearch"
          ? input.url ?? input.query ?? ""
          : relPath(input.path ?? input.filePath ?? "") || name

  const row = document.createElement("div")
  row.className = "file-row" + (output ? "" : " no-expand")
  row.innerHTML = `
    <span class="fr-kind"></span>
    <span class="fr-ic"></span>
    <span class="fr-name"></span>
    <span class="fr-stats"></span>
    <span class="fr-expand">⇅</span>
    <div class="fr-diff"></div>`
  // Spell the action out: "Read src/app.js", "Search foo", "Shell npm test".
  row.querySelector(".fr-kind").textContent = toolRowLabel(name)
  const ic = row.querySelector(".fr-ic")
  ic.textContent = badge.t
  ic.style.color = badge.c
  ic.style.borderColor = `color-mix(in srgb, ${badge.c} 34%, transparent)`
  row.querySelector(".fr-name").textContent = title
  row.querySelector(".fr-name").title = title
  row.querySelector(".fr-stats").remove()

  const pre = row.querySelector(".fr-diff")
  if (output) {
    if (name === "read") appendReadCode(pre, output)
    else for (const line of output.split(/\r?\n/).slice(0, 400)) appendDiffLine(pre, { type: "context", text: line })
  } else {
    row.querySelector(".fr-expand").hidden = true
    pre.remove()
  }
  row.onclick = () => {
    if (!row.querySelector(".fr-diff")) return
    row.classList.toggle("open")
  }
  return row
}

function subagentMeta(state = {}, input = {}, toolCallId = "") {
  const md = state?.metadata && typeof state.metadata === "object" ? state.metadata : {}
  const output = (Array.isArray(state?.content) ? state.content : []).filter((item) => item?.type === "text").map((item) => item.text || "").join("\n")
  const legacyId = /\b(?:id|sessionID):\s*(subagent_[0-9a-f]+)\b/i.exec(output)?.[1] || ""
  const knownByCall = toolCallId && typeof subAgentsById !== "undefined"
    ? [...subAgentsById.values()].find((agent) => agent.parentToolCallId === toolCallId)
    : null
  const subagentId = md.subagentId || legacyId || knownByCall?.id || ""
  const known = (subagentId && typeof subAgentsById !== "undefined" ? subAgentsById.get(subagentId) : null) || knownByCall
  return {
    id: subagentId,
    sessionID: known?.childSessionId || md.subagentSessionId || "",
    name: known?.name || md.subagentName || input.name || input.agent || input.type || "Subagent",
    type: known?.type || md.subagentType || input.agent || input.type || "general",
    task: known?.task || md.subagentTask || input.task || "",
    status: known?.status || md.subagentStatus || (state.status === "error" ? "error" : "running"),
    result: known?.result || md.subagentResult || "",
    error: known?.error || md.subagentError || "",
  }
}

function syncSubagentCard(el, info) {
  if (!el || !info) return
  el.classList.add("subagent-tool")
  if (info.id) el.dataset.subagentId = info.id
  el.dataset.subagentStatus = info.status || "running"
  el.classList.remove("running", "done", "failed")
  const status = info.status || "running"
  el.classList.add(status === "done" ? "done" : status === "error" ? "failed" : "running")
  el.querySelector(".act-title").textContent = info.name || "Subagent"
  el.querySelector(".act-sub").textContent = `${info.type || "general"}${info.task ? ` · ${info.task}` : ""}`
  const stateEl = el.querySelector(".act-state")
  stateEl.textContent = status === "done" ? "✓" : status === "error" ? "✕" : "●"
  const body = el.querySelector(".act-body")
  body.textContent = info.result || info.error || info.task || "Open to watch progress"
  body.hidden = false
  const group = el.closest(".used-group")
  if (group) {
    const labels = [...group.querySelectorAll(".used-list .act-title")].map((node) => node.textContent).filter(Boolean)
    if (labels.length) group.querySelector(".used-names").textContent = labels.join(", ")
  }
  el.querySelector(".act-head").onclick = (event) => {
    event.stopPropagation()
    if (info.id) openSubagentView(info.id)
  }
}

function renderToolDetails(el, name, input = {}, state = {}, toolCallId = "") {
  // subtitle (file path / command)
  const sub = toolSubtitle(name, input)
  const durationMs = Number(state?.metadata?.durationMs)
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? (durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`) : ""
  if (sub || duration) el.querySelector(".act-sub").textContent = [sub, duration].filter(Boolean).join(" · ")

  const files = toolFiles(state, input)
  const body = el.querySelector(".act-body")
  const out = el.querySelector(".act-out")

  if (name === "subagent" || name === "task") {
    syncSubagentCard(el, subagentMeta(state, input, toolCallId))
    return
  }

  el.querySelectorAll(".file-rows").forEach((n) => n.remove())

  if (files.length && (name === "edit" || name === "write" || name === "patch" || state?.metadata?.files)) {
    // File edits render as standalone cards (like the real app): the tool name
    // is already shown by the "Used N ..." group header.
    el.classList.add("file-tool")
    const wrap = document.createElement("div")
    wrap.className = "file-rows"
    for (const f of files) wrap.appendChild(fileRowEl(f, input, name))
    el.appendChild(wrap)
    return
  }

  const toolContent = Array.isArray(state.content) ? state.content : []
  const output = toolContent
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")

  // Browser screenshots are real image artifacts, not a byte-count placeholder.
  // Rebuild the image section each time a live tool result or history is rendered.
  el.querySelectorAll(".act-screenshots").forEach((node) => node.remove())
  const screenshots = toolContent.filter((item) => item?.type === "image" && item.dataUrl)
  if (screenshots.length) {
    const wrap = document.createElement("div")
    wrap.className = "act-screenshots"
    for (const shot of screenshots.slice(0, 2)) {
      const figure = document.createElement("figure")
      figure.className = "act-screenshot"
      const img = document.createElement("img")
      img.src = shot.dataUrl
      img.alt = `Browser screenshot${shot.title ? `: ${shot.title}` : ""}`
      img.loading = "lazy"
      img.decoding = "async"
      img.addEventListener("click", () => {
        const viewer = document.createElement("div")
        viewer.className = "browser-shot-viewer"
        viewer.setAttribute("role", "dialog")
        viewer.setAttribute("aria-label", "Browser screenshot preview")
        const close = document.createElement("button")
        close.type = "button"
        close.className = "browser-shot-close"
        close.textContent = "Close"
        const large = document.createElement("img")
        large.src = shot.dataUrl
        large.alt = img.alt
        close.onclick = () => viewer.remove()
        viewer.addEventListener("click", (event) => { if (event.target === viewer) viewer.remove() })
        viewer.append(close, large)
        document.body.appendChild(viewer)
      })
      figure.appendChild(img)
      const captionText = [shot.title, shot.url].filter(Boolean).join(" · ")
      if (captionText) {
        const caption = document.createElement("figcaption")
        caption.textContent = captionText
        figure.appendChild(caption)
      }
      wrap.appendChild(figure)
    }
    el.appendChild(wrap)
    el.classList.add("open")
  }

  if (name in TOOL_CARD_META) {
    el.classList.add("file-tool")
    const wrap = document.createElement("div")
    wrap.className = "file-rows"
    wrap.appendChild(toolCardEl(name, input, output))
    el.appendChild(wrap)
    return
  }

  el.classList.remove("file-tool")
  if (output) out.textContent = output.slice(0, 4000)
  else if (!body.textContent && Object.keys(input).length) {
    body.textContent = JSON.stringify(input, null, 2).slice(0, 1500)
  }
}

/* ---------- thought rows (opencode style "Thought 4s") ---------- */
function addThought(text = "", dur = 0, open = false) {
  const el = document.createElement("div")
  el.className = "thought" + (open ? " open" : "")
  el.innerHTML = `
    <div class="thought-head">
      <span class="th-label">Thinking</span>
      <span class="th-dur"></span>
      <span class="th-chev">▸</span>
    </div>
    <div class="th-body"></div>`
  if (dur) el.querySelector(".th-dur").textContent = `${dur}s`
  el.querySelector(".th-body").textContent = text
  el.querySelector(".thought-head").onclick = () => el.classList.toggle("open")
  $("messages").appendChild(el)
  scrollChat()
  return el
}

function toolRow(part) {
  const st = part.state ?? {}
  const key = `hist:${part.id}`
  const input = st.input ?? {}
  const name = part.name || "tool"
  const el = toolAct(key, name, input)
  renderToolDetails(el, name, input, st, part.id)
  if (st.status === "error" || st.status === "failed") actDone(key, false)
  else if (st.status === "completed" || st.status === "success") actDone(key, true)
  else el.classList.add("running")
  if (name === "subagent" || name === "task") syncSubagentCard(el, subagentMeta(st, input, part.id))
  return el
}

/* group consecutive tools like opencode: "Used 2 Write, Shell ▾" */
function toolGroupEl(tools) {
  const wrap = document.createElement("div")
  wrap.className = "used-group"
  const names = tools.map((t) => {
    if (t.part.name === "subagent" || t.part.name === "task") return subagentMeta(t.part.state, t.part.state?.input, t.part.id).name
    return toolRowLabel(t.part.name)
  })
  const head = document.createElement("div")
  head.className = "used-head"
  head.innerHTML = `<span class="used-n"></span><span class="used-names"></span><span class="used-chev">▾</span>`
  head.querySelector(".used-n").textContent = `Used ${tools.length}`
  head.querySelector(".used-names").textContent = names.join(", ")
  const list = document.createElement("div")
  list.className = "used-list"
  for (const t of tools) list.appendChild(t.el)
  head.onclick = () => wrap.classList.toggle("collapsed")
  wrap.append(head, list)
  return wrap
}

function renderAssistantMessage(m) {
  const parts = m.content ?? []
  const created = m.time?.created ?? 0
  let pending = []
  const seenTexts = new Set()
  const flush = () => {
    if (!pending.length) return
    $("messages").appendChild(toolGroupEl(pending))
    pending = []
  }
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      // Some providers replay the last text part after a retry. The replay is NOT
      // always adjacent: the pattern is text -> tool -> text -> tool -> text.
      // A "consecutive only" check therefore let the same sentence through 3
      // times. Use a set of the texts already shown in THIS message instead, so
      // the same sentence is rendered exactly once no matter where it appears.
      const t = String(part.text).trim()
      if (t.length >= 24) {
        if (seenTexts.has(t)) continue
        seenTexts.add(t)
      }
      flush()
      addMsg("assistant", part.text)
    } else if (part.type === "reasoning" && part.text) {
      flush()
      const span = part.time?.completed && part.time?.created
        ? part.time.completed - part.time.created
        : (m.time?.completed && m.time?.created ? m.time.completed - m.time.created : 0)
      const dur = span > 0 ? Math.max(1, Math.round(span / 1000)) : 0
      addThought(part.text, dur)
    } else if (part.type === "tool" && part.name === "question") {
      // Answered questions get a compact recap instead of a raw tool row.
      flush()
      const q = questionHistoryEl(part)
      if (q) $("messages").appendChild(q)
    } else if (part.type === "tool") {
      const el = toolRow(part)
      pending.push({ part, el })
    }
  }
  flush()
}

function compactionHistoryEl(m) {
  const el = document.createElement("div")
  el.className = "ctxd-card done history"
  const head = document.createElement("div")
  head.className = "ctxd-head"
  head.innerHTML = `<span class="ctxd-ic">⌁</span><span class="ctxd-title">Context checkpoint</span><span class="ctxd-meta"></span>`
  const reason = m.reason || "checkpoint"
  const source = m.summarySource === "fallback" ? "fallback summary" : "AI summary"
  const model = m.summaryModel && m.summarySource !== "fallback" ? ` · ${m.summaryModel}` : ""
  head.querySelector(".ctxd-meta").textContent = `${reason} · ${source}${model}`
  const sum = document.createElement("div")
  sum.className = "ctxd-sum"
  const complete = [String(m.summary || "").trim(), String(m.projectContext || "").trim()].filter(Boolean).join("\n\n")
  if (window.renderMarkdown) sum.innerHTML = window.renderMarkdown(complete)
  else sum.textContent = complete
  sum.hidden = !complete
  head.onclick = () => el.classList.toggle("open")
  el.append(head, sum)
  if (complete) el.classList.add("open")
  return el
}

function renderHistoryMessages(msgs, { editable = true, usageRing = true, retryRow = true, assistantName = "VibeCoder" } = {}) {
  if (usageRing) setUsageFromMessages(msgs)
  $("messages").innerHTML = ""
  liveCompactEl = null
  clearActs()
  permEls.clear()
  for (const m of msgs) {
    if (m.type === "user") {
      const text = m.metadata?.displayText ?? m.content?.text ?? m.text ?? ""
      const images = userMessageImages(m)
      if (text || images.length) {
        const bubble = addMsg("user", text, "", images)
        if (editable) attachUserActions(bubble, text, m.id)
        else bubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode("Task"))
      }
    } else if (m.type === "assistant") {
      renderAssistantMessage(m)
    } else if (m.type === "compaction") {
      // A compaction checkpoint: the conversation above it was summarized.
      if (m.status === "completed") $("messages").appendChild(compactionHistoryEl(m))
    } else if (m.type === "shell") {
      const key = `hist-shell:${m.id}`
      const el = addAct(key, "⌘", "Shell", "tool", m.command || "")
      el.querySelector(".act-body").textContent = m.cwd || ""
      actDone(key, m.status === "exited")
    }
  }
  if (assistantName !== "VibeCoder") {
    $("messages").querySelectorAll(".msg.assistant .who").forEach((node) => { node.textContent = assistantName })
  }
  scrollChat(true)
  if (retryRow) restoreRetryRow()
  if (usageRing) renderAutoCompact()
}

async function renderSessionHistory(sessionID) {
  const res = await vibe.getMessages({ sessionID, limit: 200 })
  if (!res.ok) return
  if (sessionID !== state.activeSessionID || state.subagentView) return // user switched while loading
  const msgs = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  renderHistoryMessages(msgs)
}

/* ---------- edit & resend a sent user message ---------- */
function attachUserActions(bubble, text, messageID) {
  const msg = bubble?.closest(".msg")
  if (!msg) return bubble
  msg.dataset.text = text || ""
  msg.dataset.msgId = messageID || ""
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "msg-edit"
  btn.title = "Edit and resend"
  btn.setAttribute("aria-label", "Edit and resend")
  btn.textContent = "✎"
  btn.onclick = (e) => {
    e.stopPropagation()
    beginEditMessage(msg)
  }
  msg.appendChild(btn)
  return bubble
}

function beginEditMessage(msg) {
  if (msg.querySelector(".msg-edit-box")) return
  const bubble = msg.querySelector(".bubble")
  if (!bubble) return
  const original = msg.dataset.text || bubble.textContent || ""

  const box = document.createElement("div")
  box.className = "msg-edit-box"
  const ta = document.createElement("textarea")
  ta.className = "msg-edit-input"
  ta.value = original
  ta.rows = Math.min(8, Math.max(2, original.split("\n").length + 1))

  const row = document.createElement("div")
  row.className = "msg-edit-actions"
  const save = document.createElement("button")
  save.type = "button"
  save.className = "save-btn"
  save.textContent = "Save & resend"
  const cancel = document.createElement("button")
  cancel.type = "button"
  cancel.className = "save-btn ghost"
  cancel.textContent = "Cancel"

  const close = () => {
    box.remove()
    bubble.hidden = false
    msg.querySelector(".msg-edit")?.removeAttribute("hidden")
  }
  cancel.onclick = close
  save.onclick = async () => {
    const next = ta.value.trim()
    if (!next) return
    save.disabled = true
    cancel.disabled = true
    save.textContent = "Resending…"
    const ok = await editAndResend(msg, next)
    if (!ok) {
      save.disabled = false
      cancel.disabled = false
      save.textContent = "Save & resend"
      close()
    }
  }

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close()
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.onclick()
  })

  row.append(save, cancel)
  box.append(ta, row)
  bubble.hidden = true
  msg.querySelector(".msg-edit")?.setAttribute("hidden", "")
  msg.appendChild(box)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
}

/**
 * Find the server message id for a rendered user bubble (history or live).
 */
async function bindLiveMessageId(msgEl, text) {
  if (!msgEl) return
  const wanted = String(text || "").trim()
  if (!wanted) return
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!msgEl.isConnected) return
    try {
      const sid = state.activeSessionID
      if (!sid) return
      const res = await vibe.getMessages({ sessionID: sid, limit: 30 })
      if (res.ok) {
        const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
        const msgs = all.filter((m) => m.type === "user")
        const pick = (m) => String(m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? "").trim()
        // The newest matching row that is not already bound to a bubble.
        const bound = new Set(
          [...$("messages").querySelectorAll(".msg.user")]
            .map((el) => el.dataset.msgId)
            .filter(Boolean),
        )
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (pick(msgs[i]) !== wanted) continue
          if (bound.has(msgs[i].id)) continue
          msgEl.dataset.msgId = msgs[i].id
          return
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 700))
  }
}

async function resolveUserMessageId(msg) {
  const sid = state.activeSessionID
  if (!sid) return null
  const res = await vibe.getMessages({ sessionID: sid, limit: 200 })
  if (!res.ok) return null
  const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const msgs = all.filter((m) => m.type === "user")
  const pick = (m) => m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? ""
  const userEls = [...$("messages").querySelectorAll(".msg.user")]
  const idx = userEls.indexOf(msg)
  if (idx < 0) return null

  // Align the server list with the rendered bubbles by walking both in order.
  // Matching by text alone is NOT safe: when the same text was sent twice the
  // old "search from the end" picked the NEWEST match, so the wrong (old)
  // message was deleted and the duplicate stayed for ever. Walking forward
  // pairs the 1st bubble with the 1st server row, the 2nd with the 2nd, ...
  const taken = new Set()
  const ids = new Array(userEls.length).fill(null)
  for (let i = 0; i < userEls.length; i++) {
    const text = userEls[i].dataset.text || ""
    if (!text) continue
    for (let k = 0; k < msgs.length; k++) {
      if (taken.has(msgs[k].id)) continue
      if (pick(msgs[k]) !== text) continue
      taken.add(msgs[k].id)
      ids[i] = msgs[k].id
      break
    }
  }
  if (ids[idx]) return ids[idx]
  // Nothing aligned (the message may not be persisted yet).
  return null
}

/**
 * Revert the session to just before the edited message, then send the new text.
 * Revert uses `files: false`, so the code changes the agent already made stay.
 * Returns true when the resend was started.
 */
async function editAndResend(msg, text) {
  const sid = state.activeSessionID
  if (!sid) return false
  if (state.running) {
    alert("The agent is still running. Stop it first, then edit and resend.")
    return false
  }
  const messageID = msg.dataset.msgId || (await resolveUserMessageId(msg))
  if (!messageID) {
    // Not persisted yet (e.g. the request failed) — just put it back in the composer.
    $("input").value = text
    $("input").dispatchEvent(new Event("input"))
    $("input").focus()
    return false
  }
  const ok = await showConfirm(
    "Edit & resend will remove this message and every reply after it from the chat.\n" +
      "Code changes the agent already made are kept.\n\nContinue?",
  )
  if (!ok) return false
  const res = await vibe.revertSession({ sessionID: sid, messageID })
  if (!res.ok) {
    alert("Could not revert this message: " + (res.error || "unknown error"))
    return false
  }
  await renderSessionHistory(sid)
  $("input").value = text
  $("input").dispatchEvent(new Event("input"))
  await send()
  return true
}

function openSession(id) {
  if (state.subagentView) leaveSubagentView(false)
  state.activeSessionID = id
  resetCompactionUi()
  setMainEmpty(false)
  hideBranchChip()
  document.querySelectorAll(".session-list li").forEach((li) => li.classList.remove("active"))
  const item = [...$("session-list").children].find(
    (li) => li.dataset.id === id,
  )
  item?.classList.add("active")
  renderSessionHistory(id)
  refreshSubagentIndex(id)
  refreshForms()
  // the running-commands list belongs to one session: drop the old rows, then
  // pull the commands this session still has running (they live in the backend)
  for (const [key, job] of [...runningJobs]) if (job.shellId) runningJobs.delete(key)
  renderBgJob()
  refreshShellJobs()
  // the pending retry belongs to the session that failed: switching away drops it
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  stopRetryCountdown()
  hideRetryInline()
  state.retryCount = 0
}

/* ---------- queued prompts (typed while the agent is running) ---------- */
const queuedPrompts = [] // { sid, text }

function renderQueueStrip() {
  const host = $("composer")
  if (!host) return
  let el = $("queue-strip")
  const mine = queuedPrompts.filter((q) => q.sid === state.activeSessionID)
  if (!mine.length) { if (el) el.remove(); return }
  if (!el) {
    el = document.createElement("div")
    el.id = "queue-strip"
    el.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:12px;opacity:.85;border-bottom:1px solid rgba(255,255,255,.08)"
    host.prepend(el)
  }
  el.textContent = ""
  const label = document.createElement("span")
  label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
  label.textContent = `⏳ Queued (${mine.length}): ${mine[0].text.replace(/\s+/g, " ").slice(0, 120)}`
  const x = document.createElement("button")
  x.type = "button"
  x.textContent = "✕"
  x.title = "Remove queued message(s)"
  x.style.cssText = "background:none;border:0;color:inherit;cursor:pointer"
  x.onclick = () => { clearQueuedPrompts(); }
  el.append(label, x)
}

function clearQueuedPrompts() {
  queuedPrompts.length = 0
  renderQueueStrip()
}

function queuePrompt() {
  const ta = $("input")
  const text = ta.value.trim()
  if (!text || !state.activeSessionID) return
  queuedPrompts.push({ sid: state.activeSessionID, text })
  ta.value = ""
  $("btn-send").disabled = false
  renderQueueStrip()
}

async function drainQueuedPrompt() {
  if (state.running || sendInFlight || state.userStopped || state.retryTimer) return
  const i = queuedPrompts.findIndex((q) => q.sid === state.activeSessionID)
  if (i < 0) { renderQueueStrip(); return }
  const [item] = queuedPrompts.splice(i, 1)
  renderQueueStrip()
  const ta = $("input")
  if (ta.value.trim()) { // user is typing something new: put the queued text first, keep theirs
    ta.value = item.text + "\n\n" + ta.value
  } else ta.value = item.text
  await send()
}

let sendInFlight = false
async function send() {
  // Prevent double-click / Enter+click races while provider selection and session
  // setup contain asynchronous IPC calls. Never enqueue a second prompt into a busy run.
  if (sendInFlight) return
  if (state.running) {
    // OpenCode-style: Enter while the agent works queues the message; it is sent
    // automatically as soon as the current run finishes successfully.
    queuePrompt()
    return
  }
  sendInFlight = true
  try {
    await performSend()
  } catch (e) {
    showRunFailureInline(String(e?.message || e))
  } finally {
    sendInFlight = false
  }
}

async function performSend() {
  const ta = $("input")
  const text = ta.value.trim()
  if (!text && attachments.length === 0) return
  // A new message cancels a pending automatic retry (no double prompt).
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  stopRetryCountdown()
  hideRetryInline()
  maybeShowBranchForText(text)
  // The owner code is checked and REDACTED here: the model must never see it.
  const owner = await checkOwnerCode(text)
  const sendText = owner.found ? owner.text : text

  // Re-read the authoritative provider catalog before every run. This closes the
  // race where profiles.json was edited/deleted but localStorage or an existing
  // session still points at the previous provider ID.
  if (typeof vibe.providerCatalog === "function") {
    const latest = await vibe.providerCatalog()
    if (!latest || latest.ok === false) {
      throw new Error(`Could not refresh the current provider catalog before sending: ${latest?.error || "unknown error"}`)
    }
    applyProviderCatalog(latest.data || {})
  } else {
    await loadModels()
  }
  const isCurrentModel = (key) => !!key && (state.models || []).some((item) => `${item.providerID}/${item.id}` === key)
  if (!isCurrentModel(state.selectedModel)) {
    const fallback = (state.models || []).find((item) => item && item.providerID && item.id)
    if (!fallback) throw new Error("No configured provider models are available. Open Settings → Model settings and save a provider with at least one model.")
    state.selectedModel = `${fallback.providerID}/${fallback.id}`
    try { localStorage.setItem("vibecoder.model", state.selectedModel) } catch {}
    $("model-label").textContent = modelDisplayLabel(state.selectedModel)
  }

  // A fresh user request starts a fresh background cycle.
  autoCont.count = 0
  autoCont.todos = []
  if (!state.activeSessionID) {
    const res = await vibe.createSession({ directory: projectDir })
    if (!res.ok) return alert(res.error)
    const s = res.data?.data ?? res.data
    state.activeSessionID = s.id ?? s.sessionID
    await refreshSessions()
  }
  // Bind the session to a "VibeCoder AI" agent (project-level agent file)
  let workDir = projectDir
  if (!workDir) {
    const c = await vibe.cwd()
    workDir = c.ok ? c.data : null
  }
  if (workDir) {
    const ag = await vibe.ensureAgent({ directory: workDir })
    if (ag.ok && !(ag.data && ag.data.ok === false)) {
      const sw = await vibe.switchAgent({ sessionID: state.activeSessionID, agent: "vibecoderai" })
      if (!sw.ok) console.warn("[VibeCoder] could not select the agent:", sw.error || "unknown error")
      hideError("agent")
    } else {
      console.warn("[VibeCoder] could not prepare the project agent:", ag.error || ag.data?.error || "unknown error")
      hideError("agent")
    }
  }
  await applyPermissionMode()
  if (state.selectedModel) {
    const [providerID, ...rest] = state.selectedModel.split("/")
    const resM = await vibe.setModel({
      sessionID: state.activeSessionID,
      model: { providerID, id: rest.join("/") },
    })
    if (!resM || resM.ok === false) {
      const message = resM?.error || "Could not apply the selected model. No message was sent."
      showError("Could not switch model", message, { key: "model-switch" })
      return // Never send the prompt using the session's previously active provider.
    }
    hideError("model-switch")
  }
  setMainEmpty(false)
  const files = []
  for (const a of attachments) {
    if (a.kind === "image" && a.dataUrl) {
      files.push({ uri: a.dataUrl, mime: a.mime || "image/png", name: a.name })
    } else if (a.path) {
      const uri = "file:///" + String(a.path).replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")
      files.push({ uri, mime: a.mime || "text/plain", name: a.name })
    }
  }
  const fullText = sendText
  ta.value = ""
  const imageUrls = attachments
    .filter((a) => a.kind === "image" && a.dataUrl)
    .map((a) => a.dataUrl)
  const fileCount = attachments.length - imageUrls.length
  let shown = sendText
  if (fileCount > 0) shown = (shown ? shown + " " : "") + `📎${fileCount}`
  attachments.length = 0
  renderAttachments()
  const userMsgEl = addMsg("user", shown, "", imageUrls)
  attachUserActions(userMsgEl, sendText, "")
  scrollChat(true)
  clearActs()
  msgBuffers.clear()
  textEnded.clear()
  state.needBubble = false
  const thinking = addMsg("assistant", "Thinking...", "thinking")
  state.pendingBubble = thinking
  state.liveTextEl = thinking
  state.retryBubble = thinking // a later retry countdown belongs to this row
  if (state.thinkTimer) clearTimeout(state.thinkTimer)
  state.thinkTimer = null
  setRunning(true)
  // A new run starts only after the prior execution lifecycle has completed.
  state.compactionBlockedRun = false
  // a fresh run: forget the previous interrupt reason / error
  state.interruptReason = null
  state.userStopped = false
  state.lastRealError = null
  const thinkingEffort = pillState.thinking === "None" ? "none" : pillState.thinking.toLowerCase()
  // Remember what is being sent BEFORE the call: if the request itself fails or
  // times out, the Retry button needs the text.
  state.lastSend = { text: fullText, files, thinking: thinkingEffort, msgEl: userMsgEl, sid: state.activeSessionID }
  state.retryCount = 0
  let res
  try {
    res = await vibe.prompt({ sessionID: state.activeSessionID, text: fullText, files, thinking: thinkingEffort })
  } catch (e) {
    setRunning(false)
    if (state.thinkTimer) clearTimeout(state.thinkTimer)
    // prompt() threw before the engine touched the session: nothing to revert
    if (state.lastSend) state.lastSend.persisted = false
    showRunFailureInline(String(e), thinking)
    return
  }
  if (!res.ok) {
    setRunning(false)
    if (state.thinkTimer) clearTimeout(state.thinkTimer)
    if (state.lastSend) state.lastSend.persisted = false
    showRunFailureInline(res.error || "Unknown error", thinking)
    return
  }
  hideError("prompt")
  // The engine titles a fresh session from this first prompt. The run starts
  // fire-and-forget on the backend, so refresh shortly after (the run-end
  // handler refreshes again as the authority).
  setTimeout(refreshSessions, 700)
  // Remember what was sent so a timeout / rate limit can be retried without the
  // user retyping anything.
  state.lastSend = { text: fullText, files, thinking: thinkingEffort, msgEl: userMsgEl, sid: state.activeSessionID }
  state.retryCount = 0
  // Bind the live bubble to the server message id, so a later "edit & resend"
  // or an automatic retry reverts THIS message and not a same-text one.
  // The prompt is enqueued at this point, so the row may not exist yet — the
  // lookup is retried a few times in the background.
  bindLiveMessageId(userMsgEl, fullText)
  // prompt() only enqueues the message — the agent is still running. Keep the
  // stop/running state until execution.succeeded / failed / interrupted fires.
  if (state.thinkTimer) clearTimeout(state.thinkTimer)
  state.thinkTimer = setTimeout(() => {
    if (thinking.classList.contains("thinking")) {
      // Do NOT end the running state here: OpenCode can sit inside its own
      // provider retry for minutes without emitting anything. Just say so, the
      // Stop button stays available.
      thinking.textContent = "⏳ No output for 2 minutes — still waiting (Stop to cancel)"
    }
  }, 120000)
  // Safety net in case the execution event never arrives. This is based on
  // *inactivity* (any event from the run restarts it), not on the total run
  // time: a long task with tool calls must never be killed by a fixed limit.
  armRunWatchdog()
}

/* ---------- inactivity watchdog ---------- */
/* A fixed "the run must be done in 10 minutes" timer used to interrupt big
   tasks and the UI then said "The run was interrupted." for no visible reason.
   OpenCode itself has no such limit, so now only a run that produced *nothing*
   (no text, reasoning, tool or step event) for a long time is stopped. */
const RUN_INACTIVITY_MS = 15 * 60 * 1000

function armRunWatchdog() {
  if (state.runTimer) clearTimeout(state.runTimer)
  state.runTimer = setTimeout(() => {
    state.runTimer = null
    if (!state.running) return
    // The abort that follows is generic - remember the real reason first.
    state.interruptReason = "inactivity"
    if (state.activeSessionID) Promise.resolve(vibe.interrupt({ sessionID: state.activeSessionID })).catch(() => {})
    setRunning(false)
    const mins = Math.round(RUN_INACTIVITY_MS / 60000)
    showRunFailureInline(`Stopped after ${mins} minutes of silence — send the message again to continue where it stopped.`)
  }, RUN_INACTIVITY_MS)
}

/* ---------- retry after a timeout / rate limit ---------- */
/* Provider hiccups (429, 5xx, timeouts, dropped sockets) used to stop the run
   with an error and nothing else. Now the run retries itself like OpenCode:
   exponential backoff from 2s capped at 10s, 10 attempts, with jitter. The
   countdown is rendered as its own row inside the timeline, directly under the
   line where the run stopped - not as a popup and not as a bottom bar. */
const MAX_RETRIES = 10

/** OpenCode's schedule: 2s, 4s, 8s, then 10s for the rest, with jitter. */
function retryDelayMs(attempt) {
  const base = Math.min(2000 * Math.pow(2, Math.max(0, attempt - 1)), 10000)
  const jitter = 0.85 + Math.random() * 0.3
  return Math.max(1000, Math.round(base * jitter))
}

/**
 * Context compaction failures are terminal for the current request. Retrying
 * the same oversized transcript cannot fix them and creates a stale Stop row.
 */
function isTerminalCompactionError(err) {
  const value = err && typeof err === "object" ? err : { message: String(err ?? "") }
  const code = String(value.code || "").toUpperCase()
  if (code.startsWith("CONTEXT_COMPACTION_")) return true
  const s = `${String(value.message || "")} ${JSON.stringify(value)}`.toLowerCase()
  return /context compaction failed|context compaction created a checkpoint.*still over budget|checkpoint committed, but the resulting request remains over budget|automatic compaction stopped after \d+ successful compactions|cannot compact safely|cannot compact because a safe split|no valid split boundary preserves|insufficient context budget to ask for a checkpoint summary|do not send another model request without recovery/.test(s)
}

/** Errors another attempt cannot fix: the key, account, model or compaction budget. */
function isFatalRunError(err) {
  if (isTerminalCompactionError(err)) return true
  const s = JSON.stringify(err ?? "").toLowerCase()
  if (!s) return false
  return /no credits|not enough credit|out of credits|insufficient (funds|balance|credits)|credit balance|billing|invalid api key|unauthorized|forbidden|permission denied|model not found|does not exist|no api key|api key for/.test(
    s,
  )
}

/** Everything else is retried automatically: rate limits, 5xx, timeouts, dropped
    streams, tool failures and aborts that arrive without a reason. */
function isRetryableRunError(err) {
  return !isFatalRunError(err)
}

/** The provider really says the account has no credits (a 429 is not that). */
function isNoCreditError(err) {
  const s = JSON.stringify(err ?? "").toLowerCase()
  return /no credits|not enough credit|out of credits|insufficient (funds|balance|credits)|credit balance|billing/.test(s)
}

function addRetryButtonToBubble(bubble) {
  if (!bubble || bubble.querySelector(".retry-btn")) return
  const btn = document.createElement("button")
  btn.className = "save-btn ghost retry-btn"
  btn.textContent = "⟳ Retry"
  btn.title = "Send the same message again"
  btn.onclick = async () => {
    btn.disabled = true
    const started = await retryLastRun()
    // nothing was sent (session still stopping / revert blocked): keep it usable
    if (!started) btn.disabled = false
  }
  bubble.appendChild(btn)
}

/** A run failure belongs where it happened: on the assistant bubble, with a Retry
 *  button. Run failures never open the red banner - that popup is only for setup
 *  problems (settings, providers). */
function showRunFailureInline(msg, target) {
  hideError("execution")
  hideError("prompt")
  hideError("retry")
  // A provider that answers 4xx before streaming ANY text leaves no assistant
  // bubble behind, and the history re-render wipes the "Thinking..." placeholder
  // because nothing was persisted for the assistant. Create the bubble instead
  // of dropping the error: a failed run that looks like silence is the worst
  // failure mode ("my message never got an answer").
  const t = target || runEndBubble()
  t.classList.remove("thinking")
  t.textContent = `⚠ ${msg}`
  addRetryButtonToBubble(t)
  scrollChat()
  return t
}

/** The server id of the newest persisted user message matching `text` (or the last
 *  user message when it has no text, e.g. an image-only prompt). Returns "" when it
 *  cannot be proven that the failed bubble really is in the session. */
async function findLastUserMessageID(sid, text) {
  if (!sid) return ""
  const res = await vibe.getMessages({ sessionID: sid, limit: 200 })
  if (!res || res.ok === false) return ""
  const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const users = all.filter((m) => m.type === "user")
  if (!users.length) return ""
  // More rendered user bubbles than server rows means the failed message never
  // reached the session (no API key, unknown profile...). Reverting then would
  // delete an OLDER real turn - never do that.
  const domUsers = $("messages").querySelectorAll(".msg.user").length
  if (domUsers > users.length) return ""
  const newest = users[users.length - 1]
  const pick = (m) => String(m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? "").trim()
  const wanted = String(text || "").trim()
  if (wanted) return pick(newest) === wanted ? newest.id || "" : ""
  return pick(newest) ? "" : newest.id || ""
}

/** Resend the last message, dropping the failed turn first so it is not duplicated. */
async function retryLastRun(auto = false) {
  const last = state.lastSend
  if (!last) return false
  // a timer and a click can race: only one retry may resend
  if (state.retrying) return false
  // A retry while the previous attempt is still alive must stop that run first:
  // the engine would otherwise answer "Session is busy" and the message would be
  // added a second time. The backend also waits, this makes the UI match it.
  if (state.running) {
    try {
      await vibe.interrupt({ sessionID: state.activeSessionID || last.sid })
    } catch {}
    const until = Date.now() + 5000
    while (state.running && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    if (state.running) {
      const t = lastAssistantBubble()
      if (t) t.textContent = "⏹ The run is still stopping — Retry again in a moment."
      return false
    }
  }
  state.retrying = true
  try {
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    // Never resend into another session the user switched to meanwhile.
    if (last.sid && state.activeSessionID && last.sid !== state.activeSessionID) return false
    const sid = state.activeSessionID || last.sid
    const target = lastAssistantBubble()
    // Preferred path: RESUME the run from the exact point it stopped instead of
    // rolling the turn back and replaying it. Every tool call that already
    // finished (reads, edits, file writes) stays in the session, so the work the
    // agent completed before the timeout is neither redone nor lost. Revert +
    // resend below stays only as the fallback: a message that never reached the
    // session, or a backend without the resume endpoint.
    if (last.persisted !== false && typeof vibe.resumeRun === "function") {
      if (target) target.classList.remove("thinking")
      let r = null
      try {
        setRunning(true) // before the IPC call: live deltas must not be dropped
        r = await vibe.resumeRun({ sessionID: sid })
      } catch {
        r = null
      }
      if (r && r.ok) {
        // reuse the retry bubble - a retried run must never add a second row
        const thinking = retryBubble()
        thinking.classList.add("thinking")
        thinking.textContent = "⟳ Resuming where it stopped..."
        state.pendingBubble = thinking
        state.liveTextEl = thinking
        state.userStopped = false
        state.interruptReason = null
        if (state.thinkTimer) clearTimeout(state.thinkTimer)
        state.thinkTimer = setTimeout(() => {
          if (thinking.classList.contains("thinking")) {
            thinking.textContent = "⏳ No output for 2 minutes — still waiting (Stop to cancel)"
          }
        }, 120000)
        hideError("execution")
        hideError("prompt")
        hideError("retry")
        hideRetryInline()
        armRunWatchdog()
        return true
      }
      setRunning(false)
    }
    // Find the failed user message on the server and remove it (plus everything
    // after it) BEFORE sending again. Without this the chat keeps both copies.
    let messageID = ""
    if (last.persisted === false) {
      // The prompt failed before the engine appended the message (no API key,
      // unknown profile...). It is a local bubble only: drop it, revert nothing.
      if (last.msgEl && last.msgEl.isConnected) last.msgEl.remove()
      if (target && target.isConnected) target.remove()
    } else {
      messageID = last.msgEl?.dataset.msgId || ""
      try {
        if (!messageID && last.msgEl && last.msgEl.isConnected) messageID = (await resolveUserMessageId(last.msgEl)) || ""
      } catch (e) {
        console.warn("retry: could not find the failed message:", e)
      }
      try {
        if (!messageID) messageID = await findLastUserMessageID(sid, last.text)
      } catch {}
      if (messageID) {
        let r = null
        try {
          r = await vibe.revertSession({ sessionID: sid, messageID })
        } catch (e) {
          r = { ok: false, error: String(e) }
        }
        if (!r || r.ok === false) {
          // The old turn is still in the session. Sending again now would leave
          // BOTH messages in the chat for ever, so nothing is sent.
          const msg = (r && r.error ? String(r.error) : "Unknown error") + " — the message was not sent again."
          showRunFailureInline(msg, target)
          return false
        }
        await renderSessionHistory(sid)
      } else if (last.msgEl && last.msgEl.isConnected) {
        // Not provably in the session: never delete an older turn. Only the local
        // bubble is dropped so the resend does not show the text twice.
        last.msgEl.remove()
        if (target && target.isConnected) target.remove()
      }
    }
    // Images / files of the original message go with the retry.
    attachments.length = 0
    for (const f of Array.isArray(last.files) ? last.files : []) {
      const uri = String(f.uri || "")
      if (uri.startsWith("data:")) {
        attachments.push({ kind: "image", dataUrl: uri, mime: f.mime || "image/png", name: f.name || "image" })
      } else if (uri.startsWith("file:///")) {
        attachments.push({ kind: "file", path: decodeURIComponent(uri.slice(8)), mime: f.mime || "", name: f.name || "(file)" })
      }
    }
    renderAttachments()
    $("input").value = last.text
    $("input").dispatchEvent(new Event("input"))
    hideError("execution")
    hideError("prompt")
    hideError("retry")
    hideRetryInline()
    if (auto) setRunning(false)
    // send() starts a fresh attempt and resets the counter. A retry must keep the
    // budget it already used, otherwise a model that never answers would retry
    // for ever instead of stopping after the whole schedule.
    const usedRetries = state.retryCount
    await send()
    state.retryCount = Math.max(state.retryCount, usedRetries)
    return true
  } finally {
    state.retrying = false
  }
}

/** The live "Retry 2/6 · 14s" label under the point where the run stopped. */
function stopRetryCountdown() {
  if (state.retryTick) {
    clearInterval(state.retryTick)
    state.retryTick = null
  }
}

/** The live "Retrying 2/10 · 8s" row under the point where the run stopped. */
const retryRowState = { active: false, attempt: 0, total: MAX_RETRIES, left: 0, reason: "" }

function retryRow() {
  const box = $("messages")
  if (!box) return null
  let el = box.querySelector(".retry-row")
  if (!el) {
    el = document.createElement("div")
    el.className = "retry-row"
    el.setAttribute("role", "status")
    el.setAttribute("aria-live", "polite")
    const spin = document.createElement("span")
    spin.className = "retry-spin"
    spin.setAttribute("aria-hidden", "true")
    spin.textContent = "⟳"
    const text = document.createElement("span")
    text.className = "retry-text"
    const stop = document.createElement("button")
    stop.className = "retry-row-stop"
    stop.type = "button"
    stop.textContent = "Stop"
    stop.onclick = (e) => {
      e.stopPropagation()
      cancelRetry()
    }
    el.append(spin, text, stop)
    // Insert directly after the last assistant bubble, not at the end of the container.
    // This keeps the retry counter inline below the VibeCoder message.
    // Always the very end of the timeline: tool rows may follow the last assistant bubble.
    box.appendChild(el)
  }
  return el
}

function retryRowLabel() {
  const r = retryRowState
  const wait = r.left > 0 ? ` · ${r.left}s` : ""
  return `Retrying ${r.attempt}/${r.total}${wait}`
}

/** Render (or re-render) the inline retry row in its place in the timeline. */
function renderRetryRow() {
  if (!retryRowState.active) return
  const el = retryRow()
  if (!el) return
  const text = el.querySelector(".retry-text")
  if (text) text.textContent = retryRowState.reason ? `${retryRowState.reason} — ${retryRowLabel()}` : retryRowLabel()
  scrollChat()
}

/** Used after renderSessionHistory() wiped #messages: put the row back. */
function restoreRetryRow() {
  if (retryRowState.active) renderRetryRow()
  else hideRetryInline()
}

function showRetryInline(text, attempt, total, left) {
  if (attempt != null) retryRowState.attempt = attempt
  if (total != null) retryRowState.total = total
  if (left != null) retryRowState.left = left
  if (text != null) retryRowState.reason = String(text)
  retryRowState.active = true
  // The old bottom bar stays hidden: the retry lives in the timeline now.
  const legacy = $("retry-inline")
  if (legacy) legacy.hidden = true
  renderRetryRow()
}

function hideRetryInline() {
  retryRowState.active = false
  const el = $("messages")?.querySelector(".retry-row")
  if (el) el.remove()
  const legacy = $("retry-inline")
  if (legacy) legacy.hidden = true
}

/** The user cancelled the wait: no further attempt, and stop the run if needed. */
function cancelRetry() {
  stopRetryCountdown()
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  hideRetryInline()
  if (state.running) stopRunningJob("agent")
}

$("retry-inline-stop")?.addEventListener("click", cancelRetry)

/**
 * The ONE bubble every retry writes into (countdown, resume notice, errors).
 * Each attempt used to addMsg a fresh VibeCoder row and leave the previous
 * "⟳ Retry n/3 · 0s" frozen in the chat - three retries, three duplicate
 * half-dead bubbles. Reusing a single row keeps the whole retry story in one
 * place and it gets replaced by the real answer once the run recovers.
 */
function retryBubble() {
  const el = state.retryBubble && state.retryBubble.isConnected ? state.retryBubble : lastAssistantBubble()
  if (el) {
    state.retryBubble = el
    return el
  }
  const fresh = addMsg("assistant", "", "thinking")
  state.retryBubble = fresh
  return fresh
}

function scheduleRetry(reason) {
  // Never schedule a retry for a compaction failure: no model request is safe
  // until the conversation is reduced or the user changes context settings.
  if (isTerminalCompactionError(reason)) {
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.retryTimer = null
    stopRetryCountdown()
    hideRetryInline()
    return false
  }
  // one retry at a time: step.failed and execution.failed can both report the
  // same failure, and a second schedule would burn attempts for nothing
  if (state.retryTimer || state.retrying) return true
  if (state.retryCount >= MAX_RETRIES) return false
  state.retryCount++
  const attempt = state.retryCount
  const wait = retryDelayMs(attempt)
  let left = Math.max(1, Math.round(wait / 1000))
  // Do NOT overwrite the stopped assistant line: the error stays where it
  // happened and the retry row is appended directly under it.
  showRetryInline(reason, attempt, MAX_RETRIES, left)
  // Live seconds, so the user can see the retry is real and how long it waits.
  stopRetryCountdown()
  state.retryTick = setInterval(() => {
    left = Math.max(0, left - 1)
    showRetryInline(null, attempt, MAX_RETRIES, left)
    if (left <= 0) stopRetryCountdown()
  }, 1000)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    stopRetryCountdown()
    retryLastRun(true)
  }, wait)
  return true
}

/* ---------- running / stop state ---------- */
function setRunning(on) {
  state.running = !!on
  if (!state.running) state.pulse = null
  const btn = $("btn-send")
  btn.classList.toggle("stop", state.running)
  btn.textContent = state.running ? "■" : "↑"
  btn.title = state.running ? "Stop" : "Send"
  btn.disabled = state.running ? false : !$("input").value.trim()
  updateRunBadge()
  // background job chip: shows while the agent works and the app is away
  if (state.running) {
    runningJobs.set("agent", { kind: "Agent", title: "Agent run", at: Date.now() })
    if (appIsInBackground()) markBackgroundJob()
    else renderBgJob()
  } else {
    clearBackgroundJob()
  }
  if (!state.running && state.runTimer) {
    clearTimeout(state.runTimer)
    state.runTimer = null
  }
  if (state.running) {
    if (state.permPoll) clearInterval(state.permPoll)
    state.permPoll = setInterval(refreshPermissionRequests, 1200)
    // questions can arrive any moment while the agent runs; poll keeps the card
    // in sync even if an event is missed
    if (state.formPoll) clearInterval(state.formPoll)
    state.formPoll = setInterval(refreshForms, 1500)
  } else {
    if (state.permPoll) {
      clearInterval(state.permPoll)
      state.permPoll = null
    }
    if (state.formPoll) {
      clearInterval(state.formPoll)
      state.formPoll = null
    }
    refreshForms()
  }
  updateJumpButton()
}

// Test hook: the offline UI tests drive the event handler directly.
window.__testSetRunning = (on) => setRunning(!!on)
window.__testState = state
// Test hooks for the duplicate/retry regression test.
window.__testRenderAssistant = (m) => renderAssistantMessage(m)
window.__testScheduleRetry = (reason) => scheduleRetry(reason)
window.__testRetryLastRun = (auto) => retryLastRun(auto)
window.__testClearRetry = () => {
  stopRetryCountdown()
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  hideRetryInline()
}

$("btn-send").onclick = async () => {
  if (state.running) {
    // stop the running agent
    state.userStopped = true
    state.interruptReason = "user"
    clearQueuedPrompts() // Stop drops anything still waiting
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    if (state.activeSessionID) await vibe.interrupt({ sessionID: state.activeSessionID })
    setRunning(false)
    state.retryBubble = null
    typingFlush()
    const t = lastAssistantBubble()
    if (t?.classList.contains("thinking")) {
      t.classList.remove("thinking")
      t.textContent = "⏹ Stopped"
    }
    return
  }
  send()
}
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})
$("input").addEventListener("input", () => {
  $("btn-send").disabled = state.running ? false : !$("input").value.trim()
})
/* Ctrl/Cmd+C over a selection in the chat (outside inputs) copies it. The native
   app menu is gone, so the shortcut is wired here; inside inputs the browser's
   own copy keeps working. */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== "c") return
  const t = e.target
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !String(sel).trim()) return
  document.execCommand("copy")
  e.preventDefault()
})

/* ---------- live events (assistant streaming, v2 schema: event.data) ---------- */
const msgBuffers = new Map() // "assistantMessageID#ordinal" -> streamed text
const textEnded = new Map() // same key -> final trimmed text (duplicate guard)
const typing = { el: null, full: "", shown: 0, timer: null }

/** Bubble for run-level errors/stop notices. Reuse the last assistant bubble only when
 *  nothing but a retry row/compaction card follows it; otherwise (tool rows came after it)
 *  add a fresh bubble at the end so the error appears where the run actually stopped. */
function runEndBubble() {
  const last = lastAssistantBubble()
  const msg = last ? last.closest(".msg") : null
  if (msg) {
    let n = msg.nextElementSibling
    while (n && (n.classList.contains("retry-row") || n === liveCompactEl)) n = n.nextElementSibling
    if (!n) return last
  }
  return addMsg("assistant", "")
}

function lastAssistantBubble() {
  return [...document.querySelectorAll(".msg.assistant .bubble")].at(-1) ?? null
}

// Reveal streamed text progressively (left → right) instead of dumping chunks.
function typingTick() {
  if (!typing.el) {
    clearInterval(typing.timer)
    typing.timer = null
    return
  }
  const left = typing.full.length - typing.shown
  if (left <= 0) {
    clearInterval(typing.timer)
    typing.timer = null
    return
  }
  typing.shown += Math.min(left, 2 + Math.floor(left / 25))
  typing.el.textContent = typing.full.slice(0, typing.shown)
  scrollChat()
}

function typingPush(text) {
  typing.full = text
  if (!typing.timer) typing.timer = setInterval(typingTick, 16)
}

/* ---------- real error text ---------- */
/* OpenCode publishes a generic "Step interrupted" / "Tool execution interrupted"
   when a run is aborted, which hides what really happened. These helpers turn
   that into the real reason (or the real error message). */
const INTERRUPT_REASON_TEXT = {
  user: "You stopped this run.",
  shutdown: "The OpenCode service shut down while this run was going.",
  superseded: "Another run replaced this one.",
  inactivity: "The run was stopped after a period of inactivity.",
  unknown: "The run was interrupted.",
}

/** A generic abort message instead of the real cause. */
function isGenericInterrupt(err) {
  if (!err) return false
  const msg = String(err.message || "").toLowerCase()
  return (
    err.type === "aborted" ||
    msg.includes("step interrupted") ||
    msg.includes("tool execution interrupted")
  )
}

/** The real error, with its type and any nested detail. */
function realErrorText(err) {
  if (!err) return ""
  const parts = []
  if (err.message) parts.push(String(err.message))
  if (err.type && err.type !== "aborted") parts.push(`(${err.type})`)
  const extra = err.data ?? err.cause ?? err.error
  if (extra) {
    let t = ""
    if (typeof extra === "string") t = extra
    else if (extra.message) t = String(extra.message)
    else {
      try {
        t = JSON.stringify(extra)
      } catch {}
    }
    if (t && !parts.join(" ").includes(t)) parts.push(t)
  }
  return parts.join(" ").trim()
}

/** Why the run was interrupted, in plain words. */
function interruptText() {
  const reason = state.interruptReason || (state.userStopped ? "user" : "unknown")
  return INTERRUPT_REASON_TEXT[reason] || INTERRUPT_REASON_TEXT.unknown
}

function typingFlush() {
  if (typing.timer) {
    clearInterval(typing.timer)
    typing.timer = null
  }
  if (typing.el) {
    // Render final text as markdown
    typing.el.innerHTML = window.renderMarkdown(typing.full)
    scrollChat()
  }
  typing.el = null
  typing.full = ""
  typing.shown = 0
}

vibe.onEvent(async (event) => {
  const type = event?.type ?? ""
  const data = event?.data ?? {}
  const sid = data.sessionID

  // Anything the running session emits proves the run is still alive.
  if (state.running && sid && sid === state.activeSessionID) armRunWatchdog()

  // Provider JSON files are watched by the Electron main process. Refresh all
  // derived UI state when a provider/model/key is changed inside or outside the app.
  if (type === "providers.changed") {
    refreshProviderStateLive().catch((error) => showError("Could not refresh providers", String(error?.message || error), { key: "providers-refresh" }))
    return
  }
  if (type === "skills.changed") {
    loadSkills().catch(() => {})
    return
  }

  // Synthetic status events from the host / main process (no sessionID).
  if (type === "host.event_stream") {
    if (data.status === "disconnected") {
      showError(
        "Lost connection to the agent",
        `The event stream disconnected (attempt ${Math.max(1, Number(data.attempt) || 1)}). ` +
          `Reconnecting automatically…${data.message ? "\n\n" + data.message : ""}`,
        { key: "host-stream" },
      )
    } else if (data.status === "connected") {
      hideError("host-stream")
    }
    return
  }
  if (type === "app.error") {
    showError(data.title || "Application error", data.message || data.detail || "Unknown error")
    return
  }
  if (type === "app.focus") {
    // The window lost/gained focus: the agent keeps working in the background.
    if (data.focused === false) markBackgroundJob()
    else renderBgJob()
    return
  }
  if (type === "app.openUrl") {
    // A link clicked anywhere in the app opens in the built-in browser panel,
    // never in an outside window.
    if (data && data.url) openBrowser(data.url, { newTab: true })
    return
  }

  if (type === "compaction.settings.changed") {
    applyCompactionSettings(data.compaction || data)
    return
  }

  if (type === "subagent.event") {
    handleSubagentEvent(data)
    return
  }

  if (type === "session.pulse.started" && sid === state.activeSessionID) {
    state.pulse = { step: 0, tools: 0, maxSteps: Number(data.maxSteps) || 0 }
    updateRunBadge()
    return
  }
  if (type === "session.pulse.step.started" && sid === state.activeSessionID) {
    state.pulse = { ...(state.pulse || {}), step: Number(data.step) || 0, tools: Array.isArray(data.tools) ? data.tools.length : 0 }
    updateRunBadge()
    return
  }
  if (type === "session.pulse.step.ended" && sid === state.activeSessionID) {
    state.pulse = { ...(state.pulse || {}), step: Number(data.step) || state.pulse?.step || 0 }
    updateRunBadge()
    return
  }
  if (type === "session.permission.locked" && sid === state.activeSessionID) {
    addHarnessNote("Hard lock blocked this action", `${data.tool || "action"}${data.subject ? ` — ${data.subject}` : ""}`, "locked")
    return
  }
  if (type === "session.recipe.started" && sid === state.activeSessionID) {
    addHarnessNote(`Recipe /${data.id || "unknown"}`, [data.agent && `persona ${data.agent}`, data.model && `model ${data.model}`].filter(Boolean).join(" · "))
    return
  }

  // While inspecting a child, keep the parent's run state current but do not
  // paint parent text/tools into the child timeline. Back re-renders the parent
  // canonically from disk.
  if (state.subagentView && sid === state.activeSessionID && /^session\.(text|reasoning|tool|compaction)\./.test(type)) return

  // The question tool surfaces as a session "form". Render it as an interactive
  // card — the agent is paused until the user answers or dismisses it.
  if (type === "form.created" || type === "form.replied" || type === "form.cancelled") {
    const fsid = data.form?.sessionID ?? data.sessionID
    if (!fsid || fsid === state.activeSessionID) refreshForms()
    return
  }

  // Compaction (auto or manual): show the checkpoint while it streams, then
  // re-render the canonical timeline once the summary is stored.
  if (type.startsWith("session.compaction.")) {
    if (sid !== state.activeSessionID) return
    if (type === "session.compaction.started") {
      // The compact endpoint is always admitted as a manual request, so use our
      // own trigger to label an automatic checkpoint correctly.
      const why = data.reason === "auto" ? "auto" : (state.compactTrigger || "manual")
      state.compacting = true
      updateRunBadge()
      showCompaction("running", { reason: why, summaryModel: data.summaryModel })
      if (state.compactWatch) clearTimeout(state.compactWatch)
      state.compactWatch = setTimeout(() => {
        if (!state.compacting) return
        finishCompaction("failed", { reason: data.reason, error: "No response from the compaction step (timed out)" })
      }, COMPACT_TIMEOUT_MS)
    } else if (type === "session.compaction.delta") {
      const el = liveCompactEl
      if (el) {
        const sum = el.querySelector(".ctxd-sum")
        const waiting = data.reset && !data.text
        const text = waiting
          ? `Waiting for ${data.summaryModel || "the summary model"} to write the checkpoint summary…`
          : String(data.text || "")
        sum.classList.toggle("waiting", waiting)
        if (waiting) sum.textContent = text
        else if (window.renderMarkdown) sum.innerHTML = window.renderMarkdown(text)
        else sum.textContent = text
        sum.hidden = !text
        const meta = el.querySelector(".ctxd-meta")
        if (meta && data.summaryModel) meta.textContent = `${data.reason || state.compactTrigger || "compaction"} · ${data.summaryModel}`
      }
    } else if (type === "session.compaction.ended") {
      const why = data.reason === "auto" ? "auto" : (state.compactTrigger || "manual")
      const text = data.summary || data.text || ""
      if (data.summarized === false) {
        finishCompaction("failed", { reason: why, error: data.error || "No valid checkpoint summary was created." })
      } else if (data.fitsBudget === false) {
        finishCompaction("overbudget", { reason: why, text, summarySource: data.summarySource, summaryModel: data.summaryModel, before: data.before, after: data.after, error: data.error || "The compacted request remains over budget." })
      } else {
        finishCompaction("done", { reason: why, text, summarySource: data.summarySource, summaryModel: data.summaryModel, before: data.before, after: data.after, projectContext: data.projectContext })
      }
    } else if (type === "session.compaction.failed") {
      const msg = (data.error && (data.error.message || data.error.type)) || "compaction failed"
      if (data.reason === "auto" && /nothing to compact/i.test(msg)) quietCompactionEnd()
      else finishCompaction("failed", { reason: data.reason, error: msg })
    }
    return
  }

  // Live token usage for the context ring (no return: other handlers still run).
  if ((type === "session.step.ended" || type === "session.step.failed") && data.tokens && sid === state.activeSessionID) {
    U.addStep(usage, data.assistantMessageID ?? `live-${Date.now()}`, data.tokens, data.cost)
    updateUsageRing()
  }

  if (type === "session.text.delta" || type === "session.text.ended") {
    if (sid !== state.activeSessionID) return
    // The turn is over and the history render is authoritative - a late event
    // must not paint the message a second time.
    if (!state.running) return
    // One assistant message can contain several text parts. Key by ordinal so
    // a new part starts a fresh row instead of appending into the previous one.
    const key = `${data.assistantMessageID ?? "cur"}#${data.ordinal ?? 0}`
    if (type === "session.text.delta" && textEnded.has(key)) return // late duplicate delta
    const buf = msgBuffers.get(key) ?? ""
    const next = type === "session.text.ended" ? (data.text ?? buf) : buf + (data.delta ?? "")
    msgBuffers.set(key, next)

    if (type === "session.text.ended") {
      const final = String(next).trim()
      // Some models emit text.ended twice (or replay it after a retry) — the
      // canonical history render at the end of the turn is authoritative, so
      // only the first completed part is painted live.
      if (textEnded.has(key)) return
      textEnded.set(key, final)
      if (typing.el && !typing.el.isConnected) typing.el = null // replaced by the history render
      if (typing.el) {
        typingPush(next)
        typingFlush()
      } else {
        // No live bubble for this part. If the timeline already shows the text
        // (the history render put it there), do NOT add it a second time.
        const prev = lastAssistantBubble()
        const alreadyThere = !!prev && !!final && prev.textContent.includes(final)
        if (!alreadyThere) {
          const b = addMsg("assistant", "")
          b.textContent = next
        }
      }
      state.liveTextEl = null
    } else {
      if (!typing.el) {
        const ph = state.liveTextEl
        if (ph && ph.isConnected) {
          ph.classList.remove("thinking")
          ph.textContent = ""
          typing.el = ph
        } else {
          typing.el = addMsg("assistant", "")
        }
        typing.shown = 0
      }
      typingPush(next)
    }
    if (state.thinkTimer) {
      clearTimeout(state.thinkTimer)
      state.thinkTimer = null
    }
  }
  if (type === "session.step.failed") {
    if (sid !== state.activeSessionID) return
    const err = data.error ?? {}
    if (isTerminalCompactionError(err) || (data.retryable === false && /compaction|context window|over budget/i.test(String(err.message || err)))) {
      // The compaction card already contains the checkpoint and budget error.
      // Remove only the empty Thinking placeholder and keep the card at the end.
      // Wait for execution.failed to release the run lock; otherwise a new prompt
      // can race the old failure event and the status row lands in the middle.
      state.compactionBlockedRun = true
      state.lastRealError = err
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.retryTimer = null
      stopRetryCountdown()
      hideRetryInline()
      hideError("execution")
      const pending = state.pendingBubble || lastAssistantBubble()
      if (pending?.classList.contains("thinking")) pending.closest(".msg")?.remove()
      if (typing.el?.classList?.contains("thinking")) typing.el.closest(".msg")?.remove()
      state.pendingBubble = null
      state.liveTextEl = null
      typing.el = null
      if (!liveCompactEl?.isConnected) {
        const message = String(err.message || err || "Context compaction could not continue.")
        showCompaction(/over budget/i.test(message) ? "overbudget" : "failed", {
          reason: state.compactTrigger || "auto",
          error: message,
        })
      }
      const box = $("messages")
      if (box && liveCompactEl?.isConnected && box.lastElementChild !== liveCompactEl) box.appendChild(liveCompactEl)
      scrollChat(true)
      return
    }
    setRunning(false)
    // The prompt failed before the engine appended the message to the session:
    // a retry must NOT revert an older turn (that would lose real chat history).
    if (data.persisted === false && state.lastSend) state.lastSend.persisted = false
    // A provider that rejected the request as too large can still be rescued by
    // summarizing now instead of making the user start a new session.
    if (state.autoCompact && looksLikeContextOverflow(err)) compactNow({ reason: "auto" })

    let pretty = ""
    let failed = true
    let freeModel = null
    if (isGenericInterrupt(err)) {
      // OpenCode collapses some real failures into "Step interrupted". That is
      // only a harmless stop when we know who/why stopped the run.
      const knownStop = !!(state.interruptReason || state.userStopped)
      failed = !knownStop
      pretty = knownStop ? interruptText() : "The run stopped unexpectedly (the service sent no error)."
      state.lastRealError = null
    } else if (isNoCreditError(err)) {
      const configured = new Map((providerState.list || []).map((p) => [p.id, p]))
      freeModel = (state.models || []).find((m) => {
        if (!m || !m.id || !/free/i.test(String(m.id))) return false
        if (`${m.providerID}/${m.id}` === state.selectedModel) return false
        return !configured.get(m.providerID)?.disabled
      }) || null
      pretty = freeModel
        ? `This model has no credits. Try your configured free model: ${freeModel.providerID}/${freeModel.id}`
        : "This model has no credits. Add or select a working free model in Settings → Models, or check this provider's quota."
      state.lastRealError = err
    } else {
      pretty = realErrorText(err) || "Step failed"
      state.lastRealError = err
      // If this error matches the one already shown inline on a tool card
      // (session.tool.failed), suppress the redundant run-level bubble so the
      // user sees it only once at the tool row.
      if (pretty === state.lastToolError) hideError()
    }

    const target = runEndBubble()
    if (target) {
      target.classList.remove("thinking")
      target.textContent = failed ? `⚠ ${pretty}` : `⏹ ${pretty}`
      if (freeModel) {
        const btn = document.createElement("button")
        btn.className = "save-btn quota-btn"
        btn.textContent = `Switch to ${freeModel.id}`
        btn.onclick = async () => {
          const key = `${freeModel.providerID}/${freeModel.id}`
          try {
            if (!state.activeSessionID) throw new Error("Create or open a chat before switching models.")
            const switched = await vibe.setModel({
              sessionID: state.activeSessionID,
              model: { providerID: freeModel.providerID, id: freeModel.id },
            })
            if (!switched || switched.ok === false) throw new Error(switched?.error || "Model switch failed")
            state.selectedModel = key
            try { localStorage.setItem("vibecoder.model", key) } catch {}
            $("model-label").textContent = freeModel.id
            updateUsageRing()
            renderModelList()
            btn.remove()
          } catch (e) {
            showError("Could not switch model", String(e?.message || e), { key: "model-switch" })
          }
        }
        target.appendChild(btn)
      }
    }
    if (failed) {
      // A run failure is always reported inline, where it happened: the red popup
      // covers the chat and fights with the inline retry counter. The bubble
      // already says what happened, plus a Retry button.
      const retryable = data.retryable !== false && !state.userStopped && isRetryableRunError(state.lastRealError)
      hideError("execution")
      if (!retryable) {
        hideRetryInline()
        if (target) addRetryButtonToBubble(target)
      }
      // Safety net: normally execution.failed follows within milliseconds and
      // schedules the retry. If it never arrives, retry from here instead of
      // leaving the run dead in the water.
      if (retryable) {
        setTimeout(() => {
          if (state.running || state.retryTimer || state.userStopped) return
          if (state.interruptReason) return
          if (scheduleRetry(pretty)) notifyAgent("The model did not answer — retrying", pretty)
        }, 1500)
      }
    } else {
      hideError("execution")
    }
  }
  if (type === "session.execution.succeeded") {
    if (sid !== state.activeSessionID) return
    hideError("execution")
    hideRetryInline()
    state.retryCount = 0
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    typingFlush()
    if (reasoningEl) {
      const secs = state.reasonStart ? Math.max(1, Math.round((Date.now() - state.reasonStart) / 1000)) : 0
      if (secs) reasoningEl.querySelector(".th-dur").textContent = `${secs}s`
      reasoningEl.classList.remove("open")
      reasoningEl = null
      state.reasonStart = null
    }
    setRunning(false)
    hideBranchChip()
    const target = lastAssistantBubble()
    if (target?.classList.contains("thinking")) target.textContent = ""
    if (queuedPrompts.length) setTimeout(drainQueuedPrompt, 900) // after the timeline re-render below
    // re-render the canonical timeline (opencode style groups, file cards)
    setTimeout(() => {
      if (!state.activeSessionID) return
      renderSessionHistory(state.activeSessionID)
      // The engine names a fresh session from the first prompt - without this
      // refresh the sidebar kept showing "New session" until an app restart.
      refreshSessions()
      // The turn just finished — if the window is nearly full the conversation
      // is summarized now rather than overflowing on the next prompt.
      maybeAutoCompact(1200)
      const summary = lastAnswerSummary()
      const done = !agentLooksUnfinished()
      const wasBackgroundJob = bgJob.startedAt > 0
      if (done) {
        // The whole task is finished -> tell the user, with the summary.
        clearBackgroundJob()
        notifyAgent(
          wasBackgroundJob ? "🎉 Background job finished" : "✅ Task finished",
          summary || "The agent finished the whole task.",
        )
      } else {
        // One step is done, more is open.
        notifyAgent("Agent finished a step", summary || "Continuing with the next step.")
        // ... and let the agent continue on its own if the user is away.
        if (appIsInBackground()) scheduleAutoContinue()
      }
    }, 400)
  }
  if (type === "session.execution.started") {
    if (sid !== state.activeSessionID) return
    setRunning(true)
    if (data.source === "subagent-result" && !state.subagentView) {
      state.userStopped = false
      state.interruptReason = null
      state.lastRealError = null
      const pending = addMsg("assistant", "Using the completed subagent result…", "thinking")
      state.pendingBubble = pending
      state.liveTextEl = pending
    }
  }
  if (type === "session.execution.failed" || type === "session.execution.interrupted") {
    if (sid !== state.activeSessionID) return
    if (type === "session.execution.failed" && data.persisted === false && state.lastSend) {
      state.lastSend.persisted = false
    }
    typingFlush()
    setRunning(false)
    hideBranchChip()
    if (type === "session.execution.failed" && data.source === "subagent-result") {
      const msg = realErrorText(data.error) || "The main agent could not report the completed subagent result."
      showRunFailureInline(msg, runEndBubble())
      notifyAgent("Could not report subagent result", msg)
      return
    }
    if (type === "session.execution.failed" && (state.compactionBlockedRun || isTerminalCompactionError(data.error) || (data.retryable === false && /compaction|context window|over budget/i.test(String(data.error?.message || data.error || ""))))) {
      // The checkpoint card is the sole UI for this terminal failure. Do not
      // duplicate it as an assistant bubble or start another model retry.
      state.compactionBlockedRun = false
      state.lastRealError = data.error || state.lastRealError
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.retryTimer = null
      stopRetryCountdown()
      hideRetryInline()
      hideError("execution")
      const pending = state.pendingBubble || lastAssistantBubble()
      if (pending?.classList.contains("thinking")) pending.closest(".msg")?.remove()
      state.pendingBubble = null
      state.liveTextEl = null
      if (liveCompactEl?.isConnected) {
        const box = $("messages")
        if (box && box.lastElementChild !== liveCompactEl) box.appendChild(liveCompactEl)
      } else {
        const message = String(data.error?.message || data.error || "Context compaction could not continue.")
        showCompaction(/over budget/i.test(message) ? "overbudget" : "failed", {
          reason: state.compactTrigger || "auto",
          error: message,
        })
      }
      scrollChat(true)
      return
    }
    maybeAutoCompact(1200)
    if (type === "session.execution.failed") {
      const err = data.error
      const generic = isGenericInterrupt(err)
      const knownStop = !!(state.interruptReason || state.userStopped)
      // Prefer the real error we already saw on the step event.
      const real = generic ? state.lastRealError : err
      // OpenCode sometimes ends the execution with a generic abort while the
      // provider actually failed (429 / dropped stream). Nobody stopped it, no
      // reason was published -> treat it as a failure and retry, like the
      // original OpenCode clients do.
      const unexpectedAbort = generic && !knownStop && !state.lastRealError
      if (generic && knownStop) {
        // A stop we can explain: say it, but do not raise an error.
        const target = runEndBubble()
        if (target) target.textContent = `⏹ ${interruptText()}`
        hideError("execution")
        return
      }
      const msg = unexpectedAbort
        ? "The run stopped unexpectedly (the service sent no error)."
        : real
          ? realErrorText(real) || "The agent stopped unexpectedly."
          : "The agent stopped unexpectedly."
      const target = runEndBubble()
      // Timeouts / rate limits / 5xx / unknown aborts: retry automatically and
      // keep a manual Retry available afterwards.
      if (data.retryable !== false && !state.userStopped && (isRetryableRunError(real) || unexpectedAbort) && scheduleRetry(msg)) {
        // A retry is coming: no red banner, the inline counter says it all.
        hideError("execution")
        notifyAgent("The model did not answer — retrying", msg)
      } else {
        // Retries exhausted (or the error is not retryable): show the real
        // error inline, where the run stopped. No red popup.
        hideRetryInline()
        showRunFailureInline(msg, target)
        notifyAgent("Agent stopped with an error", msg)
      }
    } else {
      // remember why the run was interrupted so the step row can say it
      const reason = data.reason || state.interruptReason || "unknown"
      state.interruptReason = reason
      const known = reason === "user" || reason === "shutdown" || reason === "superseded" || reason === "inactivity" || state.userStopped
      if (known) {
        if (reason !== "user" && !state.userStopped) {
          const msg = interruptText()
          const target = runEndBubble()
          if (target) target.textContent = `⏹ ${msg}`
          hideError("execution")
          notifyAgent("Agent interrupted", msg)
        } else {
          hideError("execution")
        }
      } else if (scheduleRetry("The run stopped unexpectedly.")) {
        // An abort nobody asked for (provider/tool failure inside OpenCode):
        // retry it like any other hiccup instead of silently ending the run.
        notifyAgent("The model did not answer — retrying", "The run stopped unexpectedly.")
      } else {
        const msg = interruptText()
        showRunFailureInline(msg)
        notifyAgent("Agent interrupted", msg)
      }
    }
  }
  // Keep the sidebar in sync with the server: a session can be created,
  // renamed, moved or deleted from anywhere (another window, a plugin, the
  // agent itself). Debounced so a burst of events costs one refresh.
  if (/^session\.(created|deleted|moved|renamed|archived|forked)$/.test(type)) scheduleSessionsRefresh()
  // The host retried a prompt that hit a transient provider/transport error.
  if (type === "host.retry") {
    const bubble = lastAssistantBubble()
    if (data?.recovered) {
      if (bubble && /retrying/i.test(bubble.textContent || "")) bubble.textContent = "Thinking..."
    } else if (!data?.failed && bubble) {
      bubble.textContent = `⟳ Provider busy — retrying ${data?.attempt ?? ""}/${data?.of ?? ""}…`
    }
  }

  /* ---- agent activity events (opencode app style) ---- */
  if (sid && sid !== state.activeSessionID) {
    // activity belongs to another session — don't paint it into this timeline
    if (type === "session.permissions") refreshPermissionRequests()
    return
  }
  if (state.thinkTimer && (type.startsWith("session.reasoning") || type.startsWith("session.tool"))) {
    clearTimeout(state.thinkTimer)
    state.thinkTimer = null
  }
  if (type === "session.tool.input.started") {
    typingFlush()
    const key = `tool:${data.id}`
    if (data.name) toolNames.set(key, data.name)
    // track it as a running job (shown in the "Running" list)
    runningJobs.set(key, { kind: "Tool", title: data.name || "tool", at: Date.now() })
    renderBgJob()
    // The question tool gets its own interactive card (form.created) instead of
    // a raw tool row.
    if (data.name !== "question") toolAct(key, data.name || "tool")
  }
  if (type === "session.tool.input.delta") {
    const key = `tool:${data.id}`
    const el = actEls.get(key)
    if (el) {
      const b = el.querySelector(".act-body")
      b.textContent = (b.textContent || "") + (data.delta ?? "")
    }
  }
  if (type === "session.tool.input.ended") {
    const key = `tool:${data.id}`
    const el = actEls.get(key)
    if (el && data.input && !el.querySelector(".act-body").textContent) {
      el.querySelector(".act-body").textContent = JSON.stringify(data.input, null, 2)
    }
  }
  if (type === "session.tool.called") {
    const key = `tool:${data.id}`
    const input = data.input ?? {}
    // this event carries no tool name — remember it from input.started
    const name = data.name || toolNames.get(key) || input.name || "tool"
    maybeShowBranchForTool(name, input)
    if (name === "question") {
      // pending form card handles this tool; make sure it is on screen
      refreshForms()
      return
    }
    toolArgs.set(key, { name, input })
    const el = toolAct(key, name, input)
    renderToolDetails(el, name, input, { metadata: data.metadata }, data.id)
    if (name === "todowrite" && Array.isArray(input?.todos)) {
      // remember the agent's plan -> tells us if work is still open
      autoCont.todos = input.todos
      // and show it in the task strip (it is saved on disk)
      todoState.items = input.todos.map((t) => ({
        content: t?.content || "",
        status: t?.status || "pending",
        priority: t?.priority || "medium",
      }))
      // a fresh plan is worth showing again, even if it was hidden before
      todoState.hidden = false
      renderTodos()
      saveTodos()
    }
    // the running job list shows the tool and what it touches
    const job = runningJobs.get(key)
    const target = toolSubtitle(name, input).replace(/\s+/g, " ").trim()
    if (job) {
      job.kind = toolRowLabel(name)
      job.title = `${toolRowLabel(name)}${target ? ": " + target : ""}`
    }
    renderBgJob()
  }
  if (type === "session.tool.success") {
    actDone(`tool:${data.id}`, true)
    runningJobs.delete(`tool:${data.id}`)
    renderBgJob()
    const el = actEls.get(`tool:${data.id}`)
    const info = toolArgs.get(`tool:${data.id}`)
    if (el && info) {
      renderToolDetails(el, info.name, info.input, {
        content: data.content,
        metadata: data.metadata,
      }, data.id)
    }
    // keep the finished tool visible in the status line until the next one
  }
  if (type === "session.tool.failed") {
    actDone(`tool:${data.id}`, false)
    runningJobs.delete(`tool:${data.id}`)
    renderBgJob()
    const el = actEls.get(`tool:${data.id}`)
    if (el && data.error) {
      // "Tool execution interrupted" is generic -> say what really happened
      const txt = isGenericInterrupt(data.error)
        ? interruptText()
        : realErrorText(data.error) || "failed"
      el.querySelector(".act-out").textContent = txt
      // remember this error so the later step.failed can suppress its duplicate bubble
      state.lastToolError = realErrorText(data.error) || String(data.error || "")
    }
  }
  if (type === "session.reasoning.started") {
    // One live thought row per continuous reasoning stream (models can emit
    // several reasoning.started events in a row — don't orphan empty rows).
    if (reasoningEl) return
    // Replace the "Thinking..." placeholder: reasoning has its own row.
    const ph = lastAssistantBubble()
    if (ph?.classList.contains("thinking")) {
      ph.closest(".msg")?.remove()
      state.liveTextEl = null
    }
    state.reasonStart = Date.now()
    reasoningEl = addThought("", 0, true) // keep thinking visible while it streams
  }
  if (type === "session.reasoning.delta" && reasoningEl) {
    const b = reasoningEl.querySelector(".th-body")
    b.textContent = (b.textContent || "") + (data.delta ?? "")
    scrollChat()
  }
  if (type === "session.reasoning.ended" && reasoningEl) {
    const secs = state.reasonStart
      ? Math.max(1, Math.round((Date.now() - state.reasonStart) / 1000))
      : 0
    if (secs) reasoningEl.querySelector(".th-dur").textContent = `${secs}s`
    reasoningEl.classList.remove("open") // collapse to a neat "Thinking Ns"
    reasoningEl = null
    state.reasonStart = null
  }
  /* Background shells (opencode-style): the bash tool's OWN row already shows the
     command, so these events only feed the running-jobs chip (Stop / Background). */
  if (type === "session.shell.started") {
    const sh = data.shell ?? {}
    if (sh.id) {
      runningJobs.set(`shell:${sh.id}`, {
        kind: "Shell",
        title: String(sh.command || "shell"),
        at: sh.started || Date.now(),
        shellId: sh.id,
        backgrounded: !!sh.background,
        cwd: sh.cwd || "",
        file: sh.file || "",
      })
      renderBgJob()
    }
  }
  if (type === "session.shell.backgrounded") {
    const sh = data.shell ?? {}
    const job = runningJobs.get(`shell:${sh.id}`)
    if (job) job.backgrounded = true
    renderBgJob()
  }
  if (type === "session.shell.ended" || type === "session.shell.completed") {
    const sh = data.shell ?? {}
    runningJobs.delete(`shell:${sh.id}`)
    renderBgJob()
  }
  if (type === "session.permissions" || type === "session.tool.called") {
    refreshPermissionRequests()
  }
  /* OpenCode provider device-login flow events */
  if (type === "opencode-auth-url") {
    const code = event.code || ""
    $("opencode-code").textContent = code || "-"
    $("opencode-device").hidden = false
    $("opencode-wait").textContent = "Waiting for authorization — finish the sign-in in your browser."
    $("opencode-st-dot").className = "st-dot checking"
    $("opencode-st-text").textContent = "Device login started — sign in in your browser"
  }
  if (type === "opencode-auth-done") {
    if (authPoll) clearInterval(authPoll)
    authPoll = null
    $("opencode-wait").textContent = "Connected — loading models…"
    // A different account can expose a different model catalog, so drop the cache.
    resetOpenCodeModelCache()
    await refreshAuthUI()
    await loadModels()
    $("opencode-wait").textContent = "Connected — models are ready."
  }
  if (type === "opencode-auth-closed") {
    if (authPoll) clearInterval(authPoll)
    authPoll = null
    if (event.error) {
      $("opencode-st-dot").className = "st-dot off"
      $("opencode-st-text").textContent = `Login failed — ${event.error}`
      showError("OpenCode login failed", event.error, { key: "auth" })
    }
    await refreshAuthUI()
  }
})

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
// Stable manual fallback. Automatic updates can be turned off, so the app must
// always expose a way for a user to download the current installer themselves.
const APP_RELEASES_URL = "https://github.com/jhfarhanyt20-coder/VibeCoder-AI/releases/latest"

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
      case "update-available": statusText = `Update available: ${fmtVersion(s.payload?.version)}`; break
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
  if (btn) { btn.disabled = true; btn.textContent = "Downloading…" }
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
    if (btn) { btn.disabled = false; btn.textContent = "Download Update" }
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
  // The manual release link must work even if the updater bridge is absent.
  const openReleaseBtn = document.getElementById("app-update-open-release")
  if (openReleaseBtn) openReleaseBtn.onclick = async () => {
    if (!vibe.openExternal) return
    try {
      const res = await vibe.openExternal({ url: APP_RELEASES_URL })
      if (res && res.ok === false) throw new Error(res.error || "Could not open the download page")
    } catch (err) {
      showError("Could not open the download page", (err && err.message) || String(err), { key: "app-update-release" })
    }
  }
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
    if (page === "mcp") loadMcp()
    if (page === "plugins") loadPlugins()
    if (page === "marketplace") loadMarketplace()
    if (page === "memory") loadMemory()
    if (page === "subagents") loadAgents()
    if (page === "browser-use") loadBrowserUse()
    if (page === "browser-use") loadBrowserUse()
    if (page === "model-settings") loadProviders()
    if (page === "skills") loadSkills()
    if (page === "usage") loadUsage()
    if (page === "app-updates") refreshAppUpdateStatus()
  }
})

/* ---------- MCP servers + plugins (real config, wired to the CLI) ---------- */
const cfgState = {
  mcp: [],
  plugins: [],
  mcpFiles: [],
  pluginFiles: [],
  builtinMcp: [],
  builtinPlugins: [],
  builtinPluginDirs: [],
}

function cfgDir() {
  // projectDir is declared later in the file; read it lazily at call time.
  try {
    return typeof projectDir !== "undefined" ? projectDir : null
  } catch {
    return null
  }
}

function setCfgBusy(which, busy) {
  const btn = $(which === "mcp" ? "mcp-refresh" : "plugin-refresh")
  if (btn) {
    btn.disabled = busy
    btn.textContent = busy ? "… Loading" : "⟳ Refresh"
  }
}

function renderCfgFiles(which) {
  const box = $(which === "mcp" ? "mcp-files" : "plugin-files")
  if (!box) return
  const files = which === "mcp" ? cfgState.mcpFiles : cfgState.pluginFiles
  box.innerHTML = ""
  if (!files || !files.length) {
    box.textContent = "No OpenCode config files found yet — adding an item creates one."
    return
  }
  for (const f of files) {
    const row = document.createElement("div")
    row.className = "cfg-file" + (f.ok ? "" : " bad")
    row.textContent = `${f.scope}: ${f.file}${f.ok ? "" : "  (invalid JSON)"}`
    box.appendChild(row)
  }
  const note = document.createElement("div")
  note.className = "cfg-note"
  note.textContent = "Changes are written through the OpenCode CLI; restart the app if a running session does not pick them up."
  box.appendChild(note)
}

function cfgBadge(scope) {
  const b = document.createElement("span")
  b.className = "cfg-badge " + (scope === "project" ? "project" : "global")
  b.textContent = scope === "project" ? "project" : "global"
  return b
}

function renderMcp() {
  const list = $("mcp-list")
  if (!list) return
  list.innerHTML = ""
  $("mcp-count").textContent = String(cfgState.mcp.length)
  if (!cfgState.mcp.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No MCP servers configured."
    list.appendChild(e)
    return
  }
  for (const s of cfgState.mcp) {
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = s.name
    const meta = document.createElement("div")
    meta.className = "cfg-meta"
    meta.title = s.type === "remote"
      ? (s.url || "")
      : (s.command || []).join(" ")
    meta.textContent = s.type === "remote"
      ? `remote · ${s.url || "no url"}`
      : `local · ${(s.command || []).join(" ") || "no command"}`
    main.append(name, meta)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove MCP server "${s.name}" from the ${s.scope} config?`))) return
      del.disabled = true
      const res = await vibe.mcpRemove({ name: s.name, directory: cfgDir(), global: s.scope === "global" })
      if (!res.ok) {
        del.disabled = false
        alert("Remove failed: " + (res.error || "unknown"))
        return
      }
      await loadMcp()
    }
    actions.appendChild(del)

    row.append(main, cfgBadge(s.scope), actions)
    list.appendChild(row)
  }
}

function renderPlugins() {
  const list = $("plugin-list")
  if (!list) return
  list.innerHTML = ""
  $("plugin-count").textContent = String(cfgState.plugins.length)
  if (!cfgState.plugins.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No plugins configured."
    list.appendChild(e)
    return
  }
  for (const p of cfgState.plugins) {
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = p.spec
    const meta = document.createElement("div")
    meta.className = "cfg-meta"
    meta.textContent = p.options ? "with options" : "package"
    main.append(name, meta)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove plugin "${p.spec}"?`))) return
      del.disabled = true
      const res = await vibe.pluginRemove({ spec: p.spec, directory: cfgDir() })
      if (!res.ok) {
        del.disabled = false
        alert("Remove failed: " + (res.error || "unknown"))
        return
      }
      await loadPlugins()
    }
    actions.appendChild(del)

    row.append(main, cfgBadge(p.scope), actions)
    list.appendChild(row)
  }
}

async function loadMcp() {
  setCfgBusy("mcp", true)
  try {
    const res = await vibe.mcpList({ directory: cfgDir() })
    if (!res.ok) throw new Error(res.error || "Could not read the OpenCode config")
    cfgState.mcp = Array.isArray(res.data?.mcp) ? res.data.mcp : []
    cfgState.mcpFiles = Array.isArray(res.data?.files) ? res.data.files : []
    renderMcp()
    renderCfgFiles("mcp")
    await loadBuiltins()
  } catch (e) {
    $("mcp-list").innerHTML = ""
    const err = document.createElement("div")
    err.className = "cfg-empty"
    err.textContent = "Failed to load: " + String(e.message || e)
    $("mcp-list").appendChild(err)
  } finally {
    setCfgBusy("mcp", false)
  }
}

async function loadPlugins() {
  setCfgBusy("plugins", true)
  try {
    const res = await vibe.pluginList({ directory: cfgDir() })
    if (!res.ok) throw new Error(res.error || "Could not read the OpenCode config")
    cfgState.plugins = Array.isArray(res.data?.plugins) ? res.data.plugins : []
    cfgState.pluginFiles = Array.isArray(res.data?.files) ? res.data.files : []
    renderPlugins()
    renderCfgFiles("plugins")
    await loadBuiltins()
  } catch (e) {
    $("plugin-list").innerHTML = ""
    const err = document.createElement("div")
    err.className = "cfg-empty"
    err.textContent = "Failed to load: " + String(e.message || e)
    $("plugin-list").appendChild(err)
  } finally {
    setCfgBusy("plugins", false)
  }
}

/* ---------- built-in MCP servers + local plugin files ---------- */
function cfgTagRow(entry) {
  const wrap = document.createElement("div")
  wrap.className = "cfg-tags"
  for (const t of entry.tags || []) {
    const b = document.createElement("span")
    b.className = "cfg-tag"
    b.textContent = t
    wrap.appendChild(b)
  }
  if (entry.auth === "oauth") {
    const b = document.createElement("span")
    b.className = "cfg-tag auth"
    b.textContent = "oauth"
    wrap.appendChild(b)
  }
  return wrap
}

function renderBuiltinMcp() {
  const list = $("builtin-mcp-list")
  if (!list) return
  list.innerHTML = ""
  if (!cfgState.builtinMcp.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "Built-in catalog is empty."
    list.appendChild(e)
    return
  }

  for (const s of cfgState.builtinMcp) {
    const row = document.createElement("div")
    row.className = "cfg-item cfg-builtin"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = s.title
    const meta = document.createElement("div")
    meta.className = "cfg-meta cfg-wrap"
    meta.textContent = s.description
    const detail = document.createElement("div")
    detail.className = "cfg-meta mono"
    detail.textContent = s.type === "remote" ? s.url : (s.command || []).join(" ")
    main.append(name, meta, detail, cfgTagRow(s))

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const btn = document.createElement("button")
    btn.className = s.installed ? "" : "add"
    btn.textContent = s.installed ? "Added ✓" : "Add"
    btn.disabled = !!s.installed
    btn.onclick = async () => {
      btn.disabled = true
      btn.textContent = "Adding…"
      const res = await vibe.mcpAdd({
        name: s.name,
        type: s.type,
        url: s.type === "remote" ? s.url : undefined,
        command: s.type === "local" ? s.command : undefined,
        global: !!$("mcp-global")?.checked || !cfgDir(),
        directory: cfgDir(),
      })
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = "Add"
        alert("Add failed: " + (res.error || "unknown"))
        return
      }
      await loadMcp()
    }
    actions.appendChild(btn)

    row.append(main, actions)
    list.appendChild(row)
  }
}

function renderBuiltinPlugins() {
  const list = $("builtin-plugin-list")
  if (!list) return
  list.innerHTML = ""
  if (!cfgState.builtinPlugins.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No built-in plugins bundled with this build."
    list.appendChild(e)
    return
  }

  for (const p of cfgState.builtinPlugins) {
    const row = document.createElement("div")
    row.className = "cfg-item cfg-builtin"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = p.title
    const meta = document.createElement("div")
    meta.className = "cfg-meta cfg-wrap"
    meta.textContent = p.description
    const detail = document.createElement("div")
    detail.className = "cfg-meta mono"
    detail.textContent = p.installed
      ? `${p.path}`
      : "not installed"
    main.append(name, meta, detail, cfgTagRow(p))

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const btn = document.createElement("button")
    btn.className = p.installed ? "del" : "add"
    btn.textContent = p.installed ? "Remove" : "Install"
    btn.onclick = async () => {
      if (p.installed && !(await showConfirm(`Remove built-in plugin "${p.title}"?`))) return
      btn.disabled = true
      btn.textContent = p.installed ? "Removing…" : "Installing…"
      const res = p.installed
        ? await vibe.removeBuiltinPlugin({ id: p.id, directory: cfgDir(), global: p.scope === "global" })
        : await vibe.installBuiltinPlugin({
            id: p.id,
            directory: cfgDir(),
            global: !!$("builtin-plugin-global")?.checked || !cfgDir(),
          })
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = p.installed ? "Remove" : "Install"
        alert((p.installed ? "Remove" : "Install") + " failed: " + (res.error || "unknown"))
        return
      }
      await loadPlugins()
    }
    actions.appendChild(btn)

    if (p.installed && p.scope) row.append(main, cfgBadge(p.scope), actions)
    else row.append(main, actions)
    list.appendChild(row)
  }
}

async function loadBuiltins() {
  if (!vibe.builtins) return
  const res = await vibe.builtins({ directory: cfgDir() })
  if (!res || !res.ok) return
  cfgState.builtinMcp = Array.isArray(res.data?.mcp) ? res.data.mcp : []
  cfgState.builtinPlugins = Array.isArray(res.data?.plugins) ? res.data.plugins : []
  cfgState.builtinPluginDirs = Array.isArray(res.data?.pluginDirs) ? res.data.pluginDirs : []
  renderBuiltinMcp()
  renderBuiltinPlugins()
}

/* ---------- marketplace (MCP + plugins + skills) ---------- */
const marketState = { items: [], kind: "all", query: "", counts: {}, registries: [], registryStatus: [] }

function marketKindLabel(kind) {
  if (kind === "mcp") return "MCP"
  if (kind === "plugin") return "Plugin"
  return "Skill"
}

function marketMatches(item) {
  if (marketState.kind !== "all" && item.kind !== marketState.kind) return false
  const q = marketState.query.trim().toLowerCase()
  if (!q) return true
  return [item.id, item.title, item.description, ...(item.tags || [])]
    .join(" ")
    .toLowerCase()
    .includes(q)
}

function renderMarket() {
  const grid = $("mkt-grid")
  if (!grid) return
  grid.innerHTML = ""

  const items = marketState.items.filter(marketMatches)
  if (!items.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = marketState.query
      ? `No match for “${marketState.query}”.`
      : "Nothing here yet."
    grid.appendChild(e)
    return
  }

  for (const item of items) {
    const card = document.createElement("div")
    card.className = "mkt-card" + (item.installed ? " installed" : "")

    const head = document.createElement("div")
    head.className = "mkt-head"
    const title = document.createElement("div")
    title.className = "mkt-title"
    title.textContent = item.title
    const kind = document.createElement("span")
    kind.className = "mkt-kind " + item.kind
    kind.textContent = marketKindLabel(item.kind)
    head.append(title, kind)

    const desc = document.createElement("div")
    desc.className = "mkt-desc"
    desc.textContent = item.description

    const tags = document.createElement("div")
    tags.className = "cfg-tags"
    const free = document.createElement("span")
    free.className = "cfg-tag free"
    free.textContent = "free"
    tags.appendChild(free)
    if (item.custom) {
      const custom = document.createElement("span")
      custom.className = "cfg-tag custom"
      custom.textContent = item.registry ? item.registry.name : "custom"
      custom.title = item.registry ? item.registry.url : ""
      tags.appendChild(custom)
    }
    for (const t of item.tags || []) {
      const b = document.createElement("span")
      b.className = "cfg-tag"
      b.textContent = t
      tags.appendChild(b)
    }

    const foot = document.createElement("div")
    foot.className = "mkt-foot"
    const state = document.createElement("span")
    state.className = "mkt-state" + (item.installed ? " on" : "")
    state.textContent = item.installed
      ? "Installed" + (item.scope ? " · " + item.scope : "")
      : "Not installed"

    const btn = document.createElement("button")
    btn.className = "mkt-btn " + (item.installed ? "del" : "add")
    btn.textContent = item.installed ? "Remove" : "Install"
    btn.onclick = () => marketAction(item, btn)

    foot.append(state, btn)
    card.append(head, desc, tags, foot)
    grid.appendChild(card)
  }
}

async function marketAction(item, btn) {
  const dir = cfgDir()
  const useGlobal = !!$("mkt-global")?.checked || !dir

  if (item.installed && !(await showConfirm(`Remove “${item.title}”?`))) return

  btn.disabled = true
  btn.textContent = item.installed ? "Removing…" : "Installing…"

  let res
  if (item.kind === "mcp") {
    res = item.installed
      ? await vibe.mcpRemove({ name: item.name, directory: dir, global: false })
      : await vibe.mcpAdd({
          name: item.name,
          type: item.type,
          url: item.url,
          command: item.command,
          env: item.env,
          headers: item.headers,
          global: useGlobal,
          directory: dir,
        })
  } else if (item.kind === "plugin") {
    if (item.custom) {
      // Registry plugins are plain npm/git packages.
      res = item.installed
        ? await vibe.pluginRemove({ spec: item.spec, directory: dir })
        : await vibe.pluginAdd({ spec: item.spec, directory: dir })
    } else {
      res = item.installed
        ? await vibe.removeBuiltinPlugin({ id: item.id, directory: dir, global: item.scope === "global" })
        : await vibe.installBuiltinPlugin({ id: item.id, directory: dir, global: useGlobal })
    }
  } else if (item.custom) {
    // Registry skills ship their markdown inline.
    res = item.installed
      ? await vibe.removeCustomSkill({ id: item.id, directory: dir, global: item.scope === "global" })
      : await vibe.installCustomSkill({
          id: item.id,
          title: item.title,
          description: item.description,
          content: item.content,
          directory: dir,
          global: useGlobal,
        })
  } else {
    res = item.installed
      ? await vibe.removeSkill({ id: item.id, directory: dir, global: item.scope === "global" })
      : await vibe.installSkill({ id: item.id, directory: dir, global: useGlobal })
  }

  if (!res || !res.ok) {
    btn.disabled = false
    btn.textContent = item.installed ? "Remove" : "Install"
    alert((item.installed ? "Remove" : "Install") + " failed: " + ((res && res.error) || "unknown"))
    return
  }
  await loadMarketplace()
}

/* ---------- custom marketplaces (registries) ---------- */
function renderRegistries() {
  const list = $("mkt-reg-list")
  if (!list) return
  list.innerHTML = ""

  const registries = marketState.registries || []
  const status = marketState.registryStatus || []
  const count = $("mkt-reg-count")
  if (count) count.textContent = String(registries.length)

  if (!registries.length) {
    const empty = document.createElement("div")
    empty.className = "cfg-empty"
    empty.textContent = "No custom marketplace yet. Add a registry URL above."
    list.appendChild(empty)
    return
  }

  for (const reg of registries) {
    const st = status.find((s) => s.id === reg.id)
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"

    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = reg.name || reg.url

    const url = document.createElement("div")
    url.className = "cfg-meta mono cfg-wrap"
    url.textContent = reg.url

    const note = document.createElement("div")
    note.className = "cfg-note"
    if (!st) note.textContent = "Not loaded yet."
    else if (st.ok)
      note.textContent = `${st.count} item${st.count === 1 ? "" : "s"}${st.cached ? " (cached)" : ""}`
    else note.textContent = `Could not load: ${st.error}${st.cached ? " — showing the last cached copy" : ""}`

    main.append(name, url, note)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "mkt-btn del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove the marketplace “${reg.name || reg.url}”?`))) return
      const res = await vibe.registryRemove({ id: reg.id })
      if (!res || !res.ok) {
        alert("Remove failed: " + ((res && res.error) || "unknown"))
        return
      }
      await loadMarketplace()
    }
    actions.appendChild(del)

    row.append(main, actions)
    list.appendChild(row)
  }
}

if ($("mkt-reg-add")) {
  $("mkt-reg-add").onclick = async () => {
    const urlInput = $("mkt-reg-url")
    const nameInput = $("mkt-reg-name")
    const url = String(urlInput?.value || "").trim()
    if (!url) {
      alert("Enter the registry URL first.")
      return
    }
    const btn = $("mkt-reg-add")
    btn.disabled = true
    btn.textContent = "Adding…"
    try {
      const res = await vibe.registryAdd({ name: String(nameInput?.value || "").trim(), url })
      if (!res || !res.ok) {
        alert("Could not add the marketplace: " + ((res && res.error) || "unknown"))
        return
      }
      if (urlInput) urlInput.value = ""
      if (nameInput) nameInput.value = ""
      await loadMarketplace(true)
    } finally {
      btn.disabled = false
      btn.textContent = "Add registry"
    }
  }
}

async function loadMarketplace(refresh = false) {
  const btn = $("mkt-refresh")
  if (btn) {
    btn.disabled = true
    btn.textContent = "… Loading"
  }
  try {
    const res = await vibe.marketplace({ directory: cfgDir(), kind: "all", refresh: !!refresh })
    if (!res.ok) throw new Error(res.error || "Could not load the marketplace")
    marketState.items = Array.isArray(res.data?.items) ? res.data.items : []
    marketState.counts = res.data?.counts || {}
    marketState.registries = Array.isArray(res.data?.registries) ? res.data.registries : []
    marketState.registryStatus = Array.isArray(res.data?.registryStatus) ? res.data.registryStatus : []

    for (const k of ["all", "mcp", "plugin", "skill"]) {
      const el = $("mkt-count-" + k)
      if (el) el.textContent = String(marketState.counts[k] ?? 0)
    }

    renderMarket()
    renderRegistries()

    const files = $("mkt-files")
    if (files) {
      files.innerHTML = ""
      const note = document.createElement("div")
      note.className = "cfg-note"
      const installed = marketState.counts.installed ?? 0
      note.textContent = `${installed} of ${marketState.counts.all ?? 0} installed. Project items go to .opencode/, global items to the OpenCode config folder.`
      files.appendChild(note)
    }
  } catch (e) {
    const grid = $("mkt-grid")
    if (grid) {
      grid.innerHTML = ""
      const err = document.createElement("div")
      err.className = "cfg-empty"
      err.textContent = "Failed to load: " + String(e.message || e)
      grid.appendChild(err)
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = "⟳ Refresh"
    }
  }
}

if ($("mkt-refresh")) $("mkt-refresh").onclick = () => loadMarketplace(true)
if ($("mkt-search")) {
  $("mkt-search").oninput = () => {
    marketState.query = $("mkt-search").value
    renderMarket()
  }
}
if ($("mkt-chips")) {
  $("mkt-chips").querySelectorAll(".mkt-chip").forEach((chip) => {
    chip.onclick = () => {
      marketState.kind = chip.dataset.kind || "all"
      $("mkt-chips")
        .querySelectorAll(".mkt-chip")
        .forEach((c) => c.classList.toggle("active", c === chip))
      renderMarket()
    }
  })
}

/* ---------- installed skills page ---------- */
async function loadSkills() {
  const btn = $("skills-refresh")
  if (btn) {
    btn.disabled = true
    btn.textContent = "… Loading"
  }
  try {
    const res = await vibe.marketplace({ directory: cfgDir(), kind: "skill" })
    if (!res.ok) throw new Error(res.error || "Could not load skills")

    const items = (res.data?.items || []).filter((i) => i.installed)
    const list = $("skills-list")
    list.innerHTML = ""
    $("skills-count").textContent = String(items.length)

    if (!items.length) {
      const e = document.createElement("div")
      e.className = "cfg-empty"
      e.textContent = "No skills installed yet — open the Marketplace to add one."
      list.appendChild(e)
    } else {
      for (const item of items) {
        const row = document.createElement("div")
        row.className = "cfg-item"

        const main = document.createElement("div")
        main.className = "cfg-main"
        const name = document.createElement("div")
        name.className = "cfg-name"
        name.textContent = item.title
        const meta = document.createElement("div")
        meta.className = "cfg-meta cfg-wrap"
        meta.textContent = item.description
        const path = document.createElement("div")
        path.className = "cfg-meta mono"
        path.textContent = item.path || ""
        main.append(name, meta, path)

        const actions = document.createElement("div")
        actions.className = "cfg-actions"
        const del = document.createElement("button")
        del.className = "del"
        del.textContent = "Remove"
        del.onclick = async () => {
          if (!(await showConfirm(`Remove skill "${item.title}"?`))) return
          del.disabled = true
          const r = await vibe.removeSkill({
            id: item.id,
            directory: cfgDir(),
            global: item.scope === "global",
          })
          if (!r.ok) {
            del.disabled = false
            alert("Remove failed: " + (r.error || "unknown"))
            return
          }
          await loadSkills()
        }
        actions.appendChild(del)

        row.append(main, cfgBadge(item.scope), actions)
        list.appendChild(row)
      }
    }

    const files = $("skills-files")
    if (files) {
      files.innerHTML = ""
      const note = document.createElement("div")
      note.className = "cfg-note"
      note.textContent =
        "Skills are Markdown files with frontmatter (name, description). OpenCode reloads them automatically."
      files.appendChild(note)
    }
  } catch (e) {
    const list = $("skills-list")
    if (list) {
      list.innerHTML = ""
      const err = document.createElement("div")
      err.className = "cfg-empty"
      err.textContent = "Failed to load: " + String(e.message || e)
      list.appendChild(err)
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = "⟳ Refresh"
    }
  }
}

if ($("skills-refresh")) $("skills-refresh").onclick = () => loadSkills()
if ($("skills-github-import")) {
  $("skills-github-import").onclick = async () => {
    const btn = $("skills-github-import")
    const input = $("skills-github-source")
    const status = $("skills-github-status")
    const source = String(input?.value || "").trim()
    if (!source) {
      status.textContent = "Enter owner/repo or a public GitHub repository/folder URL."
      input?.focus()
      return
    }
    const global = !!$("skills-github-global")?.checked
    const target = global ? "the global OpenCode skills directory" : `the current project (${cfgDir()})`
    const approved = await showConfirm(
      `Import Agent Skills from ${source} into ${target}?\n\nThe SKILL.md instructions are untrusted project content. They will not run automatically; the agent will load a skill only when relevant. Continue only if you trust this repository.`
    )
    if (!approved) return
    btn.disabled = true
    btn.textContent = "Importing…"
    status.textContent = "Downloading and validating public GitHub skill files…"
    status.classList.remove("cfg-file", "bad")
    try {
      const result = await vibe.importGitHubSkills({ source, global, directory: cfgDir() })
      if (!result || result.ok === false) throw new Error(result?.error || "Import failed")
      const data = result.data || result
      const installed = Number(data.count) || (Array.isArray(data.installed) ? data.installed.length : 0)
      status.textContent = `Imported ${installed} skill${installed === 1 ? "" : "s"} from ${data.source || source}. Refreshing discovered skills…`
      input.value = ""
      await loadSkills()
    } catch (error) {
      status.textContent = `Import failed: ${String(error?.message || error)}`
      status.classList.add("cfg-file", "bad")
    } finally {
      btn.disabled = false
      btn.textContent = "Import"
    }
  }
}
if ($("skills-open-market")) {
  $("skills-open-market").onclick = () => {
    const nav = document.querySelector('.settings-nav .nav-item[data-page="marketplace"]')
    if (nav) nav.click()
  }
}

function parseKeyValues(text) {
  const out = {}
  for (const part of String(text || "").split(/[,\n]/)) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

if ($("mcp-type")) {
  $("mcp-type").onchange = () => {
    const remote = $("mcp-type").value === "remote"
    $("mcp-local-row").hidden = remote
    $("mcp-remote-row").hidden = !remote
    $("mcp-add-hint").textContent = remote
      ? "Remote servers connect over HTTP(S). Headers are optional (KEY=value, comma separated)."
      : "Local servers run a command (stdio). Environment variables are optional (KEY=value, comma separated)."
  }
}
if ($("mcp-refresh")) $("mcp-refresh").onclick = () => loadMcp()
if ($("plugin-refresh")) $("plugin-refresh").onclick = () => loadPlugins()

if ($("mcp-add-btn")) {
  $("mcp-add-btn").onclick = async () => {
    const name = $("mcp-name").value.trim()
    const type = $("mcp-type").value
    const global = $("mcp-global").checked
    const pairs = parseKeyValues($("mcp-env").value)
    if (!name) return alert("Enter a server name")
    if (type === "remote" && !$("mcp-url").value.trim()) return alert("Enter the server URL")
    if (type === "local" && !$("mcp-command").value.trim()) return alert("Enter the command to run")
    const btn = $("mcp-add-btn")
    btn.disabled = true
    btn.textContent = "Adding…"
    try {
      const res = await vibe.mcpAdd({
        name,
        type,
        url: $("mcp-url").value.trim(),
        command: $("mcp-command").value.trim(),
        env: type === "local" ? pairs : undefined,
        headers: type === "remote" ? pairs : undefined,
        global,
        directory: cfgDir(),
      })
      if (!res.ok) throw new Error(res.error || "mcp add failed")
      $("mcp-name").value = ""
      $("mcp-command").value = ""
      $("mcp-url").value = ""
      $("mcp-env").value = ""
      await loadMcp()
    } catch (e) {
      alert("Add failed: " + String(e.message || e))
    } finally {
      btn.disabled = false
      btn.textContent = "Add server"
    }
  }
}

if ($("plugin-add-btn")) {
  $("plugin-add-btn").onclick = async () => {
    const spec = $("plugin-add-input").value.trim()
    if (!spec) return alert("Enter a plugin package or Git specifier")
    const btn = $("plugin-add-btn")
    btn.disabled = true
    btn.textContent = "Installing…"
    try {
      const res = await vibe.pluginAdd({ spec, directory: cfgDir() })
      if (!res.ok) throw new Error(res.error || "plugin add failed")
      $("plugin-add-input").value = ""
      await loadPlugins()
    } catch (e) {
      alert("Add failed: " + String(e.message || e))
    } finally {
      btn.disabled = false
      btn.textContent = "Add"
    }
  }
}

// "+ Add provider" / Refresh on the Model settings page
document.querySelector(".add-provider")?.addEventListener("click", startNewProvider)
document.querySelector(".model-head .icon-btn.square")?.addEventListener("click", async (event) => {
  const btn = event.currentTarget
  if (btn) { btn.disabled = true; btn.textContent = "…" }
  try {
    await refreshProviderStateLive()
  } catch (error) {
    showError("Could not refresh provider profiles", String(error?.message || error), { key: "providers-refresh" })
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⟳" }
  }
})

/* ---------- model picker (searchable) ---------- */
state.models = []
state.selectedModel = null
state.modelMenuOpen = false
let modelLoadGeneration = 0
let providerLoadGeneration = 0
let providerRefreshGeneration = 0

function modelDisplayLabel(key) {
  const row = (state.models || []).find((model) => `${model.providerID}/${model.id}` === key)
  if (!row) return "Select model"
  const provider = (providerState.list || []).find((item) => item.id === row.providerID)
  const modelName = row.name || row.id
  return provider?.name ? `${provider.name} · ${modelName}` : modelName
}

function applyProviderCatalog(data) {
  // Context sizes may have changed in Model settings: re-read them for the ring.
  ctxLimitsStale = true // keep showing the old numbers until the fresh ones arrive (no flicker)
  setTimeout(() => { try { loadCtxLimits() } catch {} }, 0)
  if (!data || typeof data !== "object") return
  providerState.list = Array.isArray(data.custom) ? data.custom : []
  providerState.formats = Array.isArray(data.formats) ? data.formats : []
  state.models = Array.isArray(data.models) ? data.models : []
  state.providerSource = data.source || null

  const storageHint = $("pf-storage-hint")
  if (storageHint && data.source) {
    storageHint.textContent = `Profiles: ${data.source.profilesFile || "local profiles.json"} · API keys: ${data.source.authFile || "local auth.json"}. Provider changes are read from these files; secrets are never included in refresh events.`
  }

  // Keep a cached model only when it still exists in the authoritative catalog.
  let cached = null
  try { cached = localStorage.getItem("vibecoder.model") || null } catch {}
  const valid = (key) => !!key && state.models.some((m) => `${m.providerID}/${m.id}` === key)
  const serverSelection = valid(data.selectedModel) ? data.selectedModel : null
  // The server's persisted choice is canonical. Local selection is retained
  // only while that exact provider/model pair exists in the fresh disk catalog.
  const previousSelection = valid(state.selectedModel) ? state.selectedModel : null
  const cachedSelection = valid(cached) ? cached : null
  state.selectedModel = serverSelection || previousSelection || cachedSelection || null
  if (cached && !valid(cached)) {
    try { localStorage.removeItem("vibecoder.model") } catch {}
  }
  if (state.selectedModel) {
    try { localStorage.setItem("vibecoder.model", state.selectedModel) } catch {}
  } else {
    try { localStorage.removeItem("vibecoder.model") } catch {}
  }
  const label = $("model-label")
  if (label) label.textContent = state.selectedModel ? modelDisplayLabel(state.selectedModel) : "Select model"
  renderCompactionModels()
}

async function loadModels() {
  const generation = ++modelLoadGeneration
  let res

  if (typeof vibe.providerCatalog === "function") {
    res = await vibe.providerCatalog()
    if (generation !== modelLoadGeneration) return state.models
    if (!res || res.ok === false) {
      showError("Could not refresh providers and models", res?.error || "Unknown error", { key: "models" })
      return state.models
    }
    applyProviderCatalog(res.data || {})
  } else {
    // Compatibility with older preload bundles.
    try { await loadProviders({ silent: true }) } catch {}
    res = await vibe.listAllModels()
    if (generation !== modelLoadGeneration) return state.models
    if (res && res.ok === false) {
      showError("Could not load the model list", res.error || "Unknown error", { key: "models" })
      return state.models
    }
    const list = Array.isArray(res?.data)
      ? res.data
      : (Array.isArray(res?.data?.models)
          ? res.data.models
          : (Array.isArray(res?.models) ? res.models : []))
    state.models = list
    if (!state.selectedModel) {
      try { state.selectedModel = localStorage.getItem("vibecoder.model") || null } catch {}
    }
    if (state.selectedModel && !state.models.some((m) => `${m.providerID}/${m.id}` === state.selectedModel)) {
      state.selectedModel = null
      try { localStorage.removeItem("vibecoder.model") } catch {}
    }
    const label = $("model-label")
    if (label) label.textContent = state.selectedModel ? modelDisplayLabel(state.selectedModel) : "Select model"
  }

  hideError("models")
  updateUsageRing()
  loadCtxLimits()
  if (state.modelMenuOpen) renderModelList(modelSearch?.value || "")
  renderCompactionModels()
  return state.models
}

function renderModelList(filter = "") {
  const box = document.getElementById("model-results")
  box.innerHTML = ""
  const q = filter.trim().toLowerCase()
  // The custom providers the app knows (id -> name, on/off state, models).
  const custom = new Map((providerState.list || []).map((p) => [p.id, p]))
  const hits = state.models.filter((m) => {
    const cp = custom.get(m.providerID)
    if (cp) {
      // A custom provider that is switched off offers nothing. Its current model
      // IDs are authoritative: never show stale rows deleted from profiles.json.
      if (cp.disabled) return false
      const added = (cp.models || []).some((x) => String(x.id) === String(m.id))
      if (!added) return false
    } else if (!m.isBuiltin) {
      // A row without a current custom provider record is stale. Do not let a
      // deleted provider linger just because an older renderer snapshot survived.
      return false
    } else if (!m.hasKey) {
      // Keep built-ins out of the picker until credentials/no-auth configuration
      // exists; configured custom providers are listed first by the backend.
      return false
    }
    if (!q) return true
    return (
      m.id.toLowerCase().includes(q) ||
      m.providerID.toLowerCase().includes(q) ||
      `${m.providerID}/${m.id}`.toLowerCase().includes(q) ||
      // the display name of a custom provider is searchable too
      (custom.get(m.providerID)?.name || "").toLowerCase().includes(q)
    )
  })
  if (state.models.length === 0) {
    const d = document.createElement("div")
    d.className = "mr-loading"
    d.textContent = "Login korle model ekhane ashbe"
    box.appendChild(d)
    return
  }
  if (hits.length === 0) {
    const d = document.createElement("div")
    d.className = "mr-none"
    d.textContent = `Kichu pa'i nai — "${filter}"`
    box.appendChild(d)
    return
  }
  const groups = new Map()
  for (const m of hits) {
    if (!groups.has(m.providerID)) groups.set(m.providerID, [])
    groups.get(m.providerID).push(m)
  }
  for (const [providerID, models] of groups) {
    const g = document.createElement("div")
    g.className = "mr-group"
    // show the display name of a custom provider (e.g. "openrouter2")
    const known = custom.get(providerID)
    g.textContent = known?.name ? `${known.name} · ${providerID}` : providerID
    box.appendChild(g)
    for (const m of models) {
      const b = document.createElement("button")
      b.className = "mr-item"
      const key = `${m.providerID}/${m.id}`
      b.dataset.model = key
      if (state.selectedModel === key) b.classList.add("selected")
      b.textContent = m.id
      if (key.toLowerCase().includes("free")) {
        const badge = document.createElement("span")
        badge.className = "mr-badge"
        badge.textContent = "FREE"
        b.appendChild(badge)
      }
      if (m.image) {
        // the model can see images: attaching a picture will actually reach it
        const badge = document.createElement("span")
        badge.className = "mr-badge"
        badge.textContent = "👁 IMAGES"
        b.appendChild(badge)
      }
      b.onclick = async () => {
        const previous = state.selectedModel
        state.selectedModel = key
        $("model-label").textContent = modelDisplayLabel(key)
        updateUsageRing()
        try {
          localStorage.setItem("vibecoder.model", key)
        } catch {}
        closeAllMenus()
        renderModelList()
        // Don't leave the UI pointing at a model that the session failed to adopt.
        if (state.activeSessionID) {
          try {
            const switched = await vibe.setModel({
              sessionID: state.activeSessionID,
              model: { providerID: m.providerID, id: m.id },
            })
            if (!switched || switched.ok === false) throw new Error(switched?.error || "Model switch failed")
            const canonical = switched.data?.selectedModel
            if (canonical && state.models.some((item) => `${item.providerID}/${item.id}` === canonical)) {
              state.selectedModel = canonical
              try { localStorage.setItem("vibecoder.model", canonical) } catch {}
              $("model-label").textContent = modelDisplayLabel(canonical)
            }
            hideError("model-switch")
          } catch (err) {
            state.selectedModel = previous
            try {
              if (previous) localStorage.setItem("vibecoder.model", previous)
              else localStorage.removeItem("vibecoder.model")
            } catch {}
            $("model-label").textContent = previous ? previous.split("/").slice(1).join("/") : "Select model"
            updateUsageRing()
            renderModelList()
            showError("Could not switch model", String(err?.message || err), { key: "model-switch" })
          }
        }
      }
      box.appendChild(b)
    }
  }
}

const modelMenu = document.getElementById("model-menu")
const modelSearch = document.getElementById("model-search")

$("btn-model").onclick = async (e) => {
  e.stopPropagation()
  const wasHidden = modelMenu.hidden
  closeAllMenus()
  if (wasHidden) {
    modelMenu.hidden = false
    // Always refresh: a provider that was just added (or switched off) has to
    // show up (or disappear) right away.
    await loadModels()
    if (typeof vibe.providerCatalog !== "function") await loadProviders({ silent: true })
    renderModelList(modelSearch.value)
    modelSearch.focus()
  }
}

modelSearch.oninput = () => renderModelList(modelSearch.value)
$("btn-model-refresh")?.addEventListener("click", async (e) => {
  e.stopPropagation()
  const btn = $("btn-model-refresh")
  btn.textContent = "…"
  try {
    await loadModels()
    if (typeof vibe.providerCatalog !== "function") await loadProviders({ silent: true })
    renderModelList(modelSearch.value)
  } finally {
    btn.textContent = "⟳"
  }
})

/* ---------- workspaces (projects) ---------- */
const WS_KEY = "vibecoder.workspaces"
const ACTIVE_PROJECT_KEY = "vibecoder.activeProject"
let workspaces = []

function loadWorkspaces() {
  try {
    workspaces = JSON.parse(localStorage.getItem(WS_KEY) || "[]")
  } catch {
    workspaces = []
  }
  // Drop cached branch names: the branch is always verified live now, and a
  // stale value (e.g. "master") used to show up for folders that are not repos.
  let changed = false
  for (const w of workspaces) {
    if (w && w.branch) {
      delete w.branch
      changed = true
    }
  }
  if (changed) {
    try { localStorage.setItem(WS_KEY, JSON.stringify(workspaces)) } catch {}
  }
  $("chip-branch").hidden = true
  renderWorkspaces()
}

function saveWorkspaces() {
  localStorage.setItem(WS_KEY, JSON.stringify(workspaces))
}

/** Write/refresh the agent + AGENTS.md rules for a project (temp cleanup, verify). */
function ensureProjectAgent(dir) {
  if (!dir || !vibe.ensureAgent) return
  const model = (() => {
    try {
      return localStorage.getItem("vibecoder.model") || ""
    } catch {
      return ""
    }
  })()
  Promise.resolve(vibe.ensureAgent({ directory: dir, memory: memoryEnabled(), model })).catch(() => {})
}

/** Remember the open project so MCP/plugin/skill pages survive a restart. */
function saveActiveProject(dir) {
  try {
    if (dir) localStorage.setItem(ACTIVE_PROJECT_KEY, dir)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  } catch {}
}

async function restoreActiveProject() {
  let dir = null
  try {
    dir = localStorage.getItem(ACTIVE_PROJECT_KEY)
  } catch {}

  // localStorage can be wiped (cache clear / different origin). The main
  // process keeps its own copy, so fall back to that.
  if (!dir && vibe.getDirectory) {
    try {
      const res = await vibe.getDirectory()
      if (res && res.ok && typeof res.data === "string" && res.data) dir = res.data
    } catch {}
  }

  if (!dir && workspaces.length === 1) dir = workspaces[0].dir
  if (!dir) return

  let ws = workspaces.find((w) => w.dir === dir)
  if (!ws) {
    // The saved folder is not in the sidebar yet (fresh install / cleared
    // storage) — add it instead of silently dropping the selection.
    ws = { dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir }
    workspaces.push(ws)
    saveWorkspaces()
  }

  saveActiveProject(ws.dir)
  projectDir = ws.dir
  $("chip-project-label").textContent = ws.name
  $("chip-project").title = ws.dir
  $("hero-title").textContent = `Start a new task in ${ws.name}`
  $("project-block").hidden = false
  $("workspace-name").textContent = ws.name
  renderWorkspaces()

  try {
    const res = await vibe.setDirectory(ws.dir)
    if (res && res.ok === false) console.warn("setDirectory failed:", res.error)
    ensureProjectAgent(ws.dir)
    await refreshSessions()
    resetActiveSessionForWorkspace()
  } catch (e) {
    console.warn("restore active project failed:", e)
  }
}

function renderWorkspaces() {
  const ul = $("workspace-list")
  ul.innerHTML = ""
  if (workspaces.length === 0) {
    const li = document.createElement("li")
    li.className = "workspace-empty"
    li.textContent = "No workspace yet — add one with ＋"
    ul.appendChild(li)
  }
  for (const ws of workspaces) {
    const li = document.createElement("li")
    li.dataset.dir = ws.dir
    if (ws.dir === projectDir) li.classList.add("active")

    const name = document.createElement("span")
    name.className = "ws-name"
    name.textContent = ws.name
    name.title = ws.dir

    const acts = document.createElement("span")
    acts.className = "ws-acts"
    const ren = document.createElement("button")
    ren.textContent = "✎"
    ren.title = "Rename"
    ren.onclick = async (e) => {
      e.stopPropagation()
      // Electron has no prompt() -> the themed dialog with a text field
      const nn = await showPrompt({
        title: "Rename workspace",
        message: "Workspace er notun naam:",
        defaultValue: ws.name,
        okText: "Save",
      })
      if (nn && nn.trim()) {
        ws.name = nn.trim()
        saveWorkspaces()
        renderWorkspaces()
        if (ws.dir === projectDir) $("workspace-name").textContent = ws.name
      }
    }
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "✕"
    del.title = "Delete"
    del.onclick = async (e) => {
      e.stopPropagation()
      if (!(await showConfirm(`"${ws.name}" delete korbe? (project folder delete hobe na, shudhu list theke)`))) return
      workspaces = workspaces.filter((w) => w.dir !== ws.dir)
      saveWorkspaces()
      if (projectDir === ws.dir) {
        projectDir = null
        saveActiveProject(null)
        $("chip-project-label").textContent = "Select project"
        $("chip-branch").hidden = true
        $("project-block").hidden = true
      }
      renderWorkspaces()
    }

    acts.append(ren, del)
    li.append(name, acts)
    li.onclick = async () => {
      projectDir = ws.dir
      saveActiveProject(ws.dir)
      $("chip-project-label").textContent = ws.name
      $("chip-project").title = ws.dir
      $("hero-title").textContent = `Start a new task in ${ws.name}`
      $("project-block").hidden = false
      $("workspace-name").textContent = ws.name
      await vibe.setDirectory(ws.dir)
      ensureProjectAgent(ws.dir)
      hideBranchChip()
      renderWorkspaces()
      await refreshSessions()
      resetActiveSessionForWorkspace()
    }
    ul.appendChild(li)
  }
}

async function addWorkspace({ directory, name }) {
  if (!directory) return
  let ws = workspaces.find((w) => w.dir === directory)
  if (!ws) {
    ws = { dir: directory, name: name || directory.split(/[\\/]/).pop() }
    workspaces.push(ws)
    saveWorkspaces()
  }
  projectDir = directory
  saveActiveProject(directory)
  $("chip-project-label").textContent = name
  $("chip-project").title = directory
  $("hero-title").textContent = `Start a new task in ${name}`
  $("project-block").hidden = false
  $("workspace-name").textContent = name
  // The branch chip stays hidden until the agent actually runs a git commit.
  $("chip-branch").hidden = true
  renderWorkspaces()
  // Sync the backend with the new workspace too (the sidebar click does this;
  // without it the backend kept filtering the session list by the old folder
  // and freshly created sessions never showed up).
  try {
    await vibe.setDirectory(directory)
    ensureProjectAgent(directory)
    await refreshSessions()
    resetActiveSessionForWorkspace()
  } catch {}
}

/* ---------- git branch chip (only during git work) ---------- */
function hideBranchChip() {
  $("chip-branch").hidden = true
}

/**
 * Show the current branch — but ONLY when the folder really is a git repo.
 * The branch is always verified live through the main process (git
 * rev-parse); a cached value is never trusted, otherwise a stale "master"
 * used to stick around in projects that are not git repositories at all.
 */
async function showBranchChip() {
  const dir = projectDir
  if (!dir || !vibe.gitBranch) return
  let branch = null
  try {
    const res = await vibe.gitBranch(dir)
    if (res && res.ok && res.data) branch = res.data
  } catch {}
  if (!branch) return
  $("chip-branch-label").textContent = branch
  $("chip-branch").hidden = false
}

/* Git subcommands that only READ the repo — they are not "git work". */
const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "remote", "config", "ls-files", "ls-remote",
  "blame", "describe", "rev-parse", "symbolic-ref", "shortlog", "whatchanged",
  "check-ignore", "cat-file", "var", "grep", "help", "version",
])

/* These list by default, but change the repo when a name is given
 * (git branch -> lists, git branch feature -> creates). */
const GIT_NEEDS_ARG = new Set(["branch", "tag"])

/* git stash list / git stash show only read; git stash (push/pop) changes. */
const GIT_STASH_READONLY = new Set(["list", "show"])

/** True when the command line actually changes the repo (add/commit/...). */
function hasGitWork(cmd) {
  const s = String(cmd || "")
  if (!/\bgit\b/.test(s)) return false
  const re = /\bgit\b/g
  let m
  while ((m = re.exec(s)) !== null) {
    const tokens = s.slice(m.index + m[0].length).trim().split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (!t) break
      if (/^(&&|\|\||;|\||&)$/.test(t)) break // a new command starts here
      if (t.startsWith("-")) {
        // flags like -C <path> consume the next token
        if (!t.includes("=") && /^-[a-zA-Z]$/.test(t)) i++
        continue
      }
      const sub = t.toLowerCase()
      if (GIT_NEEDS_ARG.has(sub)) {
        const next = tokens[i + 1] ? tokens[i + 1].toLowerCase() : ""
        // a name after it means create, a delete/move flag means remove
        if (next && !next.startsWith("-") && !/^(&&|\|\||;|\||&)$/.test(next)) return true
        if (/^(-d|-m|--delete|--move)$/.test(next)) return true
        break
      }
      if (sub === "stash") {
        const next = tokens[i + 1] ? tokens[i + 1].toLowerCase() : ""
        if (GIT_STASH_READONLY.has(next)) break
        return true
      }
      if (!GIT_READONLY.has(sub)) return true
      break // only the first real subcommand counts
    }
  }
  return false
}

/* The user asked for git work in the prompt (text mention only — the chip
 * still needs a REAL git repo, verified by the main process). */
function maybeShowBranchForText(text) {
  if (/\b(git\s+)?commit(?:ted|ting)?\b/i.test(String(text || ""))) showBranchChip()
}

/* The agent actually runs a git command -> show the branch for this run. */
function maybeShowBranchForTool(name, input) {
  if (!["shell", "bash", "terminal", "exec", "command"].includes(String(name || ""))) return
  const cmd = String(input?.command ?? input?.cmd ?? "")
  if (!hasGitWork(cmd)) return
  showBranchChip()
}

$("btn-add-workspace").onclick = async () => {
  const res = await vibe.pickProject()
  if (!res.ok || !res.data) return
  addWorkspace(res.data)
  await vibe.setDirectory(res.data.directory)
  ensureProjectAgent(res.data.directory)
  await refreshSessions()
}

$("btn-clear-workspaces").onclick = async () => {
  if (!workspaces.length) return
  if (!(await showConfirm("Sob workspace list theke delete korbe?"))) return
  workspaces = []
  saveWorkspaces()
  projectDir = null
  saveActiveProject(null)
  $("chip-project-label").textContent = "Select project"
  $("chip-branch").hidden = true
  $("project-block").hidden = true
  renderWorkspaces()
}

/* ---------- permission mode (Ask / Full Access) ---------- */
const PERM_ACTIONS = ["edit", "write", "patch", "bash", "webfetch"]

function permissionsFor(mode) {
  const effect = mode === "full" ? "allow" : "ask"
  const list = [
    ...PERM_ACTIONS.map((action) => ({ action, resource: "*", effect })),
    // Note: question tool is handled separately - it's always allowed as a UI prompt
    // but should NOT trigger Full Access mode detection
  ]
  // The agent may always write its own memory file, even in "Ask" mode.
  // The memory file lives OUTSIDE the project, and OpenCode checks the
  // `external_directory` permission BEFORE the write/edit permission. Without
  // that rule the save is blocked by a prompt (and the agent gives up), which
  // is why "remember this" never reached the file before.
  if (state.memoryFile && memoryEnabled()) {
    const file = String(state.memoryFile).replace(/\\/g, "/")
    const dir = file.slice(0, file.lastIndexOf("/"))
    list.push({ action: "read", resource: file, effect: "allow" })
    list.push({ action: "write", resource: file, effect: "allow" })
    list.push({ action: "edit", resource: file, effect: "allow" })
    if (dir) list.push({ action: "external_directory", resource: dir + "/*", effect: "allow" })
  }
  return list
}

async function applyPermissionMode() {
  if (!state.activeSessionID) return
  const res = await vibe.setPermissions({
    sessionID: state.activeSessionID,
    permissions: permissionsFor(pillState.access),
  })
  if (!res.ok) showError("Could not apply the permission mode", res.error || "Unknown error", { key: "permissions" })
  else hideError("permissions")
  
  // IMPORTANT: When switching to "ask" mode, clear any existing session rules
  // that were added from previous "Full Access" sessions. This ensures
  // permission prompts actually appear in Ask mode.
  if (pillState.access !== "full" && vibe.clearSessionRules) {
    await vibe.clearSessionRules({ sessionID: state.activeSessionID })
  }
}

/* ---------- custom model providers ---------- */
/* Add / rename / enable / disable / delete a provider, add its models and use
   them in the composer. The key is never put into localStorage. */
const providerState = {
  list: [],
  formats: [],
  selectedId: null,
  draft: null,
  fetched: [],
}

/* What the app calls for each API format - the hint under the base URL. */
const FORMAT_HINT = {
  anthropic: "The API root, e.g. https://api.anthropic.com — the app calls /v1/messages (x-api-key). Console/dashboard URLs are fixed automatically.",
  chat: "The API root, e.g. https://api.openai.com/v1 — the app calls /chat/completions (Bearer). Console URLs (console.groq.com, console.x.ai...) are fixed automatically.",
  responses: "The API root, e.g. https://api.openai.com/v1 — the app calls /responses (Bearer). Console/dashboard URLs are fixed automatically.",
}

function updateFormatHint() {
  const hint = $("pf-baseurl-hint")
  if (!hint) return
  const fmt = $("pf-format")?.value || "chat"
  hint.textContent = FORMAT_HINT[fmt] || FORMAT_HINT.chat
}

function providerHeadersText(headers) {
  return Object.entries(headers && typeof headers === "object" ? headers : {}).map(([name, value]) => `${name}: ${value}`).join("\n")
}

function parseProviderHeaders(text) {
  const headers = {}
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const colon = line.indexOf(":")
    if (colon <= 0) throw new Error(`Invalid request header line: "${line}". Use Name: value.`)
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!value) throw new Error(`Request header "${name}" has no value.`)
    headers[name] = value
  }
  return headers
}

function parseProviderBody(text) {
  const source = String(text || "").trim()
  if (!source) return {}
  let value
  try { value = JSON.parse(source) } catch (error) { throw new Error(`Extra request body is not valid JSON: ${error.message}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extra request body must be a JSON object.")
  return value
}

const providerBodyText = (body) => body && typeof body === "object" && Object.keys(body).length ? JSON.stringify(body, null, 2) : ""

$("pf-format")?.addEventListener("change", updateFormatHint)

function newProviderDraft() {
  return {
    id: "",
    name: "",
    baseURL: "",
    apiFormat: "chat",
    apiKey: "",
    hasKey: false,
    maskedKey: "",
    headers: {},
    body: {},
    models: [],
    scope: "global",
    disabled: false,
    isNew: true,
  }
}

async function loadProviders(opts = {}) {
  if (!vibe.providerList && !vibe.providerCatalog) return
  const generation = ++providerLoadGeneration
  const res = typeof vibe.providerCatalog === "function"
    ? await vibe.providerCatalog({ directory: projectDir })
    : await vibe.providerList({ directory: projectDir })
  if (generation !== providerLoadGeneration) return
  if (!res || res.ok === false) {
    if (!opts.silent) {
      showError("Could not load the providers", res?.error || "Unknown error", { key: "providers" })
    }
    return
  }
  const data = res.data || {}
  if (typeof vibe.providerCatalog === "function") {
    applyProviderCatalog(data)
  } else {
    providerState.list = data.custom ?? []
    providerState.formats = data.formats ?? []
  }
  if (opts.silent) return
  renderProviderList()
  if (providerState.selectedId) {
    const found = providerState.list.find((p) => p.id === providerState.selectedId)
    if (found) {
      // Don't overwrite unsaved fields, but don't resurrect a provider deleted
      // from disk: deletion is authoritative for the provider catalog.
      if (!providerDraftDirty()) providerState.draft = { ...found, isNew: false }
      renderProviderDetail()
      return
    }
  }
  providerState.selectedId = null
  providerState.draft = null
  renderProviderDetail()
}

function providerDraftDirty() {
  const d = providerState.draft
  if (!d || d.isNew) return !!d
  const currentModels = JSON.stringify(d.models || [])
  const saved = providerState.list.find((p) => p.id === d.id)
  if (!saved) return true
  return String($("pf-name")?.value || "") !== String(saved.name || "") ||
    String($("pf-baseurl")?.value || "") !== String(saved.baseURL || "") ||
    String($("pf-format")?.value || "chat") !== String(saved.apiFormat || "chat") ||
    String($("pf-headers")?.value || "").trim() !== providerHeadersText(saved.headers).trim() ||
    String($("pf-body")?.value || "").trim() !== providerBodyText(saved.body).trim() ||
    String($("pf-scope")?.value || "global") !== String(saved.scope || "global") ||
    currentModels !== JSON.stringify(saved.models || []) ||
    !!d.disabled !== !!saved.disabled
}

async function refreshProviderStateLive() {
  const generation = ++providerRefreshGeneration
  const selectedId = providerState.selectedId
  const draftBefore = providerState.draft
    ? { ...providerState.draft, models: [...(providerState.draft.models || [])] }
    : null
  const dirtyBefore = providerDraftDirty()

  await loadModels()
  if (generation !== providerRefreshGeneration) return
  if (typeof vibe.providerCatalog !== "function") {
    await loadProviders({ silent: true })
  }

  // A newly-created draft is local work and can survive a refresh. An existing
  // draft whose provider disappeared from disk must not bring the deleted row
  // back into the UI or the Composer catalog.
  if (draftBefore?.isNew) {
    providerState.selectedId = selectedId
    providerState.draft = draftBefore
    renderProviderList()
    renderProviderDetail()
  } else if (selectedId && providerState.list.some((item) => item.id === selectedId)) {
    const saved = providerState.list.find((item) => item.id === selectedId)
    providerState.selectedId = selectedId
    providerState.draft = dirtyBefore ? draftBefore : { ...saved, isNew: false }
    renderProviderList()
    renderProviderDetail()
  } else {
    providerState.selectedId = null
    providerState.draft = null
    renderProviderList()
    renderProviderDetail()
  }

  renderModelList(modelSearch?.value || "")
  const menu = $("model-menu")
  if (state.modelMenuOpen && menu) menu.hidden = false
}

function renderProviderList() {
  const box = $("custom-provider-list")
  const empty = $("custom-provider-empty")
  if (!box) return
  box.textContent = ""
  if (empty) empty.hidden = providerState.list.length > 0
  for (const p of providerState.list) {
    const item = document.createElement("div")
    item.className = "ml-item provider-item" + (p.id === providerState.selectedId ? " active" : "")
    item.dataset.provider = p.id
    const ic = document.createElement("span")
    ic.className = "prov-ic"
    ic.textContent = "◈"
    const nm = document.createElement("span")
    nm.className = "prov-nm"
    nm.textContent = p.name
    item.append(ic, nm)
    // Every custom provider shows its state like the OpenCode row does:
    // green = on (models usable), grey = switched off.
    const dot = document.createElement("span")
    dot.className = "prov-dot " + (p.disabled ? "off" : "on")
    dot.title = p.disabled ? "This provider is switched off" : "This provider is on"
    item.appendChild(dot)
    item.onclick = () => selectProvider(p.id)
    box.appendChild(item)
  }
}

function selectProvider(id) {
  const p = providerState.list.find((x) => x.id === id)
  if (!p) return
  providerState.selectedId = id
  providerState.draft = { ...p, isNew: false }
  renderProviderList()
  renderProviderDetail()
  // the OpenCode built-in block is not shown while a custom provider is open
  $("md-opencode").hidden = true
  $("md-custom").hidden = false
  $("model-detail").querySelector(".md-empty")?.setAttribute("hidden", "")
}

function startNewProvider() {
  providerState.selectedId = null
  providerState.draft = newProviderDraft()
  renderProviderList()
  renderProviderDetail()
  $("md-opencode").hidden = true
  $("md-custom").hidden = false
  $("model-detail").querySelector(".md-empty")?.setAttribute("hidden", "")
}

function renderProviderDetail() {
  const d = providerState.draft
  providerKeyLoaded = null
  providerKeyFor = null
  const box = $("md-custom")
  if (!box) return
  if (!d) {
    box.hidden = true
    $("md-opencode").hidden = false
    $("model-detail").querySelector(".md-empty")?.removeAttribute("hidden")
    return
  }
  box.hidden = false
  $("md-custom-name").textContent = d.name || "New provider"
  $("md-custom-sub").textContent = d.isNew
    ? "Not saved yet — fill the form and press Save provider"
    : `${d.models.length} model${d.models.length === 1 ? "" : "s"} · ${d.scope === "global" ? "global" : "this project"}`
  $("pf-name").value = d.name || ""
  $("pf-baseurl").value = d.baseURL || ""
  $("pf-format").value = d.apiFormat || "chat"
  $("pf-headers").value = providerHeadersText(d.headers)
  $("pf-body").value = providerBodyText(d.body)
  updateFormatHint()
  $("pf-apikey").value = ""
  $("pf-apikey").type = "password"
  $("pf-apikey").placeholder = d.hasKey ? `${d.maskedKey} (saved - click the eye to reveal)` : "sk-..."
  $("pf-key-toggle").classList.remove("revealed")
  providerKeyLoaded = null
  $("pf-scope").value = d.scope || "global"
  const toggle = $("toggle-provider")
  toggle.classList.toggle("on", !d.disabled)
  toggle.setAttribute("aria-checked", d.disabled ? "false" : "true")
  $("pf-delete").hidden = d.isNew
  renderProviderModels()
}

function renderProviderModels() {
  const box = $("pf-model-list")
  const d = providerState.draft
  if (!box) return
  box.textContent = ""
  const models = d?.models ?? []
  if ($("pf-models-count")) {
    $("pf-models-count").textContent = models.length
      ? `${models.length} model${models.length === 1 ? "" : "s"}`
      : "No models yet"
  }
  for (const m of models) {
    const row = document.createElement("div")
    row.className = "pf-model"
    const id = document.createElement("span")
    id.className = "pfm-id"
    id.textContent = m.id
    const lim = document.createElement("span")
    lim.className = "pfm-lim"
    lim.textContent = m.context ? `${m.context} ctx · ${m.output || 0} out` : "no limits"
    if (m.image) {
      const img = document.createElement("span")
      img.className = "pfm-img"
      img.title = "This model can read images"
      img.textContent = "🖼 images"
      row.append(img)
    }
    const x = document.createElement("button")
    x.className = "pfm-x"
    x.type = "button"
    x.title = "Remove this model"
    x.textContent = "✕"
    x.onclick = () => {
      providerState.draft.models = providerState.draft.models.filter((z) => z.id !== m.id)
      renderProviderModels()
    }
    row.append(id, lim, x)
    box.appendChild(row)
  }
}

async function saveProvider() {
  const d = providerState.draft
  if (!d) return
  const btn = $("pf-save")
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = "Saving…"
  try {
    const headers = parseProviderHeaders($("pf-headers").value)
    const body = parseProviderBody($("pf-body").value)
    const res = await vibe.providerSave({
      id: d.id || undefined,
      name: $("pf-name").value.trim(),
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      apiKey: $("pf-apikey").value,
      headers,
      body,
      models: d.models,
      scope: $("pf-scope").value,
      directory: projectDir,
      disabled: d.disabled,
    })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not save the provider")
    hideError("providers")
    hideError("providers-key")
    if (res.data?.warning) showError("Saved, but this format may not work", String(res.data.warning), { key: "providers" })
    providerState.selectedId = res.data?.id || d.id
    providerState.draft = {
      ...d,
      id: providerState.selectedId,
      name: $("pf-name").value.trim(),
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      headers,
      body,
      scope: $("pf-scope").value,
      isNew: false,
    }
    await loadProviders()
    // Read the just-persisted profile immediately; no timing-based refresh.
    await loadProviders({ silent: true })
    await loadModels()
    renderModelList(modelSearch?.value || "")
  } catch (e) {
    showError("Could not save the provider", String(e && e.message ? e.message : e), { key: "providers" })
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

async function deleteProvider() {
  const d = providerState.draft
  if (!d || d.isNew) return
  if (!(await showConfirm(`"${d.name}" delete korbe? Provider ar tar modelগুলো আর থাকবে না।`))) return
  try {
    const res = await vibe.providerRemove({ id: d.id, scope: d.scope, directory: projectDir })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not delete the provider")
    providerState.selectedId = null
    providerState.draft = null
    await loadProviders()
    await loadModels()
  } catch (e) {
    showError("Could not delete the provider", String(e && e.message ? e.message : e), { key: "providers" })
  }
}

async function toggleProvider() {
  const d = providerState.draft
  if (!d || d.isNew) return
  const next = !d.disabled
  try {
    const res = await vibe.providerDisabled({ id: d.id, disabled: next, scope: d.scope, directory: projectDir })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not switch the provider")
    d.disabled = next
    await loadProviders()
    await loadModels()
  } catch (e) {
    showError("Could not switch the provider", String(e && e.message ? e.message : e), { key: "providers" })
  }
}

/** Ask the provider which models it has. */
async function fetchModelsForForm() {
  const btn = $("pf-fetch-models")
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = "Fetching…"
  try {
    const res = await vibe.providerModels({
      id: providerState.draft?.id || undefined,
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      apiKey: $("pf-apikey").value,
      headers: parseProviderHeaders($("pf-headers").value),
    })
    if (!res || res.ok === false) {
      providerState.fetched = []
      showError(
        "Could not fetch the models",
        (res?.error || "Unknown error") + " — you can still add a model by hand.",
        { key: "providers" },
      )
      return
    }
    hideError("providers")
    providerState.fetched = res.data?.models ?? []
    const count = res.data?.count ?? providerState.fetched.length
    if (!count) {
      showError("No models found", "The provider did not return any model ids.", { key: "providers" })
      return
    }
    // A provider can have a thousand models - the app never dumps them all.
    // The user types the model id and the app confirms that one.
    providerState.fetchedCount = count
    openModelModal(providerState.fetched)
  } catch (e) {
    showError("Could not fetch the models", String(e && e.message ? e.message : e), { key: "providers" })
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

/* ---------- add model modal ---------- */
let modelModalSmart = true
let modelModalChoices = []
let modelModalImage = false

function openModelModal(choices) {
  modelModalChoices = choices || []
  $("mf-id").value = ""
  $("mf-context").value = ""
  $("mf-output").value = ""
  modelModalImage = false
  $("mf-image").checked = false
  $("mf-image-row").hidden = true
  const count = providerState.fetchedCount || modelModalChoices.length
  $("mf-status").textContent = count
    ? `${count} models on this provider — type the model id, the app fills in the rest.`
    : "Type the model id. The context window and the image support are filled in automatically."
  $("mf-status").classList.remove("err")
  modelModalSmart = true
  $("mf-smart").classList.add("on")
  $("mf-smart").setAttribute("aria-checked", "true")
  // a small search over the fetched ids (never the whole list)
  const pick = $("mf-picker")
  if (pick) {
    pick.textContent = ""
    const show = modelModalChoices.slice(0, 8)
    for (const m of show) {
      const b = document.createElement("button")
      b.className = "save-btn ghost"
      b.type = "button"
      b.textContent = m.id
      b.onclick = () => {
        $("mf-id").value = m.id
        confirmModel(m.id)
      }
      pick.appendChild(b)
    }
  }
  $("model-modal").hidden = false
  $("mf-id").focus()
}

function closeModelModal() {
  $("model-modal").hidden = true
}

/** Look the typed model up: the provider first, then models.dev. */
async function confirmModel(modelId) {
  const id = String(modelId || "").trim()
  if (!id) return
  const status = $("mf-status")
  status.classList.remove("err")
  const d = providerState.draft
  const baseURL = $("pf-baseurl").value.trim()
  const apiFormat = $("pf-format").value
  const apiKey = $("pf-apikey").value
  let headers
  try { headers = parseProviderHeaders($("pf-headers").value) }
  catch (error) { status.textContent = error.message; status.classList.add("err"); return }

  if (baseURL) {
    status.textContent = `Looking up "${id}" on the provider…`
    try {
      const res = await vibe.providerModel({ id: d?.id || undefined, baseURL, apiFormat, apiKey, headers, modelId: id })
      if (res && res.ok && res.data?.found) {
        const m = res.data.model
        $("mf-context").value = m.context || ""
        $("mf-output").value = m.output || ""
        modelModalImage = !!m.image
        $("mf-image").checked = modelModalImage
        $("mf-image-row").hidden = false
        status.textContent = `Found on the provider — ${m.context || "?"} context, ${m.output || "?"} output${m.image ? ", images" : ""}.`
        return
      }
      if (res && res.data?.error) status.textContent = res.data.error
    } catch (e) {
      status.textContent = String(e && e.message ? e.message : e)
    }
  }

  // models.dev fallback
  status.textContent = `Looking up "${id}" on models.dev…`
  try {
    const meta = await vibe.providerMeta({ modelId: id })
    if (meta && meta.ok && meta.data?.found) {
      $("mf-context").value = meta.data.context || ""
      $("mf-output").value = meta.data.output || ""
      modelModalImage = !!meta.data.image
      $("mf-image").checked = modelModalImage
      $("mf-image-row").hidden = false
      status.textContent = `Found on models.dev (${meta.data.provider}) — ${meta.data.context || "?"} context${meta.data.image ? ", images" : ""}.`
    } else {
      status.textContent = "Not found — you can type the limits by hand."
    }
  } catch {
    status.textContent = "Could not look it up — you can type the limits by hand."
  }
  if (d) d.image = modelModalImage
}

async function addModelFromModal() {
  const id = $("mf-id").value.trim()
  if (!id) {
    $("mf-status").textContent = "A model id is required."
    $("mf-status").classList.add("err")
    return
  }
  const status = $("mf-status")
  let context = Number($("mf-context").value) || 0
  let output = Number($("mf-output").value) || 0
  if (modelModalSmart && (!context || !output || !modelModalImage)) {
    await confirmModel(id)
    context = Number($("mf-context").value) || context
    output = Number($("mf-output").value) || output
    modelModalImage = $("mf-image").checked
  }
  const draft = providerState.draft
  if (!draft) {
    closeModelModal()
    return
  }
  draft.models = draft.models.filter((m) => m.id !== id)
  draft.models.push({ id, name: id, context, output, image: modelModalImage })
  renderProviderModels()
  closeModelModal()
}

$("pf-save")?.addEventListener("click", saveProvider)
$("pf-delete")?.addEventListener("click", deleteProvider)
$("pf-fetch-models")?.addEventListener("click", fetchModelsForForm)
$("pf-add-model")?.addEventListener("click", () => openModelModal([]))
// The saved key is hidden by default (type=password). Clicking the eye pulls the
// real key from the backend once and reveals it, so you can see which key a
// provider uses; clicking again re-hides it.
let providerKeyLoaded = null
let providerKeyFor = null
$("pf-key-toggle")?.addEventListener("click", async (event) => {
  event.preventDefault()
  event.stopPropagation()
  const input = $("pf-apikey")
  if (!input) return
  if (input.type === "text") {
    input.type = "password"
    $("pf-key-toggle").classList.remove("revealed")
    return
  }
  // typing a new (unsaved) key: the eye just reveals what is typed
  if (input.value) {
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    return
  }
  const id = providerState.draft && providerState.draft.id
  if (!id) {
    // New providers have no stored secret yet; still let the eye reveal typed text.
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    input.focus()
    return
  }
  try {
    if (providerKeyFor !== id) {
      providerKeyLoaded = null
      const res = await vibe.providerKey({ id })
      if (!res || res.ok === false) throw new Error(res?.error || "Could not read the saved API key")
      providerKeyLoaded = res.data?.key || ""
      providerKeyFor = id
    }
    if (!providerKeyLoaded) {
      showError("Could not reveal API key", "No saved key was found for this provider. Enter a key and save the provider first.", { key: "providers-key" })
      return
    }
    hideError("providers-key")
    input.value = providerKeyLoaded
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    input.focus()
  } catch (e) {
    showError("Could not reveal API key", String(e?.message || e), { key: "providers-key" })
  }
})
$("toggle-provider")?.addEventListener("click", toggleProvider)
$("model-modal-close")?.addEventListener("click", closeModelModal)
$("mf-cancel")?.addEventListener("click", closeModelModal)
$("mf-save")?.addEventListener("click", addModelFromModal)
// typing a model id confirms it (context window + image support) on its own
let mfLookupTimer = null
$("mf-id")?.addEventListener("input", () => {
  if (!modelModalSmart) return
  const id = $("mf-id").value.trim()
  if (!id) return
  if (mfLookupTimer) clearTimeout(mfLookupTimer)
  mfLookupTimer = setTimeout(() => confirmModel(id), 700)
})
$("mf-image")?.addEventListener("change", () => {
  modelModalImage = $("mf-image").checked
})
$("mf-smart")?.addEventListener("click", () => {
  modelModalSmart = !modelModalSmart
  $("mf-smart").classList.toggle("on", modelModalSmart)
  $("mf-smart").setAttribute("aria-checked", modelModalSmart ? "true" : "false")
})
$("model-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "model-modal") closeModelModal()
})

/* ---------- subagents (enable / disable the agents OpenCode offers) ---------- */
let agentList = []
let subAgentsById = new Map()
let subagentPoll = null
let subagentRenderSignature = ""

async function refreshSubagentIndex(sessionID) {
  if (!vibe.subagentList || !sessionID) return
  try {
    const res = await vibe.subagentList({ sessionID })
    if (!res || res.ok === false) return
    const list = res.data?.subagents || []
    for (const agent of list) subAgentsById.set(agent.id, agent)
    if (state.activeSessionID === sessionID && !state.subagentView) renderSessionHistory(sessionID)
  } catch {}
}

function subagentSignature(details) {
  const messages = Array.isArray(details?.messages) ? details.messages : []
  return JSON.stringify([details?.status, details?.result?.length || 0, details?.error, details?.liveText?.length || 0, messages.map((message) => [message.id, message.status, (message.content || []).length])])
}

function setSubagentHeader(details) {
  $("subagent-view-name").textContent = details.name || details.agent || details.type || "Subagent"
  $("subagent-view-task").textContent = `${details.type || "general"}${details.task ? ` · ${details.task}` : ""}`
  const status = details.status || "running"
  const badge = $("subagent-view-status")
  badge.textContent = status
  badge.className = `subagent-view-status ${status}`
  $("subagent-view-stop").hidden = status !== "running"
  $("subagent-send").disabled = status === "running"
  $("subagent-input").disabled = status === "running"
  $("subagent-input").placeholder = status === "running" ? "This subagent is still working…" : "Send a follow-up to this subagent…"
}

function renderSubagentDetails(details) {
  if (!state.subagentView || state.subagentView.id !== details.id) return
  setSubagentHeader(details)
  renderHistoryMessages(Array.isArray(details.messages) ? details.messages : [], {
    editable: false,
    usageRing: false,
    retryRow: false,
    assistantName: details.name || "Subagent",
  })
  if (details.liveReasoning) addThought(details.liveReasoning, 0, true)
  if (details.liveText) {
    const bubble = addMsg("assistant", details.liveText)
    bubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
    state.subagentView.liveBubble = bubble
    state.subagentView.liveText = details.liveText
  } else {
    state.subagentView.liveBubble = null
    state.subagentView.liveText = ""
  }
  const serialized = JSON.stringify(details.messages || [])
  if (details.result && !serialized.includes(details.result)) {
    const result = addMsg("assistant", details.result)
    result.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
  }
  if (details.error) {
    const error = addMsg("assistant", `⚠ ${details.error}`, "thinking")
    error.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
  }
  scrollChat(true)
}

async function refreshSubagentView(force = false) {
  const view = state.subagentView
  if (!view || !vibe.subagentDetails) return
  const res = await vibe.subagentDetails({ id: view.id })
  if (!res || res.ok === false || !res.data) {
    if (force) showError("Could not open the subagent", res?.error || "Subagent not found", { key: "subagent-view" })
    return
  }
  const details = res.data
  subAgentsById.set(details.id, details)
  const signature = subagentSignature(details)
  if (force || signature !== subagentRenderSignature) {
    subagentRenderSignature = signature
    renderSubagentDetails(details)
  } else setSubagentHeader(details)
  updateSubagentCards(details)
}

async function openSubagentView(id) {
  if (!id) return
  clearInterval(subagentPoll)
  subagentRenderSignature = ""
  state.subagentView = { id, parentSessionID: state.activeSessionID, liveBubble: null, liveText: "" }
  $("subagent-viewbar").hidden = false
  $("subagent-composer").hidden = false
  $("composer").hidden = true
  $("todo-panel").hidden = true
  $("retry-inline").hidden = true
  setMainEmpty(false)
  await refreshSubagentView(true)
  subagentPoll = setInterval(() => refreshSubagentView(false).catch(() => {}), 1000)
}

function leaveSubagentView(renderParent = true) {
  clearInterval(subagentPoll)
  subagentPoll = null
  subagentRenderSignature = ""
  state.subagentView = null
  $("subagent-viewbar").hidden = true
  $("subagent-composer").hidden = true
  $("composer").hidden = false
  $("subagent-input").value = ""
  hideError("subagent-view")
  renderTodos()
  if (renderParent && state.activeSessionID) renderSessionHistory(state.activeSessionID)
}

function updateSubagentCards(details) {
  if (!details?.id) return
  const info = {
    id: details.id,
    sessionID: details.childSessionId,
    name: details.name,
    type: details.type,
    task: details.task,
    status: details.status,
    result: details.result,
    error: details.error,
  }
  document.querySelectorAll(`.act[data-subagent-id="${details.id}"]`).forEach((element) => syncSubagentCard(element, info))
}

function handleSubagentEvent(data) {
  const id = data.subagentId
  if (!id) return
  const current = subAgentsById.get(id) || { id, status: "running" }
  const eventType = data.eventType || ""
  const next = {
    ...current,
    id,
    childSessionId: data.subagentSessionId || current.childSessionId,
    parentToolCallId: data.parentToolCallId || current.parentToolCallId,
    name: data.subagentName || data.name || current.name || "Subagent",
    type: data.agentType || current.type || "general",
    task: data.task || current.task || "",
  }
  if (eventType === "subagent.start" || eventType === "subagent.resume") next.status = "running"
  if (eventType === "subagent.error") { next.status = "error"; next.error = data.error || "Subagent failed" }
  if (eventType === "subagent.end" || eventType === "subagent.result") {
    next.status = data.status || next.status || "done"
    if (data.result) next.result = data.result
    if (data.error) next.error = data.error
  }
  subAgentsById.set(id, next)
  const index = agentList.findIndex((agent) => agent.id === id)
  if (index >= 0) agentList[index] = { ...agentList[index], ...next }
  else agentList.unshift(next)
  updateSubagentCards(next)
  if (next.parentToolCallId) {
    const parentCard = actEls.get(`tool:${next.parentToolCallId}`)
    if (parentCard) syncSubagentCard(parentCard, {
      id: next.id,
      sessionID: next.childSessionId,
      name: next.name,
      type: next.type,
      task: next.task,
      status: next.status,
      result: next.result,
      error: next.error,
    })
  }
  if (index < 0 || ["subagent.start", "subagent.resume", "subagent.error", "subagent.end", "subagent.result"].includes(eventType)) renderAgentList()

  const view = state.subagentView
  if (!view || view.id !== id) return
  setSubagentHeader(next)
  if (eventType === "text.delta" && data.delta) {
    if (!view.liveBubble) {
      view.liveBubble = addMsg("assistant", "")
      view.liveBubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(next.name || "Subagent"))
      view.liveText = ""
    }
    view.liveText += String(data.delta)
    if (window.renderMarkdown) view.liveBubble.innerHTML = window.renderMarkdown(view.liveText)
    else view.liveBubble.textContent = view.liveText
    scrollChat()
    return
  }
  if (["tool.start", "tool.end", "subagent.start", "subagent.resume", "subagent.error", "subagent.end", "subagent.result", "done"].includes(eventType)) {
    setTimeout(() => refreshSubagentView(true).catch(() => {}), 50)
  }
}

async function sendSubagentFollowup() {
  const view = state.subagentView
  const input = $("subagent-input")
  const text = input.value.trim()
  if (!view || !text) return
  const res = await vibe.subagentResume({ id: view.id, text })
  if (!res || res.ok === false) {
    showError("Could not resume the subagent", res?.error || "Unknown error", { key: "subagent-view" })
    return
  }
  input.value = ""
  await refreshSubagentView(true)
}

$("subagent-back").onclick = () => leaveSubagentView(true)
$("subagent-view-stop").onclick = async () => {
  const id = state.subagentView?.id
  if (!id) return
  await vibe.subagentStop({ id })
  refreshSubagentView(true)
}
$("subagent-send").onclick = sendSubagentFollowup
$("subagent-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendSubagentFollowup() }
})

async function loadAgents() {
  if (!vibe.subagentList) return
  try {
    const [t, l] = await Promise.all([
      vibe.subagentToggle ? vibe.subagentToggle({}) : { data: { enabled: true } },
      vibe.subagentList({}),
    ])
    const enabled = t && t.ok === false ? true : (t.data && t.data.enabled !== undefined ? t.data.enabled : true)
    const toggle = $("subagent-toggle")
    if (toggle) {
      toggle.classList.toggle("on", enabled)
      toggle.setAttribute("aria-checked", enabled ? "true" : "false")
      toggle.onclick = async () => {
        const now = toggle.classList.contains("on")
        const res = await vibe.subagentToggle({ enabled: !now })
        toggle.classList.toggle("on", !now)
        toggle.setAttribute("aria-checked", !now)
      }
    }
    const res = l
    if (!res || res.ok === false) {
      showError("Could not load subagents", res?.error || "Unknown error", { key: "agents" })
      return
    }
    agentList = res.data?.subagents ?? []
    subAgentsById = new Map()
    for (const a of agentList) subAgentsById.set(a.id, a)
    renderAgentList()
  } catch (e) {
    showError("Could not load subagents", String(e), { key: "agents" })
  }
}

function renderAgentList() {
  const list = $("subagent-list")
  if (!list) return
  list.textContent = ""
  const box = $("subagent-count")
  if (box) box.textContent = agentList.length
  if (!agentList.length) {
    const empty = document.createElement("div")
    empty.className = "cfg-empty"
    empty.textContent = "No subagents yet."
    list.appendChild(empty)
    return
  }
  for (const a of agentList) {
    const row = document.createElement("div")
    row.className = "s-row"
    const main = document.createElement("div")
    main.className = "s-col"
    const name = document.createElement("div")
    name.className = "s-name"
    name.textContent = a.name || a.id
    const desc = document.createElement("div")
    desc.className = "s-desc"
    desc.textContent = `${a.type} · ${a.status}${a.task ? " — " + a.task.slice(0, 60) : ""}`
    main.append(name, desc)
    const right = document.createElement("div")
    right.className = "s-row-actions"
    const tag = document.createElement("span")
    tag.className = "cfg-tag"
    tag.textContent = a.type || "subagent"
    right.append(tag)
    row.append(main, right)
    row.classList.add("subagent-settings-row")
    row.title = "Open this subagent's conversation"
    row.onclick = () => openSubagentView(a.id)
    list.appendChild(row)
  }
}

/* ---------- browser use ---------- */
async function loadBrowserUse() {
  const btn = $("btn-browser-install")
  if (!btn || !vibe.builtins) return
  const res = await vibe.builtins({ directory: projectDir })
  const entry = (res.data?.mcp ?? []).find((m) => m.id === "playwright")
  const installed = !!entry?.installed
  // An install from an older build runs a visible Chrome window OUTSIDE the app.
  // The one browser of the app is the panel, so the agent's MCP is fixed to
  // --headless the first time this page is opened (only the playwright entry).
  let normalized = false
  if (installed && vibe.mcpList) {
    try {
      const list = await vibe.mcpList({ directory: projectDir })
      const cur = (list?.data?.mcp ?? []).find((s) => String(s.name).toLowerCase() === "playwright")
      const raw = Array.isArray(cur?.command)
        ? cur.command
        : typeof cur?.command === "string"
          ? cur.command.split(/\s+/)
          : null
      const useGlobal = cur?.scope === "global" ? true : !projectDir
      if (
        cur &&
        raw &&
        raw.some((a) => String(a).includes("@playwright/mcp")) &&
        !raw.some((a) => String(a) === "--headless")
      ) {
        const r = await vibe.mcpAdd({
          name: "playwright",
          type: "local",
          command: [...raw.map(String), "--headless"],
          directory: useGlobal ? null : projectDir,
          global: useGlobal,
        })
        normalized = !!r && r.ok !== false
      }
    } catch {}
  }
  btn.textContent = installed ? "Remove" : "Install"
  btn.classList.toggle("danger-btn", installed)
  btn.classList.toggle("save-btn", !installed)
  btn.onclick = async () => {
    btn.disabled = true
    btn.textContent = installed ? "Removing…" : "Installing…"
    try {
      if (installed) {
        const r = await vibe.mcpRemove({ name: "playwright", directory: projectDir, global: !projectDir })
        if (r && r.ok === false) throw new Error(r.error || "Could not remove the browser MCP")
      } else {
        const r = await vibe.mcpAdd({
          name: "playwright",
          type: "local",
          command: entry?.command ?? ["npx", "-y", "@playwright/mcp@latest", "--headless"],
          directory: projectDir,
          global: !projectDir,
        })
        if (r && r.ok === false) throw new Error(r.error || "Could not install the browser MCP")
      }
    } catch (e) {
      showError("Browser control", String(e && e.message ? e.message : e), { key: "browser" })
    } finally {
      btn.disabled = false
      await loadBrowserUse()
    }
  }
  if ($("browser-mcp-desc")) {
    $("browser-mcp-desc").textContent = installed
      ? "Installed — the agent can open pages, click, fill forms, read the DOM and take screenshots." +
        (normalized ? " Headless mode was switched on, so no browser window opens outside the app." : "")
      : "Real browser control: open pages, click buttons, fill forms, read the DOM and take screenshots. The first start downloads the Playwright browser (~150 MB)."
  }
}

/* ---------- persistent memory ---------- */
/* The app shows the memory file; the agent only writes into it when the user
   asks ("remember this"). The app never saves a fact on its own.
   them here so the user can see, add and remove them - and switch the whole
   thing on or off from this page. */
const MEMORY_KEY = "vibecoder.memory"
let memoryEntries = []

function memoryEnabled() {
  try {
    return localStorage.getItem(MEMORY_KEY) !== "off"
  } catch {
    return true
  }
}

function setMemoryEnabled(on) {
  try { localStorage.setItem(MEMORY_KEY, on ? "on" : "off") } catch {}
  // The rules the agent reads are refreshed right away, so the memory is
  // really gone (or back) for the next run.
  if (projectDir) ensureProjectAgent(projectDir)
  applyMemoryUi()
}

function applyMemoryUi() {
  const on = memoryEnabled()
  const toggle = $("toggle-memory")
  if (toggle) {
    toggle.classList.toggle("on", on)
    toggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  const input = $("memory-input")
  if (input) input.disabled = !on
  const add = $("btn-memory-add")
  if (add) add.disabled = !on
  const note = $("memory-off-note")
  if (note) note.hidden = on
  const list = $("memory-list")
  if (list && !on) {
    list.textContent = ""
    const off = document.createElement("div")
    off.className = "memory-empty"
    off.textContent = "Persistent memory is off — the agent does not read or write these notes."
    list.appendChild(off)
  }
}

async function loadMemory() {
  applyMemoryUi()
  if (!vibe.memoryList) return
  const res = await vibe.memoryList()
  if (!res || res.ok === false) {
    showError("Could not load the memory", res?.error || "Unknown error", { key: "memory" })
    return
  }
  memoryEntries = res.data?.entries ?? []
  const file = res.data?.path ?? ""
  if ($("memory-path")) $("memory-path").textContent = file
  if ($("memory-count")) {
    $("memory-count").textContent = memoryEntries.length
      ? `${memoryEntries.length} ${memoryEntries.length === 1 ? "memory" : "memories"} saved`
      : "Nothing saved yet."
  }
  renderMemoryList()
}

async function loadUsage() {
  console.log("[Usage] Loading usage data...")
  console.log("[Usage] vibe.getAllUsage exists:", !!vibe.getAllUsage)
  if (!vibe.getAllUsage) {
    console.warn("[Usage] getAllUsage not available")
    // Show fallback message
    const overview = $("usage-overview")
    if (overview) {
      overview.hidden = false
      const err = document.createElement("div")
      err.style.color = "var(--text-muted)"
      err.style.padding = "8px"
      err.textContent = "Usage API not available - run with --dev flag to debug"
      overview.appendChild(err)
    }
    return
  }
  
  try {
    const res = await vibe.getAllUsage()
    console.log("[Usage] Response:", JSON.stringify(res).substring(0, 500))
    
    if (!res || res.ok === false) {
      console.error("[VibeCoder] Could not load usage:", res?.error || "Unknown error")
      const overview = $("usage-overview")
      if (overview) {
        overview.hidden = false
        const err = document.createElement("div")
        err.style.color = "red"
        err.style.padding = "8px"
        err.textContent = "Error: " + (res?.error || "Unknown error")
        overview.appendChild(err)
      }
      return
    }
    
    const data = res.data
    if (!data) {
      console.warn("[Usage] No data returned")
      return
    }
    
    // Handle double-wrapping: if data.data exists (IPC already wrapped), unwrap it
    const usageData = data.data || data
    
    console.log("[Usage] Data keys:", Object.keys(usageData))
    console.log("[Usage] Sessions count:", usageData.sessions?.length)
    console.log("[Usage] Total tokens:", usageData.totalTokens)
    
    if (!usageData.sessions) {
      console.error("[Usage] Invalid data structure:", usageData)
      return
    }
    
    // Show overview
    const overview = $("usage-overview")
    if (overview) {
      console.log("[Usage] Setting overview visible")
      overview.hidden = false
      
      // Update elements
      const tokensEl = $("usage-total-tokens")
      const costEl = $("usage-total-cost")
      const countEl = $("usage-session-count")
      
      console.log("[Usage] Elements found:", { tokens: !!tokensEl, cost: !!costEl, count: !!countEl })
      
      if (tokensEl) {
        const tokens = usageData.totalTokens || 0
        tokensEl.textContent = tokens >= 1e6 
          ? `${(tokens / 1e6).toFixed(2)}M` 
          : tokens >= 1e3 
            ? `${(tokens / 1e3).toFixed(1)}k`
            : tokens.toString()
        console.log("[Usage] Tokens set to:", tokensEl.textContent)
      }
      
      if (costEl) {
        const cost = usageData.totalCost || 0
        costEl.textContent = cost > 0 ? `$${cost.toFixed(4)}` : "$0.0000"
      }
      
      if (countEl) {
        const count = (usageData.sessions || []).length
        countEl.textContent = `${count} session${count !== 1 ? 's' : ''}`
      }
    }
    
    // Render session list
    const listEl = $("usage-session-list")
    if (listEl && usageData.sessions && usageData.sessions.length > 0) {
      const sessionsDiv = $("usage-sessions")
      if (sessionsDiv) sessionsDiv.hidden = false
      
      listEl.textContent = ""
      const sorted = [...usageData.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      
      for (const s of sorted) {
        const row = document.createElement("div")
        row.className = "s-row s-row-flat"
        
        const info = document.createElement("div")
        info.style.flex = "1"
        
        const title = document.createElement("div")
        title.className = "s-name"
        title.style.fontSize = "14px"
        title.textContent = s.title || "Untitled"
        
        const meta = document.createElement("div")
        meta.style.cssText = "font-size: 11px; color: var(--text-muted);"
        const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "-"
        const model = s.model || "unknown"
        meta.textContent = `${date} · ${model}`
        
        info.append(title, meta)
        
        const tokens = document.createElement("span")
        tokens.className = "s-count"
        tokens.style.textAlign = "right"
        const total = (s.totalInputTokens || 0) + (s.totalOutputTokens || 0)
        tokens.textContent = total >= 1e6 
          ? `${(total / 1e6).toFixed(1)}M` 
          : total >= 1e3 
            ? `${(total / 1e3).toFixed(1)}k`
            : total.toString()
        
        const cost = document.createElement("span")
        cost.className = "s-count"
        cost.style.cssText = "text-align: right; color: var(--accent);"
        cost.textContent = `$${(s.estimatedCost || 0).toFixed(4)}`
        
        row.append(info, tokens, cost)
        listEl.appendChild(row)
      }
    }
  } catch (e) {
    console.error("[Usage] Exception:", e)
  }
}

function renderMemoryList() {
  const list = $("memory-list")
  if (!list) return
  list.textContent = ""
  if (!memoryEntries.length) {
    const empty = document.createElement("div")
    empty.className = "memory-empty"
    empty.textContent = "No memories yet. Tell the agent to remember something (or use the box above) — only you can add one."
    list.appendChild(empty)
    return
  }
  for (const m of memoryEntries) {
    const row = document.createElement("div")
    row.className = "memory-row"
    const text = document.createElement("div")
    text.className = "memory-text"
    text.textContent = m.text
    const date = document.createElement("div")
    date.className = "memory-date"
    date.textContent = m.date || ""
    const del = document.createElement("button")
    del.className = "danger-btn small"
    del.type = "button"
    del.textContent = "Remove"
    del.onclick = async () => {
      const res = await vibe.memoryRemove({ id: m.id, directory: projectDir, memory: memoryEnabled() })
      if (res && res.ok === false) {
        showError("Could not remove the memory", res.error || "Unknown error", { key: "memory" })
        return
      }
      memoryEntries = res.data?.entries ?? []
      renderMemoryList()
      if ($("memory-count")) $("memory-count").textContent = `${memoryEntries.length} saved`
    }
    row.append(text, date, del)
    list.appendChild(row)
  }
}

async function addMemory() {
  const input = $("memory-input")
  if (!input) return
  const text = input.value.trim()
  if (!text) return
  if (!memoryEnabled()) {
    showError("Persistent memory is off", "Turn it on in Settings > Memory first.", { key: "memory" })
    return
  }
  const res = await vibe.memoryAdd({ text, directory: projectDir, memory: true })
  if (res && res.ok === false) {
    showError("Could not save the memory", res.error || "Unknown error", { key: "memory" })
    return
  }
  hideError("memory")
  input.value = ""
  memoryEntries = res.data?.entries ?? []
  renderMemoryList()
  if ($("memory-count")) {
    $("memory-count").textContent = `${memoryEntries.length} ${memoryEntries.length === 1 ? "memory" : "memories"} saved`
  }
}

$("btn-memory-add")?.addEventListener("click", () => addMemory())
$("memory-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    addMemory()
  }
})
$("btn-memory-open")?.addEventListener("click", async () => {
  const res = await vibe.openMemoryFile()
  if (res && res.ok === false) alert(res.error || "Could not open the file")
})
$("toggle-memory")?.addEventListener("click", () => {
  setMemoryEnabled(!memoryEnabled())
})
$("toggle-memory")?.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault()
    setMemoryEnabled(!memoryEnabled())
  }
})

/* ---------- themed dialogs ---------- */
/* The native alert()/await showConfirm() popups are white and do not match the app.
   Everything now goes through this dark dialog. */
let dlgResolve = null
let dlgMode = "confirm" // "confirm" | "prompt"

function closeDialog(result) {
  const dlg = $("app-dialog")
  if (!dlg) return
  const input = $("dlg-input")
  dlg.hidden = true
  if (input) input.hidden = true
  const resolve = dlgResolve
  dlgResolve = null
  if (!resolve) return
  if (dlgMode === "prompt") {
    // the text of the field (or null when it was cancelled)
    const value = result === true ? (input ? input.value : "") : null
    dlgMode = "confirm"
    resolve(value)
    return
  }
  resolve(result)
}

function showDialog({
  title = "VibeCoder AI",
  message = "",
  okText = "OK",
  cancelText = "Cancel",
} = {}) {
  const dlg = $("app-dialog")
  if (!dlg) return Promise.resolve(true)
  if (dlgResolve) closeDialog(false) // only one dialog at a time
  dlgMode = "confirm"
  const input = $("dlg-input")
  if (input) input.hidden = true
  $("dlg-title").textContent = title
  $("dlg-message").textContent = message
  $("dlg-ok").textContent = okText
  const cancel = $("dlg-cancel")
  cancel.textContent = cancelText
  cancel.hidden = !cancelText
  dlg.hidden = false
  $("dlg-ok").focus()
  return new Promise((resolve) => {
    dlgResolve = resolve
  })
}

/* A themed text field (the native prompt() does not exist in Electron). */
function showPrompt({
  title = "VibeCoder AI",
  message = "",
  defaultValue = "",
  okText = "OK",
  cancelText = "Cancel",
} = {}) {
  const dlg = $("app-dialog")
  const input = $("dlg-input")
  if (!dlg || !input) return Promise.resolve(null)
  if (dlgResolve) closeDialog(false)
  dlgMode = "prompt"
  $("dlg-title").textContent = title
  $("dlg-message").textContent = message
  $("dlg-ok").textContent = okText
  const cancel = $("dlg-cancel")
  cancel.textContent = cancelText
  cancel.hidden = !cancelText
  input.hidden = false
  input.value = defaultValue ?? ""
  dlg.hidden = false
  // The browser gives the focus back to the button that was clicked AFTER this
  // handler runs, so focusing synchronously lost the caret: typing then went
  // nowhere and Enter re-clicked the ✎ button (rename looked like it did
  // nothing). Focus again after paint, and once more shortly after.
  focusDialogInput()
  requestAnimationFrame(focusDialogInput)
  setTimeout(focusDialogInput, 60)
  return new Promise((resolve) => {
    dlgResolve = resolve
  })
}

function focusDialogInput() {
  const input = $("dlg-input")
  if (!input || input.hidden) return
  try {
    input.focus({ preventScroll: true })
    input.select()
  } catch {}
}

async function showAlert(message, title = "VibeCoder AI") {
  return showDialog({ title, message, okText: "OK", cancelText: null })
}

async function showConfirm(message, title = "VibeCoder AI", okText = "OK") {
  return showDialog({ title, message, okText, cancelText: "Cancel" })
}

$("dlg-ok")?.addEventListener("click", () => closeDialog(true))
$("dlg-cancel")?.addEventListener("click", () => closeDialog(false))
$("dlg-x")?.addEventListener("click", () => closeDialog(false))
$("app-dialog")?.addEventListener("click", (e) => {
  if (e.target.id === "app-dialog") closeDialog(false)
})
// Enter in the text field confirms, Escape cancels
$("dlg-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    e.stopPropagation()
    closeDialog(true)
  } else if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    closeDialog(false)
  }
})
document.addEventListener("keydown", (e) => {
  if (!dlgResolve) return
  if (e.key === "Escape") {
    closeDialog(false)
    return
  }
  // Enter confirms a prompt even when the caret is not in the field (right
  // after opening, the focus can still be on the button that opened it).
  if (e.key === "Enter" && dlgMode === "prompt" && document.activeElement !== $("dlg-input")) {
    e.preventDefault()
    closeDialog(true)
  }
})

// the native alert() is replaced by the themed one (the calls stay the same)
window.alert = (message) => {
  showAlert(String(message ?? ""))
}
// safety net: if a native confirm() is ever used, it shows the themed dialog
// and does nothing until the code is converted (never a white popup).
window.confirm = (message) => {
  showDialog({ title: "VibeCoder AI", message: String(message ?? ""), okText: "OK", cancelText: "Cancel" })
  return false
}

/* ---------- the task list (the plan of the agent) ---------- */
/* The agent writes its plan with the todowrite tool; the app mirrors it in a
   compact strip right below the Running chip (green check = done, arrow opens
   the details: what is finished and what is still left) and keeps it on disk,
   so the work is not lost when the app is closed. */
const TODO_OPEN_KEY = "vibecoder.todoOpen"
const todoState = { items: [], hidden: false, open: readTodoOpen() }

function readTodoOpen() {
  try {
    return localStorage.getItem(TODO_OPEN_KEY) === "1"
  } catch {
    return false
  }
}

async function loadTodos() {
  if (!vibe.todoList) return
  const res = await vibe.todoList()
  if (!res || res.ok === false) return
  const items = res.data?.items ?? []
  todoState.items = items
  // a list where everything is done is old news: do not pop up on every start,
  // the strip comes back as soon as the agent plans the next task
  if (items.length && items.every((t) => t.status === "completed" || t.status === "cancelled")) {
    todoState.hidden = true
  }
  renderTodos()
}

/** The strip sits right below the Running chip, or at the top when it is hidden. */
function placeTodoPanel(panel) {
  const job = $("bg-job")
  const under = !!(job && !job.hidden)
  panel.style.top = under ? "48px" : "12px"
}

/** Keep the strip glued under the Running chip when that chip appears/disappears. */
function syncTodoPosition() {
  const panel = $("todo-panel")
  if (panel && !panel.hidden) placeTodoPanel(panel)
}

function setTodoOpen(open) {
  todoState.open = !!open
  try {
    localStorage.setItem(TODO_OPEN_KEY, open ? "1" : "0")
  } catch {}
  renderTodos()
}

function renderTodos() {
  const panel = $("todo-panel")
  const list = $("todo-list")
  if (!panel || !list) return
  const items = todoState.items || []
  const done = items.filter((t) => t.status === "completed").length
  const open = items.filter((t) => t.status === "pending" || t.status === "in_progress").length
  const total = done + open
  if (!total || todoState.hidden) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  placeTodoPanel(panel)
  panel.classList.toggle("collapsed", !todoState.open)
  panel.classList.toggle("open", todoState.open)
  const body = $("todo-body")
  if (body) body.hidden = !todoState.open
  const head = $("todo-toggle")
  if (head) head.setAttribute("aria-expanded", todoState.open ? "true" : "false")
  if ($("todo-count")) $("todo-count").textContent = `${done}/${total}`
  const left = $("todo-left")
  if (left) {
    left.textContent = open ? `${open} left` : "all done"
    left.classList.toggle("all-done", open === 0)
  }
  if ($("todo-note")) {
    $("todo-note").textContent = open
      ? `${done} done · ${open} left`
      : `${done} done · everything is finished`
  }
  list.textContent = ""
  // collapsed: the one-line strip is enough, the rows are built when it opens
  if (!todoState.open) return
  for (const t of items) {
    const row = document.createElement("div")
    row.className =
      "todo-item" +
      (t.status === "completed" ? " done" : "") +
      (t.status === "in_progress" ? " active" : "")
    const box = document.createElement("span")
    box.className = "tk-box"
    box.textContent = "✓"
    box.title = "Mark as done / not done"
    const text = document.createElement("span")
    text.className = "tk-text"
    text.textContent = t.content
    row.append(box, text)
    box.onclick = async () => {
      const next = t.status === "completed" ? "pending" : "completed"
      todoState.items = todoState.items.map((x) => (x.content === t.content ? { ...x, status: next } : x))
      renderTodos()
      await saveTodos()
    }
    list.appendChild(row)
  }
}

async function saveTodos() {
  if (!vibe.todoSave) return
  try {
    await vibe.todoSave({ items: todoState.items })
  } catch {}
}

function toggleTodos() {
  setTodoOpen(!todoState.open)
}

$("todo-toggle")?.addEventListener("click", (e) => {
  if (e.target.closest("#todo-close")) return
  toggleTodos()
})
$("todo-toggle")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    toggleTodos()
  }
})
$("todo-close")?.addEventListener("click", (e) => {
  e.stopPropagation()
  todoState.hidden = true
  const p = $("todo-panel")
  if (p) p.hidden = true
})
$("todo-clear")?.addEventListener("click", async (e) => {
  e.stopPropagation()
  todoState.items = todoState.items.filter((t) => t.status !== "completed")
  renderTodos()
  await saveTodos()
})

/* ---------- owner verification ---------- */
/* The user proves that they own the app with a secret code. The agent is told
   about it, so it can trust owner-only instructions. */
const OWNER_CODE_KEY = "vibecoder.ownerVerified"

function ownerVerified() {
  try {
    return localStorage.getItem(OWNER_CODE_KEY) === "1"
  } catch {
    return false
  }
}

async function verifyOwner(code) {
  if (!code || !String(code).trim()) {
    showError("Owner code missing", "Type the owner code to verify.", { key: "owner" })
    return false
  }
  const res = await vibe.ownerVerify({ code: String(code), directory: projectDir })
  if (!res || res.ok === false) {
    showError("Wrong owner code", res?.error || "That is not the owner code", { key: "owner" })
    return false
  }
  try { localStorage.setItem(OWNER_CODE_KEY, "1") } catch {}
  hideError("owner")
  renderOwnerBadge()
  notifyAgent("Owner verified", "The user proved that they are the owner of this app.")
  return true
}

function renderOwnerBadge() {
  // the owner state is not shown in the UI - only the agent is told about it
}

/**
 * The owner code: the user types the secret code word in the chat. The app
 * checks it, marks the user as the verified owner and REDACTS the code from
 * the message, so the model never sees it (not even in the next turn).
 */
async function checkOwnerCode(text) {
  if (!vibe.ownerScan) return { text, found: false }
  let scan = null
  try {
    scan = await vibe.ownerScan({ text: String(text ?? "") })
  } catch {
    return { text, found: false }
  }
  if (!scan || !scan.found) return { text, found: false }
  // it matched the stored hash -> the user is the owner
  try { localStorage.setItem(OWNER_CODE_KEY, "1") } catch {}
  renderOwnerBadge()
  notifyAgent("Owner verified", "The user proved that they are the owner of this app.")
  showError("Owner verified", "You are verified as the owner of this app.", { key: "owner" })
  setTimeout(() => hideError("owner"), 4000)
  return { text: scan.redacted ?? text, found: true }
}

$("owner-form")?.addEventListener("submit", async (e) => {
  e.preventDefault()
  const input = $("owner-input")
  if (!input) return
  const ok = await verifyOwner(input.value)
  if (ok) input.value = ""
})

$("btn-owner-verify")?.addEventListener("click", async () => {
  const input = $("owner-code")
  if (!input) return
  const ok = await verifyOwner(input.value)
  if (ok) input.value = ""
})
$("owner-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    $("btn-owner-verify")?.click()
  }
})

/* ---------- the theme (dark / amoled / light / system) ---------- */
const THEME_KEY = "vibecoder.theme"
const FONT_KEY = "vibecoder.fontScale"
const THEMES = ["dark", "amoled", "light", "system"]

function currentTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return THEMES.includes(t) ? t : "dark"
  } catch {
    return "dark"
  }
}

function systemTheme() {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
  } catch {
    return "dark"
  }
}

function resolvedTheme(name) {
  const t = THEMES.includes(name) ? name : "dark"
  return t === "system" ? systemTheme() : t
}

function applyTheme(name, save = true) {
  const theme = THEMES.includes(name) ? name : "dark"
  document.documentElement.dataset.theme = resolvedTheme(theme)
  if (save) {
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
  }
  const sel = $("theme-select")
  if (sel) sel.value = theme
}

/* the interface text size (only the text, not the icons) */
function applyFontScale(px, save = true) {
  const n = Math.min(18, Math.max(12, Math.round(Number(px) || 14)))
  document.documentElement.style.setProperty("--fs-scale", String(n / 14))
  const range = $("font-size-range")
  if (range && range.value !== String(n)) range.value = String(n)
  const label = $("font-size-value")
  if (label) label.textContent = `${n} px`
  if (save) {
    try { localStorage.setItem(FONT_KEY, String(n / 14)) } catch {}
  }
}

$("theme-select")?.addEventListener("change", (e) => applyTheme(e.target.value))
$("font-size-range")?.addEventListener("input", (e) => applyFontScale(e.target.value))
// the theme has to be set before the first paint -> renderer/theme.js does that
applyTheme(currentTheme(), false)
try {
  const stored = localStorage.getItem(FONT_KEY)
  applyFontScale(stored ? Math.round(Number(stored) * 14) : 14, false)
} catch {
  applyFontScale(14, false)
}
// follow the system theme while it is selected
try {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "system") applyTheme("system", false)
  })
} catch {}

/* ---------- agent activity (tools, reasoning, shell) ---------- */const toolArgs = new Map()
const toolNames = new Map() // tool call id -> name (session.tool.called omits it)

/* ---------- agent events in the chat ----------
   Every step the agent takes is a row in the chat timeline, each labelled with
   its name (Read / Search / Edit / Shell / Thinking ...). There is no separate
   status line in the composer - the chat IS the event log. */

/** Friendly one-word label per tool — shown on every row in the chat. */
const TOOL_ROW_LABEL = {
  read: "Read", write: "Write", edit: "Edit", patch: "Patch",
  grep: "Search", glob: "Find", list: "List", ls: "List",
  bash: "Shell", shell: "Shell", terminal: "Shell", exec: "Shell", command: "Shell",
  webfetch: "Fetch", websearch: "Web search", question: "Ask",
  task: "Subagent", subagent: "Subagent", skill: "Skill", todowrite: "Plan",
}

/** The name to show for a tool row ("Read", "Search", "Shell", ...). */
function toolRowLabel(name) {
  if (!name) return "Tool"
  return TOOL_ROW_LABEL[name] || TOOL_META[name]?.label || name
}

/** The agent's own plan (todowrite) — the next thing it says it will do. */
function nextTodoText(input) {
  const todos = input?.todos
  if (!Array.isArray(todos) || !todos.length) return ""
  const todo =
    todos.find((t) => t?.status === "in_progress") ||
    todos.find((t) => t?.status === "pending")
  return todo?.content ? String(todo.content).slice(0, 70) : ""
}

/** A short summary of the agent's plan for the "Plan" row in the chat. */
function planSummary(input) {
  const todos = input?.todos
  if (!Array.isArray(todos) || !todos.length) return ""
  const done = todos.filter((t) => t?.status === "completed").length
  const open = todos.length - done
  return `${done}/${todos.length} done${open ? `, ${open} open` : ""}`
}

const TOOL_META = {
  read: { icon: "📖", label: "Read" },
  list: { icon: "📁", label: "List" },
  glob: { icon: "📁", label: "List" },
  grep: { icon: "🔍", label: "Search" },
  shell: { icon: "⌘", label: "Shell" },
  bash: { icon: "⌘", label: "Shell" },
  terminal: { icon: "⌘", label: "Shell" },
  exec: { icon: "⌘", label: "Shell" },
  command: { icon: "⌘", label: "Shell" },
  edit: { icon: "✏️", label: "Edit" },
  write: { icon: "📝", label: "Write" },
  patch: { icon: "🩹", label: "Patch" },
  webfetch: { icon: "🌐", label: "Web fetch" },
  websearch: { icon: "🌐", label: "Web search" },
  task: { icon: "🤖", label: "Agent" },
  subagent: { icon: "🤖", label: "Agent" },
  skill: { icon: "🧩", label: "Skill" },
  todowrite: { icon: "📋", label: "Todo" },
}

const actEls = new Map() // key -> element
let reasoningEl = null

function relPath(p) {
  if (!p) return ""
  let s = String(p)
  if (projectDir) {
    const base = String(projectDir).replace(/[\\/]+$/, "")
    if (s.toLowerCase().startsWith(base.toLowerCase())) {
      s = s.slice(base.length).replace(/^[\\/]+/, "")
    }
  }
  return s.split("\\").join("/")
}

function toolSubtitle(name, input = {}) {
  switch (name) {
    case "read":
      return relPath(input.filePath ?? input.path ?? "")
    case "list":
    case "glob":
      return relPath(input.path ?? "") || input.pattern || ""
    case "grep":
      return `${input.pattern ?? ""} ${relPath(input.path ?? "")}`.trim()
    case "shell":
    case "bash":
    case "terminal":
    case "exec":
    case "command":
      return input.command ?? input.cmd ?? ""
    case "edit":
    case "write":
    case "patch":
      return relPath(input.filePath ?? input.path ?? "")
    case "webfetch":
      return input.url ?? ""
    case "websearch":
      return input.query ?? input.url ?? ""
    case "todowrite":
      return planSummary(input) || nextTodoText(input)
    default:
      return input.description ?? input.query ?? input.prompt ?? ""
  }
}

function addAct(key, icon, title, kind = "", subtitle = "") {
  if (actEls.has(key)) return actEls.get(key)
  const el = document.createElement("div")
  el.className = "act" + (kind ? " " + kind : "")
  el.innerHTML = `
    <div class="act-head">
      <span class="act-ic"></span>
      <span class="act-title"></span>
      <span class="act-sub"></span>
      <span class="act-state">●</span>
    </div>
    <pre class="act-body"></pre>
    <pre class="act-out"></pre>`
  el.querySelector(".act-ic").textContent = icon
  el.querySelector(".act-title").textContent = title
  el.querySelector(".act-sub").textContent = subtitle
  el.querySelector(".act-head").onclick = () => el.classList.toggle("open")
  $("messages").appendChild(el)
  actEls.set(key, el)
  scrollChat()
  return el
}

function toolAct(key, name, input = {}) {
  const meta = TOOL_META[name] ?? { icon: "🔧", label: name }
  const el = addAct(key, meta.icon, toolRowLabel(name), "tool", toolSubtitle(name, input))
  return el
}

function actBody(key) {
  return actEls.get(key)?.querySelector(".act-body")
}

function actOut(key) {
  return actEls.get(key)?.querySelector(".act-out")
}

function actDone(key, ok = true) {
  const el = actEls.get(key)
  if (!el) return
  el.classList.add(ok ? "done" : "failed")
  el.querySelector(".act-state").textContent = ok ? "✓" : "✕"
}

function actAppend(key, text) {
  const b = actBody(key)
  if (b) b.textContent = (b.textContent || "") + text
}

function clearActs() {
  actEls.clear()
  toolArgs.clear()
  toolNames.clear()
  reasoningEl = null
}

function addHarnessNote(title, detail = "", tone = "") {
  const box = $("messages")
  if (!box) return
  const el = document.createElement("div")
  el.className = `harness-note${tone ? ` ${tone}` : ""}`
  const strong = document.createElement("strong")
  strong.textContent = String(title || "VibeCore")
  el.appendChild(strong)
  if (detail) el.appendChild(document.createTextNode(` · ${String(detail)}`))
  box.appendChild(el)
  scrollChat()
}

/* ---------- permission requests ---------- */
const permEls = new Map()
const permSeen = new Set()

function permissionScope(action) {
  if (action === "external_directory") return "Outside workspace"
  if (action === "bash") return "Command"
  if (["write", "edit", "multiedit", "apply_patch"].includes(action)) return "File change"
  if (["read", "list", "grep", "glob"].includes(action)) return "Read-only"
  if (String(action || "").startsWith("browser")) return "Browser"
  if (["connector", "mcp"].includes(action)) return "Connector"
  return "Action"
}

async function refreshPermissionRequests() {
  const res = await vibe.listPermissionRequests()
  const list = res.ok ? (Array.isArray(res.data) ? res.data : (res.data?.data ?? [])) : []
  const pending = list.filter((p) => p && p.id && p.sessionID === state.activeSessionID)
  for (const p of pending) {
    if (!p.id) continue
    if (permSeen.has(p.id)) continue
    permSeen.add(p.id)
    const el = document.createElement("div")
    el.className = "perm-card"
    el.innerHTML = `
      <div class="perm-title">🔐 Permission required</div>
      <div class="perm-scope"></div>
      <div class="perm-action"></div>
      <div class="perm-res"></div>
      <div class="perm-actions">
        <button class="save-btn" data-d="once">Allow once</button>
        <button class="save-btn ghost" data-d="always">Always allow</button>
        <button class="danger-btn" data-d="reject">Reject</button>
      </div>`
    el.querySelector(".perm-action").textContent = `${p.action || "action"}`
    el.querySelector(".perm-scope").textContent = permissionScope(p.action)
    el.querySelector(".perm-res").textContent =
      (Array.isArray(p.resources) ? p.resources.join(", ") : p.resource) || ""
    // The agent is blocked -> tell the user, even if the app is in the background
    notifyAgent(
      "Permission needed",
      `${p.action || "action"} — ${(Array.isArray(p.resources) ? p.resources.join(", ") : p.resource) || "the agent is waiting"}`,
    )
    el.querySelectorAll(".perm-actions button").forEach((b) => {
      b.onclick = async () => {
        const decision = b.dataset.d
        const r = await vibe.replyPermission({
          sessionID: p.sessionID,
          requestID: p.id,
          decision,
        })
        if (r.ok) {
          el.classList.add("resolved")
          el.querySelector(".perm-actions").remove()
          el.querySelector(".perm-title").textContent =
            decision === "reject" ? "🚫 Rejected" : "✅ Allowed (" + decision + ")"
          setTimeout(() => el.remove(), 2500)
        } else {
          alert("Permission reply fail: " + (r.error || ""))
        }
        permEls.delete(p.id)
      }
    })
    $("messages").appendChild(el)
    permEls.set(p.id, el)
    scrollChat()

    // Full Access mode -> auto approve everything
    if (pillState.access === "full") {
      await vibe.replyPermission({ sessionID: p.sessionID, requestID: p.id, decision: "always" })
      el.querySelector(".perm-title").textContent = "✅ Auto-approved (Full Access)"
      el.querySelector(".perm-actions").remove()
      setTimeout(() => el.remove(), 2000)
      permEls.delete(p.id)
    }
  }
}

/* ---------- model questions (question tool -> session forms) ---------- */
const qCards = new Map() // formID -> element
const qSeen = new Set()

const Q_MULTI = "multiselect"

function qAnswerLabel(v) {
  if (Array.isArray(v)) return v.join(", ")
  if (v === true) return "Yes"
  if (v === false) return "No"
  return String(v ?? "")
}

function questionCardEl(form) {
  const el = document.createElement("div")
  el.className = "q-card"
  el.dataset.formID = form.id

  const head = document.createElement("div")
  head.className = "q-head"
  head.innerHTML = `<span class="q-ic">❓</span><span class="q-head-title"></span><span class="q-badge">waiting</span>`
  head.querySelector(".q-head-title").textContent = form.title || "Question"
  el.appendChild(head)

  const body = document.createElement("div")
  body.className = "q-body"
  el.appendChild(body)

  const fields = (Array.isArray(form.fields) ? form.fields : []).filter((f) => f && !f.hidden)
  const readers = [] // { key, read() }
  el._titles = new Map(fields.map((f) => [f.key, f.title || f.key]))

  for (const f of fields) {
    const box = document.createElement("div")
    box.className = "q-field"
    box.dataset.key = f.key

    const title = document.createElement("div")
    title.className = "q-title"
    title.textContent = f.title || f.key
    box.appendChild(title)

    if (f.description) {
      const desc = document.createElement("div")
      desc.className = "q-desc"
      desc.textContent = f.description
      box.appendChild(desc)
    }

    // selected option values (or a parsed number/boolean)
    const val = { chosen: [], custom: null, input: null }
    const opts = Array.isArray(f.options) ? f.options : []
    let wrap = null

    if (opts.length) {
      wrap = document.createElement("div")
      wrap.className = "q-opts" + (f.type === Q_MULTI ? " multi" : "")
      for (const o of opts) {
        const value = o.value ?? o.label
        const b = document.createElement("button")
        b.type = "button"
        b.className = "q-opt"
        b.dataset.value = value
        const lbl = document.createElement("span")
        lbl.className = "q-opt-label"
        lbl.textContent = o.label ?? value
        b.appendChild(lbl)
        if (o.description) {
          const d = document.createElement("span")
          d.className = "q-opt-desc"
          d.textContent = o.description
          b.appendChild(d)
        }
        b.onclick = () => {
          if (f.type === Q_MULTI) {
            const i = val.chosen.indexOf(value)
            if (i >= 0) val.chosen.splice(i, 1)
            else val.chosen.push(value)
            b.classList.toggle("on", i < 0)
          } else {
            val.chosen = [value]
            wrap.querySelectorAll(".q-opt").forEach((x) => x.classList.toggle("on", x === b))
          }
          if (val.input) val.input.value = ""
          val.custom = null
          updateFoot()
        }
        wrap.appendChild(b)
      }
      box.appendChild(wrap)
    }

    if (f.type === "boolean") {
      wrap = document.createElement("div")
      wrap.className = "q-opts"
      for (const [txt, boolVal] of [["Yes", true], ["No", false]]) {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "q-opt"
        const lbl = document.createElement("span")
        lbl.className = "q-opt-label"
        lbl.textContent = txt
        b.appendChild(lbl)
        b.onclick = () => {
          val.chosen = [boolVal]
          wrap.querySelectorAll(".q-opt").forEach((x) => x.classList.toggle("on", x === b))
          updateFoot()
        }
        wrap.appendChild(b)
      }
      box.appendChild(wrap)
    } else if (f.type === "integer" || f.type === "number") {
      const inp = document.createElement("input")
      inp.className = "q-custom"
      inp.type = "number"
      if (f.minimum !== undefined) inp.min = f.minimum
      if (f.maximum !== undefined) inp.max = f.maximum
      inp.oninput = () => updateFoot()
      val.input = inp
      box.appendChild(inp)
    } else if (f.custom === true || (!opts.length && f.type === "string")) {
      // "type your own answer" (the question tool sets custom: true)
      const inp = document.createElement("input")
      inp.className = "q-custom"
      inp.type = "text"
      inp.placeholder = opts.length ? "Ba nijer answer lekho…" : f.placeholder || "Answer lekho…"
      inp.oninput = () => {
        val.custom = inp.value
        if (inp.value.trim()) {
          val.chosen = []
          wrap?.querySelectorAll(".q-opt").forEach((x) => x.classList.remove("on"))
        }
        updateFoot()
      }
      val.input = inp
      box.appendChild(inp)
    }

    readers.push({
      key: f.key,
      read() {
        if (f.type === "boolean") return val.chosen.length ? val.chosen[0] : undefined
        if (val.input && (f.type === "integer" || f.type === "number")) {
          const n = Number(val.input.value)
          if (val.input.value === "" || Number.isNaN(n)) return undefined
          return f.type === "integer" ? Math.trunc(n) : n
        }
        const custom = String(val.custom ?? "").trim()
        if (custom) return f.type === Q_MULTI ? [...val.chosen, custom] : custom
        if (f.type === Q_MULTI) return val.chosen.slice()
        return val.chosen[0]
      },
    })

    body.appendChild(box)
  }

  const foot = document.createElement("div")
  foot.className = "q-foot"
  foot.innerHTML = `
    <button class="save-btn q-submit" type="button">Answer</button>
    <button class="danger-btn q-dismiss" type="button">Dismiss</button>
    <span class="q-hint"></span>`
  el.appendChild(foot)

  const submit = foot.querySelector(".q-submit")
  const dismiss = foot.querySelector(".q-dismiss")
  const hint = foot.querySelector(".q-hint")

  function readAnswer() {
    const answer = {}
    for (const r of readers) {
      const v = r.read()
      if (v === undefined || v === null || v === "") continue
      if (Array.isArray(v) && v.length === 0) continue
      answer[r.key] = v
    }
    return answer
  }

  function updateFoot() {
    submit.disabled = Object.keys(readAnswer()).length === 0
    hint.textContent = ""
  }

  submit.onclick = async () => {
    const answer = readAnswer()
    if (!Object.keys(answer).length) {
      hint.textContent = "Pick an option or write your own answer"
      return
    }
    submit.disabled = true
    hint.textContent = "Pathacchi…"
    const r = await vibe.replyForm({
      sessionID: form.sessionID || state.activeSessionID,
      formID: form.id,
      answer,
    })
    if (r.ok) settleQuestionCard(el, "answered", answer)
    else {
      submit.disabled = false
      hint.textContent = "⚠ " + (r.error || "Answer pathate parlam na")
    }
  }

  dismiss.onclick = async () => {
    dismiss.disabled = true
    const r = await vibe.cancelForm({
      sessionID: form.sessionID || state.activeSessionID,
      formID: form.id,
      message: "User dismissed the question",
    })
    if (r.ok) settleQuestionCard(el, "dismissed")
    else {
      dismiss.disabled = false
      hint.textContent = "⚠ " + (r.error || "Dismiss fail")
    }
  }

  updateFoot()
  return el
}

function settleQuestionCard(el, kind, answer) {
  if (!el || el.classList.contains("settled")) return
  el.classList.add("settled", kind)
  const badge = el.querySelector(".q-badge")
  if (badge) badge.textContent = kind === "answered" ? "answered" : "dismissed"
  // the inputs are done — keep only the question + the chosen answer
  el.querySelectorAll(".q-opts").forEach((n) => n.remove())
  el.querySelectorAll(".q-custom").forEach((n) => n.remove())
  el.querySelector(".q-foot")?.remove()
  if (kind === "answered" && answer) {
    const keys = Object.keys(answer)
    const titles = el._titles || new Map()
    const sum = document.createElement("div")
    sum.className = "q-summary"
    for (const k of keys) {
      const row = document.createElement("div")
      row.className = "q-sum-row"
      if (keys.length > 1) {
        const key = document.createElement("span")
        key.className = "q-sum-key"
        key.textContent = titles.get(k) || k
        row.appendChild(key)
      }
      const val = document.createElement("span")
      val.className = "q-sum-val"
      val.textContent = qAnswerLabel(answer[k])
      row.appendChild(val)
      sum.appendChild(row)
    }
    el.appendChild(sum)
  }
}

async function refreshForms() {
  if (!state.activeSessionID) return
  const res = await vibe.listForms({ sessionID: state.activeSessionID })
  if (!res.ok) return
  const list = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const pending = new Set()
  for (const f of list) {
    if (!f || !f.id) continue
    pending.add(f.id)
    if (qSeen.has(f.id)) continue
    qSeen.add(f.id)
    const el = questionCardEl({ ...f, sessionID: f.sessionID || state.activeSessionID })
    $("messages").appendChild(el)
    qCards.set(f.id, el)
    scrollChat()
    // The agent is waiting for an answer -> tell the user, even in background.
    const question = (f.questions && f.questions[0] && (f.questions[0].question || f.questions[0].text)) || ""
    notifyAgent("❓ The agent is asking you", question || "The agent needs an answer to continue.")
  }
  // a form that vanished without us answering was answered/cancelled elsewhere
  for (const [id, el] of [...qCards]) {
    if (pending.has(id)) continue
    if (!el.classList.contains("settled")) settleQuestionCard(el, "dismissed")
    qCards.delete(id)
  }
}

function questionHistoryEl(part) {
  const st = part.state ?? {}
  // Models sometimes send `questions` as a JSON string or a single object; never assume an array.
  const asList = (v) => {
    if (typeof v === "string") { try { v = JSON.parse(v) } catch { return v.trim() ? [{ question: v }] : [] } }
    if (Array.isArray(v)) return v.map((q) => (q && typeof q === "object" ? q : { question: String(q ?? "") }))
    return v && typeof v === "object" ? [v] : []
  }
  const questions = asList(st.input?.questions)
  if (!questions.length) return null
  const rawAnswers = st.metadata?.answers
  const answers = Array.isArray(rawAnswers) ? rawAnswers : (rawAnswers == null ? [] : [rawAnswers])
  const done = st.status === "completed"
  const el = document.createElement("div")
  el.className = "q-card history settled " + (done ? "answered" : "pending")
  const head = document.createElement("div")
  head.className = "q-head"
  head.innerHTML = `<span class="q-ic">❓</span><span class="q-head-title">Questions</span><span class="q-badge"></span>`
  head.querySelector(".q-badge").textContent = done ? "answered" : (st.status || "pending")
  el.appendChild(head)
  const body = document.createElement("div")
  body.className = "q-body"
  questions.forEach((q, i) => {
    const box = document.createElement("div")
    box.className = "q-field"
    const title = document.createElement("div")
    title.className = "q-title"
    title.textContent = q.header || `Question ${i + 1}`
    const desc = document.createElement("div")
    desc.className = "q-desc"
    desc.textContent = q.question || ""
    box.append(title, desc)
    const a = answers[i]
    const row = document.createElement("div")
    row.className = "q-sum-row"
    const key = document.createElement("span")
    key.className = "q-sum-key"
    key.textContent = "answer"
    const val = document.createElement("span")
    val.className = "q-sum-val"
    val.textContent = Array.isArray(a) && a.length ? a.join(", ") : "—"
    row.append(key, val)
    box.appendChild(row)
    body.appendChild(box)
  })
  el.appendChild(body)
  return el
}

/* ---------- OpenCode provider (device login) ---------- */
const ocSub = document.getElementById("opencode-sub")
const ocStDot = document.getElementById("opencode-st-dot")
const ocStText = document.getElementById("opencode-st-text")
const ocConnect = document.getElementById("opencode-connect")
const ocDisconnect = document.getElementById("opencode-disconnect")
const ocDevice = document.getElementById("opencode-device")
const ocDot = document.getElementById("opencode-dot")
const connState = document.getElementById("conn-state")
const connLabel = document.getElementById("connect-label")
let authPoll = null

/* Sidebar "Connect" button -> popover with login / logout */
$("btn-connect").onclick = async (e) => {
  e.stopPropagation()
  const menu = document.getElementById("connect-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  if (wasHidden) {
    menu.hidden = false
    await refreshAuthUI()
  }
}

$("conn-connect").onclick = async () => {
  closeAllMenus()
  connState.textContent = "Sign in in your browser…"
  const res = await vibe.authConnect()
  if (res && res.ok === false) {
    connState.textContent = `Login failed — ${res.error || "unknown error"}`
    return
  }
  if (authPoll) clearInterval(authPoll)
  authPoll = setInterval(refreshAuthUI, 3000)
}

$("conn-logout").onclick = async () => {
  closeAllMenus()
  connState.textContent = "Logging out…"
  if (authPoll) clearInterval(authPoll)
  authPoll = null
  const res = await vibe.authDisconnect()
  const out = (res && res.data) || {}
  const failed = (res && res.ok === false) || (out && out.ok === false)
  if (failed) {
    // Never claim a logout that did not happen: the saved account is still there.
    const why = (res && res.error) || out.error || "The saved account could not be removed"
    showError("OpenCode logout failed", why, { key: "auth" })
    await refreshAuthUI()
    connState.textContent = `Logout failed — ${why}`
    return
  }
  hideError("auth")
  resetOpenCodeModelCache()
  await refreshAuthUI()
  connState.textContent = "Logged out — saved account removed"
}

// A logged-out account must not leave its model cache/selection behind: the
// next account can have a different catalog and the old pick would 404. Models
// of the other providers stay usable.
function resetOpenCodeModelCache() {
  state.models = (state.models || []).filter((m) => m && m.providerID !== "opencode")
  if (String(state.selectedModel || "").startsWith("opencode/")) {
    state.selectedModel = null
    try {
      localStorage.removeItem("vibecoder.model")
    } catch {}
    $("model-label").textContent = "Select model"
  }
}

async function refreshAuthUI() {
  const res = await vibe.authStatus()
  if (res && res.ok === false) {
    // Do not show "Not connected" when the state could not be read at all.
    ocStDot.className = "st-dot off"
    ocStText.textContent = `Status unknown — ${res.error || "the account store is unreachable"}`
    connState.textContent = "Status unknown"
    return
  }
  const connected = !!(res.ok && res.data?.connected)
  if (connected) {
    const who = res.data.email || res.data.org || "account"
    ocSub.textContent = "OpenCode Console account connected"
    ocStDot.className = "st-dot on"
    ocStText.textContent = `Connected — ${who}`
    ocConnect.hidden = true
    ocDisconnect.hidden = false
    ocDevice.hidden = true
    ocDot.classList.add("on")
    connState.textContent = `Connected — ${who}`
    // Sidebar shows the signed-in account (gmail username) instead of "Connect".
    const user = String(res.data.email || "").split("@")[0]
    connLabel.textContent = user || res.data.org || "Connected"
    connLabel.title = res.data.email || who
    if (state.models.length === 0) loadModels().then(() => renderModelList())
  } else {
    ocSub.textContent = "Connect your OpenCode account to use free models"
    ocStDot.className = "st-dot off"
    ocStText.textContent = "Not connected"
    ocConnect.hidden = false
    ocDisconnect.hidden = true
    ocDot.classList.remove("on")
    // Clearing the OpenCode model cache also drops a stale opencode selection,
    // so nothing tries to use the logged-out account's models.
    resetOpenCodeModelCache()
    connState.textContent = "Not connected"
    connLabel.textContent = "Connect"
    connLabel.title = "Connect your OpenCode account"
  }
  const provItems = document.querySelectorAll(".provider-item")
  provItems.forEach((i) =>
    i.classList.toggle("selected", i.dataset.provider === state.selectedProvider),
  )
  // Also update settings nav user
  loadAuthInfo()
}

state.selectedProvider = null

document.querySelector(".provider-item[data-provider=opencode]").onclick = () => {
  state.selectedProvider = "opencode"
  document.querySelector(".md-empty").hidden = true
  document.getElementById("md-opencode").hidden = false
  refreshAuthUI()
}

ocConnect.onclick = async () => {
  ocStDot.className = "st-dot checking"
  ocStText.textContent = "Starting device login…"
  ocDevice.hidden = true
  const res = await vibe.authConnect()
  if (res && res.ok === false) {
    ocStDot.className = "st-dot off"
    ocStText.textContent = `Login failed — ${res.error || "unknown error"}`
    return
  }
  // Poll status every 4s until the flow closes / page refreshes
  if (authPoll) clearInterval(authPoll)
  authPoll = setInterval(refreshAuthUI, 4000)
}

ocDisconnect.onclick = async () => {
  ocStDot.className = "st-dot checking"
  ocStText.textContent = "Disconnecting…"
  if (authPoll) clearInterval(authPoll)
  authPoll = null
  const res = await vibe.authDisconnect()
  const out = (res && res.data) || {}
  const failed = (res && res.ok === false) || (out && out.ok === false)
  if (failed) {
    const why = (res && res.error) || out.error || "The saved account could not be removed"
    showError("OpenCode logout failed", why, { key: "auth" })
    await refreshAuthUI()
    ocStText.textContent = `Logout failed — ${why}`
    return
  }
  hideError("auth")
  resetOpenCodeModelCache()
  ocDevice.hidden = true
  await refreshAuthUI()
}

// Toggles
settingsContent.querySelectorAll(".toggle").forEach((t) => {
  if (t.id === "toggle-notify" || t.id === "toggle-autocontinue" || t.id === "toggle-memory") {
    return // handled below (persisted)
  }
  t.onclick = () => t.classList.toggle("on")
})

/* Background notifications toggle (persisted in localStorage) */
const notifyToggle = $("toggle-notify")
if (notifyToggle) {
  const applyNotifyState = () => {
    const on = notificationsEnabled()
    notifyToggle.classList.toggle("on", on)
    notifyToggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  applyNotifyState()
  notifyToggle.onclick = () => {
    try { localStorage.setItem(NOTIFY_KEY, notificationsEnabled() ? "off" : "on") } catch {}
    applyNotifyState()
  }
  notifyToggle.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      notifyToggle.onclick()
    }
  }
}

/* Auto-continue in the background toggle (persisted in localStorage) */
const autoToggle = $("toggle-autocontinue")
if (autoToggle) {
  const applyAutoState = () => {
    const on = autoContinueEnabled()
    autoToggle.classList.toggle("on", on)
    autoToggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  applyAutoState()
  autoToggle.onclick = () => {
    try { localStorage.setItem(AUTO_CONTINUE_KEY, autoContinueEnabled() ? "off" : "on") } catch {}
    applyAutoState()
  }
  autoToggle.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      autoToggle.onclick()
    }
  }
}
$("btn-test-notify")?.addEventListener("click", async () => {
  try {
    const r = await vibe.notify({ title: "VibeCoder AI", body: "Notifications are working ✅" })
    if (r && r.ok === false) showError("Could not send the notification", r.error || "Unknown error")
  } catch (e) {
    showError("Could not send the notification", String(e))
  }
})

document.getElementById("setting-backend").onchange = async (e) => {
  const res = await vibe.setMode(e.target.value)
  if (!res.ok) {
    alert(res.error)
    e.target.value = state.mode ?? "cli"
  }
}

/* ---------- composer: access mode / project / thinking (dropdown menus) ---------- */
const pillState = {
  access: "ask",
  thinking: "Low",
}

function closeAllMenus() {
  document.querySelectorAll(".drop-menu").forEach((m) => (m.hidden = true))
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) closeAllMenus()
})

const ACCESS_META = {
  ask: { label: "Ask before changes", orange: false },
  full: { label: "Full Access", orange: true },
}

function setAccess(key) {
  pillState.access = key
  const m = ACCESS_META[key]
  $("access-label").textContent = m.label
  $("btn-access").classList.toggle("orange", m.orange)
  document.querySelectorAll("#access-menu .drop-item").forEach((it) =>
    it.classList.toggle("selected", it.dataset.access === key),
  )
  applyPermissionMode()
}

function setThinking(level) {
  pillState.thinking = level
  $("thinking-label").textContent = level === "None" ? "Off" : level
  document.querySelectorAll("#thinking-menu .drop-item").forEach((it) =>
    it.classList.toggle("selected", it.dataset.think === level),
  )
}

function wireMenu(btnID, menuID, onPick) {
  const btn = $(btnID)
  const menu = $(menuID)
  btn.onclick = (e) => {
    e.stopPropagation()
    const wasHidden = menu.hidden
    closeAllMenus()
    menu.hidden = !wasHidden
  }
  menu.querySelectorAll(".drop-item").forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation()
      onPick(item)
      closeAllMenus()
    }
  })
}

wireMenu("btn-access", "access-menu", (item) => setAccess(item.dataset.access))
wireMenu("btn-thinking", "thinking-menu", (item) => setThinking(item.dataset.think))
$("btn-ctx").onclick = async (e) => {
  e.stopPropagation()
  const menu = $("ctx-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  menu.hidden = !wasHidden
  if (!menu.hidden) {
    await Promise.all([loadCompactionSettings({ silent: true }), loadModels()])
    renderCompactionModels()
  }
}
$("ctx-auto-toggle").onclick = async (e) => {
  e.stopPropagation()
  await setAutoCompact(!state.autoCompact)
}
$("ctx-compact-now").onclick = (e) => {
  e.stopPropagation()
  closeAllMenus()
  compactNow({ reason: "manual" })
}

const rewindRows = (response) => response?.ok === false ? [] : (Array.isArray(response?.data) ? response.data : [])
const shortPath = (value) => String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || String(value || "file")

async function refreshRewindMenu() {
  const summary = $("rewind-summary")
  const files = $("rewind-files")
  const stepButton = $("rewind-step")
  const turnButton = $("rewind-turn")
  const redoButton = $("rewind-redo")
  const sessionID = state.activeSessionID
  state.rewindLatestStep = null
  state.rewindLatestTurn = null
  if (!sessionID) {
    summary.textContent = "Open a session to inspect captured changes."
    files.replaceChildren()
    stepButton.disabled = turnButton.disabled = redoButton.disabled = true
    return
  }
  const [stepResult, turnResult, redoResult] = await Promise.all([
    vibe.listStepSnapshots({ sessionID }),
    vibe.listSnapshots({ sessionID }),
    vibe.listRedo({ sessionID }),
  ])
  const steps = rewindRows(stepResult)
  const turns = rewindRows(turnResult)
  const redos = rewindRows(redoResult)
  state.rewindLatestStep = steps[0] || null
  state.rewindLatestTurn = turns[0] || null
  stepButton.disabled = state.running || !state.rewindLatestStep
  turnButton.disabled = state.running || !state.rewindLatestTurn
  redoButton.disabled = state.running || !redos.length
  const target = state.rewindLatestStep || state.rewindLatestTurn
  if (!target) {
    summary.textContent = redos.length ? "Changes are rewound. Redo is available." : "No captured changes in this session."
    files.replaceChildren()
    return
  }
  summary.textContent = target.step
    ? `Latest capture: turn ${target.turn}, step ${target.step}`
    : `Latest capture: turn ${target.turn}`
  const preview = await vibe.previewSnapshot({ sessionID, turn: target.turn, ...(target.step ? { step: target.step } : {}) })
  const rows = preview?.ok === false ? [] : (preview?.data?.files || [])
  files.replaceChildren(...rows.slice(0, 8).map((row) => {
    const el = document.createElement("div")
    el.className = "rewind-file"
    const name = document.createElement("b")
    name.textContent = shortPath(row.path)
    name.title = String(row.path || "")
    const stats = document.createElement("span")
    stats.textContent = row.skipped ? "skipped" : row.binary ? "binary" : `+${Number(row.added) || 0} −${Number(row.removed) || 0}`
    el.append(name, stats)
    return el
  }))
}

async function applyRewind(kind) {
  if (state.running) return showError("Stop the current run first", "Rewind cannot change files while the agent is running.", { key: "rewind" })
  const sessionID = state.activeSessionID
  if (!sessionID) return
  let response
  if (kind === "step") {
    const target = state.rewindLatestStep
    if (!target) return
    response = await vibe.undoStepSession({ sessionID, turn: target.turn, step: target.step })
  } else if (kind === "turn") response = await vibe.undoSession({ sessionID })
  else response = await vibe.redoSession({ sessionID })
  if (!response || response.ok === false) {
    showError("Rewind failed", response?.error || "The requested history state is unavailable.", { key: "rewind" })
    return
  }
  hideError("rewind")
  closeAllMenus()
  await renderSessionHistory(sessionID)
  await refreshSessions()
}

$("btn-rewind").onclick = async (event) => {
  event.stopPropagation()
  const menu = $("rewind-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  menu.hidden = !wasHidden
  if (!menu.hidden) await refreshRewindMenu()
}
$("rewind-menu").onclick = (event) => event.stopPropagation()
$("rewind-step").onclick = () => applyRewind("step")
$("rewind-turn").onclick = () => applyRewind("turn")
$("rewind-redo").onclick = () => applyRewind("redo")
setAccess("ask")
setThinking("Low")
renderAutoCompact()

let projectDir = null
$("chip-project").onclick = async () => {
  const res = await vibe.pickProject()
  if (!res.ok || !res.data) return
  addWorkspace(res.data)
  await vibe.setDirectory(res.data.directory)
  ensureProjectAgent(res.data.directory)
  await refreshSessions()
}

/* ---------- attachments ---------- */
const attachments = []

/** true/false when the selected model is known, null when it is not in the list. */
function selectedModelImageSupport() {
  const key = state.selectedModel
  if (!key) return null
  const list = Array.isArray(state.models) ? state.models : []
  const hit = list.find((m) => `${m.providerID}/${m.id}` === key)
  return hit ? !!hit.image : null
}

function renderAttachments() {
  const tray = $("attach-tray")
  tray.innerHTML = ""
  tray.hidden = attachments.length === 0
  for (const a of attachments) {
    const chip = document.createElement("span")
    chip.className = "attach" + (a.kind === "image" ? " image" : "")
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img")
      img.className = "thumb"
      img.src = a.dataUrl
      img.alt = a.name
      chip.appendChild(img)
    } else {
      const ic = document.createElement("span")
      ic.className = "att-ic"
      ic.textContent = "📄"
      chip.appendChild(ic)
    }
    const nm = document.createElement("span")
    nm.className = "nm"
    nm.textContent = a.name || (a.path || "").split(/[\\/]/).pop()
    nm.title = a.path || a.name
    const rm = document.createElement("button")
    rm.className = "rm"
    rm.textContent = "✕"
    rm.title = "Remove"
    rm.onclick = () => {
      const i = attachments.indexOf(a)
      if (i >= 0) attachments.splice(i, 1)
      renderAttachments()
    }
    chip.append(nm, rm)
    tray.appendChild(chip)
  }
  if (attachments.some((a) => a.kind === "image")) {
    const hint = document.createElement("span")
    hint.className = "att-hint"
    const canSee = selectedModelImageSupport()
    hint.textContent =
      canSee === false
        ? "⚠ this model is not marked vision-capable — pick one with 👁 IMAGES"
        : "image — the model can see this"
    tray.appendChild(hint)
  }
}

function addAttachments(list) {
  for (const a of list) {
    if (!a) continue
    if (attachments.some((x) => x.path === a.path)) continue
    attachments.push(a)
  }
  renderAttachments()
}

$("btn-attach").onclick = async () => {
  const res = await vibe.pickAttachments()
  if (!res.ok) return alert(res.error)
  const items = []
  for (const p of res.data) {
    const r = await vibe.readAttachment(p)
    if (r.ok) items.push(r.data)
    else items.push({ path: p, name: p.split(/[\\/]/).pop(), kind: "file" })
  }
  addAttachments(items)
}

/* ---------- top buttons (visual for now) ---------- */
for (const [id, msg] of [
  ["btn-devices", "Devices: coming soon"],
]) {
  const el = $(id)
  if (el) el.onclick = () => alert(msg)
}

renderSessions()
refreshSessions()
loadCompactionSettings({ silent: true })
/* ---------- splash screen (logo + pulse) ---------- */
const splash = $("splash")
if (splash) {
  // keep it visible for a short moment so the user sees the animation
  setTimeout(() => {
    splash.classList.add("hidden")
    setTimeout(() => { splash.hidden = true }, 350)
  }, 800)
}

/* ---------- built-in browser (right dock, one browser for everything) ----------
   OpenCode-style tabs inside the app: links from the chat, URLs the agent prints
   and anything the user types land here, never in an outside window. Tabs and
   the open state survive a restart. */
const BR_KEY = "vibecoder.browser"
const brPanel = $("browser-panel")
const brBody = $("browser-body")
const brTabsEl = $("br-tabs")
const brUrl = $("br-url")
const brProgress = $("br-progress")
const brEmpty = $("browser-empty")
const brTabs = new Map() // id -> { id, view, url, title, loading }
let brActive = ""
let brRestored = false

function readBrowserPrefs() {
  try {
    return JSON.parse(localStorage.getItem(BR_KEY) || "{}") || {}
  } catch {
    return {}
  }
}

function saveBrowserPrefs(patch) {
  try {
    localStorage.setItem(BR_KEY, JSON.stringify({ ...readBrowserPrefs(), ...patch }))
  } catch {}
}

/** "localhost:3000" -> http://localhost:3000, "example.com" -> https://..., text -> search. */
function browserUrl(text) {
  const s = String(text || "").trim()
  if (!s) return ""
  if (/^(https?|file|data|about):/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/i.test(s)) return "http://" + s
  if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(:\d+)?(\/|$)/.test(s)) return "http://" + s
  if (/^[\w-]+(\.[\w-]+)+((:\d+)?(\/|$|\?))/.test(s)) return "https://" + s
  return "https://duckduckgo.com/?q=" + encodeURIComponent(s)
}

/** Width limits of the dock: the sidebar (260px) and ~420px of chat always stay visible. */
function brWidthBounds() {
  const min = 300
  const max = Math.max(min, window.innerWidth - 260 - 420)
  return { min, max }
}

function brSetWidth(px) {
  if (!brPanel) return 0
  const { min, max } = brWidthBounds()
  const w = Math.round(Math.min(max, Math.max(min, Number(px) || 0)))
  brPanel.style.width = w + "px"
  return w
}

function brRestoreWidth() {
  const w = Number(readBrowserPrefs().width)
  if (Number.isFinite(w) && w > 0) brSetWidth(w)
}

function brSaveState() {
  saveBrowserPrefs({
    open: !!brPanel && !brPanel.hidden,
    activeId: brActive,
    tabs: [...brTabs.values()].map((t) => ({ id: t.id, url: t.url || "", title: t.title || "" })),
  })
}

function brRenderTabs() {
  if (!brTabsEl) return
  brTabsEl.innerHTML = ""
  for (const tab of brTabs.values()) {
    const el = document.createElement("div")
    el.className = "browser-tab" + (tab.id === brActive ? " active" : "")
    el.title = tab.url || tab.title || "New tab"
    const name = document.createElement("span")
    name.className = "br-tab-title"
    name.textContent = tab.title || tab.url || "New tab"
    const x = document.createElement("button")
    x.className = "br-tab-x"
    x.type = "button"
    x.title = "Close tab"
    x.textContent = "✕"
    x.addEventListener("click", (e) => {
      e.stopPropagation()
      brCloseTab(tab.id)
    })
    el.append(name, x)
    el.addEventListener("click", () => brActivate(tab.id))
    el.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      brCloseTab(tab.id)
    })
    brTabsEl.append(el)
  }
}

function brUpdateChrome() {
  const tab = brTabs.get(brActive)
  if (brUrl) brUrl.value = tab && tab.url && tab.url !== "about:blank" ? tab.url : ""
  if (brProgress) brProgress.hidden = !(tab && tab.loading)
  if (brEmpty) brEmpty.hidden = brTabs.size > 0
  const reload = $("br-reload")
  if (reload) reload.title = tab && tab.loading ? "Stop loading" : "Reload"
}

function brActivate(id) {
  if (!brTabs.has(id)) return
  brActive = id
  for (const t of brTabs.values()) {
    if (t.view) t.view.classList.toggle("active", t.id === id)
  }
  brRenderTabs()
  brUpdateChrome()
  brSaveState()
  const tab = brTabs.get(id)
  try {
    tab.view.focus()
  } catch {}
}

function brBindTab(tab) {
  const view = tab.view
  const isActive = () => brActive === tab.id
  const setUrl = (url) => {
    if (!url || url === "about:blank") return
    tab.url = url
    if (isActive() && brUrl) brUrl.value = url
    brSaveState()
  }
  view.addEventListener("did-start-loading", () => {
    tab.loading = true
    if (isActive()) brUpdateChrome()
  })
  view.addEventListener("did-stop-loading", () => {
    tab.loading = false
    try {
      const u = view.getURL()
      if (u && u !== "about:blank") tab.url = u
    } catch {}
    if (!tab.title && tab.url) tab.title = ""
    if (isActive()) brUpdateChrome()
    brRenderTabs()
    brSaveState()
  })
  view.addEventListener("did-navigate", (e) => setUrl(e && e.url))
  view.addEventListener("did-navigate-in-page", (e) => setUrl(e && e.url))
  view.addEventListener("page-title-updated", (e) => {
    tab.title = String((e && e.title) || "").slice(0, 120)
    brRenderTabs()
    brSaveState()
  })
  view.addEventListener("did-fail-load", (e) => {
    tab.loading = false
    if (isActive()) brUpdateChrome()
    if (!e || e.errorCode === -3) return // -3 = the user stopped the load
    if (e.isMainFrame === false) return
    showError(
      "The page could not be loaded",
      `${e.errorDescription || "error"} (${e.errorCode})\n${e.validatedURL || tab.url || ""}`,
      { key: "br-" + tab.id },
    )
  })
}

function brCreateTab(url, opts = {}) {
  const id = opts.id || "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  if (brTabs.has(id)) return brTabs.get(id)
  const view = document.createElement("webview")
  view.className = "browser-view"
  view.setAttribute("partition", "persist:vibecoder-browser")
  const initial = url && url !== "about:blank" ? url : ""
  const tab = { id, view, url: initial, title: "", loading: false }
  brTabs.set(id, tab)
  brBindTab(tab)
  if (brBody) brBody.append(view)
  try {
    view.setAttribute("src", url && url !== "about:blank" ? url : "about:blank")
  } catch {}
  if (opts.activate !== false) brActivate(id)
  else {
    brRenderTabs()
    brUpdateChrome()
  }
  return tab
}

/** Wait until Electron has attached a webview guest so the main process can control the same visible page. */
async function brGetContentsId(view, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const id = Number(view && view.getWebContentsId && view.getWebContentsId())
      if (Number.isInteger(id) && id > 0) return id
    } catch (e) { lastError = e }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("The in-app browser page did not attach to Electron in time" + (lastError ? `: ${lastError.message}` : ""))
}

function brRestoreTabs() {
  if (brRestored) return
  brRestored = true
  const prefs = readBrowserPrefs()
  let list = Array.isArray(prefs.tabs) ? prefs.tabs : []
  // Older state kept a single address.
  if (!list.length && prefs.url) list = [{ id: "t-restored", url: prefs.url, title: "" }]
  for (const t of list) {
    if (!t || !t.id) continue
    const tab = brCreateTab(t.url || "about:blank", { id: String(t.id), activate: false })
    if (tab && t.title) tab.title = String(t.title)
  }
  const wanted = prefs.activeId && brTabs.has(prefs.activeId) ? prefs.activeId : [...brTabs.keys()][0] || ""
  if (wanted) brActivate(wanted)
  brRenderTabs()
  brUpdateChrome()
}

function brCloseTab(id) {
  const tab = brTabs.get(id)
  if (!tab) return
  const ids = [...brTabs.keys()]
  const idx = ids.indexOf(id)
  try {
    tab.view.remove()
  } catch {}
  brTabs.delete(id)
  if (brActive === id) {
    const next = ids[idx + 1] || ids[idx - 1] || ""
    brActive = brTabs.has(next) ? next : ""
    if (brActive) {
      brActivate(brActive)
      return
    }
  }
  brRenderTabs()
  brUpdateChrome()
  brSaveState()
}

function brNewTab(url) {
  if (brPanel) brPanel.hidden = false
  brRestoreTabs()
  brCreateTab(url || "about:blank")
  if (brUrl) {
    setTimeout(() => {
      try {
        brUrl.focus()
        brUrl.select()
      } catch {}
    }, 50)
  }
}

function brGo(text) {
  const target = browserUrl(text)
  if (!target) return
  const tab = brTabs.get(brActive)
  if (!tab) {
    brCreateTab(target)
    return
  }
  tab.url = target
  if (brEmpty) brEmpty.hidden = true
  brUpdateChrome()
  brSaveState()
  try {
    tab.view.loadURL(target)
  } catch (e) {
    showError("The page could not be opened", String(e && e.message ? e.message : e), { key: "br-" + tab.id })
  }
}

/** Opens the browser with a page (a new tab unless it is still empty). */
function openBrowser(url, opts = {}) {
  if (!brPanel) return
  const wasHidden = brPanel.hidden
  brPanel.hidden = false
  brRestoreWidth()
  brRestoreTabs()
  if (url) {
    const target = browserUrl(url)
    if (target) {
      const active = brTabs.get(brActive)
      if (opts.newTab || wasHidden || !active || active.url) brCreateTab(target)
      else {
        brActivate(active.id)
        brGo(target)
      }
    }
  } else if (!brTabs.size) {
    brCreateTab("about:blank")
  } else {
    brUpdateChrome()
  }
  brSaveState()
  if (opts.focus !== false) {
    setTimeout(() => {
      try {
        brUrl.focus()
        brUrl.select()
      } catch {}
    }, 50)
  }
}

function closeBrowser() {
  if (!brPanel) return
  brPanel.hidden = true
  brSaveState()
}

function toggleBrowser(url) {
  if (!brPanel) return
  if (!brPanel.hidden && !url) closeBrowser()
  else openBrowser(url)
}

$("chip-browser")?.addEventListener("click", () => toggleBrowser())
$("br-close")?.addEventListener("click", closeBrowser)
$("br-new")?.addEventListener("click", () => brNewTab())
$("br-reload")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.loading) tab.view.stop()
    else tab.view.reload()
  } catch {}
})
$("br-back")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.view.canGoBack()) tab.view.goBack()
  } catch {}
})
$("br-fwd")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.view.canGoForward()) tab.view.goForward()
  } catch {}
})
$("br-external")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  const url = (tab && tab.url) || brUrl?.value || ""
  if (url && vibe.openExternal) vibe.openExternal({ url })
})
brUrl?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return
  e.preventDefault()
  brGo(brUrl.value)
})
document.querySelectorAll(".browser-quick [data-url]").forEach((btn) => {
  btn.addEventListener("click", () => brNewTab(btn.dataset.url))
})
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (!mod || !e.shiftKey) return
  const key = String(e.key).toLowerCase()
  if (key === "b") {
    e.preventDefault()
    toggleBrowser()
  } else if (key === "t" && brPanel && !brPanel.hidden) {
    e.preventDefault()
    brNewTab()
  }
})

/* Drag the left edge of the browser to resize it (width is remembered). */
const brResize = $("br-resize")
const brShield = $("br-shield")
if (brResize && brShield && brPanel) {
  brResize.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = brPanel.getBoundingClientRect().width
    let width = startW
    brResize.classList.add("dragging")
    brPanel.classList.add("resizing")
    brShield.hidden = false
    document.body.style.userSelect = "none"
    const move = (ev) => {
      const { min, max } = brWidthBounds()
      width = Math.min(max, Math.max(min, startW - (ev.clientX - startX)))
      brPanel.style.width = Math.round(width) + "px"
    }
    const up = () => {
      brShield.hidden = true
      brResize.classList.remove("dragging")
      brPanel.classList.remove("resizing")
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      saveBrowserPrefs({ width: Math.round(width) })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  })
  brResize.addEventListener("dblclick", () => {
    brPanel.style.width = ""
    saveBrowserPrefs({ width: 0 })
  })
}
window.addEventListener("resize", () => {
  if (!brPanel || brPanel.hidden || !brPanel.style.width) return
  brSetWidth(brPanel.getBoundingClientRect().width)
})

/* ---------- startup ---------- */
loadModelLabel()
loadAuthInfo()
loadWorkspaces()
restoreActiveProject()
refreshAuthUI()
refreshCliStatus()
// The browser panel is the app's one browser: reopen the tabs of the last run.
if (readBrowserPrefs().open) setTimeout(() => openBrowser(undefined, { focus: false }), 0)
// The provider states (on / off) are needed by the model picker.
if (vibe.providerList) loadProviders({ silent: true })
// The task list of the last run (the agent continues with it).
loadTodos()
// The agent's memory file: needed so it can save facts without asking.
if (vibe.memoryPath) {
  Promise.resolve(vibe.memoryPath())
    .then((res) => {
      state.memoryFile = res?.data || ""
      // the memory permissions are part of the session rule set -> re-apply
      // them once the path is known (the first session may exist already)
      if (state.memoryFile) applyPermissionMode()
    })
    .catch(() => {})
}
// The CLI auth probe can be slow/fail on a cold start — retry once so the
// sidebar account name always appears for a logged-in user.
setTimeout(() => {
  refreshAuthUI()
  loadAuthInfo()
}, 3000)

// Test hook for the offline UI tests (must be at the end: every state it
// touches has to be declared by now).
window.__testProviderState = providerState

/* Compaction UI is handled by the canonical session.compaction.* event listener above. */

/* ---------- agent control for the visible in-app browser dock ---------- */
if (vibe && typeof vibe.onBrowserCommand === "function") {
  vibe.onBrowserCommand((command) => {
    const requestId = String(command && command.requestId || "")
    const action = String(command && command.action || "")
    const args = command && command.args && typeof command.args === "object" ? command.args : {}
    Promise.resolve().then(async () => {
      if (!brPanel || !brBody) throw new Error("The in-app browser dock is not available")
      if (["createTab", "activateTab", "navigate"].includes(action)) brPanel.hidden = false
      brRestoreTabs()

      if (action === "listTabs") {
        const rows = []
        for (const tab of brTabs.values()) {
          let contentsId = 0
          try { contentsId = await brGetContentsId(tab.view) } catch {}
          try {
            const actual = tab.view.getURL()
            if (actual) tab.url = actual
          } catch {}
          rows.push({ id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, generation: Number(tab.generation) || 0, contentsId })
        }
        return rows
      }

      if (action === "createTab") {
        const id = String(args.id || "")
        if (!id) throw new Error("A tab ID is required")
        if (brTabs.has(id)) throw new Error(`Browser tab ${id} already exists`)
        const tab = brCreateTab(String(args.url || "about:blank"), { id, activate: true })
        const contentsId = await brGetContentsId(tab.view)
        return { id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, contentsId }
      }

      if (action === "closeTab") {
        const id = String(args.tabID || "")
        if (!brTabs.has(id)) throw new Error(`Browser tab ${id || "(missing)"} not found`)
        brCloseTab(id)
        return { closed: true, tabID: id }
      }

      if (action === "activateTab") {
        const id = String(args.tabID || "")
        if (!brTabs.has(id)) throw new Error(`Browser tab ${id || "(missing)"} not found`)
        brPanel.hidden = false
        brActivate(id)
        const tab = brTabs.get(id)
        const contentsId = await brGetContentsId(tab.view)
        return { id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, contentsId }
      }

      throw new Error(`Unsupported browser bridge action: ${action}`)
    }).then(
      (data) => vibe.browserCommandResult({ requestId, ok: true, data }),
      (error) => vibe.browserCommandResult({ requestId, ok: false, error: String(error && error.message || error) }),
    ).catch(() => {})
  })
}
