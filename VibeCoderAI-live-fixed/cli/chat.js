"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { createRenderer, table, clip, when } = require("./ui")
const { c, safeText, providerName, selectedProfile, THEMES } = require("./theme")
const { TerminalInput } = require("./input")
const { loadSettings, loadHistory, saveSettings, rememberPrompt } = require("./settings")
const { runCommand, modelChoices, splitCommand } = require("./actions")
const { expandFileMentions } = require("./attachments")
const { stopSessionWork } = require("./run")
const { homeDir } = require("../core/util")
const { redactText } = require("../core/harness/guard")

const LOCAL_COMMANDS = ["help", "model", "models", "fallback", "agent", "new", "sessions", "use", "rename", "delete", "compact", "undo", "redo", "steps", "step", "diff", "history", "export", "usage", "skills", "skill", "playbooks", "agents", "recipes", "recipe", "memory", "mcp", "plugins", "extensions", "tools", "doctor", "config", "theme", "access", "provider", "permissions", "locks", "forms", "crew", "shells", "shell", "trail", "todos", "browser", "marketplace", "registry", "auth", "profile", "reasoning", "thinking", "verbose", "yes", "dir", "clear", "exit", "quit"]
const HELP = `VibeCoder chat

  /model [id]       pick/switch model    /agent [id]     pick/switch persona
  /models           provider catalog    /new [title]    new session
  /sessions         session picker      /use <n|id>     open session
  /rename [title]   change title        /delete         confirm deletion
  /history [n]      saved conversation   /export <file>  redacted session export
  /undo [message]   rewind a turn        /redo           restore files/history
  /steps            step snapshots      /step undo <turn> <step>
  /diff [turn step] redacted preview     /compact        summarize old context
  /recipe <id> args run a recipe         /skill <id> task load a playbook
  /recipes /skills /agents /mcp /plugins /extensions /tools /marketplace
  /memory /todos /trail /usage /config /permissions /locks /crew /shell
  /browser          real desktop browser (start with vibe attach)
  /fallback         ordered failover chain for rate limits and outages
  /provider         add, remove, key, test or list providers
  /auth add <id>    masked API key       /profile        advanced profiles
  /theme [name]     terminal colors      /reasoning      show/hide thinking
  /thinking [level] reasoning effort     /verbose        detailed tool output
  /access [full|ask] saved approval mode  /doctor         setup diagnostics
  /yes              toggle saved Full Access (hard Locks still apply)
  /dir              working folder       /clear          clear terminal only
  /exit             leave chat

Management commands accept the same arguments as vibe help (for example,
/mcp resources server or /config set compaction.keep.tokens 12000).
Enter sends. Alt+Enter/Ctrl+J inserts a newline. Bracketed paste stays one draft.
Ctrl+P opens commands; Tab completes /commands and @files; ↑/↓ recalls history.
Mouse wheel/PgUp scroll chat. F4 or click the access label to choose Full Access.
Paste with Ctrl+V (or right-click); the whole clipboard lands as one draft.
Ctrl+C interrupts; Ctrl+B moves blocking shells to the background.
Theme changes do not change the desktop UI or your terminal font size.`

function commandName(line) { return String(line || "").trim().split(/\s+/)[0].replace(/^\//, "").toLowerCase() }

function completer(dir) {
  return (text) => {
    if (/^\/[a-z-]*$/i.test(text)) {
      const hits = LOCAL_COMMANDS.map((s) => "/" + s).filter((s) => s.startsWith(text))
      if (hits.length === 1) return { text: hits[0] + " " }
      if (hits.length) return { choices: hits.map((s) => ({ label: s, value: s + " " })), prefix: text }
    }
    const match = /(^|\s)@(?:"([^"]*)"|([^\s]*))$/.exec(text)
    if (!match) return null
    const fragment = match[2] ?? match[3]
    const slash = Math.max(fragment.lastIndexOf("/"), fragment.lastIndexOf("\\"))
    const prefix = fragment.slice(0, slash + 1)
    const leaf = fragment.slice(slash + 1)
    let rows
    try { rows = fs.readdirSync(path.resolve(dir, prefix || "."), { withFileTypes: true }) } catch { return null }
    const before = text.slice(0, match.index) + match[1]
    const hits = rows.filter((r) => r.name.toLowerCase().startsWith(leaf.toLowerCase()) && !["node_modules", ".git"].includes(r.name)).slice(0, 80).map((row) => {
      const name = prefix + row.name + (row.isDirectory() ? "/" : "")
      return { label: name, value: before + "@" + (/\s/.test(name) ? JSON.stringify(name) : name) }
    })
    return hits.length === 1 ? { text: hits[0].value } : { choices: hits, prefix: fragment }
  }
}

function printHistory(session, log, limit = 12) {
  const messages = (session.messages || []).filter((m) => (m.parts || []).some((p) => !p.agentOnly && ["text", "tool_use", "image"].includes(p.type))).slice(-Math.min(100, Math.max(1, limit)))
  if (!messages.length) { log(c.dim("No saved messages yet.")); return }
  for (const message of messages) {
    log(c.bold(message.role === "assistant" ? "VibeCoder" : "You"))
    for (const part of message.parts || []) {
      if (part.agentOnly) continue
      if (part.type === "text") log(redactText(safeText(part.text)))
      else if (part.type === "tool_use") log(c.dim(`  tool ${part.name} ${clip(JSON.stringify(part.args || {}), 100)}`))
      else if (part.type === "image") log(c.dim(`  [image: ${part.mime || "image"}]`))
    }
  }
}

async function runChat({ vibe, dir, profile, flags = {}, agent, session: initial, input: provided, home = homeDir(), stored = loadSettings(home), connection } = {}) {
  const input = provided || new TerminalInput()
  const screen = input.screen || (input.wantScreen || !provided && process.stdout.isTTY && !flags.plain && process.env.TERM !== "dumb"
    ? input.enableScreen({ version: require("../package.json").version })
    : null)
  input.history = stored.history ? loadHistory(home) : []
  const output = { isTTY: process.stdout.isTTY, write: (s) => input.write(s) }
  const log = (s = "") => output.write(String(s) + "\n")
  let session = initial
  if (!session) {
    if (flags.session) session = await vibe.session.get(flags.session)
    else if (flags.continue) {
      const rows = await vibe.session.list({ dir })
      if (rows.length) session = await vibe.session.get(rows[0].id)
    }
    if (!session) session = await vibe.session.create({ dir, profile, agent })
  }
  dir = session.dir
  const owned = new Set([session.id])
  const renderers = new Map()
  let profiles = await vibe.profiles.list()
  let personas = await vibe.control.call("agents.list", { directory: dir })
  let sessions = []
  let exiting = false
  let eventQueue = Promise.resolve()
  let autoCrew = Promise.resolve()
  let draft = ""
  let yesMode = flags.yes === undefined ? stored.access === "full" : !!flags.yes
  let closing = false
  const settingsNow = { ...stored, reasoning: !!(flags.reasoning || stored.reasoning), verbose: !!(flags.verbose || stored.verbose) }
  const rendererFor = (id) => {
    if (!renderers.has(id)) renderers.set(id, createRenderer({
      vibe, rl: input, out: screen ? { write() {} } : output, yes: yesMode,
      verbose: settingsNow.verbose, showReasoning: settingsNow.reasoning, quiet: !!flags.quiet,
      onEvent: screen ? (event, state) => {
        if (id === session.id) screen.event(event, state)
        else if (["shell.completed", "subagent.end"].includes(event.type)) screen.write(`Another session completed background work: ${id}`)
      } : undefined,
    }))
    return renderers.get(id)
  }
  const enqueue = (event) => {
    const id = event.sessionId || session.id
    if (!owned.has(id)) return Promise.resolve()
    rendererFor(id).observe(event)
    const next = eventQueue.then(() => rendererFor(id).handle(event))
    eventQueue = next.catch((error) => log(c.red("Terminal event: " + error.message)))
    return next
  }
  const context = (extra = {}) => ({ vibe, dir, home, sessionId: session.id, input, out: output, inChat: true, flags: { ...flags, yes: rendererFor(session.id).state.yes }, ...extra })
  const refresh = async () => {
    session = await vibe.session.get(session.id)
    dir = session.dir
    input.complete = completer(dir)
    profiles = await vibe.profiles.list()
    personas = await vibe.control.call("agents.list", { directory: dir })
    const p = selectedProfile(session.profile, profiles)
    const persona = personas.find((a) => a.id === (session.agent || "build"))
    screen?.setContext({
      workspace: path.basename(dir), directory: dir, title: session.title,
      agent: persona?.name || session.agent || "Pilot", provider: providerName(p, profiles),
      percent: p?.contextLimit ? Math.round(100 * (Number(session.usage?.lastInput) || 0) / p.contextLimit) : null,
      limit: p?.contextLimit, mode: vibe.mode, yes: rendererFor(session.id).state.yes,
    })
  }
  const label = () => {
    const p = selectedProfile(session.profile, profiles)
    const persona = personas.find((a) => a.id === (session.agent || "build"))
    const context = Number(session.usage?.lastInput) || 0
    const percent = p?.contextLimit ? Math.round(100 * context / p.contextLimit) : null
    return `${persona?.name || session.agent || "Pilot"} / ${providerName(p, profiles)}${percent !== null ? `   context ${percent}%` : ""}`
  }
  const interrupted = () => {
    const busy = input.active?.multiline ? false : true
    if (busy || vibe.engine?.isBusy(session.id)) {
      vibe.session.interrupt(session.id).catch?.(() => {})
      return
    }
    exiting = true
    input.close()
  }
  const background = () => vibe.control.call("shells.background", { sessionId: session.id }).then((rows) => log(c.dim(`${rows.length || 0} shell(s) backgrounded`))).catch((error) => log(c.red(error.message)))
  input.on("SIGINT", interrupted)
  input.on("background", background)
  const off = vibe.event.subscribe((event) => {
    if (!owned.has(event.sessionId)) return
    const pending = enqueue(event)
    if (event.type === "subagent.end" && event.status === "done") {
      // Delivery is event-driven, not a status poll or a synthetic user prompt.
      autoCrew = autoCrew.then(async () => {
        await pending.catch(() => {})
        if (closing) return
        await new Promise((r) => setImmediate(r))
        const state = await vibe.control.call("session.state", { sessionId: event.sessionId })
        if (!closing && !state.busy && !state.shells.length && !state.crew.length && state.pendingCrew) {
          for await (const ev of vibe.session.resume(event.sessionId, { reasoningEffort: flags.thinking, summaryModel: flags.summaryModel, maxSteps: flags.steps })) await enqueue(ev)
        }
      }).catch((error) => log(c.red("Crew result: " + error.message)))
    }
    return pending
  })

  const switchSession = async (target) => {
    session = await vibe.session.get(target)
    owned.add(session.id)
    await refresh()
    if (screen) screen.setHistory(session)
    else { log(c.bold(session.title) + c.dim(`  ${session.id}`)); printHistory(session, log, 6) }
    // A pending request may predate this subscription/selection.
    for (const form of await vibe.forms.list(session.id)) await enqueue({ type: "question.ask", form, sessionId: session.id })
    const permissions = await vibe.control.call("permissions.list", { sessionId: session.id, directory: dir })
    for (const p of permissions.pending.filter((p) => p.sessionId === session.id)) await enqueue({ type: "permission.ask", permissionId: p.id, tool: p.tool, subject: p.subject, sessionId: session.id })
  }

  const exit = async () => {
    if (vibe.mode === "inproc") {
      const live = []
      for (const id of owned) {
        const state = await vibe.control.call("session.state", { sessionId: id }).catch(() => null)
        if (state && (state.busy || state.shells.length || state.crew.length)) live.push(id)
      }
      if (live.length) {
        const answer = await input.read("Local jobs need this CLI process. Stop them and exit? [y/N] ", { interrupt: true })
        if (!/^(y|yes)$/i.test(String(answer || "").trim())) return
        for (const id of live) await stopSessionWork(vibe, id)
      }
    }
    exiting = true
  }

  async function handleCommand(line) {
    const [name, ...args] = splitCommand(line.replace(/^\//, ""))
    const rest = args.join(" ")
    switch (name.toLowerCase()) {
      case "help": log(HELP); return null
      case "exit":
      case "quit": await exit(); return null
      case "dir": log(dir); return null
      case "clear":
        if (screen) screen.clearTranscript()
        else if (process.stdout.isTTY && process.env.TERM !== "dumb") process.stdout.write("\x1b[2J\x1b[H")
        else log()
        return null
      case "history": printHistory(await vibe.session.get(session.id), log, Number(args[0]) || 12); return null
      case "model": {
        const selected = rest ? { id: rest } : await input.pick(modelChoices(profiles), "Choose a model")
        if (!selected) return null
        const resolved = await vibe.control.call("profiles.resolve", { id: selected.id })
        session = await vibe.session.switchModel(session.id, resolved.id)
        saveSettings({ model: resolved.id }, home)
        await refresh()
        log(c.dim(`Provider: ${providerName(selectedProfile(session.profile, profiles), profiles)}`))
        return null
      }
      case "agent": {
        const selected = rest ? { id: rest } : await input.pick(personas.map((a) => ({ ...a, label: a.name, description: a.description })), "Choose an agent")
        if (!selected) return null
        await vibe.control.call("agents.select", { sessionId: session.id, id: selected.id })
        saveSettings({ agent: selected.id }, home)
        await refresh()
        log(c.dim(`Agent: ${personas.find((p) => p.id === selected.id)?.name || selected.id}`))
        return null
      }
      case "new":
        session = await vibe.session.create({ dir, profile: session.profile, title: rest || undefined, agent: session.agent || agent || "build" })
        owned.add(session.id); sessions = []
        await refresh()
        screen?.setHistory(session)
        log(c.dim(`New session ${session.id}`))
        return null
      case "sessions":
        sessions = await vibe.session.list(args[0] === "all" ? {} : { dir })
        log(table(sessions.map((s, i) => [i + 1, s.id, clip(s.title, 50)]), ["#", "Session", "Title"]))
        {
          const selected = await input.pick(sessions.map((s) => ({ ...s, label: s.title || s.id, description: `${when(s.updatedAt)}  ${s.dir}` })), "Open a session")
          if (selected) await switchSession(selected.id)
        }
        return null
      case "use": {
        if (!sessions.length) sessions = await vibe.session.list({ dir })
        const index = Number(args[0])
        const target = Number.isInteger(index) && index > 0 ? sessions[index - 1]?.id : args[0]
        if (!target) throw new Error("Use /sessions, then /use <number or ID>.")
        await switchSession(target)
        return null
      }
      case "rename": {
        const title = rest || await input.read("New title: ", { interrupt: true })
        if (title) session = await vibe.session.rename(session.id, title)
        sessions = []
        return null
      }
      case "delete": {
        const answer = await input.read(`Delete "${clip(session.title, 60)}" and its history? [y/N] `, { interrupt: true })
        if (!/^(y|yes)$/i.test(String(answer || "").trim())) return null
        await stopSessionWork(vibe, session.id)
        await vibe.session.remove(session.id)
        owned.delete(session.id)
        session = await vibe.session.create({ dir, profile: session.profile, agent: session.agent || "build" })
        owned.add(session.id); sessions = []
        await refresh()
        screen?.setHistory(session)
        return null
      }
      case "undo":
        log(JSON.stringify(await vibe.session.undo(session.id, args[0]), null, 2)); await refresh(); screen?.setHistory(session); return null
      case "redo":
        log(JSON.stringify(await vibe.session.redo(session.id), null, 2)); await refresh(); screen?.setHistory(session); return null
      case "steps": {
        const steps = await vibe.session.snapshotSteps(session.id)
        log(table(steps.map((s) => [s.turn, s.step, when(s.time), s.files?.length || 0]), ["Turn", "Step", "Time", "Files"]))
        log(c.dim("Rewind: /step undo <turn> <step>. Preview: /diff <turn> <step>"))
        return null
      }
      case "step":
        if (args[0] !== "undo" || !args[1] || !args[2]) throw new Error("Usage: /step undo <turn> <step>")
        log(JSON.stringify(await vibe.session.undoStep(session.id, Number(args[1]), Number(args[2])), null, 2))
        await refresh(); screen?.setHistory(session); return null
      case "diff":
        log(JSON.stringify(await vibe.session.snapshotPreview(session.id, { turn: args[0] ? Number(args[0]) : undefined, step: args[1] ? Number(args[1]) : undefined }), null, 2)); return null
      case "export":
        await runCommand(context({ flags: { ...flags, output: rest } }), ["session", "export", session.id]); return null
      case "recipe":
        if (!args[0]) { await runCommand(context(), ["recipes"]); return null }
        await vibe.control.call("recipes.show", { id: args[0], directory: dir })
        return line.trim().replace(/^\/recipe\s+/i, "/")
      case "skill":
        await vibe.control.call("skills.show", { id: args[0], directory: dir })
        return `Load the installed playbook with exact ID ${JSON.stringify(args[0])} using the playbook tool, then ${args.slice(1).join(" ") || "help me apply it to the current task."}`
      case "reasoning":
        settingsNow.reasoning = !settingsNow.reasoning
        for (const renderer of renderers.values()) renderer.state.showReasoning = settingsNow.reasoning
        saveSettings({ reasoning: settingsNow.reasoning }, home)
        log(c.dim("Thinking " + (settingsNow.reasoning ? "shown" : "hidden"))); return null
      case "thinking": {
        const choice = args[0] ? { id: args[0].toLowerCase() } : await input.pick(["auto", "none", "low", "medium", "high"].map((id) => ({ id, label: id === "auto" ? "Provider default" : id })), "Reasoning effort")
        if (!choice) return null
        if (!["auto", "none", "low", "medium", "high"].includes(choice.id)) throw new Error("Use /thinking auto|none|low|medium|high.")
        flags.thinking = choice.id === "auto" ? undefined : choice.id
        saveSettings({ thinking: flags.thinking || null }, home)
        log(c.dim("Effort: " + (flags.thinking || "provider preset"))); return null
      }
      case "verbose":
        settingsNow.verbose = !settingsNow.verbose
        for (const renderer of renderers.values()) renderer.state.verbose = settingsNow.verbose
        saveSettings({ verbose: settingsNow.verbose }, home)
        log(c.dim("Detailed tools " + (settingsNow.verbose ? "shown" : "hidden"))); return null
      case "yes": {
        const enabled = !rendererFor(session.id).state.yes
        saveSettings({ access: enabled ? "full" : "ask" }, home)
        yesMode = enabled
        for (const renderer of renderers.values()) renderer.state.yes = enabled
        screen?.setContext({ yes: enabled })
        log(c.dim(enabled ? "Full Access saved. Permission prompts auto-approved; hard Locks and agent rules stay in force." : "Ask before changes saved.")); return null
      }
      case "access": {
        const selected = args[0] ? { id: args[0] } : await input.pick([
          { id: "ask", label: "Ask before changes", description: "Review each permission request before the action runs." },
          { id: "full", label: "Full Access", description: "Automatically approve permission requests. Hard Locks and agent denies remain." },
        ], "Permission mode")
        if (!selected) return null
        if (!["ask", "full"].includes(selected.id)) throw new Error("Use /access ask or /access full.")
        saveSettings({ access: selected.id }, home)
        yesMode = selected.id === "full"
        for (const renderer of renderers.values()) renderer.state.yes = yesMode
        screen?.setContext({ yes: yesMode })
        log(c.dim(yesMode ? "Full Access saved. No repeated permission prompts." : "Ask before changes saved."))
        return null
      }
      case "theme": {
        const selected = args[0] ? { id: args[0] } : await input.pick(Object.entries(THEMES).map(([id, t]) => ({ id, label: t.name, description: id })), "Choose a terminal theme")
        if (selected) await runCommand(context(), ["theme", selected.id])
        return null
      }
      case "provider":
      case "profile": {
        if (args.length) {
          if (await runCommand(context(), ["provider", ...args])) await refresh()
          return null
        }
        const action = await input.pick([
          { id: "list", label: "List providers", description: "Ready state, provider name and current model." },
          { id: "add", label: "Add a provider", description: "Guided: API format, URL, model and a hidden key." },
          { id: "remove", label: "Remove a custom provider", description: "Built-in providers stay available." },
          { id: "key", label: "Save an API key", description: "Stored locally, never shown in the transcript." },
          { id: "test", label: "Test a provider", description: "Ask the endpoint for its model list." },
        ], "Provider manager")
        if (!action) return null
        if (await runCommand(context(), ["provider", action.id])) await refresh()
        return null
      }
      case "auth":
        if (!args.length) {
          const choice = await input.pick(profiles.filter((p) => !p.derivedFrom).map((p) => ({ ...p, label: providerName(p, profiles), description: p.hasKey || p.noAuth ? "Key configured" : "No key" })), "Save a provider key")
          if (choice) await runCommand(context(), ["auth", "add", choice.id])
        } else await runCommand(context(), ["auth", ...args])
        await refresh(); return null
      default: {
        const parsed = require("./vibe").parseArgs([name.toLowerCase(), ...args])
        if (await runCommand(context({ flags: { ...context().flags, ...parsed.flags } }), parsed.rest)) { await refresh(); return null }
        // Leave known recipes (and ordinary unknown slash text) to the engine.
        return line
      }
    }
  }

  try {
    if (off.ready) await off.ready
    await refresh()
    if (screen) { screen.setHistory(session); screen.open() }
    else {
      log(c.accent("◆ ") + c.bold("VibeCoder") + c.dim("  " + require("../package.json").version))
      log(c.dim(`${path.basename(dir)}  ${connection ? "attached to " + connection.url : "standalone engine"}\n${dir}`))
      log(c.dim("Ctrl+P commands   /model provider picker   /help all controls"))
    }
    if (!profiles.some((p) => !p.disabled && (p.hasKey || p.noAuth))) log(c.yellow("No API key yet. Use /auth to save one, or /profile add to configure a provider."))
    if (!screen && session.messages?.length) printHistory(session, log, 6)
    for (const form of await vibe.forms.list(session.id)) await enqueue({ type: "question.ask", form, sessionId: session.id })
    const pending = await vibe.control.call("permissions.list", { sessionId: session.id, directory: dir })
    for (const p of pending.pending.filter((p) => p.sessionId === session.id)) await enqueue({ type: "permission.ask", permissionId: p.id, tool: p.tool, subject: p.subject, sessionId: session.id })
    while (!exiting && !input.closed) {
      await eventQueue
      const answer = await input.read(label(), { multiline: true, history: stored.history, palette: true, initial: draft })
      draft = ""
      if (answer === null) { if (input.closed || exiting) break; continue }
      if (answer?.action === "palette") {
        const choice = await input.pick(LOCAL_COMMANDS.map((s) => ({ label: "/" + s, value: "/" + s })), "VibeCoder commands")
        draft = choice?.value || answer.draft
        continue
      }
      if (answer?.action === "complete") {
        const choice = await input.pick(answer.choices, "Complete")
        draft = choice?.value || answer.draft
        continue
      }
      if (answer?.action === "access") {
        try { await handleCommand("/access") } catch (error) { log(c.red(error.message)) }
        draft = answer.draft
        continue
      }
      let text = String(answer || "").trim()
      if (!text) continue
      if (stored.history) {
        try { rememberPrompt(text, home); input.history = loadHistory(home) }
        catch (error) { log(c.yellow("History could not be saved; the message can still run. " + error.message)) }
      }
      try {
        if (text.startsWith("/")) {
          screen?.beginCommand(commandName(text))
          try { text = await handleCommand(text) } finally { screen?.endCommand() }
          if (text === null || exiting) continue
        }
        const displayText = text
        const expanded = expandFileMentions(text, dir)
        screen?.userMessage(displayText, expanded.files)
        for (const miss of expanded.missing) log(c.yellow("Not attached: " + miss))
        if (expanded.inlined.length) log(c.dim("Attached: " + expanded.inlined.map((f) => f.path).join(", ")))
        const state = await vibe.control.call("session.state", { sessionId: session.id })
        if (state.busy) {
          try {
            await vibe.control.call("session.queue", { sessionId: session.id, text: expanded.text, files: expanded.files })
            log(c.dim("Message queued for the next safe tool boundary."))
            continue
          } catch (error) {
            if (!/not running/i.test(error.message)) throw error
          }
        }
        for await (const event of vibe.session.prompt(session.id, expanded.text, { files: expanded.files, reasoningEffort: flags.thinking, summaryModel: flags.summaryModel, maxSteps: flags.steps })) await enqueue(event)
        await eventQueue
        await refresh()
      } catch (error) { log(c.red("Error: " + error.message)) }
    }
  } finally {
    closing = true
    off()
    input.off("SIGINT", interrupted)
    input.off("background", background)
    input.close()
    // Only runs owned by this local CLI are stopped at an explicit exit.
    if (vibe.mode === "inproc") for (const id of owned) await stopSessionWork(vibe, id).catch(() => {})
    await eventQueue
    await autoCrew
  }
}

module.exports = { runChat, expandFileMentions, commandName, completer, printHistory, LOCAL_COMMANDS, HELP }
