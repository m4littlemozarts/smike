import fs from 'node:fs';
import path from 'node:path';

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') {
      return true;
    }
    if (error?.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function removeStaleLock(lockPath) {
  let lockContents = '';
  try {
    lockContents = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true;
    }
    throw error;
  }

  const pid = Number.parseInt(lockContents.trim(), 10);
  if (pidIsAlive(pid)) {
    return false;
  }

  fs.rmSync(lockPath, { force: true });
  return true;
}

export function acquireCliTestLock(repoRoot, options = {}) {
  const {
    timeoutMs = 30_000,
    pollMs = 25,
  } = options;
  const lockDir = path.join(repoRoot, '.smike-test-tmp');
  const lockPath = path.join(lockDir, '.cli-test.lock');
  fs.mkdirSync(lockDir, { recursive: true });

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      if (removeStaleLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for CLI test lock: ${lockPath}`);
      }
      sleepMs(pollMs);
    }
  }
}

export function releaseCliTestLock(lock) {
  if (!lock) {
    return;
  }
  fs.closeSync(lock.fd);
  fs.rmSync(lock.lockPath, { force: true });
}
