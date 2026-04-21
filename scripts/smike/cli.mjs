#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDispatchHelpers } from './lib/dispatch.mjs';
import { createBuildPlanningAuditorRecord } from './lib/auditor.mjs';
import { createBuildPlanningCheckerRecord } from './lib/checker.mjs';
import {
  buildPlanningDraftPromotionCheck,
  planningAnalysisIsExecutionReady,
} from './lib/planning-readiness.mjs';
import { createBuildReviewRecord } from './lib/review.mjs';
import {
  collectCompletionRequirementFailures,
  normalizeDispatchCompletionRequirements,
  verifiedArtifactPathsFromCompletionArtifacts,
} from './lib/runtime-artifact-surface.mjs';
import { createValidationHelpers } from './lib/validation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = process.env.SMIKE_PROJECT_ROOT
  ? path.resolve(process.env.SMIKE_PROJECT_ROOT)
  : process.cwd();
const SMIKE_ROOT = path.join(REPO_ROOT, '.smike');
const SMIKE_ARCHIVE_ROOT = path.join(REPO_ROOT, '.smike-archive');
const ACTIVE_PROJECT_PATH = path.join(SMIKE_ROOT, 'ACTIVE.json');
const PLAN_SCHEMA_PATH = path.join(__dirname, 'schemas', 'plan.schema.json');
const STATE_SCHEMA_PATH = path.join(__dirname, 'schemas', 'state.schema.json');
const ROOT_PLAN_SCHEMA_REF = process.env.SMIKE_PLAN_SCHEMA_REF || '../../scripts/smike/schemas/plan.schema.json';
const PHASE_PLAN_SCHEMA_REF =
  process.env.SMIKE_PHASE_PLAN_SCHEMA_REF || '../../../../scripts/smike/schemas/plan.schema.json';
const ROOT_STATE_SCHEMA_REF = process.env.SMIKE_STATE_SCHEMA_REF || '../../scripts/smike/schemas/state.schema.json';
const LEGACY_PLACEHOLDER_PLAN_ID = 'replace-with-plan-id';
const DEFAULT_MAX_PHASES_PER_RUN = 10;
const CAPSULE_REF_LIMIT = 6;
const ADDITIONAL_CONTEXT_LIMIT = 8;
const STATE_GOTCHA_LIMIT = 50;
const OPERATOR_NOTES_START = '<!-- SMIKE:OPERATOR-NOTES:START -->';
const OPERATOR_NOTES_END = '<!-- SMIKE:OPERATOR-NOTES:END -->';
const DEFAULT_OPERATOR_NOTES_PROMPT =
  '- Add manual follow-ups here when SMIKE surfaces something subtle that the automatic pass missed.';
const SMIKE_PARENT_TEST_RUNNER_ENV = 'SMIKE_PARENT_TEST_RUNNER';
const SMIKE_ALLOW_NESTED_TEST_RUNS_ENV = 'SMIKE_ALLOW_NESTED_TEST_RUNS';
const SMIKE_ALLOW_TEST_ACTIVE_PROJECT_ENV = 'SMIKE_ALLOW_TEST_ACTIVE_PROJECT';
const SMIKE_NESTED_TEST_SKIP_STDOUT = 'smike-nested-test-run-skipped';
const FRESH_SESSION_FOR_IMPLEMENTATION_PAUSE_REASON = 'fresh-session-for-implementation';
const AWAITING_FRESH_SESSION_LIFECYCLE_STATUS = 'awaiting_fresh_session';
const PLANNING_DRAFT_LIFECYCLE_STATUS = 'planning_draft';
const TEST_RUNNER_ENV_HINTS = [
  'VITEST',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'JEST_WORKER_ID',
  'AVA_PATH',
  'NODE_TEST_CONTEXT',
  'TAP',
];
const DEFAULT_SMIKE_FEEDBACK_PATH =
  REPO_ROOT === FRAMEWORK_ROOT
    ? path.join(REPO_ROOT, 'docs', 'smike-feedback.md')
    : path.join(REPO_ROOT, 'memories', 'smike-feedback.md');
const SMIKE_FEEDBACK_PATH = process.env.SMIKE_FEEDBACK_PATH
  ? path.resolve(process.env.SMIKE_FEEDBACK_PATH)
  : DEFAULT_SMIKE_FEEDBACK_PATH;
const SMIKE_FEEDBACK_SYNC_MODE = (() => {
  const raw = typeof process.env.SMIKE_FEEDBACK_SYNC_MODE === 'string'
    ? process.env.SMIKE_FEEDBACK_SYNC_MODE.trim().toLowerCase()
    : '';
  return raw === 'planning_complete' ? 'planning_complete' : 'full';
})();
const KNOWN_PHASE_REFRESH_MODES = new Set(['lightweight', 'auto_detailer_on_drift', 'always_detailer']);
const DEFAULT_FEEDBACK_NOTES_PROMPT =
  '- Add durable workflow follow-ups here when a SMIKE run reveals something worth keeping in repo memory.';
const RESERVED_COMMANDS = new Set(['advance', 'cycle', 'recheck', 'doctor', 'validate', 'generate', 'activate', 'resume', 'status', 'list', 'dispatch', 'archive', 'restore', 'gc', 'intake']);
const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SHELL_OUTPUT_LIMIT = 16 * 1024 * 1024;
const MANAGED_CHILD_REAP_GRACE_MS = 500;
const MANAGED_CHILDREN = new Map();
let managedChildCleanupHooksInstalled = false;
const DEFAULT_REVIEW_ANTI_PATTERNS = [
  'Do not treat executor output as proof; rerun verification in JUDGE.',
  'Do not mark a plan complete on exit codes alone when ACs need behavioral evidence.',
  'Do not hide pre-existing failures or unrelated red tests without stating the baseline.',
  'Do not ignore export or interface drift that lacks explicit verification coverage.',
  'Do not treat broad write scope as harmless; call out blast radius when it appears.',
  'Do not rubber-stamp a pass when acceptance coverage is weaker than the stated objective.',
];
const ROLE_DEFINITIONS = {
  strategist: {
    stage: 'planning',
    enabled_by_default: true,
    fresh_context: true,
    independent: false,
    focus_areas: [
      'Extract objective, constraints, truth sources, and collision zones from the spec.',
      'Produce a bounded phase graph with sane sequencing and parallelism.',
    ],
    anti_patterns: [
      'Do not jump into implementation before decomposing the spec.',
      'Do not ignore required references or repo invariants named by the spec.',
      'Do not create broad write scopes when the work can be sliced more narrowly.',
    ],
    expected_outputs: ['STRATEGY.md', 'ROADMAP.md', 'PLAN.json', 'phase plans'],
  },
  detailer: {
    stage: 'planning',
    enabled_by_default: true,
    fresh_context: true,
    independent: false,
    focus_areas: [
      'Turn each phase into a reviewable plan with explicit files, actions, verification, and boundaries.',
      'Carry forward gotchas and sibling interfaces without dumping unnecessary context.',
    ],
    anti_patterns: [
      'Do not over-decompose into a long tail of tiny tasks.',
      'Do not omit verification or leave acceptance criteria vague.',
      'Do not assume sibling interfaces without naming the dependency explicitly.',
    ],
    expected_outputs: ['phase PLAN.json'],
  },
  checker: {
    stage: 'planning',
    enabled_by_default: true,
    fresh_context: true,
    independent: true,
    focus_areas: [
      'Catch dependency gaps, interface mismatches, overlapping scope, and blast-radius issues across plans.',
      'Propagate concrete discoveries downstream instead of restating obvious scope text.',
    ],
    anti_patterns: [
      'Do not restate the spec without adding cross-plan signal.',
      'Do not escalate speculative conflicts that lack evidence from the actual plan graph.',
      'Do not request code changes when the issue is only documentation or planning phrasing.',
    ],
    expected_outputs: ['cross-plan discovery notes', 'routing corrections'],
  },
  auditor: {
    stage: 'planning',
    enabled_by_default: true,
    fresh_context: true,
    independent: true,
    focus_areas: [
      'Trace deliverables and promised behaviors back to concrete plan coverage.',
      'Distinguish true scope gaps from vague prose and low-confidence speculation.',
    ],
    anti_patterns: [
      'Do not treat keyword overlap as proof of coverage.',
      'Do not invent dependencies or workstreams not supported by the spec.',
      'Do not confuse ambiguous prose with a mandatory hard requirement.',
    ],
    expected_outputs: ['coverage notes', 'scope-gap guidance'],
  },
  executor: {
    stage: 'execution',
    enabled_by_default: true,
    fresh_context: true,
    independent: false,
    focus_areas: [
      'Implement the plan within write scope and leave a tight execution report.',
      'Keep edits bounded to the smallest file set that satisfies acceptance.',
    ],
    anti_patterns: [
      'Do not widen scope because adjacent code looks tempting.',
      'Do not hide partial work or verification shortcuts in the execution summary.',
      'Do not rely on files outside the declared write scope without surfacing the need.',
    ],
    expected_outputs: ['EXEC-REPORT.md', 'code changes inside write scope'],
  },
  judge: {
    stage: 'execution',
    enabled_by_default: true,
    fresh_context: true,
    independent: true,
    focus_areas: [
      'Rerun verification independently and trace acceptance criteria back to evidence.',
      'Check boundaries, scope drift, and whether baseline issues were called out honestly.',
    ],
    anti_patterns: DEFAULT_REVIEW_ANTI_PATTERNS,
    expected_outputs: ['VERDICT.md'],
  },
  reviewer: {
    stage: 'execution',
    enabled_by_default: true,
    fresh_context: true,
    independent: true,
    focus_areas: [
      'Review correctness, invariants, and drift not already proven by JUDGE.',
      'Surface weak evidence, contract gaps, and risky blast radius patterns.',
    ],
    anti_patterns: DEFAULT_REVIEW_ANTI_PATTERNS,
    expected_outputs: ['REVIEW.md'],
  },
  fixer: {
    stage: 'execution',
    enabled_by_default: true,
    fresh_context: true,
    independent: false,
    focus_areas: [
      'Resolve only the concrete failures or review concerns that were raised.',
      'Preserve already-passing behavior and keep the repair narrow.',
    ],
    anti_patterns: [
      'Do not refactor untouched code just because it is nearby.',
      'Do not “fix” speculative issues that are not in the failure capsule.',
      'Do not expand file scope without proving the reported issue cannot be solved locally.',
    ],
    expected_outputs: ['FIX capsule or targeted repair work'],
  },
};
const KNOWN_ROLES = Object.keys(ROLE_DEFINITIONS);
const KNOWN_DELEGATION_MODES = new Set(['local_only', 'runtime_subagents', 'auto']);
const KNOWN_DELEGATION_OWNERS = new Set(['smike_runner', 'runtime_orchestrator']);
const KNOWN_RUNTIME_DISPATCH_STATUSES = new Set(['queued', 'spawned', 'completed', 'stale', 'failed']);
const KNOWN_RUNTIME_DISPATCH_FRESHNESS = new Set(['pending', 'fresh', 'stale', 'missing', 'unchanged']);
const MAX_RUNTIME_DISPATCH_HISTORY = 200;
const MAX_ARTIFACT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const REPO_WALK_EXCLUDED_DIRS = new Set([
  '.claude',
  '.git',
  '.next',
  '.smike',
  '.venv',
  '.wrangler',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);

function usage() {
  console.log(`Usage:
  smike
  smike <spec.md|spec-slug> [context.md ...]
  smike "<freeform prompt...>" [--context=path1,path2] [--spec=memories/name.md]
  smike <project>
  smike advance [project]
  smike cycle <project> [--no-auto-continue] [--max-phases=<n>]
  smike recheck <project>
  smike doctor [project]
  smike dispatch <project> <spawned|completed|failed|retry> <dispatch-id> [--reason=<text>]
  smike dispatch <project> complete-group <current|group-number>
  smike archive <project> [--mode=compact|full] [--force]
  smike restore <project>
  smike gc
  smike validate <project>
  smike generate <project>
  smike activate <project>
  smike resume [project]
  smike status [project]
  smike list

Project directory must be: .smike/<project>
Canonical machine contract: .smike/<project>/PLAN.json
Canonical lifecycle state: .smike/<project>/STATE.json`);
}

function fail(message, code = 1) {
  console.error(`smike: ${message}`);
  process.exit(code);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRel(p) {
  return p.replaceAll('\\\\', '/').replace(/^\.\//, '').trim();
}

function compactCapsuleValue(value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const compacted = value
      .map((entry) => compactCapsuleValue(entry))
      .filter((entry) => entry !== undefined);
    return compacted.length > 0 ? compacted : undefined;
  }
  if (typeof value === 'object') {
    const compacted = Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, compactCapsuleValue(entry)])
        .filter(([, entry]) => entry !== undefined),
    );
    return Object.keys(compacted).length > 0 ? compacted : undefined;
  }
  return value;
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function looksLikeTestRunnerCommand(command) {
  return /\b(vitest|jest|mocha|ava|tap)\b/i.test(String(command || ''));
}

function readProcessMetadata(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') {
    return null;
  }

  const result = spawnSync('ps', ['-o', 'ppid=', '-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }

  const line = String(result.stdout || '')
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!line) {
    return null;
  }

  const match = line.match(/^(\d+)\s+(.*)$/);
  if (!match) {
    return null;
  }

  return {
    ppid: Number.parseInt(match[1], 10),
    command: match[2],
  };
}

function looksLikeSmikeProcessCommand(command) {
  return /(?:^|[\s/])smike(?:[\s]|$)|scripts[\\/]+smike[\\/]+cli\.mjs/i.test(String(command || ''));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function readLockMtimeMs(lockPath) {
  try {
    return fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

function inspectProjectLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return {
      stale: false,
      reason: null,
      record: null,
    };
  }

  const lockInfoPath = path.join(lockPath, 'lock.json');
  const lockAgeMs = (() => {
    const mtimeMs = readLockMtimeMs(lockPath);
    return typeof mtimeMs === 'number' ? Math.max(0, Date.now() - mtimeMs) : null;
  })();

  if (!fs.existsSync(lockInfoPath)) {
    return {
      stale: lockAgeMs === null || lockAgeMs >= 5_000,
      reason: 'lock directory is missing lock.json',
      record: null,
    };
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(lockInfoPath, 'utf8'));
  } catch {
    return {
      stale: lockAgeMs === null || lockAgeMs >= 5_000,
      reason: 'lock.json is unreadable',
      record: null,
    };
  }

  const pid = Number.parseInt(String(record?.pid ?? ''), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      stale: lockAgeMs === null || lockAgeMs >= 5_000,
      reason: 'lock.json is missing a valid pid',
      record,
    };
  }

  if (!processExists(pid)) {
    return {
      stale: true,
      reason: `pid ${pid} is not running`,
      record,
    };
  }

  const metadata = readProcessMetadata(pid);
  if (metadata && !looksLikeSmikeProcessCommand(metadata.command)) {
    return {
      stale: true,
      reason: `pid ${pid} does not look like an active SMIKE process`,
      record,
    };
  }

  return {
    stale: false,
    reason: null,
    record,
  };
}

function clearProjectLock(lockPath) {
  fs.rmSync(lockPath, { recursive: true, force: true });
}

function pruneStaleProjectLocks() {
  if (!fs.existsSync(SMIKE_ROOT)) {
    return;
  }

  for (const entry of fs.readdirSync(SMIKE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const lockPath = path.join(SMIKE_ROOT, entry.name, '.lock');
    const inspection = inspectProjectLock(lockPath);
    if (inspection.stale) {
      clearProjectLock(lockPath);
    }
  }
}

function parentProcessLooksLikeTestRunner(maxDepth = 2) {
  let pid = process.ppid;
  let depth = 0;

  while (Number.isInteger(pid) && pid > 0 && depth < maxDepth) {
    const metadata = readProcessMetadata(pid);
    if (!metadata) {
      return false;
    }
    if (looksLikeTestRunnerCommand(metadata.command)) {
      return true;
    }
    pid = metadata.ppid;
    depth += 1;
  }

  return false;
}

function isParentTestRunnerContext(env = process.env) {
  if (env[SMIKE_PARENT_TEST_RUNNER_ENV] === '1') {
    return true;
  }

  if (env[SMIKE_ALLOW_NESTED_TEST_RUNS_ENV] === '1') {
    return false;
  }

  if (TEST_RUNNER_ENV_HINTS.some((name) => typeof env[name] === 'string' && env[name].trim().length > 0)) {
    return true;
  }

  const lifecycle = `${env.npm_lifecycle_event || ''} ${env.npm_lifecycle_script || ''}`;
  return /\b(vitest|jest|mocha|ava|tap)\b/i.test(lifecycle) || parentProcessLooksLikeTestRunner();
}

function buildManagedCommandEnv(baseEnv = process.env) {
  const managedEnv = {
    ...baseEnv,
  };
  delete managedEnv[SMIKE_ALLOW_TEST_ACTIVE_PROJECT_ENV];

  if (
    managedEnv[SMIKE_ALLOW_NESTED_TEST_RUNS_ENV] === '1'
    || managedEnv[SMIKE_PARENT_TEST_RUNNER_ENV] === '1'
    || !isParentTestRunnerContext(managedEnv)
  ) {
    return managedEnv;
  }

  return {
    ...managedEnv,
    [SMIKE_PARENT_TEST_RUNNER_ENV]: '1',
  };
}

function isTestLikeCommand(command) {
  const normalized = String(command || '').trim();
  if (!normalized) {
    return false;
  }

  return (
    /\b(vitest|jest|mocha|ava|tap)\b/i.test(normalized)
    || /\b(?:npm|pnpm|yarn|bun)\b[^\n]*\btest(?:[:\w-]+)?\b/i.test(normalized)
  );
}

function guardNestedTestCommand(command, options = {}) {
  const stdoutToken = typeof options.stdoutToken === 'string' && options.stdoutToken.trim().length > 0
    ? options.stdoutToken.trim()
    : SMIKE_NESTED_TEST_SKIP_STDOUT;

  return `if [ "\${${SMIKE_ALLOW_NESTED_TEST_RUNS_ENV}:-}" = "1" ] || [ "\${${SMIKE_PARENT_TEST_RUNNER_ENV}:-0}" != "1" ]; then ( ${command} ); else printf '%s\\n' ${shellEscape(stdoutToken)}; fi`;
}

function guardTestVerifyCommand(command, options = {}) {
  return isTestLikeCommand(command) ? guardNestedTestCommand(command, options) : command;
}

function inferNestedTestGuardStdoutToken(expectation = {}) {
  const stdoutIncludes = Array.isArray(expectation?.stdout_includes)
    ? expectation.stdout_includes
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean)
    : [];
  return stdoutIncludes.length === 1 ? stdoutIncludes[0] : null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`invalid JSON at ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function acquireProjectLock(project, commandName) {
  const paths = getProjectPaths(project);
  ensureDir(paths.projectDir);
  const lockPath = path.join(paths.projectDir, '.lock');
  const lockRel = normalizeRel(path.relative(REPO_ROOT, lockPath));
  let acquired = false;

  try {
    fs.mkdirSync(lockPath);
    acquired = true;
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const inspection = inspectProjectLock(lockPath);
      if (!inspection.stale) {
        fail(`project ${project} is locked by another SMIKE command: ${lockRel}`);
      }

      try {
        clearProjectLock(lockPath);
        fs.mkdirSync(lockPath);
        acquired = true;
      } catch (retryError) {
        if (retryError && retryError.code === 'EEXIST') {
          fail(`project ${project} is locked by another SMIKE command: ${lockRel}`);
        }
        fail(`failed to clear stale project lock for ${project}: ${retryError.message}`);
      }
    } else {
      fail(`failed to acquire project lock for ${project}: ${error.message}`);
    }
  }

  if (!acquired) {
    fail(`failed to acquire project lock for ${project}: unknown lock acquisition state`);
  }

  fs.writeFileSync(
    path.join(lockPath, 'lock.json'),
    `${JSON.stringify({
      project,
      command: commandName || 'unknown',
      pid: process.pid,
      acquired_at: nowIso(),
    }, null, 2)}\n`,
    'utf8',
  );

  let released = false;
  const cleanup = () => {
    if (released) {
      return;
    }
    released = true;
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  };
  const exitHandler = () => cleanup();
  const sigintHandler = () => {
    cleanupManagedChildrenSync('SIGINT');
    cleanup();
    process.exit(130);
  };
  const sigtermHandler = () => {
    cleanupManagedChildrenSync('SIGTERM');
    cleanup();
    process.exit(143);
  };

  process.once('exit', exitHandler);
  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  return () => {
    cleanup();
    process.removeListener('exit', exitHandler);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigtermHandler);
  };
}

function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function appendShellOutput(current, chunk, limit = DEFAULT_SHELL_OUTPUT_LIMIT) {
  const text = typeof chunk === 'string' ? chunk : chunk ? chunk.toString('utf8') : '';
  if (!text || current.length >= limit) {
    return current;
  }
  const next = current + text;
  return next.length > limit ? next.slice(0, limit) : next;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runQuietProcessSync(command, args) {
  try {
    return spawnSync(command, args, {
      stdio: 'ignore',
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}

function signalProcessGroup(pid, signal) {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return false;
  }
}

function sweepDirectChildrenSync(parentPid, signal = 'TERM') {
  if (process.platform === 'win32' || !Number.isInteger(parentPid) || parentPid <= 0) {
    return;
  }
  runQuietProcessSync('pkill', [`-${signal}`, '-P', String(parentPid)]);
}

function processGroupHasMembersSync(groupPid) {
  if (process.platform === 'win32' || !Number.isInteger(groupPid) || groupPid <= 0) {
    return false;
  }
  const result = runQuietProcessSync('pgrep', ['-g', String(groupPid)]);
  return Boolean(result && result.status === 0);
}

function processHasDirectChildrenSync(parentPid) {
  if (process.platform === 'win32' || !Number.isInteger(parentPid) || parentPid <= 0) {
    return false;
  }
  const result = runQuietProcessSync('pgrep', ['-P', String(parentPid)]);
  return Boolean(result && result.status === 0);
}

async function reapManagedChild(info, options = {}) {
  const graceMs = typeof options.graceMs === 'number' ? options.graceMs : MANAGED_CHILD_REAP_GRACE_MS;
  if (!info || info.reaped || !Number.isInteger(info.pid) || info.pid <= 0) {
    return;
  }

  const hasSurvivors =
    options.force === true
    || processGroupHasMembersSync(info.pid)
    || processHasDirectChildrenSync(info.pid);
  if (!hasSurvivors) {
    return;
  }

  info.reaped = true;
  if (process.platform === 'win32') {
    runQuietProcessSync('taskkill', ['/pid', String(info.pid), '/t', '/f']);
    return;
  }

  signalProcessGroup(info.pid, 'SIGTERM');
  sweepDirectChildrenSync(info.pid, 'TERM');
  await sleep(graceMs);

  if (processGroupHasMembersSync(info.pid) || processHasDirectChildrenSync(info.pid)) {
    signalProcessGroup(info.pid, 'SIGKILL');
    sweepDirectChildrenSync(info.pid, 'KILL');
  }
}

function reapManagedChildSync(info) {
  if (!info || !Number.isInteger(info.pid) || info.pid <= 0) {
    return;
  }
  if (process.platform === 'win32') {
    runQuietProcessSync('taskkill', ['/pid', String(info.pid), '/t', '/f']);
    return;
  }
  signalProcessGroup(info.pid, 'SIGTERM');
  sweepDirectChildrenSync(info.pid, 'TERM');
  signalProcessGroup(info.pid, 'SIGKILL');
  sweepDirectChildrenSync(info.pid, 'KILL');
}

function cleanupManagedChildrenSync(reason = 'exit') {
  for (const info of MANAGED_CHILDREN.values()) {
    info.cleanup_reason = reason;
    reapManagedChildSync(info);
  }
  sweepDirectChildrenSync(process.pid, 'TERM');
  sweepDirectChildrenSync(process.pid, 'KILL');
}

function ensureManagedChildCleanupHooks() {
  if (managedChildCleanupHooksInstalled) {
    return;
  }
  managedChildCleanupHooksInstalled = true;

  process.on('exit', () => {
    cleanupManagedChildrenSync('exit');
  });
  process.on('uncaughtExceptionMonitor', () => {
    cleanupManagedChildrenSync('uncaughtException');
  });
}

function runShellSync(command, options = {}) {
  const cwd = options.cwd || REPO_ROOT;
  const timeoutMs = options.timeoutMs || DEFAULT_SHELL_TIMEOUT_MS;
  const start = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: DEFAULT_SHELL_OUTPUT_LIMIT,
    env: buildManagedCommandEnv(process.env),
  });
  const durationMs = Date.now() - start;
  const status = result.status ?? -1;
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return {
    command,
    cwd,
    durationMs,
    status,
    stdout,
    stderr,
    timedOut,
    error: result.error ? String(result.error.message || result.error) : null,
    ok: status === 0 && !timedOut,
  };
}

async function runShell(command, options = {}) {
  ensureManagedChildCleanupHooks();

  const cwd = options.cwd || REPO_ROOT;
  const timeoutMs = options.timeoutMs || DEFAULT_SHELL_TIMEOUT_MS;
  const start = Date.now();
  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
  const shellArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', command]
      : ['-lc', command];

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let timeoutHandle = null;

    const child = spawn(shell, shellArgs, {
      cwd,
      detached: process.platform !== 'win32',
      env: buildManagedCommandEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const info = {
      pid: child.pid,
      command,
      cwd,
      child,
      reaped: false,
    };
    if (Number.isInteger(child.pid) && child.pid > 0) {
      MANAGED_CHILDREN.set(child.pid, info);
    }

    const finalize = async (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      MANAGED_CHILDREN.delete(info.pid);
      await reapManagedChild(info, { graceMs: MANAGED_CHILD_REAP_GRACE_MS });

      const durationMs = Date.now() - start;
      const status = typeof code === 'number' ? code : -1;
      resolve({
        command,
        cwd,
        durationMs,
        status,
        stdout,
        stderr,
        signal: signal || null,
        timedOut,
        error:
          spawnError
            ? String(spawnError.message || spawnError)
            : timedOut ? `Command timed out after ${timeoutMs}ms` : null,
        ok: status === 0 && !timedOut,
      });
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout = appendShellOutput(stdout, chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = appendShellOutput(stderr, chunk);
      });
    }

    child.once('error', async (error) => {
      spawnError = error;
      await finalize(null, null);
    });
    child.once('close', async (code, signal) => {
      await finalize(code, signal);
    });

    timeoutHandle = setTimeout(async () => {
      timedOut = true;
      await reapManagedChild(info, {
        force: true,
        graceMs: MANAGED_CHILD_REAP_GRACE_MS,
      });
    }, timeoutMs);
  });
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value)))];
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeStringArray(values) {
  return uniqueStrings(
    ensureArray(values)
      .map((value) => String(value).trim())
      .filter(Boolean),
  );
}

function safeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function inferPlanStage(project, plan) {
  const declared = plan?.orchestration?.stage;
  if (declared === 'planning' || declared === 'execution') {
    return declared;
  }

  if (plan?.plan_id === `${project}-plan`) {
    return 'planning';
  }

  if (typeof plan?.phase === 'string' && /planning/i.test(plan.phase)) {
    return 'planning';
  }

  if (typeof plan?.scope === 'string' && /planning only/i.test(plan.scope)) {
    return 'planning';
  }

  return 'execution';
}

function isPlanningLifecycleStatus(status) {
  return status === 'planning' || status === PLANNING_DRAFT_LIFECYCLE_STATUS;
}

function isPlanningDraftLifecycleStatus(status) {
  return status === PLANNING_DRAFT_LIFECYCLE_STATUS;
}

function isPlanningDraftState(state) {
  return isPlanningDraftLifecycleStatus(state?.lifecycle?.status) || state?.planning?.status === 'draft';
}

function defaultEnabledForRole(stage, role) {
  const definition = ROLE_DEFINITIONS[role];
  return Boolean(definition && definition.stage === stage && definition.enabled_by_default);
}

function normalizeRoleConfig(stage, role, config = {}) {
  const definition = ROLE_DEFINITIONS[role] || {
    fresh_context: true,
    independent: false,
    focus_areas: [],
    anti_patterns: [],
    expected_outputs: [],
  };
  const roleConfig =
    config && typeof config === 'object' && !Array.isArray(config)
      ? config
      : {};

  return {
    enabled: 'enabled' in roleConfig ? roleConfig.enabled !== false : defaultEnabledForRole(stage, role),
    fresh_context:
      typeof roleConfig.fresh_context === 'boolean'
        ? roleConfig.fresh_context
        : definition.fresh_context,
    independent:
      typeof roleConfig.independent === 'boolean'
        ? roleConfig.independent
        : definition.independent,
    focus_areas: normalizeStringArray(
      roleConfig.focus_areas && roleConfig.focus_areas.length > 0
        ? roleConfig.focus_areas
        : definition.focus_areas,
    ),
    anti_patterns: normalizeStringArray(
      roleConfig.anti_patterns && roleConfig.anti_patterns.length > 0
        ? roleConfig.anti_patterns
        : definition.anti_patterns,
    ),
    additional_context: normalizeStringArray(roleConfig.additional_context || []),
    expected_outputs: normalizeStringArray(definition.expected_outputs || []),
  };
}

function resolveOrchestrationConfig(project, plan) {
  const raw =
    plan?.orchestration && typeof plan.orchestration === 'object' && !Array.isArray(plan.orchestration)
      ? plan.orchestration
      : {};
  const rawRoles =
    raw.roles && typeof raw.roles === 'object' && !Array.isArray(raw.roles)
      ? raw.roles
      : {};
  const stage = inferPlanStage(project, plan);
  const roles = Object.fromEntries(
    KNOWN_ROLES.map((role) => [role, normalizeRoleConfig(stage, role, rawRoles[role])]),
  );

  return {
    stage,
    discovery_propagation: raw.discovery_propagation !== false,
    roles,
  };
}

function normalizeDelegationConfig(plan = {}) {
  const raw =
    plan?.delegation && typeof plan.delegation === 'object' && !Array.isArray(plan.delegation)
      ? plan.delegation
      : {};
  const mode = KNOWN_DELEGATION_MODES.has(raw.mode) ? raw.mode : 'local_only';
  const owner = KNOWN_DELEGATION_OWNERS.has(raw.owner) ? raw.owner : 'smike_runner';

  return {
    mode,
    owner,
    runtime_roles: normalizeStringArray(raw.runtime_roles || []),
    dispatch_artifacts: normalizePathList(raw.dispatch_artifacts || []),
    result_artifacts: normalizePathList(raw.result_artifacts || []),
  };
}

function defaultAutoRuntimeRoles(plan = {}) {
  const preferred = normalizeStringArray(plan?.delegation?.runtime_roles || [])
    .filter((role) => role === 'executor');
  return preferred.length > 0 ? preferred : ['executor'];
}

function normalizePhaseRefreshMode(plan = {}) {
  const rawFlags =
    plan?.feature_flags && typeof plan.feature_flags === 'object' && !Array.isArray(plan.feature_flags)
      ? plan.feature_flags
      : {};
  const rawMode = typeof rawFlags.phase_refresh_mode === 'string'
    ? rawFlags.phase_refresh_mode.trim()
    : '';
  if (KNOWN_PHASE_REFRESH_MODES.has(rawMode)) {
    return rawMode;
  }

  if (inferPlanStage('', plan) === 'execution' && normalizeStringArray(plan?.depends_on).length > 0) {
    return 'auto_detailer_on_drift';
  }

  return 'lightweight';
}

function createDispatchFreshness(status = 'pending', reason = null, checkedAt = null) {
  const normalizedStatus = KNOWN_RUNTIME_DISPATCH_FRESHNESS.has(status) ? status : 'pending';
  return {
    status: normalizedStatus,
    checked_at: checkedAt,
    reason: typeof reason === 'string' && reason.trim() ? reason.trim() : null,
  };
}

function normalizeArtifactSnapshotList(value) {
  return ensureArray(value)
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      path: typeof entry.path === 'string' ? normalizeRel(entry.path) : '',
      exists: entry.exists === true,
      sha256: typeof entry.sha256 === 'string' && entry.sha256.trim() ? entry.sha256 : null,
      size_bytes: Number.isInteger(entry.size_bytes) && entry.size_bytes >= 0 ? entry.size_bytes : 0,
      mtime_ms: Number.isFinite(entry.mtime_ms) ? Number(entry.mtime_ms) : null,
    }))
    .filter((entry) => entry.path);
}

function ensureRuntimeDispatchState(orchestration) {
  if (
    !orchestration.runtime_dispatches ||
    typeof orchestration.runtime_dispatches !== 'object' ||
    Array.isArray(orchestration.runtime_dispatches)
  ) {
    orchestration.runtime_dispatches = {};
  }

  const runtimeDispatches = orchestration.runtime_dispatches;
  if (!runtimeDispatches.by_id || typeof runtimeDispatches.by_id !== 'object' || Array.isArray(runtimeDispatches.by_id)) {
    runtimeDispatches.by_id = {};
  }

  for (const [dispatchId, rawEntry] of Object.entries(runtimeDispatches.by_id)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      delete runtimeDispatches.by_id[dispatchId];
      continue;
    }

    rawEntry.dispatch_id = typeof rawEntry.dispatch_id === 'string' && rawEntry.dispatch_id.trim()
      ? rawEntry.dispatch_id
      : dispatchId;
    rawEntry.plan_id = typeof rawEntry.plan_id === 'string' ? rawEntry.plan_id : '';
    rawEntry.role = typeof rawEntry.role === 'string' && KNOWN_ROLES.includes(rawEntry.role) ? rawEntry.role : '';
    rawEntry.group = Number.isInteger(rawEntry.group) && rawEntry.group >= 1 ? rawEntry.group : 1;
    rawEntry.current = rawEntry.current === true;
    rawEntry.signature = typeof rawEntry.signature === 'string' ? rawEntry.signature : '';
    rawEntry.capsule_json = typeof rawEntry.capsule_json === 'string' ? normalizeRel(rawEntry.capsule_json) : '';
    rawEntry.result_artifacts = normalizePathList(rawEntry.result_artifacts || []);
    rawEntry.artifact_change_required = rawEntry.artifact_change_required === true;
    rawEntry.completion_requirements = normalizeDispatchCompletionRequirements(
      rawEntry.completion_requirements,
      rawEntry.result_artifacts,
      rawEntry.artifact_change_required,
    );
    rawEntry.agent_type_hint = typeof rawEntry.agent_type_hint === 'string' ? rawEntry.agent_type_hint : 'default';
    rawEntry.reasoning_effort_hint = typeof rawEntry.reasoning_effort_hint === 'string' ? rawEntry.reasoning_effort_hint : 'medium';
    rawEntry.instruction = typeof rawEntry.instruction === 'string' ? rawEntry.instruction : '';
    rawEntry.spawn_recommended = rawEntry.spawn_recommended !== false;
    rawEntry.status = KNOWN_RUNTIME_DISPATCH_STATUSES.has(rawEntry.status) ? rawEntry.status : 'queued';
    rawEntry.created_at = typeof rawEntry.created_at === 'string' ? rawEntry.created_at : nowIso();
    rawEntry.updated_at = typeof rawEntry.updated_at === 'string' ? rawEntry.updated_at : rawEntry.created_at;
    rawEntry.last_seen_at = typeof rawEntry.last_seen_at === 'string' ? rawEntry.last_seen_at : rawEntry.updated_at;
    rawEntry.last_spawned_at = typeof rawEntry.last_spawned_at === 'string' ? rawEntry.last_spawned_at : null;
    rawEntry.completed_at = typeof rawEntry.completed_at === 'string' ? rawEntry.completed_at : null;
    rawEntry.failed_at = typeof rawEntry.failed_at === 'string' ? rawEntry.failed_at : null;
    rawEntry.stale_at = typeof rawEntry.stale_at === 'string' ? rawEntry.stale_at : null;
    rawEntry.failure_reason = typeof rawEntry.failure_reason === 'string' && rawEntry.failure_reason.trim()
      ? rawEntry.failure_reason.trim()
      : null;
    rawEntry.spawn_baseline = normalizeArtifactSnapshotList(rawEntry.spawn_baseline);
    rawEntry.completion_artifacts = normalizeArtifactSnapshotList(rawEntry.completion_artifacts);
    rawEntry.freshness =
      rawEntry.freshness && typeof rawEntry.freshness === 'object' && !Array.isArray(rawEntry.freshness)
        ? createDispatchFreshness(rawEntry.freshness.status, rawEntry.freshness.reason, rawEntry.freshness.checked_at || null)
        : createDispatchFreshness();
    rawEntry.transition_log = ensureArray(rawEntry.transition_log)
      .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => ({
        at: typeof entry.at === 'string' ? entry.at : rawEntry.updated_at,
        status: KNOWN_RUNTIME_DISPATCH_STATUSES.has(entry.status) ? entry.status : rawEntry.status,
        reason: typeof entry.reason === 'string' && entry.reason.trim() ? entry.reason.trim() : null,
      }))
      .slice(-20);
  }

  return runtimeDispatches;
}

function ensureOrchestrationState(state) {
  if (!state.orchestration || typeof state.orchestration !== 'object' || Array.isArray(state.orchestration)) {
    state.orchestration = {};
  }

  const orchestration = state.orchestration;
  orchestration.stage = typeof orchestration.stage === 'string' ? orchestration.stage : 'execution';
  orchestration.active_role = typeof orchestration.active_role === 'string' ? orchestration.active_role : null;
  orchestration.last_role = typeof orchestration.last_role === 'string' ? orchestration.last_role : null;
  orchestration.next_role = typeof orchestration.next_role === 'string' ? orchestration.next_role : null;
  orchestration.discovery_propagation = orchestration.discovery_propagation !== false;
  orchestration.role_history = ensureArray(orchestration.role_history);

  if (!orchestration.capsules || typeof orchestration.capsules !== 'object' || Array.isArray(orchestration.capsules)) {
    orchestration.capsules = {};
  }
  const capsules = orchestration.capsules;
  if (!capsules.latest_by_role || typeof capsules.latest_by_role !== 'object' || Array.isArray(capsules.latest_by_role)) {
    capsules.latest_by_role = {};
  }
  if (!capsules.by_plan || typeof capsules.by_plan !== 'object' || Array.isArray(capsules.by_plan)) {
    capsules.by_plan = {};
  }
  if (
    orchestration.current_actionable_dispatch !== null
    && (
      !orchestration.current_actionable_dispatch
      || typeof orchestration.current_actionable_dispatch !== 'object'
      || Array.isArray(orchestration.current_actionable_dispatch)
    )
  ) {
    orchestration.current_actionable_dispatch = null;
  }
  if (!Object.prototype.hasOwnProperty.call(orchestration, 'current_actionable_dispatch')) {
    orchestration.current_actionable_dispatch = null;
  }
  orchestration.current_actionable_capsule = typeof orchestration.current_actionable_capsule === 'string'
    && orchestration.current_actionable_capsule.trim()
    ? orchestration.current_actionable_capsule.trim()
    : null;
  if (
    !orchestration.runtime_dispatch_view
    || typeof orchestration.runtime_dispatch_view !== 'object'
    || Array.isArray(orchestration.runtime_dispatch_view)
  ) {
    orchestration.runtime_dispatch_view = {};
  }
  const runtimeDispatchView = orchestration.runtime_dispatch_view;
  runtimeDispatchView.actionable_plan =
    runtimeDispatchView.actionable_plan
    && typeof runtimeDispatchView.actionable_plan === 'object'
    && !Array.isArray(runtimeDispatchView.actionable_plan)
      ? runtimeDispatchView.actionable_plan
      : null;
  runtimeDispatchView.ready_dispatches = ensureArray(runtimeDispatchView.ready_dispatches)
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
  runtimeDispatchView.dispatch_counts =
    runtimeDispatchView.dispatch_counts
    && typeof runtimeDispatchView.dispatch_counts === 'object'
    && !Array.isArray(runtimeDispatchView.dispatch_counts)
      ? runtimeDispatchView.dispatch_counts
      : {
        tracked: 0,
        ready: 0,
        active: 0,
        failed: 0,
        completed: 0,
      };
  runtimeDispatchView.delegation =
    runtimeDispatchView.delegation
    && typeof runtimeDispatchView.delegation === 'object'
    && !Array.isArray(runtimeDispatchView.delegation)
      ? runtimeDispatchView.delegation
      : {
        mode: 'local_only',
        owner: 'smike_runner',
        result_artifacts: [],
      };
  ensureRuntimeDispatchState(orchestration);

  return orchestration;
}

function hashFileSha256(absolutePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(absolutePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function snapshotArtifactPath(filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(REPO_ROOT, filePath);
  if (!isPathInside(REPO_ROOT, absolutePath)) {
    fail(`result artifact path escapes repository root: ${filePath}`);
  }
  const relativePath = normalizeRel(path.relative(REPO_ROOT, absolutePath));
  if (!fs.existsSync(absolutePath)) {
    return {
      path: relativePath,
      exists: false,
      sha256: null,
      size_bytes: 0,
      mtime_ms: null,
    };
  }

  const stats = fs.statSync(absolutePath);
  if (!stats.isFile()) {
    fail(`result artifact is not a file: ${relativePath}`);
  }
  if (stats.size > MAX_ARTIFACT_SNAPSHOT_BYTES) {
    fail(
      `result artifact exceeds snapshot size cap (${MAX_ARTIFACT_SNAPSHOT_BYTES} bytes): ${relativePath} (${stats.size} bytes)`,
    );
  }
  return {
    path: relativePath,
    exists: true,
    sha256: hashFileSha256(absolutePath),
    size_bytes: stats.size,
    mtime_ms: Math.round(stats.mtimeMs),
  };
}

function snapshotArtifactList(paths) {
  return normalizePathList(paths).map((artifactPath) => snapshotArtifactPath(artifactPath));
}

function artifactSnapshotEquivalent(left, right) {
  const leftEntries = normalizeArtifactSnapshotList(left);
  const rightEntries = normalizeArtifactSnapshotList(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (let index = 0; index < leftEntries.length; index += 1) {
    const leftEntry = leftEntries[index];
    const rightEntry = rightEntries[index];
    if (
      leftEntry.path !== rightEntry.path ||
      leftEntry.exists !== rightEntry.exists ||
      leftEntry.sha256 !== rightEntry.sha256 ||
      leftEntry.size_bytes !== rightEntry.size_bytes
    ) {
      return false;
    }
  }

  return true;
}

function artifactChangeRequiredForRole(role) {
  return role === 'strategist' || role === 'detailer' || role === 'executor' || role === 'fixer';
}

function buildDispatchCompletionRequirements(resultArtifacts = [], artifactChangeRequired = false) {
  return normalizeDispatchCompletionRequirements(null, resultArtifacts, artifactChangeRequired);
}

function buildCompletionChecksFromRequirements(requirements) {
  const normalized = normalizeDispatchCompletionRequirements(requirements);
  const artifactPaths = normalized.artifact_requirements.map((entry) => entry.path);
  const checks = [
    artifactPaths.length > 0
      ? `Write the declared result artifacts on disk: ${artifactPaths.join(', ')}.`
      : 'Write the role-specific result artifacts declared by the dispatch contract.',
  ];
  const hasJson = normalized.artifact_requirements.some((entry) => entry.must_parse_json);
  const hasText = normalized.artifact_requirements.some((entry) => entry.kind === 'text');
  if (hasJson) {
    checks.push('JSON result artifacts must parse successfully and contain non-empty semantic content.');
  }
  if (hasText) {
    checks.push('Text result artifacts must contain non-blank content.');
  }
  checks.push(
    normalized.require_artifact_change
      ? 'Materially change at least one declared result artifact before marking the dispatch complete.'
      : 'Leave a valid result artifact even when the role only reports pass/fail or findings.',
  );
  return uniqueStrings(checks);
}

function appendRuntimeDispatchTransition(entry, status, reason = null, at = nowIso()) {
  entry.transition_log = ensureArray(entry.transition_log);
  const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  const last = entry.transition_log[entry.transition_log.length - 1];
  if (!last || last.status !== status || last.reason !== normalizedReason) {
    entry.transition_log.push({ at, status, reason: normalizedReason });
    if (entry.transition_log.length > 20) {
      entry.transition_log = entry.transition_log.slice(-20);
    }
  }
}

function updateRuntimeDispatchStatus(entry, status, reason = null, at = nowIso()) {
  const normalizedStatus = KNOWN_RUNTIME_DISPATCH_STATUSES.has(status) ? status : 'queued';
  entry.status = normalizedStatus;
  entry.updated_at = at;
  if (normalizedStatus === 'spawned') {
    entry.last_spawned_at = at;
    entry.failed_at = null;
    entry.failure_reason = null;
  } else if (normalizedStatus === 'completed') {
    entry.completed_at = at;
    entry.failed_at = null;
    entry.failure_reason = null;
    entry.stale_at = null;
  } else if (normalizedStatus === 'failed') {
    entry.failed_at = at;
    entry.failure_reason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'runtime dispatch failed';
  } else if (normalizedStatus === 'stale') {
    entry.stale_at = at;
  } else if (normalizedStatus === 'queued') {
    entry.failed_at = null;
    entry.failure_reason = null;
  }
  appendRuntimeDispatchTransition(entry, normalizedStatus, reason, at);
}

function buildDispatchFreshnessFromCompletion(entry) {
  const checkedAt = nowIso();
  const completionArtifacts = normalizeArtifactSnapshotList(entry.completion_artifacts);
  if (completionArtifacts.length === 0) {
    return createDispatchFreshness('stale', 'No completion artifact snapshot was recorded.', checkedAt);
  }

  const currentArtifacts = snapshotArtifactList(entry.result_artifacts);
  const missingArtifact = currentArtifacts.find((artifact) => !artifact.exists);
  if (missingArtifact) {
    return createDispatchFreshness('missing', `Missing result artifact: ${missingArtifact.path}`, checkedAt);
  }
  if (artifactSnapshotEquivalent(currentArtifacts, completionArtifacts)) {
    return createDispatchFreshness('fresh', 'Result artifacts still match the completion snapshot.', checkedAt);
  }
  return createDispatchFreshness('stale', 'Result artifacts changed after the dispatch completed.', checkedAt);
}

function buildRoleCapsuleBasename(planId, role) {
  return `${safeSlug(planId)}-${safeSlug(role)}-capsule`;
}

function getRoleCapsulePaths(paths, planId, role) {
  const base = buildRoleCapsuleBasename(planId, role);
  return {
    jsonPath: path.join(paths.capsulesDir, `${base}.json`),
    jsonRel: path.relative(REPO_ROOT, path.join(paths.capsulesDir, `${base}.json`)).replaceAll(path.sep, '/'),
    mdPath: null,
    mdRel: null,
  };
}

function updateCapsuleRefs(orchestration, role, planId, capsulePaths) {
  orchestration.capsules.latest_by_role[role] = capsulePaths.jsonRel;
  if (!orchestration.capsules.by_plan[planId] || typeof orchestration.capsules.by_plan[planId] !== 'object') {
    orchestration.capsules.by_plan[planId] = {};
  }
  orchestration.capsules.by_plan[planId][role] = capsulePaths.jsonRel;
}

function recordRoleHistory(orchestration, entry) {
  orchestration.role_history.push(entry);
  if (orchestration.role_history.length > 200) {
    orchestration.role_history = orchestration.role_history.slice(-200);
  }
}

function ensureDiscoveryLog(state) {
  state.propagated_discoveries = ensureArray(state.propagated_discoveries);
  return state.propagated_discoveries;
}

function collectCapsulePathsForPlan(state, planId, roles) {
  const orchestration = ensureOrchestrationState(state);
  const byPlan = orchestration.capsules.by_plan?.[planId];
  if (!byPlan || typeof byPlan !== 'object' || Array.isArray(byPlan)) {
    return [];
  }

  return normalizePathList(
    normalizeStringArray(roles)
      .map((role) => byPlan[role])
      .filter(Boolean),
  );
}

function collectLatestCapsulePaths(state, roles) {
  const orchestration = ensureOrchestrationState(state);
  return normalizePathList(
    normalizeStringArray(roles)
      .map((role) => orchestration.capsules.latest_by_role?.[role])
      .filter(Boolean),
  );
}

function limitCapsuleRefs(paths, limit = CAPSULE_REF_LIMIT) {
  return normalizePathList(paths).slice(0, limit);
}

function collectDependencyCapsulePaths(state, dependencyIds, roles, limit = CAPSULE_REF_LIMIT) {
  return limitCapsuleRefs(
    normalizeStringArray(dependencyIds)
      .flatMap((dependencyId) => collectCapsulePathsForPlan(state, dependencyId, roles)),
    limit,
  );
}

function trimStateGotchas(values, limit = STATE_GOTCHA_LIMIT, { keepLatest = true } = {}) {
  const gotchas = normalizeStringArray(values);
  if (gotchas.length <= limit) {
    return gotchas;
  }
  return keepLatest ? gotchas.slice(-limit) : gotchas.slice(0, limit);
}

function repairStateGotchaOverflow(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || !Array.isArray(state.gotchas)) {
    return false;
  }
  if (state.gotchas.length <= STATE_GOTCHA_LIMIT) {
    return false;
  }
  state.gotchas = state.gotchas.slice(-STATE_GOTCHA_LIMIT);
  return true;
}

function persistStateRepair(paths, state) {
  state.updated_at = nowIso();
  writeJson(paths.statePath, state);
}

function readValidatedState(paths, { strict = false, persistRepair = false } = {}) {
  const state = readJson(paths.statePath);
  const repaired = strict ? false : repairStateGotchaOverflow(state);
  const validationErrors = validateState(state);
  if (validationErrors.length > 0) {
    fail(`STATE.json validation failed:\n- ${validationErrors.join('\n- ')}`);
  }
  if (repaired && persistRepair) {
    persistStateRepair(paths, state);
  }
  return { state, repaired };
}

function persistRoleCapsule(paths, state, capsule, status, summary) {
  const orchestration = ensureOrchestrationState(state);
  const capsulePaths = writeRoleCapsule(paths, capsule);
  updateCapsuleRefs(orchestration, capsule.role, capsule.plan_id, capsulePaths);
  recordRoleHistory(orchestration, {
    cycle: capsule.cycle ?? 0,
    stage: capsule.stage,
    role: capsule.role,
    plan_id: capsule.plan_id,
    status,
    capsule_json: capsulePaths.jsonRel,
    generated_at: capsule.generated_at,
    summary,
  });
  orchestration.last_role = capsule.role;
  return capsulePaths;
}

function writeDispatchCapsule(paths, state, capsule) {
  const orchestration = ensureOrchestrationState(state);
  const capsulePaths = writeRoleCapsule(paths, capsule);
  updateCapsuleRefs(orchestration, capsule.role, capsule.plan_id, capsulePaths);
  return capsulePaths;
}

function findDownstreamPlanIds(workflowPlans, planId) {
  return ensureArray(workflowPlans)
    .filter((plan) => ensureArray(plan.depends_on).includes(planId))
    .map((plan) => plan.plan_id);
}

function appendPropagatedDiscoveries(state, sourcePlanId, targetPlanIds, discoveries) {
  const items = normalizeStringArray(discoveries);
  if (items.length === 0) {
    return;
  }

  const discoveryLog = ensureDiscoveryLog(state);
  discoveryLog.push({
    source_plan_id: sourcePlanId,
    target_plan_ids: normalizeStringArray(targetPlanIds),
    generated_at: nowIso(),
    discoveries: items,
  });
  if (discoveryLog.length > 100) {
    state.propagated_discoveries = discoveryLog.slice(-100);
  }
}

function sortStrings(values) {
  return [...normalizeStringArray(values)].sort((left, right) => left.localeCompare(right));
}

function sortByKey(values, buildKey) {
  return [...ensureArray(values)].sort((left, right) => buildKey(left).localeCompare(buildKey(right)));
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObjectKeys(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

function buildPlanHashInput(plan) {
  return sortObjectKeys({
    profile: plan?.profile || null,
    feature_flags: plan?.feature_flags || null,
    depends_on: sortStrings(plan?.depends_on),
    allowed_files: sortStrings(plan?.allowed_files),
    blocked_files: sortStrings(plan?.blocked_files),
    write_scope: {
      mode: plan?.write_scope?.mode || null,
      allowed_files: sortStrings(plan?.write_scope?.allowed_files),
      blocked_files: sortStrings(plan?.write_scope?.blocked_files),
      reason: plan?.write_scope?.reason || null,
    },
    preflight: {
      require_clean_worktree:
        typeof plan?.preflight?.require_clean_worktree === 'boolean'
          ? plan.preflight.require_clean_worktree
          : null,
      required_tools: sortStrings(plan?.preflight?.required_tools),
      required_env_vars: sortStrings(plan?.preflight?.required_env_vars),
    },
    verify_commands: sortByKey(
      ensureArray(plan?.verify_commands).map((command) => ({
        id: command?.id || null,
        run: command?.run || null,
        cwd: command?.cwd || null,
        timeout_ms: Number.isInteger(command?.timeout_ms) ? command.timeout_ms : null,
        expect: command?.expect || null,
      })),
      (command) => String(command?.id || ''),
    ),
    acceptance_criteria: sortByKey(
      ensureArray(plan?.acceptance_criteria).map((ac) => ({
        id: ac?.id || null,
        description: ac?.description || null,
        command_ids: sortStrings(ac?.command_ids),
        signals: sortByKey(
          ensureArray(ac?.signals).map((signal) => ({
            command_id: signal?.command_id || null,
            expected_signal: signal?.expected_signal || null,
          })),
          (signal) => `${signal?.command_id || ''}:${signal?.expected_signal || ''}`,
        ),
      })),
      (ac) => String(ac?.id || ''),
    ),
    postflight: {
      commands: sortByKey(
        ensureArray(plan?.postflight?.commands).map((command) => ({
          id: command?.id || null,
          run: command?.run || null,
          cwd: command?.cwd || null,
          timeout_ms: Number.isInteger(command?.timeout_ms) ? command.timeout_ms : null,
          expect: command?.expect || null,
        })),
        (command) => String(command?.id || ''),
      ),
    },
    quality_gates: plan?.quality_gates || null,
  });
}

function hashPlanContractLegacy(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function hashPlanContract(plan) {
  return crypto.createHash('sha256').update(JSON.stringify(buildPlanHashInput(plan))).digest('hex');
}

function escapeRegex(input) {
  return input.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(glob) {
  const normalized = normalizeRel(glob);
  let regex = '';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];

    if (char === '*') {
      const nextChar = normalized[index + 1];
      const afterNextChar = normalized[index + 2];
      if (nextChar === '*') {
        if (afterNextChar === '/') {
          regex += '(?:.*/)?';
          index += 2;
        } else {
          regex += '.*';
          index += 1;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      continue;
    }

    regex += escapeRegex(char);
  }

  return new RegExp(`^${regex}$`);
}

function matchesAnyGlob(filePath, globs) {
  const normalized = normalizeRel(filePath);
  return globs.some((glob) => globToRegex(glob).test(normalized));
}

function getDirtyPaths() {
  const tracked = runShellSync('git diff --name-only --relative HEAD', { timeoutMs: 20_000 });
  const untracked = runShellSync('git ls-files --others --exclude-standard', { timeoutMs: 20_000 });
  if (tracked.status !== 0 || untracked.status !== 0) {
    fail('unable to read git workspace status; ensure this is a git repository with git installed');
  }

  const trackedPaths = tracked.stdout
    .split(/\r?\n/)
    .map(normalizeRel)
    .filter(Boolean);
  const untrackedPaths = untracked.stdout
    .split(/\r?\n/)
    .map(normalizeRel)
    .filter(Boolean);

  return new Set([...trackedPaths, ...untrackedPaths]);
}

function getProjectPaths(project) {
  const projectDir = path.join(SMIKE_ROOT, project);
  return {
    projectDir,
    inputsDir: path.join(projectDir, 'inputs'),
    capsulesDir: path.join(projectDir, 'capsules'),
    projectMetaPath: path.join(projectDir, 'PROJECT.json'),
    projectMdPath: path.join(projectDir, 'PROJECT.md'),
    roadmapPath: path.join(projectDir, 'ROADMAP.md'),
    strategyPath: path.join(projectDir, 'STRATEGY.md'),
    notesPath: path.join(projectDir, 'SMIKE-NOTES.md'),
    planJsonPath: path.join(projectDir, 'PLAN.json'),
    planMdPath: path.join(projectDir, 'PLAN.md'),
    statePath: path.join(projectDir, 'STATE.json'),
    stateMdPath: path.join(projectDir, 'STATE.md'),
    execReportPath: path.join(projectDir, 'EXEC-REPORT.md'),
    verdictReportPath: path.join(projectDir, 'VERDICT.md'),
    reviewReportPath: path.join(projectDir, 'REVIEW.md'),
    planningCheckerJsonPath: path.join(projectDir, 'CHECKER.json'),
    planningCheckerMdPath: path.join(projectDir, 'CHECKER.md'),
    planningAuditorJsonPath: path.join(projectDir, 'AUDITOR.json'),
    planningAuditorMdPath: path.join(projectDir, 'AUDITOR.md'),
    planningAuditJsonPath: path.join(projectDir, 'AUDIT.json'),
    planningAuditMdPath: path.join(projectDir, 'AUDIT.md'),
    planningHandoffMdPath: path.join(projectDir, 'PLANNING-HANDOFF.md'),
    resumeCapsuleJsonPath: path.join(projectDir, 'RESUME-CAPSULE.json'),
    resumeCapsuleMdPath: path.join(projectDir, 'RESUME-CAPSULE.md'),
    implementationHandoffJsonPath: path.join(projectDir, 'IMPLEMENTATION-HANDOFF.json'),
    planGraphJsonPath: path.join(projectDir, 'PLAN-GRAPH.json'),
    planGraphMdPath: path.join(projectDir, 'PLAN-GRAPH.md'),
    indexJsonPath: path.join(projectDir, 'INDEX.json'),
  };
}

function removeLegacyRuntimeDelegationArtifacts(projectDir) {
  for (const fileName of ['RUNTIME-DELEGATION.json', 'RUNTIME-DELEGATION.md']) {
    const filePath = path.join(projectDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

function getArchivePaths(project) {
  const archiveDir = path.join(SMIKE_ARCHIVE_ROOT, project);
  return {
    archiveDir,
    manifestPath: path.join(archiveDir, 'MANIFEST.json'),
    inputsDir: path.join(archiveDir, 'inputs'),
    runtimeDir: path.join(archiveDir, 'project'),
  };
}

function walkRelativeFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(normalizeRel(path.relative(rootDir, absolutePath)));
      }
    }
  };

  walk(rootDir);
  return files.sort();
}

function latestCapsuleArchiveSet(project, state) {
  const latestByRole = ensureOrchestrationState(state)?.capsules?.latest_by_role || {};
  return new Set(
    Object.values(latestByRole)
      .filter((value) => typeof value === 'string' && value.trim())
      .map((value) => normalizeRel(value))
      .filter((value) => value.startsWith(`.smike/${project}/capsules/`)),
  );
}

function shouldIncludeArchivedRuntimeFile(project, relPath, mode, latestCapsules) {
  const normalized = normalizeRel(relPath);
  if (!normalized || normalized.endsWith('.tmp')) {
    return false;
  }
  if (normalized === '.lock' || normalized.startsWith('.lock/')) {
    return false;
  }
  if (mode === 'full') {
    return true;
  }
  if (normalized === 'capsules' || normalized.startsWith('capsules/')) {
    return latestCapsules.has(`.smike/${project}/${normalized}`);
  }
  return true;
}

function copyRelativeFile(srcRoot, destRoot, relPath) {
  const sourcePath = path.join(srcRoot, relPath);
  const destinationPath = path.join(destRoot, relPath);
  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyTreeFiles(srcRoot, destRoot) {
  const copiedFiles = [];
  ensureDir(destRoot);
  for (const relPath of walkRelativeFiles(srcRoot)) {
    copyRelativeFile(srcRoot, destRoot, relPath);
    copiedFiles.push(normalizeRel(relPath));
  }
  return copiedFiles;
}

function copyProjectRuntimeForArchive(project, state, archivePaths, mode = 'compact') {
  const sourcePaths = getProjectPaths(project);
  const latestCapsules = latestCapsuleArchiveSet(project, state);
  const copiedFiles = [];

  ensureDir(archivePaths.runtimeDir);
  for (const relPath of walkRelativeFiles(sourcePaths.projectDir)) {
    if (!shouldIncludeArchivedRuntimeFile(project, relPath, mode, latestCapsules)) {
      continue;
    }
    copyRelativeFile(sourcePaths.projectDir, archivePaths.runtimeDir, relPath);
    copiedFiles.push(normalizeRel(path.join('project', relPath)));
  }

  return copiedFiles.sort();
}

function snapshotArchiveInputs(specRel, contextFiles, archivePaths) {
  const copied = [];
  const missing = [];
  const inputs = uniqueStrings([specRel, ...normalizePathList(contextFiles)]).filter(Boolean);

  ensureDir(archivePaths.inputsDir);
  for (const inputRel of inputs) {
    const normalized = normalizeRel(inputRel);
    const sourcePath = path.resolve(REPO_ROOT, normalized);
    if (!isPathInside(REPO_ROOT, sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      missing.push(normalized);
      continue;
    }

    const destinationPath = path.join(archivePaths.inputsDir, normalized);
    ensureDir(path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath);
    copied.push({
      source_rel: normalized,
      archived_rel: normalizeRel(path.relative(archivePaths.archiveDir, destinationPath)),
    });
  }

  return {
    copied,
    missing,
  };
}

function listPlanningInputs(specRel, contextFiles) {
  return uniqueStrings([specRel, ...normalizePathList(contextFiles)]).filter(Boolean);
}

function getProjectInputSnapshotRel(project, inputRel) {
  return normalizeRel(path.posix.join('.smike', project, 'inputs', normalizeRel(inputRel)));
}

function collectProjectPlanningInputStatus(project, paths, specRel, contextFiles) {
  const inputs = listPlanningInputs(specRel, contextFiles);
  const items = inputs.map((inputRel) => {
    const normalized = normalizeRel(inputRel);
    const sourcePath = path.resolve(REPO_ROOT, normalized);
    const snapshotRel = getProjectInputSnapshotRel(project, normalized);
    const snapshotPath = path.resolve(REPO_ROOT, snapshotRel);
    const sourceExists = isPathInside(REPO_ROOT, sourcePath)
      && fs.existsSync(sourcePath)
      && fs.statSync(sourcePath).isFile();
    const snapshotExists = isPathInside(REPO_ROOT, snapshotPath)
      && fs.existsSync(snapshotPath)
      && fs.statSync(snapshotPath).isFile();
    return {
      source_rel: normalized,
      snapshot_rel: snapshotRel,
      source_exists: sourceExists,
      snapshot_exists: snapshotExists,
      role: normalized === normalizeRel(specRel || '') ? 'spec' : 'context',
    };
  });
  return {
    root: normalizeRel(path.relative(REPO_ROOT, paths.inputsDir)),
    inputs: items,
    missing_source_paths: items.filter((item) => !item.source_exists).map((item) => item.source_rel),
    recoverable_paths: items.filter((item) => !item.source_exists && item.snapshot_exists).map((item) => item.source_rel),
    unrecoverable_paths: items.filter((item) => !item.source_exists && !item.snapshot_exists).map((item) => item.source_rel),
  };
}

function snapshotProjectInputs(project, paths, specRel, contextFiles) {
  ensureDir(paths.inputsDir);
  const inputs = listPlanningInputs(specRel, contextFiles);
  for (const inputRel of inputs) {
    const normalized = normalizeRel(inputRel);
    const sourcePath = path.resolve(REPO_ROOT, normalized);
    if (!isPathInside(REPO_ROOT, sourcePath) || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
      continue;
    }
    const snapshotPath = path.resolve(REPO_ROOT, getProjectInputSnapshotRel(project, normalized));
    ensureDir(path.dirname(snapshotPath));
    fs.copyFileSync(sourcePath, snapshotPath);
  }
  return collectProjectPlanningInputStatus(project, paths, specRel, contextFiles);
}

function restoreProjectPlanningInputsFromSnapshot(project, paths, specRel, contextFiles) {
  const before = collectProjectPlanningInputStatus(project, paths, specRel, contextFiles);
  const restored = [];
  for (const item of before.inputs) {
    if (item.source_exists || !item.snapshot_exists) {
      continue;
    }
    const sourcePath = path.resolve(REPO_ROOT, item.source_rel);
    const snapshotPath = path.resolve(REPO_ROOT, item.snapshot_rel);
    ensureDir(path.dirname(sourcePath));
    fs.copyFileSync(snapshotPath, sourcePath);
    restored.push(item.source_rel);
  }
  return {
    restored,
    status: collectProjectPlanningInputStatus(project, paths, specRel, contextFiles),
  };
}

function buildPlanningInputFailureMessage(project, inputStatus, surface) {
  const lines = [
    `${surface} for ${project} is missing readable planning inputs:`,
    ...inputStatus.inputs
      .filter((item) => !item.source_exists)
      .map((item) => `- ${item.source_rel}${item.snapshot_exists ? ` (snapshot available at ${item.snapshot_rel})` : ' (no snapshot available)'}`),
  ];
  if (inputStatus.recoverable_paths.length > 0) {
    lines.push(`Recoverable from snapshots under .smike/${project}/inputs/. Run \`./smike doctor ${project}\` if you want a dedicated diagnosis.`);
  } else {
    lines.push(`No usable local snapshot exists under .smike/${project}/inputs/. Restore the missing files or recreate the project inputs.`);
  }
  return lines.join('\n');
}

function ensurePlanningInputsReadable(project, paths, specRel, contextFiles, surface) {
  if (!specRel || !String(specRel).trim()) {
    fail(`${surface} for ${project} is missing a recorded spec path. Run \`./smike doctor ${project}\`.`);
  }

  const recovery = restoreProjectPlanningInputsFromSnapshot(project, paths, specRel, contextFiles);
  if (recovery.status.missing_source_paths.length > 0) {
    fail(buildPlanningInputFailureMessage(project, recovery.status, surface));
  }
  return recovery;
}

function printPlanningInputRecovery(project, recovery) {
  if (!Array.isArray(recovery?.restored) || recovery.restored.length === 0) {
    return;
  }
  console.log(`smike: restored planning inputs for ${project} from .smike/${project}/inputs`);
  for (const restoredPath of recovery.restored) {
    console.log(`restored_input: ${restoredPath}`);
  }
}

function buildArchiveManifest(project, archiveMode, state, rootPlan, projectMeta, copiedRuntimeFiles, inputSnapshot) {
  const latest = ensureArray(state?.history).at(-1) || null;
  return {
    schema_version: '1.0.0',
    archived_at: nowIso(),
    project,
    archive_mode: archiveMode,
    lifecycle_status: state?.lifecycle?.status || null,
    last_result: state?.lifecycle?.last_result || latest?.result || null,
    last_completed_at: state?.lifecycle?.last_completed_at || latest?.completed_at || null,
    next_action: state?.lifecycle?.next_action || null,
    spec_path: projectMeta?.spec_path || rootPlan?.spec || state?.planning?.spec_path || null,
    context_files: normalizePathList(projectMeta?.context_files || []),
    feedback_path: normalizeRel(path.relative(REPO_ROOT, SMIKE_FEEDBACK_PATH)),
    history_count: ensureArray(state?.history).length,
    plan_count: ensureArray(state?.workflow?.plans).length,
    latest_capsule_roles: sortStrings(Object.keys(ensureOrchestrationState(state)?.capsules?.latest_by_role || {})),
    input_snapshot: inputSnapshot,
    runtime_files: copiedRuntimeFiles,
  };
}

function removeTempFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  let removed = 0;
  const walk = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.tmp')) {
        fs.rmSync(absolutePath, { force: true });
        removed += 1;
      }
    }
  };

  walk(rootDir);
  return removed;
}

function pruneEmptyDirs(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return 0;
  }

  let removed = 0;
  const walk = (currentDir, isRoot = false) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name));
      }
    }

    if (isRoot) {
      return;
    }

    if (fs.readdirSync(currentDir).length === 0) {
      fs.rmdirSync(currentDir);
      removed += 1;
    }
  };

  walk(rootDir, true);
  return removed;
}

function getResearchResultPaths(project, phaseId) {
  const phaseDir = `.smike/${project}/phases/${phaseId}`;
  return {
    jsonRel: `${phaseDir}/${phaseId}-FINDINGS.json`,
  };
}

function getRuntimeExecutionResultPaths(project, phaseId, role) {
  const phaseDir = `.smike/${project}/phases/${phaseId}`;
  return {
    jsonRel: `${phaseDir}/${phaseId}-${role}-runtime.json`,
  };
}

function buildResearchFindingsTemplate(project, phase) {
  return {
    schema_version: '1.0.0',
    project,
    phase: phase.id,
    title: phase.title,
    status: 'todo',
    summary: '',
    findings: [],
    next_action: '',
  };
}

function bulletify(text) {
  return String(text || '')
    .replace(/^[-*+]\s*/, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

function splitDependencyReference(reference) {
  const raw = String(reference || '').trim();
  if (!raw) {
    return { raw: '', project: '', plan_id: '', external: false };
  }

  const separatorIndex = raw.indexOf(':');
  if (separatorIndex === -1) {
    return {
      raw,
      project: null,
      plan_id: raw,
      external: false,
    };
  }

  return {
    raw,
    project: raw.slice(0, separatorIndex).trim(),
    plan_id: raw.slice(separatorIndex + 1).trim(),
    external: true,
  };
}

function normalizeDependencyReference(reference, defaultProject) {
  const parsed = splitDependencyReference(reference);
  return {
    raw: parsed.raw,
    project: parsed.external ? parsed.project : defaultProject,
    plan_id: parsed.plan_id,
    external: parsed.external ? parsed.project !== defaultProject : false,
  };
}

function dependencyNodeKey(project, planId) {
  return `${project}:${planId}`;
}

function formatDependencyReference(project, planId, defaultProject = null) {
  if (defaultProject && project === defaultProject) {
    return planId;
  }
  return `${project}:${planId}`;
}

function validateDependencyReferenceValue(reference, fieldName, errors) {
  const parsed = splitDependencyReference(reference);
  if (!parsed.raw) {
    errors.push(`${fieldName}[] must be non-empty strings`);
    return;
  }
  if (parsed.external && (!parsed.project || !parsed.plan_id)) {
    errors.push(`${fieldName}[] cross-project references must use "project:plan-id"`);
  }
}

const { validatePlan, validateState } = createValidationHelpers({
  planSchemaPath: PLAN_SCHEMA_PATH,
  stateSchemaPath: STATE_SCHEMA_PATH,
  ensureArray,
  uniqueStrings,
  validateDependencyReferenceValue,
});

function extractPlanningNotes(plan, planMdPath, state) {
  const notes = [];

  for (const gotcha of ensureArray(state?.gotchas)) {
    const normalized = bulletify(gotcha);
    if (normalized) {
      notes.push(normalized);
    }
  }

  const explicitPlanNotes = [
    ...sortStrings(plan?.notes),
    ...sortStrings(plan?.risks).map((risk) => `Risk: ${risk}`),
  ];
  if (explicitPlanNotes.length > 0) {
    return uniqueStrings([...notes, ...explicitPlanNotes]);
  }

  if (!planMdPath || !fs.existsSync(planMdPath)) {
    return uniqueStrings(notes);
  }

  const lines = fs.readFileSync(planMdPath, 'utf8').split(/\r?\n/);
  let inKeywordSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (/^#{1,6}\s+/.test(line)) {
      inKeywordSection = /(gotcha|risk|weakness|improv|deviation|open question|follow[- ]up)/i.test(line);
      continue;
    }

    if (/^<\/?(gotchas?|risks?|weakness(?:es)?|improvements?|deviations?|open_questions?|followups?)>$/i.test(line)) {
      inKeywordSection = !line.startsWith('</');
      continue;
    }

    if ((inKeywordSection || /^[-*+]\s+/.test(line) || /^\d+\.\s+/.test(line)) && /(gotcha|risk|weakness|improv|deviation|follow[- ]up|should|need to|needs to)/i.test(line)) {
      const normalized = bulletify(line);
      if (normalized) {
        notes.push(normalized);
      }
      continue;
    }

    if (/^(key\s+)?(gotchas?|risks?|weakness(?:es)?|improvements?|deviations?|follow[- ]ups?):/i.test(line)) {
      const normalized = bulletify(line.replace(/^[^:]+:\s*/, ''));
      if (normalized) {
        notes.push(normalized);
      }
    }
  }

  return uniqueStrings(notes);
}

function collectLoopFindings(state) {
  const findings = [];

  for (const entry of ensureArray(state?.history)) {
    const planId = entry?.plan_id || 'unknown-plan';

    for (const check of ensureArray(entry?.preflight?.checks).filter((item) => item && item.pass === false)) {
      if (check.type === 'workspace_dirty') {
        findings.push({
          type: 'preflight',
          subtype: 'workspace_dirty',
          plan_id: planId,
          message: `${planId}: workspace dirty preflight failed`,
        });
      } else if (check.type === 'tool') {
        findings.push({
          type: 'preflight',
          subtype: 'tool',
          plan_id: planId,
          tool: check.tool,
          message: `${planId}: missing required tool ${check.tool}`,
        });
      } else if (check.type === 'env') {
        findings.push({
          type: 'preflight',
          subtype: 'env',
          plan_id: planId,
          env_var: check.env_var,
          message: `${planId}: missing required env var ${check.env_var}`,
        });
      }
    }

    for (const command of ensureArray(entry?.verify_commands).filter((item) => item && item.pass === false)) {
      findings.push({
        type: 'verify',
        plan_id: planId,
        command_id: command.id,
        message: `${planId}: verify command ${command.id} failed`,
      });
    }

    for (const failure of ensureArray(entry?.failures).filter((value) => {
      return !String(value).startsWith('preflight.')
        && !String(value).startsWith('verify.')
        && !String(value).startsWith('ac.')
        && !String(value).startsWith('postflight.');
    })) {
      findings.push({
        type: 'failure',
        plan_id: planId,
        message: `${planId}: ${failure}`,
      });
    }

    for (const violation of ensureArray(entry?.scope?.violations)) {
      findings.push({
        type: 'scope',
        plan_id: planId,
        message: `${planId}: scope violation on ${violation.file} (${violation.reason})`,
      });
    }

    for (const ac of ensureArray(entry?.acceptance).filter((item) => item && item.pass === false)) {
      findings.push({
        type: 'acceptance',
        plan_id: planId,
        acceptance_id: ac.id,
        message: `${planId}: acceptance gap ${ac.id}`,
      });
    }

    for (const command of ensureArray(entry?.postflight).filter((item) => item && item.pass === false)) {
      findings.push({
        type: 'postflight',
        plan_id: planId,
        command_id: command.id,
        message: `${planId}: postflight command ${command.id} failed`,
      });
    }

    for (const finding of ensureArray(entry?.review?.findings)) {
      if (finding?.id === 'baseline-dirty-worktree') {
        continue;
      }
      findings.push({
        type: 'review',
        plan_id: planId,
        review_id: finding?.id || null,
        severity: finding?.severity || null,
        message: `${planId}: review concern ${finding.id}`,
      });
    }
  }

  for (const plan of ensureArray(state?.workflow?.plans).filter((item) => item?.contract_changed)) {
    findings.push({
      type: 'contract_change',
      plan_id: plan.plan_id,
      message: `${plan.plan_id}: completed plan contract changed and had to be rerun`,
    });
  }

  for (const blocker of getDependencyBlockers(state?.project || '', ensureArray(state?.workflow?.plans))) {
    const unmet = blocker.unmet_dependencies
      .map((dependency) => `${dependency.plan_id} (${dependency.status})`)
      .join(', ');
    findings.push({
      type: 'dependency',
      plan_id: blocker.plan_id,
      message: `${blocker.plan_id}: dependency blocker remained (${unmet})`,
    });
  }

  return findings;
}

function deriveImprovementCandidates(planningNotes, loopFindings) {
  const candidates = [];

  for (const note of planningNotes) {
    candidates.push(`Planning note: ${note}`);
  }

  for (const finding of loopFindings) {
    if (finding.type === 'preflight' && finding.subtype === 'workspace_dirty') {
      candidates.push('Dirty-worktree handling is brittle. Add better guidance or a narrower delta mode for safe continuation.');
    } else if (finding.type === 'preflight' && finding.subtype === 'tool') {
      candidates.push(`Preflight for ${finding.plan_id} failed on required tool ${finding.tool}. Tighten tool prerequisites or surface setup steps earlier.`);
    } else if (finding.type === 'preflight' && finding.subtype === 'env') {
      candidates.push(`Preflight for ${finding.plan_id} failed on required env var ${finding.env_var}. Tighten setup guidance or surface those requirements earlier.`);
    } else if (finding.type === 'verify') {
      candidates.push(`Verification for ${finding.plan_id} failed. Review whether the plan’s verify commands are too brittle or missing setup guidance.`);
    } else if (finding.type === 'scope') {
      candidates.push(`Write-scope enforcement tripped for ${finding.plan_id}. Review whether allowed/blocked file scoping is too loose or too hard to author correctly.`);
    } else if (finding.type === 'acceptance') {
      candidates.push(`Acceptance gaps remained in ${finding.plan_id}. Improve how the orchestrator surfaces unresolved ACs before scope completion.`);
    } else if (finding.type === 'postflight') {
      candidates.push(`Postflight checks for ${finding.plan_id} failed. Review whether follow-up commands should be first-class lifecycle hooks.`);
    } else if (finding.type === 'review' && finding.severity !== 'low') {
      candidates.push(`Review concerns were raised for ${finding.plan_id}. Tighten anti-pattern guidance or add stronger plan-level evidence for the flagged area.`);
    } else if (finding.type === 'contract_change') {
      candidates.push(`Completed-plan drift was detected for ${finding.plan_id}. Improve plan stability checks or make contract deltas more visible earlier.`);
    } else if (finding.type === 'dependency') {
      candidates.push(`Dependency blockers remained for ${finding.plan_id}. Improve dependency visibility and unblock guidance in the orchestrator.`);
    } else if (finding.type === 'failure') {
      candidates.push(`Failure surfaced for ${finding.plan_id} outside the structured loop categories. Tighten failure typing so advice stops depending on message text.`);
    }
  }

  return uniqueStrings(candidates);
}

function deriveFrameworkFrictionCandidates(loopFindings) {
  const candidates = [];

  for (const finding of loopFindings) {
    if (finding.type === 'preflight' && finding.subtype === 'workspace_dirty') {
      candidates.push('Dirty-worktree handling is brittle. Add better guidance or a narrower delta mode for safe continuation.');
    } else if (finding.type === 'preflight' && finding.subtype === 'tool') {
      candidates.push(`Preflight for ${finding.plan_id} failed on required tool ${finding.tool}. Tighten tool prerequisites or surface setup steps earlier.`);
    } else if (finding.type === 'preflight' && finding.subtype === 'env') {
      candidates.push(`Preflight for ${finding.plan_id} failed on required env var ${finding.env_var}. Tighten setup guidance or surface those requirements earlier.`);
    } else if (finding.type === 'verify') {
      candidates.push(`Verification for ${finding.plan_id} failed. Review whether the plan’s verify commands are too brittle or missing setup guidance.`);
    } else if (finding.type === 'scope') {
      candidates.push(`Write-scope enforcement tripped for ${finding.plan_id}. Review whether allowed/blocked file scoping is too loose or too hard to author correctly.`);
    } else if (finding.type === 'acceptance') {
      candidates.push(`Acceptance gaps remained in ${finding.plan_id}. Improve how the orchestrator surfaces unresolved ACs before scope completion.`);
    } else if (finding.type === 'postflight') {
      candidates.push(`Postflight checks for ${finding.plan_id} failed. Review whether follow-up commands should be first-class lifecycle hooks.`);
    } else if (finding.type === 'review' && finding.severity !== 'low') {
      candidates.push(`Review concerns were raised for ${finding.plan_id}. Tighten anti-pattern guidance or add stronger plan-level evidence for the flagged area.`);
    } else if (finding.type === 'contract_change') {
      candidates.push(`Completed-plan drift was detected for ${finding.plan_id}. Improve plan stability checks or make contract deltas more visible earlier.`);
    } else if (finding.type === 'dependency') {
      candidates.push(`Dependency blockers remained for ${finding.plan_id}. Improve dependency visibility and unblock guidance in the orchestrator.`);
    } else if (finding.type === 'failure') {
      candidates.push(`Failure surfaced for ${finding.plan_id} outside the structured loop categories. Tighten failure typing so advice stops depending on message text.`);
    }
  }

  return uniqueStrings(candidates);
}

function extractLegacyOperatorNotes(existingMarkdown) {
  const match = String(existingMarkdown || '').match(/^## Operator Notes\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/m);
  return match ? match[1].trim() : '';
}

function readPreservedOperatorNotes(notesPath) {
  if (!notesPath || !fs.existsSync(notesPath)) {
    return '';
  }

  const existingMarkdown = fs.readFileSync(notesPath, 'utf8');
  const preservePattern = new RegExp(
    `${escapeRegex(OPERATOR_NOTES_START)}\\s*\\n?([\\s\\S]*?)\\n?\\s*${escapeRegex(OPERATOR_NOTES_END)}`,
    'm',
  );
  const preserved = existingMarkdown.match(preservePattern)?.[1]?.trim() || '';
  if (preserved) {
    return preserved;
  }

  const legacyNotes = extractLegacyOperatorNotes(existingMarkdown);
  const legacyPrompt = DEFAULT_OPERATOR_NOTES_PROMPT.replace(/^- /, '');
  return legacyNotes && legacyNotes !== legacyPrompt ? legacyNotes : '';
}

function durableFeedbackSectionStart(project) {
  return `<!-- SMIKE:PROJECT:${project}:START -->`;
}

function durableFeedbackSectionEnd(project) {
  return `<!-- SMIKE:PROJECT:${project}:END -->`;
}

function durableFeedbackNotesStart(project) {
  return `<!-- SMIKE:PROJECT:${project}:OPERATOR-NOTES:START -->`;
}

function durableFeedbackNotesEnd(project) {
  return `<!-- SMIKE:PROJECT:${project}:OPERATOR-NOTES:END -->`;
}

function readPreservedDurableFeedbackNotes(feedbackPath, project) {
  if (!feedbackPath || !fs.existsSync(feedbackPath)) {
    return '';
  }

  const existingMarkdown = fs.readFileSync(feedbackPath, 'utf8');
  const preservePattern = new RegExp(
    `${escapeRegex(durableFeedbackNotesStart(project))}\\s*\\n?([\\s\\S]*?)\\n?\\s*${escapeRegex(durableFeedbackNotesEnd(project))}`,
    'm',
  );
  return existingMarkdown.match(preservePattern)?.[1]?.trim() || '';
}

function isEphemeralFeedbackProject(project, rootPlan) {
  const normalizedProject = String(project || '').trim();
  const normalizedSpec = normalizeRel(rootPlan?.spec || '');
  if (normalizedSpec.startsWith('.smike-test-tmp/')) {
    return true;
  }

  if (!normalizedProject) {
    return false;
  }

  if (!normalizedSpec && /^(smike-|manual-)/.test(normalizedProject)) {
    return true;
  }

  return /^(?:smike-(?:search|project-selector(?:-prefix)?|review-(?:heuristics|source)|cross-(?:blocked|complete)|executor-dep-cap|nested-test-guard|planning-lint|legacy-recommended-only|start-resume|stale-resume|walk-excludes|phase-metadata|explicit-deps|lock-stale|restore|archive|gc|fixer-route|manual-guard-debug)|manual-(?:missing-shape|legacy-recommended)-)/.test(normalizedProject);
}

function resolveDurableFeedbackPhase(project, state) {
  const lifecycleStatus = state?.lifecycle?.status || null;
  const planningStatus = state?.planning?.status || null;
  const pauseReason = state?.workflow?.pause_reason || null;
  const history = ensureArray(state?.history);
  const latest = history.at(-1) || null;
  const planningRootPlanId = `${project}-plan`;
  const onlyPlanningHistory = history.length > 0 && history.every((entry) => entry?.plan_id === planningRootPlanId);
  const planningBoundaryComplete =
    planningStatus === 'complete'
    && (
      onlyPlanningHistory
      || lifecycleStatus === 'ready'
      || lifecycleStatus === AWAITING_FRESH_SESSION_LIFECYCLE_STATUS
      || pauseReason === FRESH_SESSION_FOR_IMPLEMENTATION_PAUSE_REASON
    );

  if (SMIKE_FEEDBACK_SYNC_MODE === 'planning_complete') {
    if (!planningBoundaryComplete) {
      return null;
    }
    return {
      phase: 'planning',
      key: [
        'planning',
        planningStatus,
        state?.planning?.last_plan_hash || '',
        state?.planning?.completed_at || state?.lifecycle?.last_completed_at || latest?.completed_at || '',
      ].join(':'),
    };
  }

  if (lifecycleStatus === 'planning_blocked' || planningStatus === 'blocked') {
    return {
      phase: 'planning',
      key: [
        'planning',
        planningStatus || lifecycleStatus || 'blocked',
        state?.planning?.last_plan_hash || '',
        state?.lifecycle?.last_completed_at || latest?.completed_at || '',
      ].join(':'),
    };
  }

  if (isPlanningDraftLifecycleStatus(lifecycleStatus) || planningStatus === 'draft') {
    return {
      phase: 'planning',
      key: [
        'planning',
        'draft',
        state?.planning?.last_plan_hash || '',
        state?.updated_at || '',
      ].join(':'),
    };
  }

  if (planningBoundaryComplete) {
    return {
      phase: 'planning',
      key: [
        'planning',
        planningStatus,
        state?.planning?.last_plan_hash || '',
        state?.planning?.completed_at || state?.lifecycle?.last_completed_at || latest?.completed_at || '',
      ].join(':'),
    };
  }

  if (planningStatus === 'complete' && ['complete', 'failed', 'blocked'].includes(lifecycleStatus) && latest && !onlyPlanningHistory) {
    return {
      phase: 'execution',
      key: [
        'execution',
        lifecycleStatus,
        state?.lifecycle?.last_result || latest?.result || '',
        state?.lifecycle?.last_completed_at || latest?.completed_at || '',
        String(ensureArray(state?.history).length),
      ].join(':'),
    };
  }

  return null;
}

function buildDurableFeedbackSection(project, rootPlan, state, planningNotes, loopFindings, frameworkCandidates, operatorNotes = '') {
  const latest = ensureArray(state.history).at(-1) || null;
  const notes = planningNotes.slice(0, 8);
  const findings = loopFindings.map((finding) => finding.message).slice(0, 8);
  const improvements = frameworkCandidates.slice(0, 8);
  const lines = [
    `## ${project}`,
    '',
    `- Updated: ${nowIso()}`,
    `- Spec: ${rootPlan.spec || '(none)'}`,
    `- Lifecycle: ${state.lifecycle?.status || 'unknown'}`,
    `- Last result: ${state.lifecycle?.last_result || 'unknown'}`,
    `- Last completed: ${state.lifecycle?.last_completed_at || latest?.completed_at || 'unknown'}`,
    `- Next action: ${state.lifecycle?.next_action || 'none'}`,
    `- Next command: ${getLifecycleNextCommand(state) || 'none'}`,
    '',
    '### Project Findings',
    ...(notes.length > 0 ? notes.map((note) => `- ${note}`) : ['- none']),
    '',
    '### Framework Friction',
    ...(improvements.length > 0 ? improvements.map((candidate) => `- ${candidate}`) : ['- none']),
    '',
    '### Signals From Latest Run',
    ...(findings.length > 0 ? findings.map((finding) => `- ${finding}`) : ['- none']),
    '',
    '### Operator Notes',
    'Anything inside the preserve block below survives regeneration for this project.',
    durableFeedbackNotesStart(project),
    operatorNotes || DEFAULT_FEEDBACK_NOTES_PROMPT,
    durableFeedbackNotesEnd(project),
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function syncDurableFeedbackMemory(project, rootPlan, state, planningNotes, loopFindings, frameworkCandidates) {
  if (isEphemeralFeedbackProject(project, rootPlan)) {
    return;
  }

  const phaseRecord = resolveDurableFeedbackPhase(project, state);
  if (!phaseRecord) {
    return;
  }

  const feedbackSyncState = state.feedback_sync && typeof state.feedback_sync === 'object' && !Array.isArray(state.feedback_sync)
    ? state.feedback_sync
    : {};
  const syncKeyField = phaseRecord.phase === 'planning' ? 'planning_key' : 'execution_key';
  if (feedbackSyncState[syncKeyField] === phaseRecord.key) {
    return;
  }

  ensureDir(path.dirname(SMIKE_FEEDBACK_PATH));
  const preservedNotes = readPreservedDurableFeedbackNotes(SMIKE_FEEDBACK_PATH, project);
  const sectionBody = buildDurableFeedbackSection(
    project,
    rootPlan,
    state,
    planningNotes,
    loopFindings,
    frameworkCandidates,
    preservedNotes,
  ).trimEnd();
  const startMarker = durableFeedbackSectionStart(project);
  const endMarker = durableFeedbackSectionEnd(project);
  const renderedSection = `${startMarker}\n${sectionBody}\n${endMarker}`;
  const header = [
    '# SMIKE Feedback Log',
    '',
    'Durable workflow feedback captured from terminal SMIKE runs. Project sections are regenerated; operator-note preserve blocks survive updates.',
    '',
  ].join('\n');

  const existingMarkdown = fs.existsSync(SMIKE_FEEDBACK_PATH)
    ? fs.readFileSync(SMIKE_FEEDBACK_PATH, 'utf8')
    : header;
  const sectionPattern = new RegExp(
    `${escapeRegex(startMarker)}\\n?[\\s\\S]*?\\n?${escapeRegex(endMarker)}\\n*`,
    'm',
  );
  const updatedMarkdown = sectionPattern.test(existingMarkdown)
    ? existingMarkdown.replace(sectionPattern, `${renderedSection}\n\n`)
    : `${existingMarkdown.trimEnd()}\n\n${renderedSection}\n`;

  fs.writeFileSync(SMIKE_FEEDBACK_PATH, updatedMarkdown, 'utf8');
  state.feedback_sync = {
    ...feedbackSyncState,
    [syncKeyField]: phaseRecord.key,
    [`${phaseRecord.phase}_synced_at`]: nowIso(),
    last_phase: phaseRecord.phase,
    last_key: phaseRecord.key,
  };
}

function buildImprovementNotes(project, rootPlan, state, planningNotes, loopFindings, candidates, operatorNotes = '') {
  const lines = [];
  const workflowComplete = state.lifecycle?.status === 'complete';
  const latest = ensureArray(state.history).at(-1) || null;

  lines.push('# SMIKE Notes');
  lines.push('');
  lines.push(`- Project: ${project}`);
  lines.push(`- Generated: ${nowIso()}`);
  lines.push(`- Root plan: ${rootPlan.plan_id}`);
  lines.push(`- Lifecycle: ${state.lifecycle?.status || 'unknown'}`);
  lines.push(`- Scope complete: ${workflowComplete ? 'yes' : 'no'}`);
  if (latest?.completed_at) {
    lines.push(`- Last cycle completed: ${latest.completed_at}`);
  }
  lines.push('');

  lines.push('## Planning Phase Notes');
  if (planningNotes.length === 0) {
    lines.push('- none detected automatically');
  } else {
    for (const note of planningNotes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push('');

  lines.push('## Loop Findings');
  if (loopFindings.length === 0) {
    lines.push('- none detected automatically');
  } else {
    for (const finding of uniqueStrings(loopFindings.map((item) => item.message))) {
      lines.push(`- ${finding}`);
    }
  }
  lines.push('');

  lines.push('## Improvement Candidates');
  if (candidates.length === 0) {
    lines.push('- none detected automatically');
  } else {
    for (const candidate of candidates) {
      lines.push(`- ${candidate}`);
    }
  }
  lines.push('');

  lines.push('## Operator Notes');
  lines.push('Anything inside the preserve block below survives SMIKE regeneration.');
  lines.push(OPERATOR_NOTES_START);
  lines.push(operatorNotes || DEFAULT_OPERATOR_NOTES_PROMPT);
  lines.push(OPERATOR_NOTES_END);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function expectationFromSignal(expectedSignal) {
  const expectation = {
    exit_code: undefined,
    stdout_includes: [],
    stderr_includes: [],
  };

  for (const token of expectedSignal.split('&&').map((value) => value.trim()).filter(Boolean)) {
    if (token.startsWith('exit=')) {
      const rawCode = token.slice('exit='.length).trim();
      const parsed = Number(rawCode);
      if (Number.isFinite(parsed)) {
        expectation.exit_code = parsed;
      }
    } else if (token.startsWith('stdout~')) {
      expectation.stdout_includes.push(token.slice('stdout~'.length));
    } else if (token.startsWith('stderr~')) {
      expectation.stderr_includes.push(token.slice('stderr~'.length));
    }
  }

  return expectation;
}

function evaluateExpectation(result, expectation, fallbackExitCode = 0) {
  const checks = [];
  const expectedExit = expectation.exit_code ?? fallbackExitCode;
  const exitPass = result.status === expectedExit;
  checks.push({
    check: `exit=${expectedExit}`,
    pass: exitPass,
    details: `actual exit=${result.status}`,
  });

  for (const expected of expectation.stdout_includes || []) {
    checks.push({
      check: `stdout~${expected}`,
      pass: result.stdout.includes(expected),
      details: result.stdout.includes(expected) ? 'found in stdout' : 'missing from stdout',
    });
  }

  for (const expected of expectation.stderr_includes || []) {
    checks.push({
      check: `stderr~${expected}`,
      pass: result.stderr.includes(expected),
      details: result.stderr.includes(expected) ? 'found in stderr' : 'missing from stderr',
    });
  }

  return {
    pass: checks.every((item) => item.pass),
    checks,
  };
}

function runPreflight(plan, baselineDirtyPaths) {
  const dirtySample = baselineDirtyPaths.slice(0, 50);
  const preflight = {
    passed: true,
    checks: [],
  };

  preflight.checks.push({
    type: 'workspace_dirty',
    required_clean: plan.preflight.require_clean_worktree,
    dirty_count: baselineDirtyPaths.length,
    dirty_paths: dirtySample,
    dirty_paths_truncated: baselineDirtyPaths.length > dirtySample.length,
    pass: !plan.preflight.require_clean_worktree || baselineDirtyPaths.length === 0,
    message:
      !plan.preflight.require_clean_worktree || baselineDirtyPaths.length === 0
        ? 'ok'
        : 'workspace has uncommitted changes',
  });

  for (const tool of uniqueStrings(plan.preflight.required_tools || [])) {
    const check = runShellSync(`command -v ${shellEscape(tool)} >/dev/null 2>&1`, { timeoutMs: 15_000 });
    preflight.checks.push({
      type: 'tool',
      tool,
      pass: check.status === 0,
      message: check.status === 0 ? 'available' : 'missing from PATH',
    });
  }

  for (const envVar of uniqueStrings(plan.preflight.required_env_vars || [])) {
    const value = process.env[envVar];
    preflight.checks.push({
      type: 'env',
      env_var: envVar,
      pass: typeof value === 'string' && value.trim().length > 0,
      message:
        typeof value === 'string' && value.trim().length > 0
          ? 'set'
          : 'missing or empty',
    });
  }

  preflight.passed = preflight.checks.every((check) => check.pass);
  return preflight;
}

function resolveCommandCwd(projectDir, command) {
  const cwd = command.cwd ? path.resolve(projectDir, command.cwd) : REPO_ROOT;
  if (!isPathInside(REPO_ROOT, cwd)) {
    fail(`command ${command.id || command.run || '(unnamed)'} has cwd outside repository: ${cwd}`);
  }
  return cwd;
}

async function runVerifyCommands(plan, projectDir) {
  const results = [];

  for (const command of plan.verify_commands) {
    const cwd = resolveCommandCwd(projectDir, command);
    const timeoutMs = typeof command.timeout_ms === 'number' ? command.timeout_ms : 10 * 60 * 1000;
    const expectation = command.expect || {};
    const guardedRun = guardTestVerifyCommand(command.run, {
      stdoutToken: inferNestedTestGuardStdoutToken(expectation),
    });
    const runResult = await runShell(guardedRun, { cwd, timeoutMs });
    const evaluation = evaluateExpectation(runResult, expectation, 0);

    results.push({
      id: command.id,
      run: command.run,
      cwd,
      timeout_ms: timeoutMs,
      result: runResult,
      expectation,
      evaluation,
      pass: evaluation.pass,
    });
  }

  return results;
}

function evaluateAcceptance(plan, verifyResultsById) {
  const results = [];

  for (const ac of plan.acceptance_criteria) {
    const checks = [];
    const commandPasses = [];

    for (const commandId of ac.command_ids) {
      const commandResult = verifyResultsById.get(commandId);
      const pass = Boolean(commandResult && commandResult.pass);
      commandPasses.push(pass);
      checks.push({
        type: 'command_pass',
        command_id: commandId,
        pass,
        details: pass ? 'command passed expectation checks' : 'command failed or missing',
      });
    }

    for (const signal of ac.signals) {
      const commandResult = verifyResultsById.get(signal.command_id);
      if (!commandResult) {
        checks.push({
          type: 'signal',
          command_id: signal.command_id,
          expected_signal: signal.expected_signal,
          pass: false,
          details: 'referenced command result is missing',
        });
        continue;
      }

      const expectation = expectationFromSignal(signal.expected_signal);
      const evaluated = evaluateExpectation(commandResult.result, expectation, 0);
      checks.push({
        type: 'signal',
        command_id: signal.command_id,
        expected_signal: signal.expected_signal,
        pass: evaluated.pass,
        details: evaluated.checks.map((item) => `${item.check}: ${item.pass ? 'PASS' : 'FAIL'}`).join('; '),
      });
    }

    const pass = checks.every((check) => check.pass) && commandPasses.every(Boolean);
    results.push({
      id: ac.id,
      description: ac.description,
      pass,
      checks,
      command_ids: ac.command_ids,
    });
  }

  return results;
}

function enforceWriteScope(plan, baselineDirty, modeRequireClean) {
  const afterDirty = getDirtyPaths();
  const observed = [...afterDirty].sort();

  const changedPaths = modeRequireClean
    ? observed
    : observed.filter((filePath) => !baselineDirty.has(filePath));

  const allowedGlobs = uniqueStrings([
    ...ensureArray(plan.allowed_files),
    ...ensureArray(plan.write_scope?.allowed_files),
  ]);
  const blockedGlobs = uniqueStrings([
    ...ensureArray(plan.blocked_files),
    ...ensureArray(plan.write_scope?.blocked_files),
  ]);

  const violations = [];
  for (const filePath of changedPaths) {
    const blocked = matchesAnyGlob(filePath, blockedGlobs);
    const allowed = matchesAnyGlob(filePath, allowedGlobs);

    if (blocked) {
      violations.push({
        file: filePath,
        reason: 'matched blocked_files',
      });
      continue;
    }

    if (!allowed) {
      violations.push({
        file: filePath,
        reason: 'outside allowed_files',
      });
    }
  }

  return {
    mode: modeRequireClean ? 'workspace' : 'delta',
    changed_paths: changedPaths,
    allowed_globs: allowedGlobs,
    blocked_globs: blockedGlobs,
    pass: violations.length === 0,
    violations,
  };
}

async function runPostflight(plan, projectDir) {
  const results = [];

  for (const command of ensureArray(plan.postflight.commands)) {
    if (!command || typeof command !== 'object') {
      results.push({
        id: '(invalid)',
        pass: false,
        reason: 'postflight command must be an object',
      });
      continue;
    }

    const id = command.id || command.run || '(unnamed-postflight-command)';
    const cwd = resolveCommandCwd(projectDir, command);
    const timeoutMs = typeof command.timeout_ms === 'number' ? command.timeout_ms : 10 * 60 * 1000;
    const expectation = command.expect || {};
    const guardedRun = guardTestVerifyCommand(command.run, {
      stdoutToken: inferNestedTestGuardStdoutToken(expectation),
    });
    const runResult = await runShell(guardedRun, { cwd, timeoutMs });
    const evaluation = evaluateExpectation(runResult, expectation, 0);
    results.push({
      id,
      run: command.run,
      cwd,
      result: runResult,
      expectation,
      evaluation,
      pass: evaluation.pass,
    });
  }

  return results;
}

function getQualityGateConfig(plan) {
  const qualityGates =
    plan?.quality_gates && typeof plan.quality_gates === 'object' && !Array.isArray(plan.quality_gates)
      ? plan.quality_gates
      : {};
  const judge =
    qualityGates.judge && typeof qualityGates.judge === 'object' && !Array.isArray(qualityGates.judge)
      ? qualityGates.judge
      : {};
  const review =
    qualityGates.review && typeof qualityGates.review === 'object' && !Array.isArray(qualityGates.review)
      ? qualityGates.review
      : {};

  return {
    judge: {
      rerun_verify: judge.rerun_verify !== false,
    },
    review: {
      focus_areas: normalizeStringArray(review.focus_areas || []),
      anti_patterns: normalizeStringArray(
        review.anti_patterns && review.anti_patterns.length > 0
          ? review.anti_patterns
          : DEFAULT_REVIEW_ANTI_PATTERNS,
      ),
    },
  };
}

function summarizeExpectation(expectation = {}) {
  const tokens = [];
  if (typeof expectation.exit_code === 'number') {
    tokens.push(`exit=${expectation.exit_code}`);
  }
  for (const value of ensureArray(expectation.stdout_includes)) {
    tokens.push(`stdout~${value}`);
  }
  for (const value of ensureArray(expectation.stderr_includes)) {
    tokens.push(`stderr~${value}`);
  }
  return tokens.length > 0 ? tokens.join(' && ') : '(no explicit expectation)';
}

function summarizeSignals(signals = []) {
  const values = ensureArray(signals)
    .map((signal) => signal?.expected_signal)
    .filter((value) => typeof value === 'string' && value.trim());
  return values.length > 0 ? values.join(' | ') : '(no signals)';
}

async function buildVerdictRecord(contract, cycleRecord, projectDir) {
  const qualityConfig = getQualityGateConfig(contract.plan);
  const rerunResults = qualityConfig.judge.rerun_verify
    ? await runVerifyCommands(contract.plan, projectDir)
    : [];
  const rerunMap = new Map(rerunResults.map((result) => [result.id, result]));
  const acceptance = qualityConfig.judge.rerun_verify
    ? evaluateAcceptance(contract.plan, rerunMap)
    : cycleRecord.acceptance;

  const failures = [];
  if (qualityConfig.judge.rerun_verify) {
    for (const result of rerunResults) {
      if (!result.pass) {
        failures.push(`verify.${result.id}`);
      }
    }
  }
  for (const result of acceptance) {
    if (!result.pass) {
      failures.push(`ac.${result.id}`);
    }
  }
  if (!cycleRecord.scope.pass) {
    failures.push('scope.enforcement');
  }

  return {
    generated_at: nowIso(),
    reran_verify: qualityConfig.judge.rerun_verify,
    result: failures.length === 0 ? 'pass' : 'fail',
    failures,
    verify_commands: (qualityConfig.judge.rerun_verify ? rerunResults : []).map((item) => ({
      id: item.id,
      run: item.run,
      cwd: path.relative(REPO_ROOT, item.cwd),
      status: item.result.status,
      pass: item.pass,
      duration_ms: item.result.durationMs,
      stdout_tail: item.result.stdout.slice(-500),
      stderr_tail: item.result.stderr.slice(-500),
    })),
    acceptance,
    scope: cycleRecord.scope,
  };
}

function acUsesOnlyExitSignals(ac, commandsById) {
  const signals = ensureArray(ac?.signals);
  if (signals.length === 0) {
    return false;
  }

  for (const signal of signals) {
    const parsed = expectationFromSignal(signal.expected_signal || '');
    const hasBehavioralSignal =
      ensureArray(parsed.stdout_includes).length > 0 || ensureArray(parsed.stderr_includes).length > 0;
    if (hasBehavioralSignal) {
      return false;
    }

    const command = commandsById.get(signal.command_id);
    const commandExpectation = command?.expect || {};
    if (
      ensureArray(commandExpectation.stdout_includes).length > 0 ||
      ensureArray(commandExpectation.stderr_includes).length > 0
    ) {
      return false;
    }
  }

  return true;
}

function getWorkspaceDirtyCheck(preflight) {
  return ensureArray(preflight?.checks).find((check) => check?.type === 'workspace_dirty') || null;
}

function isLikelyTestPath(filePath) {
  return /(^|\/)(tests?|__tests__)\/|(?:\.test|\.spec)\.[^/]+$/i.test(filePath);
}

function isLikelySourcePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.startsWith('.smike/')) {
    return false;
  }
  return /\.(?:[cm]?[jt]sx?|mjs|cjs|mts|cts|swift|py|sql)$/i.test(filePath);
}

function isLikelyInterfaceSurfacePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.startsWith('.smike/')) {
    return false;
  }
  return (
    /(^|\/)(index|types)\.[^/]+$/i.test(filePath)
    || /\.d\.ts$/i.test(filePath)
    || /(^|\/)package\.json$/i.test(filePath)
    || /(^|\/)(api|types)\//i.test(filePath)
    || /(^|\/)schema\.sql$/i.test(filePath)
  );
}

function looksLikeVerificationCoverageCommand(command) {
  const haystack = `${command?.id || ''} ${command?.run || ''}`;
  return /\b(test|vitest|jest|mocha|ava|tap|typecheck|tsc|build)\b/i.test(haystack);
}

const buildReviewRecord = createBuildReviewRecord({
  getQualityGateConfig,
  ensureArray,
  acUsesOnlyExitSignals,
  isLikelySourcePath,
  isLikelyInterfaceSurfacePath,
  isLikelyTestPath,
  getWorkspaceDirtyCheck,
  looksLikeVerificationCoverageCommand,
  nowIso,
});

const buildPlanningCheckerRecord = createBuildPlanningCheckerRecord({
  nowIso,
});

const buildPlanningAuditorRecord = createBuildPlanningAuditorRecord({
  nowIso,
});

function buildVerdictReport(project, cycleRecord, verdictRecord) {
  const lines = [
    `# VERDICT — ${project}`,
    '',
    `- Generated: ${verdictRecord.generated_at}`,
    `- Plan: ${cycleRecord.plan_id}`,
    `- Result: ${verdictRecord.result.toUpperCase()}`,
    `- Fresh verify rerun: ${verdictRecord.reran_verify ? 'yes' : 'no'}`,
    '',
    '## Verification Commands',
  ];

  if (verdictRecord.verify_commands.length === 0) {
    lines.push('- No fresh verify commands were rerun.');
  } else {
    lines.push('| ID | Result | Exit | Command |');
    lines.push('|---|---|---:|---|');
    for (const command of verdictRecord.verify_commands) {
      lines.push(`| ${command.id} | ${command.pass ? 'PASS' : 'FAIL'} | ${command.status} | \`${command.run}\` |`);
    }
  }

  lines.push('');
  lines.push('## Acceptance Criteria');
  lines.push('| AC | Result | Signals |');
  lines.push('|---|---|---|');
  for (const ac of verdictRecord.acceptance) {
    const signalSummary = summarizeSignals(
      ac.checks
        .filter((check) => check.type === 'signal')
        .map((check) => ({ expected_signal: check.expected_signal })),
    );
    lines.push(`| ${ac.id} | ${ac.pass ? 'PASS' : 'FAIL'} | ${signalSummary} |`);
  }

  lines.push('');
  lines.push('## Scope Check');
  lines.push(`- Scope pass: ${verdictRecord.scope.pass ? 'yes' : 'no'}`);
  lines.push(`- Changed files: ${verdictRecord.scope.changed_paths.length === 0 ? 'none' : verdictRecord.scope.changed_paths.join(', ')}`);
  lines.push(`- Violations: ${verdictRecord.scope.violations.length === 0 ? 'none' : verdictRecord.scope.violations.map((item) => `${item.file} (${item.reason})`).join(', ')}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push(verdictRecord.failures.length === 0 ? '- PASS' : `- FAIL: ${verdictRecord.failures.join(', ')}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function buildReviewReport(project, cycleRecord, reviewRecord, plan) {
  const lines = [
    `# REVIEW — ${project}`,
    '',
    `- Generated: ${reviewRecord.generated_at}`,
    `- Plan: ${cycleRecord.plan_id}`,
    `- Result: ${reviewRecord.result.toUpperCase()}`,
    `- Drift detected: ${reviewRecord.drift.toUpperCase()}`,
    '',
    '## Findings',
  ];

  if (reviewRecord.findings.length === 0) {
    lines.push('- None.');
  } else {
    for (const finding of reviewRecord.findings) {
      lines.push(`- ${finding.severity.toUpperCase()} ${finding.id}: ${finding.title} — ${finding.details}`);
    }
  }

  lines.push('');
  lines.push('## Focus Areas');
  if (reviewRecord.focus_areas.length === 0) {
    lines.push(`- Default posture only. Objective: ${plan.objective}`);
  } else {
    for (const focus of reviewRecord.focus_areas) {
      lines.push(`- ${focus}`);
    }
  }

  lines.push('');
  lines.push('## Anti-Pattern Watch');
  for (const antiPattern of reviewRecord.anti_patterns) {
    lines.push(`- ${antiPattern}`);
  }

  lines.push('');
  lines.push('## Change Surface');
  lines.push(`- Changed files: ${reviewRecord.changed_paths.length === 0 ? 'none' : reviewRecord.changed_paths.join(', ')}`);
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function parseMarkdownBulletSection(filePath, heading) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const escapedHeading = escapeRegex(String(heading || '').trim());
  if (!escapedHeading) {
    return [];
  }
  const match = text.match(new RegExp(`^## ${escapedHeading}\\r?\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm'));
  if (!match) {
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, '').trim())
    .filter(Boolean);
}

function loadPlanningAnalysis(paths) {
  const checker = readOptionalJson(paths.planningCheckerJsonPath);
  const auditor = readOptionalJson(paths.planningAuditorJsonPath) || readOptionalJson(paths.planningAuditJsonPath);
  const normalizeFindings = (report, source) => ensureArray(report?.findings).map((finding) => ({
    source,
    id: finding?.id || `${source}-unknown`,
    severity: finding?.severity || 'low',
    title: finding?.title || 'Unknown planning finding',
    details: finding?.details || '',
  }));
  const findings = [
    ...normalizeFindings(checker, 'checker'),
    ...normalizeFindings(auditor, 'auditor'),
  ];
  const blockingFindings = findings.filter((finding) => finding.severity !== 'low');

  return {
    checker,
    auditor,
    findings,
    blocking_findings: blockingFindings,
  };
}

function getExistingMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function getPlanningPhasePlanPaths(paths, bundle = null) {
  if (bundle && Array.isArray(bundle.phase_blueprints)) {
    return bundle.phase_blueprints
      .map((phase) => path.join(paths.projectDir, 'phases', phase.id, `${phase.id}-PLAN.json`))
      .filter((filePath) => fs.existsSync(filePath));
  }

  const phasesDir = path.join(paths.projectDir, 'phases');
  if (!fs.existsSync(phasesDir)) {
    return [];
  }

  return walkRelativeFiles(phasesDir)
    .filter((relativePath) => /-PLAN\.json$/.test(relativePath))
    .map((relativePath) => path.join(phasesDir, relativePath))
    .filter((filePath) => fs.existsSync(filePath));
}

function getPlanningSourceArtifactPaths(paths, bundle = null) {
  return [
    paths.planJsonPath,
    paths.planMdPath,
    paths.strategyPath,
    paths.roadmapPath,
    ...getPlanningPhasePlanPaths(paths, bundle),
  ].filter((filePath) => fs.existsSync(filePath));
}

function getPlanningVerificationArtifactPaths(paths) {
  return [
    paths.planningCheckerJsonPath,
    paths.planningAuditorJsonPath,
    paths.verdictReportPath,
    paths.reviewReportPath,
  ].filter((filePath) => fs.existsSync(filePath));
}

function getPlanningArtifactFreshness(paths, bundle = null) {
  const sourcePaths = getPlanningSourceArtifactPaths(paths, bundle);
  const verificationPaths = getPlanningVerificationArtifactPaths(paths);
  if (sourcePaths.length === 0) {
    return {
      stale: false,
      reason: null,
      source_paths: [],
      verification_paths: verificationPaths.map((filePath) => path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')),
      stale_outputs: [],
    };
  }

  const latestSource = sourcePaths
    .map((filePath) => ({ filePath, mtimeMs: getExistingMtimeMs(filePath) || 0 }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

  if (verificationPaths.length === 0) {
    return {
      stale: true,
      reason: 'planning verification artifacts are missing',
      source_paths: sourcePaths.map((filePath) => path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')),
      verification_paths: [],
      stale_outputs: [],
    };
  }

  const staleOutputs = verificationPaths.filter((filePath) => {
    const mtimeMs = getExistingMtimeMs(filePath);
    return typeof mtimeMs !== 'number' || mtimeMs < latestSource.mtimeMs;
  });

  return {
    stale: staleOutputs.length > 0,
    reason: staleOutputs.length > 0
      ? `planning sources changed after verification (${staleOutputs.map((filePath) => path.basename(filePath)).join(', ')})`
      : null,
    source_paths: sourcePaths.map((filePath) => path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')),
    verification_paths: verificationPaths.map((filePath) => path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')),
    stale_outputs: staleOutputs.map((filePath) => path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')),
  };
}

function buildPlanningBlockedNextAction(project, paths, planningAnalysis) {
  const findingSummary = planningAnalysis.blocking_findings
    .slice(0, 4)
    .map((finding) => `${finding.source}:${finding.id}`)
    .join(', ');
  const suffix = findingSummary ? ` Top blockers: ${findingSummary}.` : '';
  const docs = [
    planningAnalysis.checker ? `.smike/${project}/CHECKER.json` : null,
    planningAnalysis.auditor ? `.smike/${project}/AUDITOR.json` : null,
  ].filter(Boolean);
  const docText = docs.length > 0 ? docs.join(' and ') : `.smike/${project}/PLAN.md`;
  return `Resolve planning findings in ${docText}, then rerun \`${buildRecheckCommand(project)}\`.${suffix}`;
}

function buildCycleCommand(project) {
  return `./smike cycle ${project}`;
}

function buildAdvanceCommand(project = null) {
  const normalized = typeof project === 'string' ? project.trim() : '';
  return normalized ? `./smike advance ${normalized}` : './smike advance';
}

function buildRecheckCommand(project) {
  return `./smike recheck ${project}`;
}

function buildResumeCommand(project = null) {
  const normalized = typeof project === 'string' ? project.trim() : '';
  return normalized ? `./smike resume ${normalized}` : './smike resume';
}

function buildRetryDispatchCommand(project, dispatchId = '<dispatch-id>') {
  return `./smike dispatch ${project} retry ${dispatchId}`;
}

function buildCompleteDispatchGroupCommand(project, group = 'current') {
  return `./smike dispatch ${project} complete-group ${group}`;
}

function isFreshSessionImplementationPauseReason(value) {
  return typeof value === 'string' && value.trim() === FRESH_SESSION_FOR_IMPLEMENTATION_PAUSE_REASON;
}

function applyFreshSessionImplementationGate(state) {
  if (!state.workflow || typeof state.workflow !== 'object') {
    state.workflow = {};
  }
  state.workflow.auto_continue = false;
  state.workflow.pause_reason = FRESH_SESSION_FOR_IMPLEMENTATION_PAUSE_REASON;
}

function clearFreshSessionImplementationGate(state) {
  if (!isFreshSessionImplementationPauseReason(state?.workflow?.pause_reason)) {
    return false;
  }
  if (!state.workflow || typeof state.workflow !== 'object') {
    state.workflow = {};
  }
  state.workflow.auto_continue = true;
  state.workflow.pause_reason = null;
  return true;
}

function carryForwardFreshSessionImplementationGate(state, previousWorkflow) {
  if (!isFreshSessionImplementationPauseReason(previousWorkflow?.pause_reason)) {
    return false;
  }
  applyFreshSessionImplementationGate(state);
  return true;
}

function setLifecycleStopReason(state, stopReason = null) {
  if (!state.lifecycle || typeof state.lifecycle !== 'object') {
    state.lifecycle = {};
  }
  state.lifecycle.stop_reason = typeof stopReason === 'string' && stopReason.trim()
    ? stopReason.trim()
    : null;
}

function setLifecycleNextStep(state, nextAction, nextCommand = null) {
  if (!state.lifecycle || typeof state.lifecycle !== 'object') {
    state.lifecycle = {};
  }
  state.lifecycle.next_action = typeof nextAction === 'string' && nextAction.trim()
    ? nextAction
    : 'No next action recorded.';
  state.lifecycle.next_command = typeof nextCommand === 'string' && nextCommand.trim()
    ? nextCommand.trim()
    : null;
}

function getLifecycleNextCommand(state) {
  const value = state?.lifecycle?.next_command;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function runtimeDispatchPlanFilterFromActionable(actionable) {
  return Array.isArray(actionable?.plan_ids) && actionable.plan_ids.length > 0
    ? actionable.plan_ids
    : actionable?.plan_id || null;
}

function buildAwaitingRuntimeDispatchState(project, runtimeDispatchPending) {
  const pendingPlansText = describePendingRuntimePlans(runtimeDispatchPending);
  const readyIds = runtimeDispatchPending.ready_dispatches.map((entry) => entry.dispatch_id).join(', ') || 'none';
  return {
    status: 'awaiting_runtime_dispatch',
    stop_reason: 'awaiting_runtime_dispatch',
    next_action:
      `Run runtime dispatch group ${runtimeDispatchPending.group || 1} for ${pendingPlansText}: ${readyIds}. `
      + `Use \`STATE.json.lifecycle.next_command\` as authority, mark completion with \`./smike dispatch ${project} completed <dispatch-id>\`, `
      + `then rerun \`${buildAdvanceCommand(project)}\`.`,
    next_command: buildAdvanceCommand(project),
  };
}

function buildReadyRuntimeDispatchFollowOnState(project, runtimeDispatchPending) {
  const pendingPlansText = describePendingRuntimePlans(runtimeDispatchPending);
  const readyIds = runtimeDispatchPending.ready_dispatches.map((entry) => entry.dispatch_id).join(', ') || 'none';
  return {
    status: 'in_progress',
    stop_reason: null,
    next_action:
      `Run runtime dispatch group ${runtimeDispatchPending.group || 1} for ${pendingPlansText}: ${readyIds}. `
      + `Use \`STATE.json.lifecycle.next_command\` as authority, mark completion with \`./smike dispatch ${project} completed <dispatch-id>\`, `
      + 'then follow the updated `next_command`.',
    next_command: buildAdvanceCommand(project),
  };
}

function buildAwaitingFreshSessionState(project, readyWorkflowPlans, runtimeDispatchPending = null) {
  const actionableDispatchId = runtimeDispatchPending?.ready_dispatches?.[0]?.dispatch_id
    || runtimeDispatchPending?.active_dispatches?.[0]?.dispatch_id
    || runtimeDispatchPending?.failed_dispatches?.[0]?.dispatch_id
    || null;
  const actionableDispatchText = actionableDispatchId
    ? ` Current actionable dispatch: ${actionableDispatchId}.`
    : '';
  return {
    status: AWAITING_FRESH_SESSION_LIFECYCLE_STATUS,
    stop_reason: AWAITING_FRESH_SESSION_LIFECYCLE_STATUS,
    next_action:
      `Planning complete. Start a fresh session with \`${buildAdvanceCommand(project)}\` before executing implementation work.`
      + actionableDispatchText
      + ` ${describeReadyWorkflowPlans(readyWorkflowPlans)}`,
    next_command: buildAdvanceCommand(project),
  };
}

function enterAwaitingRuntimeDispatch(state, project, runtimeDispatchPending) {
  const lifecycle = buildAwaitingRuntimeDispatchState(project, runtimeDispatchPending);
  state.lifecycle.status = lifecycle.status;
  setLifecycleStopReason(state, lifecycle.stop_reason);
  setLifecycleNextStep(state, lifecycle.next_action, lifecycle.next_command);
}

function enterAwaitingFreshSession(state, project, readyWorkflowPlans, runtimeDispatchPending = null) {
  const lifecycle = buildAwaitingFreshSessionState(project, readyWorkflowPlans, runtimeDispatchPending);
  state.lifecycle.status = lifecycle.status;
  setLifecycleStopReason(state, lifecycle.stop_reason);
  setLifecycleNextStep(state, lifecycle.next_action, lifecycle.next_command);
}

function buildRuntimeDispatchPendingState(runtimeContext) {
  if (!runtimeContext) {
    return null;
  }
  if (
    runtimeContext.delegation?.mode !== 'runtime_subagents'
    || runtimeContext.delegation?.owner !== 'runtime_orchestrator'
    || runtimeContext.dispatches.length === 0
    || runtimeContext.all_dispatches_completed_fresh
  ) {
    return null;
  }
  return {
    plan_id: runtimeContext.actionable.plan_id,
    plan_ids: runtimeContext.actionable.plan_ids,
    group: currentRuntimeDispatchGroup(runtimeContext),
    ready_dispatches: runtimeContext.ready_dispatches,
    active_dispatches: runtimeContext.active_dispatches,
    failed_dispatches: runtimeContext.failed_dispatches,
  };
}

function describePendingRuntimePlans(runtimeDispatchPending) {
  return runtimeDispatchPending.plan_ids.length > 1
    ? runtimeDispatchPending.plan_ids.join(', ')
    : runtimeDispatchPending.plan_id;
}

function summarizeRuntimeDispatchContext(runtimeContext) {
  const actionablePlanIds = Array.isArray(runtimeContext?.actionable?.plan_ids) && runtimeContext.actionable.plan_ids.length > 0
    ? runtimeContext.actionable.plan_ids.join(', ')
    : 'none';
  return {
    plan_ids: actionablePlanIds,
    group: currentRuntimeDispatchGroup(runtimeContext) || 'none',
    completable_group: currentCompletableRuntimeDispatchGroup(runtimeContext),
    ready_ids: runtimeContext.ready_dispatches.map((entry) => entry.dispatch_id).join(', ') || 'none',
    active_ids: runtimeContext.active_dispatches.map((entry) => entry.dispatch_id).join(', ') || 'none',
    failed_ids: runtimeContext.failed_dispatches.map((entry) => entry.dispatch_id).join(', ') || 'none',
  };
}

function buildRuntimeDispatchSummaryLines(runtimeContext) {
  if (!runtimeContext || runtimeContext.dispatches.length === 0) {
    return [];
  }

  const summary = summarizeRuntimeDispatchContext(runtimeContext);
  const staleEntries = runtimeContext.dispatches.filter(
    (entry) => entry.status === 'stale' || entry.freshness?.status === 'stale',
  );
  return [
    `dispatch_plan_ids: ${summary.plan_ids}`,
    `dispatch_group: ${summary.group}`,
    `dispatch_completable_group: ${summary.completable_group}`,
    `dispatch_ready: ${summary.ready_ids}`,
    `dispatch_active: ${summary.active_ids}`,
    `dispatch_failed: ${summary.failed_ids}`,
    ...staleEntries.slice(0, 4).map((entry) => `dispatch_stale: ${entry.dispatch_id} (${entry.freshness?.reason || 'stale dispatch contract'})`),
  ];
}

function printDispatchFollowOn(project, state) {
  console.log(`next: ${state.lifecycle?.next_action || 'unknown'}`);
  const nextCommand = getLifecycleNextCommand(state);
  if (nextCommand) {
    console.log(`next_command: ${nextCommand}`);
  }
  if (state.lifecycle?.status === 'awaiting_runtime_dispatch') {
    console.log('runtime_requirement: host runtime must execute next_command before treating this project state as complete.');
  } else if (state.lifecycle?.status === AWAITING_FRESH_SESSION_LIFECYCLE_STATUS) {
    console.log('fresh_session_requirement: start a fresh session through next_command before executing implementation work.');
  }

  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.planJsonPath)) {
    return;
  }

  const rootPlan = readJson(paths.planJsonPath);
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  for (const line of buildRuntimeDispatchSummaryLines(runtimeContext)) {
    console.log(line);
  }
  if (runtimeContext.active_dispatches.length > 1) {
    const group = currentRuntimeDispatchGroup(runtimeContext) || 'current';
    console.log(`dispatch_completion_hint: complete state writes serially, or use \`${buildCompleteDispatchGroupCommand(project, group)}\`.`);
  }
}

function applyRuntimeDispatchPendingLifecycle(project, state, runtimeDispatchPending, options = {}) {
  if (!runtimeDispatchPending) {
    return false;
  }

  const pendingPlansText = describePendingRuntimePlans(runtimeDispatchPending);
  if (runtimeDispatchPending.ready_dispatches.length > 0) {
    if (options.readyLifecycle === 'in_progress') {
      const lifecycle = buildReadyRuntimeDispatchFollowOnState(project, runtimeDispatchPending);
      state.lifecycle.status = lifecycle.status;
      setLifecycleStopReason(state, lifecycle.stop_reason);
      setLifecycleNextStep(state, lifecycle.next_action, lifecycle.next_command);
    } else {
      enterAwaitingRuntimeDispatch(state, project, runtimeDispatchPending);
    }
    return true;
  }

  setLifecycleStopReason(state, null);
  if (runtimeDispatchPending.failed_dispatches.length > 0) {
    state.lifecycle.status = 'in_progress';
    const failedIds = runtimeDispatchPending.failed_dispatches.map((entry) => entry.dispatch_id).join(', ');
    setLifecycleNextStep(
      state,
      `Resolve failed runtime dispatches for ${pendingPlansText}: ${failedIds}. Retry them with \`${buildRetryDispatchCommand(project)}\`, then rerun \`${buildCycleCommand(project)}\`.`,
      buildRetryDispatchCommand(project, runtimeDispatchPending.failed_dispatches[0]?.dispatch_id || '<dispatch-id>'),
    );
    return true;
  }

  if (runtimeDispatchPending.active_dispatches.length > 0) {
    state.lifecycle.status = 'in_progress';
    const activeIds = runtimeDispatchPending.active_dispatches.map((entry) => entry.dispatch_id).join(', ');
    setLifecycleNextStep(
      state,
      `Wait for runtime dispatches to finish for ${pendingPlansText}: ${activeIds}. Then rerun \`${buildCycleCommand(project)}\`.`,
      buildCycleCommand(project),
    );
    return true;
  }

  return false;
}

function extractSpawnDispatchId(nextCommand) {
  const match = typeof nextCommand === 'string'
    ? nextCommand.trim().match(/^\.\/smike dispatch \S+ spawned (\S+)$/)
    : null;
  return match?.[1] || null;
}

function appendHistoryEvent(state, event) {
  state.history.push(event);
  if (state.history.length > 50) {
    state.history = state.history.slice(-50);
  }
}

function maybeRecordHandoffFailure(project, state) {
  if (state?.lifecycle?.status !== 'awaiting_runtime_dispatch') {
    return false;
  }

  const dispatchId = extractSpawnDispatchId(getLifecycleNextCommand(state))
    || state?.orchestration?.current_actionable_dispatch?.dispatch_id
    || null;
  if (!dispatchId) {
    return false;
  }

  const entry = getRuntimeDispatchEntry(state, dispatchId);
  if (!entry || (entry.status !== 'queued' && entry.status !== 'stale') || entry.last_spawned_at) {
    return false;
  }

  const lastCompletedAt = typeof state?.lifecycle?.last_completed_at === 'string'
    ? state.lifecycle.last_completed_at
    : null;
  const alreadyRecorded = [...ensureArray(state.history)]
    .reverse()
    .find((item) => item?.event === 'handoff_failure'
      && item?.dispatch_id === dispatchId
      && (!lastCompletedAt || (typeof item.at === 'string' && item.at >= lastCompletedAt)));
  if (alreadyRecorded) {
    return false;
  }

  const at = nowIso();
  appendHistoryEvent(state, {
    event: 'handoff_failure',
    at,
    dispatch_id: dispatchId,
    message: `Previous cycle queued dispatch ${dispatchId}, but runtime did not spawn it before this cycle.`,
  });
  console.warn(`WARNING: previous cycle queued dispatch ${dispatchId}, but runtime did not spawn it before this cycle.`);
  console.warn('This is a runtime handoff failure, not a planning failure. Check scripts/smike/RUNTIME_ORCHESTRATOR.md.');
  return true;
}

function collectDependencyDiscoveries(state, dependencyIds, targetPlanId = null) {
  const discoveries = [...ensureArray(state?.gotchas)];
  const target = typeof targetPlanId === 'string' && targetPlanId.trim() ? targetPlanId.trim() : null;

  if (target) {
    for (const record of ensureArray(state?.propagated_discoveries)) {
      if (!ensureArray(record?.target_plan_ids).includes(target)) {
        continue;
      }
      for (const discovery of ensureArray(record?.discoveries)) {
        discoveries.push(`refresh: ${discovery}`);
      }
    }
  }

  for (const depId of normalizeStringArray(dependencyIds)) {
    const latest = [...ensureArray(state?.history)]
      .reverse()
      .find((entry) => entry?.plan_id === depId);
    if (!latest) {
      continue;
    }

    for (const failure of ensureArray(latest.failures)) {
      discoveries.push(`${depId}: ${failure}`);
    }

    for (const finding of ensureArray(latest.review?.findings)) {
      discoveries.push(`${depId}: ${finding.severity || 'note'} ${finding.title || finding.id}`);
    }
  }

  return uniqueStrings(discoveries).slice(0, 16);
}

function summarizeWriteScopeAreas(plan = {}) {
  const allowed = uniqueStrings([
    ...ensureArray(plan?.allowed_files),
    ...ensureArray(plan?.write_scope?.allowed_files),
  ]).filter((entry) => entry && !entry.startsWith('.smike/'));

  return uniqueStrings(
    allowed.map((entry) => {
      const normalized = normalizeRel(entry).replace(/^\.\//, '');
      const parts = normalized.split('/').filter(Boolean);
      if (parts[0] === 'packages' && parts[1]) {
        return `packages/${parts[1]}`;
      }
      if (parts[0] === 'apps' && parts[1]) {
        return `apps/${parts[1]}`;
      }
      if (parts[0] === 'tests' && parts[1]) {
        return `tests/${parts[1]}`;
      }
      return parts[0] || '(root)';
    }),
  );
}

function collectAutoDelegationSignals(state, contract) {
  const plan = contract?.plan || {};
  const planId = plan?.plan_id || null;
  const writeScopeAllowed = uniqueStrings([
    ...ensureArray(plan?.allowed_files),
    ...ensureArray(plan?.write_scope?.allowed_files),
  ]).filter((entry) => entry && !entry.startsWith('.smike/'));
  const writeScopeAreas = summarizeWriteScopeAreas(plan);
  const verifyCount = ensureArray(plan?.verify_commands).length;
  const dependencyCount = normalizeStringArray(plan?.depends_on).length;
  const acceptanceCount = ensureArray(plan?.acceptance_criteria).length;
  const priorFailureCount = ensureArray(state?.history)
    .filter((entry) => entry?.plan_id === planId && entry?.result === 'fail')
    .length;
  const refreshSignals = collectPhaseRefreshSignals(state, contract);
  const signals = [];

  if (writeScopeAreas.length >= 2) {
    signals.push(`write scope spans ${writeScopeAreas.length} areas (${writeScopeAreas.join(', ')})`);
  }
  if (writeScopeAllowed.length >= 5) {
    signals.push(`write scope lists ${writeScopeAllowed.length} allowed surfaces`);
  }
  if (verifyCount >= 3) {
    signals.push(`verification surface includes ${verifyCount} commands`);
  }
  if (dependencyCount >= 2) {
    signals.push(`phase depends on ${dependencyCount} upstream phases`);
  }
  if (acceptanceCount >= 4) {
    signals.push(`acceptance contract includes ${acceptanceCount} criteria`);
  }
  if (priorFailureCount > 0) {
    signals.push(`phase has ${priorFailureCount} prior failed execution cycle${priorFailureCount === 1 ? '' : 's'}`);
  }
  if (refreshSignals.length > 0) {
    signals.push('upstream drift signals already exist for this phase');
  }

  return uniqueStrings(signals).slice(0, 12);
}

function shouldAutoPromoteDelegation(state, contract) {
  const declaredDelegation = normalizeDelegationConfig(contract?.plan);
  if (declaredDelegation.mode !== 'auto') {
    return false;
  }
  if (inferPlanStage('', contract?.plan || {}) !== 'execution') {
    return false;
  }
  return collectAutoDelegationSignals(state, contract).length >= 2;
}

function resolveExecutionDelegation(project, state, contract) {
  const declaredDelegation = normalizeDelegationConfig(contract?.plan);
  const stage = inferPlanStage(project, contract?.plan || {});
  const defaultRuntimeArtifacts = contract?.plan?.plan_id
    ? [getRuntimeExecutionResultPaths(project, contract.plan.plan_id, 'executor').jsonRel]
    : [];
  if (stage !== 'execution') {
    return declaredDelegation;
  }

  if (declaredDelegation.mode === 'auto') {
    if (!shouldAutoPromoteDelegation(state, contract)) {
      return {
        ...declaredDelegation,
        declared_mode: 'auto',
        mode: 'local_only',
        owner: 'smike_runner',
        runtime_roles: [],
        auto_promoted: false,
        auto_signals: collectAutoDelegationSignals(state, contract),
      };
    }

    return {
      ...declaredDelegation,
      declared_mode: 'auto',
      mode: 'runtime_subagents',
      owner: 'runtime_orchestrator',
      runtime_roles: defaultAutoRuntimeRoles(contract?.plan),
      result_artifacts: declaredDelegation.result_artifacts.length > 0
        ? declaredDelegation.result_artifacts
        : defaultRuntimeArtifacts,
      auto_promoted: true,
      auto_signals: collectAutoDelegationSignals(state, contract),
    };
  }

  if (declaredDelegation.mode === 'runtime_subagents' && declaredDelegation.owner === 'runtime_orchestrator') {
    return {
      ...declaredDelegation,
      result_artifacts: declaredDelegation.result_artifacts.length > 0
        ? declaredDelegation.result_artifacts
        : defaultRuntimeArtifacts,
      declared_mode: declaredDelegation.mode,
      auto_promoted: false,
      auto_signals: [],
    };
  }

  return declaredDelegation;
}

function latestRoleGeneratedAt(state, planId, role) {
  const entry = [...ensureArray(state?.orchestration?.role_history)]
    .reverse()
    .find((item) => item?.plan_id === planId && item?.role === role && typeof item?.generated_at === 'string');
  return entry?.generated_at || null;
}

function collectPhaseRefreshSignals(state, contract) {
  const planId = contract?.plan?.plan_id || null;
  const dependencyIds = normalizeStringArray(contract?.plan?.depends_on);
  const lastDetailerAt = latestRoleGeneratedAt(state, planId, 'detailer');
  const signals = [];

  if (!planId || dependencyIds.length === 0) {
    return signals;
  }

  if (!lastDetailerAt) {
    signals.push('no prior detailer capsule exists for this phase');
  }

  for (const dependencyId of dependencyIds) {
    const latestDependencyRun = [...ensureArray(state?.history)]
      .reverse()
      .find((entry) => entry?.plan_id === dependencyId && typeof entry?.completed_at === 'string');
    if (
      latestDependencyRun?.completed_at
      && (!lastDetailerAt || Date.parse(latestDependencyRun.completed_at) > Date.parse(lastDetailerAt))
    ) {
      signals.push(`${dependencyId} completed after the phase plan was last detailed`);
    }
  }

  for (const record of ensureArray(state?.propagated_discoveries)) {
    if (!ensureArray(record?.target_plan_ids).includes(planId)) {
      continue;
    }
    if (
      typeof record?.generated_at === 'string'
      && (!lastDetailerAt || Date.parse(record.generated_at) > Date.parse(lastDetailerAt))
    ) {
      for (const discovery of ensureArray(record?.discoveries)) {
        signals.push(`propagated discovery: ${discovery}`);
      }
    }
  }

  return uniqueStrings(signals).slice(0, 12);
}

function shouldAutoDetailerRefresh(state, contract) {
  const mode = normalizePhaseRefreshMode(contract?.plan);
  if (mode === 'lightweight') {
    return false;
  }

  const stage = inferPlanStage('', contract?.plan || {});
  if (stage !== 'execution') {
    return false;
  }

  const dependencyIds = normalizeStringArray(contract?.plan?.depends_on);
  if (dependencyIds.length === 0) {
    return false;
  }

  if (mode === 'always_detailer') {
    return true;
  }

  return collectPhaseRefreshSignals(state, contract).length > 0;
}

function buildRoleCapsule({
  project,
  planId,
  cycle,
  stage,
  role,
  objective,
  roleConfig,
  primaryPaths,
  additionalPaths,
  readOrder,
  questions,
  boundaries,
  outputs,
  evidence,
  contextSnapshot,
  resultArtifacts,
  artifactChangeRequired,
  nextAction,
}) {
  const normalizedResultArtifacts = normalizePathList(resultArtifacts || []);
  const completionRequirements = buildDispatchCompletionRequirements(
    normalizedResultArtifacts,
    artifactChangeRequired === true,
  );
  const expectedArtifacts = normalizeStringArray(
    outputs?.expected_artifacts && outputs.expected_artifacts.length > 0
      ? outputs.expected_artifacts
      : normalizedResultArtifacts.length > 0
        ? normalizedResultArtifacts
        : roleConfig.expected_outputs || [],
  );
  return compactCapsuleValue({
    schema_version: '1.0.0',
    generated_at: nowIso(),
    project,
    plan_id: planId,
    cycle,
    stage,
    role,
    freshness: {
      fresh_context: roleConfig.fresh_context,
      independent: roleConfig.independent,
    },
    objective,
    context_snapshot: contextSnapshot || {},
    inputs: {
      primary_paths: normalizePathList(primaryPaths || []),
      additional_paths: normalizePathList(additionalPaths || []),
      read_order: normalizeStringArray(readOrder || []),
      questions_to_answer: normalizeStringArray(questions || []),
    },
    boundaries: {
      allowed_files: normalizePathList(boundaries?.allowed_files || []),
      blocked_files: normalizePathList(boundaries?.blocked_files || []),
      reason: boundaries?.reason || null,
    },
    dispatch: {
      result_artifacts: normalizedResultArtifacts,
      artifact_change_required: artifactChangeRequired === true,
      completion_requirements: completionRequirements,
    },
    outputs: {
      expected_artifacts: expectedArtifacts,
      success_conditions: normalizeStringArray(outputs?.success_conditions || []),
    },
    evidence: evidence || {},
    anti_patterns: normalizeStringArray(roleConfig.anti_patterns || []),
    next_action: nextAction || '',
  });
}

function buildPlanningRoleResultArtifacts(project, role, planId) {
  if (role === 'strategist') {
    return [
      `.smike/${project}/STRATEGY.md`,
      `.smike/${project}/ROADMAP.md`,
    ];
  }
  if (role === 'detailer') {
    return [`.smike/${project}/phases/${planId}/${planId}-PLAN.json`];
  }
  if (role === 'checker') {
    return [`.smike/${project}/CHECKER.json`];
  }
  if (role === 'auditor') {
    return [`.smike/${project}/AUDITOR.json`];
  }
  return [];
}

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
  };
}

function buildPlanningRoleGuidance(role, options = {}) {
  if (role === 'strategist') {
    return {
      readOrder: [
        'Read the spec first, then the refs that define truth and scope.',
        'Extract deliverables, constraints, protected areas, and phase boundaries before sequencing work.',
      ],
      questions: [
        'What must this loop deliver before implementation can be considered complete?',
        'What phase graph keeps the work reviewable and collision-aware?',
      ],
      successConditions: [
        'Strategy captures truth sources, constraints, drift seeds, and bounded phases.',
        'Planning artifacts keep downstream roles anchored on the same spec context.',
      ],
      nextAction: 'Hand bounded phase blueprints to detailers.',
    };
  }

  if (role === 'detailer') {
    return {
      readOrder: [
        'Read the root planning artifacts first so this phase inherits the same objective and constraints.',
        'Use only the refs needed for this phase and make files, checks, and dependencies explicit.',
      ],
      questions: [
        `What is the smallest reviewable slice for Plan ${options.planId || 'this phase'}?`,
        'What discoveries or dependency edges must be carried forward now?',
      ],
      successConditions: [
        'Phase plan is explicit about files, verification, and boundaries.',
        'Dependency edges and gotchas are captured now instead of rediscovered later.',
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

function buildExecutionRoleGuidance(role, options = {}) {
  const hasDependencies = options.hasDependencies === true;

  if (role === 'detailer') {
    return {
      readOrder: [
        'Read STATE.md and the current phase contract first.',
        'Read dependency judge/reviewer capsules and propagated discoveries before rewriting the phase plan.',
      ],
      questions: [
        'What assumptions changed because upstream phases finished or discovered new constraints?',
        'How should this phase narrow or reorder itself before execution starts?',
      ],
      successConditions: [
        'The refreshed phase plan reflects upstream dependency evidence before execution starts.',
        'The refresh stays phase-local and does not widen into a new planning loop.',
      ],
      nextAction: 'Hand the refreshed phase contract to the executor.',
    };
  }

  if (role === 'executor') {
    return {
      readOrder: [
        'Start with STATE.md and the current plan contract so execution is grounded on disk.',
        'Read the same-plan detailer capsule before opening raw source files.',
        hasDependencies
          ? 'If dependencies exist, read only their judge/reviewer capsules and propagated discoveries before editing.'
          : 'Touch broader source only when the plan contract or local evidence requires it.',
      ],
      questions: [
        'What is the smallest change set that satisfies the objective and acceptance criteria?',
        'Which discoveries or prior findings must be preserved while making this change?',
        'What verification will leave enough evidence for JUDGE?',
      ],
      successConditions: [
        'Implementation stays within write scope and leaves a clear verification surface for JUDGE.',
        'Execution is honest about partial work, baseline failures, and discoveries worth propagating.',
      ],
      nextAction: 'Hand changed files, verification results, and discoveries to JUDGE.',
    };
  }

  if (role === 'judge') {
    return {
      readOrder: [
        'Read the current plan contract and executor capsule before opening changed files.',
        'Rerun verify commands first; use file reads only where acceptance needs behavioral tracing.',
      ],
      questions: [
        'Which acceptance criteria are proven by fresh evidence and which still need tracing?',
        'Did the observed file changes stay inside scope and align with the objective?',
      ],
      successConditions: [
        'VERDICT is based on fresh verification, explicit AC mapping, and scope enforcement.',
        'Any failures or weak evidence are concrete enough to route into a narrow fix.',
      ],
      nextAction: 'Write VERDICT.md, then hand the bounded change surface to REVIEW.',
    };
  }

  if (role === 'reviewer') {
    return {
      readOrder: [
        'Read VERDICT.md and the judge capsule first so review starts from verified evidence.',
        'Use the changed surface and focus areas to stay on correctness, drift, and interface risk.',
      ],
      questions: [
        'Does the diff actually deliver the stated objective, or is there drift despite passing commands?',
        'Are any review findings concrete enough to block completion or require a narrow fix route?',
      ],
      successConditions: [
        'REVIEW focuses on correctness, invariants, and drift instead of cosmetic commentary.',
        'Blocking concerns are narrow, actionable, and mapped to the current change surface.',
      ],
      nextAction: options.verdictPassed
        ? 'Either clear the plan or route concrete review concerns into a fix capsule.'
        : 'Route verdict failures and review concerns into a narrow fix capsule.',
    };
  }

  return {
    readOrder: [
      'Read VERDICT.md and REVIEW.md first so the exact failures are clear before touching code.',
      'Use the existing capsules and changed surface to find the narrowest repair path.',
    ],
    questions: [
      'What is the smallest repair that clears the current blocking failures?',
      'Which already-passing behaviors must remain untouched while the fix is applied?',
    ],
    successConditions: [
      'Fix stays inside the current write scope and addresses only the reported blocking issues.',
      'Repair leaves enough evidence to rerun the same JUDGE and REVIEW path cleanly.',
    ],
    nextAction: 'Apply a narrow fix, rerun the same plan, and keep the repair scoped to the reported issues.',
  };
}

function buildRuntimeFollowOnRoleGuidance(role, planId) {
  if (role === 'judge') {
    return {
      objective: `Independently verify the runtime-owned findings for ${planId}.`,
      readOrder: [
        'Read STATE.md, the current plan contract, and the same-plan executor capsule first.',
        'Treat the findings artifacts as claims to verify, not proof.',
      ],
      questions: [
        'Do the current result artifacts satisfy the declared outputs and acceptance criteria?',
        'What gaps, drift, or scope issues should be surfaced before review proceeds?',
      ],
      successConditions: [
        'Judge context stays phase-matched and anchored on the live result artifacts.',
        'The findings are verified without relying on stale capsules from an earlier phase.',
      ],
      nextAction: 'If the findings hold up, hand the same phase surface to REVIEW.',
    };
  }

  return {
    objective: `Review runtime-owned findings for ${planId} for drift, correctness, and follow-on risk.`,
    readOrder: [
      'Read STATE.md, the current plan contract, and the same-plan judge capsule first.',
      'Use the result artifacts and same-plan executor context as the primary review surface.',
    ],
    questions: [
      'Do the findings materially support the intended follow-on work, or are there gaps or drift?',
      'Should this phase be treated as complete, or is a narrower follow-up still required?',
    ],
    successConditions: [
      'Reviewer context stays anchored on the same phase artifacts and fresh same-plan judge/executor capsules.',
      'The review can reason about drift without reusing stale review context from an earlier phase.',
    ],
    nextAction: 'If no blocking concerns remain, allow reconciliation to close the phase.',
  };
}

function buildExecutionDetailerRefreshCapsule(project, contract, state, cycleNumber) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const dependencyIds = normalizeStringArray(contract.plan.depends_on);
  const refreshSignals = collectPhaseRefreshSignals(state, contract);
  const guidance = buildExecutionRoleGuidance('detailer');

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleNumber,
    stage: 'execution',
    role: 'detailer',
    objective: `Refresh the phase contract for ${contract.plan.plan_id} against upstream execution evidence before implementation continues.`,
    roleConfig: ROLE_DEFINITIONS.detailer,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      ...collectDependencyCapsulePaths(state, dependencyIds, ['judge', 'reviewer']),
    ],
    additionalPaths: [
      `.smike/${project}/STRATEGY.md`,
      `.smike/${project}/ROADMAP.md`,
      `.smike/${project}/PROJECT.md`,
      contract.plan.spec,
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, ['detailer']),
    ],
    readOrder: guidance.readOrder,
    questions: guidance.questions,
    boundaries: {
      allowed_files: [contract.plan_json_rel],
      blocked_files: contract.plan.blocked_files,
      reason: 'Execution-time detailer refresh may only rewrite the current phase PLAN.json.',
    },
    outputs: {
      expected_artifacts: buildPlanningRoleResultArtifacts(project, 'detailer', contract.plan.plan_id),
      success_conditions: guidance.successConditions,
    },
    resultArtifacts: buildPlanningRoleResultArtifacts(project, 'detailer', contract.plan.plan_id),
    artifactChangeRequired: true,
    evidence: {
      depends_on: dependencyIds,
      dependency_discoveries: collectDependencyDiscoveries(state, dependencyIds, contract.plan.plan_id),
      refresh_signals: refreshSignals,
    },
    nextAction: guidance.nextAction,
  });
}

function buildExecutorCapsule(project, contract, state, cycleNumber, delegationOverride = null) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const roleConfig = orchestrationConfig.roles.executor;
  const delegation = delegationOverride || normalizeDelegationConfig(contract.plan);
  const dependencyIds = normalizeStringArray(contract.plan.depends_on);
  const dependencyDiscoveries = collectDependencyDiscoveries(state, dependencyIds, contract.plan.plan_id);
  const downstreamPlanIds = findDownstreamPlanIds(state.workflow?.plans, contract.plan.plan_id);
  const guidance = buildExecutionRoleGuidance('executor', { hasDependencies: dependencyIds.length > 0 });

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleNumber,
    stage: orchestrationConfig.stage,
    role: 'executor',
    objective: contract.plan.objective,
    roleConfig,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, ['detailer']),
      ...collectDependencyCapsulePaths(state, dependencyIds, ['judge', 'reviewer']),
    ],
    additionalPaths: [
      contract.plan.spec,
      `.smike/${project}/PROJECT.md`,
      ...collectLatestCapsulePaths(state, ['strategist', 'checker', 'auditor']),
      ...limitCapsuleRefs(roleConfig.additional_context, ADDITIONAL_CONTEXT_LIMIT),
    ],
    readOrder: guidance.readOrder,
    questions: guidance.questions,
    boundaries: {
      allowed_files: contract.plan.write_scope?.allowed_files || contract.plan.allowed_files,
      blocked_files: contract.plan.write_scope?.blocked_files || contract.plan.blocked_files,
      reason: contract.plan.write_scope?.reason || 'Executor stays inside the declared write scope.',
    },
    outputs: {
      expected_artifacts: delegation.result_artifacts,
      success_conditions: guidance.successConditions,
    },
    resultArtifacts: delegation.result_artifacts,
    artifactChangeRequired: true,
    evidence: {
      depends_on: dependencyIds,
      downstream_plan_ids: downstreamPlanIds,
      verify_commands: ensureArray(contract.plan.verify_commands).map((command) => command.id),
      acceptance_criteria: ensureArray(contract.plan.acceptance_criteria).map((ac) => ac.id),
      dependency_discoveries: dependencyDiscoveries,
      phase_refresh: {
        mode: dependencyIds.length > 0 ? 'dependency_aware_executor_refresh' : 'not_needed',
        dependency_plan_ids: dependencyIds,
      },
      write_scope: contract.plan.write_scope,
    },
    nextAction: guidance.nextAction,
  });
}

function buildJudgeCapsule(project, paths, contract, state, cycleRecord) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const roleConfig = orchestrationConfig.roles.judge;
  const dependencyIds = normalizeStringArray(contract.plan.depends_on);
  const guidance = buildExecutionRoleGuidance('judge');

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleRecord.cycle,
    stage: orchestrationConfig.stage,
    role: 'judge',
    objective: `Independently verify ${contract.plan.plan_id} against acceptance, scope, and baseline honesty.`,
    roleConfig,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, ['executor']),
      ...ensureArray(cycleRecord.scope?.changed_paths),
    ],
    additionalPaths: [
      contract.plan.spec,
      ...collectDependencyCapsulePaths(state, dependencyIds, ['judge', 'reviewer']),
      ...limitCapsuleRefs(roleConfig.additional_context, ADDITIONAL_CONTEXT_LIMIT),
    ],
    readOrder: guidance.readOrder,
    questions: guidance.questions,
    boundaries: {
      allowed_files: uniqueStrings([
        ...ensureArray(contract.plan.allowed_files),
        ...ensureArray(cycleRecord.scope?.changed_paths),
      ]),
      blocked_files: contract.plan.blocked_files,
      reason: 'Judge verifies the declared plan scope plus the observed changed surface so execution drift stays inspectable.',
    },
    outputs: {
      success_conditions: guidance.successConditions,
    },
    resultArtifacts: [
      path.relative(REPO_ROOT, paths.verdictReportPath).replaceAll(path.sep, '/'),
    ],
    artifactChangeRequired: false,
    evidence: {
      execution_result: cycleRecord.execution_result || cycleRecord.result,
      execution_failures: ensureArray(cycleRecord.failures),
      changed_paths: ensureArray(cycleRecord.scope?.changed_paths),
      verify_commands: ensureArray(cycleRecord.verify_commands).map((command) => ({
        id: command.id,
        pass: command.pass,
        exit: command.status,
      })),
      acceptance: ensureArray(cycleRecord.acceptance).map((ac) => ({
        id: ac.id,
        pass: ac.pass,
      })),
      dependency_discoveries: collectDependencyDiscoveries(state, dependencyIds),
    },
    nextAction: guidance.nextAction,
  });
}

function buildReviewerCapsule(project, paths, contract, state, cycleRecord, verdictRecord) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const roleConfig = orchestrationConfig.roles.reviewer;
  const qualityConfig = getQualityGateConfig(contract.plan);
  const dependencyIds = normalizeStringArray(contract.plan.depends_on);
  const guidance = buildExecutionRoleGuidance('reviewer', { verdictPassed: verdictRecord.result === 'pass' });

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleRecord.cycle,
    stage: orchestrationConfig.stage,
    role: 'reviewer',
    objective: `Review ${contract.plan.plan_id} for correctness, invariants, and drift after JUDGE.`,
    roleConfig,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      path.relative(REPO_ROOT, paths.verdictReportPath).replaceAll(path.sep, '/'),
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, ['judge', 'executor']),
    ],
    additionalPaths: [
      contract.plan.spec,
      ...collectDependencyCapsulePaths(state, dependencyIds, ['reviewer']),
      ...limitCapsuleRefs(roleConfig.additional_context, ADDITIONAL_CONTEXT_LIMIT),
    ],
    readOrder: guidance.readOrder,
    questions: guidance.questions,
    boundaries: {
      allowed_files: uniqueStrings([
        ...ensureArray(cycleRecord.scope?.changed_paths),
        contract.plan_json_rel,
        contract.plan_md_rel,
        path.relative(REPO_ROOT, paths.verdictReportPath).replaceAll(path.sep, '/'),
      ]),
      blocked_files: contract.plan.blocked_files,
      reason: 'Reviewer stays on the current diff and adjacent invariant checks; no broad repo tour.',
    },
    outputs: {
      success_conditions: guidance.successConditions,
    },
    resultArtifacts: [
      path.relative(REPO_ROOT, paths.reviewReportPath).replaceAll(path.sep, '/'),
    ],
    artifactChangeRequired: false,
    evidence: {
      verdict_result: verdictRecord.result,
      verdict_failures: ensureArray(verdictRecord.failures),
      focus_areas: qualityConfig.review.focus_areas,
      changed_paths: ensureArray(cycleRecord.scope?.changed_paths),
      dependency_discoveries: collectDependencyDiscoveries(state, dependencyIds),
    },
    nextAction: guidance.nextAction,
  });
}

function buildRuntimeFollowOnCapsule(project, contract, state, role, cycleNumber, resultArtifacts = []) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const roleConfig = orchestrationConfig.roles[role];
  const dependencyIds = normalizeStringArray(contract.plan.depends_on);
  const normalizedArtifacts = normalizePathList(resultArtifacts);
  const samePlanRoles = role === 'judge' ? ['executor'] : ['judge', 'executor'];
  const dependencyRoles = role === 'reviewer' ? ['reviewer'] : ['judge', 'reviewer'];
  const roleSpecific = buildRuntimeFollowOnRoleGuidance(role, contract.plan.plan_id);

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleNumber,
    stage: orchestrationConfig.stage,
    role,
    objective: roleSpecific.objective,
    roleConfig,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, samePlanRoles),
      ...normalizedArtifacts,
    ],
    additionalPaths: [
      contract.plan.spec,
      ...collectDependencyCapsulePaths(state, dependencyIds, dependencyRoles),
      ...limitCapsuleRefs(roleConfig.additional_context, ADDITIONAL_CONTEXT_LIMIT),
    ],
    readOrder: roleSpecific.readOrder,
    questions: roleSpecific.questions,
    boundaries: {
      allowed_files: uniqueStrings([
        ...ensureArray(contract.plan.allowed_files),
        ...ensureArray(contract.plan.write_scope?.allowed_files),
        ...normalizedArtifacts,
      ]),
      blocked_files: uniqueStrings([
        ...ensureArray(contract.plan.blocked_files),
        ...ensureArray(contract.plan.write_scope?.blocked_files),
      ]),
      reason: `Runtime ${role} stays on the declared phase surface and its result artifacts.`,
    },
    outputs: {
      expected_artifacts: normalizedArtifacts,
      success_conditions: roleSpecific.successConditions,
    },
    resultArtifacts: normalizedArtifacts,
    artifactChangeRequired: false,
    evidence: {
      result_artifacts: normalizedArtifacts,
      verify_commands: ensureArray(contract.plan.verify_commands).map((command) => command.id),
      acceptance_criteria: ensureArray(contract.plan.acceptance_criteria).map((ac) => ac.id),
      dependency_discoveries: collectDependencyDiscoveries(state, dependencyIds),
    },
    nextAction: roleSpecific.nextAction,
  });
}

function buildFixerCapsule(project, paths, contract, state, cycleRecord, verdictRecord, reviewRecord) {
  const orchestrationConfig = resolveOrchestrationConfig(project, contract.plan);
  const roleConfig = orchestrationConfig.roles.fixer;
  const delegation = normalizeDelegationConfig(contract.plan);
  const blockingFindings = ensureArray(reviewRecord.findings)
    .filter((finding) => finding.severity !== 'low')
    .map((finding) => `${finding.severity} ${finding.id}: ${finding.title}`);
  const blockingFailures = uniqueStrings([
    ...ensureArray(verdictRecord.failures).map((value) => `judge.${value}`),
    ...blockingFindings,
  ]);
  const guidance = buildExecutionRoleGuidance('fixer');

  return buildRoleCapsule({
    project,
    planId: contract.plan.plan_id,
    cycle: cycleRecord.cycle,
    stage: orchestrationConfig.stage,
    role: 'fixer',
    objective: `Repair ${contract.plan.plan_id} without widening scope or redesigning the solution.`,
    roleConfig,
    primaryPaths: [
      `.smike/${project}/STATE.md`,
      contract.plan_json_rel,
      contract.plan_md_rel,
      path.relative(REPO_ROOT, paths.verdictReportPath).replaceAll(path.sep, '/'),
      path.relative(REPO_ROOT, paths.reviewReportPath).replaceAll(path.sep, '/'),
      ...collectCapsulePathsForPlan(state, contract.plan.plan_id, ['executor', 'judge', 'reviewer']),
    ],
    additionalPaths: [...limitCapsuleRefs(roleConfig.additional_context, ADDITIONAL_CONTEXT_LIMIT)],
    readOrder: guidance.readOrder,
    questions: guidance.questions,
    boundaries: {
      allowed_files: contract.plan.write_scope?.allowed_files || contract.plan.allowed_files,
      blocked_files: contract.plan.write_scope?.blocked_files || contract.plan.blocked_files,
      reason: 'Fix scope is narrower than execution scope: only repair the reported failures.',
    },
    outputs: {
      success_conditions: guidance.successConditions,
    },
    resultArtifacts: delegation.result_artifacts,
    artifactChangeRequired: true,
    evidence: {
      blocking_failures: blockingFailures,
      changed_paths: ensureArray(cycleRecord.scope?.changed_paths),
      verdict_result: verdictRecord.result,
      review_result: reviewRecord.result,
      review_findings: ensureArray(reviewRecord.findings).map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
      })),
    },
    nextAction: guidance.nextAction,
  });
}

function writeRoleCapsule(paths, capsule) {
  ensureDir(paths.capsulesDir);
  const capsulePaths = getRoleCapsulePaths(paths, capsule.plan_id, capsule.role);
  writeJson(capsulePaths.jsonPath, capsule);
  const legacyMdPath = path.join(paths.capsulesDir, `${buildRoleCapsuleBasename(capsule.plan_id, capsule.role)}.md`);
  if (fs.existsSync(legacyMdPath)) {
    fs.unlinkSync(legacyMdPath);
  }
  return capsulePaths;
}

function summarizeFailures(preflight, verifyResults, acceptanceResults, scopeResult, postflightResults) {
  const failures = [];

  for (const check of preflight.checks) {
    if (!check.pass) {
      if (check.type === 'workspace_dirty') {
        failures.push('preflight.workspace_dirty');
      } else if (check.type === 'tool') {
        failures.push(`preflight.tool.${check.tool}`);
      } else if (check.type === 'env') {
        failures.push(`preflight.env.${check.env_var}`);
      }
    }
  }

  for (const result of verifyResults) {
    if (!result.pass) {
      failures.push(`verify.${result.id}`);
    }
  }

  for (const result of acceptanceResults) {
    if (!result.pass) {
      failures.push(`ac.${result.id}`);
    }
  }

  if (!scopeResult.pass) {
    failures.push('scope.enforcement');
  }

  for (const result of postflightResults) {
    if (!result.pass) {
      failures.push(`postflight.${result.id}`);
    }
  }

  return failures;
}

function relativizeInsideRepo(targetPath) {
  if (!targetPath) {
    return null;
  }

  const absolute = path.resolve(REPO_ROOT, targetPath);
  if (!isPathInside(REPO_ROOT, absolute)) {
    fail(`path escapes repository root: ${targetPath}`);
  }
  return path.relative(REPO_ROOT, absolute).replaceAll(path.sep, '/');
}

function walkRepoFiles(rootDir, relativePrefix = '') {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (REPO_WALK_EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(rootDir, entry.name);
    const relativePath = relativePrefix
      ? path.posix.join(relativePrefix, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      files.push(...walkRepoFiles(absolutePath, relativePath));
      continue;
    }

    if (entry.isFile()) {
      files.push({
        absolute: absolutePath,
        relative: relativePath.replaceAll(path.sep, '/'),
      });
    }
  }

  return files;
}

function findPathCandidates(inputPath) {
  const normalizedInput = normalizeRel(inputPath);
  const inputBaseName = path.posix.basename(normalizedInput);
  const repoFiles = walkRepoFiles(REPO_ROOT);
  const directSuffixMatches = repoFiles.filter((file) => file.relative.endsWith(normalizedInput));
  if (directSuffixMatches.length > 0) {
    return directSuffixMatches;
  }

  return repoFiles.filter((file) => path.posix.basename(file.relative) === inputBaseName);
}

function tryResolveExistingPath(inputPath) {
  const absolute = path.resolve(REPO_ROOT, inputPath);
  if (!isPathInside(REPO_ROOT, absolute)) {
    return {
      status: 'outside_repo',
      inputPath,
    };
  }

  if (fs.existsSync(absolute)) {
    return {
      status: 'ok',
      absolute,
      relative: path.relative(REPO_ROOT, absolute).replaceAll(path.sep, '/'),
    };
  }

  const candidates = findPathCandidates(inputPath);
  if (candidates.length === 1) {
    return {
      status: 'ok',
      ...candidates[0],
    };
  }
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      inputPath,
      candidates,
    };
  }

  return {
    status: 'missing',
    inputPath,
  };
}

function resolveExistingPath(inputPath) {
  const resolution = tryResolveExistingPath(inputPath);
  if (resolution.status === 'ok') {
    return resolution;
  }
  if (resolution.status === 'outside_repo') {
    fail(`path must stay inside repository: ${inputPath}`);
  }
  if (resolution.status === 'ambiguous') {
    fail(`path is ambiguous: ${inputPath}\n- ${resolution.candidates.map((candidate) => candidate.relative).join('\n- ')}`);
  }
  fail(`path not found: ${inputPath}`);
}

function resolvePathList(inputPaths) {
  return inputPaths.map(resolveExistingPath).map((resolved) => ({
    absolute: resolved.absolute,
    relative: normalizeRel(resolved.relative),
  }));
}

function buildDefaultIntakeSpecRel(promptText) {
  const base = safeSlug(promptText).slice(0, 72) || 'smike-intake';
  let candidate = normalizeRel(path.posix.join('memories', `${base}.md`));
  let counter = 2;
  while (fs.existsSync(path.join(REPO_ROOT, candidate))) {
    candidate = normalizeRel(path.posix.join('memories', `${base}-${counter}.md`));
    counter += 1;
  }
  return candidate;
}

function resolvePlannedPath(inputPath, surface = 'path') {
  const normalized = normalizeRel(String(inputPath || ''));
  if (!normalized) {
    fail(`${surface} is required`);
  }

  const absolute = path.resolve(REPO_ROOT, normalized);
  if (!isPathInside(REPO_ROOT, absolute)) {
    fail(`${surface} must stay inside repository: ${inputPath}`);
  }

  return {
    absolute,
    relative: normalizeRel(path.relative(REPO_ROOT, absolute).replaceAll(path.sep, '/')),
  };
}

function resolveIntakeSpecTarget(specPath, promptText) {
  if (!specPath) {
    return resolvePlannedPath(buildDefaultIntakeSpecRel(promptText), 'intake spec path');
  }

  const resolved = resolvePlannedPath(specPath, 'intake spec path');
  if (!resolved.relative.endsWith('.md')) {
    fail(`intake spec path must end in .md: ${specPath}`);
  }
  if (fs.existsSync(resolved.absolute)) {
    fail(`intake spec already exists: ${resolved.relative}`);
  }
  return resolved;
}

function extractContextFlagPaths(flagValue) {
  return String(flagValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseIntakeArgs(rawArgs) {
  const promptParts = [];
  const contextInputs = [];
  let specPath = null;

  for (const arg of ensureArray(rawArgs)) {
    if (!String(arg).startsWith('--')) {
      if (specPath || contextInputs.length > 0) {
        fail('intake prompt text must come before flags');
      }
      promptParts.push(arg);
      continue;
    }

    if (arg.startsWith('--context=')) {
      contextInputs.push(...extractContextFlagPaths(arg.slice('--context='.length)));
      continue;
    }
    if (arg.startsWith('--spec=')) {
      if (specPath) {
        fail('intake accepts only one --spec flag');
      }
      specPath = arg.slice('--spec='.length).trim();
      continue;
    }
    fail(`unknown intake flag: ${arg}`);
  }

  const promptText = promptParts.join(' ').trim().replace(/\s+/g, ' ');
  if (!promptText) {
    fail('intake prompt text is required');
  }

  return {
    promptText,
    specPath,
    contextFiles: normalizePathList(
      contextInputs.map((contextPath) => resolveExistingPath(contextPath).relative),
    ),
  };
}

function argsIncludeIntakeFlags(args) {
  return ensureArray(args).some((arg) => {
    const value = String(arg || '');
    return value.startsWith('--context=') || value.startsWith('--spec=');
  });
}

function shouldRouteArgsToIntake(args) {
  const normalizedArgs = ensureArray(args).map((arg) => String(arg));
  if (normalizedArgs.length === 0) {
    return false;
  }
  if (argsIncludeIntakeFlags(normalizedArgs)) {
    return true;
  }

  const promptParts = normalizedArgs.filter((arg) => !arg.startsWith('--'));
  if (promptParts.length === 0) {
    return false;
  }

  if (promptParts.length > 1) {
    return !promptParts.every((arg) => tryResolveExistingPath(arg).status === 'ok');
  }

  const [singleArg] = promptParts;
  if (!/\s/.test(singleArg)) {
    return false;
  }
  if (resolveSpecShortcut(singleArg) || resolveProjectSelector(singleArg)) {
    return false;
  }
  return true;
}

function promptToSpecTitle(promptText) {
  const trimmed = String(promptText || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) {
    return 'SMIKE Intake Draft';
  }
  const sentence = trimmed.replace(/[.?!]+$/g, '');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function buildIntakeSpecMarkdown(promptText, contextFiles = []) {
  const title = promptToSpecTitle(promptText);
  const refLines = contextFiles.length > 0
    ? contextFiles.map((ref) => `> - ${ref}`)
    : ['> - Add canonical repo paths here before promoting out of planning_draft.'];
  const plannerReadLines = contextFiles.length > 0
    ? contextFiles.map((ref, index) => `${index + 1}. ${ref}`)
    : ['Add repo docs, routes, packages, tests, or design references here before promotion.'];
  const promptSentence = promptText.endsWith('.') ? promptText : `${promptText}.`;

  return [
    `# ${title}`,
    '',
    '> **SMIKE intake draft.**',
    '> Generated from a short prompt so the onboarding planner can expand it into a real spec.',
    '> Refine this file during `planning_draft`; SMIKE will rebuild `.smike/**` from it on the next cycle.',
    '> Primary refs:',
    ...refLines,
    '',
    '## Intake Prompt',
    promptSentence,
    '',
    '## Objective',
    `Expand the short intake prompt into a concrete, reviewable implementation plan for ${promptText}.`,
    '',
    '## What The Planner Must Read First',
    ...plannerReadLines,
    '',
    '## Required Deliverable From This Loop',
    '1. A bounded implementation plan that turns the intake prompt into reviewable execution slices.',
    '2. Clarified assumptions, constraints, and truth sources needed before execution begins.',
    '3. Phase-specific verification commands once the implementation surface is concrete.',
    '',
    '## Required Planning Output Shape',
    '- Plan 01: Scope and truth-source intake (category:general)',
    '- Plan 02: First executable slice (depends:01; category:general)',
    '- Plan 03: Follow-on slice and verification (depends:02; category:verification)',
    '',
    '## Priority 1: Scope and truth-source intake',
    'Turn the short prompt into a concrete problem statement, capture the repo truth sources, and answer the open questions before promotion.',
    '',
    '## Priority 2: First executable slice',
    'Define the first bounded implementation slice once the target files, interfaces, and constraints are concrete.',
    '',
    '## Priority 3: Follow-on slice and verification',
    'Define the remaining implementation work and add phase-specific verification commands for each code-bearing slice.',
    '',
    '## Clarifying Questions',
    '- What user-visible behavior should exist when this feature is done?',
    '- Which files, packages, routes, screens, or APIs are most likely in scope?',
    '- What existing docs, tests, or implementation references should the planner treat as truth?',
    '- What is explicitly out of scope for this loop?',
    '- How should the finished work be verified?',
    '',
    '## Notes From Intake',
    `- Raw prompt: ${promptText}`,
    '- Replace generic phase titles, summaries, and verification with concrete repo-aware details before promotion.',
    '',
  ].join('\n');
}

function resolveSpecShortcut(input) {
  const selector = String(input || '').trim();
  if (!selector || selector.includes('/') || selector.includes('\\')) {
    return null;
  }

  const normalizedSelector = normalizeRel(selector).replace(/\.md$/i, '');
  const markdownFiles = walkRepoFiles(REPO_ROOT).filter((file) => file.relative.endsWith('.md'));
  const exactRelative = markdownFiles.filter((file) => file.relative === `${normalizedSelector}.md`);
  if (exactRelative.length === 1) {
    return exactRelative[0].relative;
  }
  if (exactRelative.length > 1) {
    fail(`spec shorthand is ambiguous: ${input}\n- ${exactRelative.map((file) => file.relative).join('\n- ')}`);
  }

  const suffixMatches = markdownFiles.filter(
    (file) => file.relative.endsWith(`/${normalizedSelector}.md`),
  );
  const preferredSuffixMatches = suffixMatches.filter((file) => file.relative.startsWith('memories/'));
  const basenameMatches = markdownFiles.filter(
    (file) => path.posix.basename(file.relative, '.md') === normalizedSelector,
  );
  const preferredBasenameMatches = basenameMatches.filter((file) => file.relative.startsWith('memories/'));
  const matches =
    preferredSuffixMatches.length === 1 ? preferredSuffixMatches
      : suffixMatches.length === 1 ? suffixMatches
        : preferredBasenameMatches.length === 1 ? preferredBasenameMatches
          : suffixMatches.length > 0 ? suffixMatches
            : basenameMatches;

  if (matches.length === 1) {
    return matches[0].relative;
  }
  if (matches.length > 1) {
    fail(`spec shorthand is ambiguous: ${input}\n- ${matches.map((file) => file.relative).join('\n- ')}`);
  }

  return null;
}

function normalizePathList(paths) {
  if (!Array.isArray(paths)) {
    return [];
  }

  return uniqueStrings(
    paths
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

const { dispatchIdFor, dispatchSignature, resolveRuntimeDispatchEntry } = createDispatchHelpers({
  safeSlug,
  normalizePathList,
  normalizeDispatchCompletionRequirements,
});

function slugifyProjectName(input) {
  const base = path.basename(input, path.extname(input));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'smike-project';
}

function listProjectDirs() {
  ensureDir(SMIKE_ROOT);
  return fs.readdirSync(SMIKE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name !== 'templates' && name !== 'phases');
}

function listArchiveDirs() {
  ensureDir(SMIKE_ARCHIVE_ROOT);
  return fs.readdirSync(SMIKE_ARCHIVE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function resolveArchiveSelector(input) {
  const selector = String(input || '').trim();
  if (!selector) {
    return null;
  }
  if (selector.includes('/') || selector.includes('\\')) {
    return null;
  }

  const projects = listArchiveDirs();
  const exact = projects.find((project) => project === selector);
  if (exact) {
    return exact;
  }

  const caseInsensitive = projects.filter((project) => project.toLowerCase() === selector.toLowerCase());
  if (caseInsensitive.length === 1) {
    return caseInsensitive[0];
  }
  if (caseInsensitive.length > 1) {
    fail(`archive selector is ambiguous: ${selector}\n- ${caseInsensitive.join('\n- ')}`);
  }

  const prefixMatches = projects.filter((project) => project.startsWith(selector));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    fail(`archive selector is ambiguous: ${selector}\n- ${prefixMatches.join('\n- ')}`);
  }

  return null;
}

function resolveProjectSelector(input) {
  const selector = String(input || '').trim();
  if (!selector) {
    return null;
  }
  if (selector.includes('/') || selector.includes('\\')) {
    return null;
  }

  const projects = listProjectDirs();
  const exact = projects.find((project) => project === selector);
  if (exact) {
    return exact;
  }

  const caseInsensitive = projects.filter((project) => project.toLowerCase() === selector.toLowerCase());
  if (caseInsensitive.length === 1) {
    return caseInsensitive[0];
  }
  if (caseInsensitive.length > 1) {
    fail(`project selector is ambiguous: ${selector}\n- ${caseInsensitive.join('\n- ')}`);
  }

  const prefixMatches = projects.filter((project) => project.startsWith(selector));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    fail(`project selector is ambiguous: ${selector}\n- ${prefixMatches.join('\n- ')}`);
  }

  return null;
}

function findProjectForSpec(specRel) {
  for (const project of listProjectDirs()) {
    const paths = getProjectPaths(project);

    if (fs.existsSync(paths.projectMetaPath)) {
      try {
        const projectMeta = readJson(paths.projectMetaPath);
        if (projectMeta?.spec_path === specRel) {
          return project;
        }
      } catch {
        // Ignore malformed legacy metadata and continue scanning.
      }
    }

    if (fs.existsSync(paths.planJsonPath)) {
      try {
        const plan = readJson(paths.planJsonPath);
        if (plan?.spec === specRel) {
          return project;
        }
      } catch {
        // Ignore malformed plans during best-effort lookup.
      }
    }

    if (fs.existsSync(paths.statePath)) {
      try {
        const state = readJson(paths.statePath);
        if (state?.project?.spec === specRel || state?.planning?.spec_path === specRel) {
          return project;
        }
      } catch {
        // Ignore malformed legacy state during best-effort lookup.
      }
    }
  }

  return null;
}

function allocateProjectName(specRel) {
  const existing = findProjectForSpec(specRel);
  if (existing) {
    return existing;
  }

  const base = slugifyProjectName(specRel);
  let candidate = base;
  let suffix = 2;
  while (fs.existsSync(path.join(SMIKE_ROOT, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function shouldPersistActiveProject(env = process.env) {
  if (env[SMIKE_ALLOW_TEST_ACTIVE_PROJECT_ENV] === '1') {
    return true;
  }
  return !isParentTestRunnerContext(env);
}

function setActiveProject(activeProject) {
  if (!shouldPersistActiveProject()) {
    return;
  }
  ensureDir(SMIKE_ROOT);
  writeJson(ACTIVE_PROJECT_PATH, {
    schema_version: '1.0.0',
    updated_at: nowIso(),
    ...activeProject,
  });
}

function readActiveProject() {
  if (!fs.existsSync(ACTIVE_PROJECT_PATH)) {
    return null;
  }

  const active = readJson(ACTIVE_PROJECT_PATH);
  if (!active || typeof active !== 'object' || Array.isArray(active)) {
    fail(`invalid active project pointer: ${ACTIVE_PROJECT_PATH}`);
  }
  if (typeof active.project !== 'string' || !active.project.trim()) {
    fail(`active project pointer is missing project: ${ACTIVE_PROJECT_PATH}`);
  }
  return active;
}

function clearActiveProject(project = null) {
  if (!fs.existsSync(ACTIVE_PROJECT_PATH)) {
    return false;
  }

  const active = readActiveProject();
  if (project && active.project !== project) {
    return false;
  }

  fs.rmSync(ACTIVE_PROJECT_PATH, { force: true });
  return true;
}

function templatePath(...segments) {
  return path.join(__dirname, 'templates', 'codex', ...segments);
}

function readTemplateJson(filename) {
  return readJson(templatePath(filename));
}

function cleanMarkdownInline(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDirectiveValue(text) {
  return String(text || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMarkdownSections(markdown) {
  const sections = [];
  const lines = String(markdown || '').split(/\r?\n/);
  let current = { level: 0, title: 'ROOT', lines: [] };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      sections.push(current);
      current = {
        level: heading[1].length,
        title: cleanMarkdownInline(heading[2]),
        lines: [],
      };
      continue;
    }
    current.lines.push(line);
  }

  sections.push(current);
  return sections;
}

function findSection(sections, pattern) {
  return sections.find((section) => pattern.test(section.title));
}

function sectionText(section) {
  return section ? section.lines.join('\n').trim() : '';
}

function extractListItems(text) {
  const items = [];

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim()) {
      continue;
    }
    const bullet = rawLine.match(/^[-*+]\s+(.+)$/) || rawLine.match(/^\d+\.\s+(.+)$/);
    if (!bullet) {
      continue;
    }
    const value = cleanMarkdownInline(bullet[1]);
    if (value) {
      items.push(value);
    }
  }

  return uniqueStrings(items);
}

function extractLabeledListItems(text, labelPattern) {
  const items = [];
  let capture = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (labelPattern.test(cleanMarkdownInline(trimmed))) {
      capture = true;
      continue;
    }

    if (!capture) {
      continue;
    }

    const bullet = rawLine.match(/^[-*+]\s+(.+)$/) || rawLine.match(/^\d+\.\s+(.+)$/);
    if (bullet) {
      const value = cleanMarkdownInline(bullet[1]);
      if (value) {
        items.push(value);
      }
      continue;
    }

    if (/^[A-Za-z].*:\s*$/.test(trimmed)) {
      break;
    }
  }

  return uniqueStrings(items);
}

function extractMarkdownTitle(markdown, fallback) {
  const match = String(markdown || '').match(/^#\s+(.+?)\s*$/m);
  return match ? cleanMarkdownInline(match[1]) : fallback;
}

function looksLikeRepoPath(value) {
  const candidate = cleanMarkdownInline(value);
  if (!candidate || candidate.includes(' ')) {
    return false;
  }
  return (
    candidate.includes('/') ||
    /\.(md|json|ts|tsx|js|mjs|cjs|sql|sh|toml|yml|yaml)$/i.test(candidate) ||
    /^[A-Z0-9_.-]+\.md$/i.test(candidate)
  );
}

function extractRepoPathsFromText(text) {
  const matches = [];
  for (const match of String(text || '').matchAll(/`([^`]+)`/g)) {
    const candidate = normalizeRel(match[1]);
    if (looksLikeRepoPath(candidate)) {
      matches.push(candidate);
    }
  }
  return normalizePathList(matches);
}

function extractPrimaryRefs(markdown) {
  const refs = [];
  let inPrimaryRefs = false;

  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('>')) {
      const content = cleanMarkdownInline(line.slice(1).trim());
      if (/^Primary refs:/i.test(content)) {
        inPrimaryRefs = true;
        continue;
      }
      if (inPrimaryRefs) {
        const bullet = content.match(/^-\s+(.+)$/);
        if (bullet) {
          refs.push(normalizeRel(bullet[1]));
          continue;
        }
      }
    }

    if (inPrimaryRefs && line && !line.startsWith('>')) {
      break;
    }
  }

  return normalizePathList(refs);
}

function inferPlanningMode(markdown) {
  const normalized = String(markdown || '').toLowerCase();
  if (
    normalized.includes('read-only smike research loop') ||
    normalized.includes('advice-only smike run') ||
    normalized.includes('advisory smike run') ||
    normalized.includes('advice-only') ||
    normalized.includes('advisory only') ||
    normalized.includes('architecture audit') ||
    normalized.includes('read-only audit') ||
    normalized.includes('audit-only') ||
    normalized.includes('must not make implementation changes') ||
    normalized.includes('must not change repo code') ||
    normalized.includes('quality of planning')
  ) {
    return 'research';
  }
  return 'implementation';
}

function planningCategoryIsHighRisk(category) {
  return new Set(['permissions', 'verification', 'migration']).has(String(category || '').toLowerCase());
}

function phaseLooksHighRisk(phase) {
  const normalized = `${phase?.title || ''} ${phase?.summary || ''}`.toLowerCase();
  return planningCategoryIsHighRisk(phase?.category)
    || /(auth|permission|security|ownership|schema|migration|billing|webhook|route-architecture|worker truth cleanup)/.test(normalized);
}

function buildPlanningAnalysisPolicy(bundle, phaseBlueprints) {
  const hasBlockingLint = ensureArray(bundle?.lint?.findings).some((finding) => finding?.severity !== 'low');
  const highRiskPhase = phaseBlueprints.some((phase) => phaseLooksHighRisk(phase));
  const broadOrComplex =
    phaseBlueprints.length >= 3
    || bundle.mode === 'research'
    || bundle.deliverables.length >= 5
    || bundle.protected_areas.length > 0
    || bundle.primary_refs.length >= 5;

  if (hasBlockingLint) {
    return {
      checker_enabled: true,
      auditor_enabled: true,
      reason: 'Blocking spec lint must be materialized through planning analysis so planning can fail loudly.',
    };
  }

  if (highRiskPhase || broadOrComplex) {
    return {
      checker_enabled: true,
      auditor_enabled: true,
      reason: 'Bundle is broad, research-oriented, or high-risk enough to justify full planning analysis.',
    };
  }

  return {
    checker_enabled: false,
    auditor_enabled: false,
    reason: 'Bundle is small and low-risk, so full checker/auditor passes would add more overhead than signal.',
  };
}

function researchPhaseNeedsReviewer(phase) {
  const normalized = `${phase?.title || ''} ${phase?.summary || ''}`.toLowerCase();
  return planningCategoryIsHighRisk(phase?.category)
    || /(auth|permission|security|ownership|schema|migration|verification|guardrail|destructive|billing)/.test(normalized);
}

function summarizeSection(text, fallback) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  const sentence = normalized.match(/.+?[.!?](?:\s|$)/);
  return sentence ? sentence[0].trim() : normalized;
}

function inferPhaseCategory(text) {
  const normalized = String(text || '').toLowerCase();
  if (normalized.includes('auth') || normalized.includes('permission')) {
    return 'permissions';
  }
  if (normalized.includes('route')) {
    return 'route-architecture';
  }
  if (normalized.includes('doc') || normalized.includes('memory') || normalized.includes('architecture')) {
    return 'doc-drift';
  }
  if (normalized.includes('dead') || normalized.includes('remnant') || normalized.includes('hygiene')) {
    return 'dead-code';
  }
  if (normalized.includes('verification') || normalized.includes('guardrail') || normalized.includes('test')) {
    return 'verification';
  }
  return 'general';
}

function categoryWriteScopeGlobs(category, docRefs) {
  switch (category) {
    case 'permissions':
      return ['packages/worker/**', 'packages/shared/**', 'tests/**', ...docRefs.filter((ref) => /AGENTS|security|MEMORY|family-tech-platform/i.test(ref))];
    case 'route-architecture':
      return ['packages/worker/**', 'packages/shared/**', 'packages/cli/**', 'tests/**'];
    case 'doc-drift':
      return [...docRefs];
    case 'dead-code':
      return ['packages/worker/**', 'packages/shared/**', 'packages/cli/**', 'tests/**', 'scripts/**', ...docRefs];
    case 'verification':
      return ['tests/**', 'packages/worker/**', 'packages/shared/**', 'packages/cli/**', ...docRefs.filter((ref) => /AGENTS|MEMORY|family-tech-platform/i.test(ref))];
    case 'ui-component':
      return ['packages/dashboard/**', 'tests/**', ...docRefs];
    case 'migration':
      return ['packages/worker/**', 'packages/shared/**', 'tests/**', 'scripts/**'];
    default:
      return [];
  }
}

function inferPhaseWriteScope(project, mode, phase, primaryRefs) {
  const normalized = `${phase.title} ${phase.summary}`.toLowerCase();
  const allowed = [];
  const blocked = ['.env*', '**/*.pem', '**/*.key'];
  const docRefs = primaryRefs.filter((ref) => ref.endsWith('.md') || ref === 'AGENTS.md');
  const explicitWriteScope = normalizePathList(ensureArray(phase.declared_write_scope || []));

  if (explicitWriteScope.length > 0) {
    allowed.push(...explicitWriteScope, ...docRefs);
  }

  if (allowed.length === 0 && phase.category) {
    allowed.push(...categoryWriteScopeGlobs(phase.category, docRefs));
  }

  if (allowed.length === 0 && /(auth|permission|ownership|webhook|worker|truth cleanup)/.test(normalized)) {
    allowed.push('packages/worker/**', 'packages/shared/**', 'tests/**');
    allowed.push(...docRefs.filter((ref) => /AGENTS|security|MEMORY|family-tech-platform/i.test(ref)));
  }

  if (allowed.length === 0 && /(route|helper|env|context|uuid|response|error)/.test(normalized)) {
    allowed.push('packages/worker/**', 'packages/shared/**', 'packages/cli/**', 'tests/**');
  }

  if (allowed.length === 0 && /(doc|memory|architecture|manifest|reconciliation)/.test(normalized)) {
    allowed.push(...docRefs);
  }

  if (allowed.length === 0 && /(dead|remnant|hygiene|artifact|type drift|naming drift|deprecated)/.test(normalized)) {
    allowed.push('packages/worker/**', 'packages/shared/**', 'packages/cli/**', 'tests/**', 'scripts/**');
    allowed.push(...docRefs);
  }

  if (allowed.length === 0 && /(verification|guardrail|regression|test)/.test(normalized)) {
    allowed.push('tests/**', 'packages/worker/**', 'packages/shared/**', 'packages/cli/**');
    allowed.push(...docRefs.filter((ref) => /AGENTS|MEMORY|family-tech-platform/i.test(ref)));
  }

  if (allowed.length === 0) {
    allowed.push('packages/worker/**', 'packages/shared/**', 'tests/**');
    allowed.push(...docRefs);
  }

  if (!/schedule/.test(normalized)) {
    blocked.push('packages/dashboard/src/components/ScheduleEditor.tsx');
  }
  if (!/(agent|enrollment|path a|path b|ios|dashboard)/.test(normalized)) {
    blocked.push('packages/agent-app/**', 'packages/agent-cli/**', 'packages/ios/**');
  }

  const readSurface = normalizePathList(allowed);
  const blockedFiles = normalizePathList(blocked);
  const researchWriteScope = [`.smike/${project}/**`];

  return {
    allowed_files: readSurface,
    blocked_files: blockedFiles,
    write_scope_allowed_files:
      mode === 'research'
        ? researchWriteScope
        : explicitWriteScope.length > 0 ? explicitWriteScope : readSurface,
    write_scope_blocked_files: blockedFiles,
    write_scope_reason:
      mode === 'research'
        ? 'Research mode: write findings only inside `.smike/<project>/`; do not change repo code.'
        : explicitWriteScope.length > 0
          ? `Bound ${phase.id} to the declared write scope from the planning shape.`
          : `Bound ${phase.id} to a reviewable cleanup slice.`,
  };
}

function buildDocCheckCommand(pathsToCheck) {
  const script = [
    "const fs = require('fs')",
    "const path = require('path')",
    `const files = ${JSON.stringify(pathsToCheck)}`,
    "const missing = files.filter((file) => !fs.existsSync(path.join(process.cwd(), file)))",
    "if (missing.length > 0) { console.error('missing:' + missing.join(',')); process.exit(1); }",
    "process.stdout.write('docs-ready')",
  ].join('; ');
  return `node -e ${JSON.stringify(script)}`;
}

function buildResearchArtifactCheckCommand(project, phase) {
  const resultPaths = getResearchResultPaths(project, phase.id);
  const script = [
    "const fs = require('fs')",
    "const path = require('path')",
    "const repoRoot = process.cwd()",
    `const jsonPath = path.join(repoRoot, ${JSON.stringify(resultPaths.jsonRel)})`,
    "if (!fs.existsSync(jsonPath)) { console.error('missing-json:' + jsonPath); process.exit(1); }",
    "const findings = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))",
    "if (!findings || typeof findings !== 'object' || Array.isArray(findings)) { console.error('invalid-findings-json'); process.exit(1); }",
    `if (String(findings.phase || '') !== ${JSON.stringify(phase.id)}) { console.error('phase-mismatch'); process.exit(1); }`,
    "if (!Array.isArray(findings.findings) || findings.findings.length === 0) { console.error('missing-findings'); process.exit(1); }",
    "for (const finding of findings.findings) {",
    "  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) { console.error('invalid-finding'); process.exit(1); }",
    "  if (typeof finding.id !== 'string' || !finding.id.trim()) { console.error('missing-finding-id'); process.exit(1); }",
    "  if (typeof finding.title !== 'string' || !finding.title.trim()) { console.error('missing-finding-title'); process.exit(1); }",
    "  if (typeof finding.category !== 'string' || !finding.category.trim()) { console.error('missing-finding-category'); process.exit(1); }",
    "  if (typeof finding.confidence !== 'string' || !finding.confidence.trim()) { console.error('missing-finding-confidence'); process.exit(1); }",
    "  if (typeof finding.action !== 'string' || !finding.action.trim()) { console.error('missing-finding-action'); process.exit(1); }",
    "  if (typeof finding.summary !== 'string' || !finding.summary.trim()) { console.error('missing-finding-summary'); process.exit(1); }",
    "  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) { console.error('missing-finding-evidence'); process.exit(1); }",
    "  for (const evidence of finding.evidence) {",
    "    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) { console.error('invalid-evidence'); process.exit(1); }",
    "    if (typeof evidence.path !== 'string' || !evidence.path.trim()) { console.error('missing-evidence-path'); process.exit(1); }",
    "    if (typeof evidence.note !== 'string' || !evidence.note.trim()) { console.error('missing-evidence-note'); process.exit(1); }",
    "  }",
    "}",
    "process.stdout.write('research-artifacts-ready')",
  ].join('; ');

  return `node -e ${JSON.stringify(script)}`;
}

function buildPlanningBundleCheckCommand(project, phaseIds, planningAnalysis = {}) {
  const artifacts = [
    `.smike/${project}/PROJECT.md`,
    `.smike/${project}/PLAN.md`,
    `.smike/${project}/ROADMAP.md`,
    `.smike/${project}/STRATEGY.md`,
    `.smike/${project}/PLAN-GRAPH.json`,
    `.smike/${project}/STATE.json`,
    ...phaseIds.map((phaseId) => `.smike/${project}/phases/${phaseId}/${phaseId}-PLAN.json`),
  ];
  if (planningAnalysis.checker_enabled) {
    artifacts.push(`.smike/${project}/CHECKER.json`);
  }
  if (planningAnalysis.auditor_enabled) {
    artifacts.push(`.smike/${project}/AUDITOR.json`);
  }
  const expectedPlans = [`${project}-plan`, ...phaseIds];

  const script = [
    "const fs = require('fs')",
    "const path = require('path')",
    "const projectRoot = process.cwd()",
    `const files = ${JSON.stringify(artifacts)}`,
    "const missing = files.filter((file) => !fs.existsSync(path.join(projectRoot, file)))",
    "if (missing.length > 0) { console.error('missing:' + missing.join(',')); process.exit(1); }",
    `const graphPath = path.join(projectRoot, '.smike', ${JSON.stringify(project)}, 'PLAN-GRAPH.json')`,
    "const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))",
    "const plans = new Set((graph.plans || []).map((plan) => plan.plan))",
    `const missingPlans = ${JSON.stringify(expectedPlans)}.filter((planId) => !plans.has(planId))`,
    "if (missingPlans.length > 0) { console.error('missing_plans:' + missingPlans.join(',')); process.exit(1); }",
    "process.stdout.write('planning-bundle-ready')",
  ].join('; ');

  return `node -e ${JSON.stringify(script)}`;
}

function buildPlanningReportCheckCommand(project, reportName) {
  const normalizedName = String(reportName || '').toUpperCase();
  const jsonRel = `.smike/${project}/${normalizedName}.json`;
  const script = [
    "const fs = require('fs')",
    "const path = require('path')",
    "const projectRoot = process.cwd()",
    `const reportPath = path.join(projectRoot, ${JSON.stringify(jsonRel)})`,
    "if (!fs.existsSync(reportPath)) { console.error('missing:' + reportPath); process.exit(1); }",
    "const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))",
    "if (!report || typeof report !== 'object' || Array.isArray(report)) { console.error('invalid-report'); process.exit(1); }",
    "if (!Array.isArray(report.findings)) { console.error('missing-findings'); process.exit(1); }",
    "const blocking = report.findings.filter((finding) => finding && finding.severity && finding.severity !== 'low')",
    `if (String(report.result || '') !== 'pass' || blocking.length > 0) { console.error('blocking-findings:' + blocking.map((finding) => finding.id || 'unknown').join(',')); process.exit(1); }`,
    `process.stdout.write(${JSON.stringify(`${normalizedName.toLowerCase()}-ready`)})`,
  ].join('; ');

  return `node -e ${JSON.stringify(script)}`;
}

function buildCustomVerifyCommand(run, index) {
  const normalizedRun = String(run || '').trim();
  const commandId = `verify-${index + 1}`;
  const timeoutMs = /\b(test|vitest|jest|tsc|typecheck|build)\b/i.test(normalizedRun) ? 600000 : 120000;
  return {
    id: commandId,
    run: normalizedRun,
    cwd: '../..',
    timeout_ms: timeoutMs,
    expect: {
      exit_code: 0,
    },
  };
}

function buildPhaseVerifyCommands(project, phase, primaryRefs, mode = 'implementation') {
  const commands = [];
  const explicitVerifyCommands = normalizeStringArray(phase.declared_verify_commands || []);
  const hasCodeScope = phase.allowed_files.some((filePath) => /^(packages|tests|scripts)\//.test(filePath));
  const docsToCheck = primaryRefs
    .filter((ref) => ref.endsWith('.md') || ref === 'AGENTS.md')
    .slice(0, 6);

  if (mode === 'research') {
    commands.push({
      id: 'research-artifacts',
      run: buildResearchArtifactCheckCommand(project, phase),
      cwd: '../..',
      timeout_ms: 30000,
      expect: {
        exit_code: 0,
        stdout_includes: ['research-artifacts-ready'],
      },
    });
  }

  if (mode !== 'research' && explicitVerifyCommands.length > 0) {
    commands.push(...explicitVerifyCommands.map((run, index) => buildCustomVerifyCommand(run, index)));
  }

  if (mode !== 'research' && commands.length === 0) {
    const category = phase.category || 'general';
    const shouldAddTypecheck = hasCodeScope || ['permissions', 'route-architecture', 'verification', 'ui-component', 'migration'].includes(category);
    const shouldAddUnitTests = hasCodeScope || ['permissions', 'route-architecture', 'verification', 'ui-component', 'migration'].includes(category);

    if (shouldAddTypecheck) {
      commands.push({
        id: 'typecheck',
        run: 'npm run typecheck',
        cwd: '../..',
        timeout_ms: 600000,
        expect: {
          exit_code: 0,
        },
      });
    }

    if (shouldAddUnitTests) {
      commands.push({
        id: 'unit-tests',
        run: guardTestVerifyCommand('npm run test:unit'),
        cwd: '../..',
        timeout_ms: 600000,
        expect: {
          exit_code: 0,
        },
      });
    }
  }

  if (docsToCheck.length > 0 && (mode === 'research' || commands.length === 0 || phase.category === 'doc-drift')) {
    commands.push({
      id: 'doc-paths',
      run: buildDocCheckCommand(docsToCheck),
      cwd: '../..',
      timeout_ms: 30000,
      expect: {
        exit_code: 0,
        stdout_includes: ['docs-ready'],
      },
    });
  }

  if (commands.length === 0) {
    commands.push({
      id: 'phase-ready',
      run: "node -e \"process.stdout.write('phase-ready')\"",
      cwd: '../..',
      timeout_ms: 30000,
      expect: {
        exit_code: 0,
        stdout_includes: ['phase-ready'],
      },
    });
  }

  return commands;
}

function buildAcceptanceCriteria(commands, prefix) {
  return commands.map((command, index) => ({
    id: `AC-${index + 1}`,
    description: `${prefix}: ${command.id}`,
    command_ids: [command.id],
    signals: [
      {
        command_id: command.id,
        expected_signal: command.expect?.stdout_includes?.[0]
          ? `exit=0 && stdout~${command.expect.stdout_includes[0]}`
          : 'exit=0',
      },
    ],
  }));
}

function parsePhaseBlueprintLine(line) {
  const match = line.trim().match(/^-\s*Plan\s+(\d+):\s+(.+?)\s*(?:\(([^)]+)\))?$/i);
  if (!match) {
    return null;
  }

  const directiveText = cleanDirectiveValue(match[3] || '');
  const directives = Object.fromEntries(
    directiveText
      .split(/\s*;\s*/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf(':');
        if (separatorIndex === -1) {
          return [part.toLowerCase(), 'true'];
        }
        return [
          cleanDirectiveValue(part.slice(0, separatorIndex)).toLowerCase(),
          cleanDirectiveValue(part.slice(separatorIndex + 1)),
        ];
      }),
  );

  return {
    id: match[1].padStart(2, '0'),
    title: cleanMarkdownInline(match[2]),
    declared_depends_on: normalizePathList(
      String(directives.depends || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => value.padStart(2, '0')),
    ),
    declared_category: directives.category ? cleanMarkdownInline(directives.category) : null,
    declared_write_scope: normalizePathList(
      String(directives.write_scope || directives.scope || '')
        .split(',')
        .map((value) => value.trim().replaceAll('\\', '/'))
        .filter(Boolean),
    ),
    declared_verify_commands: normalizeStringArray(
      String(directives.verify || '')
        .split('|')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  };
}

const DELIVERABLE_SECTION_PATTERNS = [
  /^Required Deliverable From This Loop$/i,
  /^Required Deliverables From This Loop$/i,
  /^Planner Must Produce$/i,
  /^Main Deliverable$/i,
  /^Main Deliverables$/i,
  /^Required Deliverables From Planning$/i,
  /^Required Deliverables From Execution$/i,
];

const PLANNING_SHAPE_SECTION_PATTERNS = [
  /^Required Planning Output Shape$/i,
  /^Planning Output Shape$/i,
];

const REQUIRED_PLAN_01_CONTRACT_PATTERNS = [
  /^Required Plan 01 Contract$/i,
  /^Plan 01 Contract$/i,
];
const LEGACY_RECOMMENDED_EXECUTABLE_PATTERN = /^Recommended First Executable Phase$/i;

const NON_GOAL_SECTION_PATTERNS = [
  /^Explicit Non-Goals$/i,
  /^Scope Out$/i,
];

function findSectionByPatterns(sections, patterns) {
  for (const pattern of patterns) {
    const section = findSection(sections, pattern);
    if (section) {
      return section;
    }
  }
  return null;
}

function extractListItemsFromSectionPatterns(sections, patterns) {
  return patterns.flatMap((pattern) => extractListItems(sectionText(findSection(sections, pattern))));
}

function findFirstPhaseContractSection(sections) {
  return findSectionByPatterns(sections, [
    ...REQUIRED_PLAN_01_CONTRACT_PATTERNS,
    LEGACY_RECOMMENDED_EXECUTABLE_PATTERN,
  ]);
}

function buildPlanningLintFindings(sections) {
  const findings = [];
  const hasObjective = Boolean(sectionText(findSection(sections, /^Objective$/i)));
  const hasDeliverables = extractListItemsFromSectionPatterns(sections, DELIVERABLE_SECTION_PATTERNS).length > 0;
  const hasPlanningShape = Boolean(findSectionByPatterns(sections, PLANNING_SHAPE_SECTION_PATTERNS))
    || sections.some((section) => /^Priority\s+\d+:/i.test(section.title));
  const hasLegacyRecommendedExecutable = Boolean(findSection(sections, LEGACY_RECOMMENDED_EXECUTABLE_PATTERN));

  if (!hasObjective) {
    findings.push({
      id: 'spec-missing-objective',
      severity: 'medium',
      title: 'The spec is missing an Objective section',
      details: 'Add `## Objective` so the planner can distinguish the loop goal from implementation details.',
    });
  }

  if (!hasDeliverables) {
    findings.push({
      id: 'spec-missing-deliverables',
      severity: 'medium',
      title: 'The spec is missing required deliverables',
      details: 'Add `## Required Deliverable From This Loop` or `## Planner Must Produce` so planning can audit coverage.',
    });
  }

  if (!hasPlanningShape) {
    findings.push({
      id: 'spec-missing-planning-shape',
      severity: 'high',
      title: 'The spec does not define a planning shape',
      details: 'Add `## Required Planning Output Shape` or `## Priority N:` sections. Silent fallback to a single implementation phase is no longer enough.',
    });
  }

  if (!hasPlanningShape && hasLegacyRecommendedExecutable) {
    findings.push({
      id: 'spec-legacy-recommended-phase-only',
      severity: 'high',
      title: 'The spec only provides a legacy recommended executable phase hint',
      details: '`## Recommended First Executable Phase` is now treated as a legacy alias. Prefer `## Required Plan 01 Contract`, and still add `## Required Planning Output Shape` or `## Priority N:` sections so the planner has a real decomposition.',
    });
  }

  return {
    result: findings.some((finding) => finding.severity !== 'low') ? 'concerns' : 'pass',
    findings,
  };
}

function extractPhaseBlueprints(sections) {
  const recommendedSection = findSectionByPatterns(sections, PLANNING_SHAPE_SECTION_PATTERNS);
  const recommendedLines = sectionText(recommendedSection).split(/\r?\n/);
  const recommendedPhases = [];

  for (const line of recommendedLines) {
    const phase = parsePhaseBlueprintLine(line);
    if (phase) {
      recommendedPhases.push(phase);
    }
  }

  const prioritySections = sections.filter((section) => /^Priority\s+\d+:/i.test(section.title));
  if (recommendedPhases.length > 0) {
    return recommendedPhases.map((phase, index) => {
      const prioritySection = prioritySections[index];
      const hasPrioritySummary = Boolean(sectionText(prioritySection));
      const summary = summarizeSection(
        sectionText(prioritySection),
        `Implement ${phase.title.toLowerCase()}.`,
      );
      return {
        ...phase,
        summary,
        summary_source: hasPrioritySummary ? 'priority' : 'fallback_blueprint',
        category: phase.declared_category || inferPhaseCategory(`${phase.title} ${summary}`),
        dependency_mode: phase.declared_depends_on.length > 0 ? 'explicit' : 'implicit',
      };
    });
  }

  if (prioritySections.length > 0) {
    return prioritySections.map((section, index) => {
      const title = cleanMarkdownInline(section.title.replace(/^Priority\s+\d+:\s*/i, ''));
      const hasPrioritySummary = Boolean(sectionText(section));
      const summary = summarizeSection(sectionText(section), `Implement ${title.toLowerCase()}.`);
      return {
        id: String(index + 1).padStart(2, '0'),
        title,
        summary,
        summary_source: hasPrioritySummary ? 'priority' : 'fallback_priority',
        category: inferPhaseCategory(`${title} ${summary}`),
        declared_depends_on: [],
        declared_write_scope: [],
        declared_verify_commands: [],
        dependency_mode: 'implicit',
      };
    });
  }

  const firstPhaseContractSection = findFirstPhaseContractSection(sections);
  if (firstPhaseContractSection) {
    const title = 'Plan 01 contract';
    const summary = summarizeSection(sectionText(firstPhaseContractSection), 'Implement the Plan 01 contract.');
    return [
      {
        id: '01',
        title,
        summary,
        summary_source: 'first_phase_contract',
        category: inferPhaseCategory(`${title} ${summary}`),
        declared_depends_on: [],
        declared_write_scope: [],
        declared_verify_commands: [],
        dependency_mode: 'recommended',
      },
    ];
  }

  return [
    {
      id: '01',
      title: 'Implementation',
      summary: 'Implement the spec in bounded, reviewable slices.',
      summary_source: 'fallback_implementation',
      category: 'general',
      declared_depends_on: [],
      declared_write_scope: [],
      declared_verify_commands: [],
      dependency_mode: 'fallback',
    },
  ];
}

function buildPlanningBundle(project, specRel, contextFiles) {
  const specPath = path.join(REPO_ROOT, specRel);
  const specText = fs.readFileSync(specPath, 'utf8');
  const sections = parseMarkdownSections(specText);
  const mode = inferPlanningMode(specText);
  const intakePrompt = summarizeSection(
    sectionText(findSection(sections, /^Intake Prompt$/i)),
    '',
  );
  const objective = summarizeSection(
    sectionText(findSection(sections, /^Objective$/i)),
    `Implement ${project}.`,
  );
  const refsFromRequiredRead = extractListItems(sectionText(findSection(sections, /^What The Planner Must Read First$/i)))
    .map((value) => normalizeRel(value))
    .filter(looksLikeRepoPath);
  const requiredPlanningPostureText = sectionText(findSection(sections, /^Required Planning Posture$/i));
  const requiredPlanningRefs = extractRepoPathsFromText(requiredPlanningPostureText);
  const primaryRefs = normalizePathList([
    ...extractPrimaryRefs(specText),
    ...refsFromRequiredRead,
    ...requiredPlanningRefs,
    ...contextFiles,
  ]);
  const deliverables = normalizePathList(extractListItemsFromSectionPatterns(sections, DELIVERABLE_SECTION_PATTERNS));
  const lint = buildPlanningLintFindings(sections);
  const extractedPhases = extractPhaseBlueprints(sections);
  const integrationRequirementsText = sectionText(findSection(sections, /^Integration Requirements$/i));
  const planningDecisions = extractLabeledListItems(integrationRequirementsText, /^The plan must decide:?$/i);
  const integrationRequirements = extractListItems(integrationRequirementsText)
    .filter((item) => !planningDecisions.includes(item));
  const riskHotspots = extractListItems(sectionText(findSection(sections, /^Risk Hotspots$/i)));
  const firstPhaseContractSection = findFirstPhaseContractSection(sections);
  const firstPhaseContractText = sectionText(firstPhaseContractSection);
  const firstPhaseContractItems = extractListItems(firstPhaseContractText);
  const clarifyingQuestions = extractListItems(sectionText(findSection(sections, /^Clarifying Questions$/i)));
  const explicitDeferrals = extractListItems(sectionText(findSection(sections, /^Explicit Deferrals$/i)));
  const unresolvedRefTokens = uniqueStrings(String(specText || '').match(/@ref[^\s`)]*/g) || []);
  const explicitDependenciesDeclared = extractedPhases.some((phase) => ensureArray(phase.declared_depends_on).length > 0);
  const phaseBlueprints = extractedPhases.map((phase, index, allPhases) => {
    const writeScope = inferPhaseWriteScope(project, mode, phase, primaryRefs);
    return {
      ...phase,
      depends_on: explicitDependenciesDeclared
        ? ensureArray(phase.declared_depends_on)
        : index === 0 ? [] : [allPhases[index - 1].id],
      allowed_files: writeScope.allowed_files,
      blocked_files: writeScope.blocked_files,
      write_scope_allowed_files: writeScope.write_scope_allowed_files,
      write_scope_blocked_files: writeScope.write_scope_blocked_files,
      write_scope_reason: writeScope.write_scope_reason,
      research_reviewer_required: mode === 'research' ? researchPhaseNeedsReviewer(phase) : true,
    };
  });
  const planningAnalysis = buildPlanningAnalysisPolicy({
    mode,
    lint,
    deliverables,
    protected_areas: extractListItems(sectionText(findSection(sections, /^Protected \/ High-Collision Areas$/i))),
    primary_refs: primaryRefs,
  }, phaseBlueprints);

  return {
    title: extractMarkdownTitle(specText, project),
    intake_prompt: intakePrompt,
    objective,
    mode,
    primary_refs: primaryRefs,
    deliverables,
    constraints: extractListItems(sectionText(findSection(sections, /^Critical Constraints$/i))),
    non_goals: extractListItemsFromSectionPatterns(sections, NON_GOAL_SECTION_PATTERNS),
    required_planning_refs: requiredPlanningRefs,
    integration_requirements: integrationRequirements,
    planning_decisions: planningDecisions,
    risk_hotspots: riskHotspots,
    first_phase_contract_heading: firstPhaseContractSection?.title || null,
    first_phase_contract_summary: summarizeSection(firstPhaseContractText, ''),
    first_phase_contract_items: firstPhaseContractItems,
    recommended_first_phase_summary: summarizeSection(firstPhaseContractText, ''),
    recommended_first_phase_items: firstPhaseContractItems,
    explicit_deferrals: explicitDeferrals,
    clarifying_questions: clarifyingQuestions,
    protected_areas: extractListItems(sectionText(findSection(sections, /^Protected \/ High-Collision Areas$/i))),
    drift_seeds: extractListItems(sectionText(findSection(sections, /^Known Current Drift Seeds$/i))),
    lint,
    explicit_dependencies_declared: explicitDependenciesDeclared,
    unresolved_ref_tokens: unresolvedRefTokens,
    planning_analysis: planningAnalysis,
    phase_blueprints: phaseBlueprints,
    spec_paths: normalizePathList([specRel, ...contextFiles, ...extractRepoPathsFromText(specText)]),
    spec_hash: crypto.createHash('sha256').update(specText).digest('hex'),
  };
}

function buildPlanningDraftNextAction(project, promotionCheck, bundle = null) {
  const blockerText = promotionCheck.blockers.slice(0, 6).join('; ');
  const questionText = ensureArray(bundle?.clarifying_questions).slice(0, 2).join(' / ');
  const suffixBits = [];
  if (questionText) {
    suffixBits.push(`Answer onboarding questions: ${questionText}.`);
  }
  if (blockerText) {
    suffixBits.push(`Missing before promotion: ${blockerText}.`);
  }
  const suffix = suffixBits.length > 0 ? ` ${suffixBits.join(' ')}` : '';
  return `Refine the spec-driven planning draft for ${project} (update the spec, not \`.smike/**\`), then rerun \`${buildCycleCommand(project)}\`.${suffix}`;
}

function getPlanningDraftNoticeLines(state) {
  if (!isPlanningDraftLifecycleStatus(state?.lifecycle?.status) && state?.planning?.status !== 'draft') {
    return [];
  }
  return [
    'Planning draft notice: edits to `.smike/**` are rebuilt from the spec on the next cycle.',
    'Fix surface: update the spec’s `Required Planning Output Shape`, `Priority N:` summaries, and inline `verify:` commands.',
  ];
}

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

function renderStateMarkdown(project, specRel, state) {
  const paths = getProjectPaths(project);
  const rootPlan = fs.existsSync(paths.planJsonPath) ? readJson(paths.planJsonPath) : {};
  const workflowPlans = ensureArray(state.workflow?.plans);
  const groups = workflowPlans.length > 0 ? buildDependencyGroups(project, workflowPlans) : { parallel_groups: 0 };
  const graphSummary = workflowPlans.length > 0
    ? `Graph ready — ${workflowPlans.length} plans in ${groups.parallel_groups} group${groups.parallel_groups === 1 ? '' : 's'}`
    : state.lifecycle.status;
  const orchestration = ensureOrchestrationState(state);
  const latestCapsules = Object.entries(orchestration.capsules.latest_by_role || {})
    .filter(([, capsulePath]) => typeof capsulePath === 'string' && capsulePath.trim());
  const propagatedDiscoveries = ensureDiscoveryLog(state);
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  const actionable = runtimeContext.actionable;
  const delegation = runtimeContext.delegation;
  const currentDispatches = runtimeContext.dispatches;
  const readyDispatches = runtimeContext.ready_dispatches;
  const dispatchSummary = summarizeRuntimeDispatchContext(runtimeContext);
  const planningAnalysis = loadPlanningAnalysis(paths);
  const planningFreshness = getPlanningArtifactFreshness(paths);
  const actionableDispatch = orchestration.current_actionable_dispatch;
  const actionableDispatchSummary = actionableDispatch
    ? `${actionableDispatch.dispatch_id} (${actionableDispatch.role} / ${actionableDispatch.status}${actionableDispatch.freshness ? ` / ${actionableDispatch.freshness}` : ''})`
    : 'none';
  const actionableCapsule = orchestration.current_actionable_capsule || 'none';
  const planningBlockers = planningAnalysis.blocking_findings.slice(0, 3);
  const planningPrompt = typeof state.planning?.intake_prompt === 'string' ? state.planning.intake_prompt.trim() : '';
  const planningQuestions = ensureArray(state.planning?.clarifying_questions).slice(0, 5);
  const recentDiscoveries = propagatedDiscoveries.slice(-5);
  const operatorGuidance = getOperatorGuidanceLines(project, state);

  return [
    '# SMIKE State',
    '',
    '## Authority',
    `Canonical state: .smike/${project}/STATE.json`,
    'Canonical operator handoff: this file (`STATE.md`)',
    `Supporting views: .smike/${project}/IMPLEMENTATION-HANDOFF.json, .smike/${project}/PLANNING-HANDOFF.md`,
    '',
    '## Resume',
    `Project: ${project}`,
    `Spec: ${specRel}`,
    `Plan: ${graphSummary}`,
    `Current: ${state.current_plan?.plan_id || 'none'}`,
    `Status: ${state.lifecycle.status}`,
    `Next: ${state.lifecycle.next_action}`,
    `Next command: ${getLifecycleNextCommand(state) || 'none'}`,
    ...(state.lifecycle.stop_reason ? [`Stop reason: ${state.lifecycle.stop_reason}`] : []),
    `spec_hash: ${state.planning?.spec_hash || '(unknown)'}`,
    ...getPlanningDraftNoticeLines(state),
    '',
    '## Operator',
    'Read this file first in a fresh Codex session.',
    ...operatorGuidance.map((line) => `- ${line}`),
    '',
    '## Planning Analysis',
    `Checker: ${planningAnalysis.checker?.result || 'not-generated'}`,
    `Auditor: ${planningAnalysis.auditor?.result || 'not-generated'}`,
    `Artifacts fresh: ${planningFreshness.stale ? `no (${planningFreshness.reason})` : 'yes'}`,
    ...(planningBlockers.length > 0
      ? planningBlockers.map((finding) => `- ${finding.source}:${finding.id} ${finding.title}`)
      : ['- none']),
    ...(planningPrompt
      ? [
          '',
          '## Planning Intake',
          `Prompt: ${planningPrompt}`,
          ...(planningQuestions.length > 0
            ? planningQuestions.map((question) => `- ${question}`)
            : ['- no clarifying questions captured']),
        ]
      : []),
    '',
    '## Actionable Surface',
    `Stage: ${orchestration.stage}`,
    `Mode: ${delegation.mode}`,
    `Owner: ${delegation.owner}`,
    `Actionable plan: ${actionable.plan_id || 'none'}`,
    `Dispatch: ${actionableDispatchSummary}`,
    `Capsule: ${actionableCapsule}`,
    `Command: ${getLifecycleNextCommand(state) || 'none'}`,
    `Handoff: .smike/${project}/IMPLEMENTATION-HANDOFF.json`,
    `Planning handoff: .smike/${project}/PLANNING-HANDOFF.md`,
    '',
    '## Runtime Dispatches',
    `Dispatch group: ${dispatchSummary.group}`,
    `Completable group: ${currentCompletableRuntimeDispatchGroup(runtimeContext)}`,
    `Actionable plan ids: ${dispatchSummary.plan_ids}`,
    `Ready dispatches: ${readyDispatches.length}`,
    `Tracked dispatches: ${currentDispatches.length}`,
    ...(currentDispatches.length > 0
      ? currentDispatches.map((entry) => {
          const freshness = entry.freshness?.status || 'pending';
          return `- ${entry.dispatch_id}: ${entry.role} [group ${entry.group}] ${entry.status} / ${freshness}`;
        })
      : ['- none']),
    '',
    '## Notes',
    ...(latestCapsules.length > 0
      ? [`Latest capsules: ${latestCapsules.map(([role]) => role).join(', ')}`]
      : ['Latest capsules: none']),
    ...(ensureArray(state.gotchas).length > 0
      ? ensureArray(state.gotchas).slice(0, 5).map((gotcha) => `- Gotcha: ${gotcha}`)
      : ['- Gotcha: none']),
    ...(recentDiscoveries.length > 0
      ? recentDiscoveries.map((entry) => {
          const targets = ensureArray(entry.target_plan_ids).join(', ') || 'none';
          const discoveries = ensureArray(entry.discoveries).join('; ');
          return `- Discovery: ${entry.source_plan_id} -> ${targets}: ${discoveries}`;
        })
      : ['- Discovery: none']),
    '',
  ].join('\n');
}

function renderPlanningHandoffMarkdown(project, handoff) {
  const lines = [
    '# Planning Handoff',
    '',
    `Project: ${project}`,
    `Status: ${handoff.lifecycle?.status || 'unknown'}`,
    `Next: ${handoff.lifecycle?.next_action || 'unknown'}`,
    `Next command: ${handoff.lifecycle?.next_command || 'none'}`,
    '',
    '## Actionable Surface',
    `- Plan: ${handoff.actionable_surface?.plan_id || 'none'}`,
    `- Dispatch group: ${handoff.actionable_surface?.dispatch_group ?? 'none'}`,
    `- Current dispatch: ${handoff.actionable_surface?.current_dispatch?.dispatch_id || 'none'}`,
    `- Capsule: ${handoff.actionable_surface?.current_capsule || 'none'}`,
    `- Handoff: .smike/${project}/IMPLEMENTATION-HANDOFF.json`,
    '',
    '## Phase Graph',
  ];

  for (const phase of ensureArray(handoff.phase_graph)) {
    lines.push(`- ${phase.plan_id}: depends on ${ensureArray(phase.depends_on).join(', ') || 'none'}`);
    lines.push(`  Scope: ${ensureArray(phase.write_scope).join(', ') || 'none'}`);
    lines.push(`  Acceptance: ${ensureArray(phase.acceptance_surface).join('; ') || 'none'}`);
  }

  lines.push('');
  lines.push('## Deferred Items');
  for (const item of ensureArray(handoff.deferred_items)) {
    lines.push(`- ${item}`);
  }
  if (ensureArray(handoff.deferred_items).length === 0) {
    lines.push('- none');
  }

  lines.push('');
  lines.push('## Protected Areas');
  for (const item of ensureArray(handoff.protected_areas)) {
    lines.push(`- ${item}`);
  }
  if (ensureArray(handoff.protected_areas).length === 0) {
    lines.push('- none');
  }

  return `${lines.join('\n')}\n`;
}

function renderRoadmapMarkdown(project, bundle) {
  const lines = [
    '# ROADMAP',
    '',
    `Project: ${project}`,
    `Mode: ${bundle.mode}`,
    `Objective: ${bundle.objective}`,
    '',
    '## Phase Graph',
    '| Plan | Title | Depends On | Category | Write Scope |',
    '|---|---|---|---|---|',
    ...bundle.phase_blueprints.map((phase) => `| ${phase.id} | ${phase.title} | ${phase.depends_on.join(', ') || '—'} | ${phase.category} | ${phase.write_scope_allowed_files.slice(0, 4).join(', ')} |`),
    '',
    '## Protected Areas',
  ];

  if (bundle.protected_areas.length === 0) {
    lines.push('- none captured from spec');
  } else {
    bundle.protected_areas.forEach((area) => lines.push(`- ${area}`));
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function renderStrategyMarkdown(project, bundle) {
  const lines = [
    '# STRATEGY',
    '',
    `Project: ${project}`,
    `Mode: ${bundle.mode}`,
    `Objective: ${bundle.objective}`,
    '',
    '## Truth Sources',
  ];

  if (bundle.primary_refs.length === 0) {
    lines.push('- none captured from spec');
  } else {
    bundle.primary_refs.forEach((ref) => lines.push(`- ${ref}`));
  }

  lines.push('');
  lines.push('## Deliverables');
  if (bundle.deliverables.length === 0) {
    lines.push('- produce a bounded implementation plan');
  } else {
    bundle.deliverables.forEach((deliverable) => lines.push(`- ${deliverable}`));
  }

  lines.push('');
  lines.push('## Critical Constraints');
  if (bundle.constraints.length === 0) {
    lines.push('- none captured from spec');
  } else {
    bundle.constraints.forEach((constraint) => lines.push(`- ${constraint}`));
  }

  if (bundle.integration_requirements.length > 0) {
    lines.push('');
    lines.push('## Integration Requirements');
    bundle.integration_requirements.forEach((item) => lines.push(`- ${item}`));
  }

  if (bundle.planning_decisions.length > 0) {
    lines.push('');
    lines.push('## Planning Decisions');
    bundle.planning_decisions.forEach((item) => lines.push(`- ${item}`));
  }

  if (bundle.risk_hotspots.length > 0) {
    lines.push('');
    lines.push('## Risk Hotspots');
    bundle.risk_hotspots.forEach((item) => lines.push(`- ${item}`));
  }

  if (bundle.protected_areas.length > 0) {
    lines.push('');
    lines.push('## Protected Areas');
    bundle.protected_areas.forEach((item) => lines.push(`- ${item}`));
  }

  lines.push('');
  lines.push('## Drift Seeds');
  if (bundle.drift_seeds.length === 0) {
    lines.push('- none captured from spec');
  } else {
    bundle.drift_seeds.forEach((seed) => lines.push(`- ${seed}`));
  }

  lines.push('');
  lines.push('## Phase Plan');
  bundle.phase_blueprints.forEach((phase) => {
    const phaseBits = [
      `${phase.id}: ${phase.title}`,
      phase.summary,
      `depends ${phase.depends_on.join(', ') || 'none'}`,
      `scope ${phase.write_scope_allowed_files.join(', ') || 'none'}`,
    ];
    if (ensureArray(phase.declared_verify_commands).length > 0) {
      phaseBits.push(`verify ${phase.declared_verify_commands.join(' | ')}`);
    }
    lines.push(`- ${phaseBits.join(' | ')}`);
  });
  lines.push('');

  if (bundle.first_phase_contract_items.length > 0) {
    lines.push('## Required Plan 01 Contract');
    if (bundle.first_phase_contract_summary) {
      lines.push(`Summary: ${bundle.first_phase_contract_summary}`);
    }
    if (bundle.first_phase_contract_heading === 'Recommended First Executable Phase') {
      lines.push('Legacy heading detected: `Recommended First Executable Phase`.');
    }
    bundle.first_phase_contract_items.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }

  if (bundle.explicit_deferrals.length > 0) {
    lines.push('## Deferred Items');
    bundle.explicit_deferrals.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }

  if (bundle.non_goals.length > 0) {
    lines.push('## Non-Goals');
    bundle.non_goals.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function renderPlanningPlanMarkdown(specRel, contextFiles, bundle) {
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
      primaryPaths: [rootPlan.spec, ...bundle.primary_refs.slice(0, CAPSULE_REF_LIMIT)],
      additionalPaths: [
        `.smike/${project}/PROJECT.md`,
        `.smike/${project}/ROADMAP.md`,
        `.smike/${project}/STRATEGY.md`,
        ...bundle.spec_paths.slice(0, CAPSULE_REF_LIMIT),
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
        recommended_first_phase_items: bundle.recommended_first_phase_items,
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
        `.smike/${project}/ROADMAP.md`,
        `.smike/${project}/STRATEGY.md`,
        `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`,
      ],
      additionalPaths: [...bundle.primary_refs.slice(0, CAPSULE_REF_LIMIT)],
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
        `.smike/${project}/ROADMAP.md`,
        `.smike/${project}/STRATEGY.md`,
        ...bundle.phase_blueprints.map((phase) => `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`),
      ],
      additionalPaths: [...bundle.primary_refs.slice(0, CAPSULE_REF_LIMIT)],
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
        `.smike/${project}/ROADMAP.md`,
        ...bundle.phase_blueprints.map((phase) => `.smike/${project}/phases/${phase.id}/${phase.id}-PLAN.json`),
      ],
      additionalPaths: [...bundle.primary_refs.slice(0, CAPSULE_REF_LIMIT)],
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
  plan.$schema = ROOT_PLAN_SCHEMA_REF;
  const phaseIds = bundle.phase_blueprints.map((phase) => phase.id);
  const planningAnalysis = resolvePlanningAnalysisForMode(bundle, planningMode);
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
  plan.workflow = {
    auto_continue: true,
    stop_on_failure: true,
    max_phases_per_run: DEFAULT_MAX_PHASES_PER_RUN,
    phase_plans: phaseIds.map((phaseId) => `phases/${phaseId}/${phaseId}-PLAN.json`),
  };
  plan.delegation = {
    mode: 'runtime_subagents',
    owner: 'runtime_orchestrator',
    runtime_roles: ['strategist', 'detailer'],
    dispatch_artifacts: [
      `.smike/${project}/STATE.json`,
    ],
    result_artifacts: [
      `.smike/${project}/STRATEGY.md`,
      `.smike/${project}/ROADMAP.md`,
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
  return {
    $schema: PHASE_PLAN_SCHEMA_REF,
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
      required_tools: ['node', 'npm', 'git'],
      required_env_vars: [],
    },
    verify_commands: commands,
    acceptance_criteria: buildAcceptanceCriteria(commands, `${phase.id} verification`),
    postflight: {
      commands: [],
    },
    workflow: {
      auto_continue: true,
      stop_on_failure: true,
      max_phases_per_run: 1,
      phase_plans: [],
    },
    delegation: {
      mode: isResearch ? 'runtime_subagents' : 'auto',
      owner: isResearch ? 'runtime_orchestrator' : 'smike_runner',
      runtime_roles: isResearch ? ['executor', 'judge', ...(reviewerRequired ? ['reviewer'] : [])] : ['executor'],
      dispatch_artifacts: [
        `.smike/${project}/STATE.json`,
      ],
      result_artifacts: isResearch && researchResults
        ? [researchResults.jsonRel]
        : [],
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
    feature_flags: {
      phase_refresh_mode: phaseRefreshMode,
    },
  };
}

function buildPlanningState(project, specRel, contextFiles, plan, bundle, planningMode = 'active', inputSnapshot = null) {
  const state = readTemplateJson('STATE.json');
  state.$schema = ROOT_STATE_SCHEMA_REF;
  const rootPlanHash = hashPlanContract(plan);
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
    status: planningMode === 'draft' ? PLANNING_DRAFT_LIFECYCLE_STATUS : 'planning',
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
    stop_on_failure: true,
    max_phases_per_run: DEFAULT_MAX_PHASES_PER_RUN,
    plans: [],
  };
  state.history = [];
  state.gotchas = trimStateGotchas(bundle.drift_seeds, STATE_GOTCHA_LIMIT, { keepLatest: false });
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

function writePlanningAnalysisArtifacts(project, paths, bundle, phaseContracts, planningMode = 'active') {
  const planningAnalysis = resolvePlanningAnalysisForMode(bundle, planningMode);
  const analysisPlans = phaseContracts.map((contract) => contract.analysisPlan);
  const removeIfExists = (filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  };

  if (planningAnalysis.checker_enabled) {
    const checkerRecord = buildPlanningCheckerRecord(bundle, analysisPlans);
    writeJson(paths.planningCheckerJsonPath, checkerRecord);
    removeIfExists(paths.planningCheckerMdPath);
  } else {
    removeIfExists(paths.planningCheckerJsonPath);
    removeIfExists(paths.planningCheckerMdPath);
  }

  if (planningAnalysis.auditor_enabled) {
    const auditorRecord = buildPlanningAuditorRecord(bundle, analysisPlans);
    writeJson(paths.planningAuditorJsonPath, auditorRecord);
    removeIfExists(paths.planningAuditorMdPath);
    removeIfExists(paths.planningAuditJsonPath);
    removeIfExists(paths.planningAuditMdPath);
  } else {
    removeIfExists(paths.planningAuditorJsonPath);
    removeIfExists(paths.planningAuditorMdPath);
    removeIfExists(paths.planningAuditJsonPath);
    removeIfExists(paths.planningAuditMdPath);
  }
}

function buildPlanningAnalysisPlanFromCurrentPhasePlan(phasePlan) {
  return {
    ...phasePlan,
    dependency_mode: phasePlan?.dependency_mode || phasePlan?.metadata?.dependency_mode || 'implicit',
    declared_write_scope: normalizePathList(
      phasePlan?.declared_write_scope
      || phasePlan?.metadata?.declared_write_scope
      || phasePlan?.write_scope?.allowed_files
      || [],
    ),
    declared_verify_commands: normalizeStringArray(
      phasePlan?.declared_verify_commands
      || phasePlan?.metadata?.declared_verify_commands
      || ensureArray(phasePlan?.verify_commands).map((command) => command?.id),
    ),
    write_scope_allowed_files: normalizePathList(
      phasePlan?.write_scope_allowed_files
      || phasePlan?.metadata?.write_scope_allowed_files
      || phasePlan?.write_scope?.allowed_files
      || [],
    ),
  };
}

function readPlanningAnalysisPlansFromDisk(project, paths, bundle) {
  return ensureArray(bundle.phase_blueprints).map((phase) => {
    const phasePlanJsonPath = path.join(paths.projectDir, 'phases', phase.id, `${phase.id}-PLAN.json`);
    if (!fs.existsSync(phasePlanJsonPath)) {
      fail(`missing planning phase contract: ${phasePlanJsonPath}`);
    }
    return buildPlanningAnalysisPlanFromCurrentPhasePlan(readJson(phasePlanJsonPath));
  });
}

function refreshPlanningAnalysisArtifactsFromCurrentPlans(project, paths, bundle) {
  const planningAnalysis = resolvePlanningAnalysisForMode(bundle, 'active');
  const analysisPlans = readPlanningAnalysisPlansFromDisk(project, paths, bundle);
  const removeIfExists = (filePath) => {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  };

  if (planningAnalysis.checker_enabled) {
    writeJson(paths.planningCheckerJsonPath, buildPlanningCheckerRecord(bundle, analysisPlans));
    removeIfExists(paths.planningCheckerMdPath);
  } else {
    removeIfExists(paths.planningCheckerJsonPath);
    removeIfExists(paths.planningCheckerMdPath);
  }

  if (planningAnalysis.auditor_enabled) {
    writeJson(paths.planningAuditorJsonPath, buildPlanningAuditorRecord(bundle, analysisPlans));
    removeIfExists(paths.planningAuditorMdPath);
    removeIfExists(paths.planningAuditJsonPath);
    removeIfExists(paths.planningAuditMdPath);
  } else {
    removeIfExists(paths.planningAuditorJsonPath);
    removeIfExists(paths.planningAuditorMdPath);
    removeIfExists(paths.planningAuditJsonPath);
    removeIfExists(paths.planningAuditMdPath);
  }
}

function writePlanningArtifacts(project, specRel, contextFiles, options = {}) {
  const planningMode = options.planningMode === 'draft' ? 'draft' : 'active';
  const paths = getProjectPaths(project);
  ensureDir(paths.projectDir);

  const bundle = buildPlanningBundle(project, specRel, contextFiles);
  const plan = buildPlanningRootPlan(project, specRel, contextFiles, bundle, planningMode);
  const inputSnapshot = snapshotProjectInputs(project, paths, specRel, contextFiles);
  const state = buildPlanningState(project, specRel, contextFiles, plan, bundle, planningMode, inputSnapshot);
  const phaseContracts = buildPlanningPhaseContracts(project, specRel, bundle);

  writeJson(paths.projectMetaPath, {
    schema_version: '1.0.0',
    project,
    title: bundle.title,
    mode: bundle.mode,
    spec_path: specRel,
    context_files: contextFiles,
    input_snapshot: inputSnapshot,
    primary_refs: bundle.primary_refs,
    deliverables: bundle.deliverables,
    created_at: state.created_at,
    updated_at: state.updated_at,
  });
  fs.writeFileSync(paths.projectMdPath, renderProjectMarkdown(project, specRel, contextFiles, bundle), 'utf8');
  fs.writeFileSync(paths.roadmapPath, renderRoadmapMarkdown(project, bundle), 'utf8');
  fs.writeFileSync(paths.strategyPath, renderStrategyMarkdown(project, bundle), 'utf8');
  writeJson(paths.planJsonPath, plan);
  fs.writeFileSync(paths.planMdPath, renderPlanningPlanMarkdown(specRel, contextFiles, bundle), 'utf8');

  for (const { phase, phasePlan } of phaseContracts) {
    const phaseDir = path.join(paths.projectDir, 'phases', phase.id);
    ensureDir(phaseDir);
    const phasePlanJsonPath = path.join(phaseDir, `${phase.id}-PLAN.json`);
    writeJson(phasePlanJsonPath, phasePlan);
    const legacyPhasePlanMdPath = path.join(phaseDir, `${phase.id}-PLAN.md`);
    if (fs.existsSync(legacyPhasePlanMdPath)) {
      fs.unlinkSync(legacyPhasePlanMdPath);
    }
    if (bundle.mode === 'research') {
      const researchPaths = getResearchResultPaths(project, phase.id);
      const researchJsonPath = path.join(REPO_ROOT, researchPaths.jsonRel);
      if (!fs.existsSync(researchJsonPath)) {
        writeJson(researchJsonPath, buildResearchFindingsTemplate(project, phase));
      }
      const legacyResearchMdPath = path.join(REPO_ROOT, `.smike/${project}/phases/${phase.id}/${phase.id}-FINDINGS.md`);
      if (fs.existsSync(legacyResearchMdPath)) {
        fs.unlinkSync(legacyResearchMdPath);
      }
    }
  }

  writePlanningAnalysisArtifacts(project, paths, bundle, phaseContracts, planningMode);

  const workflowSettings = resolveWorkflowSettings(plan, {});
  const contracts = buildWorkflowContracts(paths, plan, workflowSettings);
  syncWorkflowState(state, contracts, workflowSettings);
  writePlanningRoleCapsules(project, paths, bundle, plan, state);
  syncActionableRuntimeDispatchState(project, paths, state, plan);
  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.stateMdPath, renderStateMarkdown(project, specRel, state), 'utf8');
  generateDerivedArtifacts(project, paths, state, plan);
}

function shouldRefreshPlanningArtifacts(paths) {
  if (!fs.existsSync(paths.planJsonPath) || !fs.existsSync(paths.statePath)) {
    return true;
  }
  if (!fs.existsSync(paths.roadmapPath) || !fs.existsSync(paths.strategyPath)) {
    return true;
  }

  try {
    const plan = readJson(paths.planJsonPath);
    const state = readJson(paths.statePath);
    const isDraft = isPlanningDraftState(state);
    if (plan?.plan_id === LEGACY_PLACEHOLDER_PLAN_ID) {
      return true;
    }
    if (isDraft) {
      return true;
    }
    if (!fs.existsSync(paths.planningCheckerJsonPath)) {
      return true;
    }
    if (!fs.existsSync(paths.planningAuditorJsonPath)) {
      return true;
    }

    const project = path.basename(paths.projectDir);
    const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : {};
    const specRel = typeof plan?.spec === 'string' ? plan.spec : null;
    const contextFiles = normalizePathList(projectMeta?.context_files || []);
    const runtimeOwnedPlanning = inferPlanStage(project, plan) === 'planning'
      && normalizeDelegationConfig(plan).mode === 'runtime_subagents';
    if (specRel && fs.existsSync(path.join(REPO_ROOT, specRel))) {
      const expectedBundle = buildPlanningBundle(project, specRel, contextFiles);
      const expectedPhaseContracts = buildPlanningPhaseContracts(project, specRel, expectedBundle);
      if (projectMeta?.mode && projectMeta.mode !== expectedBundle.mode) {
        return true;
      }

      for (const { phase, phasePlan } of expectedPhaseContracts) {
        const phasePlanPath = path.join(paths.projectDir, 'phases', phase.id, `${phase.id}-PLAN.json`);
        if (!fs.existsSync(phasePlanPath)) {
          return true;
        }
        const currentPhasePlan = readJson(phasePlanPath);
        if (runtimeOwnedPlanning) {
          continue;
        }
        if (
          JSON.stringify(normalizePathList(currentPhasePlan.write_scope?.allowed_files || []))
          !== JSON.stringify(normalizePathList(phasePlan.write_scope?.allowed_files || []))
        ) {
          return true;
        }
        if (currentPhasePlan.scope !== phasePlan.scope) {
          return true;
        }
        const currentVerifyIds = normalizePathList(
          ensureArray(currentPhasePlan.verify_commands).map((command) => command?.id),
        );
        const expectedVerifyIds = normalizePathList(
          ensureArray(phasePlan.verify_commands).map((command) => command?.id),
        );
        if (JSON.stringify(currentVerifyIds) !== JSON.stringify(expectedVerifyIds)) {
          return true;
        }
      }

      if (runtimeOwnedPlanning) {
        return false;
      }

      const expectedCheckerRecord = buildPlanningCheckerRecord(
        expectedBundle,
        expectedPhaseContracts.map((contract) => contract.analysisPlan),
      );
      const expectedAuditorRecord = buildPlanningAuditorRecord(
        expectedBundle,
        expectedPhaseContracts.map((contract) => contract.analysisPlan),
      );
      const currentCheckerReport = readJson(paths.planningCheckerJsonPath);
      const currentAuditorReport = readJson(paths.planningAuditorJsonPath);
      if (
        currentCheckerReport.result !== expectedCheckerRecord.result
        || JSON.stringify(currentCheckerReport.findings || []) !== JSON.stringify(expectedCheckerRecord.findings || [])
        || JSON.stringify(currentCheckerReport.topological_order || []) !== JSON.stringify(expectedCheckerRecord.topological_order || [])
      ) {
        return true;
      }
      if (
        currentAuditorReport.result !== expectedAuditorRecord.result
        || JSON.stringify(currentAuditorReport.findings || []) !== JSON.stringify(expectedAuditorRecord.findings || [])
        || JSON.stringify(currentAuditorReport.mappings || []) !== JSON.stringify(expectedAuditorRecord.mappings || [])
      ) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

function syncPlanningState(project, state, plan) {
  const planning = state?.planning;
  if (!planning || typeof planning !== 'object') {
    return { transitioned: false, currentHash: hashPlanContract(plan) };
  }

  const currentHash = hashPlanContract(plan);
  const initialHash = planning.initial_plan_hash;
  const changed = typeof initialHash === 'string' && currentHash !== initialHash;
  if (!changed || !isPlanningLifecycleStatus(state.lifecycle?.status) || isPlanningDraftState(state)) {
    return { transitioned: false, currentHash };
  }

  const paths = getProjectPaths(project);
  const specRel = typeof planning.spec_path === 'string' ? planning.spec_path.trim() : '';
  const contextFiles = normalizePathList(planning.context_files || []);
  if (!specRel || !fs.existsSync(path.join(REPO_ROOT, specRel))) {
    return { transitioned: false, currentHash };
  }

  let promotionCheck = { ready: false, blockers: ['spec-unreadable'] };
  try {
    const bundle = buildPlanningBundle(project, specRel, contextFiles);
    const phaseContracts = buildPlanningPhaseContracts(project, specRel, bundle);
    promotionCheck = buildPlanningDraftPromotionCheck(bundle, phaseContracts);
  } catch {
    return { transitioned: false, currentHash };
  }

  const planningAnalysis = loadPlanningAnalysis(paths);
  if (!promotionCheck.ready || !planningAnalysisIsExecutionReady(planningAnalysis)) {
    return { transitioned: false, currentHash };
  }

  state.lifecycle.status = 'ready';
  setLifecycleNextStep(state, `Planning complete. Run \`./smike\` to execute ${project}.`, buildCycleCommand(project));
  state.updated_at = nowIso();
  state.current_plan = {
    ...state.current_plan,
    plan_id: plan.plan_id,
    contract_hash: currentHash,
  };
  state.planning = {
    ...planning,
    status: 'complete',
    last_plan_hash: currentHash,
    completed_at: state.updated_at,
  };
  const orchestration = ensureOrchestrationState(state);
  orchestration.stage = 'execution';
  orchestration.active_role = null;
  orchestration.next_role = 'executor';

  syncActionableRuntimeDispatchState(project, paths, state, plan);
  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.stateMdPath, renderStateMarkdown(project, planning.spec_path || project, state), 'utf8');
  generateDerivedArtifacts(project, paths, state, plan);
  return { transitioned: true, currentHash };
}

function getRuntimeDispatchSummaryLines(project, state) {
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.planJsonPath)) {
    return [];
  }

  const rootPlan = readJson(paths.planJsonPath);
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  return buildRuntimeDispatchSummaryLines(runtimeContext);
}

function getQualitySummaryLines(state) {
  const latest = ensureArray(state?.history).slice(-1)[0];
  const orchestration = ensureOrchestrationState(state);
  const lines = [];
  if (latest?.verdict?.result) {
    lines.push(`verdict: ${latest.verdict.result}`);
  }
  if (latest?.review?.result) {
    lines.push(`review: ${latest.review.result}`);
  }
  if (orchestration.next_role) {
    lines.push(`next_role: ${orchestration.next_role}`);
  }
  return lines;
}

function getOperatorGuidanceLines(project, state) {
  const nextCommand = getLifecycleNextCommand(state) || 'none';
  const advanceCommand = buildAdvanceCommand(project);
  const lines = [
    `handoff: .smike/${project}/STATE.md`,
    `inspect_command: ./smike status ${project}`,
    `advance_command: ${advanceCommand}`,
  ];

  if (isPlanningDraftState(state)) {
    lines.push('operator_requirement: planning_draft is spec-driven; update the spec, not .smike/**.');
    return lines;
  }

  if (state.lifecycle?.status === 'awaiting_runtime_dispatch') {
    lines.push(`operator_requirement: run ${nextCommand} now, then mark each finished dispatch with ./smike dispatch ${project} completed <dispatch-id>.`);
    return lines;
  }

  if (state.lifecycle?.status === AWAITING_FRESH_SESSION_LIFECYCLE_STATUS) {
    lines.push(`operator_requirement: stop in this session, start a fresh session, then run ${nextCommand}.`);
    return lines;
  }

  lines.push(`operator_requirement: inspection is read-only; use ${advanceCommand} to execute the next legal step.`);
  return lines;
}

function printProjectInspectionSummary(commandLabel, project, specRel, state, extraLines = []) {
  console.log(`smike ${commandLabel}: ${project}`);
  if (specRel) {
    console.log(`spec: ${specRel}`);
  }
  console.log(`status: ${state.lifecycle?.status || 'unknown'}`);
  console.log(`next: ${state.lifecycle?.next_action || 'unknown'}`);
  const nextCommand = getLifecycleNextCommand(state);
  if (nextCommand) {
    console.log(`next_command: ${nextCommand}`);
  }
  for (const line of getOperatorGuidanceLines(project, state)) {
    console.log(line);
  }
  for (const line of getRuntimeDispatchSummaryLines(project, state)) {
    console.log(line);
  }
  for (const line of getPlanningDraftNoticeLines(state)) {
    console.log(line);
  }
  for (const line of extraLines) {
    console.log(line);
  }
}

function getStaleActiveProjectMissingPath(paths) {
  if (!fs.existsSync(paths.projectDir)) {
    return `.smike/${path.basename(paths.projectDir)}`;
  }
  if (!fs.existsSync(paths.planJsonPath)) {
    return `.smike/${path.basename(paths.projectDir)}/PLAN.json`;
  }
  if (!fs.existsSync(paths.statePath)) {
    return `.smike/${path.basename(paths.projectDir)}/STATE.json`;
  }
  return null;
}

function getProjectRecoveryArgs(project, active = null) {
  const paths = getProjectPaths(project);
  const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : null;
  const plan = fs.existsSync(paths.planJsonPath) ? readJson(paths.planJsonPath) : null;
  const state = fs.existsSync(paths.statePath) ? readJson(paths.statePath) : null;
  const specPath =
    (active?.project === project ? active.spec_path : null)
    || projectMeta?.spec_path
    || plan?.spec
    || state?.planning?.spec_path
    || null;
  const contextFiles = normalizePathList(
    (active?.project === project ? active.context_files : null)
    || projectMeta?.context_files
    || state?.planning?.context_files
    || [],
  );
  const specArgs = specPath ? [specPath, ...contextFiles] : [];
  const recoverable = specArgs.length > 0
    && specArgs.every((entry) => {
      try {
        resolveExistingPath(entry);
        return true;
      } catch {
        return false;
      }
    });

  return {
    specArgs,
    recoverable,
  };
}

function printNoSelectedProject() {
  console.log('smike: no active project');
  console.log('hint: run `./smike list` or start one with `./smike <spec.md>`');
}

function printStaleProject(project, paths, active = null, { noun = 'project' } = {}) {
  const missing = getStaleActiveProjectMissingPath(paths);
  const recovery = getProjectRecoveryArgs(project, active);
  console.log(`smike: ${noun} is stale (${project})`);
  if (missing) {
    console.log(`missing: ${missing}`);
  }
  if (recovery.recoverable) {
    console.log(`next: run \`${buildAdvanceCommand(project)}\` to recover from the recorded spec inputs.`);
    return;
  }
  console.log(`next: run \`./smike doctor ${project}\`, \`./smike activate ${project}\`, or recreate the project from spec.`);
}

function readProjectInspection(project, active = null) {
  const paths = getProjectPaths(project);
  const stalePath = getStaleActiveProjectMissingPath(paths);
  if (stalePath) {
    return {
      project,
      paths,
      stale: true,
      stalePath,
    };
  }

  const state = readJson(paths.statePath);
  const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : null;
  const plan = fs.existsSync(paths.planJsonPath) ? readJson(paths.planJsonPath) : null;
  const specRel =
    (active?.project === project ? active.spec_path : null)
    || projectMeta?.spec_path
    || state?.planning?.spec_path
    || plan?.spec
    || null;

  return {
    project,
    paths,
    stale: false,
    state,
    specRel,
  };
}

function runList() {
  const active = readActiveProject();
  const projects = listProjectDirs().sort((left, right) => left.localeCompare(right));
  if (projects.length === 0) {
    console.log('smike list: no projects');
    return;
  }

  console.log('smike list');
  for (const project of projects) {
    const inspection = readProjectInspection(project, active);
    const activeMarker = active?.project === project ? '*' : '-';
    if (inspection.stale) {
      console.log(`${activeMarker} ${project}: stale (${inspection.stalePath})`);
      continue;
    }

    const state = inspection.state;
    const nextCommand = getLifecycleNextCommand(state) || 'none';
    console.log(`${activeMarker} ${project}: ${state.lifecycle?.status || 'unknown'} :: ${nextCommand}`);
  }
}

function runStatus(projectSelector = null) {
  const selectedProject = typeof projectSelector === 'string' && projectSelector.trim()
    ? (resolveProjectSelector(projectSelector) || projectSelector.trim())
    : null;
  const active = readActiveProject();
  const project = selectedProject || active?.project || null;
  if (!project) {
    printNoSelectedProject();
    return;
  }

  const inspection = readProjectInspection(project, active);
  if (inspection.stale) {
    printStaleProject(project, inspection.paths, active, {
      noun: active?.project === project ? 'active project' : 'project',
    });
    return;
  }

  printProjectInspectionSummary('status', project, inspection.specRel, inspection.state, [
    `plan: .smike/${project}/PLAN.md`,
    `contract: .smike/${project}/PLAN.json`,
    ...getQualitySummaryLines(inspection.state),
  ]);
}

function collectDoctorIssues(project, paths, state, active = null) {
  const issues = [];
  const specRel = active?.spec_path || state?.planning?.spec_path || null;
  const contextFiles = normalizePathList(active?.context_files || state?.planning?.context_files || []);
  const inputStatus = collectProjectPlanningInputStatus(project, paths, specRel, contextFiles);
  const nextCommand = getLifecycleNextCommand(state);
  const currentDispatchId = state?.orchestration?.current_actionable_dispatch?.dispatch_id || null;

  if (active?.project === project) {
    const activeSpec = typeof active.spec_path === 'string' ? active.spec_path.trim() : null;
    const stateSpec = typeof state?.planning?.spec_path === 'string' ? state.planning.spec_path.trim() : null;
    if (activeSpec && stateSpec && activeSpec !== stateSpec) {
      issues.push({
        severity: 'error',
        id: 'active-spec-mismatch',
        message: `ACTIVE.json points at ${activeSpec}, but STATE.json points at ${stateSpec}.`,
      });
    }
  }

  if (!specRel) {
    issues.push({
      severity: 'error',
      id: 'missing-spec-path',
      message: 'No spec_path is recorded in ACTIVE.json or STATE.json.',
    });
  }

  if (inputStatus.missing_source_paths.length > 0) {
    issues.push({
      severity: 'error',
      id: 'missing-planning-inputs',
      message: `Missing planning inputs: ${inputStatus.missing_source_paths.join(', ')}`,
    });
    if (inputStatus.recoverable_paths.length > 0) {
      issues.push({
        severity: 'warning',
        id: 'recoverable-planning-inputs',
        message: `Recoverable from .smike/${project}/inputs: ${inputStatus.recoverable_paths.join(', ')}`,
      });
    }
    if (inputStatus.unrecoverable_paths.length > 0) {
      issues.push({
        severity: 'error',
        id: 'unrecoverable-planning-inputs',
        message: `No snapshot available for: ${inputStatus.unrecoverable_paths.join(', ')}`,
      });
    }
  }

  if (nextCommand && !parseCanonicalSmikeCommand(nextCommand)) {
    issues.push({
      severity: 'error',
      id: 'non-canonical-next-command',
      message: `STATE.json next_command is not canonical: ${nextCommand}`,
    });
  }

  const runtimeDispatchView = state?.orchestration?.runtime_dispatch_view;
  if (!runtimeDispatchView || typeof runtimeDispatchView !== 'object' || Array.isArray(runtimeDispatchView)) {
    issues.push({
      severity: 'error',
      id: 'missing-runtime-dispatch-view',
      message: 'STATE.json is missing orchestration.runtime_dispatch_view.',
    });
  } else {
    const actionablePlanId = runtimeDispatchView.actionable_plan?.plan_id || null;
    if (actionablePlanId && actionablePlanId !== (state.current_plan?.plan_id || null)) {
      issues.push({
        severity: 'error',
        id: 'runtime-dispatch-view-plan-mismatch',
        message: `orchestration.runtime_dispatch_view.actionable_plan.plan_id ${actionablePlanId} does not match STATE.json current plan ${state.current_plan?.plan_id || 'null'}.`,
      });
    }
    if (state.lifecycle?.status === 'awaiting_runtime_dispatch' && ensureArray(runtimeDispatchView.ready_dispatches).length === 0) {
      issues.push({
        severity: 'error',
        id: 'runtime-dispatch-view-missing-ready-dispatches',
        message: 'STATE.json is awaiting runtime dispatch but orchestration.runtime_dispatch_view.ready_dispatches is empty.',
      });
    }
  }

  const implementationHandoff = fs.existsSync(paths.implementationHandoffJsonPath) ? readJson(paths.implementationHandoffJsonPath) : null;
  if (!implementationHandoff) {
    issues.push({
      severity: 'error',
      id: 'missing-implementation-handoff',
      message: `Missing derived artifact: .smike/${project}/IMPLEMENTATION-HANDOFF.json`,
    });
  } else {
    if ((implementationHandoff.lifecycle?.status || null) !== (state.lifecycle?.status || null)) {
      issues.push({
        severity: 'error',
        id: 'implementation-handoff-status-mismatch',
        message: `IMPLEMENTATION-HANDOFF.json status ${implementationHandoff.lifecycle?.status || 'null'} does not match STATE.json status ${state.lifecycle?.status || 'null'}.`,
      });
    }
    if ((implementationHandoff.lifecycle?.next_command || null) !== (nextCommand || null)) {
      issues.push({
        severity: 'error',
        id: 'implementation-handoff-next-command-mismatch',
        message: `IMPLEMENTATION-HANDOFF.json next_command ${implementationHandoff.lifecycle?.next_command || 'null'} does not match STATE.json next_command ${nextCommand || 'null'}.`,
      });
    }
  }

  const stateMarkdown = fs.existsSync(paths.stateMdPath) ? fs.readFileSync(paths.stateMdPath, 'utf8') : null;
  if (!stateMarkdown) {
    issues.push({
      severity: 'error',
      id: 'missing-state-markdown',
      message: `Missing derived artifact: .smike/${project}/STATE.md`,
    });
  } else {
    if (!stateMarkdown.includes(`Status: ${state.lifecycle?.status}`)) {
      issues.push({
        severity: 'error',
        id: 'state-markdown-status-mismatch',
        message: 'STATE.md status line does not match STATE.json.',
      });
    }
    const expectedNextCommandLine = `Next command: ${nextCommand || 'none'}`;
    if (!stateMarkdown.includes(expectedNextCommandLine)) {
      issues.push({
        severity: 'error',
        id: 'state-markdown-next-command-mismatch',
        message: `STATE.md is missing the expected next command line: ${expectedNextCommandLine}`,
      });
    }
    if (!stateMarkdown.includes(`Canonical state: .smike/${project}/STATE.json`)) {
      issues.push({
        severity: 'warning',
        id: 'state-markdown-authority-missing',
        message: 'STATE.md is missing the authority banner.',
      });
    }
  }

  const planningHandoffMarkdown = fs.existsSync(paths.planningHandoffMdPath)
    ? fs.readFileSync(paths.planningHandoffMdPath, 'utf8')
    : null;
  if (!planningHandoffMarkdown) {
    issues.push({
      severity: 'error',
      id: 'missing-planning-handoff',
      message: `Missing derived artifact: .smike/${project}/PLANNING-HANDOFF.md`,
    });
  } else if (!planningHandoffMarkdown.includes(`Next command: ${nextCommand || 'none'}`)) {
    issues.push({
      severity: 'error',
      id: 'planning-handoff-next-command-mismatch',
      message: 'PLANNING-HANDOFF.md next command does not match STATE.json.',
    });
  }

  if (
    implementationHandoff?.actionable_surface?.current_dispatch?.dispatch_id
    && currentDispatchId
    && implementationHandoff.actionable_surface.current_dispatch.dispatch_id !== currentDispatchId
  ) {
    issues.push({
      severity: 'error',
      id: 'current-dispatch-mismatch',
      message:
        `IMPLEMENTATION-HANDOFF.json current dispatch ${implementationHandoff.actionable_surface.current_dispatch.dispatch_id} `
        + `does not match STATE.json current actionable dispatch ${currentDispatchId}.`,
    });
  }

  return {
    specRel,
    contextFiles,
    inputStatus,
    issues,
  };
}

function runDoctor(projectSelector = null) {
  const selectedProject = typeof projectSelector === 'string' && projectSelector.trim()
    ? (resolveProjectSelector(projectSelector) || projectSelector.trim())
    : null;
  const active = selectedProject ? readActiveProject() : readActiveProject();
  const project = selectedProject || active?.project || null;
  if (!project) {
    fail('no project selected. Use `./smike doctor <project>` or activate a project first.');
  }

  console.log(`smike doctor: ${project}`);
  const paths = getProjectPaths(project);
  const missingRuntime = getStaleActiveProjectMissingPath(paths);
  if (missingRuntime) {
    console.log('result: FAIL');
    console.log(`- missing runtime artifact: ${missingRuntime}`);
    console.log(`- next: run \`./smike activate ${project}\` or recreate the project from spec.`);
    process.exitCode = 1;
    return;
  }

  const { state } = readValidatedState(paths, { persistRepair: true });
  const report = collectDoctorIssues(project, paths, state, active);
  const errorCount = report.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = report.issues.filter((issue) => issue.severity === 'warning').length;

  console.log(`status: ${state.lifecycle?.status || 'unknown'}`);
  console.log(`next_command: ${getLifecycleNextCommand(state) || 'none'}`);
  console.log(`spec: ${report.specRel || 'none'}`);
  console.log(`context: ${report.contextFiles.join(', ') || 'none'}`);
  console.log(`inputs_snapshot_root: .smike/${project}/inputs`);
  console.log(`errors: ${errorCount}`);
  console.log(`warnings: ${warningCount}`);

  if (report.issues.length === 0) {
    console.log('result: PASS');
    return;
  }

  console.log('result: FAIL');
  for (const issue of report.issues) {
    console.log(`- ${issue.severity} ${issue.id}: ${issue.message}`);
  }
  const needsDerivedRefresh = report.issues.some((issue) => [
    'missing-runtime-delegation',
    'missing-implementation-handoff',
    'missing-state-markdown',
    'missing-planning-handoff',
    'runtime-delegation-status-mismatch',
    'runtime-delegation-next-command-mismatch',
    'runtime-delegation-plan-mismatch',
    'implementation-handoff-status-mismatch',
    'implementation-handoff-next-command-mismatch',
    'state-markdown-status-mismatch',
    'state-markdown-next-command-mismatch',
    'planning-handoff-next-command-mismatch',
  ].includes(issue.id));
  if (needsDerivedRefresh) {
    console.log(`- remediation derived-artifacts: run \`./smike generate ${project}\` to refresh derived views from STATE.json.`);
  }
  process.exitCode = 1;
}

function runActivate(project) {
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.projectDir)) {
    fail(`project directory not found: ${paths.projectDir}`);
  }

  const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : null;
  const plan = fs.existsSync(paths.planJsonPath) ? readJson(paths.planJsonPath) : null;
  const specRel = projectMeta?.spec_path || plan?.spec || null;
  const contextFiles = normalizePathList(projectMeta?.context_files || []);
  setActiveProject({
    project,
    spec_path: specRel,
    context_files: contextFiles,
    activated_via: 'project',
  });
  console.log(`smike activate: ${project}`);
  if (specRel) {
    console.log(`spec: ${specRel}`);
  }
  console.log('resume: run `./smike`');
}

async function runStart(specArgs) {
  if (!Array.isArray(specArgs) || specArgs.length === 0) {
    fail('spec path is required');
  }

  const resolvedPaths = resolvePathList(specArgs);
  const spec = resolvedPaths[0];
  const contextFiles = normalizePathList(resolvedPaths.slice(1).map((entry) => entry.relative));
  const project = allocateProjectName(spec.relative);
  const paths = getProjectPaths(project);
  const hasExistingArtifacts = fs.existsSync(paths.planJsonPath) && fs.existsSync(paths.statePath);
  const needsPlanningRefresh = hasExistingArtifacts && shouldRefreshPlanningArtifacts(paths);

  if (!hasExistingArtifacts || needsPlanningRefresh) {
    writePlanningArtifacts(project, spec.relative, contextFiles, { planningMode: 'draft' });
  }

  setActiveProject({
    project,
    spec_path: spec.relative,
    context_files: contextFiles,
    activated_via: 'spec',
  });

  console.log(`smike start: ${project}`);
  console.log(`spec: ${spec.relative}`);
  if (contextFiles.length > 0) {
    console.log(`context: ${contextFiles.join(', ')}`);
  }
  console.log(`plan: .smike/${project}/PLAN.md`);
  console.log(`contract: .smike/${project}/PLAN.json`);

  if (!hasExistingArtifacts || needsPlanningRefresh) {
    await runCycle(project, { maxPhases: 1 });
    const updatedState = readJson(paths.statePath);
    printProjectInspectionSummary('resume', project, spec.relative, updatedState, [
      `roadmap: .smike/${project}/ROADMAP.md`,
      `strategy: .smike/${project}/STRATEGY.md`,
    ]);
    return;
  }

  await runEntrypoint();
}

async function runIntake(rawArgs) {
  const { promptText, specPath, contextFiles } = parseIntakeArgs(rawArgs);
  const targetSpec = resolveIntakeSpecTarget(specPath, promptText);
  ensureDir(path.dirname(targetSpec.absolute));
  fs.writeFileSync(targetSpec.absolute, buildIntakeSpecMarkdown(promptText, contextFiles), 'utf8');
  await runStart([targetSpec.relative, ...contextFiles]);
}

async function runAdvanceExecution(project, active = null) {
  const paths = getProjectPaths(project);
  if (getStaleActiveProjectMissingPath(paths)) {
    const recovery = getProjectRecoveryArgs(project, active);
    if (!recovery.recoverable) {
      fail(`project is stale or missing runtime artifacts: ${project}`);
    }
    console.log(`smike advance: recovering ${project} from spec ${recovery.specArgs[0]}`);
    await runStart(recovery.specArgs);
    return;
  }

  const plan = readJson(paths.planJsonPath);
  const { state } = readValidatedState(paths, { persistRepair: true });

  const specRel =
    (active?.project === project ? active.spec_path : null)
    || state?.planning?.spec_path
    || plan?.spec
    || null;
  const planningSync = syncPlanningState(project, state, plan);
  if (planningSync.transitioned) {
    console.log(`smike: planning changes detected for ${project}; starting execution`);
    await runCycle(project, {});
    return;
  }

  if (isPlanningLifecycleStatus(state.lifecycle?.status)) {
    await runCycle(project, {});
    return;
  }

  const clearedFreshSessionGate = clearFreshSessionImplementationGate(state);
  if (clearedFreshSessionGate) {
    persistProjectState(project, paths, state, plan, specRel);
    console.log(`smike resume: cleared implementation gate for ${project}`);
  }

  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, plan);
  const lifecycleReconciled = applyRuntimeDispatchPendingLifecycle(
    project,
    state,
    buildRuntimeDispatchPendingState(runtimeContext),
  );
  const planningRecheck = shouldAutoRecheckPlanning(
    project,
    paths,
    state,
    specRel,
    normalizePathList((active?.project === project ? active.context_files : null) || state?.planning?.context_files || []),
  );
  if (planningRecheck.stale) {
    await runRecheck(project);
    return;
  }
  if (state.lifecycle?.status === 'awaiting_runtime_dispatch') {
    const handoffRecorded = maybeRecordHandoffFailure(project, state);
    if (lifecycleReconciled || handoffRecorded) {
      persistProjectState(project, paths, state, plan, specRel);
    }
    printProjectInspectionSummary('advance', project, specRel, state, [
      `plan: .smike/${project}/PLAN.md`,
      `contract: .smike/${project}/PLAN.json`,
      ...getQualitySummaryLines(state),
    ]);
    return;
  }

  await runCycle(project, {});
}

async function runResume(projectSelector = null) {
  const selectedProject = typeof projectSelector === 'string' && projectSelector.trim()
    ? (resolveProjectSelector(projectSelector) || projectSelector.trim())
    : null;
  const active = readActiveProject();
  const project = selectedProject || active?.project || null;
  if (!project) {
    printNoSelectedProject();
    return;
  }

  const inspection = readProjectInspection(project, active);
  if (inspection.stale) {
    printStaleProject(project, inspection.paths, active, {
      noun: active?.project === project ? 'active project' : 'project',
    });
    return;
  }

  printProjectInspectionSummary('resume', project, inspection.specRel, inspection.state, [
    `plan: .smike/${project}/PLAN.md`,
    `contract: .smike/${project}/PLAN.json`,
    ...getQualitySummaryLines(inspection.state),
  ]);
}

async function runEntrypoint(projectSelector = null) {
  const selectedProject = typeof projectSelector === 'string' && projectSelector.trim()
    ? (resolveProjectSelector(projectSelector) || projectSelector.trim())
    : null;
  if (selectedProject) {
    runActivate(selectedProject);
  }

  const active = readActiveProject();
  const project = selectedProject || active?.project || null;
  if (!project) {
    printNoSelectedProject();
    return;
  }

  const inspection = readProjectInspection(project, active);
  if (inspection.stale) {
    const recovery = getProjectRecoveryArgs(project, active);
    if (recovery.recoverable) {
      await runAdvanceExecution(project, active);
      return;
    }
    printStaleProject(project, inspection.paths, active, {
      noun: active?.project === project ? 'active project' : 'project',
    });
    return;
  }

  if (getLifecycleNextCommand(inspection.state)) {
    await runAdvance(project);
    return;
  }

  await runResume(project);
}

function parseCanonicalSmikeCommand(commandText) {
  const normalized = typeof commandText === 'string' ? commandText.trim() : '';
  if (!normalized.startsWith('./smike ')) {
    return null;
  }

  let match = normalized.match(/^\.\/smike advance(?: (\S+))?$/);
  if (match) {
    return { command: 'advance', project: match[1] || null };
  }
  match = normalized.match(/^\.\/smike recheck (\S+)$/);
  if (match) {
    return { command: 'recheck', project: match[1] };
  }
  match = normalized.match(/^\.\/smike resume(?: (\S+))?$/);
  if (match) {
    return { command: 'resume', project: match[1] || null };
  }
  match = normalized.match(/^\.\/smike cycle (\S+)$/);
  if (match) {
    return { command: 'cycle', project: match[1] };
  }
  match = normalized.match(/^\.\/smike dispatch (\S+) (spawned|completed|failed|retry|complete-group) (\S+)$/);
  if (match) {
    return {
      command: 'dispatch',
      project: match[1],
      action: match[2],
      dispatch_id: match[3],
    };
  }

  return null;
}

function shouldAutoRecheckPlanning(project, paths, state, planningSpecRel, planningContextFiles) {
  if (!planningSpecRel || !fs.existsSync(path.join(REPO_ROOT, planningSpecRel))) {
    return { stale: false, freshness: null };
  }
  if (isPlanningDraftState(state)) {
    return { stale: false, freshness: null };
  }

  const bundle = buildPlanningBundle(project, planningSpecRel, planningContextFiles);
  const freshness = getPlanningArtifactFreshness(paths, bundle);
  if (!freshness.stale) {
    return { stale: false, freshness };
  }

  return { stale: true, freshness, bundle };
}

async function runPlanningRecheckInternal(
  project,
  paths,
  rootPlan,
  state,
  workflowSettings,
  planningSpecRel,
  planningContextFiles,
  options = {},
) {
  const planningInputRecovery = ensurePlanningInputsReadable(
    project,
    paths,
    planningSpecRel,
    planningContextFiles,
    'planning recheck',
  );
  printPlanningInputRecovery(project, planningInputRecovery);

  const bundle = options.bundle || buildPlanningBundle(project, planningSpecRel, planningContextFiles);
  refreshPlanningAnalysisArtifactsFromCurrentPlans(project, paths, bundle);

  const contracts = buildWorkflowContracts(paths, rootPlan, workflowSettings);
  syncWorkflowState(state, contracts, workflowSettings);
  const contractsByPath = new Map(contracts.map((contract) => [contract.plan_json_rel, contract]));
  const planningContract = contracts.find((contract) => contract.plan.plan_id === `${project}-plan`);
  if (!planningContract) {
    fail(`missing planning root contract for ${project}`);
  }

  const orchestration = ensureOrchestrationState(state);
  ensureDiscoveryLog(state);
  const planOrchestration = resolveOrchestrationConfig(project, planningContract.plan);
  const cycleNumber = (state.lifecycle?.cycle_count || 0) + 1;
  state.lifecycle = state.lifecycle || {};
  state.lifecycle.cycle_count = cycleNumber;
  state.lifecycle.last_started_at = nowIso();
  state.lifecycle.status = 'running';
  orchestration.stage = planOrchestration.stage;
  orchestration.discovery_propagation = planOrchestration.discovery_propagation;
  state.current_plan = {
    plan_id: planningContract.plan.plan_id,
    plan_json: planningContract.plan_json_rel,
    plan_md: planningContract.plan_md_rel,
    depends_on: ensureArray(planningContract.plan.depends_on),
    contract_hash: hashPlanContract(planningContract.plan),
  };

  let executorCapsulePaths = null;
  orchestration.active_role = 'executor';
  orchestration.next_role = 'judge';
  if (planOrchestration.roles.executor.enabled) {
    const executorCapsule = buildExecutorCapsule(project, planningContract, state, cycleNumber);
    executorCapsulePaths = persistRoleCapsule(
      paths,
      state,
      executorCapsule,
      'prepared',
      `Executor context prepared for ${planningContract.plan.plan_id}.`,
    );
  }

  const cycleRecord = await executeSinglePlan(planningContract, cycleNumber, paths.projectDir);
  if (executorCapsulePaths) {
    recordRoleHistory(orchestration, {
      cycle: cycleNumber,
      stage: planOrchestration.stage,
      role: 'executor',
      plan_id: planningContract.plan.plan_id,
      status: cycleRecord.result,
      capsule_json: executorCapsulePaths.jsonRel,
      generated_at: nowIso(),
      summary: `Executor finished ${planningContract.plan.plan_id} with ${cycleRecord.result}.`,
    });
    orchestration.last_role = 'executor';
  }

  let judgeCapsulePaths = null;
  orchestration.active_role = 'judge';
  orchestration.next_role = 'reviewer';
  if (planOrchestration.roles.judge.enabled) {
    const judgeCapsule = buildJudgeCapsule(project, paths, planningContract, state, cycleRecord);
    judgeCapsulePaths = persistRoleCapsule(
      paths,
      state,
      judgeCapsule,
      'prepared',
      `Judge context prepared for ${planningContract.plan.plan_id}.`,
    );
  }
  const verdictRecord = await buildVerdictRecord(planningContract, cycleRecord, paths.projectDir);
  if (judgeCapsulePaths) {
    recordRoleHistory(orchestration, {
      cycle: cycleNumber,
      stage: planOrchestration.stage,
      role: 'judge',
      plan_id: planningContract.plan.plan_id,
      status: verdictRecord.result,
      capsule_json: judgeCapsulePaths.jsonRel,
      generated_at: verdictRecord.generated_at,
      summary: `Judge returned ${verdictRecord.result} for ${planningContract.plan.plan_id}.`,
    });
    orchestration.last_role = 'judge';
  }
  fs.writeFileSync(paths.verdictReportPath, buildVerdictReport(project, cycleRecord, verdictRecord), 'utf8');

  let reviewerCapsulePaths = null;
  orchestration.active_role = 'reviewer';
  orchestration.next_role = null;
  if (planOrchestration.roles.reviewer.enabled) {
    const reviewerCapsule = buildReviewerCapsule(project, paths, planningContract, state, cycleRecord, verdictRecord);
    reviewerCapsulePaths = persistRoleCapsule(
      paths,
      state,
      reviewerCapsule,
      'prepared',
      `Reviewer context prepared for ${planningContract.plan.plan_id}.`,
    );
  }
  const reviewRecord = buildReviewRecord(planningContract, cycleRecord, verdictRecord);
  if (reviewerCapsulePaths) {
    recordRoleHistory(orchestration, {
      cycle: cycleNumber,
      stage: planOrchestration.stage,
      role: 'reviewer',
      plan_id: planningContract.plan.plan_id,
      status: reviewRecord.result,
      capsule_json: reviewerCapsulePaths.jsonRel,
      generated_at: reviewRecord.generated_at,
      summary: `Reviewer returned ${reviewRecord.result} for ${planningContract.plan.plan_id}.`,
    });
    orchestration.last_role = 'reviewer';
  }
  const qualityFailures = uniqueStrings([
    ...ensureArray(cycleRecord.failures),
    ...ensureArray(verdictRecord.failures).map((value) => `judge.${value}`),
    ...(reviewRecord.result === 'concerns' ? ['review.concerns'] : []),
  ]);
  cycleRecord.execution_result = cycleRecord.result;
  cycleRecord.verdict = {
    result: verdictRecord.result,
    failures: verdictRecord.failures,
    generated_at: verdictRecord.generated_at,
  };
  cycleRecord.review = {
    result: reviewRecord.result,
    findings: reviewRecord.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
    })),
    generated_at: reviewRecord.generated_at,
  };
  cycleRecord.failures = qualityFailures;
  cycleRecord.result = qualityFailures.length === 0 ? 'pass' : 'fail';
  fs.writeFileSync(paths.reviewReportPath, buildReviewReport(project, cycleRecord, reviewRecord, planningContract.plan), 'utf8');

  state.history.push(cycleRecord);
  const planningWorkflowPlan = state.workflow.plans.find((plan) => plan.plan_id === planningContract.plan.plan_id);
  if (planningWorkflowPlan) {
    planningWorkflowPlan.last_result = cycleRecord.result;
    planningWorkflowPlan.last_cycle = cycleNumber;
    planningWorkflowPlan.status = cycleRecord.result === 'pass' ? 'complete' : 'failed';
  }

  state.lifecycle.last_completed_at = cycleRecord.completed_at;
  state.lifecycle.last_result = cycleRecord.result;
  const planningAnalysis = loadPlanningAnalysis(paths);
  const planningReady = cycleRecord.result === 'pass' && planningAnalysisIsExecutionReady(planningAnalysis);

  if (state.planning && typeof state.planning === 'object') {
    state.planning = {
      ...state.planning,
      status: planningReady ? 'complete' : 'blocked',
      completed_at: planningReady ? cycleRecord.completed_at : state.planning.completed_at || null,
    };
  }

  const readyWorkflowPlans = getReadyWorkflowPlans(project, state.workflow.plans);
  const nextRunnablePending = readyWorkflowPlans[0] || null;
  const nextRunnableContract = nextRunnablePending ? contractsByPath.get(nextRunnablePending.plan_json) : null;
  let runtimeDispatchPending = null;

  if (planningReady) {
    orchestration.stage = 'execution';
    if (
      nextRunnableContract
      && inferPlanStage(project, nextRunnableContract.plan) !== 'planning'
    ) {
      applyFreshSessionImplementationGate(state);
    }
    if (nextRunnableContract) {
      const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
      if (
        nextRuntimeContext.actionable.plan_ids?.includes(nextRunnableContract.plan.plan_id)
        && nextRuntimeContext.dispatches.length > 0
        && !nextRuntimeContext.all_dispatches_completed_fresh
      ) {
        state.current_plan = {
          plan_id: nextRunnableContract.plan.plan_id,
          plan_json: nextRunnableContract.plan_json_rel,
          plan_md: nextRunnableContract.plan_md_rel,
          depends_on: ensureArray(nextRunnableContract.plan.depends_on),
          contract_hash: hashPlanContract(nextRunnableContract.plan),
        };
        runtimeDispatchPending = {
          plan_id: nextRunnableContract.plan.plan_id,
          plan_ids: nextRuntimeContext.actionable.plan_ids,
          group: currentRuntimeDispatchGroup(nextRuntimeContext),
          ready_dispatches: nextRuntimeContext.ready_dispatches,
          active_dispatches: nextRuntimeContext.active_dispatches,
          failed_dispatches: nextRuntimeContext.failed_dispatches,
        };
      }
    }
  }

  orchestration.active_role = null;
  if (!planningReady) {
    state.lifecycle.status = 'planning_blocked';
    setLifecycleStopReason(state, 'planning_blocked');
    setLifecycleNextStep(state, buildPlanningBlockedNextAction(project, paths, planningAnalysis), buildRecheckCommand(project));
    orchestration.next_role = null;
  } else if (runtimeDispatchPending && isFreshSessionImplementationPauseReason(state.workflow.pause_reason)) {
    enterAwaitingFreshSession(state, project, readyWorkflowPlans, runtimeDispatchPending);
    orchestration.next_role = null;
  } else if (runtimeDispatchPending) {
    applyRuntimeDispatchPendingLifecycle(project, state, runtimeDispatchPending);
    orchestration.next_role = null;
  } else if (nextRunnablePending && isFreshSessionImplementationPauseReason(state.workflow.pause_reason)) {
    enterAwaitingFreshSession(state, project, readyWorkflowPlans);
    orchestration.next_role = null;
  } else if (nextRunnablePending) {
    state.lifecycle.status = 'in_progress';
    setLifecycleStopReason(state, null);
    setLifecycleNextStep(state, describeReadyWorkflowPlans(readyWorkflowPlans), buildCycleCommand(project));
    orchestration.next_role = 'executor';
  } else {
    state.lifecycle.status = 'complete';
    setLifecycleStopReason(state, null);
    setLifecycleNextStep(state, 'Scope complete.');
    orchestration.next_role = null;
  }

  state.updated_at = nowIso();
  if (state.history.length > 50) {
    state.history = state.history.slice(-50);
  }
  syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  const reportMarkdown = buildExecReport(project, rootPlan, [cycleRecord], state);
  fs.writeFileSync(paths.execReportPath, reportMarkdown, 'utf8');
  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.stateMdPath, renderStateMarkdown(project, rootPlan.spec || state?.planning?.spec_path || project, state), 'utf8');
  generateDerivedArtifacts(project, paths, state, rootPlan);

  const overallResult = planningReady ? 'PASS' : 'FAIL';
  console.log(`smike recheck ${project}: ${overallResult} (1 plan executed)`);
  if (!planningReady && options.exitOnFailure !== false) {
    if (cycleRecord.failures.length > 0) {
      console.log(`failing checks: ${cycleRecord.failures.join(', ')}`);
    }
    process.exit(1);
  }
}

async function runRecheck(projectSelector) {
  const project = resolveProjectSelector(projectSelector) || projectSelector;
  if (!project) {
    fail('project argument is required');
  }

  const releaseProjectLock = acquireProjectLock(project, 'recheck');
  try {
    const paths = getProjectPaths(project);
    if (!fs.existsSync(paths.planJsonPath)) {
      fail(`missing PLAN.json: ${paths.planJsonPath}`);
    }
    if (!fs.existsSync(paths.statePath)) {
      fail(`missing STATE.json: ${paths.statePath}`);
    }

    const rootPlan = readJson(paths.planJsonPath);
    const workflowSettings = resolveWorkflowSettings(rootPlan, {});
    const { state } = readValidatedState(paths, { persistRepair: true });
    const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : {};
    const planningSpecRel = projectMeta?.spec_path || rootPlan?.spec || state?.planning?.spec_path || null;
    const planningContextFiles = normalizePathList(projectMeta?.context_files || state?.planning?.context_files || []);
    await runPlanningRecheckInternal(
      project,
      paths,
      rootPlan,
      state,
      workflowSettings,
      planningSpecRel,
      planningContextFiles,
      {},
    );
  } finally {
    releaseProjectLock();
  }
}

async function runAdvance(projectSelector = null) {
  const selectedProject = typeof projectSelector === 'string' && projectSelector.trim()
    ? (resolveProjectSelector(projectSelector) || projectSelector.trim())
    : null;
  const active = readActiveProject();
  const project = selectedProject || active?.project || null;
  if (!project) {
    fail('no project selected. Use `./smike advance <project>` or activate a project first.');
  }

  const paths = getProjectPaths(project);
  if (getStaleActiveProjectMissingPath(paths)) {
    await runAdvanceExecution(project, active);
    return;
  }

  const { state } = readValidatedState(paths, { persistRepair: true });
  const nextCommand = getLifecycleNextCommand(state);
  if (!nextCommand) {
    fail(`no next_command recorded for ${project}`);
  }

  if (nextCommand === buildAdvanceCommand(project)) {
    if (state.lifecycle?.status === 'awaiting_runtime_dispatch') {
      const rootPlan = readJson(paths.planJsonPath);
      const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
      const readyDispatches = runtimeContext.ready_dispatches
        .filter((entry) => entry.group === currentRuntimeDispatchGroup(runtimeContext));
      if (readyDispatches.length === 0) {
        fail(`no ready runtime dispatches found for ${project}`);
      }
      for (const entry of readyDispatches) {
        runDispatch(project, 'spawned', entry.dispatch_id, {});
      }
      return;
    }

    if (state.lifecycle?.status === AWAITING_FRESH_SESSION_LIFECYCLE_STATUS) {
      await runAdvanceExecution(project, active);
      return;
    }
  }

  const parsed = parseCanonicalSmikeCommand(nextCommand);
  if (!parsed) {
    fail(`advance only supports canonical ./smike next_command values. Got: ${nextCommand}`);
  }

  if (parsed.command === 'advance' || parsed.command === 'resume') {
    await runAdvanceExecution(parsed.project || project, active);
    return;
  }
  if (parsed.command === 'recheck') {
    await runRecheck(parsed.project || project);
    return;
  }
  if (parsed.command === 'cycle') {
    await runCycle(parsed.project || project, {});
    return;
  }
  if (parsed.command === 'dispatch') {
    if (parsed.action === 'complete-group') {
      runDispatchGroup(parsed.project || project, parsed.action, parsed.dispatch_id, {});
      return;
    }
    runDispatch(parsed.project || project, parsed.action, parsed.dispatch_id, {});
    return;
  }

  fail(`advance cannot execute unsupported next_command: ${nextCommand}`);
}

async function runProjectSelector(projectSelector) {
  const project = resolveProjectSelector(projectSelector);
  if (!project) {
    fail(`project not found: ${projectSelector}`);
  }
  await runEntrypoint(project);
}

function loadOrInitState(project, paths, rootPlan) {
  if (fs.existsSync(paths.statePath)) {
    const { state } = readValidatedState(paths, { persistRepair: true });
    state.history = ensureArray(state.history);
    state.gotchas = trimStateGotchas(state.gotchas);
    state.workflow.plans = ensureArray(state.workflow?.plans);
    ensureOrchestrationState(state);
    ensureDiscoveryLog(state);
    return state;
  }

  const state = {
    schema_version: '2.1.0',
    profile: 'codex',
    project,
    created_at: nowIso(),
    updated_at: nowIso(),
    current_plan: {
      plan_id: rootPlan.plan_id,
      plan_json: path.relative(REPO_ROOT, paths.planJsonPath),
      plan_md: path.relative(REPO_ROOT, paths.planMdPath),
      depends_on: ensureArray(rootPlan.depends_on),
    },
    lifecycle: {
      status: 'ready',
      cycle_count: 0,
      last_started_at: null,
      last_completed_at: null,
      last_result: null,
      next_action: `Run \`${buildCycleCommand(project)}\``,
      next_command: buildCycleCommand(project),
    },
    workflow: {
      auto_continue: true,
      stop_on_failure: true,
      max_phases_per_run: DEFAULT_MAX_PHASES_PER_RUN,
      plans: [],
    },
    history: [],
    gotchas: [],
  };
  ensureOrchestrationState(state);
  ensureDiscoveryLog(state);
  state.orchestration.stage = inferPlanStage(project, rootPlan);
  state.orchestration.next_role = state.orchestration.stage === 'planning' ? 'strategist' : 'executor';
  return state;
}

function resolveWorkflowSettings(rootPlan, cycleOptions = {}) {
  const workflow = rootPlan.workflow && typeof rootPlan.workflow === 'object' ? rootPlan.workflow : {};
  const pauseReason = typeof workflow.pause_reason === 'string' ? workflow.pause_reason.trim() : '';
  const autoContinueFromPlan = workflow.auto_continue === false && pauseReason
    ? false
    : true;
  const autoContinue = cycleOptions.noAutoContinue ? false : autoContinueFromPlan;
  const stopOnFailure = workflow.stop_on_failure !== false;
  const maxFromPlan = Number.isInteger(workflow.max_phases_per_run)
    ? workflow.max_phases_per_run
    : DEFAULT_MAX_PHASES_PER_RUN;
  const maxPhases = Number.isInteger(cycleOptions.maxPhases) ? cycleOptions.maxPhases : maxFromPlan;
  const phasePlans = ensureArray(workflow.phase_plans).map((item) => String(item).trim()).filter(Boolean);
  return {
    auto_continue: autoContinue,
    pause_reason: pauseReason || null,
    stop_on_failure: stopOnFailure,
    max_phases_per_run: Math.max(1, maxPhases),
    phase_plans: phasePlans,
  };
}

function resolvePlanContract(projectDir, jsonPath, fallbackMdPath = null) {
  const absoluteJsonPath = path.resolve(projectDir, jsonPath);
  const normalizedProjectDir = path.resolve(projectDir);
  if (!isPathInside(normalizedProjectDir, absoluteJsonPath)) {
    fail(`phase plan path escapes project directory: ${jsonPath}`);
  }
  if (!fs.existsSync(absoluteJsonPath)) {
    fail(`missing plan contract: ${absoluteJsonPath}`);
  }

  const plan = readJson(absoluteJsonPath);
  const validationErrors = validatePlan(plan);
  if (validationErrors.length > 0) {
    fail(`PLAN.json validation failed for ${absoluteJsonPath}:\n- ${validationErrors.join('\n- ')}`);
  }
  if (plan.profile !== 'codex') {
    fail(`plan profile at ${absoluteJsonPath} is "${plan.profile}", expected "codex"`);
  }

  const absoluteMdPath = fallbackMdPath
    ? path.resolve(projectDir, fallbackMdPath)
    : absoluteJsonPath.replace(/\.json$/i, '.md');
  if (fallbackMdPath && !fs.existsSync(absoluteMdPath)) {
    fail(`missing human plan document: ${absoluteMdPath}`);
  }
  const planMdPath = fs.existsSync(absoluteMdPath) ? absoluteMdPath : null;

  return {
    plan,
    contract_hash: hashPlanContract(plan),
    plan_json_path: absoluteJsonPath,
    plan_md_path: planMdPath,
    plan_json_rel: path.relative(REPO_ROOT, absoluteJsonPath),
    plan_md_rel: planMdPath ? path.relative(REPO_ROOT, planMdPath) : null,
  };
}

function collectWorkflowContracts(paths, rootPlan, workflowSettings) {
  const contracts = [];
  if (
    inferPlanStage(path.basename(paths.projectDir), rootPlan) === 'planning'
    || workflowSettings.phase_plans.length === 0
  ) {
    contracts.push(
      resolvePlanContract(paths.projectDir, paths.planJsonPath, paths.planMdPath),
    );
  }
  for (const phasePlanPath of workflowSettings.phase_plans) {
    contracts.push(resolvePlanContract(paths.projectDir, phasePlanPath));
  }

  const seenPlanIds = new Set();
  for (const contract of contracts) {
    if (seenPlanIds.has(contract.plan.plan_id)) {
      fail(`duplicate plan_id in workflow: ${contract.plan.plan_id}`);
    }
    seenPlanIds.add(contract.plan.plan_id);
  }

  return contracts;
}

function loadWorkflowProjectContext(project, projectContextCache, dependencyErrors) {
  if (projectContextCache.has(project)) {
    return projectContextCache.get(project);
  }

  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.projectDir)) {
    dependencyErrors.push(`dependency project not found: ${project} (${paths.projectDir})`);
    return null;
  }
  if (!fs.existsSync(paths.planJsonPath)) {
    dependencyErrors.push(`dependency project ${project} is missing PLAN.json: ${paths.planJsonPath}`);
    return null;
  }
  if (!fs.existsSync(paths.planMdPath)) {
    dependencyErrors.push(`dependency project ${project} is missing PLAN.md: ${paths.planMdPath}`);
    return null;
  }
  if (!fs.existsSync(paths.statePath)) {
    dependencyErrors.push(`dependency project ${project} is missing STATE.json: ${paths.statePath}`);
    return null;
  }

  const rootPlan = readJson(paths.planJsonPath);
  const planValidationErrors = validatePlan(rootPlan);
  if (planValidationErrors.length > 0) {
    dependencyErrors.push(`dependency project ${project} PLAN.json validation failed: ${planValidationErrors.join('; ')}`);
    return null;
  }
  if (rootPlan.profile !== 'codex') {
    dependencyErrors.push(`dependency project ${project} has unsupported profile "${rootPlan.profile}"`);
    return null;
  }

  const workflowSettings = resolveWorkflowSettings(rootPlan, {});
  const contracts = collectWorkflowContracts(paths, rootPlan, workflowSettings);
  const state = readJson(paths.statePath);
  repairStateGotchaOverflow(state);
  const stateValidationErrors = validateState(state);
  if (stateValidationErrors.length > 0) {
    dependencyErrors.push(`dependency project ${project} STATE.json validation failed: ${stateValidationErrors.join('; ')}`);
    return null;
  }

  const context = {
    project,
    paths,
    rootPlan,
    workflowSettings,
    contracts,
    contractsById: new Map(contracts.map((contract) => [contract.plan.plan_id, contract])),
    state,
    workflowPlansById: new Map(
      ensureArray(state.workflow?.plans).map((plan) => [plan.plan_id, plan]),
    ),
  };
  projectContextCache.set(project, context);
  return context;
}

function buildWorkflowContracts(paths, rootPlan, workflowSettings) {
  const project = path.basename(paths.projectDir);
  const contracts = collectWorkflowContracts(paths, rootPlan, workflowSettings);

  const dependencyErrors = [];
  const projectContextCache = new Map();
  projectContextCache.set(project, {
    project,
    paths,
    rootPlan,
    workflowSettings,
    contracts,
    contractsById: new Map(contracts.map((contract) => [contract.plan.plan_id, contract])),
    state: null,
    workflowPlansById: new Map(),
  });
  const visiting = new Set();
  const visited = new Set();

  function resolveDependencyNode(reference, ownerProject, ownerPlanId) {
    if (!reference.project || !reference.plan_id) {
      dependencyErrors.push(
        `plan ${formatDependencyReference(ownerProject, ownerPlanId, project)} has invalid dependency reference: ${reference.raw || '(empty)'}`,
      );
      return null;
    }

    const context = reference.project === project
      ? projectContextCache.get(project)
      : loadWorkflowProjectContext(reference.project, projectContextCache, dependencyErrors);
    if (!context) {
      return null;
    }

    const contract = context.contractsById.get(reference.plan_id);
    if (!contract) {
      dependencyErrors.push(
        `plan ${formatDependencyReference(ownerProject, ownerPlanId, project)} depends on unknown plan reference: ${formatDependencyReference(reference.project, reference.plan_id)}`,
      );
      return null;
    }

    return {
      project: context.project,
      contract,
      key: dependencyNodeKey(context.project, contract.plan.plan_id),
      display: formatDependencyReference(context.project, contract.plan.plan_id, project),
    };
  }

  function visit(contractProject, contract, stack = []) {
    const nodeKey = dependencyNodeKey(contractProject, contract.plan.plan_id);
    const nodeDisplay = formatDependencyReference(contractProject, contract.plan.plan_id, project);
    if (visited.has(nodeKey)) {
      return;
    }
    if (visiting.has(nodeKey)) {
      dependencyErrors.push(`dependency cycle detected: ${[...stack, nodeDisplay].join(' -> ')}`);
      return;
    }

    visiting.add(nodeKey);
    const deps = normalizeStringArray(contract?.plan?.depends_on);
    contract.plan.depends_on = deps;

    for (const dependencyRaw of deps) {
      const dependencyRef = normalizeDependencyReference(dependencyRaw, contractProject);
      if (
        dependencyRef.project === contractProject
        && dependencyRef.plan_id === contract.plan.plan_id
      ) {
        dependencyErrors.push(`plan ${nodeDisplay} cannot depend on itself`);
        continue;
      }
      const dependencyNode = resolveDependencyNode(
        dependencyRef,
        contractProject,
        contract.plan.plan_id,
      );
      if (!dependencyNode) {
        continue;
      }
      visit(dependencyNode.project, dependencyNode.contract, [...stack, nodeDisplay]);
    }

    visiting.delete(nodeKey);
    visited.add(nodeKey);
  }

  for (const contract of contracts) {
    visit(project, contract);
  }

  if (dependencyErrors.length > 0) {
    fail(`workflow dependency validation failed:\n- ${uniqueStrings(dependencyErrors).join('\n- ')}`);
  }

  return contracts;
}

function syncWorkflowState(state, contracts, workflowSettings) {
  const existingByPath = new Map(
    ensureArray(state.workflow?.plans).map((item) => [item.plan_json, item]),
  );

  const plans = contracts.map((contract) => {
    const existing = existingByPath.get(contract.plan_json_rel);
    const matchesLegacyHash =
      typeof existing?.contract_hash === 'string' &&
      existing.contract_hash === hashPlanContractLegacy(contract.plan);
    const contractChanged =
      typeof existing?.contract_hash === 'string' &&
      existing.contract_hash !== contract.contract_hash &&
      !matchesLegacyHash;
    return {
      plan_id: contract.plan.plan_id,
      plan_json: contract.plan_json_rel,
      plan_md: contract.plan_md_rel,
      depends_on: normalizeStringArray(contract.plan.depends_on),
      contract_hash: contract.contract_hash,
      contract_changed: contractChanged,
      status: existing?.status === 'complete' && !contractChanged ? 'complete' : 'pending',
      last_result: contractChanged ? null : existing?.last_result || null,
      last_cycle: contractChanged ? null : existing?.last_cycle || null,
    };
  });

  state.workflow = {
    auto_continue: workflowSettings.auto_continue,
    pause_reason: workflowSettings.pause_reason,
    stop_on_failure: workflowSettings.stop_on_failure,
    max_phases_per_run: workflowSettings.max_phases_per_run,
    plans,
  };
}

function resolveWorkflowDependencyState(project, workflowPlans, projectContextCache = new Map()) {
  const localPlansById = new Map(workflowPlans.map((plan) => [plan.plan_id, plan]));
  return ensureArray(workflowPlans).map((plan) => ({
    plan_id: plan.plan_id,
    unmet_dependencies: normalizeStringArray(plan.depends_on)
      .map((dependencyRaw) => {
        const dependencyRef = normalizeDependencyReference(dependencyRaw, project);
        if (dependencyRef.project === project) {
          const localDependency = localPlansById.get(dependencyRef.plan_id);
          if (!localDependency) {
            fail(`workflow dependency resolution failed: unknown local plan reference ${dependencyRaw} for ${plan.plan_id}`);
          }
          return localDependency.status === 'complete'
            ? null
            : {
                plan_id: formatDependencyReference(project, dependencyRef.plan_id, project),
                project,
                status: localDependency.status,
                external: false,
              };
        }

        const dependencyErrors = [];
        const context = loadWorkflowProjectContext(
          dependencyRef.project,
          projectContextCache,
          dependencyErrors,
        );
        if (!context) {
          fail(`workflow dependency resolution failed:\n- ${dependencyErrors.join('\n- ')}`);
        }

        const dependencyContract = context.contractsById.get(dependencyRef.plan_id);
        if (!dependencyContract) {
          fail(
            `workflow dependency resolution failed: missing dependency plan ${formatDependencyReference(dependencyRef.project, dependencyRef.plan_id)}`,
          );
        }

        const dependencyState = context.workflowPlansById.get(dependencyRef.plan_id);
        const dependencyStatus = dependencyState?.status || 'pending';
        return dependencyStatus === 'complete'
          ? null
          : {
              plan_id: formatDependencyReference(dependencyRef.project, dependencyRef.plan_id),
              project: dependencyRef.project,
              status: dependencyStatus,
              external: true,
            };
      })
      .filter(Boolean),
  }));
}

function buildDependencyGroups(project, workflowPlans) {
  const plansById = new Map(workflowPlans.map((plan) => [plan.plan_id, plan]));
  const groupByPlanId = new Map();
  const visiting = new Set();

  function resolveGroup(planId) {
    if (groupByPlanId.has(planId)) {
      return groupByPlanId.get(planId);
    }
    if (visiting.has(planId)) {
      return 1;
    }

    visiting.add(planId);
    const plan = plansById.get(planId);
    const dependencyGroups = normalizeStringArray(plan?.depends_on)
      .map((dependencyRaw) => normalizeDependencyReference(dependencyRaw, project))
      .filter((dependencyRef) => dependencyRef.project === project && plansById.has(dependencyRef.plan_id))
      .map((dependencyRef) => resolveGroup(dependencyRef.plan_id));
    const group = dependencyGroups.length === 0 ? 1 : Math.max(...dependencyGroups) + 1;
    visiting.delete(planId);
    groupByPlanId.set(planId, group);
    return group;
  }

  for (const plan of workflowPlans) {
    resolveGroup(plan.plan_id);
  }

  const groups = [...new Set(groupByPlanId.values())]
    .sort((a, b) => a - b)
    .map((groupNumber) => {
      const plans = workflowPlans
        .filter((plan) => groupByPlanId.get(plan.plan_id) === groupNumber)
        .map((plan) => plan.plan_id);

      return {
        group: groupNumber,
        label:
          plans.length > 1
            ? `Group ${groupNumber} (parallel — dependencies satisfied)`
            : `Group ${groupNumber}`,
        plans,
      };
    });

  return {
    parallel_groups: groups.length,
    groups,
    group_by_plan_id: groupByPlanId,
  };
}

function getDependencyBlockers(project, workflowPlans, projectContextCache = new Map()) {
  const dependencyState = resolveWorkflowDependencyState(project, workflowPlans, projectContextCache);
  const blockers = [];

  for (const plan of workflowPlans) {
    if (plan.status !== 'pending') {
      continue;
    }

    const unmet = ensureArray(
      dependencyState.find((entry) => entry.plan_id === plan.plan_id)?.unmet_dependencies,
    );

    if (unmet.length > 0) {
      blockers.push({
        plan_id: plan.plan_id,
        unmet_dependencies: unmet,
      });
    }
  }

  return blockers;
}

function findNextRunnableWorkflowPlan(project, workflowPlans) {
  return getReadyWorkflowPlans(project, workflowPlans)[0] || null;
}

function getReadyWorkflowPlans(project, workflowPlans) {
  const dependencyBlockers = getDependencyBlockers(project, workflowPlans);
  const blockedPlanIds = new Set(dependencyBlockers.map((blocker) => blocker.plan_id));
  return ensureArray(workflowPlans).filter(
    (workflowPlan) => workflowPlan.status === 'pending' && !blockedPlanIds.has(workflowPlan.plan_id),
  );
}

function findReadyWorkflowGroup(project, workflowPlans) {
  const readyPlans = getReadyWorkflowPlans(project, workflowPlans);
  if (readyPlans.length === 0) {
    return null;
  }

  const dependencyGroups = buildDependencyGroups(project, workflowPlans);
  const lowestGroup = Math.min(
    ...readyPlans.map((plan) => dependencyGroups.group_by_plan_id.get(plan.plan_id) || 1),
  );

  return {
    group: lowestGroup,
    plans: readyPlans.filter(
      (plan) => (dependencyGroups.group_by_plan_id.get(plan.plan_id) || 1) === lowestGroup,
    ),
  };
}

function describeReadyWorkflowPlans(readyPlans) {
  const plans = ensureArray(readyPlans);
  const planIds = plans.map((plan) => plan.plan_id);
  if (planIds.length === 0) {
    return 'No ready plans.';
  }
  if (planIds.length === 1) {
    const dependencyIds = normalizeStringArray(plans[0]?.depends_on);
    if (dependencyIds.length > 0) {
      return `Continue with ${planIds[0]}. Only the lowest-numbered ready dependency group advances in a cycle, and execution will refresh from dependency evidence: ${dependencyIds.join(', ')}.`;
    }
    return `Continue with ${planIds[0]}. Only the lowest-numbered ready dependency group advances in a cycle.`;
  }
  return `Continue with ready plans: ${planIds.join(', ')}. Only the lowest-numbered ready dependency group advances in a cycle.`;
}

function describeDependencyBlockers(dependencyBlockers) {
  return dependencyBlockers.map((blocker) => {
    const unmet = blocker.unmet_dependencies
      .map((dependency) => `${dependency.plan_id} (${dependency.status})`)
      .join(', ');
    return `${blocker.plan_id} <= ${unmet}`;
  }).join('; ');
}

function resolveActionablePlanContext(project, paths, state, rootPlan) {
  const workflowPlans = ensureArray(state.workflow?.plans);
  const currentPlanId = state.current_plan?.plan_id || null;
  const currentWorkflowPlan = currentPlanId
    ? workflowPlans.find((workflowPlan) => workflowPlan.plan_id === currentPlanId) || null
    : null;
  const readyWorkflowGroup = findReadyWorkflowGroup(project, workflowPlans);
  const nextRunnablePending = readyWorkflowGroup?.plans[0] || null;

  let actionableWorkflowPlan = currentWorkflowPlan;
  let actionableWorkflowPlans = actionableWorkflowPlan ? [actionableWorkflowPlan] : [];
  let actionableGroup = null;
  if (!isPlanningLifecycleStatus(state.lifecycle?.status)) {
    const currentStatus = currentWorkflowPlan?.status || null;
    if (!currentWorkflowPlan || currentStatus === 'complete') {
      actionableWorkflowPlan = nextRunnablePending || currentWorkflowPlan;
      actionableWorkflowPlans = readyWorkflowGroup?.plans || (actionableWorkflowPlan ? [actionableWorkflowPlan] : []);
      actionableGroup = readyWorkflowGroup?.group || null;
    } else if (currentStatus !== 'failed' && nextRunnablePending && currentWorkflowPlan.plan_id === `${project}-plan`) {
      actionableWorkflowPlan = nextRunnablePending;
      actionableWorkflowPlans = readyWorkflowGroup?.plans || (actionableWorkflowPlan ? [actionableWorkflowPlan] : []);
      actionableGroup = readyWorkflowGroup?.group || null;
    } else if (nextRunnablePending && (!readyWorkflowGroup || !readyWorkflowGroup.plans.some((plan) => plan.plan_id === currentWorkflowPlan?.plan_id))) {
      actionableWorkflowPlan = nextRunnablePending;
      actionableWorkflowPlans = readyWorkflowGroup?.plans || [nextRunnablePending];
      actionableGroup = readyWorkflowGroup?.group || null;
    } else if (readyWorkflowGroup && readyWorkflowGroup.plans.some((plan) => plan.plan_id === currentWorkflowPlan?.plan_id)) {
      actionableWorkflowPlans = readyWorkflowGroup.plans;
      actionableGroup = readyWorkflowGroup.group;
    }
  }

  const planPath = actionableWorkflowPlan?.plan_json
    ? path.resolve(REPO_ROOT, actionableWorkflowPlan.plan_json)
    : state.current_plan?.plan_json
      ? path.resolve(REPO_ROOT, state.current_plan.plan_json)
      : paths.planJsonPath;
  const plan = fs.existsSync(planPath) ? readJson(planPath) : rootPlan;

  return {
    workflow_plan: actionableWorkflowPlan,
    workflow_plans: actionableWorkflowPlans,
    plan,
    plan_path: planPath,
    plan_id: actionableWorkflowPlan?.plan_id || plan?.plan_id || state.current_plan?.plan_id || rootPlan.plan_id,
    plan_ids: actionableWorkflowPlans.map((planItem) => planItem.plan_id),
    group: actionableGroup,
    next_runnable_pending: nextRunnablePending,
  };
}

async function executeSinglePlan(contract, cycleNumber, projectDir) {
  const baselineDirty = getDirtyPaths();
  const baselineDirtyArray = [...baselineDirty].sort();
  const startedAt = nowIso();

  const preflight = runPreflight(contract.plan, baselineDirtyArray);
  const verifyResults = preflight.passed ? await runVerifyCommands(contract.plan, projectDir) : [];
  const verifyMap = new Map(verifyResults.map((result) => [result.id, result]));
  const acceptance = preflight.passed ? evaluateAcceptance(contract.plan, verifyMap) : [];
  const scope = preflight.passed
    ? enforceWriteScope(contract.plan, baselineDirty, contract.plan.preflight.require_clean_worktree)
    : {
        mode: contract.plan.preflight.require_clean_worktree ? 'workspace' : 'delta',
        changed_paths: [],
        allowed_globs: uniqueStrings([
          ...ensureArray(contract.plan.allowed_files),
          ...ensureArray(contract.plan.write_scope?.allowed_files),
        ]),
        blocked_globs: uniqueStrings([
          ...ensureArray(contract.plan.blocked_files),
          ...ensureArray(contract.plan.write_scope?.blocked_files),
        ]),
        pass: false,
        violations: [{ file: '(n/a)', reason: 'scope check skipped due to preflight failure' }],
      };
  const postflight = preflight.passed ? await runPostflight(contract.plan, projectDir) : [];
  const failures = summarizeFailures(preflight, verifyResults, acceptance, scope, postflight);
  const result = failures.length === 0 ? 'pass' : 'fail';
  const completedAt = nowIso();

  return {
    cycle: cycleNumber,
    plan_id: contract.plan.plan_id,
    plan_json: contract.plan_json_rel,
    plan_md: contract.plan_md_rel,
    objective: contract.plan.objective,
    scope_text: contract.plan.scope,
    started_at: startedAt,
    completed_at: completedAt,
    result,
    failures,
    preflight,
    verify_commands: verifyResults.map((item) => ({
      id: item.id,
      run: item.run,
      cwd: path.relative(REPO_ROOT, item.cwd),
      status: item.result.status,
      pass: item.pass,
      duration_ms: item.result.durationMs,
      stdout_tail: item.result.stdout.slice(-500),
      stderr_tail: item.result.stderr.slice(-500),
    })),
    acceptance,
    scope: {
      mode: scope.mode,
      pass: scope.pass,
      changed_paths: scope.changed_paths,
      allowed_globs: scope.allowed_globs,
      blocked_globs: scope.blocked_globs,
      violations: scope.violations,
    },
    postflight: postflight.map((item) => ({
      id: item.id,
      run: item.run,
      cwd: path.relative(REPO_ROOT, item.cwd),
      status: item.result.status,
      pass: item.pass,
      duration_ms: item.result.durationMs,
      stdout_tail: item.result.stdout.slice(-500),
      stderr_tail: item.result.stderr.slice(-500),
    })),
  };
}

function buildExecReport(project, rootPlan, executedPlans, state) {
  const lines = [];
  const dependencyBlockers = getDependencyBlockers(project, ensureArray(state.workflow?.plans));
  const contractChanges = ensureArray(state.workflow?.plans).filter((plan) => plan.contract_changed);
  const paths = getProjectPaths(project);
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  lines.push(`# EXEC-REPORT — ${project}`);
  lines.push('');
  lines.push(`- Generated: ${nowIso()}`);
  lines.push(`- Profile: ${rootPlan.profile}`);
  lines.push(`- Cycles this run: ${executedPlans.length}`);
  lines.push(`- Lifecycle status: ${state.lifecycle.status}`);
  lines.push(`- Next action: ${state.lifecycle.next_action}`);
  lines.push('');

  if (contractChanges.length > 0) {
    lines.push('## Contract Changes');
    for (const plan of contractChanges) {
      lines.push(`- ${plan.plan_id}: plan contract changed, previous completion state was reset`);
    }
    lines.push('');
  }

  if (executedPlans.length === 0) {
    if (
      runtimeContext.delegation.mode === 'runtime_subagents' &&
      runtimeContext.delegation.owner === 'runtime_orchestrator' &&
      runtimeContext.dispatches.length > 0 &&
      !runtimeContext.all_dispatches_completed_fresh
    ) {
      lines.push(`No pending plans were executed because ${runtimeContext.actionable.plan_id} is waiting on runtime dispatch work.`);
      lines.push('This planning/execution loop is not complete until the host runtime runs lifecycle.next_command and reconciles again.');
      lines.push('');
      lines.push('## Runtime Dispatches');
      for (const dispatch of runtimeContext.dispatches) {
        lines.push(`- ${dispatch.dispatch_id}: ${dispatch.status} / ${dispatch.freshness?.status || 'pending'}`);
      }
    } else if (dependencyBlockers.length === 0) {
      lines.push('No pending plans were executed in this run.');
    } else {
      lines.push('No pending plans were executed because all remaining work is dependency-blocked.');
      lines.push('');
      lines.push('## Dependency Blockers');
      for (const blocker of dependencyBlockers) {
        const unmet = blocker.unmet_dependencies
          .map((dependency) => `${dependency.plan_id} (${dependency.status})`)
          .join(', ');
        lines.push(`- ${blocker.plan_id}: waiting on ${unmet}`);
      }
      const readyGroup = buildReadyPlanGroup(project, ensureArray(state.workflow?.plans));
      if (readyGroup?.plans?.length > 0) {
        lines.push('');
        lines.push('## Ready Group');
        lines.push(`- Current runnable group: ${readyGroup.group}`);
        lines.push(`- Plans in that group: ${readyGroup.plans.map((plan) => plan.plan_id).join(', ')}`);
      }
    }
    lines.push('');
    return `${lines.join('\n')}\n`;
  }

  lines.push('## Run Summary');
  lines.push('| Plan | Result | Failures |');
  lines.push('|---|---|---|');
  for (const entry of executedPlans) {
    lines.push(`| ${entry.plan_id} | ${entry.result.toUpperCase()} | ${entry.failures.length ? entry.failures.join(', ') : 'none'} |`);
  }
  lines.push('');

  for (const entry of executedPlans) {
    const acceptanceGaps = entry.acceptance.filter((item) => !item.pass).map((item) => item.id);
    lines.push(`## ${entry.plan_id}`);
    lines.push(`- Plan file: ${entry.plan_json}`);
    lines.push(`- Result: ${entry.result.toUpperCase()}`);
    lines.push(`- Execution result: ${(entry.execution_result || entry.result).toUpperCase()}`);
    lines.push(`- Verdict: ${(entry.verdict?.result || 'not-run').toUpperCase()}`);
    lines.push(`- Review: ${(entry.review?.result || 'not-run').toUpperCase()}`);
    lines.push(`- Started: ${entry.started_at}`);
    lines.push(`- Completed: ${entry.completed_at}`);
    lines.push('');
    lines.push('### Objective');
    lines.push(entry.objective);
    lines.push('');
    lines.push('### Scope');
    lines.push(entry.scope_text);
    lines.push('');
    lines.push('### Verify Commands');
    lines.push('| ID | Result | Exit | Command |');
    lines.push('|---|---|---:|---|');
    for (const command of entry.verify_commands) {
      lines.push(`| ${command.id} | ${command.pass ? 'PASS' : 'FAIL'} | ${command.status} | \`${command.run}\` |`);
    }
    lines.push('');
    lines.push('### Acceptance Criteria');
    lines.push('| AC | Result | Commands |');
    lines.push('|---|---|---|');
    for (const ac of entry.acceptance) {
      lines.push(`| ${ac.id} | ${ac.pass ? 'PASS' : 'FAIL'} | ${ac.command_ids.join(', ')} |`);
    }
    lines.push('');
    lines.push(`- Scope violations: ${entry.scope.violations.length === 0 ? 'none' : entry.scope.violations.map((item) => `${item.file} (${item.reason})`).join(', ')}`);
    lines.push(`- Acceptance gaps: ${acceptanceGaps.length === 0 ? 'none' : acceptanceGaps.join(', ')}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function dispatchGroupForRole(project, currentPlanId, role) {
  if (currentPlanId === `${project}-plan`) {
    if (role === 'strategist') {
      return 1;
    }
    if (role === 'detailer') {
      return 2;
    }
    return 3;
  }

  if (role === 'executor') {
    return 1;
  }
  if (role === 'judge') {
    return 2;
  }
  if (role === 'reviewer') {
    return 3;
  }
  if (role === 'fixer') {
    return 4;
  }
  return 1;
}

function agentTypeHintForRole(role, stage) {
  if (role === 'executor' || role === 'fixer') {
    return 'worker';
  }
  if (stage === 'planning') {
    return 'default';
  }
  if (role === 'judge' || role === 'reviewer') {
    return 'default';
  }
  return 'default';
}

function reasoningHintForRole(role, stage) {
  if (stage === 'planning' || role === 'judge' || role === 'reviewer' || role === 'fixer') {
    return 'high';
  }
  return 'medium';
}

function resultArtifactsForDispatch(project, currentPlanId, planId, role, delegation) {
  if (currentPlanId === `${project}-plan`) {
    return buildPlanningRoleResultArtifacts(project, role, planId);
  }

  if (role === 'detailer') {
    return buildPlanningRoleResultArtifacts(project, 'detailer', planId);
  }

  if (delegation.mode === 'runtime_subagents' && planId === currentPlanId) {
    if (delegation.result_artifacts.length > 0) {
      return delegation.result_artifacts;
    }
    return [getRuntimeExecutionResultPaths(project, planId, role).jsonRel];
  }

  return [];
}

function getRuntimeDispatchEntry(state, dispatchId) {
  const orchestration = ensureOrchestrationState(state);
  const byId = orchestration.runtime_dispatches?.by_id;
  if (!byId || typeof byId !== 'object' || Array.isArray(byId)) {
    return null;
  }
  const entry = byId[dispatchId];
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
}

function isRuntimeDispatchCompletedFresh(state, planId, role) {
  const dispatchId = dispatchIdFor(planId, role);
  const entry = getRuntimeDispatchEntry(state, dispatchId);
  return entry?.status === 'completed' && entry?.freshness?.status === 'fresh';
}

function buildRuntimeDispatches(project, paths, state, actionableContext) {
  const orchestration = ensureOrchestrationState(state);
  const byPlan = orchestration.capsules.by_plan || {};
  const currentPlan = actionableContext.plan;
  const activePlanId = actionableContext.plan_id || currentPlan?.plan_id || state.current_plan?.plan_id || null;
  const rootExecutionContract = {
    plan: currentPlan,
    plan_json_rel: actionableContext.workflow_plan?.plan_json || state.current_plan?.plan_json || '',
    plan_md_rel: actionableContext.workflow_plan?.plan_md || state.current_plan?.plan_md || '',
  };
  const delegation = activePlanId === `${project}-plan`
    ? normalizeDelegationConfig(currentPlan)
    : resolveExecutionDelegation(project, state, rootExecutionContract);
  const dispatches = [];

  const pushDispatch = (planId, role, capsuleJsonRel, currentDelegation = delegation, groupOverride = null, instructionOverride = null) => {
    if (typeof capsuleJsonRel !== 'string' || !capsuleJsonRel.trim()) {
      return;
    }
    const stage = activePlanId === `${project}-plan` ? 'planning' : inferPlanStage(project, currentPlan);
    const resultArtifacts = resultArtifactsForDispatch(project, activePlanId, planId, role, currentDelegation);
    const artifactChangeRequired = artifactChangeRequiredForRole(role);
    const dispatch = {
      plan_id: planId,
      role,
      group: groupOverride || dispatchGroupForRole(project, activePlanId, role),
      agent_type_hint: agentTypeHintForRole(role, stage),
      reasoning_effort_hint: reasoningHintForRole(role, stage),
      capsule_json: path.resolve(REPO_ROOT, capsuleJsonRel),
      result_artifacts: resultArtifacts,
      artifact_change_required: artifactChangeRequired,
      completion_requirements: buildDispatchCompletionRequirements(resultArtifacts, artifactChangeRequired),
      instruction: instructionOverride || `Read the capsule first, then produce the required result artifacts for ${planId} without widening scope.`,
      spawn_recommended: true,
    };
    dispatch.dispatch_id = dispatchIdFor(dispatch.plan_id, dispatch.role);
    dispatch.signature = dispatchSignature(dispatch);
    dispatches.push(dispatch);
  };

  const maybePushDetailerRefreshDispatch = (contract, groupOverride = null) => {
    if (!shouldAutoDetailerRefresh(state, contract)) {
      return false;
    }
    const refreshCapsule = buildExecutionDetailerRefreshCapsule(
      project,
      contract,
      state,
      (state.lifecycle?.cycle_count || 0) + 1,
    );
    const refreshCapsuleRel = writeDispatchCapsule(paths, state, refreshCapsule).jsonRel;
    const refreshSignals = collectPhaseRefreshSignals(state, contract);
    const instruction = refreshSignals.length > 0
      ? `Read the capsule first, then refresh ${contract.plan.plan_id} against upstream drift without widening scope. Signals: ${refreshSignals.slice(0, 4).join('; ')}`
      : `Read the capsule first, then refresh ${contract.plan.plan_id} against upstream drift without widening scope.`;
    pushDispatch(
      contract.plan.plan_id,
      'detailer',
      refreshCapsuleRel,
      {
        mode: 'runtime_subagents',
        owner: 'runtime_orchestrator',
        runtime_roles: ['detailer'],
        dispatch_artifacts: [`.smike/${project}/STATE.json`],
        result_artifacts: buildPlanningRoleResultArtifacts(project, 'detailer', contract.plan.plan_id),
      },
      groupOverride || 1,
      instruction,
    );
    return true;
  };

  if (activePlanId === `${project}-plan`) {
    if (delegation.mode !== 'runtime_subagents') {
      return [];
    }
    const runtimeRoles = new Set(normalizeStringArray(delegation.runtime_roles || []));
    const rootRoleMap = byPlan[activePlanId] || {};
    for (const role of ['strategist', 'checker', 'auditor']) {
      if (!runtimeRoles.has(role)) {
        continue;
      }
      pushDispatch(activePlanId, role, rootRoleMap[role]);
    }

    for (const [planId, roleMap] of Object.entries(byPlan)) {
      if (planId === activePlanId) {
        continue;
      }
      if (!runtimeRoles.has('detailer')) {
        continue;
      }
      pushDispatch(planId, 'detailer', roleMap?.detailer);
    }

    return dispatches.sort((a, b) => a.group - b.group || a.plan_id.localeCompare(b.plan_id));
  }

  if (ensureArray(actionableContext.workflow_plans).length > 1 && actionableContext.group !== null) {
    for (const workflowPlan of actionableContext.workflow_plans) {
      const planJsonPath = workflowPlan?.plan_json ? path.resolve(REPO_ROOT, workflowPlan.plan_json) : null;
      const planMdPath = workflowPlan?.plan_md ? path.resolve(REPO_ROOT, workflowPlan.plan_md) : null;
      if (!planJsonPath || !fs.existsSync(planJsonPath)) {
        continue;
      }

      const contract = resolvePlanContract(paths.projectDir, planJsonPath, planMdPath);
      if (maybePushDetailerRefreshDispatch(contract, actionableContext.group || 1)) {
        continue;
      }
      const planDelegation = resolveExecutionDelegation(project, state, contract);
      if (
        planDelegation.mode !== 'runtime_subagents'
        || planDelegation.owner !== 'runtime_orchestrator'
        || !planDelegation.runtime_roles.includes('executor')
      ) {
        continue;
      }

      const executorCapsule = buildExecutorCapsule(
        project,
        contract,
        state,
        (state.lifecycle?.cycle_count || 0) + 1,
        planDelegation,
      );
      const executorCapsuleRel = writeDispatchCapsule(paths, state, executorCapsule).jsonRel;

      const instruction = planDelegation.result_artifacts.length > 0
        ? `Read the capsule first, then produce the required result artifacts for ${contract.plan.plan_id} without widening scope.`
        : `Read the capsule first, then implement ${contract.plan.plan_id} inside the declared write scope before reconciliation.`;
      pushDispatch(
        contract.plan.plan_id,
        'executor',
        executorCapsuleRel,
        planDelegation,
        actionableContext.group || 1,
        instruction,
      );
    }
    return dispatches.sort((a, b) => a.group - b.group || a.plan_id.localeCompare(b.plan_id));
  }

  if (ensureArray(actionableContext.workflow_plans).length === 1 && actionableContext.group !== null) {
    const workflowPlan = actionableContext.workflow_plans[0];
    const planJsonPath = workflowPlan?.plan_json ? path.resolve(REPO_ROOT, workflowPlan.plan_json) : null;
    const planMdPath = workflowPlan?.plan_md ? path.resolve(REPO_ROOT, workflowPlan.plan_md) : null;
    if (planJsonPath && fs.existsSync(planJsonPath)) {
      const contract = resolvePlanContract(paths.projectDir, planJsonPath, planMdPath);
      const baseGroup = actionableContext.group || 1;
      if (maybePushDetailerRefreshDispatch(contract, baseGroup)) {
        return dispatches.sort((a, b) => a.group - b.group || a.role.localeCompare(b.role));
      }
      const planDelegation = resolveExecutionDelegation(project, state, contract);
      if (
        planDelegation.mode === 'runtime_subagents'
        && planDelegation.owner === 'runtime_orchestrator'
        && planDelegation.runtime_roles.includes('executor')
      ) {
        const executorCapsule = buildExecutorCapsule(
          project,
          contract,
          state,
          (state.lifecycle?.cycle_count || 0) + 1,
          planDelegation,
        );
        const executorCapsuleRel = writeDispatchCapsule(paths, state, executorCapsule).jsonRel;
        const instruction = planDelegation.result_artifacts.length > 0
          ? `Read the capsule first, then produce the required result artifacts for ${contract.plan.plan_id} without widening scope.`
          : `Read the capsule first, then implement ${contract.plan.plan_id} inside the declared write scope before reconciliation.`;
        if (!isRuntimeDispatchCompletedFresh(state, contract.plan.plan_id, 'executor')) {
          pushDispatch(
            contract.plan.plan_id,
            'executor',
            executorCapsuleRel,
            planDelegation,
            baseGroup,
            instruction,
          );
          return dispatches.sort((a, b) => a.group - b.group || a.role.localeCompare(b.role));
        }

        const executorDispatchEntry = getRuntimeDispatchEntry(state, dispatchIdFor(contract.plan.plan_id, 'executor'));
        const verifiedResultArtifacts = verifiedArtifactPathsFromCompletionArtifacts(executorDispatchEntry);
        if (planDelegation.result_artifacts.length > 0 && verifiedResultArtifacts.length === 0) {
          return [];
        }

        if (
          planDelegation.runtime_roles.includes('judge')
          && !isRuntimeDispatchCompletedFresh(state, contract.plan.plan_id, 'judge')
        ) {
          const judgeCapsule = buildRuntimeFollowOnCapsule(
            project,
            contract,
            state,
            'judge',
            (state.lifecycle?.cycle_count || 0) + 1,
            verifiedResultArtifacts,
          );
          const judgeCapsuleRel = writeDispatchCapsule(paths, state, judgeCapsule).jsonRel;
          pushDispatch(
            contract.plan.plan_id,
            'judge',
            judgeCapsuleRel,
            planDelegation,
            baseGroup + 1,
          );
          return dispatches.sort((a, b) => a.group - b.group || a.role.localeCompare(b.role));
        }

        if (
          planDelegation.runtime_roles.includes('reviewer')
          && !isRuntimeDispatchCompletedFresh(state, contract.plan.plan_id, 'reviewer')
        ) {
          const reviewerCapsule = buildRuntimeFollowOnCapsule(
            project,
            contract,
            state,
            'reviewer',
            (state.lifecycle?.cycle_count || 0) + 1,
            verifiedResultArtifacts,
          );
          const reviewerCapsuleRel = writeDispatchCapsule(paths, state, reviewerCapsule).jsonRel;
          pushDispatch(
            contract.plan.plan_id,
            'reviewer',
            reviewerCapsuleRel,
            planDelegation,
            baseGroup + 2,
          );
          return dispatches.sort((a, b) => a.group - b.group || a.role.localeCompare(b.role));
        }

        return [];
      }
    }
  }

  if (delegation.mode !== 'runtime_subagents') {
    return [];
  }
  const currentRoleMap = byPlan[activePlanId] || {};
  for (const role of delegation.runtime_roles) {
    pushDispatch(activePlanId, role, currentRoleMap[role] || orchestration.capsules.latest_by_role?.[role], delegation);
  }

  return dispatches.sort((a, b) => a.group - b.group || a.role.localeCompare(b.role));
}

function createRuntimeDispatchEntry(dispatch, createdAt = nowIso()) {
  const entry = {
    dispatch_id: dispatch.dispatch_id,
    plan_id: dispatch.plan_id,
    role: dispatch.role,
    group: dispatch.group,
    current: true,
    signature: dispatch.signature,
    capsule_json: normalizeRel(dispatch.capsule_json),
    result_artifacts: normalizePathList(dispatch.result_artifacts || []),
    artifact_change_required: dispatch.artifact_change_required === true,
    completion_requirements: normalizeDispatchCompletionRequirements(
      dispatch.completion_requirements,
      dispatch.result_artifacts,
      dispatch.artifact_change_required,
    ),
    agent_type_hint: dispatch.agent_type_hint,
    reasoning_effort_hint: dispatch.reasoning_effort_hint,
    instruction: dispatch.instruction,
    spawn_recommended: dispatch.spawn_recommended !== false,
    status: 'queued',
    created_at: createdAt,
    updated_at: createdAt,
    last_seen_at: createdAt,
    last_spawned_at: null,
    completed_at: null,
    failed_at: null,
    stale_at: null,
    failure_reason: null,
    spawn_baseline: [],
    completion_artifacts: [],
    freshness: createDispatchFreshness('pending', 'Dispatch is queued for the runtime orchestrator.', null),
    transition_log: [],
  };
  appendRuntimeDispatchTransition(entry, 'queued', 'Dispatch enqueued for the runtime orchestrator.', createdAt);
  return entry;
}

function syncRuntimeDispatchState(state, dispatches) {
  const orchestration = ensureOrchestrationState(state);
  const runtimeDispatches = ensureRuntimeDispatchState(orchestration);
  const byId = runtimeDispatches.by_id;
  const seenIds = new Set();
  const syncAt = nowIso();

  for (const entry of Object.values(byId)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      entry.current = false;
    }
  }

  for (const dispatch of dispatches) {
    seenIds.add(dispatch.dispatch_id);
    const existing = resolveRuntimeDispatchEntry(byId, dispatch);
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      byId[dispatch.dispatch_id] = createRuntimeDispatchEntry(dispatch, syncAt);
      continue;
    }

    const signatureChanged = existing.signature && existing.signature !== dispatch.signature;
    existing.plan_id = dispatch.plan_id;
    existing.role = dispatch.role;
    existing.group = dispatch.group;
    existing.current = true;
    existing.signature = dispatch.signature;
    existing.capsule_json = normalizeRel(dispatch.capsule_json);
    existing.result_artifacts = normalizePathList(dispatch.result_artifacts || []);
    existing.artifact_change_required = dispatch.artifact_change_required === true;
    existing.completion_requirements = normalizeDispatchCompletionRequirements(
      dispatch.completion_requirements,
      dispatch.result_artifacts,
      dispatch.artifact_change_required,
    );
    existing.agent_type_hint = dispatch.agent_type_hint;
    existing.reasoning_effort_hint = dispatch.reasoning_effort_hint;
    existing.instruction = dispatch.instruction;
    existing.spawn_recommended = dispatch.spawn_recommended !== false;
    existing.updated_at = syncAt;
    existing.last_seen_at = syncAt;

    if (signatureChanged) {
      existing.spawn_baseline = [];
      existing.completion_artifacts = [];
      existing.freshness = createDispatchFreshness(
        'stale',
        'Dispatch contract changed since the previous runtime pass.',
        syncAt,
      );
      updateRuntimeDispatchStatus(existing, 'stale', 'Dispatch contract changed since the previous runtime pass.', syncAt);
      continue;
    }

    if (existing.status === 'completed') {
      const freshness = buildDispatchFreshnessFromCompletion(existing);
      existing.freshness = freshness;
      if (freshness.status !== 'fresh') {
        updateRuntimeDispatchStatus(existing, 'stale', freshness.reason, syncAt);
      }
      continue;
    }

    if (existing.status === 'spawned') {
      existing.freshness = createDispatchFreshness('pending', 'Runtime dispatch is still in flight.', syncAt);
      continue;
    }

    if (existing.status === 'failed') {
      if (!existing.freshness || existing.freshness.status === 'pending' || existing.freshness.status === 'fresh') {
        existing.freshness = createDispatchFreshness('stale', existing.failure_reason || 'Runtime dispatch failed.', syncAt);
      }
      continue;
    }

    if (existing.status === 'queued') {
      existing.freshness = createDispatchFreshness('pending', 'Dispatch is queued for the runtime orchestrator.', syncAt);
    }
  }

  for (const entry of Object.values(byId)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    if (!seenIds.has(entry.dispatch_id)) {
      entry.current = false;
    }
  }

  const staleEntries = Object.values(byId)
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => entry.current !== true)
    .sort((left, right) => {
      const leftTime = Date.parse(left.last_seen_at || left.updated_at || left.created_at || '') || 0;
      const rightTime = Date.parse(right.last_seen_at || right.updated_at || right.created_at || '') || 0;
      return leftTime - rightTime || left.dispatch_id.localeCompare(right.dispatch_id);
    });
  if (staleEntries.length > MAX_RUNTIME_DISPATCH_HISTORY) {
    for (const entry of staleEntries.slice(0, staleEntries.length - MAX_RUNTIME_DISPATCH_HISTORY)) {
      delete byId[entry.dispatch_id];
    }
  }

  return runtimeDispatches;
}

function matchesRuntimeDispatchPlanFilter(entry, planFilter = null) {
  if (!planFilter) {
    return true;
  }
  if (Array.isArray(planFilter)) {
    return planFilter.includes(entry.plan_id);
  }
  return entry.plan_id === planFilter;
}

function getCurrentRuntimeDispatchEntries(state, planFilter = null) {
  const orchestration = ensureOrchestrationState(state);
  const runtimeDispatches = ensureRuntimeDispatchState(orchestration);
  return Object.values(runtimeDispatches.by_id)
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .filter((entry) => entry.current === true)
    .filter((entry) => matchesRuntimeDispatchPlanFilter(entry, planFilter))
    .sort((left, right) => left.group - right.group || left.plan_id.localeCompare(right.plan_id) || left.role.localeCompare(right.role));
}

function getReadyRuntimeDispatchEntries(state, planFilter = null) {
  const currentEntries = getCurrentRuntimeDispatchEntries(state, planFilter);
  const readyEntries = currentEntries.filter((entry) => entry.status === 'queued' || entry.status === 'stale');
  const minGroup = readyEntries.reduce((value, entry) => Math.min(value, entry.group), Number.POSITIVE_INFINITY);
  return Number.isFinite(minGroup)
    ? readyEntries.filter((entry) => entry.group === minGroup)
    : [];
}

function hasCompletedFreshDispatches(entries) {
  return entries.length > 0 && entries.every((entry) => entry.status === 'completed' && entry.freshness?.status === 'fresh');
}

function buildRuntimeDispatchContract(entry) {
  return {
    dispatch_id: entry.dispatch_id,
    plan_id: entry.plan_id,
    role: entry.role,
    group: entry.group,
    agent_type_hint: entry.agent_type_hint,
    reasoning_effort_hint: entry.reasoning_effort_hint,
    capsule_json: entry.capsule_json,
    result_artifacts: normalizePathList(entry.result_artifacts || []),
    completion_requirements: normalizeDispatchCompletionRequirements(
      entry.completion_requirements,
      entry.result_artifacts,
      entry.artifact_change_required,
    ),
    instruction: entry.instruction,
  };
}

function currentRuntimeDispatchGroup(runtimeContext) {
  return (
    runtimeContext.ready_dispatches[0]?.group
    || runtimeContext.active_dispatches[0]?.group
    || runtimeContext.failed_dispatches[0]?.group
    || runtimeContext.dispatches[0]?.group
    || runtimeContext.actionable.group
    || null
  );
}

function currentCompletableRuntimeDispatchGroup(runtimeContext) {
  const activeGroups = [...new Set(runtimeContext.active_dispatches.map((entry) => entry.group).filter((group) => Number.isInteger(group)))];
  if (activeGroups.length === 1) {
    return activeGroups[0];
  }
  if (activeGroups.length > 1) {
    return 'mixed';
  }
  return 'none';
}

function syncActionableRuntimeDispatchState(project, paths, state, rootPlan) {
  const actionable = resolveActionablePlanContext(project, paths, state, rootPlan);
  const orchestration = ensureOrchestrationState(state);
  const declaredDelegation = normalizeDelegationConfig(actionable.plan);
  const dispatches = buildRuntimeDispatches(project, paths, state, actionable);
  syncRuntimeDispatchState(state, dispatches);
  const planFilter = runtimeDispatchPlanFilterFromActionable(actionable);
  const currentEntries = getCurrentRuntimeDispatchEntries(state, planFilter);
  const readyEntries = getReadyRuntimeDispatchEntries(state, planFilter);
  const activeEntries = currentEntries.filter((entry) => entry.status === 'spawned');
  const failedEntries = currentEntries.filter((entry) => entry.status === 'failed');
  const completedEntries = currentEntries.filter((entry) => entry.status === 'completed');
  const delegation = currentEntries.length > 0
    ? {
      mode: 'runtime_subagents',
      owner: 'runtime_orchestrator',
      runtime_roles: uniqueStrings(currentEntries.map((entry) => entry.role)),
      dispatch_artifacts: declaredDelegation.dispatch_artifacts,
      result_artifacts: uniqueStrings(currentEntries.flatMap((entry) => ensureArray(entry.result_artifacts))),
    }
    : declaredDelegation;
  const currentActionableEntry = readyEntries[0]
    || activeEntries[0]
    || failedEntries[0]
    || currentEntries[0]
    || null;
  orchestration.current_actionable_dispatch = currentActionableEntry
    ? {
      dispatch_id: currentActionableEntry.dispatch_id,
      plan_id: currentActionableEntry.plan_id,
      plan_ids: ensureArray(actionable.plan_ids),
      role: currentActionableEntry.role,
      group: currentActionableEntry.group,
      status: currentActionableEntry.status,
      freshness: currentActionableEntry.freshness?.status || null,
      capsule_json: typeof currentActionableEntry.capsule_json === 'string'
        ? normalizeRel(currentActionableEntry.capsule_json)
        : null,
    }
    : null;
  orchestration.current_actionable_capsule = orchestration.current_actionable_dispatch?.capsule_json || null;
  orchestration.runtime_dispatch_view = {
    actionable_plan: {
      plan_id: actionable.plan_id || null,
      plan_ids: ensureArray(actionable.plan_ids),
      group: currentRuntimeDispatchGroup({
        actionable,
        ready_dispatches: readyEntries,
        active_dispatches: activeEntries,
        failed_dispatches: failedEntries,
        dispatches: currentEntries,
      }),
      completable_group: currentCompletableRuntimeDispatchGroup({
        active_dispatches: activeEntries,
      }),
      plan_json: actionable.plan_path ? path.resolve(actionable.plan_path) : null,
      stage: inferPlanStage(project, actionable.plan),
    },
    ready_dispatches: readyEntries.map((entry) => buildRuntimeDispatchContract(entry)),
    dispatch_counts: {
      tracked: currentEntries.length,
      ready: readyEntries.length,
      active: activeEntries.length,
      failed: failedEntries.length,
      completed: completedEntries.length,
    },
    delegation: {
      mode: delegation.mode,
      owner: delegation.owner,
      result_artifacts: normalizePathList(delegation.result_artifacts || []),
    },
  };

  return {
    actionable,
    delegation,
    dispatches: currentEntries,
    ready_dispatches: readyEntries,
    active_dispatches: activeEntries,
    failed_dispatches: failedEntries,
    completed_dispatches: completedEntries,
    all_dispatches_completed_fresh: currentEntries.length === 0
      ? true
      : hasCompletedFreshDispatches(currentEntries),
  };
}

function generateDerivedArtifacts(project, paths, state, rootPlan) {
  const orchestration = ensureOrchestrationState(state);
  const propagatedDiscoveries = ensureDiscoveryLog(state);
  const latest = state.history[state.history.length - 1] || null;
  const acceptanceGaps = ensureArray(latest?.acceptance)
    .filter((item) => item && item.pass === false)
    .map((item) => item.id);
  const workflowPlans = ensureArray(state.workflow?.plans);
  const nextPending = workflowPlans.find((plan) => plan.status !== 'complete') || null;
  const dependencyBlockers = getDependencyBlockers(project, workflowPlans);
  const dependencyBlockersByPlanId = new Map(
    dependencyBlockers.map((blocker) => [blocker.plan_id, blocker.unmet_dependencies]),
  );
  const contractChanges = workflowPlans
    .filter((plan) => plan.contract_changed)
    .map((plan) => plan.plan_id);
  const dependencyGroups = buildDependencyGroups(project, workflowPlans);
  const planningNotes = extractPlanningNotes(rootPlan, paths.planMdPath, state);
  const loopFindings = collectLoopFindings(state);
  const improvementCandidates = deriveImprovementCandidates(planningNotes, loopFindings);
  const frameworkFrictionCandidates = deriveFrameworkFrictionCandidates(loopFindings);
  const verdictCount = state.history.filter((entry) => entry?.verdict?.generated_at).length;
  const reviewCount = state.history.filter((entry) => entry?.review?.generated_at).length;
  const latestVerdictResult = latest?.verdict?.result || null;
  const latestReviewResult = latest?.review?.result || null;
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  const planningAnalysis = loadPlanningAnalysis(paths);
  const planningFreshness = getPlanningArtifactFreshness(paths);
  const currentDelegation = runtimeContext.delegation;
  const currentDispatchGroup = currentRuntimeDispatchGroup(runtimeContext);
  const completableDispatchGroup = currentCompletableRuntimeDispatchGroup(runtimeContext);
  const readyDispatches = runtimeContext.ready_dispatches.map((entry) => buildRuntimeDispatchContract(entry));
  const latestCapsules = Object.fromEntries(
    Object.entries(orchestration.capsules.latest_by_role || {})
      .filter(([, capsulePath]) => typeof capsulePath === 'string' && capsulePath.trim())
      .map(([role, capsulePath]) => [role, path.resolve(REPO_ROOT, capsulePath)]),
  );
  const roleCapsuleCount = fs.existsSync(paths.capsulesDir)
    ? fs.readdirSync(paths.capsulesDir).filter((fileName) => fileName.endsWith('.json')).length
    : 0;
  const operatorNotes = readPreservedOperatorNotes(paths.notesPath);
  const authoritativeState = {
    path: path.resolve(paths.statePath),
    updated_at: state.updated_at || null,
    lifecycle: {
      status: state.lifecycle?.status || null,
      next_action: state.lifecycle?.next_action || null,
      next_command: getLifecycleNextCommand(state),
      stop_reason: state.lifecycle?.stop_reason || null,
    },
  };
  const workflowPlanDetails = workflowPlans.map((plan) => {
    const planPath = path.resolve(REPO_ROOT, plan.plan_json);
    const planContract = fs.existsSync(planPath) ? readJson(planPath) : null;
    return {
      plan_id: plan.plan_id,
      status: plan.status,
      depends_on: ensureArray(plan.depends_on),
      write_scope: normalizePathList(planContract?.write_scope?.allowed_files || []),
      acceptance_surface: ensureArray(planContract?.acceptance_criteria).map((criterion) => criterion?.description).filter(Boolean),
    };
  });
  const notesMarkdown = buildImprovementNotes(
    project,
    rootPlan,
    state,
    planningNotes,
    loopFindings,
    improvementCandidates,
    operatorNotes,
  );
  syncDurableFeedbackMemory(project, rootPlan, state, planningNotes, loopFindings, frameworkFrictionCandidates);

  const resumeCapsuleJson = {
    schema_version: '2.1.0',
    generated_at: nowIso(),
    project,
    next_action: state.lifecycle.next_action,
    next_command: getLifecycleNextCommand(state),
    stop_reason: state.lifecycle.stop_reason || null,
    current_phase: state.lifecycle.status,
    current_plan: runtimeContext.actionable.plan_id || state.current_plan?.plan_id || null,
    current_plan_group: currentDispatchGroup,
    current_plan_ids: runtimeContext.actionable.plan_ids,
    blockers:
      orchestration.stage === 'planning' && planningAnalysis.blocking_findings.length > 0
        ? planningAnalysis.blocking_findings.map((finding) => `${finding.source}:${finding.id}`)
        : ensureArray(latest?.failures),
    dependency_blockers: dependencyBlockers,
    acceptance_gaps: acceptanceGaps,
    latest_verdict: latestVerdictResult,
    latest_review: latestReviewResult,
    gotchas: ensureArray(state.gotchas),
    planning: {
      checker_result: planningAnalysis.checker?.result || null,
      auditor_result: planningAnalysis.auditor?.result || null,
      artifacts_fresh: !planningFreshness.stale,
      artifacts_freshness_reason: planningFreshness.reason,
      blocking_findings: planningAnalysis.blocking_findings.map((finding) => ({
        source: finding.source,
        id: finding.id,
        title: finding.title,
        severity: finding.severity,
      })),
    },
    orchestration: {
      stage: orchestration.stage,
      active_role: orchestration.active_role,
      last_role: orchestration.last_role,
      next_role: orchestration.next_role,
      runtime_dispatch_view: orchestration.runtime_dispatch_view,
    },
    delegation: {
      mode: currentDelegation.mode,
      owner: currentDelegation.owner,
      ready_dispatch_ids: readyDispatches.map((entry) => entry.dispatch_id),
    },
  };

  const planGraphJson = {
    schema_version: '2.1.0',
    generated_at: nowIso(),
    project,
    phase: rootPlan.phase || null,
    summary: {
      spec: rootPlan.spec || null,
      created: state.created_at || null,
      total_plans: workflowPlans.length || 1,
      parallel_groups: dependencyGroups.parallel_groups,
      blocked_plans: dependencyBlockers.length,
    },
    groups: dependencyGroups.groups,
    dependency_blockers: dependencyBlockers,
    plans: workflowPlans.map((plan) => ({
      plan: plan.plan_id,
      file: plan.plan_md || plan.plan_json,
      group: dependencyGroups.group_by_plan_id.get(plan.plan_id) || 1,
      depends_on: ensureArray(plan.depends_on),
      blocked_by: ensureArray(dependencyBlockersByPlanId.get(plan.plan_id)),
      pause: null,
      status: plan.status,
    })),
  };

  const indexJson = {
    schema_version: '2.1.0',
    generated_at: nowIso(),
    project,
    counts: {
      plans: workflowPlans.length || (fs.existsSync(paths.planMdPath) ? 1 : 0),
      exec_reports: fs.existsSync(paths.execReportPath) ? 1 : 0,
      verdict_reports: verdictCount,
      review_reports: reviewCount,
      planning_reports:
        (fs.existsSync(paths.planningCheckerJsonPath) ? 1 : 0)
        + (fs.existsSync(paths.planningAuditorJsonPath) ? 1 : 0),
      fix_reports: 0,
      role_capsules: roleCapsuleCount,
    },
    next_plan: nextPending ? path.resolve(REPO_ROOT, nextPending.plan_md || nextPending.plan_json) : null,
    latest_reports: {
      exec: fs.existsSync(paths.execReportPath) ? path.resolve(paths.execReportPath) : null,
      verdict: fs.existsSync(paths.verdictReportPath) ? path.resolve(paths.verdictReportPath) : null,
      review: fs.existsSync(paths.reviewReportPath) ? path.resolve(paths.reviewReportPath) : null,
      checker: fs.existsSync(paths.planningCheckerJsonPath) ? path.resolve(paths.planningCheckerJsonPath) : null,
      auditor: fs.existsSync(paths.planningAuditorJsonPath) ? path.resolve(paths.planningAuditorJsonPath) : null,
      handoff: path.resolve(paths.implementationHandoffJsonPath),
      planning_handoff: path.resolve(paths.planningHandoffMdPath),
    },
    orchestration: {
      stage: orchestration.stage,
      active_role: orchestration.active_role,
      last_role: orchestration.last_role,
      next_role: orchestration.next_role,
    },
    latest_capsules: latestCapsules,
    discovery_log_entries: propagatedDiscoveries.length,
  };

  const implementationHandoffJson = {
    schema_version: '1.0.0',
    generated_at: nowIso(),
    project,
    authoritative_state: authoritativeState,
    lifecycle: {
      status: state.lifecycle.status,
      next_action: state.lifecycle.next_action,
      next_command: getLifecycleNextCommand(state),
      stop_reason: state.lifecycle.stop_reason || null,
    },
    planning: {
      checker_result: planningAnalysis.checker?.result || null,
      auditor_result: planningAnalysis.auditor?.result || null,
      artifacts_fresh: !planningFreshness.stale,
      artifacts_freshness_reason: planningFreshness.reason,
    },
    actionable_surface: {
      plan_id: runtimeContext.actionable.plan_id || state.current_plan?.plan_id || null,
      plan_ids: runtimeContext.actionable.plan_ids,
      dispatch_group: currentDispatchGroup,
      completable_group: completableDispatchGroup,
      current_dispatch: orchestration.current_actionable_dispatch,
      current_capsule: orchestration.current_actionable_capsule || null,
    },
    phase_graph: workflowPlanDetails,
    dependency_blockers: dependencyBlockers,
    deferred_items: parseMarkdownBulletSection(paths.strategyPath, 'Deferred Items'),
    protected_areas: parseMarkdownBulletSection(paths.strategyPath, 'Protected Areas'),
  };

  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.notesPath, notesMarkdown, 'utf8');
  writeJson(paths.resumeCapsuleJsonPath, resumeCapsuleJson);
  if (fs.existsSync(paths.resumeCapsuleMdPath)) {
    fs.unlinkSync(paths.resumeCapsuleMdPath);
  }

  writeJson(paths.planGraphJsonPath, planGraphJson);
  if (fs.existsSync(paths.planGraphMdPath)) {
    fs.unlinkSync(paths.planGraphMdPath);
  }

  writeJson(paths.indexJsonPath, indexJson);
  writeJson(paths.implementationHandoffJsonPath, implementationHandoffJson);
  fs.writeFileSync(paths.planningHandoffMdPath, renderPlanningHandoffMarkdown(project, implementationHandoffJson), 'utf8');
  removeLegacyRuntimeDelegationArtifacts(paths.projectDir);
}

async function runCycle(project, cycleOptions = {}) {
  const releaseProjectLock = acquireProjectLock(project, 'cycle');
  try {
  const paths = getProjectPaths(project);

  if (!fs.existsSync(paths.projectDir)) {
    fail(`project directory not found: ${paths.projectDir}`);
  }
  if (!fs.existsSync(paths.planJsonPath)) {
    fail(`missing canonical plan contract: ${paths.planJsonPath}`);
  }

  let rootPlan = readJson(paths.planJsonPath);
  const rootValidationErrors = validatePlan(rootPlan);
  if (rootValidationErrors.length > 0) {
    fail(`PLAN.json validation failed:\n- ${rootValidationErrors.join('\n- ')}`);
  }
  if (rootPlan.profile !== 'codex') {
    fail(`PLAN.json profile is "${rootPlan.profile}". This runner is codex-only; Claude workflow is unchanged.`);
  }
  if (!fs.existsSync(paths.planMdPath)) {
    fail(`missing human plan document: ${paths.planMdPath}`);
  }

  let workflowSettings = resolveWorkflowSettings(rootPlan, cycleOptions);
  let contracts = buildWorkflowContracts(paths, rootPlan, workflowSettings);
  let state = loadOrInitState(project, paths, rootPlan);
  const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : {};
  const planningSpecRel = projectMeta?.spec_path || rootPlan?.spec || state?.planning?.spec_path || null;
  const planningContextFiles = normalizePathList(projectMeta?.context_files || state?.planning?.context_files || []);

  if (isPlanningDraftState(state)) {
    const planningInputRecovery = ensurePlanningInputsReadable(
      project,
      paths,
      planningSpecRel,
      planningContextFiles,
      'planning draft',
    );
    printPlanningInputRecovery(project, planningInputRecovery);

    writePlanningArtifacts(project, planningSpecRel, planningContextFiles, { planningMode: 'draft' });
    rootPlan = readJson(paths.planJsonPath);
    workflowSettings = resolveWorkflowSettings(rootPlan, cycleOptions);
    contracts = buildWorkflowContracts(paths, rootPlan, workflowSettings);
    state = loadOrInitState(project, paths, rootPlan);

    const draftBundle = buildPlanningBundle(project, planningSpecRel, planningContextFiles);
    const draftPhaseContracts = buildPlanningPhaseContracts(project, planningSpecRel, draftBundle);
    const promotionCheck = buildPlanningDraftPromotionCheck(draftBundle, draftPhaseContracts);

    if (!promotionCheck.ready) {
      state.current_plan = {
        plan_id: rootPlan.plan_id,
        plan_json: `.smike/${project}/PLAN.json`,
        plan_md: `.smike/${project}/PLAN.md`,
        depends_on: [],
        contract_hash: hashPlanContract(rootPlan),
      };
      state.lifecycle.status = PLANNING_DRAFT_LIFECYCLE_STATUS;
      state.lifecycle.last_result = null;
      setLifecycleStopReason(state, null);
      setLifecycleNextStep(state, buildPlanningDraftNextAction(project, promotionCheck, draftBundle), buildCycleCommand(project));
      state.updated_at = nowIso();
      if (state.planning && typeof state.planning === 'object') {
        state.planning = {
          ...state.planning,
          status: 'draft',
          completed_at: null,
        };
      }
      const orchestration = ensureOrchestrationState(state);
      orchestration.stage = 'planning';
      orchestration.active_role = null;
      orchestration.next_role = 'strategist';
      persistProjectState(project, paths, state, rootPlan, planningSpecRel);
      console.log(`smike cycle ${project}: DRAFT (0 plans executed)`);
      console.log(`next: ${state.lifecycle.next_action}`);
      return;
    }

    writePlanningArtifacts(project, planningSpecRel, planningContextFiles, { planningMode: 'active' });
    rootPlan = readJson(paths.planJsonPath);
    workflowSettings = resolveWorkflowSettings(rootPlan, cycleOptions);
    contracts = buildWorkflowContracts(paths, rootPlan, workflowSettings);
    state = loadOrInitState(project, paths, rootPlan);
  }

  const previousWorkflow = state.workflow && typeof state.workflow === 'object'
    ? { ...state.workflow }
    : null;
  syncWorkflowState(state, contracts, workflowSettings);
  carryForwardFreshSessionImplementationGate(state, previousWorkflow);
  const orchestration = ensureOrchestrationState(state);
  ensureDiscoveryLog(state);
  const planningRecheck = shouldAutoRecheckPlanning(project, paths, state, planningSpecRel, planningContextFiles);
  if (planningRecheck.stale) {
    await runPlanningRecheckInternal(
      project,
      paths,
      rootPlan,
      state,
      workflowSettings,
      planningSpecRel,
      planningContextFiles,
      { bundle: planningRecheck.bundle, exitOnFailure: true },
    );
    return;
  }
  maybeRecordHandoffFailure(project, state);

  const contractsByPath = new Map(contracts.map((contract) => [contract.plan_json_rel, contract]));
  const executedPlans = [];
  let failTriggered = false;
  let runtimeDispatchPending = null;

  while (executedPlans.length < state.workflow.max_phases_per_run) {
    const nextRunnablePlan = findNextRunnableWorkflowPlan(project, state.workflow.plans);

    if (!nextRunnablePlan) {
      break;
    }
    if (executedPlans.length === 0 && isFreshSessionImplementationPauseReason(state.workflow.pause_reason)) {
      break;
    }
    if (executedPlans.length > 0 && !state.workflow.auto_continue) {
      break;
    }

    const contract = contractsByPath.get(nextRunnablePlan.plan_json);
    if (!contract) {
      fail(`workflow state references unknown plan contract: ${nextRunnablePlan.plan_json}`);
    }
    const planOrchestration = resolveOrchestrationConfig(project, contract.plan);
    const currentRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    const currentPlanDispatches = currentRuntimeContext?.actionable.plan_ids?.includes(contract.plan.plan_id)
      ? currentRuntimeContext.dispatches
      : [];

    if (
      currentPlanDispatches.length > 0 &&
      !currentRuntimeContext.all_dispatches_completed_fresh
    ) {
      state.current_plan = {
        plan_id: contract.plan.plan_id,
        plan_json: contract.plan_json_rel,
        plan_md: contract.plan_md_rel,
        depends_on: ensureArray(contract.plan.depends_on),
        contract_hash: hashPlanContract(contract.plan),
      };
      runtimeDispatchPending = {
        plan_id: contract.plan.plan_id,
        plan_ids: currentRuntimeContext.actionable.plan_ids,
        group: currentRuntimeDispatchGroup(currentRuntimeContext),
        ready_dispatches: currentRuntimeContext.ready_dispatches,
        active_dispatches: currentRuntimeContext.active_dispatches,
        failed_dispatches: currentRuntimeContext.failed_dispatches,
      };
      break;
    }

    if (
      contract.plan.plan_id === `${project}-plan`
      && planOrchestration.stage === 'planning'
      && currentPlanDispatches.length > 0
      && currentRuntimeContext?.all_dispatches_completed_fresh
    ) {
      const planningInputRecovery = ensurePlanningInputsReadable(
        project,
        paths,
        planningSpecRel,
        planningContextFiles,
        'planning phase',
      );
      printPlanningInputRecovery(project, planningInputRecovery);
      const livePlanningBundle = buildPlanningBundle(project, planningSpecRel, planningContextFiles);
      refreshPlanningAnalysisArtifactsFromCurrentPlans(project, paths, livePlanningBundle);
    }

    const cycleNumber = (state.lifecycle?.cycle_count || 0) + 1;
    state.lifecycle = state.lifecycle || {};
    state.lifecycle.cycle_count = cycleNumber;
    state.lifecycle.last_started_at = nowIso();
    state.lifecycle.status = 'running';
    orchestration.stage = planOrchestration.stage;
    orchestration.discovery_propagation = planOrchestration.discovery_propagation;

    state.current_plan = {
      plan_id: contract.plan.plan_id,
      plan_json: contract.plan_json_rel,
      plan_md: contract.plan_md_rel,
      depends_on: ensureArray(contract.plan.depends_on),
      contract_hash: hashPlanContract(contract.plan),
    };

    let executorCapsulePaths = null;
    orchestration.active_role = 'executor';
    orchestration.next_role = 'judge';
    if (planOrchestration.roles.executor.enabled) {
      const executorCapsule = buildExecutorCapsule(project, contract, state, cycleNumber);
      executorCapsulePaths = persistRoleCapsule(
        paths,
        state,
        executorCapsule,
        'prepared',
        `Executor context prepared for ${contract.plan.plan_id}.`,
      );
    }

    const cycleRecord = await executeSinglePlan(contract, cycleNumber, paths.projectDir);
    if (executorCapsulePaths) {
      recordRoleHistory(orchestration, {
        cycle: cycleNumber,
        stage: planOrchestration.stage,
        role: 'executor',
        plan_id: contract.plan.plan_id,
        status: cycleRecord.result,
        capsule_json: executorCapsulePaths.jsonRel,
        generated_at: nowIso(),
        summary: `Executor finished ${contract.plan.plan_id} with ${cycleRecord.result}.`,
      });
      orchestration.last_role = 'executor';
    }

    let judgeCapsulePaths = null;
    orchestration.active_role = 'judge';
    orchestration.next_role = 'reviewer';
    if (planOrchestration.roles.judge.enabled) {
      const judgeCapsule = buildJudgeCapsule(project, paths, contract, state, cycleRecord);
      judgeCapsulePaths = persistRoleCapsule(
        paths,
        state,
        judgeCapsule,
        'prepared',
        `Judge context prepared for ${contract.plan.plan_id}.`,
      );
    }
    const verdictRecord = await buildVerdictRecord(contract, cycleRecord, paths.projectDir);
    if (judgeCapsulePaths) {
      recordRoleHistory(orchestration, {
        cycle: cycleNumber,
        stage: planOrchestration.stage,
        role: 'judge',
        plan_id: contract.plan.plan_id,
        status: verdictRecord.result,
        capsule_json: judgeCapsulePaths.jsonRel,
        generated_at: verdictRecord.generated_at,
        summary: `Judge returned ${verdictRecord.result} for ${contract.plan.plan_id}.`,
      });
      orchestration.last_role = 'judge';
    }
    fs.writeFileSync(paths.verdictReportPath, buildVerdictReport(project, cycleRecord, verdictRecord), 'utf8');

    let reviewerCapsulePaths = null;
    orchestration.active_role = 'reviewer';
    orchestration.next_role = null;
    if (planOrchestration.roles.reviewer.enabled) {
      const reviewerCapsule = buildReviewerCapsule(project, paths, contract, state, cycleRecord, verdictRecord);
      reviewerCapsulePaths = persistRoleCapsule(
        paths,
        state,
        reviewerCapsule,
        'prepared',
        `Reviewer context prepared for ${contract.plan.plan_id}.`,
      );
    }
    const reviewRecord = buildReviewRecord(contract, cycleRecord, verdictRecord);
    if (reviewerCapsulePaths) {
      recordRoleHistory(orchestration, {
        cycle: cycleNumber,
        stage: planOrchestration.stage,
        role: 'reviewer',
        plan_id: contract.plan.plan_id,
        status: reviewRecord.result,
        capsule_json: reviewerCapsulePaths.jsonRel,
        generated_at: reviewRecord.generated_at,
        summary: `Reviewer returned ${reviewRecord.result} for ${contract.plan.plan_id}.`,
      });
      orchestration.last_role = 'reviewer';
    }
    const qualityFailures = uniqueStrings([
      ...ensureArray(cycleRecord.failures),
      ...ensureArray(verdictRecord.failures).map((value) => `judge.${value}`),
      ...(reviewRecord.result === 'concerns' ? ['review.concerns'] : []),
    ]);
    cycleRecord.execution_result = cycleRecord.result;
    cycleRecord.verdict = {
      result: verdictRecord.result,
      failures: verdictRecord.failures,
      generated_at: verdictRecord.generated_at,
    };
    cycleRecord.review = {
      result: reviewRecord.result,
      findings: reviewRecord.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        title: finding.title,
      })),
      generated_at: reviewRecord.generated_at,
    };
    cycleRecord.failures = qualityFailures;
    cycleRecord.result = qualityFailures.length === 0 ? 'pass' : 'fail';

    fs.writeFileSync(paths.reviewReportPath, buildReviewReport(project, cycleRecord, reviewRecord, contract.plan), 'utf8');
    if (cycleRecord.result === 'fail' && planOrchestration.stage !== 'planning' && planOrchestration.roles.fixer.enabled) {
      orchestration.active_role = 'fixer';
      orchestration.next_role = 'fixer';
      const fixerCapsule = buildFixerCapsule(project, paths, contract, state, cycleRecord, verdictRecord, reviewRecord);
      const fixerCapsulePaths = persistRoleCapsule(
        paths,
        state,
        fixerCapsule,
        'routed',
        `Fix route prepared for ${contract.plan.plan_id}.`,
      );
      recordRoleHistory(orchestration, {
        cycle: cycleNumber,
        stage: planOrchestration.stage,
        role: 'fixer',
        plan_id: contract.plan.plan_id,
        status: 'routed',
        capsule_json: fixerCapsulePaths.jsonRel,
        generated_at: nowIso(),
        summary: `Fix route prepared for ${contract.plan.plan_id}.`,
      });
      orchestration.last_role = 'fixer';
    } else {
      orchestration.active_role = null;
      orchestration.next_role = null;
    }

    if (planOrchestration.discovery_propagation) {
      appendPropagatedDiscoveries(
        state,
        contract.plan.plan_id,
        findDownstreamPlanIds(state.workflow.plans, contract.plan.plan_id),
        uniqueStrings([
          ...ensureArray(verdictRecord.failures).map((value) => `judge: ${value}`),
          ...ensureArray(reviewRecord.findings).map((finding) => `${finding.severity} review: ${finding.title}`),
          ...ensureArray(cycleRecord.scope?.violations).map((violation) => `scope: ${violation.file} (${violation.reason})`),
        ]),
      );
    }

    executedPlans.push(cycleRecord);
    state.history.push(cycleRecord);

    nextRunnablePlan.last_result = cycleRecord.result;
    nextRunnablePlan.last_cycle = cycleNumber;
    nextRunnablePlan.status = cycleRecord.result === 'pass' ? 'complete' : 'failed';

    state.lifecycle.last_completed_at = cycleRecord.completed_at;
    state.lifecycle.last_result = cycleRecord.result;
    if (cycleRecord.result === 'fail') {
      failTriggered = true;
      if (state.workflow.stop_on_failure) {
        break;
      }
    }

    if (contract.plan.plan_id === `${project}-plan` && cycleRecord.result === 'pass') {
      const readyPlansAfterPlanning = getReadyWorkflowPlans(project, state.workflow.plans);
      const nextPlanAfterPlanning = readyPlansAfterPlanning[0] || null;
      const nextContractAfterPlanning = nextPlanAfterPlanning
        ? contractsByPath.get(nextPlanAfterPlanning.plan_json)
        : null;
      if (
        nextContractAfterPlanning
        && inferPlanStage(project, nextContractAfterPlanning.plan) !== 'planning'
      ) {
        applyFreshSessionImplementationGate(state);
        break;
      }
    }
  }

  const allComplete = state.workflow.plans.length > 0 && state.workflow.plans.every((plan) => plan.status === 'complete');
  const nextPending = state.workflow.plans.find((plan) => plan.status === 'pending') || null;
  const dependencyBlockers = getDependencyBlockers(project, state.workflow.plans);
  const readyWorkflowPlans = getReadyWorkflowPlans(project, state.workflow.plans);
  const nextRunnablePending = readyWorkflowPlans[0] || null;
  const nextRunnableContract = nextRunnablePending ? contractsByPath.get(nextRunnablePending.plan_json) : null;
  const planningPlan = state.workflow.plans.find((plan) => plan.plan_id === `${project}-plan`) || null;

  if (!runtimeDispatchPending && nextRunnableContract) {
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    if (
      nextRuntimeContext.actionable.plan_ids?.includes(nextRunnableContract.plan.plan_id)
      && nextRuntimeContext.dispatches.length > 0
      && !nextRuntimeContext.all_dispatches_completed_fresh
    ) {
      state.current_plan = {
        plan_id: nextRunnableContract.plan.plan_id,
        plan_json: nextRunnableContract.plan_json_rel,
        plan_md: nextRunnableContract.plan_md_rel,
        depends_on: ensureArray(nextRunnableContract.plan.depends_on),
        contract_hash: hashPlanContract(nextRunnableContract.plan),
      };
      runtimeDispatchPending = {
        plan_id: nextRunnableContract.plan.plan_id,
        plan_ids: nextRuntimeContext.actionable.plan_ids,
        group: currentRuntimeDispatchGroup(nextRuntimeContext),
        ready_dispatches: nextRuntimeContext.ready_dispatches,
        active_dispatches: nextRuntimeContext.active_dispatches,
        failed_dispatches: nextRuntimeContext.failed_dispatches,
      };
    }
  }

  if (
    state.planning &&
    typeof state.planning === 'object' &&
    planningPlan?.status === 'complete' &&
    state.planning.status !== 'complete'
  ) {
    state.planning = {
      ...state.planning,
      status: 'complete',
      completed_at: nowIso(),
    };
    orchestration.stage = 'execution';
  }

  const planningExecutedThisCycle = executedPlans.some((entry) => entry.plan_id === `${project}-plan`);
  if (
    planningExecutedThisCycle
    && !failTriggered
    && !runtimeDispatchPending
    && nextRunnableContract
    && inferPlanStage(project, nextRunnableContract.plan) !== 'planning'
  ) {
    applyFreshSessionImplementationGate(state);
  }

  orchestration.active_role = null;
  setLifecycleStopReason(state, null);
  if (allComplete) {
    state.lifecycle.status = 'complete';
    setLifecycleNextStep(state, 'Scope complete.');
    orchestration.next_role = null;
  } else if (runtimeDispatchPending && isFreshSessionImplementationPauseReason(state.workflow.pause_reason)) {
    enterAwaitingFreshSession(state, project, readyWorkflowPlans, runtimeDispatchPending);
    orchestration.next_role = null;
  } else if (runtimeDispatchPending) {
    applyRuntimeDispatchPendingLifecycle(project, state, runtimeDispatchPending);
    orchestration.next_role = null;
  } else if (failTriggered) {
    if (state.current_plan?.plan_id === `${project}-plan`) {
      const planningAnalysis = loadPlanningAnalysis(paths);
      state.lifecycle.status = 'planning_blocked';
      setLifecycleNextStep(state, buildPlanningBlockedNextAction(project, paths, planningAnalysis), buildRecheckCommand(project));
      orchestration.next_role = null;
      if (state.planning && typeof state.planning === 'object') {
        state.planning = {
          ...state.planning,
          status: 'blocked',
        };
      }
    } else {
      state.lifecycle.status = 'failed';
      orchestration.next_role = 'fixer';
      setLifecycleNextStep(
        state,
        `Fix findings in .smike/${project}/VERDICT.md and .smike/${project}/REVIEW.md for ${state.current_plan?.plan_id || 'current plan'} using ${orchestration.capsules.latest_by_role?.fixer || `.smike/${project}/capsules/`}, then rerun \`${buildCycleCommand(project)}\`.`,
        buildCycleCommand(project),
      );
    }
  } else if (nextRunnablePending && !state.workflow.auto_continue) {
    if (isFreshSessionImplementationPauseReason(state.workflow.pause_reason)) {
      enterAwaitingFreshSession(state, project, readyWorkflowPlans);
    } else {
      state.lifecycle.status = 'in_progress';
      const pauseReason = typeof state.workflow.pause_reason === 'string' && state.workflow.pause_reason.trim()
        ? `Auto-continue paused: ${state.workflow.pause_reason.trim()}. `
        : 'Auto-continue disabled. ';
      setLifecycleNextStep(state, `${pauseReason}${describeReadyWorkflowPlans(readyWorkflowPlans)}`, buildCycleCommand(project));
    }
    orchestration.next_role = 'executor';
  } else if (nextRunnablePending && executedPlans.length >= state.workflow.max_phases_per_run) {
    state.lifecycle.status = 'in_progress';
    setLifecycleNextStep(
      state,
      `Reached max phases per run (${state.workflow.max_phases_per_run}). ${describeReadyWorkflowPlans(readyWorkflowPlans)}`,
      buildCycleCommand(project),
    );
    orchestration.next_role = 'executor';
  } else if (nextRunnablePending) {
    state.lifecycle.status = 'in_progress';
    setLifecycleNextStep(state, describeReadyWorkflowPlans(readyWorkflowPlans), buildCycleCommand(project));
    orchestration.next_role = 'executor';
  } else if (dependencyBlockers.length > 0) {
    state.lifecycle.status = 'blocked';
    setLifecycleNextStep(
      state,
      `Unblock dependency blockers: ${describeDependencyBlockers(dependencyBlockers)}.`,
      buildCycleCommand(project),
    );
    orchestration.next_role = null;
  } else {
    state.lifecycle.status = 'in_progress';
    setLifecycleNextStep(state, 'No pending plan was executed.', buildCycleCommand(project));
    orchestration.next_role = null;
  }

  if (nextRunnableContract) {
    orchestration.stage = inferPlanStage(project, nextRunnableContract.plan);
  }

  state.updated_at = nowIso();
  if (state.history.length > 50) {
    state.history = state.history.slice(-50);
  }
  syncActionableRuntimeDispatchState(project, paths, state, rootPlan);

  const reportMarkdown = buildExecReport(project, rootPlan, executedPlans, state);
  fs.writeFileSync(paths.execReportPath, reportMarkdown, 'utf8');
  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.stateMdPath, renderStateMarkdown(project, rootPlan.spec || state?.planning?.spec_path || project, state), 'utf8');
  generateDerivedArtifacts(project, paths, state, rootPlan);

  const overallResult = failTriggered ? 'FAIL' : allComplete ? 'PASS' : 'PARTIAL';
  console.log(`smike cycle ${project}: ${overallResult} (${executedPlans.length} plan${executedPlans.length === 1 ? '' : 's'} executed)`);
  if (failTriggered) {
    const latestFailures = executedPlans[executedPlans.length - 1]?.failures || [];
    if (latestFailures.length > 0) {
      console.log(`failing checks: ${latestFailures.join(', ')}`);
    }
    process.exit(1);
  }
  } finally {
    releaseProjectLock();
  }
}

function runValidate(project) {
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.planJsonPath)) {
    fail(`missing PLAN.json: ${paths.planJsonPath}`);
  }
  const rootPlan = readJson(paths.planJsonPath);
  const errors = validatePlan(rootPlan);
  if (errors.length > 0) {
    fail(`PLAN.json validation failed:\n- ${errors.join('\n- ')}`);
  }
  if (rootPlan.profile !== 'codex') {
    fail(`profile is ${rootPlan.profile}; codex runner validates codex profile only`);
  }

  const workflowSettings = resolveWorkflowSettings(rootPlan, {});
  const contracts = buildWorkflowContracts(paths, rootPlan, workflowSettings);
  console.log(`PLAN.json valid for codex profile: ${paths.planJsonPath}`);
  if (contracts.length > 1) {
    console.log(`workflow phase plans validated: ${contracts.length - 1}`);
  }
}

function runGenerate(project) {
  const releaseProjectLock = acquireProjectLock(project, 'generate');
  try {
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.planJsonPath)) {
    fail(`missing PLAN.json: ${paths.planJsonPath}`);
  }
  if (!fs.existsSync(paths.statePath)) {
    fail(`missing STATE.json: ${paths.statePath}`);
  }
  const plan = readJson(paths.planJsonPath);
  const { state } = readValidatedState(paths, { persistRepair: true });
  if (plan.profile !== 'codex') {
    fail(`profile is ${plan.profile}; generation command is codex-only`);
  }
  const workflowSettings = resolveWorkflowSettings(plan, {});
  const contracts = buildWorkflowContracts(paths, plan, workflowSettings);
  syncWorkflowState(state, contracts, workflowSettings);
  ensureOrchestrationState(state);
  ensureDiscoveryLog(state);
  syncActionableRuntimeDispatchState(project, paths, state, plan);
  state.updated_at = nowIso();
  writeJson(paths.statePath, state);
  fs.writeFileSync(paths.stateMdPath, renderStateMarkdown(project, plan.spec || state?.planning?.spec_path || project, state), 'utf8');
  generateDerivedArtifacts(project, paths, state, plan);
  console.log(`derived artifacts regenerated for ${project}`);
  } finally {
    releaseProjectLock();
  }
}

function persistProjectState(project, paths, state, rootPlan, specRel = null) {
  generateDerivedArtifacts(project, paths, state, rootPlan);
  writeJson(paths.statePath, state);
  fs.writeFileSync(
    paths.stateMdPath,
    renderStateMarkdown(project, specRel || rootPlan.spec || state?.planning?.spec_path || project, state),
    'utf8',
  );
}

function completeRuntimeDispatchEntry(project, paths, state, rootPlan, entry) {
  const dispatchId = entry.dispatch_id;
  const at = nowIso();
  if (entry.status !== 'spawned') {
    fail(`dispatch ${dispatchId} must be marked spawned before it can be completed`);
  }

  const snapshots = snapshotArtifactList(entry.result_artifacts);
  const completionRequirements = normalizeDispatchCompletionRequirements(
    entry.completion_requirements,
    entry.result_artifacts,
    entry.artifact_change_required,
  );
  const missingArtifact = snapshots.find((artifact) => !artifact.exists);
  if (missingArtifact) {
    entry.freshness = createDispatchFreshness('missing', `Missing result artifact: ${missingArtifact.path}`, at);
    updateRuntimeDispatchStatus(entry, 'failed', `Missing result artifact: ${missingArtifact.path}`, at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    applyRuntimeDispatchPendingLifecycle(project, state, buildRuntimeDispatchPendingState(nextRuntimeContext));
    persistProjectState(project, paths, state, rootPlan);
    fail(`dispatch ${dispatchId} cannot be completed: missing result artifact ${missingArtifact.path}`);
  }

  const semanticFailures = collectCompletionRequirementFailures(
    completionRequirements,
    snapshots,
    (artifactPath) => fs.readFileSync(path.resolve(REPO_ROOT, artifactPath), 'utf8'),
  );
  if (semanticFailures.length > 0) {
    const failureReason = semanticFailures[0];
    entry.freshness = createDispatchFreshness('stale', failureReason, at);
    updateRuntimeDispatchStatus(entry, 'failed', failureReason, at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    applyRuntimeDispatchPendingLifecycle(project, state, buildRuntimeDispatchPendingState(nextRuntimeContext));
    persistProjectState(project, paths, state, rootPlan);
    fail(`dispatch ${dispatchId} cannot be completed:\n- ${semanticFailures.join('\n- ')}`);
  }

  if (entry.artifact_change_required && artifactSnapshotEquivalent(entry.spawn_baseline, snapshots)) {
    entry.freshness = createDispatchFreshness(
      'unchanged',
      'Result artifacts did not change after the dispatch was spawned.',
      at,
    );
    updateRuntimeDispatchStatus(entry, 'failed', 'Result artifacts did not change after spawn.', at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    applyRuntimeDispatchPendingLifecycle(project, state, buildRuntimeDispatchPendingState(nextRuntimeContext));
    persistProjectState(project, paths, state, rootPlan);
    fail(`dispatch ${dispatchId} cannot be completed: result artifacts are unchanged from the spawn baseline`);
  }

  entry.completion_artifacts = snapshots;
  entry.freshness = buildDispatchFreshnessFromCompletion(entry);
  updateRuntimeDispatchStatus(entry, 'completed', 'Runtime dispatch completed and artifacts were verified.', at);
  const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  if (!applyRuntimeDispatchPendingLifecycle(
    project,
    state,
    buildRuntimeDispatchPendingState(nextRuntimeContext),
    { readyLifecycle: 'in_progress' },
  )) {
    state.lifecycle.status = 'in_progress';
    setLifecycleStopReason(state, null);
    setLifecycleNextStep(
      state,
      `Runtime dispatch ${dispatchId} completed. Rerun \`${buildAdvanceCommand(project)}\` to reconcile the next action.`,
      buildAdvanceCommand(project),
    );
  }
  persistProjectState(project, paths, state, rootPlan);
}

function runDispatchGroup(project, action, groupSelector, options = {}) {
  const releaseProjectLock = acquireProjectLock(project, 'dispatch');
  try {
    const paths = getProjectPaths(project);
    if (!fs.existsSync(paths.planJsonPath)) {
      fail(`missing PLAN.json: ${paths.planJsonPath}`);
    }
    if (!fs.existsSync(paths.statePath)) {
      fail(`missing STATE.json: ${paths.statePath}`);
    }

    const rootPlan = readJson(paths.planJsonPath);
    const { state } = readValidatedState(paths, { persistRepair: true });

    ensureOrchestrationState(state);
    ensureDiscoveryLog(state);
    const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    if (
      runtimeContext.delegation.mode !== 'runtime_subagents' ||
      runtimeContext.delegation.owner !== 'runtime_orchestrator'
    ) {
      fail(`current actionable plan for ${project} is not runtime-owned delegation`);
    }

    if (action !== 'complete-group') {
      fail(`unknown dispatch group action: ${action}`);
    }

    const normalizedSelector = typeof groupSelector === 'string' && groupSelector.trim()
      ? groupSelector.trim().toLowerCase()
      : 'current';
    const targetGroup = normalizedSelector === 'current'
      ? currentRuntimeDispatchGroup(runtimeContext)
      : Number.parseInt(normalizedSelector, 10);
    if (!Number.isInteger(targetGroup) || targetGroup < 1) {
      fail(`invalid dispatch group selector: ${groupSelector}`);
    }

    const entries = runtimeContext.dispatches
      .filter((entry) => entry.group === targetGroup && entry.status === 'spawned')
      .sort((a, b) => a.dispatch_id.localeCompare(b.dispatch_id));
    if (entries.length === 0) {
      fail(`no spawned dispatches found in group ${targetGroup} for ${project}`);
    }

    for (const entry of entries) {
      completeRuntimeDispatchEntry(project, paths, state, rootPlan, entry);
      console.log(`smike dispatch ${project}: ${entry.dispatch_id} -> completed`);
    }
    console.log(`smike dispatch ${project}: group ${targetGroup} -> completed (${entries.length} dispatches)`);
    printDispatchFollowOn(project, state);
  } finally {
    releaseProjectLock();
  }
}

function runDispatch(project, action, dispatchId, options = {}) {
  const releaseProjectLock = acquireProjectLock(project, 'dispatch');
  try {
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.planJsonPath)) {
    fail(`missing PLAN.json: ${paths.planJsonPath}`);
  }
  if (!fs.existsSync(paths.statePath)) {
    fail(`missing STATE.json: ${paths.statePath}`);
  }

  const rootPlan = readJson(paths.planJsonPath);
  const { state } = readValidatedState(paths, { persistRepair: true });

  ensureOrchestrationState(state);
  ensureDiscoveryLog(state);
  const runtimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
  if (
    runtimeContext.delegation.mode !== 'runtime_subagents' ||
    runtimeContext.delegation.owner !== 'runtime_orchestrator'
  ) {
    fail(`current actionable plan for ${project} is not runtime-owned delegation`);
  }

  const dispatchPlanFilter =
    Array.isArray(runtimeContext.actionable.plan_ids) && runtimeContext.actionable.plan_ids.length > 0
      ? runtimeContext.actionable.plan_ids
      : runtimeContext.actionable.plan_id;
  const entry = getCurrentRuntimeDispatchEntries(state, dispatchPlanFilter)
    .find((dispatch) => dispatch.dispatch_id === dispatchId);
  if (!entry) {
    fail(`unknown current dispatch: ${dispatchId}`);
  }

  const at = nowIso();
  if (action === 'spawned') {
    if (entry.status !== 'queued' && entry.status !== 'stale') {
      fail(`dispatch ${dispatchId} must be queued or stale before marking it spawned`);
    }
    entry.spawn_baseline = snapshotArtifactList(entry.result_artifacts);
    entry.freshness = createDispatchFreshness('pending', 'Runtime dispatch is in flight.', at);
    updateRuntimeDispatchStatus(entry, 'spawned', 'Runtime dispatch claimed by the orchestrator.', at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    applyRuntimeDispatchPendingLifecycle(project, state, buildRuntimeDispatchPendingState(nextRuntimeContext));
    persistProjectState(project, paths, state, rootPlan);
    console.log(`smike dispatch ${project}: ${dispatchId} -> spawned`);
    printDispatchFollowOn(project, state);
    return;
  }

  if (action === 'completed') {
    completeRuntimeDispatchEntry(project, paths, state, rootPlan, entry);
    console.log(`smike dispatch ${project}: ${dispatchId} -> completed`);
    printDispatchFollowOn(project, state);
    return;
  }

  if (action === 'failed') {
    const reason = typeof options.reason === 'string' && options.reason.trim()
      ? options.reason.trim()
      : 'Runtime dispatch failed.';
    entry.freshness = createDispatchFreshness('stale', reason, at);
    updateRuntimeDispatchStatus(entry, 'failed', reason, at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    if (!applyRuntimeDispatchPendingLifecycle(project, state, buildRuntimeDispatchPendingState(nextRuntimeContext))) {
      state.lifecycle.status = 'in_progress';
      setLifecycleStopReason(state, null);
      setLifecycleNextStep(
        state,
        `Runtime dispatch ${dispatchId} failed. Retry it with \`${buildRetryDispatchCommand(project, dispatchId)}\`, then rerun \`${buildCycleCommand(project)}\`.`,
        buildRetryDispatchCommand(project, dispatchId),
      );
    }
    persistProjectState(project, paths, state, rootPlan);
    console.log(`smike dispatch ${project}: ${dispatchId} -> failed`);
    printDispatchFollowOn(project, state);
    return;
  }

  if (action === 'retry') {
    if (entry.status !== 'failed' && entry.status !== 'stale') {
      fail(`dispatch ${dispatchId} must be failed or stale before it can be retried`);
    }
    entry.spawn_baseline = [];
    entry.completion_artifacts = [];
    entry.freshness = createDispatchFreshness('pending', 'Dispatch requeued for retry.', at);
    updateRuntimeDispatchStatus(entry, 'queued', 'Dispatch requeued for retry.', at);
    const nextRuntimeContext = syncActionableRuntimeDispatchState(project, paths, state, rootPlan);
    applyRuntimeDispatchPendingLifecycle(
      project,
      state,
      buildRuntimeDispatchPendingState(nextRuntimeContext),
      { readyLifecycle: 'in_progress' },
    );
    persistProjectState(project, paths, state, rootPlan);
    console.log(`smike dispatch ${project}: ${dispatchId} -> queued`);
    printDispatchFollowOn(project, state);
    return;
  }

  fail(`unknown dispatch action: ${action}`);
  } finally {
    releaseProjectLock();
  }
}

function runArchive(projectSelector, options = {}) {
  const project = resolveProjectSelector(projectSelector) || projectSelector;
  const paths = getProjectPaths(project);
  if (!fs.existsSync(paths.projectDir)) {
    fail(`project directory not found: ${paths.projectDir}`);
  }

  const releaseProjectLock = acquireProjectLock(project, 'archive');
  try {
    if (!fs.existsSync(paths.planJsonPath)) {
      fail(`missing canonical plan contract: ${paths.planJsonPath}`);
    }
    if (!fs.existsSync(paths.statePath)) {
      fail(`missing canonical state contract: ${paths.statePath}`);
    }

    const rootPlan = readJson(paths.planJsonPath);
    const { state } = readValidatedState(paths, { persistRepair: true });
    const projectMeta = fs.existsSync(paths.projectMetaPath) ? readJson(paths.projectMetaPath) : {};
    const lifecycleStatus = state?.lifecycle?.status || null;
    const terminalStatuses = new Set(['complete', 'failed', 'blocked', 'planning_blocked']);

    if (!options.force && !terminalStatuses.has(lifecycleStatus)) {
      fail(`refusing to archive nonterminal project ${project} with status ${lifecycleStatus || 'unknown'}; use --force to override`);
    }

    const archiveMode = options.mode === 'full' ? 'full' : 'compact';
    const archivePaths = getArchivePaths(project);
    if (fs.existsSync(archivePaths.archiveDir)) {
      fail(`archive destination already exists: ${archivePaths.archiveDir}`);
    }

    try {
      ensureDir(archivePaths.archiveDir);
      const copiedRuntimeFiles = copyProjectRuntimeForArchive(project, state, archivePaths, archiveMode);
      const inputSnapshot = snapshotArchiveInputs(
        projectMeta?.spec_path || rootPlan?.spec || state?.planning?.spec_path || null,
        projectMeta?.context_files || [],
        archivePaths,
      );
      const manifest = buildArchiveManifest(project, archiveMode, state, rootPlan, projectMeta, copiedRuntimeFiles, inputSnapshot);
      writeJson(archivePaths.manifestPath, manifest);
    } catch (error) {
      fs.rmSync(archivePaths.archiveDir, { recursive: true, force: true });
      throw error;
    }

    const clearedActive = clearActiveProject(project);
    fs.rmSync(paths.projectDir, { recursive: true, force: true });

    console.log(`smike archive: ${project}`);
    console.log(`archive: .smike-archive/${project}`);
    console.log(`mode: ${archiveMode}`);
    if (clearedActive) {
      console.log('active: cleared');
    }
    const manifest = readJson(archivePaths.manifestPath);
    if (manifest.input_snapshot?.missing?.length > 0) {
      console.log(`missing_inputs: ${manifest.input_snapshot.missing.join(', ')}`);
    }
  } finally {
    releaseProjectLock();
  }
}

function runRestore(projectSelector) {
  const project = resolveArchiveSelector(projectSelector) || projectSelector;
  const archivePaths = getArchivePaths(project);
  const paths = getProjectPaths(project);

  if (!fs.existsSync(archivePaths.archiveDir)) {
    fail(`archive not found: ${archivePaths.archiveDir}`);
  }
  if (!fs.existsSync(archivePaths.runtimeDir)) {
    fail(`archive is missing runtime payload: ${archivePaths.runtimeDir}`);
  }
  if (fs.existsSync(paths.projectDir)) {
    fail(`project directory already exists: ${paths.projectDir}`);
  }

  ensureDir(SMIKE_ROOT);
  copyTreeFiles(archivePaths.runtimeDir, paths.projectDir);

  console.log(`smike restore: ${project}`);
  console.log(`project: .smike/${project}`);
  console.log(`resume: run \`./smike activate ${project}\` then \`./smike\``);
}

function runGc() {
  pruneStaleProjectLocks();
  const removedTmp = removeTempFiles(SMIKE_ROOT) + removeTempFiles(SMIKE_ARCHIVE_ROOT);
  const removedEmptyDirs = pruneEmptyDirs(SMIKE_ROOT) + pruneEmptyDirs(SMIKE_ARCHIVE_ROOT);

  console.log('smike gc: complete');
  console.log(`tmp_removed: ${removedTmp}`);
  console.log(`empty_dirs_removed: ${removedEmptyDirs}`);
}

async function main() {
  pruneStaleProjectLocks();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  if (args.length === 0) {
    await runEntrypoint();
    return;
  }

  const [command, project, ...rest] = args;
  if (!RESERVED_COMMANDS.has(command)) {
    if (args.length === 1) {
      const projectMatch = resolveProjectSelector(command);
      if (projectMatch) {
        await runProjectSelector(projectMatch);
        return;
      }
      const specShortcut = resolveSpecShortcut(command);
      if (specShortcut) {
        await runStart([specShortcut]);
        return;
      }
    }
    if (shouldRouteArgsToIntake(args)) {
      await runIntake(args);
      return;
    }
    await runStart(args);
    return;
  }

  if (command === 'cycle') {
    if (!project) {
      fail('project argument is required');
    }
    const cycleOptions = {
      noAutoContinue: rest.includes('--no-auto-continue'),
      maxPhases: null,
    };
    for (const flag of rest) {
      if (flag.startsWith('--max-phases=')) {
        const raw = flag.slice('--max-phases='.length);
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed < 1) {
          fail(`invalid --max-phases value: ${raw}`);
        }
        cycleOptions.maxPhases = parsed;
      } else if (flag !== '--no-auto-continue') {
        fail(`unknown cycle flag: ${flag}`);
      }
    }
    await runCycle(project, cycleOptions);
    return;
  }
  if (command === 'intake') {
    await runIntake(args.slice(1));
    return;
  }
  if (command === 'recheck') {
    if (!project) {
      fail('project argument is required');
    }
    if (rest.length > 0) {
      fail(`recheck does not accept extra arguments: ${rest.join(' ')}`);
    }
    await runRecheck(project);
    return;
  }
  if (command === 'doctor') {
    if (rest.length > 0) {
      fail(`doctor does not accept extra arguments: ${rest.join(' ')}`);
    }
    runDoctor(project || null);
    return;
  }
  if (command === 'advance') {
    if (rest.length > 0) {
      fail(`advance does not accept extra arguments: ${rest.join(' ')}`);
    }
    await runAdvance(project || null);
    return;
  }
  if (command === 'dispatch') {
    const action = rest[0];
    const dispatchId = rest[1];
    if (!project) {
      fail('project argument is required');
    }
    if (!action) {
      fail('dispatch action is required');
    }
    if (!dispatchId) {
      fail('dispatch-id is required');
    }
    const options = {
      reason: null,
    };
    for (const flag of rest.slice(2)) {
      if (flag.startsWith('--reason=')) {
        options.reason = flag.slice('--reason='.length);
      } else {
        fail(`unknown dispatch flag: ${flag}`);
      }
    }
    if (action === 'complete-group') {
      runDispatchGroup(project, action, dispatchId, options);
      return;
    }
    runDispatch(project, action, dispatchId, options);
    return;
  }
  if (command === 'archive') {
    if (!project) {
      fail('project argument is required');
    }
    const options = {
      mode: 'compact',
      force: false,
    };
    for (const flag of rest) {
      if (flag === '--force') {
        options.force = true;
      } else if (flag.startsWith('--mode=')) {
        const mode = flag.slice('--mode='.length);
        if (mode !== 'compact' && mode !== 'full') {
          fail(`unknown archive mode: ${mode}`);
        }
        options.mode = mode;
      } else {
        fail(`unknown archive flag: ${flag}`);
      }
    }
    runArchive(project, options);
    return;
  }
  if (command === 'restore') {
    if (!project) {
      fail('project argument is required');
    }
    if (rest.length > 0) {
      fail(`restore does not accept extra arguments: ${rest.join(' ')}`);
    }
    runRestore(project);
    return;
  }
  if (command === 'gc') {
    if (args.length > 1) {
      fail(`gc does not accept extra arguments: ${args.slice(1).join(' ')}`);
    }
    runGc();
    return;
  }
  if (command === 'validate') {
    if (!project) {
      fail('project argument is required');
    }
    runValidate(project);
    return;
  }
  if (command === 'generate') {
    if (!project) {
      fail('project argument is required');
    }
    runGenerate(project);
    return;
  }
  if (command === 'activate') {
    if (!project) {
      fail('project argument is required');
    }
    if (rest.length > 0) {
      fail(`activate does not accept extra arguments: ${rest.join(' ')}`);
    }
    runActivate(project);
    return;
  }
  if (command === 'resume') {
    if (rest.length > 0) {
      fail(`resume does not accept extra arguments: ${rest.join(' ')}`);
    }
    await runResume(project || null);
    return;
  }
  if (command === 'status') {
    if (rest.length > 0) {
      fail(`status does not accept extra arguments: ${rest.join(' ')}`);
    }
    runStatus(project || null);
    return;
  }
  if (command === 'list') {
    if (args.length > 1) {
      fail(`list does not accept extra arguments: ${args.slice(1).join(' ')}`);
    }
    runList();
    return;
  }

  fail(`unknown command: ${command}`);
}

main()
  .then(() => {
    process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
