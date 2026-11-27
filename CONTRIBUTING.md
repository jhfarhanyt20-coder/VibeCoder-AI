# Contributing to BDCoder AI

Thanks for helping improve BDCoder AI. The project is proprietary software;
the source is public so users can inspect the engine, report issues, and verify
releases. Please read this before opening a pull request.

## Good first contributions

- Reproduce a bug on Windows 10/11 and attach the exact version, provider
  format, model ID, and sanitized error text.
- Improve documentation, screenshots, or error messages.
- Add a regression test for a bug that is already understood.
- Test a provider or gateway and report which API format it supports.

Please open an issue before writing a large feature or refactor. It avoids work
that cannot be merged.

## Never include secrets

Do not paste API keys, tokens, passwords, verification codes, private source, or
full logs containing them. Redact `Authorization`, `x-api-key`, `sk-...`, and
provider account details. If a key was exposed, revoke it first.

## Development

```bash
cd VibeCoderAI-live-fixed
npm ci
npm test
npm run app
```

Requirements: Node.js 20+ and Windows for the desktop app.

## Change standards

- Keep existing features and stored IDs working. Prefer additive changes.
- Do not add a runtime dependency without explicit approval.
- Keep the current visual design unless a redesign was agreed first.
- Put renderer style rules in `theme.css`/`skin.css`; the renderer CSP forbids
  inline styles.
- Add or extend tests for every behavior change.
- `npm test` must be green before a release commit.

## Pull requests

1. Open an issue describing the problem and the intended fix.
2. Fork the repository and create a focused branch.
3. Keep the diff limited to the issue. Do not reformat unrelated files.
4. Run `npm test` from `VibeCoderAI-live-fixed`.
5. Describe what changed, why, the tests added, and any user-visible impact.

Because the project is proprietary, submitting a pull request does not transfer
ownership of the repository or grant redistribution rights. The maintainer may
decline a contribution that conflicts with the license, security model, or
release process.

## Reporting security issues

Follow [SECURITY.md](SECURITY.md). Do not open a public issue for a
vulnerability.
