import { spawn, spawnSync } from 'node:child_process';

import { shellEscape as defaultShellEscape } from './common-utils.mjs';

export function readProcessMetadata(pid) {
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

export function looksLikeSmikeProcessCommand(command) {
  return /(?:^|[\s/])smike(?:[\s]|$)|scripts[\\/]+smike[\\/]+cli\.mjs/i.test(String(command || ''));
}

export function processExists(pid) {
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

function looksLikeShellProcessCommand(command) {
  return /(?:^|[\s/])(bash|zsh|sh|dash|ash|fish|nu)(?:[\s]|$)/i.test(String(command || ''));
}

function appendShellOutput(current, chunk, limit) {
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

export function createProcessHelpers({
  repoRoot,
  testRunnerEnvHints = [],
  smikeParentTestRunnerEnv = 'SMIKE_PARENT_TEST_RUNNER',
  smikeAllowNestedTestRunsEnv = 'SMIKE_ALLOW_NESTED_TEST_RUNS',
  smikeAllowTestActiveProjectEnv = 'SMIKE_ALLOW_TEST_ACTIVE_PROJECT',
  smikeNestedTestSkipStdout = 'smike-nested-test-run-skipped',
  defaultShellTimeoutMs = 10 * 60 * 1000,
  defaultShellOutputLimit = 16 * 1024 * 1024,
  managedChildReapGraceMs = 500,
  isTestLikeCommand = (command) => /\b(vitest|jest|mocha|ava|tap)\b/i.test(String(command || '')),
  shellEscape = defaultShellEscape,
} = {}) {
  const managedChildren = new Map();
  let managedChildCleanupHooksInstalled = false;

  function looksLikeTestRunnerCommand(command) {
    return isTestLikeCommand(command);
  }

  function resolveRuntimeOwnerPid(maxDepth = 4) {
    let pid = process.ppid;
    let depth = 0;

    while (Number.isInteger(pid) && pid > 0 && depth < maxDepth) {
      const metadata = readProcessMetadata(pid);
      if (!metadata) {
        return pid;
      }

      const command = metadata.command || '';
      if (!looksLikeShellProcessCommand(command) && !looksLikeSmikeProcessCommand(command)) {
        return pid;
      }

      pid = metadata.ppid;
      depth += 1;
    }

    return Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : process.pid;
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
    if (env[smikeParentTestRunnerEnv] === '1') {
      return true;
    }

    if (env[smikeAllowNestedTestRunsEnv] === '1') {
      return false;
    }

    if (testRunnerEnvHints.some((name) => typeof env[name] === 'string' && env[name].trim().length > 0)) {
      return true;
    }

    const lifecycle = `${env.npm_lifecycle_event || ''} ${env.npm_lifecycle_script || ''}`;
    return /\b(vitest|jest|mocha|ava|tap)\b/i.test(lifecycle) || parentProcessLooksLikeTestRunner();
  }

  function buildManagedCommandEnv(baseEnv = process.env) {
    const managedEnv = {
      ...baseEnv,
    };
    delete managedEnv[smikeAllowTestActiveProjectEnv];

    if (
      managedEnv[smikeAllowNestedTestRunsEnv] === '1'
      || managedEnv[smikeParentTestRunnerEnv] === '1'
      || !isParentTestRunnerContext(managedEnv)
    ) {
      return managedEnv;
    }

    return {
      ...managedEnv,
      [smikeParentTestRunnerEnv]: '1',
    };
  }

  function guardNestedTestCommand(command, options = {}) {
    const stdoutToken = typeof options.stdoutToken === 'string' && options.stdoutToken.trim().length > 0
      ? options.stdoutToken.trim()
      : smikeNestedTestSkipStdout;

    return `if [ "\${${smikeAllowNestedTestRunsEnv}:-}" = "1" ] || [ "\${${smikeParentTestRunnerEnv}:-0}" != "1" ]; then ( ${command} ); else printf '%s\\n' ${shellEscape(stdoutToken)}; fi`;
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

  async function reapManagedChild(info, options = {}) {
    const graceMs = typeof options.graceMs === 'number' ? options.graceMs : managedChildReapGraceMs;
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
    for (const info of managedChildren.values()) {
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
    const cwd = options.cwd || repoRoot;
    const timeoutMs = options.timeoutMs || defaultShellTimeoutMs;
    const start = Date.now();
    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: defaultShellOutputLimit,
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

    const cwd = options.cwd || repoRoot;
    const timeoutMs = options.timeoutMs || defaultShellTimeoutMs;
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
        managedChildren.set(child.pid, info);
      }

      const finalize = async (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        managedChildren.delete(info.pid);
        await reapManagedChild(info, { graceMs: managedChildReapGraceMs });

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
          stdout = appendShellOutput(stdout, chunk, defaultShellOutputLimit);
        });
      }
      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr = appendShellOutput(stderr, chunk, defaultShellOutputLimit);
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
          graceMs: managedChildReapGraceMs,
        });
      }, timeoutMs);
    });
  }

  return {
    buildManagedCommandEnv,
    cleanupManagedChildrenSync,
    guardNestedTestCommand,
    guardTestVerifyCommand,
    inferNestedTestGuardStdoutToken,
    isParentTestRunnerContext,
    parentProcessLooksLikeTestRunner,
    resolveRuntimeOwnerPid,
    runShell,
    runShellSync,
  };
}
