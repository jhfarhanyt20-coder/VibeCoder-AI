"use strict"
/**
 * Loom — layered project briefs for the agent context.
 *
 * Order (stable, so the model's prompt cache survives between turns):
 *   1. global      <VIBE_HOME>/VIBE.md
 *   2. project     <root>/VIBE.md
 *   3. nested      <root>/sub/VIBE.md ... up to the workspace
 *   4. per-folder  <dir>/.vibe/briefs/*.md
 *
 * Only files that exist are included. With no brief files this returns an
 * empty string, which means the existing prompt is byte-for-byte unchanged.
 *
 * This module never executes anything from a brief. A brief is project data,
 * not policy: it cannot grant permissions or override a lock.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir, toPosix } = require("../util")

const MAX_FILE_CHARS = 12000
const MAX_TOTAL_CHARS = 30000
const MAX_BRIEFS_PER_DIR = 20
const MAX_DEPTH = 12

function stripBom(text) {
  return String(text == null ? "" : text).replace(/^\uFEFF/, "")
}

function readBrief(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_FILE_CHARS * 4) return ""
    return stripBom(fs.readFileSync(file, "utf8")).trim()
  } catch {
    return ""
  }
}

/** Nearest project root: the first ancestor containing .git, else the workspace. */
function findRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd())
  const start = dir
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir
    } catch {}
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return start
}

/** Directories from root down to cwd, inclusive. */
function rootToCwd(root, cwd) {
  const target = path.resolve(cwd || process.cwd())
  const rel = path.relative(root, target)
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return [root]
  const out = [root]
  let cur = root
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    cur = path.join(cur, part)
    out.push(cur)
  }
  return out
}

function listFolderBriefs(dir) {
  const folder = path.join(dir, ".vibe", "briefs")
  let entries = []
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name) && !entry.name.startsWith("."))
    .map((entry) => path.join(folder, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_BRIEFS_PER_DIR)
}

function clip(text, max) {
  const value = String(text || "")
  return value.length > max ? value.slice(0, max) + "\n...[brief clipped]" : value
}

/**
 * Build the combined brief text. `label` is used for the section heading so
 * the model knows which file the guidance came from.
 */
function buildBrief({ cwd, home } = {}) {
  const workspace = path.resolve(cwd || process.cwd())
  const globalDir = home || homeDir()
  const root = findRoot(workspace)
  const dirs = rootToCwd(root, workspace)
  const files = []

  const add = (file) => {
    if (!file) return
    try {
      const real = fs.realpathSync(file)
      if (files.some((item) => item.real === real)) return
      files.push({ file, real })
    } catch {}
  }

  add(path.join(globalDir, "VIBE.md"))
  for (const dir of dirs) add(path.join(dir, "VIBE.md"))
  for (const dir of dirs) for (const file of listFolderBriefs(dir)) add(file)

  const sections = []
  let used = 0
  for (const item of files) {
    const text = readBrief(item.file)
    if (!text) continue
    const remaining = MAX_TOTAL_CHARS - used
    if (remaining <= 0) break
    const body = clip(text, Math.min(MAX_FILE_CHARS, remaining))
    const rel = path.relative(workspace, item.file)
    const label = rel && !rel.startsWith("..") ? toPosix(rel) : toPosix(path.relative(root, item.file)) || "VIBE.md"
    sections.push(`## ${label}\n${body}`)
    used += body.length + label.length + 4
  }
  return sections.join("\n\n")
}

module.exports = {
  buildBrief,
  findRoot,
  rootToCwd,
  listFolderBriefs,
  MAX_FILE_CHARS,
  MAX_TOTAL_CHARS,
}
