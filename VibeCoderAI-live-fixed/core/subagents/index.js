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
    description: "Research the web and return a readable summary.",
    tools: ["webfetch", "read", "write", "todowrite"],
    systemExtra: "You are a research assistant. Use webfetch to browse URLs, then write a concise, well-sourced summary. Always cite URLs.",
  },
  read: {
    description: "Read and summarize files/directories in the workspace.",
    tools: ["read", "grep", "glob", "write", "todowrite"],
    systemExtra: "You are a code-reading assistant. Inspect files and return clear summaries with file paths and line references. Do not edit anything unless asked.",
  },
  write: {
    description: "Create or edit files in the workspace.",
    tools: ["read", "write", "edit", "glob", "grep", "todowrite"],
    systemExtra: "You are a coding assistant. Create/edit files using read/write/edit. Run small checks only if explicitly asked.",
  },
  bash: {
    description: "Run shell commands in the workspace.",
    tools: ["bash", "read", "glob", "grep", "todowrite"],
    systemExtra: "You are a command-line assistant. Run commands with bash and report the output. Be careful with destructive commands.",
  },
  mcp: {
    description: "Call MCP server tools.",
    tools: ["mcp"],
    systemExtra: "You are an MCP tool-calling assistant. Use the available mcp__ tools to talk to connected MCP servers and report results.",
  },
  plugin: {
    description: "Call plugin tools.",
    tools: ["plugin"],
    systemExtra: "You are a plugin tool-calling assistant. Use the available plugin__ tools and report results.",
  },
  general: {
    description: "General purpose subagent with all built-in tools.",
    tools: [...tools.ALL.map((t) => t.name)],
    systemExtra: "You are a general assistant. Use the available tools to complete the task and report results.",
  },
}

class SubAgentManager {
  constructor(engine) {
    this.engine = engine
    this.agents = new Map() // id -> { id, name, type, task, status, result, error, sessionId, ctl, done }
  }

  /** Create a subagent inside a session. Returns { id, status }. */
  create({ sessionId, name, type = "general", task, maxSteps, profile } = {}) {
    const session = this.engine.store.get(sessionId)
    if (!session) throw new Error("Session not found: " + sessionId)
    const profileName = PROFILES[type]
    if (!profileName) throw new Error("Unknown subagent type: " + type)

    // The subagent runs against the SAME model profile as the parent session
    // (it is the same engine, same home). Without this the subagent fell back
    // to a built-in profile id it could not authenticate -> "error".
    const subProfile = profile || session.profile

    const id = newId("subagent")
    const ctl = new AbortController()
    const agent = {
      id,
      name: name || type + "_agent",
      type,
      task: String(task || ""),
      status: "running",
      result: "",
      error: "",
      sessionId,
      ctl,
      done: null,
    }
    this.agents.set(id, agent)

    // Fire and forget; errors are stored on the agent so subagentResult/Status
    // can report them. The parent session keeps running independently.
    this._run(agent, session, subProfile, maxSteps || DEFAULT_MAX_STEPS)
    return {
      id,
      status: "running",
      // opencode-style guidance so the parent does NOT poll the child
      notice:
        `The subagent is working in the background (sessionID: ${id}). You will be notified automatically when it finishes. ` +
        "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; " +
        "avoid working with the same files or topics it is using. " +
        "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
    }
  }

  list(sessionId) {
    const out = []
    for (const a of this.agents.values()) {
      if (sessionId && a.sessionId !== sessionId) continue
      out.push({
        id: a.id,
        name: a.name,
        type: a.type,
        task: a.task,
        status: a.status,
        sessionId: a.sessionId,
      })
    }
    return out
  }

  status(id) {
    const a = this.agents.get(id)
    if (!a) return null
    return { id: a.id, status: a.status, error: a.error, sessionId: a.sessionId }
  }

  result(id) {
    const a = this.agents.get(id)
    if (!a) return null
    return { id: a.id, status: a.status, result: a.result, error: a.error }
  }

  stop(id) {
    const a = this.agents.get(id)
    if (!a) return false
    a.ctl.abort()
    return true
  }

  /** Internal: run the subagent's mini loop. */
  async _run(agent, session, profile, maxSteps) {
    const store = this.engine.store
    const id = agent.id
    const tryEmit = (ev) => {
      try {
        // Engine exposes _emit(sessionId, event), not an `emit` property.
        // Going through it makes child events visible to the UI and allows
        // permission.ask events to be answered by the parent session.
        this.engine._emit(session.id, { ...ev, subagentId: id })
      } catch {}
    }

    try {
      tryEmit({ type: "subagent.start", name: agent.name, type: agent.type, task: agent.task })
      // The parent session stores a profile id (e.g. "mock"), but runLoop and
      // the LLM adapters require the resolved profile object (including format).
      // Internal callers may also supply an already-resolved profile object.
      const profileObj = typeof profile === "string" ? profiles.getProfile(profile, this.engine.home) : profile
      if (!profileObj || typeof profileObj !== "object" || !profileObj.format) {
        throw new Error(`Subagent model profile is missing a valid format (profile: ${typeof profile === "string" ? profile : "object"})`)
      }
      const apiKey = profiles.getKey(profileObj, this.engine.home)
      const allBuiltIn = () => [...tools.ALL]
      const allowed = new Set(PROFILES[agent.type].tools)
      const extraTools = () =>
        allBuiltIn().filter((t) => allowed.has(t.name))
      const system = buildSystem({
        agentName: agent.name,
        cwd: session.dir,
        extra:
          "You are a SUBAGENT spawned by the parent agent. Your only job is: " +
          agent.task +
          "\n\n" +
          PROFILES[agent.type].systemExtra +
          "\n\nWhen you are finished, write a short final summary and stop. Do not ask the user for permission; the parent agent owns the session.",
      })

      let finalText = ""
      const emitSubagent = (ev) => {
        if (ev && ev.type === "text.delta" && typeof ev.delta === "string") finalText += ev.delta
        tryEmit(ev)
      }
      const done = await runLoop({
        session,
        store,
        profile: profileObj,
        apiKey,
        emit: emitSubagent,
        signal: agent.ctl.signal,
        // Reuse the session's actual permission policy. Permission prompts are
        // emitted into the parent session so the user can approve/deny them.
        askPermission: this.engine._ask(session, agent.ctl.signal, tryEmit),
        agentName: agent.name,
        extraSystem: system,
        maxSteps,
        extraTools,
        waitExtraTools: null,
        isOrphan: () => agent.ctl.aborted,
        engine: this.engine,
      })
      // runLoop resolves when the loop finishes (done/interrupted/error)
      agent.status = agent.ctl.aborted ? "error" : "done"
      agent.result = finalText || "(no text produced)"
    } catch (e) {
      agent.status = "error"
      agent.error = (e && e.message) || String(e)
      tryEmit({ type: "subagent.error", error: agent.error })
    } finally {
      agent.done = true
      tryEmit({ type: "subagent.end", status: agent.status })
    }
  }
}

module.exports = { SubAgentManager, PROFILES }
