<loop_phases>

## Purpose

Explain the semantics of SMIKE's three loop phases: PLAN, APPLY, JUDGE. Every unit of work follows this loop. Skipping phases breaks traceability and increases risk.

## The Loop

```
    ┌─────────────────────────────────────────┐
    │                                         │
    ▼                                         │
  PLAN ────────► APPLY ────────► JUDGE ───────┘
    │              │               │
    │              │               │
 Define work   Execute work   Verify & close
 Get approval  Run tests      Independent check
```

## PLAN Phase

**Purpose:** Define what will be built, how it will be verified, and what's out of scope.

**Artifacts Created:**
- `{phase}-{plan}-PLAN.md` in `.smike/phases/{phase-name}/`

**Activities:**
1. Analyze requirements and context
2. Define objective (Goal, Purpose, Output)
3. Write acceptance criteria (Given/When/Then)
4. Break down into 2-3 tasks with Files, Test, Action, Verify, Done
5. Set boundaries (DO NOT CHANGE, SCOPE LIMITS)
6. Define verification checklist
7. **Wait for approval before proceeding**

**Entry Condition:**
- Prior plan completed (JUDGE done) OR first plan
- ROADMAP indicates this phase is next

**Exit Condition:**
- PLAN.md created with all required sections
- User has approved the plan
- STATE.md updated to show "ready for APPLY"

**Loop Position:**
```
PLAN ──▶ APPLY ──▶ JUDGE
  ✓        ○        ○     [PLAN complete, awaiting APPLY]
```

## APPLY Phase

**Purpose:** Execute the approved plan by dispatching subagent(s), using TDD for testable tasks.

**Artifacts Created:**
- Code/files specified in PLAN.md
- Test files for tasks with `<test>` fields
- Per-task git commits
- `{plan}-EXEC-REPORT.md` (full report written to disk by execution subagent)

**Activities:**
1. Extract plan metadata mechanically (no full plan read — subagent reads it)
2. Assess parallelism (can tasks run independently?)
3. Dispatch execution subagent(s) with report_path for disk write
4. For TDD tasks: write failing test → implement → verify pass
5. For standard tasks: implement → verify
6. Parse compact execution summary (full report on disk)
7. Triage any failures — read full report from disk only when needed
8. Auto-continue to JUDGE

**Entry Condition:**
- PLAN.md exists and is approved
- STATE.md shows loop position at PLAN complete

**Exit Condition:**
- All tasks completed (or triaged)
- Execution report parsed and verified via git
- Ready for independent verification

**Loop Position:**
```
PLAN ──▶ APPLY ──▶ JUDGE
  ✓        ✓        ○     [APPLY complete, ready for JUDGE]
```

## JUDGE Phase

**Purpose:** Independently verify execution output, then reconcile and route. The Judge doesn't trust the execution report — it runs tests and checks acceptance criteria itself.

**Modes:** LIGHT (1 task, inline verification), MEDIUM (1-2 tasks, verification subagent only),
FULL (verification + review subagents in parallel). Mode determined by task count, execution
result, TDD presence, and discovery flags.

**Artifacts Created:**
- `{plan}-VERDICT.md` (full verdict written to disk by verification subagent)
- `{plan}-REVIEW.md` (full review written to disk by review subagent — FULL mode only)
- Completion block appended to PLAN.md
- Updated `STATE.md`
- Updated `ROADMAP.md` (if phase complete)

**Activities:**
1. Determine judge mode (LIGHT / MEDIUM / FULL)
2. Structural integrity check (mechanical — all modes)
3. Dispatch verification subagent with verdict_path (MEDIUM/FULL)
4. Dispatch review subagent with review_path (FULL only, unless review_mode=always)
5. Parse compact summaries (full reports on disk — read only on failure paths)
6. Append completion block to PLAN.md
7. Update STATE.md
8. Route to next plan, pause checkpoint, or phase transition

**Entry Condition:**
- APPLY phase complete (auto-invoked)

**Exit Condition:**
- All ACs independently verified
- Completion block appended
- STATE.md updated with new position
- Loop closed, ready for next PLAN

**Loop Position:**
```
PLAN ──▶ APPLY ──▶ JUDGE
  ✓        ✓        ✓     [Loop complete, ready for next PLAN]
```

## Loop Invariants

**Never Skip PLAN:**
No plan = no acceptance criteria = no way to verify completion.

**Never Execute Without Approval:**
Plans may have incorrect assumptions. Approval catches issues early.

**Always Close With JUDGE:**
No JUDGE = no independent verification = quality gaps.

**JUDGE Verifies Independently:**
The Judge runs tests and checks ACs itself. It does not rubber-stamp
the execution report. This is the quality guarantee.

## Phase Transitions

### PLAN → APPLY
Trigger: User approves plan (explicit signal)

Validation:
- [ ] PLAN.md has all required sections
- [ ] Acceptance criteria are testable
- [ ] Tasks have Files, Action, Verify, Done
- [ ] TDD tasks have Test field and test command in Verify
- [ ] Boundaries are clear

### APPLY → JUDGE
Trigger: All tasks complete OR triaged (auto-invoked)

Validation:
- [ ] Each task verification passed (or triaged)
- [ ] Execution report parsed
- [ ] Git commits verified

### JUDGE → PLAN (next)
Trigger: Independent verification passed, state updated

Validation:
- [ ] All ACs independently verified
- [ ] Completion block appended
- [ ] STATE.md reflects new position
- [ ] ROADMAP.md updated if phase complete

## Visual Loop Position Format

STATE.md displays loop position visually:

```markdown
## Loop Position

Current loop state:
```
PLAN ──▶ APPLY ──▶ JUDGE
  ✓        ○        ○     [Description of current state]
```
```

Symbols:
- `✓` = Phase complete
- `○` = Phase pending

## Anti-Patterns

**Partial loops:**
```
PLAN → APPLY → (skip JUDGE) → PLAN
```
Why bad: No independent verification. Bugs compound across plans.

**Implicit approval:**
```
"I assume the plan is approved and will proceed"
```
Why bad: May execute on flawed assumptions.

**Trusting the execution report blindly:**
```
"Subagent said PASS, moving on"
```
Why bad: The whole point of JUDGE is independent verification.

</loop_phases>
