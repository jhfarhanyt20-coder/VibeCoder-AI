"use strict"
/**
 * Connectors page: sign in to GitHub (device code), see the account, sign out.
 * The left-bar "Connectors" button opens this page; Marketplace lives inside it.
 */
;(function () {
  const $ = (id) => document.getElementById(id)
  const unwrap = (r) => (r && typeof r === "object" && "ok" in r ? (r.ok ? r.data : Promise.reject(new Error(r.error || "Failed"))) : r)
  const api = (name, arg) => Promise.resolve(window.vibe && typeof window.vibe[name] === "function" ? window.vibe[name](arg) : null).then(unwrap)

  // ---- Connectors hub: its own page next to the app sidebar, with tabs on top.
  // It reuses the existing pages (connectors, marketplace, plugins, mcp) so all
  // their buttons and data loading keep working.
  // One tab per page: Skills, MCP servers and Plugins each have their own.
  const TABS = [
    { id: "connectors", label: "Connectors" },
    { id: "marketplace", label: "Marketplace" },
    { id: "skills", label: "Skills" },
    { id: "mcp", label: "MCP servers" },
    { id: "plugins", label: "Plugins" },
  ]
  const HUB_PAGES = new Set(["connectors", "marketplace", "plugins", "mcp", "skills"])
  let hubPage = "connectors"

  function settingsEl() { return document.getElementById("settings") }
  function placeHub() {
    const s = settingsEl()
    if (!s || !s.classList.contains("hub")) return
    const side = document.getElementById("app-sidebar")
    const shell = document.querySelector(".shell")
    const hidden = !side || (shell && shell.classList.contains("sidebar-hidden"))
    s.style.left = hidden ? "0px" : Math.round(side.getBoundingClientRect().right) + "px"
  }
  function ensureHead() {
    let head = $("hub-head")
    if (head) return head
    head = document.createElement("div")
    head.id = "hub-head"
    head.className = "hub-head"
    head.innerHTML = '<button class="hub-back" id="hub-back" type="button" title="Back to the chat (Esc)"><span aria-hidden="true">←</span> Back</button><h1 class="hub-title" id="hub-title">Connectors</h1><div class="hub-tabs" id="hub-tabs" role="tablist"></div><div class="hub-subtabs" id="hub-subtabs" role="tablist"></div>'
    const content = $("settings-content")
    content.prepend(head)
    // The hub hides the settings menu (and its "Back to workspace"), so it has its own way out.
    $("hub-back").addEventListener("click", () => { closeHub(); const back = $("btn-back"); if (back) back.click() })
    return head
  }
  function renderTabs() {
    ensureHead()
    const top = TABS.find((t) => t.id === hubPage || (t.sub && t.sub.some((s) => s.id === hubPage))) || TABS[0]
    $("hub-title").textContent = top.label
    const tabs = $("hub-tabs")
    tabs.replaceChildren(...TABS.map((t) => {
      const b = document.createElement("button")
      b.type = "button"; b.className = "hub-tab" + (t === top ? " active" : ""); b.textContent = t.label
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(t === top))
      b.onclick = () => showHub(t.sub ? t.sub[0].id : t.id)
      return b
    }))
    const sub = $("hub-subtabs")
    sub.hidden = !top.sub
    sub.replaceChildren(...(top.sub || []).map((s) => {
      const b = document.createElement("button")
      b.type = "button"; b.className = "hub-subtab" + (s.id === hubPage ? " active" : ""); b.textContent = s.label
      b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(s.id === hubPage))
      b.onclick = () => showHub(s.id)
      return b
    }))
  }
  function showHub(page) {
    hubPage = HUB_PAGES.has(page) ? page : "connectors"
    const s = settingsEl()
    if (!s) return
    if (s.hidden) { const btn = $("btn-settings"); if (btn) btn.click() }
    s.classList.add("hub")
    const nav = document.querySelector(`.settings-nav .nav-item[data-page="${hubPage}"]`)
    if (nav) nav.click()
    renderTabs()
    placeHub()
    if (hubPage === "connectors") refresh()
  }
  function closeHub() { const s = settingsEl(); if (s) { s.classList.remove("hub"); s.style.left = "" } }
  function openPage(page) { showHub(page) }

  const CARDS = {
    github: { name: "GitHub", idle: "Repositories, issues, pull requests and code", allow: "press Authorize", deviceUrl: "https://github.com/login/device" },
    facebook: { name: "Facebook", idle: "Pages, posts, Messenger, Business and ads", allow: "allow VibeCoder", deviceUrl: "https://www.facebook.com" },
  }
  function renderCard(id, st) {
    const meta = CARDS[id]
    if (!st || !meta || !$(`cn-${id}`)) return
    const q = (part) => $(`cn-${id}-${part}`)
    // Not open to users yet: a calm "Coming soon" card, no sign-in.
    const soon = !!st.comingSoon && !st.connected
    $(`cn-${id}`).classList.toggle("soon", soon)
    if (soon) {
      q("badge").hidden = false
      q("badge").textContent = "Coming soon"
      q("badge").classList.add("muted")
      q("sub").textContent = meta.idle
      q("connect").hidden = false
      q("connect").disabled = true
      q("connect").classList.remove("primary")
      for (const part of ["cancel", "disconnect", "code", "error"]) q(part).hidden = true
      return
    }
    q("badge").textContent = "Connected"
    q("badge").classList.remove("muted")
    q("connect").disabled = false
    q("connect").classList.add("primary")
    const connected = !!st.connected
    const pending = !connected && st.pending
    q("badge").hidden = !connected
    q("sub").textContent = connected && st.account
      ? `Signed in as ${st.account.login || st.account.name}${st.account.name && st.account.name !== st.account.login ? ` (${st.account.name})` : ""}`
      : meta.idle
    q("connect").hidden = connected || !!pending
    q("cancel").hidden = !pending
    q("disconnect").hidden = !connected
    q("code").hidden = !pending
    if (pending) {
      const web = !st.pending.userCode
      q("code-value").textContent = st.pending.userCode || ""
      q("copy").hidden = web
      document.querySelector(`#cn-${id}-code .cn-code-label`).textContent = web
        ? `A browser tab opened. Sign in to ${meta.name} there and ${meta.allow} — that's all.`
        : `Enter this code on ${meta.name}, then ${meta.allow}:`
      q("open").textContent = web ? "Open the page again" : `Open ${meta.name}`
      q("open").dataset.url = st.pending.verificationUri
    }
    const err = q("error")
    err.hidden = !st.error || connected
    err.textContent = st.error || ""
    $(`cn-${id}`).classList.toggle("connected", connected)
  }
  const renderGitHub = (st) => renderCard("github", st)

  async function refresh() {
    try {
      const list = await api("connectorsList")
      for (const st of list || []) renderCard(st.id, st)
    } catch {}
  }

  function start() {
    if (!$("cn-github")) return
    const side = $("btn-connectors")
    if (side) side.addEventListener("click", () => showHub("connectors"))
    // Settings (gear) opens the normal settings view, never the hub.
    const gear = $("btn-settings")
    if (gear) gear.addEventListener("click", (e) => { if (e.isTrusted) closeHub() }, true)
    // Using the sidebar (new task, a chat, a workspace) leaves the hub.
    const sidebar = $("app-sidebar")
    if (sidebar) sidebar.addEventListener("click", (e) => {
      const s = settingsEl()
      if (!s || !s.classList.contains("hub") || s.hidden) return
      if (e.target.closest("#btn-connectors, .side-bottom")) return
      if (e.target.closest("button, li")) { closeHub(); const back = $("btn-back"); if (back) back.click() }
    })
    window.addEventListener("resize", placeHub)
    const shell = document.querySelector(".shell")
    if (shell) new MutationObserver(placeHub).observe(shell, { attributes: true, attributeFilter: ["class"] })
    const s = settingsEl()
    if (s) new MutationObserver(() => { if (s.hidden) closeHub() }).observe(s, { attributes: true, attributeFilter: ["hidden"] })
    // Other places that open the marketplace go to the hub too.
    const legacy = $("btn-marketplace")
    if (legacy) legacy.addEventListener("click", (e) => { e.stopImmediatePropagation(); showHub("marketplace") }, true)
    const nav = document.querySelector('.settings-nav .nav-item[data-page="connectors"]')
    if (nav) nav.addEventListener("click", refresh)
    $("cn-open-marketplace").addEventListener("click", () => openPage("marketplace"))

    for (const id of Object.keys(CARDS)) {
      const q = (part) => $(`cn-${id}-${part}`)
      if (!q("connect")) continue
      q("connect").addEventListener("click", async () => {
        const b = q("connect")
        b.disabled = true
        b.textContent = "Starting…"
        try { renderCard(id, await api("connectorConnect", { id })) }
        catch (e) { renderCard(id, { connected: false, error: String((e && e.message) || e) }) }
        finally { b.disabled = false; b.textContent = `Sign in with ${CARDS[id].name}` }
      })
      q("cancel").addEventListener("click", async () => { try { renderCard(id, await api("connectorCancel", { id })) } catch {} })
      q("disconnect").addEventListener("click", async () => { try { renderCard(id, await api("connectorDisconnect", { id })) } catch {} })
      q("copy").addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(q("code-value").textContent); q("copy").textContent = "Copied"; setTimeout(() => { q("copy").textContent = "Copy code" }, 1500) } catch {}
      })
      q("open").addEventListener("click", () => { api("openExternal", { url: q("open").dataset.url || CARDS[id].deviceUrl }).catch(() => {}) })
    }
    if (window.vibe && typeof window.vibe.onEvent === "function") {
      window.vibe.onEvent((ev) => {
        if (ev && ev.type === "connector.changed") {
          const st = (ev.data && ev.data.connector) || ev.connector
          if (st && CARDS[st.id]) renderCard(st.id, st)
        }
      })
    }
    refresh()
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
