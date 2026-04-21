import test from 'node:test';
import assert from 'node:assert/strict';

import { createBuildPlanningCheckerRecord } from './checker.mjs';

const buildChecker = createBuildPlanningCheckerRecord({
  nowIso: () => '2026-04-20T00:00:00.000Z',
});

function makePlan({
  plan_id,
  objective,
  scope,
  depends_on = [],
  allowed_files = ['packages/worker/**', 'packages/shared/**', 'tests/**'],
  write_scope_allowed_files = allowed_files,
  verify_commands = [
    { id: 'typecheck' },
    { id: 'unit-tests' },
  ],
}) {
  return {
    plan_id,
    phase: `Plan ${plan_id}`,
    objective,
    scope,
    depends_on,
    allowed_files,
    write_scope_allowed_files,
    verify_commands,
  };
}

test('checker blocks generic implementation scaffolding that ignores the first executable phase contract', () => {
  const bundle = {
    lint: { findings: [] },
    mode: 'implementation',
    deliverables: [
      'app-intel schema',
      'shared types',
      'curated seed import',
      'app-intel release generation / diff / rollback surface',
      'lane-based allocator integration',
    ],
    integration_requirements: [
      'current curated sources during migration bootstrap',
      'existing compile-time KV caching patterns',
    ],
    first_phase_contract_items: [
      'create schema',
      'create shared types',
      'import current curated sources',
      'generate a deterministic draft release',
      'diff it against empty/current state',
      'wire the compiler to consume the published release',
      'enforce lane-based allocation and budget clipping in compile time',
      'prove seeded-release behavior matches current runtime behavior for representative cases',
    ],
  };

  const phasePlans = [
    makePlan({
      plan_id: '01',
      objective: 'Schema + shared types + curated seed import',
      scope: 'Implement schema + shared types + curated seed import.',
    }),
    makePlan({
      plan_id: '02',
      objective: 'Release generation / diff / rollback routes + admin/operator auth model',
      scope: 'Implement release generation / diff / rollback routes + admin/operator auth model.',
      depends_on: ['01'],
    }),
    makePlan({
      plan_id: '03',
      objective: 'Lane-based allocator + compiler integration + migration coexistence',
      scope: 'Implement lane-based allocator + compiler integration + migration coexistence.',
      depends_on: ['02'],
    }),
  ];

  const record = buildChecker(bundle, phasePlans);
  const ids = new Set(record.findings.map((finding) => finding.id));

  assert.equal(record.result, 'concerns');
  assert(ids.has('generic-phase-scaffolding'));
  assert(ids.has('bundle-generic-verification'));
  assert(ids.has('first-phase-misaligned'));
});

test('checker allows a substantive first phase with specific verification', () => {
  const bundle = {
    lint: { findings: [] },
    mode: 'implementation',
    deliverables: [
      'schema + shared types',
      'seed import tooling',
      'compiler integration',
    ],
    integration_requirements: [
      'existing compile-time KV caching patterns',
    ],
    first_phase_contract_items: [
      'create schema',
      'create shared types',
      'import current curated sources',
      'generate a deterministic draft release',
      'wire the compiler to consume the published release',
      'prove seeded-release behavior matches current runtime behavior for representative cases',
    ],
  };

  const phasePlans = [
    makePlan({
      plan_id: '01',
      objective: 'Schema + release consumer',
      scope: 'Create the app-intel schema and shared types, import current curated sources, generate a deterministic draft release, wire the compiler to consume the published release, and prove seeded-release equivalence against representative runtime cases.',
      verify_commands: [
        { id: 'typecheck' },
        { id: 'unit-tests' },
        { id: 'seeded-release-equivalence' },
      ],
    }),
    makePlan({
      plan_id: '02',
      objective: 'Admin routes',
      scope: 'Add release publish, diff, rollback, and pin routes with admin/operator authorization checks.',
      depends_on: ['01'],
      verify_commands: [
        { id: 'typecheck' },
        { id: 'unit-tests' },
        { id: 'release-route-auth' },
      ],
    }),
  ];

  const record = buildChecker(bundle, phasePlans);

  assert.equal(record.result, 'pass');
});

test('checker still honors the legacy recommended-first-phase alias', () => {
  const bundle = {
    lint: { findings: [] },
    mode: 'implementation',
    deliverables: [
      'schema + shared types',
      'seed import tooling',
    ],
    integration_requirements: [],
    recommended_first_phase_items: [
      'create schema',
      'create shared types',
      'import current curated sources',
    ],
  };

  const phasePlans = [
    makePlan({
      plan_id: '01',
      objective: 'Schema + shared types + seed import',
      scope: 'Create the schema, shared types, and curated seed import path.',
      verify_commands: [
        { id: 'typecheck' },
        { id: 'seed-import-proof' },
      ],
    }),
  ];

  const record = buildChecker(bundle, phasePlans);
  const ids = new Set(record.findings.map((finding) => finding.id));

  assert.equal(record.result, 'pass');
  assert.equal(ids.has('first-phase-misaligned'), false);
});

test('checker flags Plan 01 contract items that are owned by later phases', () => {
  const bundle = {
    lint: { findings: [] },
    mode: 'implementation',
    deliverables: [
      'schema + shared types',
      'release generation',
      'compiler integration',
      'lane-based allocator integration',
    ],
    integration_requirements: [
      'existing compile-time KV caching patterns',
    ],
    first_phase_contract_items: [
      'create schema',
      'create shared types',
      'import current curated sources',
      'wire the compiler to consume the published release',
      'enforce lane-based allocation and budget clipping in compile time',
    ],
  };

  const phasePlans = [
    makePlan({
      plan_id: '01',
      objective: 'Schema + shared types + curated seed import',
      scope: 'Create the schema, shared types, curated seed import path, and deterministic release artifact contract.',
      verify_commands: [
        { id: 'typecheck' },
        { id: 'seed-import-proof' },
      ],
    }),
    makePlan({
      plan_id: '02',
      objective: 'Release routes',
      scope: 'Add release generation, diff, rollback, and pin routes.',
      depends_on: ['01'],
      verify_commands: [
        { id: 'typecheck' },
        { id: 'release-route-proof' },
      ],
    }),
    makePlan({
      plan_id: '03',
      objective: 'Lane-based allocator + compiler integration + migration coexistence',
      scope: 'Wire the compiler to consume the published release and enforce lane-based allocation and budget clipping at compile time.',
      depends_on: ['02'],
      verify_commands: [
        { id: 'typecheck' },
        { id: 'compiler-consumer-proof' },
        { id: 'allocator-budget-proof' },
      ],
    }),
  ];

  const record = buildChecker(bundle, phasePlans);
  const conflict = record.findings.find((finding) => finding.id === 'first-phase-ownership-conflict');

  assert.equal(record.result, 'concerns');
  assert.equal(Boolean(conflict), true);
  assert.match(conflict.details, /wire the compiler to consume the published release -> 03/);
  assert.match(conflict.details, /enforce lane-based allocation and budget clipping in compile time -> 03/);
});

test('checker does not flag ownership conflict when Plan 01 truly owns its contract', () => {
  const bundle = {
    lint: { findings: [] },
    mode: 'implementation',
    deliverables: [
      'schema + shared types',
      'seed import tooling',
      'release contract',
      'compiler integration',
    ],
    integration_requirements: [
      'existing compile-time KV caching patterns',
    ],
    first_phase_contract_items: [
      'create schema',
      'create shared types',
      'import current curated sources',
      'generate a deterministic draft release',
      'prove the release artifact shape the compiler will consume',
    ],
  };

  const phasePlans = [
    makePlan({
      plan_id: '01',
      objective: 'Schema + release contract',
      scope: 'Create the schema and shared types, import current curated sources, generate a deterministic draft release, and prove the release artifact shape the compiler will consume.',
      verify_commands: [
        { id: 'typecheck' },
        { id: 'seed-import-proof' },
        { id: 'release-contract-proof' },
      ],
    }),
    makePlan({
      plan_id: '02',
      objective: 'Release routes',
      scope: 'Add release publish, diff, rollback, and pin routes.',
      depends_on: ['01'],
      verify_commands: [
        { id: 'typecheck' },
        { id: 'release-route-proof' },
      ],
    }),
    makePlan({
      plan_id: '03',
      objective: 'Compiler cutover',
      scope: 'Switch the live compiler read path to the published release once parity evidence is green.',
      depends_on: ['02'],
      verify_commands: [
        { id: 'typecheck' },
        { id: 'compiler-cutover-proof' },
      ],
    }),
  ];

  const record = buildChecker(bundle, phasePlans);
  const ids = new Set(record.findings.map((finding) => finding.id));

  assert.equal(ids.has('first-phase-ownership-conflict'), false);
});
