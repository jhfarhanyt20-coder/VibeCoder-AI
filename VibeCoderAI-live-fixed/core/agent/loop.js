"use strict"
const llm = require("../llm")
const tools = require("../tools")
const compaction = require("./compaction")
const { buildSystem } = require("./prompt")
const { isInside } = require("../tools/fsutil")
const skills = require("../skills")
const { sleep } = require("../util")

/** If a run was interrupted, an assistant tool_call may have no result. Add error results so the history is valid. */
function repairHistory(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "assistant") continue
    const calls = m.parts.filter((p) => p.type === "tool_call")
    if (!calls.length) continue
    const next = messages[i + 1]
    const have = new Set(next && next.role === "user" ? next.parts.filter((p) => p.type === "tool_result").map((p) => p.id) : [])
    const missing = calls.filter((c) => !have.has(c.id))
    if (!missing.length) continue
    const fill = missing.map((c) => ({ type: "tool_result", id: c.id, name: c.name, output: "Interrupted before this tool finished.", isError: true }))
    if (next && next.role === "user" && next.parts.some((p) => p.type === "tool_result")) next.parts.unshift(...fill)
    else messages.splice(i + 1, 0, { role: "user", parts: fill })
  }
}

/**
 * A tool that ignores the abort signal (hung MCP call, plugin, network read)
 * must not keep the whole run - and so the session - busy. After an abort the
 * tool gets a short grace period to settle on its own (bash kills its child and
 * reports the output), then the call is given up with an error result.
 */
function abortable(p, signal, graceMs = 1500) {
  if (!signal) return p
  return new Promise((resolve, reject) => {
    let t = null
    const cleanup = () => {
      clearTimeout(t)
      signal.removeEventListener("abort", on)
    }
    const on = () => {
      t = setTimeout(() => reject(new Error("Interrupted by user.")), graceMs)
    }
    if (signal.aborted) on()
    else signal.addEventListener("abort", on, { once: true })
    Promise.resolve(p).then(
      (v) => (cleanup(), resolve(v)),
      (e) => (cleanup(), reject(e)),
    )
  })
}

/**
 * Names models habitually emit that mean one of our tools (OpenCode/Claude/GPT
 * trainings). Without this every such call died with `Unknown tool "shell"` and
 * it looked like "all the tools are broken".
 */
const TOOL_ALIASES = {
  shell: "bash",
  run: "bash",
  exec: "bash",
  execute: "bash",
  command: "bash",
  terminal: "bash",
  read_file: "read",
  list_files: "read",
  list_dir: "read",
  ls: "read",
  view: "read",
  write_file: "write",
  create_file: "write",
  save_file: "write",
  str_replace_editor: "edit",
  str_replace: "edit",
  edit_file: "edit",
  multi_edit: "edit",
  patch: "edit",
  search: "grep",
  search_files: "grep",
  code_search: "grep",
  find: "glob",
  find_files: "glob",
  todo_write: "todowrite",
  ask_user: "question",
  askuser: "question",
}
const resolveTool = (name) => tools.byName(name) || tools.byName(TOOL_ALIASES[String(name || "").toLowerCase()])

/**
 * V-05: split a shell command on its top-level separators (&&, ||, ;, |) while
 * ignoring quoted spans, so each sub-command is checked against the permission
 * rules on its own. This stops `echo ok && rm -rf /` from hiding behind the
 * harmless first segment.
 */
function splitCommand(cmd) {
  const out = []
  let cur = ""
  let q = null
  let i = 0
  const s = String(cmd || "")
  while (i < s.length) {
    const ch = s[i]
    if (q) {
      cur += ch
      if (ch === q && s[i - 1] !== "\\") q = null
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      q = ch
      cur += ch
      i++
      continue
    }
    if (ch === "\\") {
      cur += ch + (s[i + 1] || "")
      i += 2
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === "&&" || two === "||") {
      if (cur.trim()) out.push(cur.trim())
      cur = ""
      i += 2
      continue
    }
    if (ch === ";" || ch === "|") {
      if (cur.trim()) out.push(cur.trim())
      cur = ""
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out.length ? out : [s.trim()]
}

async function runLoop({ session, store, profile, apiKey, emit, signal, askPermission, agentName, agent = null, extraSystem, maxSteps = 100, extraTools = () => [], waitExtraTools = null, isOrphan = () => false, engine = null, compactionConfig = null, summaryProfile = null, summaryApiKey = "", summaryWarning = "" }) {
  // V-07: an agent definition can cap the run. An explicit maxSteps wins.
  if (agent && Number(agent.steps) > 0 && maxSteps === 100) maxSteps = Math.floor(Number(agent.steps))
  const agentSystem = agent && typeof agent.system === "string" ? agent.system.trim() : ""
  const recent = []
  let emptyRetries = 0 // consecutive empty model replies (retried before we call it an error)
  let overflowRetried = false
  // built-ins + MCP/plugin tools, refreshed each step (a server may connect mid-run)
  const allTools = () => [...tools.ALL, ...extraTools()]
  let toolSpecs = tools.specs(allTools())
  const resolve = (name) => allTools().find((t) => t.name === name) || allTools().find((t) => t.name === TOOL_ALIASES[String(name || "").toLowerCase()])
  const skillText = skills.systemText(session.dir)
  const sys = () => buildSystem({ agentName, cwd: session.dir, extra: [agentSystem, extraSystem, skillText].filter(Boolean).join("\n\n") })

  const doCompact = async (reason, targetTokens = 0) => {
    const summaryModel = summaryProfile
      ? summaryProfile.summaryModelKey || summaryProfile.id || summaryProfile.model || "custom"
      : (profile?.id && profile?.model ? `${profile.id}/${profile.model}` : (session.profile || ""))
    emit({ type: "compaction.start", reason, summaryModel })
    const system = sys()
    let result
    try {
      result = await compaction.compact({
        session,
        profile,
        apiKey,
        signal,
        reason,
        system,
        toolSpecs,
        targetTokens,
        config: compactionConfig,
        summaryProfile,
        summaryApiKey,
        onSummaryDelta: (update) => emit({ type: "compaction.delta", reason, ...update }),
        archive: (entry) => compaction.writeArchive(store.dir, session.id, entry),
      })
    } catch (error) {
      emit({ type: "compaction.end", reason, summarized: false, committed: false, fitsBudget: false, error: error?.message || String(error) })
      throw error
    }
    // Save a checkpoint only when the compactor actually committed it. A failed
    // compaction must not rewrite otherwise untouched history on disk.
    if (result.committed) store.save(session)
    // V-20: surface a broken summary-model id without blocking the checkpoint.
    if (summaryWarning && result.committed && !result.warning) result.warning = summaryWarning
    emit({
      type: "compaction.end",
      ...result,
      reason,
      // Both consumers exist in this app: the history card reads summary while
      // the older status-card handler used text.
      summary: result.summary || "",
      text: result.summary || "",
    })
    if (!result.summarized) {
      const error = new Error(`Context compaction failed: ${result.error || "No valid checkpoint was produced."}`)
      error.code = "CONTEXT_COMPACTION_FAILED"
      error.retryable = false
      throw error
    }
    if (result.fitsBudget === false) {
      const error = new Error(`Context compaction created a checkpoint but the request is still over budget. ${result.error || "Do not send another model request until context is reduced."}`)
      error.code = "CONTEXT_COMPACTION_OVER_BUDGET"
      error.retryable = false
      throw error
    }
    return result
  }

  let consecutiveGuardHits = 0 // identical-call guard trips; 2 = the model is stuck
  let stuck = false
  let finalized = false // V-06: true when the final step produced a closing summary
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return emit({ type: "done", reason: "interrupted" })
    // a still-connecting MCP server must not make its tools "Unknown" this step
    // (bounded + abortable: a hung server used to block the very first model
    // request AND make Stop/"send again" fail with "could not be stopped")
    if (waitExtraTools) await waitExtraTools(signal)
    if (signal.aborted) return emit({ type: "done", reason: "interrupted" })
    if (isOrphan()) return
    const system = sys()
    toolSpecs = tools.specs(allTools())

    // V-18: `compaction.auto: false` disables the pre-request checkpoint only.
    // Explicit /compact and overflow recovery still run.
    if (compactionConfig?.auto !== false && compaction.needsCompaction({ system, messages: session.messages, toolSpecs, lastInput: session.usage.lastInput, profile, config: compactionConfig })) await doCompact("auto")

    // V-06: on the final step we drop the tools and ask the model to write a
    // closing summary in plain text, instead of ending with a silent max_steps.
    const finalStep = step === maxSteps - 1
    const reqSystem = finalStep
      ? system + "\n\n# Final step\nYou are at the last step of this run. Do not call any tools. Write a concise closing summary of what you changed, what you verified, and what is still pending."
      : system
    const reqTools = finalStep ? [] : toolSpecs

    let text = ""
    const calls = []
    let finish = "stop"
    let sawReasoning = false
    let stepUsage = null // last usage event of THIS request -> stored on the message
    try {
      for await (const ev of llm.stream(profile, { apiKey, system: reqSystem, messages: session.messages, tools: reqTools, signal })) {
        if (ev.type === "text") {
          text += ev.delta
          emit({ type: "text.delta", delta: ev.delta })
        } else if (ev.type === "reasoning") {
          sawReasoning = true
          emit({ type: "reasoning.delta", delta: ev.delta })
        }
        else if (ev.type === "tool_call") calls.push(ev)
        else if (ev.type === "usage") {
          stepUsage = { input: ev.input || 0, output: ev.output || 0 }
          if (ev.input) session.usage.lastInput = ev.input
          session.usage.totalInput += ev.input || 0
          session.usage.totalOutput += ev.output || 0
          emit({ type: "usage", input: ev.input, output: ev.output })
        } else if (ev.type === "finish") finish = ev.reason
      }
    } catch (e) {
      if (signal.aborted) {
        if (text) session.messages.push({ role: "assistant", parts: [{ type: "text", text }] })
        store.save(session)
        return emit({ type: "done", reason: "interrupted" })
      }
      const inputBudget = Number(e.inputTokenBudget) || 0
      if ((e.overflow || inputBudget > 0) && !overflowRetried) {
        overflowRetried = true
        await doCompact("overflow", inputBudget)
        step--
        continue
      }
      throw e
    }

    if (isOrphan()) return // this run was force-replaced while it was stuck: touch nothing
    const parts = []
    if (text.trim()) parts.push({ type: "text", text })
    // store the canonical tool name so history and the provider replay stay consistent with the specs
    for (const c of calls) parts.push({ type: "tool_call", id: c.id, name: (resolve(c.name) || { name: c.name }).name, args: c.args })
    if (!parts.length) {
      // The model answered with NOTHING (no text, no tool call). Ending the run
      // quietly made the chat look dead - "the LLM response never comes".
      // Reasoning that ate the whole output budget is a config problem (retrying
      // cannot help); a plain empty reply is retried twice, then reported.
      const budget = finish === "length" || finish === "max_tokens"
      if (!budget && emptyRetries < 2) {
        emptyRetries++
        await sleep(600 * emptyRetries, signal).catch(() => {})
        step-- // a retried empty reply must not eat the step budget
        continue
      }
      store.save(session)
      throw new Error(
        budget
          ? `The model used its whole output limit ${sawReasoning ? "thinking" : ""} and sent no answer (finish: ${finish}). Raise "Max output tokens" for this model or lower its reasoning effort.`
          : `The model returned an empty reply (finish: ${finish || "none"}${sawReasoning ? ", only reasoning" : ""}). Check the model id, base URL and API format for this provider, then send again.`,
      )
    }
    emptyRetries = 0
    // the step's own token usage rides on the message: the UI's context ring
    // (and a reload after the run) read it from there - without it the ring
    // only ever showed "?" no matter how long the chat grew.
    // providerID/model form matches the UI picker key (derived profiles are
    // "<provider>/<model>", the base profile is just "<provider>").
    const modelTag = { providerID: String(profile.id).split("/")[0], id: profile.model }
    session.messages.push({ role: "assistant", parts, ...(stepUsage ? { usage: stepUsage, model: modelTag } : {}) })
    store.save(session)
    if (!calls.length) {
      if (finalStep) finalized = true
      return emit({ type: "done", reason: finish, ...(finalStep ? { summarized: true } : {}) })
    }

    const results = []
    for (const c of calls) {
      if (signal.aborted) {
        results.push({ type: "tool_result", id: c.id, name: c.name, output: "Interrupted by user.", isError: true })
        continue
      }
      // an MCP call may have been planned while that server was still connecting
      let resolved = resolve(c.name)
      if (!resolved && waitExtraTools && String(c.name).startsWith("mcp__")) {
        await waitExtraTools(signal)
        resolved = resolve(c.name)
      }
      const shown = resolved ? resolved.name : c.name
      emit({ type: "tool.start", id: c.id, name: shown, args: c.args })
      let out
      let isError = false
      let stats = null
      let screenshot = null
      try {
        const tool = resolved
        if (!tool) throw new Error(`Unknown tool "${c.name}". Available: ${allTools().map((t) => t.name).join(", ")}`)
        if (c.args && c.args.__parseError) throw new Error("Tool arguments were not valid JSON. Send them again as a valid JSON object.")
        for (const k of (tool.parameters.required || [])) if (c.args[k] == null) throw new Error(`Missing required argument "${k}"`)
        const sig = c.name + JSON.stringify(c.args)
        recent.push(sig)
        if (recent.length > 3) recent.shift()
        if (recent.length === 3 && recent.every((x) => x === sig)) {
          consecutiveGuardHits++
          if (consecutiveGuardHits >= 2) {
            // the model ignored the first "change your approach" error and did it
            // again: stop instead of burning 100 steps of the user's credits
            emit({ type: "tool.end", id: c.id, name: shown, output: "Stopped: the agent repeated the same call.", isError: true })
            results.push({ type: "tool_result", id: c.id, name: shown, output: "Stopped after repeated identical calls.", isError: true })
            stuck = true
            break
          }
          throw new Error("The same call was made 3 times in a row with the same arguments. Try a different approach.")
        }
        consecutiveGuardHits = 0

        const ctx = { cwd: session.dir, signal, session, emit, stats: {}, engine, toolCallId: c.id, toolName: shown }
        for (const p of tool.paths(c.args, ctx)) {
          if (!isInside(session.dir, p) && !(await askPermission({ tool: "external_directory", subject: p })))
            throw new Error(`Permission denied: ${p} is outside the workspace. Do not retry; ask the user.`)
        }
        const perm = tool.perm(c.args, ctx)
        // V-05: for shell commands, split on top-level separators and check each
        // sub-command separately, so a dangerous tail can't hide behind a benign
        // head (e.g. `echo ok && rm -rf /`). Deny rules are matched per segment.
        let granted = false
        if (perm.tool === "bash" && typeof perm.subject === "string") {
          for (const sub of splitCommand(perm.subject)) {
            granted = await askPermission({ tool: "bash", subject: sub })
            if (!granted) break
          }
        } else {
          granted = await askPermission(perm)
        }
        if (!granted) throw new Error("The user denied permission for this action. Do not retry the same action; ask how to proceed.")
        const toolValue = await abortable(Promise.resolve().then(() => tool.run(c.args, ctx)), signal)
        if (toolValue && toolValue.__vibeStructuredToolResult === "browser-screenshot") {
          out = tools.clip(String(toolValue.text || "Browser screenshot captured."))
          const source = toolValue.screenshot && typeof toolValue.screenshot === "object" ? toolValue.screenshot : {}
          if (typeof source.data === "string" && source.data) {
            screenshot = {
              mime: String(source.mime || "image/png"),
              data: source.data,
              url: String(source.url || ""),
              title: String(source.title || ""),
              tabID: String(source.tabID || c.args?.tabID || ""),
              // Always retain/show the screenshot. Only pass pixels back into the
              // next LLM request when the selected model advertises vision support.
              modelVisible: !!profile.image,
            }
          }
        } else {
          out = tools.clip(String(toolValue ?? ""))
        }
        if (ctx.stats && Object.keys(ctx.stats).length) stats = ctx.stats // file diffs + structured tool metadata (subagents, screenshots, ...)
      } catch (e) {
        out = String((e && e.message) || e)
        isError = true
      }
      emit({ type: "tool.end", id: c.id, name: shown, output: out, isError, ...(stats ? { stats } : {}), ...(screenshot ? { screenshot } : {}) })
      results.push({ type: "tool_result", id: c.id, name: shown, output: out, isError, ...(stats ? { stats } : {}), ...(screenshot ? { screenshot } : {}) })
    }
    // the stuck-guard stopped mid-batch: give the untouched calls an error result
    // so the stored history stays valid without another provider request.
    if (stuck) {
      for (const c of calls) if (!results.some((r) => r.id === c.id)) results.push({ type: "tool_result", id: c.id, name: c.name, output: "Skipped: the agent stopped after repeating the same call.", isError: true })
      session.messages.push({ role: "user", parts: results })
      store.save(session)
      return emit({ type: "done", reason: "stuck" })
    }
    if (isOrphan()) return
    session.messages.push({ role: "user", parts: results })
    store.save(session)
  }
  emit({ type: "done", reason: "max_steps", ...(finalized ? { summarized: true } : {}) })
}

module.exports = { runLoop, repairHistory, abortable, splitCommand }
