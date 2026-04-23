import fs from 'node:fs';
import path from 'node:path';

function displayPath(rootDir, filePath) {
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..')) {
    return filePath;
  }
  return relative;
}

function readJsonObject(filePath, rootDir, failures, label = null) {
  const formattedLabel = label || displayPath(rootDir, filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    failures.push(`${formattedLabel} is not valid JSON: ${error.message}`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    failures.push(`${formattedLabel} must parse to a JSON object`);
    return null;
  }

  return parsed;
}

export function createContractVerifier({
  frameworkRoot,
  validatePlan,
  validateState,
  fixturesManifestPath = path.join(frameworkRoot, 'scripts', 'smike', 'fixtures', 'contracts', 'manifest.json'),
  schemaPaths = {
    plan: path.join(frameworkRoot, 'scripts', 'smike', 'schemas', 'plan.schema.json'),
    state: path.join(frameworkRoot, 'scripts', 'smike', 'schemas', 'state.schema.json'),
  },
  templatePaths = {
    plan: path.join(frameworkRoot, 'scripts', 'smike', 'templates', 'codex', 'PLAN.json'),
    state: path.join(frameworkRoot, 'scripts', 'smike', 'templates', 'codex', 'STATE.json'),
  },
} = {}) {
  if (!frameworkRoot || typeof frameworkRoot !== 'string') {
    throw new Error('frameworkRoot is required');
  }
  if (typeof validatePlan !== 'function') {
    throw new Error('validatePlan is required');
  }
  if (typeof validateState !== 'function') {
    throw new Error('validateState is required');
  }

  function verifyContracts() {
    const failures = [];
    const counts = {
      schemas: 0,
      templates: 0,
      fixtures: 0,
    };

    for (const schemaPath of Object.values(schemaPaths || {})) {
      counts.schemas += 1;
      readJsonObject(schemaPath, frameworkRoot, failures);
    }

    for (const [kind, templatePath] of Object.entries(templatePaths || {})) {
      counts.templates += 1;
      const template = readJsonObject(templatePath, frameworkRoot, failures);
      if (!template) {
        continue;
      }
      const errors = kind === 'plan' ? validatePlan(template) : validateState(template);
      if (errors.length > 0) {
        failures.push(
          `${displayPath(frameworkRoot, templatePath)} expected valid ${kind.toUpperCase()} template but failed:\n- ${errors.join('\n- ')}`,
        );
      }
    }

    const manifest = readJsonObject(fixturesManifestPath, frameworkRoot, failures);
    const fixtureRoot = path.dirname(fixturesManifestPath);
    const fixtureDefinitions = Array.isArray(manifest?.fixtures) ? manifest.fixtures : null;
    if (!fixtureDefinitions) {
      failures.push(`${displayPath(frameworkRoot, fixturesManifestPath)} must define a fixtures array`);
      return {
        ok: failures.length === 0,
        failures,
        counts,
      };
    }

    for (const fixture of fixtureDefinitions) {
      counts.fixtures += 1;
      if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
        failures.push(`${displayPath(frameworkRoot, fixturesManifestPath)} fixtures[] entries must be objects`);
        continue;
      }

      const fixtureId = typeof fixture.id === 'string' && fixture.id.trim() ? fixture.id.trim() : '<unknown-fixture>';
      const fixtureKind = fixture.kind === 'plan' || fixture.kind === 'state' ? fixture.kind : null;
      const relativeFixturePath = typeof fixture.path === 'string' && fixture.path.trim() ? fixture.path.trim() : null;
      const expectsValid = fixture.expect_valid === true;
      const expectsInvalid = fixture.expect_valid === false;

      if (!fixtureKind) {
        failures.push(`fixture ${fixtureId} has unknown kind: ${fixture.kind}`);
        continue;
      }
      if (!relativeFixturePath) {
        failures.push(`fixture ${fixtureId} is missing path`);
        continue;
      }
      if (!expectsValid && !expectsInvalid) {
        failures.push(`fixture ${fixtureId} must declare expect_valid: true or false`);
        continue;
      }

      const absoluteFixturePath = path.resolve(fixtureRoot, relativeFixturePath);
      const document = readJsonObject(
        absoluteFixturePath,
        frameworkRoot,
        failures,
        `${fixtureId} (${displayPath(frameworkRoot, absoluteFixturePath)})`,
      );
      if (!document) {
        continue;
      }

      const validator = fixtureKind === 'plan' ? validatePlan : validateState;
      const errors = validator(document);

      if (expectsValid) {
        if (errors.length > 0) {
          failures.push(
            `fixture ${fixtureId} (${displayPath(frameworkRoot, absoluteFixturePath)}) expected valid ${fixtureKind.toUpperCase()} but failed:\n- ${errors.join('\n- ')}`,
          );
        }
        continue;
      }

      if (errors.length === 0) {
        failures.push(`fixture ${fixtureId} (${displayPath(frameworkRoot, absoluteFixturePath)}) expected invalid ${fixtureKind.toUpperCase()} but passed validation`);
        continue;
      }

      for (const expectedError of Array.isArray(fixture.expected_errors) ? fixture.expected_errors : []) {
        if (typeof expectedError !== 'string' || !expectedError.trim()) {
          continue;
        }
        if (!errors.includes(expectedError)) {
          failures.push(
            `fixture ${fixtureId} (${displayPath(frameworkRoot, absoluteFixturePath)}) missing expected validation error: ${expectedError}`,
          );
        }
      }
    }

    return {
      ok: failures.length === 0,
      failures,
      counts,
    };
  }

  return {
    verifyContracts,
  };
}
