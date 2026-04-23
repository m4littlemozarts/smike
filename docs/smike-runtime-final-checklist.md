# SMIKE Runtime Final Checklist

Use this checklist after the acceptance runbook and recovery matrix have both been exercised. The goal is to leave behind a small evidence bundle, not a narrative summary.

## Final Checklist

- Confirm the package exists: `docs/spec-smike-runtime-acceptance.md`, `docs/smike-runtime-acceptance-runbook.md`, `docs/smike-runtime-recovery-matrix.md`, and this file all exist in the repo.
- Capture the final `./smike status spec-smike-runtime-acceptance` output, including `status`, `next_command`, and any `dispatch_*` lines.
- Capture the top actionable block from `.smike/spec-smike-runtime-acceptance/STATE.md`, especially `Actionable dispatch`, `Next command`, and `Advance behavior`.
- Run `./smike doctor spec-smike-runtime-acceptance` and record whether it returns `result: PASS` or the exact failing error id.
- Keep the latest capsule path that matched the last actionable dispatch under `.smike/spec-smike-runtime-acceptance/capsules/`.
- Confirm the runbook and recovery matrix headings are present:
  - `Retry / Respawn`
  - `Lease Expiry`
  - `Archive / Restore`
- If you exercised a failed-dispatch path, keep the command/output pair for:
  - `./smike dispatch <project> failed <dispatch-id>`
  - `./smike dispatch <project> retry <dispatch-id>`
  - the follow-up `./smike advance <project>` that respawned the work
- If you exercised lease-expiry recovery, keep:
  - the `dispatch_lease_expired:` line from `status`
  - the `error expired-runtime-dispatch-lease:` line from `doctor`
  - the recovery command sequence you used afterward
- If you exercised archive/restore, keep:
  - the `smike archive:` output and archive path
  - any `abandoned_live_dispatches:` line if you used the forced path
  - the `smike restore:` output with `validated: .smike/<project>/STATE.json`
  - the follow-up `./smike doctor <project>` result after restore
- Do not call the runtime healthy until the evidence above is captured from real command output or the on-disk state files.
