<context_management>

## Purpose

Strategies for working effectively across long SMIKE sessions. The orchestrator runs
continuously — auto-compaction handles context window limits. All critical state lives
on disk. These principles ensure the system stays grounded.

## Core Principle: Disk Is Truth

The orchestrator's in-memory state may be summarized by auto-compaction at any time.
This is fine. All critical state is persisted to disk:

| State | File | Survives Compaction |
|-------|------|---------------------|
| Current position | STATE.md | Yes |
| Plan graph + status | PLAN-GRAPH.md | Yes |
| Execution baseline | STATE.md `## Execution Baseline` | Yes |
| Plan completion | Completion blocks on PLAN.md | Yes |
| Execution reports | `{plan}-EXEC-REPORT.md` | Yes |
| Verification verdicts | `{plan}-VERDICT.md` | Yes |
| Code reviews | `{plan}-REVIEW.md` | Yes |
| Fix reports | `{plan}-FIX-REPORT.md` | Yes |
| Gotchas | STATE.md `## Gotchas` | Yes |
| Discovery propagation log | STATE.md `## Propagated Discoveries` | Yes |
| Session info | STATE.md `## Session Continuity` | Yes |

**Rule:** At every cycle boundary (start of APPLY, start of auto_continue), re-read
STATE.md and PLAN-GRAPH.md. Do not rely on in-memory state from previous cycles.

## Auto-Compaction

Claude Code auto-compacts at ~80-85% context utilization. After compaction:
- System prompt (CLAUDE.md, rules, skills) is preserved verbatim
- Conversation history is summarized
- Recent messages are preserved verbatim

The orchestrator does NOT know when compaction happens. It cannot measure its own
token usage. Any attempt to estimate context percentage is unreliable guessing.

**Therefore:** No context brackets. No context checks. No handoff triggers based on
estimated usage. The orchestrator just runs. Auto-compaction and disk-grounded
re-orientation handle the rest.

## Lean Injection Principles

These apply to ALL agents (orchestrator and subagents):

### Load What You Need
```markdown
<!-- GOOD: Targeted loading -->
Read STATE.md, then the specific PLAN.md being executed.

<!-- BAD: Kitchen sink -->
Read PROJECT.md, ROADMAP.md, STATE.md, all PLAN.md files, and 5 source files
"just in case."
```

### Completion Blocks Before Full Plans
When referencing prior work, read the completion block at the bottom of the PLAN.md
(result, deviations, gotchas) — not the full plan. The completion block captures what
was built. The full plan captures what was intended. After completion, the block is
more useful and far cheaper.

### Progressive Detail
Start with high-level, drill down only when needed:

1. Read STATE.md (current position)
2. Read completion block of relevant PLAN.md (what was built)
3. Read specific source files (implementation details)

Don't load implementation details until you need them.

## Subagent Disk Write Pattern

Subagents in the implementation loop (execution, verification, review, fix) write their
full structured reports to disk and return only compact summaries to the orchestrator.
This mirrors the detailer write-to-disk-return-summary pattern from init.

### How It Works

1. The orchestrator passes a report path (`{report_path}`, `{verdict_path}`, `{review_path}`)
   to each subagent as a placeholder in the prompt.
2. The subagent writes its full structured report to that path using the Write tool.
3. The subagent verifies the write succeeded with `test -s "{path}"`.
4. The subagent returns only a compact summary block to the orchestrator.
5. The orchestrator routes based on the summary's result field.
6. The orchestrator reads the full report from disk ONLY on failure paths.

### Report Files

All report files live in `.smike/{project_name}/phases/{phase}/` alongside the PLAN.md.

| Agent | Report File | Summary Block | On-Disk Format |
|-------|------------|---------------|----------------|
| Execution | `{plan}-EXEC-REPORT.md` | `---EXEC-SUMMARY---` | `---REPORT---` |
| Verification | `{plan}-VERDICT.md` | `---VERIFY-SUMMARY---` | `---VERDICT---` |
| Review | `{plan}-REVIEW.md` | `---REVIEW-SUMMARY---` | `---REVIEW---` |
| Fix | `{plan}-FIX-REPORT.md` | `---FIX-SUMMARY---` | `---REPORT---` |

### When Full Reports Are Read From Disk

The common path (SUCCESS + CLEAN) stays lean — the orchestrator never reads full reports.

| Condition | Action |
|-----------|--------|
| SUCCESS + CLEAN/no review | Summary only — zero disk reads |
| PARTIAL / NEEDS_DECISION / BLOCKED | Read exec report for triage |
| Verification CONCERNS | Summary sufficient — no disk read needed |
| Verification FAIL | Read verdict for fix dispatch details |
| Review CONCERNS | Summary sufficient — details on disk if needed later |
| Review ISSUES (HIGH) | Read review for user presentation |
| Review DRIFT: YES | Read review for drift explanation |
| Fix needed | Read relevant report for problem details |

### Pattern Origin

This pattern was established by the detailer agent in init-project.md. Detailers write
full PLAN.md files to disk and return only compact ---SUMMARY--- blocks. The orchestrator
never holds full plan text. The implementation loop now follows the same principle for
all subagent outputs.

### Why This Matters

Each subagent report is 40-80 lines of structured text. In a 5-plan phase with FULL
JUDGE mode, the orchestrator would accumulate ~5 execution reports + ~5 verdicts +
~5 reviews = ~600-1200 lines of report text in its conversation. With this pattern,
the common path accumulates only ~5 lines per report (the summary), and full reports
are read only when needed for failure triage.

## Mechanical Extraction Pattern

The orchestrator avoids reading full PLAN.md files by using targeted bash extraction
for the specific metadata it needs:

```bash
# Frontmatter (depends_on, pause_before)
sed -n '1,/^---$/{ /^---$/,/^---$/p }' "${plan_path}" | head -20

# Task file lists — handles both indented and flush formats
sed -n '/<files>/,/<\/files>/p' "${plan_path}"

# Boundaries
sed -n '/<boundaries>/,/<\/boundaries>/p' "${plan_path}"

# AC names
grep -E '## AC-' "${plan_path}"

# Task count — matches both <task> and <task type="auto">
grep -c '<task[ >]' "${plan_path}" 2>/dev/null || echo 0

# TDD presence
grep -c '<test>' "${plan_path}" 2>/dev/null || echo 0

# Verification command count
sed -n '/<verification>/,/<\/verification>/p' "${plan_path}" | grep -c '^- \[' 2>/dev/null || echo 0
```

**When to use:** APPLY's `load_plan`, JUDGE's `structural_integrity_check`, and any
step that needs plan metadata for routing (not full plan content for understanding).

**When NOT to use:** Subagents that need to understand and execute the plan. They read
the full file in fresh context — that's their job.

### Discovery Propagation via Bash

Instead of reading full future PLAN.md files to inject discovery notes, use bash sed:

```bash
# Dedup check
grep -q "plan-${source_id}.*${target_id}.*${file}" ".smike/${project}/STATE.md" && echo "SKIP" || echo "NEW"

# Inject into target plan
target_plan=".smike/${project}/phases/{phase}/{target}-PLAN.md"
grep -q "## Discovery Notes" "${target_plan}" && {
  sed -i '' '/## Discovery Notes/a\
- [plan-'"${source_id}"'] '"${description}"'' "${target_plan}"
} || {
  sed -i '' 's|</context>|## Discovery Notes\
- [plan-'"${source_id}"'] '"${description}"'\
</context>|' "${target_plan}"
}
```

This keeps future plan content entirely out of orchestrator memory.

## Plan Sizing

Plans should be small enough for a single execution subagent to handle in fresh context:

- **2-3 tasks per plan** (hard limit)
- **Target ~50% of subagent context** per plan execution
- Single concern per plan — don't mix unrelated subsystems

This sizing is about subagent quality, not orchestrator limits. Each subagent
gets fresh 200k context. A plan that burns 80% of that context will produce
lower-quality output in the final tasks.

## Avoiding Reflexive Chaining

**Anti-pattern: Reflexive chain**
```yaml
# Plan 01-01
depends_on: []

# Plan 01-02
depends_on: ["01-01"]  # Does 02 actually need 01's output?

# Plan 01-03
depends_on: ["01-02"]  # Does 03 actually need 02's output?
```

This creates false sequential execution. Trace actual imports/calls.

**Pattern: Genuine dependencies only**
```yaml
# Plan 01-01: Create User model
depends_on: []

# Plan 01-02: Create Product model
depends_on: []  # Independent! Can parallelize.

# Plan 01-03: Create Order model (references User and Product)
depends_on: ["01-01", "01-02"]  # Genuine: imports types from both
```

## Operator-Controlled Pauses

The orchestrator runs continuously unless explicitly stopped:

| Mechanism | When to Use |
|-----------|-------------|
| `pause_before: true` in plan frontmatter | Set during init — "I want to do manual work before this plan" |
| `.smike/{project_name}/STOP` file | Runtime kill switch — create this file to stop after current cycle |
| `/smike:pause` | Manual pause with handoff creation |

No automatic pauses based on context estimates. The operator decides when to stop.

## Session Handoffs

When the operator manually pauses (via STOP file or /smike:pause):

### STATE.md Session Continuity
Always updated. Minimal but sufficient for quick resume:

```markdown
## Session Continuity
Last session: 2026-01-28 11:15
Stopped at: Phase 3, Plan 01, Task 2 complete
Next action: Execute group 1
```

### HANDOFF.md Document
For longer breaks. Created by `/smike:pause`:

- Self-contained entry point (assumes no prior context)
- What was accomplished this session
- What's in progress
- Key decisions made
- Current blockers
- Exact next action

## Discovery Propagation Tracking

When execution or verification discovers something that affects a future plan,
the orchestrator injects it into that plan's `<context>` section via bash sed
(see Mechanical Extraction Pattern above). This injection modifies the file on disk
but the action itself lives in conversation history — which auto-compaction may
summarize away.

**Problem:** After compaction, the orchestrator might not remember what it propagated
and could propagate the same discovery again, creating duplicates.

**Solution:** STATE.md `## Propagated Discoveries` logs every propagation:

```markdown
## Propagated Discoveries
- [plan-01-01 → plan-01-03] webhook_types.ts: WebhookEvent union type changed
- [plan-01-01 → plan-01-04] enrollment.ts: stage enum values updated
- [plan-01-02 → plan-01-04] cli_args.ts: --format flag added (review finding)
```

**Rules:**
- Before propagating any discovery, check this section for duplicates (same source + target + file)
- After propagating, add an entry in the same BATCH_STATE_UPDATES Write call
- The re-orient step at cycle boundaries reads this section to prime dedup awareness
- Entries are never deleted — they serve as an audit trail across the full phase

**Why this works:** The dedup check is on disk (survives compaction). The propagated
content is on disk (in future PLAN.md files, survives compaction). The log connects
the two. Even if compaction summarizes away "what was propagated where," the next
re-orient reads the log and knows exactly what's been done.

## Write-Then-Summarize Pattern

After completing a major write (completion block, state update, discovery propagation),
store only a one-line summary in working memory. Do NOT carry the full text through
auto_continue cycles:

```
Plan 01-02: PASS — webhook handler + enrollment stages, no deviations
```

All detail lives on disk (PLAN.md completion block, report files, LOG.md). The orchestrator
references by path + summary. This keeps conversation lean through multi-plan sessions
and gives auto-compaction less to summarize when it fires.

## Anti-Patterns

**Guessing context percentage:**
The model cannot measure its own token usage. Any bracket system based on
"I think I'm at 40%" is unreliable. Don't do it.

**Loading everything "just in case":**
Wastes subagent context on unused content. Load targeted files only.

**Loading full subagent reports when only the result matters:**
On the SUCCESS + CLEAN path, the orchestrator only needs the result field
(PASS/SUCCESS), task outcomes, and file lists — all available in compact summaries.
Reading the full report from disk to "double-check" wastes context. Trust the
summary for routing; read full reports only for failure triage, fix dispatch,
or detailed completion blocks.

**Stopping preemptively:**
The orchestrator's work is procedural routing — it holds up fine through
compaction. Let it run. Stop only when the operator says so.

**"Freeing memory" by writing to disk:**
LLM conversation context is append-only — you cannot free tokens by writing plan
contents to a file. The text stays in the conversation history forever. What you
CAN do is avoid re-loading and re-quoting content that's already on disk. After
writing plans to disk, reference them ONLY by file path and summary. Do NOT
re-read or quote plan contents in subsequent orchestrator steps. Subagents read
plan files in their own fresh context — the orchestrator doesn't need the full text.

</context_management>
