"use strict"
const fs = require("fs")
const path = require("path")
const { SessionStore } = require("./store/sessions")
const profiles = require("./llm/profiles")
const { DEFAULT_RULES, normalizeRules } = require("./perm/rules")
const { runLoop, repairHistory } = require("./agent/loop")
const compaction = require("./agent/compaction")
const agents = require("./agents")
const config = require("./config")
const { buildSystem } = require("./agent/prompt")
const snapshots = require("./store/snapshots")
const tools = require("./tools")
const jobs = require("./jobs")
const { McpManager } = require("./mcp")
const { SubAgentManager } = require("./subagents")
const forms = require("./forms")
const { ExtensionManager } = require("./harness/extensions")
const { loadLocks, isLocked } = require("./harness/locks")
const { combineRules, decideWithSource } = require("./harness/guard")
const recipes = require("./harness/recipes")
const { Trail, shouldTrail } = require("./harness/trail")
const { newId, homeDir } = require("./util")

class Engine {
  /**
   * @param {{home?:string, agentName?:string, permission?:"ask"|"allow"|"deny", rules?:Array, extraSystem?:string, crewMaxParallel?:number}} opts
   * permission: what to do when a rule says "ask" and nobody answers: "ask" = emit permission.ask and wait.
   */
  constructor(opts = {}) {
    this.home = opts.home || homeDir()
    this.store = new SessionStore(this.home)
    this.agentName = opts.agentName || "VibeCoder AI"
    this.permissionMode = opts.permission || "ask"
    this.extraSystem = opts.extraSystem || ""
    let user = []
    try {
      user = JSON.parse(fs.readFileSync(path.join(this.home, "rules.json"), "utf8"))
    } catch {}
    // V-08: normalize both rule shapes at load time; last match still wins.
    this.rules = [...DEFAULT_RULES, ...normalizeRules(user), ...normalizeRules(opts.rules)]
    // async, ONE background PowerShell call total: upgrades pre-encryption
    // auth.json and warms the key cache - the UI hot path never spawns.
    profiles.migrateAuthKeys(this.home)
    this.listeners = new Set()
    this.trail = new Trail({ home: this.home })
    this.pending = new Map()
    // V-10: interactive questions the agent is waiting on (formID -> form).
    this.forms = new Map()
    this.runs = new Map()
    this.mcp = new McpManager({ home: this.home })
    this.extensions = new ExtensionManager({ home: this.home })
    this._mcpSync = null // in-flight connect promise (dedupe)
    this.crewMaxParallel = Math.max(1, Math.min(16, Math.floor(Number(opts.crewMaxParallel) || 4)))
    this.subagents = new SubAgentManager(this, { maxParallel: this.crewMaxParallel })
    this.subagentsEnabled = opts.subagentsEnabled !== false // on by default
    // V-07 convenience API: engine.agents.list(dir) / engine.agents.get(id, dir)
    this.agents = {
      list: (dir, listOpts) => this.listAgents(dir, listOpts),
      get: (id, dir) => this.getAgent(id, dir),
    }
  }

  subagentTool() {
    return {
      name: "subagent",
      description:
        "Run a focused subagent in its own visible child session. By default this waits and returns the final result inline; set background:true to keep the main agent moving while the user watches the child progress.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["general", "web", "read", "write", "bash", "mcp", "plugin"],
            description: "Kind of subagent",
          },
          agent: { type: "string", description: "Agent definition id (for example explore or general). Overrides type while type remains backward-compatible." },
          task: { type: "string", description: "What the subagent should accomplish" },
          name: { type: "string", description: "Optional name" },
          maxSteps: { type: "integer", description: "Max steps, default 25" },
          background: { type: "boolean", description: "true = return immediately; false/default = wait and return the final result" },
        },
        required: ["task"],
      },
      perm: (a) => ({ tool: "subagent", subject: String(a.agent || a.type || "general") }),
      paths: () => [],
      run: async (a, c) => {
        const r = this.subagents.create({
          sessionId: c.session && c.session.id,
          name: a.name,
          type: a.type,
          agent: a.agent,
          task: a.task,
          maxSteps: a.maxSteps,
          background: a.background === true,
          parentToolCallId: c.toolCallId,
        })
        if (c.stats) Object.assign(c.stats, {
          subagentId: r.id,
          subagentSessionId: r.childSessionId || r.sessionID,
          subagentName: r.name,
          subagentType: r.type,
          subagentAgent: r.agent,
          subagentTask: r.task,
          subagentStatus: r.status,
          background: r.background,
          parentToolCallId: r.parentToolCallId || c.toolCallId,
        })
        const id = r.id
        const name = r.name || a.name || a.agent || a.type || "subagent"
        if (a.background !== true) {
          const onAbort = () => this.subagents.stop(id)
          c.signal?.addEventListener("abort", onAbort, { once: true })
          let final
          try { final = await this.subagents.wait(id) }
          finally { c.signal?.removeEventListener("abort", onAbort) }
          if (!final) throw new Error(`Subagent "${id}" disappeared before returning a result.`)
          if (c.stats) Object.assign(c.stats, { subagentStatus: final.status, subagentResult: final.result, subagentError: final.error, completedAt: final.completedAt })
          if (final.status === "error") throw new Error(`Subagent "${name}" failed: ${final.error || "unknown error"}`)
          return `Subagent "${name}" completed.\n\n${final.result}`
        }
        const parts = [
          `Subagent "${name}" started (id: ${id}). It runs in the background.`,
          "",
          r.notice ||
            `The subagent is working in the background (sessionID: ${id}). You will be notified automatically when it finishes. ` +
              "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; " +
              "avoid working with the same files or topics it is using. " +
              "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
          "",
          "Its final result will be attached automatically and shown in the clickable subagent row.",
        ]
        return parts.join("\n")
      },
    }
  }

  /**
   * User extensions for a workspace: MCP tools (connect in the background,
   * never block a prompt) + plugin tools (loaded fresh, cheap).
   */
  extraTools(directory) {
    if (!this._mcpSync) {
      const p = this.mcp.sync(directory).finally(() => {
        if (this._mcpSync === p) this._mcpSync = null
      })
      this._mcpSync = p
      p.catch(() => {})
    }
    let pl = []
    try {
      pl = this.extensions.toolObjects(directory)
    } catch {}
    const ex = [...this.mcp.toolObjects(), ...this.mcp.resourceToolObjects(), ...pl]
    if (this.subagentsEnabled) ex.push(this.subagentTool())
    return ex
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  _emit(sessionId, ev) {
    const full = { ...ev, sessionId, time: Date.now() }
    for (const l of this.listeners) {
      try {
        l(full)
      } catch {}
    }
    // Durable audit trail: only low-frequency, useful checkpoints. A logging
    // failure must never affect the run, so Trail.append() swallows errors.
    if (shouldTrail(full)) this.trail.append(sessionId, full)
    try { this.extensions.event(full) } catch {}
    return full
  }

  /** Read the persisted audit trail for a session (oldest first). */
  getTrail(sessionId, limit = 200) {
    return this.trail.read(sessionId, limit)
  }

  // ---- profiles / auth ----
  listProfiles() {
    return profiles.listProfiles(this.home).map((p) => ({ ...p, hasKey: profiles.hasKey(p, this.home) }))
  }
  upsertProfile(p) {
    return profiles.upsertProfile(p, this.home)
  }
  setKey(id, key) {
    profiles.setKey(id, key, this.home)
  }

  // ---- agents (V-07) ----
  listAgents(dir, { includeHidden = false } = {}) {
    return agents.listAgents({ home: this.home, dir }).filter((agent) => includeHidden || !agent.hidden)
  }
  getAgent(id, dir) {
    return agents.getAgent(id, { home: this.home, dir })
  }

  // ---- sessions ----
  createSession({ dir, profile, title, agent } = {}) {
    profiles.getProfile(profile, this.home)
    const session = this.store.create({ dir, profile, title })
    if (agent) {
      const found = this.getAgent(agent, session.dir)
      if (!found) throw new Error(`Unknown agent "${agent}". Add <dir>/.vibe/agents/${agent}.md or ${this.home}/agents/${agent}.md`)
      session.agent = found.id
      this.store.save(session)
    }
    return session
  }
  listSessions(q) {
    return this.store.list(q)
  }
  getSession(id) {
    return this.store.get(id)
  }
  renameSession(id, title) {
    return this.store.rename(id, title)
  }
  removeSession(id) {
    // A deleted session must stop immediately: a graceful interrupt lets the run
    // keep saving the session (its finally block rewrites the JSON file), which
    // made deletions reappear. forceStop marks the run orphaned so its late
    // events and saves are ignored; the session store also tombstones the id as a
    // second line of defence.
    if (this.runs.has(id)) this.forceStop(id)
    // V-01: child sessions are hidden from list(), so they must be removed here
    // or they would leak on disk for ever.
    try {
      for (const child of this.store.list({ includeSubagents: true })) {
        if (child.parentId === id) {
          if (this.runs.has(child.id)) this.forceStop(child.id)
          this.store.remove(child.id)
          this.trail.remove(child.id)
        }
      }
    } catch {}
    this.store.remove(id)
    snapshots.remove(this.home, id)
    this.trail.remove(id)
  }
  switchModel(id, profile) {
    profiles.getProfile(profile, this.home)
    const s = this.store.get(id)
    s.profile = profile
    s.usage.lastInput = 0
    this.store.save(s)
    return s
  }
  /**
   * Drop the failed turn: remove the user message (messageID = "msg-<index>" from
   * the history) plus everything after it, so a retry can resend without duplicating.
   */
  revertSession(id, messageID) {
    if (this.runs.has(id)) throw new Error("Session is busy - stop the current run first.")
    const s = this.store.get(id)
    const i = Number(/^(?:msg|cmp)-(\d+)$/.exec(String(messageID || ""))?.[1])
    if (!Number.isInteger(i) || i < 0 || i >= s.messages.length) throw new Error("This message is no longer in the session.")
    if (s.messages[i].role !== "user") throw new Error("Can only revert to a user message.")
    s.messages = s.messages.slice(0, i)
    s.updatedAt = Date.now()
    this.store.save(s)
    snapshots.clearRedo(this.home, id)
    return s
  }

  /**
   * Undo the agent's FILE changes. By messageID ("msg-<index>" of a user message)
   * or, with no messageID, the most recent turn that changed files. Restores the
   * original content (deleting files the agent created) and also drops the
   * conversation from that user message on, like revertSession.
   * Shell side effects (sed -i, formatters, git) are not captured.
   */
  undoSession(id, messageID) {
    if (this.runs.has(id)) throw new Error("Session is busy - stop the current run first.")
    const s = this.store.get(id)
    let turn = null
    let cut = -1
    if (messageID) {
      const i = Number(/^(?:msg|cmp)-(\d+)$/.exec(String(messageID))?.[1])
      if (!Number.isInteger(i) || i < 0 || i >= s.messages.length || s.messages[i].role !== "user") throw new Error("Pick a user message to undo from.")
      turn = s.messages[i].turn
      if (!Number.isInteger(turn)) throw new Error("This message has no file snapshot (it predates undo support).")
      cut = i
    } else {
      const snaps = snapshots.list(this.home, id)
      if (!snaps.length) throw new Error("Nothing to undo: the agent has not changed any files in this session.")
      turn = snaps[0].turn
      cut = s.messages.findIndex((m) => m.role === "user" && m.turn === turn)
    }
    const droppedMessages = cut >= 0 ? s.messages.slice(cut) : []
    const result = snapshots.undo(this.home, id, turn)
    let dropped = 0
    if (cut >= 0) {
      dropped = s.messages.length - cut
      s.messages = s.messages.slice(0, cut)
      s.updatedAt = Date.now()
      this.store.save(s)
    }
    snapshots.attachRedo(this.home, id, result.redoId, { messageIndex: cut, messages: droppedMessages })
    return { ...result, messagesDropped: dropped }
  }
  listSnapshots(id) {
    return snapshots.list(this.home, id)
  }
  listStepSnapshots(id) {
    return snapshots.listSteps(this.home, id)
  }
  previewSnapshot(id, options) {
    this.store.get(id) // validate session ownership/existence first
    return snapshots.preview(this.home, id, options)
  }
  listRedo(id) {
    this.store.get(id)
    return snapshots.listRedo(this.home, id)
  }
  undoStepSession(id, turn, step) {
    if (this.runs.has(id)) throw new Error("Session is busy - stop the current run first.")
    const s = this.store.get(id)
    const selectedTurn = Number(turn)
    const selectedStep = Number(step)
    if (!Number.isInteger(selectedTurn) || !Number.isInteger(selectedStep) || selectedStep < 1) throw new Error("Choose a valid turn and step to rewind.")
    const start = s.messages.findIndex((message) => message.role === "user" && message.turn === selectedTurn)
    let cut = -1
    if (start >= 0) cut = s.messages.findIndex((message, index) => index > start && Number(message.step) >= selectedStep)
    const droppedMessages = cut >= 0 ? s.messages.slice(cut) : []
    const result = snapshots.undoStep(this.home, id, selectedTurn, selectedStep)
    if (!result.steps.length) throw new Error("Nothing to rewind for that step.")
    if (cut >= 0) {
      s.messages = s.messages.slice(0, cut)
      s.updatedAt = Date.now()
      this.store.save(s)
    }
    snapshots.attachRedo(this.home, id, result.redoId, { messageIndex: cut, messages: droppedMessages })
    return { ...result, messagesDropped: droppedMessages.length }
  }
  redoSession(id) {
    if (this.runs.has(id)) throw new Error("Session is busy - stop the current run first.")
    const s = this.store.get(id)
    const pending = snapshots.peekRedo(this.home, id)
    if (!pending) throw new Error("Nothing to redo.")
    const index = Number(pending.meta?.messageIndex)
    if (Number.isInteger(index) && index >= 0 && s.messages.length !== index) {
      throw new Error("Cannot redo because the session history changed after rewind.")
    }
    const result = snapshots.redo(this.home, id)
    const messages = Array.isArray(result.meta?.messages) ? result.meta.messages : []
    if (Number.isInteger(index) && index >= 0 && messages.length) s.messages.splice(index, 0, ...messages)
    if (messages.length) {
      s.updatedAt = Date.now()
      this.store.save(s)
    }
    const { meta, ...publicResult } = result
    return { ...publicResult, messagesRestored: messages.length }
  }

  // ---- permissions ----
  /**
   * `inherits` lets a child run (subagent) keep the parent session's approvals:
   * rules are matched against engine rules + inherited rules + own rules, while
   * a new "always" approval is still stored on `session` (the run that asked).
   */
  _ask(session, signal, emit, inherits = null, agentRules = []) {
    return (perm) => {
      const tool = String(perm?.tool ?? "")
      // V-10: asking the user a question is itself the interaction; a
      // permission prompt on top of it would be a second, pointless click.
      if (tool === "question") return true
      const subject = perm?.subject == null ? "" : perm.subject
      const neverPersist = !!perm?.neverPersist
      // Hard locks are checked before every other rule. They are not a prompt
      // and cannot be lifted by a saved "always allow" approval.
      const locks = loadLocks({ home: this.home, dir: session && session.dir })
      if (isLocked(locks, tool, subject)) {
        const event = { type: "permission.lock", tool, subject: String(subject) }
        if (perm && typeof perm === "object") perm.locked = true
        if (typeof emit === "function") emit(event)
        else this._emit(session && session.id, event)
        return false
      }
      // V-07: an agent definition's rules sit last, so a "deny" in a read-only
      // agent cannot be overridden by an older "always allow" approval.
      const layers = combineRules({
        project: this.rules,
        inherited: inherits?.rules || [],
        session: session.rules || [],
        agent: Array.isArray(agentRules) ? agentRules : [],
      })
      const { action, source } = decideWithSource(layers, tool, subject)
      // Durable audit: which layer decided, without leaking the subject value.
      this.trail.append(session && session.id, {
        type: "permission.decision",
        tool,
        subject: String(subject),
        action,
        source,
      })
      if (action === "allow") return true
      if (action === "deny") return false
      if (this.permissionMode === "allow") return true
      if (this.permissionMode === "deny") return false
      if (signal.aborted) return false // the run was stopped: never wait for an answer nobody can give
      const permissionId = newId("perm")
      return new Promise((resolve) => {
        this.pending.set(permissionId, { resolve, session, inherits, tool, subject, neverPersist })
        signal.addEventListener("abort", () => this.replyPermission(permissionId, "deny"), { once: true })
        emit({ type: "permission.ask", permissionId, tool, subject })
      })
    }
  }
  /** decision: "once" | "always" | "deny" */
  replyPermission(permissionId, decision) {
    const p = this.pending.get(permissionId)
    if (!p) return false
    this.pending.delete(permissionId)
    if (decision === "always" && !p.neverPersist) {
      // V-04: tools that declare neverPersist (e.g. browser.evaluate runs
      // arbitrary JS in the user's page) never save an "always" allow rule.
      const exact = !["edit", "write"].includes(p.tool)
      p.session.rules.push({ tool: p.tool, pattern: exact ? p.subject : "*", exact, action: "allow" })
      this.store.save(p.session)
    }
    p.resolve(decision !== "deny")
    return true
  }

  // ---- V-10: interactive questions (the `question` tool) ----
  /**
   * Ask the user one or more questions and wait for the answer. Resolves with
   * an ordered `answers` array (string[] per question) or `null` when the user
   * dismissed the form or the run was stopped.
   */
  askQuestions({ session, questions, signal, emit }) {
    const normalized = forms.normalizeQuestions(questions)
    const id = newId("form")
    const form = forms.formPayload(session.id, id, normalized)
    const send = typeof emit === "function" ? emit : (ev) => this._emit(session.id, ev)
    return new Promise((resolve) => {
      const entry = { id, sessionID: session.id, questions: normalized, form, resolve, emit: send, cleanup: null }
      this.forms.set(id, entry)
      const onAbort = () => {
        if (!this.forms.delete(id)) return
        send({ type: "question.cancelled", form, message: "The run was stopped." })
        resolve(null)
      }
      entry.cleanup = () => {
        try {
          signal?.removeEventListener?.("abort", onAbort)
        } catch {}
      }
      if (signal) {
        if (signal.aborted) return onAbort()
        signal.addEventListener("abort", onAbort, { once: true })
      }
      send({ type: "question.ask", form })
    })
  }
  /** Pending questions, newest last. Omit sessionID to list every session. */
  listForms(sessionID) {
    return [...this.forms.values()]
      .filter((entry) => !sessionID || entry.sessionID === sessionID)
      .map((entry) => entry.form)
  }
  /** Answer a pending form. Returns false when it is no longer pending. */
  replyForm(formID, answer) {
    const entry = this.forms.get(formID)
    if (!entry) return false
    this.forms.delete(formID)
    entry.cleanup?.()
    const answers = forms.answerValues(entry.questions, answer)
    entry.emit({ type: "question.replied", form: entry.form, answers })
    entry.resolve(answers)
    return true
  }
  /** Dismiss a pending form (the agent continues without an answer). */
  cancelForm(formID, message = "User dismissed the question") {
    const entry = this.forms.get(formID)
    if (!entry) return false
    this.forms.delete(formID)
    entry.cleanup?.()
    entry.emit({ type: "question.cancelled", form: entry.form, message })
    entry.resolve(null)
    return true
  }

  // ---- running ----
  interrupt(id) {
    const c = this.runs.get(id)
    if (!c) return
    c.abort()
    // Safety net: a run that is stuck somewhere that cannot be aborted (a hung
    // child process, a dead socket, ...) must never keep the session "busy"
    // for ever - that is what produced "The previous run could not be stopped".
    if (!c.killTimer) {
      c.killTimer = setTimeout(() => {
        if (this.runs.get(id) === c) this.forceStop(id)
      }, 5000)
      if (c.killTimer.unref) c.killTimer.unref()
    }
  }
  /**
   * Release a session whose run did not stop after abort(): the old run is
   * marked orphaned (its late events / writes are ignored), listeners get a
   * normal "interrupted" ending and the session is free for the next prompt.
   */
  forceStop(id) {
    const c = this.runs.get(id)
    if (!c) return false
    try {
      c.abort()
    } catch {}
    for (const [pid, p] of [...this.pending]) if (p.session && p.session.id === id) this.replyPermission(pid, "deny")
    // V-10: a dead run must not leave an answerable question card behind.
    for (const form of [...this.forms.values()]) if (form.sessionID === id) this.cancelForm(form.id, "The run was stopped.")
    this._emit(id, { type: "done", reason: "interrupted" })
    c.orphaned = true
    if (c.killTimer) clearTimeout(c.killTimer)
    this.runs.delete(id)
    if (c.kick) c.kick()
    return true
  }
  /** Stop the current run (if any) and resolve once the session is free. Always frees it. */
  async stop(id, graceMs = 4000) {
    if (!this.runs.has(id)) return true
    this.interrupt(id)
    const until = Date.now() + graceMs
    while (this.runs.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
    if (this.runs.has(id)) this.forceStop(id)
    return !this.runs.has(id)
  }
  /** Wait (bounded, abortable) for MCP servers that are still connecting. */
  _waitMcp(signal, ms = 4000) {
    const p = this._mcpSync
    if (!p) return Promise.resolve()
    return new Promise((resolve) => {
      let t = null
      const done = () => {
        clearTimeout(t)
        if (signal) signal.removeEventListener("abort", done)
        resolve()
      }
      t = setTimeout(done, ms)
      if (signal) {
        if (signal.aborted) return done()
        signal.addEventListener("abort", done, { once: true })
      }
      p.then(done, done)
    })
  }
  isBusy(id) {
    return this.runs.has(id)
  }

  /* ---- shell jobs (background commands) ---- */
  /** All shell jobs of a session (running + recently finished). */
  listShells(id) {
    return jobs.list(id)
  }
  shellOutput(shellID, max) {
    return jobs.output(shellID, max)
  }
  /** Send stdin to one running shell. The session boundary is always enforced. */
  shellInput(id, shellID, text, options) {
    const job = jobs.get(shellID)
    if (!job) throw new Error("This shell no longer exists.")
    if (job.sessionID && id && job.sessionID !== id) throw new Error("This shell belongs to another session.")
    return jobs.input(shellID, text, options)
  }
  /** Ctrl+B: move every blocking shell command of this session to the background. */
  backgroundSession(id) {
    const moved = jobs.backgroundSession(id)
    for (const shell of moved) this._emit(id, { type: "shell.backgrounded", shell })
    return moved
  }
  /** Move one running shell command to the background. */
  backgroundShell(id, shellID) {
    const job = jobs.background(shellID)
    if (!job) throw new Error("This shell is no longer running.")
    if (job.sessionID && id && job.sessionID !== id) throw new Error("This shell belongs to another session.")
    this._emit(id, { type: "shell.backgrounded", shell: job })
    return job
  }
  /** Stop one background shell (and its child tree) without stopping the run. */
  cancelShell(id, shellID) {
    const job = jobs.get(shellID)
    if (!job) throw new Error("This shell is no longer running.")
    if (job.sessionID && id && job.sessionID !== id) throw new Error("This shell belongs to another session.")
    return jobs.cancel(shellID)
  }
  /**
   * Post a synthetic message into the conversation (a finished background job,
   * a moved-to-background notice, ...). It is stored as a user message so the
   * next model request sees it and can continue from there.
   */
  notice(id, text) {
    const session = this.store.get(id)
    const body = String(text)
    const last = session.messages[session.messages.length - 1]
    // Anthropic wants alternating roles: a notice that lands right after tool
    // results rides on that same user turn instead of opening a second one.
    // Only a tool-result turn is merged into - never a real user bubble, so the
    // notice text can never contaminate a message the user sent.
    // Every notice part is marked agentOnly: the model sees it, the chat UI hides it.
    const toolTurn = last && last.role === "user" && Array.isArray(last.parts) && !last.agentOnly && last.parts.some((p) => p.type === "tool_result")
    if (toolTurn) last.parts.push({ type: "text", text: body, agentOnly: true })
    else session.messages.push({ role: "user", parts: [{ type: "text", text: body, agentOnly: true }] })
    this.store.save(session)
    this._emit(id, { type: "notice", text: body })
    return session
  }

  _takeSubagentResultParts(session) {
    const legacy = Array.isArray(session.pendingSubagentResults) ? session.pendingSubagentResults : []
    const completed = this.subagents && typeof this.subagents.takeResults === "function" ? this.subagents.takeResults(session.id) : []
    const pending = [...legacy, ...completed]
    if (!pending.length) return []
    session.pendingSubagentResults = []
    return pending.map((item) => ({
      type: "text",
      agentOnly: true,
      subagentResultId: item.id,
      text: item.status === "done"
        ? `[Subagent completed: ${item.name} (${item.id})]\n${item.result || "(no text produced)"}`
        : `[Subagent failed: ${item.name} (${item.id})]\n${item.error || "Unknown error"}`,
    }))
  }

  /** Send a prompt; async-iterate the events. Breaking out of the loop interrupts the run. */
  async *prompt(id, text, opts = {}) {
    if (this.runs.has(id)) throw new Error("Session is busy")
    const session = this.store.get(id)
    const recipe = !opts.agentOnly ? recipes.expandRecipe(text, { directory: session.dir, home: this.home }) : null
    const runOpts = recipe ? {
      ...opts,
      recipeId: recipe.id,
      recipeAgent: recipe.agent || "",
      recipeModel: recipe.model || "",
    } : opts
    const profile = profiles.getProfile(session.profile, this.home)
    const apiKey = profiles.getKey(profile, this.home)
    const ctl = this._begin(id, opts)
    try {
      repairHistory(session.messages)
      // agentOnly prompts (the automatic background-run nudge) reach the model
      // but are not shown as a chat bubble.
      const parts = opts.agentOnly ? [{ type: "text", text: String(text), agentOnly: true }] : [{ type: "text", text: String(text) }]
      if (recipe) parts.push({ type: "text", text: recipe.text, agentOnly: true, recipe: recipe.id })
      parts.unshift(...this._takeSubagentResultParts(session))
      // image files arrive as { mime, data } (base64) and become canonical image parts
      for (const f of Array.isArray(opts.files) ? opts.files : []) {
        if (f && f.data && String(f.mime || "").startsWith("image/")) parts.push({ type: "image", mime: f.mime, data: f.data })
      }
      // every real user prompt starts a new "turn"; file snapshots are keyed by it
      if (!opts.agentOnly) session.turnSeq = (session.turnSeq || 0) + 1
      session.messages.push({
        role: "user",
        parts,
        ...(opts.agentOnly ? {} : { turn: session.turnSeq }),
        ...(recipe ? { recipe: { id: recipe.id, agent: recipe.agent || "", model: recipe.model || "" } } : {}),
      })
      if (session.title === "New session") session.title = String(text).replace(/\s+/g, " ").trim().slice(0, 60) || session.title
      this.store.save(session)
      if (!opts.agentOnly) snapshots.clearRedo(this.home, id)
    } catch (e) {
      // a failed save (Windows file lock, full disk...) used to leave the run
      // registered for ever -> every later message said "previous run could not be stopped"
      if (this.runs.get(id) === ctl) this.runs.delete(id)
      throw e
    }

    yield* this._drive(session, profile, apiKey, ctl, runOpts)
  }

  /**
   * Continue a failed/interrupted turn from the exact point it stopped - no new
   * user message is appended. Tool calls that already completed (and the file
   * edits they made) stay in the history, so a retry after a provider timeout
   * does not redo or lose the work the agent already finished.
   */
  async *resume(id, opts = {}) {
    if (this.runs.has(id)) throw new Error("Session is busy")
    const session = this.store.get(id)
    const profile = profiles.getProfile(session.profile, this.home)
    const apiKey = profiles.getKey(profile, this.home)
    repairHistory(session.messages)
    const subagentParts = this._takeSubagentResultParts(session)
    if (subagentParts.length) {
      const last = session.messages[session.messages.length - 1]
      if (last?.role === "user" && (last.parts || []).some((part) => part.type === "tool_result")) last.parts.push(...subagentParts)
      else session.messages.push({ role: "user", parts: subagentParts })
    }
    if (!session.messages.length) throw new Error("Nothing to resume - this session has no messages yet.")
    this.store.save(session) // persist the repaired history (interrupted tool calls get error results)
    const lastUser = [...session.messages].reverse().find((message) => message?.role === "user" && (message.parts || []).some((part) => part?.type === "text" && !part.agentOnly))
    const lastRecipe = lastUser?.recipe
    const runOpts = lastRecipe ? {
      ...opts,
      recipeId: opts.recipeId || lastRecipe.id || "",
      recipeAgent: opts.recipeAgent || lastRecipe.agent || "",
      recipeModel: opts.recipeModel || lastRecipe.model || "",
    } : opts
    const ctl = this._begin(id, runOpts)
    yield* this._drive(session, profile, apiKey, ctl, runOpts)
  }

  /** Resolve either a profile id or an exact profile/model key for one run. */
  _profileTarget(target) {
    const value = String(target || "").trim()
    try { return profiles.getProfile(value, this.home) } catch (exactError) {
      const slash = value.indexOf("/")
      if (slash <= 0 || slash === value.length - 1) throw exactError
      const profileID = value.slice(0, slash)
      const modelID = value.slice(slash + 1)
      const base = profiles.getProfile(profileID, this.home)
      const rows = Array.isArray(base.models) ? base.models : []
      const row = rows.find((item) => item && String(item.id) === modelID)
      if (!row && String(base.model || "") !== modelID) throw new Error(`Model "${modelID}" is not configured for profile "${profileID}".`)
      return {
        ...base,
        model: modelID,
        ...(Number(row?.context) > 0 ? { contextLimit: Number(row.context) } : {}),
        ...(Number(row?.output) > 0 ? { maxOutput: Number(row.output) } : {}),
        ...(row && Object.prototype.hasOwnProperty.call(row, "image") ? { image: !!row.image } : {}),
      }
    }
  }

  /**
   * V-20: resolve the optional dedicated summary profile from config.json.
   * `profile: null` means "use the session model". A broken profile id must
   * never stop compaction - it falls back and reports a warning.
   */
  _summaryTarget(cfg) {
    const target = cfg && cfg.model ? String(cfg.model).trim() : ""
    if (!target) return { profile: null, apiKey: "", warning: "" }
    try {
      let profile
      let modelKey = ""
      try {
        // Backward compatible: a plain profile id keeps using that profile's
        // selected model.
        profile = profiles.getProfile(target, this.home)
        modelKey = `${profile.id}/${profile.model}`
      } catch (exactError) {
        // The desktop picker stores an exact provider/model key. Model ids may
        // contain slashes, so only the first segment is the profile id.
        const slash = target.indexOf("/")
        if (slash <= 0 || slash === target.length - 1) throw exactError
        const profileID = target.slice(0, slash)
        const modelID = target.slice(slash + 1)
        const base = profiles.getProfile(profileID, this.home)
        const rows = Array.isArray(base.models) ? base.models : []
        const row = rows.find((item) => item && String(item.id) === modelID)
        if (!row && String(base.model || "") !== modelID) {
          throw new Error(`Model "${modelID}" is not configured for profile "${profileID}".`)
        }
        profile = {
          ...base,
          model: modelID,
          ...(Number(row?.context) > 0 ? { contextLimit: Number(row.context) } : {}),
          ...(Number(row?.output) > 0 ? { maxOutput: Number(row.output) } : {}),
          ...(row && Object.prototype.hasOwnProperty.call(row, "image") ? { image: !!row.image } : {}),
        }
        modelKey = `${profileID}/${modelID}`
      }
      profile = { ...profile, summaryModelKey: modelKey }
      return { profile, apiKey: profiles.getKey(profile, this.home), warning: "" }
    } catch (e) {
      return {
        profile: null,
        apiKey: "",
        warning: `Compaction summary model "${target}" is unavailable (${e.message}); using the session model.`,
      }
    }
  }

  getCompactionConfig() {
    return config.compactionConfig(this.home)
  }

  setCompactionConfig(patch = {}) {
    return config.updateCompaction(this.home, patch)
  }

  /** V-19: archive callback shared by runLoop and manual compaction. */
  _archiveFor(session) {
    return (entry) => compaction.writeArchive(this.store.dir, session.id, entry)
  }

  _begin(id, opts) {
    const ctl = new AbortController()
    if (opts.signal) opts.signal.addEventListener("abort", () => ctl.abort(), { once: true })
    this.runs.set(id, ctl)
    return ctl
  }

  /** Shared driver for prompt()/resume(): runs the agent loop and yields its events. */
  async *_drive(session, profile, apiKey, ctl, opts = {}) {
    const id = session.id
    const queue = []
    let wake = null
    let finished = false
    const kick = () => {
      if (wake) {
        const w = wake
        wake = null
        w()
      }
    }
    ctl.kick = kick
    const emit = (ev) => {
      if (ctl.orphaned) return // force-stopped run: its late events must not reach the next run's UI
      queue.push(this._emit(id, ev))
      kick()
    }
    if (opts.recipeId) emit({ type: "recipe.start", id: opts.recipeId, agent: opts.recipeAgent || "", model: opts.recipeModel || "" })

    // V-18/V-20: read the compaction block once per run so a config edit takes
    // effect on the next prompt without restarting the app.
    const compactionConfig = config.compactionConfig(this.home)

    // V-07: resolve the session's agent definition (prompt, steps, permissions,
    // optional model override). A missing definition falls back to the default.
    const requestedAgent = opts.recipeAgent || session.agent || ""
    const agent = requestedAgent ? this.getAgent(requestedAgent, session.dir) : null
    if (requestedAgent && !agent) emit({ type: "notice", text: `Agent "${requestedAgent}" is unavailable; using the default agent.` })
    let runProfile = profile
    let runApiKey = apiKey
    const modelTarget = opts.recipeModel || agent?.model || ""
    if (modelTarget) {
      try {
        runProfile = this._profileTarget(modelTarget)
        runApiKey = profiles.getKey(runProfile, this.home)
      } catch (e) {
        emit({ type: "notice", text: `Run model "${modelTarget}" is unavailable (${e.message}); using ${session.profile}.` })
      }
    }
    // Desktop ChatComposer explicitly requests the active run model for both
    // manual and automatic summaries. CLI/SDK callers can still opt into the
    // advanced config.model override by omitting `summaryModel: "session"`.
    const summary = opts.summaryModel === "session"
      ? { profile: null, apiKey: "", warning: "" }
      : this._summaryTarget(compactionConfig)
    if (summary.warning) emit({ type: "notice", text: summary.warning })

    const done = runLoop({
      session,
      store: this.store,
      profile: runProfile,
      apiKey: runApiKey,
      emit,
      signal: ctl.signal,
      askPermission: this._ask(session, ctl.signal, emit, null, agent?.rules || []),
      agentName: this.agentName,
      agent,
      extraSystem: this.extraSystem,
      maxSteps: opts.maxSteps || agent?.steps || undefined,
      extraTools: () => this.extraTools(session.dir),
      waitExtraTools: (sig) => this._waitMcp(sig || ctl.signal),
      isOrphan: () => !!ctl.orphaned,
      engine: this,
      compactionConfig,
      summaryProfile: summary.profile,
      summaryApiKey: summary.apiKey,
      summaryWarning: summary.warning,
    })
      .catch((e) => {
        emit({
          type: "error",
          message: (e && e.message) || String(e),
          ...(e && e.code ? { code: e.code } : {}),
          ...(e && e.retryable === false ? { retryable: false } : {}),
        })
        emit({ type: "done", reason: "error" })
      })
      .finally(() => {
        finished = true
        if (!ctl.orphaned) {
          try {
            this.store.save(session)
          } catch {}
        }
        kick()
      })

    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift()
          continue
        }
        if (finished || ctl.orphaned) break
        await new Promise((r) => (wake = r))
      }
    } finally {
      if (!finished) ctl.abort()
      if (!ctl.orphaned) await done
      if (ctl.killTimer) clearTimeout(ctl.killTimer)
      if (this.runs.get(id) === ctl) this.runs.delete(id)
    }
  }

  /** Create a subagent inside a session. Returns { id, status }. */
  createSubagent({ sessionId, name, type = "general", agent, task, maxSteps, background = true } = {}) {
    return this.subagents.create({ sessionId, name, type, agent, task, maxSteps, background })
  }
  /** All subagents (optionally scoped to one session). */
  listSubagents(sessionId) {
    return this.subagents.list(sessionId)
  }
  async listConnectorResources(connector, directory) {
    if (directory) await this.mcp.sync(directory)
    return this.mcp.resources(connector)
  }
  async listConnectorResourceTemplates(connector, directory) {
    if (directory) await this.mcp.sync(directory)
    return this.mcp.resourceTemplates(connector)
  }
  async readConnectorResource(connector, uri, directory) {
    if (directory) await this.mcp.sync(directory)
    return this.mcp.readResource(connector, uri)
  }
  beginConnectorOAuth(connector, redirectUri, directory) {
    return this.mcp.beginOAuth(connector, { redirectUri, directory })
  }
  completeConnectorOAuth(state, code) {
    return this.mcp.completeOAuth({ state, code })
  }
  clearConnectorOAuth(connector, directory) {
    return this.mcp.clearOAuth(connector, directory)
  }
  /** Subagent status + error. */
  subagentStatus(id) {
    return this.subagents.status(id)
  }
  /** Subagent final result once done. */
  subagentResult(id) {
    return this.subagents.result(id)
  }
  subagentDetails(id) {
    return this.subagents.details(id)
  }
  resumeSubagent(id, text, opts) {
    return this.subagents.resume(id, text, opts)
  }
  /** Abort a running subagent. */
  stopSubagent(id) {
    return this.subagents.stop(id)
  }

  // ---- browser (Electron only) ----
  // Browser tools operate the visible renderer <webview> dock, not hidden windows.
  _browserManager() {
    if (this._browser) return this._browser
    let BrowserManager
    try { BrowserManager = require("../electron/browser").BrowserManager } catch { return null }
    if (!BrowserManager) return null
    this._browser = new BrowserManager()
    return this._browser
  }
  _noBrowser() {
    return { ok: false, error: "No browser available: browser tools only work in the Electron app." }
  }
  async browserListTabs() {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { return { ok: true, data: { tabs: await bm.listTabs() } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserCreateTab({ url } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const tab = await bm.createTab({ url }); return { ok: true, data: { tabID: tab.id, url: tab.url, title: tab.title || "", active: tab.active !== false } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserCloseTab({ tabID } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { await bm.closeTab(tabID); return { ok: true } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserNavigate({ tabID, url } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { await bm.navigate(tabID, url); return { ok: true } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserCurrent({ depth = 8 } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try {
      const tab = await bm.currentTab()
      const snapshot = await bm.snapshot(tab.id, { depth })
      const latest = bm.tabs && bm.tabs.get(String(tab.id))
      return { ok: true, data: { tabID: tab.id, url: latest?.url || tab.url, title: latest?.title || tab.title, active: true, snapshot } }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserScreenshot({ tabID, fullPage = false } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try {
      const shot = typeof bm.captureScreenshot === "function"
        ? await bm.captureScreenshot(tabID, { fullPage })
        : { buffer: await bm.screenshot(tabID, { fullPage }), tabID: String(tabID || ""), url: "", title: "", mime: "image/png" }
      return { ok: true, data: { data: shot.buffer.toString("base64"), mime: shot.mime || "image/png", tabID: shot.tabID, url: shot.url, title: shot.title } }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserEvaluate({ tabID, script } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const result = await bm.evaluate(tabID, script); return { ok: true, data: { result } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserWait({ tabID, selector, text, networkIdle = false, timeoutMs } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try {
      const result = await bm.wait(tabID, { selector, text, networkIdle, timeoutMs })
      return { ok: true, data: result }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserSnapshot({ tabID, depth = 8 } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try {
      const snapshot = await bm.snapshot(tabID, { depth })
      const tab = bm.tabs && (tabID ? bm.tabs.get(String(tabID)) : [...(bm.tabs || new Map()).values()].find((t) => t.active))
      return { ok: true, data: { snapshot, generation: tab?.generation || 0, refCount: (tab?.refs && tab.refs.size) || 0 } }
    } catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserClick({ tabID, ref, generation } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const result = await bm.click(tabID, ref, generation); return { ok: true, data: { result } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserFill({ tabID, ref, text, generation } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const result = await bm.fill(tabID, ref, text, generation); return { ok: true, data: { result } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserPress({ tabID, key } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const result = await bm.press(tabID, key); return { ok: true, data: { result } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }
  async browserScroll({ tabID, deltaY } = {}) {
    const bm = this._browserManager()
    if (!bm) return this._noBrowser()
    try { const result = await bm.scroll(tabID, deltaY); return { ok: true, data: { result } } }
    catch (e) { return { ok: false, error: String(e?.message || e) } }
  }

  // ---- todos (the agent's plan, persisted on the session) ----
  todoList(id) {
    const s = this.store.get(id)
    return { items: Array.isArray(s.todos) ? s.todos : [] }
  }
  todoSave(id, { items } = {}) {
    const s = this.store.get(id)
    s.todos = Array.isArray(items) ? items : []
    this.store.save(s)
    return { items: s.todos }
  }

  /** Explicit compaction. Returns {before, after, summarized}. */
  async compact(id, opts = {}) {
    if (this.runs.has(id)) throw new Error("Session is busy")
    const session = this.store.get(id)
    const profile = profiles.getProfile(session.profile, this.home)
    const apiKey = profiles.getKey(profile, this.home)
    const ctl = new AbortController()
    this.runs.set(id, ctl)
    const reason = opts.reason === "auto" ? "auto" : "manual"
    try {
      const toolSpecs = tools.specs([...tools.ALL, ...this.extraTools(session.dir)])
      const system = buildSystem({ agentName: this.agentName, cwd: session.dir, model: profile.model, extra: this.extraSystem })
      const compactionConfig = config.compactionConfig(this.home)
      const summary = opts.summaryModel === "session"
        ? { profile: null, apiKey: "", warning: "" }
        : this._summaryTarget(compactionConfig)
      const summaryModel = summary.profile
        ? summary.profile.summaryModelKey || summary.profile.id || summary.profile.model || "custom"
        : (profile?.id && profile?.model ? `${profile.id}/${profile.model}` : session.profile)
      this._emit(id, { type: "compaction.start", reason, summaryModel })
      if (summary.warning) this._emit(id, { type: "notice", text: summary.warning })
      const r = await compaction.compact({
        session,
        profile,
        apiKey,
        signal: opts.signal || ctl.signal,
        reason,
        system,
        toolSpecs,
        config: compactionConfig,
        summaryProfile: summary.profile,
        summaryApiKey: summary.apiKey,
        summaryTimeoutMs: opts.summaryTimeoutMs,
        onSummaryDelta: (update) => this._emit(id, { type: "compaction.delta", reason, ...update }),
        archive: this._archiveFor(session),
      })
      if (summary.warning && r.committed && !r.warning) r.warning = summary.warning
      if (r.committed) this.store.save(session)
      this._emit(id, { type: "compaction.end", reason, ...r, summary: r.summary || "", text: r.summary || "" })
      return r
    } finally {
      this.runs.delete(id)
    }
  }
}

module.exports = { Engine }
