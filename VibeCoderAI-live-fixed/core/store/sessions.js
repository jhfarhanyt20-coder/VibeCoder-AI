"use strict"
/** Sessions are JSON files in <VIBE_HOME>/sessions/<id>.json (atomic write). */
const fs = require("fs")
const path = require("path")
const { newId, homeDir } = require("../util")

class SessionStore {
  constructor(home) {
    this.dir = path.join(home || homeDir(), "sessions")
    fs.mkdirSync(this.dir, { recursive: true })
    this.cache = new Map()
    // Tombstones for deleted sessions. A run that is still winding down holds the
    // old session object and calls save() from its finally block (and from inside
    // the agent loop). Without this, deleting a session that has just been used
    // silently rewrote its JSON file a moment later, so the session "came back".
    this.removed = new Set()
  }
  file(id) {
    if (!/^ses_[0-9a-f]+$/.test(id)) throw new Error("Invalid session id")
    return path.join(this.dir, id + ".json")
  }
  create({ dir, profile, title, kind, parentId, agentId }) {
    const now = Date.now()
    const s = {
      id: newId("ses"),
      // `kind`/`parentId` live near the top on purpose: SessionStore._row reads
      // only the first 4 KB of the file to build the session list, so optional
      // metadata must sit before the (potentially huge) messages array.
      ...(kind ? { kind } : {}),
      ...(parentId ? { parentId } : {}),
      ...(agentId ? { agentId } : {}),
      dir: path.resolve(dir || process.cwd()),
      profile,
      title: title || "New session",
      createdAt: now,
      updatedAt: now,
      messages: [],
      todos: [],
      rules: [],
      usage: { lastInput: 0, totalInput: 0, totalOutput: 0 },
      compactions: 0,
    }
    this.save(s)
    return s
  }
  get(id) {
    if (this.removed.has(id)) throw new Error(`Session not found: ${id}`)
    if (this.cache.has(id)) return this.cache.get(id)
    let s
    try {
      s = JSON.parse(fs.readFileSync(this.file(id), "utf8"))
    } catch {
      throw new Error(`Session not found: ${id}`)
    }
    this.cache.set(id, s)
    return s
  }
  save(s) {
    // A deleted session is a tombstone: ignore late saves from a run that is
    // still finishing instead of recreating the file.
    if (this.removed.has(s.id)) return s
    s.updatedAt = Date.now()
    this.cache.set(s.id, s)
    const f = this.file(s.id)
    const tmp = f + "." + process.pid + ".tmp"
    // 1-space JSON + a "messageCount" injected before the huge messages array:
    // list() reads the header without parsing the body (old files fall back).
    const flat = {}
    for (const k of Object.keys(s)) {
      if (k === "messages") flat.messageCount = Array.isArray(s.messages) ? s.messages.length : 0
      flat[k] = s[k]
    }
    fs.writeFileSync(tmp, JSON.stringify(flat, null, 1))
    fs.renameSync(tmp, f)
  }
  /** Header-only read from a small prefix (title/dir/usage never sit behind the
   *  messages array). Falls back to a full parse for files saved by old versions. */
  _row(f, id) {
    let head
    try {
      const fd = fs.openSync(f, "r")
      const buf = Buffer.alloc(4096)
      const n = fs.readSync(fd, buf, 0, 4096, 0)
      fs.closeSync(fd)
      head = buf.toString("utf8", 0, n)
    } catch {
      return null
    }
    const str = (k) => {
      const m = new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(head)
      return m ? JSON.parse('"' + m[1] + '"') : undefined
    }
    const num = (k) => {
      const m = new RegExp(`"${k}":\\s*(\\d+)`).exec(head)
      return m ? Number(m[1]) : undefined
    }
    const idH = str("id")
    if (idH !== id || str("dir") == null || num("createdAt") == null || num("messageCount") == null) {
      const s = this.get(id) // old single-line format: one full parse
      return { id, title: s.title, dir: s.dir, profile: s.profile, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages.length, kind: s.kind, parentId: s.parentId, agentId: s.agentId }
    }
    const live = this.cache.get(id) // a cached (live) session knows its real message count
    return {
      id,
      title: str("title") || "New session",
      dir: str("dir"),
      profile: str("profile"),
      createdAt: num("createdAt"),
      updatedAt: num("updatedAt") || num("createdAt"),
      messages: live ? live.messages.length : num("messageCount") || 0,
      kind: str("kind"),
      parentId: str("parentId"),
      agentId: str("agentId"),
    }
  }
  list({ dir, includeSubagents = false } = {}) {
    const out = []
    for (const n of fs.readdirSync(this.dir)) {
      if (!n.endsWith(".json")) continue
      // V-19 compaction archives are siblings named <id>.archive.json. They are
      // not sessions, and a deleted session's archive must never surface either.
      if (n.endsWith(".archive.json")) continue
      const id = n.slice(0, -5)
      if (this.removed.has(id)) continue
      try {
        const r = this._row(path.join(this.dir, n), id)
        if (!r || (dir && path.resolve(dir) !== r.dir)) continue
        // Subagent sessions are internal child runs. They must not show up in
        // the user's session list; pass includeSubagents for cleanup/telemetry.
        if (r.kind === "subagent" && !includeSubagents) continue
        out.push(r)
      } catch {}
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  rename(id, title) {
    const s = this.get(id)
    s.title = String(title).slice(0, 200)
    this.save(s)
    return s
  }
  remove(id) {
    this.removed.add(id)
    this.cache.delete(id)
    let base = null
    try {
      base = this.file(id)
    } catch {
      return // invalid id: nothing on disk to delete
    }
    // The session file and its V-19 compaction archive (<id>.archive.json) must
    // both go, or the deleted history would linger on disk.
    const archive = base.replace(/\.json$/, ".archive.json")
    for (const f of [base, archive]) {
      try {
        fs.unlinkSync(f)
      } catch {}
    }
    // Clean up an interrupted atomic write for this session, if one is left.
    try {
      const prefix = path.basename(base) + "."
      for (const n of fs.readdirSync(this.dir)) {
        if (n.startsWith(prefix) && n.endsWith(".tmp")) {
          try {
            fs.unlinkSync(path.join(this.dir, n))
          } catch {}
        }
      }
    } catch {}
  }
}

module.exports = { SessionStore }
