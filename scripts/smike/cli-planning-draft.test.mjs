import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const tempSpecDir = path.join(repoRoot, '.smike-test-tmp');

function slugifyProjectName(input) {
  const base = path.basename(input, path.extname(input));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'smike-project';
}

function writeSpec(relativePath, markdown) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, 'utf8');
  return absolutePath;
}

function runCli(args, extraEnv = {}) {
  return execFileSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function cleanupProject(project, specRel) {
  const activePath = path.join(repoRoot, '.smike', 'ACTIVE.json');
  if (fs.existsSync(activePath)) {
    fs.rmSync(activePath, { force: true });
  }
  fs.rmSync(path.join(repoRoot, '.smike', project), { recursive: true, force: true });
  fs.rmSync(path.join(repoRoot, specRel), { force: true });
}

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
    assert.match(state.lifecycle.next_action, /Missing before promotion:/);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/CHECKER.json`)), false);
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
    assert.match(stateMd, /Fix surface: update the spec’s `Required Planning Output Shape`, `Priority N:` summaries, and inline `verify:` commands\./);
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
    assert.match(specText, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(state.lifecycle.status, 'planning_draft');
    assert.equal(state.planning.status, 'draft');
    assert.match(state.planning.intake_prompt, /build release dashboard with audit trail/i);
    assert.equal(Array.isArray(state.planning.clarifying_questions), true);
    assert.equal(state.planning.clarifying_questions.length >= 3, true);
    assert.match(state.lifecycle.next_action, /Answer onboarding questions:/);
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
    const dispatchEntries = Object.values(state.orchestration.runtime_dispatches.by_id || {});
    const dispatchRoles = new Set(dispatchEntries.map((entry) => entry.role));
    const strategistCapsulePath = state.orchestration.capsules.by_plan[`${project}-plan`].strategist;
    const detailerCapsulePath = state.orchestration.capsules.by_plan['01'].detailer;
    const strategistCapsule = readJson(strategistCapsulePath);
    const detailerCapsule = readJson(detailerCapsulePath);

    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.match(
      startOutput,
      new RegExp(`operator_requirement: run \\\./smike advance ${project} now, then mark each finished dispatch with \\\./smike dispatch ${project} completed <dispatch-id>\\.`),
    );
    assert.deepEqual(state.orchestration.runtime_dispatch_view.ready_dispatches.map((entry) => entry.role), ['strategist']);
    assert.equal(dispatchRoles.has('strategist'), true);
    assert.equal(dispatchRoles.has('detailer'), true);
    assert.equal(dispatchRoles.has('checker'), false);
    assert.equal(dispatchRoles.has('auditor'), false);

    assert.deepEqual(strategistCapsule.dispatch.result_artifacts, [
      `.smike/${project}/STRATEGY.md`,
      `.smike/${project}/ROADMAP.md`,
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

    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    fs.appendFileSync(strategyPath, '\n- strategist runtime completion test\n', 'utf8');
    fs.appendFileSync(roadmapPath, '\n- strategist runtime completion test\n', 'utf8');

    const completionOutput = runCli(
      ['dispatch', project, 'completed', strategistDispatchId],
      { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' },
    );
    assert.match(completionOutput, new RegExp(`next_command: \\\./smike advance ${project}`));

    const spawnOutput = runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(spawnOutput, /01-detailer -> spawned/);

    const state = readJson(`.smike/${project}/STATE.json`);
    assert.equal(state.lifecycle.status, 'in_progress');
    assert.equal(state.lifecycle.next_command, `./smike cycle ${project}`);
    assert.equal(state.orchestration.runtime_dispatches.by_id['01-detailer'].status, 'spawned');
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

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    fs.appendFileSync(strategyPath, '\n- strategist runtime completion test\n', 'utf8');
    fs.appendFileSync(roadmapPath, '\n- strategist runtime completion test\n', 'utf8');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const state = readJson(`.smike/${project}/STATE.json`);
    const stateMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/STATE.md`), 'utf8');
    const handoff = readJson(`.smike/${project}/IMPLEMENTATION-HANDOFF.json`);
    const planningHandoffMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/PLANNING-HANDOFF.md`), 'utf8');

    assert.equal(state.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
    assert.equal(state.orchestration.current_actionable_dispatch.dispatch_id, '01-executor');
    assert.equal(state.orchestration.current_actionable_dispatch.role, 'executor');
    assert.match(state.orchestration.current_actionable_capsule, new RegExp(`\\.smike/${project}/capsules/01-executor-capsule\\.json$`));
    assert.match(stateMd, new RegExp(`Canonical state: \\.smike/${project}/STATE\\.json`));
    assert.match(stateMd, /## Actionable Surface/);
    assert.match(stateMd, /Dispatch: 01-executor \(executor \/ queued \/ pending\)/);
    assert.match(stateMd, new RegExp(`Command: \\.\\/smike advance ${project}`));
    assert.equal(handoff.actionable_surface.plan_id, '01');
    assert.equal(handoff.actionable_surface.current_dispatch.dispatch_id, '01-executor');
    assert.equal(Array.isArray(handoff.phase_graph), true);
    assert.match(planningHandoffMd, /# Planning Handoff/);
    assert.match(planningHandoffMd, new RegExp(`Next command: \\.\\/smike advance ${project}`));
    assert.match(planningHandoffMd, /- 01: depends on none/);
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

    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    fs.appendFileSync(strategyPath, '\n- strategist runtime completion test\n', 'utf8');
    fs.appendFileSync(roadmapPath, '\n- strategist runtime completion test\n', 'utf8');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    runCli(['dispatch', project, 'spawned', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', '01-detailer'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    fs.appendFileSync(strategyPath, '\n- stale planning artifact trigger\n', 'utf8');

    const cycleOutput = runCli(['cycle', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);

    assert.match(cycleOutput, new RegExp(`smike recheck ${project}: PASS`));
    assert.equal(state.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
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

    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    fs.appendFileSync(strategyPath, '\n- strategist runtime completion test\n', 'utf8');
    fs.appendFileSync(roadmapPath, '\n- strategist runtime completion test\n', 'utf8');
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

    assert.match(advanceOutput, new RegExp(`${strategistDispatchId} -> spawned`));
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'spawned');
    assert.equal(state.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(state.lifecycle.next_command, `./smike advance ${project}`);
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

    const strategyPath = path.join(repoRoot, `.smike/${project}/STRATEGY.md`);
    const roadmapPath = path.join(repoRoot, `.smike/${project}/ROADMAP.md`);
    fs.appendFileSync(strategyPath, '\n- strategist runtime completion test\n', 'utf8');
    fs.appendFileSync(roadmapPath, '\n- strategist runtime completion test\n', 'utf8');

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

    const updatedPhasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    assert.equal(updatedPhasePlan.scope, 'runtime-edited scope survives rerun');
  } finally {
    cleanupProject(project, specRel);
  }
});
