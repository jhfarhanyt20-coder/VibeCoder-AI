// Safe markdown rendering for the sandboxed renderer.
//
// marked + DOMPurify are loaded as plain <script> tags from renderer/vendor,
// because the preload runs with sandbox: true and cannot require npm modules.
// Everything user/model generated is sanitized before it reaches innerHTML.
//
// The renderer CSP is style-src 'self': no inline style attributes anywhere.
// DOMPurify's default string output re-serializes style attributes it stripped
// nothing from (e.g. white-space on code blocks), which the CSP blocks and
// logs. So sanitize straight into a detached DOM fragment and insert that —
// all styling comes from the stylesheets.
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
        // RETURN_DOM_FRAGMENT: never serialize back to a string, so no
        // style="…" attribute can reach the DOM and trip style-src 'self'.
        return window.DOMPurify.sanitize(html, {
          RETURN_DOM_FRAGMENT: true,
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

  // Insert renderMarkdown() output. Callers must use this instead of
  // `.innerHTML =` so the DOM-fragment result is inserted without a
  // serialize/reparse round-trip (which is where inline styles reappear).
  function renderMarkdownInto(el, text) {
    const out = renderMarkdown(text)
    if (out instanceof window.Node) el.replaceChildren(out)
    else el.innerHTML = out
  }

  window.renderMarkdown = renderMarkdown
  window.renderMarkdownInto = renderMarkdownInto
})()
