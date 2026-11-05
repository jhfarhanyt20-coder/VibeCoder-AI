"use strict"
/**
 * Guardrails — the rule layer around every action.
 *
 * Precedence is deliberately simple and testable:
 *
 *   default rules  →  project/global rules  →  inherited (parent) rules
 *                  →  session rules         →  agent rules
 *
 * Every layer is evaluated in order and the LAST matching rule wins. Agent
 * rules therefore sit at the top, so a read-only persona cannot be widened by
 * an old "always allow" approval. Locks are checked separately, before all of
 * this, and are never affected by a rule.
 *
 * This module also owns secret detection/redaction helpers used by the Trail
 * and by callers that want to show a decision without leaking credentials.
 */
const { toPosix, globToRegExp, globToRegExpLoose } = require("../util")
const { normalizeRule, decide } = require("../perm/rules")

const LAYERS = ["default", "project", "inherited", "session", "agent"]

/**
 * Flatten rule layers in precedence order. An unknown layer name is kept last
 * so callers cannot accidentally outrank agent rules.
 */
function combineRules(layers = {}) {
  const out = []
  for (const name of LAYERS) {
    const list = layers[name]
    if (Array.isArray(list)) out.push({ source: name, rules: list })
  }
  for (const [name, list] of Object.entries(layers || {})) {
    if (!LAYERS.includes(name) && Array.isArray(list)) out.push({ source: name, rules: list })
  }
  return out
}

/**
 * Same matching semantics as `decide()`, but also reports which layer produced
 * the winning rule. `source` is "default" when nothing matched.
 */
function decideWithSource(layers, tool, subject) {
  const ordered = Array.isArray(layers) ? layers : combineRules(layers)
  const normalized = ordered.map((layer) => ({
    source: layer.source || "unknown",
    rules: (Array.isArray(layer.rules) ? layer.rules : []).map(normalizeRule),
  }))
  const rules = normalized.flatMap((layer) => layer.rules)
  // Reuse the one true matcher so precedence can never drift from decide().
  const action = decide(rules, tool, subject)
  let source = "default"
  // Walk again to find the last matching layer. Cheap (rules are tiny).
  const s = toPosix(subject == null ? "" : subject)
  for (const layer of normalized) {
    for (const r of layer.rules) {
      if (matches(r, tool, s)) source = layer.source
    }
  }
  return { action, source }
}

function matches(rule, tool, subject) {
  if (rule.tool !== "*" && rule.tool !== tool) return false
  const matcher = rule.tool === "bash" ? globToRegExpLoose : globToRegExp
  let hit = rule.exact ? subject === toPosix(rule.pattern) : rule.pattern === "*" || matcher(rule.pattern).test(subject)
  if (!hit && rule.tool === "bash" && typeof rule.pattern === "string" && rule.pattern.endsWith(" *")) {
    hit = subject === toPosix(rule.pattern.slice(0, -2).trim())
  }
  return hit
}

const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!example$|sample$|template$|dist$)[^/]+$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)(credentials|secrets?)\.(json|ya?ml|toml)$/i,
  /(^|\/)service[-_]account[^/]*\.json$/i,
  /\.(pem|p12|pfx|key)$/i,
]

/** True when a path is a file we should never echo verbatim. */
function isSecretFile(file) {
  const p = toPosix(String(file == null ? "" : file))
  if (!p) return false
  return SECRET_FILE_PATTERNS.some((re) => re.test(p))
}

const SECRET_TEXT_PATTERNS = [
  // Authorization: Bearer <token> (before the key=value rule, which would only
  // eat the word "Bearer")
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]"],
  // key = value / key: value for obviously secret names
  [/\b(api[-_]?key|access[-_]?key|secret|client[-_]?secret|password|passwd|token|authorization|private[-_]?key)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[redacted]"],
  // well-known token prefixes
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza[redacted]"],
]

/**
 * Redact secret-looking values in free text while keeping keys readable.
 * Used for Trail strings and any UI that shows a raw command/output.
 */
function redactText(value) {
  let text = String(value == null ? "" : value)
  for (const [re, replacement] of SECRET_TEXT_PATTERNS) text = text.replace(re, replacement)
  // PEM private key bodies
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
  return text
}

/**
 * Redact a file body. Secret files keep their structure (keys and comments) so
 * the shape is still useful, but every value is replaced.
 */
function redactFileBody(file, body) {
  const text = String(body == null ? "" : body)
  if (!isSecretFile(file)) return redactText(text)
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim() || /^\s*#/.test(line)) return line
      const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*)(.*)$/)
      if (!m) return redactText(line)
      return m[1] + "[redacted]"
    })
    .join("\n")
}

module.exports = {
  LAYERS,
  combineRules,
  decideWithSource,
  isSecretFile,
  redactText,
  redactFileBody,
}
