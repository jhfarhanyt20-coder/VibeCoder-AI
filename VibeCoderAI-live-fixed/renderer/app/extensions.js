/* ---------- MCP servers + plugins (real config, wired to the CLI) ---------- */
const cfgState = {
  mcp: [],
  plugins: [],
  mcpFiles: [],
  pluginFiles: [],
  builtinMcp: [],
  builtinPlugins: [],
  builtinPluginDirs: [],
}

function cfgDir() {
  // projectDir is declared later in the file; read it lazily at call time.
  try {
    return typeof projectDir !== "undefined" ? projectDir : null
  } catch {
    return null
  }
}

function setCfgBusy(which, busy) {
  const btn = $(which === "mcp" ? "mcp-refresh" : "plugin-refresh")
  if (btn) {
    btn.disabled = busy
    btn.textContent = busy ? "… Loading" : "⟳ Refresh"
  }
}

function renderCfgFiles(which) {
  const box = $(which === "mcp" ? "mcp-files" : "plugin-files")
  if (!box) return
  const files = which === "mcp" ? cfgState.mcpFiles : cfgState.pluginFiles
  box.innerHTML = ""
  if (!files || !files.length) {
    box.textContent = "No OpenCode config files found yet — adding an item creates one."
    return
  }
  for (const f of files) {
    const row = document.createElement("div")
    row.className = "cfg-file" + (f.ok ? "" : " bad")
    row.textContent = `${f.scope}: ${f.file}${f.ok ? "" : "  (invalid JSON)"}`
    box.appendChild(row)
  }
  const note = document.createElement("div")
  note.className = "cfg-note"
  note.textContent = "Changes are written through the OpenCode CLI; restart the app if a running session does not pick them up."
  box.appendChild(note)
}

function cfgBadge(scope) {
  const b = document.createElement("span")
  b.className = "cfg-badge " + (scope === "project" ? "project" : "global")
  b.textContent = scope === "project" ? "project" : "global"
  return b
}

function renderMcp() {
  const list = $("mcp-list")
  if (!list) return
  list.innerHTML = ""
  $("mcp-count").textContent = String(cfgState.mcp.length)
  if (!cfgState.mcp.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No MCP servers configured."
    list.appendChild(e)
    return
  }
  for (const s of cfgState.mcp) {
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = s.name
    const meta = document.createElement("div")
    meta.className = "cfg-meta"
    meta.title = s.type === "remote"
      ? (s.url || "")
      : (s.command || []).join(" ")
    meta.textContent = s.type === "remote"
      ? `remote · ${s.url || "no url"}`
      : `local · ${(s.command || []).join(" ") || "no command"}`
    main.append(name, meta)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove MCP server "${s.name}" from the ${s.scope} config?`))) return
      del.disabled = true
      const res = await vibe.mcpRemove({ name: s.name, directory: cfgDir(), global: s.scope === "global" })
      if (!res.ok) {
        del.disabled = false
        alert("Remove failed: " + (res.error || "unknown"))
        return
      }
      await loadMcp()
    }
    actions.appendChild(del)

    row.append(main, cfgBadge(s.scope), actions)
    list.appendChild(row)
  }
}

function renderPlugins() {
  const list = $("plugin-list")
  if (!list) return
  list.innerHTML = ""
  $("plugin-count").textContent = String(cfgState.plugins.length)
  if (!cfgState.plugins.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No plugins configured."
    list.appendChild(e)
    return
  }
  for (const p of cfgState.plugins) {
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = p.spec
    const meta = document.createElement("div")
    meta.className = "cfg-meta"
    meta.textContent = p.options ? "with options" : "package"
    main.append(name, meta)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove plugin "${p.spec}"?`))) return
      del.disabled = true
      const res = await vibe.pluginRemove({ spec: p.spec, directory: cfgDir() })
      if (!res.ok) {
        del.disabled = false
        alert("Remove failed: " + (res.error || "unknown"))
        return
      }
      await loadPlugins()
    }
    actions.appendChild(del)

    row.append(main, cfgBadge(p.scope), actions)
    list.appendChild(row)
  }
}

async function loadMcp() {
  setCfgBusy("mcp", true)
  try {
    const res = await vibe.mcpList({ directory: cfgDir() })
    if (!res.ok) throw new Error(res.error || "Could not read the OpenCode config")
    cfgState.mcp = Array.isArray(res.data?.mcp) ? res.data.mcp : []
    cfgState.mcpFiles = Array.isArray(res.data?.files) ? res.data.files : []
    renderMcp()
    renderCfgFiles("mcp")
    await loadBuiltins()
  } catch (e) {
    $("mcp-list").innerHTML = ""
    const err = document.createElement("div")
    err.className = "cfg-empty"
    err.textContent = "Failed to load: " + String(e.message || e)
    $("mcp-list").appendChild(err)
  } finally {
    setCfgBusy("mcp", false)
  }
}

async function loadPlugins() {
  setCfgBusy("plugins", true)
  try {
    const res = await vibe.pluginList({ directory: cfgDir() })
    if (!res.ok) throw new Error(res.error || "Could not read the OpenCode config")
    cfgState.plugins = Array.isArray(res.data?.plugins) ? res.data.plugins : []
    cfgState.pluginFiles = Array.isArray(res.data?.files) ? res.data.files : []
    renderPlugins()
    renderCfgFiles("plugins")
    await loadBuiltins()
  } catch (e) {
    $("plugin-list").innerHTML = ""
    const err = document.createElement("div")
    err.className = "cfg-empty"
    err.textContent = "Failed to load: " + String(e.message || e)
    $("plugin-list").appendChild(err)
  } finally {
    setCfgBusy("plugins", false)
  }
}

/* ---------- built-in MCP servers + local plugin files ---------- */
function cfgTagRow(entry) {
  const wrap = document.createElement("div")
  wrap.className = "cfg-tags"
  for (const t of entry.tags || []) {
    const b = document.createElement("span")
    b.className = "cfg-tag"
    b.textContent = t
    wrap.appendChild(b)
  }
  if (entry.auth === "oauth") {
    const b = document.createElement("span")
    b.className = "cfg-tag auth"
    b.textContent = "oauth"
    wrap.appendChild(b)
  }
  return wrap
}

function renderBuiltinMcp() {
  const list = $("builtin-mcp-list")
  if (!list) return
  list.innerHTML = ""
  if (!cfgState.builtinMcp.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "Built-in catalog is empty."
    list.appendChild(e)
    return
  }

  for (const s of cfgState.builtinMcp) {
    const row = document.createElement("div")
    row.className = "cfg-item cfg-builtin" + (s.installed ? " installed" : "")

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = s.title
    const meta = document.createElement("div")
    meta.className = "cfg-meta cfg-wrap"
    meta.textContent = s.description
    const detail = document.createElement("div")
    detail.className = "cfg-meta mono"
    detail.textContent = s.type === "remote" ? s.url : (s.command || []).join(" ")
    main.append(name, meta, detail, cfgTagRow(s))

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const btn = document.createElement("button")
    btn.className = s.installed ? "" : "add"
    btn.textContent = s.installed ? "Added ✓" : "Add"
    btn.disabled = !!s.installed
    btn.onclick = async () => {
      btn.disabled = true
      btn.textContent = "Adding…"
      const res = await vibe.mcpAdd({
        name: s.name,
        type: s.type,
        url: s.type === "remote" ? s.url : undefined,
        command: s.type === "local" ? s.command : undefined,
        global: !!$("mcp-global")?.checked || !cfgDir(),
        directory: cfgDir(),
      })
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = "Add"
        alert("Add failed: " + (res.error || "unknown"))
        return
      }
      await loadMcp()
    }
    actions.appendChild(btn)

    row.append(main, actions)
    list.appendChild(row)
  }
}

function renderBuiltinPlugins() {
  const list = $("builtin-plugin-list")
  if (!list) return
  list.innerHTML = ""
  if (!cfgState.builtinPlugins.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No built-in plugins bundled with this build."
    list.appendChild(e)
    return
  }

  for (const p of cfgState.builtinPlugins) {
    const row = document.createElement("div")
    row.className = "cfg-item cfg-builtin" + (p.installed ? " installed" : "")

    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = p.title
    const meta = document.createElement("div")
    meta.className = "cfg-meta cfg-wrap"
    meta.textContent = p.description
    const detail = document.createElement("div")
    detail.className = "cfg-meta mono"
    // Installed: where it lives. Not installed: nothing (the button says it).
    detail.textContent = p.installed ? `${p.path}` : ""
    main.append(name, meta, detail, cfgTagRow(p))

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const btn = document.createElement("button")
    btn.className = p.installed ? "del" : "add"
    btn.textContent = p.installed ? "Remove" : "Install"
    btn.onclick = async () => {
      if (p.installed && !(await showConfirm(`Remove built-in plugin "${p.title}"?`))) return
      btn.disabled = true
      btn.textContent = p.installed ? "Removing…" : "Installing…"
      const res = p.installed
        ? await vibe.removeBuiltinPlugin({ id: p.id, directory: cfgDir(), global: p.scope === "global" })
        : await vibe.installBuiltinPlugin({
            id: p.id,
            directory: cfgDir(),
            global: !!$("builtin-plugin-global")?.checked || !cfgDir(),
          })
      if (!res.ok) {
        btn.disabled = false
        btn.textContent = p.installed ? "Remove" : "Install"
        alert((p.installed ? "Remove" : "Install") + " failed: " + (res.error || "unknown"))
        return
      }
      await loadPlugins()
    }
    actions.appendChild(btn)

    if (p.installed && p.scope) row.append(main, cfgBadge(p.scope), actions)
    else row.append(main, actions)
    list.appendChild(row)
  }
}

async function loadBuiltins() {
  if (!vibe.builtins) return
  const res = await vibe.builtins({ directory: cfgDir() })
  if (!res || !res.ok) return
  cfgState.builtinMcp = Array.isArray(res.data?.mcp) ? res.data.mcp : []
  cfgState.builtinPlugins = Array.isArray(res.data?.plugins) ? res.data.plugins : []
  cfgState.builtinPluginDirs = Array.isArray(res.data?.pluginDirs) ? res.data.pluginDirs : []
  renderBuiltinMcp()
  renderBuiltinPlugins()
}

/* ---------- marketplace (MCP + plugins + skills) ---------- */
const marketState = { items: [], kind: "all", query: "", counts: {}, registries: [], registryStatus: [] }

function marketKindLabel(kind) {
  if (kind === "mcp") return "MCP"
  if (kind === "plugin") return "Plugin"
  return "Skill"
}

function marketMatches(item) {
  if (marketState.kind !== "all" && item.kind !== marketState.kind) return false
  const q = marketState.query.trim().toLowerCase()
  if (!q) return true
  return [item.id, item.title, item.description, ...(item.tags || [])]
    .join(" ")
    .toLowerCase()
    .includes(q)
}

function renderMarket() {
  const grid = $("mkt-grid")
  if (!grid) return
  grid.innerHTML = ""

  const items = marketState.items.filter(marketMatches)
  if (!items.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = marketState.query
      ? `No match for “${marketState.query}”.`
      : "Nothing here yet."
    grid.appendChild(e)
    return
  }

  for (const item of items) {
    const card = document.createElement("div")
    card.className = "mkt-card" + (item.installed ? " installed" : "")

    const head = document.createElement("div")
    head.className = "mkt-head"
    const title = document.createElement("div")
    title.className = "mkt-title"
    title.textContent = item.title
    const kind = document.createElement("span")
    kind.className = "mkt-kind " + item.kind
    kind.textContent = marketKindLabel(item.kind)
    head.append(title, kind)

    const desc = document.createElement("div")
    desc.className = "mkt-desc"
    desc.textContent = item.description

    const tags = document.createElement("div")
    tags.className = "cfg-tags"
    const free = document.createElement("span")
    free.className = "cfg-tag free"
    free.textContent = "free"
    tags.appendChild(free)
    if (item.custom) {
      const custom = document.createElement("span")
      custom.className = "cfg-tag custom"
      custom.textContent = item.registry ? item.registry.name : "custom"
      custom.title = item.registry ? item.registry.url : ""
      tags.appendChild(custom)
    }
    for (const t of item.tags || []) {
      const b = document.createElement("span")
      b.className = "cfg-tag"
      b.textContent = t
      tags.appendChild(b)
    }

    const foot = document.createElement("div")
    foot.className = "mkt-foot"
    const state = document.createElement("span")
    state.className = "mkt-state" + (item.installed ? " on" : "")
    state.textContent = item.installed
      ? "Installed" + (item.scope ? " · " + item.scope : "")
      : "Not installed"

    const btn = document.createElement("button")
    btn.className = "mkt-btn " + (item.installed ? "del" : "add")
    btn.textContent = item.installed ? "Remove" : "Install"
    btn.onclick = () => marketAction(item, btn)

    foot.append(state, btn)
    card.append(head, desc, tags, foot)
    grid.appendChild(card)
  }
}

async function marketAction(item, btn) {
  const dir = cfgDir()
  const useGlobal = !!$("mkt-global")?.checked || !dir

  if (item.installed && !(await showConfirm(`Remove “${item.title}”?`))) return

  btn.disabled = true
  btn.textContent = item.installed ? "Removing…" : "Installing…"

  let res
  if (item.kind === "mcp") {
    res = item.installed
      ? await vibe.mcpRemove({ name: item.name, directory: dir, global: false })
      : await vibe.mcpAdd({
          name: item.name,
          type: item.type,
          url: item.url,
          command: item.command,
          env: item.env,
          headers: item.headers,
          global: useGlobal,
          directory: dir,
        })
  } else if (item.kind === "plugin") {
    if (item.custom) {
      // Registry plugins are plain npm/git packages.
      res = item.installed
        ? await vibe.pluginRemove({ spec: item.spec, directory: dir })
        : await vibe.pluginAdd({ spec: item.spec, directory: dir })
    } else {
      res = item.installed
        ? await vibe.removeBuiltinPlugin({ id: item.id, directory: dir, global: item.scope === "global" })
        : await vibe.installBuiltinPlugin({ id: item.id, directory: dir, global: useGlobal })
    }
  } else if (item.custom) {
    // Registry skills ship their markdown inline.
    res = item.installed
      ? await vibe.removeCustomSkill({ id: item.id, directory: dir, global: item.scope === "global" })
      : await vibe.installCustomSkill({
          id: item.id,
          title: item.title,
          description: item.description,
          content: item.content,
          directory: dir,
          global: useGlobal,
        })
  } else {
    res = item.installed
      ? await vibe.removeSkill({ id: item.id, directory: dir, global: item.scope === "global" })
      : await vibe.installSkill({ id: item.id, directory: dir, global: useGlobal })
  }

  if (!res || !res.ok) {
    btn.disabled = false
    btn.textContent = item.installed ? "Remove" : "Install"
    alert((item.installed ? "Remove" : "Install") + " failed: " + ((res && res.error) || "unknown"))
    return
  }
  await loadMarketplace()
}

/* ---------- custom marketplaces (registries) ---------- */
function renderRegistries() {
  const list = $("mkt-reg-list")
  if (!list) return
  list.innerHTML = ""

  const registries = marketState.registries || []
  const status = marketState.registryStatus || []
  const count = $("mkt-reg-count")
  if (count) count.textContent = String(registries.length)

  if (!registries.length) {
    const empty = document.createElement("div")
    empty.className = "cfg-empty"
    empty.textContent = "No custom marketplace yet. Add a registry URL above."
    list.appendChild(empty)
    return
  }

  for (const reg of registries) {
    const st = status.find((s) => s.id === reg.id)
    const row = document.createElement("div")
    row.className = "cfg-item"

    const main = document.createElement("div")
    main.className = "cfg-main"

    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = reg.name || reg.url

    const url = document.createElement("div")
    url.className = "cfg-meta mono cfg-wrap"
    url.textContent = reg.url

    const note = document.createElement("div")
    note.className = "cfg-note"
    if (!st) note.textContent = "Not loaded yet."
    else if (st.ok)
      note.textContent = `${st.count} item${st.count === 1 ? "" : "s"}${st.cached ? " (cached)" : ""}`
    else note.textContent = `Could not load: ${st.error}${st.cached ? " — showing the last cached copy" : ""}`

    main.append(name, url, note)

    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const del = document.createElement("button")
    del.className = "mkt-btn del"
    del.textContent = "Remove"
    del.onclick = async () => {
      if (!(await showConfirm(`Remove the marketplace “${reg.name || reg.url}”?`))) return
      const res = await vibe.registryRemove({ id: reg.id })
      if (!res || !res.ok) {
        alert("Remove failed: " + ((res && res.error) || "unknown"))
        return
      }
      await loadMarketplace()
    }
    actions.appendChild(del)

    row.append(main, actions)
    list.appendChild(row)
  }
}

if ($("mkt-reg-add")) {
  $("mkt-reg-add").onclick = async () => {
    const urlInput = $("mkt-reg-url")
    const nameInput = $("mkt-reg-name")
    const url = String(urlInput?.value || "").trim()
    if (!url) {
      alert("Enter the registry URL first.")
      return
    }
    const btn = $("mkt-reg-add")
    btn.disabled = true
    btn.textContent = "Adding…"
    try {
      const res = await vibe.registryAdd({ name: String(nameInput?.value || "").trim(), url })
      if (!res || !res.ok) {
        alert("Could not add the marketplace: " + ((res && res.error) || "unknown"))
        return
      }
      if (urlInput) urlInput.value = ""
      if (nameInput) nameInput.value = ""
      await loadMarketplace(true)
    } finally {
      btn.disabled = false
      btn.textContent = "Add registry"
    }
  }
}

async function loadMarketplace(refresh = false) {
  const btn = $("mkt-refresh")
  if (btn) {
    btn.disabled = true
    btn.textContent = "… Loading"
  }
  try {
    const res = await vibe.marketplace({ directory: cfgDir(), kind: "all", refresh: !!refresh })
    if (!res.ok) throw new Error(res.error || "Could not load the marketplace")
    marketState.items = Array.isArray(res.data?.items) ? res.data.items : []
    marketState.counts = res.data?.counts || {}
    marketState.registries = Array.isArray(res.data?.registries) ? res.data.registries : []
    marketState.registryStatus = Array.isArray(res.data?.registryStatus) ? res.data.registryStatus : []

    for (const k of ["all", "mcp", "plugin", "skill"]) {
      const el = $("mkt-count-" + k)
      if (el) el.textContent = String(marketState.counts[k] ?? 0)
    }

    renderMarket()
    renderRegistries()

    const files = $("mkt-files")
    if (files) {
      files.innerHTML = ""
      const note = document.createElement("div")
      note.className = "cfg-note"
      const installed = marketState.counts.installed ?? 0
      note.textContent = `${installed} of ${marketState.counts.all ?? 0} installed. Project items go to .opencode/, global items to the OpenCode config folder.`
      files.appendChild(note)
    }
  } catch (e) {
    const grid = $("mkt-grid")
    if (grid) {
      grid.innerHTML = ""
      const err = document.createElement("div")
      err.className = "cfg-empty"
      err.textContent = "Failed to load: " + String(e.message || e)
      grid.appendChild(err)
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = "⟳ Refresh"
    }
  }
}

if ($("mkt-refresh")) $("mkt-refresh").onclick = () => loadMarketplace(true)
if ($("mkt-search")) {
  $("mkt-search").oninput = () => {
    marketState.query = $("mkt-search").value
    renderMarket()
  }
}
if ($("mkt-chips")) {
  $("mkt-chips").querySelectorAll(".mkt-chip").forEach((chip) => {
    chip.onclick = () => {
      marketState.kind = chip.dataset.kind || "all"
      $("mkt-chips")
        .querySelectorAll(".mkt-chip")
        .forEach((c) => c.classList.toggle("active", c === chip))
      renderMarket()
    }
  })
}

/* ---------- installed skills page ---------- */
// The skills shipped with BDCoder, each with Install / Remove.
function renderBuiltinSkills(items) {
  const list = $("builtin-skill-list")
  if (!list) return
  list.innerHTML = ""
  if (!items.length) {
    const e = document.createElement("div")
    e.className = "cfg-empty"
    e.textContent = "No built-in skills in this build."
    list.appendChild(e)
    return
  }
  for (const item of items) {
    const row = document.createElement("div")
    row.className = "cfg-item cfg-builtin" + (item.installed ? " installed" : "")
    const main = document.createElement("div")
    main.className = "cfg-main"
    const name = document.createElement("div")
    name.className = "cfg-name"
    name.textContent = item.title || item.id
    const meta = document.createElement("div")
    meta.className = "cfg-meta cfg-wrap"
    meta.textContent = item.description || ""
    main.append(name, meta, cfgTagRow(item))
    const actions = document.createElement("div")
    actions.className = "cfg-actions"
    const btn = document.createElement("button")
    btn.className = item.installed ? "del" : "add"
    btn.textContent = item.installed ? "Remove" : "Install"
    btn.onclick = async () => {
      if (item.installed && !(await showConfirm(`Remove skill "${item.title || item.id}"?`))) return
      btn.disabled = true
      btn.textContent = item.installed ? "Removing…" : "Installing…"
      const r = item.installed
        ? await vibe.removeSkill({ id: item.id, directory: cfgDir(), global: item.scope === "global" })
        : await vibe.installSkill({ id: item.id, title: item.title, description: item.description, directory: cfgDir(), global: !!$("builtin-skill-global")?.checked || !cfgDir() })
      if (!r.ok) {
        btn.disabled = false
        btn.textContent = item.installed ? "Remove" : "Install"
        alert((item.installed ? "Remove" : "Install") + " failed: " + (r.error || "unknown"))
        return
      }
      loadSkills()
    }
    actions.appendChild(btn)
    row.append(main, actions)
    list.appendChild(row)
  }
}

async function loadSkills() {
  const btn = $("skills-refresh")
  if (btn) {
    btn.disabled = true
    btn.textContent = "… Loading"
  }
  try {
    const res = await vibe.marketplace({ directory: cfgDir(), kind: "skill" })
    if (!res.ok) throw new Error(res.error || "Could not load skills")

    renderBuiltinSkills((res.data?.items || []).filter((i) => !i.custom))
    const items = (res.data?.items || []).filter((i) => i.installed)
    const list = $("skills-list")
    list.innerHTML = ""
    $("skills-count").textContent = String(items.length)

    if (!items.length) {
      const e = document.createElement("div")
      e.className = "cfg-empty"
      e.textContent = "No skills installed yet — open the Marketplace to add one."
      list.appendChild(e)
    } else {
      for (const item of items) {
        const row = document.createElement("div")
        row.className = "cfg-item"

        const main = document.createElement("div")
        main.className = "cfg-main"
        const name = document.createElement("div")
        name.className = "cfg-name"
        name.textContent = item.title
        const meta = document.createElement("div")
        meta.className = "cfg-meta cfg-wrap"
        meta.textContent = item.description
        const path = document.createElement("div")
        path.className = "cfg-meta mono"
        path.textContent = item.path || ""
        main.append(name, meta, path)

        const actions = document.createElement("div")
        actions.className = "cfg-actions"
        const del = document.createElement("button")
        del.className = "del"
        del.textContent = "Remove"
        del.onclick = async () => {
          if (!(await showConfirm(`Remove skill "${item.title}"?`))) return
          del.disabled = true
          const r = await vibe.removeSkill({
            id: item.id,
            directory: cfgDir(),
            global: item.scope === "global",
          })
          if (!r.ok) {
            del.disabled = false
            alert("Remove failed: " + (r.error || "unknown"))
            return
          }
          await loadSkills()
        }
        actions.appendChild(del)

        row.append(main, cfgBadge(item.scope), actions)
        list.appendChild(row)
      }
    }

    const files = $("skills-files")
    if (files) {
      files.innerHTML = ""
      const note = document.createElement("div")
      note.className = "cfg-note"
      note.textContent =
        "Skills are Markdown files with frontmatter (name, description). BDCoder picks them up automatically."
      files.appendChild(note)
    }
  } catch (e) {
    const list = $("skills-list")
    if (list) {
      list.innerHTML = ""
      const err = document.createElement("div")
      err.className = "cfg-empty"
      err.textContent = "Failed to load: " + String(e.message || e)
      list.appendChild(err)
    }
  } finally {
    if (btn) {
      btn.disabled = false
      btn.textContent = "⟳ Refresh"
    }
  }
}

if ($("skills-refresh")) $("skills-refresh").onclick = () => loadSkills()
if ($("skills-github-import")) {
  $("skills-github-import").onclick = async () => {
    const btn = $("skills-github-import")
    const input = $("skills-github-source")
    const status = $("skills-github-status")
    const source = String(input?.value || "").trim()
    if (!source) {
      status.textContent = "Enter owner/repo or a public GitHub repository/folder URL."
      input?.focus()
      return
    }
    const global = !!$("skills-github-global")?.checked
    const target = global ? "the global OpenCode skills directory" : `the current project (${cfgDir()})`
    const approved = await showConfirm(
      `Import Agent Skills from ${source} into ${target}?\n\nThe SKILL.md instructions are untrusted project content. They will not run automatically; the agent will load a skill only when relevant. Continue only if you trust this repository.`
    )
    if (!approved) return
    btn.disabled = true
    btn.textContent = "Importing…"
    status.textContent = "Downloading and validating public GitHub skill files…"
    status.classList.remove("cfg-file", "bad")
    try {
      const result = await vibe.importGitHubSkills({ source, global, directory: cfgDir() })
      if (!result || result.ok === false) throw new Error(result?.error || "Import failed")
      const data = result.data || result
      const installed = Number(data.count) || (Array.isArray(data.installed) ? data.installed.length : 0)
      status.textContent = `Imported ${installed} skill${installed === 1 ? "" : "s"} from ${data.source || source}. Refreshing discovered skills…`
      input.value = ""
      await loadSkills()
    } catch (error) {
      status.textContent = `Import failed: ${String(error?.message || error)}`
      status.classList.add("cfg-file", "bad")
    } finally {
      btn.disabled = false
      btn.textContent = "Import"
    }
  }
}
if ($("skills-open-market")) {
  $("skills-open-market").onclick = () => {
    const nav = document.querySelector('.settings-nav .nav-item[data-page="marketplace"]')
    if (nav) nav.click()
  }
}

function parseKeyValues(text) {
  const out = {}
  for (const part of String(text || "").split(/[,\n]/)) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

if ($("mcp-type")) {
  $("mcp-type").onchange = () => {
    const remote = $("mcp-type").value === "remote"
    $("mcp-local-row").hidden = remote
    $("mcp-remote-row").hidden = !remote
    $("mcp-add-hint").textContent = remote
      ? "Remote servers connect over HTTP(S). Headers are optional (KEY=value, comma separated)."
      : "Local servers run a command (stdio). Environment variables are optional (KEY=value, comma separated)."
  }
}
if ($("mcp-refresh")) $("mcp-refresh").onclick = () => loadMcp()
if ($("plugin-refresh")) $("plugin-refresh").onclick = () => loadPlugins()

if ($("mcp-add-btn")) {
  $("mcp-add-btn").onclick = async () => {
    const name = $("mcp-name").value.trim()
    const type = $("mcp-type").value
    const global = $("mcp-global").checked
    const pairs = parseKeyValues($("mcp-env").value)
    if (!name) return alert("Enter a server name")
    if (type === "remote" && !$("mcp-url").value.trim()) return alert("Enter the server URL")
    if (type === "local" && !$("mcp-command").value.trim()) return alert("Enter the command to run")
    const btn = $("mcp-add-btn")
    btn.disabled = true
    btn.textContent = "Adding…"
    try {
      const res = await vibe.mcpAdd({
        name,
        type,
        url: $("mcp-url").value.trim(),
        command: $("mcp-command").value.trim(),
        env: type === "local" ? pairs : undefined,
        headers: type === "remote" ? pairs : undefined,
        global,
        directory: cfgDir(),
      })
      if (!res.ok) throw new Error(res.error || "mcp add failed")
      $("mcp-name").value = ""
      $("mcp-command").value = ""
      $("mcp-url").value = ""
      $("mcp-env").value = ""
      await loadMcp()
    } catch (e) {
      alert("Add failed: " + String(e.message || e))
    } finally {
      btn.disabled = false
      btn.textContent = "Add server"
    }
  }
}

if ($("plugin-add-btn")) {
  $("plugin-add-btn").onclick = async () => {
    const spec = $("plugin-add-input").value.trim()
    if (!spec) return alert("Enter a plugin package or Git specifier")
    const btn = $("plugin-add-btn")
    btn.disabled = true
    btn.textContent = "Installing…"
    try {
      const res = await vibe.pluginAdd({ spec, directory: cfgDir() })
      if (!res.ok) throw new Error(res.error || "plugin add failed")
      $("plugin-add-input").value = ""
      await loadPlugins()
    } catch (e) {
      alert("Add failed: " + String(e.message || e))
    } finally {
      btn.disabled = false
      btn.textContent = "Add"
    }
  }
}

// "+ Add provider" / Refresh on the Model settings page
// (looked up on click: startNewProvider is defined in app/models.js, loaded after this file)
document.querySelector(".add-provider")?.addEventListener("click", (event) => startNewProvider(event))
document.querySelector(".model-head .icon-btn.square")?.addEventListener("click", async (event) => {
  const btn = event.currentTarget
  if (btn) { btn.disabled = true; btn.textContent = "…" }
  try {
    await refreshProviderStateLive()
  } catch (error) {
    showError("Could not refresh provider profiles", String(error?.message || error), { key: "providers-refresh" })
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "⟳" }
  }
})

