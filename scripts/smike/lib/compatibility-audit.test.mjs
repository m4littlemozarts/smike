import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCompatibilityAuditor } from './compatibility-audit.mjs';
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

function copyFile(relativeSource, absoluteDestination) {
  fs.mkdirSync(path.dirname(absoluteDestination), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relativeSource), absoluteDestination);
}

test('auditCompatibility classifies compatible, migratable, and unsupported runtime payloads', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-compatibility-'));

  copyFile(
    'scripts/smike/fixtures/contracts/plans/valid-parallel-plan.json',
    path.join(tempRoot, '.smike', 'compatible-live', 'PLAN.json'),
  );
  copyFile(
    'scripts/smike/fixtures/contracts/states/valid-awaiting-runtime-dispatch.json',
    path.join(tempRoot, '.smike', 'compatible-live', 'STATE.json'),
  );

  copyFile(
    'scripts/smike/fixtures/contracts/plans/valid-parallel-plan.json',
    path.join(tempRoot, '.smike', 'migratable-live', 'PLAN.json'),
  );
  copyFile(
    'scripts/smike/fixtures/contracts/states/invalid-projection-drift.json',
    path.join(tempRoot, '.smike', 'migratable-live', 'STATE.json'),
  );

  copyFile(
    'scripts/smike/fixtures/contracts/plans/valid-parallel-plan.json',
    path.join(tempRoot, '.smike-archive', 'broken-archive', 'project', 'PLAN.json'),
  );

  copyFile(
    'scripts/smike/fixtures/contracts/plans/valid-parallel-plan.json',
    path.join(tempRoot, '.smike-snapshots', 'snap-project', 'planning-ready', 'project', 'PLAN.json'),
  );
  copyFile(
    'scripts/smike/fixtures/contracts/states/valid-complete.json',
    path.join(tempRoot, '.smike-snapshots', 'snap-project', 'planning-ready', 'project', 'STATE.json'),
  );

  try {
    const { auditCompatibility } = createCompatibilityAuditor({
      repoRoot: tempRoot,
      validatePlan,
      validateState,
    });

    const result = auditCompatibility();

    assert.equal(result.status, 'FAIL');
    assert.deepEqual(result.counts, {
      scanned: 4,
      compatible: 2,
      migratable: 1,
      unsupported: 1,
    });
    assert.equal(result.entries.find((entry) => entry.label === '.smike/compatible-live').classification, 'compatible');
    assert.equal(result.entries.find((entry) => entry.label === '.smike/migratable-live').classification, 'migratable');
    assert.match(
      result.entries.find((entry) => entry.label === '.smike/migratable-live').errors.join('\n'),
      /runtime_dispatch_view\.ready_dispatches references unknown dispatch_id: missing-dispatch/,
    );
    assert.equal(
      result.entries.find((entry) => entry.label === '.smike-archive/broken-archive/project').classification,
      'unsupported',
    );
    assert.match(
      result.entries.find((entry) => entry.label === '.smike-archive/broken-archive/project').errors.join('\n'),
      /missing STATE\.json/,
    );
    assert.equal(
      result.entries.find((entry) => entry.label === '.smike-snapshots/snap-project/planning-ready/project').classification,
      'compatible',
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('auditCompatibility reports PASS when no runtime artifacts exist', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-compatibility-empty-'));

  try {
    const { auditCompatibility } = createCompatibilityAuditor({
      repoRoot: tempRoot,
      validatePlan,
      validateState,
    });

    const result = auditCompatibility();

    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.counts, {
      scanned: 0,
      compatible: 0,
      migratable: 0,
      unsupported: 0,
    });
    assert.deepEqual(result.entries, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
