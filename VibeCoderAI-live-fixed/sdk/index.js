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
      switchModel: async (id, profile) => e.switchModel(id, profile),
      prompt: (id, text, o) => e.prompt(id, text, o),
      resume: (id, o) => e.resume(id, o),
      interrupt: async (id) => e.interrupt(id),
      compact: (id) => e.compact(id),
    },
    permission: { reply: async (permissionId, decision) => e.replyPermission(permissionId, decision) },
    subagents: {
      create: async (o) => e.createSubagent(o),
      list: async (sessionId) => e.listSubagents(sessionId),
      status: async (id) => e.subagentStatus(id),
      result: async (id) => e.subagentResult(id),
      stop: async (id) => e.stopSubagent(id),
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
    session: {
      create: (o) => call("POST", "/session", o),
      list: (q = {}) => call("GET", "/session" + (q.dir ? `?dir=${encodeURIComponent(q.dir)}` : "")),
      get: (id) => call("GET", `/session/${id}`),
      messages: async (id) => (await call("GET", `/session/${id}`)).messages,
      rename: (id, title) => call("PATCH", `/session/${id}`, { title }),
      remove: (id) => call("DELETE", `/session/${id}`),
      revert: (id, messageID) => call("POST", `/session/${id}/revert`, { messageID }),
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
      compact: (id) => call("POST", `/session/${id}/compact`, {}),
    },
    permission: { reply: (permissionId, decision) => call("POST", `/permission/${permissionId}`, { decision }) },
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
