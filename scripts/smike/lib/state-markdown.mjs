import path from 'node:path';

import { ensureArray, normalizeRel, normalizeStringArray } from './common-utils.mjs';

export function createStateMarkdownRenderer({
  repoRoot,
  buildDependencyGroups,
  buildDependencyNextAction,
  buildImplementationProfileSurface,
  buildCycleCommand,
  describeDependencyBlockers,
  describeDependencyTargets,
  ensureDiscoveryLog,
  ensureOrchestrationState,
  getCurrentRuntimeDispatchEntriesFromState,
  getLifecycleNextCommand,
  getOperatorGuidanceLines,
  getPlanningDraftNoticeLines,
  getRuntimeDispatchLeaseExpiry,
  summarizeRuntimeDispatchOwner,
  summarizeRuntimeDispatchState,
}) {
  return function renderStateMarkdown(project, specRel, state) {
    const workflowPlans = ensureArray(state.workflow?.plans);
    const groups = workflowPlans.length > 0 ? buildDependencyGroups(project, workflowPlans) : { parallel_groups: 0 };
    const graphSummary = workflowPlans.length > 0
      ? `Graph ready — ${workflowPlans.length} plans in ${groups.parallel_groups} group${groups.parallel_groups === 1 ? '' : 's'}`
      : state.lifecycle.status;
    const orchestration = ensureOrchestrationState(state);
    const latestCapsules = Object.entries(orchestration.capsules.latest_by_role || {})
      .filter(([, capsulePath]) => typeof capsulePath === 'string' && capsulePath.trim());
    const propagatedDiscoveries = ensureDiscoveryLog(state);
    const runtimeDispatchView = orchestration.runtime_dispatch_view || {};
    const actionable = runtimeDispatchView.actionable_plan || {};
    const delegation = runtimeDispatchView.delegation || {};
    const currentDispatches = getCurrentRuntimeDispatchEntriesFromState(state);
    const dispatchSummary = summarizeRuntimeDispatchState(state);
    const planningAnalysis = state?.planning?.analysis || {};
    const planningFreshness = state?.planning?.verification || {};
    const actionableDispatch = orchestration.current_actionable_dispatch;
    const actionableDispatchSummary = actionableDispatch
      ? `${actionableDispatch.dispatch_id} (${actionableDispatch.role} / ${actionableDispatch.status}${actionableDispatch.freshness ? ` / ${actionableDispatch.freshness}` : ''})`
      : 'none';
    const actionableDispatchOwnerSummary = actionableDispatch
      ? summarizeRuntimeDispatchOwner(actionableDispatch.active_owner || actionableDispatch.last_owner)
      : 'none';
    const actionableCapsule = orchestration.current_actionable_capsule || 'none';
    const actionableCapsuleDisplay = typeof actionableCapsule === 'string' && actionableCapsule !== 'none'
      ? normalizeRel(path.relative(repoRoot, path.resolve(actionableCapsule)))
      : actionableCapsule;
    const planningBlockers = ensureArray(planningAnalysis.blocking_findings).slice(0, 3);
    const planningPrompt = typeof state.planning?.intake_prompt === 'string' ? state.planning.intake_prompt.trim() : '';
    const planningQuestions = ensureArray(state.planning?.clarifying_questions).slice(0, 5);
    const draftCorrection = state?.planning?.draft_correction || null;
    const recentDiscoveries = propagatedDiscoveries.slice(-5);
    const operatorGuidance = getOperatorGuidanceLines(project, state);
    const dependencyBlockers = ensureArray(state?.workflow?.dependency_blockers);
    const actionableDependencyTargets = ensureArray(state?.workflow?.actionable_dependency_targets);
    const dependencyNextAction = typeof state?.workflow?.dependency_next_action === 'string'
      && state.workflow.dependency_next_action.trim()
      ? state.workflow.dependency_next_action.trim()
      : (dependencyBlockers.length > 0
        ? buildDependencyNextAction({
          project,
          dependencyBlockers,
          actionableTargets: actionableDependencyTargets,
          buildCycleCommand,
        }).summary
        : null);
    const implementationProfileSurface = buildImplementationProfileSurface(project, state);
    const effectiveSpecRel = specRel || state?.planning?.spec_path || project;

    return [
      '# SMIKE State',
      '',
      '## Authority',
      `Canonical state: .smike/${project}/STATE.json`,
      'Canonical operator handoff: this file (`STATE.md`)',
      `Supporting machine view: .smike/${project}/IMPLEMENTATION-HANDOFF.json`,
      `Delegation owner: ${delegation.owner || 'unknown'}`,
      `Delegation mode: ${delegation.mode || 'unknown'}`,
      ...(implementationProfileSurface
        ? [
            `Implementation profile: ${implementationProfileSurface.profile}`,
            `Runtime promotion: ${implementationProfileSurface.runtime_promotion}`,
            `Runtime follow-on roles: ${implementationProfileSurface.runtime_follow_on_roles}`,
            `Runtime roles: ${implementationProfileSurface.runtime_roles.join(', ') || 'none'}`,
          ]
        : []),
      `Authority surface: ${delegation.owner === 'runtime_orchestrator'
        ? 'Use STATE.json lifecycle plus orchestration.current_actionable_dispatch/current_actionable_capsule.'
        : 'Use STATE.json lifecycle plus current_plan.'}`,
      `Actionable dispatch: ${actionableDispatchSummary}`,
      `Actionable owner: ${actionableDispatchOwnerSummary}`,
      `Actionable lease: ${actionableDispatch?.lease_expires_at || 'none'}`,
      `Actionable capsule: ${actionableCapsuleDisplay}`,
      '',
      '## Resume',
      `Project: ${project}`,
      `Spec: ${effectiveSpecRel}`,
      `Plan: ${graphSummary}`,
      `Current: ${state.current_plan?.plan_id || 'none'}`,
      `Status: ${state.lifecycle.status}`,
      `Next: ${state.lifecycle.next_action}`,
      `Next command: ${getLifecycleNextCommand(state) || 'none'}`,
      `Advance behavior: ${state.lifecycle?.advance_behavior || 'unknown'} — ${state.lifecycle?.advance_behavior_detail || 'unknown'}`,
      ...(state.lifecycle.stop_reason ? [`Stop reason: ${state.lifecycle.stop_reason}`] : []),
      `spec_hash: ${state.planning?.spec_hash || '(unknown)'}`,
      `planning_context_hash: ${state.planning?.planning_context_hash || '(unknown)'}`,
      ...getPlanningDraftNoticeLines(state),
      '',
      '## Next Step',
      'Read this file first in a fresh Codex session.',
      ...operatorGuidance.map((line) => `- ${line}`),
      '',
      '## Actionable Surface',
      `Stage: ${orchestration.stage}`,
      `Mode: ${delegation.mode}`,
      `Owner: ${delegation.owner}`,
      ...(implementationProfileSurface
        ? [
            `Implementation profile: ${implementationProfileSurface.profile}`,
            `Runtime promotion: ${implementationProfileSurface.runtime_promotion}`,
            `Runtime follow-on roles: ${implementationProfileSurface.runtime_follow_on_roles}`,
            `Runtime roles: ${implementationProfileSurface.runtime_roles.join(', ') || 'none'}`,
          ]
        : []),
      `Actionable plan: ${actionable.plan_id || 'none'}`,
      `Dispatch: ${actionableDispatchSummary}`,
      `Owner: ${actionableDispatchOwnerSummary}`,
      `Lease: ${actionableDispatch?.lease_expires_at || 'none'}`,
      `Capsule: ${actionableCapsuleDisplay}`,
      `Command: ${getLifecycleNextCommand(state) || 'none'}`,
      `Handoff: .smike/${project}/IMPLEMENTATION-HANDOFF.json`,
      '',
      '## Planning Analysis',
      `Checker: ${planningAnalysis.checker_result || 'not-generated'}`,
      `Auditor: ${planningAnalysis.auditor_result || 'not-generated'}`,
      `Artifacts fresh: ${planningFreshness.stale ? `no (${planningFreshness.reason})` : 'yes'}`,
      ...(planningBlockers.length > 0
        ? planningBlockers.map((finding) => `- ${finding.source}:${finding.id} ${finding.title}`)
        : ['- none']),
      ...(planningPrompt
        ? [
            '',
            '## Planning Intake',
            `Prompt: ${planningPrompt}`,
            ...(planningQuestions.length > 0
              ? planningQuestions.map((question) => `- ${question}`)
              : ['- no clarifying questions captured']),
          ]
        : []),
      ...(draftCorrection
        ? [
            '',
            '## Planning Draft Correction Loop',
            `Summary: ${draftCorrection.summary || 'Refine the spec until the planning draft is promotion-ready.'}`,
            ...(normalizeStringArray(draftCorrection.fix_targets || []).length > 0
              ? [`Fix targets: ${normalizeStringArray(draftCorrection.fix_targets || []).join(', ')}`]
              : []),
            ...(ensureArray(draftCorrection.questions).length > 0
              ? ['Questions to answer:', ...ensureArray(draftCorrection.questions).map((question) => `- ${question}`)]
              : []),
            ...(ensureArray(draftCorrection.blockers).length > 0
              ? ['Promotion blockers:', ...ensureArray(draftCorrection.blockers).map((blocker) => `- ${blocker}`)]
              : []),
            ...(normalizeStringArray(draftCorrection.action_plan || []).length > 0
              ? ['One-pass spec patch:', ...normalizeStringArray(draftCorrection.action_plan || []).map((step) => `- ${step}`)]
              : []),
          ]
        : []),
      ...(dependencyBlockers.length > 0
        ? [
            '',
            '## Dependency Blockers',
            `Summary: ${describeDependencyBlockers(dependencyBlockers)}`,
            `Actionable upstream plans: ${actionableDependencyTargets.length > 0 ? describeDependencyTargets(actionableDependencyTargets) : 'none'}`,
            `Do this now: ${dependencyNextAction || 'Resolve the upstream dependency chain, then rerun the cycle.'}`,
            `Reconcile after upstream changes: ${buildCycleCommand(project)}`,
          ]
        : []),
      '## Runtime Dispatches',
      `Dispatch group: ${dispatchSummary.group}`,
      `Completable group: ${dispatchSummary.completable_group}`,
      `Actionable plan ids: ${dispatchSummary.plan_ids}`,
      `Ready dispatches: ${state?.orchestration?.runtime_dispatch_view?.dispatch_counts?.ready || 0}`,
      `Tracked dispatches: ${state?.orchestration?.runtime_dispatch_view?.dispatch_counts?.tracked || currentDispatches.length}`,
      ...(currentDispatches.length > 0
        ? currentDispatches.map((entry) => {
            const freshness = entry.freshness?.status || 'pending';
            return `- ${entry.dispatch_id}: ${entry.role} [group ${entry.group}] ${entry.status} / ${freshness} / owner ${summarizeRuntimeDispatchOwner(entry.active_owner || entry.last_owner)} / lease ${getRuntimeDispatchLeaseExpiry(entry) || 'none'}`;
          })
        : ['- none']),
      '',
      '## Notes',
      ...(latestCapsules.length > 0
        ? [`Latest capsules: ${latestCapsules.map(([role]) => role).join(', ')}`]
        : ['Latest capsules: none']),
      ...(ensureArray(state.gotchas).length > 0
        ? ensureArray(state.gotchas).slice(0, 5).map((gotcha) => `- Gotcha: ${gotcha}`)
        : ['- Gotcha: none']),
      ...(recentDiscoveries.length > 0
        ? recentDiscoveries.map((entry) => {
            const targets = ensureArray(entry.target_plan_ids).join(', ') || 'none';
            const discoveries = ensureArray(entry.discoveries).join('; ');
            return `- Discovery: ${entry.source_plan_id} -> ${targets}: ${discoveries}`;
          })
        : ['- Discovery: none']),
      '',
    ].join('\n');
  };
}
