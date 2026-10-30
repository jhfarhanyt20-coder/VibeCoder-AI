"use strict"
const fs = require("fs")
const path = require("path")

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".vibecoder", "__pycache__", ".venv", "target"])

/** Resolve a user/model path against the workspace. */
const resolvePath = (cwd, p) => path.resolve(cwd, String(p || "."))
/** realpath of the deepest EXISTING ancestor + the not-yet-existing rest (so a symlink/junction cannot hide a path). */
function realish(p) {
  let cur = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      const r = fs.realpathSync.native(cur)
      return rest.length ? path.join(r, ...rest.reverse()) : r
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}
const within = (a, b) => {
  const rel = path.relative(a, b)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}
/** Inside the workspace both lexically AND after resolving symlinks/junctions. */
const isInside = (cwd, abs) => within(path.resolve(cwd), path.resolve(abs)) && within(realish(cwd), realish(abs))

function* walk(root, { maxFiles = 20000 } = {}) {
  let count = 0
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORE.has(e.name)) stack.push(full)
      } else if (e.isFile()) {
        if (++count > maxFiles) return
        yield full
      }
    }
  }
}

/**
 * Line diff for the tool cards: identical head/tail are trimmed (the typical
 * edit case), the changed middle becomes additions/deletions counts plus a
 * compact +/- patch preview the UI can expand. Capped so sessions stay small.
 */
function diffStats(before, after) {
  const bl = before == null ? [] : String(before).replace(/\r\n/g, "\n").split("\n")
  const al = String(after == null ? "" : after).replace(/\r\n/g, "\n").split("\n")
  if (bl.length > 1 && bl[bl.length - 1] === "") bl.pop() // trailing newline is not a line
  if (al.length > 1 && al[al.length - 1] === "") al.pop()
  let s = 0
  while (s < bl.length && s < al.length && bl[s] === al[s]) s++
  let e = 0
  while (e < bl.length - s && e < al.length - s && bl[bl.length - 1 - e] === al[al.length - 1 - e]) e++
  const bMid = bl.slice(s, bl.length - e)
  const aMid = al.slice(s, al.length - e)
  const CAP = 150
  const lines = []
  if (s) lines.push(`\u2026 ${s} unchanged`)
  for (const l of bMid.slice(0, CAP)) lines.push("-" + l)
  for (const l of aMid.slice(0, CAP)) lines.push("+" + l)
  if (bMid.length > CAP || aMid.length > CAP) lines.push(`\u2026 ${bMid.length + aMid.length - 2 * CAP} more changed lines`)
  if (e) lines.push(`\u2026 ${e} unchanged`)
  return { additions: aMid.length, deletions: bMid.length, patch: lines.join("\n").slice(0, 20000) }
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0)

module.exports = { resolvePath, isInside, walk, looksBinary, IGNORE, diffStats }
