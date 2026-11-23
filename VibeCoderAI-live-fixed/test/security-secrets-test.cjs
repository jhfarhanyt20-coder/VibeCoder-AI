"use strict"
// Security hardening: secret storage, redaction, provider endpoints, redirects,
// gateway allow-list, markdown URL guard, UNC file block, build + CI config.
// Uses FAKE values only. No network, no app start, no windows.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const vm = require("node:vm")

const ROOT = path.join(__dirname, "..")
const REPO = path.join(ROOT, "..")
const read = (...p) => fs.readFileSync(path.join(...p), "utf8").replace(/\r\n/g, "\n")
const tests = []
const test = (name, fn) => tests.push({ name, fn })

/* ---------- 1. DPAPI: no data in the PowerShell command line ---------- */
test("secrets: PowerShell scripts are constants and carry no item data", async () => {
  const secrets = require("../core/store/secrets")
  const { psArgs, stdinPayload, script } = secrets._internal
  const fake = "fake-vibe-test-" + "Q".repeat(24)
  const b64 = Buffer.from(fake, "utf8").toString("base64")
  for (const mode of ["protect", "unprotect"]) {
    const argv = psArgs(mode).join(" ")
    assert.ok(!argv.includes(fake) && !argv.includes(b64), `${mode} argv holds no data`)
    assert.ok(!/FromBase64String\('/.test(argv), `${mode} argv has no embedded base64 literal`)
    assert.match(script(mode), /\[Console\]::In\.ReadLine\(\)/, `${mode} reads items from stdin`)
    assert.equal(psArgs(mode).join(" "), psArgs(mode).join(" "))
  }
  assert.equal(stdinPayload([fake, ""]), b64 + "\n\n", "one base64 line per item")
  const src = read(ROOT, "core", "store", "secrets.js")
  assert.match(src, /input: stdinPayload\(items\)/, "sync path sends items via stdin")
  assert.match(src, /child\.stdin\.end\(stdinPayload\(items\)/, "async path sends items via stdin")
  assert.match(src, /'CurrentUser'/, "DPAPI CurrentUser scope kept")
  if (process.platform === "win32") {
    const blobs = await secrets.protectBatch([fake, "fake-two-ünï"])
    assert.ok(blobs && blobs.every((b) => b && b.startsWith(secrets.PREFIX)), "protected")
    assert.ok(!blobs.join("").includes(fake), "blob is not plaintext")
    assert.deepEqual(await secrets.unprotectBatch(blobs), [fake, "fake-two-ünï"], "batch round-trip")
    const one = secrets.encrypt(fake + "-sync")
    assert.ok(one.startsWith(secrets.PREFIX))
    assert.equal(secrets.decrypt(one), fake + "-sync", "sync round-trip")
    assert.throws(() => secrets.decrypt(secrets.PREFIX + "bm90LWEtYmxvYg=="), /could not be decrypted/, "no plaintext fallback")
  }
})

/* ---------- 2. redaction ---------- */
test("redactText: new token shapes are redacted, ordinary words are not", () => {
  const { redactText } = require("../core/harness/guard")
  const cases = [
    ["github_pat_" + "A1b2C3d4E5".repeat(4), "github_pat_"],
    ["EAA" + "Bcd1234XyZ".repeat(6), "EAA"],
    ["https://graph.example.test/me?access_token=" + "abc123XYZ".repeat(3) + "&fields=id", "access_token="],
    ["https://api.example.test/x?a=1&token=" + "t0ken".repeat(5), "token="],
    ['{"api_key": "' + "k".repeat(30) + '"}', '"api_key"'],
    ['{"access_token":"' + "a".repeat(30) + '"}', '"access_token"'],
    ["OPENAI_API_KEY=" + "x".repeat(30), "OPENAI_API_KEY="],
    ["MY_SERVICE_TOKEN=" + "y".repeat(30), "MY_SERVICE_TOKEN="],
    ["APP_SECRET=" + "z".repeat(30), "APP_SECRET="],
    ["glpat-" + "g".repeat(24), "glpat-"],
    ["npm_" + "N".repeat(36), "npm_"],
    ["hf_" + "H".repeat(34), "hf_"],
    ["gsk_" + "G".repeat(52), "gsk_"],
    ["sk-or-v1-" + "o".repeat(40), "sk-or-"],
    ["xai-" + "X".repeat(60), "xai-"],
    ["r8_" + "R".repeat(37), "r8_"],
  ]
  for (const [input, keep] of cases) {
    const out = redactText(input)
    assert.ok(out.includes("[redacted]"), `redacted: ${keep}`)
    assert.ok(out.includes(keep), `keeps the name: ${keep}`)
    const secretTail = input.slice(-12)
    assert.ok(!out.includes(secretTail), `value gone: ${keep}`)
  }
  for (const plain of [
    "The token budget is fine and the key idea works.",
    "Use npm install and the hf hub; EAA is short.",
    "https://example.test/search?q=hello&page=2",
    "monkey=banana primary keys are fine",
    "export PATH=/usr/bin",
  ]) {
    assert.equal(redactText(plain), plain, `untouched: ${plain}`)
  }
})

/* ---------- 3. provider endpoint rules ---------- */
test("provider URL: http only for loopback / private LAN", () => {
  const profiles = require("../core/llm/profiles")
  for (const ok of [
    "https://api.example.test/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.1:8080",
    "http://127.5.6.7",
    "http://[::1]:1234/v1",
    "http://10.0.0.5/v1",
    "http://172.16.0.1",
    "http://172.31.255.255",
    "http://192.168.1.20:1234/v1",
    "http://my-box.local:8000/v1",
  ])
    assert.doesNotThrow(() => profiles.checkProviderURL(ok), ok)
  for (const bad of ["http://api.example.test/v1", "http://8.8.8.8", "http://172.32.0.1", "http://192.169.1.1", "http://localhost.evil.test"])
    assert.throws(() => profiles.checkProviderURL(bad), /must use https/, bad)
  assert.throws(() => profiles.checkProviderURL("ftp://x.test"), /http or https/)
  assert.match(read(ROOT, "electron", "backend.cjs"), /profileStore\.checkProviderURL\(parsedBase\.href\)/, "desktop save enforces it")
  assert.match(read(ROOT, "core", "control.js"), /profiles\.checkProviderURL\(url\.href\)/, "control save enforces it")
})

test("provider key: an origin change clears the saved key, same origin keeps it", async () => {
  const profiles = require("../core/llm/profiles")
  assert.equal(profiles.originChanged({ baseURL: "https://a.example.test/v1" }, "https://a.example.test/v2"), false)
  assert.equal(profiles.originChanged({ baseURL: "https://a.example.test/v1" }, "https://b.example.test/v1"), true)
  assert.equal(profiles.originChanged({ baseURL: "https://a.example.test/v1" }, "http://a.example.test/v1"), true)
  assert.equal(profiles.originChanged(null, "https://b.example.test"), false)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sec-"))
  const prevHome = process.env.VIBE_HOME
  process.env.VIBE_HOME = home
  try {
    const { createControl } = require("../core/control")
    const { Engine } = require("../core/engine")
    const engine = new Engine({ home })
    const control = createControl(engine)
    const save = (baseURL) => control.call("profiles.save", { profile: { id: "sec-x", format: "openai-chat", baseURL, model: "m" } })
    await save("https://a.example.test/v1")
    profiles.setKey("sec-x", "fake-key-123456789", home)
    await save("https://a.example.test/v2")
    assert.ok(profiles.hasKey({ id: "sec-x" }, home), "same origin keeps the key")
    const moved = await save("https://b.example.test/v1")
    assert.equal(moved.keyCleared, true)
    assert.equal(profiles.hasKey({ id: "sec-x" }, home), false, "moved origin cleared the key")
  } finally {
    if (prevHome === undefined) delete process.env.VIBE_HOME
    else process.env.VIBE_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("provider key: desktop save clears the key on origin change without a new key", () => {
  const src = read(ROOT, "electron", "backend.cjs")
  assert.match(src, /const movedOrigin = !a\.apiKey && profileStore\.originChanged\(current, profile\.baseURL\)/)
  assert.match(src, /if \(movedOrigin && profileStore\.hasKey\(\{ id \}, home\)\) \{\n\s+engine\.setKey\(id, ""\)/)
})

test("apiKeyEnv: only *KEY / *TOKEN / *SECRET names are read", () => {
  const profiles = require("../core/llm/profiles")
  for (const ok of ["OPENAI_API_KEY", "GROQ_API_KEY", "MY_TOKEN", "APP_SECRET", "302AI_API_KEY"]) assert.ok(profiles.validApiKeyEnv(ok), ok)
  for (const bad of ["PATH", "USERPROFILE", "HOME", "openai_api_key", "AWS_KEY_ID", "", null]) assert.ok(!profiles.validApiKeyEnv(bad), String(bad))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sec-env-"))
  const prev = process.env.VC_SEC_NOT_A_KEY_VAR
  process.env.VC_SEC_NOT_A_KEY_VAR = "fake-should-not-leak"
  try {
    assert.equal(profiles.hasKey({ id: "nope", apiKeyEnv: "VC_SEC_NOT_A_KEY_VAR" }, home), false)
    assert.throws(() => profiles.getKey({ id: "nope", apiKeyEnv: "VC_SEC_NOT_A_KEY_VAR" }, home), /No API key/)
  } finally {
    if (prev === undefined) delete process.env.VC_SEC_NOT_A_KEY_VAR
    else process.env.VC_SEC_NOT_A_KEY_VAR = prev
    fs.rmSync(home, { recursive: true, force: true })
  }
  assert.match(read(ROOT, "core", "control.js"), /profiles\.validApiKeyEnv\(p\.apiKeyEnv\)/, "control save validates it")
})

/* ---------- 4. redirects ---------- */
test("provider requests never follow a redirect to another origin", async () => {
  const http = require("../core/llm/http")
  const src = read(ROOT, "core", "llm", "http.js")
  assert.match(src, /redirect: "manual"/)
  const res = (status, location) => ({ status, headers: { get: (h) => (h === "location" ? location : null) } })
  assert.equal(http.redirectTarget(res(307, "/v1/chat"), "https://a.example.test/v1/x"), "https://a.example.test/v1/chat")
  assert.throws(() => http.redirectTarget(res(307, "https://evil.example.test/x"), "https://a.example.test/v1"), /does not send API keys across redirects/)
  assert.throws(() => http.redirectTarget(res(302, "/v1/chat"), "https://a.example.test/v1"), /redirected/)
  // end to end with a stubbed fetch: the key is sent exactly once, to the original host
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), key: opts.headers["x-api-key"], redirect: opts.redirect })
    return { status: 308, ok: false, headers: { get: () => "https://evil.example.test/steal" }, body: null, text: async () => "" }
  }
  try {
    await assert.rejects(http.postStream("https://a.example.test/v1/messages", { headers: { "x-api-key": "fake-k" }, body: {}, retries: 0 }), /across redirects/)
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].redirect, "manual")
  assert.ok(seen.every((s) => s.url.startsWith("https://a.example.test/")))
})

/* ---------- 5. private files ---------- */
test("profiles.json and mcp.json are written owner-only", () => {
  const pf = require("../core/store/private-file")
  assert.equal(typeof pf.hardenFileAcl, "function")
  assert.match(read(ROOT, "core", "llm", "profiles.js"), /fs\.writeFileSync\(f, JSON\.stringify\(user, null, 2\), \{ mode: 0o600 \}\)[\s\S]{0,200}hardenFileAcl\(f\)/)
  assert.match(read(ROOT, "core", "mcp", "index.js"), /writePrivateFile\(f, JSON\.stringify\(v, null, 2\)\)/)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sec-pf-"))
  try {
    const f = path.join(home, "x.json")
    pf.writePrivateFile(f, "{}")
    assert.equal(fs.readFileSync(f, "utf8"), "{}")
    if (process.platform !== "win32") assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

/* ---------- 6. gateway allow-list ---------- */
test("vibecoder account: only allow-listed gateway origins are accepted", async () => {
  const { createVibecoderAccount, DEFAULT_GATEWAY_URL } = require("../electron/vibecoder-account.cjs")
  const BASE = "https://site.example.test"
  const GW = "https://gateway.example.test"
  const MODELS = [{ id: "m1", context_length: 1000 }]
  const json = (value) => ({ ok: true, status: 200, json: async () => value })
  const run = async (announced, extra = {}) => {
    let profile = null
    const acct = createVibecoderAccount({
      baseUrl: BASE, gatewayUrl: GW, openExternal: async () => {}, emit: () => {},
      keys: { get: () => "vc_fake", set() {}, clear() {} },
      profiles: { exists: () => !!profile, upsert: (p) => { profile = p }, remove() {} },
      fetch: async (url) => (url.endsWith("/v1/account") ? json({ gateway_url: announced }) : json({ data: MODELS })),
      ...extra,
    })
    await acct.syncModels()
    return profile.baseURL
  }
  assert.equal(await run("https://attacker.example.test"), `${GW}/v1`, "unknown origin ignored")
  assert.equal(await run(BASE), `${GW}/v1`, "website naming itself keeps the default")
  assert.equal(await run(DEFAULT_GATEWAY_URL), `${new URL(DEFAULT_GATEWAY_URL).origin}/v1`, "built-in gateway accepted")
  assert.equal(await run("https://second.example.test", { allowedGateways: ["https://second.example.test"] }), "https://second.example.test/v1")
})

/* ---------- 7. markdown URL guard + UNC block ---------- */
test("markdown: //host, \\\\host and file: URLs are dropped; id/name forbidden", () => {
  const hooks = {}
  const fakePurify = {
    addHook: (name, fn) => { hooks[name] = fn },
    sanitize: () => "",
  }
  const window = { DOMPurify: fakePurify, marked: { parse: (s) => s }, Node: function () {} }
  vm.runInNewContext(read(ROOT, "renderer", "markdown.js"), { window })
  window.renderMarkdown("x") // installs the hooks
  assert.equal(typeof hooks.uponSanitizeAttribute, "function")
  assert.equal(typeof hooks.afterSanitizeAttributes, "function")
  const g = window.__vibeMarkdownUrlGuard
  const bad = [
    ["img", "src", "//attacker.example/x.png"],
    ["img", "src", "\\\\attacker\\share\\x.png"],
    ["img", "src", " /\\attacker/x"],
    ["img", "src", "file://attacker/x.png"],
    ["img", "src", "FILE:///C:/Windows/win.ini"],
    ["img", "src", "javascript:alert(1)"],
    ["img", "src", "data:text/html,<b>x</b>"],
    ["img", "srcset", "https://ok.example/a.png 1x, //attacker/b.png 2x"],
    ["a", "href", "//attacker.example/"],
    ["a", "href", "file:///C:/x"],
    ["a", "href", "java\tscript:alert(1)"],
    ["image", "xlink:href", "//attacker/x"],
  ]
  for (const [tag, attr, value] of bad) {
    assert.ok(g.unsafeUrlAttribute(tag, attr, value), `${tag}[${attr}]=${value}`)
    const data = { attrName: attr, attrValue: value, keepAttr: true }
    hooks.uponSanitizeAttribute({ nodeName: tag.toUpperCase() }, data)
    assert.equal(data.keepAttr, false, `hook drops ${value}`)
  }
  const good = [
    ["img", "src", "https://ok.example/a.png"],
    ["img", "src", "data:image/png;base64,iVBORw0KGgo="],
    ["a", "href", "https://ok.example/page"],
    ["a", "href", "mailto:someone@example.test"],
    ["a", "href", "#section"],
    ["a", "title", "//not a url attribute"],
  ]
  for (const [tag, attr, value] of good) assert.ok(!g.unsafeUrlAttribute(tag, attr, value), `${tag}[${attr}]=${value} kept`)
  const src = read(ROOT, "renderer", "markdown.js")
  assert.match(src, /FORBID_ATTR: \["style", "onerror", "onload", "id", "name"\]/)
})

test("main: file:// requests with a host (UNC) are cancelled", () => {
  const src = read(ROOT, "electron", "main.cjs")
  assert.match(src, /webRequest\.onBeforeRequest\(\{ urls: \["file:\/\/\*\/\*"\] \}/)
  assert.match(src, /blockUncFileRequests\(session\.defaultSession\)/)
  const fnSrc = src.match(/function isUncFileUrl\(url\) \{[\s\S]*?\n\}/)[0]
  const isUnc = vm.runInNewContext(`(${fnSrc})`, { URL })
  assert.equal(isUnc("file://attacker/x.png"), true)
  assert.equal(isUnc("file:////attacker/share"), true)
  assert.equal(isUnc("file:\\\\attacker\\x"), true)
  assert.equal(isUnc("file:///C:/app/renderer/index.html"), false)
  assert.equal(isUnc("https://example.test/"), false)
})

/* ---------- 8-10. build, .gitignore, CI ---------- */
test("installer excludes dev scripts; fuses set (runAsNode kept for diagnostics)", () => {
  const pkg = JSON.parse(read(ROOT, "package.json"))
  for (const x of ["!electron/fix-*.js", "!electron/add-event-handler.js", "!electron/event-wiring.js", "!electron/proper-add-events.js", "!electron/frontend/**"])
    assert.ok(pkg.build.files.includes(x), x)
  const f = pkg.build.electronFuses
  assert.equal(f.runAsNode, true, "core/tools/diagnostics.js runs process.execPath with ELECTRON_RUN_AS_NODE")
  assert.equal(f.enableNodeOptionsEnvironmentVariable, false)
  assert.equal(f.enableNodeCliInspectArguments, false)
  assert.equal(f.onlyLoadAppFromAsar, true)
})

test(".gitignore covers .env* and the local website copy", () => {
  const lines = read(REPO, ".gitignore").split("\n").map((l) => l.trim())
  for (const l of [".env*", "!.env.example", "!.env.sample", "/website/", ".env", ".env.local", "node_modules/"]) assert.ok(lines.includes(l), l)
})

test("release workflow: no persisted git credentials, least privilege, pinned actions", () => {
  const yml = read(REPO, ".github", "workflows", "release.yml")
  assert.match(yml, /persist-credentials: false/)
  assert.match(yml, /^permissions:\n  contents: read$/m)
  assert.match(yml, /  release:\n    runs-on: windows-latest\n    permissions:\n      contents: write/)
  assert.match(yml, /uses: actions\/checkout@[0-9a-f]{40} # v4/)
  assert.match(yml, /uses: actions\/setup-node@[0-9a-f]{40} # v4/)
  assert.match(yml, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/, "publish uses GH_TOKEN, not git credentials")
})

;(async () => {
  let pass = 0
  for (const t of tests) {
    try {
      await t.fn()
      pass++
      console.log("PASS security: " + t.name)
    } catch (e) {
      console.error("FAIL security: " + t.name)
      console.error(e)
      process.exitCode = 1
    }
  }
  console.log(`${pass}/${tests.length} security tests passed`)
})()
