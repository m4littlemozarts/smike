# SMIKE CLI Module Boundaries

This note records the current boundary between the CLI entrypoint and helper modules.
Use it when adding framework behavior so `scripts/smike/cli.mjs` does not absorb every new concern.

## Rule Of Thumb

Keep `cli.mjs` as the command coordinator and state-machine authority. Move code out when it is:

- pure data shaping
- rendering
- artifact payload construction
- filesystem/process plumbing
- validation or analysis that can be called as a helper
- lifecycle-adjacent bookkeeping that does not choose the next runtime transition

Keep code in `cli.mjs` when it decides command flow, mutates lifecycle authority, reconciles runtime dispatch groups, or advances the run cycle.

## Current Ownership

- `common-utils.mjs`: small normalization, sorting, escaping, glob, and string helpers shared across CLI modules.
- `filesystem.mjs`: JSON and directory helpers that preserve the CLI's fail-fast behavior.
- `process-helpers.mjs`: shell execution, managed child cleanup, nested test-run guards, and process metadata handling.
- `project-locks.mjs`: per-project lock acquisition, stale lock inspection, and lock pruning.
- `derived-artifacts.mjs`: payload builders for generated runtime artifacts such as `RESUME-CAPSULE.json`, `PLAN-GRAPH.json`, `INDEX.json`, and `IMPLEMENTATION-HANDOFF.json`.
- `state-markdown.mjs`: rendering for `.smike/<project>/STATE.md`.
- `planning-renderers.mjs`: rendering for planning `PROJECT.md` and planning `PLAN.md`.
- `planning-capsules.mjs`: planning strategist/detailer capsule payloads and role-history updates.
- `planning-builders.mjs`: construction of planning root plans, phase plans, planning state, and phase-contract analysis views.
- `planning-analysis-state.mjs`: checker/auditor analysis loading, planning artifact freshness, verification projection, and blocked-next-action wording.

Existing domain modules keep their narrower jobs:

- `auditor.mjs`, `checker.mjs`, `review.mjs`: analysis record builders.
- `dispatch.mjs`: dispatch identity and lookup helpers.
- `operator-surface.mjs`: operator-facing summary and dependency-blocker text.
- `planning-analysis-utils.mjs`, `planning-readiness.mjs`: planning scoring and promotion gates.
- `portability-heuristics.mjs`: repo-shape detection and default verification command generation.
- `runtime-artifact-surface.mjs`: dispatch completion artifact requirements.
- `validation.mjs`: schema and contract validation helpers.

## Refactor Boundary

The high-value refactor work is mostly complete once large pure/helper islands have been extracted and covered by the existing test suite.

Do not split `runCycle`, `advance`, or runtime reconciliation just to reduce line count. Those functions are the core state machine. A useful extraction there needs a specific pressure:

- a bug fix that requires isolating a state transition
- a new lifecycle feature with clear ownership
- tests that need a smaller public helper to verify behavior
- repeated code that can be moved without changing transition authority

Until then, leave run-cycle control in `cli.mjs` and keep extracting only obvious helper boundaries around it.

## Test Expectation

For module-boundary changes, run at least:

```bash
node --check scripts/smike/cli.mjs
node --test scripts/smike/cli-planning-draft.test.mjs
node --test scripts/smike/cli-operator-surface.test.mjs
npm test
```

Treat `npm test` as the final green-bar signal before continuing with deeper lifecycle work.
