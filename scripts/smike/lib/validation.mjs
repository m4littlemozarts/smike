import fs from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';

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
  const location = formatSchemaPath(error?.instancePath || '', missingProperty);
  const detail = typeof error?.message === 'string' && error.message.trim() ? error.message.trim() : 'is invalid';
  return location ? `${documentLabel} ${location} ${detail}` : `${documentLabel} ${detail}`;
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

    const commandIds = new Set(
      ensureArray(plan.verify_commands)
        .map((command) => (typeof command?.id === 'string' ? command.id.trim() : ''))
        .filter(Boolean),
    );
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
    const valid = validateStateSchema(state);
    if (valid) {
      return [];
    }
    return uniqueStrings(ensureArray(validateStateSchema.errors).map((error) => formatSchemaError('STATE.json', error)));
  }

  return {
    formatSchemaError,
    validatePlan,
    validateState,
  };
}
