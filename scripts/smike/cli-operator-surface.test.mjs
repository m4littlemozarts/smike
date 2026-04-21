import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireCliTestLock, releaseCliTestLock } from './test-cli-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
let cliTestLock = null;

test.beforeEach(() => {
  cliTestLock = acquireCliTestLock(repoRoot);
});

test.afterEach(() => {
  releaseCliTestLock(cliTestLock);
  cliTestLock = null;
});

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

function promotePlanningToAwaitingFreshSession(project) {
  const strategistDispatchId = `${project}-plan-strategist`;
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
}

test('resume is inspection-only and does not clear the fresh-session gate', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-resume.md`;
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
    promotePlanningToAwaitingFreshSession(project);

    const before = readJson(`.smike/${project}/STATE.json`);
    const resumeOutput = runCli(['resume', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const after = readJson(`.smike/${project}/STATE.json`);

    assert.equal(before.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(after.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(after.lifecycle.next_command, `./smike advance ${project}`);
    assert.match(resumeOutput, new RegExp(`smike resume: ${project}`));
    assert.match(resumeOutput, new RegExp(`handoff: \\.smike/${project}/STATE\\.md`));
    assert.match(
      resumeOutput,
      new RegExp(`operator_requirement: stop in this session, start a fresh session, then run \\\./smike advance ${project}\\.`),
    );
  } finally {
    cleanupProject(project, specRel);
  }
});

test('bare smike resolves the next legal step for the active project', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-entrypoint.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and queue runtime-owned planning dispatches.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['activate', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const entryOutput = runCli([], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);
    const strategistDispatchId = `${project}-plan-strategist`;

    assert.match(entryOutput, new RegExp(`${strategistDispatchId} -> spawned`));
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'spawned');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('status can inspect a named project without an active pointer', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-status.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and queue runtime-owned planning dispatches.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    fs.rmSync(path.join(repoRoot, '.smike', 'ACTIVE.json'), { force: true });

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(statusOutput, new RegExp(`smike status: ${project}`));
    assert.match(statusOutput, /status: awaiting_runtime_dispatch/);
    assert.match(statusOutput, new RegExp(`inspect_command: \\\./smike status ${project}`));
    assert.match(statusOutput, new RegExp(`advance_command: \\\./smike advance ${project}`));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('project selector entrypoint resolves correctly without an active pointer', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-selector.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and queue runtime-owned planning dispatches.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    fs.rmSync(path.join(repoRoot, '.smike', 'ACTIVE.json'), { force: true });

    const entryOutput = runCli([project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);
    const strategistDispatchId = `${project}-plan-strategist`;

    assert.match(entryOutput, new RegExp(`smike activate: ${project}`));
    assert.match(entryOutput, new RegExp(`${strategistDispatchId} -> spawned`));
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'spawned');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('list shows resumable projects and marks the active one', () => {
  const specRelA = `.smike-test-tmp/smike-operator-${Date.now()}-list-a.md`;
  const specRelB = `.smike-test-tmp/smike-operator-${Date.now()}-list-b.md`;
  const projectA = slugifyProjectName(specRelA);
  const projectB = slugifyProjectName(specRelB);

  writeSpec(specRelA, `# Runtime-Owned Planning

## Objective
Produce a planning bundle with a queued runtime dispatch.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  writeSpec(specRelB, `# Generic Planning Draft

## Objective
Plan a broad implementation without committing to concrete proof commands yet.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
`);

  try {
    runCli([specRelA], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli([specRelB], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const listOutput = runCli(['list'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(listOutput, /smike list/);
    assert.match(listOutput, new RegExp(`- ${projectA}: awaiting_runtime_dispatch :: \\\./smike advance ${projectA}`));
    assert.match(listOutput, new RegExp(`\\* ${projectB}: planning_draft :: \\\./smike cycle ${projectB}`));
  } finally {
    cleanupProject(projectA, specRelA);
    cleanupProject(projectB, specRelB);
  }
});

test('STATE.md promotes itself as the canonical operator handoff', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-state.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and queue runtime-owned planning dispatches.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const stateMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/STATE.md`), 'utf8');

    assert.match(stateMd, /Canonical operator handoff: this file \(`STATE\.md`\)/);
    assert.match(stateMd, /## Operator/);
    assert.match(stateMd, new RegExp(`- handoff: \\.smike/${project}/STATE\\.md`));
    assert.match(stateMd, new RegExp(`- advance_command: \\.\\/smike advance ${project}`));
  } finally {
    cleanupProject(project, specRel);
  }
});
