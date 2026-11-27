"use strict"
// The model picker lists Fallback first, then the signed-in BDCoder account's
// models, then every other provider (desktop app and CLI alike).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { modelChoices } = require("../cli/actions")

const rows = modelChoices([
  { id: "openrouter", name: "OpenRouter", models: [{ id: "a" }], hasKey: true },
  { id: "amd", name: "AMD", models: [{ id: "b" }], hasKey: true },
  { id: "vibecoder", name: "BDCoder AI", models: [{ id: "free-1", name: "Auto" }, { id: "free-2", name: "Agnes" }], hasKey: true },
])
assert.deepEqual(rows.map((r) => r.id), ["vibecoder/free-1", "vibecoder/free-2", "openrouter/a", "amd/b"], "CLI: BDCoder first, others keep their order")

const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app", "models.js"), "utf8").replace(/\r\n/g, "\n")
assert.match(src, /const groupRank = \(id\) => \(id === "group" \? 0 : id === "vibecoder" \? 1 : 2\)/, "app: Fallback, then BDCoder, then the rest")
assert.match(src, /for \(const \[providerID, models\] of orderedGroups\)/, "app: the ordered groups are drawn")
console.log("PASS model picker order: Fallback, then the BDCoder account, then other providers (app and CLI)")
