# SMIKE Spec Prep Brief

Use this when another session needs to prepare a SMIKE-ready spec file without reading the full parser reference.

This is the short contract, not the exhaustive one. For edge cases and full grammar, see `scripts/smike/SPEC_AUTHORING.md`.

`./smike <spec.md> [context.md ...]` auto-runs a framework-owned spec-prep pass before normal planning promotion. The user should still be able to just run `./smike`; the prep pass normalizes the main spec into parser-safe shape by managing a `SMIKE:CONTRACT` block in the first file when needed. Context files still remain refs only.

Use this brief when a normal planning session needs to prepare work for SMIKE without running the SMIKE loop itself.

## What SMIKE Actually Does

SMIKE planning does **not** merge multiple markdown files into one spec.

- `./smike <spec.md> [context.md ...]` parses only the first file as the spec body.
- The spec-prep pass may add or refresh a managed parser-facing contract block in that first file.
- Later files are context refs only.
- Context files can help the planner understand the repo.
- Context files do **not** satisfy required headings in the main spec.
- `planning_draft` is rebuilt from the spec. Fix the spec file, not generated `.smike/**` artifacts.

## What Must Be In The Main Spec File

Put these in `spec.md` itself:

- `## Objective`
- `## Required Deliverable From This Loop` or `## Planner Must Produce`
- `## Required Planning Output Shape` or matching `## Priority N:` sections
- repo truth sources under `## What The Planner Must Read First`
- concrete `- Plan NN:` lines once the implementation surface is known
- matching `## Priority N:` summaries for every phase
- explicit `depends:` edges where phases can run in parallel or must wait for non-adjacent work
- `category:` or `write_scope:` on every phase
- at least one phase-specific `verify:` command per code-bearing phase when the surface is concrete

If those sections live only in attached context docs, SMIKE will still stop in `planning_draft`.

## What SMIKE Can Infer On Its Own

SMIKE can already infer some structure during planning:

- planning mode from trigger phrases in the main spec
- repo refs from the main spec plus attached context files
- default phase dependency chaining when `depends:` is omitted
- write scope from phase category and referenced files
- fallback proof commands that prove only spec readiness

SMIKE does **not** currently infer the core planning contract from context docs. It expects the main spec file to carry the load-bearing headings. Fallback phases and fallback proof commands are enough to create a draft, but they are not enough for a strong promotion.

## Minimal Prompt To Hand Another Session

```markdown
Turn this request into a single self-contained SMIKE spec file.

Important:
- SMIKE parses only the first file as the spec.
- Attached context docs are refs only and do not satisfy required sections.
- Put all required planning sections in the main spec file itself.
- SMIKE may add a managed contract block, but your job is to make the main spec concrete enough that the managed block mirrors real repo-aware intent instead of fallback scaffolding.
- During `planning_draft`, update the spec file. Do not patch generated `.smike/**` planning artifacts.

Required sections in the main spec file:
- `## Objective`
- `## What The Planner Must Read First`
- `## Required Deliverable From This Loop` or `## Planner Must Produce`
- `## Required Planning Output Shape` with concrete `- Plan NN:` lines
- matching `## Priority N:` summaries

For every phase:
- include `category:` or `write_scope:`
- include `depends:` when the default chain is wrong
- write a `## Priority N:` summary that is specific enough to become phase scope
- add phase-specific `verify:` commands on each code-bearing `- Plan NN:` line when the surface is concrete

Use attached docs as source material and truth refs, but do not split the spec contract across files. Leave `## Clarifying Questions` only for facts that genuinely block promotion; otherwise capture assumptions, constraints, non-goals, deferrals, and risk controls in the spec.
```

## When To Use The Full Authoring Guide

Open `scripts/smike/SPEC_AUTHORING.md` only when you need:

- exact accepted headings and aliases
- blueprint directive syntax
- research-mode details
- parser edge cases
- deeper examples
