import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

const { loadLocks, isLocked, stripJsonComments } = require("../core/harness/locks")
const { Trail, shouldTrail } = require("../core/harness/trail")
const { buildBrief } = require("../core/harness/loom")
const { buildSystem } = require("../core/agent/prompt")
const { Engine } = require("../core/engine")
const { combineRules, decideWithSource, isSecretFile, redactText, redactFileBody } = require("../core/harness/guard")
const actions = require("../core/harness/actions")
const snapshots = require("../core/store/snapshots")
const recipes = require("../core/harness/recipes")
const { McpManager } = require("../core/mcp")
const { McpClient } = require("../core/mcp/client")
const { ExtensionManager } = require("../core/harness/extensions")
const connectorOAuth = require("../core/harness/connectors/oauth")
const { decide } = require("../core/perm/rules")
const { createVibe } = require("../sdk")

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibe-harness-"))

const sse = (value) => `data: ${JSON.stringify(value)}\n\n`
const done = (input = 10, output = 5) => [
  sse({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  sse({ usage: { prompt_tokens: input, completion_tokens: output }, choices: [] }),
  "data: [DONE]\n\n",
]
function mockLLM(handler) {
  let n = 0
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}")
      requests.push(body)
      const result = await handler({ n: n++, body })
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of result) res.write(chunk)
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port, requests, close: () => server.close() }),
    )
  })
}

test("locks: global block matches the command, unrelated commands stay open", () => {
  const home = tmp()
  fs.writeFileSync(
    path.join(home, "locks.json"),
    JSON.stringify([{ action: "bash", resource: "git push *", effect: "block" }]),
  )
  const locks = loadLocks({ home })
  assert.equal(isLocked(locks, "bash", "git push origin main"), true)
  assert.equal(isLocked(locks, "bash", "git push"), true)
  assert.equal(isLocked(locks, "bash", "git status"), false)
  assert.equal(isLocked(locks, "read", "src/app.js"), false)
})

test("locks: JSONC comments are accepted and invalid files are ignored safely", () => {
  const home = tmp()
  fs.writeFileSync(
    path.join(home, "locks.jsonc"),
    `{
      // a comment
      "locks": [
        { "action": "shell", "resource": "rm -rf *", "effect": "block" } /* block */
      ]
    }`,
  )
  const locks = loadLocks({ home })
  assert.equal(isLocked(locks, "shell", "rm -rf dist"), true)

  const bad = tmp()
  fs.writeFileSync(path.join(bad, "locks.json"), "{ not json")
  assert.deepEqual(loadLocks({ home: bad }), [])
  assert.equal(stripJsonComments('{"a":"// not a comment"}'), '{"a":"// not a comment"}')
})

test("locks: project entries override a broader global block with a narrow allow", () => {
  const home = tmp()
  const dir = tmp()
  fs.writeFileSync(
    path.join(home, "locks.json"),
    JSON.stringify([{ action: "bash", resource: "git push *", effect: "block" }]),
  )
  fs.mkdirSync(path.join(dir, ".vibe"), { recursive: true })
  fs.writeFileSync(
    path.join(dir, ".vibe", "locks.json"),
    JSON.stringify([{ action: "bash", resource: "git push origin main", effect: "allow" }]),
  )
  const locks = loadLocks({ home, dir })
  assert.equal(isLocked(locks, "bash", "git push origin main"), false)
  assert.equal(isLocked(locks, "bash", "git push origin release"), true)
})

test("engine: a hard lock blocks even when permission mode is allow", async () => {
  const home = tmp()
  const dir = tmp()
  fs.writeFileSync(
    path.join(home, "locks.json"),
    JSON.stringify([{ action: "bash", resource: "git push *", effect: "block" }]),
  )
  const engine = new Engine({ home, permission: "allow" })
  const session = { id: "ses_lock_test", dir, rules: [], messages: [], usage: {} }
  const ask = engine._ask(session, new AbortController().signal, () => {})

  assert.equal(await ask({ tool: "bash", subject: "git push origin main" }), false)
  assert.equal(await ask({ tool: "bash", subject: "git status" }), true)

  const locked = { tool: "bash", subject: "git push origin main" }
  assert.equal(await ask(locked), false)
  assert.equal(locked.locked, true)

  // A saved "always allow" approval must not lift a hard lock.
  session.rules.push({ tool: "bash", pattern: "*", action: "allow" })
  assert.equal(await ask({ tool: "bash", subject: "git push origin main" }), false)
})

test("guard: agent rules outrank session and project rules", () => {
  const layers = combineRules({
    project: [{ tool: "bash", pattern: "*", action: "allow" }],
    session: [{ tool: "bash", pattern: "git *", action: "deny" }],
    agent: [{ tool: "bash", pattern: "git status", action: "allow" }],
  })
  assert.equal(decideWithSource(layers, "bash", "git status").action, "allow")
  assert.equal(decideWithSource(layers, "bash", "git status").source, "agent")
  assert.equal(decideWithSource(layers, "bash", "git push").action, "deny")
  assert.equal(decideWithSource(layers, "bash", "git push").source, "session")

  // Same answer as the plain matcher for every case.
  const flat = layers.flatMap((layer) => layer.rules)
  assert.equal(decideWithSource(layers, "bash", "git push").action, decide(flat, "bash", "git push"))
})

test("guard: secret files and free-text tokens are redacted", () => {
  assert.equal(isSecretFile(".env"), true)
  assert.equal(isSecretFile("/repo/.env.local"), true)
  assert.equal(isSecretFile(".env.example"), false)
  assert.equal(isSecretFile("src/app.js"), false)
  assert.equal(isSecretFile("keys/id_rsa"), true)

  const text = redactText("token=abc123\nAuthorization: Bearer abcdefghijkl\nkey sk-abcdefghijklmnop1234")
  assert.doesNotMatch(text, /abc123/)
  assert.doesNotMatch(text, /abcdefghijkl/)
  assert.doesNotMatch(text, /sk-abcdefghijklmnop1234/)
  assert.match(text, /token=/)

  const body = redactFileBody(".env", "API_KEY=super-secret\n# comment\nNAME=app\n")
  assert.match(body, /API_KEY=\[redacted\]/)
  assert.match(body, /# comment/)
  assert.match(body, /NAME=\[redacted\]/)
  assert.doesNotMatch(body, /super-secret/)
})

test("guard: every permission decision is audited with its layer", async () => {
  const home = tmp()
  const engine = new Engine({ home, permission: "allow" })
  const session = { id: "ses_guard_audit", dir: tmp(), rules: [], messages: [], usage: {} }
  const ask = engine._ask(session, new AbortController().signal, () => {})
  assert.equal(await ask({ tool: "bash", subject: "npm test" }), true)

  const rows = engine.getTrail(session.id, 20)
  const decision = rows.find((row) => row.type === "permission.decision")
  assert.ok(decision, "permission.decision should be written to the trail")
  assert.equal(decision.tool, "bash")
  assert.equal(decision.action, "allow")
  assert.equal(typeof decision.source, "string")
})

test("rewind: snapshots are addressable per step inside a turn", () => {
  const home = tmp()
  const dir = tmp()
  const file = path.join(dir, "note.txt")
  fs.writeFileSync(file, "one")
  const session = { id: "ses_abcdef", turnSeq: 3 }
  const ctx = (step) => ({ session, engine: { home }, step })

  snapshots.capture(ctx(1), file)
  fs.writeFileSync(file, "two")
  snapshots.capture(ctx(2), file)
  fs.writeFileSync(file, "three")

  const steps = snapshots.listSteps(home, session.id)
  assert.deepEqual(steps.map((s) => s.step), [2, 1])
  assert.deepEqual(steps[0].files, [file])

  const preview = snapshots.preview(home, session.id, { turn: 3, step: 2 })
  assert.equal(preview.files.length, 1)
  assert.equal(preview.files[0].changed, true)
  assert.match(preview.files[0].diff, /-two/)
  assert.match(preview.files[0].diff, /\+three/)

  // Undo step 2 only: back to the state before that step.
  const second = snapshots.undoStep(home, session.id, 3, 2)
  assert.deepEqual(second.restored, [file])
  assert.equal(fs.readFileSync(file, "utf8"), "two")
  assert.equal(snapshots.listRedo(home, session.id).length, 1)

  // Redo restores the exact state and makes the step rewindable again.
  const redone = snapshots.redo(home, session.id)
  assert.deepEqual(redone.restored, [file])
  assert.equal(fs.readFileSync(file, "utf8"), "three")
  assert.deepEqual(snapshots.listSteps(home, session.id).map((s) => s.step), [2, 1])

  // Undo step 1: back to the original.
  snapshots.undoStep(home, session.id, 3, 2)
  snapshots.undoStep(home, session.id, 3, 1)
  assert.equal(fs.readFileSync(file, "utf8"), "one")

  // A file created by a step is deleted when that step is undone.
  const created = path.join(dir, "new.txt")
  snapshots.capture(ctx(1), created)
  fs.writeFileSync(created, "new")
  const out = snapshots.undoStep(home, session.id, 3, 1)
  assert.deepEqual(out.deleted, [created])
  assert.equal(fs.existsSync(created), false)
  snapshots.redo(home, session.id)
  assert.equal(fs.readFileSync(created, "utf8"), "new")
})

test("rewind: engine step undo and redo keep file history aligned", () => {
  const home = tmp()
  const engine = new Engine({ home, permission: "allow" })
  const dir = tmp()
  const file = path.join(dir, "app.txt")
  fs.writeFileSync(file, "before")
  const session = engine.store.create({ dir, profile: "unused" })
  session.turnSeq = 1
  session.messages = [
    { role: "user", turn: 1, parts: [{ type: "text", text: "change it" }] },
    { role: "assistant", step: 1, parts: [{ type: "tool_call", id: "c1", name: "edit", args: {} }] },
    { role: "user", step: 1, parts: [{ type: "tool_result", id: "c1", name: "edit", output: "ok" }] },
    { role: "assistant", step: 2, parts: [{ type: "text", text: "done" }] },
  ]
  engine.store.save(session)
  snapshots.capture({ session, engine, step: 1 }, file)
  fs.writeFileSync(file, "after")

  const undone = engine.undoStepSession(session.id, 1, 1)
  assert.equal(fs.readFileSync(file, "utf8"), "before")
  assert.equal(undone.messagesDropped, 3)
  assert.equal(engine.getSession(session.id).messages.length, 1)
  assert.equal(engine.listRedo(session.id).length, 1)

  const redone = engine.redoSession(session.id)
  assert.equal(fs.readFileSync(file, "utf8"), "after")
  assert.equal(redone.messagesRestored, 3)
  assert.equal(engine.getSession(session.id).messages.length, 4)
  assert.equal(engine.listStepSnapshots(session.id).length, 1)
})

test("crew: depth and per-parent parallel limits are enforced", () => {
  const home = tmp()
  const engine = new Engine({ home, permission: "allow", crewMaxParallel: 1 })
  // Keep records running without opening a provider connection.
  engine.subagents._run = async () => {}
  const parent = engine.store.create({ dir: tmp(), profile: "unused" })

  const first = engine.subagents.create({ sessionId: parent.id, type: "general", task: "first" })
  assert.equal(engine.subagents.maxParallel, 1)
  assert.equal(engine.subagents.status(first.id).ok, null)
  assert.throws(
    () => engine.subagents.create({ sessionId: parent.id, type: "general", task: "second" }),
    /Crew parallel limit reached \(1\)/,
  )
  assert.throws(
    () => engine.subagents.create({ sessionId: first.sessionID, type: "general", task: "nested" }),
    /cannot spawn nested/i,
  )

  const record = engine.subagents.agents.get(first.id)
  record.status = "error"
  record.error = "failed safely"
  record.completedAt = record.startedAt + 12
  const failed = engine.subagents.result(first.id)
  assert.equal(failed.ok, false)
  assert.equal(failed.durationMs, 12)

  const second = engine.subagents.create({ sessionId: parent.id, type: "general", task: "second" })
  assert.ok(second.id)
})

test("actions: string and object results share one contract", () => {
  const plain = actions.normalizeResult("hello")
  assert.deepEqual(plain, { output: "hello", isError: false })

  const rich = actions.normalizeResult({
    output: "done",
    isError: false,
    stats: { added: 3 },
    artifacts: ["a.txt", { path: "b.txt", kind: "image", bytes: 10 }],
  })
  assert.equal(rich.output, "done")
  assert.deepEqual(rich.stats, { added: 3 })
  assert.deepEqual(rich.artifacts, [{ path: "a.txt" }, { path: "b.txt", kind: "image", bytes: 10 }])

  assert.equal(actions.normalizeResult({ text: "from text" }).output, "from text")

  const huge = actions.clipOutput("x".repeat(200000))
  assert.ok(huge.length < 200000)
  assert.match(huge, /chars truncated/)

  const elapsed = actions.mark()
  assert.equal(typeof elapsed(), "number")
})

test("connectors: resources are paged, discoverable and read lazily", async () => {
  const client = new McpClient("docs", { type: "remote", url: "https://example.invalid/mcp" })
  const calls = []
  client._request = async (method, params) => {
    calls.push({ method, params })
    if (!params.cursor) return { resources: [{ uri: "docs://one", name: "One" }], nextCursor: "next" }
    return { resources: [{ uri: "docs://two", name: "Two" }] }
  }
  assert.deepEqual((await client.listResources()).map((item) => item.uri), ["docs://one", "docs://two"])
  assert.equal(calls.length, 2)

  const manager = new McpManager({ home: tmp() })
  manager.clients.set("docs", {
    ok: true,
    error: "",
    tools: [],
    resources: [{ uri: "docs://one", name: "One", mimeType: "text/plain" }],
    resourceTemplates: [{ uriTemplate: "docs://{id}", name: "By id" }],
    resourceError: "",
    client: { readResource: async (uri) => [{ uri, mimeType: "text/plain", text: "hello resource" }] },
  })
  assert.equal(manager.resources("docs")[0].connector, "docs")
  assert.equal(manager.resourceTemplates("docs")[0].uriTemplate, "docs://{id}")
  const read = await manager.readResource("docs", "docs://one")
  assert.deepEqual(read, [{ uri: "docs://one", mimeType: "text/plain", type: "text", text: "hello resource" }])
  const action = manager.resourceToolObjects()[0]
  assert.match(action.name, /^connector__docs__read$/)
  assert.equal(await action.run({ uri: "docs://one" }), "hello resource")
})

test("extensions: native tools load once and receive lifecycle hooks", async () => {
  const home = tmp()
  const project = tmp()
  const folder = path.join(home, "extensions")
  const file = path.join(folder, "lifecycle.js")
  const log = path.join(home, "hooks.log")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(file, `
    const fs = require("node:fs")
    const log = (text) => fs.appendFileSync(${JSON.stringify(log)}, text + "\\n")
    module.exports = {
      hooks: {
        onLoad() { log("load") },
        onUnload() { log("unload") },
        onEvent(event) { if (event.type === "test.event") log("event") },
        beforeAction() { log("before") },
        afterAction({ error }) { log(error ? "after-error" : "after") },
      },
      tools: [{
        name: "echo",
        description: "Echo one value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        async run(args) { return { output: "echo:" + args.value, artifacts: ["result.txt"] } },
      }],
    }
  `)

  const manager = new ExtensionManager({ home })
  const first = manager.toolObjects(project)
  assert.equal(first.length, 1)
  assert.equal(first[0].name, "extension__lifecycle__echo")
  manager.toolObjects(project) // stable signature: no second onLoad
  const result = await first[0].run({ value: "ok" }, {})
  assert.deepEqual(result, { output: "echo:ok", artifacts: ["result.txt"] })
  manager.event({ type: "test.event" })
  fs.unlinkSync(file)
  assert.equal(manager.toolObjects(project).length, 0)
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split(/\r?\n/), ["load", "before", "after", "event", "unload"])
})

test("connectors: OAuth uses PKCE and never writes tokens to config", async () => {
  const started = connectorOAuth.beginOAuth({
    authorizationUrl: "https://accounts.example.com/authorize",
    clientId: "vibe-client",
    redirectUri: "http://127.0.0.1:4567/callback",
    scopes: ["read", "tools"],
  })
  const authorize = new URL(started.url)
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256")
  assert.equal(authorize.searchParams.get("state"), started.state)
  assert.equal(authorize.searchParams.get("scope"), "read tools")
  assert.ok(authorize.searchParams.get("code_challenge").length >= 40)
  assert.equal(started.url.includes(started.verifier), false)

  let tokenRequest
  const token = await connectorOAuth.exchangeCode({
    tokenUrl: "https://accounts.example.com/token",
    clientId: "vibe-client",
    code: "code-123",
    redirectUri: "http://127.0.0.1:4567/callback",
    verifier: started.verifier,
    fetchImpl: async (url, options) => {
      tokenRequest = { url: String(url), options }
      return { ok: true, status: 200, json: async () => ({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 }) }
    },
  })
  assert.equal(token.accessToken, "access-secret")
  assert.match(tokenRequest.options.body, /code_verifier=/)
  assert.doesNotMatch(started.url, /access-secret|refresh-secret/)

  const home = tmp()
  fs.writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ docs: {
    type: "remote",
    url: "https://connector.example.com/mcp",
    oauth: { authorizationUrl: "https://accounts.example.com/authorize", tokenUrl: "https://accounts.example.com/token", clientId: "vibe-client", scopes: ["read"] },
  } }))
  const manager = new McpManager({ home })
  const pending = manager.beginOAuth("docs", { redirectUri: "http://localhost:4567/callback" })
  assert.equal(pending.connector, "docs")
  assert.equal(Object.hasOwn(pending, "verifier"), false)
  assert.equal(fs.readFileSync(path.join(home, "mcp.json"), "utf8").includes("access-secret"), false)
})

test("connectors: an OAuth token environment variable becomes a bearer header", async () => {
  const oldFetch = globalThis.fetch
  const oldToken = process.env.VIBE_TEST_CONNECTOR_TOKEN
  let captured
  process.env.VIBE_TEST_CONNECTOR_TOKEN = "env-secret-token"
  globalThis.fetch = async (url, options) => {
    captured = { url, options }
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "content-type" ? "application/json" : null },
      json: async () => ({ jsonrpc: "2.0", id: 1, result: {} }),
    }
  }
  try {
    const client = new McpClient("secure", { type: "remote", url: "https://connector.example.com/mcp", oauth: { tokenEnv: "VIBE_TEST_CONNECTOR_TOKEN" } })
    await client._postRemote({ jsonrpc: "2.0", id: 1, method: "ping" })
    assert.equal(captured.options.headers.authorization, "Bearer env-secret-token")
  } finally {
    globalThis.fetch = oldFetch
    if (oldToken === undefined) delete process.env.VIBE_TEST_CONNECTOR_TOKEN
    else process.env.VIBE_TEST_CONNECTOR_TOKEN = oldToken
  }
})

test("recipes: layered templates substitute arguments without executing shell fences", () => {
  const home = tmp()
  const root = tmp()
  const nested = path.join(root, "packages", "app")
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  fs.mkdirSync(path.join(home, "recipes"), { recursive: true })
  fs.mkdirSync(path.join(nested, ".vibe", "recipes"), { recursive: true })
  fs.writeFileSync(path.join(home, "recipes", "ship.md"), "Global $ARGUMENTS")
  fs.writeFileSync(path.join(nested, ".vibe", "recipes", "ship.md"), [
    "---",
    "description: Ship one target",
    "persona: plan",
    "model: alternate",
    "---",
    "Review $1, then use all args: $ARGUMENTS",
    "```bash",
    "npm test",
    "```",
  ].join("\n"))

  const list = recipes.listRecipes({ directory: nested, home })
  assert.equal(list.filter((item) => item.id === "ship").length, 1)
  assert.equal(list.find((item) => item.id === "ship").scope, "project")
  const expanded = recipes.expandRecipe('/ship "web app" production', { directory: nested, home })
  assert.deepEqual(expanded.args, ["web app", "production"])
  assert.match(expanded.text, /Review web app/)
  assert.match(expanded.text, /"web app" production/)
  assert.match(expanded.text, /reference material, not approval/)
  assert.equal(expanded.agent, "plan")
  assert.equal(expanded.model, "alternate")
  assert.equal(recipes.expandRecipe("/unknown arg", { directory: nested, home }), null)
})

test("recipes: slash invocation applies ephemeral persona and model overrides", async () => {
  const home = tmp()
  const dir = tmp()
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
  const folder = path.join(dir, ".vibe", "recipes")
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, "inspect.md"), [
    "---",
    "description: Inspect a target",
    "persona: plan",
    "model: alternate",
    "---",
    "Inspect $1 carefully. Full request: $ARGUMENTS",
  ].join("\n"))

  const mock = await mockLLM(() => [sse({ choices: [{ delta: { content: "Recipe complete." } }] }), ...done()])
  try {
    const vibe = createVibe({ home, permission: "allow" })
    await vibe.profiles.upsert({ id: "default", format: "openai-chat", baseURL: `http://127.0.0.1:${mock.port}/v1`, model: "m-default", noAuth: true, contextLimit: 128000 })
    await vibe.profiles.upsert({ id: "alternate", format: "openai-chat", baseURL: `http://127.0.0.1:${mock.port}/v1`, model: "m-alternate", noAuth: true, contextLimit: 128000 })
    const session = await vibe.session.create({ dir, profile: "default" })
    const events = []
    for await (const event of vibe.session.prompt(session.id, '/inspect "src app" now')) events.push(event)

    assert.ok(events.some((event) => event.type === "recipe.start" && event.id === "inspect"))
    assert.equal(mock.requests.length, 1)
    assert.equal(mock.requests[0].model, "m-alternate")
    assert.match(JSON.stringify(mock.requests[0].messages), /You are a planning agent/)
    assert.match(JSON.stringify(mock.requests[0].messages), /Inspect src app carefully/)
    const stored = await vibe.session.get(session.id)
    const user = stored.messages.find((message) => message.recipe?.id === "inspect")
    assert.ok(user)
    assert.equal(user.parts[0].text, '/inspect "src app" now')
    assert.ok(user.parts.some((part) => part.agentOnly && /Inspect src app carefully/.test(part.text)))
    assert.deepEqual(user.recipe, { id: "inspect", agent: "plan", model: "alternate" })
  } finally {
    mock.close()
  }
})

test("trail: writes, reads and redacts secrets without throwing", () => {
  const home = tmp()
  const trail = new Trail({ home })
  assert.equal(
    trail.append("ses_1", {
      type: "tool.end",
      output: "x".repeat(5000),
      args: { apiKey: "secret-key", authorization: "Bearer abc", command: "npm test" },
    }),
    true,
  )
  assert.equal(trail.append("ses_1", { type: "tool.start", args: { token: "t" } }), true)

  const rows = trail.read("ses_1", 10)
  assert.equal(rows.length, 2)
  assert.match(rows[0].output, /clipped/)
  assert.equal(rows[0].args.apiKey, "[redacted]")
  assert.equal(rows[0].args.authorization, "[redacted]")
  assert.equal(rows[0].args.command, "npm test")
  assert.equal(rows[1].args.token, "[redacted]")
  assert.equal(typeof rows[0].time, "number")

  assert.deepEqual(trail.read("missing", 10), [])
})

test("trail: only durable event types are persisted", () => {
  assert.equal(shouldTrail({ type: "tool.start" }), true)
  assert.equal(shouldTrail({ type: "run.start" }), true)
  assert.equal(shouldTrail({ type: "step.start" }), true)
  assert.equal(shouldTrail({ type: "step.end" }), true)
  assert.equal(shouldTrail({ type: "done" }), true)
  assert.equal(shouldTrail({ type: "text.delta" }), false)
  assert.equal(shouldTrail({ type: "reasoning.delta" }), false)

  const engine = new Engine({ home: tmp(), permission: "allow" })
  engine._emit("ses_trail", { type: "tool.start", name: "read" })
  engine._emit("ses_trail", { type: "text.delta", delta: "hello" })
  const rows = engine.getTrail("ses_trail")
  assert.equal(rows.length, 1)
  assert.equal(rows[0].type, "tool.start")
  assert.equal(rows[0].name, "read")
  assert.equal(rows[0].sessionId, "ses_trail")
})

test("loom: global, project, nested and folder briefs load in stable order", () => {
  const oldHome = process.env.VIBE_HOME
  const home = tmp()
  const root = tmp()
  const sub = path.join(root, "packages", "app")
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  fs.mkdirSync(sub, { recursive: true })
  fs.mkdirSync(path.join(sub, ".vibe", "briefs"), { recursive: true })
  fs.writeFileSync(path.join(home, "VIBE.md"), "global-rule")
  fs.writeFileSync(path.join(root, "VIBE.md"), "root-rule")
  fs.writeFileSync(path.join(sub, "VIBE.md"), "sub-rule")
  fs.writeFileSync(path.join(sub, ".vibe", "briefs", "10-style.md"), "folder-rule")
  process.env.VIBE_HOME = home
  try {
    const text = buildBrief({ cwd: sub })
    assert.match(text, /global-rule/)
    assert.match(text, /root-rule/)
    assert.match(text, /sub-rule/)
    assert.match(text, /folder-rule/)
    assert.ok(text.indexOf("global-rule") < text.indexOf("root-rule"))
    assert.ok(text.indexOf("root-rule") < text.indexOf("sub-rule"))
    assert.ok(text.indexOf("sub-rule") < text.indexOf("folder-rule"))

    const system = buildSystem({ cwd: sub, model: "test-model" })
    assert.match(system, /# Project brief \(VIBE\.md\)/)
    assert.match(system, /sub-rule/)

    // An explicit home wins over VIBE_HOME (SDK callers can pass their own home).
    process.env.VIBE_HOME = tmp()
    const explicit = buildSystem({ cwd: sub, model: "test-model", home })
    assert.match(explicit, /global-rule/)
  } finally {
    if (oldHome === undefined) delete process.env.VIBE_HOME
    else process.env.VIBE_HOME = oldHome
  }
})

test("loom: with no brief files the prompt has no new section", () => {
  const oldHome = process.env.VIBE_HOME
  const home = tmp()
  const root = tmp()
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  process.env.VIBE_HOME = home
  try {
    assert.equal(buildBrief({ cwd: root }), "")
    const system = buildSystem({ cwd: root, model: "test-model" })
    assert.doesNotMatch(system, /# Project brief \(VIBE\.md\)/)
  } finally {
    if (oldHome === undefined) delete process.env.VIBE_HOME
    else process.env.VIBE_HOME = oldHome
  }
})

test("engine loop: multiple read-only calls run in one batch and keep order", async () => {
  const home = tmp()
  const dir = tmp()
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n")
  fs.writeFileSync(path.join(dir, "b.txt"), "beta\n")
  const mock = await mockLLM(({ n }) => {
    if (n === 0) {
      const call = (index, id, file) => ({
        index,
        id,
        function: { name: "read", arguments: JSON.stringify({ path: file }) },
      })
      return [
        sse({ choices: [{ delta: { tool_calls: [call(0, "read_a", "a.txt"), call(1, "read_b", "b.txt")] } }] }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        sse({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }),
        "data: [DONE]\n\n",
      ]
    }
    return [sse({ choices: [{ delta: { content: "Both files read." } }] }), ...done()]
  })
  try {
    const vibe = createVibe({ home, permission: "allow" })
    await vibe.profiles.upsert({
      id: "mock",
      format: "openai-chat",
      baseURL: `http://127.0.0.1:${mock.port}/v1`,
      model: "m",
      noAuth: true,
      contextLimit: 128000,
    })
    const session = await vibe.session.create({ dir, profile: "mock" })
    const events = []
    for await (const event of vibe.session.prompt(session.id, "read both files")) events.push(event)

    const starts = events.filter((event) => event.type === "tool.start" && event.name === "read")
    const ends = events.filter((event) => event.type === "tool.end" && event.name === "read")
    assert.equal(starts.length, 2)
    assert.equal(ends.length, 2)
    assert.equal(ends[0].id, "read_a")
    assert.equal(ends[1].id, "read_b")
    assert.match(ends[0].output, /alpha/)
    assert.match(ends[1].output, /beta/)
    assert.equal(ends.every((event) => event.isError === false), true)
    assert.equal(ends.every((event) => typeof event.durationMs === "number" && event.durationMs >= 0), true)
    const step = events.find((event) => event.type === "step.start")
    assert.ok(step.tools.includes("read"))
    assert.ok(step.tools.includes("playbook"))
    assert.equal(step.tools.includes("skill"), false)

    const stored = await vibe.session.get(session.id)
    const toolResults = stored.messages.flatMap((message) =>
      (message.parts || []).filter((part) => part.type === "tool_result"),
    )
    assert.equal(toolResults.length, 2)
    assert.deepEqual(toolResults.map((part) => part.id), ["read_a", "read_b"])
  } finally {
    mock.close()
  }
})

test("engine loop: a hard lock reaches the model as a blocked action", async () => {
  const home = tmp()
  const dir = tmp()
  fs.writeFileSync(
    path.join(home, "locks.json"),
    JSON.stringify([{ action: "bash", resource: "git push *", effect: "block" }]),
  )
  const mock = await mockLLM(({ n }) => {
    if (n === 0) {
      return [
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_lock",
                    function: { name: "bash", arguments: JSON.stringify({ command: "git push origin main" }) },
                  },
                ],
              },
            },
          ],
        }),
        sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        sse({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }),
        "data: [DONE]\n\n",
      ]
    }
    return [sse({ choices: [{ delta: { content: "Understood, not pushing." } }] }), ...done()]
  })
  try {
    const vibe = createVibe({ home, permission: "allow" })
    await vibe.profiles.upsert({
      id: "mock",
      format: "openai-chat",
      baseURL: `http://127.0.0.1:${mock.port}/v1`,
      model: "m",
      noAuth: true,
      contextLimit: 128000,
    })
    const session = await vibe.session.create({ dir, profile: "mock" })
    const events = []
    for await (const event of vibe.session.prompt(session.id, "push the branch")) events.push(event)

    const ended = events.find((event) => event.type === "tool.end" && event.name === "bash")
    assert.ok(ended, "bash tool should have ended")
    assert.equal(ended.isError, true)
    assert.match(ended.output, /hard lock/i)
    assert.ok(events.some((event) => event.type === "permission.lock"))
    assert.ok(events.some((event) => event.type === "run.start"))
    assert.ok(events.some((event) => event.type === "step.start"))
    assert.ok(events.some((event) => event.type === "step.end"))
  } finally {
    mock.close()
  }
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} harness tests passed`)
if (failed) process.exit(1)
