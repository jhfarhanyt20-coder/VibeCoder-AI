"use strict"
/**
 * Shell job registry (OpenCode-style).
 *
 * Every shell command - foreground or background - is a job with:
 *   - a file-backed combined stdout/stderr log (`~/.vibe/shell/<session>/<id>.out`),
 *   - a status (running / completed / error / cancelled),
 *   - a `done` promise and a `backgrounded` promise.
 *
 * A foreground call can be moved to the background while it runs (Ctrl+B in the
 * app, or automatically when its timeout expires). The process keeps running,
 * the tool call returns immediately, and the caller is notified when it ends.
 * Background jobs are never killed by the run's abort signal.
 */
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")
const { newId, homeDir } = require("./util")

const KEEP_OUTPUT = 64 * 1024 // per-job in-memory tail (full output stays in the file)
const EXITED_LIMIT = 25 // settled jobs kept for status/output lookups
const jobs = new Map()

function shellDir(sessionID) {
  const safe = String(sessionID || "global").replace(/[^\w.-]+/g, "_").slice(0, 80) || "global"
  const dir = path.join(homeDir(), "shell", safe)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {}
  return dir
}

function killTree(child) {
  if (!child || !child.pid) return
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
}

function clipTail(s, n) {
  const t = String(s == null ? "" : s)
  return t.length <= n ? t : t.slice(-n)
}

/** Keep the settled-job history bounded without losing running jobs. */
function trimHistory() {
  const settled = [...jobs.values()].filter((j) => j.status !== "running")
  settled.sort((a, b) => (a.completed || 0) - (b.completed || 0))
  for (const j of settled.slice(0, Math.max(0, settled.length - EXITED_LIMIT))) jobs.delete(j.id)
}

/**
 * Spawn one shell command. Returns a handle:
 *   { id, file, info(), done, backgrounded, background(), cancel() }
 * `done` resolves with the final info; `backgrounded` resolves as soon as the
 * job is moved to the background (it does not stop the process).
 */
function createShell({ sessionID, command, cwd, background = false, env, emit } = {}) {
  const id = newId("sh")
  const win = process.platform === "win32"
  const file = path.join(shellDir(sessionID), id + ".out")
  const job = {
    id,
    type: "shell",
    sessionID,
    command: String(command || ""),
    cwd: cwd || process.cwd(),
    file,
    status: "running",
    started: Date.now(),
    completed: 0,
    exit: undefined,
    signal: undefined,
    backgrounded: !!background,
    output: "",
    size: 0,
    cancelled: false,
    emit: typeof emit === "function" ? emit : null,
  }

  let doneResolve
  const done = new Promise((r) => (doneResolve = r))
  let bgResolve
  const backgrounded = new Promise((r) => (bgResolve = r))
  let stream = null
  let settled = false

  const info = () => jobInfo(job)

  // Let background()/backgroundSession() (called by id) wake the tool's race.
  job.backgroundResolve = () => {
    if (bgResolve) bgResolve(info())
  }

  const settle = (status, code, signal) => {
    if (settled) return
    settled = true
    job.status = status
    job.exit = code == null ? undefined : code
    job.signal = signal || undefined
    job.completed = Date.now()
    try {
      if (stream) stream.end()
    } catch {}
    trimHistory()
    doneResolve(info())
  }

  let child
  try {
    const args = win ? ["-NoProfile", "-NonInteractive", "-Command", String(command || "")] : ["-lc", String(command || "")]
    child = spawn(win ? "powershell.exe" : "bash", args, {
      cwd: job.cwd,
      // A background job must survive an interrupt of the agent run. On POSIX a
      // detached process group also lets us kill the whole tree.
      detached: !win,
      windowsHide: true,
      env: { ...process.env, ...(env || {}) },
    })
    job.pid = child.pid
  } catch (e) {
    job.output = `Failed to start shell: ${e.message}`
    job.status = "error"
    job.completed = Date.now()
    doneResolve(info())
    backgroundedResolveNoop()
    return handle()
  }

  try {
    stream = fs.createWriteStream(file, { flags: "w" })
    stream.on("error", () => {})
  } catch {}

  const add = (d) => {
    const text = d.toString()
    job.output = clipTail(job.output + text, KEEP_OUTPUT)
    job.size += Buffer.byteLength(text)
    try {
      stream && stream.write(text)
    } catch {}
  }
  child.stdout.on("data", add)
  child.stderr.on("data", add)

  child.on("error", (e) => {
    job.output = clipTail(job.output + `\nFailed to start shell: ${e.message}`, KEEP_OUTPUT)
    settle("error")
  })
  child.on("close", (code, signal) => {
    // A user cancel already recorded "cancelled"; keep that status.
    if (job.cancelled) settle("cancelled", code, signal)
    else settle(code === 0 ? "completed" : "error", code, signal)
  })

  jobs.set(id, job)

  function backgroundedResolveNoop() {
    if (bgResolve) bgResolve(info())
  }

  function handle() {
    return {
      id,
      file,
      job,
      info,
      done,
      backgrounded,
      /** Move the running job to the background (no-op once it finished). */
      background() {
        job.backgrounded = true
        if (bgResolve) bgResolve(info())
        if (job.status !== "running") return info()
        return info()
      },
      /** Stop this job (and its child tree). */
      cancel() {
        job.cancelled = true
        if (job.status === "running") killTree(child)
        return info()
      },
    }
  }

  return handle()
}

/** Move one job to the background. */
function background(id) {
  const job = jobs.get(id)
  if (!job) return undefined
  job.backgrounded = true
  if (typeof job.backgroundResolve === "function") job.backgroundResolve()
  return jobInfo(job)
}

/** Move every blocking shell job of a session to the background (Ctrl+B). */
function backgroundSession(sessionID, type = "shell") {
  const moved = []
  for (const job of jobs.values()) {
    if (job.sessionID !== sessionID) continue
    if (type && job.type !== type) continue
    if (job.status !== "running") continue
    job.backgrounded = true
    if (typeof job.backgroundResolve === "function") job.backgroundResolve()
    moved.push(jobInfo(job))
  }
  return moved
}

function jobInfo(job) {
  return {
    id: job.id,
    type: job.type,
    sessionID: job.sessionID,
    command: job.command,
    cwd: job.cwd,
    file: job.file,
    status: job.status,
    started: job.started,
    ...(job.completed ? { completed: job.completed } : {}),
    ...(job.exit !== undefined ? { exit: job.exit } : {}),
    ...(job.signal !== undefined ? { signal: job.signal } : {}),
    backgrounded: job.backgrounded,
    size: job.size,
  }
}

function get(id) {
  const job = jobs.get(id)
  return job ? jobInfo(job) : undefined
}

function list(sessionID) {
  return [...jobs.values()]
    .filter((j) => !sessionID || j.sessionID === sessionID)
    .map(jobInfo)
}

/** The last `max` characters of a job's output (in-memory tail while running). */
function output(id, max = 30000) {
  const job = jobs.get(id)
  if (!job) return undefined
  return clipTail(job.output, Math.max(1, Number(max) || 30000))
}

/**
 * Move a job to the background and return promises that the shell tool can race.
 * The job's `handle` already exposes these; this is for callers that only have
 * an id (backend/UI).
 */
function cancel(id) {
  const job = jobs.get(id)
  if (!job) return undefined
  job.cancelled = true
  if (job.status === "running" && job.pid) {
    try {
      if (process.platform === "win32") spawn("taskkill", ["/PID", String(job.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
      else process.kill(-job.pid, "SIGKILL")
    } catch {}
  }
  return jobInfo(job)
}

function cancelSession(sessionID) {
  const out = []
  for (const job of [...jobs.values()]) {
    if (job.sessionID === sessionID && job.status === "running") out.push(cancel(job.id))
  }
  return out
}

function cancelAll() {
  for (const job of [...jobs.values()]) if (job.status === "running") cancel(job.id)
}

function size() {
  return jobs.size
}

module.exports = {
  createShell,
  background,
  backgroundSession,
  get,
  list,
  output,
  cancel,
  cancelSession,
  cancelAll,
  size,
  killTree,
  KEEP_OUTPUT,
}
