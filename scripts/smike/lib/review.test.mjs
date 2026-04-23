import test from 'node:test';
import assert from 'node:assert/strict';

import { createPortabilityHeuristics } from './portability-heuristics.mjs';
import { createBuildReviewRecord } from './review.mjs';

const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
};

const portabilityHeuristics = createPortabilityHeuristics();

const buildReview = createBuildReviewRecord({
  getQualityGateConfig: () => ({
    review: {
      focus_areas: [],
      anti_patterns: [],
    },
  }),
  ensureArray,
  acUsesOnlyExitSignals: (ac) => ac?.weak === true,
  isLikelySourcePath: portabilityHeuristics.isLikelySourcePath,
  isLikelyInterfaceSurfacePath: portabilityHeuristics.isLikelyInterfaceSurfacePath,
  isLikelyTestPath: portabilityHeuristics.isLikelyTestPath,
  getWorkspaceDirtyCheck: (preflight) => ensureArray(preflight?.checks).find((check) => check?.type === 'workspace_dirty') || null,
  looksLikeVerificationCoverageCommand: portabilityHeuristics.looksLikeVerificationCoverageCommand,
  looksLikeTestVerificationCommand: portabilityHeuristics.looksLikeTestVerificationCommand,
  nowIso: () => '2026-04-21T00:00:00.000Z',
});

function makeContract({
  verify_commands = [{ id: 'unit-tests', run: 'vitest run tests/unit/example.test.ts' }],
  acceptance_criteria = [{ id: 'AC-1', weak: true }],
} = {}) {
  return {
    plan: {
      verify_commands,
      acceptance_criteria,
      quality_gates: {
        review: {
          focus_areas: [],
          anti_patterns: [],
        },
      },
    },
  };
}

function makeCycleRecord({
  changed_paths = [],
  dirty_paths = [],
  dirty_paths_truncated = false,
} = {}) {
  return {
    scope: {
      changed_paths,
      pass: true,
    },
    preflight: {
      checks: [{
        type: 'workspace_dirty',
        dirty_count: dirty_paths.length,
        dirty_paths,
        dirty_paths_truncated,
      }],
    },
  };
}

function makeVerdictRecord(result = 'pass') {
  return {
    result,
    failures: result === 'pass' ? [] : ['verify.unit-tests'],
  };
}

test('review suppresses weak-evidence findings when a test command and changed tests already back the change', () => {
  const review = buildReview(
    makeContract(),
    makeCycleRecord({
      changed_paths: [
        'packages/worker/src/example.ts',
        'tests/unit/example.test.ts',
      ],
    }),
    makeVerdictRecord('pass'),
  );

  const findingIds = new Set(review.findings.map((finding) => finding.id));

  assert.equal(review.result, 'pass');
  assert.equal(findingIds.has('weak-evidence-AC-1'), false);
  assert.equal(findingIds.has('behavioral-coverage-gap'), false);
});

test('review omits dirty-baseline noise when pre-existing dirt is disjoint from the phase delta', () => {
  const review = buildReview(
    makeContract({
      verify_commands: [{ id: 'typecheck', run: 'npm run typecheck' }],
      acceptance_criteria: [],
    }),
    makeCycleRecord({
      changed_paths: ['packages/worker/src/example.ts'],
      dirty_paths: ['README.md'],
    }),
    makeVerdictRecord('pass'),
  );

  const findingIds = new Set(review.findings.map((finding) => finding.id));

  assert.equal(findingIds.has('baseline-dirty-worktree'), false);
});

test('review reports dirty-baseline overlap as a delta instead of generic noise', () => {
  const review = buildReview(
    makeContract({
      verify_commands: [{ id: 'typecheck', run: 'npm run typecheck' }],
      acceptance_criteria: [],
    }),
    makeCycleRecord({
      changed_paths: ['packages/worker/src/example.ts'],
      dirty_paths: ['packages/worker/src/example.ts', 'README.md'],
    }),
    makeVerdictRecord('pass'),
  );

  const finding = review.findings.find((entry) => entry.id === 'baseline-dirty-worktree');

  assert.equal(finding?.title, 'Dirty baseline overlapped phase-owned changes');
  assert.match(finding?.details || '', /changed 1 path\(s\)/);
  assert.match(finding?.details || '', /Overlap with this cycle: 1 path\(s\) \(packages\/worker\/src\/example\.ts\)\./);
  assert.match(finding?.details || '', /no commit is required/i);
});

test('review treats python service paths and wrapper-based pytest commands as coverage', () => {
  const review = buildReview(
    makeContract({
      verify_commands: [{ id: 'verify-service', run: './scripts/verify-python.sh pytest -q services/api' }],
      acceptance_criteria: [{ id: 'AC-1', weak: true }],
    }),
    makeCycleRecord({
      changed_paths: ['services/api/main.py'],
    }),
    makeVerdictRecord('pass'),
  );

  const findingIds = new Set(review.findings.map((finding) => finding.id));

  assert.equal(findingIds.has('weak-evidence-AC-1'), false);
  assert.equal(findingIds.has('behavioral-coverage-gap'), false);
  assert.equal(findingIds.has('source-drift-without-coverage'), false);
});

test('review treats go test as behavioral proof for Go package layouts', () => {
  const review = buildReview(
    makeContract({
      verify_commands: [{ id: 'verify-go', run: 'go test ./pkg/http/...' }],
      acceptance_criteria: [{ id: 'AC-1', weak: true }],
    }),
    makeCycleRecord({
      changed_paths: ['pkg/http/router.go'],
    }),
    makeVerdictRecord('pass'),
  );

  const findingIds = new Set(review.findings.map((finding) => finding.id));

  assert.equal(findingIds.has('weak-evidence-AC-1'), false);
  assert.equal(findingIds.has('behavioral-coverage-gap'), false);
  assert.equal(findingIds.has('source-drift-without-coverage'), false);
});

test('review recognizes Rust interface surfaces and cargo check coverage', () => {
  const review = buildReview(
    makeContract({
      verify_commands: [{ id: 'verify-rust', run: 'cargo check --workspace' }],
      acceptance_criteria: [],
    }),
    makeCycleRecord({
      changed_paths: ['crates/api/src/lib.rs', 'crates/api/src/types.proto'],
    }),
    makeVerdictRecord('pass'),
  );

  const findingIds = new Set(review.findings.map((finding) => finding.id));

  assert.equal(findingIds.has('source-drift-without-coverage'), false);
  assert.equal(findingIds.has('interface-drift-without-coverage'), false);
});
