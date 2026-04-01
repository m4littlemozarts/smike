# SMIKE

It's like plan mode but for way bigger multisession plans that are annoying to do with Claude Code right now.

Feed `/smike:init` a well thought out spec doc with any other supporting info you want, it will work it into a multisession plan without dropping anything important.

`/smike:resume` will work through the full init plan. Its use of subagents and smart context engineering means you can chug through the whole thing in one long session without context rot. Most of the time it's completely automated.

Built to keep multi-session projects on track without scope drift and annoying shit.

## Quick Start

1. Write a spec for what you want to build (markdown, as detailed as you want)
2. `/smike:init my-spec.md` — decomposes into an executable plan graph
3. In a new session `/smike:resume my-spec` — starts execution, picks up automatically
4. Let it cook. `/smike:pause` to pause if needed

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
| `/smike:pause` | Freeze current progress. Creates a self-contained handoff file for the next session. |

## Use Cases

**Greenfield features across multiple files and concerns**
Write a spec covering the data model, API, and UI. SMIKE breaks it into isolated plans with explicit file boundaries and dependency ordering, then executes them sequentially (or in parallel where safe).

**Big refactors**
Structural changes that can't be done in one shot. SMIKE tracks which pieces are done, what decisions were made along the way, and what still needs to happen.

**Anything where "just do it" leads to drift**
If you've had Claude build something that technically works but doesn't match what you asked for, the independent judge phase catches that. Verification and code review run in fresh context with no knowledge of the execution. They only check the plan's acceptance criteria against the actual code.

## Architecture

### Agents

SMIKE dispatches specialized subagents at each stage. They write full reports to disk and return only compact summaries, keeping the orchestrator's context lean.

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
| **Light** | 1 task, simple verifies, clean execution | Inline checks only, no subagent |
| **Medium** | 1-2 tasks, clean execution | Verification subagent, skip review |
| **Full** | 3+ tasks, failures, or discoveries | Verification + review in parallel |

### Parallel Execution

Plans in the same dependency group run in parallel (up to 3 concurrent subagents in isolated worktrees). Plans across groups run sequentially. SMIKE handles the merge ordering.

## Install

Tell Claude to do it:

```
Clone https://github.com/m4littlemozarts/smike into ~/.claude/smike/ and copy the
command files from the commands/ folder into ~/.claude/commands/smike/ so the slash
commands work. Add .smike/ to this project's .gitignore.
```

Or do it yourself:

```bash
# Framework
git clone https://github.com/m4littlemozarts/smike.git ~/.claude/smike

# Commands (enables /smike:init, /smike:resume, /smike:pause)
mkdir -p ~/.claude/commands/smike
cp ~/.claude/smike/commands/* ~/.claude/commands/smike/
```

Add `.smike/` to your project's `.gitignore`.
