import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function runCli(args) {
  return execFileSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
    },
    encoding: 'utf8',
  });
}

function runCliStatus(args) {
  return spawnSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
    },
    encoding: 'utf8',
  });
}

test('validate --plan-quality-fixtures verifies the plan-quality corpus', () => {
  const output = runCli(['validate', '--plan-quality-fixtures']);

  assert.match(output, /smike validate plan-quality-fixtures: PASS/);
  assert.match(output, /fixtures: 4/);
});

test('validate --plan-quality reports a ready spec as JSON', () => {
  const output = runCli([
    'validate',
    '--plan-quality',
    'scripts/smike/fixtures/plan-quality/specs/valid-single-doc-slice.md',
    '--json',
  ]);
  const report = JSON.parse(output);

  assert.equal(report.ok, true);
  assert.equal(report.spec, 'scripts/smike/fixtures/plan-quality/specs/valid-single-doc-slice.md');
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.phases, ['01']);
});

test('validate --plan-quality exits nonzero for blocked specs', () => {
  const result = runCliStatus([
    'validate',
    '--plan-quality',
    'scripts/smike/fixtures/plan-quality/specs/invalid-generic-proof.md',
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /smike validate plan-quality: FAIL/);
  assert.match(result.stdout, /generic verify command/);
});
