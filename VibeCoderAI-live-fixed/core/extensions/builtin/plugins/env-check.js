"use strict"
// VibeCoder built-in plugin: which settings from .env.example are missing in
// .env. Shows only the NAMES of the settings, never their values. Read-only.
const fs = require("fs")
const path = require("path")

const keysOf = (file) => {
  const keys = new Map()
  let text = ""
  try { text = fs.readFileSync(file, "utf8") } catch { return null }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line)
    if (m) keys.set(m[1], m[2].trim().replace(/^["']|["']$/g, "") !== "")
  }
  return keys
}

module.exports = {
  tools: [{
    name: "env_check",
    description: "Compare the project's .env.example / .env.sample / .env.template with .env: lists settings that are missing or empty in .env and settings that are not documented in the example. Shows names only, never values. Read-only.",
    parameters: { type: "object", properties: {} },
    // Reads .env, so the usual .env rule applies (it asks unless allowed).
    perm: (_args, ctx = {}) => ({ tool: "read", subject: path.join(ctx.cwd || process.cwd(), ".env") }),
    run: async (_args, ctx = {}) => {
      const root = ctx.cwd || process.cwd()
      const exampleName = [".env.example", ".env.sample", ".env.template", ".env.dist"].find((f) => fs.existsSync(path.join(root, f)))
      const example = exampleName ? keysOf(path.join(root, exampleName)) : null
      const env = keysOf(path.join(root, ".env"))
      if (!example && !env) return "No .env or .env.example file in this project."
      if (!example) return `.env has ${env.size} setting(s), but there is no .env.example to compare with. Consider adding one (names only, no secret values).`
      if (!env) return `${exampleName} lists ${example.size} setting(s) and there is no .env yet. Needed: ${[...example.keys()].join(", ")}`
      const missing = [...example.keys()].filter((k) => !env.has(k))
      const empty = [...example.keys()].filter((k) => env.has(k) && !env.get(k))
      const extra = [...env.keys()].filter((k) => !example.has(k))
      return [
        `Compared ${exampleName} (${example.size}) with .env (${env.size}).`,
        `Missing in .env: ${missing.join(", ") || "none"}`,
        `Empty in .env: ${empty.join(", ") || "none"}`,
        `In .env but not documented in ${exampleName}: ${extra.join(", ") || "none"}`,
      ].join("\n")
    },
  }],
}
