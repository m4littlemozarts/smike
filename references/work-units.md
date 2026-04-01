<work_units>

## Purpose

Guide plan sizing so that each execution subagent can complete its work in fresh
context without quality degradation. This is about subagent capacity, not orchestrator
limits — the orchestrator runs continuously.

## Subagent Context Budget

Each execution subagent gets a fresh 200k token context window. Quality degrades
as the subagent fills its window during a single plan execution:

| Subagent Usage | Quality | Effect |
|----------------|---------|--------|
| 0-30% | PEAK | Thorough, comprehensive |
| 30-50% | GOOD | Solid work |
| 50-70% | DEGRADING | Starts cutting corners |
| 70%+ | POOR | Rushed, minimal |

**The rule:** Size plans so subagents finish within ~50% of their context.

## File Count → Context Impact

| Files Modified | Context Impact |
|----------------|----------------|
| 0-3 files | ~10-15% (small) |
| 4-6 files | ~20-30% (medium) |
| 7+ files | ~40%+ (large — split) |

| Complexity | Context/Task |
|------------|--------------|
| Simple CRUD | ~15% |
| Business logic | ~25% |
| Complex algorithms | ~40% |
| Domain modeling | ~35% |

**Quick estimates:**
- 2 simple tasks: ~30%
- 2 medium tasks: ~50%
- 2 complex tasks: ~80% (split!)
- 3 simple tasks: ~45%
- 3 medium tasks: ~75% (risky)

## Split Signals

**Always split when:**
- More than 3 tasks (even if tasks seem small)
- Multiple subsystems (DB + API + UI = separate plans)
- Any task with >5 file modifications
- Discovery + implementation (separate plans)

**Consider splitting when:**
- Estimated >5 files modified total
- Complex domains (auth, payments, data modeling)
- Uncertainty about approach
- Natural semantic boundaries

</work_units>
