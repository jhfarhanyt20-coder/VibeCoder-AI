"use strict"
// The chat must not shake while the agent works. Measured in the real renderer
// (frame by frame) these were the causes; this test keeps the fixes in place.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const root = path.join(__dirname, "..")
const app = fs.readFileSync(path.join(root, "renderer/app.js"), "utf8")
const steady = fs.readFileSync(path.join(root, "renderer/chat-steady.js"), "utf8")
const css = fs.readFileSync(path.join(root, "renderer/theme.css"), "utf8")

// 1. Streamed text is shown as markdown while it streams. Plain text that
//    became markdown only at the end made the message jump by ~300px.
const tick = app.slice(app.indexOf("function typingTick("), app.indexOf("function typingPaint("))
assert.match(tick, /typingPaint\(/, "typingTick paints through typingPaint")
assert.doesNotMatch(tick, /\.textContent = typing\.full\.slice/, "no plain-text streaming")
const paint = app.slice(app.indexOf("function typingPaint("), app.indexOf("function typingPush("))
assert.match(paint, /renderMarkdownInto\(typing\.el/, "typingPaint renders markdown")

// Throttle: long answers are painted less often, the last piece always.
{
  const painted = []
  const ctx = vm.createContext({ performance: { now: () => ctx.clock }, clock: 0, clearInterval() {}, painted })
  vm.runInContext(`var typing = { el: {}, full: "", shown: 0, timer: 1 }; function typingPaint(t) { painted.push(t) };` + tick, ctx)
  vm.runInContext(`typing.full = "x".repeat(200)`, ctx)
  for (let i = 0; i < 400 && vm.runInContext("typing.shown < typing.full.length", ctx); i++) { ctx.clock += 16; vm.runInContext("typingTick()", ctx) }
  assert.equal(painted.at(-1), "x".repeat(200), "the full text is painted at the end")
  assert(painted.length < 30, `painted ${painted.length} times; must be throttled`)
}

// 2. Following the newest text is decided by where the user last was, so a
//    block that grows a lot at once does not stop the follow; scrolling up by
//    hand stops it at once.
const scroll = app.slice(app.indexOf("var chatFollowing"), app.indexOf("function updateJumpButton("))
assert(scroll.includes("} else if (!chatUserAway && (chatFollowing || nearBottom())) {"), "follows by where the user was")
// It glides to the newest line (a paragraph used to snap the chat 50-74px up in one frame).
assert(scroll.includes("function glideStep()") && scroll.includes("Math.max(2, dist * 0.22)"), "glides instead of snapping")
assert(scroll.includes("if (!window.vibeChatGliding) {") && scroll.includes("} else chatFollowing = nearBottom()"), "a glide is not mistaken for the user scrolling")
// Scrolling up by hand stops following and the glide at once.
assert.match(scroll, /const stop = \(\) => \{ chatFollowing = false;[\s\S]*"wheel"[\s\S]*deltaY < 0 && !innerScroller\(event\.target\)\) stop\(\)/)
assert(steady.includes("!!window.vibeChatGliding ||"), "the steady chat treats a glide as following")

// 3. The steady chat keeps its spare space in a spacer, never in padding
//    (padding counts toward the flex item's minimum height and made the whole
//    chat box grow and push the layout), never larger than most of a screen,
//    and never closes it while it is on screen (that slid the chat down).
assert.doesNotMatch(steady, /paddingBottom/, "no padding-based spare space")
assert.match(steady, /--steady-gap/)
assert.match(steady, /maxGap = \(\) => Math\.max\(0, m\.clientHeight - 120\)/)
assert.doesNotMatch(steady, /DECAY/, "no closing animation of visible spare space")
assert.match(css, /\.chat-scroll::after \{[^}]*height: var\(--steady-gap, 0px\)[^}]*margin-top: -18px/)
assert.match(css, /\.chat-scroll \{ min-height: 0; \}/)
// The flex gap the negative margin cancels must still be 18px.
assert.match(css, /\.chat-scroll \{[^}]*gap: 18px;/)

console.log("PASS chat motion: live markdown while streaming, steady follow, spacer-based spare space")

// Question card: the header is not repeated for one question, the hints are
// plain English, and multi-select says so.
const card = app.slice(app.indexOf("function questionCardEl("), app.indexOf("function settleQuestionCard("))
assert.match(card, /fields\.length === 1 && fieldTitle === \(form\.title \|\| "Question"\)/)
assert.match(card, /"Or type your own answer…"/)
assert.match(card, /"Pick one or more"/)
assert.doesNotMatch(card, /lekho|Pathacchi|Dismiss fail/)
assert.match(css, /\.q-opts\.multi \.q-opt::before \{ border-radius: 4px; \}/)
console.log("PASS question card: no repeated header, English hints, round/square option marks")

// Open questions wait in a box above the composer (one at a time), never in
// the chat; once answered they move into the chat as a short recap.
const html = fs.readFileSync(path.join(root, "renderer/index.html"), "utf8")
assert(html.indexOf('id="q-dock"') > 0 && html.indexOf('id="q-dock"') < html.indexOf('id="composer"'), "the question box sits right above the composer")
const refresh = app.slice(app.indexOf("async function refreshForms("), app.indexOf("function questionHistoryEl("))
assert.match(refresh, /dockQuestionCard\(el\)/)
assert.doesNotMatch(refresh, /\$\("messages"\)\.appendChild\(el\)/, "a new question is not put into the chat")
assert.match(refresh, /el\.dataset\.sessionId !== listedSid\) continue/, "other chats' questions are left alone")
const settle = app.slice(app.indexOf("function settleQuestionCard("), app.indexOf("async function refreshForms("))
assert.match(settle, /\$\("messages"\)\.appendChild\(el\)/, "answered: the recap goes into the chat")
assert.match(settle, /function dockQuestionCard\([\s\S]*`\$\{at \+ 1\} of \$\{fields\.length\}`/)
assert(settle.includes(";(tabs || head).after(foot)"), "the buttons sit at the top of the box")
assert(css.includes(".q-dock .q-foot { position: sticky;"), "the buttons stay in view")
console.log("PASS question box: above the composer, one question at a time, buttons on top, recap in the chat")

// Working indicator: no "Thinking..." text, blinking dots while the agent runs.
{
  const polish = fs.readFileSync(path.join(root, "renderer/polish.css"), "utf8")
  assert(app.includes('const thinking = addMsg("assistant", "", "thinking")'), "the placeholder has no text")
  assert(app.includes('document.body.classList.toggle("agent-running", state.running)'), "setRunning marks the page")
  assert(polish.includes("body.agent-running .msg.assistant .bubble.thinking:empty::after") && polish.includes("@keyframes vc-working-dots"))
  assert(polish.includes("body:not(.agent-running) .msg.assistant:has(> .bubble.thinking:empty) { display: none; }"), "no empty bubble after the run")
  console.log("PASS working dots: no Thinking text, dots only while running")
}

// Ideas from studying an open-source chat UI, written our own way: scroll
// anchoring only while reading above, inner scroll boxes do not stop following,
// and a light band sweeps over the name of a running step.
{
  const polish = fs.readFileSync(path.join(root, "renderer/polish.css"), "utf8")
  const s2 = app.slice(app.indexOf("var chatFollowing"), app.indexOf("function updateJumpButton("))
  assert(s2.includes('el.style.overflowAnchor = chatFollowing ? "none" : "auto"'))
  assert(s2.includes("!innerScroller(event.target)"))
  assert(polish.includes("@keyframes vc-sweep") && polish.includes("body.agent-running .act:not(.done):not(.failed) .act-title"))
  console.log("PASS chat polish: anchoring by follow state, inner scrolling, running-step sweep")
}

// The spare space only catches a sudden fold and then closes by itself, so a
// folding Thinking box or a finished run never leaves the text stuck at the top.
{
  assert(steady.includes("setGap(gap > 3 ? gap - Math.min(26, Math.max(2, gap * 0.12)) : 0)"), "the spare space eases closed")
  console.log("PASS spare space: closes by itself, no blank screen after a fold or a run")
}

// Reading while the agent writes: one wheel step up stops following until the
// user scrolls back to the very bottom (or presses the jump arrow); the steady
// chat never puts back a scroll the user made, and closes its spare space only
// while nothing is arriving (no down-and-up wobble).
{
  const s3 = app.slice(app.indexOf("var chatFollowing"), app.indexOf("function updateJumpButton("))
  assert(s3.includes("} else if (!chatUserAway && (chatFollowing || nearBottom())) {"), "a user who scrolled up is not pulled back")
  assert(s3.includes("chatUserAway = true;"), "scrolling up marks the user as away")
  assert(s3.includes("el.scrollHeight - el.scrollTop - el.clientHeight <= 6) { chatUserAway = false; chatFollowing = true }"), "back at the very bottom follows again")
  assert(steady.includes('typeof window.vibeChatFollowing === "function" && !window.vibeChatFollowing()'), "the steady chat respects the user scrolling up")
  assert(steady.includes("if (shrank && m.scrollTop < lastTop) m.scrollTop = lastTop"), "only a fold's clamp is undone")
  assert(steady.includes("(!live || performance.now() - lastGrowAt > 700)"), "the spare space closes only while nothing arrives")
  console.log("PASS reading while writing: scroll up stays put, no wobble")
}
