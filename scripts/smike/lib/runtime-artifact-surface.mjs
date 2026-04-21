import path from 'node:path';

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

function normalizeArtifactSnapshotList(value) {
  return ensureArray(value)
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path.trim() : '',
      exists: entry.exists !== false,
    }))
    .filter((entry) => entry.path);
}

function normalizeArtifactKind(value) {
  return value === 'json' || value === 'text' || value === 'file' ? value : 'file';
}

function inferArtifactKind(artifactPath) {
  const ext = path.extname(String(artifactPath || '').toLowerCase());
  if (ext === '.json') {
    return 'json';
  }
  if (ext === '.md' || ext === '.markdown' || ext === '.txt' || ext === '.log' || ext === '.yml' || ext === '.yaml') {
    return 'text';
  }
  return 'file';
}

function normalizeArtifactRequirement(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const artifactPath = typeof entry.path === 'string' ? entry.path.trim() : '';
  if (!artifactPath) {
    return null;
  }

  const kind = normalizeArtifactKind(entry.kind || inferArtifactKind(artifactPath));
  return {
    path: artifactPath,
    kind,
    must_exist: entry.must_exist !== false,
    must_be_nonempty: entry.must_be_nonempty !== false,
    must_parse_json: entry.must_parse_json === true || kind === 'json',
  };
}

export function normalizeDispatchCompletionRequirements(value, resultArtifacts = [], artifactChangeRequired = false) {
  const declaredArtifacts = uniqueStrings(
    ensureArray(resultArtifacts)
      .map((artifactPath) => String(artifactPath).trim())
      .filter(Boolean),
  );
  const providedRequirements = new Map(
    ensureArray(value?.artifact_requirements)
      .map((entry) => normalizeArtifactRequirement(entry))
      .filter(Boolean)
      .map((entry) => [entry.path, entry]),
  );
  const requirementPaths = uniqueStrings([
    ...declaredArtifacts,
    ...providedRequirements.keys(),
  ]);

  return {
    artifact_requirements: requirementPaths.map((artifactPath) => {
      const provided = providedRequirements.get(artifactPath);
      return normalizeArtifactRequirement({
        path: artifactPath,
        kind: provided?.kind || inferArtifactKind(artifactPath),
        must_exist: provided?.must_exist !== false,
        must_be_nonempty: provided?.must_be_nonempty !== false,
        must_parse_json: provided?.must_parse_json === true,
      });
    }),
    require_artifact_change: value?.require_artifact_change === true || artifactChangeRequired === true,
  };
}

export function collectCompletionRequirementFailures(requirements, completionArtifacts, readArtifactText = null) {
  const normalizedRequirements = normalizeDispatchCompletionRequirements(requirements);
  const snapshotByPath = new Map(
    normalizeArtifactSnapshotList(completionArtifacts).map((artifact) => [artifact.path, artifact]),
  );
  const failures = [];

  for (const requirement of normalizedRequirements.artifact_requirements) {
    const snapshot = snapshotByPath.get(requirement.path);
    if (requirement.must_exist && (!snapshot || snapshot.exists !== true)) {
      failures.push(`Missing result artifact: ${requirement.path}`);
      continue;
    }
    if (!snapshot || snapshot.exists !== true) {
      continue;
    }

    if (requirement.must_be_nonempty && snapshot.size_bytes <= 0) {
      failures.push(`Result artifact is empty: ${requirement.path}`);
      continue;
    }

    if (requirement.kind === 'text' || requirement.must_parse_json) {
      if (typeof readArtifactText !== 'function') {
        failures.push(`No artifact reader is available for ${requirement.path}`);
        continue;
      }

      let content = '';
      try {
        content = String(readArtifactText(requirement.path) || '');
      } catch (error) {
        failures.push(`Result artifact is unreadable: ${requirement.path}`);
        continue;
      }

      if (requirement.must_be_nonempty && !content.trim()) {
        failures.push(`Result artifact is blank: ${requirement.path}`);
        continue;
      }

      if (requirement.must_parse_json) {
        try {
          const parsed = JSON.parse(content);
          if (
            (Array.isArray(parsed) && parsed.length === 0)
            || (
              parsed
              && typeof parsed === 'object'
              && !Array.isArray(parsed)
              && Object.keys(parsed).length === 0
            )
          ) {
            failures.push(`Result artifact has no semantic JSON content: ${requirement.path}`);
          }
        } catch (error) {
          failures.push(`Result artifact is not valid JSON: ${requirement.path}`);
        }
      }
    }
  }

  return failures;
}

export function verifiedArtifactPathsFromCompletionArtifacts(entry) {
  return uniqueStrings(
    normalizeArtifactSnapshotList(entry?.completion_artifacts)
      .filter((artifact) => artifact.exists)
      .map((artifact) => artifact.path),
  );
}
