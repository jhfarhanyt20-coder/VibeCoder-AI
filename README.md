# VibeCoder AI

**A local-first AI coding workspace for Windows.** Bring your own model provider, keep your project on your machine, and let an agent plan, edit, run, verify, and rewind real work.

[Website](https://vibecoderai.onrender.com) · [Download](https://vibecoderai.onrender.com/download-page) · [Latest release](https://github.com/jhfarhanyt20-coder/VibeCoder-AI/releases/latest) · [Report a problem](https://github.com/jhfarhanyt20-coder/VibeCoder-AI/issues)

![VibeCoder AI agent reading, editing and verifying a project](docs/screenshots/agent-run.png)

![Release](https://img.shields.io/github/v/release/jhfarhanyt20-coder/VibeCoder-AI?style=flat-square)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-3157d5?style=flat-square)
![Node](https://img.shields.io/badge/Node.js-20%2B-378777?style=flat-square)
![License](https://img.shields.io/badge/license-proprietary-637189?style=flat-square)

---

## Why VibeCoder AI

| | |
|---|---|
| **Your providers, your keys** | OpenAI-compatible Chat Completions, OpenAI Responses, and Anthropic Messages formats. Add any compatible endpoint, including self-hosted and keyless local servers. |
| **Fallback model** | Build one ordered chain from models across different providers. If a model is rate-limited, returns a server error, times out, is unreachable, or is blocked by its content filter, the next model answers automatically. The cursor is sticky, moves down the chain, and wraps around at the end. |
| **Real agent work** | Read and search a project, edit files, run commands, inspect diffs, verify changes, and use MCP connectors — with live tool output in the timeline. |
| **Control stays with you** | Permission prompts, hard Locks, Guardrails, and per-step Rewind snapshots. Stop a run at any time. |
| **Long sessions that continue** | Provider-aware context metering, automatic compaction, and overflow recovery. |
| **Careful with your accounts** | Connector tools never show Facebook or GitHub tokens to the model. Merging a PR, writing to the main branch, force-pushing, pressing Enter in a chat or mail app, and actions on a website the agent has not identified always ask first. |
| **Lower cost on long runs** | Prompt caching for every provider, decided by API format (Anthropic, OpenAI Chat, OpenAI Responses), not by name: the agent keeps each request's prefix identical, so 98-100% of a step's input is read from the provider's cache on endpoints that cache. Works for any custom provider you add. |
| **Fewer wasted steps** | Every browser click or key reports the new page and title. Computer Use says when element numbers moved. Shell results show a command's real exit code, and when a command writes its output to a file, the agent sees that file. |
| **Hardened against prompt injection** | A web page, README or tool result cannot make the agent run, delete or install things on its own: risky shell commands, repo-provided agents and plugins, Computer Use launches and dangerous browser clicks all ask you first, and secrets stay out of logs and away from other hosts. |
| **Stays open in the tray** | The close button hides VibeCoder AI in the Windows tray, so a stray click never stops a running agent. Click the tray icon to bring it back; right-click → Quit to exit. |
| **Two surfaces, one engine** | The desktop app and the full-screen `vibe` CLI share sessions, providers, tools, permissions, and history. |
| **Local-first** | No VibeCoder-hosted model service. API keys stay in the local encrypted key store; project code stays on your machine until you send it to your chosen provider. |

## Screenshots

### Fallback model chain

Pick models from every provider, order them, and let VibeCoder continue when one provider stops.

![Fallback model popup](docs/screenshots/fallback-model.png)

### One picker for every provider

Fallback model sits above the provider list as a single selectable entry.

![Model picker](docs/screenshots/model-picker.png)

## Download

Windows 10 / 11, 64-bit:

- **Website:** https://vibecoderai.onrender.com/download-page
- **GitHub Releases:** https://github.com/jhfarhanyt20-coder/VibeCoder-AI/releases/latest

Installed desktop apps update through the public GitHub Release feed. Open **Settings → App Updates** and use **Check for Updates** → **Update Now** → **Install & Restart**. The manual update path works even when automatic checks/downloads are off.

## Add a provider

1. Open **Settings → Model settings**.
2. Pick a popular provider or **Add provider**.
3. Enter the API base URL and API key, then add one or more models.
4. Choose the model (or the **Fallback model** chain) in the composer.

Popular providers stay under **Popular providers** and turn green once configured; only providers you create yourself appear under **Custom providers**.

### Fallback model

Open **Settings → Model settings → Fallback model**, then:

1. Pick models from any configured provider.
2. Order them with the arrow buttons (top = first).
3. Select **Fallback model** in the composer.

Each model uses its own provider key and context window. If the active model fails, the next one answers; the position is remembered across app restarts, and **Reset to #1** is always available.

## CLI

Requires Node.js 20+:

```bash
npm install -g ./VibeCoder-CLI-<version>.tgz
cd path/to/your-project
vibe
```

The CLI calls the same SDK and tool registry as the desktop app. See the [CLI page](https://vibecoderai.onrender.com/cli) for commands, provider management, attach mode, and troubleshooting.

## Repository layout

```text
VibeCoderAI-live-fixed/   Desktop app, core engine, SDK, CLI, renderer and tests
docs/                     Screenshots; app documentation lives in VibeCoderAI-live-fixed/docs/
.github/workflows/        Tag-driven Windows release workflow
```

## Development

```bash
cd VibeCoderAI-live-fixed
npm ci
npm test
npm run app
```

The test suite covers the core engine, adapters, agents, skills, harness, control, CLI, Electron IPC, UI regressions, and the updater. A release is built only from a `v*` tag and must pass the full suite.

## Project standards

- **Backward-compatible changes only.** Existing sessions, stored provider IDs, and update paths keep working.
- **No secrets in the repository.** API keys are stored locally by the app, never committed.
- **Release discipline.** One patch increment at a time, full test gate, then a tagged GitHub Release with installer, blockmap, `latest.yml`, and the CLI package.
- **Security reports.** See [SECURITY.md](SECURITY.md); please do not open a public issue for a vulnerability.
- **Contributions.** Issues and reproduction reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) before sending code.
- **Architecture contract.** [VIBE.md](VIBE.md) records the release, security, and UI rules.
- **Progress tracker.** [HARNESS_TODO.md](VibeCoderAI-live-fixed/HARNESS_TODO.md) records completed phases and hardening work.

## License

Proprietary software, all rights reserved. See [LICENSE](LICENSE). VibeCoder AI is a desktop workspace, not a hosted AI provider; model usage and provider terms are handled by the provider you connect.

---

If VibeCoder AI saves you time, **star the repository** so more builders can find it.
