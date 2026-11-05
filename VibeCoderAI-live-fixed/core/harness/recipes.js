"use strict"
/**
 * Recipes — small slash-command prompt templates.
 *
 * Files are data, never executable configuration. Fenced shell snippets are
 * passed to the model as examples and retain the normal bash Guardrails; this
 * module does not spawn a process or call a tool.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")
const { findRoot, rootToCwd } = require("./loom")

const MAX_RECIPES = 100
const MAX_BODY_CHARS = 30000

function parseFrontmatter(text) {
  const source = String(text || "").replace(/^\uFEFF/, "")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!match) return { fields: {}, body: source }
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let value = kv[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    fields[kv[1].toLowerCase()] = value
  }
  return { fields, body: source.slice(match[0].length) }
}

function idOf(file) {
  return path.basename(file, path.extname(file)).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function readRecipe(file, scope) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_BODY_CHARS * 4) return null
    const parsed = parseFrontmatter(fs.readFileSync(file, "utf8"))
    const id = idOf(file)
    if (!id) return null
    const body = parsed.body.trim().slice(0, MAX_BODY_CHARS)
    return {
      id,
      name: String(parsed.fields.name || id).trim(),
      description: String(parsed.fields.description || body.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#")) || `Run /${id}`).trim().slice(0, 500),
      agent: String(parsed.fields.persona || parsed.fields.agent || "").trim(),
      model: String(parsed.fields.model || "").trim(),
      file,
      scope,
      body,
      hasShellBlocks: /```\s*(?:ba?sh|shell|zsh|fish|powershell|pwsh|cmd|bat)\b/i.test(body),
    }
  } catch {
    return null
  }
}

function scan(dir, scope, out) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.size >= MAX_RECIPES) return
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name.startsWith(".") || !/\.md$/i.test(entry.name)) continue
    const recipe = readRecipe(path.join(dir, entry.name), scope)
    if (recipe) out.set(recipe.id, recipe)
  }
}

/** Global first, then project root toward cwd; the closest recipe wins. */
function listRecipes({ directory, home } = {}) {
  const cwd = path.resolve(directory || process.cwd())
  const root = findRoot(cwd)
  const out = new Map()
  scan(path.join(home || homeDir(), "recipes"), "global", out)
  for (const dir of rootToCwd(root, cwd)) scan(path.join(dir, ".vibe", "recipes"), "project", out)
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function getRecipe(id, options = {}) {
  const wanted = String(id || "").trim().toLowerCase()
  return listRecipes(options).find((item) => item.id === wanted) || null
}

function splitArguments(raw) {
  const text = String(raw || "")
  const out = []
  let current = ""
  let quote = ""
  let escaped = false
  for (const ch of text) {
    if (escaped) { current += ch; escaped = false; continue }
    if (ch === "\\" && quote !== "'") { escaped = true; continue }
    if (quote) {
      if (ch === quote) quote = ""
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (/\s/.test(ch)) {
      if (current) { out.push(current); current = "" }
      continue
    }
    current += ch
  }
  if (escaped) current += "\\"
  if (current) out.push(current)
  return out
}

function renderBody(recipe, rawArgs) {
  const raw = String(rawArgs || "").trim()
  const args = splitArguments(raw)
  return recipe.body
    .replace(/\$\{ARGUMENTS\}|\$ARGUMENTS\b/g, raw)
    .replace(/\$\{([1-9])\}|\$([1-9])\b/g, (_, a, b) => args[Number(a || b) - 1] || "")
}

/** Expand only known `/recipe` commands; unknown slash text remains normal chat. */
function expandRecipe(text, options = {}) {
  const source = String(text || "")
  const match = /^\/([a-z0-9][a-z0-9._-]*)(?:\s+([\s\S]*))?$/i.exec(source.trim())
  if (!match) return null
  const recipe = getRecipe(match[1], options)
  if (!recipe) return null
  const rawArgs = match[2] || ""
  const rendered = renderBody(recipe, rawArgs)
  const safety = recipe.hasShellBlocks
    ? "\n\nRecipe safety: fenced shell text is reference material, not approval. Use the bash action only when needed; every command still passes through Locks and Guardrails."
    : ""
  return {
    id: recipe.id,
    file: recipe.file,
    agent: recipe.agent,
    model: recipe.model,
    args: splitArguments(rawArgs),
    rawArgs,
    hasShellBlocks: recipe.hasShellBlocks,
    text: `[Recipe: /${recipe.id}]\n${rendered}${safety}`,
  }
}

function systemText(options = {}) {
  const list = listRecipes(options)
  if (!list.length) return ""
  return [
    "# Available recipes",
    "Users can invoke these prompt templates with /name followed by arguments:",
    ...list.map((item) => `- /${item.id} — ${item.description}`),
  ].join("\n")
}

module.exports = { listRecipes, getRecipe, expandRecipe, systemText, splitArguments, renderBody, parseFrontmatter }
