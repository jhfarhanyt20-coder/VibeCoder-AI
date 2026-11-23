"use strict"
/**
 * VibeCoder account in the desktop app ("Sign in with VibeCoder").
 *
 * Device-code sign-in against the VibeCoder website: the app asks for a code,
 * opens /connect?code=XXXX-XXXX in the browser, and polls until the signed-in
 * user presses Allow. The app token is stored with the other provider keys
 * (encrypted), and the free models are kept as one custom provider profile
 * ("vibecoder", OpenAI Chat format) that is refreshed from the website.
 *
 * Everything external is injected so this file can be tested without Electron.
 */

const DEFAULT_ACCOUNT_URL = "https://vibecoderai.onrender.com"
// AI requests (model list, chat) go to the gateway host. Sign-in and the account
// stay on the website. The website can name another gateway with `gateway_url`.
const DEFAULT_GATEWAY_URL = "https://vibecoder-website-production.up.railway.app"
const PROFILE_ID = "vibecoder"
const PROVIDER_NAME = "VibeCoder AI"
const SYNC_EVERY = 30 * 60 * 1000
const STATUS_TTL = 60 * 1000

/** A safe origin: HTTPS, or HTTP only for localhost. Anything else gives `fallback`. */
function safeOrigin(value, fallback) {
  const raw = String(value || "").trim().replace(/\/+$/, "")
  if (!raw) return fallback
  let url
  try { url = new URL(raw) } catch { return fallback }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return fallback
  return url.origin
}
function accountBaseUrl(env = process.env) { return safeOrigin(env.VIBECODER_ACCOUNT_URL || DEFAULT_ACCOUNT_URL, DEFAULT_ACCOUNT_URL) }
function gatewayBaseUrl(env = process.env) { return safeOrigin(env.VIBECODER_GATEWAY_URL || DEFAULT_GATEWAY_URL, DEFAULT_GATEWAY_URL) }

/** /v1/models rows -> the provider profile's model list (name, limits, images, free). */
function profileFromModels(baseUrl, data) {
  const rows = (Array.isArray(data) ? data : []).filter((m) => m && typeof m.id === "string" && m.id)
  if (!rows.length) return null
  const models = rows.map((m) => ({
    id: m.id,
    name: String(m.name || m.id).slice(0, 120),
    context: Number(m.context_length) || 0,
    output: Number(m.max_output_tokens) || 16384,
    image: !!m.capabilities?.images,
    free: m.free !== false,
    tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 8) : [],
  }))
  const first = models[0]
  return {
    id: PROFILE_ID,
    name: PROVIDER_NAME,
    label: PROVIDER_NAME,
    baseURL: `${baseUrl}/v1`,
    format: "openai-chat",
    model: first.id,
    models,
    contextLimit: first.context || 128000,
    maxOutput: first.output || 16384,
    image: first.image,
    scope: "global",
    managed: "vibecoder-account",
  }
}

function createVibecoderAccount(deps) {
  const fetcher = deps.fetch || globalThis.fetch
  const baseUrl = deps.baseUrl || accountBaseUrl()
  const defaultGateway = deps.gatewayUrl || gatewayBaseUrl()
  let gateway = defaultGateway
  // The app token is sent to the gateway, so the website may only pick a gateway
  // from this allow-list: the built-in gateway, the configured/validated
  // override (VIBECODER_GATEWAY_URL or deps.gatewayUrl) and any origins the host
  // passes explicitly. Any other announced origin is ignored.
  const allowedGateways = new Set(
    [DEFAULT_GATEWAY_URL, defaultGateway, ...(Array.isArray(deps.allowedGateways) ? deps.allowedGateways : [])]
      .map((u) => safeOrigin(u, ""))
      .filter(Boolean),
  )
  const now = deps.now || Date.now
  const wait = deps.setTimeout || setTimeout
  const emit = deps.emit || (() => {})
  const keys = deps.keys // { get(): string, set(token), clear() }
  const profiles = deps.profiles // { upsert(profile), remove(), exists(): boolean }
  let pending = null // { code, url, deviceCode, interval, expiresAt }
  let lastError = ""
  let info = null
  let infoAt = 0
  let pollTimer = null
  let syncTimer = null

  const request = async (pathname, { method = "GET", token, body, base = baseUrl } = {}) => {
    const headers = { Accept: "application/json" }
    if (body !== undefined) headers["Content-Type"] = "application/json"
    if (token) headers.Authorization = `Bearer ${token}`
    const response = await fetcher(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
    let data = null
    try { data = await response.json() } catch {}
    return { status: response.status, ok: response.ok, data: data || {} }
  }
  const token = () => { try { return keys.get() || "" } catch { return "" } }

  function forget(reason) {
    try { keys.clear() } catch {}
    try { profiles.remove() } catch {}
    info = null; infoAt = 0
    if (reason) lastError = reason
    emit("auth.changed", { connected: false, reason: reason || "" })
  }

  /** Fetch the free model list and save it as the "VibeCoder AI" provider. */
  async function syncModels() {
    const t = token()
    if (!t) return { synced: false }
    // The website may name the gateway host; otherwise the built-in default is used.
    try {
      const acct = await request("/v1/account", { token: t })
      if (acct.status === 401) { forget("Your VibeCoder sign-in was disconnected. Sign in again."); return { synced: false, signedOut: true } }
      if (acct.ok) {
        info = acct.data; infoAt = now()
        // A website that names only itself has no separate gateway configured:
        // keep the built-in gateway then.
        const named = safeOrigin(acct.data.gateway_url, "")
        gateway = named && named !== baseUrl && allowedGateways.has(named) ? named : defaultGateway
      }
    } catch {}
    const res = await request("/v1/models", { token: t, base: gateway })
    if (res.status === 401) { forget("Your VibeCoder sign-in was disconnected. Sign in again."); return { synced: false, signedOut: true } }
    if (!res.ok) throw new Error(res.data?.error?.message || `Could not load VibeCoder models (HTTP ${res.status}).`)
    const profile = profileFromModels(gateway, res.data.data)
    if (!profile) throw new Error("VibeCoder returned no models.")
    profiles.upsert(profile)
    emit("auth.models", { count: profile.models.length })
    return { synced: true, count: profile.models.length }
  }

  async function poll() {
    pollTimer = null
    if (!pending) return
    if (now() >= pending.expiresAt) { pending = null; lastError = "The sign-in code expired. Try again."; emit("auth.changed", { connected: false }); return }
    let res
    try { res = await request("/api/device/token", { method: "POST", body: { device_code: pending.deviceCode } }) } catch { schedule(); return }
    if (res.ok && res.data.access_token) {
      pending = null
      lastError = ""
      keys.set(res.data.access_token)
      info = null; infoAt = 0
      try { await syncModels() } catch (e) { lastError = String(e.message || e) }
      emit("auth.changed", { connected: true })
      return
    }
    const error = res.data.error
    if (error === "slow_down") { pending.interval += 5; schedule(); return }
    if (error === "authorization_pending" || res.status >= 500 || res.status === 429) { schedule(); return }
    pending = null
    lastError = error === "access_denied" ? "Sign-in was denied in the browser." : "The sign-in code expired. Try again."
    emit("auth.changed", { connected: false })
  }
  function schedule() {
    if (!pending) return
    pollTimer = wait(() => { poll().catch(() => schedule()) }, pending.interval * 1000)
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref()
  }

  return {
    baseUrl,
    profileId: PROFILE_ID,

    /** Start (or resume) sign-in: returns the code and opens the browser. */
    async connect() {
      if (pending && now() < pending.expiresAt) {
        await deps.openExternal(pending.url)
        return { code: pending.code, url: pending.url, expiresIn: Math.round((pending.expiresAt - now()) / 1000) }
      }
      lastError = ""
      const res = await request("/api/device/code", { method: "POST", body: { device_name: String(deps.deviceName || "VibeCoder app").slice(0, 60) } })
      if (!res.ok || !res.data.device_code || !res.data.user_code) {
        const message = res.status === 503 ? "VibeCoder sign-in is not available right now. Try again later." : res.status === 429 ? "Too many sign-in attempts. Try again in a few minutes." : `Could not start sign-in (HTTP ${res.status}).`
        throw new Error(message)
      }
      const url = String(res.data.verification_uri_complete || `${baseUrl}/connect?code=${res.data.user_code}`)
      if (!url.startsWith(`${baseUrl}/`)) throw new Error("The sign-in page address was not from VibeCoder.")
      pending = { code: res.data.user_code, url, deviceCode: res.data.device_code, interval: Math.max(2, Number(res.data.interval) || 5), expiresAt: now() + (Number(res.data.expires_in) || 600) * 1000 }
      if (pollTimer) clearTimeout(pollTimer)
      schedule()
      await deps.openExternal(url)
      emit("auth.changed", { connected: false, pending: true })
      return { code: pending.code, url, expiresIn: Math.round((pending.expiresAt - now()) / 1000) }
    },

    /** Who is signed in, today's usage, or the pending code. */
    async status({ fresh = false } = {}) {
      const t = token()
      const waiting = pending && now() < pending.expiresAt ? { code: pending.code, url: pending.url, expiresIn: Math.round((pending.expiresAt - now()) / 1000) } : null
      if (!t) return { connected: false, email: null, provider: PROVIDER_NAME, pending: waiting, error: lastError || null }
      if (fresh || !info || now() - infoAt > STATUS_TTL) {
        try {
          const res = await request("/v1/account", { token: t })
          if (res.status === 401) { forget("Your VibeCoder sign-in was disconnected. Sign in again."); return { connected: false, email: null, provider: PROVIDER_NAME, pending: null, error: lastError } }
          if (res.ok) { info = res.data; infoAt = now() }
        } catch {}
        if (!profiles.exists()) syncModels().catch(() => {})
      }
      return { connected: true, email: info?.email || null, name: info?.name || null, picture: info?.picture || null, plan: info?.plan || "free", dailyLimit: info?.dailyLimit ?? null, usage: info?.usage || null, provider: PROVIDER_NAME, profileId: PROFILE_ID, pending: null, error: null }
    },

    /** Sign out: revoke the token on the website (best effort) and forget it here. */
    async disconnect() {
      const t = token()
      pending = null
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (t) { try { await request("/v1/account/logout", { method: "POST", token: t, body: {} }) } catch {} }
      lastError = ""
      forget("")
      return { disconnected: true }
    },

    syncModels,

    /** Keep the model list fresh: at start and every 30 minutes while signed in. */
    startAutoSync() {
      if (token()) syncModels().catch(() => {})
      syncTimer = setInterval(() => { if (token()) syncModels().catch(() => {}) }, SYNC_EVERY)
      if (typeof syncTimer.unref === "function") syncTimer.unref()
      return () => clearInterval(syncTimer)
    },
  }
}

module.exports = { createVibecoderAccount, profileFromModels, accountBaseUrl, gatewayBaseUrl, safeOrigin, PROFILE_ID, PROVIDER_NAME, DEFAULT_ACCOUNT_URL, DEFAULT_GATEWAY_URL }
