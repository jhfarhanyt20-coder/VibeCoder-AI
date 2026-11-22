"use strict"
/**
 * Review, merge or discard the work a Crew helper did in its own workspace.
 * The main agent decides what reaches the real project; nothing is merged
 * automatically. Merges are three-way and never overwrite user edits silently.
 */
const MAX = 24000
const clip = (s) => (s.length <= MAX ? s : `${s.slice(0, MAX)}\n… [cut; call crewChanges with diff: false for the file list only, or read the files you need from the helper workspace]`)

function crew(ctx) {
  const m = ctx && ctx.engine && ctx.engine.subagents
  if (!m || typeof m.mergeWorkspace !== "function") throw new Error("Crew is not available here.")
  return m
}
const idProp = { type: "string", description: "Helper id (from the subagent result, e.g. subagent_…)" }

const crewChanges = {
  name: "crewChanges",
  description: "Show what a finished Crew helper changed in its own workspace (file list and diff). Use it before crewMerge.",
  parameters: { type: "object", properties: { subagentId: idProp, diff: { type: "boolean", description: "Include the diff (default true)" } }, required: ["subagentId"] },
  perm: () => ({ tool: "read", subject: "crew changes" }),
  paths: () => [],
  async run(a, c) {
    const r = crew(c).workspaceChanges(String(a.subagentId), { withDiff: a.diff !== false })
    if (r.mode === "shared") return `This helper worked directly in the project folder (${r.note}). Its changes are already in the project.`
    if (r.state && r.state !== "open") return `This helper's workspace is ${r.state}. ${r.files.length ? `Files: ${r.files.map((f) => f.path).join(", ")}` : ""}`.trim()
    if (!r.files.length) return "The helper changed no files. Use crewDiscard to clean up its workspace."
    return clip(`${r.files.length} file${r.files.length === 1 ? "" : "s"} changed in the helper's own workspace (${r.mode}):\n${r.files.map((f) => `  ${f.status} ${f.path}`).join("\n")}${r.diff ? `\n\n${r.diff}` : ""}\n\nNext: crewMerge to apply (optionally only some files) or crewDiscard to drop them.`)
  },
}

const crewMerge = {
  name: "crewMerge",
  description: "Apply a finished Crew helper's changes to the real project. Three-way merge: files the user did not touch take the helper's version; where both changed, a line merge is made and real conflicts are marked (nothing is silently overwritten). Rewind can undo it. Optionally give only some files.",
  parameters: { type: "object", properties: { subagentId: idProp, files: { type: "array", items: { type: "string" }, description: "Only these paths (relative, as listed by crewChanges)" } }, required: ["subagentId"] },
  perm: (a) => ({ tool: "edit", subject: `crew merge ${a.subagentId}` }),
  paths: () => [],
  async run(a, c) {
    const r = crew(c).mergeWorkspace(String(a.subagentId), { only: Array.isArray(a.files) && a.files.length ? a.files.map(String) : undefined })
    const lines = [`Merged ${r.applied.length} of ${r.total} file${r.total === 1 ? "" : "s"} into the project${r.state === "merged" ? " and removed the helper's workspace" : ""}.`]
    if (r.conflicts.length) lines.push(`Conflicts to fix by hand (marked with <<<<<<< your version / >>>>>>> helper's version): ${r.conflicts.join(", ")}. Read each file, keep the right lines, remove the markers.`)
    if (r.kept.length) lines.push(`Kept the user's version and saved the helper's next to it: ${r.kept.map((k) => (k.helperCopy ? `${k.path} → ${k.helperCopy}` : `${k.path} (helper deleted it)`)).join(", ")}.`)
    if (r.remaining && r.remaining.length) lines.push(`Not merged yet (still in the workspace): ${r.remaining.join(", ")}.`)
    lines.push("Run the project's tests/build to check the combined result.")
    return lines.join("\n")
  },
}

const crewDiscard = {
  name: "crewDiscard",
  description: "Throw away a Crew helper's own workspace and its changes. The project is not touched.",
  parameters: { type: "object", properties: { subagentId: idProp }, required: ["subagentId"] },
  perm: () => ({ tool: "subagent", subject: "discard" }),
  paths: () => [],
  async run(a, c) {
    const r = crew(c).discardWorkspace(String(a.subagentId))
    return r.state === "discarded" ? "Discarded the helper's workspace. The project was not changed." : `Nothing to discard (workspace ${r.state}).`
  },
}

module.exports = { ALL: [crewChanges, crewMerge, crewDiscard] }
