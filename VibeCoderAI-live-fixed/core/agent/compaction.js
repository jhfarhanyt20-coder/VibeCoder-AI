"use strict"

/**
 * OpenCode-style conversation compaction.
 *
 * Generate a checkpoint for old history, then replace the old head while
 * preserving a recent tail. Original history is not modified until a summary
 * (LLM or deterministic fallback) is ready. The caller must stop if fitsBudget
 * is false; estimated token counts cannot guarantee provider acceptance.
 */

const fs = require("node:fs")
const path = require("node:path")
const llm = require("../llm")
const { estimateTokens, sleep } = require("../util")

const PRUNED = "[Old tool output cleared to save context]"
// Kept for compatibility with older configs/tests. config.json's
// `compaction.maxRuns` (0 = unlimited) replaces the hard cap.
const MAX_COMPACTIONS = 6
const MAX_ARCHIVES = 2
const MESSAGE_OVERHEAD = 4
// Summary generation has its own shorter silence watchdog. It resets whenever
// the model sends an event, so a healthy long summary can finish while a dead
// provider cannot leave manual/auto compaction spinning for minutes.
const SUMMARY_SILENCE_TIMEOUT_MS = 30000
const SUMMARY_SYSTEM =
  "You write checkpoint summaries so another agent can continue without the original messages. Be factual, evidence-aware, dense and exact. Never invent details or turn a suspicion into a confirmed finding."
const TEMPLATE = `Summarize only what the user and the assistant said and did. Leave out instructions and setup the assistant was given rather than told by the user: repository conventions, instruction files such as AGENTS.md, and environment details like the session ID. The next agent receives current versions of all of these separately.

You MUST use this format for your response (you may omit sections that aren't applicable). Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the user, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the current working directory, that another agent would need to open to continue this work. Include at most 15, most important first. Do not list every file that was read or changed. Include paths outside the current working directory when relevant. If none, write "(none)".
- \`[file or directory path]\`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>

Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only user questions or requests that remain unanswered or require further action. Do not repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or merged.
- Do not mention the summary process or that context was compacted.
- Keep the headings exactly as written, but write their bullet content in the user's primary language.
- Preserve epistemic status exactly: distinguish observed facts, user-reported facts, assistant hypotheses, and unverified possibilities.
- Never call something a verified root cause, completed diagnosis, successful fix, or confirmed result unless the conversation contains direct conclusive evidence.
- Put unresolved verification in Active or Blocked, including missing permissions, unavailable logs/dumps, failed commands, and conflicting evidence.
- Preserve important contradictions rather than selecting one as certain.

Do not continue the task or call tools.

Return only the structured summary in the requested format. Do not include a preamble, explanation, or other commentary.`
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

/**
 * Budget for one model request.
 * `config` is the optional `config.json` -> compaction block. `buffer` overrides
 * the maxOutput reserve; it is always capped at 25% of the window so a small
 * context model still has usable input room.
 */
function limits(profile, config) {
  const normalized = normalizeProfile(profile)
  const limit = normalized.contextLimit
  const customBuffer = config && Number(config.buffer) > 0 ? Math.floor(Number(config.buffer)) : 0
  const desiredReserve = customBuffer > 0 ? customBuffer : Math.max(2048, normalized.maxOutput)
  const reserve = Math.min(desiredReserve, Math.floor(limit * 0.25), limit - 1)
  const usable = Math.max(1, limit - reserve)
  return { limit, reserve, usable, threshold: usable }
}

function usableForMessages(profile, system, toolSpecs, config) {
  const { usable } = limits(profile, config)
  return Math.max(0, usable - tokenCount(system || "") - tokenCount(safeStringify(toolSpecs || [])))
}

// A checkpoint always costs some tokens of its own (prefix + summary + project
// context). Summarizing a head smaller than this cannot shrink the request.
const MIN_USEFUL_HEAD_TOKENS = 256

/**
 * Decide whether an automatic checkpoint is worth running. It is not when the
 * request is over budget only because the immutable system prompt + tool catalog
 * are huge and the conversation itself is still tiny: replacing those few
 * messages with a checkpoint would make the request bigger, not smaller.
 *
 * The "budget too small to write any summary" case is deliberately NOT skipped,
 * so compact() still runs and reports the terminal failure (no model request is
 * allowed in that situation).
 */
function needsCompaction({ system, messages, toolSpecs, lastInput, profile, config }) {
  const { usable, threshold } = limits(profile, config)
  const measured = Number.isFinite(lastInput) && lastInput > 0 ? lastInput : 0
  if (Math.max(requestTokens(system, messages, toolSpecs), measured) < threshold) return false

  const configuredKeep = config && config.keep && Number(config.keep.tokens) > 0 ? Math.floor(Number(config.keep.tokens)) : 0
  const keepTokens = configuredKeep > 0
    ? Math.min(configuredKeep, Math.max(1, usable - 1))
    : Math.min(20000, Math.floor(usable * 0.2))
  if (messagesTokens(messages) > keepTokens + MIN_USEFUL_HEAD_TOKENS) return true

  // Nothing to gain. Only proceed if the summary itself cannot fit, because the
  // caller must surface that failure instead of silently sending an impossible
  // request.
  const normalized = normalizeProfile(profile)
  const maxOutput = Math.max(1, Math.min(normalized.maxOutput, 4096))
  const fixedInput = tokenCount(SUMMARY_SYSTEM) + tokenCount(`<conversation>\n\n</conversation>\n\n${TEMPLATE}`) + MESSAGE_OVERHEAD
  return usable - fixedInput - maxOutput - 64 < 48
}

/** Clear old tool outputs in a provided message array. Caller decides whether to commit the array. */
function prune(messages, profile, config) {
  if (!Array.isArray(messages)) return 0
  const { limit } = limits(profile, config)
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

/** Drop the template's own instruction lines when a model copies them into its answer. */
function stripTemplateEcho(text) {
  return String(text || "")
    .replace(/<\/?template>/gi, "")
    .replace(/^[ \t]*Break the objective into smaller goals and report.*\n?/gim, "")
    .replace(/^[ \t]*List the files and directories, other than the current working directory.*\n?/gim, "")
}

function validSummary(summary) {
  const s = String(summary || "").trim()
  const objective = /##\s+(Goal|Objective)\b/i.test(s)
  const state = /##\s+(Accomplished|Discoveries|Work State|Next Move)\b/i.test(s)
  return s.length >= 40 && objective && state
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
    "## Objective", users.at(-1) || users[0] || "- Continue the user's current task.",
    "## Requirements", users.slice(-5).join("\n") || "- (none)",
    "## Decisions", "- (none)",
    "## Work State", "### Completed", assistant.slice(-8).join("\n") || "- (none)", "### Active", users.at(-1) || "- (none)", "### Blocked", errors.slice(-8).join("\n") || "- (none)",
    "## Next Move", "1. Continue from the latest retained user request.",
    "## Relevant Files", [...files].slice(-15).map((file) => `- ${file}`).join("\n") || "- (none)",
    "## Important Context", "- Preserve the newest conversation over stale earlier goals.",
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

/**
 * OpenCode-style summary split: keep recent messages verbatim, but even when
 * the whole conversation fits the keep allowance retain only the latest user
 * exchange so there is meaningful older history to summarize. Tool-result-only
 * user turns are not boundaries; they stay with their assistant tool call.
 */
function pickSummaryCut(messages, keepTokens) {
  if (!Array.isArray(messages) || !messages.length) return 0
  // A previous checkpoint "keeps recent" when it retained a tail (displayAfter > 0).
  const previousKeepsRecent = !!messages[0]?.summary && Number(messages[0].displayAfter) > 0
  const entries = messages.flatMap((message, index) => {
    if (message?.summary) return []
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const visible = parts.some((part) =>
      part?.type === "tool_call" || part?.type === "tool_result" || part?.type === "image" || (part?.type === "text" && !part.agentOnly),
    )
    return visible ? [{ message, index, tokens: msgTokens(message) }] : []
  })
  if (!entries.length) return previousKeepsRecent ? Math.min(1, messages.length) : messages.length

  const keep = Math.max(0, Number.isFinite(keepTokens) ? Math.floor(keepTokens) : 0)
  // Walk from the newest message backward, accumulating tokens until the keep
  // allowance is used up. The retained tail may overrun `keep` only when it must
  // stop on a whole-exchange boundary (a single large message cannot be split).
  let start = entries.length
  let total = 0
  while (start > 0) {
    const next = total + entries[start - 1].tokens
    if (next > keep) break
    total = next
    start--
  }
  // `dropped` is the count of oldest entries given up to the summary. Never drop
  // so far that nothing remains to retain.
  const dropped = Math.min(start, entries.length - 1)
  const isUser = (entry) => entry.message?.role === "user" && (entry.message.parts || []).some((part) => part?.type === "text" && !part.agentOnly)
  // Choose the latest user boundary at or before `dropped` so a whole exchange
  // is retained (an assistant tool_call and its result stay together).
  let boundary = -1
  for (let i = 0; i <= dropped; i++) if (isUser(entries[i])) boundary = i
  // When nothing within the allowance begins at a user text, keep the latest
  // exchange verbatim so there is always an older part for the summary to cover
  // (OpenCode parity) and so the current user's request is never dropped.
  if (boundary <= 0) {
    for (let i = entries.length - 1; i > 0; i--) {
      if (isUser(entries[i])) { boundary = i; break }
    }
  }

  let cut
  if (boundary > 0) cut = entries[boundary].index
  else if (previousKeepsRecent) cut = Math.min(1, messages.length)
  else cut = messages.length

  // Choose the nearest valid + safe boundary at or after the ideal split so a
  // tool_call is never separated from its result across the cut.
  for (let candidate = Math.max(1, cut); candidate <= messages.length; candidate++) {
    if (candidate < messages.length && !validCut(messages[candidate])) continue
    if (cutIsSafe(messages, candidate)) return candidate
  }
  return pickSafeCut(messages, keepTokens)
}

function checkpointMessage(session, summary, reason = "auto", summarySource = "llm", summaryModel = "", displayAfter = 0) {
  const sourceNote = summarySource === "fallback" ? "[Automatic fallback summary; the LLM summary was unavailable.]\n\n" : ""
  return {
    role: "user",
    summary: true,
    compactionReason: reason,
    summarySource,
    displayAfter: Math.max(0, Number(displayAfter) || 0),
    ...(summaryModel ? { summaryModel } : {}),
    parts: [{ type: "text", text: `${CHECKPOINT_PREFIX}\n\n${sourceNote}${summary}\n\n${projectContext(session)}` }],
  }
}

async function generateSummaryWithin({ profile, apiKey, signal, head, previousSummary, targetTokens, onDelta, onActivity }) {
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
    if (typeof onDelta === "function") onDelta({ reset: true, text: "", delta: "" })
    for await (const event of llm.stream({ ...normalized, maxOutput }, { apiKey, system: SUMMARY_SYSTEM, messages, tools: [], signal })) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Context compaction cancelled")
      if (typeof onActivity === "function") onActivity()
      if (event?.type === "text") {
        const delta = String(event.delta || "")
        text += delta
        // Show the live text without the echoed <template> wrapper (an inert HTML
        // element that would hide the streaming summary) or a half-typed tag.
        if (typeof onDelta === "function" && delta) onDelta({ reset: false, text: stripTemplateEcho(text).replace(/<\/?t?e?m?p?l?a?t?e?$/i, "").replace(/^\s+/, ""), delta })
      }
      if (event?.type === "finish") break
    }
    // Models often echo the prompt's <template> wrapper. In HTML <template> is an
    // inert element, so the whole checkpoint would be invisible in the UI.
    const summary = stripTemplateEcho(text).trim()
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

/** Run summary generation with a silence timeout that falls back safely. */
async function generateSummary(options) {
  const parentSignal = options.signal
  const timeoutMs = Number(options.timeoutMs) > 0
    ? Math.max(50, Math.min(120000, Math.floor(Number(options.timeoutMs))))
    : SUMMARY_SILENCE_TIMEOUT_MS
  const ctl = new AbortController()
  let timer = null
  let timedOut = false
  const onParentAbort = () => ctl.abort(parentSignal.reason)
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      ctl.abort(new Error(`Summary model was silent for ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs)
  }
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true })
  arm()
  try {
    return await generateSummaryWithin({ ...options, signal: ctl.signal, onActivity: arm })
  } catch (error) {
    if (!timedOut) throw error
    const fallback = mechanicalSummary(options.head)
    if (fallback.length < 80) throw error
    return {
      summary: fallback,
      source: "fallback",
      warning: `The summary model did not send data for ${Math.round(timeoutMs / 1000)}s; a safe fallback checkpoint was created instead.`,
    }
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}

/**
 * Compact a session in place. History is untouched until the summary is ready.
 *
 * Options beyond the session:
 *   config          config.json -> compaction block (auto/keep/buffer/maxRuns)
 *   summaryProfile  optional profile that writes the checkpoint (V-20)
 *   summaryApiKey   key for that profile
 *   archive         optional (entry) => void; called with the replaced head (V-19)
 */
async function compact({
  session,
  profile,
  apiKey,
  signal,
  reason = "auto",
  system = "",
  toolSpecs = [],
  targetTokens = 0,
  config = null,
  summaryProfile = null,
  summaryApiKey = "",
  summaryTimeoutMs = 0,
  onSummaryDelta = null,
  archive = null,
}) {
  if (!session || !Array.isArray(session.messages)) {
    return { before: 0, after: 0, summarized: false, committed: false, fitsBudget: false, reason, error: "Invalid session: messages must be an array." }
  }

  const before = requestTokens(system, session.messages, toolSpecs)
  const normalized = normalizeProfile(profile)
  const { usable } = limits(normalized, config)
  const budgetLimit = Number.isFinite(targetTokens) && targetTokens > 0
    ? Math.min(usable, Math.max(1, Math.floor(targetTokens)))
    : usable

  // maxRuns: 0 (the default) means unlimited. A positive value still guards
  // against a provider that keeps rejecting an already compacted history.
  const maxRuns = config && Number(config.maxRuns) > 0 ? Math.floor(Number(config.maxRuns)) : 0
  if (reason === "auto" && maxRuns > 0 && (Number(session.compactions) || 0) >= maxRuns) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: `Automatic compaction stopped after ${maxRuns} successful compactions; the request may still exceed budget.` }
  }

  // Work on clones. prune() is allowed to shrink the candidate history, but a
  // failed summary must leave the actual session messages byte-for-byte intact.
  const candidateMessages = cloneMessages(session.messages)
  const prunedTokens = prune(candidateMessages, normalized, config)
  const configuredKeep = config && config.keep && Number(config.keep.tokens) > 0 ? Math.floor(Number(config.keep.tokens)) : 0
  const keepTokens = configuredKeep > 0
    ? Math.min(configuredKeep, Math.max(1, budgetLimit - 1))
    : Math.min(20000, Math.floor(budgetLimit * 0.2))
  const cut = pickSummaryCut(candidateMessages, keepTokens)

  if (cut <= 0) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Cannot compact safely: no valid split boundary preserves the known tool-call/result relationships." }
  }

  const head = candidateMessages.slice(0, cut)
  const tail = candidateMessages.slice(cut)
  if (!head.length) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Cannot compact because a safe split produced an empty head." }
  }

  // V-20: the checkpoint can be written by a separate (usually cheaper/faster)
  // model. The fallback keeps the session model when the profile is unusable.
  const summarizer = summaryProfile ? normalizeProfile(summaryProfile) : normalized
  const summarizerKey = summaryProfile ? summaryApiKey || apiKey : apiKey
  const sessionModel = profile?.id && profile?.model ? `${profile.id}/${profile.model}` : (session.profile || "")
  const configuredSummaryModel = summaryProfile
    ? summaryProfile.summaryModelKey || summaryProfile.id || summaryProfile.model || "custom"
    : sessionModel
  let usedSummaryModel = configuredSummaryModel
  const progressFor = (model) => (update) => {
    if (typeof onSummaryDelta === "function") onSummaryDelta({ ...update, summaryModel: model })
  }
  let generated
  // A previous checkpoint is already the first message in `head`. Repeating it
  // again after the transcript over-weights stale goals (the reported session
  // repeated its old MCP topic and ignored newer YouTube/Binance research).
  const previousSummary = head.some((message) => message?.summary) ? "" : session.compactedSummary
  try {
    generated = await generateSummary({
      profile: summarizer,
      apiKey: summarizerKey,
      signal,
      head,
      previousSummary,
      targetTokens: budgetLimit,
      timeoutMs: summaryTimeoutMs,
      onDelta: progressFor(configuredSummaryModel),
    })
    // A configured low-cost summary model may be down or return malformed text.
    // Try the active session model once before accepting a mechanical fallback.
    if (summaryProfile && generated.source === "fallback" && configuredSummaryModel !== sessionModel) {
      const firstWarning = generated.warning
      const retry = await generateSummary({
        profile: normalized,
        apiKey,
        signal,
        head,
        previousSummary,
        targetTokens: budgetLimit,
        timeoutMs: summaryTimeoutMs,
        onDelta: progressFor(sessionModel),
      })
      if (retry.source === "llm") {
        generated = { ...retry, warning: [firstWarning, `Retried with the session model (${sessionModel}).`].filter(Boolean).join(" ") }
        usedSummaryModel = sessionModel
      } else {
        generated.warning = [firstWarning, retry.warning].filter(Boolean).join(" ")
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: error?.message || String(error) }
  }

  const summary = String(generated?.summary || "").trim()
  if (!summary) {
    return { before, after: before, summarized: false, committed: false, fitsBudget: before <= budgetLimit, budgetLimit, reason, error: "Summary generation returned empty content; original history was preserved." }
  }

  const summaryModel = usedSummaryModel
  // The model must read the checkpoint first, but the chat timeline should show
  // it where compaction happened: after the retained pre-compaction tail and
  // before messages created later.
  const nextMessages = [checkpointMessage(session, summary, reason, generated.source || "llm", summaryModel, tail.length), ...tail]
  const after = requestTokens(system, nextMessages, toolSpecs)
  const fitsBudget = after <= budgetLimit

  // The summary writer sizes its checkpoint against its own budget, but the
  // *session* request that follows (checkpoint + retained tail + system + tools)
  // is measured against the session profile. When the retained tail is too big
  // for that combined request, drop the oldest whole safe tail units until the
  // request fits. `cutIsSafe` keeps tool_call/tool_result pairs together and
  // never orphans a result across the boundary. The checkpoint's displayAfter
  // stays the number of retained messages so the chat places it correctly.
  let committedTail = tail
  let fits = after <= budgetLimit
  // The current user's request is the one message that must never be dropped by
  // trimming - it is what the run is answering. Find the index of the newest
  // user text message so `trimTailToFit` keeps at least that exchange.
  const latestUserIndex = (() => {
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
      const msg = candidateMessages[i]
      if (msg?.role === "user" && (msg.parts || []).some((p) => p?.type === "text" && !p.agentOnly)) return i
    }
    return candidateMessages.length // no user text: everything may be trimmed
  })()
  if (!fits) {
    const keepMax = latestUserIndex >= candidateMessages.length ? candidateMessages.length : latestUserIndex
    for (let keepAt = cut + 1; keepAt <= keepMax; keepAt++) {
      if (keepAt < candidateMessages.length && !cutIsSafe(candidateMessages, keepAt)) continue
      const candidate = [checkpointMessage(session, summary, reason, generated.source || "llm", summaryModel, candidateMessages.length - keepAt), ...candidateMessages.slice(keepAt)]
      if (requestTokens(system, candidate, toolSpecs) <= budgetLimit) {
        committedTail = candidateMessages.slice(keepAt)
        fits = true
        break
      }
    }
    // Never let trimming erase the current user request entirely. If the only
    // safe trim is to drop it, keep the latest exchange and report over-budget.
    if (committedTail.length === 0 && latestUserIndex < candidateMessages.length) {
      committedTail = tail
      fits = false
    }
  }
  const effectiveTail = committedTail
  const finalNextMessages = [checkpointMessage(session, summary, reason, generated.source || "llm", summaryModel, effectiveTail.length), ...effectiveTail]
  const finalAfter = requestTokens(system, finalNextMessages, toolSpecs)
  // Blocking on over-budget matters only when the *retained tail* (the current
  // user request that must be preserved) is itself too large to ever send - e.g.
  // a single oversized prompt. A marginal overshoot from the app's own system +
  // tool-catalog overhead is not something another compaction pass can fix, so
  // the run proceeds and any real provider overflow is handled by the next
  // compaction (bounded by maxRuns). A request that fits, or whose retained tail
  // is small, therefore does not block; only a huge retained tail does.
  const tailTokens = messagesTokens(effectiveTail)
  const finalFits = finalAfter <= budgetLimit || tailTokens <= Math.max(0, budgetLimit * 0.5)

  // V-19: write the replaced head to an archive before it is dropped. A failed
  // archive write must never block compaction, so it is best-effort.
  if (typeof archive === "function") {
    try {
      archive({
        at: Date.now(),
        reason,
        summary,
        messages: head,
        before,
        after: finalAfter,
        summarySource: generated.source || "llm",
        summarizer: summaryModel,
      })
    } catch {}
  }

  // Atomic commit point: no user history mutation occurred before this line.
  finalNextMessages[0].contextTokens = finalAfter // lets the context ring show the real size right after compaction
  session.messages = finalNextMessages
  session.compactions = (session.compactions || 0) + 1
  session.compactedSummary = summary
  if (session.usage && typeof session.usage === "object") session.usage.lastInput = 0

  const result = {
    before,
    after: finalAfter,
    summarized: true,
    committed: true,
    fitsBudget: finalFits,
    budgetLimit,
    prunedTokens,
    summary,
    summarySource: generated.source || "llm",
    reason,
  }
  result.summaryModel = summaryModel
  if (generated.warning) result.warning = generated.warning
  if (!finalFits) {
    result.error = `Checkpoint committed, but the resulting request remains over budget (${finalAfter} estimated input tokens; budget ${budgetLimit}). Do not send another model request without recovery.`
  }
  return result
}

/**
 * V-19: append a compacted head to <dir>/<sessionId>.archive.json.
 * The two newest checkpoints are kept on disk; the model never sees this file.
 */
function writeArchive(dir, sessionId, entry) {
  if (!dir || !sessionId) return null
  const file = path.join(dir, String(sessionId) + ".archive.json")
  let list = []
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {}
  if (!Array.isArray(list)) list = []
  list.unshift(entry)
  const kept = list.slice(0, MAX_ARCHIVES)
  const tmp = file + "." + process.pid + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(kept))
  fs.renameSync(tmp, file)
  return { file, count: kept.length }
}

/** Read the kept archives for a session (newest first). */
function readArchives(dir, sessionId) {
  if (!dir || !sessionId) return []
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, String(sessionId) + ".archive.json"), "utf8"))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

module.exports = {
  compact,
  writeArchive,
  readArchives,
  prune,
  needsCompaction,
  requestTokens,
  messagesTokens,
  msgTokens,
  partTokens,
  pickCut,
  pickSafeCut,
  pickSummaryCut,
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
  SUMMARY_SILENCE_TIMEOUT_MS,
}
