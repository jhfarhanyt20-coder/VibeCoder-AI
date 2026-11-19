"use strict"
// Tool calls that small models send in other shapes must still work, and every
// failure must say what happened, that nothing changed, and what to do next.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const tools = require("../core/tools")
const toolargs = require("../core/agent/toolargs")
const { applyEdit } = require("../core/tools/editkit")

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const T = (n) => tools.ALL.find((t) => t.name === n)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-args-"))
const ctx = { cwd: dir, stats: {}, emit() {}, session: null }
fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true })
fs.writeFileSync(path.join(dir, "src", "util.js"), "function add(a, b) {\n  const total = a + b\n  return total\n}\nconst x = 1\nconst x = 1\n")
fs.writeFileSync(path.join(dir, "src", "lib", "deep.js"), "export const deep = true\n")

test("other parameter names and string numbers/booleans are accepted", () => {
  const { args } = toolargs.prepareArgs(T("edit"), { file_path: "a.js", old_string: "x", new_string: "y", replace_all: "true" })
  assert.deepEqual(args, { path: "a.js", oldString: "x", newString: "y", replaceAll: true })
  const r = toolargs.prepareArgs(T("read"), { filePath: "src/util.js", offset: "2", limit: "1" }).args
  assert.equal(r.path, "src/util.js"); assert.equal(r.offset, 2); assert.equal(r.limit, 1)
  assert.equal(toolargs.prepareArgs(T("bash"), { cmd: "echo hi" }).args.command, "echo hi")
  assert.equal(toolargs.prepareArgs(T("read"), { path: "src/util.js:3" }).args.offset, 3, "path:line is split")
})

test("timeouts given in seconds are read as seconds", () => {
  const { args, notes } = toolargs.prepareArgs(T("bash"), { command: "npm test", timeout: 60 })
  assert.equal(args.timeout, 60000)
  assert.match(notes.join(" "), /60 s/)
})

test("JSON sent as text, in fences or with trailing commas is repaired", () => {
  const { args } = toolargs.prepareArgs(T("read"), { __parseError: true, raw: '```json\n{"path": "src/util.js",}\n```' })
  assert.equal(args.path, "src/util.js")
  assert.deepEqual(toolargs.prepareArgs(T("todowrite"), { todos: "[]" }).args.todos, [])
  assert.throws(() => toolargs.prepareArgs(T("write"), { __parseError: true, raw: '{"path":"a.js","content":"abc' }, { finish: "length" }), /output limit cut the call off/)
})

test("missing arguments say what was sent and what is expected", () => {
  assert.throws(() => toolargs.prepareArgs(T("read"), { line: 3 }), (e) => /Missing required argument "path"/.test(e.message) && /Nothing was executed/.test(e.message) && /Expected: path \(string, required\)/.test(e.message))
  assert.throws(() => toolargs.prepareArgs(T("read"), [1, 2]), /must be a JSON object/)
})

test("tool names forgive case and suggest close names", () => {
  assert.equal(toolargs.findTool("Read", tools.ALL).name, "read")
  assert.equal(toolargs.findTool("TodoWrite", tools.ALL).name, "todowrite")
  const msg = toolargs.unknownToolMessage("reed", tools.ALL)
  assert.match(msg, /Did you mean "read"/)
  assert.match(msg, /Nothing was executed/)
})

test("text-editor style calls map to read / write / edit", () => {
  const m = toolargs.editorCommand("str_replace_editor", { command: "create", path: "a.txt", file_text: "hi" }, tools.ALL)
  assert.equal(m.tool.name, "write"); assert.equal(m.args.content, "hi")
  assert.equal(toolargs.editorCommand("str_replace_editor", { command: "view", path: "a" }, tools.ALL).tool.name, "read")
  assert.match(toolargs.editorCommand("str_replace_editor", { command: "undo_edit" }, tools.ALL).error, /not supported/)
})

test("edit not found shows the closest lines; several matches say where", () => {
  const src = fs.readFileSync(path.join(dir, "src", "util.js"), "utf8")
  assert.throws(() => applyEdit(src, "const totl = a + b\n  return totl", "z"), (e) => /Closest match \(lines 2-3/.test(e.message) && /nothing was changed/.test(e.message))
  assert.throws(() => applyEdit(src, "const x = 1", "z"), /lines 5, 6/)
  assert.match(applyEdit(src, "3\t  return total", "  return 0").strategy, /line-number prefixes removed/)
})

test("read: missing file suggests similar names; offsets past the end are explained", async () => {
  await assert.rejects(T("read").run({ path: "src/utils.js" }, ctx), (e) => /File not found/.test(e.message) && /src\/util\.js/.test(e.message))
  assert.match(await T("read").run({ path: "src/util.js", offset: 99 }, ctx), /past the end of the file \(7 lines\)/)
  assert.match(await T("read").run({ path: "src/util.js", offset: 1, limit: 2 }, ctx), /Showing lines 1-2 of 7.*offset=3/)
})

test("edit on a missing file says to use write", async () => {
  await assert.rejects(T("edit").run({ path: "src/nope.js", oldString: "a", newString: "b" }, ctx), /does not exist|File not found.*Use write/)
})

test("write accepts a JSON object as content", async () => {
  await T("write").run({ path: "package.json", content: { name: "demo" } }, ctx)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name, "demo")
})

test("grep: a file path works, bad regex falls back to text, no matches explains why", async () => {
  assert.match(await T("grep").run({ pattern: "total", path: "src/util.js" }, ctx), /util\.js:2:/)
  assert.match(await T("grep").run({ pattern: "add(a", path: "src" }, ctx), /searched as plain text[\s\S]*util\.js:1:/)
  assert.match(await T("grep").run({ pattern: "zzzz_nothing" }, ctx), /No matches for .* in \d+ files?/)
  await assert.rejects(T("grep").run({ pattern: "x", path: "missing-dir" }, ctx), /Path not found/)
})

test("glob: *.js finds files in subfolders and ./ prefixes work", async () => {
  const out = await T("glob").run({ pattern: "*.js" }, ctx)
  assert.match(out, /deep\.js/)
  assert.match(await T("glob").run({ pattern: "./src/*.js" }, ctx), /util\.js/)
  assert.match(await T("glob").run({ pattern: "*.zig" }, ctx), /No files matched .*Try a broader pattern/)
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS tool args: ${t.name}`) }
    catch (e) { console.error(`FAIL tool args: ${t.name}`); console.error(e); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} tool args tests passed`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  if (passed !== tests.length) process.exit(1)
})()
