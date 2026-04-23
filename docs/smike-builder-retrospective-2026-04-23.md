# SMIKE Builder Retrospective — 2026-04-23

> Historical design note. This file captures operator friction and framework follow-up ideas from the `spec-smike-runtime-acceptance` run, not the live runtime contract. Use `README.md` and `scripts/smike/RUNTIME_ORCHESTRATOR.md` for current operator/runtime behavior.

## Why This Exists

The acceptance run completed, but the path there felt heavier than the size of the work. This note captures where the framework imposed friction during a real docs-only implementation loop, what to change if the goal is to make SMIKE good at building now, and what role the current docs set is actually serving.

## What Felt Rough

### 1. The operator has to understand too much of the control plane

The documented loop expects the operator to know when to use `advance`, `cycle`, `recheck`, `doctor`, and `dispatch`, and to understand the lifecycle meaning behind each one. That is defensible for the framework author, but it is too much surface for straightforward implementation work.

Evidence:

- `README.md` presents `./smike` as the universal entrypoint, but the live operator loop still requires several specialist commands.
- `scripts/smike/RUNTIME_ORCHESTRATOR.md` documents a real state machine with explicit branch logic for `awaiting_runtime_dispatch`, `in_progress`, `awaiting_fresh_session`, retry, respawn, and reconciliation.

Consequence:

- SMIKE feels like a workflow engine that you operate manually, not a thin build loop that mostly gets out of the way.

### 2. Small contract edits can kick the run back into orchestration churn

During the acceptance run, tightening plan verification or improving phase scope text pushed detailer dispatches back into stale/respawn/retry paths. That preserved correctness, but the work felt administrative.

What this means:

- The framework currently treats many contract refinements as lifecycle events that must be replayed through the runtime machinery.
- That behavior is coherent for auditability, but it is a bad fit for normal implementation momentum.

### 3. Spec authoring is still too parser-shaped

The spec format is powerful, but it is fragile. Exact headings, exact phase blueprint syntax, exact trigger phrases, and exact `verify:` formatting all matter. The authoring guide is clear about this, but the required precision is still high for a system that is supposed to accelerate work.

Consequence:

- Too much effort is spent making the spec legible to the parser instead of making the task legible to the implementer.
- Broken or weak `verify:` commands are discovered late, after planning has already created runtime work from them.

### 4. Verification quality problems surface later than they should

The acceptance run revealed that a phase can make it all the way into execution even when its verify surface is weak or malformed. The framework eventually caught this, but only after an execution/judge/reviewer/fixer pass had already started.

The real issue is not that SMIKE verifies too much. It is that some verification quality checks happen too late.

### 5. Terminal state and actionable dispatch state can still feel inconsistent

The final run ended with `status: complete`, but `STATE.md` still showed a queued actionable dispatch. `doctor` passed, so the runtime considered the project healthy, but the operator handoff surface still looked like there was pending work.

Consequence:

- The state machine may be internally valid, but the human-facing semantics are muddy.
- A terminal project should not make the operator ask whether a queued dispatch is real or ignorable.

### 6. The docs set is overloaded

Right now the docs directory mixes:

- live operator/runtime contract docs
- spec authoring reference
- historical design notes
- review notes
- generated acceptance artifacts
- diagnostic workflow feedback

That makes the framework feel more complex than it needs to, because the repo does not clearly separate "what to obey now" from "what we learned while redesigning this."

## What To Improve If The Goal Is Building Now

### Priority 1: Add a real fast lane

The framework needs a thin implementation path where the common case is:

1. start or select project
2. run the next legal step
3. let SMIKE absorb internal orchestration details
4. stop only for real blockers

Practical implication:

- `./smike` or `./smike run` should be the only normal mutating command.
- `cycle`, `recheck`, and raw `dispatch` should become explicit recovery/debug surfaces, not steady-state workflow commands.

### Priority 2: Auto-complete runtime bookkeeping where safe

If a spawned child finishes and the framework can prove the required artifacts changed and verified, the framework should record completion automatically. Manual `dispatch completed` should be for recovery or ambiguous cases, not the happy path.

### Priority 3: Move verification-quality checks earlier

Weak `verify:` commands, malformed shell fragments, and acceptance criteria that only assert `exit=0` should be blocked during planning promotion, not discovered after execution starts.

Concrete direction:

- lint `verify:` commands for parseability and target file existence during planning
- reject obviously split or partial shell commands
- warn when ACs rely only on exit codes with no content signal

### Priority 4: Make implementation mode lighter than research mode

Right now implementation runs still inherit a lot of the machinery that makes sense for audit and research loops. For actual build work, the framework should bias toward:

- fewer roles by default
- fewer generated artifacts
- fewer state transitions visible to the operator
- fewer chances for contract-only drift to reopen the loop

### Priority 5: Tighten terminal-state invariants

If `status == complete`, the operator surface should also satisfy:

- no queued actionable dispatch
- no ready dispatch group
- no ambiguous `next step`

If the runtime needs to keep history around, it should do that without presenting it as pending operator work.

### Priority 6: Stop making specs feel like source code

Long term, the current markdown grammar should probably be replaced or supplemented with a structured manifest or generated front matter block. The model can still draft the human-readable spec, but the machine contract should be less sensitive to exact heading names and inline punctuation.

## What The Current Docs Are For

### Live authority

- `README.md`: high-level framework/operator summary
- `scripts/smike/RUNTIME_ORCHESTRATOR.md`: live runtime/operator contract
- `scripts/smike/SPEC_AUTHORING.md`: live spec grammar and planning contract

### Generated operator aids

- `docs/smike-runtime-acceptance-runbook.md`
- `docs/smike-runtime-recovery-matrix.md`
- `docs/smike-runtime-final-checklist.md`

These are acceptance artifacts: operator-facing proof that the current contract can be exercised coherently.

### Historical design and review notes

- `docs/plan-smike-simplification.md`
- `docs/plan-recursive-planning-orchestration.md`
- `docs/plan-schema-surface-audit-2026-04-23.md`
- `docs/smike-upgrade-review-notes-2026-04-18.md`
- similar `plan-*` and review files

These are not runtime authority. They are framework memory.

### Diagnostic run feedback

- `docs/smike-feedback.md`

This is a diagnostic target for friction observed during actual SMIKE runs. Keep
it small; promote durable lessons into coherent design, runtime, or operator
docs instead of preserving generated project history.

## Recommended Docs Taxonomy

To reduce confusion, split the docs surface by role:

- `docs/reference/` for live authoritative docs
- `docs/guides/` for operator guides and acceptance runbooks
- `docs/design/` for historical plans, redesign notes, and retrospectives
- `docs/acceptance/` for generated acceptance packages
- `docs/feedback/` for temporary workflow feedback triage notes

The important product rule is simple:

- one place to learn the live runtime contract
- one place to learn how to run it
- one place to read historical design thinking

## Bottom Line

SMIKE is currently stronger at preserving workflow correctness than preserving implementation momentum.

That is not a reason to throw away the state machine. It is a reason to collapse the public surface around it:

- one normal mutating command
- earlier validation of weak plans
- fewer visible lifecycle hops
- cleaner terminal-state semantics
- a docs taxonomy that separates live contract from framework memory

If the framework does not get a fast lane for normal build work, it will keep feeling heavier than the problems it is supposed to help solve.
