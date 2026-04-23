import fs from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatSchemaPath(instancePath, missingProperty = null) {
  const base = typeof instancePath === 'string' ? instancePath.replace(/^\//, '') : '';
  const segments = base ? base.split('/').filter(Boolean) : [];
  if (missingProperty) {
    segments.push(missingProperty);
  }
  return segments.join('.');
}

function formatSchemaError(documentLabel, error) {
  const missingProperty =
    error?.keyword === 'required' && typeof error?.params?.missingProperty === 'string'
      ? error.params.missingProperty
      : null;
  const additionalProperty =
    error?.keyword === 'additionalProperties' && typeof error?.params?.additionalProperty === 'string'
      ? error.params.additionalProperty
      : null;
  const location = formatSchemaPath(error?.instancePath || '', missingProperty);
  let detail = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : 'is invalid';
  if (additionalProperty) {
    detail = `${detail} (unexpected key: ${additionalProperty})`;
  }
  return location ? `${documentLabel} ${location} ${detail}` : `${documentLabel} ${detail}`;
}

function parseDependencyReference(reference) {
  const raw = typeof reference === 'string' ? reference.trim() : '';
  if (!raw) {
    return null;
  }

  const delimiterIndex = raw.indexOf(':');
  if (delimiterIndex === -1) {
    return {
      raw,
      project: null,
      plan_id: raw,
      external: false,
    };
  }

  return {
    raw,
    project: raw.slice(0, delimiterIndex),
    plan_id: raw.slice(delimiterIndex + 1),
    external: true,
  };
}

function normalizeStringListForComparison(values, ensureArray) {
  return ensureArray(values)
    .map((value) => (typeof value === 'string' ? value.trim() : String(value ?? '').trim()))
    .filter(Boolean)
    .sort();
}

function stringListsMatch(left, right, ensureArray) {
  const normalizedLeft = normalizeStringListForComparison(left, ensureArray);
  const normalizedRight = normalizeStringListForComparison(right, ensureArray);
  if (normalizedLeft.length !== normalizedRight.length) {
    return false;
  }
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function stringListContainsAll(superset, subset, ensureArray) {
  const supersetValues = new Set(normalizeStringListForComparison(superset, ensureArray));
  return normalizeStringListForComparison(subset, ensureArray)
    .every((value) => supersetValues.has(value));
}

export function createValidationHelpers({
  planSchemaPath,
  stateSchemaPath,
  ensureArray,
  uniqueStrings,
  validateDependencyReferenceValue,
}) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validatePlanSchema = ajv.compile(JSON.parse(fs.readFileSync(planSchemaPath, 'utf8')));
  const validateStateSchema = ajv.compile(JSON.parse(fs.readFileSync(stateSchemaPath, 'utf8')));

  function validatePlan(plan) {
    const errors = [];
    const valid = validatePlanSchema(plan);
    if (!valid) {
      errors.push(...ensureArray(validatePlanSchema.errors).map((error) => formatSchemaError('PLAN.json', error)));
    }
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      return uniqueStrings(errors);
    }

    const validateCommandList = (commands, fieldName) => {
      const ids = new Set();
      for (const command of ensureArray(commands)) {
        if (!command || typeof command !== 'object' || Array.isArray(command)) {
          continue;
        }
        if (typeof command.id !== 'string' || !command.id.trim()) {
          continue;
        }
        if (ids.has(command.id)) {
          errors.push(`duplicate ${fieldName} id: ${command.id}`);
        } else {
          ids.add(command.id);
        }
      }
    };

    validateCommandList(plan.verify_commands, 'verify_commands');
    validateCommandList(plan.postflight?.commands, 'postflight.commands');

    if (!stringListContainsAll(plan.allowed_files, plan.write_scope?.allowed_files, ensureArray)) {
      errors.push('allowed_files must contain every write_scope.allowed_files entry');
    }

    if (!stringListsMatch(plan.blocked_files, plan.write_scope?.blocked_files, ensureArray)) {
      errors.push('blocked_files must match write_scope.blocked_files');
    }

    const verifyCommandIds = ensureArray(plan.verify_commands)
      .map((command) => (typeof command?.id === 'string' ? command.id.trim() : ''))
      .filter(Boolean);
    const postflightCommandIds = ensureArray(plan.postflight?.commands)
      .map((command) => (typeof command?.id === 'string' ? command.id.trim() : ''))
      .filter(Boolean);
    const commandIds = new Set(verifyCommandIds);
    const postflightCommandIdSet = new Set(postflightCommandIds);

    for (const commandId of verifyCommandIds) {
      if (postflightCommandIdSet.has(commandId)) {
        errors.push(`command id reused across verify_commands and postflight.commands: ${commandId}`);
      }
    }

    const acceptanceIds = new Set();
    for (const ac of ensureArray(plan.acceptance_criteria)) {
      if (!ac || typeof ac !== 'object' || Array.isArray(ac)) {
        continue;
      }
      const acId = typeof ac.id === 'string' ? ac.id.trim() : '';
      if (acId) {
        if (acceptanceIds.has(acId)) {
          errors.push(`duplicate acceptance criteria id: ${acId}`);
        } else {
          acceptanceIds.add(acId);
        }
      }

      for (const dependency of ensureArray(ac.command_ids)) {
        if (typeof dependency !== 'string' || !dependency.trim()) {
          continue;
        }
        if (!commandIds.has(dependency)) {
          errors.push(`acceptance_criteria[${acId || '?'}] references unknown command id: ${dependency}`);
        }
      }

      for (const signal of ensureArray(ac.signals)) {
        if (!signal || typeof signal !== 'object' || Array.isArray(signal)) {
          continue;
        }
        if (typeof signal.command_id !== 'string' || !signal.command_id.trim()) {
          continue;
        }
        if (!commandIds.has(signal.command_id)) {
          errors.push(`acceptance_criteria[${acId || '?'}] signal references unknown command id: ${signal.command_id}`);
        }
      }
    }

    for (const dependency of ensureArray(plan.depends_on)) {
      if (typeof dependency !== 'string' || !dependency.trim()) {
        continue;
      }
      validateDependencyReferenceValue(dependency, 'depends_on', errors);
    }

    return uniqueStrings(errors);
  }

  function validateState(state) {
    const errors = [];
    const valid = validateStateSchema(state);
    if (!valid) {
      errors.push(...ensureArray(validateStateSchema.errors).map((error) => formatSchemaError('STATE.json', error)));
    }
    if (!isRecord(state)) {
      return uniqueStrings(errors);
    }

    const stateProject = typeof state.project === 'string' ? state.project.trim() : '';
    const workflowPlans = ensureArray(state.workflow?.plans).filter((entry) => isRecord(entry));
    const workflowPlanIds = workflowPlans
      .map((plan) => (typeof plan.plan_id === 'string' ? plan.plan_id.trim() : ''))
      .filter(Boolean);
    const workflowPlanIdSet = new Set(workflowPlanIds);
    const seenWorkflowPlanIds = new Set();

    for (const plan of workflowPlans) {
      const planId = typeof plan.plan_id === 'string' ? plan.plan_id.trim() : '';
      if (!planId) {
        continue;
      }
      if (seenWorkflowPlanIds.has(planId)) {
        errors.push(`duplicate workflow.plans plan_id: ${planId}`);
      } else {
        seenWorkflowPlanIds.add(planId);
      }
    }

    for (const plan of workflowPlans) {
      const planId = typeof plan.plan_id === 'string' ? plan.plan_id.trim() : '?';
      for (const dependency of ensureArray(plan.depends_on)) {
        if (typeof dependency !== 'string' || !dependency.trim()) {
          continue;
        }
        validateDependencyReferenceValue(dependency, `workflow.plans[${planId}].depends_on`, errors);
        const parsed = parseDependencyReference(dependency);
        if (!parsed?.plan_id) {
          continue;
        }
        const sameProjectDependency = !parsed.external || !parsed.project || parsed.project === stateProject;
        if (sameProjectDependency && parsed.plan_id === planId) {
          errors.push(`workflow.plans[${planId}] depends on itself`);
        }
        if (sameProjectDependency && workflowPlanIdSet.size > 0 && !workflowPlanIdSet.has(parsed.plan_id)) {
          errors.push(`workflow.plans[${planId}] references unknown internal dependency: ${dependency}`);
        }
      }
    }

    const currentPlanId = typeof state.current_plan?.plan_id === 'string' ? state.current_plan.plan_id.trim() : '';
    if (currentPlanId && workflowPlanIdSet.size > 0 && !workflowPlanIdSet.has(currentPlanId)) {
      errors.push(`current_plan.plan_id is not present in workflow.plans: ${currentPlanId}`);
    }

    const runtimeDispatchById = isRecord(state.orchestration?.runtime_dispatches?.by_id)
      ? state.orchestration.runtime_dispatches.by_id
      : {};
    const runtimeDispatchEntries = Object.entries(runtimeDispatchById)
      .filter(([, entry]) => isRecord(entry));
    const allCurrentDispatchEntries = runtimeDispatchEntries
      .filter(([, entry]) => entry.current === true)
      .map(([, entry]) => entry);
    const dispatchMap = new Map();

    for (const [dispatchId, entry] of runtimeDispatchEntries) {
      dispatchMap.set(dispatchId, entry);

      const entryDispatchId = typeof entry.dispatch_id === 'string' ? entry.dispatch_id.trim() : '';
      if (!entryDispatchId) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] is missing dispatch_id`);
      } else if (entryDispatchId !== dispatchId) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] dispatch_id does not match key`);
      }

      if (typeof entry.plan_id !== 'string' || !entry.plan_id.trim()) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] is missing plan_id`);
      } else if (workflowPlanIdSet.size > 0 && !workflowPlanIdSet.has(entry.plan_id.trim())) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] references unknown workflow plan: ${entry.plan_id}`);
      }

      if (typeof entry.role !== 'string' || !entry.role.trim()) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] is missing role`);
      }
      if (typeof entry.status !== 'string' || !entry.status.trim()) {
        errors.push(`runtime_dispatches.by_id[${dispatchId}] is missing status`);
      }
    }

    const actionablePlan = isRecord(state.orchestration?.runtime_dispatch_view?.actionable_plan)
      ? state.orchestration.runtime_dispatch_view.actionable_plan
      : null;
    const actionablePlanId = typeof actionablePlan?.plan_id === 'string' ? actionablePlan.plan_id.trim() : '';
    const actionablePlanIds = ensureArray(actionablePlan?.plan_ids)
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean);
    const dispatchCountPlanIds = actionablePlanIds.length > 0
      ? actionablePlanIds
      : (actionablePlanId ? [actionablePlanId] : (currentPlanId ? [currentPlanId] : []));
    const currentDispatchEntries = dispatchCountPlanIds.length > 0
      ? allCurrentDispatchEntries.filter((entry) => dispatchCountPlanIds.includes(entry.plan_id))
      : allCurrentDispatchEntries;

    const currentActionableDispatch = isRecord(state.orchestration?.current_actionable_dispatch)
      ? state.orchestration.current_actionable_dispatch
      : null;
    if (currentActionableDispatch) {
      const dispatchId = typeof currentActionableDispatch.dispatch_id === 'string'
        ? currentActionableDispatch.dispatch_id.trim()
        : '';
      if (!dispatchId) {
        errors.push('current_actionable_dispatch is missing dispatch_id');
      } else {
        const entry = dispatchMap.get(dispatchId);
        if (!entry) {
          errors.push(`current_actionable_dispatch references unknown dispatch_id: ${dispatchId}`);
        } else {
          for (const field of ['plan_id', 'role', 'status', 'capsule_json']) {
            const left = typeof currentActionableDispatch[field] === 'string'
              ? currentActionableDispatch[field].trim()
              : currentActionableDispatch[field] ?? null;
            const right = typeof entry[field] === 'string'
              ? entry[field].trim()
              : entry[field] ?? null;
            if (left != null && left !== '' && right != null && right !== '' && left !== right) {
              errors.push(`current_actionable_dispatch.${field} does not match runtime_dispatches.by_id[${dispatchId}].${field}`);
            }
          }

          const actionableFreshness = typeof currentActionableDispatch.freshness === 'string'
            ? currentActionableDispatch.freshness.trim()
            : '';
          const entryFreshness = typeof entry.freshness?.status === 'string'
            ? entry.freshness.status.trim()
            : '';
          if (actionableFreshness && entryFreshness && actionableFreshness !== entryFreshness) {
            errors.push(`current_actionable_dispatch.freshness does not match runtime_dispatches.by_id[${dispatchId}].freshness.status`);
          }
        }
      }

      if (
        actionablePlanIds.length > 0
        && typeof currentActionableDispatch.plan_id === 'string'
        && !actionablePlanIds.includes(currentActionableDispatch.plan_id.trim())
      ) {
        errors.push(`current_actionable_dispatch.plan_id is missing from runtime_dispatch_view.actionable_plan.plan_ids: ${currentActionableDispatch.plan_id.trim()}`);
      }
    }

    const currentActionableCapsule = typeof state.orchestration?.current_actionable_capsule === 'string'
      ? state.orchestration.current_actionable_capsule.trim()
      : '';
    if (currentActionableCapsule) {
      if (!currentActionableDispatch) {
        errors.push('current_actionable_capsule is set without current_actionable_dispatch');
      } else if ((currentActionableDispatch.capsule_json || '').trim() !== currentActionableCapsule) {
        errors.push('current_actionable_capsule does not match current_actionable_dispatch.capsule_json');
      }
    }

    const readyDispatches = ensureArray(state.orchestration?.runtime_dispatch_view?.ready_dispatches)
      .filter((entry) => isRecord(entry));
    const readyDispatchIds = new Set();
    for (const readyDispatch of readyDispatches) {
      const dispatchId = typeof readyDispatch.dispatch_id === 'string' ? readyDispatch.dispatch_id.trim() : '';
      if (!dispatchId) {
        errors.push('runtime_dispatch_view.ready_dispatches[] is missing dispatch_id');
        continue;
      }
      if (readyDispatchIds.has(dispatchId)) {
        errors.push(`duplicate runtime_dispatch_view.ready_dispatches dispatch_id: ${dispatchId}`);
      } else {
        readyDispatchIds.add(dispatchId);
      }

      const entry = dispatchMap.get(dispatchId);
      if (!entry) {
        errors.push(`runtime_dispatch_view.ready_dispatches references unknown dispatch_id: ${dispatchId}`);
        continue;
      }
      if (entry.current !== true) {
        errors.push(`runtime_dispatch_view.ready_dispatches includes non-current dispatch: ${dispatchId}`);
      }
      if (entry.status !== 'queued' && entry.status !== 'stale') {
        errors.push(`runtime_dispatch_view.ready_dispatches includes non-ready dispatch status for ${dispatchId}: ${entry.status}`);
      }
    }

    const dispatchCounts = isRecord(state.orchestration?.runtime_dispatch_view?.dispatch_counts)
      ? state.orchestration.runtime_dispatch_view.dispatch_counts
      : null;
    if (dispatchCounts) {
      const expectedCounts = {
        tracked: currentDispatchEntries.length,
        ready: readyDispatches.length,
        active: currentDispatchEntries.filter((entry) => entry.status === 'spawned').length,
        failed: currentDispatchEntries.filter((entry) => entry.status === 'failed').length,
        completed: currentDispatchEntries.filter((entry) => entry.status === 'completed').length,
      };
      for (const [field, expected] of Object.entries(expectedCounts)) {
        if (Number.isInteger(dispatchCounts[field]) && dispatchCounts[field] !== expected) {
          errors.push(`runtime_dispatch_view.dispatch_counts.${field} does not match runtime dispatch state: expected ${expected}, got ${dispatchCounts[field]}`);
        }
      }
    }

    if (state.lifecycle?.status === 'complete') {
      if (currentDispatchEntries.length > 0) {
        errors.push(`lifecycle.status complete cannot keep current runtime dispatches: ${currentDispatchEntries.map((entry) => entry.dispatch_id).join(', ')}`);
      }
      if (currentActionableDispatch) {
        errors.push('lifecycle.status complete cannot keep current_actionable_dispatch');
      }
      if (currentActionableCapsule) {
        errors.push('lifecycle.status complete cannot keep current_actionable_capsule');
      }
      if (readyDispatches.length > 0) {
        errors.push('lifecycle.status complete cannot keep ready runtime dispatches');
      }
      const nextCommand = typeof state.lifecycle?.next_command === 'string' ? state.lifecycle.next_command.trim() : '';
      if (nextCommand) {
        errors.push(`lifecycle.status complete cannot keep next_command: ${nextCommand}`);
      }
    }

    return uniqueStrings(errors);
  }

  return {
    formatSchemaError,
    validatePlan,
    validateState,
  };
}
