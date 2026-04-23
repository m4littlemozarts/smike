import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatchHelpers } from './dispatch.mjs';

const uniqueStrings = (values) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value).trim())
    .filter(Boolean),
)];

const normalizeDispatchCompletionRequirements = (value, resultArtifacts = [], artifactChangeRequired = false) => ({
  artifact_requirements: uniqueStrings(resultArtifacts).map((artifactPath) => ({
    path: artifactPath,
    kind: artifactPath.endsWith('.json') ? 'json' : 'file',
    must_exist: true,
    must_be_nonempty: true,
    must_parse_json: artifactPath.endsWith('.json'),
  })),
  require_artifact_change: value?.require_artifact_change === true || artifactChangeRequired === true,
});

const { dispatchIdFor, dispatchSignature, resolveRuntimeDispatchEntry } = createDispatchHelpers({
  safeSlug: (value) => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  normalizePathList: uniqueStrings,
  normalizeDispatchCompletionRequirements,
});

test('resolveRuntimeDispatchEntry prefers the current matching entry over a newer non-current entry', () => {
  const byId = {
    olderCurrent: {
      dispatch_id: 'olderCurrent',
      plan_id: '01',
      role: 'executor',
      current: true,
      updated_at: '2026-04-20T00:00:00.000Z',
    },
    newerNonCurrent: {
      dispatch_id: 'newerNonCurrent',
      plan_id: '01',
      role: 'executor',
      current: false,
      updated_at: '2026-04-21T00:00:00.000Z',
    },
  };

  const resolved = resolveRuntimeDispatchEntry(byId, {
    dispatch_id: '01-executor',
    plan_id: '01',
    role: 'executor',
  });

  assert.equal(resolved, byId['01-executor']);
  assert.equal(resolved.dispatch_id, '01-executor');
  assert.equal('olderCurrent' in byId, false);
  assert.equal('newerNonCurrent' in byId, true);
});

test('dispatchSignature stays stable for equivalent dispatches and changes when the contract changes', () => {
  const baseDispatch = {
    dispatch_id: dispatchIdFor('01', 'detailer'),
    plan_id: '01',
    role: 'detailer',
    result_artifacts: ['.smike/demo/phases/01/01-PLAN.json'],
    instruction: 'Write the detailed phase plan.',
    agent_type_hint: 'default',
    reasoning_effort_hint: 'high',
    artifact_change_required: true,
    completion_requirements: null,
  };

  const identicalCopy = {
    ...baseDispatch,
    result_artifacts: ['.smike/demo/phases/01/01-PLAN.json'],
  };
  const changedDispatch = {
    ...baseDispatch,
    agent_type_hint: 'worker',
  };

  assert.equal(dispatchSignature(baseDispatch), dispatchSignature(identicalCopy));
  assert.notEqual(dispatchSignature(baseDispatch), dispatchSignature(changedDispatch));
});
