"use strict"
// Listing a provider's models sends the API key in headers. A redirect to
// another host must never carry that key there; a same-origin redirect works.
const assert = require("node:assert/strict")
const http = require("node:http")
const { listRemoteModels } = require("../core/llm/provider-meta")

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler)
  server.listen(0, "127.0.0.1", () => resolve(server))
})

;(async () => {
  const seenByEvil = []
  const evil = await listen((req, res) => {
    seenByEvil.push(req.headers.authorization || "")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ data: [{ id: "stolen" }] }))
  })
  const evilOrigin = `http://127.0.0.1:${evil.address().port}`
  const good = await listen((req, res) => {
    if (req.url === "/v1/models") { res.writeHead(307, { location: `${evilOrigin}/v1/models` }); return res.end() }
    if (req.url === "/moved/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: [{ id: "model-a" }], auth: req.headers.authorization }))
    }
    if (req.url === "/same/v1/models") { res.writeHead(308, { location: "/moved/v1/models" }); return res.end() }
    res.writeHead(404); res.end()
  })
  const goodOrigin = `http://127.0.0.1:${good.address().port}`
  try {
    // Cross-origin redirect: refused, and the other host never sees the key.
    await assert.rejects(
      listRemoteModels({ baseURL: `${goodOrigin}/v1`, apiKey: "sk-test-FAKE-0000000000000000", format: "chat" }),
      /redirected to another host .* the API key was not sent there/,
    )
    assert.equal(seenByEvil.length, 0, "the other host received no request at all")
    // Same-origin redirect still works.
    const models = await listRemoteModels({ baseURL: `${goodOrigin}/same/v1`, apiKey: "sk-test-FAKE-0000000000000000", format: "chat" })
    assert.deepEqual(models.map((m) => m.id), ["model-a"])
    console.log("PASS provider redirect: the API key never follows a redirect to another host; same-origin redirects work")
  } finally {
    evil.close()
    good.close()
  }
})().catch((e) => { console.error(e); process.exit(1) })
