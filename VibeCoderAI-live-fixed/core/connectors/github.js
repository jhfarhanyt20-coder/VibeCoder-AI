"use strict"
/**
 * GitHub connector: "Sign in" with the GitHub device flow (no client secret is
 * needed or stored), then tools the agent can use with the user's account.
 *
 * Sign-in: the app shows a short code and opens github.com/login/device; the
 * user enters it and presses Authorize; we poll until GitHub returns a token.
 * The token is saved encrypted (core/connectors/store).
 *
 * Shared by the desktop app and the CLI (same engine, same tools).
 */
const crypto = require("node:crypto")
const store = require("./store")

// The VibeCoder website does one-click sign-in (it holds the GitHub client secret).
const ACCOUNT_URL = (() => {
  const raw = String(process.env.VIBECODER_ACCOUNT_URL || "https://vibecoderai.onrender.com").replace(/\/+$/, "")
  try { const u = new URL(raw); return u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname) ? u.origin : "https://vibecoderai.onrender.com" } catch { return "https://vibecoderai.onrender.com" }
})()
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

// Public OAuth App id of "VibeCoder AI" (not a secret; can be overridden).
const CLIENT_ID = process.env.VIBECODER_GITHUB_CLIENT_ID || "Ov23lirzzUNFz9HSGE3z"
const SCOPES = "repo read:org read:user user:email workflow gist"
const API = "https://api.github.com"
const ID = "github"

function createGitHub({ home, fetch: fetcher = globalThis.fetch, now = Date.now, setTimer = setTimeout, onChange = () => {}, accountUrl = ACCOUNT_URL } = {}) {
  let pending = null // { userCode, verificationUri, deviceCode, interval, expiresAt }
  let lastError = ""
  let timer = null

  const status = () => {
    const saved = store.get(ID, home)
    return {
      id: ID,
      name: "GitHub",
      connected: !!(saved && saved.connected),
      account: saved && saved.connected ? { login: saved.login, name: saved.name || "", avatar: saved.avatar || "", scopes: saved.scopes || "" } : null,
      pending: pending ? { mode: pending.mode, userCode: pending.userCode || null, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt } : null,
      error: lastError,
    }
  }

  async function post(url, body) {
    const res = await fetcher(url, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "VibeCoder-AI" }, body: JSON.stringify(body) })
    let data = {}
    try { data = await res.json() } catch {}
    return { ok: res.ok, status: res.status, data }
  }

  /** One-click when the website offers it (browser → Authorize → done); else the code flow. */
  async function connect({ mode } = {}) {
    if (pending && pending.expiresAt > now()) return status()
    lastError = ""
    if (mode !== "device") {
      let web = false
      try {
        const r = await fetcher(`${accountUrl}/api/connectors`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) })
        web = !!(r.ok && (await r.json())?.github?.web)
      } catch {}
      if (web) {
        const secret = b64url(crypto.randomBytes(32))
        const claim = b64url(crypto.createHash("sha256").update(secret).digest())
        pending = { mode: "web", secret, verificationUri: `${accountUrl}/connect/github/start?claim=${claim}`, interval: 2, expiresAt: now() + 10 * 60 * 1000 }
        schedule()
        onChange(status())
        return status()
      }
    }
    const r = await post("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: SCOPES })
    if (!r.ok || !r.data.device_code) {
      lastError = r.data.error_description || r.data.error || `GitHub did not start sign-in (HTTP ${r.status}).`
      if (/device flow/i.test(lastError) || r.data.error === "device_flow_disabled") lastError = "Device Flow is turned off for the VibeCoder GitHub app. Turn on \"Enable Device Flow\" in its GitHub settings."
      onChange(status())
      throw new Error(lastError)
    }
    pending = {
      mode: "device",
      userCode: r.data.user_code,
      verificationUri: r.data.verification_uri || "https://github.com/login/device",
      deviceCode: r.data.device_code,
      interval: Math.max(5, Number(r.data.interval) || 5),
      expiresAt: now() + (Number(r.data.expires_in) || 900) * 1000,
    }
    schedule()
    onChange(status())
    return status()
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    if (!pending) return
    timer = setTimer(() => { poll().catch(() => {}) }, pending.interval * 1000)
    if (timer && typeof timer.unref === "function") timer.unref()
  }

  /** One poll. Returns the new status. */
  async function poll() {
    if (!pending) return status()
    if (pending.expiresAt <= now()) {
      pending = null
      lastError = "The sign-in code expired. Press Sign in again."
      onChange(status())
      return status()
    }
    if (pending.mode === "web") {
      let data = {}
      try {
        const res = await fetcher(`${accountUrl}/connect/github/claim`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ secret: pending.secret }), signal: AbortSignal.timeout(10000) })
        data = await res.json()
      } catch {}
      if (!data || !data.token) { schedule(); return status() }
      return finishWith(data.token, data.scope)
    }
    const r = await post("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: pending.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    const err = r.data.error
    if (err === "authorization_pending") { schedule(); return status() }
    if (err === "slow_down") { pending.interval += 5; schedule(); return status() }
    if (err || !r.data.access_token) {
      pending = null
      lastError = err === "access_denied" ? "Sign-in was cancelled on GitHub." : err === "expired_token" ? "The sign-in code expired. Press Sign in again." : (r.data.error_description || "GitHub sign-in failed.")
      onChange(status())
      return status()
    }
    return finishWith(r.data.access_token, r.data.scope)
  }

  async function finishWith(token, scope) {
    let user = {}
    try { user = await api(token, "GET", "/user") } catch {}
    store.save(ID, { login: user.login || "", name: user.name || "", avatar: user.avatar_url || "", scopes: scope || SCOPES, connectedAt: new Date(now()).toISOString() }, token, home)
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
    lastError = ""
    onChange(status())
    return status()
  }

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
    onChange(status())
    return status()
  }

  function disconnect() {
    cancel()
    store.remove(ID, home)
    lastError = ""
    onChange(status())
    return status()
  }

  async function api(tokenOverride, method, pathOrUrl, body, { raw = false } = {}) {
    const token = tokenOverride || store.token(ID, home)
    if (!token) throw new Error("GitHub is not connected. Ask the user to connect it in Connectors (or `vibe connectors github connect`).")
    const url = /^https:\/\/api\.github\.com\//.test(pathOrUrl) ? pathOrUrl : `${API}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`
    const res = await fetcher(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "VibeCoder-AI",
        ...(body != null ? { "Content-Type": "application/json" } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let data = text
    try { data = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) {
      const msg = (data && data.message) || String(text).slice(0, 300) || `HTTP ${res.status}`
      const hint = res.status === 401 ? " The GitHub sign-in is no longer valid: ask the user to sign in again in Connectors."
        : res.status === 403 && /rate limit/i.test(msg) ? " GitHub rate limit reached: wait a few minutes."
        : res.status === 403 ? " The account has no permission for this."
        : res.status === 404 ? " Not found, or the account has no access to it: check owner/repo/path."
        : res.status === 422 ? " GitHub rejected the input: check the fields."
        : ""
      const e = new Error(`GitHub ${method} ${url.replace(API, "")} failed (${res.status}): ${msg}.${hint} Nothing was changed.`)
      e.status = res.status
      throw e
    }
    return data
  }

  return { id: ID, status, connect, poll, cancel, disconnect, api: (method, p, body, opts) => api(null, method, p, body, opts), connected: () => !!store.token(ID, home) }
}

module.exports = { createGitHub, CLIENT_ID, SCOPES }
