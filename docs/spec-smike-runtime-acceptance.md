# SMIKE Runtime Acceptance Pass

> **SMIKE spec.**
> Primary refs:
> - README.md
> - scripts/smike/SPEC_AUTHORING.md
> - scripts/smike/RUNTIME_ORCHESTRATOR.md
> - scripts/smike/cli-operator-surface.test.mjs

## Objective
Produce a bounded, reviewable acceptance package for the SMIKE framework that proves the current runtime/orchestration contract is usable by an operator without editing framework code. The loop should leave behind a docs-only acceptance runbook, a failure-recovery matrix, and a final execution checklist that a human can use to validate happy-path execution, dispatch failure recovery, lease expiry recovery, and archive/restore semantics.

## What The Planner Must Read First
1. README.md
2. scripts/smike/SPEC_AUTHORING.md
3. scripts/smike/RUNTIME_ORCHESTRATOR.md
4. scripts/smike/cli-operator-surface.test.mjs
5. docs/README.md

## Critical Constraints
- Keep the write surface inside `docs/**` only.
- Do not change runtime code, schemas, or tests in this loop.
- Treat this as an operator-facing acceptance package, not a framework redesign pass.
- The final docs should be runnable by a human who only knows the documented `./smike` surface.

## Explicit Non-Goals
- Do not modify `scripts/smike/**`.
- Do not add new framework features or change runtime semantics.
- Do not rewrite existing architecture plans unless the acceptance docs need to reference them.
- Do not rely on hidden repo knowledge that is not named in the acceptance package.

## Required Deliverable From This Loop
1. A docs-only acceptance runbook that tells an operator exactly how to run one bounded end-to-end SMIKE validation pass in this repo.
2. A failure and recovery matrix that covers dispatch retry/respawn, lease expiry, and archive/restore handling with concrete commands and expected surfaces.
3. A final checklist that states what evidence to capture from `status`, `doctor`, `STATE.md`, and archive/restore flows before calling the runtime healthy.

## Required Planning Output Shape
- Plan 01: Acceptance runbook skeleton (category:doc-drift; write_scope:docs/spec-smike-runtime-acceptance.md,docs/smike-runtime-acceptance-runbook.md; verify:test -f docs/smike-runtime-acceptance-runbook.md)
- Plan 02: Runtime failure and recovery matrix (depends:01; category:verification; write_scope:docs/smike-runtime-acceptance-runbook.md,docs/smike-runtime-recovery-matrix.md; verify:rg -n "Retry / Respawn|Lease Expiry|Archive / Restore" docs/smike-runtime-recovery-matrix.md)
- Plan 03: Final operator checklist and docs index update (depends:02; category:doc-drift; write_scope:docs/README.md,docs/smike-runtime-acceptance-runbook.md,docs/smike-runtime-recovery-matrix.md,docs/smike-runtime-final-checklist.md; verify:rg -n "Final Checklist" docs/smike-runtime-final-checklist.md && rg -n "spec-smike-runtime-acceptance.md" docs/README.md)

## Priority 1: Acceptance runbook skeleton
Create the primary runbook the operator will actually follow. It should explain the setup assumptions, the exact spec/command flow to start a disposable SMIKE project in this repo, the happy-path sequence through planning and runtime dispatch, and the artifacts to inspect after each step. Keep it concrete enough that a cold operator can follow it without interpreting framework internals.

## Priority 2: Runtime failure and recovery matrix
Add a dedicated matrix for non-happy-path behavior. Capture the command to trigger each recovery path, what `status`, `doctor`, and `STATE.md` should surface, and what the legal next command is afterward. At minimum include dispatch failure plus retry/respawn, expired runtime dispatch lease handling, and archive/restore behavior for both safe and forced cases.

## Priority 3: Final operator checklist and docs index update
Finish the acceptance package with a short checklist that a human can mark off after running the pass. Make the checklist evidence-oriented: exact files, commands, or output snippets to confirm. Update `docs/README.md` so the acceptance spec and its generated companion docs are easy to find later.

## Risk Hotspots
- Acceptance docs can become fluffy if they summarize behavior without naming exact commands and evidence.
- The runbook is only useful if it distinguishes happy-path commands from recovery-only commands.
- Archive/restore guidance is easy to get wrong if it ignores live dispatch constraints.

## Protected / High-Collision Areas
- scripts/smike/**
- package.json
- package-lock.json
- .smike/**

## Notes
- Favor a disposable-project framing so the operator can run the acceptance pass without risking important local runtime state.
- Prefer commands that already exist in the repo or are explicitly documented in the framework docs.
