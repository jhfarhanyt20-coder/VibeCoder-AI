"use strict"
/** Adapter: OpenAI Responses API format (POST /responses). */
const { parseSSE } = require("./sse")
const { postStreamAdaptive, parseRawBody } = require("./http")
const { newId } = require("../util")

function toWire(messages) {
  const input = []
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const p of m.parts) {
        if (p.type === "text" && p.text) input.push({ role: "assistant", content: [{ type: "output_text", text: p.text }] })
        else if (p.type === "tool_call")
          input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: JSON.stringify(p.args == null ? {} : p.args) })
      }
    } else {
      for (const p of m.parts) {
        if (p.type !== "tool_result") continue
        input.push({ type: "function_call_output", call_id: p.id, output: String(p.output) })
        const shot = p.screenshot
        if (shot?.modelVisible !== false && shot?.data) {
          input.push({ role: "user", content: [
            { type: "input_text", text: `Browser screenshot${shot.title ? ` — ${shot.title}` : ""}${shot.url ? ` (${shot.url})` : ""}. Inspect the visual state of this page.` },
            { type: "input_image", image_url: `data:${shot.mime || "image/png"};base64,${shot.data}` },
          ] })
        }
      }
      const t = m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")
      const imgs = m.parts.filter((p) => p.type === "image" && p.data)
      if (t || imgs.length) {
        const content = []
        if (t) content.push({ type: "input_text", text: t })
        for (const im of imgs) content.push({ type: "input_image", image_url: `data:${im.mime};base64,${im.data}` })
        input.push({ role: "user", content })
      }
    }
  }
  return input
}

async function* stream({ profile, apiKey, system, messages, tools, signal }) {
  const q = profile.quirks || {}
  const body = {
    model: profile.model,
    input: toWire(messages),
    stream: true,
    store: false,
    max_output_tokens: profile.maxOutput || 8192,
    ...(q.extraBody || {}),
  }
  if (system) body.instructions = system
  if (tools && tools.length) body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }))
  if (q.reasoningEffort) body.reasoning = { effort: q.reasoningEffort, summary: "auto" }

  const headers = { ...(profile.headers || {}) }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const adapt = (err, b) => {
    const t = err.body
    if (b.reasoning && /reasoning/i.test(t) && /unsupported|unknown|not support|unrecognized|invalid/i.test(t)) return delete b.reasoning
    if (b.store === false && /\bstore\b/i.test(t)) return delete b.store
    return false
  }
  const res = await postStreamAdaptive(profile.baseURL.replace(/\/+$/, "") + "/responses", { headers, body, signal }, adapt)

  let sawCall = false
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
      case "response.output_text.delta":
        if (j.delta) yield { type: "text", delta: j.delta }
        break
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (j.delta) yield { type: "reasoning", delta: j.delta }
        break
      case "response.output_item.done":
        if (j.item && j.item.type === "function_call") {
          sawCall = true
          let args = {}
          try {
            args = j.item.arguments ? JSON.parse(j.item.arguments) : {}
          } catch {
            args = { __parseError: true, raw: j.item.arguments }
          }
          yield { type: "tool_call", id: j.item.call_id || newId("call"), name: j.item.name, args }
        }
        break
      case "response.completed": {
        const u = (j.response && j.response.usage) || {}
        yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 }
        break
      }
      case "response.failed":
      case "error": {
        const e = (j.response && j.response.error) || j.error || j
        throw new Error(e.message || JSON.stringify(e))
      }
    }
  }
  yield { type: "finish", reason: sawCall ? "tool_calls" : "stop" }
}

/** A non-streamed response object -> canonical events. */
function* fromJson(j) {
  const r = j.response || j
  let sawCall = false
  for (const item of r.output || []) {
    if (item.type === "reasoning") {
      const t = (item.summary || []).map((x) => x.text || "").join("")
      if (t) yield { type: "reasoning", delta: t }
    } else if (item.type === "message") {
      const t = (item.content || []).map((x) => x.text || "").join("")
      if (t) yield { type: "text", delta: t }
    } else if (item.type === "function_call") {
      sawCall = true
      let args = {}
      try {
        args = item.arguments ? JSON.parse(item.arguments) : {}
      } catch {
        args = { __parseError: true, raw: item.arguments }
      }
      yield { type: "tool_call", id: item.call_id || newId("call"), name: item.name, args }
    }
  }
  if (!(r.output || []).length && typeof r.output_text === "string" && r.output_text) yield { type: "text", delta: r.output_text }
  const u = r.usage || {}
  yield { type: "usage", input: u.input_tokens || 0, output: u.output_tokens || 0 }
  yield { type: "finish", reason: sawCall ? "tool_calls" : "stop" }
}

module.exports = { stream, toWire, fromJson }
