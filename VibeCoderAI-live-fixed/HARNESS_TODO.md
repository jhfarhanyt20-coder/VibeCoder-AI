# VibeCore Harness — Implementation Tracker

> এই ফাইলটাই আমাদের main progress memory. Limit শেষ হলে বা নতুন session শুরু হলে
> প্রথমে এই ফাইল পড়বে, তারপর প্রথম unchecked phase থেকে কাজ শুরু করবে।
> প্রতিটা phase শেষে "Progress Log" আপডেট করবে।

Last updated: 2026-11-04
App root: `VibeCoderAI-live-fixed`
Git root: `C:\Users\farhan\Downloads\VibeCoderAI-live-provider-browser-fixed`
Git HEAD at start: `9d8a18a`

---

## 1. Goal

আমাদের app-এর agent যেন একটা proper agentic harness-এর মতো কাজ করে:

- নিজে নিজে step-by-step কাজ করে, শুধু chat করে না।
- tool ব্যবহার করে পড়ে, খোঁজে, লেখে, চালায়, যাচাই করে।
- বিপজ্জনক কাজের আগে permission চায়; hard lock কেউ ভাঙতে না পারে।
- long conversation নিজে compress করে চালিয়ে যায়।
- ভুল হলে থেমে না গিয়ে error পড়ে নতুন পথ নেয়।
- বড় কাজ ছোট helper (Crew) দিয়ে ভাগ করে।
- প্রতিটা step保存/audit হয়, তাই crash হলেও কাজ হারায় না।
- file change undo করা যায়।
- সবকিছু আমাদের নিজের নামে; কারও নাম, code, prompt, text, asset কপি নয়।

**সবচেয়ে বড় নিয়ম:** কোনো existing feature ভাঙা যাবে না। যা যোগ করব, সেটা
additive হবে। ডিফল্টে পুরোনো behaviour বদলাবে না।

---

## 2. Baseline (এটা আবার check করতে হবে)

শেষ full test run: **2026-11-05 — সব pass**

```text
npm test
core-test.mjs                 117 passed
agents-test.mjs                11 passed
skills-test.mjs                 8 passed
harness-test.mjs               23 passed
electron-backend-smoke.cjs     125 IPC handlers
compaction-ui-regression       PASS
subagent-ui-regression         PASS
harness-ui-regression          PASS
app-update-ui-regression        PASS
app-updater-test                8 passed
```

প্রতিটি commit-এর আগে working tree inspect করতে হবে। User-এর unrelated local
file commit করা যাবে না; বিশেষ করে ignored local notes কখনও release tag-এ নয়।

---

## 3. Hard rules

1. `npm test` green না হলে commit নয়।
2. এক phase = এক commit (user বললে)।
3. নতুন runtime dependency নয়।
4. Unrelated dirty file touch/commit নয়।
5. পুরোনো session, tool, permission, update system ভাঙা যাবে না।
6. আমাদের code/UI/docs-এ কারও নাম/reference থাকবে না; clean-room naming।
7. প্রতিটা নতুন module-এর unit test থাকবে।
8. প্রতিটা phase-এর পর এই ফাইল আপডেট হবে।

---

## 4. Our naming (clean-room)

| Concept | Our name | Location |
|---|---|---|
| Whole harness | **VibeCore** | `core/harness/` |
| Agent loop | **Pulse** | `core/harness/pulse.js` |
| Context builder | **Loom** | `core/harness/loom.js` |
| Default persona | **Pilot** | `.vibe/personas/pilot.md` |
| Planning persona | **Architect** | `.vibe/personas/architect.md` |
| Read-only explorer | **Scout** | `.vibe/personas/scout.md` |
| Coding helper | **Maker** | `.vibe/personas/maker.md` |
| Review helper | **Inspector** | `.vibe/personas/inspector.md` |
| Web helper | **Researcher** | `.vibe/personas/researcher.md` |
| Subagent system | **Crew** | `core/harness/crew.js` |
| Skills | **Playbooks** | `.vibe/playbooks/<id>/PLAYBOOK.md` |
| Slash commands | **Recipes** | `.vibe/recipes/*.md` |
| Permission rules | **Guardrails** | `core/harness/guard.js` |
| Hard deny rules | **Locks** | `core/harness/locks.js` |
| Snapshots | **Rewind** | `core/harness/rewind.js` |
| Compaction | **Weave** | `core/harness/weave.js` |
| Project instructions | **Brief** | `VIBE.md` + `.vibe/briefs/` |
| MCP | **Connectors** | `core/harness/connectors/` |
| Plugins | **Extensions** | `core/harness/extensions/` |
| Event/audit log | **Trail** | `core/harness/trail.js` |

Project layout:

```text
VIBE.md
.vibe/
  config.json
  personas/
  playbooks/<id>/PLAYBOOK.md
  recipes/
  briefs/
  locks.jsonc
```

---

## 5. Phase checklist

### Phase 0 — Baseline + clean-room inventory
- [x] `npm test` baseline আবার confirm
- [x] compatibility naming inventory reviewed (legacy provider IDs/paths stay internal)
- [x] built-in persona rename map (Pilot/Architect/Scout/Maker/Inspector/Researcher)
- [x] built-in IDs kept stable, so existing sessions/config remain compatible
- [x] tests green

**Phase 0 result:** done. VibeCore's model-facing additions use only our names.
Legacy provider/config identifiers remain solely where removing them would break
an existing integration or stored project.

### Phase 1 — Trail + Locks (foundation, zero default behaviour change)
- [x] `core/harness/trail.js` — append-only JSONL event log, per session, bounded
- [x] `core/harness/locks.js` — load `~/.vibe/locks.jsonc` + project `.vibe/locks.jsonc`
- [x] Lock shape: `{ action, resource, effect: "block" }`; last match wins
- [x] Locks evaluated before normal rules; `block` cannot be overridden by "always allow"
- [x] `Engine._ask` integration: lock check first, then existing `decide(...)`
- [x] Trail events: existing `tool.start`, `tool.end`, `permission.*`, `compaction.*`, `done`, `error` etc.
- [x] Trail: explicit `run.start` / `step.start` / `step.end` events (completed in Phase 3)
- [x] `test/harness-test.mjs` — locks precedence, project override, trail write/read, old rules unchanged
- [x] add `node test/harness-test.mjs` to `npm test`
- [x] full tests green
- [x] update this file

**Phase 1 result:** done (6 new tests). Default behaviour unchanged: no lock file = old rules exactly.
Deferred to Phase 3: explicit run/step events for richer timeline.

**Phase 1 exact next step:** Phase 2 — `core/harness/loom.js` + `VIBE.md` brief hierarchy, additive to the existing prompt builder.

### Phase 2 — Loom (context)
- [x] layered brief: global `~/.vibe/VIBE.md` → project `VIBE.md` → nested briefs
- [x] stable section order for prompt cache
- [x] per-file + total character budget
- [x] `.vibe/briefs/*.md` per-folder notes
- [x] duplicate file protection
- [x] prompt integration (additive; no brief = unchanged prompt)
- [x] tests

**Phase 2 result:** done (2 new tests). `buildBrief()` is additive and cannot grant
permissions or override a lock.

### Phase 3 — Pulse (loop)
- [x] explicit `run.start` event
- [x] explicit `step.start` / `step.end` events (step number, finish, tools, tokens)
- [x] hard-lock denial reaches the model with a clear "blocked by a hard lock" message
- [x] integration test: lock blocks a real loop, model receives the denial, no command runs
- [x] parallel read-only actions (`read`, `list`, `grep`, `glob`), serial side-effect actions
- [x] permission checks stay sequential; results keep the model's call order
- [x] final-step summary (already exists; kept)
- [x] abort/crash recovery (already exists; kept)
- [x] tests for parallel scheduling (2 concurrent reads, order + stored history)

**Phase 3 result:** done (2 new loop tests). Only pure reads with more than one
call use the parallel path; every side-effect tool and every mixed batch stays
sequential, so permission and ordering semantics are unchanged.

### Phase 4 — Guardrails
- [x] unified rule shape + last-match semantics (already exists)
- [x] per-persona → session → global precedence documented/tested (`core/harness/guard.js`)
- [x] path jail + shell segment check (already exists; kept)
- [x] secret-file detection + free-text token redaction (Trail uses it)
- [x] audit every decision to Trail (`permission.decision` with tool, action, layer)
- [x] tests

**Phase 4 result:** done (3 new tests). Precedence is
`project → inherited → session → agent`, last match wins; agent rules still win
over an old "always allow". Trail strings now redact bearer tokens, key=value
secrets and known token prefixes, and every permission decision is audited.

### Phase 5 — Actions
- [x] uniform action contract: `{ output, isError, stats, artifacts }`, clipped output (string returns still work)
- [x] duration measured for every tool and attached to `tool.end`
- [x] `step` exposed to tools (used by Rewind)
- [x] formatters/diagnostics after edit (already exists; kept)
- [x] internal aliases (no model-facing foreign names; already exists)
- [x] tests

**Phase 5 result:** done (1 new test). Existing string-returning tools are
unchanged; richer tools can now return stats/artifacts and every tool result
reports a duration.

### Phase 6 — Crew
- [x] fresh-context child sessions (already exists; kept)
- [x] foreground/background (already exists; kept)
- [x] hard depth=1 + configurable per-parent parallel cap (`crewMaxParallel`, default 4)
- [x] permission inheritance (already exists; kept)
- [x] result contract (`ok`, `status`, `result`, `error`, `durationMs`) + foreground failure propagation
- [x] tests

**Phase 6 result:** done (1 new test). A parent can run four helpers by default
(configurable from 1–16); nested helpers remain impossible. Completed results now
carry stable success/error and duration metadata without changing old fields.

### Phase 7 — Playbooks + Recipes
- [x] `.vibe/playbooks/<id>/PLAYBOOK.md` discovery (global + layered project)
- [x] lazy catalogue/load + supporting files; legacy formats stay compatible
- [x] model-facing `playbook` action; legacy `skill` remains internal compatibility
- [x] `.vibe/recipes/*.md`, `$ARGUMENTS`/`$1…$9`, persona/model override
- [x] shell fences are reference-only and never executed by the recipe loader
- [x] recipe override survives run resume metadata
- [x] tests

**Phase 7 result:** done (+2 playbook tests, +2 recipe tests). Native Vibe paths
win precedence while old installations continue to load. Recipes expand only a
known slash command; unknown `/text` remains ordinary chat.

### Phase 8 — Rewind + Weave
- [x] per-step snapshots inside each turn (`ctx.step` → `snapshots.capture`)
- [x] per-turn + per-step undo/redo stack; new edits invalidate stale redo
- [x] bounded, secret-redacted diff preview
- [x] local/remote SDK routes for steps, preview, undo-step, redo and redo list
- [x] token accounting, keep-tail, iterative summary (already exists; kept)
- [x] overflow recovery (already exists; kept)
- [x] tests

**Phase 8 result:** done (+2 tests total). Existing turn undo remains compatible;
step rewind now keeps conversation/tool history aligned, redo restores both files
and dropped messages, and previews never expose recognized secret-file values.

### Phase 9 — Connectors + Extensions
- [x] local/remote connectors (existing transports kept; explicit Engine home fixed)
- [x] paged resource + template discovery, lazy resource reads and Connector read actions
- [x] OAuth Authorization Code + PKCE, in-memory tokens and `tokenEnv` bearer support
- [x] Connector OAuth/resource local + remote SDK routes
- [x] native `.vibe/extensions/*.js` + compatibility plugin folders
- [x] extension load/unload/event + before/after action hooks
- [x] tool catalogue frozen and audited per step (`step.start.tools`)
- [x] tests

**Phase 9 result:** done (+4 tests). OAuth verifiers/tokens are never written to
connector config; SDK clients drive start/complete/clear. Binary resources expose
metadata only, while text resources are loaded lazily. Extension hook failures
are isolated from the run.

### Phase 10 — UI + hardening
- [x] unified live timeline (Pulse step badge + existing tools/permissions/Crew rows)
- [x] permission card with action scope + hard-Lock notice
- [x] Crew panel (existing panel kept and regression-tested)
- [x] context meter + cost (existing meter kept)
- [x] Rewind UI: preview summary, step undo, turn undo and redo
- [x] action duration survives live events and history reload
- [x] Electron/preload wiring + UI regression
- [x] security checklist
- [x] docs

**Phase 10 result:** done. See `docs/VIBECORE.md` and
`docs/VIBECORE_SECURITY.md`. The Electron backend now exposes Trail and complete
Rewind APIs; 124 IPC handlers pass preload coverage.

### Phase 11 — Live Shell + Project Diagnostics
- [x] stream bounded shell output to the UI in real time
- [x] safe stdin / newline / EOF controls for running shell jobs
- [x] agent-facing shell input action with normal Guardrails
- [x] optional project-local TypeScript semantic diagnostics
- [x] explicit diagnostics action with graceful syntax-only fallback
- [x] Electron/UI/core regression tests

**Constraint:** no new runtime dependency. This phase adds a safe pipe-based
interactive layer, not a terminal emulator. Full PTY semantics remain optional
until an audited native PTY dependency is explicitly approved.

**Phase 11 result:** done (+3 core tests; full suite green). Shell output is
coalesced and bounded, stdin is size/session/writable-checked, and both UI and
agent can send Enter or EOF. TypeScript semantic diagnostics run in an isolated
bounded worker only when that project already provides TypeScript and after the
normal Guardrail decision; VibeCoder installs no package.

### Phase 12 — Usage Details + Durable Background Results
- [x] provider usage normalization for reasoning/cache read/cache write
- [x] prevent OpenAI nested-detail and Anthropic cache double-counting
- [x] preserve complete usage through live events and session reload
- [x] persist background command intent, command, status, exit and output
- [x] deliver completion outside expired run queues and auto-resume safely
- [x] detect `Press any key` / Enter / Y-N / credential prompts before completion
- [x] never auto-enter secrets; route ordinary answers through `shellInput`
- [x] preserve the existing desktop visual design (redesign canceled)
- [x] core/Electron/UI regression tests

**Phase 12 result:** done (+2 core tests; full suite green). The five existing
context rows now receive normalized provider values without changing the UI.
Background jobs retain why they ran and cannot silently finish in an expired
queue; interactive prompts reach the agent while the process is still alive.

### Phase 13 — Agent-Readable Terminal Stream
- [x] `shellList` shows every running/recent shell with state and exact command
- [x] `shellOutput` reads live output/status, with incremental `sinceBytes`
- [x] every real user prompt carries a bounded live snapshot of running shells
- [x] long background jobs report bounded progress at safe model boundaries
- [x] blocking foreground commands waiting for input move to the background
- [x] returned tool result includes the terminal tail that caused the wait
- [x] agent is instructed to read the stream itself, never ask for copy/paste
- [x] secrets still require the user; no auto-answer of passwords/codes
- [x] core/UI regression tests

**Phase 13 result:** done (+2 core tests; full suite green). The terminal stream
is now part of the model context: no user copy/paste is required to explain a
stuck or long-running process. The UI is unchanged.

---

## 6. Priority

```text
P0: Phase 0, 1, 2, 3, 4, 8
P1: Phase 5, 6, 7, 9
P2: Phase 10
```

Thin vertical slice first:
`Persona → Loom → Pulse → 4 core actions → Guardrails/Locks → Trail → UI`

---

## 7. Progress log

| Date | Phase | Result | Tests |
|---|---|---|---|
| 2026-11-04 | Baseline | সব pass | 110 + 11 + 6 + 7 |
| 2026-11-04 | Tracker created | `HARNESS_TODO.md` | — |
| 2026-11-04 | Phase 1 (part) | `locks.js` + `trail.js` + engine wiring | +6 harness tests, full suite green |
| 2026-11-04 | Phase 2 | `loom.js` + `VIBE.md` hierarchy + prompt integration | +2 tests, full suite green |
| 2026-11-04 | Phase 3 (part) | `run.start` / `step.start` / `step.end` + lock denial message | +1 test, full suite green |
| 2026-11-04 | Phase 3 | parallel read-only batch + ordering test | +1 test, full suite green |
| 2026-11-04 | Phase 4 | `guard.js` precedence + secret redaction + Trail decision audit | +3 tests, full suite green |
| 2026-11-04 | Phase 5 | `actions.js` uniform result contract + tool duration | +1 test, full suite green |
| 2026-11-04 | Phase 8 (part) | per-step snapshots + `listSteps` / `undoStep` | +1 test, full suite green |
| 2026-11-04 | Phase 6 | Crew depth + parallel cap + result metadata | +1 test, full suite green |
| 2026-11-04 | Phase 7 | native Playbooks + layered Recipes + run overrides | +4 tests, full suite green |
| 2026-11-04 | Phase 8 | step-aligned undo/redo stack + redacted diff preview + SDK routes | +1 test, full suite green |
| 2026-11-04 | Phase 9 | Connector resources/OAuth + Extension lifecycle + per-step tool snapshot | +4 tests, full suite green |
| 2026-11-04 | Phase 10 | Pulse/Lock UI + scoped permissions + Rewind menu + docs | +1 UI regression, full suite green |
| 2026-11-05 | Release | `v0.2.0` published to GitHub Releases | CI green; installer + `latest.yml` + blockmap uploaded; auto-update verified |
| 2026-11-05 | Release | `v0.3.0` App Updates manual check/download/install + release-page fallback | CI green; installer + `latest.yml` + blockmap uploaded; manual flow verified |
| 2026-11-05 | Release | `v0.3.1` corrected manual update to stay entirely in-app | CI green; installer + `latest.yml` + blockmap uploaded |
| 2026-11-05 | Phase 11 | bounded live shell + safe stdin + project TypeScript diagnostics | +3 core tests; 125 IPC handlers; full suite green |
| 2026-11-05 | Release | `v0.3.2` live shell + project diagnostics | CI green; installer + `latest.yml` + blockmap uploaded |
| 2026-11-05 | Phase 12 | detailed context usage + durable background completion/input prompts | +2 core tests; full suite green |
| 2026-11-05 | Release | `v0.3.3` usage details + durable/intelligent background shell results | CI green; installer + `latest.yml` + blockmap uploaded |
| 2026-11-06 | Phase 13 | agent-readable live terminal stream + blocking-prompt takeover | +2 core tests; full suite green |
| 2026-11-06 | Release | `v0.3.4` terminal output reaches the agent without copy/paste | CI green; installer + `latest.yml` + blockmap uploaded |

---

## 8. Resume instructions (limit শেষ হলে)

1. এই ফাইল পড়ো।
2. `npm test` চালাও — baseline green কিনা দেখো।
3. সব numbered phase complete হলে নিচের hardening backlog থেকে প্রথম item নাও।
4. ওই phase-এর ছোট ছোট sub-task শেষ করো।
5. Test green হলে phase tick + Progress Log update।
6. User-কে Bengali-তে সংক্ষেপে জানাও: কী হয়েছে, test result, পরের ধাপ।
7. কোনো unrelated dirty file commit করো না।

---

## 9. Follow-up hardening backlog

- [ ] Manual packaged-Electron click-through on Windows (Rewind menu, OAuth callback, extension reload).
- [ ] Persist Connector refresh tokens only after an OS-backed encrypted store is available; keep in-memory until then.
- [ ] Add richer per-file diff expansion to the Rewind menu (the bounded backend preview already exists).
- [ ] Retire legacy provider/config labels only in a dedicated migration that preserves stored IDs and paths.

---

## 10. What NOT to do

- একবারে পুরো harness rewrite নয়।
- existing `runLoop`, `tools`, `skills`, `subagents`, `snapshots` delete/rename নয় —
  আগে wrapper/adapter, পরে ধীরে ধীরে move।
- নতুন dependency নয়।
- foreign code/prompt/text/asset কপি নয়।
- test না চালিয়ে "done" বলা নয়।
