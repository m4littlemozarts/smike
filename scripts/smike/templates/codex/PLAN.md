# PLAN

Spec authoring contract: `scripts/smike/SPEC_AUTHORING.md`

## Objective
Describe the user-visible outcome.

## Scope
State what is in and out for this cycle.

## Write Scope
- `allowed_files`
- `blocked_files`

## Acceptance Criteria
List AC IDs and one-line intent. Full machine mapping stays in `PLAN.json`.

## Verify Commands
List command IDs from `PLAN.json`.

## Planning Context
- Keep durable planning semantics in `planning_context`
- `truth_sources`, `explicit_deferrals`, and `protected_areas` should survive rerenders

## Orchestration
- `orchestration.stage`: `planning` or `execution`
- `orchestration.discovery_propagation`: keep enabled unless downstream phases truly do not need discoveries
- `orchestration.roles.<role>.additional_context`: rare escape hatch only
- Capsules stay sidecar-first; the runner writes them and validates contracts

## Delegation
- `delegation.mode`: `local_only`, `runtime_subagents`, or `auto`
- `delegation.owner`: `smike_runner` or `runtime_orchestrator`
- Keep result artifacts minimal and explicit
- Runtime behavior lives in `scripts/smike/RUNTIME_ORCHESTRATOR.md`

## Execution Profile
- `execution_policy.profile`: default implementation path is `thin_executor_first`
- `execution_policy.runtime.promotion`: use `complexity_gated_executor_only` unless a plan truly needs wider runtime delegation
- `execution_policy.runtime.roles`: runtime-owned implementation defaults to `executor`
- `execution_policy.runtime.follow_on_roles`: keep follow-on `judge`/`reviewer` local with `local_only`
- `execution_policy.quality.judge_rerun_verify`: keep enabled so runtime output never substitutes for proof
- `delegation` should carry mode/owner/result artifacts only; runtime roles derive from `execution_policy`
- `quality_gates` is legacy compatibility only; generated plans should prefer `execution_policy.quality`

## Workflow
- `depends_on`: use bare `plan-id` for same-project deps, `project:plan-id` for cross-project deps
- Optional phase contracts live in `workflow.phase_plans`
- Auto-continue defaults on
