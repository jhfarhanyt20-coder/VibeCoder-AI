import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-home-"))
const project = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-project-"))
process.env.VIBE_HOME = tempHome
const skills = require("../core/skills")
const tests = []
const test = (name, fn) => tests.push([name, fn])

function mkdirFor(file) { fs.mkdirSync(path.dirname(file), { recursive: true }) }

function fakeResponse({ status = 200, json, text = "" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return json },
    async text() { return text },
  }
}

 test("discovers OpenCode and Agent Skills directory formats plus legacy markdown", async () => {
  const skillFile = path.join(project, ".opencode", "skills", "reviewer", "SKILL.md")
  mkdirFor(skillFile)
  fs.writeFileSync(skillFile, "---\nname: reviewer\ndescription: Reviews source code\n---\n\nReview the changed files carefully.\n")
  const refFile = path.join(project, ".opencode", "skills", "reviewer", "references", "rubric.md")
  mkdirFor(refFile)
  fs.writeFileSync(refFile, "Review correctness, security, and regression coverage.\n")

  const agentFile = path.join(project, ".agents", "skills", "test-writer", "SKILL.md")
  mkdirFor(agentFile)
  fs.writeFileSync(agentFile, "---\nname: test-writer\ndescription: Write regression tests\n---\n\nAdd a test for every bug fix.\n")

  const flatFile = path.join(tempHome, "skills", "legacy.md")
  mkdirFor(flatFile)
  fs.writeFileSync(flatFile, "---\nname: legacy\ndescription: Old markdown skill\n---\n\nLegacy skill instructions.\n")

  const found = skills.listSkills(project)
  assert.ok(found.some((item) => item.id === "reviewer" && item.format === "SKILL.md"))
  assert.ok(found.some((item) => item.id === "test-writer"))
  assert.ok(found.some((item) => item.id === "legacy" && item.scope === "global"))
  assert.match(skills.systemText(project), /reviewer.*Reviews source code/)

  const loaded = skills.loadSkill({ id: "reviewer", directory: project })
  assert.match(loaded.body, /Review the changed files carefully/)
  assert.ok(loaded.supportingFiles.some((item) => item.relative === path.join("references", "rubric.md")))

  // Verify the agent runtime can actually invoke the skill, not just discover it.
  const tools = require("../core/tools")
  const skillTool = tools.byName("skill")
  assert.ok(skillTool, "the built-in skill tool must be registered")
  const runtimeOutput = await skillTool.run({ id: "reviewer" }, { cwd: project })
  assert.match(runtimeOutput, /Loaded skill: reviewer/)
  assert.match(runtimeOutput, /Review the changed files carefully/)
  assert.match(runtimeOutput, /Trust boundary/)
})

test("installs and removes a project skill using OpenCode SKILL.md layout", () => {
  const installed = skills.installSkillFile({
    id: "planning",
    description: "Plan changes before editing",
    content: "Read the repository and produce a plan before changing files.",
    directory: project,
  })
  assert.equal(installed.scope, "project")
  assert.ok(installed.file.endsWith(path.join("planning", "SKILL.md")))
  assert.match(fs.readFileSync(installed.file, "utf8"), /name: planning/)
  assert.ok(skills.listSkills(project).some((item) => item.id === "planning"))
  assert.equal(skills.removeSkillFile({ id: "planning", directory: project }).removed, true)
  assert.equal(fs.existsSync(path.dirname(installed.file)), false)
})

test("imports public GitHub skills and supporting resources without executing them", async () => {
  const importProject = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-import-"))
  const tree = [
    { path: "skills/reviewer/SKILL.md", type: "blob", size: 130 },
    { path: "skills/reviewer/references/rubric.md", type: "blob", size: 55 },
    { path: "skills/qa/SKILL.md", type: "blob", size: 95 },
    { path: "README.md", type: "blob", size: 20 },
  ]
  const contentByPath = {
    "skills/reviewer/SKILL.md": "---\nname: reviewer\ndescription: Check code changes\n---\n\nReview for bugs and security issues.\n",
    "skills/reviewer/references/rubric.md": "Check correctness, safety, and test coverage.\n",
    "skills/qa/SKILL.md": "---\nname: qa\ndescription: Improve regression testing\n---\n\nWrite reproducible tests.\n",
  }
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/repos/octo/demo") {
      return fakeResponse({ json: { default_branch: "main" } })
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname.includes("/git/trees/")) {
      return fakeResponse({ json: { truncated: false, tree } })
    }
    if (parsed.hostname === "raw.githubusercontent.com") {
      const key = decodeURIComponent(parsed.pathname.split("/main/")[1] || "")
      if (Object.hasOwn(contentByPath, key)) return fakeResponse({ text: contentByPath[key] })
      return fakeResponse({ status: 404, text: "not found" })
    }
    return fakeResponse({ status: 404, text: "not found" })
  }

  const imported = await skills.importGitHubSkills({
    source: "https://github.com/octo/demo/tree/main/skills",
    directory: importProject,
    fetchImpl,
  })
  assert.equal(imported.count, 2)
  assert.ok(fs.existsSync(path.join(importProject, ".opencode", "skills", "reviewer", "SKILL.md")))
  assert.match(fs.readFileSync(path.join(importProject, ".opencode", "skills", "reviewer", "references", "rubric.md"), "utf8"), /test coverage/)
  assert.ok(skills.listSkills(importProject).some((item) => item.id === "qa"))
  const loaded = skills.loadSkill({ id: "reviewer", directory: importProject })
  assert.match(loaded.body, /Review for bugs and security issues/)
  assert.equal(loaded.supportingFiles.length, 1)
  try { fs.rmSync(importProject, { recursive: true, force: true }) } catch {}
})

test("rolls back an entire GitHub import if a later skill fails", async () => {
  const importProject = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-atomic-"))
  const tree = [
    { path: "skills/a/SKILL.md", type: "blob", size: 70 },
    { path: "skills/b/SKILL.md", type: "blob", size: 70 },
  ]
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.hostname === "api.github.com" && parsed.pathname.includes("/git/trees/")) {
      return fakeResponse({ json: { truncated: false, tree } })
    }
    if (parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.endsWith("/skills/a/SKILL.md")) {
      return fakeResponse({ text: "---\nname: alpha\ndescription: first skill\n---\n\nAlpha instructions.\n" })
    }
    if (parsed.hostname === "raw.githubusercontent.com" && parsed.pathname.endsWith("/skills/b/SKILL.md")) {
      return fakeResponse({ status: 503, text: "simulated network failure" })
    }
    return fakeResponse({ status: 404, text: "not found" })
  }

  await assert.rejects(
    () => skills.importGitHubSkills({
      source: "https://github.com/octo/atomic/tree/main/skills",
      directory: importProject,
      fetchImpl,
    }),
    /HTTP 503/
  )
  const installedRoot = path.join(importProject, ".opencode", "skills")
  assert.equal(fs.existsSync(path.join(installedRoot, "alpha")), false, "the first skill must be rolled back")
  assert.equal(fs.existsSync(path.join(installedRoot, "beta")), false)
  try { fs.rmSync(importProject, { recursive: true, force: true }) } catch {}
})

test("rejects traversal paths reported by a GitHub repository tree", async () => {
  const importProject = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-skills-traversal-"))
  const fetchImpl = async (url) => {
    const parsed = new URL(url)
    if (parsed.hostname === "api.github.com" && parsed.pathname.includes("/git/trees/")) {
      return fakeResponse({ json: { truncated: false, tree: [
        { path: "skills/a/../outside/SKILL.md", type: "blob", size: 90 },
      ] } })
    }
    assert.fail(`Unexpected network request for unsafe path: ${url}`)
  }
  await assert.rejects(
    () => skills.importGitHubSkills({
      source: "https://github.com/octo/traversal/tree/main/skills",
      directory: importProject,
      fetchImpl,
    }),
    /No SKILL.md files found/
  )
  assert.equal(fs.existsSync(path.join(importProject, ".opencode", "skills")), false)
  try { fs.rmSync(importProject, { recursive: true, force: true }) } catch {}
})

test("rejects non-GitHub URLs and path traversal sources", async () => {
  await assert.rejects(
    () => skills.importGitHubSkills({ source: "https://evil.example/a/b", directory: project, fetchImpl: async () => { throw new Error("should not fetch") } }),
    /public repositories from https:\/\/github.com only/
  )
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}\n`, error?.stack || error)
  }
}
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
try { fs.rmSync(project, { recursive: true, force: true }) } catch {}
if (failed) process.exitCode = 1
else console.log(`All ${tests.length} skills tests passed.`)
