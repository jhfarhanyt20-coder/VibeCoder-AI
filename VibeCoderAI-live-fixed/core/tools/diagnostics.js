"use strict"
/**
 * Post-edit diagnostics ("LSP-lite", zero dependencies).
 *
 * After write / edit / multiedit / apply_patch the agent gets syntax errors
 * back in the SAME tool result, so it fixes them immediately instead of
 * discovering them at the end (OpenCode does this through real LSP servers).
 *
 * Supported without installing anything: .json, .js/.mjs/.cjs (node --check)
 * and .py (python ast.parse, only if python exists). The explicit diagnostics
 * action can additionally use a project's own TypeScript compiler for targeted
 * semantic diagnostics. That action is Guardrail-protected because loading a
 * project-installed compiler executes third-party package code.
 */
const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const MAX_BYTES = 1024 * 1024
const MAX_MSG = 1500
const TIMEOUT = 8000
const TYPE_TIMEOUT = 15000
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])

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

function findProjectTypeScript(abs) {
  let dir = path.dirname(path.resolve(abs))
  for (;;) {
    const file = path.join(dir, "node_modules", "typescript", "lib", "typescript.js")
    if (fs.existsSync(file)) return file
    const parent = path.dirname(dir)
    if (parent === dir) return ""
    dir = parent
  }
}

function checkTypeScript(abs) {
  const compiler = findProjectTypeScript(abs)
  if (!compiler) return {
    available: false,
    provider: "none",
    diagnostics: [],
    note: "No project-local TypeScript compiler was found. Add TypeScript to this project to enable semantic diagnostics; no package was installed automatically.",
  }
  const worker = path.join(__dirname, "diagnostics-worker.js")
  const run = spawnSync(process.execPath, [worker, compiler, abs], {
    encoding: "utf8",
    timeout: TYPE_TIMEOUT,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    env: nodeEnv(),
  })
  if (run.error) {
    const timedOut = run.error.code === "ETIMEDOUT"
    return { available: false, provider: "typescript", diagnostics: [], note: timedOut ? "TypeScript diagnostics timed out after 15 seconds." : String(run.error.message || run.error) }
  }
  try {
    const result = JSON.parse(String(run.stdout || "{}"))
    if (!result.ok) return { available: false, provider: "typescript", diagnostics: [], note: result.error || "TypeScript diagnostics failed." }
    return { available: true, ...result }
  } catch {
    return { available: false, provider: "typescript", diagnostics: [], note: clean(run.stderr || run.stdout) || "TypeScript diagnostics returned an invalid response." }
  }
}

function inspect(abs, { semantic = false } = {}) {
  try {
    const file = path.resolve(abs)
    const ext = path.extname(file).toLowerCase()
    const st = fs.statSync(file)
    if (!st.isFile()) return { available: false, provider: "none", diagnostics: [], note: "Diagnostics require a file." }
    if (st.size > MAX_BYTES) return { available: false, provider: "none", diagnostics: [], note: `File is larger than the ${MAX_BYTES}-byte diagnostics limit.` }
    const text = fs.readFileSync(file, "utf8")
    if (semantic && TS_EXTENSIONS.has(ext)) {
      const typed = checkTypeScript(file)
      if (typed.available || ![".js", ".mjs", ".cjs"].includes(ext)) return typed
      const syntax = checkJs(file, text)
      return {
        available: true,
        provider: "Node syntax (TypeScript unavailable)",
        diagnostics: syntax ? [{ file, line: 0, column: 0, code: 0, category: "error", message: syntax }] : [],
        note: typed.note,
      }
    }
    let message = "", provider = "none"
    if (ext === ".json") { provider = "JSON parser"; message = checkJson(file, text) }
    else if (ext === ".py") { provider = python() ? "Python AST" : "none"; message = provider === "none" ? "" : checkPy(file) }
    else if ([".js", ".mjs", ".cjs"].includes(ext)) { provider = "Node syntax"; message = checkJs(file, text) }
    else return { available: false, provider: "none", diagnostics: [], note: semantic && TS_EXTENSIONS.has(ext) ? "No semantic provider is available." : `No built-in diagnostic provider for ${ext || "this file type"}.` }
    return {
      available: provider !== "none",
      provider,
      diagnostics: message ? [{ file, line: 0, column: 0, code: 0, category: "error", message }] : [],
      ...(provider === "none" ? { note: "The required local parser is not installed." } : {}),
    }
  } catch (error) {
    return { available: false, provider: "none", diagnostics: [], note: String(error?.message || error) }
  }
}

function format(report, abs) {
  if (!report.available) return `Diagnostics unavailable for ${abs}: ${report.note || "no provider found"}`
  if (!report.diagnostics.length) return `No diagnostics found in ${abs} (${report.provider}).`
  const rows = report.diagnostics.map((diag) => {
    const pos = diag.line ? `:${diag.line}${diag.column ? `:${diag.column}` : ""}` : ""
    const code = diag.code ? ` TS${diag.code}` : ""
    return `${diag.file || abs}${pos}${code} ${diag.category || "error"}: ${diag.message}`
  })
  return [`Diagnostics for ${abs} (${report.provider}):`, ...rows, ...(report.truncated ? ["Additional diagnostics were truncated."] : [])].join("\n")
}

/** Returns "" when the file looks fine (or cannot be checked), else a ready-to-append message. */
function diagnose(abs) {
  const report = inspect(abs, { semantic: false })
  if (!report.available || !report.diagnostics.length) return ""
  return `\n\nSyntax errors detected in ${abs} after this change. Fix them now:\n${format(report, abs).slice(0, MAX_MSG)}`
}

module.exports = { diagnose, inspect, format, findProjectTypeScript }
