"use strict"
const { stripVTControlCharacters } = require("node:util")

const THEMES = {
  obsidian: { name: "Obsidian", background: "#101114", surface: "#1b1d23", subtle: "#24272f", selection: "#433425", onSelection: "#fbe6d1", accent: "#e7ae78", text: "#eceef4", muted: "#a0a6b3", border: "#687182", success: "#9bd5af", warning: "#e7c486", error: "#f4a1a5" },
  dark: { name: "Dark", background: "#111725", surface: "#192235", subtle: "#243148", selection: "#2b3e5d", onSelection: "#edf3ff", accent: "#aecbff", text: "#e7edf8", muted: "#9baec6", border: "#6f87a5", success: "#9eddbb", warning: "#f0d094", error: "#ffabab" },
  light: { name: "Light", background: "#f4f6fa", surface: "#e8edf4", subtle: "#dce3ed", selection: "#d2dfef", onSelection: "#192338", accent: "#7b461e", text: "#192338", muted: "#516077", border: "#66758b", success: "#246e43", warning: "#80530e", error: "#a82a37" },
  amoled: { name: "AMOLED", background: "#000000", surface: "#101012", subtle: "#202024", selection: "#403426", onSelection: "#fff0d8", accent: "#f2c387", text: "#ffffff", muted: "#b0b0b6", border: "#85858d", success: "#a1dfb7", warning: "#f3d79e", error: "#ffabab" },
  system: { name: "System", accent: 36, text: 39, muted: 90, border: 90, success: 32, warning: 33, error: 31 },
}
let current = "obsidian"
let output = process.stdout
let enabled = null

function safeText(value) {
  return stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}
function colorEnabled(out = output) {
  return enabled !== false && !!out.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"
}
function configureTheme(name, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(THEMES, name)) throw new Error(`Unknown theme "${name}". Choose ${Object.keys(THEMES).join(", ")}.`)
  current = name
  output = options.output || output
  if (options.color !== undefined) enabled = options.color
  return name
}
function ansiColor(value, background = false) {
  if (typeof value === "number") return background ? value + 10 : value
  const rgb = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16))
  const depth = output.getColorDepth?.() || (process.env.COLORTERM === "truecolor" || process.env.WT_SESSION ? 24 : 4)
  if (depth >= 24) return (background ? "48;2;" : "38;2;") + rgb.join(";")
  if (depth >= 8) return (background ? "48;5;" : "38;5;") + (16 + 36 * Math.round(rgb[0] / 51) + 6 * Math.round(rgb[1] / 51) + Math.round(rgb[2] / 51))
  const min = Math.min(...rgb), max = Math.max(...rgb)
  if (max - min <= 35) return (max < 90 ? 30 : max < 155 ? 90 : max < 210 ? 37 : 97) + (background ? 10 : 0)
  const high = rgb.map((n) => n >= (min + max) / 2 ? 1 : 0)
  return (max > 180 ? 90 : 30) + high[0] + high[1] * 2 + high[2] * 4 + (background ? 10 : 0)
}
function paint(code, value) {
  const text = safeText(value)
  const bg = THEMES[current].background ? ";" + ansiColor(THEMES[current].background, true) : ""
  return colorEnabled() ? `\x1b[${code}${bg}m${text}\x1b[0m` : text
}
function role(name, value) { return paint(ansiColor(THEMES[current][name] || THEMES[current].text), value) }
const c = {
  dim: (s) => role("muted", s), bold: (s) => paint(1, s),
  red: (s) => role("error", s), green: (s) => role("success", s), yellow: (s) => role("warning", s),
  blue: (s) => role("accent", s), magenta: (s) => role("accent", s), cyan: (s) => role("accent", s),
  accent: (s) => role("accent", s), border: (s) => role("border", s), text: (s) => role("text", s),
  invert: (s) => paint(7, s),
}

function providerName(profile, profiles = []) {
  const root = profile?.derivedFrom ? profiles.find((p) => p.id === profile.derivedFrom) || profile : profile
  return safeText(root?.name || root?.label || root?.id || "Select provider")
}
function selectedProfile(value, profiles) {
  const exact = profiles.find((p) => p.id === value)
  if (exact) return exact
  const root = profiles.filter((p) => value?.startsWith(p.id + "/")).sort((a, b) => b.id.length - a.id.length)[0]
  if (!root) return null
  const modelID = value.slice(root.id.length + 1)
  const model = (root.models || []).find((m) => m.id === modelID)
  return { ...root, model: modelID, contextLimit: model?.context || root.contextLimit, maxOutput: model?.output || root.maxOutput }
}

const screenPalette = () => current === "system" ? { ...THEMES.obsidian, name: "System", background: "#000000", surface: "#101012", accent: "#d9d9df", system: true } : THEMES[current]
function screenStyle(style = {}) {
  const palette = screenPalette()
  const fg = style.fg || "text", bg = style.bg || "background"
  const depth = output.getColorDepth?.() || (process.env.COLORTERM === "truecolor" || process.env.WT_SESSION ? 24 : 4)
  if (process.env.NO_COLOR !== undefined) return `\x1b[0;37;40${style.bold ? ";1" : ""}m`
  if (depth < 8 || palette.system) {
    const light = current === "light"
    const foreground = { text: light ? 30 : 97, muted: light ? 30 : 37, border: light ? 30 : 90, accent: light ? 34 : 93, success: light ? 32 : 92, warning: light ? 33 : 93, error: light ? 31 : 91, onSelection: light ? 30 : 97 }[fg] || (light ? 30 : 97)
    const background = bg === "selection" ? (light ? 47 : 100) : light ? 107 : 40
    return `\x1b[0;${foreground};${background}${style.bold ? ";1" : ""}m`
  }
  return `\x1b[0;${ansiColor(palette[fg] || palette.text)};${ansiColor(palette[bg] || palette.background, true)}${style.bold ? ";1" : ""}m`
}

module.exports = { THEMES, c, configureTheme, colorEnabled, safeText, providerName, selectedProfile, screenPalette, screenStyle, currentTheme: () => current }
