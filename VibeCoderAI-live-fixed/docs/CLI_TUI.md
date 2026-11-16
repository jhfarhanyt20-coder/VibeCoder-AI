# VibeCoder full-screen terminal — design and resume plan

Status: **implemented; screen/regression tests green; live review in progress**
Updated: 2026-11-16

The owner explicitly requested a professional full-screen terminal layout,
comparable in usability to a modern coding-agent TUI. The earlier blue
PowerShell console screenshot is the rejected baseline. This approval is
**CLI-only**: do not redesign the desktop app, remove provider/model choices,
change the engine, add a runtime dependency, commit or release.

Read root `VIBE.md`, `HARNESS_TODO.md`, `docs/CLI.md` and this file after a reset.
Baseline before this visual pass: all 19 suites green; existing core/CLI controls,
native Electron font/provider/sidebar QA, and archive tests passed.

## Direction

Keep VibeCoder's own name, copy, typography and palette. Rebuild common terminal
patterns, not another product's assets, prompts, source or signature logo.
The official terminal guide used only for behaviour reference describes
full-screen interactive chat, plain automation, and palette fallbacks:
https://opencode.ai/docs/cli

The design is a **terminal workspace**, not a log viewer:

```text
 Desktop / session title                                  VibeCoder 0.3.10

                           VibeCoder
                 Work on your next change.
          [ fresh-session home; transcript replaces this after a prompt ]

  You                                                        Context (wide)
  user message                                               tokens / limit

  VibeCoder                                                  Todo
  readable response / code / concise tool activities          Crew
                                                             modified files

  > Ask VibeCoder to work in this project...
    Pilot   provider name once                 ask before changes   context
  Enter send   Ctrl+J newline   Ctrl+P commands                Desktop
```

- Full viewport painted with an explicit background. No inherited PowerShell
  blue; no permanent change to console/OS preferences.
- Normal chat rows have a role, spacing and text hierarchy; tool activities are
  compact, not mixed into assistant prose.
- Composer stays fixed at the bottom. Current persona/provider/permission mode
  remain visible. Raw model IDs are inside the picker, not duplicate headings.
- Fresh home is centered and quiet; active chat uses available space.
- Wide windows get a contextual side panel. It collapses at narrow widths.
- Model/session/command pickers and permission/question prompts are centered
  overlays with a selected row, filter, keyboard hints and clear focus.
- Keep the draft when a background question interrupts; external-client
  resolution dismisses only that question.
- Support transcript scroll without moving the composer; new messages follow
  only when the user is already at the end.
- No decorative spinner/animation, giant raw URLs, repeated prompt labels or
  low-value usage spam in the main transcript.

## Tokens and constraints

Terminal's own monospace font; no new font dependency or programmatic font-size
change. Prefer ASCII-compatible wordmark/input marker so the default Windows
console cannot turn the logo into a missing glyph.

Default Obsidian roles: background `#101114`, surface `#1b1d23`, subtle
`#24272f`, text `#eceef4`, muted `#a0a6b3`, border `#687182`, warm Vibe accent
`#e7ae78`, success `#9bd5af`, error `#f4a1a5`, warning `#e7c486`.
Every text/background pair must pass 4.5:1; input/focus border at least 3:1.
Dark, Light, AMOLED and System keep distinct role palettes. Use true color
where supported, semantic 16/256-color fallbacks otherwise.

Layout uses character cells: 2-column outer padding, 80-column home/composer,
2-row header, 1-row footer, composer 4–10 rows, side panel about 28 columns
only when width >=110. Bound every line/cursor to the actual terminal size.
Minimum-size state remains readable and can still exit safely.

## Architecture / feature protection

Add `cli/screen.js` as a presentation layer. Existing engine, APIs, stores,
renderer event handling, question answers, permissions, snapshots, shell/Crew
lifecycle and plain/JSON commands stay intact.

- TerminalInput may draw through a screen instead of writing raw prompt lines.
- Structured engine events feed the screen; existing event renderer still owns
  permissions/forms, deduplication and totals.
- Alternate-screen, cursor, paste/raw-mode, resize handlers and timers must be
  restored on EOF, Ctrl+C, normal exit and exceptions.
- `--plain`, non-TTY and `--json` remain the backward-compatible line/machine
  modes. The full-screen UI is for interactive `chat`/`attach`.
- Global inspection commands retain their existing stdout schema/columns.

## Checklist

- [x] Owner's rejection/new scope and visual plan persisted.
- [x] Theme roles + contrast/semantic fallback tests.
- [x] Cell canvas, alternate screen, differential redraw and resize.
- [x] Fresh home, structured transcript, fixed composer and contextual panel.
- [x] Centered picker/permission/question/secret overlays.
- [x] Input integration, scroll controls and no repeated plain prompt echoes.
- [x] Tests for narrow/wide layout, streaming, input/draft, modal resolution,
      ANSI injection protection and cleanup.
- [x] Full 21-suite regression gate including the new 15-case screen suite and 5-case provider suite.
- [x] Mouse-wheel/right-click interaction, saved Full Access, and paste in the
      Windows console (Ctrl+V reads the clipboard; bracketed paste stays one draft).
- [x] Guided `/provider` manager in chat and `vibe provider` outside chat:
      list, add, remove, key, test and models without opening the desktop app.
- [x] Provider management tests: encrypted key, keyless endpoints, built-in
      protection, secret redaction and Full Access never auto-deleting a provider.
- [ ] Real Windows terminal review; no automatic paid prompt.
- [ ] Rebuild a distinctly named review archive; keep the old artifact unchanged.

The earlier review terminal (PowerShell 9848 / Node 6368) and source app can
remain open while building this. Do not kill the owner's terminal/session or
discard the messages they entered. Show the new UI in a new review window.

## Verification / current state

- 2026-11-16: final `npm test` green: every previous feature/API/desktop/updater
  suite plus 12 full-screen cases. The new flow test uses the real SDK/mock
  provider for questions, model switching, command overlays, fresh session state
  and cleanup. No paid prompt was sent.
- Source app review shell `sh_1e02095d1001quffzx0t3iTHz0` completed during the
  server restart. Do not replay completed implementation work or blindly restart
  that job. Standalone CLI review does not require the desktop process.
- Visual previews use actual cell-canvas data with demo content, not copied
  product screenshots: `tui-home.html`, `tui-chat.html`, `tui-picker.html` and
  matching PNGs under `%LOCALAPPDATA%\Temp\opencode\vibe-cli-review\`.
  Python Playwright checked the viewport background and captured all three.
- Review launcher `open-tui.ps1` opens the new full-screen CLI in Desktop with
  the owner's existing Vibe stores. It clears inherited NO_COLOR only in that
  review process; no permanent console/font settings are changed.
- Old review archive stays untouched. Build the new artifact with the
  `-fullscreen-review.tgz` suffix, then wait for owner acceptance. No commit,
  push, tag or version bump is authorized yet.
- 2026-11-16 live check: new review window (PowerShell 7268 / Node 5832) shows
  the dark full-screen layout, saved Full Access, and the `Ctrl+V paste` footer.
  A real clipboard paste landed as exactly one draft (`clipboard paste works`),
  not separate submissions. Screenshot: `tui-paste-live-2.png`.
- Provider manager live surface: `/provider` menu in chat; `vibe provider
  add|remove|key|test|models|show` outside chat. Guided add stores the key
  encrypted, supports keyless endpoints, and remove only offers custom profiles.
- New review archive (not published):
  `VibeCoder-CLI-0.3.10-fullscreen-review2.tgz`, 62 files, 208710 bytes,
  SHA-256 `64c2df4676b8da73e186fefff4ed50b0b4632b8cd8c1fd2e9737aab5caa84a9a`.
