"use strict"
/**
 * Fallback model groups: an ordered list of provider/model keys plus a sticky
 * cursor. The cursor is the index of the model that answered last; it only
 * moves forward (wrapping around the end) when the current model is rate
 * limited, a server error occurs or the request times out.
 *
 * Stored in <VIBE_HOME>/groups.json, no credentials. Always contains the
 * single "fallback" group so a fresh install has a stable identity to select.
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("../util")

const DEFAULT_GROUP = { id: "fallback", name: "Fallback model", models: [], cursor: 0 }

const groupsFile = (home) => path.join(home || homeDir(), "groups.json")

function readAll(home) {
  try {
    const raw = JSON.parse(fs.readFileSync(groupsFile(home), "utf8"))
    return Array.isArray(raw) ? raw.filter((g) => g && typeof g.id === "string" && g.id) : []
  } catch {
    return []
  }
}

function normalize(group) {
  const seen = new Set()
  const models = []
  for (const key of Array.isArray(group.models) ? group.models : []) {
    const value = String(key == null ? "" : key).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    models.push(value)
  }
  let cursor = Number(group.cursor)
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= models.length) cursor = 0
  return {
    id: String(group.id || DEFAULT_GROUP.id),
    name: String(group.name || DEFAULT_GROUP.name),
    models,
    cursor,
  }
}

function listGroups(home) {
  const saved = readAll(home).map(normalize)
  if (!saved.some((g) => g.id === DEFAULT_GROUP.id)) saved.unshift({ ...DEFAULT_GROUP, models: [], cursor: 0 })
  return saved
}

function getGroup(id, home) {
  const wanted = String(id || "").trim() || DEFAULT_GROUP.id
  const found = listGroups(home).find((g) => g.id === wanted)
  if (!found) throw new Error(`Unknown fallback group "${wanted}".`)
  return found
}

function writeAll(list, home) {
  const f = groupsFile(home)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(list, null, 2))
}

function saveGroup(group, home) {
  const next = normalize({ ...DEFAULT_GROUP, ...group, id: group.id || DEFAULT_GROUP.id, name: group.name || DEFAULT_GROUP.name })
  const all = readAll(home)
  const index = all.findIndex((g) => g.id === next.id)
  if (index >= 0) all[index] = next
  else all.push(next)
  writeAll(all, home)
  return next
}

/** Persist the sticky cursor only. Missing file/group is created on demand. */
function setCursor(id, cursor, home) {
  const wanted = String(id || "").trim() || DEFAULT_GROUP.id
  const all = readAll(home)
  const index = all.findIndex((g) => g.id === wanted)
  const current = index >= 0 ? all[index] : { ...DEFAULT_GROUP, id: wanted, models: [] }
  const next = normalize({ ...current, cursor })
  if (index >= 0 && normalize(current).cursor === next.cursor) return next
  if (index >= 0) all[index] = next
  else all.push(next)
  writeAll(all, home)
  return next
}

module.exports = { DEFAULT_GROUP, groupsFile, listGroups, getGroup, saveGroup, setCursor }
