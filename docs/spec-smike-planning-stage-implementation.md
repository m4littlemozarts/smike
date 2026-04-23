# SMIKE Planning Stage Revision Pass

> **SMIKE spec.**
> Primary refs:
> - README.md
> - scripts/smike/SPEC_AUTHORING.md
> - scripts/smike/RUNTIME_ORCHESTRATOR.md
> - docs/design/plan-planning-stage-architecture.md
> - docs/design/research-smike-planning-architecture-comparative-2026-04-23.md
> - docs/smike-builder-retrospective-2026-04-23.md
> - scripts/smike/cli.mjs
> - scripts/smike/templates/codex/STATE.json
> - scripts/smike/schemas/state.schema.json
> - scripts/smike/cli-planning-draft.test.mjs
> - scripts/smike/cli-operator-surface.test.mjs
> - scripts/smike/lib/operator-surface.mjs

## Objective
Implement the first bounded revision pass for SMIKE planning so prompt-driven entry no longer relies on a weak generic spec bootstrap, planning state can express intake, durable question interrupts, pending answers, accepted answers, typed gaps, proposal freshness, and a bounded compile/preflight loop explicitly, and the operator surfaces remain coherent while the runtime keeps using `./smike` as the normal forward path. The loop should produce a concrete framework change set with targeted tests and doc updates, not another design-only note.

## What The Planner Must Read First
1. README.md
2. scripts/smike/SPEC_AUTHORING.md
3. scripts/smike/RUNTIME_ORCHESTRATOR.md
4. docs/design/plan-planning-stage-architecture.md
5. docs/design/research-smike-planning-architecture-comparative-2026-04-23.md
6. docs/smike-builder-retrospective-2026-04-23.md
7. scripts/smike/cli.mjs
8. scripts/smike/templates/codex/STATE.json
9. scripts/smike/schemas/state.schema.json
10. scripts/smike/cli-planning-draft.test.mjs
11. scripts/smike/cli-operator-surface.test.mjs
12. scripts/smike/lib/operator-surface.mjs
13. scripts/smike/lib/planning-readiness.mjs
14. scripts/smike/lib/checker.mjs

## Critical Constraints
- Preserve `./smike` as the common mutating command for the happy path.
- Keep `./smike <spec.md>` working while upgrading `./smike "<prompt>"` to use a real intake-prep path.
- Do not remove `planning_draft`; use it as the weak-or-provisional planning gate while richer planning state lives under `state.planning`.
- Keep canonical planning truth explicit: accepted answers and accepted planning decisions must converge into one durable planning contract rather than split across ad hoc caches.
- Keep the first journaling pass bounded: planning may gain a narrow append-only journal for authority-changing transitions, but this loop must not rewrite the entire runtime into full event sourcing.
- Keep the planning compile/preflight loop bounded: it should force the contract through existing readiness gates, not create open-ended retry churn.
- Maintain legible operator surfaces in `STATE.md`, `status`, and `doctor` while the planning internals evolve.
- Prefer incremental migration over a one-shot rewrite so current planning tests and runtime invariants can be updated in bounded slices.

## Explicit Non-Goals
- Do not redesign executor, judge, reviewer, or fixer behavior outside the planning revisions needed for this loop.
- Do not make planning children authoritative over canonical plan truth.
- Do not add public-web research as a default planning dependency.
- Do not rewrite unrelated docs outside the planning/runtime docs that need to describe the new intake and planning behavior.
- Do not replace the current markdown spec grammar in this loop.

## Integration Requirements
The plan must decide:
- where the durable intake artifact lives and how `recheck`, `doctor`, and state rendering recover it
- how pending answers become accepted answers and when that promotion updates `planning_context_hash`
- how `planning.gaps` becomes the source-of-truth uncertainty model without creating disagreement with `planning.analysis.blocking_findings`
- whether `state.planning` gains a bounded append-only journal and which planning transitions must be recorded there for recovery and auditability
- how surfaced question batches get durable `interrupt_id` / resume semantics and when a changed planning context invalidates an old batch
- where verify-quality lint lives so malformed or weak proof surfaces block promotion before dispatch readiness
- how the bounded planning compile/preflight pass invokes existing lint/checker/readiness logic, how many local passes it gets, and how failures become typed gaps instead of generic retry churn
- how the old prompt bootstrap fields such as `intake_prompt` and `clarifying_questions` migrate into the richer intake state without leaving broken operator surfaces

## Required Deliverable From This Loop
1. A framework implementation that keeps prompt-driven entry available but routes it through a first-class planning intake model instead of generating a generic parser-facing spec as the primary authority.
2. Durable state, schema, and operator-surface updates that make intake state, question interrupts, pending answers, accepted answers, typed planning gaps, and proposal freshness explicit and machine-auditable.
3. A bounded planning compile/preflight path that runs shared lint, checker, and readiness logic against provisional planning contracts and converts failures into typed gaps.
4. A shared planning-readiness path that derives blockage, readiness, verify-quality lint, and dispatch readiness from one coherent source of truth.
5. Targeted tests that prove prompt entry, compile-loop refinement, intake promotion, question-batch resume semantics, planning blockage semantics, and planning handoff surfaces remain coherent after the revision.
6. Updated runtime/spec authoring docs that describe the new planning intake behavior and retire the old generic prompt-bootstrap guidance.

## Required Plan 01 Contract
- Introduce or reserve explicit planning-intake state under `state.planning` rather than extending the old generic `intake_prompt` / `clarifying_questions` shape indefinitely.
- Introduce or reserve a bounded planning journal under `state.planning` for authority-changing planning transitions, with materialized operator-friendly views still rendered directly in state.
- Introduce or reserve explicit planning compile/preflight state under `state.planning` so local refinement passes, last findings, and pass budgets are visible and auditable.
- Keep the top-level lifecycle meanings stable enough that existing operator/runtime docs remain recognizable while the richer substate moves under `state.planning`.
- Make the first slice update the durable schema/template/operator surface together so later planning work does not depend on hidden state conventions.

## Required Planning Output Shape
- Plan 01: Planning authority boundaries, intake state contract, compile-loop state, and surface migration (category:general; write_scope:scripts/smike/schemas/state.schema.json,scripts/smike/templates/codex/STATE.json,scripts/smike/lib/operator-surface.mjs,scripts/smike/lib/operator-surface.test.mjs,scripts/smike/cli-operator-surface.test.mjs,scripts/smike/cli.mjs; verify:node --test scripts/smike/lib/operator-surface.test.mjs --test-name-pattern "planning intake"|node --test scripts/smike/cli-operator-surface.test.mjs --test-name-pattern "planning intake"|node --test scripts/smike/cli-operator-surface.test.mjs --test-name-pattern "accepted answers")
- Plan 02: Prompt entry intake-prep flow, compile/preflight refinement loop, and interruptible question batches (depends:01; category:general; write_scope:scripts/smike/cli.mjs,scripts/smike/cli-planning-draft.test.mjs,scripts/smike/cli-operator-surface.test.mjs,scripts/smike/templates/codex/STATE.json,scripts/smike/lib/planning-readiness.mjs; verify:node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "prompt intake"|node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "question batch"|node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "compile"|node --test scripts/smike/cli-operator-surface.test.mjs --test-name-pattern "open questions")
- Plan 03: Accepted-answer promotion, typed gap derivation, and planning blockage semantics (depends:02; category:verification; write_scope:scripts/smike/cli.mjs,scripts/smike/schemas/state.schema.json,scripts/smike/templates/codex/STATE.json,scripts/smike/lib/planning-readiness.mjs,scripts/smike/lib/planning-readiness.test.mjs,scripts/smike/cli-planning-draft.test.mjs,scripts/smike/cli-operator-surface.test.mjs; verify:node --test scripts/smike/lib/planning-readiness.test.mjs|node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "typed gap"|node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "planning blocked"|node --test scripts/smike/cli-operator-surface.test.mjs --test-name-pattern "planning blocked")
- Plan 04: Promotion gate upgrade, verify-quality lint, and planning dispatch readiness (depends:03; category:verification; write_scope:scripts/smike/cli.mjs,scripts/smike/lib/checker.mjs,scripts/smike/lib/checker.test.mjs,scripts/smike/lib/planning-readiness.mjs,scripts/smike/lib/planning-readiness.test.mjs,scripts/smike/cli-planning-draft.test.mjs; verify:node --test scripts/smike/lib/checker.test.mjs|node --test scripts/smike/lib/planning-readiness.test.mjs|node --test scripts/smike/cli-planning-draft.test.mjs --test-name-pattern "verify")
- Plan 05: Planning docs, migration notes, and authoring guidance refresh (depends:04; category:doc-drift; write_scope:README.md,scripts/smike/SPEC_AUTHORING.md,scripts/smike/RUNTIME_ORCHESTRATOR.md,docs/design/plan-planning-stage-architecture.md,docs/design/research-smike-planning-architecture-comparative-2026-04-23.md,docs/spec-smike-planning-stage-implementation.md; verify:rg -n "planning intake|interrupt_id|planning journal|compile/preflight" README.md scripts/smike/SPEC_AUTHORING.md docs/design/plan-planning-stage-architecture.md docs/spec-smike-planning-stage-implementation.md|rg -n "accepted answers|typed gaps|verify-quality|shared readiness" scripts/smike/SPEC_AUTHORING.md docs/design/plan-planning-stage-architecture.md docs/spec-smike-planning-stage-implementation.md)

## Priority 1: Planning authority boundaries, intake state, compile-loop state, and surface migration
Establish the durable planning-intake shape before changing prompt entry semantics. Replace the fragile assumption that prompt-related state is just `intake_prompt` plus `clarifying_questions` with an explicit intake substructure that can hold the raw prompt, candidate truth sources, intake questions, intake gaps, readiness state, and pending answers. At the same time, reserve a bounded planning journal for authority-changing transitions and explicit compile/preflight state so later answer, gap, and proposal flows do not fragment across ad hoc caches. Update the template, schema, and operator-facing projections together so `STATE.md`, `status`, and tests do not drift away from the machine contract.

## Priority 2: Prompt entry intake-prep flow, compile/preflight refinement, and interruptible question batches
Replace the old prompt bootstrap that writes a generic parser-facing spec into `memories/` as the main authority. `./smike "<prompt>"` should stay available, but it should enter a real intake-prep flow that mines repo-local truth, captures only the unresolved high-authority questions, runs a bounded compile/preflight refinement loop against current Smike gates, and binds surfaced question batches to durable interrupt semantics. Keep `./smike <spec.md>` stable, and make the migration from old prompt-entry tests explicit rather than implicit.

## Priority 3: Accepted-answer promotion, typed gap derivation, and blockage integration
Make `planning.gaps` the canonical uncertainty model for the richer planning loop and derive the coarse blocking/operator surface from it so the two cannot disagree. Define how pending answers are captured, how accepted answers land in canonical planning truth, and how that affects freshness, invalidation, and blockage semantics. The result should distinguish "questions exist" from "planning is truly blocked" without regressing current readiness and handoff behavior.

## Priority 4: Promotion gate and dispatch-readiness upgrade
The planning revision should not just add richer state; it should move more quality control earlier. Add verify-quality lint, dependency legibility, and dispatch-readiness derivation to the shared planning-readiness path so malformed or generic proof surfaces are blocked before execution handoff. This is the main architecture correction validated by both the retrospective and the external systems review.

## Priority 5: Planning docs, migration notes, and authoring guidance refresh
Once the code path exists, update the live docs so a cold operator can understand the new prompt entry, question interrupt, and planning intake behavior. Retire guidance that tells users to rely on the old generic prompt-bootstrap path, document the richer intake and accepted-answer behavior, and keep the planning-stage design note aligned with the implemented contract rather than the superseded bootstrap model.

## Risk Hotspots
- Prompt-entry migration can break the happy path if old `planning_draft` assumptions remain hard-coded in status or operator-surface helpers.
- Adding a planning journal can create state bloat or double-truth bugs if the reducer/materialized-view boundary is not explicit.
- A compile/preflight loop can become annoying churn if the pass budget, stop conditions, and "failures become typed gaps" rule are not explicit.
- Splitting pending versus accepted answers can create hash and freshness drift if the canonical source is not enforced in one place.
- `planning.gaps` can easily become a second blocker system unless it is explicitly derived into `planning.analysis` in one code path.
- Question-batch interrupts can become flaky if invalidation rules depend on vague timestamps instead of explicit planning-context changes.
- Early verify lint can cause false-positive promotion failures if it is bolted onto checker output instead of integrated into shared readiness logic.
- Docs can become misleading if they describe the new intake layer before the runtime and tests actually use it.

## Explicit Deferrals
- deeper planning-only dispatch role splits beyond the current strategist/detailer envelope
- public-web planning research policy
- replacement of markdown spec grammar with a structured manifest format
- broader execution-runtime simplification outside the planning-stage revisions implemented here
- rich repo-profile / skill loading beyond the minimum repo-local truth-source inventory needed for intake

## Protected / High-Collision Areas
- .smike/**
- package.json
- package-lock.json
- scripts/smike/lib/review.mjs
- scripts/smike/lib/auditor.mjs

## Notes
- Favor file-specific or test-specific verification over broad repo-wide proof commands.
- Keep the first implementation pass bounded enough that a follow-on spec can handle planning proposal artifacts or deeper dispatch refinements if needed.
- When a path needs transitional compatibility, prefer explicit migration code and tests over silent fallback magic.
