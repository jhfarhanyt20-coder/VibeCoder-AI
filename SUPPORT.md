# Support

## Get the app

- Website: https://vibecoderai.onrender.com
- Download: https://vibecoderai.onrender.com/download-page
- Latest release: https://github.com/jhfarhanyt20-coder/VibeCoder-AI/releases/latest

## Update the desktop app

Open **Settings → App Updates**:

1. **Check for Updates** — works on demand, even with automatic checks off.
2. **Update Now** — downloads inside the app without changing your saved
   preference.
3. **Install & Restart** — completes the update.

Existing installations keep receiving updates through the public GitHub Release
feed. This repository must stay public for that to work.

## Before opening an issue

- Confirm the version in **Settings → General** (or `vibe --version`).
- Try **Model settings → provider → Fetch models** to confirm the base URL and
  key.
- Check whether the same prompt works with another provider. Some gateways
  block languages, regions, or content; that is a provider policy, not an app
  setting.
- For a rate limit or an unreachable provider, add a second model to
  **Fallback model** and select the chain in the composer.

## Open an issue

https://github.com/jhfarhanyt20-coder/VibeCoder-AI/issues/new/choose

Include:

- VibeCoder AI version and Windows version,
- provider format (Chat Completions, Responses, or Anthropic) and model ID,
- steps to reproduce, expected result, and actual result,
- sanitized error text.

Never include API keys, tokens, passwords, private source code, or personal
data. Revoke any credential that was exposed.

## Security

Report vulnerabilities privately through
[SECURITY.md](SECURITY.md), not in a public issue.
