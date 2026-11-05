"use strict"
/** OAuth 2.0 Authorization Code + PKCE helpers for remote Connectors. */
const crypto = require("node:crypto")

const base64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

function endpoint(value, label) {
  let url
  try { url = new URL(String(value || "")) } catch { throw new Error(`${label} must be a valid URL.`) }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${label} must use HTTPS (HTTP is allowed only for localhost).`)
  return url
}

function beginOAuth({ authorizationUrl, clientId, redirectUri, scopes = [], state, extra = {} } = {}) {
  const url = endpoint(authorizationUrl, "Authorization URL")
  if (!clientId) throw new Error("OAuth clientId is required.")
  if (!redirectUri) throw new Error("OAuth redirectUri is required.")
  const verifier = base64url(crypto.randomBytes(48))
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest())
  const safeState = state || base64url(crypto.randomBytes(24))
  const scope = Array.isArray(scopes) ? scopes.map(String).filter(Boolean).join(" ") : String(scopes || "")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", String(clientId))
  url.searchParams.set("redirect_uri", String(redirectUri))
  url.searchParams.set("state", safeState)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  if (scope) url.searchParams.set("scope", scope)
  for (const [key, value] of Object.entries(extra || {})) if (/^[a-zA-Z0-9._-]+$/.test(key) && value != null) url.searchParams.set(key, String(value))
  return { url: url.toString(), state: safeState, verifier, createdAt: Date.now() }
}

async function exchangeCode({ tokenUrl, clientId, clientSecret, code, redirectUri, verifier, fetchImpl = globalThis.fetch } = {}) {
  const url = endpoint(tokenUrl, "Token URL")
  if (typeof fetchImpl !== "function") throw new Error("This runtime does not provide fetch().")
  if (!clientId || !code || !redirectUri || !verifier) throw new Error("OAuth token exchange is missing clientId, code, redirectUri, or PKCE verifier.")
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: String(clientId),
    code: String(code),
    redirect_uri: String(redirectUri),
    code_verifier: String(verifier),
  })
  if (clientSecret) body.set("client_secret", String(clientSecret))
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`OAuth token endpoint returned HTTP ${response.status}: ${data.error_description || data.error || "request failed"}`)
  if (!data.access_token) throw new Error("OAuth token endpoint returned no access token.")
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : "",
    tokenType: String(data.token_type || "Bearer"),
    expiresIn: Number(data.expires_in) || 0,
    scope: String(data.scope || ""),
  }
}

module.exports = { beginOAuth, exchangeCode, base64url }
