export function createPlanningMarkdownRenderers({ buildPlanningContextFromBundle }) {
  function renderProjectMarkdown(project, specRel, contextFiles, bundle) {
    const lines = [
      `# ${project}`,
      '',
      bundle.objective,
      '',
      '## Snapshot',
      `- Project: ${project}`,
      `- Spec: ${specRel}`,
      `- Mode: ${bundle.mode}`,
      `- Resume: ./smike`,
    ];

    if (contextFiles.length > 0) {
      lines.push(`- Context: ${contextFiles.join(', ')}`);
    }

    if (bundle.intake_prompt) {
      lines.push('');
      lines.push('## Intake');
      lines.push(`- Prompt: ${bundle.intake_prompt}`);
      if (bundle.clarifying_questions.length === 0) {
        lines.push('- Clarifying questions: none captured');
      } else {
        bundle.clarifying_questions.forEach((question) => lines.push(`- ${question}`));
      }
    }

    lines.push('');
    lines.push('## Refs');
    if (bundle.primary_refs.length === 0) {
      lines.push('- none captured from spec');
    } else {
      bundle.primary_refs.forEach((ref) => lines.push(`- ${ref}`));
    }

    lines.push('');
    lines.push('## Deliverables');
    if (bundle.deliverables.length === 0) {
      lines.push('- produce a bounded implementation graph from the spec');
    } else {
      bundle.deliverables.forEach((deliverable) => lines.push(`- ${deliverable}`));
    }

    return `${lines.join('\n')}\n`;
  }

  function renderPlanningPlanMarkdown(specRel, contextFiles, bundle) {
    const planningContext = buildPlanningContextFromBundle(bundle);
    const lines = [
      '# PLAN',
      '',
      `Spec: ${specRel}`,
      `Mode: ${bundle.mode}`,
      `Objective: ${bundle.objective}`,
    ];

    if (contextFiles.length > 0) {
      lines.push(`Context: ${contextFiles.join(', ')}`);
    }

    lines.push('');
    lines.push('## Planning Rules');
    lines.push('- Produce concrete phase plans from the spec, not a placeholder bundle.');
    if (bundle.mode === 'research') {
      lines.push('- This is read-only research: write findings inside `.smike/<project>/` only and leave repo code untouched.');
    } else {
      lines.push('- Each implementation phase needs a bounded write scope and explicit verification.');
    }
    lines.push('- Planning writes stay inside `.smike/<project>/`.');
    lines.push('');
    lines.push('## Deliverables');
    if (bundle.deliverables.length === 0) {
      lines.push('- phase graph and execution plan');
    } else {
      bundle.deliverables.forEach((deliverable) => lines.push(`- ${deliverable}`));
    }
    lines.push('');
    lines.push('## Planning Context');
    lines.push('- Canonical planning semantics live in `PLAN.json > planning_context`.');
    lines.push(`- Truth sources: ${planningContext.truth_sources.join(', ') || 'none'}`);
    lines.push(`- Deferred items: ${planningContext.explicit_deferrals.join(', ') || 'none'}`);
    lines.push(`- Protected areas: ${planningContext.protected_areas.join(', ') || 'none'}`);
    lines.push('');
    lines.push('## Delegation');
    lines.push('- Strategist and detailer may run from runtime-owned capsules.');
    lines.push('- The runner owns state and contract writing.');
    if (bundle.planning_analysis.checker_enabled || bundle.planning_analysis.auditor_enabled) {
      lines.push('- Checker and auditor stay local and re-read the current on-disk plans before planning can pass.');
    } else {
      lines.push(`- Checker/auditor are skipped for this bundle: ${bundle.planning_analysis.reason}`);
    }
    lines.push('');
    lines.push('## Phase Guide');
    lines.push('- Keep each phase to one reviewable surface.');
    lines.push('- Prefer narrow scopes over speculative future work.');
    lines.push('');
    lines.push('## Phase Index');
    bundle.phase_blueprints.forEach((phase) => lines.push(`- ${phase.id}: ${phase.title}`));
    lines.push('');

    return `${lines.join('\n')}\n`;
  }

  return {
    renderPlanningPlanMarkdown,
    renderProjectMarkdown,
  };
}
