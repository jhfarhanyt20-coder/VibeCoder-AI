# VibeCoder AI — OpenCode Parity & Hardening Plan

**Status:** active
**Last updated:** 2026-10-30
**Repo root (this file lives here):** `C:\Users\farhan\Downloads\VibeCoderAI-live-provider-browser-fixed`
**Project root (all code):** `VibeCoderAI-live-fixed/`
**Run every command from:** `VibeCoderAI-live-fixed/`

> বাংলা নোট: এই ফাইলটা handoff plan. যেকোনো agent একটা task ID ধরে, তার *Files* + *Acceptance* পড়ে, implementation করে, `npm test` চালায়, তারপর নিচের Status table-এ ✅ দেয়। কোনো existing feature, tool, event name বা config key মুছবে না — সব কিছু additive।

---

## 0. How to work this plan

1. Pick **one** task ID (`V-01`, `V-02`, …) that is not ✅.
2. Read its **Why / Files / Change / Acceptance**. Do not improvise beyond it.
3. Implement. Keep the diff to that task only.
4. Add or extend a test (see `test/` map below) that fails before and passes after.
5. Run `npm test`. Run the task's own manual check.
6. Update the **Status table** at the bottom (`⬜` → `✅`) and append one line to **Changelog**.

If a task turns out to be wrong, do **not** silently skip it. Add a note under the task and open a `BLOCKED` status with the reason.

---

## 1. Ground rules (hard constraints — do not violate)

| # | Rule |
|---|---|
| G1 | **Zero new runtime dependencies.** `dependencies` must stay empty. Electron stays a devDependency. |
| G2 | **Additive only.** No renaming or removing of existing tools, events, config files, IPC channels, or UI cards. |
| G3 | **Feature flags default to today's behaviour.** New behaviour is opt-in via `~/.vibe/config.json` until a phase is fully done. |
| G4 | **Every tool keeps the shape** `{ name, description, parameters, perm, paths, run }`. New tools must supply all six. |
| G5 | **Windows-first.** Test on PowerShell. No `bash`-only assumptions. |
| G6 | **No secret leakage.** Keys stay in `~/.vibe/auth.json`; never log, never put in events, never in session JSON. |
| G7 | **Session file safety.** Any change to `session.messages` must still pass the `cutIsSafe` invariants in `core/agent/compaction.js`. |
| G8 | **`npm test` must pass** before any task is marked ✅. A task that breaks an older test is a failed task. |

---

## 2. Architecture map (verified by reading the code)

| Area | File | Lines | Notes |
|---|---|---|---|
| Agent loop | `core/agent/loop.js` | 313 | `runLoop()`, step cap, tool resolve, duplicate guard, abort |
| System prompt | `core/agent/prompt.js` | 73 | `buildSystem()` — identity, rules, AGENTS.md |
| Compaction | `core/agent/compaction.js` | 561 | prune → safe cut → LLM summary → fallback → commit |
| Engine | `core/engine.js` | 583 | sessions, permissions, runs, shell jobs, browser bridge |
| Tools | `core/tools/index.js` | 752 | read/write/edit/bash/grep/glob/todowrite/webfetch/skill/memory + subagent* |
| Browser tools | `core/tools/browser.js` | 184 | 12 `browser.*` tools, thin wrappers over `engine.browser*` |
| Browser bridge | `electron/browser.js` | 282 | `BrowserManager`, IPC to renderer dock, `webContents` control |
| Subagents | `core/subagents/index.js` | 211 | 7 hardcoded profiles, fire-and-forget |
| Permissions | `core/perm/rules.js` | 62 | glob rules, last-match-wins |
| Sessions | `core/store/sessions.js` | 122 | one JSON file per session |
| Shell jobs | `core/jobs.js` | 271 | background commands, file log, cancel tree |
| LLM adapters | `core/llm/*.js` | ~750 | `openai-chat`, `openai-responses`, `anthropic`, SSE |
| Electron backend | `electron/backend.cjs` | 778 | `window.vibe` API surface |
| Renderer | `renderer/app.js` | 293 KB | single-file UI (do not restructure in this plan) |

**Test map**

| File | Covers |
|---|---|
| `test/core-test.mjs` | engine, loop, compaction, permissions, tools |
| `test/skills-test.mjs` | skill discovery + SKILL.md parsing |
| `test/electron-backend-smoke.cjs` | backend wiring, events, provider catalog |
| `test/compaction-ui-regression.mjs` | compaction failure UI contract |

---

## 3. Verified defects — fix these before adding features

Every defect below was confirmed by reading the current code. **Do not start P1 until P0 is ✅.**

### D1 — Subagents write into the parent session's history (critical)
`core/subagents/index.js:195` passes the **parent's** session object into `runLoop()`:
```js
const done = await runLoop({ session, store, profile: profileObj, ... })
```
`runLoop` then does `session.messages.push(...)` and `store.save(session)`.
Result: the child's full tool trace lands in the parent context, and parent + child race on the same array and the same JSON file (lost updates).
**Fix → V-01.**

### D2 — `mcp` and `plugin` subagent types have zero tools
`core/subagents/index.js:175-178` filters `tools.ALL`, but `PROFILES.mcp.tools = ["mcp"]` and `PROFILES.plugin.tools = ["plugin"]`; no such names exist in `tools.ALL`. Those subagents start with an empty toolset and every call fails as `Unknown tool`.
**Fix → V-02.**

### D3 — Browser element refs live inside the page
`electron/browser.js:203-214` stores refs in `window.__vibeElementRefs`; `snapshot()` clears and rebuilds them, and navigation destroys them. `click`/`fill` (`:241`, `:254`) depend on that page-global, so a stale ref produces an unhelpful error instead of a guided re-snapshot.
**Fix → V-03.**

### D4 — `browser.evaluate` can be permanently allowed
`core/tools/browser.js:129` uses `perm() = { tool: "browser", subject: "evaluate" }`; `engine.replyPermission("always")` (`core/engine.js:203-207`) persists an exact allow rule, so arbitrary JS in the user's logged-in page runs forever without asking.
**Fix → V-04.**

### D5 — Permission hole: `npm run *` / `make *` are auto-allowed
`core/perm/rules.js:28-39` allows `*npm run *`, `*make *`, `*mvn *`, `*gradle *`, `*cargo build*` etc. `npm run <script>` executes arbitrary code from `package.json`, so a malicious PR can turn an "allowed" build command into code execution.
**Fix → V-05.**

### D6 — Step exhaustion is silent
`core/agent/loop.js:310` ends with `done, reason:"max_steps"` and no summary. The user pays for 100 steps and gets nothing usable. OpenCode removes tools on the final step and asks the model to summarise in text.
**Fix → V-06.**

### D7 — Compaction deletes history permanently
`core/agent/compaction.js:516` `session.messages = nextMessages` throws the head away. There is no way to inspect or restore what was summarised.
**Fix → V-11.**

### D8 — `browser.navigate` guesses page load with a fixed sleep
`core/tools/browser.js:87` `await new Promise(r => setTimeout(r, 1000))`. Slow pages are read half-loaded; fast pages waste a second.
**Fix → V-09.**

### D9 — Hard cap of 6 automatic compactions
`core/agent/compaction.js:16` `MAX_COMPACTIONS = 6`; at `:470` auto compaction then refuses to run, and the run errors with `CONTEXT_COMPACTION_OVER_BUDGET` even though compaction could still help.
**Fix → V-13.**

### D10 — Session store rewrites the whole JSON on every step
`core/store/sessions.js` `save()` serialises the entire message array on every loop step (`loop.js:221`, `:303`). At ~2 MB histories this becomes the slowest part of a run.
**Fix → V-18 (low priority).**

---

## 4. Phases and tasks

Effort is a rough single-developer estimate. Each task is independent unless it says `depends on`.

---

### P0 — Correctness & safety (do first)

#### V-01 — Isolate subagent history in its own session
- **Why:** D1. Today a subagent corrupts the parent conversation.
- **Files:** `core/subagents/index.js`, `core/engine.js`, `core/store/sessions.js`
- **Change:**
  1. In `SubAgentManager.create()` (`:75`), create a **new** child session: `store.create({ dir: parent.dir, profile: parent.profile, title: "subagent: " + task.slice(0, 40) })` and store `agent.session = child`.
  2. Add `parentId` + `kind: "subagent"` fields to the session object; `SessionStore.list()` must exclude `kind === "subagent"` by default so the UI session list is unchanged.
  3. In `_run()` (`:195`) pass `session: agent.session` — never the parent's object.
  4. Keep emitting child events on the **parent** session id with `subagentId` (UI contract unchanged).
  5. `subagentResult(id)` returns `agent.result` (final text) only — not the child transcript.
- **Acceptance:**
  - Parent `session.messages.length` is identical before and after a subagent run.
  - Parent JSON file on disk is not written during the child run (assert mtime unchanged in the test).
  - Child session file exists under `~/.vibe/sessions/` with `kind:"subagent"`.
  - `subagentResult(id)` still returns the final text and `subagentStatus(id)` still reports `done`/`error`.
- **Test:** new `test/subagent-isolation.mjs` — fake profile, two subagents in parallel, assert no cross-writes and no lost parent messages.

#### V-02 — Fix `mcp` / `plugin` subagent tool sets
- **Why:** D2.
- **Files:** `core/subagents/index.js`, `core/engine.js`
- **Change:** replace the `allBuiltIn()` source at `:175` with a call to the engine's full tool catalog:
  `this.engine.extraTools(session.dir)` + `tools.ALL`, then filter by `PROFILES[type].tools`. For `type:"mcp"` keep every tool whose name starts with `mcp__`; for `"plugin"` keep every tool whose name starts with `plugin__`. Resolve the MCP catalog with a bounded wait (`engine._waitMcp(signal, 4000)`).
- **Acceptance:** a fake MCP server exposing `echo` produces a `mcp__test__echo` tool inside an `mcp`-type subagent; the subagent returns its output.
- **Test:** extend `test/core-test.mjs`.

#### V-03 — Move browser element refs into the main process with generation stamps
- **Why:** D3.
- **Files:** `electron/browser.js`, `core/tools/browser.js`
- **Change:**
  1. `snapshot()` bumps `tab.generation++` and stores `tab.refs = Map<ref, { role, name, tag, index }>` (keep the existing `data-vibe-ref` attribute injection so click/fill still work).
  2. `click`/`fill` (`:241`, `:254`) accept an optional `generation` arg. If the caller passes a stale generation, throw `Element ref <ref> is from an older snapshot (generation N, current M). Call browser.snapshot again.`
  3. Never read `window.__vibeElementRefs` as the source of truth; still set it for the injected script, but validate membership against `tab.refs` first.
  4. `browser.snapshot` result string gains a trailing line `refs: generation <N>, <count> elements`.
  5. `browser.click` / `browser.fill` accept and echo `generation`.
- **Acceptance:** snapshot → navigate → click with the old ref returns the guided stale-ref message (not a generic failure); a fresh snapshot makes the same click succeed.
- **Test:** extend `test/electron-backend-smoke.cjs` with a fake `BrowserManager` and assert the error text.

#### V-04 — Stop persisting "always allow" for `browser.evaluate`
- **Why:** D4.
- **Files:** `core/engine.js`, `core/tools/browser.js`
- **Change:** give tools an optional `neverPersist: true` flag. In `replyPermission()` (`engine.js:199`), if the pending entry's tool has `neverPersist`, do **not** push a session rule; the approval is for this call only. Set the flag on `browser.evaluate` only.
- **Acceptance:** approve "always" for `browser.evaluate` twice in a row → two prompts. Approve "always" for `read` → one prompt, second read silent.
- **Test:** extend `test/core-test.mjs`.

#### V-05 — Close the shell permission hole
- **Why:** D5.
- **Files:** `core/perm/rules.js`, `core/agent/loop.js`
- **Change:**
  1. Remove these from `DEFAULT_RULES`: `*npm run *`, `*make *`, `*mvn *`, `*gradle *` (keep `npm test`, `npm build`, `yarn test`, `pnpm test`, `cargo build|test`, `go build|test`, `dotnet build|test`, `node *test*`, `node *build*`).
  2. Add deny rules at the end of `DEFAULT_RULES`:
     `rm -rf /`, `rm -rf ~`, `*Remove-Item*-Recurse*C:\*`, `format *`, `shutdown*`, `*curl*|*sh*`, `*wget*|*sh*`, `:(){:|:&};:`
  3. In `loop.js` before `askPermission(perm)` (`:269-270`), split a `bash` subject on `&&`, `||`, `;`, `|` into sub-commands and call `askPermission` for **each**; any denial denies the whole call. (Lightweight scanner; unknown/parenthesised commands fall through to a single check.)
- **Acceptance:** `npm run evil` asks; `npm test` does not; `echo hi && rm -rf /` asks twice and the deny blocks the whole call; existing allow flows unchanged.
- **Test:** extend `test/core-test.mjs` with the 4 cases.

#### V-06 — Last-step summarisation instead of silent stop
- **Why:** D6.
- **Files:** `core/agent/loop.js`
- **Change:** in the loop head, when `step === maxSteps - 1`, set `toolSpecs = []` for that request and append one synthetic system-role note to the request: `"You have reached the step limit. Do not call tools. Summarise what you changed, what you verified, and what is still pending."` Keep the final `done` event, add `reason: "max_steps"` plus `summarized: true`.
- **Acceptance:** a run that hits the cap produces one final text message with no tool calls; `session.messages` is valid for replay; the UI shows text, not an empty stop.
- **Test:** extend `test/core-test.mjs` with a mock LLM that always calls a tool.

---

### P1 — Agent loop parity

#### V-07 — Agent definition loader (`core/agents/index.js`)
- **Why:** Tomar kache ek global prompt; OpenCode has named agents with model/permissions/steps.
- **Files:** new `core/agents/index.js`, `core/engine.js`, `core/agent/loop.js`
- **Change:**
  1. New module modelled on `core/skills/index.js` discovery (same roots + frontmatter parser; do not duplicate the parser — export it or copy the 20 lines).
  2. Roots: global `~/.vibe/agents/<id>.md`; project `<dir>/.vibe/agents/<id>.md`. Nested folders become part of the id (`team/reviewer`).
  3. Frontmatter keys: `description`, `mode` (`primary|subagent|all`), `model`, `system`, `permissions` (array of `{action, resource, effect}`), `steps`, `hidden`, `color`. Markdown body = system prompt.
  4. Builtins shipped in code: `build` (today's behaviour), `plan` (deny `edit`/`write` except `**/plan/**`), `explore` (read-only tool subset), `general` (subagent, all tools).
  5. `engine.agents.list() / get(id)`; `engine.createSession({ agent })` stores `session.agent`.
  6. `runLoop` accepts `agent` and derives `maxSteps = agent.steps || 100`, extra system text, and the permission rule set.
- **Acceptance:** a project `.vibe/agents/reviewer.md` with `mode: subagent` and `edit: deny` is discoverable, selectable, and cannot edit a file.
- **Test:** new `test/agents-test.mjs` (discovery, frontmatter, permission merge, hidden, model override).

#### V-08 — Permission rule shape upgrade (compatible)
- **Why:** OpenCode's `{action, resource, effect}` is easier for agents/plugins to author than `{tool, pattern, action}`.
- **Files:** `core/perm/rules.js`, `core/engine.js`
- **Change:** `decide()` accepts **both** shapes. Normalise `{action, resource, effect}` → `{tool: action, pattern: resource, action: effect}` at load time. Keep last-match-wins. Support the ` *` suffix rule from OpenCode (a shell pattern ending in ` *` also matches the bare command). Add a `glob`/`grep` resource caveat: for `grep` the resource is the **pattern**, not the path.
- **Acceptance:** the existing `rules.json` still loads; a new-style array produces the same decisions as the equivalent old-style array.
- **Test:** extend `test/core-test.mjs`.

#### V-09 — `browser.wait` and real navigation readiness
- **Why:** D8 + biggest browser reliability win.
- **Files:** `electron/browser.js`, `core/tools/browser.js`, `core/engine.js`
- **Change:**
  1. `BrowserManager.wait(tabID, {selector, text, networkIdle, timeoutMs})` — poll `contents.executeJavaScript` every 150 ms (max 30 s), plus `contents.once('did-finish-load')` when `networkIdle` is requested. Bound all page JS by timeout.
  2. New tool `browser.wait` with `perm: {tool:"browser", subject:"wait"}`.
  3. `browser.navigate` calls `wait({selector:"body", timeoutMs:5000})` and **keeps** the 1 s sleep as a fallback only when the wait times out (do not change behaviour for SPA pages).
- **Acceptance:** navigate to a page with a 2 s delayed `#done` element → `browser.wait({selector:"#done"})` returns in ~2 s and reports the elapsed time; a timeout returns a clear error, not a hang.
- **Test:** `test/electron-backend-smoke.cjs` with a fake `executeJavaScript`.

#### V-10 — `question` tool (interactive prompt)
- **Files:** `core/tools/index.js`, `core/engine.js`, `electron/backend.cjs`, `renderer/app.js` (one modal)
- **Change:** tool `{ name:"question", parameters:{ questions:[{header, question, options:[{label, description}], multiple}] } }`. Emit `{type:"question.ask", id, questions}`; resolve via `engine.replyQuestion(id, answer)`. Add `question.ask` / `question.reply` to the event bridge. Denying the tool must degrade gracefully (tool returns "user dismissed the question; continue with your best judgement").
- **Acceptance:** a run that calls `question` blocks until the UI answers, then continues; on Stop the pending question resolves as dismissed.
- **Test:** extend `test/core-test.mjs` (engine-level) + a smoke assertion in `electron-backend-smoke.cjs`.

#### V-11 — Subagent upgrades
- **Depends on:** V-01, V-07
- **Files:** `core/subagents/index.js`, `core/engine.js`
- **Change:**
  1. `foreground` option: when `background !== true`, await the child and return its final text inline (parent does not have to poll).
  2. `model` comes from the agent definition, else the parent's profile.
  3. `permissions` come from the agent definition; permission subject is the **agent id** (not `"spawn"`).
  4. `subagentResume(id, text)` re-prompts the child session.
  5. Hard nesting depth 1: a subagent's tool catalog never contains `subagent`.
  6. `subagent` tool schema gains `agent` (id) and `background` (bool); `type` stays for backward compatibility and maps to the agent id.
- **Acceptance:** foreground subagent returns text in the same turn; background still notifies; `subagentResume` continues the same child session; recursion is impossible.
- **Test:** extend `test/subagent-isolation.mjs`.

#### V-12 — Plugin hooks (`beforeTool`, `afterTool`, `beforePrompt`)
- **Files:** `core/plugins/index.js`, `core/agent/loop.js`, `core/engine.js`
- **Change:** if a plugin exports `{ hooks: { beforeTool, afterTool, beforePrompt, onEvent } }`, run hooks around the existing path. Each hook is `async (ctx) => ctx | void`. A `beforeTool` may return `{ deny: "reason" }`. Errors in a hook are caught, logged as `plugin.hook.error`, and never crash the run. Plain tool-export plugins keep working unchanged.
- **Acceptance:** a sample plugin that rewrites `bash` args and one that blocks a path both work; a plugin that throws does not break the loop.
- **Test:** extend `test/core-test.mjs`.

---

### P2 — Browser parity

#### V-13 — Browser page search, console, network capture
- **Files:** `electron/browser.js`, `core/tools/browser.js`
- **Change:**
  1. `browser.search({text, tabID})` → `window.find`/TreeWalker, returns match count + scrolls to the first hit.
  2. `browser.console({tabID, clear, limit})` → per-tab ring buffer (100 entries) fed by `contents.on('console-message')`.
  3. `browser.network({tabID, clear, limit})` → per-tab ring buffer fed by `contents.session.webRequest.onCompleted` filtered to the tab's webContentsId; store method, URL, status, duration. **Never store headers or bodies** (secret safety, G6).
- **Acceptance:** a page that logs twice shows 2 console entries; a failing fetch shows in `browser.network` with its status; clearing empties the buffer.
- **Test:** extend `test/electron-backend-smoke.cjs`.

#### V-14 — Browser file upload / download
- **Files:** `electron/browser.js`, `core/tools/browser.js`
- **Change:** `browser.upload({tabID, ref, path})` validates the path is inside the workspace or an explicitly allowed dir, ≤ 5 MiB, then sets the file input via `contents.debugger` / `DOM.setFileInputFiles`. `browser.download({tabID, url, path})` writes only inside `./.vibe-scratch/`. Both require `ask` permission, never persist.
- **Acceptance:** uploading a 1 MiB file into a file input works; a 6 MiB file and a path outside the workspace are rejected with a clear message.
- **Test:** smoke test with a fixture HTML file.

#### V-15 — Accessibility-tree snapshots with DOM fallback
- **Files:** `electron/browser.js`
- **Change:** try `contents.accessibility.snapshot({ interestingOnly: true })` first; convert to the same `[role] name @ref` text format so **all existing consumers keep working**. Fall back to the current DOM walk if the tree is empty. Keep `depth` and the 2500-node cap.
- **Acceptance:** existing snapshot output shape is unchanged (same line format); buttons/links/inputs still get refs; a page with no accessibility support still produces a DOM snapshot.
- **Test:** `test/electron-backend-smoke.cjs`.

#### V-16 — Browser dialog handling
- **Files:** `electron/browser.js`
- **Change:** attach `contents.on('will-prevent-unload')` and a per-tab `dialogPolicy` (`accept` | `dismiss`). Default `accept` for `beforeunload` during agent navigation so a dirty page cannot freeze a run. Never override the policy for user-initiated navigation.
- **Acceptance:** navigating away from a page with `beforeunload` does not hang; the tool returns and the tab is on the new URL.
- **Test:** fixture page with `beforeunload`.

V-17 (optional, only if time): `browser.perf` trace via `contents.startTracing()` behind a config flag. Not required for parity.

---

### P3 — Compaction / context parity

#### V-18 — Configurable compaction
- **Files:** `core/agent/compaction.js`, new `~/.vibe/config.json` reader in `core/util.js` or `core/config.js`
- **Change:** read `{ compaction: { auto: true, keep: { tokens: 15000 }, buffer: 0, maxRuns: 0, model: null } }`.
  - `limits()` (`:92`) uses `buffer` (default 0 = today's `maxOutput` reserve) and `keep.tokens` (default 15000) instead of the hardcoded `min(20000, 20%)`.
  - `auto:false` disables auto compaction but keeps `/compact` and overflow recovery.
  - `maxRuns: 0` = unlimited (replaces `MAX_COMPACTIONS`); keep the constant exported for tests.
- **Acceptance:** with `keep.tokens: 30000` the retained tail doubles; with `auto:false` no auto compaction fires but the explicit compact command still works; defaults reproduce today's numbers within ±1 token headroom.
- **Test:** extend `test/core-test.mjs`.

#### V-19 — Keep compacted history (archive instead of delete)
- **Why:** D7.
- **Files:** `core/agent/compaction.js`, `core/store/sessions.js`, `renderer/app.js` (one "show original" control)
- **Change:**
  1. Before `session.messages = nextMessages` (`:516`), push `{ at, reason, summary, messages: head }` into `session.archives` (cap 2, oldest dropped and written to `~/.vibe/sessions/<id>.archive.json`).
  2. `archives` is **never sent to the model** — strip it in the LLM adapters or store it in a sibling file only. Preferred: sibling file only, so `session.messages` stays small.
  3. UI: the existing checkpoint card gets a "View original" toggle that reads the archive lazily.
- **Acceptance:** after compaction the original head is restorable from disk; the model request token estimate is unchanged versus today; `fitsBudget` logic untouched.
- **Test:** extend `test/core-test.mjs` + `test/compaction-ui-regression.mjs`.

#### V-20 — Separate summary model
- **Files:** `core/agent/compaction.js`, `core/engine.js`
- **Change:** `compaction.model` (string profile id) is resolved in `engine` and passed to `compact({ summaryProfile })`. Fall back to the session profile if resolution fails, with a `compaction.end` warning field. `generateSummary` (`:380`) already takes a profile — use it.
- **Acceptance:** with a valid second profile, summary requests hit that model's baseURL (assert with a mock HTTP server); an invalid id falls back and warns.
- **Test:** extend `test/core-test.mjs`.

#### V-21 — Background compaction (flagged)
- **Files:** `core/agent/loop.js`, `core/agent/compaction.js`
- **Change:** when `compaction.background: true`, at 85 % of the threshold start `generateSummary` in a detached promise (`engine._bgCompaction.set(sessionId, promise)`); at the threshold, if the promise resolved and the head boundary is still valid (`cutIsSafe` re-check), swap it in; otherwise compact synchronously exactly as today. Drop held summaries on model switch, session delete, and process exit.
- **Acceptance:** with the flag on, a threshold crossing does not add summary latency; a concurrent history change invalidates the held summary and falls back; with the flag off behaviour is byte-identical to today.
- **Test:** `test/core-test.mjs` with a fake slow LLM.

#### V-22 — Native compaction for `openai-responses` (optional)
- **Files:** `core/llm/openai-responses.js`, `core/agent/compaction.js`
- **Change:** profile flag `compaction: "native"` → send the conversation to the provider's compaction endpoint, store the returned opaque item as a `summary` message with `native: true`, keep the recent tail. Not portable across models: on model switch, discard and fall back to a summary.
- **Acceptance:** a mocked native response is replayed verbatim on the next request; switching model discards it.
- **Test:** extend `test/core-test.mjs`.

---

### P4 — Differentiation (keep what OpenCode does not have)

#### V-23 — File snapshots + `/undo`
- **Why:** OpenCode has `/undo`; your `revertSession()` (`core/engine.js:169`) only reverts messages. Combining the two is your differentiator (plus your checkpoint UI).
- **Files:** `core/store/snapshots.js` (new), `core/tools/index.js` (`write` `:55`, `edit` `:78`), `core/engine.js`, `electron/backend.cjs`
- **Change:**
  1. Before a write/edit, copy the current file (or a "did not exist" marker) to `~/.vibe/snapshots/<session>/<step>/<hash>`.
  2. `revertSession(id, msgID)` also restores every snapshot after that message index, in reverse order.
  3. Add `engine.revertFiles(id, msgID)` and a UI confirm. Shell-driven changes are explicitly **out of scope** — say so in the UI copy.
  4. Cap storage: 50 MB per session, prune oldest.
- **Acceptance:** edit a file → revert the message → file content is byte-identical to before; a created file is deleted; untracked/outside-workspace files untouched.
- **Test:** new `test/snapshots-test.mjs`.

#### V-24 — Keep these, do not regress
These are **products of your engine**, not gaps. Any task that weakens them fails review:
duplicate-call guard (`loop.js:247-261`), stuck detection, orphan-run protection (`isOrphan`), `forceStop` safety net, background shell jobs + Ctrl+B, compaction checkpoint card with before/after tokens and llm/fallback source, `.vibe-scratch` discipline, screenshot retention in history, language-matching system rule.

---

## 5. Complete verification checklist

Run this **at the end of every phase**, and again after the last task. Do not mark a phase ✅ without it.

### 5.1 Automated

```powershell
cd VibeCoderAI-live-provider-browser-fixed\VibeCoderAI-live-fixed
node --version                 # must be >= 20
npm test                       # core + skills + electron smoke + compaction UI regression
```

Expected: all four suites pass, zero non-zero exits.

New suites that must exist by the end:

```powershell
node test/subagent-isolation.mjs
node test/agents-test.mjs
node test/snapshots-test.mjs
```

### 5.2 Static checks

```powershell
# no new runtime dependency
node -e "const p=require('./package.json'); if(Object.keys(p.dependencies||{}).length) { console.error('FAIL: runtime deps'); process.exit(1) } else console.log('OK: zero runtime deps')"

# every tool still has the required shape
node -e "const t=require('./core/tools'); for (const x of t.ALL) for (const k of ['name','description','parameters','perm','paths','run']) if (x[k]==null) { console.error('FAIL', x.name, k); process.exit(1) } console.log('OK: tool shape', t.ALL.length)"

# compaction invariants still hold
node -e "const c=require('./core/agent/compaction'); console.log('OK: exports', ['compact','needsCompaction','pickSafeCut','cutIsSafe'].every(k=>typeof c[k]==='function'))"
```

### 5.3 Manual — CLI

```powershell
node cli/vibe.js models
node cli/vibe.js run -m groq-gpt-oss-120b "list the files in core and summarise each in one line"
node cli/vibe.js serve --port 4096          # then Ctrl+C
```

Check: streaming text arrives, no unhandled rejection, session file written to `~/.vibe/sessions/`.

### 5.4 Manual — Desktop app

```powershell
npm run dev
```

Walk this list and tick every line:

- [ ] New session starts, model picker shows the configured provider.
- [ ] A prompt streams text and at least one tool call renders as a card.
- [ ] Stop during streaming → run ends, session is immediately usable again.
- [ ] Permission prompt appears for `write` outside the allowlist; "once", "always", "deny" all behave.
- [ ] `browser.tabs.open` → tab appears in the dock → `browser.snapshot` → `browser.click` works.
- [ ] `browser.screenshot` renders inside the tool card and opens the viewer on click.
- [ ] Subagent spawns → parent chat keeps working → completion notice arrives → `subagentResult` returns the text.
- [ ] Long run triggers compaction → checkpoint card shows before/after tokens and source; the run continues.
- [ ] Forced compaction failure shows the existing failure card and blocks the next request (regression from `README`).
- [ ] Settings → provider add/edit → model list refreshes without restart.
- [ ] Restart the app → sessions, providers, and keys are all still there.

### 5.5 Security spot-checks

- [ ] `npm run evil` (a script that would be harmless) triggers a permission prompt.
- [ ] `echo hi && rm -rf /` is denied at the second sub-command.
- [ ] `browser.evaluate` asks every single time, even after "always".
- [ ] `~/.vibe/auth.json` is never present in any tool output, event payload, or log line.
- [ ] Reading `**/.env` asks; `**/.env.example` does not.

### 5.6 Perf sanity

- [ ] A 100-message session opens in under 1 s.
- [ ] A compaction on a 60 K-token session completes and the UI updates without freezing.
- [ ] `browser.snapshot` on a large page returns in under 3 s.

### 5.7 Packaging

```powershell
verify-and-build.bat
```

- [ ] `npm ci` + `npm test` pass inside the script.
- [ ] The NSIS installer builds into `release/`.
- [ ] Install → launch → a first prompt works on the packaged EXE.

---

## 6. Status table

| ID | Task | Phase | Status | Notes |
|---|---|---|---|---|
| V-01 | Isolate subagent history | P0 | ⬜ | |
| V-02 | Fix mcp/plugin subagent tools | P0 | ⬜ | |
| V-03 | Browser refs → main process + generation | P0 | ⬜ | |
| V-04 | `browser.evaluate` never persists | P0 | ⬜ | |
| V-05 | Close shell permission hole | P0 | ⬜ | |
| V-06 | Last-step summarisation | P0 | ⬜ | |
| V-07 | Agent definition loader | P1 | ⬜ | |
| V-08 | Permission rule shape upgrade | P1 | ⬜ | |
| V-09 | `browser.wait` + navigate readiness | P1 | ⬜ | |
| V-10 | `question` tool | P1 | ⬜ | |
| V-11 | Subagent upgrades | P1 | ⬜ | depends V-01, V-07 |
| V-12 | Plugin hooks | P1 | ⬜ | |
| V-13 | Browser search / console / network | P2 | ⬜ | |
| V-14 | Browser upload / download | P2 | ⬜ | |
| V-15 | Accessibility-tree snapshots | P2 | ⬜ | |
| V-16 | Browser dialog handling | P2 | ⬜ | |
| V-17 | Browser perf trace | P2 | ⬜ | optional |
| V-18 | Configurable compaction | P3 | ⬜ | |
| V-19 | Compacted-history archive | P3 | ⬜ | |
| V-20 | Separate summary model | P3 | ⬜ | |
| V-21 | Background compaction | P3 | ⬜ | flagged |
| V-22 | Native compaction (responses) | P3 | ⬜ | optional |
| V-23 | File snapshots + `/undo` | P4 | ⬜ | |
| V-24 | Regression guardrail (no task) | — | ✅ | review checklist |

---

## 7. Do NOT do (out of scope, time sinks)

- Rewriting into an OpenCode-style client/server with a background service. The Electron in-process model is correct for this app.
- Adding full LSP. If code intelligence is needed, add a `diagnostics` tool that shells out to `tsc --noEmit`, `eslint -f json`, or `cargo check` and parses the output.
- Restructuring `renderer/app.js` (293 KB). Only surgical edits, one feature at a time.
- Replacing JSON session storage with SQLite.
- Renaming `bash` → `shell`, `subagent` → `task`, or any existing event name. Aliases exist (`loop.js:58-84`) — do not expand the surface.

---

## 8. Changelog

| Date | Task | Agent | Summary |
|---|---|---|---|
| 2026-10-30 | — | planner | Plan created from a code-level comparison against OpenCode V2 docs (agent loop, browser, subagents, compaction). |
