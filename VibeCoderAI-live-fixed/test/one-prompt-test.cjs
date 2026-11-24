"use strict"
// A compound shell command asks ONCE (the whole command), not once per
// segment, and a script block is never cut in half. Safety stays: any denied
// segment refuses, a wildcard allow rule cannot approve the joined text, and
// "Always allow" saves the same exact per-segment rules as before.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { createVibe } = require("../sdk")
const tools = require("../core/tools")
const { checkPermissions, splitCommand } = require("../core/agent/loop")

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vc-oneprompt-"))
const tick = () => new Promise((r) => setImmediate(r))
const bashPerm = (command) => tools.byName("bash").perm({ command })

;(async () => {
  // splitting keeps script blocks and sub-expressions whole
  assert.deepEqual(splitCommand('Write-Output "hi"; 1..6 | ForEach-Object { "line $_"; Start-Sleep -Milliseconds 400 }'),
    ['Write-Output "hi"', "1..6", 'ForEach-Object { "line $_"; Start-Sleep -Milliseconds 400 }'])
  assert.deepEqual(splitCommand("echo ok && rm -rf /"), ["echo ok", "rm -rf /"], "top-level separators still split")
  assert.deepEqual(splitCommand("if ($x) { del a; del b }; echo done"), ["if ($x) { del a; del b }", "echo done"])

  const home = tmp()
  const vibe = createVibe({ home, permission: "ask" })
  const s = vibe.engine.store.create({ dir: tmp(), profile: "mock" })
  const events = []
  const ask = vibe.engine._ask(s, new AbortController().signal, (e) => events.push(e))

  // 1) four segments that each need asking -> exactly one prompt, showing the whole command
  const cmd = 'Write-Output "hi"; 1..6 | ForEach-Object { "line $_"; Start-Sleep -Milliseconds 400 }'
  const before = vibe.engine.pending.size
  const p1 = checkPermissions(ask, bashPerm(cmd), {})
  await tick()
  assert.equal(vibe.engine.pending.size, before + 1, "one prompt only")
  const asks = events.filter((e) => e.type === "permission.ask")
  assert.equal(asks.length, 1)
  assert.equal(asks[0].subject, cmd, "the prompt shows the whole command")
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "once")
  assert.equal(await p1, true)

  // 2) a segment that a rule denies refuses the whole command without a prompt
  events.length = 0
  s.rules.push({ tool: "bash", pattern: "*Stop-Computer*", action: "deny" })
  assert.equal(await checkPermissions(ask, bashPerm("echo hi; Stop-Computer"), {}), false)
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 0, "denied: nobody is asked")

  // 3) a wildcard allow rule for the first part cannot approve the joined command
  events.length = 0
  s.rules.push({ tool: "bash", pattern: "echo*", action: "allow" })
  const p3 = checkPermissions(ask, bashPerm("echo a; Remove-Item C:\\temp\\x"), {})
  await tick()
  const ask3 = events.filter((e) => e.type === "permission.ask")
  assert.equal(ask3.length, 1, "still asks for the part no rule allows")
  assert.equal(ask3[0].subject, "echo a; Remove-Item C:\\temp\\x")
  // "Always" saves exact rules for the segments that needed asking only
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "always")
  assert.equal(await p3, true)
  const saved = s.rules.filter((r) => r.exact && r.action === "allow").map((r) => r.pattern)
  assert.ok(saved.includes("Remove-Item C:\\temp\\x"), "the asked segment is remembered")
  assert.ok(!saved.includes("echo a; Remove-Item C:\\temp\\x"), "the joined text is not saved as one rule")
  // the same command next time runs without a prompt
  events.length = 0
  assert.equal(await checkPermissions(ask, bashPerm("echo a; Remove-Item C:\\temp\\x"), {}), true)
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 0)

  // 4) every segment allowed -> no prompt at all
  events.length = 0
  assert.equal(await checkPermissions(ask, bashPerm("npm test; npm test"), {}), true)
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 0)

  // 5) two calls for the same file at once (two parallel edits) -> ONE prompt; the answer covers both
  events.length = 0
  const file = path.join(s.dir, "a.h")
  const e1 = ask({ tool: "edit", subject: file })
  const e2 = ask({ tool: "edit", subject: file })
  await tick()
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 1, "no duplicate prompt for the same file")
  vibe.permission.reply([...vibe.engine.pending.keys()].pop(), "once")
  assert.deepEqual([await e1, await e2], [true, true])
  // a different file still gets its own prompt, and a rejection covers both waiting calls
  events.length = 0
  const d1 = ask({ tool: "edit", subject: file })
  const d2 = ask({ tool: "edit", subject: file })
  const other = ask({ tool: "edit", subject: path.join(s.dir, "b.h") })
  await tick()
  assert.equal(events.filter((e) => e.type === "permission.ask").length, 2)
  const ids = [...vibe.engine.pending.keys()]
  vibe.permission.reply(ids[0], "deny")
  vibe.permission.reply(ids[1], "once")
  assert.deepEqual([await d1, await d2, await other], [false, false, true])

  console.log("PASS one prompt per command: whole command shown once, blocks kept whole, deny/wildcard/always rules unchanged, same-file calls share one prompt")
})().catch((e) => { console.error(e); process.exit(1) })
