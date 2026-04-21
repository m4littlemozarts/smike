import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanningDraftPromotionCheck,
  planningAnalysisIsExecutionReady,
} from './planning-readiness.mjs';

function makePhaseContract({
  id = '01',
  scope = 'Define a concrete implementation slice.',
  summary_source = 'priority',
  write_scope_allowed_files = ['scripts/smike/**'],
  declared_verify_commands = ['printf proof'],
  verify_commands = [{ id: 'verify-1' }],
} = {}) {
  return {
    phase: {
      id,
      summary_source,
    },
    phasePlan: {
      scope,
      write_scope: {
        allowed_files: write_scope_allowed_files,
      },
    },
    analysisPlan: {
      declared_verify_commands,
      verify_commands,
    },
  };
}

test('promotion check blocks fallback summaries and generic proof surfaces', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: ['@ref.missing'],
      lint: {
        findings: [{ id: 'spec-missing-shape', severity: 'high' }],
      },
    },
    [
      makePhaseContract({
        id: '01',
        summary_source: 'fallback_blueprint',
        declared_verify_commands: [],
        verify_commands: [{ id: 'typecheck' }, { id: 'unit-tests' }],
      }),
    ],
  );

  assert.equal(result.ready, false);
  assert(result.blockers.some((blocker) => blocker.includes('concrete phase summary')));
  assert(result.blockers.some((blocker) => blocker.includes('phase-specific proof command')));
  assert(result.blockers.some((blocker) => blocker.includes('@ref.missing')));
  assert(result.blockers.some((blocker) => blocker.includes('spec-missing-shape')));
});

test('promotion check passes for concrete scoped phases with explicit proof commands', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: [],
      lint: { findings: [] },
    },
    [
      makePhaseContract(),
      makePhaseContract({
        id: '02',
        scope: 'Add a second concrete slice with bounded scope and explicit proof commands.',
      }),
    ],
  );

  assert.deepEqual(result, { ready: true, blockers: [] });
});

test('promotion check blocks first-phase ownership drift before checker time', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: [],
      lint: { findings: [] },
      first_phase_contract_items: [
        'wire the compiler to consume the published release',
        'enforce lane-based allocation and budget clipping in compile time',
      ],
    },
    [
      makePhaseContract({
        id: '01',
        scope: 'Create the schema and shared types only.',
        declared_verify_commands: ['printf schema-proof'],
        verify_commands: [{ id: 'schema-proof' }],
      }),
      makePhaseContract({
        id: '02',
        scope: 'Wire the compiler to consume the published release and enforce lane-based allocation with budget clipping.',
        declared_verify_commands: ['printf compiler-proof'],
        verify_commands: [{ id: 'compiler-proof' }],
      }),
    ],
  );

  assert.equal(result.ready, false);
  assert(result.blockers.some((blocker) => blocker.includes('first-phase contract') || blocker.includes('ownership drift')));
});

test('planning analysis must have checker and auditor pass with no blockers', () => {
  assert.equal(planningAnalysisIsExecutionReady({
    checker: { result: 'pass' },
    auditor: { result: 'pass' },
    blocking_findings: [],
  }), true);

  assert.equal(planningAnalysisIsExecutionReady({
    checker: { result: 'pass' },
    auditor: null,
    blocking_findings: [],
  }), false);

  assert.equal(planningAnalysisIsExecutionReady({
    checker: { result: 'pass' },
    auditor: { result: 'pass' },
    blocking_findings: [{ id: 'generic-phase-scaffolding' }],
  }), false);
});
