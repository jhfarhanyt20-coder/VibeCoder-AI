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
// VibeCoder's own block wordmark (5 rows): "VIBE" in the accent colour,
// "CODER" in the text colour. Plain block characters, width 1 in every console.
const LETTERS = {
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  B: ["████ ", "█   █", "████ ", "█   █", "████ "],
  E: ["█████", "█    ", "████ ", "█    ", "█████"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  O: [" ███ ", "█   █", "█   █", "█   █", " ███ "],
  D: ["████ ", "█   █", "█   █", "█   █", "████ "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
}
const wordRows = (word) => LETTERS.V.map((_, row) => [...word].map((ch) => LETTERS[ch][row]).join(" "))
const WORDMARK = { vibe: wordRows("VIBE"), coder: wordRows("CODER") }
const WORDMARK_WIDTH = WORDMARK.vibe[0].length + 2 + WORDMARK.coder[0].length
// Friendly names for tool rows; unknown tools keep their own name.
const TOOL_LABELS = {
  bash: "Shell", shell: "Shell", read: "Read", write: "Write", edit: "Edit", multiedit: "Edit", patch: "Patch", apply_patch: "Patch",
  list: "List", glob: "Find files", grep: "Search", webfetch: "Fetch", websearch: "Web search", todowrite: "Plan", question: "Question",
  subagent: "Crew", subagentResult: "Crew result", subagentStatus: "Crew status", memory: "Memory", skill: "Skill", vibecoder_help: "Guide",
}
const toolLabel = (name = "") => TOOL_LABELS[name] || (String(name).startsWith("computer_") ? "Computer · " + String(name).slice(9).replace(/_/g, " ") : String(name).startsWith("browser") ? "Browser · " + String(name).replace(/^browser[_.]?/, "") : String(name))
// One-line descriptions for the "/" dropdown (commands without one still show).
const COMMAND_INFO = {
  help: "all commands and keys", model: "pick or switch the model", models: "provider catalog", agent: "pick an agent",
  new: "start a new session", sessions: "open an earlier session", use: "open a session by number or id", rename: "rename this session",
  delete: "delete this session", compact: "summarize old context", undo: "rewind the last turn", redo: "restore what undo removed",
  steps: "step snapshots", step: "undo one step", diff: "preview changes", history: "show the saved conversation", export: "export this session",
  usage: "tokens and cost", skills: "playbooks you can load", skill: "load a playbook", playbooks: "playbooks", agents: "agent definitions",
  recipes: "prompt recipes", recipe: "run a recipe", memory: "saved notes", mcp: "MCP servers", plugins: "plugins", extensions: "extensions",
  tools: "available tools", doctor: "check the setup", config: "settings", theme: "terminal colours", access: "Ask or Full Access",
  computer: "Computer Use on/off", connectors: "GitHub / Facebook sign-in", provider: "add or test providers", permissions: "permission rules",
  locks: "hard locks", forms: "pending questions", crew: "helpers and their work", shells: "running shells", shell: "shell output and input",
  trail: "audit log", todos: "the task list", browser: "the real desktop browser", marketplace: "catalog", registry: "catalog",
  auth: "API keys", profile: "advanced profiles", reasoning: "show or hide thinking", thinking: "reasoning effort", verbose: "detailed tool output",
  yes: "toggle Full Access", dir: "working folder", clear: "clear the screen", exit: "leave", quit: "leave", fallback: "failover chain for outages",
}
const seconds = (ms) => (ms >= 10000 ? Math.round(ms / 1000) + "s" : (ms / 1000).toFixed(1) + "s")
// The terminal window's own title bar ("VibeCoder · project"); controls removed.
const windowTitle = (text) => "\x1b]0;" + String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 120) + "\x07"

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
    // The real console window: dark title bar + VibeCoder icon (Windows; undone on close).
    if (this.output === process.stdout) { try { this.restoreChrome = require("./window-chrome").applyWindowChrome({ output: this.output, onReady: () => { this.windowControls = true; this.lastTitle = null; this.updateTitle(); this.previous = []; this.schedule() } }) } catch {} }
    this.updateTitle()
    this.render()
  }
  /** Title bar buttons: min / max / drag go to the window helper. */
  windowAction(action) { return !!this.restoreChrome?.send?.(action) }
  /** The window's title bar shows VibeCoder and the project, not a file path. */
  updateTitle() {
    if (!this.opened || this.closed) return
    const name = this.context.workspace || path.basename(this.context.directory || "") || ""
    const title = `VibeCoder${name ? " · " + name : ""}${this.busy ? " · working" : ""}`
    if (title === this.lastTitle) return
    this.lastTitle = title
    this.output.write(windowTitle(title))
  }
  /** While the agent works the status line ticks (time + pulsing dot). */
  tick(on) {
    if (on && !this.ticker && !this.closed) {
      this.ticker = setInterval(() => { this.pulse = !this.pulse; this.schedule() }, 500)
      this.ticker.unref?.()
    } else if (!on && this.ticker) { clearInterval(this.ticker); this.ticker = null }
  }
  close() {
    if (this.closed) return
    this.closed = true
    if (this.pending) clearImmediate(this.pending)
    this.pending = null
    this.output.off?.("resize", this.onResize)
    this.tick(false)
    try { this.restoreChrome?.() } catch {}
    if (this.opened) this.output.write("\x1b[?1000l\x1b[?1006l\x1b[0m\x1b[?25h\x1b[?1049l" + windowTitle("VibeCoder"))
    this.opened = false
  }
  schedule() {
    if (this.closed || !this.opened || this.pending) return
    this.pending = setImmediate(() => { this.pending = null; this.render() })
  }
  setInput(input) { this.input = input; this.schedule() }
  setDialog(dialog) { this.dialog = dialog; this.modalOffset = 0; this.schedule() }
  setContext(context) { this.context = { ...this.context, ...context }; this.updateTitle(); this.schedule() }
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
      this.busySince = Date.now(); this.tick(true); this.updateTitle()
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
      this.lastRunMs = this.busySince ? Date.now() - this.busySince : 0
      this.busySince = 0; this.tick(false); this.updateTitle()
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
  /** "/" dropdown: matching commands while the draft is a bare "/word". */
  suggestions() {
    const a = this.input
    if (!a || a.kind === "pick" || !a.multiline || this.dialog || this.inspector) return []
    const m = /^\/([\w-]*)$/.exec(a.text || "")
    if (!m) return []
    const names = Array.isArray(this.context.commands) && this.context.commands.length ? this.context.commands : Object.keys(COMMAND_INFO)
    const want = m[1].toLowerCase()
    const starts = names.filter((n) => n.startsWith(want))
    const inner = want ? names.filter((n) => !n.startsWith(want) && n.includes(want)) : []
    return [...new Set([...starts, ...inner])].map((name) => ({ name, info: COMMAND_INFO[name] || "" }))
  }
  handleKey(key) {
    const hints = this.suggestions()
    if (hints.length) {
      this.suggestIndex = Math.max(0, Math.min(hints.length - 1, this.suggestIndex || 0))
      if (key.name === "up" || key.name === "down") {
        this.suggestIndex = (this.suggestIndex + (key.name === "up" ? hints.length - 1 : 1)) % hints.length
        this.schedule(); return true
      }
      const pick = hints[this.suggestIndex]
      if (key.name === "tab" && pick) {
        this.input.text = "/" + pick.name + " "; this.input.cursor = this.input.text.length; this.suggestIndex = 0
        this.schedule(); return true
      }
      // Enter runs the highlighted command (the input then sends this text).
      if ((key.name === "return" || key.name === "enter") && pick && !key.meta && !key.ctrl) {
        this.input.text = "/" + pick.name; this.input.cursor = this.input.text.length; this.suggestIndex = 0
        return false
      }
    } else this.suggestIndex = 0
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
    if ((event.button & 3) === 0 && !(event.button & 32) && !this.dialog && !this.inspector && this.input?.kind !== "pick") {
      // Own title bar: buttons, double-click to maximize, press-and-drag to move.
      if (inside(frame.regions.winClose)) return { kind: "window", action: "close" }
      if (inside(frame.regions.winMax)) return { kind: "window", action: "max" }
      if (inside(frame.regions.winMin)) return { kind: "window", action: "min" }
      if (this.windowControls && inside(frame.regions.header)) {
        const now = Date.now(), double = now - (this.lastHeaderClick || 0) < 450
        this.lastHeaderClick = double ? 0 : now
        return { kind: "window", action: double ? "max" : "drag" }
      }
      // Sessions sidebar.
      if (inside(frame.regions.newSession)) return { kind: "newSession" }
      const row = (frame.regions.sessionRows || []).find((r) => event.y === r.y && event.x >= r.x && event.x < r.x + r.width)
      if (row) return { kind: "session", id: row.id }
    }
    if ((event.button & 3) === 2 && !(event.button & 32) && !this.dialog && !this.inspector && this.input?.kind !== "pick") {
      // Right-click on a session: open / rename / delete menu (elsewhere: paste, as before).
      const row = (frame.regions.sessionRows || []).find((r) => event.y === r.y && event.x >= r.x && event.x < r.x + r.width)
      if (row) return { kind: "sessionMenu", id: row.id }
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
        // ● Label  brief · 1.2s  — the dot is green when done, red on error and
        // pulses while running; one dim result line below says what came back.
        const running = block.status === "running"
        const dotFg = block.status === "error" ? "error" : running ? (this.pulse ? "accent" : "muted") : "success"
        const label = toolLabel(block.name)
        const time = block.duration ? " · " + seconds(block.duration) : ""
        push([{ text: "● ", fg: dotFg }, { text: label + "  ", fg: block.status === "error" ? "error" : "text", bold: true }, { text: short(block.brief, Math.max(1, width - cellWidth(label) - cellWidth(time) - 5)), fg: "muted" }, { text: time, fg: "muted" }])
        const first = String(block.output || "").split("\n").map((s) => s.trim()).find(Boolean)
        if (block.status === "error") push([{ text: "  └ ", fg: "border" }, { text: short(first || "failed", width - 4), fg: "error" }])
        else if (!running && first) {
          const count = String(block.output).split("\n").filter((s) => s.trim()).length
          push([{ text: "  └ ", fg: "border" }, { text: short(first, width - 16), fg: "muted" }, { text: count > 1 ? `  +${count - 1} lines` : "", fg: "border" }])
        }
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
    // Left: every session of this project, like the desktop app's sidebar.
    const sessions = Array.isArray(this.context.sessions) ? this.context.sessions : null
    const left = sessions && this.sessionsPanel !== false && cols >= 100 ? (cols >= 150 ? 32 : 26) : 0
    const sideWidth = !home && this.panel && cols - left >= 110 ? 28 : 0
    const mainWidth = cols - sideWidth - left
    const X = left
    const title = this.context.title && this.context.title !== "New session" ? this.context.title : "New task"
    // VibeCoder's own title bar: brand, project and task on the left; the
    // model and version on the right; window buttons when the native bar is hidden.
    const project = this.context.workspace || path.basename(this.context.directory || "") || "Workspace"
    canvas.fill(0, 0, cols, 1, { bg: "surface" })
    regions.header = { x: 0, y: 0, width: cols, height: 1 }
    canvas.put(1, 0, "▌", { fg: "accent", bg: "surface", bold: true }) // block glyph: present in every console font
    canvas.put(3, 0, "Vibe", { fg: "accent", bg: "surface", bold: true })
    canvas.put(7, 0, "Coder", { fg: "text", bg: "surface", bold: true })
    let rightEdge = cols
    if (this.windowControls) {
      // ─ minimize   □ maximize/restore   × close (glyphs present in console fonts)
      const buttons = [["winMin", "─"], ["winMax", "□"], ["winClose", "×"]]
      rightEdge = cols - buttons.length * 4
      buttons.forEach(([key, glyph], i) => {
        const bx = rightEdge + i * 4
        canvas.put(bx + 1, 0, glyph, { fg: key === "winClose" ? "error" : "muted", bg: "surface", bold: true })
        regions[key] = { x: bx, y: 0, width: 4, height: 1 }
      })
    }
    const right = `${this.context.model ? short(this.context.model, 30) + "  " : this.context.provider ? short(this.context.provider, 28) + "  " : ""}v${this.version}`
    const rightX = Math.max(14, rightEdge - cellWidth(right) - 2)
    const middleRoom = Math.max(0, rightX - 18)
    if (middleRoom > 4) {
      canvas.put(13, 0, "│", { fg: "border", bg: "surface" })
      const proj = short(project, Math.max(4, Math.min(28, middleRoom - 4)))
      canvas.put(15, 0, proj, { fg: "text", bg: "surface", bold: true })
      const taskX = 15 + cellWidth(proj) + 2
      if (rightX - taskX > 8) canvas.put(taskX, 0, short("· " + (this.busy ? "working · " : "") + title, rightX - taskX - 2), { fg: this.busy ? "accent" : "muted", bg: "surface" })
    }
    canvas.put(rightX, 0, right, { fg: "muted", bg: "surface" })
    canvas.put(0, 1, "─".repeat(cols), { fg: "subtle" })
    if (left) this.drawSessions(canvas, regions, left, rows)
    const inputWidth = Math.max(16, Math.min(home ? 80 : mainWidth - 4, mainWidth - 4))
    const inputX = X + (home ? Math.floor((mainWidth - inputWidth) / 2) : 2)
    const active = this.input
    const text = active?.kind === "text" && active.multiline ? active.text : ""
    const inputLines = wrapLines(text, inputWidth - 5)
    const inputHeight = Math.max(4, Math.min(9, rows - 7, inputLines.length + 3))
    const inputY = home ? Math.min(rows - inputHeight - 3, Math.max(7, Math.floor(rows * 0.55))) : rows - inputHeight - 2
    regions.composer = { x: inputX, y: inputY, width: inputWidth, height: inputHeight }
    regions.content = { x: X + 2, y: 3, width: mainWidth - 4, height: Math.max(1, inputY - 4) }
    let contentStart = 0, maxStart = 0
    if (home) {
      const logo = "VibeCoder"
      const y = Math.max(3, inputY - 5)
      if (rows >= 24 && mainWidth >= WORDMARK_WIDTH + 6) {
        const wordmarkX = X + Math.floor((mainWidth - WORDMARK_WIDTH) / 2)
        const coderX = wordmarkX + WORDMARK.vibe[0].length + 2
        for (let i = 0; i < WORDMARK.vibe.length; i++) {
          canvas.put(wordmarkX, y - 6 + i, WORDMARK.vibe[i], { fg: "accent", bold: true })
          canvas.put(coderX, y - 6 + i, WORDMARK.coder[i], { fg: "text", bold: true })
        }
      } else canvas.put(X + Math.floor((mainWidth - logo.length) / 2), y, logo, { fg: "text", bold: true })
      const sub = "What should we build or fix today?"
      canvas.put(X + Math.floor((mainWidth - sub.length) / 2), y + 1, sub, { fg: "muted" })
      const tip = "/ for commands   @ to attach files   Ctrl+P menu"
      if (mainWidth > tip.length + 4) canvas.put(X + Math.floor((mainWidth - tip.length) / 2), y + 3, tip, { fg: "border" })
    } else {
      const content = this.transcript(regions.content.width)
      const maxOffset = Math.max(0, content.length - regions.content.height)
      this.scrollOffset = Math.min(this.scrollOffset, maxOffset)
      const start = this.anchor === null ? Math.max(0, content.length - regions.content.height - this.scrollOffset) : Math.min(this.anchor, maxOffset)
      this.scrollOffset = Math.max(0, content.length - regions.content.height - start)
      contentStart = start; maxStart = maxOffset
      for (let i = 0; i < regions.content.height && start + i < content.length; i++) this.putRuns(canvas, X + 2, 3 + i, content[start + i], regions.content.width)
    }
    canvas.fill(inputX, inputY, inputWidth, inputHeight, { bg: "surface" })
    canvas.put(inputX + 1, inputY + 1, ">", { fg: "accent", bg: "surface", bold: true })
    const visibleCount = inputHeight - 3
    const before = wrapLines(text.slice(0, active?.cursor || 0), inputWidth - 5)
    const start = Math.max(0, before.length - visibleCount)
    if (text) {
      for (let i = 0; i < visibleCount; i++) canvas.put(inputX + 3, inputY + 1 + i, inputLines[start + i] || "", { bg: "surface" })
    } else canvas.put(inputX + 3, inputY + 1, short(this.busy ? "VibeCoder is working… (Ctrl+C stops)" : "Ask VibeCoder to work in this project...", inputWidth - 5), { fg: "muted", bg: "surface" })
    const identity = `${this.context.agent || "Pilot"} · ${this.context.provider || "Select provider"}${this.context.model ? " · " + this.context.model : ""}`
    const mode = inputWidth < 58 ? this.context.yes ? "Full" : "Ask" : this.context.yes ? "Full Access" : "Ask before changes"
    const percent = this.context.percent == null ? "" : inputWidth < 58 ? `  ${this.context.percent}%` : `  ${this.context.percent}% context`
    canvas.put(inputX + 3, inputY + inputHeight - 1, short(identity, inputWidth - mode.length - percent.length - 7), { fg: "accent", bg: "surface" })
    const accessX = inputX + Math.max(3, inputWidth - mode.length - percent.length - 2)
    canvas.put(accessX, inputY + inputHeight - 1, mode + percent, { fg: this.context.yes ? "warning" : "muted", bg: "surface" })
    regions.access = { x: accessX, y: inputY + inputHeight - 1, width: mode.length, height: 1 }
    if (active?.kind === "text" && active.multiline) cursor = { x: Math.min(cols - 1, inputX + 3 + cellWidth(before.at(-1))), y: inputY + 1 + Math.min(visibleCount - 1, before.length - start - 1) }
    if (sideWidth) {
      regions.panel = { x: X + mainWidth + 1, y: 3, width: sideWidth - 3, height: rows - 6 }
      for (let y = 2; y < rows - 2; y++) canvas.put(X + mainWidth, y, "│", { fg: "subtle" })
      this.drawPanel(canvas, regions.panel)
    }
    const footer = this.scrollOffset ? `History / ${this.scrollOffset} rows above latest   Ctrl+End latest` : "Enter send   Ctrl+J newline   Ctrl+V paste   F4 access   Mouse/PgUp history"
    canvas.put(2, rows - 1, short(footer, cols - 4), { fg: "muted" })
    if (this.busy && !home) {
      // Live status: pulsing dot, elapsed time, how to stop.
      const elapsed = this.busySince ? seconds(Date.now() - this.busySince) : ""
      canvas.put(X + 2, inputY - 1, "●", { fg: this.pulse ? "accent" : "muted", bold: true })
      canvas.put(X + 4, inputY - 1, short(`Working${elapsed ? " · " + elapsed : ""}   Ctrl+C stops`, mainWidth - 6), { fg: "accent" })
    } else if (this.notice && !home) {
      const done = this.notice === "Ready" && this.lastRunMs ? `Done in ${seconds(this.lastRunMs)}` : this.notice
      canvas.put(X + 2, inputY - 1, short(done, mainWidth - 4), { fg: /fail|error/i.test(this.notice) ? "error" : "muted" })
    } else if (this.notice && home) {
      canvas.put(inputX, inputY + inputHeight, short(this.notice, inputWidth), { fg: /fail|error|first/i.test(this.notice) ? "warning" : "muted" })
    }
    const hints = this.suggestions()
    if (hints.length) {
      // Dropdown just above the composer: as many rows as fit (max 16), scrolls with the highlight.
      const index = Math.max(0, Math.min(hints.length - 1, this.suggestIndex || 0))
      const count = Math.min(16, hints.length, Math.max(1, inputY - 3))
      const first = Math.max(0, Math.min(index - count + 1, hints.length - count))
      const boxY = inputY - count - 1
      const nameWidth = Math.min(16, Math.max(...hints.map((h) => h.name.length)) + 2)
      canvas.fill(inputX, boxY, inputWidth, count + 1, { bg: "subtle" })
      for (let i = 0; i < count; i++) {
        const h = hints[first + i], selected = first + i === index
        const bg = selected ? "selection" : "subtle"
        canvas.fill(inputX, boxY + i, inputWidth, 1, { bg })
        canvas.put(inputX + 2, boxY + i, short("/" + h.name, nameWidth), { fg: selected ? "onSelection" : "accent", bg, bold: selected })
        canvas.put(inputX + 3 + nameWidth, boxY + i, short(h.info, inputWidth - nameWidth - 5), { fg: selected ? "onSelection" : "muted", bg })
      }
      canvas.put(inputX + 2, boxY + count, short(`↑↓ choose   Tab complete   Enter run${hints.length > count ? `   ${hints.length} commands` : ""}`, inputWidth - 4), { fg: "border", bg: "subtle" })
      regions.suggestions = { x: inputX, y: boxY, width: inputWidth, height: count + 1 }
    }
    if (active && (active.kind === "pick" || !active.multiline) || this.inspector) cursor = this.drawModal(canvas, regions)
    return { canvas, cursor, regions, small: false, home, contentStart, maxStart }
  }
  /** The sessions sidebar: + New session, then every session (current one highlighted). */
  drawSessions(canvas, regions, left, rows) {
    const list = this.context.sessions || []
    for (let y = 2; y < rows - 1; y++) canvas.put(left - 1, y, "│", { fg: "subtle" })
    let y = 3
    canvas.put(2, y, "+ New session", { fg: "accent", bold: true })
    regions.newSession = { x: 0, y, width: left - 1, height: 1 }
    y += 2
    canvas.put(2, y++, short(`Sessions${list.length ? ` (${list.length})` : ""}`, left - 4), { fg: "muted", bold: true })
    regions.sessionRows = []
    if (!list.length) canvas.put(2, y, "No sessions yet", { fg: "border" })
    const room = Math.max(0, rows - 3 - y)
    const currentAt = Math.max(0, list.findIndex((s) => s.id === this.context.sessionId))
    const first = Math.max(0, Math.min(currentAt - Math.floor(room / 2), list.length - room))
    for (let i = first; i < list.length && y < rows - 2; i++) {
      const s = list[i]
      const current = s.id === this.context.sessionId
      const bg = current ? "selection" : "background"
      canvas.fill(1, y, left - 3, 1, { bg })
      const ago = s.ago ? String(s.ago).replace(/\s*ago$/, "") : ""
      const titleWidth = left - 6 - (ago ? cellWidth(ago) + 1 : 0)
      canvas.put(2, y, short(s.title || "Untitled", titleWidth), { fg: current ? "onSelection" : "text", bg, bold: current })
      if (ago) canvas.put(left - 3 - cellWidth(ago), y, ago, { fg: current ? "onSelection" : "border", bg })
      regions.sessionRows.push({ x: 0, y, width: left - 1, id: s.id })
      y++
    }
    const tip = "Right-click: rename, delete"
    if (list.length && rows - 3 > y && left - 4 >= tip.length) canvas.put(2, rows - 3, tip, { fg: "border" })
  }
  drawPanel(canvas, box) {
    let y = box.y
    const line = (text, fg = "muted", bold = false) => { if (y < box.y + box.height) canvas.put(box.x + 1, y++, short(text, box.width - 1), { fg, bold }) }
    line("Context", "text", true)
    const percent = Math.max(0, Math.min(100, this.context.percent || 0))
    const filled = Math.round(percent / 100 * 20)
    if (y < box.y + box.height) {
      canvas.put(box.x + 1, y, "█".repeat(filled), { fg: percent > 85 ? "warning" : "accent" })
      canvas.put(box.x + 1 + filled, y++, "░".repeat(20 - filled), { fg: "border" })
    }
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
