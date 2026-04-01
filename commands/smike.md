---
name: smike
description: "SMIKE — init, resume, or pause depending on context"
argument-hint: "[spec-file] [extra-reference-files...]"
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent, AskUserQuestion]
---

<objective>
Unified SMIKE entry point. Smart-routes to init, resume, or pause based on arguments and
project state on disk.

**Routing logic:**

| Invocation | State | Action |
|---|---|---|
| `/smike spec.md [refs...]` | No `.smike/{project}/` exists | **Init** — decompose spec into plan graph |
| `/smike spec.md [refs...]` | Project exists, spec hash matches | **Resume** — pick up where left off |
| `/smike spec.md [refs...]` | Project exists, spec hash differs | **Ask** — re-init or resume existing plan? |
| `/smike project-name` | Project exists (arg is not a file) | **Resume** — pick up where left off |
| `/smike` (no args) | Active project in progress | **Pause** — create handoff |
| `/smike` (no args) | No active projects | Show status / help |
</objective>

<execution_context>
<!-- Workflows loaded on-demand based on routing decision -->
</execution_context>

<context>
$ARGUMENTS
</context>

<process>

<step name="route" priority="first">
**Determine action from arguments + disk state.**

1. **No arguments provided:**
   - List projects: `ls -d .smike/*/STATE.md 2>/dev/null | sed 's|.smike/||;s|/STATE.md||'`
   - **0 projects:** Print help:
     ```
     SMIKE — No active projects.

     Usage:
       /smike spec.md [refs...]  — Initialize a new project from a spec
       /smike project-name       — Resume an existing project
       /smike                    — Pause current work (when mid-session)
     ```
     Exit.
   - **1+ projects with active loop context in conversation:** → Route to **PAUSE**.
     (The user is mid-session and typed `/smike` with no args — they want to pause.)
   - **1+ projects, fresh session (no loop context):** → Route to **RESUME** (pass no args,
     let resume-project.md handle project selection).

2. **Arguments provided — check if first arg is a file:**
   ```bash
   ls "$first_arg" 2>/dev/null
   ```

   **2a. First arg IS a file (spec path):**
   - Derive `project_name` from filename: strip extension and trailing `-spec` suffix.
     - `enrollment-agent-spec.md` → `enrollment-agent`
     - `dns-filtering.md` → `dns-filtering`
   - Compute spec hash:
     ```bash
     md5 -q "$first_arg" 2>/dev/null || md5sum "$first_arg" | cut -d' ' -f1
     ```
   - Check for existing project:
     ```bash
     ls .smike/{project_name}/STATE.md 2>/dev/null
     ```

   **If project does NOT exist:** → Route to **INIT** (pass all $ARGUMENTS).

   **If project exists:**
   - Read stored hash:
     ```bash
     grep '^spec_hash:' .smike/{project_name}/STATE.md | awk '{print $2}'
     ```
   - **Hash matches (or no stored hash yet):** → Route to **RESUME** (pass project_name).
   - **Hash differs:** → Ask via AskUserQuestion:
     - "Spec file has changed since this project was initialized. What would you like to do?"
     - Options:
       - "Re-initialize" — Re-run planning with the updated spec (existing plans will be replaced)
       - "Resume existing plan" — Ignore spec changes and continue where you left off
     - **Re-initialize:** → Route to **INIT** (pass all $ARGUMENTS).
     - **Resume existing plan:** → Route to **RESUME** (pass project_name).

   **2b. First arg is NOT a file (treat as project name):**
   - Check if `.smike/{first_arg}/STATE.md` exists.
   - **Exists:** → Route to **RESUME** (pass first_arg as project_name).
   - **Does not exist:** Print error:
     ```
     No file or SMIKE project found for "{first_arg}".

     If it's a spec file, check the path. If it's a project name, run:
       ls .smike/*/STATE.md
     to see available projects.
     ```
     Exit.
</step>

<step name="dispatch">
**Execute the routed action by loading the appropriate workflow.**

**INIT:**
- Follow workflow: @~/.claude/smike/workflows/init-project.md
- Pass all $ARGUMENTS through.
- After init completes, store the spec hash in STATE.md:
  ```markdown
  spec_hash: {computed_hash}
  spec_file: {spec_file_path}
  ```

**RESUME:**
- Follow workflow: @~/.claude/smike/workflows/resume-project.md
- Pass project_name as argument.

**PAUSE:**
- Follow workflow: @~/.claude/smike/workflows/pause-work.md
- Resolve project from conversation context or single-project auto-select.
</step>

</process>

<success_criteria>
- [ ] Correct action routed based on arguments + disk state
- [ ] Spec hash compared when project exists and spec file provided
- [ ] Spec hash stored in STATE.md after init
- [ ] Downstream workflow executed with correct arguments
</success_criteria>
