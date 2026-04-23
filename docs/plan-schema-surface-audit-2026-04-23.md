# Plan Schema Surface Audit

> Historical audit note. This file records the April 23, 2026 schema-usage pass so later pruning can be evidence-based instead of speculative.

## Goal

Classify the top-level fields in `scripts/smike/schemas/plan.schema.json` by actual usage in the live SMIKE code path.

Meaning of the labels:

- `runtime-read`: the field is consumed by the CLI/runtime or by a load-bearing helper module.
- `written-for-tools`: emitted for schema/tooling compatibility but not used by runtime behavior.
- `human-facing`: read mainly to improve handoff/readability rather than to drive execution.

## Field Audit

| Field | Status | Evidence |
| --- | --- | --- |
| `$schema` | `written-for-tools` | written during plan generation in `scripts/smike/cli.mjs`; no runtime read path found |
| `schema_version` | `written-for-tools` | written into generated artifacts and templates; no execution branch depends on it today |
| `profile` | `runtime-read` | validated and enforced in `scripts/smike/cli.mjs` before generation/validation/runtime use |
| `plan_id` | `runtime-read` | used across workflow graphing, dispatch ids, capsules, validation, and review |
| `phase` | `runtime-read` | used in planning analysis and handoff/reporting surfaces |
| `spec` | `runtime-read` | used to anchor planning/execution context and project handoff surfaces |
| `objective` | `runtime-read` | used in capsules, checker/auditor heuristics, reports, and cycle records |
| `scope` | `runtime-read` | used by planning readiness, checker heuristics, capsules, and cycle records |
| `depends_on` | `runtime-read` | load-bearing for dependency ordering, blocking, and refresh behavior |
| `feature_flags` | `runtime-read` | currently used for phase-refresh and related runtime feature behavior |
| `notes` | `human-facing` | read into planning notes / operator surfaces, but not used as an execution gate |
| `risks` | `human-facing` | folded into planning notes / handoff surfaces, not execution control |
| `allowed_files` | `runtime-read` | used for scope enforcement, checker heuristics, and capsules |
| `blocked_files` | `runtime-read` | used for scope enforcement and capsule boundaries |
| `write_scope` | `runtime-read` | load-bearing for execution boundaries, planning readiness, hashing, and capsules |
| `preflight` | `runtime-read` | load-bearing for tool/env/worktree checks |
| `verify_commands` | `runtime-read` | load-bearing for execution proof, readiness, validation, review, and capsules |
| `acceptance_criteria` | `runtime-read` | load-bearing for acceptance evaluation, validation, review, and capsules |
| `postflight` | `runtime-read` | load-bearing for postflight command execution and failure reporting |
| `planning_context` | `runtime-read` | canonical planning semantics live here and are hashed / surfaced in handoff |
| `workflow` | `runtime-read` | used for auto-continue, phase limits, and fresh-session gating |
| `delegation` | `runtime-read` | load-bearing for runtime-owned dispatch behavior and result-artifact mode |
| `orchestration` | `runtime-read` | load-bearing for role enablement, discovery propagation, and stage behavior |
| `quality_gates` | `runtime-read` | consumed by review/judge quality configuration |

## Current Judgment

Safe pruning candidates at the top level are small:

- `$schema`
- `schema_version`

Those are still useful metadata fields, but they are not part of the live runtime contract.

The next non-trivial pruning candidates are not obvious deletions. They are policy questions:

- `notes`
- `risks`

Those fields are read today, but only into human-facing planning notes. Removing them would simplify the schema, but it would also narrow the operator handoff surface. That should be an intentional product decision, not a blind cleanup.

## Recommendation

Do not aggressively prune the top-level plan schema yet.

The better next step is:

1. Keep the current top-level shape stable.
2. Treat `$schema` and `schema_version` as metadata, not runtime invariants.
3. If more pruning is desired, target low-signal nested surfaces or duplicated human-facing fields before touching the load-bearing execution contract.

## Compatibility Gate

Do not tighten `additionalProperties`, required authority fields, or runtime
dispatch projections until live, archived, and snapshot artifacts have been
sampled with `./smike validate --compatibility`.

The compatibility audit should classify each artifact as:

- `compatible`: valid against current schema and semantic validators.
- `migratable`: structurally close enough for a defined normalization path.
- `unsupported`: intentionally outside the supported runtime contract.

A stricter schema change is ready only after every known `migratable` artifact
has a migration rule or every remaining failure has been deliberately classified
as unsupported historical data.
