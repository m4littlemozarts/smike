import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { acquireCliTestLock, releaseCliTestLock } from './test-cli-lock.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, '..', '..');
export const tempSpecDir = path.join(repoRoot, '.smike-test-tmp');
export const repoConfigPath = path.join(repoRoot, 'smike.config.json');

export function installCliTestLocking(test) {
  let cliTestLock = null;

  test.beforeEach(() => {
    cliTestLock = acquireCliTestLock(repoRoot);
  });

  test.afterEach(() => {
    releaseCliTestLock(cliTestLock);
    cliTestLock = null;
  });
}

export function slugifyProjectName(input) {
  const base = path.basename(input, path.extname(input));
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'smike-project';
}

export function writeSpec(relativePath, markdown) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, markdown, 'utf8');
  return absolutePath;
}

export function runCli(args, extraEnv = {}) {
  return execFileSync('node', ['scripts/smike/cli.mjs', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SMIKE_PARENT_TEST_RUNNER: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

export function runCliExpectFailure(args, extraEnv = {}) {
  try {
    runCli(args, extraEnv);
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`;
  }
  assert.fail(`expected command to fail: ${args.join(' ')}`);
}

export function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

export function cleanupArchive(project) {
  fs.rmSync(path.join(repoRoot, '.smike-archive', project), { recursive: true, force: true });
}

export function cleanupProject(project, specRel) {
  const activePath = path.join(repoRoot, '.smike', 'ACTIVE.json');
  if (fs.existsSync(activePath)) {
    fs.rmSync(activePath, { force: true });
  }
  fs.rmSync(path.join(repoRoot, '.smike', project), { recursive: true, force: true });
  fs.rmSync(path.join(repoRoot, '.smike-snapshots', project), { recursive: true, force: true });
  cleanupArchive(project);
  if (specRel) {
    fs.rmSync(path.join(repoRoot, specRel), { force: true });
  }
}

export function appendStrategistArtifactChange(project, note) {
  const planPath = path.join(repoRoot, `.smike/${project}/PLAN.json`);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.notes = [...(plan.notes || []), note];
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

export function withRepoConfig(config, callback) {
  const hadConfig = fs.existsSync(repoConfigPath);
  const previousConfig = hadConfig ? fs.readFileSync(repoConfigPath, 'utf8') : null;

  try {
    fs.writeFileSync(repoConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return callback();
  } finally {
    if (hadConfig) {
      fs.writeFileSync(repoConfigPath, previousConfig, 'utf8');
    } else {
      fs.rmSync(repoConfigPath, { force: true });
    }
  }
}
