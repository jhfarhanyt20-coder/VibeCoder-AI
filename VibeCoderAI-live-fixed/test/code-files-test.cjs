"use strict"
// Code panel files: only inside the open project, line endings and BOM kept,
// a file the agent changed meanwhile is not silently overwritten.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const code = require("../electron/code-files.cjs")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-code-"))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-out-"))
try {
  fs.mkdirSync(path.join(root, "src"))
  fs.mkdirSync(path.join(root, "node_modules", "big"), { recursive: true })
  fs.writeFileSync(path.join(root, "node_modules", "big", "index.js"), "x")
  fs.writeFileSync(path.join(root, "src", "app.js"), "const a = 1\r\nconst b = 2\r\n")
  fs.writeFileSync(path.join(root, "README.md"), "﻿# Title\n")
  fs.writeFileSync(path.join(root, "logo.bin"), Buffer.from([1, 0, 2, 3]))
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret")

  // The list: folders first, heavy generated folders listed but not opened.
  const tree = code.codeTree(root)
  assert.equal(tree.files, 3)
  assert.deepEqual(tree.tree.map((n) => n.name), ["node_modules", "src", "logo.bin", "README.md"])
  assert.equal(tree.tree[0].skipped, true)
  assert.deepEqual(tree.tree[0].children, [])

  // Read keeps CRLF and BOM information; binary files are not shown as text.
  const app = code.codeRead(root, { file: "src/app.js" })
  assert.equal(app.path, "src/app.js")
  assert.equal(app.eol, "\r\n")
  const readme = code.codeRead(root, { file: path.join(root, "README.md") })
  assert.equal(readme.bom, true)
  assert.equal(readme.text, "# Title\n")
  assert.equal(code.codeRead(root, { file: "logo.bin" }).binary, true)

  // Nothing outside the project folder, also not through "..".
  assert.throws(() => code.codeRead(root, { file: path.join(outside, "secret.txt") }), /outside the open project/)
  assert.throws(() => code.codeRead(root, { file: "../" + path.basename(outside) + "/secret.txt" }), /outside the open project/)
  assert.throws(() => code.codeWrite(root, { file: path.join(outside, "secret.txt"), text: "x" }), /outside the open project/)
  assert.throws(() => code.codeRead(null, { file: "a" }), /No project folder/)
  // A link inside the project that points outside is refused too.
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"))
    assert.throws(() => code.codeRead(root, { file: "link.txt" }), /outside the open project/)
  } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") throw e // no symlink rights on this Windows account
  }

  // Save: the editor's \n text goes back with the file's own CRLF and BOM.
  const saved = code.codeWrite(root, { file: "src/app.js", text: "const a = 10\nconst b = 2\n", mtimeMs: app.mtimeMs, eol: app.eol })
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "const a = 10\r\nconst b = 2\r\n")
  code.codeWrite(root, { file: "README.md", text: "# New\n", mtimeMs: readme.mtimeMs, eol: "\n", bom: true })
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "﻿# New\n")

  // Changed on disk after it was opened (the agent edited it): refused unless forced.
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(root, "src", "app.js"), later, later)
  assert.throws(() => code.codeWrite(root, { file: "src/app.js", text: "mine\n", mtimeMs: saved.mtimeMs, eol: "\r\n" }), /changed on disk/)
  code.codeWrite(root, { file: "src/app.js", text: "mine\n", mtimeMs: saved.mtimeMs, eol: "\r\n", force: true })
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), "mine\r\n")

  // Only existing files are saved here.
  assert.throws(() => code.codeWrite(root, { file: "src/new.js", text: "x" }), /existing file/)
  console.log("PASS code panel files: project-only paths, CRLF/BOM kept, changed-on-disk guard, binary and big files")
} finally {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
}

// The renderer side: CodeMirror is vendored with its licence, the panel is
// wired to the file name in the chat (the row's own click stays), and the
// IPC names exist in the preload and the backend.
{
  const r = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  const html = r('renderer/index.html')
  for (const f of ['codemirror.js', 'codemirror.css', 'LICENSE', 'mode-javascript.js', 'addon-search.js']) assert(fs.existsSync(path.join(__dirname, '..', 'renderer/vendor/codemirror', f)), f)
  assert(html.indexOf('vendor/codemirror/codemirror.js') < html.indexOf('code-panel.js'))
  assert(html.indexOf('code-panel.js') < html.indexOf('src="app.js"'))
  assert(html.includes('id="btn-code-files"') && html.includes('id="code-panel"'))
  const app = require("./renderer-app-source.cjs")()
  const link = app.slice(app.indexOf("function linkFileName("), app.indexOf("function linkFileName(") + 600)
  assert(link.includes("event.stopPropagation()") && link.includes("window.vibeCodePanel.open(file"), "a name click opens the editor, not the diff")
  assert(app.includes('linkFileName(row.querySelector(".fr-name"), full, () => changedLinesOf(f))'))
  // changedLinesOf: new-file line numbers of added lines, from a patch.
  const start = app.indexOf('function changedLinesOf(')
  const fn = new Function(app.slice(start, app.indexOf('function linkFileName(')) + '; return changedLinesOf')()
  assert.deepEqual(fn({ patch: ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' c'].join('\n') }), [2, 3])
  assert.deepEqual(fn({ hunks: [{ newStart: 10, lines: [{ type: 'equal' }, { type: 'del' }, { type: 'add' }, { type: 'equal' }, { type: 'add' }] }] }), [11, 13])
  for (const name of ['codeTree', 'codeRead', 'codeWrite']) {
    assert(r('electron/preload.cjs').includes(name + ': call("' + name + '")'), name)
    assert(r('electron/backend.cjs').includes('"' + name + '"'), name)
  }
  // The side-panel icon (sidebar + title bar) opens the launcher: changes, browser, files.
  assert(html.includes('id="side-launch"') && html.includes('id="btn-side-panel"'))
  for (const k of ['changes', 'browser', 'files']) assert(html.includes('data-open="' + k + '"'), k)
  assert(html.indexOf('side-launch.js') > html.indexOf('code-panel.js') && html.indexOf('side-launch.js') < html.indexOf('src="app.js"'))
  assert(app.includes('window.vibeSidePanel ? window.vibeSidePanel.toggle() : toggleBrowser()'), 'the sidebar icon opens the side panel')
  assert(/id="chip-browser"[^>]*hidden>/.test(html), 'no side-panel icon next to Settings; the title bar has it')
  assert(r('renderer/polish.css').includes('.has-vc-icon[hidden] { display: none !important; }'), 'a hidden icon button stays hidden')
  assert(r('renderer/icons.js').includes('"chip-browser": "panelRight"'))
  console.log('PASS code panel UI: vendored CodeMirror, file name opens the editor, changed lines, IPC names, side panel launcher')
}
