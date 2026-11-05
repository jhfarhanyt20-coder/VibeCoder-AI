"use strict"
/**
 * Post-edit diagnostics ("LSP-lite", zero dependencies).
 *
 * After write / edit / multiedit / apply_patch the agent gets syntax errors
 * back in the SAME tool result, so it fixes them immediately instead of
 * discovering them at the end (OpenCode does this through real LSP servers).
 *
 * Supported without installing anything:  .json  .js/.mjs/.cjs (node --check)
 * .py (python ast.parse, only if python exists). Nothing here executes the
 * user's code: `node --check` and `ast.parse` only parse.
 */
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const MAX_BYTES = 1024 * 1024
const MAX_MSG = 1500
const TIMEOUT = 8000

const clean = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^Node\.js v\d/.test(l.trim()))
    .join("\n")
    .slice(0, MAX_MSG)

// In the packaged Electron app process.execPath is the app itself: this flag makes it behave like plain node.
const nodeEnv = () => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1" })

function checkJson(abs, text) {
  const base = path.basename(abs).toLowerCase()
  if (/^(ts|js)config.*\.json$/.test(base) || /\.jsonc$/.test(base) || /[\\/]\.vscode[\\/]/.test(abs)) return "" // JSON-with-comments files
  try {
    JSON.parse(text.replace(/^\uFEFF/, ""))
    return ""
  } catch (e) {
    return String(e.message || e)
  }
}

function checkJs(abs, text) {
  const run = (args, input) =>
    spawnSync(process.execPath, args, { encoding: "utf8", timeout: TIMEOUT, windowsHide: true, env: nodeEnv(), ...(input != null ? { input } : {}) })
  let r = run(["--check", abs])
  if (r.error || r.status === 0) return ""
  const msg = clean(r.stderr)
  // an ES module in a package without "type": "module" is not an error for bundlers
  if (/Cannot use import statement|Unexpected token 'export'|import\.meta|Cannot use 'import\.meta'|await is only valid/.test(msg)) {
    r = run(["--input-type=module", "--check"], text)
    if (r.error || r.status === 0) return ""
  }
  return msg
}

let pyCmd // undefined = not probed, null = no python
function python() {
  if (pyCmd !== undefined) return pyCmd
  pyCmd = null
  for (const c of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 4000, windowsHide: true })
    if (!r.error && r.status === 0) { pyCmd = c; break }
  }
  return pyCmd
}

function checkPy(abs) {
  const cmd = python()
  if (!cmd) return ""
  const code = "import ast,sys\nsrc=open(sys.argv[1],encoding='utf-8',errors='replace').read()\ntry:\n    ast.parse(src,sys.argv[1])\nexcept SyntaxError as e:\n    print('%s:%s: SyntaxError: %s' % (e.filename,e.lineno,e.msg)); sys.exit(1)\n"
  const r = spawnSync(cmd, ["-c", code, abs], { encoding: "utf8", timeout: TIMEOUT, windowsHide: true })
  if (r.error || r.status === 0) return ""
  return clean(r.stdout || r.stderr)
}

/** Returns "" when the file looks fine (or cannot be checked), else a ready-to-append message. */
function diagnose(abs) {
  try {
    const ext = path.extname(abs).toLowerCase()
    if (![".json", ".js", ".mjs", ".cjs", ".py"].includes(ext)) return ""
    const st = fs.statSync(abs)
    if (!st.isFile() || st.size > MAX_BYTES) return ""
    const text = fs.readFileSync(abs, "utf8")
    const msg = ext === ".json" ? checkJson(abs, text) : ext === ".py" ? checkPy(abs) : checkJs(abs, text)
    return msg ? `\n\nSyntax errors detected in ${abs} after this change. Fix them now:\n${msg}` : ""
  } catch {
    return ""
  }
}

module.exports = { diagnose }
