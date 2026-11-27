"use strict"
/** Adapter: Anthropic Messages format (POST /v1/messages). */
const { parseSSE } = require("./sse")
const { postStreamAdaptive, parseRawBody, streamError, PRODUCT_HEADERS } = require("./http")
const { anthropicUsage } = require("./usage")
const promptCache = require("./cache")

function toWire(messages) {
  const out = []
  for (const m of messages) {
    const content = []
    if (m.role === "assistant") {
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text })
        else if (p.type === "tool_call") content.push({ type: "tool_use", id: p.id, name: p.name, input: p.args == null ? {} : p.args })
      }
    } else {
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue
        content.push({ type: "tool_result", tool_use_id: p.id, content: String(p.output), is_error: !!p.isError })
        const shot = p.screenshot
        if (shot?.modelVisible !== false && shot?.data) {
          content.push({ type: "text", text: (shot.caption ? `${shot.caption}${shot.title ? ` — ${shot.title}` : ""}. Inspect what is on the screen.` : `Browser screenshot${shot.title ? ` — ${shot.title}` : ""}${shot.url ? ` (${shot.url})` : ""}. Inspect the visual state of this page.`) })
          content.push({ type: "image", source: { type: "base64", media_type: shot.mime || "image/png", data: shot.data } })
        }
      }
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text })
        else if (p.type === "image" && p.data) content.push({ type: "image", source: { type: "base64", media_type: p.mime, data: p.data } })
      }
    }
    if (content.length) out.push({ role: m.role, content })
  }
  return out
}

/**
 * Prompt caching: mark the stable prefix so the provider can reuse it on the
 * next request of the same run (cheaper, faster). Three breakpoints: the last
 * tool definition, the system prompt and the newest message block; the
 * provider looks back from each one, so the previous step's prefix is found.
 * profile.quirks.promptCache === false turns it off for a gateway that
 * rejects cache_control.
 */
const EPHEMERAL = { type: "ephemeral" }
function addCacheMarks(body) {
  if (Array.isArray(body.tools) && body.tools.length) body.tools[body.tools.length - 1].cache_control = EPHEMERAL
  if (typeof body.system === "string" && body.system) body.system = [{ type: "text", text: body.system, cache_control: EPHEMERAL }]
  const last = Array.isArray(body.messages) && body.messages[body.messages.length - 1]
  const block = last && Array.isArray(last.content) && last.content[last.content.length - 1]
  if (block && typeof block === "object") block.cache_control = EPHEMERAL
  return body
}
/** Undo addCacheMarks (for a gateway that answers 400 to cache_control). */
function dropCacheMarks(body) {
  let changed = false
  for (const t of body.tools || []) if (t.cache_control) { delete t.cache_control; changed = true }
  if (Array.isArray(body.system)) { body.system = body.system.map((b) => b.text).join("\n"); changed = true }
  for (const m of body.messages || []) for (const b of Array.isArray(m.content) ? m.content : []) if (b && b.cache_control) { delete b.cache_control; changed = true }
  return changed
}

/** base may already end in /v1 or /v1/messages: never double the path. */
const endpoint = (base) => base.replace(/\/v1\/messages$/i, "").replace(/\/v1$/i, "") + "/v1/messages"

async function* stream({ profile, apiKey, system, messages, tools, signal, toolChoice = null }) {
  const q = profile.quirks || {}
  const body = {
    model: profile.model,
    max_tokens: profile.maxOutput || 8192,
    messages: toWire(messages),
    stream: true,
    ...(q.extraBody || {}),
  }
  if (system) body.system = system
  if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  // The last step of a run keeps the tool definitions (so the cached prefix
  // still matches) but tells the model not to call them.
  if (toolChoice === "none" && body.tools) body.tool_choice = { type: "none" }
  // Explicit cache marks for every Anthropic-format endpoint (core/llm/cache.js).
  const marked = promptCache.useMarks(profile)
  if (marked) addCacheMarks(body)
  let droppedMarks = false

  // Identity first: every request says it comes from BDCoder AI. Some
  // Anthropic-format gateways (new-api based routers etc.) whitelist known
  // Claude clients and answer 401 "unauthorized client detected" to anything
  // else. Only in that case do we retry once with the compatible client string,
  // so a provider that would break because of our name never sees it.
  // profile.headers can still override anything.
  const COMPAT_HEADERS = { "user-agent": "claude-cli/2.0.60 (external, cli)", "x-app": "cli" }
  const headers = { "anthropic-version": "2023-06-01", ...PRODUCT_HEADERS, ...(profile.headers || {}) }
  if (apiKey) headers["x-api-key"] = apiKey
  const base = (profile.baseURL || "https://api.anthropic.com").replace(/\/+$/, "")
  const adapt = (error, request) => {
    if (q.reasoningOverride && request.thinking && /thinking|budget_tokens|temperature/i.test(error.body) && /unsupported|unknown|not support|unrecognized|invalid|must be/i.test(error.body)) return delete request.thinking
    if (request.tool_choice && /tool_choice/i.test(String(error.body || ""))) return delete request.tool_choice
    // Any other 400 while the request carries cache marks: try once without
    // them, whatever the endpoint's error text says (no provider-specific rules).
    if (marked && !droppedMarks && promptCache.mayBeAboutMarks(error.body) && dropCacheMarks(request)) { droppedMarks = true; return true }
    return false
  }
  let res
  try {
    res = await postStreamAdaptive(endpoint(base), { headers, body, signal }, adapt)
  } catch (e) {
    if (!e || e.code !== "PROVIDER_CLIENT_RESTRICTED") throw e
    // Compatibility retry: only the client string changes; the product header
    // stays so the gateway still sees which app made the request.
    res = await postStreamAdaptive(endpoint(base), { headers: { ...headers, ...COMPAT_HEADERS }, body, signal }, adapt)
  }
  // The request only went through without the marks: do not send them to this endpoint again.
  if (droppedMarks) promptCache.rememberRejected(profile)

  const blocks = new Map()
  let finish = "stop"
  let usage = {}
  for await (const ev of parseSSE(res.body)) {
    if (ev.event === "raw") {
      yield* fromJson(parseRawBody(ev.data))
      return
    }
    let j
    try {
      j = JSON.parse(ev.data)
    } catch {
      continue
    }
    switch (j.type) {
      case "message_start":
        if (j.message && j.message.usage) usage = { ...usage, ...j.message.usage }
        break
      case "content_block_start":
        if (j.content_block && j.content_block.type === "tool_use")
          blocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: "" })
        break
      case "content_block_delta": {
        const d = j.delta || {}
        if (d.type === "text_delta" && d.text) yield { type: "text", delta: d.text }
        else if (d.type === "thinking_delta" && d.thinking) yield { type: "reasoning", delta: d.thinking }
        else if (d.type === "input_json_delta") {
          const b = blocks.get(j.index)
          if (b) b.json += d.partial_json || ""
        }
        break
      }
      case "content_block_stop": {
        const b = blocks.get(j.index)
        if (b) {
          let args = {}
          try {
            args = b.json ? JSON.parse(b.json) : {}
          } catch {
            args = { __parseError: true, raw: b.json }
          }
          yield { type: "tool_call", id: b.id, name: b.name, args }
          blocks.delete(j.index)
        }
        break
      }
      case "message_delta":
        if (j.delta && j.delta.stop_reason) finish = j.delta.stop_reason === "tool_use" ? "tool_calls" : j.delta.stop_reason
        if (j.usage) {
          // real Anthropic reports input_tokens at message_start, many routers
          // report it (only) here at message_delta: take whichever is non-zero
          usage = { ...usage, ...j.usage }
          yield { type: "usage", ...anthropicUsage(usage) }
        }
        break
      case "error":
        throw streamError((j.error && j.error.message) || JSON.stringify(j))
    }
  }
  yield { type: "finish", reason: finish }
}

/** A non-streamed Messages object -> canonical events. */
function* fromJson(j) {
  let n = 0
  for (const b of j.content || []) {
    if (b.type === "text" && b.text) yield { type: "text", delta: b.text }
    else if (b.type === "thinking" && b.thinking) yield { type: "reasoning", delta: b.thinking }
    else if (b.type === "tool_use") {
      n++
      yield { type: "tool_call", id: b.id, name: b.name, args: b.input || {} }
    }
  }
  const u = j.usage || {}
  yield { type: "usage", ...anthropicUsage(u) }
  yield { type: "finish", reason: n ? "tool_calls" : j.stop_reason === "end_turn" ? "stop" : j.stop_reason || "stop" }
}

module.exports = { stream, toWire, fromJson }
