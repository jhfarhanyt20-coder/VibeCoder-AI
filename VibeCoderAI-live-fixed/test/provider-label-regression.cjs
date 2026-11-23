"use strict"
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const app = require("./renderer-app-source.cjs")()
const labelCode = app.slice(app.indexOf("function modelDisplayLabel("), app.indexOf("\nfunction applyProviderCatalog"))
const listCode = app.slice(app.indexOf("function renderModelList("), app.indexOf("\nconst modelMenu ="))
class Element {
  constructor() { this.children = []; this.dataset = {}; this.className = ""; this.textContent = ""; this.classList = { add() {} } }
  set innerHTML(_) { this.children = [] }
  appendChild(child) { this.children.push(child) }
}
async function verify(id, name) {
  const box = new Element(), label = new Element()
  const storage = new Map(), switched = []
  const modelID = "@cf/team/model-with/slashes"
  const state = { models: [{ providerID: id, providerName: name, id: modelID, name: "Friendly model", image: true }], selectedModel: null, activeSessionID: "ses_fixture" }
  const context = {
    state, providerState: { list: [{ id, name, models: [{ id: modelID }] }] },
    document: { getElementById: () => box, createElement: () => new Element() },
    $: () => label, localStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    closeAllMenus() {}, updateUsageRing() {}, hideError() {}, showError() {},
    vibe: { setModel: async (payload) => { switched.push(payload); return { ok: true, data: { selectedModel: `${id}/${modelID}` } } } },
  }
  vm.createContext(context)
  vm.runInContext(labelCode + "\n" + listCode + "\nrenderModelList()", context)
  const heading = box.children.find((e) => e.className === "mr-group")
  assert.equal(heading.textContent, name, "the provider name appears once, without a second ID/name")
  const button = box.children.find((e) => e.className === "mr-item")
  assert.equal(button.dataset.model, `${id}/${modelID}`, "the canonical model key is unchanged")
  assert.equal(button.textContent, modelID, "model choices keep their original text")
  await button.onclick()
  assert.equal(state.selectedModel, `${id}/${modelID}`)
  assert.deepEqual(JSON.parse(JSON.stringify(switched[0])), { sessionID: "ses_fixture", model: { providerID: id, id: modelID } })
  assert.equal(storage.get("vibecoder.model"), `${id}/${modelID}`)
  assert.equal(label.textContent, `${name} · Friendly model`, "the existing closed composer label stays unchanged")
}
;(async () => {
  await verify("cloudfire", "cloudfire")
  await verify("custom-provider-id", "My provider")
  console.log("PASS provider heading: one name; composer label, model IDs, image choices, persistence and switching unchanged")
})().catch((error) => { console.error(error); process.exitCode = 1 })
