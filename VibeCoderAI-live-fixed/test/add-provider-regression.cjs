"use strict"
// "+ Add provider" must open a blank form. Unsaved preset forms (OpenAI, Agnes…)
// used to share the blank form's draft key, so Add provider showed the last preset.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8").replace(/\r\n/g, "\n")
const pick = (from, to) => {
  const a = source.indexOf(from)
  const b = source.indexOf(to, a + from.length)
  assert(a > 0 && b > a, `found ${from}`)
  return source.slice(a, b)
}
const context = vm.createContext({ providerState: { draft: null } })
vm.runInContext([
  pick("function providerDraftKey(", "\nfunction captureProviderForm"),
  "const PROVIDER_PRESETS = [{ name: 'OpenAI', baseURL: 'https://api.openai.com/v1' }, { name: 'Agnes AI', baseURL: 'https://api.agnes-ai.com/api/v1' }]",
  pick("const presetKey = ", "\nfunction renderProviderPresets"),
].join("\n"), context)

const key = (d) => vm.runInContext("providerDraftKey(d)", Object.assign(context, { d }))
assert.equal(key({ id: "kilo" }), "kilo", "saved providers keep their id")
assert.equal(key({ preset: "https://api.openai.com/v1" }), "__preset__:https://api.openai.com/v1", "a preset form has its own draft")
assert.equal(key({ name: "" }), "__new__", "only the blank form is __new__")

const untouched = (d) => vm.runInContext("isUntouchedPresetDraft(d)", Object.assign(context, { d }))
assert.equal(untouched({ name: "Agnes AI", baseURL: "https://api.agnes-ai.com/api/v1/" }), true, "an old preset left in __new__ is recognised")
assert.equal(untouched({ name: "Agnes AI", baseURL: "https://api.agnes-ai.com/api/v1", apiKey: "sk-typed" }), false, "a form the user typed into is kept")
assert.equal(untouched({ name: "Mine", baseURL: "https://my.example.com/v1" }), false, "a real custom draft is kept")

// Wiring: presets store under their own key; Add provider never reuses an untouched preset.
assert.match(pick("function selectProviderPreset(", "\n}\n"), /providerFormDrafts\.set\(ownKey, d\)/)
assert.doesNotMatch(pick("function selectProviderPreset(", "\n}\n"), /providerFormDrafts\.set\("__new__"/)
assert.match(pick("function startNewProvider(", "\n}\n"), /isUntouchedPresetDraft\(blank\)/)
console.log("PASS add provider: opens a blank form; preset forms keep their own drafts")
