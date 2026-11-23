"use strict"
// Picking a model in a NEW task (no session yet) must be the model the first
// message uses. The catalog refresh that runs before sending used to put the
// engine's older saved choice back over the user's pick.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = require("./renderer-app-source.cjs")()
const start = source.indexOf("function applyProviderCatalog(data) {")
const end = source.indexOf("async function loadModels()", start)
assert(start > 0 && end > start, "applyProviderCatalog exists")

const store = new Map()
const label = { textContent: "" }
const context = vm.createContext({
  state: { models: [], selectedModel: null, pendingModelPick: null },
  providerState: {},
  ctxLimitsStale: false,
  setTimeout: () => 0,
  loadCtxLimits: () => {},
  renderCompactionModels: () => {},
  modelDisplayLabel: (key) => key,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  $: (id) => (id === "model-label" ? label : null),
})
vm.runInContext(source.slice(start, end), context)

const models = [{ providerID: "kilo", id: "old-model" }, { providerID: "openrouter", id: "new-model" }]
const catalog = { models, custom: [], formats: [], selectedModel: "kilo/old-model" } // engine still remembers the old one

// The user picks a new model in a new task (no session: nothing told the engine yet).
context.state.selectedModel = "openrouter/new-model"
context.state.pendingModelPick = "openrouter/new-model"
vm.runInContext("applyProviderCatalog(data)", Object.assign(context, { data: catalog }))
assert.equal(context.state.selectedModel, "openrouter/new-model", "the refresh before sending keeps the user's pick")
assert.equal(label.textContent, "openrouter/new-model")

// After the session adopts it, the engine's saved choice is the source of truth again.
context.state.pendingModelPick = null
vm.runInContext("applyProviderCatalog(data)", Object.assign(context, { data: { ...catalog, selectedModel: "openrouter/new-model" } }))
assert.equal(context.state.selectedModel, "openrouter/new-model")

// A pick of a model that no longer exists is ignored.
context.state.pendingModelPick = "gone/model"
vm.runInContext("applyProviderCatalog(data)", Object.assign(context, { data: catalog }))
assert.equal(context.state.selectedModel, "kilo/old-model")

// Wiring: the picker records the pick, and a successful session switch clears it.
assert.match(source, /state\.selectedModel = key\s*\n\s*state\.pendingModelPick = key/)
assert.match(source, /state\.pendingModelPick = null \/\/ the new session now uses the picked model/)
console.log("PASS model pick: the first message of a new task uses the model picked in the composer")
