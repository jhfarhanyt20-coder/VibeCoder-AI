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
const skin = read("renderer/skin.css")
const obsidian = read("renderer/obsidian.css")
const backend = read("electron/backend.cjs")
const preload = read("electron/preload.cjs")
const messages = read("electron/messages.cjs")
const main = read("electron/main.cjs")
const themeBoot = read("renderer/theme.js")

// CSP is style-src 'self': inline style attributes are blocked by the renderer.
assert.doesNotMatch(html, /\sstyle=/, "renderer HTML must not use inline style attributes")
assert.match(html, /<link rel="stylesheet" href="skin\.css" \/>/)
assert.match(skin, /consistent application surfaces and settings finish/)
assert.match(html, /<link rel="stylesheet" href="obsidian\.css" \/>/)
assert.ok(html.indexOf('href="obsidian.css"') > html.indexOf('href="skin.css"'), "Obsidian must load after the base skin")
assert.match(obsidian, /Obsidian production skin/)
for (const selector of ["#btn-new-task", ".settings-nav", ".ctx-menu", ".dlg-box", ".modal", ".file-row"]) {
  assert.ok(obsidian.includes(`html[data-theme="obsidian"] ${selector}`), `Obsidian is missing scoped ${selector}`)
}
assert.doesNotMatch(obsidian, /(^|\n)\s*:root\s*[,\{]/, "Obsidian must not override the original themes")
for (const theme of ["obsidian", "dark", "amoled", "light", "system"]) {
  assert.match(html, new RegExp(`<option value=["']${theme}["']`), `missing Appearance option ${theme}`)
}
assert.match(app, /const THEMES = \[[^\]]*["']obsidian["'][^\]]*["']dark["'][^\]]*["']amoled["'][^\]]*["']light["'][^\]]*["']system["'][^\]]*\]/)
assert.match(themeBoot, /resolved === ["']obsidian["']/)
assert.match(main, /nativeImage\.createFromDataURL\(/, "Windows title-bar icon must use a transparent image")
assert.match(app, /tone === ["']warning["']/)
assert.match(app, /Saved, but this format may not work[\s\S]*tone: ["']warning["']/)
assert.match(css, /\.error-banner\[data-tone=["']warning["']\]/)
assert.match(obsidian, /\.error-banner\[data-tone=\"warning\"\]/)
assert.match(app, /function normalizedFontPx\(/)
assert.match(app, /raw < 4 \? raw \* 14 : raw/)
assert.match(app, /localStorage\.setItem\(FONT_KEY, String\(n\)\)/)
assert.match(app, /--range-pct/)
assert.match(themeBoot, /savedFont < 4 \? savedFont \* 14 : savedFont/)
assert.match(css, /--range-pct/)
assert.match(css, /\.settings-page input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)/)
assert.match(skin, /\.settings-page input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)/)
assert.match(skin, /html:not\(\[data-theme="obsidian"\]\) \.composer-foot\s*\{[^}]*flex-wrap: wrap/, "original themes must wrap crowded composer controls")
assert.match(skin, /\.composer-foot > \.menu-wrap:has\(#btn-model\)\s*\{[^}]*flex: 1 1 140px/, "model labels need a shrinkable container")
assert.match(skin, /#model-label\s*\{[^}]*text-overflow: ellipsis/, "long model names must not squeeze Send/Stop")
assert.match(skin, /\.composer \.send\s*\{[^}]*flex: 0 0 32px/, "Send/Stop must retain its full clickable width")
assert.match(skin, /\.composer \.mode-pill \.mdl,[\s\S]*?font-family: var\(--font-ui\)/, "composer labels must use the UI font, not the code font")
assert.match(skin, /html:not\(\[data-theme="obsidian"\]\) \.msg.assistant \.bubble\s*\{[^}]*line-height: 1\.78/, "chat text must keep Obsidian's reading rhythm")
for (const label of [
  "General", "App Updates", "Appearance", "Model settings", "Browser Use",
  "Computer Use", "Keyboard Shortcuts", "Memory", "Subagents", "Marketplace",
  "Plugins", "MCP Servers", "Skills", "Commands", "Hooks", "Usage", "Privacy",
]) {
  assert.ok(html.includes(`>${label}<`) || html.includes(`> ${label}<`), `Settings navigation lost ${label}`)
}

// Product UI copy is English-only: no Bangla script and no Banglish strings.
const banglaScript = /[\u0980-\u09FF]/
const banglishCopy = /\b(notun|naam|ashbe|jayota|nijei|shudhu|pathate|parlam|banaye|dekhai|ekhane|korbe|korle|hobe|theke|kichu|kono|apni|tumi|mone|gulo|jabe|dekhao)\b/i
for (const [file, source] of [["renderer/index.html", html], ["renderer/app.js", app]]) {
  assert.doesNotMatch(source, banglaScript, `${file} must not contain Bangla UI copy`)
  assert.doesNotMatch(source, banglishCopy, `${file} must not contain Banglish UI copy`)
}

// The V brand mark collapses the sidebar and leaves an accessible restore
// button in the main pane. The preference survives a restart.
for (const id of ["app-sidebar", "btn-sidebar-toggle", "btn-sidebar-restore"]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing sidebar control ${id}`)
}
assert.match(app, /const SIDEBAR_HIDDEN_KEY = ["']vibe\.sidebarHidden["']/)
assert.match(app, /classList\.toggle\(["']sidebar-hidden["']/)
assert.match(app, /btn-sidebar-toggle["']\)\?\.addEventListener\(["']click["']/)
assert.match(app, /btn-sidebar-restore["']\)\?\.addEventListener\(["']click["']/)
assert.match(css, /\.shell\.sidebar-hidden \.sidebar/)
assert.match(css, /\.sidebar-restore\[hidden\]/)
assert.match(css, /\.shell\.sidebar-hidden \.sidebar-restore\s*\{ z-index: 60/, "sidebar restore must stay above the running badge")
assert.match(css, /\.shell\.sidebar-hidden \.main > \.bg-job\s*\{ left: 52px/, "running badge must leave room for sidebar restore")
assert.match(app, /event\.key\.toLowerCase\(\) === "b"/, "sidebar must have a keyboard recovery shortcut")
assert.match(html, /id=["']jump-live["']/)
assert.match(app, /\$\(["']messages["']\)\.addEventListener\(["']scroll["'], updateJumpButton/)
assert.match(app, /\$\(["']main["']\)\?\.addEventListener\(["']wheel["']/)
assert.match(app, /event\.preventDefault\(\)\s*\n\s*updateJumpButton\(\)/)
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
assert.doesNotMatch(app, /Step \$\{pulse\.step\}/, "composer must not display step/action counters")
assert.match(app, /COMPOSER_DRAFT_KEY = "vibecoder\.composerDraft"/)
assert.match(app, /localStorage\.setItem\(COMPOSER_DRAFT_KEY/)
assert.match(app, /You · Pending/)
assert.match(preload, /queuePrompt: call\("queuePrompt"\)/)
assert.match(backend, /queuePrompt: async/)
assert.doesNotMatch(app, /clearQueuedPrompts\(\)/, "Stop must not discard pending user messages")
assert.match(css, /\.rewind-menu/)
assert.match(css, /\.harness-note\.locked/)
assert.match(preload, /shellInput: call\("shellInput"\)/)
assert.match(backend, /shellInput: async/)
const toolsSrc = read("core/tools/index.js")
assert.match(toolsSrc, /name: "shellList"/)
assert.match(toolsSrc, /name: "shellOutput"/)
assert.match(toolsSrc, /readShellOutput/)
assert.match(read("core/engine.js"), /_runningShellParts/)
assert.match(read("core/engine.js"), /recordShellProgress/)
assert.match(read("core/jobs.js"), /readOutput/)
assert.match(app, /waiting for input/)
for (const event of ["session.shell.started", "session.shell.output", "session.shell.input", "session.shell.waiting", "session.shell.ended", "session.shell.completed"]) {
  assert.match(backend, new RegExp(event.replaceAll(".", "\\.")), `backend does not map ${event}`)
}
assert.match(backend, /case "shell\.resume\.started"/)
assert.match(backend, /source: "shell-result"/)
assert.match(app, /data\.source === "shell-result"/)
assert.match(app, /const waitingForShell =/)
assert.match(app, /async function sendRunningShellInput/)
assert.match(app, /type === "session\.shell\.output"/)
assert.match(app, /function startShellJobSync\(/, "background shell snapshots must reconcile after missed renderer events")
assert.match(app, /Number\(job\.outputSize \|\| 0\)/, "open background console panels must refresh from reconciled output snapshots")
assert.match(app, /shellSyncTimer = setInterval/, "background shell reconciliation must run periodically")
assert.match(app, /applyFinalShellOutput\(sh, finalOutput\)/, "completed shell snapshots must repair missing live output deltas")
assert.match(app, /const missedStart = !job && !!sh\.id/, "output events must reconstruct a shell row if the start event was missed")
assert.match(app, /vibe\.shellInput\(/)
assert.match(css, /\.bji-output/)
assert.match(css, /\.bji-input-row/)

const syntax = spawnSync(process.execPath, ["--check", path.join(root, "renderer", "app.js")], { encoding: "utf8" })
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout)

console.log("PASS harness UI regression: Pulse, permissions, Rewind and live shell controls are wired end-to-end")
