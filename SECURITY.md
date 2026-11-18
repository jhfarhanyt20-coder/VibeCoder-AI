# Security policy

VibeCoder AI is a local-first desktop application. The most sensitive data it
handles is your provider API keys and the project content you send to a model.

## Supported versions

Security fixes are shipped in the latest desktop release. Users receive them
through the in-app updater or the public GitHub Release feed:

https://github.com/jhfarhanyt20-coder/VibeCoder-AI/releases/latest

## Reporting a vulnerability

Please **do not open a public issue** for a vulnerability.

Use GitHub's private vulnerability reporting:

https://github.com/jhfarhanyt20-coder/VibeCoder-AI/security/advisories/new

Include:

- the VibeCoder AI version (desktop or CLI),
- your Windows version,
- a short description and reproduction steps,
- the impact you believe is possible,
- any logs with **API keys, tokens, and private source removed**.

Never send an API key, password, recovery code, or a full private project. If a
credential may have been exposed, revoke it at the provider immediately.

## Scope

In scope:

- local key-store handling in the desktop app,
- the Electron preload/IPC boundary,
- the local HTTP/SSE server and CLI authentication,
- update metadata and installer verification,
- permission, Guardrail, Lock, and path-jail bypasses.

Out of scope:

- a model provider's own content moderation or availability,
- model output being incorrect,
- issues that require an already-compromised Windows account,
- provider API keys that were pasted into a public issue or chat.

## Project code trust

Global plugins and extensions in `~/.vibe` are installed by you and load as
before. Project-scoped executable content is different: `<workspace>/.vibe/extensions/*.js`,
`<workspace>/.vibe/plugins/*.js` and `<workspace>/.vibe/mcp.json` can run code
or spawn commands.

VibeCoder AI therefore asks once per workspace before loading them. The desktop
shows a **Trust and load project tools** dialog; the CLI exposes:

```bash
vibe trust            # review and approve the current workspace
vibe trust <folder>   # review another workspace
vibe trust list       # show approved workspaces and signature status
vibe trust revoke [folder]
```

Approval is bound to a SHA-256 signature of the exact executable files in
`~/.vibe/trust.json`. Editing any of them asks again. Declining keeps only the
normal chat/tools available; global plugins stay enabled. Never approve a
workspace you have not reviewed.

## Secret handling on disk

- Session, snapshot, trail, shell-output and command-audit files are written with
  owner-only permissions (`0600`, plus `chmod` on POSIX): `~/.vibe/sessions`,
  `~/.vibe/snapshots`, `~/.vibe/trail`, `~/.vibe/shell` and `~/.vibe/audit.log`.
- Snapshots never store the contents of `.env`-style secret files. Undo reports
  them as skipped instead of keeping a copy.
- Shell output logs stop at 50 MB per job, so a runaway command cannot fill the
  disk. Command lines in the audit log are redacted.

## Browser and connector approvals

- Browser approvals are scoped to the page origin (`click example.com`), not to a
  blanket action. When the origin is not known yet the approval is one-shot and
  the **Always allow** button is not offered.
- `browser.evaluate` is always one-shot because it runs arbitrary page JavaScript.
- Remote MCP servers must use HTTPS. Plain HTTP is accepted only for loopback
  development.
- Settings → General lists every trusted workspace with its signature status and
  a **Revoke** button; editing the workspace asks again.

## Project rules

- No secrets are committed to this repository.
- The repository stays public because existing installed apps read its release
  assets without shipping a GitHub token.
- Releases are published only from a tested `v*` tag.
