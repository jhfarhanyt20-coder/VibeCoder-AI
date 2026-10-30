"use strict"
/**
 * MCP servers are configured in JSON files (merge: project overrides global,
 * same shape as opencode-style configs):
 *   global : ~/.vibe/mcp.json
 *   project: <workspace>/.vibe/mcp.json
 * Format: { "<name>": { type: "local"|"remote", command?: [..], url?, env?, headers? } }
 * The Manager keeps one live McpClient per server, (re)connects entries on
 * demand and exposes their tools in the engine tool namespace:
 *   mcp__<server>__<tool>
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("../util")
const { McpClient } = require("./client")

const globalFile = () => path.join(homeDir(), "mcp.json")
const projectFile = (dir) => path.join(dir || "", ".vibe", "mcp.json")

const readJson = (f, fb) => {
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"))
    return j && typeof j === "object" && !Array.isArray(j) ? j : fb
  } catch {
    return fb
  }
}
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(v, null, 2))
}
const sanitize = (e) => {
  const out = { type: e.type === "remote" ? "remote" : "local" }
  if (out.type === "local" && Array.isArray(e.command) && e.command.length) out.command = e.command.map(String)
  if (out.type === "remote" && e.url) out.url = String(e.url)
  if (e.env && typeof e.env === "object") out.env = e.env
  if (e.headers && typeof e.headers === "object") out.headers = e.headers
  return out
}

/** [{name, scope, file, ...entry}] newest scope wins (project over global). */
function listServers(directory) {
  const rows = []
  const g = readJson(globalFile(), {})
  for (const [name, e] of Object.entries(g)) rows.push({ name, scope: "global", file: globalFile(), ...sanitize(e) })
  if (directory) {
    const p = readJson(projectFile(directory), {})
    for (const [name, e] of Object.entries(p)) {
      const i = rows.findIndex((r) => r.name === name)
      const row = { name, scope: "project", file: projectFile(directory), ...sanitize(e) }
      if (i >= 0) rows[i] = row
      else rows.push(row)
    }
  }
  return rows
}

function addServer({ name, type, url, command, env, headers, global, directory }) {
  const id = String(name || "").trim().replace(/[^\w.-]/g, "-").slice(0, 60)
  if (!id) throw new Error("Server name is required")
  const entry = sanitize({ type, url, command, env, headers })
  if (entry.type === "local" && !entry.command) throw new Error("A local MCP server needs a command")
  if (entry.type === "remote" && !/^https?:\/\//i.test(entry.url || "")) throw new Error("A remote MCP server needs an http(s) URL")
  const file = global || !directory ? globalFile() : projectFile(directory)
  const cfg = readJson(file, {})
  if (cfg[id] && !global && readJson(globalFile(), {})[id]) entry.scopeNote = "overrides global"
  cfg[id] = entry
  writeJson(file, cfg)
  return { name: id, scope: file === globalFile() ? "global" : "project", file }
}

function removeServer({ name, global, directory }) {
  const file = global || !directory ? globalFile() : projectFile(directory)
  const cfg = readJson(file, {})
  if (!(name in cfg)) return { removed: false }
  delete cfg[name]
  writeJson(file, cfg)
  return { removed: true, file }
}

/** Live clients + tool catalogue. */
class McpManager {
  constructor() {
    this.clients = new Map() // name -> { client, ok, error, tools, signature }
    this.queue = Promise.resolve()
  }
  static signature(row) {
    return row.scope + "|" + JSON.stringify(sanitize(row))
  }
  /** Connect whatever is configured and not already up (best effort, parallel). */
  async sync(directory) {
    const rows = listServers(directory)
    const wanted = new Set(rows.map((r) => r.name))
    for (const [name, st] of this.clients) {
      if (!wanted.has(name) || st.signature !== this._sig(rows, name)) {
        try {
          st.client && st.client.close()
        } catch {}
        this.clients.delete(name)
      }
    }
    const todo = rows.filter((r) => !this.clients.has(r.name))
    await Promise.all(
      todo.map(async (r) => {
        const st = { client: null, ok: false, error: "connecting", tools: [], signature: McpManager.signature(r) }
        this.clients.set(r.name, st)
        try {
          const c = new McpClient(r.name, r)
          await c.connect()
          st.client = c
          st.ok = true
          st.error = ""
          st.tools = c.tools
        } catch (e) {
          st.error = (e && e.message) || String(e)
        }
      }),
    )
    return rows
  }
  _sig(rows, name) {
    const r = rows.find((x) => x.name === name)
    return r ? McpManager.signature(r) : ""
  }
  status() {
    const out = []
    for (const [name, st] of this.clients) out.push({ name, ok: st.ok, error: st.error, tools: st.tools.length })
    return out
  }
  /** Engine tool objects for every connected server's tool. */
  toolObjects() {
    const out = []
    for (const [name, st] of this.clients) {
      if (!st.ok) continue
      for (const t of st.tools) {
        // provider function-name rules are strict (^[A-Za-z0-9_-]{1,64}$):
        // the DECLARED name is sanitized, callTool still uses the server's real name
        const qname = `mcp__${String(name).replace(/[^\w-]/g, "_")}__${String(t.name).replace(/[^\w-]/g, "_")}`.slice(0, 64)
        out.push({
          name: qname,
          description: String(t.description || `MCP tool ${t.name} from "${name}"`).slice(0, 1200),
          parameters: (t.inputSchema && typeof t.inputSchema === "object") || t.inputSchema === undefined ? t.inputSchema || { type: "object", properties: {} } : { type: "object", properties: {} },
          perm: () => ({ tool: "mcp", subject: qname }),
          paths: () => [],
          run: async (args) => {
            const cur = this.clients.get(name)
            if (!cur || !cur.ok || !cur.client) throw new Error(`MCP server "${name}" is not connected`)
            const text = await cur.client.callTool(t.name, args)
            return require("../tools").clip(String(text))
          },
        })
      }
    }
    return out
  }
}

module.exports = { globalFile, projectFile, listServers, addServer, removeServer, McpManager, readJson }
