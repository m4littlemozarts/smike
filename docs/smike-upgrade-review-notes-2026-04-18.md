# SMIKE Upgrade Review Notes

Date: 2026-04-18
Context: second-pass review of the current SMIKE runtime/state-machine design after `spec-codebase-unification-cleanup` stopped at the runtime handoff boundary.

## Bottom Line

The current SMIKE stack still has real value, but it has drifted away from the original reason it felt good to use.

The useful part is the control plane:
- resumability
- explicit dependency ordering
- freshness checks on result artifacts
- auditable handoff state

The part that has become bloated is the operational surface around that control plane:
- too many artifacts to hold in working memory
- too much prompt text spread across runtime docs, state files, capsules, and plan files
- too much ambiguity about which layer is supposed to act next
- too much bookkeeping pressure on the model compared with the amount of real decision-making help it gets back

The result is a framework that is strong on truth and auditability, but weak on fluidity and momentum.

## What Actually Happened

The stop in `spec-codebase-unification-cleanup` does not look like a product blocker or a mysterious hard runtime timeout.

What happened:
- phase 02 completed successfully
- phase 03 was correctly identified as the next actionable runtime-owned dispatch
- the state machine queued `03-executor`
- the next command became `./smike dispatch spec-codebase-unification-cleanup spawned 03-executor`
- the outer runtime did not perform that handoff and continue the loop

So the stop appears to have been an orchestration-boundary failure, not a planning failure.

The strict freshness behavior was correct:
- `03-FINDINGS.md` and `03-FINDINGS.json` already existed from April 17, 2026 at 5:47:48 PM PDT
- the current `03-executor` dispatch was created later, on April 17, 2026 at 8:53:50 PM PDT
- `artifact_change_required=true` means older artifacts should not auto-count for the new dispatch

So the bug was not the strictness. The bug was stopping with a ready queued runtime dispatch still waiting to be spawned.

## Why This Feels Worse Than The Earlier Thin Version

The older thin agent-only orchestration worked because the model had one clear job:
- understand the current step
- do the step
- move to the next step

The current stack asks the model to juggle more layers at once:
- a canonical state machine
- a separate runtime ownership model
- multiple derived status artifacts
- capsules that are supposed to be narrow but still point back to many other artifacts
- lifecycle transitions that require explicit dispatch bookkeeping

That added machinery only pays off if it removes ambiguity.

Right now it often does the opposite. It creates a new class of ambiguity:
- is `./smike` done, or is it just done reconciling?
- is the runtime supposed to act, or is the local runner supposed to act?
- is an existing artifact valid evidence, or stale relative to the current dispatch?
- which file is the real contract for the next action?

This is the main reason the system now feels heavy without obviously feeling smarter.

## What Still Seems Worth Keeping

These parts look like real upgrades over a purely conversational loop:

- `STATE.json` / `STATE.md` as the durable project position
- explicit plan graph and dependency ordering
- dispatch freshness checks for artifact-producing phases
- narrow write scopes and declared result artifacts
- the idea that subagents should run from compact contracts instead of full-thread memory

Those are the pieces that actually improve correctness and resumability.

## What Looks Like Pure or Near-Pure Overhead

These areas currently look like they add more cognitive cost than value:

- multiple overlapping handoff surfaces that say almost the same thing
- long runtime-orchestrator instructions plus long child capsules plus plan docs
- role proliferation for low-risk read-only work
- generic capsule template text that does not fully match the actual required outputs
- lifecycle states that under-describe the real situation

One concrete example:
- phase 03 required `03-FINDINGS.json` and `03-FINDINGS.md`
- the `03-executor` capsule still described generic expected outputs like `EXEC-REPORT.md` and "code changes inside write scope"

That kind of mismatch is small on its own, but across a whole loop it trains the model to treat the system as fuzzy ceremony rather than a sharp contract.

## Prompt Density Concern

The prompt surface is likely too dense.

Measured during review:
- `scripts/smike/RUNTIME_ORCHESTRATOR.md`: about 1,595 words
- `scripts/smike/CODEX_PROFILE.md`: about 1,144 words
- `03-executor-capsule.md`: about 479 words
- `03-PLAN.md`: about 438 words
- the referenced spec and supporting state/project artifacts add several thousand more words if actually loaded

That is not necessarily fatal, but it is enough to create instruction competition.

The likely failure mode is not "the model is dumb." The likely failure mode is:
- too many documents are acting like control-plane authority at once
- the model can follow local instructions but miss the cross-document invariant
- the runtime handoff boundary is conceptually obvious to us, but not operationally unavoidable to the model

This is especially dangerous on GPT-family models when the workflow depends on strict outer-runtime continuation rather than a single, direct "keep going until blocked" action loop.

## Working Hypothesis About Model Behavior

The issue does not look like a hidden hard-stop program that simply kills long-running work.

The more plausible explanation is:
- `./smike` completed a reconciliation step successfully
- the state machine emitted the correct next action
- the outer runtime failed to treat "ready queued runtime dispatch" as a must-act condition
- because the control plane is spread across several files and prompts, the model treated the state write as a reasonable stopping point

In other words, the system currently depends too much on obedient interpretation and not enough on hard invariants.

## The Real Point Of The State Machine

The state machine should exist to do four things:

1. Persist position.
2. Enforce ordering.
3. Verify artifacts honestly.
4. Make resumes reliable.

It should not be trying to become the main source of semantic intelligence.
It should not force every agent to repeatedly ingest a large amount of orchestration prose.
It should not make the operator wonder which layer actually owns momentum.

If it is doing more than those four jobs, it is probably growing into the wrong shape.

## Direction For A Coherent Upgrade Review

This is not a full plan yet, but the review should probably push toward these principles:

### 1. Re-thin the orchestrator layer

Keep the runtime loop brutally simple:
- start or resume
- inspect canonical state
- if a runtime-owned dispatch is ready, spawn it
- if local-only work is ready, do it
- reconcile
- repeat until genuinely blocked

Anything that does not help that loop should be questioned.

### 2. Make "ready runtime dispatch" impossible to ignore

The framework should not stop in a generic `in_progress` state when the true state is:
- work is ready
- runtime owns the next action
- stopping now is premature

Likely change:
- add a lifecycle such as `awaiting_runtime_dispatch`
- add an explicit `stop_reason`
- treat exiting with ready queued runtime work as an invariant violation unless the runtime intentionally reports a handoff failure

### 3. Reduce prompt overlap

Each layer should have one job:
- plan contract: scope and outputs
- state: current position and next required action
- capsule: compact worker brief
- runtime prompt: host loop only

If the same instruction has to appear in all four places, that is a smell.

### 4. Cut role count for low-risk research

For read-only research and doc-truth reconciliation, default to:
- executor
- judge

Make reviewer opt-in by risk, contradiction density, or novelty.

### 5. Make capsules exact, not generic

Capsules should list:
- exact output files
- exact scope
- exact verification hooks
- exact blocker condition

No leftover generic text about code changes when the task is findings-only.

### 6. Keep the state machine as bookkeeping, not narration

The machine should track:
- what is ready
- what is blocked
- what changed
- what passed
- what failed

It should not need to explain the whole philosophy of the workflow every cycle.

## Initial Simplification Tests Worth Running

Before designing a larger rewrite, it would be useful to test a much thinner posture:

1. One small read-only SMIKE run with:
- no reviewer by default
- one canonical runtime prompt
- one compact capsule
- explicit `awaiting_runtime_dispatch` state

2. One implementation run where the only added machinery beyond the old thin loop is:
- durable state
- artifact freshness
- plan dependency graph

3. One failure-mode harness where the runtime intentionally stops after queuing a dispatch, to verify the system reports a handoff failure bluntly instead of silently looking "in progress"

If those thin tests feel better, that is strong evidence that the current complexity is not pulling its weight.

## Current Judgment

The framework has not become pointless, but it has drifted out of proportion.

The state machine itself is not the mistake.
The mistake is allowing the state machine and its surrounding artifact layer to become a conceptual burden instead of a support layer.

The likely recovery path is not "throw it all away."
The likely recovery path is:
- keep the durable control-plane pieces that actually improve truth and resumes
- aggressively delete or compress the parts that duplicate instructions, blur ownership, or slow momentum

## Open Questions For Cross-Session Review

- Which artifacts are truly canonical, and which are just convenience views that could be removed?
- Can the runtime operate correctly from only `ACTIVE.json`, `STATE.json`, and the current plan contract?
- Do capsules need dependency backreferences as often as they currently include them?
- Should low-risk research have a separate minimal profile instead of inheriting the heavier full workflow?
- Are GPT-family models more sensitive than Claude to distributed control-plane instructions, making thinner orchestration more important here?
- Which parts of the old thin SMIKE flow felt best in practice and should be treated as non-regression requirements?

## Provisional Recommendation

Treat this as an upgrade review and simplification pass, not as a feature-extension pass.

Goal:
- recover the original thin, fluid, agent-first feel
- keep only the minimum durable machinery that clearly improves correctness, resumability, and scope control

Anything that does not clearly serve that goal should be a deletion candidate.
