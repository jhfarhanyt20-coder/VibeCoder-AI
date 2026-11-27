"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../core/util")
const { readJson, writeJson } = require("../core/control")
const { redactText } = require("../core/harness/guard")
const { THEMES, safeText } = require("./theme")

const DEFAULTS = { theme: "obsidian", reasoning: false, verbose: false, history: true, model: null, agent: "build", thinking: null, access: "ask", computerUse: true }
const settingsFile = (home = homeDir()) => path.join(home, "cli.json")
const historyFile = (home = homeDir()) => path.join(home, "cli_history")

function loadSettings(home) {
  let raw
  try { raw = readJson(settingsFile(home), {}) } catch { raw = {} }
  if (!raw || Array.isArray(raw) || typeof raw !== "object") raw = {}
  return {
    ...DEFAULTS,
    theme: Object.prototype.hasOwnProperty.call(THEMES, raw.theme) ? raw.theme : DEFAULTS.theme,
    ...Object.fromEntries(["reasoning", "verbose", "history", "computerUse"].filter((key) => typeof raw[key] === "boolean").map((key) => [key, raw[key]])),
    model: typeof raw.model === "string" ? raw.model : null,
    agent: typeof raw.agent === "string" ? raw.agent : DEFAULTS.agent,
    thinking: ["none", "low", "medium", "high"].includes(raw.thinking) ? raw.thinking : null,
    access: raw.access === "full" ? "full" : "ask",
  }
}
function saveSettings(patch, home) {
  const file = settingsFile(home)
  const raw = readJson(file, {})
  if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error(`${file} must contain an object.`)
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown CLI setting "${key}".`)
    if (key === "theme" && !Object.prototype.hasOwnProperty.call(THEMES, value)) throw new Error("Unknown terminal theme.")
    if (["reasoning", "verbose", "history", "computerUse"].includes(key) && typeof value !== "boolean") throw new Error(`${key} needs true or false.`)
    if (["model", "agent"].includes(key) && value !== null && typeof value !== "string") throw new Error(`${key} needs a string or null.`)
    if (key === "thinking" && value !== null && !["none", "low", "medium", "high"].includes(value)) throw new Error("Thinking must be none, low, medium, high or null.")
    if (key === "access" && !["ask", "full"].includes(value)) throw new Error("Access must be ask or full.")
  }
  writeJson(file, { ...raw, ...patch }, { private: true })
  return loadSettings(home)
}
function loadHistory(home) {
  try {
    const stat = fs.statSync(historyFile(home))
    if (stat.size > 1024 * 1024) return []
    const rows = JSON.parse(fs.readFileSync(historyFile(home), "utf8"))
    return Array.isArray(rows) ? rows.filter((s) => typeof s === "string").slice(-200) : []
  } catch { return [] }
}
function rememberPrompt(text, home) {
  const raw = String(text || "").trim()
  if (!raw || /^\/(?:auth|shell\s+input|token|password)\b/i.test(raw)) return
  const clean = redactText(safeText(raw)).slice(0, 12000)
  const file = historyFile(home)
  let rows = readJson(file, [])
  if (!Array.isArray(rows) || rows.some((s) => typeof s !== "string")) throw new Error("History was left unchanged: it is not a BDCoder history array.")
  if (rows[rows.length - 1] === clean) return
  rows.push(clean)
  rows = rows.slice(-200)
  while (rows.length > 1 && Buffer.byteLength(JSON.stringify(rows), "utf8") > 900 * 1024) rows.shift()
  writeJson(file, rows, { private: true })
}

module.exports = { DEFAULTS, settingsFile, historyFile, loadSettings, saveSettings, loadHistory, rememberPrompt }
