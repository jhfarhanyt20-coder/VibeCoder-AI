"use strict"
/**
 * Permission rules. A rule is {tool, pattern, action: "allow"|"ask"|"deny"}.
 * Last matching rule wins. `subject` is what the tool touches: a command, an absolute path, a host.
 * Extra pseudo-tool "external_directory" guards any path outside the workspace.
 */
const { globToRegExp, toPosix } = require("../util")

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
  // Allow build commands without asking - these are common development operations
  { tool: "bash", pattern: "*npm run *", action: "allow" },
  { tool: "bash", pattern: "*npm test*", action: "allow" },
  { tool: "bash", pattern: "*npm build*", action: "allow" },
  { tool: "bash", pattern: "*yarn build*", action: "allow" },
  { tool: "bash", pattern: "*yarn test*", action: "allow" },
  { tool: "bash", pattern: "*pnpm build*", action: "allow" },
  { tool: "bash", pattern: "*pnpm test*", action: "allow" },
  { tool: "bash", pattern: "*node *test*", action: "allow" },
  { tool: "bash", pattern: "*node *build*", action: "allow" },
  { tool: "bash", pattern: "*make *", action: "allow" },
  { tool: "bash", pattern: "*mvn *", action: "allow" },
  { tool: "bash", pattern: "*gradle *", action: "allow" },
  { tool: "bash", pattern: "*cargo build*", action: "allow" },
  { tool: "bash", pattern: "*cargo test*", action: "allow" },
  { tool: "bash", pattern: "*go build*", action: "allow" },
  { tool: "bash", pattern: "*go test*", action: "allow" },
  { tool: "bash", pattern: "*dotnet build*", action: "allow" },
  { tool: "bash", pattern: "*dotnet test*", action: "allow" },
]

const cache = new Map()
const re = (p) => {
  let r = cache.get(p)
  if (!r) cache.set(p, (r = globToRegExp(p)))
  return r
}

function decide(rules, tool, subject) {
  const s = toPosix(subject == null ? "" : subject)
  let action = "ask"
  for (const r of rules) {
    if (r.tool !== "*" && r.tool !== tool) continue
    const hit = r.exact ? s === toPosix(r.pattern) : r.pattern === "*" || re(r.pattern).test(s)
    if (hit) action = r.action
  }
  return action
}

module.exports = { DEFAULT_RULES, decide }
