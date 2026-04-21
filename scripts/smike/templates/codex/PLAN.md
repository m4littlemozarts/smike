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

## Orchestration
- `orchestration.stage`: `planning` or `execution`
- `orchestration.discovery_propagation`: keep enabled unless downstream phases truly do not need discoveries
- `orchestration.roles.<role>.additional_context`: rare escape hatch only
- Capsules stay sidecar-first; the runner writes them and validates contracts

## Delegation
- `delegation.mode`: `local_only`, `runtime_subagents`, or `auto`
- `delegation.owner`: `smike_runner` or `runtime_orchestrator`
- Keep dispatch and result artifacts minimal
- Runtime behavior lives in `scripts/smike/RUNTIME_ORCHESTRATOR.md`

## Workflow
- `depends_on`: use bare `plan-id` for same-project deps, `project:plan-id` for cross-project deps
- Optional phase contracts live in `workflow.phase_plans`
- Auto-continue defaults on
