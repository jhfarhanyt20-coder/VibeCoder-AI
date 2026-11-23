"use strict"
/**
 * Edit helpers shared by edit / multiedit.
 *
 *  1. applyEdit(): exact match first, then a chain of progressively looser
 *     matchers (OpenCode-style replacers) so a small whitespace / indentation
 *     slip by the model does not fail the whole edit.
 *  2. fileGuard: read-before-edit + "modified since you read it" check.
 */
const fs = require("fs")
const snapshots = require("../store/snapshots")

// ---------------------------------------------------------------- matchers
const trimEndLines = (s) => String(s).split(/\r?\n/)

/** Lines of src with their char offsets: [{ text, start, end }] (end excludes the newline). */
function indexLines(src) {
  const out = []
  let pos = 0
  while (pos <= src.length) {
    let nl = src.indexOf("\n", pos)
    if (nl === -1) nl = src.length
    const end = nl > pos && src[nl - 1] === "\r" ? nl - 1 : nl
    out.push({ text: src.slice(pos, end), start: pos, end })
    pos = nl + 1
  }
  return out
}

function wantedLines(oldS) {
  const lines = trimEndLines(oldS)
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop() // trailing newline
  return lines
}

const minIndent = (lines) => {
  let min = null
  for (const l of lines) {
    if (!l.trim()) continue
    const ind = /^[ \t]*/.exec(l)[0]
    if (min === null || ind.length < min.length) min = ind
  }
  return min || ""
}

/** exact substring occurrences */
function exactMatcher(src, oldS) {
  const out = []
  if (!oldS) return out
  let i = 0
  for (;;) {
    const at = src.indexOf(oldS, i)
    if (at === -1) break
    out.push({ start: at, end: at + oldS.length })
    i = at + oldS.length
  }
  return out
}

/**
 * Typographic look-alikes: models often write “smart” quotes, en/em dashes or
 * a non-breaking space where the file has plain ASCII (or the other way
 * round). Each look-alike maps to ONE ASCII character, so positions found in
 * the normalized text are exact positions in the original file.
 */
const TYPO = /[‘’‚‛′‵“”„‟″‶‐‑‒–—―−    ]/g
const TYPO_MAP = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "‵": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "‶": '"', "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-", " ": " ", " ": " ", " ": " ", " ": " " }
const plainTypography = (s) => String(s).replace(TYPO, (ch) => TYPO_MAP[ch] || ch)

/** exact match after mapping typographic look-alikes to ASCII on both sides */
function typographyMatcher(src, oldS) {
  const a = plainTypography(src)
  const b = plainTypography(oldS)
  if (a === src && b === oldS) return [] // nothing to normalize: exact already decided
  return exactMatcher(a, b)
}

/** every line equal after trim() */
function lineTrimmedMatcher(src, oldS) {
  const want = wantedLines(oldS).map((l) => l.trim())
  const lines = indexLines(src)
  const out = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true
    for (let j = 0; j < want.length; j++) if (lines[i + j].text.trim() !== want[j]) { ok = false; break }
    if (ok) out.push({ start: lines[i].start, end: lines[i + want.length - 1].end, reindent: true, lineBased: true })
  }
  return out
}

/** same tokens; whitespace may differ, appear or vanish next to punctuation */
function whitespaceMatcher(src, oldS) {
  const tokens = oldS.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) || []
  if (!tokens.length || tokens.length > 4000) return []
  const word = /[\p{L}\p{N}_]/u
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  let pat = esc(tokens[0])
  for (let i = 1; i < tokens.length; i++)
    pat += (word.test(tokens[i - 1].slice(-1)) && word.test(tokens[i][0]) ? "\\s+" : "\\s*") + esc(tokens[i])
  let re
  try { re = new RegExp(pat, "gu") } catch { return [] }
  const out = []
  let m
  const wantNl = /\r?\n$/.test(oldS)
  while ((m = re.exec(src))) {
    let end = m.index + m[0].length
    if (wantNl) { if (src.startsWith("\r\n", end)) end += 2; else if (src[end] === "\n") end += 1 }
    out.push({ start: m.index, end })
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

/** same block after removing the common indentation from both sides */
function indentFlexMatcher(src, oldS) {
  const want = wantedLines(oldS)
  const wi = minIndent(want).length
  const norm = (ls, n) => ls.map((l) => (l.trim() ? l.slice(Math.min(n, /^[ \t]*/.exec(l)[0].length)).trimEnd() : ""))
  const wantN = norm(want, wi)
  const lines = indexLines(src)
  const out = []
  for (let i = 0; i + want.length <= lines.length; i++) {
    const block = lines.slice(i, i + want.length).map((x) => x.text)
    if (norm(block, minIndent(block).length).join("\n") === wantN.join("\n"))
      out.push({ start: lines[i].start, end: lines[i + want.length - 1].end, reindent: true, lineBased: true })
  }
  return out
}

const bigrams = (s) => {
  const t = s.replace(/\s+/g, " ").trim()
  const m = new Map()
  for (let i = 0; i < t.length - 1; i++) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) || 0) + 1)
  return { m, n: Math.max(0, t.length - 1), t }
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (A.t === B.t) return 1
  if (!A.n || !B.n) return 0
  let hit = 0
  for (const [k, v] of A.m) hit += Math.min(v, B.m.get(k) || 0)
  return (2 * hit) / (A.n + B.n)
}

/** first + last line identical, middle lines roughly similar (>= 3 lines, unique candidate) */
function blockAnchorMatcher(src, oldS) {
  const want = wantedLines(oldS)
  if (want.length < 3) return []
  const first = want[0].trim(), last = want[want.length - 1].trim()
  if (!first || !last) return []
  const lines = indexLines(src)
  const cands = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].text.trim() !== first) continue
    const j = i + want.length - 1
    if (j >= lines.length) continue
    // allow the block to be +-1 line longer/shorter than the model remembered
    for (const end of [j, j - 1, j + 1]) {
      if (end <= i + 1 || end >= lines.length || lines[end].text.trim() !== last) continue
      const mid = lines.slice(i + 1, end).map((x) => x.text)
      const wmid = want.slice(1, -1)
      let sum = 0
      const n = Math.max(mid.length, wmid.length)
      for (let k = 0; k < n; k++) sum += dice(mid[k] || "", wmid[k] || "")
      const score = n ? sum / n : 1
      if (score >= 0.7) { cands.push({ start: lines[i].start, end: lines[end].end, score, reindent: true, lineBased: true }); break }
    }
  }
  if (cands.length > 1) {
    cands.sort((a, b) => b.score - a.score)
    if (cands[0].score - cands[1].score < 0.15) return cands // ambiguous: caller reports it
    return [cands[0]]
  }
  return cands
}

const MATCHERS = [
  ["exact", exactMatcher],
  ["typography-normalized", typographyMatcher],
  ["line-trimmed", lineTrimmedMatcher],
  ["whitespace-normalized", whitespaceMatcher],
  ["indentation-flexible", indentFlexMatcher],
  ["block-anchor", blockAnchorMatcher],
]

/** Re-indent newS so it lines up with the block that was actually found in the file. */
function reindent(newS, oldS, foundText) {
  const oldL = wantedLines(oldS)
  const foundL = trimEndLines(foundText)
  const oi = minIndent(oldL)
  const fi = minIndent(foundL)
  if (oi === fi && oldL.length === foundL.length && oldL.every((l, i) => /^[ \t]*/.exec(l)[0] === /^[ \t]*/.exec(foundL[i])[0])) return newS
  // when the line counts agree, learn "model indent -> real indent" per level
  const map = new Map()
  if (oldL.length === foundL.length)
    oldL.forEach((l, i) => { if (l.trim()) map.set(/^[ \t]*/.exec(l)[0], /^[ \t]*/.exec(foundL[i])[0]) })
  return trimEndLines(newS)
    .map((l) => {
      if (!l.trim()) return l
      const ind = /^[ \t]*/.exec(l)[0]
      if (map.has(ind)) return map.get(ind) + l.slice(ind.length)
      const body = l.startsWith(oi) ? l.slice(oi.length) : l.slice(ind.length)
      return fi + body
    })
    .join("\n")
}

/**
 * Apply one replacement to `src`. Returns { out, count, strategy }.
 * Throws a model-friendly Error when nothing (or too many things) match.
 */
function applyEdit(src, oldString, newString, replaceAll = false) {
  if (oldString === newString) throw new Error("oldString and newString are identical")
  if (oldString === "") throw new Error("oldString is empty; use the write tool to create or replace a whole file")
  const crlf = src.includes("\r\n")
  const fixEol = (s) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"))

  let tried = ""
  for (const [name, fn] of MATCHERS) {
    const cands = fn(src, oldString)
    if (!cands.length) continue
    tried = name
    if (cands.length > 1 && !replaceAll) {
      const lineOf = (pos) => src.slice(0, pos).split("\n").length
      const where = cands.slice(0, 8).map((c) => lineOf(c.start)).join(", ")
      throw new Error(`oldString matches ${cands.length} places${name === "exact" ? "" : ` (after ${name} matching)`} (lines ${where}${cands.length > 8 ? ", …" : ""}); nothing was changed. Include one or two neighbouring lines so it matches only once, or set replaceAll: true to change all of them.`)
    }
    const picked = replaceAll ? cands : [cands[0]]
    let out = src
    for (const c of [...picked].sort((a, b) => b.start - a.start)) {
      const found = src.slice(c.start, c.end)
      let repl = c.reindent ? reindent(newString, oldString, found) : newString
      // line-based matches stop before the last line's newline; do not double it
      if (c.lineBased && /\r?\n$/.test(oldString) && /\r?\n$/.test(repl)) repl = repl.replace(/\r?\n$/, "")
      repl = fixEol(repl)
      out = out.slice(0, c.start) + repl + out.slice(c.end)
    }
    return { out, count: picked.length, strategy: tried }
  }
  // Models often paste read's "12<TAB>" line-number prefixes into oldString.
  const numbered = String(oldString).split(/\r?\n/)
  if (numbered.some((l) => l.trim()) && numbered.every((l) => /^\s*\d+\t/.test(l) || !l.trim())) {
    const unnumber = (s) => String(s).split(/\r?\n/).map((l) => l.replace(/^\s*\d+\t/, "")).join("\n")
    const r = applyEdit(src, unnumber(oldString), unnumber(newString), replaceAll)
    return { ...r, strategy: `${r.strategy}, line-number prefixes removed` }
  }
  throw new Error(notFoundMessage(src, oldString))
}

/** "Not found" plus the closest block of the file, numbered, so the model can copy it exactly. */
function notFoundMessage(src, oldString) {
  const base = "oldString was not found in the file; nothing was changed."
  try {
    const lines = src.split(/\r?\n/)
    if (lines.length > 20000) throw new Error("large")
    const want = String(oldString).replace(/\r\n/g, "\n").split("\n")
    while (want.length > 1 && !want[want.length - 1].trim()) want.pop()
    const n = Math.max(1, Math.min(want.length, 40))
    const firstWanted = (want.find((l) => l.trim()) || "").trim()
    let best = { score: 0, at: -1 }
    for (let i = 0; i < lines.length; i++) {
      if (firstWanted && dice(lines[i].trim(), firstWanted) < 0.35) continue // cheap pre-filter
      let sum = 0
      for (let k = 0; k < n; k++) sum += dice((lines[i + k] || "").trim(), (want[k] || "").trim())
      const score = sum / n
      if (score > best.score) best = { score, at: i }
    }
    if (best.at < 0 || best.score < 0.45) return `${base} Nothing similar exists in this file: check you have the right file, read it again and copy the text exactly.`
    const from = best.at + 1
    const to = Math.min(lines.length, best.at + n)
    const shown = lines.slice(best.at, best.at + n).map((l, k) => `${from + k}\t${l.length > 300 ? l.slice(0, 300) + "…" : l}`).join("\n")
    return `${base} Closest match (lines ${from}-${to}, ${Math.round(best.score * 100)}% similar):\n${shown}\nCopy those lines exactly as oldString (without the line-number prefix), or read offset=${Math.max(1, from - 5)} limit=${n + 10} first.`
  } catch {
    return `${base} Read the file again and copy the text exactly (small whitespace/indentation differences are tolerated).`
  }
}

// ---------------------------------------------------------------- read guard
// sessionId -> Map(absPath -> mtimeMs of the content the model last saw)
const seen = new Map()
const sid = (c) => (c && c.session && c.session.id) || null

const fileGuard = {
  noteRead(c, abs) {
    const id = sid(c)
    if (!id) return
    try {
      if (!seen.has(id)) seen.set(id, new Map())
      seen.get(id).set(abs, fs.statSync(abs).mtimeMs)
    } catch {}
  },
  /** Throws if the file exists and the model has not read its current content. */
  assertReadable(c, abs) {
    const id = sid(c)
    if (!id) return // direct/library use without a session: no guard
    let st
    try { st = fs.statSync(abs) } catch { return } // new file: nothing to protect
    if (!st.isFile()) return
    const at = seen.get(id)?.get(abs)
    if (at == null) throw new Error(`You must read ${abs} before modifying it. Call the read tool on it first.`)
    if (st.mtimeMs - at > 2) throw new Error(`${abs} changed on disk since you last read it. Read it again before modifying it.`)
  },
  /** Call before ANY modification: read guard + undo snapshot of the original. */
  beforeModify(c, abs) {
    this.assertReadable(c, abs)
    snapshots.capture(c, abs)
  },
  afterWrite(c, abs) { this.noteRead(c, abs) },
  forget(id) { seen.delete(id) },
}

module.exports = { applyEdit, fileGuard, MATCHERS }
