"use strict"
/**
 * GitHub tools for the agent, offered while the GitHub connector is signed in.
 * Reading never asks. Ordinary changes (issue, comment, branch, PR, file on a
 * work branch) follow the normal permission mode. Actions that are hard to undo
 * (merge, writing to the default branch, deleting, repository settings) always
 * ask the user first, even in Full Access.
 * Every reply says what happened and what to do next.
 */

const MAX = 24000
const clip = (s, n = MAX) => (s.length <= n ? s : `${s.slice(0, n)}\n… [${s.length - n} more characters cut; ask for a narrower part]`)

function gh(ctx) {
  const c = ctx && ctx.engine && ctx.engine.connectors && ctx.engine.connectors.github
  if (!c || !c.connected()) throw new Error("GitHub is not connected. Ask the user to sign in under Connectors → GitHub (CLI: vibe connectors github connect). Nothing was done.")
  // Pass the run's stop signal along, so Stop also cancels a GitHub call in flight.
  const signal = ctx && ctx.signal
  if (!signal) return c
  return { ...c, api: (method, p, body, opts) => c.api(method, p, body, { signal, ...(opts || {}) }) }
}

// github_api calls that are hard to undo: always ask, even in Full Access.
// The query string is ignored when matching, so "?x" cannot slip past the check.
function criticalApi(method, path) {
  if (method === "GET") return false
  if (method === "DELETE") return true
  const p = String(path || "").split(/[?#]/)[0].replace(/\/{2,}/g, "/").replace(/\/+$/, "")
  if (/\/(transfer|collaborators|hooks|keys|secrets|actions\/permissions|branches\/[^/]+\/protection)\b|^\/repos\/[^/]+\/[^/]+$|^\/orgs\/[^/]+$|^\/user$/i.test(p)) return true
  if (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/i.test(p)) return true // merge (like github_merge_pr)
  if ((method === "PATCH" || method === "POST") && /^\/repos\/[^/]+\/[^/]+\/git\/refs(\/|$)/i.test(p)) return true // move / force a branch or tag
  if (method === "PUT" && /^\/repos\/[^/]+\/[^/]+\/contents(\/|$)/i.test(p)) return true // commit a file (github_write_file asks only off the default branch)
  return false
}

/** Number the lines of a text file, between start_line and end_line (1-based), cut at whole lines to fit. */
function showLines(head, text, a) {
  const lines = text.split("\n")
  const total = lines.length
  const from = Math.min(total, Math.max(1, Math.floor(Number(a.start_line)) || 1))
  const to = Math.min(total, Math.max(from, Math.floor(Number(a.end_line)) || total))
  let body = ""
  let last = from - 1
  for (let i = from; i <= to; i++) {
    const line = `${i}\t${lines[i - 1]}\n`
    if (body.length + line.length > MAX && i > from) break
    body += line.length > MAX ? `${line.slice(0, MAX)}…\n` : line
    last = i
  }
  const partial = from > 1 || last < total
  const note = partial ? `Showing lines ${from}-${last} of ${total}.${last < total ? ` Use start_line=${last + 1} to read more.` : ""}\n` : ""
  return `${head}\n${note}${body.replace(/\n$/, "")}`
}

function repoOf(a) {
  const r = String(a.repo || a.repository || "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "")
  if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error(`"repo" must look like owner/name (for example octocat/hello-world); got "${a.repo || ""}". Use github_repos to find it. Nothing was done.`)
  return r
}
const enc = (p) => String(p || "").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")

async function confirmCritical(ctx, what) {
  const ok = typeof ctx.askPermission === "function" && await ctx.askPermission({ tool: "github", subject: `Allow the agent to ${what} on GitHub?`, neverPersist: true, forceAsk: true, critical: true })
  if (!ok) throw new Error(`The user did not allow this: ${what}. Do not retry it; ask the user what to do.`)
}

async function defaultBranch(c, repo) {
  const info = await c.api("GET", `/repos/${repo}`)
  return info.default_branch || "main"
}

const repoProp = { type: "string", description: "Repository as owner/name, e.g. octocat/hello-world" }

const tool = (name, description, properties, required, perm, run) => ({
  name,
  description,
  parameters: { type: "object", properties, required },
  connector: "github",
  perm: (a) => ({ tool: "github", subject: perm(a) }),
  paths: () => [],
  run,
})

const ALL = [
  tool("github_repos", "List the signed-in user's GitHub repositories, or search repositories. Returns owner/name, visibility, default branch and last update.",
    { query: { type: "string", description: "Optional search words (searches all of GitHub when given)" }, limit: { type: "integer", description: "Max results (default 30)" } }, [],
    () => "read repos",
    async (a, ctx) => {
      const c = gh(ctx)
      const n = Math.min(100, Math.max(1, Number(a.limit) || 30))
      const rows = a.query
        ? (await c.api("GET", `/search/repositories?q=${encodeURIComponent(a.query)}&per_page=${n}`)).items || []
        : await c.api("GET", `/user/repos?per_page=${n}&sort=updated&affiliation=owner,collaborator,organization_member`)
      if (!rows.length) return a.query ? `No repositories match "${a.query}".` : "This account has no repositories yet."
      return rows.map((r) => `${r.full_name}${r.private ? " (private)" : ""} · default ${r.default_branch} · updated ${String(r.updated_at || "").slice(0, 10)}${r.description ? ` · ${r.description.slice(0, 100)}` : ""}`).join("\n")
    }),

  tool("github_files", "Read a file, or list a folder, in a GitHub repository (any branch, tag or commit).",
    { repo: repoProp, path: { type: "string", description: "File or folder path; empty for the repository root" }, ref: { type: "string", description: "Branch, tag or commit (default: the default branch)" }, start_line: { type: "integer", description: "Optional first line to show (1-based) for a long file" }, end_line: { type: "integer", description: "Optional last line to show (1-based)" } }, ["repo"],
    (a) => `read ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const q = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ""
      const data = await c.api("GET", `/repos/${repo}/contents/${enc(a.path)}${q}`)
      if (Array.isArray(data)) return `Folder ${repo}/${a.path || ""}${a.ref ? ` @ ${a.ref}` : ""}:\n` + data.map((e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}${e.type === "file" ? ` (${e.size} bytes)` : ""}`).join("\n")
      if (data && data.type === "file") {
        if (data.size > 1024 * 1024) return `${data.path} is ${data.size} bytes, too big to show. Open it on GitHub: ${data.html_url}`
        const bytes = Buffer.from(String(data.content || ""), "base64")
        if (bytes.includes(0)) return `${data.path} is a binary file (${data.size} bytes, sha ${String(data.sha).slice(0, 10)}); it cannot be shown as text. Open it on GitHub: ${data.html_url || ""}`.trim()
        return showLines(`${data.path} (sha ${String(data.sha).slice(0, 10)}, ${data.size} bytes)`, bytes.toString("utf8"), a)
      }
      return clip(JSON.stringify(data, null, 2))
    }),

  tool("github_search_code", "Search code on GitHub (optionally inside one repository). Returns file paths and repositories.",
    { query: { type: "string", description: "Words or code to find" }, repo: { type: "string", description: "Optional owner/name to search in" } }, ["query"],
    (a) => `read search ${a.repo || ""}`.trim(),
    async (a, ctx) => {
      const c = gh(ctx)
      const q = `${a.query}${a.repo ? ` repo:${repoOf(a)}` : ""}`
      const data = await c.api("GET", `/search/code?q=${encodeURIComponent(q)}&per_page=30`)
      const items = data.items || []
      return items.length ? `${data.total_count} result(s):\n` + items.map((i) => `${i.repository.full_name}: ${i.path}`).join("\n") : `No code matches "${a.query}"${a.repo ? ` in ${a.repo}` : ""}. Try fewer or different words.`
    }),

  tool("github_issues", "List issues and/or pull requests of a repository (open by default), or search them with words.",
    { repo: repoProp, type: { type: "string", enum: ["issue", "pr", "all"], description: "issue, pr or all (default all)" }, state: { type: "string", enum: ["open", "closed", "all"], description: "default open" }, query: { type: "string", description: "Optional search words" } }, ["repo"],
    (a) => `read ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const state = ["open", "closed", "all"].includes(a.state) ? a.state : "open"
      const kind = a.type === "issue" ? " is:issue" : a.type === "pr" ? " is:pr" : ""
      const q = `repo:${repo}${kind}${state === "all" ? "" : ` is:${state}`} ${a.query || ""}`.trim()
      const data = await c.api("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`)
      const items = data.items || []
      if (!items.length) return `No ${a.type === "pr" ? "pull requests" : a.type === "issue" ? "issues" : "issues or pull requests"} found (${state}) in ${repo}.`
      return items.map((i) => `#${i.number} ${i.pull_request ? "PR" : "issue"} [${i.state}] ${i.title} · by ${i.user && i.user.login} · ${i.comments} comments · updated ${String(i.updated_at).slice(0, 10)}`).join("\n")
    }),

  tool("github_issue", "Read one issue or pull request with its description and comments (for a PR also the changed files).",
    { repo: repoProp, number: { type: "integer", description: "Issue or PR number" } }, ["repo", "number"],
    (a) => `read ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const n = Number(a.number)
      const issue = await c.api("GET", `/repos/${repo}/issues/${n}`)
      const comments = await c.api("GET", `/repos/${repo}/issues/${n}/comments?per_page=50`)
      let out = `#${n} ${issue.pull_request ? "Pull request" : "Issue"} [${issue.state}] ${issue.title}\nby ${issue.user && issue.user.login} · ${issue.html_url}\n\n${issue.body || "(no description)"}`
      if (issue.pull_request) {
        const pr = await c.api("GET", `/repos/${repo}/pulls/${n}`)
        const files = await c.api("GET", `/repos/${repo}/pulls/${n}/files?per_page=100`)
        out += `\n\nBranch ${pr.head && pr.head.ref} → ${pr.base && pr.base.ref} · mergeable: ${pr.mergeable == null ? "unknown" : pr.mergeable} · ${pr.merged ? "merged" : "not merged"}\nChanged files:\n` + files.map((f) => `${f.status} ${f.filename} (+${f.additions} -${f.deletions})`).join("\n")
      }
      if (comments.length) out += "\n\nComments:\n" + comments.map((m) => `— ${m.user && m.user.login} (${String(m.created_at).slice(0, 10)}): ${m.body}`).join("\n")
      return clip(out)
    }),

  tool("github_create_issue", "Open a new issue in a repository.",
    { repo: repoProp, title: { type: "string" }, body: { type: "string", description: "Markdown description" }, labels: { type: "array", items: { type: "string" } } }, ["repo", "title"],
    (a) => `write issue ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const r = await c.api("POST", `/repos/${repo}/issues`, { title: String(a.title), body: a.body || "", ...(Array.isArray(a.labels) && a.labels.length ? { labels: a.labels } : {}) })
      return `Opened issue #${r.number} in ${repo}: ${r.html_url}`
    }),

  tool("github_comment", "Add a comment to an issue or pull request.",
    { repo: repoProp, number: { type: "integer" }, body: { type: "string", description: "Markdown comment" } }, ["repo", "number", "body"],
    (a) => `write comment ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const r = await c.api("POST", `/repos/${repo}/issues/${Number(a.number)}/comments`, { body: String(a.body) })
      return `Commented on #${a.number} in ${repo}: ${r.html_url}`
    }),

  tool("github_create_branch", "Create a new branch in a repository from another branch (default: the default branch).",
    { repo: repoProp, branch: { type: "string", description: "New branch name" }, from: { type: "string", description: "Branch to start from (default: default branch)" } }, ["repo", "branch"],
    (a) => `write branch ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const from = a.from || await defaultBranch(c, repo)
      const ref = await c.api("GET", `/repos/${repo}/git/ref/heads/${enc(from)}`)
      await c.api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: ref.object.sha })
      return `Created branch ${a.branch} from ${from} (${String(ref.object.sha).slice(0, 7)}) in ${repo}. Next: github_write_file on this branch, then github_create_pr.`
    }),

  tool("github_write_file", "Create or update one file in a repository with a commit. Prefer a work branch (github_create_branch) and a pull request; writing to the default branch asks the user first.",
    { repo: repoProp, path: { type: "string" }, content: { type: "string", description: "The whole new file content" }, message: { type: "string", description: "Commit message" }, branch: { type: "string", description: "Branch to commit to (default: the default branch)" } }, ["repo", "path", "content", "message"],
    (a) => `write file ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const def = await defaultBranch(c, repo)
      const branch = a.branch || def
      if (branch === def) await confirmCritical(ctx, `commit "${a.message}" (${a.path}) directly to ${repo}'s default branch ${def}`)
      let sha
      try { sha = (await c.api("GET", `/repos/${repo}/contents/${enc(a.path)}?ref=${encodeURIComponent(branch)}`)).sha } catch (e) { if (e.status !== 404) throw e }
      const r = await c.api("PUT", `/repos/${repo}/contents/${enc(a.path)}`, { message: String(a.message), content: Buffer.from(String(a.content), "utf8").toString("base64"), branch, ...(sha ? { sha } : {}) })
      return `${sha ? "Updated" : "Created"} ${a.path} on ${branch} in ${repo} (commit ${String(r.commit && r.commit.sha).slice(0, 7)}).${branch !== def ? " Next: github_create_pr to propose it." : ""}`
    }),

  tool("github_create_pr", "Open a pull request from one branch into another (default: the default branch).",
    { repo: repoProp, title: { type: "string" }, head: { type: "string", description: "Branch with the changes" }, base: { type: "string", description: "Branch to merge into (default: default branch)" }, body: { type: "string" }, draft: { type: "boolean" } }, ["repo", "title", "head"],
    (a) => `write pr ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      const base = a.base || await defaultBranch(c, repo)
      const r = await c.api("POST", `/repos/${repo}/pulls`, { title: String(a.title), head: String(a.head), base, body: a.body || "", draft: a.draft === true })
      return `Opened pull request #${r.number} (${a.head} → ${base}) in ${repo}: ${r.html_url}`
    }),

  tool("github_merge_pr", "Merge a pull request. Always asks the user first.",
    { repo: repoProp, number: { type: "integer" }, method: { type: "string", enum: ["merge", "squash", "rebase"], description: "default merge" } }, ["repo", "number"],
    (a) => `write merge ${a.repo}`,
    async (a, ctx) => {
      const c = gh(ctx)
      const repo = repoOf(a)
      await confirmCritical(ctx, `merge pull request #${a.number} in ${repo}`)
      const r = await c.api("PUT", `/repos/${repo}/pulls/${Number(a.number)}/merge`, { merge_method: ["merge", "squash", "rebase"].includes(a.method) ? a.method : "merge" })
      return r.merged ? `Merged #${a.number} in ${repo} (${String(r.sha).slice(0, 7)}).` : `GitHub did not merge #${a.number}: ${r.message || "unknown reason"}.`
    }),

  tool("github_api", "Call any other GitHub REST API endpoint (https://docs.github.com/rest) when no other github_ tool fits, e.g. releases, actions runs, labels, collaborators. GET only reads; other methods change things and may ask the user. Deleting, merging, moving/forcing branches or tags, committing files and repository settings always ask (prefer github_create_branch / github_write_file / github_merge_pr).",
    { method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] }, path: { type: "string", description: "API path, e.g. /repos/owner/name/releases" }, body: { type: "object", description: "JSON body for POST/PATCH/PUT" } }, ["method", "path"],
    (a) => (String(a.method || "GET").toUpperCase() === "GET" ? "read api" : `write api ${a.path}`),
    async (a, ctx) => {
      const c = gh(ctx)
      const method = String(a.method || "GET").toUpperCase()
      const p = String(a.path || "")
      if (!p.startsWith("/")) throw new Error('"path" must start with / (for example /repos/owner/name/releases). Nothing was done.')
      // Hard to undo: deleting anything, repository/organisation settings, visibility, transfer, collaborators,
      // merging, moving/forcing refs, committing files (see criticalApi).
      if (criticalApi(method, p)) {
        await confirmCritical(ctx, `${method} ${p}${a.body ? ` with ${JSON.stringify(a.body).slice(0, 200)}` : ""}`)
      }
      const data = await c.api(method, p, method === "GET" ? undefined : a.body || {})
      return data == null ? `${method} ${p}: done (no content).` : clip(JSON.stringify(data, null, 2))
    }),
]

module.exports = { ALL, criticalApi }
