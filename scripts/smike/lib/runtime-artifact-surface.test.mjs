import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectCompletionRequirementFailures,
  normalizeDispatchCompletionRequirements,
  verifiedArtifactPathsFromCompletionArtifacts,
} from './runtime-artifact-surface.mjs';

test('verified artifact surface is derived from completion snapshots only', () => {
  const result = verifiedArtifactPathsFromCompletionArtifacts({
    result_artifacts: ['phantom/missing.json'],
    completion_artifacts: [
      { path: 'artifacts/real.json', exists: true },
      { path: 'artifacts/ignored.json', exists: false },
      { path: 'artifacts/real.json', exists: true },
    ],
  });

  assert.deepEqual(result, ['artifacts/real.json']);
});

test('verified artifact surface is empty without completion evidence', () => {
  assert.deepEqual(verifiedArtifactPathsFromCompletionArtifacts({
    result_artifacts: ['artifacts/declared.json'],
    completion_artifacts: [],
  }), []);
});

test('completion requirements default to semantic checks for json and text artifacts', () => {
  assert.deepEqual(
    normalizeDispatchCompletionRequirements(
      null,
      ['reports/outcome.json', 'notes/summary.md', 'artifacts/blob.bin'],
      true,
    ),
    {
      artifact_requirements: [
        {
          path: 'reports/outcome.json',
          kind: 'json',
          must_exist: true,
          must_be_nonempty: true,
          must_parse_json: true,
        },
        {
          path: 'notes/summary.md',
          kind: 'text',
          must_exist: true,
          must_be_nonempty: true,
          must_parse_json: false,
        },
        {
          path: 'artifacts/blob.bin',
          kind: 'file',
          must_exist: true,
          must_be_nonempty: true,
          must_parse_json: false,
        },
      ],
      require_artifact_change: true,
    },
  );
});

test('completion requirement failures reject blank text and empty json containers', () => {
  const requirements = normalizeDispatchCompletionRequirements(null, [
    'reports/outcome.json',
    'notes/summary.md',
  ]);
  const failures = collectCompletionRequirementFailures(
    requirements,
    [
      {
        path: 'reports/outcome.json',
        exists: true,
        size_bytes: 2,
      },
      {
        path: 'notes/summary.md',
        exists: true,
        size_bytes: 4,
      },
    ],
    (artifactPath) => {
      if (artifactPath === 'reports/outcome.json') {
        return '{}';
      }
      if (artifactPath === 'notes/summary.md') {
        return '   \n';
      }
      return '';
    },
  );

  assert.deepEqual(failures, [
    'Result artifact has no semantic JSON content: reports/outcome.json',
    'Result artifact is blank: notes/summary.md',
  ]);
});

test('completion requirement failures reject invalid json and missing artifacts', () => {
  const requirements = normalizeDispatchCompletionRequirements(null, [
    'reports/outcome.json',
    'notes/summary.md',
  ]);
  const failures = collectCompletionRequirementFailures(
    requirements,
    [
      {
        path: 'reports/outcome.json',
        exists: true,
        size_bytes: 10,
      },
    ],
    (artifactPath) => artifactPath === 'reports/outcome.json' ? '{"bad"' : '',
  );

  assert.deepEqual(failures, [
    'Result artifact is not valid JSON: reports/outcome.json',
    'Missing result artifact: notes/summary.md',
  ]);
});
