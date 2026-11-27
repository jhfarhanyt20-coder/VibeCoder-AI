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

const registriesFile = (home) => path.join(home || homeDir(), "registries.json")
const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return fb
  }
}

// Built-in skill texts and plugin sources live in ./builtin (BDCoder's own).
const builtinFile = (...p) => { try { return fs.readFileSync(path.join(__dirname, "builtin", ...p), "utf8") } catch { return "" } }
const skill = (id, title, description, tags) => ({ id, title, description, tags, content: builtinFile("skills", id + ".md") })
const plugin = (id, title, description, tags) => ({ id, name: id, title, description, tags, spec: id, content: builtinFile("plugins", id + ".js") })

/** The shipped catalog: well-known, no-key MCP servers + BDCoder skills and plugins. */
const BUILTIN = {
  mcp: [
    { name: "everything", title: "Everything (MCP test server)", description: "Reference MCP server exercising tools, resources and prompts. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], tags: ["demo", "official"] },
    { name: "memory", title: "Memory graph", description: "Persistent knowledge graph across sessions. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-memory"], tags: ["memory", "official"] },
    { name: "filesystem", title: "Filesystem", description: "Expose extra folders as sandboxed file tools. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], tags: ["files", "official"] },
    { id: "playwright", name: "playwright", title: "Playwright browser", description: "A real browser the agent can drive: open pages, click, type, take snapshots. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@playwright/mcp@latest", "--headless"], tags: ["browser", "testing"] },
    { name: "context7", title: "Context7 docs", description: "Up-to-date documentation and code examples for libraries and frameworks, so the agent does not rely on old knowledge. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@upstash/context7-mcp"], tags: ["docs"] },
    { name: "sequential-thinking", title: "Sequential thinking", description: "Step-by-step thinking tool for long, tricky problems: plan, revise and branch. Needs Node.js (npx).", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"], tags: ["reasoning", "official"] },
  ],
  plugins: [
    plugin("project-overview", "Project overview", "Tool project_overview: languages, folders, config files and the run / test / build commands of the open project.", ["project"]),
    plugin("todo-finder", "TODO finder", "Tool find_todos: every TODO, FIXME, HACK and BUG note in the code with file and line.", ["code"]),
    plugin("env-check", "Env check", "Tool env_check: settings missing or empty in .env compared with .env.example (names only, never values).", ["config"]),
    plugin("media-tools", "Media tools", "Tools media_check (FFmpeg, Node, installed voices) and voice_over: free offline voice-over WAV files from the voices in Windows.", ["video", "voice"]),
    plugin("port-check", "Port check", "Tool ports_in_use: which local dev-server ports (3000, 5173, 8080...) are answering right now.", ["dev server"]),
  ],
  skills: [
    { id: "commit-helper", title: "Commit helper", description: "Write conventional commits from the working diff.", tags: ["git"], content: "# Commit helper\n\n1. Run `git diff --staged` (fall back to `git status -s` + `git diff`).\n2. Write ONE conventional commit message: `type(scope): summary` (<=72 chars), imperative mood.\n3. Show the message and the exact `git commit -m` command; only run it when the user said to commit.\n" },
    { id: "code-reviewer", title: "Code reviewer", description: "Structured review: bugs, security, style, tests.", tags: ["review"], content: "# Code reviewer\n\nReview the diff/changed files and report ONLY concrete findings, each as: file:line - severity (bug|security|perf|style) - what - suggested fix. No praise, no summary fluff. If nothing is wrong say so.\n" },
    { id: "test-writer", title: "Test writer", description: "Add focused unit tests for changed code.", tags: ["testing"], content: "# Test writer\n\n1. Find the changed functions (git diff).\n2. Add tests to the project's existing test layout and framework (do not invent a new one).\n3. Cover the happy path + one failure path per function. Run the suite and fix until green.\n" },
    skill("bug-fixer", "Bug fixer", "Reproduce, find the root cause, fix it with a test, and prove it.", ["debugging"]),
    skill("app-tester", "App tester", "Run the app and test it like a real user, then report what breaks.", ["testing"]),
    skill("project-explainer", "Project explainer", "Explain an unfamiliar project: parts, flows and how to run it.", ["onboarding"]),
    skill("safe-refactor", "Safe refactor", "Clean up code in small, tested steps without changing behaviour.", ["refactor"]),
    skill("security-check", "Security check", "Find secrets, injection risks and unsafe defaults before publishing.", ["security"]),
    skill("video-maker", "Video maker", "Animated video with a voice-over (Remotion), checked frame by frame, and posted to a Facebook Page on request.", ["video"]),
    skill("docs-writer", "Docs writer", "Write or update the README from the real, verified commands.", ["docs"]),
  ],
}

function listRegistries(home) {
  const list = readJson(registriesFile(home), [])
  return Array.isArray(list) ? list.filter((r) => r && r.url) : []
}
function saveRegistries(list, home) {
  fs.mkdirSync(path.dirname(registriesFile(home)), { recursive: true })
  fs.writeFileSync(registriesFile(home), JSON.stringify(list, null, 2))
}
function addRegistry({ name, url, home }) {
  const u = String(url || "").trim()
  if (!/^https?:\/\//i.test(u)) throw new Error("Registry URL must be http(s)")
  const list = listRegistries(home)
  if (list.some((r) => r.url === u)) throw new Error("That registry is already added")
  const reg = { id: "reg_" + Buffer.from(u).toString("hex").slice(0, 16), name: String(name || "").trim() || new URL(u).hostname, url: u }
  list.push(reg)
  saveRegistries(list, home)
  return reg
}
function removeRegistry({ id, home }) {
  const list = listRegistries(home)
  const next = list.filter((r) => r.id !== id)
  if (next.length === list.length) throw new Error("Registry not found")
  saveRegistries(next, home)
  return { ok: true }
}

/** Fetch + cache one registry. Returns { doc, cached, error }. */
async function fetchRegistry(reg, { force = false, home } = {}) {
  const cacheFile = path.join(home || homeDir(), "registry-cache", reg.id + ".json")
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
