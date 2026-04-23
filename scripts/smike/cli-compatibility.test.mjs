import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function copyFile(relativeSource, absoluteDestination) {
  fs.mkdirSync(path.dirname(absoluteDestination), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relativeSource), absoluteDestination);
}

function runCli(args, rootDir) {
  return execFileSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
      SMIKE_PROJECT_ROOT: rootDir,
    },
    encoding: 'utf8',
  });
}

test('validate --compatibility classifies workspace runtime artifacts', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-compatibility-cli-'));

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

  try {
    const output = runCli(['validate', '--compatibility'], tempRoot);

    assert.match(output, /smike validate compatibility: WARN/);
    assert.match(output, /repo_root: /);
    assert.match(output, /scanned: 2/);
    assert.match(output, /compatible: 1/);
    assert.match(output, /migratable: 1/);
    assert.match(output, /unsupported: 0/);
    assert.match(output, /migratable live \.smike\/migratable-live/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
