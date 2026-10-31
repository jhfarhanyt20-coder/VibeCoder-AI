"use strict"
/**
 * Permission rules. A rule is {tool, pattern, action: "allow"|"ask"|"deny"}.
 * Last matching rule wins. `subject` is what the tool touches: a command, an absolute path, a host.
 * Extra pseudo-tool "external_directory" guards any path outside the workspace.
 */
const { globToRegExp, globToRegExpLoose, toPosix } = require("../util")

const DEFAULT_RULES = [
  { tool: "*", pattern: "*", action: "ask" },
  { tool: "read", pattern: "*", action: "allow" },
  { tool: "grep", pattern: "*", action: "allow" },
  { tool: "glob", pattern: "*", action: "allow" },
  { tool: "todowrite", pattern: "*", action: "allow" },
  { tool: "memory", pattern: "*", action: "allow" },
  // Loading a discovered SKILL.md is read-only. The skill text still does not
  // grant permission for commands, edits, secrets, or other tool actions.
  { tool: "skill", pattern: "*", action: "allow" },
  // the agent's own scratch folder (./.vibe-scratch): creating, editing and
  // cleaning up files inside it never asks - it is the agent's private workspace
  { tool: "*", pattern: "**/.vibe-scratch/**", action: "allow" },
  { tool: "bash", pattern: "*rm *vibe-scratch*", action: "allow" },
  { tool: "bash", pattern: "*Remove-Item*vibe-scratch*", action: "allow" },
  { tool: "read", pattern: "**/.env*", action: "ask" },
  { tool: "read", pattern: "**/.env.example", action: "allow" },
  { tool: "read", pattern: "**/.env.sample", action: "allow" },
  // Allow build commands without asking - these are common development operations.
  // NOTE: `npm run <script>` executes arbitrary code from package.json, so it is
  // intentionally NOT auto-allowed (V-05). Keep only direct build/test commands.
  { tool: "bash", pattern: "*npm test*", action: "allow" },
  { tool: "bash", pattern: "*npm build*", action: "allow" },
  { tool: "bash", pattern: "*npm ci*", action: "allow" },
  { tool: "bash", pattern: "*npm install*", action: "allow" },
  { tool: "bash", pattern: "*yarn build*", action: "allow" },
  { tool: "bash", pattern: "*yarn test*", action: "allow" },
  { tool: "bash", pattern: "*pnpm build*", action: "allow" },
  { tool: "bash", pattern: "*pnpm test*", action: "allow" },
  { tool: "bash", pattern: "*node *test*", action: "allow" },
  { tool: "bash", pattern: "*node *build*", action: "allow" },
  { tool: "bash", pattern: "*cargo build*", action: "allow" },
  { tool: "bash", pattern: "*cargo test*", action: "allow" },
  { tool: "bash", pattern: "*go build*", action: "allow" },
  { tool: "bash", pattern: "*go test*", action: "allow" },
  { tool: "bash", pattern: "*dotnet build*", action: "allow" },
  { tool: "bash", pattern: "*dotnet test*", action: "allow" },
  // --- V-05: hard denies that outrank every allow above (last match wins) ---
  // These match the raw command text; compound commands are split first by the
  // loop (see core/agent/loop.js) so each sub-command is checked on its own.
  { tool: "bash", pattern: "*rm -rf /", action: "deny" },
  { tool: "bash", pattern: "*rm -rf /*", action: "deny" },
  { tool: "bash", pattern: "*rm -rf ~", action: "deny" },
  { tool: "bash", pattern: "*rm -rf ~/*", action: "deny" },
  { tool: "bash", pattern: "*Remove-Item *-Recurse*C:\\*", action: "deny" },
  { tool: "bash", pattern: "*Remove-Item *-Recurse*C:/", action: "deny" },
  { tool: "bash", pattern: "*format *", action: "deny" },
  { tool: "bash", pattern: "*shutdown*", action: "deny" },
  { tool: "bash", pattern: "*:(){:|:&};:*", action: "deny" },
  // shell download-and-execute chains (curl/wget/Invoke-WebRequest | sh)
  { tool: "bash", pattern: "*curl*|*sh*", action: "deny" },
  { tool: "bash", pattern: "*wget*|*sh*", action: "deny" },
  { tool: "bash", pattern: "*curl*&&*sh*", action: "deny" },
  { tool: "bash", pattern: "*wget*&&*sh*", action: "deny" },
  { tool: "bash", pattern: "*Invoke-WebRequest*|*iex*", action: "deny" },
  { tool: "bash", pattern: "*irm *|*iex*", action: "deny" },
]

/**
 * V-08: two authoring shapes are accepted.
 *   old: { tool, pattern, action: "allow"|"ask"|"deny" }
 *   new: { action, resource, effect }   (OpenCode style - `action` is the tool)
 * normalizeRule() converts either one to the engine shape, so decide() and the
 * session approval writer only ever deal with {tool, pattern, action}.
 */
const ACTIONS = new Set(["allow", "ask", "deny"])
const actionOf = (value) => {
  const a = String(value == null ? "" : value).trim().toLowerCase()
  return ACTIONS.has(a) ? a : "ask"
}

function normalizeRule(rule) {
  const r = rule && typeof rule === "object" ? rule : {}
  const hasEngineShape = typeof r.tool === "string" && typeof r.action === "string" && ACTIONS.has(String(r.action).toLowerCase())
  if (hasEngineShape) {
    return {
      ...r,
      tool: r.tool,
      pattern: String(r.pattern == null ? "*" : r.pattern),
      action: actionOf(r.action),
      ...(r.exact ? { exact: true } : {}),
    }
  }
  return {
    tool: String(r.tool || r.action || "*"),
    pattern: String(r.pattern || r.resource || "*"),
    action: actionOf(r.effect || r.permission),
    ...(r.exact ? { exact: true } : {}),
  }
}

const normalizeRules = (list) => (Array.isArray(list) ? list.map(normalizeRule) : [])

const cache = new Map()
const re = (p) => {
  let r = cache.get(p)
  if (!r) cache.set(p, (r = globToRegExp(p)))
  return r
}
const reLoose = (p) => {
  // bash rules match the raw command text, where '*' must cross '/'.
  const key = "~" + p
  let r = cache.get(key)
  if (!r) cache.set(key, (r = globToRegExpLoose(p)))
  return r
}

function decide(rules, tool, subject) {
  const s = toPosix(subject == null ? "" : subject)
  let action = "ask"
  for (const raw of Array.isArray(rules) ? rules : []) {
    // Fast path: rules loaded by the engine are already normalized. Anything
    // still carrying the new shape is normalized here so both work everywhere.
    const r = raw && typeof raw.tool === "string" && ACTIONS.has(String(raw.action || "").toLowerCase()) ? raw : normalizeRule(raw)
    if (r.tool !== "*" && r.tool !== tool) continue
    const matcher = r.tool === "bash" ? reLoose : re
    let hit = r.exact ? s === toPosix(r.pattern) : r.pattern === "*" || matcher(r.pattern).test(s)
    // OpenCode's "git *" also matches the bare "git" command.
    if (!hit && r.tool === "bash" && typeof r.pattern === "string" && r.pattern.endsWith(" *")) {
      hit = s === toPosix(r.pattern.slice(0, -2).trim())
    }
    // Note: for `grep` the subject is the search pattern, not a file path, so a
    // rule like {tool:"grep", pattern:"TODO"} guards the text being searched.
    if (hit) action = r.action
  }
  return action
}

module.exports = { DEFAULT_RULES, decide, normalizeRule, normalizeRules }
