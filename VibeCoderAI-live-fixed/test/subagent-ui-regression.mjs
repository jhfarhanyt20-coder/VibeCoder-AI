import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

const manager = read("core/subagents/index.js")
const engine = read("core/engine.js")
const backend = read("electron/backend.cjs")
const preload = read("electron/preload.cjs")
const messages = read("electron/messages.cjs")
const renderer = read("renderer/app.js")
const html = read("renderer/index.html")

assert.match(engine, /agent:\s*\{ type: "string"/)
assert.match(engine, /background:\s*\{ type: "boolean"/)
assert.match(engine, /await this\.subagents\.wait\(id\)/)
assert.match(manager, /Subagents cannot spawn nested subagents/)
assert.match(manager, /type: "subagent\.start", name: agent\.name, agentType: agent\.type/)
assert.match(manager, /takeResults\(parentSessionId\)/)
assert.match(manager, /subagentResultDeliveredAt/)
assert.match(messages, /const metadata = stats/)

assert.match(backend, /emitUI\("subagent\.event"/)
assert.match(backend, /subagentDetails:/)
assert.match(backend, /subagentResume:/)
assert.match(preload, /subagentDetails: call\("subagentDetails"\)/)
assert.match(preload, /subagentResume: call\("subagentResume"\)/)

for (const id of ["subagent-viewbar", "subagent-back", "subagent-view-name", "subagent-view-status", "subagent-composer", "subagent-input", "subagent-send"]) {
  assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`)
}
assert.match(renderer, /async function openSubagentView\(id\)/)
assert.match(renderer, /function leaveSubagentView\(renderParent = true\)/)
assert.match(renderer, /function handleSubagentEvent\(data\)/)
assert.match(renderer, /function syncSubagentCard\(el, info\)/)
assert.match(renderer, /openSubagentView\(info\.id\)/)
assert.match(renderer, /vibe\.subagentResume\(\{ id: view\.id, text \}\)/)
assert.match(html, /← Main agent/)

console.log("PASS subagent UI regression: clickable child timeline, live progress, result persistence, resume, and Back to main are wired end-to-end")
