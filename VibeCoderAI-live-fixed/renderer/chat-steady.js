"use strict"
// A steady chat while the agent works. During a run, parts of the chat close
// on their own (a finished "Thinking" box folds from ~350px to one line, long
// step lists hide older steps, a permission card loses its buttons) and a
// moment later the next step adds height again. That shrink-then-grow made
// the whole conversation jump up and down ("shaking").
//
// While a run is live (and after it, until the user leaves the bottom or opens
// another chat) and the user follows the bottom, the chat's total height never
// goes down: what a fold takes away is kept as spare space at the bottom (new
// content fills it), and the scroll position the browser clamped is put back
// before the frame is painted.
//
// The spare space is never closed while it is on screen, because closing it
// there pulls the whole chat down. It shrinks only by the part that is out of
// view below (the user scrolled up), when the next run fills it, or when a
// different chat is opened.
;(function () {
  const m = document.getElementById("messages")
  if (!m || typeof ResizeObserver !== "function") return
  let peakTotal = 0 // tallest scroll height seen while holding (spare space included)
  let gap = 0 // spare space currently added at the bottom

  let lastTop = m.scrollTop
  let lastTotal = m.scrollHeight
  let holding = false // a run is live, or just ended and the user still follows the bottom
  let view = null // the chat being shown; another chat drops the spare space

  // `state` is the app's top-level state object (shared global scope).
  const running = () => { try { return typeof state !== "undefined" && !!state.running } catch { return false } }
  const viewKey = () => {
    try { return typeof state === "undefined" ? "" : `${state.activeSessionID || ""}|${state.subagentView ? state.subagentView.id || state.subagentView.sessionID || "sub" : ""}` } catch { return "" }
  }
  const remember = () => { lastTop = m.scrollTop; lastTotal = m.scrollHeight }
  // Was the user at the bottom just before this change? Measured against the
  // height before the fold: after it the browser has already clamped scrollTop.
  // (The app glides to the bottom; while it glides the user still follows.)
  // The app knows when the user scrolled up on purpose: then never pull back.
  const following = () => {
    if (typeof window.vibeChatFollowing === "function" && !window.vibeChatFollowing()) return false
    return !!window.vibeChatGliding || lastTotal - lastTop - m.clientHeight <= 160
  }
  let lastGrowAt = 0 // when the chat last got taller (text or a tool is arriving)
  // A fold that settle() has not handled yet must not be recorded as "normal".
  const settled = () => !holding || m.scrollHeight >= peakTotal
  const hiddenBelow = () => Math.max(0, m.scrollHeight - m.scrollTop - m.clientHeight)

  // The spare space is the height of the chat's ::after spacer (theme.css).
  // Never more than most of one screen: a screen of nothing is worse than a
  // small move.
  const maxGap = () => Math.max(0, m.clientHeight - 120)
  function setGap(px) {
    const next = Math.max(0, Math.round(Math.min(px, maxGap())))
    if (next === gap) return
    gap = next
    if (!gap) m.style.removeProperty("--steady-gap")
    else m.style.setProperty("--steady-gap", `${gap}px`)
    void m.scrollHeight // lay out now, so a scrollTop set next is not clamped
  }

  function reset() {
    holding = false
    setGap(0)
    peakTotal = 0
    remember()
  }

  function startHold() {
    holding = true
    peakTotal = m.scrollHeight
  }

  // Runs after layout and before paint whenever a chat block changes size.
  function settle() {
    if (!holding) {
      if (!running()) return
      startHold()
    }
    if (!following()) {
      // The user reads further up: drop only the spare space that is out of
      // view, so nothing on screen moves, and stop holding once it is gone.
      setGap(gap - hiddenBelow())
      if (!gap && !running()) holding = false
      peakTotal = m.scrollHeight
      remember()
      return
    }
    const now = m.scrollHeight
    if (now > lastTotal) lastGrowAt = performance.now()
    const shrank = now < lastTotal
    const content = now - gap
    setGap(peakTotal - content)
    // Undo the browser's clamp after a fold — only then: a scroll the user made
    // is never put back.
    if (shrank && m.scrollTop < lastTop) m.scrollTop = lastTop
    peakTotal = Math.max(peakTotal, m.scrollHeight)
    remember()
  }

  const ro = new ResizeObserver(settle)
  const watch = (el) => { if (el instanceof Element) ro.observe(el) }
  for (const c of m.children) watch(c)
  // The chat is redrawn from history at the end of every run (that one redraw
  // is held steady) and on other occasions, such as Edit & resend or a
  // compaction. Any other redraw starts clean: its content is new anyway.
  let endedAt = 0
  let holdNextRedraw = false
  let wasLive = false
  new MutationObserver((list) => {
    let removed = 0
    let added = 0
    for (const rec of list) {
      for (const n of rec.addedNodes) { watch(n); added++ }
      for (const n of rec.removedNodes) { if (n instanceof Element) ro.unobserve(n); removed++ }
    }
    if (removed >= 3 && added && !running() && holding) {
      if (holdNextRedraw && Date.now() - endedAt < 6000) holdNextRedraw = false
      else reset()
    }
    settle()
  }).observe(m, { childList: true })
  m.addEventListener("scroll", () => {
    if (!settled()) return
    // Scrolled up after the run: let the out-of-view spare space go.
    if (holding && !running() && gap && hiddenBelow() > 0) {
      setGap(gap - hiddenBelow())
      peakTotal = m.scrollHeight
      if (!gap) holding = false
    }
    remember()
  }, { passive: true })

  function frame() {
    const key = viewKey()
    if (key !== view) { view = key; reset() } // another chat: start clean
    const live = running()
    if (live && !holding) startHold()
    if (wasLive && !live) { endedAt = Date.now(); holdNextRedraw = true }
    wasLive = live
    if (settled()) remember()
    // The spare space only catches a sudden fold (a closing Thinking box, a
    // group folding). Then it closes again in a few frames, so the chat eases
    // down instead of jumping, and a big fold never leaves a blank screen with
    // the text stuck at the top. New content that arrives meanwhile fills it.
    // Only while nothing is arriving: closing the space while new text pushes
    // the chat up made it go down and up again (a visible wobble).
    if (gap && settled() && (!live || performance.now() - lastGrowAt > 700)) {
      setGap(gap > 3 ? gap - Math.min(26, Math.max(2, gap * 0.12)) : 0)
      peakTotal = m.scrollHeight
      remember()
      if (!gap && !live) holding = false
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
  window.vibeChatSteady = { reset, gap: () => gap }
})()
