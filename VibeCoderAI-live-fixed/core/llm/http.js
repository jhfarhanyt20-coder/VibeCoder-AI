"use strict"
const { sleep } = require("../util")

// Read the shipped version once so provider requests identify the exact build
// without a manually maintained string in the hot path.
const VIBE_VERSION = (() => {
  try { return require("../../package.json").version || "0.0.0" } catch { return "0.0.0" }
})()

// Product identity carried by every provider request (chat, responses, anthropic
// and the model list), so providers and gateways can recognise BDCoder AI.
// A profile's own headers may still override these values.
const PRODUCT_HEADERS = {
  "user-agent": `VibeCoderAI/${VIBE_VERSION}`,
  "x-vibecoder-client": `VibeCoderAI/${VIBE_VERSION}`,
}

/**
 * The auth and identification headers each kind of provider expects.
 *   - Standard OpenAI-compatible APIs: Authorization: Bearer <key>.
 *   - Azure OpenAI / Azure AI: the key goes in `api-key` (a Bearer value there is
 *     treated as an Entra token and rejected).
 *   - OpenRouter: HTTP-Referer + X-Title name the app (its documented attribution headers).
 * Profile headers are applied by the caller afterwards, so a user can still override anything.
 */
function authHeaders(baseURL, apiKey) {
  let host = ""
  try { host = new URL(String(baseURL || "")).hostname.toLowerCase() } catch {}
  const h = {}
  const azure = /\.openai\.azure\.com$|\.cognitiveservices\.azure\.com$|\.services\.ai\.azure\.com$/.test(host)
  if (apiKey) {
    if (azure) h["api-key"] = apiKey
    else h.authorization = `Bearer ${apiKey}`
  }
  if (host === "openrouter.ai") {
    h["http-referer"] = "https://bdcoderai.onrender.com"
    h["x-title"] = "BDCoder AI"
  }
  return h
}

// Some gateways (AgentRouter, new-api routers) reject an unknown client before
// looking at the request. Only after a 401/403 "unauthorized client" do the
// OpenAI-format adapters retry once with a client string those gateways
// whitelist. The product header stays, so the provider still sees which app
// made the request. Anthropic keeps its own claude-cli fallback.
const COMPAT_CLIENT_HEADERS = { "user-agent": "codex_cli_rs/0.50.0" }

// Remember which providers already refused the app identity, so later requests
// skip the doomed first attempt. The product header is always kept.
const compatClients = new Set()
const prefersCompatClient = (id) => !!id && compatClients.has(id)
const rememberCompatClient = (id) => { if (id) compatClients.add(id) }

/**
 * The free quota resets at 00:00 UTC (6:00 AM in Bangladesh, for example).
 * "Resets at 00:00 UTC" alone reads like "never" to most people, so give the
 * local clock time and how long is left.
 */
function nextUtcMidnight(now = Date.now()) {
  const d = new Date(now)
  d.setUTCHours(24, 0, 0, 0)
  return d.getTime()
}
function freeLimitMessage(text, now = Date.now()) {
  const limit = /\((\d+) requests\)/.exec(String(text))?.[1]
  const at = nextUtcMidnight(now)
  const left = Math.max(0, at - now)
  const hours = Math.floor(left / 3600000), minutes = Math.ceil((left % 3600000) / 60000)
  const inText = hours ? `${hours}h ${minutes === 60 ? 0 : minutes}m` : `${minutes}m`
  let clock = ""
  try { clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) } catch {}
  return `Today's free BDCoder requests are used up${limit ? ` (${limit} per day)` : ""}. They come back at ${clock ? clock + " your time" : "midnight UTC"} (00:00 UTC), in ${inText}. Until then, pick another model, or use the Fallback model so another provider answers.`
}

class ApiError extends Error {
  constructor(status, body) {
    const text = String(body)
    const restricted = [401, 403].includes(status) && /unauthori[sz]ed[_\s-]*client|client[^\n]{0,40}(?:not allowed|not authori[sz]ed|detected)/i.test(text)
    const blocked = status === 400 && /content[_\s-]*blocked|content[_\s-]*policy|blocked by (?:the )?provider/i.test(text)
    // AgentRouter's own server filter refuses messages written only in some
    // languages (tested: Bangla, Banglish and Hindi are blocked; English, French,
    // Chinese and mixed Bangla+English pass). Say so plainly.
    const agentRouter = /agent_router_api_error|agentrouter/i.test(text)
    // BDCoder's free models: say when the daily quota comes back, in local time.
    const freeLimit = status === 429 && /"code"\s*:\s*"daily_limit"|Daily free limit reached/i.test(text)
    super(freeLimit
      ? freeLimitMessage(text)
      : blocked
      ? agentRouter
        ? `AgentRouter's filter blocked this message (HTTP 400). AgentRouter refuses chats that start in some languages, such as Bangla, Banglish or Hindi, even harmless ones. Start the chat in English (once the model itself has replied in Bangla, Bangla and Banglish messages usually pass), mix in English, pick another model, or use the Fallback model so the next provider answers automatically. Provider said: ${text.slice(0, 200)}`
        : `The provider's content filter blocked this message (HTTP 400). Try another provider, add one to the Fallback model chain, or rephrase the message. Provider said: ${text.slice(0, 300)}`
      : restricted
        ? `This provider rejected BDCoder AI as an unauthorized client (HTTP ${status}). The credential is restricted to another approved application; ask the provider to authorize BDCoder AI or use an unrestricted API credential. Provider said: ${text.slice(0, 300)}`
        : `HTTP ${status}: ${text.slice(0, 500)}`)
    this.name = "ApiError"
    this.status = status
    this.body = text
    if (freeLimit) this.code = "FREE_DAILY_LIMIT"
    if (restricted) this.code = "PROVIDER_CLIENT_RESTRICTED"
    if (blocked) this.code = "PROVIDER_CONTENT_BLOCKED"
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
/**
 * Credentials (authorization / x-api-key / api-key) must never follow a
 * redirect to another host. Redirects are handled MANUALLY: a 307/308 to the
 * SAME origin is followed (method and body preserved, at most 3 hops); any
 * other redirect fails with a clear error and the key is not re-sent.
 */
const MAX_REDIRECTS = 3
function redirectTarget(res, from) {
  if (![301, 302, 303, 307, 308].includes(res.status)) return null
  const loc = res.headers && res.headers.get("location")
  let next
  try {
    next = new URL(loc || "", from)
  } catch {
    next = null
  }
  const src = new URL(from)
  if (!loc || !next || next.origin !== src.origin || ![307, 308].includes(res.status)) {
    const where = next ? next.origin : "an unknown location"
    throw new ApiError(
      res.status,
      `The provider redirected the request (${res.status}) to ${where}. BDCoder does not send API keys across redirects - set the provider base URL to the final API address.`,
    )
  }
  return next.toString()
}

async function postStream(url, { headers = {}, body, signal, retries = 2, connectMs = CONNECT_TIMEOUT_MS } = {}) {
  let attempt = 0
  let target = String(url)
  let hops = 0
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
      const res = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", ...PRODUCT_HEADERS, ...headers },
        body: JSON.stringify(body),
        signal: ctl.signal,
        redirect: "manual",
      })
      clearTimeout(timer) // headers arrived: the idle watchdog takes over from here
      if (res.status >= 300 && res.status < 400) {
        if (signal) signal.removeEventListener("abort", onAbort)
        try {
          await res.body?.cancel?.()
        } catch {}
        const next = redirectTarget(res, target)
        if (!next) throw new ApiError(res.status, `The provider answered with an unexpected ${res.status} status.`)
        if (hops >= MAX_REDIRECTS) throw new ApiError(res.status, `Too many redirects from the provider (${res.status}).`)
        hops++
        target = next
        continue
      }
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

module.exports = { ApiError, NonApiResponseError, postStream, redirectTarget, postStreamAdaptive, parseRawBody, streamError, PRODUCT_HEADERS, authHeaders, COMPAT_CLIENT_HEADERS, prefersCompatClient, rememberCompatClient, VIBE_VERSION }
