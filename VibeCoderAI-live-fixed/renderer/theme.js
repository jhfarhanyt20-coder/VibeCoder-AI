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
    if (resolved === "amoled" || resolved === "light" || resolved === "dark") {
      document.documentElement.dataset.theme = resolved
    }
    var scale = localStorage.getItem("vibecoder.fontScale")
    if (scale && Number(scale) > 0) {
      document.documentElement.style.setProperty("--fs-scale", String(scale))
    }
  } catch (e) {
    /* the default theme is fine */
  }
})()
