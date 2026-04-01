<purpose>
Initialize SMIKE from user-provided spec and reference files. Reads all files, asks
clarifying questions, dispatches the planning agent to decompose into an executable
plan graph, creates all project state, and STOPS. Execution begins in a fresh session
via `/smike:resume` to maximize context budget.

Supports both fresh initialization and revision of existing plans.
</purpose>

<rules>
Never override model for REASONING subagents (strategist, detailer, checker, scope auditor).
These require full model capability. Mechanical validation steps (dry_run_validation,
export_cross_validation, graph_validation) run inline — no subagent needed, no model choice.

Never call AskUserQuestion from within a subagent. Subagents emit structured
ESCALATION/QUESTIONS blocks. The orchestrator (this workflow) is the ONLY layer
that calls AskUserQuestion.

**AskUserQuestion fallback protocol** — use this EVERY time this workflow calls AskUserQuestion:

AskUserQuestion may silently auto-complete with empty answers during skill/command
invocations (e.g., `/smike:init`). The interactive picker never renders to the user.

Detection: after AskUserQuestion returns, check the result string for answer content.
A successful response contains `"header"="answer"` patterns (e.g., `"Auth method"="Yes"`).
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
resolve_project, load_previous_state, relay_questions, stage3 scope gaps,
stage3 checker escalations, and export_cross_validation.
</rules>

<when_to_use>
- Starting SMIKE on a new spec
- Revising an existing SMIKE project (user wants to modify the plan graph)
- User provides one or more files: primary spec + optional reference docs
</when_to_use>

<process>

<step name="resolve_project" priority="first">
**Derive project name and detect existing projects.**

1. Parse $ARGUMENTS as space-separated file paths.
2. The first argument is the primary spec file. Derive `project_name` from the spec
   filename by stripping the extension and any trailing `-spec` suffix:
   - `enrollment-agent-spec.md` → `enrollment-agent`
   - `dns-filtering.md` → `dns-filtering`
   - `my-feature.md` → `my-feature`

3. Check if `.smike/{project_name}/` already exists:
   ```bash
   ls .smike/{project_name}/STATE.md 2>/dev/null
   ```

4. **If exists:** Ask the user via AskUserQuestion:
   - "Found existing SMIKE project '{project_name}'. What would you like to do?"
   - Options:
     - "Revise existing plan" → set `revision_mode = true`, proceed to load_previous_state
     - "Start fresh (delete old)" → delete `.smike/{project_name}/`, set `revision_mode = false`

5. **If not exists:** set `revision_mode = false`, proceed to validate_files.

6. Store: `project_name`, `revision_mode`, `project_dir` = `.smike/{project_name}`
</step>

<step name="load_previous_state" condition="revision_mode == true">
**Load existing plan graph for revision.**

1. Read `.smike/{project_name}/PLAN-GRAPH.md` → store as `previous_graph`
2. Read all existing PLAN.md files from `.smike/{project_name}/phases/`
3. Ask the user via AskUserQuestion:
   - "What should change in this plan? (describe your critique)"
   - Free-text input (the "Other" option)
4. Store user's critique as `revision_critique`
5. Proceed to validate_files (spec file still needed for re-verification)
</step>

<step name="validate_files">
**Parse $ARGUMENTS as space-separated file paths. Validate only — do NOT read contents.**

1. Split $ARGUMENTS into individual paths.
2. For each path, verify it exists:
   ```bash
   ls "$path" 2>/dev/null
   ```
3. Store validated paths:
   - `spec_file_path` = first file (the primary spec)
   - `reference_file_paths` = remaining files (architecture docs, design docs)

4. If NO files provided or none found:
   - Ask: "Provide a path to your spec file, or describe what you want to build."
   - If user provides file path(s): validate them.
   - If user describes it inline: create project dir first (`mkdir -p .smike/{project_name}`),
     write to `.smike/{project_name}/INLINE-SPEC.md`, use that as spec_file_path.

**DO NOT read file contents into orchestrator memory.** The planning subagent reads
them in its own fresh context. The orchestrator only needs the paths.
</step>

<step name="gather_project_info">
**Collect minimal project metadata. Ask only what can't be inferred.**

1. Use `project_name` derived from spec filename.
2. Read FIRST 20 LINES of spec file to extract phase name and summary. Do NOT read the full file.
3. Read CLAUDE.md if it exists (for project context — stack, structure, constraints).
4. Store extra_context as empty string (populated after strategist if needed).
</step>

<step name="create_structure">
Create project directory:
```bash
mkdir -p .smike/{project_name}/phases
```
</step>

<step name="stage1_strategist">
**STAGE 1: Dispatch strategist to produce plan outlines + dependency graph.**

Read `~/.claude/smike/prompts/strategist-agent.md`.

Fill placeholders:
- {spec path}: spec_file_path
- {reference file paths}: reference_file_paths
- {prior context}: extra_context or "None"
- {tdd_default}: "true" (default for new projects; user can change in config.md after init)

**Revision mode:** If `revision_mode == true`, also fill:
- {previous_graph}: the previous ---STRATEGY--- output from `previous_graph`
- {critique}: `revision_critique` from user
- {gap_report}: scope gap report if this re-dispatch was triggered by scope auditor, else empty

**Fresh mode:** If `revision_mode == false`, omit the `<revision_input>` section entirely
from the strategist prompt. This saves ~20 lines of irrelevant context for fresh decompositions.

**Pass file PATHS only.** Strategist reads everything in its own fresh context.

Agent configuration:
- subagent_type: "general-purpose"
- model: inherit from session
- description: "Strategize plan decomposition"

Track dispatch counters separately — different failure modes, independent budgets:
- `strategist_validation_failures` (starts at 0, max 2) — graph_validation structural failures
- `strategist_scope_failures` (starts at 0, max 2) — SCOPE_GAP re-dispatches from auditor
Total dispatches capped at initial + 2 of each type = 5 absolute max.
Scope gap does NOT consume a validation retry and vice versa.
</step>

<step name="graph_validation">
**MECHANICAL VALIDATION — no agent needed.**

After strategist returns, before any further processing:

1. Extract the strategy between ---STRATEGY--- and ---END-STRATEGY---
2. Parse: graph (parallel groups), plan outlines, file_map, excluded_features, decomposition_checklist

3. **Checklist validation:**
   - Verify `decomposition_checklist` section is present in output
   - All 6 items must be checked ([x])
   - If missing or incomplete: re-dispatch strategist with instruction to complete checklist

4. **Reference integrity:**
   - Every `depends_on` value in every plan references an actual plan id in the graph
   - If broken reference found: fail with "Plan {id} depends_on '{ref}' which does not exist"

5. **DAG validity:**
   - Topological sort on the dependency graph must succeed (no cycles)
   - If cycle detected: fail with "Cycle detected: {plan_a} → {plan_b} → ... → {plan_a}"

6. **File isolation:**
   - No file path appears in 2+ plans within the same parallel group
   - If overlap found: fail with "File '{path}' in plans {id_a} and {id_b} (both group {G})"

7. **Group structure:**
   - Group N plans only depend on plans in groups < N
   - If violated: fail with "Plan {id} (group {G}) depends on plan {dep_id} (group {G2} ≥ {G})"

8. **On any failure:**
   - If `strategist_validation_failures < 2`: increment, re-dispatch strategist with
     failure report injected as prior_context. Log: "Graph validation failed — re-dispatching ({count}/2)"
   - If `strategist_validation_failures >= 2`: present failures to user, offer manual fix or abort.

9. **On success:** proceed to process_strategy
</step>

<step name="process_strategy">
When graph validation passes:

1. Store: `strategy` (the full parsed output), `plan_outlines` (list), `graph` (groups), `excluded_features`
2. Extract QUESTIONS from strategist output (between ---QUESTIONS--- and ---END-QUESTIONS---)
3. If excluded_features is non-empty:
   - Print: "⚠ {N} spec features excluded:"
   - List each with feature name + reason
   - Print: "Scope auditor will verify in Stage 3."
   - Do NOT block here — auditor catches gaps downstream.
4. If revision_mode: extract ---CHANGES--- block and display to user:
   ```
   Plan graph changes from previous version:
   - Plan 01: KEPT — no objections
   - Plan 05: REMOVED — tests folded into plans 01 and 02
   ```
5. Print brief status: `Strategy: {N} plans in {G} groups. Detailing...`
</step>

<step name="relay_questions">
If the strategist returned QUESTIONS (not "None"):
  1. Present each question to the user via AskUserQuestion.
  2. **Apply the AskUserQuestion fallback protocol** (see rules section):
     - Check result for actual answer content (`=` between quoted strings).
     - If empty: fall back to printed questions + wait for chat response.
  3. **Echo-back:** After receiving answers (from either path), explicitly state each
     selected option in extra_context. Format:
     ```
     Q: {question text}
     A: {selected option label or user's typed answer}
     ```
  4. Append all formatted Q&A pairs to extra_context.
  5. Pass extra_context to ALL detailers as additional context — not just the plan
     the question relates to. Every detailer should know about user decisions that
     affect cross-plan interfaces.

If no questions: proceed.
</step>

<step name="stage2_detailers">
**STAGE 2: Dispatch one detailer subagent per plan — in parallel where possible.**

Read `~/.claude/smike/prompts/detailer-agent.md`.

**Pre-dispatch:** Ensure phase directories exist for all plans before dispatching.
The `create_structure` step already ran `mkdir -p .smike/{project_name}/phases`, but
each plan needs its phase subdirectory:
```bash
# For each plan outline, ensure phase dir exists
mkdir -p .smike/{project_name}/phases/{phase}
```

**Revision mode optimization:** If `revision_mode == true`, only dispatch detailers
for plans marked as MODIFIED or NEW in the ---CHANGES--- block. Plans marked as KEPT
carry forward their existing PLAN.md files unchanged.

For EACH plan outline being detailed:
- Compute plan_path: `.smike/{project_name}/phases/{phase}/{plan}-PLAN.md`
- Fill placeholders:
  - {plan_path}: the computed plan_path (detailer writes PLAN.md directly to this path)
  - {plan_outline}: the specific plan's outline (id, title, goal, files, tasks, ac_sketch, tdd, depends_on)
  - {spec path}: spec_file_path
  - {reference file paths}: reference_file_paths
  - {project_gotchas}: the `gotchas` section from the strategist's output (verbatim).
    The detailer filters for relevance to its own files — pass all gotchas and let
    the detailer decide which to include in the plan's <context>.
  - {sibling_interfaces}: For each OTHER plan in plan_outlines, extract its
    `exports` field from the strategy. Format as:
      Plan {id} exports: {export line}
    Omit the current plan's own exports.
- Agent configuration:
  - subagent_type: "general-purpose"
  - model: inherit from session
  - description: "Detail plan {id}: {title}"

**Dispatch ALL detailers in parallel** using multiple Agent tool calls in a single message.
Each detailer has fresh context and reads only its assigned files.
**Detailers write PLAN.md to disk themselves** (via {plan_path}) and return only a
compact ---SUMMARY--- block. The orchestrator never receives full plan text.

**Why parallel is safe:** Each detailer owns different files (strategist enforced this).
No file overlap = no conflicts. Each produces one independent PLAN.md written to its
own unique path.
</step>

<step name="process_plans">
When ALL detailers return:

**Detailers already wrote PLAN.md files to disk.** The orchestrator receives only
compact ---SUMMARY--- blocks. Do NOT read full plan content into orchestrator memory.

1. Parse each detailer's ---SUMMARY--- / ---END-SUMMARY--- block and store the summary:
   ```
   Plan {id}: {title}
     Goal: {goal line}
     Files: {file list}
     AC count: {N}
     Task count: {N}
     Path: {plan_path from summary}
     Notes: {notes from summary}
   ```
   If a detailer returned ---ERROR--- instead of ---SUMMARY---, log the error and
   mark that plan for re-dispatch.

2. Validate each plan ON DISK (do not read plan content into orchestrator memory).
   Use bash grep/test commands to check structure mechanically:
   ```bash
   # Verify file exists and is non-empty
   test -s "{plan_path}" || echo "MISSING: {plan_path}"

   # Required sections present
   for section in objective context acceptance_criteria tasks boundaries verification; do
     grep -qc "<$section>" "{plan_path}" || echo "MISSING SECTION: <$section> in {plan_path}"
   done

   # Task count check
   task_count=$(grep -c '<task ' "{plan_path}" 2>/dev/null || grep -c '<task>' "{plan_path}" 2>/dev/null || echo 0)
   echo "Tasks: $task_count"
   ```
   - **Task count: 2-3 tasks per plan. Hard reject if >5.** If a detailer produced
     4-5 tasks, present to user with a warning ("detailer over-decomposed — accept
     or re-dispatch with stricter constraint?"). If >5, auto-reject and re-dispatch
     with explicit instruction: "Combine into 2-3 tasks. Do not create one task per file."
   - Validate task children (files + action + verify + done) via grep counts
   - Cross-check file count from summary against strategist's assignment

3. Collect NOTES from each detailer's summary block — if any flag missed dependencies
   or CROSS_PLAN requests, present them to user before proceeding

4. If validation fails on any plan: present issues, offer to re-dispatch that detailer

5. Reference plans only by file path and summary going forward. The orchestrator
   NEVER reads full plan content into its own context. Full plan text is on disk —
   subagents (checker, auditor, executor) read via file path in their own fresh context.

6. Merge newly detailed plans with any carried-forward plans (revision mode)

Parse graph metadata from strategy:
- `parallelizable`: total plans that can run in parallel
- `sequential_groups`: number of groups
- `estimated_cycles`: total APPLY→JUDGE cycles
</step>

<step name="cross_plan_negotiation">
**MECHANICAL RESOLUTION — no agent needed. Run after process_plans, before export_cross_validation.**

Detailers produce NOTES when they discover cross-plan interface needs (e.g., "Plan 01
should add 'pushing_onboarding' to EnrollmentStage"). This step structurally resolves
those notes instead of dumping them on the user.

**1. Extract cross-plan requests from detailer NOTES:**
```bash
# For each plan, grep NOTES for references to other plan IDs
for plan in .smike/{project_name}/phases/**/*-PLAN.md; do
  plan_id=$(grep '^plan:' "$plan" | head -1)
  # Notes are after ---END-PLAN--- in detailer output — stored in memory from process_plans
done
```
Also scan each plan's `<boundaries>` SCOPE LIMITS and `<context>` Discovery Notes for
patterns: "Plan {X} owns...", "needs {value} in Plan {X}", "{TypeName} owned by Plan {X}".

**2. Classify each request:**

ADDITIVE_TYPE_CHANGE: A plan needs a new value added to a type/enum/set that another
plan already modifies. Example: Plan 04 needs `pushing_onboarding` added to
`EnrollmentStage` which Plan 01 already extends.
- Detection: request names a type in the target plan's `<exports>` or `<action>`, AND
  the target plan's action already describes modifying that type.
- Resolution: auto-apply. Read target plan from disk, append the new value to the
  relevant `<action>` instruction and add/update an AC. Write back.
  Log: `Negotiation: added '{value}' to {TypeName} in Plan {target_id} (requested by Plan {source_id})`

ADDITIVE_EXPORT: A plan needs a new endpoint/subcommand/function that the target plan
could naturally host but doesn't currently include.
- Detection: request describes an interface in the target plan's domain (same package,
  same route file) but not in the target plan's `<exports>` or `<tasks>`.
- Resolution: auto-apply if the addition is ≤3 lines of action text and doesn't change
  the target plan's task count. Otherwise present to user:
  `Plan {source_id} needs '{interface}' from Plan {target_id}. Add to Plan {target_id}?`
  Options: "Add" / "Dismiss — source plan works around it"

STRUCTURAL_CHANGE: Anything that would restructure a plan's tasks, change file ownership,
or modify the dependency graph.
- Resolution: present to user. These are rare — most cross-plan requests are additive.

**3. After all resolutions, re-validate modified plans:**
- Re-run dry_run_validation section checks (section presence, task structure) on any
  plan that was modified by this step.
- Do NOT re-dispatch detailers — changes are surgical edits to on-disk PLAN.md files.

**4. Log summary:**
```
Cross-plan negotiation: {N} requests resolved ({auto} auto-applied, {user} user-decided, {dismissed} dismissed).
```
If zero requests found: `Cross-plan negotiation: no cross-plan requests. ✓`
</step>

<step name="export_cross_validation">
**MECHANICAL VALIDATION — no agent needed. Run after cross_plan_negotiation, before Stage 3.**

For each plan, check that every sibling interface it CONSUMES is actually PRODUCED by
the plan it claims to depend on. This catches contract gaps that the checker's blast
radius scan misses (checker focuses on existing code, not planned exports).

1. Build an **export registry** from all plans on disk:
   ```bash
   # For each plan, extract its <exports> section
   for plan in .smike/{project_name}/phases/**/*-PLAN.md; do
     echo "=== $(basename $plan) ==="
     sed -n '/<exports>/,/<\/exports>/p' "$plan"
   done
   ```
   Parse each plan's exports into a lookup: `{plan_id → [export_1, export_2, ...]}`.
   Exports are: endpoint paths (e.g., `POST /api/agent/heartbeat`), type names
   (e.g., `AgentHeartbeatPayload`), CLI subcommands (e.g., `enroll usbmux list`),
   JSON protocols (e.g., `{type, udid, stage}`).

2. For each plan P, **grep for references to sibling plan IDs and export strings:**
   ```bash
   # Grep plan P for references to other plans' exports
   for sibling_id in {all plan IDs except P}; do
     # Check for plan ID references (e.g., "Plan 02", "plan-02")
     grep -i "plan.${sibling_id}" "$plan_p_path"
     # Check for each of that sibling's export strings
     for export_str in ${exports[$sibling_id]}; do
       grep -F "$export_str" "$plan_p_path"
     done
   done
   ```
   Also grep P's `<action>` and `<acceptance_criteria>` sections for endpoint paths
   (`/api/...`), type names (PascalCase identifiers), and CLI commands that appear
   in any sibling's export registry.

3. For each consumed interface found:
   a. Identify the producing plan from the export registry
   b. Verify the producing plan's `<exports>` contains the interface AND its `<tasks>`
      describe creating it (not just mentioning it in context)
   c. If the interface is a CLI subcommand, endpoint, or type: confirm the producing
      plan's `<action>` sections describe creating it — grep for the specific path/name
      within `<action>` tags:
      ```bash
      sed -n '/<action>/,/<\/action>/p' "$producer_plan_path" | grep -F "$interface"
      ```

4. **On mismatch:**
   - Build a CONTRACT_GAP report:
     ```
     CONTRACT GAP: Plan {consumer_id} expects `{interface}` from Plan {producer_id},
     but Plan {producer_id}'s tasks/exports do not define it.
     ```
   - Present all gaps to user via AskUserQuestion per gap:
     Options: "Add to producer plan" / "Remove from consumer plan" / "Dismiss (false positive)"
   - For "Add to producer": re-dispatch that single detailer with the interface requirement
     injected into the outline. Update the on-disk PLAN.md.
   - For "Remove from consumer": edit the consumer PLAN.md to remove the assumption.

5. **On clean:** `Export cross-validation: {N} interfaces checked, all contracts satisfied. ✓`
</step>

<step name="stage3_audit_and_check">
**STAGE 3: Scope audit + cross-plan consistency check.**

Plans are already written to disk from process_plans. Pass FILE PATHS to subagents,
not plan contents. This keeps orchestrator context lean at Stage 3.

Scope auditor ALWAYS runs, regardless of plan count.
Consistency checker requires 2+ plans — skip if only 1.

- **1 plan:** dispatch scope auditor only.
- **2+ plans:** dispatch scope auditor AND checker(s) in parallel.

**1. Scope auditor configuration:**
   - Read `~/.claude/smike/prompts/scope-auditor-agent.md`
   - Fill: {spec path}, {plans} as **file paths** (auditor reads them in fresh context),
     {excluded_features} from strategy
   - subagent_type: "general-purpose"
   - description: "Audit spec coverage"

**2. Checker configuration:**

The checker-agent.md prompt has a `<mode>` field. Fill it based on plan count:

**≤8 plans:** Dispatch **1 checker** in `all` mode.
   - Read `~/.claude/smike/prompts/checker-agent.md`
   - Fill `{mode}` with `all`
   - Fill `{plan content}` with **file paths** to all PLAN.md files. Checker reads them.
   - Checker outputs one `---CHECK---` block per plan.

**9+ plans:** Dispatch 1 checker per parallel group, each in `single` mode.
   - Each checker gets assigned plan **file path** + summaries of all other plans
   - Build plan summaries for sibling context (from in-memory summaries):
     ```
     PLAN {id}: {title}
       Objective: {Goal line from plan}
       Files: {file list}
       AC names: {AC-1: Name, AC-2: Name, ...}
       Exports: {from plan's <exports> section or strategist exports}
       Depends on: {depends_on list}
     ```

**3. Dispatch ALL checkers AND scope auditor simultaneously** using parallel Agent tool calls.

**4. Process scope audit (HARD GATE):**
   - Parse ---SCOPE-AUDIT--- block
   - If result: **PASS** → print "Scope audit: {covered}/{total} features covered. PASS."
   - If result: **SCOPE_GAP** → **Triage by gap severity:**

     **MINOR GAP (≤2 features missing AND each maps to an existing plan by file/theme overlap):**
     a. For each gap, identify best-fit plan from auditor's coverage_matrix + file_map.
     b. AskUserQuestion per gap:
        "Feature '{name}' (spec: {spec_ref}) missing. Fold into Plan {id} ({title})?"
        Options: "Yes, fold in" / "Different plan" / "Defer"
     c. For fold-ins: re-dispatch ONLY that plan's detailer with the feature injected
        into the outline (append to ac_sketch + task summaries). Do NOT re-dispatch strategist.
        Update the on-disk PLAN.md with the detailer's output.
     d. For deferred: add to excluded_features with reason "user_deferred".
     e. Re-run scope auditor ONLY (not checker) to confirm PASS.
     f. Checker results from original round remain valid — plan structure unchanged.

     **STRUCTURAL GAP (3+ features missing, OR any gap that needs its own plan,
     OR gaps spanning multiple unrelated plans):**
     a. If `strategist_scope_failures < 2`:
        - Print: "⚠ Structural scope gap — {N} features missing. Re-dispatching strategist..."
        - Discard checker results (plans will change)
        - Increment `strategist_scope_failures`
        - Re-dispatch strategist with SCOPE_GAP report as `gap_report`
        - Loop back to graph_validation → process_strategy → stage2_detailers → stage3_audit_and_check
     b. If `strategist_scope_failures >= 2`:
        - Present each gap to user via AskUserQuestion:
          "Scope gaps remain after 2 revision cycles: {list with spec_ref}"
          Options per gap:
          [1] "Add to existing plan" → user specifies which plan
          [2] "Defer" → add to excluded_features with reason "user_deferred"
        - Apply user decisions and proceed

**5. Process checker results** (only reached when auditor PASS):
   - Parse each ---CHECK--- block
   - **NOTES_FOR_PLANS:** For each note targeting a plan, fold into that plan's `<context>`
     section on disk. Read the PLAN.md, find the `<context>` section, and add a
     `## Discovery Notes` heading within it (before the closing `</context>` tag):
     ```xml
     <context>
     ## Source Files
     ...existing content...
     ## Discovery Notes
     - [{source}] {description}
     </context>
     ```
     This ensures the execution agent naturally reads discovery notes as part of the
     plan's context — no dangling tags that downstream workflows might ignore.
   - **ESCALATIONS:** Collect all escalations across checkers. If any exist:
     - Present to user via AskUserQuestion with options per escalation:
       "Accept suggestion" / "Override" / "Dismiss"
     - For accepted escalations: apply the checker's fix to the on-disk PLAN.md
       (add depends_on, fix type shapes, move files between plans, add task steps)
     - For graph changes: update the graph groups before write_project_state

6. **Status line:**
   ```
   Cross-check: {N} plans — {notes_count} notes, {escalation_count} escalations.
   Scope audit: {covered}/{total} features covered.
   ```
</step>

<step name="dry_run_validation">
**STRUCTURAL VALIDATION of written PLAN.md files — no agent, ~30 seconds.**

Plans are already on disk from process_plans step 3. Validate structure before proceeding.

**Run the validation script:**
```bash
# Collect all PLAN.md paths
plan_files=$(find .smike/{project_name}/phases/ -name '*-PLAN.md' | sort)
# Run validation (checks sections, task XML, format drift, file paths)
bash ~/.claude/smike/scripts/validate-plans.sh $plan_files
```

The script checks:
1. **Section presence** — required top-level XML sections (`<objective>`, `<acceptance_criteria>`,
   `<tasks>`, `<boundaries>`, `<verification>`) anchored to line start (skips code blocks)
2. **Task structure** — each `<task>` block has `<name>`, `<files>`, `<action>`, `<verify>`,
   `<done>` child tags; task count 1-5 per plan
3. **Format drift** — detects markdown headers (`##`) and bold labels (`**Files:**`) INSIDE
   the `<tasks>` section (catches hybrid format — `<task>` wrapper with markdown children)
4. **File paths** — extracts paths from `<files>` tags, warns if parent directory is missing
   when grandparent exists (likely typo)

**Graph cross-validation (inline):**
- Every plan ID in strategy has a corresponding file on disk
- Every file on disk has a corresponding graph entry
- Sum of files across plans ≈ file_map total

**On failure:**
- **FORMAT_DRIFT:** Re-dispatch that detailer with explicit format instruction:
  "Your output used markdown inside `<task>` wrappers. Every child must be an XML tag:
  `<name>`, `<files>`, `<action>`, `<verify>`, `<done>`. No `##` headers, no `**bold**`
  labels. See the WRONG/RIGHT examples in <format_reminder>."
- **Missing children:** Re-dispatch with: "Task blocks missing required children: {list}"
- **Other failures:** Report which plan(s) failed + specifics. Offer re-dispatch.

**On success:** `Dry run: {N} plans validated, {total_tasks} tasks structured. ✓`
</step>

<step name="write_project_state">
**Write remaining project files to `.smike/{project_name}/`.**

PLAN.md files already on disk from process_plans. Write everything else:

1. **(PLAN.md files already written — skip)**

2. **Write PLAN-GRAPH.md:**
   ```markdown
   # Plan Execution Graph
   Phase: 01 — {phase name}
   Spec: {spec file path}
   Created: {timestamp}
   Total plans: {N}
   Parallel groups: {G}

   ## Groups
   {group definitions from ---GRAPH--- output}

   ## Plan Index
   | Plan | File | Group | Depends On | Pause | Status |
   |------|------|-------|------------|-------|--------|
   | 01 | .smike/{project_name}/phases/.../01-01-PLAN.md | 1 | — | — | pending |
   | 02 | .smike/{project_name}/phases/.../01-02-PLAN.md | 1 | — | — | pending |
   | 03 | .smike/{project_name}/phases/.../01-03-PLAN.md | 2 | 01, 02 | — | pending |
   ...
   (Pause column: `pause` if plan frontmatter has `pause_before: true`, `—` otherwise)
   ```

3. **Write PROJECT.md:**
   ```markdown
   # {project_name}

   ## What
   {one-line description from spec}

   ## Hard Constraints
   {from CLAUDE.md invariants or user input}

   ## Active Requirements
   {derived from spec deliverables}
   ```

4. **Write ROADMAP.md:**
   ```markdown
   # Roadmap

   ## Current Phase
   **Phase 01:** {phase name}
   Status: In Progress
   Plans: {N} ({G} parallel groups)

   ### Deliverables
   {from spec}
   ```

5. **Write STATE.md:**
   ```markdown
   # SMIKE State

   ## Project
   Name: {project_name}
   Spec: {spec file path}

   ## Position
   Phase: 01 — {phase name}
   Plan: Graph created — {N} plans in {G} groups
   Last: {timestamp} — Initialized from spec

   ## Resume
   Next: Execute group 1 (plan 01-01)

   ## Loop Position
   PLAN ──▶ APPLY ──▶ JUDGE
     ✓        ○        ○

   ## Gotchas
   (none yet)

   ## Propagated Discoveries
   (none yet)

   ## Session Continuity
   Last session: {timestamp}
   Next action: Execute group 1
   ```

6. **Write config.md:**
   ```markdown
   # Project Config
   Project: {project_name}
   Created: {timestamp}

   ## Preferences
   auto_accept_plans: true
   logging: false
   review_mode: risk-only
   tdd_default: true
   deploy: batch
   deploy_commands: []
   ```

   `deploy` values: `batch` (deploy once at phase transition — default), `per_plan` (deploy after each plan), `manual` (no auto-deploy, print reminder only).
   `deploy_commands`: list of shell commands to run, e.g. `["cd packages/worker && npx wrangler deploy"]`. Read from CLAUDE.md deploy instructions if present. Empty = no automated deploy, print reminder.
</step>

<step name="present_strategy">
**Present the execution strategy and stop.**

```
═══════════════════════════════════════
SMIKE INITIALIZED — {project_name}
{N} plans, {G} groups
═══════════════════════════════════════

Group 1 (parallel): {plan-ids}
  {one-line summary per plan}

Group 2 (depends on G1): {plan-ids}
  {one-line summary per plan}

...

Critical path: {G} sequential cycles
Total plans: {N} ({parallelizable} parallelizable)
Scope: {covered}/{total} features covered{, {excluded} deferred — listed in PROJECT.md}

Spec: {spec_file_path}
References: {count of additional files, or "none"}
Project dir: .smike/{project_name}/
═══════════════════════════════════════

Ready to execute. Start a fresh session and run:
  /smike:resume {project_name}
═══════════════════════════════════════
```
</step>

<step name="stop">
**STOP. Do not begin execution.**

Init's job is decomposition only. Execution starts in a fresh session to maximize
context budget for the APPLY→JUDGE cycles.

```
Ready to execute. Run in a fresh session:
  /smike:resume {project_name}
```

Do NOT auto-continue to apply-phase. Do NOT offer to start. Just stop.
</step>

</process>

<output>
- .smike/{project_name}/ directory with all state files
- PLAN-GRAPH.md with dependency graph
- All PLAN.md files written to phases directory
- User instructed to run `/smike:resume {project_name}` in fresh session
</output>

<error_handling>
**No spec provided:**
- Ask user for spec file path or inline description.
- Do not proceed without a spec.

**Spec too vague:**
- Ask clarifying questions via AskUserQuestion.
- Re-dispatch planning agent with additional context.

**Planning agent returns too few plans (1):**
- Accept it — some specs are naturally single-plan.
- Skip graph creation, execute directly.

**Planning agent returns malformed output:**
- Present raw output to user.
- Offer to re-dispatch or manual fix.

**Scope auditor loops exhausted:**
- After 2 revision cycles with persistent SCOPE_GAP, escalate remaining gaps
  to user for manual resolution (defer or assign to plan).
</error_handling>
