/* ---------- splash screen (logo + pulse) ---------- */
const splash = $("splash")
if (splash) {
  // keep it visible for a short moment so the user sees the animation
  setTimeout(() => {
    splash.classList.add("hidden")
    setTimeout(() => { splash.hidden = true }, 350)
  }, 800)
}

/* ---------- built-in browser (right dock, one browser for everything) ----------
   OpenCode-style tabs inside the app: links from the chat, URLs the agent prints
   and anything the user types land here, never in an outside window. Tabs and
   the open state survive a restart. */
const BR_KEY = "vibecoder.browser"
const brPanel = $("browser-panel")
const brBody = $("browser-body")
const brTabsEl = $("br-tabs")
const brUrl = $("br-url")
const brProgress = $("br-progress")
const brEmpty = $("browser-empty")
const brTabs = new Map() // id -> { id, view, url, title, loading }
let brActive = ""
let brRestored = false

function readBrowserPrefs() {
  try {
    return JSON.parse(localStorage.getItem(BR_KEY) || "{}") || {}
  } catch {
    return {}
  }
}

function saveBrowserPrefs(patch) {
  try {
    localStorage.setItem(BR_KEY, JSON.stringify({ ...readBrowserPrefs(), ...patch }))
  } catch {}
}

/** "localhost:3000" -> http://localhost:3000, "example.com" -> https://..., text -> search. */
function browserUrl(text) {
  const s = String(text || "").trim()
  if (!s) return ""
  if (/^(https?|file|data|about):/i.test(s)) return s
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$|\?)/i.test(s)) return "http://" + s
  if (/^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+(:\d+)?(\/|$)/.test(s)) return "http://" + s
  if (/^[\w-]+(\.[\w-]+)+((:\d+)?(\/|$|\?))/.test(s)) return "https://" + s
  return "https://duckduckgo.com/?q=" + encodeURIComponent(s)
}

/** Width limits of the dock: the sidebar (260px) and ~420px of chat always stay visible. */
function brWidthBounds() {
  const min = 300
  const max = Math.max(min, window.innerWidth - 260 - 420)
  return { min, max }
}

function brSetWidth(px) {
  if (!brPanel) return 0
  const { min, max } = brWidthBounds()
  const w = Math.round(Math.min(max, Math.max(min, Number(px) || 0)))
  brPanel.style.width = w + "px"
  return w
}

function brRestoreWidth() {
  const w = Number(readBrowserPrefs().width)
  if (Number.isFinite(w) && w > 0) brSetWidth(w)
}

function brSaveState() {
  saveBrowserPrefs({
    open: !!brPanel && !brPanel.hidden,
    activeId: brActive,
    tabs: [...brTabs.values()].map((t) => ({ id: t.id, url: t.url || "", title: t.title || "" })),
  })
}

function brRenderTabs() {
  if (!brTabsEl) return
  brTabsEl.innerHTML = ""
  for (const tab of brTabs.values()) {
    const el = document.createElement("div")
    el.className = "browser-tab" + (tab.id === brActive ? " active" : "")
    el.title = tab.url || tab.title || "New tab"
    const name = document.createElement("span")
    name.className = "br-tab-title"
    name.textContent = tab.title || tab.url || "New tab"
    const x = document.createElement("button")
    x.className = "br-tab-x"
    x.type = "button"
    x.title = "Close tab"
    x.textContent = "✕"
    x.addEventListener("click", (e) => {
      e.stopPropagation()
      brCloseTab(tab.id)
    })
    el.append(name, x)
    el.addEventListener("click", () => brActivate(tab.id))
    el.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return
      e.preventDefault()
      brCloseTab(tab.id)
    })
    brTabsEl.append(el)
  }
}

function brUpdateChrome() {
  const tab = brTabs.get(brActive)
  if (brUrl) brUrl.value = tab && tab.url && tab.url !== "about:blank" ? tab.url : ""
  if (brProgress) brProgress.hidden = !(tab && tab.loading)
  if (brEmpty) brEmpty.hidden = brTabs.size > 0
  const reload = $("br-reload")
  if (reload) reload.title = tab && tab.loading ? "Stop loading" : "Reload"
}

function brActivate(id) {
  if (!brTabs.has(id)) return
  brActive = id
  for (const t of brTabs.values()) {
    if (t.view) t.view.classList.toggle("active", t.id === id)
  }
  brRenderTabs()
  brUpdateChrome()
  brSaveState()
  const tab = brTabs.get(id)
  try {
    tab.view.focus()
  } catch {}
}

function brBindTab(tab) {
  const view = tab.view
  const isActive = () => brActive === tab.id
  const setUrl = (url) => {
    if (!url || url === "about:blank") return
    tab.url = url
    if (isActive() && brUrl) brUrl.value = url
    brSaveState()
  }
  view.addEventListener("did-start-loading", () => {
    tab.loading = true
    if (isActive()) brUpdateChrome()
  })
  view.addEventListener("did-stop-loading", () => {
    tab.loading = false
    try {
      const u = view.getURL()
      if (u && u !== "about:blank") tab.url = u
    } catch {}
    if (!tab.title && tab.url) tab.title = ""
    if (isActive()) brUpdateChrome()
    brRenderTabs()
    brSaveState()
  })
  view.addEventListener("did-navigate", (e) => setUrl(e && e.url))
  view.addEventListener("did-navigate-in-page", (e) => setUrl(e && e.url))
  view.addEventListener("page-title-updated", (e) => {
    tab.title = String((e && e.title) || "").slice(0, 120)
    brRenderTabs()
    brSaveState()
  })
  view.addEventListener("did-fail-load", (e) => {
    tab.loading = false
    if (isActive()) brUpdateChrome()
    if (!e || e.errorCode === -3) return // -3 = the user stopped the load
    if (e.isMainFrame === false) return
    showError(
      "The page could not be loaded",
      `${e.errorDescription || "error"} (${e.errorCode})\n${e.validatedURL || tab.url || ""}`,
      { key: "br-" + tab.id },
    )
  })
}

function brCreateTab(url, opts = {}) {
  const id = opts.id || "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  if (brTabs.has(id)) return brTabs.get(id)
  const view = document.createElement("webview")
  view.className = "browser-view"
  view.setAttribute("partition", "persist:vibecoder-browser")
  const initial = url && url !== "about:blank" ? url : ""
  const tab = { id, view, url: initial, title: "", loading: false }
  brTabs.set(id, tab)
  brBindTab(tab)
  if (brBody) brBody.append(view)
  try {
    view.setAttribute("src", url && url !== "about:blank" ? url : "about:blank")
  } catch {}
  if (opts.activate !== false) brActivate(id)
  else {
    brRenderTabs()
    brUpdateChrome()
  }
  return tab
}

/** Wait until Electron has attached a webview guest so the main process can control the same visible page. */
async function brGetContentsId(view, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const id = Number(view && view.getWebContentsId && view.getWebContentsId())
      if (Number.isInteger(id) && id > 0) return id
    } catch (e) { lastError = e }
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error("The in-app browser page did not attach to Electron in time" + (lastError ? `: ${lastError.message}` : ""))
}

function brRestoreTabs() {
  if (brRestored) return
  brRestored = true
  const prefs = readBrowserPrefs()
  let list = Array.isArray(prefs.tabs) ? prefs.tabs : []
  // Older state kept a single address.
  if (!list.length && prefs.url) list = [{ id: "t-restored", url: prefs.url, title: "" }]
  for (const t of list) {
    if (!t || !t.id) continue
    const url = /^(https?:\/\/|about:blank$)/i.test(String(t.url || "")) ? String(t.url) : "about:blank"
    const tab = brCreateTab(url, { id: String(t.id), activate: false })
    if (tab && t.title) tab.title = String(t.title)
  }
  const wanted = prefs.activeId && brTabs.has(prefs.activeId) ? prefs.activeId : [...brTabs.keys()][0] || ""
  if (wanted) brActivate(wanted)
  brRenderTabs()
  brUpdateChrome()
}

function brCloseTab(id) {
  const tab = brTabs.get(id)
  if (!tab) return
  const ids = [...brTabs.keys()]
  const idx = ids.indexOf(id)
  try {
    tab.view.remove()
  } catch {}
  brTabs.delete(id)
  if (brActive === id) {
    const next = ids[idx + 1] || ids[idx - 1] || ""
    brActive = brTabs.has(next) ? next : ""
    if (brActive) {
      brActivate(brActive)
      return
    }
  }
  brRenderTabs()
  brUpdateChrome()
  brSaveState()
}

function brNewTab(url) {
  if (brPanel) brPanel.hidden = false
  brRestoreTabs()
  brCreateTab(url || "about:blank")
  if (brUrl) {
    setTimeout(() => {
      try {
        brUrl.focus()
        brUrl.select()
      } catch {}
    }, 50)
  }
}

function brGo(text) {
  const target = browserUrl(text)
  if (!target) return
  const tab = brTabs.get(brActive)
  if (!tab) {
    brCreateTab(target)
    return
  }
  tab.url = target
  if (brEmpty) brEmpty.hidden = true
  brUpdateChrome()
  brSaveState()
  try {
    tab.view.loadURL(target)
  } catch (e) {
    showError("The page could not be opened", String(e && e.message ? e.message : e), { key: "br-" + tab.id })
  }
}

/** Opens the browser with a page (a new tab unless it is still empty). */
function openBrowser(url, opts = {}) {
  if (!brPanel) return
  const wasHidden = brPanel.hidden
  brPanel.hidden = false
  brRestoreWidth()
  brRestoreTabs()
  if (url) {
    const target = browserUrl(url)
    if (target) {
      const active = brTabs.get(brActive)
      if (opts.newTab || wasHidden || !active || active.url) brCreateTab(target)
      else {
        brActivate(active.id)
        brGo(target)
      }
    }
  } else if (!brTabs.size) {
    brCreateTab("about:blank")
  } else {
    brUpdateChrome()
  }
  brSaveState()
  if (opts.focus !== false) {
    setTimeout(() => {
      try {
        brUrl.focus()
        brUrl.select()
      } catch {}
    }, 50)
  }
}

function closeBrowser() {
  if (!brPanel) return
  brPanel.hidden = true
  brSaveState()
}

function toggleBrowser(url) {
  if (!brPanel) return
  if (!brPanel.hidden && !url) closeBrowser()
  else openBrowser(url)
}

// The sidebar icon opens the side panel list (browser, files, changes); Ctrl+Shift+B still opens the browser.
$("chip-browser")?.addEventListener("click", () => (window.vibeSidePanel ? window.vibeSidePanel.toggle() : toggleBrowser()))
$("br-close")?.addEventListener("click", closeBrowser)
$("br-new")?.addEventListener("click", () => brNewTab())
$("br-reload")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.loading) tab.view.stop()
    else tab.view.reload()
  } catch {}
})
$("br-back")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.view.canGoBack()) tab.view.goBack()
  } catch {}
})
$("br-fwd")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  if (!tab) return
  try {
    if (tab.view.canGoForward()) tab.view.goForward()
  } catch {}
})
$("br-external")?.addEventListener("click", () => {
  const tab = brTabs.get(brActive)
  const url = (tab && tab.url) || brUrl?.value || ""
  if (url && vibe.openExternal) vibe.openExternal({ url })
})
brUrl?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return
  e.preventDefault()
  brGo(brUrl.value)
})
document.querySelectorAll(".browser-quick [data-url]").forEach((btn) => {
  btn.addEventListener("click", () => brNewTab(btn.dataset.url))
})
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey
  if (!mod || !e.shiftKey) return
  const key = String(e.key).toLowerCase()
  if (key === "b") {
    e.preventDefault()
    toggleBrowser()
  } else if (key === "t" && brPanel && !brPanel.hidden) {
    e.preventDefault()
    brNewTab()
  }
})

/* Drag the left edge of the browser to resize it (width is remembered). */
const brResize = $("br-resize")
const brShield = $("br-shield")
if (brResize && brShield && brPanel) {
  brResize.addEventListener("pointerdown", (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = brPanel.getBoundingClientRect().width
    let width = startW
    brResize.classList.add("dragging")
    brPanel.classList.add("resizing")
    brShield.hidden = false
    document.body.style.userSelect = "none"
    const move = (ev) => {
      const { min, max } = brWidthBounds()
      width = Math.min(max, Math.max(min, startW - (ev.clientX - startX)))
      brPanel.style.width = Math.round(width) + "px"
    }
    const up = () => {
      brShield.hidden = true
      brResize.classList.remove("dragging")
      brPanel.classList.remove("resizing")
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      saveBrowserPrefs({ width: Math.round(width) })
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  })
  brResize.addEventListener("dblclick", () => {
    brPanel.style.width = ""
    saveBrowserPrefs({ width: 0 })
  })
}
window.addEventListener("resize", () => {
  if (!brPanel || brPanel.hidden || !brPanel.style.width) return
  brSetWidth(brPanel.getBoundingClientRect().width)
})

/* ---------- startup ---------- */
loadModelLabel()
loadAuthInfo()
loadWorkspaces()
restoreActiveProject()
refreshAuthUI()
refreshCliStatus()
// The browser panel is the app's one browser: reopen the tabs of the last run.
if (readBrowserPrefs().open) setTimeout(() => openBrowser(undefined, { focus: false }), 0)
// The provider states (on / off) are needed by the model picker.
if (vibe.providerList) loadProviders({ silent: true })
// The popular-provider presets are static: fill their list once.
renderProviderPresets()
// The task list of the last run (the agent continues with it).
loadTodos()
// The agent's memory file: needed so it can save facts without asking.
if (vibe.memoryPath) {
  Promise.resolve(vibe.memoryPath())
    .then((res) => {
      state.memoryFile = res?.data || ""
      // the memory permissions are part of the session rule set -> re-apply
      // them once the path is known (the first session may exist already)
      if (state.memoryFile) applyPermissionMode()
    })
    .catch(() => {})
}
// The CLI auth probe can be slow/fail on a cold start — retry once so the
// sidebar account name always appears for a logged-in user.
setTimeout(() => {
  refreshAuthUI()
  loadAuthInfo()
}, 3000)

// Test hook for the offline UI tests (must be at the end: every state it
// touches has to be declared by now).
window.__testProviderState = providerState

/* Compaction UI is handled by the canonical session.compaction.* event listener above. */

/* ---------- agent control for the visible in-app browser dock ---------- */
if (vibe && typeof vibe.onBrowserCommand === "function") {
  vibe.onBrowserCommand((command) => {
    const requestId = String(command && command.requestId || "")
    const action = String(command && command.action || "")
    const args = command && command.args && typeof command.args === "object" ? command.args : {}
    Promise.resolve().then(async () => {
      if (!brPanel || !brBody) throw new Error("The in-app browser dock is not available")
      if (["createTab", "activateTab", "navigate"].includes(action)) brPanel.hidden = false
      brRestoreTabs()

      if (action === "listTabs") {
        const rows = []
        for (const tab of brTabs.values()) {
          let contentsId = 0
          try { contentsId = await brGetContentsId(tab.view) } catch {}
          try {
            const actual = tab.view.getURL()
            if (actual) tab.url = actual
          } catch {}
          rows.push({ id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, generation: Number(tab.generation) || 0, contentsId })
        }
        return rows
      }

      if (action === "createTab") {
        const id = String(args.id || "")
        if (!id) throw new Error("A tab ID is required")
        if (brTabs.has(id)) throw new Error(`Browser tab ${id} already exists`)
        const tab = brCreateTab(String(args.url || "about:blank"), { id, activate: true })
        const contentsId = await brGetContentsId(tab.view)
        return { id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, contentsId }
      }

      if (action === "closeTab") {
        const id = String(args.tabID || "")
        if (!brTabs.has(id)) throw new Error(`Browser tab ${id || "(missing)"} not found`)
        brCloseTab(id)
        return { closed: true, tabID: id }
      }

      if (action === "activateTab") {
        const id = String(args.tabID || "")
        if (!brTabs.has(id)) throw new Error(`Browser tab ${id || "(missing)"} not found`)
        brPanel.hidden = false
        brActivate(id)
        const tab = brTabs.get(id)
        const contentsId = await brGetContentsId(tab.view)
        return { id: tab.id, url: tab.url || "about:blank", title: tab.title || "", active: tab.id === brActive, contentsId }
      }

      throw new Error(`Unsupported browser bridge action: ${action}`)
    }).then(
      (data) => vibe.browserCommandResult({ requestId, ok: true, data }),
      (error) => vibe.browserCommandResult({ requestId, ok: false, error: String(error && error.message || error) }),
    ).catch(() => {})
  })
}
