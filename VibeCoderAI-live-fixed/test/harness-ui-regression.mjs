import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const html = read("renderer/index.html")
const app = read("renderer/app.js")
const css = read("renderer/theme.css")
const backend = read("electron/backend.cjs")
const preload = read("electron/preload.cjs")
const messages = read("electron/messages.cjs")

for (const id of ["btn-rewind", "rewind-menu", "rewind-summary", "rewind-files", "rewind-step", "rewind-turn", "rewind-redo"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing Rewind UI element ${id}`)
}
for (const method of ["listStepSnapshots", "previewSnapshot", "undoStepSession", "redoSession", "listRedo", "getTrail"]) {
  assert.match(preload, new RegExp(`${method}: call\\("${method}"\\)`), `preload is missing ${method}`)
  assert.match(backend, new RegExp(`${method}: async`), `backend is missing ${method}`)
}
for (const event of ["session.pulse.started", "session.pulse.step.started", "session.pulse.step.ended", "session.permission.locked", "session.recipe.started"]) {
  assert.match(backend, new RegExp(event.replaceAll(".", "\\.")), `backend does not map ${event}`)
}
assert.match(backend, /durationMs: ev\.durationMs/)
assert.match(backend, /reasoning: Number\(ev\.reasoning\)/)
assert.match(backend, /read: Number\(ev\.cache\?\.read\)/)
assert.match(backend, /write: Number\(ev\.cache\?\.write\)/)
assert.match(messages, /reasoning: m\.usage\.reasoning/)
assert.match(messages, /read: m\.usage\.cache\?\.read/)
assert.match(messages, /write: m\.usage\.cache\?\.write/)
assert.match(messages, /durationMs: res\.durationMs/)
assert.match(app, /async function refreshRewindMenu/)
assert.match(app, /async function applyRewind/)
assert.match(app, /function permissionScope/)
assert.match(app, /function addHarnessNote/)
assert.match(app, /Step \$\{pulse\.step\}/)
assert.match(css, /\.rewind-menu/)
assert.match(css, /\.harness-note\.locked/)
assert.match(preload, /shellInput: call\("shellInput"\)/)
assert.match(backend, /shellInput: async/)
for (const event of ["session.shell.started", "session.shell.output", "session.shell.input", "session.shell.waiting", "session.shell.ended", "session.shell.completed"]) {
  assert.match(backend, new RegExp(event.replaceAll(".", "\\.")), `backend does not map ${event}`)
}
assert.match(backend, /case "shell\.resume\.started"/)
assert.match(backend, /source: "shell-result"/)
assert.match(app, /data\.source === "shell-result"/)
assert.match(app, /const waitingForShell =/)
assert.match(app, /async function sendRunningShellInput/)
assert.match(app, /type === "session\.shell\.output"/)
assert.match(app, /vibe\.shellInput\(/)
assert.match(css, /\.bji-output/)
assert.match(css, /\.bji-input-row/)

const syntax = spawnSync(process.execPath, ["--check", path.join(root, "renderer", "app.js")], { encoding: "utf8" })
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout)

console.log("PASS harness UI regression: Pulse, permissions, Rewind and live shell controls are wired end-to-end")
