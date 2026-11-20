"use strict"
// A steady chat while the agent works. During a run, parts of the chat close
// on their own (a finished "Thinking" box folds from ~350px to one line, long
// step lists hide older steps, a permission card loses its buttons) and a
// moment later the next step adds height again. That shrink-then-grow made
// the whole conversation jump up and down ("shaking").
//
// While a run is live and the user follows the bottom, the chat's total height
// never goes down: what a fold takes away is kept as spare space at the
// bottom (new content fills it), and the scroll position the browser clamped
// is put back before the frame is painted. When the run ends the spare space
// closes gently.
;(function () {
  const DECAY = 6 // px per frame when the spare space closes after a run
  const m = document.getElementById("messages")
  if (!m || typeof ResizeObserver !== "function") return
  let peakTotal = 0 // tallest scroll height seen in this run (spare space included)
  let gap = 0 // spare space currently added at the bottom
  let basePad = null
  let lastTop = m.scrollTop
  let lastTotal = m.scrollHeight
  let wasRunning = false
  let decaying = false

  // `state` is the app's top-level state object (shared global scope).
  const running = () => { try { return typeof state !== "undefined" && !!state.running } catch { return false } }
  const remember = () => { lastTop = m.scrollTop; lastTotal = m.scrollHeight }
  // Was the user at the bottom just before this change? Measured against the
  // height before the fold: after it the browser has already clamped scrollTop.
  const following = () => lastTotal - lastTop - m.clientHeight <= 160
  // A fold that settle() has not handled yet must not be recorded as "normal".
  const settled = () => !wasRunning || m.scrollHeight >= peakTotal

  function setGap(px) {
    const next = Math.max(0, Math.round(px))
    if (next === gap) return
    gap = next
    if (!gap) { m.style.paddingBottom = ""; basePad = null }
    else {
      if (basePad == null) basePad = parseFloat(getComputedStyle(m).paddingBottom) || 0
      m.style.paddingBottom = `${basePad + gap}px`
    }
    void m.scrollHeight // lay out now, so a scrollTop set next is not clamped
  }

  function startRun() {
    wasRunning = true
    decaying = false
    peakTotal = m.scrollHeight
  }

  // Runs after layout and before paint whenever a chat block changes size.
  function settle() {
    if (!running()) return // the end of a run is handled in frame()
    if (!wasRunning) startRun()
    if (!following()) {
      // The user reads further up: let the chat behave normally.
      setGap(0)
      peakTotal = m.scrollHeight
      remember()
      return
    }
    const content = m.scrollHeight - gap
    setGap(peakTotal - content)
    if (m.scrollTop < lastTop) m.scrollTop = lastTop // undo the browser's clamp
    peakTotal = Math.max(peakTotal, m.scrollHeight)
    remember()
  }

  const ro = new ResizeObserver(settle)
  const watch = (el) => { if (el instanceof Element) ro.observe(el) }
  for (const c of m.children) watch(c)
  new MutationObserver((list) => {
    for (const rec of list) {
      for (const n of rec.addedNodes) watch(n)
      for (const n of rec.removedNodes) if (n instanceof Element) ro.unobserve(n)
    }
    settle()
  }).observe(m, { childList: true })
  m.addEventListener("scroll", () => { if (settled()) remember() }, { passive: true })

  function frame() {
    const live = running()
    if (live && !wasRunning) startRun()
    if (!live && wasRunning) { wasRunning = false; decaying = true }
    if (settled()) remember()
    // After the run: close the spare space a little each frame.
    if (!live && decaying) {
      if (gap) setGap(gap > DECAY ? gap - DECAY : 0)
      remember()
      if (!gap) { decaying = false; peakTotal = 0 }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})()
