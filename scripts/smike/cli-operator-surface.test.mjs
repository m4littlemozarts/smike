import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendStrategistArtifactChange,
  cleanupArchive,
  cleanupProject,
  installCliTestLocking,
  readJson,
  repoRoot,
  runCli,
  runCliExpectFailure,
  slugifyProjectName,
  writeSpec,
} from './test-cli-harness.mjs';

installCliTestLocking(test);

function snapshotRuntimeArtifacts(paths) {
  return paths.map((artifactPath) => {
    const absolutePath = path.join(repoRoot, artifactPath);
    if (!fs.existsSync(absolutePath)) {
      return {
        path: artifactPath,
        exists: false,
        sha256: null,
        size_bytes: 0,
        mtime_ms: null,
      };
    }

    const contents = fs.readFileSync(absolutePath);
    const stats = fs.statSync(absolutePath);
    return {
      path: artifactPath,
      exists: true,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      size_bytes: stats.size,
      mtime_ms: stats.mtimeMs,
    };
  });
}

function promotePlanningToAwaitingFreshSession(project, extraEnv = {}) {
  const strategistDispatchId = `${project}-plan-strategist`;
  runCli(['dispatch', project, 'spawned', strategistDispatchId], {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    ...extraEnv,
  });

  appendStrategistArtifactChange(project, 'strategist runtime completion test');
  runCli(['dispatch', project, 'completed', strategistDispatchId], {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    ...extraEnv,
  });

  runCli(['dispatch', project, 'spawned', '01-detailer'], {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    ...extraEnv,
  });
  const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
  const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
  phasePlan.notes = [...(phasePlan.notes || []), 'detailer runtime completion test'];
  fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');
  runCli(['dispatch', project, 'completed', '01-detailer'], {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    ...extraEnv,
  });
  runCli(['cycle', project], {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    ...extraEnv,
  });
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
    assert.match(resumeOutput, new RegExp(`Do this now: \\.\\/smike advance ${project}`));
    assert.match(
      resumeOutput,
      new RegExp(`Requirement: stop in this session, start a fresh session, then run \\\./smike advance ${project}\\.`),
    );
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance clears the fresh-session gate once and records that the one-time planning handoff was consumed', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-fresh-session-consumed.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the one-time fresh-session handoff into implementation.

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
    assert.equal(before.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(before.planning.fresh_session_gate_consumed, true);

    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const after = readJson(`.smike/${project}/STATE.json`);

    assert.match(advanceOutput, new RegExp(`smike resume: cleared implementation gate for ${project}`));
    assert.notEqual(after.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(after.planning.fresh_session_gate_consumed, true);
    assert.equal(after.workflow.pause_reason, null);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('awaiting_fresh_session writes a planning reset snapshot and status surfaces the reset command', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-planning-snapshot.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the one-time fresh-session handoff into implementation.

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

    const snapshotManifest = readJson(`.smike-snapshots/${project}/planning-ready/MANIFEST.json`);
    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.equal(snapshotManifest.snapshot_kind, 'planning-ready');
    assert.equal(snapshotManifest.lifecycle_status, 'awaiting_fresh_session');
    assert.equal(snapshotManifest.workspace_baseline.mode, 'git_head_plus_untracked');
    assert.match(statusOutput, new RegExp(`planning_snapshot: \\.smike-snapshots/${project}/planning-ready`));
    assert.match(statusOutput, new RegExp(`planning_reset: run \`\\.\\/smike reset-planning ${project}\``));
    assert.match(statusOutput, /workspace_baseline: measured against current git HEAD plus untracked files at the planning handoff; no commit is required\./);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('reset-planning restores the saved fresh-session handoff and workspace baseline', () => {
  const specRel = `memories/smike-operator-${Date.now()}-reset-planning.md`;
  const project = slugifyProjectName(specRel);
  const baselineSpecContents = `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the one-time fresh-session handoff into implementation.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`;

  writeSpec(specRel, baselineSpecContents);

  const postPlanningPath = `memories/${project}-post-planning.ts`;
  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    promotePlanningToAwaitingFreshSession(project);

    fs.writeFileSync(path.join(repoRoot, specRel), `${baselineSpecContents}\n<!-- drift -->\n`, 'utf8');
    fs.writeFileSync(path.join(repoRoot, postPlanningPath), 'export const drift = true;\n', 'utf8');

    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lifecycle.status = 'failed';
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const resetOutput = runCli(['reset-planning', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const restoredState = readJson(`.smike/${project}/STATE.json`);
    const restoredSpec = fs.readFileSync(path.join(repoRoot, specRel), 'utf8');

    assert.match(resetOutput, new RegExp(`smike reset-planning: ${project}`));
    assert.equal(restoredState.lifecycle.status, 'awaiting_fresh_session');
    assert.doesNotMatch(restoredSpec, /<!-- drift -->/);
    assert.match(restoredSpec, /Produce a planning bundle that is concrete enough to pass planning review/);
    assert.match(restoredSpec, /<!-- SMIKE:CONTRACT:START -->/);
    assert.equal(fs.existsSync(path.join(repoRoot, postPlanningPath)), false);
  } finally {
    cleanupProject(project, specRel);
    fs.rmSync(path.join(repoRoot, postPlanningPath), { force: true });
  }
});

test('planning_complete durable feedback refreshes after advance clears the fresh-session gate', () => {
  const specRel = `memories/smike-operator-${Date.now()}-feedback-refresh.md`;
  const project = slugifyProjectName(specRel);
  const feedbackPath = path.join(repoRoot, '.smike-test-tmp', `${project}-feedback.md`);
  const env = {
    SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
    SMIKE_FEEDBACK_SYNC_MODE: 'planning_complete',
    SMIKE_FEEDBACK_PATH: feedbackPath,
  };

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the one-time fresh-session handoff into implementation.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration; write_scope:scripts/smike/**; verify:printf phase-01-proof)

## Priority 1: Schema slice
Define the schema slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], env);
    promotePlanningToAwaitingFreshSession(project, env);

    const beforeAdvanceFeedback = fs.readFileSync(feedbackPath, 'utf8');
    assert.match(beforeAdvanceFeedback, /- Lifecycle: awaiting_fresh_session/);

    runCli(['advance', project], env);

    const state = readJson(`.smike/${project}/STATE.json`);
    const feedback = fs.readFileSync(feedbackPath, 'utf8');

    assert.notEqual(state.lifecycle.status, 'awaiting_fresh_session');
    assert.equal(feedback.includes(`- Lifecycle: ${state.lifecycle.status}`), true);
    assert.equal(feedback.includes(`- Next command: ${state.lifecycle.next_command || 'none'}`), true);
  } finally {
    fs.rmSync(feedbackPath, { force: true });
    cleanupProject(project, specRel);
  }
});

test('status surfaces planning blockers even while runtime dispatch is the current authority step', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-planning-blockers.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and queue runtime-owned planning dispatches.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Auth slice (category:permissions; write_scope:scripts/smike/**; verify:printf auth-proof)
- Plan 02: Send slice (depends:01; category:route-architecture; write_scope:scripts/smike/**; verify:printf send-proof)

## Priority 1: Auth slice
Define the auth slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.

## Priority 2: Send slice
Define the send slice with explicit boundaries, concrete proof obligations, and a reviewable write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.planning.analysis = {
      ...(state.planning.analysis || {}),
      blocking_findings: [
        {
          source: 'checker',
          id: 'scope-overlap-01-02',
          title: 'Plans 01 and 02 overlap in write scope',
          severity: 'medium',
        },
      ],
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(
      statusOutput,
      new RegExp(`Planning blockers already exist: checker:scope-overlap-01-02`),
    );
    assert.match(
      statusOutput,
      new RegExp(`\\.\\/smike recheck ${project}`),
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
    const dispatchEntry = state.orchestration.runtime_dispatches.by_id[strategistDispatchId];

    assert.match(entryOutput, /status: awaiting_runtime_dispatch/);
    assert.match(entryOutput, new RegExp(`dispatch_ready: ${strategistDispatchId}`));
    assert.match(entryOutput, new RegExp(`\\.\\/smike dispatch ${project} spawned <dispatch-id>`));
    assert.equal(dispatchEntry.status, 'queued');
    assert.equal(dispatchEntry.active_owner, null);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('fresh wipes an existing runtime before starting a clean planning run', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-fresh.md`;
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

    const phasePlanPath = path.join(repoRoot, `.smike/${project}/phases/01/01-PLAN.json`);
    const phasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));
    phasePlan.scope = 'dirty runtime state';
    fs.writeFileSync(phasePlanPath, `${JSON.stringify(phasePlan, null, 2)}\n`, 'utf8');

    const freshOutput = runCli(['fresh', specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const refreshedPhasePlan = JSON.parse(fs.readFileSync(phasePlanPath, 'utf8'));

    assert.match(freshOutput, new RegExp(`smike fresh: removed existing runtime for ${project}`));
    assert.match(freshOutput, new RegExp(`smike start: ${project}`));
    assert.notEqual(refreshedPhasePlan.scope, 'dirty runtime state');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('unchanged spawn-baseline failures point to retry plus advance recovery', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-spawn-baseline.md`;
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
    const strategistDispatchId = `${project}-plan-strategist`;

    appendStrategistArtifactChange(project, 'pre-spawn artifact drift');
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const failureOutput = runCliExpectFailure(
      ['dispatch', project, 'completed', strategistDispatchId],
      { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' },
    );
    const state = readJson(`.smike/${project}/STATE.json`);

    assert.match(failureOutput, /unchanged from the spawn baseline/);
    assert.match(
      failureOutput,
      new RegExp(`\\.\\/smike dispatch ${project} retry ${strategistDispatchId}`),
    );
    assert.match(
      failureOutput,
      new RegExp(`\\.\\/smike advance ${project}`),
    );
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'failed');
    assert.equal(state.lifecycle.next_command, `./smike dispatch ${project} retry ${strategistDispatchId}`);
    assert.match(state.lifecycle.next_action, /edited before `spawned` was recorded/);
    assert.equal(
      state.lifecycle.next_action.includes(`rerun \`./smike advance ${project}\` to surface it again`),
      true,
    );
    assert.equal(
      state.lifecycle.next_action.includes(`./smike dispatch ${project} spawned <dispatch-id>`),
      true,
    );
    assert.equal(state.lifecycle.next_action.includes('./smike cycle'), false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('failed runtime dispatches route the operator through retry and explicit re-claim', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-retry.md`;
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
    const strategistDispatchId = `${project}-plan-strategist`;

    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const failureOutput = runCli(
      ['dispatch', project, 'failed', strategistDispatchId],
      { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' },
    );
    const failedState = readJson(`.smike/${project}/STATE.json`);

    assert.match(failureOutput, new RegExp(`${strategistDispatchId} -> failed`));
    assert.match(failureOutput, new RegExp(`next_command: \\\./smike dispatch ${project} retry ${strategistDispatchId}`));
    assert.equal(failedState.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'failed');
    assert.equal(failedState.lifecycle.next_command, `./smike dispatch ${project} retry ${strategistDispatchId}`);

    const retryOutput = runCli(
      ['dispatch', project, 'retry', strategistDispatchId],
      { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' },
    );
    const retriedState = readJson(`.smike/${project}/STATE.json`);

    assert.match(retryOutput, new RegExp(`${strategistDispatchId} -> queued`));
    assert.match(retryOutput, new RegExp(`next_command: \\\./smike advance ${project}`));
    assert.equal(retriedState.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'queued');
    assert.equal(retriedState.lifecycle.next_command, `./smike advance ${project}`);

    const requeueOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const requeuedState = readJson(`.smike/${project}/STATE.json`);

    assert.match(requeueOutput, /status: awaiting_runtime_dispatch/);
    assert.match(requeueOutput, new RegExp(`dispatch_ready: ${strategistDispatchId}`));
    assert.match(requeueOutput, new RegExp(`\\.\\/smike dispatch ${project} spawned <dispatch-id>`));
    assert.equal(requeuedState.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'queued');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('status and doctor surface expired runtime dispatch leases before reconciliation', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-lease-expiry.md`;
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
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1', SMIKE_RUNTIME_DISPATCH_LEASE_MS: '60000' });
    const strategistDispatchId = `${project}-plan-strategist`;
    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const dispatchEntry = state.orchestration.runtime_dispatches.by_id[strategistDispatchId];
    dispatchEntry.status = 'spawned';
    dispatchEntry.last_spawned_at = '2020-01-01T00:00:00.000Z';
    dispatchEntry.active_owner = {
      session_id: 'expired-session',
      pid: 123,
      host: 'smike_runner',
      command: `./smike advance ${project}`,
      claimed_at: '2020-01-01T00:00:00.000Z',
      lease_duration_ms: 60000,
      lease_expires_at: '2020-01-01T00:01:00.000Z',
    };
    state.orchestration.current_actionable_dispatch = {
      ...state.orchestration.current_actionable_dispatch,
      dispatch_id: strategistDispatchId,
      status: 'spawned',
      active_owner: dispatchEntry.active_owner,
      lease_expires_at: dispatchEntry.active_owner.lease_expires_at,
    };
    const currentDispatches = Object.values(state.orchestration.runtime_dispatches.by_id)
      .filter((entry) => entry && entry.current === true);
    const readyDispatches = currentDispatches.filter((entry) => entry.status === 'queued' || entry.status === 'stale');
    const activeDispatches = currentDispatches.filter((entry) => entry.status === 'spawned');
    const failedDispatches = currentDispatches.filter((entry) => entry.status === 'failed');
    const completedDispatches = currentDispatches.filter((entry) => entry.status === 'completed');
    state.orchestration.runtime_dispatch_view.ready_dispatches = readyDispatches.map((entry) => ({
      dispatch_id: entry.dispatch_id,
      plan_id: entry.plan_id,
      role: entry.role,
      group: entry.group,
      status: entry.status,
      freshness: entry.freshness?.status || null,
    }));
    state.orchestration.runtime_dispatch_view.dispatch_counts = {
      tracked: currentDispatches.length,
      ready: readyDispatches.length,
      active: activeDispatches.length,
      failed: failedDispatches.length,
      completed: completedDispatches.length,
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const doctorOutput = runCliExpectFailure(['doctor', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(statusOutput, new RegExp(`dispatch_owner: ${strategistDispatchId} \\(expired-session`));
    assert.match(statusOutput, new RegExp(`dispatch_lease: ${strategistDispatchId} \\(2020-01-01T00:01:00.000Z\\)`));
    assert.match(statusOutput, new RegExp(`dispatch_lease_expired: ${strategistDispatchId} \\(Runtime dispatch lease expired at 2020-01-01T00:01:00.000Z;`));
    assert.match(doctorOutput, /error expired-runtime-dispatch-lease:/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('advance reclaims orphaned runtime dispatch owners before lease expiry', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-orphaned-owner.md`;
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
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1', SMIKE_RUNTIME_DISPATCH_LEASE_MS: '60000' });
    runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1', SMIKE_RUNTIME_DISPATCH_LEASE_MS: '60000' });

    const strategistDispatchId = `${project}-plan-strategist`;
    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const dispatchEntry = state.orchestration.runtime_dispatches.by_id[strategistDispatchId];
    dispatchEntry.spawn_baseline = snapshotRuntimeArtifacts(dispatchEntry.result_artifacts || []);
    dispatchEntry.status = 'spawned';
    dispatchEntry.last_spawned_at = '2099-01-01T00:00:00.000Z';
    dispatchEntry.active_owner = {
      session_id: 'orphaned-session',
      pid: 999999,
      host: 'smike_runner',
      command: `./smike advance ${project}`,
      claimed_at: '2099-01-01T00:00:00.000Z',
      lease_duration_ms: 60000,
      lease_expires_at: '2099-01-01T00:01:00.000Z',
    };
    state.orchestration.current_actionable_dispatch = {
      ...state.orchestration.current_actionable_dispatch,
      dispatch_id: strategistDispatchId,
      status: 'spawned',
      freshness: 'pending',
      active_owner: dispatchEntry.active_owner,
      lease_expires_at: dispatchEntry.active_owner.lease_expires_at,
    };
    const currentDispatches = Object.values(state.orchestration.runtime_dispatches.by_id)
      .filter((entry) => entry && entry.current === true);
    const readyDispatches = currentDispatches.filter((entry) => entry.status === 'queued' || entry.status === 'stale');
    const activeDispatches = currentDispatches.filter((entry) => entry.status === 'spawned');
    const failedDispatches = currentDispatches.filter((entry) => entry.status === 'failed');
    const completedDispatches = currentDispatches.filter((entry) => entry.status === 'completed');
    state.orchestration.runtime_dispatch_view.ready_dispatches = readyDispatches.map((entry) => ({
      dispatch_id: entry.dispatch_id,
      plan_id: entry.plan_id,
      role: entry.role,
      group: entry.group,
      status: entry.status,
      freshness: entry.freshness?.status || null,
    }));
    state.orchestration.runtime_dispatch_view.dispatch_counts = {
      tracked: currentDispatches.length,
      ready: readyDispatches.length,
      active: activeDispatches.length,
      failed: failedDispatches.length,
      completed: completedDispatches.length,
    };
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const doctorOutput = runCliExpectFailure(['doctor', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const advanceOutput = runCli(['advance', project], {
      SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1',
      SMIKE_RUNTIME_DISPATCH_LEASE_MS: '60000',
    });
    const recoveredState = readJson(`.smike/${project}/STATE.json`);
    const recoveredDispatch = recoveredState.orchestration.runtime_dispatches.by_id[strategistDispatchId];

    assert.match(statusOutput, new RegExp(`dispatch_owner_orphaned: ${strategistDispatchId} \\(Runtime dispatch owner pid 999999 exited before completing the dispatch\\.\\)`));
    assert.match(doctorOutput, /error orphaned-runtime-dispatch-owner:/);
    assert.match(advanceOutput, new RegExp(`smike advance: reclaiming orphaned runtime dispatches for ${project}: ${strategistDispatchId}`));
    assert.match(advanceOutput, new RegExp(`dispatch_ready: ${strategistDispatchId}`));
    assert.equal(recoveredDispatch.status, 'stale');
    assert.equal(recoveredDispatch.last_owner?.pid, 999999);
    assert.equal(recoveredDispatch.active_owner, null);
    assert.equal(
      recoveredDispatch.transition_log.some(
        (entry) => entry.status === 'stale' && /owner pid 999999 exited before completing the dispatch/.test(entry.reason || ''),
      ),
      true,
    );
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
    assert.match(statusOutput, /advance_behavior: spawn_only/);
    assert.match(statusOutput, new RegExp(`Inspect only: \\\./smike status ${project}`));
    assert.match(statusOutput, new RegExp(`Do this now: \\\./smike advance ${project}`));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('status warns when legacy state is missing state-backed handoff projection fields', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-projection-warning.md`;
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
    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    delete state.lifecycle.advance_behavior;
    delete state.lifecycle.advance_behavior_detail;
    delete state.planning.analysis;
    delete state.planning.verification;
    delete state.workflow.dependency_blockers;
    delete state.workflow.actionable_dependency_targets;
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(statusOutput, /projection_warning: STATE\.json is missing state-backed handoff fields/);
    assert.match(statusOutput, new RegExp(`projection_recovery: run \`\\.\\/smike generate ${project}\` to refresh the projection without changing workflow state\\.`));
  } finally {
    cleanupProject(project, specRel);
  }
});

test('status surfaces the thin implementation profile once execution becomes actionable', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-implementation-profile.md`;
  const project = slugifyProjectName(specRel);

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
    promotePlanningToAwaitingFreshSession(project);

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(statusOutput, /status: awaiting_fresh_session/);
    assert.match(statusOutput, /execution_profile: thin_executor_first/);
    assert.match(statusOutput, /runtime_promotion: complexity_gated_executor_only/);
    assert.match(statusOutput, /runtime_follow_on_roles: local_only/);
    assert.match(statusOutput, /runtime_roles: executor/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('completed runtime executor evidence satisfies reconciliation material-change checks', () => {
  const timestamp = Date.now();
  const specRel = `.smike-test-tmp/smike-operator-${timestamp}-runtime-evidence.md`;
  const outputRel = `.smike-test-tmp/smike-operator-${timestamp}-runtime-output.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(outputRel, '# Runtime evidence placeholder\n');
  writeSpec(specRel, `# Runtime Executor Evidence

## Objective
Produce a planning bundle whose implementation phase is runtime-owned and proves completed executor dispatch evidence during reconciliation.

## Required Deliverable From This Loop
1. Update \`${outputRel}\` so it contains the exact marker text \`SMIKE smoke marker\`.

## Required Planning Output Shape
- Plan 01: Runtime executor evidence bridge (category:verification; write_scope:${outputRel},README.md,docs/README.md,docs/smike-feedback.md,scripts/smike/RUNTIME_ORCHESTRATOR.md; verify:test -s ${outputRel} && rg -n "SMIKE smoke marker" ${outputRel} | test -s ${outputRel} | rg -n "SMIKE smoke marker" ${outputRel})

## Priority 1: Runtime executor evidence bridge
Update only \`${outputRel}\`, include the marker text, and verify it with the declared commands. The broader declared write scope and repeated verifier intentionally force runtime executor promotion for this regression.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const strategistDispatchId = `${project}-plan-strategist`;
    runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const rootPlanPath = path.join(repoRoot, `.smike/${project}/PLAN.json`);
    const rootPlan = JSON.parse(fs.readFileSync(rootPlanPath, 'utf8'));
    rootPlan.workflow = {
      ...(rootPlan.workflow || {}),
      fresh_session_gate: 'never',
    };
    rootPlan.notes = [...(rootPlan.notes || []), 'runtime evidence regression keeps implementation in-session'];
    fs.writeFileSync(rootPlanPath, `${JSON.stringify(rootPlan, null, 2)}\n`, 'utf8');
    runCli(['dispatch', project, 'completed', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const readyState = readJson(`.smike/${project}/STATE.json`);
    assert.equal(readyState.lifecycle.status, 'awaiting_runtime_dispatch');
    assert.equal(readyState.orchestration.current_actionable_dispatch.dispatch_id, '01-executor');

    runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCli(['dispatch', project, 'spawned', '01-executor'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    fs.writeFileSync(
      path.join(repoRoot, outputRel),
      '# Runtime evidence output\n\nSMIKE smoke marker\n',
      'utf8',
    );
    const runtimeArtifactRel = `.smike/${project}/phases/01/01-executor-runtime.json`;
    fs.writeFileSync(
      path.join(repoRoot, runtimeArtifactRel),
      `${JSON.stringify({
        schema_version: '1.0.0',
        project,
        plan_id: '01',
        role: 'executor',
        result: 'implemented',
        changed_files: [outputRel],
      }, null, 2)}\n`,
      'utf8',
    );
    runCli(['dispatch', project, 'completed', '01-executor'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const advanceOutput = runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const after = readJson(`.smike/${project}/STATE.json`);
    const planRun = after.history.find((entry) => entry?.plan_id === '01' && entry?.cycle === 2);

    assert.match(advanceOutput, new RegExp(`smike cycle ${project}: PASS`));
    assert.equal(after.lifecycle.status, 'complete');
    assert.equal(planRun?.result, 'pass');
    assert.equal(planRun?.material_evidence?.pass, true);
    assert.deepEqual(planRun?.runtime_executor_evidence?.changed_paths, [outputRel]);
    assert.deepEqual(planRun?.scope?.changed_paths, [outputRel]);
  } finally {
    cleanupProject(project, specRel);
    fs.rmSync(path.join(repoRoot, outputRel), { force: true });
  }
});

test('generate reopens false-positive local completions that recorded failed material evidence', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-no-material-change.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Runtime-Owned Planning

## Objective
Produce a planning bundle that is concrete enough to pass planning review and open the one-time fresh-session handoff into implementation.

## Required Deliverable From This Loop
1. A concrete planning bundle with phase-specific verification.

## Required Planning Output Shape
- Plan 01: Auth bootstrap (category:permissions; write_scope:src/auth/token.ts,src/routes/domains.ts,src/app.ts; verify:rg -n "wrong-scope bearer" plan-email-mcp.md)

## Priority 1: Auth bootstrap
Define the auth bootstrap slice with explicit boundaries and a narrow write surface.
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    promotePlanningToAwaitingFreshSession(project);
    runCli(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    runCliExpectFailure(['advance', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const cycleNumber = (state.lifecycle?.cycle_count || 0) + 1;
    state.workflow.plans = state.workflow.plans.map((plan) => (
      plan.plan_id === '01'
        ? {
          ...plan,
          status: 'complete',
          last_result: 'pass',
          last_cycle: cycleNumber,
        }
        : plan
    ));
    state.lifecycle.status = 'complete';
    state.lifecycle.last_result = 'pass';
    state.lifecycle.next_action = 'Scope complete.';
    state.lifecycle.next_command = null;
    state.orchestration.current_actionable_dispatch = null;
    state.orchestration.current_actionable_capsule = null;
    if (state.orchestration.runtime_dispatch_view) {
      state.orchestration.runtime_dispatch_view.ready_dispatches = [];
      if (state.orchestration.runtime_dispatch_view.dispatch_counts) {
        state.orchestration.runtime_dispatch_view.dispatch_counts.ready = 0;
        state.orchestration.runtime_dispatch_view.dispatch_counts.active = 0;
        state.orchestration.runtime_dispatch_view.dispatch_counts.failed = 0;
        state.orchestration.runtime_dispatch_view.dispatch_counts.completed = 0;
        state.orchestration.runtime_dispatch_view.dispatch_counts.tracked = 0;
      }
    }
    if (state.orchestration.runtime_dispatches?.by_id) {
      state.orchestration.runtime_dispatches.by_id = {};
    }
    state.history.push({
      cycle: cycleNumber,
      plan_id: '01',
      plan_json: `.smike/${project}/phases/01/01-PLAN.json`,
      plan_md: null,
      objective: 'Auth bootstrap',
      scope_text: 'Implement auth bootstrap and domain discovery boundaries.',
      started_at: '2026-04-23T00:00:00.000Z',
      completed_at: '2026-04-23T00:00:01.000Z',
      result: 'pass',
      failures: [],
      preflight: {
        passed: true,
        checks: [{
          type: 'workspace_dirty',
          required_clean: false,
          dirty_count: 0,
          dirty_paths: [],
          dirty_paths_truncated: false,
          pass: true,
          message: 'ok',
        }],
      },
      verify_commands: [{
        id: 'verify-1',
        run: 'rg -n "wrong-scope bearer" plan-email-mcp.md',
        cwd: '.',
        status: 0,
        pass: true,
        duration_ms: 1,
        stdout_tail: 'wrong-scope bearer',
        stderr_tail: '',
      }],
      acceptance: [{
        id: 'AC-1',
        description: '01 verification: verify-1',
        pass: true,
        checks: [],
        command_ids: ['verify-1'],
      }],
      scope: {
        mode: 'delta',
        pass: true,
        changed_paths: [],
        allowed_globs: ['src/auth/token.ts', 'src/routes/domains.ts', 'src/app.ts'],
        blocked_globs: [],
        violations: [],
      },
      material_evidence: {
        required: true,
        pass: false,
        reason: 'No fresh in-scope file delta was observed for this execution phase.',
      },
      postflight: [],
    });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const generateOutput = runCli(['generate', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const after = readJson(`.smike/${project}/STATE.json`);

    assert.match(generateOutput, new RegExp(`derived artifacts regenerated for ${project}`));
    assert.equal(after.workflow.plans.find((plan) => plan.plan_id === '01')?.status, 'pending');
    assert.equal(after.workflow.plans.find((plan) => plan.plan_id === '01')?.reopened_reason, 'missing_material_change_evidence');
  } finally {
    cleanupProject(project, specRel);
  }
});

test('doctor reports awaiting_runtime_dispatch contract drift when the operator tuple is mutated', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-awaiting-dispatch-drift.md`;
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
    const statePath = path.join(repoRoot, `.smike/${project}/STATE.json`);
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.lifecycle.stop_reason = 'in_progress';
    state.lifecycle.next_command = `./smike dispatch ${project} spawned ${project}-plan-strategist`;
    state.lifecycle.advance_behavior = 'follow_next_command';
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const doctorOutput = runCliExpectFailure(['doctor', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(doctorOutput, new RegExp(`smike doctor: ${project}`));
    assert.match(doctorOutput, /result: FAIL/);
    assert.match(doctorOutput, /error awaiting-runtime-dispatch-stop-reason-mismatch:/);
    assert.match(doctorOutput, /error awaiting-runtime-dispatch-next-command-mismatch:/);
    assert.match(doctorOutput, /error awaiting-runtime-dispatch-advance-behavior-mismatch:/);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('status and STATE.md surface actionable dependency blockers for draft plans', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-dependency-blockers.md`;
  const project = slugifyProjectName(specRel);

  writeSpec(specRel, `# Generic Planning Draft

## Objective
Plan a broad implementation with explicit dependency ordering across multiple slices.

## Required Deliverable From This Loop
1. A planning bundle for the broad implementation.

## Required Planning Output Shape
- Plan 01: Schema slice (category:migration)
- Plan 02: Route slice (depends:01; category:permissions)
- Plan 03: Audit trail slice (depends:02; category:ui)
`);

  try {
    runCli([specRel], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    fs.rmSync(path.join(repoRoot, '.smike', 'ACTIVE.json'), { force: true });

    const statusOutput = runCli(['status', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const state = readJson(`.smike/${project}/STATE.json`);
    const stateMd = fs.readFileSync(path.join(repoRoot, `.smike/${project}/STATE.md`), 'utf8');

    assert.match(statusOutput, /status: planning_draft/);
    assert.match(statusOutput, /planning_draft_summary: .*replace generic phase summaries with concrete repo-aware scope/);
    assert.match(statusOutput, /planning_draft_fix_targets: .*Priority N summaries/);
    assert.match(statusOutput, /planning_draft_action_plan: .*For Plan 01.*For Plan 02.*For Plan 03/);
    assert.match(statusOutput, /dependency_blockers: 02 <= 01 \(pending\); 03 <= 02 \(pending\)/);
    assert.match(
      statusOutput,
      new RegExp(`dependency_unblock: resolve upstream plan\\(s\\) first: 01 \\(pending\\); then rerun \\\./smike cycle ${project}\\.`),
    );
    assert.match(
      statusOutput,
      new RegExp(`dependency_next_action: Finish upstream plan 01 \\(pending\\) first so 02 can run, then rerun \`\\.\\/smike cycle ${project}\`\\.`),
    );
    assert.equal(Array.isArray(state.workflow.dependency_blockers), true);
    assert.deepEqual(
      state.workflow.dependency_blockers.map((blocker) => blocker.plan_id),
      ['02', '03'],
    );
    assert.deepEqual(state.workflow.actionable_dependency_targets, [{ plan_id: '01', status: 'pending' }]);
    assert.match(state.workflow.dependency_next_action, new RegExp(`Finish upstream plan 01 \\(pending\\) first so 02 can run, then rerun \`\\.\\/smike cycle ${project}\`\\.`));
    assert.match(stateMd, /## Dependency Blockers/);
    assert.match(stateMd, /Summary: 02 <= 01 \(pending\); 03 <= 02 \(pending\)/);
    assert.match(stateMd, /Actionable upstream plans: 01 \(pending\)/);
    assert.match(stateMd, new RegExp(`Do this now: Finish upstream plan 01 \\(pending\\) first so 02 can run, then rerun \`\\.\\/smike cycle ${project}\`\\.`));
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
    assert.match(entryOutput, /status: awaiting_runtime_dispatch/);
    assert.match(entryOutput, new RegExp(`dispatch_ready: ${strategistDispatchId}`));
    assert.equal(state.orchestration.runtime_dispatches.by_id[strategistDispatchId].status, 'queued');
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
    assert.match(stateMd, new RegExp(`Supporting machine view: \\.smike/${project}/IMPLEMENTATION-HANDOFF\\.json`));
    assert.match(stateMd, /## Next Step/);
    assert.match(stateMd, new RegExp(`- Do this now: \\.\\/smike advance ${project}`));
    assert.match(stateMd, new RegExp(`- Inspect only: \\.\\/smike status ${project}`));
    assert.match(stateMd, new RegExp(`- Requirement: use \`\\.\\/smike\` for the normal mutating step; \`\\.\\/smike advance ${project}\` remains the exact authority for this state\\.`));
    assert.match(stateMd, new RegExp(`- Requirement: after the runtime-owned work finishes, mark each dispatch with \\.\\/smike dispatch ${project} completed <dispatch-id>\\.`));
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/OPERATOR-SUMMARY.md`)), false);
  } finally {
    cleanupProject(project, specRel);
  }
});

test('archive refuses live runtime dispatches unless abandon-live-dispatches is explicit', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-archive-live.md`;
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
    const strategistDispatchId = `${project}-plan-strategist`;
    runCli(['dispatch', project, 'spawned', strategistDispatchId], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    const archiveFailure = runCliExpectFailure(['archive', project, '--force'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(archiveFailure, /refusing to archive .* while runtime dispatches are still live/);
    assert.equal(fs.existsSync(path.join(repoRoot, '.smike', project)), true);

    const archiveOutput = runCli(['archive', project, '--force', '--abandon-live-dispatches'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(archiveOutput, new RegExp(`smike archive: ${project}`));
    assert.match(archiveOutput, /abandoned_live_dispatches:/);
    assert.equal(fs.existsSync(path.join(repoRoot, '.smike', project)), false);
    assert.equal(fs.existsSync(path.join(repoRoot, '.smike-archive', project)), true);
  } finally {
    cleanupProject(project, specRel);
    cleanupArchive(project);
  }
});

test('restore validates runtime state and regenerates missing derived artifacts', () => {
  const specRel = `.smike-test-tmp/smike-operator-${Date.now()}-restore-validate.md`;
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

    const archiveOutput = runCli(['archive', project, '--force'], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    assert.match(archiveOutput, new RegExp(`smike archive: ${project}`));

    fs.rmSync(path.join(repoRoot, '.smike-archive', project, 'project', 'STATE.md'), { force: true });
    fs.rmSync(path.join(repoRoot, '.smike-archive', project, 'project', 'IMPLEMENTATION-HANDOFF.json'), { force: true });

    const restoreOutput = runCli(['restore', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });
    const doctorOutput = runCli(['doctor', project], { SMIKE_ALLOW_TEST_ACTIVE_PROJECT: '1' });

    assert.match(restoreOutput, new RegExp(`smike restore: ${project}`));
    assert.match(restoreOutput, new RegExp(`validated: \\.smike/${project}/STATE\\.json`));
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/STATE.md`)), true);
    assert.equal(fs.existsSync(path.join(repoRoot, `.smike/${project}/IMPLEMENTATION-HANDOFF.json`)), true);
    assert.match(doctorOutput, /result: PASS/);
  } finally {
    cleanupProject(project, specRel);
    cleanupArchive(project);
  }
});
