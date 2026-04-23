import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanningDraftPromotionCheck,
  phaseHasDraftReadyProofCommand,
  phaseHasDraftReadySummary,
  planningAnalysisIsExecutionReady,
} from './planning-readiness.mjs';

function makePhaseContract({
  id = '01',
  scope = 'Define a concrete implementation slice.',
  summary_source = 'priority',
  depends_on = [],
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
      plan_id: id,
      depends_on,
      declared_verify_commands,
      verify_commands,
      write_scope_allowed_files,
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
      makePhaseContract({
        id: '01',
        write_scope_allowed_files: ['scripts/smike/schema/**'],
      }),
      makePhaseContract({
        id: '02',
        scope: 'Add a second concrete slice with bounded scope and explicit proof commands.',
        depends_on: ['01'],
        write_scope_allowed_files: ['scripts/smike/routes/**'],
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

test('promotion check blocks non-serialized cross-phase write-scope collisions before runtime planning starts', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: [],
      lint: { findings: [] },
    },
    [
      makePhaseContract({
        id: '01',
        scope: 'Create auth and bootstrap storage.',
        write_scope_allowed_files: ['src/db/**', 'src/routes/admin.ts'],
        declared_verify_commands: ['printf auth-proof'],
        verify_commands: [{ id: 'auth-proof' }],
      }),
      makePhaseContract({
        id: '02',
        scope: 'Add outbound send state.',
        write_scope_allowed_files: ['src/db/**', 'src/routes/send.ts'],
        declared_verify_commands: ['printf send-proof'],
        verify_commands: [{ id: 'send-proof' }],
      }),
    ],
  );

  assert.equal(result.ready, false);
  assert(result.blockers.some((blocker) => blocker.includes('cross-phase write-scope collision')));
  assert(result.blockers.some((blocker) => blocker.includes('01 vs 02')));
});

test('promotion check blocks conventional route slices that only have inspection-style proof', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: [],
      lint: { findings: [] },
    },
    [
      makePhaseContract({
        id: '01',
        scope: 'Tighten domain discovery route auth behavior.',
        write_scope_allowed_files: ['src/routes/domains.ts', 'src/app.ts'],
        declared_verify_commands: ['rg -n "wrong-scope bearer" plan-email-mcp.md src/routes/domains.ts'],
        verify_commands: [{ id: 'route-proof', run: 'rg -n "wrong-scope bearer" plan-email-mcp.md src/routes/domains.ts' }],
      }),
    ],
  );

  assert.equal(result.ready, false);
  assert(result.blockers.some((blocker) => blocker.includes('behavioral route proof command')));
});

test('promotion check blocks conventional route slices that omit router wiring scope', () => {
  const result = buildPlanningDraftPromotionCheck(
    {
      unresolved_ref_tokens: [],
      lint: { findings: [] },
    },
    [
      makePhaseContract({
        id: '02',
        scope: 'Add the outbound send route.',
        write_scope_allowed_files: ['src/routes/send.ts', 'src/email/send.ts'],
        declared_verify_commands: ['node scripts/verify-send-route.mjs'],
        verify_commands: [{ id: 'send-route-proof', run: 'node scripts/verify-send-route.mjs' }],
      }),
    ],
  );

  assert.equal(result.ready, false);
  assert(result.blockers.some((blocker) => blocker.includes('router or entrypoint wiring surface')));
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
    freshness: { stale: true },
    blocking_findings: [],
  }), false);

  assert.equal(planningAnalysisIsExecutionReady({
    checker: { result: 'pass' },
    auditor: { result: 'pass' },
    blocking_findings: [{ id: 'generic-phase-scaffolding' }],
  }), false);
});

test('phaseHasDraftReadySummary rejects fallback or empty summaries and accepts concrete scope', () => {
  assert.equal(phaseHasDraftReadySummary(
    { scope: '' },
    { summary_source: 'priority' },
  ), false);

  assert.equal(phaseHasDraftReadySummary(
    { scope: 'Define the route boundary.' },
    { summary_source: 'fallback_blueprint' },
  ), false);

  assert.equal(phaseHasDraftReadySummary(
    { scope: 'Define the route boundary.' },
    { summary_source: 'priority' },
  ), true);
});

test('phaseHasDraftReadyProofCommand accepts declared commands and rejects generic verify-only surfaces', () => {
  assert.equal(phaseHasDraftReadyProofCommand({
    declared_verify_commands: ['printf route-proof'],
    verify_commands: [{ id: 'typecheck' }],
  }), true);

  assert.equal(phaseHasDraftReadyProofCommand({
    declared_verify_commands: [],
    verify_commands: [{ id: 'typecheck' }, { id: 'unit-tests' }],
  }), false);

  assert.equal(phaseHasDraftReadyProofCommand({
    declared_verify_commands: [],
    verify_commands: [{ id: 'route-auth-proof' }],
  }), true);
});
