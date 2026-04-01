<purpose>
Execute an approved PLAN.md by dispatching subagent(s) with fresh context. The orchestrator validates, assesses parallelism, dispatches, parses results, verifies via git, and auto-continues to JUDGE.
</purpose>

<when_to_use>
- User has approved a PLAN.md (explicit approval required)
- STATE.md shows ready for APPLY
</when_to_use>

<loop_context>
Expected phase: APPLY
Prior phase: PLAN (approval just received)
Next phase: JUDGE (auto-continues after execution)
</loop_context>

<required_reading>
@.smike/{project_name}/STATE.md
@.smike/{project_name}/phases/{phase}/{plan}-PLAN.md

Note: `{project_name}` is passed from the resume workflow or the previous
workflow step. All `.smike/` paths in this workflow are relative to `.smike/{project_name}/`.
</required_reading>

<logging>
**Subagent-owned logging.** Each subagent writes its own LOG.md entry.
The orchestrator passes `{log_path}` (or "DISABLED") to each subagent prompt.
The orchestrator does NOT read or append to LOG.md.
</logging>

<process>

<rule name="ASKUSER_FALLBACK" priority="critical">
**AskUserQuestion fallback protocol** — use this EVERY time this workflow calls AskUserQuestion:

AskUserQuestion may silently auto-complete with empty answers during skill/command
invocations. The interactive picker never renders to the user.

Detection: after AskUserQuestion returns, check the result string for answer content.
A successful response contains `"header"="answer"` patterns (e.g., `"Action"="Fix"`).
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
triage_issues (ambiguous failures), handle_fix (user-directed fix), and
check_prior_attempt (partially done task decisions).
</rule>

<rule name="BATCH_STATE_UPDATES" priority="critical">
Never make multiple separate Edit calls to STATE.md. Always: Read → modify all sections → single Write.
This applies to every step that touches STATE.md. Violation of this rule wastes 3-4 tool calls per transition.
</rule>

<rule name="RETRY_BUDGETS" priority="critical">
Track dispatch counts per plan with independent budgets per failure category:

- `execution_dispatches`: 1 (the initial dispatch — never re-dispatch the full plan)
- `fix_dispatches`: max 1 per issue (straightforward auto-fix OR user-directed, not both in sequence)
- `verification_retries`: max 1 (re-verify after a fix, not after unchanged state)

Total subagent dispatches per APPLY→JUDGE cycle: capped at 4
(1 execution + 1 fix + 1 verification + 1 review).

If a fix fails: escalate to user immediately. Do not retry with variations.
Separate counters mean a fix failure does NOT consume a verification retry.
</rule>

<step name="re_orient" priority="first">
**Re-ground from disk at the start of every cycle.**
Auto-compaction may have summarized prior context. Disk state is always authoritative.

1. Read STATE.md — extract current position and next plan.
2. Read PLAN-GRAPH.md — extract plan statuses and next eligible plan.
3. Read `## Propagated Discoveries` from STATE.md (if present) — note what's already
   been propagated to avoid duplicates during this cycle's triage/discovery steps.
4. **Reconciliation:** If STATE.md position and PLAN-GRAPH.md status conflict
   (e.g., STATE says plan X is next but PLAN-GRAPH shows it complete):
   - Trust PLAN-GRAPH.md (it has per-plan completion status, updated by JUDGE).
   - Update STATE.md to match PLAN-GRAPH.md truth.
   - Log: "STATE.md reconciled with PLAN-GRAPH.md — was {old}, now {new}."

Do not rely on in-memory state from previous cycles.
</step>

<step name="validate_approval">
1. If auto-continued from init or judge auto_continue: approval is implicit. Skip.
2. If invoked directly (e.g., via /smike:judge recovery):
   - Look for explicit approval signal in user message: "approved", "execute", "go ahead", etc.
   - If unclear: "Plan ready at [path]. Approve execution?"
</step>

<step name="load_plan">
**Extract structured metadata from PLAN.md using mechanical bash extraction.**
Do NOT read the full file into orchestrator memory — the execution agent reads
it in fresh context. The orchestrator only needs routing metadata.

```bash
plan_path=".smike/{project_name}/phases/{phase}/{plan}-PLAN.md"

# Extract frontmatter (depends_on, pause_before, etc.)
sed -n '1,/^---$/{ /^---$/,/^---$/p }' "${plan_path}" | head -20

# Extract task file lists (for preflight + parallelism assessment)
# Handles both indented (  <files>) and flush (<files>) formats
sed -n '/<files>/,/<\/files>/p' "${plan_path}"

# Extract boundary file lists (for structural integrity check in JUDGE)
sed -n '/<boundaries>/,/<\/boundaries>/p' "${plan_path}"

# Extract AC names (for execution memo)
grep -E '## AC-' "${plan_path}"

# Count tasks (for parallelism + judge mode)
# Matches both <task> and <task type="auto">
grep -c '<task[ >]' "${plan_path}" 2>/dev/null || echo 0

# Check for TDD (for judge mode)
grep -c '<test>' "${plan_path}" 2>/dev/null || echo 0

# Count verification commands (for judge mode)
sed -n '/<verification>/,/<\/verification>/p' "${plan_path}" | grep -c '^- \[' 2>/dev/null || echo 0
```

Parse results and store: plan_path, depends_on, task_count, tdd_present,
verify_cmd_count, file_lists (per task), boundary_files, ac_names.

Plans are fully autonomous — no checkpoint handling needed.
</step>

<step name="preflight_check">
**Mechanical validation before dispatching subagent — no agent, ~5 seconds.**

Catches issues that would immediately fail the execution subagent. Cheap to run,
expensive to miss.

1. **File existence:** For each `<files>` entry across all tasks:
   ```bash
   # For files that should exist (not new files being created):
   # Check if parent directory exists — new files are expected, missing dirs are not
   for file in {task_file_list}; do
     parent=$(dirname "$file")
     if [ ! -d "$parent" ] && [ "$parent" != "." ]; then
       echo "PREFLIGHT FAIL: directory $parent does not exist for $file"
     fi
   done
   ```
   Skip files whose `<action>` says "create" — those are expected to not exist yet.

2. **Dependency completion:** For each plan in `depends_on`:
   ```bash
   # Verify each dependency is marked complete in PLAN-GRAPH.md
   grep "{dep_plan_id}" .smike/{project_name}/PLAN-GRAPH.md | grep -q "complete"
   ```
   If any dependency is NOT complete: **STOP.** Do not dispatch. Report:
   "Plan {id} depends on {dep_id} which is not complete. Check PLAN-GRAPH.md."

3. **Verify commands parseable:** For each task's `<verify>` field:
   ```bash
   # Quick syntax check — just confirm the command parses
   bash -n <<< "{verify_command}" 2>&1
   ```
   If syntax error: warn (soft signal, don't block — verify commands sometimes
   reference files that don't exist yet).

**On PREFLIGHT FAIL (hard):** Do not dispatch. Report the failure and stop.
**On warnings (soft):** Log and proceed — execution subagent may handle them.
</step>

<step name="capture_baseline">
1. Record current git HEAD: `git rev-parse HEAD`
2. Check STATE.md for an existing `## Execution Baseline` section:
   - **If exists AND plan matches current plan:** a prior session was interrupted mid-execution.
     Use the STORED baseline (not current HEAD). Proceed to check_prior_attempt.
   - **If exists but plan differs:** stale baseline from a different plan. Overwrite with current.
   - **If not exists:** fresh execution. Write new baseline.
3. Write/update baseline in STATE.md (single Write with other state changes):
   ```markdown
   ## Execution Baseline
   Plan: {plan-id}
   Commit: {baseline_hash}
   ```
4. On JUDGE completion, the `update_state` step removes the Execution Baseline section
   (it's only needed during an active APPLY→JUDGE cycle).
</step>

<step name="check_prior_attempt" priority="critical">
**Check for partial work from a prior interrupted execution.**

Uses the baseline from STATE.md (which survives session death), NOT current HEAD.

1. Run: `git log --oneline {baseline}..HEAD`
2. Cross-reference committed files against each task's `<files>` list
3. Route:
   - **All tasks done:** skip execution, go to verify_execution
   - **Some done, some not:** tell subagent which are done, execute only remaining
   - **Partially done task:** ask user — reset to baseline (recommended) or continue from partial
   - **No commits:** clean slate, proceed normally
</step>


<step name="assess_parallelism">
**Determine whether tasks can run in parallel.**

Default: sequential (one subagent). Only parallelize when ALL conditions met:

1. Plan has 2-3 tasks (single-task plans are always sequential)
2. Zero file overlap: no `<files>` entries intersect between tasks
3. Different subsystems: tasks are in different packages or directories
4. No dependency: no task references another task's output
5. No TDD tasks: red-green cycle is inherently sequential

**If ALL conditions met:**
- Log: "Tasks are independent — dispatching {N} parallel subagents."
- Dispatch each task as a separate subagent (see dispatch_parallel)

**Otherwise:**
- Sequential dispatch (see dispatch_subagent)
- **Silent.** Do not report the parallelism assessment. Proceed without comment.

**Never more than 3 parallel subagents.** If plan has 3 tasks and
conditions are met, 3 is fine. This is the ceiling.

**Subagent suitability criteria** (from subagent-criteria):
- Self-contained: work doesn't require iterative human feedback
- Clear scope: inputs/outputs well-defined, low ambiguity
- Complexity sweet spot: 2-3 well-defined tasks, 15-60 min of work, clear verification
</step>

<step name="dispatch_execution">
**Prompt template:** Read `~/.claude/smike/prompts/execution-agent.md`
Fill placeholders: {PLAN.md file path}, {log_path}, {report_path}.
Pass the FILE PATH, not the file contents. Subagent reads it in fresh context.
**log_path:** `.smike/{project_name}/phases/{phase}/{plan}-LOG.md` if logging enabled, else "DISABLED".
**report_path:** `.smike/{project_name}/phases/{phase}/{plan}-EXEC-REPORT.md`

**Sequential (default):** One subagent, full plan.
- subagent_type: "general-purpose", model: inherit, description: "Execute plan {NN}-{name}"

**Parallel (if assess_parallelism passed):** One subagent per task.
- Same template, but include only that task's `<task>` block + relevant ACs + full boundaries
- Each task gets its own report_path: `{plan}-task{N}-EXEC-REPORT.md`
- Dispatch all simultaneously using parallel Agent tool calls
</step>

<step name="parse_result">
When subagent(s) return:

**Sequential:** Parse the compact ---EXEC-SUMMARY--- block.
- Extract: result, tasks, commits, files_changed, tests_written, issues, has_discovery, path
- On SUCCESS with no discovery: summary is sufficient for all downstream steps.
- On PARTIAL/NEEDS_DECISION/BLOCKED or has_discovery=true: read full report from disk
  for triage classification:
  ```bash
  cat "{report_path}"
  ```

**Parallel:** Merge summaries from all subagents into one combined summary:
- result: SUCCESS only if ALL subagents returned SUCCESS
- tasks: combine all task results
- commits: sum all commit counts
- files_changed: combine all file lists
- tests_written: sum all test counts
- issues: combine
- has_discovery: true if ANY subagent has has_discovery: true

Only read full reports from disk for subagents that returned non-SUCCESS:
```bash
cat "{task_N_report_path}"
```

If any return is malformed (no ---EXEC-SUMMARY--- found, or ---ERROR--- block):
treat as BLOCKED for that task, log raw output.
</step>

<step name="verify_execution">
After parsing:

1. **Git verification:**
   - `git log --oneline {baseline}..HEAD` — confirm commits exist
   - `git diff --stat {baseline}..HEAD` — confirm files actually changed
   - Cross-reference with files_changed from summary

2. **Result routing:**

   **SUCCESS:** All tasks passed
   - Full report is on disk at {report_path} — no in-memory storage needed
   - Proceed to finalize → JUDGE

   **PARTIAL:** Some tasks passed, some failed
   - Proceed to triage_issues

   **NEEDS_DECISION:** Subagent found an out-of-scope issue
   - Proceed to triage_issues

   **BLOCKED:** Cannot proceed at all
   - Proceed to triage_issues

   For PARTIAL/NEEDS_DECISION/BLOCKED, the orchestrator also has a
   **rollback** option available (see triage_issues).
</step>

<step name="triage_issues">
**Read full execution report from disk for triage classification.**
This is the ONLY step that needs the full report. Extract BLOCKERS and DISCOVERY.
```bash
cat "{report_path}"
```

**Classify each issue from BLOCKERS/DISCOVERY before involving user.**

**Straightforward (auto-fix, no user prompt):**
Missing import, typo, type mismatch, test assertion update, small boundary change.
Rule: you can write the fix prompt in 2-3 sentences with no "or" clauses.
→ Dispatch fix subagent directly.

**Ambiguous (escalate to user):**
Multiple valid approaches, schema change, security-sensitive, contradicts docs.
→ Present options from DISCOVERY + these choices:
- Fix → dispatch fix subagent with user's direction
- Skip → continue to JUDGE with partial status
- Rollback → `git reset --soft {baseline}`, update STATE.md to re-queue plan
- Abort → keep commits, stop
- Re-plan → **LAST RESORT.** Only offer when the plan's approach is fundamentally wrong
  (not a bug, but the wrong strategy — assumed code structure that doesn't exist,
  AC was misspecified, etc.). Rollback to baseline, re-dispatch detailer with failure
  context injected into the plan outline, write updated PLAN.md, then re-enter APPLY.
  This resets the plan's retry budgets. If re-plan is chosen:
  1. `git reset --soft {baseline}`
  2. Read `~/.claude/smike/prompts/detailer-agent.md`
  3. Fill placeholders with original outline + failure context as `{prior_context}`:
     ```
     PRIOR ATTEMPT FAILED:
     Result: {execution result}
     Reason: {user's description or BLOCKERS summary}
     Files changed before rollback: {file list}
     What didn't work: {one-line per failed task}
     ```
  4. Dispatch detailer subagent, write updated PLAN.md to disk
  5. Reset retry budgets, re-enter APPLY from re_orient step

**Discovery propagation to downstream plans (via bash — no full file reads):**
For each DISCOVERY item with `affected_files` or `affected_types`:
1. **Dedup check against STATE.md:**
   ```bash
   grep -q "plan-${source_id}.*${target_id}.*${file}" ".smike/${project_name}/STATE.md" && echo "SKIP" || echo "NEW"
   ```
   If already listed, skip. Prevents duplicate propagation after auto-compaction.
2. Look up the owning plan in PLAN-GRAPH.md's Plan Index
3. If the file belongs to a FUTURE pending plan → inject discovery note via bash:
   ```bash
   target_plan=".smike/${project_name}/phases/{phase}/{target_plan}-PLAN.md"
   # Check if Discovery Notes heading already exists
   grep -q "## Discovery Notes" "${target_plan}" && {
     # Append to existing section
     sed -i '' '/## Discovery Notes/a\
- [plan-'"${source_id}"'] '"${file}"': '"${description}"'' "${target_plan}"
   } || {
     # Create section before </context> closing tag
     sed -i '' 's|</context>|## Discovery Notes\
- [plan-'"${source_id}"'] '"${file}"': '"${description}"'\
</context>|' "${target_plan}"
   }
   ```
   This keeps future plan content entirely out of orchestrator memory.
4. If the discovery implies a new dependency → update PLAN-GRAPH.md Plan Index table
5. For `affected_types`: grep future PLAN.md `<files>` sections for the type name:
   ```bash
   grep -l "${type_name}" .smike/${project_name}/phases/**/*-PLAN.md
   ```
   Fold note into matching plans via the same bash injection.
6. **Log propagation to STATE.md** — add entry to `## Propagated Discoveries`:
   ```markdown
   - [plan-{source} → plan-{target}] {file}: {description}
   ```
   Include this in the next BATCH_STATE_UPDATES Write call (do not write separately).
</step>

<step name="handle_fix">
For straightforward fixes (auto-dispatched) or user-directed fixes:

1. Read `~/.claude/smike/prompts/fix-agent.md`
   Fill placeholders: {problem}, {direction}, {task XML}, {BLOCKERS}, {boundaries},
   {log_path}, {report_path}, {review_items}: "None".
   **report_path:** `.smike/{project_name}/phases/{phase}/{plan}-FIX-REPORT.md`
   Dispatch as Agent prompt.

2. Parse compact ---FIX-SUMMARY--- (same pattern as parse_result).
   On SUCCESS: summary is enough — merge fix result with original exec summary.
   On PARTIAL/BLOCKED: read full fix report from disk:
   ```bash
   cat "{fix_report_path}"
   ```

3. If fix succeeds: merge into original summary, continue to JUDGE
4. If fix fails: escalate to user immediately (see RETRY_BUDGETS rule).
   Do not re-dispatch fix with variations — present the failure and offer:
   - User-directed fix → dispatch ONE more fix with user's specific direction
   - Skip → continue to JUDGE with partial status
   - Rollback → `git reset --soft {baseline}`, re-queue plan
</step>

<step name="finalize">
**Derive execution memo from the compact summary and hand off to JUDGE.**

Do NOT write STATE.md — JUDGE handles that.

**1. Create execution memo from summary fields** — this is ALL that JUDGE receives:

The ---EXEC-SUMMARY--- already contains result, tasks, commits, files_changed, issues.
Construct the memo directly:

```
EXECUTION MEMO:
Result: {from summary result}
Baseline: {baseline_commit_hash}
Tasks: {from summary tasks}
Files changed: {from summary files_changed}
Issues: {from summary issues}
Has discovery: {from summary has_discovery}
Task count: {from load_plan extraction}
TDD present: {from load_plan extraction}
Verify cmd count: {from load_plan extraction}
Full report: {report_path}
```

The full report is on disk at {report_path}. The verification subagent verifies
independently from git diff and tests. The review subagent reads git diff directly.
Neither needs the full execution report.

**2. If logging enabled**, append execution summary to `.smike/{project_name}/phases/{phase}/{plan}-LOG.md`:
```markdown
### execution_summary — {timestamp}
Result: {result} | Tasks: {task summary} | Commits: {count}
Full report: {report_path}
```
(The full report is already on disk — no need to duplicate it into the log.)

**3. Per-plan deploy (if configured):**
Read `config.md`. If `deploy: per_plan` AND `deploy_commands` is non-empty AND
result is SUCCESS, run deploy commands now. If deploy fails, note in execution
memo but do NOT block JUDGE. Skip for `batch` or `manual`.

**4. Auto-continue to JUDGE:** Read @~/.claude/smike/workflows/judge-phase.md
with Read tool and follow its instructions. Pass execution memo + baseline only.
Do NOT use the Skill tool — JUDGE is an internal workflow, not a registered skill.
</step>

</process>

<output>
- Modified files as specified in PLAN.md (via subagent)
- Per-task git commits from subagent
- Tests written for tasks with <test> fields
- Execution summary parsed and verified; full report on disk
- Auto-continues to JUDGE (no user prompt) — JUDGE handles STATE.md write
</output>

<error_handling>
**Boundary violation in subagent:** Caught during verify_execution via git diff review. Report to user.
**Subagent timeout/crash:** Treat as BLOCKED. Check git log for any partial commits. Report to user.
**Plan not found:** Check STATE.md, ask user to confirm location.
**Malformed summary:** Log raw subagent output, treat as BLOCKED, ask user to review.
**Write failure (---ERROR--- block):** Subagent failed to write report to disk. Check the error reason. Report to user.
**Parallel merge conflict:** If parallel subagents created conflicting changes, treat as BLOCKED. This shouldn't happen if parallelism conditions were correctly assessed.
</error_handling>
</output>
