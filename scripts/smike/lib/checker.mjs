import {
  countBlockingFindings,
  globsLikelyOverlap,
  hasDependencyPath,
  topologicalOrder,
} from './planning-analysis-utils.mjs';

const GENERIC_VERIFY_COMMAND_IDS = new Set(['typecheck', 'unit-tests', 'doc-paths', 'phase-ready', 'research-artifacts']);

export function createBuildPlanningCheckerRecord({
  nowIso,
}) {
  return function buildPlanningCheckerRecord(bundle, phasePlans) {
    const findings = [];
    const explicitDependencies = phasePlans.some((plan) => (plan.metadata?.dependency_mode || plan.dependency_mode) === 'explicit');
    const planIds = new Set(phasePlans.map((plan) => plan.plan_id));
    const topological = topologicalOrder(phasePlans);

    for (const lintFinding of bundle.lint?.findings || []) {
      findings.push({
        ...lintFinding,
        origin: 'spec-lint',
      });
    }

    for (const [index, plan] of phasePlans.entries()) {
      const unknownDependencies = plan.depends_on.filter((dependencyId) => !planIds.has(dependencyId));
      if (unknownDependencies.length > 0) {
        findings.push({
          id: `unknown-dependency-${plan.plan_id}`,
          severity: 'high',
          title: `Plan ${plan.plan_id} references unknown dependencies`,
          details: `Unknown plan ids: ${unknownDependencies.join(', ')}.`,
          origin: 'checker',
        });
      }

      if (plan.depends_on.includes(plan.plan_id)) {
        findings.push({
          id: `self-dependency-${plan.plan_id}`,
          severity: 'high',
          title: `Plan ${plan.plan_id} depends on itself`,
          details: 'Remove the self-reference; it creates an impossible dependency.',
          origin: 'checker',
        });
      }

      const dependsOnFuturePlan = plan.depends_on.filter((dependencyId) => {
        const dependencyIndex = phasePlans.findIndex((candidate) => candidate.plan_id === dependencyId);
        return dependencyIndex > index;
      });
      if (dependsOnFuturePlan.length > 0) {
        findings.push({
          id: `ordering-drift-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} depends on a later phase in file order`,
          details: `Dependencies should appear earlier than ${plan.plan_id}: ${dependsOnFuturePlan.join(', ')}.`,
          origin: 'checker',
        });
      }

      if (!explicitDependencies && index > 0 && plan.depends_on.length === 0) {
        findings.push({
          id: `missing-dependency-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} has no declared dependency edge`,
          details: 'Later phases should declare an upstream dependency unless they are intentionally parallel.',
          origin: 'checker',
        });
      }

      const hasCodeScope = plan.allowed_files.some((filePath) => /^(packages|tests|scripts)\//.test(filePath));
      const onlyGenericVerification = plan.verify_commands.length > 0
        && plan.verify_commands.every((command) => GENERIC_VERIFY_COMMAND_IDS.has(command.id));
      if (hasCodeScope && onlyGenericVerification) {
        findings.push({
          id: `generic-verification-${plan.plan_id}`,
          severity: 'low',
          title: `Plan ${plan.plan_id} uses only generic verification commands`,
          details: 'Phase verification is limited to reusable defaults. Add a phase-specific check when the slice has a specialized risk surface.',
          origin: 'checker',
        });
      }
    }

    for (let index = 0; index < phasePlans.length; index += 1) {
      const leftPlan = phasePlans[index];
      for (let otherIndex = index + 1; otherIndex < phasePlans.length; otherIndex += 1) {
        const rightPlan = phasePlans[otherIndex];
        const collisions = [];

        for (const leftGlob of leftPlan.write_scope_allowed_files) {
          for (const rightGlob of rightPlan.write_scope_allowed_files) {
            if (globsLikelyOverlap(leftGlob, rightGlob)) {
              collisions.push(`${leftGlob} <> ${rightGlob}`);
            }
          }
        }

        if (collisions.length > 0) {
          const serialized = hasDependencyPath(phasePlans, leftPlan.plan_id, rightPlan.plan_id)
            || hasDependencyPath(phasePlans, rightPlan.plan_id, leftPlan.plan_id);
          findings.push({
            id: `scope-overlap-${leftPlan.plan_id}-${rightPlan.plan_id}`,
            severity: serialized ? 'low' : 'medium',
            title: `Plans ${leftPlan.plan_id} and ${rightPlan.plan_id} overlap in write scope`,
            details: `${serialized ? 'Serialized overlap' : 'Potential collisions'}: ${collisions.slice(0, 4).join('; ')}.`,
            origin: 'checker',
          });
        }
      }
    }

    if (topological.length !== phasePlans.length) {
      const unresolved = phasePlans
        .map((plan) => plan.plan_id)
        .filter((planId) => !topological.includes(planId));
      findings.push({
        id: 'cycle-detected',
        severity: 'high',
        title: 'The phase graph is cyclic',
        details: `Resolve dependency cycles before execution: ${unresolved.join(', ')}.`,
        origin: 'checker',
      });
    }

    return {
      generated_at: nowIso(),
      result: countBlockingFindings(findings) === 0 ? 'pass' : 'concerns',
      explicit_dependencies_declared: explicitDependencies,
      topological_order: topological,
      findings,
    };
  };
}
