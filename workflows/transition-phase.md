<purpose>
Handle phase-level transition after all plans complete. Includes scope audit (gut check) to catch dropped work before moving on. Auto-continues unless scope gaps found.

**Invoked by:** judge-phase.md when it detects "last plan in phase"
**Scope:** Phase N → Phase N+1 (or milestone completion)
</purpose>

<when_to_use>
- All plans in current phase are complete
- Phase is ready to close
</when_to_use>

<required_reading>
@.smike/{project_name}/STATE.md
@.smike/{project_name}/ROADMAP.md

Note: `{project_name}` is passed from the judge-phase workflow. All `.smike/`
paths in this workflow are relative to `.smike/{project_name}/`.
</required_reading>

<process>

<step name="verify_phase_completion" priority="first">
1. Count PLAN.md files in current phase directory
2. Verify all have completion blocks appended
3. **If incomplete:** Report which plans are missing, wait for user
4. **If complete:** Continue
</step>

<step name="scope_audit" priority="critical">
**GUT CHECK: Did this phase deliver what it promised?**

This step exists because context rot causes scope to silently drop.

1. Read ROADMAP.md — find Phase N's goal and scope
2. Read all completion blocks in `.smike/{project_name}/phases/{phase}/`
3. Compare: what was promised vs what was built
4. For each promised deliverable:
   - Was it built? (check completion blocks + source files)
   - Was it explicitly deferred? (check completion block deviations)
   - Or was it silently dropped?

**If scope gaps found:**
```
════════════════════════════════════════
SCOPE AUDIT — GAPS DETECTED
════════════════════════════════════════

Phase {N} goal: {goal from ROADMAP}

Delivered:
- [item] ✓
- [item] ✓

Gaps (not built, not explicitly deferred):
- [missing item 1]
- [missing item 2]

════════════════════════════════════════
```

**Wait for user decision on each gap.** This is a mandatory stop.

Use AskUserQuestion for each gap with options:
- "Add remediation plan" — Add to STATE.md Gotchas as `SCOPE GAP: [description]`. Next `/smike` init MUST address scope gaps before Phase N+1's own work.
- "Defer to backlog" — Add to STATE.md Deferred section.
- "Mark as not needed" — Update ROADMAP phase scope to reflect reality.

**If no gaps:** Continue automatically.
```
Scope audit: Phase {N} delivered all promised items. ✓
```
</step>

<step name="cleanup_handoffs">
Delete stale handoffs in phase directory.
</step>

<step name="update_project">
1. If any requirements shipped: check them off in Active Requirements
2. If new constraints discovered: add to Constraints
</step>

<step name="update_state_for_transition">
Update STATE.md:

```markdown
## Position
Milestone: [Name] ([version])
Phase: [N+1] of [total] — [Next phase name]
Plan: Not started
Last: [today] — Phase [N] complete, transitioned to Phase [N+1]

## Resume
Next: /smike with Phase [N+1] spec
```

If scope gaps were added: include them in Gotchas section.
</step>

<step name="update_roadmap_completion">
Mark current phase complete in ROADMAP.md.
Update progress count.
</step>

<step name="commit_phase">
**Commit phase state + only the source files this phase touched.**

1. Collect changed source files from all plans in this phase:
   - Read each PLAN.md's completion block or `<context>` section for file lists
   - Or use: `git diff --name-only HEAD~{commit_count}` to get actual changed files
2. Stage source files ONLY (`.smike/` is typically gitignored — SMIKE state is local):
```bash
# Add only source files that this phase's plans actually modified:
git add {file1} {file2} ...
# Do NOT use `git add src/` — that stages unrelated files
# Do NOT stage .smike/ files — check `git check-ignore .smike/` first if unsure
git commit -m "$(cat <<'EOF'
feat({phase}): {phase-description}

Phase {N} complete:
- {plan-01 summary}
- {plan-02 summary}

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
</step>

<step name="deploy">
**Run deploy commands if configured.**

1. Read `config.md` for `deploy` and `deploy_commands`.
2. Route by deploy strategy:
   - `batch`: Run `deploy_commands` now (phase transition = batch boundary).
   - `per_plan`: Already deployed per-plan during APPLY — skip.
   - `manual`: Print reminder with commands from config, do NOT execute.
3. If `deploy_commands` is empty: print "No deploy commands configured — deploy manually if needed."
4. If deploy command fails: print error, do NOT block phase transition. Deploy failures are operational, not code issues.
</step>

<step name="verify_state_consistency">
Quick check: STATE.md and ROADMAP.md agree on phase number and status.
If misaligned, fix before routing.
</step>

<step name="route">
**Route to next phase or milestone completion.**

**Route A (more phases):**
All plans for this phase are complete. If more phases exist in ROADMAP, tell user:
```
Phase {N} complete. Run /smike with a new spec for Phase {N+1}.
Project: {project_name}
```
STOP. New phases require a new spec and fresh decomposition.

**Route B (milestone complete):**
```
════════════════════════════════════════
MILESTONE COMPLETE: {version}
════════════════════════════════════════

All {N} phases finished.
════════════════════════════════════════
```
Check `.smike/{project_name}/config.md` for `auto_accept_plans: true`:
- **Autonomous mode:** Create handoff and stop. Milestone boundary is a natural
  session break even in autonomous mode — the user should review before starting
  a new milestone.
- **Checkpoint mode:** Use AskUserQuestion:
  - "Start next milestone" — Begin planning next version
  - "Pause here" — Stop and create handoff
</step>

</process>

<output>
- STATE.md updated for new phase
- ROADMAP.md marked complete
- Scope gaps caught and routed (remediation, defer, or dismiss)
- Git commit created
- Auto-continues to next phase (unless milestone complete)
</output>
