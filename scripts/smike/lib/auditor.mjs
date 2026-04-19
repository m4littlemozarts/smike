import {
  countBlockingFindings,
  scoreDeliverableAgainstPlan,
  tokenize,
} from './planning-analysis-utils.mjs';

export function createBuildPlanningAuditorRecord({
  nowIso,
}) {
  return function buildPlanningAuditorRecord(bundle, phasePlans) {
    const findings = [];
    const mappings = [];
    const auditCandidates = [
      {
        plan_id: 'planning-root',
        phase: 'Planning root',
        objective: bundle.objective,
        scope: [
          ...bundle.constraints,
          ...bundle.phase_blueprints.map((phase) => `${phase.id} ${phase.title} ${phase.summary}`),
          'ROADMAP PLAN-GRAPH STRATEGY PLAN',
        ].join(' '),
        allowed_files: [],
        write_scope_allowed_files: ['.smike/**'],
        delegation: {
          result_artifacts: ['ROADMAP.md', 'PLAN-GRAPH.json', 'STRATEGY.md', 'PLAN.md'],
        },
      },
      ...phasePlans,
    ];

    for (const deliverable of bundle.deliverables || []) {
      const deliverableTokens = tokenize(deliverable);
      const ranked = auditCandidates
        .map((plan) => ({
          plan_id: plan.plan_id,
          title: plan.phase,
          ...scoreDeliverableAgainstPlan(deliverable, plan),
        }))
        .sort((left, right) => right.score - left.score || left.plan_id.localeCompare(right.plan_id));

      const bestMatch = ranked[0] || null;
      const weakMatch = bestMatch
        && bestMatch.score > 0
        && bestMatch.score < 2
        && !bestMatch.fileMatch
        && deliverableTokens.length >= 3;
      mappings.push({
        deliverable,
        plan_id: bestMatch?.score > 0 ? bestMatch.plan_id : null,
        score: bestMatch?.score || 0,
        overlap: bestMatch?.overlap || [],
        match_type: bestMatch?.fileMatch ? 'file-scope' : weakMatch ? 'weak-keyword' : bestMatch?.score > 0 ? 'keyword' : 'none',
      });

      if (!bestMatch || bestMatch.score === 0) {
        findings.push({
          id: `deliverable-gap-${mappings.length}`,
          severity: 'high',
          title: 'A deliverable is not mapped to any phase',
          details: `No phase credibly covers: ${deliverable}.`,
          origin: 'auditor',
        });
        continue;
      }

      if (weakMatch) {
        findings.push({
          id: `deliverable-weak-match-${mappings.length}`,
          severity: 'medium',
          title: 'A deliverable is covered only by a weak phase match',
          details: `${deliverable} maps weakly to ${bestMatch.plan_id} using keyword overlap only (${bestMatch.overlap.join(', ') || 'none'}).`,
          origin: 'auditor',
        });
      }
    }

    return {
      generated_at: nowIso(),
      result: countBlockingFindings(findings) === 0 ? 'pass' : 'concerns',
      mappings,
      findings,
    };
  };
}

export const createBuildPlanningAuditRecord = createBuildPlanningAuditorRecord;
