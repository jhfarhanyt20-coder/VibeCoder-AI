"use strict"
// BDCoder built-in plugin: a quick map of the open project (languages, how to
// run / test / build it, main config files, largest folders). Read-only.
const fs = require("fs")
const path = require("path")

const SKIP = new Set(["node_modules", ".git", "dist", "build", "release", "out", ".next", ".nuxt", ".cache", "__pycache__", ".venv", "venv", "coverage", "target", ".turbo"])
const LANG = { ".js": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript", ".ts": "TypeScript", ".tsx": "TypeScript", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin", ".cs": "C#", ".cpp": "C++", ".cc": "C++", ".c": "C", ".h": "C/C++ header", ".php": "PHP", ".rb": "Ruby", ".swift": "Swift", ".dart": "Dart", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".vue": "Vue", ".svelte": "Svelte", ".sql": "SQL", ".sh": "Shell", ".ps1": "PowerShell", ".md": "Markdown" }
const CONFIGS = ["package.json", "pyproject.toml", "requirements.txt", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile", "Dockerfile", "docker-compose.yml", "Makefile", ".env.example", "tsconfig.json", "vite.config.js", "vite.config.ts", "next.config.js", "electron-builder.yml"]

function scan(root, limit = 20000) {
  const langs = {}
  const folders = {}
  let files = 0
  let stopped = false
  const walk = (dir, top) => {
    let list = []
    try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const d of list) {
      if (files >= limit) { stopped = true; return }
      if (d.isDirectory()) {
        if (!SKIP.has(d.name) && !d.name.startsWith(".")) walk(path.join(dir, d.name), top || d.name)
      } else if (d.isFile()) {
        files++
        const lang = LANG[path.extname(d.name).toLowerCase()]
        if (lang) langs[lang] = (langs[lang] || 0) + 1
        const key = top || "(root)"
        folders[key] = (folders[key] || 0) + 1
      }
    }
  }
  walk(root, "")
  return { files, stopped, langs, folders }
}

function commands(root) {
  const out = []
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    const pm = fs.existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm"
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) out.push(`${pm} run ${name}   # ${String(cmd).slice(0, 100)}`)
    if (pkg.main) out.push(`entry: ${pkg.main}`)
  } catch { /* no package.json */ }
  if (fs.existsSync(path.join(root, "pyproject.toml")) || fs.existsSync(path.join(root, "requirements.txt"))) out.push("python: pip install -r requirements.txt / pytest")
  if (fs.existsSync(path.join(root, "Cargo.toml"))) out.push("cargo build / cargo test / cargo run")
  if (fs.existsSync(path.join(root, "go.mod"))) out.push("go build ./... / go test ./...")
  if (fs.existsSync(path.join(root, "Makefile"))) out.push("make (see the Makefile targets)")
  return out
}

module.exports = {
  tools: [{
    name: "project_overview",
    description: "A quick map of the open project: languages, file counts per top folder, main config files and the run/test/build commands. Read-only. Use it first when starting on an unfamiliar project.",
    parameters: { type: "object", properties: {} },
    perm: () => ({ tool: "read", subject: "project overview" }),
    run: async (_args, ctx = {}) => {
      const root = ctx.cwd || process.cwd()
      const s = scan(root)
      const langs = Object.entries(s.langs).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} (${v})`).join(", ") || "none found"
      const folders = Object.entries(s.folders).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${k}: ${v} files`).join("\n")
      const configs = CONFIGS.filter((f) => fs.existsSync(path.join(root, f)))
      const cmds = commands(root)
      return [
        `Project: ${path.basename(root)}  (${root})`,
        `Files: ${s.files}${s.stopped ? "+ (stopped counting)" : ""} (skipped: node_modules, .git, build output)`,
        `Languages: ${langs}`,
        `Config files: ${configs.join(", ") || "none of the usual ones"}`,
        "Largest folders:",
        folders || "  (empty)",
        "Commands:",
        cmds.length ? cmds.map((c) => "  " + c).join("\n") : "  none detected",
      ].join("\n")
    },
  }],
}
