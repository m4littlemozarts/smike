const PLANNING_DRAFT_LIFECYCLE_STATUS = 'planning_draft';

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(values) {
  return ensureArray(values)
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  return normalizeStringArray(values).filter(
    (value, index, array) => array.indexOf(value) === index,
  );
}

function isPlanningDraftState(state) {
  return state?.lifecycle?.status === PLANNING_DRAFT_LIFECYCLE_STATUS || state?.planning?.status === 'draft';
}

function groupPlanningDraftBlockersByPhase(blockers) {
  const byPhase = new Map();
  for (const blocker of ensureArray(blockers)) {
    const match = typeof blocker === 'string' ? blocker.match(/^([0-9]{2}):\s*(.+)$/) : null;
    if (!match) {
      continue;
    }
    const [, planId, issue] = match;
    if (!byPhase.has(planId)) {
      byPhase.set(planId, []);
    }
    byPhase.get(planId).push(issue.trim());
  }
  return [...byPhase.entries()].map(([plan_id, issues]) => ({
    plan_id,
    issues: uniqueStrings(issues),
  }));
}

function summarizePlanningDraftPhaseIssue(issue) {
  if (issue.includes('phase-specific proof command')) {
    return 'add a phase-specific proof command';
  }
  if (issue.includes('write-scope entry')) {
    return 'tighten write scope';
  }
  if (issue.includes('concrete phase summary')) {
    return 'replace the fallback phase summary with repo-aware scope';
  }
  return issue;
}

export function buildPlanningDraftCorrectionLoop(promotionCheck, bundle = null) {
  const blockers = ensureArray(promotionCheck?.blockers).slice(0, 6);
  const questions = ensureArray(bundle?.clarifying_questions).slice(0, 3);
  const phaseRequirements = groupPlanningDraftBlockersByPhase(blockers);
  const fixTargets = [];
  const summaryParts = [];
  const actionPlan = [];

  if (questions.length > 0) {
    summaryParts.push('answer the onboarding questions in the spec');
    fixTargets.push('Clarifying Questions');
    actionPlan.push(`Answer the onboarding questions in \`## Clarifying Questions\`: ${questions.join(' / ')}`);
  }

  if (ensureArray(bundle?.primary_refs).length === 0) {
    summaryParts.push('add the missing repo truth sources');
    fixTargets.push('What The Planner Must Read First');
    actionPlan.push('Add canonical repo truth sources under `## What The Planner Must Read First`.');
  }

  if (blockers.some((blocker) => blocker.includes('concrete phase summary'))) {
    summaryParts.push('replace generic phase summaries with concrete repo-aware scope');
    fixTargets.push('Priority N summaries');
  }

  if (blockers.some((blocker) => blocker.includes('write-scope entry'))) {
    summaryParts.push('add repo-aware write-scope entries');
    fixTargets.push('Required Planning Output Shape');
  }

  if (blockers.some((blocker) => blocker.includes('phase-specific proof command'))) {
    summaryParts.push('add at least one phase-specific proof command per phase');
    fixTargets.push('inline verify: commands');
  }

  if (blockers.some((blocker) => blocker.includes('Resolve unresolved spec reference token'))) {
    summaryParts.push('replace unresolved spec reference tokens with canonical repo paths');
    fixTargets.push('What The Planner Must Read First');
  }

  if (blockers.some((blocker) => blocker.includes('Resolve planning spec lint'))) {
    summaryParts.push('resolve the remaining planning-spec lint blockers');
  }

  if (blockers.some((blocker) => blocker.includes('first-phase'))) {
    summaryParts.push('tighten first-phase ownership before promotion');
    fixTargets.push('Priority 1 summary');
  }

  if (phaseRequirements.length > 0) {
    actionPlan.push(...phaseRequirements.map((phaseRequirement) => (
      `For Plan ${phaseRequirement.plan_id}, ${phaseRequirement.issues.map(summarizePlanningDraftPhaseIssue).join(', ')}.`
    )));
  }

  const uncategorizedBlockers = blockers.filter((blocker) => (
    !blocker.includes('concrete phase summary')
    && !blocker.includes('write-scope entry')
    && !blocker.includes('phase-specific proof command')
    && !blocker.includes('Resolve unresolved spec reference token')
    && !blocker.includes('Resolve planning spec lint')
    && !blocker.includes('first-phase')
  ));
  if (summaryParts.length === 0 && uncategorizedBlockers.length > 0) {
    summaryParts.push(uncategorizedBlockers[0]);
  }

  return {
    summary: summaryParts.join('; '),
    questions,
    blockers,
    fix_targets: uniqueStrings(fixTargets),
    action_plan: uniqueStrings(actionPlan),
    phase_requirements: phaseRequirements,
  };
}

export function getPlanningDraftNoticeLines(state) {
  if (!isPlanningDraftState(state)) {
    return [];
  }
  const correction = state?.planning?.draft_correction;
  const fixTargets = normalizeStringArray(correction?.fix_targets || []);
  return [
    'Planning draft notice: edits to `.smike/**` are rebuilt from the spec on the next cycle.',
    fixTargets.length > 0
      ? `Fix surface: update ${fixTargets.join(', ')} in the spec, then rerun the cycle.`
      : 'Fix surface: update the spec’s `Required Planning Output Shape`, `Priority N:` summaries, and inline `verify:` commands.',
  ];
}

export function getPlanningDraftCorrectionSummaryLines(state) {
  if (!isPlanningDraftState(state)) {
    return [];
  }
  const correction = state?.planning?.draft_correction;
  if (!correction || typeof correction !== 'object') {
    return [];
  }

  const lines = [];
  if (typeof correction.summary === 'string' && correction.summary.trim()) {
    lines.push(`planning_draft_summary: ${correction.summary.trim()}`);
  }
  const fixTargets = normalizeStringArray(correction.fix_targets || []);
  if (fixTargets.length > 0) {
    lines.push(`planning_draft_fix_targets: ${fixTargets.join(', ')}`);
  }
  const questions = ensureArray(correction.questions).slice(0, 3);
  if (questions.length > 0) {
    lines.push(`planning_draft_questions: ${questions.join(' / ')}`);
  }
  const blockers = ensureArray(correction.blockers).slice(0, 4);
  if (blockers.length > 0) {
    lines.push(`planning_draft_blockers: ${blockers.join('; ')}`);
  }
  const actionPlan = normalizeStringArray(correction.action_plan || []);
  if (actionPlan.length > 0) {
    lines.push(`planning_draft_action_plan: ${actionPlan.join(' | ')}`);
  }
  return lines;
}

export function describeDependencyBlockers(dependencyBlockers) {
  return ensureArray(dependencyBlockers).map((blocker) => {
    const unmet = ensureArray(blocker.unmet_dependencies)
      .map((dependency) => `${dependency.plan_id} (${dependency.status})`)
      .join(', ');
    return `${blocker.plan_id} <= ${unmet}`;
  }).join('; ');
}

export function getActionableDependencyTargets(dependencyBlockers) {
  const blockers = ensureArray(dependencyBlockers);
  const blockedPlanIds = new Set(blockers.map((blocker) => blocker.plan_id));
  const actionableTargets = [];

  for (const blocker of blockers) {
    for (const dependency of ensureArray(blocker.unmet_dependencies)) {
      if (!dependency?.plan_id) {
        continue;
      }
      if (!dependency.external && blockedPlanIds.has(dependency.plan_id)) {
        continue;
      }
      actionableTargets.push({
        plan_id: dependency.plan_id,
        status: dependency.status || 'pending',
      });
    }
  }

  return actionableTargets.filter((target, index, array) => array.findIndex(
    (candidate) => candidate.plan_id === target.plan_id && candidate.status === target.status,
  ) === index);
}

export function describeDependencyTargets(targets) {
  return ensureArray(targets)
    .map((target) => `${target.plan_id} (${target.status})`)
    .join(', ');
}

export function buildDependencyNextAction({ project, dependencyBlockers, actionableTargets, buildCycleCommand }) {
  const targets = ensureArray(actionableTargets).length > 0
    ? ensureArray(actionableTargets)
    : getActionableDependencyTargets(dependencyBlockers);
  if (targets.length === 0) {
    return {
      summary: `Unblock dependency blockers: ${describeDependencyBlockers(ensureArray(dependencyBlockers))}.`,
      next_command: buildCycleCommand(project),
    };
  }

  const primaryTarget = targets[0];
  const blockedPlans = ensureArray(dependencyBlockers)
    .filter((blocker) => ensureArray(blocker.unmet_dependencies).some((dependency) => dependency.plan_id === primaryTarget.plan_id))
    .map((blocker) => blocker.plan_id);
  const blockedSuffix = blockedPlans.length > 0
    ? ` so ${blockedPlans.join(', ')} can run`
    : '';
  return {
    summary:
      `Finish upstream plan ${primaryTarget.plan_id} (${primaryTarget.status}) first${blockedSuffix}, `
      + `then rerun \`${buildCycleCommand(project)}\`.`,
    next_command: buildCycleCommand(project),
  };
}

export function getDependencyBlockerSummaryLines({ project, state, buildCycleCommand }) {
  const dependencyBlockers = ensureArray(state?.workflow?.dependency_blockers);
  if (dependencyBlockers.length === 0) {
    return [];
  }

  const actionableTargets = ensureArray(state?.workflow?.actionable_dependency_targets).length > 0
    ? ensureArray(state?.workflow?.actionable_dependency_targets)
    : getActionableDependencyTargets(dependencyBlockers);
  const lines = [
    `dependency_blockers: ${describeDependencyBlockers(dependencyBlockers)}`,
  ];
  if (actionableTargets.length > 0) {
    lines.push(
      `dependency_unblock: resolve upstream plan(s) first: ${describeDependencyTargets(actionableTargets)}; then rerun ${buildCycleCommand(project)}.`,
    );
  }
  const nextAction = buildDependencyNextAction({
    project,
    dependencyBlockers,
    actionableTargets,
    buildCycleCommand,
  });
  if (nextAction.summary) {
    lines.push(`dependency_next_action: ${nextAction.summary}`);
  }
  return lines;
}
