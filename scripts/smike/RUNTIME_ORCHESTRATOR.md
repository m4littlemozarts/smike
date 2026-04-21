# SMIKE Runtime Orchestrator

Read these files in order:

1. `.smike/ACTIVE.json`
2. `.smike/<project>/STATE.json`
3. `.smike/<project>/RESUME-CAPSULE.json`
4. The current `PLAN.json`
5. The referenced capsule `.json` files
6. `.smike/<project>/RUNTIME-DELEGATION.json` only as a convenience projection of the current runtime dispatch view
7. `.smike/<project>/PLANNING-HANDOFF.md` as the stable human handoff digest once planning passes

Hard rule:

If `STATE.json.lifecycle.status == "awaiting_runtime_dispatch"`, you MUST run `STATE.json.lifecycle.next_command` before doing anything else. Exiting without running it is an invariant violation.

If `STATE.json.lifecycle.status == "awaiting_fresh_session"`, you MUST stop the current session and resume through `STATE.json.lifecycle.next_command` before starting implementation work. The executor dispatch may already be queued in `STATE.json.orchestration.current_actionable_dispatch`; do not spawn it in the same session that completed planning.

For host runtimes with agent tools, a user invoking `/smike` or asking to resume SMIKE is explicit authorization to execute the runtime-owned dispatches required by the active SMIKE project. Do not stop at `awaiting_runtime_dispatch` to ask whether strategist, detailer, executor, judge, reviewer, or fixer subagents are allowed.

`./smike` is the canonical bootstrap, reconciliation, verification, and state-writing layer. The host runtime owns semantic work and real subagent spawning only when the delegation contract says it does.

## Responsibilities

- Start new work with `./smike <spec.md> [context.md ...]`. If authoring a new spec, follow `scripts/smike/SPEC_AUTHORING.md` — it lists the exact H2 sections the planner parses, the phase-blueprint line syntax, and the trigger phrases for review / research mode.
- Resume with bare `./smike`.
- Advance with `./smike advance [project]` to execute the canonical next step from `STATE.json.lifecycle.next_command`. This is the preferred operator surface for both queued runtime dispatches and fresh-session resumes.
- Diagnose suspicious state with `./smike doctor [project]`. It checks planning inputs, active-project drift, and mismatches between `STATE.json` and derived views.
- Recheck failed or stale planning with `./smike recheck <project>`.
- Reconcile with `./smike cycle <project>`.
- Mark runtime-owned dispatch lifecycle with `./smike dispatch <project> <spawned|completed|failed|retry> <dispatch-id>`.
- When multiple spawned dispatches in the same current group are ready to finish, prefer `./smike dispatch <project> complete-group current` so completion writes stay serialized under one project lock.
- Treat `STATE.json` as the authority. `RUNTIME-DELEGATION.json` is a derived convenience view generated from `STATE.json.orchestration` for dispatch-facing reads. If they ever disagree, `STATE.json` wins. Capsules are compact worker briefs, not the authority.
- Planning inputs are snapshotted into `.smike/<project>/inputs/` during bootstrap and planning refreshes. If the working-tree spec or context files go missing later, prefer restoring them from that snapshot before treating the project as unrecoverable.
- Serialize state-mutating `./smike dispatch ...` commands for a project. The project lock is per-project, so parallel `completed` / `failed` / `retry` updates will race and one will fail on `.smike/<project>/.lock`.

## Loop

1. Run `./smike` or `./smike cycle <project>`.
2. Read `STATE.json` first. Use `RUNTIME-DELEGATION.json` only to inspect the current ready dispatch group more quickly.
3. Treat the planning to implementation boundary as a mandatory fresh-session gate. When planning completes and `STATE.json.lifecycle.status == "awaiting_fresh_session"`, print the bundle digest:
phase graph, per-phase write scope, acceptance surface, and deferred items.
Prefer reading `.smike/<project>/PLANNING-HANDOFF.md` for that digest instead of reconstructing it manually from multiple files.
4. Stop that session after printing the digest. Do not run `./smike cycle <project>` for the first implementation phase in the same session.
5. Stop only if the project is complete or genuinely blocked by a user decision, missing credentials, missing external evidence, or intentional manual verification.
6. If lifecycle status is `awaiting_runtime_dispatch`, run `next_command`, spawn the referenced dispatch group, wait for the work, and mark each dispatch `completed` or `failed`.
If a dispatch command prints a new `next_command`, follow that exact command next. It may be another `spawned` command or `./smike cycle <project>`.
For Codex runtimes, this means using the runtime agent tools directly; there is no separate skill layer.
`next_command` should normally be `./smike advance <project>` now. Treat raw `dispatch spawned ...` commands as debugging or low-level recovery surfaces.
7. If lifecycle status is `awaiting_fresh_session`, stop and resume through `next_command` in a fresh session before touching implementation work. Use `STATE.json.orchestration.current_actionable_dispatch` and `current_actionable_capsule` as the operator-facing handoff surface; `capsules.latest_by_role` is historical context, not the primary “what do I do now?” pointer.
8. If `delegation.mode=local_only`, do the work in the main runtime and then run `./smike cycle <project>`.
If `delegation.mode=auto`, let SMIKE decide whether the current phase stays local or promotes an executor dispatch. Do not force a runtime child unless the cycle queued one.
9. If planning artifacts changed after a failed or completed planning verification pass, run `./smike recheck <project>` or follow the auto-routed recheck path before treating planning as execution-ready. Do not continue into executor work on stale planning reports.
9. Repeat until complete or genuinely blocked.

## Dispatch Rules

- Only dispatch the current lowest-numbered ready `group`.
- Planning dispatch groups are ordered: `1=strategist`, `2=detailers`. Checker and auditor stay local to the CLI for now.
- Implementation phases now default to `delegation.mode=auto`. `auto` promotes only the executor role, and only when the phase is broad enough that subagent overhead is likely worth it.
- Execution does not re-run detailers by default. Planning is expected to leave all phase contracts concrete enough that execution can continue with the first ready plan using the executor/judge/reviewer/fixer loop.
- Dependent implementation phases default to `phase_refresh_mode=auto_detailer_on_drift`. If upstream judge/reviewer evidence or propagated discoveries indicate drift after the last detailer pass, SMIKE queues a phase-local runtime-owned `detailer` refresh for that one plan before execution continues.
- `RUNTIME-DELEGATION.json.ready_dispatches` is a derived shortcut; `STATE.json.lifecycle` is still the source of truth for whether the runtime must act next.
- `PLANNING-HANDOFF.md` is the stable human digest for fresh-session review; `IMPLEMENTATION-HANDOFF.json` remains the machine-readable handoff contract.
- Do not skip a queued group because files already exist. Freshness is enforced at dispatch completion time.
- Respect `dependency_blockers`. Blocked plans are not runnable yet.

## Execution Flow

After the planning boundary:

1. Planning has already authored the phase contracts for the later plans.
2. The first ready implementation plan becomes actionable.
3. SMIKE resolves delegation for that phase: `local_only`, explicit `runtime_subagents`, or `auto` promoted executor dispatch.
4. Before a later plan executes, SMIKE checks for downstream drift from upstream dependency evidence.
5. If drift is low, the executor capsule is refreshed from upstream dependency judge/reviewer capsules and propagated discoveries.
6. If drift is high enough to stale the phase contract, SMIKE queues a phase-local `detailer` refresh for that one plan, rewrites only that phase `PLAN.json`, and then resumes execution.
7. Execution then advances plan-by-plan through executor -> judge -> reviewer -> fixer.

This is intentional: planning does the decomposition once, execution refreshes a bounded plan against live upstream evidence, and dependency gates stop later phases from widening the active surface too early. `auto` gives the runtime a safe way to delegate broad executor work without forcing every implementation phase through full dispatch choreography, and the heavier refresh path stays automatic and phase-local instead of becoming a whole-project replanning loop.

## Child Contract

Pass only the narrow context the child needs:

- dispatch object
- current `PLAN.json`
- capsule `.json`
- required `result_artifacts`
- repo invariants that are not already on disk

Tell every child:

- read the capsule first
- stay inside declared write scope
- do not overwrite artifacts owned by another active dispatch
- write the listed `result_artifacts`
- report blockers explicitly
- list changed files in the final reply

For Codex runtimes:

- Use `spawn_agent` for independent ready dispatches in the same group.
- Parallelize detailers when group `2` contains multiple phase plans.
- Keep the main runtime on the control plane: dispatch lifecycle, waits, completion marking, and `./smike cycle` reconciliation stay local.
- Parallelize the work, not the state writes. Child agents may run in parallel, but dispatch completion/failure commands for a single project should be issued one at a time.

Recommended mapping:

- `agent_type_hint=worker` for execution/fix work
- `agent_type_hint=default` for planning, judge, and reviewer work
- `reasoning_effort_hint=high` for planning, judge, reviewer, fixer
- `reasoning_effort_hint=medium` for bounded executor work

## Completion Rules

- `completed` verifies required artifacts.
- Runtime completion also verifies the dispatch’s machine-readable `completion_requirements`, so JSON artifacts must parse and text artifacts must be non-blank before completion is accepted.
- If `artifact_change_required=true`, unchanged artifacts are a failed dispatch.
- After a completed or failed runtime dispatch, follow the updated `next_command`. If none is printed, rerun `./smike cycle <project>`.
- If a new cycle warns about a `handoff_failure`, treat it as a runtime orchestration bug, not a planning failure.

## Local And Auto Mode

When `delegation.mode=local_only`, do not invent fake subagents.
When `delegation.mode=auto`, also do not invent subagents unless the current cycle actually queued a runtime executor dispatch.

Read:

1. `STATE.json`
2. `RESUME-CAPSULE.json`
3. the current `PLAN.json`
4. the latest relevant capsule `.json`

Then do the work directly, run any needed verification, and reconcile through `./smike cycle <project>`.
