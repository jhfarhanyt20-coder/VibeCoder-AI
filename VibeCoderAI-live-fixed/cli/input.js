"use strict"
/**
 * One stdin owner for chat, pickers, permissions and secret prompts.
 * Bracketed pastes are inserted as one draft, never submitted line by line.
 * Raw mode, cursor and bracketed-paste state are restored on every exit path.
 */
const readline = require("node:readline")
const { EventEmitter } = require("node:events")
const { PassThrough } = require("node:stream")
const { execFile } = require("node:child_process")
const { StringDecoder } = require("node:string_decoder")
const { c, safeText } = require("./theme")

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const segments = (value) => [...graphemes.segment(value)].map((s) => s.segment)
function cellWidth(text) {
  let width = 0
  for (const ch of segments(safeText(text))) {
    const n = ch.codePointAt(0)
    if (/^\p{Mark}+$/u.test(ch)) continue
    width += /\p{Extended_Pictographic}/u.test(ch) || n >= 0x1100 && (
      n <= 0x115f || n >= 0x2e80 && n <= 0xa4cf || n >= 0xac00 && n <= 0xd7a3 ||
      n >= 0xf900 && n <= 0xfaff || n >= 0xfe10 && n <= 0xfe6f || n >= 0xff01 && n <= 0xff60 || n >= 0x20000
    ) ? 2 : 1
  }
  return width
}
function wrapLines(text, columns) {
  const rows = [""]
  let width = 0
  for (const ch of segments(text)) {
    if (ch === "\n") { rows.push(""); width = 0; continue }
    const size = cellWidth(ch)
    if (width + size > columns) { rows.push(""); width = 0 }
    rows[rows.length - 1] += ch
    width += size
  }
  return rows
}

class TerminalInput extends EventEmitter {
  constructor({ input = process.stdin, output = process.stdout, history = [], complete, fullScreen = false } = {}) {
    super()
    this.input = input
    this.output = output
    this.history = history.slice(-200)
    this.complete = complete
    this.wantScreen = fullScreen
    this.screen = null
    this.closed = false
    this.active = null
    this.suspended = []
    this.liveBuffer = ""
    this.rendered = 0
    this.cursorRow = 0
    this.cursorCol = 0
    this.pending = ""
    this.mouseBuffer = ""
    this.paste = false
    this.decoder = new StringDecoder("utf8")
    this.keys = new PassThrough()
    readline.emitKeypressEvents(this.keys)
    this.keys.on("keypress", (text, key) => this.key(text, key || {}))
    this.onData = (chunk) => this.data(typeof chunk === "string" ? chunk : this.decoder.write(chunk))
    this.onEnd = () => this.close()
    this.onResize = () => { if (this.active) this.draw() }
    this.wasRaw = !!input.isRaw
    if (input.setRawMode) input.setRawMode(true)
    input.on("data", this.onData)
    input.on("end", this.onEnd)
    output.on?.("resize", this.onResize)
    input.resume()
    if (output.isTTY && process.env.TERM !== "dumb") output.write("\x1b[?2004h")
  }

  data(chunk) {
    clearTimeout(this.escapeTimer)
    this.pending += chunk
    const start = "\x1b[200~", end = "\x1b[201~"
    for (;;) {
      const marker = this.paste ? end : start
      const at = this.pending.indexOf(marker)
      if (at >= 0) {
        const content = this.pending.slice(0, at)
        if (this.paste) this.insert(content.replace(/\r\n?/g, "\n"))
        else this.keyData(content)
        this.pending = this.pending.slice(at + marker.length)
        this.paste = !this.paste
        continue
      }
      // Keep only a possible split marker. Plain Escape/arrow sequences must
      // remain responsive; their bytes are decoded by Node's keypress parser.
      let keep = 0
      for (let n = 1; n < marker.length && n <= this.pending.length; n++) if (marker.startsWith(this.pending.slice(-n))) keep = n
      const ready = this.pending.slice(0, this.pending.length - keep)
      this.pending = this.pending.slice(this.pending.length - keep)
      if (this.paste) this.insert(ready.replace(/\r\n?/g, "\n"))
      else if (ready) {
        if (!this.mouseBuffer && ready.length > 1 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ready)) this.insert(ready.replace(/\r\n?/g, "\n"))
        else this.keyData(ready)
      }
      if (this.pending) {
        this.escapeTimer = setTimeout(() => {
          const pending = this.pending
          this.pending = ""
          if (this.paste) this.insert(pending)
          else if (pending === "\x1b") this.key("", { name: "escape" })
          else this.keyData(pending)
        }, 35)
      }
      break
    }
  }

  insert(text) {
    const a = this.active
    if (!a || a.kind === "pick") return
    const clean = safeText(text).replace(/\t/g, "  ")
    const next = a.text.slice(0, a.cursor) + clean + a.text.slice(a.cursor)
    if (Buffer.byteLength(next, "utf8") > 100000) return
    a.text = next
    a.cursor += clean.length
    this.draw()
  }
  /** SGR/X10 mouse reports are control data, never text in the prompt. */
  keyData(text) {
    let value = this.mouseBuffer + text
    this.mouseBuffer = ""
    if (!this.screen) { this.keys.write(value); return }
    for (;;) {
      const sgr = value.indexOf("\x1b[<"), x10 = value.indexOf("\x1b[M")
      const positions = [sgr, x10].filter((n) => n >= 0)
      if (!positions.length) { this.keys.write(value); return }
      const at = Math.min(...positions)
      if (at) this.keys.write(value.slice(0, at))
      value = value.slice(at)
      if (value.startsWith("\x1b[<")) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(value)
        if (!match) {
          if (/^\x1b\[<[\d;]*$/.test(value) && value.length < 64) this.mouseBuffer = value
          else this.keys.write(value)
          return
        }
        this.mouse({ button: Number(match[1]), x: Number(match[2]) - 1, y: Number(match[3]) - 1, release: match[4] === "m" })
        value = value.slice(match[0].length)
      } else {
        if (value.length < 6) { this.mouseBuffer = value; return }
        this.mouse({ button: value.charCodeAt(3) - 32, x: value.charCodeAt(4) - 33, y: value.charCodeAt(5) - 33, release: (value.charCodeAt(3) - 32) === 3 })
        value = value.slice(6)
      }
      if (!value) return
    }
  }
  mouse(event) {
    const action = this.screen?.mouse(event)
    if (action?.kind === "access" && this.active?.multiline) this.finish({ action: "access", draft: this.active.text })
    else if (action?.kind === "paste") this.pasteClipboard()
    else if (action?.kind === "pick" && this.active?.kind === "pick") this.finish(action.value)
    else this.draw()
  }
  /** Conhost sends Ctrl+V as a key instead of pasting; read the OS clipboard. */
  pasteClipboard() {
    if (this.clipboardBusy || process.platform !== "win32" || this.closed) return
    if (!this.active || this.active.kind === "pick") return
    this.clipboardBusy = true
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      this.clipboardBusy = false
      if (this.closed || !this.active || error) return
      const text = String(stdout || "").replace(/\r\n?/g, "\n")
      if (text) this.insert(text)
    })
  }

  key(text, key) {
    if (this.screen?.handleKey(key)) return
    if (key.ctrl && key.name === "c") {
      const active = this.active
      this.emit("SIGINT")
      if (active && this.active === active) this.finish(null)
      return
    }
    if (key.ctrl && key.name === "b") { this.emit("background"); return }
    const a = this.active
    if (!a) return
    if (key.ctrl && key.name === "d" && !a.text) { this.close(); return }
    if (key.name === "escape") { this.finish(null); return }
    if (a.kind === "pick") { this.pickKey(text, key); return }
    if (a.palette && key.ctrl && key.name === "p") { this.finish({ action: "palette", draft: a.text }); return }
    if (a.palette && key.name === "f4") { this.finish({ action: "access", draft: a.text }); return }
    if (key.ctrl && key.name === "v" && !a.secret && a.kind !== "pick") {
      // Windows console never performs a native paste; fetch the clipboard.
      if (process.platform === "win32") { this.pasteClipboard(); return }
    }
    if ((key.meta && (key.name === "return" || key.name === "enter")) || (key.ctrl && key.name === "j")) {
      if (a.multiline) this.insert("\n")
      return
    }
    if (key.name === "return" || key.name === "enter") { this.finish(a.text); return }
    if (key.name === "tab" && !a.secret) {
      const result = this.complete?.(a.text)
      if (result?.text) { a.text = result.text; a.cursor = a.text.length; this.draw() }
      else if (result?.choices?.length) this.finish({ action: "complete", choices: result.choices, draft: a.text, prefix: result.prefix })
      return
    }
    const before = segments(a.text.slice(0, a.cursor))
    const after = segments(a.text.slice(a.cursor))
    if (key.name === "left") a.cursor -= before.pop()?.length || 0
    else if (key.name === "right") a.cursor += after[0]?.length || 0
    else if (key.name === "home" || key.ctrl && key.name === "a") a.cursor = 0
    else if (key.name === "end" || key.ctrl && key.name === "e") a.cursor = a.text.length
    else if (key.name === "backspace") {
      if (key.ctrl || key.meta) {
        const cut = a.text.slice(0, a.cursor).replace(/\s*\S+\s*$/, "").length
        a.text = a.text.slice(0, cut) + a.text.slice(a.cursor); a.cursor = cut
      } else {
        const size = before.pop()?.length || 0
        a.text = a.text.slice(0, a.cursor - size) + a.text.slice(a.cursor); a.cursor -= size
      }
    } else if (key.name === "delete") a.text = a.text.slice(0, a.cursor) + a.text.slice(a.cursor + (after[0]?.length || 0))
    else if (key.ctrl && key.name === "u") { a.text = a.text.slice(a.cursor); a.cursor = 0 }
    else if (key.ctrl && key.name === "k") a.text = a.text.slice(0, a.cursor)
    else if (key.name === "up" || key.name === "down") {
      if (a.secret || !a.history) return
      if (a.historyIndex === this.history.length) a.draft = a.text
      a.historyIndex = Math.max(0, Math.min(this.history.length, a.historyIndex + (key.name === "up" ? -1 : 1)))
      a.text = a.historyIndex === this.history.length ? a.draft : this.history[a.historyIndex]
      a.cursor = a.text.length
    } else if (!key.ctrl && !key.meta && text) { this.insert(text); return }
    this.draw()
  }

  pickKey(text, key) {
    const a = this.active
    if (key.name === "up") a.index = Math.max(0, a.index - 1)
    else if (key.name === "down") a.index = Math.min(this.matches().length - 1, a.index + 1)
    else if (key.name === "pageup") a.index = Math.max(0, a.index - 6)
    else if (key.name === "pagedown") a.index = Math.min(this.matches().length - 1, a.index + 6)
    else if (key.name === "return" || key.name === "enter") { this.finish(this.matches()[a.index] || null); return }
    else if (key.name === "backspace") { a.text = segments(a.text).slice(0, -1).join(""); a.index = 0 }
    else if (!key.ctrl && !key.meta && text) { a.text += safeText(text); a.index = 0 }
    this.draw()
  }
  matches() {
    const a = this.active
    return a.rows.filter((row) => `${row.label} ${row.description || ""}`.toLowerCase().includes(a.text.toLowerCase()))
  }

  read(label, options = {}) {
    if (this.closed) return Promise.resolve(null)
    if (this.active) {
      if (!options.interrupt) return Promise.reject(new Error("Terminal input is already in use."))
      this.clear()
      this.suspended.push(this.active)
      this.active = null
    }
    return new Promise((resolve) => {
      this.active = {
        kind: "text", label: safeText(label), text: String(options.initial || ""), cursor: String(options.initial || "").length,
        multiline: !!options.multiline, secret: !!options.secret, history: !!options.history, palette: !!options.palette,
        historyIndex: this.history.length, draft: "", resolve, ...options,
      }
      this.draw()
    })
  }
  question(label, cb) { this.read(label, { interrupt: true, interaction: true }).then((value) => cb(typeof value === "string" ? value : "")) }
  pick(rows, label) {
    if (this.closed) return Promise.resolve(null)
    if (this.active) return Promise.reject(new Error("Terminal input is already in use."))
    return new Promise((resolve) => {
      this.active = { kind: "pick", label: safeText(label), rows, text: "", index: 0, resolve }
      this.draw()
    })
  }

  clear() {
    if (this.screen) return
    if (!this.rendered) return
    if (this.output.isTTY && process.env.TERM !== "dumb") {
      this.output.write("\r" + (this.cursorRow ? `\x1b[${this.cursorRow}A` : ""))
      for (let i = 0; i < this.rendered; i++) {
        this.output.write("\x1b[2K" + (i < this.rendered - 1 ? "\x1b[1B\r" : ""))
      }
      if (this.rendered > 1) this.output.write(`\x1b[${this.rendered - 1}A`)
      this.output.write("\r")
    }
    this.rendered = 0
  }

  draw() {
    if (this.closed) return
    if (this.screen) { this.screen.setInput(this.active); return }
    if (!this.active) return
    this.clear()
    const a = this.active
    const columns = Math.max(16, Math.min(this.output.columns || 80, 100) - 2)
    let rows = []
    let cursorRow = 0, cursorCol = 0
    if (a.kind === "pick") {
      rows.push(c.accent(wrapLines(a.label + (a.text ? `: ${a.text}` : ""), columns)[0]))
      const hits = this.matches()
      a.index = Math.max(0, Math.min(a.index, hits.length - 1))
      const start = Math.max(0, a.index - 5)
      const count = Math.max(2, Math.min(8, (this.output.rows || 24) - 5))
      if (!hits.length) rows.push(c.dim("  No matches. Backspace to edit; Escape to cancel."))
      for (let i = start; i < Math.min(hits.length, start + count); i++) {
        const row = hits[i], selected = i === a.index
        const label = safeText((selected ? "› " : "  ") + row.label)
        rows.push((selected ? c.accent : c.dim)(wrapLines(label, columns)[0]))
        if (selected && row.description) rows.push(c.dim("  " + wrapLines(safeText(row.description), columns - 2)[0]))
      }
      rows.push(c.dim(wrapLines("  ↑/↓ choose   Enter select   type to filter   Esc cancel", columns)[0]))
      cursorRow = 0; cursorCol = Math.min(columns, cellWidth(a.label + (a.text ? `: ${a.text}` : "")))
    } else if (a.multiline) {
      const left = safeText(a.label).slice(0, columns - 7)
      rows.push(c.border("┌─ ") + c.accent(left) + c.border(" " + "─".repeat(Math.max(0, columns - cellWidth(left) - 4))))
      const visible = wrapLines(a.text || "", columns - 4)
      const before = wrapLines(a.text.slice(0, a.cursor), columns - 4)
      const max = Math.max(2, (this.output.rows || 24) - 5)
      const start = Math.max(0, before.length - max)
      rows.push(...visible.slice(start, start + max).map((s, i) => c.border(i === 0 && start === 0 ? "│ › " : "│   ") + c.text(s)))
      rows.push(c.border("└─ ") + c.dim(wrapLines("Enter send   Alt+Enter new line   Ctrl+P commands   Tab complete", columns - 3)[0]))
      cursorRow = Math.min(before.length - start, rows.length - 2)
      cursorCol = 4 + cellWidth(before[before.length - 1])
    } else {
      const text = a.secret ? "•".repeat(segments(a.text).length) : a.text
      rows = wrapLines(a.label + text, columns).map((s) => c.text(s))
      const before = wrapLines(a.label + (a.secret ? "•".repeat(segments(a.text.slice(0, a.cursor)).length) : a.text.slice(0, a.cursor)), columns)
      cursorRow = before.length - 1
      cursorCol = cellWidth(before[before.length - 1])
    }
    this.output.write(rows.join("\n") + "\r")
    const up = rows.length - 1 - cursorRow
    if (this.output.isTTY && process.env.TERM !== "dumb") this.output.write((up ? `\x1b[${up}A` : "") + (cursorCol ? `\x1b[${cursorCol}C` : ""))
    this.rendered = rows.length
    this.cursorRow = cursorRow
    this.cursorCol = cursorCol
  }

  /** Clear/redraw the live composer without losing its draft or cursor. */
  write(text) {
    if (this.screen) { this.screen.write(text); return }
    if (!this.active) { this.output.write(this.liveBuffer + text); this.liveBuffer = ""; return }
    this.liveBuffer += text
    const newline = this.liveBuffer.lastIndexOf("\n")
    if (newline < 0) return
    this.clear()
    this.output.write(this.liveBuffer.slice(0, newline + 1))
    this.liveBuffer = this.liveBuffer.slice(newline + 1)
    this.draw()
  }
  finish(value) {
    const a = this.active
    if (!a) return
    this.clear()
    this.active = null
    if (!this.screen) {
      if (typeof value === "string" && !a.secret && a.kind !== "pick") this.output.write(c.dim(a.label) + " " + safeText(value) + "\n")
      else if (a.secret) this.output.write(c.dim(a.label) + " [hidden]\n")
    }
    a.resolve(value)
    this.active = this.suspended.pop() || null
    if (this.active || this.screen) this.draw()
  }
  enableScreen(options = {}) {
    if (!this.screen) this.screen = new (require("./screen").TerminalScreen)({ output: this.output, ...options })
    return this.screen
  }
  setDialog(dialog) { this.screen?.setDialog(dialog) }
  cancel() { this.finish(null) }
  close() {
    if (this.closed) return
    while (this.active) this.finish(null)
    this.closed = true
    this.input.off("data", this.onData)
    this.input.off("end", this.onEnd)
    this.output.off?.("resize", this.onResize)
    this.keys.destroy()
    clearTimeout(this.escapeTimer)
    this.screen?.close()
    if (this.input.setRawMode) this.input.setRawMode(this.wasRaw)
    if (this.output.isTTY && process.env.TERM !== "dumb") this.output.write("\x1b[?2004l\x1b[?25h\x1b[0m")
    this.input.pause()
    this.emit("close")
  }
}

module.exports = { TerminalInput, cellWidth, wrapLines, segments }
