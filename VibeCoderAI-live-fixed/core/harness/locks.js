"use strict"
/**
 * Locks — hard, non-interactive deny rules.
 *
 * A lock can only block. It never grants access, never asks, and cannot be
 * overridden by a session "always allow" approval. Locks are evaluated before
 * the normal permission rules.
 *
 * Accepted shapes (all three are equivalent):
 *   { "action": "bash", "resource": "git push *", "effect": "block" }
 *   { "tool": "bash", "pattern": "git push *", "effect": "block" }
 *   { "tool": "bash", "pattern": "git push *", "action": "deny" }
 *
 * Files (both optional):
 *   ~/.vibe/locks.json        global
 *   <workspace>/.vibe/locks.json
 *
 * Project entries come after global entries, so a project can add a narrow
 * exception with `{ "effect": "allow" }` when the global file already blocked
 * the broader action. The last matching entry wins, exactly like the normal
 * permission rules.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")
const { decide } = require("../perm/rules")

const globalFile = (home) => path.join(home || homeDir(), "locks.json")
const globalJsoncFile = (home) => path.join(home || homeDir(), "locks.jsonc")
const projectFile = (dir) => path.join(dir || process.cwd(), ".vibe", "locks.json")
const projectJsoncFile = (dir) => path.join(dir || process.cwd(), ".vibe", "locks.jsonc")

/** Remove // and block comments outside strings. Keeps JSON values intact. */
function stripJsonComments(text) {
  const src = String(text == null ? "" : text)
  let out = ""
  let inString = false
  let escaped = false
  let line = false
  let block = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    const next = src[i + 1]
    if (line) {
      if (ch === "\n" || ch === "\r") {
        line = false
        out += ch
      }
      continue
    }
    if (block) {
      if (ch === "*" && next === "/") {
        block = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      line = true
      i++
      continue
    }
    if (ch === "/" && next === "*") {
      block = true
      i++
      continue
    }
    out += ch
  }
  return out
}

function normalizeLock(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const tool = String(raw.tool || raw.action || "*").trim() || "*"
  const pattern = String(raw.pattern || raw.resource || "*").trim() || "*"
  const effect = String(raw.effect || raw.action_effect || (raw.action === "deny" ? "deny" : "block")).trim().toLowerCase()
  // A lock whose effect is not a recognised block/deny is ignored rather than
  // silently turning into an allow. "allow" exists only for narrow exceptions.
  if (effect === "allow") return { tool, pattern, action: "allow", lock: true }
  if (effect === "block" || effect === "deny") return { tool, pattern, action: "deny", lock: true }
  return null
}

/** Parse one lock file. Returns { locks, error } and never throws. */
function readLocks(file) {
  try {
    if (!file || !fs.existsSync(file)) return { locks: [], error: null }
    const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")
    const data = JSON.parse(stripJsonComments(text))
    const list = Array.isArray(data) ? data : data && Array.isArray(data.locks) ? data.locks : []
    return { locks: list.map(normalizeLock).filter(Boolean), error: null }
  } catch (error) {
    return { locks: [], error: error && error.message ? error.message : String(error) }
  }
}

function loadLocks({ home, dir } = {}) {
  const globalBase = home || homeDir()
  const out = []
  for (const file of [globalFile(globalBase), globalJsoncFile(globalBase)]) out.push(...readLocks(file).locks)
  if (dir) for (const file of [projectFile(dir), projectJsoncFile(dir)]) out.push(...readLocks(file).locks)
  return out
}

/** True when the last matching lock entry is a block. */
function isLocked(locks, tool, subject) {
  if (!Array.isArray(locks) || !locks.length) return false
  return decide(locks, tool, subject) === "deny"
}

module.exports = {
  globalFile,
  globalJsoncFile,
  projectFile,
  projectJsoncFile,
  stripJsonComments,
  normalizeLock,
  readLocks,
  loadLocks,
  isLocked,
}
