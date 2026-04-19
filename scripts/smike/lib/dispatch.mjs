import crypto from 'node:crypto';

export function createDispatchHelpers({ safeSlug, normalizePathList }) {
  function dispatchIdFor(planId, role) {
    return `${safeSlug(planId)}-${safeSlug(role)}`;
  }

  function legacyDispatchIdFor(planId, role, group) {
    return `${dispatchIdFor(planId, role)}-g${group}`;
  }

  function getRuntimeDispatchLookupIds(dispatch) {
    const ids = [dispatch.dispatch_id];
    if (Number.isInteger(dispatch.group) && dispatch.group >= 1) {
      const legacyId = legacyDispatchIdFor(dispatch.plan_id, dispatch.role, dispatch.group);
      if (!ids.includes(legacyId)) {
        ids.push(legacyId);
      }
    }
    return ids;
  }

  function compareRuntimeDispatchRecency(left, right) {
    const leftTime = Date.parse(left.last_seen_at || left.updated_at || left.created_at || '') || 0;
    const rightTime = Date.parse(right.last_seen_at || right.updated_at || right.created_at || '') || 0;
    return rightTime - leftTime;
  }

  function rekeyRuntimeDispatchEntry(byId, fromId, toId, entry) {
    if (fromId !== toId) {
      delete byId[fromId];
      byId[toId] = entry;
    }
    entry.dispatch_id = toId;
    return entry;
  }

  function resolveRuntimeDispatchEntry(byId, dispatch) {
    for (const lookupId of getRuntimeDispatchLookupIds(dispatch)) {
      const existing = byId[lookupId];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        return rekeyRuntimeDispatchEntry(byId, lookupId, dispatch.dispatch_id, existing);
      }
    }

    const matchingEntries = Object.entries(byId)
      .filter(([, entry]) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .filter(([, entry]) => entry.plan_id === dispatch.plan_id && entry.role === dispatch.role)
      .sort(([, left], [, right]) => {
        if ((left.current === true) !== (right.current === true)) {
          return left.current === true ? -1 : 1;
        }
        return compareRuntimeDispatchRecency(left, right);
      });

    if (matchingEntries.length === 0) {
      return null;
    }

    const [entryId, entry] = matchingEntries[0];
    return rekeyRuntimeDispatchEntry(byId, entryId, dispatch.dispatch_id, entry);
  }

  function dispatchSignature(dispatch) {
    return crypto.createHash('sha256').update(JSON.stringify({
      plan_id: dispatch.plan_id,
      role: dispatch.role,
      result_artifacts: normalizePathList(dispatch.result_artifacts || []),
      instruction: dispatch.instruction,
      agent_type_hint: dispatch.agent_type_hint,
      reasoning_effort_hint: dispatch.reasoning_effort_hint,
      artifact_change_required: dispatch.artifact_change_required === true,
    })).digest('hex');
  }

  return {
    dispatchIdFor,
    dispatchSignature,
    resolveRuntimeDispatchEntry,
  };
}
