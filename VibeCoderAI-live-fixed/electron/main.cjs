"use strict"
/**
 * VibeCoder AI - Electron entry (dev mode).
 * Loads renderer/index.html and wires window.vibe to the vibe-core SDK
 * (in-process engine) + the `vibe serve` HTTP/SSE API started in backend.cjs.
 */
const path = require("path")
const { app, BrowserWindow, Menu, clipboard, shell } = require("electron")
const { initBackend, shutdownBackend } = require("./backend.cjs")
const updater = require("./updater.cjs")

/* The native menu bar (File/Edit/View/Window) is not wanted - the app has its own
   UI. Copy/paste keeps working through the right-click menu and Ctrl+C/Ctrl+V
   (editable fields handle those in Chromium itself; plain chat selections get a
   Ctrl+C handler in the renderer). */
Menu.setApplicationMenu(null)

/** Right-click: Cut/Copy/Paste inside the composer, Copy for chat selections, Open link for links. */
function attachContextMenu(win) {
  win.webContents.on("context-menu", (_e, params) => {
    const items = []
    if (params.linkURL) {
      items.push({ label: "Open link in browser", click: () => shell.openExternal(params.linkURL) })
      items.push({ label: "Copy link address", click: () => clipboard.writeText(params.linkURL) })
    }
    if (params.mediaType === "image" && params.srcURL) {
      items.push({ label: "Copy image address", click: () => clipboard.writeText(params.srcURL) })
    }
    if (params.isEditable) {
      if (items.length) items.push({ type: "separator" })
      items.push(
        { label: "Cut", role: "cut" },
        { label: "Copy", role: "copy" },
        { label: "Paste", role: "paste" },
        { label: "Select all", role: "selectAll" },
      )
    } else if (params.selectionText && params.selectionText.trim()) {
      if (items.length) items.push({ type: "separator" })
      items.push({ label: "Copy", click: () => clipboard.writeText(params.selectionText) })
      items.push({ label: "Select all", click: () => win.webContents.selectAll() })
    }
    if (!items.length) return
    Menu.buildFromTemplate(items).popup({ window: win })
  })
}

function appIcon() {
  // packaged: extraResources copies build/icon.ico into <resources>/; dev: repo build/
  const cands = [path.join(process.resourcesPath || "", "build", "icon.ico"), path.join(__dirname, "..", "build", "icon.ico")]
  return cands.find((x) => x && require("fs").existsSync(x))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "VibeCoder AI",
    icon: appIcon(),
    backgroundColor: "#0b0d12",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // the built-in browser dock uses <webview>
    },
  })
  win.setMenuBarVisibility(false)
  win.once("ready-to-show", () => win.show())
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"))
  attachContextMenu(win)

  // Markdown links open target=_blank: never spawn an Electron window for them -
  // hand them to the real browser. Same for anything that tries to navigate away
  // from the app page (a prompt-injected <a> must not load remote content here).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file:")) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
    }
  })

  // dev mode: open the devtools (F12 toggles them anytime)
  if (process.argv.includes("--dev") || process.env.VIBE_DEV === "1") win.webContents.openDevTools({ mode: "detach" })

  // backend needs the window to push engine events
  initBackend(win)

  // Production-only desktop auto-updater: broadcast updater state to the renderer
  // over a secure IPC channel (the renderer never touches electron-updater).
  const offUpdater = updater.onChange((type, payload) => {
    try {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send("vibe:app-update-event", { type, payload })
      }
    } catch {}
  })
  win.on("closed", () => { try { offUpdater() } catch {} })
  return win
}

/* ---------- production guards ---------- */
// One instance only: two apps (or app + `vibe serve`) share ~/.vibe/sessions and
// their in-memory stores would silently overwrite each other's writes.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0]
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  // A crash must say so in the log instead of vanishing (the renderer logs via IPC).
  const crashLog = (what) => (e) => {
    try {
      const file = require("path").join(require("../core/util").homeDir(), "app-error.log")
      require("fs").appendFileSync(file, `[${new Date().toISOString()}] main ${what}: ${e && e.stack ? e.stack : e}\n\n`)
    } catch {}
    console.error(`[vibe] uncaught ${what}:`, e)
  }
  process.on("uncaughtException", crashLog("uncaughtException"))
  process.on("unhandledRejection", crashLog("unhandledRejection"))
}

app.whenReady().then(() => {
  // Provide the updater with a live "is any agent work active?" check so it can
  // refuse to install a restart while a run is in flight. The engine is owned by
  // backend.cjs, so ask it for the live engine each time (never cache a copy).
  updater.setBusyProvider(() => {
    try {
      const backend = require("./backend.cjs")
      const engine = backend.engine
      if (engine && typeof engine.runs === "object" && engine.runs) return engine.runs.size > 0
    } catch {}
    return false
  })
  // Production-only: start the stable-channel auto-updater and one quiet check
  // on startup. Dev mode never checks (enabled() is false there).
  if (updater.enabled()) {
    updater.startPeriodicCheck()
    setTimeout(() => updater.checkForUpdates({ silent: true }).catch(() => {}), 4000)
  }

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  shutdownBackend()
  if (process.platform !== "darwin") app.quit()
})
