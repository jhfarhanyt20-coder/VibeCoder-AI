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

test("video upload: a Reel goes start → bytes → finish with the Page token; a normal video is one multipart upload; public always asks", async () => {
  const calls = []
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const base = fakeFacebook().fetch
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts })
    const u = new URL(url)
    const p = u.pathname.replace(/^\/v[\d.]+/, "")
    if (p === "/555/video_reels" && JSON.parse(String(opts.body || "{}").startsWith("{") ? opts.body : "{}").upload_phase === "start") return ok({ video_id: "v77", upload_url: "https://rupload.facebook.com/video-upload/v21.0/v77" })
    if (u.host === "rupload.facebook.com") return ok({ success: true })
    if (p === "/555/video_reels") return ok({ success: true })
    if (u.host === "graph-video.facebook.com" && p === "/555/videos") return ok({ id: "v88" })
    if (p === "/v77") return ok({ status: { video_status: "ready", processing_phase: { status: "complete" } }, permalink_url: "/reel/v77" })
    return base(url, opts)
  }
  const fb = createFacebook({ home, fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-fbv-"))
  fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.alloc(4096, 7))
  const asks = []
  const ctx = { cwd: dir, engine: { connectors: { facebook: fb } }, askPermission: async (q) => { asks.push(q); return true } }

  // Draft Reel: no critical ask, three steps, bytes with the Page token.
  assert.match(await T("facebook_upload_video").run({ page: "555", file: "clip.mp4", reel: true, description: "New shop video" }, ctx), /Reel uploaded: v77 \(unpublished draft\)/)
  assert.equal(asks.length, 0)
  const start = calls.find((c) => c.url.includes("/555/video_reels") && String(c.opts.body).includes("start"))
  assert.equal(JSON.parse(start.opts.body).access_token, "EAApage")
  const bytes = calls.find((c) => c.url.startsWith("https://rupload.facebook.com/"))
  assert.equal(bytes.opts.headers.Authorization, "OAuth EAApage")
  assert.equal(bytes.opts.headers.file_size, "4096")
  assert.equal(bytes.opts.headers.offset, "0")
  const finish = calls.filter((c) => c.url.includes("/555/video_reels")).pop()
  assert.match(String(finish.opts.body), /upload_phase=finish/)
  assert.match(String(finish.opts.body), /video_state=DRAFT/)
  assert.match(String(finish.opts.body), /description=New\+shop\+video/)

  // Publish a normal video: one critical ask, multipart to graph-video.
  assert.match(await T("facebook_upload_video").run({ page: "555", file: "clip.mp4", title: "Hi", publish: true }, ctx), /Video uploaded: v88 \(published/)
  assert.equal(asks.length, 1)
  assert.equal(asks[0].critical, true)
  const multi = calls.find((c) => c.url.startsWith("https://graph-video.facebook.com/"))
  assert(multi.opts.body instanceof FormData)
  assert.equal(multi.opts.body.get("published"), "true")
  assert.equal(multi.opts.body.get("access_token"), "EAApage")

  // Saying no publishes nothing; a non-video file or a missing file is refused.
  const before = calls.length
  const no = { cwd: dir, engine: { connectors: { facebook: fb } }, askPermission: async () => false }
  await assert.rejects(T("facebook_upload_video").run({ page: "555", file: "clip.mp4", reel: true, publish: true }, no), /did not allow/)
  assert.equal(calls.length, before, "nothing sent after a no")
  await assert.rejects(T("facebook_upload_video").run({ page: "555", file: "notes.txt" }, ctx), /must be an \.mp4/)
  await assert.rejects(T("facebook_upload_video").run({ page: "555", file: "missing.mp4" }, ctx), /ENOENT|no such file/i)
  // The path goes through the workspace check.
  assert.deepEqual(T("facebook_upload_video").paths({ file: "clip.mp4" }, ctx), [path.join(dir, "clip.mp4")])
  assert.match(await T("facebook_video_status").run({ page: "555", video_id: "v77" }, ctx), /Video v77: ready[\s\S]*processing: complete[\s\S]*facebook\.com\/reel\/v77/)
  assert.equal(decide(DEFAULT_RULES, "facebook", "read video"), "allow")
  fs.rmSync(dir, { recursive: true, force: true })
})

test("full Page control: edit, delete, hide comments, photos, Page info, late Messenger replies — each asks first, the Page itself is never deleted", async () => {
  const calls = []
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const base = fakeFacebook().fetch
  let messengerWindowOpen = false
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts, method: opts.method || "GET" })
    const u = new URL(url)
    const p = u.pathname.replace(/^\/v[\d.]+/, "")
    const body = typeof opts.body === "string" ? opts.body : ""
    if (p === "/555/messages") {
      if (/messaging_type=RESPONSE/.test(body) && !messengerWindowOpen) return { ok: false, status: 400, json: async () => ({ error: { message: "(#10) This message is sent outside of allowed window.", code: 10 } }) }
      return ok({ message_id: "m.1" })
    }
    if (p === "/555_9" || p === "/555_1_2" || p === "/555" && opts.method === "POST") return ok({ success: true })
    if (p === "/555/photos") return ok({ id: "ph1", post_id: "555_77" })
    if (opts.method === "DELETE" && p === "/555_9") return ok({ success: true })
    return base(url, opts)
  }
  const fb = createFacebook({ home, fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-fbp-"))
  fs.writeFileSync(path.join(dir, "cover.png"), Buffer.alloc(2048, 3))
  const asks = []
  const ctx = { cwd: dir, engine: { connectors: { facebook: fb } }, askPermission: async (q) => { asks.push(q); return true } }

  assert.match(await T("facebook_edit_post").run({ page: "555", post_id: "555_9", message: "New text" }, ctx), /Post 555_9 updated/)
  assert.match(await T("facebook_delete").run({ page: "555", id: "555_9", what: "post" }, ctx), /Deleted post 555_9/)
  assert.equal(calls.find((c) => c.method === "DELETE").url.includes("access_token=EAApage"), true, "deletes as the Page")
  await assert.rejects(T("facebook_delete").run({ page: "555", id: "555" }, ctx), /cannot be deleted/)
  assert.match(await T("facebook_hide_comment").run({ page: "555", comment_id: "555_1_2" }, ctx), /hidden/)
  assert.match(String(calls.find((c) => c.url.includes("/555_1_2")).opts.body), /is_hidden=true/)
  assert.match(await T("facebook_upload_photo").run({ page: "555", file: "cover.png", caption: "Sale", publish: true }, ctx), /Photo uploaded: ph1 \(post 555_77\), published/)
  assert.equal(calls.find((c) => c.url.includes("/555/photos")).opts.body.get("published"), "true")
  await assert.rejects(T("facebook_upload_photo").run({ page: "555", file: "notes.txt" }, ctx), /must be a \.jpg/)
  assert.match(await T("facebook_update_page").run({ page: "555", about: "Clothes for everyone", phone: "+880 1700" }, ctx), /updated: about, phone/)
  await assert.rejects(T("facebook_update_page").run({ page: "555" }, ctx), /at least one field/)

  // Messenger: outside 24 h a normal reply fails with a clear way forward; the Human Agent tag works.
  await assert.rejects(T("facebook_send_message").run({ page: "555", recipient_id: "9", text: "Sorry for the wait" }, ctx), /human_agent=true/)
  assert.match(await T("facebook_send_message").run({ page: "555", recipient_id: "9", text: "Sorry for the wait", human_agent: true }, ctx), /Message sent \(m\.1\)/)
  assert.match(String(calls.filter((c) => c.url.includes("/555/messages")).pop().opts.body), /messaging_type=MESSAGE_TAG[\s\S]*tag=HUMAN_AGENT|tag=HUMAN_AGENT[\s\S]*messaging_type=MESSAGE_TAG/)

  // Every change asked, as a critical question; a "no" sends nothing.
  assert.equal(asks.length, 7, "edit, delete, hide, photo, page info and two message tries each asked once")
  assert(asks.every((q) => q.critical === true))
  const before = calls.length
  const no = { cwd: dir, engine: { connectors: { facebook: fb } }, askPermission: async () => false }
  await assert.rejects(T("facebook_delete").run({ page: "555", id: "555_9" }, no), /did not allow/)
  await assert.rejects(T("facebook_edit_post").run({ page: "555", post_id: "555_9", message: "x" }, no), /did not allow/)
  assert.equal(calls.length, before)
  assert.deepEqual(T("facebook_upload_photo").paths({ file: "cover.png" }, ctx), [path.join(dir, "cover.png")])
  fs.rmSync(dir, { recursive: true, force: true })
})

// A fake with extra endpoints for the review fixes; falls back to fakeFacebook.
function fakeMore() {
  const calls = []
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  const bad = (code, message) => ({ ok: false, status: 400, json: async () => ({ error: { message, code } }) })
  const base = fakeFacebook().fetch
  const fetch = async (url, opts = {}) => {
    const method = opts.method || "GET"
    const u = new URL(url)
    const p = u.pathname.replace(/^\/v[\d.]+/, "")
    calls.push({ url, method, p, q: u.searchParams })
    if (p === "/me/accounts" && u.searchParams.get("fields") === "access_token,name") return ok({ data: [{ id: "555", name: "Vibe Shop", access_token: "EAApage" }], paging: { cursors: { after: "x" } }, nested: { client_secret: "s3cret", password: "pw", ok: "visible" } })
    if (p === "/act_77" && method === "GET") return ok({ id: "act_77", currency: "USD" })
    if (p === "/act_77/campaigns" && method === "GET") return ok({ data: [{ id: "c9", name: "Spring", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "500", lifetime_budget: "12000", insights: { data: [{ spend: "3.10", impressions: "100", clicks: "4" }] } }] })
    if (p === "/123456" && method === "DELETE") return ok({ success: true })
    if (p === "/555/insights") {
      const m = u.searchParams.get("metric")
      if (m === "page_follows") return bad(100, "(#100) The value must be a valid insights metric")
      if (/page_fans|post_engaged_users/.test(m)) return bad(100, "(#100) The value must be a valid insights metric")
      if (m.includes(",") && m.includes("page_follows")) return bad(100, "(#100) The value must be a valid insights metric")
      return ok({ data: m.split(",").map((name) => ({ name, period: "days_28", values: [{ value: 42 }] })) })
    }
    if (p === "/555_9/comments") return ok({ data: [{ id: "555_9_1", from: { name: "Rafi" }, message: "Nice", created_time: "2026-11-20T10:00:00", like_count: 1 }] })
    if (p === "/777_888/comments") return ok({ data: [{ id: "777_888_2", from: { name: "Mina" }, message: "Reply", created_time: "2026-11-20T11:00:00" }] })
    return base(url, opts)
  }
  return { fetch, calls }
}

test("fix 1: tokens and secrets in raw API answers are hidden from the model", async () => {
  const fb = createFacebook({ home, fetch: fakeMore().fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  const r = await T("facebook_api").run({ method: "GET", path: "/me/accounts", params: { fields: "access_token,name" } }, ctx)
  assert(!r.includes("EAApage") && !r.includes("s3cret") && !r.includes("\"pw\""), r)
  assert.match(r, /"access_token": "\[hidden\]"/)
  assert.match(r, /"client_secret": "\[hidden\]"/)
  assert.match(r, /"ok": "visible"/)
  assert.match(r, /"name": "Vibe Shop"/)
})

test("fix 3: ad money is shown with the currency, account status in words", async () => {
  const fake = fakeMore()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  const acc = await T("facebook_ad_accounts").run({}, ctx)
  assert.match(acc, /status ACTIVE \(1\)/)
  assert.match(acc, /spent 1200 \(= 12\.00 USD\)/)
  assert.match(fake.calls.find((c) => c.p === "/me/adaccounts").q.get("fields"), /spend_cap/)
  const ads = await T("facebook_ads").run({ ad_account: "77" }, ctx)
  assert.match(ads, /daily budget 500 \(= 5\.00 USD\)/)
  assert.match(ads, /lifetime budget 12000 \(= 120\.00 USD\)/)
  assert.match(ads, /spend 3\.10 USD/)
  assert.equal(fake.calls.find((c) => c.p === "/act_77").q.get("fields"), "currency")
})

test("fix 4: DELETE blocks only /me and the user's own id; ads/photos by numeric id can be deleted (asks)", async () => {
  const fake = fakeMore()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const asks = []
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async (q) => { asks.push(q); return true } }
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/me" }, ctx), /not allowed/)
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/100?x=1" }, ctx), /not allowed/)
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/100/" }, ctx), /not allowed/)
  assert.equal(asks.length, 0)
  assert.match(await T("facebook_api").run({ method: "DELETE", path: "/123456" }, ctx), /success/)
  assert.equal(asks.length, 1)
  assert.equal(asks[0].critical, true)
  assert(fake.calls.some((c) => c.p === "/123456" && c.method === "DELETE"))
  // Own id unknown: only /me is blocked, and the question says so.
  const stub = { connected: () => true, userId: async () => "", api: async () => ({ success: true }), asPage: async () => ({}) }
  const asks2 = []
  const ctx2 = { engine: { connectors: { facebook: stub } }, askPermission: async (q) => { asks2.push(q); return true } }
  await assert.rejects(T("facebook_api").run({ method: "DELETE", path: "/me" }, ctx2), /not allowed/)
  assert.match(await T("facebook_api").run({ method: "DELETE", path: "/100" }, ctx2), /success/)
  assert.match(asks2[0].subject, /only \/me is blocked/)
})

test("fix 5: insights use supported default metrics; a rejected metric (#100) says to pass metrics", async () => {
  const fake = fakeMore()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  const r = await T("facebook_insights").run({ id: "555" }, ctx)
  const first = fake.calls.find((c) => c.p === "/555/insights").q.get("metric")
  assert.match(first, /page_impressions_unique/)
  assert(!/page_fans|page_impressions,|post_engaged_users/.test(first), first)
  assert.match(r, /page_impressions_unique \(days_28\): 42/)
  assert.match(r, /page_post_engagements \(days_28\): 42/)
  assert.match(r, /Not available \(error #100\): page_follows[\s\S]*metrics explicitly/)
  await assert.rejects(T("facebook_insights").run({ id: "555", metrics: "page_fans" }, ctx), /rejected the metric list "page_fans"[\s\S]*Pass metrics explicitly/)
  assert.match(await T("facebook_insights").run({ id: "555", metric: "page_views_total" }, ctx), /page_views_total \(days_28\): 42/)
})

test("fix 6: comments take an optional page; a comment id without page suggests passing it", async () => {
  const fake = fakeMore()
  const fb = createFacebook({ home, fetch: fake.fetch, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { engine: { connectors: { facebook: fb } }, askPermission: async () => true }
  assert.match(await T("facebook_comments").run({ id: "555_9" }, ctx), /Rafi/)
  await assert.rejects(T("facebook_comments").run({ id: "777_888" }, ctx), /page=<Page id/)
  assert.match(await T("facebook_comments").run({ id: "777_888", page: "555" }, ctx), /Mina/)
  const call = fake.calls.filter((c) => c.p === "/777_888/comments").pop()
  assert.equal(call.q.get("access_token"), "EAApage", "reads as the given Page")
})

test("fix 7: Graph calls time out with a clear message and stop with the run", async () => {
  const hang = (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))
  const fb = createFacebook({ home, fetch: hang, setTimer: () => null, accountUrl: SITE, available: true, timeoutMs: 40 })
  await assert.rejects(fb.api("GET", "/me/adaccounts", {}), /timed out after 0\.04s\. Nothing was done/)
  await assert.rejects(fb.api("POST", "/act_77/campaigns", { name: "x" }), /timed out after 0\.04s\. It may or may not have been done/)
  const ctl = new AbortController()
  const slow = createFacebook({ home, fetch: hang, setTimer: () => null, accountUrl: SITE, available: true })
  const ctx = { signal: ctl.signal, engine: { connectors: { facebook: slow } }, askPermission: async () => true }
  setTimeout(() => ctl.abort(), 20)
  await assert.rejects(T("facebook_ad_accounts").run({}, ctx), /Stopped/)
  const { TIMEOUT_MS, UPLOAD_TIMEOUT_MS } = require("../core/connectors/facebook")
  assert.equal(TIMEOUT_MS, 30000)
  assert(UPLOAD_TIMEOUT_MS >= 10 * 60 * 1000)
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
