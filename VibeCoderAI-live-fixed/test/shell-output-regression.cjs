"use strict"

const assert = require("node:assert/strict")
const os = require("node:os")
const path = require("node:path")
const fs = require("node:fs")
const jobs = require("../core/jobs")

async function main() {
  const events = []
  const expected = "x".repeat(100000) // larger than six IPC chunks.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-shell-stream-"))
  try {
    const handle = jobs.createShell({
      sessionID: "shell-large-output-regression",
      command: `node -e "process.stdout.write('x'.repeat(100000))"`,
      cwd,
      background: true,
      emit: (event) => events.push(event),
    })
    const result = await handle.done
    assert.equal(result.status, "completed")
    const chunks = events.filter((event) => event.type === "shell.output")
    assert.equal(chunks.map((event) => event.delta).join(""), expected, "live renderer stream must not drop burst output")
    assert.ok(chunks.length > 1, "large output must be split across bounded events")
    assert.ok(chunks.every((event) => event.delta.length <= 16 * 1024 + 1), "each renderer event must remain bounded")
    assert.match(jobs.output(handle.id, 30000), /x{16}$/)
    console.log(`PASS shell output regression: ${expected.length.toLocaleString()} characters delivered across ${chunks.length} ordered events`)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
