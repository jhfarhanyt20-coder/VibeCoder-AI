"use strict"
/**
 * Adapter: OpenAI Chat Completions format.
 * Used by OpenAI, Groq (gpt-oss), xAI Grok, DeepSeek, Ollama, LM Studio, vLLM, OpenRouter ...
 * Canonical -> wire, and wire SSE -> canonical events.
 */
const { parseSSE } = require("./sse")
const { postStreamAdaptive, parseRawBody, streamError, COMPAT_CLIENT_HEADERS, prefersCompatClient, rememberCompatClient, authHeaders } = require("./http")
const { newId } = require("../util")
const { openAIUsage } = require("./usage")

function toWire(system, messages) {
  const out = []
  if (system) out.push({ role: "system", content: system })
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
      const calls = m.parts.filter((p) => p.type === "tool_call")
      if (!text && !calls.length) continue
      const msg = { role: "assistant", content: text }
      if (calls.length)
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args == null ? {} : c.args) },
          // Gemini 3 needs its thought_signature back on each function call.
          ...(c.extra && typeof c.extra === "object" ? { extra_content: c.extra } : {}),
        }))
      out.push(msg)
    } else {
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue
        // OpenAI formats have no error flag: mark failures in the text so the model notices.
        out.push({ role: "tool", tool_call_id: p.id, content: p.isError && !/^(error|stopped|paused|interrupted)/i.test(String(p.output)) ? `Error: ${String(p.output)}` : String(p.output) })
        const shot = p.screenshot
        if (shot?.modelVisible !== false && shot?.data) {
          out.push({ role: "user", content: [
            { type: "text", text: (shot.caption ? `${shot.caption}${shot.title ? ` — ${shot.title}` : ""}. Inspect what is on the screen.` : `Browser screenshot${shot.title ? ` — ${shot.title}` : ""}${shot.url ? ` (${shot.url})` : ""}. Inspect the visual state of this page.`) },
            { type: "image_url", image_url: { url: `data:${shot.mime || "image/png"};base64,${shot.data}` } },
          ] })
        }
      }
      const t = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      const imgs = m.parts.filter((p) => p.type === "image" && p.data)
      if (imgs.length) {
        // vision: content array with text + image_url (data: URL) blocks
        const content = []
        if (t) content.push({ type: "text", text: t })
        for (const im of imgs) content.push({ type: "image_url", image_url: { url: `data:${im.mime};base64,${im.data}` } })
        out.push({ role: "user", content })
      } else if (t) out.push({ role: "user", content: t })
    }
  }
  return out
}

function parseArgs(raw) {
  if (!raw || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __parseError: true, raw }
  }
}

// Google's OpenAI-compatible Gemini endpoint.
const isGemini = (profile) => /(^|.)generativelanguage.googleapis.com/i.test(String((profile && profile.baseURL) || ""))
// Gemini model ids are lowercase ("models/gemini-2.5-flash-Lite" is a 400).
const geminiModel = (m) => String(m || "").trim().toLowerCase()
// Gemini 3 rejects a function call without its thought_signature. Calls saved
// before signatures were kept (or made by another model) get Google's
// documented placeholder so the chat can continue.
const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator"
function withGeminiSignatures(wire) {
  for (const m of wire) {
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue
    for (const tc of m.tool_calls) {
      const sig = tc.extra_content && tc.extra_content.google && tc.extra_content.google.thought_signature
      if (!sig) tc.extra_content = { ...(tc.extra_content || {}), google: { ...((tc.extra_content && tc.extra_content.google) || {}), thought_signature: GEMINI_SKIP_SIGNATURE } }
    }
  }
  return wire
}

async function* stream({ profile, apiKey, system, messages, tools, signal }) {
  const q = profile.quirks || {}
  const gemini = isGemini(profile)
  const body = {
    model: gemini ? geminiModel(profile.model) : profile.model,
    messages: gemini ? withGeminiSignatures(toWire(system, messages)) : toWire(system, messages),
    stream: true,
    stream_options: { include_usage: true },
    [q.maxTokensParam || "max_tokens"]: profile.maxOutput || 8192,
    ...(q.extraBody || {}),
  }
  if (tools && tools.length)
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
  if (q.reasoningEffort) body.reasoning_effort = q.reasoningEffort

  // Auth + identification the provider expects (Bearer, Azure api-key, OpenRouter attribution); profile headers win.
  const headers = { ...authHeaders(profile.baseURL, apiKey), ...(profile.headers || {}) }
  // providers that reject an optional parameter: drop / swap it and retry
  const adapt = (err, b) => {
    const t = err.body
    if (b.stream_options && /stream_options|include_usage/i.test(t)) return delete b.stream_options
    if (b.max_tokens != null && /max_completion_tokens/i.test(t)) {
      b.max_completion_tokens = b.max_tokens
      return delete b.max_tokens
    }
    if (b.max_completion_tokens != null && /max_completion_tokens|max_tokens/i.test(t) && /unsupported|unknown|not support|unrecognized|invalid/i.test(t)) {
      b.max_tokens = b.max_completion_tokens
      return delete b.max_completion_tokens
    }
    if (b.reasoning_effort && /reasoning_effort|reasoning/i.test(t) && /unsupported|unknown|not support|unrecognized|invalid/i.test(t)) return delete b.reasoning_effort
    return false
  }
  const url = profile.baseURL.replace(/\/+$/, "") + "/chat/completions"
  const compat = prefersCompatClient(profile.id)
  let res
  try {
    res = await postStreamAdaptive(url, { headers: compat ? { ...headers, ...COMPAT_CLIENT_HEADERS } : headers, body, signal }, adapt)
  } catch (e) {
    if (!e || e.code !== "PROVIDER_CLIENT_RESTRICTED") throw e
    // Identity first; retry once only when a gateway refuses our client name.
    res = await postStreamAdaptive(url, { headers: { ...headers, ...COMPAT_CLIENT_HEADERS }, body, signal }, adapt)
    rememberCompatClient(profile.id)
  }

  const calls = new Map()
  let finish = "stop"
  const reasoningKeys = [q.reasoningField, "reasoning_content", "reasoning"].filter(Boolean)
  for await (const ev of parseSSE(res.body)) {
    if (ev.event === "raw") {
      // not an event stream: a whole chat.completion object (or an error)
      yield* fromJson(parseRawBody(ev.data))
      return
    }
    if (ev.data === "[DONE]") break
    let j
    try {
      j = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (j.error) throw streamError(typeof j.error === "string" ? j.error : j.error.message || JSON.stringify(j.error))
    if (j.usage) yield { type: "usage", ...openAIUsage(j.usage) }
    const ch = j.choices && j.choices[0]
    if (!ch) continue
    const d = ch.delta || {}
    if (d.content) yield { type: "text", delta: d.content }
    for (const k of reasoningKeys) {
      if (typeof d[k] === "string" && d[k]) {
        yield { type: "reasoning", delta: d[k] }
        break
      }
    }
    for (const tc of d.tool_calls || []) {
      let i = tc.index == null ? 0 : tc.index
      let c = calls.get(i)
      // Gemini/Ollama-style gateways send EVERY call with index 0 (or none) and
      // only the id tells them apart: a different id on a call that already has
      // a name is a NEW call, not more arguments for the old one.
      if (c && tc.id && c.name && tc.id !== c.id && tc.function && tc.function.name) {
        i = Math.max(...calls.keys()) + 1
        c = undefined
      }
      if (!c) calls.set(i, (c = { id: tc.id || newId("call"), name: "", args: "" }))
      if (tc.id) c.id = tc.id
      if (tc.extra_content && typeof tc.extra_content === "object") c.extra = tc.extra_content
      if (tc.function) {
        if (tc.function.name && !c.name) c.name = tc.function.name
        if (tc.function.arguments) c.args += tc.function.arguments
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason
  }
  for (const c of calls.values()) if (c.name) yield { type: "tool_call", id: c.id, name: c.name, args: parseArgs(c.args), ...(c.extra ? { extra: c.extra } : {}) }
  yield { type: "finish", reason: calls.size ? "tool_calls" : finish }
}

/** A non-streamed chat.completion object -> the same canonical events. */
function* fromJson(j) {
  const ch = j.choices && j.choices[0]
  const m = (ch && (ch.message || ch.delta)) || {}
  const reasoning = m.reasoning_content || m.reasoning
  if (typeof reasoning === "string" && reasoning) yield { type: "reasoning", delta: reasoning }
  const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || "").join("") : ""
  if (content) yield { type: "text", delta: content }
  if (j.usage) yield { type: "usage", ...openAIUsage(j.usage) }
  let n = 0
  for (const tc of m.tool_calls || []) {
    if (!tc || !tc.function || !tc.function.name) continue
    n++
    const a = tc.function.arguments
    yield { type: "tool_call", id: tc.id || newId("call"), name: tc.function.name, args: typeof a === "string" ? parseArgs(a) : a || {}, ...(tc.extra_content && typeof tc.extra_content === "object" ? { extra: tc.extra_content } : {}) }
  }
  yield { type: "finish", reason: n ? "tool_calls" : (ch && ch.finish_reason) || "stop" }
}

module.exports = { stream, toWire, fromJson, isGemini, geminiModel, withGeminiSignatures }
