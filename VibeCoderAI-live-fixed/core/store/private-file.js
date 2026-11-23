"use strict"
/**
 * Owner-only file hardening for files that can hold credentials
 * (auth.json, profiles.json custom headers, mcp.json headers/env).
 * POSIX: mode 0600. Windows: chmod is a no-op, so icacls removes inherited
 * ACEs and grants only the current user. Runs icacls once per file per process
 * (the ACL survives later in-place writes to the same file).
 */
const fs = require("fs")
const { spawnSync } = require("child_process")

const aclDone = new Set()

function hardenFileAcl(file) {
  const f = String(file || "")
  if (!f || aclDone.has(f)) return
  aclDone.add(f)
  if (process.platform !== "win32") return
  const user = process.env.USERNAME || process.env.USER
  if (!user) return
  try {
    spawnSync("icacls", [f, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, timeout: 15000, stdio: "ignore" })
  } catch {}
}

/** chmod 0600 + Windows ACL pin */
function makePrivate(file) {
  try {
    fs.chmodSync(file, 0o600)
  } catch {}
  hardenFileAcl(file)
}

/** write a file created with mode 0600, then pin its ACL to the current user */
function writePrivateFile(file, content, encoding = "utf8") {
  fs.writeFileSync(file, content, { encoding, mode: 0o600 })
  makePrivate(file)
}

module.exports = { hardenFileAcl, makePrivate, writePrivateFile }
