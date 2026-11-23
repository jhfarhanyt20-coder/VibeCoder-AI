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
const RISKY_WORDS = /\b(send|submit|post|publish|tweet|reply|delete|remove|erase|wipe|uninstall|install|buy|purchase|pay|checkout|check out|place order|order now|transfer|withdraw|donate|subscribe|unsubscribe|confirm|accept|agree|allow|grant|authorize|revoke|deactivate|close (my |this )?account|end task|end process( tree)?|sign out|log out|logout|factory reset|reset (this )?(pc|computer|device|phone|password|account)|format (the )?(disk|drive|partition|volume|card|usb)|quick format|empty (the )?(recycle bin|trash)|permanently)\b/i
const RISKY_PROGRAMS = /(^|[\\/\s"])(setup|install(er)?|uninstall|msiexec|regedit|reg|diskpart|format|bcdedit|netsh|sc|gpedit|secpol|taskschd|control|ms-settings:|cmd|powershell|pwsh|wscript|cscript|mmc)(\.exe|\.msc|\.msi|\b)/i
const RISKY_KEYS = /^(shift\+delete|shift\+del|ctrl\+shift\+delete|ctrl\+shift\+del|alt\+shift\+delete)$/i
// Windows (title or program) where Enter usually sends a message or an email.
const SEND_APPS = /whatsapp|messenger|telegram|signal|discord|slack|teams|skype|outlook|thunderbird|gmail|\bmail\b|viber|imo\b|wechat|line\b/i

// Programs that run commands, scripts or code ("living off the land" tools,
// script hosts, interpreters, terminals). Starting one always asks.
const COMMAND_PROGRAMS = /^(mshta|rundll32|regsvr32|regasm|regsvcs|wscript|cscript|certutil|bitsadmin|node|nodejs|python[\d.]*|pythonw|py|pyw|ruby|perl|php|java|javaw|deno|bun|msiexec|installutil|msbuild|cmstp|odbcconf|pcalua|forfiles|wmic|schtasks|at|powershell_ise|wt|windowsterminal|conhost|openconsole|bash|sh|wsl|wslhost|mintty|git-bash|hh|infdefaultinstall|presentationhost|msdt|control|mmc|cmd|powershell|pwsh)(\.exe|\.cmd)?$/i
// Files that run code when opened.
const RUNNABLE_FILES = /\.(msi|msix|msixbundle|appx|appxbundle|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|scr|pif|cpl|msc|reg|jar|com|inf|application|appref-ms|url|scf|chm|settingcontent-ms|diagcab)$/i
// Places where downloaded or dropped programs land.
const UNTRUSTED_DIRS = /[\\/](downloads|temp|tmp|appdata|inetcache|temporary internet files)[\\/]/i
// Ordinary apps that may start without a prompt (bare names only).
const SAFE_APPS = /^(notepad|calc|calculator|mspaint|paint|pbrush|wordpad|write|snippingtool|screensketch|notepad\+\+|code|code-insiders|msedge|chrome|firefox|brave|opera|vivaldi|iexplore|winword|excel|powerpnt|onenote|outlook|taskmgr|magnify|osk|charmap|explorer)(\.exe)?$/i
// Browser / editor switches that turn an ordinary app into a command runner.
const RISKY_APP_FLAGS = /--(gpu-launcher|renderer-cmd-prefix|utility-cmd-prefix|browser-subprocess-path|load-extension|install-extension|remote-debugging-port|remote-debugging-pipe|disable-web-security|no-sandbox|user-data-dir|extensions-dir)\b/i
// Documents that only open in a viewer or editor.
const DOCUMENT_FILES = /\.(txt|md|markdown|log|csv|tsv|json|xml|yaml|yml|ini|pdf|png|jpe?g|gif|bmp|webp|ico|svg|mp3|mp4|wav|m4a|mkv|avi|mov|webm|docx|xlsx|pptx|doc|xls|ppt|odt|ods|odp|rtf|html?)$/i

// Windows where typed text runs as a command: consoles, terminals, the Run box
// and the Start / search launcher (type a name, press Enter, it starts).
const CONSOLE_PROCESSES = /^(cmd|powershell|powershell_ise|pwsh|windowsterminal|wt|conhost|openconsole|bash|sh|wsl|wslhost|mintty|git-bash|ubuntu[\d.]*|debian|kali|alacritty|wezterm(-gui)?|hyper|tabby|cmder|conemu(64)?|putty|kitty)(\.exe)?$/i
const CONSOLE_TITLES = /^(administrator:\s*)?(select\s+)?(command prompt|windows powershell|powershell|developer command prompt|developer powershell)\b|\\(cmd|powershell|pwsh|wsl|bash)\.exe\b|^(mingw(32|64)|msys)\b|windows terminal/i
const LAUNCHER_PROCESSES = /^(searchhost|searchapp|searchui|startmenuexperiencehost|cortana|powertoys\.powerlauncher|keypirinha|wox|flow\.launcher)(\.exe)?$/i
// Windows where an unnamed click may change something important.
const BROWSER_PROCESSES = /^(msedge|chrome|firefox|brave|opera|vivaldi|iexplore|arc|chromium)(\.exe)?$/i
const SENSITIVE_PAGE_TITLES = /\b(pay|payment|payments|checkout|check out|billing|bank|banking|wallet|card|cards|transfer|purchase|order|account|accounts|password|passwords|security|sign in|signin|log in|login|delete|danger zone|subscription|invoice|paypal|stripe|bkash|nagad)\b/i
const SENSITIVE_WINDOWS = /^(settings|control panel|windows security|windows defender|virus & threat protection|user accounts|registry editor|task scheduler|services|computer management|disk management|device manager|local group policy editor|system properties|programs and features|uac|user account control)\b|\b(control panel|windows security|defender|firewall|bitlocker|credential manager)\b/i
const SENSITIVE_PROCESSES = /^(systemsettings|sechealthui|securityhealthhost|msmpeng|mmc|regedit|control|taskmgr|consent|credentialuibroker|applicationframehost)(\.exe)?$/i

/** What kind of window is this, for risk purposes? "run" | "console" | "launcher" | "". */
function windowKind(detail = {}) {
  const title = String(detail.title != null ? detail.title : detail.window || "").trim()
  const proc = String(detail.process || "").trim()
  if (/^run$/i.test(title)) return "run"
  if (proc && CONSOLE_PROCESSES.test(proc)) return "console"
  if (CONSOLE_TITLES.test(title)) return "console"
  // Older callers pass "title process" as one string.
  if (!proc && detail.window) {
    const last = String(detail.window).trim().split(/\s+/).pop()
    if (last && CONSOLE_PROCESSES.test(last)) return "console"
    if (last && LAUNCHER_PROCESSES.test(last)) return "launcher"
  }
  if (proc && LAUNCHER_PROCESSES.test(proc)) return "launcher"
  if (/^(search|start)$/i.test(title) && (!proc || /^(explorer|searchhost|searchapp|startmenuexperiencehost)$/i.test(proc))) return "launcher"
  return ""
}

/** A window where an unnamed click could pay, send, change security or delete. */
function sensitiveWindow(detail = {}) {
  const title = String(detail.title != null ? detail.title : detail.window || "").trim()
  const proc = String(detail.process || "").trim()
  const both = `${title} ${proc}`
  if (windowKind(detail)) return "a command window"
  if (SEND_APPS.test(both)) return "a mail or chat app"
  if (proc && SENSITIVE_PROCESSES.test(proc) && !(proc.toLowerCase().startsWith("applicationframehost") && !SENSITIVE_WINDOWS.test(title))) return "a system or security window"
  if (SENSITIVE_WINDOWS.test(title)) return "a system or security window"
  if ((proc ? BROWSER_PROCESSES.test(proc) : /\b(microsoft edge|google chrome|mozilla firefox|brave|opera|vivaldi)\b/i.test(title)) && SENSITIVE_PAGE_TITLES.test(title)) return "a payment or account page"
  return ""
}

/**
 * Text that looks like a command line starting programs or changing the
 * system. Checked wherever it is typed: Notepad text can be pasted into a
 * console later, and the window detection can be wrong.
 */
const COMMAND_TEXT = [
  /(^|[\s;&|"'(`])(powershell|pwsh)(\.exe)?\s+[-/]\w/i,
  /^\s*(powershell|pwsh|cmd|wt|wsl|bash|mshta|rundll32|regsvr32|certutil|bitsadmin|wscript|cscript|msiexec|installutil|schtasks|bcdedit|diskpart|vssadmin|wmic|netsh|taskkill|iex|iwr|irm)(\.exe)?(\s|$)/i,
  /(^|[\s;&|"'(`])cmd(\.exe)?\s+\/[ckr]\b/i,
  /(^|[\s;&|"'(`])(mshta|rundll32|regsvr32|certutil|bitsadmin|installutil|cmstp|odbcconf|pcalua|forfiles)(\.exe)?\s+\S/i,
  /\|\s*(iex|invoke-expression|sh|bash|cmd|powershell|pwsh)\b/i,
  /\b(iex|invoke-expression)\s*[(\s$'"]/i,
  /\b(invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|downloaddata|start-bitstransfer|frombase64string|start-process|new-object\s+net\.webclient)\b/i,
  /(^|[\s;&|"'(`])(curl|wget)(\.exe)?\s[^\n]*https?:\/\/[^\n]*(\||>|-o\b|--output\b)/i,
  /(^|[\s;&|"'(`])reg(\.exe)?\s+(add|delete|import|load|restore|copy)\b/i,
  /(^|[\s;&|"'(`])schtasks(\.exe)?\s+\/(create|change|run|delete)\b/i,
  /(^|[\s;&|"'(`])net1?(\.exe)?\s+(user|localgroup|share|stop|use)\b/i,
  /(^|[\s;&|"'(`])sc(\.exe)?\s+(create|config|delete|stop|failure)\b/i,
  /\b(set|add|remove)-mppreference\b|\bdisablerealtimemonitoring\b/i,
  /\b(set-executionpolicy|new-service|new-scheduledtask|register-scheduledtask|set-itemproperty\s+[^\n]*hk(lm|cu):|remove-item\s+[^\n]*-recurse)\b/i,
  /(^|\s)-(e|en|enc|encodedcommand)\s+[A-Za-z0-9+/=]{20,}/i,
  /(^|[\s;&|"'(`])(bcdedit|vssadmin\s+delete|wbadmin\s+delete|cipher\s+\/w|takeown|icacls\s+[^\n]*\/grant)\b/i,
  /(^|[\s;&|"'(`])(del|erase)\s+(\/[fsqa]\s*)+/i,
  /(^|[\s;&|"'(`])(rd|rmdir)\s+\/s\b/i,
  /(^|[\s;&|"'(`])format\s+[a-z]:/i,
  /(^|[\s;&|"'(`])rm\s+-(r|rf|fr)\b/i,
  /(^|[\s;&|"'(`])taskkill(\.exe)?\s+\//i,
  /(^|[\s;&|"'(`])(wscript|cscript)(\.exe)?\s+\S+\.(js|jse|vbs|vbe|wsf)\b/i,
]
function looksLikeCommand(text) {
  const s = String(text || "")
  return COMMAND_TEXT.some((re) => re.test(s))
}

/** Is `file` inside the directory `dir`? (case-insensitive on Windows) */
function insideDir(file, dir) {
  if (!file || !dir) return false
  try {
    const rel = path.relative(path.resolve(String(dir)), path.resolve(String(file)))
    return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
  } catch { return false }
}
function isFolder(p) {
  try { return fs.statSync(String(p)).isDirectory() } catch { return false }
}
const unquote = (s) => String(s || "").trim().replace(/^"(.*)"$/, "$1").trim()

/** Normalised key tokens: "Win+R enter" -> [["win","r"],["enter"]]. */
function keyTokens(keys) {
  const alias = { windows: "win", lwin: "win", rwin: "win", meta: "win", super: "win", cmd: "win", start: "win", command: "win", return: "enter", control: "ctrl", del: "delete" }
  return String(keys || "").trim().split(/\s+/).filter(Boolean).map((tok) => tok.toLowerCase().split("+").filter(Boolean).map((k) => alias[k] || k))
}

/** Why starting this program needs the user's OK, or "". */
function launchRisk(detail = {}) {
  const file = unquote(detail.file)
  const args = String(detail.args || "")
  const what = `${detail.file || ""} ${detail.args || ""}`.trim()
  if (!file) return ""
  if (RISKY_PROGRAMS.test(what) || /\.(msi|msix|appx|bat|cmd|ps1|vbs|reg)\b/i.test(what)) return `start "${what}" (it can install software or change system settings)`
  const base = path.basename(file.replace(/\//g, "\\").split("\\").pop() || file)
  if (COMMAND_PROGRAMS.test(base)) return `start "${what}" (it can run commands or scripts)`
  if (looksLikeCommand(args) || looksLikeCommand(file)) return `start "${what}" (the arguments look like a command)`
  if (RISKY_APP_FLAGS.test(args)) return `start "${what}" (these options can run other programs)`
  // Web pages open in the user's browser.
  if (/^https?:\/\//i.test(file)) return ""
  if (/^mailto:/i.test(file)) return ""
  // Any other URI scheme (ms-settings:, search-ms:, ms-msdt:, file:, shell: …).
  if (/^[a-z][a-z0-9+.-]+:/i.test(file)) return `start "${what}" (it is not an ordinary app or web page)`
  if (RUNNABLE_FILES.test(file)) return `start "${what}" (opening this file runs code)`
  const bare = !/[\\/]/.test(file)
  if (bare && SAFE_APPS.test(base)) {
    // explorer opens folders only; a file, a URL or a shell: target runs things.
    if (/^explorer(\.exe)?$/i.test(base)) {
      const target = unquote(args.replace(/^\s*\/(e|n|root|select),?\s*/i, ""))
      if (!target || isFolder(target)) return ""
      return `start "${what}" (explorer is asked to open something that is not a folder)`
    }
    return ""
  }
  // A folder opens in File Explorer.
  if (isFolder(file)) return ""
  if (/\.exe$/i.test(file) || !/\.[a-z0-9]{1,12}$/i.test(base)) {
    if (UNTRUSTED_DIRS.test(file) && !insideDir(file, detail.workspace)) return `start "${what}" (a program from a downloads or temporary folder)`
    // The project's own built app, inside the workspace.
    if (!bare && detail.workspace && insideDir(file, detail.workspace)) return ""
    const pf = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432].filter(Boolean)
    if (!bare && /\.exe$/i.test(file) && pf.some((d) => insideDir(file, d))) return ""
    return `start "${what}" (it is not on the list of everyday apps)`
  }
  if (DOCUMENT_FILES.test(file)) return ""
  return `start "${what}" (it is not on the list of everyday apps or documents)`
}

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
// detail.window is the window title (older callers: "title process");
// detail.title / detail.process, when given, are used for window detection.
function riskOf(kind, detail = {}) {
  const winLabel = String(detail.title || detail.window || "").trim()
  if (kind === "launch") return launchRisk(detail)
  if (kind === "key") {
    if (RISKY_KEYS.test(String(detail.keys || "").replace(/\s+/g, ""))) return `press ${detail.keys} (permanent delete)`
    const tokens = keyTokens(detail.keys)
    // Win+R (Run box) and Win+X (power menu: terminal, admin terminal) start programs.
    for (const t of tokens) {
      if (t.includes("win") && (t.includes("r") || t.includes("x"))) return `press ${detail.keys} (it opens ${t.includes("r") ? "the Run box" : "the power menu"}, which can start any program or command)`
    }
    const enter = tokens.some((t) => t.includes("enter"))
    const kindNow = windowKind(detail)
    if (enter && kindNow) return `press Enter in "${winLabel || kindNow}" (${kindNow === "launcher" ? "this starts what was typed" : "this runs what was typed as a command"})`
    // Paste into a console runs the pasted lines.
    if (kindNow === "console" && tokens.some((t) => (t.includes("ctrl") && t.includes("v")) || (t.includes("shift") && t.includes("insert")))) return `paste into "${winLabel}" (pasted lines run as commands)`
    // Enter in a chat or mail app sends the message: ask, like clicking "Send".
    if (/(^|\s)(ctrl\+)?enter$/i.test(String(detail.keys || "").trim()) && SEND_APPS.test(`${detail.window || ""} ${detail.process || ""}`)) return `press Enter in "${winLabel}" (this may send a message)`
    return ""
  }
  if (kind === "click") {
    const name = String(detail.name || "").trim()
    const where = winLabel ? ` in "${winLabel}"` : ""
    if (name && RISKY_WORDS.test(name)) return `click "${name}"${where}`
    // An unnamed point: judge it by the nearest named control around it.
    const near = String(detail.ancestor || "").trim()
    if (!name && near && RISKY_WORDS.test(near)) return `click inside "${near}"${where}`
    const kindNow = windowKind(detail)
    // The Run box: OK starts the typed command.
    if (kindNow === "run" && !/^(cancel|close|browse\.*)$/i.test(name)) return `click ${name ? `"${name}"` : "a control"} in the Run box (it can start any program)`
    if (kindNow === "console" && /^(right|middle)$/i.test(String(detail.button || ""))) return `${detail.button}-click in "${winLabel}" (this pastes into a command window)`
    if (!name && !near) {
      const sens = sensitiveWindow(detail)
      if (sens) return `click an unnamed spot${where} (${sens}: the agent cannot tell what this button does)`
    }
    return ""
  }
  if (kind === "type") {
    const text = String(detail.text || "")
    if (/\b(\d[ -]?){13,19}\b/.test(text)) return "type what looks like a card or account number"
    if (looksLikeCommand(text)) return `type what looks like a command line ("${text.trim().slice(0, 80)}")`
    const kindNow = windowKind(detail)
    if (kindNow === "run") return "type into the Run box (it can start any program)"
    if (kindNow === "console") return `type into "${winLabel}" (a command window: typed text runs as commands)`
    if (kindNow === "launcher") return `type into "${winLabel || "the Start search"}" (it can start programs)`
    return ""
  }
  return ""
}

module.exports = { ComputerExecutor, riskOf, helperPath, RISKY_WORDS, SEND_APPS, windowKind, sensitiveWindow, looksLikeCommand }
