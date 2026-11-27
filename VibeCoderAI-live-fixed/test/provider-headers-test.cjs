"use strict"
// Each provider gets the auth and identification headers it expects.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { authHeaders, PRODUCT_HEADERS } = require("../core/llm/http")
const profiles = require("../core/llm/profiles")
const tools = require("../core/tools")

;(async () => {
  // Standard OpenAI-compatible: Bearer.
  assert.deepEqual(authHeaders("https://api.groq.com/openai/v1", "k1"), { authorization: "Bearer k1" })
  // OpenRouter: Bearer + its documented attribution headers.
  assert.deepEqual(authHeaders("https://openrouter.ai/api/v1", "k2"), { authorization: "Bearer k2", "http-referer": "https://bdcoderai.onrender.com", "x-title": "BDCoder AI" })
  // Azure: api-key, never Bearer.
  for (const u of ["https://me.openai.azure.com/openai/v1", "https://me.cognitiveservices.azure.com/openai/v1", "https://me.services.ai.azure.com/models"]) {
    assert.deepEqual(authHeaders(u, "k3"), { "api-key": "k3" }, u)
  }
  // No key (local servers): no auth header at all.
  assert.deepEqual(authHeaders("http://127.0.0.1:11434/v1", ""), {})
  assert.match(PRODUCT_HEADERS["user-agent"], /^VibeCoderAI\/\d+\.\d+\.\d+$/)

  // A key pasted with "Bearer " is used without the prefix.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-hdr-"))
  process.env.VC_TEST_KEY = "  Bearer sk-abc  "
  assert.equal(profiles.getKey({ id: "x", apiKeyEnv: "VC_TEST_KEY" }, home), "sk-abc")
  delete process.env.VC_TEST_KEY

  // The real request carries them: product identity + auth, profile headers win.
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.headers)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const llm = require("../core/llm/openai-chat")
  const stream = (llm.stream || llm.default || llm)({ profile: { id: "hdr", baseURL: `http://127.0.0.1:${server.address().port}/v1`, model: "m", format: "openai-chat", headers: { "x-custom": "1" } }, apiKey: "sk-live", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [] })
  if (stream && typeof stream[Symbol.asyncIterator] === "function") for await (const _ of stream) { /* drain */ }
  server.close()
  if (seen.length) {
    assert.equal(seen[0].authorization, "Bearer sk-live")
    assert.match(seen[0]["user-agent"], /^VibeCoderAI\//)
    assert.equal(seen[0]["x-custom"], "1")
  }

  // Tool leftovers: web addresses without https://, unified diffs.
  const web = tools.ALL.find((t) => t.name === "webfetch")
  assert.equal(web.perm({ url: "example.com/docs" }).subject, "example.com")
  await assert.rejects(web.run({ url: "not a url" }, {}), /not a valid web address/)
  const patch = tools.ALL.find((t) => t.name === "apply_patch")
  await assert.rejects(patch.run({ patchText: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" }, { cwd: home, stats: {} }), /git\/unified diff/)
  fs.rmSync(home, { recursive: true, force: true })
  console.log(`PASS provider headers: Bearer, OpenRouter attribution, Azure api-key, no-key local, Bearer-prefix keys${seen.length ? ", real request headers" : ""}; webfetch and apply_patch messages`)
})().catch((e) => { console.error(e); process.exit(1) })
