import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const { createVibe } = require(path.join(root, "sdk"))
const { runCommand } = require(path.join(root, "cli", "actions"))
const { TerminalInput } = require(path.join(root, "cli", "input"))
const { configureTheme } = require(path.join(root, "cli", "theme"))
const profiles = require(path.join(root, "core", "llm", "profiles"))
const { loadSettings } = require(path.join(root, "cli", "settings"))

const tests = [], test = (name, fn) => tests.push({ name, fn })
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
function fakeInput(answers) {
  const events = []
  return {
    events,
    pick: async (rows, label) => { events.push(["pick", label]); return answers.shift() },
    read: async (label, options = {}) => { events.push(["read", label, !!options.secret]); return answers.shift() },
  }
}
function tempHome() {
  const base = path.join(os.tmpdir(), "opencode")
  fs.mkdirSync(base, { recursive: true })
  const home = fs.mkdtempSync(path.join(base, "vibe-provider-"))
  const dir = path.join(home, "project")
  fs.mkdirSync(dir)
  return { home, dir }
}

test("guided provider add saves format, URL, model, limit and an encrypted key", async () => {
  const { home, dir } = tempHome()
  const vibe = createVibe({ home })
  const input = fakeInput([
    { id: "openai-chat" },
    "my-gateway",
    "http://127.0.0.1:9999/v1",
    "test-model",
    "64000",
    "sk-test-12345",
  ])
  const logs = []
  try {
    const ok = await runCommand({ vibe, dir, home, input, flags: {}, out: { write: (s) => logs.push(String(s)) } }, ["provider", "add"])
    assert.equal(ok, true)
    const saved = await vibe.profiles.list()
    const row = saved.find((p) => p.id === "my-gateway")
    assert.ok(row, "the provider must be listed after the wizard")
    assert.equal(row.format, "openai-chat")
    assert.equal(row.baseURL, "http://127.0.0.1:9999/v1")
    assert.equal(row.model, "test-model")
    assert.equal(row.contextLimit, 64000)
    assert.equal(row.hasKey, true)
    assert.equal(profiles.getKey(profiles.getProfile("my-gateway", home), home), "sk-test-12345")
    assert.ok(input.events.some(([kind, label, secret]) => kind === "read" && secret && /API key/.test(label)))
    const raw = fs.readFileSync(path.join(home, "auth.json"), "utf8")
    assert.equal(raw.includes("sk-test-12345"), false, "the key must be encrypted at rest")
    assert.ok(logs.join("").includes("my-gateway"))
  } finally {
    vibe.engine.extensions.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("guided remove only offers custom providers and deletes the saved key", async () => {
  const { home, dir } = tempHome()
  const vibe = createVibe({ home })
  await vibe.profiles.upsert({ id: "custom-one", name: "custom-one", format: "openai-chat", baseURL: "http://127.0.0.1:9999/v1", model: "m", contextLimit: 8192 })
  await vibe.profiles.setKey("custom-one", "sk-remove-me")
  const input = fakeInput([
    { id: "custom-one", label: "Custom One" },
    "y",
  ])
  try {
    await runCommand({ vibe, dir, home, input, flags: {}, out: { write() {} } }, ["provider", "remove"])
    const saved = await vibe.profiles.list()
    assert.equal(saved.some((p) => p.id === "custom-one"), false)
    const auth = JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8"))
    assert.equal("custom-one" in auth, false, "the saved key must be deleted with the provider")
    assert.equal(saved.some((p) => p.id === "anthropic"), true, "built-in providers must remain")
  } finally {
    vibe.engine.extensions.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("keyless setup records noAuth only after an explicit yes", async () => {
  const { home, dir } = tempHome()
  const vibe = createVibe({ home })
  const input = fakeInput([
    { id: "openai-chat" },
    "local-lab",
    "http://127.0.0.1:11434/v1",
    "llama3.3",
    "8192",
    "",
    "yes",
  ])
  try {
    await runCommand({ vibe, dir, home, input, flags: {}, out: { write() {} } }, ["provider", "add"])
    const row = (await vibe.profiles.list()).find((p) => p.id === "local-lab")
    assert.equal(row.noAuth, true)
    assert.equal(fs.existsSync(path.join(home, "auth.json")) && "local-lab" in JSON.parse(fs.readFileSync(path.join(home, "auth.json"), "utf8")), false)
  } finally {
    vibe.engine.extensions.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("paste inserts the whole clipboard as one draft, never as separate submissions", async () => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; input.setRawMode = (value) => { input.isRaw = value }
  output.isTTY = true; output.columns = 100; output.rows = 30; output.getColorDepth = () => 24
  output.on("data", () => {})
  configureTheme("obsidian", { output, color: true })
  const ui = new TerminalInput({ input, output, fullScreen: true })
  const screen = ui.enableScreen({ context: { workspace: "Desktop", provider: "cloudfire", agent: "Pilot" } })
  screen.open()
  try {
    const draft = ui.read("Compose", { multiline: true })
    ui.data("first line\nsecond line")
    assert.equal(ui.active.text, "first line\nsecond line")
    let pasted = 0
    ui.pasteClipboard = () => { pasted++; ui.insert("from clipboard") }
    ui.key("", { ctrl: true, name: "v" })
    assert.equal(pasted, 1)
    assert.ok(ui.active.text.includes("from clipboard"))
    ui.data("\x1b[<2;20;10M")
    assert.equal(pasted, 2, "right-click in a mouse-enabled console must paste")
    assert.ok(ui.active.text.endsWith("from clipboard"))
    ui.close(); await draft
  } finally {
    ui.close()
  }
})

test("deleting a provider in chat still asks even with saved Full Access", async () => {
  const { home, dir } = tempHome()
  const vibe = createVibe({ home })
  await vibe.profiles.upsert({ id: "keep-safe", name: "keep-safe", format: "openai-chat", baseURL: "http://127.0.0.1:9999/v1", model: "m" })
  const answers = [{ id: "ask" }]
  let asked = false
  const input = {
    pick: async () => answers.shift(),
    read: async () => { asked = true; return "" },
  }
  try {
    await runCommand({ vibe, dir, home, input, inChat: true, flags: { yes: true }, out: { write() {} } }, ["provider", "remove", "keep-safe"])
    assert.equal(asked, true, "the destructive action must still ask")
    assert.equal((await vibe.profiles.list()).some((p) => p.id === "keep-safe"), true)
    assert.equal(loadSettings(home).access, "ask")
  } finally {
    vibe.engine.extensions.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

let failed = 0
for (const { name, fn } of tests) {
  try { await fn(); console.log("PASS CLI provider: " + name) }
  catch (error) { failed++; console.error("FAIL CLI provider: " + name + "\n" + error.stack) }
}
if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY); else delete process.stdin.isTTY
console.log(`${tests.length - failed}/${tests.length} CLI provider tests passed`)
if (failed) process.exitCode = 1
