"use strict"
// Computer Use helps weaker models: every action reports what really changed,
// hidden controls are marked, models without vision are told so, zoom exists.
const assert = require("node:assert/strict")
const { ALL, GUIDE, changeReport } = require("../core/tools/computer")
const { modelSeesImages } = require("../core/agent/loop")
const pm = require("../core/llm/provider-meta")

const el = (id, type, name, extra = {}) => ({ id, type, name, ...extra })
// A click that changed a label: the old text is gone, the new one is listed with its number.
let r = changeReport([el(1, "Button", "Add"), el(2, "Text", "Count: 0")], [el(1, "Button", "Add"), el(2, "Text", "Count: 1")], true)
assert.match(r, /\+ \[2\] Text \(shows\) "Count: 1"/)
assert.match(r, /- gone: Text "Count: 0"/)
// Nothing changed: the model is told the action may not have worked.
r = changeReport([el(1, "Button", "Add")], [el(1, "Button", "Add")], true)
assert.match(r, /No control in this window changed/)
assert.match(r, /two failures/)
// Field value, enabled state and visibility changes are reported.
r = changeReport([el(1, "Edit", "Name", { value: "" }), el(2, "Button", "Save", { enabled: false })], [el(1, "Edit", "Name", { value: "Bob" }), el(2, "Button", "Save", { enabled: true, hidden: "covered by another control" })], true)
assert.match(r, /value "" → "Bob"/)
assert.match(r, /now enabled/)
assert.match(r, /now NOT visible/)
// Another window came to the front: its controls are listed with fresh numbers.
r = changeReport([el(1, "Button", "Old")], [el(1, "Button", "OK"), el(2, "Text", "Saved")], false)
assert.match(r, /controls now \(fresh numbers\)[\s\S]*\[1\] Button "OK"/)

// Tools and guidance.
const names = ALL.map((t) => t.name)
assert(names.includes("computer_zoom"), "a zoom tool exists")
assert.match(GUIDE, /plan the whole task/)
assert.match(GUIDE, /What changed/)
assert.match(GUIDE, /NOT visible/)

// Vision: the profile switch alone is not enough when the catalog says no.
assert.equal(modelSeesImages({ image: false, model: "gpt-5.6-sol" }), false)
assert.equal(modelSeesImages({ image: true, model: "totally-unknown-model-xyz" }), true, "unknown models trust the profile switch")
if (pm.modelImageSupport("grok-3") === false) assert.equal(modelSeesImages({ image: true, model: "grok-3" }), false, "a known text-only model gets no images")
console.log("PASS computer smart: change reports, hidden controls, zoom, vision honesty")

// computer_steps: several planned actions in one call, numbers stay stable,
// one change report at the end, stops at the first failing step, risky steps still ask.
;(async () => {
  if (process.platform !== "win32") return console.log("SKIP computer_steps (Windows only)")
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path")
  const { ComputerExecutor } = require("../core/computer")
  const steps = ALL.find((t) => t.name === "computer_steps")
  const make = ({ elementName = "Add note", password = false } = {}) => {
    const calls = []
    let count = 0
    const fg = { hwnd: "700", title: "Vibe Notes Test", process: "powershell" }
    const ex = new ComputerExecutor({ home: fs.mkdtempSync(path.join(os.tmpdir(), "vc-steps-")) })
    ex.lastShot = { x: 0, y: 0, w: 800, h: 600, scale: 1, sentW: 800, sentH: 600 }
    ex.elementsWindow = fg
    ex.lastElementsList = [{ id: 1, type: "Edit", name: "New note", value: "" }, { id: 2, type: "Button", name: "Add note" }, { id: 3, type: "Text", name: "Status: 0 notes" }]
    ex.target = fg
    ex.call = async (cmd, args = {}) => {
      calls.push(cmd)
      switch (cmd) {
        case "input_state": return { lastInput: 0, now: 0, x: 10, y: 10 }
        case "cursor": return { x: 10, y: 10 }
        case "foreground": case "root_at": return fg
        case "focus": return { ...fg, focused: true }
        case "focused_password": return password
        case "element": return { id: args.id, name: args.id === 1 ? "New note" : elementName, type: args.id === 1 ? "Edit" : "Button", password: false, cx: 100, cy: 100 }
        case "click": if (args.x === 100 && calls.filter((c) => c === "click").length % 2 === 0) count++; return "ok"
        case "scan": return { window: fg, elements: [{ id: 1, type: "Edit", name: "New note", value: "" }, { id: 2, type: "Button", name: "Add note" }, { id: 3, type: "Text", name: `Status: ${count} notes` }] }
        default: return "ok"
      }
    }
    const asks = []
    const ctx = { engine: { computerUse: { enabled: true, askRisky: true }, computer: ex, computerHooks: { begin: async () => {}, isOwnWindow: () => false } }, session: { id: "s" }, signal: new AbortController().signal, askPermission: async (p) => { asks.push(p); return true } }
    return { ex, calls, ctx, asks }
  }
  // Two notes in one call.
  let t = make()
  let out = await steps.run({ steps: [{ action: "type", element: 1, text: "apple" }, { action: "click", element: 2 }, { action: "type", element: 1, text: "banana" }, { action: "click", element: 2 }] }, t.ctx)
  assert.match(out, /Did 4 of 4 steps/)
  const firstScan = t.calls.indexOf("scan")
  assert.equal(firstScan, t.calls.lastIndexOf("scan"), "one re-scan at the end only: numbers stay those of the screenshot")
  assert(firstScan > t.calls.lastIndexOf("click"), "the re-scan comes after the last step")
  assert.match(out, /What changed[\s\S]*Status: 2 notes/)
  assert.equal(t.ex.batching, false)
  // A failing step stops the batch.
  t = make({ password: true })
  out = await steps.run({ steps: [{ action: "type", element: 1, text: "x" }, { action: "click", element: 2 }] }, t.ctx)
  assert.match(out, /Did 0 of 2 steps[\s\S]*Stopped: step 1 \(type\) failed: .*password/)
  assert.equal(t.calls.includes("click") && t.calls.filter((c) => c === "click").length > 1, false, "nothing after the failed step")
  // A risky step inside a batch still asks the user.
  t = make({ elementName: "Delete selected" })
  out = await steps.run({ steps: [{ action: "click", element: 2 }] }, t.ctx)
  assert(t.asks.some((a) => a.critical && /Delete selected/.test(a.subject)), "risky click asks even inside computer_steps")
  // The Win+R → type command → Enter chain inside one batch asks before Win+R.
  t = make()
  t.ctx.askPermission = async (p) => { t.asks.push(p); return false }
  out = await steps.run({ steps: [{ action: "key", keys: "win+r" }, { action: "type", text: "powershell -c calc" }, { action: "key", keys: "enter" }] }, t.ctx)
  assert.match(out, /Stopped: step 1 \(key\) failed: .*did not allow/)
  assert.equal(t.calls.includes("keys") || t.calls.includes("type"), false, "nothing pressed or typed after the denial")
  // Unknown action.
  out = await steps.run({ steps: [{ action: "fly" }] }, make().ctx)
  assert.match(out, /unknown action "fly"/)
  console.log("PASS computer_steps: batch in one call, stable numbers, one report, stops on failure, risky still asks")
})().catch((e) => { console.error("FAIL computer_steps", e); process.exit(1) })

// CLI without a terminal: a risky action waits a bounded time for the app, then is refused (never hangs).
;(async () => {
  const ui = require("../cli/ui")
  if (typeof ui.askPermission !== "function") return console.log("SKIP critical wait (askPermission not exported)")
  process.env.VIBE_CRITICAL_WAIT_MS = "60"
  const lines = []
  const t0 = Date.now()
  const r = await ui.askPermission(null, { tool: "computer", subject: "Allow the agent to click Delete?", critical: true }, { yes: true }, (l) => lines.push(String(l)))
  assert.equal(r, "deny", "refused after the wait")
  assert(Date.now() - t0 < 2000)
  assert(lines.some((l) => /nobody approved/.test(l)))
  // An answer from the app during the wait ends it without a CLI decision.
  process.env.VIBE_CRITICAL_WAIT_MS = "5000"
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 30)
  assert.equal(await ui.askPermission(null, { tool: "computer", subject: "x", critical: true }, { yes: true }, () => {}, ac.signal), null)
  delete process.env.VIBE_CRITICAL_WAIT_MS
  console.log("PASS CLI critical approval: bounded wait, then refused; the app's answer still wins")
})().catch((e) => { console.error("FAIL critical wait", e); process.exit(1) })

// Long screen runs: only the newest screenshots go to the model again (2-5),
// the cut moves in steps so the provider's prompt cache keeps working.
{
  const { recentScreenshotsOnly } = require("../core/agent/loop")
  const shot = (n) => ({ role: "user", parts: [{ type: "tool_result", id: "c" + n, output: "shot " + n, screenshot: { data: "A" + n, mime: "image/jpeg", modelVisible: true } }] })
  const sent = (n) => recentScreenshotsOnly([...Array(n)].map((_, i) => shot(i + 1))).map((m, i) => (m.parts[0].screenshot.modelVisible ? i + 1 : 0)).filter(Boolean)
  assert.deepEqual(sent(5), [1, 2, 3, 4, 5], "short runs are untouched")
  assert.deepEqual(sent(6), [5, 6])
  assert.deepEqual(sent(9), [5, 6, 7, 8, 9], "the cut stays put between steps (cache-friendly)")
  assert.deepEqual(sent(10), [9, 10])
  const msgs = [...Array(10)].map((_, i) => shot(i + 1))
  const out = recentScreenshotsOnly(msgs)
  assert.equal(msgs[0].parts[0].screenshot.modelVisible, true, "the saved history is not changed")
  assert.match(out[0].parts[0].output, /older screenshot was here/)
  console.log("PASS screenshot history: only recent images resent, cache-friendly cut, history untouched")
}

{
  // A new control at the top renumbers the rest: the model is told the new numbers.
  const before = [el(1, "Button", "A"), el(2, "Button", "B"), el(3, "Button", "Save")]
  const after = [el(1, "MenuItem", "New"), el(2, "Button", "A"), el(3, "Button", "B"), el(4, "Button", "Save")]
  const rep = changeReport(before, after, true)
  assert.match(rep, /\+ \[1\] MenuItem/)
  assert.match(rep, /numbers SHIFTED/)
  assert.match(rep, /\[4\] Button "Save" \(was \[3\]\)/)
  // Same controls, same numbers: no shift note.
  assert.doesNotMatch(changeReport(before, before, true), /SHIFTED/)
  // Enter in a chat app asks first; Enter elsewhere does not.
  const { riskOf } = require("../core/computer")
  assert.match(riskOf("key", { keys: "enter", window: "WhatsApp" }), /may send a message/)
  assert.equal(riskOf("key", { keys: "enter", window: "Untitled - Notepad notepad" }), "")
  assert.match(riskOf("key", { keys: "shift+delete" }), /permanent delete/)
  console.log("PASS computer numbers: shifted element numbers are reported; Enter in chat apps asks first")
}
