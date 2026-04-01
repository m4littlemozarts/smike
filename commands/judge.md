---
name: smike:judge
description: Run JUDGE phase (automated verification) for a completed plan
argument-hint: "[plan-path]"
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

<objective>
Independently verify plan execution via subagent, then reconcile and route.

**When to use:** After APPLY phase completes. Usually auto-invoked from apply-phase,
but can be called manually if the loop was interrupted after execution.

JUDGE is automated verification, not manual user testing.
</objective>

<execution_context>
@~/.claude/smike/workflows/judge-phase.md
</execution_context>

<context>
Plan path: $ARGUMENTS

@.smike/STATE.md
</context>

<process>

<step name="validate">
1. Confirm plan file exists at $ARGUMENTS path
2. Check for existing completion block — if present, plan already judged
3. Verify execution commits exist (git log since plan creation)
</step>

<step name="execute">
Follow workflow: @~/.claude/smike/workflows/judge-phase.md

The workflow handles:
- Light vs full judge mode selection
- Verification subagent dispatch (full mode)
- Inline verification (light mode)
- Completion block, state update, routing
</step>

</process>

<success_criteria>
- [ ] Verification completed (inline or via subagent)
- [ ] Completion block appended to PLAN.md
- [ ] STATE.md updated
- [ ] Auto-continued to next plan or transition
</success_criteria>
