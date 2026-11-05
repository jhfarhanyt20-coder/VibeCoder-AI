#!/usr/bin/env node
"use strict"
const fs = require("fs")
const path = require("path")
const readline = require("readline")
const { createVibe } = require("../sdk")
const { createServer } = require("./server")

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--yes" || a === "-y") flags.yes = true
    else if (a === "--continue" || a === "-c") flags.continue = true
    else if (a === "-m" || a === "--model") flags.model = argv[++i]
    else if (a === "-C" || a === "--dir") flags.dir = argv[++i]
    else if (a === "-s" || a === "--session") flags.session = argv[++i]
    else if (a === "--port") flags.port = Number(argv[++i])
    else rest.push(a)
  }
  return { flags, rest }
}

const HELP = `vibe - coding agent CLI

  vibe run "<prompt>"       run one task and exit        (-m profile  -C dir  -s session  -c continue  --yes)
  vibe chat                 interactive chat             (/compact  /undo  /model <profile>  /new  /exit)
  vibe serve [--port 4096]  local HTTP+SSE API for the SDK / app
  vibe models               list model profiles
  vibe profile add <id> <openai-chat|openai-responses|anthropic> <baseURL> <model> [contextLimit]
  vibe auth add <profile>   save an API key      (vibe auth rm <profile>)
  vibe sessions             list sessions in this folder
  vibe compact <session>    summarize a session's history now
  vibe resume <session>     continue a failed/interrupted run where it stopped

Default model: $VIBE_MODEL or the first profile that has a key.
Files live in $VIBE_HOME (default ~/.vibe): profiles.json, auth.json, rules.json, sessions/
`

function pickProfile(vibe, wanted) {
  return vibe.profiles.list().then((list) => {
    const id = wanted || process.env.VIBE_MODEL
    if (id) {
      if (!list.find((p) => p.id === id)) throw new Error(`Unknown profile "${id}". Run: vibe models`)
      return id
    }
    const p = list.find((x) => x.hasKey || x.noAuth)
    if (!p) throw new Error("No model has an API key yet. Run: vibe models, then: vibe auth add <profile>")
    return p.id
  })
}

function ask(rl, q) {
  return new Promise((resolve) => rl.question(q, resolve))
}

async function renderEvents(vibe, iterable, rl, state = {}) {
  let midLine = false
  for await (const ev of iterable) {
    switch (ev.type) {
      case "text.delta":
        process.stdout.write(ev.delta)
        midLine = !ev.delta.endsWith("\n")
        break
      case "reasoning.delta":
        if (state.showReasoning) process.stdout.write(dim(ev.delta))
        break
      case "tool.start": {
        if (midLine) process.stdout.write("\n")
        midLine = false
        const brief = ev.args && (ev.args.command || ev.args.path || ev.args.pattern || ev.args.url || "")
        console.log(dim(`> ${ev.name} ${String(brief).replace(/\s+/g, " ").slice(0, 100)}`))
        break
      }
      case "tool.end":
        if (ev.isError) console.log(dim(`  ! ${ev.output.split("\n")[0].slice(0, 160)}`))
        break
      case "todo.update":
        console.log(dim(`  todo ${ev.todos.filter((t) => t.status === "completed").length}/${ev.todos.length}`))
        break
      case "compaction.start":
        console.log(dim(`\n[compacting context (${ev.reason})...]`))
        break
      case "compaction.end":
        console.log(dim(`[compacted: ~${ev.before} -> ~${ev.after} tokens]`))
        break
      case "permission.ask": {
        if (midLine) process.stdout.write("\n")
        midLine = false
        let decision = "deny"
        if (state.yes) decision = "once"
        else if (rl && process.stdin.isTTY) {
          const a = (await ask(rl, bold(`Allow ${ev.tool}: ${String(ev.subject).slice(0, 200)} ? [y]es / [a]lways / [N]o `))).trim().toLowerCase()
          decision = a === "y" || a === "yes" ? "once" : a === "a" || a === "always" ? "always" : "deny"
        } else console.log(dim(`(no terminal to ask, denied: ${ev.tool}) use --yes to allow`))
        await vibe.permission.reply(ev.permissionId, decision)
        break
      }
      case "error":
        console.error("\nError: " + ev.message)
        state.failed = true
        break
      case "done":
        if (midLine) process.stdout.write("\n")
        midLine = false
        if (ev.reason === "max_steps") console.log(dim("[stopped: step limit reached]"))
        if (ev.reason === "stuck") console.log(dim("[stopped: the agent repeated the same call]"))
        if (ev.reason === "length") console.log(dim("[stopped: output length limit]"))
        break
    }
  }
}

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2))
  const cmd = rest[0]
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP)

  const vibe = createVibe({ permission: "ask" })
  const e = vibe.engine

  if (cmd === "models") {
    for (const p of await vibe.profiles.list())
      console.log(`${p.hasKey || p.noAuth ? "*" : " "} ${p.id.padEnd(22)} ${p.format.padEnd(17)} ${p.model}`)
    return console.log(dim("\n* = ready (key set).  Add a key: vibe auth add <profile>"))
  }
  if (cmd === "profile" && rest[1] === "add") {
    const [, , id, format, baseURL, model, ctx] = rest
    if (!id || !format || !baseURL || !model) throw new Error("usage: vibe profile add <id> <format> <baseURL> <model> [contextLimit]")
    // no context limit typed? look the model up (provider -> models.dev -> built-in table)
    let contextLimit = ctx ? Number(ctx) : 0
    let outputLimit = 0
    if (!contextLimit) {
      const pmeta = require("../core/llm/provider-meta")
      try {
        const guess = pmeta.repairBaseUrl(baseURL, format)
        const meta = await pmeta.lookupModel({ modelId: model, baseURL: guess.url, format: guess.format || "chat" })
        if (meta.found && meta.context) {
          contextLimit = meta.context
          outputLimit = meta.output || 0
          console.log(dim(`auto: context ${meta.context}${meta.output ? ` / output ${meta.output}` : ""}${meta.image ? " / images: yes" : ""} (${meta.source})`))
        }
      } catch {}
    }
    const res = await vibe.profiles.upsert({ id, format, baseURL, model, contextLimit: contextLimit || 128000, maxOutput: outputLimit || 8192, apiKeyEnv: id.toUpperCase().replace(/\W/g, "_") + "_API_KEY" })
    for (const h of (res && res.hints) || []) console.log(dim(`fixed: ${h}`))
    return console.log(`Profile "${id}" saved. Now: vibe auth add ${id}`)
  }
  if (cmd === "auth") {
    const id = rest[2]
    if (!id) throw new Error("usage: vibe auth add|rm <profile>")
    if (rest[1] === "rm") return (await vibe.profiles.setKey(id, ""), console.log("Key removed."))
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = (s) => rl.output.write(s.includes("API key") ? s : "")
    const key = (await ask(rl, `API key for ${id}: `)).trim()
    rl.close()
    console.log()
    if (!key) throw new Error("Empty key")
    await vibe.profiles.setKey(id, key)
    return console.log("Saved.")
  }
  if (cmd === "sessions") {
    for (const s of await vibe.session.list({ dir: path.resolve(flags.dir || process.cwd()) }))
      console.log(`${s.id}  ${new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ")}  ${s.profile.padEnd(18)} ${s.title}`)
    return
  }
  if (cmd === "compact") {
    const r = await vibe.session.compact(rest[1])
    return console.log(r.summarized ? `Compacted: ~${r.before} -> ~${r.after} tokens` : "Nothing old enough to summarize.")
  }
  if (cmd === "resume") {
    if (!rest[1]) throw new Error("usage: vibe resume <session>")
    const s = await vibe.session.get(rest[1])
    const state = { yes: !!flags.yes }
    const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
    process.on("SIGINT", () => vibe.session.interrupt(s.id))
    await renderEvents(vibe, vibe.session.resume(s.id), rl, state)
    if (rl) rl.close()
    process.exitCode = state.failed ? 1 : 0
    return
  }
  if (cmd === "serve") {
    const { server, token } = createServer(e)
    const port = flags.port || 4096
    server.listen(port, "127.0.0.1", () => {
      console.log(`vibe serve on http://127.0.0.1:${server.address().port}`)
      console.log(`token: ${token}`)
    })
    return
  }

  const dir = path.resolve(flags.dir || process.cwd())
  const getSession = async () => {
    if (flags.session) return vibe.session.get(flags.session)
    if (flags.continue) {
      const l = await vibe.session.list({ dir })
      if (l.length) return vibe.session.get(l[0].id)
    }
    return vibe.session.create({ dir, profile: await pickProfile(vibe, flags.model) })
  }

  if (cmd === "run") {
    const prompt = rest.slice(1).join(" ").trim()
    if (!prompt) throw new Error('usage: vibe run "<prompt>"')
    const s = await getSession()
    const state = { yes: !!flags.yes }
    const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null
    process.on("SIGINT", () => vibe.session.interrupt(s.id))
    await renderEvents(vibe, vibe.session.prompt(s.id, prompt), rl, state)
    if (rl) rl.close()
    console.log(dim(`session ${s.id}`))
    process.exitCode = state.failed ? 1 : 0
    return
  }

  if (cmd === "chat") {
    let s = await getSession()
    const state = { yes: !!flags.yes, showReasoning: false }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    console.log(dim(`vibe chat - ${s.profile} - ${dir}\n/compact  /undo  /model <profile>  /reasoning  /new  /exit   (Ctrl+C interrupts a running answer)`))
    let busy = false
    rl.on("SIGINT", () => (busy ? vibe.session.interrupt(s.id) : rl.close()))
    for (;;) {
      const line = (await ask(rl, bold("\n> "))).trim()
      if (!line) continue
      if (line === "/exit" || line === "/quit") break
      if (line === "/new") {
        s = await vibe.session.create({ dir, profile: s.profile })
        console.log(dim("new session " + s.id))
        continue
      }
      if (line === "/reasoning") {
        state.showReasoning = !state.showReasoning
        console.log(dim("reasoning " + (state.showReasoning ? "shown" : "hidden")))
        continue
      }
      if (line === "/undo") {
        try {
          const r = await vibe.session.undo(s.id)
          s = await vibe.session.get(s.id)
          console.log(dim(`undone: ${r.restored.length} restored, ${r.deleted.length} deleted, ${r.skipped.length} skipped; ${r.messagesDropped} message(s) dropped`))
          for (const f of [...r.restored, ...r.deleted]) console.log(dim("  " + f))
        } catch (err) {
          console.error("Error: " + err.message)
        }
        continue
      }
      if (line === "/compact") {
        try {
          const r = await vibe.session.compact(s.id)
          console.log(dim(r.summarized ? `compacted ~${r.before} -> ~${r.after} tokens` : "nothing to compact"))
        } catch (err) {
          console.error("Error: " + err.message)
        }
        continue
      }
      if (line.startsWith("/model")) {
        try {
          s = await vibe.session.switchModel(s.id, line.split(/\s+/)[1])
          console.log(dim("model -> " + s.profile))
        } catch (err) {
          console.error("Error: " + err.message)
        }
        continue
      }
      busy = true
      try {
        await renderEvents(vibe, vibe.session.prompt(s.id, line), rl, state)
      } catch (err) {
        console.error("Error: " + err.message)
      }
      busy = false
    }
    rl.close()
    return
  }
  throw new Error(`Unknown command "${cmd}". Run: vibe help`)
}

main().catch((e) => {
  console.error("Error: " + e.message)
  process.exit(1)
})
