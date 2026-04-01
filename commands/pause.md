---
name: smike:pause
description: Pause work and create a handoff for the next session
allowed-tools: [Read, Write, Edit, Glob, Bash, AskUserQuestion]
---

<objective>
Freeze current progress and create a self-contained handoff file so the next session can pick up cleanly.

**When to use:**
- Done for the day, want to resume later
- Need to context-switch to something else
</objective>

<execution_context>
@~/.claude/smike/workflows/pause-work.md
</execution_context>

<context>
@.smike/STATE.md
</context>

<process>
Follow workflow: @~/.claude/smike/workflows/pause-work.md
Exit after handoff is created.
</process>

<success_criteria>
- [ ] HANDOFF.md created with full session context
- [ ] STATE.md updated with session continuity info
- [ ] Optional WIP commit created if needed
</success_criteria>
