<purpose>
Verify execution output independently via subagent, then reconcile and route. The Judge dispatches a verification subagent with fresh context — it does NOT run tests or checks inline (except in LIGHT mode). After verification, handles bookkeeping: completion block, state update, routing.
</purpose>

<when_to_use>
- APPLY phase complete (auto-invoked from apply-phase)
- Ready to verify and close the current loop
</when_to_use>

<critical_distinction>
JUDGE = automated independent verification via subagent (no user involvement).
Part of the PLAN→APPLY→JUDGE loop.
</critical_distinction>

<loop_context>
Expected phase: JUDGE
Prior phase: APPLY (execution complete)
Next phase: PLAN (next plan) or transition (last plan in phase)
</loop_context>

<required_reading>
@.smike/{project_name}/STATE.md
@.smike/{project_name}/phases/{phase}/{plan}-PLAN.md

Note: `{project_name}` is passed from the apply-phase workflow. All `.smike/`
paths in this workflow are relative to `.smike/{project_name}/`.
</required_reading>

<references>
<!-- Completion block format defined inline in append_completion step -->
<!-- transition-phase.md loaded on demand in execute_transition step, NOT eagerly -->
</references>

<logging>
**Subagent-owned logging.** Verification and review subagents write their own LOG.md entries.
The orchestrator does NOT read or append to LOG.md.
</logging>

<process>

<rule name="ASKUSER_FALLBACK" priority="critical">
**AskUserQuestion fallback protocol** — use this EVERY time this workflow calls AskUserQuestion:

AskUserQuestion may silently auto-complete with empty answers during skill/command
invocations. The interactive picker never renders to the user.

Detection: after AskUserQuestion returns, check the result string for answer content.
A successful response contains `"header"="answer"` patterns (e.g., `"Action"="Fix now"`).
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
     └────────────────────────────────────
     Type your answers (e.g., "1a 2b") or describe in your own words:
     ```
  2. STOP and wait for the user to type a response in chat.
  3. Parse their text response and proceed.
```

This fallback applies to ALL AskUserQuestion calls in this workflow:
dispatch_verification_and_review (HIGH review issues) and verdict (fix vs skip decisions).
</rule>

<rule name="BATCH_STATE_UPDATES" priority="critical">
Never make multiple separate Edit calls to STATE.md. Always: Read → modify all sections → single Write.
This applies to every step that touches STATE.md. Violation of this rule wastes 3-4 tool calls per transition.
</rule>

<step name="determine_judge_mode" priority="first">
**Choose light, medium, full, or fast judge based on plan context and execution result.**

Use the execution memo fields passed from APPLY (task_count, tdd_present,
verify_cmd_count, result, has_discovery, discovery_severity).

**Discovery severity** (from execution memo):
- `informational`: FYI notes — pre-existing test failures, known out-of-scope items,
  working-tree changes committed alongside. Does NOT affect correctness of this plan.
- `actionable`: New exports, type changes, file overlap, or decisions that affect
  future plans or verification of this plan.
Execution agents classify each discovery item. `has_discovery: true` + all items
`informational` → treat as `has_discovery: false` for mode selection.

**FAST mode** — ALL conditions met:
- `auto_accept_plans: true` in config (autonomous session)
- Plan has 1-2 tasks
- Execution result is SUCCESS
- No actionable discovery (has_discovery: false, or all discoveries informational)
- No non-SUCCESS in prior plan's completion block (no accumulated concerns)

FAST collapses JUDGE to inline verification only:
- Run verification commands inline (Bash tool) — same as LIGHT
- Run `git diff --stat {baseline}..HEAD` to confirm file changes match
- Skip code review entirely
- Proceed directly to verdict → append_completion → update_state
- **Savings:** ~50% vs FULL baseline. No subagent dispatches.

**LIGHT mode** — ALL conditions met:
- Plan has exactly 1 task
- Verification section has ≤3 commands
- Execution result is SUCCESS (from execution memo)

**MEDIUM mode** — ALL conditions met:
- Plan has 1-2 tasks
- Does NOT qualify for LIGHT or FAST
- Execution result is SUCCESS (from execution memo)
- No actionable discovery (has_discovery: false, or all discoveries informational)

**FULL mode** — anything else (3+ tasks, partial execution,
actionable discovery, non-SUCCESS with 2 tasks).

**LIGHT** skips both subagents entirely:
- Run verification commands inline (Bash tool)
- Check each AC manually (quick read/grep/curl)
- Skip code review (no review subagent)
- Proceed directly to verdict → append_completion → update_state → ...

**MEDIUM** dispatches verification subagent ONLY, skips review:
- Verification subagent runs independently with fresh context
- No review subagent (saves ~20-25% of JUDGE cost)
- Common case: clean 2-task plans. Verification catches bugs; review
  is low-value when execution was clean and there's nothing to drift-check.
- Proceed to verdict → append_completion → update_state → ...

**FULL** dispatches verification + review in parallel:
- Continue to dispatch_verification_and_review → verdict → ...

All steps from append_completion onward apply to ALL modes.

**Savings:** FAST ~50%, LIGHT ~40%, MEDIUM ~20-25% vs FULL baseline.

**review_mode interaction:** `review_mode: risk-only` means review runs ONLY in FULL mode.
Since FULL now requires `actionable` discovery (not just any discovery), informational
notes no longer trigger unnecessary reviews. This fixes the practical issue where
review ran on nearly every plan because `has_discovery` was almost always true.
</step>

<step name="structural_integrity_check">
**Mechanical check — no subagent, runs in ALL modes. ~10 seconds.**

Verify the execution agent stayed within plan boundaries. This catches scope
drift that accumulated during execution — the plan was valid at init time,
but the execution agent may have modified files outside its boundaries.

1. Extract boundaries mechanically — do NOT read full PLAN.md:
   ```bash
   sed -n '/<boundaries>/,/<\/boundaries>/p' "${plan_path}"
   ```
   Parse out the DO NOT CHANGE file list.

2. Run: `git diff --name-only {baseline}..HEAD`

3. Cross-reference: any file in the diff that appears in DO NOT CHANGE?
   - **Yes → BOUNDARY VIOLATION.** Flag for verdict step. Include:
     `BOUNDARY: {file} modified but listed in DO NOT CHANGE`
   - **No → clean.** Continue silently.

4. Extract task file lists (already available from APPLY's load_plan metadata):
   Cross-reference with diff:
   - Files in diff but NOT in any task's `<files>`: unexpected modifications.
     Flag as `SCOPE: {file} modified but not in any task's file list`
   - This is a soft signal (CONCERNS, not FAIL) — execution agents sometimes
     need to touch adjacent files for imports. But it feeds the review.

This step does NOT block — it feeds findings into the verdict step as
additional context alongside verification and review results.
</step>

<step name="dispatch_verification_and_review">
**FULL and MEDIUM modes. Skip entirely if LIGHT mode — go straight to verdict.**

**Check `review_mode` from `.smike/{project_name}/config.md`** to determine review dispatch:
- **always:** Dispatch review subagent even in MEDIUM mode (override the default skip)
- **risk-only:** Dispatch review subagent only in FULL mode (default). MEDIUM skips review.
- **never:** Skip review subagent entirely in all modes; verification only

**Compute report paths:**
- verdict_path: `.smike/{project_name}/phases/{phase}/{plan}-VERDICT.md`
- review_path: `.smike/{project_name}/phases/{phase}/{plan}-REVIEW.md`

**1. Prepare verification subagent:**

- subagent_type: "general-purpose"
- model: inherit from session
- description: "Verify plan {NN} execution"
- Prompt template: Read `~/.claude/smike/prompts/verification-agent.md`
- Fill placeholders:
  - {PLAN.md file path}: pass the PATH — verification agent reads it in fresh context
  - {execution memo}: the compact memo from APPLY's finalize step
  - {baseline commit}: git hash from before execution
  - {phase goal}: one line from ROADMAP.md
  - {known_failures}: PRE-EXISTING entries from STATE.md Gotchas, or "None"
  - {log_path}: LOG.md path or "DISABLED"
  - {verdict_path}: computed above

**2. Prepare review subagent (FULL mode, or MEDIUM when review_mode=always):**

Before dispatching, gather review context via mechanical extraction:
- Extract plan objective:
  ```bash
  sed -n '/^<objective>/,/^<\/objective>/p' "${plan_path}" | grep -A1 '^## Goal' | tail -1
  ```
- Extract scope boundaries (for false-positive prevention):
  ```bash
  sed -n '/<boundaries>/,/<\/boundaries>/p' "${plan_path}"
  ```
  Pass the full boundaries block to the review subagent as `{scope_boundaries}`.
  The review agent MUST check items against boundaries before flagging as scope
  misses — files listed in "DO NOT CHANGE" or "NOT in scope" are not misses.
- Extract phase goal from ROADMAP.md (one line)
- Extract prior review items: check the PREVIOUS plan's completion block.
  Look for `**Review backlog:**` or `**Review:**` section:
  ```bash
  prior_plan=".smike/${project_name}/phases/{phase}/{prior_plan}-PLAN.md"
  grep -A10 '^\*\*Review' "${prior_plan}" 2>/dev/null | head -10
  ```
  If it exists, take MEDIUM+ items verbatim. If no prior plan or no backlog: "None".
- Extract prior completion summary for drift accumulation awareness:
  ```bash
  grep '^\*\*Result:\*\*' "${prior_plan}" 2>/dev/null | head -1
  ```
  If no prior plan or no completion block: "None".

- subagent_type: "general-purpose"
- model: inherit from session
- description: "Review plan {NN} changes"
- Prompt template: Read `~/.claude/smike/prompts/review-agent.md`
- Fill placeholders:
  - {baseline_commit}: git hash
  - {plan_objective}: extracted above
  - {scope_boundaries}: extracted above (plan's <boundaries> block)
  - {phase_goal}: extracted above
  - {prior_review_items}: extracted above
  - {prior_completion_summary}: extracted above
  - {log_path}: LOG.md path or "DISABLED"
  - {review_path}: computed above

**3. Dispatch based on mode:**
- **FULL mode:** Dispatch BOTH verification and review as parallel Agent calls in a single message
- **MEDIUM mode:** Dispatch verification ONLY (skip review unless review_mode=always)

**After subagent(s) return:**

Parse verification summary first (determines PASS/FAIL routing):
1. Extract ---VERIFY-SUMMARY--- block
2. Check result: PASS, CONCERNS, or FAIL
3. Extract ac_results for the completion block
4. On PASS or CONCERNS: summary is sufficient for downstream routing
5. On FAIL: read full verdict from disk for failure details:
   ```bash
   cat "{verdict_path}"
   ```
6. If return is malformed (no ---VERIFY-SUMMARY--- found, or ---ERROR--- block):
   treat as CONCERNS, log raw output, continue

Parse review summary (if dispatched):
- Extract ---REVIEW-SUMMARY--- block
- **CLEAN:** Summary is sufficient. Log "Code review: CLEAN" and continue.
- **CONCERNS:** Summary gives verdict + drift + item_count. Include in completion block.
  Full details on disk at {review_path} if needed later.
- **ISSUES (item_count shows high > 0):** Read full review from disk for specific items:
  ```bash
  cat "{review_path}"
  ```
  Present HIGH items to user before continuing.
  - Ask: "Code review found issues. Fix now or note and continue?"
  - Fix → dispatch fix subagent with specific items (fill {review_items} with HIGH/MEDIUM items)
  - Note → record in completion block, continue
- **DRIFT: YES:** Read full review from disk for drift explanation:
  ```bash
  grep -A3 'DRIFT:' "{review_path}"
  ```
  Add drift description to STATE.md Gotchas as `SCOPE GAP: {description}`.
  If drift mentions interfaces used by future plans → update PLAN-GRAPH.md dependency + STATE.md Gotchas.
- **PRIOR_ITEMS:** prior_resolved from summary gives count. If prior_resolved < prior total
  (some items still open), read full review from disk for specifics.

If verification FAIL: prioritize fix, but still use review findings.

**Fix-agent dispatch context:**
When dispatching fix-agent for review ISSUES: fill `{review_items}` with the specific HIGH/MEDIUM items from the full review.
When dispatching fix-agent for execution failures: fill `{review_items}` with "None".
**fix report_path:** `.smike/{project_name}/phases/{phase}/{plan}-FIX-REPORT.md`

**Downstream discovery propagation (via bash — no full file reads):**
After parsing results AND after appending the completion block, propagate findings
to future plans using bash sed injection (keeps future plan content out of orchestrator memory).

**Before propagating anything:** Dedup check:
```bash
grep -q "plan-${source_id}.*${target_id}.*${file}" ".smike/${project_name}/STATE.md" && echo "SKIP" || echo "NEW"
```

1. If review ITEMS reference files owned by future plans (check PLAN-GRAPH.md) →
   inject discovery note via bash:
   ```bash
   target_plan=".smike/${project_name}/phases/{phase}/{target_plan}-PLAN.md"
   grep -q "## Discovery Notes" "${target_plan}" && {
     sed -i '' '/## Discovery Notes/a\
- [plan-'"${source_id}"'] '"${file}"': '"${description}"'' "${target_plan}"
   } || {
     sed -i '' 's|</context>|## Discovery Notes\
- [plan-'"${source_id}"'] '"${file}"': '"${description}"'\
</context>|' "${target_plan}"
   }
   ```
2. If DRIFT: YES and mentions interfaces used by future plans →
   update PLAN-GRAPH.md dependency + STATE.md Gotchas
3. **Completion-block gotcha propagation:**
   Read the "Gotchas for next plan" field from the completion block just written.
   For each gotcha that names a specific file path or type:
   a. Grep future pending PLAN.md `<files>` sections for that file path or type name:
      ```bash
      grep -l "${file_or_type}" .smike/${project_name}/phases/**/*-PLAN.md 2>/dev/null
      ```
   b. **Match found:** inject via bash sed (same pattern as above).
   c. **No match:** skip — the gotcha is not relevant to any future plan.
   This should trigger rarely. Only propagate when a gotcha names something a
   future plan explicitly touches. Do NOT propagate vague or general gotchas.

4. **Log all propagations to STATE.md** — for each discovery propagated in steps 1-3,
   add to `## Propagated Discoveries`:
   ```markdown
   - [plan-{source} → plan-{target}] {file}: {description}
   ```
   Include these entries in the update_state BATCH_STATE_UPDATES Write call.

</step>

<step name="verdict">
**Determine the verdict based on verification results.**

In FULL mode: use the ---VERIFY-SUMMARY--- result field.
In MEDIUM mode: use the ---VERIFY-SUMMARY--- result field (same parsing).
In LIGHT mode: use the inline verification results you just ran.

**PASS:** All verification commands succeeded AND all ACs verified
- Summaries are sufficient for append_completion
- Continue to append_completion

**CONCERNS:** All ACs pass but verification noted unexpected items
- Log items for awareness (from summary issues field)
- Continue to append_completion

**FAIL:** Tests fail OR any AC not verified
- Read full verdict from disk for specific failure details:
  ```bash
  cat "{verdict_path}"
  ```
- Straightforward fix (test assertion wrong, import missing) → dispatch fix subagent
  with specific failure from full verdict
- Ambiguous failure (logic error, wrong approach) → escalate to user
- After fix: re-dispatch verification (subagent in FULL/MEDIUM, inline in LIGHT) to confirm
- Fix budget: 1 fix dispatch per issue. If fix fails → escalate to user
  immediately with options: rollback / skip / abort. Do not retry with variations.
</step>


<step name="append_completion">
1. Open the PLAN.md that was just executed
2. Append completion block — derive from summaries where possible, read full reports
   from disk only when needed:

   **On PASS + CLEAN review (or no review in MEDIUM/LIGHT mode):**
   All fields derivable from summaries alone:
   - **Result:** `{verify result} — {exec result} — {Date}` (one line)
   - **Deviations:** None
   - **Gotchas for next plan:** from exec summary issues if any, otherwise None
   - **Review:** `{review summary verdict} | Drift: {review summary drift}` — or "Skipped" if no review
   - **Patterns:** from exec summary files_changed list

   **On CONCERNS, FAIL, or ISSUES:**
   Read full reports from disk for detailed fields:
   ```bash
   cat "{verdict_path}"    # for deviations and gotchas
   cat "{review_path}"     # for review items (only if review was dispatched)
   ```
   - **Result:** from verify summary
   - **Deviations:** from full verdict NOTES section
   - **Gotchas for next plan:** from full verdict ISSUES + full review ITEMS
   - **Review:** from review summary verdict + drift + specific items from full review.
     Include backlog items as sub-bullets if any.
   - **Patterns:** from exec summary files_changed

3. DO NOT: list every file, describe what code does, include unnecessary metadata.
   If a field would be "None", either write "None" on the same line or omit the field.

**Review backlog escalation:**
If the review backlog now has 3+ MEDIUM items, add a note to STATE.md Gotchas:
"Review backlog: {N} MEDIUM items accumulated — next plan should address."
This makes the scope_gaps check pick it up.
</step>

<step name="update_state">
Read STATE.md. Update all changed sections in a **single Write call**: Position (plan complete),
Resume (next action), Loop Position (mark JUDGE complete), Session Continuity (update last session
+ next action), **remove `## Execution Baseline` section** (no longer needed — cycle complete).
ONE write, not multiple edits.

**Position:**
- Phase: N of M — Complete (or In Progress if more plans)
- Plan: complete
- Last: [date] — [one-line what happened]

**Resume:**
- Next: [command for next plan or next phase]

**Progress tracking:**
When updating STATE.md, also update the Progress line:
- Phase progress: count completed plans in phase dir / estimated total plans for phase
  (estimate from ROADMAP deliverables if not explicitly numbered)
- Milestone progress: count completed phases / total phases in ROADMAP
- Format: `- Phase N: [████░░░░░░] X% (M of ~N plans)`

**Gotcha accuracy rule:**
When adding entries to the Gotchas section, VERIFY the actual convention/behavior
by checking the relevant source code FIRST. Do not write gotchas based on
assumptions from the fix subagent's description — read the file to confirm.
A wrong gotcha is worse than no gotcha (it causes bugs instead of preventing them).

**Gotcha pruning rules:**
When updating STATE.md, prune stale gotchas:
- Gotchas that reference a specific plan ID → remove when that plan completes.
  Example: "Plan 04 modifies ScheduleEditor (~1,364 lines)" → remove after Plan 04 passes.
- Gotchas with `expires_after: plan-{id}` → remove when that plan completes.
- Gotchas starting with `REVIEW:` → remove when the referenced file's owning plan completes
  (check PLAN-GRAPH.md file_map).
- Gotchas starting with `PRE-EXISTING:` → keep until phase transition (transition-phase
  handles cleanup).
- General invariant gotchas (no plan reference, no expiry) → keep indefinitely.

**Pre-existing test failure tracking:**
On first encounter of pre-existing test failures in a phase, add to Gotchas:
```markdown
- PRE-EXISTING: {test_file} — {N} failures ({brief description}). Unrelated to phase work.
```
Pass this line to all verification subagents in their prompt context so they can
filter mechanically instead of investigating each time. Format in verification prompt:
```
Known pre-existing failures (exclude from regression analysis):
- {test_file}: {N} failures — {description}
```

**Review backlog transcription:**
If the review returned STILL OPEN items, add each to the Gotchas section as
`REVIEW: [file:line] — [description]`. This ensures they flow into the next
plan-phase's `check_scope_gaps` step instead of silently dropping.
</step>

<step name="log_cycle_cost">
**One orchestrator append per cycle — captures data only the orchestrator knows.**

If logging is enabled (check config), append to `.smike/{project_name}/phases/{phase}/{plan}-LOG.md`:
```markdown
### cycle_cost — {timestamp}
- Judge: {FAST|LIGHT|MEDIUM|FULL} — Verdict: {PASS|CONCERNS|FAIL}
- Subagents: {count dispatched} — Tokens: {sum of total_tokens from Agent results}
```

This is the ONLY orchestrator log write per cycle. Do NOT read the file first — just append.
If logging is disabled: skip entirely.
</step>

<step name="check_phase_completion">
**Determine what to execute next using the plan graph (or plan count).**

1. Check for `.smike/{project_name}/PLAN-GRAPH.md`:
   ```bash
   ls .smike/{project_name}/PLAN-GRAPH.md 2>/dev/null
   ```

2. **If PLAN-GRAPH.md exists (graph mode):**
   - Read PLAN-GRAPH.md
   - Find the just-completed plan in the Plan Index
   - Mark it as `complete` in PLAN-GRAPH.md (single Edit)
   - Check its group for remaining pending plans:
     - **Pending plans in same group exist:** collect ALL pending plan paths in this
       group. Pass the full list to auto_continue for parallel dispatch.
     - **All plans in this group complete:** check if there's a NEXT group
       - If next group exists → collect ALL plan paths in next group. Pass to auto_continue.
       - If no next group → all plans complete → execute_transition

3. **If no PLAN-GRAPH.md (sequential mode):**
   - Count PLAN.md files in current phase directory
   - Count completed plans (those with completion blocks)
   - All complete → execute_transition
   - More plans remain → auto_continue with next plan
</step>

<step name="auto_continue" priority="critical">
**Execute the next plan(s) from the target group.**

check_phase_completion passes a list of pending plan paths from the target group.
The flow branches: single plan → sequential (existing), 2+ plans → parallel dispatch.

1. **Check for stop signal:** `ls .smike/{project_name}/STOP 2>/dev/null`
   - If `.smike/{project_name}/STOP` exists: delete it, update STATE.md, stop.

2. **Check for operator checkpoint:** Read each pending plan's frontmatter.
   If any has `pause_before: true`:
   - **Single plan:** pause entirely.
   - **Multiple plans:** execute only plans before the paused one (by plan ID order).
     If the FIRST pending plan pauses, pause entirely.
   ```
   ════════════════════════════════════════
   CHECKPOINT — PAUSING FOR OPERATOR
   ════════════════════════════════════════

   Completed through plan {current}. Progress: {completed}/{total}.
   Pausing before plan {next}: {pause_reason from frontmatter, or "operator requested"}

   When ready: /smike {project_name}
   ════════════════════════════════════════
   ```
   Update STATE.md Resume to point to the paused plan. **STOP.** Do not continue.

3. **Re-orient from disk:**
   - Read STATE.md (position, gotchas, propagated discoveries)
   - Read PLAN-GRAPH.md (graph status)
   Do not rely on in-memory state from previous cycles. Disk is truth.

   **Write-then-summarize:** Store ONLY a one-line summary of the just-completed
   plan in working memory. Reference completed plans by path + one-line result:
   ```
   Plan {id}: {PASS|CONCERNS|FAIL} — {one-line from completion block Result field}
   ```
   This keeps the orchestrator's conversation lean through multi-plan auto_continue cycles.

---

### A. Single plan (sequential — existing behavior)

4a. Print status line:
    ```
    {plan} done. Judge: {verdict}. Progress: {completed}/{total}. Continuing → {next-plan}...
    ```

5a. Update STATE.md Resume section to point to next plan.

6a. Execute: Read @~/.claude/smike/workflows/apply-phase.md with the Read tool
    and follow its instructions for the next plan.
    Do NOT use the Skill tool for internal workflow routing.

---

### B. Parallel group dispatch (2+ plans in the target group)

The strategist verified no file overlap within a group during init.
However, runtime verification is still needed — the init-time check uses
plan outlines, not final file lists from detailed plans.

4b. **Build within-group DAG based on file overlap:**
    Load metadata (file_lists) for all plans in the group. Then:
    ```
    For each pair (A, B) in the group:
      overlap = intersection(A.file_lists, B.file_lists)
      if overlap is non-empty:
        # The plan with the lower ID executes first
        add edge: lower_id → higher_id
        log: "Intra-group dependency: {A} → {B} (shared: {overlap files})"
    ```
    Result: a mini-DAG within the group. Plans with no inbound edges are
    immediately dispatchable. Plans with inbound edges wait for predecessors.

    **Example:** Group 1 has Plans 01, 02, 03, 04.
    - Plans 01 and 02 share `types.ts` → edge: 01 → 02
    - Plans 03 and 04 share nothing with anyone → immediately dispatchable
    - Dispatch wave 1: Plans 01, 03, 04 (all independent)
    - Dispatch wave 2: Plan 02 (after 01 completes)

    If no overlaps found: all plans dispatch in a single wave (original behavior).

5b. **Print status:**
    ```
    Group {G}: {N} plans, {W} wave(s) [{wave 1 plan-ids} | {wave 2 plan-ids} | ...]
    ```

6b. **Load metadata for each plan:** Run load_plan bash extraction for each
    (same commands from apply-phase `load_plan` step). Store per-plan:
    plan_path, task_count, tdd_present, verify_cmd_count, file_lists, boundary_files.

7b. **Preflight each plan:** Run preflight_check for each (same as apply-phase).
    If any hard failure: exclude that plan, report to user, continue with others.

8b. **Capture baseline:** `git rev-parse HEAD` — shared baseline for all plans.
    Write to STATE.md:
    ```markdown
    ## Execution Baseline
    Plans: {plan-ids}
    Commit: {baseline}
    ```

9b. **Dispatch execution subagents per wave:**
    Read `~/.claude/smike/prompts/execution-agent.md` template once.

    **For each wave in the within-group DAG:**
    a. For each plan in this wave, fill placeholders (plan_path, log_path, report_path).
    b. Dispatch ALL plans in this wave using parallel Agent tool calls:
       - subagent_type: "general-purpose"
       - isolation: "worktree"
       - description: "Execute plan {id}: {title}"
       - Each gets its own report_path
    c. Collect results, merge worktree branches (in plan-ID order)
    d. If any plan in this wave has non-SUCCESS: triage before next wave

    **Single-wave groups (no intra-group overlaps):** Same as original parallel dispatch.

10b. **Collect and parse results per wave:** When wave subagents return:
     - Extract ---EXEC-SUMMARY--- from each
     - Group by result: SUCCESS plans, non-SUCCESS plans
     - Collect worktree paths and branch names from Agent tool results

11b. **Merge worktree branches** into current branch (in plan-ID order):
     ```bash
     git merge {worktree_branch} -m "merge: plan {id} (group {G} parallel)"
     git worktree remove {worktree_path} 2>/dev/null
     git branch -d {worktree_branch} 2>/dev/null
     ```
     Clean merges are guaranteed by file isolation. If any merge fails:
     STOP, report overlap violation to user.

     **Post-merge build gate (for worktree executions only):**
     After ALL worktree branches in a wave are merged, run a single build check:
     ```bash
     # TypeScript projects:
     npx tsc --noEmit 2>&1 | tail -20
     # Or project-specific build command from CLAUDE.md
     ```
     This catches cross-plan type errors that individual worktrees couldn't detect.
     If build fails: identify which plan's files caused the error, report to user.
     Individual worktree exec reports should NOT be penalized for sibling build failures.

12b. **Triage non-SUCCESS plans:** For plans with PARTIAL/BLOCKED/NEEDS_DECISION,
     handle each sequentially using apply-phase `triage_issues` logic.
     Fix attempts operate on the merged branch (not worktrees).

12b. **JUDGE all plans (batched):**
     a. determine_judge_mode for each plan (from per-plan execution memo)
     b. structural_integrity_check for all plans in one pass:
        `git diff --name-only {baseline}..HEAD` once, then partition files by plan's
        file_lists. Flag per-plan boundary/scope violations.
     c. **Batch verification dispatch:** Group all plans by judge mode:
        - FAST/LIGHT plans: verify inline, all at once (run their verify commands)
        - MEDIUM/FULL plans: dispatch ALL verification subagents in parallel
          (one per plan, single message with parallel Agent calls)
        - FULL plans additionally: dispatch ALL review subagents in parallel
          (same single message if possible, otherwise second batch)
        This converts N sequential JUDGE cycles into 1-2 parallel batches.
     d. Parse all verdicts, run verdict logic per plan
     e. append_completion per plan (can be done in a single pass)
     f. **Batch bookkeeping:** Mark ALL plans complete in PLAN-GRAPH.md with a
        single Edit (update all Status cells at once). Batch all discovery
        propagations into one pass.

13b. **Single state update for all plans:** One BATCH_STATE_UPDATES Write covering
     all completed plans. Remove `## Execution Baseline` section. Update progress.
     Prune any gotchas that expired with these plans.

15b. **Status:**
     ```
     Group {G}: {N} plans ({W} waves) — {success_count} SUCCESS. Progress: {completed}/{total}.
     ```

16b. **Route:** check_phase_completion for next group or execute_transition.

---

**Rules:**
- In graph mode: plans are pre-written (no planning step needed). Go straight to APPLY.
- In sequential mode: always single-plan (no graph, no parallelism). Go to APPLY.
- The loop runs until: phase complete, STOP signal, or `pause_before` checkpoint.
- Auto-compaction handles context window management. No context checks needed.
- Maximum 3 parallel execution subagents. If group has 4+, split into sub-batches of 3.
</step>

<step name="execute_transition" priority="required" gate="blocking">
**If last plan in phase — TRANSITION IS MANDATORY:**

```
PHASE {N} COMPLETE — running transition...
```

**MUST read and execute:** @~/.claude/smike/workflows/transition-phase.md

Transition handles: ROADMAP update, git commit, scope audit, routing.
</step>

</process>

<output>
- Verification: inline (FAST/LIGHT), verification subagent only (MEDIUM), or verification + review (FULL)
- Full reports on disk (*-VERDICT.md, *-REVIEW.md); orchestrator uses compact summaries
- Completion block appended to PLAN.md (with review findings when available)
- STATE.md updated (single write per cycle)
- Auto-continues to next plan (single) or dispatches parallel group (2+ plans in same group, worktree-isolated)
- Stops only for: `pause_before` checkpoint on next plan, phase transitions with scope gaps, HIGH severity review issues, verification failures after 2 fix attempts, .smike/{project_name}/STOP file signal, worktree merge conflict (file overlap violation)
</output>

<error_handling>
**Subagent fails:** Treat as CONCERNS, log error, continue with available data.
**Write failure (---ERROR--- block):** Subagent failed to write report to disk. Check the error reason. Treat as CONCERNS.
**All verifications fail:** Present to user with rollback option.
</error_handling>
</output>
