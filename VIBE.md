# VibeCoder AI — Project Rules (read this first)

Last updated: 2026-11-07
Current release: **0.3.6** (tag `v0.3.6`, published 2026-11-07)
Release assets verified: `VibeCoderAI-v2-0.3.6.exe`,
`VibeCoderAI-v2-0.3.6.exe.blockmap`, `latest.yml` (`version: 0.3.6`)
Repository: https://github.com/jhfarhanyt20-coder/VibeCoder-AI — **PUBLIC**
Application directory: `VibeCoderAI-live-fixed/`
License: proprietary, all rights reserved. See `LICENSE`.

This file is the persistent contract for every future session. If a model
context limit resets, read this file and `VibeCoderAI-live-fixed/HARNESS_TODO.md`
before changing anything.

## 1. Non-negotiable: users must keep receiving updates

Installed apps use the auto-updater, which downloads GitHub Releases from this
same repository. Therefore:

- **Keep this repository public.** A private repository makes its release
  assets private too; the app ships no GitHub token, so every existing install
  would lose auto-update permanently.
- If source privacy is ever required, move the source to a separate private
  repository and keep this repository public **only as the release feed**.
  Never flip this repository itself to private.
- Never publish a release only as a source commit. Users receive an update only
  when a GitHub Release with the installer and `latest.yml` is published.
- **A manual update path must always exist.** The App Updates page must keep
  working when both automatic settings are off:
  1. **Check for Updates** works purely on demand;
  2. when a release is available, **Update Now** starts the download inside the
     app and never changes the saved auto-download preference;
  3. after the download, **Install & Restart** completes the update.
  Manual update means one click in the app that starts the download — never a
  detour to a website. Never ship a build where the only update path depends
  on auto-update.

## 2. Release contract

1. The version lives in `VibeCoderAI-live-fixed/package.json` and the two root
   entries of `VibeCoderAI-live-fixed/package-lock.json`. Keep them identical.
2. For every release:
   - increment **only the patch number by exactly one** (for example
     `0.3.1` → `0.3.2` → `0.3.3` → `0.3.4` → `0.3.5`). Do not skip a patch and do not bump the
     minor/major number unless the user explicitly changes this rule;
   - run `npm test` from `VibeCoderAI-live-fixed`;
   - commit the intended files and push `master`;
   - create tag `v<version>` on that commit and push the tag.
3. `.github/workflows/release.yml` runs only on `v*` tags. It runs
   `npm ci`, `npm test`, then
   `electron-builder --win nsis --x64 --publish always`, which publishes the
   NSIS installer, `latest.yml` and blockmap to the GitHub Release.
4. The tag and the `package.json` version must match exactly. Never reuse or
   move an already published tag.
5. Do not commit when tests are red. Leave the working tree uncommitted instead.
6. After pushing a tag, verify the Actions run succeeded and that the release
   contains the `.exe`, `latest.yml` and `.blockmap` assets.
7. Never force-push `master` and never delete a previously published release.

## 3. Repository hygiene

- Never commit: `node_modules/`, `release/`, `dist/`, `.env`, `.env.local`,
  `*.log`, `*.tmp`, and `VibeCoderAI-live-fixed/core/llm/http.zip` (stale).
- Never commit API keys, tokens, passwords or credentials.
- Do not add a runtime dependency unless the user explicitly approves it.
- Prefer additive changes. Do not remove or weaken an existing feature.
- Keep compatibility paths such as `.opencode`, `SKILL.md` and `plugins` only
  where removing them would break existing users. Do not surface those names
  as product branding.
- Keep the current desktop visual design unless the user gives fresh explicit
  approval for a redesign. The user approved a look-only redesign on 2026-11-07:
  the visual layer may change, the wiring may not (see 3a).
- A background shell result must never depend on an expired run queue. Persist
  its user intent, description, command, status, exit code and bounded output;
  attach it at the next safe model boundary and resume the agent when idle.
  Dependent background work must not proceed without that result.
- A running background process that asks for input (`Press any key`, Enter,
  Y/N, password/code prompts) must be surfaced to the agent before completion.
  The agent may use `shellInput` for non-secret answers, but must ask the user
  for every password, passphrase, API key or verification code.
- The terminal stream belongs to the agent, not just the UI. `shellList` and
  `shellOutput` expose live output/status, every real user prompt carries a
  bounded snapshot of running shells, and long jobs report progress. The agent
  must read that stream itself and must never ask the user to copy terminal
  output. A blocking foreground command that waits for input is moved to the
  background so the tool call can return with its output.
- Context usage keeps provider-reported reasoning/cache categories separate and
  avoids counting them once inside input/output and again as detail fields.
- The renderer CSP is `style-src 'self'`. Never add inline `style="..."` attributes
  or inline `<style>` blocks to renderer HTML; put rules in `theme.css`/`skin.css`
  and update dynamic values through element CSSOM (`el.style.width = ...`).
  Optional visual skins are separate stylesheets linked after `theme.css`.

### 3a. UI contract — look may change, wiring may not

The desktop redesign is **visual only**. These are fixed contracts:

- Keep every `id="..."` used by `renderer/app.js`, `renderer/theme.js` or the
  preload bridge. Do not rename, remove or duplicate IDs.
- Keep every event binding and every `vibe.*` / preload / IPC method name. Do
  not rename Electron channels or change their payload shape for a redesign.
- Keep the DOM structure and class names that logic queries (`querySelector`,
  `closest`, `data-*`, tool/message cards, composer controls). New wrappers are
  allowed only when they do not change a selector used by code.
- Change the look through CSS: `theme.css` variables (or a stylesheet linked
  after it), spacing, type scale, colour, radius, shadow and motion. Prefer
  additive rules; do not rewrite feature logic.
- Never use inline `style="..."` or `<style>` blocks (CSP `style-src 'self'`).
  Set dynamic values through the element's CSSOM.
- The redesign must keep `npm test` green, especially
  `test/harness-ui-regression.mjs`, `test/compaction-ui-regression.mjs`,
  `test/subagent-ui-regression.mjs` and `test/app-update-ui-regression.mjs`.
- Show the design and get approval before switching the live UI. Then apply it
  behind a separate stylesheet where possible, so reverting is one link.

The user selected the **Obsidian** direction on 2026-11-07. Its production
visual layer is `renderer/obsidian.css`, linked after the existing `skin.css`
and scoped only to `data-theme="obsidian"`. Obsidian is an additional Appearance
option; Dark, AMOLED, Light and System keep their previous CSS and behaviour.
Removing the one link removes Obsidian without changing renderer wiring or
stored user data.

**Baseline backup (never commit, never ship):**
`VibeCoderAI-live-fixed/renderer-backups/pre-redesign-2026-11-07/`
plus `pre-redesign-2026-11-07.zip` and `MANIFEST.txt` (SHA-256 of every file).
The folder is gitignored. Restoring a file from the backup must reproduce the
pre-redesign look and wiring exactly.

## 4. Naming and clean-room rules

- New product code, UI text and documentation use only VibeCoder / VibeCore
  naming: VibeCore, Pulse, Loom, Pilot, Architect, Scout, Maker, Crew,
  Playbooks, Recipes, Guardrails, Locks, Rewind, Trail, Connectors,
  Extensions, Brief.
- Do not copy another product's names, prompts, text, code or assets.
- Existing stored IDs (`build`, `plan`, `explore`, `general`) stay stable for
  backward compatibility even though their display names differ.

## 5. Architecture map

- `core/harness/` — Locks, Trail, Loom, Guardrails, Actions, Playbooks,
  Recipes, Extensions, Connectors and OAuth.
- `core/store/snapshots.js` — Rewind turn/step snapshots and the redo stack.
- `core/agent/loop.js` — Pulse run/step events, action contract, parallel reads.
- `core/jobs.js` — bounded live shell output, background lifecycle and safe stdin.
- `core/tools/diagnostics*.js` — syntax checks plus Guardrail-protected,
  project-local TypeScript semantic diagnostics.
- `core/subagents/index.js` — Crew limits and the result contract.
- `core/engine.js` — wiring for every harness subsystem.
- `electron/backend.cjs`, `electron/preload.cjs` — IPC bridge.
- `renderer/` — desktop UI (Pulse badge, permission scope, Rewind menu).
- `sdk/index.js`, `cli/server.js` — local and remote API.
- `HARNESS_TODO.md` — phase tracker, progress log, hardening backlog.
- `docs/VIBECORE.md`, `docs/VIBECORE_SECURITY.md` — harness and security docs.

## 6. Verification gate

Run from `VibeCoderAI-live-fixed`:

```text
npm test
```

Expected baseline: core 110, agents 11, skills/playbooks 8, harness 23,
Electron backend smoke 124 IPC handlers, compaction/subagent/harness UI
regressions, updater 7. The suite must be fully green before a release commit.

## 7. Resume after a context-limit reset

1. Read this file and `VibeCoderAI-live-fixed/HARNESS_TODO.md`.
2. Inspect state: `git log --oneline -5`, `git status --short`,
   `git tag --list`, and compare with `git ls-remote --tags origin`.
3. Run `npm test` before making new changes.
4. Continue from the first unchecked item in `HARNESS_TODO.md`, or from the
   hardening backlog at the bottom of that file.
5. Update `HARNESS_TODO.md` after each completed phase so the next reset can
   resume without guessing.
