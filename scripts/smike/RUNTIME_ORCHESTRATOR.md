# SMIKE Runtime Orchestrator

Hard rule:

If `STATE.json.lifecycle.status == "awaiting_runtime_dispatch"`, run `STATE.json.lifecycle.next_command` before anything else. Exiting without doing that is a handoff failure.

Read in this order:

1. `.smike/ACTIVE.json`
2. `.smike/<project>/STATE.md`
3. `.smike/<project>/STATE.json`
4. `.smike/<project>/PLAN.json`
5. The current actionable capsule `.json`
6. `.smike/<project>/PLANNING-HANDOFF.md` only when planning just finished

`./smike` is the state machine. The runtime does semantic work and real agent spawning only when the delegation contract says it should.

## Commands

- Start a project with `./smike <spec.md> [context.md ...]`.
- Use `./smike` as the universal entrypoint. With an active or selected project, it should resolve the correct next action automatically.
- Inspect the active project with `./smike resume [project]`.
- Inspect any project with `./smike status [project]` or `./smike list`.
- Advance the exact next step with `./smike advance [project]`.
- Reconcile state with `./smike cycle <project>`.
- Recheck stale planning with `./smike recheck <project>`.
- Inspect suspicious state with `./smike doctor [project]`.
- Mark runtime dispatch state with `./smike dispatch <project> <spawned|completed|failed|retry> <dispatch-id>`.
- Use `./smike dispatch <project> complete-group current` when multiple spawned dispatches in the current group finished.

Treat `STATE.json` as authority. Treat `STATE.md` as the canonical operator handoff. `orchestration.runtime_dispatch_view` is the grouped dispatch projection. Capsules are worker briefs, not authority.

## Loop

1. Run `./smike` to let the state machine resolve the correct next step, or `./smike status <project>` / `./smike list` to inspect without mutation.
2. Read `STATE.md` first, then `STATE.json` if you need the machine contract.
3. If status is `awaiting_runtime_dispatch`, run `next_command`, spawn the queued dispatch group, wait for the work, then mark each dispatch `completed` or `failed`.
4. If status is `awaiting_fresh_session`, stop and resume through `next_command` in a fresh session before implementation. Do not start the first implementation phase in the same session that finished planning.
5. Use `./smike advance <project>` for any state mutation or execution.
6. If delegation is `local_only`, do the work locally and reconcile with `./smike cycle <project>`.
7. If delegation is `auto`, only spawn a child when the current cycle actually queued one.
8. Repeat until complete or blocked by a real user decision, missing credentials, or missing external evidence.

For Codex runtimes, a user invoking `/smike`, `./smike`, or asking to resume SMIKE is explicit authorization to execute required runtime-owned dispatches. Do not stop to ask whether strategist, detailer, executor, judge, reviewer, or fixer dispatches are allowed.

## Dispatch Rules

- Dispatch only the current lowest-numbered ready group.
- Planning runtime groups are `1=strategist`, `2=detailers`.
- Checker and auditor stay local.
- Execution usually runs plan-by-plan through executor, judge, reviewer, fixer.
- `auto` may promote only executor work; do not invent extra subagents.
- Respect `dependency_blockers`. Blocked plans are not runnable.
- Serialize `./smike dispatch ...` writes per project. Parallel child work is fine; parallel state writes are not.

## Fresh-Session Boundary

When planning finishes and status becomes `awaiting_fresh_session`, stop. The operator-facing handoff surface is:

- `.smike/<project>/STATE.md`
- `STATE.json.lifecycle.next_command`
- `STATE.json.orchestration.current_actionable_dispatch`
- `STATE.json.orchestration.current_actionable_capsule`

`capsules.latest_by_role` is history, not the primary "what do I do now?" pointer.

## Child Contract

Give each child only the narrow context it needs:

- the dispatch object
- `PLAN.json`
- the capsule `.json`
- required `result_artifacts`
- any repo invariants not already on disk

Tell every child:

- read the capsule first
- stay inside declared write scope
- do not overwrite artifacts owned by another active dispatch
- write the listed `result_artifacts`
- report blockers explicitly
- list changed files in the final reply

For Codex runtimes:

- Use `spawn_agent` for independent ready dispatches in the same group.
- Parallelize detailers within group `2`.
- Keep dispatch lifecycle updates and `./smike cycle` local in the parent runtime.

Suggested mapping:

- `agent_type_hint=worker` for executor and fixer work
- `agent_type_hint=default` for planning, judge, reviewer
- `reasoning_effort_hint=high` for planning, judge, reviewer, fixer
- `reasoning_effort_hint=medium` for bounded executor work

## Completion

- `completed` verifies required artifacts.
- Runtime completion also verifies machine-readable `completion_requirements`.
- If `artifact_change_required=true`, unchanged artifacts fail the dispatch.
- After any `completed` or `failed` dispatch, follow the new `next_command`. If none is printed, run `./smike cycle <project>`.
- If a new cycle reports `handoff_failure`, treat that as a runtime orchestration bug, not a planning bug.
