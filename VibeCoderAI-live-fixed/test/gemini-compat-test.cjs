"use strict"
// Gemini (Google's OpenAI-compatible endpoint): lowercase model ids, and the
// thought_signature on function calls is kept and sent back (Gemini 3 needs it).
const assert = require("node:assert/strict")
const oc = require("../core/llm/openai-chat")
const { parseSSE } = require("../core/llm/sse")

const g = { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }
assert.equal(oc.isGemini(g), true)
assert.equal(oc.isGemini({ baseURL: "https://api.openai.com/v1" }), false)
assert.equal(oc.geminiModel("models/gemini-2.5-flash-Lite"), "models/gemini-2.5-flash-lite")

// A saved call with its signature goes back with extra_content.
const sig = { google: { thought_signature: "abc" } }
const wire = oc.toWire("", [
  { role: "assistant", parts: [{ type: "tool_call", id: "c1", name: "list", args: { path: "." }, extra: sig }] },
  { role: "user", parts: [{ type: "tool_result", id: "c1", output: "a" }] },
  { role: "assistant", parts: [{ type: "tool_call", id: "c2", name: "list", args: {} }] },
])
assert.deepEqual(wire[0].tool_calls[0].extra_content, sig)
assert.equal(wire[2].tool_calls[0].extra_content, undefined, "other providers never get extra fields")
// An old call without a signature gets Google's documented placeholder.
oc.withGeminiSignatures(wire)
assert.equal(wire[0].tool_calls[0].extra_content.google.thought_signature, "abc")
assert.equal(wire[2].tool_calls[0].extra_content.google.thought_signature, "skip_thought_signature_validator")

// Non-streamed json keeps the signature on the tool_call event.
const evs = [...oc.fromJson({ choices: [{ message: { tool_calls: [{ id: "x", function: { name: "list", arguments: "{}" }, extra_content: sig }] } }] })]
assert.deepEqual(evs.find((e) => e.type === "tool_call").extra, sig)
console.log("PASS gemini compat: lowercase model ids, thought_signature kept and replayed, placeholder for old calls")
