"use strict"
/**
 * Inspection commands for the terminal.
 *
 * These read the exact same stores the desktop app reads, so what `vibe skills`
 * shows is what the agent will load, and what `vibe mcp` shows is what the
 * engine will connect to. Nothing here starts a model request.
 */

const path = require("path")
const { c, table, when, tokens, money, clip } = require("./ui")
const { homeDir } = require("../core/util")
const skillsStore = require("../core/skills")
const agentsStore = require("../core/agents")
const mcpStore = require("../core/mcp")
const pluginsStore = require("../core/plugins")
const toolSpecs = require("../core/tools")

function jsonOut(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n")
}

function listSkills(dir, home) {
  return skillsStore.listSkills(dir, home || homeDir()).map((s) => ({
    id: s.id,
    name: s.name || s.id,
    scope: s.scope || "",
    format: s.format || "",
    description: s.description || "",
    file: s.file || "",
  }))
}

function printSkills(rows, asJson) {
  if (asJson) return jsonOut(rows)
  if (!rows.length) {
    console.log(c.dim("No skills found. Add one under .vibe/skills/<id>/SKILL.md or install from Marketplace."))
    return
  }
  console.log(table(rows.map((s) => [s.id, s.scope, s.name, clip(s.description, 72)]), ["ID", "Scope", "Name", "Description"]))
  console.log(c.dim(`\n${rows.length} skill(s). The agent loads one with the skill tool when a task matches.`))
}

function listAgents(dir, home) {
  return agentsStore.listAgents({ home: home || homeDir(), dir }).filter((a) => !a.hidden).map((a) => ({
    id: a.id,
    name: a.name || a.id,
    scope: a.scope || "builtin",
    mode: a.mode || "",
    description: a.description || "",
    file: a.file || "",
  }))
}

function printAgents(rows, asJson) {
  if (asJson) return jsonOut(rows)
  console.log(table(rows.map((a) => [a.id, a.scope, a.mode || "-", clip(a.description, 72)]), ["ID", "Scope", "Mode", "Description"]))
  console.log(c.dim(`\n${rows.length} agent(s). Use: vibe run --agent <id> "..."`))
}

function listMcp(dir, home) {
  const configured = mcpStore.listServers(dir, home || homeDir())
  return configured.map((s) => ({
    name: s.name,
    scope: s.scope,
    type: s.type,
    target: s.type === "remote" ? s.url : (s.command || []).join(" "),
    file: s.file,
  }))
}

function printMcp(rows, dir, asJson) {
  if (asJson) return jsonOut(rows)
  if (!rows.length) {
    console.log(c.dim("No MCP servers configured."))
  } else {
    console.log(table(rows.map((s) => [s.name, s.scope, s.type, s.target]), ["Name", "Scope", "Type", "Target"]))
    console.log(c.dim(`\n${rows.length} configured. Their tools appear automatically in this folder.`))
  }
  console.log(c.dim(`Global config: ${mcpStore.globalFile()}`))
  if (dir) console.log(c.dim(`Project config: ${mcpStore.projectFile(dir)}`))
}

function listPlugins(dir) {
  return pluginsStore.listPlugins(dir).map((p) => ({
    name: p.name,
    scope: p.scope,
    ok: !!p.ok,
    error: p.error || "",
    file: p.file,
  }))
}

function printPlugins(rows, asJson) {
  if (asJson) return jsonOut(rows)
  if (!rows.length) {
    console.log(c.dim("No plugins installed."))
    return
  }
  console.log(table(rows.map((p) => [p.name, p.scope, p.ok ? "ok" : "error", p.error]), ["Name", "Scope", "Status", "Error"]))
}

function listTools() {
  return toolSpecs.ALL.map((t) => ({ name: t.name, description: t.description || "" }))
}

function printTools(dir, asJson) {
  const rows = listTools().map((t) => [t.name, clip(t.description, 84)])
  let extra = []
  try {
    extra = pluginsStore.toolObjects(dir)
  } catch {}
  if (asJson) return jsonOut({ builtin: listTools(), plugins: extra.map((t) => ({ name: t.name, description: t.description })) })
  console.log(table(rows, ["Tool", "Description"]))
  if (extra.length) {
    console.log(c.dim("\nPlugin tools:"))
    console.log(table(extra.map((t) => [t.name, clip(t.description, 84)]), ["Tool", "Description"]))
  }
  console.log(c.dim(`\n${rows.length} built-in tool(s)${extra.length ? ` + ${extra.length} plugin tool(s)` : ""}. MCP tools appear once their server connects.`))
}

async function doctor({ dir, home, vibe }) {
  const h = home || homeDir()
  const profiles = vibe.engine.listProfiles()
  const ready = profiles.filter((p) => p.hasKey || p.noAuth)
  const skills = listSkills(dir, h)
  const agents = listAgents(dir, h)
  const mcp = listMcp(dir, h)
  const plugins = listPlugins(dir)
  const sessions = await vibe.session.list({ dir })
  const files = {
    home: h,
    profiles: path.join(h, "profiles.json"),
    auth: path.join(h, "auth.json"),
    sessions: path.join(h, "sessions"),
    rules: path.join(h, "rules.json"),
    project: dir,
  }
  const out = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    dir,
    home: h,
    files,
    profiles: { total: profiles.length, ready: ready.length, readyIDs: ready.map((p) => p.id) },
    skills: skills.length,
    agents: agents.length,
    mcpServers: mcp.length,
    plugins: plugins.length,
    sessions: sessions.length,
  }
  return out
}

function printDoctor(info, asJson) {
  if (asJson) return jsonOut(info)
  const ok = (v) => (v ? c.green("ok") : c.yellow("none"))
  console.log(c.bold("VibeCoder CLI doctor"))
  console.log(`  node       ${info.node} (${info.platform})`)
  console.log(`  folder     ${info.dir}`)
  console.log(`  home       ${info.home}`)
  console.log(`  models     ${info.profiles.ready}/${info.profiles.total} ready ${ok(info.profiles.ready)}`)
  if (info.profiles.readyIDs.length) console.log(c.dim(`             ${info.profiles.readyIDs.join(", ")}`))
  console.log(`  skills     ${info.skills}`)
  console.log(`  agents     ${info.agents}`)
  console.log(`  mcp        ${info.mcpServers}`)
  console.log(`  plugins    ${info.plugins}`)
  console.log(`  sessions   ${info.sessions}`)
  console.log(c.dim("\nFiles:"))
  for (const [name, file] of Object.entries(info.files)) console.log(c.dim(`  ${name.padEnd(9)} ${file}`))
  if (!info.profiles.ready) console.log(c.yellow("\nNo model has a key yet. Run: vibe models  →  vibe auth add <profile>"))
}

async function printSessions(vibe, dir, asJson) {
  const list = await vibe.session.list({ dir })
  if (asJson) return jsonOut(list)
  if (!list.length) {
    console.log(c.dim("No sessions in this folder yet. Start one with: vibe chat"))
    return
  }
  console.log(
    table(
      list.map((s) => [s.id, when(s.updatedAt || s.time?.updated), s.profile || "", s.title || ""]),
      ["Session", "Updated", "Model", "Title"],
    ),
  )
  console.log(c.dim("\nResume: vibe resume <session>   ·   Continue the newest: vibe chat -c"))
}

function readSession(vibe, id) {
  return vibe.session.get(id)
}

function printUsage(session, asJson) {
  const usage = session?.usage || {}
  const rows = {
    session: session?.id,
    title: session?.title,
    steps: Array.isArray(session?.messages) ? session.messages.filter((m) => m.role === "assistant").length : 0,
    input: usage.totalInput || 0,
    output: usage.totalOutput || 0,
    reasoning: usage.totalReasoning || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    cost: usage.totalCost || 0,
  }
  if (asJson) return jsonOut(rows)
  console.log(c.bold(`Session ${rows.session || ""}`))
  console.log(`  messages   ${rows.steps}`)
  console.log(`  input      ${tokens(rows.input)} tokens`)
  console.log(`  output     ${tokens(rows.output)} tokens`)
  if (rows.cacheRead) console.log(`  cache      ${tokens(rows.cacheRead)} read`)
  const cost = money(rows.cost)
  if (cost) console.log(`  cost       ${cost}`)
}

module.exports = {
  listSkills, printSkills,
  listAgents, printAgents,
  listMcp, printMcp,
  listPlugins, printPlugins,
  listTools, printTools,
  doctor, printDoctor,
  printSessions, readSession, printUsage,
  jsonOut,
}
