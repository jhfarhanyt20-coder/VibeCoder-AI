"use strict"
/**
 * Built-in (shipped) shell allow rules, matched structurally instead of by a
 * loose `*text*` wildcard.
 *
 * The old default rules were substring globs such as `*npm test*` and
 * `*Remove-Item*vibe-scratch*`, so `Format-Volume D # npm test` or
 * `Remove-Item -Recurse -Force C:\Users\x # vibe-scratch` ran without a prompt.
 * A built-in rule now matches only when one split command segment:
 *   - STARTS with the rule's program + sub-command (`npm test`, `cargo build`),
 *   - carries only plain arguments after it (no comment, redirect, variable,
 *     sub-expression, script block or other way to start a second program),
 *   - and, for the scratch cleanup rule, removes only paths inside
 *     `./.vibe-scratch` (relative to the workspace, no `..`, no drive, no
 *     absolute path, no wildcard in the folder name itself).
 *
 * Saved user rules are not affected: they keep the plain wildcard semantics.
 */

/** Tokenize one command segment. Returns null when the text has shell syntax a built-in rule must not auto-allow. */
function tokenize(segment) {
  const s = String(segment == null ? "" : segment)
  const out = []
  let cur = ""
  let has = false
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) {
      if (ch === q) { q = null; continue }
      // Inside double quotes PowerShell/bash still expand $x, $(..) and `x.
      if (q === '"' && (ch === "$" || ch === "`")) return null
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue }
    if (ch === " " || ch === "\t") {
      if (has || cur) out.push(cur)
      cur = ""
      has = false
      continue
    }
    // Comments, redirects, variables, sub-expressions, script blocks, call
    // operators, cmd escapes/expansion, splatting, separators and newlines.
    if ("#$`(){}<>|;&%^!@\r\n\0".includes(ch)) {
      // `2>&1` (merge stderr into stdout) is harmless and very common.
      if (ch === ">" && /^[12*]?$/.test(cur) && s.slice(i, i + 3) === ">&1" && (s[i + 3] === undefined || /\s/.test(s[i + 3]))) {
        cur = ""
        has = false
        i += 2
        continue
      }
      return null
    }
    cur += ch
    has = true
  }
  if (q) return null // unbalanced quote
  if (has || cur) out.push(cur)
  return out
}

const lower = (s) => String(s).toLowerCase()
const prog = (t) => lower(t).replace(/\.(cmd|exe|bat|ps1)$/, "")
const scratchMention = (t) => /vibe-scratch/i.test(t)

// Flags npm/yarn/pnpm accept for test/build/install without running anything
// extra. `--script-shell`, `--node-options`, `--prefix`, `--userconfig` and the
// like can point the run at another program, so they are not on this list.
const PKG_FLAGS = new Set([
  "--silent", "-s", "--quiet", "-q", "--if-present", "--workspaces", "--ws", "--include-workspace-root",
  "--no-audit", "--no-fund", "--prefer-offline", "--offline", "--legacy-peer-deps", "--ignore-scripts",
  "--frozen-lockfile", "--immutable", "--no-progress", "--verbose", "--loglevel=silent", "--loglevel=error",
  "--loglevel=warn", "--loglevel=info", "--production", "--omit=dev", "--omit=optional", "--omit=peer",
  "--include=dev", "--no-save", "--strict-peer-dependencies", "--recursive", "-r",
])
const PKG_VALUE_FLAG = /^--(workspace|filter)=[\w@./-]+$/

/** `npm test`, `npm test -- --grep x`, `npm ci`, `yarn build` ... */
function pkgRule(words) {
  return (tokens) => {
    if (tokens.length < words.length) return false
    for (let i = 0; i < words.length; i++) {
      if ((i === 0 ? prog(tokens[i]) : lower(tokens[i])) !== words[i]) return false
    }
    const rest = tokens.slice(words.length)
    let afterDash = false
    for (const t of rest) {
      if (scratchMention(t)) return false
      if (afterDash) continue // arguments handed to the repo's own script
      if (t === "--" && /^(test|build)$/.test(words[1])) { afterDash = true; continue }
      if (PKG_FLAGS.has(lower(t)) || PKG_VALUE_FLAG.test(t)) continue
      return false // a package name, a config flag or anything else: ask
    }
    return true
  }
}

// Options that let the build tool run another program; the rule asks for them.
const RISKY_FLAG = {
  cargo: /^(--config(=|$)|-Z|--target-dir$|-C$)/i,
  go: /^-{1,2}(exec|toolexec|overlay|modfile)(=|$)/i,
  dotnet: /^([-/](p|property|logger|l|distributedlogger|dl|noAutoResponse)[:=]|--property|--logger|@)/i,
}

/** `cargo test …`, `go build ./...`, `dotnet test …`. */
function toolRule(words) {
  return (tokens) => {
    if (tokens.length < words.length) return false
    for (let i = 0; i < words.length; i++) {
      if ((i === 0 ? prog(tokens[i]) : lower(tokens[i])) !== words[i]) return false
    }
    const risky = RISKY_FLAG[words[0]]
    for (const t of tokens.slice(words.length)) {
      if (scratchMention(t)) return false
      if (risky && risky.test(t)) return false
    }
    return true
  }
}

/** `node --test` with only test-runner flags and test file paths. */
function nodeTestRule(tokens) {
  if (tokens.length < 2 || prog(tokens[0]) !== "node" || lower(tokens[1]) !== "--test") return false
  for (const t of tokens.slice(2)) {
    if (scratchMention(t)) return false
    if (t.startsWith("-")) {
      if (/^--(experimental-)?test(-[a-z-]+)?(=.*)?$/i.test(t)) continue
      return false // --require, --import, --eval, --loader ... load other code
    }
  }
  return true
}

/** Is one path argument inside ./.vibe-scratch (relative to the workspace)? */
function insideScratch(raw) {
  const p = String(raw).replace(/\\/g, "/")
  if (!p) return false
  if (/^[a-z]:/i.test(p) || p.startsWith("/") || p.startsWith("~")) return false // absolute: ask
  const parts = p.split("/").filter((x, i) => !(x === "." && i === 0) && x !== "")
  if (!parts.length || lower(parts[0]) !== ".vibe-scratch") return false
  if (parts.some((x) => x === ".." || x.includes(":"))) return false
  return true
}

const RM_PARAM_WITH_PATH = /^-(path|literalpath|lp|pspath)$/i
const RM_PARAM_WITH_WORD = /^-(erroraction|ea|warningaction|wa|informationaction|infa)$/i
const RM_PARAM_WITH_NAME = /^-(include|exclude|filter)$/i
const RM_SWITCH = /^(-[a-z]+(:\$?(true|false))?|--(recursive|force|verbose|dir|one-file-system|no-preserve-root|preserve-root))$/i

/** `Remove-Item -Recurse -Force .vibe-scratch`, `rm -rf ./.vibe-scratch/a.txt` … */
function scratchCleanupRule(tokens, segment) {
  if (!tokens.length) return false
  const p = prog(tokens[0])
  if (p !== "remove-item" && p !== "rm" && p !== "ri") return false
  // `-Confirm:$false` is the only `$` allowed; tokenize() rejected the rest.
  const paths = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (RM_PARAM_WITH_PATH.test(t)) {
      const v = tokens[++i]
      if (v === undefined) return false
      paths.push(...v.split(","))
      continue
    }
    if (RM_PARAM_WITH_WORD.test(t)) {
      const v = tokens[++i]
      if (!v || !/^[a-z]+$/i.test(v)) return false
      continue
    }
    if (RM_PARAM_WITH_NAME.test(t)) {
      const v = tokens[++i]
      if (!v || /[\\/:]|\.\./.test(v)) return false
      continue
    }
    if (t.startsWith("-")) {
      if (RM_SWITCH.test(t)) continue
      return false
    }
    paths.push(...t.split(","))
  }
  const list = paths.filter((x) => x !== "")
  return list.length > 0 && list.every(insideScratch)
}

/** PowerShell `-Confirm:$false` is safe; take it out before the strict tokenizer runs. */
const withoutConfirmFalse = (s) => String(s).replace(/(^|\s)-Confirm:\$false(?=\s|$)/gi, "$1-Confirm:false")

const MATCHERS = {
  "npm-test": pkgRule(["npm", "test"]),
  "npm-t": pkgRule(["npm", "t"]),
  "npm-build": pkgRule(["npm", "build"]),
  "npm-ci": pkgRule(["npm", "ci"]),
  "npm-install": pkgRule(["npm", "install"]),
  "npm-i": pkgRule(["npm", "i"]),
  "yarn-build": pkgRule(["yarn", "build"]),
  "yarn-test": pkgRule(["yarn", "test"]),
  "pnpm-build": pkgRule(["pnpm", "build"]),
  "pnpm-test": pkgRule(["pnpm", "test"]),
  "node-test": nodeTestRule,
  "cargo-build": toolRule(["cargo", "build"]),
  "cargo-test": toolRule(["cargo", "test"]),
  "go-build": toolRule(["go", "build"]),
  "go-test": toolRule(["go", "test"]),
  "dotnet-build": toolRule(["dotnet", "build"]),
  "dotnet-test": toolRule(["dotnet", "test"]),
  "scratch-clean": scratchCleanupRule,
}

/**
 * Does one command segment match a built-in rule? Unknown builtin names never
 * match (fail closed), so an old app reading a newer rule file cannot be
 * widened by it.
 */
function matchBuiltin(name, segment) {
  const fn = MATCHERS[name]
  if (!fn) return false
  const text = String(segment == null ? "" : segment).trim()
  const tokens = tokenize(name === "scratch-clean" ? withoutConfirmFalse(text) : text)
  if (!tokens || !tokens.length) return false
  return fn(tokens, text) === true
}

/**
 * Shell text that can start a second program inside the first command:
 * command/sub-expression substitution, script blocks, Invoke-Expression,
 * Start-Process, nested shells (`cmd /c`, `powershell -c`, `-EncodedCommand`),
 * cmd `%VAR%` expansion. A match turns an automatic allow into a prompt.
 */
function hasDynamicShell(command) {
  const s = String(command == null ? "" : command)
  if (/\$\(|`|\$\{|@\(|@\{/.test(s)) return true
  // Unquoted sub-expression / script block: `npm test (calc)`, `& {..}`, `. {..}`.
  let q = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q) q = null; continue }
    if (ch === "'" || ch === '"') { q = ch; continue }
    if (ch === "(" || ch === "{") return true
  }
  const word = "(?:^|[\\s;|&(\"'])"
  // Short aliases only count in command position (start of a segment), so
  // `npm start` or `git log ii` do not trip the check.
  const head = "(?:^|[;|&(\\n]\\s*)"
  const tests = [
    new RegExp(`${word}(?:iex|Invoke-Expression|Invoke-Command|Start-Process|Start-Job|Start-ThreadJob|Invoke-Item|Register-ScheduledTask|schtasks|wmic|Invoke-WmiMethod|Invoke-CimMethod|rundll32|mshta|regsvr32|cscript|wscript|xargs)(?:\\.exe)?(?=\\s|$)`, "i"),
    new RegExp(`${head}(?:icm|saps|start|sajb|ii|\\.)(?=\\s|$)`, "i"),
    new RegExp(`${word}cmd(?:\\.exe)?\\s+(?:/[a-z]\\s+)*/[ck]\\b`, "i"),
    new RegExp(`${word}(?:powershell|pwsh)(?:\\.exe)?\\s(?:[^\\n]*\\s)?-(?:c|command|e|ec|en|enc|encodedcommand|f|file)\\b`, "i"),
    new RegExp(`${word}(?:powershell|pwsh)(?:\\.exe)?\\s+(?!-)\\S`, "i"),
    new RegExp(`${word}(?:bash|sh|zsh|dash)(?:\\.exe)?\\s(?:[^\\n]*\\s)?-c\\b`, "i"),
    new RegExp(`${word}wsl(?:\\.exe)?(?=\\s|$)`, "i"),
    /\s-exec(dir)?\s/i, // find -exec
  ]
  return tests.some((re) => re.test(s))
}

module.exports = { matchBuiltin, hasDynamicShell, insideScratch, tokenize, MATCHERS }
