import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_GENERIC_VERIFY_COMMAND_IDS = new Set([
  'typecheck',
  'unit-tests',
  'doc-paths',
  'phase-ready',
  'research-artifacts',
]);

const KNOWN_VERIFY_FAMILIES = new Set(['javascript', 'bun', 'python', 'go', 'rust']);

const DEFAULT_PORTABILITY_PATTERN_SOURCES = {
  code_scope_path_patterns: [
    '^(packages|tests|scripts|src|app|apps|server|services|lib|pkg|cmd|internal|crates)(?:/|$)',
  ],
  source_path_patterns: [
    '\\.(?:[cm]?[jt]sx?|mjs|cjs|mts|cts|swift|py|sql|go|rs|rb|java|kt|kts|php|sh|bash|zsh|lua)$',
  ],
  interface_path_patterns: [
    '(^|/)(index|types)\\.[^/]+$',
    '\\.d\\.ts$',
    '(^|/)package\\.json$',
    '(^|/)(api|types)/',
    '(^|/)schema\\.sql$',
    '(^|/)__init__\\.py$',
    '\\.proto$',
    '(^|/)openapi[^/]*\\.(?:json|ya?ml)$',
    '(^|/)schema\\.prisma$',
  ],
  test_path_patterns: [
    '(^|/)(tests?|__tests__|spec|specs|e2e|integration)/',
    '(?:\\.test|\\.spec)\\.[^/]+$',
    '(^|/)test_[^/]+\\.py$',
    '(^|/)conftest\\.py$',
    '(^|/)[^/]+_test\\.go$',
  ],
  coverage_command_patterns: [
    '\\b(?:test|tests|testing|vitest|jest|mocha|ava|tap|tapjs|pytest|pyright|mypy|ruff|typecheck|tsc|build|compile)\\b',
    '\\bgo\\s+test\\b',
    '\\bgo\\s+vet\\b',
    '\\bcargo\\s+(?:test|check)\\b',
    '\\bbun\\s+test\\b',
    '\\bdeno\\s+test\\b',
    '\\bmvn(?:w)?\\s+test\\b',
    '\\bgradle(?:w)?\\s+test\\b',
    '\\buv\\s+run\\s+(?:pytest|pyright|mypy|ruff)\\b',
    '\\bpoetry\\s+run\\s+(?:pytest|pyright|mypy|ruff)\\b',
    '\\bpdm\\s+run\\s+(?:pytest|pyright|mypy|ruff)\\b',
    '\\bpipenv\\s+run\\s+(?:pytest|pyright|mypy|ruff)\\b',
  ],
  test_command_patterns: [
    '\\b(?:test|tests|testing|vitest|jest|mocha|ava|tap|tapjs|pytest)\\b',
    '\\bgo\\s+test\\b',
    '\\bcargo\\s+test\\b',
    '\\bbun\\s+test\\b',
    '\\bdeno\\s+test\\b',
    '\\bmvn(?:w)?\\s+test\\b',
    '\\bgradle(?:w)?\\s+test\\b',
    '\\buv\\s+run\\s+pytest\\b',
    '\\bpoetry\\s+run\\s+pytest\\b',
    '\\bpdm\\s+run\\s+pytest\\b',
    '\\bpipenv\\s+run\\s+pytest\\b',
  ],
  inspection_command_patterns: [
    '^\\s*(?:rg|grep|egrep|fgrep)\\b',
    '^\\s*sed\\b',
    '^\\s*cat\\b',
    '^\\s*(?:head|tail|awk|find|ls|stat|wc)\\b',
    '^\\s*(?:jq|yq)\\b',
    '^\\s*git\\s+(?:diff|show)\\b',
  ],
  trivial_command_patterns: [
    '^\\s*(?:printf|echo)\\b',
    '^\\s*true\\s*$',
    '^\\s*:\\s*$',
  ],
};

const KNOWN_OVERRIDE_FIELDS = new Set([
  ...Object.keys(DEFAULT_PORTABILITY_PATTERN_SOURCES),
  'default_verify_family',
]);

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return [...new Set(
    ensureArray(values)
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )];
}

function normalizeFilePath(filePath) {
  return String(filePath || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .trim();
}

function normalizeVerifyFamily(value, sourceLabel) {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!KNOWN_VERIFY_FAMILIES.has(normalized)) {
    throw new Error(`${sourceLabel} must be one of: ${[...KNOWN_VERIFY_FAMILIES].join(', ')}`);
  }
  return normalized;
}

function ensurePatternSourceList(values, fieldName, sourceLabel) {
  if (!Array.isArray(values)) {
    throw new Error(`${sourceLabel}.${fieldName} must be an array of regex strings`);
  }
  return values.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${sourceLabel}.${fieldName}[${index}] must be a non-empty regex string`);
    }
    return value.trim();
  });
}

function normalizePatternOverride(value, fieldName, sourceLabel) {
  if (value == null) {
    return {};
  }
  if (Array.isArray(value)) {
    return {
      extend: ensurePatternSourceList(value, fieldName, sourceLabel),
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${sourceLabel}.${fieldName} must be an array or an object with extend/replace arrays`);
  }

  const normalized = {};
  if ('extend' in value) {
    normalized.extend = ensurePatternSourceList(value.extend, `${fieldName}.extend`, sourceLabel);
  }
  if ('replace' in value) {
    normalized.replace = ensurePatternSourceList(value.replace, `${fieldName}.replace`, sourceLabel);
  }
  return normalized;
}

function normalizePortabilityOverrides(overrides, sourceLabel) {
  if (overrides == null) {
    return {};
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error(`${sourceLabel} must be an object`);
  }

  const normalized = {};
  for (const [fieldName, value] of Object.entries(overrides)) {
    if (!KNOWN_OVERRIDE_FIELDS.has(fieldName)) {
      throw new Error(`${sourceLabel}.${fieldName} is not a supported portability heuristic override`);
    }
    if (fieldName === 'default_verify_family') {
      normalized[fieldName] = normalizeVerifyFamily(value, `${sourceLabel}.${fieldName}`);
      continue;
    }
    normalized[fieldName] = normalizePatternOverride(value, fieldName, sourceLabel);
  }
  return normalized;
}

function buildPatterns(defaultSources, override = {}) {
  const sources = override.replace ? override.replace : [...defaultSources, ...ensureArray(override.extend)];
  return sources.map((source) => new RegExp(source, 'i'));
}

function matchesAny(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function collectPlanPaths(plan) {
  return uniqueStrings([
    ...ensureArray(plan?.allowed_files),
    ...ensureArray(plan?.write_scope_allowed_files),
    ...ensureArray(plan?.write_scope?.allowed_files),
  ]).map((filePath) => normalizeFilePath(filePath));
}

function detectRepoMarkers({
  repoRoot,
  existsSync = fs.existsSync,
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    return {
      hasPackageJson: false,
      hasBunLock: false,
      hasPyproject: false,
      hasPyrightConfig: false,
      hasMypyConfig: false,
      hasRuffConfig: false,
      hasGoMod: false,
      hasCargoToml: false,
    };
  }

  const marker = (relativePath) => existsSync(path.join(repoRoot, relativePath));
  return {
    hasPackageJson: marker('package.json'),
    hasBunLock: marker('bun.lock') || marker('bun.lockb'),
    hasPyproject: marker('pyproject.toml') || marker('pytest.ini') || marker('setup.py') || marker('requirements.txt'),
    hasPyrightConfig: marker('pyrightconfig.json'),
    hasMypyConfig: marker('mypy.ini') || marker('.mypy.ini'),
    hasRuffConfig: marker('ruff.toml') || marker('.ruff.toml'),
    hasGoMod: marker('go.mod'),
    hasCargoToml: marker('Cargo.toml'),
  };
}

function summarizePathHints(paths) {
  return {
    hasRustPath: paths.some((filePath) => /(^|\/)crates\//i.test(filePath) || /\.rs$/i.test(filePath)),
    hasGoPath: paths.some((filePath) => /(^|\/)(cmd|internal|pkg)\//i.test(filePath) || /\.go$/i.test(filePath)),
    hasPythonPath: paths.some((filePath) => /\.py$/i.test(filePath)),
    hasJavaScriptPath: paths.some((filePath) => /\.(?:[cm]?[jt]sx?|mjs|cjs|mts|cts)$/i.test(filePath)),
    hasBunPath: paths.some((filePath) => /(^|\/)(app|apps|packages|src|tests?)\//i.test(filePath)),
  };
}

export function createPortabilityHeuristics(overrides = {}) {
  const normalizedOverrides = normalizePortabilityOverrides(overrides, 'portability_heuristics');
  const codeScopePathPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.code_scope_path_patterns,
    normalizedOverrides.code_scope_path_patterns,
  );
  const sourcePathPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.source_path_patterns,
    normalizedOverrides.source_path_patterns,
  );
  const interfacePathPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.interface_path_patterns,
    normalizedOverrides.interface_path_patterns,
  );
  const testPathPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.test_path_patterns,
    normalizedOverrides.test_path_patterns,
  );
  const coverageCommandPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.coverage_command_patterns,
    normalizedOverrides.coverage_command_patterns,
  );
  const testCommandPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.test_command_patterns,
    normalizedOverrides.test_command_patterns,
  );
  const inspectionCommandPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.inspection_command_patterns,
    normalizedOverrides.inspection_command_patterns,
  );
  const trivialCommandPatterns = buildPatterns(
    DEFAULT_PORTABILITY_PATTERN_SOURCES.trivial_command_patterns,
    normalizedOverrides.trivial_command_patterns,
  );
  const defaultVerifyFamily = normalizedOverrides.default_verify_family || null;

  function isLikelyCodeScopePath(filePath) {
    const normalized = normalizeFilePath(filePath);
    if (!normalized || normalized.startsWith('.smike/')) {
      return false;
    }
    return matchesAny(normalized, codeScopePathPatterns);
  }

  function isLikelyTestPath(filePath) {
    const normalized = normalizeFilePath(filePath);
    if (!normalized || normalized.startsWith('.smike/')) {
      return false;
    }
    return matchesAny(normalized, testPathPatterns);
  }

  function isLikelySourcePath(filePath) {
    const normalized = normalizeFilePath(filePath);
    if (!normalized || normalized.startsWith('.smike/') || isLikelyTestPath(normalized)) {
      return false;
    }
    return matchesAny(normalized, sourcePathPatterns);
  }

  function isLikelyInterfaceSurfacePath(filePath) {
    const normalized = normalizeFilePath(filePath);
    if (!normalized || normalized.startsWith('.smike/')) {
      return false;
    }
    return matchesAny(normalized, interfacePathPatterns);
  }

  function looksLikeVerificationCoverageCommand(command) {
    const haystack = `${command?.id || ''} ${command?.run || ''}`.trim();
    if (!haystack) {
      return false;
    }
    return matchesAny(haystack, coverageCommandPatterns);
  }

  function looksLikeTestVerificationCommand(command) {
    const haystack = `${command?.id || ''} ${command?.run || ''}`.trim();
    if (!haystack) {
      return false;
    }
    return matchesAny(haystack, testCommandPatterns);
  }

  function looksLikeInspectionOnlyCommand(command) {
    const haystack = `${command?.run || ''}`.trim();
    if (!haystack) {
      return false;
    }
    return matchesAny(haystack, inspectionCommandPatterns);
  }

  function looksLikeTrivialVerificationCommand(command) {
    const haystack = `${command?.run || ''}`.trim();
    if (!haystack) {
      return false;
    }
    return matchesAny(haystack, trivialCommandPatterns);
  }

  function looksLikeBehavioralVerificationCommand(command) {
    const haystack = `${command?.run || ''}`.trim();
    if (!haystack) {
      return false;
    }
    if (looksLikeVerificationCoverageCommand(command) || looksLikeTestVerificationCommand(command)) {
      return true;
    }
    if (looksLikeInspectionOnlyCommand(command) || looksLikeTrivialVerificationCommand(command)) {
      return false;
    }
    return true;
  }

  function planHasCodeScope(plan) {
    return collectPlanPaths(plan).some((filePath) => isLikelyCodeScopePath(filePath));
  }

  function inferDefaultVerifyFamily({
    repoRoot,
    plan,
    existsSync = fs.existsSync,
  } = {}) {
    if (defaultVerifyFamily) {
      return defaultVerifyFamily;
    }

    const paths = collectPlanPaths(plan);
    const pathHints = summarizePathHints(paths);
    const markers = detectRepoMarkers({ repoRoot, existsSync });

    if (pathHints.hasRustPath || markers.hasCargoToml) {
      return 'rust';
    }
    if (pathHints.hasGoPath || markers.hasGoMod) {
      return 'go';
    }
    if (pathHints.hasPythonPath || markers.hasPyproject) {
      return 'python';
    }
    if (markers.hasBunLock) {
      return 'bun';
    }
    if (pathHints.hasJavaScriptPath || pathHints.hasBunPath || markers.hasPackageJson) {
      return markers.hasBunLock ? 'bun' : 'javascript';
    }
    return null;
  }

  function inferDefaultRequiredTools({
    repoRoot,
    plan,
    existsSync = fs.existsSync,
  } = {}) {
    switch (inferDefaultVerifyFamily({ repoRoot, plan, existsSync })) {
      case 'python':
        return ['python', 'git'];
      case 'go':
        return ['go', 'git'];
      case 'rust':
        return ['cargo', 'git'];
      case 'bun':
        return ['bun', 'git'];
      case 'javascript':
        return ['node', 'npm', 'git'];
      default:
        return ['git'];
    }
  }

  function buildDefaultVerifyCommands({
    repoRoot,
    plan,
    includeTypecheck = true,
    includeTests = true,
    guardTestCommand = (command) => command,
    existsSync = fs.existsSync,
  } = {}) {
    const family = inferDefaultVerifyFamily({ repoRoot, plan, existsSync });
    const markers = detectRepoMarkers({ repoRoot, existsSync });
    const commands = [];

    switch (family) {
      case 'python':
        if (includeTypecheck) {
          if (markers.hasPyrightConfig) {
            commands.push({ id: 'typecheck', run: 'pyright' });
          } else if (markers.hasMypyConfig) {
            commands.push({ id: 'typecheck', run: 'mypy .' });
          } else if (markers.hasRuffConfig) {
            commands.push({ id: 'typecheck', run: 'ruff check .' });
          }
        }
        if (includeTests) {
          commands.push({ id: 'unit-tests', run: guardTestCommand('pytest -q') });
        }
        break;
      case 'go':
        if (includeTests || includeTypecheck) {
          commands.push({ id: 'unit-tests', run: guardTestCommand('go test ./...') });
        }
        break;
      case 'rust':
        if (includeTypecheck) {
          commands.push({ id: 'typecheck', run: 'cargo check --workspace' });
        }
        if (includeTests) {
          commands.push({ id: 'unit-tests', run: guardTestCommand('cargo test --workspace') });
        }
        break;
      case 'bun':
        if (includeTypecheck) {
          commands.push({ id: 'typecheck', run: 'bun x tsc --noEmit' });
        }
        if (includeTests) {
          commands.push({ id: 'unit-tests', run: guardTestCommand('bun test') });
        }
        break;
      case 'javascript':
        if (includeTypecheck) {
          commands.push({ id: 'typecheck', run: 'npm run typecheck' });
        }
        if (includeTests) {
          commands.push({ id: 'unit-tests', run: guardTestCommand('npm run test:unit') });
        }
        break;
      default:
        break;
    }

    return commands;
  }

  return {
    isLikelyCodeScopePath,
    isLikelySourcePath,
    isLikelyInterfaceSurfacePath,
    isLikelyTestPath,
    looksLikeVerificationCoverageCommand,
    looksLikeTestVerificationCommand,
    looksLikeInspectionOnlyCommand,
    looksLikeTrivialVerificationCommand,
    looksLikeBehavioralVerificationCommand,
    planHasCodeScope,
    inferDefaultVerifyFamily,
    inferDefaultRequiredTools,
    buildDefaultVerifyCommands,
  };
}

export function loadRepoPortabilityHeuristicsConfig({
  repoRoot,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
    return {};
  }

  const configPath = path.join(repoRoot, 'smike.config.json');
  if (!existsSync(configPath)) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`invalid smike.config.json: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('smike.config.json must contain a JSON object');
  }

  return normalizePortabilityOverrides(parsed.portability_heuristics, 'smike.config.json#portability_heuristics');
}
