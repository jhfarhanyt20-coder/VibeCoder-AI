"use strict"
// VibeCoder built-in plugin: list TODO / FIXME / HACK / BUG notes left in the
// project's code, with file and line. Read-only.
const fs = require("fs")
const path = require("path")

const SKIP = new Set(["node_modules", ".git", "dist", "build", "release", "out", ".next", ".cache", "__pycache__", ".venv", "venv", "coverage", "target", "vendor"])
const TEXT = /\.(m?js|cjs|jsx|tsx?|py|go|rs|java|kt|cs|cpp|cc|c|h|php|rb|swift|dart|html|css|scss|vue|svelte|sql|sh|ps1|md|ya?ml|toml|json)$/i
const MARK = /\b(TODO|FIXME|HACK|BUG|XXX)\b[:\s-]*(.*)/

module.exports = {
  tools: [{
    name: "find_todos",
    description: "List TODO, FIXME, HACK, BUG and XXX notes in the project's code with file:line and the note text. Read-only. Optional `kind` filters one marker, `limit` caps the list (default 200).",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "Only this marker, e.g. FIXME" },
        limit: { type: "number", description: "Most results to return (default 200, max 1000)" },
      },
    },
    perm: () => ({ tool: "read", subject: "todo notes" }),
    run: async (args = {}, ctx = {}) => {
      const root = ctx.cwd || process.cwd()
      const only = args.kind ? String(args.kind).toUpperCase() : ""
      const limit = Math.min(1000, Math.max(1, Number(args.limit) || 200))
      const hits = []
      const counts = {}
      const walk = (dir) => {
        let list = []
        try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const d of list) {
          if (hits.length >= limit) return
          const full = path.join(dir, d.name)
          if (d.isDirectory()) { if (!SKIP.has(d.name) && !d.name.startsWith(".")) walk(full); continue }
          if (!d.isFile() || !TEXT.test(d.name)) continue
          let text = ""
          try { if (fs.statSync(full).size > 1024 * 1024) continue; text = fs.readFileSync(full, "utf8") } catch { continue }
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            const m = MARK.exec(lines[i])
            if (!m || (only && m[1] !== only)) continue
            counts[m[1]] = (counts[m[1]] || 0) + 1
            hits.push(`${path.relative(root, full).split(path.sep).join("/")}:${i + 1}  ${m[1]}  ${m[2].trim().slice(0, 160)}`)
          }
        }
      }
      walk(root)
      if (!hits.length) return only ? `No ${only} notes found.` : "No TODO / FIXME / HACK / BUG notes found."
      const summary = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")
      return `${hits.length} note(s)${hits.length >= limit ? " (limit reached)" : ""} — ${summary}\n` + hits.join("\n")
    },
  }],
}
