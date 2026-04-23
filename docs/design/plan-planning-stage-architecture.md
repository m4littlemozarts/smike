# Planning Stage Architecture

> Historical design note. This file proposes a planning-stage architecture for SMIKE, not the live runtime contract. Use `README.md` and `scripts/smike/RUNTIME_ORCHESTRATOR.md` for current behavior.
>
> Comparative architecture notes that informed this revision live in `docs/design/research-smike-planning-architecture-comparative-2026-04-23.md`.

Date: 2026-04-23
Scope: define a planning workflow where `./smike` remains the normal mutating entrypoint, planning can ask the user concise questions without hard-stopping prematurely, and bounded planning research can reduce uncertainty before execution.

## Bottom Line

Planning should become an explicit sub-state machine inside SMIKE, not just a parser feeding implementation.

The desired flow is:

1. turn a raw prompt or spec into a structured planning intake
2. promote that intake into a canonical planning contract
3. analyze the contract for typed gaps
4. ask the user only the questions that require user authority
5. continue independent planning work while waiting on those answers
6. merge evidence-backed planning proposals into canonical plan truth
7. promote to execution only when the promotion gate passes

The operator-facing rule stays simple:

- use `./smike` as the normal mutating command
- let SMIKE decide whether the next legal step is parse, local planning work, planning dispatch spawn, planning dispatch reconciliation, question surfacing, or execution handoff
- use `status`, `advance`, `cycle`, and `dispatch` as inspection or recovery primitives, not the common-path planning interface

## Goals

- keep `./smike` as the default forward path
- keep `./smike "<prompt>"` available for simpler feature requests, but make it feed a real intake-prep layer instead of a weak generic draft spec
- make planning a real system with explicit gap discovery and resolution
- ask the user for decisions without collapsing the whole loop immediately
- keep research advisory until the parent planner accepts and merges it
- preserve the existing state-machine discipline, freshness checks, and handoff semantics

## Non-Goals

- do not let planning children write production code
- do not let planning children mutate the canonical plan directly
- do not turn every ambiguity into a hard block
- do not require external web research by default
- do not add a large new set of top-level lifecycle statuses when planning-specific state can live under `state.planning`

## Comparative Architecture Signals

The current direction is broadly right, but the external systems converge on a few implementation details that should become explicit before SMIKE carries this into code:

- planning questions should be durable interrupts with stable ids, not just prose lists
- planning should keep a bounded append-only journal for authority-changing transitions
- readiness, blockage, question state, and proposal freshness should be derived from one reducer pass
- promotion should include verify-quality lint before planning can surface execution-ready work
- planning should run a bounded local compile/preflight loop against real readiness gates before surfacing execution-ready work
- planning parallelism should be derived from dependency edges plus collision checks, not from optimism

Those additions keep the public operator surface small while making recovery and auditability stronger.

## Operator Experience

The ideal operator experience is:

1. `./smike <spec.md>` or `./smike "<prompt>"`
2. `./smike`
3. answer concise questions when SMIKE asks them
4. `./smike`
5. repeat until planning promotes or a real blocker remains

The operator should not need to decide whether the next step is:

- parse the spec again
- run local planning analysis
- spawn planning research work
- reconcile planning dispatches
- ask the user another question batch
- promote planning

That routing belongs inside the planning state machine.

## Core Model

Planning should have five durable layers:

### 0. Intake Preparation

This layer exists for prompt-driven entry and for weak specs that are not yet good enough to become canonical planning contracts.

Input:

- raw prompt text or underspecified spec
- attached context files
- repo-local truth sources
- prior accepted answers

Output:

- `planning.intake.raw_prompt` or equivalent source reference
- candidate truth sources
- candidate scope and phase shape
- typed intake gaps
- a promotion check for whether the input is ready to become the canonical planning contract

Canonical rule:

- prompt-driven entry should not generate a fake parser-facing spec as the primary authority
- prompt-driven entry should first produce an intake artifact owned by `STATE.json > planning.intake`
- only after the intake promotion gate passes should SMIKE synthesize or update the canonical planning contract consumed by the normal planning loop
- this preserves the convenience of `./smike "<prompt>"` without polluting canonical plan truth with low-confidence scaffolding

### 1. Contract Normalization

Input:

- spec markdown
- attached context files
- repo-local truth sources
- prior question answers

Output:

- normalized planning bundle
- inferred planning context
- initial phase decomposition
- explicit unresolved references

Canonical rule:

- transient planning work lives in `STATE.json > planning`
- accepted planning decisions live in `PLAN.json > planning_context`
- specifically, accepted user answers should be promoted into a single canonical field such as `PLAN.json > planning_context.accepted_answers`
- `STATE.json > planning.answers` may exist as a working cache or operator surface, but if it disagrees with `PLAN.json > planning_context.accepted_answers`, the plan wins
- accepted-answer changes should change `planning_context_hash`; they should not change `spec_hash` unless the spec text itself changed
- managed spec annotations, if they exist, are derived provenance views, not a second source of truth

This is where the current parser already helps. It should remain strict enough to produce canonical structure, but it should no longer be the whole planning story.

### 2. Gap Analysis

Planning should detect typed gaps instead of relying on vague prose blockers.

Recommended gap types:

- `missing_truth_source`
- `missing_phase_decomposition`
- `missing_dependency_owner`
- `missing_write_scope`
- `missing_verify_surface`
- `missing_acceptance_signal`
- `unresolved_reference`
- `open_product_decision`
- `external_evidence_required`
- `clarification_needed`

Each gap should carry:

- `id`
- `type`
- `severity`
- `phase_id` or `plan_id`
- `question`
- `resolution_mode`
- `status`
- `confidence`
- `evidence`
- `stale_if`

The important shift is that planning becomes a queue of typed uncertainties, not just a pass/fail parser review.

Canonical rule:

- `planning.gaps` is the source-of-truth uncertainty model during planning
- `planning.analysis.blocking_findings` remains the coarse operator/runtime projection derived from unresolved blocking gaps plus checker/auditor evidence
- promotion, blockage, and freshness logic should be computed from one pass so `planning.gaps` and `planning.analysis` cannot disagree

## Authority Boundaries

Planning should keep three layers of authority separate:

- repo truth sources and attached context files
- working planning state in `STATE.json > planning`
- accepted planning truth in `PLAN.json > planning_context`

Recommended durable mechanism:

- record authority-changing planning transitions in a bounded `planning.journal`
- materialize `planning.open_questions`, `planning.answers`, `planning.gaps`, `planning.readiness`, and proposal freshness from that journal in one reducer path
- keep the journal scoped to planning; do not rewrite the entire runtime into full event sourcing in the first rollout

Recommended event kinds:

- `intake_refreshed`
- `question_batch_opened`
- `answer_recorded`
- `answer_accepted`
- `gap_status_changed`
- `proposal_received`
- `proposal_merged`
- `promotion_blocked`
- `promotion_passed`

## Planning Compile Loop

Planning should not stop at "this looks like a reasonable plan." It should run a bounded compile/preflight loop against the same gates the current framework already enforces.

The rule:

- planning succeeds only when it produces a contract that passes SMIKE's current planning promotion and readiness gates
- subagents and local planner passes may improve the contract, but they do not redefine what "ready" means

Recommended compile loop:

1. materialize the current provisional intake or planning contract
2. run parser lint, verify lint, checker logic, and planning-readiness checks
3. convert every failure into typed gaps with explicit ownership
4. resolve inline-local gaps immediately when repo facts or deterministic rewrites are enough
5. surface only true authority questions to the user
6. rerun the compile pass after accepted answers or accepted proposal merges land
7. stop when promotion passes or the bounded local refinement budget is exhausted

Design intent:

- this is not open-ended retry churn
- this is a bounded local refinement loop that forces planning to satisfy the real framework contract before execution handoff

Recommended policy:

- `planning.compile.max_local_passes = 3`
- `planning.compile.promote_only_on_shared_readiness = true`
- `planning.compile.emit_gaps_from_failures = true`

Current gate families the compile loop should exercise:

- spec lint for required planning shape
- verify-command lint for malformed, generic, or missing-target proof commands
- checker findings for dependency legibility, placeholder scope, overlap, and first-phase ownership
- planning-readiness checks for concrete summaries, write scope, proof specificity, and execution readiness

### 3. Resolution Engine

Every gap should be resolved through one of four paths:

- `inline_local`
  Meaning: SMIKE can resolve this from current repo facts without delegation.
- `ask_user`
  Meaning: the user owns this decision or clarification.
- `planning_dispatch`
  Meaning: a bounded planning child should produce a proposal artifact.
- `hard_block`
  Meaning: progress cannot continue because required authority, credentials, or external policy is missing.

### 4. Promotion Gate

Planning promotes only when:

- no blocking typed gaps remain
- canonical plan truth is concrete enough for execution
- planning proposals are either merged, rejected, or marked stale
- verification surface is specific enough to support execution review
- dependency ordering and write-scope boundaries are auditable

This gate is where the current planning-readiness work belongs.

Planning should also have an earlier intake promotion gate:

- prompt- or intake-driven work promotes into the canonical planning contract only when repo truth sources, likely scope boundaries, and blocking user questions are concrete enough to stop being provisional intake data
- after that gate passes, the normal planning contract takes over and the richer planning loop continues

## Question-Asking Without Premature Stop

The planning loop should ask the user questions and keep going when there is still independent planning work available.

### Rule

If at least one open gap can still be progressed without the missing user answer, planning should continue.

Examples:

- if route ownership is unclear but proof-surface design can proceed, ask the question and continue proof design
- if provider choice is unresolved but auth-flow comparison can still be prepared for each option, ask the question and continue option scouting
- if a user decision affects all remaining work, then planning may enter a true blocked state

### Question Batches

Questions should be:

- short
- user-authority only
- batched conservatively
- stable until answered or invalidated

Recommended limits:

- ask at most 1-3 questions in one batch
- prioritize the highest-leverage decision questions first
- do not re-ask the same question with different wording unless assumptions changed

### State Shape

Questions should be tracked explicitly in `state.planning`, for example:

- `planning.open_questions`
- `planning.question_batches`
- `planning.last_question_batch_id`
- `planning.active_interrupt_id`
- `planning.answers`

Each question should record:

- `id`
- `text`
- `reason`
- `phase_id` or `plan_id`
- `blocking_scope`
- `asked_at`
- `answered_at`
- `answer`
- `status`

Each question batch should also record:

- `batch_id`
- `interrupt_id`
- `question_ids`
- `invalidated_at`
- `invalidated_by_planning_context_hash`

### Block Semantics

`planning_blocked` should mean:

- there is no more useful planning work to do until a required answer or external condition arrives

It should not mean:

- at least one user question exists

That distinction is load-bearing. Open questions are normal. Full planning blockage should be rarer.

## Planning Research

Planning research should be narrow, typed, and advisory.

### Allowed Planning Research

Planning research is a good fit for:

- repo-local truth-source discovery
- dependency and collision mapping
- interface and pseudocode sketches
- option comparison
- proof and verification design
- identifying candidate write-scope boundaries

### Not Allowed By Default

Planning research should not:

- browse the public web unless the planning policy allows it
- make product decisions
- rewrite canonical phase plans directly
- silently promote assumptions into execution truth

### Research Outputs

Planning children should write proposal artifacts, not canonical plan artifacts.

Recommended artifact kinds:

- `RESEARCH-PROPOSAL.json`
- `OPTION-MATRIX.json`
- `PROOF-PROPOSAL.json`
- `DEPENDENCY-NOTES.json`

Every proposal artifact should include:

- `proposal_id`
- `gap_ids`
- `assumptions`
- `evidence`
- `confidence`
- `recommended_merge`
- `stale_if`
- `generated_at`

### Merge Rule

The parent planner owns merge.

That means:

- children may suggest
- parent accepts, rejects, or parks
- only accepted content becomes canonical `PLAN.json` truth
- proposal completion may update receipt/freshness bookkeeping, but it must not auto-accept semantic plan changes

## Recommended Planning Roles

The first planning version should stay small.

Recommended planning-only roles:

- `api-research`
- `pseudocode-detailer`
- `option-scout`
- `proof-designer`
- `blocker-mapper`

These should not become first-class runtime dispatch ids in the first rollout.

Instead, treat them as planning work modes that map onto the existing planning runtime profile:

- `strategist` may run `api-research`, `option-scout`, and `blocker-mapper` flavored work
- `detailer` may run `pseudocode-detailer` and `proof-designer` flavored work
- checker and auditor stay local and continue to produce the coarse planning analysis surface

Only split these into new dispatch role ids later if the existing `strategist` and `detailer` envelope proves too coarse in real usage.

## State-Machine Integration

Planning should fit into the existing coarse lifecycle model rather than replace it.

### Keep Existing Top-Level Lifecycle Meaning

- `planning_draft`
  Intake or normalized contract work exists, but promotion fails because the planning input is still too weak, too generic, or too provisional.
- `planning`
  Planning is active and the planner is doing intake prep, local analysis, merge work, or question/research scheduling.
- `awaiting_runtime_dispatch`
  A planning dispatch group is queued and ready to spawn.
- `in_progress`
  Planning dispatch work is active or being reconciled.
- `planning_blocked`
  No more useful planning progress is possible until a user answer or external condition arrives.
- `awaiting_fresh_session`
  Planning is complete and execution is ready behind the fresh-session gate.

### Add Rich Planning Substate

The richer planning lifecycle should live under `state.planning`, for example:

- `planning.stage`
  Values: `intake_prep`, `intake_promotion_check`, `normalize`, `compile`, `gap_analysis`, `questioning`, `research`, `merge`, `promotion_check`
- `planning.journal`
- `planning.intake`
- `planning.intake.raw_prompt`
- `planning.intake.candidate_truth_sources`
- `planning.intake.candidate_phase_shape`
- `planning.intake.gaps`
- `planning.intake.open_questions`
- `planning.intake.interrupt_id`
- `planning.intake.readiness`
- `planning.gaps`
- `planning.research_queue`
- `planning.proposals`
- `planning.open_questions`
- `planning.question_batches`
- `planning.answers`
- `planning.verify_lint`
- `planning.compile`
- `planning.compile.pass_count`
- `planning.compile.last_findings`
- `planning.dispatch_activation_groups`
- `planning.readiness`

This keeps the human/operator lifecycle stable while making planning internally legible.

## `./smike` Decision Algorithm During Planning

When the selected project is in planning, `./smike` should do the first applicable step below:

1. If the project started from a prompt or weak intake, refresh `planning.intake` from the latest prompt, accepted answers, and repo facts.
2. Recompute intake gaps and the intake promotion check.
3. If intake questions should be surfaced now, print them and mark them active.
4. If intake work is still provisional but progressable, continue intake prep.
5. If the intake promotion gate passes, synthesize or refresh the canonical planning contract from the accepted intake state.
6. Rebuild or refresh the normalized planning bundle if the spec or accepted answers changed.
7. Replay or refresh the planning journal materialized views if new answers, gap changes, or proposals landed.
8. Run the bounded planning compile/preflight pass against shared lint, checker, and planning-readiness gates.
9. Recompute typed gaps, verify-quality lint, and planning readiness from one shared pass.
10. Reconcile any completed planning proposal artifacts into the parent merge queue and refresh their freshness state.
11. If a question batch should be surfaced now, print it, attach the active interrupt id, and mark it active.
12. If there is independent inline planning work, do it.
13. If planning dispatch activation groups are ready, transition to `awaiting_runtime_dispatch`.
14. If planning dispatches are active or failed, reconcile them.
15. If blocking gaps remain but other work still exists, stay in `planning`.
16. If blocking gaps remain and no other work exists, enter `planning_blocked`.
17. If readiness passes, promote planning and continue toward execution handoff.

This keeps `./smike` as the fast lane while preserving exact authority commands under `next_command` for recovery and inspection.

Important constraint:

- no semantic proposal content should become canonical plan truth without an explicit parent acceptance step

## Answer Flow

The answer path should be explicit.

### Proposed Behavior

When SMIKE asks questions:

- it writes them into state and the operator surface
- it binds the surfaced batch to an `interrupt_id`
- the current interactive session asks the user directly
- the user answers in plain language
- those answers are first recorded in `STATE.json > planning.answers` as pending structured planning answers
- `./smike` reruns normalization and gap analysis using accepted answers from `PLAN.json > planning_context.accepted_answers` and any still-pending answers only as candidate inputs awaiting acceptance

### Important Constraint

Accepted answers should not mutate the original user spec text invisibly.

Instead, the planning truth should make the answer source explicit through one canonical promotion path:

- pending or newly captured answers live in `STATE.json > planning.answers`
- pending intake-specific answers may also be grouped under `STATE.json > planning.intake.answers`
- accepted answers are promoted into `PLAN.json > planning_context.accepted_answers`
- any appended managed answer block in the spec is optional derived provenance only

The framework should preserve provenance for every planning decision.

Additional constraint:

- question batches should be invalidated explicitly when a newer planning context makes them stale
- resuming after a question answer should target the active interrupt batch, not rely on fuzzy "latest question" behavior

## Prompt-Driven Entry

Prompt-driven entry should stay supported, but it should become a real planning-intake path instead of a generic spec-template shortcut.

### Intended Behavior

When the operator runs `./smike "<prompt>"`:

- SMIKE records the prompt under `planning.intake.raw_prompt`
- SMIKE mines repo-local truth sources and candidate scope before asking broad questions
- SMIKE asks only the highest-authority unresolved questions needed to stabilize scope
- SMIKE tracks intake gaps separately from post-contract planning gaps
- SMIKE promotes into the canonical planning contract only when the intake promotion gate passes

### Important Constraint

Do not treat prompt entry as "write a generic markdown spec and hope the rest of planning fixes it later."

Instead:

- prompt entry should produce a first-class intake artifact
- the intake artifact should be revisable, auditable, and freshness-aware
- the canonical spec or planning contract should be synthesized from accepted intake state, not from canned placeholder prose

That keeps simple feature requests ergonomic without dragging low-confidence scaffolding into the durable planning contract.

## Suggested Planning Policy

Planning policy should be explicit and configurable.

Recommended defaults:

- `questions.max_batch_size = 3`
- `research.allow_repo_local = true`
- `research.allow_external = false`
- `research.max_parallel_children = 3`
- `research.max_depth = 2`
- `planning.compile.max_local_passes = 3`
- `planning.compile.promote_only_on_shared_readiness = true`
- `promotion.require_no_blocking_gaps = true`
- `promotion.require_verify_lint_clean = true`
- `promotion.require_specific_verify_surface = true`
- `promotion.require_dependency_legibility = true`

## Acceptance Criteria

This planning architecture is working when:

- `./smike` remains the common-path mutating command
- `./smike "<prompt>"` remains available for simple requests, but routes through intake prep instead of generic placeholder spec generation
- planning asks concise user questions without collapsing into constant hard blocks
- planning continues independent work while answers are pending
- planning children reduce uncertainty without stealing authority
- stale planning research is invalidated instead of silently merged
- planning runs a bounded compile/preflight loop against real framework gates before execution handoff
- promotion to execution reflects actual readiness, not just parser success
- operator-facing state clearly distinguishes open questions from true planning blockage
- question batches can be resumed or invalidated deterministically
- planning dispatch readiness reflects the phase DAG plus scope-collision analysis

## Rollout Plan

### Phase 1: Planning Journal, Compile Loop Skeleton, And Typed Gap Model

Add:

- `planning.journal`
- `planning.compile`
- `planning.intake`
- `planning.gaps`
- question records
- resolution modes
- planning-stage substate

Define at the same time:

- intake gaps as canonical truth during prompt/weak-spec preparation
- `planning.gaps` as canonical uncertainty truth
- `planning.analysis.blocking_findings` as its derived operator/runtime projection
- a reducer path that materializes question state, answers, and readiness from the journal
- a bounded compile/preflight pass that turns lint/checker/readiness failures into typed gaps

Do not add planning children yet.

### Phase 2: Question Queue And Answer Integration

Add:

- intake-question batching
- question batching
- durable `interrupt_id` binding for surfaced batches
- structured answer storage
- rerun behavior after answers land
- distinction between open-question and fully blocked planning
- canonical promotion from pending answers in state into accepted answers in `PLAN.json > planning_context`

### Phase 3: Intake Promotion

Add:

- intake promotion checks
- synthesis of canonical planning contracts from accepted intake state
- retirement of the old generic prompt-to-spec bootstrap path

### Phase 4: Planning Dispatch Profile

Add:

- planning-only roles
- planning proposal artifacts
- merge rules
- staleness detection for proposals
- derived dispatch activation groups from the phase DAG plus scope-collision analysis

### Phase 5: Promotion Gate Upgrade

Unify:

- parser lint
- typed gap closure
- journal/materialized-view refresh
- verification-quality checks
- first-phase ownership checks
- dependency legibility
- compile/preflight pass budgeting and stop conditions

### Phase 6: Limited External Research Policy

Only after repo-local planning research works well:

- allow explicitly policy-gated external research
- require provenance and freshness
- keep it advisory unless merged

## What Not To Do

- do not make planning children authoritative
- do not treat every open question as a top-level blocked state
- do not auto-merge plausible proposals into canonical plan truth
- do not let planning recurse without bounded depth and ownership
- do not mix execution dispatches into planning-only research profiles
- do not make `./smike` ask large surveys instead of progressing the plan

## Summary

The right planning architecture is:

- one normal mutating command: `./smike`
- one authoritative parent planner
- typed gap discovery
- concise user questions
- advisory planning research
- explicit merge
- explicit promotion gate

That gives SMIKE a real planning system without giving up the state machine that already makes the runtime legible.
