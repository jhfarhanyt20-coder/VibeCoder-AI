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
const oauth = require("../harness/connectors/oauth")

const globalFile = (home) => path.join(home || homeDir(), "mcp.json")
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
  if (e.oauth && typeof e.oauth === "object") {
    out.oauth = {
      authorizationUrl: String(e.oauth.authorizationUrl || ""),
      tokenUrl: String(e.oauth.tokenUrl || ""),
      clientId: String(e.oauth.clientId || ""),
      scopes: Array.isArray(e.oauth.scopes) ? e.oauth.scopes.map(String) : String(e.oauth.scopes || "").split(/\s+/).filter(Boolean),
      tokenEnv: String(e.oauth.tokenEnv || ""),
    }
  }
  return out
}

/** [{name, scope, file, ...entry}] newest scope wins (project over global). */
function listServers(directory, home) {
  const rows = []
  const g = readJson(globalFile(home), {})
  for (const [name, e] of Object.entries(g)) rows.push({ name, scope: "global", file: globalFile(home), ...sanitize(e) })
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
  constructor({ home } = {}) {
    this.home = home || homeDir()
    this.clients = new Map() // name -> { client, ok, error, tools, signature }
    this.queue = Promise.resolve()
    this.oauthTokens = new Map()
    this.oauthPending = new Map()
    this.directory = ""
  }
  static signature(row) {
    return row.scope + "|" + JSON.stringify(sanitize(row))
  }
  /** Connect whatever is configured and not already up (best effort, parallel). */
  async sync(directory) {
    this.directory = directory || this.directory || ""
    const rows = listServers(directory, this.home)
    this.rows = new Map(rows.map((row) => [row.name, row]))
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
        const st = { client: null, ok: false, error: "connecting", tools: [], resources: [], resourceTemplates: [], resourceError: "", signature: McpManager.signature(r) }
        this.clients.set(r.name, st)
        try {
          const token = this.oauthTokens.get(r.name)
          const c = new McpClient(r.name, token ? { ...r, oauth: { ...(r.oauth || {}), accessToken: token.accessToken } } : r)
          await c.connect()
          st.client = c
          st.ok = true
          st.error = ""
          st.tools = c.tools
          st.resources = c.resources
          st.resourceTemplates = c.resourceTemplates
          st.resourceError = c.resourceError
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
    for (const [name, st] of this.clients) out.push({ name, ok: st.ok, error: st.error, tools: st.tools.length, resources: st.resources.length, resourceTemplates: st.resourceTemplates.length, resourceError: st.resourceError || "" })
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

  resources(connector = "") {
    const out = []
    for (const [name, st] of this.clients) {
      if (!st.ok || (connector && connector !== name)) continue
      for (const resource of st.resources) out.push({ connector: name, ...resource })
    }
    return out
  }

  resourceTemplates(connector = "") {
    const out = []
    for (const [name, st] of this.clients) {
      if (!st.ok || (connector && connector !== name)) continue
      for (const template of st.resourceTemplates) out.push({ connector: name, ...template })
    }
    return out
  }

  async readResource(connector, uri) {
    const st = this.clients.get(String(connector || ""))
    if (!st || !st.ok || !st.client) throw new Error(`Connector "${connector}" is not connected`)
    const contents = await st.client.readResource(uri)
    return contents.map((item) => ({
      uri: String(item?.uri || uri || ""),
      ...(item?.mimeType ? { mimeType: String(item.mimeType) } : {}),
      ...(typeof item?.text === "string" ? { type: "text", text: item.text } : {}),
      ...(typeof item?.blob === "string" ? { type: "blob", bytes: Math.floor(item.blob.length * 0.75) } : {}),
    }))
  }

  /** One read action per connector; resource URIs remain lazy. */
  resourceToolObjects() {
    const out = []
    for (const [name, st] of this.clients) {
      if (!st.ok || (!st.resources.length && !st.resourceTemplates.length)) continue
      const qname = `connector__${String(name).replace(/[^\w-]/g, "_")}__read`.slice(0, 64)
      out.push({
        name: qname,
        description: `Read a resource from connector "${name}" by URI. Discoverable resources: ${st.resources.length}; templates: ${st.resourceTemplates.length}.`,
        parameters: { type: "object", properties: { uri: { type: "string", description: "Exact resource URI" } }, required: ["uri"] },
        perm: (args) => ({ tool: "connector", subject: `${name}:${String(args.uri || "")}` }),
        paths: () => [],
        run: async (args) => {
          const contents = await this.readResource(name, args.uri)
          return contents.map((item) => item.type === "text" ? item.text : `[binary resource: ${item.bytes || 0} bytes, ${item.mimeType || "unknown type"}]`).join("\n") || "(empty resource)"
        },
      })
    }
    return out
  }

  beginOAuth(name, { redirectUri, directory } = {}) {
    const row = listServers(directory || this.directory, this.home).find((item) => item.name === name)
    if (!row?.oauth?.authorizationUrl || !row.oauth.tokenUrl || !row.oauth.clientId) throw new Error(`Connector "${name}" has no complete OAuth configuration.`)
    const started = oauth.beginOAuth({ authorizationUrl: row.oauth.authorizationUrl, clientId: row.oauth.clientId, redirectUri, scopes: row.oauth.scopes })
    this.oauthPending.set(started.state, { name, row, redirectUri, verifier: started.verifier, directory: directory || this.directory, createdAt: started.createdAt })
    return { connector: name, url: started.url, state: started.state, createdAt: started.createdAt }
  }

  async completeOAuth({ state, code, fetchImpl } = {}) {
    const pending = this.oauthPending.get(String(state || ""))
    if (!pending) throw new Error("OAuth state is unknown or expired.")
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.oauthPending.delete(state)
      throw new Error("OAuth state expired; start authorization again.")
    }
    const token = await oauth.exchangeCode({
      tokenUrl: pending.row.oauth.tokenUrl,
      clientId: pending.row.oauth.clientId,
      code,
      redirectUri: pending.redirectUri,
      verifier: pending.verifier,
      fetchImpl,
    })
    this.oauthPending.delete(state)
    this.oauthTokens.set(pending.name, token)
    const current = this.clients.get(pending.name)
    try { current?.client?.close() } catch {}
    this.clients.delete(pending.name)
    await this.sync(pending.directory)
    return { connector: pending.name, connected: !!this.clients.get(pending.name)?.ok, expiresIn: token.expiresIn, hasRefreshToken: !!token.refreshToken }
  }

  async clearOAuth(name, directory) {
    const id = String(name || "")
    const removed = this.oauthTokens.delete(id)
    const current = this.clients.get(id)
    try { current?.client?.close() } catch {}
    this.clients.delete(id)
    await this.sync(directory || this.directory)
    return removed
  }
}

module.exports = { globalFile, projectFile, listServers, addServer, removeServer, McpManager, readJson }
