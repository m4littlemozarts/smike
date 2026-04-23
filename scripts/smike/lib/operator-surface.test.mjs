import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDependencyNextAction,
  buildPlanningDraftCorrectionLoop,
  describeDependencyBlockers,
  getActionableDependencyTargets,
  getDependencyBlockerSummaryLines,
  getPlanningDraftCorrectionSummaryLines,
  getPlanningDraftNoticeLines,
} from './operator-surface.mjs';

test('planning-draft correction loop groups per-phase fixes into a one-pass action plan', () => {
  const correction = buildPlanningDraftCorrectionLoop(
    {
      blockers: [
        '01: add a concrete phase summary instead of fallback "Implement ..." text',
        '01: add at least one phase-specific proof command',
        '02: add at least one write-scope entry',
      ],
    },
    {
      clarifying_questions: ['What user-visible behavior should exist when this feature is done?'],
      primary_refs: [],
    },
  );

  assert.match(correction.summary, /answer the onboarding questions/);
  assert.match(correction.summary, /add at least one phase-specific proof command per phase/);
  assert.equal(Array.isArray(correction.phase_requirements), true);
  assert.deepEqual(correction.phase_requirements[0], {
    plan_id: '01',
    issues: [
      'add a concrete phase summary instead of fallback "Implement ..." text',
      'add at least one phase-specific proof command',
    ],
  });
  assert.match(correction.action_plan.join(' | '), /For Plan 01, replace the fallback phase summary with repo-aware scope, add a phase-specific proof command\./);
});

test('planning-draft notice and summary lines surface the new correction payload', () => {
  const state = {
    lifecycle: { status: 'planning_draft' },
    planning: {
      status: 'draft',
      draft_correction: {
        summary: 'replace generic phase summaries with concrete repo-aware scope',
        fix_targets: ['Priority N summaries', 'inline verify: commands'],
        questions: ['What routes are in scope?'],
        blockers: ['01: add at least one phase-specific proof command'],
        action_plan: ['For Plan 01, add a phase-specific proof command.'],
      },
    },
  };

  assert.deepEqual(getPlanningDraftNoticeLines(state), [
    'Planning draft notice: edits to `.smike/**` are rebuilt from the spec on the next cycle.',
    'Fix surface: update Priority N summaries, inline verify: commands in the spec, then rerun the cycle.',
  ]);
  assert.deepEqual(getPlanningDraftCorrectionSummaryLines(state), [
    'planning_draft_summary: replace generic phase summaries with concrete repo-aware scope',
    'planning_draft_fix_targets: Priority N summaries, inline verify: commands',
    'planning_draft_questions: What routes are in scope?',
    'planning_draft_blockers: 01: add at least one phase-specific proof command',
    'planning_draft_action_plan: For Plan 01, add a phase-specific proof command.',
  ]);
});

test('dependency blocker helpers resolve the actionable upstream plan and next action', () => {
  const dependencyBlockers = [
    {
      plan_id: '02',
      unmet_dependencies: [{ plan_id: '01', status: 'pending' }],
    },
    {
      plan_id: '03',
      unmet_dependencies: [{ plan_id: '02', status: 'pending' }],
    },
  ];

  assert.equal(describeDependencyBlockers(dependencyBlockers), '02 <= 01 (pending); 03 <= 02 (pending)');
  assert.deepEqual(getActionableDependencyTargets(dependencyBlockers), [{ plan_id: '01', status: 'pending' }]);
  assert.deepEqual(
    buildDependencyNextAction({
      project: 'smike-demo',
      dependencyBlockers,
      actionableTargets: [{ plan_id: '01', status: 'pending' }],
      buildCycleCommand: (project) => `./smike cycle ${project}`,
    }),
    {
      summary: 'Finish upstream plan 01 (pending) first so 02 can run, then rerun `./smike cycle smike-demo`.',
      next_command: './smike cycle smike-demo',
    },
  );
});

test('dependency blocker summary lines include unblock and next-action messaging', () => {
  const state = {
    workflow: {
      dependency_blockers: [
        {
          plan_id: '02',
          unmet_dependencies: [{ plan_id: '01', status: 'pending' }],
        },
      ],
      actionable_dependency_targets: [{ plan_id: '01', status: 'pending' }],
    },
  };

  assert.deepEqual(
    getDependencyBlockerSummaryLines({
      project: 'smike-demo',
      state,
      buildCycleCommand: (project) => `./smike cycle ${project}`,
    }),
    [
      'dependency_blockers: 02 <= 01 (pending)',
      'dependency_unblock: resolve upstream plan(s) first: 01 (pending); then rerun ./smike cycle smike-demo.',
      'dependency_next_action: Finish upstream plan 01 (pending) first so 02 can run, then rerun `./smike cycle smike-demo`.',
    ],
  );
});
