"use strict"
// GitHub connector: device-flow sign-in, encrypted storage, tools, permissions.
// GitHub itself is faked; nothing leaves this machine.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createGitHub } = require("../core/connectors/github")
const store = require("../core/connectors/store")
const ghTools = require("../core/tools/github")
const { decide, DEFAULT_RULES } = require("../core/perm/rules")
const { createVibe } = require("../sdk")

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const T = (n) => ghTools.ALL.find((t) => t.name === n)
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-gh-"))

function fakeGitHub({ pendingPolls = 1 } = {}) {
  const calls = []
  let polls = 0
  const files = { "README.md": "hello" }
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null
    calls.push({ url, method: opts.method || "GET", body, auth: opts.headers && opts.headers.Authorization })
    if (url.endsWith("/login/device/code")) return json(200, { device_code: "dev123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 })
    if (url.endsWith("/login/oauth/access_token")) return ++polls <= pendingPolls ? json(200, { error: "authorization_pending" }) : json(200, { access_token: "gho_secret_token", scope: "repo" })
    if (url.endsWith("/user")) return json(200, { login: "jamil", name: "Jamil", avatar_url: "https://x/a.png" })
    if (url.includes("/user/repos")) return json(200, [{ full_name: "jamil/app", private: true, default_branch: "main", updated_at: "2026-11-01T00:00:00Z", description: "My app" }])
    if (/\/repos\/jamil\/app$/.test(url)) return json(200, { default_branch: "main" })
    if (url.includes("/contents/README.md") && (opts.method || "GET") === "GET") return json(200, { type: "file", path: "README.md", sha: "abc123", size: 5, content: Buffer.from(files["README.md"]).toString("base64") })
    if (url.includes("/contents/") && opts.method === "PUT") return json(200, { commit: { sha: "def4567890" } })
    if (url.includes("/contents/")) return json(404, { message: "Not Found" })
    if (url.includes("/pulls/3/merge")) return json(200, { merged: true, sha: "9999999" })
    return json(404, { message: "Not Found" })
  }
  return { fetch, calls }
}

test("sign-in: code shown, waits while pending, then saves the account encrypted", async () => {
  const fake = fakeGitHub({ pendingPolls: 1 })
  const changes = []
  const gh = createGitHub({ home, fetch: fake.fetch, setTimer: () => null, onChange: (s) => changes.push(s) })
  const started = await gh.connect()
  assert.equal(started.pending.userCode, "ABCD-1234")
  assert.equal(started.connected, false)
  assert.equal((await gh.poll()).connected, false, "still waiting for Authorize")
  const done = await gh.poll()
  assert.equal(done.connected, true)
  assert.equal(done.account.login, "jamil")
  const raw = fs.readFileSync(store.file(home), "utf8")
  assert(!raw.includes("gho_secret_token") || process.platform !== "win32", "token is not stored in plain text on Windows")
  assert.equal(store.token("github", home), "gho_secret_token")
  assert(!JSON.stringify(done).includes("gho_secret_token"), "status never exposes the token")
  assert(changes.length >= 2)
})

test("one-click sign-in through the website: no code, browser link, token claimed with the secret", async () => {
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "vc-gh-web-"))
  let claims = 0
  let sentSecret = null
  const fetch = async (url, opts = {}) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    if (url === "https://site.test/api/connectors") return ok({ github: { web: true } })
    if (url === "https://site.test/connect/github/claim") { sentSecret = JSON.parse(opts.body).secret; return ++claims < 2 ? ok({ pending: true }) : ok({ token: "gho_web", scope: "repo" }) }
    if (url.endsWith("/user")) return ok({ login: "jamil" })
    return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" }
  }
  const gh = createGitHub({ home: home2, fetch, setTimer: () => null, accountUrl: "https://site.test" })
  const st = await gh.connect()
  assert.equal(st.pending.mode, "web")
  assert.equal(st.pending.userCode, null, "no code to type")
  assert.match(st.pending.verificationUri, /^https:\/\/site\.test\/connect\/github\/start\?claim=[A-Za-z0-9_-]{43}$/)
  assert.equal((await gh.poll()).connected, false)
  const done = await gh.poll()
  assert.equal(done.connected, true)
  assert.equal(done.account.login, "jamil")
  assert(!st.pending.verificationUri.includes(sentSecret), "the link carries only the hash, never the secret")
  assert.equal(store.token("github", home2), "gho_web")
  fs.rmSync(home2, { recursive: true, force: true })
})

test("tools: list repos and read a file with the saved token", async () => {
  const fake = fakeGitHub()
  const gh = createGitHub({ home, fetch: fake.fetch, setTimer: () => null })
  const ctx = { engine: { connectors: { github: gh } }, askPermission: async () => true }
  assert.match(await T("github_repos").run({}, ctx), /jamil\/app \(private\) · default main/)
  assert.match(await T("github_files").run({ repo: "jamil/app", path: "README.md" }, ctx), /1\thello/)
  assert(fake.calls.some((c) => c.auth === "Bearer gho_secret_token"))
  await assert.rejects(T("github_files").run({ repo: "not a repo" }, ctx), /owner\/name/)
})

test("writing to the default branch and merging always ask (critical); a work branch does not", async () => {
  const fake = fakeGitHub()
  const gh = createGitHub({ home, fetch: fake.fetch, setTimer: () => null })
  const asks = []
  const ctx = { engine: { connectors: { github: gh } }, askPermission: async (p) => { asks.push(p); return false } }
  await assert.rejects(T("github_write_file").run({ repo: "jamil/app", path: "a.txt", content: "x", message: "add" }, ctx), /did not allow/)
  assert.equal(asks[0].critical, true)
  assert.equal(fake.calls.some((c) => c.method === "PUT"), false, "nothing was written")
  assert.match(await T("github_write_file").run({ repo: "jamil/app", path: "a.txt", content: "x", message: "add", branch: "work" }, ctx), /Created a\.txt on work/)
  await assert.rejects(T("github_merge_pr").run({ repo: "jamil/app", number: 3 }, ctx), /did not allow/)
  await assert.rejects(T("github_api").run({ method: "DELETE", path: "/repos/jamil/app" }, ctx), /did not allow/)
})

test("permissions: reading is allowed, changes ask by default", () => {
  assert.equal(decide(DEFAULT_RULES, "github", "read jamil/app"), "allow")
  assert.equal(decide(DEFAULT_RULES, "github", "read repos"), "allow")
  assert.equal(decide(DEFAULT_RULES, "github", "write issue jamil/app"), "ask")
})

test("the agent gets GitHub tools only while signed in; disconnect removes the account", async () => {
  const vibe = createVibe({ home, permission: "ask" })
  const names = () => vibe.engine.extraTools(home).map((t) => t.name).filter((n) => n.startsWith("github_"))
  assert.equal(names().length, ghTools.ALL.length)
  vibe.engine.connectors.github.disconnect()
  assert.deepEqual(names(), [])
  await assert.rejects(T("github_repos").run({}, { engine: vibe.engine }), /not connected/)
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS github connector: ${t.name}`) }
    catch (e) { console.error(`FAIL github connector: ${t.name}`); console.error(e); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} github connector tests passed`)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
  if (passed !== tests.length) process.exit(1)
})()
