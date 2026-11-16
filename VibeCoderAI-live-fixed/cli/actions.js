"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { c, table, clip, tokens, money, when } = require("./ui")
const { THEMES, configureTheme, safeText, providerName } = require("./theme")
const settings = require("./settings")
const { publicData } = require("../core/control")

const COMMANDS = ["help", "chat", "run", "resume", "serve", "attach", "models", "provider", "profile", "auth", "sessions", "session", "compact", "undo", "redo", "steps", "diff", "usage", "skills", "playbooks", "agents", "recipes", "mcp", "plugins", "extensions", "tools", "doctor", "memory", "config", "access", "permissions", "locks", "forms", "crew", "shells", "shell", "trail", "todos", "browser", "marketplace", "registry", "theme", "init", "completion"]
const HELP = `vibe - VibeCoder coding agent CLI

  vibe / vibe chat             interactive agent, pickers and multiline composer
  vibe run "<prompt>"          run a task; stream tools, Crew and shell results
  vibe resume <session>        continue the same interrupted turn
  vibe attach                  use a running desktop/serve engine (real browser)
  vibe serve [--port 4096]      authenticated local HTTP + SSE host

  vibe models / provider       catalog, guided add/remove, key test and models
  vibe profile / auth          advanced profile JSON and secure key commands
  vibe sessions / session      list, show, rename, export/import, remove
  vibe skills / playbooks      list/show/install/remove, GitHub import
  vibe agents                 list/show/install/remove agent definitions
  vibe recipes                list/show/install/remove prompt templates
  vibe mcp                    list/add/remove/status/resources/read/auth
  vibe plugins / extensions   list/install/reload/remove reviewed local JS
  vibe tools                  built-in, Crew, extension and MCP tools
  vibe marketplace / registry catalogs and reviewed installs
  vibe memory / todos / trail persistent notes, plan and audit log
  vibe permissions / locks    scoped rules and pending requests
  vibe crew / shell / shells  details, resume/stop, live output/input
  vibe undo / redo / steps     turn and step Rewind; vibe diff for previews
  vibe compact / config       context summaries and settings
  vibe usage                  tokens, reasoning, cache and cost
  vibe theme [name]            terminal colors
  vibe doctor                 paths, keys, counts and host diagnostics
  vibe init / completion      safe scaffolding and shell completions

Options
  -C, --dir <folder>   -s, --session <id>   -c, --continue
  -m, --model <profile or provider/model>  -a, --agent <id>
  --attach            --url <loopback URL>  (token from $VIBE_TOKEN)
  --yes               approve prompts, never bypass Guardrails/Locks
  --access full|ask   save the CLI's permission mode across restarts
  --json              NDJSON runs or JSON inspection; no ANSI
  --theme <name>      --plain    --reasoning    --thinking <none|low|medium|high>
  --verbose           --quiet    --all    --global    --file <path>
  --limit <n>         --steps <n>    --output <new file>     --version

Examples
  vibe chat -C C:\\Projects\\my-app
  vibe run "Review @src/app.js" --agent explore
  vibe skills install review --file PLAYBOOK.md
  vibe mcp add local-tools local -- node server.js
  vibe shell output <shell-id> --session <session-id>
  vibe config set compaction.keep.tokens 12000
  vibe session export <session-id> --output chat.json

Attach text/images with @path/to/file or @"path with spaces".
Inside chat: /help or Ctrl+P. Enter sends; Alt+Enter/Ctrl+J adds a line.
Tab completes slash commands and @files; ↑/↓ recalls private, redacted history.
Themes: ${Object.keys(THEMES).join(", ")}. Font size belongs to your terminal.
Stores: $VIBE_HOME (default ~/.vibe). No new runtime dependencies.
`

function splitCommand(text) {
  return [...String(text).matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}
function valueOf(raw) {
  try { return JSON.parse(raw) } catch { return raw }
}
function fileText(file, dir, max = 1024 * 1024) {
  if (!file) throw new Error("Supply a local file with --file <path>.")
  const full = path.resolve(dir, file)
  if (fs.statSync(full).size > max) throw new Error("This file exceeds the import size limit.")
  return fs.readFileSync(full, "utf8").replace(/^\uFEFF/, "")
}
function writeNewFile(file, dir, content) {
  if (!file) throw new Error("Choose a new output file with --output <path>.")
  const full = path.resolve(dir, file)
  fs.writeFileSync(full, content, { flag: "wx", mode: 0o600 })
  return full
}
function modelChoices(profiles) {
  return profiles.filter((p) => !p.derivedFrom && !p.disabled).flatMap((p) => {
    const models = p.models?.length ? p.models : [{ id: p.model }]
    return models.map((m) => ({
      id: p.models?.length ? `${p.id}/${m.id}` : p.id,
      label: m.name || m.id,
      description: providerName(p, profiles) + (p.hasKey || p.noAuth ? "" : " (no key)"),
      provider: providerName(p, profiles), model: m.id, ready: !!(p.hasKey || p.noAuth),
    }))
  })
}

const PROVIDER_FORMATS = [
  { id: "openai-chat", label: "OpenAI-compatible / Chat Completions", description: "OpenAI, Groq, xAI, DeepSeek, OpenRouter, Ollama and most gateways.", baseURL: "https://api.openai.com/v1" },
  { id: "openai-responses", label: "OpenAI / Responses API", description: "Use when the endpoint implements /v1/responses rather than /chat/completions.", baseURL: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic / Messages API", description: "Claude-compatible endpoints using the Messages format.", baseURL: "https://api.anthropic.com" },
]

async function runCommand(ctx, argv) {
  const { vibe, flags = {}, input } = ctx
  const dir = ctx.dir
  const [name, sub, ...rest] = argv
  const sid = ctx.sessionId || flags.session
  const out = ctx.out || process.stdout
  const log = (s = "") => out.write(String(s) + "\n")
  const print = (value) => log(JSON.stringify(publicData(value), null, 2))
  const show = (value, format) => flags.json || !format ? print(value) : format(value)
  const call = (action, args = {}) => vibe.control.call(action, { directory: dir, sessionId: sid, global: !!flags.global, ...args })
  const requireSession = () => {
    if (!sid) throw new Error("Choose a session with --session <id> (or /use in chat).")
    return sid
  }
  const confirm = async (message) => {
    if (flags.yes && !ctx.inChat) return true
    if (!input || !process.stdin.isTTY) throw new Error(message + " Re-run with --yes to confirm.")
    const answer = await input.read(message + " [y/N] ", { interrupt: true })
    return /^(y|yes)$/i.test(String(answer || "").trim())
  }
  const listMarkdown = async (kind, heading) => {
    if (!sub || sub === "list") {
      const rows = await call(kind + ".list", { all: !!flags.all })
      show(rows, (list) => {
        log(table(list.map((r) => [r.id, r.scope, clip(r.name || r.id, 26), clip(r.description, 64)]), ["ID", "Scope", heading, "Description"]))
        if (!list.length) log(c.dim(`None installed. Use: vibe ${name} install <id> --file <path>`))
      })
    } else if (sub === "show") {
      const item = await call(kind + ".show", { id: rest[0] })
      show(item, (row) => log(c.bold(row.name || row.id) + "\n" + (row.body || row.system || "")))
    } else if (sub === "install") {
      const result = await call(kind + ".install", { id: rest[0], content: fileText(flags.file || rest[1], dir) })
      show(result, (r) => log(`Installed ${r.id}: ${r.file}`))
    } else if (sub === "remove" || sub === "rm") {
      if (await confirm(`Remove ${heading.toLowerCase()} "${rest[0]}" from the ${flags.global ? "global" : "project"} scope?`)) print(await call(kind + ".remove", { id: rest[0] }))
    } else if (kind === "skills" && sub === "import") {
      print(await call("skills.import", { source: rest[0] }))
    } else throw new Error(`Usage: vibe ${name} list|show|install|remove${kind === "skills" ? "|import" : ""}`)
  }

  const providerRows = async () => (await vibe.profiles.list()).filter((p) => !p.derivedFrom)
  const customProviders = async () => {
    const builtin = new Set(require("../core/llm/profiles").BUILTIN.map((p) => p.id))
    return (await providerRows()).filter((p) => !builtin.has(p.id))
  }
  const askLine = async (label, options = {}) => {
    if (!input) throw new Error("This guided setup needs a terminal. Use the flag form instead.")
    return input.read(label, { interrupt: true, ...options })
  }
  const askPick = async (rows, label) => {
    if (!input) throw new Error("This guided setup needs a terminal. Pass the ID as an argument instead.")
    return input.pick(rows, label)
  }
  const saveProviderKey = async (id) => {
    const key = String(await askLine(`API key for ${id} (hidden, Enter to skip): `, { secret: true }) || "").trim()
    if (!key) return false
    await vibe.profiles.setKey(id, key)
    log(c.dim("Key saved securely in the local auth store."))
    return true
  }
  const providerWizard = async () => {
    const format = await askPick(PROVIDER_FORMATS, "Choose the provider API format")
    if (!format) return null
    const id = String(await askLine("Provider ID (letters, numbers, dots, dashes, underscores): ") || "").trim()
    if (!id) throw new Error("A provider ID is required.")
    const baseURL = String(await askLine(`API base URL [${format.baseURL}]: `, { initial: format.baseURL }) || "").trim() || format.baseURL
    const model = String(await askLine("Model ID (for example gpt-4.1 or llama3.3): ") || "").trim()
    if (!model) throw new Error("A model ID is required.")
    const limitText = String(await askLine("Context window in tokens [auto]: ") || "").trim()
    let contextLimit = Number(limitText) || 0, maxOutput = 8192
    if (!contextLimit) {
      try {
        const meta = await require("../core/llm/provider-meta").lookupModel({ modelId: model, baseURL, format: format.id })
        contextLimit = meta.context || 0
        maxOutput = meta.output || maxOutput
      } catch {}
    }
    const profile = {
      id, name: id, label: id, format: format.id, baseURL, model,
      contextLimit: contextLimit || 128000, maxOutput,
      apiKeyEnv: id.toUpperCase().replace(/\W/g, "_") + "_API_KEY",
    }
    let result = await call("profiles.save", { profile })
    for (const hint of result.hints || []) log(c.dim("fixed: " + hint))
    if (!(await saveProviderKey(id))) {
      const keyless = await askLine("Does this endpoint work without a key? [y/N] ")
      if (/^(y|yes)$/i.test(String(keyless || "").trim())) {
        result = await call("profiles.save", { profile: { ...profile, noAuth: true } })
        log(c.dim("Saved as a keyless endpoint (noAuth)."))
      } else log(c.yellow(`No key saved yet. Add one later with: vibe auth add ${id}`))
    }
    log(`Provider "${id}" saved. Test it with: vibe provider test ${id}`)
    return result
  }
  const providerRemove = async () => {
    const rows = await customProviders()
    if (!rows.length) throw new Error("No custom providers to remove. Built-in providers stay available; add one with: vibe provider add")
    const wanted = rest[0]
    const target = wanted
      ? rows.find((p) => p.id === wanted) || (() => { throw new Error(`"${wanted}" is built-in or not a custom provider.`) })()
      : await askPick(rows.map((p) => ({ ...p, label: providerName(p, rows), description: `${p.model}${p.hasKey || p.noAuth ? "" : " (no key)"}` })), "Remove a custom provider")
    if (!target) return null
    if (!(await confirm(`Remove provider "${target.id}" and its saved key?`))) return null
    print(await call("profiles.remove", { id: target.id }))
  }
  const providerTarget = async (label) => {
    const rows = await providerRows()
    const wanted = rest[0]
    if (wanted) return rows.find((p) => p.id === wanted) || (() => { throw new Error(`Unknown provider "${wanted}".`) })()
    return askPick(rows.map((p) => ({ ...p, label: providerName(p, rows), description: `${p.model}${p.hasKey || p.noAuth ? "" : " (no key)"}` })), label)
  }
  const runLegacyProfileAdd = async (id, format, baseURL, model, limit) => {
    if (!id || !format || !baseURL || !model) throw new Error("usage: vibe profile add <id> <format> <baseURL> <model> [contextLimit]")
    let contextLimit = Number(limit) || 0, maxOutput = 8192
    if (!contextLimit) {
      try {
        const meta = await require("../core/llm/provider-meta").lookupModel({ modelId: model, baseURL, format })
        contextLimit = meta.context || 0
        maxOutput = meta.output || maxOutput
      } catch {}
    }
    const result = await call("profiles.save", { profile: { id, name: id, label: id, format, baseURL, model, contextLimit: contextLimit || 128000, maxOutput, apiKeyEnv: id.toUpperCase().replace(/\W/g, "_") + "_API_KEY" } })
    show(result, (r) => {
      for (const hint of r.hints || []) log(c.dim("fixed: " + hint))
      log(`Provider "${id}" saved. Now save its key: vibe provider key ${id}`)
    })
  }

  switch (name) {
    case "help": log(HELP); break
    case "skills":
    case "playbooks": await listMarkdown("skills", "Playbook"); break
    case "agents": await listMarkdown("agents", "Agent"); break
    case "recipes": await listMarkdown("recipes", "Recipe"); break
    case "models": {
      const list = await vibe.profiles.list()
      show(list.map((p) => publicData(p)), () => {
        if (!ctx.inChat) {
          // Keep the original script-friendly profile/format/model columns.
          for (const p of list) log(`${p.hasKey || p.noAuth ? "*" : " "} ${p.id.padEnd(22)} ${String(p.format || "").padEnd(17)} ${p.model}`)
          log(c.dim("\n* = ready (key set). Add a key: vibe auth add <profile>"))
          return
        }
        for (const provider of list.filter((p) => !p.derivedFrom && !p.disabled)) {
          log(c.bold(providerName(provider, list)))
          for (const row of modelChoices([provider])) log(`  ${row.ready ? "*" : " "} ${row.model}`)
        }
        log(c.dim("\n* = key configured. Save a key: vibe auth add <profile ID>. /model opens the picker."))
      })
      break
    }
    case "provider":
      if (!sub || sub === "list") {
        const rows = await providerRows()
        show(rows.map((p) => publicData(p)), () => {
          log(table(rows.map((p) => [p.hasKey || p.noAuth ? "*" : " ", p.id, providerName(p, rows), p.model]), ["", "ID", "Provider", "Model"]))
          log(c.dim("\n* = ready. Add: vibe provider add   Remove: vibe provider remove"))
          log(c.dim("Key: vibe provider key   Test: vibe provider test   Models: vibe provider models"))
        })
      } else if (sub === "add") {
        if (rest.length >= 4) await runLegacyProfileAdd(rest[0], rest[1], rest[2], rest[3], rest[4])
        else await providerWizard()
      } else if (["remove", "rm"].includes(sub)) await providerRemove()
      else if (sub === "key" || sub === "auth") {
        const target = await providerTarget("Save a provider key")
        if (target && !(await saveProviderKey(target.id))) log(c.dim("No key saved."))
      } else if (sub === "test") {
        const target = await providerTarget("Test a provider")
        if (target) {
          try {
            const models = await call("profiles.models", { id: target.id })
            log(c.green(`Connected. ${models.length} model(s) listed by ${providerName(target, await providerRows())}.`))
            for (const model of models.slice(0, 8)) log(c.dim(`  ${model.id}`))
            if (models.length > 8) log(c.dim(`  ... ${models.length - 8} more`))
          } catch (error) {
            throw new Error(`Provider test failed: ${error.message}`)
          }
        }
      } else if (sub === "models") {
        const target = await providerTarget("List provider models")
        if (target) print(await call("profiles.models", { id: target.id }))
      } else if (sub === "show") {
        const target = await providerTarget("Show a provider")
        if (target) print(target)
      } else throw new Error("Usage: vibe provider list|add|remove|key|test|models|show [id]")
      break
    case "profile":
      if (!sub || sub === "list") print(await call("profiles.list"))
      else if (sub === "add" && !rest.length) await providerWizard()
      else if (sub === "add") await runLegacyProfileAdd(rest[0], rest[1], rest[2], rest[3], rest[4])
      else if (sub === "import") print(await call("profiles.save", { profile: JSON.parse(fileText(flags.file || rest[0], dir)) }))
      else if (sub === "show") {
        const row = (await call("profiles.list")).find((p) => p.id === rest[0])
        if (!row) throw new Error("Unknown provider profile.")
        print(row)
      } else if (sub === "models") print(await call("profiles.models", { id: rest[0] }))
      else if (["remove", "rm"].includes(sub)) {
        if (rest[0]) {
          if (await confirm(`Remove custom provider "${rest[0]}" and its saved key?`)) print(await call("profiles.remove", { id: rest[0] }))
        } else await providerRemove()
      } else throw new Error("Usage: vibe profile add|import|show|models|remove")
      break
    case "auth": {
      const id = rest[0]
      if (!id || !["add", "rm", "remove"].includes(sub)) throw new Error("usage: vibe auth add|rm <profile>")
      if (!(await vibe.profiles.list()).some((p) => p.id === id)) throw new Error(`Unknown profile "${id}". Run: vibe models`)
      if (sub !== "add") { await vibe.profiles.setKey(id, ""); show({ removed: true }, () => log("Key removed.")); break }
      const key = input
        ? await input.read(`API key for ${id}: `, { secret: true, interrupt: true })
        : fileTextInput(4096)
      if (!String(key || "").trim()) throw new Error("No key saved: the input was empty or cancelled.")
      await vibe.profiles.setKey(id, String(key).trim())
      show({ saved: true }, () => log("Saved."))
      break
    }
    case "sessions": {
      const rows = await vibe.session.list(flags.all ? {} : { dir })
      show(rows, (list) => {
        log(table(list.map((s) => [s.id, when(s.updatedAt), s.profile || "", clip(s.title, 48)]), ["Session", "Updated", "Model", "Title"]))
        if (!list.length) log(c.dim("No sessions yet. Start one with: vibe chat"))
        else log(c.dim("\nResume: vibe resume <session>. Continue newest: vibe chat -c"))
      })
      break
    }
    case "session": {
      const id = rest[0] || sid
      if (sub === "show") print(await vibe.session.get(id))
      else if (sub === "rename") print(await vibe.session.rename(id, rest.slice(1).join(" ")))
      else if (["remove", "rm"].includes(sub)) {
        if (await confirm(`Delete session "${id}" and its history?`)) { await vibe.session.remove(id); print({ removed: true }) }
      } else if (sub === "export") {
        const data = await call("session.export", { sessionId: id })
        if (flags.output || rest[1]) log(writeNewFile(flags.output || rest[1], dir, JSON.stringify(data, null, 2)))
        else print(data)
      } else if (sub === "import") print(await call("session.import", { data: JSON.parse(fileText(flags.file || rest[0], dir, 16 * 1024 * 1024)), profile: flags.model }))
      else throw new Error("Usage: vibe session show|rename|remove|export <id>, or import --file <export>")
      break
    }
    case "compact": {
      const result = await vibe.session.compact(sub || requireSession(), { summaryModel: flags.summaryModel })
      show(result, (r) => log(r.summarized ? `Compacted: ~${r.before} -> ~${r.after} tokens` : "Nothing old enough to summarize."))
      break
    }
    case "undo": print(await vibe.session.undo(sub || requireSession(), rest[0])); break
    case "redo": print(await vibe.session.redo(sub || requireSession())); break
    case "steps": print(await vibe.session.snapshotSteps(sub || requireSession())); break
    case "diff": print(await vibe.session.snapshotPreview(sub || requireSession(), { turn: rest[0] ? Number(rest[0]) : undefined, step: rest[1] ? Number(rest[1]) : undefined })); break
    case "usage": {
      const data = await call("usage.get", { sessionId: sub || sid, all: !!flags.all })
      show(data, (r) => {
        if (r.sessions) log(table(r.sessions.map((s) => [s.session, tokens(s.input), tokens(s.output), s.cost === null ? "unknown" : money(s.cost), clip(s.title, 36)]), ["Session", "Input", "Output", "Cost", "Title"]))
        else log(`Session ${r.session}\n  input      ${tokens(r.input)} tokens\n  output     ${tokens(r.output)} tokens\n  reasoning  ${tokens(r.reasoning)} tokens\n  cache      ${tokens(r.cacheRead)} read / ${tokens(r.cacheWrite)} write`)
        log(`  cost       ${r.cost === null || r.unknownCost ? `${money(r.cost) || "unknown"} (some charges unknown)` : money(r.cost)}`)
      })
      break
    }
    case "memory":
      if (!sub || sub === "list") show(await call("memory.list"), (r) => {
        log(table(r.entries.map((e) => [e.id, e.date || "", clip(e.text, 88)]), ["ID", "Date", "Memory"]))
        log(c.dim(r.file))
      })
      else if (sub === "add") print(await call("memory.add", { text: rest.join(" ") }))
      else if (["remove", "rm"].includes(sub)) {
        if (await confirm(`Remove memory "${rest[0]}"?`)) print(await call("memory.remove", { id: rest[0] }))
      } else throw new Error("Usage: vibe memory list|add <text>|remove <id>")
      break
    case "config":
      if (!sub || sub === "get" || sub === "show") print(await call("config.get"))
      else if (sub === "set") print(await call("config.set", { key: rest[0], value: valueOf(rest.slice(1).join(" ")) }))
      else throw new Error("Usage: vibe config get|set <compaction.key> <value>")
      break
    case "theme":
      if (!sub || sub === "list") show({ current: settings.loadSettings(ctx.home).theme, themes: Object.keys(THEMES) }, (r) => {
        log(table(r.themes.map((id) => [id === r.current ? "*" : "", id, THEMES[id].name]), ["", "Theme", "Name"]))
        log(c.dim("Set: vibe theme obsidian. Terminal font size is controlled by the terminal application."))
      })
      else {
        settings.saveSettings({ theme: sub }, ctx.home)
        configureTheme(sub)
        show({ theme: sub }, () => log(`Terminal theme: ${THEMES[sub].name}`))
      }
      break
    case "access":
      if (!sub) print({ access: settings.loadSettings(ctx.home).access })
      else {
        if (!["ask", "full"].includes(sub)) throw new Error("Use vibe access ask or vibe access full.")
        settings.saveSettings({ access: sub }, ctx.home)
        show({ access: sub, saved: true }, () => log(sub === "full" ? "Full Access saved. Permission requests auto-approved; hard Locks and agent denies still apply." : "Ask before changes saved."))
      }
      break
    case "mcp": {
      if (!sub || sub === "list") show(await call("mcp.list"), (rows) => {
        log(table(rows.map((r) => [r.name, r.scope, r.type, clip(r.url || publicData((r.command || []).join(" ")), 76)]), ["Name", "Scope", "Type", "Target"]))
        if (!rows.length) log(c.dim("No MCP servers configured."))
        log(c.dim(`Global config: ${path.join(ctx.home, "mcp.json")}\nProject config: ${path.join(dir, ".vibe", "mcp.json")}`))
      })
      else if (sub === "add") {
        const [id, type, ...target] = rest
        const extra = flags.file ? JSON.parse(fileText(flags.file, dir)) : {}
        print(await call("mcp.add", { ...extra, name: id, type: type || extra.type, ...(type === "remote" ? { url: target[0] } : target.length ? { command: target } : {}) }))
      } else if (["remove", "rm"].includes(sub)) {
        if (await confirm(`Remove MCP "${rest[0]}" from the ${flags.global ? "global" : "project"} scope?`)) print(await call("mcp.remove", { name: rest[0] }))
      } else if (sub === "status") print(await call("mcp.status"))
      else if (sub === "resources") print(await vibe.connectors.resources({ connector: rest[0], directory: dir }))
      else if (sub === "templates") print(await vibe.connectors.templates({ connector: rest[0], directory: dir }))
      else if (sub === "read") print(await vibe.connectors.read({ connector: rest[0], uri: rest[1], directory: dir }))
      else if (sub === "auth") {
        const redirectUri = rest[1]
        if (!redirectUri || !input) throw new Error("Use vibe mcp auth <name> <registered redirect URL> in a terminal.")
        const started = await vibe.connectors.beginOAuth({ connector: rest[0], redirectUri, directory: dir })
        log(`Open this authorization URL:\n${started.url}`)
        const callback = await input.read("Paste the returned callback URL: ", { secret: true, interrupt: true })
        if (!callback) throw new Error("Authorization cancelled.")
        const url = new URL(callback)
        if (url.searchParams.get("state") !== started.state) throw new Error("OAuth state did not match; no token was exchanged.")
        print(await vibe.connectors.completeOAuth({ state: started.state, code: url.searchParams.get("code") }))
      } else if (sub === "logout") print({ cleared: await vibe.connectors.clearOAuth({ connector: rest[0], directory: dir }) })
      else throw new Error("Usage: vibe mcp list|add|remove|status|resources|templates|read|auth|logout")
      break
    }
    case "plugins":
    case "extensions":
      if (!sub || sub === "list") {
        const rows = await call("extensions.list")
        show(name === "plugins" ? rows.filter((r) => r.legacy) : rows, (list) => {
          log(table(list.map((r) => [r.id, r.scope, r.loaded ? r.ok ? "loaded" : "error" : "not loaded", clip(r.error, 65)]), ["ID", "Scope", "Status", "Error"]))
          if (!list.length) log(c.dim("No extensions installed."))
        })
      } else if (sub === "install") {
        if (name === "plugins" && flags.spec) {
          if (await confirm("Fetch this reviewed package using your npm and load its JavaScript with your user account?")) print(await call("plugins.fetch", { spec: flags.spec }))
          break
        }
        const file = flags.file || rest[0]
        const id = flags.file ? rest[0] : rest[1] || path.basename(file || "", ".js")
        if (await confirm("This JavaScript runs with your user account on reload/agent runs. Install the reviewed local file?")) print(await call("extensions.install", { id, content: fileText(file, dir), legacy: name === "plugins" }))
      } else if (["remove", "rm"].includes(sub)) {
        if (await confirm(`Remove extension "${rest[0]}" from the ${flags.global ? "global" : "project"} scope?`)) print(await call("extensions.remove", { id: rest[0], legacy: name === "plugins" }))
      } else if (sub === "reload") print(await call("extensions.reload"))
      else throw new Error(`Usage: vibe ${name} list|install <file.js> [id]|reload|remove <id>`)
      break
    case "tools": {
      const data = await call("tools.list")
      show(data, (r) => {
        const rows = [...r.builtin, ...r.extensions, ...r.mcp, ...r.crew]
        log(table(rows.map((t) => [t.name, clip(t.description, 84)]), ["Tool", "Description"]))
        log(c.dim(`\n${rows.length} tool(s). MCP tools appear after connection; installed extensions share the engine's lifecycle.`))
      })
      break
    }
    case "permissions":
    case "locks":
      if (!sub || sub === "list") {
        const data = await call("permissions.list")
        print(name === "locks" ? data.locks : data)
      } else if (sub === "add") print(await call("permissions.add", { tool: rest[0], pattern: rest[1], effect: rest[2] }))
      else if (sub === "clear") {
        requireSession()
        if (await confirm("Clear this session's saved approvals? Hard Locks and agent rules stay unchanged.")) print(await call("permissions.clear"))
      } else if (sub === "reply") print(await call("permission.reply", { id: rest[0], decision: rest[1] }))
      else throw new Error("Usage: vibe permissions list|add <tool> <pattern> <effect>|clear|reply <id> <decision>")
      break
    case "forms":
      if (!sub || sub === "list") print(await vibe.forms.list(sid))
      else if (sub === "reply") print(await vibe.forms.reply(rest[0], JSON.parse(fileText(flags.file || rest[1], dir))))
      else if (sub === "cancel") print(await vibe.forms.cancel(rest[0], rest.slice(1).join(" ") || "Cancelled in the terminal"))
      else throw new Error("Usage: vibe forms list|reply <id> --file <answers.json>|cancel <id>")
      break
    case "crew":
      if (!sub || sub === "list") print(await call("crew.list"))
      else if (["show", "result", "status"].includes(sub)) print(await call("crew.show", { id: rest[0] }))
      else if (sub === "start") { requireSession(); print(await call("crew.start", { agent: rest[0], task: rest.slice(1).join(" "), background: true, maxSteps: flags.steps })) }
      else if (sub === "stop") print(await call("crew.stop", { id: rest[0] }))
      else if (sub === "resume") print(await call("crew.resume", { id: rest[0], text: rest.slice(1).join(" ") }))
      else if (sub === "settings") print(await call("crew.settings", rest[0] === "parallel" ? { maxParallel: Number(rest[1]) } : rest[0] ? { enabled: valueOf(rest[0]) } : {}))
      else throw new Error("Usage: vibe crew list|show|start <agent> <task>|stop|resume|settings")
      break
    case "shells": print(await call("shells.list")); break
    case "shell":
      if (!sub || sub === "list") print(await call("shells.list"))
      else if (sub === "output") {
        const result = await call("shells.output", { id: rest[0], max: flags.limit, sinceBytes: flags.since })
        show(result, (r) => { log(`Shell ${r.shell.id}: ${r.shell.status} (exit ${r.shell.exit ?? "?"})`); log(safeText(r.text || "")) })
      } else if (sub === "input") { requireSession(); print(await call("shells.input", { id: rest[0], text: rest.slice(1).join(" ") })) }
      else if (sub === "eof") { requireSession(); print(await call("shells.input", { id: rest[0], eof: true, newline: false })) }
      else if (sub === "background") { requireSession(); print(await call("shells.background", { id: rest[0] })) }
      else if (sub === "stop") { requireSession(); print(await call("shells.stop", { id: rest[0] })) }
      else throw new Error("Usage: vibe shell list|output|input|eof|background|stop <shell ID>")
      break
    case "trail": print(await call("trail.list", { sessionId: sub || requireSession(), limit: flags.limit })); break
    case "todos":
      requireSession()
      if (!sub || sub === "list") print(await call("todos.list"))
      else if (sub === "set") print(await call("todos.save", { items: JSON.parse(fileText(flags.file || rest[0], dir)) }))
      else throw new Error("Usage: vibe todos list|set --file <array.json>")
      break
    case "registry":
      if (!sub || sub === "list") print(await call("registry.list"))
      else if (sub === "add") print(await call("registry.add", { name: rest[0], url: rest[1] }))
      else if (["remove", "rm"].includes(sub)) print(await call("registry.remove", { id: rest[0] }))
      else throw new Error("Usage: vibe registry list|add <name> <URL>|remove <id>")
      break
    case "marketplace":
      if (!sub || sub === "list") show(await call("marketplace.list"), (r) => {
        log(table(r.items.map((i) => [i.kind, i.id, i.source, clip(i.title || i.name || i.description, 70)]), ["Kind", "ID", "Source", "Description"]))
        for (const reg of r.registries) if (reg.error) log(c.yellow(`${reg.name}: ${reg.error}`))
      })
      else if (sub === "install") {
        if (await confirm("Install this catalog item? MCP commands and JS extensions run with your user account.")) print(await call("marketplace.install", { kind: rest[0], id: rest[1], source: rest[2] }))
      } else throw new Error("Usage: vibe marketplace list|install <kind> <id> [source]")
      break
    case "browser": {
      const command = sub || "tabs"
      const args = { tabID: rest[0] }
      if (command === "open") args.url = rest[0]
      if (command === "navigate") args.url = rest[1]
      if (command === "click" || command === "fill") args.ref = rest[1]
      if (command === "fill") args.text = rest.slice(2).join(" ")
      if (command === "press") args.key = rest[1]
      if (command === "scroll") args.deltaY = Number(rest[1]) || 600
      if (command === "evaluate") args.script = flags.file ? fileText(flags.file, dir) : rest.slice(1).join(" ")
      if (command === "wait") args.selector = rest[1]
      const result = await call("browser." + command, args)
      if (!result.ok) throw new Error(result.error + " Start the desktop app and use vibe attach for browser features.")
      if (command === "screenshot" && flags.output) log(writeNewFile(flags.output, dir, Buffer.from(result.data.data, "base64")))
      else print(result.data || { ok: true })
      break
    }
    case "init": print(await call("project.init")); break
    case "completion": log(completionScript(sub)); break
    case "doctor": {
      const info = await call("info")
      const profiles = await vibe.profiles.list()
      const ready = profiles.filter((p) => !p.disabled && (p.hasKey || p.noAuth))
      const [playbooks, personas, mcpRows, extensions, sessions] = await Promise.all([
        call("skills.list"), call("agents.list"), call("mcp.list"), call("extensions.list"), vibe.session.list({ dir }),
      ])
      const data = { node: process.version, platform: `${process.platform} ${process.arch}`, dir, home: info.home, mode: vibe.mode, browser: info.browser, profiles: { total: profiles.length, ready: ready.length, readyIDs: ready.map((p) => p.id) }, skills: playbooks.length, agents: personas.length, mcpServers: mcpRows.length, plugins: extensions.length, sessions: sessions.length }
      show(data, (r) => {
        log(c.bold("VibeCoder CLI doctor"))
        for (const [key, value] of Object.entries({ node: `${r.node} (${r.platform})`, folder: dir, home: r.home, mode: r.mode, browser: r.browser ? "desktop host connected" : "use vibe attach for browser control", models: `${r.profiles.ready}/${r.profiles.total} ready`, skills: r.skills, agents: r.agents, mcp: r.mcpServers, extensions: r.plugins, sessions: r.sessions })) log(`  ${key.padEnd(12)} ${value}`)
        if (!ready.length) log(c.yellow("\nNo API keys configured. Run vibe models, then vibe auth add <profile>."))
      })
      break
    }
    default: return false
  }
  return true
}

function fileTextInput(max) {
  const text = fs.readFileSync(0, "utf8")
  if (Buffer.byteLength(text, "utf8") > max) throw new Error("Input exceeds the secret size limit.")
  return text
}
function completionScript(shell) {
  const words = COMMANDS.join(" ")
  if (shell === "bash") return `_vibe_complete() { COMPREPLY=( $(compgen -W "${words}" -- "\${COMP_WORDS[COMP_CWORD]}") ); }\ncomplete -F _vibe_complete vibe`
  if (shell === "zsh") return `#compdef vibe\n_arguments '1:command:(${words})' '*:file:_files'`
  if (shell === "fish") return COMMANDS.map((s) => `complete -c vibe -n '__fish_use_subcommand' -a ${s}`).join("\n")
  if (["powershell", "pwsh"].includes(shell)) return `Register-ArgumentCompleter -Native -CommandName vibe -ScriptBlock {\n  param($wordToComplete, $commandAst, $cursorPosition)\n  '${words}'.Split(' ') | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {\n    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)\n  }\n}`
  throw new Error("Choose completion bash|zsh|fish|powershell.")
}

module.exports = { runCommand, modelChoices, splitCommand, fileText, writeNewFile, valueOf, COMMANDS, HELP, completionScript }
