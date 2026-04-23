import fs from 'node:fs';
import path from 'node:path';

function displayPath(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative;
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        errors: [`${filePath} must parse to a JSON object`],
      };
    }
    return {
      ok: true,
      value: parsed,
      errors: [],
    };
  } catch (error) {
    return {
      ok: false,
      errors: [`${filePath} is not valid JSON: ${error.message}`],
    };
  }
}

function listDirectories(rootDir) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    return [];
  }
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function summarizeValidationErrors(errors, limit = 5) {
  return errors.slice(0, limit);
}

export function createCompatibilityAuditor({
  repoRoot,
  validatePlan,
  validateState,
  liveRoot = path.join(repoRoot, '.smike'),
  archiveRoot = path.join(repoRoot, '.smike-archive'),
  snapshotRoot = path.join(repoRoot, '.smike-snapshots'),
} = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error('repoRoot is required');
  }
  if (typeof validatePlan !== 'function') {
    throw new Error('validatePlan is required');
  }
  if (typeof validateState !== 'function') {
    throw new Error('validateState is required');
  }

  function collectCandidates() {
    const candidates = [];

    for (const projectDir of listDirectories(liveRoot)) {
      candidates.push({
        kind: 'live',
        label: displayPath(repoRoot, projectDir),
        contractRoot: projectDir,
        planPath: path.join(projectDir, 'PLAN.json'),
        statePath: path.join(projectDir, 'STATE.json'),
      });
    }

    for (const archiveDir of listDirectories(archiveRoot)) {
      const runtimeDir = path.join(archiveDir, 'project');
      candidates.push({
        kind: 'archive',
        label: displayPath(repoRoot, runtimeDir),
        contractRoot: runtimeDir,
        planPath: path.join(runtimeDir, 'PLAN.json'),
        statePath: path.join(runtimeDir, 'STATE.json'),
      });
    }

    for (const projectDir of listDirectories(snapshotRoot)) {
      for (const snapshotDir of listDirectories(projectDir)) {
        const runtimeDir = path.join(snapshotDir, 'project');
        candidates.push({
          kind: 'snapshot',
          label: displayPath(repoRoot, runtimeDir),
          contractRoot: runtimeDir,
          planPath: path.join(runtimeDir, 'PLAN.json'),
          statePath: path.join(runtimeDir, 'STATE.json'),
        });
      }
    }

    return candidates;
  }

  function classifyCandidate(candidate) {
    const errors = [];
    if (!fs.existsSync(candidate.planPath)) {
      errors.push(`missing PLAN.json: ${displayPath(repoRoot, candidate.planPath)}`);
    }
    if (!fs.existsSync(candidate.statePath)) {
      errors.push(`missing STATE.json: ${displayPath(repoRoot, candidate.statePath)}`);
    }
    if (errors.length > 0) {
      return {
        ...candidate,
        classification: 'unsupported',
        errors,
      };
    }

    const planRead = readJsonObject(candidate.planPath);
    const stateRead = readJsonObject(candidate.statePath);
    if (!planRead.ok || !stateRead.ok) {
      return {
        ...candidate,
        classification: 'unsupported',
        errors: [
          ...planRead.errors.map((error) => error.replace(candidate.planPath, displayPath(repoRoot, candidate.planPath))),
          ...stateRead.errors.map((error) => error.replace(candidate.statePath, displayPath(repoRoot, candidate.statePath))),
        ],
      };
    }

    const planErrors = validatePlan(planRead.value);
    const stateErrors = validateState(stateRead.value);
    const validationErrors = [
      ...planErrors.map((error) => `PLAN.json: ${error}`),
      ...stateErrors.map((error) => `STATE.json: ${error}`),
    ];

    if (validationErrors.length === 0) {
      return {
        ...candidate,
        classification: 'compatible',
        errors: [],
      };
    }

    return {
      ...candidate,
      classification: 'migratable',
      errors: summarizeValidationErrors(validationErrors),
    };
  }

  function auditCompatibility() {
    const candidates = collectCandidates();
    const entries = candidates.map(classifyCandidate);
    const counts = {
      scanned: entries.length,
      compatible: entries.filter((entry) => entry.classification === 'compatible').length,
      migratable: entries.filter((entry) => entry.classification === 'migratable').length,
      unsupported: entries.filter((entry) => entry.classification === 'unsupported').length,
    };

    let status = 'PASS';
    if (counts.unsupported > 0) {
      status = 'FAIL';
    } else if (counts.migratable > 0) {
      status = 'WARN';
    }

    return {
      status,
      counts,
      entries,
    };
  }

  return {
    auditCompatibility,
  };
}
