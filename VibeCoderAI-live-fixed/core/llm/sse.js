"use strict"
/** Parse a fetch() response body (Server-Sent Events) into {event, data} objects. */
function parseBlock(raw) {
  let event = "message"
  const data = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue
    const i = line.indexOf(":")
    const field = i < 0 ? line : line.slice(0, i)
    let value = i < 0 ? "" : line.slice(i + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  return data.length ? { event, data: data.join("\n") } : null
}

/* A provider that opens the stream and then says nothing made the agent look dead
   for the whole watchdog window. Treat a long silence as a dropped stream so the
   run fails fast and the client auto-retries it. */
const IDLE_TIMEOUT_MS = 120000
/* Cap for the "was this even SSE?" capture below. */
const RAW_CAP = 2 * 1024 * 1024

async function* parseSSE(body, { idleMs = IDLE_TIMEOUT_MS } = {}) {
  const dec = new TextDecoder()
  const sep = /\r?\n\r?\n/
  let buf = ""
  // A gateway that ignores stream:true (or an error page / JSON error sent with
  // HTTP 200) answers with a plain body that has no "data:" framing. The old
  // parser dropped it silently -> the run ended with NO text and NO error
  // ("the LLM response never comes"). Remember the raw body while nothing has
  // been parsed, and hand it to the adapter as one {event:"raw"} at the end.
  let yielded = 0
  let raw = ""
  const it = body[Symbol.asyncIterator]()
  for (;;) {
    let timer = null
    let next
    try {
      next = await Promise.race([
        it.next(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`The provider stopped sending data (${Math.round(idleMs / 1000)}s of silence).`)), idleMs)
        }),
      ])
    } catch (e) {
      // the iterator holds the stream lock, so cancel() rejects (not throws) - swallow it
      try {
        if (typeof body.cancel === "function") Promise.resolve(body.cancel()).catch(() => {})
      } catch {}
      throw e
    } finally {
      clearTimeout(timer)
    }
    if (next.done) break
    const chunk = next.value
    const piece = typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true })
    buf += piece
    if (!yielded && raw.length < RAW_CAP) raw += piece
    let m
    while ((m = sep.exec(buf))) {
      const block = buf.slice(0, m.index)
      buf = buf.slice(m.index + m[0].length)
      const ev = parseBlock(block)
      if (ev) {
        yielded++
        yield ev
      }
    }
  }
  buf += dec.decode()
  if (buf.trim()) {
    const ev = parseBlock(buf)
    if (ev) {
      yielded++
      yield ev
    }
  }
  if (!yielded && raw.trim()) yield { event: "raw", data: raw.trim() }
}

module.exports = { parseSSE, parseBlock }
