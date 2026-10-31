"use strict"
/**
 * User config: <VIBE_HOME>/config.json (optional; every key has a safe default).
 *
 * {
 *   "compaction": {
 *     "auto": true,             // false = no automatic compaction; /compact and overflow recovery still work
 *     "keep": { "tokens": 0 },  // recent history to keep after a checkpoint; 0 = automatic (today's min(20000, 20%))
 *     "buffer": 0,              // tokens reserved for the reply; 0 = today's maxOutput reserve
 *     "maxRuns": 0,             // automatic compactions allowed per session; 0 = unlimited
 *     "model": null,            // profile id that writes the checkpoint summary; null = the session's own model
 *     "background": false       // prepare the next checkpoint before the threshold is crossed
 *   }
 * }
 *
 * The file is read on demand (a few hundred bytes) so an edit takes effect on the
 * next prompt without restarting the app.
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("./util")

const DEFAULTS = {
  compaction: {
    auto: true,
    keep: { tokens: 0 },
    buffer: 0,
    maxRuns: 0,
    model: null,
    background: false,
  },
}

const bool = (value, fallback) => (typeof value === "boolean" ? value : fallback)
const count = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function normalizeCompaction(raw) {
  const value = raw && typeof raw === "object" ? raw : {}
  const keep = value.keep && typeof value.keep === "object" ? value.keep : {}
  return {
    auto: bool(value.auto, DEFAULTS.compaction.auto),
    keep: { tokens: count(keep.tokens) },
    buffer: count(value.buffer),
    maxRuns: count(value.maxRuns),
    model: value.model ? String(value.model).trim() || null : null,
    background: bool(value.background, DEFAULTS.compaction.background),
  }
}

function configFile(home) {
  return path.join(home || homeDir(), "config.json")
}

function readConfig(home) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(configFile(home), "utf8"))
  } catch {}
  return { compaction: normalizeCompaction(raw && raw.compaction) }
}

const compactionConfig = (home) => readConfig(home).compaction

/**
 * Persist a partial compaction update without discarding unrelated config keys.
 * The desktop UI uses this so non-technical users never need to edit JSON by
 * hand. The write is atomic: readers see either the old or the complete new
 * file, never a half-written settings document.
 */
function updateCompaction(home, patch) {
  const file = configFile(home)
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {}
  const previous = raw.compaction && typeof raw.compaction === "object" && !Array.isArray(raw.compaction)
    ? raw.compaction
    : {}
  const change = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}
  const merged = {
    ...previous,
    ...change,
    keep: {
      ...(previous.keep && typeof previous.keep === "object" ? previous.keep : {}),
      ...(change.keep && typeof change.keep === "object" ? change.keep : {}),
    },
  }
  const normalized = normalizeCompaction(merged)
  const next = {
    ...raw,
    compaction: {
      ...previous,
      ...normalized,
      keep: {
        ...(previous.keep && typeof previous.keep === "object" ? previous.keep : {}),
        ...normalized.keep,
      },
    },
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
  return normalized
}

module.exports = { DEFAULTS, configFile, readConfig, compactionConfig, updateCompaction, normalizeCompaction }
