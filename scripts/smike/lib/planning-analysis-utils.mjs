const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'if',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

function normalizeText(value) {
  return String(value || '').toLowerCase();
}

export function tokenize(value) {
  return [...new Set(
    normalizeText(value)
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )];
}

export function normalizeGlob(glob) {
  return String(glob || '').replaceAll('\\', '/').trim();
}

function staticGlobPrefix(glob) {
  const normalized = normalizeGlob(glob);
  const wildcardIndex = normalized.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, '');
}

function escapeRegex(input) {
  return input.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(glob) {
  const normalized = normalizeGlob(glob);
  let regex = escapeRegex(normalized);
  regex = regex.replace(/\*\*/g, '___DOUBLE_STAR___');
  regex = regex.replace(/\*/g, '[^/]*');
  regex = regex.replace(/___DOUBLE_STAR___/g, '.*');
  regex = regex.replace(/\?/g, '[^/]');
  return new RegExp(`^${regex}$`);
}

export function globsLikelyOverlap(left, right) {
  const normalizedLeft = normalizeGlob(left);
  const normalizedRight = normalizeGlob(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftPrefix = staticGlobPrefix(normalizedLeft);
  const rightPrefix = staticGlobPrefix(normalizedRight);
  if (!leftPrefix || !rightPrefix) {
    return true;
  }

  if (leftPrefix === rightPrefix) {
    return true;
  }
  if (leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`)) {
    return true;
  }

  const leftRegex = globToRegex(normalizedLeft);
  const rightRegex = globToRegex(normalizedRight);
  const candidates = [
    leftPrefix,
    rightPrefix,
    `${leftPrefix}/__smike_overlap_probe__`,
    `${rightPrefix}/__smike_overlap_probe__`,
  ];

  return candidates.some((candidate) => leftRegex.test(candidate) && rightRegex.test(candidate));
}

function buildDependencyGraph(phasePlans) {
  const byId = new Map(phasePlans.map((plan) => [plan.plan_id, plan]));
  const outgoing = new Map(phasePlans.map((plan) => [plan.plan_id, []]));
  const incomingCount = new Map(phasePlans.map((plan) => [plan.plan_id, 0]));

  for (const plan of phasePlans) {
    for (const dependencyId of plan.depends_on) {
      if (!byId.has(dependencyId)) {
        continue;
      }
      outgoing.get(dependencyId).push(plan.plan_id);
      incomingCount.set(plan.plan_id, (incomingCount.get(plan.plan_id) || 0) + 1);
    }
  }

  return {
    outgoing,
    incomingCount,
  };
}

export function topologicalOrder(phasePlans) {
  const { outgoing, incomingCount } = buildDependencyGraph(phasePlans);
  const queue = phasePlans
    .filter((plan) => (incomingCount.get(plan.plan_id) || 0) === 0)
    .map((plan) => plan.plan_id);
  const order = [];

  while (queue.length > 0) {
    const current = queue.shift();
    order.push(current);
    for (const downstreamId of outgoing.get(current) || []) {
      const nextCount = (incomingCount.get(downstreamId) || 0) - 1;
      incomingCount.set(downstreamId, nextCount);
      if (nextCount === 0) {
        queue.push(downstreamId);
      }
    }
  }

  return order;
}

export function hasDependencyPath(phasePlans, fromPlanId, toPlanId) {
  const byId = new Map(phasePlans.map((plan) => [plan.plan_id, plan]));
  const visited = new Set();
  const stack = [fromPlanId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === toPlanId) {
      return true;
    }
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const currentPlan = byId.get(current);
    for (const dependencyId of currentPlan?.depends_on || []) {
      if (!visited.has(dependencyId)) {
        stack.push(dependencyId);
      }
    }
  }

  return false;
}

export function countBlockingFindings(findings) {
  return findings.filter((finding) => finding.severity !== 'low').length;
}

function buildPhaseSearchText(plan) {
  return [
    plan.phase,
    plan.objective,
    plan.scope,
    ...plan.allowed_files,
    ...plan.write_scope_allowed_files,
    ...(plan.delegation?.result_artifacts || []),
  ].join(' ');
}

export function scoreDeliverableAgainstPlan(deliverable, plan) {
  const normalizedDeliverable = normalizeGlob(deliverable);
  const planText = buildPhaseSearchText(plan);
  const deliverableTokens = tokenize(deliverable);
  const phaseTokens = tokenize(planText);
  const overlap = deliverableTokens.filter((token) => phaseTokens.includes(token));
  const fileMatch = normalizedDeliverable.includes('/')
    && plan.write_scope_allowed_files.some((glob) => globsLikelyOverlap(normalizedDeliverable, glob));

  return {
    overlap,
    fileMatch,
    score: (fileMatch ? 3 : 0) + overlap.length,
  };
}
