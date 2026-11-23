"use strict"
/**
 * "Always allow" for shell commands, remembered as a command family instead of
 * the exact text: approving `git commit -m "fix"` once also allows later
 * `git commit -m "other"`, `npm run build` allows `npm run build -- --watch`.
 *
 * Only well-known command families are generalized; anything else is still
 * remembered exactly. A family rule matches a command segment only when the
 * segment tokenizes cleanly (no comments, redirects, variables, sub-
 * expressions, script blocks or separators — the same strict tokenizer the
 * built-in rules use) and starts with the remembered program and sub-command.
 * Saved rules look like { tool: "bash", pattern: "git commit", prefix: true }.
 */
const { tokenize } = require("./builtin")

const prog = (t) => String(t).toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "")

// Read-only commands: the program alone is the family.
const READ_ONLY = new Set(["ls", "dir", "pwd", "cat", "type", "echo", "tree", "where", "which", "get-childitem", "gci", "get-content", "gc", "get-location", "gl", "select-string", "sls", "test-path", "get-item", "gi", "resolve-path", "get-command", "gcm"])
// git sub-commands that change nothing outside the repo's normal workflow.
// push, reset, clean, rm and config are never generalized.
const GIT = new Set(["status", "diff", "log", "show", "add", "commit", "checkout", "switch", "branch", "fetch", "pull", "stash", "restore", "tag", "merge", "rebase", "remote", "blame", "grep", "describe", "rev-parse", "ls-files"])
const PKG = new Set(["test", "t", "build", "ci", "install", "i", "add", "lint", "run"])
const TOOLCHAIN = { cargo: new Set(["build", "test", "check", "run", "fmt", "clippy"]), go: new Set(["build", "test", "vet", "run", "fmt"]), dotnet: new Set(["build", "test", "run", "restore"]) }

/** The command family for one segment, as a list of leading tokens, or null (remember exactly). */
function familyOf(segment) {
  const t = tokenize(String(segment == null ? "" : segment).trim())
  if (!t || !t.length) return null
  if (t.some((x) => /vibe-scratch/i.test(x))) return null
  const p = prog(t[0])
  const sub = t[1] ? String(t[1]).toLowerCase() : ""
  if (READ_ONLY.has(p)) return [p]
  if (p === "git" && GIT.has(sub)) return ["git", sub]
  if (["npm", "pnpm", "yarn"].includes(p) && PKG.has(sub)) {
    if (sub === "run") return t[2] && /^[\w:.@/-]+$/.test(t[2]) ? [p, "run", t[2]] : null
    return [p, sub]
  }
  if (TOOLCHAIN[p] && TOOLCHAIN[p].has(sub)) return [p, sub]
  if ((p === "python" || p === "py" || p === "python3") && sub === "-m" && /^(pytest|unittest)$/i.test(t[2] || "")) return [p, "-m", String(t[2]).toLowerCase()]
  if (p === "pytest") return ["pytest"]
  return null
}

/** The rule "Always allow" saves for one approved shell segment. */
function rememberRule(segment) {
  const family = familyOf(segment)
  if (family) return { tool: "bash", pattern: family.join(" "), prefix: true, action: "allow" }
  return { tool: "bash", pattern: String(segment), exact: true, action: "allow" }
}

/** Human text for what "Always allow" would remember (shown on the prompt). */
function rememberLabel(segment) {
  const family = familyOf(segment)
  return family ? `${family.join(" ")} …` : String(segment)
}

/** Does a saved family rule match this command segment? */
function matchPrefix(pattern, segment) {
  const want = String(pattern || "").trim().split(/\s+/).filter(Boolean)
  if (!want.length) return false
  const t = tokenize(String(segment == null ? "" : segment).trim())
  if (!t || t.length < want.length) return false
  if (t.some((x) => /vibe-scratch/i.test(x))) return false
  for (let i = 0; i < want.length; i++) {
    const got = i === 0 ? prog(t[0]) : String(t[i]).toLowerCase()
    if (got !== want[i].toLowerCase()) return false
  }
  return true
}

module.exports = { familyOf, rememberRule, rememberLabel, matchPrefix }
