"use strict"
/**
 * Browser bridge for the app's visible in-app <webview> dock.
 *
 * The old implementation created hidden BrowserWindows, so browser.* tools
 * operated on pages the user could not see. This manager now asks the trusted
 * renderer to manage its actual dock tabs, then controls those guest webContents
 * directly from the Electron main process.
 */
const electron = require("electron")
const { BrowserWindow } = electron
const getDefaultWebContents = (id) => {
  try { return electron.webContents && electron.webContents.fromId(Number(id)) } catch { return null }
}

const NO_BROWSER = "No browser available: the in-app browser only works inside the Electron app."
const ALLOWED_RESULT_CHANNEL = "vibe:browser-command-result"

class BrowserManager {
  constructor(options = {}) {
    this.tabs = new Map()
    this.activeTabID = null
    this.nextId = 1
    this.pending = new Map()
    this.commandTimeoutMs = Number(options.commandTimeoutMs) || 15000
    this.getHostWindow = options.getHostWindow || (() => {
      try {
        if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== "function") return null
        const windows = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed())
        return windows.find((w) => {
          try { return /renderer[\\/]index\.html/i.test(decodeURIComponent(new URL(w.webContents.getURL()).pathname)) } catch { return false }
        }) || windows[0] || null
      } catch { return null }
    })
    this.getWebContents = options.getWebContents || getDefaultWebContents
  }

  _request(action, args = {}) {
    const win = this.getHostWindow()
    if (!win || win.isDestroyed?.() || !win.webContents || win.webContents.isDestroyed?.()) {
      return Promise.reject(new Error(NO_BROWSER))
    }
    const requestId = `br_${Date.now().toString(36)}_${this.nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`In-app browser command timed out: ${action}`))
      }, this.commandTimeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, action })
      try {
        win.webContents.send("vibe:browser-command", { requestId, action, args })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error(`Could not send browser command: ${error?.message || error}`))
      }
    })
  }

  /** Called only by the trusted app renderer through the result IPC handler. */
  resolveCommand(payload = {}) {
    const requestId = String(payload.requestId || "")
    const entry = this.pending.get(requestId)
    if (!entry) return { ok: false, error: "Unknown or expired browser command" }
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    if (payload.ok === false) entry.reject(new Error(String(payload.error || `Browser command failed: ${entry.action}`)))
    else entry.resolve(payload.data)
    return { ok: true }
  }

  async listTabs() {
    const rows = await this._request("listTabs")
    const list = Array.isArray(rows) ? rows : []
    const next = new Map()
    for (const row of list) {
      if (!row || !row.id) continue
      const contentsId = Number(row.contentsId) || 0
      const contents = contentsId ? this.getWebContents(contentsId) : null
      let url = String(row.url || "about:blank")
      let title = String(row.title || "")
      try { if (contents && !contents.isDestroyed?.()) url = contents.getURL() || url } catch {}
      try { if (contents && !contents.isDestroyed?.()) title = contents.getTitle() || title } catch {}
      next.set(String(row.id), {
        id: String(row.id),
        url,
        title,
        active: !!row.active,
        generation: Number(row.generation) || 0,
        contentsId,
        refs: this.tabs.get(String(row.id))?.refs || new Map(),
      })
    }
    // Older renderer bundles may not advertise `active`; preserve the previous
    // active selection when possible, otherwise choose the first visible tab.
    if (next.size && ![...next.values()].some((tab) => tab.active)) {
      const previous = [...next.values()].find((tab) => tab.id === this.activeTabID)
      const chosen = previous || next.values().next().value
      if (chosen) chosen.active = true
    }
    this.tabs = next
    this.activeTabID = [...next.values()].find((tab) => tab.active)?.id || null
    return [...next.values()].map(({ id, url, title, active, generation }) => ({ id, url, title, active, generation }))
  }

  async currentTab() {
    const tabs = await this.listTabs()
    const active = tabs.find((tab) => tab.active) || tabs[0]
    if (!active) throw new Error("No in-app browser tab is open. Open a page in the Browser panel first.")
    return active
  }

  async createTab(options = {}) {
    const id = `agent_${Date.now().toString(36)}_${this.nextId++}`
    const row = await this._request("createTab", { id, url: String(options.url || "about:blank") })
    if (!row || !row.id || !Number(row.contentsId)) throw new Error("In-app browser tab was created but its page is not attached yet")
    const tab = { id: String(row.id), url: String(row.url || options.url || "about:blank"), title: String(row.title || ""), active: row.active !== false, generation: 0, contentsId: Number(row.contentsId), refs: new Map() }
    this.tabs.set(tab.id, tab)
    if (tab.active) this.activeTabID = tab.id
    return tab
  }

  async closeTab(tabID) {
    await this._request("closeTab", { tabID: String(tabID) })
    this.tabs.delete(String(tabID))
    if (this.activeTabID === String(tabID)) this.activeTabID = null
    return true
  }

  async _getTab(tabID, { activate = true } = {}) {
    let id = String(tabID || "").trim()
    let tab = id ? this.tabs.get(id) : null
    let wc = tab && tab.contentsId ? this.getWebContents(tab.contentsId) : null

    if (!id || !tab || !wc || wc.isDestroyed?.()) {
      const tabs = await this.listTabs()
      if (!id) {
        const selected = tabs.find((item) => item.active) || tabs[0]
        id = selected?.id || ""
      }
      tab = this.tabs.get(id)
      wc = tab && tab.contentsId ? this.getWebContents(tab.contentsId) : null
    }

    if (!tab || !wc || wc.isDestroyed?.()) {
      throw new Error(`Browser tab ${id || "(no active tab)"} not found. Open a page in the Browser panel or call browser.tabs.list.`)
    }
    if (activate) {
      await this._request("activateTab", { tabID: id })
      this.activeTabID = id
      for (const item of this.tabs.values()) item.active = item.id === id
    }
    return { tab, contents: wc }
  }

  async navigate(tabID, url) {
    const target = String(url || "").trim()
    if (!target) throw new Error("A URL is required")
    if (/^javascript:/i.test(target)) throw new Error("javascript: URLs are not allowed")
    const { tab, contents } = await this._getTab(tabID)
    await contents.loadURL(target)
    tab.url = target
    tab.refs.clear()
    return true
  }

  async captureScreenshot(tabID, options = {}) {
    const { tab, contents } = await this._getTab(tabID)
    // Capture the actual visible webContents, shrink very large desktops to keep
    // history/provider requests bounded, and prefer JPEG to avoid huge base64 PNGs.
    const captured = await contents.capturePage()
    const size = captured?.getSize?.() || { width: 0, height: 0 }
    const image = size.width > 1440 && typeof captured.resize === "function"
      ? captured.resize({ width: 1440 })
      : captured
    const buffer = typeof image.toJPEG === "function" ? image.toJPEG(76) : image.toPNG()
    if (!buffer || !buffer.length) throw new Error("The browser returned an empty screenshot.")
    if (buffer.length > 3 * 1024 * 1024) throw new Error("The screenshot is larger than 3 MB even after compression. Reduce the page size and retry.")
    let url = tab.url || "about:blank"
    let title = tab.title || ""
    try { url = contents.getURL() || url } catch {}
    try { title = contents.getTitle() || title } catch {}
    tab.url = url
    tab.title = title
    return { buffer, tabID: tab.id, url, title, mime: typeof image.toJPEG === "function" ? "image/jpeg" : "image/png" }
  }

  async screenshot(tabID, options = {}) {
    const shot = await this.captureScreenshot(tabID, options)
    return shot.buffer
  }

  async evaluate(tabID, script) {
    if (typeof script !== "string" || !script.trim()) throw new Error("JavaScript expression is required")
    const { contents } = await this._getTab(tabID)
    return contents.executeJavaScript(script)
  }

  /**
   * V-09: wait until a condition holds in the tab instead of a fixed sleep.
   * Polls every 150 ms for a CSS selector or a visible text substring, and
   * optionally waits for the next did-finish-load (network idle). Page JS is
   * bounded by the same deadline, so a stuck page cannot hang the run.
   */
  async wait(tabID, options = {}) {
    const { contents } = await this._getTab(tabID)
    const selector = options.selector ? String(options.selector) : ""
    const text = options.text ? String(options.text) : ""
    const networkIdle = !!options.networkIdle
    const timeoutMs = Math.max(50, Math.min(30000, Number(options.timeoutMs) || 10000))
    const started = Date.now()
    const deadline = started + timeoutMs
    const probe = selector || text
      ? `(() => {
          const sel = ${JSON.stringify(selector)};
          const wanted = ${JSON.stringify(text)};
          if (sel) { const el = document.querySelector(sel); if (el) return true; }
          if (wanted) { const body = document.body ? document.body.innerText : ''; if (String(body).includes(wanted)) return true; }
          return false;
        })()`
      : ""

    let idleDone = !networkIdle
    let onIdle = null
    if (networkIdle) {
      onIdle = () => { idleDone = true }
      try {
        contents.once("did-finish-load", onIdle)
        if (typeof contents.isLoading === "function" && !contents.isLoading()) idleDone = true
        else if (typeof contents.isLoading !== "function") idleDone = true
      } catch {
        idleDone = true
      }
    }

    const withTimeout = (promise, ms) => {
      const p = Promise.resolve(promise)
      p.catch(() => {})
      let timer
      const guard = new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, ms)) })
      return Promise.race([p, guard]).finally(() => clearTimeout(timer))
    }

    try {
      while (true) {
        const remaining = deadline - Date.now()
        if (probe && remaining > 0) {
          // race the page probe against the remaining budget
          const found = await withTimeout(contents.executeJavaScript(probe), remaining)
          if (found && idleDone) {
            return { elapsedMs: Date.now() - started, selector, text, networkIdle }
          }
        } else if (!probe && idleDone) {
          return { elapsedMs: Date.now() - started, selector, text, networkIdle }
        }
        if (Date.now() >= deadline) {
          const what =
            [selector && `selector ${selector}`, text && `text ${JSON.stringify(text)}`, networkIdle && "network idle"]
              .filter(Boolean)
              .join(" / ") || "condition"
          throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(150, Math.max(1, deadline - Date.now()))))
      }
    } finally {
      if (onIdle) {
        try { contents.removeListener("did-finish-load", onIdle) } catch {}
      }
    }
  }

  async snapshot(tabID, options = {}) {
    const { tab, contents } = await this._getTab(tabID)
    const depth = Math.max(1, Math.min(16, Number(options.depth) || 8))
    // V-03: each snapshot is a new generation. The model must pass back the
    // generation it saw; a stale ref is rejected before we ever touch the page.
    tab.generation = (tab.generation || 0) + 1
    const nodes = await contents.executeJavaScript(`(() => {
      const nodes = [];
      const selectors = 'a,button,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[tabindex],[contenteditable="true"]';
      for (const el of document.querySelectorAll('[data-vibe-ref]')) el.removeAttribute('data-vibe-ref');
      window.__vibeNextRef = 1;
      for (const el of document.querySelectorAll(selectors)) {
        if (!(el instanceof HTMLElement)) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || el.hidden || el.getAttribute('aria-hidden') === 'true') continue;
        const ref = 'e' + (window.__vibeNextRef++);
        el.setAttribute('data-vibe-ref', ref);
      }
      const seen = new Set();
      function walk(node, level) {
        if (!node || level > ${depth} || seen.has(node) || !(node instanceof Element)) return;
        seen.add(node);
        const tag = node.tagName.toLowerCase();
        const ref = node.getAttribute('data-vibe-ref') || '';
        const role = node.getAttribute('role') || tag;
        const rawName = node.getAttribute('aria-label') || node.getAttribute('alt') || node.innerText || node.textContent || '';
        const name = String(rawName).replace(/\\s+/g, ' ').trim().slice(0, 140);
        const value = ('value' in node ? node.value : node.getAttribute('value')) || '';
        if (level === 0 || ref || name || ['main','nav','form','header','footer'].includes(tag)) {
          nodes.push({ level, role, name, value: String(value).slice(0, 120), ref, tag });
        }
        for (const child of node.children || []) walk(child, level + 1);
      }
      walk(document.body, 0);
      return nodes.slice(0, 2500);
    })()`)
    const refs = new Map()
    for (const node of Array.isArray(nodes) ? nodes : []) if (node.ref) refs.set(node.ref, node)
    tab.refs = refs
    const lines = (Array.isArray(nodes) ? nodes : []).map((node) => `${"  ".repeat(node.level)}[${node.role}] ${node.name || node.tag}${node.value ? ` = ${node.value}` : ""}${node.ref ? ` @${node.ref}` : ""}`)
    return lines.join("\n")
  }

  async click(tabID, ref, generation) {
    const { tab, contents } = await this._getTab(tabID)
    const curGen = tab.generation || 0
    if (!tab.refs.has(String(ref))) throw new Error(`Element ref ${ref} not found. Call browser.snapshot first.`)
    const gen = Number.isFinite(Number(generation)) ? Number(generation) : curGen
    if (gen !== curGen) {
      throw new Error(`Element ref ${ref} is from an older snapshot (generation ${gen}, current ${curGen}). Call browser.snapshot again.`)
    }
    const safeRef = JSON.stringify(String(ref))
    return contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-vibe-ref=' + ${safeRef} + ']');
      if (!el || !el.isConnected) throw new Error('Element ref is stale; take a new snapshot');
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: ${safeRef}, tag: el.tagName.toLowerCase(), generation: ${curGen} };
    })()`)
  }

  async fill(tabID, ref, text, generation) {
    const { tab, contents } = await this._getTab(tabID)
    const curGen = tab.generation || 0
    if (!tab.refs.has(String(ref))) throw new Error(`Element ref ${ref} not found. Call browser.snapshot first.`)
    const gen = Number.isFinite(Number(generation)) ? Number(generation) : curGen
    if (gen !== curGen) {
      throw new Error(`Element ref ${ref} is from an older snapshot (generation ${gen}, current ${curGen}). Call browser.snapshot again.`)
    }
    const safeRef = JSON.stringify(String(ref))
    const safeText = JSON.stringify(String(text ?? ""))
    return contents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-vibe-ref=' + ${safeRef} + ']');
      if (!el || !el.isConnected) throw new Error('Element ref is stale; take a new snapshot');
      if (el.matches('input,textarea,select')) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${safeText}); else el.value = ${safeText};
      } else if (el.isContentEditable) {
        el.textContent = ${safeText};
      } else {
        throw new Error('Target is not an editable element');
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${safeText} }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: ${safeRef} };
    })()`)
  }

  async press(tabID, key) {
    const { contents } = await this._getTab(tabID)
    const normalized = String(key || "").trim()
    if (!normalized || normalized.length > 32) throw new Error("A valid key is required")
    const keys = { Enter: "ENTER", Escape: "ESC", Esc: "ESC", Tab: "TAB", Space: "SPACE", Backspace: "BACKSPACE", Delete: "DELETE", ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT", Home: "HOME", End: "END", PageUp: "PAGEUP", PageDown: "PAGEDOWN" }
    const keyCode = keys[normalized] || normalized.toUpperCase()
    try {
      contents.sendInputEvent({ type: "keyDown", keyCode })
      contents.sendInputEvent({ type: "keyUp", keyCode })
      return { pressed: normalized }
    } catch {
      const safeKey = JSON.stringify(normalized)
      return contents.executeJavaScript(`(() => { const t = document.activeElement || document.body; for (const type of ['keydown','keypress','keyup']) t.dispatchEvent(new KeyboardEvent(type, {key:${safeKey}, bubbles:true, cancelable:true})); return {pressed:${safeKey}} })()`)
    }
  }

  async scroll(tabID, deltaY) {
    const { contents } = await this._getTab(tabID)
    const amount = Math.max(-10000, Math.min(10000, Math.trunc(Number(deltaY) || 0)))
    return contents.executeJavaScript(`(() => { window.scrollBy({ top: ${amount}, left: 0, behavior: 'auto' }); return { scrollY: window.scrollY }; })()`)
  }

  async activateTab(tabID) {
    return this._request("activateTab", { tabID: String(tabID) })
  }
}

module.exports = { BrowserManager, NO_BROWSER }
