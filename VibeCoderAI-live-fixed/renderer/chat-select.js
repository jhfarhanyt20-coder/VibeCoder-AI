"use strict"
// Selecting chat text with the mouse: dragging past the bottom (or top) of the
// chat scrolls the CHAT, like a normal text view. Without this, Chromium's
// selection auto-scroll moved the whole (overflow:hidden) main pane instead,
// so the conversation slid up over the composer.
;(function () {
  const EDGE = 28 // px from the chat edge where auto-scroll starts
  const MAX_SPEED = 26 // px per frame at full distance
  let dragging = false
  let lastY = 0
  let raf = 0

  function chat() { return document.getElementById("messages") }

  // Panes that must never scroll themselves (they are overflow:hidden layouts).
  function pinLayout() {
    const box = chat()
    for (let el = box && box.parentElement; el; el = el.parentElement) {
      if (el.scrollTop) el.scrollTop = 0
      if (el.scrollLeft) el.scrollLeft = 0
    }
    const root = document.scrollingElement
    if (root && root.scrollTop) root.scrollTop = 0
  }

  function step() {
    raf = 0
    if (!dragging) return
    const box = chat()
    if (!box) return
    const r = box.getBoundingClientRect()
    let dy = 0
    if (lastY > r.bottom - EDGE) dy = Math.min(MAX_SPEED, 4 + (lastY - (r.bottom - EDGE)) / 3)
    else if (lastY < r.top + EDGE) dy = -Math.min(MAX_SPEED, 4 + ((r.top + EDGE) - lastY) / 3)
    if (dy) box.scrollTop += dy
    pinLayout()
    raf = requestAnimationFrame(step)
  }

  function stop() {
    if (!dragging) return
    dragging = false
    document.body.classList.remove("chat-selecting")
    if (raf) cancelAnimationFrame(raf), (raf = 0)
    pinLayout()
  }

  document.addEventListener("mousedown", (e) => {
    const box = chat()
    if (e.button !== 0 || !box || !box.contains(e.target)) return
    if (e.target.closest("button, input, textarea, select, a, [contenteditable='true']")) return
    dragging = true
    lastY = e.clientY
    document.body.classList.add("chat-selecting")
    if (!raf) raf = requestAnimationFrame(step)
  }, true)
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return
    if (!(e.buttons & 1)) return stop()
    lastY = e.clientY
  }, true)
  document.addEventListener("mouseup", stop, true)
  window.addEventListener("blur", stop)
  // Even outside a drag, a layout pane that got scrolled snaps back.
  document.addEventListener("scroll", (e) => {
    const box = chat()
    const t = e.target
    if (!box || t === box || !(t instanceof Element) || !t.contains(box)) return
    pinLayout()
  }, true)
})()
