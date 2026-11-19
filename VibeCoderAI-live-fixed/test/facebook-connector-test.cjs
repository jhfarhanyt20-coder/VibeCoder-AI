"use strict"
// Facebook connector: one-click sign-in through the website, the user's own
// account, page tokens, and "ask first" for anything public, paid or deleting.
// Facebook itself is faked; nothing leaves this machine.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createFacebook } = require("../core/connectors/facebook")
const store = require("../core/connectors/store")
const fbTools = require("../core/tools/facebook")
const { decide, DEFAULT_RULES } = require("../core/perm/rules")
const { createVibe } = require("../sdk")

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const T = (n) => fbTools.ALL.find((t) => t.name === n)
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-fb-"))
const SITE = "https://site.test"

function fakeFacebook({ web = true } = {}) {
  const calls = []
  let claims = 0
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const fetch = async (url, opts = {}) => {
    const method = opts.method || "GET"
    calls.push({ url, method, body: opts.body || "" })
    if (url === `${SITE}/api/connectors`) return ok({ facebook: { web } })
    if (url === `${SITE}/connect/facebook/claim`) return ++claims < 2 ? ok({ pending: true }) : ok({ token: "EAAuser", expiresIn: 5184000 })
    const u = new URL(url)
    const p = u.pathname.replace(/^\/v[\d.]+/, "")
    if (p === "/me") return ok({ id: "100", name: "Jamil Hussain" })
    if (p === "/me/accounts") return ok({ data: [{ id: "555", name: "Vibe Shop", category: "Shopping", followers_count: 1200, tasks: ["CREATE_CONTENT", "MODERATE", "ADVERTISE"] }] })
    if (p === "/555" && method === "GET") return ok({ id: "555", name: "Vibe Shop", access_token: "EAApage" })
    if (p === "/555/feed" && method === "POST") return ok({ id: "555_9" })
    if (p === "/me/adaccounts") return ok({ data: [{ id: "act_77", name: "Main ads", currency: "USD", account_status: 1, amount_spent: "1200" }] })
    if (p === "/act_77/campaigns" && method === "POST") return ok({ id: "c1" })
    return { ok: false, status: 400, json: async () => ({ error: { message: "Unsupported", code: 100 } }) }
  }
  return { fetch, calls }
}

test("sign-in opens the website link (no code), claims the token and saves the user's own account", async () => {
  const fake = fakeFacebook()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const st = await fb.connect()
  assert.equal(st.pending.userCode, null)
  assert.match(st.pending.verificationUri, /^https:\/\/site\.test\/connect\/facebook\/start\?claim=[A-Za-z0-9_-]{43}$/)
  assert.equal((await fb.poll()).connected, false)
  const done = await fb.poll()
  assert.equal(done.connected, true)
  assert.equal(done.account.name, "Jamil Hussain")
  assert.equal(store.token("facebook", home), "EAAuser")
  assert(!JSON.stringify(done).includes("EAAuser"), "status never exposes the token")
})

test("without the website setup, sign-in says so instead of hanging", async () => {
  const fb = createFacebook({ home: fs.mkdtempSync(path.join(os.tmpdir(), "vc-fb2-")), fetch: fakeFacebook({ web: false }).fetch, setTimer: () => null, accountUrl: SITE, available: true })
  await assert.rejects(fb.connect(), /not available/)
})

test("tools read pages and ad accounts; posting uses the Page's own token", async () => {
  const fake = fakeFacebook()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  assert.match(await T("facebook_pages").run({}, ctx), /555 · Vibe Shop · Shopping · 1200 followers/)
  assert.match(await T("facebook_ad_accounts").run({}, ctx), /act_77 · Main ads · USD/)
  assert.match(await T("facebook_create_post").run({ page: "555", message: "Hello" }, ctx), /unpublished draft/)
  const post = fake.calls.find((c) => c.url.includes("/555/feed"))
  assert.match(post.url, /access_token=EAApage/, "posts as the Page")
  assert.match(post.body, /published=false/)
})

test("publishing, messaging, spending and generic writes always ask; a 'no' changes nothing", async () => {
  const fake = fakeFacebook()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const asks = []
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async (p) => { asks.push(p); return false } }
  await assert.rejects(T("facebook_create_post").run({ page: "555", message: "Big sale!", publish: true }, ctx), /did not allow/)
  await assert.rejects(T("facebook_send_message").run({ page: "555", recipient_id: "9", text: "hi" }, ctx), /did not allow/)
  await assert.rejects(T("facebook_reply_comment").run({ page: "555", comment_id: "555_1_2", message: "thanks" }, ctx), /did not allow/)
  await assert.rejects(T("facebook_create_campaign").run({ ad_account: "77", name: "Go", objective: "OUTCOME_TRAFFIC", status: "ACTIVE" }, ctx), /did not allow/)
  await assert.rejects(T("facebook_set_status").run({ id: "c1", status: "ACTIVE" }, ctx), /did not allow/)
  await assert.rejects(T("facebook_api").run({ method: "POST", path: "/act_77/adsets", params: { name: "x" } }, ctx), /did not allow/)
  assert(asks.length === 6 && asks.every((a) => a.critical === true), "every one was a critical ask")
  assert.equal(fake.calls.filter((c) => c.method === "POST").length, 0, "nothing was sent to Facebook")
  // a paused campaign without a budget spends nothing: no critical ask
  const ok = { engine: { connectors: { facebook: fb } }, askPermission: async () => { throw new Error("should not ask") } }
  assert.match(await T("facebook_create_campaign").run({ ad_account: "77", name: "Draft", objective: "OUTCOME_TRAFFIC" }, ok), /Created campaign c1 \(PAUSED\)/)
})

test("deleting the account is impossible; reading needs no permission", async () => {
  const fb = createFacebook({ home, fetch: fakeFacebook().fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/me" }, ctx), /not allowed/)
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/100" }, ctx), /not allowed/)
  assert.equal(decide(DEFAULT_RULES, "facebook", "read pages"), "allow")
  assert.equal(decide(DEFAULT_RULES, "facebook", "write post 555"), "ask")
})

test("coming soon: sign-in is closed for users and says so", async () => {
  const fb = createFacebook({ home: fs.mkdtempSync(path.join(os.tmpdir(), "vc-fb3-")), fetch: fakeFacebook().fetch, setTimer: () => null, accountUrl: SITE, available: false })
  assert.equal(fb.status().comingSoon, true)
  await assert.rejects(fb.connect(), /coming soon/i)
})

test("the agent gets Facebook tools only while signed in", async () => {
  const vibe = createVibe({ home, permission: "ask" })
  const names = () => vibe.engine.extraTools(home).map((t) => t.name).filter((n) => n.startsWith("facebook_"))
  assert.equal(names().length, fbTools.ALL.length)
  vibe.engine.connectors.facebook.disconnect()
  assert.deepEqual(names(), [])
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS facebook connector: ${t.name}`) }
    catch (e) { console.error(`FAIL facebook connector: ${t.name}`); console.error(e); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} facebook connector tests passed`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  if (passed !== tests.length) process.exit(1)
})()
