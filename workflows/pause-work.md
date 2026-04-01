<purpose>
Create HANDOFF.md file and update STATE.md when pausing work mid-session. Enables seamless resumption in fresh session with full context restoration.
</purpose>

<when_to_use>
- User explicitly pauses work
- Switching to different project
- Before a long break (end of day, etc.)
</when_to_use>

<loop_context>
Any position in PLAN/APPLY/JUDGE loop. Captures state regardless of where loop is.
</loop_context>

<required_reading>
@.smike/{project_name}/STATE.md
@.smike/{project_name}/PROJECT.md

Note: `{project_name}` is passed from the active workflow or resolved from STATE.md.
All `.smike/` paths in this workflow are relative to `.smike/{project_name}/`.
</required_reading>

<references>
<!-- Handoff format is defined inline in create_handoff step -->
</references>

<process>

<step name="detect_position" priority="first">
1. Read `.smike/{project_name}/STATE.md` to get:
   - Current phase and plan
   - Loop position (PLAN/APPLY/JUDGE markers)
   - Last activity
2. Identify current working directory:
   ```bash
   ls -t .smike/{project_name}/phases/*/PLAN*.md 2>/dev/null | head -1
   ```
</step>

<step name="gather_session_context">
**Collect complete state for handoff:**

Ask user (or infer from conversation):
1. **Work completed this session** - What got done?
2. **Work in progress** - What's partially done?
3. **Decisions made** - Key choices and rationale
4. **Blockers/issues** - Anything stuck?
5. **Mental context** - The approach, what you were thinking

If user doesn't provide, summarize from:
- Recent file modifications (`git status`)
- Conversation history
- STATE.md changes
</step>

<step name="create_handoff">
**Create HANDOFF file:**

```bash
# Generate filename
TIMESTAMP=$(date +%Y-%m-%d)
HANDOFF_FILE=".smike/{project_name}/HANDOFF-${TIMESTAMP}.md"
```

**Write content (NOT from template, populate directly):**

```markdown
# SMIKE Handoff

**Date:** [current timestamp]
**Project:** {project_name}
**Status:** [paused/blocked]

---

## READ THIS FIRST

You have no prior context. This document tells you everything.

**Project:** [from PROJECT.md]
**Core value:** [from PROJECT.md]

---

## Current State

**Version:** [from STATE.md]
**Phase:** [N] of [total] — [phase name]
**Plan:** [plan-id] — [status]

**Loop Position:**
```
PLAN ──▶ APPLY ──▶ JUDGE
  [✓/○]    [✓/○]    [✓/○]
```

---

## What Was Done

- [Accomplishment 1]
- [Accomplishment 2]
- [Accomplishment 3]

---

## What's In Progress

- [In-progress item with status]

---

## What's Next

**Immediate:** [specific next action]

**After that:** [following action]

---

## Key Files

| File | Purpose |
|------|---------|
| `.smike/{project_name}/STATE.md` | Live project state |
| `.smike/{project_name}/ROADMAP.md` | Phase overview |
| [current plan path] | [plan purpose] |

---

## Resume Instructions

1. Read `.smike/{project_name}/STATE.md` for latest position
2. Check loop position
3. Run `/smike {project_name}`

---

*Handoff created: [timestamp]*
```

Be specific enough for a fresh Claude to understand immediately.
</step>

<step name="update_state">
**Update `.smike/{project_name}/STATE.md` Session Continuity section:**

```markdown
## Session Continuity

Last session: [timestamp]
Stopped at: [what was happening]
Next action: [clear directive]
Resume file: .smike/{project_name}/HANDOFF-[date].md
Resume context:
- [bullet 1 - key context]
- [bullet 2 - key context]
- [bullet 3 - key context]
```
</step>

<step name="optional_commit">
**If git repo, offer WIP commit with explicit two-question flow:**

**Question 1 — Commit WIP?**
```
────────────────────────────────────────
Would you like to commit your work-in-progress?

This saves a checkpoint you can return to.
────────────────────────────────────────
[yes] / [no]
```

**If no:** Skip to confirm step.

**If yes — Question 2 — Branch choice:**
```
────────────────────────────────────────
Where should this WIP commit go?

Use AskUserQuestion:
- "main" — Commit directly to main branch
- "feature branch" — Create feature/{phase-name} branch first

Note: Feature branch is useful if work isn't ready for main.
────────────────────────────────────────
```

**If main (option 1):**
```bash
git add .smike/{project_name}/ src/
git commit -m "wip({phase}): paused at {plan}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

**If feature branch (option 2):**
```bash
# Create and switch to feature branch
git checkout -b feature/{phase-name}

# Commit to feature branch
git add .smike/{project_name}/ src/
git commit -m "wip({phase}): paused at {plan}

Co-Authored-By: Claude <noreply@anthropic.com>"

# Record branch strategy in STATE.md for transition-phase
```

**Update STATE.md Session Continuity with branch info:**
```markdown
Git strategy: {main|feature/{phase-name}}
```

This enables transition-phase.md to know the branch strategy when reconciling.
</step>

<step name="confirm">
**Display confirmation:**

```
════════════════════════════════════════
SMIKE SESSION PAUSED — {project_name}
════════════════════════════════════════

Handoff created: .smike/{project_name}/HANDOFF-[date].md

Current State:
  Phase: [N] of [M]
  Plan: [status]
  Loop: [PLAN/APPLY/JUDGE position]

To resume later:
  /smike {project_name}

════════════════════════════════════════
```
</step>

</process>

<output>
- HANDOFF-{date}.md created in .smike/{project_name}/
- STATE.md updated with session continuity
- Optional WIP commit with branch choice (main or feature/{phase})
- Git strategy recorded in STATE.md for transition-phase
- User knows how to resume
</output>

<error_handling>
**No .smike/ directory:**
- "No SMIKE project found. Nothing to pause."

**STATE.md missing or corrupted:**
- Create minimal handoff from available context
- Note the gap in handoff file

**Git not available:**
- Skip commit step, still create handoff
</error_handling>
