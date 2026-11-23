"use strict"
/**
 * Agent definitions (OpenCode-style): a named prompt + model + permissions + step cap.
 *
 * Discovery (project overrides global, later wins):
 *   global:  <VIBE_HOME>/agents/<id>.md
 *   project: <dir>/.vibe/agents/<id>.md
 * A project (repository) file never replaces a built-in id ("general", "plan",
 * ...): it is loaded as "project/<id>". Until the workspace is trusted its
 * permission rules can only narrow access ("allow" rules are dropped).
 * Nested folders become part of the id: team/reviewer -> "team/reviewer".
 *
 * A markdown file is frontmatter + a body. The body is the extra system prompt.
 * Frontmatter keys: name, description, mode (primary|subagent|all), model,
 * system, permissions, steps, hidden, color.
 *
 * permissions accepts either JSON (inline) or a compact list:
 *   permissions: [{"action":"edit","resource":"**","effect":"deny"}]
 *   permissions: edit:**=deny, shell:**=deny
 * The engine rule shape is {tool, pattern, action}; `rules` is the normalized
 * version of `permissions` and is what decide() consumes.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")
const { parseFrontmatter, slug } = require("../skills")

const MAX_AGENT_BODY_CHARS = 30000
const MAX_AGENTS = 100
const MAX_DEPTH = 4

const globalDir = (home) => path.join(home || homeDir(), "agents")
const projectDir = (dir) => path.join(dir || process.cwd(), ".vibe", "agents")

/** Built-in agents. `build` intentionally has no extra system text so the
 *  default prompt (and therefore today's behaviour) is unchanged. */
const BUILTIN = [
  {
    id: "build",
    name: "Pilot",
    description: "Default VibeCoder agent with every tool.",
    mode: "primary",
    system: "",
    permissions: [],
    steps: 100,
    hidden: false,
    color: "#2563eb",
  },
  {
    id: "plan",
    name: "Architect",
    description: "Explores and plans; normal project files cannot be edited.",
    mode: "primary",
    system:
      "You are a planning agent. Inspect the codebase and propose a concrete plan. Do not modify normal project files; write plan files only when the user asks for one.",
    permissions: [
      { action: "edit", resource: "**", effect: "deny" },
      { action: "write", resource: "**", effect: "deny" },
      { action: "edit", resource: "**/plan/**", effect: "allow" },
      { action: "write", resource: "**/plan/**", effect: "allow" },
      // Plan mode is read-only: shell is denied except a few inspection commands.
      // Later rules win, so the redirect/output denies come last.
      { action: "bash", resource: "**", effect: "deny" },
      { action: "bash", resource: "git status*", effect: "allow" },
      { action: "bash", resource: "git diff*", effect: "allow" },
      { action: "bash", resource: "git log*", effect: "allow" },
      { action: "bash", resource: "git show*", effect: "allow" },
      { action: "bash", resource: "ls*", effect: "allow" },
      { action: "bash", resource: "dir*", effect: "allow" },
      { action: "bash", resource: "pwd", effect: "allow" },
      { action: "bash", resource: "*>*", effect: "deny" },
      { action: "bash", resource: "*--output*", effect: "deny" },
    ],
    steps: 60,
    hidden: false,
    color: "#7c3aed",
  },
  {
    id: "explore",
    name: "Scout",
    description: "Reads and searches without editing files or running commands.",
    mode: "subagent",
    system: "You are an exploration agent. Search and read code or web sources, then report findings. Do not edit files and do not run commands.",
    permissions: [
      { action: "edit", resource: "**", effect: "deny" },
      { action: "write", resource: "**", effect: "deny" },
      { action: "bash", resource: "**", effect: "deny" },
    ],
    steps: 40,
    hidden: false,
    color: "#059669",
  },
  {
    id: "general",
    name: "Maker",
    description: "General-purpose subagent with all built-in tools.",
    mode: "subagent",
    system: "You are a general assistant. Use the available tools to complete the task and report the result.",
    permissions: [],
    steps: 100,
    hidden: false,
    color: "#64748b",
  },
]

function parsePermissions(value) {
  if (Array.isArray(value)) return value.filter((p) => p && typeof p === "object")
  const text = String(value == null ? "" : value).trim()
  if (!text) return []
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p === "object") : []
    } catch {}
  }
  const out = []
  for (const piece of text.split(/[\n,]+/)) {
    const item = piece.trim()
    if (!item) continue
    const withResource = /^([\w.*-]+)\s*[:=]\s*([^=]+?)\s*=\s*(allow|ask|deny)$/i.exec(item)
    if (withResource) {
      out.push({ action: withResource[1], resource: withResource[2].trim() || "**", effect: withResource[3].toLowerCase() })
      continue
    }
    const simple = /^([\w.*-]+)\s*=\s*(allow|ask|deny)$/i.exec(item)
    if (simple) out.push({ action: simple[1], resource: "**", effect: simple[2].toLowerCase() })
  }
  return out
}

/** {action, resource, effect} | {tool, pattern, action} -> the engine shape. */
function normalizeRule(permission) {
  const p = permission && typeof permission === "object" ? permission : {}
  const tool = String(p.tool || p.action || "*").trim() || "*"
  const pattern = String(p.pattern || p.resource || "*").trim() || "*"
  const raw = String(p.effect || p.action || p.permission || "ask").trim().toLowerCase()
  const action = raw === "allow" || raw === "deny" ? raw : "ask"
  return { tool, pattern, action }
}

const firstLine = (body) =>
  String(body || "")
    .replace(/^\s+/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")) || ""

function parseAgent(file, scope, idFromPath) {
  let text
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_AGENT_BODY_CHARS * 4) return null
    text = fs.readFileSync(file, "utf8")
  } catch {
    return null
  }
  const { fields, body } = parseFrontmatter(String(text).replace(/^\uFEFF/, ""))
  const id = idFromPath || slug(path.basename(file, path.extname(file)))
  if (!id) return null
  const modeValue = String(fields.mode || "all").trim().toLowerCase()
  const mode = ["primary", "subagent", "all"].includes(modeValue) ? modeValue : "all"
  const permissions = parsePermissions(fields.permissions)
  const steps = Number(fields.steps) > 0 ? Math.min(1000, Math.floor(Number(fields.steps))) : 100
  return {
    id,
    name: String(fields.name || id).trim().slice(0, 120),
    description: String(fields.description || firstLine(body) || `Agent ${id}`).trim().slice(0, 1024),
    mode,
    model: fields.model ? String(fields.model).trim() || null : null,
    system: String(fields.system || body || "").trim().slice(0, MAX_AGENT_BODY_CHARS),
    permissions,
    rules: permissions.map(normalizeRule),
    steps,
    hidden: /^(true|yes|1)$/i.test(String(fields.hidden || "").trim()),
    color: fields.color ? String(fields.color).trim() : "#64748b",
    scope,
    file,
    builtin: false,
  }
}

function scan(dir, scope, out, depth = 0, prefix = "") {
  if (depth > MAX_DEPTH || out.size >= MAX_AGENTS) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.isSymbolicLink()) continue
      scan(full, scope, out, depth + 1, prefix + slug(entry.name) + "/")
      continue
    }
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue
    const id = prefix + slug(path.basename(entry.name, path.extname(entry.name)))
    const agent = parseAgent(full, scope, id)
    if (agent) out.set(agent.id, agent)
  }
}

function withRules(agent, scope = "builtin") {
  const permissions = Array.isArray(agent.permissions) ? agent.permissions : []
  return {
    ...agent,
    permissions,
    rules: permissions.map(normalizeRule),
    scope,
    file: agent.file || null,
    builtin: scope === "builtin",
  }
}

const BUILTIN_IDS = new Set(BUILTIN.map((agent) => agent.id))
/** Namespace for repository agents whose file name collides with a built-in id. */
const PROJECT_NAMESPACE = "project/"

function workspaceTrusted(dir, home) {
  if (!dir) return false
  try {
    return require("../harness/trust").isProjectTrusted(dir, home || homeDir())
  } catch {
    return false
  }
}

/**
 * Security: a repository's agent file may only NARROW permissions until the
 * user trusts the workspace. "allow" rules are dropped; "deny"/"ask" stay.
 * When it shadows one of the user's own global agents, the global rules stay
 * in force first so the repo copy cannot loosen them either.
 */
function confineProjectAgent(agent, base) {
  const rules = Array.isArray(agent.rules) ? agent.rules : []
  const kept = rules.filter((rule) => rule.action !== "allow")
  const dropped = rules.length - kept.length
  const permissions = (agent.permissions || []).filter((p) => normalizeRule(p).action !== "allow")
  const baseRules = base && Array.isArray(base.rules) ? base.rules : []
  const baseAllow = base && Array.isArray(base.permissions) ? base.permissions : []
  const out = {
    ...agent,
    permissions: [...baseAllow, ...permissions],
    rules: [...baseRules, ...kept],
    untrusted: true,
  }
  if (dropped) out.warnings = [...(agent.warnings || []), `Ignored ${dropped} "allow" permission rule(s) from an untrusted project agent.`]
  return out
}

/**
 * All agents: built-ins first, then global files, then project files (later
 * wins). Project files can never replace a built-in id: such a file is kept
 * under "project/<id>" with a warning.
 */
function listAgents({ home, dir } = {}) {
  const all = new Map()
  for (const builtin of BUILTIN) all.set(builtin.id, withRules(builtin))
  const globals = new Map()
  scan(globalDir(home), "global", globals)
  // The user's own global agents keep today's behaviour (they may replace a built-in).
  for (const [id, agent] of globals) all.set(id, agent)
  const project = new Map()
  scan(projectDir(dir), "project", project)
  if (!project.size) return [...all.values()].sort((a, b) => a.id.localeCompare(b.id))
  const trusted = workspaceTrusted(dir, home)
  for (const [id, found] of project) {
    let agent = found
    if (BUILTIN_IDS.has(id)) {
      const namespaced = PROJECT_NAMESPACE + id
      agent = {
        ...agent,
        id: namespaced,
        shadowed: id,
        warnings: [...(agent.warnings || []), `Project agent "${id}" cannot replace the built-in agent; loaded as "${namespaced}".`],
      }
    }
    if (!trusted) agent = confineProjectAgent(agent, globals.get(agent.id) || null)
    all.set(agent.id, agent)
  }
  return [...all.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Find by exact id, then by a unique leaf name ("reviewer" -> "team/reviewer"). */
function getAgent(id, opts = {}) {
  const wanted = String(id || "").trim().toLowerCase()
  if (!wanted) return null
  const list = listAgents(opts)
  const exact = list.find((agent) => agent.id.toLowerCase() === wanted)
  if (exact) return exact
  const leaves = list.filter((agent) => agent.id.split("/").pop().toLowerCase() === wanted)
  return leaves.length === 1 ? leaves[0] : null
}

module.exports = {
  globalDir,
  projectDir,
  BUILTIN,
  parseAgent,
  parsePermissions,
  normalizeRule,
  listAgents,
  getAgent,
  confineProjectAgent,
  PROJECT_NAMESPACE,
  MAX_AGENT_BODY_CHARS,
}
