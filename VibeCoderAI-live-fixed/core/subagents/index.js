"use strict"
/**
 * Subagents: spawn smaller agents inside a running session to do focused work
 * (research, reading, editing, running commands, calling MCP/plugin tools, ...).
 * Each subagent runs its own mini `runLoop` against the same LLM profile but
 * with a restricted tool set and its own system prompt. A parent agent can:
 *   - createSubagent(name, type, task)   -> returns { id, status }
 *   - listSubagents()                    -> all subagents + status
 *   - subagentStatus(id)                 -> "running" | "done" | "error"
 *   - subagentResult(id)                 -> final text once done
 *   - subagentStop(id)                   -> abort
 *
 * Subagents are scoped to a session: they live while the session is alive and
 * are dropped when the session is removed. They emit events on the session's
 * emit so the UI can show "subagent started / step / done" cards.
 */

const fs = require("fs")
const path = require("path")
const { newId } = require("../util")
const tools = require("../tools")
const profiles = require("../llm/profiles")
const { buildSystem } = require("../agent/prompt")
const { runLoop, repairHistory } = require("../agent/loop")

const DEFAULT_MAX_STEPS = 25

/** Built-in subagent tool profiles. Each profile picks which tools a subagent
 * of that type may use. */
const PROFILES = {
  web: {
    name: "Web Researcher",
    description: "Research the web and return a readable summary.",
    tools: ["webfetch", "read", "write", "todowrite"],
    systemExtra: "You are a research assistant. Use webfetch to browse URLs, then write a concise, well-sourced summary. Always cite URLs.",
  },
  read: {
    name: "Code Explorer",
    description: "Read and summarize files/directories in the workspace.",
    tools: ["read", "list", "grep", "glob", "write", "todowrite"],
    systemExtra: "You are a code-reading assistant. Inspect files and return clear summaries with file paths and line references. Do not edit anything unless asked.",
  },
  write: {
    name: "Coding Agent",
    description: "Create or edit files in the workspace.",
    tools: ["read", "list", "write", "edit", "multiedit", "apply_patch", "glob", "grep", "todowrite"],
    systemExtra: "You are a coding assistant. Create/edit files using read/write/edit. Run small checks only if explicitly asked.",
  },
  bash: {
    name: "Command Agent",
    description: "Run shell commands in the workspace.",
    tools: ["bash", "read", "list", "glob", "grep", "todowrite"],
    systemExtra: "You are a command-line assistant. Run commands with bash and report the output. Be careful with destructive commands.",
  },
  mcp: {
    name: "MCP Agent",
    description: "Call MCP server tools.",
    tools: ["mcp"],
    systemExtra: "You are an MCP tool-calling assistant. Use the available mcp__ tools to talk to connected MCP servers and report results.",
  },
  plugin: {
    name: "Plugin Agent",
    description: "Call plugin tools.",
    tools: ["plugin"],
    systemExtra: "You are a plugin tool-calling assistant. Use the available plugin__ tools and report results.",
  },
  general: {
    name: "General Agent",
    description: "General purpose subagent with all built-in tools.",
    tools: [...tools.ALL.map((t) => t.name)],
    systemExtra: "You are a general assistant. Use the available tools to complete the task and report results.",
  },
}

/**
 * V-02: pick which tools a subagent of `type` may use from the full engine
 * catalog (built-ins + MCP + plugins). `mcp` and `plugin` are PREFIX types:
 * they receive every tool whose name starts with mcp__ / plugin__ (a plain
 * name lookup could never match them, because tools.ALL has no such tools).
 */
function selectTools(type, list) {
  const all = Array.isArray(list) ? list : []
  if (type === "mcp") return all.filter((t) => t.name.startsWith("mcp__"))
  if (type === "plugin") return all.filter((t) => t.name.startsWith("plugin__"))
  const allowed = new Set(PROFILES[type] ? PROFILES[type].tools : [])
  return all.filter((t) => allowed.has(t.name))
}

class SubAgentManager {
  constructor(engine, { maxParallel = 4 } = {}) {
    this.engine = engine
    this.agents = new Map()
    this.maxParallel = Math.max(1, Math.min(16, Math.floor(Number(maxParallel) || 4)))
  }

  /** Number of live children owned by one parent session. */
  activeCount(parentSessionId, exceptId = "") {
    let count = 0
    for (const agent of this.agents.values()) {
      if (agent.id !== exceptId && agent.sessionId === parentSessionId && agent.status === "running") count++
    }
    return count
  }

  _assertCapacity(parentSessionId, exceptId = "") {
    if (this.activeCount(parentSessionId, exceptId) >= this.maxParallel) {
      throw new Error(`Crew parallel limit reached (${this.maxParallel}). Wait for a running helper to finish or stop one before starting another.`)
    }
  }

  _public(a) {
    const durationMs = a.completedAt && a.startedAt ? Math.max(0, a.completedAt - a.startedAt) : 0
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      agent: a.agentId || a.type,
      task: a.task,
      status: a.status,
      result: a.result || "",
      error: a.error || "",
      sessionId: a.sessionId,
      childSessionId: a.childSessionId,
      background: a.background !== false,
      startedAt: a.startedAt || 0,
      completedAt: a.completedAt || 0,
      durationMs,
      ok: a.status === "done" ? true : a.status === "error" ? false : null,
      parentToolCallId: a.parentToolCallId || "",
    }
  }

  _fromChild(child) {
    if (!child || child.kind !== "subagent" || !child.agentId) return null
    const savedStatus = String(child.subagentStatus || "done")
    return {
      id: child.agentId,
      name: child.subagentName || child.title || "Subagent",
      type: child.subagentType || "general",
      agentId: child.subagentDefinition || child.subagentType || "general",
      task: child.subagentTask || "",
      status: savedStatus === "running" ? "error" : savedStatus,
      result: child.subagentResult || lastAssistantText(child) || "",
      error: savedStatus === "running" ? "Interrupted when the app stopped." : (child.subagentError || ""),
      sessionId: child.parentId,
      childSessionId: child.id,
      session: child,
      background: child.subagentBackground !== false,
      startedAt: child.subagentStartedAt || child.createdAt || 0,
      completedAt: child.subagentCompletedAt || child.updatedAt || 0,
      parentToolCallId: child.subagentParentToolCallId || "",
      progress: [],
      liveText: "",
      liveReasoning: "",
      ctl: null,
      done: Promise.resolve(),
      recovered: true,
    }
  }

  _get(id) {
    const live = this.agents.get(id)
    if (live) return live
    for (const row of this.engine.store.list({ includeSubagents: true })) {
      if (row.agentId !== id) continue
      const recovered = this._fromChild(this.engine.store.get(row.id))
      if (recovered) this.agents.set(id, recovered)
      return recovered
    }
    return null
  }

  /** Create a subagent inside a session. Returns its public descriptor. */
  create({ sessionId, name, type = "general", agent: requestedAgent, task, maxSteps, profile, background = true, parentToolCallId = "" } = {}) {
    const parent = this.engine.store.get(sessionId)
    if (!parent) throw new Error("Session not found: " + sessionId)
    if (parent.kind === "subagent") throw new Error("Subagents cannot spawn nested subagents.")
    this._assertCapacity(parent.id)
    const agentId = String(requestedAgent || type || "general")
    const definition = typeof this.engine.getAgent === "function" ? this.engine.getAgent(agentId, parent.dir) : null
    const legacyType = PROFILES[type] ? type : PROFILES[agentId] ? agentId : "general"
    if (!definition && !PROFILES[legacyType]) throw new Error("Unknown subagent type/agent: " + agentId)
    const subProfile = profile || definition?.model || parent.profile

    const id = newId("subagent")
    const ctl = new AbortController()
    const displayName = name || definition?.name || PROFILES[legacyType]?.name || `${legacyType}_agent`
    const startedAt = Date.now()

    const child = this.engine.store.create({
      dir: parent.dir,
      profile: subProfile,
      title: `subagent: ${String(task || type).replace(/\s+/g, " ").trim().slice(0, 40) || type}`,
      kind: "subagent",
      parentId: parent.id,
      agentId: id,
    })
    child.subagentName = displayName
    child.subagentType = legacyType
    child.subagentDefinition = definition?.id || agentId
    child.subagentTask = String(task || "")
    child.subagentStatus = "running"
    child.subagentResult = ""
    child.subagentError = ""
    child.subagentBackground = background !== false
    child.subagentStartedAt = startedAt
    child.subagentParentToolCallId = String(parentToolCallId || "")
    // The task is a real child-session message: the detail view can show it and
    // the model receives the same durable prompt after resume/restart.
    child.messages.push({ role: "user", parts: [{ type: "text", text: String(task || ""), subagentTask: true }] })
    this.engine.store.save(child)

    const record = {
      id,
      name: displayName,
      type: legacyType,
      agentId: definition?.id || agentId,
      definition,
      task: String(task || ""),
      status: "running",
      result: "",
      error: "",
      sessionId: parent.id,
      childSessionId: child.id,
      session: child,
      profile: subProfile,
      maxSteps: maxSteps || definition?.steps || DEFAULT_MAX_STEPS,
      background: background !== false,
      startedAt,
      completedAt: 0,
      parentToolCallId: String(parentToolCallId || ""),
      progress: [],
      liveText: "",
      liveReasoning: "",
      ctl,
      done: null,
    }
    this.agents.set(id, record)
    record.done = this._run(record)
    return {
      ...this._public(record),
      sessionID: child.id,
      notice: `Subagent "${displayName}" is ${record.background ? "working in the background" : "running"}. Open its row to watch progress. You will be notified when it finishes.`,
    }
  }

  list(sessionId) {
    const out = new Map()
    for (const a of this.agents.values()) {
      if (sessionId && a.sessionId !== sessionId) continue
      out.set(a.id, this._public(a))
    }
    for (const row of this.engine.store.list({ includeSubagents: true })) {
      if (row.kind !== "subagent" || !row.agentId || out.has(row.agentId)) continue
      const a = this._fromChild(this.engine.store.get(row.id))
      if (!a || (sessionId && a.sessionId !== sessionId)) continue
      this.agents.set(a.id, a)
      out.set(a.id, this._public(a))
    }
    return [...out.values()].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  }

  status(id) {
    const a = this._get(id)
    if (!a) return null
    return this._public(a)
  }

  result(id) {
    const a = this._get(id)
    if (!a) return null
    return this._public(a)
  }

  details(id) {
    const a = this._get(id)
    if (!a) return null
    return { ...this._public(a), progress: a.progress || [], liveText: a.liveText || "", liveReasoning: a.liveReasoning || "" }
  }

  takeResults(parentSessionId) {
    const results = []
    for (const item of this.list(parentSessionId)) {
      if (item.status === "running") continue
      const a = this._get(item.id)
      if (!a || a.session.subagentResultDeliveredAt) continue
      const publicResult = this._public(a)
      results.push({ id: a.id, name: a.name, status: a.status, ok: publicResult.ok, result: a.result, error: a.error, durationMs: publicResult.durationMs })
      a.session.subagentResultDeliveredAt = Date.now()
      this.engine.store.save(a.session)
    }
    return results
  }

  async wait(id) {
    const a = this._get(id)
    if (!a) return null
    await a.done
    return this.result(id)
  }

  resume(id, text, { maxSteps } = {}) {
    const a = this._get(id)
    if (!a) throw new Error(`No subagent found with id: ${id}`)
    if (a.status === "running") throw new Error("Subagent is already running.")
    this._assertCapacity(a.sessionId, a.id)
    if (!a.definition && typeof this.engine.getAgent === "function") a.definition = this.engine.getAgent(a.agentId, a.session.dir)
    if (a.recovered && !a.profile) a.profile = a.definition?.model || a.session.profile
    a.ctl = new AbortController()
    a.status = "running"
    a.error = ""
    a.result = ""
    a.startedAt = Date.now()
    a.completedAt = 0
    a.maxSteps = maxSteps || a.maxSteps || DEFAULT_MAX_STEPS
    a.session.messages.push({ role: "user", parts: [{ type: "text", text: String(text || ""), subagentFollowup: true }] })
    a.session.subagentStatus = "running"
    a.session.subagentError = ""
    a.session.subagentStartedAt = a.startedAt
    a.session.subagentCompletedAt = 0
    a.session.subagentDurationMs = 0
    delete a.session.subagentResultDeliveredAt
    this.engine.store.save(a.session)
    this._event(a, { type: "subagent.resume", text: String(text || "") })
    a.done = this._run(a)
    return this._public(a)
  }

  stop(id) {
    const a = this._get(id)
    if (!a || a.status !== "running" || !a.ctl) return false
    a.ctl.abort()
    return true
  }

  _event(agent, ev) {
    const clean = { ...ev, time: Date.now() }
    if (clean.screenshot?.data) clean.screenshot = { ...clean.screenshot, data: "" }
    if (typeof clean.output === "string" && clean.output.length > 12000) clean.output = clean.output.slice(0, 12000) + "\n[truncated]"
    agent.progress.push(clean)
    if (agent.progress.length > 500) agent.progress.splice(0, agent.progress.length - 500)
    try {
      this.engine._emit(agent.sessionId, { ...ev, subagentId: agent.id, subagentSessionId: agent.childSessionId, subagentName: agent.name, agentType: agent.type, subagentBackground: agent.background, parentToolCallId: agent.parentToolCallId })
    } catch {}
  }

  _persist(agent) {
    const child = agent.session
    child.subagentStatus = agent.status
    child.subagentResult = agent.result
    child.subagentError = agent.error
    child.subagentCompletedAt = agent.completedAt
    child.subagentDurationMs = agent.completedAt && agent.startedAt ? Math.max(0, agent.completedAt - agent.startedAt) : 0
    this.engine.store.save(child)
  }

  _publishResult(agent) {
    // Do not rewrite the parent from a child process. The parent consumes this
    // persisted child result at its next prompt/resume safe boundary.
    if (!agent.background) {
      agent.session.subagentResultDeliveredAt = Date.now()
      this.engine.store.save(agent.session)
    }
    const result = this._public(agent)
    this._event(agent, { type: "subagent.result", status: agent.status, ok: result.ok, durationMs: result.durationMs, result: agent.result, error: agent.error })
  }

  /** Internal: run the subagent's isolated loop. */
  async _run(agent) {
    const store = this.engine.store
    const session = agent.session

    try {
      this._event(agent, { type: "subagent.start", name: agent.name, agentType: agent.type, task: agent.task })
      const profileObj = typeof agent.profile === "string" ? profiles.getProfile(agent.profile, this.engine.home) : agent.profile
      if (!profileObj || typeof profileObj !== "object" || !profileObj.format) {
        throw new Error(`Subagent model profile is missing a valid format (profile: ${typeof agent.profile === "string" ? agent.profile : "object"})`)
      }
      const apiKey = profiles.getKey(profileObj, this.engine.home)
      const extraTools = () => {
        const builtin = [...tools.ALL]
        let ext = []
        try {
          if (this.engine.extraTools) ext = this.engine.extraTools(session.dir)
        } catch {}
        const seen = new Map()
        for (const t of [...builtin, ...ext]) if (t && t.name) seen.set(t.name, t)
        // Hard depth=1: no child catalog ever contains the spawn tool. Children
        // also never own the user's attention: questions belong to the parent.
        return selectTools(agent.type, [...seen.values()]).filter((tool) => tool.name !== "subagent" && tool.name !== "question")
      }
      const system = buildSystem({
        agentName: agent.name,
        cwd: session.dir,
        model: profileObj.model,
        home: this.engine?.home,
        extra:
          "You are a SUBAGENT spawned by the parent agent. Your only job is: " +
          agent.task +
          "\n\n" +
          PROFILES[agent.type].systemExtra +
          (agent.definition?.system ? `\n\n${agent.definition.system}` : "") +
          "\n\nWhen you are finished, write a short final summary and stop. Do not ask the user for permission; the parent agent owns the session.",
      })

      const emitSubagent = (ev) => {
        if (ev?.type === "text.delta" && typeof ev.delta === "string") agent.liveText += ev.delta
        if (ev?.type === "reasoning.delta" && typeof ev.delta === "string") agent.liveReasoning += ev.delta
        if (ev?.type === "tool.start") { agent.liveText = ""; agent.liveReasoning = "" }
        this._event(agent, ev)
      }
      await runLoop({
        session,
        store,
        profile: profileObj,
        apiKey,
        emit: emitSubagent,
        signal: agent.ctl.signal,
        // Reuse the session's actual permission policy, plus the parent's saved
        // "always" approvals. Prompts still surface on the parent session.
        askPermission: this.engine._ask(session, agent.ctl.signal, (ev) => this._event(agent, ev), this.engine.store.get(agent.sessionId), agent.definition?.rules || []),
        agentName: agent.name,
        extraSystem: system,
        maxSteps: agent.maxSteps,
        extraTools,
        waitExtraTools: null,
        isOrphan: () => agent.ctl.signal.aborted,
        engine: this.engine,
      })
      agent.status = agent.ctl.signal.aborted ? "error" : "done"
      agent.result = lastAssistantText(session) || agent.liveText || "(no text produced)"
      if (agent.ctl.signal.aborted && !agent.error) agent.error = "Stopped by user."
    } catch (e) {
      agent.status = "error"
      agent.error = (e && e.message) || String(e)
      this._event(agent, { type: "subagent.error", error: agent.error })
    } finally {
      agent.completedAt = Date.now()
      agent.liveText = ""
      agent.liveReasoning = ""
      this._persist(agent)
      this._event(agent, { type: "subagent.end", status: agent.status, result: agent.result, error: agent.error })
      this._publishResult(agent)
    }
  }
}

function lastAssistantText(session) {
  for (let i = (session?.messages?.length || 0) - 1; i >= 0; i--) {
    const message = session.messages[i]
    if (message?.role !== "assistant") continue
    const text = (message.parts || []).filter((part) => part.type === "text").map((part) => String(part.text || "")).join("\n").trim()
    if (text) return text
  }
  return ""
}

module.exports = { SubAgentManager, PROFILES, selectTools }
