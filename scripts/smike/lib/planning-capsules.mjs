import { ensureArray, normalizeStringArray } from './common-utils.mjs';

export function createPlanningCapsuleWriter({
  capsuleRefLimit,
  buildPlanningSchemaContract,
  buildPlanningRoleResultArtifacts,
  buildRoleCapsule,
  ensureOrchestrationState,
  normalizePathList,
  recordRoleHistory,
  resolveOrchestrationConfig,
  updateCapsuleRefs,
  writeRoleCapsule,
}) {
  function buildPlanningStrategistContextSnapshot(bundle) {
    return {
      mode: bundle.mode,
      title: bundle.title,
      objective: bundle.objective,
      deliverables: normalizeStringArray(bundle.deliverables || []),
      constraints: normalizeStringArray(bundle.constraints || []),
      integration_requirements: normalizeStringArray(bundle.integration_requirements || []),
      risk_hotspots: normalizeStringArray(bundle.risk_hotspots || []),
      primary_refs: normalizePathList(bundle.primary_refs || []),
      phase_blueprints: ensureArray(bundle.phase_blueprints).map((phase) => ({
        id: phase.id,
        title: phase.title,
        summary: phase.summary,
        depends_on: normalizeStringArray(phase.depends_on || []),
        allowed_files: normalizePathList(phase.allowed_files || []),
        write_scope_allowed_files: normalizePathList(phase.write_scope_allowed_files || []),
      })),
      schema_contract: buildPlanningSchemaContract('strategist'),
    };
  }

  function buildPlanningDetailerContextSnapshot(bundle, phase) {
    return {
      mode: bundle.mode,
      title: bundle.title,
      root_objective: bundle.objective,
      primary_refs: normalizePathList(bundle.primary_refs || []),
      phase_blueprint: {
        id: phase.id,
        title: phase.title,
        summary: phase.summary,
        category: phase.category,
        depends_on: normalizeStringArray(phase.depends_on || []),
        allowed_files: normalizePathList(phase.allowed_files || []),
        blocked_files: normalizePathList(phase.blocked_files || []),
        write_scope_allowed_files: normalizePathList(phase.write_scope_allowed_files || []),
        write_scope_reason: phase.write_scope_reason || null,
        verification_ids: normalizeStringArray(
          ensureArray(phase.verify_commands).map((command) => command?.id),
        ),
      },
      schema_contract: buildPlanningSchemaContract('detailer'),
    };
  }

  function buildPlanningRoleGuidance(role, options = {}) {
    if (role === 'strategist') {
      return {
        readOrder: [
          'Read the spec first, then the refs that define truth and scope.',
          'Extract deliverables, constraints, protected areas, and phase boundaries before sequencing work.',
          'Before handing phase blueprints to detailers, make parallel-ready groups collision-aware: shared catch-all ownership is a planning bug, not something checker should discover for the first time.',
          'Stay inside the PLAN.json schema: sharpen notes, risks, and allowed planning_context keys instead of inventing new top-level fields.',
        ],
        questions: [
          'What must this loop deliver before implementation can be considered complete?',
          'What phase graph keeps the work reviewable and collision-aware?',
          'Which future phases can be parallel-ready, and what concrete file ownership keeps them disjoint?',
        ],
        successConditions: [
          'Strategy captures truth sources, constraints, drift seeds, and bounded phases.',
          'Planning artifacts keep downstream roles anchored on the same spec context.',
          'Parallel-ready phases name disjoint concrete write surfaces instead of shared catch-all globs such as src/db/**, scripts/**, or a single shared route file.',
          'Artifact change must materially sharpen PLAN.json with concrete sequencing, risks, notes, or review focus; placeholder churn does not count.',
          'Any new structured planning metadata stays inside allowed planning_context keys; do not add ad hoc root keys such as phase_blueprints.',
        ],
        nextAction: 'Hand bounded phase blueprints to detailers.',
      };
    }

    if (role === 'detailer') {
      return {
        readOrder: [
          'Read the root planning artifacts first so this phase inherits the same objective and constraints.',
          'Use only the refs needed for this phase and make files, checks, and dependencies explicit.',
          'If this phase could run alongside another ready phase, replace shared catch-all ownership with concrete files or force serialization explicitly.',
          'Stay inside the phase PLAN.json schema: sharpen existing keys instead of creating ad hoc phase-specific fields.',
        ],
        questions: [
          `What is the smallest reviewable slice for Plan ${options.planId || 'this phase'}?`,
          'What discoveries or dependency edges must be carried forward now?',
          'Which exact files belong to this phase, and which tempting shared files must stay owned by another phase?',
        ],
        successConditions: [
          'Phase plan is explicit about files, verification, and boundaries.',
          'Dependency edges and gotchas are captured now instead of rediscovered later.',
          `Plan ${options.planId || 'this phase'} avoids shared catch-all globs or broad directory ownership that would collide with sibling phases.`,
          `Artifact change must materially sharpen Plan ${options.planId || 'this phase'} with concrete files, verification, dependencies, or gotchas; restating existing fields does not count.`,
          `Plan ${options.planId || 'this phase'} stays within the phase PLAN.json schema and does not invent new top-level keys.`,
        ],
        nextAction: 'Hand completed phase plans to checker and auditor for cross-plan review.',
      };
    }

    if (role === 'checker') {
      return {
        readOrder: [
          'Read the phase graph before individual plans so dependency checks stay global.',
          'Look for overlap, missing edges, and discoveries that should propagate downstream.',
        ],
        questions: [
          'Do any plans overlap in scope or miss a required dependency edge?',
          'What concrete discoveries should be propagated before execution?',
        ],
        successConditions: [
          'Cross-plan mismatches and blast-radius conflicts are surfaced before execution.',
          'Checker notes stay specific enough to help later plans instead of creating noise.',
        ],
        nextAction: 'Pass any concrete discoveries to the auditor and downstream phase plans.',
      };
    }

    return {
      readOrder: [
        'Read the spec and required deliverables before looking at the phase plans.',
        'Map each promised behavior or deliverable to a concrete phase before declaring coverage.',
      ],
      questions: [
        'Which deliverables or promises are not yet traced to a concrete phase?',
        'Are any coverage matches weak or based on wording instead of behavior?',
      ],
      successConditions: [
        'Coverage gaps are concrete and traceable back to the spec.',
        'Ambiguous prose stays ambiguous instead of being silently promoted to a hard requirement.',
      ],
      nextAction: 'If coverage is sound, hand the first execution slice to the executor.',
    };
  }

  function writePlanningRoleCapsules(project, paths, bundle, rootPlan, state) {
    const orchestration = ensureOrchestrationState(state);
    const roleConfig = resolveOrchestrationConfig(project, rootPlan);
    const rootPlanRel = `.smike/${project}/PLAN.json`;

    orchestration.stage = 'planning';
    orchestration.discovery_propagation = roleConfig.discovery_propagation;
    orchestration.active_role = null;
    orchestration.last_role = null;
    orchestration.next_role = 'strategist';

    if (roleConfig.roles.strategist.enabled) {
      const strategistGuidance = buildPlanningRoleGuidance('strategist');
      const strategistCapsule = buildRoleCapsule({
        project,
        planId: rootPlan.plan_id,
        cycle: 0,
        stage: 'planning',
        role: 'strategist',
        objective: bundle.objective,
        roleConfig: roleConfig.roles.strategist,
        primaryPaths: [rootPlan.spec, ...bundle.primary_refs.slice(0, capsuleRefLimit)],
        additionalPaths: [
          `.smike/${project}/PROJECT.md`,
          rootPlanRel,
          `.smike/${project}/PLAN-GRAPH.json`,
          ...bundle.spec_paths.slice(0, capsuleRefLimit),
        ],
        readOrder: strategistGuidance.readOrder,
        questions: strategistGuidance.questions,
        boundaries: {
          allowed_files: rootPlan.write_scope.allowed_files,
          blocked_files: rootPlan.write_scope.blocked_files,
          reason: rootPlan.write_scope.reason,
        },
        outputs: {
          success_conditions: strategistGuidance.successConditions,
        },
        contextSnapshot: buildPlanningStrategistContextSnapshot(bundle),
        resultArtifacts: buildPlanningRoleResultArtifacts(project, 'strategist', rootPlan.plan_id),
        artifactChangeRequired: true,
        evidence: {
          deliverables: bundle.deliverables,
          constraints: bundle.constraints,
          integration_requirements: bundle.integration_requirements,
          planning_decisions: bundle.planning_decisions,
          risk_hotspots: bundle.risk_hotspots,
          first_phase_contract_items: bundle.first_phase_contract_items,
          protected_areas: bundle.protected_areas,
          drift_seeds: bundle.drift_seeds,
        },
        nextAction: strategistGuidance.nextAction,
      });
      const capsulePaths = writeRoleCapsule(paths, strategistCapsule);
      updateCapsuleRefs(orchestration, 'strategist', strategistCapsule.plan_id, capsulePaths);
      recordRoleHistory(orchestration, {
        cycle: 0,
        stage: 'planning',
        role: 'strategist',
        plan_id: strategistCapsule.plan_id,
        status: 'prepared',
        capsule_json: capsulePaths.jsonRel,
        generated_at: strategistCapsule.generated_at,
        summary: 'Strategist context prepared from spec, refs, constraints, and protected areas.',
      });
      orchestration.last_role = 'strategist';
    }

    for (const phase of bundle.phase_blueprints) {
      if (!roleConfig.roles.detailer.enabled) {
        break;
      }

      const detailerGuidance = buildPlanningRoleGuidance('detailer', { planId: phase.id });
      const detailerCapsule = buildRoleCapsule({
        project,
        planId: phase.id,
        cycle: 0,
        stage: 'planning',
        role: 'detailer',
        objective: phase.summary,
        roleConfig: roleConfig.roles.detailer,
        primaryPaths: [
          rootPlanRel,
          `.smike/${project}/PLAN-GRAPH.json`,
          `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`,
        ],
        additionalPaths: [...bundle.primary_refs.slice(0, capsuleRefLimit)],
        readOrder: detailerGuidance.readOrder,
        questions: detailerGuidance.questions,
        boundaries: {
          allowed_files: phase.allowed_files,
          blocked_files: phase.blocked_files,
          reason: `Bound ${phase.id} to a reviewable cleanup slice.`,
        },
        outputs: {
          success_conditions: detailerGuidance.successConditions,
        },
        contextSnapshot: buildPlanningDetailerContextSnapshot(bundle, phase),
        resultArtifacts: buildPlanningRoleResultArtifacts(project, 'detailer', phase.id),
        artifactChangeRequired: true,
        evidence: {
          depends_on: phase.depends_on,
          category: phase.category,
          primary_refs: bundle.primary_refs,
          write_scope: phase.write_scope_allowed_files,
        },
        nextAction: detailerGuidance.nextAction,
      });
      const capsulePaths = writeRoleCapsule(paths, detailerCapsule);
      updateCapsuleRefs(orchestration, 'detailer', detailerCapsule.plan_id, capsulePaths);
      recordRoleHistory(orchestration, {
        cycle: 0,
        stage: 'planning',
        role: 'detailer',
        plan_id: detailerCapsule.plan_id,
        status: 'prepared',
        capsule_json: capsulePaths.jsonRel,
        generated_at: detailerCapsule.generated_at,
        summary: `Detailer context prepared for Plan ${phase.id}.`,
      });
      orchestration.last_role = 'detailer';
    }

    if (roleConfig.roles.checker.enabled) {
      const checkerGuidance = buildPlanningRoleGuidance('checker');
      const checkerCapsule = buildRoleCapsule({
        project,
        planId: rootPlan.plan_id,
        cycle: 0,
        stage: 'planning',
        role: 'checker',
        objective: 'Verify cross-plan consistency before execution begins.',
        roleConfig: roleConfig.roles.checker,
        primaryPaths: [
          rootPlanRel,
          `.smike/${project}/PLAN-GRAPH.json`,
          ...bundle.phase_blueprints.map((phase) => `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`),
        ],
        additionalPaths: [...bundle.primary_refs.slice(0, capsuleRefLimit)],
        readOrder: checkerGuidance.readOrder,
        questions: checkerGuidance.questions,
        boundaries: {
          allowed_files: [`.smike/${project}/**`],
          blocked_files: rootPlan.blocked_files,
          reason: 'Checker reviews planning artifacts only.',
        },
        outputs: {
          success_conditions: checkerGuidance.successConditions,
        },
        evidence: {
          phase_graph: bundle.phase_blueprints.map((phase) => ({
            id: phase.id,
            depends_on: phase.depends_on,
            allowed_files: phase.allowed_files,
          })),
        },
        nextAction: checkerGuidance.nextAction,
      });
      const capsulePaths = writeRoleCapsule(paths, checkerCapsule);
      updateCapsuleRefs(orchestration, 'checker', checkerCapsule.plan_id, capsulePaths);
      recordRoleHistory(orchestration, {
        cycle: 0,
        stage: 'planning',
        role: 'checker',
        plan_id: checkerCapsule.plan_id,
        status: 'prepared',
        capsule_json: capsulePaths.jsonRel,
        generated_at: checkerCapsule.generated_at,
        summary: 'Checker context prepared for cross-plan dependency and overlap review.',
      });
      orchestration.last_role = 'checker';
    }

    if (roleConfig.roles.auditor.enabled) {
      const auditorGuidance = buildPlanningRoleGuidance('auditor');
      const auditorCapsule = buildRoleCapsule({
        project,
        planId: rootPlan.plan_id,
        cycle: 0,
        stage: 'planning',
        role: 'auditor',
        objective: 'Audit planning coverage against the spec and deliverables.',
        roleConfig: roleConfig.roles.auditor,
        primaryPaths: [
          rootPlan.spec,
          rootPlanRel,
          `.smike/${project}/PLAN-GRAPH.json`,
          ...bundle.phase_blueprints.map((phase) => `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`),
        ],
        additionalPaths: [...bundle.primary_refs.slice(0, capsuleRefLimit)],
        readOrder: auditorGuidance.readOrder,
        questions: auditorGuidance.questions,
        boundaries: {
          allowed_files: [`.smike/${project}/**`],
          blocked_files: rootPlan.blocked_files,
          reason: 'Auditor reviews planning artifacts and spec context only.',
        },
        outputs: {
          success_conditions: auditorGuidance.successConditions,
        },
        evidence: {
          deliverables: bundle.deliverables,
          protected_areas: bundle.protected_areas,
          phase_index: bundle.phase_blueprints.map((phase) => ({ id: phase.id, title: phase.title })),
        },
        nextAction: auditorGuidance.nextAction,
      });
      const capsulePaths = writeRoleCapsule(paths, auditorCapsule);
      updateCapsuleRefs(orchestration, 'auditor', auditorCapsule.plan_id, capsulePaths);
      recordRoleHistory(orchestration, {
        cycle: 0,
        stage: 'planning',
        role: 'auditor',
        plan_id: auditorCapsule.plan_id,
        status: 'prepared',
        capsule_json: capsulePaths.jsonRel,
        generated_at: auditorCapsule.generated_at,
        summary: 'Auditor context prepared for deliverable-to-plan coverage review.',
      });
      orchestration.last_role = 'auditor';
    }
  }

  return {
    writePlanningRoleCapsules,
  };
}
