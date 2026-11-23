"use strict"
// Permission-system security fixes:
//  1. built-in bash allow rules are anchored (no `*npm test*` substring hits),
//     scratch cleanup only inside ./.vibe-scratch, scratch any-tool rule is
//     file tools only;
//  2. forceAsk/neverPersist survive the per-segment split in the loop;
//  3. apply_patch asks for every file it touches;
//  4. shellInput shows the typed text and never saves "always";
//  5. webfetch refuses private targets on the first hop (and pins DNS).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const http = require("node:http")
const { decide, DEFAULT_RULES } = require("../core/perm/rules")
const { hasDynamicShell } = require("../core/perm/builtin")
const { checkPermissions, splitCommand } = require("../core/agent/loop")
const tools = require("../core/tools")
const jobs = require("../core/jobs")
const { createVibe } = require("../sdk")

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vibe-sec-"))
const bash = (c) => decide(DEFAULT_RULES, "bash", c)
// What the loop + engine do for one bash command: every split segment must be allowed.
const loopBash = (command) => {
  const perm = tools.byName("bash").perm({ command })
  return splitCommand(perm.subject).every((sub) => {
    const a = bash(sub)
    return a === "allow" && !perm.forceAsk
  })
}

const results = []
async function test(name, fn) {
  try {
    await fn()
    results.push(name)
  } catch (e) {
    console.error(`FAIL ${name}`)
    throw e
  }
}

;(async () => {
  await test("1a: substring attack strings are not auto-allowed", () => {
    const attacks = [
      String.raw`Remove-Item -Recurse -Force C:\Users\x # vibe-scratch`,
      "Format-Volume D # npm test",
      "rm -rf /home/x # vibe-scratch",
      "evil.exe --npm test",
      "calc.exe; npm test",
      "npm test # anything",
      String.raw`npm test > C:\Windows\x.txt`,
      "npm test --script-shell=calc.exe",
      "npm install evil-package",
      "npm test $(calc)",
      "npm test (calc)",
      "npm test `calc`",
      "go test -exec calc ./...",
      "cargo test --config target.x.runner=calc",
      "node --test --require ./evil.js",
      "node evil.js --test",
      "python ./.vibe-scratch/x.py",
      "cmd /c npm test",
      "xnpm test",
    ]
    for (const c of attacks) {
      assert.notEqual(bash(c), "allow", `must not auto-allow: ${c}`)
      assert.equal(loopBash(c), false, `loop must not run unasked: ${c}`)
    }
  })

  await test("1b: anchored build/test commands stay auto-allowed", () => {
    for (const c of ["npm test", "npm test -- --grep foo", "npm test 2>&1", "npm ci", "npm ci --no-audit --no-fund", "npm install", "npm install --legacy-peer-deps", "yarn test", "pnpm build", "node --test", "node --test test/a.test.js", "cargo build --release", "cargo test", "go build ./...", "go test ./...", "dotnet build", "dotnet test", "npm.cmd test"]) {
      assert.equal(bash(c), "allow", `should allow: ${c}`)
    }
    assert.equal(loopBash("cd sub; npm test"), false, "cd still asks")
    assert.equal(bash("npm run evil"), "ask")
    assert.equal(bash("rm -rf /"), "deny")
  })

  await test("1c: scratch cleanup only inside ./.vibe-scratch", () => {
    for (const c of [
      "Remove-Item -Recurse -Force .vibe-scratch",
      String.raw`Remove-Item -Recurse -Force .\.vibe-scratch\*`,
      String.raw`Remove-Item -LiteralPath .vibe-scratch\a.txt -Force -ErrorAction SilentlyContinue`,
      "Remove-Item -Recurse -Force .vibe-scratch -Confirm:$false",
      "rm -rf ./.vibe-scratch/a.txt",
      "rm -rf .vibe-scratch",
    ]) assert.equal(bash(c), "allow", `inside scratch: ${c}`)
    for (const c of [
      String.raw`Remove-Item -Recurse -Force C:\Users\x`,
      String.raw`Remove-Item -Recurse .vibe-scratch\..\src`,
      String.raw`Remove-Item .vibe-scratch, C:\x -Recurse`,
      String.raw`Remove-Item C:\proj\.vibe-scratch -Recurse`,
      "rm -rf .vibe-scratch*",
      "rm -rf .vibe-scratch ../other",
      "rm -rf ~/.vibe-scratch",
      "Remove-Item .vibe-scratch -Recurse > C:/x.log",
      "Remove-Item $env:USERPROFILE -Recurse # .vibe-scratch",
      "Remove-Item -Recurse -Force -Path (Get-Location) .vibe-scratch",
      "Get-ChildItem .vibe-scratch",
    ]) assert.notEqual(bash(c), "allow", `outside scratch: ${c}`)
  })

  await test("1d: .vibe-scratch any-path allow is for file tools only", () => {
    const p = "C:/proj/.vibe-scratch/a.txt"
    for (const t of ["read", "write", "edit", "list", "glob", "grep", "multiedit", "apply_patch"]) assert.equal(decide(DEFAULT_RULES, t, p), "allow", t)
    for (const t of ["external_directory", "browser", "webfetch", "mcp__x__y", "bash"]) assert.notEqual(decide(DEFAULT_RULES, t, p), "allow", t)
    assert.equal(bash("evil.exe C:/x/.vibe-scratch/a"), "ask")
  })

  await test("1e: saved user rules keep their wildcard semantics", () => {
    const rules = [...DEFAULT_RULES, { tool: "bash", pattern: "git *", action: "allow" }, { tool: "bash", pattern: "*make*", action: "allow" }, { tool: "bash", pattern: "pytest -q", exact: true, action: "allow" }]
    assert.equal(decide(rules, "bash", "git status"), "allow")
    assert.equal(decide(rules, "bash", "git"), "allow")
    assert.equal(decide(rules, "bash", "cmake --build ."), "allow")
    assert.equal(decide(rules, "bash", "pytest -q"), "allow")
    // an old/foreign rule with an unknown builtin never matches (fail closed)
    assert.equal(decide([{ tool: "bash", pattern: "*", builtin: "nope", action: "allow" }], "bash", "ls"), "ask")
  })

  await test("2a: dynamic shell syntax forces an ask", () => {
    for (const c of ["npm test $(calc)", "npm test (calc)", "npm test @(calc)", "& { calc }", ". { calc }", "Start-Process calc", "powershell -EncodedCommand AAA", "pwsh -enc AAA", "cmd /c calc", "bash -c ls", "iex $x", "Invoke-Expression x", "find . -exec rm {} ;"]) {
      assert.equal(tools.byName("bash").perm({ command: c }).forceAsk, true, c)
    }
    for (const c of ["npm test", "npm start", "git commit -m \"fix (x)\"", "git log"]) assert.equal(hasDynamicShell(c), false, c)
  })

  await test("2b: forceAsk/neverPersist are carried into every split segment", async () => {
    const seen = []
    const ask = async (p) => { seen.push(p); return true }
    const perm = tools.byName("bash").perm({ command: "npm test; npm test $(calc)" })
    assert.equal(await checkPermissions(ask, perm, {}), true)
    assert.equal(seen.length, 2)
    for (const p of seen) {
      assert.equal(p.tool, "bash")
      assert.equal(p.forceAsk, true, `segment ${p.subject} lost forceAsk`)
    }
    seen.length = 0
    await checkPermissions(ask, { tool: "bash", subject: "a && b", neverPersist: true, critical: true }, {})
    assert.deepEqual(seen.map((p) => [p.subject, p.neverPersist, p.critical]), [["a", true, true], ["b", true, true]])
  })

  await test("2c: real engine prompts for a dynamic command even when the prefix is allow-listed", async () => {
    const home = tmp()
    const vibe = createVibe({ home, permission: "ask" })
    const s = vibe.engine.store.create({ dir: tmp(), profile: "mock" })
    const ask = vibe.engine._ask(s, new AbortController().signal, () => {})
    assert.equal(await checkPermissions(ask, tools.byName("bash").perm({ command: "npm test" }), {}), true, "plain npm test is allowed")
    const before = vibe.engine.pending.size
    const pending = checkPermissions(ask, tools.byName("bash").perm({ command: "npm test $(calc)" }), {})
    await new Promise((r) => setImmediate(r))
    assert.equal(vibe.engine.pending.size, before + 1, "dynamic command waits for the user")
    vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "deny")
    assert.equal(await pending, false)
  })

  await test("3: apply_patch asks for every distinct file", async () => {
    const d = tmp()
    fs.writeFileSync(path.join(d, "a.txt"), "one\n")
    fs.writeFileSync(path.join(d, "mv.txt"), "keep\n")
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.txt", "@@", "-one", "+ONE",
      "*** Add File: sub/new.txt", "+hi",
      "*** Delete File: gone.txt",
      "*** Update File: mv.txt", "*** Move to: ../outside/moved.txt", "@@", "-keep", "+kept",
      "*** End Patch",
    ].join("\n")
    const ap = tools.byName("apply_patch")
    const perm = ap.perm({ patchText: patch }, { cwd: d })
    const all = [perm.subject, ...perm.more.map((p) => p.subject)]
    assert.deepEqual(all, [path.join(d, "a.txt"), path.join(d, "sub", "new.txt"), path.join(d, "gone.txt"), path.join(d, "mv.txt"), path.resolve(d, "../outside/moved.txt")])
    assert.ok(perm.more.every((p) => p.tool === "edit"))
    // the same file twice is asked once
    const dup = ap.perm({ patchText: ["*** Begin Patch", "*** Update File: a.txt", "@@", "-one", "+1", "*** Update File: a.txt", "@@", "-1", "+2", "*** End Patch"].join("\n") }, { cwd: d })
    assert.equal(dup.subject, path.join(d, "a.txt"))
    assert.equal(dup.more, undefined)
    // the loop asks each one; a denial of any extra file blocks the call
    const asked = []
    const denyMove = async (p) => { asked.push(p.subject); return !/moved\.txt$/.test(p.subject) }
    assert.equal(await checkPermissions(denyMove, perm, {}), false)
    assert.equal(asked.length, 5)
    // everything granted: ctx.grantedPaths is set and run() does not ask again
    const ctx = { cwd: d, stats: {} }
    const ask2 = []
    assert.equal(await checkPermissions(async (p) => { ask2.push(p.subject); return true }, perm, ctx), true)
    assert.equal(ctx.grantedPaths.size, 5)
    fs.writeFileSync(path.join(d, "gone.txt"), "x\n")
    ctx.askPermission = async () => { throw new Error("must not ask again") }
    await tools.byName("read").run({ path: "a.txt" }, ctx)
    await tools.byName("read").run({ path: "mv.txt" }, ctx)
    await tools.byName("read").run({ path: "gone.txt" }, ctx)
    const out = await ap.run({ patchText: patch }, ctx)
    assert.match(out, /Moved/)
    assert.equal(fs.readFileSync(path.join(d, "a.txt"), "utf8"), "ONE\n")
    fs.rmSync(path.resolve(d, "../outside"), { recursive: true, force: true })
    // direct callers without a pre-checked set still ask per extra file
    const direct = []
    const two = ["*** Begin Patch", "*** Add File: p1.txt", "+1", "*** Add File: p2.txt", "+2", "*** End Patch"].join("\n")
    await assert.rejects(() => ap.run({ patchText: two }, { cwd: d, stats: {}, askPermission: async (p) => { direct.push(p.subject); return false } }), /denied permission/)
    assert.deepEqual(direct, [path.join(d, "p2.txt")])
    fs.rmSync(d, { recursive: true, force: true })
  })

  await test("4: shellInput shows the text and never persists", () => {
    const si = tools.byName("shellInput")
    const p = si.perm({ shellId: "sh_1", text: "yes\nrm -rf x" })
    assert.equal(p.tool, "bash")
    assert.equal(p.neverPersist, true)
    assert.match(p.subject, /^input sh_1: /)
    assert.match(p.subject, /yes\\nrm -rf x/)
    assert.match(p.subject, /\+ Enter$/)
    assert.match(si.perm({ shellId: "sh_1", text: "", enter: true }).subject, /^input sh_1: \(no text\) \+ Enter$/)
    assert.ok(si.perm({ shellId: "sh_1", text: "a".repeat(500) }).subject.length < 200, "subject is truncated")
    assert.doesNotMatch(si.perm({ shellId: "sh_1", text: "password=hunter2secret" }).subject, /hunter2secret/)
    // a job stopped at a password prompt: the agent may not type into it
    const origGet = jobs.get
    jobs.get = () => ({ id: "sh_2", waitingForInput: true, waitingPrompt: "Enter passphrase for key:" })
    try {
      assert.throws(() => si.run({ shellId: "sh_2", text: "secret" }, { engine: { shellInput: () => ({ bytes: 1 }) }, session: { id: "s" } }), /Never enter secrets/)
      assert.match(si.run({ shellId: "sh_2", text: "", enter: true }, { engine: { shellInput: () => ({ bytes: 1 }) }, session: { id: "s" } }), /Sent 1 byte/)
    } finally {
      jobs.get = origGet
    }
  })

  await test("5: webfetch refuses private first-hop targets; explicit localhost is a critical prompt", async () => {
    const wf = tools.byName("webfetch")
    const local = wf.perm({ url: "http://localhost:3000/x" })
    assert.equal(local.forceAsk, true)
    assert.equal(local.critical, true)
    assert.equal(local.neverPersist, true)
    assert.equal(wf.perm({ url: "http://127.0.0.1:8080" }).critical, true)
    assert.equal(wf.perm({ url: "https://example.com" }).critical, undefined)
    assert.equal(tools.isPrivateAddr("::ffff:7f00:1"), true)
    assert.equal(tools.isPrivateAddr("fe80::1"), true)
    assert.equal(tools.isPrivateAddr("fc00::1"), true)
    assert.equal(tools.isPrivateAddr("172.20.0.1"), true)
    assert.equal(tools.isPrivateAddr("93.184.216.34"), false)
    // private literal IPs and *.internal names are refused before any request
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://[fe80::1]/", "http://[::ffff:a00:1]/", "http://metadata.google.internal/"]) {
      await assert.rejects(() => wf.run({ url }, {}), /blocked/, url)
    }
    // a hostname that resolves to loopback (not written as localhost) is refused
    const srv = http.createServer((req, res) => {
      if (req.url === "/go") { res.writeHead(302, { location: "http://10.1.2.3/" }); return res.end() }
      res.end("ok-local")
    })
    await new Promise((r) => srv.listen(0, "127.0.0.1", r))
    try {
      const port = srv.address().port
      // DNS rebinding: the pre-check sees a public IP, the connection's own
      // lookup gets 127.0.0.1 -> refused inside the socket lookup.
      const dns = require("node:dns")
      const origLookup = dns.lookup
      const origPromise = dns.promises.lookup
      dns.promises.lookup = async (h, o) => (/rebind\.test$/.test(h) ? [{ address: "93.184.216.34", family: 4 }] : origPromise(h, o))
      dns.lookup = (h, o, cb) => (/rebind\.test$/.test(h) ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : origLookup(h, o, cb))
      try {
        await assert.rejects(() => wf.run({ url: `http://evil.rebind.test:${port}/` }, {}), /private network address .*blocked/)
        dns.promises.lookup = async () => [{ address: "127.0.0.1", family: 4 }]
        await assert.rejects(() => wf.run({ url: `http://evil.rebind.test:${port}/` }, {}), /Request to a private network address .*blocked/)
      } finally {
        dns.lookup = origLookup
        dns.promises.lookup = origPromise
      }
      // explicit loopback (approved through the critical prompt) still works
      assert.match(await wf.run({ url: `http://127.0.0.1:${port}/` }, {}), /ok-local/)
      assert.match(await wf.run({ url: `http://localhost:${port}/` }, {}), /ok-local/)
      // and its redirect to another private host is still blocked
      await assert.rejects(() => wf.run({ url: `http://127.0.0.1:${port}/go` }, {}), /blocked/)
    } finally {
      srv.close()
    }
    // real engine in Full Access: the localhost fetch still waits for a click
    const vibe = createVibe({ home: tmp(), permission: "allow" })
    const s = vibe.engine.store.create({ dir: tmp(), profile: "mock" })
    const ask = vibe.engine._ask(s, new AbortController().signal, () => {})
    assert.equal(await ask(wf.perm({ url: "https://example.com" })), true)
    const before = vibe.engine.pending.size
    const p = ask(wf.perm({ url: "http://localhost:5173" }))
    await new Promise((r) => setImmediate(r))
    assert.equal(vibe.engine.pending.size, before + 1)
    vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "always")
    assert.equal(await p, true)
    assert.equal(vibe.engine.getSession(s.id).rules.length, 0, "localhost approval is never saved")
  })

  console.log(`PASS security perm: ${results.length} checks (anchored bash rules, scratch cleanup, forceAsk per segment, apply_patch per path, shellInput subject, webfetch private hosts)`)
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
