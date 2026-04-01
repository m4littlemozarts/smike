---
name: smike:resume
description: Restore context, check progress, or pause work
argument-hint: "[optional: 'pause' to create handoff, or context hint]"
allowed-tools: [Read, Write, Edit, Glob, Bash, AskUserQuestion]
---

<objective>
Session entry point for SMIKE projects. Restores context, shows status, and routes to ONE next action.

**When to use:**
- Starting a new session on an existing SMIKE project
- Checking progress mid-session
- Pausing work: `/smike:resume pause` creates a handoff for next session
</objective>

<execution_context>
@~/.claude/smike/workflows/resume-project.md
@~/.claude/smike/workflows/pause-work.md
</execution_context>

<context>
$ARGUMENTS

@.smike/STATE.md
</context>

<process>

If $ARGUMENTS contains "pause":
  Follow workflow: @~/.claude/smike/workflows/pause-work.md
  Exit after handoff is created.

Otherwise:
  Follow workflow: @~/.claude/smike/workflows/resume-project.md

**Key behavior:** Suggest exactly ONE next action, not multiple options.
</process>

<success_criteria>
- [ ] Context restored from STATE.md and/or handoff
- [ ] Loop position correctly identified
- [ ] Exactly ONE next action suggested (not multiple options)
- [ ] User can proceed or redirect with context
</success_criteria>
