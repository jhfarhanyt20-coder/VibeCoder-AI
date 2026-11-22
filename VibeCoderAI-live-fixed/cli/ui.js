"use strict"
// Short, readable step lines for Computer Use (same wording as the app).
function computerBrief(name, a) {
  const where = a.element != null && a.element !== "" ? `element ${a.element}` : (a.x != null && a.y != null ? `at ${a.x}, ${a.y}` : "")
  switch (String(name)) {
    case "computer_screenshot": return "looking at the screen"
    case "computer_zoom": return "looking closer at part of the screen"
    case "computer_done": return "done with the computer (Computer Use off)"
    case "computer_steps": return `doing ${Array.isArray(a.steps) ? a.steps.length : 0} steps: ${(Array.isArray(a.steps) ? a.steps : []).map((s) => s && s.action).filter(Boolean).join(" → ")}`
    case "computer_ui": return "reading the window controls"
    case "computer_windows": return "listing open windows"
    case "computer_focus": return `switching to window ${a.window || a.title || ""}`.trim()
    case "computer_launch": return `opening ${a.program || ""}`.trim()
    case "computer_click": return `${a.double ? "double-click" : a.button === "right" ? "right-click" : "click"} ${where}`.trim()
    case "computer_type": return `typing "${String(a.text || "").slice(0, 60)}"${a.enter ? " + Enter" : ""}`
    case "computer_key": return `pressing ${a.keys || ""}`.trim()
    case "computer_scroll": return `scrolling ${where}`.trim()
    case "computer_drag": return "dragging"
    case "computer_wait": return a.for_window ? `waiting for "${a.for_window}"` : `waiting ${a.seconds || 1}s`
    default: return ""
  }
}
/**
 * Terminal output for the VibeCoder CLI.
 *
 * One renderer handles every engine event, so the terminal never silently
 * drops a feature the desktop app shows: permissions, questions/forms,
 * subagents (crew), background shells, todos, usage, compaction, notices.
 *
 * Plain output (no TTY, pipes, CI) stays line based and colourless.
 */

const { c, safeText, colorEnabled } = require("./theme")
const isTTY = !!process.stdout.isTTY
const useColor = colorEnabled()

function clip(text, max = 160) {
  const one = safeText(text).replace(/\s+/g, " ").trim()
  return one.length > max ? one.slice(0, max - 1) + "…" : one
}

function tokens(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M"
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k"
  return String(v)
}

function money(cost) {
  const v = Number(cost)
  if (cost === undefined || cost === null || !Number.isFinite(v) || v < 0) return ""
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`
}

function when(ts) {
  const v = Number(ts)
  if (!v) return ""
  const diff = Date.now() - v
  if (diff < 60e3) return "just now"
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}m ago`
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)}h ago`
  return `${Math.floor(diff / 86400e3)}d ago`
}

/** "y / a / n" permission prompt. Resolves "once" | "always" | "deny". */
async function askPermission(rl, ev, state, log = console.log, signal) {
  const subject = clip(ev.subject, 220)
  // A risky Computer Use action is never auto-approved by --yes / Full Access.
  if (state.yes && !ev.critical) return "once"
  // A risky action with no terminal to ask: leave it for another client (the
  // desktop app's card when attached) instead of denying it here.
  if (ev.critical && (!rl || !process.stdin.isTTY)) {
    // Never wait for ever: when no app answers in time, refuse it, so the
    // agent stops this action and tells the user instead of hanging the run.
    const waitMs = Number(process.env.VIBE_CRITICAL_WAIT_MS) > 0 ? Number(process.env.VIBE_CRITICAL_WAIT_MS) : 90000
    log(c.dim(`(waiting up to ${Math.round(waitMs / 1000)}s for approval in the VibeCoder app: ${subject})`))
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        log(c.dim(`(nobody approved within ${Math.round(waitMs / 1000)}s: denied)`))
        resolve("deny")
      }, waitMs)
      signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(null) }, { once: true })
    })
  }
  if (!rl || !process.stdin.isTTY) {
    log(c.dim(`(no terminal to ask, denied: ${ev.tool}) use --yes to allow`))
    return "deny"
  }
  rl.setDialog?.({ kind: "permission", title: "Approve action", body: `${ev.tool}\n${subject}`, hint: "y once   a always   N deny   Esc cancel" })
  const answer = String(await ask(rl, `Allow ${ev.tool}: ${subject}? [y]es / [a]lways / [N]o `, signal) || "")
    .trim()
    .toLowerCase()
  rl.setDialog?.(null)
  if (answer === "y" || answer === "yes") return "once"
  if (answer === "a" || answer === "always") return "always"
  return "deny"
}

function ask(rl, question, signal) {
  if (!rl || rl.closed || signal?.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    let finished = false
    const finish = (answer) => {
      if (finished) return
      finished = true
      rl.off?.("close", cancelled)
      rl.off?.("SIGINT", cancelled)
      signal?.removeEventListener("abort", cancelled)
      resolve(answer)
    }
    const cancelled = () => finish(null)
    rl.once?.("close", cancelled)
    rl.once?.("SIGINT", cancelled)
    signal?.addEventListener("abort", cancelled, { once: true })
    try { rl.question(question, finish) } catch { finish(null) }
  })
}

/**
 * Draw one question of a form and return the picked values.
 * Accepts a number, "1,3", free text, or empty (skip).
 */
async function askQuestionForm(rl, form, state, log = console.log, signal) {
  if (!rl || !process.stdin.isTTY) {
    log(c.dim(`(no terminal to answer: ${form.title}) the question was skipped`))
    return null
  }
  const answers = {}
  for (let i = 0; i < form.questions.length; i++) {
    const q = form.questions[i]
    const lines = []
    lines.push("")
    lines.push(c.cyan("? ") + c.bold(q.header || `Question ${i + 1}`))
    if (q.question && q.question !== q.header) lines.push("  " + q.question)
    const options = Array.isArray(q.options) ? q.options : []
    options.forEach((o, n) => {
      lines.push(`  ${c.bold(String(n + 1))}. ${o.label}${o.description ? c.dim(" — " + o.description) : ""}`)
    })
    log(lines.join("\n"))
    const hint = options.length
      ? q.multiple
        ? `numbers (1,3) or text, empty = skip: `
        : `number or text, empty = skip: `
      : `answer, empty = skip: `
    rl.setDialog?.({ kind: "question", title: q.header || form.title || "Question", body: q.question || "", options, hint: (q.multiple ? "Numbers 1,3 or custom text" : "Number or custom text") + " / Enter answer / Esc skip" })
    const answer = await ask(rl, "  " + hint, signal)
    rl.setDialog?.(null)
    if (answer === null) return null
    const raw = String(answer).trim()
    if (!raw) {
      answers[`q${i}`] = []
      continue
    }
    if (/^\d+(?:\s*,\s*\d+)*$/.test(raw) && options.length) {
      const indices = raw.split(",").map(Number)
      if (indices.some((n) => n < 1 || n > options.length) || !q.multiple && indices.length > 1) {
        log(c.yellow("Choose a listed number, or type a custom answer."))
        i--
        continue
      }
      answers[`q${i}`] = [...new Set(indices.map((n) => options[n - 1].label))]
    } else {
      // Commas in a free-text answer are not a multiple-choice separator.
      answers[`q${i}`] = [raw]
    }
  }
  return answers
}

/**
 * @param {{rl?: import("readline").Interface, yes?: boolean, showReasoning?: boolean,
 *          json?: boolean, quiet?: boolean, verbose?: boolean, out?: NodeJS.WriteStream}} opts
 */
function createRenderer(opts = {}) {
  const out = opts.out || process.stdout
  const state = {
    yes: !!opts.yes,
    showReasoning: !!opts.showReasoning,
    json: !!opts.json,
    quiet: !!opts.quiet,
    verbose: !!opts.verbose,
    failed: false,
    toolErrors: 0,
    costKnown: false,
    interrupted: false,
    totals: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    steps: 0,
    midline: false,
    textSinceTool: false,
    todos: [],
    channel: "",
    contentType: "",
    waiting: null,
  }
  const rl = opts.rl || null
  const log = (text) => out.write(String(text) + "\n")

  const line = (text = "") => {
    if (state.midline) {
      out.write("\n")
      state.midline = false
    }
    out.write(text + "\n")
  }
  const write = (text) => {
    if (!text) return
    out.write(text)
    state.midline = !safeText(text).endsWith("\n")
  }
  const note = (text) => {
    if (state.quiet) return
    line(c.dim(text))
  }
  const usage = new Map()
  const seen = new Set()
  const formsSeen = new Set()
  const permissionsSeen = new Set()
  const remember = (set, id) => { set.add(id); if (set.size > 500) set.delete(set.values().next().value) }
  function observe(ev) {
    const formResolved = ["question.replied", "question.cancelled"].includes(ev.type)
    const permissionResolved = ev.type === "permission.replied"
    const id = formResolved ? ev.form?.id : permissionResolved ? ev.permissionId : null
    if (id) remember(formResolved ? formsSeen : permissionsSeen, id)
    const pending = state.waiting
    if (pending && pending.id === id) {
      pending.external = true
      pending.controller.abort()
      if (rl?.active?.interaction) rl.cancel?.()
    }
  }
  const addUsage = (ev) => {
    const key = [ev.subagentId || "", ev.step ?? state.steps, ev.model?.providerID || "", ev.model?.id || ""].join(":")
    const previous = usage.get(key) || {}
    const next = { input: Number(ev.input) || 0, output: Number(ev.output) || 0, reasoning: Number(ev.reasoning) || 0, cacheRead: Number(ev.cache?.read) || 0, cacheWrite: Number(ev.cache?.write) || 0, cost: Number(ev.cost) || 0 }
    for (const k of Object.keys(next)) state.totals[k] += next[k] - (previous[k] || 0)
    usage.set(key, next)
    if (ev.cost !== undefined) state.costKnown = true
  }

  async function handle(ev) {
    if (!ev || typeof ev !== "object") return
    if (ev.eventID) {
      if (seen.has(ev.eventID)) return
      seen.add(ev.eventID)
      if (seen.size > 8000) seen.delete(seen.values().next().value)
    }
    observe(ev)
    if (ev.type === "run.start" && !ev.subagentId) beginRun()
    if (ev.type === "error" && !ev.subagentId || ev.type === "done" && !ev.subagentId && ev.reason === "error") state.failed = true
    if (ev.type === "done" && !ev.subagentId && ev.reason === "interrupted") state.interrupted = true
    if (ev.type === "usage") addUsage(ev)
    if (state.json) {
      out.write(JSON.stringify(ev) + "\n")
      // Machine mode still has to keep the run moving: nobody can answer a
      // prompt that is printed as JSON, so answer with the configured mode.
      if (ev.type === "permission.ask") {
        // A risky Computer Use action waits for a person (e.g. the desktop app's
        // card when attached); --yes never approves it.
        if (!ev.critical) await opts.vibe?.permission?.reply?.(ev.permissionId, state.yes ? "once" : "deny")
      }
      if (ev.type === "question.ask" && ev.form) {
        await opts.vibe?.forms?.cancel?.(ev.form.id, "No terminal is attached (JSON mode).")
      }
      return
    }
    // Model, tool and shell strings cannot inject terminal escape sequences.
    const clean = (value) => {
      if (typeof value === "string") return safeText(value)
      if (Array.isArray(value)) return value.map(clean)
      if (!value || typeof value !== "object") return value
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]))
    }
    ev = clean(ev)
    try { opts.onEvent?.(ev, state) } catch (error) { state.presentationError = error.message }
    const channel = ev.subagentId ? `Crew ${ev.subagentName || ev.subagentId}` : ""
    if (["text.delta", "reasoning.delta", "tool.start"].includes(ev.type) && state.channel !== channel) {
      if (state.midline) line()
      if (channel) note(`[${channel}]`)
      state.channel = channel
    }

    switch (ev.type) {
      case "run.start":
        state.steps = 0
        if (state.verbose && ev.model) note(`model ${ev.model.providerID || ""}/${ev.model.id || ""} — ${ev.dir || ""}`)
        break
      case "step.start":
        state.steps = Number(ev.step) || state.steps
        if (state.verbose) note(`step ${ev.step}/${ev.maxSteps}`)
        break
      case "step.end":
        state.steps = Number(ev.step) || state.steps
        break
      case "text.delta":
        if (state.quiet && ev.subagentId) break
        if (state.contentType === "reasoning" && state.midline) line()
        state.contentType = "text"
        write(c.text(String(ev.delta || "")))
        state.textSinceTool = true
        break
      case "reasoning.delta":
        if (state.showReasoning) {
          if (state.contentType === "text" && state.midline) line()
          if (!state.midline) write(c.dim("thinking "))
          write(c.dim(String(ev.delta || "")))
          state.contentType = "reasoning"
        }
        break
      case "tool.start": {
        const brief = /^computer_/.test(String(ev.name)) ? computerBrief(ev.name, ev.args || {}) : ev.args && ([ev.args.repo, ev.args.number != null ? `#${ev.args.number}` : "", ev.args.page ? `page ${ev.args.page}` : "", ev.args.ad_account].filter(Boolean).join(" ") || ev.args.command || ev.args.path || ev.args.pattern || ev.args.url || ev.args.task || ev.args.id || ev.args.query || "")
        if (!state.quiet) line(c.magenta("→ ") + c.bold(String(ev.name)) + (brief ? " " + c.dim(clip(brief, 120)) : ""))
        state.textSinceTool = false
        break
      }
      case "tool.end":
        if (ev.isError) {
          line(c.red("  ! ") + c.red(clip(String(ev.output || "").split("\n")[0], 180)))
          state.toolErrors++
        } else if (state.verbose) {
          const first = String(ev.output || "").split("\n")[0]
          note(`  ${ev.durationMs ? `${ev.durationMs}ms` : "done"}${first ? " — " + clip(first, 120) : ""}`)
        }
        state.textSinceTool = false
        break
      case "todo.update":
        state.todos = Array.isArray(ev.todos) ? ev.todos : []
        if (!state.quiet) {
          const done = state.todos.filter((t) => t.status === "completed").length
          line(c.dim(`  todo ${done}/${state.todos.length}`))
          for (const t of state.todos.slice(0, 12)) {
            const mark = t.status === "completed" ? c.green("[x]") : t.status === "in_progress" ? c.yellow("[~]") : t.status === "cancelled" ? c.dim("[-]") : "[ ]"
            line(`    ${mark} ${t.content || t.text || ""}`)
          }
        }
        break
      case "usage":
        if (state.verbose) {
          const parts = [`step ${ev.step || state.steps}`, `in ${tokens(ev.input)}`, `out ${tokens(ev.output)}`]
          if (ev.cache?.read) parts.push(`cache ${tokens(ev.cache.read)}`)
          const cost = money(ev.cost)
          if (cost) parts.push(cost)
          note("  " + parts.join(" · "))
        }
        break
      case "compaction.start":
        line(c.dim(`\n[compacting context (${ev.reason || "auto"})...]`))
        break
      case "compaction.delta":
        if (state.verbose && ev.delta) write(c.dim(ev.delta))
        break
      case "compaction.end":
        line(
          c.dim(
            ev.summarized === false
              ? `[context not compacted${ev.error ? ": " + clip(ev.error, 120) : ""}]`
              : `[compacted: ~${tokens(ev.before)} -> ~${tokens(ev.after)} tokens]`,
          ),
        )
        break
      case "permission.ask": {
        if (permissionsSeen.has(ev.permissionId)) break
        remember(permissionsSeen, ev.permissionId)
        line(c.yellow("permission ") + `${ev.tool}: ${clip(ev.subject, 200)}`)
        const pending = { id: ev.permissionId, controller: new AbortController(), external: false }
        state.waiting = pending
        const decision = await askPermission(rl, ev, state, log, pending.controller.signal)
        state.waiting = null
        if (!pending.external && decision) await opts.vibe?.permission?.reply?.(ev.permissionId, decision)
        if (decision === "deny") note("  denied")
        break
      }
      case "permission.lock":
        line(c.dim(`[locked] ${ev.tool || ""} ${clip(ev.reason || ev.subject || "", 160)}`))
        break
      case "permission.decision":
        if (state.verbose) note(`  ${ev.decision || ""} ${ev.tool || ""}`)
        break
      case "permission.replied":
        if (state.verbose) note(`  permission ${ev.decision || "resolved"}: ${ev.tool || ""}`)
        break
      case "question.ask": {
        if (!ev.form) break
        if (formsSeen.has(ev.form.id)) break
        remember(formsSeen, ev.form.id)
        line(c.cyan("? ") + c.bold(ev.form.title || "Question"))
        const pending = { id: ev.form.id, controller: new AbortController(), external: false }
        state.waiting = pending
        const answers = await askQuestionForm(rl, ev.form, state, log, pending.controller.signal)
        state.waiting = null
        if (!pending.external) {
          if (answers) await opts.vibe?.forms?.reply?.(ev.form.id, answers)
          else await opts.vibe?.forms?.cancel?.(ev.form.id, "The user skipped the question.")
        }
        break
      }
      case "question.replied":
        note("  answered")
        break
      case "question.cancelled":
        note(`  question skipped${ev.message ? ": " + clip(ev.message, 120) : ""}`)
        break
      case "subagent.start":
        if (!state.quiet) line(c.blue("⚑ subagent ") + c.bold(ev.subagentName || ev.name || "subagent") + c.dim(` started${ev.task ? " — " + clip(ev.task, 120) : ""}`))
        break
      case "subagent.resume":
        note(`  subagent ${ev.subagentName || ""} resumed${ev.text ? ": " + clip(ev.text, 120) : ""}`)
        break
      case "subagent.result":
        note(`  subagent ${ev.subagentName || ""} result${ev.ok === false ? " (failed)" : ""}${ev.durationMs ? ` in ${Math.round(ev.durationMs / 1000)}s` : ""}: ${clip(ev.result || ev.error || "", 160)}`)
        break
      case "subagent.end":
        note(`  subagent ${ev.subagentName || ""} ${ev.status || "finished"}${ev.error ? ": " + clip(ev.error, 120) : ""}`)
        break
      case "subagent.error":
        line(c.red(`  subagent error: ${clip(ev.error || "", 160)}`))
        break
      case "shell.started":
        if (state.verbose) note(`  shell ${ev.shell?.id || ""} started: ${clip(ev.shell?.command || "", 160)}`)
        break
      case "shell.output":
        if (state.verbose) {
          if (state.channel !== `shell ${ev.shell?.id}`) {
            line(c.dim(`  shell ${ev.shell?.id || ""} output`))
            state.channel = `shell ${ev.shell?.id}`
          }
          write(String(ev.delta || ""))
        }
        break
      case "shell.input":
        if (state.verbose) note(`  shell ${ev.shell?.id || ""}: ${ev.eof ? "input closed" : `${ev.bytes || 0} byte(s) sent`}`)
        break
      case "shell.ended":
        if (state.verbose) note(`  shell ${ev.shell?.id || ""} ${ev.shell?.status || "finished"} (exit ${ev.shell?.exit ?? "?"})`)
        break
      case "shell.backgrounded":
        note(`  shell ${ev.shell?.id || ""} running in the background`)
        break
      case "shell.completed":
        note(`  shell ${ev.shell?.id || ""} ${ev.shell?.status || "finished"}${ev.shell?.exit !== undefined || ev.shell?.exitCode !== undefined ? ` (exit ${ev.shell.exit ?? ev.shell.exitCode})` : ""}: ${clip((ev.output || "").split("\n")[0], 120)}`)
        break
      case "shell.waiting":
        line(c.yellow(`  shell ${ev.shell?.id || ""} is waiting for input: `) + clip(ev.prompt || "", 160))
        break
      case "shell.results.attached":
        note(`  ${ev.count || 0} shell result(s) attached`)
        break
      case "shell.resume.started":
        note("  continuing from the saved background shell result")
        break
      case "prompts.attached":
        note(`  ${(ev.ids || []).length} queued prompt(s) attached`)
        break
      case "recipe.start":
        note(`recipe ${ev.id || ev.name || ""}${ev.args ? " " + clip(ev.args, 80) : ""}`)
        break
      case "notice":
        line(c.yellow("· ") + String(ev.text || ""))
        break
      case "error":
        line(c.red("Error: ") + String(ev.message || ev.error || "unknown error"))
        break
      case "done":
        if (state.midline) {
          out.write("\n")
          state.midline = false
        }
        if (ev.reason === "max_steps") note("[stopped: step limit reached]")
        else if (ev.reason === "stuck") note("[stopped: the agent repeated the same call]")
        else if (ev.reason === "length") note("[stopped: output length limit]")
        else if (ev.reason === "interrupted") {
          state.interrupted = true
          note("[interrupted]")
        }
        if (!ev.subagentId && opts.summaryAtDone !== false && (state.verbose || state.totals.input || state.totals.output || state.costKnown)) {
          const t = state.totals
          const cost = state.costKnown ? money(t.cost) : ""
          note(
            `[${tokens(t.input)} in · ${tokens(t.output)} out${t.reasoning ? ` · ${tokens(t.reasoning)} thinking` : ""}${
              t.cacheRead ? ` · ${tokens(t.cacheRead)} cached` : ""
            }${cost ? ` · ${cost}` : ""}]`,
          )
        }
        break
      default:
        // Unknown future events still surface in verbose mode instead of
        // disappearing, so a new engine feature never looks silent.
        if (state.verbose) note(`(${ev.type})`)
        break
    }
  }

  /** One-line summary of the finished run; used after a prompt completes. */
  function summary() {
    const t = state.totals
    const bits = []
    if (t.input) bits.push(`${tokens(t.input)} in`)
    if (t.output) bits.push(`${tokens(t.output)} out`)
    const cost = state.costKnown ? money(t.cost) : ""
    if (cost) bits.push(cost)
    return bits.join(" · ")
  }

  function resetRun() {
    state.failed = false
    state.interrupted = false
    state.steps = 0
    state.midline = false
    state.textSinceTool = false
    state.channel = ""
    state.toolErrors = 0
    state.contentType = ""
  }

  /** Start a fresh prompt: per-run totals and status, not cumulative. */
  function beginRun() {
    state.totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    state.todos = []
    state.costKnown = false
    usage.clear()
    resetRun()
  }

  async function handleEvents(iterable) {
    for await (const ev of iterable) await enqueue(ev)
  }

  let queue = Promise.resolve()
  const enqueue = (ev) => {
    observe(ev)
    const next = queue.then(() => handle(ev))
    queue = next.catch((error) => {
      state.failed = true
      if (state.json) out.write(JSON.stringify({ type: "error", message: `Terminal event error: ${error.message}` }) + "\n")
      else line(c.red(`Terminal event error: ${error.message}`))
    })
    return next
  }
  return { state, handle, observe, enqueue, drain: () => queue, handleEvents, summary, resetRun, beginRun, line, note, write }
}

/** Simple aligned table for the inspection commands. */
function table(rows, headers) {
  const all = [headers, ...rows]
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)))
  return all
    .map((row, index) => {
      const cells = row.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ")
      return index === 0 ? c.bold(cells) : cells
    })
    .join("\n")
}

module.exports = { c, clip, tokens, money, when, table, ask, askPermission, askQuestionForm, createRenderer, isTTY, useColor }
