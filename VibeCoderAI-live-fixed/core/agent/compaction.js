"use strict"

/**
 * OpenCode-style conversation compaction.
 *
 * Generate a checkpoint for old history, then replace the old head while
 * preserving a recent tail. Original history is not modified until a summary
 * (LLM or deterministic fallback) is ready. The caller must stop if fitsBudget
 * is false; estimated token counts cannot guarantee provider acceptance.
 */

const llm = require("../llm")
const { estimateTokens, sleep } = require("../util")

const PRUNED = "[Old tool output cleared to save context]"
const MAX_COMPACTIONS = 6
const MESSAGE_OVERHEAD = 4
const SUMMARY_SYSTEM =
  "You write checkpoint summaries of a coding-agent conversation so that another agent can continue the work without the original messages. Be factual, dense and exact. Never invent details."
const TEMPLATE = `Write a checkpoint summary of the conversation above. Use exactly these sections:

## Goal
What the user is trying to achieve right now.

## Instructions
Rules, preferences and constraints the user gave that still apply.

## Discoveries
Facts learned: how the code works, errors seen, decisions made and why.

## Accomplished
What is done, what is in progress, what is still to do (keep the remaining TODO items).

## Relevant files and directories
Exact paths, with one line on what changed or why it matters.

Keep exact file paths, commands that were run and any error that is still open. No preamble, no closing remarks.`
const CHECKPOINT_PREFIX = "[Checkpoint: the earlier part of this conversation was compacted. Continue from this summary.]"

function tokenCount(value) {
  return estimateTokens(String(value == null ? "" : value))
}

function partTokens(part) {
  if (!part || typeof part !== "object") return 0
  if (part.type === "text") return tokenCount(part.text)
  // Vision payload estimates vary by provider; use a conservative fixed estimate.
  if (part.type === "image") return 1000
  if (part.type === "tool_call") {
    let args = "{}"
    try { args = JSON.stringify(part.args || {}) } catch { args = "[unserializable]" }
    return tokenCount(part.name) + tokenCount(args)
  }
  if (part.type === "tool_result") {
    // Screenshot pixels are passed to vision-capable models separately from
    // the textual tool output; include a conservative allowance in estimates.
    return tokenCount(part.output) + (part.screenshot?.data && part.screenshot.modelVisible !== false ? 1000 : 0)
  }
  return 0
}

const msgTokens = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts.reduce((total, part) => total + partTokens(part), MESSAGE_OVERHEAD)
}
const messagesTokens = (messages) =>
  Array.isArray(messages) ? messages.reduce((total, message) => total + msgTokens(message), 0) : 0
const requestTokens = (system, messages, toolSpecs) =>
  tokenCount(system || "") + tokenCount(safeStringify(toolSpecs || [])) + messagesTokens(messages)

function safeStringify(value) {
  try {
    const out = JSON.stringify(value)
    return out === undefined ? String(value ?? "") : out
  } catch {
    return "[unserializable]"
  }
}

function normalizeProfile(profile) {
  const p = profile && typeof profile === "object" ? profile : {}
  const contextLimit = Number.isFinite(p.contextLimit) && p.contextLimit > 0
    ? Math.max(2, Math.floor(p.contextLimit))
    : 128000
  const rawOutput = Number.isFinite(p.maxOutput) && p.maxOutput > 0
    ? Math.floor(p.maxOutput)
    : 2048
  const maxOutput = Math.max(1, Math.min(rawOutput || 2048, contextLimit - 1))
  return { ...p, contextLimit, maxOutput }
}

function limits(profile) {
  const normalized = normalizeProfile(profile)
  const limit = normalized.contextLimit
  // Keep a minimum generation reserve where possible; never reserve more than
  // 25% of context so small-context models still have a usable input budget.
  const desiredReserve = Math.max(2048, normalized.maxOutput)
  const reserve = Math.min(desiredReserve, Math.floor(limit * 0.25), limit - 1)
  const usable = Math.max(1, limit - reserve)
  return { limit, reserve, usable, threshold: usable }
}

function usableForMessages(profile, system, toolSpecs) {
  const { usable } = limits(profile)
  return Math.max(0, usable - tokenCount(system || "") - tokenCount(safeStringify(toolSpecs || [])))
}

function needsCompaction({ system, messages, toolSpecs, lastInput, profile }) {
  const { threshold } = limits(profile)
  const measured = Number.isFinite(lastInput) && lastInput > 0 ? lastInput : 0
  return Math.max(requestTokens(system, messages, toolSpecs), measured) >= threshold
}

/** Clear old tool outputs in a provided message array. Caller decides whether to commit the array. */
function prune(messages, profile) {
  if (!Array.isArray(messages)) return 0
  const { limit } = limits(profile)
  const protect = Math.min(40000, Math.floor(limit * 0.3))
  const minSave = Math.min(20000, Math.floor(limit * 0.1))
  let seen = 0
  let freed = 0
  const targets = []

  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = Array.isArray(messages[i]?.parts) ? messages[i].parts : []
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type !== "tool_result" || part.output === PRUNED) continue
      const size = tokenCount(part.output)
      seen += size
      if (seen > protect) {
        targets.push(part)
        freed += size
      }
    }
  }
  if (freed < minSave) return 0
  for (const part of targets) part.output = PRUNED
  return freed
}

function cloneMessages(messages) {
  return messages.map((message) => ({
    ...message,
    parts: Array.isArray(message?.parts) ? message.parts.map((part) => ({ ...part })) : [],
  }))
}

function clipStr(value, maxChars) {
  const source = String(value ?? "")
  const max = Math.max(0, Math.floor(maxChars))
  if (source.length <= max) return source
  if (max === 0) return ""
  if (max <= 24) return source.slice(0, max)
  const marker = ` …[${source.length - (max - 24)} chars omitted]`
  return source.slice(0, max - marker.length) + marker
}

function renderMessage(message) {
  const role = message?.summary ? "earlier summary" : String(message?.role || "unknown")
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const rendered = []
  for (const part of parts) {
    if (!part || typeof part !== "object") continue
    if (part.type === "text") rendered.push(`[${role}] ${clipStr(part.text, 8000)}`)
    else if (part.type === "tool_call") rendered.push(`[assistant tool call] ${String(part.name || "unknown")} ${clipStr(safeStringify(part.args || {}), 1500)}`)
    else if (part.type === "tool_result") {
      rendered.push(`[tool result ${String(part.name || "")}${part.isError ? " ERROR" : ""}] ${clipStr(part.output, 1500)}`)
      if (part.screenshot?.data) {
        rendered.push(`[browser screenshot attached${part.screenshot.title ? `: ${String(part.screenshot.title)}` : ""}${part.screenshot.url ? ` — ${String(part.screenshot.url)}` : ""}]`)
      }
    }
    else if (part.type === "image") rendered.push("[image attached; inspect relevant user context and image-supported model behavior]")
  }
  return rendered.join(" ")
}

function takeStart(blocks, budget) {
  const selected = []
  let used = 0
  const cap = Math.max(0, Math.floor(budget))
  for (let i = 0; i < blocks.length; i++) {
    const separator = selected.length ? 1 : 0
    const room = cap - used - separator
    if (room <= 0) break
    if (blocks[i].length <= room) {
      selected.push(blocks[i])
      used += separator + blocks[i].length
    } else {
      if (!selected.length) selected.push(blocks[i].slice(0, room))
      break
    }
  }
  return selected
}

function takeEnd(blocks, budget) {
  const selected = []
  let used = 0
  const cap = Math.max(0, Math.floor(budget))
  for (let i = blocks.length - 1; i >= 0; i--) {
    const separator = selected.length ? 1 : 0
    const room = cap - used - separator
    if (room <= 0) break
    if (blocks[i].length <= room) {
      selected.unshift(blocks[i])
      used += separator + blocks[i].length
    } else {
      if (!selected.length) selected.unshift(blocks[i].slice(-room))
      break
    }
  }
  return selected
}

/** Preserve the initial request and newest progress while omitting only the middle. */
function renderTranscript(messages, maxChars) {
  const blocks = (Array.isArray(messages) ? messages : []).map(renderMessage).filter(Boolean)
  if (!blocks.length) return ""
  const full = blocks.join("\n")
  const cap = Math.max(0, Math.floor(maxChars))
  if (full.length <= cap) return full
  const marker = "\n[…middle of the conversation omitted…]\n"
  if (cap <= marker.length + 2) return clipStr(full, cap)
  const available = cap - marker.length
  // A single oversized message can contain both the original goal and the most
  // recent state. Preserve distinct beginning/end fragments instead of silently
  // keeping only its beginning.
  if (blocks.length === 1) {
    const headChars = Math.floor(available * 0.4)
    const tailChars = available - headChars
    const result = `${blocks[0].slice(0, headChars)}${marker}${blocks[0].slice(-tailChars)}`
    return result.length > cap ? result.slice(0, cap) : result
  }
  const head = takeStart(blocks, Math.floor(available * 0.4))
  const usedHeadCount = head.length
  const tail = takeEnd(blocks.slice(usedHeadCount), available - Math.floor(available * 0.4))
  let result = `${head.join("\n")}${marker}${tail.join("\n")}`
  if (result.length > cap) result = result.slice(0, cap)
  return result
}

function validSummary(summary) {
  const s = String(summary || "").trim()
  return s.length >= 40 && /##\s+Goal\b/i.test(s) && /##\s+(Accomplished|Discoveries)\b/i.test(s)
}

function projectContext(session) {
  const open = (Array.isArray(session?.todos) ? session.todos : []).filter((todo) => todo && todo.status !== "completed")
  const context = [
    "## Project context",
    `- Working directory: ${session?.dir || "(unknown)"}`,
    "- Preserve the user's current goal and the files already changed.",
  ]
  if (open.length) context.push("- Open TODO items:\n" + open.slice(0, 50).map((todo) => `  - [${todo.status || "open"}] ${String(todo.content || "").slice(0, 500)}`).join("\n"))
  return context.join("\n")
}

function mechanicalSummary(messages) {
  const users = []
  const assistant = []
  const files = new Set()
  const errors = []
  for (const message of messages) {
    const parts = Array.isArray(message?.parts) ? message.parts : []
    for (const part of parts) {
      if (part?.type === "text" && message.role === "user") users.push(`- ${clipStr(String(part.text || "").replace(/\s+/g, " "), 500)}`)
      if (part?.type === "text" && message.role === "assistant") assistant.push(`- ${clipStr(String(part.text || "").replace(/\s+/g, " "), 300)}`)
      if (part?.type === "tool_call" && part.args && typeof part.args.path === "string") files.add(part.args.path)
      if (part?.type === "tool_result" && part.isError) errors.push(`- ${clipStr(part.output, 300)}`)
    }
  }
  return [
    "## Goal", users[0] || "- Continue the user's current task.",
    "## Instructions", users.slice(1, 5).join("\n") || "- (none recorded)",
    "## Discoveries", errors.slice(-8).join("\n") || "- (no explicit tool errors recorded)",
    "## Accomplished", assistant.slice(-8).join("\n") || "- Work is not yet summarized; continue by inspecting recent history.",
    "## Relevant files and directories", [...files].slice(-40).map((file) => `- ${file}`).join("\n") || "- (none recorded)",
  ].join("\n\n")
}

function cloneSafeBoundaryInfo(messages, start, end) {
  const calls = new Set()
  const results = new Set()
  let idlessCalls = 0
  let idlessResults = 0
  for (let i = start; i < end; i++) {
    const parts = Array.isArray(messages[i]?.parts) ? messages[i].parts : []
    for (const part of parts) {
      if (part?.type !== "tool_call" && part?.type !== "tool_result") continue
      const rawId = part.id ?? part.callId ?? part.call_id ?? part.toolCallId ?? part.tool_call_id
      const id = rawId == null || rawId === "" ? null : String(rawId)
      if (part.type === "tool_call") {
        if (id === null) idlessCalls++
        else calls.add(id)
      } else {
        if (id === null) idlessResults++
        else results.add(id)
      }
    }
  }
  return { calls, results, idlessCalls, idlessResults }
}

function validCut(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return !(parts.length > 0 && parts.every((part) => part?.type === "tool_result"))
}

function cutIsSafe(messages, cut) {
  if (!Array.isArray(messages) || !Number.isInteger(cut) || cut <= 0 || cut > messages.length) return false
  // A cut at messages.length summarizes the entire history. It is safe because
  // no call/result pair crosses into a retained tail (the tail is empty).
  if (cut < messages.length && !validCut(messages[cut])) return false
  const head = cloneSafeBoundaryInfo(messages, 0, cut)
  const tail = cloneSafeBoundaryInfo(messages, cut, messages.length)
  for (const id of head.calls) if (tail.results.has(id)) return false
  for (const id of tail.calls) if (head.results.has(id)) return false
  // ID-less interactions cannot be correlated. Do not cut across an unknown
  // call/result frontier; runtime-generated calls should always carry IDs.
  if (head.idlessCalls && (tail.results.size || tail.idlessResults)) return false
  if (tail.idlessResults && head.calls.size) return false
  if (tail.idlessCalls && (head.results.size || head.idlessResults)) return false
  if (head.idlessResults && tail.calls.size) return false
  return true
}

/** Return the message index where the retained tail starts. */
function pickCut(messages, keepTokens) {
  if (!Array.isArray(messages) || messages.length <= 1) return 0
  const keep = Math.max(0, Number.isFinite(keepTokens) ? Math.floor(keepTokens) : 0)
  let cut = messages.length - 1
  while (cut > 1 && !validCut(messages[cut])) cut--
  if (cut <= 0 || !validCut(messages[cut])) return 0
  let accumulated = msgTokens(messages[cut])
  for (let i = cut - 1; i >= 1; i--) {
    const next = accumulated + msgTokens(messages[i])
    if (next > keep) break
    accumulated = next
    if (validCut(messages[i])) cut = i
  }
  return cut
}

function pickSafeCut(messages, keepTokens) {
  if (!Array.isArray(messages) || messages.length === 0) return 0
  const initial = pickCut(messages, keepTokens)
  const start = initial > 0 ? initial : 1
  const keep = Math.max(0, Number.isFinite(keepTokens) ? Math.floor(keepTokens) : 0)

  // First search forward from the ideal boundary. If a huge assistant message
  // contains a batch of tool calls, retain the whole interaction or summarize
  // it wholly; never force that oversized batch into the retained tail forever.
  for (let cut = start; cut <= messages.length; cut++) {
    if (cut < messages.length && !validCut(messages[cut])) continue
    if (!cutIsSafe(messages, cut)) continue
    const tailTokens = messagesTokens(messages.slice(cut))
    if (tailTokens <= keep || cut === messages.length) return cut
  }

  // Defensive fallback: select any safe boundary, preferring the smallest tail.
  for (let cut = messages.length; cut > 0; cut--) {
    if (cut < messages.length && !validCut(messages[cut])) continue
    if (cutIsSafe(messages, cut)) return cut
  }
  return 0
}

function checkpointMessage(session, summary, reason = "auto", summarySource = "llm") {
  const sourceNote = summarySource === "fallback" ? "[Automatic fallback summary; the LLM summary was unavailable.]\n\n" : ""
  return {
    role: "user",
    summary: true,
    compactionReason: reason,
    summarySource,
    parts: [{ type: "text", text: `${CHECKPOINT_PREFIX}\n\n${sourceNote}${summary}\n\n${projectContext(session)}` }],
  }
}

async function generateSummary({ profile, apiKey, signal, head, previousSummary, targetTokens }) {
  const normalized = normalizeProfile(profile)
  const { usable } = limits(normalized)
  const budget = Number.isFinite(targetTokens) && targetTokens > 0
    ? Math.min(usable, Math.floor(targetTokens))
    : usable
  const maxOutput = Math.max(1, Math.min(normalized.maxOutput, 4096))
  const previous = previousSummary ? `Previous checkpoint summary:\n${clipStr(previousSummary, 2400)}\n\n` : ""
  const overheadText = `<conversation>\n\n</conversation>\n\n${previous}${TEMPLATE}`
  const fixedInputTokens = tokenCount(SUMMARY_SYSTEM) + tokenCount(overheadText) + MESSAGE_OVERHEAD
  const transcriptBudgetTokens = budget - fixedInputTokens - maxOutput - 64
  if (transcriptBudgetTokens < 48) throw new Error(`Insufficient context budget to ask for a checkpoint summary (${budget} input tokens available).`)

  const initialChars = Math.max(160, transcriptBudgetTokens * 3)
  const caps = [...new Set([initialChars, Math.floor(initialChars * 0.55), Math.floor(initialChars * 0.25), 160])].filter((n) => n > 0)
  let lastError = null
  let sawInvalid = false
  let lastValidRequest = null

  async function attempt(messages) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Context compaction cancelled")
    const estimate = requestTokens(SUMMARY_SYSTEM, messages, [])
    if (estimate + maxOutput + 64 > budget) {
      lastError = new Error(`Summary request is over budget (${estimate} input tokens + ${maxOutput} output reserve; budget ${budget}).`)
      return null
    }
    lastValidRequest = messages
    let text = ""
    for await (const event of llm.stream({ ...normalized, maxOutput }, { apiKey, system: SUMMARY_SYSTEM, messages, tools: [], signal })) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Context compaction cancelled")
      if (event?.type === "text") text += String(event.delta || "")
      if (event?.type === "finish") break
    }
    const summary = text.trim()
    if (validSummary(summary)) return summary
    sawInvalid = true
    return null
  }

  for (const cap of caps) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Context compaction cancelled")
    const transcript = renderTranscript(head, cap)
    const messages = [{ role: "user", parts: [{ type: "text", text: `<conversation>\n${transcript}\n</conversation>\n\n${previous}${TEMPLATE}` }] }]
    try {
      const summary = await attempt(messages)
      if (summary) return { summary, source: "llm" }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }

  if (lastValidRequest) {
    await sleep(250, signal)
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Context compaction cancelled")
    try {
      // Check the exact final retry again; never bypass the budget guard.
      const estimate = requestTokens(SUMMARY_SYSTEM, lastValidRequest, [])
      if (estimate + maxOutput + 64 <= budget) {
        const summary = await attempt(lastValidRequest)
        if (summary) return { summary, source: "llm" }
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = lastError || error
    }
  }

  // A deterministic summary is the fallback. It is always marked as fallback
  // so UI/debugging can distinguish it from an LLM-written checkpoint.
  const fallback = mechanicalSummary(head)
  if (fallback.length < 80) {
    throw lastError || new Error(sawInvalid ? "The model returned an invalid checkpoint summary." : "Could not generate a checkpoint summary.")
  }
  return { summary: fallback, source: "fallback", warning: lastError?.message || (sawInvalid ? "The model did not return a valid structured summary." : "") }
}

/** Compact a session in place. History is untouched until the summary is ready. */
async function compact({ session, profile, apiKey, signal, reason = "auto", system = "", toolSpecs = [], targetTokens = 0 }) {
  if (!session || !Array.isArray(session.messages)) {
    return { before: 0, after: 0, summarized: false, committed: false, fitsBudget: false, reason, error: "Invalid session: messages must be an array." }
  }

  const before = requestTokens(system, session.messages, toolSpecs)
  const normalized = normalizeProfile(profile)
  const { usable } = limits(normalized)
  const budgetLimit = Number.isFinite(targetTokens) && targetTokens > 0
    ? Math.min(usable, Math.max(1, Math.floor(targetTokens)))
    : usable

  if (reason === "auto" && (Number(session.compactions) || 0) >= MAX_COMPACTIONS) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: `Automatic compaction stopped after ${MAX_COMPACTIONS} successful compactions; the request may still exceed budget.` }
  }

  // Work on clones. prune() is allowed to shrink the candidate history, but a
  // failed summary must leave the actual session messages byte-for-byte intact.
  const candidateMessages = cloneMessages(session.messages)
  const prunedTokens = prune(candidateMessages, normalized)
  const keepTokens = Math.min(20000, Math.floor(budgetLimit * 0.2))
  const cut = pickSafeCut(candidateMessages, keepTokens)

  if (cut <= 0) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Cannot compact safely: no valid split boundary preserves the known tool-call/result relationships." }
  }

  const head = candidateMessages.slice(0, cut)
  const tail = candidateMessages.slice(cut)
  if (!head.length) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Cannot compact because a safe split produced an empty head." }
  }

  let generated
  try {
    generated = await generateSummary({
      profile: normalized,
      apiKey,
      signal,
      head,
      previousSummary: session.compactedSummary,
      targetTokens: budgetLimit,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: error?.message || String(error) }
  }

  const summary = String(generated?.summary || "").trim()
  if (!summary) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Summary generation returned empty content; original history was preserved." }
  }

  const nextMessages = [checkpointMessage(session, summary, reason, generated.source || "llm"), ...tail]
  const after = requestTokens(system, nextMessages, toolSpecs)
  const fitsBudget = after <= budgetLimit

  // Atomic commit point: no user history mutation occurred before this line.
  session.messages = nextMessages
  session.compactions = (session.compactions || 0) + 1
  session.compactedSummary = summary
  if (session.usage && typeof session.usage === "object") session.usage.lastInput = 0

  const result = {
    before,
    after,
    summarized: true,
    committed: true,
    fitsBudget,
    budgetLimit,
    prunedTokens,
    summary,
    summarySource: generated.source || "llm",
    reason,
  }
  if (generated.warning) result.warning = generated.warning
  if (!fitsBudget) {
    result.error = `Checkpoint committed, but the resulting request remains over budget (${after} estimated input tokens; budget ${budgetLimit}). Do not send another model request without recovery.`
  }
  return result
}

module.exports = {
  compact,
  prune,
  needsCompaction,
  requestTokens,
  messagesTokens,
  msgTokens,
  partTokens,
  pickCut,
  pickSafeCut,
  cutIsSafe,
  limits,
  normalizeProfile,
  usableForMessages,
  renderTranscript,
  estimateSummaryRequestTokens: (transcript, previousSummary) => requestTokens(SUMMARY_SYSTEM, [{ role: "user", parts: [{ type: "text", text: `<conversation>\n${transcript}\n</conversation>\n\n${previousSummary ? `Previous checkpoint summary:\n${clipStr(previousSummary, 2400)}\n\n` : ""}${TEMPLATE}` }] }], []),
  validateSummary: validSummary,
  mechanicalSummary,
  PRUNED,
  TEMPLATE,
  MAX_COMPACTIONS,
}
