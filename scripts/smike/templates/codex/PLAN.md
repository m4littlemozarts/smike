# PLAN

> Spec authoring contract: `scripts/smike/SPEC_AUTHORING.md` (parsed sections, blueprint line syntax, review/research mode triggers).

## Objective
Describe the user-visible outcome.

## Scope
Define what is in and out for this cycle.

## Write Scope
- `allowed_files`: must match `PLAN.json`.
- `blocked_files`: must match `PLAN.json`.

## Acceptance Criteria
List AC IDs and one-line intent. Full machine mapping lives in `PLAN.json`.

## Verify Commands
Reference command IDs from `PLAN.json`.

## Quality Gates
- `quality_gates.judge.rerun_verify`: keep enabled unless the rerun is prohibitively expensive.
- `quality_gates.review.focus_areas`: list the highest-risk correctness or invariant checks for REVIEW.
- `quality_gates.review.anti_patterns`: optional context-engineering reminders; defaults cover rubber-stamping, weak AC evidence, hidden pre-existing failures, export drift, and broad scope.

## Orchestration
- `orchestration.stage`: `execution` for normal plans, `planning` for strategist/detailer/checker/auditor bundles.
- `orchestration.discovery_propagation`: keep enabled unless downstream plans truly do not need new discoveries.
- `orchestration.roles.<role>.additional_context`: rare escape hatch for high-value sidecars only; avoid kitchen-sink loading and keep it to 8 paths or fewer.
- Capsules are sidecar-first: executor reads state + plan + dependency capsules, judge reads fresh evidence + changed files, reviewer reads verdict + changed surface, fixer reads only blocking findings.
- The local runner writes capsules and validates contracts. It does not spawn real subagents itself.

## Delegation
- `delegation.mode`: use `runtime_subagents` when the outer runtime should spawn real agents from the capsule briefs, or `local_only` when the runner is enough.
- `delegation.owner`: `runtime_orchestrator` when real subagent spawning belongs to the host runtime; `smike_runner` when no runtime delegation is expected.
- `delegation.dispatch_artifacts`: keep this to the minimal runtime handoff files the orchestrator should read first.
- `delegation.result_artifacts`: list the concrete outputs that must exist before a research or delegated phase can pass.
- Host runtime behavior and dispatch ordering live in `scripts/smike/RUNTIME_ORCHESTRATOR.md`.

## Workflow
- `depends_on`: use bare `plan-id` for same-project deps and `project:plan-id` for cross-project deps inside `.smike/`.
- Optional phase contracts: `workflow.phase_plans` in `PLAN.json`.
- Auto-continue defaults to enabled until all phase plans are complete.
- Default `workflow.max_phases_per_run` is 10 so a loop can make progress without drifting too far from operator oversight.
