// Set the theme before the first paint (otherwise the app flashes in the
// default theme for a moment). Kept in its own file because the app's
// Content-Security-Policy does not allow inline scripts.
(function () {
  try {
    var pref = localStorage.getItem("vibecoder.theme") || "dark"
    var resolved = pref
    if (pref === "system") {
      var light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      resolved = light ? "light" : "dark"
    }
    if (resolved === "obsidian" || resolved === "amoled" || resolved === "light" || resolved === "dark") {
      document.documentElement.dataset.theme = resolved
    }
    var savedFont = Number(localStorage.getItem("vibecoder.fontScale"))
    if (Number.isFinite(savedFont) && savedFont > 0) {
      // Accept both the old ratio format and the new displayed-pixel format.
      var px = savedFont < 4 ? savedFont * 14 : savedFont
      px = Math.min(18, Math.max(12, Math.round(px)))
      document.documentElement.style.setProperty("--fs-scale", String(px / 14))
    }
  } catch (e) {
    /* the default theme is fine */
  }
})()
