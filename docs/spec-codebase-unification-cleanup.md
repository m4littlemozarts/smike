# Codebase Unification + Hardening Cleanup

> **SMIKE spec.**
> Canonical project slug: `spec-codebase-unification-cleanup`
> Primary refs:
> - `family-tech-platform.md`
> - `memories/MEMORY.md`
> - `memories/security/hardening-plan.md`
> - `memories/security/plan-authz-access-control.md`
> - `memories/cleanup/hygiene-plan.md`
> - `memories/Business/pricing-and-operator-model.md`
> - `AGENTS.md`

This scope should behave like an internal strategist/reviewer, not like an eager implementer.

## Objective

Clean up the Family Tech Platform into a more coherent, trustworthy codebase by unifying the auth/permissions model, reconciling stale docs against live code, removing stale or duplicated implementation paths, and standardizing the route-layer architecture across `shared`, `worker`, `dashboard`, and `cli`.

This is not a feature project. It is a correctness + coherence + maintainability project.

## Meta Intent

This spec is for a read-only SMIKE research loop whose purpose is to generate the best possible cleanup program for a follow-on implementation cleanup run.

Use the full loop to inspect code, docs, tests, manifests, and backlog truth; verify what is live vs stale; and produce a high-confidence findings report plus a proposed multi-phase cleanup plan.

This research loop must optimize for correctness of analysis and quality of planning, not for making code changes.

## SMIKE Framework Alignment

This spec must align with the current SMIKE contract in `scripts/smike/RUNTIME_ORCHESTRATOR.md`.

Treat these as required framework rules for the planner:
- bootstrap and reconciliation are canonical through `./smike` and `./smike cycle <project>`
- `PLAN.json` is the machine contract; `PLAN.md` is the readable summary
- planning output is not complete until the root bundle includes `PROJECT.*`, `PLAN.*`, `ROADMAP.md`, `STRATEGY.md`, `CHECKER.json`, `AUDITOR.json`, `STATE.json`, `PLAN-GRAPH.json`, and `RESUME-CAPSULE.json`
- research phases are runtime-delegated when the plan says `delegation.mode=runtime_subagents` and `delegation.owner=runtime_orchestrator`
- the local runner writes capsules and validates artifacts; it does not pretend to spawn the real research subagents itself
- contract changes should reopen the affected plans through normal SMIKE contract diffing; do not rely on any older special revision-mode behavior
- auto-continue should follow the current default posture: keep `workflow.auto_continue=true` unless the plan has a deliberate reason to pause
- use bare `plan-id` dependencies for same-project phases and `project:plan-id` only for real cross-project dependencies inside `.smike/`

## Research Loop Mode

This SMIKE scope is a read-only research and reconciliation loop.

The loop should use its normal execution, judge, and review structure, but repurposed for investigation:
- Execution: inspect code, tests, docs, manifests, and backlog artifacts; collect evidence
- Judge: verify each major finding against live code and reject weak or stale assumptions
- Review: identify coverage gaps, contradictions, and areas the investigation did not fully settle

This loop must not make implementation changes.
This loop must not perform opportunistic cleanup.
This loop must optimize for quality of findings, truth reconciliation, and follow-on planning.

Planning must not stop after strategist/detailer output alone.
The root planning contract should auto-continue into the research phase graph, and research phases should only pass when their required result artifacts contain substantive findings.

## Research Output Priority

The primary deliverable is a high-confidence findings report.
The secondary deliverable is a proposed multi-phase cleanup plan for a follow-on implementation cleanup run.

If there is a tradeoff between broader implementation planning and better evidence quality, choose better evidence quality.

## Evidence Standard

Do not promote an item into the cleanup plan unless it is supported by at least one of:
- live code evidence
- test evidence
- verified doc/code contradiction
- repeated pattern across multiple files
- confirmed active backlog drift

Speculation, stale docs alone, or single-comment assumptions are not enough.

## Required Deliverable From This Loop

This planning loop must end by producing:
1. A truth reconciliation report
2. A findings inventory with categories and priorities
3. A recommended phase decomposition for the cleanup project
4. Suggested file scopes, dependencies, and verification strategy for the follow-on implementation run
5. A short list of items that should explicitly be left alone
6. A root planning bundle whose machine surfaces match current SMIKE expectations
7. Runtime handoff artifacts that let the host orchestrator continue without guessing
8. Checker and audit outputs that validate the planning bundle before it passes

## Planning Posture

The planning phase must treat live code as the source of truth and docs as advisory until verified.

Do not assume older security or memory docs are current. The planner must explicitly classify each referenced doc as one of:
- `live`
- `partially stale`
- `fixed in code, docs stale`
- `superseded`
- `archive-only`

The first planning output must separate:
- true live bugs / permission gaps
- doc drift
- architectural duplication
- low-risk hygiene
- active in-progress work that should be left alone

## Critical Constraints

- Respect repo invariants from `AGENTS.md`.
- Every D1 access must continue going through the DB wrapper with `PRAGMA foreign_keys=ON`.
- Every family-scoped query must remain family-scoped.
- All MDM interactions must continue through the adapter.
- Do not split schedule editing into a new navigation flow.
- Do not revert or overwrite unrelated dirty-worktree changes.
- Prefer cleanup that strengthens existing architecture over cleanup that invents new architecture.
- Prefer deleting stale paths over preserving dead compatibility layers with comments.

## Additional Planning Constraints

### Dirty Worktree Safety

The planner must assume the repo contains unrelated in-progress work.

For every generated plan:
- avoid broad file scopes when a narrower scope is possible
- call out likely collision zones with active Path B, dashboard, or agent work
- prefer sequencing that cleans shared foundations before touching volatile feature areas
- do not schedule “cleanup” work that requires reverting or rewriting unrelated user changes

### Required Truth Reconciliation Output

Before proposing executable phase plans, produce a short reconciliation table covering the main architecture, security, memory, and cleanup docs.

For each major doc or backlog source, classify it as:
- `live`
- `partially stale`
- `fixed in code, docs stale`
- `superseded`
- `archive-only`

The planner must explicitly identify:
- items still requiring code changes
- items requiring doc-only cleanup
- items that should be removed from active backlog/manifests
- items that should be deferred because they overlap active in-flight work

### Cleanup Decision Rule

When a cleanup candidate is found, classify it as one of:
- `fix now`
- `fix after foundation cleanup`
- `doc only`
- `archive/remove`
- `leave alone`

Do not generate implementation plans for items that are only stale documentation unless they are bundled with a necessary code truth-alignment pass.

## What The Planner Must Read First

1. `AGENTS.md`
2. `family-tech-platform.md`
3. `memories/MEMORY.md`
4. `memories/security/hardening-plan.md`
5. `memories/security/plan-authz-access-control.md`
6. `memories/cleanup/hygiene-plan.md`
7. `memories/Business/pricing-and-operator-model.md`

If touching schedule editor surfaces, also read:
- `memories/schedule-editor-v2-plan.md`

## Known Current Drift Seeds

Use these as starting checkpoints, not assumptions:
- Worker comments and architecture docs still describe webhook HMAC even though current webhook handling uses callback verification.
- MEMORY/security docs still describe some authz/header gaps that appear partially or fully fixed in live code.
- Permission logic exists, but it is spread across middleware, route helpers, and route-local verification functions instead of one clearly canonical model.
- There is significant cleanup backlog around route helper duplication, env type duplication, dead exports, deprecated routes, and stale comments.
- The repo includes generated/build artifacts and local tool state; planner should decide what is truly repo-policy cleanup vs merely local environment noise.

## Planner Must Produce

Before emitting proposed executable phase plans, produce:

1. A repo truth snapshot
   - canonical auth paths
   - canonical permission boundaries
   - major duplicate verification/helper patterns
   - major doc/code contradictions
   - active collision zones from the dirty worktree

2. A cleanup inventory table
   Columns:
   - item
   - category (`permissions`, `route-architecture`, `doc-drift`, `dead-code`, `type-drift`, `artifact-policy`)
   - status (`live`, `stale`, `fixed-in-code`, `superseded`)
   - action (`fix now`, `doc only`, `archive/remove`, `leave alone`, `defer`)
   - rationale
   - likely files

3. A phase graph
   - phase order
   - dependency edges
   - which phases are safe to parallelize
   - which phases must stay sequential

## Protected / High-Collision Areas

Treat these as high-collision unless directly required by the current phase:
- active Path B worker/session files
- active agent-app and agent-cli enrollment files
- large ScheduleEditor surface files
- generated/build artifacts
- local tool state and workspace-specific files

Any plan that touches a high-collision area must justify why cleanup cannot be done elsewhere first.

## Documentation Cleanup Rule

Documentation changes must be one of:
- correcting a material contradiction with live code
- removing stale operational guidance
- updating active planning/manifests to reflect shipped reality
- moving stale guidance to archive

Do not spend a phase on tone, prose polish, or broad rewriting.

## Verification Bias

Every implementation phase should prefer targeted verification over broad suite runs when possible.

Examples:
- route/unit tests for authz changes
- grep/assertion checks for removed deprecated paths
- typecheck on touched packages
- focused tests for canonical helper behavior

Only use full repo verification when the phase genuinely crosses package boundaries.

## Mandatory Exit Condition For Plan 01

Plan 01 is not complete until:
- the canonical auth/permissions model is explicit in code and docs
- misleading webhook/HMAC commentary is removed or corrected
- ownership verification placement is intentional and documented
- at least one targeted regression test protects the canonical permission path

## Likely Low-Yield Areas

Unless evidence points otherwise, treat these as lower priority in the first loop:
- purely visual dashboard polish
- shipped design explorations and archived design docs
- deep performance tuning without signs of architectural drift
- generated artifacts and local build outputs
- feature ideation docs that do not affect current auth/permissions/route truth

Spend the first loop on alignment risk, not broad curiosity.

## Finding Confidence

Each major finding should include a confidence label:
- `high` = directly verified in live code/tests
- `medium` = strongly supported but needs one more confirmation
- `low` = plausible pattern or doc drift, not yet fully verified

Only `high` and strong `medium` findings should drive the proposed second-loop implementation plan.
Low-confidence items should be listed separately as follow-up investigation, not mixed into the main cleanup program.

## Priority Order

### Priority 1: Canonical Auth + Permissions Model

The first executable cleanup phase should establish and document the canonical permission model:
- session auth vs API key auth vs extension auth
- operator vs platform_admin responsibilities
- family ownership checks
- route grouping expectations
- webhook trust model
- which checks belong in middleware vs route helpers vs route-local logic

This phase should also identify and fix comment/doc lies in the code around auth/security, especially where comments contradict real behavior.

### Priority 2: Route-Layer Unification

Standardize route architecture across worker routes:
- shared ownership verification helpers
- canonical env/context typing
- UUID validation patterns
- response/error shape consistency
- route registration and guard consistency
- removal of duplicated helper functions where a canonical helper already exists

### Priority 3: Architecture Doc Reconciliation

Update the base docs so they stop fighting the code:
- `family-tech-platform.md`
- `memories/MEMORY.md`
- active security docs/manifests
- cleanup docs where shipped items need to be marked done or removed

Do not rewrite docs cosmetically. Only change docs where they materially improve planning accuracy or implementation safety.

### Priority 4: Dead Paths, Remnants, and Low-Risk Hygiene

After auth/permissions/doc truth is stabilized:
- remove deprecated routes that are truly dead
- remove stale comments/TODOs that point to old architecture
- remove dead exports and duplicated helpers
- unify obvious low-risk type drift and naming drift
- clean up repo-policy artifacts only if the planner confirms they should not live in source control

### Priority 5: Verification + Guardrails

End with tests and guardrails that make the cleanup stick:
- targeted authz/ownership tests
- route contract tests where cleanup changes behavior
- doc cross-references to the canonical permission model
- acceptance checks that catch future drift

## Explicit Non-Goals

- No new product features
- No redesign of the schedule editor
- No broad enrollment architecture rewrite
- No Path A / Path B behavior changes unless cleanup is required for correctness
- No speculative abstractions without deleting existing duplication
- No “cleanup” that is really a hidden feature build

## Required Planning Output Shape

The planner should produce a bounded multi-phase implementation plan, not one giant blob.

The root planning bundle must be current-SMIKE shaped, not an older narrative-only bundle.
At minimum it should produce:
- `PROJECT.md` and `PROJECT.json`
- `PLAN.md` and `PLAN.json`
- `ROADMAP.md`
- `STRATEGY.md`
- `CHECKER.json`
- `AUDITOR.json`
- `STATE.json`
- `PLAN-GRAPH.json`
- `RESUME-CAPSULE.json`

Recommended decomposition:
- Plan 01: Canonical auth/permissions model + worker truth cleanup
- Plan 02: Route-layer unification and shared verification helpers
- Plan 03: Docs reconciliation for architecture/security/memory
- Plan 04: Dead/remnant cleanup and low-risk hygiene
- Plan 05: Verification hardening and anti-drift guardrails

Dependencies should force auth/permissions truth before broad hygiene.

## Per-Plan Requirements

Each generated plan must include:
- a machine contract in `PLAN.json`
- a readable summary for the root plan in `PLAN.md`
- narrow file scope
- strict `write_scope`
- blocked files
- concrete verification commands
- acceptance criteria tied to executable verification
- explicit `depends_on` edges using plan IDs
- explicit delegation posture
- explicit quality gates for JUDGE and REVIEW
- clear note about how to avoid unrelated dirty-worktree edits

For research phases specifically:
- use `delegation.mode=runtime_subagents`
- use `delegation.owner=runtime_orchestrator`
- name concrete `result_artifacts` that prove substantive findings exist
- keep write scope inside `.smike/<project>/` only

The root planning contract should keep `workflow.auto_continue=true` and use the current default phase budget unless there is a specific reason to constrain it.

Each plan should prefer a small, reviewable write scope over a repo-wide blast radius.

## Success Criteria For The Overall Cleanup Project

The cleanup session is successful when:
- the auth/permissions model is explicit, consistent, and documented
- worker comments/docs no longer contradict live auth/webhook behavior
- operator/family authorization logic is easier to reason about from one canonical path
- stale docs stop reporting already-fixed issues as live blockers
- dead or deprecated code paths are materially reduced
- duplicated route/helper/env patterns are reduced
- verification exists for the permission model and the most important cleanup regressions

## Mandatory Research-Loop Rule

This research loop is successful only if it improves confidence in what should be done next.

Do not optimize this loop for early implementation momentum or for stopping at plan generation.
Optimize it for:
- stronger evidence
- cleaner issue classification
- better sequencing
- lower risk of chasing stale assumptions in the follow-on implementation run

## Final Planning Instruction

Bias the planning phase toward high-leverage unification work first, not cosmetic sweep-up.

If there is tension between “remove clutter” and “make auth/permissions unquestionably correct,” choose auth/permissions first.
