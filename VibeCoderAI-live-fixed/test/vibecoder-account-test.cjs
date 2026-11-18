"use strict"
// "Sign in with VibeCoder": device-code sign-in, token storage, model sync and sign-out.
const assert = require("node:assert/strict")
const { createVibecoderAccount, profileFromModels, accountBaseUrl } = require("../electron/vibecoder-account.cjs")

const BASE = "https://vibecoderai.onrender.com"
const GW = "https://gateway.example.test"
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })

const MODELS = [
  { id: "vibecoder/free", name: "Auto (best available)", context_length: 1048576, free: true, tags: ["Auto"], capabilities: { tools: true, images: true } },
  { id: "vibecoder/free-10", name: "NVIDIA Nemotron 3 Ultra", context_length: 1000000, max_output_tokens: 65536, free: true, tags: ["Pro", "1M context"], capabilities: { tools: true, images: false } },
  { id: "vibecoder/free-72", name: "Agnes 3.0 Flash", context_length: 512000, max_output_tokens: 65536, free: true, tags: ["Coding", "Fast", "Vision"], capabilities: { tools: true, images: true } },
]

function harness({ deny = false, revoked = false } = {}) {
  let clock = 1_000_000
  const timers = []
  const calls = []
  const opened = []
  const events = []
  let stored = ""
  let profile = null
  let polls = 0
  const fetch = async (url, init = {}) => {
    const host = url.startsWith(GW) ? "gw" : "site"
    const path = url.replace(BASE, "").replace(GW, "")
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ host, path, method: init.method || "GET", auth: init.headers?.Authorization || "", body })
    if (path === "/api/device/code") return json({ device_code: "d".repeat(43), user_code: "BCDF-GHJK", verification_uri_complete: `${BASE}/connect?code=BCDF-GHJK`, expires_in: 600, interval: 5 })
    if (path === "/api/device/token") {
      polls++
      if (polls === 1) return json({ error: "authorization_pending" }, 400)
      if (deny) return json({ error: "access_denied" }, 400)
      return json({ access_token: "vc_" + "t".repeat(43), token_type: "bearer", base_url: `${BASE}/v1` })
    }
    if (path === "/v1/models") return revoked ? json({ error: { message: "nope" } }, 401) : json({ object: "list", data: MODELS })
    if (path === "/v1/account") return revoked ? json({ error: {} }, 401) : json({ email: "person@example.test", name: "Test Person", plan: "free", dailyLimit: 100, usage: { requests: 3 } })
    if (path === "/v1/account/logout") return json({ ok: true })
    throw new Error(`unexpected ${path}`)
  }
  const account = createVibecoderAccount({
    fetch, baseUrl: BASE, gatewayUrl: GW, now: () => clock,
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms, unref() {} }; timers.push(t); return t },
    openExternal: async (url) => { opened.push(url) },
    emit: (type, data) => events.push({ type, data }),
    deviceName: "VibeCoder on TEST-PC",
    keys: { get: () => stored, set: (v) => { stored = v }, clear: () => { stored = "" } },
    profiles: { exists: () => !!profile, upsert: (p) => { profile = p }, remove: () => { profile = null } },
  })
  const tick = async (ms) => {
    clock += ms
    for (const t of timers.splice(0)) { if (t.at <= clock) await t.fn(); else timers.push(t) }
    await new Promise((r) => setImmediate(r))
  }
  return { account, calls, opened, events, tick, stored: () => stored, profile: () => profile, setStored: (v) => { stored = v } }
}

test("sign-in opens the browser with the code and finishes after Allow", async () => {
  const h = harness()
  const start = await h.account.connect()
  assert.equal(start.code, "BCDF-GHJK")
  assert.deepEqual(h.opened, [`${BASE}/connect?code=BCDF-GHJK`], "the browser opens the connect page directly")
  assert.equal(h.calls[0].body.device_name, "VibeCoder on TEST-PC")
  const waiting = await h.account.status()
  assert.equal(waiting.connected, false)
  assert.equal(waiting.pending.code, "BCDF-GHJK", "the app can show the code while waiting")
  await h.tick(5000) // authorization_pending
  assert.equal(h.stored(), "")
  await h.tick(5000) // approved
  assert.match(h.stored(), /^vc_t{43}$/, "the token is stored with the provider keys")
  const p = h.profile()
  assert.equal(p.id, "vibecoder")
  assert.equal(p.name, "VibeCoder AI")
  assert.equal(p.baseURL, `${GW}/v1`, "chat goes to the gateway host")
  assert.ok(h.calls.filter((c) => c.path === "/v1/models").every((c) => c.host === "gw"), "model list from the gateway")
  assert.ok(h.calls.filter((c) => c.path.startsWith("/api/device") || c.path.startsWith("/v1/account")).every((c) => c.host === "site"), "sign-in and account stay on the website")
  assert.equal(p.format, "openai-chat")
  assert.equal(p.model, "vibecoder/free")
  assert.deepEqual(p.models.map((m) => m.name), ["Auto (best available)", "NVIDIA Nemotron 3 Ultra", "Agnes 3.0 Flash"])
  assert.equal(p.models[1].image, false)
  assert.equal(p.models[2].image, true)
  assert.equal(p.models[2].free, true)
  assert.ok(h.events.some((e) => e.type === "auth.changed" && e.data.connected === true))
  const s = await h.account.status({ fresh: true })
  assert.equal(s.connected, true)
  assert.equal(s.email, "person@example.test")
  assert.equal(s.usage.requests, 3)
  assert.equal(s.dailyLimit, 100)
  assert.ok(h.calls.filter((c) => c.path.startsWith("/v1/")).every((c) => c.auth === "Bearer vc_" + "t".repeat(43)))
})

test("a gateway named by the website is used; the website naming itself keeps the built-in gateway", async () => {
  const { createVibecoderAccount: create } = require("../electron/vibecoder-account.cjs")
  for (const [announced, expected] of [["https://other-gateway.example.test", "https://other-gateway.example.test"], [BASE, GW], ["http://evil.example", GW]]) {
    let profile = null
    const acct = create({
      baseUrl: BASE, gatewayUrl: GW, openExternal: async () => {}, emit: () => {},
      keys: { get: () => "vc_" + "t".repeat(43), set() {}, clear() {} },
      profiles: { exists: () => !!profile, upsert: (p) => { profile = p }, remove() {} },
      fetch: async (url) => url.endsWith("/v1/account") ? json({ email: "a@b.c", gateway_url: announced }) : json({ data: MODELS }),
    })
    await acct.syncModels()
    assert.equal(profile.baseURL, `${expected}/v1`, `announced ${announced}`)
  }
})

test("clicking again while waiting reopens the same page instead of a new code", async () => {
  const h = harness()
  await h.account.connect()
  await h.account.connect()
  assert.equal(h.calls.filter((c) => c.path === "/api/device/code").length, 1)
  assert.equal(h.opened.length, 2)
})

test("denied sign-in stops waiting and explains why", async () => {
  const h = harness({ deny: true })
  await h.account.connect()
  await h.tick(5000)
  await h.tick(5000)
  const s = await h.account.status()
  assert.equal(s.connected, false)
  assert.equal(s.pending, null)
  assert.match(s.error, /denied/)
  assert.equal(h.stored(), "")
})

test("an expired code stops waiting", async () => {
  const h = harness()
  await h.account.connect()
  await h.tick(601000)
  const s = await h.account.status()
  assert.equal(s.pending, null)
  assert.match(s.error, /expired/)
})

test("sign-out revokes the token on the website and removes the provider", async () => {
  const h = harness()
  await h.account.connect(); await h.tick(5000); await h.tick(5000)
  assert.ok(h.profile())
  const out = await h.account.disconnect()
  assert.equal(out.disconnected, true)
  assert.ok(h.calls.some((c) => c.path === "/v1/account/logout" && c.auth.startsWith("Bearer vc_")))
  assert.equal(h.stored(), "")
  assert.equal(h.profile(), null)
  assert.equal((await h.account.status()).connected, false)
})

test("a token disconnected on the website signs the app out cleanly", async () => {
  const h = harness({ revoked: true })
  h.setStored("vc_" + "r".repeat(43))
  const s = await h.account.status({ fresh: true })
  assert.equal(s.connected, false)
  assert.match(s.error, /disconnected/)
  assert.equal(h.stored(), "")
  const sync = await h.account.syncModels()
  assert.equal(sync.synced, false)
})

test("profile mapping and safe base URL", () => {
  assert.equal(profileFromModels(BASE, []), null)
  const p = profileFromModels(BASE, MODELS)
  assert.equal(p.models.length, 3)
  assert.equal(p.contextLimit, 1048576)
  assert.equal(accountBaseUrl({}), BASE)
  assert.equal(accountBaseUrl({ VIBECODER_ACCOUNT_URL: "http://localhost:4198/" }), "http://localhost:4198")
  assert.equal(accountBaseUrl({ VIBECODER_ACCOUNT_URL: "http://evil.example" }), BASE, "plain HTTP is only allowed for localhost")
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS vibecoder account: ${t.name}`) }
    catch (e) { console.error(`FAIL vibecoder account: ${t.name}`); console.error(e); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} vibecoder account tests passed`)
  if (passed !== tests.length) process.exit(1)
})()
