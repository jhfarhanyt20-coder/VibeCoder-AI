"use strict"
/**
 * Extensions — cached tool modules with a tiny lifecycle.
 *
 * Native locations:
 *   <home>/extensions/*.js
 *   <workspace>/.vibe/extensions/*.js
 *
 * Existing plugin folders remain compatible. A module may export one tool, an
 * array, or `{ tools, hooks }`. Supported hooks: onLoad, onUnload, onEvent,
 * beforeAction and afterAction. Hook failures never crash the engine.
 */
const fs = require("node:fs")
const path = require("node:path")
const { homeDir } = require("../util")

const safeId = (value) => String(value || "extension").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "extension"

class ExtensionManager {
  constructor({ home } = {}) {
    this.home = home || homeDir()
    this.loaded = new Map()
  }

  _sources(directory) {
    return [
      { dir: path.join(this.home, "plugins"), scope: "global", legacy: true },
      { dir: path.join(this.home, "extensions"), scope: "global", legacy: false },
      ...(directory ? [
        { dir: path.join(directory, ".vibe", "plugins"), scope: "project", legacy: true },
        { dir: path.join(directory, ".vibe", "extensions"), scope: "project", legacy: false },
      ] : []),
    ]
  }

  discover(directory) {
    const found = new Map()
    for (const source of this._sources(directory)) {
      let entries = []
      try { entries = fs.readdirSync(source.dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || entry.isSymbolicLink() || !/\.js$/i.test(entry.name)) continue
        const file = path.join(source.dir, entry.name)
        const id = safeId(path.basename(entry.name, path.extname(entry.name)))
        try {
          const st = fs.statSync(file)
          found.set(id, { id, file, scope: source.scope, legacy: source.legacy, signature: `${file}|${st.size}|${st.mtimeMs}` })
        } catch {}
      }
    }
    return [...found.values()]
  }

  _hook(record, name, payload) {
    const fn = record?.hooks?.[name]
    if (typeof fn !== "function") return
    try {
      const value = fn(payload)
      if (value && typeof value.then === "function") value.catch(() => {})
    } catch {}
  }

  _unload(record) {
    this._hook(record, "onUnload", { id: record.id, file: record.file, scope: record.scope })
    try { delete require.cache[require.resolve(record.file)] } catch {}
  }

  _load(row) {
    try {
      delete require.cache[require.resolve(row.file)]
      const mod = require(row.file)
      const rawTools = Array.isArray(mod) ? mod : Array.isArray(mod?.tools) ? mod.tools : mod?.name ? [mod] : []
      const hooks = !Array.isArray(mod) && mod && typeof mod === "object" ? (mod.hooks || {}) : {}
      const record = { ...row, ok: true, error: "", rawTools, hooks }
      this._hook(record, "onLoad", { id: row.id, file: row.file, scope: row.scope })
      return record
    } catch (error) {
      return { ...row, ok: false, error: error?.message || String(error), rawTools: [], hooks: {} }
    }
  }

  sync(directory) {
    const rows = this.discover(directory)
    const wanted = new Map(rows.map((row) => [row.id, row]))
    for (const [id, current] of this.loaded) {
      const row = wanted.get(id)
      if (!row || row.signature !== current.signature) {
        this._unload(current)
        this.loaded.delete(id)
      }
    }
    for (const row of rows) if (!this.loaded.has(row.id)) this.loaded.set(row.id, this._load(row))
    return this.status()
  }

  status() {
    return [...this.loaded.values()].map((record) => ({ id: record.id, file: record.file, scope: record.scope, legacy: record.legacy, ok: record.ok, error: record.error, tools: record.rawTools.length }))
  }

  event(event) {
    for (const record of this.loaded.values()) if (record.ok) this._hook(record, "onEvent", event)
  }

  toolObjects(directory) {
    this.sync(directory)
    const coreTools = require("../tools")
    const out = []
    for (const record of this.loaded.values()) {
      if (!record.ok) continue
      for (const raw of record.rawTools) {
        if (!raw || !raw.name || typeof raw.run !== "function") continue
        const prefix = record.legacy ? "plugin" : "extension"
        const declared = String(raw.name).includes("__") ? String(raw.name) : `${prefix}__${record.id}__${String(raw.name).replace(/[^\w-]/g, "_")}`
        out.push({
          name: declared.slice(0, 64),
          description: String(raw.description || `${record.id} extension action`).slice(0, 1200),
          parameters: raw.parameters && typeof raw.parameters === "object" ? raw.parameters : { type: "object", properties: {} },
          perm: raw.perm || (() => ({ tool: record.legacy ? "plugin" : "extension", subject: declared })),
          paths: raw.paths || (() => []),
          run: async (args, context) => {
            const payload = { extension: record.id, tool: declared, args, context }
            if (typeof record.hooks.beforeAction === "function") {
              try { await record.hooks.beforeAction(payload) } catch {}
            }
            let value
            let error
            try {
              value = await raw.run(args, { ...context, home: this.home, extension: record.id })
              return typeof value === "string" ? coreTools.clip(value) : value
            } catch (caught) {
              error = caught
              throw caught
            } finally {
              if (typeof record.hooks.afterAction === "function") {
                try { await record.hooks.afterAction({ ...payload, value, error }) } catch {}
              }
            }
          },
        })
      }
    }
    return out
  }

  close() {
    for (const record of this.loaded.values()) this._unload(record)
    this.loaded.clear()
  }
}

module.exports = { ExtensionManager }
