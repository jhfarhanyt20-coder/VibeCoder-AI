// Safe markdown rendering for the sandboxed renderer.
//
// marked + DOMPurify are loaded as plain <script> tags from renderer/vendor,
// because the preload runs with sandbox: true and cannot require npm modules.
// Everything user/model generated is sanitized before it reaches innerHTML.
;(function () {
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c])
  }

  function renderMarkdown(text) {
    if (text === null || text === undefined) return ""
    const src = String(text)
    if (!src) return ""

    try {
      if (window.marked && window.DOMPurify) {
        const html = window.marked.parse(src, { async: false, breaks: true })
        return window.DOMPurify.sanitize(html, {
          // Keep links useful but harmless: they are opened externally by main.
          ADD_ATTR: ["target", "rel"],
          FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
          FORBID_ATTR: ["style", "onerror", "onload"],
        })
      }
    } catch {
      // Fall through to plain text below.
    }

    return escapeHtml(src).replace(/\r?\n/g, "<br>")
  }

  window.renderMarkdown = renderMarkdown
})()
