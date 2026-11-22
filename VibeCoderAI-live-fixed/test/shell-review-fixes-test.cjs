"use strict"
// Shell tool fixes from an agent's own session review:
// python -c quoting hint, redirected output shown by shellOutput, honest
// exit-code label, no deleting ./.vibe-scratch while a shell still uses it.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const tools = require("../core/tools")
const jobs = require("../core/jobs")
const src = fs.readFileSync(path.join(__dirname, "..", "core", "tools", "index.js"), "utf8")
const T = tools._internal

// 1) python -c with quotes/backslashes is recognised; plain one-liners are not
const bad = String.raw`python -c "import re; pat = re.compile(rb'(?:[\x20-\x7e]\x00){3,80}')"`
assert.equal(T.inlineScript(bad), true)
assert.equal(T.inlineScript(`python -c "print(1)"`), false)
assert.equal(T.inlineScript(`node -e "console.log(\\"a\\")"`), true)
assert.equal(T.inlineScript(`python file.py`), false)
if (process.platform === "win32") {
  assert.match(T.shellHint(bad, "The term 'x' is not recognized as the name of a cmdlet"), /write the code to a file/)
  assert.match(T.shellHint(`& "C:\\Program Files\\WindowsApps\\x\\cdb.exe"`, "Access is denied"), /copy the program's folder/)
}
const bashSpec = tools.ALL.find((t) => t.name === "bash")
assert.doesNotMatch(bashSpec.description, /python file\.py` or `python -c/, "the tool no longer recommends python -c")
assert.match(bashSpec.description, /Do not redirect a background command/)

// 2) redirect targets
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vc-redir-"))
assert.deepEqual(T.redirectTargets(`winget install x *> .vibe-scratch\\windbg-install.log`, cwd), [path.resolve(cwd, ".vibe-scratch\\windbg-install.log")])
assert.deepEqual(T.redirectTargets(`npm test 2>&1`, cwd), [])
assert.deepEqual(T.redirectTargets(`git status > $null`, cwd), [])
assert.deepEqual(T.redirectTargets(`dir | Out-File -FilePath "out put.txt"`, cwd), [path.resolve(cwd, "out put.txt")])
assert.deepEqual(T.redirectTargets(`if ($a -gt 3) { echo hi }`, cwd), [])
assert.deepEqual(T.redirectTargets(`build 2>> err.log`, cwd), [path.resolve(cwd, "err.log")])

// PowerShell 5.1 writes *> files as UTF-16 LE with a BOM
const log = path.join(cwd, "install.log")
fs.writeFileSync(log, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Downloading...\r\nSuccessfully installed WinDbg\r\n", "utf16le")]))
assert.match(T.fileTail(log).text, /Successfully installed WinDbg/)
const note = T.redirectNote({ command: "winget install x *> install.log", cwd })
assert.match(note, /sends its output to .*install\.log/)
assert.match(note, /Successfully installed WinDbg/)
assert.match(T.redirectNote({ command: "x *> later.log", cwd }), /not created yet/)
assert.equal(T.redirectNote({ command: "npm test", cwd }), "")
assert.match(src, /const redirected = redirectNote\(result\.shell\)/, "shellOutput shows the redirected file")

// 3) exit code label no longer says "failed"
assert.doesNotMatch(src, /\[command failed: exit code/)
assert.match(src, /Not always an error: some programs use non-zero codes/)

// 4) deleting ./.vibe-scratch while a running shell uses it is refused
const realList = jobs.list
jobs.list = () => [{ id: "sh_1", status: "running", command: "chkdsk D: /scan > .vibe-scratch\\chk.log", started: Date.now() }]
try {
  assert.ok(T.scratchDeleteConflict("Remove-Item -Recurse -Force .vibe-scratch", "s1"))
  assert.equal(T.scratchDeleteConflict("Remove-Item -Recurse -Force build", "s1"), null)
  const out = bashSpec.run({ command: "Remove-Item -Recurse -Force .vibe-scratch" }, { cwd, session: { id: "s1", messages: [] } })
  assert.match(String(out), /Not run: this deletes \.\/\.vibe-scratch while a running shell still uses it/)
  assert.match(String(out), /sh_1/)
  jobs.list = () => [{ id: "sh_2", status: "completed", command: "x > .vibe-scratch\\a.log" }]
  assert.equal(T.scratchDeleteConflict("Remove-Item -Recurse -Force .vibe-scratch", "s1"), null, "finished shells do not block")
} finally {
  jobs.list = realList
}

fs.rmSync(cwd, { recursive: true, force: true })
console.log("PASS shell review fixes: python -c hint, redirected output shown, honest exit code, scratch delete guard")
