# Recursive Planning Orchestration

> Historical design note. This file captures planning-model exploration, not the live runtime contract. Use `README.md` and `scripts/smike/RUNTIME_ORCHESTRATOR.md` for current operator/runtime behavior.

Date: 2026-04-21
Scope: define a tasteful recursive planning model for SMIKE where the main session keeps shaping intent with the user while bounded side sessions reduce uncertainty through research, pseudocode, option comparison, and proof design.

## Bottom Line

The right pattern is not recursive implementation. It is recursive clarification under a strict parent orchestrator.

The main session should keep owning:
- user interaction
- scope and product decisions
- plan authority
- dispatch authority
- final merge decisions

Side sessions should help during planning, before code exists, by producing advisory artifacts such as:
- API shape research
- pseudocode and interface sketches
- option comparisons
- proof and verification design
- dependency and blocker discovery

Those side sessions should not mutate the canonical plan directly. Their outputs become authoritative only when the main session accepts and merges them.

## Why This Exists

The main opportunity is to use waiting time well.

While the user is still talking through features, tradeoffs, and priorities with the main session, the system can already start reducing technical uncertainty in parallel. That lets the main planning conversation stay fluid without forcing the user to wait for every background question to be answered serially.

This is useful when:
- an external integration has multiple plausible approaches
- the API shape is not yet clear enough to design cleanly
- the same feature breaks into several independent technical questions
- the user is still deciding scope, but some uncertainty can be reduced safely in the background

This is not useful when:
- the real blocker is unresolved product intent
- workers would just restate the same information with different wording
- subagents would start coding against assumptions the user has not approved
- recursion is being used as a substitute for sharper orchestration

## Architectural Position

This plan assumes the current SMIKE direction remains intact:
- keep the durable control plane
- keep explicit lifecycle state
- keep explicit dispatch ownership
- keep freshness and dependency guarantees
- keep write-scope enforcement

This is an expansion of the planning loop, not a retreat from orchestration discipline.

The system should not become "agents all the way down." It should remain:
- one authoritative orchestrator
- a bounded number of parallel child sessions
- explicit ownership and merge points
- explicit invalidation when assumptions change

## Core Principle

Recursion is allowed only where it compresses uncertainty without multiplying authority.

That means:
- recursive planning is valid
- recursive decomposition is sometimes valid
- recursive implementation is dangerous by default
- child-to-child authority transfer is usually invalid

If a deeper session is justified, the parent should normally spawn it after reviewing the need, rather than letting children create open-ended trees of new work.

## Planning Mode

Planning mode should support two tracks running at once.

### Main Track

The main track is the live user conversation. It owns:
- desired behavior
- priorities
- tradeoffs
- exclusions
- acceptance or rejection of proposals
- promotion from planning into executable implementation work

### Shadow Track

The shadow track is made of bounded planning children. It exists to reduce uncertainty in parallel. It may produce:
- external integration notes
- API and schema sketches
- state-machine or flow pseudocode
- alternative implementation options
- proof commands and verification plans
- blocker and dependency discovery

The shadow track is advisory only. It does not rewrite the canonical plan by itself.

## Planning Agent Types

The first version only needs a small set of planning roles.

### `api-research`

Purpose:
- inspect docs, SDKs, auth flows, rate limits, webhook patterns, payload shapes, and likely server/client boundaries

Expected outputs:
- recommended integration shape
- known edge cases
- secrets and env requirements
- proof strategy
- open questions still unresolved

### `pseudocode-detailer`

Purpose:
- turn approved feature ideas into provisional flows, interfaces, data shapes, and state transitions

Expected outputs:
- pseudocode for main flows
- candidate types and contracts
- event boundaries
- failure states
- implementation questions that still need a decision

### `option-scout`

Purpose:
- compare two to four concrete implementation paths

Expected outputs:
- short option matrix
- tradeoffs
- recommended choice
- reasons not to choose the other options

### `proof-designer`

Purpose:
- define how the feature would be proven before code exists

Expected outputs:
- proof commands
- test fixture ideas
- verification checkpoints
- minimal acceptance criteria

### `blocker-mapper`

Purpose:
- identify external blockers, sequencing constraints, and likely collision zones

Expected outputs:
- explicit blocker list
- what can proceed despite blockers
- wake conditions
- dependency graph notes

## Authority Rules

These rules are load-bearing.

### Rule 1: Main Session Owns Authority

Only the main session may:
- mutate the canonical spec
- mutate the canonical plan
- spawn new work by default
- accept or reject planning proposals
- graduate planning into implementation

### Rule 2: Planning Children Produce Proposals

Planning children should write proposal artifacts, not authoritative artifacts.

They can suggest:
- new routes
- API contracts
- schema shapes
- library choices
- verification plans

They cannot silently promote those suggestions into implementation truth.

### Rule 3: Parent Owns State Mutation

Parallel children may work independently, but orchestration state writes must stay serialized in the parent.

### Rule 4: Scope Changes Invalidate Stale Planning

If the main session changes a feature in a way that materially affects a child task, the child output becomes stale unless explicitly rebased.

Examples:
- the auth model changes
- the chosen provider changes
- a screen becomes server-rendered instead of client-rendered
- the user removes a major workflow step

### Rule 5: Recursion Needs a Trigger

Deeper decomposition should happen only when:
- a subproblem clearly separates into independent technical questions
- resolving those questions will materially improve planning quality
- the parent can still keep ownership legible

Recursion should not happen merely because the task is large.

## Recursion Limits

The default recursion posture should be conservative.

Recommended starting rules:
- default depth limit: 2
- common case: main session -> planning children
- exceptional case: main session -> planning child -> one deeper research question, but only with parent approval
- direct child-to-child spawning: off by default
- parallel child count: small unless independence is obvious

This still gives most of the benefit while avoiding uncontrolled session trees.

## Artifact Model

Planning needs a clear split between provisional and authoritative artifacts.

### Canonical Artifacts

These are parent-owned:
- `SPEC.md`: current user-approved scope and behavior
- `DECISIONS.md`: accepted decisions only
- canonical machine planning artifacts already used by SMIKE

### Proposal Artifacts

These are child-owned until merged:
- `RESEARCH/*.md` or `.json`
- `PSEUDOCODE/*.md`
- `OPTIONS/*.md`
- `PROOF/*.md`
- `BLOCKERS/*.json`

Proposal artifacts should include:
- source question
- assumptions used
- relevant plan or spec version
- confidence level
- unresolved questions
- merge recommendation

## Planning Confidence vs Implementation Readiness

Do not collapse these into one status.

A feature may have:
- clear user intent
- partial API knowledge
- useful pseudocode
- no approval to implement

That is healthy. The system should represent that honestly instead of forcing early pseudo-certainty.

Recommended separate dimensions:
- intent clarity
- technical clarity
- proof clarity
- implementation approval

Only the last one should allow code-writing dispatches.

## Merge Model

The parent should periodically reconcile shadow-track work into the main track.

Each planning proposal ends in one of:
- `accepted`
- `accepted_with_edits`
- `rejected`
- `needs_refinement`
- `parked_as_reference`

Merge should be explicit. The system should avoid silent diffusion where child recommendations gradually become assumed truth without a visible decision.

## Invalidation Model

Proposal outputs should carry enough metadata to know when they are stale.

Suggested invalidation inputs:
- spec version or contract hash
- relevant integration choice
- dependency versions when material
- expected UI or route boundaries
- declared assumptions

If those inputs change, the proposal should be marked stale or partial rather than lingering as ambiguous advice.

## Pause and Wake Semantics

Planning children can pause, but only with an explicit blocker contract.

A paused child must declare:
- blocker type
- exact wake condition
- whether useful partial output already exists
- whether the task is safe to abandon
- next legal parent action

Valid blocker types include:
- waiting on user decision
- waiting on provider choice
- waiting on external credentials
- waiting on another proposal artifact
- waiting on a parent merge decision

The parent should be able to see blocked work as a queue of decisions, not as vague "still thinking" status.

## Catalog of Generic Features

A reusable catalog is useful if it stores patterns, not just code snippets.

The catalog should cover recurring work such as:
- Stripe flows
- auth providers
- contact or calendar integrations
- admin dashboards
- email providers
- webhooks
- file uploads
- billing portals

Each catalog entry should include:
- what problem it solves
- leading implementation options
- why you would choose each option
- reasons not to choose them
- likely env and secret requirements
- route and server/client boundary patterns
- data and webhook shapes
- proof commands
- known failure cases
- reference implementations

The catalog should not become a dumping ground for random starter code. If it is mostly code, it will age badly and create false confidence.

## Relationship To Implementation

Planning children should not write production code in this mode.

They may produce:
- pseudocode
- interface drafts
- route sketches
- example payloads
- provisional schema definitions

They should not:
- edit app code
- create migrations
- wire real dependencies
- commit to file changes before implementation approval

Promotion into implementation should require an explicit transition by the main session once intent, technical shape, and proof plan are good enough.

## Lifecycle Sketch

One plausible lifecycle extension is:

1. `planning_live`
   The main session is actively working with the user.
2. `planning_parallel_research`
   One or more shadow-track agents are gathering bounded findings.
3. `planning_merge`
   Parent is reviewing and merging accepted proposals.
4. `planning_blocked`
   The only remaining work depends on a user or external decision.
5. `planning_ready_for_implementation`
   Intent, technical shape, and proof plan are sufficient to open code-writing dispatches.

This does not need to be implemented as exact lifecycle names immediately, but the distinctions matter.

## Dispatch Contract For Planning Children

Every planning child should get a narrow contract:
- the question it is answering
- the current relevant spec slice
- the relevant plan or feature version
- allowed output artifacts
- explicit non-goals
- whether external research is allowed
- timeout or completion expectation

The child should be told:
- do not mutate canonical planning artifacts
- do not write code
- treat your output as provisional unless merged
- report assumptions explicitly
- list unresolved questions clearly

## Good Triggers For Planning Recursion

Use planning recursion when:
- an external integration has unclear auth or webhook boundaries
- several implementation paths are plausible and materially different
- one feature decomposes into independent technical investigations
- proof strategy is unclear and likely to shape the design
- a complex workflow needs pseudocode before implementation planning will be credible

## Bad Triggers For Planning Recursion

Do not recurse when:
- the user has not yet decided what they want
- the work is simple enough for the parent to reason about directly
- a child would just rephrase existing context
- more sessions would create coordination overhead with no real information gain
- the system is using extra agents as a substitute for clearer thinking

## Major Failure Modes

This model is attractive, but it has obvious failure modes.

### 1. Proposal Drift

Children keep producing artifacts against stale assumptions while the main session keeps evolving the feature.

Mitigation:
- version proposals
- mark assumptions explicitly
- invalidate on meaningful spec changes

### 2. False Authority

Provisional pseudocode starts being treated as a committed contract.

Mitigation:
- separate proposal artifacts from canonical artifacts
- require explicit merge state

### 3. Session Proliferation

The system starts too many side sessions and loses coordination quality.

Mitigation:
- limit concurrency
- require a concrete question for each spawn
- keep parent-controlled recursion

### 4. Endless Improvement Loops

Research agents keep polishing options and pseudocode without a stop condition.

Mitigation:
- require exit criteria
- require bounded deliverables
- force parent merge or rejection

### 5. Premature Coding Pressure

Research outputs are used to justify implementation before the user has approved scope.

Mitigation:
- separate implementation approval from planning confidence
- require explicit graduation to code-writing work

## Recommended First Implementation Slice

The first real version should stay small.

### Phase 1

Add a planning-only dispatch profile that supports:
- `api-research`
- `pseudocode-detailer`
- `option-scout`
- `proof-designer`

### Phase 2

Add proposal artifacts with:
- version metadata
- assumptions
- merge state
- staleness detection

### Phase 3

Add a parent merge step that can:
- accept
- reject
- request refinement
- park as reference

### Phase 4

Add a small catalog format for recurring integration patterns.

### Phase 5

Only after the above works well, consider limited deeper recursion.

## What Not To Do

Avoid these temptations:
- do not let every child spawn more children by default
- do not let planning children write production code
- do not treat all pseudocode as implementation-ready
- do not invent a giant role taxonomy before the basic loop proves useful
- do not let generic feature catalogs become a second stale codebase
- do not merge proposal artifacts automatically just because they look plausible

## Open Questions

These still need design work before implementation:
- what exact artifact paths and naming should proposal outputs use
- whether proposal artifacts should be Markdown, JSON, or paired surfaces
- how proposal staleness should be computed in the current state model
- whether catalog entries belong in the framework repo or host repos
- how much external research should be allowed during planning-only dispatches
- what the best operator surface is for seeing active planning questions
- whether planning merge belongs inside `advance`, `cycle`, or a separate command

## Success Criteria

This planning model is working if:
- the user can keep shaping the feature in the main session while technical uncertainty falls in parallel
- planning children reduce uncertainty without stealing authority
- the system can tell the difference between advisory artifacts and approved plan truth
- recursion stays bounded and legible
- stale research gets invalidated instead of silently contaminating the plan
- planning exits with better implementation readiness, not just more documents
