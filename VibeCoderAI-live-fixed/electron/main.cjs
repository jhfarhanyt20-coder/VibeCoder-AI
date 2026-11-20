"use strict"
/**
 * VibeCoder AI - Electron entry (dev mode).
 * Loads renderer/index.html and wires window.vibe to the vibe-core SDK
 * (in-process engine) + the `vibe serve` HTTP/SSE API started in backend.cjs.
 */
const path = require("path")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow, Menu, clipboard, shell, nativeImage, session, dialog } = require("electron")
const { initBackend, shutdownBackend } = require("./backend.cjs")
const updater = require("./updater.cjs")
const { setWindowTheme } = require("./window-theme.cjs")

const APP_ENTRY = pathToFileURL(path.join(__dirname, "..", "renderer", "index.html")).href
const WEBVIEW_URL = /^(https?|about|file|data):/i

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
      if (/^https?:\/\//i.test(params.linkURL)) {
        items.push({ label: "Open link in browser", click: () => shell.openExternal(params.linkURL) })
      }
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

function transparentTitleBarIcon() {
  // A non-empty transparent image prevents Windows from falling back to the
  // executable/Electron icon in the native title bar. Keeping the native frame
  // preserves minimize/maximize/close, snapping and every existing theme.
  return nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVDhPYxgFo2AUjAIwYGAAAAQQAAGnRHxjAAAAAElFTkSuQmCC",
  )
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "VibeCoder AI",
    // Keep the packaged/taskbar application identity, but do not paint the
    // tiny icon in the Windows native title bar. Other platforms keep the
    // normal app icon.
    icon: process.platform === "win32" ? transparentTitleBarIcon() : appIcon(),
    backgroundColor: "#0b0d12",
    // Frameless window: the renderer paints the title strip and its
    // minimize/maximize/close buttons in the app's current theme colour.
    frame: false,
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
  // The renderer sends the active app theme after its CSS loads; this first
  // pass avoids a bright Windows-accent title bar while the window starts.
  setWindowTheme(win, { caption: "#0b0d12", text: "#d7dbe2", border: "#26292f", dark: true })
  // Launch fitted to the current display's work area. Maximizing (rather than a
  // fixed pixel size) keeps the app correct for every display scale and size.
  win.once("ready-to-show", () => {
    if (!win.isMaximized()) win.maximize()
    win.show()
  })
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"))
  attachContextMenu(win)

  // Markdown links open target=_blank: never spawn an Electron window for them -
  // hand them to the real browser. Same for anything that tries to navigate away
  // from the app page (a prompt-injected <a> must not load remote content here).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: "deny" }
  })
  const guardAppNavigation = (e, url) => {
    if (url === APP_ENTRY || url.startsWith(APP_ENTRY + "#")) return
    e.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {})
  }
  win.webContents.on("will-navigate", guardAppNavigation)
  win.webContents.on("will-redirect", guardAppNavigation)
  // The browser dock is the only webview in the app. Never let a guest inherit
  // a preload or Node privileges, and keep its permission requests denied.
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload
    delete params.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    const src = String(params.src || "")
    if (src && !WEBVIEW_URL.test(src)) event.preventDefault()
  })
  try {
    const dock = session.fromPartition("persist:vibecoder-browser")
    dock.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    dock.setPermissionCheckHandler(() => false)
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    win.webContents.session.setPermissionCheckHandler(() => false)
  } catch {}

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
// The installed app and the dev app (npm run app) share this lock on purpose.
// The one started second used to vanish silently while the other window jumped
// to the front, which looked like "the other app keeps opening". It now says why.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.whenReady().then(() => {
    try {
      dialog.showMessageBoxSync({
        type: "info",
        title: "VibeCoder AI is already open",
        message: "VibeCoder AI is already open",
        detail: app.isPackaged
          ? "Another VibeCoder AI window is running (maybe the dev version started with npm run app). Both use the same chats, so only one can run at a time. Close the other one first, then open this again."
          : "The installed VibeCoder AI app is running. The dev version (npm run app) uses the same chats, so only one can run at a time. Close the installed app first, then start the dev version again.",
        buttons: ["OK"],
      })
    } catch {}
    app.quit()
  })
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
  if (!gotLock) return // the copy started second only shows its notice and quits
  // Guest pages in the browser dock are isolated: no popups and no navigation
  // outside normal web/about/file/data URLs.
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") return
    contents.setWindowOpenHandler(() => ({ action: "deny" }))
    const guard = (event, url) => { if (!WEBVIEW_URL.test(url)) event.preventDefault() }
    contents.on("will-navigate", guard)
    contents.on("will-redirect", guard)
  })
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
