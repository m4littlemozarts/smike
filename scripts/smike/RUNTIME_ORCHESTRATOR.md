# SMIKE Runtime Orchestrator

Hard rule:

If `STATE.json.lifecycle.status == "awaiting_runtime_dispatch"`, run `STATE.json.lifecycle.next_command` before anything else. If runtime dispatch work is already active and `STATE.json.lifecycle.next_command` is `./smike advance <project>`, keep using that exact authority command until the state machine reaches a different gate. Exiting without doing that is a handoff failure.

Read in this order:

1. `.smike/ACTIVE.json`
2. `.smike/<project>/STATE.md`
3. `.smike/<project>/STATE.json`
4. `.smike/<project>/PLAN.json`
5. The current actionable capsule `.json`
`./smike` is the state machine. The runtime does semantic work and real agent spawning only when the delegation contract says it should.

## Commands

- Start a project with `./smike <spec.md> [context.md ...]`.
- Start a guaranteed clean project with `./smike fresh <spec.md> [context.md ...]`.
- Treat only the first file as the spec contract. Later `context.md` files are supporting refs, not merged spec sections.
- Use `./smike` as the universal entrypoint. With an active or selected project, it should resolve the correct next action automatically.
- Inspect the active project with `./smike resume [project]`.
- Inspect any project with `./smike status [project]` or `./smike list`.
- Advance the exact next step with `./smike advance [project]`.
- Reconcile state with `./smike cycle <project>`.
- Recheck stale planning with `./smike recheck <project>`.
- Inspect suspicious state with `./smike doctor [project]`.
- Mark runtime dispatch state with `./smike dispatch <project> <spawned|completed|failed|retry> <dispatch-id>`.
- Use `./smike dispatch <project> complete-group current` when multiple spawned dispatches in the current group finished.
- Treat `dispatch` as the narrow event/recovery primitive.
- Treat `./smike` as the normal forward mutating surface.
- Treat `./smike advance <project>` as the exact lifecycle authority and recovery/debug primitive surfaced by `STATE.json.lifecycle.next_command`.

Treat `STATE.json` as authority. Treat `STATE.md` as the canonical operator handoff. `orchestration.runtime_dispatch_view` is the grouped dispatch projection. Capsules are worker briefs, not authority.

## Loop

1. Run `./smike` to let the state machine resolve the correct next step, or `./smike status <project>` / `./smike list` to inspect without mutation.
2. Read `STATE.md` first, then `STATE.json` if you need the machine contract.
Use `STATE.json.lifecycle.advance_behavior` and the `STATE.md` actionable surface to understand what the next authority command will actually do from this state.
3. If status is `awaiting_runtime_dispatch`, run `next_command` to surface the queued dispatch group, launch the needed worker(s), then mark each one `spawned` with `./smike dispatch <project> spawned <dispatch-id>` only after the worker actually starts.
4. While runtime dispatches are active, status may stay `in_progress` and still require `./smike advance <project>` as the exact authority command. In normal operation, keep using `./smike`; when you need the exact recovery primitive, follow `next_command`.
5. If status is `awaiting_fresh_session`, stop and resume through `next_command` in a fresh session before implementation. This gate is only for the one-time initial planning-to-implementation boundary when `workflow.fresh_session_gate` is `initial_only`. Set `workflow.fresh_session_gate` to `never` to keep the loop in one session.
6. Use `./smike` for the normal mutating path. Use `./smike advance <project>` when you need to execute the exact lifecycle authority command directly.
7. Use `./smike cycle <project>` for reconciliation that does not require dispatch execution, such as local-only work or explicit state refresh.
8. If delegation is `auto`, only spawn a child when the current cycle actually queued one.
9. Repeat until complete or blocked by a real user decision, missing credentials, or missing external evidence.

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

When the initial planning bundle first finishes and status becomes `awaiting_fresh_session`, stop. This applies only when `workflow.fresh_session_gate` is `initial_only`, and it should happen once per project rather than once per implementation phase. The operator-facing handoff surface is:

- `.smike/<project>/STATE.md`
- `STATE.json.lifecycle.next_command`
- `STATE.json.lifecycle.advance_behavior`
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
- Keep dispatch lifecycle updates and follow-up `./smike advance` / `./smike cycle` reconciliation local in the parent runtime.

Suggested mapping:

- `agent_type_hint=worker` for executor and fixer work
- `agent_type_hint=default` for planning, judge, reviewer
- `reasoning_effort_hint=high` for planning, judge, reviewer, fixer
- `reasoning_effort_hint=medium` for bounded executor work

## Completion

- `completed` verifies required artifacts.
- Runtime completion also verifies machine-readable `completion_requirements`.
- If `artifact_change_required=true`, unchanged artifacts fail the dispatch.
- After any `completed` or `failed` dispatch, follow the new `next_command`. In the active-dispatch path this is usually `./smike advance <project>`, while the normal fast lane remains `./smike`. If none is printed, run `./smike cycle <project>`.
- If a new cycle reports `handoff_failure`, treat that as a runtime orchestration bug, not a planning bug.
