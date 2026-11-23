"use strict"
/**
 * Browser tools - fixed with proper element ref system.
 * Uses injected element tracking instead of broken __vibeElementRefs.
 */

// Snapshots of large pages used to reach ~100k chars (~25k tokens). Keep one
// page snapshot to ~20k chars and tell the model how to read the rest.
const MAX_TEXT = 20_000
const MAX_EVAL = 20_000
const SNAPSHOT_HINT = "Snapshot clipped. Pass a lower depth (e.g. depth: 3 or 4) to see the page outline first, then read one part with browser.evaluate and document.querySelector(...)."

function clip(text, max = MAX_TEXT, hint = "") {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return text.slice(0, half) + `\n\n... [${text.length - max} chars truncated] ...\n\n` + text.slice(-half) + (hint ? `\n\n[${hint}]` : "")
}

function clipSnapshot(text) {
  return clip(String(text), MAX_TEXT, SNAPSHOT_HINT)
}

// Browser actions are approved per origin, not blanket per action. A rule saved
// for "click github.com" must not also allow clicks on a bank tab. The host is
// tracked PER TAB and refreshed from every result that reports a URL
// (navigate, tabs.open, tabs.list, browser.current, snapshot and the
// click/fill/press/scroll results). A tab whose host is unknown never borrows
// another tab's host: its approval is one-shot (neverPersist) and always asks
// (forceAsk), so no saved rule can approve it.
const tabHosts = new Map() // tabID -> host ("" when the page has none, e.g. about:blank)
const tabUrls = new Map() // tabID -> last known URL
let activeTabID = ""

function hostOf(url) {
  try { return new URL(String(url || "")).host || "" } catch { return "" }
}

function noteTab(tabID, url, { active = false } = {}) {
  const id = tabID == null ? "" : String(tabID)
  if (!id) return
  if (active) activeTabID = id
  if (url == null || url === "") return
  tabUrls.set(id, String(url))
  tabHosts.set(id, hostOf(url))
}

// Navigations and new tabs make that tab the active one.
function noteHost(tabID, url) {
  noteTab(tabID, url, { active: true })
}

function noteTabList(tabs) {
  if (!Array.isArray(tabs)) return
  const seen = new Set()
  for (const tab of tabs) {
    if (!tab || !tab.id) continue
    seen.add(String(tab.id))
    noteTab(tab.id, tab.url, { active: !!tab.active })
  }
  // Forget tabs that no longer exist so a reused ID cannot inherit a host.
  for (const id of [...tabHosts.keys()]) if (!seen.has(id)) { tabHosts.delete(id); tabUrls.delete(id); tabRefs.delete(id) }
  if (activeTabID && !seen.has(activeTabID)) activeTabID = ""
}

function forgetTab(tabID) {
  const id = String(tabID || "")
  tabHosts.delete(id)
  tabUrls.delete(id)
  tabRefs.delete(id)
  if (activeTabID === id) activeTabID = ""
}

function hostFor(args = {}) {
  const id = args && args.tabID ? String(args.tabID) : activeTabID
  return (id && tabHosts.get(id)) || ""
}

// ---- dangerous clicks and secret fields ----
// A saved "always allow click <host>" rule covers ordinary clicks only. A
// button whose name deletes, pays, transfers, sends, revokes … asks every time
// (critical, never saved), and fields for passwords, one-time codes or card
// numbers are never filled by the agent.
const { RISKY_WORDS } = require("../computer")
const tabRefs = new Map() // tabID -> Map(ref -> { role, name })
const SENSITIVE_FIELD = /\b(password|passwd|passphrase|passcode|pin( ?code)?|otp|one[- ]?time|verification code|verify code|security code|auth(entication)? code|2fa|mfa|totp|cvv2?|cvc2?|csc|card ?number|card ?no|cc-?(number|num|csc|cvc|exp\w*)|credit ?card|debit ?card|iban|routing( number)?|account ?number|ssn|social security)\b/i
const SENSITIVE_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)\b/i
const SENSITIVE_PAGE = /\b(pay|payment|payments|checkout|billing|bank|banking|wallet|transfer|purchase|order|delete|danger|security|password|account|settings)\b/i

/** Remember the names of the refs of a snapshot, per tab. */
function noteRefs(tabID, snapshot) {
  const id = String(tabID || activeTabID || "")
  if (!id || typeof snapshot !== "string") return
  const refs = new Map()
  for (const line of snapshot.split("\n")) {
    const m = /^\s*\[([^\]]*)\]\s?(.*?)\s@(e\d+)\s*$/.exec(line)
    if (!m) continue
    let name = m[2]
    const eq = name.indexOf(" = ")
    if (eq >= 0) name = name.slice(0, eq)
    refs.set(m[3], { role: m[1], name: name.trim() })
  }
  tabRefs.set(id, refs)
}

const describeScript = (ref) => `(() => {
  const el = document.querySelector('[data-vibe-ref=' + ${JSON.stringify(JSON.stringify(String(ref)))} + ']');
  if (!el) return null;
  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const labels = el.labels && el.labels.length ? Array.from(el.labels).map((l) => l.innerText).join(' ') : '';
  const by = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(' ');
  const tag = el.tagName.toLowerCase();
  const type = String(tag === 'input' ? el.type : (el.getAttribute('type') || '')).toLowerCase();
  const btnValue = tag === 'input' && /^(submit|button|reset|image)$/.test(type) ? (el.value || el.getAttribute('alt') || '') : '';
  const name = clean(el.getAttribute('aria-label') || by || btnValue || labels || el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 160);
  return { tag, type, name, label: clean(labels + ' ' + by).slice(0, 160), autocomplete: el.getAttribute('autocomplete') || '', id: el.id || '', fieldName: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '', title: el.getAttribute('title') || '' };
})()`

/**
 * What is this ref? Read from the page itself when the engine's browser is at
 * hand (or when this tab has no snapshot of ours, through the bridge), else
 * from the latest snapshot this tool saw.
 */
async function describeRef(api, a) {
  const id = String(a.tabID || activeTabID || "")
  const cached = (id && tabRefs.get(id) && tabRefs.get(id).get(String(a.ref))) || null
  let live = null
  try {
    const bm = api && typeof api._browserManager === "function" ? api._browserManager() : null
    if (bm && typeof bm.evaluate === "function") live = await bm.evaluate(a.tabID, describeScript(a.ref))
    else if (!(id && tabRefs.has(id)) && typeof api?.browserEvaluate === "function") {
      const res = await api.browserEvaluate({ tabID: a.tabID, script: describeScript(a.ref) })
      live = res && res.ok ? res.data && res.data.result : null
    }
  } catch {}
  const info = live && typeof live === "object" ? { ...live } : {}
  if (!info.name && cached) info.name = cached.name
  if (!info.role && cached) info.role = cached.role
  return info
}

const pageOf = (a) => { const id = String(a.tabID || activeTabID || ""); return (id && tabUrls.get(id)) || "" }

/** Why clicking this element needs a fresh OK, or "". */
function dangerousClick(info, a) {
  const name = String(info.name || "").trim()
  if (!name) return ""
  if (!RISKY_WORDS.test(name)) return ""
  // A bare "Submit" is the generic form button; it asks only on pages about
  // money, accounts or security.
  if (/^submit[.!]?$/i.test(name) && !SENSITIVE_PAGE.test(pageOf(a))) return ""
  return `click "${name.slice(0, 100)}"`
}

/** Why the agent must never fill this field, or "". */
function secretField(info, text) {
  if (String(info.type || "").toLowerCase() === "password") return "a password field"
  if (SENSITIVE_AUTOCOMPLETE.test(String(info.autocomplete || ""))) return "a password, one-time code or card field"
  const words = [info.name, info.label, info.id, info.fieldName, info.placeholder, info.title].filter(Boolean).join(" ").replace(/[_-]+/g, " ")
  if (SENSITIVE_FIELD.test(words) || SENSITIVE_FIELD.test(String(info.autocomplete || ""))) return "a password, one-time code or card field"
  if (/\b(\d[ -]?){13,19}\b/.test(String(text || ""))) return "what looks like a card or account number"
  return ""
}

async function confirmDangerous(c, a, reason) {
  const host = hostFor(a) || "this page"
  const ok = typeof c?.askPermission === "function" && await c.askPermission({ tool: "browser", subject: `Allow the agent to ${reason} on ${host}?`, forceAsk: true, neverPersist: true, critical: true })
  if (!ok) throw new Error(`The user did not allow this: ${reason} on ${host}. Nothing was clicked. Do not retry it; ask the user what to do.`)
}

function actionPerm(action, args = {}) {
  const host = hostFor(args)
  if (host) return { tool: "browser", subject: `${action} ${host}` }
  const which = args && args.tabID ? `tab ${args.tabID}` : "the active tab"
  return { tool: "browser", subject: `${action} (unknown host: ${which})`, neverPersist: true, forceAsk: true }
}

/**
 * Shared post-action report for click / fill / press / scroll. The bridge
 * returns { result } where result may carry tabID, url, title, urlBefore,
 * navigated and generation (electron/browser.js). Older bridges return less;
 * the report then stays as short as before.
 */
function actionReport(head, args, res, hostBefore) {
  const d = res && res.data && typeof res.data === "object" ? res.data : {}
  const r = d.result && typeof d.result === "object" ? d.result : {}
  const tabID = String(r.tabID || d.tabID || args.tabID || activeTabID || "")
  const url = r.url || d.url || ""
  const title = r.title != null ? r.title : d.title
  const prevUrl = r.urlBefore || (tabID ? tabUrls.get(tabID) : "") || ""
  if (tabID && url) noteTab(tabID, url, { active: true })
  const lines = [head]
  if (url) {
    lines.push(`Tab: ${tabID || "(active)"}`)
    lines.push(`Title: ${title || "(untitled)"}`)
    lines.push(`URL: ${url}`)
  }
  const generation = r.generation != null ? r.generation : d.generation
  if (generation != null) lines.push(`Snapshot generation: ${generation}`)
  const navigated = r.navigated === true || (!!url && !!prevUrl && url !== prevUrl)
  if (navigated) lines.push(`Page navigated to ${url}; element refs from the old snapshot are stale — take a new snapshot (browser.snapshot) before the next click or fill.`)
  const hostRan = hostOf(r.urlBefore || "")
  if (hostBefore && hostRan && hostBefore !== hostRan) lines.push(`Note: the approval was for ${hostBefore}, but the tab was on ${hostRan} when the action ran.`)
  return lines.join("\n")
}

function formatEvalResult(value) {
  if (value === undefined) return "(script returned undefined)"
  if (value === null) return "(script returned null)"
  let text
  if (typeof value === "string") text = value === "" ? "(script returned an empty string)" : value
  else {
    try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
    if (text === undefined) text = String(value)
  }
  if (text.length <= MAX_EVAL) return text
  return text.slice(0, MAX_EVAL) + `\n\n... [${text.length - MAX_EVAL} chars truncated] ...\n[Output clipped at ${MAX_EVAL} chars. Narrow the script: select one element (document.querySelector(...)), return only the fields you need, or slice long text (e.g. .slice(0, 2000)).]`
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
          if (page.tabID) noteTab(page.tabID, page.url, { active: true })
          if (page.tabID && typeof page.snapshot === "string") noteRefs(page.tabID, page.snapshot)
          return `Active browser page\nTab: ${page.tabID || "(unknown)"}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url || "(unknown)"}\n\n${clipSnapshot(page.snapshot || "No DOM snapshot available.")}`
        }
        const res = await engine?.browserListTabs?.()
        if (!res?.ok) throw new Error(res?.error || "No browser available")
        const tabs = res.data?.tabs || []
        noteTabList(tabs)
        const page = tabs.find((tab) => tab.active) || tabs[0]
        if (!page) throw new Error("No in-app browser tab is open. Open a page in the Browser panel first.")
        noteTab(page.id, page.url, { active: true })
        const snap = await engine.browserSnapshot?.({ tabID: page.id, depth: a.depth || 8 })
        if (!snap?.ok) throw new Error(snap?.error || "Could not read the current page")
        if (typeof snap.data?.snapshot === "string") noteRefs(page.id, snap.data.snapshot)
        return `Active browser page\nTab: ${page.id}\nTitle: ${page.title || "(untitled)"}\nURL: ${page.url || "(unknown)"}\n\n${clipSnapshot(snap.data?.snapshot || "No DOM snapshot available.")}`
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
        noteTabList(tabs)
        return tabs.length ? tabs.map(t => `- ${t.id}${t.active ? " [ACTIVE]" : ""}: ${t.title || "Untitled"} (${t.url})`).join("\n") : "No tabs open"
      },
    },
    openTab: {
      name: "browser.tabs.open",
      description: "Open a new tab in the visible in-app browser dock at the URL. The user can watch the agent control this page.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: [] },
      perm: (a = {}) => {
        let host = ""
        try { host = new URL(String(a.url || "")).host } catch {}
        const perm = { tool: "browser", subject: host ? `navigate ${host}` : "navigate" }
        if (!host) perm.neverPersist = true
        return perm
      },
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserCreateTab?.({ url: a.url || "about:blank" })
        if (!res?.ok) return `Failed: ${res?.error || "No browser available. Browser tools only work inside the Electron app (npm run app)."}`
        noteHost(res.data.tabID, res.data.url || a.url)
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
        forgetTab(a.tabID)
        return `Closed ${a.tabID}`
      },
    },
    navigate: {
      name: "browser.navigate",
      description: "Navigate the selected visible in-app browser tab to a URL. Reports the final URL after redirects.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, url: { type: "string" } }, required: ["url"] },
      perm: (a = {}) => {
        let host = ""
        try { host = new URL(String(a.url || "")).host } catch {}
        const perm = { tool: "browser", subject: host ? `navigate ${host}` : "navigate" }
        if (!host) perm.neverPersist = true
        return perm
      },
      paths: () => [],
      async run(a, c) {
        const api = c.engine || c.vibe
        const res = await api?.browserNavigate?.({ tabID: a.tabID, url: a.url })
        if (!res?.ok) throw new Error(res?.error || "Failed to navigate")
        // V-09: wait for the body instead of guessing with a sleep. The old 1 s
        // pause stays as a fallback only when readiness cannot be confirmed.
        const canWait = typeof api?.browserWait === "function"
        const waited = canWait ? await api.browserWait({ tabID: a.tabID, selector: "body", timeoutMs: 5000 }) : null
        const notes = []
        let tabID = res.data?.tabID || waited?.data?.tabID || a.tabID || ""
        let finalUrl = (waited?.ok && waited.data?.url) || res.data?.url || ""
        let title = (waited?.ok && waited.data?.title) || res.data?.title || ""
        if (canWait && !waited?.ok) {
          notes.push(`Timed out waiting for the page body (${waited?.error || "no response"}); the page may still be loading. Use browser.wait or browser.snapshot to check.`)
          await new Promise((r) => setTimeout(r, 1000))
          if (!finalUrl && typeof api?.browserListTabs === "function") {
            try {
              const listed = await api.browserListTabs()
              const tabs = listed?.ok ? (listed.data?.tabs || []) : []
              const tab = (tabID && tabs.find((t) => String(t.id) === String(tabID))) || tabs.find((t) => t.active)
              if (tab) { tabID = tab.id; finalUrl = tab.url || ""; title = tab.title || "" }
            } catch {}
          }
        }
        // Learn the host from the FINAL URL (after redirects) when it is known.
        noteHost(tabID || activeTabID, finalUrl || a.url)
        const lines = [`Navigated the ${a.tabID ? `tab ${a.tabID}` : "active browser tab"} to ${a.url}`]
        if (finalUrl) {
          lines.push(`Final URL: ${finalUrl}`)
          if (title) lines.push(`Title: ${title}`)
          if (finalUrl !== a.url) lines.push(`Note: the final URL differs from the requested ${a.url} (redirected or normalized).`)
        }
        lines.push(...notes)
        return lines.join("\n")
      },
    },
    wait: {
      name: "browser.wait",
      description:
        "Wait until a CSS selector or visible text appears in the visible in-app browser tab (poll every 150 ms, max 30 s). Use it after navigating or clicking when content loads asynchronously instead of guessing with sleeps.",
      parameters: {
        type: "object",
        properties: {
          tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." },
          selector: { type: "string", description: "CSS selector that must exist, e.g. '#results'." },
          text: { type: "string", description: "Visible text that must appear on the page." },
          networkIdle: { type: "boolean", description: "Also wait for the next page load to finish." },
          timeoutMs: { type: "integer", description: "Maximum wait in milliseconds (default 10000, max 30000)." },
        },
        required: [],
      },
      perm: () => ({ tool: "browser", subject: "wait" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserWait?.({
          tabID: a.tabID,
          selector: a.selector,
          text: a.text,
          networkIdle: a.networkIdle,
          timeoutMs: a.timeoutMs,
        })
        if (!res?.ok) throw new Error(res?.error || "Failed to wait")
        const d = res.data || {}
        if (d.url) noteTab(d.tabID || a.tabID || activeTabID, d.url, { active: true })
        const what = [d.selector ? `selector ${d.selector}` : "", d.text ? `text ${JSON.stringify(d.text)}` : "", d.networkIdle ? "network idle" : ""].filter(Boolean).join(" / ")
        return `Wait completed in ${d.elapsedMs} ms${what ? ` (${what})` : ""}${d.url ? `\nURL: ${d.url}` : ""}`
      },
    },
    snapshot: {
      name: "browser.snapshot",
      description: "Get an accessibility/DOM snapshot of the visible in-app browser tab with element refs. Use before clicking or filling. The snapshot returns a Generation number: pass the SAME generation back to browser.click / browser.fill so a stale ref is detected. Large pages are clipped at ~20k chars; pass a lower depth to see the outline.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, depth: { type: "integer" } }, required: [] },
      perm: () => ({ tool: "browser", subject: "snapshot" }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserSnapshot?.({ tabID: a.tabID, depth: a.depth || 8 })
        if (!res?.ok) throw new Error(res?.error || "Failed to snapshot")
        if (res.data?.url) noteTab(res.data.tabID || a.tabID || activeTabID, res.data.url)
        if (typeof res.data?.snapshot === "string") noteRefs(res.data.tabID || a.tabID || activeTabID, res.data.snapshot)
        const gen = res.data.generation != null ? `\nGeneration: ${res.data.generation} (${res.data.refCount || 0} elements)` : ""
        return `Page: ${res.data.title || "(untitled)"}\nURL: ${res.data.url || "(unknown)"}${gen}\n\n${clipSnapshot(res.data.snapshot || "Empty")}`
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
        if (url && (res.data?.tabID || a.tabID)) noteTab(tabID, url)
        return {
          __vibeStructuredToolResult: "browser-screenshot",
          text: `Captured a screenshot of ${title || "the current browser page"} (${url || tabID || "active tab"}). The screenshot is attached below; use the image to inspect visual layout and use browser.current for readable page content.`,
          screenshot: { mime, data, url, title, tabID },
        }
      },
    },
    evaluate: {
      name: "browser.evaluate",
      description: "Execute JavaScript in the selected visible in-app browser tab. Use only for the requested browser task. Output is clipped at ~20k chars; return only what you need.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, script: { type: "string" } }, required: ["script"] },
      perm: () => ({ tool: "browser", subject: "evaluate", neverPersist: true }),
      paths: () => [],
      async run(a, c) {
        const res = await (c.engine || c.vibe)?.browserEvaluate?.({ tabID: a.tabID, script: a.script })
        if (!res?.ok) throw new Error(res?.error || "Failed to evaluate")
        return formatEvalResult(res.data?.result)
      },
    },
    click: {
      name: "browser.click",
      description: "Click an element in the visible in-app browser using a ref from the latest snapshot. Pass the snapshot's Generation to catch stale refs. Reports the page URL/title after the click.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, ref: { type: "string" }, generation: { type: "integer", description: "The Generation from the latest browser.snapshot; omit to allow any." } }, required: ["ref"] },
      perm: (a = {}) => actionPerm("click", a),
      paths: () => [],
      async run(a, c) {
        const hostBefore = hostFor(a)
        const api = c.engine || c.vibe
        const danger = dangerousClick(await describeRef(api, a), a)
        if (danger) await confirmDangerous(c, a, danger)
        const res = await api?.browserClick?.({ tabID: a.tabID, ref: a.ref, generation: a.generation })
        if (!res?.ok) throw new Error(res?.error || "Failed to click")
        return actionReport(`Clicked ${a.ref}`, a, res, hostBefore)
      },
    },
    fill: {
      name: "browser.fill",
      description: "Fill an input in the visible in-app browser using a ref from the latest snapshot. Pass the snapshot's Generation to catch stale refs.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, ref: { type: "string" }, text: { type: "string" }, generation: { type: "integer", description: "The Generation from the latest browser.snapshot; omit to allow any." } }, required: ["ref", "text"] },
      perm: (a = {}) => actionPerm("fill", a),
      paths: () => [],
      async run(a, c) {
        const hostBefore = hostFor(a)
        const api = c.engine || c.vibe
        const secret = secretField(await describeRef(api, a), a.text)
        if (secret) throw new Error(`Refused: ${a.ref} is ${secret === "what looks like a card or account number" ? "being filled with " + secret : secret}. The agent never fills passwords, one-time codes or card numbers. Nothing was filled. Ask the user to type it themselves in the browser.`)
        const res = await api?.browserFill?.({ tabID: a.tabID, ref: a.ref, text: a.text, generation: a.generation })
        if (!res?.ok) throw new Error(res?.error || "Failed to fill")
        return actionReport(`Filled ${a.ref}`, a, res, hostBefore)
      },
    },
    press: {
      name: "browser.press",
      description: "Press a keyboard key in the selected visible in-app browser tab. Reports the page URL/title after the key press.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, key: { type: "string" } }, required: ["key"] },
      perm: (a = {}) => actionPerm("press", a),
      paths: () => [],
      async run(a, c) {
        const hostBefore = hostFor(a)
        const res = await (c.engine || c.vibe)?.browserPress?.({ tabID: a.tabID, key: a.key })
        if (!res?.ok) throw new Error(res?.error || "Failed to press")
        return actionReport(`Pressed ${a.key}`, a, res, hostBefore)
      },
    },
    scroll: {
      name: "browser.scroll",
      description: "Scroll the selected visible in-app browser tab.",
      parameters: { type: "object", properties: { tabID: { type: "string", description: "Optional; defaults to the active visible browser tab." }, deltaY: { type: "integer" } }, required: ["deltaY"] },
      perm: (a = {}) => actionPerm("scroll", a),
      paths: () => [],
      async run(a, c) {
        const hostBefore = hostFor(a)
        const res = await (c.engine || c.vibe)?.browserScroll?.({ tabID: a.tabID, deltaY: a.deltaY })
        if (!res?.ok) throw new Error(res?.error || "Failed to scroll")
        const y = res.data?.result?.scrollY
        return actionReport(Number.isFinite(y) ? `Scrolled (scrollY ${y})` : "Scrolled", a, res, hostBefore)
      },
    },
  }
}

/** Test helper: clear the per-tab host map between test cases. */
function _resetBrowserToolState() {
  tabHosts.clear()
  tabUrls.clear()
  tabRefs.clear()
  activeTabID = ""
}

module.exports = { createBrowserTools, _resetBrowserToolState }
