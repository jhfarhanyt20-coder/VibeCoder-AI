# VibeCore Harness

VibeCore is VibeCoder AI's execution harness. It turns a model response into a
bounded run of visible steps, actions, permission decisions and recoverable file
changes.

## Project layout

```text
VIBE.md
.vibe/
  locks.jsonc
  briefs/*.md
  playbooks/<id>/PLAYBOOK.md
  recipes/<id>.md
  extensions/*.js
  mcp.json
```

All files are optional. A project with none of them keeps the standard agent
behaviour.

## Briefs and Loom

`VIBE.md` contains project guidance. Loom reads, in stable order:

1. `<VIBE_HOME>/VIBE.md`
2. the project-root `VIBE.md`
3. nested `VIBE.md` files down to the active directory
4. `.vibe/briefs/*.md` files from those directories

Brief text is bounded and deduplicated. It is context, not permission: a brief
cannot override a Lock or grant an action.

## Locks and Guardrails

Locks are hard policy. Put them in `<VIBE_HOME>/locks.jsonc` or
`.vibe/locks.jsonc`:

```jsonc
[
  { "action": "bash", "resource": "git push *", "effect": "block" }
]
```

The closest matching rule wins between global and project files. A saved
approval cannot lift a hard Lock.

Guardrails handle ordinary `allow`, `ask` and `deny` decisions. Their order is:

```text
project → inherited parent → session approval → persona
```

The last matching rule wins. Persona rules stay last so a read-only persona
cannot be widened by an old session approval.

## Pulse and Actions

Pulse emits `run.start`, `step.start` and `step.end` checkpoints. The action
catalog is frozen for each step, so a model can call only actions advertised in
that step. Multiple pure reads can execute concurrently; mixed or mutating
actions remain serial.

Every action result has a common shape:

```js
{ output, isError, stats?, artifacts?, durationMs? }
```

Plain string returns remain supported. Output is clipped before it enters
history or the Trail.

## Live shell jobs

Every shell command is a bounded job with a file-backed log. Long-running jobs
can move to the background without being killed. Output is coalesced into small
live events and shown in the running-jobs panel and active action row. A user or
the `shellInput` action can send bounded text, Enter or EOF to the process;
session ownership is checked on every input. Stop still kills the child tree.

This is a safe stdin/stdout pipe, not a terminal emulator. Programs that need
raw terminal mode, cursor control or full PTY semantics remain future optional
work and require an explicitly approved native dependency.

## Project diagnostics

JSON, JavaScript and Python syntax checks continue to run automatically after
file actions. The read-only `diagnostics` action adds targeted TypeScript
syntax and semantic/type errors when that project already has TypeScript under
its own `node_modules`. VibeCoder installs nothing. Loading project-installed
compiler code goes through Guardrails, runs in an isolated bounded worker, and
falls back with a clear message when no provider is available.

## Playbooks

A Playbook is a lazily loaded workflow:

```text
.vibe/playbooks/review/PLAYBOOK.md
```

```markdown
---
name: Review
description: Review changed code for correctness and regressions
---

Read the changed files, identify risks, and run focused checks.
```

Only the ID and description enter the normal prompt. The full body and its
supporting files are loaded when the `playbook` action is used.

## Recipes

Recipes are slash-command prompt templates:

```markdown
---
description: Inspect one target
persona: plan
model: optional-profile-id
---

Inspect $1 carefully. Full request: $ARGUMENTS
```

Invoke it with `/inspect src/app.js`. `$1` through `$9` use parsed arguments;
`$ARGUMENTS` keeps the raw argument text. Persona and model overrides apply to
that run only and survive run resume.

Shell fences in a Recipe are reference text. The loader never executes them;
any command still has to go through the normal `bash` action, Locks and
Guardrails.

## Crew

Crew helpers run in isolated child sessions. They inherit the parent's
permission policy, cannot spawn another helper, and have a per-parent parallel
cap (`crewMaxParallel`, default `4`, range `1–16`). Foreground failures propagate
to the parent action; background results are attached at the next safe parent
turn.

## Rewind

Before a file action changes a file, Rewind captures its state for both the user
turn and the Pulse step. The UI can preview a bounded redacted diff, undo a step
or turn, and redo the latest rewind. Starting a new branch invalidates stale
redo states.

Shell-side file mutations are not captured. Prefer file actions when a change
must be rewindable.

## Connectors and Extensions

Connectors support local and remote transports, tool calls, paged resource
discovery and lazy resource reads. Remote authorization supports OAuth code flow
with PKCE or a bearer token supplied by an environment variable. Runtime OAuth
tokens are kept in memory and are never written to connector configuration.

Native extensions live in `<VIBE_HOME>/extensions` or `.vibe/extensions` and may
export tools plus these optional hooks:

- `onLoad`, `onUnload`
- `onEvent`
- `beforeAction`, `afterAction`

Hook failures are isolated from the agent run. Extensions are executable code;
install only code you trust.

## Trail

Trail writes bounded JSONL records under `<VIBE_HOME>/trail`. It stores durable
events—not text deltas—and redacts secret keys, bearer credentials, common token
prefixes and private-key bodies. Removing a session also removes its Trail.
