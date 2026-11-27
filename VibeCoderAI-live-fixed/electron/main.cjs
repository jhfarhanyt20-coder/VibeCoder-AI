"use strict"
/**
 * BDCoder AI - Electron entry (dev mode).
 * Loads renderer/index.html and wires window.vibe to the vibe-core SDK
 * (in-process engine) + the `vibe serve` HTTP/SSE API started in backend.cjs.
 */
const path = require("path")
const { pathToFileURL } = require("node:url")
const { app, BrowserWindow, Menu, Tray, clipboard, shell, nativeImage, session, dialog } = require("electron")
// Keep settings, sign-in and chats in the same folder after the BDCoder rename.
if (typeof app.setPath === "function" && typeof app.getPath === "function") {
  app.setPath("userData", path.join(app.getPath("appData"), "vibe-core"))
}
const { initBackend, shutdownBackend } = require("./backend.cjs")
const updater = require("./updater.cjs")
const { setWindowTheme } = require("./window-theme.cjs")

const APP_ENTRY = pathToFileURL(path.join(__dirname, "..", "renderer", "index.html")).href
const WEBVIEW_URL = /^(https?|about|file|data):/i
/** true for a file: URL that names a host (Windows UNC / SMB) - never load it.
 *  file:///C:/... (empty host) is the app itself and stays allowed. */
function isUncFileUrl(url) {
  const raw = String(url || "")
  if (!/^file:/i.test(raw)) return false
  if (/^file:[\\/]{3}[\\/]/i.test(raw)) return true // file:////host/share
  try { return !!new URL(raw).hostname } catch { return true }
}

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

/* ---------- close to the tray ----------
   The window's close button hides BDCoder AI in the Windows tray (notification
   area) instead of quitting, so a stray click never ends the app or a running
   agent. Click the tray icon to bring the window back; right-click it and choose
   "Quit BDCoder AI" to exit for real. Installing an update and shutting
   Windows down still quit normally (both go through before-quit). */
let quitting = false
let tray = null
let trayHintShown = false
app.on("before-quit", () => { quitting = true })

function showMainWindow() {
  const w = BrowserWindow.getAllWindows()[0]
  if (!w) return createWindow()
  if (w.isMinimized()) w.restore()
  if (!w.isVisible()) w.show()
  w.focus()
  return w
}

function quitFromTray() {
  quitting = true
  app.quit()
}

function createTray() {
  if (tray) return tray
  try {
    const file = appIcon()
    let img = file ? nativeImage.createFromPath(file) : null
    if (!img || img.isEmpty()) return null
    if (process.platform === "win32") img = img.resize({ width: 16, height: 16 })
    tray = new Tray(img)
    tray.setToolTip("BDCoder AI")
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open BDCoder AI", click: showMainWindow },
      { type: "separator" },
      { label: "Quit BDCoder AI", click: quitFromTray },
    ]))
    tray.on("click", showMainWindow)
    tray.on("double-click", showMainWindow)
  } catch (e) {
    console.error("[vibe] tray unavailable:", e && e.message)
    tray = null
  }
  return tray
}

/** Close button: hide to the tray. Without a tray icon there is no way back, so quit as before. */
function closeToTray(win) {
  win.on("close", (e) => {
    if (quitting || !createTray()) return
    e.preventDefault()
    win.hide()
    if (!trayHintShown && process.platform === "win32") {
      trayHintShown = true
      // A quiet note like every other BDCoder notification: no Windows sound
      // (the app plays its own soft chime), and it slides away after a few seconds.
      try {
        const { Notification } = require("electron")
        if (Notification && typeof Notification.isSupported === "function" && Notification.isSupported()) {
          const n = new Notification({ title: "BDCoder AI is still running", body: "It keeps working in the tray. Right-click the tray icon and choose Quit to exit.", silent: true, timeoutType: "default" })
          n.on("click", () => { try { win.show(); win.focus() } catch {} })
          n.show()
          setTimeout(() => { try { n.close() } catch {} }, 2500)
          try { win.webContents.send("vibe:event", { type: "notification.chime", data: {} }) } catch {}
        } else {
          tray.displayBalloon({ title: "BDCoder AI is still running", content: "It is in the tray. Right-click the icon and choose Quit to exit.", iconType: "info" })
        }
      } catch {}
    }
  })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    title: "BDCoder AI",
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
  closeToTray(win)

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
        title: "BDCoder AI is already open",
        message: "BDCoder AI is already open",
        detail: app.isPackaged
          ? "Another BDCoder AI window is running (maybe the dev version started with npm run app). Both use the same chats, so only one can run at a time. Close the other one first, then open this again."
          : "The installed BDCoder AI app is running. The dev version (npm run app) uses the same chats, so only one can run at a time. Close the installed app first, then start the dev version again.",
        buttons: ["OK"],
      })
    } catch {}
    app.quit()
  })
} else {
  app.on("second-instance", () => {
    // the window may be hidden in the tray: bring it back
    if (app.isReady()) showMainWindow()
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

  // file://HOST/... is a UNC path on Windows: loading it (a model-written
  // <img src="//host/x.png"> on this file:// page resolves to file://host/...)
  // makes Windows try SMB and leak the user's NTLM hash. Cancel every file:
  // request that names a host; the app's own file:///C:/... loads stay allowed.
  const blockUncFileRequests = (ses) => {
    try {
      ses.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
        callback({ cancel: isUncFileUrl(details.url) })
      })
    } catch {}
  }
  blockUncFileRequests(session.defaultSession)
  try { blockUncFileRequests(session.fromPartition("persist:vibecoder-browser")) } catch {}

  createWindow()
  createTray()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on("window-all-closed", () => {
  shutdownBackend()
  if (process.platform !== "darwin") app.quit()
})
