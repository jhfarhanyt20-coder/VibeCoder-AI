"use strict"
/**
 * Prompt caching for every provider, decided by the API format, never by the
 * provider's name: a provider added or removed later behaves the same.
 *
 * - The agent keeps the request prefix stable (system prompt, tool list and
 *   history are sent byte-for-byte the same from step to step), which is what
 *   providers with automatic prefix caching need (all three formats).
 * - Anthropic Messages and OpenAI Chat Completions requests also carry explicit
 *   `cache_control` marks, which the providers that cache only on request use
 *   and the others ignore.
 * - An endpoint that answers 400 to the marks gets the same request once more
 *   without them; when that retry works the endpoint is remembered for this
 *   app session, so it never pays for a failed request again.
 *
 * profile.quirks.promptCache === false turns the marks off for a profile.
 */
const rejected = new Set()

const endpointKey = (profile) => `${String((profile && profile.format) || "")}|${String((profile && profile.baseURL) || "").replace(/\/+$/, "").toLowerCase()}|${String((profile && profile.model) || "")}`

/** Send explicit cache marks to this profile? */
function useMarks(profile) {
  const q = (profile && profile.quirks) || {}
  if (q.promptCache === false) return false
  return !rejected.has(endpointKey(profile))
}

/** The endpoint refused the marks and accepted the same request without them. */
function rememberRejected(profile) {
  rejected.add(endpointKey(profile))
}

/**
 * A 400 that is clearly about something else (the context is too long, a
 * rate limit or quota, a bad key, an unknown model) must reach its own
 * handling (compaction, fallback, the user) and never be "fixed" by dropping
 * the marks. Any other 400 may be the marks.
 */
const OTHER_400 = /context (length|window)|maximum context|context_length|too (long|large|many tokens)|prompt is too long|exceeds? (the )?(maximum|max|limit)|reduce the length|max_tokens|rate.?limit|too many requests|quota|insufficient|billing|credit|api.?key|unauthori[sz]ed|forbidden|model.{0,40}(not found|does not exist|not available|not supported)|no such model|unknown model/i
function mayBeAboutMarks(errorBody) {
  return !OTHER_400.test(String(errorBody || ""))
}

/** For tests. */
function _reset() { rejected.clear() }

module.exports = { useMarks, rememberRejected, mayBeAboutMarks, endpointKey, _reset }
