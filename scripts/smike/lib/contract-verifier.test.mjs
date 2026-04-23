import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContractVerifier } from './contract-verifier.mjs';
import { createValidationHelpers } from './validation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
};

const uniqueStrings = (values) => [...new Set(ensureArray(values).map((value) => String(value).trim()).filter(Boolean))];

const { validatePlan, validateState } = createValidationHelpers({
  planSchemaPath: path.join(__dirname, '..', 'schemas', 'plan.schema.json'),
  stateSchemaPath: path.join(__dirname, '..', 'schemas', 'state.schema.json'),
  ensureArray,
  uniqueStrings,
  validateDependencyReferenceValue(reference, fieldName, errors) {
    if (typeof reference !== 'string' || !reference.trim()) {
      errors.push(`${fieldName}[] must be non-empty strings`);
      return;
    }
    const parts = reference.split(':');
    if (parts.length > 2 || parts.some((part) => !part.trim())) {
      errors.push(`${fieldName}[] cross-project references must use "project:plan-id"`);
    }
  },
});

test('verifyContracts passes for shipped schemas, templates, and fixtures', () => {
  const { verifyContracts } = createContractVerifier({
    frameworkRoot: repoRoot,
    validatePlan,
    validateState,
  });

  const result = verifyContracts();

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.counts.schemas, 2);
  assert.equal(result.counts.templates, 2);
  assert.equal(result.counts.fixtures >= 1, true);
});

test('verifyContracts reports missing expected invalid-fixture errors', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-contracts-'));
  const fixturePath = path.join(tempDir, 'invalid-plan.json');
  const manifestPath = path.join(tempDir, 'manifest.json');

  fs.writeFileSync(fixturePath, `${JSON.stringify({
    $schema: '../../scripts/smike/schemas/plan.schema.json',
    schema_version: '2.1.0',
    profile: 'codex',
    plan_id: 'broken-plan',
    objective: 'Break validation on purpose.',
    scope: 'Exercise the contract verifier.',
    depends_on: [],
    allowed_files: ['src/routes/**'],
    blocked_files: ['.env*'],
    write_scope: {
      mode: 'strict',
      allowed_files: ['src/routes/**', 'src/lib/**'],
      blocked_files: ['.env*'],
    },
    preflight: {
      require_clean_worktree: false,
      required_tools: ['node'],
      required_env_vars: [],
    },
    verify_commands: [
      {
        id: 'verify-contract',
        run: 'echo ok',
      },
    ],
    acceptance_criteria: [
      {
        id: 'AC-1',
        description: 'Contract verifier catches this.',
        command_ids: ['verify-contract'],
        signals: [
          {
            command_id: 'verify-contract',
            expected_signal: 'exit=0',
          },
        ],
      },
    ],
    postflight: {
      commands: [],
    },
  }, null, 2)}\n`, 'utf8');

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    fixtures: [
      {
        id: 'broken-plan',
        kind: 'plan',
        path: 'invalid-plan.json',
        expect_valid: false,
        expected_errors: ['this error string should never appear'],
      },
    ],
  }, null, 2)}\n`, 'utf8');

  try {
    const { verifyContracts } = createContractVerifier({
      frameworkRoot: repoRoot,
      validatePlan,
      validateState,
      fixturesManifestPath: manifestPath,
      schemaPaths: {},
      templatePaths: {},
    });

    const result = verifyContracts();

    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /missing expected validation error: this error string should never appear/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
