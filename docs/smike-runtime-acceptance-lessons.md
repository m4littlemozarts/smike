# SMIKE Runtime Acceptance Lessons

This note captures what the completed acceptance run taught us about the framework itself. It is not a control-plane document. Use it as a short retrospective next to the runbook package.

## What Worked

- Planning was the strongest part of the run. The framework produced a coherent bundle, preserved the requested phase order, and moved through checker and auditor cleanly.
- The operator package shape is useful. The run produced a runbook, a recovery matrix, and a final checklist that make the runtime easier to inspect as a system instead of as ad hoc command output.
- Recovery concepts are now concrete enough to document. Retry, lease expiry, and archive/restore can be described as separate flows instead of one generic "rerun it" fallback.

## What Felt Rough

- Implementation felt more mechanical than planning. That is partly because this was a docs-only spec, so executor work was somewhat artificial and evidence-heavy rather than behavior-heavy.
- The final review still called out weak acceptance evidence for one criterion because the proof leaned too much on exit status and file presence.
- Some recovery guidance still had to be inferred from the runtime behavior instead of quoted directly from a first-class contract surface.

## Framework Lessons

- The operator surface is now strong enough to expose real inconsistencies. That is good, but it also means cleanup bugs are more visible.
- Completion semantics still need tightening. This run ended with the project marked `complete` while `STATE.md`, `STATE.json`, and `./smike status` still advertised an actionable queued dispatch.
- Recovery language should become more explicit in the framework itself. If a doc has to say "Inference," the runtime contract is still underspecified for that path.
- Evidence quality matters even for docs-only phases. If acceptance criteria can pass on exit code alone, review will keep flagging weak proof.

## Extracted Feedback Log Lessons

- Dependency blockers should name the blocked plan, the upstream dependency,
  and the exact legal unblock command. Repeated feedback-log entries showed
  that "02 is blocked by 01" is not enough operator guidance by itself.
- Acceptance gaps should surface before a phase is allowed to look complete.
  The runtime should prefer early planning or reconciliation feedback over late
  reviewer surprise.
- Contract-only refinements need a lighter path than full stale-detailer churn
  when auditability is preserved and the changed surface is only the runtime
  contract.
- Weak or malformed `verify:` commands should fail during planning promotion,
  before executor, judge, or reviewer dispatches begin.
- Human-facing handoffs should never report `complete` while still advertising
  queued or actionable runtime dispatches.

## Recommended Follow-Up

- Fix final dispatch cleanup so actionable runtime dispatches are cleared when lifecycle status becomes `complete`.
- Strengthen acceptance criteria for docs-only work so commands prove headings, content, or state transitions instead of only command success.
- Promote lease-expiry recovery into a more explicit operator contract so the docs do not need to infer the legal repair path.
- Run one more acceptance pass against a small real code-bearing change so executor quality is tested on something less artificial than docs packaging.
