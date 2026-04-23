import {
  countBlockingFindings,
  globsLikelyOverlap,
  hasDependencyPath,
  scoreDeliverableAgainstPlan,
  tokenize,
  topologicalOrder,
} from './planning-analysis-utils.mjs';
import {
  createPortabilityHeuristics,
  DEFAULT_GENERIC_VERIFY_COMMAND_IDS,
} from './portability-heuristics.mjs';

const portabilityHeuristics = createPortabilityHeuristics();

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(
    ensureArray(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )];
}

function normalizeSentence(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function usesOnlyGenericVerification(plan) {
  return plan.verify_commands.length > 0
    && plan.verify_commands.every((command) => DEFAULT_GENERIC_VERIFY_COMMAND_IDS.has(command.id));
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

function buildWriteScopeReferenceTokens(plan) {
  return uniqueStrings(
    ensureArray([
      ...ensureArray(plan.allowed_files),
      ...ensureArray(plan.write_scope_allowed_files),
    ])
      .filter((entry) => portabilityHeuristics.isLikelySourcePath(entry))
      .flatMap((entry) => tokenize(String(entry || ''))),
  ).filter((token) => !new Set(['src', 'lib', 'app', 'apps', 'packages', 'routes', 'scripts', 'tests']).has(token));
}

function normalizePathEntry(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function collectWriteScopeEntries(plan) {
  return uniqueStrings([
    ...ensureArray(plan.allowed_files),
    ...ensureArray(plan.write_scope_allowed_files),
  ]).map((entry) => normalizePathEntry(entry));
}

function hasWildcard(entry) {
  return /[*?[{]/.test(String(entry || ''));
}

function isConventionalRouteScopeEntry(entry) {
  const normalized = normalizePathEntry(entry);
  if (!normalized || hasWildcard(normalized) || !portabilityHeuristics.isLikelySourcePath(normalized)) {
    return false;
  }
  return /(^|\/)routes\/[^/]+\.[^/]+$/i.test(normalized);
}

function isLikelyRouteWiringEntry(entry) {
  const normalized = normalizePathEntry(entry);
  if (!normalized || hasWildcard(normalized) || !portabilityHeuristics.isLikelySourcePath(normalized)) {
    return false;
  }
  return /(^|\/)(app|server|main|index|router|routes|worker|entry)\.[^/]+$/i.test(normalized)
    || /(^|\/)(app|server|main|router|routes)\/index\.[^/]+$/i.test(normalized);
}

function planHasConventionalRouteScope(plan) {
  return collectWriteScopeEntries(plan).some((entry) => isConventionalRouteScopeEntry(entry));
}

function planHasRouteWiringScope(plan) {
  return collectWriteScopeEntries(plan).some((entry) => isLikelyRouteWiringEntry(entry));
}

function routeVerificationNeedsBehavioralProof(plan) {
  if (!planHasConventionalRouteScope(plan)) {
    return false;
  }
  const verifyCommands = ensureArray(plan.verify_commands);
  if (verifyCommands.length === 0) {
    return true;
  }
  return !verifyCommands.some((command) => portabilityHeuristics.looksLikeBehavioralVerificationCommand(command));
}

function verificationLooksDetachedFromCodeScope(plan) {
  if (!portabilityHeuristics.planHasCodeScope(plan)) {
    return false;
  }

  const verifyCommands = ensureArray(plan.verify_commands);
  if (verifyCommands.length === 0) {
    return false;
  }
  if (verifyCommands.some((command) => portabilityHeuristics.looksLikeVerificationCoverageCommand(command) || portabilityHeuristics.looksLikeTestVerificationCommand(command))) {
    return false;
  }

  const scopeTokens = buildWriteScopeReferenceTokens(plan);
  if (scopeTokens.length === 0) {
    return false;
  }

  const verifyText = verifyCommands
    .flatMap((command) => [command?.id, command?.run])
    .map((value) => String(value || '').toLowerCase())
    .join(' ');

  return !scopeTokens.some((token) => verifyText.includes(token));
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
  return Array.isArray(bundle?.first_phase_contract_items) ? bundle.first_phase_contract_items : [];
}

export function createBuildPlanningCheckerRecord({
  nowIso,
}) {
  return function buildPlanningCheckerRecord(bundle, phasePlans) {
    const findings = [];
    const explicitDependencies = phasePlans.some((plan) => (plan.metadata?.dependency_mode || plan.dependency_mode) === 'explicit');
    const planIds = new Set(phasePlans.map((plan) => plan.plan_id));
    const topological = topologicalOrder(phasePlans);
    const codeScopedPlans = phasePlans.filter((plan) => portabilityHeuristics.planHasCodeScope(plan));
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

      const codeScope = portabilityHeuristics.planHasCodeScope(plan);
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

      if (verificationLooksDetachedFromCodeScope(plan)) {
        findings.push({
          id: `detached-proof-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} proof surface is detached from the code-bearing write scope`,
          details: 'Verification commands do not reference code-bearing write-scope targets and do not run tests, builds, or other coverage commands. Tighten the proof surface before execution can pass.',
          origin: 'checker',
        });
      }

      if (routeVerificationNeedsBehavioralProof(plan)) {
        findings.push({
          id: `route-behavioral-proof-gap-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} route verification is inspection-only`,
          details: 'This phase owns conventional route modules, but its proof surface is limited to grep/printf-style inspection or other non-behavioral commands. Add a behavioral route check such as an HTTP/request assertion, test run, or executable proof script before planning can pass.',
          origin: 'checker',
        });
      }

      if (planHasConventionalRouteScope(plan) && !planHasRouteWiringScope(plan)) {
        findings.push({
          id: `route-wiring-scope-${plan.plan_id}`,
          severity: 'medium',
          title: `Plan ${plan.plan_id} route scope omits likely router wiring ownership`,
          details: 'This phase owns conventional route files under a routes/ directory, but no likely router or entrypoint file is in write scope. Add the registration surface (for example app.ts, server.ts, router.ts, or index.ts) or narrow the route scope so the wiring assumption is explicit.',
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
