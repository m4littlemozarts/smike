import {
  countBlockingFindings,
  globsLikelyOverlap,
  hasDependencyPath,
  scoreDeliverableAgainstPlan,
  tokenize,
  topologicalOrder,
} from './planning-analysis-utils.mjs';

const GENERIC_VERIFY_COMMAND_IDS = new Set(['typecheck', 'unit-tests', 'doc-paths', 'phase-ready', 'research-artifacts']);

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeSentence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function hasCodeScope(plan) {
  return plan.allowed_files.some((filePath) => /^(packages|tests|scripts)\//.test(filePath));
}

function usesOnlyGenericVerification(plan) {
  return plan.verify_commands.length > 0
    && plan.verify_commands.every((command) => GENERIC_VERIFY_COMMAND_IDS.has(command.id));
}

function isFallbackPhaseScope(plan) {
  const normalizedScope = normalizeSentence(plan.scope);
  const normalizedObjective = normalizeSentence(plan.objective);
  if (!normalizedScope) {
    return true;
  }
  return normalizedScope === `implement ${normalizedObjective}`
    || normalizedScope === 'implement the recommended first executable phase'
    || normalizedScope === 'implement the spec in bounded, reviewable slices';
}

function buildPlanCoverageText(plan) {
  const parts = [
    plan.objective,
    plan.scope,
    ...ensureArray(plan.acceptance_criteria).flatMap((criterion) => [
      criterion?.id,
      criterion?.description,
      ...ensureArray(criterion?.signals).map((signal) => signal?.expected_signal),
    ]),
    ...ensureArray(plan.verify_commands).flatMap((command) => [
      command?.id,
      command?.run,
    ]),
  ];
  return parts
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function coverageRatio(requirement, plan) {
  const requirementTokens = tokenize(requirement);
  if (requirementTokens.length === 0) {
    return 0;
  }
  const match = scoreDeliverableAgainstPlan(requirement, plan);
  if (match.fileMatch) {
    return 1;
  }
  const coverageTextTokens = tokenize(buildPlanCoverageText(plan));
  const coverageOverlap = requirementTokens.filter((token) => coverageTextTokens.includes(token));
  return Math.max(match.overlap.length, coverageOverlap.length) / requirementTokens.length;
}

function rankRequirementCoverage(requirement, phasePlans) {
  return phasePlans
    .map((plan) => ({
      plan_id: plan.plan_id,
      phase: plan.phase,
      ratio: coverageRatio(requirement, plan),
    }))
    .sort((left, right) => right.ratio - left.ratio || left.plan_id.localeCompare(right.plan_id));
}

function getFirstPhaseContractItems(bundle) {
  if (Array.isArray(bundle?.first_phase_contract_items) && bundle.first_phase_contract_items.length > 0) {
    return bundle.first_phase_contract_items;
  }
  return Array.isArray(bundle?.recommended_first_phase_items) ? bundle.recommended_first_phase_items : [];
}

export function createBuildPlanningCheckerRecord({
  nowIso,
}) {
  return function buildPlanningCheckerRecord(bundle, phasePlans) {
    const findings = [];
    const explicitDependencies = phasePlans.some((plan) => (plan.metadata?.dependency_mode || plan.dependency_mode) === 'explicit');
    const planIds = new Set(phasePlans.map((plan) => plan.plan_id));
    const topological = topologicalOrder(phasePlans);
    const codeScopedPlans = phasePlans.filter((plan) => hasCodeScope(plan));
    const broadImplementationBundle = bundle.mode !== 'research'
      && (
        codeScopedPlans.length >= 2
        || (bundle.deliverables || []).length >= 3
        || (bundle.integration_requirements || []).length > 0
        || getFirstPhaseContractItems(bundle).length > 0
      );

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

      const codeScope = hasCodeScope(plan);
      const onlyGenericVerification = usesOnlyGenericVerification(plan);
      if (codeScope && onlyGenericVerification) {
        findings.push({
          id: `generic-verification-${plan.plan_id}`,
          severity: 'low',
          title: `Plan ${plan.plan_id} uses only generic verification commands`,
          details: 'Phase verification is limited to reusable defaults. Add a phase-specific check when the slice has a specialized risk surface.',
          origin: 'checker',
        });
      }

      if (broadImplementationBundle && codeScope && isFallbackPhaseScope(plan)) {
        findings.push({
          id: `generic-scope-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} still has placeholder scope text`,
          details: `The phase scope is still generic (${plan.scope}). Replace the fallback wording with concrete behavior, boundaries, and proof obligations before planning can pass.`,
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

    if (
      broadImplementationBundle
      && codeScopedPlans.length > 0
      && codeScopedPlans.every((plan) => isFallbackPhaseScope(plan))
    ) {
      findings.push({
        id: 'generic-phase-scaffolding',
        severity: 'high',
        title: 'The planning bundle is still generic scaffolding',
        details: 'Every code-bearing phase still uses fallback scope text. Planning must capture concrete behavior, boundaries, and proof obligations before the implementation gate can open.',
        origin: 'checker',
      });
    }

    if (
      broadImplementationBundle
      && codeScopedPlans.length > 0
      && codeScopedPlans.every((plan) => usesOnlyGenericVerification(plan))
    ) {
      findings.push({
        id: 'bundle-generic-verification',
        severity: 'medium',
        title: 'The planning bundle has no phase-specific verification',
        details: 'All code-bearing phases rely only on generic reusable checks such as typecheck or unit-tests. Add phase-specific proof commands before treating planning as execution-ready.',
        origin: 'checker',
      });
    }

    const firstPhaseContractItems = getFirstPhaseContractItems(bundle);
    if (broadImplementationBundle && phasePlans.length > 0 && firstPhaseContractItems.length > 0) {
      const firstPlan = phasePlans[0];
      const coverage = firstPhaseContractItems.map((item) => ({
        item,
        ratio: coverageRatio(item, firstPlan),
      }));
      const strongCoverage = coverage.filter((entry) => entry.ratio >= 0.5);
      const minimumStrongCoverage = Math.max(1, Math.ceil(coverage.length * 0.6));
      if (strongCoverage.length < minimumStrongCoverage) {
        findings.push({
          id: 'first-phase-misaligned',
          severity: 'high',
          title: 'Plan 01 does not satisfy the spec’s Plan 01 contract',
          details: `Plan ${firstPlan.plan_id} only strongly covers ${strongCoverage.length}/${coverage.length} required first-phase behaviors. Uncovered examples: ${coverage.filter((entry) => entry.ratio < 0.5).slice(0, 4).map((entry) => entry.item).join('; ')}.`,
          origin: 'checker',
        });
      }

      const ownershipConflicts = firstPhaseContractItems
        .map((item) => {
          const rankedCoverage = rankRequirementCoverage(item, phasePlans);
          const firstPlanCoverage = rankedCoverage.find((entry) => entry.plan_id === firstPlan.plan_id) || {
            plan_id: firstPlan.plan_id,
            phase: firstPlan.phase,
            ratio: 0,
          };
          const laterOwner = rankedCoverage.find(
            (entry) => entry.plan_id !== firstPlan.plan_id && entry.ratio >= 0.5,
          );
          if (!laterOwner || firstPlanCoverage.ratio >= 0.5) {
            return null;
          }
          return {
            item,
            first_plan_ratio: firstPlanCoverage.ratio,
            owner_plan_id: laterOwner.plan_id,
            owner_phase: laterOwner.phase,
            owner_ratio: laterOwner.ratio,
          };
        })
        .filter(Boolean);

      if (ownershipConflicts.length > 0) {
        findings.push({
          id: 'first-phase-ownership-conflict',
          severity: 'high',
          title: 'The Plan 01 contract assigns behaviors that later phases appear to own',
          details: ownershipConflicts
            .slice(0, 4)
            .map((conflict) => `${conflict.item} -> ${conflict.owner_plan_id} (${conflict.owner_phase})`)
            .join('; '),
          origin: 'checker',
        });
      }
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
