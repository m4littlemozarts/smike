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

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
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

function getFirstPhasePromotionBlockers(bundle, phaseContracts) {
  const firstPhaseItems = Array.isArray(bundle?.first_phase_contract_items) ? bundle.first_phase_contract_items : [];
  if (firstPhaseItems.length === 0 || phaseContracts.length === 0) {
    return [];
  }

  const firstContract = phaseContracts[0];
  const strongCoverage = firstPhaseItems.filter((item) => coverageRatio(item, firstContract?.analysisPlan) >= 0.5);
  const minimumStrongCoverage = Math.max(1, Math.ceil(firstPhaseItems.length * 0.6));
  const blockers = [];

  if (strongCoverage.length < minimumStrongCoverage) {
    blockers.push(
      `${firstContract?.phase?.id || '01'}: first-phase contract is under-owned; add explicit scope, acceptance, or verify coverage for ${firstPhaseItems.filter((item) => coverageRatio(item, firstContract?.analysisPlan) < 0.5).slice(0, 3).join('; ')}`,
    );
  }

  const ownershipConflicts = firstPhaseItems
    .map((item) => {
      const firstCoverage = coverageRatio(item, firstContract?.analysisPlan);
      const laterOwner = phaseContracts.slice(1).find((contract) => coverageRatio(item, contract?.analysisPlan) >= 0.5);
      if (firstCoverage >= 0.5 || !laterOwner) {
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

export const DEFAULT_GENERIC_PLANNING_VERIFY_COMMAND_IDS = new Set([
  'typecheck',
  'unit-tests',
  'doc-paths',
  'phase-ready',
  'research-artifacts',
]);

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
  }

  for (const token of normalizeStringArray(bundle?.unresolved_ref_tokens || [])) {
    blockers.push(`Resolve unresolved spec reference token ${token}`);
  }

  const lintFindings = ensureArray(bundle?.lint?.findings)
    .filter((finding) => finding?.severity && finding.severity !== 'low')
    .map((finding) => finding?.id)
    .filter(Boolean);
  for (const lintId of lintFindings) {
    blockers.push(`Resolve planning spec lint ${lintId}`);
  }

  for (const blocker of getFirstPhasePromotionBlockers(bundle, phaseContracts)) {
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
    && ensureArray(planningAnalysis?.blocking_findings).length === 0,
  );
}
