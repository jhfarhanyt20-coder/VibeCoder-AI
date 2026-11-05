"use strict"
/**
 * Actions — one small contract shared by every tool result.
 *
 * Tools may return a plain string (today's shape) or an object:
 *
 *   { output, isError, stats, artifacts }
 *
 * `normalizeResult()` turns either shape into the same record, clips huge
 * output, and keeps artifacts as a small list of `{ path, kind, bytes }`.
 * Duration is measured by the loop and attached to the `tool.end` event.
 *
 * This lives beside the loop instead of wrapping each tool, so existing tool
 * implementations stay untouched.
 */

const MAX_OUTPUT = 60000

function clipOutput(text, max = MAX_OUTPUT) {
  const value = String(text == null ? "" : text)
  const limit = Math.max(1000, Number(max) || MAX_OUTPUT)
  if (value.length <= limit) return value
  const half = Math.floor(limit / 2)
  return value.slice(0, half) + `\n\n... [${value.length - limit} chars truncated] ...\n\n` + value.slice(-half)
}

function normalizeArtifacts(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list
    .map((item) => {
      if (!item) return null
      if (typeof item === "string") return { path: item }
      const path = item.path || item.file || item.name
      if (!path) return null
      return { path: String(path), ...(item.kind ? { kind: String(item.kind) } : {}), ...(Number.isFinite(item.bytes) ? { bytes: item.bytes } : {}) }
    })
    .filter(Boolean)
}

/** Normalize any tool return value into the uniform action result. */
function normalizeResult(value, { isError = false, max = MAX_OUTPUT } = {}) {
  if (value == null) return { output: "", isError: !!isError }
  if (typeof value === "string") return { output: clipOutput(value, max), isError: !!isError }
  if (typeof value !== "object") return { output: clipOutput(String(value), max), isError: !!isError }
  const out = {
    output: clipOutput(value.output != null ? value.output : value.text != null ? value.text : "", max),
    isError: !!(value.isError || isError),
  }
  if (value.stats && typeof value.stats === "object") out.stats = value.stats
  const artifacts = normalizeArtifacts(value.artifacts)
  if (artifacts.length) out.artifacts = artifacts
  if (Number.isFinite(value.durationMs)) out.durationMs = value.durationMs
  return out
}

/** A monotonic start mark + elapsed milliseconds (safe on every platform). */
function mark() {
  const t = process.hrtime.bigint()
  return () => Number(process.hrtime.bigint() - t) / 1e6
}

module.exports = { MAX_OUTPUT, clipOutput, normalizeResult, normalizeArtifacts, mark }
