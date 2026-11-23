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
 * The approval is bound to a hash of every file and folder under
 * .vibe/extensions, .vibe/plugins and .vibe/agents (recursively) plus
 * .vibe/mcp.json, so any change there asks again. A workspace is only
 * "automatically trusted" when none of those exist. No secrets are stored here.
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

const TREE_ROOTS = [
  [".vibe", "extensions"],
  [".vibe", "plugins"],
  [".vibe", "agents"],
]
const MAX_TREE_DEPTH = 8
const MAX_TREE_ENTRIES = 5000
const MAX_HASH_BYTES = 16 * 1024 * 1024

/**
 * Walk one project tree. Every entry counts (all files at any depth, symbolic
 * links and sub-folders), so a folder named `evil.js` or a nested file can not
 * slip past the approval. Symbolic links are listed but never followed.
 */
function walkTree(root) {
  const files = []
  const dirs = []
  let exists = false
  try { exists = fs.lstatSync(root).isDirectory() } catch {}
  if (!exists) return { exists: false, files, dirs, truncated: false }
  let truncated = false
  const visit = (dir, depth) => {
    if (truncated) return
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length + dirs.length >= MAX_TREE_ENTRIES) { truncated = true; return }
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { files.push({ file: full, kind: "link" }); continue }
      if (entry.isDirectory()) {
        dirs.push(full)
        if (depth >= MAX_TREE_DEPTH) { truncated = true; continue }
        visit(full, depth + 1)
        continue
      }
      files.push({ file: full, kind: entry.isFile() ? "file" : "other" })
    }
  }
  visit(root, 0)
  return { exists: true, files, dirs, truncated }
}

function projectTrees(directory) {
  const root = path.resolve(String(directory || ""))
  return TREE_ROOTS.map((parts) => {
    const dir = path.join(root, ...parts)
    return { dir, ...walkTree(dir) }
  })
}

/**
 * Project-scoped files that require trust: everything under .vibe/extensions,
 * .vibe/plugins and .vibe/agents (recursively) plus .vibe/mcp.json. A tree that
 * exists but holds no files is listed by its folder so it still asks once.
 */
function projectFiles(directory) {
  if (!directory) return []
  const root = path.resolve(String(directory || ""))
  if (!root) return []
  const files = []
  for (const tree of projectTrees(root)) {
    if (!tree.exists) continue
    if (!tree.files.length) { files.push(tree.dir); continue }
    for (const row of tree.files) files.push(row.file)
  }
  const mcp = path.join(root, ".vibe", "mcp.json")
  try { if (fs.lstatSync(mcp).isFile() || fs.lstatSync(mcp).isSymbolicLink()) files.push(mcp) } catch {}
  return files
}

function hashFile(hash, file) {
  let st
  try { st = fs.lstatSync(file) } catch { hash.update("<missing>"); return }
  if (st.isSymbolicLink()) {
    let target = ""
    try { target = fs.readlinkSync(file) } catch {}
    hash.update("<symlink>" + target)
    return
  }
  if (!st.isFile()) { hash.update(`<other:${st.mode}>`); return }
  if (st.size > MAX_HASH_BYTES) { hash.update(`<large:${st.size}:${st.mtimeMs}>`); return }
  try { hash.update(fs.readFileSync(file)) } catch { hash.update("<unreadable>") }
}

function projectSignature(directory) {
  if (!directory) return ""
  const root = path.resolve(String(directory || ""))
  const rel = (file) => path.relative(root, file).replace(/\\/g, "/")
  const hash = crypto.createHash("sha256")
  let any = false
  for (const tree of projectTrees(root)) {
    if (!tree.exists) continue
    any = true
    hash.update("tree\0" + rel(tree.dir) + "\0")
    for (const dir of tree.dirs) hash.update("dir\0" + rel(dir) + "\0")
    for (const row of tree.files) {
      hash.update(row.kind + "\0" + rel(row.file) + "\0")
      hashFile(hash, row.file)
      hash.update("\0")
    }
    if (tree.truncated) hash.update("<truncated>\0")
  }
  const mcp = path.join(root, ".vibe", "mcp.json")
  let hasMcp = false
  try { hasMcp = fs.lstatSync(mcp).isFile() || fs.lstatSync(mcp).isSymbolicLink() } catch {}
  if (hasMcp) {
    any = true
    hash.update("file\0.vibe/mcp.json\0")
    hashFile(hash, mcp)
    hash.update("\0")
  }
  return any ? hash.digest("hex") : ""
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
