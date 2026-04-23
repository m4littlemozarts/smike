import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendStrategistArtifactChange,
  cleanupProject,
  installCliTestLocking,
  readJson,
  repoRoot,
  runCli,
  slugifyProjectName,
  tempSpecDir,
  withRepoConfig,
  writeSpec,
} from './test-cli-harness.mjs';

installCliTestLocking(test);

test('new broad planning runs stay in planning_draft without checker or auditor gating', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-generic.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Generic Planning Draft

## Objective
Plan a broad implementation without committing to concrete proof commands yet.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);
    assert.equal(state.lifecycle.status, 'planning_draft');
    assert.equal(state.planning.status, 'draft');
    assert.match(state.lifecycle.next_action, /Correction loop:/);
    assert.match(state.lifecycle.next_action, /concrete repo-aware scope/);
    assert.equal(Array.isArray(state.planning.draft_correction?.blockers), true);
    assert.equal(state.planning.draft_correction.blockers.length > 0, true);
    assert.equal(Array.isArray(state.planning.draft_correction?.action_plan), true);
    assert.equal(state.planning.draft_correction.action_plan.length > 0, true);
    assert.match(state.planning.draft_correction.action_plan.join(' | '), /For Plan 01/);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/CHECKER.json`)), false);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/AUDITOR.json`)), false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('draft planning ignores legacy AUDIT artifacts', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-legacy-audit.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Generic Planning Draft

## Objective
Plan a broad implementation without committing to concrete proof commands yet.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const auditJsonPath = path.join(repoRoot, `.smike/${project}/AUDIT.json`);
    const auditMdPath = path.join(repoRoot, `.smike/${project}/AUDIT.md`);
    fs.writeFileSync(auditJsonPath, `${JSON.stringify({ result: 'pass', findings: [] }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(auditMdPath, '# Legacy AUDIT\n', 'utf8');

    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.equal(fs.existsSync(auditJsonPath), true);
    assert.equal(fs.existsSync(auditMdPath), true);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/AUDITOR.json`)), false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('STATE.md surfaces that planning_draft is spec-driven', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-status.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Generic Planning Draft

## Objective
Plan a broad implementation without committing to concrete proof commands yet.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const stateMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/STATE.md`), 'utf8');
    assert.match(stateMd, /Planning draft notice: edits to `\.smike\/\*\*` are rebuilt from the spec on the next cycle\./);
    assert.match(stateMd, /Fix surface: update .*Priority N summaries.*in the spec, then rerun the cycle\./);
    assert.match(stateMd, /## Planning Draft Correction Loop/);
    assert.match(stateMd, /Summary: .*replace generic phase summaries with concrete repo-aware scope/);
    assert.match(stateMd, /Promotion blockers:/);
    assert.match(stateMd, /One-pass spec patch:/);
    assert.match(stateMd, /For Plan 01, /);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('planning draft honors repo portability override defaults for generated verify commands', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-python-defaults.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Python Defaults

## Objective
Plan a bounded service slice with repo-level portability overrides.

## Required Deliverable From This Loop
1. A planning bundle for the service slice.

## Required Planning Output Shape
- Plan 01: Service slice (category:migration; write_scope:src/**)

## Priority 1: Service slice
Define the service slice with concrete boundaries and explicit scope.
`);

  try {
    withRepoConfig({
      framework_dir: '.',
      portability_heuristics: {
        default_verify_family: 'python',
      },
    }, () => {
      runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    });

    const phasePlan = readJson(`.smike/${project}/phases/01/01-PLAN.json`);

    assert.deepEqual(phasePlan.preflight.required_tools, ['python', 'git']);
    assert.deepEqual(phasePlan.verify_commands.map((command) => command.id), ['verify-1']);
    assert.match(phasePlan.verify_commands[0].run, /plan-01-spec-ready/);
    assert.match(phasePlan.verify_commands[0].run, new RegExp(specRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('planning draft blocks malformed or generic explicit verify commands before promotion', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-verify-lint.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Verify Lint

## Objective
Plan a bounded implementation slice with explicit but invalid proof commands.

## Required Deliverable From This Loop
1. A planning bundle for the implementation slice.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:npm test|printf "broken)

## Priority 1: Schema slice
Define the schema slice with concrete boundaries and proof commands.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);
    const blockers = state.planning.draft_correction?.blockers || [];

    assert.equal(state.lifecycle.status, 'planning_draft');
    assert.match(blockers.join(' | '), /phase-01-verify-command-generic/);
    assert.match(state.lifecycle.next_action, /planning-spec lint blockers/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('freeform prompt bootstraps a planning_draft project without a separate command', () => {
  const promptParts = ['build', 'release', 'dashboard', 'with', 'audit', 'trail', String(Date.now())];
  const prompt = promptParts.join(' ');
  let project = null;
  let specRel = null;

  try {
    runCli(promptParts, { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const active = readJson('.smike/ACTIVE.json');
    project = active.project;
    specRel = active.spec_path;

    const state = readJson(`.smike/${project}/STATE.json`);
    const specText = fs.readFileSync(path.join(repoRoot, specRel), 'utf8');

    assert.match(specRel, /^memories\/build-release-dashboard-with-audit-trail-/);
    assert.match(specText, /## Intake Prompt/);
    assert.match(specText, /## Clarifying Questions/);
    assert.match(specText, /## Planning Design Prompt/);
    assert.match(specText, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(state.planning.status, 'in_progress');
    assert.match(state.planning.intake_prompt, /build release dashboard with audit trail/i);
    assert.equal(Array.isArray(state.planning.clarifying_questions), true);
    assert.equal(state.planning.clarifying_questions.length >= 3, true);
    assert.match(state.lifecycle.next_action, /Launch runtime dispatch group 1/);
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
  } finally {
    if (project && specRel) {
      cleanupProject(project, specRel);
    }
  }
});

test('freeform prompt accepts explicit spec and context paths', () => {
  const prompt = `add account-level feature flags ${Date.now()}`;
  const specRel = `.smike-test-tmp/intake-${Date.now()}.md`;
  const project = slugifyProjectName(specRel);

  try {
    runCli([
      prompt,
      `--spec=${specRel}`,
      '--context=README.md,scripts/smike/SPEC_AUTHORING.md',
    ], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const active = readJson('.smike/ACTIVE.json');
    const state = readJson(`.smike/${project}/STATE.json`);
    const specText = fs.readFileSync(path.join(repoRoot, specRel), 'utf8');

    assert.equal(active.spec_path, specRel);
    assert.deepEqual(active.context_files, ['README.md', 'scripts/smike/SPEC_AUTHORING.md']);
    assert.deepEqual(state.planning.context_files, ['README.md', 'scripts/smike/SPEC_AUTHORING.md']);
    assert.match(specText, /## What The Planner Must Read First/);
    assert.match(specText, /1\. README\.md/);
    assert.match(specText, /2\. scripts\/smike\/SPEC_AUTHORING\.md/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('cycle promotes a draft plan into runtime-owned planning dispatch once the spec becomes concrete', () => {
  const specRel = `.smike-test-tmp/smike-planning-draft-${Date.now()}-promote.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Generic Planning Draft

## Objective
Plan a broad implementation without committing to concrete proof commands yet.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    writeSpec(specRel, `# Promotable Planning Draft

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

    runCli(['cycle', project]);

    const state = readJson(`.smike/${project}/STATE.json`);
    assert.equal(state.planning.status, 'in_progress');
    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/CHECKER.json`)), true);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/AUDITOR.json`)), true);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('promotable planning waits for strategist/detailer runtime dispatches and writes self-contained planning capsules', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-dispatch.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

  try {
    const startOutput = runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);
    const rootPlan = readJson(`.smike/${project}/PLAN.json`);
    const phasePlan = readJson(`.smike/${project}/phases/01/01-PLAN.json`);
    const dispatchEntries = Object.values(state.orchestration.runtime_dispatches.by_id || {});
    const dispatchRoles = new Set(dispatchEntries.map((entry) => entry.role));
    const strategistCapsulePath = state.orchestration.capsules.by_plan[`${project}-plan`].strategist;
    const detailerCapsulePath = state.orchestration.capsules.by_plan['01'].detailer;
    const strategistCapsule = readJson(strategistCapsulePath);
    const detailerCapsule = readJson(detailerCapsulePath);

    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.match(
      startOutput,
      new RegExp(`Requirement: use \`\\.\\/smike\` for the normal mutating step; \`\\.\\/smike advance ${project}\` remains the exact authority for this state\\.`),
    );
    assert.match(
      startOutput,
      new RegExp(`Requirement: after the runtime-owned work finishes, mark each dispatch with \\.\\/smike dispatch ${project} completed <dispatch-id>\\.`),
    );
    assert.deepEqual(state.orchestration.runtime_dispatch_view.ready_dispatches.map((entry) => entry.role), ['strategist']);
    assert.equal(dispatchRoles.has('strategist'), true);
    assert.equal(dispatchRoles.has('detailer'), true);
    assert.equal(dispatchRoles.has('checker'), false);
    assert.equal(dispatchRoles.has('auditor'), false);
    assert.equal('dispatch_artifacts' in (rootPlan.delegation || {}), false);
    assert.equal('dispatch_artifacts' in (phasePlan.delegation || {}), false);
    assert.equal(phasePlan.execution_policy.profile, 'thin_executor_first');
    assert.equal(phasePlan.execution_policy.runtime.promotion, 'complexity_gated_executor_only');
    assert.equal(phasePlan.execution_policy.runtime.follow_on_roles, 'local_only');
    assert.deepEqual(phasePlan.execution_policy.runtime.roles, ['executor']);
    assert.equal(phasePlan.execution_policy.quality.judge_rerun_verify, true);
    assert.deepEqual(phasePlan.execution_policy.quality.review_focus_areas, ['scope_control', 'verification_contract']);
    assert.equal(phasePlan.feature_flags.implementation_profile, 'thin_executor_first');
    assert.equal(phasePlan.feature_flags.implementation_runtime_promotion, 'complexity_gated_executor_only');
    assert.equal(phasePlan.feature_flags.implementation_runtime_follow_on_roles, 'local_only');
    assert.equal('quality_gates' in phasePlan, false);
    assert.equal('runtime_roles' in (phasePlan.delegation || {}), false);

    assert.deepEqual(strategistCapsule.dispatch.result_artifacts, [
      `.smike/${project}/PLAN.json`,
    ]);
    assert.equal(strategistCapsule.dispatch.artifact_change_required, true);
    assert.equal(strategistCapsule.dispatch.completion_requirements.require_artifact_change, true);
    assert.equal('completion_checks' in strategistCapsule.dispatch, false);
    assert.equal(
      strategistCapsule.dispatch.completion_requirements.artifact_requirements[0].must_be_nonempty,
      true,
    );
    assert.deepEqual(strategistCapsule.outputs.expected_artifacts, strategistCapsule.dispatch.result_artifacts);
    assert.equal(Array.isArray(strategistCapsule.context_snapshot.phase_blueprints), true);
    assert.equal(strategistCapsule.context_snapshot.phase_blueprints.length, 2);

    assert.deepEqual(detailerCapsule.dispatch.result_artifacts, [
      `.smike/${project}/phases/01/01-PLAN.json`,
    ]);
    assert.equal(detailerCapsule.dispatch.artifact_change_required, true);
    assert.equal(detailerCapsule.dispatch.completion_requirements.require_artifact_change, true);
    assert.equal('completion_checks' in detailerCapsule.dispatch, false);
    assert.equal(detailerCapsule.dispatch.completion_requirements.artifact_requirements[0].must_parse_json, true);
    assert.deepEqual(detailerCapsule.outputs.expected_artifacts, detailerCapsule.dispatch.result_artifacts);
    assert.equal(detailerCapsule.context_snapshot.phase_blueprint.id, '01');
    assert.deepEqual(detailerCapsule.context_snapshot.phase_blueprint.write_scope_allowed_files, ['scripts/smike/**']);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('strategist completion advances to a spawnable detailer dispatch', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-detailer-spawn.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');

    const completionOutput = runCli(
      ['dispatch', project, 'completed', strategistDispatchId],
      { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' },
    );
    assert.match(completionOutput, new RegExp(`next_command: \\\./smike advance ${project}`));

    const spawnOutput = runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(spawnOutput, /01-detailer -> spawned/);

    const state = readJson(`.smike/${project}/STATE.json`);
    assert.equal(state.lifecycle.status, 'in_progress');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
    assert.equal(state.orchestration.runtime_dispatches.by_id['01-detailer'].status, 'spawned');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('active strategist dispatch remains the actionable surface while later planning dispatches are queued', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-active-dispatch.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const spawnOutput = runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);
    const handoff = readJson(`.smike/${project}/IMPLEMENTATION-HANDOFF.json`);

    assert.match(spawnOutput, new RegExp(`${strategistDispatchId} -> spawned`));
    assert.equal(state.orchestration.current_actionable_dispatch.dispatch_id, strategistDispatchId);
    assert.equal(state.orchestration.current_actionable_dispatch.status, 'spawned');
    assert.match(statusOutput, new RegExp(`actionable_dispatch: ${strategistDispatchId} \\(strategist / spawned / pending\\)`));
    assert.match(statusOutput, /dispatch_group: 1/);
    assert.equal(handoff.actionable_surface.current_dispatch.dispatch_id, strategistDispatchId);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('planning completion enters awaiting_fresh_session and exposes the actionable executor surface', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-fresh-session.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**,docs/**,README.md,smike,package.json; verify:printf phase-01-proof)

## What The Planner Must Read First
1. README.md
2. scripts/smike/SPEC_AUTHORING.md

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Explicit Deferrals
- private fleet observation
- paid metadata provider integration

## Protected / High-Collision Areas
- scripts/smike/cli.mjs
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);
    const rootPlan = readJson(`.smike/${project}/PLAN.json`);
    const stateMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/STATE.md`), 'utf8');
    const handoff = readJson(`.smike/${project}/IMPLEMENTATION-HANDOFF.json`);
    const executorCapsule = JSON.parse(fs.readFileSync(state.orchestration.current_actionable_capsule, 'utf8'));

    assert.equal(state.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
    assert.equal(state.lifecycle.advance_behavior, 'stop_at_fresh_session_gate');
    assert.equal(typeof state.planning.analysis, 'object');
    assert.equal(Array.isArray(state.planning.analysis.blocking_findings), true);
    assert.equal(typeof state.planning.verification, 'object');
    assert.equal(Array.isArray(state.workflow.dependency_blockers), true);
    assert.equal(state.orchestration.current_actionable_dispatch.dispatch_id, '01-executor');
    assert.equal(state.orchestration.current_actionable_dispatch.role, 'executor');
    assert.match(state.orchestration.current_actionable_capsule, new RegExp(`\\.smike/${project}/capsules/01-executor-capsule\\.json$`));
    assert.deepEqual(
      executorCapsule.outputs.expected_artifacts || [],
      executorCapsule.dispatch.result_artifacts || [],
    );
    assert.doesNotMatch(JSON.stringify(executorCapsule.outputs || {}), /EXEC-REPORT\.md/);
    assert.equal(Array.isArray(executorCapsule.outputs.verification_commands), true);
    assert.equal(executorCapsule.outputs.verification_commands.length > 0, true);
    assert.equal(Array.isArray(executorCapsule.outputs.acceptance_criteria), true);
    assert.equal(executorCapsule.outputs.acceptance_criteria.length > 0, true);
    assert.equal(executorCapsule.context_snapshot.phase_contract.write_scope_allowed_files[0], 'scripts/smike/**');
    assert.equal(executorCapsule.context_snapshot.execution_surface.artifact_mode, 'artifact_driven');
    assert.equal(phasePlan.execution_policy.profile, 'thin_executor_first');
    assert.equal(phasePlan.execution_policy.runtime.promotion, 'complexity_gated_executor_only');
    assert.equal(phasePlan.execution_policy.runtime.follow_on_roles, 'local_only');
    assert.deepEqual(phasePlan.execution_policy.runtime.roles, ['executor']);
    assert.equal(phasePlan.execution_policy.quality.judge_rerun_verify, true);
    assert.equal(phasePlan.feature_flags.implementation_profile, 'thin_executor_first');
    assert.equal(phasePlan.feature_flags.implementation_runtime_promotion, 'complexity_gated_executor_only');
    assert.equal(phasePlan.feature_flags.implementation_runtime_follow_on_roles, 'local_only');
    assert.equal('quality_gates' in phasePlan, false);
    assert.equal('runtime_roles' in (phasePlan.delegation || {}), false);
    assert.match(stateMd, new RegExp(`Canonical state: \\.smike/${project}/STATE\\.json`));
    assert.match(stateMd, /Delegation owner: runtime_orchestrator/);
    assert.match(stateMd, /Delegation mode: runtime_subagents/);
    assert.match(stateMd, /Implementation profile: thin_executor_first/);
    assert.match(stateMd, /Runtime promotion: complexity_gated_executor_only/);
    assert.match(stateMd, /Runtime follow-on roles: local_only/);
    assert.match(stateMd, /Runtime roles: executor/);
    assert.match(stateMd, /Authority surface: Use STATE\.json lifecycle plus orchestration\.current_actionable_dispatch\/current_actionable_capsule\./);
    assert.match(stateMd, /Actionable dispatch: 01-executor \(executor \/ queued \/ pending\)/);
    assert.match(stateMd, new RegExp(`Actionable capsule: \\.smike/${project}/capsules/01-executor-capsule\\.json`));
    assert.match(stateMd, /Advance behavior: stop_at_fresh_session_gate/);
    assert.match(stateMd, /## Next Step/);
    assert.match(stateMd, new RegExp(`Do this now: \\.\\/smike advance ${project}`));
    assert.match(stateMd, /## Actionable Surface/);
    assert.match(stateMd, /Implementation profile: thin_executor_first/);
    assert.match(stateMd, /Dispatch: 01-executor \(executor \/ queued \/ pending\)/);
    assert.match(stateMd, new RegExp(`Command: \\.\\/smike advance ${project}`));
    assert.deepEqual(rootPlan.planning_context.truth_sources, [
      'README.md',
      'scripts/smike/SPEC_AUTHORING.md',
      specRel,
    ]);
    assert.deepEqual(rootPlan.planning_context.explicit_deferrals, [
      'private fleet observation',
      'paid metadata provider integration',
    ]);
    assert.deepEqual(rootPlan.planning_context.protected_areas, ['scripts/smike/cli.mjs']);
    assert.deepEqual(rootPlan.planning_context.production_gate, ['01']);
    assert.equal(handoff.actionable_surface.plan_id, '01');
    assert.equal(handoff.actionable_surface.current_dispatch.dispatch_id, '01-executor');
    assert.deepEqual(handoff.truth_sources, [
      'README.md',
      'scripts/smike/SPEC_AUTHORING.md',
      specRel,
    ]);
    assert.deepEqual(handoff.deferred_items, [
      'private fleet observation',
      'paid metadata provider integration',
    ]);
    assert.deepEqual(handoff.protected_areas, ['scripts/smike/cli.mjs']);
    assert.equal(Array.isArray(handoff.phase_graph), true);
    assert.equal(typeof handoff.planning_context_hash, 'string');
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/OPERATOR-SUMMARY.md`)), false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('planning completion can continue in-session when workflow.fresh_session_gate is never', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-no-fresh-gate.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and continue directly into execution without a fresh-session stop.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**,docs/**,README.md,smike,package.json; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const rootPlanPath = path.join(repoRoot, `.smike/${project}/PLAN.json`);
    const rootPlan = JSON.parse(fs.readFileSync(rootPlanPath, 'utf8'));
    rootPlan.workflow = {
      ...(rootPlan.workflow || {}),
      fresh_session_gate: 'never',
    };
    fs.writeFileSync(rootPlanPath, `${JSON.stringify(rootPlan, null, 2)}\n`, 'utf8');

    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);

    assert.equal(state.workflow.fresh_session_gate, 'never');
    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(state.lifecycle.advance_behavior, 'spawn_only');
    assert.equal(state.orchestration.current_actionable_dispatch.dispatch_id, '01-executor');
    assert.equal(state.orchestration.current_actionable_dispatch.role, 'executor');
    assert.match(state.lifecycle.next_command, new RegExp(`^\\.\\/smike advance ${project}$`));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('doctor reports pass for a coherent runtime-owned planning bundle', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-doctor.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and expose a consistent derived handoff surface.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const doctorOutput = runCli(['doctor', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(doctorOutput, new RegExp(`smike doctor: ${project}`));
    assert.match(doctorOutput, /result: PASS/);
    assert.match(doctorOutput, /inputs_snapshot_root: \.smike\/.*\/inputs/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('recheck restores missing planning inputs from project snapshots', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-restore.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that remains recheckable even if the working-tree spec temporarily disappears.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    fs.rmSync(path.join(repoRoot, specRel), { force: true });

    const recheckOutput = runCli(['recheck', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(recheckOutput, new RegExp(`smike: restored planning inputs for ${project}`));
    assert.equal(fs.existsSync(path.join(repoRoot, specRel)), true);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('cycle auto-routes into planning recheck when planning artifacts changed after verification', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-recheck.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'stale planning artifact trigger');

    const cycleOutput = runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);

    assert.match(cycleOutput, new RegExp(`smike recheck ${project}: PASS`));
    assert.equal(state.lifecycle.status, 'in_progress');
    assert.equal(state.lifecycle.next_command, `./smike cycle ${project}`);
    assert.equal(state.planning.verification.stale, false);
    assert.equal(Array.isArray(state.planning.verification.verification_paths), true);
    assert.equal(state.history[state.history.length - 1].plan_id, `${project}-plan`);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('semantic completion rules reject changed but empty json artifacts', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-semantic-completion.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    fs.writeFileSync(phasePlanPath, '{}\n', 'utf8');

    assert.throws(
      () => runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' }),
      /Result artifact has no semantic JSON content: \.smike\/.*\/phases\/01\/01-PLAN\.json/,
    );

    const state = readJson(`.smike/${project}/STATE.json`);
    assert.equal(state.orchestration.runtime_dispatches.by_id['01-detailer'].status, 'failed');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance executes the queued dispatch spawn command', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-advance.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);
    const strategistDispatchId = `${project}-plan-strategist`;

    assert.match(advanceOutput, /status: awaiting_runtime_dispatch/);
    assert.match(advanceOutput, new RegExp(`dispatch_ready: ${strategistDispatchId}`));
    assert.match(advanceOutput, new RegExp(`\\.\\/smike dispatch ${project} spawned <dispatch-id>`));
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'queued');
    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance is idempotent while a runtime dispatch is already spawned', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-advance-active.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const before = readJson(`.smike/${project}/STATE.json`);
    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const after = readJson(`.smike/${project}/STATE.json`);

    assert.equal(before.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'spawned');
    assert.equal(after.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'spawned');
    assert.equal(after.lifecycle.status, 'in_progress');
    assert.equal(after.lifecycle.next_command, `./smike advance ${project}`);
    assert.match(advanceOutput, new RegExp(`smike advance: ${project}`));
    assert.match(advanceOutput, /status: in_progress/);
    assert.match(advanceOutput, new RegExp(`next_command: \\\./smike advance ${project}`));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance continues through planning reconciliation after runtime dispatch completion', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-advance-cycle.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);

    assert.match(advanceOutput, new RegExp(`smike recheck ${project}: PASS`));
    assert.match(advanceOutput, new RegExp(`smike advance: planning completed for ${project}; entering the fresh-session gate\\.`));
    assert.match(advanceOutput, new RegExp(`fresh_session_requirement: stop in this session and resume with \\\./smike advance ${project}\\.`));
    assert.equal(state.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
    assert.equal(state.planning.verification.stale, false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance recheck ignores removed planning narrative docs', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-deferred-drift.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Explicit Deferrals
- private fleet observation
- paid metadata provider integration
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    fs.writeFileSync(roadmapPath, '# stale roadmap\n', 'utf8');
    fs.writeFileSync(strategyPath, '# stale strategy\n', 'utf8');

    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);

    assert.match(advanceOutput, new RegExp(`smike recheck ${project}: PASS`));
    assert.equal(fs.existsSync(roadmapPath), true);
    assert.equal(fs.existsSync(strategyPath), true);
    assert.equal(state.lifecycle.status, 'awaiting_fresh_session');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('cycle after strategist completion does not record a false handoff failure', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-handoff.md`;
  const project = slugifyProjectName(specRel);
  const strategistDispatchId = `${project}-plan-strategist`;

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    appendStrategistArtifactChange(project, 'strategist runtime completion test');

    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const cycleOutput = runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.doesNotMatch(cycleOutput, /handoff_failure|did not spawn it before this cycle/i);

    const state = readJson(`.smike/${project}/STATE.json`);
    assert(['awaiting_runtime_dispatch', 'awaiting_fresh_session'].includes(state.lifecycle.status));
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
    assert.equal(
      state.history.some((entry) => entry?.event === 'handoff_failure' && entry?.dispatch_id === '01-detailer'),
      false,
    );
  } finally {
    cleanupProject(project, specRel);
  }
});

test('rerunning start does not overwrite runtime-owned planning artifacts', () => {
  const specRel = `.smike-test-tmp/smike-planning-runtime-${Date.now()}-preserve.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the fresh-session implementation gate.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)
- Plan 02: Route slice (depends:01; category:permissions; write_scope:scripts/smike/**; verify:printf phase-02-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Route slice
Define the route and auth slice with concrete boundaries, explicit proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.scope = 'runtime-edited scope survives rerun';
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');

    const rerunOutput = runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.doesNotMatch(rerunOutput, /handoff_failure|did not spawn it before this cycle/i);
    assert.match(rerunOutput, new RegExp(`smike resume-existing: ${project}`));
    assert.match(rerunOutput, /existing_created_at: /);
    assert.match(rerunOutput, /existing_updated_at: /);
    assert.match(rerunOutput, new RegExp(`existing_next_command: \\\./smike (?:cycle|advance) ${project}`));

    const updatedPhasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    assert.equal(updatedPhasePlan.scope, 'runtime-edited scope survives rerun');
  } finally {
    cleanupProject(project, specRel);
  }
});
