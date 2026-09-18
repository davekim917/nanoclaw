/**
 * Tests for the mount allowlist loader/validator.
 *
 * Covers the two cleanups:
 *  - The loader honors the per-root `readOnly` key (translating it to
 *    `allowReadWrite`) and tolerates the top-level `nonMainReadOnly` key that
 *    setup writes into every fresh install.
 *  - The allowlist is read per call (mtime-keyed cache), so a parse error is
 *    never cached permanently — a fixed file is picked up without a restart.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The config path is a module-level const in production; point it at a
// per-test temp file via a getter so each test is isolated from the cache.
// dataDir mirrors DATA_DIR the same way, for the managed-git-hooks
// containment check (#666 review B9) — the real worktree's DATA_DIR has no
// data/managed-git-hooks directory at all, so that check needs its own
// per-test fixture root to exercise against.
const mockState = vi.hoisted(() => ({ allowlistPath: '', dataDir: '' }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../config.js');
  return {
    ...actual,
    get MOUNT_ALLOWLIST_PATH() {
      return mockState.allowlistPath;
    },
    get DATA_DIR() {
      return mockState.dataDir;
    },
  };
});

import { loadMountAllowlist, validateMount } from './index.js';

let tmpDir: string;
let configFile: string;
let projectsDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnt-sec-'));
  configFile = path.join(tmpDir, 'mount-allowlist.json');
  mockState.allowlistPath = configFile;
  mockState.dataDir = path.join(tmpDir, 'data');
  fs.mkdirSync(mockState.dataDir, { recursive: true });

  projectsDir = path.join(tmpDir, 'projects');
  repoDir = path.join(projectsDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeAllowlist(obj: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(obj, null, 2) + '\n');
}

describe('loadMountAllowlist', () => {
  it('translates per-root readOnly:false into a read-write grant', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, readOnly: false }],
      blockedPatterns: [],
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);

    // ...and a mount that requests read-write actually gets it.
    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });

  it('keeps readOnly:true as a read-only grant', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, readOnly: true }],
      blockedPatterns: [],
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(false);

    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('tolerates an unknown top-level nonMainReadOnly key', () => {
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, allowReadWrite: true }],
      blockedPatterns: [],
      nonMainReadOnly: true,
    });

    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots).toHaveLength(1);
    expect(allowlist!.allowedRoots[0].allowReadWrite).toBe(true);
  });

  it('picks up a fixed file without a restart (parse errors are not cached)', () => {
    // A broken edit blocks all mounts...
    fs.writeFileSync(configFile, 'not valid json {');
    expect(loadMountAllowlist()).toBeNull();

    // ...but fixing the file recovers on the very next call — no restart.
    writeAllowlist({
      allowedRoots: [{ path: projectsDir, allowReadWrite: true }],
      blockedPatterns: [],
    });
    const allowlist = loadMountAllowlist();
    expect(allowlist).not.toBeNull();
    expect(allowlist!.allowedRoots).toHaveLength(1);
  });

  it('returns null when the allowlist file is missing', () => {
    // No file written.
    expect(loadMountAllowlist()).toBeNull();
  });
});

describe('managed git-hooks tree containment (#666 review B9)', () => {
  function managedHooksScanDir(): string {
    const dir = path.join(mockState.dataDir, 'managed-git-hooks', 'scan');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it('refuses a read-write mount whose real path IS the managed git-hooks root', () => {
    const managedRoot = path.join(mockState.dataDir, 'managed-git-hooks');
    fs.mkdirSync(managedRoot, { recursive: true });
    writeAllowlist({ allowedRoots: [{ path: mockState.dataDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = validateMount({ hostPath: managedRoot, readonly: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/host-managed git-hooks tree/);
  });

  it('refuses a read-write mount whose real path is UNDER the managed git-hooks root (e.g. scan/)', () => {
    const scanDir = managedHooksScanDir();
    writeAllowlist({ allowedRoots: [{ path: mockState.dataDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = validateMount({ hostPath: scanDir, readonly: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/host-managed git-hooks tree/);
  });

  it('refuses via a symlink that only resolves into the managed git-hooks tree — realpath comparison, not string comparison (B11)', () => {
    const scanDir = managedHooksScanDir();
    const symlinkPath = path.join(tmpDir, 'sneaky-link');
    fs.symlinkSync(scanDir, symlinkPath);
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = validateMount({ hostPath: symlinkPath, readonly: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/host-managed git-hooks tree/);
  });

  it('refuses a read-write mount of DATA_DIR itself — an ANCESTOR of the managed tree reaches it through the parent (B9)', () => {
    managedHooksScanDir();
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = validateMount({ hostPath: mockState.dataDir, readonly: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/host-managed git-hooks tree/);
  });

  it('does NOT refuse a read-only mount of the same tree — the guard is RW-only', () => {
    const scanDir = managedHooksScanDir();
    writeAllowlist({ allowedRoots: [{ path: mockState.dataDir, allowReadWrite: true }], blockedPatterns: [] });

    const result = validateMount({ hostPath: scanDir, readonly: true });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(true);
  });

  it('is a no-op (never blocks) for an UNRELATED mount when the managed git-hooks tree does not exist yet on this host', () => {
    // No managed-git-hooks directory created under mockState.dataDir at all.
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
  });

  it('still refuses a read-write mount of DATA_DIR itself even when managed-git-hooks/ does not exist yet — the lexical check needs no realpath resolution of the (absent) leaf (#666 review P3-6)', () => {
    // mockState.dataDir exists (created in beforeEach), but nothing under
    // it named managed-git-hooks does — the exact "before the first host
    // restart that creates it" case the old realpath-only check missed.
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });
    const result = validateMount({ hostPath: mockState.dataDir, readonly: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/host-managed git-hooks tree/);
  });

  it('an ordinary read-write mount elsewhere under an allowed root is unaffected', () => {
    managedHooksScanDir(); // exists, but repoDir is nowhere near it
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    const result = validateMount({ hostPath: repoDir, readonly: false });
    expect(result.allowed).toBe(true);
    expect(result.effectiveReadonly).toBe(false);
  });
});

// Issue #876 hardening. Both patterns are credential-bearing directories that
// the default list missed by one character or one word.
describe('default blocked patterns cover the OAuth bundles and hyphenated key files', () => {
  /** Create `<projectsDir>/<relative>` and offer it as a mount. */
  function mountOf(relative: string): ReturnType<typeof validateMount> {
    const hostPath = path.join(projectsDir, relative);
    fs.mkdirSync(hostPath, { recursive: true });
    writeAllowlist({ allowedRoots: [{ path: projectsDir, allowReadWrite: true }], blockedPatterns: [] });
    return validateMount({ hostPath, readonly: true });
  }

  it('refuses the MCP OAuth bundle directory, where the refresh tokens live', () => {
    const result = mountOf(path.join('data', 'mcp-oauth'));
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked pattern "mcp-oauth"/);
  });

  it('refuses a parent that merely CONTAINS the bundle directory', () => {
    // `data/` is the realistic operator mistake: one entry, and the bundles
    // are inside it.
    fs.mkdirSync(path.join(projectsDir, 'nested', 'mcp-oauth'), { recursive: true });
    const result = mountOf(path.join('mcp-oauth-backups'));
    expect(result.allowed).toBe(false);
  });

  it('refuses the HYPHENATED private-key spelling, which `private_key` never matched', () => {
    const result = mountOf('private-key');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/blocked pattern "private-key"/);
    // The underscore spelling still matches, as before.
    expect(mountOf('private_key').allowed).toBe(false);
  });

  it('leaves an ordinary directory alone', () => {
    expect(mountOf('ordinary-repo').allowed).toBe(true);
  });
});

// #905 review P1: a blocked PATTERN only inspects the mount's own path, so
// `mcp-oauth` in the list closed the leaf and left every ancestor open —
// `data/`, or a home directory, reaches the same bundles through the parent.
describe('the MCP OAuth bundle directory is unreachable from above as well as below', () => {
  function mount(hostPath: string, readonly = true): ReturnType<typeof validateMount> {
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });
    return validateMount({ hostPath, readonly });
  }

  it('refuses a READ-ONLY mount of DATA_DIR, the realistic operator mistake', () => {
    fs.mkdirSync(path.join(mockState.dataDir, 'mcp-oauth'), { recursive: true });
    const result = mount(mockState.dataDir);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/MCP OAuth bundle directory/);
  });

  it('refuses an ancestor above DATA_DIR too', () => {
    fs.mkdirSync(path.join(mockState.dataDir, 'mcp-oauth'), { recursive: true });
    expect(mount(tmpDir).allowed).toBe(false);
  });

  it('refuses it before the directory exists — no integration has been created yet', () => {
    // Nothing named mcp-oauth on disk anywhere.
    expect(fs.existsSync(path.join(mockState.dataDir, 'mcp-oauth'))).toBe(false);
    expect(mount(mockState.dataDir).allowed).toBe(false);
  });

  it('refuses the bundle directory itself, read-only', () => {
    const bundles = path.join(mockState.dataDir, 'mcp-oauth');
    fs.mkdirSync(bundles, { recursive: true });
    expect(mount(bundles).allowed).toBe(false);
  });

  it('leaves a sibling under DATA_DIR alone — this is a targeted refusal, not a ban on data/', () => {
    const siblings = path.join(mockState.dataDir, 'workgroups');
    fs.mkdirSync(siblings, { recursive: true });
    expect(mount(siblings).allowed).toBe(true);
  });
});

// #905 review round 3: resolving only DATA_DIR and appending the literal
// `mcp-oauth` component misses the case where the LEAF is the symlink. Bundle
// writes follow it, so the target is where the refresh tokens really live.
describe('the bundle directory is protected through a symlinked leaf too', () => {
  function mount(hostPath: string): ReturnType<typeof validateMount> {
    writeAllowlist({ allowedRoots: [{ path: tmpDir, allowReadWrite: true }], blockedPatterns: [] });
    return validateMount({ hostPath, readonly: true });
  }

  /** `<dataDir>/mcp-oauth` → `<tmpDir>/elsewhere/bundles`, nothing in the
   *  target's own path spelling matching any pattern. */
  function linkBundlesOutside(): string {
    const target = path.join(tmpDir, 'elsewhere', 'bundles');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(mockState.dataDir, { recursive: true });
    fs.symlinkSync(target, path.join(mockState.dataDir, 'mcp-oauth'));
    return target;
  }

  it('refuses the symlink target', () => {
    const target = linkBundlesOutside();
    const result = mount(target);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/MCP OAuth bundle directory/);
  });

  it('refuses an ancestor of the symlink target', () => {
    linkBundlesOutside();
    expect(mount(path.join(tmpDir, 'elsewhere')).allowed).toBe(false);
  });

  it('still allows an unrelated directory beside it', () => {
    linkBundlesOutside();
    const unrelated = path.join(tmpDir, 'elsewhere-but-unrelated');
    fs.mkdirSync(unrelated, { recursive: true });
    expect(mount(unrelated).allowed).toBe(true);
  });
});
