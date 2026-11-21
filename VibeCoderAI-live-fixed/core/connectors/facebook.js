"use strict"
/**
 * Facebook connector: one-click "Sign in with Facebook" through the VibeCoder
 * website (it holds the app secret), then Graph API access for the agent with
 * the user's OWN account: Pages, posts, comments, Messenger, insights,
 * Business and ads. The long-lived user token (about 60 days) is saved
 * encrypted on this computer (core/connectors/store).
 *
 * Shared by the desktop app and the CLI.
 */
const crypto = require("node:crypto")
const store = require("./store")

const ID = "facebook"
// "Coming soon": sign-in stays off for users until Meta approves the app
// (App Review + Business Verification). VIBECODER_FACEBOOK=1 turns it on for testing.
const AVAILABLE = process.env.VIBECODER_FACEBOOK === "1"
const COMING_SOON = "Facebook is coming soon to VibeCoder. It will open for everyone after Meta approves the app."
const GRAPH = "https://graph.facebook.com/v21.0"
const ACCOUNT_URL = (() => {
  const raw = String(process.env.VIBECODER_ACCOUNT_URL || "https://vibecoderai.onrender.com").replace(/\/+$/, "")
  try { const u = new URL(raw); return u.protocol === "https:" || ["localhost", "127.0.0.1"].includes(u.hostname) ? u.origin : "https://vibecoderai.onrender.com" } catch { return "https://vibecoderai.onrender.com" }
})()
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")

function createFacebook({ home, fetch: fetcher = globalThis.fetch, now = Date.now, setTimer = setTimeout, onChange = () => {}, accountUrl = ACCOUNT_URL, available = AVAILABLE } = {}) {
  let pending = null // { secret, verificationUri, interval, expiresAt }
  let lastError = ""
  let timer = null
  const pageTokens = new Map() // pageId -> page access token (memory only)

  const status = () => {
    const saved = store.get(ID, home)
    const expired = saved && saved.expiresAt && Date.parse(saved.expiresAt) <= now()
    return {
      id: ID,
      name: "Facebook",
      comingSoon: !available,
      connected: !!(saved && saved.connected) && !expired,
      account: saved && saved.connected ? { login: saved.name || saved.userId || "", name: saved.name || "", userId: saved.userId || "", expiresAt: saved.expiresAt || "" } : null,
      pending: pending ? { mode: "web", userCode: null, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt } : null,
      error: expired ? "The Facebook sign-in expired. Press Sign in with Facebook again." : lastError,
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer)
    if (!pending) return
    timer = setTimer(() => { poll().catch(() => {}) }, pending.interval * 1000)
    if (timer && typeof timer.unref === "function") timer.unref()
  }

  async function connect() {
    if (!available) throw new Error(COMING_SOON)
    if (pending && pending.expiresAt > now()) return status()
    lastError = ""
    let web = false
    try {
      const r = await fetcher(`${accountUrl}/api/connectors`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) })
      web = !!(r.ok && (await r.json())?.facebook?.web)
    } catch {}
    if (!web) {
      lastError = "Facebook sign-in is not available right now (the VibeCoder website has not finished its Facebook setup). Try again later."
      onChange(status())
      throw new Error(lastError)
    }
    const secret = b64url(crypto.randomBytes(32))
    const claim = b64url(crypto.createHash("sha256").update(secret).digest())
    pending = { secret, verificationUri: `${accountUrl}/connect/facebook/start?claim=${claim}`, interval: 2, expiresAt: now() + 10 * 60 * 1000 }
    schedule()
    onChange(status())
    return status()
  }

  async function poll() {
    if (!pending) return status()
    if (pending.expiresAt <= now()) {
      pending = null
      lastError = "The sign-in took too long. Press Sign in with Facebook again."
      onChange(status())
      return status()
    }
    let data = {}
    try {
      const res = await fetcher(`${accountUrl}/connect/facebook/claim`, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ secret: pending.secret }), signal: AbortSignal.timeout(10000) })
      data = await res.json()
    } catch {}
    if (!data || !data.token) { schedule(); return status() }
    const token = String(data.token)
    let me = {}
    try { me = await graph(token, "GET", "/me", { fields: "id,name" }) } catch {}
    const expiresAt = data.expiresIn ? new Date(now() + Number(data.expiresIn) * 1000).toISOString() : ""
    store.save(ID, { userId: me.id || "", name: me.name || "", expiresAt, connectedAt: new Date(now()).toISOString() }, token, home)
    if (timer) clearTimeout(timer)
    timer = null
    pending = null
    lastError = ""
    pageTokens.clear()
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
    pageTokens.clear()
    lastError = ""
    onChange(status())
    return status()
  }

  /** Graph API call. `params` go in the query for GET/DELETE and the form body otherwise. */
  async function graph(tokenOverride, method, path, params = {}) {
    const token = tokenOverride || store.token(ID, home)
    if (!token) throw new Error("Facebook is not connected. Ask the user to sign in under Connectors → Facebook (CLI: vibe connectors facebook connect). Nothing was done.")
    const clean = String(path || "").replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, "")
    const url = new URL(`${GRAPH}${clean.startsWith("/") ? "" : "/"}${clean}`)
    const body = new URLSearchParams()
    const target = method === "GET" || method === "DELETE" ? url.searchParams : body
    for (const [k, v] of Object.entries(params || {})) if (v != null) target.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
    url.searchParams.set("access_token", token)
    const res = await fetcher(url.href, { method, ...(method === "GET" || method === "DELETE" ? {} : { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }) })
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || (data && data.error)) {
      const e = (data && data.error) || {}
      const msg = e.error_user_msg || e.message || `HTTP ${res.status}`
      const hint = e.code === 190 ? " The Facebook sign-in is no longer valid: ask the user to sign in again in Connectors."
        : e.code === 10 || e.code === 200 || /permission/i.test(msg) ? " This needs a permission the account did not grant (or the app is not approved for it yet). Ask the user to sign in again and allow it."
        : e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613 ? " Facebook rate limit reached: wait a few minutes."
        : e.code === 100 ? " Facebook rejected an input: check ids and fields."
        : ""
      const err = new Error(`Facebook ${method} ${clean.split("?")[0]} failed: ${msg}.${hint} Nothing was changed.`)
      err.code = e.code
      throw err
    }
    return data
  }

  /** A Page's own access token (needed to post or message as the Page). */
  async function pageToken(pageId) {
    const id = String(pageId)
    if (pageTokens.has(id)) return pageTokens.get(id)
    const data = await graph(null, "GET", `/${encodeURIComponent(id)}`, { fields: "access_token,name" })
    if (!data || !data.access_token) throw new Error(`No access to Page ${id}. Use facebook_pages to see the Pages this account manages. Nothing was done.`)
    pageTokens.set(id, data.access_token)
    return data.access_token
  }

  const connected = () => {
    const st = status()
    return st.connected && !!store.token(ID, home)
  }

  /* ---------- video upload (Page videos and Reels) ----------
     Both need the Page permissions the connector already asks for
     (pages_manage_posts, pages_read_engagement, pages_show_list). */
  const VIDEO_MAX = 512 * 1024 * 1024
  function readVideo(file) {
    const fs = require("fs")
    const stat = fs.statSync(String(file))
    if (!stat.isFile()) throw new Error(`Not a file: ${file}. Nothing was uploaded.`)
    if (stat.size > VIDEO_MAX) throw new Error(`The video is ${Math.round(stat.size / 1048576)} MB; at most 512 MB can be uploaded here. Make it smaller (lower resolution or bitrate) first. Nothing was uploaded.`)
    if (stat.size < 1024) throw new Error("The video file is almost empty. Nothing was uploaded.")
    return fs.readFileSync(String(file))
  }
  async function json(res, what) {
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok || (data && data.error) || !data) {
      const e = (data && data.error) || {}
      throw new Error(`Facebook ${what} failed: ${e.error_user_msg || e.message || `HTTP ${res.status}`}. Nothing was published.`)
    }
    return data
  }

  /** A normal Page video (any shape), sent as one multipart upload. */
  async function uploadVideo(pageId, file, { title, description, published } = {}) {
    const bytes = readVideo(file)
    const token = await pageToken(pageId)
    const form = new FormData()
    form.set("access_token", token)
    form.set("published", published ? "true" : "false")
    if (title) form.set("title", String(title))
    if (description) form.set("description", String(description))
    form.set("source", new Blob([bytes], { type: "video/mp4" }), require("path").basename(String(file)))
    const res = await fetcher(`${GRAPH.replace("graph.", "graph-video.")}/${encodeURIComponent(String(pageId))}/videos`, { method: "POST", body: form })
    const data = await json(res, "video upload")
    return { id: data.id, published: !!published }
  }

  /** A Reel (vertical 9:16, 3-90 s): start a session, send the bytes, finish. */
  async function uploadReel(pageId, file, { title, description, state = "DRAFT" } = {}) {
    const bytes = readVideo(file)
    const token = await pageToken(pageId)
    const page = encodeURIComponent(String(pageId))
    const start = await json(await fetcher(`${GRAPH}/${page}/video_reels`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_phase: "start", access_token: token }),
    }), "Reel upload (start)")
    if (!start.video_id) throw new Error("Facebook did not start the Reel upload. Nothing was published.")
    const uploadUrl = start.upload_url || `https://rupload.facebook.com/video-upload/${GRAPH.split("/").pop()}/${start.video_id}`
    await json(await fetcher(uploadUrl, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(bytes.length), "Content-Type": "application/octet-stream" },
      body: bytes,
    }), "Reel upload (sending the video)")
    const finish = await graph(token, "POST", `/${page}/video_reels`, {
      video_id: start.video_id, upload_phase: "finish", video_state: state,
      ...(title ? { title: String(title) } : {}), ...(description ? { description: String(description) } : {}),
    })
    if (finish && finish.success === false) throw new Error("Facebook did not accept the Reel. Nothing was published.")
    return { id: start.video_id, state }
  }

  /** Processing state of an uploaded video or Reel. */
  async function videoStatus(pageId, videoId) {
    const token = await pageToken(pageId)
    const data = await graph(token, "GET", `/${encodeURIComponent(String(videoId))}`, { fields: "status,permalink_url,title,description" })
    return data
  }

  return {
    id: ID, status, connect, poll, cancel, disconnect, connected,
    api: (method, path, params) => graph(null, method, path, params),
    asPage: async (pageId, method, path, params) => graph(await pageToken(pageId), method, path, params),
    uploadVideo, uploadReel, videoStatus,
  }
}

module.exports = { createFacebook, GRAPH, COMING_SOON }
