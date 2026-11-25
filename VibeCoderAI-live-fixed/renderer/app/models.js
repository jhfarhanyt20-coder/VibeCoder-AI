/**
 * One icon style for every provider: a small rounded tile with two letters
 * taken from the name (OpenAI → OA, Google Gemini → GG, agness → AG). The same
 * look everywhere, no third-party logos.
 */
function provMonogram(name) {
  const clean = String(name || "").replace(/\(.*?\)/g, " ").replace(/[^A-Za-z0-9 ]+/g, " ").trim()
  const skip = /^(ai|api|the|inc|llc)$/i
  const words = clean.split(/\s+/).filter((w) => w && !skip.test(w))
  if (!words.length) return "?"
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  const w = words[0]
  const caps = w.replace(/[^A-Z0-9]/g, "")
  if (caps.length >= 2) return caps.slice(0, 2)
  return w.slice(0, 2).toUpperCase()
}
function setProvIcon(el, name) {
  el.classList.add("mono")
  el.textContent = provMonogram(name)
  el.setAttribute("aria-hidden", "true")
}

/* ---------- model picker (searchable) ---------- */
state.models = []
state.selectedModel = null
// A model the user just picked that the engine has not adopted yet (for example
// in a new task, before a session exists). It wins over the engine's older saved
// choice until a session confirms it, so the first message uses the picked model.
state.pendingModelPick = null
state.modelMenuOpen = false
let modelLoadGeneration = 0
let providerLoadGeneration = 0
let providerRefreshGeneration = 0

function modelDisplayLabel(key) {
  const row = (state.models || []).find((model) => `${model.providerID}/${model.id}` === key)
  if (!row) return "Select model"
  if (row.isGroup) {
    const models = Array.isArray(row.groupModels) ? row.groupModels : []
    const cursor = Math.min(Math.max(0, Number(row.groupCursor) || 0), Math.max(0, models.length - 1))
    const activeKey = row.activeModel || models[cursor]
    const active = activeKey ? activeKey.split("/").slice(1).join("/") : ""
    return active ? `${row.name || "Fallback model"} · ${active}` : (row.name || "Fallback model")
  }
  const provider = (providerState.list || []).find((item) => item.id === row.providerID)
  const modelName = row.name || row.id
  return provider?.name ? `${provider.name} · ${modelName}` : modelName
}

function applyProviderCatalog(data) {
  // Context sizes may have changed in Model settings: re-read them for the ring.
  ctxLimitsStale = true // keep showing the old numbers until the fresh ones arrive (no flicker)
  setTimeout(() => { try { loadCtxLimits() } catch {} }, 0)
  if (!data || typeof data !== "object") return
  providerState.list = Array.isArray(data.custom) ? data.custom : []
  providerState.formats = Array.isArray(data.formats) ? data.formats : []
  state.models = Array.isArray(data.models) ? data.models : []
  state.providerSource = data.source || null

  const storageHint = $("pf-storage-hint")
  if (storageHint && data.source) {
    storageHint.textContent = `Profiles: ${data.source.profilesFile || "local profiles.json"} · API keys: ${data.source.authFile || "local auth.json"}. Provider changes are read from these files; secrets are never included in refresh events.`
  }

  // Keep a cached model only when it still exists in the authoritative catalog.
  let cached = null
  try { cached = localStorage.getItem("vibecoder.model") || null } catch {}
  const valid = (key) => !!key && state.models.some((m) => `${m.providerID}/${m.id}` === key)
  const serverSelection = valid(data.selectedModel) ? data.selectedModel : null
  // The server's persisted choice is canonical. Local selection is retained
  // only while that exact provider/model pair exists in the fresh disk catalog.
  const previousSelection = valid(state.selectedModel) ? state.selectedModel : null
  const cachedSelection = valid(cached) ? cached : null
  const pickedSelection = valid(state.pendingModelPick) ? state.pendingModelPick : null
  state.selectedModel = pickedSelection || serverSelection || previousSelection || cachedSelection || null
  if (cached && !valid(cached)) {
    try { localStorage.removeItem("vibecoder.model") } catch {}
  }
  if (state.selectedModel) {
    try { localStorage.setItem("vibecoder.model", state.selectedModel) } catch {}
  } else {
    try { localStorage.removeItem("vibecoder.model") } catch {}
  }
  const label = $("model-label")
  if (label) label.textContent = state.selectedModel ? modelDisplayLabel(state.selectedModel) : "Select model"
  renderCompactionModels()
}

async function loadModels() {
  const generation = ++modelLoadGeneration
  let res

  if (typeof vibe.providerCatalog === "function") {
    res = await vibe.providerCatalog()
    if (generation !== modelLoadGeneration) return state.models
    if (!res || res.ok === false) {
      showError("Could not refresh providers and models", res?.error || "Unknown error", { key: "models" })
      return state.models
    }
    applyProviderCatalog(res.data || {})
  } else {
    // Compatibility with older preload bundles.
    try { await loadProviders({ silent: true }) } catch {}
    res = await vibe.listAllModels()
    if (generation !== modelLoadGeneration) return state.models
    if (res && res.ok === false) {
      showError("Could not load the model list", res.error || "Unknown error", { key: "models" })
      return state.models
    }
    const list = Array.isArray(res?.data)
      ? res.data
      : (Array.isArray(res?.data?.models)
          ? res.data.models
          : (Array.isArray(res?.models) ? res.models : []))
    state.models = list
    if (!state.selectedModel) {
      try { state.selectedModel = localStorage.getItem("vibecoder.model") || null } catch {}
    }
    if (state.selectedModel && !state.models.some((m) => `${m.providerID}/${m.id}` === state.selectedModel)) {
      state.selectedModel = null
      try { localStorage.removeItem("vibecoder.model") } catch {}
    }
    const label = $("model-label")
    if (label) label.textContent = state.selectedModel ? modelDisplayLabel(state.selectedModel) : "Select model"
  }

  hideError("models")
  updateUsageRing()
  loadCtxLimits()
  if (state.modelMenuOpen) renderModelList(modelSearch?.value || "")
  renderCompactionModels()
  return state.models
}

function renderModelList(filter = "") {
  const box = document.getElementById("model-results")
  box.innerHTML = ""
  const q = filter.trim().toLowerCase()
  // The custom providers the app knows (id -> name, on/off state, models).
  const custom = new Map((providerState.list || []).map((p) => [p.id, p]))
  const hits = state.models.filter((m) => {
    const cp = custom.get(m.providerID)
    if (cp) {
      // A custom provider that is switched off offers nothing. Its current model
      // IDs are authoritative: never show stale rows deleted from profiles.json.
      if (cp.disabled) return false
      const added = (cp.models || []).some((x) => String(x.id) === String(m.id))
      if (!added) return false
    } else if (!m.isBuiltin) {
      // A row without a current custom provider record is stale. Do not let a
      // deleted provider linger just because an older renderer snapshot survived.
      return false
    } else if (!m.hasKey) {
      // Keep built-ins out of the picker until credentials/no-auth configuration
      // exists; configured custom providers are listed first by the backend.
      return false
    }
    if (!q) return true
    return (
      m.id.toLowerCase().includes(q) ||
      m.providerID.toLowerCase().includes(q) ||
      `${m.providerID}/${m.id}`.toLowerCase().includes(q) ||
      // the display name of a custom provider is searchable too
      (custom.get(m.providerID)?.name || "").toLowerCase().includes(q) ||
      // and a model's own name (VibeCoder models: "NVIDIA Nemotron 3 Ultra")
      String(m.name || "").toLowerCase().includes(q)
    )
  })
  if (state.models.length === 0) {
    const d = document.createElement("div")
    d.className = "mr-loading"
    d.textContent = "Models will appear here after sign-in"
    box.appendChild(d)
    return
  }
  if (hits.length === 0) {
    const d = document.createElement("div")
    d.className = "mr-none"
    d.textContent = `No models found for "${filter}"`
    box.appendChild(d)
    return
  }
  const groups = new Map()
  for (const m of hits) {
    if (!groups.has(m.providerID)) groups.set(m.providerID, [])
    groups.get(m.providerID).push(m)
  }
  // Fallback model first, then the signed-in VibeCoder account's models, then
  // every other provider in the order the backend gave them.
  const groupRank = (id) => (id === "group" ? 0 : id === "vibecoder" ? 1 : 2)
  const orderedGroups = [...groups].map((g, i) => [g, i]).sort((a, b) => groupRank(a[0][0]) - groupRank(b[0][0]) || a[1] - b[1]).map(([g]) => g)
  for (const [providerID, models] of orderedGroups) {
    const g = document.createElement("div")
    g.className = "mr-group"
    // One provider heading; IDs stay on the model keys, not beside the name.
    const known = custom.get(providerID)
    g.textContent = providerID === "group" ? "Fallback model" : (known?.name || providerID)
    box.appendChild(g)
    for (const m of models) {
      const b = document.createElement("button")
      b.className = "mr-item"
      const key = `${m.providerID}/${m.id}`
      b.dataset.model = key
      if (state.selectedModel === key) b.classList.add("selected")
      // VibeCoder account models have opaque ids (vibecoder/free-3): show their real name.
      b.textContent = m.id === "fallback" && m.isGroup ? (m.name || "Fallback model") : (m.providerID === "vibecoder" && m.name ? m.name : m.id)
      // One clean line: the name, then small tags pushed to the right.
      const tagsEl = document.createElement("span")
      tagsEl.className = "mr-tags"
      b.appendChild(tagsEl)
      if (m.providerID === "vibecoder") b.title = Array.isArray(m.tags) && m.tags.length ? `${m.name} — ${m.tags.join(", ")}` : (m.name || m.id)
      if (m.isGroup) {
        const badge = document.createElement("span")
        badge.className = "mr-badge"
        badge.textContent = `${(m.groupModels || []).length} model${(m.groupModels || []).length === 1 ? "" : "s"}`
        badge.title = "Automatic failover: 429, server error or timeout moves to the next model"
        tagsEl.appendChild(badge)
        b.title = (m.groupModels || []).map((model, index) => `${index + 1}. ${model}`).join("\n")
      }
      if (m.free || key.toLowerCase().includes("free")) {
        const badge = document.createElement("span")
        badge.className = "mr-badge free"
        badge.textContent = "Free"
        tagsEl.appendChild(badge)
      }
      if (m.image) {
        // the model can see images: attaching a picture will actually reach it
        const badge = document.createElement("span")
        badge.className = "mr-badge vision"
        badge.textContent = "Vision"
        badge.title = "Can see images"
        tagsEl.appendChild(badge)
      }
      b.onclick = async () => {
        const previous = state.selectedModel
        state.selectedModel = key
        state.pendingModelPick = key
        $("model-label").textContent = modelDisplayLabel(key)
        updateUsageRing()
        try {
          localStorage.setItem("vibecoder.model", key)
        } catch {}
        closeAllMenus()
        renderModelList()
        // Don't leave the UI pointing at a model that the session failed to adopt.
        if (state.activeSessionID) {
          try {
            const switched = await vibe.setModel({
              sessionID: state.activeSessionID,
              model: { providerID: m.providerID, id: m.id },
            })
            if (!switched || switched.ok === false) throw new Error(switched?.error || "Model switch failed")
            const canonical = switched.data?.selectedModel
            if (canonical && state.models.some((item) => `${item.providerID}/${item.id}` === canonical)) {
              state.selectedModel = canonical
              try { localStorage.setItem("vibecoder.model", canonical) } catch {}
              $("model-label").textContent = modelDisplayLabel(canonical)
            }
            state.pendingModelPick = null // the session adopted it
            hideError("model-switch")
          } catch (err) {
            state.selectedModel = previous
            state.pendingModelPick = null
            try {
              if (previous) localStorage.setItem("vibecoder.model", previous)
              else localStorage.removeItem("vibecoder.model")
            } catch {}
            $("model-label").textContent = previous ? previous.split("/").slice(1).join("/") : "Select model"
            updateUsageRing()
            renderModelList()
            showError("Could not switch model", String(err?.message || err), { key: "model-switch" })
          }
        }
      }
      box.appendChild(b)
    }
  }
}

const modelMenu = document.getElementById("model-menu")
const modelSearch = document.getElementById("model-search")

$("btn-model").onclick = async (e) => {
  e.stopPropagation()
  const wasHidden = modelMenu.hidden
  closeAllMenus()
  if (wasHidden) {
    modelMenu.hidden = false
    // Always refresh: a provider that was just added (or switched off) has to
    // show up (or disappear) right away.
    await loadModels()
    if (typeof vibe.providerCatalog !== "function") await loadProviders({ silent: true })
    renderModelList(modelSearch.value)
    modelSearch.focus()
  }
}

modelSearch.oninput = () => renderModelList(modelSearch.value)
$("btn-model-refresh")?.addEventListener("click", async (e) => {
  e.stopPropagation()
  const btn = $("btn-model-refresh")
  btn.textContent = "…"
  try {
    await loadModels()
    if (typeof vibe.providerCatalog !== "function") await loadProviders({ silent: true })
    renderModelList(modelSearch.value)
  } finally {
    btn.textContent = "⟳"
  }
})

/* ---------- workspaces (projects) ---------- */
const WS_KEY = "vibecoder.workspaces"
const ACTIVE_PROJECT_KEY = "vibecoder.activeProject"
let workspaces = []

function loadWorkspaces() {
  try {
    workspaces = JSON.parse(localStorage.getItem(WS_KEY) || "[]")
  } catch {
    workspaces = []
  }
  // Drop cached branch names: the branch is always verified live now, and a
  // stale value (e.g. "master") used to show up for folders that are not repos.
  let changed = false
  for (const w of workspaces) {
    if (w && w.branch) {
      delete w.branch
      changed = true
    }
  }
  if (changed) {
    try { localStorage.setItem(WS_KEY, JSON.stringify(workspaces)) } catch {}
  }
  $("chip-branch").hidden = true
  renderWorkspaces()
}

function saveWorkspaces() {
  localStorage.setItem(WS_KEY, JSON.stringify(workspaces))
}

/** Write/refresh the agent + AGENTS.md rules for a project (temp cleanup, verify). */
function ensureProjectAgent(dir) {
  if (!dir || !vibe.ensureAgent) return
  const model = (() => {
    try {
      return localStorage.getItem("vibecoder.model") || ""
    } catch {
      return ""
    }
  })()
  Promise.resolve(vibe.ensureAgent({ directory: dir, memory: memoryEnabled(), model })).catch(() => {})
}

/** Remember the open project so MCP/plugin/skill pages survive a restart. */
function saveActiveProject(dir) {
  try {
    if (dir) localStorage.setItem(ACTIVE_PROJECT_KEY, dir)
    else localStorage.removeItem(ACTIVE_PROJECT_KEY)
  } catch {}
}

async function restoreActiveProject() {
  let dir = null
  try {
    dir = localStorage.getItem(ACTIVE_PROJECT_KEY)
  } catch {}

  // localStorage can be wiped (cache clear / different origin). The main
  // process keeps its own copy, so fall back to that.
  if (!dir && vibe.getDirectory) {
    try {
      const res = await vibe.getDirectory()
      if (res && res.ok && typeof res.data === "string" && res.data) dir = res.data
    } catch {}
  }

  if (!dir && workspaces.length === 1) dir = workspaces[0].dir
  if (!dir) return

  let ws = workspaces.find((w) => w.dir === dir)
  if (!ws) {
    // The saved folder is not in the sidebar yet (fresh install / cleared
    // storage) — add it instead of silently dropping the selection.
    ws = { dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir }
    workspaces.push(ws)
    saveWorkspaces()
  }

  saveActiveProject(ws.dir)
  projectDir = ws.dir
  $("chip-project-label").textContent = ws.name
  $("chip-project").title = ws.dir
  $("hero-title").textContent = `Start a new task in ${ws.name}`
  $("project-block").hidden = false
  $("workspace-name").textContent = ws.name
  renderWorkspaces()

  try {
    const res = await vibe.setDirectory(ws.dir)
    if (res && res.ok === false) console.warn("setDirectory failed:", res.error)
    ensureProjectAgent(ws.dir)
    await refreshSessions()
    resetActiveSessionForWorkspace()
  } catch (e) {
    console.warn("restore active project failed:", e)
  }
}

function renderWorkspaces() {
  const ul = $("workspace-list")
  ul.innerHTML = ""
  if (workspaces.length === 0) {
    const li = document.createElement("li")
    li.className = "workspace-empty"
    li.textContent = "No workspace yet — add one with ＋"
    ul.appendChild(li)
  }
  for (const ws of workspaces) {
    const li = document.createElement("li")
    li.dataset.dir = ws.dir
    if (ws.dir === projectDir) li.classList.add("active")

    const name = document.createElement("span")
    name.className = "ws-name"
    name.textContent = ws.name
    name.title = ws.dir

    const acts = document.createElement("span")
    acts.className = "ws-acts"
    const ren = document.createElement("button")
    ren.textContent = "✎"
    ren.title = "Rename"
    ren.onclick = async (e) => {
      e.stopPropagation()
      // Electron has no prompt() -> the themed dialog with a text field
      const nn = await showPrompt({
        title: "Rename workspace",
        message: "New workspace name:",
        defaultValue: ws.name,
        okText: "Save",
      })
      if (nn && nn.trim()) {
        ws.name = nn.trim()
        saveWorkspaces()
        renderWorkspaces()
        if (ws.dir === projectDir) $("workspace-name").textContent = ws.name
      }
    }
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "✕"
    del.title = "Delete"
    del.onclick = async (e) => {
      e.stopPropagation()
      if (!(await showConfirm(`Delete "${ws.name}"? The project folder stays on disk; only its list entry is removed.`))) return
      workspaces = workspaces.filter((w) => w.dir !== ws.dir)
      saveWorkspaces()
      if (projectDir === ws.dir) {
        projectDir = null
        saveActiveProject(null)
        $("chip-project-label").textContent = "Select project"
        $("chip-branch").hidden = true
        $("project-block").hidden = true
      }
      renderWorkspaces()
    }

    acts.append(ren, del)
    li.append(name, acts)
    li.onclick = async () => {
      projectDir = ws.dir
      saveActiveProject(ws.dir)
      $("chip-project-label").textContent = ws.name
      $("chip-project").title = ws.dir
      $("hero-title").textContent = `Start a new task in ${ws.name}`
      $("project-block").hidden = false
      $("workspace-name").textContent = ws.name
      await vibe.setDirectory(ws.dir)
      ensureProjectAgent(ws.dir)
      hideBranchChip()
      renderWorkspaces()
      await refreshSessions()
      resetActiveSessionForWorkspace()
    }
    ul.appendChild(li)
  }
}

async function addWorkspace({ directory, name }) {
  if (!directory) return
  let ws = workspaces.find((w) => w.dir === directory)
  if (!ws) {
    ws = { dir: directory, name: name || directory.split(/[\\/]/).pop() }
    workspaces.push(ws)
    saveWorkspaces()
  }
  projectDir = directory
  saveActiveProject(directory)
  $("chip-project-label").textContent = name
  $("chip-project").title = directory
  $("hero-title").textContent = `Start a new task in ${name}`
  $("project-block").hidden = false
  $("workspace-name").textContent = name
  // The branch chip stays hidden until the agent actually runs a git commit.
  $("chip-branch").hidden = true
  renderWorkspaces()
  // Sync the backend with the new workspace too (the sidebar click does this;
  // without it the backend kept filtering the session list by the old folder
  // and freshly created sessions never showed up).
  try {
    await vibe.setDirectory(directory)
    ensureProjectAgent(directory)
    await refreshSessions()
    resetActiveSessionForWorkspace()
  } catch {}
}

/* ---------- git branch chip (only during git work) ---------- */
function hideBranchChip() {
  $("chip-branch").hidden = true
}

/**
 * Show the current branch — but ONLY when the folder really is a git repo.
 * The branch is always verified live through the main process (git
 * rev-parse); a cached value is never trusted, otherwise a stale "master"
 * used to stick around in projects that are not git repositories at all.
 */
async function showBranchChip() {
  const dir = projectDir
  if (!dir || !vibe.gitBranch) return
  let branch = null
  try {
    // The main process answers { branch: "main" } (null outside a git repo);
    // older builds answered the plain name. Show only a real branch name.
    const res = await vibe.gitBranch({ directory: dir })
    const data = res && typeof res === "object" && "ok" in res ? (res.ok ? res.data : null) : res
    const name = typeof data === "string" ? data : data && typeof data.branch === "string" ? data.branch : ""
    if (/^[^\s\0]{1,200}$/.test(name.trim())) branch = name.trim()
  } catch {}
  if (!branch) { hideBranchChip(); return }
  $("chip-branch-label").textContent = branch
  $("chip-branch").hidden = false
}

/* Git subcommands that only READ the repo — they are not "git work". */
const GIT_READONLY = new Set([
  "status", "log", "diff", "show", "remote", "config", "ls-files", "ls-remote",
  "blame", "describe", "rev-parse", "symbolic-ref", "shortlog", "whatchanged",
  "check-ignore", "cat-file", "var", "grep", "help", "version",
])

/* These list by default, but change the repo when a name is given
 * (git branch -> lists, git branch feature -> creates). */
const GIT_NEEDS_ARG = new Set(["branch", "tag"])

/* git stash list / git stash show only read; git stash (push/pop) changes. */
const GIT_STASH_READONLY = new Set(["list", "show"])

/** True when the command line actually changes the repo (add/commit/...). */
function hasGitWork(cmd) {
  const s = String(cmd || "")
  if (!/\bgit\b/.test(s)) return false
  const re = /\bgit\b/g
  let m
  while ((m = re.exec(s)) !== null) {
    const tokens = s.slice(m.index + m[0].length).trim().split(/\s+/)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (!t) break
      if (/^(&&|\|\||;|\||&)$/.test(t)) break // a new command starts here
      if (t.startsWith("-")) {
        // flags like -C <path> consume the next token
        if (!t.includes("=") && /^-[a-zA-Z]$/.test(t)) i++
        continue
      }
      const sub = t.toLowerCase()
      if (GIT_NEEDS_ARG.has(sub)) {
        const next = tokens[i + 1] ? tokens[i + 1].toLowerCase() : ""
        // a name after it means create, a delete/move flag means remove
        if (next && !next.startsWith("-") && !/^(&&|\|\||;|\||&)$/.test(next)) return true
        if (/^(-d|-m|--delete|--move)$/.test(next)) return true
        break
      }
      if (sub === "stash") {
        const next = tokens[i + 1] ? tokens[i + 1].toLowerCase() : ""
        if (GIT_STASH_READONLY.has(next)) break
        return true
      }
      if (!GIT_READONLY.has(sub)) return true
      break // only the first real subcommand counts
    }
  }
  return false
}

/* The user asked for git work in the prompt (text mention only — the chip
 * still needs a REAL git repo, verified by the main process). */
function maybeShowBranchForText(text) {
  if (/\b(git\s+)?commit(?:ted|ting)?\b/i.test(String(text || ""))) showBranchChip()
}

/* The agent actually runs a git command -> show the branch for this run. */
function maybeShowBranchForTool(name, input) {
  if (!["shell", "bash", "terminal", "exec", "command"].includes(String(name || ""))) return
  const cmd = String(input?.command ?? input?.cmd ?? "")
  if (!hasGitWork(cmd)) return
  showBranchChip()
}

$("btn-add-workspace").onclick = async () => {
  const res = await vibe.pickProject()
  if (!res.ok || !res.data) return
  addWorkspace(res.data)
  await vibe.setDirectory(res.data.directory)
  ensureProjectAgent(res.data.directory)
  await refreshSessions()
}

$("btn-clear-workspaces").onclick = async () => {
  if (!workspaces.length) return
  if (!(await showConfirm("Remove every workspace from the list?"))) return
  workspaces = []
  saveWorkspaces()
  projectDir = null
  saveActiveProject(null)
  $("chip-project-label").textContent = "Select project"
  $("chip-branch").hidden = true
  $("project-block").hidden = true
  renderWorkspaces()
}

/* ---------- permission mode (Ask / Full Access) ---------- */
const PERM_ACTIONS = ["edit", "write", "patch", "bash", "webfetch"]

function permissionsFor(mode) {
  const effect = mode === "full" ? "allow" : "ask"
  const list = [
    ...PERM_ACTIONS.map((action) => ({ action, resource: "*", effect })),
    // Note: question tool is handled separately - it's always allowed as a UI prompt
    // but should NOT trigger Full Access mode detection
  ]
  // The agent may always write its own memory file, even in "Ask" mode.
  // The memory file lives OUTSIDE the project, and OpenCode checks the
  // `external_directory` permission BEFORE the write/edit permission. Without
  // that rule the save is blocked by a prompt (and the agent gives up), which
  // is why "remember this" never reached the file before.
  if (state.memoryFile && memoryEnabled()) {
    const file = String(state.memoryFile).replace(/\\/g, "/")
    const dir = file.slice(0, file.lastIndexOf("/"))
    list.push({ action: "read", resource: file, effect: "allow" })
    list.push({ action: "write", resource: file, effect: "allow" })
    list.push({ action: "edit", resource: file, effect: "allow" })
    if (dir) list.push({ action: "external_directory", resource: dir + "/*", effect: "allow" })
  }
  return list
}

async function applyPermissionMode(sessionID = state.activeSessionID) {
  if (!sessionID) return
  const res = await vibe.setPermissions({
    sessionID,
    permissions: permissionsFor(pillState.access),
  })
  if (!res.ok) showError("Could not apply the permission mode", res.error || "Unknown error", { key: "permissions" })
  else hideError("permissions")
  
  // IMPORTANT: When switching to "ask" mode, clear any existing session rules
  // that were added from previous "Full Access" sessions. This ensures
  // permission prompts actually appear in Ask mode.
  if (pillState.access !== "full" && vibe.clearSessionRules) {
    await vibe.clearSessionRules({ sessionID })
  }
}

/* ---------- custom model providers ---------- */
/* Add / rename / enable / disable / delete a provider, add its models and use
   them in the composer. The key is never put into localStorage. */
const providerState = {
  list: [],
  formats: [],
  selectedId: null,
  draft: null,
  fetched: [],
}

const providerFormDrafts = new Map()
const providerDraftChecked = new Set()
let providerDraftWrite = Promise.resolve()
let providerDraftTimer = null
let providerDraftLastSaved = ""

function providerDraftKey(d = providerState.draft) {
  if (d?.id) return d.id
  // An unsaved preset (OpenAI, Anthropic…) keeps its own draft, so "+ Add provider"
  // always opens the blank form instead of the last preset.
  if (d?.preset) return `__preset__:${d.preset}`
  return "__new__"
}

function captureProviderForm() {
  const d = providerState.draft
  if (!d) return null
  Object.assign(d, {
    name: $("pf-name").value,
    baseURL: $("pf-baseurl").value,
    apiFormat: $("pf-format").value,
    apiKey: $("pf-apikey").value,
    keyVisible: $("pf-apikey").type === "text",
    headersText: $("pf-headers").value,
    bodyText: $("pf-body").value,
    scope: $("pf-scope").value,
  })
  providerFormDrafts.set(providerDraftKey(d), d)
  return { ...d, models: (d.models || []).map((model) => ({ ...model })) }
}

function persistProviderDraft() {
  clearTimeout(providerDraftTimer)
  const draft = captureProviderForm()
  if (!draft || typeof vibe.providerDraftSave !== "function") return providerDraftWrite
  const key = providerDraftKey(draft)
  // Clicking another provider fires blur/change handlers on the current form
  // and then selectProvider itself. Serialize once so one click never queues
  // several identical IPC writes (that was the "heavy" provider switch).
  let fingerprint = ""
  try { fingerprint = JSON.stringify({ key, draft }) } catch {}
  if (fingerprint && fingerprint === providerDraftLastSaved) return providerDraftWrite
  providerDraftLastSaved = fingerprint
  const status = $("pf-autosave-status")
  if (status) status.textContent = "Saving draft…"
  providerDraftWrite = providerDraftWrite.catch(() => {}).then(async () => {
    const res = await vibe.providerDraftSave({ key, draft })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not auto-save the provider draft")
    if (providerDraftKey() === key && status) status.textContent = "Draft auto-saved · use Save provider to apply"
  }).catch(() => {
    // Let the next edit retry the same payload.
    providerDraftLastSaved = ""
    if (providerDraftKey() === key && status) status.textContent = "Auto-save failed · use Save provider to retry"
  })
  return providerDraftWrite
}

async function restoreProviderDraft(d) {
  if (typeof vibe.providerDraftLoad !== "function") return
  const key = providerDraftKey(d)
  // One disk read per provider per session. Re-clicking providers after the
  // first visit stays instant and never repaints the form twice.
  if (providerDraftChecked.has(key)) return
  providerDraftChecked.add(key)
  const res = await vibe.providerDraftLoad({ key }).catch(() => null)
  if (providerState.draft !== d || providerFormDrafts.has(key)) return
  if (res?.ok && res.data?.draft) {
    // Older builds stored preset forms as the blank "__new__" draft: never show one of those as "Add provider".
    if (key === "__new__" && isUntouchedPresetDraft(res.data.draft)) return
    Object.assign(d, res.data.draft, { id: d.id, isNew: d.isNew, keyVisible: false })
    providerFormDrafts.set(key, d)
    renderProviderDetail()
    $("pf-autosave-status").textContent = "Auto-saved draft restored"
  }
}

for (const id of ["pf-name", "pf-baseurl", "pf-format", "pf-apikey", "pf-headers", "pf-body", "pf-scope"]) {
  $(id)?.addEventListener("input", (event) => {
    captureProviderForm()
    clearTimeout(providerDraftTimer)
    if (event.inputType === "insertFromPaste") void persistProviderDraft()
    else providerDraftTimer = setTimeout(persistProviderDraft, 300)
  })
  $(id)?.addEventListener("change", () => void persistProviderDraft())
  $(id)?.addEventListener("blur", () => void persistProviderDraft())
}
window.addEventListener("blur", () => {
  if (providerState.draft && providerDraftDirty()) void persistProviderDraft()
})

/* What the app calls for each API format - the hint under the base URL. */
const FORMAT_HINT = {
  anthropic: "The API root, e.g. https://api.anthropic.com — the app calls /v1/messages (x-api-key). Console/dashboard URLs are fixed automatically.",
  chat: "The API root, e.g. https://api.openai.com/v1 — the app calls /chat/completions (Bearer). Console URLs (console.groq.com, console.x.ai...) are fixed automatically.",
  responses: "The API root, e.g. https://api.openai.com/v1 — the app calls /responses (Bearer). Console/dashboard URLs are fixed automatically.",
}

function updateFormatHint() {
  const hint = $("pf-baseurl-hint")
  if (!hint) return
  const fmt = $("pf-format")?.value || "chat"
  hint.textContent = FORMAT_HINT[fmt] || FORMAT_HINT.chat
}

function providerHeadersText(headers) {
  return Object.entries(headers && typeof headers === "object" ? headers : {}).map(([name, value]) => `${name}: ${value}`).join("\n")
}

function parseProviderHeaders(text) {
  const headers = {}
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const colon = line.indexOf(":")
    if (colon <= 0) throw new Error(`Invalid request header line: "${line}". Use Name: value.`)
    const name = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (!value) throw new Error(`Request header "${name}" has no value.`)
    headers[name] = value
  }
  return headers
}

function parseProviderBody(text) {
  const source = String(text || "").trim()
  if (!source) return {}
  let value
  try { value = JSON.parse(source) } catch (error) { throw new Error(`Extra request body is not valid JSON: ${error.message}`) }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Extra request body must be a JSON object.")
  return value
}

const providerBodyText = (body) => body && typeof body === "object" && Object.keys(body).length ? JSON.stringify(body, null, 2) : ""

$("pf-format")?.addEventListener("change", updateFormatHint)

function newProviderDraft() {
  return {
    id: "",
    name: "",
    baseURL: "",
    apiFormat: "chat",
    apiKey: "",
    hasKey: false,
    maskedKey: "",
    headers: {},
    body: {},
    models: [],
    scope: "global",
    disabled: false,
    isNew: true,
  }
}

async function loadProviders(opts = {}) {
  if (!opts.silent) captureProviderForm()
  if (!vibe.providerList && !vibe.providerCatalog) return
  const generation = ++providerLoadGeneration
  const res = typeof vibe.providerCatalog === "function"
    ? await vibe.providerCatalog({ directory: projectDir })
    : await vibe.providerList({ directory: projectDir })
  if (generation !== providerLoadGeneration) return
  if (!res || res.ok === false) {
    if (!opts.silent) {
      showError("Could not load the providers", res?.error || "Unknown error", { key: "providers" })
    }
    return
  }
  const data = res.data || {}
  if (typeof vibe.providerCatalog === "function") {
    applyProviderCatalog(data)
  } else {
    providerState.list = data.custom ?? []
    providerState.formats = data.formats ?? []
  }
  if (opts.silent) return
  captureProviderForm()
  renderProviderList()
  if (providerState.selectedId) {
    const found = providerState.list.find((p) => p.id === providerState.selectedId)
    if (found) {
      // Don't overwrite unsaved fields, but don't resurrect a provider deleted
      // from disk: deletion is authoritative for the provider catalog.
      if (!providerDraftDirty()) providerState.draft = { ...found, isNew: false }
      renderProviderDetail()
      return
    }
  }
  if (providerState.draft?.isNew) {
    renderProviderDetail()
    return
  }
  providerState.selectedId = null
  providerState.draft = null
  renderProviderDetail()
}

function providerDraftDirty() {
  const d = providerState.draft
  if (!d || d.isNew) return !!d
  const currentModels = JSON.stringify(d.models || [])
  const saved = providerState.list.find((p) => p.id === d.id)
  if (!saved) return true
  return String($("pf-name")?.value || "") !== String(saved.name || "") ||
    String($("pf-baseurl")?.value || "") !== String(saved.baseURL || "") ||
    String($("pf-format")?.value || "chat") !== String(saved.apiFormat || "chat") ||
    String($("pf-headers")?.value || "").trim() !== providerHeadersText(saved.headers).trim() ||
    String($("pf-body")?.value || "").trim() !== providerBodyText(saved.body).trim() ||
    String($("pf-scope")?.value || "global") !== String(saved.scope || "global") ||
    !!$("pf-apikey")?.value ||
    currentModels !== JSON.stringify(saved.models || []) ||
    !!d.disabled !== !!saved.disabled
}

async function refreshProviderStateLive() {
  captureProviderForm()
  const generation = ++providerRefreshGeneration
  const selectedId = providerState.selectedId
  let draftBefore = providerState.draft
    ? { ...providerState.draft, models: [...(providerState.draft.models || [])] }
    : null
  let dirtyBefore = providerDraftDirty()

  await loadModels()
  if (generation !== providerRefreshGeneration) return
  if (typeof vibe.providerCatalog !== "function") {
    await loadProviders({ silent: true })
  }

  if (providerState.selectedId !== selectedId) return
  draftBefore = captureProviderForm()
  dirtyBefore = providerDraftDirty()

  // A newly-created draft is local work and can survive a refresh. An existing
  // draft whose provider disappeared from disk must not bring the deleted row
  // back into the UI or the Composer catalog.
  if (draftBefore?.isNew) {
    providerState.selectedId = selectedId
    providerState.draft = draftBefore
    renderProviderList()
    renderProviderDetail()
  } else if (selectedId && providerState.list.some((item) => item.id === selectedId)) {
    const saved = providerState.list.find((item) => item.id === selectedId)
    providerState.selectedId = selectedId
    providerState.draft = dirtyBefore ? draftBefore : { ...saved, isNew: false }
    renderProviderList()
    renderProviderDetail()
  } else {
    providerState.selectedId = null
    providerState.draft = null
    renderProviderList()
    renderProviderDetail()
  }

  renderModelList(modelSearch?.value || "")
  const menu = $("model-menu")
  if (state.modelMenuOpen && menu) menu.hidden = false
}

function renderProviderList() {
  const box = $("custom-provider-list")
  const empty = $("custom-provider-empty")
  if (!box) return
  box.textContent = ""
  // A provider created from a popular preset belongs to the Popular list, not
  // to Custom providers. Only genuinely new/custom providers appear here.
  // The VibeCoder account's own profile lives in the VibeCoderAI panel above.
  const rows = providerState.list.filter((p) => !providerPresetOf(p) && p.id !== "vibecoder")
  if (empty) empty.hidden = rows.length > 0
  for (const p of rows) {
    const item = document.createElement("div")
    item.className = "ml-item provider-item" + (p.id === providerState.selectedId ? " active" : "")
    item.dataset.provider = p.id
    const ic = document.createElement("span")
    ic.className = "prov-ic"
    setProvIcon(ic, p.name)
    const nm = document.createElement("span")
    nm.className = "prov-nm"
    nm.textContent = p.name
    item.append(ic, nm)
    // Every custom provider shows its state like the OpenCode row does:
    // green = on (models usable), grey = switched off.
    const dot = document.createElement("span")
    dot.className = "prov-dot " + (p.disabled ? "off" : "on")
    dot.title = p.disabled ? "This provider is switched off" : "This provider is on"
    item.appendChild(dot)
    item.onclick = () => selectProvider(p.id)
    box.appendChild(item)
  }
  renderProviderPresets()
}

/** The popular preset a saved provider came from, or null for a custom one. */
function providerPresetOf(p) {
  if (!p) return null
  const key = presetKey(p)
  if (!key) return null
  return PROVIDER_PRESETS.find((preset) => presetKey(preset) === key) || null
}

/** Cheap active-state repaint for a provider switch (no list rebuild). */
function updateProviderSelection() {
  const box = $("custom-provider-list")
  if (!box) return
  for (const item of box.querySelectorAll(".provider-item[data-provider]")) {
    item.classList.toggle("active", item.dataset.provider === providerState.selectedId)
  }
}

/* ---------- popular provider presets ----------
   One click fills the provider form with the name, the API base URL and the
   format. No models are added: the user pastes a key and adds models exactly
   like a custom provider. The base URL stays editable, so a preset can be
   pointed at a proxy or a different regional host. */
const PROVIDER_PRESETS = [
  { name: "OpenAI", baseURL: "https://api.openai.com/v1", apiFormat: "chat", icon: "◎" },
  { name: "Anthropic (Claude)", baseURL: "https://api.anthropic.com", apiFormat: "anthropic", icon: "◈" },
  { name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", apiFormat: "chat", icon: "◈" },
  { name: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", apiFormat: "chat", icon: "◈" },
  { name: "Vercel AI Gateway", baseURL: "https://ai-gateway.vercel.sh/v1", apiFormat: "chat", icon: "▲" },
  { name: "Kilo Gateway", baseURL: "https://ai-gateway.kilo.ai/api/v1", apiFormat: "chat", icon: "◈" },
  { name: "AgentRouter", baseURL: "https://agentrouter.org/v1", apiFormat: "chat", icon: "◈" },
  { name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiFormat: "chat", icon: "✦" },
  { name: "Groq", baseURL: "https://api.groq.com/openai/v1", apiFormat: "chat", icon: "⚡" },
  { name: "Agnes AI", baseURL: "https://apihub.agnes-ai.com/v1", apiFormat: "chat", icon: "◈" },
  { name: "AMD", baseURL: "https://developer.amd.com.cn/radeon/api/v1", apiFormat: "chat", icon: "◈" },
]

const presetKey = (p) => String(p && p.baseURL || "").trim().replace(/\/+$/, "").toLowerCase()
/** A draft that is only a preset's prefilled form (no key and no models typed in). */
function isUntouchedPresetDraft(d) {
  if (!d || d.id) return false
  const k = presetKey(d)
  return !!k && PROVIDER_PRESETS.some((p) => presetKey(p) === k) && !String(d.apiKey || "").trim() && !(d.models || []).length
}

function renderProviderPresets() {
  const box = $("preset-provider-list")
  if (!box) return
  box.textContent = ""
  for (const preset of PROVIDER_PRESETS) {
    const saved = providerState.list.find((p) => presetKey(p) === presetKey(preset)) || null
    const item = document.createElement("div")
    item.className = "ml-item provider-item preset-item" + (saved ? " configured" : "")
    item.dataset.preset = preset.baseURL
    if (saved) item.dataset.provider = saved.id
    item.title = saved
      ? `${preset.name} — configured${saved.name && saved.name !== preset.name ? ` as ${saved.name}` : ""}`
      : `${preset.name} — ${preset.baseURL}`
    const ic = document.createElement("span")
    ic.className = "prov-ic"
    setProvIcon(ic, preset.name)
    const nm = document.createElement("span")
    nm.className = "prov-nm"
    nm.textContent = preset.name
    item.append(ic, nm)
    if (saved) {
      // Configured popular provider: green/grey state, exactly like Custom rows.
      const dot = document.createElement("span")
      dot.className = "prov-dot " + (saved.disabled ? "off" : "on")
      dot.title = saved.disabled ? "This provider is switched off" : "This provider is on"
      item.appendChild(dot)
      item.onclick = () => selectProvider(saved.id)
    } else {
      const add = document.createElement("span")
      add.className = "prov-add"
      add.textContent = "＋"
      add.title = `Add ${preset.name}`
      item.appendChild(add)
      item.onclick = () => selectProviderPreset(preset)
    }
    box.appendChild(item)
  }
  updatePresetActive()
}

function updatePresetActive() {
  const list = $("preset-provider-list")
  if (!list) return
  const current = providerState.draft ? presetKey(providerState.draft) : ""
  for (const item of list.children) {
    item.classList.toggle("active", !!current && presetKey({ baseURL: item.dataset.preset }) === current)
  }
}

function selectProviderPreset(preset) {
  // Already saved with this base URL -> open that provider instead of a duplicate.
  const existing = providerState.list.find((p) => presetKey(p) === presetKey(preset))
  if (existing) {
    selectProvider(existing.id)
    return
  }
  if (providerState.draft && providerDraftDirty()) void persistProviderDraft()
  providerState.selectedId = null
  const ownKey = `__preset__:${presetKey(preset)}`
  let d = providerFormDrafts.get(ownKey)
  if (!d) {
    d = newProviderDraft()
    Object.assign(d, {
      name: preset.name,
      baseURL: preset.baseURL,
      apiFormat: preset.apiFormat,
      models: [],
      isNew: true,
      preset: presetKey(preset),
    })
  }
  providerState.draft = d
  // Remember this preset's form under its own key (never the blank "__new__" one).
  providerFormDrafts.set(ownKey, d)
  updateProviderSelection()
  updatePresetActive()
  renderProviderDetail()
  showProviderFormPanel()
  $("model-detail").scrollTop = 0
  // The form's input/change handlers save once the user actually edits it.
  // Writing a draft on every preset click just added IPC noise to the switch.
}

/** Show the custom/preset provider form and nothing else (the VibeCoderAI
 *  account panel belongs to its own list item only). */
function showProviderFormPanel() {
  state.selectedProvider = null
  for (const item of document.querySelectorAll(".provider-item[data-provider=opencode]")) item.classList.remove("selected")
  $("md-opencode").hidden = true
  $("md-custom").hidden = false
  $("model-detail").querySelector(".md-empty")?.setAttribute("hidden", "")
}

function selectProvider(id) {
  const p = providerState.list.find((x) => x.id === id)
  if (!p) return
  if (providerState.draft && providerState.draft.id !== id && providerDraftDirty()) void persistProviderDraft()
  providerState.selectedId = id
  providerState.draft = providerFormDrafts.get(id) || { ...p, isNew: false }
  updateProviderSelection()
  updatePresetActive()
  renderProviderDetail()
  $("model-detail").scrollTop = 0
  void restoreProviderDraft(providerState.draft)
  // the VibeCoderAI account block is not shown while a custom provider is open
  showProviderFormPanel()
}

function startNewProvider() {
  if (providerState.draft && providerDraftDirty()) void persistProviderDraft()
  providerState.selectedId = null
  const blank = providerFormDrafts.get("__new__")
  providerState.draft = blank && !isUntouchedPresetDraft(blank) ? blank : newProviderDraft()
  providerFormDrafts.set("__new__", providerState.draft)
  updateProviderSelection()
  updatePresetActive()
  renderProviderDetail()
  $("model-detail").scrollTop = 0
  void restoreProviderDraft(providerState.draft)
  showProviderFormPanel()
}

function renderProviderDetail() {
  const d = providerState.draft
  providerKeyLoaded = null
  providerKeyFor = null
  const box = $("md-custom")
  if (!box) return
  if (!d) {
    box.hidden = true
    $("md-opencode").hidden = false
    $("model-detail").querySelector(".md-empty")?.removeAttribute("hidden")
    return
  }
  box.hidden = false
  $("md-custom-name").textContent = d.name || "New provider"
  if ($("md-custom-logo")) setProvIcon($("md-custom-logo"), d.name || "New provider")
  $("md-custom-sub").textContent = d.isNew
    ? "Not saved yet — fill the form and press Save provider"
    : `${d.models.length} model${d.models.length === 1 ? "" : "s"} · ${d.scope === "global" ? "global" : "this project"}`
  $("pf-name").value = d.name || ""
  $("pf-baseurl").value = d.baseURL || ""
  $("pf-format").value = d.apiFormat || "chat"
  $("pf-headers").value = d.headersText ?? providerHeadersText(d.headers)
  $("pf-body").value = d.bodyText ?? providerBodyText(d.body)
  updateFormatHint()
  $("pf-apikey").value = d.apiKey || ""
  $("pf-apikey").type = d.keyVisible ? "text" : "password"
  $("pf-apikey").placeholder = d.hasKey ? `${d.maskedKey} (saved - click the eye to reveal)` : "sk-..."
  $("pf-key-toggle").classList.toggle("revealed", !!d.keyVisible)
  providerKeyLoaded = null
  $("pf-scope").value = d.scope || "global"
  const toggle = $("toggle-provider")
  toggle.classList.toggle("on", !d.disabled)
  toggle.setAttribute("aria-checked", d.disabled ? "false" : "true")
  $("pf-delete").hidden = d.isNew
  const autosave = $("pf-autosave-status")
  if (autosave) autosave.textContent = d.isNew ? "Not saved yet — use Save provider" : ""
  renderProviderModels()
}

function renderProviderModels() {
  const box = $("pf-model-list")
  const d = providerState.draft
  if (!box) return
  box.textContent = ""
  const models = d?.models ?? []
  if ($("pf-models-count")) {
    $("pf-models-count").textContent = models.length
      ? `${models.length} model${models.length === 1 ? "" : "s"}`
      : "No models yet"
  }
  for (const m of models) {
    const row = document.createElement("div")
    row.className = "pf-model"
    const id = document.createElement("span")
    id.className = "pfm-id"
    id.textContent = m.id
    const lim = document.createElement("span")
    lim.className = "pfm-lim"
    lim.textContent = m.context ? `${m.context} ctx · ${m.output || 0} out` : "no limits"
    if (m.image) {
      const img = document.createElement("span")
      img.className = "pfm-img"
      img.title = "This model can read images"
      img.textContent = "🖼 images"
      row.append(img)
    }
    const x = document.createElement("button")
    x.className = "pfm-x"
    x.type = "button"
    x.title = "Remove this model"
    x.textContent = "✕"
    x.onclick = () => {
      providerState.draft.models = providerState.draft.models.filter((z) => z.id !== m.id)
      renderProviderModels()
    }
    row.append(id, lim, x)
    box.appendChild(row)
  }
}

async function saveProvider() {
  const d = providerState.draft
  if (!d) return
  const btn = $("pf-save")
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = "Saving…"
  try {
    const headers = parseProviderHeaders($("pf-headers").value)
    const body = parseProviderBody($("pf-body").value)
    const res = await vibe.providerSave({
      id: d.id || undefined,
      name: $("pf-name").value.trim(),
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      apiKey: $("pf-apikey").value,
      headers,
      body,
      models: d.models,
      scope: $("pf-scope").value,
      directory: projectDir,
      disabled: d.disabled,
    })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not save the provider")
    clearTimeout(providerDraftTimer)
    await providerDraftWrite
    const draftKey = providerDraftKey(d)
    if (typeof vibe.providerDraftRemove === "function") await vibe.providerDraftRemove({ key: draftKey })
    providerFormDrafts.delete(draftKey)
    $("pf-apikey").value = ""
    hideError("providers")
    hideError("providers-key")
    if (res.data?.warning) {
      const text = String(res.data.warning)
      // An address the app simply corrected is good news, not a problem.
      const onlyFixedUrl = text.split("\n").every((line) => /^base URL ".*" -> ".*"$/.test(line.trim()) || /is the console\/dashboard/.test(line))
      if (onlyFixedUrl) showError("Saved — API address corrected", `${text.replace(/^base URL "(.*)" -> "(.*)"$/gm, "Changed $1 to the API address $2")}. Nothing else to do.`, { key: "providers", tone: "success" })
      else showError("Saved, but this format may not work", text, { key: "providers", tone: "warning" })
    }
    providerState.selectedId = res.data?.id || d.id
    providerState.draft = {
      ...d,
      id: providerState.selectedId,
      name: $("pf-name").value.trim(),
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      headers,
      body,
      scope: $("pf-scope").value,
      apiKey: "",
      keyVisible: false,
      isNew: false,
    }
    await loadProviders()
    // Read the just-persisted profile immediately; no timing-based refresh.
    await loadProviders({ silent: true })
    await loadModels()
    renderModelList(modelSearch?.value || "")
  } catch (e) {
    showError("Could not save the provider", String(e && e.message ? e.message : e), { key: "providers" })
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

async function deleteProvider() {
  const d = providerState.draft
  if (!d || d.isNew) return
  if (!(await showConfirm(`Delete "${d.name}"? The provider and its models will be removed.`))) return
  try {
    const res = await vibe.providerRemove({ id: d.id, scope: d.scope, directory: projectDir })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not delete the provider")
    clearTimeout(providerDraftTimer)
    await providerDraftWrite
    if (typeof vibe.providerDraftRemove === "function") await vibe.providerDraftRemove({ key: providerDraftKey(d) })
    providerFormDrafts.delete(providerDraftKey(d))
    providerState.selectedId = null
    providerState.draft = null
    await loadProviders()
    await loadModels()
  } catch (e) {
    showError("Could not delete the provider", String(e && e.message ? e.message : e), { key: "providers" })
  }
}

async function toggleProvider() {
  const d = providerState.draft
  if (!d || d.isNew) return
  const next = !d.disabled
  try {
    const res = await vibe.providerDisabled({ id: d.id, disabled: next, scope: d.scope, directory: projectDir })
    if (!res || res.ok === false) throw new Error(res?.error || "Could not switch the provider")
    d.disabled = next
    await loadProviders()
    await loadModels()
  } catch (e) {
    showError("Could not switch the provider", String(e && e.message ? e.message : e), { key: "providers" })
  }
}

/** Ask the provider which models it has. */
async function fetchModelsForForm() {
  const btn = $("pf-fetch-models")
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = "Fetching…"
  try {
    const res = await vibe.providerModels({
      id: providerState.draft?.id || undefined,
      baseURL: $("pf-baseurl").value.trim(),
      apiFormat: $("pf-format").value,
      apiKey: $("pf-apikey").value,
      headers: parseProviderHeaders($("pf-headers").value),
    })
    if (!res || res.ok === false) {
      providerState.fetched = []
      showError(
        "Could not fetch the models",
        (res?.error || "Unknown error") + " — you can still add a model by hand.",
        { key: "providers" },
      )
      return
    }
    hideError("providers")
    providerState.fetched = res.data?.models ?? []
    const count = res.data?.count ?? providerState.fetched.length
    if (!count) {
      showError("No models found", "The provider did not return any model ids.", { key: "providers" })
      return
    }
    // A provider can have a thousand models - the app never dumps them all.
    // The user types the model id and the app confirms that one.
    providerState.fetchedCount = count
    openModelModal(providerState.fetched)
  } catch (e) {
    showError("Could not fetch the models", String(e && e.message ? e.message : e), { key: "providers" })
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

/* ---------- add model modal ---------- */
let modelModalSmart = true
let modelModalChoices = []
let modelModalImage = false

function openModelModal(choices) {
  modelModalChoices = choices || []
  $("mf-id").value = ""
  $("mf-context").value = ""
  $("mf-output").value = ""
  modelModalImage = false
  $("mf-image").checked = false
  $("mf-image-row").hidden = true
  const count = providerState.fetchedCount || modelModalChoices.length
  $("mf-status").textContent = count
    ? `${count} models on this provider — type the model id, the app fills in the rest.`
    : "Type the model id. The context window and the image support are filled in automatically."
  $("mf-status").classList.remove("err")
  modelModalSmart = true
  $("mf-smart").classList.add("on")
  $("mf-smart").setAttribute("aria-checked", "true")
  // a small search over the fetched ids (never the whole list)
  const pick = $("mf-picker")
  if (pick) {
    pick.textContent = ""
    const show = modelModalChoices.slice(0, 8)
    for (const m of show) {
      const b = document.createElement("button")
      b.className = "save-btn ghost"
      b.type = "button"
      b.textContent = m.id
      b.onclick = () => {
        $("mf-id").value = m.id
        confirmModel(m.id)
      }
      pick.appendChild(b)
    }
  }
  $("model-modal").hidden = false
  $("mf-id").focus()
}

function closeModelModal() {
  $("model-modal").hidden = true
}

/** Look the typed model up: the provider first, then models.dev. */
async function confirmModel(modelId) {
  const id = String(modelId || "").trim()
  if (!id) return
  const status = $("mf-status")
  status.classList.remove("err")
  const d = providerState.draft
  const baseURL = $("pf-baseurl").value.trim()
  const apiFormat = $("pf-format").value
  const apiKey = $("pf-apikey").value
  let headers
  try { headers = parseProviderHeaders($("pf-headers").value) }
  catch (error) { status.textContent = error.message; status.classList.add("err"); return }

  if (baseURL) {
    status.textContent = `Looking up "${id}" on the provider…`
    try {
      const res = await vibe.providerModel({ id: d?.id || undefined, baseURL, apiFormat, apiKey, headers, modelId: id })
      if (res && res.ok && res.data?.found) {
        const m = res.data.model
        $("mf-context").value = m.context || ""
        $("mf-output").value = m.output || ""
        modelModalImage = !!m.image
        $("mf-image").checked = modelModalImage
        $("mf-image-row").hidden = false
        status.textContent = `Found on the provider — ${m.context || "?"} context, ${m.output || "?"} output${m.image ? ", images" : ""}.`
        return
      }
      if (res && res.data?.error) status.textContent = res.data.error
    } catch (e) {
      status.textContent = String(e && e.message ? e.message : e)
    }
  }

  // models.dev fallback
  status.textContent = `Looking up "${id}" on models.dev…`
  try {
    const meta = await vibe.providerMeta({ modelId: id })
    if (meta && meta.ok && meta.data?.found) {
      $("mf-context").value = meta.data.context || ""
      $("mf-output").value = meta.data.output || ""
      modelModalImage = !!meta.data.image
      $("mf-image").checked = modelModalImage
      $("mf-image-row").hidden = false
      status.textContent = `Found on models.dev (${meta.data.provider}) — ${meta.data.context || "?"} context${meta.data.image ? ", images" : ""}.`
    } else {
      status.textContent = "Not found — you can type the limits by hand."
    }
  } catch {
    status.textContent = "Could not look it up — you can type the limits by hand."
  }
  if (d) d.image = modelModalImage
}

async function addModelFromModal() {
  const id = $("mf-id").value.trim()
  if (!id) {
    $("mf-status").textContent = "A model id is required."
    $("mf-status").classList.add("err")
    return
  }
  const status = $("mf-status")
  let context = Number($("mf-context").value) || 0
  let output = Number($("mf-output").value) || 0
  if (modelModalSmart && (!context || !output || !modelModalImage)) {
    await confirmModel(id)
    context = Number($("mf-context").value) || context
    output = Number($("mf-output").value) || output
    modelModalImage = $("mf-image").checked
  }
  const draft = providerState.draft
  if (!draft) {
    closeModelModal()
    return
  }
  draft.models = draft.models.filter((m) => m.id !== id)
  draft.models.push({ id, name: id, context, output, image: modelModalImage })
  renderProviderModels()
  closeModelModal()
}

$("pf-save")?.addEventListener("click", saveProvider)
$("pf-delete")?.addEventListener("click", deleteProvider)
$("pf-fetch-models")?.addEventListener("click", fetchModelsForForm)
$("pf-add-model")?.addEventListener("click", () => openModelModal([]))
// The saved key is hidden by default (type=password). Clicking the eye pulls the
// real key from the backend once and reveals it, so you can see which key a
// provider uses; clicking again re-hides it.
let providerKeyLoaded = null
let providerKeyFor = null
$("pf-key-toggle")?.addEventListener("click", async (event) => {
  event.preventDefault()
  event.stopPropagation()
  const input = $("pf-apikey")
  if (!input) return
  if (input.type === "text") {
    input.type = "password"
    $("pf-key-toggle").classList.remove("revealed")
    return
  }
  // typing a new (unsaved) key: the eye just reveals what is typed
  if (input.value) {
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    return
  }
  const id = providerState.draft && providerState.draft.id
  if (!id) {
    // New providers have no stored secret yet; still let the eye reveal typed text.
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    input.focus()
    return
  }
  try {
    if (providerKeyFor !== id) {
      providerKeyLoaded = null
      const res = await vibe.providerKey({ id })
      if (!res || res.ok === false) throw new Error(res?.error || "Could not read the saved API key")
      providerKeyLoaded = res.data?.key || ""
      providerKeyFor = id
    }
    if (!providerKeyLoaded) {
      showError("Could not reveal API key", "No saved key was found for this provider. Enter a key and save the provider first.", { key: "providers-key" })
      return
    }
    hideError("providers-key")
    input.value = providerKeyLoaded
    input.type = "text"
    $("pf-key-toggle").classList.add("revealed")
    input.focus()
  } catch (e) {
    showError("Could not reveal API key", String(e?.message || e), { key: "providers-key" })
  }
})
$("toggle-provider")?.addEventListener("click", toggleProvider)
$("model-modal-close")?.addEventListener("click", closeModelModal)
$("mf-cancel")?.addEventListener("click", closeModelModal)
$("mf-save")?.addEventListener("click", addModelFromModal)
// typing a model id confirms it (context window + image support) on its own
let mfLookupTimer = null
$("mf-id")?.addEventListener("input", () => {
  if (!modelModalSmart) return
  const id = $("mf-id").value.trim()
  if (!id) return
  if (mfLookupTimer) clearTimeout(mfLookupTimer)
  mfLookupTimer = setTimeout(() => confirmModel(id), 700)
})
$("mf-image")?.addEventListener("change", () => {
  modelModalImage = $("mf-image").checked
})
$("mf-smart")?.addEventListener("click", () => {
  modelModalSmart = !modelModalSmart
  $("mf-smart").classList.toggle("on", modelModalSmart)
  $("mf-smart").setAttribute("aria-checked", modelModalSmart ? "true" : "false")
})
$("model-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "model-modal") closeModelModal()
})

