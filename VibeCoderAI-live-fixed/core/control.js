"use strict"
/**
 * User-facing management of the existing VibeCore stores. This is not another
 * agent engine: the CLI and authenticated local SDK share these operations.
 * Configuration and installed Markdown are data; no recipe is executed here.
 */
const fs = require("node:fs")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawnSync } = require("node:child_process")
const profiles = require("./llm/profiles")
const skills = require("./skills")
const agents = require("./agents")
const recipes = require("./harness/recipes")
const catalog = require("./extensions/catalog")
const mcp = require("./mcp")
const plugins = require("./plugins")
const config = require("./config")
const { DEFAULT_RULES, normalizeRules } = require("./perm/rules")
const { loadLocks } = require("./harness/locks")
const { redactText } = require("./harness/guard")
const tools = require("./tools")

const SECRET_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization|cookie|headers|env)$/i
const RESERVED = new Set(["__proto__", "prototype", "constructor"])

function publicData(value) {
  if (typeof value === "string") return redactText(value).replace(/(--(?:api[-_]?key|token|secret|password))(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/gi, "$1 [redacted]")
  if (Array.isArray(value)) return value.map((item, index) => typeof value[index - 1] === "string" && /^--(?:api[-_]?key|token|secret|password)$/i.test(value[index - 1]) ? "[redacted]" : publicData(item))
  if (!value || typeof value !== "object") return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED.has(key)) continue
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : publicData(item)
  }
  return out
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch (error) {
    if (error.code === "ENOENT") return fallback
    throw new Error(`Cannot read ${file}: ${error.message}. The file was not overwritten.`)
  }
}

function privateFile(file) {
  try { fs.chmodSync(file, 0o600) } catch {}
  if (process.platform !== "win32" || !process.env.USERNAME) return
  spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
    windowsHide: true, timeout: 15000, stdio: "ignore",
  })
}

function atomicWrite(file, content, { exclusive = false, private: secret = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (exclusive) {
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
  } else {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
    try {
      fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 })
      fs.renameSync(tmp, file)
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  }
  if (secret) privateFile(file)
}

const writeJson = (file, value, options) => atomicWrite(file, JSON.stringify(value, null, 2) + "\n", options)

function validId(value, nested = false) {
  const id = String(value || "").trim()
  if (!id || id.length > 120 || !new RegExp(nested ? "^[a-zA-Z0-9._-]+(?:/[a-zA-Z0-9._-]+)*$" : "^[a-zA-Z0-9._-]+$").test(id) ||
      id.split("/").some((part) => part === "." || part === ".." || RESERVED.has(part))) {
    throw new Error("Use an ID containing letters, numbers, dots, dashes or underscores; traversal is not allowed.")
  }
  return id
}

function workspace(directory) {
  const dir = path.resolve(directory || process.cwd())
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`)
  return dir
}

function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file))
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
}

/** A symlink/junction cannot redirect a scoped install/removal elsewhere. */
function scopedFile(root, relative) {
  const file = path.resolve(root, relative)
  if (!within(root, file)) throw new Error("The target escapes the selected scope.")
  let cursor = file
  for (;;) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Refusing to write through a symlink or junction. Use the real owning folder.")
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return file
}

function textContent(input, max = 120000) {
  const content = String(input ?? "")
  if (!content.trim()) throw new Error("Content cannot be empty.")
  if (Buffer.byteLength(content, "utf8") > max) throw new Error(`Content exceeds the ${max}-byte limit.`)
  return content
}

function usageOf(session) {
  const usage = session.usage || {}
  const messages = (session.messages || []).filter((m) => m.role === "assistant")
  const details = messages.reduce((sum, m) => {
    const u = m.usage || {}
    sum.reasoning += Number(u.reasoning) || 0
    sum.cacheRead += Number(u.cache?.read) || 0
    sum.cacheWrite += Number(u.cache?.write) || 0
    if (u.cost === undefined) sum.unknownCost = true
    return sum
  }, { reasoning: 0, cacheRead: 0, cacheWrite: 0, unknownCost: false })
  return {
    session: session.id, title: session.title, steps: messages.length,
    input: Number(usage.totalInput) || 0, output: Number(usage.totalOutput) || 0,
    ...details,
    cost: usage.totalCost === undefined ? null : Number(usage.totalCost),
    context: Number(usage.lastInput) || 0,
  }
}

function createControl(engine) {
  const home = engine.home
  const rootFor = (a, folder) => a.global ? path.join(home, folder) : path.join(workspace(a.directory), ".vibe", folder)
  const idleSession = (id) => {
    const session = engine.getSession(id)
    if (engine.isBusy(id) || engine.subagents.activeCount(id)) throw new Error("Stop this session and its running Crew before changing its settings.")
    return session
  }
  const resolveProfile = (wanted) => {
    const list = engine.listProfiles()
    const exact = list.find((p) => p.id === wanted)
    if (exact) {
      if (exact.disabled) throw new Error(`Provider "${wanted}" is disabled.`)
      return exact.id
    }
    const parent = list.filter((p) => !p.disabled && wanted.startsWith(p.id + "/"))
      .sort((a, b) => b.id.length - a.id.length)
      .find((p) => String(p.model || "") === wanted.slice(p.id.length + 1) || (p.models || []).some((m) => m.id === wanted.slice(p.id.length + 1)))
    if (!parent) throw new Error(`Unknown model "${wanted}". Run: vibe models`)
    // Session profile/model keys are resolved in-memory. Do not create extra
    // provider rows or duplicate credentials in the desktop's shared catalog.
    engine._profileTarget(wanted)
    return wanted
  }
  const removeMarkdown = (a, folder) => {
    const root = rootFor(a, folder)
    const id = validId(a.id, true).split("/").map((s) => folder === "agents" ? skills.slug(s) : s.toLowerCase()).join("/")
    const file = scopedFile(root, id + ".md")
    if (!fs.existsSync(file)) return { removed: false, file }
    fs.unlinkSync(file)
    return { removed: true, file }
  }
  const installMarkdown = (a, folder) => {
    const id = validId(a.id, true).split("/").map((s) => folder === "agents" ? skills.slug(s) : s.toLowerCase()).join("/")
    const file = scopedFile(rootFor(a, folder), id + ".md")
    atomicWrite(file, textContent(a.content), { exclusive: true })
    return { id, file, scope: a.global ? "global" : "project" }
  }

  const actions = {
    info: (a) => {
      const browser = engine._browser || (process.versions.electron ? engine._browserManager() : null)
      return {
        home, directory: workspace(a.directory), version: require("../package.json").version,
        browser: !!browser?.getHostWindow?.(),
        crew: { enabled: engine.subagentsEnabled, maxParallel: engine.crewMaxParallel },
        capabilities: Object.keys(actions),
      }
    },
    "skills.list": (a) => skills.listSkills(workspace(a.directory), home).map(({ body, ...row }) => row),
    "skills.show": (a) => skills.loadSkill({ id: a.id, directory: workspace(a.directory), home }),
    "skills.install": (a) => {
      const root = rootFor(a, "playbooks")
      const id = skills.slug(validId(a.id))
      scopedFile(root, path.join(id, "PLAYBOOK.md"))
      return skills.installPlaybookFile({ id, description: a.description, content: textContent(a.content), directory: workspace(a.directory), global: !!a.global, home })
    },
    "skills.import": (a) => skills.importGitHubSkills({ source: a.source, directory: workspace(a.directory), global: !!a.global, home }),
    "skills.remove": (a) => {
      const dir = workspace(a.directory)
      const roots = a.global ? [skills.globalDir(home), skills.globalPlaybookDir(home), skills.globalOpenCodeDir()] :
        [path.join(dir, ".vibe", "skills"), path.join(dir, ".vibe", "playbooks"), skills.projectDir(dir)]
      const row = skills.listSkills(dir, home).find((s) => s.id === a.id && s.scope === (a.global ? "global" : "project"))
      if (!row) return { removed: false }
      const root = roots.find((candidate) => within(candidate, row.file))
      if (!root) throw new Error("This playbook belongs to an ancestor or external installation. Remove it from its owning folder instead.")
      scopedFile(root, path.relative(root, row.file))
      return skills.removeSkillFile({ id: a.id, directory: dir, global: !!a.global, home, strictScope: true })
    },
    "agents.list": (a) => engine.listAgents(workspace(a.directory), { includeHidden: !!a.all }).map(({ system, ...row }) => row),
    "agents.show": (a) => {
      const agent = engine.getAgent(a.id, workspace(a.directory))
      if (!agent) throw new Error(`Unknown agent "${a.id}".`)
      return agent
    },
    "agents.install": (a) => installMarkdown(a, "agents"),
    "agents.remove": (a) => removeMarkdown(a, "agents"),
    "agents.select": (a) => {
      const session = idleSession(a.sessionId)
      const agent = engine.getAgent(a.id, session.dir)
      if (!agent) throw new Error(`Unknown agent "${a.id}".`)
      session.agent = agent.id
      engine.store.save(session)
      return { id: agent.id, name: agent.name, sessionId: session.id }
    },
    "recipes.list": (a) => recipes.listRecipes({ directory: workspace(a.directory), home }),
    "recipes.show": (a) => {
      const recipe = recipes.getRecipe(a.id, { directory: workspace(a.directory), home })
      if (!recipe) throw new Error(`Unknown recipe "${a.id}".`)
      return recipe
    },
    "recipes.install": (a) => installMarkdown(a, "recipes"),
    "recipes.remove": (a) => removeMarkdown(a, "recipes"),
    "mcp.list": (a) => publicData(mcp.listServers(workspace(a.directory), home)),
    "mcp.add": (a) => {
      const file = scopedFile(a.global ? home : path.join(workspace(a.directory), ".vibe"), "mcp.json")
      const raw = readJson(file, {})
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MCP config must contain an object.")
      return mcp.addServer({ ...a, directory: workspace(a.directory), home })
    },
    "mcp.remove": (a) => mcp.removeServer({ ...a, directory: workspace(a.directory), home }),
    "mcp.status": async (a) => {
      await engine.mcp.sync(workspace(a.directory))
      return engine.mcp.status()
    },
    "extensions.list": (a) => {
      const status = new Map(engine.extensions.status().map((s) => [s.id, s]))
      return engine.extensions.discover(workspace(a.directory)).map((row) => ({ ...row, ...(status.get(row.id) || {}), loaded: status.has(row.id) }))
    },
    "extensions.reload": (a) => engine.extensions.sync(workspace(a.directory)),
    "extensions.install": (a) => {
      const id = validId(a.id)
      const file = scopedFile(rootFor(a, a.legacy ? "plugins" : "extensions"), id + ".js")
      // Install is a copy, not a require(). Execution starts only on reload/run.
      atomicWrite(file, textContent(a.content), { exclusive: true })
      return { id, file, scope: a.global ? "global" : "project", loaded: false }
    },
    "extensions.remove": (a) => {
      const file = scopedFile(rootFor(a, a.legacy ? "plugins" : "extensions"), validId(a.id) + ".js")
      if (!fs.existsSync(file)) return { removed: false, file }
      fs.unlinkSync(file)
      engine.extensions.sync(workspace(a.directory))
      return { removed: true, file }
    },
    "plugins.fetch": (a) => {
      const spec = String(a.spec || "").trim()
      const npm = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9.*~^+-]+)?$/i.test(spec)
      const git = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:#[\w./-]+)?$/i.test(spec)
      if (!npm && !git) throw new Error("Use a reviewed npm package/version or public GitHub HTTPS repository; shell flags and shell syntax are not accepted.")
      const target = rootFor(a, "plugins")
      scopedFile(target, "install-check.js")
      fs.mkdirSync(home, { recursive: true })
      const staging = fs.mkdtempSync(path.join(home, ".vibe-plugin-stage-"))
      let installed
      try {
        // Use the existing installer in a private staging scope; it cannot
        // clobber an installed module before discovering the canonical name.
        installed = plugins.installPlugin({ spec, global: false, directory: staging, home })
        if (!within(staging, installed.file)) throw new Error("The plugin installer returned a path outside its staging scope.")
        const id = validId(installed.name)
        const file = scopedFile(target, id + ".js")
        atomicWrite(file, fs.readFileSync(installed.file, "utf8"), { exclusive: true })
        return { name: id, file, scope: a.global ? "global" : "project" }
      } finally {
        if (installed?.file) { try { delete require.cache[require.resolve(installed.file)] } catch {} }
        fs.rmSync(staging, { recursive: true, force: true })
      }
    },
    "tools.list": (a) => ({
      builtin: tools.ALL.map(({ name, description, parameters }) => ({ name, description, parameters })),
      extensions: engine.extensions.toolObjects(workspace(a.directory)).map(({ name, description, parameters }) => ({ name, description, parameters })),
      mcp: [...engine.mcp.toolObjects(), ...engine.mcp.resourceToolObjects()].map(({ name, description, parameters }) => ({ name, description, parameters })),
      crew: engine.subagentsEnabled ? [engine.subagentTool()].map(({ name, description, parameters }) => ({ name, description, parameters })) : [],
    }),
    "memory.list": () => ({ file: path.join(home, "memories.json"), entries: readJson(path.join(home, "memories.json"), []) }),
    "memory.add": (a) => {
      const file = path.join(home, "memories.json")
      const entries = readJson(file, [])
      if (!Array.isArray(entries)) throw new Error("The memory file must contain an array.")
      const text = textContent(a.text, 8000).trim().slice(0, 2000)
      if (!entries.some((e) => e.text === text)) entries.push({ id: crypto.randomBytes(8).toString("hex"), text, date: new Date().toISOString().slice(0, 10) })
      writeJson(file, entries.slice(-500), { private: true })
      return actions["memory.list"]()
    },
    "memory.remove": (a) => {
      const file = path.join(home, "memories.json")
      const entries = readJson(file, [])
      if (!Array.isArray(entries)) throw new Error("The memory file must contain an array.")
      const next = entries.filter((e) => e.id !== a.id)
      writeJson(file, next, { private: true })
      return { removed: next.length !== entries.length, entries: next, file }
    },
    "config.get": () => ({ file: config.configFile(home), compaction: engine.getCompactionConfig(), crew: { enabled: engine.subagentsEnabled, maxParallel: engine.crewMaxParallel } }),
    "config.set": (a) => {
      const raw = readJson(config.configFile(home), {})
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json must contain an object.")
      const keys = ["auto", "background", "buffer", "maxRuns", "model", "keep.tokens"]
      const key = String(a.key || "").replace(/^compaction\./, "")
      if (!keys.includes(key)) throw new Error("Supported settings: compaction.auto/background/buffer/maxRuns/model/keep.tokens")
      let value = a.value
      if (["auto", "background"].includes(key) && typeof value !== "boolean") throw new Error("This setting needs true or false.")
      if (["buffer", "maxRuns", "keep.tokens"].includes(key) && (!Number.isInteger(value) || value < 0)) throw new Error("This setting needs a non-negative integer.")
      if (key === "model" && value != null && value !== "") value = resolveProfile(String(value))
      const patch = key === "keep.tokens" ? { keep: { tokens: value } } : { [key]: value }
      return engine.setCompactionConfig(patch)
    },
    "permissions.list": (a) => {
      const session = a.sessionId ? engine.getSession(a.sessionId) : null
      return {
        global: engine.rules, session: session?.rules || [],
        agent: session?.agent ? engine.getAgent(session.agent, session.dir)?.rules || [] : [],
        locks: loadLocks({ dir: session?.dir || workspace(a.directory), home }),
        pending: [...engine.pending].map(([id, p]) => ({ id, sessionId: p.session?.parentId || p.session?.id, tool: p.tool, subject: p.subject })),
      }
    },
    "permissions.add": (a) => {
      if (!["allow", "ask", "deny"].includes(a.effect)) throw new Error("Permission effect must be allow, ask or deny.")
      const rule = normalizeRules([{ action: a.tool || "*", resource: a.pattern || "*", effect: a.effect }])[0]
      if (a.global) {
        const file = path.join(home, "rules.json")
        const rows = readJson(file, [])
        if (!Array.isArray(rows)) throw new Error("rules.json must contain an array.")
        rows.push(rule)
        writeJson(file, rows)
        engine.rules = [...DEFAULT_RULES, ...normalizeRules(rows)]
      } else {
        const session = idleSession(a.sessionId)
        session.rules = [...(session.rules || []), rule]
        engine.store.save(session)
      }
      return { added: rule, scope: a.global ? "global" : "session" }
    },
    "permissions.clear": (a) => {
      const session = idleSession(a.sessionId)
      session.rules = []
      engine.store.save(session)
      return { cleared: true, sessionId: session.id }
    },
    "permission.reply": (a) => {
      if (!["once", "always", "deny"].includes(a.decision)) throw new Error("Use once, always or deny.")
      return { replied: engine.replyPermission(a.id, a.decision) }
    },
    "crew.list": (a) => engine.listSubagents(a.sessionId),
    "crew.show": (a) => {
      const detail = engine.subagentDetails(a.id)
      if (!detail) throw new Error(`No Crew member "${a.id}".`)
      return { ...detail, messages: engine.getSession(detail.childSessionId).messages }
    },
    "crew.start": (a) => {
      if (!engine.subagentsEnabled) throw new Error("Crew is disabled for this engine.")
      const parent = engine.getSession(a.sessionId)
      textContent(a.task)
      const definition = a.agent ? engine.getAgent(a.agent, parent.dir) : null
      const types = ["general", "web", "read", "write", "bash", "mcp", "plugin"]
      if (a.agent && !definition && !types.includes(a.agent)) throw new Error(`Unknown Crew agent/type "${a.agent}".`)
      return engine.createSubagent({ ...a, ...(a.agent && !definition ? { type: a.agent, agent: undefined } : {}), background: a.background !== false })
    },
    "crew.stop": async (a) => ({ stopped: await engine.stopSubagent(a.id) }),
    "crew.resume": (a) => engine.resumeSubagent(a.id, textContent(a.text), { maxSteps: a.maxSteps }),
    "crew.settings": (a) => {
      if (a.enabled !== undefined) {
        if (typeof a.enabled !== "boolean") throw new Error("enabled must be boolean.")
        engine.subagentsEnabled = a.enabled
      }
      if (a.maxParallel !== undefined) {
        if (!Number.isInteger(a.maxParallel) || a.maxParallel < 1 || a.maxParallel > 16) throw new Error("Crew parallel limit must be 1–16.")
        engine.crewMaxParallel = a.maxParallel
        engine.subagents.maxParallel = a.maxParallel
      }
      return { enabled: engine.subagentsEnabled, maxParallel: engine.crewMaxParallel, scope: "running engine" }
    },
    "shells.list": (a) => engine.listShells(a.sessionId),
    "shells.output": (a) => engine.readShellOutput(a.sessionId, a.id, { max: Math.min(1000000, Math.max(1, Number(a.max) || 30000)), sinceBytes: a.sinceBytes }),
    "shells.input": (a) => engine.shellInput(a.sessionId, a.id, String(a.text || ""), { newline: a.newline !== false, eof: !!a.eof }),
    "shells.background": (a) => a.id ? (engine.getShell(a.sessionId, a.id), engine.backgroundShell(a.sessionId, a.id)) : engine.backgroundSession(a.sessionId),
    "shells.stop": (a) => ({ cancelled: engine.cancelShell(a.sessionId, a.id) }),
    "trail.list": (a) => engine.getTrail(a.sessionId, Math.min(2000, Math.max(1, Number(a.limit) || 200))),
    "todos.list": (a) => engine.todoList(a.sessionId),
    "todos.save": (a) => engine.todoSave(a.sessionId, { items: a.items }),
    "profiles.list": () => engine.listProfiles().map((p) => publicData(p)),
    "profiles.resolve": (a) => ({ id: resolveProfile(String(a.id || "")) }),
    "profiles.save": (a) => {
      const p = { ...a.profile }
      p.id = validId(p.id)
      if (!["openai-chat", "openai-responses", "anthropic"].includes(p.format)) throw new Error("Choose openai-chat, openai-responses or anthropic format.")
      const url = new URL(String(p.baseURL || ""))
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Use an HTTP(S) API URL without embedded credentials.")
      if (!String(p.model || "").trim()) throw new Error("A model ID is required.")
      for (const key of Object.keys(p)) if (SECRET_KEY.test(key) && key !== "headers") throw new Error("Save credentials with vibe auth, not in a profile.")
      if (p.headers && Object.keys(p.headers).some((k) => /authorization|auth|cookie|key|token|secret|password/i.test(k))) throw new Error("Credentials belong in vibe auth, not profile headers.")
      const checkBody = (value) => {
        if (!value || typeof value !== "object") return
        for (const [key, item] of Object.entries(value)) {
          if (RESERVED.has(key) || /api[-_]?key|secret|password|authorization|credential|access[-_]?token|refresh[-_]?token/i.test(key)) throw new Error("Credentials are not allowed in provider body fields.")
          checkBody(item)
        }
      }
      checkBody(p.quirks?.extraBody)
      return engine.upsertProfile(p)
    },
    "profiles.remove": (a) => {
      if (profiles.BUILTIN.some((p) => p.id === a.id)) throw new Error("Built-in providers cannot be removed.")
      const file = path.join(home, "profiles.json")
      const rows = readJson(file, [])
      const next = rows.filter((p) => p.id !== a.id)
      if (next.length === rows.length) return { removed: false }
      writeJson(file, next)
      engine.setKey(a.id, "")
      return { removed: true }
    },
    "profiles.key": (a) => {
      profiles.getProfile(a.id, home)
      engine.setKey(a.id, a.key)
      return { saved: !!String(a.key || "").trim() }
    },
    "profiles.models": async (a) => {
      const p = profiles.getProfile(a.id, home)
      return require("./llm/provider-meta").listRemoteModels({ baseURL: p.baseURL, apiKey: p.noAuth ? "" : profiles.getKey(p, home), format: p.format === "anthropic" ? "anthropic" : p.format === "openai-responses" ? "responses" : "chat", headers: p.headers || {} })
    },
    "usage.get": (a) => {
      if (a.sessionId) return usageOf(engine.getSession(a.sessionId))
      const sessions = engine.listSessions({ dir: a.all ? undefined : workspace(a.directory) }).map((s) => usageOf(engine.getSession(s.id)))
      return { sessions, input: sessions.reduce((n, s) => n + s.input, 0), output: sessions.reduce((n, s) => n + s.output, 0), cost: sessions.reduce((n, s) => n + (s.cost || 0), 0), unknownCost: sessions.some((s) => s.cost === null || s.unknownCost) }
    },
    "session.export": (a) => ({ format: "vibecoder-session", version: 1, session: publicData(engine.getSession(a.sessionId)) }),
    "session.import": (a) => {
      if (a.data?.format !== "vibecoder-session" || a.data?.version !== 1 || !Array.isArray(a.data.session?.messages)) throw new Error("Not a VibeCoder session export.")
      const source = a.data.session
      const session = engine.createSession({ dir: workspace(a.directory), profile: resolveProfile(String(a.profile || source.profile)), title: source.title })
      session.messages = source.messages
      session.todos = Array.isArray(source.todos) ? source.todos : []
      session.usage = source.usage && typeof source.usage === "object" ? source.usage : session.usage
      session.importedFrom = source.id
      engine.store.save(session)
      return session
    },
    "session.state": (a) => {
      const session = engine.getSession(a.sessionId)
      return {
        busy: engine.isBusy(a.sessionId), shells: engine.listShells(a.sessionId).filter((s) => s.status === "running"),
        crew: engine.listSubagents(a.sessionId).filter((s) => s.status === "running"),
        shellResume: engine.shellResumeTimers.has(a.sessionId) || engine.shellResumeRunning.has(a.sessionId),
        pendingShellResults: session.pendingShellResults?.length || 0,
        pendingShellPrompts: session.pendingShellPrompts?.length || 0,
        pendingCrew: engine.listSubagents(a.sessionId).filter((member) => member.status !== "running" && !engine.getSession(member.childSessionId).subagentResultDeliveredAt).length,
      }
    },
    "session.queue": (a) => engine.queuePrompt(a.sessionId, { id: a.id || "pending_" + crypto.randomBytes(8).toString("hex"), text: a.text, files: a.files }),
    "session.stop": (a) => engine.stop(a.sessionId),
    "registry.list": () => publicData(catalog.listRegistries(home)),
    "registry.add": (a) => catalog.addRegistry({ ...a, home }),
    "registry.remove": (a) => catalog.removeRegistry({ ...a, home }),
    "marketplace.list": async (a) => {
      const items = ["mcp", "plugins", "skills"].flatMap((kind) => catalog.BUILTIN[kind].map((row) => ({ ...row, kind: kind === "plugins" ? "plugin" : kind === "skills" ? "skill" : kind, id: row.id || row.name, source: "builtin" })))
      const registries = []
      for (const reg of catalog.listRegistries(home)) {
        const result = await catalog.fetchRegistry(reg, { force: !!a.refresh, home })
        registries.push({ id: reg.id, name: reg.name, cached: !!result.cached, error: result.error || "" })
        if (!result.doc) continue
        for (const kind of ["mcp", "plugins", "skills"]) for (const row of Array.isArray(result.doc[kind]) ? result.doc[kind] : []) {
          items.push({ ...row, kind: kind === "plugins" ? "plugin" : kind === "skills" ? "skill" : kind, id: row.id || row.name, source: reg.id })
        }
      }
      return { items: publicData(items), registries }
    },
    "marketplace.install": async (a) => {
      const found = (await actions["marketplace.list"](a)).items.filter((i) => i.id === a.id && (!a.kind || i.kind === a.kind) && (!a.source || i.source === a.source))
      if (found.length !== 1) throw new Error("Select an exact kind/ID/source from vibe marketplace.")
      const item = found[0]
      if (item.kind === "skill") return actions["skills.install"]({ ...a, id: item.id, content: item.content, description: item.description })
      if (item.kind === "mcp") return actions["mcp.add"]({ ...item, ...a, name: item.name || item.id })
      if (item.kind === "plugin" && item.content) return actions["extensions.install"]({ ...a, id: item.id, content: item.content, legacy: true })
      if (item.kind === "plugin" && item.spec) return actions["plugins.fetch"]({ ...a, spec: item.spec })
      throw new Error("This item has no supported install source. Use a reviewed local file instead.")
    },
    "project.init": (a) => {
      const dir = workspace(a.directory)
      const templates = {
        "VIBE.md": "# Project brief\n\nDescribe the goal, commands, conventions and verification steps for this project.\n",
        ".vibe/agents/reviewer.md": "---\nname: Inspector\ndescription: Review project changes without editing files.\nmode: subagent\npermissions: write:**=deny, edit:**=deny, bash:**=deny\n---\nRead the relevant files and report concrete findings with file and line references.\n",
        ".vibe/recipes/review.md": "---\ndescription: Review the requested changes.\n---\nReview $ARGUMENTS. Read the files and report bugs, risks and missing tests. Do not commit or change files unless asked.\n",
      }
      const created = [], skipped = []
      for (const [relative, content] of Object.entries(templates)) {
        const file = scopedFile(dir, relative)
        if (fs.existsSync(file)) { skipped.push(file); continue }
        atomicWrite(file, content, { exclusive: true })
        created.push(file)
      }
      return { created, skipped }
    },
  }

  const browserMethods = { tabs: "ListTabs", current: "Current", open: "CreateTab", close: "CloseTab", navigate: "Navigate", screenshot: "Screenshot", snapshot: "Snapshot", click: "Click", fill: "Fill", press: "Press", scroll: "Scroll", evaluate: "Evaluate", wait: "Wait" }
  for (const [name, suffix] of Object.entries(browserMethods)) actions["browser." + name] = (a) => engine["browser" + suffix](a)

  return {
    actions: Object.keys(actions),
    async call(action, args = {}) {
      if (!Object.prototype.hasOwnProperty.call(actions, action)) throw new Error(`Unknown VibeCore control action "${action}".`)
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Control arguments must be an object.")
      return actions[action](args)
    },
  }
}

module.exports = { createControl, usageOf, publicData, readJson, writeJson, atomicWrite, privateFile, validId, scopedFile }
