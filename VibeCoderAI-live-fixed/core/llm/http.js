"use strict"
const { sleep } = require("../util")

// Read the shipped version once so provider requests identify the exact build
// without a manually maintained string in the hot path.
const VIBE_VERSION = (() => {
  try { return require("../../package.json").version || "0.0.0" } catch { return "0.0.0" }
})()

class ApiError extends Error {
  constructor(status, body) {
    const text = String(body)
    const restricted = [401, 403].includes(status) && /unauthori[sz]ed[_\s-]*client|client[^\n]{0,40}(?:not allowed|not authori[sz]ed|detected)/i.test(text)
    super(restricted
      ? `This provider rejected VibeCoder AI as an unauthorized client (HTTP ${status}). The credential is restricted to another approved application; ask the provider to authorize VibeCoder AI or use an unrestricted API credential. Provider said: ${text.slice(0, 300)}`
      : `HTTP ${status}: ${text.slice(0, 500)}`)
    this.name = "ApiError"
    this.status = status
    this.body = text
    if (restricted) this.code = "PROVIDER_CLIENT_RESTRICTED"
  }
  /** True when the provider says the prompt is larger than the context window. */
  get overflow() {
    return (
      [400, 413, 422].includes(this.status) &&
      /context|too long|too many tokens|too large|request too large|maximum.*(length|tokens)|exceed|reduce (the|your) (length|message|prompt|input)|tokens per minute|\bTPM\b|\bITPM\b/i.test(this.body)
    )
  }
  /** A provider's input-token throughput cap is often lower than the model's
   *  context window. Return a conservative prompt budget so the retry compacts
   *  enough history to fit under TPM/ITPM instead of retrying the same payload. */
  get inputTokenBudget() {
    if (![400, 413, 422].includes(this.status) || !/(input tokens per minute|tokens per minute|\bTPM\b|\bITPM\b)/i.test(this.body)) return 0
    const match = this.body.match(/\bLimit\s*[:=]?\s*(\d+)\s*[,;:]?\s*Requested\s*[:=]?\s*(\d+)/i)
    if (!match) return 0
    const limit = Number(match[1])
    const requested = Number(match[2])
    if (!Number.isFinite(limit) || !Number.isFinite(requested) || limit <= 0 || requested <= limit) return 0
    return Math.max(1024, Math.floor(limit * 0.75))
  }
}

class NonApiResponseError extends Error {
  constructor(body) {
    const text = String(body || "")
    const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)
    super(`The provider returned a website instead of its model API. Use the API base URL (usually ending in /v1), not a dashboard URL. Response: ${plain || "(empty)"}`)
    this.name = "NonApiResponseError"
    this.code = "PROVIDER_NON_API_RESPONSE"
    this.body = text
  }
}

/**
 * A provider that accepts the connection but never answers used to freeze the run
 * for the full 15-minute watchdog window ("the agent died"). Fail fast instead -
 * the client's inline auto-retry picks the run back up within seconds.
 * IMPORTANT: this timeout covers ONLY the wait for response headers. Once the
 * stream is open, stalls are guarded by the SSE idle watchdog (sse.js) instead:
 * a fixed timer kept attached to the fetch signal used to kill HEALTHY streams
 * mid-generation the moment the total request time crossed the limit.
 */
const CONNECT_TIMEOUT_MS = 120000

/** POST JSON, return the streaming Response. Retries 429/5xx/network errors before the first byte. */
async function postStream(url, { headers = {}, body, signal, retries = 2, connectMs = CONNECT_TIMEOUT_MS } = {}) {
  let attempt = 0
  for (;;) {
    const ctl = new AbortController()
    let stalled = false
    // keep the caller's abort wired for the WHOLE life of the stream (interrupting
    // a run must still cancel the body), but only the timer decides "stalled".
    const onAbort = () => ctl.abort(signal.reason)
    if (signal) signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      stalled = true
      ctl.abort(new Error("connect-timeout"))
    }, connectMs)
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", "user-agent": `VibeCoderAI/${VIBE_VERSION}`, ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
      })
      clearTimeout(timer) // headers arrived: the idle watchdog takes over from here
      if (!res.ok) {
        if (signal) signal.removeEventListener("abort", onAbort)
        const text = await res.text().catch(() => "")
        const err = new ApiError(res.status, text)
        if ((res.status === 429 || res.status >= 500) && attempt < retries && !(signal && signal.aborted)) {
          const ra = Number(res.headers.get("retry-after"))
          attempt++
          // short silent waits only: the UI retries visibly after this helper gives up
          await sleep(ra > 0 ? Math.min(ra, 8) * 1000 : Math.min(4000, 500 * 2 ** attempt), signal)
          continue
        }
        throw err
      }
      return res
    } catch (e) {
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      if (signal && signal.aborted) throw e // the user stopped the run
      if (e instanceof ApiError) throw e
      if (stalled) {
        throw new Error(`The provider did not respond within ${Math.round(connectMs / 1000)}s (connection stalled) - retrying.`)
      }
      if (attempt < retries) {
        attempt++
        await sleep(Math.min(4000, 500 * 2 ** attempt), signal)
        continue
      }
      throw e
    }
  }
}

/**
 * Mid-stream provider errors arrive inside the SSE body with no HTTP status.
 * Wrap them as an ApiError(400, text) so the loop's e.overflow detection
 * (auto-compaction retry) works on streamed "context too long" errors too.
 */
function streamError(text) {
  return new ApiError(400, String(text || ""))
}

/**
 * Some providers reject an optional parameter instead of ignoring it
 * (stream_options on old gateways, max_tokens on OpenAI's newer models, ...).
 * adapt(err, body) edits `body` in place and returns true when a retry makes
 * sense. At most 3 adjustments, 400/422 only.
 */
async function postStreamAdaptive(url, opts, adapt) {
  for (let i = 0; ; i++) {
    try {
      return await postStream(url, opts)
    } catch (e) {
      if (i < 3 && adapt && e instanceof ApiError && (e.status === 400 || e.status === 422) && adapt(e, opts.body)) continue
      throw e
    }
  }
}

/**
 * The provider answered 200 but not with an event stream (the adapter got the
 * whole body as one {event:"raw"}). Return the parsed JSON, or throw an error
 * that SAYS what came back - never end the run silently with no reply.
 */
function parseRawBody(text) {
  const t = String(text || "").trim()
  let j
  try {
    j = JSON.parse(t)
  } catch {
    throw new NonApiResponseError(t)
  }
  const err = j && (j.error || (j.type === "error" && j))
  if (err) throw streamError(typeof err === "string" ? err : err.message || (err.error && err.error.message) || JSON.stringify(err))
  return j
}

module.exports = { ApiError, NonApiResponseError, postStream, postStreamAdaptive, parseRawBody, streamError }
