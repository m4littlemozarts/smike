# SMIKE Simplification Plan

Date: 2026-04-18
Scope: recover the thin, fluid feel of the original SMIKE loop without throwing away the durable control-plane machinery added in the last two days.
Companion doc: `smike-upgrade-review-notes-2026-04-18.md` (review notes — read first).

## Bottom Line

**Keep the state machine. Burn the surface around it.**

The state machine itself is not the problem. `contract_hash`, `depends_on`, dispatch freshness, and `write_scope` are doing real work and should stay. What has ballooned is the *artifact and prose surface* that wraps those mechanics: dual `.json`/`.md` mirrors, two parallel control-plane documents, 52 capsule files per project, 8 orchestration roles with near-identical capsule shapes, and two runtime prompt docs that partly contradict each other.

The fix is not a rewrite. It is an aggressive deletion pass, followed by one targeted state-machine addition (the `awaiting_runtime_dispatch` lifecycle) that removes the specific handoff ambiguity the review notes identified.

## Why This Is The Call (Not "Throw It Away")

The thin 2-days-ago version had real gaps: no resumability, no artifact freshness, no dependency gating, no write-scope enforcement. Going back to that loses measurable correctness guarantees. The user would feel fluid momentum for a while and then get bitten by the same cross-session drift problems.

The current heavy version has the opposite failure mode: correctness guarantees are in place, but the operator has to juggle too many artifacts to feel the benefit. The state machine is doing its job and then asking for a tax on top.

The third option — keep the durable mechanics, delete the surface duplication, collapse orchestration docs, and add one targeted invariant — is the cheapest recovery path and the one the review notes already point at.

This simplification is also a model-compatibility fix, not just a housekeeping pass. The GPT stack exposed the fragility more sharply than the earlier posture did, so the validation plan has to prove the simplified loop works on both Opus and GPT-family runtimes.

## Numeric Baseline (for reference, not bragging)

Measured in the current tree on 2026-04-18:

- `scripts/smike/cli.mjs`: 7,427 lines (was 1,247 two days ago — 5.9× growth)
- `scripts/smike/RUNTIME_ORCHESTRATOR.md`: 257 lines, ~1,595 words
- `scripts/smike/CODEX_PROFILE.md`: 169 lines, ~1,144 words
- `.smike/CODEX.md`: 290 lines
- State schema: 351 lines (added 274 in the last two days)
- Plan schema: 454 lines, 31 top-level properties
- `scripts/smike/lib/`: 7 modules, 727 lines (was 0 modules two days ago)
- `spec-codebase-unification-cleanup` project: 97 total files, 52 capsules, 28 control-plane artifacts, ~23k words of control-plane prose
- Per phase: 8 capsule files (4 roles × 2 formats), 2–4 phase-local artifacts

These numbers are the *symptom*. The disease is that the operator now has to answer "what's next?" by reading 5+ files instead of 1.

## Three Passes

The work is sequenced into three passes so each pass is independently shippable and testable. Do not pre-plan migrations that depend on later passes landing. If Pass 1 alone feels good, stop.

---

### Pass 1 — Deletion Pass (no behavior change, just surface collapse)

Goal: cut the artifact and prose surface in half without changing the durable mechanics underneath. This pass alone should noticeably restore the "thin" feel because most of the operator's cognitive load is surface, not logic.

#### 1a. Kill `.md` mirrors of machine-read `.json` artifacts

Current pattern: `cli.mjs` writes both `X.json` and `X.md` for almost every artifact. Runtime reads only the `.json`. The `.md` exists purely for human readability, but the content is structurally identical and the `.md` immediately drifts from the `.json` whenever either regenerates.

Delete (stop generating) the `.md` side of these pairs:
- `PLAN-GRAPH.md` (keep `PLAN-GRAPH.json`)
- `RUNTIME-DELEGATION.md` (keep `.json`)
- `AUDITOR.md` *and* `AUDIT.md` (fold into `AUDITOR.json` — they are currently duplicates of each other, which is its own bug)
- `CHECKER.md` (keep `.json`)
- All `capsules/*-*-capsule.md` files (keep `.json`)
- Phase-local mirror pairs such as `phases/**/XX-PLAN.md` next to `XX-PLAN.json`, and any `XX-FINDINGS.md` / `XX-FINDINGS.json` pair that is just dual-rendering the same payload

Keep (these are genuinely human-first):
- `PROJECT.md` (scope brief the user actually reads when setting up a project)
- `STATE.md` (useful for the operator to `cat` to know where they are)
- `ROADMAP.md`
- `SMIKE-NOTES.md` (session-end notes log; planning and implementation loops should append to it rather than dropping it)

Notes retention rule:
- The end-of-session note-keeping artifact must stay.
- Planning loops should leave a short session-end note in `SMIKE-NOTES.md` capturing what was decided, what changed, and the next expected entry point.
- Implementation loops should leave a short session-end note in `SMIKE-NOTES.md` capturing what shipped, what was verified, what remains, and any blocker or handoff context.
- Simplification work may trim duplicated prose around the loop, but it must not delete, stop generating, or stop appending the session-end notes artifact.

Project artifact decision:
- Treat `PROJECT.md` as the intended long-term canonical project brief.
- Do **not** delete `PROJECT.json` in the same step as the mirror cleanup.
- First grep the runtime/CLI for `PROJECT.json` consumers. If none are load-bearing, remove `PROJECT.json` in a follow-up deletion inside Pass 1 rather than mixing that decision into the generic mirror pass.

Phase-local artifact rule:
- Root artifacts are not the only target. Phase directories are in scope too.
- If a phase artifact is a machine-read structural payload, keep the `.json` and stop emitting the `.md` mirror.
- If a phase artifact is intentionally human-first prose, keep the `.md` and stop emitting the `.json` mirror.
- The rule is one canonical artifact per payload, not dual renderings forever.

Net reduction from the pure mirror cleanup: still roughly the high-50s files per project, plus one more if `PROJECT.json` proves deletable.

Implementation: a single pass through `cli.mjs` ripping out the `write*Md` calls that mirror `.json` output. No schema changes. No runtime changes.

#### 1b. Collapse AUDIT / AUDITOR redundancy

Current state: `AUDIT.json` and `AUDITOR.json` exist in parallel and contain identical content (293 words each). Same for their `.md` versions. This appears to be a renaming that was never completed.

Pick one name (`AUDITOR.json` reads cleaner as the role-scoped artifact). Delete the other. Migrate any cli.mjs references. No behavior change.

#### 1c. Collapse orchestration prompt docs

Current state: `scripts/smike/RUNTIME_ORCHESTRATOR.md` (1,595 words) and `scripts/smike/CODEX_PROFILE.md` (1,144 words) both claim authority over the outer loop. They overlap heavily. The operator model gets instruction competition between them.

Keep one. `RUNTIME_ORCHESTRATOR.md` is the more operational document (actual loop pseudocode, dispatch rules, lifecycle API). Fold the useful parts of `CODEX_PROFILE.md` (entry point list, context-engineering patterns) into it. Delete `CODEX_PROFILE.md`.

Target length for the merged runtime doc: **under 800 words**. If it is longer, it is doing something other than specifying the loop.

Also: `.smike/CODEX.md` (290 lines) should be reviewed for whether it is still needed at all, or whether it can become a 30-line README pointing at the merged runtime doc.

#### 1d. Cut role boilerplate for low-risk phases

Current state: every phase generates capsules for `detailer`, `executor`, `judge`, `reviewer` — 4 roles, 8 files. For read-only research phases (findings-only, no code changes), `reviewer` and often `detailer` add ceremony without catching anything new.

Change the default for `stage: "execution"` phases with `write_scope.allowed_files: []` (read-only):
- `executor` (required)
- `judge` (required)
- `detailer` (opt-in via plan flag)
- `reviewer` (opt-in via plan flag)

Plan flags:
- `require_detailer: true`
- `require_reviewer: true`

Default for read-only execution phases: detailer off, reviewer off.

For `stage: "execution"` with real write scope, keep all four — the reviewer earns its keep when code is actually changing.

Net effect: read-only phases drop from 8 capsules to 2–4 capsules. Roughly half the phases in a typical project are read-only discovery, so this is a significant cut.

#### 1e. Trim the capsule template

Current state: capsules carry generic boilerplate sections (`objectives`, `inputs`, `boundaries`, `outputs`, `evidence`, `anti_patterns`, `next_action`) whether or not the phase needs them. The `03-executor` capsule in the stalled project still listed generic outputs like `EXEC-REPORT.md` when the phase actually required `03-FINDINGS.json` and `03-FINDINGS.md`.

Capsule generation should:
- Read the phase's declared `outputs` from PLAN.json and render those *exactly* in the capsule
- Omit sections that are empty (no `anti_patterns` → no `anti_patterns` block in the capsule)
- Stop including "generic expected outputs" text

Target capsule size: **under 200 words** for read-only, **under 350 words** for execution. The current ~430-word average is mostly boilerplate.

#### 1f. Audit the plan schema surface

Current state: `plan.schema.json` is 454 lines with 31 top-level properties. Pass 1 is supposed to reduce surface area, but leaving obviously dead schema around would preserve a large part of the control-plane bloat.

Pass 1f should:
- Inventory all 31 top-level properties
- Mark each as `read by cli/runtime`, `written only`, or `apparently unused`
- Delete properties that are not read by `cli.mjs`, the runtime loop, or the surviving runtime doc contract
- Defer only the properties that are needed for backward compatibility during the in-flight migration window

Target: finish Pass 1 with a shorter schema and a written audit table showing why each remaining top-level property still exists.

---

### Pass 2 — The One New Invariant

Goal: remove the specific ambiguity where the runtime can stop even though a runtime-owned dispatch is queued and ready. This is the only state-machine *addition* in the whole plan.

#### 2a. Add `awaiting_runtime_dispatch` lifecycle state

Current state: after `./smike cycle` queues a runtime-owned dispatch, `STATE.json.lifecycle.status` is `in_progress` — the same status the project has when local work is mid-flight. The runtime had to read a second dispatch surface separately to know whether it was supposed to act next. When the runtime missed this signal, the project looked "in progress" forever.

Add a new lifecycle state: `awaiting_runtime_dispatch`. Semantics:
- Entered when `./smike cycle` reconciles and finds one or more `ready_dispatches` that the runtime must spawn
- Contains `next_command` (the exact `./smike dispatch …` invocation to run) as a top-level field on `STATE.json.lifecycle`
- Contains `stop_reason: "awaiting_runtime_dispatch"` as a machine-checkable field
- Exited when the runtime calls `./smike dispatch <project> spawned <dispatch_id>` (or on failure, `./smike dispatch <project> failed <dispatch_id>`)

#### 2b. Make the state impossible to ignore

In the runtime doc (the one surviving after Pass 1c): add a single hard rule at the top, before any other instruction:

> If `STATE.json.lifecycle.status == "awaiting_runtime_dispatch"`, you MUST run `STATE.json.lifecycle.next_command` before doing anything else. Exiting without running it is an invariant violation.

Not "should." Not "is recommended." The one hard rule. Every other instruction in the runtime doc should be explicitly optional or context-dependent, so the hard rule stands out.

#### 2c. Detect and report handoff failures bluntly

In `./smike cycle` reconciliation: if the previous cycle ended with `lifecycle.status == "awaiting_runtime_dispatch"` and no `dispatch spawned` call was observed before the next cycle started, emit a loud warning at the top of the cycle output:

```
WARNING: previous cycle queued dispatch <id>, but runtime did not spawn it before this cycle.
This is a runtime handoff failure, not a planning failure. Check RUNTIME_ORCHESTRATOR.md.
```

Record this in `STATE.json.history` with `event: "handoff_failure"`. This gives us a concrete symptom to count across runs and measure whether the invariant is actually working.

#### 2d. Leave old stalled projects alone

This pass does not need to migrate or rescue previously stalled projects.

Compatibility stance:
- Treat the `awaiting_runtime_dispatch` change as additive for newly created projects and newly initialized state.
- Do not make stalled legacy projects a release gate for this simplification.
- If an older project is ever resumed later, handle that as a separate compatibility task or re-bootstrap decision, not as part of Pass 2.
- The validation target for Pass 2 is the repro harness and fresh test projects, not historical cleanup.

---

### Pass 3 — Rebalance (only if Passes 1 + 2 are not enough)

Do not start Pass 3 until at least one real project has completed end-to-end on Pass 1 + Pass 2. The working hypothesis is that those two passes are sufficient. Pass 3 is reserve ammunition, not planned work.

Candidates for Pass 3 (listed, not committed):

- **Collapse `RUNTIME-DELEGATION.json` into `STATE.json`**: completed. The grouped runtime-dispatch view now lives under `STATE.json.orchestration.runtime_dispatch_view`, so the runtime reads one authoritative file per cycle instead of juggling a duplicate projection.
- **Inline small `lib/` modules back into `cli.mjs`**: `planning-review.mjs` is a 5-line stub. `review.mjs` is 92 lines. The 7-module split added test isolation but cost `grep`-ability. Revisit whether the split pays off once the cli surface area has stabilized post-Pass 1.
- **Minimal profile for read-only research**: a separate `./smike cycle --profile read-only` mode that skips detailer + reviewer by default, writes fewer capsules, and uses a shorter runtime doc. Only add this if Pass 1d alone is insufficient.
- **Replace the capsule `.json` files with inline fields on the phase directory's `PLAN.json`**: eliminates the `capsules/` directory entirely. Most capsule content is derivable from the plan — generating a separate artifact is a convenience, not a load-bearing contract.

Each Pass 3 candidate is individually reversible and should ship on its own merits if the evidence from Pass 1 + 2 says it is needed.

---

## What To Delete Today vs. Defer

**Delete today** (no downstream dependencies, safe to ship in Pass 1):
- `*.md` mirrors of machine-read JSON (Pass 1a)
- `AUDIT.*` (keep `AUDITOR.*`) (Pass 1b)
- `CODEX_PROFILE.md` after merging into `RUNTIME_ORCHESTRATOR.md` (Pass 1c)
- Capsule boilerplate sections when they are empty (Pass 1e)
- Unused plan-schema properties proven dead by the Pass 1f audit

**Defer** (need Pass 2 to land first):
- Any change to how the runtime loop reads input files (Pass 3 collapse depends on the new lifecycle state being in place)
- Any `lib/` reorganization (wait for cli.mjs surface to stabilize)
- `PROJECT.json` deletion until consumer grep proves it is not load-bearing

**Do not delete, ever** (these are load-bearing):
- `STATE.json` durable fields: `contract_hash`, `lifecycle`, `workflow.plans[].status`, `orchestration.runtime_dispatches.by_id.*.freshness`
- `depends_on` dependency resolution in cli.mjs
- `write_scope.allowed_files` / `write_scope.blocked_files` enforcement
- Artifact freshness checking (`artifact_change_required`)
- Schema validation on plan.json and state.json
- `SMIKE-NOTES.md` as the human session-end notes log for planning and implementation loops

---

## Test Protocol Before Locking In

The review notes already proposed this. Concretizing it here.

Before merging Pass 1 + 2, run three calibration SMIKE projects back-to-back. Each project is small enough to finish in one or two cycles.

Model matrix:
- Run Tests A / B / C on the Opus posture
- Run Tests A / B / C on the GPT posture (`GPT-5.4` planner / `GPT-5.3 Codex` executor)
- Record any difference in handoff behavior, artifact loading, or stop conditions between the two stacks

### Test A — Read-only research run
- Pick an existing project with a findings-only phase (e.g., a hygiene audit that does not change code)
- Use the Pass 1 + 2 posture (no reviewer by default, collapsed runtime doc, exact capsules, `awaiting_runtime_dispatch` lifecycle)
- Run once on Opus and once on the GPT posture
- **Success criteria**: loop completes with fewer than 5 capsule files per phase, runtime never stops with a queued dispatch, operator can answer "what's next?" by reading `STATE.json` alone on both model stacks

### Test B — Real implementation run
- Pick a small code change (single-file fix, single-phase project)
- Full role set (executor + judge + reviewer + detailer)
- Run once on Opus and once on the GPT posture
- **Success criteria**: durable pieces still fire (contract_hash detects mid-flight plan edits, dependency gate blocks out-of-order phases, write_scope rejects out-of-scope writes), and end-of-session notes are still appended correctly in both planning and implementation loops

### Test C — Intentional handoff failure
- Run a project where the runtime deliberately exits after `./smike cycle` queues a dispatch
- Run once on Opus and once on the GPT posture
- **Success criteria**: next `./smike cycle` loudly reports a handoff failure at the top of its output, `STATE.json.history` records it as `handoff_failure`, and the GPT posture does not silently stop at a queued runtime dispatch after Pass 2 in the repro harness that previously exposed the bug

Post-test qualitative check:
- After Tests A / B / C, write a 3-bullet retrospective on whether the ceremony-to-work ratio improved, whether the runtime handoff feels operationally obvious, and whether the model spent less effort on bookkeeping.

If all three tests feel lighter than the current state AND the durable guarantees still hold, ship Pass 1 + 2. If the metrics improve but the retrospective still says the loop feels heavy, Pass 3 is needed.

---

## Success Criteria (how we know we are done)

The rescue has worked if all of these are true after Pass 1 + 2 ship:

1. Operator can answer "what does SMIKE want me to do right now?" by reading a single file (`STATE.json`) and running a single command (`STATE.json.lifecycle.next_command`).
2. A typical read-only project produces fewer than 20 total files (down from ~97).
3. The merged runtime doc is under 800 words.
4. Capsules average under 300 words and do not contain boilerplate sections that do not apply to the phase.
5. A deliberately induced handoff failure (Test C) surfaces loudly on the next cycle.
6. Durable guarantees are unchanged: `contract_hash` still detects plan drift, `depends_on` still gates phases, `write_scope` still rejects out-of-scope writes, artifact freshness still catches stale "already done" claims.
7. On the GPT posture, Codex no longer stops mid-handoff at a queued runtime dispatch after Pass 2; the repro harness behavior seen on current main is no longer reproducible.
8. The operator retrospective after Tests A / B / C says the loop feels fluid again; if the numbers are better but the experience still feels spiraled, the simplification is not done.

If 1–5 land but 6 degrades, we over-cut and need to restore. If 6 holds but 7–8 fail, the model-specific fragility is still present and Pass 3 or further runtime tightening is warranted.

---

## Non-Goals

Explicitly out of scope for this plan, to keep the blast radius contained:

- Rewriting the capsule system from scratch
- Adding new orchestration roles
- Changing how `./smike` is invoked at the CLI level — the user-facing commands stay the same
- Any schema version bump beyond what Pass 2 requires
- Any planning-review / auditor scoring changes

---

## Open Questions To Resolve During Pass 1

These are specific decision points that need a small answer before Pass 1 is written, not before Pass 1 is planned:

1. **`PROJECT.json` consumer check**: can any runtime or CLI path still require `PROJECT.json`, or can `PROJECT.md` become canonical after Pass 1a lands?
2. **Does any existing consumer read `PLAN-GRAPH.md`, `RUNTIME-DELEGATION.md`, or the phase-local `*-PLAN.md` / `*-FINDINGS.md` mirrors?** `grep` the codebase before deleting, not after.
3. **Capsule-MD deletion safety**: confirm the runtime never falls back to `.md` when `.json` is malformed. If it does, either fix the runtime or keep the `.md` for that one path only.
4. **`awaiting_runtime_dispatch` schema version**: is this a minor schema bump (additive) or a breaking change? Additive is strongly preferred.
5. **Phase-local output canonicalization**: for `FINDINGS`-style outputs, do we want `.json` or `.md` as the canonical artifact when both currently exist?

## Execution Posture

This simplification work should be executed manually, not as a SMIKE project. The thing being changed is the orchestrator itself, so using the full orchestrator loop to rewrite its own control plane would add avoidable feedback-path ambiguity.

Expected sizing:
- Pass 1: about half a day if the mirror/schema grep is clean; up to a day if phase-local output cleanup finds hidden consumers
- Pass 2: about half a day including the handoff invariant and repro-harness validation
- Test matrix and retrospective: about half a day

Rollback / escape hatch:
- Before Pass 1 starts, create a clean revert point tagged `smike-pre-simplification`
- If Pass 2 breaks the repro harness or destabilizes fresh test projects, revert to that tag rather than trying to debug from a half-finished control-plane change

## Provisional Sequencing

Rough order-of-operations for shipping Pass 1 + 2:

1. Create rollback tag `smike-pre-simplification`
2. Dry-run grep sweep for consumers of the `.md` mirrors, including phase-local mirrors (safety check for 1a, 1b, 1c)
3. Pass 1a — strip `.md` mirror generation from `cli.mjs`
4. Pass 1b — collapse AUDIT/AUDITOR
5. Pass 1c — merge runtime docs, delete `CODEX_PROFILE.md`
6. Pass 1e — tighten capsule generation (empty sections omitted, outputs from plan)
7. Pass 1d — add `require_detailer` / `require_reviewer` flags, default both off for read-only
8. Pass 1f — audit and delete dead plan-schema properties
9. Pass 2a — schema + cli.mjs: `awaiting_runtime_dispatch` lifecycle, `next_command`, `stop_reason`
10. Pass 2b — runtime doc: single hard rule at the top
11. Pass 2c — handoff-failure detection + history event
12. Pass 2d — keep legacy stalled projects out of scope for this pass
13. Run Tests A / B / C on Opus and GPT posture, then write the 3-bullet retrospective
14. Commit, observe for one real project cycle, then decide on Pass 3

No single step in this list should be more than a few hundred lines of cli.mjs diff. If any one step sprawls, stop and split it.
