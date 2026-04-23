# SMIKE Runtime Acceptance Runbook

This runbook is the operator path for one bounded acceptance pass of the SMIKE framework in this repo. It uses the checked-in acceptance spec and keeps the runtime disposable by restarting from `fresh`.

## Scope

- Project slug: `spec-smike-runtime-acceptance`
- Spec: `docs/spec-smike-runtime-acceptance.md`
- Runtime root: `.smike/spec-smike-runtime-acceptance/`
- Entry command: `./smike`

## Companion Docs

- [smike-runtime-recovery-matrix.md](smike-runtime-recovery-matrix.md)
- [smike-runtime-final-checklist.md](smike-runtime-final-checklist.md)

## Preconditions

- Run from the repo root.
- `node`, `npm`, and `git` must already be available on `PATH`.
- Treat this pass as disposable. Prefer `./smike fresh ...` instead of reusing old state.
- Read `.smike/spec-smike-runtime-acceptance/STATE.md` before making a mutating follow-up command.

## Happy-Path Sequence

### 1. Start a clean runtime

```bash
./smike fresh docs/spec-smike-runtime-acceptance.md
```

What to inspect next:

- `.smike/spec-smike-runtime-acceptance/STATE.md`
- `.smike/spec-smike-runtime-acceptance/PLAN.json`
- `.smike/spec-smike-runtime-acceptance/phases/01/01-PLAN.json`

Expected surface:

- The project exists at `.smike/spec-smike-runtime-acceptance/`.
- `STATE.md` shows the current lifecycle status and legal `next_command`.
- The plan bundle is present, even if the project is still in `planning_draft`.

### 2. Promote the planning bundle

```bash
./smike cycle spec-smike-runtime-acceptance
```

What to inspect next:

- `.smike/spec-smike-runtime-acceptance/STATE.md`
- `.smike/spec-smike-runtime-acceptance/VERDICT.md`
- `.smike/spec-smike-runtime-acceptance/REVIEW.md`

Expected surface:

- `VERDICT.md` and `REVIEW.md` exist.
- `STATE.md` reports the next legal step instead of leaving the project in an unreviewed draft.
- If runtime planning dispatches are required, the next mutating command is `./smike advance spec-smike-runtime-acceptance`.

### 3. Follow runtime-owned planning dispatches

```bash
./smike advance spec-smike-runtime-acceptance
```

When a dispatch is active:

- Read the current capsule named in `STATE.md`.
- Use `STATE.json.lifecycle.advance_behavior` to confirm whether `advance` is spawning new work or reconciling existing work.
- After the dispatch work finishes, record completion with `./smike dispatch spec-smike-runtime-acceptance completed <dispatch-id>`.
- If a whole current group finished, `./smike dispatch spec-smike-runtime-acceptance complete-group current` is the group-level shortcut.
- Rerun `./smike advance spec-smike-runtime-acceptance` after each completion so the state machine can surface the next legal action.

Primary inspection surfaces during dispatch execution:

- `.smike/spec-smike-runtime-acceptance/STATE.md`
- `.smike/spec-smike-runtime-acceptance/STATE.json`
- `.smike/spec-smike-runtime-acceptance/capsules/*.json`

Expected surface:

- `STATE.md` shows the actionable dispatch id, owner, and lease.
- `STATE.json.orchestration.current_actionable_dispatch` matches the capsule you are executing.
- `next_command` stays authoritative; do not improvise around it.

### 4. Honor the fresh-session gate

If `STATE.md` reports `awaiting_fresh_session`, stop the current session. Start a fresh session and continue with the exact `next_command`, which should be:

```bash
./smike advance spec-smike-runtime-acceptance
```

Expected surface:

- `resume` remains inspection-only.
- The fresh-session gate clears only after the new session runs the printed `advance` command.

### 5. Execute implementation phases in order

For this acceptance spec, implementation work is docs-only and follows the declared phase order:

1. `01` writes `docs/smike-runtime-acceptance-runbook.md`.
2. `02` extends the package with `docs/smike-runtime-recovery-matrix.md`.
3. `03` finishes the package with `docs/smike-runtime-final-checklist.md` and updates `docs/README.md`.

For each phase:

1. Run `./smike advance spec-smike-runtime-acceptance`.
2. Read the current executor capsule and stay inside its `write_scope`.
3. Produce the required doc artifact plus any declared runtime result artifact.
4. Mark the executor dispatch complete.
5. Rerun `./smike advance spec-smike-runtime-acceptance`.

Expected surface:

- The active plan id in `STATE.md` advances from `01` to `02` to `03`.
- The corresponding doc files appear under `docs/`.
- The project remains operator-driven through `advance`, `dispatch`, and `cycle`; no framework code changes are required.

## Evidence To Capture During The Pass

- The exact `next_command` printed after each `cycle`, `advance`, or `dispatch` call.
- The top actionable block from `.smike/spec-smike-runtime-acceptance/STATE.md`.
- The current capsule path for any spawned dispatch.
- The final doc artifacts created under `docs/`.

## Stop Conditions

- `./smike doctor spec-smike-runtime-acceptance` reports a failure.
- `STATE.md` and the command output disagree about the next legal command.
- A dispatch lease expires or a dispatch fails.

Use [smike-runtime-recovery-matrix.md](smike-runtime-recovery-matrix.md) for the concrete retry, lease-expiry, and archive/restore recovery commands.
