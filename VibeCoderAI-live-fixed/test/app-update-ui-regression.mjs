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
  "app-update-open-release",
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

assert.match(html, /Open download page/, "manual download page button is missing")
assert.match(app, /async function doAppUpdateCheck/)
assert.match(app, /async function doAppUpdateDownload/)
assert.match(app, /async function doAppUpdateInstall/)
assert.match(app, /const APP_RELEASES_URL = "https:\/\/github\.com\/jhfarhanyt20-coder\/VibeCoder-AI\/releases\/latest"/)
assert.match(app, /if \(downloadBtn\) downloadBtn\.onclick = doAppUpdateDownload/)
assert.match(app, /if \(openReleaseBtn\) openReleaseBtn\.onclick/)
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

console.log("PASS app update UI regression: manual check, download, install and release-page fallback are wired")
