import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")
const html = read("renderer/index.html")
const app = read("renderer/app.js")
const updater = read("electron/updater.cjs")

for (const id of [
  "app-update-check",
  "app-update-action-card",
  "app-update-available-row",
  "app-update-download",
  "app-update-dismiss",
  "app-update-progress-row",
  "app-update-install-row",
  "app-update-install",
  "app-update-error-row",
  "app-update-retry",
]) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `missing App Updates element ${id}`)
}

assert.match(html, /Update Now/, "the in-app update button is missing")
assert.match(html, /download starts inside the app/i, "the update copy must describe the in-app download")
assert.doesNotMatch(html, /Open download page|app-update-open-release/, "manual update must not send users to a web page")
assert.doesNotMatch(app, /releases\/latest|openReleaseBtn/, "manual update must stay inside the app")
assert.match(app, /async function doAppUpdateCheck/)
assert.match(app, /async function doAppUpdateDownload/)
assert.match(app, /async function doAppUpdateInstall/)
assert.match(app, /if \(downloadBtn\) downloadBtn\.onclick = doAppUpdateDownload/)
assert.match(app, /btn\.textContent = "Update Now"/)
assert.match(app, /s\.state === "update-available"/)
assert.match(app, /showAppUpdateRow\("app-update-available-row", s\.state === "update-available"\)/)
assert.match(app, /ev\.type === "download-progress" \? "downloading"/)
assert.match(app, /appUpdateState\.state = "downloading"/)
assert.match(app, /appUpdateState\.payload = \{ \.\.\.\(appUpdateState\.payload \|\| \{\}\), \.\.\.\(ev\.payload \|\| \{\}\) \}/)
assert.match(updater, /const previousAutoDownload = au\.autoDownload/)
assert.doesNotMatch(updater, /prefs\.autoDownload = true/, "manual download must not change the saved preference")
assert.match(updater, /au\.autoDownload = previousAutoDownload/)

const syntax = spawnSync(process.execPath, ["--check", path.join(root, "renderer", "app.js")], { encoding: "utf8" })
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout)

console.log("PASS app update UI regression: manual check, in-app Update Now download and Install & Restart are wired")
