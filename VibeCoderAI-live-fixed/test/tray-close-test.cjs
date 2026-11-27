"use strict"
/**
 * Close button hides the app in the tray; the tray menu quits for real.
 * Loads electron/main.cjs against a fake electron module (no window opens).
 */
const assert = require("assert")
const path = require("path")
const Module = require("module")
const { EventEmitter } = require("events")

const appEvents = new EventEmitter()
let readyCb = null
const windows = []
let quitCalls = 0
let trays = []

class FakeWin extends EventEmitter {
  constructor() { super(); this.visible = false; this.destroyed = false; this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, openDevTools() {}, send() {}, isDestroyed: () => false, session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } }); windows.push(this) }
  setMenuBarVisibility() {} loadFile() {} isMaximized() { return true } maximize() {}
  show() { this.visible = true } hide() { this.visible = false } isVisible() { return this.visible }
  isMinimized() { return false } restore() {} focus() {} isDestroyed() { return this.destroyed }
  close() { const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; this.emit("close", e); if (!e.defaultPrevented) { this.destroyed = true; windows.splice(windows.indexOf(this), 1) } }
}
class FakeTray extends EventEmitter {
  constructor(img) { super(); this.img = img; trays.push(this) }
  setToolTip(t) { this.tip = t } setContextMenu(m) { this.menu = m } displayBalloon(b) { this.balloon = b }
}
const img = { isEmpty: () => false, resize() { return img } }
const electron = {
  app: Object.assign(appEvents, {
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (cb) => { readyCb = cb } }),
    isReady: () => true, isPackaged: false,
    quit: () => { quitCalls++; appEvents.emit("before-quit") },
  }),
  BrowserWindow: Object.assign(FakeWin, { getAllWindows: () => windows.slice() }),
  Menu: { setApplicationMenu() {}, buildFromTemplate: (items) => ({ items }) },
  Tray: FakeTray,
  clipboard: {}, shell: { openExternal: async () => {} }, dialog: {},
  nativeImage: { createFromDataURL: () => img, createFromPath: () => img },
  session: { fromPartition: () => ({ setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }) },
}
const stubs = {
  electron,
  [path.join(__dirname, "..", "electron", "backend.cjs")]: { initBackend() {}, shutdownBackend() {} },
  [path.join(__dirname, "..", "electron", "updater.cjs")]: { onChange: () => () => {}, setBusyProvider() {}, enabled: () => false },
  [path.join(__dirname, "..", "electron", "window-theme.cjs")]: { setWindowTheme() {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === "electron") return stubs.electron
  try {
    const full = Module._resolveFilename(request, parent, isMain)
    if (stubs[full]) return stubs[full]
  } catch {}
  return origLoad.apply(this, arguments)
}
require("../electron/main.cjs")
Module._load = origLoad

assert.ok(readyCb, "app waits for ready")
readyCb()
assert.strictEqual(windows.length, 1, "one window")
assert.strictEqual(trays.length, 1, "tray icon created")
const win = windows[0]
win.show()
const tray = trays[0]
assert.strictEqual(tray.tip, "BDCoder AI")
const labels = tray.menu.items.map((i) => i.label).filter(Boolean)
assert.deepStrictEqual(labels, ["Open BDCoder AI", "Quit BDCoder AI"], "tray menu: open + quit")

// 1) close button hides instead of quitting
win.close()
assert.strictEqual(windows.length, 1, "window still exists after close")
assert.strictEqual(win.isVisible(), false, "window hidden in the tray")
assert.strictEqual(quitCalls, 0, "app did not quit")
assert.ok(tray.balloon && /tray/i.test(tray.balloon.content), "one-time hint says it is in the tray")

// 2) clicking the tray brings it back
tray.emit("click")
assert.strictEqual(win.isVisible(), true, "tray click shows the window")
win.close()
tray.menu.items.find((i) => i.label === "Open BDCoder AI").click()
assert.strictEqual(win.isVisible(), true, "Open item shows the window")

// 3) second launch brings the hidden window back
win.close()
appEvents.emit("second-instance")
assert.strictEqual(win.isVisible(), true, "second launch shows the hidden window")

// 4) Quit from the tray really closes
tray.menu.items.find((i) => i.label === "Quit BDCoder AI").click()
assert.strictEqual(quitCalls, 1, "app.quit called")
win.close()
assert.strictEqual(windows.length, 0, "window closes for real after Quit")

console.log("tray-close-test: ok")
