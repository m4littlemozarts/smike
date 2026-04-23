import fs from 'node:fs';
import path from 'node:path';

export function createPlanningAnalysisStateHelpers({
  repoRoot,
  readOptionalJson,
  walkRelativeFiles,
  ensureArray,
  buildRecheckCommand,
  nowIso,
}) {
  function getExistingMtimeMs(filePath) {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  function rel(filePath) {
    return path.relative(repoRoot, filePath).replaceAll(path.sep, '/');
  }

  function getPlanningPhasePlanPaths(paths, bundle = null) {
    if (bundle && Array.isArray(bundle.phase_blueprints)) {
      return bundle.phase_blueprints
        .map((phase) => path.join(paths.projectDir, 'phases', phase.id, `${phase.id}-PLAN.json`))
        .filter((filePath) => fs.existsSync(filePath));
    }

    const phasesDir = path.join(paths.projectDir, 'phases');
    if (!fs.existsSync(phasesDir)) {
      return [];
    }

    return walkRelativeFiles(phasesDir)
      .filter((relativePath) => /-PLAN\.json$/.test(relativePath))
      .map((relativePath) => path.join(phasesDir, relativePath))
      .filter((filePath) => fs.existsSync(filePath));
  }

  function getPlanningSourceArtifactPaths(paths, bundle = null) {
    return [
      paths.planJsonPath,
      paths.planMdPath,
      ...getPlanningPhasePlanPaths(paths, bundle),
    ].filter((filePath) => fs.existsSync(filePath));
  }

  function getPlanningVerificationArtifactPaths(paths) {
    return [
      paths.planningCheckerJsonPath,
      paths.planningAuditorJsonPath,
      paths.verdictReportPath,
      paths.reviewReportPath,
    ].filter((filePath) => fs.existsSync(filePath));
  }

  function getPlanningArtifactFreshness(paths, bundle = null) {
    const sourcePaths = getPlanningSourceArtifactPaths(paths, bundle);
    const verificationPaths = getPlanningVerificationArtifactPaths(paths);
    if (sourcePaths.length === 0) {
      return {
        stale: false,
        reason: null,
        source_paths: [],
        verification_paths: verificationPaths.map(rel),
        stale_outputs: [],
      };
    }

    const latestSource = sourcePaths
      .map((filePath) => ({ filePath, mtimeMs: getExistingMtimeMs(filePath) || 0 }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

    if (verificationPaths.length === 0) {
      return {
        stale: true,
        reason: 'planning verification artifacts are missing',
        source_paths: sourcePaths.map(rel),
        verification_paths: [],
        stale_outputs: [],
      };
    }

    const staleOutputs = verificationPaths.filter((filePath) => {
      const mtimeMs = getExistingMtimeMs(filePath);
      return typeof mtimeMs !== 'number' || mtimeMs < latestSource.mtimeMs;
    });

    return {
      stale: staleOutputs.length > 0,
      reason: staleOutputs.length > 0
        ? `planning sources changed after verification (${staleOutputs.map((filePath) => path.basename(filePath)).join(', ')})`
        : null,
      source_paths: sourcePaths.map(rel),
      verification_paths: verificationPaths.map(rel),
      stale_outputs: staleOutputs.map(rel),
    };
  }

  function buildPlanningVerificationState(freshness) {
    return {
      checked_at: nowIso(),
      stale: freshness.stale,
      reason: freshness.reason,
      source_paths: freshness.source_paths,
      verification_paths: freshness.verification_paths,
      stale_outputs: freshness.stale_outputs,
    };
  }

  function syncPlanningVerificationState(state, paths, freshness = null) {
    const resolvedFreshness = freshness || getPlanningArtifactFreshness(paths);
    if (state?.planning && typeof state.planning === 'object' && !Array.isArray(state.planning)) {
      state.planning = {
        ...state.planning,
        verification: buildPlanningVerificationState(resolvedFreshness),
      };
    }
    return resolvedFreshness;
  }

  function loadPlanningAnalysis(paths) {
    const checker = readOptionalJson(paths.planningCheckerJsonPath);
    const auditor = readOptionalJson(paths.planningAuditorJsonPath);
    const freshness = getPlanningArtifactFreshness(paths);
    const normalizeFindings = (report, source) => ensureArray(report?.findings).map((finding) => ({
      source,
      id: finding?.id || `${source}-unknown`,
      severity: finding?.severity || 'low',
      title: finding?.title || 'Unknown planning finding',
      details: finding?.details || '',
    }));
    const findings = [
      ...normalizeFindings(checker, 'checker'),
      ...normalizeFindings(auditor, 'auditor'),
    ];
    const blockingFindings = findings.filter((finding) => finding.severity !== 'low');

    return {
      checker,
      auditor,
      freshness,
      findings,
      blocking_findings: blockingFindings,
    };
  }

  function buildPlanningBlockedNextAction(project, paths, planningAnalysis) {
    if (planningAnalysis?.freshness?.stale) {
      const staleOutputs = ensureArray(planningAnalysis.freshness.stale_outputs)
        .map((filePath) => path.basename(filePath))
        .filter(Boolean);
      const staleSummary = staleOutputs.length > 0
        ? ` Stale verification outputs: ${staleOutputs.join(', ')}.`
        : '';
      return `Planning artifacts changed since the last verified run. Rerun \`${buildRecheckCommand(project)}\` before execution can continue.${staleSummary}`;
    }

    const findingSummary = planningAnalysis.blocking_findings
      .slice(0, 4)
      .map((finding) => `${finding.source}:${finding.id}`)
      .join(', ');
    const suffix = findingSummary ? ` Top blockers: ${findingSummary}.` : '';
    const docs = [
      planningAnalysis.checker ? `.smike/${project}/CHECKER.json` : null,
      planningAnalysis.auditor ? `.smike/${project}/AUDITOR.json` : null,
    ].filter(Boolean);
    const docText = docs.length > 0 ? docs.join(' and ') : `.smike/${project}/PLAN.md`;
    return `Resolve planning findings in ${docText}, then rerun \`${buildRecheckCommand(project)}\`.${suffix}`;
  }

  return {
    loadPlanningAnalysis,
    getPlanningPhasePlanPaths,
    getPlanningSourceArtifactPaths,
    getPlanningVerificationArtifactPaths,
    getPlanningArtifactFreshness,
    buildPlanningVerificationState,
    syncPlanningVerificationState,
    buildPlanningBlockedNextAction,
  };
}
