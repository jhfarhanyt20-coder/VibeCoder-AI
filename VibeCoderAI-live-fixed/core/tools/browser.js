"use strict"
/**
 * Browser tools - fixed with proper element ref system.
 * Uses injected element tracking instead of broken __vibeElementRefs.
 */

const MAX_TEXT = 100_000

function clip(text, max = MAX_TEXT) {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return text.slice(0, half) + `\n\n... [${text.length - max} chars truncated] ...\n\n` + text.slice(-half)
}

function createBrowserTools() {
  return {
    current: {
      name: "browser.current",
      description: "Inspect the CURRENT active page in the visible in-app browser. Returns current URL, page title, and an accessibility/DOM snapshot. Use this first when the user asks what is on screen; use browser.screenshot to capture and display the actual page image.",
      parameters: { type: "object", properties: { depth: { type: "integer", minimum: 1, maximum: 16 } }, required: [] },
      perm: () => ({ tool: "browser", subject: "snapshot" }),
      paths: () => [],
      async run(a, c) {
        const engine = c.engine || c.vibe
        if (typeof engine?.browserCurrent === "function") {
          const res = await engine.browserCurrent({ depth: a.depth || 8 })
          if (!res?.ok) throw new Error(res?.error || "Could not inspect the current browser page")
          const page = res.data || {}
          return `Active browser page\nTab: ${page.tabID || "(unknown)"}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url || "(unknown)"}\n\n${clip(String(page.snapshot || "No DOM snapshot available."))}`
        }
        const res = await engine?.browserListTabs?.()
        if (!res?.ok) throw new Error(res?.error || "No browser available")
        const tabs = res.data?.tabs || []
        const page = tabs.find((tab) => tab.active) || tabs[0]
        if (!page) throw new Error("No in-app browser tab is open. Open a page in the Browser panel first.")
        const snap = await engine.browserSnapshot?.({ tabID: page.id, depth: a.depth || 8 })
        if (!snap?.ok) throw new Error(snap?.error || "Could not read the current page")
        return `Active browser page\nTab: ${page.id}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url || "(unknown)"}\n\n${clip(String(snap.data?.snapshot || "No DOM snapshot available."))}`
      },
    },
    listTabs: {
      name: "browser.tabs.list",
      description: "List tabs in the visible in-app browser dock. These are the same tabs the user can see. Returns tab IDs for other operations.",
      parameters: { type: "object", properties: {} },
      perm: () => ({ tool: "browser", subject: "list" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserListTabs?.()
        if (!res?.ok) return `Failed: ${res?.error || "No browser available. Browser tools only work inside the Electron app (npm run app)."}`
        const tabs = res.data?.tabs || []
        return tabs.length ? tabs.map(t => `- ${t.id}${t.active ? " [ACTIVE]" : ""}: ${t.title || "Untitled"} (${t.url})`).join("\n") : "No tabs open"
      },
    },
    openTab: {
      name: "browser.tabs.open",
      description: "Open a new tab in the visible in-app browser dock at the URL. The user can watch the agent control this page.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: [] },
      perm: () => ({ tool: "browser", subject: "navigate" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserCreateTab?.({ url: a.url || "about:blank" })
        if (!res?.ok) return `Failed: ${res?.error || "No browser available. Browser tools only work inside the Electron app (npm run app)."}`
        return `Opened active browser tab: ${res.data.tabID}\nTitle: ${res.data.title || "(loading)"}\nURL: ${res.data.url || a.url || "about:blank"}`
      },
    },
    closeTab: {
      name: "browser.tabs.close",
      description: "Close a tab in the visible in-app browser dock.",
      parameters: { type: "object", properties: { tabID: { type: "string" } }, required: ["tabID"] },
      perm: () => ({ tool: "browser", subject: "close" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserCloseTab?.({ tabID: a.tabID })
        if (!res?.ok) throw new Error(res?.error || "Failed to close tab")
        return `Closed ${a.tabID}`
      },
    },
    navigate: {
      name: "browser.navigate",
      description: "Navigate the selected visible in-app browser tab to a URL.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, url: { type: "string" } }, required: ["url"] },
      perm: () => ({ tool: "browser", subject: "navigate" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserNavigate?.({ tabID: a.tabID, url: a.url })
        if (!res?.ok) throw new Error(res?.error || "Failed to navigate")
        await new Promise(r => setTimeout(r, 1000))
        return `Navigated the ${a.tabID ? `tab ${a.tabID}` : "active browser tab"} to ${a.url}`
      },
    },
    snapshot: {
      name: "browser.snapshot",
      description: "Get an accessibility/DOM snapshot of the visible in-app browser tab with element refs. Use before clicking or filling.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, depth: { type: "integer" } }, required: [] },
      perm: () => ({ tool: "browser", subject: "snapshot" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserSnapshot?.({ tabID: a.tabID, depth: a.depth || 8 })
        if (!res?.ok) throw new Error(res?.error || "Failed to snapshot")
        return `Page: ${res.data.title || "(untitled)"}\nURL: ${res.data.url || "(unknown)"}\n\n${clip(res.data.snapshot || "Empty")}`
      },
    },
    screenshot: {
      name: "browser.screenshot",
      description: "Capture a screenshot of the visible in-app browser tab.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, fullPage: { type: "boolean" } }, required: [] },
      perm: () => ({ tool: "browser", subject: "screenshot" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserScreenshot?.({ tabID: a.tabID, fullPage: a.fullPage })
        if (!res?.ok) throw new Error(res?.error || "Failed to screenshot")
        const data = String(res.data?.data || "")
        if (!data) throw new Error("The browser screenshot returned no image data")
        const mime = String(res.data?.mime || "image/png")
        const url = String(res.data?.url || "")
        const title = String(res.data?.title || "")
        const tabID = String(res.data?.tabID || a.tabID || "")
        return {
          __vibeStructuredToolResult: "browser-screenshot",
          text: `Captured a screenshot of ${title || "the current browser page"} (${url || tabID || "active tab"}). The screenshot is attached below; use the image to inspect visual layout and use browser.current for readable page content.`,
          screenshot: { mime, data, url, title, tabID },
        }
      },
    },
    evaluate: {
      name: "browser.evaluate",
      description: "Execute JavaScript in the selected visible in-app browser tab. Use only for the requested browser task.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, script: { type: "string" } }, required: ["script"] },
      perm: () => ({ tool: "browser", subject: "evaluate", neverPersist: true }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserEvaluate?.({ tabID: a.tabID, script: a.script })
        if (!res?.ok) throw new Error(res?.error || "Failed to evaluate")
        return JSON.stringify(res.data.result, null, 2)
      },
    },
    click: {
      name: "browser.click",
      description: "Click an element in the visible in-app browser using a ref from the latest snapshot.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, ref: { type: "string" } }, required: ["ref"] },
      perm: () => ({ tool: "browser", subject: "click" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserClick?.({ tabID: a.tabID, ref: a.ref })
        if (!res?.ok) throw new Error(res?.error || "Failed to click")
        return `Clicked ${a.ref}`
      },
    },
    fill: {
      name: "browser.fill",
      description: "Fill an input in the visible in-app browser using a ref from the latest snapshot.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] },
      perm: () => ({ tool: "browser", subject: "fill" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserFill?.({ tabID: a.tabID, ref: a.ref, text: a.text })
        if (!res?.ok) throw new Error(res?.error || "Failed to fill")
        return `Filled ${a.ref}`
      },
    },
    press: {
      name: "browser.press",
      description: "Press a keyboard key in the selected visible in-app browser tab.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, key: { type: "string" } }, required: ["key"] },
      perm: () => ({ tool: "browser", subject: "press" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserPress?.({ tabID: a.tabID, key: a.key })
        if (!res?.ok) throw new Error(res?.error || "Failed to press")
        return `Pressed ${a.key}`
      },
    },
    scroll: {
      name: "browser.scroll",
      description: "Scroll the selected visible in-app browser tab.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, deltaY: { type: "integer" } }, required: ["deltaY"] },
      perm: () => ({ tool: "browser", subject: "scroll" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserScroll?.({ tabID: a.tabID, deltaY: a.deltaY })
        if (!res?.ok) throw new Error(res?.error || "Failed to scroll")
        return "Scrolled"
      },
    },
  }
}

module.exports = { createBrowserTools }
