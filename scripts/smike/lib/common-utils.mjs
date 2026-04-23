export function normalizeRel(p) {
  return String(p || '').replaceAll('\\\\', '/').replace(/^\.\//, '').trim();
}

export function compactCapsuleValue(value) {
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

export function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function uniqueStrings(values) {
  return [...new Set(ensureArray(values).map((value) => String(value)))];
}

export function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeStringArray(values) {
  return uniqueStrings(
    ensureArray(values)
      .map((value) => String(value).trim())
      .filter(Boolean),
  );
}

export function safeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

export function sortStrings(values) {
  return [...normalizeStringArray(values)].sort((left, right) => left.localeCompare(right));
}

export function sortByKey(values, buildKey) {
  return [...ensureArray(values)].sort((left, right) => buildKey(left).localeCompare(buildKey(right)));
}

export function sortObjectKeys(value) {
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

export function escapeRegex(input) {
  return String(input || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globToRegex(glob) {
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

export function matchesAnyGlob(filePath, globs) {
  const normalized = normalizeRel(filePath);
  return ensureArray(globs).some((glob) => globToRegex(glob).test(normalized));
}
