"use strict"
// The renderer's main script is split into ordered files: renderer/app.js
// first, then renderer/app/*.js in the order index.html loads them. They run
// as classic scripts that share one global scope, so joined in that order they
// are exactly the old single app.js. Tests that inspect the renderer source
// read it through here instead of renderer/app.js alone.
const fs = require("node:fs")
const path = require("node:path")

const renderer = path.join(__dirname, "..", "renderer")

/** The app script files, in load order (paths relative to renderer/). */
function appScriptFiles() {
  const html = fs.readFileSync(path.join(renderer, "index.html"), "utf8")
  const files = []
  for (const m of html.matchAll(/<script\s+src="([^"]+)"\s*><\/script>/g)) {
    if (m[1] === "app.js" || /^app\/[\w.-]+\.js$/.test(m[1])) files.push(m[1])
  }
  if (!files.length || files[0] !== "app.js") throw new Error("index.html must load app.js before its parts in app/")
  return files
}

/** The whole renderer app source, joined in load order. */
function rendererAppSource() {
  return appScriptFiles().map((f) => fs.readFileSync(path.join(renderer, f), "utf8")).join("")
}

module.exports = rendererAppSource
module.exports.appScriptFiles = appScriptFiles
module.exports.rendererAppSource = rendererAppSource
