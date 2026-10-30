"use strict"
const fs = require("fs")
const path = require("path")
const { SessionStore } = require("./store/sessions")
const profiles = require("./llm/profiles")
const { DEFAULT_RULES, decide } = require("./perm/rules")
const { runLoop, repairHistory } = require("./agent/loop")
const compaction = require("./agent/compaction")
const { buildSystem } = require("./agent/prompt")
const tools = require("./tools")
const jobs = require("./jobs")
const { McpManager } = require("./mcp")
const { SubAgentManager } = require("./subagents")
const plugins = require("./plugins")
const { newId, homeDir } = require("./util")

class Engine {
  /**
   * @param {{home?:string, agentName?:string, permission?:"ask"|"allow"|"deny", rules?:Array, extraSystem?:string}} opts
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
    this.rules = [...DEFAULT_RULES, ...(Array.isArray(user) ? user : []), ...(opts.rules || [])]
    // async, ONE background PowerShell call total: upgrades pre-encryption
    // auth.json and warms the key cache - the UI hot path never spawns.
    profiles.migrateAuthKeys(this.home)
    this.listeners = new Set()
    this.pending = new Map()
    this.runs = new Map()
    this.mcp = new McpManager()
    this._mcpSync = null // in-flight connect promise (dedupe)
    this.subagents = new SubAgentManager(this)
    this.subagentsEnabled = opts.subagentsEnabled !== false // on by default
  }

  subagentTool() {
    return {
      name: "subagent",
      description:
        "Spawn a background subagent to do focused work (research, read files, write/edit, run commands, call MCP/plugin tools). " +
        "It runs independently and reports back when finished. Use it for long background tasks so the main chat keeps going.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["general", "web", "read", "write", "bash", "mcp", "plugin"],
            description: "Kind of subagent",
          },
          task: { type: "string", description: "What the subagent should accomplish" },
          name: { type: "string", description: "Optional name" },
          maxSteps: { type: "integer", description: "Max steps, default 25" },
        },
        required: ["type", "task"],
      },
      perm: () => ({ tool: "subagent", subject: "spawn" }),
      paths: () => [],
      run: async (a, c) => {
        const r = this.subagents.create({
          sessionId: c.session && c.session.id,
          name: a.name,
          type: a.type,
          task: a.task,
          maxSteps: a.maxSteps,
        })
        const id = r.id
        const name = a.name || a.type
        const parts = [
          `Subagent "${name}" started (id: ${id}). It runs in the background.`,
          "",
          r.notice ||
            `The subagent is working in the background (sessionID: ${id}). You will be notified automatically when it finishes. ` +
              "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; " +
              "avoid working with the same files or topics it is using. " +
              "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
          "",
          "When it finishes, use `subagentResult` (pass its id) to fetch the final output, then report it to the user.",
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
      pl = plugins.toolObjects(directory)
    } catch {}
    const ex = [...this.mcp.toolObjects(), ...pl]
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
    return full
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

  // ---- sessions ----
  createSession({ dir, profile, title } = {}) {
    profiles.getProfile(profile, this.home)
    return this.store.create({ dir, profile, title })
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
    this.interrupt(id)
    // V-01: child sessions are hidden from list(), so they must be removed here
    // or they would leak on disk for ever.
    try {
      for (const child of this.store.list({ includeSubagents: true })) {
        if (child.parentId === id) this.store.remove(child.id)
      }
    } catch {}
    this.store.remove(id)
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
    return s
  }

  // ---- permissions ----
  /**
   * `inherits` lets a child run (subagent) keep the parent session's approvals:
   * rules are matched against engine rules + inherited rules + own rules, while
   * a new "always" approval is still stored on `session` (the run that asked).
   */
  _ask(session, signal, emit, inherits = null) {
    return (perm) => {
      const tool = String(perm?.tool ?? "")
      const subject = perm?.subject == null ? "" : perm.subject
      const neverPersist = !!perm?.neverPersist
      const action = decide([...this.rules, ...(inherits?.rules || []), ...session.rules], tool, subject)
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

  /** Send a prompt; async-iterate the events. Breaking out of the loop interrupts the run. */
  async *prompt(id, text, opts = {}) {
    if (this.runs.has(id)) throw new Error("Session is busy")
    const session = this.store.get(id)
    const profile = profiles.getProfile(session.profile, this.home)
    const apiKey = profiles.getKey(profile, this.home)
    const ctl = this._begin(id, opts)
    try {
      repairHistory(session.messages)
      // agentOnly prompts (the automatic background-run nudge) reach the model
      // but are not shown as a chat bubble.
      const parts = opts.agentOnly ? [{ type: "text", text: String(text), agentOnly: true }] : [{ type: "text", text: String(text) }]
      // image files arrive as { mime, data } (base64) and become canonical image parts
      for (const f of Array.isArray(opts.files) ? opts.files : []) {
        if (f && f.data && String(f.mime || "").startsWith("image/")) parts.push({ type: "image", mime: f.mime, data: f.data })
      }
      session.messages.push({ role: "user", parts })
      if (session.title === "New session") session.title = String(text).replace(/\s+/g, " ").trim().slice(0, 60) || session.title
      this.store.save(session)
    } catch (e) {
      // a failed save (Windows file lock, full disk...) used to leave the run
      // registered for ever -> every later message said "previous run could not be stopped"
      if (this.runs.get(id) === ctl) this.runs.delete(id)
      throw e
    }

    yield* this._drive(session, profile, apiKey, ctl, opts)
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
    if (!session.messages.length) throw new Error("Nothing to resume - this session has no messages yet.")
    this.store.save(session) // persist the repaired history (interrupted tool calls get error results)
    const ctl = this._begin(id, opts)
    yield* this._drive(session, profile, apiKey, ctl, opts)
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

    const done = runLoop({
      session,
      store: this.store,
      profile,
      apiKey,
      emit,
      signal: ctl.signal,
      askPermission: this._ask(session, ctl.signal, emit),
      agentName: this.agentName,
      extraSystem: this.extraSystem,
      maxSteps: opts.maxSteps,
      extraTools: () => this.extraTools(session.dir),
      waitExtraTools: (sig) => this._waitMcp(sig || ctl.signal),
      isOrphan: () => !!ctl.orphaned,
      engine: this,
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
  createSubagent({ sessionId, name, type = "general", task, maxSteps } = {}) {
    return this.subagents.create({ sessionId, name, type, task, maxSteps })
  }
  /** All subagents (optionally scoped to one session). */
  listSubagents(sessionId) {
    return this.subagents.list(sessionId)
  }
  /** Subagent status + error. */
  subagentStatus(id) {
    return this.subagents.status(id)
  }
  /** Subagent final result once done. */
  subagentResult(id) {
    return this.subagents.result(id)
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

  /** Manual compaction. Returns {before, after, summarized}. */
  async compact(id, opts = {}) {
    if (this.runs.has(id)) throw new Error("Session is busy")
    const session = this.store.get(id)
    const profile = profiles.getProfile(session.profile, this.home)
    const apiKey = profiles.getKey(profile, this.home)
    const ctl = new AbortController()
    this.runs.set(id, ctl)
    try {
      this._emit(id, { type: "compaction.start", reason: "manual" })
      const toolSpecs = tools.specs([...tools.ALL, ...this.extraTools(session.dir)])
      const system = buildSystem({ agentName: this.agentName, cwd: session.dir, extra: this.extraSystem })
      const r = await compaction.compact({ session, profile, apiKey, signal: opts.signal || ctl.signal, reason: "manual", system, toolSpecs })
      if (r.committed) this.store.save(session)
      this._emit(id, { type: "compaction.end", reason: "manual", ...r, summary: r.summary || "", text: r.summary || "" })
      return r
    } finally {
      this.runs.delete(id)
    }
  }
}

module.exports = { Engine }
