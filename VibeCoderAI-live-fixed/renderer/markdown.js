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

  // URL attributes in model/user HTML. This page is file://, so a scheme-
  // relative "//host/x.png" (or "\\host\x") resolves to file://host/... - a
  // Windows UNC path that makes the OS try SMB and leak the NTLM hash. Only
  // plain web links survive: http(s)/mailto for links, http(s)/data:image for
  // images, and relative paths that stay on this page's own (empty) host.
  const URL_ATTRS = new Set(["src", "href", "srcset", "xlink:href", "poster", "action", "formaction", "background", "cite", "data"])
  const LINK_SCHEMES = new Set(["http", "https", "mailto"])
  const IMAGE_SCHEMES = new Set(["http", "https"])
  const IMAGE_TAGS = new Set(["img", "image", "source", "picture", "video", "audio", "track", "input"])

  function unsafeUrlValue(value, isImage) {
    // browsers drop ASCII whitespace/control characters inside URLs
    const v = String(value == null ? "" : value).replace(/[\u0000-\u0020\u007f]/g, "")
    if (!v) return false
    if (/^[\\/]{2}/.test(v)) return true // //host or \\host: network path
    if (/^%5c/i.test(v) || /^[\\/]%5c/i.test(v)) return true
    const m = v.match(/^([a-z][a-z0-9+.-]*):/i)
    if (!m) return false // relative to this page: no host
    const scheme = m[1].toLowerCase()
    if (isImage) {
      if (scheme === "data") return !/^data:image\/(png|gif|jpe?g|webp|bmp|avif)[;,]/i.test(v)
      return !IMAGE_SCHEMES.has(scheme)
    }
    return !LINK_SCHEMES.has(scheme)
  }

  /** true when attribute `name` on tag `tag` carries a URL that must be dropped */
  function unsafeUrlAttribute(tag, name, value) {
    const attr = String(name || "").toLowerCase()
    if (!URL_ATTRS.has(attr)) return false
    const isImage = IMAGE_TAGS.has(String(tag || "").toLowerCase()) && attr !== "href"
    if (attr === "srcset") {
      return String(value == null ? "" : value)
        .split(",")
        .some((part) => unsafeUrlValue(part.trim().split(/\s+/)[0], true))
    }
    return unsafeUrlValue(value, isImage || attr === "poster" || attr === "background")
  }

  let hooked = false
  function installHooks(purify) {
    if (hooked || !purify || typeof purify.addHook !== "function") return
    hooked = true
    purify.addHook("uponSanitizeAttribute", (node, data) => {
      if (data && unsafeUrlAttribute(node && node.nodeName, data.attrName, data.attrValue)) data.keepAttr = false
    })
    // second line of defence after DOMPurify's own URI checks
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (!node || !node.attributes) return
      for (const attr of Array.from(node.attributes)) {
        if (unsafeUrlAttribute(node.nodeName, attr.name, attr.value)) node.removeAttribute(attr.name)
      }
    })
  }

  function renderMarkdown(text) {
    if (text === null || text === undefined) return ""
    const src = String(text)
    if (!src) return ""

    try {
      if (window.marked && window.DOMPurify) {
        installHooks(window.DOMPurify)
        const html = window.marked.parse(src, { async: false, breaks: true })
        // RETURN_DOM_FRAGMENT: never serialize back to a string, so no
        // style="…" attribute can reach the DOM and trip style-src 'self'.
        return window.DOMPurify.sanitize(html, {
          RETURN_DOM_FRAGMENT: true,
          // Keep links useful but harmless: they are opened externally by main.
          ADD_ATTR: ["target", "rel"],
          FORBID_TAGS: ["style", "form", "input", "button", "iframe", "object", "embed"],
          // id/name: model HTML must not clobber the app's own element ids
          // (marked v14 emits no heading ids, so nothing in chat relies on them)
          FORBID_ATTR: ["style", "onerror", "onload", "id", "name"],
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
  window.__vibeMarkdownUrlGuard = { unsafeUrlAttribute, unsafeUrlValue }
})()
