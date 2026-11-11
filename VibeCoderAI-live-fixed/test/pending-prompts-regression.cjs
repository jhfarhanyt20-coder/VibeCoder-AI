"use strict"
const assert = require("node:assert/strict")
const path = require("node:path")
const llm = require("../core/llm")
const { runLoop } = require("../core/agent/loop")
const { Engine } = require("../core/engine")

async function main() {
  const session = { id: "pending-test", dir: path.resolve(__dirname, ".."), messages: [], turnSeq: 1, usage: { totalInput: 0, totalOutput: 0 } }
  const ctl = { signal: new AbortController().signal }
  const engine = { runs: new Map([[session.id, ctl]]) }
  let finishedTool = false
  let requests = 0
  let attached = false
  const original = llm.stream
  llm.stream = async function* (_profile, request) {
    requests++
    if (requests === 1) {
      yield { type: "tool_call", id: "read-1", name: "read", args: { path: "package.json", limit: 2 } }
    } else {
      assert.equal(finishedTool, true, "the in-flight tool must finish before the pending prompt is consumed")
      assert.equal(request.messages.some(m => m.pendingID === "pending-1" && m.parts[0].text === "New instructions"), true)
      yield { type: "text", delta: "Received the pending message." }
    }
    yield { type: "finish", reason: "stop" }
  }
  try {
    await runLoop({
      session, store: { save() {} }, profile: { id: "test", model: "test" }, apiKey: "", signal: ctl.signal,
      askPermission: async () => true, maxSteps: 4, engine,
      takePendingPrompts: () => (ctl.userPrompts || []).splice(0),
      emit(event) {
        if (event.type === "tool.start") {
          Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-1", text: "New instructions" })
          Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-1", text: "New instructions" })
          assert.equal(ctl.userPrompts.length, 1, "duplicate IPC delivery must be idempotent")
          assert.equal(session.messages.some(m => m.pendingID), false)
        }
        if (event.type === "tool.end") finishedTool = true
        if (event.type === "prompts.attached") { attached = true; assert.deepEqual(event.ids, ["pending-1"]) }
      },
    })
    assert.equal(requests, 2)
    assert.equal(attached, true)
    assert.equal(session.messages.filter(m => m.pendingID === "pending-1").length, 1)
    console.log("PASS pending prompts: current tool completes first, next model step receives the message once, normal user history is persisted and acknowledgement is emitted")
  } finally { llm.stream = original }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
