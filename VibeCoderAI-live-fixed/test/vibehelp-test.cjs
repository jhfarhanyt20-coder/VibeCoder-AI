"use strict"
// The agent knows its own product: a guide tool every model can use, offered in
// the app and the CLI, allowed without prompts, and shipped in both packages.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const zlib = require("node:zlib")
const { ALL, sections } = require("../core/tools/vibehelp")
const { decide, DEFAULT_RULES } = require("../core/perm/rules")
const { buildSystem } = require("../core/agent/prompt")
const { createVibe } = require("../sdk")

;(async () => {
  const tool = ALL[0]
  const titles = sections().map((s) => s.title)
  for (const need of ["Overview", "Models and providers", "Computer Use", "Connectors", "CLI", "Privacy and data", "Troubleshooting"]) assert(titles.includes(need), `guide has ${need}`)

  const pick = async (topic) => (await tool.run({ topic })).split("\n").filter((l) => l.startsWith("## "))[0]
  assert.equal(await pick("how do I stop computer use"), "## Computer Use")
  assert.equal(await pick("openrouter base url"), "## Models and providers")
  assert.equal(await pick("keyboard shortcuts"), "## Composer and keyboard shortcuts")
  assert.equal(await pick("github connector"), "## Connectors")
  assert.match(await tool.run({ topic: "quantum chromodynamics" }), /Do not guess/)
  assert.match(await tool.run({}), /Topics: Overview/)

  assert.equal(decide(DEFAULT_RULES, "vibecoder_help", "guide"), "allow", "reading the guide never asks")

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vc-help-"))
  const vibe = createVibe({ home, permission: "ask" })
  assert(vibe.engine.extraTools(home).some((t) => t.name === "vibecoder_help"), "offered to every model")

  const sys = buildSystem({ cwd: home, home })
  assert.match(sys, /call the vibecoder_help tool/)
  assert.match(sys, /simple greeting .* no links/)

  // The CLI archive carries the guide and the Computer Use helper.
  const { buildArchive } = require("../scripts/package-cli.cjs")
  const out = path.join(home, "cli.tgz")
  buildArchive({ output: out })
  const tar = zlib.gunzipSync(fs.readFileSync(out))
  const names = []
  for (let o = 0; o + 512 <= tar.length;) {
    const n = tar.slice(o, o + 100).toString().replace(/\0.*$/s, "")
    if (!n) break
    const size = parseInt(tar.slice(o + 124, o + 136).toString().trim(), 8) || 0
    names.push(n)
    o += 512 + Math.ceil(size / 512) * 512
  }
  assert(names.includes("package/core/knowledge/vibecoder.md"), "guide ships with the CLI")
  assert(names.includes("package/core/computer/helper.ps1"), "Computer Use helper ships with the CLI")
  fs.rmSync(home, { recursive: true, force: true })
  console.log("PASS vibecoder guide: sections, topic search, no prompts, in every agent's tools and prompt, shipped in the CLI with the Computer Use helper")
})().catch((e) => { console.error(e); process.exit(1) })
