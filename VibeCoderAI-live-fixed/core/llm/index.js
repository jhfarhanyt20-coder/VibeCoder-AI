"use strict"
const adapters = {
  "openai-chat": require("./openai-chat"),
  "openai-responses": require("./openai-responses"),
  anthropic: require("./anthropic"),
}

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
 *  {type:"text"|"reasoning", delta} | {type:"tool_call", id, name, args} | {type:"usage", input, output} | {type:"finish", reason} */
function stream(profile, req) {
  if (!profile || typeof profile !== "object" || !profile.format) {
    throw new Error(`Invalid model profile: missing format (expected openai-chat | openai-responses | anthropic)`)
  }
  const adapter = adapters[profile.format]
  if (!adapter) throw new Error(`Unknown format "${profile.format}" (use openai-chat | openai-responses | anthropic)`)

  const normalized = normalizeToolNames(req || {})
  const { wireToOriginal, ...wireReq } = normalized
  const remapEvents = async function* (iterable) {
    for await (const event of iterable) {
      if (event && event.type === "tool_call" && wireToOriginal.has(event.name)) {
        yield { ...event, name: wireToOriginal.get(event.name) }
      } else yield event
    }
  }

  if (profile.format === "openai-responses") {
    // Some hosts (Groq, DeepSeek, ...) speak only /chat/completions: a 404 on
    // /responses falls back to chat using the SAME normalized tool-name map.
    return (async function* () {
      try {
        yield* remapEvents(adapter.stream({ ...wireReq, profile }))
      } catch (e) {
        if (e && e.status === 404) yield* remapEvents(adapters["openai-chat"].stream({ ...wireReq, profile }))
        else throw e
      }
    })()
  }
  return remapEvents(adapter.stream({ ...wireReq, profile }))
}
module.exports = { stream, adapters, normalizeToolNames, ...require("./http"), ...require("./sse") }
