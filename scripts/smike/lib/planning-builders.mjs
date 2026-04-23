export function createPlanningBuilders({
  rootPlanSchemaRef,
  phasePlanSchemaRef,
  rootStateSchemaRef,
  defaultFreshSessionGate,
  defaultMaxPhasesPerRun,
  stateGotchaLimit,
  planningDraftLifecycleStatus,
  thinExecutorFirstImplementationProfile,
  researchFindingsRuntimeProfile,
  repoRoot,
  portabilityHeuristics,
  readTemplateJson,
  normalizePathList,
  normalizeStringArray,
  buildPlanningContextFromBundle,
  buildPlanningBundleCheckCommand,
  buildPlanningReportCheckCommand,
  buildPhaseVerifyCommands,
  buildAcceptanceCriteria,
  getResearchResultPaths,
  buildCycleCommand,
  hashPlanContract,
  hashPlanningContext,
  trimStateGotchas,
  nowIso,
}) {
  function resolvePlanningAnalysisForMode(bundle, planningMode = 'active') {
    const planningAnalysis = bundle.planning_analysis || { checker_enabled: true, auditor_enabled: true };
    if (planningMode === 'draft') {
      return {
        ...planningAnalysis,
        checker_enabled: false,
        auditor_enabled: false,
        reason: 'Draft bootstrap skips checker/auditor until promotion.',
      };
    }
    return planningAnalysis;
  }

  function buildPlanningRootPlan(project, specRel, contextFiles, bundle, planningMode = 'active') {
    const plan = readTemplateJson('PLAN.json');
    plan.$schema = rootPlanSchemaRef;
    const phaseIds = bundle.phase_blueprints.map((phase) => phase.id);
    const planningAnalysis = resolvePlanningAnalysisForMode(bundle, planningMode);
    const planningContext = buildPlanningContextFromBundle(bundle);
    plan.plan_id = `${project}-plan`;
    plan.phase = 'Planning';
    plan.spec = specRel;
    plan.objective = `Generate a real SMIKE planning bundle for ${specRel}.`;
    plan.scope = `Planning only. Produce strategy, roadmap, and implementation phase contracts for ${project} without changing repo code.`;
    plan.allowed_files = normalizePathList([
      `.smike/${project}/**`,
      specRel,
      ...bundle.primary_refs,
      ...contextFiles,
    ]);
    plan.blocked_files = ['.env*', '**/*.pem', '**/*.key'];
    plan.write_scope.allowed_files = [`.smike/${project}/**`];
    plan.write_scope.blocked_files = [...plan.blocked_files];
    plan.write_scope.reason = 'Planning writes are limited to generated SMIKE artifacts.';
    plan.preflight.require_clean_worktree = false;
    plan.verify_commands = [{
      id: 'planning-bundle',
      run: buildPlanningBundleCheckCommand(project, phaseIds, planningAnalysis),
      cwd: '../..',
      timeout_ms: 30000,
      expect: {
        exit_code: 0,
        stdout_includes: ['planning-bundle-ready'],
      },
    }];
    if (planningAnalysis.checker_enabled) {
      plan.verify_commands.push({
        id: 'planning-checker',
        run: buildPlanningReportCheckCommand(project, 'CHECKER'),
        cwd: '../..',
        timeout_ms: 30000,
        expect: {
          exit_code: 0,
          stdout_includes: ['checker-ready'],
        },
      });
    }
    if (planningAnalysis.auditor_enabled) {
      plan.verify_commands.push({
        id: 'planning-auditor',
        run: buildPlanningReportCheckCommand(project, 'AUDITOR'),
        cwd: '../..',
        timeout_ms: 30000,
        expect: {
          exit_code: 0,
          stdout_includes: ['auditor-ready'],
        },
      });
    }
    plan.acceptance_criteria = buildAcceptanceCriteria(plan.verify_commands, 'Planning bundle verified');
    plan.postflight = {
      commands: [],
    };
    plan.planning_context = planningContext;
    plan.workflow = {
      auto_continue: true,
      fresh_session_gate: defaultFreshSessionGate,
      stop_on_failure: true,
      max_phases_per_run: defaultMaxPhasesPerRun,
      phase_plans: phaseIds.map((phaseId) => `phases/${phaseId}/${phaseId}-PLAN.json`),
    };
    plan.delegation = {
      mode: 'runtime_subagents',
      owner: 'runtime_orchestrator',
      runtime_roles: ['strategist', 'detailer'],
      result_artifacts: [
        `.smike/${project}/PLAN.json`,
        `.smike/${project}/PLAN-GRAPH.json`,
        ...phaseIds.map((phaseId) => `.smike/${project}/phases/${phaseId}/${phaseId}-PLAN.json`),
      ],
    };
    plan.orchestration = {
      stage: 'planning',
      discovery_propagation: true,
      roles: {
        strategist: { enabled: true },
        detailer: { enabled: true },
        checker: { enabled: false },
        auditor: { enabled: false },
        executor: { enabled: true },
        judge: { enabled: true },
        reviewer: { enabled: true },
      },
    };
    return plan;
  }

  function buildPhasePlan(project, specRel, bundle, phase) {
    const commands = buildPhaseVerifyCommands(project, phase, bundle.primary_refs, bundle.mode);
    const isResearch = bundle.mode === 'research';
    const researchResults = isResearch ? getResearchResultPaths(project, phase.id) : null;
    const reviewerRequired = isResearch ? phase.research_reviewer_required !== false : true;
    const phaseRefreshMode = isResearch
      ? 'lightweight'
      : (phase.depends_on.length > 0 ? 'auto_detailer_on_drift' : 'lightweight');
    const executionPolicy = isResearch
      ? {
        profile: researchFindingsRuntimeProfile,
        runtime: {
          promotion: 'declared_runtime_roles',
          roles: ['executor', 'judge', ...(reviewerRequired ? ['reviewer'] : [])],
          follow_on_roles: 'allow_declared_runtime_roles',
        },
        quality: {
          judge_rerun_verify: true,
          review_focus_areas: ['evidence_quality', 'findings_specificity'],
          review_anti_patterns: [],
        },
      }
      : {
        profile: thinExecutorFirstImplementationProfile,
        runtime: {
          promotion: 'complexity_gated_executor_only',
          roles: ['executor'],
          follow_on_roles: 'local_only',
        },
        quality: {
          judge_rerun_verify: true,
          review_focus_areas: ['scope_control', 'verification_contract'],
          review_anti_patterns: [],
        },
      };
    const executionProfile = isResearch
      ? {
        feature_flags: {
          phase_refresh_mode: phaseRefreshMode,
          implementation_profile: researchFindingsRuntimeProfile,
          implementation_runtime_promotion: 'declared_runtime_roles',
          implementation_runtime_follow_on_roles: 'allow_declared_runtime_roles',
        },
        delegation: {
          mode: 'runtime_subagents',
          owner: 'runtime_orchestrator',
          result_artifacts: researchResults ? [researchResults.jsonRel] : [],
        },
        orchestration: {
          stage: 'execution',
          discovery_propagation: true,
          roles: {
            executor: { enabled: true },
            judge: { enabled: true },
            reviewer: { enabled: reviewerRequired },
            fixer: { enabled: true },
          },
        },
      }
      : {
        feature_flags: {
          phase_refresh_mode: phaseRefreshMode,
          implementation_profile: thinExecutorFirstImplementationProfile,
          implementation_runtime_promotion: 'complexity_gated_executor_only',
          implementation_runtime_follow_on_roles: 'local_only',
        },
        delegation: {
          mode: 'auto',
          owner: 'smike_runner',
          result_artifacts: [],
        },
        orchestration: {
          stage: 'execution',
          discovery_propagation: true,
          roles: {
            executor: { enabled: true },
            judge: { enabled: true },
            reviewer: { enabled: reviewerRequired },
            fixer: { enabled: true },
          },
        },
      };
    return {
      $schema: phasePlanSchemaRef,
      schema_version: '2.1.0',
      profile: 'codex',
      plan_id: phase.id,
      phase: `Plan ${phase.id}`,
      spec: specRel,
      objective: isResearch
        ? `Investigate ${phase.title.toLowerCase()} and record findings for the follow-on implementation loop.`
        : phase.title,
      scope: isResearch
        ? `Read-only research only. ${phase.summary} Record evidence and findings in .smike/${project}/ without changing repo code.`
        : phase.summary,
      depends_on: phase.depends_on,
      allowed_files: phase.allowed_files,
      blocked_files: phase.blocked_files,
      write_scope: {
        mode: 'strict',
        allowed_files: phase.write_scope_allowed_files,
        blocked_files: phase.write_scope_blocked_files,
        reason: phase.write_scope_reason,
      },
      preflight: {
        require_clean_worktree: false,
        required_tools: portabilityHeuristics.inferDefaultRequiredTools({
          repoRoot,
          plan: phase,
        }),
        required_env_vars: [],
      },
      verify_commands: commands,
      acceptance_criteria: buildAcceptanceCriteria(commands, `${phase.id} verification`),
      postflight: {
        commands: [],
      },
      workflow: {
        auto_continue: true,
        fresh_session_gate: 'never',
        stop_on_failure: true,
        max_phases_per_run: 1,
        phase_plans: [],
      },
      execution_policy: executionPolicy,
      delegation: executionProfile.delegation,
      orchestration: executionProfile.orchestration,
      feature_flags: executionProfile.feature_flags,
    };
  }

  function buildPlanningState(project, specRel, contextFiles, plan, bundle, planningMode = 'active', inputSnapshot = null) {
    const state = readTemplateJson('STATE.json');
    state.$schema = rootStateSchemaRef;
    const rootPlanHash = hashPlanContract(plan);
    const planningContextHash = hashPlanningContext(plan.planning_context);
    state.project = project;
    state.created_at = nowIso();
    state.updated_at = nowIso();
    state.current_plan = {
      plan_id: plan.plan_id,
      plan_json: `.smike/${project}/PLAN.json`,
      plan_md: `.smike/${project}/PLAN.md`,
      depends_on: [],
      contract_hash: rootPlanHash,
    };
    state.lifecycle = {
      status: planningMode === 'draft' ? planningDraftLifecycleStatus : 'planning',
      cycle_count: 0,
      last_started_at: null,
      last_completed_at: null,
      last_result: null,
      next_action: planningMode === 'draft'
        ? `Planning draft created for ${project}. Refine it with \`${buildCycleCommand(project)}\`.`
        : `Execute the planning phase for ${project}.`,
      next_command: buildCycleCommand(project),
    };
    state.workflow = {
      auto_continue: true,
      fresh_session_gate: defaultFreshSessionGate,
      stop_on_failure: true,
      max_phases_per_run: defaultMaxPhasesPerRun,
      plans: [],
    };
    state.history = [];
    state.gotchas = trimStateGotchas(bundle.drift_seeds, stateGotchaLimit, { keepLatest: false });
    state.propagated_discoveries = [];
    state.orchestration = {
      stage: 'planning',
      active_role: null,
      last_role: null,
      next_role: 'strategist',
      discovery_propagation: true,
      role_history: [],
      capsules: {
        latest_by_role: {},
        by_plan: {},
      },
    };
    state.planning = {
      status: planningMode === 'draft' ? 'draft' : 'in_progress',
      mode: bundle.mode,
      spec_path: specRel,
      spec_hash: bundle.spec_hash,
      intake_prompt: bundle.intake_prompt || null,
      clarifying_questions: bundle.clarifying_questions,
      context_files: contextFiles,
      input_snapshot: inputSnapshot,
      primary_refs: bundle.primary_refs,
      deliverables: bundle.deliverables,
      planning_context_hash: planningContextHash,
      draft_correction: null,
      initial_plan_hash: rootPlanHash,
      last_plan_hash: rootPlanHash,
      completed_at: null,
    };
    return state;
  }

  function buildPlanningPhaseContracts(project, specRel, bundle) {
    return bundle.phase_blueprints.map((phase) => {
      const phasePlan = buildPhasePlan(project, specRel, bundle, phase);
      return {
        phase,
        phasePlan,
        analysisPlan: {
          ...phasePlan,
          dependency_mode: phase.dependency_mode || 'implicit',
          declared_write_scope: normalizePathList(phase.declared_write_scope || []),
          declared_verify_commands: normalizeStringArray(phase.declared_verify_commands || []),
          write_scope_allowed_files: normalizePathList(phase.write_scope_allowed_files || []),
        },
      };
    });
  }

  return {
    resolvePlanningAnalysisForMode,
    buildPlanningRootPlan,
    buildPhasePlan,
    buildPlanningState,
    buildPlanningPhaseContracts,
  };
}
