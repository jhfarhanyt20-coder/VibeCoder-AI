"use strict"
/**
 * Keep the native Windows window controls, but paint the title-bar overlay
 * with the app's own theme colours. This works on Windows 10 and Windows 11;
 * DWMWA_CAPTION_COLOR is Windows 11 only, so it is not used.
 */
function normalizeColor(value, fallback) {
  const text = String(value || "").trim()
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback
}

function setWindowTheme(win, theme = {}) {
  if (process.platform !== "win32") return
  if (!win || win.isDestroyed || win.isDestroyed()) return
  const color = normalizeColor(theme.caption, "#0b0d12")
  // The title strip and buttons are renderer-drawn. Keep the native window
  // background in sync so resize flashes and rounded-corner gutters match.
  try {
    win.setBackgroundColor(color)
  } catch {}
}

module.exports = { setWindowTheme, normalizeColor }
