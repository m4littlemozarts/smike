---
name: smike:init
description: Initialize SMIKE with a spec — decompose into executable plan graph
argument-hint: "[spec-file] [extra-reference-files...]"
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

<objective>
Initialize SMIKE by reading spec/reference files, decomposing into an executable plan graph,
and writing all project state. Does NOT start execution — use `/smike:resume` in a fresh session.

**When to use:** Starting a new SMIKE-managed feature or project.

**Accepts multiple files:** First file is the primary spec. Additional files are reference
context (architecture docs, design docs, existing specs) passed to the planning agent.

**Two-stage decomposition:**
1. Validate file paths (spec + references)
2. Ask any clarifying questions
3. Stage 1: Strategist subagent reads spec → produces plan outlines + dependency graph
4. Stage 2: Detailer subagents (parallel) each flesh out one plan outline into full PLAN.md
5. Write all .smike/ state (PROJECT.md, STATE.md, ROADMAP.md, PLAN-GRAPH.md, all PLAN.md files)
6. Present the execution strategy
7. STOP — user runs `/smike:resume` in a fresh session to begin execution
</objective>

<execution_context>
@~/.claude/smike/workflows/init-project.md
<!-- strategist + detailer prompts loaded on-demand at dispatch, NOT eagerly -->
</execution_context>

<context>
$ARGUMENTS (space-separated file paths: first is spec, rest are references)
</context>

<process>
Follow workflow: @~/.claude/smike/workflows/init-project.md
</process>

<success_criteria>
- [ ] All input files read and understood
- [ ] Planning subagent decomposed spec into plans + graph
- [ ] All .smike/ files created (STATE, ROADMAP, PROJECT, PLAN-GRAPH, plans)
- [ ] Execution strategy presented to user
- [ ] User told to run `/smike:resume` in a fresh session
</success_criteria>
