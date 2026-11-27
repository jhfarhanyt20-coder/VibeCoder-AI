# BDCoder CLI — parity, implementation and resume memory

> **Historical review record.** This document captures the CLI work as it was
> reviewed around v0.3.10–0.3.11. The current shipped version and test counts
> live in `package.json` and the root `VIBE.md`; treat the notes below as
> history, not as the current release state.

Status: **agent features verified; full-screen CLI visual pass in progress**
Last updated: 2026-11-15
App root: `VibeCoderAI-live-fixed/`
Entry point: `cli/vibe.js` (`bin: vibe`)

After a context reset: read root `VIBE.md`, `HARNESS_TODO.md`, then this file;
inspect Git status/log/tags and run `npm test` before editing.

**Do not commit, bump, push or tag this work without owner approval.** The owner
wants to see it running first. Version remains 0.3.10. The next release, when
approved, is exactly **0.3.11**, with matching package/lock versions and tag.
Ordinary commits are not app updates. Keep the public release feed public.

## 1. Scope and owner decisions

- The terminal exposes the existing VibeCore agent features, not a second
  engine or another product's code/UI/prompts.
- No runtime dependency was added. The editor, pickers, ANSI output, storage,
  archive builder and HTTP control layer use Node's standard library.
- Keep all existing commands/flags and legacy paths/tool IDs working. The
  original plain model-discovery columns remain available for scripts.
- Preserve the desktop visual design and every existing ID/event/IPC binding.
- Fix the Obsidian font slider first; preserve the earlier sidebar scroll fix.
- Owner clarified the provider-label change: keep the current composer/model
  choices exactly as they are, but remove the duplicate provider name + ID
  heading (`cloudfire · cloudfire` becomes `cloudfire`). **Do not remove model
  IDs or redesign the closed selector.** Terminal pickers use one provider name.
- Persist the plan so a context limit cannot lose the task.
- Owner subsequently rejected the sparse blue-console appearance and explicitly
  requested a professional full-screen CLI. Continue `docs/CLI_TUI.md`; the
  prior green tests describe the baseline, not approval of the visual design.

## 2. Run and install

From the app directory:

```powershell
npm run cli
# Or:
node cli/vibe.js chat
.\vibe.cmd chat
.\vibe.ps1 chat
```

Select a workspace/model:

```powershell
node cli/vibe.js chat -C C:\Projects\my-app
node cli/vibe.js run "Review @src/app.js" --agent explore --json --yes
node cli/vibe.js chat --theme obsidian
```

To share the **running desktop engine**, rather than start a second engine:

```powershell
node cli/vibe.js attach
node cli/vibe.js run "Review this project" --attach -C C:\Projects\my-app
node cli/vibe.js browser tabs --attach
```

Explicit connections accept `--url http://127.0.0.1:<port>` and `VIBE_TOKEN`.
Prefer the environment variable/automatic local discovery over putting tokens
in command-line arguments. Use a matching updated desktop/serve version.
Standalone chat never silently attaches to another process.

**Use attach for a session already live in the desktop app.** Separate engines
share disk stores but not live session caches. The same engine is the safe path
for simultaneous desktop/terminal interaction.

Build a dependency-free, npm-compatible release archive:

```powershell
npm run pack:cli
npm install -g ./release/BDCoder-CLI-<version>.tgz
vibe
```

The packer refuses to overwrite an existing archive. It ships only CLI/core/SDK
source, a CLI manifest, README and license: no Electron runtime, dependencies,
credentials, session data, ZIPs or build output. The existing tag-only release
workflow adds this archive **after** the normal desktop installer/update assets.
No package was published to npm and no release was created during this task.

## 3. Feature parity

✅ implemented · host = real desktop required · native = stays in the desktop.

| Feature | Terminal implementation |
|---|---|
| Chat/streaming, resume, diagnostics/tools | ✅ same SDK/Engine and tool registry |
| Personas/agents | ✅ list/show/install/remove, `--agent`, `/agent` picker |
| Skills/playbooks | ✅ discovery/load, local install/remove, GitHub import |
| Recipes | ✅ list/show/install/remove, `/recipe <id> args` and direct `/id` |
| Crew/subagents | ✅ live child events, list/details/result/start/resume/stop, capacity/toggle controls |
| Background shell jobs | ✅ live output, original intent/result delivery, output/input/EOF/background/stop |
| Permissions and hard Locks | ✅ scoped rules, requests/replies/clear; `--yes` never bypasses hard Locks/agent denies |
| Questions/forms | ✅ single/multiple/custom/skip; pending list/reply/cancel; shared-client resolution |
| Sessions/workspaces | ✅ new/list/picker/use/rename/delete, export/import, `-C/-s/-c` |
| Rewind | ✅ turn undo, step undo, redo, snapshot list and redacted preview |
| Compaction | ✅ manual/automatic core paths, settings and advanced summary model |
| Usage/cost | ✅ input/output/reasoning/cache; unknown charge is not displayed as free |
| Providers/models/keys | ✅ existing add/auth commands, catalog/import/show/fetch/remove; masked key input |
| Attachments | ✅ quoted `@file`, text inlining, correct raw-base64 image parts, size budgets |
| Memory, todos, audit trail | ✅ shared stores and management commands |
| MCP/Connectors | ✅ configure/status/resources/templates/read and PKCE OAuth interaction |
| Extensions/plugins | ✅ inspect/install/reload/remove, lifecycle, reviewed package fetch through the existing installer |
| Marketplace/registries | ✅ same built-ins/registry data, explicit installs, no automatic unreviewed execution |
| Terminal UX | ✅ five themes, command/model/agent/session pickers, multiline/paste, completion, private history |
| HTTP/SSE and local/remote SDK | ✅ original routes preserved plus authenticated control API |
| Browser tools/dock | ✅ through `vibe attach`, controlling the real visible Electron browser |
| Window chrome, native dialogs/notifications, desktop updater | native; not faked in a Node terminal |
| Account login/upgrades not configured in the standalone app | same availability constraint; no fake account/payment flow |

The terminal font size belongs to the terminal application. Its themes are
separate from desktop appearance settings; the desktop font slider is fixed
independently.

## 4. Architecture

```text
cli/vibe.js            compatibility router, args, entry point, attach/serve/run
cli/actions.js         shared global/slash management commands and completions
cli/chat.js            interactive controller, safe prompt queue, session history
cli/input.js           one stdin owner, editing/pickers/paste/secret prompts
cli/ui.js              serialized event renderer and permission/question handling
cli/theme.js           color roles, 16/256/true-color fallback, provider labels
cli/settings.js        independent cli.json + bounded/redacted cli_history
cli/attachments.js     text/image file mentions with byte/count limits
cli/run.js             foreground/background subscription and lifecycle cleanup
cli/connection.js      private local host discovery (Windows DPAPI tokens)
cli/server.js          original authenticated loopback HTTP/SSE routes + controls
core/control.js        same-store management, validation and scoped safe writes
sdk/index.js           additive control/browser/Crew/todo remote APIs
scripts/package-cli.cjs standard-library tar/gzip CLI packaging
```

Important implementation contracts:

- `eventID` is additive. Stream + subscription copies are deduplicated without
  dropping real deltas. Original event fields/routes stay intact.
- Observe form/permission resolution before the rendering queue: an answer from
  the desktop must cancel only that terminal question, not the user's draft.
- `--yes` concerns permissions, not question answers. Non-TTY/JSON questions are
  explicitly cancelled so the agent never freezes waiting for unavailable stdin.
- Shell results remain durable in core session storage, carry intent/command/
  status/output, and resume at a safe boundary. Terminal subscriptions also show
  child/idle events that were absent from the original CLI.
- Model keys resolve per session/in memory. **Never create an extra provider
  row or copy credentials merely to select a model.** This avoids duplicate
  desktop groups and changing another session's provider preset.
- Explicit CLI effort is a per-run `reasoningEffort` override. Existing desktop
  `thinking` wiring/defaults are unchanged. Provider optional-parameter fallback
  stays available; low-output Anthropic profiles get a clear budget notice.
- `targetProfile()` retains compatibility with lightweight hosts binding an
  individual Engine method (the pending-message rollback regression covers it).
- Installs/removals are scoped, traversal/junction guarded, and refuse overwrites.
  Package plugins use the existing installer in an isolated staging scope.
- Unrecognized/corrupt settings or history are not silently overwritten.
  Optional history failure cannot stop an otherwise valid agent prompt.
- New stored paths/defaults are Vibe paths. Old `.opencode`/plugin/skill formats
  remain compatibility sources, not new branding.

## 5. Terminal design and controls

The workbench keeps ordinary terminal scrollback rather than copying a full-screen
product layout. The composer is the one framed element; progress rows remain
compact, errors/permissions are distinct, and the working folder/persona/provider
are visible. Use the terminal's monospace font and bounded line lengths.

Obsidian roles: text `#e5e7ed`, muted `#9b9fae`, accent `#b7bce0`, success
`#8cceac`. Themes: **Obsidian, Dark, Light, AMOLED, System**. Color falls back to
256/16-color and respects `NO_COLOR`/`TERM=dumb`; machine output contains no ANSI.

```text
Enter                  send
Ctrl+J / Alt+Enter      newline (Alt+Enter depends on terminal key bindings)
Ctrl+P                 command picker
Tab                    slash/file completion
Up/Down                private prompt history or picker navigation
Ctrl+C                 interrupt/cancel; idle chat can exit
Ctrl+B                 background blocking shell jobs
/model /agent          pick or switch
/sessions /use         history picker/switch
/thinking /reasoning   effort versus thinking visibility
/theme /verbose        independent terminal presentation settings
/help                  all management/slash commands
```

Local chat asks before exiting while jobs need its process. Explicit Ctrl+C/exit
cleans up CLI-owned work; leaving a remote attachment does not destroy the host.
Use `vibe serve`/the desktop host for work that must outlive the terminal.

## 6. Completed checklist

- [x] Obsidian's 71 hard-coded sizes use `--fs-scale`; earlier sidebar fix retained.
- [x] Minimal desktop provider-heading de-duplication, model selection unchanged.
- [x] All existing agent events plus child/idle shell events in the terminal.
- [x] Forms/permission cancellation, external resolution, EOF/Ctrl+C cleanup.
- [x] Full management command surfaces and local/remote control APIs.
- [x] Themes, keyboard pickers, multiline/bracketed paste, file completion/history.
- [x] Correct images, bounded attachments, usage deduplication and JSON failures.
- [x] Model selection does not mutate the shared provider catalog.
- [x] Scaffolding, reviewed marketplace/plugin installs and shell completions.
- [x] Windows launchers and dependency-free CLI archive/tagged-release asset.
- [x] Regression suites wired into `npm test`.
- [x] Real Electron appearance/model-picker/sidebar click-through on an isolated profile.
- [ ] Owner's live prompt/provider/browser/OAuth/plugin acceptance check.
- [ ] Owner-approved commit, exactly-one-patch bump and verified public tagged release.

Real OAuth and third-party installs were not performed with the owner's accounts.
Mock/model/transport tests are offline; they are not a claim about every external
provider's current availability.

## 7. Verification and evidence

Run from the app directory:

```text
npm test
node cli/vibe.js help
node cli/vibe.js doctor
node cli/vibe.js tools --json
npm run pack:cli
```

Latest full run: **2026-11-15 — green** after the compatibility fallback:
120 core, 11 agents, 8 skills, 23 harness, 14 control, 14 CLI command,
23 CLI runtime, package/provider checks, 129 IPC handlers, all existing UI/
pending-prompt/usage/updater regressions. Final review run includes the extra
legacy-output assertion and is fully green (19 suites).

Runtime tests spawn the real CLI against mock HTTP providers: questions, durable
shell completion/auto-resume, Crew, images, failure status, interactive controls,
cross-client resolution and per-run reasoning. Archive tests run the extracted
CLI without Electron/node_modules.

Real Electron + Python Playwright (isolated `VIBE_HOME` and `userData`) verified:

- all five sampled text sizes scale by `18/14` in Obsidian/Dark/Light/AMOLED;
  Obsidian title **22 → 28.2857 px**, label **13.5 → 17.3571 px**;
- provider group is exactly `cloudfire`; canonical key/image choice and existing
  `cloudfire · preview-model` closed selector remain intact;
- 80 actual rendered session rows scroll in their list (266 px client / 3095 px
  scroll) and the 47 px footer remains inside a 699 px viewport.

Evidence/scripts: `%LOCALAPPDATA%\Temp\opencode\vibe-cli-review\`
(`appearance-results.json`, `appearance-obsidian.png`, `provider-sidebar.png`,
`appearance-host.cjs`, `appearance-check.py`). The first QA attempt filled a
hidden empty-state list; the corrected attempt uses `renderSessions()` and passes.
These files and mock user data are not release/commit content.

## 8. Current worktree / next turn

Release 0.3.11 is approved: package.json, package-lock.json and the tag move
together. Preserve unrelated screenshots, `core/agent/prompt.zip`, `render.yaml`
and `website/`; do not stage ZIPs, output, node_modules, logs or credentials.
Website source is maintained in the separate private `VibeCoder-AI-Website`
repository.

Review archive built successfully:
`%LOCALAPPDATA%\Temp\opencode\vibe-cli-review\VibeCoder-CLI-0.3.10.tgz`
(61 files, 195534 bytes, SHA-256
`5bda645fa3b3c4e907488ab73438263e1a2dee09c114b6f9d8a897214abfae2f`).
This is a local review artifact, not a published v0.3.10 update.

Source app launched for owner review with `npm run app`,
background shell `sh_1e02095d1001quffzx0t3iTHz0`. Intent: leave the app open for
review; no automatic provider prompt. The shell completion notification must
be recorded if the owner closes it. Do not duplicate/poll this job.

## 9. Full-screen review corrections (2026-11-16)

- `docs/CLI_TUI.md` owns the full-screen design and is the resume point.
- `vibe provider` and `/provider` are the CLI-only provider manager: list, guided
  add (format, base URL, model, context window, hidden key or keyless `noAuth`),
  remove (custom only), key, test and models; the legacy
  `vibe profile add <id> <format> <baseURL> <model>` form is unchanged.
- Paste works in the Windows console: bracketed paste stays one draft, Ctrl+V
  reads the OS clipboard because conhost sends it as a key, and right-click in
  the mouse-enabled full-screen view does the same. Mouse reports never enter
  the draft.
- Saved Full Access auto-approves tool permission requests but never silently
  confirms destructive provider/session/extension removal.
- Final gate: **21 suites green**, including 15 screen and 5 provider cases.

Terminal launcher: `%LOCALAPPDATA%\Temp\opencode\vibe-cli-review\open-cli.ps1`
(connects to the source host in the Desktop workspace).

Review startup confirmed:

- `node cli/vibe.js doctor --attach --json -C Desktop` succeeded against the
  real source host (`mode: remote`, `browser: true`, shared `~/.vibe` stores).
  No paid prompt was sent and no key was printed.
- Separate review terminal is open: PowerShell PID **9848**, CLI Node PID
  **6368**, attached to the source app in the Desktop workspace.
- QA-only Electron window was closed gracefully; the owner's source app and
  review CLI are intentionally left open.

Next safe step: wait for explicit owner acceptance/release approval. Do not tag
or move `v0.3.10`. Handle the background source-app completion as a review window
closing, not as a request to relaunch or repeat tests automatically.
