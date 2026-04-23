import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createValidationHelpers } from './validation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ensureArray = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  return value == null ? [] : [value];
};

const uniqueStrings = (values) => [...new Set(ensureArray(values).map((value) => String(value).trim()).filter(Boolean))];

const { formatSchemaError, validatePlan, validateState } = createValidationHelpers({
  planSchemaPath: path.join(__dirname, '..', 'schemas', 'plan.schema.json'),
  stateSchemaPath: path.join(__dirname, '..', 'schemas', 'state.schema.json'),
  ensureArray,
  uniqueStrings,
  validateDependencyReferenceValue(reference, fieldName, errors) {
    if (typeof reference !== 'string' || !reference.trim()) {
      errors.push(`${fieldName}[] must be non-empty strings`);
      return;
    }
    const parts = reference.split(':');
    if (parts.length > 2 || parts.some((part) => !part.trim())) {
      errors.push(`${fieldName}[] cross-project references must use "project:plan-id"`);
    }
  },
});

function makePlan() {
  return {
    $schema: '../../scripts/smike/schemas/plan.schema.json',
    schema_version: '2.1.0',
    profile: 'codex',
    plan_id: 'demo-plan',
    phase: 'Planning',
    spec: 'demo.md',
    objective: 'Create a demo plan.',
    scope: 'Planning only.',
    depends_on: [],
    allowed_files: ['.smike/demo/**'],
    blocked_files: ['.env*'],
    write_scope: {
      mode: 'strict',
      allowed_files: ['.smike/demo/**'],
      blocked_files: ['.env*'],
    },
    preflight: {
      require_clean_worktree: false,
      required_tools: ['node'],
      required_env_vars: [],
    },
    verify_commands: [
      {
        id: 'verify-demo',
        run: 'echo ok',
      },
    ],
    acceptance_criteria: [
      {
        id: 'AC-1',
        description: 'Demo verified',
        command_ids: ['verify-demo'],
        signals: [
          {
            command_id: 'verify-demo',
            expected_signal: 'exit=0',
          },
        ],
      },
    ],
    postflight: {
      commands: [],
    },
  };
}

function makeState() {
  return {
    $schema: '../../scripts/smike/schemas/state.schema.json',
    schema_version: '2.1.0',
    profile: 'codex',
    project: 'demo',
    created_at: '2026-04-23T00:00:00.000Z',
    updated_at: '2026-04-23T00:00:00.000Z',
    current_plan: {
      plan_id: '01',
      plan_json: '.smike/demo/phases/01/01-PLAN.json',
      plan_md: '.smike/demo/phases/01/01-PLAN.md',
      depends_on: [],
    },
    lifecycle: {
      status: 'awaiting_runtime_dispatch',
      cycle_count: 1,
      last_started_at: null,
      last_completed_at: null,
      last_result: null,
      next_action: 'Spawn executor',
      stop_reason: 'awaiting_runtime_dispatch',
      next_command: './smike advance demo',
      advance_behavior: 'spawn_only',
      advance_behavior_detail: 'Spawn the current actionable runtime dispatch.',
    },
    workflow: {
      auto_continue: true,
      stop_on_failure: true,
      max_phases_per_run: 10,
      plans: [
        {
          plan_id: '01',
          plan_json: '.smike/demo/phases/01/01-PLAN.json',
          plan_md: '.smike/demo/phases/01/01-PLAN.md',
          depends_on: [],
          status: 'pending',
        },
      ],
      dependency_blockers: [],
      actionable_dependency_targets: [],
      dependency_next_action: null,
    },
    history: [],
    orchestration: {
      stage: 'execution',
      active_role: null,
      last_role: null,
      next_role: 'executor',
      discovery_propagation: true,
      role_history: [],
      runtime_dispatches: {
        by_id: {
          '01-executor': {
            dispatch_id: '01-executor',
            plan_id: '01',
            role: 'executor',
            group: 1,
            current: true,
            status: 'queued',
            capsule_json: '.smike/demo/capsules/01-executor.json',
            freshness: {
              status: 'pending',
              checked_at: null,
              reason: null,
            },
          },
        },
      },
      runtime_dispatch_view: {
        actionable_plan: {
          plan_id: '01',
          plan_ids: ['01'],
          group: 1,
          completable_group: 'none',
        },
        ready_dispatches: [
          {
            dispatch_id: '01-executor',
            plan_id: '01',
            role: 'executor',
            group: 1,
            status: 'queued',
          },
        ],
        dispatch_counts: {
          tracked: 1,
          ready: 1,
          active: 0,
          failed: 0,
          completed: 0,
        },
      },
      current_actionable_dispatch: {
        dispatch_id: '01-executor',
        plan_id: '01',
        group: 1,
        role: 'executor',
        status: 'queued',
        freshness: 'pending',
        capsule_json: '.smike/demo/capsules/01-executor.json',
      },
      current_actionable_capsule: '.smike/demo/capsules/01-executor.json',
      capsules: {
        latest_by_role: {},
        by_plan: {},
      },
    },
  };
}

test('validateState passes for a coherent runtime dispatch surface', () => {
  const errors = validateState(makeState());
  assert.deepEqual(errors, []);
});

test('validateState rejects duplicate workflow plan ids and bad internal dependencies', () => {
  const state = makeState();
  state.workflow.plans.push({
    plan_id: '01',
    plan_json: '.smike/demo/phases/01/01b-PLAN.json',
    depends_on: ['02', '01'],
  });

  const errors = validateState(state);

  assert(errors.includes('duplicate workflow.plans plan_id: 01'));
  assert(errors.includes('workflow.plans[01] depends on itself'));
  assert(errors.includes('workflow.plans[01] references unknown internal dependency: 02'));
});

test('validateState rejects actionable dispatch drift against runtime dispatches', () => {
  const state = makeState();
  state.orchestration.current_actionable_dispatch.status = 'spawned';
  state.orchestration.current_actionable_capsule = '.smike/demo/capsules/other.json';

  const errors = validateState(state);

  assert(errors.includes('current_actionable_dispatch.status does not match runtime_dispatches.by_id[01-executor].status'));
  assert(errors.includes('current_actionable_capsule does not match current_actionable_dispatch.capsule_json'));
});

test('validateState rejects ready-dispatch and count drift', () => {
  const state = makeState();
  state.orchestration.runtime_dispatch_view.ready_dispatches = [
    { dispatch_id: 'missing-dispatch' },
  ];
  state.orchestration.runtime_dispatch_view.dispatch_counts.ready = 3;
  state.orchestration.runtime_dispatch_view.dispatch_counts.tracked = 2;

  const errors = validateState(state);

  assert(errors.includes('runtime_dispatch_view.ready_dispatches references unknown dispatch_id: missing-dispatch'));
  assert(errors.includes('runtime_dispatch_view.dispatch_counts.ready does not match runtime dispatch state: expected 1, got 3'));
  assert(errors.includes('runtime_dispatch_view.dispatch_counts.tracked does not match runtime dispatch state: expected 1, got 2'));
});

test('validateState rejects terminal states that still advertise actionable runtime work', () => {
  const state = makeState();
  state.lifecycle.status = 'complete';
  state.lifecycle.next_command = './smike advance demo';

  const errors = validateState(state);

  assert(errors.includes('lifecycle.status complete cannot keep current runtime dispatches: 01-executor'));
  assert(errors.includes('lifecycle.status complete cannot keep current_actionable_dispatch'));
  assert(errors.includes('lifecycle.status complete cannot keep current_actionable_capsule'));
  assert(errors.includes('lifecycle.status complete cannot keep ready runtime dispatches'));
  assert(errors.includes('lifecycle.status complete cannot keep next_command: ./smike advance demo'));
});

test('validateState rejects runtime-owned lifecycle states missing next-command authority fields', () => {
  const state = makeState();
  delete state.lifecycle.next_command;
  delete state.lifecycle.advance_behavior;
  delete state.lifecycle.advance_behavior_detail;
  delete state.lifecycle.stop_reason;

  const errors = validateState(state);

  assert(errors.includes("STATE.json lifecycle.next_command must have required property 'next_command'"));
  assert(errors.includes("STATE.json lifecycle.advance_behavior must have required property 'advance_behavior'"));
  assert(errors.includes("STATE.json lifecycle.advance_behavior_detail must have required property 'advance_behavior_detail'"));
  assert(errors.includes("STATE.json lifecycle.stop_reason must have required property 'stop_reason'"));
});

test('validateState rejects dispatch authority records missing required fields', () => {
  const state = makeState();
  delete state.orchestration.runtime_dispatches.by_id['01-executor'].group;
  state.orchestration.runtime_dispatch_view.ready_dispatches = [
    {
      dispatch_id: '01-executor',
      plan_id: '01',
      role: 'executor',
      status: 'queued',
    },
  ];
  state.orchestration.current_actionable_dispatch = {
    dispatch_id: '01-executor',
    plan_id: '01',
    role: 'executor',
    status: 'queued',
  };

  const errors = validateState(state);

  assert(errors.includes("STATE.json orchestration.runtime_dispatches.by_id.01-executor.group must have required property 'group'"));
  assert(errors.includes("STATE.json orchestration.runtime_dispatch_view.ready_dispatches.0.group must have required property 'group'"));
  assert(errors.includes("STATE.json orchestration.current_actionable_dispatch.group must have required property 'group'"));
});

test('validateState rejects unexpected keys on strict runtime dispatch projection objects', () => {
  const state = makeState();
  state.orchestration.runtime_dispatch_view.actionable_plan.unexpected_stage_flag = true;
  state.orchestration.runtime_dispatch_view.dispatch_counts.queued = 1;
  state.orchestration.current_actionable_dispatch.retry_token = 'stale';

  const errors = validateState(state);

  assert(errors.includes('STATE.json orchestration.runtime_dispatch_view.actionable_plan must NOT have additional properties (unexpected key: unexpected_stage_flag)'));
  assert(errors.includes('STATE.json orchestration.runtime_dispatch_view.dispatch_counts must NOT have additional properties (unexpected key: queued)'));
  assert(errors.includes('STATE.json orchestration.current_actionable_dispatch must NOT have additional properties (unexpected key: retry_token)'));
});

test('formatSchemaError includes unexpected additional-property keys', () => {
  const message = formatSchemaError('PLAN.json', {
    keyword: 'additionalProperties',
    instancePath: '/planning_context',
    message: 'must NOT have additional properties',
    params: {
      additionalProperty: 'production_gate',
    },
  });

  assert.equal(
    message,
    'PLAN.json planning_context must NOT have additional properties (unexpected key: production_gate)',
  );
});

test('validatePlan accepts extended planning_context fields and names unexpected keys', () => {
  const validPlan = makePlan();
  validPlan.planning_context = {
    truth_sources: ['README.md'],
    production_gate: ['01', '02'],
    optional_phase: '09',
    phase_order_notes: ['Phase 01 must finish before Phase 02.'],
    parallel_groups: [
      {
        group: 2,
        phases: ['02', '03'],
        write_surfaces: {
          '02': ['src/routes/send.ts'],
          '03': ['src/routes/threads.ts'],
        },
      },
    ],
    operator_checkpoints: [
      {
        phase: '03',
        checkpoint: 'Attach Email Routing after deploy.',
      },
    ],
    collision_matrix: [
      {
        shared_paths: ['src/routes/admin.ts'],
        owner_split: {
          '01': 'bootstrap only',
          '08': 'retention only',
        },
        rule: 'Keep responsibilities split.',
      },
    ],
    risk_controls: [
      {
        risk: 'token drift',
        control: 'mint scoped tokens late',
      },
    ],
    explicit_deferrals: ['Phase 09 is optional.'],
    protected_areas: ['style-guides/**'],
  };
  assert.deepEqual(validatePlan(validPlan), []);

  const invalidPlan = makePlan();
  invalidPlan.phase_blueprints = [];
  invalidPlan.planning_context = {
    truth_sources: ['README.md'],
    not_allowed: ['x'],
  };

  const errors = validatePlan(invalidPlan);

  assert(errors.includes('PLAN.json must NOT have additional properties (unexpected key: phase_blueprints)'));
  assert(errors.includes('PLAN.json planning_context must NOT have additional properties (unexpected key: not_allowed)'));
});

test('validatePlan rejects top-level/write-scope file drift and cross-list command id reuse', () => {
  const plan = makePlan();
  plan.allowed_files = ['src/routes/**'];
  plan.write_scope.allowed_files = ['src/routes/**', 'src/lib/**'];
  plan.blocked_files = ['.env*', 'secrets/**'];
  plan.write_scope.blocked_files = ['.env*'];
  plan.postflight.commands = [
    {
      id: 'verify-demo',
      run: 'echo cleanup',
    },
  ];

  const errors = validatePlan(plan);

  assert(errors.includes('allowed_files must contain every write_scope.allowed_files entry'));
  assert(errors.includes('blocked_files must match write_scope.blocked_files'));
  assert(errors.includes('command id reused across verify_commands and postflight.commands: verify-demo'));
});

test('validatePlan accepts broader allowed_files so long as write scope stays inside it', () => {
  const plan = makePlan();
  plan.allowed_files = ['src/docs/**', 'src/lib/**', 'src/routes/**'];
  plan.write_scope.allowed_files = ['src/routes/**', 'src/lib/**'];
  plan.blocked_files = ['secrets/**', '.env*'];
  plan.write_scope.blocked_files = ['.env*', 'secrets/**'];

  assert.deepEqual(validatePlan(plan), []);
});
