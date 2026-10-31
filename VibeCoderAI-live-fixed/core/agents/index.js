"use strict"
/**
 * Agent definitions (OpenCode-style): a named prompt + model + permissions + step cap.
 *
 * Discovery (project overrides global, later wins):
 *   global:  <VIBE_HOME>/agents/<id>.md
 *   project: <dir>/.vibe/agents/<id>.md
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
    name: "Build",
    description: "Default coding agent with every tool.",
    mode: "primary",
    system: "",
    permissions: [],
    steps: 100,
    hidden: false,
    color: "#2563eb",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Explores and plans; normal project files cannot be edited.",
    mode: "primary",
    system:
      "You are a planning agent. Inspect the codebase and propose a concrete plan. Do not modify normal project files; write plan files only when the user asks for one.",
    permissions: [
      { action: "edit", resource: "**", effect: "deny" },
      { action: "write", resource: "**", effect: "deny" },
      { action: "edit", resource: "**/plan/**", effect: "allow" },
      { action: "write", resource: "**/plan/**", effect: "allow" },
    ],
    steps: 60,
    hidden: false,
    color: "#7c3aed",
  },
  {
    id: "explore",
    name: "Explore",
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
    name: "General",
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

/** All agents: built-ins first, then global files, then project files (later wins). */
function listAgents({ home, dir } = {}) {
  const all = new Map()
  for (const builtin of BUILTIN) all.set(builtin.id, withRules(builtin))
  const found = new Map()
  scan(globalDir(home), "global", found)
  scan(projectDir(dir), "project", found)
  for (const [id, agent] of found) all.set(id, agent)
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
  MAX_AGENT_BODY_CHARS,
}
