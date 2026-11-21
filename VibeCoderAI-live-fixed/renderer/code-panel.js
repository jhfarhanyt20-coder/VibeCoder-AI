"use strict"
// Code panel, docked on the right: open files as tabs, a colour-coded editor
// (CodeMirror 5, vendored) where the user can edit and save, the lines the
// agent changed marked in the gutter, and the project's files on the right
// with a filter and their git state. Opened from a file name in the chat
// (window.vibeCodePanel.open) or from the folder icon in the title bar.
;(function () {
  const $ = (id) => document.getElementById(id)
  const panel = $("code-panel")
  if (!panel || typeof window.CodeMirror !== "function") return
  const api = () => window.vibe || {}
  const WIDTH_KEY = "vibecoder.codePanelWidth"
  const TREE_KEY = "vibecoder.codeTreeWidth"
  const TREE_HIDDEN_KEY = "vibecoder.codeTreeHidden"
  const store = {
    get(k) { try { return localStorage.getItem(k) } catch { return null } },
    set(k, v) { try { localStorage.setItem(k, v) } catch { /* storage blocked */ } },
  }

  const tabs = [] // { path, name, doc, mtimeMs, eol, bom, clean, note }
  let active = null
  let cm = null
  let treeData = null
  let treeLoading = null
  const expanded = new Set()
  let changesOnly = false // the file list shows only new / changed files

  /* ---------- language by file name ---------- */
  const MODES = {
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: { name: "javascript", typescript: true }, tsx: { name: "javascript", typescript: true },
    json: { name: "javascript", json: true }, jsonc: { name: "javascript", json: true },
    css: "css", scss: "text/x-scss", less: "text/x-less",
    html: "htmlmixed", htm: "htmlmixed", vue: "htmlmixed", svelte: "htmlmixed",
    xml: "xml", svg: "xml", xaml: "xml", csproj: "xml",
    py: "python", pyw: "python", md: "markdown", markdown: "markdown",
    c: "text/x-csrc", h: "text/x-csrc", cpp: "text/x-c++src", cc: "text/x-c++src", hpp: "text/x-c++src",
    cs: "text/x-csharp", java: "text/x-java", kt: "text/x-kotlin", dart: "text/x-java",
    sh: "shell", bash: "shell", zsh: "shell", sql: "sql", yml: "yaml", yaml: "yaml",
    go: "go", rs: "rust", php: "application/x-httpd-php", ps1: "powershell", psm1: "powershell",
    toml: "toml", diff: "diff", patch: "diff",
  }
  function modeFor(name) {
    const lower = String(name).toLowerCase()
    if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return "dockerfile"
    const ext = lower.includes(".") ? lower.split(".").pop() : ""
    return MODES[ext] || "text/plain"
  }
  const base = (p) => String(p).split("/").pop()

  /* ---------- the editor ---------- */
  function editor() {
    if (cm) return cm
    $("code-empty").hidden = true
    cm = window.CodeMirror($("code-editor"), {
      lineNumbers: true,
      lineWrapping: true,
      matchBrackets: true,
      styleActiveLine: true,
      indentUnit: 2,
      tabSize: 2,
      gutters: ["code-mark-gutter", "CodeMirror-linenumbers"],
      extraKeys: {
        "Ctrl-S": () => save(),
        "Cmd-S": () => save(),
      },
    })
    cm.on("changes", () => updateDirty())
    return cm
  }

  function updateDirty() {
    if (!active) return
    const dirty = !active.doc.isClean(active.clean)
    $("code-save").disabled = !dirty
    const t = $("code-tabs").querySelector(`[data-path="${CSS.escape(active.path)}"]`)
    if (t) t.classList.toggle("dirty", dirty)
    if (dirty) status("")
  }
  const isDirty = (t) => !t.doc.isClean(t.clean)

  function status(text, kind = "") {
    const s = $("code-status")
    s.textContent = text
    s.className = "code-status" + (kind ? ` ${kind}` : "")
  }

  /* ---------- tabs ---------- */
  function renderTabs() {
    const box = $("code-tabs")
    box.replaceChildren()
    for (const t of tabs) {
      const b = document.createElement("div")
      b.className = "code-tab" + (t === active ? " active" : "") + (isDirty(t) ? " dirty" : "")
      b.dataset.path = t.path
      b.setAttribute("role", "tab")
      b.title = t.path
      const name = document.createElement("span")
      name.className = "code-tab-name"
      name.textContent = t.name
      const x = document.createElement("button")
      x.type = "button"
      x.className = "code-tab-x"
      x.title = "Close this file"
      x.textContent = "✕"
      x.onclick = (e) => { e.stopPropagation(); closeTab(t) }
      b.onclick = () => activate(t)
      b.onauxclick = (e) => { if (e.button === 1) closeTab(t) }
      b.append(name, x)
      box.appendChild(b)
    }
  }

  function renderCrumbs() {
    const box = $("code-crumbs")
    box.replaceChildren()
    if (!active) return
    const parts = [treeData?.name || "", ...active.path.split("/")].filter(Boolean)
    parts.forEach((p, i) => {
      if (i) {
        const sep = document.createElement("span")
        sep.className = "code-crumb-sep"
        sep.textContent = "›"
        box.appendChild(sep)
      }
      const c = document.createElement("span")
      c.className = "code-crumb" + (i === parts.length - 1 ? " last" : "")
      c.textContent = p
      box.appendChild(c)
    })
    box.title = active.path
  }

  function activate(t) {
    active = t
    const ed = editor()
    ed.swapDoc(t.doc)
    renderTabs()
    renderCrumbs()
    updateDirty()
    status(t.note || "")
    revealInTree(t.path)
    setTimeout(() => ed.refresh(), 0)
  }

  async function closeTab(t) {
    if (isDirty(t)) {
      const ok = await confirmBox(`"${t.name}" has changes that are not saved. Close it and lose them?`, "Unsaved changes", "Close without saving")
      if (!ok) return
    }
    const i = tabs.indexOf(t)
    if (i >= 0) tabs.splice(i, 1)
    if (active === t) {
      active = null
      const next = tabs[i] || tabs[i - 1]
      if (next) activate(next)
      else {
        cm?.swapDoc(window.CodeMirror.Doc("", "text/plain"))
        if (cm) cm.getWrapperElement().hidden = true
        $("code-empty").hidden = false
        $("code-save").disabled = true
        renderTabs()
        renderCrumbs()
        status("")
      }
    } else renderTabs()
  }

  function confirmBox(message, title, okText) {
    if (typeof window.showConfirm === "function") return window.showConfirm(message, title, okText)
    try { if (typeof showConfirm === "function") return showConfirm(message, title, okText) } catch { /* not loaded */ }
    return Promise.resolve(window.confirm(message))
  }

  /* ---------- the agent's changed lines ---------- */
  function markLines(t, lines) {
    const doc = t.doc
    const ed = editor()
    doc.eachLine((h) => { doc.removeLineClass(h, "background", "code-changed-line") })
    if (ed.getDoc() === doc) ed.clearGutter("code-mark-gutter")
    if (!Array.isArray(lines) || !lines.length) return
    for (const n of lines) {
      const i = Number(n) - 1
      if (!(i >= 0 && i < doc.lineCount())) continue
      doc.addLineClass(i, "background", "code-changed-line")
      const mark = document.createElement("span")
      mark.className = "code-changed-mark"
      // Gutter markers live on the editor; set them while this doc is shown.
      if (ed.getDoc() === doc) ed.setGutterMarker(i, "code-mark-gutter", mark)
    }
    t.pendingMarks = lines
  }

  /* ---------- open / reload / save ---------- */
  async function read(file) {
    const r = await api().codeRead?.({ file })
    if (!r || r.ok === false) throw new Error(r?.error || "Could not open the file")
    return r.data
  }

  async function open(file, opts = {}) {
    show()
    if (!file) return
    status("Opening…")
    let data
    try { data = await read(file) } catch (e) { status(String(e.message || e), "error"); return }
    let t = tabs.find((x) => x.path === data.path)
    const note = data.tooBig ? "This file is too large to show here (over 2 MB)." : data.binary ? "This is a binary file; it cannot be shown as text." : ""
    if (t && isDirty(t)) {
      activate(t) // keep the user's unsaved edits
    } else {
      const doc = window.CodeMirror.Doc(note ? "" : data.text, modeFor(data.name))
      if (t) {
        t.doc = doc
        Object.assign(t, { mtimeMs: data.mtimeMs, eol: data.eol, bom: data.bom, note, readOnly: !!note })
      } else {
        t = { path: data.path, name: data.name, doc, mtimeMs: data.mtimeMs, eol: data.eol, bom: data.bom, note, readOnly: !!note }
        tabs.push(t)
      }
      t.clean = doc.changeGeneration(true)
      activate(t)
    }
    cm.setOption("readOnly", t.readOnly ? "nocursor" : false)
    cm.getWrapperElement().hidden = false
    if (opts.lines) {
      markLines(t, opts.lines)
      const first = Math.min(...opts.lines.map(Number).filter((n) => n > 0))
      if (Number.isFinite(first)) cm.scrollIntoView({ line: first - 1, ch: 0 }, 120)
    }
    status(note || "")
  }

  async function save(force = false) {
    const t = active
    if (!t || t.readOnly || (!isDirty(t) && !force)) return
    status("Saving…")
    const r = await api().codeWrite?.({ file: t.path, text: t.doc.getValue(), mtimeMs: t.mtimeMs, eol: t.eol, bom: t.bom, force })
    if (r && r.ok !== false) {
      t.mtimeMs = r.data.mtimeMs
      t.clean = t.doc.changeGeneration(true)
      updateDirty()
      renderTabs()
      status("Saved", "ok")
      loadTree(true)
      return
    }
    const msg = r?.error || "Could not save the file"
    if (/changed on disk/i.test(msg) && !force) {
      status("")
      const ok = await confirmBox(`${t.name} was changed on disk after you opened it (the agent may have edited it).\n\nSave your version anyway and overwrite those changes?`, "File changed on disk", "Overwrite")
      if (ok) return save(true)
      status("Not saved. Close the tab and open the file again to see the newer version.", "error")
      return
    }
    status(msg, "error")
  }

  /* ---------- the file list ---------- */
  async function loadTree(force = false) {
    if (treeData && !force) return treeData
    if (treeLoading) return treeLoading
    treeLoading = (async () => {
      const r = await api().codeTree?.()
      treeLoading = null
      if (!r || r.ok === false) {
        treeData = null
        $("code-tree-name").textContent = "Project files"
        $("code-tree-count").textContent = ""
        const list = $("code-tree-list")
        list.replaceChildren()
        const p = document.createElement("div")
        p.className = "code-tree-note"
        p.textContent = r?.error || "Open a project folder to see its files."
        list.appendChild(p)
        return null
      }
      treeData = r.data
      $("code-tree-name").textContent = treeData.name
      $("code-tree-name").title = treeData.root
      $("code-tree-count").textContent = `${treeData.files}${treeData.truncated ? "+" : ""} file${treeData.files === 1 ? "" : "s"}`
      renderTree()
      renderCrumbs()
      return treeData
    })()
    return treeLoading
  }

  const statusOf = (p) => treeData?.status?.[p] || ""
  const dirStatus = (node) => {
    const s = treeData?.status || {}
    const prefix = node.path + "/"
    for (const k in s) if (k.startsWith(prefix)) return true
    return false
  }

  function treeRow(node, depth) {
    const row = document.createElement("div")
    row.className = "code-node" + (node.dir ? " dir" : " file") + (node.skipped ? " skipped" : "")
    row.setAttribute("role", "treeitem")
    row.dataset.path = node.path
    row.style.paddingLeft = `${8 + depth * 14}px`
    const caret = document.createElement("span")
    caret.className = "code-caret"
    caret.textContent = node.dir ? (expanded.has(node.path) ? "▾" : "▸") : ""
    const name = document.createElement("span")
    name.className = "code-node-name"
    name.textContent = node.name
    const st = document.createElement("span")
    st.className = "code-node-st"
    if (node.dir) { if (!node.skipped && dirStatus(node)) st.classList.add("dot") }
    else {
      const s = statusOf(node.path)
      if (s) { st.textContent = s; st.classList.add(`st-${s}`) }
    }
    row.append(caret, name, st)
    if (node.skipped) row.title = `${node.name} is not listed (too many generated files)`
    if (active && active.path === node.path) row.classList.add("active")
    row.onclick = () => {
      if (node.dir) {
        if (node.skipped) return
        if (expanded.has(node.path)) expanded.delete(node.path)
        else expanded.add(node.path)
        renderTree()
      } else open(node.path)
    }
    return row
  }

  function renderTree() {
    const list = $("code-tree-list")
    list.replaceChildren()
    if (!treeData) return
    const q = $("code-tree-filter").value.trim().toLowerCase()
    if (changesOnly) {
      const paths = Object.keys(treeData.status || {}).filter((p) => !q || p.toLowerCase().includes(q)).sort()
      for (const p of paths) {
        const row = treeRow({ name: base(p), path: p }, 0)
        row.querySelector(".code-node-name").textContent = p
        list.appendChild(row)
      }
      if (!paths.length) {
        const n = document.createElement("div")
        n.className = "code-tree-note"
        n.textContent = Object.keys(treeData.status || {}).length ? "No changed file matches." : "No new or changed files (or this folder is not a git project)."
        list.appendChild(n)
      }
      return
    }
    if (q) {
      const hits = []
      const walk = (nodes) => { for (const n of nodes) { if (n.dir) walk(n.children || []); else if (n.path.toLowerCase().includes(q)) hits.push(n) } }
      walk(treeData.tree)
      for (const n of hits.slice(0, 400)) {
        const row = treeRow(n, 0)
        row.querySelector(".code-node-name").textContent = n.path
        list.appendChild(row)
      }
      if (!hits.length) {
        const p = document.createElement("div")
        p.className = "code-tree-note"
        p.textContent = "No file matches."
        list.appendChild(p)
      }
      return
    }
    const add = (nodes, depth) => {
      for (const n of nodes) {
        list.appendChild(treeRow(n, depth))
        if (n.dir && expanded.has(n.path)) add(n.children || [], depth + 1)
      }
    }
    add(treeData.tree, 0)
  }

  function revealInTree(p) {
    if (!p) return
    const parts = p.split("/")
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join("/"))
    renderTree()
    const row = $("code-tree-list").querySelector(`.code-node[data-path="${CSS.escape(p)}"]`)
    row?.scrollIntoView({ block: "nearest" })
  }

  /* ---------- show / hide, sizes ---------- */
  function applyTreeHidden(hidden) {
    $("code-tree").hidden = hidden
    $("code-split").hidden = hidden
    $("code-tree-toggle").setAttribute("aria-pressed", hidden ? "false" : "true")
    $("code-tree-toggle").classList.toggle("on", !hidden)
    store.set(TREE_HIDDEN_KEY, hidden ? "1" : "0")
    cm?.refresh()
  }

  function show() {
    if (panel.hidden) {
      panel.hidden = false
      const w = Number(store.get(WIDTH_KEY))
      if (w > 0) panel.style.width = `${w}px`
      const tw = Number(store.get(TREE_KEY))
      if (tw > 0) $("code-tree").style.width = `${tw}px`
      $("btn-code-files")?.classList.add("on")
      loadTree(true) // the project folder may have changed while it was closed
    } else loadTree()
    setTimeout(() => cm?.refresh(), 0)
  }

  async function hide() {
    const dirty = tabs.filter(isDirty)
    if (dirty.length) {
      const ok = await confirmBox(`${dirty.length === 1 ? `"${dirty[0].name}" has` : `${dirty.length} files have`} changes that are not saved. Close the code panel and lose them?`, "Unsaved changes", "Close without saving")
      if (!ok) return
      // Drop the unsaved files; the saved ones stay open for next time.
      for (const t of dirty) { t.doc.markClean(); t.clean = t.doc.changeGeneration(true); await closeTab(t) }
    }
    panel.hidden = true
    panel.classList.remove("max")
    $("btn-code-files")?.classList.remove("on")
  }

  function dragEdge(handle, onMove, onEnd) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      handle.setPointerCapture(e.pointerId)
      handle.classList.add("dragging")
      panel.classList.add("resizing")
      const move = (ev) => onMove(ev)
      const up = () => {
        handle.classList.remove("dragging")
        panel.classList.remove("resizing")
        handle.removeEventListener("pointermove", move)
        handle.removeEventListener("pointerup", up)
        handle.removeEventListener("pointercancel", up)
        onEnd()
        cm?.refresh()
      }
      handle.addEventListener("pointermove", move)
      handle.addEventListener("pointerup", up)
      handle.addEventListener("pointercancel", up)
    })
  }

  // The panel's left edge: wider / narrower (the chat keeps at least 360px).
  dragEdge($("code-resize"), (e) => {
    const right = panel.getBoundingClientRect().right
    const max = Math.max(360, window.innerWidth - 360)
    const w = Math.round(Math.min(max, Math.max(340, right - e.clientX)))
    panel.classList.remove("max")
    panel.style.width = `${w}px`
  }, () => store.set(WIDTH_KEY, String(parseInt(panel.style.width, 10) || "")))
  $("code-resize").addEventListener("dblclick", () => { panel.style.width = ""; panel.classList.remove("max"); store.set(WIDTH_KEY, ""); cm?.refresh() })

  // Between the editor and the file list.
  dragEdge($("code-split"), (e) => {
    const right = $("code-body").getBoundingClientRect().right
    const w = Math.round(Math.min(480, Math.max(150, right - e.clientX)))
    $("code-tree").style.width = `${w}px`
  }, () => store.set(TREE_KEY, String(parseInt($("code-tree").style.width, 10) || "")))
  $("code-split").addEventListener("dblclick", () => { $("code-tree").style.width = ""; store.set(TREE_KEY, ""); cm?.refresh() })

  /* ---------- buttons ---------- */
  $("code-close").onclick = () => hide()
  $("code-save").onclick = () => save()
  $("code-max").onclick = () => {
    const on = panel.classList.toggle("max")
    $("code-max").title = on ? "Make the code panel smaller" : "Make the code panel bigger"
    setTimeout(() => cm?.refresh(), 0)
  }
  $("code-tree-toggle").onclick = () => applyTreeHidden(!$("code-tree").hidden)
  $("code-tree-refresh").onclick = () => loadTree(true)
  function setChangesOnly(on) {
    changesOnly = !!on
    $("code-changes").setAttribute("aria-pressed", changesOnly ? "true" : "false")
    $("code-changes").classList.toggle("on", changesOnly)
    renderTree()
  }
  $("code-changes").onclick = () => setChangesOnly(!changesOnly)
  $("code-tree-filter").addEventListener("input", () => renderTree())
  $("btn-code-files")?.addEventListener("click", () => {
    if (panel.hidden) { show(); applyTreeHidden(false); return }
    if ($("code-tree").hidden) applyTreeHidden(false)
    else hide()
  })
  applyTreeHidden(store.get(TREE_HIDDEN_KEY) === "1")

  // Back to the app (files may have changed outside): refresh the list.
  window.addEventListener("focus", () => { if (!panel.hidden) loadTree(true) })

  window.vibeCodePanel = {
    open, show, hide, save,
    files: () => { show(); applyTreeHidden(false); setChangesOnly(false) },
    changes: async () => {
      show(); applyTreeHidden(false); setChangesOnly(true)
      const t = await loadTree(true)
      // Nothing open yet: show the first changed file right away.
      const first = Object.keys(t?.status || {}).sort().find((p) => t.status[p] !== "D")
      if (!active && first) open(first)
    },
    refresh: () => loadTree(true), isOpen: () => !panel.hidden }
})()
