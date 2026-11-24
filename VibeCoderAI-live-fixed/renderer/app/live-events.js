/* ---------- live events (assistant streaming, v2 schema: event.data) ---------- */
const msgBuffers = new Map() // "assistantMessageID#ordinal" -> streamed text
const textEnded = new Map() // same key -> final trimmed text (duplicate guard)
const typing = { el: null, full: "", shown: 0, timer: null }

/** Bubble for run-level errors/stop notices. Reuse the last assistant bubble only when
 *  nothing but a retry row/compaction card follows it; otherwise (tool rows came after it)
 *  add a fresh bubble at the end so the error appears where the run actually stopped. */
function runEndBubble() {
  const last = lastAssistantBubble()
  const msg = last ? last.closest(".msg") : null
  if (msg) {
    let n = msg.nextElementSibling
    while (n && (n.classList.contains("retry-row") || n === liveCompactEl)) n = n.nextElementSibling
    if (!n) return last
  }
  return addMsg("assistant", "")
}

function lastAssistantBubble() {
  return [...document.querySelectorAll(".msg.assistant .bubble")].at(-1) ?? null
}

// Reveal streamed text progressively (left → right) instead of dumping chunks.
function typingTick() {
  if (!typing.el) {
    clearInterval(typing.timer)
    typing.timer = null
    return
  }
  const left = typing.full.length - typing.shown
  if (left <= 0) {
    clearInterval(typing.timer)
    typing.timer = null
    return
  }
  typing.shown += Math.min(left, 2 + Math.floor(left / 25))
  // Show the text already formatted (headings, lists, code, tables) while it
  // streams. Plain text that turned into markdown only at the end made the
  // message jump by hundreds of pixels. Formatting costs more than plain text,
  // so long answers are painted a little less often.
  const now = performance.now()
  const every = Math.min(160, 32 + typing.full.length / 400)
  if (typing.shown < typing.full.length && now - (typing.paintedAt || 0) < every) return
  typing.paintedAt = now
  typingPaint(typing.full.slice(0, typing.shown))
}

function typingPaint(text) {
  if (window.renderMarkdownInto) window.renderMarkdownInto(typing.el, text)
  else typing.el.textContent = text
  scrollChat()
}

function typingPush(text) {
  typing.full = text
  if (!typing.timer) typing.timer = setInterval(typingTick, 16)
}

/* ---------- real error text ---------- */
/* OpenCode publishes a generic "Step interrupted" / "Tool execution interrupted"
   when a run is aborted, which hides what really happened. These helpers turn
   that into the real reason (or the real error message). */
const INTERRUPT_REASON_TEXT = {
  user: "You stopped this run.",
  shutdown: "The VibeCoder service shut down while this run was going.",
  superseded: "Another run replaced this one.",
  inactivity: "The run was stopped after a period of inactivity.",
  unknown: "The run was interrupted.",
}

/** A generic abort message instead of the real cause. */
function isGenericInterrupt(err) {
  if (!err) return false
  const msg = String(err.message || "").toLowerCase()
  return (
    err.type === "aborted" ||
    msg.includes("step interrupted") ||
    msg.includes("tool execution interrupted")
  )
}

/** The real error, with its type and any nested detail. */
function realErrorText(err) {
  if (!err) return ""
  const parts = []
  if (err.message) parts.push(String(err.message))
  if (err.type && err.type !== "aborted") parts.push(`(${err.type})`)
  const extra = err.data ?? err.cause ?? err.error
  if (extra) {
    let t = ""
    if (typeof extra === "string") t = extra
    else if (extra.message) t = String(extra.message)
    else {
      try {
        t = JSON.stringify(extra)
      } catch {}
    }
    if (t && !parts.join(" ").includes(t)) parts.push(t)
  }
  return parts.join(" ").trim()
}

/** Why the run was interrupted, in plain words. */
function interruptText() {
  const reason = state.interruptReason || (state.userStopped ? "user" : "unknown")
  return INTERRUPT_REASON_TEXT[reason] || INTERRUPT_REASON_TEXT.unknown
}

function typingFlush() {
  if (typing.timer) {
    clearInterval(typing.timer)
    typing.timer = null
  }
  if (typing.el) typingPaint(typing.full) // the final text, as markdown
  typing.el = null
  typing.full = ""
  typing.shown = 0
}

vibe.onEvent(async (event) => {
  const type = event?.type ?? ""
  const data = event?.data ?? {}
  const sid = data.sessionID

  if (type === "session.prompts.attached") {
    const ids = new Set(data.ids || [])
    for (let i = queuedPrompts.length - 1; i >= 0; i--) {
      if (queuedPrompts[i].sid === sid && ids.has(queuedPrompts[i].id)) queuedPrompts.splice(i, 1)
    }
    if (sid === state.activeSessionID) {
      $("messages").querySelectorAll(".pending-prompt").forEach((row) => {
        if (!ids.has(row.dataset.pendingId)) return
        row.classList.remove("pending-prompt")
        row.querySelector(".who").textContent = "You"
      })
    }
    return
  }

  // Anything the running session emits proves the run is still alive.
  if (state.running && sid && sid === state.activeSessionID) armRunWatchdog()

  // Provider JSON files are watched by the Electron main process. Refresh all
  // derived UI state when a provider/model/key is changed inside or outside the app.
  if (type === "providers.changed") {
    refreshProviderStateLive().catch((error) => showError("Could not refresh providers", String(error?.message || error), { key: "providers-refresh" }))
    return
  }
  // VibeCoder account: signed in / out, code expired, or models refreshed.
  // Computer Use: the on-screen badge shows activity; here only the stop is reported.
  if (type === "notification.chime") {
    if (notificationsEnabled()) playChime()
    return
  }
  if (type === "notification.clicked") {
    const target = data.sessionID
    if (target && target !== state.activeSessionID && typeof openSession === "function") openSession(target)
    return
  }
  if (type === "computer.active") {
    // While the agent uses the computer the window is a narrow side panel:
    // only the chat shows (the left bar comes back with the full window).
    document.body.classList.toggle("computer-side", data.active === true)
    return
  }
  if (type === "computer.stopped") {
    showError("Computer Use stopped", "You pressed Ctrl+Alt+Esc, so the agent stopped controlling the computer.", { key: "computer-use" })
    return
  }
  if (type === "auth.changed" || type === "auth.models") {
    refreshAuthUI().catch(() => {})
    return
  }
  if (type === "skills.changed") {
    loadSkills().catch(() => {})
    return
  }

  // Synthetic status events from the host / main process (no sessionID).
  if (type === "host.event_stream") {
    if (data.status === "disconnected") {
      showError(
        "Lost connection to the agent",
        `The event stream disconnected (attempt ${Math.max(1, Number(data.attempt) || 1)}). ` +
          `Reconnecting automatically…${data.message ? "\n\n" + data.message : ""}`,
        { key: "host-stream" },
      )
    } else if (data.status === "connected") {
      hideError("host-stream")
    }
    return
  }
  if (type === "app.error") {
    showError(data.title || "Application error", data.message || data.detail || "Unknown error")
    return
  }
  if (type === "app.focus") {
    // The window lost/gained focus: the agent keeps working in the background.
    if (data.focused === false) markBackgroundJob()
    else renderBgJob()
    return
  }
  if (type === "app.openUrl") {
    // A link clicked anywhere in the app opens in the built-in browser panel,
    // never in an outside window.
    if (data && data.url) openBrowser(data.url, { newTab: true })
    return
  }

  if (type === "compaction.settings.changed") {
    applyCompactionSettings(data.compaction || data)
    return
  }

  if (type === "subagent.event") {
    handleSubagentEvent(data)
    return
  }

  if (type === "session.pulse.started" && sid === state.activeSessionID) {
    state.pulse = { step: 0, tools: 0, maxSteps: Number(data.maxSteps) || 0 }
    updateRunBadge()
    return
  }
  if (type === "session.pulse.step.started" && sid === state.activeSessionID) {
    state.pulse = { ...(state.pulse || {}), step: Number(data.step) || 0, tools: Array.isArray(data.tools) ? data.tools.length : 0 }
    updateRunBadge()
    return
  }
  if (type === "session.pulse.step.ended" && sid === state.activeSessionID) {
    state.pulse = { ...(state.pulse || {}), step: Number(data.step) || state.pulse?.step || 0 }
    updateRunBadge()
    return
  }
  if (type === "session.permission.locked" && sid === state.activeSessionID) {
    addHarnessNote("Hard lock blocked this action", `${data.tool || "action"}${data.subject ? ` — ${data.subject}` : ""}`, "locked")
    return
  }
  if (type === "session.recipe.started" && sid === state.activeSessionID) {
    addHarnessNote(`Recipe /${data.id || "unknown"}`, [data.agent && `persona ${data.agent}`, data.model && `model ${data.model}`].filter(Boolean).join(" · "))
    return
  }

  // While inspecting a child, keep the parent's run state current but do not
  // paint parent text/tools into the child timeline. Back re-renders the parent
  // canonically from disk.
  if (state.subagentView && sid === state.activeSessionID && /^session\.(text|reasoning|tool|compaction)\./.test(type)) return

  // The question tool surfaces as a session "form". Render it as an interactive
  // card — the agent is paused until the user answers or dismisses it.
  if (type === "form.created" || type === "form.replied" || type === "form.cancelled") {
    const fsid = data.form?.sessionID ?? data.sessionID
    if (!fsid || fsid === state.activeSessionID) refreshForms()
    return
  }

  // Compaction (auto or manual): show the checkpoint while it streams, then
  // re-render the canonical timeline once the summary is stored.
  if (type.startsWith("session.compaction.")) {
    if (sid !== state.activeSessionID) return
    if (type === "session.compaction.started") {
      // The compact endpoint is always admitted as a manual request, so use our
      // own trigger to label an automatic checkpoint correctly.
      const why = data.reason === "auto" ? "auto" : (state.compactTrigger || "manual")
      state.compacting = true
      updateRunBadge()
      showCompaction("running", { reason: why, summaryModel: data.summaryModel })
      if (state.compactWatch) clearTimeout(state.compactWatch)
      state.compactWatch = setTimeout(() => {
        if (!state.compacting) return
        finishCompaction("failed", { reason: data.reason, error: "No response from the compaction step (timed out)" })
      }, COMPACT_TIMEOUT_MS)
    } else if (type === "session.compaction.delta") {
      const el = liveCompactEl
      if (el) {
        const sum = el.querySelector(".ctxd-sum")
        const waiting = data.reset && !data.text
        const text = waiting
          ? `Waiting for ${data.summaryModel || "the summary model"} to write the checkpoint summary…`
          : String(data.text || "")
        sum.classList.toggle("waiting", waiting)
        if (waiting) sum.textContent = text
        else if (window.renderMarkdownInto) window.renderMarkdownInto(sum, text)
        else sum.textContent = text
        sum.hidden = !text
        const meta = el.querySelector(".ctxd-meta")
        if (meta && data.summaryModel) meta.textContent = `${data.reason || state.compactTrigger || "compaction"} · ${data.summaryModel}`
      }
    } else if (type === "session.compaction.ended") {
      const why = data.reason === "auto" ? "auto" : (state.compactTrigger || "manual")
      const text = data.summary || data.text || ""
      if (data.summarized === false) {
        finishCompaction("failed", { reason: why, error: data.error || "No valid checkpoint summary was created." })
      } else if (data.fitsBudget === false) {
        finishCompaction("overbudget", { reason: why, text, summarySource: data.summarySource, summaryModel: data.summaryModel, before: data.before, after: data.after, error: data.error || "The compacted request remains over budget." })
      } else {
        finishCompaction("done", { reason: why, text, summarySource: data.summarySource, summaryModel: data.summaryModel, before: data.before, after: data.after, projectContext: data.projectContext })
      }
    } else if (type === "session.compaction.failed") {
      const msg = (data.error && (data.error.message || data.error.type)) || "compaction failed"
      if (data.reason === "auto" && /nothing to compact/i.test(msg)) quietCompactionEnd()
      else finishCompaction("failed", { reason: data.reason, error: msg })
    }
    return
  }

  // Live token usage for the context ring (no return: other handlers still run).
  if ((type === "session.step.ended" || type === "session.step.failed") && data.tokens && sid === state.activeSessionID) {
    U.addStep(usage, data.assistantMessageID ?? `live-${Date.now()}`, data.tokens, data.cost, data.costSource, data.model)
    updateUsageRing()
  }

  if (type === "session.text.delta" || type === "session.text.ended") {
    if (sid !== state.activeSessionID) return
    // The turn is over and the history render is authoritative - a late event
    // must not paint the message a second time.
    if (!state.running) return
    // One assistant message can contain several text parts. Key by ordinal so
    // a new part starts a fresh row instead of appending into the previous one.
    const key = `${data.assistantMessageID ?? "cur"}#${data.ordinal ?? 0}`
    if (type === "session.text.delta" && textEnded.has(key)) return // late duplicate delta
    const buf = msgBuffers.get(key) ?? ""
    const next = type === "session.text.ended" ? (data.text ?? buf) : buf + (data.delta ?? "")
    msgBuffers.set(key, next)

    if (type === "session.text.ended") {
      const final = String(next).trim()
      // Some models emit text.ended twice (or replay it after a retry) — the
      // canonical history render at the end of the turn is authoritative, so
      // only the first completed part is painted live.
      if (textEnded.has(key)) return
      textEnded.set(key, final)
      if (typing.el && !typing.el.isConnected) typing.el = null // replaced by the history render
      if (typing.el) {
        typingPush(next)
        typingFlush()
      } else {
        // No live bubble for this part. If the timeline already shows the text
        // (the history render put it there), do NOT add it a second time.
        const prev = lastAssistantBubble()
        const alreadyThere = !!prev && !!final && prev.textContent.includes(final)
        if (!alreadyThere) {
          const b = addMsg("assistant", "")
          b.textContent = next
        }
      }
      state.liveTextEl = null
    } else {
      if (!typing.el) {
        const ph = state.liveTextEl
        if (ph && ph.isConnected) {
          ph.classList.remove("thinking")
          ph.textContent = ""
          typing.el = ph
        } else {
          typing.el = addMsg("assistant", "")
        }
        typing.shown = 0
      }
      typingPush(next)
    }
    if (state.thinkTimer) {
      clearTimeout(state.thinkTimer)
      state.thinkTimer = null
    }
  }
  if (type === "session.step.failed") {
    if (sid !== state.activeSessionID) return
    const err = data.error ?? {}
    if (isTerminalCompactionError(err) || (data.retryable === false && /compaction|context window|over budget/i.test(String(err.message || err)))) {
      // The compaction card already contains the checkpoint and budget error.
      // Remove only the empty Thinking placeholder and keep the card at the end.
      // Wait for execution.failed to release the run lock; otherwise a new prompt
      // can race the old failure event and the status row lands in the middle.
      state.compactionBlockedRun = true
      state.lastRealError = err
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.retryTimer = null
      stopRetryCountdown()
      hideRetryInline()
      hideError("execution")
      const pending = state.pendingBubble || lastAssistantBubble()
      if (pending?.classList.contains("thinking")) pending.closest(".msg")?.remove()
      if (typing.el?.classList?.contains("thinking")) typing.el.closest(".msg")?.remove()
      state.pendingBubble = null
      state.liveTextEl = null
      typing.el = null
      if (!liveCompactEl?.isConnected) {
        const message = String(err.message || err || "Context compaction could not continue.")
        showCompaction(/over budget/i.test(message) ? "overbudget" : "failed", {
          reason: state.compactTrigger || "auto",
          error: message,
        })
      }
      const box = $("messages")
      if (box && liveCompactEl?.isConnected && box.lastElementChild !== liveCompactEl) box.appendChild(liveCompactEl)
      scrollChat(true)
      return
    }
    setRunning(false)
    // The prompt failed before the engine appended the message to the session:
    // a retry must NOT revert an older turn (that would lose real chat history).
    if (data.persisted === false && state.lastSend) state.lastSend.persisted = false
    // A provider that rejected the request as too large can still be rescued by
    // summarizing now instead of making the user start a new session.
    if (state.autoCompact && looksLikeContextOverflow(err)) compactNow({ reason: "auto" })

    let pretty = ""
    let failed = true
    let freeModel = null
    if (isGenericInterrupt(err)) {
      // OpenCode collapses some real failures into "Step interrupted". That is
      // only a harmless stop when we know who/why stopped the run.
      const knownStop = !!(state.interruptReason || state.userStopped)
      failed = !knownStop
      pretty = knownStop ? interruptText() : "The run stopped unexpectedly (the service sent no error)."
      state.lastRealError = null
    } else if (isNoCreditError(err)) {
      const configured = new Map((providerState.list || []).map((p) => [p.id, p]))
      freeModel = (state.models || []).find((m) => {
        if (!m || !m.id || !/free/i.test(String(m.id))) return false
        if (`${m.providerID}/${m.id}` === state.selectedModel) return false
        return !configured.get(m.providerID)?.disabled
      }) || null
      pretty = freeModel
        ? `This model has no credits. Try your configured free model: ${freeModel.providerID}/${freeModel.id}`
        : "This model has no credits. Add or select a working free model in Settings → Models, or check this provider's quota."
      state.lastRealError = err
    } else {
      pretty = realErrorText(err) || "Step failed"
      state.lastRealError = err
      // If this error matches the one already shown inline on a tool card
      // (session.tool.failed), suppress the redundant run-level bubble so the
      // user sees it only once at the tool row.
      if (pretty === state.lastToolError) hideError()
    }

    const target = runEndBubble()
    if (target) {
      target.classList.remove("thinking")
      target.textContent = failed ? `⚠ ${pretty}` : `⏹ ${pretty}`
      if (freeModel) {
        const btn = document.createElement("button")
        btn.className = "save-btn quota-btn"
        btn.textContent = `Switch to ${freeModel.id}`
        btn.onclick = async () => {
          const key = `${freeModel.providerID}/${freeModel.id}`
          try {
            if (!state.activeSessionID) throw new Error("Create or open a chat before switching models.")
            const switched = await vibe.setModel({
              sessionID: state.activeSessionID,
              model: { providerID: freeModel.providerID, id: freeModel.id },
            })
            if (!switched || switched.ok === false) throw new Error(switched?.error || "Model switch failed")
            state.selectedModel = key
            try { localStorage.setItem("vibecoder.model", key) } catch {}
            $("model-label").textContent = freeModel.id
            updateUsageRing()
            renderModelList()
            btn.remove()
          } catch (e) {
            showError("Could not switch model", String(e?.message || e), { key: "model-switch" })
          }
        }
        target.appendChild(btn)
      }
    }
    if (failed) {
      // A run failure is always reported inline, where it happened: the red popup
      // covers the chat and fights with the inline retry counter. The bubble
      // already says what happened, plus a Retry button.
      const retryable = data.retryable !== false && !state.userStopped && isRetryableRunError(state.lastRealError)
      hideError("execution")
      if (!retryable) {
        hideRetryInline()
        if (target) addRetryButtonToBubble(target)
      }
      // Safety net: normally execution.failed follows within milliseconds and
      // schedules the retry. If it never arrives, retry from here instead of
      // leaving the run dead in the water.
      if (retryable) {
        setTimeout(() => {
          if (state.running || state.retryTimer || state.userStopped) return
          if (state.interruptReason) return
          if (scheduleRetry(pretty)) notifyAgent("The model did not answer — retrying", pretty, "progress")
        }, 1500)
      }
    } else {
      hideError("execution")
    }
  }
  if (type === "session.execution.succeeded") {
    if (sid !== state.activeSessionID) return
    hideError("execution")
    hideRetryInline()
    state.retryCount = 0
    stopRetryCountdown()
    if (state.retryTimer) {
      clearTimeout(state.retryTimer)
      state.retryTimer = null
    }
    typingFlush()
    if (reasoningEl) {
      const secs = state.reasonStart ? Math.max(1, Math.round((Date.now() - state.reasonStart) / 1000)) : 0
      finishThought(reasoningEl, secs)
      reasoningEl.classList.remove("open")
      reasoningEl = null
      state.reasonStart = null
    }
    setRunning(false)
    hideBranchChip()
    const target = lastAssistantBubble()
    if (target?.classList.contains("thinking")) target.textContent = ""
    if (queuedPrompts.length) setTimeout(drainQueuedPrompt, 900) // after the timeline re-render below
    // re-render the canonical timeline (opencode style groups, file cards)
    setTimeout(() => {
      if (!state.activeSessionID) return
      renderSessionHistory(state.activeSessionID)
      // The engine names a fresh session from the first prompt - without this
      // refresh the sidebar kept showing "New session" until an app restart.
      refreshSessions()
      // The turn just finished — if the window is nearly full the conversation
      // is summarized now rather than overflowing on the next prompt.
      maybeAutoCompact(1200)
      const summary = lastAnswerSummary()
      const done = !agentLooksUnfinished()
      const wasBackgroundJob = bgJob.startedAt > 0
      const waitingForShell = [...runningJobs.values()].some((job) => job.shellId)
      if (waitingForShell) {
        // A durable engine completion will attach the command's intent, output
        // and exit status, then resume the agent. Do not announce completion or
        // start a competing auto-continue run while that result is pending.
        renderBgJob()
        return
      }
      if (done) {
        // The whole task is finished -> tell the user, with the summary.
        clearBackgroundJob()
        notifyAgent(
          wasBackgroundJob ? "Background task finished" : "Task finished",
          summary || "The agent finished the whole task.",
          "done",
          sid,
        )
      } else {
        // One step is done, more is open.
        notifyAgent("Agent finished a step", summary || "Continuing with the next step.", "progress")
        // ... and let the agent continue on its own if the user is away.
        if (appIsInBackground()) scheduleAutoContinue()
      }
    }, 400)
  }
  if (type === "session.execution.started") {
    if (sid !== state.activeSessionID) return
    setRunning(true)
    if (data.source === "subagent-result" && !state.subagentView) {
      state.userStopped = false
      state.interruptReason = null
      state.lastRealError = null
      const pending = addMsg("assistant", "Using the completed subagent result…", "thinking")
      state.pendingBubble = pending
      state.liveTextEl = pending
    } else if (data.source === "shell-result" && !state.subagentView) {
      state.userStopped = false
      state.interruptReason = null
      state.lastRealError = null
      const pending = addMsg("assistant", "Using the completed background command result…", "thinking")
      state.pendingBubble = pending
      state.liveTextEl = pending
    }
  }
  if (type === "session.execution.failed" || type === "session.execution.interrupted") {
    if (sid !== state.activeSessionID) return
    if (type === "session.execution.failed" && data.persisted === false && state.lastSend) {
      state.lastSend.persisted = false
    }
    typingFlush()
    setRunning(false)
    hideBranchChip()
    if (type === "session.execution.failed" && data.source === "subagent-result") {
      const msg = realErrorText(data.error) || "The main agent could not report the completed subagent result."
      showRunFailureInline(msg, runEndBubble())
      notifyAgent("Could not report the helper's result", msg, "error", sid)
      return
    }
    if (type === "session.execution.failed" && (state.compactionBlockedRun || isTerminalCompactionError(data.error) || (data.retryable === false && /compaction|context window|over budget/i.test(String(data.error?.message || data.error || ""))))) {
      // The checkpoint card is the sole UI for this terminal failure. Do not
      // duplicate it as an assistant bubble or start another model retry.
      state.compactionBlockedRun = false
      state.lastRealError = data.error || state.lastRealError
      if (state.retryTimer) clearTimeout(state.retryTimer)
      state.retryTimer = null
      stopRetryCountdown()
      hideRetryInline()
      hideError("execution")
      const pending = state.pendingBubble || lastAssistantBubble()
      if (pending?.classList.contains("thinking")) pending.closest(".msg")?.remove()
      state.pendingBubble = null
      state.liveTextEl = null
      if (liveCompactEl?.isConnected) {
        const box = $("messages")
        if (box && box.lastElementChild !== liveCompactEl) box.appendChild(liveCompactEl)
      } else {
        const message = String(data.error?.message || data.error || "Context compaction could not continue.")
        showCompaction(/over budget/i.test(message) ? "overbudget" : "failed", {
          reason: state.compactTrigger || "auto",
          error: message,
        })
      }
      scrollChat(true)
      return
    }
    maybeAutoCompact(1200)
    if (type === "session.execution.failed") {
      const err = data.error
      const generic = isGenericInterrupt(err)
      const knownStop = !!(state.interruptReason || state.userStopped)
      // Prefer the real error we already saw on the step event.
      const real = generic ? state.lastRealError : err
      // OpenCode sometimes ends the execution with a generic abort while the
      // provider actually failed (429 / dropped stream). Nobody stopped it, no
      // reason was published -> treat it as a failure and retry, like the
      // original OpenCode clients do.
      const unexpectedAbort = generic && !knownStop && !state.lastRealError
      if (generic && knownStop) {
        // A stop we can explain: say it, but do not raise an error.
        const target = runEndBubble()
        if (target) target.textContent = `⏹ ${interruptText()}`
        hideError("execution")
        return
      }
      const msg = unexpectedAbort
        ? "The run stopped unexpectedly (the service sent no error)."
        : real
          ? realErrorText(real) || "The agent stopped unexpectedly."
          : "The agent stopped unexpectedly."
      const target = runEndBubble()
      // Timeouts / rate limits / 5xx / unknown aborts: retry automatically and
      // keep a manual Retry available afterwards.
      if (data.retryable !== false && !state.userStopped && (isRetryableRunError(real) || unexpectedAbort) && scheduleRetry(msg)) {
        // A retry is coming: no red banner, the inline counter says it all.
        hideError("execution")
        notifyAgent("The model did not answer — retrying", msg, "progress")
      } else {
        // Retries exhausted (or the error is not retryable): show the real
        // error inline, where the run stopped. No red popup.
        hideRetryInline()
        showRunFailureInline(msg, target)
        notifyAgent("Task stopped with an error", msg, "error", sid)
      }
    } else {
      // remember why the run was interrupted so the step row can say it
      const reason = data.reason || state.interruptReason || "unknown"
      state.interruptReason = reason
      const known = reason === "user" || reason === "shutdown" || reason === "superseded" || reason === "inactivity" || state.userStopped
      if (known) {
        if (reason !== "user" && !state.userStopped) {
          const msg = interruptText()
          const target = runEndBubble()
          if (target) target.textContent = `⏹ ${msg}`
          hideError("execution")
          notifyAgent("Task interrupted", msg, "error", sid)
        } else {
          hideError("execution")
        }
      } else if (scheduleRetry("The run stopped unexpectedly.")) {
        // An abort nobody asked for (provider/tool failure inside OpenCode):
        // retry it like any other hiccup instead of silently ending the run.
        notifyAgent("The model did not answer — retrying", "The run stopped unexpectedly.", "progress")
      } else {
        const msg = interruptText()
        showRunFailureInline(msg)
        notifyAgent("Task interrupted", msg, "error", sid)
      }
    }
  }
  // Keep the sidebar in sync with the server: a session can be created,
  // renamed, moved or deleted from anywhere (another window, a plugin, the
  // agent itself). Debounced so a burst of events costs one refresh.
  if (/^session\.(created|deleted|moved|renamed|archived|forked)$/.test(type)) scheduleSessionsRefresh()
  // The host retried a prompt that hit a transient provider/transport error.
  if (type === "host.retry") {
    const bubble = lastAssistantBubble()
    if (data?.recovered) {
      if (bubble && /retrying/i.test(bubble.textContent || "")) bubble.textContent = ""
    } else if (!data?.failed && bubble) {
      bubble.textContent = `⟳ Provider busy — retrying ${data?.attempt ?? ""}/${data?.of ?? ""}…`
    }
  }

  /* ---- agent activity events (opencode app style) ---- */
  if (sid && sid !== state.activeSessionID) {
    // activity belongs to another session — don't paint it into this timeline
    if (type === "session.permissions") refreshPermissionRequests()
    return
  }
  if (state.thinkTimer && (type.startsWith("session.reasoning") || type.startsWith("session.tool"))) {
    clearTimeout(state.thinkTimer)
    state.thinkTimer = null
  }
  if (type === "session.tool.input.started") {
    typingFlush()
    const preceding = $("messages").lastElementChild
    if (preceding?.matches(".msg.assistant") && !preceding.querySelector(".thinking, .error")) appendTimeline(preceding, "commentary")
    const key = `tool:${data.id}`
    if (data.name) toolNames.set(key, data.name)
    // track it as a running job (shown in the "Running" list)
    runningJobs.set(key, { kind: "Tool", title: data.name || "tool", at: Date.now(), sessionID: sid || state.activeSessionID || "" })
    renderBgJob()
    // The question tool gets its own interactive card (form.created) instead of
    // a raw tool row.
    if (data.name !== "question") toolAct(key, data.name || "tool")
  }
  if (type === "session.tool.input.delta") {
    const key = `tool:${data.id}`
    const el = actEls.get(key)
    if (el) {
      const b = el.querySelector(".act-body")
      b.textContent = (b.textContent || "") + (data.delta ?? "")
    }
  }
  if (type === "session.tool.input.ended") {
    const key = `tool:${data.id}`
    const el = actEls.get(key)
    if (el && data.input && !el.querySelector(".act-body").textContent) {
      el.querySelector(".act-body").textContent = JSON.stringify(data.input, null, 2)
    }
  }
  if (type === "session.tool.called") {
    const key = `tool:${data.id}`
    const input = data.input ?? {}
    // this event carries no tool name — remember it from input.started
    const name = data.name || toolNames.get(key) || input.name || "tool"
    maybeShowBranchForTool(name, input)
    if (name === "question") {
      // pending form card handles this tool; make sure it is on screen
      refreshForms()
      return
    }
    toolArgs.set(key, { name, input })
    const el = toolAct(key, name, input)
    renderToolDetails(el, name, input, { metadata: data.metadata }, data.id)
    if (name === "todowrite" && Array.isArray(input?.todos)) {
      // remember the agent's plan -> tells us if work is still open
      autoCont.todos = input.todos
      // and show it in the task strip (it is saved on disk)
      todoState.items = input.todos.map((t) => ({
        content: t?.content || "",
        status: t?.status || "pending",
        priority: t?.priority || "medium",
      }))
      // a fresh plan is worth showing again, even if it was hidden before
      todoState.hidden = false
      renderTodos()
      saveTodos()
    }
    // the running job list shows the tool and what it touches
    const job = runningJobs.get(key)
    const target = toolSubtitle(name, input).replace(/\s+/g, " ").trim()
    if (job) {
      job.kind = toolRowLabel(name)
      job.title = `${toolRowLabel(name)}${target ? ": " + target : ""}`
    }
    renderBgJob()
  }
  if (type === "session.tool.success") {
    actDone(`tool:${data.id}`, true)
    runningJobs.delete(`tool:${data.id}`)
    renderBgJob()
    const el = actEls.get(`tool:${data.id}`)
    const info = toolArgs.get(`tool:${data.id}`)
    if (el && info) {
      renderToolDetails(el, info.name, info.input, {
        content: data.content,
        metadata: data.metadata,
      }, data.id)
    }
    const finalShell = shellToolOutputs.get(data.id)
    if (finalShell) {
      const out = actOut(`tool:${data.id}`)
      if (out) {
        out.textContent = finalShell.text || (finalShell.status === "completed" ? "Process completed with no output." : `Process ${finalShell.status}.`)
        if (finalShell.exit !== undefined) out.dataset.exitCode = String(finalShell.exit)
      }
      shellToolOutputs.delete(data.id)
    }
    // keep the finished tool visible in the status line until the next one
  }
  if (type === "session.tool.failed") {
    actDone(`tool:${data.id}`, false)
    runningJobs.delete(`tool:${data.id}`)
    renderBgJob()
    const el = actEls.get(`tool:${data.id}`)
    if (el && data.error) {
      // "Tool execution interrupted" is generic -> say what really happened
      const txt = isGenericInterrupt(data.error)
        ? interruptText()
        : realErrorText(data.error) || "failed"
      el.querySelector(".act-out").textContent = txt
      // remember this error so the later step.failed can suppress its duplicate bubble
      state.lastToolError = realErrorText(data.error) || String(data.error || "")
    }
  }
  if (type === "session.reasoning.started") {
    // One live thought row per continuous reasoning stream (models can emit
    // several reasoning.started events in a row — don't orphan empty rows).
    if (reasoningEl) return
    // Replace the "Thinking..." placeholder: reasoning has its own row.
    const ph = lastAssistantBubble()
    if (ph?.classList.contains("thinking")) {
      ph.closest(".msg")?.remove()
      state.liveTextEl = null
    }
    state.reasonStart = Date.now()
    reasoningEl = addThought("", 0, true) // keep thinking visible while it streams
    startThoughtTimer(reasoningEl, state.reasonStart)
    // Follow new text unless the user scrolls up inside the box to read.
    const body = reasoningEl.querySelector(".th-body")
    body.addEventListener("scroll", () => { body.dataset.follow = body.scrollHeight - body.scrollTop - body.clientHeight < 60 ? "1" : "0" })
  }
  if (type === "session.reasoning.delta" && reasoningEl) {
    const b = reasoningEl.querySelector(".th-body")
    b.textContent = (b.textContent || "") + (data.delta ?? "")
    followThought(b)
    scrollChat()
  }
  if (type === "session.reasoning.ended" && reasoningEl) {
    const secs = state.reasonStart
      ? Math.max(1, Math.round((Date.now() - state.reasonStart) / 1000))
      : 0
    finishThought(reasoningEl, secs)
    reasoningEl.classList.toggle("open", !timelinePreferences.thinking.collapse)
    reasoningEl = null
    state.reasonStart = null
  }
  /* Background shells (opencode-style): the bash tool's OWN row already shows the
     command, so these events only feed the running-jobs chip (Stop / Background). */
  if (type === "session.shell.started") {
    const sh = data.shell ?? {}
    if (sh.id) {
      runningJobs.set(`shell:${sh.id}`, {
        kind: "Shell",
        sessionID: sid || state.activeSessionID || "",
        title: String(sh.description || sh.intent || sh.command || "shell"),
        at: sh.started || Date.now(),
        shellId: sh.id,
        backgrounded: !!(sh.backgrounded || sh.background),
        cwd: sh.cwd || "",
        file: sh.file || "",
        command: String(sh.command || ""),
        writable: sh.writable !== false,
        waitingForInput: !!sh.waitingForInput,
        toolCallId: sh.toolCallId || "",
        output: "",
      })
      renderBgJob()
    }
  }
  if (type === "session.shell.output") {
    const sh = data.shell ?? {}
    const delta = String(data.delta || "")
    const key = `shell:${sh.id}`
    let job = runningJobs.get(key)
    const missedStart = !job && !!sh.id
    if (missedStart) {
      // An output delta is itself enough to reconstruct the lightweight job row
      // if the renderer missed shell.started during a sleep/reconnect.
      job = {
        kind: "Shell",
        sessionID: sid || state.activeSessionID || "",
        title: String(sh.description || sh.intent || sh.command || "shell"),
        command: String(sh.command || ""),
        at: sh.started || Date.now(),
        shellId: sh.id,
        backgrounded: !!sh.backgrounded,
        writable: sh.writable !== false,
        waitingForInput: !!sh.waitingForInput,
        toolCallId: sh.toolCallId || "",
        output: "",
      }
      runningJobs.set(key, job)
      renderBgJob()
    }
    if (job) {
      job.output = terminalText((job.output || "") + delta)
      job.writable = sh.writable !== false
      job.waitingForInput = !!sh.waitingForInput
      updateShellOutputView(sh.id, job.output)
    }
    const toolCallId = sh.toolCallId || job?.toolCallId
    const out = toolCallId ? actOut(`tool:${toolCallId}`) : null
    if (out) out.textContent = terminalText((out.textContent || "") + delta, 30000)
  }
  if (type === "session.shell.input") {
    const sh = data.shell ?? {}
    const job = runningJobs.get(`shell:${sh.id}`)
    if (job) { job.writable = sh.writable !== false; job.waitingForInput = false }
    if (!$("bg-job-panel")?.hidden) renderBgJobPanel()
  }
  if (type === "session.shell.waiting") {
    const sh = data.shell ?? {}
    const job = runningJobs.get(`shell:${sh.id}`)
    if (job) {
      job.waitingForInput = true
      job.writable = sh.writable !== false
      if (data.prompt && !job.output) job.output = terminalText(data.prompt)
    }
    renderBgJob()
  }
  if (type === "session.shell.backgrounded") {
    const sh = data.shell ?? {}
    const job = runningJobs.get(`shell:${sh.id}`)
    if (job) job.backgrounded = true
    renderBgJob()
  }
  if (type === "session.shell.ended" || type === "session.shell.completed") {
    const sh = data.shell ?? {}
    const job = runningJobs.get(`shell:${sh.id}`)
    if (type === "session.shell.completed") {
      const finalOutput = terminalText(data.output || job?.output || "", 30000)
      applyFinalShellOutput(sh, finalOutput)
      if (sh.id) reconciledShellResults.add(sh.id)
      while (reconciledShellResults.size > 200) reconciledShellResults.delete(reconciledShellResults.values().next().value)
    }
    runningJobs.delete(`shell:${sh.id}`)
    shellInputDrafts.delete(sh.id)
    renderBgJob()
  }
  if (type === "session.permissions" || type === "session.tool.called") {
    refreshPermissionRequests()
  }
  /* OpenCode provider device-login flow events */
  if (type === "opencode-auth-url") {
    const code = event.code || ""
    $("opencode-code").textContent = code || "-"
    $("opencode-device").hidden = false
    $("opencode-wait").textContent = "Waiting for authorization — finish the sign-in in your browser."
    $("opencode-st-dot").className = "st-dot checking"
    $("opencode-st-text").textContent = "Device login started — sign in in your browser"
  }
  if (type === "opencode-auth-done") {
    if (authPoll) clearInterval(authPoll)
    authPoll = null
    $("opencode-wait").textContent = "Connected — loading models…"
    // A different account can expose a different model catalog, so drop the cache.
    resetOpenCodeModelCache()
    await refreshAuthUI()
    await loadModels()
    $("opencode-wait").textContent = "Connected — models are ready."
  }
  if (type === "opencode-auth-closed") {
    if (authPoll) clearInterval(authPoll)
    authPoll = null
    if (event.error) {
      $("opencode-st-dot").className = "st-dot off"
      $("opencode-st-text").textContent = `Login failed — ${event.error}`
      showError("OpenCode login failed", event.error, { key: "auth" })
    }
    await refreshAuthUI()
  }
})

