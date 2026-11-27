/* ---------- chat ---------- */
/* Stick to the bottom while streaming, but let the user scroll up freely.
   The floating arrow appears whenever the user is away from the newest chat,
   including after a run has finished. */
function nearBottom(slack = 90) {
  const el = $("messages")
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

// Follow the newest chat while the user stays at the bottom. Decided by where
// the user last was, not by the distance after the change: a block that grows
// a lot at once (a table, a code block) must not make the chat stop following.
var chatFollowing = true // var: safe even if read before this line runs
// While following, the chat GLIDES to the newest line instead of snapping: a
// new paragraph or code block used to move everything up 50-70px in one frame,
// which read as jumping. Each frame closes part of the distance (a long gap is
// mostly skipped first). Opening a chat (force) still jumps straight there.
var chatGlide = 0
function glideStep() {
  chatGlide = 0
  const el = $("messages")
  if (!chatFollowing) return
  const max = el.scrollHeight - el.clientHeight
  const dist = max - el.scrollTop
  if (dist <= 0.5) { window.vibeChatGliding = false; return }
  window.vibeChatGliding = true
  const step = dist > el.clientHeight * 1.5 ? dist - el.clientHeight * 0.5 : Math.max(2, dist * 0.22)
  el.scrollTop = Math.min(max, el.scrollTop + step)
  chatGlide = requestAnimationFrame(glideStep)
}
function scrollChat(force = false) {
  const el = $("messages")
  if (force) {
    if (chatGlide) cancelAnimationFrame(chatGlide)
    chatGlide = 0
    window.vibeChatGliding = false
    el.scrollTop = el.scrollHeight
    chatFollowing = true
    chatUserAway = false
  } else if (!chatUserAway && (chatFollowing || nearBottom())) {
    chatFollowing = true
    el.style.overflowAnchor = "none"
    if (!chatGlide) chatGlide = requestAnimationFrame(glideStep)
  }
  requestAnimationFrame(updateJumpButton)
}
// The user scrolled up to read: nothing pulls the chat down again until they
// scroll back to the very bottom themselves or press the jump arrow. (Being
// "near" the bottom is not enough: one wheel step up used to count as near,
// and the next streamed word pulled the chat back down.)
var chatUserAway = false
window.vibeChatFollowing = () => chatFollowing && !chatUserAway
{
  const el = $("messages")
  // The browser's own scroll anchoring helps only while the user reads further
  // up (it keeps their place when something above changes). While following
  // the bottom it would fight the glide, so it is off then.
  const anchor = () => { el.style.overflowAnchor = chatFollowing ? "none" : "auto" }
  anchor()
  // During a glide the distance to the bottom is the glide's, not the user's.
  el.addEventListener("scroll", () => {
    if (!window.vibeChatGliding) {
      if (chatUserAway) {
        // Back at the very bottom by the user's own scrolling: follow again.
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 6) { chatUserAway = false; chatFollowing = true }
        else chatFollowing = false
      } else chatFollowing = nearBottom()
    }
    anchor()
  }, { passive: true })
  // Scrolling up by hand stops following (and any glide) at once, before the
  // next streamed word could pull the chat back down.
  const stop = () => { chatFollowing = false; chatUserAway = true; window.vibeChatGliding = false; if (chatGlide) cancelAnimationFrame(chatGlide); chatGlide = 0; anchor() }
  // Scrolling inside a code block, tool output or thought box scrolls that box,
  // not the chat: it must not stop following.
  const innerScroller = (target) => {
    for (let n = target instanceof Element ? target : null; n && n !== el; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true
    }
    return false
  }
  el.addEventListener("wheel", (event) => { if (event.deltaY < 0 && !innerScroller(event.target)) stop() }, { passive: true })
  el.addEventListener("keydown", (event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stop() })
  el.addEventListener("pointerdown", (event) => { if (event.offsetX > el.clientWidth) stop() }) // the scroll bar
}

function updateJumpButton() {
  const btn = $("jump-live")
  if (!btn) return
  const away = !nearBottom()
  btn.hidden = !away
  const composer = $("composer")
  const main = composer?.closest(".main")
  if (composer && main) {
    const box = composer.getBoundingClientRect()
    const frame = main.getBoundingClientRect()
    btn.style.left = `${Math.min(box.right - frame.left + 10, frame.width - 46)}px`
    btn.style.top = `${box.top - frame.top + (box.height - 36) / 2}px`
  }
  const label = btn.querySelector(".jump-label")
  if (label) label.textContent = state.running ? "Agent working" : "Jump to latest"
}

$("messages").addEventListener("scroll", updateJumpButton, { passive: true })
window.addEventListener("resize", updateJumpButton)
if (typeof ResizeObserver === "function") new ResizeObserver(updateJumpButton).observe($("composer"))
if ($("jump-live")) {
  $("jump-live").onclick = () => {
    scrollChat(true)
    updateJumpButton()
  }
}

// When the sidebar is collapsed, the chat stays at a readable line length and
// leaves wide margins. Treat those empty margins as part of the chat's scroll
// surface, without stealing wheel input from the composer or other controls.
$("main")?.addEventListener("wheel", (event) => {
  if (!sidebarIsHidden() || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  const target = event.target instanceof Element ? event.target : null
  if (!target || target.closest(
    "#messages, #composer, #subagent-composer, .retry-inline, .bg-job, .todo-panel, " +
      ".error-banner, .jump-live, button, input, textarea, select, [contenteditable='true']",
  )) return

  const messages = $("messages")
  const max = Math.max(0, messages.scrollHeight - messages.clientHeight)
  if (!max) return
  const scale = event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? messages.clientHeight : 1
  const next = Math.max(0, Math.min(max, messages.scrollTop + event.deltaY * scale))
  if (next === messages.scrollTop) return
  if (event.deltaY < 0) chatFollowing = false
  messages.scrollTop = next
  event.preventDefault()
  updateJumpButton()
}, { passive: false })

function addMsg(role, text, cls = "", images = []) {
  const el = document.createElement("div")
  el.className = `msg ${role}`
  el.innerHTML = `<span class="who"></span><div class="bubble ${cls}"></div>`
  el.querySelector(".who").textContent = role === "user" ? "You" : "BDCoder"
  const bubble = el.querySelector(".bubble")
  if (role === "assistant" && cls !== "thinking") {
    // Render markdown for assistant messages (not for "Thinking..." placeholder)
    if (window.renderMarkdownInto) window.renderMarkdownInto(bubble, text)
    else bubble.textContent = text
  } else {
    bubble.textContent = text
  }
  if (Array.isArray(images) && images.length) {
    const box = document.createElement("div")
    box.className = "msg-imgs"
    for (const src of images) {
      if (!src) continue
      const img = document.createElement("img")
      img.src = src
      img.alt = "attachment"
      img.loading = "lazy"
      box.appendChild(img)
    }
    if (box.children.length) bubble.appendChild(box)
  }
  if (role === "assistant" && cls === "commentary") appendTimeline(el, "commentary")
  else $("messages").appendChild(el)
  scrollChat()
  return bubble
}

/** Pull image data URLs out of a stored user message (v2 media/file parts). */
function userMessageImages(m) {
  const parts = Array.isArray(m?.content) ? m.content : []
  const out = []
  for (const p of parts) {
    if (!p || typeof p !== "object") continue
    if (!["media", "file", "image"].includes(p.type)) continue
    const mime = p.mime || p.mediaType || p.media?.source?.mediaType || ""
    if (!String(mime).startsWith("image/")) continue
    let url = p.url || p.dataUrl || p.src
    if (!url && p.media?.source?.type === "base64" && p.media.source.data) {
      url = `data:${mime};base64,${p.media.source.data}`
    }
    if (!url && typeof p.data === "string") url = `data:${mime};base64,${p.data}`
    if (url) out.push(url)
  }
  return out
}

/* ---------- opencode-style assistant turn rendering ---------- */
function countDiff(patch) {
  let add = 0
  let del = 0
  for (const line of String(patch || "").split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++
    else if (line.startsWith("-") && !line.startsWith("---")) del++
  }
  return { add, del }
}

function toolFiles(state, input = {}) {
  const files = state?.metadata?.files
  if (Array.isArray(files) && files.length) return files
  const md = state?.metadata
  if (md && typeof md === "object") {
    const out = []
    for (const [k, v] of Object.entries(md)) {
      if (v && typeof v === "object" && (v.patch || v.additions !== undefined)) {
        out.push({ file: k, patch: v.patch, additions: v.additions, deletions: v.deletions, hunks: v.hunks, oldLines: v.oldLines, newLines: v.newLines })
      }
    }
    if (out.length) return out
  }
  const p = input.path ?? input.filePath
  if (p) return [{
    file: p,
    patch: state?.metadata?.patch ?? input.patch,
    additions: state?.metadata?.additions,
    deletions: state?.metadata?.deletions,
    hunks: state?.metadata?.hunks,
    oldLines: state?.metadata?.oldLines,
    newLines: state?.metadata?.newLines,
  }]
  return []
}

const FILE_BADGES = {
  css: { t: "#", c: "var(--code-purple)" },
  scss: { t: "#", c: "var(--code-pink)" },
  less: { t: "#", c: "var(--code-purple)" },
  js: { t: "JS", c: "var(--code-yellow)" },
  mjs: { t: "JS", c: "var(--code-yellow)" },
  cjs: { t: "JS", c: "var(--code-yellow)" },
  jsx: { t: "JS", c: "var(--code-cyan)" },
  ts: { t: "TS", c: "var(--code-blue)" },
  tsx: { t: "TS", c: "var(--code-blue)" },
  html: { t: "<>", c: "var(--code-orange)" },
  htm: { t: "<>", c: "var(--code-orange)" },
  json: { t: "{}", c: "var(--code-yellow)" },
  md: { t: "M", c: "var(--code-steel)" },
  py: { t: "Py", c: "var(--code-navy)" },
  c: { t: "C", c: "var(--code-blue)" },
  cc: { t: "C++", c: "var(--code-blue)" },
  cpp: { t: "C++", c: "var(--code-blue)" },
  h: { t: "H", c: "var(--code-purple)" },
  hpp: { t: "H++", c: "var(--code-purple)" },
  java: { t: "J", c: "var(--code-orange)" },
  go: { t: "Go", c: "var(--code-cyan)" },
  rs: { t: "Rs", c: "var(--code-orange)" },
  bat: { t: "B", c: "var(--code-green)" },
  cmd: { t: "B", c: "var(--code-green)" },
  sh: { t: "$", c: "var(--code-green)" },
  yml: { t: "Y", c: "var(--code-red)" },
  yaml: { t: "Y", c: "var(--code-red)" },
  txt: { t: "T", c: "var(--code-gray)" },
}

const CODE_KEYWORDS = /^(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|namespace|new|null|private|protected|public|return|static|struct|switch|template|this|throw|true|try|type|typedef|typeof|undefined|using|var|virtual|void|while|yield)$/
const CODE_TOKEN = /(\/\/.*$|#\s*(?:include|define|if|ifdef|ifndef|endif|pragma|using)\b.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|namespace|new|null|private|protected|public|return|static|struct|switch|template|this|throw|true|try|type|typedef|typeof|undefined|using|var|virtual|void|while|yield)\b|\b\d+(?:\.\d+)?\b)/g

function renderCodeText(node, value) {
  const text = String(value ?? "")
  let at = 0
  CODE_TOKEN.lastIndex = 0
  let match
  while ((match = CODE_TOKEN.exec(text))) {
    if (match.index > at) node.appendChild(document.createTextNode(text.slice(at, match.index)))
    const token = document.createElement("span")
    const raw = match[0]
    token.className = raw.startsWith("//") ? "tok-comment"
      : raw.startsWith("#") ? "tok-pre"
        : /^["'`]/.test(raw) ? "tok-string"
          : /^\d/.test(raw) ? "tok-number"
            : CODE_KEYWORDS.test(raw) ? "tok-keyword" : ""
    token.textContent = raw
    node.appendChild(token)
    at = match.index + raw.length
  }
  if (at < text.length) node.appendChild(document.createTextNode(text.slice(at)))
  if (!text) node.appendChild(document.createTextNode(" "))
}

function fileBadge(file) {
  const name = String(file || "")
  const ext = name.split(".").pop().toLowerCase()
  const b = FILE_BADGES[ext] || { t: (ext || "?").slice(0, 2).toUpperCase(), c: "var(--code-gray)" }
  return b
}

function appendDiffLine(container, line = {}) {
  const type = line.type === "add" || line.type === "del" || line.type === "meta" ? line.type : "context"
  const row = document.createElement("div")
  row.className = `dl ${type === "context" ? "" : type}`.trim()
  const oldNo = document.createElement("span")
  oldNo.className = "dl-no old"
  oldNo.textContent = line.oldLine == null ? "" : String(line.oldLine)
  const newNo = document.createElement("span")
  newNo.className = "dl-no new"
  newNo.textContent = line.newLine == null ? "" : String(line.newLine)
  const mark = document.createElement("span")
  mark.className = "dl-mark"
  mark.textContent = type === "add" ? "+" : type === "del" ? "−" : type === "meta" ? "…" : ""
  const code = document.createElement("span")
  code.className = "dl-code"
  if (type === "meta") code.textContent = String(line.text ?? "") || " "
  else renderCodeText(code, line.text)
  row.append(oldNo, newNo, mark, code)
  container.appendChild(row)
}

function appendReadCode(container, output) {
  for (const raw of String(output || "").split(/\r?\n/).slice(0, 2000)) {
    const match = /^(\d+)\t(.*)$/.exec(raw)
    const row = document.createElement("div")
    row.className = match ? "code-row" : "code-row meta"
    const number = document.createElement("span")
    number.className = "code-no"
    number.textContent = match ? match[1] : ""
    const code = document.createElement("span")
    code.className = "code-text"
    if (match) renderCodeText(code, match[2])
    else code.textContent = raw || " "
    row.append(number, code)
    container.appendChild(row)
  }
}

function appendStructuredDiff(container, file) {
  const hunks = Array.isArray(file.hunks) ? file.hunks : []
  let previousOldEnd = 0
  for (const hunk of hunks) {
    const oldStart = Number(hunk.oldStart) || 1
    const omitted = Math.max(0, oldStart - previousOldEnd - 1)
    if (omitted) appendDiffLine(container, { type: "meta", text: `${omitted} unchanged line${omitted === 1 ? "" : "s"}` })
    for (const line of Array.isArray(hunk.lines) ? hunk.lines : []) appendDiffLine(container, line)
    previousOldEnd = Math.max(previousOldEnd, oldStart + Math.max(0, Number(hunk.oldCount) || 0) - 1)
  }
  const trailing = Math.max(0, (Number(file.oldLines) || 0) - previousOldEnd)
  if (trailing) appendDiffLine(container, { type: "meta", text: `${trailing} unchanged line${trailing === 1 ? "" : "s"}` })
}

function fileRowEl(f, input = {}, toolName = "") {
  const full = f.file ?? input.filePath ?? input.path ?? ""
  const stats = countDiff(f.patch)
  const add = f.additions ?? stats.add
  const del = f.deletions ?? stats.del
  const badge = fileBadge(full)

  const row = document.createElement("div")
  row.className = "file-row"
  row.innerHTML = `
    <span class="fr-kind"></span>
    <span class="fr-ic"></span>
    <span class="fr-name"></span>
    <span class="fr-stats">
      <span class="fr-add"></span>
      <span class="fr-del"></span>
    </span>
    <span class="fr-expand">⇅</span>
    <div class="fr-diff"></div>`

  // Spell the action out: "Edit src/app.js", "Write ...".
  row.querySelector(".fr-kind").textContent = toolRowLabel(toolName) || "Edit"
  const ic = row.querySelector(".fr-ic")
  ic.textContent = badge.t
  ic.style.color = badge.c
  ic.style.borderColor = `color-mix(in srgb, ${badge.c} 34%, transparent)`
  row.querySelector(".fr-name").textContent = relPath(full)
  row.querySelector(".fr-add").textContent = `+${add}`
  row.querySelector(".fr-del").textContent = `-${del}`

  const pre = row.querySelector(".fr-diff")
  const patch = String(f.patch ?? "")
  if (Array.isArray(f.hunks) && f.hunks.length) {
    appendStructuredDiff(pre, f)
  } else if (patch) {
    for (const line of patch.split(/\r?\n/)) {
      if (line.startsWith("@@")) appendDiffLine(pre, { type: "meta", text: line })
      else if (line.startsWith("+") && !line.startsWith("+++")) appendDiffLine(pre, { type: "add", text: line.slice(1) })
      else if (line.startsWith("-") && !line.startsWith("---")) appendDiffLine(pre, { type: "del", text: line.slice(1) })
      else appendDiffLine(pre, { type: "context", text: line.startsWith(" ") ? line.slice(1) : line })
    }
  } else {
    row.querySelector(".fr-expand").hidden = true
    pre.remove()
  }

  row.onclick = () => {
    if (!row.querySelector(".fr-diff")) return
    row.classList.toggle("open")
  }
  linkFileName(row.querySelector(".fr-name"), full, () => changedLinesOf(f))
  return row
}

// The new-file line numbers the agent added or changed, from a structured
// diff or a unified patch. Used to mark them in the code panel.
function changedLinesOf(f = {}) {
  const lines = []
  const hunks = Array.isArray(f.hunks) ? f.hunks : []
  if (hunks.length) {
    for (const h of hunks) {
      let n = Number(h.newStart) || Number(h.oldStart) || 1
      for (const l of Array.isArray(h.lines) ? h.lines : []) {
        if (l.type === "add") lines.push(n++)
        else if (l.type !== "del" && l.type !== "meta") n++
      }
    }
    return lines
  }
  let n = 0
  for (const line of String(f.patch ?? "").split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line)
    if (m) { n = Number(m[1]); continue }
    if (!n || line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) lines.push(n++)
    else if (!line.startsWith("-") && !line.startsWith("\\")) n++
  }
  return lines
}

// A file name in the chat: clicking it opens the file in the code panel on
// the right. The rest of the row keeps its own click (show / hide the diff).
function linkFileName(nameEl, file, lines) {
  if (!nameEl || !file || !window.vibeCodePanel) return
  nameEl.classList.add("fr-link")
  nameEl.title = `${relPath(file)} · open in the code editor`
  nameEl.addEventListener("click", (event) => {
    event.stopPropagation()
    window.vibeCodePanel.open(file, { lines: typeof lines === "function" ? lines() : lines })
  })
}

/* card row for read / list / grep / shell / webfetch */
const TOOL_CARD_META = {
  read: null,
  list: { t: "📁", c: "var(--code-gray)" },
  glob: { t: "📁", c: "var(--code-gray)" },
  grep: { t: "⌕", c: "var(--code-gray)" },
  shell: { t: "$", c: "var(--code-green)" },
  bash: { t: "$", c: "var(--code-green)" },
  webfetch: { t: "↗", c: "var(--code-steel)" },
  websearch: { t: "↗", c: "var(--code-steel)" },
}

function toolCardEl(name, input = {}, output = "") {
  const meta = TOOL_CARD_META[name] ?? { t: "•", c: "var(--code-gray)" }
  const badge = name === "read" ? fileBadge(input.path ?? input.filePath ?? "") : meta
  const title =
    name === "shell" || name === "bash"
      ? input.command ?? "shell"
      : name === "grep"
        ? `${input.pattern ?? ""}${input.path ? "  " + relPath(input.path) : ""}`.trim()
        : name === "webfetch" || name === "websearch"
          ? input.url ?? input.query ?? ""
          : relPath(input.path ?? input.filePath ?? "") || name

  const row = document.createElement("div")
  row.className = "file-row" + (output ? "" : " no-expand")
  row.innerHTML = `
    <span class="fr-kind"></span>
    <span class="fr-ic"></span>
    <span class="fr-name"></span>
    <span class="fr-stats"></span>
    <span class="fr-expand">⇅</span>
    <div class="fr-diff"></div>`
  // Spell the action out: "Read src/app.js", "Search foo", "Shell npm test".
  row.querySelector(".fr-kind").textContent = toolRowLabel(name)
  const ic = row.querySelector(".fr-ic")
  ic.textContent = badge.t
  ic.style.color = badge.c
  ic.style.borderColor = `color-mix(in srgb, ${badge.c} 34%, transparent)`
  row.querySelector(".fr-name").textContent = title
  row.querySelector(".fr-name").title = title
  if (name === "read") linkFileName(row.querySelector(".fr-name"), input.path ?? input.filePath ?? "")
  row.querySelector(".fr-stats").remove()

  const pre = row.querySelector(".fr-diff")
  if (output) {
    if (name === "read") appendReadCode(pre, output)
    else for (const line of output.split(/\r?\n/).slice(0, 400)) appendDiffLine(pre, { type: "context", text: line })
  } else {
    row.querySelector(".fr-expand").hidden = true
    pre.remove()
  }
  row.onclick = () => {
    if (!row.querySelector(".fr-diff")) return
    row.classList.toggle("open")
  }
  return row
}

function subagentMeta(state = {}, input = {}, toolCallId = "") {
  const md = state?.metadata && typeof state.metadata === "object" ? state.metadata : {}
  const output = (Array.isArray(state?.content) ? state.content : []).filter((item) => item?.type === "text").map((item) => item.text || "").join("\n")
  const legacyId = /\b(?:id|sessionID):\s*(subagent_[0-9a-f]+)\b/i.exec(output)?.[1] || ""
  const knownByCall = toolCallId && typeof subAgentsById !== "undefined"
    ? [...subAgentsById.values()].find((agent) => agent.parentToolCallId === toolCallId)
    : null
  const subagentId = md.subagentId || legacyId || knownByCall?.id || ""
  const known = (subagentId && typeof subAgentsById !== "undefined" ? subAgentsById.get(subagentId) : null) || knownByCall
  return {
    id: subagentId,
    sessionID: known?.childSessionId || md.subagentSessionId || "",
    name: known?.name || md.subagentName || input.name || input.agent || input.type || "Subagent",
    type: known?.type || md.subagentType || input.agent || input.type || "general",
    task: known?.task || md.subagentTask || input.task || "",
    status: known?.status || md.subagentStatus || (state.status === "error" ? "error" : "running"),
    result: known?.result || md.subagentResult || "",
    error: known?.error || md.subagentError || "",
  }
}

function syncSubagentCard(el, info) {
  if (!el || !info) return
  el.classList.add("subagent-tool")
  if (info.id) el.dataset.subagentId = info.id
  el.dataset.subagentStatus = info.status || "running"
  el.classList.remove("running", "done", "failed")
  const status = info.status || "running"
  el.classList.add(status === "done" ? "done" : status === "error" ? "failed" : "running")
  el.querySelector(".act-title").textContent = info.name || "Subagent"
  el.querySelector(".act-sub").textContent = `${info.type || "general"}${info.task ? ` · ${info.task}` : ""}`
  const stateEl = el.querySelector(".act-state")
  stateEl.textContent = status === "done" ? "✓" : status === "error" ? "✕" : "●"
  const body = el.querySelector(".act-body")
  body.textContent = info.result || info.error || info.task || "Open to watch progress"
  body.hidden = false
  const group = el.closest(".used-group")
  if (group) {
    if (group.classList.contains("timeline-group")) updateTimelineGroup(group)
  }
  el.querySelector(".act-head").onclick = (event) => {
    event.stopPropagation()
    if (info.id) openSubagentView(info.id)
  }
}

function renderToolDetails(el, name, input = {}, state = {}, toolCallId = "") {
  // subtitle (file path / command)
  const sub = toolSubtitle(name, input)
  const durationMs = Number(state?.metadata?.durationMs)
  const duration = Number.isFinite(durationMs) && durationMs >= 0 ? (durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`) : ""
  if (sub || duration) el.querySelector(".act-sub").textContent = [sub, duration].filter(Boolean).join(" · ")

  const files = toolFiles(state, input)
  const body = el.querySelector(".act-body")
  const out = el.querySelector(".act-out")

  if (name === "subagent" || name === "task") {
    syncSubagentCard(el, subagentMeta(state, input, toolCallId))
    return
  }

  el.querySelectorAll(".file-rows").forEach((n) => n.remove())

  if (files.length && (name === "edit" || name === "write" || name === "patch" || state?.metadata?.files)) {
    // File edits render as standalone cards (like the real app): the tool name
    // is already shown by the "Used N ..." group header.
    el.classList.add("file-tool")
    const wrap = document.createElement("div")
    wrap.className = "file-rows"
    for (const f of files) wrap.appendChild(fileRowEl(f, input, name))
    el.appendChild(wrap)
    for (const card of wrap.querySelectorAll(".file-row")) card.classList.toggle("open", !timelinePreferences.edits.collapse)
    return
  }

  const toolContent = Array.isArray(state.content) ? state.content : []
  const output = toolContent
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")

  // Browser screenshots are real image artifacts, not a byte-count placeholder.
  // Rebuild the image section each time a live tool result or history is rendered.
  el.querySelectorAll(".act-screenshots").forEach((node) => node.remove())
  const screenshots = toolContent.filter((item) => item?.type === "image" && item.dataUrl)
  if (screenshots.length) {
    const wrap = document.createElement("div")
    wrap.className = "act-screenshots"
    for (const shot of screenshots.slice(0, 2)) {
      const figure = document.createElement("figure")
      figure.className = "act-screenshot"
      const img = document.createElement("img")
      img.src = shot.dataUrl
      img.alt = `Browser screenshot${shot.title ? `: ${shot.title}` : ""}`
      img.loading = "lazy"
      img.decoding = "async"
      img.addEventListener("click", () => {
        const viewer = document.createElement("div")
        viewer.className = "browser-shot-viewer"
        viewer.setAttribute("role", "dialog")
        viewer.setAttribute("aria-label", "Browser screenshot preview")
        const close = document.createElement("button")
        close.type = "button"
        close.className = "browser-shot-close"
        close.textContent = "Close"
        const large = document.createElement("img")
        large.src = shot.dataUrl
        large.alt = img.alt
        close.onclick = () => viewer.remove()
        viewer.addEventListener("click", (event) => { if (event.target === viewer) viewer.remove() })
        viewer.append(close, large)
        document.body.appendChild(viewer)
      })
      figure.appendChild(img)
      const captionText = [shot.title, shot.url].filter(Boolean).join(" · ")
      if (captionText) {
        const caption = document.createElement("figcaption")
        caption.textContent = captionText
        figure.appendChild(caption)
      }
      wrap.appendChild(figure)
    }
    el.appendChild(wrap)
    el.classList.add("open")
  }

  if (name in TOOL_CARD_META && name !== "read" && timelineCategory(name) !== "shell") {
    el.classList.add("file-tool")
    const wrap = document.createElement("div")
    wrap.className = "file-rows"
    wrap.appendChild(toolCardEl(name, input, output))
    el.appendChild(wrap)
    return
  }

  el.classList.remove("file-tool")
  if (output) out.textContent = output.slice(0, 4000)
  else if (!body.textContent && Object.keys(input).length) {
    body.textContent = JSON.stringify(input, null, 2).slice(0, 1500)
  }
}

const TIMELINE_KEY = "vibecoder.timelinePreferences"
const TIMELINE_CATEGORIES = { shell: "Shell", edits: "Edits", thinking: "Thinking", subagents: "Subagents", notices: "Notices", tools: "Other tools", commentary: "Commentary" }
function loadTimelinePreferences() {
  let saved = {}
  try { saved = JSON.parse(localStorage.getItem(TIMELINE_KEY) || "{}") || {} } catch {}
  return Object.fromEntries(Object.keys(TIMELINE_CATEGORIES).map((key) => [key, { group: saved[key]?.group !== false, collapse: saved[key]?.collapse !== false }]))
}
let timelinePreferences = loadTimelinePreferences()
function timelineCategory(name) {
  if (["bash", "shell", "terminal", "exec", "command", "shellOutput", "shellInput", "shellList"].includes(name)) return "shell"
  if (["edit", "write", "patch", "multiedit", "apply_patch", "write_file"].includes(name)) return "edits"
  if (["subagent", "task", "subagentResult", "subagentStatus", "subagentStop"].includes(name)) return "subagents"
  return "tools"
}
function timelineGroup() {
  const wrap = document.createElement("div")
  // Steps stay visible: the agent's work reads as a list of actions. Each row's
  // details (output, diff) still open on click; long runs show the latest steps.
  wrap.className = "used-group timeline-group steps-visible"
  const head = document.createElement("button")
  head.type = "button"
  head.className = "used-head"
  head.innerHTML = '<span class="used-n"></span><span class="used-names"></span><span class="used-chev">▾</span>'
  const list = document.createElement("div")
  list.className = "used-list"
  const more = document.createElement("button")
  more.type = "button"
  more.className = "steps-more"
  more.hidden = true
  more.onclick = () => {
    wrap.classList.remove("trimmed")
    wrap.dataset.showAll = "1"
    more.hidden = true
  }
  list.before(more)
  head.onclick = () => {
    wrap.classList.toggle("collapsed")
    wrap.dataset.manualExpansion = "1"
    head.setAttribute("aria-expanded", String(!wrap.classList.contains("collapsed")))
  }
  wrap.append(head, more, list)
  return wrap
}
function updateTimelineGroup(group) {
  const rows = [...group.querySelector(".used-list").children]
  const tools = rows.filter((row) => row.dataset.timelineTool)
  const labels = [...new Set((tools.length ? tools : rows).map((row) => row.dataset.timelineTool || TIMELINE_CATEGORIES[row.dataset.timelineItem]))]
  group.querySelector(".used-n").textContent = `${tools.length || rows.length} step${(tools.length || rows.length) === 1 ? "" : "s"}`
  group.querySelector(".used-names").textContent = labels.join(" · ")
  const failed = rows.filter((row) => row.classList?.contains("failed")).length
  group.classList.toggle("has-failed", failed > 0)
  // "Working" only for the latest group of a run that is still going.
  group.classList.toggle("is-running", typeof state !== "undefined" && !!state.running && group === $("messages").lastElementChild && rows.some((row) => row.classList?.contains("act") && !row.classList.contains("done") && !row.classList.contains("failed")))
  // Long runs: show the latest 6 steps and a "show earlier" row.
  const hiddenCount = rows.length - 6
  const more = group.querySelector(".steps-more")
  const trim = hiddenCount > 2 && !group.dataset.showAll
  group.classList.toggle("trimmed", trim)
  if (more) { more.hidden = !trim; more.textContent = `Show ${hiddenCount} earlier step${hiddenCount === 1 ? "" : "s"}` }
  group.querySelector(".used-head").setAttribute("aria-expanded", String(!group.classList.contains("collapsed")))
}
function appendTimeline(el, category) {
  el.dataset.timelineItem = category
  const host = $("messages")
  el.remove()
  if (!timelinePreferences[category].group) { host.appendChild(el); return }
  let group = host.lastElementChild
  if (!group?.classList.contains("timeline-group")) {
    group = timelineGroup()
    host.appendChild(group)
  }
  group.querySelector(".used-list").appendChild(el)
  updateTimelineGroup(group)
}
function refreshTimelinePreferences() {
  const host = $("messages")
  const rows = [...host.children].flatMap((el) => el.classList.contains("timeline-group") ? [...el.querySelector(".used-list").children] : [el])
  host.replaceChildren()
  for (const row of rows) {
    if (row.dataset.timelineItem) {
      const category = row.dataset.timelineItem
      if (row.classList.contains("thought") || row.classList.contains("act")) row.classList.toggle("open", !timelinePreferences[category].collapse)
      for (const card of row.querySelectorAll(".file-row")) card.classList.toggle("open", !timelinePreferences[category].collapse)
      appendTimeline(row, category)
    } else host.appendChild(row)
  }
  scrollChat()
}
function initTimelineSettings() {
  const host = $("timeline-preferences")
  if (!host) return
  for (const [category, label] of Object.entries(TIMELINE_CATEGORIES)) {
    const row = document.createElement("div")
    row.className = "timeline-setting-row"
    const title = document.createElement("span")
    title.textContent = label
    row.appendChild(title)
    for (const option of ["group", "collapse"]) {
      const input = document.createElement("input")
      input.type = "checkbox"
      input.checked = timelinePreferences[category][option]
      input.dataset.timelineSetting = `${category}.${option}`
      input.setAttribute("aria-label", `${label}: ${option}`)
      input.onchange = () => {
        timelinePreferences[category][option] = input.checked
        try { localStorage.setItem(TIMELINE_KEY, JSON.stringify(timelinePreferences)) } catch {}
        refreshTimelinePreferences()
      }
      row.appendChild(input)
    }
    host.appendChild(row)
  }
}
initTimelineSettings()

/* ---------- thought rows (opencode style "Thought 4s") ---------- */
/** A finished thought reads "Thought for 12s"; a live one counts the seconds. */
function finishThought(el, secs) {
  if (!el) return
  if (el._thinkTimer) { clearInterval(el._thinkTimer); el._thinkTimer = null }
  el.classList.remove("live")
  const label = el.querySelector(".th-label")
  if (label) label.textContent = secs ? `Thought for ${secs}s` : "Thought"
  const dur = el.querySelector(".th-dur")
  if (dur) dur.textContent = ""
}
function startThoughtTimer(el, since) {
  if (!el) return
  el.classList.add("live")
  const label = el.querySelector(".th-label")
  if (label) label.textContent = "Thinking"
  const tick = () => {
    const d = el.querySelector(".th-dur")
    if (d) d.textContent = `${Math.max(0, Math.round((Date.now() - since) / 1000))}s`
  }
  tick()
  el._thinkTimer = setInterval(tick, 1000)
}
/** Keep the newest thinking text in view (the box scrolls on its own). */
function followThought(body) {
  if (!body) return
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 60 || body.dataset.follow !== "0") body.scrollTop = body.scrollHeight
}

function addThought(text = "", dur = 0, open = false) {
  const el = document.createElement("div")
  el.className = "thought" + ((open || !timelinePreferences.thinking.collapse) ? " open" : "")
  el.innerHTML = `
    <div class="thought-head">
      <span class="th-label">Thinking</span>
      <span class="th-dur"></span>
      <span class="th-chev">▸</span>
    </div>
    <div class="th-body"></div>`
  if (dur) finishThought(el, dur)
  else if (!open) el.querySelector(".th-label").textContent = "Thought"
  el.querySelector(".th-body").textContent = text
  el.querySelector(".thought-head").onclick = () => el.classList.toggle("open")
  appendTimeline(el, "thinking")
  scrollChat()
  return el
}

function toolRow(part) {
  const st = part.state ?? {}
  const key = `hist:${part.id}`
  const input = st.input ?? {}
  const name = part.name || "tool"
  const el = toolAct(key, name, input)
  renderToolDetails(el, name, input, st, part.id)
  if (st.status === "error" || st.status === "failed") actDone(key, false)
  else if (st.status === "completed" || st.status === "success") actDone(key, true)
  else el.classList.add("running")
  if (name === "subagent" || name === "task") syncSubagentCard(el, subagentMeta(st, input, part.id))
  return el
}

/* group consecutive tools like opencode: "Used 2 Write, Shell ▾" */
function toolGroupEl(tools) {
  const wrap = document.createElement("div")
  wrap.className = "used-group"
  const names = tools.map((t) => {
    if (t.part.name === "subagent" || t.part.name === "task") return subagentMeta(t.part.state, t.part.state?.input, t.part.id).name
    return toolRowLabel(t.part.name)
  })
  const head = document.createElement("div")
  head.className = "used-head"
  head.innerHTML = `<span class="used-n"></span><span class="used-names"></span><span class="used-chev">▾</span>`
  head.querySelector(".used-n").textContent = `Used ${tools.length}`
  head.querySelector(".used-names").textContent = names.join(", ")
  const list = document.createElement("div")
  list.className = "used-list"
  for (const t of tools) list.appendChild(t.el)
  head.onclick = () => wrap.classList.toggle("collapsed")
  wrap.append(head, list)
  return wrap
}

function renderAssistantMessage(m) {
  const parts = m.content ?? []
  const created = m.time?.created ?? 0
  const seenTexts = new Set()
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      // Some providers replay the last text part after a retry. The replay is NOT
      // always adjacent: the pattern is text -> tool -> text -> tool -> text.
      // A "consecutive only" check therefore let the same sentence through 3
      // times. Use a set of the texts already shown in THIS message instead, so
      // the same sentence is rendered exactly once no matter where it appears.
      const t = String(part.text).trim()
      if (t.length >= 24) {
        if (seenTexts.has(t)) continue
        seenTexts.add(t)
      }
      const commentary = parts.slice(parts.indexOf(part) + 1).some((next) => next.type === "tool")
      addMsg("assistant", part.text, commentary ? "commentary" : "")
    } else if (part.type === "reasoning" && part.text) {
      const span = part.time?.completed && part.time?.created
        ? part.time.completed - part.time.created
        : (m.time?.completed && m.time?.created ? m.time.completed - m.time.created : 0)
      const dur = span > 0 ? Math.max(1, Math.round(span / 1000)) : 0
      addThought(part.text, dur)
    } else if (part.type === "tool" && part.name === "question") {
      // Answered questions get a compact recap instead of a raw tool row.
      const q = questionHistoryEl(part)
      if (q) $("messages").appendChild(q)
    } else if (part.type === "tool") {
      toolRow(part)
    }
  }
}

function compactionHistoryEl(m) {
  const el = document.createElement("div")
  el.className = "ctxd-card done history"
  const head = document.createElement("div")
  head.className = "ctxd-head"
  head.innerHTML = `<span class="ctxd-ic">⌁</span><span class="ctxd-title">Context checkpoint</span><span class="ctxd-meta"></span>`
  const reason = m.reason || "checkpoint"
  const source = m.summarySource === "fallback" ? "fallback summary" : "AI summary"
  const model = m.summaryModel && m.summarySource !== "fallback" ? ` · ${m.summaryModel}` : ""
  head.querySelector(".ctxd-meta").textContent = `${reason} · ${source}${model}`
  const sum = document.createElement("div")
  sum.className = "ctxd-sum"
  const complete = [String(m.summary || "").trim(), String(m.projectContext || "").trim()].filter(Boolean).join("\n\n")
  if (window.renderMarkdownInto) window.renderMarkdownInto(sum, complete)
  else sum.textContent = complete
  sum.hidden = !complete
  head.onclick = () => el.classList.toggle("open")
  el.append(head, sum)
  if (complete) el.classList.add("open")
  return el
}

function renderHistoryMessages(msgs, { editable = true, usageRing = true, retryRow = true, assistantName = "BDCoder" } = {}) {
  if (usageRing) setUsageFromMessages(msgs)
  $("messages").innerHTML = ""
  liveCompactEl = null
  clearActs()
  permEls.clear()
  for (const m of msgs) {
    if (m.type === "user") {
      const text = m.metadata?.displayText ?? m.content?.text ?? m.text ?? ""
      const images = userMessageImages(m)
      if (text || images.length) {
        const bubble = addMsg("user", text, "", images)
        if (editable) attachUserActions(bubble, text, m.id)
        else bubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode("Task"))
      }
    } else if (m.type === "assistant") {
      renderAssistantMessage(m)
    } else if (m.type === "compaction") {
      // A compaction checkpoint: the conversation above it was summarized.
      if (m.status === "completed") $("messages").appendChild(compactionHistoryEl(m))
    } else if (m.type === "shell") {
      const key = `hist-shell:${m.id}`
      const el = addAct(key, "⌘", "Shell", "tool", m.command || "")
      el.querySelector(".act-body").textContent = m.cwd || ""
      actDone(key, m.status === "exited")
      el.classList.toggle("open", !timelinePreferences.shell.collapse)
      el.dataset.timelineTool = "Shell"
      appendTimeline(el, "shell")
    }
  }
  if (assistantName !== "BDCoder") {
    $("messages").querySelectorAll(".msg.assistant .who").forEach((node) => { node.textContent = assistantName })
  }
  scrollChat(true)
  if (retryRow) restoreRetryRow()
  if (usageRing) renderAutoCompact()
}

async function renderSessionHistory(sessionID) {
  const res = await vibe.getMessages({ sessionID, limit: 200 })
  if (!res.ok) return
  if (sessionID !== state.activeSessionID || state.subagentView) return // user switched while loading
  const msgs = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  renderHistoryMessages(msgs)
  renderQueueStrip()
}

/* ---------- edit & resend a sent user message ---------- */
function attachUserActions(bubble, text, messageID) {
  const msg = bubble?.closest(".msg")
  if (!msg) return bubble
  msg.dataset.text = text || ""
  msg.dataset.msgId = messageID || ""
  const btn = document.createElement("button")
  btn.type = "button"
  btn.className = "msg-edit"
  btn.title = "Edit and resend"
  btn.setAttribute("aria-label", "Edit and resend")
  btn.textContent = "✎"
  btn.onclick = (e) => {
    e.stopPropagation()
    beginEditMessage(msg)
  }
  msg.appendChild(btn)
  return bubble
}

function beginEditMessage(msg) {
  if (msg.querySelector(".msg-edit-box")) return
  const bubble = msg.querySelector(".bubble")
  if (!bubble) return
  const original = msg.dataset.text || bubble.textContent || ""

  const box = document.createElement("div")
  box.className = "msg-edit-box"
  const ta = document.createElement("textarea")
  ta.className = "msg-edit-input"
  ta.value = original
  ta.rows = Math.min(8, Math.max(2, original.split("\n").length + 1))

  const row = document.createElement("div")
  row.className = "msg-edit-actions"
  const save = document.createElement("button")
  save.type = "button"
  save.className = "save-btn"
  save.textContent = "Save & resend"
  const cancel = document.createElement("button")
  cancel.type = "button"
  cancel.className = "save-btn ghost"
  cancel.textContent = "Cancel"

  const close = () => {
    box.remove()
    bubble.hidden = false
    msg.querySelector(".msg-edit")?.removeAttribute("hidden")
  }
  cancel.onclick = close
  save.onclick = async () => {
    const next = ta.value.trim()
    if (!next) return
    save.disabled = true
    cancel.disabled = true
    save.textContent = "Resending…"
    const ok = await editAndResend(msg, next)
    if (!ok) {
      save.disabled = false
      cancel.disabled = false
      save.textContent = "Save & resend"
      close()
    }
  }

  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close()
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.onclick()
  })

  row.append(save, cancel)
  box.append(ta, row)
  bubble.hidden = true
  msg.querySelector(".msg-edit")?.setAttribute("hidden", "")
  msg.appendChild(box)
  ta.focus()
  ta.setSelectionRange(ta.value.length, ta.value.length)
}

/**
 * Find the server message id for a rendered user bubble (history or live).
 */
async function bindLiveMessageId(msgEl, text) {
  if (!msgEl) return
  const wanted = String(text || "").trim()
  if (!wanted) return
  for (let attempt = 0; attempt < 6; attempt++) {
    if (!msgEl.isConnected) return
    try {
      const sid = state.activeSessionID
      if (!sid) return
      const res = await vibe.getMessages({ sessionID: sid, limit: 30 })
      if (res.ok) {
        const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
        const msgs = all.filter((m) => m.type === "user")
        const pick = (m) => String(m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? "").trim()
        // The newest matching row that is not already bound to a bubble.
        const bound = new Set(
          [...$("messages").querySelectorAll(".msg.user")]
            .map((el) => el.dataset.msgId)
            .filter(Boolean),
        )
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (pick(msgs[i]) !== wanted) continue
          if (bound.has(msgs[i].id)) continue
          msgEl.dataset.msgId = msgs[i].id
          return
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 700))
  }
}

async function resolveUserMessageId(msg) {
  const sid = state.activeSessionID
  if (!sid) return null
  const res = await vibe.getMessages({ sessionID: sid, limit: 200 })
  if (!res.ok) return null
  const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const msgs = all.filter((m) => m.type === "user")
  const pick = (m) => m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? ""
  const userEls = [...$("messages").querySelectorAll(".msg.user")]
  const idx = userEls.indexOf(msg)
  if (idx < 0) return null

  // Align the server list with the rendered bubbles by walking both in order.
  // Matching by text alone is NOT safe: when the same text was sent twice the
  // old "search from the end" picked the NEWEST match, so the wrong (old)
  // message was deleted and the duplicate stayed for ever. Walking forward
  // pairs the 1st bubble with the 1st server row, the 2nd with the 2nd, ...
  const taken = new Set()
  const ids = new Array(userEls.length).fill(null)
  for (let i = 0; i < userEls.length; i++) {
    const text = userEls[i].dataset.text || ""
    if (!text) continue
    for (let k = 0; k < msgs.length; k++) {
      if (taken.has(msgs[k].id)) continue
      if (pick(msgs[k]) !== text) continue
      taken.add(msgs[k].id)
      ids[i] = msgs[k].id
      break
    }
  }
  if (ids[idx]) return ids[idx]
  // Nothing aligned (the message may not be persisted yet).
  return null
}

/**
 * Revert the session to just before the edited message, then send the new text.
 * Revert uses `files: false`, so the code changes the agent already made stay.
 * Returns true when the resend was started.
 */
async function editAndResend(msg, text) {
  const sid = state.activeSessionID
  if (!sid) return false
  if (state.running) {
    alert("The agent is still running. Stop it first, then edit and resend.")
    return false
  }
  const messageID = msg.dataset.msgId || (await resolveUserMessageId(msg))
  if (!messageID) {
    // Not persisted yet (e.g. the request failed) — just put it back in the composer.
    $("input").value = text
    $("input").dispatchEvent(new Event("input"))
    $("input").focus()
    return false
  }
  const ok = await showConfirm(
    "Edit & resend will remove this message and every reply after it from the chat.\n" +
      "Code changes the agent already made are kept.\n\nContinue?",
  )
  if (!ok) return false
  const res = await vibe.revertSession({ sessionID: sid, messageID })
  if (!res.ok) {
    alert("Could not revert this message: " + (res.error || "unknown error"))
    return false
  }
  await renderSessionHistory(sid)
  $("input").value = text
  $("input").dispatchEvent(new Event("input"))
  await send()
  return true
}

function openSession(id) {
  if (state.subagentView) leaveSubagentView(false)
  state.activeSessionID = id
  resetCompactionUi()
  setMainEmpty(false)
  hideBranchChip()
  document.querySelectorAll(".session-list li").forEach((li) => li.classList.remove("active"))
  const item = [...$("session-list").children].find(
    (li) => li.dataset.id === id,
  )
  item?.classList.add("active")
  renderSessionHistory(id)
  refreshSubagentIndex(id)
  refreshForms()
  // the running-commands list belongs to one session: drop the old rows, then
  // pull the commands this session still has running (they live in the backend)
  for (const [key, job] of [...runningJobs]) if (job.shellId) runningJobs.delete(key)
  renderBgJob()
  refreshShellJobs()
  // the pending retry belongs to the session that failed: switching away drops it
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  stopRetryCountdown()
  hideRetryInline()
  state.retryCount = 0
}

/* ---------- queued prompts (typed while the agent is running) ---------- */
const queuedPrompts = [] // { id, sid, text, attachments, files }

function attachmentFiles(items) {
  return items.map((item) => item.kind === "image" && item.dataUrl
    ? { uri: item.dataUrl, mime: item.mime || "image/png", name: item.name }
    : { path: item.path, mime: item.mime || "text/plain", name: item.name })
}

function clearSubmittedAttachments(submitted) {
  for (const item of submitted) {
    const index = attachments.indexOf(item)
    if (index !== -1) attachments.splice(index, 1)
  }
  renderAttachments()
}
const COMPOSER_DRAFT_KEY = "vibecoder.composerDraft"

function saveComposerDraft() {
  const ta = $("input")
  try {
    localStorage.setItem(COMPOSER_DRAFT_KEY, JSON.stringify({ text: ta.value, start: ta.selectionStart, end: ta.selectionEnd }))
  } catch {}
}

try {
  const draft = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_KEY) || "null")
  if (draft && typeof draft.text === "string") {
    $("input").value = draft.text
    $("input").setSelectionRange(draft.start || 0, draft.end || 0)
  }
} catch {}
window.addEventListener("pagehide", saveComposerDraft)
window.addEventListener("beforeunload", saveComposerDraft)

function renderQueueStrip() {
  const host = $("messages")
  if (!host) return
  host.querySelectorAll(".pending-prompt").forEach((el) => el.remove())
  for (const item of queuedPrompts.filter((q) => q.sid === state.activeSessionID)) {
    const images = item.attachments.filter((attachment) => attachment.kind === "image" && attachment.dataUrl).map((attachment) => attachment.dataUrl)
    const names = item.attachments.filter((attachment) => attachment.kind !== "image" || !attachment.dataUrl).map((attachment) => attachment.name || attachment.path || "File")
    const preview = [item.text, ...names.map((name) => `📎 ${name}`)].filter(Boolean).join("\n")
    const bubble = addMsg("user", preview, "", images)
    const row = bubble.closest(".msg")
    row.classList.add("pending-prompt")
    row.dataset.pendingId = item.id
    row.querySelector(".who").textContent = "You · Pending"
  }
}

async function queuePrompt() {
  const ta = $("input")
  const text = ta.value.trim()
  if ((!text && !attachments.length) || !state.activeSessionID) return
  const submitted = [...attachments]
  const item = { id: crypto.randomUUID(), sid: state.activeSessionID, text, attachments: submitted.map((attachment) => ({ ...attachment })), files: attachmentFiles(submitted), submitting: true }
  queuedPrompts.push(item)
  ta.value = ""
  saveComposerDraft()
  clearSubmittedAttachments(submitted)
  $("btn-send").disabled = false
  renderQueueStrip()
  try {
    if (typeof vibe.queuePrompt === "function") {
      const result = await vibe.queuePrompt({ sessionID: item.sid, id: item.id, text, files: item.files })
      if (result?.ok === false && state.running) showRunFailureInline(result.error || "Could not queue attachments; the pending message was retained.")
    }
  } catch (error) {
    if (state.running) showRunFailureInline(String(error?.message || error))
  } finally { item.submitting = false }
  if (!state.running) drainQueuedPrompt()
}

async function drainQueuedPrompt() {
  if (state.running || sendInFlight || state.stopping || state.retryTimer) return
  const item = queuedPrompts.find((q) => q.sid === state.activeSessionID)
  if (!item) { renderQueueStrip(); return }
  if (item.submitting) return
  sendInFlight = true
  try {
    if (await performSend(item)) {
      const index = queuedPrompts.indexOf(item)
      if (index !== -1) queuedPrompts.splice(index, 1)
    }
  } catch (e) {
    showRunFailureInline(String(e?.message || e))
  } finally {
    sendInFlight = false
    renderQueueStrip()
  }
}

let sendInFlight = false
async function send() {
  // Prevent double-click / Enter+click races while provider selection and session
  // setup contain asynchronous IPC calls. Never enqueue a second prompt into a busy run.
  if (sendInFlight) return
  if (state.running) {
    // OpenCode-style: Enter while the agent works queues the message; it is sent
    // automatically as soon as the current run finishes successfully.
    queuePrompt()
    return
  }
  sendInFlight = true
  try {
    await performSend()
  } catch (e) {
    showRunFailureInline(String(e?.message || e))
  } finally {
    sendInFlight = false
  }
}

async function performSend(queued = null) {
  const ta = $("input")
  let targetSessionID = queued?.sid ?? state.activeSessionID
  const sameSession = () => state.activeSessionID === targetSessionID
  if (!sameSession()) return false
  const text = queued === null ? ta.value.trim() : queued.text
  const sentAttachments = queued === null ? [...attachments] : queued.attachments
  const files = queued === null ? attachmentFiles(sentAttachments) : queued.files
  if (!text && !sentAttachments.length) return
  // A new message cancels a pending automatic retry (no double prompt).
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  stopRetryCountdown()
  hideRetryInline()
  maybeShowBranchForText(text)
  // The owner code is checked and REDACTED here: the model must never see it.
  const owner = await checkOwnerCode(text)
  if (!sameSession()) return false
  const sendText = owner.found ? owner.text : text

  // Re-read the authoritative provider catalog before every run. This closes the
  // race where profiles.json was edited/deleted but localStorage or an existing
  // session still points at the previous provider ID.
  if (typeof vibe.providerCatalog === "function") {
    const latest = await vibe.providerCatalog()
    if (!sameSession()) return false
    if (!latest || latest.ok === false) {
      throw new Error(`Could not refresh the current provider catalog before sending: ${latest?.error || "unknown error"}`)
    }
    applyProviderCatalog(latest.data || {})
  } else {
    await loadModels()
    if (!sameSession()) return false
  }
  const isCurrentModel = (key) => !!key && (state.models || []).some((item) => `${item.providerID}/${item.id}` === key)
  if (!isCurrentModel(state.selectedModel)) {
    const fallback = (state.models || []).find((item) => item && item.providerID && item.id)
    if (!fallback) throw new Error("No configured provider models are available. Open Settings → Model settings and save a provider with at least one model.")
    state.selectedModel = `${fallback.providerID}/${fallback.id}`
    try { localStorage.setItem("vibecoder.model", state.selectedModel) } catch {}
    $("model-label").textContent = modelDisplayLabel(state.selectedModel)
  }

  // A fresh user request starts a fresh background cycle.
  autoCont.count = 0
  autoCont.todos = []
  if (!targetSessionID) {
    const res = await vibe.createSession({ directory: projectDir })
    if (!sameSession()) return false
    if (!res.ok) return alert(res.error)
    const s = res.data?.data ?? res.data
    targetSessionID = s.id ?? s.sessionID
    state.activeSessionID = targetSessionID
    await refreshSessions()
    if (!sameSession()) return false
  }
  // Bind the session to a "BDCoder AI" agent (project-level agent file)
  let workDir = projectDir
  if (!workDir) {
    const c = await vibe.cwd()
    if (!sameSession()) return false
    workDir = c.ok ? c.data : null
  }
  if (workDir) {
    const ag = await vibe.ensureAgent({ directory: workDir })
    if (!sameSession()) return false
    if (ag.ok && !(ag.data && ag.data.ok === false)) {
      const sw = await vibe.switchAgent({ sessionID: targetSessionID, agent: "vibecoderai" })
      if (!sameSession()) return false
      if (!sw.ok) console.warn("[BDCoder] could not select the agent:", sw.error || "unknown error")
      hideError("agent")
    } else {
      console.warn("[BDCoder] could not prepare the project agent:", ag.error || ag.data?.error || "unknown error")
      hideError("agent")
    }
  }
  await applyPermissionMode(targetSessionID)
  if (!sameSession()) return false
  if (state.selectedModel) {
    const [providerID, ...rest] = state.selectedModel.split("/")
    const resM = await vibe.setModel({
      sessionID: targetSessionID,
      model: { providerID, id: rest.join("/") },
    })
    if (!sameSession()) return false
    if (!resM || resM.ok === false) {
      const message = resM?.error || "Could not apply the selected model. No message was sent."
      showError("Could not switch model", message, { key: "model-switch" })
      return // Never send the prompt using the session's previously active provider.
    }
    state.pendingModelPick = null // the new session now uses the picked model
    hideError("model-switch")
  }
  setMainEmpty(false)
  const fullText = sendText
  if (queued === null && ta.value.trim() === text) {
    ta.value = ""
    saveComposerDraft()
  }
  const imageUrls = sentAttachments
    .filter((a) => a.kind === "image" && a.dataUrl)
    .map((a) => a.dataUrl)
  const fileCount = sentAttachments.length - imageUrls.length
  let shown = sendText
  if (fileCount > 0) shown = (shown ? shown + " " : "") + `📎${fileCount}`
  if (queued === null) clearSubmittedAttachments(sentAttachments)
  const userMsgEl = addMsg("user", shown, "", imageUrls)
  attachUserActions(userMsgEl, sendText, "")
  scrollChat(true)
  clearActs()
  msgBuffers.clear()
  textEnded.clear()
  state.needBubble = false
  // No "Thinking..." text: the empty bubble shows blinking dots while the agent runs.
  const thinking = addMsg("assistant", "", "thinking")
  thinking.setAttribute("aria-label", "BDCoder is working")
  state.pendingBubble = thinking
  state.liveTextEl = thinking
  state.retryBubble = thinking // a later retry countdown belongs to this row
  if (state.thinkTimer) clearTimeout(state.thinkTimer)
  state.thinkTimer = null
  setRunning(true)
  // A new run starts only after the prior execution lifecycle has completed.
  state.compactionBlockedRun = false
  // a fresh run: forget the previous interrupt reason / error
  state.interruptReason = null
  state.userStopped = false
  state.lastRealError = null
  const thinkingEffort = pillState.thinking === "None" ? "none" : pillState.thinking.toLowerCase()
  // Remember what is being sent BEFORE the call: if the request itself fails or
  // times out, the Retry button needs the text.
  state.lastSend = { text: fullText, files, thinking: thinkingEffort, msgEl: userMsgEl, sid: targetSessionID }
  state.retryCount = 0
  let res
  try {
    res = await vibe.prompt({ sessionID: targetSessionID, text: fullText, files, thinking: thinkingEffort, pendingID: queued?.id })
  } catch (e) {
    if (!sameSession()) return false
    setRunning(false)
    if (state.thinkTimer) clearTimeout(state.thinkTimer)
    // prompt() threw before the engine touched the session: nothing to revert
    if (state.lastSend) state.lastSend.persisted = false
    showRunFailureInline(String(e), thinking)
    return
  }
  if (!sameSession()) return !!res?.ok
  if (!res.ok) {
    setRunning(false)
    if (state.thinkTimer) clearTimeout(state.thinkTimer)
    if (state.lastSend) state.lastSend.persisted = false
    showRunFailureInline(res.error || "Unknown error", thinking)
    return
  }
  hideError("prompt")
  // The engine titles a fresh session from this first prompt. The run starts
  // fire-and-forget on the backend, so refresh shortly after (the run-end
  // handler refreshes again as the authority).
  setTimeout(refreshSessions, 700)
  // Remember what was sent so a timeout / rate limit can be retried without the
  // user retyping anything.
  state.lastSend = { text: fullText, files, thinking: thinkingEffort, msgEl: userMsgEl, sid: targetSessionID }
  state.retryCount = 0
  // Bind the live bubble to the server message id, so a later "edit & resend"
  // or an automatic retry reverts THIS message and not a same-text one.
  // The prompt is enqueued at this point, so the row may not exist yet — the
  // lookup is retried a few times in the background.
  bindLiveMessageId(userMsgEl, fullText)
  // prompt() only enqueues the message — the agent is still running. Keep the
  // stop/running state until execution.succeeded / failed / interrupted fires.
  if (state.thinkTimer) clearTimeout(state.thinkTimer)
  state.thinkTimer = setTimeout(() => {
    if (thinking.classList.contains("thinking")) {
      // Do NOT end the running state here: OpenCode can sit inside its own
      // provider retry for minutes without emitting anything. Just say so, the
      // Stop button stays available.
      thinking.textContent = "⏳ No output for 2 minutes — still waiting (Stop to cancel)"
    }
  }, 120000)
  // Safety net in case the execution event never arrives. This is based on
  // *inactivity* (any event from the run restarts it), not on the total run
  // time: a long task with tool calls must never be killed by a fixed limit.
  armRunWatchdog()
  return true
}

/* ---------- inactivity watchdog ---------- */
/* A fixed "the run must be done in 10 minutes" timer used to interrupt big
   tasks and the UI then said "The run was interrupted." for no visible reason.
   OpenCode itself has no such limit, so now only a run that produced *nothing*
   (no text, reasoning, tool or step event) for a long time is stopped. */
const RUN_INACTIVITY_MS = 15 * 60 * 1000

function armRunWatchdog() {
  if (state.runTimer) clearTimeout(state.runTimer)
  state.runTimer = setTimeout(() => {
    state.runTimer = null
    if (!state.running) return
    // The abort that follows is generic - remember the real reason first.
    state.interruptReason = "inactivity"
    if (state.activeSessionID) Promise.resolve(vibe.interrupt({ sessionID: state.activeSessionID })).catch(() => {})
    setRunning(false)
    const mins = Math.round(RUN_INACTIVITY_MS / 60000)
    showRunFailureInline(`Stopped after ${mins} minutes of silence — send the message again to continue where it stopped.`)
  }, RUN_INACTIVITY_MS)
}

/* ---------- retry after a timeout / rate limit ---------- */
/* Provider hiccups (429, 5xx, timeouts, dropped sockets) used to stop the run
   with an error and nothing else. Now the run retries itself like OpenCode:
   exponential backoff from 2s capped at 10s, 10 attempts, with jitter. The
   countdown is rendered as its own row inside the timeline, directly under the
   line where the run stopped - not as a popup and not as a bottom bar. */
const MAX_RETRIES = 10

/** OpenCode's schedule: 2s, 4s, 8s, then 10s for the rest, with jitter. */
function retryDelayMs(attempt) {
  const base = Math.min(2000 * Math.pow(2, Math.max(0, attempt - 1)), 10000)
  const jitter = 0.85 + Math.random() * 0.3
  return Math.max(1000, Math.round(base * jitter))
}

/**
 * Context compaction failures are terminal for the current request. Retrying
 * the same oversized transcript cannot fix them and creates a stale Stop row.
 */
function isTerminalCompactionError(err) {
  const value = err && typeof err === "object" ? err : { message: String(err ?? "") }
  const code = String(value.code || "").toUpperCase()
  if (code.startsWith("CONTEXT_COMPACTION_")) return true
  const s = `${String(value.message || "")} ${JSON.stringify(value)}`.toLowerCase()
  return /context compaction failed|context compaction created a checkpoint.*still over budget|checkpoint committed, but the resulting request remains over budget|automatic compaction stopped after \d+ successful compactions|cannot compact safely|cannot compact because a safe split|no valid split boundary preserves|insufficient context budget to ask for a checkpoint summary|do not send another model request without recovery/.test(s)
}

/** Errors another attempt cannot fix: the key, account, model or compaction budget. */
function isFatalRunError(err) {
  if (isTerminalCompactionError(err)) return true
  const s = JSON.stringify(err ?? "").toLowerCase()
  if (!s) return false
  return /no credits|not enough credit|out of credits|insufficient (funds|balance|credits)|credit balance|billing|invalid api key|unauthorized|forbidden|permission denied|model not found|does not exist|no api key|api key for/.test(
    s,
  )
}

/** Everything else is retried automatically: rate limits, 5xx, timeouts, dropped
    streams, tool failures and aborts that arrive without a reason. */
function isRetryableRunError(err) {
  return !isFatalRunError(err)
}

/** The provider really says the account has no credits (a 429 is not that). */
function isNoCreditError(err) {
  const s = JSON.stringify(err ?? "").toLowerCase()
  return /no credits|not enough credit|out of credits|insufficient (funds|balance|credits)|credit balance|billing/.test(s)
}

function addRetryButtonToBubble(bubble) {
  if (!bubble || bubble.querySelector(".retry-btn")) return
  const btn = document.createElement("button")
  btn.className = "save-btn ghost retry-btn"
  btn.textContent = "⟳ Retry"
  btn.title = "Send the same message again"
  btn.onclick = async () => {
    btn.disabled = true
    const started = await retryLastRun()
    // nothing was sent (session still stopping / revert blocked): keep it usable
    if (!started) btn.disabled = false
  }
  bubble.appendChild(btn)
}

/** A run failure belongs where it happened: on the assistant bubble, with a Retry
 *  button. Run failures never open the red banner - that popup is only for setup
 *  problems (settings, providers). */
function showRunFailureInline(msg, target) {
  hideError("execution")
  hideError("prompt")
  hideError("retry")
  // A provider that answers 4xx before streaming ANY text leaves no assistant
  // bubble behind, and the history re-render wipes the "Thinking..." placeholder
  // because nothing was persisted for the assistant. Create the bubble instead
  // of dropping the error: a failed run that looks like silence is the worst
  // failure mode ("my message never got an answer").
  const t = target || runEndBubble()
  t.classList.remove("thinking")
  t.textContent = `⚠ ${msg}`
  addRetryButtonToBubble(t)
  scrollChat()
  return t
}

/** The server id of the newest persisted user message matching `text` (or the last
 *  user message when it has no text, e.g. an image-only prompt). Returns "" when it
 *  cannot be proven that the failed bubble really is in the session. */
async function findLastUserMessageID(sid, text) {
  if (!sid) return ""
  const res = await vibe.getMessages({ sessionID: sid, limit: 200 })
  if (!res || res.ok === false) return ""
  const all = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const users = all.filter((m) => m.type === "user")
  if (!users.length) return ""
  // More rendered user bubbles than server rows means the failed message never
  // reached the session (no API key, unknown profile...). Reverting then would
  // delete an OLDER real turn - never do that.
  const domUsers = $("messages").querySelectorAll(".msg.user").length
  if (domUsers > users.length) return ""
  const newest = users[users.length - 1]
  const pick = (m) => String(m?.metadata?.displayText ?? m?.content?.text ?? m?.text ?? "").trim()
  const wanted = String(text || "").trim()
  if (wanted) return pick(newest) === wanted ? newest.id || "" : ""
  return pick(newest) ? "" : newest.id || ""
}

/** Resend the last message, dropping the failed turn first so it is not duplicated. */
async function retryLastRun(auto = false) {
  const last = state.lastSend
  if (!last) return false
  // a timer and a click can race: only one retry may resend
  if (state.retrying) return false
  // A retry while the previous attempt is still alive must stop that run first:
  // the engine would otherwise answer "Session is busy" and the message would be
  // added a second time. The backend also waits, this makes the UI match it.
  if (state.running) {
    try {
      await vibe.interrupt({ sessionID: state.activeSessionID || last.sid })
    } catch {}
    const until = Date.now() + 5000
    while (state.running && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    if (state.running) {
      const t = lastAssistantBubble()
      if (t) t.textContent = "⏹ The run is still stopping — Retry again in a moment."
      return false
    }
  }
  state.retrying = true
  try {
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    // Never resend into another session the user switched to meanwhile.
    if (last.sid && state.activeSessionID && last.sid !== state.activeSessionID) return false
    const sid = state.activeSessionID || last.sid
    const target = lastAssistantBubble()
    // Preferred path: RESUME the run from the exact point it stopped instead of
    // rolling the turn back and replaying it. Every tool call that already
    // finished (reads, edits, file writes) stays in the session, so the work the
    // agent completed before the timeout is neither redone nor lost. Revert +
    // resend below stays only as the fallback: a message that never reached the
    // session, or a backend without the resume endpoint.
    if (last.persisted !== false && typeof vibe.resumeRun === "function") {
      if (target) target.classList.remove("thinking")
      let r = null
      try {
        setRunning(true) // before the IPC call: live deltas must not be dropped
        r = await vibe.resumeRun({ sessionID: sid })
      } catch {
        r = null
      }
      if (r && r.ok) {
        // reuse the retry bubble - a retried run must never add a second row
        const thinking = retryBubble()
        thinking.classList.add("thinking")
        thinking.textContent = "⟳ Resuming where it stopped..."
        state.pendingBubble = thinking
        state.liveTextEl = thinking
        state.userStopped = false
        state.interruptReason = null
        if (state.thinkTimer) clearTimeout(state.thinkTimer)
        state.thinkTimer = setTimeout(() => {
          if (thinking.classList.contains("thinking")) {
            thinking.textContent = "⏳ No output for 2 minutes — still waiting (Stop to cancel)"
          }
        }, 120000)
        hideError("execution")
        hideError("prompt")
        hideError("retry")
        hideRetryInline()
        armRunWatchdog()
        return true
      }
      setRunning(false)
    }
    // Find the failed user message on the server and remove it (plus everything
    // after it) BEFORE sending again. Without this the chat keeps both copies.
    let messageID = ""
    if (last.persisted === false) {
      // The prompt failed before the engine appended the message (no API key,
      // unknown profile...). It is a local bubble only: drop it, revert nothing.
      if (last.msgEl && last.msgEl.isConnected) last.msgEl.remove()
      if (target && target.isConnected) target.remove()
    } else {
      messageID = last.msgEl?.dataset.msgId || ""
      try {
        if (!messageID && last.msgEl && last.msgEl.isConnected) messageID = (await resolveUserMessageId(last.msgEl)) || ""
      } catch (e) {
        console.warn("retry: could not find the failed message:", e)
      }
      try {
        if (!messageID) messageID = await findLastUserMessageID(sid, last.text)
      } catch {}
      if (messageID) {
        let r = null
        try {
          r = await vibe.revertSession({ sessionID: sid, messageID })
        } catch (e) {
          r = { ok: false, error: String(e) }
        }
        if (!r || r.ok === false) {
          // The old turn is still in the session. Sending again now would leave
          // BOTH messages in the chat for ever, so nothing is sent.
          const msg = (r && r.error ? String(r.error) : "Unknown error") + " — the message was not sent again."
          showRunFailureInline(msg, target)
          return false
        }
        await renderSessionHistory(sid)
      } else if (last.msgEl && last.msgEl.isConnected) {
        // Not provably in the session: never delete an older turn. Only the local
        // bubble is dropped so the resend does not show the text twice.
        last.msgEl.remove()
        if (target && target.isConnected) target.remove()
      }
    }
    // Images / files of the original message go with the retry.
    attachments.length = 0
    for (const f of Array.isArray(last.files) ? last.files : []) {
      const uri = String(f.uri || "")
      if (uri.startsWith("data:")) {
        attachments.push({ kind: "image", dataUrl: uri, mime: f.mime || "image/png", name: f.name || "image" })
      } else if (uri.startsWith("file:///")) {
        attachments.push({ kind: "file", path: decodeURIComponent(uri.slice(8)), mime: f.mime || "", name: f.name || "(file)" })
      }
    }
    renderAttachments()
    $("input").value = last.text
    $("input").dispatchEvent(new Event("input"))
    hideError("execution")
    hideError("prompt")
    hideError("retry")
    hideRetryInline()
    if (auto) setRunning(false)
    // send() starts a fresh attempt and resets the counter. A retry must keep the
    // budget it already used, otherwise a model that never answers would retry
    // for ever instead of stopping after the whole schedule.
    const usedRetries = state.retryCount
    await send()
    state.retryCount = Math.max(state.retryCount, usedRetries)
    return true
  } finally {
    state.retrying = false
  }
}

/** The live "Retry 2/6 · 14s" label under the point where the run stopped. */
function stopRetryCountdown() {
  if (state.retryTick) {
    clearInterval(state.retryTick)
    state.retryTick = null
  }
}

/** The live "Retrying 2/10 · 8s" row under the point where the run stopped. */
const retryRowState = { active: false, attempt: 0, total: MAX_RETRIES, left: 0, reason: "" }

function retryRow() {
  const box = $("messages")
  if (!box) return null
  let el = box.querySelector(".retry-row")
  if (!el) {
    el = document.createElement("div")
    el.className = "retry-row"
    el.setAttribute("role", "status")
    el.setAttribute("aria-live", "polite")
    const spin = document.createElement("span")
    spin.className = "retry-spin"
    spin.setAttribute("aria-hidden", "true")
    spin.textContent = "⟳"
    const text = document.createElement("span")
    text.className = "retry-text"
    const stop = document.createElement("button")
    stop.className = "retry-row-stop"
    stop.type = "button"
    stop.textContent = "Stop"
    stop.onclick = (e) => {
      e.stopPropagation()
      cancelRetry()
    }
    el.append(spin, text, stop)
    // Insert directly after the last assistant bubble, not at the end of the container.
    // This keeps the retry counter inline below the BDCoder message.
    // Always the very end of the timeline: tool rows may follow the last assistant bubble.
    box.appendChild(el)
  }
  return el
}

function retryRowLabel() {
  const r = retryRowState
  const wait = r.left > 0 ? ` · ${r.left}s` : ""
  return `Retrying ${r.attempt}/${r.total}${wait}`
}

/** Render (or re-render) the inline retry row in its place in the timeline. */
function renderRetryRow() {
  if (!retryRowState.active) return
  const el = retryRow()
  if (!el) return
  const text = el.querySelector(".retry-text")
  if (text) text.textContent = retryRowState.reason ? `${retryRowState.reason} — ${retryRowLabel()}` : retryRowLabel()
  scrollChat()
}

/** Used after renderSessionHistory() wiped #messages: put the row back. */
function restoreRetryRow() {
  if (retryRowState.active) renderRetryRow()
  else hideRetryInline()
}

function showRetryInline(text, attempt, total, left) {
  if (attempt != null) retryRowState.attempt = attempt
  if (total != null) retryRowState.total = total
  if (left != null) retryRowState.left = left
  if (text != null) retryRowState.reason = String(text)
  retryRowState.active = true
  // The old bottom bar stays hidden: the retry lives in the timeline now.
  const legacy = $("retry-inline")
  if (legacy) legacy.hidden = true
  renderRetryRow()
}

function hideRetryInline() {
  retryRowState.active = false
  const el = $("messages")?.querySelector(".retry-row")
  if (el) el.remove()
  const legacy = $("retry-inline")
  if (legacy) legacy.hidden = true
}

/** The user cancelled the wait: no further attempt, and stop the run if needed. */
function cancelRetry() {
  stopRetryCountdown()
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  hideRetryInline()
  if (state.running) stopRunningJob("agent")
}

$("retry-inline-stop")?.addEventListener("click", cancelRetry)

/**
 * The ONE bubble every retry writes into (countdown, resume notice, errors).
 * Each attempt used to addMsg a fresh BDCoder row and leave the previous
 * "⟳ Retry n/3 · 0s" frozen in the chat - three retries, three duplicate
 * half-dead bubbles. Reusing a single row keeps the whole retry story in one
 * place and it gets replaced by the real answer once the run recovers.
 */
function retryBubble() {
  const el = state.retryBubble && state.retryBubble.isConnected ? state.retryBubble : lastAssistantBubble()
  if (el) {
    state.retryBubble = el
    return el
  }
  const fresh = addMsg("assistant", "", "thinking")
  state.retryBubble = fresh
  return fresh
}

function scheduleRetry(reason) {
  // Never schedule a retry for a compaction failure: no model request is safe
  // until the conversation is reduced or the user changes context settings.
  if (isTerminalCompactionError(reason)) {
    if (state.retryTimer) clearTimeout(state.retryTimer)
    state.retryTimer = null
    stopRetryCountdown()
    hideRetryInline()
    return false
  }
  // one retry at a time: step.failed and execution.failed can both report the
  // same failure, and a second schedule would burn attempts for nothing
  if (state.retryTimer || state.retrying) return true
  if (state.retryCount >= MAX_RETRIES) return false
  state.retryCount++
  const attempt = state.retryCount
  const wait = retryDelayMs(attempt)
  let left = Math.max(1, Math.round(wait / 1000))
  // Do NOT overwrite the stopped assistant line: the error stays where it
  // happened and the retry row is appended directly under it.
  showRetryInline(reason, attempt, MAX_RETRIES, left)
  // Live seconds, so the user can see the retry is real and how long it waits.
  stopRetryCountdown()
  state.retryTick = setInterval(() => {
    left = Math.max(0, left - 1)
    showRetryInline(null, attempt, MAX_RETRIES, left)
    if (left <= 0) stopRetryCountdown()
  }, 1000)
  if (state.retryTimer) clearTimeout(state.retryTimer)
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null
    stopRetryCountdown()
    retryLastRun(true)
  }, wait)
  return true
}

/* ---------- running / stop state ---------- */
function setRunning(on) {
  state.running = !!on
  // While the agent runs, an empty "working" bubble shows blinking dots (theme.css).
  document.body.classList.toggle("agent-running", state.running)
  if (!state.running) for (const g of document.querySelectorAll(".timeline-group.is-running")) g.classList.remove("is-running")
  if (!state.running) state.pulse = null
  const btn = $("btn-send")
  btn.classList.toggle("stop", state.running)
  btn.textContent = state.running ? "■" : "↑"
  btn.title = state.running ? "Stop" : "Send"
  btn.disabled = state.running ? false : !$("input").value.trim()
  updateRunBadge()
  // background job chip: shows while the agent works and the app is away
  if (state.running) {
    runningJobs.set("agent", { kind: "Agent", title: "Agent run", at: Date.now() })
    if (appIsInBackground()) markBackgroundJob()
    else renderBgJob()
  } else {
    clearBackgroundJob()
  }
  if (!state.running && state.runTimer) {
    clearTimeout(state.runTimer)
    state.runTimer = null
  }
  if (state.running) {
    if (state.permPoll) clearInterval(state.permPoll)
    state.permPoll = setInterval(refreshPermissionRequests, 1200)
    // questions can arrive any moment while the agent runs; poll keeps the card
    // in sync even if an event is missed
    if (state.formPoll) clearInterval(state.formPoll)
    state.formPoll = setInterval(refreshForms, 1500)
  } else {
    if (state.permPoll) {
      clearInterval(state.permPoll)
      state.permPoll = null
    }
    if (state.formPoll) {
      clearInterval(state.formPoll)
      state.formPoll = null
    }
    refreshForms()
  }
  updateJumpButton()
}

// Test hook: the offline UI tests drive the event handler directly.
window.__testSetRunning = (on) => setRunning(!!on)
window.__testState = state
// Test hooks for the duplicate/retry regression test.
window.__testRenderAssistant = (m) => renderAssistantMessage(m)
window.__testScheduleRetry = (reason) => scheduleRetry(reason)
window.__testRetryLastRun = (auto) => retryLastRun(auto)
window.__testClearRetry = () => {
  stopRetryCountdown()
  if (state.retryTimer) {
    clearTimeout(state.retryTimer)
    state.retryTimer = null
  }
  hideRetryInline()
}

$("btn-send").onclick = async () => {
  if (state.running) {
    // stop the running agent
    state.userStopped = true
    state.interruptReason = "user"
    state.stopping = true
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    try {
      const res = state.activeSessionID ? await vibe.interrupt({ sessionID: state.activeSessionID }) : { ok: true }
      if (!res.ok) throw new Error(res.error || "Could not stop the agent.")
    } catch (e) {
      state.stopping = false
      showRunFailureInline(String(e?.message || e))
      return
    }
    setRunning(false)
    state.retryBubble = null
    typingFlush()
    const t = lastAssistantBubble()
    if (t?.classList.contains("thinking")) {
      t.classList.remove("thinking")
      t.textContent = "⏹ Stopped"
    }
    state.stopping = false
    await drainQueuedPrompt()
    return
  }
  send()
}
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})
$("input").addEventListener("input", () => {
  saveComposerDraft()
  $("btn-send").disabled = state.running ? false : !$("input").value.trim()
})
/* Ctrl/Cmd+C over a selection in the chat (outside inputs) copies it. The native
   app menu is gone, so the shortcut is wired here; inside inputs the browser's
   own copy keeps working. */
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== "c") return
  const t = e.target
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || !String(sel).trim()) return
  document.execCommand("copy")
  e.preventDefault()
})

