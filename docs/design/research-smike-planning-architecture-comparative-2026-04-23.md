# Comparative Architecture Notes For SMIKE Planning

Date: 2026-04-23
Scope: pressure-test the proposed SMIKE planning-stage architecture against comparable agent runtimes and planning systems, then extract only the patterns that improve the framework without bloating the common path.

## Systems Reviewed

- LangGraph docs: durable execution, interrupts, checkpoint-backed resume, and idempotent task guidance.
- OpenHands SDK docs: append-only event log, stateless step loop, context condensation, and repo-scoped skills.
- OpenAI Agents SDK docs and agent guide: manager vs handoff composition, lifecycle hooks, and layered guardrails.
- Claude Code docs: subagents, lifecycle hooks around subagent spawn/stop, and permission/continuation controls.
- Microsoft AutoGen docs: graph-directed multi-agent workflows, explicit activation structure, and human-in-the-loop termination.

## What Repeats Across The Better Systems

### 1. Human questions are interrupts, not just strings in state

The stronger runtimes treat user input as a durable pause/resume boundary, not a loose note attached to the current run.

Why it matters for SMIKE:

- a planning question batch needs an id the runtime can resume against
- the batch must stay stable until answered or invalidated
- a changed planning context should explicitly stale the old batch instead of silently reusing it

Recommended SMIKE adoption:

- add `planning.intake.interrupt_id` for intake-specific question pauses
- add `planning.question_batches[].interrupt_id` for post-contract planning questions
- treat `planning_blocked` as "no independent work remains", not "a question exists"
- reissue or invalidate question batches when `planning_context_hash` changes

### 2. Working state should be materialized from a small append-only planning journal

OpenHands is the clearest example here: the execution model is event-driven, append-only, and derived into views. LangGraph also leans on durable persisted state plus replay/resume semantics. SMIKE does not need a full event-sourced rewrite, but planning would benefit from one bounded journal for authority-changing transitions.

Why it matters for SMIKE:

- pending answers, accepted answers, gap status, proposal freshness, and promotion outcomes are all easy places for caches to drift
- operator surfaces can stay friendly while machine truth becomes auditable
- recheck and doctor get a durable recovery path that is more legible than implicit recomputation alone

Recommended SMIKE adoption:

- add `planning.journal[]` as a bounded append-only log for planning transitions only
- keep the journal narrow: `intake_refreshed`, `question_batch_opened`, `answer_recorded`, `answer_accepted`, `gap_status_changed`, `proposal_received`, `proposal_merged`, `promotion_blocked`, `promotion_passed`
- derive `planning.open_questions`, `planning.answers`, `planning.gaps`, `planning.readiness`, and proposal freshness from one reducer path
- do not attempt full runtime event sourcing in this loop

### 3. The parent planner should act like a manager, not a peer in a free-for-all handoff chain

OpenAI's manager-vs-handoff split and Claude Code's subagent model both reinforce the same point: delegation works best when one authority remains responsible for final state transitions.

Why it matters for SMIKE:

- child planning work is useful for reducing uncertainty, but dangerous as a source of canonical truth
- explicit merge ownership keeps `planning_context` drift contained
- stale child output becomes easier to reason about when every proposal maps back to the parent planner's gap queue

Recommended SMIKE adoption:

- keep one authoritative parent planner
- require all child planning output to land as proposal artifacts keyed by `gap_ids`
- make parent merge the only path that can update canonical `PLAN.json > planning_context`
- keep researcher/detailer work advisory even when it is high confidence

### 4. Repo memory should be separate from run state

OpenHands' always-loaded repo skill and `AGENTS.md`-style repo memory are useful because they distinguish stable repository context from transient run state.

Why it matters for SMIKE:

- intake currently risks recomputing the same repo-local truth discovery every cycle
- stable repo constraints, CI facts, and common source-of-truth files should not be mixed with pending planning questions
- planning state becomes easier to keep small if recurring repo context lives elsewhere

Recommended SMIKE adoption:

- keep `planning.intake.candidate_truth_sources` explicit, but allow a later `repo-profile` style artifact for recurring repo context
- treat that repo profile as an input to intake, not as run-state authority
- defer richer skill or profile machinery until the intake and question flow is stable

### 5. Guardrails belong before expensive execution, not after

The Smike retrospective already identified this. The external systems validate it. OpenAI's guide pushes layered guardrails. Claude Code exposes hooks around tool and subagent transitions. LangGraph emphasizes deterministic/idempotent workflow boundaries. AutoGen encourages explicit graph control before execution.

Why it matters for SMIKE:

- malformed or generic `verify:` surfaces should not survive into execution-ready planning
- dependency ambiguity and write-scope collisions should block dispatch formation, not just show up later as noise

Recommended SMIKE adoption:

- move verify-quality lint into planning promotion
- make dispatch readiness depend on one shared pass that checks gap closure, dependency legibility, and verify surface quality
- fail early on weak phase-specific proof, unresolved ownership, or invalid command structure

### 6. Parallelism should come from explicit graph facts, not optimism

AutoGen's graph flow and LangGraph's explicit node structure both make concurrency legible. The lesson for SMIKE is not "become a graph engine." It is "derive parallel planning work from declared dependencies plus collision checks."

Recommended SMIKE adoption:

- keep the phase DAG as the planning backbone
- derive `planning.dispatch_activation_groups` from dependency edges and write-scope collision analysis
- only surface parallel planning dispatches when there is no dependency path and no unsafe scope overlap
- keep the graph projection derived, not operator-authored

### 7. Long-running planning needs condensation and provenance, not transcript dumping

OpenHands' condenser and the OpenAI handoff history controls both point to the same operational truth: long transcripts become drag unless the system maintains compressed provenance.

Recommended SMIKE adoption:

- store concise proposal summaries and evidence refs in state
- collapse accepted child output into parent-owned summaries instead of dragging full child transcripts into planning state
- preserve provenance ids and stale conditions even when text is condensed

## Patterns Worth Stealing Now

- durable interrupt ids for planning questions
- a bounded append-only planning journal
- one reducer path that derives gaps, answers, readiness, and operator surfaces
- parent-owned proposal merge
- promotion-time verify-quality lint
- derived dispatch activation groups from the phase DAG

## Patterns Worth Deferring

- full repo-profile or skill registry automation
- nested planning handoff chains
- external-web planning research by default
- full runtime-wide event sourcing
- graph-visualization or time-travel tooling

## Patterns To Avoid

- letting child planning work mutate canonical plan truth directly
- treating open questions as synonymous with full blockage
- dumping full transcripts into handoff state
- exposing graph or dispatch internals as the normal operator interface
- making public-web research part of the common planning path

## Resulting SMIKE Architecture Recommendations

1. Add a bounded `planning.journal` and derive working views from it.
2. Make question batches durable interrupts with explicit invalidation rules.
3. Preserve a strict authority split:
   `STATE.json > planning` is working state,
   `PLAN.json > planning_context` is accepted planning truth,
   repo truth sources remain external refs or later repo-profile inputs.
4. Keep planning children advisory; parent merge is the only semantic write path.
5. Expand the promotion gate so verify quality and dispatch safety are checked before execution handoff.
6. Derive planning parallelism from the DAG plus scope-collision analysis.

## Sources

- LangGraph interrupts: https://docs.langchain.com/oss/python/langgraph/interrupts
- LangGraph durable execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- OpenHands SDK agent architecture: https://docs.openhands.dev/sdk/arch/agent
- OpenHands SDK events: https://docs.openhands.dev/sdk/arch/events
- OpenHands SDK condenser: https://docs.openhands.dev/sdk/arch/condenser
- OpenHands general skills / repo memory: https://docs.openhands.dev/overview/skills/repo
- OpenAI Agents SDK agents guide: https://openai.github.io/openai-agents-js/guides/agents/
- OpenAI Agents SDK handoffs: https://openai.github.io/openai-agents-python/handoffs/
- OpenAI practical guide to building agents: https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code hooks: https://code.claude.com/docs/en/hooks
- Microsoft AutoGen GraphFlow: https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/graph-flow.html
- Microsoft AutoGen human-in-the-loop: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/human-in-the-loop.html
