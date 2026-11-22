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

/** Common Bangla / Banglish words → the English words the guide is written in. */
const LOCAL_WORDS = [
  [/কম্পিউটার|computer|কম্পিউটার ইউজ/, "computer use"],
  [/ব্রাউজার|browser/, "browser"],
  [/আপডেট|update/, "update"],
  [/মডেল|model/, "model"],
  [/প্রোভাইডার|provider/, "provider"],
  [/ফেসবুক|facebook|fb\b/, "facebook"],
  [/গিটহাব|গিট হাব|github/, "github"],
  [/স্কিল|skill/, "skill"],
  [/প্লাগ-?ইন|plugin/, "plugin"],
  [/এমসিপি|mcp/, "mcp"],
  [/মেমোরি|মেমরি|মনে রাখ/, "memory"],
  [/শেল|টার্মিনাল|কমান্ড/, "shell terminal command"],
  [/সেটিং|সেটিংস/, "settings"],
  [/পারমিশন|অনুমতি/, "permission"],
  [/ভয়েস|ভয়েস/, "voice"],
  [/ভিডিও/, "video"],
  [/সাব-?এজেন্ট/, "subagent"],
  [/ক্রু/, "crew"],
  [/লগইন|লগ ইন|সাইন ইন|একাউন্ট|অ্যাকাউন্ট/, "sign in account"],
  [/রিওয়াইন্ড|আগের অবস্থা|undo/, "rewind"],
  [/এডিটর|কোড প্যানেল/, "code editor"],
  [/থিম/, "theme"],
  [/ছবি|স্ক্রিনশট/, "image screenshot"],
  [/ইন্সটল|ইনস্টল|install/, "install"],
  [/সিএলআই|cli\b/, "cli"],
]

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
    // Topics may come in Bangla or Banglish: add the English words the guide uses.
    const extra = []
    for (const [re, en] of LOCAL_WORDS) if (re.test(raw)) extra.push(en)
    const query = extra.length ? `${raw} ${extra.join(" ")}` : raw
    const words = query.split(/[^\p{L}\p{N}+.#@/$-]+/u).filter(Boolean)
    const ranked = all.map((s) => ({ s, n: score(s, words, query) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, 3)
    if (!ranked.length) {
      return `${head} Nothing in the guide matches "${a.topic}". If the topic was not in English, call vibecoder_help again with English keywords (for example "computer use", "update", "provider"). Otherwise: Do not guess. Tell the user you are not sure, and point them to https://vibecoderai.onrender.com or GitHub issues. Topics in the guide: ${all.map((s) => s.title).join(" · ")}.`
    }
    return `${head}\n\n${ranked.map((x) => `## ${x.s.title}\n${x.s.body}`).join("\n\n")}\n\nAnswer from this text only; if it does not cover the question, say so.`
  },
}

module.exports = { ALL: [vibecoderHelp], sections }
