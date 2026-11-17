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

## Project rules

- No secrets are committed to this repository.
- The repository stays public because existing installed apps read its release
  assets without shipping a GitHub token.
- Releases are published only from a tested `v*` tag.
