"use strict"
// Computer Use: setting gate, safety checks, coordinate mapping and the critical
// permission prompt. A fake executor is used, so nothing moves the real mouse.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createVibe } = require("../sdk")
const computerTools = require("../core/tools/computer")
const { riskOf, ComputerExecutor } = require("../core/computer")

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const tool = (name) => computerTools.ALL.find((t) => t.name === name)

function fakeExecutor(overrides = {}) {
  const calls = []
  const ex = new ComputerExecutor({ home: fs.mkdtempSync(path.join(os.tmpdir(), "vc-cu-")) })
  ex.lastShot = { x: 0, y: 0, w: 1366, h: 768, scale: 1366 / 1280, sentW: 1280, sentH: 720 }
  const state = { foreground: { hwnd: "500", title: "Untitled - Notepad", pid: 4242, process: "notepad" }, password: false, cursor: { x: 10, y: 10 }, ...overrides }
  ex.call = async (cmd, args = {}) => {
    calls.push({ cmd, args })
    switch (cmd) {
      case "cursor": return state.cursor
      case "input_state": return { lastInput: state.lastInput || 0, now: 0, x: state.cursor.x, y: state.cursor.y }
      case "root_at": return state.foreground
      case "focus": { if (state.focusWorks !== false && state.windows && state.windows[args.hwnd]) state.foreground = state.windows[args.hwnd]; return { ...(state.windows && state.windows[args.hwnd] || state.foreground), focused: String(state.foreground.hwnd) === String(args.hwnd) } }
      case "foreground": return state.foreground
      case "focused_password": return state.password
      case "element": return { id: args.id, name: state.elementName || "Save", type: "Button", password: !!state.elementPassword, cx: 400, cy: 300, rect: {} }
      case "point_info": return { name: state.pointName || "", type: "Button", window: state.foreground }
      case "windows": return [state.foreground]
      case "click": case "move": state.cursor = { x: args.x, y: args.y }; return "ok"
      case "scroll": state.cursor = { x: args.x, y: args.y }; return "ok"
      case "drag": state.cursor = { x: args.x2, y: args.y2 }; return "ok"
      case "screenshot": return { data: "AAAA", mime: "image/jpeg", x: 0, y: 0, w: 1366, h: 768, sentW: 1280, sentH: 720, scale: 1366 / 1280, foreground: state.foreground, window: state.foreground, elements: [{ id: 1, type: "Button", name: "File", rect: {} }, { id: 2, type: "Edit", name: "Text editor", value: "", rect: {} }] }
      default: return "ok"
    }
  }
  return { ex, calls, state }
}

function ctxFor(ex, { enabled = true, asks = [], answer = true, ownFront = false } = {}) {
  const engine = {
    computerUse: { enabled, askRisky: true },
    computer: ex,
    computerHooks: { begin: async () => {}, isOwnWindow: () => ownFront },
  }
  return { engine, session: { id: "s1" }, signal: new AbortController().signal, askPermission: async (p) => { asks.push(p); return answer } }
}

test("the tools are offered to the model only while Computer Use is on", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cu-home-"))
  const vibe = createVibe({ home, permission: "ask" })
  const names = () => vibe.engine.extraTools(home).map((t) => t.name).filter((n) => n.startsWith("computer_"))
  assert.deepEqual(names(), [], "off by default outside the desktop app")
  vibe.engine.computerUse.enabled = true
  if (process.platform === "win32") assert.equal(names().length, computerTools.ALL.length)
  vibe.engine.computerUse.enabled = false
  assert.deepEqual(names(), [])
})

test("when off, every computer tool refuses (defence in depth)", async () => {
  const { ex, calls } = fakeExecutor()
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(ex, { enabled: false })), /turned off/)
  await assert.rejects(tool("computer_screenshot").run({}, ctxFor(ex, { enabled: false })), /turned off/)
  assert.equal(calls.length, 0, "no input event was sent")
})

test("screenshot returns the image plus a numbered element list any model can use", async () => {
  if (process.platform !== "win32") return
  const { ex } = fakeExecutor()
  const out = await tool("computer_screenshot").run({}, ctxFor(ex))
  assert.equal(out.__vibeStructuredToolResult, "computer-screenshot")
  assert.equal(out.screenshot.caption, "Computer screenshot")
  assert.match(out.text, /\[1\] Button "File"/)
  assert.match(out.text, /\[2\] Edit "Text editor"/)
  assert.match(out.text, /Window in front: "Untitled - Notepad"/)
})

test("x/y in screenshot pixels map to real screen pixels", () => {
  const ex = new ComputerExecutor({ home: os.tmpdir() })
  ex.lastShot = { x: 100, y: 50, scale: 1.5 }
  assert.deepEqual(ex.toScreen(10, 20), { x: 115, y: 80 })
  assert.deepEqual(ex.toShot(115, 80), { x: 10, y: 20 })
})

test("risky actions ask first (critical, never saved); ordinary ones do not", async () => {
  if (process.platform !== "win32") return
  const asks = []
  const { ex, state } = fakeExecutor({ elementName: "Send" })
  await tool("computer_click").run({ element: 3 }, ctxFor(ex, { asks }))
  assert.equal(asks.length, 1)
  assert.equal(asks[0].critical, true)
  assert.equal(asks[0].neverPersist, true)
  assert.match(asks[0].subject, /click "Send"/)
  // Everyday buttons do not ask: a counter's Reset, Notepad's Format menu, Bold, Save.
  for (const name of ["Reset", "Format", "Bold", "Save", "Add"]) {
    state.elementName = name
    await tool("computer_click").run({ element: 4 }, ctxFor(ex, { asks }))
  }
  assert.equal(asks.length, 1, "ordinary buttons do not ask")
  // Real danger still asks.
  for (const name of ["Factory reset", "Reset this PC", "Format disk", "Delete", "Install"]) {
    state.elementName = name
    await tool("computer_click").run({ element: 4 }, ctxFor(ex, { asks }))
  }
  assert.equal(asks.length, 6, "dangerous buttons ask every time")
  const denied = fakeExecutor({ elementName: "Delete" })
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(denied.ex, { answer: false })), /did not allow/)
  assert.equal(denied.calls.some((c) => c.cmd === "click"), false, "nothing was clicked after a denial")
})

test("risk rules for programs, keys and numbers", () => {
  assert.match(riskOf("launch", { file: "C:\\Downloads\\setup.exe" }), /install/)
  assert.match(riskOf("launch", { file: "msiexec", args: "/i app.msi" }), /install/)
  assert.equal(riskOf("launch", { file: "notepad" }), "")
  assert.equal(riskOf("launch", { file: "C:\\proj\\dist\\MyApp.exe" }), "")
  assert.match(riskOf("key", { keys: "shift+delete" }), /permanent/)
  assert.equal(riskOf("key", { keys: "ctrl+s" }), "")
  assert.match(riskOf("type", { text: "4111 1111 1111 1111" }), /card/)
  assert.equal(riskOf("type", { text: "আমার নাম পরীক্ষা 123" }), "")
})

test("typing refuses password fields and the app's own window", async () => {
  if (process.platform !== "win32") return
  const pw = fakeExecutor({ password: true })
  pw.ex.target = pw.state.foreground
  await assert.rejects(tool("computer_type").run({ text: "secret" }, ctxFor(pw.ex)), /password/)
  assert.equal(pw.calls.some((c) => c.cmd === "type"), false)
  const own = fakeExecutor()
  await assert.rejects(tool("computer_type").run({ text: "hi" }, ctxFor(own.ex, { ownFront: true })), /VibeCoder app itself is in front/)
  await assert.rejects(tool("computer_key").run({ keys: "enter" }, ctxFor(own.ex, { ownFront: true })), /VibeCoder app itself is in front/)
  const ok = fakeExecutor()
  ok.ex.target = ok.state.foreground
  const out = await tool("computer_type").run({ text: "আমার নাম পরীক্ষা 123", enter: true }, ctxFor(ok.ex))
  assert.match(out, /Typed 20 characters into "Untitled - Notepad" and pressed Enter/)
  assert.equal(ok.calls.find((c) => c.cmd === "type").args.text, "আমার নাম পরীক্ষা 123")
})

test("never types into a window that is not the target in front (the Edge/Notepad case)", async () => {
  if (process.platform !== "win32") return
  const notepad = { hwnd: "500", title: "Untitled - Notepad", pid: 4242, process: "notepad" }
  const edge = { hwnd: "900", title: "Settings & privacy | Facebook - Microsoft Edge", pid: 77, process: "msedge" }
  // Working in Notepad, but Edge is in front: nothing may be typed or pressed.
  const a = fakeExecutor({ foreground: edge })
  a.ex.target = notepad
  await assert.rejects(tool("computer_type").run({ text: "hello" }, ctxFor(a.ex)), /window in front is "Settings & privacy.*not "Untitled - Notepad".*Nothing was typed/)
  await assert.rejects(tool("computer_key").run({ keys: "enter" }, ctxFor(a.ex)), /Nothing was typed/)
  assert.equal(a.calls.some((c) => c.cmd === "type" || c.cmd === "keys"), false)
  // No target chosen yet: refuse instead of typing into whatever is in front.
  const b = fakeExecutor({ foreground: edge })
  await assert.rejects(tool("computer_type").run({ text: "hello" }, ctxFor(b.ex)), /Choose the window first/)
  // Element numbers belong to Notepad; Notepad cannot be brought forward: no click at all.
  const c = fakeExecutor({ foreground: edge, focusWorks: false, windows: { 500: notepad, 900: edge } })
  c.ex.elementsWindow = notepad
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(c.ex)), /Could not bring "Untitled - Notepad" to the front.*Nothing was clicked/)
  await assert.rejects(tool("computer_type").run({ text: "hi", element: 1 }, ctxFor(c.ex)), /Nothing was clicked/)
  assert.equal(c.calls.some((x) => x.cmd === "click" || x.cmd === "type"), false)
  // When Notepad can be brought forward, the click and typing go there.
  const d = fakeExecutor({ foreground: edge, windows: { 500: notepad, 900: edge } })
  d.ex.elementsWindow = notepad
  await tool("computer_type").run({ text: "ok", element: 1 }, ctxFor(d.ex))
  assert.equal(d.state.foreground.hwnd, "500")
  assert.ok(d.calls.some((x) => x.cmd === "type"))
})

test("the agent pauses when the user types on the keyboard between steps", async () => {
  if (process.platform !== "win32") return
  const k = fakeExecutor({ lastInput: 5000 })
  k.ex.baselineInput = 1000
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(k.ex)), /using the computer \(keyboard or mouse input/)
  assert.equal(k.calls.some((c) => c.cmd === "click"), false)
})

test("a cursor that only drifted (no real input) does not pause the task", async () => {
  if (process.platform !== "win32") return
  const drift = fakeExecutor({ cursor: { x: 533, y: 300 }, lastInput: 1000 })
  drift.ex.noteCursor(400, 300) // 133 px away, but no new keyboard/mouse input
  drift.ex.baselineInput = 1000
  await tool("computer_click").run({ element: 1 }, ctxFor(drift.ex))
  assert.ok(drift.calls.some((c) => c.cmd === "click"), "the click still runs")
  const hand = fakeExecutor({ cursor: { x: 533, y: 300 }, lastInput: 1200 })
  hand.ex.noteCursor(400, 300) // same distance with real input: pause
  hand.ex.baselineInput = 1000
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(hand.ex)), /using the computer \(the mouse moved \d+ px/)
})

test("the agent stops when the user takes the mouse, hits the corner, or presses the kill switch", async () => {
  if (process.platform !== "win32") return
  const moved = fakeExecutor({ cursor: { x: 900, y: 500 } })
  moved.ex.noteCursor(400, 300)
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(moved.ex)), /using the computer \(the mouse moved \d+ px/)
  const corner = fakeExecutor({ cursor: { x: 0, y: 0 } })
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(corner.ex)), /fail-safe/)
  const killed = fakeExecutor()
  killed.ex.stopped = true
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctxFor(killed.ex)), /Ctrl\+Alt\+Esc/)
  assert.equal(killed.calls.some((c) => c.cmd === "click"), false)
})

test("a critical prompt is not auto-approved even in allow mode", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cu-perm-"))
  const vibe = createVibe({ home, permission: "allow" })
  const engine = vibe.engine
  const session = { id: "sx", dir: home, rules: [] }
  const events = []
  const ask = engine._ask(session, new AbortController().signal, (e) => events.push(e))
  assert.equal(await ask({ tool: "computer", subject: "look at the screen" }), true, "ordinary computer actions are allowed by default")
  const pending = ask({ tool: "computer", subject: "Allow the agent to click \"Send\"?", forceAsk: true, neverPersist: true, critical: true })
  await new Promise((r) => setImmediate(r))
  const askEvent = events.find((e) => e.type === "permission.ask")
  assert.ok(askEvent, "the user is asked")
  assert.equal(askEvent.critical, true)
  engine.replyPermission(askEvent.permissionId, "deny")
  assert.equal(await pending, false)
})

test("CLI parity: setting is on by default and vibe computer on/off saves it", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-cu-cli-"))
  const settings = require("../cli/settings")
  assert.equal(settings.loadSettings(home).computerUse, true, "on by default, like the app")
  assert.equal(settings.saveSettings({ computerUse: false }, home).computerUse, false)
  assert.throws(() => settings.saveSettings({ computerUse: "yes" }, home), /true or false/)
  const { runCommand } = require("../cli/actions")
  const vibe = createVibe({ home, permission: "ask", computerUse: true })
  const ctx = { vibe, dir: home, home, flags: { json: true }, out: { write() {} } }
  const origLog = console.log; console.log = () => {}
  try { await runCommand(ctx, ["computer", "off"]) } finally { console.log = origLog }
  assert.equal(settings.loadSettings(home).computerUse, false)
  assert.equal(vibe.engine.computerUse.enabled, false, "the running engine follows the switch")
  await assert.rejects(runCommand(ctx, ["computer", "maybe"]), /vibe computer on/)
})

test("CLI parity: without the desktop app the helper shows the badge and Ctrl+Alt+Esc stops the run", async () => {
  const { ex, calls } = fakeExecutor()
  const interrupted = []
  const engine = { computerUse: { enabled: true, askRisky: true }, computer: ex, computerHooks: null, runs: new Map([["s1", {}]]), interrupt: (id) => interrupted.push(id), _emit: () => {} }
  const ctx = { engine, session: { id: "s1" }, signal: new AbortController().signal, askPermission: async () => true }
  await tool("computer_screenshot").run({}, ctx)
  assert.ok(engine.computerHooks && engine.computerHooks.standalone, "default hooks are installed")
  assert.ok(calls.some((c) => c.cmd === "overlay" && c.args.show === true && c.args.hotkey === true), "badge shown and hotkey registered")
  ex.onEvent({ event: "kill" })
  assert.equal(ex.stopped, true)
  assert.deepEqual(interrupted, ["s1"])
  assert.ok(calls.some((c) => c.cmd === "overlay" && c.args.show === false), "badge hidden")
  await assert.rejects(tool("computer_click").run({ element: 1 }, ctx), /Ctrl\+Alt\+Esc/)
  engine.computerHooks.end({ sessionId: "s1" })
  assert.equal(ex.stopped, false, "the next task may use the computer again")
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS computer use: ${t.name}`) }
    catch (e) { console.error(`FAIL computer use: ${t.name}`); console.error(e); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} computer use tests passed`)
  if (passed !== tests.length) process.exit(1)
})()
