/* ---------- fallback model (ordered chain across providers) ---------- */
const fallbackState = { group: null, catalog: [], open: false, saving: false }

function updateFallbackDot() {
  const dot = $("fb-entry-dot")
  if (!dot) return
  const count = fallbackState.group?.models?.length || 0
  dot.className = "prov-dot " + (count ? "on" : "off")
  dot.title = count
    ? `${count} model${count === 1 ? "" : "s"} in the fallback chain`
    : "No models added yet — click Fallback model to add some"
}

async function loadFallbackState() {
  if (typeof vibe.fallbackGet !== "function") return
  const res = await vibe.fallbackGet()
  if (!res || res.ok === false) return
  fallbackState.group = res.data?.group || { id: "fallback", name: "Fallback model", models: [], cursor: 0 }
  fallbackState.catalog = Array.isArray(res.data?.catalog) ? res.data.catalog : []
  updateFallbackDot()
  if (fallbackState.open) renderFallback()
}

function fallbackRow(key) {
  return fallbackState.catalog.find((row) => row.key === key) || null
}

function fallbackRowLabel(row, key) {
  return row ? `${row.providerName || row.providerID} · ${row.name || row.modelID}` : key
}

async function openFallback() {
  const overlay = $("fb-overlay")
  if (!overlay) return
  fallbackState.open = true
  // Keep a custom provider draft safe but hide its panel behind the popup.
  if (providerState.draft) void persistProviderDraft()
  providerState.selectedId = null
  updateProviderSelection()
  updatePresetActive()
  $("md-opencode").hidden = true
  $("md-custom").hidden = true
  overlay.hidden = false
  const search = $("fb-search")
  if (search) search.value = ""
  await loadFallbackState()
  renderFallback()
}

function closeFallback() {
  fallbackState.open = false
  const overlay = $("fb-overlay")
  if (overlay) overlay.hidden = true
  const detail = $("model-detail")
  detail?.querySelector(".md-empty")?.removeAttribute("hidden")
  $("md-opencode").hidden = false
  $("md-custom").hidden = true
}

function fbOpButton(label, title, disabled, onClick, extra = "") {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "fb-op" + extra
  button.textContent = label
  button.title = title
  button.disabled = !!disabled
  button.onclick = (event) => { event.stopPropagation(); onClick() }
  return button
}

function renderFallback() {
  const group = fallbackState.group
  if (!group) return
  const models = Array.isArray(group.models) ? group.models : []
  const cursor = models.length ? Math.min(Math.max(0, Number(group.cursor) || 0), models.length - 1) : 0
  const list = $("fb-added-list")
  if (!list) return
  list.textContent = ""
  $("fb-added-empty").hidden = models.length > 0

  models.forEach((key, index) => {
    const row = fallbackRow(key)
    const item = document.createElement("div")
    item.className = "fb-row" + (models.length && index === cursor ? " active" : "")

    const num = document.createElement("span")
    num.className = "fb-num"
    num.textContent = String(index + 1)

    const name = document.createElement("div")
    name.className = "fb-model"
    const title = document.createElement("div")
    title.textContent = row ? (row.name || row.modelID) : key
    const sub = document.createElement("small")
    sub.textContent = row ? (row.providerName || row.providerID) : "model is not configured any more — it will be skipped"
    name.append(title, sub)

    const ops = document.createElement("div")
    ops.className = "fb-ops"
    ops.append(
      fbOpButton("↑", "Move up", index === 0, () => moveFallbackModel(index, -1)),
      fbOpButton("↓", "Move down", index === models.length - 1, () => moveFallbackModel(index, 1)),
      fbOpButton("✕", "Remove from fallback", false, () => toggleFallbackModel(key), " remove"),
    )
    item.append(num, name, ops)
    list.appendChild(item)
  })

  const current = $("fb-current")
  if (current) {
    current.textContent = models.length
      ? `Next answer: #${cursor + 1} · ${fallbackRowLabel(fallbackRow(models[cursor]), models[cursor])}`
      : ""
  }
  renderFallbackCatalog()
  updateFallbackDot()
}

function renderFallbackCatalog() {
  const box = $("fb-catalog-list")
  if (!box) return
  box.textContent = ""
  const query = String($("fb-search")?.value || "").trim().toLowerCase()
  const added = new Set(fallbackState.group?.models || [])
  const hits = fallbackState.catalog.filter((row) => !query
    || row.key.toLowerCase().includes(query)
    || String(row.providerName || "").toLowerCase().includes(query)
    || String(row.modelID || "").toLowerCase().includes(query))
  $("fb-catalog-empty").hidden = hits.length > 0

  const groups = new Map()
  for (const row of hits) {
    if (!groups.has(row.providerID)) groups.set(row.providerID, [])
    groups.get(row.providerID).push(row)
  }
  for (const [providerID, rows] of groups) {
    const head = document.createElement("div")
    head.className = "fb-group-head"
    head.textContent = rows[0].providerName || providerID
    box.appendChild(head)
    for (const row of rows) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "fb-cat-item" + (added.has(row.key) ? " added" : "")
      const check = document.createElement("span")
      check.className = "fb-check"
      check.textContent = "✓"
      const text = document.createElement("span")
      text.className = "fb-cat-text"
      const name = document.createElement("span")
      name.textContent = row.name || row.modelID
      const sub = document.createElement("small")
      sub.textContent = row.modelID + (row.context ? ` · ${row.context} ctx` : "")
      text.append(name, sub)
      button.append(check, text)
      button.onclick = () => toggleFallbackModel(row.key)
      box.appendChild(button)
    }
  }
}

async function persistFallback(models, activeKey) {
  if (typeof vibe.fallbackSave !== "function") return
  fallbackState.saving = true
  const previous = fallbackState.group
  const cursor = models.indexOf(activeKey)
  const savedCursor = cursor >= 0 ? cursor : Math.min(Math.max(0, Number(previous?.cursor) || 0), Math.max(0, models.length - 1))
  fallbackState.group = { ...(previous || { id: "fallback", name: "Fallback model" }), models, cursor: savedCursor }
  renderFallback()
  const res = await vibe.fallbackSave({ models, cursor: savedCursor })
  fallbackState.saving = false
  if (!res || res.ok === false) {
    fallbackState.group = previous
    renderFallback()
    showError("Could not save the fallback model", res?.error || "Unknown error", { key: "fallback" })
    return
  }
  hideError("fallback")
  fallbackState.group = res.data || fallbackState.group
  // The composer picker and its label read the fresh catalog (including the
  // cursor), so refresh it before repainting the popup.
  await loadModels()
  renderFallback()
}

function toggleFallbackModel(key) {
  if (fallbackState.saving) return
  const models = [...(fallbackState.group?.models || [])]
  let activeKey = models[Number(fallbackState.group?.cursor) || 0]
  const index = models.indexOf(key)
  if (index >= 0) {
    models.splice(index, 1)
    if (key === activeKey) activeKey = models[Math.min(index, models.length - 1)]
  } else {
    models.push(key)
  }
  void persistFallback(models, activeKey)
}

function moveFallbackModel(index, delta) {
  if (fallbackState.saving) return
  const models = [...(fallbackState.group?.models || [])]
  const target = index + delta
  if (target < 0 || target >= models.length) return
  const activeKey = models[Number(fallbackState.group?.cursor) || 0]
  const [moved] = models.splice(index, 1)
  models.splice(target, 0, moved)
  void persistFallback(models, activeKey)
}

async function resetFallbackCursor() {
  if (typeof vibe.fallbackReset !== "function") return
  const res = await vibe.fallbackReset()
  if (!res || res.ok === false) {
    showError("Could not reset the fallback model", res?.error || "Unknown error", { key: "fallback" })
    return
  }
  fallbackState.group = res.data || fallbackState.group
  await loadModels()
  renderFallback()
}

$("fallback-group-item").onclick = () => { void openFallback() }
$("fb-close").onclick = () => closeFallback()
$("fb-reset").onclick = () => { void resetFallbackCursor() }
$("fb-search").oninput = () => renderFallbackCatalog()
$("fb-overlay").onclick = (event) => { if (event.target === $("fb-overlay")) closeFallback() }
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && fallbackState.open) closeFallback()
})

/* ---------- VibeCoderAI account (device login, coming soon) ---------- */
const ocSub = document.getElementById("opencode-sub")
const ocStDot = document.getElementById("opencode-st-dot")
const ocStText = document.getElementById("opencode-st-text")
const ocConnect = document.getElementById("opencode-connect")
const ocDisconnect = document.getElementById("opencode-disconnect")
const ocDevice = document.getElementById("opencode-device")
const ocDot = document.getElementById("opencode-dot")
const connState = document.getElementById("conn-state")
const connLabel = document.getElementById("connect-label")
let authPoll = null

/* The VibeCoderAI account is live: "Sign in with VibeCoder" opens the website,
   the user presses Allow, and the free VibeCoder models appear as a provider.
   Setting this back to true restores the old "coming soon" state. */
const VIBECODER_ACCOUNT_COMING_SOON = false

function applyComingSoonAccount() {
  if (ocSub) ocSub.textContent = "Your own VibeCoderAI API host — coming soon"
  if (ocStDot) ocStDot.className = "st-dot soon"
  if (ocStText) ocStText.textContent = "Coming soon"
  if (ocConnect) {
    ocConnect.hidden = false
    ocConnect.disabled = true
    ocConnect.textContent = "Coming soon"
  }
  if (ocDisconnect) ocDisconnect.hidden = true
  if (ocDevice) ocDevice.hidden = true
  if (ocDot) ocDot.classList.remove("on")
  if (connState) connState.textContent = "Coming soon — your own VibeCoderAI API host"
  if (connLabel) {
    connLabel.textContent = "VibeCoderAI"
    connLabel.title = "VibeCoderAI account — coming soon"
  }
}

/* Sidebar account button. Signed out: one click opens the VibeCoder website in
   the browser to sign in (the menu shows the code to match). Signed in: the menu
   shows the account, today's usage and Logout. */
let authSignedIn = false
let authStarting = false

async function startVibecoderSignIn() {
  if (VIBECODER_ACCOUNT_COMING_SOON || authStarting) return
  authStarting = true
  connState.textContent = "Opening VibeCoder in your browser…"
  if (ocStText) ocStText.textContent = "Opening VibeCoder in your browser…"
  if (ocStDot) ocStDot.className = "st-dot checking"
  try {
    const res = await vibe.authConnect()
    if (res && res.ok === false) {
      const why = res.error || "unknown error"
      connState.textContent = `Sign-in failed — ${why}`
      if (ocStText) ocStText.textContent = `Sign-in failed — ${why}`
      if (ocStDot) ocStDot.className = "st-dot off"
      return
    }
    showAuthCode(res?.data?.code)
    if (authPoll) clearInterval(authPoll)
    authPoll = setInterval(() => { refreshAuthUI().catch(() => {}) }, 3000)
  } finally {
    authStarting = false
  }
}

function showAuthCode(code) {
  if (!code) return
  connState.textContent = `Code ${code} — press Allow in your browser. Signing in finishes here automatically.`
  if (ocDevice) ocDevice.hidden = false
  const codeEl = document.getElementById("opencode-code")
  if (codeEl) codeEl.textContent = code
  if (ocStDot) ocStDot.className = "st-dot checking"
  if (ocStText) ocStText.textContent = "Waiting for you to press Allow in the browser…"
}

$("btn-connect").onclick = async (e) => {
  e.stopPropagation()
  const menu = document.getElementById("connect-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  if (!wasHidden) return
  menu.hidden = false
  await refreshAuthUI()
  if (!authSignedIn && !VIBECODER_ACCOUNT_COMING_SOON) await startVibecoderSignIn()
}

$("conn-connect").onclick = async () => {
  if (VIBECODER_ACCOUNT_COMING_SOON) return
  await startVibecoderSignIn()
}

$("conn-logout").onclick = async () => {
  closeAllMenus()
  connState.textContent = "Logging out…"
  if (authPoll) clearInterval(authPoll)
  authPoll = null
  const res = await vibe.authDisconnect()
  const out = (res && res.data) || {}
  const failed = (res && res.ok === false) || (out && out.ok === false)
  if (failed) {
    // Never claim a logout that did not happen: the saved account is still there.
    const why = (res && res.error) || out.error || "The saved account could not be removed"
    showError("VibeCoderAI logout failed", why, { key: "auth" })
    await refreshAuthUI()
    connState.textContent = `Logout failed — ${why}`
    return
  }
  hideError("auth")
  resetOpenCodeModelCache()
  await refreshAuthUI()
  connState.textContent = "Logged out — saved account removed"
}

// A logged-out account must not leave its model cache/selection behind: the
// next account can have a different catalog and the old pick would 404. Models
// of the other providers stay usable.
function resetOpenCodeModelCache() {
  state.models = (state.models || []).filter((m) => m && m.providerID !== "opencode" && m.providerID !== "vibecoder")
  if (String(state.selectedModel || "").startsWith("opencode/") || String(state.selectedModel || "").startsWith("vibecoder/")) {
    state.selectedModel = null
    try {
      localStorage.removeItem("vibecoder.model")
    } catch {}
    $("model-label").textContent = "Select model"
  }
}

async function refreshAuthUI() {
  if (VIBECODER_ACCOUNT_COMING_SOON) {
    applyComingSoonAccount()
    return
  }
  const res = await vibe.authStatus()
  if (res && res.ok === false) {
    // Do not show "Not connected" when the state could not be read at all.
    ocStDot.className = "st-dot off"
    ocStText.textContent = `Status unknown — ${res.error || "the account store is unreachable"}`
    connState.textContent = "Status unknown"
    return
  }
  const connected = !!(res.ok && res.data?.connected)
  authSignedIn = connected
  const pending = !connected && res.ok ? res.data?.pending : null
  if (connected || !pending) {
    if (authPoll) clearInterval(authPoll)
    authPoll = null
  }
  if (connected) {
    const who = res.data.email || res.data.org || "account"
    // The free quota resets at 00:00 UTC: show that as the user's own clock time.
    let resets = ""
    try {
      const at = res.data.usage?.resetsAt ? new Date(res.data.usage.resetsAt) : null
      if (at && !Number.isNaN(at.getTime())) resets = ` · resets at ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    } catch {}
    const usage = res.data.usage && res.data.dailyLimit != null
      ? ` · ${Number(res.data.usage.requests) || 0}/${Number(res.data.dailyLimit) || 0} requests today${resets}`
      : ""
    ocSub.textContent = "Signed in — free VibeCoder models are in the model picker"
    ocStDot.className = "st-dot on"
    ocStText.textContent = `Connected — ${who}${usage}`
    ocConnect.hidden = true
    ocDisconnect.hidden = false
    ocDevice.hidden = true
    ocDot.classList.add("on")
    connState.textContent = `Signed in — ${who}${usage}`
    // Sidebar shows the signed-in account (name or gmail username) instead of "Connect".
    const user = String(res.data.name || "").trim() || String(res.data.email || "").split("@")[0]
    connLabel.textContent = user || res.data.org || "Connected"
    connLabel.title = res.data.email || who
    const logout = document.getElementById("conn-logout")
    if (logout) logout.disabled = false
    const login = document.getElementById("conn-connect")
    if (login) login.hidden = true
    if (!(state.models || []).some((m) => m && m.providerID === "vibecoder")) loadModels().then(() => renderModelList()).catch(() => {})
  } else if (pending) {
    ocSub.textContent = "Finish signing in in your browser"
    ocConnect.hidden = false
    ocConnect.disabled = false
    ocConnect.textContent = "Open the sign-in page again"
    ocDisconnect.hidden = true
    ocDot.classList.remove("on")
    showAuthCode(pending.code)
    connLabel.textContent = "Signing in…"
    connLabel.title = `Code ${pending.code}`
  } else {
    ocSub.textContent = "Sign in with VibeCoder to use free models — no API key needed"
    ocStDot.className = "st-dot off"
    ocStText.textContent = res.data?.error || "Not connected"
    ocConnect.hidden = false
    ocConnect.disabled = false
    ocConnect.textContent = "Sign in with VibeCoder"
    ocDisconnect.hidden = true
    ocDevice.hidden = true
    ocDot.classList.remove("on")
    // Clearing the OpenCode model cache also drops a stale opencode selection,
    // so nothing tries to use the logged-out account's models.
    resetOpenCodeModelCache()
    connState.textContent = res.data?.error || "Not signed in — sign in with VibeCoder to use free models"
    connLabel.textContent = "Sign in"
    connLabel.title = "Sign in with VibeCoder"
    const login = document.getElementById("conn-connect")
    if (login) { login.hidden = false; login.disabled = false; login.textContent = "Sign in with VibeCoder" }
    const logout = document.getElementById("conn-logout")
    if (logout) logout.disabled = true
  }
  const provItems = document.querySelectorAll(".provider-item")
  provItems.forEach((i) =>
    i.classList.toggle("selected", i.dataset.provider === state.selectedProvider),
  )
  // Also update settings nav user
  loadAuthInfo()
}

state.selectedProvider = null

document.querySelector(".provider-item[data-provider=opencode]").onclick = () => {
  state.selectedProvider = "opencode"
  // Leaving a custom provider open: save its form, then show only the account panel.
  if (providerState.draft && providerDraftDirty()) void persistProviderDraft()
  providerState.selectedId = null
  providerState.draft = null
  updateProviderSelection()
  updatePresetActive()
  document.querySelector(".md-empty").hidden = true
  document.getElementById("md-opencode").hidden = false
  document.getElementById("md-custom").hidden = true
  const detail = document.getElementById("model-detail")
  if (detail) detail.scrollTop = 0
  refreshAuthUI()
}

ocConnect.onclick = async () => {
  await startVibecoderSignIn()
}

ocDisconnect.onclick = async () => {
  ocStDot.className = "st-dot checking"
  ocStText.textContent = "Disconnecting…"
  if (authPoll) clearInterval(authPoll)
  authPoll = null
  const res = await vibe.authDisconnect()
  const out = (res && res.data) || {}
  const failed = (res && res.ok === false) || (out && out.ok === false)
  if (failed) {
    const why = (res && res.error) || out.error || "The saved account could not be removed"
    showError("VibeCoderAI logout failed", why, { key: "auth" })
    await refreshAuthUI()
    ocStText.textContent = `Logout failed — ${why}`
    return
  }
  hideError("auth")
  resetOpenCodeModelCache()
  ocDevice.hidden = true
  await refreshAuthUI()
}

// Toggles
settingsContent.querySelectorAll(".toggle").forEach((t) => {
  if (t.id === "toggle-notify" || t.id === "toggle-autocontinue" || t.id === "toggle-memory" || t.id === "toggle-computer-use") {
    return // handled below (persisted)
  }
  t.onclick = () => t.classList.toggle("on")
})

/* Background notifications toggle (persisted in localStorage) */
const notifyToggle = $("toggle-notify")
if (notifyToggle) {
  const applyNotifyState = () => {
    const on = notificationsEnabled()
    notifyToggle.classList.toggle("on", on)
    notifyToggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  applyNotifyState()
  notifyToggle.onclick = () => {
    try { localStorage.setItem(NOTIFY_KEY, notificationsEnabled() ? "off" : "on") } catch {}
    applyNotifyState()
  }
  notifyToggle.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      notifyToggle.onclick()
    }
  }
}

/* Auto-continue in the background toggle (persisted in localStorage) */
const autoToggle = $("toggle-autocontinue")
if (autoToggle) {
  const applyAutoState = () => {
    const on = autoContinueEnabled()
    autoToggle.classList.toggle("on", on)
    autoToggle.setAttribute("aria-checked", on ? "true" : "false")
  }
  applyAutoState()
  autoToggle.onclick = () => {
    try { localStorage.setItem(AUTO_CONTINUE_KEY, autoContinueEnabled() ? "off" : "on") } catch {}
    applyAutoState()
  }
  autoToggle.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault()
      autoToggle.onclick()
    }
  }
}
$("btn-test-notify")?.addEventListener("click", async () => {
  try {
    const r = await vibe.notify({ title: "VibeCoder AI", body: "Notifications are working ✅" })
    if (r && r.ok === false) showError("Could not send the notification", r.error || "Unknown error")
  } catch (e) {
    showError("Could not send the notification", String(e))
  }
})

const backendSelect = document.getElementById("setting-backend")
if (backendSelect) backendSelect.onchange = async (e) => {
  const res = await vibe.setMode(e.target.value)
  if (!res.ok) {
    alert(res.error)
    e.target.value = state.mode ?? "sdk"
  }
}

/* ---------- composer: access mode / project / thinking (dropdown menus) ---------- */
const pillState = {
  access: "ask",
  thinking: "Low",
}

function closeAllMenus() {
  document.querySelectorAll(".drop-menu").forEach((m) => (m.hidden = true))
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) closeAllMenus()
})

const ACCESS_META = {
  ask: { label: "Ask before changes", orange: false },
  full: { label: "Full Access", orange: true },
}

function setAccess(key) {
  pillState.access = key
  const m = ACCESS_META[key]
  $("access-label").textContent = m.label
  $("btn-access").classList.toggle("orange", m.orange)
  document.querySelectorAll("#access-menu .drop-item").forEach((it) =>
    it.classList.toggle("selected", it.dataset.access === key),
  )
  applyPermissionMode()
}

function setThinking(level) {
  pillState.thinking = level
  $("thinking-label").textContent = level === "None" ? "Off" : level
  document.querySelectorAll("#thinking-menu .drop-item").forEach((it) =>
    it.classList.toggle("selected", it.dataset.think === level),
  )
}

function wireMenu(btnID, menuID, onPick) {
  const btn = $(btnID)
  const menu = $(menuID)
  btn.onclick = (e) => {
    e.stopPropagation()
    const wasHidden = menu.hidden
    closeAllMenus()
    menu.hidden = !wasHidden
  }
  menu.querySelectorAll(".drop-item").forEach((item) => {
    item.onclick = (e) => {
      e.stopPropagation()
      onPick(item)
      closeAllMenus()
    }
  })
}

wireMenu("btn-access", "access-menu", (item) => setAccess(item.dataset.access))
wireMenu("btn-thinking", "thinking-menu", (item) => setThinking(item.dataset.think))
$("btn-ctx").onclick = async (e) => {
  e.stopPropagation()
  const menu = $("ctx-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  menu.hidden = !wasHidden
  if (!menu.hidden) {
    await Promise.all([loadCompactionSettings({ silent: true }), loadModels()])
    renderCompactionModels()
  }
}
$("ctx-auto-toggle").onclick = async (e) => {
  e.stopPropagation()
  await setAutoCompact(!state.autoCompact)
}
$("ctx-compact-now").onclick = (e) => {
  e.stopPropagation()
  closeAllMenus()
  compactNow({ reason: "manual" })
}

const rewindRows = (response) => response?.ok === false ? [] : (Array.isArray(response?.data) ? response.data : [])
const shortPath = (value) => String(value || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || String(value || "file")

async function refreshRewindMenu() {
  const summary = $("rewind-summary")
  const files = $("rewind-files")
  const stepButton = $("rewind-step")
  const turnButton = $("rewind-turn")
  const redoButton = $("rewind-redo")
  const sessionID = state.activeSessionID
  state.rewindLatestStep = null
  state.rewindLatestTurn = null
  if (!sessionID) {
    summary.textContent = "Open a session to inspect captured changes."
    files.replaceChildren()
    stepButton.disabled = turnButton.disabled = redoButton.disabled = true
    return
  }
  const [stepResult, turnResult, redoResult] = await Promise.all([
    vibe.listStepSnapshots({ sessionID }),
    vibe.listSnapshots({ sessionID }),
    vibe.listRedo({ sessionID }),
  ])
  const steps = rewindRows(stepResult)
  const turns = rewindRows(turnResult)
  const redos = rewindRows(redoResult)
  state.rewindLatestStep = steps[0] || null
  state.rewindLatestTurn = turns[0] || null
  stepButton.disabled = state.running || !state.rewindLatestStep
  turnButton.disabled = state.running || !state.rewindLatestTurn
  redoButton.disabled = state.running || !redos.length
  const target = state.rewindLatestStep || state.rewindLatestTurn
  if (!target) {
    summary.textContent = redos.length ? "Changes are rewound. Redo is available." : "No captured changes in this session."
    files.replaceChildren()
    return
  }
  summary.textContent = target.step
    ? `Latest capture: turn ${target.turn}, step ${target.step}`
    : `Latest capture: turn ${target.turn}`
  const preview = await vibe.previewSnapshot({ sessionID, turn: target.turn, ...(target.step ? { step: target.step } : {}) })
  const rows = preview?.ok === false ? [] : (preview?.data?.files || [])
  files.replaceChildren(...rows.slice(0, 8).map((row) => {
    const el = document.createElement("div")
    el.className = "rewind-file"
    const name = document.createElement("b")
    name.textContent = shortPath(row.path)
    name.title = String(row.path || "")
    const stats = document.createElement("span")
    stats.textContent = row.skipped ? "skipped" : row.binary ? "binary" : `+${Number(row.added) || 0} −${Number(row.removed) || 0}`
    el.append(name, stats)
    return el
  }))
}

async function applyRewind(kind) {
  if (state.running) return showError("Stop the current run first", "Rewind cannot change files while the agent is running.", { key: "rewind" })
  const sessionID = state.activeSessionID
  if (!sessionID) return
  let response
  if (kind === "step") {
    const target = state.rewindLatestStep
    if (!target) return
    response = await vibe.undoStepSession({ sessionID, turn: target.turn, step: target.step })
  } else if (kind === "turn") response = await vibe.undoSession({ sessionID })
  else response = await vibe.redoSession({ sessionID })
  if (!response || response.ok === false) {
    showError("Rewind failed", response?.error || "The requested history state is unavailable.", { key: "rewind" })
    return
  }
  hideError("rewind")
  closeAllMenus()
  await renderSessionHistory(sessionID)
  await refreshSessions()
}

$("btn-rewind").onclick = async (event) => {
  event.stopPropagation()
  const menu = $("rewind-menu")
  const wasHidden = menu.hidden
  closeAllMenus()
  menu.hidden = !wasHidden
  if (!menu.hidden) await refreshRewindMenu()
}
$("rewind-menu").onclick = (event) => event.stopPropagation()
$("rewind-step").onclick = () => applyRewind("step")
$("rewind-turn").onclick = () => applyRewind("turn")
$("rewind-redo").onclick = () => applyRewind("redo")
setAccess("ask")
setThinking("Low")
renderAutoCompact()

let projectDir = null
$("chip-project").onclick = async () => {
  const res = await vibe.pickProject()
  if (!res.ok || !res.data) return
  addWorkspace(res.data)
  await vibe.setDirectory(res.data.directory)
  ensureProjectAgent(res.data.directory)
  await refreshSessions()
}

/* ---------- attachments ---------- */
const attachments = []

/** true/false when the selected model is known, null when it is not in the list. */
function selectedModelImageSupport() {
  const key = state.selectedModel
  if (!key) return null
  const list = Array.isArray(state.models) ? state.models : []
  const hit = list.find((m) => `${m.providerID}/${m.id}` === key)
  return hit ? !!hit.image : null
}

function renderAttachments() {
  const tray = $("attach-tray")
  tray.innerHTML = ""
  tray.hidden = attachments.length === 0
  for (const a of attachments) {
    const chip = document.createElement("span")
    chip.className = "attach" + (a.kind === "image" ? " image" : "")
    if (a.kind === "image" && a.dataUrl) {
      const img = document.createElement("img")
      img.className = "thumb"
      img.src = a.dataUrl
      img.alt = a.name
      chip.appendChild(img)
    } else {
      const ic = document.createElement("span")
      ic.className = "att-ic"
      ic.textContent = "📄"
      chip.appendChild(ic)
    }
    const nm = document.createElement("span")
    nm.className = "nm"
    nm.textContent = a.name || (a.path || "").split(/[\\/]/).pop()
    nm.title = a.path || a.name
    const rm = document.createElement("button")
    rm.className = "rm"
    rm.textContent = "✕"
    rm.title = "Remove"
    rm.onclick = () => {
      const i = attachments.indexOf(a)
      if (i >= 0) attachments.splice(i, 1)
      renderAttachments()
    }
    chip.append(nm, rm)
    tray.appendChild(chip)
  }
  if (attachments.some((a) => a.kind === "image")) {
    const hint = document.createElement("span")
    hint.className = "att-hint"
    const canSee = selectedModelImageSupport()
    hint.textContent =
      canSee === false
        ? "⚠ this model is not marked vision-capable — pick one marked Vision"
        : "image — the model can see this"
    tray.appendChild(hint)
  }
}

function addAttachments(list) {
  for (const a of list) {
    if (!a) continue
    if (attachments.some((x) => x.path === a.path)) continue
    attachments.push(a)
  }
  renderAttachments()
}

$("btn-attach").onclick = async () => {
  const res = await vibe.pickAttachments()
  if (!res.ok) return alert(res.error)
  const items = []
  for (const p of res.data) {
    const r = await vibe.readAttachment(p)
    if (r.ok) items.push(r.data)
    else items.push({ path: p, name: p.split(/[\\/]/).pop(), kind: "file" })
  }
  addAttachments(items)
}

/* ---------- top buttons (visual for now) ---------- */
for (const [id, msg] of [
  ["btn-devices", "Devices: coming soon"],
]) {
  const el = $(id)
  if (el) el.onclick = () => alert(msg)
}

renderSessions()
refreshSessions()
loadCompactionSettings({ silent: true })
