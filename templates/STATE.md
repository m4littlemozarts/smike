# STATE.md Template

**Purpose:** Thin pointer to current position + gotchas Claude can't discover from code.
**Target: 20-30 lines. If it exceeds 40, prune.**

---

## File Template

```markdown
# Project State

## Project Reference

See: .smike/PROJECT.md (updated [date])

**Core value:** [core value from PROJECT.md]
**Current focus:** [current phase name or "ready for planning"]

## Current Position

Milestone: [Name] ([version])
Phase: [X] of [Y] — [Phase Name]
Plan: [current plan status]
Status: [Ready for PLAN / Awaiting approval / In progress / Complete]
Last activity: [YYYY-MM-DD] — [one-line what happened]

Progress:
- [Milestone name]: [██░░░░░░░░] X%

## Loop Position

Current loop state:
```
PLAN ──▶ APPLY ──▶ JUDGE
  ○        ○        ○     [Description of current state]
```

## Accumulated Context

### Decisions
| Decision | Phase | Impact |
|----------|-------|--------|
| [decision] | [phase] | [impact] |

### Gotchas (not in code)
<!-- Only things that would cause bugs if Claude didn't know them -->
<!-- Ask: "Can Claude discover this by reading source files?" If yes, delete it. -->
- [gotcha 1]

### Deferred Issues
- [item] — [when to revisit]

## Session Continuity

Last session: [date]
Next action: [exact command to run]
Resume context: [essential context for next session]

---
*STATE.md — Updated after every significant action*
```
