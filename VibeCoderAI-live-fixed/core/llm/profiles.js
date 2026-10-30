"use strict"
/**
 * Provider profiles: one JSON object per model endpoint. Adding a provider = adding a profile, no code.
 *   format: "openai-chat" | "openai-responses" | "anthropic"
 *   quirks: { reasoningField, reasoningEffort, maxTokensParam, extraBody }
 * User profiles live in <VIBE_HOME>/profiles.json and override built-ins with the same id.
 * Keys live in <VIBE_HOME>/auth.json (mode 0600) or in the env var named by apiKeyEnv.
 */
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")
const { homeDir } = require("../util")
const { repairProfile } = require("./provider-meta")
const secrets = require("../store/secrets")

const BUILTIN = [
  {
    id: "anthropic",
    label: "Anthropic (Messages format)",
    format: "anthropic",
    baseURL: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    contextLimit: 200000,
    maxOutput: 8192,
  },
  {
    id: "openai",
    label: "OpenAI (Chat Completions)",
    format: "openai-chat",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiKeyEnv: "OPENAI_API_KEY",
    contextLimit: 128000,
    maxOutput: 8192,
    quirks: { maxTokensParam: "max_completion_tokens" },
  },
  {
    id: "openai-responses",
    label: "OpenAI (Responses API)",
    format: "openai-responses",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4.1",
    apiKeyEnv: "OPENAI_API_KEY",
    contextLimit: 128000,
    maxOutput: 8192,
  },
  {
    id: "groq-gpt-oss-120b",
    label: "Groq - gpt-oss-120b",
    format: "openai-chat",
    baseURL: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    apiKeyEnv: "GROQ_API_KEY",
    contextLimit: 131072,
    maxOutput: 8192,
    quirks: { reasoningField: "reasoning", reasoningEffort: "medium", maxTokensParam: "max_completion_tokens" },
  },
  {
    id: "xai-grok",
    label: "xAI Grok (set the model you have access to)",
    format: "openai-chat",
    baseURL: "https://api.x.ai/v1",
    model: "grok-4",
    apiKeyEnv: "XAI_API_KEY",
    contextLimit: 131072,
    maxOutput: 8192,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    format: "openai-chat",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextLimit: 64000,
    maxOutput: 8192,
  },
  {
    id: "ollama",
    label: "Ollama (local, no key)",
    format: "openai-chat",
    baseURL: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder",
    noAuth: true,
    contextLimit: 32768,
    maxOutput: 4096,
  },
]

const read = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"))
  } catch {
    return fallback
  }
}
const profilesFile = (home) => path.join(home || homeDir(), "profiles.json")
const authFile = (home) => path.join(home || homeDir(), "auth.json")

function listProfiles(home) {
  const user = read(profilesFile(home), [])
  const map = new Map(BUILTIN.map((p) => [p.id, p]))
  for (const p of Array.isArray(user) ? user : []) if (p && p.id) map.set(p.id, { ...(map.get(p.id) || {}), ...p })
  return [...map.values()]
}

function getProfile(id, home) {
  const p = listProfiles(home).find((x) => x.id === id)
  if (!p) throw new Error(`Unknown model profile "${id}". Run: vibe models`)
  return p
}

function upsertProfile(profile, home) {
  // source-level fix: console/dashboard URLs are corrected for every client.
  // The format is the user's explicit choice and is saved as-is - a host that does
  // not serve it only produces a hint (the runtime falls back on a 404).
  const fixed = repairProfile(profile)
  const clean = { ...profile }
  if (fixed.baseURL) clean.baseURL = fixed.baseURL
  const hints = fixed.hints.filter((h) => !/^format "/.test(h))
  if (!clean.format && fixed.format) clean.format = fixed.format
  else if (clean.format && fixed.format && fixed.format !== clean.format) {
    hints.push(
      `format "${clean.format}" is kept; ${clean.baseURL || fixed.baseURL} is known to serve "${fixed.format}"`,
    )
  }
  const f = profilesFile(home)
  const user = read(f, [])
  const i = user.findIndex((p) => p.id === clean.id)
  if (i >= 0) user[i] = { ...user[i], ...clean }
  else user.push(clean)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(user, null, 2))
  return { id: clean.id, baseURL: clean.baseURL, format: clean.format, hints }
}

/* chmod 0600 is a no-op on Windows; icacls pins the file to the current user.
   Runs once per file per process (the ACL survives later writes to the same file). */
const aclDone = new Set()
function hardenFileAcl(f) {
  if (aclDone.has(f)) return
  aclDone.add(f)
  if (process.platform !== "win32") return
  const user = process.env.USERNAME || process.env.USER
  if (!user) return
  try {
    spawnSync("icacls", [f, "/inheritance:r", "/grant:r", `${user}:F`], { windowsHide: true, timeout: 15000, stdio: "ignore" })
  } catch {}
}

function setKey(id, key, home) {
  const normalized = String(key == null ? "" : key).trim()
  if (normalized && !/^[\x20-\x7E]+$/.test(normalized)) {
    throw new Error("The API key contains non-ASCII characters. Re-enter the exact key from the provider dashboard.")
  }
  key = normalized
  const f = authFile(home)
  const auth = read(f, {})
  if (key) auth[id] = secrets.encrypt(key)
  else delete auth[id]
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(auth, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(f, 0o600)
  } catch {}
  hardenFileAcl(f)
}

function getKey(profile, home) {
  if (profile.noAuth) return ""
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) {
    const key = String(process.env[profile.apiKeyEnv]).trim()
    if (!/^[\x20-\x7E]*$/.test(key)) throw new Error(`The API key in ${profile.apiKeyEnv} contains non-ASCII characters; correct that environment variable.`)
    return key
  }
  const auth = read(authFile(home), {})
  const k = auth[profile.id]
  if (k) {
    const key = secrets.decrypt(k)
    // API keys are ASCII; a non-ASCII value is a corrupted store (old DPAPI
    // bug). Fail with a clear instruction instead of a ByteString header crash.
    if (!/^[\x20-\x7E]*$/.test(key))
      throw new Error(`The saved API key for "${profile.id}" is corrupted (it contains invalid characters). Open Settings → Model settings and re-enter the key.`)
    return key.trim()
  }
  // Never borrow credentials from another profile just because the host matches.
  throw new Error(`No API key for "${profile.id}". Run: vibe auth add ${profile.id}` + (profile.apiKeyEnv ? ` (or set ${profile.apiKeyEnv})` : ""))
}

/**
 * Copy a stored key entry verbatim (the at-rest blob is identical for every
 * profile on this machine). Zero decryption, zero spawn - derived per-model
 * profiles get their key this way.
 */
function copyKey(fromId, toId, home) {
  const f = authFile(home)
  const auth = read(f, {})
  const v = auth[fromId]
  if (typeof v !== "string" || !v) return false
  auth[toId] = v
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(auth, null, 2), { mode: 0o600 })
  hardenFileAcl(f)
  return true
}

/**
 * One-time upgrade + cache warm, all in ONE powershell call:
 * plaintext keys saved by older versions -> encrypted, encrypted keys -> cached
 * so getKey()/hasKey() never spawn a process on the hot path. Fire-and-forget.
 */
async function migrateAuthKeys(home) {
  try {
    const f = authFile(home)
    const auth = read(f, {})
    if (!auth || typeof auth !== "object") return
    const entries = Object.entries(auth).filter(([, v]) => typeof v === "string" && v)
    const plain = entries.filter(([, v]) => !v.startsWith(secrets.PREFIX))
    const enc = entries.filter(([, v]) => v.startsWith(secrets.PREFIX)).map(([, v]) => v)
    await secrets.warm([...new Set(enc)])
    if (!plain.length) return
    const done = await secrets.protectBatch(plain.map(([, v]) => v))
    if (!done) return
    let changed = false
    plain.forEach(([id], i) => {
      if (done[i]) {
        auth[id] = done[i]
        changed = true
      }
    })
    if (changed) {
      fs.writeFileSync(f, JSON.stringify(auth, null, 2), { mode: 0o600 })
      hardenFileAcl(f)
    }
  } catch {}
}

/** Background warm at app start: after this, key reads are cache hits. */
const warmAuthCache = (home) => migrateAuthKeys(home)

/** Does a key EXIST for this profile? Never decrypts (no process spawn): this
 *  runs for every profile on every list, the UI only needs the badge. */
const hasKey = (profile, home) => {
  if (profile.noAuth) return true
  if (profile.apiKeyEnv && process.env[profile.apiKeyEnv]) return true
  const auth = read(authFile(home), {})
  if (typeof auth[profile.id] === "string" && auth[profile.id]) return true
  // A different profile's credential does not count as configured for this one.
  return false
}

module.exports = { BUILTIN, listProfiles, getProfile, upsertProfile, setKey, getKey, hasKey, copyKey, migrateAuthKeys, warmAuthCache }
