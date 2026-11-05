# vibe-core: VibeCoder AI engine (zero dependencies)

Own CLI + own SDK + own agent loop. No OpenCode, no third-party packages. Node >= 20.

```
core/llm/       openai-chat.js  openai-responses.js  anthropic.js  sse.js  http.js  profiles.js
core/agent/     loop.js  compaction.js  prompt.js
core/tools/     read write edit multiedit apply_patch list bash grep glob todowrite webfetch ... (+ editkit, diagnostics)
core/perm/      rules.js          allow / ask / deny rules (+ workspace guard)
core/store/     sessions.js       JSON sessions in ~/.vibe/sessions
core/store/     snapshots.js      per-turn file snapshots for /undo (~/.vibe/snapshots)
core/engine.js  ties it together
sdk/index.js    createVibe() in-process, connect() to `vibe serve`
cli/vibe.js     run / chat / serve / models / auth / compact ...
test/           automated core, skills, and Electron backend regression tests:  npm test
```

## Use
```
node cli/vibe.js models
node cli/vibe.js auth add groq-gpt-oss-120b        # or: set GROQ_API_KEY
node cli/vibe.js run -m groq-gpt-oss-120b "explain this project"
node cli/vibe.js chat -m anthropic
node cli/vibe.js profile add my-llm openai-chat https://host/v1 model-name 128000
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

## Auto-compaction (OpenCode-style)
- When the context is near its budget, on provider overflow, or on `/compact`, the agent builds a structured checkpoint summary of the older conversation and retains a recent tail.
- Old tool outputs are pruned on a candidate copy; if summary generation fails, the original history is preserved. A deterministic fallback summary is used when the LLM does not produce a valid checkpoint.
- The desktop UI displays the actual checkpoint Markdown, summary source (LLM/fallback), reason, and estimated before/after token counts. If the resulting request still exceeds the budget, it shows an explicit warning and the agent blocks the next model request rather than blindly retrying.
- Set `contextLimit` and `maxOutput` correctly in each profile. Token counts are estimates, so provider-side context limits can still differ.

## Provider settings and live refresh
Custom provider profiles are stored in `~/.vibe/profiles.json`; API keys are stored separately in `~/.vibe/auth.json` (not in the OpenCode config file and not in the repository). The desktop main process watches those files (including atomic replacements) and emits a secret-free refresh event. The ChatComposer and Model settings now fetch one authoritative provider catalog snapshot, sort configured custom providers first, omit unconfigured built-in defaults, and drop stale rows/selections after a provider/model is removed or disabled. External profile edits are picked up while the app is running; use the refresh control if a platform/filesystem watcher is unavailable.

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

## Extensions (marketplace + engine, all zero-dependency)
- **MCP servers** (`core/mcp`): local (stdio JSON-RPC) + remote (Streamable HTTP). Their tools run in the
  engine as `mcp__<server>__<tool>`. Config: `~/.vibe/mcp.json` (global) / `<workspace>/.vibe/mcp.json`.
- **Plugins** (`core/plugins`): CommonJS files exporting a tool / array / `{tools}` from
  `~/.vibe/plugins/*.js` or `<workspace>/.vibe/plugins/*.js`; installable from the marketplace (file/content/npm).
- **Skills** (`core/skills`): Agent Skills / OpenCode-compatible directory-based `SKILL.md` and legacy flat Markdown. Global roots include `~/.config/opencode/skills`, `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, and `~/.vibe/skills`; project roots include `.opencode/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, and `.vibe/skills`. The system prompt exposes a bounded ID/description catalogue and the agent's `skill` tool loads relevant full instructions on demand. Supporting files can be read with the regular `read` tool. Skill instructions are untrusted project data and do not bypass user/system rules or permissions.
- **GitHub skill imports**: Marketplace → Skills supports public `owner/repo`, GitHub repository/folder URLs, and direct `SKILL.md` URLs. Imports are size/path bounded, staged per skill, and rolled back as a batch if any selected skill fails. Supporting text/code files are preserved but never executed during import. Project skills install under `.opencode/skills/<id>/SKILL.md`; global skills under `~/.config/opencode/skills/<id>/SKILL.md`.
- **Marketplace** (`core/extensions/catalog`): shipped built-in catalog + user registries -
  any HTTPS URL serving `{ mcp:[], plugins:[], skills:[] }` JSON (cached, works offline from cache).

## Not done yet (honest list)
OAuth/device login, provider-specific thinking-block replay for Anthropic extended thinking.
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

Optional future work: a native PTY terminal and persistent multi-language LSP servers. The current pipe-based shell and project TypeScript diagnostics deliberately avoid adding native/runtime dependencies.

## License

Copyright (c) 2026 VibeCoder AI. All rights reserved. This repository is proprietary; viewing or cloning the source does not grant permission to use, copy, modify, or redistribute it. See the [LICENSE](../LICENSE) file at the repository root for the full terms. Third-party dependencies remain under their own licenses.
