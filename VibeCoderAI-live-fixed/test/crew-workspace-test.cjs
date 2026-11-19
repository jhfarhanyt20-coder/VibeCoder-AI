"use strict"
// Crew helpers that change files get their own workspace; the main agent
// reviews, merges (three-way) or discards. Works with git (worktree) and
// without git (private copy). The user's files and git index stay safe.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const workspaces = require("../core/subagents/workspace")
const crewTools = require("../core/tools/crew")
const { createVibe } = require("../sdk")

const tests = []
const test = (name, fn) => tests.push({ name, fn })
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s) }
const read = (f) => fs.readFileSync(f, "utf8")

function gitRepo() {
  const repo = tmp("vc-crew-repo-")
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "pipe" }).toString()
  g("init", "-q")
  write(path.join(repo, "app.js"), "line1\nline2\nline3\nline4\nline5\n")
  write(path.join(repo, "keep.txt"), "keep\n")
  g("add", "-A")
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  return { repo, g }
}

test("git: a worktree starts from the user's current state, including uncommitted and new files", async () => {
  if (!workspaces.hasGit()) return
  const { repo } = gitRepo()
  write(path.join(repo, "app.js"), "line1\nline2 (uncommitted)\nline3\nline4\nline5\n")
  write(path.join(repo, "notes.md"), "untracked\n")
  const ws = workspaces.create({ dir: repo, id: "t1", home: tmp("vc-crew-home-") })
  assert.equal(ws.mode, "git")
  assert.match(read(path.join(ws.cwd, "app.js")), /uncommitted/)
  assert.equal(read(path.join(ws.cwd, "notes.md")), "untracked\n")
  assert.deepEqual(workspaces.changes(ws), [], "nothing counts as changed at the start")
  workspaces.remove(ws)
  assert.equal(fs.existsSync(ws.root), false)
})

test("git: two helpers change different parts in parallel; both merge cleanly; the user's index is untouched", async () => {
  if (!workspaces.hasGit()) return
  const { repo, g } = gitRepo()
  const home = tmp("vc-crew-home-")
  const a = workspaces.create({ dir: repo, id: "a", home })
  const b = workspaces.create({ dir: repo, id: "b", home })
  write(path.join(a.cwd, "app.js"), "line1 (helper A)\nline2\nline3\nline4\nline5\n")
  write(path.join(b.cwd, "app.js"), "line1\nline2\nline3\nline4\nline5 (helper B)\n")
  write(path.join(b.cwd, "new.js"), "export const b = 1\n")
  assert.equal(read(path.join(repo, "app.js")), "line1\nline2\nline3\nline4\nline5\n", "the project is untouched while helpers work")
  const ra = workspaces.merge(a)
  const rb = workspaces.merge(b)
  assert.deepEqual(ra.conflicts, [])
  assert.deepEqual(rb.conflicts, [])
  assert.equal(read(path.join(repo, "app.js")), "line1 (helper A)\nline2\nline3\nline4\nline5 (helper B)\n", "both helpers' work is combined")
  assert.equal(read(path.join(repo, "new.js")), "export const b = 1\n")
  assert.doesNotMatch(g("status", "--porcelain"), /^[AMD]/m, "nothing was staged in the user's index")
  workspaces.remove(a); workspaces.remove(b)
  assert.equal(g("branch", "--list", "vibe/crew-*").trim(), "", "helper branches are removed")
})

test("git on Windows: CRLF on disk vs LF inside git is not a conflict, and the file keeps CRLF", async () => {
  if (!workspaces.hasGit()) return
  const { repo } = gitRepo()
  const ws = workspaces.create({ dir: repo, id: "eol", home: tmp("vc-crew-home-") })
  // What core.autocrlf does on checkout: same text, Windows line endings.
  write(path.join(repo, "app.js"), "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n")
  write(path.join(ws.cwd, "app.js"), "line1\nline2\nline3\nline4\nline5\nline6 (helper)\n")
  const r = workspaces.merge(ws)
  assert.deepEqual(r.conflicts, [], "line endings alone never make a conflict")
  assert.deepEqual(r.applied, ["app.js"])
  assert.equal(read(path.join(repo, "app.js")), "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6 (helper)\r\n", "the user's CRLF style is kept")
  workspaces.remove(ws)
})

test("git: a real conflict is marked, never silently overwritten", async () => {
  if (!workspaces.hasGit()) return
  const { repo } = gitRepo()
  const ws = workspaces.create({ dir: repo, id: "c", home: tmp("vc-crew-home-") })
  write(path.join(ws.cwd, "app.js"), "line1\nline2 helper\nline3\nline4\nline5\n")
  write(path.join(repo, "app.js"), "line1\nline2 user\nline3\nline4\nline5\n")
  const r = workspaces.merge(ws)
  assert.deepEqual(r.conflicts, ["app.js"])
  const text = read(path.join(repo, "app.js"))
  assert.match(text, /<<<<<<< your version[\s\S]*line2 user[\s\S]*=======[\s\S]*line2 helper[\s\S]*>>>>>>> helper's version/)
  workspaces.remove(ws)
})

test("no git: a private copy (heavy folders skipped); a both-changed file keeps the user's version and saves the helper's beside it", async () => {
  const dir = tmp("vc-crew-plain-")
  write(path.join(dir, "a.txt"), "a\n")
  write(path.join(dir, "b.txt"), "b\n")
  write(path.join(dir, "node_modules", "x.js"), "x")
  const real = workspaces.hasGit
  const ws = (() => {
    // Force copy mode even when git exists: a folder that is not a repo.
    return workspaces.create({ dir, id: "p", home: tmp("vc-crew-home-") })
  })()
  assert.equal(ws.mode, "copy")
  assert.equal(fs.existsSync(path.join(ws.cwd, "node_modules")), false)
  write(path.join(ws.cwd, "a.txt"), "a helper\n")
  write(path.join(ws.cwd, "b.txt"), "b helper\n")
  write(path.join(dir, "b.txt"), "b user\n")
  write(path.join(ws.cwd, "c.txt"), "new\n")
  const r = workspaces.merge(ws)
  assert.equal(read(path.join(dir, "a.txt")), "a helper\n", "untouched by the user: helper's version")
  assert.equal(read(path.join(dir, "c.txt")), "new\n")
  if (real()) assert.deepEqual(r.conflicts, ["b.txt"], "with git available a line merge marks the conflict")
  else assert.equal(r.kept[0].path, "b.txt")
  workspaces.remove(ws)
})

test("Crew: writer helpers get an own workspace, readers share; merge/discard through the engine and the agent tools", async () => {
  const home = tmp("vc-crew-eng-")
  const dir = tmp("vc-crew-proj-")
  write(path.join(dir, "main.txt"), "hello\n")
  const vibe = createVibe({ home, permission: "allow" })
  const e = vibe.engine
  e.subagentsEnabled = true
  // An unreachable local model: helpers start, wait on the network like a real
  // run, then fail — enough to exercise their workspaces without a real model.
  await vibe.profiles.upsert({ id: "offline", format: "openai-chat", baseURL: "http://127.0.0.1:9/v1", model: "m", noAuth: true, contextLimit: 8000 })
  const parent = e.store.create({ dir, profile: "offline" })
  const writer = e.subagents.create({ sessionId: parent.id, type: "write", task: "edit main.txt", background: true })
  const reader = e.subagents.create({ sessionId: parent.id, type: "read", task: "read things", background: true })
  assert.notEqual(writer.workspace.mode, "shared", "writer works in its own copy")
  assert.equal(reader.workspace.mode, "shared", "reader shares the folder")
  // Simulate the helper's edit inside its workspace while it is still running.
  const ws = e.subagents._get(writer.id).workspaceState
  write(path.join(ws.cwd, "main.txt"), "hello from the helper\n")
  await e.subagents.wait(writer.id) // the fake profile makes the run end quickly
  await e.subagents.wait(reader.id)
  assert.match(e.subagents.result(writer.id).result, /Own workspace: 1 file changed/, "the parent is told what changed, even when the helper failed")
  const ctx = { engine: e }
  const tools = Object.fromEntries(crewTools.ALL.map((t) => [t.name, t]))
  assert.match(await tools.crewChanges.run({ subagentId: writer.id }, ctx), /1 file changed[\s\S]*modified main\.txt/)
  assert.equal(read(path.join(dir, "main.txt")), "hello\n", "not merged yet")
  assert.match(await tools.crewMerge.run({ subagentId: writer.id }, ctx), /Merged 1 of 1 file/)
  assert.equal(read(path.join(dir, "main.txt")), "hello from the helper\n")
  assert.equal(e.subagents.status(writer.id).workspace.state, "merged")
  assert.equal(fs.existsSync(ws.root), false, "workspace removed after merge")
  // A second helper is discarded: the project stays as it is.
  const w2 = e.subagents.create({ sessionId: parent.id, type: "write", task: "x", background: true })
  write(path.join(e.subagents._get(w2.id).workspaceState.cwd, "main.txt"), "nope\n")
  await e.subagents.wait(w2.id)
  assert.match(await tools.crewDiscard.run({ subagentId: w2.id }, ctx), /Discarded/)
  assert.equal(read(path.join(dir, "main.txt")), "hello from the helper\n")
  // Deleting the chat removes any open workspace.
  const w3 = e.subagents.create({ sessionId: parent.id, type: "write", task: "y", background: true })
  write(path.join(e.subagents._get(w3.id).workspaceState.cwd, "extra.txt"), "x\n")
  await e.subagents.wait(w3.id)
  const root3 = e.subagents._get(w3.id).workspaceState.root
  // A helper that changed nothing leaves no workspace behind.
  const w4 = e.subagents.create({ sessionId: parent.id, type: "write", task: "z", background: true })
  const root4 = e.subagents._get(w4.id).workspaceState.root
  await e.subagents.wait(w4.id)
  assert.equal(fs.existsSync(root4), false, "an empty workspace is removed at once")
  assert.equal(e.subagents.status(w4.id).workspace.state, "unchanged")
  e.removeSession(parent.id)
  assert.equal(fs.existsSync(root3), false, "workspaces go away with the chat")
  // The tools are offered to the agent with Crew.
  assert(e.extraTools(dir).some((t) => t.name === "crewMerge"))
})

;(async () => {
  let passed = 0
  for (const t of tests) {
    try { await t.fn(); passed++; console.log(`PASS crew workspace: ${t.name}`) }
    catch (err) { console.error(`FAIL crew workspace: ${t.name}`); console.error(err); process.exitCode = 1 }
  }
  console.log(`${passed}/${tests.length} crew workspace tests passed`)
  if (passed !== tests.length) process.exit(1)
})()
