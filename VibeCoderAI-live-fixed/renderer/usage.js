/* Context-window / token-usage helpers: pure functions, no DOM.
 * Loaded by index.html (window.VibeUsage) and by node tests (module.exports). */
;(function (root) {
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0)

  /** Everything the model had to read/write in one step. */
  function sumTokens(t) {
    if (!t) return 0
    return num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache && t.cache.read) + num(t.cache && t.cache.write)
  }

  const modelKey = (m) => (m && m.providerID && m.id ? `${m.providerID}/${m.id}` : null)

  function emptyUsage() {
    return { steps: new Map(), last: null }
  }

  /**
   * Same rule OpenCode's own clients use (lastAssistantWithUsage): the latest assistant step that
   * reported tokens, after the last completed compaction, is what fills the context window now.
   * Every assistant step counts toward the session total.
   */
  function usageFromMessages(msgs) {
    const list = Array.isArray(msgs) ? msgs : []
    const u = emptyUsage()
    for (const m of list) {
      if (m && m.type === "assistant" && m.tokens) {
        u.steps.set(m.id, { tokens: m.tokens, cost: typeof m.cost === "number" ? m.cost : null, costSource: m.costSource })
      }
    }
    let compaction = -1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] && list[i].type === "compaction" && list[i].status === "completed") { compaction = i; break }
    }
    for (let i = list.length - 1; i > compaction; i--) {
      const m = list[i]
      if (m && m.type === "assistant" && m.tokens !== undefined) {
        u.last = { tokens: m.tokens, modelKey: modelKey(m.model) }
        break
      }
    }
    // Right after a compaction nothing has answered yet: show the compacted
    // request size instead of an empty ring.
    if (!u.last && compaction >= 0 && num(list[compaction].contextTokens) > 0) {
      u.last = { tokens: { input: num(list[compaction].contextTokens) }, modelKey: null }
    }
    return u
  }

  /** Live update from a `session.step.ended` event. */
  function addStep(u, id, tokens, cost, costSource, model) {
    if (!tokens) return u
    u.steps.set(id, { tokens, cost: typeof cost === "number" ? cost : null, costSource })
    u.last = { tokens, modelKey: modelKey(model) || (u.last ? u.last.modelKey : null) }
    return u
  }

  const contextUsed = (u) => (u && u.last ? sumTokens(u.last.tokens) : 0)

  /* ---- auto compaction threshold ----
   * Same rule the OpenCode core uses (calculateCeiling): keep a reserve of
   * max(15% of the window, 16k tokens) so the summary itself still fits. */
  const RESERVE_MIN = 16000
  const RESERVE_SHARE = 0.15

  function autoCompactAt(limit) {
    const w = num(limit)
    if (w <= 0) return Infinity
    const reserve = Math.max(Math.floor(w * RESERVE_SHARE), w >= 2 * RESERVE_MIN ? RESERVE_MIN : 0)
    return Math.max(1, w - reserve)
  }

  function shouldAutoCompact(used, limit) {
    const ceiling = autoCompactAt(limit)
    return Number.isFinite(ceiling) && num(used) >= ceiling
  }

  function totals(u) {
    const t = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, all: 0, cost: 0, steps: 0, unknownCost: 0, estimated: false }
    for (const s of u.steps.values()) {
      const k = s.tokens
      t.input += num(k.input); t.output += num(k.output); t.reasoning += num(k.reasoning)
      t.cacheRead += num(k.cache && k.cache.read); t.cacheWrite += num(k.cache && k.cache.write)
      t.cost += num(s.cost); t.steps++
      if (s.cost === null) t.unknownCost++
      if (s.costSource === "estimated") t.estimated = true
    }
    t.all = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite
    return t
  }

  /** [{providerID, modelID, id, context}] -> Map("provider/model" -> context window). */
  function buildLimitMap(list) {
    const out = new Map()
    if (!Array.isArray(list)) return out
    for (const m of list) {
      const ctx = num(m && m.context)
      if (!m || !m.providerID || ctx <= 0) continue
      for (const id of [m.modelID, m.id]) {
        if (!id) continue
        out.set(`${m.providerID}/${id}`, ctx)
        if (String(id).startsWith(m.providerID + "/")) out.set(String(id), ctx)
      }
    }
    return out
  }

  /** ok < 70% <= warn < 90% <= crit */
  function level(ratio) {
    return ratio >= 0.9 ? "crit" : ratio >= 0.7 ? "warn" : "ok"
  }

  function shortNum(n) {
    n = num(n)
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k"
    return String(Math.round(n))
  }

  const api = {
    sumTokens, modelKey, emptyUsage, usageFromMessages, addStep, contextUsed, totals, buildLimitMap, level, shortNum,
    autoCompactAt, shouldAutoCompact,
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api
  else root.VibeUsage = api
})(typeof window !== "undefined" ? window : globalThis)
