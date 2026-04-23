import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPortabilityHeuristics,
  loadRepoPortabilityHeuristicsConfig,
} from './portability-heuristics.mjs';

test('default portability heuristics recognize common repo roots and language layouts', () => {
  const heuristics = createPortabilityHeuristics();

  assert.equal(heuristics.planHasCodeScope({ allowed_files: ['src/**'] }), true);
  assert.equal(heuristics.planHasCodeScope({ allowed_files: ['services/api/**'] }), true);
  assert.equal(heuristics.planHasCodeScope({ allowed_files: ['pkg/http/**'] }), true);
  assert.equal(heuristics.planHasCodeScope({ allowed_files: ['docs/**'] }), false);

  assert.equal(heuristics.isLikelySourcePath('services/api/main.py'), true);
  assert.equal(heuristics.isLikelySourcePath('cmd/server/main.go'), true);
  assert.equal(heuristics.isLikelySourcePath('crates/worker/src/lib.rs'), true);
  assert.equal(heuristics.isLikelySourcePath('tests/test_api.py'), false);

  assert.equal(heuristics.isLikelyTestPath('tests/test_api.py'), true);
  assert.equal(heuristics.isLikelyTestPath('pkg/http/router_test.go'), true);
  assert.equal(heuristics.isLikelyTestPath('src/app.spec.ts'), true);
});

test('default portability heuristics recognize broader verification command families and wrappers', () => {
  const heuristics = createPortabilityHeuristics();

  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: 'pytest -q' }), true);
  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: 'uv run mypy src' }), true);
  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: './scripts/verify-python.sh pytest -q' }), true);
  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: 'go test ./...' }), true);
  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: 'cargo check --workspace' }), true);
  assert.equal(heuristics.looksLikeVerificationCoverageCommand({ run: 'bun test' }), true);

  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: 'pytest -q' }), true);
  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: './scripts/verify-python.sh pytest -q' }), true);
  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: 'go test ./...' }), true);
  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: 'cargo test --workspace' }), true);
  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: 'cargo check --workspace' }), false);
  assert.equal(heuristics.looksLikeTestVerificationCommand({ run: 'pyright --project pyproject.toml' }), false);
});

test('default verify family and command generation follows repo markers', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-portability-markers-'));

  try {
    fs.writeFileSync(path.join(tempRoot, 'go.mod'), 'module example.com/demo\n', 'utf8');
    const heuristics = createPortabilityHeuristics();
    const commands = heuristics.buildDefaultVerifyCommands({
      repoRoot: tempRoot,
      plan: { allowed_files: ['pkg/http/**'] },
      guardTestCommand: (command) => `guard(${command})`,
    });

    assert.equal(heuristics.inferDefaultVerifyFamily({
      repoRoot: tempRoot,
      plan: { allowed_files: ['pkg/http/**'] },
    }), 'go');
    assert.deepEqual(commands, [{ id: 'unit-tests', run: 'guard(go test ./...)' }]);
    assert.deepEqual(heuristics.inferDefaultRequiredTools({
      repoRoot: tempRoot,
      plan: { allowed_files: ['pkg/http/**'] },
    }), ['go', 'git']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('default verify family override changes generated commands', () => {
  const heuristics = createPortabilityHeuristics({
    default_verify_family: 'python',
  });

  const commands = heuristics.buildDefaultVerifyCommands({
    repoRoot: process.cwd(),
    plan: { allowed_files: ['src/**'] },
    includeTypecheck: true,
    includeTests: true,
    guardTestCommand: (command) => `guard(${command})`,
  });

  assert.equal(heuristics.inferDefaultVerifyFamily({
    repoRoot: process.cwd(),
    plan: { allowed_files: ['src/**'] },
  }), 'python');
  assert.deepEqual(commands, [{ id: 'unit-tests', run: 'guard(pytest -q)' }]);
  assert.deepEqual(heuristics.inferDefaultRequiredTools({
    repoRoot: process.cwd(),
    plan: { allowed_files: ['src/**'] },
  }), ['python', 'git']);
});

test('repo portability overrides extend the default heuristics from smike.config.json', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smike-portability-'));

  try {
    fs.writeFileSync(path.join(tempRoot, 'smike.config.json'), `${JSON.stringify({
      framework_dir: '../smike-framework',
      portability_heuristics: {
        code_scope_path_patterns: ['^lambda(?:/|$)'],
        test_command_patterns: ['\\bverify-behavior\\b'],
        default_verify_family: 'python',
      },
    }, null, 2)}\n`, 'utf8');

    const heuristics = createPortabilityHeuristics(loadRepoPortabilityHeuristicsConfig({ repoRoot: tempRoot }));

    assert.equal(heuristics.planHasCodeScope({ allowed_files: ['lambda/functions/**'] }), true);
    assert.equal(heuristics.looksLikeTestVerificationCommand({ run: './scripts/verify-behavior' }), true);
    assert.equal(heuristics.planHasCodeScope({ allowed_files: ['src/**'] }), true);
    assert.equal(heuristics.inferDefaultVerifyFamily({
      repoRoot: tempRoot,
      plan: { allowed_files: ['src/**'] },
    }), 'python');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
