# SMIKE Runtime Recovery Matrix

This matrix is the non-happy-path companion to `docs/smike-runtime-acceptance-runbook.md`. Use it only after `STATE.md` or command output shows that the normal `advance` loop is no longer enough.

## Retry / Respawn

| Scenario | Trigger command | Expected surface | Legal next command |
|---|---|---|---|
| Runtime dispatch reports an execution failure | `./smike dispatch <project> failed <dispatch-id> --reason="Runtime dispatch failed."` | `status` shows `next_command: ./smike dispatch <project> retry <dispatch-id>` and the dispatch status becomes `failed`. `STATE.md` tells the operator to retry, then rerun `advance`. | `./smike dispatch <project> retry <dispatch-id>` |
| Requeue a failed or stale dispatch | `./smike dispatch <project> retry <dispatch-id>` | The dispatch moves back to `queued`, and `next_command` becomes `./smike advance <project>`. | `./smike advance <project>` |
| Respawn the requeued dispatch | `./smike advance <project>` | Command output shows `<dispatch-id> -> spawned`. `STATE.md` shows the dispatch as active with a lease and owner command. | Continue the normal execution loop, then mark completion with `./smike dispatch <project> completed <dispatch-id>`. |
| Completion fails because result artifacts were unchanged from the spawn baseline | `./smike dispatch <project> completed <dispatch-id>` | Completion is rejected and the recovery text tells you to run `./smike dispatch <project> retry <dispatch-id>`, rerun `./smike advance <project>`, then rewrite the required artifacts after spawn. | `./smike dispatch <project> retry <dispatch-id>` |

## Lease Expiry

| Scenario | Trigger command | Expected surface | Legal next command |
|---|---|---|---|
| Inspect a suspicious live dispatch | `./smike status <project>` | Output includes `dispatch_owner`, `dispatch_lease`, and `dispatch_lease_expired: <dispatch-id> (Runtime dispatch lease expired at ...)` when the active owner did not reconcile before the lease deadline. | Run `./smike doctor <project>` to confirm the lease problem before mutating state. |
| Confirm the lease-expiry failure | `./smike doctor <project>` | `doctor` fails with `error expired-runtime-dispatch-lease:` while the dispatch is still marked `spawned`. | Mark the abandoned dispatch failed so it can re-enter the retry path. |
| Recover after the previous owner is gone | `./smike dispatch <project> failed <dispatch-id> --reason="lease expired"` | The dispatch becomes `failed`, and the project surfaces the standard retry guidance. | `./smike dispatch <project> retry <dispatch-id>` |
| Requeue and respawn after lease expiry | `./smike dispatch <project> retry <dispatch-id>` then `./smike advance <project>` | The dispatch returns to `queued`, then to `spawned`, with a fresh owner and lease. | Continue normal execution and complete the respawned dispatch. |

Inference:
The repair path above is derived from the documented `dispatch failed -> retry -> advance` flow plus the lease-expiry inspection surfaces; the sources explicitly define the detection signals and the generic retry path, but they do not spell out a separate lease-specific command.

## Archive / Restore

| Scenario | Trigger command | Expected surface | Legal next command |
|---|---|---|---|
| Safe archive when no live runtime dispatches remain | `./smike archive <project> --force` | Output includes `smike archive: <project>` and `archive: .smike-archive/<project>`. If the active pointer referenced that project, output also includes `active: cleared`. | `./smike restore <project>` if you need to rehydrate the runtime later. |
| Refused archive because dispatches are still live | `./smike archive <project> --force` | The command fails with `refusing to archive <project> while runtime dispatches are still live (...)` and tells you to rerun with `--force --abandon-live-dispatches`. | Either let the live dispatches finish normally or rerun the forced archive command. |
| Forced archive of a live runtime | `./smike archive <project> --force --abandon-live-dispatches` | Output includes `smike archive: <project>` plus `abandoned_live_dispatches: <dispatch-id>` for the abandoned work. | `./smike restore <project>` when you want the runtime back on disk. |
| Restore an archived project | `./smike restore <project>` | Output includes `validated: .smike/<project>/STATE.json` and `resume: run \`./smike activate <project>\` then \`./smike\``. The restore path regenerates missing derived artifacts before returning control. | Run `./smike doctor <project>` to confirm the restored runtime is healthy, then resume the project. |

## Operator Notes

- `STATE.json.lifecycle.next_command` remains the authority whenever command output and `STATE.md` disagree.
- Use `status` for inspection and `doctor` when state looks inconsistent.
- Do not jump straight to `archive --abandon-live-dispatches` unless you are intentionally discarding in-flight work.
- Close the pass with [smike-runtime-final-checklist.md](smike-runtime-final-checklist.md) so the evidence bundle is captured before calling the runtime healthy.
