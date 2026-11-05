"use strict"
/**
 * Trail — a small, append-only audit log for one session.
 *
 * The live event stream carries text deltas and other high-frequency traffic.
 * The Trail deliberately records only durable, useful checkpoints (tool calls,
 * permissions, compaction, subagent work, errors, completion), so it stays
 * small and can be read after a crash.
 *
 * File: ~/.vibe/trail/<session-id>.jsonl
 *
 * Secrets are redacted and long strings are clipped before writing. A failure
 * to log must never fail the agent run.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")
const { redactText } = require("./guard")

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_STRING = 4000
const MAX_DEPTH = 5
const SECRET_KEY = /(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|passwd|authorization|cookie|credential|private[-_]?key)/i

const safeId = (value) => {
  const id = String(value == null ? "" : value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120)
  return id || "unknown"
}

function clipString(value) {
  const text = String(value)
  return text.length > MAX_STRING ? text.slice(0, MAX_STRING) + `…[clipped ${text.length - MAX_STRING} chars]` : text
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value
  if (typeof value === "string") return clipString(redactText(value))
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint") return String(value)
  if (typeof value === "function" || typeof value === "symbol") return undefined
  if (depth >= MAX_DEPTH) return "[deep]"
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    return value.slice(0, 100).map((item) => redact(item, depth + 1, seen))
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]"
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) out[key] = "[redacted]"
      else out[key] = redact(item, depth + 1, seen)
    }
    return out
  }
  return clipString(value)
}

class Trail {
  constructor({ home, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.home = home || homeDir()
    this.root = path.join(this.home, "trail")
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || DEFAULT_MAX_BYTES)
  }

  fileFor(sessionId) {
    return path.join(this.root, `${safeId(sessionId)}.jsonl`)
  }

  _rotate(file) {
    try {
      if (!fs.existsSync(file)) return
      if (fs.statSync(file).size < this.maxBytes) return
      const backup = file + ".1"
      try { fs.rmSync(backup, { force: true }) } catch {}
      fs.renameSync(file, backup)
    } catch {}
  }

  /** Append one event. Returns false instead of throwing on any failure. */
  append(sessionId, event) {
    if (!sessionId || !event || typeof event !== "object") return false
    try {
      const file = this.fileFor(sessionId)
      this._rotate(file)
      fs.mkdirSync(this.root, { recursive: true })
      const record = { ...redact(event), time: event.time || Date.now() }
      fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8")
      return true
    } catch {
      return false
    }
  }

  /** Read the last `limit` events in chronological order. */
  read(sessionId, limit = 200) {
    try {
      const file = this.fileFor(sessionId)
      if (!fs.existsSync(file)) return []
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      const max = Math.max(1, Math.min(5000, Number(limit) || 200))
      return lines.slice(-max).map((line) => {
        try { return JSON.parse(line) } catch { return { type: "trail.invalid", raw: clipString(line) } }
      })
    } catch {
      return []
    }
  }

  remove(sessionId) {
    try {
      fs.rmSync(this.fileFor(sessionId), { force: true })
      fs.rmSync(this.fileFor(sessionId) + ".1", { force: true })
      return true
    } catch {
      return false
    }
  }
}

/** Event types worth keeping. Everything else stays live-only. */
const TRAIL_EVENTS = new Set([
  "run.start",
  "step.start",
  "step.end",
  "recipe.start",
  "tool.start",
  "tool.end",
  "permission.ask",
  "permission.lock",
  "permission.decision",
  "permission.reply",
  "compaction.start",
  "compaction.end",
  "subagent.start",
  "subagent.end",
  "subagent.error",
  "question.ask",
  "question.answer",
  "question.cancelled",
  "notice",
  "error",
  "done",
])

const shouldTrail = (event) => !!event && TRAIL_EVENTS.has(String(event.type || ""))

module.exports = { Trail, TRAIL_EVENTS, shouldTrail, redact, clipString, safeId }
