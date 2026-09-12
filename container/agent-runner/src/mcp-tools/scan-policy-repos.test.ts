/**
 * Loader tests for scan-policy-repos.ts (#682 round 2 blocking fix).
 *
 * git-worktrees.test.ts covers the CALLER side — isScanPolicyRepositoryName's
 * fail-closed behavior and its one-time log, via
 * resetScanPolicyRepositoryNamesForTest. This file tests the loader itself:
 * what loadScanPolicyRepositoryNames returns for each malformed shape, and
 * that importing this module never throws regardless of what's on disk at
 * its data path — the whole point of making the read a lazy function call
 * instead of a module-scope `JSON.parse(fs.readFileSync(...))`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { loadScanPolicyRepositoryNames } from './scan-policy-repos.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SOURCE_TS = readFileSync(join(HERE, 'scan-policy-repos.ts'), 'utf8');

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-policy-repos-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('loadScanPolicyRepositoryNames', () => {
  const malformedShapes: Array<[string, string]> = [
    ['malformed JSON', '{ this is not valid json'],
    ['an empty array', '[]'],
    ['an object', '{"wiki":true}'],
    ['a bare string', '"wiki"'],
  ];

  test('returns null when the file is missing', () => {
    const dir = tempDir();
    const missingPath = join(dir, 'does-not-exist.json');
    expect(loadScanPolicyRepositoryNames(missingPath)).toBeNull();
  });

  for (const [label, content] of malformedShapes) {
    test(`returns null for ${label}`, () => {
      const dir = tempDir();
      const filePath = join(dir, 'scan-policy-repos.json');
      writeFileSync(filePath, content);
      expect(loadScanPolicyRepositoryNames(filePath)).toBeNull();
    });
  }

  test('returns exactly the parsed list for a valid non-empty array of strings', () => {
    const dir = tempDir();
    const filePath = join(dir, 'scan-policy-repos.json');
    writeFileSync(filePath, JSON.stringify(['wiki']));
    expect(loadScanPolicyRepositoryNames(filePath)).toEqual(['wiki']);
  });

  test('a multi-entry list round-trips exactly, in order', () => {
    const dir = tempDir();
    const filePath = join(dir, 'scan-policy-repos.json');
    writeFileSync(filePath, JSON.stringify(['wiki', 'another-scan-policy-repo']));
    expect(loadScanPolicyRepositoryNames(filePath)).toEqual(['wiki', 'another-scan-policy-repo']);
  });

  test('an array containing an empty-string entry is rejected, not silently accepted', () => {
    const dir = tempDir();
    const filePath = join(dir, 'scan-policy-repos.json');
    writeFileSync(filePath, JSON.stringify(['wiki', '']));
    expect(loadScanPolicyRepositoryNames(filePath)).toBeNull();
  });

  test('an array containing a non-string entry is rejected', () => {
    const dir = tempDir();
    const filePath = join(dir, 'scan-policy-repos.json');
    writeFileSync(filePath, JSON.stringify(['wiki', 1]));
    expect(loadScanPolicyRepositoryNames(filePath)).toBeNull();
  });

  test('the real committed scan-policy-repos.json loads via the default path', () => {
    // No dataPath argument — exercises the DATA_PATH default, i.e. the exact
    // call production code makes (git-worktrees.ts never passes a path in
    // production; only tests override it via resetScanPolicyRepositoryNamesForTest).
    expect(loadScanPolicyRepositoryNames()).toEqual(['wiki']);
  });
});

describe('import safety: a bad data file must never throw at module load (#682 round 2 blocking fix)', () => {
  // Before this fix, scan-policy-repos.ts ran
  // `JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'))` at MODULE SCOPE, so a
  // missing or malformed scan-policy-repos.json threw during import — and
  // because this module is pulled in transitively by every MCP tool
  // (mcp-tools/index.ts -> git-worktrees.ts -> here), that took down the
  // whole nanoclaw MCP server for every tool, in every container, until
  // restart. These tests import a FRESH COPY of this module (never the real
  // committed scan-policy-repos.json — a temp-dir sibling instead) next to
  // each bad data file in turn, and assert the import itself resolves rather
  // than rejects. A cache-busting query string forces a genuinely fresh
  // module evaluation per scenario, in-process — confirmed against the
  // pre-fix source (`SCAN_POLICY_REPOSITORY_NAMES = JSON.parse(...)` at
  // module scope) that this same setup DOES reject for these exact inputs,
  // so a regression back to eager loading is caught, not vacuously green.
  let importCounter = 0;

  function freshImportOfCopyWithData(content: string | null): Promise<{
    loadScanPolicyRepositoryNames: (dataPath?: string) => readonly string[] | null;
  }> {
    const dir = tempDir();
    const modulePath = join(dir, 'scan-policy-repos.ts');
    writeFileSync(modulePath, REAL_SOURCE_TS);
    if (content !== null) writeFileSync(join(dir, 'scan-policy-repos.json'), content);
    importCounter += 1;
    return import(`${modulePath}?bust=${importCounter}`);
  }

  test('does not throw when the sibling JSON file is missing entirely', async () => {
    await expect(freshImportOfCopyWithData(null)).resolves.toHaveProperty(
      'loadScanPolicyRepositoryNames',
      expect.any(Function),
    );
  });

  test('does not throw when the sibling JSON file is malformed', async () => {
    await expect(freshImportOfCopyWithData('{ this is not valid json')).resolves.toHaveProperty(
      'loadScanPolicyRepositoryNames',
      expect.any(Function),
    );
  });

  test('does not throw when the sibling JSON file has an invalid shape, and the loader still returns null from it', async () => {
    const mod = await freshImportOfCopyWithData('[]');
    expect(mod.loadScanPolicyRepositoryNames()).toBeNull();
  });
});
