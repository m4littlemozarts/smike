import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countBlockingFindings,
  globsLikelyOverlap,
  hasDependencyPath,
  scoreDeliverableAgainstPlan,
  topologicalOrder,
} from './planning-analysis-utils.mjs';

test('globsLikelyOverlap handles shared prefixes, nested globs, and disjoint paths', () => {
  assert.equal(globsLikelyOverlap('scripts/smike/**', 'scripts/smike/lib/*.mjs'), true);
  assert.equal(globsLikelyOverlap('scripts\\smike\\**', 'scripts/smike/lib/*.mjs'), true);
  assert.equal(globsLikelyOverlap('packages/web/**', 'scripts/smike/**'), false);
});

test('topologicalOrder returns dependency-first ordering', () => {
  const order = topologicalOrder([
    { plan_id: '03', depends_on: ['02'] },
    { plan_id: '01', depends_on: [] },
    { plan_id: '02', depends_on: ['01'] },
  ]);

  assert.deepEqual(order, ['01', '02', '03']);
});

test('hasDependencyPath detects transitive dependencies in one direction only', () => {
  const phasePlans = [
    { plan_id: '01', depends_on: [] },
    { plan_id: '02', depends_on: ['01'] },
    { plan_id: '03', depends_on: ['02'] },
  ];

  assert.equal(hasDependencyPath(phasePlans, '03', '01'), true);
  assert.equal(hasDependencyPath(phasePlans, '01', '03'), false);
});

test('countBlockingFindings ignores low-severity findings', () => {
  assert.equal(countBlockingFindings([
    { severity: 'low' },
    { severity: 'medium' },
    { severity: 'high' },
  ]), 2);
});

test('scoreDeliverableAgainstPlan prefers file-scope matches and preserves keyword overlap', () => {
  const match = scoreDeliverableAgainstPlan('scripts/smike/lib/operator-surface.mjs', {
    phase: 'Operator surface',
    objective: 'Refresh operator surface messaging',
    scope: 'Update dependency blocker guidance for status output.',
    allowed_files: [],
    write_scope_allowed_files: ['scripts/smike/lib/**'],
    delegation: {
      result_artifacts: [],
    },
  });

  assert.equal(match.fileMatch, true);
  assert(match.overlap.includes('operator'));
  assert(match.score >= 4);
});
