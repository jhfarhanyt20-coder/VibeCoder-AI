"use strict"
/**
 * Computer Use executor: the only place that touches the screen, mouse,
 * keyboard and desktop windows. Windows only. It drives a long-running
 * PowerShell helper (helper.ps1, built-in .NET + Win32 + UI Automation, no npm
 * dependency) over a JSON-lines pipe.
 *
 * It keeps the state that makes the tools easy for any model:
 *   - the latest screenshot geometry, so x/y given in screenshot pixels map to
 *     real screen pixels;
 *   - the numbered UI elements of the latest screenshot/scan (click element=N);
 *   - where the agent last left the mouse, to notice when the user takes over.
 */
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn } = require("node:child_process")

const HELPER_SOURCE = path.join(__dirname, "helper.ps1")

// Actions that need the user's OK first ("Ask before risky actions").
// Everyday app buttons such as "Reset" (a counter), "Format" (a menu) or "Save"
// do not ask; only wording that sends, deletes, installs, pays, consents or
// wipes does.
const RISKY_WORDS = /\b(send|submit|post|publish|tweet|reply|delete|remove|erase|wipe|uninstall|install|buy|purchase|pay|checkout|check out|place order|order now|transfer|donate|subscribe|unsubscribe|confirm|accept|agree|allow|grant|authorize|sign out|log out|logout|factory reset|reset (this )?(pc|computer|device|phone|password|account)|format (the )?(disk|drive|partition|volume|card|usb)|quick format|empty (the )?(recycle bin|trash)|permanently)\b/i
const RISKY_PROGRAMS = /(^|[\\/\s"])(setup|install(er)?|uninstall|msiexec|regedit|reg|diskpart|format|bcdedit|netsh|sc|gpedit|secpol|taskschd|control|ms-settings:|cmd|powershell|pwsh|wscript|cscript|mmc)(\.exe|\.msc|\.msi|\b)/i
const RISKY_KEYS = /^(shift\+delete|shift\+del|ctrl\+shift\+delete|ctrl\+shift\+del|alt\+shift\+delete)$/i
// Windows (title or program) where Enter usually sends a message or an email.
const SEND_APPS = /whatsapp|messenger|telegram|signal|discord|slack|teams|skype|outlook|thunderbird|gmail|\bmail\b|viber|imo\b|wechat|line\b/i

function helperPath(home) {
  // Inside a packaged app the source sits in app.asar, which PowerShell cannot
  // read. Copy it next to the app data once per content hash.
  const text = fs.readFileSync(HELPER_SOURCE, "utf8")
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)
  const dir = path.join(home || path.join(os.homedir(), ".vibe"), "computer")
  const file = path.join(dir, `helper-${hash}.ps1`)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, "﻿" + text.replace(/^﻿/, ""), "utf8")
  }
  return file
}

class ComputerExecutor {
  constructor({ home, logFile } = {}) {
    this.home = home
    this.logFile = logFile || path.join(home || path.join(os.homedir(), ".vibe"), "computer-actions.log")
    this.child = null
    this.ready = null
    this.waiters = new Map()
    this.seq = 0
    this.buffer = ""
    this.lastShot = null // { x, y, w, h, scale, sentW, sentH, at }
    this.lastCursor = null // where the agent left the cursor
    this.baselineInput = null // last-input tick right after the agent's own action
    this.target = null // window the agent is working in: typing/keys go only there
    this.elementsWindow = null // window the numbered elements belong to
    this.launched = new Set()
    this.stopped = false // set by the kill switch until the next run
  }

  get supported() { return process.platform === "win32" }

  start() {
    if (!this.supported) return Promise.reject(new Error("Computer Use works on Windows only."))
    if (this.ready) return this.ready
    const file = helperPath(this.home)
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.child = child
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000) })
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The Computer Use helper did not start in time.")), 30000)
      child.stdout.on("data", (d) => {
        this.buffer += d
        let i
        while ((i = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, i).trim()
          this.buffer = this.buffer.slice(i + 1)
          if (!line) continue
          let msg
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.ready) { clearTimeout(timer); resolve(); continue }
          if (msg.event) { try { if (typeof this.onEvent === "function") this.onEvent(msg) } catch {} continue }
          const w = this.waiters.get(msg.id)
          if (w) { this.waiters.delete(msg.id); clearTimeout(w.timer); msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error || "Computer action failed.")) }
        }
      })
      child.on("exit", (code) => {
        clearTimeout(timer)
        const err = new Error(`The Computer Use helper stopped (code ${code}). ${stderr.trim().slice(-300)}`.trim())
        for (const w of this.waiters.values()) { clearTimeout(w.timer); w.reject(err) }
        this.waiters.clear()
        this.child = null
        this.ready = null
        reject(err)
      })
      child.on("error", (e) => { clearTimeout(timer); reject(e) })
    })
    this.ready.catch(() => {})
    return this.ready
  }

  async call(cmd, args = {}, timeoutMs = 20000) {
    await this.start()
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(`Computer action "${cmd}" timed out.`)) }, timeoutMs)
      this.waiters.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ id, cmd, args }) + "\n")
    })
  }

  /** Model coordinates are pixels of the latest screenshot; map them to the screen. */
  toScreen(x, y) {
    const s = this.lastShot
    if (!s) return { x: Math.round(x), y: Math.round(y) }
    const sx = Math.round(s.x + Number(x) * s.scale)
    const sy = Math.round(s.y + Number(y) * s.scale)
    return { x: sx, y: sy }
  }
  toShot(x, y) {
    const s = this.lastShot
    if (!s) return { x, y }
    return { x: Math.round((x - s.x) / s.scale), y: Math.round((y - s.y) / s.scale) }
  }

  /**
   * Stop if the user used the computer since the agent's last action: mouse moved,
   * any key/mouse input after the agent's own input, the corner fail-safe, or the
   * kill switch.
   */
  async checkUserTookOver() {
    if (this.stopped) throw new Error("Stopped: the user pressed Ctrl+Alt+Esc. Do not continue; tell the user the task was stopped.")
    let s
    try { s = await this.call("input_state") } catch { s = await this.call("cursor") }
    if (s.x <= 1 && s.y <= 1) {
      this.stopped = true
      throw new Error("Stopped: the mouse was pushed into the top-left corner (fail-safe). Do not continue; tell the user.")
    }
    const inputGap = this.baselineInput != null && Number.isFinite(s.lastInput) ? s.lastInput - this.baselineInput : 0
    const distance = this.lastCursor ? Math.hypot(s.x - this.lastCursor.x, s.y - this.lastCursor.y) : 0
    const typed = inputGap > 400
    // A real hand on the mouse also shows up as new input (inputGap). A cursor
    // that only drifted (a program or a DPI change moved it, no input at all)
    // must not pause the task, unless it jumped a long way.
    const moved = (distance > 80 && inputGap > 0) || distance > 300
    if (typed || moved) {
      const why = moved ? `the mouse moved ${Math.round(distance)} px` : `keyboard or mouse input ${Math.round(inputGap / 100) / 10} s after the agent's last action`
      this.log({ event: "paused", reason: why, cursor: { x: s.x, y: s.y }, last: this.lastCursor, inputGap })
      this.lastCursor = null
      this.baselineInput = null
      throw new Error(`Paused: the user is using the computer (${why}). Stop and ask the user whether to continue before doing more computer actions.`)
    }
  }
  noteCursor(x, y) { this.lastCursor = { x, y } }
  /** Remember the input state right after the agent's own action. */
  async noteAction() {
    try { const s = await this.call("input_state", {}, 5000); this.baselineInput = s.lastInput; this.lastCursor = { x: s.x, y: s.y } } catch {}
  }

  /** Bring `hwnd` to the front and check it really is in front. Returns the window info. */
  async ensureFront(hwnd, label = "the window") {
    let fg = await this.call("foreground")
    if (fg && String(fg.hwnd) === String(hwnd)) return fg
    const r = await this.call("focus", { hwnd: String(hwnd) })
    fg = await this.call("foreground")
    if (!r.focused || !fg || String(fg.hwnd) !== String(hwnd)) {
      throw new Error(`Could not bring ${label} to the front (now in front: "${(fg && fg.title) || "nothing"}"). Nothing was clicked or typed. Call computer_windows and computer_focus, or click the window in a new screenshot.`)
    }
    return fg
  }

  async releaseAll() {
    if (!this.child) return
    try { await this.call("release_all", {}, 5000) } catch {}
  }

  log(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true })
      try { if (fs.statSync(this.logFile).size > 2 * 1024 * 1024) fs.renameSync(this.logFile, this.logFile + ".1") } catch {}
      fs.appendFileSync(this.logFile, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n")
    } catch {}
  }

  /** Forget per-task state (called when a task ends). */
  reset() {
    this.lastCursor = null
    this.baselineInput = null
    this.target = null
  }

  stop() {
    this.reset()
    if (this.child) { try { this.child.stdin.end(); this.child.kill() } catch {} }
    this.child = null
    this.ready = null
  }
}

/** Does this action need the user's OK first? Returns a short reason or "". */
function riskOf(kind, detail = {}) {
  if (kind === "launch") {
    const what = `${detail.file || ""} ${detail.args || ""}`
    if (RISKY_PROGRAMS.test(what) || /\.(msi|msix|appx|bat|cmd|ps1|vbs|reg)\b/i.test(what)) return `start "${what.trim()}" (it can install software or change system settings)`
    return ""
  }
  if (kind === "key") {
    if (RISKY_KEYS.test(String(detail.keys || "").replace(/\s+/g, ""))) return `press ${detail.keys} (permanent delete)`
    // Enter in a chat or mail app sends the message: ask, like clicking "Send".
    if (/(^|\s)(ctrl\+)?enter$/i.test(String(detail.keys || "").trim()) && SEND_APPS.test(String(detail.window || ""))) return `press Enter in "${detail.window}" (this may send a message)`
    return ""
  }
  if (kind === "click") {
    const name = String(detail.name || "")
    return name && RISKY_WORDS.test(name) ? `click "${name}"${detail.window ? ` in "${detail.window}"` : ""}` : ""
  }
  if (kind === "type") {
    const text = String(detail.text || "")
    if (/\b(\d[ -]?){13,19}\b/.test(text)) return "type what looks like a card or account number"
    return ""
  }
  return ""
}

module.exports = { ComputerExecutor, riskOf, helperPath, RISKY_WORDS }
