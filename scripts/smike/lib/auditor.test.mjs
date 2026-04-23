import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildPlanningAuditorRecord } from './auditor.mjs';

const buildAuditor = createBuildPlanningAuditorRecord({
  nowIso: () => '2026-04-23T00:00:00.000Z',
});

function makePlan({
  plan_id,
  phase,
  objective,
  scope,
  write_scope_allowed_files = [],
  result_artifacts = [],
} = {}) {
  return {
    plan_id,
    phase,
    objective,
    scope,
    allowed_files: [],
    write_scope_allowed_files,
    delegation: {
      result_artifacts,
    },
  };
}

test('auditor passes when deliverables map cleanly onto phase file scope', () => {
  const record = buildAuditor(
    {
      objective: 'Ship a concrete planning bundle.',
      constraints: [],
      phase_blueprints: [],
      deliverables: ['scripts/smike/lib/operator-surface.mjs'],
    },
    [
      makePlan({
        plan_id: '02',
        phase: 'Plan 02',
        objective: 'Operator surface helpers',
        scope: 'Refine dependency blocker messaging for operators.',
        write_scope_allowed_files: ['scripts/smike/lib/**'],
      }),
    ],
  );

  assert.equal(record.result, 'pass');
  assert.deepEqual(record.findings, []);
  assert.equal(record.mappings[0].plan_id, '02');
  assert.equal(record.mappings[0].match_type, 'file-scope');
});

test('auditor reports a high-severity gap when no phase credibly covers a deliverable', () => {
  const record = buildAuditor(
    {
      objective: 'Ship a concrete planning bundle.',
      constraints: [],
      phase_blueprints: [],
      deliverables: ['mobile push credential rotation playbook'],
    },
    [
      makePlan({
        plan_id: '01',
        phase: 'Plan 01',
        objective: 'Schema work',
        scope: 'Define the schema contract.',
        write_scope_allowed_files: ['scripts/smike/**'],
      }),
    ],
  );

  assert.equal(record.result, 'concerns');
  assert.equal(record.findings[0].severity, 'high');
  assert.match(record.findings[0].details, /mobile push credential rotation playbook/);
  assert.equal(record.mappings[0].match_type, 'none');
});

test('auditor flags weak keyword-only deliverable matches', () => {
  const record = buildAuditor(
    {
      objective: 'Ship a concrete planning bundle.',
      constraints: [],
      phase_blueprints: [],
      deliverables: ['allocator compliance playbook'],
    },
    [
      makePlan({
        plan_id: '03',
        phase: 'Plan 03',
        objective: 'Allocator telemetry',
        scope: 'Add allocator counters for later review.',
        write_scope_allowed_files: ['scripts/smike/**'],
      }),
    ],
  );

  assert.equal(record.result, 'concerns');
  assert.equal(record.findings[0].severity, 'medium');
  assert.match(record.findings[0].details, /maps weakly to 03/);
  assert.equal(record.mappings[0].match_type, 'weak-keyword');
});
