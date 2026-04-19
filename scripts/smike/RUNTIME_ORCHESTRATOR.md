# SMIKE Runtime Orchestrator

Read these files in order:

1. `.smike/ACTIVE.json`
2. `.smike/<project>/STATE.json`
3. `.smike/<project>/RESUME-CAPSULE.json`
4. The current `PLAN.json`
5. The referenced capsule `.json` files
6. `.smike/<project>/RUNTIME-DELEGATION.json` only as a convenience projection of the current runtime dispatch view

Hard rule:

If `STATE.json.lifecycle.status == "awaiting_runtime_dispatch"`, you MUST run `STATE.json.lifecycle.next_command` before doing anything else. Exiting without running it is an invariant violation.

`./smike` is the canonical bootstrap, reconciliation, verification, and state-writing layer. The host runtime owns semantic work and real subagent spawning only when the delegation contract says it does.

## Responsibilities

- Start new work with `./smike <spec.md> [context.md ...]`. If authoring a new spec, follow `scripts/smike/SPEC_AUTHORING.md` — it lists the exact H2 sections the planner parses, the phase-blueprint line syntax, and the trigger phrases for review / research mode.
- Resume with bare `./smike`.
- Reconcile with `./smike cycle <project>`.
- Mark runtime-owned dispatch lifecycle with `./smike dispatch <project> <spawned|completed|failed|retry> <dispatch-id>`.
- Treat `STATE.json` as the authority. `RUNTIME-DELEGATION.json` is a derived convenience view generated from `STATE.json.orchestration` for dispatch-facing reads. If they ever disagree, `STATE.json` wins. Capsules are compact worker briefs, not the authority.

## Loop

1. Run `./smike` or `./smike cycle <project>`.
2. Read `STATE.json` first. Use `RUNTIME-DELEGATION.json` only to inspect the current ready dispatch group more quickly.
3. Stop only if the project is complete or genuinely blocked by a user decision, missing credentials, missing external evidence, or intentional manual verification.
4. If lifecycle status is `awaiting_runtime_dispatch`, run `next_command`, spawn the referenced dispatch group, wait for the work, mark each dispatch `completed` or `failed`, then run `./smike cycle <project>`.
5. If `delegation.mode=local_only`, do the work in the main runtime and then run `./smike cycle <project>`.
6. Repeat until complete or genuinely blocked.

## Dispatch Rules

- Only dispatch the current lowest-numbered ready `group`.
- `RUNTIME-DELEGATION.json.ready_dispatches` is a derived shortcut; `STATE.json.lifecycle` is still the source of truth for whether the runtime must act next.
- Do not skip a queued group because files already exist. Freshness is enforced at dispatch completion time.
- Respect `dependency_blockers`. Blocked plans are not runnable yet.

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

Recommended mapping:

- `agent_type_hint=worker` for execution/fix work
- `agent_type_hint=default` for planning, judge, and reviewer work
- `reasoning_effort_hint=high` for planning, judge, reviewer, fixer
- `reasoning_effort_hint=medium` for bounded executor work

## Completion Rules

- `completed` verifies required artifacts.
- If `artifact_change_required=true`, unchanged artifacts are a failed dispatch.
- After a completed or failed runtime dispatch, rerun `./smike cycle <project>`.
- If a new cycle warns about a `handoff_failure`, treat it as a runtime orchestration bug, not a planning failure.

## Local-Only Mode

When `delegation.mode=local_only`, do not invent fake subagents.

Read:

1. `STATE.json`
2. `RESUME-CAPSULE.json`
3. the current `PLAN.json`
4. the latest relevant capsule `.json`

Then do the work directly, run any needed verification, and reconcile through `./smike cycle <project>`.
