"use strict"
/**
 * Crew own-workspace bar in a helper's view: shows where the helper worked and
 * lets the user review, merge into the project, or discard its changes.
 */
;(function () {
  const $ = (id) => document.getElementById(id)
  const unwrap = (r) => (r && typeof r === "object" && "ok" in r ? (r.ok ? r.data : Promise.reject(new Error(r.error || "Failed"))) : r)
  const api = (name, arg) => Promise.resolve(window.vibe && typeof window.vibe[name] === "function" ? window.vibe[name](arg) : null).then(unwrap)
  let current = null

  function say(text, tone = "success") {
    try { if (typeof showError === "function") showError(tone === "success" ? "Crew" : "Crew workspace", text, { key: "crew-ws", tone }) } catch {}
  }

  function render(details) {
    current = details
    const bar = $("crew-ws-bar")
    if (!bar) return
    const ws = details && details.workspace
    if (!ws || ws.mode === "shared") {
      bar.hidden = !(ws && ws.note)
      if (ws && ws.note) {
        $("crew-ws-text").textContent = ws.note
        for (const id of ["crew-ws-review", "crew-ws-merge", "crew-ws-discard"]) $(id).hidden = true
      }
      return
    }
    bar.hidden = false
    const running = details.status === "running"
    const kind = ws.mode === "git" ? `own git worktree${ws.branch ? ` (${ws.branch})` : ""}` : "own private copy"
    let text
    if (ws.state === "merged") text = `Merged into the project${ws.merge && ws.merge.conflicts && ws.merge.conflicts.length ? ` — fix conflicts in ${ws.merge.conflicts.join(", ")}` : ""}.`
    else if (ws.state === "discarded") text = "Workspace discarded — the project was not changed."
    else if (running) text = `Working in its ${kind}. Your project is not touched until you merge.`
    else if (ws.changed === 0) text = `Worked in its ${kind} — no files changed.`
    else if (typeof ws.changed === "number") text = `Worked in its ${kind} — ${ws.changed} file${ws.changed === 1 ? "" : "s"} changed, not in your project yet.`
    else text = `Worked in its ${kind}.`
    $("crew-ws-text").textContent = text
    const open = ws.state === "open" && !running
    $("crew-ws-review").hidden = !open
    $("crew-ws-merge").hidden = !open || ws.changed === 0
    $("crew-ws-discard").hidden = !open
  }

  async function review() {
    if (!current) return
    try {
      const r = await api("crewChanges", { id: current.id })
      const files = (r.files || []).map((f) => `${f.status} ${f.path}`).join("\n")
      const body = `${r.files.length} file${r.files.length === 1 ? "" : "s"} changed:\n${files}${r.diff ? `\n\n${r.diff}` : ""}`
      if (typeof showDialog === "function") {
        const ok = await showDialog({ title: "Helper's changes", message: body.slice(0, 20000), okText: "Merge into project", cancelText: "Close" })
        if (ok) await merge()
      } else say(body.slice(0, 2000))
    } catch (e) { say(String((e && e.message) || e), "error") }
  }

  async function merge() {
    if (!current) return
    const b = $("crew-ws-merge")
    b.disabled = true
    try {
      const r = await api("crewMerge", { id: current.id })
      let msg = `Merged ${r.applied.length} of ${r.total} file${r.total === 1 ? "" : "s"} into the project.`
      if (r.conflicts.length) msg += ` Fix the marked conflicts in: ${r.conflicts.join(", ")}.`
      if (r.kept.length) msg += ` Kept your version and saved the helper's next to: ${r.kept.map((k) => k.path).join(", ")}.`
      say(msg, r.conflicts.length || r.kept.length ? "warning" : "success")
    } catch (e) { say(String((e && e.message) || e), "error") }
    finally { b.disabled = false; refresh() }
  }

  async function discard() {
    if (!current) return
    if (typeof showDialog === "function") {
      const ok = await showDialog({ title: "Discard the helper's changes?", message: "Its private workspace is deleted. Your project is not changed.", okText: "Discard", cancelText: "Keep" })
      if (!ok) return
    }
    try { await api("crewDiscard", { id: current.id }); say("Discarded. Your project was not changed.") }
    catch (e) { say(String((e && e.message) || e), "error") }
    finally { refresh() }
  }

  async function refresh() {
    if (!current) return
    try { const d = await api("subagentDetails", { id: current.id }); if (d) render(d) } catch {}
  }

  function start() {
    if (!$("crew-ws-bar")) return
    $("crew-ws-review").addEventListener("click", review)
    $("crew-ws-merge").addEventListener("click", merge)
    $("crew-ws-discard").addEventListener("click", discard)
    // The bar belongs to the helper view: hide it when that view closes.
    const viewbar = $("subagent-viewbar")
    if (viewbar) new MutationObserver(() => { if (viewbar.hidden) { $("crew-ws-bar").hidden = true; current = null } }).observe(viewbar, { attributes: true, attributeFilter: ["hidden"] })
    if (window.vibe && typeof window.vibe.onEvent === "function") {
      window.vibe.onEvent((ev) => {
        const t = ev && (ev.type === "subagent.event" ? ev.data && ev.data.eventType : ev.type)
        if (current && (t === "subagent.workspace" || t === "subagent.end")) refresh()
      })
    }
  }
  window.renderCrewWorkspace = render
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start)
  else start()
})()
