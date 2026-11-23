"use strict"
// Browser agent tools: per-tab permission host, rich action results, explicit
// evaluate output, and bounded snapshots. Runs with a fake engine bridge.
const assert = require("node:assert/strict")
const path = require("node:path")

const { createBrowserTools, _resetBrowserToolState } = require(path.join(__dirname, "..", "core", "tools", "browser.js"))
const { byName } = require(path.join(__dirname, "..", "core", "tools"))

const t = createBrowserTools()
const tests = []
function test(name, fn) { tests.push([name, fn]) }

function ctxWith(engine) { return { cwd: process.cwd(), emit: () => {}, engine } }

// ---- 1. permission host is per tab ----
test("byName exposes the same browser tools", () => {
  for (const n of ["browser.click", "browser.fill", "browser.press", "browser.scroll", "browser.navigate", "browser.evaluate", "browser.snapshot", "browser.current"]) {
    assert.equal(typeof byName(n)?.run, "function", n)
  }
})

test("unknown tab never borrows another tab's host and is not persistable", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserCreateTab(a) { return { ok: true, data: { tabID: "tab-gh", url: a.url, title: "GitHub" } } },
  }
  await t.openTab.run({ url: "https://github.com/" }, ctxWith(engine))
  const known = t.click.perm({ tabID: "tab-gh", ref: "e1" })
  assert.equal(known.subject, "click github.com")
  assert.ok(!known.neverPersist, "a known host may be saved as always-allow")
  const other = t.click.perm({ tabID: "tab-bank", ref: "e1" })
  assert.doesNotMatch(other.subject, /github\.com/, "unknown tab must not reuse github.com")
  assert.match(other.subject, /unknown host/)
  assert.equal(other.neverPersist, true)
  assert.equal(other.forceAsk, true)
  for (const tool of [t.fill, t.press, t.scroll]) {
    const p = tool.perm({ tabID: "tab-bank" })
    assert.equal(p.neverPersist, true)
    assert.doesNotMatch(p.subject, /github/)
  }
})

test("no tab state at all: active-tab action is unknown host", () => {
  _resetBrowserToolState()
  const p = t.click.perm({ ref: "e1" })
  assert.match(p.subject, /unknown host: the active tab/)
  assert.equal(p.neverPersist, true)
  assert.equal(p.forceAsk, true)
})

test("tabs.list refreshes per-tab hosts and the active tab", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserListTabs() {
      return { ok: true, data: { tabs: [
        { id: "a", url: "https://github.com/x", title: "GH", active: false },
        { id: "b", url: "https://bank.example/login", title: "Bank", active: true },
      ] } }
    },
  }
  await t.listTabs.run({}, ctxWith(engine))
  assert.equal(t.click.perm({ tabID: "a" }).subject, "click github.com")
  assert.equal(t.click.perm({ tabID: "b" }).subject, "click bank.example")
  assert.equal(t.click.perm({}).subject, "click bank.example", "no tabID -> the active tab's host")
})

test("browser.current refreshes the active tab host", async () => {
  _resetBrowserToolState()
  const engine = { async browserCurrent() { return { ok: true, data: { tabID: "c1", url: "https://docs.example/page", title: "Docs", snapshot: "[main] x" } } } }
  await t.current.run({}, ctxWith(engine))
  assert.equal(t.press.perm({}).subject, "press docs.example")
  assert.equal(t.press.perm({ tabID: "c1" }).subject, "press docs.example")
})

test("an action result that reports a new URL updates that tab's host", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserCreateTab(a) { return { ok: true, data: { tabID: "t1", url: a.url } } },
    async browserClick() { return { ok: true, data: { result: { clicked: "e3", tabID: "t1", url: "https://other.example/home", title: "Other", urlBefore: "https://github.com/", navigated: true, generation: 4 } } } },
  }
  const c = ctxWith(engine)
  await t.openTab.run({ url: "https://github.com/" }, c)
  assert.equal(t.click.perm({ tabID: "t1" }).subject, "click github.com")
  await t.click.run({ tabID: "t1", ref: "e3" }, c)
  assert.equal(t.click.perm({ tabID: "t1" }).subject, "click other.example", "host follows the page after the click navigated")
})

test("closing a tab forgets its host", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserCreateTab(a) { return { ok: true, data: { tabID: "t9", url: a.url } } },
    async browserCloseTab() { return { ok: true } },
  }
  const c = ctxWith(engine)
  await t.openTab.run({ url: "https://github.com/" }, c)
  await t.closeTab.run({ tabID: "t9" }, c)
  assert.equal(t.click.perm({ tabID: "t9" }).neverPersist, true)
})

// ---- 2. action results carry page state ----
test("click reports URL, title, generation and stale-ref warning on navigation", async () => {
  _resetBrowserToolState()
  const engine = { async browserClick() { return { ok: true, data: { result: { clicked: "e1", tabID: "t1", url: "https://example.test/next", title: "Next", urlBefore: "https://example.test/", navigated: true, generation: 2 } } } } }
  const out = await t.click.run({ tabID: "t1", ref: "e1" }, ctxWith(engine))
  assert.match(out, /^Clicked e1/)
  assert.match(out, /URL: https:\/\/example\.test\/next/)
  assert.match(out, /Title: Next/)
  assert.match(out, /Snapshot generation: 2/)
  assert.match(out, /page navigated to https:\/\/example\.test\/next/i)
  assert.match(out, /stale — take a new snapshot/)
})

test("fill / press / scroll without navigation report URL but no stale warning", async () => {
  _resetBrowserToolState()
  const page = { tabID: "t1", url: "https://example.test/form", title: "Form", urlBefore: "https://example.test/form", navigated: false, generation: 5 }
  const engine = {
    async browserFill() { return { ok: true, data: { result: { filled: "e2", ...page } } } },
    async browserPress() { return { ok: true, data: { result: { pressed: "Tab", ...page } } } },
    async browserScroll() { return { ok: true, data: { result: { scrollY: 600, ...page } } } },
  }
  const c = ctxWith(engine)
  const fill = await t.fill.run({ tabID: "t1", ref: "e2", text: "hi" }, c)
  const press = await t.press.run({ tabID: "t1", key: "Tab" }, c)
  const scroll = await t.scroll.run({ tabID: "t1", deltaY: 600 }, c)
  for (const out of [fill, press, scroll]) {
    assert.match(out, /URL: https:\/\/example\.test\/form/)
    assert.match(out, /Title: Form/)
    assert.match(out, /Snapshot generation: 5/)
    assert.doesNotMatch(out, /navigated/i)
  }
  assert.match(fill, /^Filled e2/)
  assert.match(press, /^Pressed Tab/)
  assert.match(scroll, /^Scrolled \(scrollY 600\)/)
})

test("press Enter that submits a form reports the navigation", async () => {
  _resetBrowserToolState()
  const engine = { async browserPress() { return { ok: true, data: { result: { pressed: "Enter", tabID: "t1", url: "https://example.test/results?q=x", title: "Results", urlBefore: "https://example.test/", navigated: true, generation: 3 } } } } }
  const out = await t.press.run({ tabID: "t1", key: "Enter" }, ctxWith(engine))
  assert.match(out, /Page navigated to https:\/\/example\.test\/results\?q=x/)
})

test("old bridge (no page data) still returns the short message", async () => {
  _resetBrowserToolState()
  const engine = { async browserClick() { return { ok: true } }, async browserScroll() { return { ok: true } } }
  assert.equal(await t.click.run({ tabID: "t1", ref: "e1" }, ctxWith(engine)), "Clicked e1")
  assert.equal(await t.scroll.run({ tabID: "t1", deltaY: 10 }, ctxWith(engine)), "Scrolled")
})

test("navigate reports the final URL after a redirect", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserNavigate() { return { ok: true } },
    async browserWait() { return { ok: true, data: { elapsedMs: 12, selector: "body", tabID: "t1", url: "https://www.example.test/home", title: "Home" } } },
  }
  const out = await t.navigate.run({ tabID: "t1", url: "http://example.test/" }, ctxWith(engine))
  assert.match(out, /Final URL: https:\/\/www\.example\.test\/home/)
  assert.match(out, /Title: Home/)
  assert.match(out, /differs from the requested http:\/\/example\.test\//)
  assert.equal(t.click.perm({ tabID: "t1" }).subject, "click www.example.test", "host is learned from the final URL")
})

test("navigate without redirect has no differs note", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserNavigate() { return { ok: true } },
    async browserWait() { return { ok: true, data: { elapsedMs: 3, tabID: "t1", url: "https://example.test/", title: "Ex" } } },
  }
  const out = await t.navigate.run({ tabID: "t1", url: "https://example.test/" }, ctxWith(engine))
  assert.match(out, /Final URL: https:\/\/example\.test\//)
  assert.doesNotMatch(out, /differs/)
})

test("navigate says it timed out when the body wait fails", async () => {
  _resetBrowserToolState()
  const engine = {
    async browserNavigate() { return { ok: true } },
    async browserWait() { return { ok: false, error: "Timed out after 5000 ms waiting for selector body" } },
    async browserListTabs() { return { ok: true, data: { tabs: [{ id: "t1", url: "https://slow.example/", title: "Slow", active: true }] } } },
  }
  const out = await t.navigate.run({ tabID: "t1", url: "https://slow.example/" }, ctxWith(engine))
  assert.match(out, /Timed out waiting for the page body/)
  assert.match(out, /Timed out after 5000 ms/)
  assert.match(out, /Final URL: https:\/\/slow\.example\//)
})

// ---- 3. evaluate output ----
test("evaluate returns explicit text for undefined / null / empty string", async () => {
  const mk = (result) => ({ async browserEvaluate() { return { ok: true, data: { result } } } })
  assert.equal(await t.evaluate.run({ script: "void 0" }, ctxWith(mk(undefined))), "(script returned undefined)")
  assert.equal(await t.evaluate.run({ script: "null" }, ctxWith(mk(null))), "(script returned null)")
  assert.equal(await t.evaluate.run({ script: "''" }, ctxWith(mk(""))), "(script returned an empty string)")
  assert.equal(await t.evaluate.run({ script: "document.title" }, ctxWith(mk("Hello"))), "Hello")
  assert.match(await t.evaluate.run({ script: "x" }, ctxWith(mk({ title: "Example" }))), /"title": "Example"/)
  assert.equal(await t.evaluate.run({ script: "1" }, ctxWith(mk(0))), "0")
})

test("evaluate clips large output with a narrowing hint", async () => {
  const big = "x".repeat(60_000)
  const out = await t.evaluate.run({ script: "big" }, ctxWith({ async browserEvaluate() { return { ok: true, data: { result: big } } } }))
  assert.ok(out.length < 21_000, "clipped near 20k chars, got " + out.length)
  assert.match(out, /chars truncated/)
  assert.match(out, /Narrow the script/)
  assert.match(out, /querySelector/)
})

// ---- 4. snapshot size ----
test("snapshot and current are clipped to ~20k chars with a depth/selector hint", async () => {
  _resetBrowserToolState()
  const huge = Array.from({ length: 5000 }, (_, i) => `  [button] Item number ${i} @e${i}`).join("\n")
  assert.ok(huge.length > 100_000)
  const engine = {
    async browserSnapshot() { return { ok: true, data: { snapshot: huge, generation: 1, refCount: 5000 } } },
    async browserCurrent() { return { ok: true, data: { tabID: "t1", url: "https://example.test/", title: "Big", snapshot: huge } } },
  }
  const snap = await t.snapshot.run({}, ctxWith(engine))
  const cur = await t.current.run({}, ctxWith(engine))
  for (const out of [snap, cur]) {
    assert.ok(out.length < 21_000, "clipped near 20k chars, got " + out.length)
    assert.match(out, /chars truncated/)
    assert.match(out, /lower depth/)
    assert.match(out, /querySelector/)
  }
  const small = await t.snapshot.run({}, ctxWith({ async browserSnapshot() { return { ok: true, data: { snapshot: "[button] Ok @e1" } } } }))
  assert.doesNotMatch(small, /truncated|lower depth/)
})

// ---- 5. dangerous clicks and secret fields ask / refuse even after "always allow" ----
function riskyBridge(snapshot, extra = {}) {
  const calls = []
  const engine = {
    async browserCreateTab(a) { return { ok: true, data: { tabID: "gh", url: a.url, title: "GitHub" } } },
    async browserSnapshot(a) { calls.push(["snapshot", a]); return { ok: true, data: { snapshot, generation: 1, refCount: 9, tabID: "gh", url: extra.url || "https://github.com/me/repo/settings" } } },
    async browserClick(a) { calls.push(["click", a]); return { ok: true } },
    async browserFill(a) { calls.push(["fill", a]); return { ok: true } },
    ...extra.engine,
  }
  return { engine, calls }
}
function askingCtx(engine, answer = true) {
  const asks = []
  return { asks, ctx: { ...ctxWith(engine), askPermission: async (p) => { asks.push(p); return answer } } }
}
const SNAP = [
  "[main] main",
  "  [button] Delete this repository @e1",
  "  [button] Save changes @e2",
  "  [a] Delete account @e3",
  "  [button] Pay $20 @e4",
  "  [button] Transfer ownership @e5",
  "  [button] Revoke all user tokens @e6",
  "  [input] Password @e7",
  "  [input] One-time code @e8",
  "  [input] Repository name = repo @e9",
  "  [button] Star @e10",
  "  [button] Remove @e11",
  "  [button] Confirm purchase @e12",
  "  [button] Submit @e13",
].join("\n")

test("after 'always allow click github.com', dangerous buttons still ask (critical, never saved)", async () => {
  _resetBrowserToolState()
  const { engine, calls } = riskyBridge(SNAP)
  await t.openTab.run({ url: "https://github.com/me/repo/settings" }, ctxWith(engine))
  const perm = t.click.perm({ tabID: "gh", ref: "e1" })
  assert.equal(perm.subject, "click github.com")
  assert.ok(!perm.neverPersist, "the host rule itself may still be saved")
  await t.snapshot.run({ tabID: "gh" }, ctxWith(engine))
  for (const ref of ["e1", "e3", "e4", "e5", "e6", "e11", "e12"]) {
    const { asks, ctx } = askingCtx(engine)
    await t.click.run({ tabID: "gh", ref }, ctx)
    assert.equal(asks.length, 1, `${ref} asks`)
    assert.equal(asks[0].critical, true)
    assert.equal(asks[0].forceAsk, true)
    assert.equal(asks[0].neverPersist, true)
    assert.match(asks[0].subject, /github\.com/)
  }
  // Denied: nothing is clicked.
  const before = calls.filter((c) => c[0] === "click").length
  const denied = askingCtx(engine, false)
  await assert.rejects(t.click.run({ tabID: "gh", ref: "e1" }, denied.ctx), /did not allow.*Delete this repository/)
  assert.equal(calls.filter((c) => c[0] === "click").length, before, "no click after a denial")
  // No permission system at all: refused, not silently clicked.
  await assert.rejects(t.click.run({ tabID: "gh", ref: "e3" }, ctxWith(engine)), /did not allow/)
  // Ordinary buttons: no extra prompt.
  const ok = askingCtx(engine)
  for (const ref of ["e2", "e10"]) await t.click.run({ tabID: "gh", ref }, ok.ctx)
  assert.equal(ok.asks.length, 0, "Save / Star do not ask")
  // A bare Submit on this settings page asks.
  await t.click.run({ tabID: "gh", ref: "e13" }, ok.ctx)
  assert.equal(ok.asks.length, 1)
})

test("a bare Submit asks on payment or account pages, not on an ordinary page", async () => {
  _resetBrowserToolState()
  const plain = riskyBridge("[button] Submit @e1", { url: "https://example.test/search" })
  await t.snapshot.run({ tabID: "gh" }, ctxWith(plain.engine))
  const p = askingCtx(plain.engine)
  await t.click.run({ tabID: "gh", ref: "e1" }, p.ctx)
  assert.equal(p.asks.length, 0)
  _resetBrowserToolState()
  const { engine } = riskyBridge("[button] Submit @e1", { url: "https://bank.example/transfer" })
  await t.snapshot.run({ tabID: "gh" }, ctxWith(engine))
  const { asks, ctx } = askingCtx(engine)
  await t.click.run({ tabID: "gh", ref: "e1" }, ctx)
  assert.equal(asks.length, 1)
})

test("the live element name from the page is used (and the bridge when the tab has no snapshot)", async () => {
  _resetBrowserToolState()
  // Engine with its browser manager: the name is read from the page itself.
  const scripts = []
  const live = { async browserClick() { return { ok: true } }, _browserManager: () => ({ async evaluate(tabID, script) { scripts.push(script); return { tag: "button", type: "submit", name: "Delete account" } } }) }
  const a = askingCtx(live)
  await t.click.run({ tabID: "x", ref: "e5" }, a.ctx)
  assert.equal(a.asks.length, 1)
  assert.match(a.asks[0].subject, /Delete account/)
  assert.match(scripts[0], /data-vibe-ref/)
  // Bridge only, no snapshot of this tab yet: read through browserEvaluate.
  const calls = []
  const bridge = {
    async browserEvaluate(x) { calls.push("evaluate"); return { ok: true, data: { result: { tag: "button", name: "Confirm purchase" } } } },
    async browserClick() { calls.push("click"); return { ok: true } },
  }
  const b = askingCtx(bridge)
  await t.click.run({ tabID: "y", ref: "e1" }, b.ctx)
  assert.deepEqual(calls, ["evaluate", "click"])
  assert.equal(b.asks.length, 1)
})

test("fill never types into password, one-time-code or card fields", async () => {
  _resetBrowserToolState()
  const { engine, calls } = riskyBridge(SNAP)
  await t.snapshot.run({ tabID: "gh" }, ctxWith(engine))
  const c = askingCtx(engine).ctx
  await assert.rejects(t.fill.run({ tabID: "gh", ref: "e7", text: "hunter2" }, c), /never fills passwords.*Ask the user/)
  await assert.rejects(t.fill.run({ tabID: "gh", ref: "e8", text: "123456" }, c), /Refused/)
  await assert.rejects(t.fill.run({ tabID: "gh", ref: "e9", text: "4111 1111 1111 1111" }, c), /card or account number/)
  // Live field facts: type=password, autocomplete=cc-number / one-time-code, name=cvv.
  for (const info of [{ tag: "input", type: "password", name: "" }, { tag: "input", type: "text", autocomplete: "cc-number" }, { tag: "input", type: "text", autocomplete: "one-time-code" }, { tag: "input", type: "tel", fieldName: "card_cvv" }, { tag: "input", type: "text", label: "Verification code" }]) {
    const fills = []
    const live = { async browserFill() { fills.push(1); return { ok: true } }, _browserManager: () => ({ async evaluate() { return info } }) }
    await assert.rejects(t.fill.run({ tabID: "z", ref: "e1", text: "x" }, askingCtx(live).ctx), /Refused/, JSON.stringify(info))
    assert.equal(fills.length, 0)
  }
  assert.equal(calls.filter((x) => x[0] === "fill").length, 0, "nothing was filled")
  // An ordinary field fills without a prompt.
  const ok = askingCtx(engine)
  assert.match(await t.fill.run({ tabID: "gh", ref: "e9", text: "new-repo-name" }, ok.ctx), /Filled e9/)
  assert.equal(ok.asks.length, 0)
})

;(async () => {
  let failed = 0
  for (const [name, fn] of tests) {
    try { await fn(); console.log("PASS " + name) }
    catch (e) { failed++; console.error("FAIL " + name + "\n  " + (e && e.stack || e)) }
  }
  _resetBrowserToolState()
  if (failed) { console.error(`${failed} of ${tests.length} browser tool tests failed`); process.exit(1) }
  console.log(`All ${tests.length} browser tool tests passed`)
})()
