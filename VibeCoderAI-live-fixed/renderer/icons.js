"use strict"
/**
 * BDCoder line icons: one consistent, monochrome set (24x24, 1.7 stroke,
 * currentColor) used in place of colored emoji in navigation, tool steps and
 * small buttons. Drawn for BDCoder; no third-party icon assets.
 * Exposes window.VcIcons = { svg(name), set(el, name, fallback), toolIcon(toolName) }.
 */
;(function () {
  const P = {
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2"/><circle cx="12" cy="12" r="7"/>',
    update: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-1.3-1.1-1.5-1.1-2.6 0-.9.7-1.5 1.6-1.5H16a5 5 0 0 0 5-5c0-4-4-7.3-9-7.3Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7.3" r="1"/><circle cx="14.5" cy="7.3" r="1"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7 14h10"/>',
    brain: '<path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5.2A3 3 0 0 0 7 17.5a2.5 2.5 0 0 0 5 .5V5.5A2.5 2.5 0 0 0 9 4.5Z"/><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5.2 3 3 0 0 1-3 4.8 2.5 2.5 0 0 1-5 .5"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5"/><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.7 2.6 2.3 3 4.7"/>',
    bag: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>',
    blocks: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 13.5v7M13.5 17h7"/>',
    plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0V8ZM12 16.5V21"/>',
    spark: '<path d="M12 3.5 13.8 10 20.5 12l-6.7 2L12 20.5 10.2 14 3.5 12l6.7-2L12 3.5Z"/>',
    terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 9.5 3 2.5-3 2.5M12.5 15H17"/>',
    hook: '<path d="M12 3v11a4 4 0 1 1-8 0"/><path d="M9 6h6"/>',
    chart: '<path d="M4 20V4M4 20h16"/><path d="m7.5 15 4-4.5 3 3L20 7"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    panelRight: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/>',
    changes: '<path d="M12 4v7M8.5 7.5h7"/><path d="M8.5 16h7"/><rect x="4" y="2.5" width="16" height="19" rx="2.5"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4-1.8v-4.7L4 5Z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
    folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z"/>',
    pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
    filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M12 11.5v6M9 14.5h6"/>',
    diff: '<path d="M7 4v10M2 9h10M14 17h8"/><rect x="13" y="3" width="8" height="8" rx="1.5"/>',
    bot: '<rect x="4.5" y="7.5" width="15" height="11" rx="3"/><path d="M12 4v3.5M9 12.5h.01M15 12.5h.01M9.5 15.5h5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
    camera: '<path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z"/><circle cx="12" cy="12.5" r="3.5"/>',
    scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 10h8M8 14h5"/>',
    windows: '<rect x="3" y="5" width="13" height="10" rx="1.5"/><path d="M8 19h11.5a1.5 1.5 0 0 0 1.5-1.5V9"/>',
    rocket: '<path d="M12 15c-2-1-3.5-2.5-4-4.5C9.5 6 12.5 3.5 18.5 3c-.5 6-3 9-6.5 12Z"/><path d="M8 10.5 5 11l-2 3 4 .5M13.5 16l-.5 3 3 2 .5-4"/><circle cx="14.5" cy="9" r="1.3"/>',
    pointer: '<path d="m5 3.5 13 6.5-5.5 1.5L10 17 5 3.5Z"/><path d="m13 12.5 5 5"/>',
    type: '<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>',
    key: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h.01M11 12h.01M15 12h2"/>',
    scroll: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v3"/>',
    move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    tool: '<path d="M14.5 4.5a4.5 4.5 0 0 0 5 6l-9 9a2.1 2.1 0 0 1-3-3l9-9a4.5 4.5 0 0 0-2-3Z"/>',
    user: '<circle cx="12" cy="8.5" r="3.7"/><path d="M4.5 20c.8-3.8 3.7-6 7.5-6s6.7 2.2 7.5 6"/>',
    memory: '<path d="M6 4h12v16l-6-4-6 4V4Z"/>',
    branch: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 4-4 4.5-9 7"/>',
    plugs: '<path d="M7 3v4M11 3v4M5 7h8v3a4 4 0 0 1-8 0V7ZM9 14v2a3 3 0 0 0 3 3h2"/><path d="M14 16h6M17 13v6"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4"/>',
    gauge: '<path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="m12 13 3.5-4"/><circle cx="12" cy="13.5" r="1.2"/>',
    newTask: '<path d="M12 20h8"/><path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 10.5-10.5Z"/>',
  }

  const NAV = {
    general: "gear", "app-updates": "update", appearance: "palette", "model-settings": "chip",
    "browser-use": "globe", "computer-use": "monitor", keyboard: "keyboard", memory: "memory",
    subagents: "users", marketplace: "bag", plugins: "blocks", mcp: "plug", skills: "spark",
    commands: "terminal", hooks: "hook", connectors: "plugs", usage: "chart", privacy: "lock",
  }

  const TOOLS = {
    read: "file", list: "folder", glob: "folder", grep: "search",
    shell: "terminal", bash: "terminal", terminal: "terminal", exec: "terminal", command: "terminal",
    edit: "pencil", write: "filePlus", patch: "diff", webfetch: "globe", websearch: "globe",
    task: "bot", subagent: "bot", skill: "spark", todowrite: "list",
    computer_screenshot: "camera", computer_zoom: "search", computer_steps: "pointer",computer_ui: "scan", computer_windows: "windows", computer_focus: "windows",
    computer_launch: "rocket", computer_click: "pointer", computer_type: "type", computer_key: "key",
    computer_scroll: "scroll", computer_drag: "move", computer_wait: "clock",
  }

  function svg(name) {
    const body = P[name]
    if (!body) return null
    const tpl = document.createElement("template")
    tpl.innerHTML = `<svg class="vc-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`
    return tpl.content.firstElementChild
  }

  /** Put icon `name` into `el`; keeps the old text if the icon is unknown. */
  function set(el, name, fallback) {
    if (!el) return false
    const node = svg(name)
    if (!node) { if (fallback != null) el.textContent = fallback; return false }
    el.textContent = ""
    el.appendChild(node)
    el.classList.add("has-vc-icon")
    return true
  }

  function toolIcon(toolName) {
    const n = String(toolName || "")
    if (TOOLS[n]) return TOOLS[n]
    if (/^computer_/.test(n)) return "monitor"
    if (/^github_/.test(n)) return "branch"
    if (n === "vibecoder_help") return "spark"
    if (/^crew/.test(n)) return "bot"
    if (/^facebook_/.test(n)) return "users"
    if (/^browser/.test(n)) return "globe"
    if (/^mcp[_.]/.test(n)) return "plug"
    return "tool"
  }

  /** Swap the emoji icons of static navigation for line icons. */
  function upgradeStatic(root = document) {
    root.querySelectorAll(".settings-nav .nav-item[data-page] > .ic").forEach((ic) => set(ic, NAV[ic.parentElement.dataset.page]))
    set(root.querySelector("#btn-back > .ic"), "back")
    set(root.querySelector("#btn-new-task > .ic"), "newTask")
    set(root.querySelector("#btn-marketplace > .ic"), "bag")
    set(root.querySelector("#btn-connectors > .ic"), "plugs")
    root.querySelectorAll(".cn-logo[data-vc-icon]").forEach((el) => set(el, el.dataset.vcIcon))
    const mini = { "btn-add-workspace": "plus", "btn-clear-workspaces": "trash", "chip-browser": "panelRight" }
    for (const [id, name] of Object.entries(mini)) set(root.getElementById ? root.getElementById(id) : null, name)
    root.querySelectorAll('.side-section-tools .mini-icon[title="Filter"]').forEach((b) => set(b, "filter"))
    root.querySelectorAll('.side-section-tools .mini-icon[title="Search"]').forEach((b) => set(b, "search"))
    root.querySelectorAll('.nav-bottom .mini-icon[title="Settings"]').forEach((b) => set(b, "gear"))
    set(root.querySelector("#btn-thinking > .ic"), "gauge")
    set(root.querySelector("#chip-project > .chip-ic"), "folder")
    set(root.querySelector("#chip-branch > .chip-ic"), "branch")
    set(root.getElementById ? root.getElementById("btn-model-refresh") : null, "refresh")
    // One tooltip per control: the styled one (data-tip) replaces the native title.
    root.querySelectorAll("[data-tip][title]").forEach((el) => {
      if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", el.getAttribute("title"))
      el.removeAttribute("title")
    })
  }

  window.VcIcons = { svg, set, toolIcon, upgradeStatic, names: Object.keys(P) }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => upgradeStatic())
  else upgradeStatic()
})()

// Example-task chips on the empty screen: fill the message box, never send.
;(function () {
  function wire() {
    document.querySelectorAll(".hero-chip[data-prompt]").forEach((chip) => {
      if (chip.dataset.vcWired) return
      chip.dataset.vcWired = "1"
      const name = chip.dataset.vcIcon
      if (name && window.VcIcons) {
        const icon = window.VcIcons.svg(name)
        if (icon) chip.prepend(icon)
      }
      chip.addEventListener("click", () => {
        const input = document.getElementById("input")
        if (!input) return
        input.value = chip.dataset.prompt
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.focus()
        try { input.setSelectionRange(input.value.length, input.value.length) } catch {}
      })
    })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire)
  else wire()
})()

// Sidebar: line icons on row actions, initials in the account avatar.
;(function () {
  function initials(text) {
    const s = String(text || "").replace(/@.*$/, "").replace(/[._-]+/g, " ").trim()
    if (!s || /^(connect|not connected)$/i.test(s)) return ""
    const parts = s.split(/\s+/).filter(Boolean)
    return ((parts[0] || "")[0] + ((parts[1] || "")[0] || (parts[0] || "")[1] || "")).toUpperCase()
  }
  function decorate() {
    if (!window.VcIcons) return
    document.querySelectorAll("#session-list .ws-acts button:not(.has-vc-icon), #workspace-list .ws-acts button:not(.has-vc-icon)").forEach((b) => {
      const del = b.classList.contains("del") || /delete|remove/i.test(b.title || "")
      window.VcIcons.set(b, del ? "trash" : "pencil")
    })
    const avatar = document.querySelector("#btn-connect .avatar")
    const label = document.getElementById("connect-label")
    if (avatar && label) {
      const ini = initials(label.textContent)
      if (ini) { avatar.textContent = ini; avatar.classList.add("vc-initials"); avatar.classList.remove("has-vc-icon") }
      else if (!avatar.classList.contains("has-vc-icon")) window.VcIcons.set(avatar, "user")
    }
  }
  function start() {
    decorate()
    const targets = ["session-list", "workspace-list", "connect-label"].map((id) => document.getElementById(id)).filter(Boolean)
    const mo = new MutationObserver(() => { mo.disconnect(); decorate(); targets.forEach((t) => mo.observe(t, { childList: true, subtree: true, characterData: true })) })
    targets.forEach((t) => mo.observe(t, { childList: true, subtree: true, characterData: true }))
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()

// Title bar: the sidebar toggle and the brand live at the very top, always
// visible (also while the sidebar is hidden). It drives the existing toggle.
;(function () {
  function sync() {
    const btn = document.getElementById("btn-titlebar-sidebar")
    const shell = document.querySelector(".shell")
    if (!btn || !shell) return
    const hidden = shell.classList.contains("sidebar-hidden")
    const tip = hidden ? "Show sidebar" : "Hide sidebar"
    btn.setAttribute("aria-label", tip)
    btn.dataset.tip = tip
    btn.setAttribute("aria-expanded", hidden ? "false" : "true")
  }
  function start() {
    const btn = document.getElementById("btn-titlebar-sidebar")
    if (!btn) return
    btn.addEventListener("click", () => {
      const inner = document.getElementById("btn-sidebar-toggle")
      if (inner) inner.click()
      sync()
    })
    const shell = document.querySelector(".shell")
    if (shell) new MutationObserver(sync).observe(shell, { attributes: true, attributeFilter: ["class"] })
    sync()
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()

// Sidebar width: drag its right edge to make it wider or narrower; drag it
// almost to the left edge to hide it (the title-bar button shows it again).
// Double-click the edge to go back to the default width. Remembered per user.
;(function () {
  const KEY = "vibecoder.sidebarWidth"
  const MIN = 200, MAX = 520, HIDE_AT = 140
  function apply(side, w) {
    if (!w) { side.style.removeProperty("width"); side.style.removeProperty("min-width"); side.style.removeProperty("max-width"); return }
    side.style.setProperty("width", w + "px", "important")
    side.style.setProperty("min-width", w + "px", "important")
    side.style.setProperty("max-width", w + "px", "important")
  }
  function start() {
    const side = document.getElementById("app-sidebar")
    if (!side || side.querySelector(".side-resizer")) return
    let saved = 0
    try { saved = Number(localStorage.getItem(KEY)) || 0 } catch {}
    if (saved >= MIN && saved <= MAX) apply(side, saved)
    const grip = document.createElement("div")
    grip.className = "side-resizer"
    grip.setAttribute("role", "separator")
    grip.setAttribute("aria-orientation", "vertical")
    grip.setAttribute("aria-label", "Resize sidebar")
    grip.title = ""
    side.appendChild(grip)
    let dragging = false
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return
      dragging = true
      grip.setPointerCapture(e.pointerId)
      document.body.classList.add("side-resizing")
      e.preventDefault()
    })
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return
      const left = side.getBoundingClientRect().left
      const x = e.clientX - left
      side.classList.toggle("about-to-hide", x < HIDE_AT)
      apply(side, Math.max(MIN, Math.min(MAX, Math.round(x))))
      window.dispatchEvent(new Event("resize"))
    })
    const end = (e) => {
      if (!dragging) return
      dragging = false
      document.body.classList.remove("side-resizing")
      const left = side.getBoundingClientRect().left
      const x = e.clientX - left
      side.classList.remove("about-to-hide")
      if (x < HIDE_AT) {
        const keep = Number(localStorage.getItem(KEY)) || 0
        apply(side, keep >= MIN ? keep : 0)
        const toggle = document.getElementById("btn-sidebar-toggle")
        if (toggle) toggle.click()
      } else {
        const w = Math.max(MIN, Math.min(MAX, Math.round(x)))
        try { localStorage.setItem(KEY, String(w)) } catch {}
      }
      window.dispatchEvent(new Event("resize"))
    }
    grip.addEventListener("pointerup", end)
    grip.addEventListener("pointercancel", end)
    grip.addEventListener("dblclick", () => {
      try { localStorage.removeItem(KEY) } catch {}
      apply(side, 0)
      window.dispatchEvent(new Event("resize"))
    })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
