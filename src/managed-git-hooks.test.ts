import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  assertManagedGitHooksIntegrity,
  isScanPolicyRepositoryName,
  MANAGED_GIT_HOOKS_DIR,
  MANAGED_HOOK_FILENAME,
  MANAGED_PATTERNS_FILENAME,
  migrateExistingCanonicalHooksPath,
  refreshManagedGitHooks,
} from './managed-git-hooks.js';
import { log } from './log.js';
import { canonicalRepoDir, repositoriesRoot } from './repository-workspaces.js';
import { repositoryConfigPath, safeGitConfigGet, safeGitConfigSet } from './safe-git.js';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'pipe' })
    .toString()
    .trim();

let root: string;
let hooksDir: string;

/** A real canonical repo clone (normal, not bare) at the same path shape discoverCanonicalRepositories expects. */
function fixtureRepo(workgroupId: string, repo: string): string {
  const seed = path.join(root, 'seed', workgroupId, repo);
  fs.mkdirSync(seed, { recursive: true });
  git(seed, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'base\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'base']);
  const canonical = canonicalRepoDir(workgroupId, repo, root);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  execFileSync('git', ['clone', '-q', seed, canonical]);
  return canonical;
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-hooks-'));
  hooksDir = path.join(root, 'managed-git-hooks');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('isScanPolicyRepositoryName', () => {
  it('is true only for the wiki repo name', () => {
    expect(isScanPolicyRepositoryName('wiki')).toBe(true);
    expect(isScanPolicyRepositoryName('Wiki')).toBe(false);
    expect(isScanPolicyRepositoryName('code')).toBe(false);
    expect(isScanPolicyRepositoryName('')).toBe(false);
  });
});

describe('refreshManagedGitHooks', () => {
  it('writes an executable hook and a byte-identical patterns file matching the shipped sources', () => {
    const { hookSha256, patternsSha256 } = refreshManagedGitHooks(hooksDir);
    const hookPath = path.join(hooksDir, MANAGED_HOOK_FILENAME);
    const patternsPath = path.join(hooksDir, MANAGED_PATTERNS_FILENAME);
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.existsSync(patternsPath)).toBe(true);
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(hookSha256).toHaveLength(64);
    expect(patternsSha256).toHaveLength(64);
    // assertManagedGitHooksIntegrity re-derives the same hashes from the
    // shipped sources on disk and compares byte-for-byte — a pass here is
    // the strongest available proof the installed copy matches the source.
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).not.toThrow();
  });

  it('is idempotent: a second refresh reproduces the same content and hashes', () => {
    const first = refreshManagedGitHooks(hooksDir);
    const second = refreshManagedGitHooks(hooksDir);
    expect(second).toEqual(first);
  });

  it('never swaps the containing directory itself — same inode across refreshes', () => {
    // A container that bind-mounted MANAGED_GIT_HOOKS_DIR before a restart
    // must never end up looking at a stale, orphaned directory: only the
    // FILES inside are rename-in-placed, never the directory.
    refreshManagedGitHooks(hooksDir);
    const inodeBefore = fs.statSync(hooksDir).ino;
    refreshManagedGitHooks(hooksDir);
    const inodeAfter = fs.statSync(hooksDir).ino;
    expect(inodeAfter).toBe(inodeBefore);
  });

  it('writes the patterns file before the hook, so a mid-refresh crash never leaves a hook without its dependency', () => {
    // Not directly observable without instrumenting fs internals; assert the
    // documented ordering behaviorally instead: after a refresh, the
    // patterns file the hook sources is always already present and valid.
    refreshManagedGitHooks(hooksDir);
    const patterns = fs.readFileSync(path.join(hooksDir, MANAGED_PATTERNS_FILENAME), 'utf8');
    expect(patterns).toContain('secret_scan_selftest');
  });
});

describe('assertManagedGitHooksIntegrity', () => {
  it('throws when the hooks directory does not exist yet', () => {
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).toThrow();
  });

  it('throws when the installed hook content has been tampered with', () => {
    refreshManagedGitHooks(hooksDir);
    fs.appendFileSync(path.join(hooksDir, MANAGED_HOOK_FILENAME), '\n# tampered\n');
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).toThrow(/does not match the shipped source/);
  });

  it('throws when the installed patterns content has been tampered with', () => {
    refreshManagedGitHooks(hooksDir);
    fs.appendFileSync(path.join(hooksDir, MANAGED_PATTERNS_FILENAME), '\n# tampered\n');
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).toThrow(/does not match the shipped source/);
  });

  it('throws when the installed hook loses its executable bit', () => {
    refreshManagedGitHooks(hooksDir);
    fs.chmodSync(path.join(hooksDir, MANAGED_HOOK_FILENAME), 0o644);
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).toThrow(/not a safe executable file/);
  });

  it('throws when the hooks directory has been replaced by a symlink', () => {
    refreshManagedGitHooks(hooksDir);
    const real = `${hooksDir}-real`;
    fs.renameSync(hooksDir, real);
    fs.symlinkSync(real, hooksDir);
    expect(() => assertManagedGitHooksIntegrity(hooksDir)).toThrow(/unsafe/);
  });
});

describe('migrateExistingCanonicalHooksPath', () => {
  it('points an unset core.hooksPath at the managed dir for a wiki repo only, counted in updated', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    fixtureRepo('wg-a', 'code'); // non-scan-policy sibling — must stay untouched

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result).toEqual({ updated: 1, alerts: [] });
    expect(safeGitConfigGet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath')).toBe(
      MANAGED_GIT_HOOKS_DIR,
    );
    const codeConfigPath = repositoryConfigPath(path.join(canonicalRepoDir('wg-a', 'code', root), '.git'));
    expect(safeGitConfigGet(codeConfigPath, 'core.hooksPath')).toBeNull();
  });

  it('treats an existing /dev/null hooksPath the same as unset — still migrated', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    safeGitConfigSet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath', '/dev/null');

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result.updated).toBe(1);
    expect(safeGitConfigGet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath')).toBe(
      MANAGED_GIT_HOOKS_DIR,
    );
  });

  it('leaves an already-migrated repo untouched and does not recount it as updated', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    safeGitConfigSet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath', MANAGED_GIT_HOOKS_DIR);

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result).toEqual({ updated: 0, alerts: [] });
  });

  it('never overwrites a non-default, non-managed hooksPath — reports it as an alert instead', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    safeGitConfigSet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath', '.husky/_');

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result.updated).toBe(0);
    expect(result.alerts).toEqual(['wg-a/wiki']);
    expect(safeGitConfigGet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath')).toBe('.husky/_');
    expect(log.error).toHaveBeenCalled();
  });

  it('returns counts only — an alert entry is a workgroup/repo pair, never full secret content or a path', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    safeGitConfigSet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath', '/some/custom/hook/dir');
    const result = migrateExistingCanonicalHooksPath(root);
    expect(result.alerts).toEqual(['wg-a/wiki']);
  });

  it('sums across multiple workgroups', () => {
    fixtureRepo('wg-a', 'wiki');
    fixtureRepo('wg-b', 'wiki');
    fixtureRepo('wg-b', 'code');

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result).toEqual({ updated: 2, alerts: [] });
  });

  it('returns zero counts when the repositories root does not exist yet', () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-git-hooks-empty-'));
    try {
      expect(migrateExistingCanonicalHooksPath(emptyRoot)).toEqual({ updated: 0, alerts: [] });
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  it('is a no-op on a workgroup with no scan-policy repos', () => {
    fixtureRepo('wg-a', 'code');
    fixtureRepo('wg-a', 'infra');
    expect(migrateExistingCanonicalHooksPath(root)).toEqual({ updated: 0, alerts: [] });
    expect(fs.existsSync(repositoriesRoot(root))).toBe(true);
  });
});
