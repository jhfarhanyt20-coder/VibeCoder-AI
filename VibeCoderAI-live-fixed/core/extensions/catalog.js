"use strict"
/**
 * Marketplace data: a small BUILT-IN catalog shipped with the app + user-added
 * custom REGISTRIES (any HTTPS URL returning one JSON document). A registry:
 *   { "name": "...", "mcp": [{name,type,url|command,...}], "plugins": [{id,title,spec}], "skills": [{id,title,description,content}] }
 * Everything is plain JSON/markdown - a user can host their own on GitHub Gist.
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("../util")

const registriesFile = () => path.join(homeDir(), "registries.json")
const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return fb
  }
}

/** The shipped catalog: well-known, no-key MCP servers + example skills. */
const BUILTIN = {
  mcp: [
    { name: "everything", title: "Everything (MCP test server)", description: "Reference MCP server exercising tools, resources and prompts. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], tags: ["demo", "official"] },
    { name: "memory", title: "Memory graph", description: "Persistent knowledge graph across sessions. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"], tags: ["memory", "official"] },
    { name: "filesystem", title: "Filesystem", description: "Expose extra folders as sandboxed file tools. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], tags: ["files", "official"] },
  ],
  plugins: [],
  skills: [
    { id: "commit-helper", title: "Commit helper", description: "Write conventional commits from the working diff.", tags: ["git"], content: "# Commit helper\n\n1. Run `git diff --staged` (fall back to `git status -s` + `git diff`).\n2. Write ONE conventional commit message: `type(scope): summary` (<=72 chars), imperative mood.\n3. Show the message and the exact `git commit -m` command; only run it when the user said to commit.\n" },
    { id: "code-reviewer", title: "Code reviewer", description: "Structured review: bugs, security, style, tests.", tags: ["review"], content: "# Code reviewer\n\nReview the diff/changed files and report ONLY concrete findings, each as: file:line - severity (bug|security|perf|style) - what - suggested fix. No praise, no summary fluff. If nothing is wrong say so.\n" },
    { id: "test-writer", title: "Test writer", description: "Add focused unit tests for changed code.", tags: ["testing"], content: "# Test writer\n\n1. Find the changed functions (git diff).\n2. Add tests to the project's existing test layout and framework (do not invent a new one).\n3. Cover the happy path + one failure path per function. Run the suite and fix until green.\n" },
  ],
}

function listRegistries() {
  const list = readJson(registriesFile(), [])
  return Array.isArray(list) ? list.filter((r) => r && r.url) : []
}
function saveRegistries(list) {
  fs.mkdirSync(path.dirname(registriesFile()), { recursive: true })
  fs.writeFileSync(registriesFile(), JSON.stringify(list, null, 2))
}
function addRegistry({ name, url }) {
  const u = String(url || "").trim()
  if (!/^https?:\/\//i.test(u)) throw new Error("Registry URL must be http(s)")
  const list = listRegistries()
  if (list.some((r) => r.url === u)) throw new Error("That registry is already added")
  const reg = { id: "reg_" + Buffer.from(u).toString("hex").slice(0, 16), name: String(name || "").trim() || new URL(u).hostname, url: u }
  list.push(reg)
  saveRegistries(list)
  return reg
}
function removeRegistry({ id }) {
  const list = listRegistries()
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) throw new Error("Registry not found")
  saveRegistries(next)
  return { ok: true }
}

/** Fetch + cache one registry. Returns { doc, cached, error }. */
async function fetchRegistry(reg, { force = false } = {}) {
  const cacheFile = path.join(homeDir(), "registry-cache", reg.id + ".json")
  if (!force) {
    try {
      if (Date.now() - fs.statSync(cacheFile).mtimeMs < 3600000) return { doc: readJson(cacheFile, null), cached: true }
    } catch {}
  }
  try {
    const res = await fetch(reg.url, { signal: AbortSignal.timeout(15000), headers: { accept: "application/json" } })
    if (!res.ok) throw new Error("HTTP " + res.status)
    const doc = await res.json()
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(doc))
    return { doc, cached: false }
  } catch (e) {
    const stale = readJson(cacheFile, null)
    if (stale) return { doc: stale, cached: true, error: (e && e.message) || String(e) }
    return { doc: null, cached: false, error: (e && e.message) || String(e) }
  }
}

module.exports = { BUILTIN, listRegistries, addRegistry, removeRegistry, fetchRegistry, registriesFile }
