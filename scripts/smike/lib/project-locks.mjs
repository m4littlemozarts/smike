import fs from 'node:fs';
import path from 'node:path';

export function createProjectLockHelpers({
  smikeRoot,
  repoRoot,
  getProjectPaths,
  ensureDir,
  normalizeRel,
  fail,
  nowIso,
  cleanupManagedChildrenSync,
  processExists,
  readProcessMetadata,
  looksLikeSmikeProcessCommand,
} = {}) {
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
    if (!fs.existsSync(smikeRoot)) {
      return;
    }

    for (const entry of fs.readdirSync(smikeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const lockPath = path.join(smikeRoot, entry.name, '.lock');
      const inspection = inspectProjectLock(lockPath);
      if (inspection.stale) {
        clearProjectLock(lockPath);
      }
    }
  }

  function acquireProjectLock(project, commandName) {
    const paths = getProjectPaths(project);
    ensureDir(paths.projectDir);
    const lockPath = path.join(paths.projectDir, '.lock');
    const lockRel = normalizeRel(path.relative(repoRoot, lockPath));
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

  return {
    acquireProjectLock,
    inspectProjectLock,
    pruneStaleProjectLocks,
  };
}
