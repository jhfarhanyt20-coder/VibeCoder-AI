# VibeCore Harness — Implementation Tracker

> এই ফাইলটাই আমাদের main progress memory. Limit শেষ হলে বা নতুন session শুরু হলে
> প্রথমে এই ফাইল পড়বে, তারপর প্রথম unchecked phase থেকে কাজ শুরু করবে।
> প্রতিটা phase শেষে "Progress Log" আপডেট করবে।

Last updated: 2026-11-22
App root: `VibeCoderAI-live-fixed`
Git root: `C:\Users\farhan\Downloads\VibeCoderAI-live-provider-browser-fixed`
Git HEAD at start: `41bf358`

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

শেষ full test run: **2026-11-18 — সব pass**

```text
npm test
shell-output-regression.cjs    PASS (100,000 chars, ordered)
core-test.mjs                 131 passed
agents-test.mjs                11 passed
skills-test.mjs                 8 passed
harness-test.mjs               23 passed
cli-test.mjs                   16 passed
electron-backend-smoke.cjs     138 IPC handlers
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
| Agent loop | **Pulse** | `core/agent/loop.js` |
| Context builder | **Loom** | `core/harness/loom.js` |
| Default persona | **Pilot** | `.vibe/personas/pilot.md` |
| Planning persona | **Architect** | `.vibe/personas/architect.md` |
| Read-only explorer | **Scout** | `.vibe/personas/scout.md` |
| Coding helper | **Maker** | `.vibe/personas/maker.md` |
| Review helper | **Inspector** | `.vibe/personas/inspector.md` |
| Web helper | **Researcher** | `.vibe/personas/researcher.md` |
| Subagent system | **Crew** | `core/subagents/index.js` |
| Skills | **Playbooks** | `.vibe/playbooks/<id>/PLAYBOOK.md` |
| Slash commands | **Recipes** | `.vibe/recipes/*.md` |
| Permission rules | **Guardrails** | `core/harness/guard.js` |
| Hard deny rules | **Locks** | `core/harness/locks.js` |
| Snapshots | **Rewind** | `core/store/snapshots.js` |
| Compaction | **Weave** | `core/agent/compaction.js` |
| Project instructions | **Brief** | `VIBE.md` + `.vibe/briefs/` |
| MCP | **Connectors** | `core/harness/connectors/` |
| Plugins | **Extensions** | `core/harness/extensions.js` |
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
Rewind APIs; 138 IPC handlers pass preload coverage.

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
- [x] optional `skin.css` loaded after `theme.css` (visual only)
- [x] remove the last inline style attribute so CSP `style-src 'self'` passes
- [x] regression test forbids future inline styles in renderer HTML

**Phase 13 result:** done (+2 core tests; full suite green). The terminal stream
is now part of the model context: no user copy/paste is required to explain a
stuck or long-running process. The optional skin is a separate stylesheet, so
the renderer stays compliant with `style-src 'self'`.

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
| 2026-11-06 | Hotfix | optional Graphite skin + CSP-safe update bar | no inline styles; full suite green |
| 2026-11-06 | Release | `v0.3.5` skin + CSP fix | CI green; installer + `latest.yml` + blockmap uploaded |
| 2026-11-07 | Hardening + UI | lossless UTF-8/large shell stream + real exit codes; English-only UI; Obsidian as an additive theme; sidebar collapse; semantic warnings; font slider persistence | 120 core; 11 agents; 8 skills; 23 harness; 125 IPC; full suite green |
| 2026-11-07 | Release | `v0.3.6` reliable shell output + Obsidian/UI hardening | CI green; installer (115,673,926 bytes) + `latest.yml` + blockmap uploaded; latest updater metadata verified |
| 2026-11-15 | UI + CLI | Obsidian UI font slider scales every size (`--fs-scale`); sidebar history scroll containment kept; terminal `vibe` gets full event renderer, question forms, subagent/shell rows, `@file`, `--json` and `skills/agents/mcp/plugins/tools/doctor/usage` commands | +12 CLI tests; 23 harness tests; full `npm test` green |
| 2026-11-15 | Full terminal workbench | same-store controls, Crew/shell lifecycle, shared-client form replies, private history, themes/pickers/multiline, safe installs, Rewind, per-session model keys, standalone CLI archive; provider heading de-duplicated without changing the desktop composer | final 19 suites green: 120 core, 11 agents, 8 skills, 23 harness, 14 controls, 14 CLI commands + 23 runtime tests, 129 IPC; real Electron fonts/provider/sidebar checks passed; review archive built; owner acceptance pending |
| 2026-11-18 | Desktop providers + Fallback model | cross-provider ordered fallback chain with sticky cursor/wrap, per-model context and compaction, Popular providers stay green in place, AgentRouter Responses + client compatibility, clear content-filter errors, faster provider switching | +5 core tests; 125 core; full suite green |
| 2026-11-18 | Release | `v0.3.12` Fallback model + provider upgrades | workflow run `44148751825` succeeded; installer `115730294` bytes, blockmap, `latest.yml`, CLI `0.3.12`; installer SHA-512 matched |
| 2026-11-18 | Repo + website | professional README, screenshots, issue/security/support templates, GitHub description/topics/homepage, website Fallback section + SEO/robots/sitemap | website `721f4ed`; website tests 18/18 |
| 2026-11-18 | Security hardening | project plugins/extensions/MCP trust gate with per-workspace approval; shell newline/`&`/dynamic-syntax permission checks; grep secret-file guard; frameless window IPC/navigation/webview hardening; provider-key origin separation; IPC sender checks; updater no longer installs silently on quit | core 128; control 14; Electron smoke 136 IPC; full suite green |
| 2026-11-18 | Secret-at-rest + trust UI | owner-only session/snapshot/trail/shell/audit files; secret files skipped in snapshots; 50 MB shell log cap; attachment allowlist cleared on session switch; origin-scoped browser approvals with one-shot unknown origins; HTTPS-only remote MCP; Settings trusted-workspace list with Revoke; inert settings marked coming soon | core 131; Electron smoke 138 IPC; full suite green |
| 2026-11-18 | Build toolchain | `electron-builder` 25.1.8 → 26.18.0 (dev/build only; runtime dependencies unchanged); audit has no critical issues; `win dir` and NSIS installer builds verified locally | package/lock updated; nsis `VibeCoderAI-v2-0.3.12.exe` built; signing still skipped (no certificate) |
| 2026-11-18 | CLI parity | `vibe fallback` (show/add/remove/use/set/clear) and `-m group:fallback`; `vibe trust list` and `vibe trust revoke`; help/chat help and README updated | cli-test 16 (2 new); all 131 core green |
| 2026-11-18 | Sign in with VibeCoder | sidebar account button opens the website `/connect` page (device code, Allow); encrypted app token; free VibeCoder models kept as the "VibeCoder AI" provider (real model names, FREE and image badges, searchable), refreshed at start and every 30 min; Logout revokes the token on the website; existing `authStatus`/`authConnect`/`authDisconnect` IPC made real (no new IPC names). Sign-in/account on the website (Render); chat and model list via the gateway host (Railway, `electron/vibecoder-account.cjs` `DEFAULT_GATEWAY_URL`), because Render's edge firewall blocks some coding-agent request bodies | new `test/vibecoder-account-test.cjs` 8/8; Electron smoke 138 IPC; full suite green; live chat verified through the gateway |

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

## 11. Approved timeline and pending attachment release — 2026-11-12

- Unified activity summary with chronological mixed tool/thinking rows; saved per-category grouping/collapse preferences. No category-by-category summary headers.
- Pending composer messages carry image/file snapshots through the trusted backend and safe model boundary; attachment-only messages are supported.
- Jump-to-latest control lives in the gutter to the right of the composer.
- The no-compiler diagnostics fixture is isolated from ancestor TypeScript installs; production compiler resolution is unchanged.
- Owner reviewed the running app and explicitly approved desktop/website push and release. Next patch is 0.3.9; public desktop update feed and private website source remain separate.
- Full desktop tests and isolated Electron timeline checks passed before approval. Release verification is repeated after the version bump; release success still requires verifying the workflow and published installer/update assets.
- See the latest separate verified changes backup for final verification results. The original recovery snapshot is not overwritten.
- Release completed: desktop `5d5a5c0`, tag `v0.3.9`, Actions run `43275999969` succeeded; installer, blockmap and latest.yml verified, including the downloaded installer's SHA-512.
- Private website `58e62f6` deployed successfully on Render (`dep-dbr0130ae00c739op0hg`); 17 tests and live browser smoke passed. Website uses the current 0.3.9 fallback when upstream metadata is unavailable. Real Google sign-in still requires an owner check; no credentials were used by automation.
- Owner asked for the next patch in the main desktop project only, including the existing local prompt-style change. Version is 0.3.10. Local ZIP files stay uncommitted and are excluded from the installer. No files are written to `D:\All Product`.
- Release completed in the main project: commit `bb044c9`, tag `v0.3.10`, Actions run `43600427906` succeeded. Installer, blockmap and `latest.yml` were verified, including the downloaded installer's SHA-512.

## 12. Terminal CLI and small UI fixes — 2026-11-15

- Main task: standalone full-feature terminal access to the same VibeCore engine.
  Durable parity/architecture/runbook: `docs/CLI.md`. Resume that file for this
  task rather than guessing from the older harness backlog.
- Obsidian font slider now scales all skin text; earlier history/footer fix stays.
- Owner explicitly said to keep the current composer/model list: remove only
  duplicated provider name/ID headings, not model IDs or selection behaviour.
- No new runtime dependency. Core/SDK changes are additive; original commands,
  API routes, tool IDs, permission/Locks, updater and renderer bindings remain.
- CLI themes/prefs live in `cli.json`, not desktop UI state. `vibe attach` uses
  the real host/browser and encrypted private local connection records.
- The public tag-only release workflow adds an independent Node CLI `.tgz`;
  desktop installer, blockmap, latest.yml and manual in-app updates remain.
- The first full regression caught a lightweight Engine host compatibility
  issue; `targetProfile()` fallback fixed it and the full suite subsequently passed.
  Real Electron QA used isolated mock data, not owner credentials.
- Owner review is still required. **No commit/push/tag/version bump was performed.**
  Version stays 0.3.10; next approved release is exactly 0.3.11.
- Final `npm test`: all 19 suites green (14 CLI command + 23 runtime + 14 control
  tests, archive/provider checks and every existing core/Electron/UI/updater suite).
- Source app left open for review (`sh_1e02095d1001quffzx0t3iTHz0`); separate CLI
  attached in Desktop (PowerShell 9848 / Node 6368). Real host doctor succeeded;
  no paid prompt or credential disclosure. Review archive/evidence locations and
  checksum are in `docs/CLI.md`.
- Owner rejected the initial console look (blue PowerShell/log-like layout) and
  approved a CLI-only full-screen visual pass. Active plan is `docs/CLI_TUI.md`.
  Preserve all the verified feature/API paths and the desktop design. Keep the
  old review terminal/messages; show the new UI in a separate window.
- 2026-11-16 full-screen pass: dark cell canvas, fixed composer, contextual
  panel, centered pickers/forms, mouse scroll, saved Full Access, and Windows
  paste (Ctrl+V clipboard fallback, right-click, bracketed paste one draft).
  `/provider` and `vibe provider` manage providers end-to-end without desktop.
  Final `npm test`: 21 suites green (15 screen + 5 provider cases added).
  Live review window: PowerShell 7268 / Node 5832.
- 2026-11-16 owner approved push/release and the website update. Version is
  exactly **0.3.11** (from 0.3.10); tag `v0.3.11`. `npm test` green after the
  bump (21 suites). The website gained a CLI page (`/cli`), a public
  `/download-cli` route backed by the tagged `VibeCoder-CLI-0.3.11.tgz` asset,
  new-feature copy, and a GitHub issue/ complaint path for users. Website source
  stays in the separate private `VibeCoder-AI-Website` repo; the local
  `website/` folder is not committed here.
- Release verified: commit `199dd2f`, tag `v0.3.11`, Actions run
  `43834310078` succeeded. Published assets: installer `115721226` bytes,
  blockmap, `latest.yml` and `VibeCoder-CLI-0.3.11.tgz` (`209472` bytes);
  both download URLs return HTTP 200.
- Website verified live at `https://vibecoderai.onrender.com`: `/cli` serves
  the CLI page, `/download-cli` redirects to the tagged `.tgz`, and the
  footer/FAQ/CLI support section links users to GitHub Issues for problems and
  complaints. Website commit `703f2bb` pushed to `main`.

## 13. Releases 0.3.19 and 0.3.20 — 2026-11-22

- **0.3.19** (commit `17bd868`, tag `v0.3.19`, run `44913166157`): all four assets
  uploaded by the workflow. See VIBE.md "Release history notes" for 0.3.15 (tag
  without a release), the hand-uploaded 0.3.17/0.3.18 assets and the removed
  duplicate releases.
- **0.3.20** (commit `5119d2e`, tag `v0.3.20`, run `44936878289`, owner approved):
  - chat: one wheel step up stops following until the user scrolls back to the
    very bottom or presses the jump arrow; the steady chat never puts back a
    scroll the user made; its spare space closes by itself (no blank screen after
    a folding Thinking box or a finished run) and only while nothing is arriving,
    so the chat no longer goes down and up while text streams
    (`renderer/app.js`, `renderer/chat-steady.js`);
  - Facebook: `facebook_edit_post`, `facebook_delete` (never the Page or the
    account), `facebook_hide_comment`, `facebook_upload_photo`,
    `facebook_update_page`, Messenger replies up to 7 days with the Human Agent
    tag; every public change or deletion asks first.
- Meta Login configuration (checked 2026-11-22): `pages_messaging`,
  `pages_manage_engagement` and `pages_manage_metadata` are already in the
  configuration. `human_agent` cannot be added there: it needs Meta App Review.
  Until then Messenger replies work only within 24 hours of the person's last
  message.

### 0.3.20 release checklist (done)
- [x] Owner approved the release.
- [x] `package.json` and both root entries of `package-lock.json` 0.3.19 → **0.3.20**.
- [x] `npm test` green from `VibeCoderAI-live-fixed`.
- [x] Only the intended files committed; `master` pushed.
- [x] Tag `v0.3.20` pushed.
- [x] Release run `44936878289` succeeded.
- [x] One release with `.exe` (122122916 bytes), `.exe.blockmap` (129390),
      `latest.yml` and `VibeCoder-CLI-0.3.20.tgz` (307420), all by
      `github-actions[bot]`.
- [x] `releases/latest/download/latest.yml` shows `version: 0.3.20`.
- [x] VIBE.md "Current release" and this section updated.
- [x] Website "What's new" updated (website commit `4413ec5`).

## 14. Releases 0.3.21 (not published) and 0.3.22 — 2026-11-22

- **0.3.21** (commit `bdac845`, tag `v0.3.21`, run `45032801303` failed in the test
  step): no GitHub Release. Cause: `test/tool-audit-fixes-test.cjs` and
  `test/shell-review-fixes-test.cjs` read `core/tools/index.js` and matched `
}
`;
  the Windows runner checks files out with CRLF. Fixed by normalising `
`; the
  whole suite was then run once on a CRLF copy of the tree before tagging again.
- **0.3.22** (commit `a52b0c8`, tag `v0.3.22`, run `45033548888`, owner approved):
  - close button hides the app in the Windows tray; tray menu Open / Quit
    (`electron/main.cjs`, `test/tray-close-test.cjs`);
  - shell: `exit code N` label, python -c / node -e quoting hint, shellOutput shows
    a redirected log's tail (UTF-16 aware), no deleting `./.vibe-scratch` while a
    running shell uses it (`test/shell-review-fixes-test.cjs`);
  - Computer Use: shifted element numbers reported, Enter in chat/mail apps asks,
    cursor drift without input does not pause, idle-off and `computer_done`;
  - browser: per-tab permission host (unknown site always asks, never saved),
    actions report URL/title/generation, evaluate/snapshot clipped
    (`test/browser-tools-test.cjs`; `test/core-test.mjs` updated for the new rule);
  - Facebook/GitHub: tokens redacted, 30 s / 10 min timeouts, `github_api` asks before
    merge/ref/content writes (query strings no longer bypass), ad money in real
    units, new insights metrics, `github_files` line ranges and binary detection;
  - apply_patch reads `patch`/`input`, webfetch head/`<link>` cleanup, Bangla help
    topics, `memory` asks unless the user asked to remember, clearer hints
    (`test/tool-audit-fixes-test.cjs`);
  - Running panel: shell commands only, collapsible terminal cards; Shell chip.

### 0.3.22 release checklist (done)
- [x] Owner approved the release.
- [x] `package.json` and both root entries of `package-lock.json` → **0.3.22**.
- [x] `npm test` green from `VibeCoderAI-live-fixed` (and on a CRLF copy).
- [x] Only the intended files committed; `master` pushed.
- [x] Tag `v0.3.22` pushed.
- [x] Release run `45033548888` succeeded.
- [x] One release with `.exe` (122135396 bytes), `.exe.blockmap` (129544),
      `latest.yml` (348) and `VibeCoder-CLI-0.3.22.tgz` (318431), all by
      `github-actions[bot]`.
- [x] `releases/latest/download/latest.yml` shows `version: 0.3.22`.
- [x] VIBE.md "Current release" and this section updated.
- [x] Website "What's new" updated (website commits `cf3d5fd`, `ac47512`); `/api/release` shows 0.3.22.
- [x] README (root and engine) updated.

## 15. Release 0.3.23 — 2026-11-23

- **0.3.23** (commit `a89caf9`, tag `v0.3.23`, run `45154487271`, owner approved):
  - security audit fixes: `core/perm/builtin.js` (anchored built-in bash rules,
    scratch-clean), `core/agent/loop.js` (`checkPermissions`: flags per segment,
    one prompt per compound command via engine `precheck`/`persistAs`, block-aware
    `splitCommand`), `core/agents` + `core/plugins` + `core/harness/trust.js`
    (repo files confined until trusted), `core/computer` + `core/tools/computer.js`
    (Win+R/console/launch/unnamed-click checks), `core/tools/browser.js` (risky
    clicks, secret fields), `core/store/secrets.js` (stdin), `core/harness/guard.js`
    (redaction), `core/llm/*` (no key on redirect/origin change, http only for
    LAN), `electron/vibecoder-account.cjs` (gateway allow-list),
    `renderer/markdown.js` + `electron/main.cjs` (no //host or file: URLs);
  - Electron 45.4.1, electronFuses (runAsNode kept: diagnostics uses
    ELECTRON_RUN_AS_NODE; cookie encryption NOT enabled: one-way), dev scripts
    excluded from the installer; release.yml least privilege, persist-credentials
    false, actions pinned to SHAs;
  - `renderer/chat-steady.js`: peakTotal is the real height (a big fold no longer
    leaves the chat stuck at the top);
  - `test/renderer-app-source.cjs`: tests read the renderer source through it
    (prepares splitting `renderer/app.js` into ordered parts).
- Verified before tagging: `npm test` green, the suite on a CRLF copy, a local
  installer build started with the fuses, and the dev app driven with a scripted
  local model (one prompt per command, risky delete asked, //host image dropped).
- Open: old PowerShell 4104 events from before 0.3.23 may still hold key
  material; clearing that log needs the owner's approval.

### 0.3.23 release checklist (done)
- [x] Owner approved the release.
- [x] `package.json` and both root entries of `package-lock.json` → **0.3.23**.
- [x] `npm test` green (and on a CRLF copy); local installer build OK.
- [x] Only the intended files committed; `master` pushed.
- [x] Tag `v0.3.23` pushed; release run `45154487271` succeeded.
- [x] One release with `.exe` (122168389), `.exe.blockmap` (129114), `latest.yml`
      (348) and `VibeCoder-CLI-0.3.23.tgz` (340716), all by `github-actions[bot]`.
- [x] `releases/latest/download/latest.yml` shows `version: 0.3.23`.
- [x] VIBE.md "Current release" and this section updated; README (root + engine).
- [x] Website "What's new" (`0ed96e6`) and sign-in page (`3e1ecca`) updated.

## 16. Release 0.3.24 — 2026-11-23

- **0.3.24** (commit `9229f7e`, tag `v0.3.24`, run `45167261565`, owner approved):
  - `core/llm/cache.js`: caching rules by API format only (no provider/model
    names). Anthropic (`anthropic.js`: tools, system, newest block) and OpenAI
    Chat (`openai-chat.js`: system, newest message) send `cache_control`; a 400
    while marked is retried once without marks unless it is clearly a
    context/rate/key/model error (`mayBeAboutMarks`), and an endpoint that
    only works without marks is remembered for the app session. Responses:
    automatic prefix caching. `quirks.promptCache: false` opts a profile out.
  - `core/agent/loop.js`: the final step keeps system prompt and tools, sends no
    tool_choice (measured: it breaks Gemini's cache; Anthropic documents the
    same) and adds the closing note at the end of the request only
    (`withFinalNote`). Adapters still accept `toolChoice` for callers.
  - Real-endpoint check of the final step: AMD Anthropic 8448/8578, AMD OpenAI
    8448/8580, Agnes 8960/9065, AgentRouter Responses 6105/6108, Gemini 3987
    (implicit, partial). A reasoning model needs a normal output limit for the
    closing summary (a 400-token test limit gave empty replies).
  - `core/perm/remember.js`: "Always allow" remembers command families
    (`prefix` rules, matched on clean tokens via core/perm/builtin.js tokenize);
    the prompt carries `remembers` (app card + CLI dialog).
  - `core/tools/editkit.js`: typography-normalized matcher (1:1 char map).
  - `renderer/app.js` split into `renderer/app/*.js` (same code, load order in
    index.html; `startNewProvider` listener looked up on click);
    `test/renderer-app-source.cjs` joins the parts for tests.
- Verified before tagging: `npm test` green and on a CRLF copy; local installer
  build contains renderer/app/* and core/llm/cache.js and starts with no
  startup errors.

### 0.3.24 release checklist (done)
- [x] Owner approved the release.
- [x] `package.json` and both root entries of `package-lock.json` → **0.3.24**.
- [x] `npm test` green (and on a CRLF copy); local installer build OK.
- [x] Only the intended files committed; `master` pushed.
- [x] Tag `v0.3.24` pushed; release run `45167261565` succeeded.
- [x] One release with `.exe` (122172965), `.exe.blockmap` (129270), `latest.yml`
      (348) and `VibeCoder-CLI-0.3.24.tgz` (346092), all by `github-actions[bot]`.
- [x] `releases/latest/download/latest.yml` shows `version: 0.3.24`.
- [x] VIBE.md "Current release" and this section updated; README (root + engine).
- [x] Website "What's new" updated.

### Next release (0.3.25): see section 17.

## 17. Release 0.3.25 — 2026-11-24

- **Computer Use works like a person at the desk** (checked live with Agnes 2.5
  Flash on Notepad: open, type, verify by screenshot, close without saving):
  - `electron/backend.cjs`: during computer use the window becomes a narrow
    always-on-top side panel (`sideWindowBegin`/`sideWindowEnd`) and gets its
    exact size, position and maximized state back after computer_done / run end.
    `computerUse.windowMode: "minimize"` keeps the old taskbar behaviour. The
    overlay covers the whole screen: a soft edge glow plus the label a little
    above the middle; `beforeCapture`/`afterCapture` hide it for the moment of
    an agent screenshot.
  - `core/tools/computer.js`: screenshots are plain pictures (`draw: false`, the
    helper still scans); each numbered element lists `at (x, y)` in the image.
    A click/drag on VibeCoder's own panel is refused; a screenshot first brings
    the worked-on app back to the front when the panel is in front.
  - `core/agent/loop.js` + GUIDE: the plan → open → look → batch → verify →
    handle dialogs → final screenshot → computer_done loop; a program started
    with bash must be seen with computer_screenshot before reporting on it.
  - `renderer`: `body.computer-side` hides the left bar in the panel.
- **One prompt per thing** (`core/engine.js`): two calls for the same tool and
  subject at once share one permission prompt (seen: two parallel edits of one
  file asked twice). Test: `test/one-prompt-test.cjs` case 5.
- **Shells chip**: "1 shell / 2 shells" chip, transparent blurred panel, one row
  per command (terminal icon, command, time, ×). Rows carry their `sessionID`:
  another chat or a new task never shows them, and Stop all only stops this
  chat's commands. New Task resets the running state (its first message was
  queued: "Session is not running").
- **Scroll**: the wheel over the empty space beside the chat column scrolls the
  chat (it did nothing while the left bar was open).
- `npm test`: 404 PASS.
- **Notifications like a professional tool** (`renderer/app.js` notifyAgent):
  only while the user is away from the app, and only for `done`, `permission`,
  `question`, `error` and `attention` (paused); progress ("finished a step",
  "retrying", owner verified) never notifies. The same message within 8 s shows
  once. Toasts are `silent` (no Windows sound); the app plays its own soft
  two-note Web Audio chime (`playChime`, Settings → Notification sound, with
  Play). Clicking a toast focuses the window and opens that chat
  (`notification.clicked`).
- **Ember theme** (default for new users; a saved choice is kept): warm dark
  surfaces, cream text, terracotta accent; VibeCoder's own palette
  (`theme.css`, `skin.css`, picker, `theme.js`, THEMES).
- Toasts slide away by themselves: `timeoutType: "default"` plus `close()` after
  3 s (task toasts) / 2.5 s (the one-time "still running in the tray" note, now
  a silent Notification with the app chime instead of the Windows balloon; the
  balloon stays as the fallback).
- Settings pages rebuilt from real data: **Keyboard Shortcuts** (grouped rows
  with key caps; Ctrl+, now opens settings; Ctrl+B no longer also toggles the
  left bar when it moved a blocking command), **Commands** (`commandsList`:
  recipes from `<home>/recipes` and `.vibe/recipes`, Open folder, how-to) and
  **Hooks** (`hooksList`: extensions with their declared hooks, the five hook
  moments, how-to).
- Provider icons: one style everywhere (`provMonogram` / `setProvIcon` in
  `renderer/app/models.js`, `.prov-ic.mono` in polish.css): two letters on a
  rounded tile (OpenAI → OA, Google Gemini → GG), no third-party logos; the
  preset `icon` field stays for compatibility but is no longer drawn.
- Built-in provider list: **AMD** (`https://developer.amd.com.cn/radeon/api/v1`, chat) added after Agnes AI; an existing custom AMD profile is matched by its base URL and now shows there as configured.
- Agnes AI preset base URL fixed to `https://apihub.agnes-ai.com/v1` (the old `api.agnes-ai.com/api/v1` answered 401 "Login expired" for API keys; checked: /models 200 on the new URL).
- VibeCoderAI account panel: Log in / Log out sits on the right of its header; when logged in the account's models are listed below (`renderVibecoderModels`, from the `vibecoder` profile or the picker). The `vibecoder` profile no longer shows under Custom providers.
- Connectors hub (left bar → Connectors): a "← Back" button at the top returns to the chat (the hub hides the settings menu with its Back to workspace); Esc does the same.
- Performance measured for the README/website (same PC, Task Manager memory):
  VibeCoder ~120 MB idle / ~130 MB working, ~0.5% CPU working (6% peak at the
  start); another AI coding desktop app ~540 MB idle; an AI chat/coding desktop
  app ~1,080 MB working.

### 0.3.25 release checklist
- [x] Owner approved the release (2026-11-24).
- [x] `package.json` and both root entries of `package-lock.json` → **0.3.25**.
- [x] `npm test` green.
- [ ] Commit, push `master`, tag `v0.3.25`, push the tag.
- [ ] One release with `.exe`, `.exe.blockmap`, `latest.yml` and the CLI `.tgz`.
- [ ] `releases/latest/download/latest.yml` shows `version: 0.3.25`.
- [ ] Website "What's new" + performance comparison.

### Next release (0.3.26): same checklist, one patch up, never skip.
