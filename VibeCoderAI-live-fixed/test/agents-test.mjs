import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { createVibe } = require("../sdk")
const agents = require("../core/agents")

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibe-agents-"))

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`
const chat = {
  text: (t) => [sse({ choices: [{ delta: { content: t } }] })],
  tool: (id, name, args) => [sse({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] })],
  end: (inp = 10, out = 5, reason = "stop") => [sse({ choices: [{ delta: {}, finish_reason: reason }] }), sse({ usage: { prompt_tokens: inp, completion_tokens: out }, choices: [] }), "data: [DONE]\n\n"],
}

function mock(handler) {
  let n = 0
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      requests.push({ url: req.url, body })
      const r = await handler({ url: req.url, body, n: n++ })
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const c of r.chunks) res.write(c)
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, port: server.address().port, close: () => server.close() })))
}

function writeAgent(root, rel, text) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

const REVIEWER = `---
name: Reviewer
description: Reviews code without editing it
mode: subagent
model: alt
steps: 7
color: "#ff0000"
permissions: [{"action":"edit","resource":"**","effect":"deny"},{"action":"write","resource":"**","effect":"deny"}]
---
You review code. Never edit it.
`

test("V-07: builtins are always available", () => {
  const home = tmp()
  const dir = tmp()
  const list = agents.listAgents({ home, dir })
  const ids = list.map((a) => a.id)
  for (const id of ["build", "plan", "explore", "general"]) assert.ok(ids.includes(id), `missing builtin ${id}`)
  const build = agents.getAgent("build", { home, dir })
  assert.equal(build.builtin, true)
  assert.equal(build.system, "", "the build agent must not change today's system prompt")
  assert.equal(build.mode, "primary")
})

test("V-07: a nested project agent file is discovered and parsed", () => {
  const home = tmp()
  const dir = tmp()
  writeAgent(path.join(dir, ".vibe", "agents"), "team/reviewer.md", REVIEWER)
  const found = agents.getAgent("team/reviewer", { home, dir })
  assert.ok(found, "nested id is discoverable")
  assert.equal(found.name, "Reviewer")
  assert.equal(found.mode, "subagent")
  assert.equal(found.model, "alt")
  assert.equal(found.steps, 7)
  assert.equal(found.color, "#ff0000")
  assert.match(found.system, /Never edit it/)
  assert.equal(found.scope, "project")
  assert.deepEqual(
    found.rules.find((r) => r.tool === "edit"),
    { tool: "edit", pattern: "**", action: "deny" },
  )
  // a unique leaf name also resolves
  assert.equal(agents.getAgent("reviewer", { home, dir }).id, "team/reviewer")
})

test("V-07: project definition overrides a global one with the same id", () => {
  const home = tmp()
  const dir = tmp()
  writeAgent(path.join(home, "agents"), "reviewer.md", REVIEWER)
  writeAgent(
    path.join(dir, ".vibe", "agents"),
    "reviewer.md",
    `---
name: Project Reviewer
mode: primary
permissions: [{"action":"edit","resource":"**","effect":"deny"}]
---
Project-specific prompt.
`,
  )
  const found = agents.getAgent("reviewer", { home, dir })
  assert.equal(found.name, "Project Reviewer")
  assert.equal(found.scope, "project")
  assert.equal(found.mode, "primary")
  assert.match(found.system, /Project-specific/)
})

test("V-07: the compact permission DSL is accepted", () => {
  const home = tmp()
  const dir = tmp()
  writeAgent(path.join(home, "agents"), "compact.md", `---\nname: Compact\npermissions: edit:**=deny, bash:**=deny\n---\nbody\n`)
  const found = agents.getAgent("compact", { home, dir })
  assert.deepEqual(found.rules, [
    { tool: "edit", pattern: "**", action: "deny" },
    { tool: "bash", pattern: "**", action: "deny" },
  ])
})

test("V-07: hidden agents are filtered unless requested", () => {
  const home = tmp()
  const dir = tmp()
  writeAgent(path.join(home, "agents"), "secret.md", `---\nname: Secret\nhidden: true\n---\nhidden prompt\n`)
  const vibe = createVibe({ home, permission: "allow" })
  assert.equal(vibe.engine.listAgents(dir).some((a) => a.id === "secret"), false)
  assert.equal(vibe.engine.listAgents(dir, { includeHidden: true }).some((a) => a.id === "secret"), true)
  assert.equal(vibe.engine.agents.get("secret", dir).id, "secret")
})

test("V-07: createSession stores the agent id and rejects unknown ids", async () => {
  const home = tmp()
  const dir = tmp()
  const m = await mock(() => ({ chunks: [...chat.text("ok"), ...chat.end()] }))
  const vibe = createVibe({ home, permission: "allow" })
  await vibe.profiles.upsert({ id: "mock", format: "openai-chat", baseURL: `http://127.0.0.1:${m.port}/v1`, model: "m", noAuth: true, contextLimit: 128000 })
  writeAgent(path.join(dir, ".vibe", "agents"), "reviewer.md", REVIEWER)
  const s = await vibe.session.create({ dir, profile: "mock", agent: "reviewer" })
  assert.equal(vibe.engine.getSession(s.id).agent, "reviewer")
  assert.throws(() => vibe.engine.createSession({ dir, profile: "mock", agent: "nope" }), /Unknown agent/)
  m.close()
})

test("V-07: an agent deny rule outranks a stored always-allow approval", async () => {
  const home = tmp()
  const dir = tmp()
  writeAgent(path.join(home, "agents"), "readonly.md", `---\nname: Read Only\npermissions: edit:**=deny\n---\nread only\n`)
  const vibe = createVibe({ home, permission: "ask" })
  await vibe.profiles.upsert({ id: "mock", format: "openai-chat", baseURL: "http://127.0.0.1:1/v1", model: "m", noAuth: true, contextLimit: 128000 })
  const agent = vibe.engine.getAgent("readonly", dir)
  const session = vibe.engine.createSession({ dir, profile: "mock", agent: "readonly" })
  // Simulate an old "always allow" approval for edit.
  session.rules.push({ tool: "edit", pattern: "*", action: "allow" })
  const ask = vibe.engine._ask(session, new AbortController().signal, () => {}, null, agent.rules)
  assert.equal(ask({ tool: "edit", subject: path.join(dir, "a.txt") }), false)
  assert.equal(ask({ tool: "read", subject: path.join(dir, "a.txt") }), true)
})

test("V-07: a read-only agent cannot write a file during a real run", async () => {
  const home = tmp()
  const dir = tmp()
  let turns = 0
  const m = await mock(() => {
    if (turns++ === 0) return { chunks: [...chat.tool("w1", "write", { path: "blocked.txt", content: "no" }), ...chat.end(5, 5, "tool_calls")] }
    return { chunks: [...chat.text("done"), ...chat.end()] }
  })
  const vibe = createVibe({ home, permission: "ask" })
  await vibe.profiles.upsert({ id: "mock", format: "openai-chat", baseURL: `http://127.0.0.1:${m.port}/v1`, model: "m", noAuth: true, contextLimit: 128000 })
  writeAgent(path.join(dir, ".vibe", "agents"), "reviewer.md", REVIEWER)
  const s = await vibe.session.create({ dir, profile: "mock", agent: "reviewer" })
  const events = []
  for await (const ev of vibe.session.prompt(s.id, "write blocked.txt")) events.push(ev)
  m.close()
  assert.equal(fs.existsSync(path.join(dir, "blocked.txt")), false, "the agent must not create the file")
  const toolEnd = events.find((e) => e.type === "tool.end")
  assert.ok(toolEnd && toolEnd.isError, "the denied write is reported as an error")
  assert.match(String(toolEnd.output), /denied/i)
})

test("V-07: an agent model override routes the run to that profile", async () => {
  const home = tmp()
  const dir = tmp()
  const main = await mock(() => ({ chunks: [...chat.text("main"), ...chat.end()] }))
  const alt = await mock(() => ({ chunks: [...chat.text("alt model answered"), ...chat.end()] }))
  const vibe = createVibe({ home, permission: "allow" })
  await vibe.profiles.upsert({ id: "mock", format: "openai-chat", baseURL: `http://127.0.0.1:${main.port}/v1`, model: "m", noAuth: true, contextLimit: 128000 })
  await vibe.profiles.upsert({ id: "alt", format: "openai-chat", baseURL: `http://127.0.0.1:${alt.port}/v1`, model: "a", noAuth: true, contextLimit: 128000 })
  writeAgent(path.join(dir, ".vibe", "agents"), "researcher.md", `---\nname: Researcher\nmodel: alt\n---\nresearch\n`)
  const s = await vibe.session.create({ dir, profile: "mock", agent: "researcher" })
  let text = ""
  for await (const ev of vibe.session.prompt(s.id, "hello")) if (ev.type === "text.delta") text += ev.delta
  main.close()
  alt.close()
  assert.equal(text, "alt model answered")
  assert.equal(main.requests.length, 0, "the session profile is not called")
  assert.ok(alt.requests.length >= 1)
})

test("V-07: agent.steps caps the run", async () => {
  const home = tmp()
  const dir = tmp()
  const m = await mock(() => ({ chunks: [...chat.tool("c", "bash", { command: "echo hi" }), ...chat.end(1, 1, "tool_calls")] }))
  const vibe = createVibe({ home, permission: "allow" })
  await vibe.profiles.upsert({ id: "mock", format: "openai-chat", baseURL: `http://127.0.0.1:${m.port}/v1`, model: "m", noAuth: true, contextLimit: 128000 })
  writeAgent(path.join(dir, ".vibe", "agents"), "short.md", `---\nname: Short\nsteps: 2\n---\nshort\n`)
  const s = await vibe.session.create({ dir, profile: "mock", agent: "short" })
  let done = null
  for await (const ev of vibe.session.prompt(s.id, "loop")) if (ev.type === "done") done = ev
  m.close()
  assert.ok(m.requests.length <= 2, `step cap respected (${m.requests.length} requests)`)
  assert.ok(done, "the run finishes")
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log("PASS", name)
  } catch (e) {
    failed++
    console.log("FAIL", name, "\n  ", e.stack.split("\n").slice(0, 5).join("\n   "))
  }
}
console.log(failed ? `\n${failed} FAILED` : `\nall ${tests.length} passed`)
process.exit(failed ? 1 : 0)
