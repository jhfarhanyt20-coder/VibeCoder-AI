"use strict"
/**
 * Permission rules. A rule is {tool, pattern, action: "allow"|"ask"|"deny"}.
 * Last matching rule wins. `subject` is what the tool touches: a command, an absolute path, a host.
 * Extra pseudo-tool "external_directory" guards any path outside the workspace.
 */
const { globToRegExp, globToRegExpLoose, toPosix } = require("../util")
const { matchBuiltin } = require("./builtin")

// File tools that may work inside ./.vibe-scratch without asking.
const SCRATCH_FILE_TOOLS = ["read", "write", "edit", "list", "glob", "grep", "multiedit", "apply_patch"]
// [builtin matcher, human-readable pattern]. The pattern is only a label (and a
// safe exact-match fallback if a copy of the rule ever loses its builtin key).
const BUILTIN_BASH = [
  ["npm-test", "npm test"], ["npm-t", "npm t"], ["npm-build", "npm build"], ["npm-ci", "npm ci"],
  ["npm-install", "npm install"], ["npm-i", "npm i"],
  ["yarn-build", "yarn build"], ["yarn-test", "yarn test"], ["pnpm-build", "pnpm build"], ["pnpm-test", "pnpm test"],
  // `node *test*` / `node *build*` used to be auto-allowed, which let ANY
  // `node evil.js --test` run unasked. Only Node's own test runner is allowed.
  ["node-test", "node --test"],
  ["cargo-build", "cargo build"], ["cargo-test", "cargo test"], ["go-build", "go build"], ["go-test", "go test"],
  ["dotnet-build", "dotnet build"], ["dotnet-test", "dotnet test"],
]

const DEFAULT_RULES = [
  { tool: "*", pattern: "*", action: "ask" },
  { tool: "read", pattern: "*", action: "allow" },
  { tool: "grep", pattern: "*", action: "allow" },
  { tool: "glob", pattern: "*", action: "allow" },
  { tool: "list", pattern: "*", action: "allow" },
  { tool: "todowrite", pattern: "*", action: "allow" },
  { tool: "memory", pattern: "*", action: "allow" },
  // Loading a discovered SKILL.md is read-only. The skill text still does not
  // grant permission for commands, edits, secrets, or other tool actions.
  { tool: "skill", pattern: "*", action: "allow" },
  { tool: "playbook", pattern: "*", action: "allow" },
  // Computer Use is offered only while the user keeps it on in Settings. Its
  // ordinary actions run without a prompt; risky ones (send, delete, install,
  // pay...) always ask through a critical, never-saved prompt.
  { tool: "computer", pattern: "*", action: "allow" },
  // Connectors (GitHub…): reading never asks; changes follow the permission mode;
  // hard-to-undo actions always ask through a critical prompt in the tool.
  { tool: "github", pattern: "read**", action: "allow" },
  { tool: "facebook", pattern: "read**", action: "allow" },
  // Reading BDCoder's own product guide is always free.
  { tool: "vibecoder_help", pattern: "*", action: "allow" },
  // the agent's own scratch folder (./.vibe-scratch): creating, editing and
  // reading files inside it never asks - it is the agent's private workspace.
  // Only FILE tools get this: the old any-tool rule also matched bash (any
  // command that mentioned "/.vibe-scratch/" ran unasked), external_directory
  // (a .vibe-scratch folder anywhere on disk), browser, webfetch and MCP.
  ...SCRATCH_FILE_TOOLS.map((tool) => ({ tool, pattern: "**/.vibe-scratch/**", action: "allow" })),
  // Cleaning it up: only rm / Remove-Item whose every path is inside
  // ./.vibe-scratch (see core/perm/builtin.js). Matched structurally, never by
  // a substring, so "Remove-Item C:\Users\x # vibe-scratch" asks.
  { tool: "bash", pattern: "Remove-Item .vibe-scratch", builtin: "scratch-clean", action: "allow" },
  { tool: "read", pattern: "**/.env*", action: "ask" },
  { tool: "read", pattern: "**/.env.example", action: "allow" },
  { tool: "read", pattern: "**/.env.sample", action: "allow" },
  // Build/test commands without asking - common development operations. Each
  // is matched at the START of one split command segment with only plain
  // arguments after it (core/perm/builtin.js): no comment, redirect, variable,
  // sub-expression or second command can ride along. The old `*npm test*`
  // substring rules let "Format-Volume D # npm test" run unasked.
  // NOTE: `npm run <script>` executes arbitrary code from package.json, so it is
  // intentionally NOT auto-allowed (V-05). `npm install <package>` installs
  // (and runs the install scripts of) a new package, so only a bare
  // `npm install` / `npm ci` restoring the repo's own lockfile is allowed.
  ...BUILTIN_BASH.map(([builtin, pattern]) => ({ tool: "bash", pattern, builtin, action: "allow" })),
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
  { tool: "bash", pattern: "*Format-Volume*", action: "deny" },
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
    // Built-in shell rules match structurally (core/perm/builtin.js), never by
    // substring; they only ever apply to bash.
    let hit = r.builtin
      ? r.tool === "bash" && tool === "bash" && matchBuiltin(r.builtin, s)
      : r.prefix
        // "Always allow" for a command family (core/perm/remember.js): matched
        // on clean tokens only, never by substring.
        ? r.tool === "bash" && tool === "bash" && require("./remember").matchPrefix(r.pattern, subject == null ? "" : subject)
        : r.exact ? s === toPosix(r.pattern) : r.pattern === "*" || matcher(r.pattern).test(s)
    // OpenCode's "git *" also matches the bare "git" command.
    if (!hit && !r.builtin && r.tool === "bash" && typeof r.pattern === "string" && r.pattern.endsWith(" *")) {
      hit = s === toPosix(r.pattern.slice(0, -2).trim())
    }
    // Note: for `grep` the subject is the search pattern, not a file path, so a
    // rule like {tool:"grep", pattern:"TODO"} guards the text being searched.
    if (hit) action = r.action
  }
  return action
}

module.exports = { DEFAULT_RULES, decide, normalizeRule, normalizeRules, SCRATCH_FILE_TOOLS }
