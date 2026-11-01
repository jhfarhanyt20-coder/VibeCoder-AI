"use strict"
/** `vibe serve`: local HTTP + SSE API (loopback only, bearer token). The SDK's remote mode talks to this. */
const http = require("http")
const crypto = require("crypto")

function createServer(engine, { token = crypto.randomBytes(24).toString("hex") } = {}) {
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on("data", (c) => {
        size += c.length
        if (size > 5 * 1024 * 1024) {
          reject(new Error("Body too large"))
          req.destroy()
        } else chunks.push(c)
      })
      req.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
        } catch {
          reject(new Error("Invalid JSON body"))
        }
      })
      req.on("error", reject)
    })
  const okToken = (given) => {
    const a = Buffer.from(String(given || ""))
    const b = Buffer.from(token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  const sse = (res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    return (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || "").replace(/:\d+$/, "")
      if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return sendJson(res, 403, { error: "forbidden host" })
      if (req.headers.origin) return sendJson(res, 403, { error: "browser origins are not allowed" })
      const auth = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "")
      if (!okToken(auth)) return sendJson(res, 401, { error: "unauthorized" })

      const url = new URL(req.url, "http://127.0.0.1")
      const p = url.pathname.split("/").filter(Boolean)
      const m = req.method

      if (m === "GET" && p[0] === "health") return sendJson(res, 200, { ok: true })
      if (m === "GET" && p[0] === "profiles") return sendJson(res, 200, engine.listProfiles().map(({ headers, ...rest }) => rest))
      if (m === "GET" && p[0] === "events") {
        const write = sse(res)
        const off = engine.on(write)
        req.on("close", off)
        return
      }
      if (p[0] === "permission" && m === "POST" && p[1]) {
        const b = await readBody(req)
        return sendJson(res, 200, { ok: engine.replyPermission(p[1], b.decision) })
      }
      if (p[0] === "form") {
        if (!p[1] && m === "GET") return sendJson(res, 200, engine.listForms(url.searchParams.get("sessionID") || null))
        if (p[1] && p[2] === "reply" && m === "POST")
          return sendJson(res, 200, { replied: engine.replyForm(p[1], (await readBody(req)).answer) })
        if (p[1] && p[2] === "cancel" && m === "POST")
          return sendJson(res, 200, { cancelled: engine.cancelForm(p[1], (await readBody(req)).message) })
      }
      if (p[0] === "session") {
        if (!p[1]) {
          if (m === "GET") return sendJson(res, 200, engine.listSessions({ dir: url.searchParams.get("dir") || undefined }))
          if (m === "POST") return sendJson(res, 200, engine.createSession(await readBody(req)))
        } else {
          const id = p[1]
          if (!p[2]) {
            if (m === "GET") return sendJson(res, 200, engine.getSession(id))
            if (m === "PATCH") return sendJson(res, 200, engine.renameSession(id, (await readBody(req)).title))
            if (m === "DELETE") return engine.removeSession(id), sendJson(res, 200, { ok: true })
          }
          if (p[2] === "revert" && m === "POST") {
            const b = await readBody(req)
            return sendJson(res, 200, engine.revertSession(id, b.messageID))
          }
          if (p[2] === "prompt" && m === "POST") {
            const b = await readBody(req)
            const ctl = new AbortController()
            res.on("close", () => ctl.abort())
            const write = sse(res)
            try {
              for await (const ev of engine.prompt(id, b.text, { signal: ctl.signal, files: b.files })) write(ev)
            } catch (e) {
              write({ type: "error", message: e.message })
              write({ type: "done", reason: "error" })
            }
            return res.end()
          }
          if (p[2] === "resume" && m === "POST") {
            const ctl = new AbortController()
            res.on("close", () => ctl.abort())
            const write = sse(res)
            try {
              for await (const ev of engine.resume(id, { signal: ctl.signal })) write(ev)
            } catch (e) {
              write({ type: "error", message: e.message })
              write({ type: "done", reason: "error" })
            }
            return res.end()
          }
          if (p[2] === "interrupt" && m === "POST") return engine.interrupt(id), sendJson(res, 200, { ok: true })
          if (p[2] === "compact" && m === "POST") return sendJson(res, 200, await engine.compact(id, await readBody(req)))
          if (p[2] === "model" && m === "POST") return sendJson(res, 200, engine.switchModel(id, (await readBody(req)).profile))
        }
      }
      sendJson(res, 404, { error: "not found" })
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message })
      else res.end()
    }
  })
  return { server, token }
}

module.exports = { createServer }
