"use strict"
/**
 * Minimal MCP (Model Context Protocol) client - zero dependencies.
 * Supports the two standard transports:
 *   local  : spawn the server, newline-delimited JSON-RPC over stdin/stdout
 *   remote : POST JSON-RPC to the URL (Streamable HTTP; JSON or SSE replies)
 * Just enough of the protocol to be useful: initialize -> tools/list -> tools/call.
 */
const { spawn } = require("child_process")

const PROTOCOL = "2024-11-05"
const CLIENT_INFO = { name: "vibecoder-ai", version: "0.1" }

class McpClient {
  constructor(name, entry) {
    this.name = name
    this.entry = entry // { type: "local"|"remote", command?, url?, env?, headers? }
    this.tools = []
    this.status = "connecting" // connecting | ready | error
    this.error = ""
    this.pending = new Map()
    this.nextId = 1
    this.child = null
    this.sessionId = ""
  }

  /* ---------- transports ---------- */
  _send(msg) {
    if (this.entry.type === "local") {
      if (!this.child || !this.child.stdin.writable) throw new Error(`MCP server "${this.name}" is not running`)
      this.child.stdin.write(JSON.stringify(msg) + "\n")
      return
    }
    return this._postRemote(msg)
  }

  async _postRemote(msg, signal) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.entry.headers || {}),
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    // Merge the caller's abort signal (if any) with a 60s timeout so a stopped
    // run can cancel an in-flight MCP call instead of waiting the full minute.
    const timeout = AbortSignal.timeout(60000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const res = await fetch(this.entry.url, { method: "POST", headers, body: JSON.stringify(msg), signal: combined })
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
    if (!res.ok) throw new Error(`MCP "${this.name}" answered HTTP ${res.status}`)
    const ct = res.headers.get("content-type") || ""
    if (!msg.id && msg.method) return // notification: fire and forget
    if (/event-stream/i.test(ct)) {
      // SSE body: take the data: line that carries our response id
      const text = await res.text()
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue
        try {
          const j = JSON.parse(line.slice(5).trim())
          if (j.id === msg.id || j.result !== undefined || j.error !== undefined) return j
        } catch {}
      }
      return null
    }
    return res.json().catch(() => null)
  }

  /** JSON-RPC request; resolves the result or throws the protocol error. */
  async _request(method, params) {
    const id = this.nextId++
    const msg = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }
    if (this.entry.type !== "local") {
      const r = await this._postRemote(msg)
      if (!r) throw new Error(`MCP "${this.name}": no response to ${method}`)
      if (r.error) throw new Error((r.error.message || JSON.stringify(r.error)) + ` (${method})`)
      return r.result
    }
    const reply = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP "${this.name}": timeout waiting for ${method}`))
      }, 30000)
      this.pending.set(id, { resolve, reject, timer: t })
      try {
        this._send(msg)
      } catch (e) {
        clearTimeout(t)
        this.pending.delete(id)
        reject(e)
      }
    })
    if (reply.error) throw new Error((reply.error.message || JSON.stringify(reply.error)) + ` (${method})`)
    return reply.result
  }

  _notify(method, params) {
    const msg = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }
    try {
      if (this.entry.type === "local") this._send(msg)
      else this._postRemote(msg).catch(() => {})
    } catch {}
  }

  /* ---------- lifecycle ---------- */
  async connect() {
    if (this.entry.type === "local") {
      const [cmd, ...args] = this.entry.command
      if (!cmd) throw new Error("local MCP server needs a command")
      this.child = spawn(cmd, args, {
        cwd: this.entry.cwd || process.cwd(),
        env: { ...process.env, ...(this.entry.env || {}) },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
      let buf = ""
      this.child.stdout.on("data", (d) => {
        buf += d.toString()
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (!line) continue
          let j
          try {
            j = JSON.parse(line)
          } catch {
            continue
          }
          if (j.id !== undefined && this.pending.has(j.id)) {
            const p = this.pending.get(j.id)
            clearTimeout(p.timer)
            this.pending.delete(j.id)
            p.resolve(j)
          }
        }
      })
      this.child.stderr.on("data", () => {})
      // a dead / missing server must fail its pending requests NOW (they used to
      // sit in a 30s timeout, which blocked the first model request of a run)
      const failPending = (msg) => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer)
          try {
            p.reject(new Error(msg))
          } catch {}
        }
        this.pending.clear()
      }
      this.child.on("close", () => {
        this.status = "error"
        this.error = "server process exited"
        failPending(`MCP "${this.name}": server process exited`)
      })
      this.child.on("error", (e) => {
        this.status = "error"
        this.error = e.message
        failPending(`MCP "${this.name}": ${e.message}`)
      })
      this.child.stdin.on("error", () => {})
    } else if (!/^https?:/i.test(this.entry.url || "")) {
      throw new Error("remote MCP server needs an http(s) url")
    }
    // the WHOLE handshake is bounded (a server that spawns but never answers
    // used to hold the connect for 2 x 30s); a failed connect kills the child
    let guard = null
    try {
      await Promise.race([
        (async () => {
          await this._request("initialize", {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          })
          this._notify("notifications/initialized", {})
          const out = await this._request("tools/list", {})
          this.tools = Array.isArray(out && out.tools) ? out.tools : []
        })(),
        new Promise((_, rej) => {
          guard = setTimeout(() => rej(new Error(`MCP "${this.name}": no answer within 20s`)), 20000)
        }),
      ])
    } catch (e) {
      this.close()
      this.status = "error"
      this.error = (e && e.message) || String(e)
      throw e
    } finally {
      clearTimeout(guard)
    }
    this.status = "ready"
    this.error = ""
    return this
  }

  async callTool(tool, args) {
    const out = await this._request("tools/call", { name: tool, arguments: args || {} })
    if (out && out.isError) {
      const t = (out.content || []).map((c) => c.text || "").join("\n")
      throw new Error(t || "MCP tool returned an error")
    }
    const parts = (out && out.content) || []
    const text = parts.map((c) => (c.type === "text" ? c.text : `[${c.type} content]`)).join("\n")
    return text || JSON.stringify(out && (out.structuredContent || out)) || "(empty result)"
  }

  close() {
    try {
      this.child && this.child.kill()
    } catch {}
    this.child = null
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    this.status = "closed"
  }
}

module.exports = { McpClient }
