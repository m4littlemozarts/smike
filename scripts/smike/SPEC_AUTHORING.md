# SMIKE Spec Authoring — Quick Reference

A spec handed to `./smike <spec.md> [context.md ...]` is parsed by `cli.mjs` → `buildPlanningBundle` (heading-exact). This guide lists every input the parser reads so your spec ingests cleanly on the first pass.

If a spec is good, `./smike` produces a complete planning bundle (`PLAN.json`, `ROADMAP.md`, `STRATEGY.md`, phase plans, checker + auditor, runtime delegation) with lint `result: pass`. If a spec is weak, you either get lint findings or — worse — a silent fallback to a single generic phase.

---

## Two modes

SMIKE decides between `implementation` and `research` mode from spec text (`inferPlanningMode`, cli.mjs ~L3523).

**`research` mode** is auto-detected when the spec lowercases-contains any of:
- `read-only smike research loop`
- `advice-only smike run` / `advisory smike run` / `advice-only` / `advisory only`
- `architecture audit` / `read-only audit` / `audit-only`
- `must not make implementation changes`
- `must not change repo code`
- `quality of planning`

If none of those phrases appear, mode falls back to `implementation`.

Otherwise identical section grammar — `research` mode changes what the framework *does* with the parsed bundle, not how it parses. See the Review / Research section below.

---

## Front matter (optional but recommended)

A blockquote block at the top whose first line is `> Primary refs:` followed by `> - path` bullets is harvested into `primary_refs` (on top of any `## What The Planner Must Read First` section). Example:

```markdown
> **SMIKE spec.**
> Canonical project slug: `my-project`
> Primary refs:
> - path/to/truth.md
> - packages/worker/src/routes/foo.ts
```

---

## Required sections (lint hard rules)

Missing any of these triggers `buildPlanningLintFindings` (cli.mjs ~L3970):

| Heading (exact) | Severity if missing | Purpose |
|---|---|---|
| `## Objective` | medium | one-paragraph outcome the planner uses as the root objective |
| `## Required Deliverable From This Loop` **or** `## Planner Must Produce` | medium | bulleted outputs the checker audits against |
| Legacy aliases accepted: `## Main Deliverable`, `## Required Deliverables From Planning`, `## Required Deliverables From Execution` | note | these now feed the same deliverable extraction path |
| `## Required Planning Output Shape` **or** `## Priority N:` headings | **high** | phase decomposition — without this SMIKE silently collapses to one generic phase |
| Legacy planning-shape hint accepted: `## Recommended First Executable Phase` | note | can seed a fallback executable phase, but it does **not** satisfy the required planning-shape lint on its own |

---

## Parsed optional sections

Each is extracted as a list and forwarded into the planning bundle:

| Heading (exact) | Destination | Notes |
|---|---|---|
| `## What The Planner Must Read First` | `primary_refs` | numbered list of repo paths |
| `## Critical Constraints` | `constraints` | strategist reads these into `STRATEGY.md` |
| `## Explicit Non-Goals` | `non_goals` | the checker uses these to flag scope drift |
| `## Scope Out` | `non_goals` | accepted legacy alias |
| `## Protected / High-Collision Areas` | `protected_areas` | narrows inferred write scope; auto-enables full planning analysis |
| `## Known Current Drift Seeds` | `drift_seeds` | investigation hints (especially useful in research mode) |

Leave sections out when genuinely empty — empty sections still pass lint but add noise.

---

## Phase blueprint line syntax

Inside `## Required Planning Output Shape`, each phase is one line (`parsePhaseBlueprintLine`, cli.mjs ~L3920):

```
- Plan NN: Title (directive1; directive2; ...)
```

`NN` must be a zero-padded integer. Directives are semicolon-separated `key:value` pairs inside a single set of parentheses. All optional.

| Directive | Type | Effect |
|---|---|---|
| `depends` | comma list of `NN` | explicit DAG edges. Omit → auto-chain to prior phase. Empty → runnable in parallel with siblings |
| `category` | keyword | drives inferred write scope and risk analysis |
| `write_scope` (alias `scope`) | comma list of globs | overrides category-inferred scope |
| `verify` | pipe-separated command ids | verify command ids referenced in phase acceptance |

**Categories** recognized by `categoryWriteScopeGlobs` (cli.mjs ~L3612):
`permissions`, `route-architecture`, `doc-drift`, `dead-code`, `verification`, `ui-component`, `migration`, `general`.

`permissions`, `verification`, `migration` are treated as high-risk and force checker + auditor even on small bundles.

Fallback: if neither blueprint lines nor `Priority N:` headings exist, SMIKE emits a single generic `Implementation` phase. This is almost never what you want — include at least two blueprint lines so the planner actually decomposes the work.

---

## Review / Research mode

Use this when you want SMIKE to **investigate and produce findings + a recommended follow-on plan**, not change code. Typical use cases: security audits, architecture reviews, cleanup-program planning, backlog reconciliation, spec-before-spec meta runs.

### How to trigger it

Include any of the trigger phrases from the "Two modes" section above. The clearest: put

> `This is a read-only SMIKE research loop.`

early in the spec (an `## Meta Intent` or `## Research Loop Mode` section is a clean home for it). Without a trigger phrase, SMIKE will plan *implementation* even if your deliverable is a report — and the phases will then try to write code.

### What the framework does in research mode

- **Write scope clamped** to `.smike/<project>/**` for every phase. Phases cannot touch repo code no matter what `write_scope` says (`inferPhaseWriteScope`, cli.mjs ~L3685).
- **Findings template auto-written** for each phase at `.smike/<project>/phases/<NN>/<NN>-FINDINGS.json` (`buildResearchFindingsTemplate`, cli.mjs ~L1295). Shape:
  ```json
  {
    "schema_version": "1.0.0",
    "project": "...",
    "phase": "01",
    "title": "...",
    "status": "todo",
    "summary": "",
    "findings": [],
    "next_action": ""
  }
  ```
  `findings[]` is an open array — if you want a specific shape per finding (severity, category, file refs, confidence), dictate it explicitly in `## Required Deliverable From This Loop` so the executor fills it correctly.
- **Default verify** becomes `research-artifacts-ready` (just confirms the findings file exists). If you want real evidence gates, add explicit verify commands via blueprint `verify:` directives — e.g. a script that greps the findings file for non-empty `summary` and a minimum finding count.
- **Reviewer auto-required** per phase when the phase category or title matches `auth|permission|security|ownership|schema|migration|verification|guardrail|destructive|billing` (`researchPhaseNeedsReviewer`, cli.mjs ~L3577). Match these keywords in phase titles to opt in.
- **Full planning analysis forced on** — `checker` and `auditor` always enabled in research mode because `broadOrComplex = true` (cli.mjs ~L3557). You get a full planning review of the bundle itself before phases even start.

### Recommended sections for review/research specs

On top of the required sections, add:

- `## Meta Intent` — one paragraph stating this is a read-only loop producing findings, not code changes. Include a trigger phrase here.
- `## Research Output Priority` — which deliverable wins when quality of evidence and breadth of plan conflict.
- `## Evidence Standard` — minimum bar for promoting an item into the recommended follow-on plan (e.g. "live code evidence OR confirmed doc/code contradiction"). Prevents hallucinated findings.
- `## Finding Confidence` — confidence labels (`high` / `medium` / `low`) and rule for which labels can drive the next loop.
- `## Planner Must Produce` — explicit schema for the findings and the recommended follow-on plan (so the executor produces a usable artifact, not a wall of prose).

### Blueprint shape for a review project

Review projects typically decompose as:

```
- Plan 01: Truth snapshot / reconciliation (category:doc-drift; verify:research-artifacts)
- Plan 02: Targeted investigation A (depends:01; category:permissions; verify:research-artifacts)
- Plan 03: Targeted investigation B (depends:01; category:dead-code; verify:research-artifacts)
- Plan 04: Findings consolidation + proposed follow-on plan (depends:02,03; category:general; verify:research-artifacts)
```

The point is: one grounding phase, a few parallel investigations, one synthesis phase that produces the actual recommended plan.

### Exemplar

`/Users/bigsmike/smike-framework/docs/spec-codebase-unification-cleanup.md` is a long, production-grade research spec. Skim its top-level headings and `## Priority N:` sections for a feel of review-mode prose.

---

## Pre-flight smell test

Before running `./smike <spec.md>`, answer each:

1. Can a cold agent tell if this is implementation or review mode in the first 10 lines?
2. Would *every* item under `Required Deliverable` fail a checker audit if missing, or are some aspirational? Trim the aspirational ones.
3. Does each `Plan NN:` line have a `category` or a `write_scope`? Without one, the planner falls back to generic globs.
4. Are `depends:` edges correct, or are you relying on auto-chain when phases are actually parallelizable?
5. Are protected/high-collision areas real (active in-flight work, dirty-worktree risk) or just vague caution? Vague caution makes the strategist too conservative.
6. For review mode: is your finding schema dictated, or will you get back unstructured prose?

If any answer is "not really," fix the spec. Bad specs either lint-fail fast or — worse — lint-pass and silently produce a weak plan.

---

## Minimum viable spec — implementation

```markdown
# <Title>

> **SMIKE spec.**
> Primary refs:
> - path/to/truth.md
> - packages/worker/src/routes/foo.ts

## Objective
<one paragraph outcome>

## What The Planner Must Read First
1. path/to/truth.md
2. packages/worker/src/routes/foo.ts

## Critical Constraints
- <constraint>

## Explicit Non-Goals
- <non-goal>

## Required Deliverable From This Loop
1. <concrete output>

## Required Planning Output Shape
- Plan 01: First slice (category:worker; write_scope:packages/worker/**; verify:unit-tests)
- Plan 02: Second slice (depends:01; category:ui-component; write_scope:packages/dashboard/**; verify:typecheck)
```

## Minimum viable spec — review / research

```markdown
# <Title>

> **SMIKE spec.**
> Primary refs:
> - path/to/truth.md

## Objective
Produce a findings report and a recommended follow-on plan for <area>.

## Meta Intent
This is a read-only SMIKE research loop. The loop must not make implementation changes. Optimize for quality of planning and evidence.

## What The Planner Must Read First
1. path/to/truth.md

## Evidence Standard
Do not promote an item into the recommended follow-on plan unless it is backed by live code evidence, a verified doc/code contradiction, or a repeated pattern.

## Finding Confidence
Each finding must carry `high` | `medium` | `low`. Only `high` and strong `medium` drive the proposed follow-on plan.

## Required Deliverable From This Loop
1. `<NN>-FINDINGS.json` per investigation phase with items shaped `{ id, title, severity, category, confidence, evidence[], recommended_action }`.
2. A consolidated recommended follow-on plan in the synthesis phase.

## Required Planning Output Shape
- Plan 01: Truth snapshot (category:doc-drift; verify:research-artifacts)
- Plan 02: Investigation A (depends:01; category:permissions; verify:research-artifacts)
- Plan 03: Investigation B (depends:01; category:dead-code; verify:research-artifacts)
- Plan 04: Synthesis and recommended plan (depends:02,03; category:general; verify:research-artifacts)
```

---

## Authoritative source

`scripts/smike/cli.mjs` is the contract. Key functions:

- `buildPlanningBundle` (~L4071) — top-level spec → bundle
- `buildPlanningLintFindings` (~L3970) — the three hard requirements
- `parsePhaseBlueprintLine` (~L3920) — blueprint line regex + directives
- `inferPlanningMode` (~L3523) — research mode trigger phrases
- `inferPhaseWriteScope` (~L3633) — category → glob mapping + research clamp
- `buildResearchFindingsTemplate` (~L1295) — findings file shape
- `researchPhaseNeedsReviewer` (~L3577) — auto-reviewer keyword list
- `extractPrimaryRefs` (~L3494) — front-matter parser

Schemas:
- `schemas/plan.schema.json` — final plan shape
- `templates/codex/PLAN.md` — reader-facing plan template

When behavior surprises you, grep `cli.mjs` — it is authoritative; this document is its mirror.
