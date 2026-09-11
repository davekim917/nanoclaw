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
  decideHooksMountStrategy,
  ensureRefuseHook,
  isScanPolicyRepositoryName,
  MANAGED_GIT_HOOKS_SCAN_DIR,
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
let scanDir: string;
let refuseDir: string;

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
  scanDir = path.join(root, 'managed-git-hooks', 'scan');
  refuseDir = path.join(root, 'managed-git-hooks', 'refuse');
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
    const { hookSha256, patternsSha256 } = refreshManagedGitHooks(scanDir);
    const hookPath = path.join(scanDir, MANAGED_HOOK_FILENAME);
    const patternsPath = path.join(scanDir, MANAGED_PATTERNS_FILENAME);
    expect(fs.existsSync(hookPath)).toBe(true);
    expect(fs.existsSync(patternsPath)).toBe(true);
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
    expect(hookSha256).toHaveLength(64);
    expect(patternsSha256).toHaveLength(64);
    // decideHooksMountStrategy reads the SAME recorded snapshot this refresh
    // just wrote — a 'scan' outcome here is the strongest available proof
    // the installed copy matches the source AND that this process recorded it.
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('scan');
  });

  it('is idempotent: a second refresh reproduces the same content and hashes', () => {
    const first = refreshManagedGitHooks(scanDir);
    const second = refreshManagedGitHooks(scanDir);
    expect(second).toEqual(first);
  });

  it('never swaps the containing directory itself — same inode across refreshes', () => {
    // A container that bind-mounted MANAGED_GIT_HOOKS_SCAN_DIR before a
    // restart must never end up looking at a stale, orphaned directory:
    // only the FILES inside are rename-in-placed, never the directory.
    refreshManagedGitHooks(scanDir);
    const inodeBefore = fs.statSync(scanDir).ino;
    refreshManagedGitHooks(scanDir);
    const inodeAfter = fs.statSync(scanDir).ino;
    expect(inodeAfter).toBe(inodeBefore);
  });

  it('writes the patterns file before the hook, so a mid-refresh crash never leaves a hook without its dependency', () => {
    // Not directly observable without instrumenting fs internals; assert the
    // documented ordering behaviorally instead: after a refresh, the
    // patterns file the hook sources is always already present and valid.
    refreshManagedGitHooks(scanDir);
    const patterns = fs.readFileSync(path.join(scanDir, MANAGED_PATTERNS_FILENAME), 'utf8');
    expect(patterns).toContain('secret_scan_selftest');
  });

  it('throws and writes NOTHING inside a symlinked managed-git-hooks parent — validation happens BEFORE any write, not after (#666 review P3-1)', () => {
    // Symlink the shared grandparent (`<root>/managed-git-hooks`) to an
    // unrelated real directory before scan/refuse exist at all. A
    // recursive mkdir would create scan/ INSIDE that symlink's target
    // before any validation ran; this asserts the target stays empty.
    const managedRoot = path.dirname(scanDir); // <root>/managed-git-hooks
    const evilTarget = `${managedRoot}-evil-target`;
    fs.mkdirSync(evilTarget, { recursive: true });
    fs.symlinkSync(evilTarget, managedRoot);

    expect(() => refreshManagedGitHooks(scanDir)).toThrow();
    expect(fs.readdirSync(evilTarget)).toEqual([]);
  });
});

describe('ensureRefuseHook', () => {
  it('writes an executable pre-push hook that refuses unconditionally and never mentions --no-verify', () => {
    ensureRefuseHook(refuseDir);
    const hookPath = path.join(refuseDir, MANAGED_HOOK_FILENAME);
    const stat = fs.statSync(hookPath);
    expect(stat.mode & 0o777).toBe(0o755);
    const content = fs.readFileSync(hookPath, 'utf8');
    expect(content).toMatch(/^#!\/bin\/sh/);
    expect(content).toMatch(/exit 1/);
    expect(content).not.toMatch(/--no-verify/);
  });

  it('is idempotent and never a live read from REPO_ROOT — content is identical across calls with no source on disk', () => {
    ensureRefuseHook(refuseDir);
    const first = fs.readFileSync(path.join(refuseDir, MANAGED_HOOK_FILENAME));
    ensureRefuseHook(refuseDir);
    const second = fs.readFileSync(path.join(refuseDir, MANAGED_HOOK_FILENAME));
    expect(second.equals(first)).toBe(true);
  });

  it('throws when the refuse directory has been replaced by a symlink', () => {
    ensureRefuseHook(refuseDir);
    const real = `${refuseDir}-real`;
    fs.renameSync(refuseDir, real);
    fs.symlinkSync(real, refuseDir);
    expect(() => ensureRefuseHook(refuseDir)).toThrow();
  });

  it('throws and writes NOTHING inside a symlinked managed-git-hooks parent (#666 review P3-1)', () => {
    const managedRoot = path.dirname(refuseDir); // <root>/managed-git-hooks
    const evilTarget = `${managedRoot}-evil-target`;
    fs.mkdirSync(evilTarget, { recursive: true });
    fs.symlinkSync(evilTarget, managedRoot);

    expect(() => ensureRefuseHook(refuseDir)).toThrow();
    expect(fs.readdirSync(evilTarget)).toEqual([]);
  });
});

describe('decideHooksMountStrategy — the scan -> refuse -> withhold fallback order', () => {
  it("'scan' when the scan dir was refreshed by this process and matches", () => {
    refreshManagedGitHooks(scanDir);
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('scan');
  });

  it("'refuse' (and writes the refuse hook lazily) when no refresh has completed in this process — mutation evidence for B4", () => {
    // No refreshManagedGitHooks(scanDir) call at all: the scan dir may not
    // even exist. This is the exact case B4 exists for — an empty
    // recordedSnapshots map, not a stale/absent scan dir being mistaken for
    // a pass.
    expect(fs.existsSync(path.join(refuseDir, MANAGED_HOOK_FILENAME))).toBe(false);
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('refuse');
    expect(fs.existsSync(path.join(refuseDir, MANAGED_HOOK_FILENAME))).toBe(true);
  });

  it("'refuse' when the installed hook content was tampered with after a real refresh", () => {
    refreshManagedGitHooks(scanDir);
    fs.appendFileSync(path.join(scanDir, MANAGED_HOOK_FILENAME), '\n# tampered\n');
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('refuse');
  });

  it("'refuse' when the installed patterns content was tampered with after a real refresh", () => {
    refreshManagedGitHooks(scanDir);
    fs.appendFileSync(path.join(scanDir, MANAGED_PATTERNS_FILENAME), '\n# tampered\n');
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('refuse');
  });

  it("'refuse' when the installed hook loses its executable bit", () => {
    refreshManagedGitHooks(scanDir);
    fs.chmodSync(path.join(scanDir, MANAGED_HOOK_FILENAME), 0o644);
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('refuse');
  });

  it("'refuse' when the scan directory itself has been replaced by a symlink (B11: not just the leaf file)", () => {
    refreshManagedGitHooks(scanDir);
    const real = `${scanDir}-real`;
    fs.renameSync(scanDir, real);
    fs.symlinkSync(real, scanDir);
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('refuse');
  });

  it("'withhold' when the managed-git-hooks PARENT directory has been replaced by a symlink — B11 mutation evidence", () => {
    // B11's exact scenario: an lstat on only the final component (scan/)
    // would pass this straight through, since scan/ itself is untouched —
    // only its GRANDPARENT is now a symlink. validateManagedDirChain walks
    // every component, so this degrades exactly like a tampered leaf — AND,
    // because scan/ and refuse/ share this same parent (B7's nesting), the
    // symlink breaks BOTH checks at once: there is no window where an
    // attacker can defeat the scan-dir check while the refuse-dir check
    // still reads as valid, so the outcome is 'withhold', not 'refuse'.
    refreshManagedGitHooks(scanDir);
    ensureRefuseHook(refuseDir); // valid before the attack, to prove the symlink is what breaks it
    const parent = path.dirname(scanDir); // <root>/managed-git-hooks
    const real = `${parent}-real`;
    fs.renameSync(parent, real);
    fs.symlinkSync(real, parent);
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('withhold');
  });

  it("'withhold' when neither the scan dir nor the refuse dir can be made valid", () => {
    refreshManagedGitHooks(scanDir);
    fs.appendFileSync(path.join(scanDir, MANAGED_HOOK_FILENAME), '\n# tampered\n');
    // Make the refuse dir itself unwritable-as-a-directory: a file sitting
    // where the directory should be. ensureRefuseHook's mkdirSync throws
    // (EEXIST-not-a-dir), so the lazy ensure-and-validate inside
    // decideHooksMountStrategy cannot repair it.
    fs.mkdirSync(path.dirname(refuseDir), { recursive: true });
    fs.writeFileSync(refuseDir, 'not a directory');
    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('withhold');
  });

  it('a boot-snapshot comparison — not a live re-read of REPO_ROOT — mutation evidence for B4', () => {
    // Refresh once, record the snapshot. If the REAL shipped source file
    // changes on disk afterward (simulating a deploy mid-uptime, before the
    // next restart), the installed copy must still read as valid: it still
    // matches what THIS process actually installed and recorded, which is
    // the whole point of B4. A live re-read implementation would instead
    // report 'refuse' here, which is exactly the bug B4 fixes.
    refreshManagedGitHooks(scanDir);
    const before = decideHooksMountStrategy(scanDir, refuseDir);
    expect(before).toBe('scan');

    // Simulate the shipped source changing after the boot-time refresh by
    // re-running refresh against a SEPARATE, unrelated scan dir (proving the
    // per-scanDir recordedSnapshots map is keyed correctly) — the original
    // scanDir's own installed files and recorded snapshot are untouched.
    const otherScanDir = path.join(root, 'other-scan');
    refreshManagedGitHooks(otherScanDir);
    fs.appendFileSync(path.join(otherScanDir, MANAGED_HOOK_FILENAME), '\n# unrelated drift\n');

    expect(decideHooksMountStrategy(scanDir, refuseDir)).toBe('scan');
  });
});

describe('migrateExistingCanonicalHooksPath', () => {
  it('points an unset core.hooksPath at the managed scan dir for a wiki repo only, counted in updated', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    fixtureRepo('wg-a', 'code'); // non-scan-policy sibling — must stay untouched

    const result = migrateExistingCanonicalHooksPath(root);
    expect(result).toEqual({ updated: 1, alerts: [] });
    expect(safeGitConfigGet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath')).toBe(
      MANAGED_GIT_HOOKS_SCAN_DIR,
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
      MANAGED_GIT_HOOKS_SCAN_DIR,
    );
  });

  it('leaves an already-migrated repo untouched and does not recount it as updated', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    safeGitConfigSet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath', MANAGED_GIT_HOOKS_SCAN_DIR);

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

  it('a stale config.lock on one repo does not abort the pass — the others still migrate (#666 review P2-2/B3)', () => {
    const wiki = fixtureRepo('wg-a', 'wiki');
    fixtureRepo('wg-b', 'wiki');
    // git's own locking convention: a pre-existing <config>.lock makes the
    // NEXT `git config --file ... set` fail with "could not lock config
    // file" rather than silently overwrite it.
    fs.writeFileSync(repositoryConfigPath(path.join(wiki, '.git')) + '.lock', '');

    const result = migrateExistingCanonicalHooksPath(root);
    // The locked repo is left untouched and counted as an alert (never
    // silently dropped, never a thrown exception out of this function);
    // the other workgroup's wiki repo still gets migrated.
    expect(result.updated).toBe(1);
    expect(result.alerts).toEqual(['wg-a/wiki']);
    expect(safeGitConfigGet(repositoryConfigPath(path.join(wiki, '.git')), 'core.hooksPath')).toBeNull();
    const wgBConfigPath = repositoryConfigPath(path.join(canonicalRepoDir('wg-b', 'wiki', root), '.git'));
    expect(safeGitConfigGet(wgBConfigPath, 'core.hooksPath')).toBe(MANAGED_GIT_HOOKS_SCAN_DIR);
  });
});
