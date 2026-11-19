"use strict"
/**
 * vibecoder_help: the agent's own product guide (core/knowledge/vibecoder.md).
 * Any model can answer questions about VibeCoder itself — features, settings,
 * shortcuts, models, Computer Use, Connectors, CLI, updates, privacy — from the
 * real guide instead of guessing. Read-only; offered in the app and the CLI.
 */
const fs = require("node:fs")
const path = require("node:path")

const GUIDE_FILE = path.join(__dirname, "..", "knowledge", "vibecoder.md")
let cache = null

function sections() {
  if (cache) return cache
  const text = fs.readFileSync(GUIDE_FILE, "utf8").replace(/\r\n/g, "\n")
  const parts = text.split(/\n(?=## )/)
  cache = parts.slice(1).map((part) => {
    const lines = part.split("\n")
    const title = lines[0].replace(/^##\s*/, "").trim()
    const kwLine = lines.find((l) => /^keywords:/i.test(l)) || ""
    const keywords = kwLine.replace(/^keywords:\s*/i, "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean)
    const body = lines.slice(1).filter((l) => !/^keywords:/i.test(l)).join("\n").trim()
    return { title, keywords, body }
  })
  return cache
}

function version() {
  try { return require(path.join(__dirname, "..", "..", "package.json")).version } catch { return "" }
}

function score(sec, words, raw) {
  let s = 0
  const hay = `${sec.title} ${sec.body}`.toLowerCase()
  for (const k of sec.keywords) if (raw.includes(k)) s += k.includes(" ") ? 6 : 4
  for (const w of words) {
    if (w.length < 3) continue
    if (sec.title.toLowerCase().includes(w)) s += 3
    if (sec.keywords.some((k) => k.includes(w))) s += 2
    if (hay.includes(w)) s += 1
  }
  return s
}

const vibecoderHelp = {
  name: "vibecoder_help",
  description:
    "The official VibeCoder AI product guide. Use it whenever the user asks about VibeCoder itself — what it is, who made it, website or GitHub, " +
    "features, settings, keyboard shortcuts, models/providers/API keys, free models and limits, Fallback model, permissions, Rewind, Computer Use, " +
    "Browser Use, Connectors (GitHub), Marketplace/MCP/plugins/skills, memory, the CLI and its commands, updates, privacy/terms, usage/cost, or troubleshooting. " +
    "Give topic words (e.g. \"computer use\", \"openrouter base url\", \"shortcuts\"); leave it empty for the table of contents.",
  parameters: {
    type: "object",
    properties: { topic: { type: "string", description: "What the user asked about, in a few words" } },
    required: [],
  },
  perm: () => ({ tool: "vibecoder_help", subject: "guide" }),
  paths: () => [],
  async run(a = {}) {
    const all = sections()
    const head = `VibeCoder AI${version() ? ` v${version()}` : ""} — product guide.`
    const raw = String(a.topic || "").toLowerCase().trim()
    if (!raw) {
      return `${head} Topics: ${all.map((s) => s.title).join(" · ")}.\nCall vibecoder_help again with a topic to read it.\n\n## ${all[0].title}\n${all[0].body}`
    }
    const words = raw.split(/[^a-z0-9+.#@/$-]+/).filter(Boolean)
    const ranked = all.map((s) => ({ s, n: score(s, words, raw) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 3)
    if (!ranked.length) {
      return `${head} Nothing in the guide matches "${a.topic}". Do not guess: tell the user you are not sure, and point them to https://vibecoderai.onrender.com or GitHub issues. Topics in the guide: ${all.map((s) => s.title).join(" · ")}.`
    }
    return `${head}\n\n${ranked.map((x) => `## ${x.s.title}\n${x.s.body}`).join("\n\n")}\n\nAnswer from this text only; if it does not cover the question, say so.`
  },
}

module.exports = { ALL: [vibecoderHelp], sections }
