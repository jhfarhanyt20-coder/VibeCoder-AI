"use strict"
/**
 * Plugins = plain CommonJS files the engine loads at startup. A plugin exports
 * either a tool object ({name, description, parameters, run, perm?, paths?}) or
 * an array of them, optionally wrapped: module.exports = { tools: [...] }.
 * Discovered from:
 *   global : ~/.vibe/plugins/*.js
 *   project: <workspace>/.vibe/plugins/*.js
 * "Install" for a registry entry copies its JS into one of those folders
 * (npm/git specs are fetched with the npm CLI that is already installed).
 */
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")
const { homeDir } = require("../util")
const trust = require("../harness/trust")

const globalDir = (home) => path.join(home || homeDir(), "plugins")
const projectDir = (dir) => path.join(dir || "", ".vibe", "plugins")

const slug = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "plugin"

/** [{file,name,scope,ok,error}] */
function listPlugins(directory, home) {
  const out = []
  const projectTrusted = !directory || trust.isProjectTrusted(directory, home || homeDir())
  const scan = (dir, scope) => {
    let files = []
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"))
    } catch {
      return
    }
    for (const f of files) {
      const file = path.join(dir, f)
      let ok = true
      let error = ""
      try {
        const m = require(file)
        if (!m || (!m.tools && !m.name && !Array.isArray(m))) {
          ok = false
          error = "exports neither a tool, an array, nor {tools}"
        }
      } catch (e) {
        ok = false
        error = (e && e.message) || String(e)
      }
      out.push({ file, name: f.replace(/\.js$/, ""), scope, ok, error })
    }
  }
  scan(globalDir(home), "global")
  if (directory && projectTrusted) scan(projectDir(directory), "project")
  return out
}

/** Load every plugin file into engine tool objects (bad files are skipped). */
function toolObjects(directory, ctx = {}) {
  const tools = require("../tools")
  const out = []
  for (const row of listPlugins(directory, ctx.home)) {
    if (!row.ok) continue
    let mod
    try {
      delete require.cache[require.resolve(row.file)]
      mod = require(row.file)
    } catch {
      continue
    }
    const raw = Array.isArray(mod) ? mod : Array.isArray(mod && mod.tools) ? mod.tools : mod && mod.name ? [mod] : []
    for (const t of raw) {
      if (!t || !t.name || typeof t.run !== "function") continue
      const declared = t.name.includes("__") ? t.name : `plugin__${row.name}__${t.name}`
      out.push({
        name: declared,
        description: String(t.description || "").slice(0, 1200) || `Plugin tool from ${row.name}`,
        parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
        perm: t.perm || ((a, c) => ({ tool: "plugin", subject: declared })),
        paths: t.paths || (() => []),
        run: async (a, c) => tools.clip(String(await t.run(a, { ...c, home: homeDir() }))),
      })
    }
  }
  void ctx
  return out
}

/** Install from a local file path, a raw JS string, or an npm/git spec. */
function installPlugin({ file, content, spec, global, directory, home }) {
  const dir = global || !directory ? globalDir(home) : projectDir(directory)
  fs.mkdirSync(dir, { recursive: true })
  let target
  if (file) {
    const src = String(file)
    if (!fs.existsSync(src)) throw new Error("File not found: " + src)
    target = path.join(dir, slug(path.basename(src)) + ".js")
    fs.copyFileSync(src, target)
  } else if (content) {
    const id = slug(spec || "plugin")
    target = path.join(dir, id + ".js")
    fs.writeFileSync(target, String(content), "utf8")
  } else if (spec) {
    const requested = String(spec).trim()
    // Accept a reviewed npm package/version or a public GitHub HTTPS repo.
    // Never let shell syntax reach the npm process.
    const npmSpec = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*~^+-]+)?$/i.test(requested)
    const gitSpec = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/i.test(requested)
    if (!npmSpec && !gitSpec) throw new Error("Use a reviewed npm package/version or a public GitHub HTTPS repository; shell flags and shell syntax are not accepted.")
    // fetch the npm package into a temp folder with the user's own npm, copy its main js
    const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "vibe-plugin-"))
    try {
      const isWin = process.platform === "win32"
      const npm = isWin ? (process.env.ComSpec || "cmd.exe") : "npm"
      const npmArgs = ["install", "--prefix", tmp, "--no-audit", "--no-fund", "--ignore-scripts", requested]
      const r = spawnSync(npm, isWin ? ["/d", "/s", "/c", "npm", ...npmArgs] : npmArgs, {
        windowsHide: true,
        timeout: 120000,
        stdio: "ignore",
        shell: false,
      })
      if (r.status !== 0) throw new Error("npm could not fetch: " + requested)
      const nm = path.join(tmp, "node_modules")
      const pkg = fs.readdirSync(nm).flatMap((p) => (p.startsWith("@") ? fs.readdirSync(path.join(nm, p)).map((q) => p + "/" + q) : [p]))[0]
      if (!pkg) throw new Error("package installed but empty")
      const pkgDir = path.join(nm, pkg)
      const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
      const main = path.join(pkgDir, pj.main || "index.js")
      if (!fs.existsSync(main)) throw new Error("no main entry in " + spec)
      target = path.join(dir, slug(pj.name || spec) + ".js")
      fs.copyFileSync(main, target)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  } else {
    throw new Error("Plugin install needs a file, content or npm spec")
  }
  // fail fast: a plugin that cannot load should not be "installed"
  let error = ""
  try {
    const m = require(target)
    if (!m || (!m.tools && !m.name && !Array.isArray(m))) error = "does not export a tool"
  } catch (e) {
    error = (e && e.message) || String(e)
  }
  if (error) {
    try {
      fs.unlinkSync(target)
    } catch {}
    throw new Error("Plugin rejected: " + error)
  }
  return { name: path.basename(target, ".js"), file: target, scope: target.startsWith(globalDir(home)) ? "global" : "project" }
}

function removePlugin({ name, global, directory }) {
  const dir = global || !directory ? globalDir() : projectDir(directory)
  const file = path.join(dir, slug(name) + ".js")
  try {
    delete require.cache[require.resolve(file)]
  } catch {}
  try {
    fs.unlinkSync(file)
    return { removed: true, file }
  } catch {
    return { removed: false }
  }
}

module.exports = { globalDir, projectDir, listPlugins, toolObjects, installPlugin, removePlugin }
