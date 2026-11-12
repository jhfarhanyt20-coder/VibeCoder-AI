"use strict"
const assert = require("node:assert/strict")
const path = require("node:path")
const llm = require("../core/llm")
const { runLoop } = require("../core/agent/loop")
const { Engine } = require("../core/engine")

async function main() {
  const session = { id: "pending-test", dir: path.resolve(__dirname, ".."), messages: [], turnSeq: 1, usage: { totalInput: 0, totalOutput: 0 } }
  const ctl = { signal: new AbortController().signal }
  let durable
  const store = { get: () => session, save(value) { durable = JSON.parse(JSON.stringify(value)) } }
  const engine = { runs: new Map([[session.id, ctl]]), store }
  const image = { mime: "image/png", data: "cGVuZGluZw==" }
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
      assert.deepEqual(request.messages.find(m => m.pendingID === "pending-image").parts[1], { type: "image", ...image })
      yield { type: "text", delta: "Received the pending message." }
    }
    yield { type: "finish", reason: "stop" }
  }
  try {
    await runLoop({
      session, store, profile: { id: "test", model: "test" }, apiKey: "", signal: ctl.signal,
      askPermission: async () => true, maxSteps: 4, engine,
      takePendingPrompts: () => [...(session.pendingPrompts || [])],
      emit(event) {
        if (event.type === "tool.start") {
          Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-1", text: "New instructions" })
          Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-1", text: "New instructions" })
          Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-image", text: "", files: [image] })
          assert.equal(session.pendingPrompts.length, 2, "duplicate IPC delivery must be idempotent")
          assert.deepEqual(durable.pendingPrompts[1].files, [image], "attachment-only pending prompts must be durable")
          assert.equal(session.messages.some(m => m.pendingID), false)
        }
        if (event.type === "tool.end") finishedTool = true
        if (event.type === "prompts.attached") { attached = true; assert.deepEqual(event.ids, ["pending-1", "pending-image"]) }
      },
    })
    assert.equal(requests, 2)
    assert.equal(attached, true)
    assert.equal(session.messages.filter(m => m.pendingID === "pending-1").length, 1)
    assert.equal(durable.pendingPrompts.length, 0)
    assert.deepEqual(Engine.prototype.queuePrompt.call(engine, session.id, { id: "pending-image", files: [image] }), { queued: false, attached: true })
    const failed = { ...session, messages: [], pendingPrompts: [{ id: "retain", text: "", files: [image] }] }
    await assert.rejects(runLoop({
      session: failed, store: { save() { throw new Error("disk full") } }, profile: { id: "test", model: "test" }, apiKey: "", signal: ctl.signal,
      askPermission: async () => true, maxSteps: 1, emit() {}, takePendingPrompts: () => [...failed.pendingPrompts],
    }), /disk full/)
    assert.equal(failed.pendingPrompts.length, 1, "failed persistence retains the pending attachment")
    assert.equal(failed.messages.length, 0, "failed persistence rolls back history")
    const source = require("node:fs").readFileSync(path.join(__dirname, "../renderer/app.js"), "utf8")
    const queueSource = source.slice(source.indexOf("const queuedPrompts ="), source.indexOf("let sendInFlight =", source.indexOf("const queuedPrompts =")))
    const composer = { value: "", selectionStart: 0, selectionEnd: 0 }
    const submitted = { kind: "image", name: "queued.png", dataUrl: "data:image/png;base64,cXVldWVk" }
    const current = { kind: "file", name: "draft.txt", path: "draft.txt" }
    const context = {
      attachments: [submitted], state: { activeSessionID: "session", running: true }, crypto: { randomUUID: () => "queue-id" },
      localStorage: { getItem: () => null, setItem() {} }, window: { addEventListener() {} },
      $: (id) => id === "input" ? composer : id === "messages" ? { querySelectorAll: () => [] } : {},
      renderAttachments() {}, addMsg() { return { closest: () => ({ classList: { add() {} }, dataset: {}, querySelector: () => ({}) }) } },
      showRunFailureInline() {}, vibe: { async queuePrompt(payload) { context.payload = payload; context.attachments.push(current); throw new Error("offline") } },
    }
    require("node:vm").createContext(context)
    require("node:vm").runInContext(queueSource + "\nthis.queuePrompt = queuePrompt; this.pending = queuedPrompts; this.clearSubmittedAttachments = clearSubmittedAttachments", context)
    await context.queuePrompt()
    assert.equal(context.payload.files[0].uri, submitted.dataUrl)
    assert.equal(context.pending.length, 1, "failed queue submission retains attachment-only prompt")
    assert.equal(context.pending[0].attachments[0].name, "queued.png")
    assert.deepEqual(context.attachments, [current], "queueing does not steal attachments added during IPC")
    const snapshot = [...context.attachments]
    context.attachments.push(submitted)
    context.clearSubmittedAttachments(snapshot)
    assert.deepEqual(context.attachments, [submitted], "clearing a submitted snapshot leaves later composer attachments")
    const backendSource = require("node:fs").readFileSync(path.join(__dirname, "../electron/backend.cjs"), "utf8")
    const helper = backendSource.slice(backendSource.indexOf("function promptAttachments("), backendSource.indexOf("\nconst handlers ="))
    const attachmentContext = { path, require, Buffer, pickedAttachmentPaths: new Set([path.resolve("notes.txt")]), readAttachmentData: () => ({ kind: "file", name: "notes.txt", size: 5, text: "notes" }) }
    require("node:vm").createContext(attachmentContext)
    require("node:vm").runInContext(helper + "\nthis.convert = promptAttachments", attachmentContext)
    assert.equal(attachmentContext.convert([{ path: "notes.txt" }]).text, "\n\n[Attached file: notes.txt]\nnotes")
    assert.equal(attachmentContext.convert([{ uri: require("node:url").pathToFileURL(path.resolve("notes.txt")).href }]).text.includes("notes"), true, "legacy file URLs must resolve picked files")
    assert.equal(attachmentContext.convert([{ uri: submitted.dataUrl }]).files[0].data, "cXVldWVk")
    assert.throws(() => attachmentContext.convert([{ path: "not-picked.txt" }]), /not selected/)
    const sendSource = source.slice(source.indexOf("async function performSend("), source.indexOf("/* ---------- inactivity watchdog", source.indexOf("async function performSend(")))
    for (const checkpoint of ["owner", "catalog"]) {
      const sendState = { activeSessionID: "session-a", models: [], selectedModel: "test/test" }
      const queued = { sid: "session-a", text: "keep in A", attachments: [{ ...submitted }], files: [{ uri: submitted.dataUrl }] }
      let prompts = 0
      let clears = 0
      const sendContext = {
        state: sendState, $: () => ({ value: "draft for B" }), attachments: [current],
        attachmentFiles() { throw new Error("must use queued attachment snapshot") },
        stopRetryCountdown() {}, hideRetryInline() {}, maybeShowBranchForText() {},
        checkOwnerCode: async () => { if (checkpoint === "owner") sendState.activeSessionID = "session-b"; return { found: false } },
        vibe: { providerCatalog: async () => { sendState.activeSessionID = "session-b"; return { ok: true, data: {} } }, prompt: async () => { prompts++; return { ok: true } } },
        clearSubmittedAttachments() { clears++ },
      }
      require("node:vm").createContext(sendContext)
      require("node:vm").runInContext(sendSource + "\nthis.performSend = performSend", sendContext)
      assert.equal(await sendContext.performSend(queued), false)
      assert.equal(prompts, 0, "session switch before dispatch must not send to another chat")
      assert.equal(clears, 0)
      assert.equal(queued.attachments.length, 1, "aborted preparation retains queued image")
    }
    const profileStore = require("../core/llm/profiles")
    const recipeStore = require("../core/harness/recipes")
    const snapshots = require("../core/store/snapshots")
    const originals = [profileStore.getProfile, profileStore.getKey, recipeStore.expandRecipe, snapshots.clearRedo]
    profileStore.getProfile = () => ({ id: "test" })
    profileStore.getKey = () => ""
    recipeStore.expandRecipe = () => null
    snapshots.clearRedo = () => {}
    try {
      const transaction = { id: "atomic", messages: [], turnSeq: 5, title: "New session", pendingPrompts: [{ id: "atomic-image", text: "", files: [image] }] }
      let failSave = true
      let saves = 0
      let drives = 0
      let acknowledgements = 0
      const fake = {
        home: "unused-test-home", runs: new Map(),
        store: { get: () => transaction, save() { saves++; assert.equal(transaction.pendingPrompts.length, 0); if (failSave) throw new Error("atomic save failed") } },
        _begin(id) { const run = {}; this.runs.set(id, run); return run },
        _runningShellParts: () => [], _takeShellResultParts: () => [], _takeSubagentResultParts: () => [],
        _emit() { acknowledgements++ }, async *_drive() { drives++ },
      }
      await assert.rejects(async () => { for await (const _ of Engine.prototype.prompt.call(fake, "atomic", "", { pendingID: "atomic-image" })) {} }, /atomic save failed/)
      assert.equal(transaction.messages.length, 0)
      assert.equal(transaction.turnSeq, 5)
      assert.equal(transaction.pendingPrompts.length, 1)
      assert.equal(acknowledgements, 0)
      assert.equal(fake.runs.size, 0)
      failSave = false
      for await (const _ of Engine.prototype.prompt.call(fake, "atomic", "", { pendingID: "atomic-image" })) {}
      assert.equal(saves, 2, "one transactional save per attempt")
      assert.equal(drives, 1, "retry must execute, not disappear via pending-ID deduplication")
      assert.equal(acknowledgements, 1)
      assert.equal(transaction.messages.length, 1)
      assert.equal(transaction.pendingPrompts.length, 0)
    } finally {
      ;[profileStore.getProfile, profileStore.getKey, recipeStore.expandRecipe, snapshots.clearRedo] = originals
    }
    console.log("PASS pending prompts: safe tool boundary, durable images/files, queue retention, cross-session send abort, atomic save failure rollback and successful retry")
  } finally { llm.stream = original }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
