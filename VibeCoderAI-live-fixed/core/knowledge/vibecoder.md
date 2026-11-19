# VibeCoder AI — product guide

This is the official guide the agent reads to answer questions about VibeCoder AI itself.
If something is not written here, say you are not sure instead of guessing, and point the
user to the website or GitHub.

## Overview
keywords: what is vibecoder, about, product, who made, company, website, github, download, platform, windows, version
VibeCoder AI is a local-first AI coding workspace for Windows 10 and Windows 11 (64-bit). An agent
plans, edits files, runs commands, tests the result and reports back — in a desktop app and in a
terminal CLI that share the same engine.
- Website: https://vibecoderai.onrender.com (downloads, Products, CLI guide, privacy, terms).
- Source and releases: https://github.com/jhfarhanyt20-coder/VibeCoder-AI
- Bug reports and ideas: GitHub Issues of that repository.
- The desktop installer is downloaded from the website after Google sign-in; it updates itself from
  GitHub Releases.
- Other products from the same team (Products page on the website): Vibe Stop Processing (shut the
  PC down cleanly, clean junk, stop it waking up) and VibeDownloader (download manager).

## Models and providers
keywords: model, provider, api key, custom header, header, headers, proxy, request body, openai, anthropic, claude, gemini, openrouter, groq, deepseek, kilo, agentrouter, base url, format, chat completions, responses, custom provider, local model, ollama
- Bring your own provider and API key: Settings → Model settings → Add provider (or `vibe provider` in the CLI).
- Formats: OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Most services
  (OpenRouter, Groq, DeepSeek, Gemini's OpenAI endpoint, Kilo, local servers) use **OpenAI Chat**.
- Base URL examples: OpenAI `https://api.openai.com/v1`, OpenRouter `https://openrouter.ai/api/v1`,
  Groq `https://api.groq.com/openai/v1`, DeepSeek `https://api.deepseek.com`, Anthropic `https://api.anthropic.com`.
  If someone pastes a dashboard address, the app corrects it to the API address automatically.
- Keys are stored encrypted with the Windows account (DPAPI) on the user's own PC. The website never
  asks for model API keys.
- Custom request headers and body fields are supported, so no proxy is needed: Add/Edit provider →
  "Advanced (optional) — extra headers & request body" → Request headers, one `Name: value` per line
  (for example `X-Tenant-ID: team-a`). CLI: `vibe profile` (the profile JSON has `headers`). Put the API
  key in the key field, not in a header. Custom headers override the defaults.
- Headers VibeCoder sends by itself: `User-Agent: VibeCoderAI/<version>`; `Authorization: Bearer <key>`
  for OpenAI-compatible APIs; `api-key` for Azure OpenAI; `x-api-key` + `anthropic-version` for
  Anthropic; `HTTP-Referer` + `X-Title` for OpenRouter.
- Switch model from the model button in the composer (models show Free and Vision tags). Vision models
  can see attached images and screenshots.
- Reasoning effort (None / Low / Medium / High) is the gauge button next to the model.

## Free VibeCoder models
keywords: free, sign in with vibecoder, vibecoder account, daily limit, quota, free models, training
- Click "Sign in with VibeCoder" in the sidebar account menu (the browser opens; press Allow). A
  provider called "VibeCoder AI" then appears with free models.
- Free models have a daily request limit, may change or disappear at any time, and are powered by
  third-party AI providers. Those providers may use free-model prompts and outputs to improve their
  models — do not send secrets, credentials, personal data or code you may not share.
- Usage and connected apps are visible on the website profile page; disconnect an app there.

## Fallback model
keywords: fallback, failover, rate limit, 429, chain, group, backup model
- A Fallback model is an ordered chain of models across providers. If one hits a rate limit (429),
  a server error or a timeout, the next model answers automatically.
- Set it up in Settings → Model settings (Fallback) or with `vibe fallback`. Pick "Fallback model" in
  the model menu to use it.

## Permissions, Locks and safety
keywords: permission, ask before changes, full access, allow, deny, lock, guardrails, approve, safe, yes
- "Ask before changes" (default): the agent asks before edits, commands and other changes. Reading is free.
- "Full Access": requests are approved automatically. Hard Locks, agent deny rules and critical
  questions (risky Computer Use clicks, merging on GitHub, publishing, spending money) still ask.
- Locks are hard rules the agent can never break (`vibe locks`, `vibe permissions`).
- The CLI: `vibe access ask|full`, or `--yes` for one run (never bypasses Locks).

## Rewind (undo)
keywords: rewind, undo, redo, revert, restore, steps, snapshot, mistake
- Every turn and step keeps a snapshot of changed files. Use the Rewind button in the composer, or
  `vibe undo`, `vibe redo`, `vibe steps`, `vibe diff` in the CLI.

## Computer Use
keywords: computer use, screen, mouse, keyboard, click, screenshot, test app, desktop, ctrl+alt+esc, stop
- The agent can see the screen and use the mouse and keyboard to open and test what it built, like a person.
- Turn it on/off in Settings → Computer Use (on by default) or `vibe computer on|off`.
- Press **Ctrl+Alt+Esc** at any time to stop it. It also pauses the moment you move the mouse or type.
- A badge "VibeCoder is using your computer" is shown while it works (hidden from its own screenshots).
- Risky actions (send, delete, install, pay, confirm, sign out, format, …) always ask first. It never
  types passwords, one-time codes or card numbers and never solves CAPTCHAs.
- A log of actions is kept in `~/.vibe/computer-actions.log`. Windows only.

## Browser Use
keywords: browser, web, website, chrome, page, ctrl+shift+b, scrape, test website
- The built-in browser lets the agent open pages, click, type and take screenshots. Open it with
  Ctrl+Shift+B or the globe button. Settings → Browser Use. In the CLI use `vibe attach` to share the
  desktop app's real browser.

## Connectors
keywords: connector, connectors, github, facebook, sign in with github, repository, pull request, issue, integration
- Connectors (left sidebar) let the agent work with your accounts. Each user signs in with their own account.
- GitHub: "Sign in with GitHub" → the browser opens → press Authorize. The agent can list repositories,
  read files, search code, read and open issues and pull requests, comment, create branches, commit
  files and open pull requests. Merging, committing to the default branch, deleting and repository
  settings always ask first. CLI: `vibe connectors github connect|status|disconnect`.
- Facebook: coming soon (Pages, posts, Messenger, Business and ads), after Meta approves the app.
- The Connectors page also contains the Marketplace (Browse, Plugins, MCP servers).

## Marketplace, MCP, plugins and skills
keywords: marketplace, mcp, mcp server, plugin, extension, skill, playbook, recipe, agent definition, install
- Marketplace (inside Connectors): install free MCP servers, plugins and skills; add custom registries.
- MCP servers add tools from other programs (`vibe mcp list|add|remove|status`).
- Plugins/extensions are reviewed local JavaScript (`vibe plugins`), trusted per project (`vibe trust`).
- Skills / Playbooks are reusable instructions (`$` in the composer, `vibe skills`, `vibe playbooks`).
- Recipes are prompt templates (`/` in the composer, `vibe recipes`). Agents: `vibe agents`.

## Memory, subagents and background work
keywords: memory, remember, subagent, crew, parallel, background, shell, terminal, long command, todo, plan
- Say "remember this" and the agent saves it to persistent memory (Settings → Memory, `vibe memory`).
- Subagents (Crew) can work on parts of a task in parallel (Settings → Subagents, `vibe crew`).
- Long commands run in the background; their output and finish are reported back automatically.
  Ctrl+B moves a running command to the background. `vibe shells` / `vibe shell` in the CLI.
- The agent keeps temporary files in `./.vibe-scratch/` and removes them when the task ends.

## Composer and keyboard shortcuts
keywords: shortcut, keyboard, hotkey, enter, composer, attach, file, image, @, /, $, #, chat, link chats
- Enter sends · Shift+Enter new line · Ctrl+Enter saves an edited message · Esc closes menus and dialogs
  · Ctrl+, opens Settings · Ctrl+Shift+B browser · Ctrl+B moves a command to the background ·
  Ctrl+Alt+Esc stops Computer Use.
- In the composer: `@` adds files, `/` recipes, `$` playbooks, `#` links other chats; `+` attaches files and images.
- The left sidebar can be resized by dragging its edge, hidden by dragging it to the left, and toggled
  with the button at the top-left of the title bar.

## CLI
keywords: cli, terminal, command line, vibe command, install cli, npm, vibe chat, vibe run, headless
- Install from the website's CLI page. `vibe` opens the full-screen chat in the current folder;
  `vibe run "…"` runs one task; `vibe attach` uses the running desktop app; `vibe serve` hosts HTTP/SSE.
- Everything the desktop agent can do, the CLI agent can do too (same engine and settings in `~/.vibe`).
- Useful: `vibe help`, `vibe doctor`, `vibe models`, `vibe provider`, `vibe usage`, `vibe theme`,
  `vibe computer`, `vibe connectors`. Inside chat: `/help` or Ctrl+P.

## Updates
keywords: update, upgrade, new version, auto update, install update, release
- Settings → App Updates: Check for Updates, Update Now (downloads inside the app even when automatic
  download is off), then Install & Restart. Updates come from GitHub Releases.

## Privacy and data
keywords: privacy, data, policy, terms, telemetry, tracking, where is my data, delete data, security, keys stored
- Projects, chats, keys and settings stay on the user's PC (`~/.vibe`). Prompts go only to the model
  provider the user selected (or, for free models, through VibeCoder's server to its AI providers).
- The website uses an encrypted session cookie for Google sign-in and stores no model API keys.
- Connector tokens are kept encrypted on the user's PC; the website only swaps the one-time sign-in code.
- Full texts: https://vibecoderai.onrender.com/privacy and /terms.

## Usage and cost
keywords: usage, tokens, cost, price, context, ring, percent, billing, money
- The ring in the composer shows how full the context window is. Settings → Usage (and `vibe usage`)
  shows tokens, cache and estimated cost. Costs are charged by your provider, not by VibeCoder.

## Troubleshooting
keywords: error, not working, problem, fix, help, 401, 403, 404, 429, rate limit, empty reply, slow, crash, log
- 401/403: the API key is wrong or lacks access — re-add it in Model settings.
- 404: wrong base URL or format (most services need OpenAI Chat).
- 429: rate limit — wait, or use a Fallback model.
- Empty replies: raise "Max output tokens" or lower reasoning effort for that model.
- `vibe doctor` checks paths, keys and the host. App errors are logged to `~/.vibe/app-error.log`.
- Still stuck: open an issue on GitHub with the steps and the error text (never paste API keys).
