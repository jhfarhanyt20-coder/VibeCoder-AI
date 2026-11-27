"use strict"
/**
 * Crew workspaces: every helper that changes files works in its OWN copy of the
 * project, so parallel helpers never overwrite each other or the user's files.
 *
 *  - git projects: a git worktree on its own branch (vibe/crew-<id>), started
 *    from the project's current state INCLUDING uncommitted and untracked files
 *    (recorded as a private "base" commit inside the worktree).
 *  - other projects: a plain copy ("work") plus an untouched copy ("base").
 *
 * When a helper finishes, the main agent (or the user) reviews the changes and
 * merges or discards them. Merging is a careful three-way merge per file:
 *   main unchanged since the start -> take the helper's version;
 *   both changed -> line merge (git merge-file) or, without git, keep the main
 *   file and save the helper's version next to it — nothing is lost silently.
 * The user's git index/branches are never touched by a merge.
 */
const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "release", "out", ".next", ".nuxt", "coverage", ".vibe-scratch", "__pycache__", ".venv", "venv", "target", ".gradle", ".idea", ".vs"])
const COPY_LIMITS = { files: 6000, bytes: 300 * 1024 * 1024, fileBytes: 25 * 1024 * 1024 }

let gitChecked = null
function hasGit() {
  if (gitChecked !== null) return gitChecked
  try { execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true, timeout: 10000 }); gitChecked = true } catch { gitChecked = false }
  return gitChecked
}
function git(cwd, args, { input, buffer = false, allowFail = false } = {}) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], { input, windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] })
    return buffer ? out : out.toString("utf8")
  } catch (e) {
    if (allowFail) return null
    const msg = String((e.stderr && e.stderr.toString()) || e.message || e).trim().split("\n").slice(-3).join(" ")
    throw new Error(`git ${args[0]} failed: ${msg}`)
  }
}
const IDENT = ["-c", "user.name=BDCoder Crew", "-c", "user.email=crew@vibecoder.local", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`]

function gitTop(dir) {
  if (!hasGit()) return null
  const top = git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true })
  if (!top) return null
  const head = git(dir, ["rev-parse", "--verify", "HEAD"], { allowFail: true })
  if (!head) return null // a repo without commits cannot host a worktree
  return realDir(top.trim())
}

// One spelling for a folder: Windows 8.3 short names (C:UsersRUNNER~1) and
// git's long form must compare equal, or relative paths go wrong.
function realDir(p) {
  const abs = path.resolve(p)
  try { return fs.realpathSync.native(abs) } catch { return abs }
}

function copyTree(src, dst, stats = { files: 0, bytes: 0 }) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      copyTree(s, d, stats)
    } else if (e.isFile()) {
      const size = fs.statSync(s).size
      if (size > COPY_LIMITS.fileBytes) continue
      stats.files++
      stats.bytes += size
      if (stats.files > COPY_LIMITS.files || stats.bytes > COPY_LIMITS.bytes) {
        throw new Error(`The project is too big for a private copy (over ${COPY_LIMITS.files} files or ${Math.round(COPY_LIMITS.bytes / 1048576)} MB). Use git for this project, or run the helper in the shared folder.`)
      }
      fs.copyFileSync(s, d)
    }
  }
  return stats
}

function walkFiles(root, rel = "", out = []) {
  let entries = []
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(root, r, out) }
    else if (e.isFile()) out.push(r)
  }
  return out
}
const readOrNull = (f) => { try { return fs.readFileSync(f) } catch { return null } }
const sameBuf = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b))

/**
 * Create a private workspace for helper `id` working on `dir`.
 * Returns { mode, root, cwd, base, branch, top, rel, createdAt } (plain JSON, persisted with the child session).
 */
function create({ dir, id, home }) {
  const store = path.join(home, "workspaces")
  fs.mkdirSync(store, { recursive: true })
  const root = path.join(store, String(id).replace(/[^\w.-]/g, "_"))
  const top = gitTop(dir)
  if (top) {
    const rel = path.relative(top, realDir(dir))
    const branch = `vibe/crew-${String(id).replace(/[^\w.-]/g, "-")}`
    git(top, ["worktree", "add", "-q", "-b", branch, root, "HEAD"])
    try {
      // Start from what the user really has now: uncommitted edits and new files too.
      const dirty = git(top, ["diff", "HEAD", "--binary"], { buffer: true })
      if (dirty && dirty.length) git(root, ["apply", "--binary", "--whitespace=nowarn"], { input: dirty })
      const untracked = git(top, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)
      for (const f of untracked) {
        const src = path.join(top, f)
        try {
          if (fs.statSync(src).size > COPY_LIMITS.fileBytes) continue
          fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true })
          fs.copyFileSync(src, path.join(root, f))
        } catch {}
      }
      git(root, ["add", "-A"])
      git(root, [...IDENT, "commit", "-q", "--no-verify", "--allow-empty", "-m", "BDCoder Crew: starting point"])
      const base = git(root, ["rev-parse", "HEAD"]).trim()
      return { mode: "git", root, cwd: rel ? path.join(root, rel) : root, base, branch, top, rel, source: path.resolve(dir), createdAt: Date.now() }
    } catch (e) {
      try { remove({ mode: "git", root, branch, top }) } catch {}
      throw e
    }
  }
  // No git: a working copy plus an untouched base copy for the merge.
  const work = path.join(root, "work")
  const baseDir = path.join(root, "base")
  try {
    copyTree(path.resolve(dir), work)
    copyTree(path.resolve(dir), baseDir)
  } catch (e) {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    throw e
  }
  return { mode: "copy", root, cwd: work, base: baseDir, source: path.resolve(dir), rel: "", createdAt: Date.now() }
}

/** Changed files: [{ path (posix, relative to the project root), status: added|modified|deleted }] */
function changes(ws) {
  if (!ws) return []
  if (ws.mode === "git") {
    git(ws.root, ["add", "-A"])
    const out = git(ws.root, ["diff", "--cached", "--name-status", "--no-renames", "-z", ws.base])
    const parts = out.split("\0").filter(Boolean)
    const rows = []
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i][0]
      rows.push({ path: parts[i + 1], status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" })
    }
    return rows
  }
  const work = path.join(ws.root, "work")
  const set = new Set([...walkFiles(ws.base), ...walkFiles(work)])
  const rows = []
  for (const rel of [...set].sort()) {
    const b = readOrNull(path.join(ws.base, rel))
    const w = readOrNull(path.join(work, rel))
    if (sameBuf(b, w)) continue
    rows.push({ path: rel, status: b === null ? "added" : w === null ? "deleted" : "modified" })
  }
  return rows
}

/** A readable unified diff of the helper's changes (clipped). */
function diff(ws, { maxChars = 60000 } = {}) {
  if (!ws) return ""
  if (ws.mode === "git") {
    git(ws.root, ["add", "-A"])
    const text = git(ws.root, ["diff", "--cached", "--no-renames", "--stat", "--patch", ws.base])
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [diff cut at ${maxChars} characters]` : text
  }
  const rows = changes(ws)
  return rows.map((r) => `${r.status.toUpperCase()} ${r.path}`).join("\n")
}

function baseContent(ws, rel) {
  if (ws.mode === "git") return git(ws.root, ["show", `${ws.base}:${rel}`], { buffer: true, allowFail: true })
  return readOrNull(path.join(ws.base, rel))
}
function workContent(ws, rel) {
  return readOrNull(ws.mode === "git" ? path.join(ws.root, rel) : path.join(ws.root, "work", rel))
}
function mainPath(ws, rel) {
  return ws.mode === "git" ? path.join(ws.top, rel) : path.join(ws.source, rel)
}

/**
 * Bring the helper's changes into the real project. `beforeWrite(abs)` is called
 * before each file changes (Rewind snapshots). Returns { applied, conflicts, kept, skipped }.
 */
function merge(ws, { only, beforeWrite = () => {} } = {}) {
  const rows = changes(ws).filter((r) => !only || only.includes(r.path))
  const applied = []
  const conflicts = []
  const kept = []
  for (const r of rows) {
    const target = mainPath(ws, r.path)
    // Windows: git keeps LF inside but may write CRLF to disk (autocrlf), so the
    // same text can differ only in line endings. Compare and merge on LF, and
    // write the result in the line-ending style the user's file already uses.
    const M = readOrNull(target)
    const style = eolOf(M) || eolOf(workContent(ws, r.path)) || "\n"
    const B = toLf(baseContent(ws, r.path))
    const W = toLf(workContent(ws, r.path))
    const ML = toLf(M)
    const out = (buf) => (buf && style === "\r\n" && !isBinary(buf) ? Buffer.from(buf.toString("utf8").replace(/\n/g, "\r\n"), "utf8") : buf)
    if (sameBuf(ML, W)) { applied.push(r.path); continue } // already the same
    if (sameBuf(ML, B)) {
      // The user did not touch it meanwhile: take the helper's version.
      beforeWrite(target)
      if (W === null) { try { fs.unlinkSync(target) } catch {} }
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, out(W)) }
      applied.push(r.path)
      continue
    }
    // Both sides changed. Try a line merge with git; otherwise keep both versions.
    if (B && ML && W && hasGit() && !isBinary(B) && !isBinary(ML) && !isBinary(W)) {
      const tmp = fs.mkdtempSync(path.join(ws.root, ".merge-"))
      try {
        const fm = path.join(tmp, "main"), fb = path.join(tmp, "base"), fw = path.join(tmp, "work")
        fs.writeFileSync(fm, ML); fs.writeFileSync(fb, B); fs.writeFileSync(fw, W)
        let merged
        let clean = true
        try {
          merged = execFileSync("git", ["merge-file", "-p", "-L", "your version", "-L", "start", "-L", "helper's version", fm, fb, fw], { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 })
        } catch (e) {
          if (e.status > 0 && e.stdout) { merged = e.stdout; clean = false } else throw e
        }
        beforeWrite(target)
        fs.writeFileSync(target, out(merged))
        if (clean) applied.push(r.path)
        else conflicts.push(r.path)
        continue
      } catch {
        // fall through to keeping both versions
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
      }
    }
    if (W !== null) {
      const side = `${target}.crew-${String(ws.root).slice(-6).replace(/[^\w]/g, "")}`
      fs.writeFileSync(side, W)
      kept.push({ path: r.path, helperCopy: side })
    } else {
      kept.push({ path: r.path, helperCopy: null })
    }
  }
  return { applied, conflicts, kept, total: rows.length }
}

/** "\r\n" when a text buffer uses Windows line endings, "\n" for LF, "" when unknown. */
function eolOf(buf) {
  if (!buf || isBinary(buf)) return ""
  const s = buf.toString("utf8")
  const crlf = (s.match(/\r\n/g) || []).length
  const lf = (s.match(/\n/g) || []).length - crlf
  return crlf === 0 && lf === 0 ? "" : crlf >= lf ? "\r\n" : "\n"
}
/** Text with LF line endings (binary data is returned as it is). */
function toLf(buf) {
  if (!buf || isBinary(buf)) return buf
  return Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8")
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** Delete the private workspace (and its branch in git mode). */
function remove(ws) {
  if (!ws) return
  if (ws.mode === "git") {
    if (ws.top && fs.existsSync(ws.top)) {
      git(ws.top, ["worktree", "remove", "--force", ws.root], { allowFail: true })
      git(ws.top, ["worktree", "prune"], { allowFail: true })
      if (ws.branch) git(ws.top, ["branch", "-D", ws.branch], { allowFail: true })
    }
  }
  try { fs.rmSync(ws.root, { recursive: true, force: true }) } catch {}
}

module.exports = { create, changes, diff, merge, remove, hasGit, SKIP_DIRS }
