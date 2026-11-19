"use strict"
/**
 * Saved connector accounts (~/.vibe/connectors.json). Tokens are encrypted with
 * the Windows account (DPAPI) through core/store/secrets; other platforms keep
 * the file private (0600). Plaintext tokens never reach logs or the UI.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")
const secrets = require("../store/secrets")

function file(home) { return path.join(home || homeDir(), "connectors.json") }

function readAll(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(home), "utf8"))
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}

function writeAll(data, home) {
  const f = file(home)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 })
  fs.renameSync(tmp, f)
}

/** Public info about a saved account (no token). */
function get(id, home) {
  const row = readAll(home)[id]
  if (!row) return null
  const { token, ...info } = row
  return { ...info, connected: !!token }
}

function token(id, home) {
  const row = readAll(home)[id]
  if (!row || !row.token) return ""
  try { return secrets.decrypt(row.token) } catch { return "" }
}

function save(id, info, plainToken, home) {
  const all = readAll(home)
  all[id] = { ...info, token: secrets.encrypt(plainToken), savedAt: new Date().toISOString() }
  writeAll(all, home)
}

function remove(id, home) {
  const all = readAll(home)
  if (!(id in all)) return false
  delete all[id]
  writeAll(all, home)
  return true
}

module.exports = { file, get, token, save, remove }
