# SMIKE

A structured execution framework for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Decomposes complex specs into dependency-ordered plan graphs, then executes them through an automated plan-apply-judge loop with independent verification.

Built for multi-session projects where you need traceability, not vibes.

## The Problem

Claude Code is great at single-session tasks. But when you're building something that spans days — a new service, a major refactor, a greenfield feature — things fall apart. Context gets lost between sessions. Work drifts from the spec. There's no verification that what got built actually matches what was planned.

SMIKE fixes this by giving Claude a persistent execution loop with state that survives session boundaries.

## How It Works

```
You write a spec
        │
        ▼
  /smike:init ─── Strategist decomposes into phases + plans
        │         Detailers flesh out each plan (parallel)
        │         Checker validates cross-plan contracts
        │         Scope auditor confirms full spec coverage
        │
        ▼
  .smike/ state written to disk (plans, graph, roadmap)
        │
        ▼
  /smike:resume ── Picks up where you left off, every session
        │
        ▼
  ┌─────────────────────────────────────────────────┐
  │              EXECUTION LOOP (per plan)           │
  │                                                  │
  │   APPLY ──────► JUDGE ──────► next plan          │
  │   Execute plan   Verify independently            │
  │   TDD + commits  Route: pass / fix / escalate    │
  │                                                  │
  │   ... repeats for every plan in the graph ...    │
  │                                                  │
  │   Last plan ──► TRANSITION                       │
  │                 Scope audit, deploy, next phase   │
  └─────────────────────────────────────────────────┘
```

## Commands

| Command | What it does |
|---|---|
| `/smike:init <spec> [refs...]` | Decompose a spec into an executable plan graph. Reads your spec + optional reference docs, runs multi-agent planning, writes all state to `.smike/`. Does not execute anything. |
| `/smike:resume` | Entry point for every session. Reads state from disk, figures out exactly where you left off, suggests the one next action. |
| `/smike:resume pause` | Freeze current progress. Creates a self-contained handoff file for the next session. |
| `/smike:judge [plan-path]` | Manually trigger verification if a session was interrupted after execution. Usually auto-invoked. |

## Use Cases

**Greenfield feature across multiple files and concerns**
Write a spec covering the data model, API, and UI. SMIKE breaks it into isolated plans with explicit file boundaries and dependency ordering, then executes them sequentially (or in parallel where safe).

**Multi-day refactors**
Big structural changes that can't be done in one shot. SMIKE tracks which pieces are done, what decisions were made along the way, and what still needs to happen — across as many sessions as it takes.

**Anything where "just do it" leads to drift**
If you've ever had Claude build something that technically works but doesn't match what you asked for, SMIKE's independent judge phase catches that. Verification and code review run in fresh context with no knowledge of the execution — they only check the plan's acceptance criteria against the actual code.

## Architecture

### Agents

SMIKE dispatches specialized subagents at each stage. They write full reports to disk and return only compact summaries — keeping the orchestrator's context lean.

| Agent | Stage | Role |
|---|---|---|
| **Strategist** | Init | Reads spec, produces plan outlines + dependency graph |
| **Detailer** | Init | Fleshes out one plan outline into a full PLAN.md (parallel) |
| **Checker** | Init | Cross-plan contract validation |
| **Scope Auditor** | Init | Confirms plan graph covers entire spec |
| **Execution** | Apply | Implements a plan: TDD, targeted commits, boundary enforcement |
| **Verification** | Judge | Independently runs tests + checks ACs (does not trust execution report) |
| **Review** | Judge | Fresh-eyes code review, drift detection |
| **Fix** | Judge | Targeted fix for a specific issue (one attempt, then escalate) |

### State (all on disk)

```
.smike/
  STATE.md        ← Current position, decisions, gotchas
  PROJECT.md      ← What we're building + hard constraints
  ROADMAP.md      ← Phase progress tracker
  PLAN-GRAPH.md   ← Dependency-ordered execution graph
  config.md       ← Preferences (auto-accept, TDD, deploy commands)
  phases/
    01-feature/
      01-01-PLAN.md
      01-02-PLAN.md
      ...
```

Disk is truth. After auto-compaction wipes the conversation, SMIKE re-orients from these files at every cycle boundary.

### Judge Modes

The judge auto-selects its depth based on plan complexity:

| Mode | When | What runs |
|---|---|---|
| **Light** | 1 task, simple verifies, clean execution | Inline checks only — no subagent |
| **Medium** | 1-2 tasks, clean execution | Verification subagent, skip review |
| **Full** | 3+ tasks, failures, or discoveries | Verification + review in parallel |

### Parallel Execution

Plans in the same dependency group run in parallel (up to 3 concurrent subagents in isolated worktrees). Plans across groups run sequentially. SMIKE handles the merge ordering.

## Install

Copy the `commands/` directory and framework into your Claude Code config:

```bash
# Framework
cp -R smike/ ~/.claude/smike/

# Commands (enables /smike:init, /smike:resume, /smike:judge)
mkdir -p ~/.claude/commands/smike
cp commands/* ~/.claude/commands/smike/
```

Add `.smike/` to your project's `.gitignore`.

## Quick Start

1. Write a spec for what you want to build (markdown file, as detailed as you want)
2. `/smike:init my-spec.md` — watch it decompose into plans
3. Review the plan graph in `.smike/PLAN-GRAPH.md`
4. `/smike:resume` — starts execution, picks up automatically every session
5. `/smike:resume pause` — when you need to stop

That's it. SMIKE handles the loop.
