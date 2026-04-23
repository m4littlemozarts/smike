import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');

function runCli(args, extraEnv = {}) {
  return execFileSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

test('validate --contracts verifies framework-owned schemas, templates, and fixtures', () => {
  const output = runCli(['validate', '--contracts']);

  assert.match(output, /smike validate contracts: PASS/);
  assert.match(output, /schemas: 2/);
  assert.match(output, /templates: 2/);
  assert.match(output, /fixtures: \d+/);
});
