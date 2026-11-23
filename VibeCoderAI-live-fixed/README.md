# vibe-core: VibeCoder AI engine

Own CLI + own SDK + own agent loop. Node >= 20. The desktop app adds `electron-updater` for in-app updates; the core engine has no runtime dependencies.

```
core/llm/       openai-chat.js  openai-responses.js  anthropic.js  sse.js  http.js  profiles.js
core/agent/     loop.js  compaction.js  prompt.js
core/tools/     index.js  editkit.js  diagnostics.js  browser.js  fsutil.js
core/perm/      rules.js          allow / ask / deny rules (+ workspace guard)
core/store/     sessions.js       JSON sessions in ~/.vibe/sessions
core/store/     snapshots.js      per-turn file snapshots for /undo (~/.vibe/snapshots)
core/engine.js  ties it together
sdk/index.js    createVibe() in-process, connect() to `vibe serve`
cli/vibe.js     run / chat / serve / models / fallback / trust / auth / compact ...
test/           automated core, skills, and Electron backend regression tests:  npm test
```

## Use
```
node cli/vibe.js models
node cli/vibe.js auth add groq-gpt-oss-120b        # or: set GROQ_API_KEY
node cli/vibe.js run -m groq-gpt-oss-120b "explain this project"
node cli/vibe.js chat -m anthropic
node cli/vibe.js profile add my-llm openai-chat https://host/v1 model-name 128000
node cli/vibe.js fallback add openai/gpt-4.1         # ordered failover chain
node cli/vibe.js run -m group:fallback "explain this project"
node cli/vibe.js trust list                          # trusted project workspaces
node cli/vibe.js serve --port 4096                 # prints a token; SDK remote mode uses it
```

## Desktop app (Electron, dev)
```
npm install          # installs electron (devDependency)
npm run app          # or: npm run dev  (opens devtools)
verify-and-build.bat # Windows: npm ci, npm test, then create the NSIS installer
```
`electron/main.cjs` opens `renderer/index.html`; `electron/preload.cjs` exposes `window.vibe`,
which `electron/backend.cjs` answers with the SDK (`createVibe`, in-process engine) and also
starts the same HTTP+SSE API as `vibe serve` (port 4096, slides to the next free port if busy;
`VIBE_SERVE_PORT` / `VIBE_SERVE_TOKEN` / `VIBE_SERVE=0` env vars). Model profiles, API keys and
sessions are shared with the CLI through `~/.vibe`.

## Model profiles (the 3 formats)
A profile is one JSON object (`~/.vibe/profiles.json`, overrides the built-ins by id):
`{ id, format: "openai-chat"|"openai-responses"|"anthropic", baseURL, model, apiKeyEnv, contextLimit, maxOutput, quirks }`
`quirks`: `reasoningField`, `reasoningEffort`, `maxTokensParam`, `extraBody`.
Built-ins are TEMPLATES: check the model id / context size against your provider's docs (xai-grok especially).

## Auto-compaction
- When the context is near its budget, on provider overflow, or on `/compact`, the agent builds a structured checkpoint summary of the older conversation and retains a recent tail.
- Old tool outputs are pruned on a candidate copy; if summary generation fails, the original history is preserved. A deterministic fallback summary is used when the LLM does not produce a valid checkpoint.
- The desktop UI displays the actual checkpoint Markdown, summary source (LLM/fallback), reason, and estimated before/after token counts. If the resulting request still exceeds the budget, it shows an explicit warning and the agent blocks the next model request rather than blindly retrying.
- Set `contextLimit` and `maxOutput` correctly in each profile. Token counts are estimates, so provider-side context limits can still differ.

## Provider settings and live refresh
Custom provider profiles are stored in `~/.vibe/profiles.json`; API keys are stored separately in `~/.vibe/auth.json` (not in a provider config file and not in the repository). The desktop main process watches those files (including atomic replacements) and emits a secret-free refresh event. The ChatComposer and Model settings now fetch one authoritative provider catalog snapshot, sort configured custom providers first, omit unconfigured built-in defaults, and drop stale rows/selections after a provider/model is removed or disabled. External profile edits are picked up while the app is running; use the refresh control if a platform/filesystem watcher is unavailable.

## SDK
```js
const { createVibe } = require("./sdk")
const vibe = createVibe({ agentName: "VibeCoder AI", permission: "ask" })
const s = await vibe.session.create({ dir: "D:\\proj", profile: "groq-gpt-oss-120b" })
for await (const ev of vibe.session.prompt(s.id, "fix the failing test")) {
  if (ev.type === "permission.ask") await vibe.permission.reply(ev.permissionId, "once") // | "always" | "deny"
}
```
Events: text.delta, reasoning.delta, tool.start, tool.end, permission.ask, todo.update, usage,
compaction.start, compaction.end, error, done.

## Extensions (marketplace + engine)
- **MCP servers** (`core/mcp`): local (stdio JSON-RPC) + remote (Streamable HTTP). Their tools run in the
  engine as `mcp__<server>__<tool>`. Config: `~/.vibe/mcp.json` (global) / `<workspace>/.vibe/mcp.json`.
- **Extensions** (`core/harness/extensions.js`): CommonJS files exporting a tool / array / `{tools}` from global `~/.vibe` folders or project `.vibe` folders. Project-scoped executable files (extensions, plugins, MCP config) require a one-time workspace approval; use the desktop prompt or `vibe trust`, review them with `vibe trust list`, and revoke with `vibe trust revoke [dir]`.
- **Skills** (`core/skills`): Agent Skills / compatible directory-based `SKILL.md` and legacy flat Markdown. Global roots include `~/.config/opencode/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and `~/.vibe/skills`; project roots include `.opencode/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, and `.vibe/skills`. The system prompt exposes a bounded ID/description catalogue and the agent's `skill` tool loads relevant full instructions on demand. Supporting files can be read with the regular `read` tool. Skill instructions are untrusted project data and do not bypass user/system rules or permissions.
- **GitHub skill imports**: Marketplace → Skills supports public `owner/repo`, GitHub repository/folder URLs, and direct `SKILL.md` URLs. Imports are size/path bounded, staged per skill, and rolled back as a batch if any selected skill fails. Supporting text/code files are preserved but never executed during import. Project skills install under `.opencode/skills/<id>/SKILL.md`; global skills under `~/.config/opencode/skills/<id>/SKILL.md`.
- **Marketplace** (`core/extensions/catalog`): shipped built-in catalog + user registries -
  any HTTPS URL serving `{ mcp:[], plugins:[], skills:[] }` JSON (cached, works offline from cache).

## Not done yet (honest list)
Hosted VibeCoderAI API device login, provider-specific thinking-block replay for Anthropic extended thinking. Connector OAuth (Authorization Code + PKCE) is implemented; only the hosted account flow is not shipped.
(bash is exercised on Windows PowerShell daily; MCP client + plugins + skills + per-tool diff previews are done.)

## In-app browser agent control

The built-in `browser.*` tools operate the same Electron `<webview>` tabs shown in the right-side browser dock. Agent-created tabs become visible in the dock; navigation, DOM snapshots, click/fill, key presses, scrolling, JavaScript evaluation, screenshots, and closing tabs act on that visible page rather than creating a hidden `BrowserWindow`. The browser tools are routed through the agent loop's `engine` context and the renderer/main-process bridge. In CLI/SDK mode without Electron, browser tools return a clear “No browser available” error.

Browser automation remains subject to the app's tool-permission policy. `browser.current` reports the active in-app tab title, live URL and DOM/accessibility snapshot. `browser.screenshot` captures the actual visible viewport and renders the image directly in its chat tool card; clicking the preview opens a larger viewer. The screenshot payload is preserved in session history and forwarded to OpenAI Chat, OpenAI Responses and Anthropic-format adapters when the selected model is configured as image-capable. Text-only models still receive readable DOM snapshots but cannot interpret pixels. These tools control only the app's own Browser dock, not arbitrary tabs in external Chrome/Edge windows.

Provider selection is resolved against a fresh disk-backed `providerCatalog` before each send. The backend can recover a one-turn stale provider ID only when the exact model ID identifies one unique current custom provider; it rejects ambiguous matches rather than silently choosing the wrong endpoint. If an installed packaged EXE is being used, rebuild it after updating source code for these fixes to take effect.

### Compaction failure UI regression fix

- Compaction failures now carry stable `CONTEXT_COMPACTION_FAILED` / `CONTEXT_COMPACTION_OVER_BUDGET` codes and are marked non-retryable through the engine and Electron event bridge.
- The renderer presents the existing checkpoint status card as the sole failure UI, removes the empty Thinking placeholder, and clears any stale retry countdown/Stop row.
- Failed/over-budget checkpoint cards are moved to the end of the active timeline; the run remains locked until the matching execution-failed event arrives to prevent a prompt/event race.
- Regression coverage includes a real engine test proving an unsafe compaction does not send an LLM request, plus source wiring checks for the UI/event path.


## VibeCoder engine changes (this build)

1. **Prompt bug fixed**: `${agentName}` was printed literally; the leaked example model name is gone.
2. **Per-model prompt notes** (`modelHints` in `core/agent/prompt.js`: gpt/o-series, gemini, deepseek/grok/qwen/kimi/llama/glm) + a short *Code conduct* block (no commit/push unless asked, follow conventions, `file:line` references, secrets, todo usage, prefer dedicated tools) + git repo/branch in the environment block.
3. **Permissions**: `node *test*` / `node *build*` are no longer auto-allowed (only `node --test*`). The **plan** agent now denies shell except `git status|diff|log|show`, `ls`, `dir`, `pwd` (and never redirects / `--output`).
4. **Edit**: exact match first, then a matcher chain (line-trimmed -> whitespace-normalized -> indentation-flexible -> block-anchor) that re-indents the replacement; CRLF kept. **Read-before-edit** and "file changed since you read it" are enforced per session (`core/tools/editkit.js`).
5. **New tools**: `list` (tree), `multiedit` (ordered edits, all-or-nothing), `apply_patch` (`*** Begin Patch` envelope: update/add/delete/move, atomic, per-file permission).
6. **Undo**: before write/edit/multiedit/apply_patch the original file is captured once per turn. `/undo` in `vibe chat`, `session.undo()` in the SDK, `POST /session/:id/undo`, `undoSession` in the Electron IPC. Subagent edits count toward the parent's turn. Shell side effects are not captured. `revertSession` is unchanged (messages only).
7. **Project diagnostics**: after an edit, syntax errors in `.json`, `.js/.mjs/.cjs` (`node --check`) and `.py` (`ast.parse`, if Python exists) return in the same result. The `diagnostics` action also uses a project's installed TypeScript compiler for targeted semantic/type errors, behind normal Guardrails and without installing a package.
8. **Live background shells**: long-running commands stream bounded output into the running-jobs panel and active tool row. The user or agent can send text/Enter/EOF through safe session-scoped stdin, while Stop and Background continue to work.
9. Removed stale files: `core/llm/http.zip` and the one-off `electron/fix-*.js`, `add-event-handler.js`, `event-wiring.js`, `proper-add-events.js`, `electron/frontend/cleanup.js`.
10. **Durable background results**: every background shell retains the original user intent, description, command, exit status and bounded output. Completion is delivered outside the expired run queue, attached to model-only session history and automatically resumes the agent when safe. Interactive prompts such as `Press any key`, Enter and Y/N are surfaced before completion so the agent can answer with `shellInput`; secret prompts always require the user. The agent can also read the terminal itself through `shellList` and `shellOutput`; every user prompt includes a live snapshot of running shells, so no terminal copy/paste is needed. A blocking command that waits for input is moved to the background and returns its output instead of hanging.
11. **Detailed context usage**: OpenAI Chat, OpenAI Responses, compatible routers and Anthropic now forward provider-reported reasoning, cache-read and cache-write tokens through live events and persisted history without double-counting nested totals.
12. **Tool results the model can trust (0.3.22)**: shell results say `exit code N` (not "failed"), warn about `python -c`/`node -e` quoting under PowerShell, and show the tail of a file a command redirects its output to; `./.vibe-scratch` cannot be deleted while a running shell still uses it. Browser actions return the tab's URL, title and generation and say when refs went stale; permissions are per tab and an unknown site always asks. Computer Use reports shifted element numbers and asks before Enter in chat or mail apps. Facebook and GitHub results never contain tokens, connector requests time out, `github_api` asks before merge/ref/content writes, `memory` asks unless the user asked to remember, and `vibecoder_help` understands Bangla topics.
13. **Close to tray**: the window's close button hides the app in the Windows tray; the tray menu has Open and Quit. Updates and Windows shutdown still quit normally.
14. **Security hardening (0.3.23)**: built-in shell allow rules match the real command (a `# npm test` comment no longer slips anything through), dynamic shell syntax always asks, and a compound command asks once showing the whole command. Repo agent files cannot replace built-in agents or grant themselves permissions; repo plugins never run just by being listed. Computer Use asks before Win+R / console typing and unknown programs; browser clicks on Delete/Pay-style buttons always ask and secret fields are never filled. Secrets no longer pass through PowerShell's command line, more token formats are redacted, provider keys never follow a redirect or a changed base URL to another host, and model markdown cannot make Windows contact a network share. Electron 45.4.1 with fuses; long runs no longer leave the chat stuck at the top.
15. **Prompt caching for every provider (0.3.24)** (`core/llm/cache.js`): decided by API format only, never by provider or model name, so any custom provider gets it. The agent keeps the request prefix byte-for-byte stable from step to step (system prompt, tool list, history; the final step adds its closing-summary note at the very end and sends no `tool_choice`). Anthropic Messages and OpenAI Chat requests also carry `cache_control` marks; an endpoint that answers 400 to them is retried once without and then remembered, while context/rate/key/model errors keep their own handling. OpenAI Responses relies on the provider's automatic prefix cache. Measured on real endpoints: 98-100% of the final step's input read from cache. `quirks.promptCache: false` turns the marks off for a profile.
16. **Always allow remembers command families**: approving `git commit -m "x"` also allows later `git commit …` (also `npm run <script>`, `ls`, `pytest`, `cargo/go/dotnet build|test`), matched on clean tokens only; risky commands are still remembered exactly. The prompt shows what will be remembered. `edit` also matches typographic look-alikes (curly quotes, en/em dashes, non-breaking spaces).
17. **Renderer split**: `renderer/app.js` is split into ordered parts in `renderer/app/` (chat, live events, settings, extensions, models, features, activity, account, startup); together they are the same code.

Optional future work: a native PTY terminal and persistent multi-language LSP servers. The current pipe-based shell and project TypeScript diagnostics deliberately avoid adding native/runtime dependencies.

## License

Copyright (c) 2026 VibeCoder AI. All rights reserved. This repository is proprietary; viewing or cloning the source does not grant permission to use, copy, modify, or redistribute it. See the [LICENSE](../LICENSE) file at the repository root for the full terms. Third-party dependencies remain under their own licenses.
