import fs from 'node:fs';
import path from 'node:path';

import { ensureArray } from './common-utils.mjs';

export function buildDerivedArtifactPayloads({
  project,
  paths,
  repoRoot,
  rootPlan,
  state,
  orchestration,
  propagatedDiscoveries,
  latest,
  acceptanceGaps,
  workflowPlans,
  nextPending,
  runtimeContext,
  planningAnalysis,
  planningFreshness,
  dependencyBlockers,
  actionableDependencyTargets,
  dependencyBlockersByPlanId,
  dependencyGroups,
  verdictCount,
  reviewCount,
  latestVerdictResult,
  latestReviewResult,
  canonicalPlanningContext,
  canonicalPlanningContextHash,
  currentDelegation,
  currentDispatchGroup,
  completableDispatchGroup,
  readyDispatches,
  latestCapsules,
  roleCapsuleCount,
  workflowPlanDetails,
  authoritativeState,
  getLifecycleNextCommand,
  nowIso,
}) {
  const generatedAt = nowIso();
  const resumeCapsuleJson = {
    schema_version: '2.1.0',
    generated_at: generatedAt,
    project,
    next_action: state.lifecycle.next_action,
    next_command: getLifecycleNextCommand(state),
    stop_reason: state.lifecycle.stop_reason || null,
    current_phase: state.lifecycle.status,
    current_plan: runtimeContext.actionable.plan_id || state.current_plan?.plan_id || null,
    current_plan_group: currentDispatchGroup,
    current_plan_ids: runtimeContext.actionable.plan_ids,
    blockers:
      orchestration.stage === 'planning' && planningAnalysis.blocking_findings.length > 0
        ? planningAnalysis.blocking_findings.map((finding) => `${finding.source}:${finding.id}`)
        : ensureArray(latest?.failures),
    dependency_blockers: dependencyBlockers,
    acceptance_gaps: acceptanceGaps,
    latest_verdict: latestVerdictResult,
    latest_review: latestReviewResult,
    gotchas: ensureArray(state.gotchas),
    planning: {
      checker_result: planningAnalysis.checker?.result || null,
      auditor_result: planningAnalysis.auditor?.result || null,
      artifacts_fresh: !planningFreshness.stale,
      artifacts_freshness_reason: planningFreshness.reason,
      planning_context_hash: canonicalPlanningContextHash,
      blocking_findings: planningAnalysis.blocking_findings.map((finding) => ({
        source: finding.source,
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
      })),
    },
    orchestration: {
      stage: orchestration.stage,
      active_role: orchestration.active_role,
      last_role: orchestration.last_role,
      next_role: orchestration.next_role,
      runtime_dispatch_view: orchestration.runtime_dispatch_view,
    },
    delegation: {
      mode: currentDelegation.mode,
      owner: currentDelegation.owner,
      ready_dispatch_ids: readyDispatches.map((entry) => entry.dispatch_id),
    },
  };

  const planGraphJson = {
    schema_version: '2.1.0',
    generated_at: generatedAt,
    project,
    phase: rootPlan.phase || null,
    summary: {
      spec: rootPlan.spec || null,
      created: state.created_at || null,
      total_plans: workflowPlans.length || 1,
      parallel_groups: dependencyGroups.parallel_groups,
      blocked_plans: dependencyBlockers.length,
    },
    groups: dependencyGroups.groups,
    dependency_blockers: dependencyBlockers,
    plans: workflowPlans.map((plan) => ({
      plan: plan.plan_id,
      file: plan.plan_md || plan.plan_json,
      group: dependencyGroups.group_by_plan_id.get(plan.plan_id) || 1,
      depends_on: ensureArray(plan.depends_on),
      blocked_by: ensureArray(dependencyBlockersByPlanId.get(plan.plan_id)),
      pause: null,
      status: plan.status,
    })),
  };

  const indexJson = {
    schema_version: '2.1.0',
    generated_at: generatedAt,
    project,
    counts: {
      plans: workflowPlans.length || (fs.existsSync(paths.planMdPath) ? 1 : 0),
      exec_reports: fs.existsSync(paths.execReportPath) ? 1 : 0,
      verdict_reports: verdictCount,
      review_reports: reviewCount,
      planning_reports:
        (fs.existsSync(paths.planningCheckerJsonPath) ? 1 : 0)
        + (fs.existsSync(paths.planningAuditorJsonPath) ? 1 : 0),
      fix_reports: 0,
      role_capsules: roleCapsuleCount,
    },
    next_plan: nextPending ? path.resolve(repoRoot, nextPending.plan_md || nextPending.plan_json) : null,
    latest_reports: {
      exec: fs.existsSync(paths.execReportPath) ? path.resolve(paths.execReportPath) : null,
      verdict: fs.existsSync(paths.verdictReportPath) ? path.resolve(paths.verdictReportPath) : null,
      review: fs.existsSync(paths.reviewReportPath) ? path.resolve(paths.reviewReportPath) : null,
      checker: fs.existsSync(paths.planningCheckerJsonPath) ? path.resolve(paths.planningCheckerJsonPath) : null,
      auditor: fs.existsSync(paths.planningAuditorJsonPath) ? path.resolve(paths.planningAuditorJsonPath) : null,
      handoff: path.resolve(paths.implementationHandoffJsonPath),
    },
    orchestration: {
      stage: orchestration.stage,
      active_role: orchestration.active_role,
      last_role: orchestration.last_role,
      next_role: orchestration.next_role,
    },
    latest_capsules: latestCapsules,
    discovery_log_entries: propagatedDiscoveries.length,
  };

  const implementationHandoffJson = {
    schema_version: '1.0.0',
    generated_at: generatedAt,
    project,
    authoritative_state: authoritativeState,
    lifecycle: {
      status: state.lifecycle.status,
      next_action: state.lifecycle.next_action,
      next_command: getLifecycleNextCommand(state),
      stop_reason: state.lifecycle.stop_reason || null,
    },
    planning: {
      checker_result: planningAnalysis.checker?.result || null,
      auditor_result: planningAnalysis.auditor?.result || null,
      artifacts_fresh: !planningFreshness.stale,
      artifacts_freshness_reason: planningFreshness.reason,
    },
    planning_context_hash: canonicalPlanningContextHash,
    actionable_surface: {
      plan_id: runtimeContext.actionable.plan_id || state.current_plan?.plan_id || null,
      plan_ids: runtimeContext.actionable.plan_ids,
      dispatch_group: currentDispatchGroup,
      completable_group: completableDispatchGroup,
      current_dispatch: orchestration.current_actionable_dispatch,
      current_capsule: orchestration.current_actionable_capsule || null,
    },
    phase_graph: workflowPlanDetails,
    dependency_blockers: dependencyBlockers,
    actionable_dependency_targets: actionableDependencyTargets,
    truth_sources: canonicalPlanningContext.truth_sources,
    deferred_items: canonicalPlanningContext.explicit_deferrals,
    protected_areas: canonicalPlanningContext.protected_areas,
  };

  return {
    implementationHandoffJson,
    indexJson,
    planGraphJson,
    resumeCapsuleJson,
  };
}
