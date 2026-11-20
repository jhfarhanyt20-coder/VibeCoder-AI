#!/usr/bin/env node
"use strict"
const path = require("node:path")
const fs = require("node:fs")
const { createVibe, connect } = require("../sdk")
const { homeDir } = require("../core/util")
const { createServer } = require("./server")
const { TerminalInput } = require("./input")
const { c, configureTheme } = require("./theme")
const { loadSettings, saveSettings } = require("./settings")
const { runCommand, HELP, formatHelp } = require("./actions")
const { findHost, loopbackUrl } = require("./connection")
const { runEvents, closeEngine, stopSessionWork } = require("./run")

const OPTIONS = {
  "-m": "model", "--model": "model", "-C": "dir", "--dir": "dir",
  "-s": "session", "--session": "session", "-a": "agent", "--agent": "agent",
  "--port": "port", "--theme": "theme", "--thinking": "thinking", "--summary-model": "summaryModel",
  "--url": "url", "--token": "token", "--file": "file", "--output": "output",
  "--spec": "spec",
  "--limit": "limit", "--since": "since",
  "--steps": "steps",
  "--access": "access",
}
const SWITCHES = {
  "-y": "yes", "--yes": "yes", "-c": "continue", "--continue": "continue",
  "--json": "json", "-v": "verbose", "--verbose": "verbose", "-q": "quiet", "--quiet": "quiet",
  "-V": "version", "--version": "version", "-h": "help", "--help": "help",
  "--attach": "attach", "--plain": "plain", "--no-color": "plain",
  "--global": "global", "--all": "all", "--reasoning": "reasoning",
}
function parseArgs(argv) {
  const flags = {}, rest = []
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === "--") { rest.push(...argv.slice(i + 1)); break }
    const equal = raw.startsWith("--") ? raw.indexOf("=") : -1
    const name = equal >= 0 ? raw.slice(0, equal) : raw
    if (SWITCHES[name]) flags[SWITCHES[name]] = true
    else if (OPTIONS[name]) {
      const value = equal >= 0 ? raw.slice(equal + 1) : argv[++i]
      if (value === undefined || value === "") throw new Error(`${name} needs a value.`)
      const key = OPTIONS[name]
      flags[key] = ["port", "limit", "since", "steps"].includes(key) ? Number(value) : value
      if (["port", "limit", "since", "steps"].includes(key) && (!Number.isInteger(flags[key]) || flags[key] < 0)) throw new Error(`${name} needs a non-negative integer.`)
    } else rest.push(raw)
  }
  if (flags.port > 65535) throw new Error("--port must be 0–65535.")
  if (flags.steps === 0) throw new Error("--steps must be at least 1.")
  if (flags.thinking) flags.thinking = flags.thinking.toLowerCase()
  if (flags.thinking && !["none", "low", "medium", "high"].includes(flags.thinking)) throw new Error("--thinking must be none, low, medium or high.")
  if (flags.access && !["ask", "full"].includes(flags.access)) throw new Error("--access must be ask or full.")
  return { flags, rest }
}

async function pickProfile(vibe, wanted, { allowUnconfigured = false } = {}) {
  const list = await vibe.profiles.list()
  const value = wanted || process.env.VIBE_MODEL
  if (value) return (await vibe.control.call("profiles.resolve", { id: value })).id
  const ready = list.find((p) => !p.disabled && !p.derivedFrom && (p.hasKey || p.noAuth))
  if (ready) return ready.id
  if (allowUnconfigured && list.length) return list.find((p) => !p.disabled)?.id
  throw new Error("No model has an API key yet. Run: vibe models, then: vibe auth add <profile>")
}

async function selectSession(vibe, dir, flags, stored) {
  let session
  if (flags.session) session = await vibe.session.get(flags.session)
  else if (flags.continue) {
    const rows = await vibe.session.list({ dir })
    if (rows.length) session = await vibe.session.get(rows[0].id)
  }
  if (session) {
    if (flags.model) session = await vibe.session.switchModel(session.id, await pickProfile(vibe, flags.model))
    if (flags.agent) await vibe.control.call("agents.select", { sessionId: session.id, id: flags.agent })
    return vibe.session.get(session.id)
  }
  let model = flags.model || process.env.VIBE_MODEL || stored.model
  if (model && !flags.model && !process.env.VIBE_MODEL) {
    try { model = await pickProfile(vibe, model) } catch { model = null }
  }
  const profile = await pickProfile(vibe, model, { allowUnconfigured: true })
  let agent = flags.agent || stored.agent || "build"
  if (!flags.agent && agent !== "build") {
    try { await vibe.control.call("agents.show", { id: agent, directory: dir }) } catch { agent = "build" }
  }
  return vibe.session.create({ dir, profile, agent })
}

async function main(argv = process.argv.slice(2)) {
  const { flags, rest } = parseArgs(argv)
  const command = rest[0]
  if (flags.version) return console.log(require("../package.json").version)
  if (flags.help || command === "help" || !command && !process.stdin.isTTY) return console.log(formatHelp(HELP, { color: !!process.stdout.isTTY && !flags.json }))
  const dir = path.resolve(flags.dir || process.cwd())
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`)
  const stored = loadSettings()
  if (flags.access) {
    saveSettings({ access: flags.access })
    flags.yes = flags.access === "full"
  } else if (flags.yes === undefined) flags.yes = stored.access === "full"
  flags.thinking = flags.thinking || stored.thinking || undefined
  configureTheme(flags.theme || stored.theme, { color: !flags.json && !flags.plain })
  let vibe, connection
  if (flags.attach || command === "attach" || flags.url) {
    connection = flags.url ? { url: loopbackUrl(flags.url), token: flags.token || process.env.VIBE_TOKEN } : await findHost()
    if (!connection.token) throw new Error("A local host token is required. Use vibe attach or set VIBE_TOKEN for --url.")
    vibe = connect(connection)
  } else vibe = createVibe({ permission: "ask", computerUse: stored.computerUse !== false && process.platform === "win32" })
  const info = await vibe.control.call("info", { directory: dir })
  const home = info.home || homeDir()
  if (command === "serve") {
    if (!vibe.engine) throw new Error("vibe serve starts a standalone engine. Do not combine it with --attach.")
    const { server, token } = createServer(vibe.engine)
    server.on("error", (error) => { console.error(`Server error: ${error.message}`); process.exitCode = 1; closeEngine(vibe) })
    server.listen(flags.port ?? 4096, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`
      if (flags.json) console.log(JSON.stringify({ url, version: require("../package.json").version, discoverable: true }))
      else { console.log(`vibe serve on ${url}`); console.log(`token: ${token}`) }
    })
    return
  }
  if (command === "attach" && !process.stdin.isTTY) {
    console.log(JSON.stringify({ mode: "remote", url: connection.url, version: info.version, browser: info.browser }, null, 2))
    return
  }
  const interactive = !command || command === "chat" || command === "attach"
  if (interactive && (!process.stdin.isTTY || flags.json)) throw new Error('vibe chat needs a terminal. Use vibe run "<prompt>" --json for scripts.')
  let input = null
  if (process.stdin.isTTY && !flags.json) input = new TerminalInput({ fullScreen: interactive && !flags.plain && process.env.TERM !== "dumb" })
  try {
    if (interactive) {
      const session = await selectSession(vibe, dir, flags, stored)
      return await require("./chat").runChat({ vibe, dir: session.dir, session, flags, input, home, stored, connection })
    }
    if (command === "run" || command === "resume") {
      const { expandFileMentions } = require("./chat")
      const prompt = command === "run" ? rest.slice(1).join(" ").trim() : null
      if (command === "run" && !prompt) throw new Error('usage: vibe run "<prompt>"')
      if (command === "resume" && !rest[1] && !flags.session) throw new Error("usage: vibe resume <session>")
      const session = command === "resume"
        ? await vibe.session.get(rest[1] || flags.session)
        : await selectSession(vibe, dir, flags, stored)
      let iterable
      if (command === "run") {
        const expanded = expandFileMentions(prompt, session.dir)
        for (const miss of expanded.missing) console.error(c.yellow(`Not attached: ${miss}`))
        iterable = vibe.session.prompt(session.id, expanded.text, { files: expanded.files, reasoningEffort: flags.thinking, summaryModel: flags.summaryModel, maxSteps: flags.steps })
      } else iterable = vibe.session.resume(session.id, { reasoningEffort: flags.thinking, summaryModel: flags.summaryModel, maxSteps: flags.steps })
      const interrupt = () => { input?.cancel(); stopSessionWork(vibe, session.id).catch(() => {}) }
      if (input) input.on("SIGINT", interrupt)
      else process.on("SIGINT", interrupt)
      try {
        const renderer = await runEvents(vibe, iterable, { rl: input, flags, sessionId: session.id })
        if (renderer.state.failed || renderer.state.interrupted) await stopSessionWork(vibe, session.id)
        if (!flags.json && !flags.quiet) console.log(c.dim(`session ${session.id}`))
        process.exitCode = renderer.state.interrupted ? 130 : renderer.state.failed ? 1 : 0
      } finally {
        if (input) input.off("SIGINT", interrupt)
        else process.off("SIGINT", interrupt)
      }
      return
    }
    if (command === "crew" && ["start", "resume"].includes(rest[1]) && vibe.mode === "inproc") {
      let member
      const parent = rest[1] === "resume"
        ? (await vibe.control.call("crew.show", { id: rest[2] })).sessionId
        : flags.session
      if (!parent) throw new Error("Use --session <id> when starting Crew.")
      async function* startCrew() {
        member = rest[1] === "start"
          ? await vibe.control.call("crew.start", { sessionId: parent, agent: rest[2], task: rest.slice(3).join(" "), background: true, maxSteps: flags.steps })
          : await vibe.control.call("crew.resume", { id: rest[2], text: rest.slice(3).join(" "), maxSteps: flags.steps })
        yield { type: "crew.created", crew: member, sessionId: parent }
      }
      const interrupt = () => stopSessionWork(vibe, parent).catch(() => {})
      if (input) input.on("SIGINT", interrupt); else process.on("SIGINT", interrupt)
      try {
        const renderer = await runEvents(vibe, startCrew(), { rl: input, flags: { ...flags, controlOnly: true }, sessionId: parent })
        const result = await vibe.control.call("crew.show", { id: member.id })
        if (flags.json) console.log(JSON.stringify({ type: "crew.completed", crew: result }))
        else console.log(c.text(result.result || result.error || result.status))
        process.exitCode = result.status === "error" || renderer.state.failed ? 1 : renderer.state.interrupted ? 130 : 0
      } finally {
        if (input) input.off("SIGINT", interrupt); else process.off("SIGINT", interrupt)
      }
      return
    }
    if (!await runCommand({ vibe, flags, dir, home, input }, rest)) throw new Error(`Unknown command "${command}". Run: vibe help`)
  } finally {
    input?.close()
    closeEngine(vibe)
  }
}

if (require.main === module) {
  main().catch((error) => {
    const json = process.argv.includes("--json")
    if (json) process.stdout.write(JSON.stringify({ type: "error", message: error.message }) + "\n")
    else console.error("Error: " + error.message)
    process.exitCode = 1
  })
}
module.exports = { parseArgs, pickProfile, runEvents, selectSession, main, HELP }
