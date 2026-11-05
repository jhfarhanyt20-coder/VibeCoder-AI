"use strict"
/**
 * File snapshots for undo.
 *
 * Before the agent changes a file (write / edit / multiedit / apply_patch) the
 * ORIGINAL content is captured once per turn (a turn = one user prompt).
 * Undoing turn T restores every file touched in turns >= T to its earliest
 * captured state (or deletes files the agent created).
 *
 * Stored in <VIBE_HOME>/snapshots/<rootSessionId>.json. Subagent edits are
 * attributed to the ROOT session's current turn, so one undo covers them too.
 * Changes made through the shell (sed -i, formatters, git...) are NOT captured.
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("../util")
const { redactFileBody } = require("../harness/guard")

const MAX_FILE_BYTES = 2 * 1024 * 1024 // bigger files are recorded as "skipped"
const MAX_TURNS = 50 // oldest snapshot turns are dropped beyond this
const MAX_REDOS = 20
const MAX_DIFF_CHARS = 12000

const dirOf = (home) => path.join(home || homeDir(), "snapshots")
const fileOf = (home, id) => {
  if (!/^ses_[0-9a-f]+$/.test(String(id))) throw new Error("Invalid session id")
  return path.join(dirOf(home), id + ".json")
}

function load(home, id) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(home, id), "utf8"))
    if (!j || typeof j.turns !== "object" || !j.turns) return { turns: {}, redos: [] }
    if (!Array.isArray(j.redos)) j.redos = []
    return j
  } catch {
    return { turns: {}, redos: [] }
  }
}

function save(home, id, data) {
  fs.mkdirSync(dirOf(home), { recursive: true })
  const f = fileOf(home, id)
  const tmp = f + "." + process.pid + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8")
  fs.renameSync(tmp, f)
}

/** Follow parentId links (subagent -> parent -> ...) to the root session. */
function rootOf(session, engine) {
  let s = session
  for (let i = 0; i < 6 && s && s.parentId && engine && engine.store; i++) {
    try { s = engine.store.get(s.parentId) } catch { break }
  }
  return s
}

/**
 * Capture `abs` before it is modified. No-op without a session (library use),
 * and only the first capture of a file within a turn is kept.
 */
function capture(c, abs) {
  try {
    if (!c || !c.session || !c.session.id) return
    const engine = c.engine
    const root = rootOf(c.session, engine)
    if (!root || !root.id) return
    const home = (engine && engine.home) || undefined
    const turn = String(root.turnSeq || 0)
    const stepKey = c.step == null || c.step === "" ? "" : String(c.step)
    const data = load(home, root.id)
    const t = (data.turns[turn] = data.turns[turn] || { time: Date.now(), files: {} })
    let steps = null
    if (stepKey) {
      t.steps = t.steps || {}
      steps = t.steps[stepKey] = t.steps[stepKey] || { time: Date.now(), files: {} }
    }
    const needTurn = !Object.prototype.hasOwnProperty.call(t.files, abs)
    const needStep = !!steps && !Object.prototype.hasOwnProperty.call(steps.files, abs)
    if (!needTurn && !needStep) return
    let entry
    try {
      const st = fs.statSync(abs)
      if (!st.isFile()) return
      entry = st.size > MAX_FILE_BYTES ? { existed: true, skipped: true } : { existed: true, b64: fs.readFileSync(abs).toString("base64") }
    } catch {
      entry = { existed: false } // the agent is creating this file
    }
    if (needTurn) t.files[abs] = entry
    if (needStep) steps.files[abs] = entry
    // A new edit creates a new branch; stale redo states must never overwrite it.
    data.redos = []
    const keys = Object.keys(data.turns).map(Number).sort((a, b) => a - b)
    while (keys.length > MAX_TURNS) delete data.turns[String(keys.shift())]
    save(home, root.id, data)
  } catch {
    // snapshots are best effort: never block an edit because of them
  }
}

/** [{ turn, time, files: [path...] }] newest first. */
function list(home, sessionId) {
  const data = load(home, sessionId)
  return Object.keys(data.turns)
    .map(Number)
    .sort((a, b) => b - a)
    .map((n) => ({ turn: n, time: data.turns[String(n)].time, files: Object.keys(data.turns[String(n)].files) }))
}

/** [{ turn, step, time, files: [path...] }] newest first. */
function listSteps(home, sessionId) {
  const data = load(home, sessionId)
  const out = []
  for (const turn of Object.keys(data.turns).map(Number).sort((a, b) => b - a)) {
    const steps = data.turns[String(turn)].steps || {}
    for (const step of Object.keys(steps).map(Number).sort((a, b) => b - a)) {
      out.push({ turn, step, time: steps[String(step)].time, files: Object.keys(steps[String(step)].files) })
    }
  }
  return out
}

/**
 * Restore files to their state before `fromStep` within one turn. Steps from
 * `fromStep` upward are removed; earlier steps and other turns are untouched.
 */
function undoStep(home, sessionId, turn, fromStep) {
  const data = load(home, sessionId)
  const t = data.turns[String(turn)]
  if (!t || !t.steps) return { restored: [], deleted: [], skipped: [], turn, steps: [] }
  const steps = Object.keys(t.steps).map(Number).filter((n) => n >= fromStep).sort((a, b) => a - b)
  if (!steps.length) return { restored: [], deleted: [], skipped: [], turn, steps: [] }
  const earliest = new Map()
  for (const n of steps) for (const [abs, e] of Object.entries(t.steps[String(n)].files)) if (!earliest.has(abs)) earliest.set(abs, e)
  const selected = {}
  for (const n of steps) selected[String(n)] = t.steps[String(n)]
  const redoId = pushRedo(data, { kind: "step", turn, steps: selected, after: captureEntries(earliest.keys()) })
  const out = restoreEntries(earliest)
  for (const n of steps) delete t.steps[String(n)]
  save(home, sessionId, data)
  return { ...out, turn, steps, redoId }
}

function stateOf(abs) {
  try {
    const st = fs.statSync(abs)
    if (!st.isFile()) return { existed: false }
    return st.size > MAX_FILE_BYTES ? { existed: true, skipped: true } : { existed: true, b64: fs.readFileSync(abs).toString("base64") }
  } catch {
    return { existed: false }
  }
}

function captureEntries(paths) {
  const out = {}
  for (const abs of paths) out[abs] = stateOf(abs)
  return out
}

function pushRedo(data, entry) {
  data.redos = Array.isArray(data.redos) ? data.redos : []
  const id = `redo_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  data.redos.push({ id, time: Date.now(), meta: {}, ...entry })
  if (data.redos.length > MAX_REDOS) data.redos.splice(0, data.redos.length - MAX_REDOS)
  return id
}

function restoreEntries(entries) {
  const out = { restored: [], deleted: [], skipped: [] }
  for (const [abs, e] of entries) {
    try {
      if (e.skipped) { out.skipped.push(abs); continue }
      if (e.existed) {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, Buffer.from(e.b64 || "", "base64"))
        out.restored.push(abs)
      } else if (fs.existsSync(abs)) {
        fs.rmSync(abs, { force: true })
        out.deleted.push(abs)
      }
    } catch {
      out.skipped.push(abs)
    }
  }
  return out
}

/**
 * Restore files to their state before turn `fromTurn` (and every later turn).
 * Returns { restored, deleted, skipped, turns }.
 */
function undo(home, sessionId, fromTurn) {
  const data = load(home, sessionId)
  const turns = Object.keys(data.turns).map(Number).filter((n) => n >= fromTurn).sort((a, b) => a - b)
  if (!turns.length) return { restored: [], deleted: [], skipped: [], turns: [] }
  const earliest = new Map() // first (oldest) capture of each file wins
  for (const n of turns) for (const [abs, e] of Object.entries(data.turns[String(n)].files)) if (!earliest.has(abs)) earliest.set(abs, e)
  const selected = {}
  for (const n of turns) selected[String(n)] = data.turns[String(n)]
  const redoId = pushRedo(data, { kind: "turn", turns: selected, after: captureEntries(earliest.keys()) })
  const out = restoreEntries(earliest)
  for (const n of turns) delete data.turns[String(n)]
  save(home, sessionId, data)
  return { ...out, turns, redoId }
}

function attachRedo(home, sessionId, redoId, meta = {}) {
  if (!redoId) return false
  const data = load(home, sessionId)
  const entry = data.redos.find((item) => item.id === redoId)
  if (!entry) return false
  entry.meta = meta && typeof meta === "object" ? meta : {}
  save(home, sessionId, data)
  return true
}

function clearRedo(home, sessionId) {
  const data = load(home, sessionId)
  if (!data.redos.length) return false
  data.redos = []
  save(home, sessionId, data)
  return true
}

function listRedo(home, sessionId) {
  return load(home, sessionId).redos.map((item) => ({ id: item.id, kind: item.kind, time: item.time, turn: item.turn, turns: item.turns ? Object.keys(item.turns).map(Number) : [], steps: item.steps ? Object.keys(item.steps).map(Number) : [] })).reverse()
}

function peekRedo(home, sessionId) {
  const rows = load(home, sessionId).redos
  const item = rows[rows.length - 1]
  return item ? { id: item.id, kind: item.kind, meta: item.meta || {} } : null
}

/** Restore the newest state removed by undo/undoStep. */
function redo(home, sessionId) {
  const data = load(home, sessionId)
  const entry = data.redos.pop()
  if (!entry) throw new Error("Nothing to redo.")
  const out = restoreEntries(new Map(Object.entries(entry.after || {})))
  if (entry.kind === "step") {
    const t = data.turns[String(entry.turn)]
    if (t) {
      t.steps = t.steps || {}
      for (const [step, value] of Object.entries(entry.steps || {})) t.steps[step] = value
    }
  } else {
    for (const [turn, value] of Object.entries(entry.turns || {})) data.turns[turn] = value
  }
  save(home, sessionId, data)
  return {
    ...out,
    redoId: entry.id,
    kind: entry.kind,
    turn: entry.turn,
    turns: entry.turns ? Object.keys(entry.turns).map(Number) : [],
    steps: entry.steps ? Object.keys(entry.steps).map(Number) : [],
    meta: entry.meta || {},
  }
}

const lines = (text) => text ? String(text).replace(/\r\n/g, "\n").split("\n") : []

function diffEntry(abs, beforeEntry) {
  if (beforeEntry?.skipped) return { path: abs, skipped: true, reason: "Snapshot exceeds size limit." }
  const afterEntry = stateOf(abs)
  if (afterEntry.skipped) return { path: abs, skipped: true, reason: "Current file exceeds size limit." }
  const beforeRaw = beforeEntry?.existed ? Buffer.from(beforeEntry.b64 || "", "base64").toString("utf8") : ""
  const afterRaw = afterEntry.existed ? Buffer.from(afterEntry.b64 || "", "base64").toString("utf8") : ""
  if (/\0/.test(beforeRaw) || /\0/.test(afterRaw)) return { path: abs, binary: true, existedBefore: !!beforeEntry?.existed, existsNow: !!afterEntry.existed }
  const before = lines(redactFileBody(abs, beforeRaw))
  const after = lines(redactFileBody(abs, afterRaw))
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const removed = before.slice(prefix, before.length - suffix)
  const added = after.slice(prefix, after.length - suffix)
  const contextBefore = before.slice(Math.max(0, prefix - 2), prefix)
  const contextAfter = before.slice(before.length - suffix, Math.min(before.length - suffix + 2, before.length))
  const body = [
    `--- ${abs} (before)`,
    `+++ ${abs} (current)`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ].join("\n")
  return {
    path: abs,
    existedBefore: !!beforeEntry?.existed,
    existsNow: !!afterEntry.existed,
    added: added.length,
    removed: removed.length,
    changed: added.length > 0 || removed.length > 0 || !!beforeEntry?.existed !== !!afterEntry.existed,
    diff: body.length > MAX_DIFF_CHARS ? body.slice(0, MAX_DIFF_CHARS) + "\n...[diff clipped]" : body,
  }
}

/** Read-only diff between a turn/step snapshot and the current filesystem. */
function preview(home, sessionId, { turn, step } = {}) {
  const data = load(home, sessionId)
  const selectedTurn = Number.isInteger(Number(turn)) ? Number(turn) : Object.keys(data.turns).map(Number).sort((a, b) => b - a)[0]
  const t = data.turns[String(selectedTurn)]
  if (!t) return { turn: selectedTurn, step: step == null ? null : Number(step), files: [] }
  const selectedStep = step == null ? null : Number(step)
  const entries = selectedStep == null ? t.files : (t.steps?.[String(selectedStep)]?.files || {})
  return { turn: selectedTurn, step: selectedStep, files: Object.entries(entries).map(([abs, entry]) => diffEntry(abs, entry)) }
}

function remove(home, sessionId) {
  try { fs.rmSync(fileOf(home, sessionId), { force: true }) } catch {}
}

module.exports = { capture, list, listSteps, preview, undo, undoStep, redo, listRedo, peekRedo, attachRedo, clearRedo, remove, load }
