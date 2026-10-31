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
  session.messages.forEach((m, i) => {
    if (m.role === "user" && m.summary) {
      const raw = String((m.parts[0] && m.parts[0].text) || "")
      const prefix = "[Checkpoint: the earlier part of this conversation was compacted. Continue from this summary.]"
      let checkpoint = raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw.trim()
      const contextMarker = "\n\n## Project context\n"
      const contextAt = checkpoint.lastIndexOf(contextMarker)
      const projectContext = contextAt >= 0 ? checkpoint.slice(contextAt + 2).trim() : ""
      if (contextAt >= 0) checkpoint = checkpoint.slice(0, contextAt).trim()
      out.push({
        id: `cmp-${i}`,
        type: "compaction",
        status: "completed",
        reason: m.compactionReason || "auto",
        summary: checkpoint,
        projectContext,
        summarySource: m.summarySource || "llm",
        summaryModel: m.summaryModel || "",
        time: { created: session.updatedAt },
      })
      return
    }
    if (m.role === "user") {
      // agentOnly parts (automatic background-job notices, auto-continue nudges)
      // go to the model but must never show up as a chat bubble.
      const texts = m.parts.filter((p) => p.type === "text" && !p.agentOnly).map((p) => p.text)
      const images = m.parts.filter((p) => p.type === "image" && p.data)
      if (!texts.length && !images.length) return // tool-result-only / notice-only: no bubble
      const text = texts.join("\n")
      const content = []
      if (text) content.push({ type: "text", text })
      // media parts so renderSessionHistory() can show the sent images as thumbnails
      for (const im of images) content.push({ type: "media", mime: im.mime, dataUrl: `data:${im.mime};base64,${im.data}` })
      out.push({ id: `msg-${i}`, type: "user", content, metadata: { displayText: text }, time: { created: session.updatedAt } })
      return
    }
    const parts = []
    for (const p of m.parts) {
      if (p.type === "text") parts.push({ type: "text", text: p.text })
      else if (p.type === "tool_call") {
        const res = results.get(p.id)
        // carry the stored write/edit diff stats so the +N/-M card survives a reload
        const stats = res && res.stats && (res.stats.additions != null || res.stats.deletions != null) ? res.stats : null
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
            ...(stats ? { metadata: { [stats.file || (p.args && p.args.path) || "file"]: {
              patch: stats.patch,
              additions: stats.additions,
              deletions: stats.deletions,
              hunks: stats.hunks,
              oldLines: stats.oldLines,
              newLines: stats.newLines,
            } } } : {}),
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
      ...(m.usage ? { tokens: { input: m.usage.input || 0, output: m.usage.output || 0 } } : {}),
      ...(model ? { model } : {}),
      time: { created: session.updatedAt },
    })
  })
  return out
}

module.exports = { convertMessages }
