/* ---------- subagents (enable / disable the agents OpenCode offers) ---------- */
let agentList = []
let subAgentsById = new Map()
let subagentPoll = null
let subagentRenderSignature = ""

async function refreshSubagentIndex(sessionID) {
  if (!vibe.subagentList || !sessionID) return
  try {
    const res = await vibe.subagentList({ sessionID })
    if (!res || res.ok === false) return
    const list = res.data?.subagents || []
    for (const agent of list) subAgentsById.set(agent.id, agent)
    if (state.activeSessionID === sessionID && !state.subagentView) renderSessionHistory(sessionID)
  } catch {}
}

function subagentSignature(details) {
  const messages = Array.isArray(details?.messages) ? details.messages : []
  return JSON.stringify([details?.status, details?.result?.length || 0, details?.error, details?.liveText?.length || 0, messages.map((message) => [message.id, message.status, (message.content || []).length])])
}

function setSubagentHeader(details) {
  $("subagent-view-name").textContent = details.name || details.agent || details.type || "Subagent"
  $("subagent-view-task").textContent = `${details.type || "general"}${details.task ? ` · ${details.task}` : ""}`
  const status = details.status || "running"
  const badge = $("subagent-view-status")
  badge.textContent = status
  badge.className = `subagent-view-status ${status}`
  $("subagent-view-stop").hidden = status !== "running"
  $("subagent-send").disabled = status === "running"
  $("subagent-input").disabled = status === "running"
  $("subagent-input").placeholder = status === "running" ? "This subagent is still working…" : "Send a follow-up to this subagent…"
  // Own-workspace bar (Review / Merge / Discard) lives in crew-ui.js.
  try { if (typeof window.renderCrewWorkspace === "function") window.renderCrewWorkspace(details) } catch {}
}

function renderSubagentDetails(details) {
  if (!state.subagentView || state.subagentView.id !== details.id) return
  setSubagentHeader(details)
  renderHistoryMessages(Array.isArray(details.messages) ? details.messages : [], {
    editable: false,
    usageRing: false,
    retryRow: false,
    assistantName: details.name || "Subagent",
  })
  if (details.liveReasoning) addThought(details.liveReasoning, 0, true)
  if (details.liveText) {
    const bubble = addMsg("assistant", details.liveText)
    bubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
    state.subagentView.liveBubble = bubble
    state.subagentView.liveText = details.liveText
  } else {
    state.subagentView.liveBubble = null
    state.subagentView.liveText = ""
  }
  const serialized = JSON.stringify(details.messages || [])
  if (details.result && !serialized.includes(details.result)) {
    const result = addMsg("assistant", details.result)
    result.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
  }
  if (details.error) {
    const error = addMsg("assistant", `⚠ ${details.error}`, "thinking")
    error.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(details.name || "Subagent"))
  }
  scrollChat(true)
}

async function refreshSubagentView(force = false) {
  const view = state.subagentView
  if (!view || !vibe.subagentDetails) return
  const res = await vibe.subagentDetails({ id: view.id })
  if (!res || res.ok === false || !res.data) {
    if (force) showError("Could not open the subagent", res?.error || "Subagent not found", { key: "subagent-view" })
    return
  }
  const details = res.data
  subAgentsById.set(details.id, details)
  const signature = subagentSignature(details)
  if (force || signature !== subagentRenderSignature) {
    subagentRenderSignature = signature
    renderSubagentDetails(details)
  } else setSubagentHeader(details)
  updateSubagentCards(details)
}

async function openSubagentView(id) {
  if (!id) return
  clearInterval(subagentPoll)
  subagentRenderSignature = ""
  state.subagentView = { id, parentSessionID: state.activeSessionID, liveBubble: null, liveText: "" }
  $("subagent-viewbar").hidden = false
  $("subagent-composer").hidden = false
  $("composer").hidden = true
  $("todo-panel").hidden = true
  $("retry-inline").hidden = true
  setMainEmpty(false)
  await refreshSubagentView(true)
  subagentPoll = setInterval(() => refreshSubagentView(false).catch(() => {}), 1000)
}

function leaveSubagentView(renderParent = true) {
  clearInterval(subagentPoll)
  subagentPoll = null
  subagentRenderSignature = ""
  state.subagentView = null
  $("subagent-viewbar").hidden = true
  $("subagent-composer").hidden = true
  $("composer").hidden = false
  $("subagent-input").value = ""
  hideError("subagent-view")
  renderTodos()
  if (renderParent && state.activeSessionID) renderSessionHistory(state.activeSessionID)
}

function updateSubagentCards(details) {
  if (!details?.id) return
  const info = {
    id: details.id,
    sessionID: details.childSessionId,
    name: details.name,
    type: details.type,
    task: details.task,
    status: details.status,
    result: details.result,
    error: details.error,
  }
  document.querySelectorAll(`.act[data-subagent-id="${details.id}"]`).forEach((element) => syncSubagentCard(element, info))
}

function handleSubagentEvent(data) {
  const id = data.subagentId
  if (!id) return
  const current = subAgentsById.get(id) || { id, status: "running" }
  const eventType = data.eventType || ""
  const next = {
    ...current,
    id,
    childSessionId: data.subagentSessionId || current.childSessionId,
    parentToolCallId: data.parentToolCallId || current.parentToolCallId,
    name: data.subagentName || data.name || current.name || "Subagent",
    type: data.agentType || current.type || "general",
    task: data.task || current.task || "",
  }
  if (eventType === "subagent.start" || eventType === "subagent.resume") next.status = "running"
  if (eventType === "subagent.error") { next.status = "error"; next.error = data.error || "Subagent failed" }
  if (eventType === "subagent.end" || eventType === "subagent.result") {
    next.status = data.status || next.status || "done"
    if (data.result) next.result = data.result
    if (data.error) next.error = data.error
  }
  subAgentsById.set(id, next)
  const index = agentList.findIndex((agent) => agent.id === id)
  if (index >= 0) agentList[index] = { ...agentList[index], ...next }
  else agentList.unshift(next)
  updateSubagentCards(next)
  if (next.parentToolCallId) {
    const parentCard = actEls.get(`tool:${next.parentToolCallId}`)
    if (parentCard) syncSubagentCard(parentCard, {
      id: next.id,
      sessionID: next.childSessionId,
      name: next.name,
      type: next.type,
      task: next.task,
      status: next.status,
      result: next.result,
      error: next.error,
    })
  }
  if (index < 0 || ["subagent.start", "subagent.resume", "subagent.error", "subagent.end", "subagent.result"].includes(eventType)) renderAgentList()

  const view = state.subagentView
  if (!view || view.id !== id) return
  setSubagentHeader(next)
  if (eventType === "text.delta" && data.delta) {
    if (!view.liveBubble) {
      view.liveBubble = addMsg("assistant", "")
      view.liveBubble.closest(".msg")?.querySelector(".who")?.replaceChildren(document.createTextNode(next.name || "Subagent"))
      view.liveText = ""
    }
    view.liveText += String(data.delta)
    if (window.renderMarkdownInto) window.renderMarkdownInto(view.liveBubble, view.liveText)
    else view.liveBubble.textContent = view.liveText
    scrollChat()
    return
  }
  if (["tool.start", "tool.end", "subagent.start", "subagent.resume", "subagent.error", "subagent.end", "subagent.result", "done"].includes(eventType)) {
    setTimeout(() => refreshSubagentView(true).catch(() => {}), 50)
  }
}

async function sendSubagentFollowup() {
  const view = state.subagentView
  const input = $("subagent-input")
  const text = input.value.trim()
  if (!view || !text) return
  const res = await vibe.subagentResume({ id: view.id, text })
  if (!res || res.ok === false) {
    showError("Could not resume the subagent", res?.error || "Unknown error", { key: "subagent-view" })
    return
  }
  input.value = ""
  await refreshSubagentView(true)
}

$("subagent-back").onclick = () => leaveSubagentView(true)
$("subagent-view-stop").onclick = async () => {
  const id = state.subagentView?.id
  if (!id) return
  await vibe.subagentStop({ id })
  refreshSubagentView(true)
}
$("subagent-send").onclick = sendSubagentFollowup
$("subagent-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendSubagentFollowup() }
})

async function loadAgents() {
  if (!vibe.subagentList) return
  try {
    const [t, l] = await Promise.all([
      vibe.subagentToggle ? vibe.subagentToggle({}) : { data: { enabled: true } },
      vibe.subagentList({}),
    ])
    const enabled = t && t.ok === false ? true : (t.data && t.data.enabled !== undefined ? t.data.enabled : true)
    const toggle = $("subagent-toggle")
    if (toggle) {
      toggle.classList.toggle("on", enabled)
      toggle.setAttribute("aria-checked", enabled ? "true" : "false")
      toggle.onclick = async () => {
        const now = toggle.classList.contains("on")
        const res = await vibe.subagentToggle({ enabled: !now })
        toggle.classList.toggle("on", !now)
        toggle.setAttribute("aria-checked", !now)
      }
    }
    const res = l
    if (!res || res.ok === false) {
      showError("Could not load subagents", res?.error || "Unknown error", { key: "agents" })
      return
    }
    agentList = res.data?.subagents ?? []
    subAgentsById = new Map()
    for (const a of agentList) subAgentsById.set(a.id, a)
    renderAgentList()
  } catch (e) {
    showError("Could not load subagents", String(e), { key: "agents" })
  }
}

function renderAgentList() {
  const list = $("subagent-list")
  if (!list) return
  list.textContent = ""
  const box = $("subagent-count")
  if (box) box.textContent = agentList.length
  if (!agentList.length) {
    const empty = document.createElement("div")
    empty.className = "cfg-empty"
    empty.textContent = "No subagents yet."
    list.appendChild(empty)
    return
  }
  for (const a of agentList) {
    const row = document.createElement("div")
    row.className = "s-row"
    const main = document.createElement("div")
    main.className = "s-col"
    const name = document.createElement("div")
    name.className = "s-name"
    name.textContent = a.name || a.id
    const desc = document.createElement("div")
    desc.className = "s-desc"
    desc.textContent = `${a.type} · ${a.status}${a.task ? " — " + a.task.slice(0, 60) : ""}`
    main.append(name, desc)
    const right = document.createElement("div")
    right.className = "s-row-actions"
    const tag = document.createElement("span")
    tag.className = "cfg-tag"
    tag.textContent = a.type || "subagent"
    right.append(tag)
    row.append(main, right)
    row.classList.add("subagent-settings-row")
    row.title = "Open this subagent's conversation"
    row.onclick = () => openSubagentView(a.id)
    list.appendChild(row)
  }
}

/* ---------- browser use ---------- */
async function loadBrowserUse() {
  const btn = $("btn-browser-install")
  if (!btn || !vibe.builtins) return
  const res = await vibe.builtins({ directory: projectDir })
  const entry = (res.data?.mcp ?? []).find((m) => m.id === "playwright")
  const installed = !!entry?.installed
  // An install from an older build runs a visible Chrome window OUTSIDE the app.
  // The one browser of the app is the panel, so the agent's MCP is fixed to
  // --headless the first time this page is opened (only the playwright entry).
  let normalized = false
  if (installed && vibe.mcpList) {
    try {
      const list = await vibe.mcpList({ directory: projectDir })
      const cur = (list?.data?.mcp ?? []).find((s) => String(s.name).toLowerCase() === "playwright")
      const raw = Array.isArray(cur?.command)
        ? cur.command
        : typeof cur?.command === "string"
          ? cur.command.split(/\s+/)
          : null
      const useGlobal = cur?.scope === "global" ? true : !projectDir
      if (
        cur &&
        raw &&
        raw.some((a) => String(a).includes("@playwright/mcp")) &&
        !raw.some((a) => String(a) === "--headless")
      ) {
        const r = await vibe.mcpAdd({
          name: "playwright",
          type: "local",
          command: [...raw.map(String), "--headless"],
          directory: useGlobal ? null : projectDir,
          global: useGlobal,
        })
        normalized = !!r && r.ok !== false
      }
    } catch {}
  }
  btn.textContent = installed ? "Remove" : "Install"
  btn.classList.toggle("danger-btn", installed)
  btn.classList.toggle("save-btn", !installed)
  btn.onclick = async () => {
    btn.disabled = true
    btn.textContent = installed ? "Removing…" : "Installing…"
    try {
      if (installed) {
        const r = await vibe.mcpRemove({ name: "playwright", directory: projectDir, global: !projectDir })
        if (r && r.ok === false) throw new Error(r.error || "Could not remove the browser MCP")
      } else {
        const r = await vibe.mcpAdd({
          name: "playwright",
          type: "local",
          command: entry?.command ?? ["npx", "-y", "@playwright/mcp@latest", "--headless"],
          directory: projectDir,
          global: !projectDir,
        })
        if (r && r.ok === false) throw new Error(r.error || "Could not install the browser MCP")
      }
    } catch (e) {
      showError("Browser control", String(e && e.message ? e.message : e), { key: "browser" })
    } finally {
      btn.disabled = false
      await loadBrowserUse()
    }
  }
  if ($("browser-mcp-desc")) {
    $("browser-mcp-desc").textContent = installed
      ? "Installed — the agent can open pages, click, fill forms, read the DOM and take screenshots." +
        (normalized ? " Headless mode was switched on, so no browser window opens outside the app." : "")
      : "Real browser control: open pages, click buttons, fill forms, read the DOM and take screenshots. The first start downloads the Playwright browser (~150 MB)."
  }
}

/* ---------- persistent memory ---------- */
/* The app shows the memory file; the agent only writes into it when the user
   asks ("remember this"). The app never saves a fact on its own.
   them here so the user can see, add and remove them - and switch the whole
   thing on or off from this page. */
const MEMORY_KEY = "vibecoder.memory"
let memoryEntries = []

function memoryEnabled() {
  try {
    return localStorage.getItem(MEMORY_KEY) !== "off"
  } catch {
    return true
  }
}

function setMemoryEnabled(on) {
  try { localStorage.setItem(MEMORY_KEY, on ? "on" : "off") } catch {}
  // The rules the agent reads are refreshed right away, so the memory is
  // really gone (or back) for the next run.
  if (projectDir) ensureProjectAgent(projectDir)
  applyMemoryUi()
}

function applyMemoryUi() {
  const on = memoryEnabled()
  const toggle = $("toggle-memory")
  if (toggle) {
    toggle.classList.toggle("on", on)
    toggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  const input = $("memory-input")
  if (input) input.disabled = !on
  const add = $("btn-memory-add")
  if (add) add.disabled = !on
  const note = $("memory-off-note")
  if (note) note.hidden = on
  const list = $("memory-list")
  if (list && !on) {
    list.textContent = ""
    const off = document.createElement("div")
    off.className = "memory-empty"
    off.textContent = "Persistent memory is off — the agent does not read or write these notes."
    list.appendChild(off)
  }
}

async function loadMemory() {
  applyMemoryUi()
  if (!vibe.memoryList) return
  const res = await vibe.memoryList()
  if (!res || res.ok === false) {
    showError("Could not load the memory", res?.error || "Unknown error", { key: "memory" })
    return
  }
  memoryEntries = res.data?.entries ?? []
  const file = res.data?.path ?? ""
  if ($("memory-path")) $("memory-path").textContent = file
  if ($("memory-count")) {
    $("memory-count").textContent = memoryEntries.length
      ? `${memoryEntries.length} ${memoryEntries.length === 1 ? "memory" : "memories"} saved`
      : "Nothing saved yet."
  }
  renderMemoryList()
}

async function loadUsage() {
  console.log("[Usage] Loading usage data...")
  console.log("[Usage] vibe.getAllUsage exists:", !!vibe.getAllUsage)
  if (!vibe.getAllUsage) {
    console.warn("[Usage] getAllUsage not available")
    // Show fallback message
    const overview = $("usage-overview")
    if (overview) {
      overview.hidden = false
      const err = document.createElement("div")
      err.style.color = "var(--text-muted)"
      err.style.padding = "8px"
      err.textContent = "Usage API not available - run with --dev flag to debug"
      overview.appendChild(err)
    }
    return
  }
  
  try {
    const res = await vibe.getAllUsage()
    console.log("[Usage] Response:", JSON.stringify(res).substring(0, 500))
    
    if (!res || res.ok === false) {
      console.error("[BDCoder] Could not load usage:", res?.error || "Unknown error")
      const overview = $("usage-overview")
      if (overview) {
        overview.hidden = false
        const err = document.createElement("div")
        err.style.color = "red"
        err.style.padding = "8px"
        err.textContent = "Error: " + (res?.error || "Unknown error")
        overview.appendChild(err)
      }
      return
    }
    
    const data = res.data
    if (!data) {
      console.warn("[Usage] No data returned")
      return
    }
    
    // Handle double-wrapping: if data.data exists (IPC already wrapped), unwrap it
    const usageData = data.data || data
    
    console.log("[Usage] Data keys:", Object.keys(usageData))
    console.log("[Usage] Sessions count:", usageData.sessions?.length)
    console.log("[Usage] Total tokens:", usageData.totalTokens)
    
    if (!usageData.sessions) {
      console.error("[Usage] Invalid data structure:", usageData)
      return
    }
    
    // Show overview
    const overview = $("usage-overview")
    if (overview) {
      console.log("[Usage] Setting overview visible")
      overview.hidden = false
      
      // Update elements
      const tokensEl = $("usage-total-tokens")
      const costEl = $("usage-total-cost")
      const countEl = $("usage-session-count")
      
      console.log("[Usage] Elements found:", { tokens: !!tokensEl, cost: !!costEl, count: !!countEl })
      
      if (tokensEl) {
        const tokens = usageData.totalTokens || 0
        tokensEl.textContent = tokens >= 1e6 
          ? `${(tokens / 1e6).toFixed(2)}M` 
          : tokens >= 1e3 
            ? `${(tokens / 1e3).toFixed(1)}k`
            : tokens.toString()
        console.log("[Usage] Tokens set to:", tokensEl.textContent)
      }
      
      if (costEl) {
        const cost = usageData.totalCost || 0
        costEl.textContent = usageData.unknownCost && !cost ? "Unknown" : `$${cost.toFixed(6)}${usageData.unknownCost ? " + unknown" : ""}`
      }
      
      if (countEl) {
        const count = (usageData.sessions || []).length
        countEl.textContent = `${count} session${count !== 1 ? 's' : ''}`
      }
    }
    
    // Render session list
    const listEl = $("usage-session-list")
    if (listEl && usageData.sessions && usageData.sessions.length > 0) {
      const sessionsDiv = $("usage-sessions")
      if (sessionsDiv) sessionsDiv.hidden = false
      
      listEl.textContent = ""
      const sorted = [...usageData.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      
      for (const s of sorted) {
        const row = document.createElement("div")
        row.className = "s-row s-row-flat"
        
        const info = document.createElement("div")
        info.style.flex = "1"
        
        const title = document.createElement("div")
        title.className = "s-name"
        title.style.fontSize = "14px"
        title.textContent = s.title || "Untitled"
        
        const meta = document.createElement("div")
        meta.style.cssText = "font-size: 11px; color: var(--text-muted);"
        const date = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "-"
        const model = s.model || "unknown"
        meta.textContent = `${date} · ${model}`
        
        info.append(title, meta)
        
        const tokens = document.createElement("span")
        tokens.className = "s-count"
        tokens.style.textAlign = "right"
        const total = (s.totalInputTokens || 0) + (s.totalOutputTokens || 0)
        tokens.textContent = total >= 1e6 
          ? `${(total / 1e6).toFixed(1)}M` 
          : total >= 1e3 
            ? `${(total / 1e3).toFixed(1)}k`
            : total.toString()
        
        const cost = document.createElement("span")
        cost.className = "s-count"
        cost.style.cssText = "text-align: right; color: var(--accent);"
        cost.textContent = s.estimatedCost === null ? "Unknown" : `$${(s.estimatedCost || 0).toFixed(6)}`
        
        row.append(info, tokens, cost)
        listEl.appendChild(row)
      }
    }
  } catch (e) {
    console.error("[Usage] Exception:", e)
  }
}

function renderMemoryList() {
  const list = $("memory-list")
  if (!list) return
  list.textContent = ""
  if (!memoryEntries.length) {
    const empty = document.createElement("div")
    empty.className = "memory-empty"
    empty.textContent = "No memories yet. Tell the agent to remember something (or use the box above) — only you can add one."
    list.appendChild(empty)
    return
  }
  for (const m of memoryEntries) {
    const row = document.createElement("div")
    row.className = "memory-row"
    const text = document.createElement("div")
    text.className = "memory-text"
    text.textContent = m.text
    const date = document.createElement("div")
    date.className = "memory-date"
    date.textContent = m.date || ""
    const del = document.createElement("button")
    del.className = "danger-btn small"
    del.type = "button"
    del.textContent = "Remove"
    del.onclick = async () => {
      const res = await vibe.memoryRemove({ id: m.id, directory: projectDir, memory: memoryEnabled() })
      if (res && res.ok === false) {
        showError("Could not remove the memory", res.error || "Unknown error", { key: "memory" })
        return
      }
      memoryEntries = res.data?.entries ?? []
      renderMemoryList()
      if ($("memory-count")) $("memory-count").textContent = `${memoryEntries.length} saved`
    }
    row.append(text, date, del)
    list.appendChild(row)
  }
}

async function addMemory() {
  const input = $("memory-input")
  if (!input) return
  const text = input.value.trim()
  if (!text) return
  if (!memoryEnabled()) {
    showError("Persistent memory is off", "Turn it on in Settings > Memory first.", { key: "memory" })
    return
  }
  const res = await vibe.memoryAdd({ text, directory: projectDir, memory: true })
  if (res && res.ok === false) {
    showError("Could not save the memory", res.error || "Unknown error", { key: "memory" })
    return
  }
  hideError("memory")
  input.value = ""
  memoryEntries = res.data?.entries ?? []
  renderMemoryList()
  if ($("memory-count")) {
    $("memory-count").textContent = `${memoryEntries.length} ${memoryEntries.length === 1 ? "memory" : "memories"} saved`
  }
}

$("btn-memory-add")?.addEventListener("click", () => addMemory())
$("memory-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    addMemory()
  }
})
$("btn-memory-open")?.addEventListener("click", async () => {
  const res = await vibe.openMemoryFile()
  if (res && res.ok === false) alert(res.error || "Could not open the file")
})
/* ---------- Settings → Computer Use (one switch, on by default) ---------- */
function applyComputerUseUi(enabled, supported = true) {
  const t = $("toggle-computer-use")
  if (!t) return
  t.classList.toggle("on", !!enabled)
  t.setAttribute("aria-checked", enabled ? "true" : "false")
  if (!supported) {
    t.classList.add("disabled")
    const d = $("computer-use-desc")
    if (d) d.textContent = "Computer Use works on Windows."
  }
}
async function loadComputerUse() {
  if (typeof vibe.computerUseGet !== "function") return
  const r = await vibe.computerUseGet()
  if (r && r.ok !== false) applyComputerUseUi(r.data?.enabled ?? r.enabled, r.data?.supported ?? r.supported ?? true)
}
async function toggleComputerUse() {
  const t = $("toggle-computer-use")
  if (!t || t.classList.contains("disabled") || typeof vibe.computerUseSet !== "function") return
  const next = !t.classList.contains("on")
  applyComputerUseUi(next)
  const r = await vibe.computerUseSet({ enabled: next })
  if (r && r.ok === false) { applyComputerUseUi(!next); showError("Could not change Computer Use", r.error || "", { key: "computer-use" }) }
}
$("toggle-computer-use")?.addEventListener("click", () => { void toggleComputerUse() })
$("toggle-computer-use")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void toggleComputerUse() }
})
void loadComputerUse().catch(() => {})

$("toggle-memory")?.addEventListener("click", () => {
  setMemoryEnabled(!memoryEnabled())
})
$("toggle-memory")?.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault()
    setMemoryEnabled(!memoryEnabled())
  }
})

/* ---------- themed dialogs ---------- */
/* The native alert()/await showConfirm() popups are white and do not match the app.
   Everything now goes through this dark dialog. */
let dlgResolve = null
let dlgMode = "confirm" // "confirm" | "prompt"

function closeDialog(result) {
  const dlg = $("app-dialog")
  if (!dlg) return
  const input = $("dlg-input")
  dlg.hidden = true
  if (input) input.hidden = true
  const resolve = dlgResolve
  dlgResolve = null
  if (!resolve) return
  if (dlgMode === "prompt") {
    // the text of the field (or null when it was cancelled)
    const value = result === true ? (input ? input.value : "") : null
    dlgMode = "confirm"
    resolve(value)
    return
  }
  resolve(result)
}

function showDialog({
  title = "BDCoder AI",
  message = "",
  okText = "OK",
  cancelText = "Cancel",
} = {}) {
  const dlg = $("app-dialog")
  if (!dlg) return Promise.resolve(true)
  if (dlgResolve) closeDialog(false) // only one dialog at a time
  dlgMode = "confirm"
  const input = $("dlg-input")
  if (input) input.hidden = true
  $("dlg-title").textContent = title
  $("dlg-message").textContent = message
  $("dlg-ok").textContent = okText
  const cancel = $("dlg-cancel")
  cancel.textContent = cancelText
  cancel.hidden = !cancelText
  dlg.hidden = false
  $("dlg-ok").focus()
  return new Promise((resolve) => {
    dlgResolve = resolve
  })
}

/* A themed text field (the native prompt() does not exist in Electron). */
function showPrompt({
  title = "BDCoder AI",
  message = "",
  defaultValue = "",
  okText = "OK",
  cancelText = "Cancel",
} = {}) {
  const dlg = $("app-dialog")
  const input = $("dlg-input")
  if (!dlg || !input) return Promise.resolve(null)
  if (dlgResolve) closeDialog(false)
  dlgMode = "prompt"
  $("dlg-title").textContent = title
  $("dlg-message").textContent = message
  $("dlg-ok").textContent = okText
  const cancel = $("dlg-cancel")
  cancel.textContent = cancelText
  cancel.hidden = !cancelText
  input.hidden = false
  input.value = defaultValue ?? ""
  dlg.hidden = false
  // The browser gives the focus back to the button that was clicked AFTER this
  // handler runs, so focusing synchronously lost the caret: typing then went
  // nowhere and Enter re-clicked the ✎ button (rename looked like it did
  // nothing). Focus again after paint, and once more shortly after.
  focusDialogInput()
  requestAnimationFrame(focusDialogInput)
  setTimeout(focusDialogInput, 60)
  return new Promise((resolve) => {
    dlgResolve = resolve
  })
}

function focusDialogInput() {
  const input = $("dlg-input")
  if (!input || input.hidden) return
  try {
    input.focus({ preventScroll: true })
    input.select()
  } catch {}
}

async function showAlert(message, title = "BDCoder AI") {
  return showDialog({ title, message, okText: "OK", cancelText: null })
}

async function showConfirm(message, title = "BDCoder AI", okText = "OK") {
  return showDialog({ title, message, okText, cancelText: "Cancel" })
}

$("dlg-ok")?.addEventListener("click", () => closeDialog(true))
$("dlg-cancel")?.addEventListener("click", () => closeDialog(false))
$("dlg-x")?.addEventListener("click", () => closeDialog(false))
$("app-dialog")?.addEventListener("click", (e) => {
  if (e.target.id === "app-dialog") closeDialog(false)
})
// Enter in the text field confirms, Escape cancels
$("dlg-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    e.stopPropagation()
    closeDialog(true)
  } else if (e.key === "Escape") {
    e.preventDefault()
    e.stopPropagation()
    closeDialog(false)
  }
})
document.addEventListener("keydown", (e) => {
  if (!dlgResolve) return
  if (e.key === "Escape") {
    closeDialog(false)
    return
  }
  // Enter confirms a prompt even when the caret is not in the field (right
  // after opening, the focus can still be on the button that opened it).
  if (e.key === "Enter" && dlgMode === "prompt" && document.activeElement !== $("dlg-input")) {
    e.preventDefault()
    closeDialog(true)
  }
})

// the native alert() is replaced by the themed one (the calls stay the same)
window.alert = (message) => {
  showAlert(String(message ?? ""))
}
// safety net: if a native confirm() is ever used, it shows the themed dialog
// and does nothing until the code is converted (never a white popup).
window.confirm = (message) => {
  showDialog({ title: "BDCoder AI", message: String(message ?? ""), okText: "OK", cancelText: "Cancel" })
  return false
}

/* ---------- the task list (the plan of the agent) ---------- */
/* The agent writes its plan with the todowrite tool; the app mirrors it in a
   compact strip right below the Running chip (green check = done, arrow opens
   the details: what is finished and what is still left) and keeps it on disk,
   so the work is not lost when the app is closed. */
const TODO_OPEN_KEY = "vibecoder.todoOpen"
const todoState = { items: [], hidden: false, open: readTodoOpen() }

function readTodoOpen() {
  try {
    return localStorage.getItem(TODO_OPEN_KEY) === "1"
  } catch {
    return false
  }
}

async function loadTodos() {
  if (!vibe.todoList) return
  const res = await vibe.todoList()
  if (!res || res.ok === false) return
  const items = res.data?.items ?? []
  todoState.items = items
  // a list where everything is done is old news: do not pop up on every start,
  // the strip comes back as soon as the agent plans the next task
  if (items.length && items.every((t) => t.status === "completed" || t.status === "cancelled")) {
    todoState.hidden = true
  }
  renderTodos()
}

/** The strip sits right below the Running chip, or at the top when it is hidden. */
function placeTodoPanel(panel) {
  const job = $("bg-job")
  const under = !!(job && !job.hidden)
  panel.style.top = under ? "48px" : "12px"
}

/** Keep the strip glued under the Running chip when that chip appears/disappears. */
function syncTodoPosition() {
  const panel = $("todo-panel")
  if (panel && !panel.hidden) placeTodoPanel(panel)
}

function setTodoOpen(open) {
  todoState.open = !!open
  try {
    localStorage.setItem(TODO_OPEN_KEY, open ? "1" : "0")
  } catch {}
  renderTodos()
}

function renderTodos() {
  const panel = $("todo-panel")
  const list = $("todo-list")
  if (!panel || !list) return
  const items = todoState.items || []
  const done = items.filter((t) => t.status === "completed").length
  const open = items.filter((t) => t.status === "pending" || t.status === "in_progress").length
  const total = done + open
  if (!total || todoState.hidden) {
    panel.hidden = true
    return
  }
  panel.hidden = false
  placeTodoPanel(panel)
  panel.classList.toggle("collapsed", !todoState.open)
  panel.classList.toggle("open", todoState.open)
  const body = $("todo-body")
  if (body) body.hidden = !todoState.open
  const head = $("todo-toggle")
  if (head) head.setAttribute("aria-expanded", todoState.open ? "true" : "false")
  if ($("todo-count")) $("todo-count").textContent = `${done}/${total}`
  const left = $("todo-left")
  if (left) {
    left.textContent = open ? `${open} left` : "all done"
    left.classList.toggle("all-done", open === 0)
  }
  if ($("todo-note")) {
    $("todo-note").textContent = open
      ? `${done} done · ${open} left`
      : `${done} done · everything is finished`
  }
  list.textContent = ""
  // collapsed: the one-line strip is enough, the rows are built when it opens
  if (!todoState.open) return
  for (const t of items) {
    const row = document.createElement("div")
    row.className =
      "todo-item" +
      (t.status === "completed" ? " done" : "") +
      (t.status === "in_progress" ? " active" : "")
    const box = document.createElement("span")
    box.className = "tk-box"
    box.textContent = "✓"
    box.title = "Mark as done / not done"
    const text = document.createElement("span")
    text.className = "tk-text"
    text.textContent = t.content
    row.append(box, text)
    box.onclick = async () => {
      const next = t.status === "completed" ? "pending" : "completed"
      todoState.items = todoState.items.map((x) => (x.content === t.content ? { ...x, status: next } : x))
      renderTodos()
      await saveTodos()
    }
    list.appendChild(row)
  }
}

async function saveTodos() {
  if (!vibe.todoSave) return
  try {
    await vibe.todoSave({ items: todoState.items })
  } catch {}
}

function toggleTodos() {
  setTodoOpen(!todoState.open)
}

$("todo-toggle")?.addEventListener("click", (e) => {
  if (e.target.closest("#todo-close")) return
  toggleTodos()
})
$("todo-toggle")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault()
    toggleTodos()
  }
})
$("todo-close")?.addEventListener("click", (e) => {
  e.stopPropagation()
  todoState.hidden = true
  const p = $("todo-panel")
  if (p) p.hidden = true
})
$("todo-clear")?.addEventListener("click", async (e) => {
  e.stopPropagation()
  todoState.items = todoState.items.filter((t) => t.status !== "completed")
  renderTodos()
  await saveTodos()
})

/* ---------- owner verification ---------- */
/* The user proves that they own the app with a secret code. The agent is told
   about it, so it can trust owner-only instructions. */
const OWNER_CODE_KEY = "vibecoder.ownerVerified"

function ownerVerified() {
  try {
    return localStorage.getItem(OWNER_CODE_KEY) === "1"
  } catch {
    return false
  }
}

async function verifyOwner(code) {
  if (!code || !String(code).trim()) {
    showError("Owner code missing", "Type the owner code to verify.", { key: "owner" })
    return false
  }
  const res = await vibe.ownerVerify({ code: String(code), directory: projectDir })
  if (!res || res.ok === false) {
    showError("Wrong owner code", res?.error || "That is not the owner code", { key: "owner" })
    return false
  }
  try { localStorage.setItem(OWNER_CODE_KEY, "1") } catch {}
  hideError("owner")
  renderOwnerBadge()
  notifyAgent("Owner verified", "The user proved that they are the owner of this app.", "progress")
  return true
}

function renderOwnerBadge() {
  // the owner state is not shown in the UI - only the agent is told about it
}

/**
 * The owner code: the user types the secret code word in the chat. The app
 * checks it, marks the user as the verified owner and REDACTS the code from
 * the message, so the model never sees it (not even in the next turn).
 */
async function checkOwnerCode(text) {
  if (!vibe.ownerScan) return { text, found: false }
  let scan = null
  try {
    scan = await vibe.ownerScan({ text: String(text ?? "") })
  } catch {
    return { text, found: false }
  }
  if (!scan || !scan.found) return { text, found: false }
  // it matched the stored hash -> the user is the owner
  try { localStorage.setItem(OWNER_CODE_KEY, "1") } catch {}
  renderOwnerBadge()
  notifyAgent("Owner verified", "The user proved that they are the owner of this app.", "progress")
  showError("Owner verified", "You are verified as the owner of this app.", { key: "owner" })
  setTimeout(() => hideError("owner"), 4000)
  return { text: scan.redacted ?? text, found: true }
}

$("owner-form")?.addEventListener("submit", async (e) => {
  e.preventDefault()
  const input = $("owner-input")
  if (!input) return
  const ok = await verifyOwner(input.value)
  if (ok) input.value = ""
})

$("btn-owner-verify")?.addEventListener("click", async () => {
  const input = $("owner-code")
  if (!input) return
  const ok = await verifyOwner(input.value)
  if (ok) input.value = ""
})
$("owner-code")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault()
    $("btn-owner-verify")?.click()
  }
})

