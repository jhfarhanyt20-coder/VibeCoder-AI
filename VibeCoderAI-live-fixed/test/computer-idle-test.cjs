"use strict"
// Computer Use is on only while it is used: the first action turns it on, it
// turns itself off a moment after the last one (or at once with computer_done),
// and the next action turns it on again. A fake helper; nothing is clicked.
const assert = require("node:assert/strict")
const { ALL } = require("../core/tools/computer")

if (process.platform !== "win32") {
  console.log("SKIP computer idle: Computer Use is Windows only")
  process.exit(0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const T = (n) => ALL.find((t) => t.name === n)

;(async () => {
  const events = []
  let released = 0
  const fakeEx = {
    stopped: false,
    async call(cmd) {
      if (cmd === "windows") { await sleep(30); return [] }
      return {}
    },
    async checkUserTookOver() {},
    log() {},
    async releaseAll() { released++ },
  }
  const engine = {
    computerUse: { enabled: true },
    computer: fakeEx,
    computerIdleOffMs: 120,
    computerHooks: {
      async begin() { events.push("on") },
      end(info = {}) { events.push(`off:${info.reason || ""}`) },
    },
  }
  const ctx = { engine, session: { id: "s1" } }

  assert(T("computer_done"), "computer_done is offered")
  assert.match(require("../core/tools/computer").GUIDE, /call computer_done before you answer/)

  // One action: on, then off by itself shortly after it ends (not during it).
  await T("computer_windows").run({}, ctx)
  assert.deepEqual(events, ["on"])
  await sleep(60)
  assert.deepEqual(events, ["on"], "not off right away")
  await sleep(120)
  assert.deepEqual(events, ["on", "off:idle"], "off by itself after the idle time")
  assert(released >= 1, "keys and buttons are let go")

  // Actions close together keep it on; computer_done turns it off at once.
  events.length = 0
  await T("computer_windows").run({}, ctx)
  await sleep(50)
  await T("computer_windows").run({}, ctx)
  assert.deepEqual(events.filter((e) => e.startsWith("off")), [], "stays on between close actions")
  assert.match(await T("computer_done").run({}, ctx), /Computer Use is off/)
  assert.equal(events.at(-1), "off:done")
  await sleep(200)
  assert.equal(events.filter((e) => e.startsWith("off")).length, 1, "no second off after done")

  // While an action is still running, done does not cut it off.
  events.length = 0
  const running = T("computer_windows").run({}, ctx)
  await sleep(5)
  assert.match(await T("computer_done").run({}, ctx), /still finishing/)
  await running
  await sleep(200)
  assert.equal(events.at(-1), "off:idle", "turned off after the action ended")
  console.log("PASS computer idle: on while used, off by itself after the last action or at once with computer_done")
})().catch((e) => { console.error(e); process.exit(1) })
