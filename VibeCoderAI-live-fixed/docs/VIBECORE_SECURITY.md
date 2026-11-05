# VibeCore Security Checklist

Use this checklist before shipping a build that changes agent execution.

## Policy and permissions

- [ ] Locks are evaluated before all approvals and ordinary Guardrails.
- [ ] A saved `always` approval cannot lift a Lock or a persona denial.
- [ ] Compound shell commands are checked segment by segment.
- [ ] Shell stdin is session-scoped, bounded per send and allowed only while the process is writable.
- [ ] Live shell output events are bounded and never added to the durable Trail.
- [ ] Project-local compiler execution goes through normal command Guardrails.
- [ ] Paths outside the workspace require an explicit directory decision.
- [ ] Read-only parallelism includes only actions with no side effects.
- [ ] Recipe shell fences are never executed by the Recipe loader.

## Secrets

- [ ] Trail object keys and free text are redacted before disk writes.
- [ ] Secret-file diff previews replace values with `[redacted]`.
- [ ] Connector OAuth verifier and tokens never enter configuration or Trail.
- [ ] Connector binary resources expose metadata, not raw base64, to the model.
- [ ] Provider and connector headers are not surfaced in renderer events.

## Files and recovery

- [ ] File actions capture a snapshot before mutation.
- [ ] Step undo removes the matching tool history as well as file changes.
- [ ] Redo is cleared when a new user branch or new edit starts.
- [ ] Snapshot files, redo stacks and Trail files are bounded.
- [ ] Session deletion removes snapshots, archives, child sessions and Trail.

## Crew, Connectors and Extensions

- [ ] Crew depth remains one and parallel helpers are capped per parent.
- [ ] Child permissions inherit the parent policy and persona restrictions.
- [ ] Connector calls and resource reads have normal permission subjects.
- [ ] OAuth uses S256 PKCE and validates state with a short expiry.
- [ ] Extension lifecycle hook failures cannot crash an agent run.
- [ ] Extension tools are frozen in the action snapshot for one Pulse step.

## Verification gate

Run from the app root:

```text
npm test
```

The gate includes core, persona, Playbook, harness, Electron backend, Pulse UI,
compaction UI, Crew UI and updater regressions. Do not commit harness changes if
any suite is red.
