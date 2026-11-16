"use strict"
const fs = require("node:fs")
const path = require("node:path")
const { safeText } = require("./theme")
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" }
const TEXT_LIMIT = 200 * 1024
const TOTAL_LIMIT = 10 * 1024 * 1024

function expandFileMentions(text, dir) {
  const files = [], missing = [], inlined = [], seen = new Set()
  let total = 0
  const next = String(text || "").replace(/(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s]+))/g, (match, lead, double, single, plain) => {
    const relative = double || single || plain
    const file = path.resolve(dir, relative)
    if (seen.has(file)) return match
    let stat
    try { stat = fs.statSync(file) } catch { missing.push(relative); return match }
    if (!stat.isFile()) { missing.push(relative + " (not a file)"); return match }
    if (inlined.length >= 16 || total + stat.size > TOTAL_LIMIT) { missing.push(relative + " (attachment budget exceeded)"); return match }
    const mime = MIME[path.extname(file).toLowerCase()]
    if (!mime && stat.size > TEXT_LIMIT) { missing.push(relative + " (larger than 200 KB)"); return match }
    try {
      const data = fs.readFileSync(file)
      if (mime) {
        const base64 = data.toString("base64")
        // Engine image parts require raw base64, not a nested data URL.
        files.push({ name: path.basename(file), mime, data: base64, dataUrl: `data:${mime};base64,${base64}` })
        inlined.push({ path: relative, kind: "image" })
      } else {
        if (data.includes(0)) { missing.push(relative + " (binary file)"); return match }
        const body = data.toString("utf8")
        const label = safeText(relative).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        inlined.push({ path: relative, kind: "text" })
        total += stat.size
        seen.add(file)
        return `${lead}${relative}\n\n<file path="${label}">\n${body}\n</file>`
      }
      total += stat.size
      seen.add(file)
    } catch { missing.push(relative) }
    return match
  })
  return { text: next, files, missing, inlined }
}

module.exports = { expandFileMentions, TEXT_LIMIT, TOTAL_LIMIT }
