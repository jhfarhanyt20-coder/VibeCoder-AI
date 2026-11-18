import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const { createVibe, connect } = require("../sdk")
const { createServer } = require("../cli/server")
const { findHost } = require("../cli/connection")
const { publicData } = require("../core/control")
const { isLocked } = require("../core/harness/locks")
const base = path.join(os.tmpdir(), "opencode")
fs.mkdirSync(base, { recursive: true })
const temp = fs.mkdtempSync(path.join(base, "vibe-control-test-"))
const home = path.join(temp, "home"), dir = path.join(temp, "project")
fs.mkdirSync(dir)
const vibe = createVibe({ home })
const call = (action, args = {}) => vibe.control.call(action, { directory: dir, ...args })
const tests = [], test = (name, fn) => tests.push({ name, fn })
await vibe.profiles.upsert({ id: "fixture", name: "Fixture", format: "openai-chat", baseURL: "http://127.0.0.1:1", model: "base", noAuth: true, models: [{ id: "base", context: 32000 }, { id: "other/model", context: 48000, output: 1024, image: true }] })
const session = await vibe.session.create({ dir, profile: "fixture" })

test("native playbooks, agents and recipes install in the selected scope without overwriting", async () => {
  const playbook = await call("skills.install", { id: "test-guide", content: "# Test guide\n\nVerify the requested work." })
  assert.equal(playbook.file, path.join(dir, ".vibe", "playbooks", "test-guide", "PLAYBOOK.md"))
  assert.ok((await call("skills.list")).some((s) => s.id === "test-guide"))
  await assert.rejects(call("skills.install", { id: "test-guide", content: "overwritten" }), /already installed/)
  await call("skills.install", { id: "global-guide", global: true, content: "# Global guide\nA useful guide." })
  assert.ok(fs.existsSync(path.join(home, "playbooks", "global-guide", "PLAYBOOK.md")))
  assert.equal((await call("skills.remove", { id: "global-guide" })).removed, false)
  assert.equal((await call("skills.remove", { id: "global-guide", global: true })).removed, true)
  await call("agents.install", { id: "team/reviewer", content: "---\nname: Inspector\nmode: subagent\n---\nInspect relevant code." })
  assert.equal((await call("agents.show", { id: "team/reviewer" })).name, "Inspector")
  await call("recipes.install", { id: "review", content: "---\ndescription: Review requested files\n---\nReview $ARGUMENTS" })
  assert.equal((await call("recipes.show", { id: "review" })).body, "Review $ARGUMENTS")
})
test("traversal and scoped junction/symlink writes are refused", async () => {
  await assert.rejects(call("agents.install", { id: "../escape", content: "x" }), /traversal/)
  const outside = path.join(temp, "outside")
  fs.mkdirSync(outside)
  const link = path.join(dir, ".vibe", "linked")
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir")
  const { scopedFile } = require("../core/control")
  assert.throws(() => scopedFile(link, "x.md"), /symlink|junction/)
  assert.equal(fs.readdirSync(outside).length, 0)
})
test("extensions are copied/discovered without running their code; reload uses the real lifecycle", async () => {
  const content = "global.__vibeControlLoaded=(global.__vibeControlLoaded||0)+1; module.exports={name:'hello',description:'hello',run:async()=> 'ok'}"
  const installed = await call("extensions.install", { id: "example", content })
  assert.equal(installed.loaded, false)
  assert.equal(global.__vibeControlLoaded, undefined)
  require("../core/harness/trust").trustProject(dir, home)
  assert.ok((await call("extensions.reload")).some((r) => r.id === "example" && r.ok))
  assert.equal(global.__vibeControlLoaded, 1)
  assert.ok((await call("extensions.list")).some((r) => r.id === "example" && r.ok))
  assert.ok((await call("tools.list")).extensions.some((t) => t.name === "extension__example__hello"))
  await assert.rejects(call("extensions.install", { id: "example", content: "changed" }), /EEXIST/)
  await call("extensions.remove", { id: "example" })
  delete global.__vibeControlLoaded
})
test("explicit package plugin installs reuse the existing installer without overwriting user code", async () => {
  const store = require("../core/plugins")
  const original = store.installPlugin
  const calls = []
  store.installPlugin = (args) => {
    calls.push(args)
    const file = path.join(args.directory, ".vibe", "plugins", "mock-package.js")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "module.exports={name:'mock',run:()=> 'ok'}")
    return { name: "mock-package", file }
  }
  try {
    const installed = await call("plugins.fetch", { spec: "@fixture/package@1.0.0" })
    assert.equal(installed.file, path.join(dir, ".vibe", "plugins", "mock-package.js"))
    assert.equal(calls[0].global, false, "the existing installer runs only in its temporary staging scope")
    assert.equal(fs.existsSync(calls[0].directory), false)
    const previous = fs.readFileSync(installed.file, "utf8")
    await assert.rejects(call("plugins.fetch", { spec: "@fixture/package@1.0.0" }), /EEXIST/)
    assert.equal(fs.readFileSync(installed.file, "utf8"), previous)
    for (const spec of ["--global", "pkg;command", "../local", "https://outside.test/pkg"]) {
      await assert.rejects(call("plugins.fetch", { spec }), /reviewed npm/)
    }
  } finally { store.installPlugin = original }
})
test("memory uses the same bounded, deduplicated file as the desktop", async () => {
  const first = await call("memory.add", { text: "বাংলা memory" })
  await call("memory.add", { text: "বাংলা memory" })
  assert.equal((await call("memory.list")).entries.length, 1)
  assert.equal(first.file, path.join(home, "memories.json"))
  assert.equal((await call("memory.remove", { id: first.entries[0].id })).removed, true)
})
test("compaction changes preserve unknown keys and reject corrupt settings", async () => {
  const file = path.join(home, "config.json")
  fs.writeFileSync(file, JSON.stringify({ userWork: { keep: "me" }, compaction: { custom: 7 } }))
  await call("config.set", { key: "compaction.keep.tokens", value: 1234 })
  const saved = JSON.parse(fs.readFileSync(file))
  assert.deepEqual(saved.userWork, { keep: "me" })
  assert.equal(saved.compaction.custom, 7)
  assert.equal(saved.compaction.keep.tokens, 1234)
  await assert.rejects(call("config.set", { key: "__proto__.polluted", value: true }), /Supported/)
  await assert.rejects(call("config.set", { key: "auto", value: "true" }), /true or false/)
  const before = fs.readFileSync(file, "utf8")
  fs.writeFileSync(file, "{unfinished user settings")
  await assert.rejects(call("config.set", { key: "auto", value: false }), /not overwritten/)
  assert.equal(fs.readFileSync(file, "utf8"), "{unfinished user settings")
  fs.writeFileSync(file, before)
})
test("session permissions stay below agent rules and hard Locks", async () => {
  await call("agents.select", { sessionId: session.id, id: "explore" })
  await call("permissions.add", { sessionId: session.id, tool: "write", pattern: "*", effect: "allow" })
  fs.writeFileSync(path.join(dir, ".vibe", "locks.json"), JSON.stringify([{ action: "bash", resource: "*", effect: "block" }]))
  const rules = await call("permissions.list", { sessionId: session.id })
  assert.ok(rules.agent.some((r) => r.tool === "write" && r.action === "deny"))
  assert.equal(isLocked(rules.locks, "bash", "echo test"), true)
  await call("permissions.clear", { sessionId: session.id })
  assert.equal((await call("permissions.list", { sessionId: session.id })).session.length, 0)
  assert.equal(isLocked((await call("permissions.list")).locks, "bash", "echo test"), true)
})
test("legacy Crew types stay restricted instead of becoming a general helper", async () => {
  const original = vibe.engine.createSubagent
  vibe.engine.createSubagent = (args) => args
  try {
    const helper = await call("crew.start", { sessionId: session.id, agent: "web", task: "Research a topic" })
    assert.equal(helper.type, "web")
    assert.equal(helper.agent, undefined)
    await assert.rejects(call("crew.start", { sessionId: session.id, agent: "not-an-agent", task: "Research" }), /Unknown Crew/)
  } finally { vibe.engine.createSubagent = original }
})
test("MCP writes preserve OAuth and use the explicit engine home", async () => {
  const oauth = { authorizationUrl: "https://example.test/auth", tokenUrl: "https://example.test/token", clientId: "fixture", scopes: ["read"] }
  await call("mcp.add", { name: "test-server", type: "remote", url: "https://example.test/mcp", oauth, global: true })
  const raw = JSON.parse(fs.readFileSync(path.join(home, "mcp.json")))
  assert.deepEqual(raw["test-server"].oauth, { ...oauth, tokenEnv: "" })
  assert.ok((await call("mcp.list")).some((s) => s.name === "test-server" && s.scope === "global"))
  assert.equal((await call("mcp.remove", { name: "test-server" })).removed, false)
  assert.equal((await call("mcp.remove", { name: "test-server", global: true })).removed, true)
})
test("model resolution supports slash IDs without changing the provider's selected model", async () => {
  const id = (await call("profiles.resolve", { id: "fixture/other/model" })).id
  assert.equal(id, "fixture/other/model")
  const list = await vibe.profiles.list()
  assert.equal(list.find((p) => p.id === "fixture").model, "base")
  assert.equal(list.find((p) => p.id === id), undefined, "selecting a model must not add another provider row")
  const selected = vibe.engine._profileTarget(id)
  assert.equal(selected.model, "other/model")
  assert.equal(selected.contextLimit, 48000)
  assert.equal(selected.image, true)
  const newSession = await vibe.session.create({ dir, profile: id })
  assert.equal(newSession.profile, id)
})
test("profile management never stores credential fields in headers/body", async () => {
  const p = { id: "bad", format: "openai-chat", baseURL: "https://example.test/v1", model: "x" }
  await assert.rejects(call("profiles.save", { profile: { ...p, apiKey: "do-not-store" } }), /credentials/)
  await assert.rejects(call("profiles.save", { profile: { ...p, headers: { Authorization: "secret" } } }), /Credentials/)
  await assert.rejects(call("profiles.save", { profile: { ...p, quirks: { extraBody: { metadata: { password: "secret" } } } } }), /Credentials/)
  assert.deepEqual(publicData({ command: ["node", "server", "--token", "secret-value"], env: { UNKNOWN: "secret" }, headers: { Authorization: "secret" } }), { command: ["node", "server", "--token", "[redacted]"], env: "[redacted]", headers: "[redacted]" })
})
test("usage separates reasoning/cache and represents unknown cost instead of free", async () => {
  const s = await vibe.session.create({ dir, profile: "fixture" })
  s.messages = [{ role: "assistant", parts: [], usage: { input: 10, output: 20, reasoning: 5, cache: { read: 7, write: 3 } } }]
  s.usage = { totalInput: 20, totalOutput: 25, lastInput: 20 }
  vibe.engine.store.save(s)
  const usage = await call("usage.get", { sessionId: s.id })
  assert.equal(usage.reasoning, 5)
  assert.equal(usage.cacheRead, 7)
  assert.equal(usage.cost, null)
  assert.equal(usage.unknownCost, true)
})
test("safe project init skips user work; export/import never replaces the original session", async () => {
  const brief = path.join(dir, "VIBE.md")
  fs.writeFileSync(brief, "User project brief")
  const init = await call("project.init")
  assert.ok(init.skipped.includes(brief))
  assert.equal(fs.readFileSync(brief, "utf8"), "User project brief")
  const exported = await call("session.export", { sessionId: session.id })
  const imported = await call("session.import", { data: exported })
  assert.notEqual(imported.id, session.id)
  assert.equal(imported.importedFrom, session.id)
  assert.equal((await vibe.session.get(session.id)).id, session.id)
})
test("authenticated HTTP control and local SDK share stores; untrusted requests are rejected", async () => {
  const { server, token } = createServer(vibe.engine)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  const remote = connect({ url, token })
  try {
    const off = remote.event.subscribe(() => {})
    await off.ready
    await remote.control.call("memory.add", { text: "from remote" })
    assert.ok((await call("memory.list")).entries.some((e) => e.text === "from remote"))
    assert.equal((await findHost(home)).url, url)
    const files = fs.readdirSync(path.join(home, "hosts"))
    const record = fs.readFileSync(path.join(home, "hosts", files[0]), "utf8")
    if (process.platform === "win32") assert.equal(record.includes(token), false)
    const missingAuth = await fetch(url + "/control/memory.add", { method: "POST", body: "{}" })
    assert.equal(missingAuth.status, 401)
    const origin = await fetch(url + "/control/memory.add", { method: "POST", headers: { authorization: "Bearer " + token, origin: "https://example.test" }, body: "{}" })
    assert.equal(origin.status, 403)
    await assert.rejects(remote.control.call("constructor"), /Unknown/)
    assert.equal((await remote.browser.listTabs()).ok, false, "standalone host must not fake an Electron browser")
    off()
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  assert.deepEqual(fs.readdirSync(path.join(home, "hosts")), [])
})

let failed = 0
try {
  for (const { name, fn } of tests) {
    try { await fn(); console.log("PASS control: " + name) }
    catch (error) { failed++; console.error("FAIL control: " + name + "\n" + error.stack) }
  }
} finally {
  vibe.engine.extensions.close()
  for (const state of vibe.engine.mcp.clients.values()) state.client?.close()
  fs.rmSync(temp, { recursive: true, force: true })
}
console.log(`${tests.length - failed}/${tests.length} control tests passed`)
if (failed) process.exitCode = 1
