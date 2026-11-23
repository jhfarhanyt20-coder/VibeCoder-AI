"use strict"
// The composer's git branch chip must show a real branch name — never
// "[object Object]" — and stay hidden outside a git repository.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = require("./renderer-app-source.cjs")()
const start = source.indexOf("function hideBranchChip()")
const end = source.indexOf("/* Git subcommands that only READ the repo")
assert(start > 0 && end > start, "branch chip functions exist")

async function run(answer) {
  const chip = { hidden: true }
  const label = { textContent: "" }
  const calls = []
  const context = vm.createContext({
    projectDir: "C:\\work\\app",
    $: (id) => (id === "chip-branch" ? chip : label),
    vibe: { gitBranch: async (arg) => { calls.push(arg); return answer } },
  })
  vm.runInContext(source.slice(start, end), context)
  await vm.runInContext("showBranchChip()", context)
  return { chip, label, calls }
}

;(async () => {
  let r = await run({ ok: true, data: { branch: "main" } })
  assert.equal(r.label.textContent, "main")
  assert.equal(r.chip.hidden, false)
  assert.equal(JSON.stringify(r.calls[0]), JSON.stringify({ directory: "C:\\work\\app" }), "the folder is sent as { directory }")

  r = await run({ ok: true, data: { branch: null } })
  assert.equal(r.chip.hidden, true, "not a git repo: no chip")
  assert.equal(r.label.textContent, "")

  r = await run({ ok: true, data: "feature/login" })
  assert.equal(r.label.textContent, "feature/login", "older plain-string answers still work")

  r = await run({ ok: false, error: "boom" })
  assert.equal(r.chip.hidden, true)

  r = await run({ ok: true, data: { branch: { nested: true } } })
  assert.equal(r.chip.hidden, true, "never prints an object")

  const backend = fs.readFileSync(path.join(__dirname, "..", "electron", "backend.cjs"), "utf8")
  assert.match(backend, /read \.git\/HEAD/, "branch is found even when git is not on PATH")
  console.log("PASS branch chip: real branch name, hidden outside git, no [object Object], works without git on PATH")
})().catch((e) => { console.error(e); process.exit(1) })
