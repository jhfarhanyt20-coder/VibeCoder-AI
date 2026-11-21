"use strict"
// Built-in marketplace items: every skill has real text, every plugin loads and
// its tool works on a sample project, the MCP entries are runnable commands,
// and a built-in skill installs with its text (it used to be empty).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const net = require("node:net")
const { BUILTIN } = require("../core/extensions/catalog.js")
const skills = require("../core/skills")

;(async () => {
  // Skills: unique ids, real instructions.
  const ids = BUILTIN.skills.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, "skill ids are unique")
  for (const id of ["bug-fixer", "app-tester", "project-explainer", "safe-refactor", "security-check", "docs-writer", "video-maker", "commit-helper", "code-reviewer", "test-writer"]) assert(ids.includes(id), id)
  for (const s of BUILTIN.skills) {
    assert(s.title && s.description, `${s.id} has a title and description`)
    assert(s.content.length > 150 && s.content.startsWith("# "), `${s.id} has real instructions`)
  }

  // MCP: runnable commands, the Playwright entry the Browser Use page looks for.
  for (const m of BUILTIN.mcp) {
    assert(Array.isArray(m.command) && m.command[0] === "npx" && m.command.includes("-y"), `${m.name} is an npx command`)
    assert(m.title && m.description, `${m.name} has a title`)
  }
  assert(BUILTIN.mcp.some((m) => m.id === "playwright"), "the Playwright entry exists (Browser Use page)")
  for (const n of ["context7", "sequential-thinking"]) assert(BUILTIN.mcp.some((m) => m.name === n), n)

  // Plugins: each loads with Node built-ins only and its tool works.
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-builtin-"))
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-plugins-"))
  try {
    fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "demo", main: "index.js", scripts: { dev: "vite", test: "node --test" } }))
    fs.mkdirSync(path.join(proj, "src"))
    fs.writeFileSync(path.join(proj, "src", "app.js"), "// TODO: handle errors\nconst a = 1 // FIXME wrong default\n")
    fs.mkdirSync(path.join(proj, "node_modules", "x"), { recursive: true })
    fs.writeFileSync(path.join(proj, "node_modules", "x", "i.js"), "// TODO hidden in node_modules")
    fs.writeFileSync(path.join(proj, ".env.example"), "API_KEY=\nPORT=3000\nDEBUG=false\n")
    fs.writeFileSync(path.join(proj, ".env"), "API_KEY=secret-value-123\nPORT=\nEXTRA=1\n")
    const tools = {}
    for (const p of BUILTIN.plugins) {
      assert(p.content.includes("module.exports"), `${p.id} has source`)
      const file = path.join(pdir, p.id + ".js")
      fs.writeFileSync(file, p.content)
      for (const t of require(file).tools) {
        assert(t.name && t.description && typeof t.run === "function", `${p.id}: ${t.name}`)
        // Only the voice-over writes (an audio file inside the project); the rest only read.
        assert.equal(t.perm({ text: "x" }, { cwd: proj }).tool, t.name === "voice_over" ? "write" : "read", `${t.name} permission`)
        tools[t.name] = t
      }
    }
    const ctx = { cwd: proj }
    const overview = await tools.project_overview.run({}, ctx)
    assert.match(overview, /JavaScript/)
    assert.match(overview, /npm run dev/)
    assert.match(overview, /package\.json/)
    const todos = await tools.find_todos.run({}, ctx)
    assert.match(todos, /src\/app\.js:1 {2}TODO {2}handle errors/)
    assert.match(todos, /src\/app\.js:2 {2}FIXME/)
    assert.doesNotMatch(todos, /node_modules/)
    assert.match(await tools.find_todos.run({ kind: "fixme" }, ctx), /^1 note/)
    const env = await tools.env_check.run({}, ctx)
    assert.match(env, /Missing in \.env: DEBUG/)
    assert.match(env, /Empty in \.env: PORT/)
    assert.match(env, /not documented in \.env\.example: EXTRA/)
    assert.doesNotMatch(env, /secret-value-123/, "never shows a value")
    assert.equal(tools.env_check.perm({}, ctx).subject, path.join(proj, ".env"), ".env reading follows the .env permission rule")
    const server = net.createServer().listen(0, "127.0.0.1")
    await new Promise((r) => server.once("listening", r))
    const port = server.address().port
    const ports = await tools.ports_in_use.run({ ports: [port] })
    server.close()
    assert.match(ports, new RegExp(`Answering: http://localhost:${port}`))

    // Media tools: the check always answers; the voice-over file stays inside the project.
    assert.match(await tools.media_check.run({}, ctx), /FFmpeg: [\s\S]*Node\.js: v\d+/)
    assert.deepEqual(tools.voice_over.paths({ text: "hi", out: "audio/a.wav" }, ctx), [path.join(proj, "audio", "a.wav")])
    await assert.rejects(tools.voice_over.run({ text: "hi", out: "a.mp3" }, ctx), /\.wav|Windows/)
    if (process.platform === "win32") {
      const said = await tools.voice_over.run({ text: "Hello from VibeCoder.", out: "audio/hello.wav" }, ctx)
      assert.match(said, /Voice-over saved: audio\/hello\.wav \(\d+\.\d s/)
      assert(fs.statSync(path.join(proj, "audio", "hello.wav")).size > 10000)
      await assert.rejects(tools.voice_over.run({ text: "x", voice: "No Such Voice" }, ctx), /No installed voice/)
    }

    // A built-in skill installs with its text (the desktop sends no content).
    const backend = fs.readFileSync(path.join(__dirname, "..", "electron", "backend.cjs"), "utf8")
    assert(backend.includes("const builtin = !a.content && (catalog.BUILTIN.skills || []).find((x) => x.id === a.id)"))
    const bug = BUILTIN.skills.find((s) => s.id === "bug-fixer")
    const out = skills.installSkillFile({ id: bug.id, title: bug.title, description: bug.description, content: bug.content, directory: proj })
    const written = fs.readFileSync(out.file, "utf8")
    assert.match(written, /^---[\s\S]*name: bug-fixer[\s\S]*---/)
    assert.match(written, /Reproduce first/)
    console.log(`PASS built-ins: ${BUILTIN.skills.length} skills with text, ${BUILTIN.mcp.length} MCP commands, ${BUILTIN.plugins.length} working plugins (only voice_over writes, inside the project), built-in skill installs with its text`)
  } finally {
    fs.rmSync(proj, { recursive: true, force: true })
    fs.rmSync(pdir, { recursive: true, force: true })
  }
})().catch((e) => { console.error(e); process.exit(1) })
