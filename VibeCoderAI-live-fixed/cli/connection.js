"use strict"
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const secrets = require("../core/store/secrets")
const { homeDir } = require("../core/util")
const { readJson, writeJson } = require("../core/control")

function loopbackUrl(value) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
    throw new Error("The VibeCore management connection must use a local loopback URL without embedded credentials.")
  }
  return url.origin
}
/** Owner-readable connection records; Windows tokens use the existing DPAPI store. */
function publishHost(server, engine, token) {
  let file = null
  const instance = crypto.randomBytes(12).toString("hex")
  server.on("listening", () => {
    const address = server.address()
    if (!address || typeof address === "string") return
    file = path.join(engine.home, "hosts", `${process.pid}-${address.port}.json`)
    try {
      writeJson(file, {
        instance, pid: process.pid, created: Date.now(), url: `http://127.0.0.1:${address.port}`,
        version: require("../package.json").version, token: secrets.encrypt(token),
      }, { private: true })
    } catch {
      // A locked home must not prevent the desktop/server from starting.
      file = null
    }
  })
  server.on("close", () => {
    if (!file) return
    try { if (readJson(file, {}).instance === instance) fs.unlinkSync(file) } catch {}
  })
}

async function findHost(home = homeDir()) {
  const dir = path.join(home, "hosts")
  let files
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+-\d+\.json$/.test(f))
      .map((file) => ({ file, updated: fs.statSync(path.join(dir, file)).mtimeMs }))
      .sort((a, b) => b.updated - a.updated).slice(0, 32).map((row) => row.file)
  } catch { files = [] }
  const records = files.flatMap((file) => {
    try {
      const row = readJson(path.join(dir, file), {})
      if (!Number.isInteger(row.pid) || row.pid <= 0) return []
      process.kill(row.pid, 0)
      return [row]
    } catch { return [] }
  })
  await secrets.warm(records.map((row) => row.token).filter((token) => typeof token === "string" && token.startsWith(secrets.PREFIX)))
  const results = await Promise.all(records.map(async (row) => {
    try {
      const url = loopbackUrl(row.url)
      const token = secrets.decrypt(row.token)
      const response = await fetch(url + "/health", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500), redirect: "error" })
      if (!response.ok || !(await response.json()).ok) return null
      return { ...row, url, token }
    } catch { return null }
  }))
  const host = results.filter(Boolean).sort((a, b) => b.created - a.created)[0]
  if (!host) throw new Error("No running VibeCore host found. Start the desktop app or vibe serve, then run vibe attach.")
  return host
}
module.exports = { publishHost, findHost, loopbackUrl }
