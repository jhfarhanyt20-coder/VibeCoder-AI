#!/usr/bin/env node
/**
 * CLI regression tests.
 *
 * These run the real terminal entry point against an isolated VIBE_HOME, so
 * they never touch the developer's profiles, keys or sessions. No model call
 * is made: every check is on the offline command surface plus the event
 * renderer with a fake event stream.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { Writable } from "node:stream"

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "cli", "vibe.js")
const pkg = require(path.join(root, "package.json"))
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cli-test-"))
const home = path.join(tempRoot, "home")
const work = path.join(tempRoot, "work")
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(work, { recursive: true })

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, VIBE_HOME: home, NO_COLOR: "1", TERM: "dumb", ...extraEnv },
  })
}

function json(args) {
  const out = run(args)
  assert.equal(out.status, 0, `${args.join(" ")} failed: ${out.stderr}`)
  return JSON.parse(out.stdout)
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test("help lists the full command surface", () => {
  const out = run(["help"])
  assert.equal(out.status, 0)
  for (const token of ["vibe chat", "vibe run", "vibe serve", "vibe skills", "vibe agents", "vibe mcp", "vibe plugins", "vibe tools", "vibe doctor", "vibe usage", "@path/to/file"]) {
    assert.ok(out.stdout.includes(token), `help should mention ${token}`)
  }
})

test("bare vibe prints help when stdin is not a terminal", () => {
  const out = run([])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /vibe - BDCoder coding agent CLI/)
})

test("--version matches package.json", () => {
  const out = run(["--version"])
  assert.equal(out.status, 0)
  assert.equal(out.stdout.trim(), pkg.version)
})

test("tools lists the core built-ins and stays readable", () => {
  const out = run(["tools"])
  assert.equal(out.status, 0)
  for (const name of ["read", "write", "edit", "bash", "skill", "question"]) assert.ok(out.stdout.includes(name), `tools should list ${name}`)
  const longest = Math.max(...out.stdout.split("\n").map((line) => line.length))
  assert.ok(longest < 160, `tool table should clip long descriptions (longest line ${longest})`)
})

test("skills --json reads the same store the agent uses", () => {
  const rows = json(["skills", "--json"])
  assert.ok(Array.isArray(rows))
  for (const row of rows) {
    assert.equal(typeof row.id, "string")
    assert.ok(row.id.length)
    assert.equal(typeof row.scope, "string")
  }
})

test("agents --json always includes the built-in agent", () => {
  const rows = json(["agents", "--json"])
  assert.ok(rows.some((a) => a.id === "build" && a.scope === "builtin"))
})

test("mcp and plugins --json are arrays and plain output names the config files", () => {
  assert.ok(Array.isArray(json(["mcp", "--json"])))
  assert.ok(Array.isArray(json(["plugins", "--json"])))
  const mcp = run(["mcp"])
  assert.equal(mcp.status, 0)
  assert.ok(mcp.stdout.includes(path.join(home, "mcp.json")))
})

test("doctor --json reports the isolated home and no keys", () => {
  const info = json(["doctor", "--json"])
  assert.equal(info.home, home)
  assert.equal(info.sessions, 0)
  assert.equal(info.profiles.ready, 0)
  assert.ok(info.profiles.total > 0)
  assert.equal(typeof info.skills, "number")
})

test("sessions --json is empty in a fresh home", () => {
  assert.deepEqual(json(["sessions", "--json"]), [])
})

test("models --json lists profiles without leaking keys", () => {
  const rows = json(["models", "--json"])
  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.equal(typeof row.id, "string")
    assert.equal(typeof row.hasKey, "boolean")
    assert.ok(!("apiKey" in row) && !("key" in row))
  }
})
test("plain model discovery keeps the legacy profile/format/model columns", () => {
  const out = run(["models"])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /anthropic\s+anthropic\s+claude-/)
  assert.match(out.stdout, /openai\s+openai-chat\s+/)
})

test("unknown commands fail with a helpful message", () => {
  const out = run(["nope"])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /Unknown command "nope"/)
})

test("@file mentions inline text, attach images and report missing files", () => {
  const { expandFileMentions } = require(path.join(root, "cli", "chat.js"))
  fs.writeFileSync(path.join(work, "notes.txt"), "hello world\n", "utf8")
  fs.writeFileSync(path.join(work, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const out = expandFileMentions("read @notes.txt and @pic.png and @missing.txt", work)
  assert.equal(out.inlined.filter((f) => f.kind === "text").length, 1)
  assert.match(out.text, /<file path="notes\.txt">\nhello world\n+<\/file>/)
  assert.equal(out.files.length, 1)
  assert.equal(out.files[0].mime, "image/png")
  assert.deepEqual(Buffer.from(out.files[0].data, "base64"), fs.readFileSync(path.join(work, "pic.png")))
  assert.match(out.files[0].dataUrl, /^data:image\/png;base64,/)
  assert.deepEqual(out.missing, ["missing.txt"])
})

test("renderer answers permissions and question forms, and JSON is NDJSON", async () => {
  const { createRenderer } = require(path.join(root, "cli", "ui.js"))
  const replies = []
  const fakeVibe = {
    permission: { reply: async (id, decision) => replies.push(["permission", id, decision]) },
    forms: {
      reply: async (id, answers) => replies.push(["form", id, answers]),
      cancel: async (id) => replies.push(["cancel", id]),
    },
  }
  const answers = ["y", "2"]
  const rl = { question: (_q, cb) => setImmediate(() => cb(answers.shift() ?? "")) }
  const before = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true })
  try {
    const { Writable: Sink } = await import("node:stream")
    let text = ""
    const sink = new Sink({ write(chunk, _enc, cb) { text += chunk.toString(); cb() } })
    const r = createRenderer({ rl, vibe: fakeVibe, verbose: true, showReasoning: true, out: sink })
    r.beginRun()
    await r.handleEvents([
      { type: "text.delta", delta: "hi" },
      { type: "tool.start", name: "read", args: { path: "a.js" } },
      { type: "tool.end", isError: true, output: "boom" },
      { type: "permission.ask", permissionId: "p1", tool: "bash", subject: "list files" },
      { type: "question.ask", form: { id: "f1", title: "C", questions: [{ header: "C", multiple: false, options: [{ label: "red" }, { label: "blue" }] }] } },
      { type: "subagent.start", subagentName: "reviewer", task: "check" },
      { type: "subagent.end", subagentName: "reviewer", status: "done" },
      { type: "shell.completed", shell: { id: "s1", exitCode: 0 }, output: "ok" },
      { type: "notice", text: "hello" },
      { type: "usage", input: 10, output: 5, cost: 0.001, step: 1 },
      { type: "done", reason: "stop" },
    ])
    assert.match(text, /→ read a\.js/)
    assert.match(text, /! boom/)
    assert.match(text, /subagent reviewer started/)
    assert.match(text, /shell s1 finished/)
    assert.ok(replies.some(([kind, id, value]) => kind === "permission" && id === "p1" && value === "once"))
    assert.ok(replies.some(([kind, id, value]) => kind === "form" && id === "f1" && value.q0[0] === "blue"))

    let ndjson = ""
    const sink2 = new Writable({ write(chunk, _enc, cb) { ndjson += chunk.toString(); cb() } })
    const j = createRenderer({ vibe: fakeVibe, json: true, yes: true, out: sink2 })
    await j.handleEvents([{ type: "text.delta", delta: "x" }, { type: "permission.ask", permissionId: "p2", tool: "bash", subject: "x" }])
    const lines = ndjson.trim().split("\n")
    assert.equal(lines.length, 2)
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line))
  } finally {
    if (before) Object.defineProperty(process.stdin, "isTTY", before)
    else delete process.stdin.isTTY
  }
})

test("fallback chain can be added, shown and removed from the CLI", () => {
  const add = run(["fallback", "add", "openai/gpt-4.1"])
  assert.equal(add.status, 0, add.stderr)
  assert.match(add.stdout, /openai\/gpt-4\.1/)
  const show = run(["fallback"])
  assert.equal(show.status, 0, show.stderr)
  assert.match(show.stdout, /\*\s+openai\/gpt-4\.1/)
  assert.match(show.stdout, /group:fallback/)
  const remove = run(["fallback", "remove", "1"])
  assert.equal(remove.status, 0, remove.stderr)
  assert.match(remove.stdout, /empty/i)
})

test("trust list shows an approved workspace and revoke removes it", () => {
  fs.mkdirSync(path.join(work, ".vibe", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(work, ".vibe", "plugins", "demo.js"), "module.exports = { name: 'demo' }\n")
  const approve = run(["trust", work, "--yes"])
  assert.equal(approve.status, 0, approve.stderr)
  const list = run(["trust", "list"])
  assert.equal(list.status, 0, list.stderr)
  assert.ok(list.stdout.includes(work), "trust list should include the approved workspace")
  const revoke = run(["trust", "revoke", work, "--yes"])
  assert.equal(revoke.status, 0, revoke.stderr)
  assert.match(revoke.stdout, /Revoked/)
  const after = run(["trust", "list"])
  assert.equal(after.status, 0, after.stderr)
  assert.match(after.stdout, /No trusted workspaces/)
})

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`ok ${name}`)
  } catch (error) {
    failed++
    console.error(`not ok ${name}\n  ${error && error.message ? error.message : error}`)
  }
}

try {
  fs.rmSync(tempRoot, { recursive: true, force: true })
} catch {}

console.log(`\n${tests.length - failed}/${tests.length} CLI tests passed`)
if (failed) process.exit(1)
