import {
  createPortabilityHeuristics,
  DEFAULT_GENERIC_VERIFY_COMMAND_IDS,
} from './portability-heuristics.mjs';
import { globsLikelyOverlap, hasDependencyPath } from './planning-analysis-utils.mjs';

const portabilityHeuristics = createPortabilityHeuristics();

const COVERAGE_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'this',
  'that',
  'must',
  'does',
  'then',
  'than',
  'only',
  'clear',
  'gets',
  'plan',
  'phase',
  'behavior',
  'access',
  'later',
]);
const NEGATIVE_REQUIREMENT_MARKERS = new Set([
  'do',
  'not',
  'must',
  'without',
  'avoid',
  'exclude',
  'out',
  'scope',
  'stop',
  'short',
]);

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(
    ensureArray(values)
      .map((value) => String(value).trim())
      .filter(Boolean),
  )];
}

function normalizePathList(values) {
  return uniqueStrings(values);
}

function normalizeStringArray(values) {
  return uniqueStrings(values);
}

function normalizePathEntry(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

function hasWildcard(entry) {
  return /[*?[{]/.test(String(entry || ''));
}

function collectWriteScopeEntries(contract) {
  return normalizePathList(
    contract?.phasePlan?.write_scope?.allowed_files
    || contract?.analysisPlan?.write_scope_allowed_files
    || [],
  ).map((entry) => normalizePathEntry(entry));
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

function contractHasConventionalRouteScope(contract) {
  return collectWriteScopeEntries(contract).some((entry) => isConventionalRouteScopeEntry(entry));
}

function contractHasRouteWiringScope(contract) {
  return collectWriteScopeEntries(contract).some((entry) => isLikelyRouteWiringEntry(entry));
}

function contractNeedsBehavioralRouteProof(contract) {
  if (!contractHasConventionalRouteScope(contract)) {
    return false;
  }
  const verifyCommands = ensureArray(contract?.analysisPlan?.verify_commands);
  if (verifyCommands.length === 0) {
    return true;
  }
  return !verifyCommands.some((command) => portabilityHeuristics.looksLikeBehavioralVerificationCommand(command));
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !COVERAGE_STOP_WORDS.has(token));
}

function buildCoverageText(analysisPlan) {
  return [
    analysisPlan?.objective,
    analysisPlan?.scope,
    ...ensureArray(analysisPlan?.acceptance_criteria).flatMap((criterion) => [
      criterion?.id,
      criterion?.description,
      ...ensureArray(criterion?.signals).map((signal) => signal?.expected_signal),
    ]),
    ...ensureArray(analysisPlan?.verify_commands).flatMap((command) => [
      command?.id,
      command?.run,
    ]),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
}

function coverageRatio(requirement, analysisPlan) {
  const requirementTokens = tokenize(requirement);
  if (requirementTokens.length === 0) {
    return 0;
  }
  const coverageTokens = tokenize(buildCoverageText(analysisPlan));
  const overlap = requirementTokens.filter((token) => coverageTokens.includes(token));
  return overlap.length / requirementTokens.length;
}

function requirementLooksNegative(requirement) {
  return /\b(do not|don't|must not|without|avoid|exclude|out of scope|stop short)\b/i.test(String(requirement || ''));
}

function negativeRequirementCovered(requirement, analysisPlan) {
  if (!requirementLooksNegative(requirement)) {
    return false;
  }

  const requirementTokens = tokenize(requirement)
    .filter((token) => !NEGATIVE_REQUIREMENT_MARKERS.has(token));
  if (requirementTokens.length === 0) {
    return false;
  }

  const coverageText = buildCoverageText(analysisPlan).toLowerCase();
  const coverageTokens = tokenize(coverageText);
  const overlap = requirementTokens.filter((token) => coverageTokens.includes(token));
  const hasNegativeBoundary = /\b(do not|must not|without|out of scope|stop short|narrow|only)\b/i.test(coverageText);
  return hasNegativeBoundary && overlap.length >= Math.min(2, requirementTokens.length);
}

function requirementCoverageScore(requirement, analysisPlan) {
  if (negativeRequirementCovered(requirement, analysisPlan)) {
    return 1;
  }
  return coverageRatio(requirement, analysisPlan);
}

function getFirstPhasePromotionBlockers(bundle, phaseContracts) {
  const firstPhaseItems = Array.isArray(bundle?.first_phase_contract_items) ? bundle.first_phase_contract_items : [];
  if (firstPhaseItems.length === 0 || phaseContracts.length === 0) {
    return [];
  }

  const firstContract = phaseContracts[0];
  const strongCoverage = firstPhaseItems.filter((item) => requirementCoverageScore(item, firstContract?.analysisPlan) >= 0.34);
  const minimumStrongCoverage = Math.max(1, Math.ceil(firstPhaseItems.length * 0.5));
  const blockers = [];

  if (strongCoverage.length < minimumStrongCoverage) {
    blockers.push(
      `${firstContract?.phase?.id || '01'}: first-phase contract is under-owned; add explicit scope, acceptance, or verify coverage for ${firstPhaseItems.filter((item) => requirementCoverageScore(item, firstContract?.analysisPlan) < 0.34).slice(0, 3).join('; ')}`,
    );
  }

  const ownershipConflicts = firstPhaseItems
    .map((item) => {
      const firstCoverage = requirementCoverageScore(item, firstContract?.analysisPlan);
      const laterOwner = phaseContracts.slice(1).find((contract) => requirementCoverageScore(item, contract?.analysisPlan) >= 0.34);
      if (firstCoverage >= 0.34 || !laterOwner) {
        return null;
      }
      return `${item} -> ${laterOwner?.phase?.id || 'later-phase'}`;
    })
    .filter(Boolean);

  if (ownershipConflicts.length > 0) {
    blockers.push(`Resolve first-phase ownership drift before promotion: ${ownershipConflicts.join('; ')}`);
  }

  return blockers;
}

function normalizeWriteScopeEntries(contract) {
  return normalizePathList(contract?.phasePlan?.write_scope?.allowed_files || []);
}

function findParallelScopeCollisionBlockers(phaseContracts) {
  const blockers = [];

  for (let index = 0; index < phaseContracts.length; index += 1) {
    const left = phaseContracts[index];
    const leftPlanId = left?.phase?.id || left?.analysisPlan?.plan_id || `phase-${index + 1}`;
    const leftScope = normalizeWriteScopeEntries(left);

    for (let otherIndex = index + 1; otherIndex < phaseContracts.length; otherIndex += 1) {
      const right = phaseContracts[otherIndex];
      const rightPlanId = right?.phase?.id || right?.analysisPlan?.plan_id || `phase-${otherIndex + 1}`;
      const rightScope = normalizeWriteScopeEntries(right);
      const serialized = hasDependencyPath(
        phaseContracts.map((contract) => contract?.analysisPlan || {}),
        leftPlanId,
        rightPlanId,
      ) || hasDependencyPath(
        phaseContracts.map((contract) => contract?.analysisPlan || {}),
        rightPlanId,
        leftPlanId,
      );

      if (serialized) {
        continue;
      }

      const collisions = [];
      for (const leftEntry of leftScope) {
        for (const rightEntry of rightScope) {
          if (globsLikelyOverlap(leftEntry, rightEntry)) {
            collisions.push(`${leftEntry} <> ${rightEntry}`);
          }
        }
      }

      if (collisions.length > 0) {
        blockers.push(
          `Resolve cross-phase write-scope collision before promotion: ${leftPlanId} vs ${rightPlanId} share ${collisions.slice(0, 3).join('; ')}. Replace catch-all ownership with disjoint concrete files or add the missing dependency edge.`,
        );
      }
    }
  }

  return blockers;
}

export const DEFAULT_GENERIC_PLANNING_VERIFY_COMMAND_IDS = DEFAULT_GENERIC_VERIFY_COMMAND_IDS;

export function phaseHasDraftReadySummary(phasePlan, phaseBlueprint) {
  const scopeText = String(phasePlan?.scope || '').trim();
  if (!scopeText) {
    return false;
  }
  if (String(phaseBlueprint?.summary_source || '').startsWith('fallback_')) {
    return false;
  }
  return true;
}

export function phaseHasDraftReadyProofCommand(
  analysisPlan,
  genericVerifyCommandIds = DEFAULT_GENERIC_PLANNING_VERIFY_COMMAND_IDS,
) {
  const declaredVerifyCommands = normalizeStringArray(analysisPlan?.declared_verify_commands || []);
  if (declaredVerifyCommands.length > 0) {
    return true;
  }

  const verifyIds = normalizeStringArray(
    ensureArray(analysisPlan?.verify_commands).map((command) => command?.id),
  );
  return verifyIds.some((id) => !genericVerifyCommandIds.has(id));
}

export function buildPlanningDraftPromotionCheck(
  bundle,
  phaseContracts,
  genericVerifyCommandIds = DEFAULT_GENERIC_PLANNING_VERIFY_COMMAND_IDS,
) {
  const blockers = [];

  for (const contract of ensureArray(phaseContracts)) {
    const { phase, phasePlan, analysisPlan } = contract || {};
    if (!phaseHasDraftReadySummary(phasePlan, phase)) {
      blockers.push(`${phase?.id || '??'}: add a concrete phase summary instead of fallback "Implement ..." text`);
    }
    if (normalizePathList(phasePlan?.write_scope?.allowed_files || []).length === 0) {
      blockers.push(`${phase?.id || '??'}: add at least one write-scope entry`);
    }
    if (!phaseHasDraftReadyProofCommand(analysisPlan, genericVerifyCommandIds)) {
      blockers.push(`${phase?.id || '??'}: add at least one phase-specific proof command`);
    }
    if (contractNeedsBehavioralRouteProof(contract)) {
      blockers.push(`${phase?.id || '??'}: add a behavioral route proof command instead of grep/printf-only inspection`);
    }
    if (contractHasConventionalRouteScope(contract) && !contractHasRouteWiringScope(contract)) {
      blockers.push(`${phase?.id || '??'}: add the router or entrypoint wiring surface to write scope for the route slice`);
    }
  }

  for (const token of normalizeStringArray(bundle?.unresolved_ref_tokens || [])) {
    blockers.push(`Resolve unresolved spec reference token ${token}`);
  }

  const lintFindings = ensureArray(bundle?.lint?.findings)
    .filter((finding) => finding?.severity && finding.severity !== 'low');
  for (const finding of lintFindings) {
    const lintId = typeof finding?.id === 'string' && finding.id.trim() ? finding.id.trim() : 'unknown-lint';
    const detail = typeof finding?.title === 'string' && finding.title.trim()
      ? finding.title.trim()
      : (typeof finding?.details === 'string' && finding.details.trim()
        ? finding.details.trim()
        : '');
    blockers.push(detail ? `Resolve planning spec lint ${lintId}: ${detail}` : `Resolve planning spec lint ${lintId}`);
  }

  for (const blocker of getFirstPhasePromotionBlockers(bundle, phaseContracts)) {
    blockers.push(blocker);
  }

  for (const blocker of findParallelScopeCollisionBlockers(ensureArray(phaseContracts))) {
    blockers.push(blocker);
  }

  return {
    ready: blockers.length === 0,
    blockers,
  };
}

export function planningAnalysisIsExecutionReady(planningAnalysis) {
  return Boolean(
    planningAnalysis?.checker
    && planningAnalysis?.auditor
    && planningAnalysis?.checker?.result === 'pass'
    && planningAnalysis?.auditor?.result === 'pass'
    && planningAnalysis?.freshness?.stale !== true
    && ensureArray(planningAnalysis?.blocking_findings).length === 0,
  );
}
