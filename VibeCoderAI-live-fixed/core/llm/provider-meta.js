"use strict"
/**
 * Provider URL repair + model metadata (context window / image support) - engine source level.
 * Every client (CLI `vibe profile add`, SDK, the desktop app) benefits because
 * profiles.upsertProfile() runs repairProfile() before saving.
 *
 * - Console / dashboard URLs (console.groq.com/home, console.x.ai, platform.openai.com, ...)
 *   are NOT API endpoints - the adapters would call e.g. console.groq.com/chat/completions
 *   and get HTML/404. repairBaseUrl() rewrites those to the real API base for our 3 formats.
 * - A host only speaks the formats it really serves (Groq has no /responses - openai-responses
 *   there is always a 404), so a wrong format is corrected to one the endpoint supports.
 * - Model metadata lookup order: the provider's own endpoint -> the models.dev catalog
 *   (cached in ~/.vibe/models.dev.json) -> built-in table -> name heuristics.
 */
const fs = require("fs")
const path = require("path")
const { homeDir } = require("../util")

/* UI ("chat"|"responses"|"anthropic") <-> engine ("openai-chat"|...) format names */
const TO_UI = { chat: "chat", responses: "responses", anthropic: "anthropic", "openai-chat": "chat", "openai-responses": "responses" }
const TO_ENGINE = { chat: "openai-chat", responses: "openai-responses", anthropic: "anthropic" }

/* ---------- dashboard / console -> API base (+ the format it speaks) ---------- */
const KNOWN = {
  "console.groq.com": ["https://api.groq.com/openai/v1", "chat"],
  "groq.com": ["https://api.groq.com/openai/v1", "chat"],
  "www.groq.com": ["https://api.groq.com/openai/v1", "chat"],
  "console.x.ai": ["https://api.x.ai/v1", "chat"],
  "x.ai": ["https://api.x.ai/v1", "chat"],
  "www.x.ai": ["https://api.x.ai/v1", "chat"],
  "docs.x.ai": ["https://api.x.ai/v1", "chat"],
  "platform.openai.com": ["https://api.openai.com/v1", "chat"],
  "platform.chatgpt.com": ["https://api.openai.com/v1", "chat"],
  "openai.com": ["https://api.openai.com/v1", "chat"],
  "www.openai.com": ["https://api.openai.com/v1", "chat"],
  "console.anthropic.com": ["https://api.anthropic.com", "anthropic"],
  "anthropic.com": ["https://api.anthropic.com", "anthropic"],
  "www.anthropic.com": ["https://api.anthropic.com", "anthropic"],
  "docs.anthropic.com": ["https://api.anthropic.com", "anthropic"],
  "aistudio.google.com": ["https://generativelanguage.googleapis.com/v1beta/openai", "chat"],
  "console.gemini.google.com": ["https://generativelanguage.googleapis.com/v1beta/openai", "chat"],
  "openrouter.ai": ["https://openrouter.ai/api/v1", "chat"],
  "deepseek.com": ["https://api.deepseek.com/v1", "chat"],
  "platform.deepseek.com": ["https://api.deepseek.com/v1", "chat"],
}

const ENDPOINT_SUFFIX = /\/(chat\/completions|completions|responses|messages|models|api\/show)$/i

/* Which formats each real API host actually serves.
   Groq is the classic trap: it has NO /responses endpoint - only /chat/completions. */
const HOST_FORMATS = {
  "api.groq.com": ["chat"],
  "api.deepseek.com": ["chat"],
  "api.openai.com": ["chat", "responses"],
  "api.x.ai": ["chat", "responses"],
  "api.anthropic.com": ["anthropic"],
  "generativelanguage.googleapis.com": ["chat"],
  "openrouter.ai": ["chat"],
}

/**
 * repairBaseUrl(raw, format) -> { url, changed, format, engineFormat, hint }
 * `format` may be a UI name ("chat") or an engine name ("openai-chat"); it is optional.
 * `format`/`engineFormat` in the result are set only for hosts we know the capability of.
 */
function repairBaseUrl(raw, format) {
  const fmtIn = TO_UI[String(format || "").toLowerCase()] || ""
  let s = String(raw || "").trim()
  if (!s) return { url: "", changed: false }
  if (!/^https?:\/\//i.test(s)) s = "https://" + s
  let u
  try {
    u = new URL(s)
  } catch {
    return { url: s, changed: false }
  }
  const host = u.hostname.toLowerCase()
  const hit = KNOWN[host]
  if (hit) {
    const changed = u.origin + u.pathname.replace(/\/+$/, "") !== hit[0]
    return {
      url: hit[0],
      changed,
      format: hit[1],
      engineFormat: TO_ENGINE[hit[1]],
      hint: `${host} is the console/dashboard - the API base is ${hit[0]} (${hit[1]} format)`,
    }
  }
  // the real API hosts: complete / clean the path the adapters expect
  let p = u.pathname.replace(/\/+$/, "").replace(ENDPOINT_SUFFIX, "")
  let hint = ""
  if (host === "api.groq.com" && !/\/openai\/v1$/i.test(p)) {
    p = "/openai/v1"
    hint = "Groq's chat API lives at https://api.groq.com/openai/v1"
  }
  // the anthropic adapter appends /v1/messages itself: a root must NOT carry /v1
  if ((fmtIn || (hit && hit[1])) === "anthropic") p = p.replace(/\/v1$/i, "")
  const url = u.origin + (p === "/" ? "" : p)
  // host format capability: pick a format the endpoint really has (Groq + responses = always 404)
  let fmt
  const allowed = HOST_FORMATS[host]
  if (allowed) {
    fmt = fmtIn && allowed.includes(fmtIn) ? fmtIn : allowed[0]
    if (fmtIn && fmt !== fmtIn) hint = `${host} has no /${fmtIn} endpoint - using ${fmt} format instead`
  }
  const out = { url, changed: url !== String(raw || "").trim(), hint }
  const f = fmt || (hit && hit[1])
  if (f) {
    out.format = f
    out.engineFormat = TO_ENGINE[f]
  }
  return out
}

/**
 * repairProfile({ baseURL, format, ... }) -> { baseURL, format, hints }
 * Used by profiles.upsertProfile so EVERY way of adding a provider gets the same fix.
 * `format` is the engine format here; it is only rewritten for hosts with a known capability.
 */
function repairProfile(profile) {
  const out = { baseURL: profile.baseURL, format: profile.format, hints: [] }
  if (!profile.baseURL) return out
  const fixed = repairBaseUrl(profile.baseURL, profile.format)
  if (fixed.url && fixed.url !== profile.baseURL) {
    out.hints.push(`base URL "${profile.baseURL}" -> "${fixed.url}"`)
    out.baseURL = fixed.url
  }
  if (fixed.engineFormat && fixed.engineFormat !== profile.format) {
    out.hints.push(`format "${profile.format}" -> "${fixed.engineFormat}" (${fixed.hint || fixed.url + " does not serve " + profile.format})`)
    out.format = fixed.engineFormat
  }
  if (fixed.hint && !out.hints.length) out.hints.push(fixed.hint)
  return out
}

/* ---------- provider's own model list ---------- */
function listHeaders(format, apiKey) {
  const h = {}
  if (format === "anthropic") {
    h["x-api-key"] = apiKey || ""
    h["anthropic-version"] = "2023-06-01"
    // Anthropic-format gateways often whitelist known Claude clients (401 otherwise);
    // api.anthropic.com ignores these headers. Keep in sync with anthropic.js.
    h["user-agent"] = "claude-cli/2.0.60 (external, cli)"
    h["x-app"] = "cli"
  } else if (apiKey) h.authorization = `Bearer ${apiKey}`
  return h
}

/** GET the provider's model list. Returns [{id, context, output, image}] (limits when the provider gives them). */
async function listRemoteModels({ baseURL, apiKey, format = "chat" }) {
  const base = String(baseURL || "").replace(/\/+$/, "")
  if (!base) throw new Error("Enter the base URL first")
  let url, headers
  if (/11434/.test(base)) {
    // Ollama native API
    url = base.replace(/\/v1$/i, "") + "/api/tags"
    headers = {}
  } else if (format === "anthropic") {
    url = base.replace(/\/v1$/i, "") + "/v1/models"
    headers = listHeaders("anthropic", apiKey)
  } else {
    url = base + "/models"
    headers = listHeaders(format, apiKey)
  }
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  } catch (e) {
    throw new Error(`Could not reach ${url} (${e.name === "TimeoutError" ? "timeout" : e.message})`)
  }
  if (res.status === 401 || res.status === 403) throw new Error(`The provider rejected this API key (${res.status})`)
  if (res.status === 404) throw new Error(`${url} answered 404 - is this the API root? Groq: https://api.groq.com/openai/v1, xAI: https://api.x.ai/v1, OpenAI: https://api.openai.com/v1`)
  if (!res.ok) throw new Error(`Provider answered ${res.status}`)
  const j = await res.json().catch(() => ({}))
  const raw = Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : Array.isArray(j.data) ? j.data : []
  const out = []
  for (const m of raw) {
    if (!m) continue
    if (typeof m === "string") {
      out.push({ id: m, context: 0, output: 0, image: false })
      continue
    }
    const id = m.id || m.name
    if (!id) continue
    const context = Number(m.context_length || m.context_window || m.max_context_length || (m.limits && m.limits.context) || (m.model_info && m.model_info["general.context_length"]) || 0)
    const output = Number((m.limits && m.limits.output) || m.max_output_tokens || 0)
    const mods = m.architecture && m.architecture.input_modalities
    const image = Array.isArray(mods) ? mods.includes("image") : !!(m.supports && m.supports.image)
    out.push({ id, context, output, image })
  }
  return out
}

/** Ollama's /api/show carries the real context window; presence of a vision projector = image support. */
async function ollamaShow(baseURL, modelId) {
  try {
    const base = String(baseURL || "").replace(/\/v1$/i, "").replace(/\/+$/, "")
    const res = await fetch(base + "/api/show", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelId }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const j = await res.json()
    const info = j.model_info || {}
    const context = Number(info["general.context_length"] || 0)
    const image = !!(j.projector_filename || j.projector || Object.keys(info).some((k) => /vision|clip|mmproj/i.test(k)))
    return { context, output: 0, image, source: "provider (ollama)" }
  } catch {
    return null
  }
}

/* ---------- models.dev catalog (cached) ---------- */
const catalogCacheFile = () => path.join(homeDir(), "models.dev.json")
let catalogMem = null

function catalogFresh() {
  const f = catalogCacheFile()
  try {
    const st = fs.statSync(f)
    if (Date.now() - st.mtimeMs < 3 * 86400000) return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {}
  return null
}
function catalogStale() {
  try {
    return JSON.parse(fs.readFileSync(catalogCacheFile(), "utf8"))
  } catch {
    return null
  }
}

function reloadModelsDevFromDisk() {
  try {
    catalogMem = JSON.parse(fs.readFileSync(catalogCacheFile(), "utf8"))
    return true
  } catch {
    catalogMem = null
    return false
  }
}

async function modelsDev(force = false) {
  if (catalogMem && !force) return catalogMem
  if (!force) {
    const fresh = catalogFresh()
    if (fresh) return (catalogMem = fresh)
  }
  try {
    const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(String(res.status))
    const j = await res.json()
    fs.mkdirSync(path.dirname(catalogCacheFile()), { recursive: true })
    fs.writeFileSync(catalogCacheFile(), JSON.stringify(j))
    return (catalogMem = j)
  } catch {
    return catalogStale() || {}
  }
}

function catalogLookup(catalog, modelId, providerHint) {
  const want = String(modelId || "").toLowerCase()
  const wantTail = want.split("/").pop()
  let exact = null
  let tailHit = null
  let contains = null
  for (const [pid, prov] of Object.entries(catalog)) {
    const models = prov && prov.models
    if (!models) continue
    for (const [mid, m] of Object.entries(models)) {
      const low = mid.toLowerCase()
      const limit = (m && m.limit) || {}
      const meta = {
        context: Number(limit.context || 0),
        output: Number(limit.output || 0),
        image: !!(m && m.modalities && Array.isArray(m.modalities.input) && m.modalities.input.includes("image")),
        source: `models.dev (${m.id || mid})`,
      }
      const score = pid === providerHint ? 2 : 1
      if (low === want && (!exact || exact.score < score)) exact = { score, meta }
      else if (low.split("/").pop() === wantTail && (!tailHit || tailHit.score < score)) tailHit = { score, meta }
      else if ((low.includes(want) || want.includes(low)) && want.length > 5 && (!contains || contains.score < score)) contains = { score, meta }
    }
  }
  return (exact && exact.meta) || (tailHit && tailHit.meta) || (contains && contains.meta) || null
}

/* ---------- offline fallbacks ---------- */
const BUILTIN = [
  { re: /^claude-(opus|sonnet|haiku)/i, context: 200000, output: 64000, image: true },
  { re: /^anthropic\//i, context: 200000, output: 64000, image: true },
  { re: /^grok-4/i, context: 256000, output: 32000, image: true },
  { re: /^grok-3/i, context: 131072, output: 8192, image: false },
  { re: /^gpt-(4o|4\.1|4-turbo|4\.2|5)/i, context: 128000, output: 16384, image: true },
  { re: /^gpt-oss-/i, context: 131072, output: 32768, image: false },
  { re: /^o[134]-/i, context: 200000, output: 100000, image: false },
  { re: /^llama-3\.[123]/i, context: 128000, output: 32768, image: false },
  { re: /^llama-4/i, context: 131072, output: 16384, image: true },
  { re: /^deepseek-(chat|reasoner|v3|r1)/i, context: 64000, output: 8192, image: false },
  { re: /^gemini-2/i, context: 1048576, output: 65536, image: true },
  { re: /^mistral-(large|small|nemo)/i, context: 128000, output: 16384, image: false },
  { re: /^magistral/i, context: 40000, output: 8192, image: true },
  { re: /^qwen(2\.5|3)(-|$)/i, context: 131072, output: 16384, image: false },
  { re: /^devstral/i, context: 128000, output: 16384, image: false },
  { re: /vision/i, context: 128000, output: 8192, image: true },
]

function builtinLookup(modelId) {
  const id = String(modelId || "")
  const hit = BUILTIN.find((b) => b.re.test(id))
  return hit ? { context: hit.context, output: hit.output, image: hit.image, source: "built-in table" } : null
}

/* ---------- the one call every client needs ---------- */
/**
 * lookupModel({ modelId, baseURL?, apiKey?, format? })
 * -> { found, context, output, image, source }
 */
async function lookupModel({ modelId, baseURL, apiKey, format = "chat" } = {}) {
  const id = String(modelId || "").trim()
  if (!id) return { found: false }
  const fmt = TO_UI[String(format || "chat").toLowerCase()] || "chat"
  let inProviderList = false
  // 1) the provider itself (only reliable when it exposes limits)
  if (baseURL) {
    if (/11434/.test(baseURL)) {
      const show = await ollamaShow(baseURL, id)
      if (show && (show.context || show.image)) return { found: true, ...show }
    }
    try {
      const list = await listRemoteModels({ baseURL, apiKey, format: fmt })
      const mine = list.find((m) => m.id === id || m.id.toLowerCase() === id.toLowerCase())
      if (mine) {
        inProviderList = true
        if (mine.context || mine.image) {
          return { found: true, context: mine.context || 0, output: mine.output || 0, image: !!mine.image, source: "provider" }
        }
      }
    } catch {}
  }
  // 2) models.dev catalog
  try {
    const catalog = await modelsDev()
    const providerHint = baseURL ? (new URL(repairBaseUrl(baseURL).url).hostname.split(".")[1] || "").toLowerCase() : ""
    const hit = catalogLookup(catalog, id, providerHint)
    if (hit && hit.context) return { found: true, ...hit }
  } catch {}
  // 3) built-in table
  const b = builtinLookup(id)
  if (b) return { found: true, ...b }
  // 4) the provider knows the model but nothing else is known
  if (inProviderList) return { found: true, context: 0, output: 0, image: false, source: "provider (no limits published)" }
  return { found: false }
}

module.exports = { repairBaseUrl, repairProfile, listRemoteModels, ollamaShow, modelsDev, reloadModelsDevFromDisk, catalogLookup, builtinLookup, lookupModel, KNOWN, HOST_FORMATS, TO_UI, TO_ENGINE }
