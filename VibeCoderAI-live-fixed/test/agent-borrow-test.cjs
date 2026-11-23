"use strict"
// Ideas adopted after comparing agent designs: prompt-cache marks (Anthropic),
// the final step keeps its tools with tool_choice "none", "Always allow"
// remembers a safe command family, and edit matches typographic look-alikes.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createVibe } = require("../sdk")
const { familyOf, rememberRule, rememberLabel, matchPrefix } = require("../core/perm/remember")
const { decide } = require("../core/perm/rules")
const { applyEdit } = require("../core/tools/editkit")
const { checkPermissions } = require("../core/agent/loop")
const tools = require("../core/tools")

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vc-borrow-"))
const tick = () => new Promise((r) => setImmediate(r))

;(async () => {
  // --- "Always allow" remembers a command family, never a risky superset ---
  assert.deepEqual(familyOf('git commit -m "fix"'), ["git", "commit"])
  assert.deepEqual(familyOf("npm run build -- --watch"), ["npm", "run", "build"])
  assert.deepEqual(familyOf("ls -la"), ["ls"])
  assert.equal(familyOf("git push --force"), null, "push is never generalized")
  assert.equal(familyOf("rm -rf build"), null)
  assert.equal(familyOf("echo hi > out.txt"), null, "a redirect is never generalized")
  assert.equal(familyOf("npm run $(evil)"), null)
  assert.equal(familyOf("Remove-Item .vibe-scratch\\x"), null)
  assert.equal(rememberLabel('git commit -m "x"'), "git commit …")
  assert.equal(rememberLabel("rm -rf build"), "rm -rf build")
  const rules = [rememberRule('git commit -m "fix"')]
  assert.equal(decide(rules, "bash", 'git commit -m "other"'), "allow")
  assert.equal(decide(rules, "bash", "git commit"), "allow")
  for (const c of ["git commit -m x; rm -rf /", "git commit -m $(calc)", "git commit -m x > C:/evil", "git commit -m x # hidden", "git push", "gitx commit"]) {
    assert.equal(decide(rules, "bash", c), "ask", c)
  }
  assert.equal(matchPrefix("git commit", "GIT.exe commit -a"), true, "program name is normalized")

  // the real engine: "always" saves the family, shows it first, and the next variant runs unasked
  const home = tmp()
  const vibe = createVibe({ home, permission: "ask" })
  const s = vibe.engine.store.create({ dir: tmp(), profile: "mock" })
  const events = []
  const ask = vibe.engine._ask(s, new AbortController().signal, (e) => events.push(e))
  const bash = (command) => tools.byName("bash").perm({ command })
  const p1 = checkPermissions(ask, bash('git commit -m "first"'), {})
  await tick()
  const askEv = events.find((e) => e.type === "permission.ask")
  assert.deepEqual(askEv.remembers, ["git commit …"], "the prompt says what Always allow remembers")
  const pending = [...vibe.engine.pending.values()].pop()
  assert.deepEqual(pending.remembers, ["git commit …"], "the pending list (app card) carries it too")
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "always")
  assert.equal(await p1, true)
  assert.ok(s.rules.some((r) => r.prefix && r.pattern === "git commit"), "the family rule is saved")
  events.length = 0
  assert.equal(await checkPermissions(ask, bash('git commit -m "second"'), {}), true)
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 0, "a new commit message does not ask again")
  // a risky command is still remembered exactly
  const p2 = checkPermissions(ask, bash("git push --force"), {})
  await tick()
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "always")
  await p2
  assert.ok(s.rules.some((r) => r.exact && r.pattern === "git push --force"))
  events.length = 0
  const p3 = checkPermissions(ask, bash("git push origin main"), {})
  await tick()
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 1, "another push still asks")
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "deny")
  assert.equal(await p3, false)

  // --- edit: typographic look-alikes ---
  const src = 'const msg = "Don\'t stop - keep going"\nconsole.log(msg)\n'
  const r1 = applyEdit(src, "const msg = “Don’t stop — keep going”", 'const msg = "Keep going"')
  assert.equal(r1.strategy, "typography-normalized")
  assert.equal(r1.out, 'const msg = "Keep going"\nconsole.log(msg)\n')
  const r2 = applyEdit("title: “Hello” – world\n", 'title: "Hello" - world', 'title: "Hi"')
  assert.equal(r2.out, 'title: "Hi"\n', "curly text in the file, plain text from the model")
  const r3 = applyEdit("a\u00A0b = 1\n", "a b = 1", "a b = 2")
  assert.equal(r3.out, "a b = 2\n", "a non-breaking space matches a plain space")
  assert.throws(() => applyEdit('a "x" b\n', "a “y” b", "z"), /not found/, "different words still do not match")
  assert.equal(applyEdit("x = 1\n", "x = 1", "x = 2").strategy, "exact", "exact text still wins first")

  // --- final step: the note goes after the history, the system prompt is untouched ---
  const { withFinalNote } = require("../core/agent/loop")
  const hist = [{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", parts: [{ type: "tool_call", id: "1", name: "read", args: {} }] }, { role: "user", parts: [{ type: "tool_result", id: "1", output: "x" }] }]
  const noted = withFinalNote(hist, "NOTE")
  assert.equal(noted.length, 3, "the note joins the trailing user message")
  assert.deepEqual(noted.slice(0, 2), hist.slice(0, 2), "everything before it is unchanged")
  assert.equal(noted[2].parts.at(-1).text, "NOTE")
  assert.equal(hist[2].parts.length, 1, "the saved history is not modified")
  assert.equal(withFinalNote(hist.slice(0, 2), "NOTE").at(-1).role, "user", "after an assistant message a user note is appended")
  const loopSrc = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "core", "agent", "loop.js"), "utf8")
  assert.match(loopSrc, /const reqSystem = system\r?\n/, "the final step does not change the system prompt")

  // --- OpenAI-compatible endpoints: the same rule for every provider (no name lists) ---
  const chat = require("../core/llm/openai-chat")
  const promptCache = require("../core/llm/cache")
  promptCache._reset()
  for (const p of [
    { model: "anthropic/claude-sonnet-4.5", baseURL: "https://openrouter.ai/api/v1" },
    { model: "gemini-2.5-flash", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" },
    { model: "gpt-4.1", baseURL: "https://api.openai.com/v1" },
    { model: "any-model", baseURL: "https://a-provider-added-tomorrow.example/v1" },
  ]) assert.equal(chat.wantsChatCacheMarks(p), true, `${p.model} gets the marks`)
  assert.equal(chat.wantsChatCacheMarks({ model: "x", baseURL: "https://x/v1", quirks: { promptCache: false } }), false, "a profile can turn them off")
  const loopText = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "core", "llm", "openai-chat.js"), "utf8") + require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "core", "llm", "anthropic.js"), "utf8")
  assert.doesNotMatch(loopText, /claude\|anthropic|openrouter\\.ai.*gemini/i, "no provider or model name decides caching")
  const http = require("node:http")
  const seen = []
  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = ""
      req.on("data", (d) => (b += d))
      req.on("end", () => {
        const body = JSON.parse(b)
        seen.push(body)
        if (req.headers["x-reject-cache"] && JSON.stringify(body).includes("cache_control")) {
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(JSON.stringify({ error: { message: "Invalid request" } })) // generic text on purpose
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n')
        res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9000,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":8800}}}\n\n')
        res.end("data: [DONE]\n\n")
      })
    })
    srv.listen(0, "127.0.0.1", () => resolve(srv))
  })
  const base = `http://127.0.0.1:${server.address().port}/v1`
  const run = async (profile) => { const evs = []; for await (const e of chat.stream({ profile, apiKey: "k", system: "SYS", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [] })) evs.push(e); return evs }
  const evs = await run({ id: "c", model: "anthropic/claude-x", baseURL: base })
  const first = seen.at(-1)
  assert.deepEqual(first.messages[0], { role: "system", content: [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }] })
  assert.deepEqual(first.messages.at(-1).content.at(-1).cache_control, { type: "ephemeral" })
  assert.equal(JSON.stringify(first).includes("__vc"), false, "no private marker reaches the server")
  assert.equal(evs.find((e) => e.type === "usage").cache.read, 8800, "cached tokens are reported")
  await run({ id: "g", model: "gpt-4.1", baseURL: base })
  assert.equal(JSON.stringify(seen.at(-1)).includes("cache_control"), true, "every model gets the marks")
  const before = seen.length
  const rejecting = { id: "r", model: "some-model", baseURL: base, headers: { "x-reject-cache": "1" } }
  await run(rejecting)
  assert.equal(seen.length - before, 2, "one retry, whatever the error text says")
  assert.equal(JSON.stringify(seen.at(-1)).includes("cache_control"), false)
  assert.equal(seen.at(-1).messages[0].content, "SYS", "the system prompt is a plain string again")
  assert.equal(seen.at(-1).messages.at(-1).content, "hi")
  await run(rejecting)
  assert.equal(seen.length - before, 3, "remembered: no failed request the next time")
  assert.equal(JSON.stringify(seen.at(-1)).includes("cache_control"), false)
  promptCache._reset()
  server.close()
  // A 400 that is about something else keeps its own handling (compaction, fallback, the user).
  for (const msg of ["This model's maximum context length is 8192 tokens", "prompt is too long: 250000 tokens > 200000 maximum", "Rate limit reached", "Invalid API key", "The model `x` does not exist"]) {
    assert.equal(promptCache.mayBeAboutMarks(msg), false, msg)
  }
  for (const msg of ["Invalid request", "Bad Request", "Extra inputs are not permitted", "Unrecognized request argument supplied: cache_control"]) {
    assert.equal(promptCache.mayBeAboutMarks(msg), true, msg)
  }

  console.log("PASS borrowed ideas: Always allow remembers safe command families, typographic edit matching, final-step note keeps the cached prefix, OpenAI-compatible cache marks")
})().catch((e) => { console.error(e); process.exit(1) })
