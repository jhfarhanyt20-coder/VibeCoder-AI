"use strict"
/**
 * Engine history (role/parts, tool_call+tool_result) -> the message schema
 * renderer/app.js renders (type/ content parts / state). Used by getMessages.
 */
function convertMessages(session) {
  const results = new Map()
  for (const m of session.messages) {
    if (m.role !== "user") continue
    for (const p of m.parts) if (p.type === "tool_result") results.set(p.id, p)
  }
  const out = []
  const deferredCompactions = []
  const flushCompactions = (internalIndex) => {
    for (let j = 0; j < deferredCompactions.length;) {
      if (deferredCompactions[j].target > internalIndex) { j++; continue }
      out.push(deferredCompactions[j].row)
      deferredCompactions.splice(j, 1)
    }
  }
  session.messages.forEach((m, i) => {
    if (m.role === "user" && m.summary) {
      const raw = String((m.parts[0] && m.parts[0].text) || "")
      const prefix = "[Checkpoint: the earlier part of this conversation was compacted. Continue from this summary.]"
      let checkpoint = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw.trim()
      checkpoint = checkpoint.replace(/<\/?template>/gi, "").replace(/^[ \t]*Break the objective into smaller goals and report.*\n?/gim, "").replace(/^[ \t]*List the files and directories, other than the current working directory.*\n?/gim, "").trim() // also repairs checkpoints saved before the fix
      const contextMarker = "\n\n## Project context\n"
      const contextAt = checkpoint.lastIndexOf(contextMarker)
      const projectContext = contextAt >= 0 ? checkpoint.slice(contextAt + 2).trim() : ""
      if (contextAt >= 0) checkpoint = checkpoint.slice(0, contextAt).trim()
      const row = {
        id: `cmp-${i}`,
        type: "compaction",
        status: "completed",
        reason: m.compactionReason || "auto",
        summary: checkpoint,
        projectContext,
        summarySource: m.summarySource || "llm",
        summaryModel: m.summaryModel || "",
        contextTokens: Number(m.contextTokens) || 0,
        time: { created: session.updatedAt },
      }
      const legacyDisplayAfter = i === 0 && Number(session.usage?.lastInput || 0) === 0 ? session.messages.length - 1 : null
      const displayAfter = Number.isInteger(m.displayAfter) && m.displayAfter >= 0 ? m.displayAfter : legacyDisplayAfter
      if (displayAfter != null) {
        deferredCompactions.push({ target: i + displayAfter, row })
        flushCompactions(i)
      } else out.push(row)
      return
    }
    if (m.role === "user") {
      // agentOnly parts (automatic background-job notices, auto-continue nudges)
      // go to the model but must never show up as a chat bubble.
      const texts = m.parts.filter((p) => p.type === "text" && !p.agentOnly).map((p) => p.text)
      const images = m.parts.filter((p) => p.type === "image" && p.data)
      if (!texts.length && !images.length) { flushCompactions(i); return } // tool-result-only / notice-only: no bubble
      const text = texts.join("\n")
      const content = []
      if (text) content.push({ type: "text", text })
      // media parts so renderSessionHistory() can show the sent images as thumbnails
      for (const im of images) content.push({ type: "media", mime: im.mime, dataUrl: `data:${im.mime};base64,${im.data}` })
      out.push({ id: `msg-${i}`, type: "user", content, metadata: { displayText: text }, time: { created: session.updatedAt } })
      flushCompactions(i)
      return
    }
    const parts = []
    for (const p of m.parts) {
      if (p.type === "text") parts.push({ type: "text", text: p.text })
      else if (p.type === "tool_call") {
        const res = results.get(p.id)
        // carry the stored write/edit diff stats so the +N/-M card survives a reload
        const stats = res && res.stats && typeof res.stats === "object" && Object.keys(res.stats).length ? res.stats : null
        const metadata = stats
          ? (stats.file || stats.additions != null || stats.deletions != null
              ? { [stats.file || (p.args && p.args.path) || "file"]: {
                  patch: stats.patch,
                  additions: stats.additions,
                  deletions: stats.deletions,
                  hunks: stats.hunks,
                  oldLines: stats.oldLines,
                  newLines: stats.newLines,
                } }
              : { ...stats })
          : null
        const richMetadata = res && (Number.isFinite(res.durationMs) || Array.isArray(res.artifacts))
          ? {
            ...(metadata || {}),
            ...(Number.isFinite(res.durationMs) ? { durationMs: res.durationMs } : {}),
            ...(Array.isArray(res.artifacts) ? { artifacts: res.artifacts } : {}),
          }
          : metadata
        parts.push({
          type: "tool",
          id: p.id,
          name: p.name,
          state: {
            status: res ? (res.isError ? "error" : "completed") : "running",
            input: p.args || {},
            content: res ? [
              { type: "text", text: String(res.output || "") },
              ...(res.screenshot && typeof res.screenshot.data === "string" && res.screenshot.data
                ? [{ type: "image", mime: String(res.screenshot.mime || "image/png"), dataUrl: `data:${String(res.screenshot.mime || "image/png")};base64,${res.screenshot.data}`, url: String(res.screenshot.url || ""), title: String(res.screenshot.title || ""), tabID: String(res.screenshot.tabID || "") }]
                : []),
            ] : [],
            ...(richMetadata ? { metadata: richMetadata } : {}),
          },
        })
      }
    }
    // tokens + model ride on the step so the context ring can measure the
    // window after a reload (same rule as live: newest step with tokens wins).
    const model = m.model && m.model.providerID ? m.model : undefined
    out.push({
      id: `msg-${i}`,
      type: "assistant",
      content: parts,
      ...(m.usage ? { tokens: {
        input: m.usage.input || 0,
        output: m.usage.output || 0,
        reasoning: m.usage.reasoning || 0,
        cache: {
          read: m.usage.cache?.read || 0,
          write: m.usage.cache?.write || 0,
        },
      } } : {}),
      ...(model ? { model } : {}),
      ...(m.usage?.cost !== undefined ? { cost: m.usage.cost, costSource: m.usage.costSource || "provider" } : {}),
      time: { created: session.updatedAt },
    })
    flushCompactions(i)
  })
  for (const pending of deferredCompactions) out.push(pending.row)
  return out
}

module.exports = { convertMessages }
