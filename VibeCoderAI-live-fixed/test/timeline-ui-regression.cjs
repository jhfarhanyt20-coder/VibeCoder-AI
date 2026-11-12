"use strict"
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const root = path.join(__dirname, "..")
const source = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8")
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8")
const css = fs.readFileSync(path.join(root, "renderer/theme.css"), "utf8")
const start = source.indexOf("const TIMELINE_KEY =")
const end = source.indexOf("function timelineGroup(", start)
assert(start > 0 && end > start)
const saved = new Map()
const context = vm.createContext({ localStorage: { getItem: (key) => saved.get(key) || null } })
vm.runInContext(source.slice(start, end), context)
const prefs = () => JSON.parse(vm.runInContext("JSON.stringify(loadTimelinePreferences())", context))
for (const row of Object.values(prefs())) assert.deepEqual(row, { group: true, collapse: true })
saved.set("vibecoder.timelinePreferences", JSON.stringify({ shell: { group: false, collapse: false }, edits: { group: false } }))
assert.deepEqual(prefs().shell, { group: false, collapse: false })
assert.deepEqual(prefs().edits, { group: false, collapse: true })
assert.deepEqual(prefs().thinking, { group: true, collapse: true })
saved.set("vibecoder.timelinePreferences", "broken json")
assert.deepEqual(prefs().tools, { group: true, collapse: true })
for (const [tool, expected] of [["bash", "shell"], ["terminal", "shell"], ["shellOutput", "shell"], ["apply_patch", "edits"], ["multiedit", "edits"], ["patch", "edits"], ["subagent", "subagents"], ["read", "tools"]]) {
  assert.equal(vm.runInContext(`timelineCategory(${JSON.stringify(tool)})`, context), expected)
}
const summaryStart = source.indexOf("function updateTimelineGroup(")
const summaryEnd = source.indexOf("function appendTimeline(", summaryStart)
vm.runInContext(source.slice(summaryStart, summaryEnd), context)
const summary = (items, manual = false, initiallyCollapsed = true) => {
  const values = {}
  let collapsed = initiallyCollapsed
  const group = {
    dataset: manual ? { manualExpansion: "1" } : {},
    querySelector: (selector) => selector === ".used-list" ? { children: items.map((dataset) => ({ dataset })) } : {
      set textContent(value) { values[selector] = value },
      setAttribute: (name, value) => { values[name] = value },
    },
    classList: { contains: () => collapsed, toggle: (_, value) => { collapsed = value } },
  }
  context.group = group
  vm.runInContext("updateTimelineGroup(group)", context)
  return { values, collapsed }
}
const mixed = [
  { timelineItem: "thinking" },
  { timelineItem: "edits", timelineTool: "Edit" },
  { timelineItem: "shell", timelineTool: "Shell" },
  { timelineItem: "thinking" },
  { timelineItem: "tools", timelineTool: "Read" },
  { timelineItem: "edits", timelineTool: "Edit" },
]
let result = summary(mixed)
assert.equal(result.values[".used-n"], "Used 4", "count tool calls, not thinking or duplicate labels")
assert.equal(result.values[".used-names"], "Edit, Shell, Read", "deduplicate labels in first-use order")
assert.equal(result.collapsed, true)
assert.equal(result.values["aria-expanded"], "false")
result = summary(mixed, true, false)
assert.equal(result.collapsed, false, "new activity must not collapse a manually opened group")
vm.runInContext("timelinePreferences.shell.collapse = false", context)
assert.equal(summary(mixed).collapsed, false, "mixed group respects expanded category preference")
assert.equal(summary([{ timelineItem: "thinking" }]).values[".used-names"], "Thinking")
assert(html.includes('id="timeline-preferences"'))
assert(source.includes("localStorage.setItem(TIMELINE_KEY, JSON.stringify(timelinePreferences))"))
assert(source.includes('appendTimeline(el, "thinking")'))
assert(source.includes('appendTimeline(el, "notices")'))
assert(source.includes('appendTimeline(el, "commentary")'))
const append = source.slice(source.indexOf("function appendTimeline("), source.indexOf("function refreshTimelinePreferences("))
assert(!append.includes("timelineCategory !=="), "mixed categories must share one group")
assert(source.includes("new ResizeObserver(updateJumpButton)"))
assert(source.includes("box.right - frame.left + 10"))
assert(css.includes(".main:not(.empty) #composer"))
assert(!css.includes("bottom: 150px;"))
console.log("PASS unified timeline: mixed tool/thinking summary, unique tool labels and counts, manual expansion, saved off settings, category isolation controls, live/history wiring and jump gutter")
