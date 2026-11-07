"use strict"

/**
 * Windows PowerShell 5.1 has no `&&`. Models write it constantly, so rewrite a
 * top-level `a && b && c` into `a; if ($?) { b; if ($?) { c } }`. Anything inside
 * quotes, here-strings or (), {}, [] is left alone, so `python -c "a && b"` is safe.
 */
function psChain(cmd) {
  if (!cmd.includes("&&")) return cmd
  const parts = []
  let depth = 0, quote = "", last = 0
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === "`" && quote === '"') i++
      else if (ch === quote) quote = ""
      continue
    }
    if (ch === "`") { i++; continue }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === "(" || ch === "{" || ch === "[") depth++
    else if (ch === ")" || ch === "}" || ch === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === "&" && cmd[i + 1] === "&") {
      parts.push(cmd.slice(last, i).trim())
      last = i + 2
      i++
    }
  }
  if (!parts.length) return cmd
  parts.push(cmd.slice(last).trim())
  if (parts.some((x) => !x)) return cmd
  return parts.reduceRight((acc, seg, idx) => (acc === null ? seg : idx === parts.length - 1 ? seg : `${seg}; if ($?) { ${acc} }`), null)
}

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
const { StringDecoder } = require("string_decoder")
const { newId, homeDir } = require("./util")

// PowerShell 5.1 serializes its own error/warning records as CLIXML when the
// script arrives through -EncodedCommand. Native tool output stays plain text.
// Decode those records back to readable lines so neither the UI nor the agent
// ever sees XML envelopes in the terminal stream.
const CLIXML_HEAD = "#< CLIXML"
const XML_ENTITIES = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }

function xmlUnescape(text) {
  return String(text || "")
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name) => XML_ENTITIES[name])
}

function decodeClixmlRecords(buffer) {
  const out = []
  const record = /<S S="[^"]*">([\s\S]*?)<\/S>/g
  let match
  while ((match = record.exec(buffer))) out.push(xmlUnescape(match[1]))
  return out.join("")
}

const KEEP_OUTPUT = 64 * 1024 // per-job in-memory tail (full output stays in the file)
const EXITED_LIMIT = 25 // settled jobs kept for status/output lookups
const LIVE_OUTPUT_LIMIT = 16 * 1024 // one renderer event can never grow without bound
const LIVE_OUTPUT_DELAY = 40 // coalesce noisy processes without making output feel delayed
const INPUT_LIMIT = 64 * 1024 // one stdin write; prevents accidental unbounded IPC payloads
const PROGRESS_INTERVAL = 90 * 1000 // long-running jobs report progress at most this often
const PROMPT_QUIET = 1500 // a blocking job is moved to the background only after its prompt stays put
const ENCODED_LIMIT = 28000 // Windows caps one process command line at 32767 chars
const jobs = new Map()

function inputPrompt(output) {
  const tail = String(output || "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .slice(-2000)
    .trimEnd()
  const asks = [
    /press any key to continue[^\n]*$/i,
    /press (?:enter|return) to continue[^\n]*$/i,
    /(?:are you sure|continue|proceed|overwrite|replace)[^\n]{0,100}(?:\?|\[[yn]\/[^\]]+\]|\([yn]\/[yn]\))\s*$/i,
    /(?:password|passphrase|verification code|one[- ]time (?:code|password))\s*:\s*$/i,
    /(?:enter|type) [^\n:]{1,80}\s*:\s*$/i,
  ]
  return asks.some((pattern) => pattern.test(tail)) ? tail : ""
}

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
function createShell({ sessionID, command, cwd, background = false, env, emit, toolCallId, description, intent, onSettled, onWaiting, onProgress } = {}) {
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
    toolCallId: toolCallId || undefined,
    description: String(description || "").slice(0, 500),
    intent: String(intent || "").slice(0, 2000),
    onSettled: typeof onSettled === "function" ? onSettled : null,
    onWaiting: typeof onWaiting === "function" ? onWaiting : null,
    onProgress: typeof onProgress === "function" ? onProgress : null,
    lastProgress: 0,
    autoBackgroundTimer: null,
    waitingForInput: false,
    waitingPrompt: "",
    waitingUiSignature: "",
    waitingDurableSignature: "",
    stdin: null,
    stdinEnded: false,
  }

  let doneResolve
  const done = new Promise((r) => (doneResolve = r))
  let bgResolve
  const backgrounded = new Promise((r) => (bgResolve = r))
  let stream = null
  let settled = false
  let liveBuffer = ""
  let liveTimer = null
  let scriptFile = null

  const info = () => jobInfo(job)

  const notifyWaiting = () => {
    const prompt = inputPrompt(job.output)
    if (!prompt) return
    const signature = prompt.replace(/\s+/g, " ").trim().slice(-500)
    job.waitingForInput = true
    job.waitingPrompt = prompt
    if (job.backgrounded && job.onWaiting) {
      if (job.waitingDurableSignature === signature) return
      job.waitingDurableSignature = signature
      try { job.onWaiting(info(), prompt, clipTail(job.output, 30000)) } catch {}
      return
    }
    if (job.waitingUiSignature !== signature && job.emit) {
      job.waitingUiSignature = signature
      try { job.emit({ type: "shell.waiting", shell: info(), prompt }) } catch {}
    }
    // A blocking command that sits at "Press any key", a Y/N question or a
    // credential prompt can never finish on its own. Move it to the background
    // once the prompt has stayed quiet, so the tool call returns and the agent
    // can read the output and answer with shellInput.
    if (job.backgrounded || job.autoBackgroundTimer || job.status !== "running") return
    job.autoBackgroundTimer = setTimeout(() => {
      job.autoBackgroundTimer = null
      if (job.status !== "running" || job.backgrounded) return
      if (!inputPrompt(job.output)) return
      job.backgrounded = true
      if (typeof job.backgroundResolve === "function") job.backgroundResolve()
      notifyWaiting()
    }, PROMPT_QUIET)
    if (typeof job.autoBackgroundTimer.unref === "function") job.autoBackgroundTimer.unref()
  }
  job.notifyWaiting = notifyWaiting

  // Long background jobs report their live tail periodically so the agent can
  // understand what the process is doing without the user copying a terminal.
  const maybeProgress = () => {
    if (!job.backgrounded || !job.onProgress || job.status !== "running") return
    const now = Date.now()
    if (!job.lastProgress) job.lastProgress = job.started
    if (now - job.lastProgress < PROGRESS_INTERVAL || !job.output) return
    job.lastProgress = now
    try { job.onProgress(info(), clipTail(job.output, 12000)) } catch {}
  }

  // Let background()/backgroundSession() (called by id) wake the tool's race.
  job.backgroundResolve = () => {
    if (bgResolve) bgResolve(info())
  }

  const flushLive = () => {
    if (liveTimer) clearTimeout(liveTimer)
    liveTimer = null
    if (!liveBuffer || !job.emit) { liveBuffer = ""; return }

    // Never truncate a burst to fit one renderer event. The old tail-clipping
    // behavior silently discarded the *beginning* of fast build/compiler output
    // whenever more than LIVE_OUTPUT_LIMIT characters arrived inside one batch.
    // Split the complete stream into bounded events instead, preserving order.
    while (liveBuffer.length) {
      let cut = Math.min(LIVE_OUTPUT_LIMIT, liveBuffer.length)
      // Avoid splitting a UTF-16 surrogate pair at an event boundary.
      if (cut < liveBuffer.length) {
        const last = liveBuffer.charCodeAt(cut - 1)
        const next = liveBuffer.charCodeAt(cut)
        if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) cut++
      }
      const delta = liveBuffer.slice(0, cut)
      liveBuffer = liveBuffer.slice(cut)
      try { job.emit({ type: "shell.output", shell: info(), delta }) } catch {}
    }
  }

  const settle = (status, code, signal) => {
    if (settled) return
    settled = true
    if (job.autoBackgroundTimer) clearTimeout(job.autoBackgroundTimer)
    job.autoBackgroundTimer = null
    flushLive()
    job.status = status
    job.exit = code == null ? undefined : code
    job.signal = signal || undefined
    job.completed = Date.now()
    job.stdinEnded = true
    job.waitingForInput = false
    try {
      if (stream) stream.end()
    } catch {}
    if (scriptFile) {
      try { fs.unlinkSync(scriptFile) } catch {}
      scriptFile = null
    }
    trimHistory()
    doneResolve(info())
    if (job.onSettled) {
      try { job.onSettled(info(), clipTail(job.output, 30000)) } catch {}
    }
  }

  let child
  try {
    // PowerShell 5.1 inherits legacy console encodings on many Windows installs.
    // Explicit UTF-8 keeps native-tool output readable by the agent and renderer.
    // EncodedCommand also avoids quoting/injection edge cases when user paths or
    // scripts contain quotes, newlines, or non-ASCII characters.
    const powershellScript = win
      ? [
          "$ProgressPreference = 'SilentlyContinue'",
          "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
          "$OutputEncoding = [Console]::OutputEncoding",
          "$global:LASTEXITCODE = $null",
          "& {",
          psChain(String(command || "")),
          "$global:VIBE_SUCCESS = $?",
          "}",
          "if ($global:VIBE_SUCCESS) { exit 0 } elseif ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 }",
        ].join("\n")
      : ""
    const encodedPowerShell = win ? Buffer.from(powershellScript, "utf16le").toString("base64") : ""
    let args
    if (!win) {
      args = ["-lc", String(command || "")]
    } else if (encodedPowerShell.length <= ENCODED_LIMIT) {
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell]
    } else {
      // A very long inline script would exceed the Windows command-line limit
      // once base64-encoded. Run it from a private temp file instead.
      scriptFile = path.join(shellDir(sessionID), id + ".ps1")
      fs.writeFileSync(scriptFile, "\uFEFF" + powershellScript, "utf8")
      args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile]
    }
    child = spawn(win ? "powershell.exe" : "bash", args, {
      cwd: job.cwd,
      // A background job must survive an interrupt of the agent run. On POSIX a
      // detached process group also lets us kill the whole tree.
      detached: !win,
      windowsHide: true,
      env: { ...process.env, ...(env || {}) },
    })
    job.pid = child.pid
    job.stdin = child.stdin || null
  } catch (e) {
    if (scriptFile) {
      try { fs.unlinkSync(scriptFile) } catch {}
      scriptFile = null
    }
    job.output = `Failed to start shell: ${e.message}`
    job.status = "error"
    job.completed = Date.now()
    jobs.set(id, job)
    doneResolve(info())
    backgroundedResolveNoop()
    return handle()
  }

  try {
    stream = fs.createWriteStream(file, { flags: "w" })
    stream.on("error", () => {})
  } catch {}

  // Decode each stream incrementally. Buffer.toString("utf8") per data event
  // corrupts any multi-byte character split across OS pipe chunks (common with
  // Bengali/emoji output and fast native tools).
  const stdoutDecoder = new StringDecoder("utf8")
  const stderrDecoder = new StringDecoder("utf8")

  // stderr arrives either as plain native output or as a CLIXML document. Hold
  // only the unfinished XML tail so complete error records stream live.
  let stderrMode = "unknown" // unknown | plain | clixml
  let stderrBuffer = ""
  const emitClixml = () => {
    const text = decodeClixmlRecords(stderrBuffer)
    if (text) add(text.replace(/\r?\n?$/, "\n"))
    const lastRecord = stderrBuffer.lastIndexOf("</S>")
    stderrBuffer = lastRecord === -1 ? stderrBuffer : stderrBuffer.slice(lastRecord + 4)
    if (stderrBuffer.length > 256 * 1024) stderrBuffer = stderrBuffer.slice(-4096)
    const lastTag = stderrBuffer.lastIndexOf("<")
    if (lastTag > 0) stderrBuffer = stderrBuffer.slice(lastTag)
  }
  const pushStderr = (text) => {
    if (!text) return
    if (stderrMode === "plain") return add(text)
    stderrBuffer += text
    if (stderrMode === "unknown") {
      if (stderrBuffer.length < CLIXML_HEAD.length) {
        if (CLIXML_HEAD.startsWith(stderrBuffer)) return
        stderrMode = "plain"
        const raw = stderrBuffer
        stderrBuffer = ""
        return add(raw)
      }
      if (!stderrBuffer.startsWith(CLIXML_HEAD)) {
        stderrMode = "plain"
        const raw = stderrBuffer
        stderrBuffer = ""
        return add(raw)
      }
      stderrMode = "clixml"
      const firstObj = stderrBuffer.indexOf("<Objs")
      stderrBuffer = firstObj === -1 ? "" : stderrBuffer.slice(firstObj)
    }
    emitClixml()
  }
  const flushStderr = () => {
    if (stderrMode === "plain") {
      if (stderrBuffer) add(stderrBuffer)
      stderrBuffer = ""
      return
    }
    if (stderrMode === "unknown") {
      if (stderrBuffer) add(stderrBuffer)
      stderrBuffer = ""
      return
    }
    emitClixml()
    const leftover = stderrBuffer.replace(/<[^>]*>/g, "").trim()
    if (leftover) add(leftover + "\n")
    stderrBuffer = ""
  }

  const add = (text) => {
    text = String(text || "")
    job.output = clipTail(job.output + text, KEEP_OUTPUT)
    job.size += Buffer.byteLength(text)
    try {
      stream && stream.write(text)
    } catch {}
    if (job.emit) {
      liveBuffer += text
      if (liveBuffer.length >= LIVE_OUTPUT_LIMIT) flushLive()
      else if (!liveTimer) {
        liveTimer = setTimeout(flushLive, LIVE_OUTPUT_DELAY)
        if (typeof liveTimer.unref === "function") liveTimer.unref()
      }
    }
    notifyWaiting()
    maybeProgress()
  }
  child.stdout.on("data", (chunk) => add(stdoutDecoder.write(chunk)))
  child.stderr.on("data", (chunk) => pushStderr(stderrDecoder.write(chunk)))
  if (child.stdin) child.stdin.on("error", () => { job.stdinEnded = true })

  child.on("error", (e) => {
    job.output = clipTail(job.output + `\nFailed to start shell: ${e.message}`, KEEP_OUTPUT)
    settle("error")
  })
  child.on("close", (code, signal) => {
    // Flush incomplete trailing sequences before the final output is persisted
    // or delivered to the model.
    add(stdoutDecoder.end())
    pushStderr(stderrDecoder.end())
    flushStderr()
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
        notifyWaiting()
        if (job.status !== "running") return info()
        return info()
      },
      /** Stop this job (and its child tree). */
      cancel() {
        job.cancelled = true
        if (job.status === "running") killTree(child)
        return info()
      },
      /** Send input to a process that is waiting on stdin. */
      input(text, options) {
        return input(id, text, options)
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
  if (typeof job.notifyWaiting === "function") job.notifyWaiting()
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
    if (typeof job.notifyWaiting === "function") job.notifyWaiting()
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
    writable: job.status === "running" && !job.stdinEnded && !!job.stdin && !job.stdin.destroyed,
    waitingForInput: !!job.waitingForInput,
    ...(job.waitingPrompt ? { waitingPrompt: job.waitingPrompt } : {}),
    ...(job.toolCallId ? { toolCallId: job.toolCallId } : {}),
    ...(job.description ? { description: job.description } : {}),
    ...(job.intent ? { intent: job.intent } : {}),
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
 * Read a job's live output, optionally only the bytes after `since`.
 * The in-memory tail covers normal reads; `since` falls back to the output
 * file so the agent can follow a long build without re-reading everything.
 */
function readOutput(id, { max = 12000, since = null } = {}) {
  const job = jobs.get(id)
  if (!job) return undefined
  const limit = Math.max(1, Math.min(Number(max) || 12000, 30000))
  if (since != null && Number.isFinite(Number(since))) {
    const start = Math.max(0, Math.floor(Number(since)))
    try {
      const fd = fs.openSync(job.file, "r")
      try {
        const stat = fs.fstatSync(fd)
        if (start >= stat.size) return { text: "", bytes: stat.size, offset: stat.size, truncated: false }
        const len = Math.min(limit, stat.size - start)
        const buf = Buffer.alloc(len)
        fs.readSync(fd, buf, 0, len, start)
        const end = start + len
        return {
          text: buf.toString("utf8"),
          bytes: stat.size,
          offset: end,
          truncated: end < stat.size,
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      // The file can be briefly unavailable on Windows; the memory tail is
      // still correct for the model, it just loses the byte offset.
      return { text: clipTail(job.output, limit), bytes: job.size, offset: job.size, truncated: false }
    }
  }
  return { text: clipTail(job.output, limit), bytes: job.size, offset: job.size, truncated: false }
}

/**
 * Send bounded text to a running job's stdin. This is a safe pipe-based
 * interaction layer, not a PTY: programs that require terminal cursor control
 * or raw mode still need a future audited PTY integration.
 */
function input(id, text = "", { newline = true, eof = false } = {}) {
  const job = jobs.get(id)
  if (!job) throw new Error("This shell no longer exists.")
  if (job.status !== "running") throw new Error("This shell is no longer running.")
  if (!job.stdin || job.stdinEnded || job.stdin.destroyed || !job.stdin.writable) {
    throw new Error("This shell is not accepting input.")
  }
  let value = String(text == null ? "" : text)
  if (value.includes("\0")) throw new Error("Shell input cannot contain a null byte.")
  if (Buffer.byteLength(value) > INPUT_LIMIT) throw new Error(`Shell input is limited to ${INPUT_LIMIT} bytes per send.`)
  if (newline && !/[\r\n]$/.test(value)) value += "\n"
  const bytes = Buffer.byteLength(value)
  if (value) job.stdin.write(value)
  if (job.autoBackgroundTimer) clearTimeout(job.autoBackgroundTimer)
  job.autoBackgroundTimer = null
  job.waitingForInput = false
  job.waitingPrompt = ""
  job.waitingUiSignature = ""
  job.waitingDurableSignature = ""
  if (eof) {
    job.stdinEnded = true
    job.stdin.end()
  }
  try { if (job.emit) job.emit({ type: "shell.input", shell: jobInfo(job), bytes, eof: !!eof }) } catch {}
  return { ...jobInfo(job), bytes, eof: !!eof }
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
  readOutput,
  input,
  cancel,
  cancelSession,
  cancelAll,
  size,
  killTree,
  KEEP_OUTPUT,
  INPUT_LIMIT,
  inputPrompt,
}
