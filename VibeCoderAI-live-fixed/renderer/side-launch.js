"use strict"
// The side-panel icon (title bar and sidebar): opens a short list of what can
// be shown on the right (changes, browser, files and code). With something
// already open on the right, the icon closes it again.
;(function () {
  const $ = (id) => document.getElementById(id)
  const box = $("side-launch")
  if (!box) return
  box.querySelectorAll("[data-vc-icon]").forEach((el) => window.VcIcons?.set?.(el, el.dataset.vcIcon))

  const browserOpen = () => { const b = $("browser-panel"); return !!b && !b.hidden }
  const codeOpen = () => !!window.vibeCodePanel?.isOpen?.()
  const anyOpen = () => !box.hidden || browserOpen() || codeOpen()

  function mark() {
    const on = anyOpen()
    for (const id of ["btn-side-panel", "chip-browser"]) $(id)?.classList.toggle("on", on)
  }

  function show() {
    box.hidden = false
    mark()
    box.querySelector(".side-launch-item")?.focus()
  }
  function hide() {
    box.hidden = true
    mark()
  }

  async function closeAll() {
    hide()
    if (browserOpen() && typeof window.closeBrowser === "function") window.closeBrowser()
    if (codeOpen()) await window.vibeCodePanel.hide()
    mark()
  }

  function toggle() {
    if (anyOpen()) closeAll()
    else show()
  }

  function open(name) {
    hide()
    if (name === "browser") { if (typeof window.openBrowser === "function") window.openBrowser() }
    else if (name === "files") window.vibeCodePanel?.files()
    else if (name === "changes") window.vibeCodePanel?.changes()
    mark()
  }

  box.querySelectorAll(".side-launch-item").forEach((b) => b.addEventListener("click", () => open(b.dataset.open)))
  $("side-launch-close")?.addEventListener("click", hide)
  $("btn-side-panel")?.addEventListener("click", toggle)
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") hide() })

  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return
    const key = String(e.key).toLowerCase()
    if (key === "l") { e.preventDefault(); toggle() }
    else if (key === "e") { e.preventDefault(); open("files") }
    else if (key === "g") { e.preventDefault(); open("changes") }
  })

  // Keep the icon's "on" look right when a panel opens or closes elsewhere.
  const watch = new MutationObserver(mark)
  for (const id of ["browser-panel", "code-panel", "side-launch"]) { const el = $(id); if (el) watch.observe(el, { attributes: true, attributeFilter: ["hidden"] }) }

  window.vibeSidePanel = { toggle, show, hide, open, closeAll }
})()
