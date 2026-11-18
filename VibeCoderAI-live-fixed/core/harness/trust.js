"use strict"
/**
 * Workspace trust for project-scoped executable content.
 *
 * A cloned repository may contain `.vibe/extensions/*.js`,
 * `.vibe/plugins/*.js` and `.vibe/mcp.json`. Loading those automatically gave
 * an untrusted repository code execution in the app process, outside the tool
 * permission system. Global plugins/extensions (installed by the user) keep
 * loading as before; project scope needs an explicit, per-workspace approval.
 *
 * The approval is bound to a hash of the exact executable files, so editing
 * them asks again. No secrets are stored here.
 */
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { homeDir } = require("../util")

const trustFile = (home) => path.join(home || homeDir(), "trust.json")

function readTrust(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(trustFile(home), "utf8"))
    return raw && typeof raw === "object" && raw.projects && typeof raw.projects === "object" ? raw : { version: 1, projects: {} }
  } catch {
    return { version: 1, projects: {} }
  }
}

const keyOf = (directory) => {
  const resolved = path.resolve(String(directory || ""))
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Executable project-scoped files that require trust. */
function projectFiles(directory) {
  const root = path.resolve(String(directory || ""))
  if (!root) return []
  const files = []
  const addDir = (dir) => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      if (!/\.js$/i.test(entry.name)) continue
      files.push(path.join(dir, entry.name))
    }
  }
  addDir(path.join(root, ".vibe", "extensions"))
  addDir(path.join(root, ".vibe", "plugins"))
  const mcp = path.join(root, ".vibe", "mcp.json")
  try { if (fs.statSync(mcp).isFile()) files.push(mcp) } catch {}
  return files
}

function projectSignature(directory) {
  const files = projectFiles(directory)
  if (!files.length) return ""
  const root = path.resolve(String(directory || ""))
  const hash = crypto.createHash("sha256")
  for (const file of files) {
    hash.update(path.relative(root, file).replace(/\\/g, "/"))
    hash.update("\0")
    try { hash.update(fs.readFileSync(file)) } catch { hash.update("<unreadable>") }
    hash.update("\0")
  }
  return hash.digest("hex")
}

function isProjectTrusted(directory, home) {
  const signature = projectSignature(directory)
  if (!signature) return true
  const entry = readTrust(home).projects[keyOf(directory)]
  return !!entry && entry.signature === signature && entry.trusted === true
}

function trustProject(directory, home) {
  const signature = projectSignature(directory)
  if (!signature) return { trusted: true, signature: "" }
  const file = trustFile(home)
  const data = readTrust(home)
  data.projects[keyOf(directory)] = { directory: path.resolve(String(directory)), signature, trusted: true, approvedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
  return { trusted: true, signature }
}

function trustedProjects(home) {
  const data = readTrust(home)
  return Object.entries(data.projects || {})
    .filter(([, entry]) => entry && entry.trusted === true)
    .map(([key, entry]) => {
      const directory = entry.directory || key
      return {
        directory,
        approvedAt: entry.approvedAt || "",
        signature: String(entry.signature || ""),
        files: projectFiles(directory).length,
        current: projectSignature(directory) === entry.signature,
      }
    })
}

function revokeProject(directory, home) {
  const file = trustFile(home)
  const data = readTrust(home)
  const key = keyOf(directory)
  const removed = Object.prototype.hasOwnProperty.call(data.projects, key)
  if (removed) {
    delete data.projects[key]
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  return { removed }
}

module.exports = { trustFile, projectFiles, projectSignature, isProjectTrusted, trustProject, trustedProjects, revokeProject }
