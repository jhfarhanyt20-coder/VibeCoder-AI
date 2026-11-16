"use strict"
const { EventEmitter } = require("node:events")
const { createRenderer } = require("./ui")

function closeEngine(vibe) {
  if (!vibe.engine) return
  for (const timer of vibe.engine.shellResumeTimers.values()) clearTimeout(timer)
  vibe.engine.shellResumeTimers.clear()
  for (const state of vibe.engine.mcp.clients.values()) {
    try { state.client?.close?.() } catch {}
  }
  vibe.engine.mcp.clients.clear()
  vibe.engine.extensions.close()
}

async function stopSessionWork(vibe, id) {
  const state = await vibe.control.call("session.state", { sessionId: id })
  await Promise.allSettled([
    vibe.control.call("session.stop", { sessionId: id }),
    ...state.shells.map((s) => vibe.control.call("shells.stop", { sessionId: id, id: s.id })),
    ...state.crew.map((s) => vibe.control.call("crew.stop", { id: s.id })),
  ])
}

/** Subscription captures child/idle events; event IDs prevent double rendering. */
async function runEvents(vibe, iterable, { rl, flags = {}, sessionId } = {}) {
  const renderer = createRenderer({
    vibe, rl, yes: !!flags.yes, json: !!flags.json, verbose: !!flags.verbose,
    quiet: !!flags.quiet, showReasoning: !!flags.reasoning,
  })
  const changed = new EventEmitter()
  const off = sessionId && vibe.event?.subscribe
    ? vibe.event.subscribe((event) => {
      if (event.sessionId !== sessionId) return
      const pending = renderer.enqueue(event)
      pending.finally(() => changed.emit("change")).catch(() => {})
      return pending
    })
    : null
  try {
    if (off?.ready) await off.ready
    renderer.beginRun()
    await renderer.handleEvents(iterable)
    await renderer.drain()
    if (!sessionId) return renderer
    let crewResumes = 0
    for (;;) {
      if (renderer.state.failed || renderer.state.interrupted) break
      let wake
      const next = new Promise((resolve) => { wake = resolve; changed.once("change", resolve) })
      // One deferred state read at an event boundary, not a status polling loop.
      await new Promise((resolve) => setImmediate(resolve))
      const state = await vibe.control.call("session.state", { sessionId })
      if (!state.busy && !state.shells.length && !state.crew.length && !state.shellResume) {
        changed.off("change", wake)
        if (state.pendingCrew && !flags.controlOnly && crewResumes++ < 8) {
          await renderer.handleEvents(vibe.session.resume(sessionId, { reasoningEffort: flags.thinking, summaryModel: flags.summaryModel, maxSteps: flags.steps }))
          await renderer.drain()
          continue
        }
        break
      }
      await next
      await renderer.drain()
    }
    return renderer
  } finally {
    off?.()
  }
}

module.exports = { runEvents, closeEngine, stopSessionWork }
