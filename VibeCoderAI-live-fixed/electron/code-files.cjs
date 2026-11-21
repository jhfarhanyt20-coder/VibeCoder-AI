"use strict"
// Code panel files: browse, read and save files of the open project folder.
const fs = require("fs")
const path = require("path")
const { execFile } = require("child_process")
const { promisify } = require("util")
const execFileAsync = promisify(execFile)

/* ---------- code panel: browse, read and save files of the open project ----------
   Only files inside the project folder that is open in the app (symlinks are
   resolved first, so a link cannot reach outside it). Saving only replaces an
   existing file, and refuses when the file changed on disk after it was read
   (the agent may have edited it meanwhile). */
const CODE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "release", "out", ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv", "coverage", ".turbo", ".parcel-cache", "target"])
const CODE_MAX_ENTRIES = 5000
const CODE_MAX_BYTES = 2 * 1024 * 1024

function codeRoot(dir) {
  if (!dir) throw new Error("No project folder is open")
  return fs.realpathSync(dir)
}

function codePath(dir, file) {
  const root = codeRoot(dir)
  const full = path.resolve(root, String(file || ""))
  let real = full
  try { real = fs.realpathSync(full) } catch { /* checked by the caller */ }
  const rel = path.relative(root, real)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("This file is outside the open project folder")
  return { root, full: real, rel: rel.split(path.sep).join("/") }
}

function codeTree(dir) {
  const root = codeRoot(dir)
  let entries = 0
  let files = 0
  let truncated = false
  const walk = (dir, rel) => {
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
    list.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    const out = []
    for (const d of list) {
      if (entries >= CODE_MAX_ENTRIES) { truncated = true; break }
      const childRel = rel ? `${rel}/${d.name}` : d.name
      if (d.isDirectory()) {
        entries++
        if (CODE_SKIP_DIRS.has(d.name)) out.push({ name: d.name, path: childRel, dir: true, skipped: true, children: [] })
        else out.push({ name: d.name, path: childRel, dir: true, children: walk(path.join(dir, d.name), childRel) })
      } else if (d.isFile() || d.isSymbolicLink()) {
        entries++
        files++
        out.push({ name: d.name, path: childRel })
      }
    }
    return out
  }
  const tree = walk(root, "")
  return { root, name: path.basename(root), files, truncated, tree }
}

// Git state of the project's files: M changed, A added, D deleted, U new
// (not in git yet). Paths relative to the project folder. Empty without git.
async function codeGitStatus(root) {
  const git = (args) => execFileAsync("git", args, { cwd: root, windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 })
  try {
    const top = (await git(["rev-parse", "--show-toplevel"])).stdout.trim()
    const { stdout } = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
    const status = {}
    const parts = stdout.split("\0")
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i]
      if (line.length < 4) continue
      const code = line.slice(0, 2)
      if (code[0] === "R" || code[0] === "C") i++ // the old name follows
      const rel = path.relative(root, path.resolve(top, line.slice(3))).split(path.sep).join("/")
      if (!rel || rel.startsWith("..")) continue
      status[rel] = code === "??" ? "U" : code.includes("D") ? "D" : code.includes("A") ? "A" : "M"
    }
    return status
  } catch {
    return {}
  }
}

function codeRead(dir, arg = {}) {
  const { full, rel } = codePath(dir, arg.file)
  const stat = fs.statSync(full)
  if (!stat.isFile()) throw new Error("Not a file")
  const base = { path: rel, full, name: path.basename(full), size: stat.size, mtimeMs: stat.mtimeMs }
  if (stat.size > CODE_MAX_BYTES) return { ...base, tooBig: true }
  const data = fs.readFileSync(full)
  if (data.subarray(0, 8000).includes(0)) return { ...base, binary: true }
  let text = data.toString("utf8")
  const bom = text.charCodeAt(0) === 0xfeff
  if (bom) text = text.slice(1)
  const eol = /\r\n/.test(text) ? "\r\n" : "\n"
  return { ...base, text, eol, bom }
}

function codeWrite(dir, arg = {}) {
  const { full, rel } = codePath(dir, arg.file)
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error("Only an existing file can be saved here")
  const stat = fs.statSync(full)
  if (arg.mtimeMs != null && Math.abs(stat.mtimeMs - Number(arg.mtimeMs)) > 1 && !arg.force) {
    const err = new Error("The file changed on disk after you opened it (the agent may have edited it). Reload it, or save anyway to overwrite.")
    err.code = "CHANGED_ON_DISK"
    throw err
  }
  let text = String(arg.text ?? "").replace(/\r\n/g, "\n")
  if (arg.eol === "\r\n") text = text.replace(/\n/g, "\r\n")
  if (arg.bom) text = "﻿" + text
  if (Buffer.byteLength(text) > CODE_MAX_BYTES) throw new Error("The file is too large to save here (2 MB at most)")
  fs.writeFileSync(full, text, "utf8")
  const after = fs.statSync(full)
  return { path: rel, size: after.size, mtimeMs: after.mtimeMs }
}

module.exports = { codeTree, codeRead, codeWrite, codeGitStatus, codePath }
