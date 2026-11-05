# Agent rules — VibeCoder AI

The authoritative project rules live in [`VIBE.md`](./VIBE.md) at the repository
root. Read it first, then `VibeCoderAI-live-fixed/HARNESS_TODO.md`.

Critical rules (do not skip):

1. **Keep this repository public.** The installed app's auto-updater reads
   GitHub Releases from this repo and ships no token. Making it private breaks
   updates for every existing user. If source privacy is needed, move source to
   a private repo and keep this one public as the release feed.
2. **Users only receive updates through a tagged GitHub Release**, not through
   an ordinary commit. Release flow: bump `package.json` +
   `package-lock.json`, run `npm test`, commit, push `master`, tag `v<version>`,
   push the tag. The tag must match the version. Increment exactly one patch at
   a time (`0.3.1` → `0.3.2`); never skip or bump minor/major unless the user
   explicitly changes this rule.
3. **Keep a manual update path.** App Updates must offer Check for Updates and
   an Update Now button that starts the in-app download even when auto-download
   is off (without changing the saved preference), followed by Install &
   Restart. Manual update never means sending the user to a web page.
4. **Never commit when tests are red.**
5. **Never commit** `node_modules/`, `release/`, `dist/`, `.env*`, logs, or
   `VibeCoderAI-live-fixed/core/llm/http.zip`.
6. **No secrets** in the repository and **no new runtime dependencies** without
   explicit approval.
7. **Additive, backward-compatible changes only.** Do not remove existing
   features or compatibility paths.
8. **Clean-room naming:** new code, UI and docs use VibeCoder/VibeCore names
   only. Never copy another product's names, prompts, text, code or assets.
9. After a context reset: read `VIBE.md` and `HARNESS_TODO.md`, check
   `git status` / `git log` / `git tag`, and run `npm test` before editing.
