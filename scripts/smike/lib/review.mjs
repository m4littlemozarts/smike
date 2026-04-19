export function createBuildReviewRecord({
  getQualityGateConfig,
  ensureArray,
  acUsesOnlyExitSignals,
  isLikelySourcePath,
  isLikelyInterfaceSurfacePath,
  isLikelyTestPath,
  getWorkspaceDirtyCheck,
  looksLikeVerificationCoverageCommand,
  nowIso,
}) {
  return function buildReviewRecord(contract, cycleRecord, verdictRecord) {
    const qualityConfig = getQualityGateConfig(contract.plan);
    const findings = [];
    const commandsById = new Map(ensureArray(contract.plan.verify_commands).map((command) => [command.id, command]));
    const changedPaths = ensureArray(cycleRecord.scope?.changed_paths);
    const weakEvidenceAcs = ensureArray(contract.plan.acceptance_criteria)
      .filter((ac) => acUsesOnlyExitSignals(ac, commandsById))
      .map((ac) => ac.id);
    const sourceChanges = changedPaths.filter((filePath) => isLikelySourcePath(filePath));
    const interfaceSurfaceChanges = changedPaths.filter((filePath) => isLikelyInterfaceSurfacePath(filePath));
    const changedTests = changedPaths.filter((filePath) => isLikelyTestPath(filePath));
    const dirtyWorkspaceCheck = getWorkspaceDirtyCheck(cycleRecord.preflight);
    const hasCoverageCommand = ensureArray(contract.plan.verify_commands).some((command) => looksLikeVerificationCoverageCommand(command));

    if (verdictRecord.result !== 'pass') {
      findings.push({
        id: 'judge-failed',
        severity: 'high',
        title: 'Independent verification failed',
        details: `JUDGE reported ${verdictRecord.failures.join(', ')}. Route fixes from VERDICT.md before treating this plan as complete.`,
      });
    }

    for (const acId of weakEvidenceAcs) {
      findings.push({
        id: `weak-evidence-${acId}`,
        severity: 'low',
        title: `Acceptance evidence is weak for ${acId}`,
        details: `${acId} relies on exit status only. Add stdout/stderr signals or stronger command expectations so JUDGE can verify behavior, not just process success.`,
      });
    }

    if (dirtyWorkspaceCheck && dirtyWorkspaceCheck.dirty_count > 0) {
      findings.push({
        id: 'baseline-dirty-worktree',
        severity: 'low',
        title: 'Review ran from a dirty baseline',
        details: `The workspace already had ${dirtyWorkspaceCheck.dirty_count} dirty path(s) before execution. Keep pre-existing changes explicit so new regressions are not hidden in the baseline.`,
      });
    }

    if (sourceChanges.length > 0 && weakEvidenceAcs.length > 0 && weakEvidenceAcs.length === ensureArray(contract.plan.acceptance_criteria).length) {
      findings.push({
        id: 'behavioral-coverage-gap',
        severity: 'medium',
        title: 'Changed source is covered only by exit-code evidence',
        details: `Changed source paths (${sourceChanges.join(', ')}) are only covered by exit-code acceptance checks (${weakEvidenceAcs.join(', ')}). Add behavioral signals or stronger verification before treating this as done.`,
      });
    }

    if (sourceChanges.length > 0 && !hasCoverageCommand && changedTests.length === 0) {
      findings.push({
        id: 'source-drift-without-coverage',
        severity: 'medium',
        title: 'Changed source lacks explicit test, typecheck, or build coverage',
        details: `Changed source paths (${sourceChanges.join(', ')}) have no explicit test/typecheck/build verification command and changed no test files. Add a stronger proof surface before treating this as done.`,
      });
    }

    if (interfaceSurfaceChanges.length > 0 && !hasCoverageCommand && changedTests.length === 0) {
      findings.push({
        id: 'interface-drift-without-coverage',
        severity: 'medium',
        title: 'Interface-bearing changes lack explicit typecheck or test coverage',
        details: `Likely interface or export surface files changed (${interfaceSurfaceChanges.join(', ')}), but the plan has no explicit test/typecheck/build verification command and changed no test files.`,
      });
    }

    const blockingFindings = findings.filter((finding) => finding.severity !== 'low');

    return {
      generated_at: nowIso(),
      result: blockingFindings.length === 0 ? 'pass' : 'concerns',
      focus_areas: qualityConfig.review.focus_areas,
      anti_patterns: qualityConfig.review.anti_patterns,
      findings,
      changed_paths: changedPaths,
      drift: cycleRecord.scope?.pass === false ? 'yes' : 'no',
    };
  };
}
