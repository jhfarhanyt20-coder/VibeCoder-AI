"use strict"

// Canonical usage categories used by the engine and context ring. `input` and
// `output` are the non-cache / non-reasoning portions so adding every category
// produces the provider's total without double-counting nested detail fields.
const number = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

const firstNumber = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null || !Number.isFinite(Number(value))) continue
    const found = number(value)
    if (found > 0) return found
  }
  return 0
}

const creationBreakdown = (value) => {
  if (!value || typeof value !== "object") return 0
  return number(value.ephemeral_5m_input_tokens) + number(value.ephemeral_1h_input_tokens)
}

function canonicalUsage(value = {}) {
  return {
    input: number(value.input),
    output: number(value.output),
    reasoning: number(value.reasoning),
    cache: {
      read: number(value.cache?.read),
      write: number(value.cache?.write),
    },
    ...(value.cost !== undefined && value.cost !== null && Number.isFinite(Number(value.cost)) && Number(value.cost) >= 0 ? { cost: Number(value.cost), costSource: value.costSource || "provider" } : {}),
  }
}

function openAIUsage(raw = {}) {
  const inputDetails = raw.prompt_tokens_details || raw.input_tokens_details || {}
  const outputDetails = raw.completion_tokens_details || raw.output_tokens_details || {}
  const totalInput = firstNumber(raw.prompt_tokens, raw.input_tokens)
  const totalOutput = firstNumber(raw.completion_tokens, raw.output_tokens)
  const cacheRead = firstNumber(
    inputDetails.cached_tokens,
    inputDetails.cache_read_tokens,
    raw.prompt_cache_hit_tokens,
    raw.cache_read_input_tokens,
    raw.cache_read_tokens,
    raw.cached_tokens,
    raw.cached_content_token_count,
  )
  const cacheWrite = firstNumber(
    inputDetails.cache_creation_tokens,
    inputDetails.cache_write_tokens,
    raw.cache_creation_input_tokens,
    raw.cache_write_input_tokens,
    raw.cache_write_tokens,
    creationBreakdown(raw.cache_creation),
  )
  const reasoning = firstNumber(outputDetails.reasoning_tokens, raw.reasoning_tokens, raw.thinking_tokens, raw.thoughts_token_count)
  const freshInput = raw.prompt_cache_miss_tokens !== undefined
    ? number(raw.prompt_cache_miss_tokens)
    : Math.max(0, totalInput - cacheRead - cacheWrite)
  return canonicalUsage({
    input: freshInput,
    output: Math.max(0, totalOutput - reasoning),
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
    cost: raw.cost,
  })
}

function anthropicUsage(raw = {}) {
  const cacheRead = firstNumber(raw.cache_read_input_tokens, raw.cache_read_tokens)
  const cacheWrite = firstNumber(
    raw.cache_creation_input_tokens,
    raw.cache_write_input_tokens,
    creationBreakdown(raw.cache_creation),
  )
  const reasoning = firstNumber(raw.reasoning_tokens, raw.thinking_tokens, raw.output_tokens_details?.reasoning_tokens)
  // Anthropic defines input_tokens as uncached input. Cache read/creation are
  // separate additive categories, unlike OpenAI's cached-token subset.
  return canonicalUsage({
    input: raw.input_tokens,
    output: Math.max(0, number(raw.output_tokens) - reasoning),
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
    cost: raw.cost,
  })
}

const inputTotal = (usage) => {
  const value = canonicalUsage(usage)
  return value.input + value.cache.read + value.cache.write
}

const outputTotal = (usage) => {
  const value = canonicalUsage(usage)
  return value.output + value.reasoning
}

function estimateCost(usage, pricing) {
  if (usage.cost !== undefined) return canonicalUsage(usage)
  const u = canonicalUsage(usage)
  if (!pricing) return u
  const categories = [[u.input, pricing.input], [u.output + u.reasoning, pricing.output], [u.cache.read, pricing.cache_read], [u.cache.write, pricing.cache_write]]
  let cost = 0
  for (const [tokens, rate] of categories) {
    if (!tokens) continue
    if (rate === undefined || rate === null || !Number.isFinite(Number(rate)) || Number(rate) < 0) return u
    cost += tokens * Number(rate) / 1e6
  }
  return { ...u, cost, costSource: "estimated" }
}

module.exports = { canonicalUsage, openAIUsage, anthropicUsage, inputTotal, outputTotal, estimateCost }
