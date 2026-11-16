import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { spawn } from "node:child_process"
import { PassThrough, Writable } from "node:stream"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { TerminalInput, cellWidth, wrapLines } = require("../cli/input")
const { createRenderer, askQuestionForm } = require("../cli/ui")
const theme = require("../cli/theme")
const settings = require("../cli/settings")
const { parseArgs } = require("../cli/vibe")
const { modelChoices } = require("../cli/actions")
const { expandFileMentions } = require("../cli/attachments")
const base = path.join(os.tmpdir(), "opencode")
fs.mkdirSync(base, { recursive: true })
const temp = fs.mkdtempSync(path.join(base, "vibe-cli-runtime-"))
const dir = path.join(temp, "project"), home = path.join(temp, "home")
fs.mkdirSync(dir); fs.mkdirSync(home)
const tests = [], test = (name, fn) => tests.push({ name, fn })

function fakeTerminal() {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; input.isRaw = false
  const modes = []
  input.setRawMode = (value) => { input.isRaw = value; modes.push(value) }
  output.isTTY = true; output.columns = 72; output.rows = 24
  let text = ""
  output.on("data", (data) => { text += data })
  const ui = new TerminalInput({ input, output })
  return { ui, input, output, modes, text: () => text }
}

test("multiline/bracketed paste survives split markers and Unicode without submitting", async () => {
  const t = fakeTerminal()
  try {
    const answer = t.ui.read("Pilot / Fixture", { multiline: true })
    t.input.write("\x1b")
    t.input.write("[200~first\r\nবাংলা\nthird\x1b[201")
    t.input.write("~")
    assert.equal(t.ui.active.text, "first\nবাংলা\nthird")
    assert.ok(t.ui.active, "pasted newlines do not submit")
    t.input.write("\r")
    assert.equal(await answer, "first\nবাংলা\nthird")
  } finally { t.ui.close() }
  assert.deepEqual(t.modes, [true, false])
})
test("ordinary multiline paste is one draft; Ctrl+J and grapheme editing work", async () => {
  const t = fakeTerminal()
  try {
    const answer = t.ui.read("Compose", { multiline: true })
    t.input.write("one\ntwo")
    assert.equal(t.ui.active.text, "one\ntwo")
    t.ui.key("", { ctrl: true, name: "j" })
    t.ui.insert("🙂")
    t.ui.key("", { name: "backspace" })
    assert.equal(t.ui.active.text, "one\ntwo\n")
    t.ui.key("", { name: "return" })
    assert.equal(await answer, "one\ntwo\n")
  } finally { t.ui.close() }
})
test("background questions suspend and restore the exact composer draft", async () => {
  const t = fakeTerminal()
  try {
    const draft = t.ui.read("Compose", { multiline: true, initial: "keep my draft" })
    const question = new Promise((resolve) => t.ui.question("Pick: ", resolve))
    t.input.write("2"); t.input.write("\r")
    assert.equal(await question, "2")
    assert.equal(t.ui.active.text, "keep my draft")
    t.input.write("\r")
    assert.equal(await draft, "keep my draft")
  } finally { t.ui.close() }
})
test("picker filters/arrow keys select; Escape and EOF resolve instead of hanging", async () => {
  const t = fakeTerminal()
  try {
    const pick = t.ui.pick([{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }], "Pick")
    t.ui.key("B", { name: "b" })
    t.ui.key("", { name: "return" })
    assert.equal((await pick).id, "b")
    const cancelled = t.ui.read("Question")
    t.ui.key("", { name: "escape" })
    assert.equal(await cancelled, null)
    const closed = t.ui.read("Question")
    t.input.end()
    assert.equal(await closed, null)
    assert.equal(t.ui.closed, true)
  } finally { t.ui.close() }
})
test("secret prompts never echo their value or enter prompt history", async () => {
  const t = fakeTerminal()
  try {
    const answer = t.ui.read("API key: ", { secret: true })
    t.input.write("secret-value")
    assert.equal(t.text().includes("secret-value"), false)
    t.input.write("\r")
    assert.equal(await answer, "secret-value")
    assert.equal(t.text().includes("secret-value"), false)
  } finally { t.ui.close() }
  settings.rememberPrompt("/auth add fixture secret-value", home)
  settings.rememberPrompt("remember api_key=not-public-value", home)
  assert.deepEqual(settings.loadHistory(home), ["remember api_key=[redacted]"])
})
test("terminal width, theme fallbacks and NO_COLOR do not leak untrusted escape codes", () => {
  assert.equal(cellWidth("你好"), 4)
  assert.equal(cellWidth("🙂"), 2)
  assert.ok(wrapLines("abc你好🙂xyz", 6).every((s) => cellWidth(s) <= 6))
  assert.equal(theme.safeText("safe\x1b[2J\x1b]52;c;unsafe\x07text"), "safetext")
  const originalColor = process.env.NO_COLOR
  const originalTerm = process.env.TERM
  try {
    delete process.env.NO_COLOR
    process.env.TERM = "xterm"
    theme.configureTheme("obsidian", { output: { isTTY: true, getColorDepth: () => 24 }, color: true })
    assert.match(theme.c.accent("text"), /\x1b\[38;2;/)
    theme.configureTheme("light")
    assert.match(theme.c.text("text"), /48;2;/, "Light text is readable even in a dark terminal")
    process.env.NO_COLOR = "1"
    assert.equal(theme.c.accent("text"), "text")
    delete process.env.NO_COLOR
    process.env.TERM = "dumb"
    assert.equal(theme.c.accent("text"), "text")
  } finally {
    if (originalColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = originalColor
    if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm
    theme.configureTheme("obsidian", { output: process.stdout, color: true })
  }
})
test("CLI settings are separate from desktop settings and preserve unknown fields", () => {
  fs.writeFileSync(settings.settingsFile(home), JSON.stringify({ futureSetting: "keep" }))
  settings.saveSettings({ theme: "amoled", reasoning: true }, home)
  assert.equal(settings.loadSettings(home).theme, "amoled")
  assert.equal(JSON.parse(fs.readFileSync(settings.settingsFile(home))).futureSetting, "keep")
  assert.equal(fs.existsSync(path.join(home, "electron-ui-state.json")), false)
  assert.throws(() => settings.saveSettings({ theme: "unknown" }, home), /Unknown/)
})
test("provider picker has one display name and preserves slash-containing model IDs", () => {
  const rows = modelChoices([{ id: "cloudfire", name: "cloudfire", hasKey: true, models: [{ id: "@cf/team/model" }] }, { id: "cloudfire/@cf/team/model", derivedFrom: "cloudfire", model: "@cf/team/model" }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].description, "cloudfire")
  assert.equal(rows[0].label, "@cf/team/model")
  assert.equal(rows[0].id, "cloudfire/@cf/team/model")
})
test("argument parsing preserves old aliases and -- command tails; incomplete flags fail clearly", () => {
  const args = parseArgs(["run", "task", "-m", "p", "-C", dir, "-s", "ses_a", "-c", "-y", "-a", "explore", "--json", "--", "--model", "literal"])
  assert.equal(args.flags.model, "p")
  assert.equal(args.flags.agent, "explore")
  assert.equal(args.flags.continue, true)
  assert.deepEqual(args.rest, ["run", "task", "--model", "literal"])
  assert.equal(parseArgs(["--theme=light"]).flags.theme, "light")
  assert.throws(() => parseArgs(["--model"]), /needs a value/)
  assert.throws(() => parseArgs(["--port", "wrong"]), /integer/)
})
test("renderer deduplicates transport/usage updates and only terminal errors fail a run", async () => {
  let text = ""
  const out = new Writable({ write(chunk, _, cb) { text += chunk; cb() } })
  const r = createRenderer({ out, json: true })
  await r.handle({ type: "run.start", eventID: "a" })
  await r.handle({ type: "text.delta", delta: "once", eventID: "b" })
  await r.handle({ type: "text.delta", delta: "once", eventID: "b" })
  await r.handle({ type: "usage", input: 10, output: 2, step: 1 })
  await r.handle({ type: "usage", input: 10, output: 4, step: 1 })
  await r.handle({ type: "tool.end", isError: true, output: "retryable tool failure" })
  assert.equal(r.state.failed, false)
  assert.equal(r.state.totals.input, 10)
  assert.equal(r.state.totals.output, 4)
  assert.equal(text.split("\n").filter((l) => l.includes('"eventID":"b"')).length, 1)
  await r.handle({ type: "error", message: "real failure" })
  assert.equal(r.state.failed, true)
  await r.handle({ type: "done", reason: "interrupted" })
  assert.equal(r.state.interrupted, true)
})
test("--yes never dismisses interactive questions; custom answers keep commas", async () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  try {
    const replies = ["2", "1,3", "custom, with commas"]
    const rl = { question(_, cb) { cb(replies.shift()) } }
    const form = { title: "Questions", questions: [
      { header: "Single", options: [{ label: "one" }, { label: "two" }] },
      { header: "Multiple", multiple: true, options: [{ label: "one" }, { label: "two" }, { label: "three" }] },
      { header: "Custom", options: [] },
    ] }
    assert.deepEqual(await askQuestionForm(rl, form, { yes: true }, () => {}), { q0: ["two"], q1: ["one", "three"], q2: ["custom, with commas"] })
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original); else delete process.stdin.isTTY
  }
})
test("file attachments are bounded, deduplicated and use raw image bytes", () => {
  fs.writeFileSync(path.join(dir, "notes & more.txt"), "unicode বাংলা")
  fs.writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2]))
  const expanded = expandFileMentions('inspect @"notes & more.txt" @"notes & more.txt" @binary.bin', dir)
  assert.equal(expanded.inlined.length, 1)
  assert.match(expanded.text, /path="notes &amp; more\.txt"/)
  assert.deepEqual(expanded.missing, ["binary.bin (binary file)"])
})

function answer(text, toolCalls = []) {
  return { choices: [{ message: { role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20 } }
}
const tool = (name, args) => ({ id: "call_" + name, type: "function", function: { name, arguments: JSON.stringify(args) } })
async function withModel(responder, fn) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let text = ""
    for await (const part of req) text += part
    const body = JSON.parse(text)
    requests.push(body)
    const response = await responder(body, requests.length)
    res.writeHead(response.status || 200, { "content-type": "application/json" })
    res.end(JSON.stringify(response.body || response))
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const profile = { id: "fixture", name: "Fixture", format: "openai-chat", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "fixture-model", noAuth: true, image: true, contextLimit: 128000, maxOutput: 2048 }
  fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify([profile]))
  try { await fn(requests, profile) }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}
function run(args) {
  const env = { ...process.env, VIBE_HOME: home, NO_COLOR: "1", TERM: "dumb" }
  delete env.VIBE_MODEL
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "cli", "vibe.js"), ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (part) => stdout += part)
    child.stderr.on("data", (part) => stderr += part)
    const timeout = setTimeout(() => { child.kill(); reject(new Error("CLI hung: " + args.join(" ") + "\n" + stdout + "\n" + stderr)) }, 30000)
    child.on("error", (error) => { clearTimeout(timeout); reject(error) })
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }) })
  })
}
const events = (result) => result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))

test("real CLI completes question forms in JSON mode without a key or deadlock", async () => {
  await withModel((_, n) => n === 1 ? answer("", [tool("question", { questions: [{ header: "Choice", question: "Pick", options: [{ label: "one", description: "" }] }] })]) : answer("Question cancellation handled."), async (requests) => {
    const result = await run(["run", "Ask me a question", "-m", "fixture", "--json", "--yes"])
    assert.equal(result.code, 0, result.stderr)
    const list = events(result)
    assert.ok(list.some((e) => e.type === "question.ask"))
    assert.ok(list.some((e) => e.type === "question.cancelled"))
    assert.ok(requests.length >= 2)
    assert.ok(list.some((e) => e.type === "text.delta" && e.delta.includes("handled")))
  })
})
test("real CLI exposes/consumes durable background output and resumes the original intent", async () => {
  fs.writeFileSync(path.join(dir, "worker.cjs"), "setTimeout(()=>console.log('background verified বাংলা'),150)")
  await withModel((body, n) => {
    if (n === 1) return answer("", [tool("bash", { command: "node worker.cjs", background: true, description: "verify the original task" })])
    return answer(JSON.stringify(body.messages).includes("Background shell result") ? "Background result checked." : "Waiting for the background command.")
  }, async (requests) => {
    const result = await run(["run", "Verify the background command and use its result", "-m", "fixture", "--json", "--yes"])
    assert.equal(result.code, 0, result.stderr)
    const list = events(result)
    assert.equal(list.filter((e) => e.type === "shell.completed").length, 1, "subscriptions/streams must not duplicate completion")
    assert.ok(list.some((e) => e.type === "shell.output" && e.delta.includes("background verified")))
    assert.ok(list.some((e) => e.type === "text.delta" && e.delta.includes("result checked")))
    assert.ok(requests.some((r) => JSON.stringify(r.messages).includes("Verify the background command and use its result")))
    assert.ok(requests.some((r) => JSON.stringify(r.messages).includes("Background shell result")))
  })
})
test("real CLI renders background Crew and attaches their persisted result before finishing", async () => {
  let parentCalls = 0
  await withModel(async (body) => {
    const child = body.messages.some((m) => m.role === "user" && m.content === "child task")
    if (child) { await new Promise((r) => setTimeout(r, 100)); return answer("Child verified result.") }
    parentCalls++
    if (parentCalls === 1) return answer("", [tool("subagent", { agent: "explore", task: "child task", background: true })])
    return answer(JSON.stringify(body.messages).includes("Subagent completed") ? "Crew result incorporated." : "Crew is working.")
  }, async () => {
    const result = await run(["run", "Do a focused Crew check", "-m", "fixture", "--json", "--yes"])
    assert.equal(result.code, 0, result.stderr)
    const list = events(result)
    assert.ok(list.some((e) => e.type === "subagent.start"))
    assert.ok(list.some((e) => e.type === "subagent.result"))
    assert.ok(list.some((e) => e.subagentId && e.type === "text.delta"))
    assert.ok(list.some((e) => e.type === "text.delta" && e.delta.includes("incorporated")))
  })
})
test("real image and quoted text attachments reach the provider with the correct wire shape", async () => {
  fs.writeFileSync(path.join(dir, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6u3kAAAAASUVORK5CYII=", "base64"))
  await withModel(() => answer("Files inspected."), async (requests) => {
    const result = await run(["run", 'Inspect @pic.png and @"notes & more.txt"', "-m", "fixture", "--json"])
    assert.equal(result.code, 0, result.stderr)
    const content = requests[0].messages.filter((m) => m.role === "user").at(-1).content
    assert.ok(content.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/png;base64,iVBOR")))
    assert.equal(JSON.stringify(content).includes("base64,data:image"), false)
    assert.ok(JSON.stringify(content).includes("unicode বাংলা"))
  })
})
test("real provider failure returns valid NDJSON and nonzero status", async () => {
  await withModel(() => ({ status: 400, body: { error: { message: "fixture rejected", type: "invalid_request_error" } } }), async () => {
    const result = await run(["run", "Fail clearly", "-m", "fixture", "--json"])
    assert.equal(result.code, 1)
    assert.ok(events(result).some((e) => e.type === "error"))
    assert.equal(result.stdout.includes("\x1b["), false)
  })
})
test("CLI can start/resume an existing session without selecting another profile first", async () => {
  await withModel(() => answer("Session continued."), async () => {
    const { createVibe } = require("../sdk")
    const v = createVibe({ home })
    const s = await v.session.create({ dir, profile: "fixture" })
    const result = await run(["run", "Continue this session", "--session", s.id, "--json"])
    assert.equal(result.code, 0, result.stderr)
    assert.ok(events(result).every((e) => !e.sessionId || e.sessionId === s.id))
    v.engine.extensions.close()
  })
})
test("interactive chat keeps model/agent/session/recipe/theme controls working without provider duplicates", async () => {
  await withModel(() => answer("Interactive task verified."), async (requests, profile) => {
    fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify([{ ...profile, models: [{ id: profile.model }, { id: "second/model", context: 64000 }] }]))
    const { createVibe } = require("../sdk")
    const { runChat } = require("../cli/chat")
    const v = createVibe({ home })
    const s = await v.session.create({ dir, profile: "fixture" })
    await v.control.call("recipes.install", { directory: dir, id: "inspect", content: "---\ndescription: Inspect arguments\n---\nInspect $1 with $ARGUMENTS." })
    const t = fakeTerminal()
    const commands = ["/model fixture/second/model", "/agent plan", "/new Chat review", "/config set compaction.keep.tokens 6789", '/recipe inspect "path with spaces"', "/steps", "/redo", "/theme dark", "/models", "/history", "/exit"]
    const originalRead = t.ui.read.bind(t.ui)
    t.ui.read = (label, options = {}) => {
      const result = originalRead(label, options)
      if (options.multiline) {
        const command = commands.shift()
        queueMicrotask(() => {
          if (command === undefined) t.ui.close()
          else { t.ui.insert(command); t.ui.key("", { name: "return" }) }
        })
      }
      return result
    }
    try {
      await runChat({ vibe: v, dir, session: s, input: t.ui, home, stored: { ...settings.loadSettings(home), history: false }, flags: {} })
      assert.equal(commands.length, 0, "errors in a slash command must not close/hang chat")
      const created = (await v.session.list({ dir })).find((r) => r.title === "Chat review")
      const selected = await v.session.get(created.id)
      assert.equal(selected.profile, "fixture/second/model")
      assert.equal(selected.agent, "plan")
      assert.ok(requests.some((r) => r.model === "second/model"))
      assert.ok(requests.some((r) => JSON.stringify(r.messages).includes('Inspect path with spaces with \\"path with spaces\\"')))
      assert.equal((await v.profiles.list()).filter((p) => p.id.startsWith("fixture")).length, 1)
      assert.equal(v.engine.getCompactionConfig().keep.tokens, 6789)
      assert.equal(settings.loadSettings(home).theme, "dark")
      assert.equal(t.ui.closed, true)
    } finally { t.ui.close(); v.engine.extensions.close() }
  })
})
test("forms/permissions resolved in another client cancel only their prompt and preserve the draft", async () => {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  const t = fakeTerminal()
  let replyCount = 0
  const vibe = { permission: { reply: async () => { replyCount++ } }, forms: { reply: async () => { replyCount++ }, cancel: async () => { replyCount++ } } }
  const renderer = createRenderer({ rl: t.ui, vibe, out: { write: (s) => t.ui.write(s) } })
  const draft = t.ui.read("Compose", { multiline: true, initial: "keep this draft" })
  try {
    const form = { id: "external-form", title: "Choice", questions: [{ header: "Choice", options: [{ label: "One" }] }] }
    const asked = renderer.enqueue({ type: "question.ask", form })
    await new Promise((r) => setImmediate(r))
    assert.equal(t.ui.active.interaction, true)
    const replied = renderer.enqueue({ type: "question.replied", form })
    await Promise.all([asked, replied])
    assert.equal(t.ui.active.text, "keep this draft")
    const permission = renderer.enqueue({ type: "permission.ask", permissionId: "external-perm", tool: "write", subject: "file.js" })
    await new Promise((r) => setImmediate(r))
    const resolved = renderer.enqueue({ type: "permission.replied", permissionId: "external-perm", decision: "once", tool: "write" })
    await Promise.all([permission, resolved])
    assert.equal(t.ui.active.text, "keep this draft")
    assert.equal(replyCount, 0, "the CLI must not override an answer supplied in the desktop/another SDK client")
  } finally {
    t.ui.close(); await draft
    if (original) Object.defineProperty(process.stdin, "isTTY", original); else delete process.stdin.isTTY
  }
})
test("one-shot Crew control renders the child and exits without orphaning a live local run", async () => {
  await withModel(() => answer("Direct Crew result."), async () => {
    const { createVibe } = require("../sdk")
    const v = createVibe({ home })
    const s = await v.session.create({ dir, profile: "fixture" })
    const result = await run(["crew", "start", "explore", "direct task", "--session", s.id, "--json", "--yes"])
    assert.equal(result.code, 0, result.stderr)
    const list = events(result)
    const final = list.find((e) => e.type === "crew.completed")
    assert.equal(final.crew.status, "done")
    assert.match(final.crew.result, /Direct Crew result/)
    v.engine.extensions.close()
  })
})
test("explicit CLI thinking and step limits reach the provider without changing its saved profile", async () => {
  await withModel(() => answer("Effort checked."), async (requests) => {
    const result = await run(["run", "Check effort", "-m", "fixture", "--thinking", "high", "--steps", "2", "--json"])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(requests[0].reasoning_effort, "high")
    assert.equal(events(result).find((e) => e.type === "step.start").maxSteps, 2)
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "profiles.json")))[0].quirks, undefined)
  })
})
test("explicit CLI thinking maps to a bounded Anthropic budget and leaves desktop/default options unchanged", async () => {
  await withModel(() => ({ content: [{ type: "text", text: "Thinking configured." }], stop_reason: "end_turn", usage: { input_tokens: 40, output_tokens: 20 } }), async (requests, profile) => {
    fs.writeFileSync(path.join(home, "profiles.json"), JSON.stringify([{ ...profile, format: "anthropic", maxOutput: 4096 }]))
    const result = await run(["run", "Check thinking budget", "-m", "fixture", "--thinking", "high", "--json"])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(requests[0].thinking, { type: "enabled", budget_tokens: 3072 })
    assert.equal(requests[0].max_tokens, 4096)
    const saved = JSON.parse(fs.readFileSync(path.join(home, "profiles.json")))[0]
    assert.equal(saved.quirks, undefined)
  })
})

let failed = 0
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log("PASS CLI runtime: " + name) }
    catch (error) { failed++; console.error("FAIL CLI runtime: " + name + "\n" + error.stack) }
  }
} finally { fs.rmSync(temp, { recursive: true, force: true }) }
console.log(`${tests.length - failed}/${tests.length} CLI runtime tests passed`)
if (failed) process.exitCode = 1
