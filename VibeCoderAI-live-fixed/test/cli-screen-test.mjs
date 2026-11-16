import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { PassThrough } from "node:stream"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { TerminalScreen, Canvas } = require("../cli/screen")
const { TerminalInput, cellWidth } = require("../cli/input")
const { configureTheme, THEMES } = require("../cli/theme")
const { createRenderer } = require("../cli/ui")
const { createVibe } = require("../sdk")
const { runChat } = require("../cli/chat")

const tests = [], test = (name, fn) => tests.push({ name, fn })
function terminal(columns = 120, rows = 42) {
  const output = new PassThrough(), input = new PassThrough()
  output.isTTY = true; output.columns = columns; output.rows = rows; output.getColorDepth = () => 24
  input.isTTY = true; input.isRaw = false
  input.setRawMode = (value) => { input.isRaw = value }
  let text = ""
  output.on("data", (chunk) => text += chunk.toString())
  configureTheme("obsidian", { output, color: true })
  const ui = new TerminalInput({ input, output, fullScreen: true })
  const screen = ui.enableScreen({ version: "0.3.10", context: { workspace: "Desktop", directory: "C:/Desktop", agent: "Pilot", provider: "cloudfire", percent: 0, limit: 128000, mode: "remote" } })
  screen.open()
  return { input, output, ui, screen, text: () => text }
}
const lines = (screen) => screen.frame().canvas.rows.map((_, i) => screen.frame().canvas.line(i))
test("full-screen entry paints its own background and restores the original buffer/cursor/raw state", () => {
  const t = terminal()
  t.ui.close()
  assert.ok(t.text().includes("\x1b[?1049h"))
  assert.match(t.text(), /48;2;16;17;20/)
  assert.ok(t.text().includes("\x1b[?1049l") && t.text().includes("\x1b[?25h"))
  assert.equal(t.input.isRaw, false)
  assert.equal(t.screen.closed, true)
  assert.equal(t.screen.pending, null)
  assert.equal(t.text().includes("\x1b]11;"), false, "the user's permanent terminal color settings are never changed")
})
test("fresh home is centered, provider identity occurs once in the composer and header is compact", async () => {
  const t = terminal()
  const answer = t.ui.read("Pilot / cloudfire", { multiline: true })
  try {
    const frame = t.screen.frame()
    assert.equal(frame.home, true)
    assert.equal(frame.regions.panel, undefined)
    assert.ok(frame.regions.composer.x > 2)
    const identity = frame.canvas.line(frame.regions.composer.y + frame.regions.composer.height - 1)
    assert.equal(identity.match(/cloudfire/g)?.length, 1)
    assert.ok(lines(t.screen).some((s) => s.includes("Work on your next change.")))
    assert.equal(t.text().includes("http://127"), false)
  } finally { t.ui.close(); await answer }
})
test("chat transcript separates roles, activities and code while the composer/panel stay fixed", async () => {
  const t = terminal()
  const answer = t.ui.read("Compose", { multiline: true })
  try {
    t.screen.userMessage("Inspect this project.")
    t.screen.event({ type: "run.start" })
    t.screen.event({ type: "tool.start", id: "read-1", name: "read", args: { path: "app.js" } })
    t.screen.event({ type: "tool.end", id: "read-1", output: "ok", isError: false })
    t.screen.event({ type: "text.delta", delta: "## Result\nReadable **answer** and `code`.\n```js\nconst a = 1\n```" }, {})
    t.screen.event({ type: "usage", input: 1000, output: 50 }, { totals: { input: 1000, output: 50 }, costKnown: false })
    const frame = t.screen.frame()
    const text = frame.canvas.rows.map((_, i) => frame.canvas.line(i)).join("\n")
    assert.ok(text.includes("You") && text.includes("VibeCoder") && text.includes("[+] read"))
    assert.ok(text.includes("Result") && text.includes("const a = 1"))
    assert.equal(frame.regions.composer.y, frame.canvas.height - frame.regions.composer.height - 2)
    assert.ok(frame.regions.panel.x >= frame.regions.content.x + frame.regions.content.width)
    assert.ok(text.includes("Cost not reported"))
  } finally { t.ui.close(); await answer }
})
test("narrow/tiny terminals keep all drawn text and cursor inside real cell bounds", async () => {
  for (const [width, height] of [[80, 24], [50, 18], [36, 13], [24, 8]]) {
    const t = terminal(width, height)
    const answer = t.ui.read("Compose", { multiline: true, initial: "hello 你好🙂\nsecond line" })
    try {
      t.screen.userMessage("A response ".repeat(30))
      const frame = t.screen.frame()
      for (const row of frame.canvas.rows.map((_, i) => frame.canvas.line(i))) assert.ok(cellWidth(row) <= frame.canvas.width)
      assert.ok(frame.cursor.x >= 0 && frame.cursor.x < frame.canvas.width)
      assert.ok(frame.cursor.y >= 0 && frame.cursor.y < frame.canvas.height)
      assert.equal(frame.regions.panel, undefined)
    } finally { t.ui.close(); await answer }
  }
})
test("canvas correctly clears a wide glyph when an overlay replaces either cell", () => {
  const canvas = new Canvas(8, 2)
  canvas.put(0, 0, "你好")
  canvas.put(1, 0, "a")
  assert.equal(cellWidth(canvas.line(0)), 8)
  assert.ok(canvas.line(0).includes("a"))
})
test("picker is a centered overlay, shows one provider description and filters without touching the draft", async () => {
  const t = terminal()
  const selected = t.ui.pick([{ id: "a", label: "model-a", description: "cloudfire" }, { id: "b", label: "model-b", description: "other" }], "Choose a model")
  try {
    t.ui.key("model-a", {})
    const frame = t.screen.frame()
    assert.ok(frame.regions.modal.x > 2)
    const body = frame.canvas.rows.map((_, i) => frame.canvas.line(i)).join("\n")
    assert.ok(body.includes("Choose a model") && body.includes("cloudfire"))
    assert.equal(body.includes("cloudfire / cloudfire"), false)
    t.ui.key("", { name: "return" })
    assert.equal((await selected).id, "a")
  } finally { t.ui.close() }
})
test("history scroll is anchored while new content arrives and Ctrl+End follows again", () => {
  const t = terminal()
  try {
    t.screen.userMessage("Begin")
    t.screen.event({ type: "run.start" })
    t.screen.event({ type: "text.delta", delta: Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n") }, {})
    t.screen.render()
    t.screen.handleKey({ name: "pageup" }); t.screen.render()
    const anchor = t.screen.lastFrame.contentStart
    t.screen.event({ type: "text.delta", delta: "\nnew message\nanother message" }, {})
    t.screen.render()
    assert.equal(t.screen.lastFrame.contentStart, anchor)
    t.screen.handleKey({ ctrl: true, name: "end" }); t.screen.render()
    assert.equal(t.screen.scrollOffset, 0)
  } finally { t.ui.close() }
})
test("mouse wheel scrolls chat without typing report bytes and restores following at the end", async () => {
  const t = terminal()
  const draft = t.ui.read("Compose", { multiline: true, initial: "keep draft" })
  try {
    t.screen.userMessage("Begin")
    t.screen.event({ type: "run.start" })
    t.screen.event({ type: "text.delta", delta: Array.from({ length: 70 }, (_, i) => `line ${i}`).join("\n") }, {})
    t.screen.render()
    const start = t.screen.lastFrame.contentStart
    t.input.write("\x1b[<64;10;")
    t.input.write("6M")
    t.screen.render()
    assert.equal(t.screen.lastFrame.contentStart, start - 3)
    assert.equal(t.ui.active.text, "keep draft")
    t.input.write("\x1b[<65;10;6M")
    t.screen.render()
    assert.equal(t.screen.scrollOffset, 0)
    assert.ok(t.text().includes("\x1b[?1006h"))
  } finally { t.ui.close(); await draft }
  assert.ok(t.text().includes("\x1b[?1000l") && t.text().includes("\x1b[?1006l"))
})
test("mouse access selection and F4 preserve the draft; model rows are mouse-selectable", async () => {
  const t = terminal()
  let draft = t.ui.read("Compose", { multiline: true, palette: true, initial: "unsent task" })
  try {
    t.screen.render()
    const access = t.screen.lastFrame.regions.access
    t.input.write(`\x1b[<0;${access.x + 1};${access.y + 1}M`)
    assert.deepEqual(await draft, { action: "access", draft: "unsent task" })
    draft = t.ui.read("Compose", { multiline: true, palette: true, initial: "unsent task" })
    t.ui.key("", { name: "f4" })
    assert.deepEqual(await draft, { action: "access", draft: "unsent task" })
    const selected = t.ui.pick([{ id: "ask", label: "Ask before changes" }, { id: "full", label: "Full Access" }], "Permission mode")
    t.screen.render()
    const row = t.screen.lastFrame.regions.pickRows[1]
    t.input.write(`\x1b[<0;${row.x + 1};${row.y + 1}M`)
    assert.equal((await selected).id, "full")
  } finally { t.ui.close() }
})
test("permission/question resolution dismisses only the centered dialog and restores the exact composer draft", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  const t = terminal()
  const draft = t.ui.read("Compose", { multiline: true, initial: "keep this draft" })
  let replies = 0
  const renderer = createRenderer({ rl: t.ui, vibe: { permission: { reply: async () => replies++ } }, out: { write() {} }, onEvent: (e, s) => t.screen.event(e, s) })
  try {
    const waiting = renderer.enqueue({ type: "permission.ask", permissionId: "p", tool: "write", subject: "file.js" })
    await new Promise((r) => setImmediate(r))
    let frame = t.screen.frame()
    assert.ok(frame.regions.modal)
    assert.ok(frame.canvas.rows.some((_, i) => frame.canvas.line(i).includes("Approve action")))
    const resolved = renderer.enqueue({ type: "permission.replied", permissionId: "p", decision: "once", tool: "write" })
    await Promise.all([waiting, resolved])
    frame = t.screen.frame()
    assert.equal(frame.regions.modal, undefined)
    assert.equal(t.ui.active.text, "keep this draft")
    assert.equal(replies, 0)
  } finally {
    t.ui.close(); await draft
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor); else delete process.stdin.isTTY
  }
})
test("secret input and hostile ANSI never appear in the screen model or terminal output", async () => {
  const t = terminal()
  const secret = t.ui.read("API key", { secret: true })
  try {
    t.ui.insert("do-not-expose")
    t.screen.event({ type: "text.delta", delta: "Safe\x1b]52;c;unsafe\x07\x1b[2Jtext" }, {})
    const text = t.screen.frame().canvas.rows.map((_, i) => t.screen.frame().canvas.line(i)).join("\n")
    assert.equal(text.includes("do-not-expose"), false)
    assert.equal(t.text().includes("do-not-expose"), false)
    assert.equal(t.text().includes("\x1b]52;"), false)
    assert.ok(text.includes("*************"))
  } finally { t.ui.close(); await secret }
})
test("unchanged frames use differential redraw and resize invalidates the full viewport", () => {
  const t = terminal()
  try {
    t.screen.render()
    const before = t.text().length
    t.screen.render()
    assert.ok(t.text().length - before < 100)
    t.output.columns = 90; t.output.rows = 30
    t.screen.render()
    assert.equal(t.screen.lastFrame.canvas.width, 89)
    assert.equal(t.screen.lastFrame.canvas.height, 30)
  } finally { t.ui.close() }
})
test("theme body/muted/selection pairs meet WCAG contrast; focus borders remain visible", () => {
  const luminance = (hex) => {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
  }
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  for (const [name, palette] of Object.entries(THEMES)) {
    if (name === "system") continue
    for (const bg of ["background", "surface", "subtle"]) for (const fg of ["text", "muted"]) assert.ok(ratio(palette[fg], palette[bg]) >= 4.5, `${name} ${fg}/${bg}`)
    assert.ok(ratio(palette.onSelection, palette.selection) >= 4.5, name + " selection")
    assert.ok(ratio(palette.border, palette.background) >= 3, name + " input border")
  }
})
test("full-screen chat preserves real questions, model switching, command overlays and fresh-session state", async () => {
  const base = path.join(os.tmpdir(), "opencode")
  fs.mkdirSync(base, { recursive: true })
  const temp = fs.mkdtempSync(path.join(base, "vibe-screen-flow-"))
  const dir = path.join(temp, "project"), home = path.join(temp, "home")
  fs.mkdirSync(dir); fs.mkdirSync(home)
  const requests = []
  const server = http.createServer(async (req, res) => {
    let text = ""
    for await (const part of req) text += part
    requests.push(JSON.parse(text))
    const message = requests.length === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "question-1", type: "function", function: { name: "question", arguments: JSON.stringify({ questions: [{ header: "Direction", question: "Pick a direction", options: [{ label: "Build", description: "Make a change" }, { label: "Inspect", description: "Read the project" }] }] }) } }] }
      : { role: "assistant", content: "## Verified\nQuestion handled in the terminal." }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 15 } }))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify([{ id: "fixture", name: "Vibe Provider", format: "openai-chat", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "first", models: [{ id: "first" }, { id: "alternate" }], noAuth: true, contextLimit: 128000, maxOutput: 4096 }]))
  const vibe = createVibe({ home })
  const session = await vibe.session.create({ dir, profile: "fixture" })
  const t = terminal()
  const snapshots = [], commands = ["Hello workspace", "/model fixture/alternate", "/theme light", "/theme obsidian", "/help", "/new Fresh UI", "/exit"]
  const original = t.ui.read.bind(t.ui)
  t.ui.read = (label, options = {}) => {
    const value = original(label, options)
    t.screen.render()
    snapshots.push(t.screen.frame().canvas.rows.map((_, i) => t.screen.frame().canvas.line(i)).join("\n"))
    if (options.multiline || options.interaction) {
      const command = options.interaction ? "2" : commands.shift()
      queueMicrotask(() => {
        if (t.screen.inspector) t.ui.key("", { name: "escape" })
        if (command === undefined) t.ui.close()
        else { t.ui.insert(command); t.ui.key("", { name: "return" }) }
      })
    }
    return value
  }
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  try {
    await runChat({ vibe, session, dir, home, input: t.ui, stored: { theme: "obsidian", reasoning: false, history: false, verbose: false }, flags: {} })
    assert.equal(commands.length, 0)
    assert.equal(requests.length, 2)
    assert.ok(JSON.stringify(requests[1].messages).includes("Inspect"))
    assert.ok(snapshots.some((s) => s.includes("Pick a direction") && s.includes("Direction")))
    assert.ok(snapshots.some((s) => s.includes("Question handled in the terminal.") && s.includes("You")))
    assert.ok(snapshots.some((s) => s.includes("/help") && s.includes("Esc close")))
    assert.equal((await vibe.session.get(session.id)).profile, "fixture/alternate")
    assert.equal(t.screen.blocks.length, 0, "a fresh session must not inherit old transcript blocks")
    assert.equal(t.screen.closed, true)
    assert.equal(vibe.engine.runs.size, 0)
  } finally {
    t.ui.close(); vibe.engine.extensions.close()
    server.closeAllConnections(); await new Promise((r) => server.close(r))
    fs.rmSync(temp, { recursive: true, force: true })
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin); else delete process.stdin.isTTY
  }
})
test("saved Full Access skips repeated permission dialogs after restarting the CLI but still respects hard Locks", async () => {
  const base = path.join(os.tmpdir(), "opencode")
  fs.mkdirSync(base, { recursive: true })
  const temp = fs.mkdtempSync(path.join(base, "vibe-access-flow-"))
  const home = path.join(temp, "home"), dir = path.join(temp, "project")
  fs.mkdirSync(home); fs.mkdirSync(dir)
  let requests = 0
  const server = http.createServer(async (req, res) => {
    let text = ""
    for await (const part of req) text += part
    requests++
    const message = requests % 2
      ? { role: "assistant", content: null, tool_calls: [{ id: "write-" + requests, type: "function", function: { name: "write", arguments: JSON.stringify({ path: `file-${requests}.txt`, content: "approved test data" }) } }] }
      : { role: "assistant", content: "Change verified." }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ choices: [{ message, finish_reason: requests % 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } }))
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify([{ id: "fixture", name: "Vibe Provider", format: "openai-chat", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "test", noAuth: true, contextLimit: 128000 }]))
  const vibe = createVibe({ home })
  const { loadSettings } = require("../cli/settings")
  let interactions = 0
  try {
    for (let pass = 0; pass < 2; pass++) {
      const session = await vibe.session.create({ dir, profile: "fixture" })
      const t = terminal()
      const commands = pass === 0 ? ["/access full", "Make a change", "/exit"] : ["Make another change", "/exit"]
      const original = t.ui.read.bind(t.ui)
      t.ui.read = (label, options = {}) => {
        const value = original(label, options)
        if (options.interaction) interactions++
        if (options.multiline) queueMicrotask(() => {
          if (t.screen.inspector) t.ui.key("", { name: "escape" })
          const text = commands.shift()
          if (text === undefined) t.ui.close()
          else { t.ui.insert(text); t.ui.key("", { name: "return" }) }
        })
        return value
      }
      await runChat({ vibe, session, dir, home, input: t.ui, stored: { ...loadSettings(home), history: false }, flags: {} })
      assert.equal(commands.length, 0)
      assert.equal(loadSettings(home).access, "full")
      assert.equal(t.screen.context.yes, true)
    }
    assert.equal(interactions, 0)
    assert.equal(requests, 4)
    assert.ok(fs.existsSync(path.join(dir, "file-1.txt")) && fs.existsSync(path.join(dir, "file-3.txt")))
    const { isLocked } = require("../core/harness/locks")
    assert.equal(isLocked([{ tool: "bash", pattern: "*", action: "deny", lock: true }], "bash", "any command"), true)
    assert.equal(vibe.engine.permissionMode, "ask", "the CLI choice must not weaken the shared engine's policy")
  } finally {
    vibe.engine.extensions.close()
    server.closeAllConnections(); await new Promise((r) => server.close(r))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

let failed = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS CLI screen: " + name) }
  catch (error) { failed++; console.error("FAIL CLI screen: " + name + "\n" + error.stack) }
}
configureTheme("obsidian", { output: process.stdout, color: true })
console.log(`${tests.length - failed}/${tests.length} CLI screen tests passed`)
if (failed) process.exitCode = 1
