"use strict"
// Model settings: the right side shows ONLY the provider picked on the left.
// Picking a preset (OpenAI, Anthropic…) used to leave the BDCoder AI account
// panel visible above the form, with both items highlighted.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = require("./renderer-app-source.cjs")()
const start = source.indexOf("function showProviderFormPanel()")
const end = source.indexOf("function selectProvider(id)", start)
assert(start > 0 && end > start, "one shared helper decides the visible panel")

const els = { "md-opencode": { hidden: false }, "md-custom": { hidden: true } }
const empty = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v } }
const vcItem = { classList: { removed: [], remove(c) { this.removed.push(c) } } }
const context = vm.createContext({
  state: { selectedProvider: "opencode" },
  $: (id) => (id === "model-detail" ? { querySelector: () => empty } : els[id]),
  document: { querySelectorAll: () => [vcItem] },
})
vm.runInContext(source.slice(start, end), context)
vm.runInContext("showProviderFormPanel()", context)
assert.equal(els["md-opencode"].hidden, true, "the BDCoder AI panel is hidden")
assert.equal(els["md-custom"].hidden, false, "the provider form is shown")
assert.equal(context.state.selectedProvider, null, "BDCoder AI is no longer the selected item")
assert.deepEqual([...vcItem.classList.removed], ["selected"], "its highlight is removed")
assert.equal(empty.attrs.hidden, "")

// Every way of opening a provider form uses the helper — presets included.
for (const fn of ["function selectProvider(id)", "function startNewProvider()", "function selectProviderPreset(preset)"]) {
  const at = source.indexOf(fn)
  assert(at > 0, `${fn} exists`)
  const body = source.slice(at, source.indexOf("\n}\n", at))
  assert.match(body, /showProviderFormPanel\(\)/, `${fn} shows only the provider form`)
}
console.log("PASS provider panel: only the picked provider's details are shown (presets, saved and new providers)")
