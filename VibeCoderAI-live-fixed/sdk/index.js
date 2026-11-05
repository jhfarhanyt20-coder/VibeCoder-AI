"use strict"
/**
 * Vibe SDK - same API in two modes.
 *   const vibe = createVibe({ ...engineOptions })                    // runs the engine inside your process
 *   const vibe = connect({ url: "http://127.0.0.1:4096", token })    // talks to `vibe serve`
 *
 *   const s = await vibe.session.create({ dir, profile: "groq-gpt-oss-120b" })
 *   for await (const ev of vibe.session.prompt(s.id, "fix the bug")) { ... }
 *   await vibe.permission.reply(ev.permissionId, "once" | "always" | "deny")
 *
 * Event types: text.delta, reasoning.delta, tool.start, tool.end, permission.ask, todo.update,
 *              usage, compaction.start, compaction.end, error, done
 */
const { Engine } = require("../core/engine")
const { parseSSE } = require("../core/llm/sse")

function createVibe(opts = {}) {
  const e = new Engine(opts)
  return {
    mode: "inproc",
    engine: e,
    session: {
      create: async (o) => e.createSession(o),
      list: async (q) => e.listSessions(q),
      get: async (id) => e.getSession(id),
      messages: async (id) => e.getSession(id).messages,
      rename: async (id, title) => e.renameSession(id, title),
      remove: async (id) => e.removeSession(id),
      revert: async (id, messageID) => e.revertSession(id, messageID),
      undo: async (id, messageID) => e.undoSession(id, messageID),
      undoStep: async (id, turn, step) => e.undoStepSession(id, turn, step),
      redo: async (id) => e.redoSession(id),
      snapshots: async (id) => e.listSnapshots(id),
      snapshotSteps: async (id) => e.listStepSnapshots(id),
      snapshotPreview: async (id, options) => e.previewSnapshot(id, options),
      redos: async (id) => e.listRedo(id),
      switchModel: async (id, profile) => e.switchModel(id, profile),
      prompt: (id, text, o) => e.prompt(id, text, o),
      resume: (id, o) => e.resume(id, o),
      interrupt: async (id) => e.interrupt(id),
      compact: (id, o) => e.compact(id, o),
    },
    permission: { reply: async (permissionId, decision) => e.replyPermission(permissionId, decision) },
    forms: {
      list: async (sessionID) => e.listForms(sessionID),
      reply: async (formID, answer) => ({ replied: e.replyForm(formID, answer) }),
      cancel: async (formID, message) => ({ cancelled: e.cancelForm(formID, message) }),
    },
    subagents: {
      create: async (o) => e.createSubagent(o),
      list: async (sessionId) => e.listSubagents(sessionId),
      status: async (id) => e.subagentStatus(id),
      result: async (id) => e.subagentResult(id),
      details: async (id) => e.subagentDetails(id),
      resume: async (id, text, o) => e.resumeSubagent(id, text, o),
      stop: async (id) => e.stopSubagent(id),
    },
    connectors: {
      resources: async (o = {}) => e.listConnectorResources(o.connector, o.directory),
      templates: async (o = {}) => e.listConnectorResourceTemplates(o.connector, o.directory),
      read: async (o = {}) => e.readConnectorResource(o.connector, o.uri, o.directory),
      beginOAuth: async (o = {}) => e.beginConnectorOAuth(o.connector, o.redirectUri, o.directory),
      completeOAuth: async (o = {}) => e.completeConnectorOAuth(o.state, o.code),
      clearOAuth: async (o = {}) => e.clearConnectorOAuth(o.connector, o.directory),
    },
    browser: {
      current: async (o) => e.browserCurrent(o),
      listTabs: async () => e.browserListTabs(),
      createTab: async (o) => e.browserCreateTab(o),
      closeTab: async (o) => e.browserCloseTab(o),
      navigate: async (o) => e.browserNavigate(o),
      screenshot: async (o) => e.browserScreenshot(o),
      evaluate: async (o) => e.browserEvaluate(o),
      snapshot: async (o) => e.browserSnapshot(o),
      click: async (o) => e.browserClick(o),
      fill: async (o) => e.browserFill(o),
      press: async (o) => e.browserPress(o),
      scroll: async (o) => e.browserScroll(o),
    },
    todos: {
      list: async (id) => e.todoList(id),
      save: async (id, items) => e.todoSave(id, items),
    },
    profiles: { list: async () => e.listProfiles(), upsert: async (p) => e.upsertProfile(p), setKey: async (id, key) => e.setKey(id, key) },
    event: { subscribe: (fn) => e.on(fn) },
  }
}

function connect({ url, token }) {
  const base = url.replace(/\/+$/, "")
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
    return j
  }
  async function* sseStream(method, p, body, signal) {
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
    for await (const ev of parseSSE(r.body)) yield JSON.parse(ev.data)
  }
  return {
    mode: "remote",
    connectors: {
      resources: (o = {}) => call("GET", `/connectors/resources?connector=${encodeURIComponent(o.connector || "")}&directory=${encodeURIComponent(o.directory || "")}`),
      templates: (o = {}) => call("GET", `/connectors/templates?connector=${encodeURIComponent(o.connector || "")}&directory=${encodeURIComponent(o.directory || "")}`),
      read: (o = {}) => call("POST", "/connectors/read", o),
      beginOAuth: (o = {}) => call("POST", "/connectors/oauth/start", o),
      completeOAuth: (o = {}) => call("POST", "/connectors/oauth/complete", o),
      clearOAuth: (o = {}) => call("POST", "/connectors/oauth/clear", o),
    },
    session: {
      create: (o) => call("POST", "/session", o),
      list: (q = {}) => call("GET", "/session" + (q.dir ? `?dir=${encodeURIComponent(q.dir)}` : "")),
      get: (id) => call("GET", `/session/${id}`),
      messages: async (id) => (await call("GET", `/session/${id}`)).messages,
      rename: (id, title) => call("PATCH", `/session/${id}`, { title }),
      remove: (id) => call("DELETE", `/session/${id}`),
      revert: (id, messageID) => call("POST", `/session/${id}/revert`, { messageID }),
      undo: (id, messageID) => call("POST", `/session/${id}/undo`, { messageID }),
      undoStep: (id, turn, step) => call("POST", `/session/${id}/undo-step`, { turn, step }),
      redo: (id) => call("POST", `/session/${id}/redo`),
      snapshots: (id) => call("GET", `/session/${id}/snapshots`),
      snapshotSteps: (id) => call("GET", `/session/${id}/snapshot-steps`),
      snapshotPreview: (id, options = {}) => call("POST", `/session/${id}/snapshot-preview`, options),
      redos: (id) => call("GET", `/session/${id}/redos`),
      switchModel: (id, profile) => call("POST", `/session/${id}/model`, { profile }),
      async *prompt(id, text, o = {}) {
        const ctl = new AbortController()
        if (o.signal) o.signal.addEventListener("abort", () => ctl.abort(), { once: true })
        try {
          yield* sseStream("POST", `/session/${id}/prompt`, { text, files: o.files }, ctl.signal)
        } finally {
          ctl.abort()
        }
      },
      async *resume(id, o = {}) {
        const ctl = new AbortController()
        if (o.signal) o.signal.addEventListener("abort", () => ctl.abort(), { once: true })
        try {
          yield* sseStream("POST", `/session/${id}/resume`, {}, ctl.signal)
        } finally {
          ctl.abort()
        }
      },
      interrupt: (id) => call("POST", `/session/${id}/interrupt`, {}),
      compact: (id, o = {}) => call("POST", `/session/${id}/compact`, o),
    },
    permission: { reply: (permissionId, decision) => call("POST", `/permission/${permissionId}`, { decision }) },
    forms: {
      list: (sessionID) => call("GET", "/form" + (sessionID ? `?sessionID=${encodeURIComponent(sessionID)}` : "")),
      reply: (formID, answer) => call("POST", `/form/${encodeURIComponent(formID)}/reply`, { answer }),
      cancel: (formID, message) => call("POST", `/form/${encodeURIComponent(formID)}/cancel`, { message }),
    },
    profiles: { list: () => call("GET", "/profiles") },
    event: {
      subscribe(fn) {
        const ctl = new AbortController()
        ;(async () => {
          try {
            for await (const ev of sseStream("GET", "/events", undefined, ctl.signal)) fn(ev)
          } catch {}
        })()
        return () => ctl.abort()
      },
    },
  }
}

module.exports = { createVibe, connect }
