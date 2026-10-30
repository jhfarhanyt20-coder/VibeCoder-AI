"use strict"
const crypto = require("crypto")
const os = require("os")
const path = require("path")

const newId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`
/**
 * Rough token estimate for compaction triggers. Latin text is ~4 chars/token,
 * but CJK/Bengali/Thai etc. cost ~1 token per char - plain /4 badly
 * underestimated them and let over-full requests reach the provider (400).
 */
function estimateTokens(s) {
  const str = String(s == null ? "" : s)
  let wide = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c > 0x2e7f || (c >= 0x0900 && c <= 0x0dff) || (c >= 0x0e00 && c <= 0x0e7f)) wide++
  }
  return Math.ceil((str.length - wide) / 4 + wide * 0.9)
}
const homeDir = () => process.env.VIBE_HOME || path.join(os.homedir(), ".vibe")
const toPosix = (p) => String(p).replace(/\\/g, "/")

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error("aborted"))
    const t = setTimeout(resolve, ms)
    if (signal)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t)
          reject(new Error("aborted"))
        },
        { once: true },
      )
  })
}

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")

/** Glob -> RegExp. Supports **, *, ?, {a,b}. Matches against posix paths. */
function globToRegExp(glob) {
  let re = ""
  let i = 0
  const g = toPosix(glob)
  while (i < g.length) {
    const c = g[i]
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 2
        if (g[i] === "/") {
          i++
          re += "(?:.*/)?"
        } else re += ".*"
        continue
      }
      re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else if (c === "{") {
      const end = g.indexOf("}", i)
      if (end > i) {
        re += "(?:" + g.slice(i + 1, end).split(",").map(escapeRe).join("|") + ")"
        i = end + 1
        continue
      }
      re += "\\{"
    } else re += escapeRe(c)
    i++
  }
  return new RegExp("^" + re + "$", process.platform === "win32" ? "i" : "")
}

module.exports = { newId, estimateTokens, homeDir, toPosix, sleep, globToRegExp }
