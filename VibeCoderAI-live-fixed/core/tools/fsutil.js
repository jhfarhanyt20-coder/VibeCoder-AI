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

/** Myers line diff. Returns equal/add/delete operations, or null at the safety cap. */
function lineDiff(before, after, maxDistance = 2000) {
  const n = before.length
  const m = after.length
  if (!n) return after.map((text) => ({ type: "add", text }))
  if (!m) return before.map((text) => ({ type: "del", text }))
  const max = n + m
  const v = new Map([[1, 0]])
  const trace = []
  for (let d = 0; d <= max && d <= maxDistance; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const left = v.has(k - 1) ? v.get(k - 1) : -Infinity
      const right = v.has(k + 1) ? v.get(k + 1) : -Infinity
      let x = k === -d || (k !== d && left < right) ? right : left + 1
      if (!Number.isFinite(x)) x = 0
      let y = x - k
      while (x < n && y < m && before[x] === after[y]) { x++; y++ }
      v.set(k, x)
      if (x < n || y < m) continue

      const reversed = []
      let bx = n
      let by = m
      for (let bd = trace.length - 1; bd >= 0; bd--) {
        const snapshot = trace[bd]
        const bk = bx - by
        const bLeft = snapshot.has(bk - 1) ? snapshot.get(bk - 1) : -Infinity
        const bRight = snapshot.has(bk + 1) ? snapshot.get(bk + 1) : -Infinity
        const prevK = bk === -bd || (bk !== bd && bLeft < bRight) ? bk + 1 : bk - 1
        const prevX = Number.isFinite(snapshot.get(prevK)) ? snapshot.get(prevK) : 0
        const prevY = prevX - prevK
        while (bx > prevX && by > prevY) {
          reversed.push({ type: "equal", text: before[bx - 1] })
          bx--; by--
        }
        if (bd === 0) break
        if (bx === prevX) {
          by--
          reversed.push({ type: "add", text: after[by] })
        } else {
          bx--
          reversed.push({ type: "del", text: before[bx] })
        }
      }
      return reversed.reverse()
    }
  }
  return null
}

function annotateLines(ops, oldLine, newLine) {
  return ops.map((op) => {
    const row = { ...op, oldLine: null, newLine: null }
    if (op.type !== "add") row.oldLine = oldLine++
    if (op.type !== "del") row.newLine = newLine++
    return row
  })
}

function makeHunks(ops, context = 3) {
  const changes = []
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== "equal") changes.push(i)
  if (!changes.length) return []
  const ranges = []
  for (const index of changes) {
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length, index + context + 1)
    const previous = ranges[ranges.length - 1]
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else ranges.push({ start, end })
  }
  return ranges.map(({ start, end }) => {
    const lines = ops.slice(start, end)
    const oldRows = lines.filter((line) => line.type !== "add")
    const newRows = lines.filter((line) => line.type !== "del")
    const firstOld = oldRows.find((line) => line.oldLine != null)
    const firstNew = newRows.find((line) => line.newLine != null)
    return {
      oldStart: firstOld?.oldLine || (firstNew?.newLine || 1),
      oldCount: oldRows.length,
      newStart: firstNew?.newLine || (firstOld?.oldLine || 1),
      newCount: newRows.length,
      lines,
    }
  })
}

/**
 * Proper line diff for edit cards. Unchanged lines inside the changed region are
 * aligned instead of turning the whole middle of a file into one red block and
 * one green block. Structured hunks carry old/new line numbers for the UI;
 * `patch` remains for older sessions/clients.
 */
function diffStats(before, after) {
  const splitLines = (value) => value == null || String(value) === "" ? [] : String(value).replace(/\r\n/g, "\n").split("\n")
  const bl = splitLines(before)
  const al = splitLines(after)
  if (bl.length > 1 && bl[bl.length - 1] === "") bl.pop()
  if (al.length > 1 && al[al.length - 1] === "") al.pop()
  let start = 0
  while (start < bl.length && start < al.length && bl[start] === al[start]) start++
  let end = 0
  while (end < bl.length - start && end < al.length - start && bl[bl.length - 1 - end] === al[al.length - 1 - end]) end++
  const beforeMid = bl.slice(start, bl.length - end)
  const afterMid = al.slice(start, al.length - end)
  let middle = lineDiff(beforeMid, afterMid)
  if (!middle) middle = [
    ...beforeMid.map((text) => ({ type: "del", text })),
    ...afterMid.map((text) => ({ type: "add", text })),
  ]
  const prefixStart = Math.max(0, start - 3)
  const prefix = bl.slice(prefixStart, start).map((text) => ({ type: "equal", text }))
  const suffixStart = bl.length - end
  const suffix = bl.slice(suffixStart, Math.min(bl.length, suffixStart + 3)).map((text) => ({ type: "equal", text }))
  const ops = annotateLines([...prefix, ...middle, ...suffix], prefixStart + 1, prefixStart + 1)
  const additions = middle.filter((op) => op.type === "add").length
  const deletions = middle.filter((op) => op.type === "del").length
  const rawHunks = makeHunks(ops)
  let kept = 0
  const hunks = rawHunks.map((hunk) => {
    const room = Math.max(0, 500 - kept)
    const lines = hunk.lines.slice(0, room)
    kept += lines.length
    if (lines.length < hunk.lines.length && room > 0) lines.push({ type: "meta", text: `… ${hunk.lines.length - lines.length} changed lines omitted`, oldLine: null, newLine: null })
    return { ...hunk, lines }
  }).filter((hunk) => hunk.lines.length)
  const patchLines = []
  for (const hunk of hunks) {
    patchLines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`)
    for (const line of hunk.lines) patchLines.push(line.type === "add" ? `+${line.text}` : line.type === "del" ? `-${line.text}` : line.type === "meta" ? line.text : ` ${line.text}`)
  }
  return {
    additions,
    deletions,
    oldLines: bl.length,
    newLines: al.length,
    hunks,
    patch: patchLines.join("\n").slice(0, 30000),
  }
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0)

module.exports = { resolvePath, isInside, walk, looksBinary, IGNORE, diffStats, lineDiff }
