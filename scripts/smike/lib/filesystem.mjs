import fs from 'node:fs';
import path from 'node:path';

export function createFileHelpers({ fail } = {}) {
  const reportInvalidJson = typeof fail === 'function'
    ? fail
    : (message) => {
      throw new Error(message);
    };

  function readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      return reportInvalidJson(`invalid JSON at ${filePath}: ${error.message}`);
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

  return {
    ensureDir,
    isPathInside,
    readJson,
    removeIfExists,
    writeJson,
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function isPathInside(rootPath, candidatePath) {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function removeIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}
