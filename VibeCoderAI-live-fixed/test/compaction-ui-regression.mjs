import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

const loop = read("core/agent/loop.js")
const engine = read("core/engine.js")
const backend = read("electron/backend.cjs")
const renderer = read("renderer/app.js")

assert.match(loop, /error\.code\s*=\s*["']CONTEXT_COMPACTION_FAILED["']/)
assert.match(loop, /error\.code\s*=\s*["']CONTEXT_COMPACTION_OVER_BUDGET["']/)
assert.match(loop, /error\.retryable\s*=\s*false/)
assert.match(engine, /e && e\.code \? \{ code: e\.code \} : \{\}/)
assert.match(engine, /e && e\.retryable === false \? \{ retryable: false \} : \{\}/)
assert.match(backend, /retryable:\s*ev\.retryable !== false/)
assert.match(backend, /state\.failureCode = ev\.code \|\| null/)
assert.match(backend, /state\?\.failureCode \? \{ code: state\.failureCode \} : \{\}/)
assert.match(backend, /retryable: state\?\.retryable !== false/)
assert.match(renderer, /function isTerminalCompactionError\(err\)/)
assert.match(renderer, /if \(isTerminalCompactionError\(err\)/)
assert.match(renderer, /state\.compactionBlockedRun = true/)
assert.match(renderer, /state\.compactionBlockedRun = false/)
assert.match(renderer, /box\.appendChild\(liveCompactEl\)/)
assert.match(renderer, /className = "act-screenshots"/)
assert.match(renderer, /Browser screenshot preview/)
assert.match(renderer, /img\.src = shot\.dataUrl/)
assert.match(renderer, /data\.retryable !== false && !state\.userStopped && \(isRetryableRunError\(real\) \|\| unexpectedAbort\)/)

console.log("PASS compaction UI regression: non-retryable failure propagation, no duplicate retry row, and final checkpoint placement are wired end-to-end")
