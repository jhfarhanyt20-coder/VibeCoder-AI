/* ---------- the theme (Obsidian + original dark / amoled / light / system) ---------- */
const THEME_KEY = "vibecoder.theme"
const FONT_KEY = "vibecoder.fontScale"
const CHAT_FONT_KEY = "vibecoder.chatFontScale"
const THEMES = ["obsidian", "dark", "amoled", "light", "system"]

function currentTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return THEMES.includes(t) ? t : "dark"
  } catch {
    return "dark"
  }
}

function systemTheme() {
  try {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
  } catch {
    return "dark"
  }
}

function resolvedTheme(name) {
  const t = THEMES.includes(name) ? name : "dark"
  return t === "system" ? systemTheme() : t
}

function syncWindowTheme() {
  try {
    if (!window.vibe || typeof vibe.windowTheme !== "function") return
    const resolved = document.documentElement.dataset.theme || "dark"
    const css = getComputedStyle(document.documentElement)
    const pick = (name, fallback) => {
      const value = css.getPropertyValue(name).trim()
      return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
    }
    // The native Windows title bar and 1px window border use the same surface
    // colours as the app, regardless of the Windows accent/theme setting.
    vibe.windowTheme({
      caption: pick("--bg-main", resolved === "light" ? "#ffffff" : "#0b0d12"),
      text: pick("--text", resolved === "light" ? "#1d2026" : "#d7dbe2"),
      border: pick("--border", resolved === "light" ? "#d9dde3" : "#26292f"),
      dark: resolved !== "light",
    })
  } catch {}
}

function applyTheme(name, save = true) {
  const theme = THEMES.includes(name) ? name : "dark"
  document.documentElement.dataset.theme = resolvedTheme(theme)
  if (save) {
    try { localStorage.setItem(THEME_KEY, theme) } catch {}
  }
  const sel = $("theme-select")
  if (sel) sel.value = theme
  syncWindowTheme()
}

/* the interface text size (only the text, not the icons) */
function normalizedFontPx(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 14
  // Releases before this control stored a ratio (for example 1.0714 for
  // 15px). New values are stored as the actual number shown beside the slider.
  const px = raw < 4 ? raw * 14 : raw
  return Math.min(18, Math.max(12, Math.round(px)))
}

function applyFontScale(px, save = true) {
  const n = normalizedFontPx(px)
  document.documentElement.style.setProperty("--fs-scale", String(n / 14))
  const range = $("font-size-range")
  if (range) {
    if (range.value !== String(n)) range.value = String(n)
    const min = Number(range.min) || 12
    const max = Number(range.max) || 18
    const pct = max > min ? ((n - min) / (max - min)) * 100 : 0
    range.style.setProperty("--range-pct", `${pct}%`)
  }
  const label = $("font-size-value")
  if (label) label.textContent = `${n} px`
  if (save) {
    try { localStorage.setItem(FONT_KEY, String(n)) } catch {}
  }
}

/* Chat text has its own scale so messages can grow without changing the
   sidebar, settings, or other app chrome. */
function normalizedChatFontPx(value) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 14
  const px = raw < 4 ? raw * 14 : raw
  return Math.min(22, Math.max(11, Math.round(px)))
}

function applyChatFontScale(px, save = true) {
  const n = normalizedChatFontPx(px)
  document.documentElement.style.setProperty("--chat-fs-scale", String(n / 14))
  const range = $("chat-font-size-range")
  if (range) {
    if (range.value !== String(n)) range.value = String(n)
    const min = Number(range.min) || 11
    const max = Number(range.max) || 22
    const pct = max > min ? ((n - min) / (max - min)) * 100 : 0
    range.style.setProperty("--range-pct", `${pct}%`)
  }
  const label = $("chat-font-size-value")
  if (label) label.textContent = `${n} px`
  if (save) {
    try { localStorage.setItem(CHAT_FONT_KEY, String(n)) } catch {}
  }
}

$("theme-select")?.addEventListener("change", (e) => applyTheme(e.target.value))
$("font-size-range")?.addEventListener("input", (e) => applyFontScale(e.target.value))
$("chat-font-size-range")?.addEventListener("input", (e) => applyChatFontScale(e.target.value))
// the theme has to be set before the first paint -> renderer/theme.js does that
applyTheme(currentTheme(), false)
try {
  const storedChatFont = localStorage.getItem(CHAT_FONT_KEY)
  applyChatFontScale(storedChatFont || 14, false)
} catch {
  applyChatFontScale(14, false)
}

/* custom window controls (the window is frameless so the title strip can use
   the app theme instead of the Windows accent colour) */
function updateMaximizeButton(maximized) {
  const button = $("win-max")
  if (!button) return
  button.textContent = maximized ? "❐" : "□"
  button.title = maximized ? "Restore" : "Maximize"
  button.setAttribute("aria-label", button.title)
}
$("win-min")?.addEventListener("click", () => { try { void vibe.windowMinimize?.() } catch {} })
$("win-max")?.addEventListener("click", async () => {
  try {
    const result = await vibe.windowMaximize?.()
    updateMaximizeButton(!!result?.data?.maximized)
  } catch {}
})
$("win-close")?.addEventListener("click", () => { try { void vibe.windowClose?.() } catch {} })
$("window-drag")?.addEventListener("dblclick", async (event) => {
  if (event.target.closest(".win-btn")) return
  try {
    const result = await vibe.windowMaximize?.()
    updateMaximizeButton(!!result?.data?.maximized)
  } catch {}
})
try {
  const stored = localStorage.getItem(FONT_KEY)
  applyFontScale(stored || 14, false)
} catch {
  applyFontScale(14, false)
}
// follow the system theme while it is selected
try {
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (currentTheme() === "system") applyTheme("system", false)
  })
} catch {}

/* ---------- agent activity (tools, reasoning, shell) ---------- */const toolArgs = new Map()
const toolNames = new Map() // tool call id -> name (session.tool.called omits it)

/* ---------- agent events in the chat ----------
   Every step the agent takes is a row in the chat timeline, each labelled with
   its name (Read / Search / Edit / Shell / Thinking ...). There is no separate
   status line in the composer - the chat IS the event log. */

/** Friendly one-word label per tool — shown on every row in the chat. */
const TOOL_ROW_LABEL = {
  read: "Read", write: "Write", edit: "Edit", patch: "Patch",
  grep: "Search", glob: "Find", list: "List", ls: "List",
  bash: "Shell", shell: "Shell", terminal: "Shell", exec: "Shell", command: "Shell",
  webfetch: "Fetch", websearch: "Web search", question: "Ask",
  task: "Subagent", subagent: "Subagent", skill: "Skill", todowrite: "Plan",
}

/** The name to show for a tool row ("Read", "Search", "Shell", ...). */
function toolRowLabel(name) {
  if (!name) return "Tool"
  return TOOL_ROW_LABEL[name] || TOOL_META[name]?.label || name
}

/** The agent's own plan (todowrite) — the next thing it says it will do. */
function nextTodoText(input) {
  const todos = input?.todos
  if (!Array.isArray(todos) || !todos.length) return ""
  const todo =
    todos.find((t) => t?.status === "in_progress") ||
    todos.find((t) => t?.status === "pending")
  return todo?.content ? String(todo.content).slice(0, 70) : ""
}

/** A short summary of the agent's plan for the "Plan" row in the chat. */
function planSummary(input) {
  const todos = input?.todos
  if (!Array.isArray(todos) || !todos.length) return ""
  const done = todos.filter((t) => t?.status === "completed").length
  const open = todos.length - done
  return `${done}/${todos.length} done${open ? `, ${open} open` : ""}`
}

const TOOL_META = {
  read: { icon: "📖", label: "Read" },
  list: { icon: "📁", label: "List" },
  glob: { icon: "📁", label: "List" },
  grep: { icon: "🔍", label: "Search" },
  shell: { icon: "⌘", label: "Shell" },
  bash: { icon: "⌘", label: "Shell" },
  terminal: { icon: "⌘", label: "Shell" },
  exec: { icon: "⌘", label: "Shell" },
  command: { icon: "⌘", label: "Shell" },
  edit: { icon: "✏️", label: "Edit" },
  write: { icon: "📝", label: "Write" },
  patch: { icon: "🩹", label: "Patch" },
  webfetch: { icon: "🌐", label: "Web fetch" },
  websearch: { icon: "🌐", label: "Web search" },
  task: { icon: "🤖", label: "Agent" },
  subagent: { icon: "🤖", label: "Agent" },
  skill: { icon: "🧩", label: "Skill" },
  todowrite: { icon: "📋", label: "Todo" },
  // Computer Use: each step reads like what a person would do.
  computer_screenshot: { icon: "📸", label: "Screenshot" },
  computer_zoom: { icon: "🔍", label: "Look closer" },
  computer_steps: { icon: "🖱", label: "Several steps" },
  computer_done: { icon: "✓", label: "Computer Use off" },
  computer_ui: { icon: "🔎", label: "Read screen" },
  computer_windows: { icon: "🪟", label: "Windows" },
  computer_focus: { icon: "🪟", label: "Switch window" },
  computer_launch: { icon: "🚀", label: "Open app" },
  computer_click: { icon: "🖱", label: "Click" },
  computer_type: { icon: "⌨", label: "Type" },
  computer_key: { icon: "⌨", label: "Press key" },
  computer_scroll: { icon: "🖱", label: "Scroll" },
  computer_drag: { icon: "🖱", label: "Drag" },
  computer_wait: { icon: "⏳", label: "Wait" },
  vibecoder_help: { icon: "?", label: "VibeCoder guide" },
  crewChanges: { icon: "🤖", label: "Review helper's work" },
  crewMerge: { icon: "🤖", label: "Merge helper's work" },
  crewDiscard: { icon: "🤖", label: "Discard helper's work" },
  // GitHub connector
  github_repos: { icon: "⎇", label: "GitHub repos" },
  github_files: { icon: "⎇", label: "GitHub file" },
  github_search_code: { icon: "⎇", label: "GitHub search" },
  github_issues: { icon: "⎇", label: "GitHub issues" },
  github_issue: { icon: "⎇", label: "GitHub issue" },
  github_create_issue: { icon: "⎇", label: "New issue" },
  github_comment: { icon: "⎇", label: "GitHub comment" },
  github_create_branch: { icon: "⎇", label: "New branch" },
  github_write_file: { icon: "⎇", label: "Commit file" },
  github_create_pr: { icon: "⎇", label: "Open PR" },
  github_merge_pr: { icon: "⎇", label: "Merge PR" },
  github_api: { icon: "⎇", label: "GitHub API" },
  // Facebook connector
  facebook_pages: { icon: "f", label: "Facebook Pages" },
  facebook_page_posts: { icon: "f", label: "Page posts" },
  facebook_create_post: { icon: "f", label: "Facebook post" },
  facebook_comments: { icon: "f", label: "Comments" },
  facebook_reply_comment: { icon: "f", label: "Reply to comment" },
  facebook_messages: { icon: "f", label: "Messenger" },
  facebook_send_message: { icon: "f", label: "Send message" },
  facebook_insights: { icon: "f", label: "Insights" },
  facebook_ad_accounts: { icon: "f", label: "Ad accounts" },
  facebook_ads: { icon: "f", label: "Ads" },
  facebook_create_campaign: { icon: "f", label: "New campaign" },
  facebook_set_status: { icon: "f", label: "Ad status" },
  facebook_api: { icon: "f", label: "Facebook API" },
}

const actEls = new Map() // key -> element
let reasoningEl = null

function relPath(p) {
  if (!p) return ""
  let s = String(p)
  if (projectDir) {
    const base = String(projectDir).replace(/[\\/]+$/, "")
    if (s.toLowerCase().startsWith(base.toLowerCase())) {
      s = s.slice(base.length).replace(/^[\\/]+/, "")
    }
  }
  return s.split("\\").join("/")
}

function toolSubtitle(name, input = {}) {
  if (/^facebook_/.test(String(name))) {
    return [input.page && `page ${input.page}`, input.ad_account, input.id, input.name, input.status, input.message && String(input.message).slice(0, 60), input.method && input.path ? `${input.method} ${input.path}` : ""].filter(Boolean).join(" · ").slice(0, 160)
  }
  if (/^github_/.test(String(name))) {
    return [input.repo, input.number != null ? `#${input.number}` : "", input.path, input.branch || input.head, input.title, input.query, input.method && input.path ? "" : ""].filter(Boolean).join(" · ").slice(0, 160)
  }
  switch (name) {
    case "read":
      return [relPath(input.filePath ?? input.path ?? ""), input.offset != null ? `offset=${input.offset}` : "", input.limit != null ? `limit=${input.limit}` : ""].filter(Boolean).join(" ")
    case "list":
    case "glob":
      return relPath(input.path ?? "") || input.pattern || ""
    case "grep":
      return `${input.pattern ?? ""} ${relPath(input.path ?? "")}`.trim()
    case "shell":
    case "bash":
    case "terminal":
    case "exec":
    case "command":
      return input.command ?? input.cmd ?? ""
    case "edit":
    case "write":
    case "patch":
      return relPath(input.filePath ?? input.path ?? "")
    case "webfetch":
      return input.url ?? ""
    case "websearch":
      return input.query ?? input.url ?? ""
    case "todowrite":
      return planSummary(input) || nextTodoText(input)
    // Computer Use: a short, human description of each step.
    case "computer_click":
    case "computer_scroll": {
      const where = input.element != null ? `item ${input.element}` : input.x != null ? `at ${Math.round(input.x)}, ${Math.round(input.y)}` : ""
      const how = input.double ? "double click" : input.button === "right" ? "right click" : ""
      const scroll = name === "computer_scroll" && input.amount != null ? `${input.amount > 0 ? "up" : "down"} ${Math.abs(input.amount)}` : ""
      return [scroll, how, where].filter(Boolean).join(" · ")
    }
    case "computer_type": {
      const text = String(input.text ?? "")
      return `“${text.length > 60 ? text.slice(0, 60) + "…" : text}”${input.enter ? " + Enter" : ""}`
    }
    case "computer_key":
      return input.keys ?? ""
    case "computer_launch":
      return input.program ?? ""
    case "computer_focus":
      return input.title ?? (input.window ? `window ${input.window}` : "")
    case "computer_drag":
      return input.from_element != null || input.to_element != null ? `item ${input.from_element ?? "?"} → item ${input.to_element ?? "?"}` : ""
    case "computer_wait":
      return input.for_window ? `for “${input.for_window}”` : input.seconds != null ? `${input.seconds} s` : ""
    case "computer_steps":
      return Array.isArray(input.steps) ? input.steps.map((s) => s && s.action).filter(Boolean).join(" → ") : ""
    case "computer_zoom":
      return input.width != null ? `${Math.round(input.width)}×${Math.round(input.height || 0)} at ${Math.round(input.x || 0)}, ${Math.round(input.y || 0)}` : ""
    case "computer_screenshot":
    case "computer_ui":
    case "computer_windows":
      return ""
    default:
      return input.description ?? input.query ?? input.prompt ?? ""
  }
}

function addAct(key, icon, title, kind = "", subtitle = "") {
  if (actEls.has(key)) return actEls.get(key)
  const el = document.createElement("div")
  el.className = "act" + (kind ? " " + kind : "")
  el.innerHTML = `
    <div class="act-head">
      <span class="act-ic"></span>
      <span class="act-title"></span>
      <span class="act-sub"></span>
      <span class="act-state">●</span>
    </div>
    <pre class="act-body"></pre>
    <pre class="act-out"></pre>`
  const ic = el.querySelector(".act-ic")
  if (!(icon && typeof icon === "object" && icon.vc && window.VcIcons && window.VcIcons.set(ic, icon.vc))) ic.textContent = icon && typeof icon === "object" ? icon.text || "" : icon
  el.querySelector(".act-title").textContent = title
  el.querySelector(".act-sub").textContent = subtitle
  el.querySelector(".act-head").onclick = () => el.classList.toggle("open")
  $("messages").appendChild(el)
  actEls.set(key, el)
  scrollChat()
  return el
}

function toolAct(key, name, input = {}) {
  const meta = TOOL_META[name] ?? { icon: "🔧", label: name }
  const el = addAct(key, window.VcIcons ? { vc: window.VcIcons.toolIcon(name), text: meta.icon } : meta.icon, toolRowLabel(name), "tool", toolSubtitle(name, input))
  const category = timelineCategory(name)
  el.dataset.timelineTool = toolRowLabel(name)
  if (!el.dataset.timelineItem) {
    el.classList.toggle("open", !timelinePreferences[category].collapse)
    appendTimeline(el, category)
  }
  return el
}

function actBody(key) {
  return actEls.get(key)?.querySelector(".act-body")
}

function actOut(key) {
  return actEls.get(key)?.querySelector(".act-out")
}

function actDone(key, ok = true) {
  const el = actEls.get(key)
  if (!el) return
  el.classList.add(ok ? "done" : "failed")
  el.querySelector(".act-state").textContent = ok ? "✓" : "✕"
  const group = el.closest(".timeline-group")
  if (group) updateTimelineGroup(group)
}

function actAppend(key, text) {
  const b = actBody(key)
  if (b) b.textContent = (b.textContent || "") + text
}

function clearActs() {
  actEls.clear()
  toolArgs.clear()
  toolNames.clear()
  reasoningEl = null
}

function addHarnessNote(title, detail = "", tone = "") {
  const box = $("messages")
  if (!box) return
  const el = document.createElement("div")
  el.className = `harness-note${tone ? ` ${tone}` : ""}`
  const strong = document.createElement("strong")
  strong.textContent = String(title || "VibeCore")
  el.appendChild(strong)
  if (detail) el.appendChild(document.createTextNode(` · ${String(detail)}`))
    appendTimeline(el, "notices")
  scrollChat()
}

/* ---------- permission requests ---------- */
const permEls = new Map()
const permSeen = new Set()

function permissionScope(action) {
  if (action === "external_directory") return "Outside workspace"
  if (action === "bash") return "Command"
  if (["write", "edit", "multiedit", "apply_patch"].includes(action)) return "File change"
  if (["read", "list", "grep", "glob"].includes(action)) return "Read-only"
  if (String(action || "").startsWith("browser")) return "Browser"
  if (["connector", "mcp"].includes(action)) return "Connector"
  return "Action"
}

async function refreshPermissionRequests() {
  const res = await vibe.listPermissionRequests()
  const list = res.ok ? (Array.isArray(res.data) ? res.data : (res.data?.data ?? [])) : []
  const pending = list.filter((p) => p && p.id && p.sessionID === state.activeSessionID)
  for (const p of pending) {
    if (!p.id) continue
    if (permSeen.has(p.id)) continue
    permSeen.add(p.id)
    const el = document.createElement("div")
    el.className = "perm-card"
    el.innerHTML = `
      <div class="perm-title">🔐 Permission required</div>
      <div class="perm-scope"></div>
      <div class="perm-action"></div>
      <div class="perm-res"></div>
      <div class="perm-actions">
        <button class="save-btn" data-d="once">Allow once</button>
        <button class="save-btn ghost" data-d="always">Always allow</button>
        <button class="danger-btn" data-d="reject">Reject</button>
      </div>`
    el.querySelector(".perm-action").textContent = `${p.action || "action"}`
    el.querySelector(".perm-scope").textContent = permissionScope(p.action)
    el.querySelector(".perm-res").textContent =
      (Array.isArray(p.resources) ? p.resources.join(", ") : p.resource) || ""
    // One-shot actions (e.g. browser JS, or an origin that is not known yet)
    // must not offer a blanket "Always allow".
    if (p.neverPersist) {
      const always = el.querySelector('[data-d="always"]')
      if (always) always.remove()
    } else if (Array.isArray(p.remembers) && p.remembers.some((r) => String(r).endsWith(" …"))) {
      // "Always allow" remembers a command family (git commit …), not only this exact text.
      const always = el.querySelector('[data-d="always"]')
      const what = p.remembers.join(", ")
      if (always) always.title = `Always allow: ${what}`
      const note = document.createElement("div")
      note.className = "perm-remember"
      note.textContent = `Always allow remembers: ${what}`
      el.querySelector(".perm-actions")?.after(note)
    }
    // The agent is blocked -> tell the user, even if the app is in the background
    notifyAgent(
      "Permission needed",
      `${p.action || "action"} — ${(Array.isArray(p.resources) ? p.resources.join(", ") : p.resource) || "the agent is waiting"}`,
    )
    el.querySelectorAll(".perm-actions button").forEach((b) => {
      b.onclick = async () => {
        const decision = b.dataset.d
        const r = await vibe.replyPermission({
          sessionID: p.sessionID,
          requestID: p.id,
          decision,
        })
        if (r.ok) {
          el.classList.add("resolved")
          el.querySelector(".perm-actions").remove()
          el.querySelector(".perm-title").textContent =
            decision === "reject" ? "🚫 Rejected" : "✅ Allowed (" + decision + ")"
          setTimeout(() => el.remove(), 2500)
        } else {
          alert("Permission reply fail: " + (r.error || ""))
        }
        permEls.delete(p.id)
      }
    })
    $("messages").appendChild(el)
    permEls.set(p.id, el)
    scrollChat()

    // Full Access mode -> auto approve everything, except risky Computer Use
    // actions (send, delete, install, pay...), which always need a click.
    if (pillState.access === "full" && !p.critical) {
      await vibe.replyPermission({ sessionID: p.sessionID, requestID: p.id, decision: "always" })
      el.querySelector(".perm-title").textContent = "✅ Auto-approved (Full Access)"
      el.querySelector(".perm-actions").remove()
      setTimeout(() => el.remove(), 2000)
      permEls.delete(p.id)
    }
  }
}

/* ---------- model questions (question tool -> session forms) ---------- */
const qCards = new Map() // formID -> element
const qSeen = new Set()

const Q_MULTI = "multiselect"

function qAnswerLabel(v) {
  if (Array.isArray(v)) return v.join(", ")
  if (v === true) return "Yes"
  if (v === false) return "No"
  return String(v ?? "")
}

function questionCardEl(form) {
  const el = document.createElement("div")
  el.className = "q-card"
  el.dataset.formID = form.id

  const head = document.createElement("div")
  head.className = "q-head"
  head.innerHTML = `<span class="q-ic">❓</span><span class="q-head-title"></span><span class="q-badge">waiting</span>`
  head.querySelector(".q-head-title").textContent = form.title || "Question"
  el.appendChild(head)

  const body = document.createElement("div")
  body.className = "q-body"
  el.appendChild(body)

  const fields = (Array.isArray(form.fields) ? form.fields : []).filter((f) => f && !f.hidden)
  const readers = [] // { key, read() }
  el._titles = new Map(fields.map((f) => [f.key, f.title || f.key]))

  for (const f of fields) {
    const box = document.createElement("div")
    box.className = "q-field"
    box.dataset.key = f.key

    // One question: its header is already the card's title, do not repeat it.
    const fieldTitle = f.title || f.key
    if (!(fields.length === 1 && fieldTitle === (form.title || "Question"))) {
      const title = document.createElement("div")
      title.className = "q-title"
      title.textContent = fieldTitle
      box.appendChild(title)
    }

    if (f.description) {
      const desc = document.createElement("div")
      desc.className = "q-desc"
      desc.textContent = f.description
      box.appendChild(desc)
    }

    // selected option values (or a parsed number/boolean)
    const val = { chosen: [], custom: null, input: null }
    const opts = Array.isArray(f.options) ? f.options : []
    let wrap = null

    if (opts.length) {
      if (f.type === Q_MULTI) {
        const hint = document.createElement("div")
        hint.className = "q-multi-hint"
        hint.textContent = "Pick one or more"
        box.appendChild(hint)
      }
      wrap = document.createElement("div")
      wrap.className = "q-opts" + (f.type === Q_MULTI ? " multi" : "")
      for (const o of opts) {
        const value = o.value ?? o.label
        const b = document.createElement("button")
        b.type = "button"
        b.className = "q-opt"
        b.dataset.value = value
        const lbl = document.createElement("span")
        lbl.className = "q-opt-label"
        lbl.textContent = o.label ?? value
        b.appendChild(lbl)
        if (o.description) {
          const d = document.createElement("span")
          d.className = "q-opt-desc"
          d.textContent = o.description
          b.appendChild(d)
        }
        b.onclick = () => {
          if (f.type === Q_MULTI) {
            const i = val.chosen.indexOf(value)
            if (i >= 0) val.chosen.splice(i, 1)
            else val.chosen.push(value)
            b.classList.toggle("on", i < 0)
          } else {
            val.chosen = [value]
            wrap.querySelectorAll(".q-opt").forEach((x) => x.classList.toggle("on", x === b))
          }
          if (val.input) val.input.value = ""
          val.custom = null
          updateFoot()
        }
        wrap.appendChild(b)
      }
      box.appendChild(wrap)
    }

    if (f.type === "boolean") {
      wrap = document.createElement("div")
      wrap.className = "q-opts"
      for (const [txt, boolVal] of [["Yes", true], ["No", false]]) {
        const b = document.createElement("button")
        b.type = "button"
        b.className = "q-opt"
        const lbl = document.createElement("span")
        lbl.className = "q-opt-label"
        lbl.textContent = txt
        b.appendChild(lbl)
        b.onclick = () => {
          val.chosen = [boolVal]
          wrap.querySelectorAll(".q-opt").forEach((x) => x.classList.toggle("on", x === b))
          updateFoot()
        }
        wrap.appendChild(b)
      }
      box.appendChild(wrap)
    } else if (f.type === "integer" || f.type === "number") {
      const inp = document.createElement("input")
      inp.className = "q-custom"
      inp.type = "number"
      if (f.minimum !== undefined) inp.min = f.minimum
      if (f.maximum !== undefined) inp.max = f.maximum
      inp.oninput = () => updateFoot()
      val.input = inp
      box.appendChild(inp)
    } else if (f.custom === true || (!opts.length && f.type === "string")) {
      // "type your own answer" (the question tool sets custom: true)
      const inp = document.createElement("input")
      inp.className = "q-custom"
      inp.type = "text"
      inp.placeholder = opts.length ? "Or type your own answer…" : f.placeholder || "Type your answer…"
      inp.oninput = () => {
        val.custom = inp.value
        if (inp.value.trim()) {
          val.chosen = []
          wrap?.querySelectorAll(".q-opt").forEach((x) => x.classList.remove("on"))
        }
        updateFoot()
      }
      val.input = inp
      box.appendChild(inp)
    }

    readers.push({
      key: f.key,
      read() {
        if (f.type === "boolean") return val.chosen.length ? val.chosen[0] : undefined
        if (val.input && (f.type === "integer" || f.type === "number")) {
          const n = Number(val.input.value)
          if (val.input.value === "" || Number.isNaN(n)) return undefined
          return f.type === "integer" ? Math.trunc(n) : n
        }
        const custom = String(val.custom ?? "").trim()
        if (custom) return f.type === Q_MULTI ? [...val.chosen, custom] : custom
        if (f.type === Q_MULTI) return val.chosen.slice()
        return val.chosen[0]
      },
    })

    body.appendChild(box)
  }

  const foot = document.createElement("div")
  foot.className = "q-foot"
  foot.innerHTML = `
    <button class="save-btn q-submit" type="button">Answer</button>
    <button class="danger-btn q-dismiss" type="button">Dismiss</button>
    <span class="q-hint"></span>`
  el.appendChild(foot)

  const submit = foot.querySelector(".q-submit")
  const dismiss = foot.querySelector(".q-dismiss")
  const hint = foot.querySelector(".q-hint")

  function readAnswer() {
    const answer = {}
    for (const r of readers) {
      const v = r.read()
      if (v === undefined || v === null || v === "") continue
      if (Array.isArray(v) && v.length === 0) continue
      answer[r.key] = v
    }
    return answer
  }

  function updateFoot() {
    submit.disabled = Object.keys(readAnswer()).length === 0
    hint.textContent = ""
  }

  submit.onclick = async () => {
    const answer = readAnswer()
    if (!Object.keys(answer).length) {
      hint.textContent = "Pick an option or write your own answer"
      return
    }
    submit.disabled = true
    hint.textContent = "Sending…"
    const r = await vibe.replyForm({
      sessionID: form.sessionID || state.activeSessionID,
      formID: form.id,
      answer,
    })
    if (r.ok) settleQuestionCard(el, "answered", answer)
    else {
      submit.disabled = false
      hint.textContent = "⚠ " + (r.error || "Could not send the answer")
    }
  }

  dismiss.onclick = async () => {
    dismiss.disabled = true
    const r = await vibe.cancelForm({
      sessionID: form.sessionID || state.activeSessionID,
      formID: form.id,
      message: "User dismissed the question",
    })
    if (r.ok) settleQuestionCard(el, "dismissed")
    else {
      dismiss.disabled = false
      hint.textContent = "⚠ " + (r.error || "Could not dismiss the question")
    }
  }

  updateFoot()
  return el
}

function settleQuestionCard(el, kind, answer) {
  if (!el || el.classList.contains("settled")) return
  el.classList.add("settled", kind)
  const badge = el.querySelector(".q-badge")
  if (badge) badge.textContent = kind === "answered" ? "answered" : "dismissed"
  // the inputs are done — keep only the question + the chosen answer
  el.querySelectorAll(".q-opts").forEach((n) => n.remove())
  el.querySelectorAll(".q-custom, .q-multi-hint").forEach((n) => n.remove())
  el.querySelector(".q-foot")?.remove()
  // Several questions answered: the recap lists "question header: answer"
  // only, instead of every question text and then every answer again.
  if (kind === "answered" && answer && el.querySelectorAll(".q-field").length > 1) el.classList.add("compact")
  if (kind === "answered" && answer) {
    const keys = Object.keys(answer)
    const titles = el._titles || new Map()
    const sum = document.createElement("div")
    sum.className = "q-summary"
    for (const k of keys) {
      const row = document.createElement("div")
      row.className = "q-sum-row"
      if (keys.length > 1) {
        const key = document.createElement("span")
        key.className = "q-sum-key"
        key.textContent = titles.get(k) || k
        row.appendChild(key)
      }
      const val = document.createElement("span")
      val.className = "q-sum-val"
      val.textContent = qAnswerLabel(answer[k])
      row.appendChild(val)
      sum.appendChild(row)
    }
    el.appendChild(sum)
  }
  // Answered or dismissed: the card leaves the box above the composer and
  // stays in the chat as a short recap of the question and the answer.
  if (el.classList.contains("q-docked")) {
    el.classList.remove("q-docked")
    el.querySelectorAll(".q-tabs, .q-step").forEach((n) => n.remove())
    el.querySelectorAll(".q-field").forEach((n) => { n.hidden = false })
    if (el.dataset.sessionId === state.activeSessionID && !state.subagentView) {
      $("messages").appendChild(el)
      scrollChat()
    } else el.remove()
    renderQuestionDock()
  }
}

/* The box above the composer: the active chat's first open question card,
   one question at a time (tabs + Back / Next when there are several). */
function dockQuestionCard(el) {
  const fields = [...el.querySelectorAll(".q-field")]
  const foot = el.querySelector(".q-foot")
  const submit = foot?.querySelector(".q-submit")
  if (!fields.length || !foot || !submit) return
  el.classList.add("q-docked")
  const head = el.querySelector(".q-head")
  const step = document.createElement("span")
  step.className = "q-step"
  head.insertBefore(step, head.querySelector(".q-badge"))

  let tabs = null
  if (fields.length > 1) {
    tabs = document.createElement("div")
    tabs.className = "q-tabs"
    tabs.setAttribute("role", "tablist")
    fields.forEach((f, i) => {
      const t = document.createElement("button")
      t.type = "button"
      t.className = "q-tab"
      t.setAttribute("role", "tab")
      t.textContent = (el._titles && el._titles.get(f.dataset.key)) || `Question ${i + 1}`
      t.onclick = () => show(i)
      tabs.appendChild(t)
    })
    head.after(tabs)
  }

  const back = document.createElement("button")
  back.type = "button"
  back.className = "ghost-btn q-back"
  back.textContent = "← Back"
  const next = document.createElement("button")
  next.type = "button"
  next.className = "save-btn q-next"
  next.textContent = "Next →"
  foot.insertBefore(back, submit)
  foot.insertBefore(next, submit)
  // The buttons sit at the top, right under the title and tabs, and stay in
  // view while long options scroll: nobody has to scroll down to find Next.
  ;(tabs || head).after(foot)

  const answered = (f) => !!f.querySelector(".q-opt.on") || !!f.querySelector(".q-custom")?.value.trim()
  const markTabs = () => tabs?.querySelectorAll(".q-tab").forEach((t, i) => t.classList.toggle("done", answered(fields[i])))
  let at = 0
  function show(i) {
    at = Math.max(0, Math.min(fields.length - 1, i))
    fields.forEach((f, k) => { f.hidden = k !== at })
    tabs?.querySelectorAll(".q-tab").forEach((t, k) => {
      t.classList.toggle("on", k === at)
      t.setAttribute("aria-selected", k === at ? "true" : "false")
    })
    step.textContent = fields.length > 1 ? `${at + 1} of ${fields.length}` : ""
    const last = at === fields.length - 1
    back.hidden = at === 0
    next.hidden = last
    submit.hidden = !last
    markTabs()
  }
  back.onclick = () => show(at - 1)
  next.onclick = () => show(at + 1)
  fields.forEach((f, k) => {
    f.addEventListener("input", markTabs)
    f.addEventListener("click", (e) => {
      markTabs()
      // A single choice moves on to the next question by itself.
      if (e.target.closest(".q-opts:not(.multi) .q-opt") && k === at && k < fields.length - 1) setTimeout(() => { if (at === k) show(k + 1) }, 220)
    })
  })
  show(0)
}

function renderQuestionDock() {
  const dock = $("q-dock")
  if (!dock) return
  const sid = state.activeSessionID
  const card = [...qCards.values()].find((el) =>
    el.classList.contains("q-docked") && !el.classList.contains("settled") && el.dataset.sessionId === sid) || null
  if (dock.firstElementChild !== card) dock.replaceChildren(...(card ? [card] : []))
  dock.hidden = !card
}

async function refreshForms() {
  renderQuestionDock() // another chat: show only its own questions
  const listedSid = state.activeSessionID
  if (!listedSid) return
  const res = await vibe.listForms({ sessionID: listedSid })
  if (!res.ok || listedSid !== state.activeSessionID) return
  const list = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])
  const pending = new Set()
  for (const f of list) {
    if (!f || !f.id) continue
    pending.add(f.id)
    if (qSeen.has(f.id)) continue
    qSeen.add(f.id)
    const formSid = f.sessionID || state.activeSessionID
    const el = questionCardEl({ ...f, sessionID: formSid })
    el.dataset.sessionId = formSid
    dockQuestionCard(el)
    qCards.set(f.id, el)
    // The agent is waiting for an answer -> tell the user, even in background.
    const question = (f.questions && f.questions[0] && (f.questions[0].question || f.questions[0].text)) || ""
    notifyAgent("❓ The agent is asking you", question || "The agent needs an answer to continue.")
  }
  // a form that vanished without us answering was answered/cancelled elsewhere
  // (only this chat's forms were listed, so other chats' cards are left alone)
  for (const [id, el] of [...qCards]) {
    if (pending.has(id)) continue
    if (el.dataset.sessionId && el.dataset.sessionId !== listedSid) continue
    if (!el.classList.contains("settled")) settleQuestionCard(el, "dismissed")
    qCards.delete(id)
  }
  renderQuestionDock()
}

function questionHistoryEl(part) {
  const st = part.state ?? {}
  // Models sometimes send `questions` as a JSON string or a single object; never assume an array.
  const asList = (v) => {
    if (typeof v === "string") { try { v = JSON.parse(v) } catch { return v.trim() ? [{ question: v }] : [] } }
    if (Array.isArray(v)) return v.map((q) => (q && typeof q === "object" ? q : { question: String(q ?? "") }))
    return v && typeof v === "object" ? [v] : []
  }
  const questions = asList(st.input?.questions)
  if (!questions.length) return null
  const rawAnswers = st.metadata?.answers
  const answers = Array.isArray(rawAnswers) ? rawAnswers : (rawAnswers == null ? [] : [rawAnswers])
  const done = st.status === "completed"
  const el = document.createElement("div")
  el.className = "q-card history settled " + (done ? "answered" : "pending")
  const head = document.createElement("div")
  head.className = "q-head"
  head.innerHTML = `<span class="q-ic">❓</span><span class="q-head-title">Questions</span><span class="q-badge"></span>`
  head.querySelector(".q-badge").textContent = done ? "answered" : (st.status || "pending")
  el.appendChild(head)
  const body = document.createElement("div")
  body.className = "q-body"
  questions.forEach((q, i) => {
    const box = document.createElement("div")
    box.className = "q-field"
    const title = document.createElement("div")
    title.className = "q-title"
    title.textContent = q.header || `Question ${i + 1}`
    const desc = document.createElement("div")
    desc.className = "q-desc"
    desc.textContent = q.question || ""
    box.append(title, desc)
    const a = answers[i]
    const row = document.createElement("div")
    row.className = "q-sum-row"
    const key = document.createElement("span")
    key.className = "q-sum-key"
    key.textContent = "answer"
    const val = document.createElement("span")
    val.className = "q-sum-val"
    val.textContent = Array.isArray(a) && a.length ? a.join(", ") : "—"
    row.append(key, val)
    box.appendChild(row)
    body.appendChild(box)
  })
  el.appendChild(body)
  return el
}

