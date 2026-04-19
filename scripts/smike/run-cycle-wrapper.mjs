#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SMIKE_PATH = path.join(REPO_ROOT, 'smike');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('smike: missing project argument. Usage: npm run smike:cycle -- <project>');
  process.exit(1);
}

if (!fs.existsSync(SMIKE_PATH)) {
  console.error(`smike: required in-repo executable is missing: ${SMIKE_PATH}`);
  process.exit(1);
}

try {
  fs.accessSync(SMIKE_PATH, fs.constants.X_OK);
} catch {
  console.error(`smike: ${SMIKE_PATH} exists but is not executable`);
  process.exit(1);
}

const result = spawnSync(SMIKE_PATH, ['cycle', ...args], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`smike: failed to execute cycle: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
