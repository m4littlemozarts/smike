# SMIKE Plan Preflight

Use this when you already have a decently fleshed-out implementation plan and want a fresh session to pressure-test it before handing it to a straight `smike` run.

This is not the runtime contract. It is an operator aid for finding plan-shape problems early.

If the plan will become a SMIKE spec, make sure the final main spec file is self-contained. Supporting docs can be attached as context, but they do not satisfy required headings in the spec parser.

The point is not to pre-do SMIKE's planning work. The point is to catch structural issues that would cause SMIKE to plan badly.

## Guardrails

This preflight should stay lightweight.

It should:

- check whether the plan is shaped well enough for SMIKE to work with
- call out only the highest-signal structural risks
- suggest minimal reshaping when the current plan would clearly cause churn

It should not:

- fully decompose the implementation plan in advance
- invent extra phases just to make the plan look more formal
- replace SMIKE's own planning, orchestration, or review work
- turn a decent plan into a heavyweight planning artifact

## What The Fresh Session Should Do

Have the fresh session review the plan for:

- ambiguity in the user-visible outcome
- unresolved product decisions disguised as implementation work
- bad phase boundaries
- missing or weak dependency edges
- write-scope collisions
- proof gaps
- hidden external blockers
- assumptions that would go stale quickly
- places where SMIKE would likely over-plan, under-plan, or loop

## Failure Modes To Look For

These are the common ways a plan shape causes bad SMIKE behavior.

### 1. Outcome Is Clear To You But Not Explicit In The Plan

Symptom:
- phases read like technical activity instead of user-visible behavior

What goes wrong:
- planning sessions optimize for internals
- acceptance criteria drift
- review becomes stylistic instead of behavioral

Fix:
- state the end-user outcome in one blunt paragraph
- make each phase prove movement toward that outcome

### 2. Product Decisions Are Still Embedded In The Work

Symptom:
- phases contain words like "decide", "explore", "maybe", or "choose" without a bounded decision artifact

What goes wrong:
- downstream phases are planned against unstable assumptions
- recursive planning expands because the system keeps discovering it is not actually ready

Fix:
- isolate open decisions into explicit questions
- either resolve them first or add a dedicated decision phase with clear wake conditions

### 3. Phase Boundaries Are Too Coarse

Symptom:
- one phase owns multiple subsystems, multiple interfaces, or both design and execution

What goes wrong:
- blockers stay hidden until late
- proofs become vague
- retries are expensive because the failed unit is too large

Fix:
- split phases by real dependency boundary, interface boundary, or proof boundary

### 4. Phase Boundaries Are Too Fine

Symptom:
- the plan breaks one coherent change into many tiny serial phases

What goes wrong:
- orchestration overhead dominates
- the plan looks precise but carries no extra safety
- dependency chains become noisy and brittle

Fix:
- merge adjacent phases that touch the same files, share the same proof, and cannot safely progress independently

### 5. Dependency Edges Are Implicit Instead Of Named

Symptom:
- a phase obviously depends on another phase's output, but `depends_on` would not make that legible

What goes wrong:
- SMIKE tries to advance work that is not actually ready
- planning feedback looks like generic blocker churn

Fix:
- name the dependency explicitly
- describe the artifact, decision, or interface that unlocks the next phase

### 6. Parallel Work Shares The Same Write Surface

Symptom:
- multiple phases or roles would touch the same files or tightly coupled interfaces

What goes wrong:
- fake parallelism
- merge pain
- repeated replanning after collisions

Fix:
- either serialize the work or redraw ownership so each phase has a defensible write surface

### 7. Proof Commands Exist But Do Not Prove The Behavior

Symptom:
- verify commands are generic lint/test commands with no phase-specific signal

What goes wrong:
- planning looks complete while acceptance is still underdefined
- execution can "pass" without proving the intended behavior

Fix:
- require at least one proof per phase that would actually fail if that phase's intended behavior were wrong

### 8. External Blockers Are Mixed Into Normal Execution

Symptom:
- the plan assumes credentials, API access, approvals, data, or stakeholder answers will appear during execution

What goes wrong:
- the run stalls in the middle of implementation
- blocked work is mistaken for poor planning quality

Fix:
- mark external blockers explicitly
- state what can proceed without them and what wake condition clears the blocker

### 9. Write Scope Is Too Broad Or Too Vague

Symptom:
- `allowed_files` would need to cover large repo regions because the plan does not localize ownership

What goes wrong:
- less safety
- weaker delegation
- harder review because "expected edits" are unclear

Fix:
- tighten the implementation slice
- split discovery, interface shaping, and code mutation when they do not need the same surface

### 10. Deferrals Are Not Real Deferrals

Symptom:
- out-of-scope concerns are mentioned, but no one could tell whether they are intentionally deferred or accidentally forgotten

What goes wrong:
- fresh sessions reopen old scope
- review feedback expands sideways

Fix:
- list explicit deferrals and protected areas
- say why they are deferred and what would cause them to re-enter scope

## Preflight Output You Want

The fresh session should return:

1. A readiness verdict: `ready`, `ready with reshaping`, or `not ready`
2. The top 3-5 plan-shape risks
3. Minimal changes to phase boundaries, dependencies, proofs, or write scope
4. Any questions that must be answered before a direct `smike` run
5. A smaller replacement outline only if the current plan is structurally unusable

## Suggested Review Prompt

Paste the following into a fresh session along with your plan.

```md
Review this implementation plan as SMIKE preflight, not as a coding task.

Your job is to find problems caused by the shape of the plan before I hand it to a direct SMIKE session.

Do not do SMIKE's job for it. Do not fully decompose the work, invent extra phases unless they are clearly necessary, or expand the plan just to make it more detailed.

Focus on:
- ambiguous user-visible outcomes
- whether the required SMIKE headings live in the main spec file instead of only in attached context docs
- unresolved product decisions hidden inside implementation phases
- bad phase boundaries
- weak or missing dependency edges
- write-scope collisions
- proof gaps
- external blockers
- explicit deferrals that are missing or weak

Do not rewrite the plan for style. Only call out issues that would make SMIKE plan badly, loop, under-specify proofs, or collide on ownership.
Prefer the smallest correction that makes the plan safe to hand to SMIKE.

Return:
1. Readiness verdict: ready / ready with reshaping / not ready
2. Findings ordered by severity
3. Minimal recommended plan-shape changes, including any required heading moves into the main spec file
4. Questions that must be answered before a direct SMIKE run
5. Only if the plan is structurally unusable: a smaller replacement outline with dependency notes and proof notes

Here is the plan:

[paste plan here]
```

## Minimal Operator Checklist

Before you trust the plan, make sure you can answer:

- What user-visible behavior changes when this is done?
- Which phases are blocked by decisions rather than code?
- Which dependency edges are real and named?
- Which phase-specific proof would fail if the behavior were wrong?
- Where would parallel work collide on files or interfaces?
- What is intentionally deferred?
- What external blocker could stall the run?

If two or more answers are fuzzy, the plan should go through preflight before a direct `smike` session.

If the plan already answers these cleanly, skip preflight and let SMIKE do the rest.
