<purpose>
Resume SMIKE work after a session break. Resolves which project to resume, reads
STATE.md to restore context, determines next action, and routes. Includes handoff
lifecycle management.
</purpose>

<when_to_use>
- Starting a new session on an existing SMIKE project
- Context was cleared (new conversation)
- Handoff from another session
- User asks to "continue" or "resume" SMIKE work
</when_to_use>

<philosophy>
**Single next action:** Resume determines state and suggests exactly ONE action.
No multiple options. Prevents decision fatigue.

**Handoff lifecycle:** Handoffs are consumed on resume, then deleted.
</philosophy>

<rules>
**AskUserQuestion fallback protocol** — use this EVERY time this workflow calls AskUserQuestion:

AskUserQuestion may silently auto-complete with empty answers during skill/command
invocations (e.g., `/smike`). The interactive picker never renders to the user.

Detection: after AskUserQuestion returns, check the result string for answer content.
A successful response contains `"header"="answer"` patterns (e.g., `"Project"="my-app"`).
An empty/failed response looks like: `"User has answered your questions: ."` — note the
bare period with no `=` sign and no quoted answer.

```
IF result contains "=" between quoted strings:
  → Answers received. Extract them and proceed.
ELSE (empty — no "=" found, or result is just ". "):
  → AskUserQuestion failed silently. Fall back:
  1. Print the questions as numbered text with lettered options:
     ```
     ┌─ Questions ─────────────────────────
     │ 1. {question text}
     │    (a) {option 1 label} — {description}
     │    (b) {option 2 label} — {description}
     │
     │ 2. {question text}
     │    (a) ...
     └────────────────────────────────────
     Type your answers (e.g., "1a 2b") or describe in your own words:
     ```
  2. STOP and wait for the user to type a response in chat.
  3. Parse their text response and proceed.
```

This fallback applies to ALL AskUserQuestion calls in this workflow:
resolve_project (multi-project selection) and report_and_route (checkpoint mode).
</rules>

<process>

<step name="resolve_project" priority="first">
**Determine which project to resume.**

1. Check if $ARGUMENTS contains a project name.
2. List available projects:
   ```bash
   ls -d .smike/*/STATE.md 2>/dev/null | sed 's|.smike/||;s|/STATE.md||'
   ```

3. **If project name provided in $ARGUMENTS:**
   - Verify `.smike/{project_name}/STATE.md` exists
   - If not found: "No SMIKE project '{project_name}' found." List available projects. Exit.

4. **If no project name provided:**
   - **0 projects found:** "No SMIKE projects found. Run `/smike <spec-file>` first." Exit.
   - **1 project found:** auto-select it. Print: "Resuming project: {project_name}"
   - **2+ projects found:** AskUserQuestion:
     "Multiple SMIKE projects found. Which one?"
     Options: list each project name with its current state (from STATE.md Position line)

5. Store: `project_name`, `project_dir` = `.smike/{project_name}`
</step>

<step name="load_state">
1. Read `.smike/{project_name}/STATE.md` (required)
2. Check for `.smike/{project_name}/PLAN-GRAPH.md` — if exists, read it for graph progress
3. If HANDOFF.md exists in `.smike/{project_name}/`: read it, then delete it after proceeding
4. Determine next action from STATE.md Resume section + graph status
</step>

<step name="determine_single_action">
Based on STATE.md + plan graph, determine **exactly ONE** next action:

| State | Single Next Action |
|-------|-------------------|
| No plans exist | `/smike [spec-file]` |
| Graph exists, next plan pending | Execute next plan (load apply-phase.md) |
| Next plan has `pause_before: true` | Execute it (operator already resumed — pause was honored) |
| Plan executed, not verified | `/smike:judge [plan-path]` |
| All plans complete | Phase transition |
| Blocked | "Address blocker: [specific issue]" |

**If graph exists:** show progress summary:
```
Graph: {completed}/{total} plans | Group {current}/{groups}
Next: {next-plan-id} — {one-line summary}
```

**Do NOT offer multiple options.** Pick the ONE correct action.
</step>

<step name="report_and_route">
Display brief status:

```
SMIKE RESUMED — {project_name}
Phase [N]/[M]: [Phase Name]
Last: [what happened]
Next: [brief description of next action]
```

**Check `.smike/{project_name}/config.md` for `auto_accept_plans: true`:**

**If autonomous mode (auto_accept_plans: true):**
- Print one status line: `Resuming — {next action}...`
- Execute the next action immediately (load the relevant workflow)
- No AskUserQuestion. No pause. Just go.

**If checkpoint mode (auto_accept_plans: false or missing):**
- AskUserQuestion:
  - "Continue" (Recommended) — execute the next action immediately
  - "Different action" — user provides alternative direction
- On **Continue**: execute the next action directly (load the relevant workflow).
- Do NOT print "Type yes" — use AskUserQuestion for all user interaction.

**Pass `project_name` to all downstream workflows** so they know which project
directory to use for all `.smike/{project_name}/` paths.
</step>

<step name="handoff_lifecycle">
**After user proceeds with work:**

When user confirms next action:
1. Delete consumed HANDOFF.md (if one existed)
2. Clean orphaned handoffs older than 7 days
3. Handoff context is now integrated into session
</step>

</process>

<output>
- Context restored from STATE.md
- Exactly ONE next action suggested
- Handoff deleted after consumption
- Project name passed to downstream workflows
</output>

<error_handling>
**STATE.md corrupted or incomplete:**
- Report what's missing
- Suggest manual repair or `/smike <spec-file>`

**Conflicting information:**
- Trust STATE.md over stale handoffs
- Report discrepancy, ask user to clarify
</error_handling>
