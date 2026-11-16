"use strict"
/**
 * VibeCoder's cell-based terminal workspace. No terminal/UI dependencies:
 * structured transcript, fixed composer, contextual panel and keyboard modals.
 * Only presentation lives here; the SDK still owns every action and answer.
 */
const path = require("node:path")
const { safeText, screenStyle, currentTheme } = require("./theme")
const { cellWidth, wrapLines, segments } = require("./input")
const { redactText } = require("../core/harness/guard")

const clean = (text) => redactText(safeText(text)).replace(/\t/g, "  ")
const short = (text, width) => {
  let result = "", used = 0
  for (const glyph of segments(clean(text))) {
    const size = cellWidth(glyph)
    if (used + size > Math.max(0, width)) break
    result += glyph; used += size
  }
  return result
}
const number = (value) => {
  const n = Number(value) || 0
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n)
}
const WORDMARK = [
  " __      ___ _          ",
  " \\ \\    / (_) |__   ___ ",
  "  \\ \\  / /| | '_ \\ / _ \\",
  "   \\ \\/ / | | |_) |  __/",
  "    \\__/  |_|_.__/ \\___|",
]

class Canvas {
  constructor(width, height) {
    this.width = width; this.height = height
    this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ text: " ", fg: "text", bg: "background", bold: false })))
  }
  fill(x, y, width, height, style = {}) {
    for (let row = Math.max(0, y); row < Math.min(this.height, y + height); row++) {
      for (let col = Math.max(0, x); col < Math.min(this.width, x + width); col++) this.rows[row][col] = { fg: "text", bg: "background", bold: false, ...style, text: " " }
    }
  }
  put(x, y, text, style = {}) {
    if (y < 0 || y >= this.height) return
    let col = x
    for (const glyph of segments(safeText(text).split("\n")[0])) {
      const width = cellWidth(glyph)
      if (!width) continue
      if (col + width > this.width) break
      if (col >= 0) {
        if (this.rows[y][col].text === "" && col > 0) this.rows[y][col - 1].text = " "
        if (width === 1 && this.rows[y][col + 1]?.text === "") this.rows[y][col + 1].text = " "
        this.rows[y][col] = { fg: "text", bg: "background", bold: false, ...style, text: glyph }
        if (width === 2) this.rows[y][col + 1] = { fg: "text", bg: "background", bold: false, ...style, text: "" }
      }
      col += width
    }
  }
  line(y) { return this.rows[y].map((cell) => cell.text).join("") }
  ansi(y) {
    let last = "", line = ""
    for (const cell of this.rows[y]) {
      if (cell.text === "") continue
      const style = screenStyle(cell)
      if (style !== last) { line += style; last = style }
      line += cell.text
    }
    return line
  }
}

/** A small original Markdown treatment, never terminal controls from a model. */
function styledLines(text, width, muted = false) {
  const rows = []
  let code = false
  for (const raw of clean(text).split("\n")) {
    if (/^\s*```/.test(raw)) {
      code = !code
      if (code) rows.push([{ text: "  " + (raw.replace(/^\s*```\s*/, "") || "code"), fg: "muted", bg: "surface" }])
      else rows.push([])
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(raw)
    const value = heading ? heading[2] : raw
    for (const line of wrapLines(value, Math.max(1, width - (code ? 2 : 0)))) {
      if (code) { rows.push([{ text: "  " + line, fg: "text", bg: "surface" }]); continue }
      const runs = []
      const regex = /(`[^`]+`|\*\*[^*]+\*\*)/g
      let end = 0
      for (const match of line.matchAll(regex)) {
        if (match.index > end) runs.push({ text: line.slice(end, match.index), fg: muted ? "muted" : "text", bold: !!heading })
        runs.push({ text: match[0].startsWith("`") ? match[0].slice(1, -1) : match[0].slice(2, -2), fg: match[0].startsWith("`") ? "accent" : muted ? "muted" : "text", bold: !!heading || match[0].startsWith("**") })
        end = match.index + match[0].length
      }
      runs.push({ text: line.slice(end), fg: muted ? "muted" : "text", bold: !!heading })
      rows.push(runs)
    }
  }
  return rows
}

class TerminalScreen {
  constructor({ output = process.stdout, version = "", context = {}, panel = true } = {}) {
    this.output = output; this.version = version; this.context = context
    this.panel = panel; this.blocks = []; this.tools = new Map(); this.streams = new Map()
    this.todos = []; this.crew = new Map(); this.files = new Map()
    this.totals = {}; this.costKnown = false; this.input = null; this.dialog = null
    this.inspector = null; this.command = null; this.notice = ""; this.busy = false
    this.scrollOffset = 0; this.modalOffset = 0; this.run = 0
    this.anchor = null
    this.previous = []; this.opened = false; this.closed = false
    this.pending = null
    this.onResize = () => { this.previous = []; this.schedule() }
    output.on?.("resize", this.onResize)
  }
  open() {
    if (this.opened || this.closed) return
    this.opened = true
    // Alternate buffer and explicit background replace, not persist, PS blue.
    this.output.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h" + screenStyle() + "\x1b[2J\x1b[H")
    this.render()
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (this.pending) clearImmediate(this.pending)
    this.pending = null
    this.output.off?.("resize", this.onResize)
    if (this.opened) this.output.write("\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l")
    this.opened = false
  }
  schedule() {
    if (this.closed || !this.opened || this.pending) return
    this.pending = setImmediate(() => { this.pending = null; this.render() })
  }
  setInput(input) { this.input = input; this.schedule() }
  setDialog(dialog) { this.dialog = dialog; this.modalOffset = 0; this.schedule() }
  setContext(context) { this.context = { ...this.context, ...context }; this.schedule() }
  setHistory(session) {
    this.blocks = []; this.tools.clear(); this.streams.clear(); this.scrollOffset = 0; this.anchor = null
    this.todos = Array.isArray(session.todos) ? session.todos : []
    this.totals = { input: session.usage?.totalInput || 0, output: session.usage?.totalOutput || 0, cost: session.usage?.totalCost || 0 }
    this.costKnown = session.usage?.totalCost !== undefined
    for (const message of session.messages || []) {
      for (const part of message.parts || []) {
        if (part.agentOnly) continue
        if (part.type === "text" && part.text) this.addBlock({ kind: message.role === "assistant" ? "assistant" : "user", text: clean(part.text), speaker: message.role === "assistant" ? "VibeCoder" : "You" })
        else if (part.type === "image") this.addBlock({ kind: "activity", text: "Image attachment", status: "done" })
        else if (part.type === "tool_use") {
          const block = { kind: "tool", id: part.id, name: part.name, brief: this.brief(part.args), args: part.args, status: "done", output: "" }
          this.addBlock(block); this.tools.set(part.id, block)
        } else if (part.type === "tool_result" && this.tools.has(part.id)) {
          const block = this.tools.get(part.id)
          block.status = part.isError ? "error" : "done"; block.output = clean(part.output || "")
        }
      }
    }
    this.schedule()
  }
  addBlock(block) {
    this.blocks.push(block)
    if (this.blocks.length > 500) this.blocks.shift()
    this.schedule()
    return block
  }
  userMessage(text, files = []) {
    this.notice = ""; this.inspector = null; this.scrollOffset = 0; this.anchor = null
    this.streams.clear()
    this.addBlock({ kind: "user", speaker: "You", text: clean(text) + (files.length ? `\n[${files.length} image attachment(s)]` : "") })
  }
  brief(args = {}) { return clean(args.command || args.path || args.pattern || args.url || args.task || args.id || "") }
  event(event, state = {}) {
    const ev = event
    const actor = ev.subagentId || "main"
    const key = `${this.run}:${actor}:${ev.type === "reasoning.delta" ? "thinking" : "text"}`
    if (ev.type === "run.start" && !ev.subagentId) {
      this.run++; this.busy = true; this.streams.clear(); this.notice = "Working"
    } else if (ev.type === "text.delta" || ev.type === "reasoning.delta") {
      if (ev.type === "reasoning.delta" && !state.showReasoning || state.quiet && ev.subagentId) return
      let block = this.streams.get(key)
      if (!block) {
        block = this.addBlock({ kind: ev.type === "reasoning.delta" ? "thinking" : "assistant", speaker: ev.subagentId ? `Crew / ${ev.subagentName || "helper"}` : "VibeCoder", text: "" })
        this.streams.set(key, block)
      }
      block.text = (block.text + clean(ev.delta || "")).slice(-200000)
    } else if (ev.type === "tool.start") {
      for (const name of [...this.streams.keys()]) if (name.includes(":" + actor + ":")) this.streams.delete(name)
      const block = this.addBlock({ kind: "tool", id: ev.id, name: ev.name, brief: this.brief(ev.args), args: ev.args, status: "running", output: "" })
      this.tools.set(ev.id, block)
    } else if (ev.type === "tool.end") {
      const block = this.tools.get(ev.id)
      if (block) {
        block.status = ev.isError ? "error" : "done"
        block.output = clean(ev.output || "").slice(-12000); block.duration = ev.durationMs
        if (/write|edit|patch/.test(block.name) && block.args?.path) this.files.set(block.args.path, ev.stats || {})
      }
    } else if (ev.type === "todo.update") this.todos = ev.todos || []
    else if (ev.type === "usage") {
      this.totals = { ...state.totals }; this.costKnown = !!state.costKnown
      if (!ev.subagentId && this.context.limit) this.context.percent = Math.round(100 * ((ev.input || 0) + (ev.cache?.read || 0) + (ev.cache?.write || 0)) / this.context.limit)
    } else if (ev.type === "subagent.start" || ev.type === "subagent.end" || ev.type === "subagent.error") {
      this.crew.set(ev.subagentId || ev.name, { name: ev.subagentName || ev.name || "helper", status: ev.status || (ev.type === "subagent.start" ? "running" : "error") })
      this.addBlock({ kind: "activity", text: `Crew ${ev.subagentName || ev.name || "helper"} ${ev.status || (ev.type === "subagent.start" ? "started" : "failed")}`, status: ev.type === "subagent.error" ? "error" : "done" })
    } else if (ev.type === "shell.backgrounded" || ev.type === "shell.completed" || ev.type === "shell.waiting") {
      this.addBlock({ kind: "activity", text: ev.type === "shell.waiting" ? `Shell needs input: ${clean(ev.prompt)}` : `Shell ${ev.shell?.id || ""} ${ev.type === "shell.backgrounded" ? "running in background" : ev.shell?.status || "finished"}`, status: ev.type === "shell.waiting" ? "warning" : ev.shell?.status === "error" ? "error" : "done" })
    } else if (ev.type === "compaction.start" || ev.type === "compaction.end") {
      this.addBlock({ kind: "activity", text: ev.type === "compaction.start" ? "Compacting context" : ev.summarized === false ? "Compaction did not complete" : `Context compacted: ${number(ev.before)} to ${number(ev.after)} tokens`, status: ev.summarized === false ? "warning" : "done" })
    } else if (ev.type === "notice" || ev.type === "error") this.addBlock({ kind: ev.type === "error" ? "error" : "activity", text: clean(ev.text || ev.message || ev.error || ""), status: ev.type === "error" ? "error" : "done" })
    else if (ev.type === "done" && !ev.subagentId) {
      this.busy = false
      this.notice = ev.reason === "error" ? "Turn failed / use resume to continue" : ev.reason === "interrupted" ? "Interrupted" : "Ready"
    }
    this.schedule()
  }
  beginCommand(name) { this.command = { name, text: "" }; this.inspector = null }
  endCommand() {
    const command = this.command
    this.command = null
    if (!command?.text.trim()) { this.schedule(); return }
    const lines = command.text.trim().split("\n")
    if (lines.length <= 2) this.notice = clean(lines.join(" / "))
    else this.inspector = { title: "/" + command.name, text: clean(command.text.trim()), offset: 0 }
    this.schedule()
  }
  write(text) {
    const value = clean(text)
    if (this.command) this.command.text = (this.command.text + value).slice(-200000)
    else if (value.trim()) this.notice = value.replace(/\s+/g, " ").trim()
    this.schedule()
  }
  clearTranscript() { this.blocks = []; this.streams.clear(); this.tools.clear(); this.scrollOffset = 0; this.anchor = null; this.schedule() }
  handleKey(key) {
    if (key.ctrl && key.name === "l") { this.previous = []; this.schedule(); return true }
    if (this.inspector) {
      if (key.name === "escape" || key.ctrl && key.name === "c") { this.inspector = null; this.schedule(); return true }
      if (["up", "down", "pageup", "pagedown", "home", "end"].includes(key.name)) {
        const delta = ["up", "pageup"].includes(key.name) ? -1 : 1
        this.inspector.offset = key.name === "home" ? 0 : key.name === "end" ? 100000 : Math.max(0, this.inspector.offset + delta * (key.name.startsWith("page") ? 10 : 1))
        this.schedule(); return true
      }
    }
    if (key.ctrl && key.name === "s" && !this.dialog) { this.panel = !this.panel; this.schedule(); return true }
    if (["pageup", "pagedown"].includes(key.name) && this.input?.kind !== "pick") {
      if (this.dialog) this.modalOffset = Math.max(0, this.modalOffset + (key.name === "pageup" ? -1 : 1) * 5)
      else {
        const start = this.lastFrame?.contentStart || 0
        const max = this.lastFrame?.maxStart || 0
        this.anchor = Math.max(0, Math.min(max, start + (key.name === "pageup" ? -10 : 10)))
        if (this.anchor === max) { this.anchor = null; this.scrollOffset = 0 }
      }
      this.schedule(); return true
    }
    if (key.ctrl && key.name === "end" && !this.dialog) { this.scrollOffset = 0; this.anchor = null; this.schedule(); return true }
    return false
  }
  mouse(event) {
    if (event.release) return null
    const frame = this.lastFrame || this.frame()
    const inside = (box) => box && event.x >= box.x && event.x < box.x + box.width && event.y >= box.y && event.y < box.y + box.height
    if (event.button & 64) {
      if ((event.button & 3) > 1) return null
      const direction = event.button & 1 ? 1 : -1
      if (this.inspector) this.inspector.offset = Math.max(0, this.inspector.offset + direction * 3)
      else if (this.input?.kind === "pick") {
        const hits = this.input.rows.filter((r) => `${r.label} ${r.description || ""}`.toLowerCase().includes(this.input.text.toLowerCase()))
        this.input.index = Math.max(0, Math.min(hits.length - 1, this.input.index + direction * 3))
      } else if (this.dialog) this.modalOffset = Math.max(0, this.modalOffset + direction * 3)
      else if (inside(frame.regions.content)) {
        const max = frame.maxStart || 0
        this.anchor = Math.max(0, Math.min(max, (frame.contentStart || 0) + direction * 3))
        if (this.anchor === max) { this.anchor = null; this.scrollOffset = 0 }
      }
      this.schedule()
      return null
    }
    if ((event.button & 3) !== 0) return (event.button & 3) === 2 ? { kind: "paste" } : null
    if (inside(frame.regions.access)) return { kind: "access" }
    if (this.input?.kind === "pick" && inside(frame.regions.modal)) {
      const row = (frame.regions.pickRows || []).find((r) => event.y === r.y && event.x >= r.x && event.x < r.x + r.width)
      if (row) return { kind: "pick", value: row.value }
    }
    return null
  }
  transcript(width) {
    const rows = []
    const push = (runs) => rows.push(runs)
    for (const block of this.blocks) {
      if (["assistant", "user", "thinking", "error"].includes(block.kind)) {
        if (rows.length && rows.at(-1).length) push([])
        push([{ text: block.kind === "error" ? "Error" : block.kind === "thinking" ? "Thinking" : block.speaker, fg: block.kind === "user" ? "accent" : block.kind === "error" ? "error" : block.kind === "thinking" ? "muted" : "text", bold: block.kind !== "thinking" }])
        rows.push(...styledLines(block.text, width, block.kind === "thinking"))
        push([])
      } else if (block.kind === "tool") {
        const mark = block.status === "running" ? "..." : block.status === "error" ? "!" : "+"
        const fg = block.status === "error" ? "error" : block.status === "running" ? "accent" : "muted"
        push([{ text: `[${mark}] `, fg }, { text: block.name + " ", fg, bold: true }, { text: short(block.brief, Math.max(1, width - block.name.length - 5)), fg: "muted" }])
        if (block.status === "error") rows.push(...styledLines(block.output.split("\n")[0], width, true))
      } else rows.push(...styledLines("  " + block.text, width, true))
    }
    return rows
  }
  putRuns(canvas, x, y, runs, width, base = {}) {
    if (runs.some((run) => run.bg === "surface")) canvas.fill(x, y, width, 1, { bg: "surface" })
    let col = x
    for (const run of runs) {
      const value = short(run.text, x + width - col)
      canvas.put(col, y, value, { ...base, ...run }); col += cellWidth(value)
      if (col >= x + width) break
    }
  }
  frame() {
    const cols = Math.max(1, (this.output.columns || 80) - 1), rows = Math.max(1, this.output.rows || 24)
    const canvas = new Canvas(cols, rows)
    const regions = {}
    let cursor = null
    const small = cols < 35 || rows < 12
    if (small) {
      canvas.put(0, 0, short("VibeCoder / widen terminal", cols), { fg: "accent", bold: true })
      const value = this.input?.secret ? "*".repeat(segments(this.input.text).length) : this.input?.text || ""
      if (rows > 1) canvas.put(0, rows - 2, short("> " + value, cols))
      if (rows > 2) canvas.put(0, rows - 1, short("Enter send / Ctrl+C exit", cols), { fg: "muted" })
      if (this.input && rows > 1) cursor = { x: Math.min(cols - 1, 2 + cellWidth(value)), y: rows - 2 }
      return { canvas, cursor, regions, small }
    }
    const home = !this.blocks.length
    const sideWidth = !home && this.panel && cols >= 110 ? 28 : 0
    const mainWidth = cols - sideWidth
    const title = this.context.title && this.context.title !== "New session" ? this.context.title : "New task"
    const version = "VibeCoder " + this.version
    canvas.put(2, 0, short(this.context.workspace || path.basename(this.context.directory || "") || "Workspace", Math.max(4, Math.min(24, cols - version.length - 7))), { fg: "text", bold: true })
    canvas.put(2, 1, short(title, mainWidth - 5), { fg: "muted" })
    canvas.put(Math.max(2, cols - version.length - 2), 0, version, { fg: "muted" })
    const inputWidth = Math.max(16, Math.min(home ? 80 : mainWidth - 4, mainWidth - 4))
    const inputX = home ? Math.floor((mainWidth - inputWidth) / 2) : 2
    const active = this.input
    const text = active?.kind === "text" && active.multiline ? active.text : ""
    const inputLines = wrapLines(text, inputWidth - 5)
    const inputHeight = Math.max(4, Math.min(9, rows - 7, inputLines.length + 3))
    const inputY = home ? Math.min(rows - inputHeight - 3, Math.max(7, Math.floor(rows * 0.55))) : rows - inputHeight - 2
    regions.composer = { x: inputX, y: inputY, width: inputWidth, height: inputHeight }
    regions.content = { x: 2, y: 3, width: mainWidth - 4, height: Math.max(1, inputY - 4) }
    let contentStart = 0, maxStart = 0
    if (home) {
      const logo = "VibeCoder"
      const y = Math.max(3, inputY - 5)
      if (rows >= 30 && mainWidth >= 85) {
        const wordmarkX = Math.floor((mainWidth - 25) / 2)
        for (let i = 0; i < WORDMARK.length; i++) canvas.put(wordmarkX, y - 6 + i, WORDMARK[i], { fg: "accent", bold: true })
      }
      canvas.put(Math.floor((mainWidth - logo.length) / 2), y, logo, { fg: "text", bold: true })
      const sub = "Work on your next change."
      canvas.put(Math.floor((mainWidth - sub.length) / 2), y + 2, sub, { fg: "muted" })
    } else {
      const content = this.transcript(regions.content.width)
      const maxOffset = Math.max(0, content.length - regions.content.height)
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
      const start = this.anchor === null ? Math.max(0, content.length - regions.content.height - this.scrollOffset) : Math.min(this.anchor, maxOffset)
      this.scrollOffset = Math.max(0, content.length - regions.content.height - start)
      contentStart = start; maxStart = maxOffset
      for (let i = 0; i < regions.content.height && start + i < content.length; i++) this.putRuns(canvas, 2, 3 + i, content[start + i], regions.content.width)
    }
    canvas.fill(inputX, inputY, inputWidth, inputHeight, { bg: "surface" })
    canvas.put(inputX + 1, inputY + 1, ">", { fg: "accent", bg: "surface", bold: true })
    const visibleCount = inputHeight - 3
    const before = wrapLines(text.slice(0, active?.cursor || 0), inputWidth - 5)
    const start = Math.max(0, before.length - visibleCount)
    if (text) {
      for (let i = 0; i < visibleCount; i++) canvas.put(inputX + 3, inputY + 1 + i, inputLines[start + i] || "", { bg: "surface" })
    } else canvas.put(inputX + 3, inputY + 1, short(this.busy ? "Working / Ctrl+C interrupts" : "Ask VibeCoder to work in this project...", inputWidth - 5), { fg: "muted", bg: "surface" })
    const identity = `${this.context.agent || "Pilot"} / ${this.context.provider || "Select provider"}`
    const mode = inputWidth < 58 ? this.context.yes ? "Full" : "Ask" : this.context.yes ? "Full Access" : "Ask before changes"
    const percent = this.context.percent == null ? "" : inputWidth < 58 ? `  ${this.context.percent}%` : `  ${this.context.percent}% context`
    canvas.put(inputX + 3, inputY + inputHeight - 1, short(identity, inputWidth - mode.length - percent.length - 7), { fg: "accent", bg: "surface" })
    const accessX = inputX + Math.max(3, inputWidth - mode.length - percent.length - 2)
    canvas.put(accessX, inputY + inputHeight - 1, mode + percent, { fg: this.context.yes ? "warning" : "muted", bg: "surface" })
    regions.access = { x: accessX, y: inputY + inputHeight - 1, width: mode.length, height: 1 }
    if (active?.kind === "text" && active.multiline) cursor = { x: Math.min(cols - 1, inputX + 3 + cellWidth(before.at(-1))), y: inputY + 1 + Math.min(visibleCount - 1, before.length - start - 1) }
    if (sideWidth) {
      regions.panel = { x: mainWidth + 1, y: 3, width: sideWidth - 3, height: rows - 6 }
      for (let y = 2; y < rows - 2; y++) canvas.put(mainWidth, y, "|", { fg: "border" })
      this.drawPanel(canvas, regions.panel)
    }
    const footer = this.scrollOffset ? `History / ${this.scrollOffset} rows above latest   Ctrl+End latest` : "Enter send   Ctrl+J newline   Ctrl+V paste   F4 access   Mouse/PgUp history"
    canvas.put(2, rows - 1, short(footer, cols - 4), { fg: "muted" })
    if (this.notice && !home) canvas.put(2, inputY - 1, short(this.notice, mainWidth - 4), { fg: this.busy ? "accent" : "muted" })
    if (active && (active.kind === "pick" || !active.multiline) || this.inspector) cursor = this.drawModal(canvas, regions)
    return { canvas, cursor, regions, small: false, home, contentStart, maxStart }
  }
  drawPanel(canvas, box) {
    let y = box.y
    const line = (text, fg = "muted", bold = false) => { if (y < box.y + box.height) canvas.put(box.x + 1, y++, short(text, box.width - 1), { fg, bold }) }
    line("Context", "text", true)
    const percent = Math.max(0, Math.min(100, this.context.percent || 0))
    const filled = Math.round(percent / 100 * 20)
    line("[" + "=".repeat(filled) + " ".repeat(20 - filled) + "]", "accent")
    line(`${percent}% / ${number(this.context.limit)} limit`)
    y++
    line("Usage", "text", true)
    line(`${number(this.totals.input)} input`)
    line(`${number(this.totals.output)} output`)
    if (this.totals.reasoning) line(`${number(this.totals.reasoning)} thinking`)
    if (this.costKnown) line(`$${Number(this.totals.cost || 0).toFixed(4)}`, "text")
    else line("Cost not reported")
    if (this.todos.length) {
      y++; line("Todo", "text", true)
      for (const todo of this.todos.slice(0, 5)) line(`${todo.status === "completed" ? "[+]" : todo.status === "in_progress" ? "[>]" : "[ ]"} ${todo.content || todo.text || ""}`, todo.status === "in_progress" ? "accent" : "muted")
    }
    if (this.crew.size) {
      y++; line("Crew", "text", true)
      for (const member of [...this.crew.values()].slice(-4)) line(`${member.name} / ${member.status}`, member.status === "running" ? "accent" : "muted")
    }
    if (this.files.size) {
      y++; line("Changed files", "text", true)
      for (const file of [...this.files.keys()].slice(-5)) line(path.basename(file))
    }
    y++; line(this.context.mode === "remote" ? "Desktop host attached" : "Standalone engine")
  }
  drawModal(canvas, regions) {
    const active = this.input
    const picker = active?.kind === "pick"
    const inspector = this.inspector
    const dialog = this.dialog
    const width = Math.max(20, Math.min(78, canvas.width - 8))
    const x = Math.floor((canvas.width - width) / 2)
    const pickerCount = picker ? active.rows.filter((r) => `${r.label} ${r.description || ""}`.toLowerCase().includes(active.text.toLowerCase())).length : 0
    const height = Math.min(canvas.height - 6, inspector ? canvas.height - 6 : picker ? Math.max(9, Math.min(16, pickerCount + 9)) : Math.max(8, Math.min(20, (dialog?.options?.length || 0) + 9)))
    const y = Math.max(2, Math.floor((canvas.height - height) / 2))
    regions.modal = { x, y, width, height }
    for (const row of canvas.rows) for (const cell of row) { cell.fg = "muted"; cell.bold = false }
    canvas.fill(x - 1, y - 1, width + 2, height + 2, { bg: "subtle" })
    canvas.fill(x, y, width, height, { bg: "surface" })
    const title = inspector?.title || (picker ? active.label : dialog?.title || (active?.secret ? "Secure input" : "VibeCoder"))
    canvas.put(x + 2, y + 1, short(title, width - 4), { fg: dialog?.kind === "permission" ? "warning" : "text", bg: "surface", bold: true })
    if (inspector) {
      const body = styledLines(inspector.text, width - 4)
      const max = Math.max(0, body.length - height + 5)
      inspector.offset = Math.min(inspector.offset, max)
      for (let i = 0; i < height - 5 && i + inspector.offset < body.length; i++) this.putRuns(canvas, x + 2, y + 3 + i, body[i + inspector.offset], width - 4, { bg: "surface" })
      canvas.put(x + 2, y + height - 1, short("Up/Down scroll   PgUp/PgDn page   Esc close", width - 4), { fg: "muted", bg: "surface" })
      return null
    }
    if (picker) {
      canvas.put(x + 2, y + 3, short("Search  " + active.text, width - 4), { fg: "muted", bg: "surface" })
      const hits = active.rows.filter((r) => `${r.label} ${r.description || ""}`.toLowerCase().includes(active.text.toLowerCase()))
      active.index = Math.max(0, Math.min(active.index, hits.length - 1))
      const start = Math.max(0, active.index - Math.floor((height - 8) / 2))
      regions.pickRows = []
      for (let i = 0; i < height - 7 && i + start < hits.length; i++) {
        const selected = start + i === active.index
        canvas.fill(x + 1, y + 5 + i, width - 2, 1, { bg: selected ? "selection" : "surface" })
        canvas.put(x + 2, y + 5 + i, short((selected ? "> " : "  ") + hits[start + i].label, width - 4), { fg: selected ? "onSelection" : "text", bg: selected ? "selection" : "surface", bold: selected })
        regions.pickRows.push({ x: x + 1, y: y + 5 + i, width: width - 2, value: hits[start + i] })
      }
      if (!hits.length) canvas.put(x + 2, y + 5, "No matches", { fg: "muted", bg: "surface" })
      if (hits[active.index]?.description) canvas.put(x + 2, y + height - 2, short(hits[active.index].description, width - 4), { fg: "muted", bg: "surface" })
      canvas.put(x + 2, y + height - 1, short("Up/Down select   Enter choose   Esc cancel", width - 4), { fg: "muted", bg: "surface" })
      return { x: Math.min(x + width - 2, x + 10 + cellWidth(active.text)), y: y + 3 }
    }
    const body = [
      ...(dialog?.body ? wrapLines(clean(dialog.body), width - 4) : []),
      ...(dialog?.options || []).map((o, i) => `${i + 1}. ${o.label}${o.description ? " / " + o.description : ""}`),
    ].flatMap((s) => wrapLines(s, width - 4))
    const max = Math.max(0, body.length - height + 7)
    this.modalOffset = Math.min(this.modalOffset, max)
    for (let i = 0; i < height - 7 && i + this.modalOffset < body.length; i++) canvas.put(x + 2, y + 3 + i, body[i + this.modalOffset], { bg: "surface" })
    const value = active?.secret ? "*".repeat(segments(active.text).length) : active?.text || ""
    canvas.fill(x + 1, y + height - 3, width - 2, 1, { bg: "subtle" })
    canvas.put(x + 2, y + height - 3, short("> " + value, width - 4), { fg: "text", bg: "subtle" })
    const hint = dialog?.hint || active?.label || "Enter confirm / Esc cancel"
    canvas.put(x + 2, y + height - 1, short(hint, width - 4), { fg: "muted", bg: "surface" })
    return { x: Math.min(x + width - 2, x + 4 + cellWidth(active?.secret ? "*".repeat(segments(active.text.slice(0, active.cursor)).length) : active?.text.slice(0, active.cursor) || "")), y: y + height - 3 }
  }
  render() {
    if (this.closed || !this.opened) return
    const frame = this.frame()
    this.lastFrame = frame
    const theme = currentTheme()
    const full = this.previous.length !== frame.canvas.height || this.previousWidth !== frame.canvas.width || this.previousTheme !== theme
    let output = "\x1b[?25l"
    if (full) output += screenStyle() + "\x1b[2J"
    const next = []
    for (let row = 0; row < frame.canvas.height; row++) {
      const text = frame.canvas.ansi(row)
      next.push(text)
      if (full || text !== this.previous[row]) output += `\x1b[${row + 1};1H` + text + screenStyle() + "\x1b[K"
    }
    if (frame.cursor) output += `\x1b[${Math.max(1, Math.min(frame.canvas.height, frame.cursor.y + 1))};${Math.max(1, Math.min(frame.canvas.width, frame.cursor.x + 1))}H\x1b[?25h`
    this.output.write(output)
    this.previous = next; this.previousWidth = frame.canvas.width; this.previousTheme = theme
  }
}

module.exports = { TerminalScreen, Canvas, styledLines, short }
