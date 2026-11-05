"use strict"
const adapters = {
  "openai-chat": require("./openai-chat"),
  "openai-responses": require("./openai-responses"),
  anthropic: require("./anthropic"),
}
const { repairBaseUrl } = require("./provider-meta")

// OpenAI-compatible gateways validate function names against a restricted
// character set (and commonly a 64-character limit). Keep internal tool names
// unchanged; translate them only at the provider boundary and map returned
// calls back to the registered names before the agent loop sees them.
const validWireName = (name) => /^[A-Za-z0-9_-]{1,64}$/.test(name)
function normalizeToolNames(req) {
  const names = []
  const seen = new Set()
  const add = (name) => {
    if (typeof name !== "string" || !name || seen.has(name)) return
    seen.add(name)
    names.push(name)
  }
  for (const tool of req.tools || []) add(tool && tool.name)
  // Old session history can contain names from tools that are no longer
  // registered (for example, a disconnected MCP server). It must still be
  // serialized with a valid function name on strict providers.
  for (const message of req.messages || []) {
    if (message.role !== "assistant") continue
    for (const part of message.parts || []) if (part.type === "tool_call") add(part.name)
  }

  // Reserve already-valid names first so an invalid name like "a.b" cannot
  // steal the legitimate name "a_b" and create a handler collision.
  const reserved = new Set(names.filter(validWireName))
  const originalToWire = new Map()
  const wireToOriginal = new Map()
  const used = new Set()
  for (const original of names) {
    let candidate
    if (validWireName(original) && !used.has(original)) {
      candidate = original
    } else {
      const base = (original.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool")
      candidate = base
      let suffix = 2
      while (used.has(candidate) || (reserved.has(candidate) && candidate !== original)) {
        const tail = `_${suffix++}`
        candidate = base.slice(0, Math.max(1, 64 - tail.length)) + tail
      }
    }
    used.add(candidate)
    originalToWire.set(original, candidate)
    wireToOriginal.set(candidate, original)
  }

  const wireTools = (req.tools || []).map((tool) => ({
    ...tool,
    name: originalToWire.get(tool.name) || tool.name,
  }))
  const wireMessages = (req.messages || []).map((message) => {
    if (message.role !== "assistant") return message
    return {
      ...message,
      parts: (message.parts || []).map((part) =>
        part.type === "tool_call"
          ? { ...part, name: originalToWire.get(part.name) || part.name }
          : part,
      ),
    }
  })
  return { ...req, tools: wireTools, messages: wireMessages, wireToOriginal }
}

/** stream(profile, req) -> async iterable of canonical events:
 *  {type:"text"|"reasoning", delta} | {type:"tool_call", id, name, args} |
 *  {type:"usage", input, output, reasoning, cache:{read,write}} | {type:"finish", reason} */
function runtimeProfiles(profile) {
  const fixed = repairBaseUrl(profile.baseURL, profile.format)
  const first = {
    ...profile,
    baseURL: fixed.url || profile.baseURL,
    format: fixed.engineFormat || profile.format,
  }
  const out = [first]
  // Unknown OpenAI-compatible services commonly expose a dashboard at their
  // origin and the API at /v1. Retry that API base only after the first request
  // positively identifies an HTML/non-API response; normal API errors do not
  // trigger URL guessing.
  if (first.format === "openai-chat" || first.format === "openai-responses") {
    const base = String(first.baseURL || "").replace(/\/+$/, "")
    if (base && !/(?:\/v1|\/openai\/v1|\/api\/v1)$/i.test(base)) out.push({ ...first, baseURL: base + "/v1" })
  }
  return out.filter((candidate, index, list) => list.findIndex((other) => other.baseURL === candidate.baseURL && other.format === candidate.format) === index)
}

function shouldTryChat(error) {
  if (error?.code === "PROVIDER_NON_API_RESPONSE") return true
  if ([404, 405, 501].includes(error?.status)) return true
  return [401, 403].includes(error?.status) && /unauthori[sz]ed[_\s-]*client|client[^\n]{0,40}(?:not allowed|not authori[sz]ed|detected)/i.test(String(error?.body || ""))
}

function stream(profile, req) {
  if (!profile || typeof profile !== "object" || !profile.format) {
    throw new Error(`Invalid model profile: missing format (expected openai-chat | openai-responses | anthropic)`)
  }
  if (!adapters[profile.format]) throw new Error(`Unknown format "${profile.format}" (use openai-chat | openai-responses | anthropic)`)

  const normalized = normalizeToolNames(req || {})
  const { wireToOriginal, ...wireReq } = normalized
  const remapEvents = async function* (iterable) {
    for await (const event of iterable) {
      if (event && event.type === "tool_call" && wireToOriginal.has(event.name)) {
        yield { ...event, name: wireToOriginal.get(event.name) }
      } else yield event
    }
  }

  const runOne = async function* (candidate) {
    const adapter = adapters[candidate.format]
    if (candidate.format === "openai-responses") {
      // Some hosts (Groq, DeepSeek, ...) speak only /chat/completions: a 404 on
      // /responses falls back to chat using the SAME normalized tool-name map.
      try {
        yield* adapter.stream({ ...wireReq, profile: candidate })
      } catch (e) {
        if (shouldTryChat(e)) yield* adapters["openai-chat"].stream({ ...wireReq, profile: candidate })
        else throw e
      }
      return
    }
    yield* adapter.stream({ ...wireReq, profile: candidate })
  }

  const robust = async function* () {
    const candidates = runtimeProfiles(profile)
    let lastError = null
    for (let i = 0; i < candidates.length; i++) {
      let emitted = false
      try {
        for await (const event of runOne(candidates[i])) {
          emitted = true
          yield event
        }
        return
      } catch (error) {
        lastError = error
        const canRepair = !emitted && error?.code === "PROVIDER_NON_API_RESPONSE" && i + 1 < candidates.length
        if (!canRepair) throw error
      }
    }
    if (lastError) throw lastError
  }
  return remapEvents(robust())
}
module.exports = { stream, adapters, normalizeToolNames, runtimeProfiles, shouldTryChat, ...require("./http"), ...require("./sse") }
