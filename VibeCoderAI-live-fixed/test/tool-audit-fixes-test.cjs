"use strict"
// Fixes from the full tool audit: apply_patch argument alias, webfetch HTML
// cleanup, glob hint, skill cut note, subagent status hints, memory asks when
// the user did not ask to remember, Bangla help topics, crew hint.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const tools = require("../core/tools")
const toolargs = require("../core/agent/toolargs")
const T = (n) => tools.ALL.find((t) => t.name === n)
const src = fs.readFileSync(path.join(__dirname, "..", "core", "tools", "index.js"), "utf8")

;(async () => {
  // apply_patch: "patch" / "input" are read as patchText; an empty patch says what is missing
  const prep = (args) => { const r = toolargs.prepareArgs(T("apply_patch"), args); return (r && r.args) || r }
  assert.equal(prep({ patch: "*** Begin Patch\n*** End Patch" }).patchText, "*** Begin Patch\n*** End Patch")
  assert.equal(prep({ input: "x" }).patchText, "x")
  await assert.rejects(T("apply_patch").run({}, { cwd: process.cwd() }), /got no patch: put the whole patch in "patchText"/)

  // webfetch HTML → markdown: <link> is not a list item, the title is its own heading
  const html = '<!doctype html><html><head><meta charset=utf-8><link rel=icon href=data:,><title>Example Domain</title><style>x{}</style></head><body><p>This domain is for docs.</p><ul><li>One</li></ul></body></html>'
  const md = src.match(/function htmlToMarkdown[\s\S]*?\n}\n/)[0]
  const decode = src.match(/function decodeEntities[\s\S]*?\n}\n/)[0]
  const ent = src.match(/const ENTITIES = \{[\s\S]*?\n\}\n/)[0]
  const conv = new Function(`${ent}\n${decode}\n${md}\nreturn htmlToMarkdown`)()
  const out = conv(html)
  assert.match(out, /^# Example Domain\n\nThis domain is for docs\./)
  assert.match(out, /\n- One/)
  assert.equal((out.match(/^- /gm) || []).length, 1, "only the real <li> is a bullet")

  // glob: no useless "try the same pattern" advice
  assert.match(src, /No \$\{path\.extname\(pattern\)\} files exist here/)

  // skill / playbook cut is announced
  assert.match(src, /more characters cut\. Read the rest with read on/)
  assert.doesNotMatch(src, /\]\.join\("\n"\)\.slice\(0, 36000\)/)

  // subagent status never invites polling
  const st = await T("subagentStatus").run({ subagentId: "x" }, { engine: { subagentStatus: () => ({ id: "x", status: "running" }) } })
  assert.match(st, /Do not poll/)
  const done = await T("subagentStatus").run({ subagentId: "x" }, { engine: { subagentStatus: () => ({ id: "x", status: "done" }) } })
  assert.match(done, /subagentResult only if it is missing/)

  // memory asks first unless the user's own message asked to remember
  const ctxSay = (text) => ({ session: { messages: [{ role: "user", parts: [{ type: "text", text }] }] } })
  assert.equal(T("memory").perm({ text: "x" }, ctxSay("please remember my port is 3000")).forceAsk, undefined)
  assert.equal(T("memory").perm({ text: "x" }, ctxSay("এটা মনে রাখো")).forceAsk, undefined)
  assert.equal(T("memory").perm({ text: "x" }, ctxSay("summarize this web page")).forceAsk, true)
  assert.equal(T("memory").perm({ text: "x" }, {}).forceAsk, true)

  // vibecoder_help understands Bangla topics
  const help = require("../core/tools/vibehelp").ALL[0]
  assert.match(await help.run({ topic: "কম্পিউটার ইউজ কিভাবে চালু করব" }), /## Computer Use/)
  assert.match(await help.run({ topic: "zzqqxv" }), /call vibecoder_help again with English keywords/)

  // crew hint names a parameter that exists
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", "core", "tools", "crew.js"), "utf8"), /call crewChanges with files/)

  console.log("PASS tool audit fixes: patch alias, webfetch cleanup, glob/skill/subagent hints, memory asks, Bangla help, crew hint")
})().catch((e) => { console.error(e); process.exit(1) })
