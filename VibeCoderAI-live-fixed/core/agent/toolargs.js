"use strict"
/**
 * Tool-call cleanup before a tool runs. Models (small ones especially) send
 * arguments in many shapes: other tools' parameter names (file_path, cmd),
 * numbers and booleans as strings, arrays as JSON text, JSON wrapped in code
 * fences, a tool name in another case. Each of those used to cost a turn or
 * loop. This layer accepts what clearly means the same thing and, when it
 * cannot, says exactly what was wrong, that nothing ran, and what to send.
 */

// Other common names for the same parameter. An alias is used only when the
// tool's own parameter is missing, and only if the tool really has that parameter.
const ALIASES = {
  path: ["file_path", "filePath", "filepath", "file", "filename", "fileName", "target_file", "targetFile", "absolute_path", "dir", "directory", "folder"],
  oldString: ["old_string", "old_str", "oldStr", "oldText", "old_text", "old", "search", "find", "from"],
  newString: ["new_string", "new_str", "newStr", "newText", "new_text", "new", "replace", "replacement", "to"],
  replaceAll: ["replace_all", "all", "global"],
  content: ["contents", "text", "file_text", "fileText", "data", "body", "code", "file_content"],
  command: ["cmd", "script", "commandLine", "command_line", "shell", "bash"],
  pattern: ["query", "regex", "search", "glob", "q", "search_pattern"],
  url: ["link", "href", "uri", "address"],
  offset: ["start_line", "startLine", "line", "from_line", "start"],
  limit: ["max_lines", "maxLines", "lines", "count", "num_lines"],
  todos: ["items", "tasks", "list"],
  edits: ["changes", "replacements"],
  include: ["file_pattern", "filePattern", "files", "glob_pattern"],
  timeout: ["timeout_ms", "timeoutMs"],
  description: ["desc", "summary"],
  prompt: ["instructions", "message"],
}

function stripFences(s) {
  return String(s).trim().replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
}

/** Try hard to read tool arguments sent as text. Returns an object or throws a helpful error. */
function repairJson(raw) {
  let text = stripFences(raw == null ? "" : raw)
  if (!text) return {}
  const attempts = []
  attempts.push(text)
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1))
  for (const t of [...attempts]) attempts.push(t.replace(/,\s*([}\]])/g, "$1"))
  let lastError = null
  for (const t of attempts) {
    try {
      let v = JSON.parse(t)
      if (typeof v === "string") { try { v = JSON.parse(stripFences(v)) } catch {} } // double-encoded
      if (v && typeof v === "object" && !Array.isArray(v)) return v
    } catch (e) { lastError = e }
  }
  const err = new Error(lastError ? lastError.message : "not a JSON object")
  err.parse = true
  throw err
}

function schemaProps(tool) {
  return (tool && tool.parameters && tool.parameters.properties) || {}
}

function describeParams(tool) {
  const props = schemaProps(tool)
  const req = new Set((tool.parameters && tool.parameters.required) || [])
  const parts = Object.entries(props).map(([k, v]) => `${k} (${(v && v.type) || "any"}${req.has(k) ? ", required" : ""})`)
  return parts.length ? parts.join(", ") : "no arguments"
}

function exampleCall(tool) {
  const props = schemaProps(tool)
  const req = (tool.parameters && tool.parameters.required) || []
  const obj = {}
  for (const k of req) {
    const t = props[k] && props[k].type
    obj[k] = t === "integer" || t === "number" ? 1 : t === "boolean" ? true : t === "array" ? [] : t === "object" ? {} : "..."
  }
  return JSON.stringify(obj)
}

function coerce(value, spec) {
  if (!spec || value == null) return value
  const type = Array.isArray(spec.type) ? spec.type.find((t) => t !== "null") : spec.type
  if ((type === "integer" || type === "number") && typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return type === "integer" ? Math.trunc(n) : n
  }
  if (type === "boolean" && typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (["true", "1", "yes", "y", "on"].includes(v)) return true
    if (["false", "0", "no", "n", "off", ""].includes(v)) return false
  }
  if (type === "boolean" && typeof value === "number") return value !== 0
  if ((type === "array" || type === "object") && typeof value === "string") {
    const s = stripFences(value)
    if (/^[\[{]/.test(s)) {
      try {
        const v = JSON.parse(s)
        if (type === "array" ? Array.isArray(v) : v && typeof v === "object" && !Array.isArray(v)) return v
      } catch {}
    }
  }
  if (type === "string" && Array.isArray(value) && value.every((x) => typeof x === "string" || typeof x === "number")) return value.join(" ")
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value)
  return value
}

/**
 * Make `args` fit `tool`'s schema. Returns { args, notes } where notes are short
 * remarks worth telling the model (e.g. "timeout read as seconds").
 * Throws an Error with a model-friendly message when the call cannot run.
 */
function prepareArgs(tool, rawArgs, { finish } = {}) {
  let args = rawArgs
  const notes = []
  if (args && typeof args === "object" && args.__parseError) {
    try { args = repairJson(args.raw) }
    catch (e) {
      const raw = String(args.raw || "")
      const cut = finish === "length" || finish === "max_tokens"
      throw new Error(
        `The arguments for "${tool.name}" were not valid JSON (${e.message}). Nothing was executed.` +
        (raw ? ` They started with: ${raw.slice(0, 160).replace(/\s+/g, " ")}${raw.length > 160 ? "…" : ""}` : "") +
        (cut ? ` Your output limit cut the call off: send a smaller call (for a big file, write a short first part, then add the rest with edit).` : ` Send the call again with a single valid JSON object, for example ${exampleCall(tool)}.`),
      )
    }
  }
  if (typeof args === "string") {
    try { args = repairJson(args) } catch { args = null }
  }
  if (args == null) args = {}
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`Tool arguments must be a JSON object, for example ${exampleCall(tool)}. Nothing was executed.`)
  }
  args = { ...args }
  const props = schemaProps(tool)
  // Parameter names other tools use for the same thing.
  for (const [canon, alts] of Object.entries(ALIASES)) {
    if (!(canon in props) || args[canon] != null) continue
    const hit = alts.find((k) => args[k] != null && !(k in props))
    if (hit) { args[canon] = args[hit]; delete args[hit] }
  }
  // Case/underscore variants of real parameter names (file_path → filePath, Path → path).
  const flat = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "")
  const byFlat = new Map(Object.keys(props).map((k) => [flat(k), k]))
  for (const k of Object.keys(args)) {
    if (k in props) continue
    const canon = byFlat.get(flat(k))
    if (canon && args[canon] == null) { args[canon] = args[k]; delete args[k] }
  }
  for (const [k, spec] of Object.entries(props)) if (k in args) args[k] = coerce(args[k], spec)
  // A timeout like 60 or 300 is almost always meant in seconds.
  if (props.timeout && typeof args.timeout === "number" && args.timeout > 0 && args.timeout < 1000 && /ms|milli/i.test(String(props.timeout.description || "ms"))) {
    notes.push(`timeout ${args.timeout} was read as ${args.timeout} s`)
    args.timeout = args.timeout * 1000
  }
  // "src/app.js:120" → path + offset, for tools that read by line.
  if (typeof args.path === "string" && props.offset && args.offset == null) {
    const m = /^(.*\.[A-Za-z0-9]+):(\d+)(?::\d+)?$/.exec(args.path)
    if (m) { args.path = m[1]; args.offset = Number(m[2]) }
  }
  const missing = ((tool.parameters && tool.parameters.required) || []).filter((k) => args[k] == null || (typeof args[k] === "string" && props[k] && props[k].type === "string" && args[k] === "" && k !== "content" && k !== "newString"))
  if (missing.length) {
    const sent = Object.keys(rawArgs && typeof rawArgs === "object" && !rawArgs.__parseError ? rawArgs : args)
    throw new Error(
      `Missing required argument${missing.length > 1 ? "s" : ""} ${missing.map((k) => `"${k}"`).join(", ")} for tool "${tool.name}". Nothing was executed. ` +
      `You sent: ${sent.length ? sent.join(", ") : "no arguments"}. Expected: ${describeParams(tool)}. Example: ${exampleCall(tool)}`,
    )
  }
  return { args, notes }
}

function editDistance(a, b) {
  a = String(a); b = String(b)
  if (Math.abs(a.length - b.length) > 8) return 99
  const d = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[b.length]
}

/** Find a tool by name, forgiving case, punctuation and well-known other names. */
function findTool(name, list, aliases = {}) {
  const n = String(name || "")
  const exact = list.find((t) => t.name === n)
  if (exact) return exact
  const lower = n.toLowerCase()
  const viaAlias = aliases[lower] && list.find((t) => t.name === aliases[lower])
  if (viaAlias) return viaAlias
  const ci = list.find((t) => t.name.toLowerCase() === lower)
  if (ci) return ci
  const flat = lower.replace(/[^a-z0-9]/g, "")
  if (!flat) return null
  const flatHit = list.find((t) => t.name.toLowerCase().replace(/[^a-z0-9]/g, "") === flat)
  if (flatHit) return flatHit
  const aliasKey = Object.keys(aliases).find((k) => k.replace(/[^a-z0-9]/g, "") === flat)
  return (aliasKey && list.find((t) => t.name === aliases[aliasKey])) || null
}

function unknownToolMessage(name, list) {
  const names = list.map((t) => t.name)
  const lower = String(name || "").toLowerCase()
  const ranked = names
    .map((n) => ({ n, d: n.toLowerCase().startsWith(lower) || lower.startsWith(n.toLowerCase()) ? 1 : editDistance(lower, n.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(lower.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => `"${x.n}"`)
  const core = names.filter((n) => !/^mcp__|^browser[._]|^computer_/.test(n))
  const extra = names.length - core.length
  return `Unknown tool "${name}".${ranked.length ? ` Did you mean ${ranked.join(" or ")}?` : ""} Nothing was executed. Tools: ${core.join(", ")}${extra ? ` (+${extra} browser, computer or connector tools)` : ""}.`
}

/**
 * Text-editor style calls ({command: view|create|str_replace|insert, path, ...})
 * mapped onto read / write / edit.
 */
function editorCommand(name, args, list) {
  if (!/^(str_replace_editor|str_replace_based_edit_tool|text_editor)$/i.test(String(name || ""))) return null
  const a = args && typeof args === "object" ? args : {}
  const pick = (n) => list.find((t) => t.name === n)
  const cmd = String(a.command || "").toLowerCase()
  if (cmd === "view") return { tool: pick("read"), args: { path: a.path, ...(Array.isArray(a.view_range) ? { offset: a.view_range[0], limit: a.view_range[1] > 0 ? a.view_range[1] - a.view_range[0] + 1 : undefined } : {}) } }
  if (cmd === "create") return { tool: pick("write"), args: { path: a.path, content: a.file_text != null ? a.file_text : a.content } }
  if (cmd === "str_replace" || !cmd) return { tool: pick("edit"), args: { path: a.path, oldString: a.old_str != null ? a.old_str : a.oldString, newString: a.new_str != null ? a.new_str : a.newString } }
  return { error: `The "${cmd}" editor command is not supported here. Nothing was changed. Use read, write or edit (edit with oldString/newString; to insert, include a nearby line in oldString and repeat it in newString).` }
}

module.exports = { prepareArgs, repairJson, findTool, unknownToolMessage, editorCommand, coerce, ALIASES }
