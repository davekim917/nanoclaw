import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every docker call in this file goes through this mock. The fingerprint is
// injected into each pass directly, so only the fingerprint test and the sweep
// suite (which exercises the production default) ever reach it.
const mockExecFileSync = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const centralDbMock = vi.hoisted(() => ({ current: null as null | { db: Database.Database } }));
vi.mock('./db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/connection.js')>()),
  getRawDb: () => {
    if (!centralDbMock.current) throw new Error('central db unavailable in dependency-cache unit test');
    return centralDbMock.current.db;
  },
}));

// A complete stub, not a spread: log.ts installs process-wide handlers at
// module scope (see storage-manager.test.ts for the same note).
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import {
  _resetDependencyCacheForTesting,
  agentImageFingerprint,
  collectCacheGarbage,
  convertPackageDir,
  DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS,
  dependencyKey,
  envFingerprint,
  FARM_NEW_NAME,
  FARM_OLD_NAME,
  finishDependencyCachePass,
  inventoryOf,
  isEligiblePackageDir,
  linkPackageDir,
  processPackageDir,
  recoverPackageDir,
  startDependencyCachePass,
  verifyEntry,
  type ConvertStep,
  type DependencyCachePass,
} from './dependency-cache.js';
import { _resetStorageManagerThrottleForTesting, dirSizeBytes, getStorageReport } from './storage-manager.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

const FP = envFingerprint('22.23.2', 'x64');
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let cacheRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  _resetDependencyCacheForTesting();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dependency-cache-'));
  cacheRoot = path.join(tmpRoot, 'data', 'dependency-cache');
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

interface PkgSpec {
  /** The package-lock `packages` key. */
  key: string;
  name: string;
  version: string;
  files: Record<string, string>;
}

const PKGS: PkgSpec[] = [
  {
    key: 'node_modules/left-pad',
    name: 'left-pad',
    version: '1.3.0',
    files: { 'index.js': 'module.exports = (s) => s;\n', 'README.md': '# left-pad\n' },
  },
  {
    key: 'node_modules/@scope/util',
    name: '@scope/util',
    version: '2.0.1',
    files: { 'lib/util.js': 'exports.u = 1;\n' },
  },
  { key: 'node_modules/nest', name: 'nest', version: '0.4.0', files: { 'index.js': 'require("left-pad");\n' } },
  {
    key: 'node_modules/nest/node_modules/left-pad',
    name: 'left-pad',
    version: '1.0.0',
    files: { 'index.js': 'module.exports = 0;\n' },
  },
];

/** A second, different dependency set, so a fixture can hold a second key. */
function variantPkgs(tag: string): PkgSpec[] {
  return [
    {
      key: `node_modules/only-${tag}`,
      name: `only-${tag}`,
      version: '3.1.4',
      files: { 'index.js': `module.exports = '${tag}';\n` },
    },
  ];
}

function lockEntries(pkgs: PkgSpec[]): Record<string, { version: string; resolved: string; integrity: string }> {
  const entries: Record<string, { version: string; resolved: string; integrity: string }> = {};
  for (const pkg of pkgs) {
    const base = pkg.name.split('/').pop()!;
    entries[pkg.key] = {
      version: pkg.version,
      resolved: `https://registry.npmjs.org/${pkg.name}/-/${base}-${pkg.version}.tgz`,
      integrity: `sha512-${crypto.createHash('sha256').update(`${pkg.name}@${pkg.version}`).digest('base64')}`,
    };
  }
  return entries;
}

function writeManifests(
  pkgDir: string,
  options: {
    pkgs?: PkgSpec[];
    lockfileVersion?: number;
    pkgJson?: Record<string, unknown>;
    npmrc?: string;
    /** package-lock entries that are NOT installed (so absent from the hidden lockfile). */
    extraLock?: Record<string, Record<string, unknown>>;
  } = {},
): void {
  const pkgs = options.pkgs ?? PKGS;
  fs.mkdirSync(pkgDir, { recursive: true });
  const dependencies = Object.fromEntries(
    pkgs.filter((pkg) => pkg.key.split('node_modules/').length === 2).map((pkg) => [pkg.name, `^${pkg.version}`]),
  );
  const manifest = { name: 'app', version: '1.0.0', dependencies, ...options.pkgJson };
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const lock = {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: options.lockfileVersion ?? 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0', dependencies }, ...lockEntries(pkgs), ...options.extraLock },
  };
  fs.writeFileSync(path.join(pkgDir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  if (options.npmrc !== undefined) fs.writeFileSync(path.join(pkgDir, '.npmrc'), options.npmrc);
}

/** Old enough that every fixture file predates any real seal. */
const FILE_STAMP_S = (Date.now() - 60 * 60 * 1000) / 1000;

/**
 * What `npm ci` leaves behind: every declared package dir, a `.bin` symlink,
 * and the hidden lockfile written last. Private dirs (`.vite`, `.cache`) are
 * workspace state that must never be shared.
 */
function installTree(pkgDir: string, options: { pkgs?: PkgSpec[]; privateDirs?: boolean } = {}): void {
  const pkgs = options.pkgs ?? PKGS;
  const nm = path.join(pkgDir, 'node_modules');
  for (const pkg of pkgs) {
    const dir = path.join(pkgDir, pkg.key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version }) + '\n');
    for (const [rel, body] of Object.entries(pkg.files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  }
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  const first = pkgs[0]!;
  fs.symlinkSync(
    `../${first.name}/${Object.keys(first.files)[0]}`,
    path.join(nm, '.bin', first.name.split('/').pop()!),
  );
  for (const file of regularFiles(nm)) {
    fs.utimesSync(path.join(nm, file), FILE_STAMP_S, FILE_STAMP_S);
  }
  const hidden = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: lockEntries(pkgs) };
  fs.writeFileSync(path.join(nm, '.package-lock.json'), JSON.stringify(hidden, null, 2) + '\n');
  fs.utimesSync(path.join(nm, '.package-lock.json'), FILE_STAMP_S + 30, FILE_STAMP_S + 30);
  if (options.privateDirs) {
    fs.mkdirSync(path.join(nm, '.vite', 'deps'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.vite', 'deps', '_metadata.json'), 'vite-sentinel');
    fs.mkdirSync(path.join(nm, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.cache', 'sentinel'), 'cache-sentinel');
  }
}

function makeProject(
  pkgDir: string,
  options: { pkgs?: PkgSpec[]; privateDirs?: boolean; extraLock?: Record<string, Record<string, unknown>> } = {},
): string {
  writeManifests(pkgDir, { pkgs: options.pkgs, extraLock: options.extraLock });
  installTree(pkgDir, options);
  return pkgDir;
}

/** An optional package-lock entry with the given os/cpu/libc constraints. */
function optionalEntry(constraints: Record<string, string[]>): Record<string, unknown> {
  return {
    version: '0.25.0',
    resolved: 'https://registry.npmjs.org/optional-native/-/optional-native-0.25.0.tgz',
    integrity: 'sha512-optional',
    optional: true,
    ...constraints,
  };
}

/** Make an entry look sealed `sealedDaysAgo` days ago, with every file older still. */
function backdateEntry(entryDir: string, sealedDaysAgo: number): void {
  const sealedAtMs = Date.now() - sealedDaysAgo * DAY_MS;
  const fileStamp = (sealedAtMs - DAY_MS) / 1000;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) fs.lutimesSync(full, fileStamp, fileStamp);
      else fs.utimesSync(full, fileStamp, fileStamp);
    }
  };
  walk(path.join(entryDir, 'node_modules'));
  const sealedPath = path.join(entryDir, 'SEALED');
  const sealed = JSON.parse(fs.readFileSync(sealedPath, 'utf8')) as Record<string, unknown>;
  const iso = new Date(sealedAtMs).toISOString();
  fs.unlinkSync(sealedPath);
  fs.writeFileSync(sealedPath, JSON.stringify({ ...sealed, sealedAt: iso, lastLinkedAt: iso }));
}

function isPrivateRootName(rel: string): boolean {
  const first = rel.split('/')[0]!;
  return first.startsWith('.') && first !== '.bin' && first !== '.package-lock.json';
}

/** Relative paths of regular files, sorted, private root dot entries excluded. */
function regularFiles(root: string, options: { includePrivate?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && !options.includePrivate && isPrivateRootName(childRel)) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(root, '');
  return out.sort();
}

function inodes(root: string, options: { includePrivate?: boolean } = {}): Map<string, number> {
  return new Map(regularFiles(root, options).map((rel) => [rel, fs.lstatSync(path.join(root, rel)).ino]));
}

/** Byte-, inode-, mode- and mtime-level picture of everything under `root`. */
function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const st = fs.lstatSync(full);
      const head = `${st.ino}:${st.mode}:${st.mtimeMs}:${st.nlink}`;
      if (st.isSymbolicLink()) out[childRel] = `l:${head}:${fs.readlinkSync(full)}`;
      else if (st.isDirectory()) {
        out[childRel] = `d:${head}`;
        walk(full, childRel);
      } else {
        out[childRel] = `f:${head}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(root, '');
  return out;
}

function startPass(mode: 'apply' | 'report' = 'apply', now = Date.now()): DependencyCachePass {
  const pass = startDependencyCachePass({
    mode,
    cacheRoot,
    now,
    reclaimableBytes: dirSizeBytes,
    fingerprint: () => FP,
  });
  if (!pass) throw new Error('dependency cache pass unavailable');
  return pass;
}

function keyOf(pkgDir: string): string {
  const key = dependencyKey(pkgDir, FP);
  if (!key) throw new Error(`no key for ${pkgDir}`);
  return key.key;
}

function cacheEntries(wg: string): string[] {
  const dir = path.join(cacheRoot, wg);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function tempNamesUnder(pkgDir: string): string[] {
  return [FARM_NEW_NAME, FARM_OLD_NAME].filter((name) => fs.existsSync(path.join(pkgDir, name)));
}

function expectFarmOf(pkgDir: string, entryDir: string): void {
  const nm = path.join(pkgDir, 'node_modules');
  const entryNm = path.join(entryDir, 'node_modules');
  const files = regularFiles(nm);
  expect(files).toEqual(regularFiles(entryNm));
  for (const rel of files) {
    expect(fs.lstatSync(path.join(nm, rel)).ino, rel).toBe(fs.lstatSync(path.join(entryNm, rel)).ino);
  }
}

function decisionOps(): string[] {
  return vi
    .mocked(log.info)
    .mock.calls.filter(([message]) => message === 'dependency-cache: decision')
    .map(([, data]) => String((data as { op: string }).op));
}

// ── P1 acceptance ───────────────────────────────────────────────────────────

describe('dependency cache', () => {
  it('key changes with package-lock, package.json, .npmrc, or node fingerprint and is otherwise stable', () => {
    const base = path.join(tmpRoot, 'base');
    const twin = path.join(tmpRoot, 'twin');
    writeManifests(base);
    writeManifests(twin);
    const baseKey = keyOf(base);

    expect(keyOf(base)).toBe(baseKey);
    expect(keyOf(twin)).toBe(baseKey);
    // An absent .npmrc hashes as empty bytes.
    fs.writeFileSync(path.join(twin, '.npmrc'), '');
    expect(keyOf(twin)).toBe(baseKey);

    const mutations: Array<[string, (dir: string) => void, string]> = [
      ['package-lock', (dir) => fs.appendFileSync(path.join(dir, 'package-lock.json'), '\n'), FP],
      ['package-json', (dir) => fs.appendFileSync(path.join(dir, 'package.json'), '\n'), FP],
      ['npmrc', (dir) => fs.writeFileSync(path.join(dir, '.npmrc'), 'registry=https://example.invalid/\n'), FP],
      ['node', () => undefined, envFingerprint('22.23.3', 'x64')],
    ];
    const mutated = mutations.map(([name, mutate, fingerprint]) => {
      const dir = path.join(tmpRoot, `mutated-${name}`);
      writeManifests(dir);
      mutate(dir);
      return dependencyKey(dir, fingerprint)!.key;
    });

    expect(new Set(mutated).size).toBe(4);
    for (const key of mutated) expect(key).not.toBe(baseKey);
  });

  it('adopts a verified complete private tree as a sealed read-only entry sharing inodes with the source', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'), { privateDirs: true });
    const pass = startPass();

    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');

    const key = keyOf(src);
    const entry = path.join(cacheRoot, 'wg-a', key);
    const entryNm = path.join(entry, 'node_modules');
    const srcNm = path.join(src, 'node_modules');
    const files = regularFiles(srcNm);
    expect(files.length).toBeGreaterThan(8);
    expect(regularFiles(entryNm)).toEqual(files);
    for (const rel of files) {
      const entryStat = fs.lstatSync(path.join(entryNm, rel));
      expect(entryStat.ino, rel).toBe(fs.lstatSync(path.join(srcNm, rel)).ino);
      expect(entryStat.mode & 0o222, rel).toBe(0);
    }
    expect(fs.lstatSync(path.join(entryNm, '.bin', 'left-pad')).isSymbolicLink()).toBe(true);

    const sealed = JSON.parse(fs.readFileSync(path.join(entry, 'SEALED'), 'utf8')) as {
      inventory: unknown;
      inventorySha256: string;
      source: string;
      sealedAt: string;
    };
    const inventory = inventoryOf(srcNm)!;
    expect(sealed.inventory).toEqual(inventory.items);
    expect(sealed.inventorySha256).toBe(inventory.sha256);
    expect(sealed.source).toBe(src);
    expect(Number.isFinite(Date.parse(sealed.sealedAt))).toBe(true);
    expect(verifyEntry(entry).ok).toBe(true);
    expect(cacheEntries('wg-a')).toEqual([key]);
    expect(pass.counters.adopted).toBe(1);
  });

  it('refuses to adopt a tree with a file newer than its hidden lockfile', () => {
    const src = makeProject(path.join(tmpRoot, 'repo'));
    const hiddenMs = fs.lstatSync(path.join(src, 'node_modules', '.package-lock.json')).mtimeMs;
    const late = (hiddenMs + 5000) / 1000;
    fs.utimesSync(path.join(src, 'node_modules', 'left-pad', 'index.js'), late, late);
    const before = snapshotTree(src);

    expect(processPackageDir(startPass(), 'wg-a', src)).toBe('incomplete');

    expect(cacheEntries('wg-a')).toEqual([]);
    expect(snapshotTree(src)).toEqual(before);
  });

  it('refuses to adopt a tree whose hidden lockfile is missing or differs from package-lock.json', () => {
    const missing = makeProject(path.join(tmpRoot, 'missing'));
    fs.rmSync(path.join(missing, 'node_modules', '.package-lock.json'));

    const differs = makeProject(path.join(tmpRoot, 'differs'));
    const hiddenPath = path.join(differs, 'node_modules', '.package-lock.json');
    const hidden = JSON.parse(fs.readFileSync(hiddenPath, 'utf8')) as {
      packages: Record<string, { integrity: string }>;
    };
    hidden.packages['node_modules/left-pad']!.integrity = 'sha512-somethingelse';
    fs.writeFileSync(hiddenPath, JSON.stringify(hidden, null, 2) + '\n');

    const omitted = makeProject(path.join(tmpRoot, 'omitted'));
    const omittedPath = path.join(omitted, 'node_modules', '.package-lock.json');
    const partial = JSON.parse(fs.readFileSync(omittedPath, 'utf8')) as { packages: Record<string, unknown> };
    delete partial.packages['node_modules/nest'];
    fs.writeFileSync(omittedPath, JSON.stringify(partial, null, 2) + '\n');

    // A package-lock entry that is NOT optional and never reached the hidden
    // lockfile: npm had to install it, so the tree is short of it.
    const nonOptionalAbsent = makeProject(path.join(tmpRoot, 'non-optional-absent'), {
      extraLock: {
        'node_modules/required-dep': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/required-dep/-/required-dep-2.0.0.tgz',
          integrity: 'sha512-required',
        },
      },
    });

    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', missing)).toBe('incomplete');
    expect(processPackageDir(pass, 'wg-a', differs)).toBe('incomplete');
    expect(processPackageDir(pass, 'wg-a', omitted)).toBe('incomplete');
    expect(processPackageDir(pass, 'wg-a', nonOptionalAbsent)).toBe('incomplete');
    expect(cacheEntries('wg-a')).toEqual([]);
    expect(pass.counters.adopted).toBe(0);
  });

  it('converts a complete private tree into a farm of the matching entry', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    const target = makeProject(path.join(tmpRoot, 'topic-b', 'repo'));
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');
    const entry = path.join(cacheRoot, 'wg-a', keyOf(src));
    const oldInodes = new Set(inodes(path.join(target, 'node_modules')).values());

    expect(convertPackageDir(pass, 'wg-a', target)).toBe('converted');

    expectFarmOf(target, entry);
    for (const ino of inodes(path.join(target, 'node_modules')).values()) expect(oldInodes.has(ino)).toBe(false);
    expect(tempNamesUnder(target)).toEqual([]);
    expect(pass.counters.converted).toBe(1);
    // A second pass sees a farm and does nothing.
    expect(processPackageDir(startPass(), 'wg-a', target)).toBe('farm');
  });

  it('conversion preserves workspace-private .vite and .cache dirs and never shares them', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'), { privateDirs: true });
    const target = makeProject(path.join(tmpRoot, 'topic-b', 'repo'), { privateDirs: true });
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');
    const entry = path.join(cacheRoot, 'wg-a', keyOf(src));
    const sentinels = ['.vite/deps/_metadata.json', '.cache/sentinel'];
    const before = sentinels.map((rel) => {
      const full = path.join(target, 'node_modules', rel);
      return { rel, ino: fs.lstatSync(full).ino, bytes: fs.readFileSync(full, 'utf8') };
    });

    expect(processPackageDir(pass, 'wg-a', target)).toBe('converted');

    for (const { rel, ino, bytes } of before) {
      const full = path.join(target, 'node_modules', rel);
      expect(fs.lstatSync(full).ino).toBe(ino);
      expect(fs.readFileSync(full, 'utf8')).toBe(bytes);
    }
    expect(fs.existsSync(path.join(entry, 'node_modules', '.vite'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'node_modules', '.cache'))).toBe(false);
    expectFarmOf(target, entry);
  });

  it('in-place writes to a farm file fail and unlink-then-create leaves the entry unchanged', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    const farm = makeProject(path.join(tmpRoot, 'topic-b', 'repo'));
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');
    expect(processPackageDir(pass, 'wg-a', farm)).toBe('converted');
    const entry = path.join(cacheRoot, 'wg-a', keyOf(src));
    const farmFile = path.join(farm, 'node_modules', 'left-pad', 'index.js');
    const entryFile = path.join(entry, 'node_modules', 'left-pad', 'index.js');
    const entryIno = fs.lstatSync(entryFile).ino;
    const entryBytes = fs.readFileSync(entryFile, 'utf8');

    let code: string | undefined;
    try {
      fs.appendFileSync(farmFile, 'an in-place edit');
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('EACCES');

    fs.unlinkSync(farmFile);
    fs.writeFileSync(farmFile, 'a private replacement');

    expect(fs.lstatSync(entryFile).ino).toBe(entryIno);
    expect(fs.readFileSync(entryFile, 'utf8')).toBe(entryBytes);
    expect(fs.readFileSync(farmFile, 'utf8')).toBe('a private replacement');
    expect(verifyEntry(entry).ok).toBe(true);
  });

  it('quarantines an entry with a file modified after sealedAt and never links it again', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    expect(processPackageDir(startPass(), 'wg-a', src)).toBe('adopted');
    const key = keyOf(src);
    const entry = path.join(cacheRoot, 'wg-a', key);
    const sealedAt = Date.parse(
      (JSON.parse(fs.readFileSync(path.join(entry, 'SEALED'), 'utf8')) as { sealedAt: string }).sealedAt,
    );
    // Same size, so only the mtime can give it away; write bits restored after.
    const tampered = path.join(entry, 'node_modules', 'left-pad', 'index.js');
    const size = fs.statSync(tampered).size;
    fs.chmodSync(tampered, 0o644);
    fs.writeFileSync(tampered, 'x'.repeat(size));
    fs.chmodSync(tampered, 0o444);
    fs.utimesSync(tampered, (sealedAt + 60_000) / 1000, (sealedAt + 60_000) / 1000);

    const bare = path.join(tmpRoot, 'topic-b', 'repo');
    writeManifests(bare);
    const pass = startPass();

    expect(linkPackageDir(pass, 'wg-a', bare)).toBe('quarantined');

    expect(fs.existsSync(entry)).toBe(false);
    expect(cacheEntries('wg-a').filter((name) => name.startsWith(`${key}.quarantined-`))).toHaveLength(1);
    expect(fs.existsSync(path.join(bare, 'node_modules'))).toBe(false);
    expect(tempNamesUnder(bare)).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: quarantined entry',
      expect.objectContaining({ offendingPath: 'left-pad/index.js' }),
    );
    expect(pass.counters.quarantined).toBe(1);

    vi.mocked(log.warn).mockClear();
    expect(linkPackageDir(pass, 'wg-a', bare)).toBe('no-entry');
    expect(fs.existsSync(path.join(bare, 'node_modules'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: no verified entry for key',
      expect.objectContaining({ quarantined: true }),
    );

    const other = makeProject(path.join(tmpRoot, 'topic-c', 'repo'));
    const before = inodes(path.join(other, 'node_modules'));
    vi.mocked(log.warn).mockClear();
    expect(convertPackageDir(pass, 'wg-a', other)).toBe('no-entry');
    expect(inodes(path.join(other, 'node_modules'))).toEqual(before);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: no verified entry for key',
      expect.objectContaining({ quarantined: true }),
    );
  });

  it('conversion survives interruption at every step with private bytes intact', () => {
    const crashPoints: ConvertStep[] = ['link-new', 'rename-old', 'rename-new', 'move-private:.cache'];
    for (const [index, crashPoint] of crashPoints.entries()) {
      const src = makeProject(path.join(tmpRoot, `src-${index}`, 'repo'), { privateDirs: true });
      const target = makeProject(path.join(tmpRoot, `target-${index}`, 'repo'), { privateDirs: true });
      const wg = `wg-${index}`;
      expect(processPackageDir(startPass(), wg, src)).toBe('adopted');
      const entry = path.join(cacheRoot, wg, keyOf(src));
      const sentinels = ['.vite/deps/_metadata.json', '.cache/sentinel'].map((rel) => {
        const full = path.join(target, 'node_modules', rel);
        return { rel, ino: fs.lstatSync(full).ino, bytes: fs.readFileSync(full, 'utf8') };
      });

      const originalInodes = inodes(path.join(target, 'node_modules'));

      const crashed = convertPackageDir(startPass(), wg, target, {
        onStep: (step) => {
          if (step === crashPoint) throw new Error(`simulated crash after ${step}`);
        },
      });
      expect(crashed, crashPoint).toBe('failed');
      expect(tempNamesUnder(target).length, crashPoint).toBeGreaterThan(0);

      const recoveryPass = startPass();
      expect(recoverPackageDir(recoveryPass, wg, target), crashPoint).toBe('recovered');
      expect(recoverPackageDir(recoveryPass, wg, target), crashPoint).toBe('clean');
      expect(tempNamesUnder(target), crashPoint).toEqual([]);
      for (const { rel, ino, bytes } of sentinels) {
        const full = path.join(target, 'node_modules', rel);
        expect(fs.lstatSync(full).ino, `${crashPoint} ${rel}`).toBe(ino);
        expect(fs.readFileSync(full, 'utf8'), `${crashPoint} ${rel}`).toBe(bytes);
      }

      const reversed = crashPoint === 'link-new' || crashPoint === 'rename-old';
      if (reversed) {
        // A crash at steps 1-2: recovery restores the original private tree.
        expect(inodes(path.join(target, 'node_modules')), crashPoint).toEqual(originalInodes);
      } else {
        // A crash at step 3 or mid-step 4: recovery completes the move.
        expectFarmOf(target, entry);
      }

      // The same pass's conversion then ends with a farm either way.
      expect(processPackageDir(recoveryPass, wg, target), crashPoint).toBe(reversed ? 'converted' : 'farm');
      expectFarmOf(target, entry);
      expect(tempNamesUnder(target), crashPoint).toEqual([]);
      for (const { rel, ino, bytes } of sentinels) {
        const full = path.join(target, 'node_modules', rel);
        expect(fs.lstatSync(full).ino, `${crashPoint} ${rel}`).toBe(ino);
        expect(fs.readFileSync(full, 'utf8'), `${crashPoint} ${rel}`).toBe(bytes);
      }
    }
  });

  it('entries never cross workgroups', () => {
    const inA = makeProject(path.join(tmpRoot, 'wg-a-topic', 'repo'));
    const bareB = path.join(tmpRoot, 'wg-b-topic-1', 'repo');
    writeManifests(bareB);
    const inB = makeProject(path.join(tmpRoot, 'wg-b-topic-2', 'repo'));
    const key = keyOf(inA);
    expect(keyOf(inB)).toBe(key);
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', inA)).toBe('adopted');

    expect(linkPackageDir(pass, 'wg-b', bareB)).toBe('no-entry');
    expect(fs.existsSync(path.join(bareB, 'node_modules'))).toBe(false);

    expect(processPackageDir(pass, 'wg-b', inB)).toBe('adopted');
    expect(cacheEntries('wg-b')).toEqual([key]);
    const entryA = path.join(cacheRoot, 'wg-a', key, 'node_modules');
    const entryB = path.join(cacheRoot, 'wg-b', key, 'node_modules');
    const inodesA = new Set(inodes(entryA).values());
    for (const ino of inodes(entryB).values()) expect(inodesA.has(ino)).toBe(false);
    expectFarmOf(inB, path.join(cacheRoot, 'wg-b', key));
  });

  it('cache GC deletes an entry only when no farm links remain and it is aged', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    const t0 = Date.now();
    expect(processPackageDir(startPass('apply', t0), 'wg-a', src)).toBe('adopted');
    const entry = path.join(cacheRoot, 'wg-a', keyOf(src));

    collectCacheGarbage(startPass('apply', t0 + 15 * DAY_MS));
    expect(fs.existsSync(entry)).toBe(true);

    fs.rmSync(path.join(src, 'node_modules'), { recursive: true });
    collectCacheGarbage(startPass('apply', t0 + DAY_MS));
    expect(fs.existsSync(entry)).toBe(true);

    const late = startPass('apply', t0 + 15 * DAY_MS);
    collectCacheGarbage(late);
    expect(fs.existsSync(entry)).toBe(false);
    expect(late.counters.gcDeleted).toBe(1);

    // Quarantined entries age out on the shorter clock.
    const second = makeProject(path.join(tmpRoot, 'topic-b', 'repo'), { pkgs: variantPkgs('gc') });
    expect(processPackageDir(startPass('apply', t0), 'wg-a', second)).toBe('adopted');
    const secondEntry = path.join(cacheRoot, 'wg-a', keyOf(second));
    fs.unlinkSync(path.join(secondEntry, 'node_modules', 'only-gc', 'index.js'));
    collectCacheGarbage(startPass('apply', t0));
    const quarantined = cacheEntries('wg-a').filter((name) => name.includes('.quarantined-'));
    expect(quarantined).toHaveLength(1);
    collectCacheGarbage(startPass('apply', Date.now() + 6 * DAY_MS));
    expect(cacheEntries('wg-a')).toEqual(quarantined);
    collectCacheGarbage(startPass('apply', Date.now() + 8 * DAY_MS));
    expect(cacheEntries('wg-a')).toEqual([]);
  });

  it('report mode logs decisions and mutates nothing', () => {
    const wg = 'wg-r';
    const seeded = makeProject(path.join(tmpRoot, 'seeded', 'repo'));
    const convertible = makeProject(path.join(tmpRoot, 'convertible', 'repo'), { privateDirs: true });
    const adoptable = makeProject(path.join(tmpRoot, 'adoptable', 'repo'), { pkgs: variantPkgs('adopt') });
    const interrupted = makeProject(path.join(tmpRoot, 'interrupted', 'repo'));
    fs.mkdirSync(path.join(interrupted, FARM_NEW_NAME, 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(interrupted, FARM_NEW_NAME, 'left-pad', 'index.js'), 'farm link stand-in');
    const tampered = makeProject(path.join(tmpRoot, 'tampered', 'repo'), { pkgs: variantPkgs('tamper') });
    const orphaned = makeProject(path.join(tmpRoot, 'orphaned', 'repo'), { pkgs: variantPkgs('orphan') });

    const seedPass = startPass();
    for (const dir of [seeded, tampered, orphaned]) expect(processPackageDir(seedPass, wg, dir)).toBe('adopted');
    fs.unlinkSync(path.join(cacheRoot, wg, keyOf(tampered), 'node_modules', 'only-tamper', 'index.js'));
    fs.rmSync(path.join(orphaned, 'node_modules'), { recursive: true });
    vi.mocked(log.info).mockClear();
    vi.mocked(log.warn).mockClear();

    const before = snapshotTree(tmpRoot);
    const pass = startPass('report', Date.now() + 30 * DAY_MS);
    recoverPackageDir(pass, wg, interrupted);
    processPackageDir(pass, wg, convertible);
    processPackageDir(pass, wg, adoptable);
    processPackageDir(pass, wg, seeded);
    collectCacheGarbage(pass);
    const report = finishDependencyCachePass(pass);

    expect(snapshotTree(tmpRoot)).toEqual(before);
    expect(decisionOps().sort()).toEqual(['adopt', 'convert', 'gc-delete', 'quarantine', 'recover'].sort());
    expect(report.mode).toBe('report');
    expect(report.counters).toEqual(
      expect.objectContaining({ recovered: 1, adopted: 1, converted: 1, quarantined: 1, gcDeleted: 1 }),
    );
    const convertDecision = vi
      .mocked(log.info)
      .mock.calls.find(
        ([message, data]) => message === 'dependency-cache: decision' && (data as { op: string }).op === 'convert',
      );
    expect((convertDecision?.[1] as { estimatedBytes: number }).estimatedBytes).toBeGreaterThan(0);
  });

  it('refuses to adopt a tree with a declared package directory missing or at the wrong version', () => {
    const deleted = makeProject(path.join(tmpRoot, 'deleted'));
    fs.rmSync(path.join(deleted, 'node_modules', '@scope', 'util'), { recursive: true });

    const wrongVersion = makeProject(path.join(tmpRoot, 'wrong-version'));
    const manifest = path.join(wrongVersion, 'node_modules', 'left-pad', 'package.json');
    const stat = fs.statSync(manifest);
    fs.writeFileSync(manifest, JSON.stringify({ name: 'left-pad', version: '1.3.1' }) + '\n');
    fs.utimesSync(manifest, stat.atime, stat.mtime);

    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', deleted)).toBe('incomplete');
    expect(processPackageDir(pass, 'wg-a', wrongVersion)).toBe('incomplete');
    expect(cacheEntries('wg-a')).toEqual([]);
  });

  it('a sealed entry with a deleted or resized file is quarantined before any link or convert', () => {
    // Deleted file, caught by the next link.
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    expect(processPackageDir(startPass(), 'wg-a', src)).toBe('adopted');
    const key = keyOf(src);
    fs.unlinkSync(path.join(cacheRoot, 'wg-a', key, 'node_modules', '@scope', 'util', 'lib', 'util.js'));
    const bare = path.join(tmpRoot, 'topic-b', 'repo');
    writeManifests(bare);

    expect(linkPackageDir(startPass(), 'wg-a', bare)).toBe('quarantined');
    expect(fs.existsSync(path.join(bare, 'node_modules'))).toBe(false);
    expect(tempNamesUnder(bare)).toEqual([]);
    expect(cacheEntries('wg-a').filter((name) => name.startsWith(`${key}.quarantined-`))).toHaveLength(1);

    // Resized file (mtime restored), caught by the next convert.
    const src2 = makeProject(path.join(tmpRoot, 'topic-c', 'repo'));
    expect(processPackageDir(startPass(), 'wg-r', src2)).toBe('adopted');
    const resized = path.join(cacheRoot, 'wg-r', key, 'node_modules', 'left-pad', 'README.md');
    const stat = fs.statSync(resized);
    fs.chmodSync(resized, 0o644);
    fs.truncateSync(resized, 3);
    fs.chmodSync(resized, 0o444);
    fs.utimesSync(resized, stat.atime, stat.mtime);
    const target = makeProject(path.join(tmpRoot, 'topic-d', 'repo'));
    const before = inodes(path.join(target, 'node_modules'));

    expect(convertPackageDir(startPass(), 'wg-r', target)).toBe('quarantined');
    expect(inodes(path.join(target, 'node_modules'))).toEqual(before);
    expect(tempNamesUnder(target)).toEqual([]);
    expect(cacheEntries('wg-r').filter((name) => name.startsWith(`${key}.quarantined-`))).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: quarantined entry',
      expect.objectContaining({ offendingPath: 'left-pad/README.md' }),
    );
  });

  it('conversion keeps a private tree whose inventory differs from the entry', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    const target = makeProject(path.join(tmpRoot, 'topic-b', 'repo'));
    const extra = path.join(target, 'node_modules', 'left-pad', 'extra.js');
    fs.writeFileSync(extra, 'a file the entry does not have');
    fs.utimesSync(extra, FILE_STAMP_S, FILE_STAMP_S);
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');
    const before = inodes(path.join(target, 'node_modules'), { includePrivate: true });

    expect(convertPackageDir(pass, 'wg-a', target)).toBe('convert-mismatch');

    expect(inodes(path.join(target, 'node_modules'), { includePrivate: true })).toEqual(before);
    expect(tempNamesUnder(target)).toEqual([]);
    expect(pass.counters.convertMismatch).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: convert mismatch',
      expect.objectContaining({ path: target }),
    );
  });

  it('leaves the package dir mtime alone across convert and recovery, so the sweep idle signal is not self-poisoned', () => {
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'));
    const target = makeProject(path.join(tmpRoot, 'topic-b', 'repo'), { privateDirs: true });
    const stamp = (Date.now() - 10 * DAY_MS) / 1000;
    fs.utimesSync(target, stamp, stamp);
    // utimes takes float seconds, so a round trip can move the stamp by a
    // fraction of a millisecond. A bump by our renames would move it ~10 days.
    const idleSince = fs.statSync(target).mtimeMs;
    const pass = startPass();
    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');

    expect(
      convertPackageDir(pass, 'wg-a', target, {
        onStep: (step) => {
          if (step === 'rename-new') throw new Error('simulated crash');
        },
      }),
    ).toBe('failed');
    expect(Math.abs(fs.statSync(target).mtimeMs - idleSince)).toBeLessThan(1);
    expect(recoverPackageDir(pass, 'wg-a', target)).toBe('recovered');
    expect(Math.abs(fs.statSync(target).mtimeMs - idleSince)).toBeLessThan(1);
  });

  it('accepts a tree whose only absent packages are optional', () => {
    // One the platform allows and one it excludes: Phase 1 does not ask why an
    // optional is absent, because convert only ever merges identical installs.
    const src = makeProject(path.join(tmpRoot, 'topic-a', 'repo'), {
      extraLock: {
        'node_modules/@esbuild/linux-x64': optionalEntry({ os: ['linux'], cpu: ['x64'] }),
        'node_modules/@esbuild/aix-ppc64': optionalEntry({ os: ['aix'], cpu: ['ppc64'] }),
      },
    });
    const pass = startPass();

    expect(processPackageDir(pass, 'wg-a', src)).toBe('adopted');

    expect(cacheEntries('wg-a')).toEqual([keyOf(src)]);
    expect(pass.counters.adopted).toBe(1);
  });

  it('a pass mutates at most the per-pass cap and defers the rest', () => {
    expect(DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS).toBe(5);
    const trees = Array.from({ length: 7 }, (_, i) => makeProject(path.join(tmpRoot, `topic-${i}`, 'repo')));
    const first = startPass();

    const firstOutcomes = trees.map((dir) => processPackageDir(first, 'wg-a', dir));

    expect(firstOutcomes).toEqual([
      'adopted',
      'converted',
      'converted',
      'converted',
      'converted',
      'deferred',
      'deferred',
    ]);
    expect(first.counters).toEqual(expect.objectContaining({ adopted: 1, converted: 4, deferred: 2 }));
    const deferredBefore = trees.slice(5).map((dir) => inodes(path.join(dir, 'node_modules')));
    const second = startPass();

    const secondOutcomes = trees.map((dir) => processPackageDir(second, 'wg-a', dir));

    expect(secondOutcomes).toEqual(['farm', 'farm', 'farm', 'farm', 'farm', 'converted', 'converted']);
    expect(second.counters).toEqual(expect.objectContaining({ adopted: 0, converted: 2, deferred: 0 }));
    const entry = path.join(cacheRoot, 'wg-a', keyOf(trees[0]!));
    for (const dir of trees) expectFarmOf(dir, entry);
    // The deferred trees were untouched by the first pass (their inodes moved only in the second).
    for (const [i, before] of deferredBefore.entries()) {
      expect(inodes(path.join(trees[5 + i]!, 'node_modules'))).not.toEqual(before);
    }
  });

  it('reads NODE_VERSION from the agent image once per process and fails closed without it', () => {
    mockExecFileSync.mockImplementation(() => 'PATH=/usr/local/bin\nNODE_VERSION=22.23.2\nYARN_VERSION=1.22.22\n');
    expect(agentImageFingerprint('agent:latest')).toBe(envFingerprint('22.23.2'));
    expect(agentImageFingerprint('agent:latest')).toBe(envFingerprint('22.23.2'));
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['image', 'inspect', '--format', expect.any(String), 'agent:latest'],
      expect.anything(),
    );

    _resetDependencyCacheForTesting();
    mockExecFileSync.mockImplementation(() => {
      throw new Error('No such image');
    });
    expect(agentImageFingerprint('agent:latest')).toBeNull();
    const pass = startDependencyCachePass({
      mode: 'apply',
      cacheRoot,
      now: Date.now(),
      reclaimableBytes: dirSizeBytes,
      fingerprint: () => agentImageFingerprint('agent:latest'),
    });

    // No key, so nothing is adopted, converted or linked...
    const tree = makeProject(path.join(tmpRoot, 'no-fingerprint', 'repo'));
    expect(processPackageDir(pass, 'wg-a', tree)).toBe('unkeyable');
    expect(cacheEntries('wg-a')).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'dependency-cache: environment fingerprint unavailable, skipping adopt, convert and link this pass',
      expect.anything(),
    );
    // ...but an interrupted convert's `.old` needs no key to be restored...
    const interrupted = makeProject(path.join(tmpRoot, 'no-fingerprint-old', 'repo'));
    fs.renameSync(path.join(interrupted, 'node_modules'), path.join(interrupted, FARM_OLD_NAME));
    expect(recoverPackageDir(pass, 'wg-a', interrupted)).toBe('recovered');
    expect(fs.existsSync(path.join(interrupted, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    // ...while `.new` alone is judged against the verified entry, so it waits.
    const linking = path.join(tmpRoot, 'no-fingerprint-new', 'repo');
    writeManifests(linking);
    fs.mkdirSync(path.join(linking, FARM_NEW_NAME));
    expect(recoverPackageDir(pass, 'wg-a', linking)).toBe('blocked');
    expect(fs.existsSync(path.join(linking, FARM_NEW_NAME))).toBe(true);
    expect(fs.existsSync(path.join(linking, 'node_modules'))).toBe(false);
    expect(finishDependencyCachePass(pass).fingerprintAvailable).toBe(false);

    mockExecFileSync.mockImplementation(() => 'PATH=/usr/local/bin\n');
    expect(agentImageFingerprint('agent:latest')).toBeNull();
  });
});

// ── P1-14 through the real sweep ────────────────────────────────────────────

describe('dependency cache inside the regenerable sweep', () => {
  let dataRoot: string;
  let topicsRoot: string;
  let sessionsRoot: string;
  let savedFlag: string | undefined;

  beforeEach(() => {
    _resetStorageManagerThrottleForTesting();
    savedFlag = process.env.NANOCLAW_DEPENDENCY_CACHE;
    process.env.NANOCLAW_DEPENDENCY_CACHE = 'apply';
    dataRoot = path.join(tmpRoot, 'data');
    topicsRoot = path.join(dataRoot, 'v2-topics');
    sessionsRoot = path.join(dataRoot, 'v2-sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, status TEXT, last_active TEXT, created_at TEXT NOT NULL
    )`);
    db.exec('CREATE TABLE agent_groups (id TEXT PRIMARY KEY, folder TEXT, workgroup_id TEXT)');
    db.exec('CREATE TABLE messaging_groups (id TEXT PRIMARY KEY, platform_id TEXT)');
    centralDbMock.current = { db };
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'df') {
        return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 500 500 50% /\n';
      }
      if (cmd === CONTAINER_RUNTIME_BIN && args[0] === 'image' && args[1] === 'inspect') {
        return 'PATH=/usr/local/bin\nNODE_VERSION=22.23.2\n';
      }
      throw new Error(`unexpected command ${cmd}`);
    });
  });

  afterEach(() => {
    centralDbMock.current?.db.close();
    centralDbMock.current = null;
    if (savedFlag === undefined) delete process.env.NANOCLAW_DEPENDENCY_CACHE;
    else process.env.NANOCLAW_DEPENDENCY_CACHE = savedFlag;
  });

  function makeTopic(name: string, build: (repoDir: string) => void, idleDays = 10): string {
    const topicDir = path.join(topicsRoot, 'wg-acme', name);
    const repoDir = path.join(topicDir, 'worktrees', 'REPO');
    fs.mkdirSync(repoDir, { recursive: true });
    build(repoDir);
    const stamp = (Date.now() - idleDays * DAY_MS) / 1000;
    const worktreeRoot = path.join(topicDir, 'worktrees');
    for (const entry of fs.readdirSync(worktreeRoot)) fs.utimesSync(path.join(worktreeRoot, entry), stamp, stamp);
    fs.utimesSync(worktreeRoot, stamp, stamp);
    return repoDir;
  }

  it('off still recovers interrupted conversions and garbage-collects unlinked entries', () => {
    // Unset IS `off`, the production default.
    delete process.env.NANOCLAW_DEPENDENCY_CACHE;
    let interruptedInodes = new Map<string, number>();
    const interrupted = makeTopic('thread-55555555555555555555555555555555', (repo) => {
      makeProject(repo, { privateDirs: true });
      interruptedInodes = inodes(path.join(repo, 'node_modules'), { includePrivate: true });
      // A convert that crashed after step 2 in an `apply` pass, then a rollback to `off`.
      fs.renameSync(path.join(repo, 'node_modules'), path.join(repo, FARM_OLD_NAME));
    });
    const outside = makeProject(path.join(tmpRoot, 'outside', 'repo'));
    expect(processPackageDir(startPass(), 'wg-acme', outside)).toBe('adopted');
    const agedEntry = path.join(cacheRoot, 'wg-acme', keyOf(outside));
    fs.rmSync(path.join(outside, 'node_modules'), { recursive: true });
    backdateEntry(agedEntry, 20);
    // Same lockfile as the aged entry, and fresh, so only the cache could touch it.
    const keptPrivate = makeTopic('thread-66666666666666666666666666666666', (repo) => makeProject(repo), 0);
    const privateBefore = snapshotTree(path.join(keptPrivate, 'node_modules'));

    const report = getStorageReport({
      mode: 'apply',
      now: Date.now(),
      sessionsRoot,
      threadsRoot: path.join(dataRoot, 'no-threads'),
      topicsRoot,
      runningContainerMounts: () => [],
      includeDocker: false,
      policy: { filesystemPath: tmpRoot },
    });

    expect(report.policy.dependencyCacheMode).toBe('off');
    expect(inodes(path.join(interrupted, 'node_modules'), { includePrivate: true })).toEqual(interruptedInodes);
    expect(tempNamesUnder(interrupted)).toEqual([]);
    expect(fs.existsSync(agedEntry)).toBe(false);
    expect(cacheEntries('wg-acme')).toEqual([]);
    expect(snapshotTree(path.join(keptPrivate, 'node_modules'))).toEqual(privateBefore);
    expect(report.dependencyCache?.counters).toEqual(
      expect.objectContaining({ recovered: 1, gcDeleted: 1, adopted: 0, converted: 0, privateInMountedTopics: 0 }),
    );
    // Neither recovering `.old` nor GC needs a key, so `off` never inspects the image.
    expect(
      mockExecFileSync.mock.calls.some(
        ([cmd, args]) => cmd === CONTAINER_RUNTIME_BIN && (args as string[])[0] === 'image',
      ),
    ).toBe(false);
  });

  it('npm-workspaces, pnpm, and lockfile-less projects are left to the existing sweep rule', () => {
    const workspaces = makeTopic('thread-11111111111111111111111111111111', (repo) => {
      writeManifests(repo, { pkgJson: { workspaces: ['packages/*'] } });
      installTree(repo);
    });
    const pnpm = makeTopic('thread-22222222222222222222222222222222', (repo) => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"app","version":"1.0.0"}\n');
      fs.writeFileSync(path.join(repo, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
      const store = path.join(repo, 'node_modules', '.pnpm', 'left-pad@1.3.0', 'node_modules', 'left-pad');
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, 'index.js'), 'pnpm-installed');
    });
    const lockless = makeTopic('thread-33333333333333333333333333333333', (repo) => {
      fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"app","version":"1.0.0"}\n');
      fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'ad-hoc');
    });
    // A control that IS eligible, so the flag is provably live in this pass.
    const npm = makeTopic('thread-44444444444444444444444444444444', (repo) => makeProject(repo));

    for (const dir of [workspaces, pnpm, lockless]) {
      expect(isEligiblePackageDir(dir)).toBe(false);
      expect(processPackageDir(startPass('report'), 'wg-acme', dir)).toBe('ineligible');
    }
    vi.mocked(log.info).mockClear();

    const report = getStorageReport({
      mode: 'apply',
      now: Date.now(),
      sessionsRoot,
      threadsRoot: path.join(dataRoot, 'no-threads'),
      topicsRoot,
      runningContainerMounts: () => [],
      includeDocker: false,
      policy: { filesystemPath: tmpRoot },
    });

    // The existing 2-day rule, unchanged: lockfile-backed trees go, a tree with
    // no recorded reproducer stays.
    expect(fs.existsSync(path.join(workspaces, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(pnpm, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(lockless, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('ad-hoc');
    expect(report.skipped.noManifestTrees).toBe(1);

    // Adopt/convert touched only the eligible control, which is kept as a farm.
    expect(report.dependencyCache?.counters).toEqual(expect.objectContaining({ adopted: 1, converted: 0 }));
    const entries = fs.readdirSync(path.join(dataRoot, 'dependency-cache', 'wg-acme'));
    // The sweep's fingerprint is the production default: the inspected image on this arch.
    expect(entries).toEqual([dependencyKey(npm, envFingerprint('22.23.2'))!.key]);
    const sealed = JSON.parse(
      fs.readFileSync(path.join(dataRoot, 'dependency-cache', 'wg-acme', entries[0]!, 'SEALED'), 'utf8'),
    ) as { source: string };
    expect(sealed.source).toBe(npm);
    expect(fs.existsSync(path.join(npm, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(report.actions.map((action) => action.path).sort()).toEqual(
      [path.join(workspaces, 'node_modules'), path.join(pnpm, 'node_modules')].sort(),
    );
  });
});
