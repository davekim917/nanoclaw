/**
 * Host-side npm dependency cache: one sealed, read-only copy of `node_modules`
 * per lockfile per workgroup, hardlinked into each workspace (a "farm").
 *
 * Normative spec: docs/specs/repository-branch-clones/plan.md §5.7. This module
 * is the ONE owner of verify, adopt, convert, link, seal and recovery (§3
 * invariant table). The storage sweep decides WHEN (storage-manager.ts,
 * `collectTopicRegenerableActions`) and never re-derives any of it.
 *
 * Layout: `<cacheRoot>/<workgroup>/<key>/{node_modules/, SEALED}`. The cache
 * root is a sibling of `v2-topics` under the same data dir, so every link is on
 * one filesystem and one mount (`link(2)` returns EXDEV across mounts, §4.6).
 *
 * Trust: agents share the host uid, so read-only bits are proof against
 * accidents, not a security boundary (§5.7.6). Verified completeness and the
 * inventory check catch incomplete or modified trees, not deliberate tampering
 * before adoption (§10).
 *
 * Every operation takes a pass. A `report` pass decides and logs exactly what
 * an `apply` pass would do, and mutates nothing.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

export const DEPENDENCY_CACHE_DIRNAME = 'dependency-cache';
/** Convert/link build target. Only ever holds farm links, never private bytes. */
export const FARM_NEW_NAME = '.node_modules.nanoclaw-new';
/** Where a private tree waits while its private root dot entries move out. */
export const FARM_OLD_NAME = '.node_modules.nanoclaw-old';
/**
 * The two temp names a package dir can hold mid-operation. The regenerable
 * sweep must never descend into them (they hold private bytes mid-convert) and
 * hands every package dir holding one to `recoverPackageDir` first.
 */
export const DEPENDENCY_CACHE_TEMP_NAMES: readonly string[] = [FARM_NEW_NAME, FARM_OLD_NAME];

export type DependencyCacheMode = 'off' | 'report' | 'apply';

const NODE_MODULES = 'node_modules';
const HIDDEN_LOCKFILE = '.package-lock.json';
/** Root dot entries that ARE shared; every other root dot entry is workspace-private. */
const SHARED_ROOT_DOT_NAMES = new Set(['.bin', HIDDEN_LOCKFILE]);
const SEALED_FILE = 'SEALED';
const ENTRY_TMP_SUFFIX = '.tmp';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const QUARANTINED_PATTERN = /^([0-9a-f]{64})\.quarantined-(\d+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY_GC_AGE_MS = 14 * DAY_MS;
const QUARANTINE_GC_AGE_MS = 7 * DAY_MS;
// GC ages entries in days, so `lastLinkedAt` needs no finer grain than this.
// Rewriting SEALED (which carries the whole inventory) on every link of a busy
// key would be pure write amplification.
const LAST_LINKED_REFRESH_MS = 60 * 60 * 1000;
/**
 * Adopts plus converts per pass. Each one is a full entry verify and a
 * hardlink copy of a tree that can hold 56k files (§4.6), on the host that
 * serves the fleet; the rest wait for the next hourly pass. Recovery,
 * verification and GC are not capped.
 */
export const DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS = 5;

// ── Environment fingerprint ─────────────────────────────────────────────────

const fingerprintByImage = new Map<string, string>();

export function envFingerprint(nodeVersion: string, arch: string = process.arch): string {
  return `node=${nodeVersion};platform=linux;arch=${arch}`;
}

/**
 * The agent image's `NODE_VERSION` plus `linux` and `process.arch` (§5.7.2),
 * memoized per process on success. `null` when the image cannot be inspected
 * or declares no NODE_VERSION: callers then skip cache operations for the pass
 * rather than guess, and a failure is retried next pass.
 */
export function agentImageFingerprint(image: string = CONTAINER_IMAGE): string | null {
  const memo = fingerprintByImage.get(image);
  if (memo) return memo;
  let output: string;
  try {
    output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['image', 'inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', image],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
  } catch (err) {
    log.warn('dependency-cache: agent image inspect failed', { image, err: errorMessage(err) });
    return null;
  }
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('NODE_VERSION='));
  const version = line?.slice('NODE_VERSION='.length).trim();
  if (!version) {
    log.warn('dependency-cache: agent image declares no NODE_VERSION', { image });
    return null;
  }
  const fingerprint = envFingerprint(version);
  fingerprintByImage.set(image, fingerprint);
  return fingerprint;
}

export function _resetDependencyCacheForTesting(): void {
  fingerprintByImage.clear();
}

// ── Eligibility and key ─────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonObject(file: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * §5.7.1: `package.json` without a `workspaces` field, and a `package-lock.json`
 * with `lockfileVersion` >= 2. Everything else (pnpm, yarn, bun, npm
 * workspaces, lockfile-less) keeps the existing sweep rule untouched.
 */
export function isEligiblePackageDir(pkgDir: string): boolean {
  const manifest = readJsonObject(path.join(pkgDir, 'package.json'));
  if (!manifest || Object.prototype.hasOwnProperty.call(manifest, 'workspaces')) return false;
  const lock = readJsonObject(path.join(pkgDir, 'package-lock.json'));
  return typeof lock?.lockfileVersion === 'number' && lock.lockfileVersion >= 2;
}

export interface KeyInputs {
  packageLockSha256: string;
  packageJsonSha256: string;
  npmrcSha256: string;
  fingerprint: string;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * §5.7.2: sha256 over package-lock bytes, package.json bytes, the package dir's
 * `.npmrc` bytes (empty when absent) and the environment fingerprint. Each
 * input is length-framed so no two input tuples can hash alike. `null` when an
 * input cannot be read.
 */
export function dependencyKey(pkgDir: string, fingerprint: string): { key: string; inputs: KeyInputs } | null {
  let lock: Buffer;
  let manifest: Buffer;
  let npmrc: Buffer;
  try {
    lock = fs.readFileSync(path.join(pkgDir, 'package-lock.json'));
    manifest = fs.readFileSync(path.join(pkgDir, 'package.json'));
  } catch {
    return null;
  }
  try {
    npmrc = fs.readFileSync(path.join(pkgDir, '.npmrc'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    npmrc = Buffer.alloc(0);
  }
  const hash = createHash('sha256');
  for (const [label, bytes] of [
    ['package-lock.json', lock],
    ['package.json', manifest],
    ['.npmrc', npmrc],
    ['fingerprint', Buffer.from(fingerprint, 'utf8')],
  ] as const) {
    hash.update(`${label}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return {
    key: hash.digest('hex'),
    inputs: {
      packageLockSha256: sha256(lock),
      packageJsonSha256: sha256(manifest),
      npmrcSha256: sha256(npmrc),
      fingerprint,
    },
  };
}

// ── Tree walk and inventory ─────────────────────────────────────────────────

export type InventoryItem = [relativePath: string, type: 'f' | 'l', size: number];

export interface Inventory {
  items: InventoryItem[];
  sha256: string;
}

interface TreeFile {
  rel: string;
  type: 'f' | 'l';
  stat: fs.Stats;
}

interface TreeWalk {
  files: TreeFile[];
  /** First path that is neither a directory, a regular file nor a symlink. */
  unsupported: string | null;
}

/** `.vite`, `.cache` and the like: never shared, excluded from every check. */
function isPrivateRootName(name: string): boolean {
  return name.startsWith('.') && !SHARED_ROOT_DOT_NAMES.has(name);
}

function isRealDir(target: string): boolean {
  try {
    const st = fs.lstatSync(target);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

/**
 * Every regular file and symlink under `root`, sorted by relative path, with
 * private root dot entries skipped. Never follows a symlink. `null` when any
 * part of the tree cannot be read.
 */
function walkTree(root: string): TreeWalk | null {
  const files: TreeFile[] = [];
  let unsupported: string | null = null;
  const stack: Array<[string, string]> = [[root, '']];
  while (stack.length > 0) {
    const [dir, rel] = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (rel === '' && isPrivateRootName(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const full = path.join(dir, name);
      const st = lstatOrNull(full);
      if (!st) return null;
      if (st.isDirectory()) stack.push([full, childRel]);
      else if (st.isFile()) files.push({ rel: childRel, type: 'f', stat: st });
      else if (st.isSymbolicLink()) files.push({ rel: childRel, type: 'l', stat: st });
      else unsupported ??= childRel;
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, unsupported };
}

function inventoryFromWalk(walk: TreeWalk): Inventory {
  const items: InventoryItem[] = walk.files.map((file) => [file.rel, file.type, file.stat.size]);
  return { items, sha256: sha256(JSON.stringify(items)) };
}

/** §5.7.3 inventory of a `node_modules` dir, or `null` when unreadable. */
export function inventoryOf(nodeModulesDir: string): Inventory | null {
  const walk = walkTree(nodeModulesDir);
  if (!walk || walk.unsupported) return null;
  return inventoryFromWalk(walk);
}

function firstInventoryDifference(expected: InventoryItem[], actual: InventoryItem[]): string {
  const length = Math.max(expected.length, actual.length);
  for (let i = 0; i < length; i++) {
    const want = expected[i];
    const got = actual[i];
    if (!want) return got![0];
    if (!got) return want[0];
    if (want[0] !== got[0]) return want[0] < got[0] ? want[0] : got[0];
    if (want[1] !== got[1] || want[2] !== got[2]) return want[0];
  }
  return NODE_MODULES;
}

// ── Verified completeness (§5.7.3, M4) ──────────────────────────────────────

export type Completeness =
  | { complete: true; walk: TreeWalk; inventory: Inventory }
  | { complete: false; reason: string };

function packagesOf(lock: JsonObject | null): JsonObject | null {
  const packages = lock?.packages;
  return isJsonObject(packages) ? packages : null;
}

function nameFromPackageKey(key: string): string {
  return key.slice(key.lastIndexOf(`${NODE_MODULES}/`) + NODE_MODULES.length + 1);
}

function isContainedPackageKey(key: string): boolean {
  return (
    key.startsWith(`${NODE_MODULES}/`) &&
    key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}

/**
 * A tree is complete when:
 *   (1) every hidden-lockfile package entry (the root excluded) is in
 *       package-lock.json with equal {version, resolved, integrity}, and every
 *       package-lock entry ABSENT from the hidden lockfile is `optional: true`;
 *   (2) every hidden-lockfile package path is a real directory whose
 *       package.json name and version match; and
 *   (3) no regular file is newer than the hidden lockfile.
 *
 * (1) deliberately does not ask WHY an optional package is absent (skipped for
 * this platform, skipped with its dependent, or failed to install). Phase 1
 * never changes a workspace's file set: adopt shares the source tree's own
 * inodes, and convert requires inventory equality with the entry, so only
 * identical installs merge and no working tree is replaced by a degraded one.
 * A platform-aware rule belongs to linking into a workspace that never
 * installed (plan Phase 2).
 */
export function checkCompleteness(pkgDir: string): Completeness {
  const nm = path.join(pkgDir, NODE_MODULES);
  const incomplete = (reason: string): Completeness => ({ complete: false, reason });
  const hiddenPath = path.join(nm, HIDDEN_LOCKFILE);
  const hiddenStat = lstatOrNull(hiddenPath);
  if (!hiddenStat?.isFile()) return incomplete('hidden lockfile missing');
  const hiddenPackages = packagesOf(readJsonObject(hiddenPath));
  const lockPackages = packagesOf(readJsonObject(path.join(pkgDir, 'package-lock.json')));
  if (!hiddenPackages || !lockPackages) return incomplete('lockfile packages unreadable');

  const hiddenKeys = Object.keys(hiddenPackages)
    .filter((key) => key !== '')
    .sort();
  const lockKeys = Object.keys(lockPackages)
    .filter((key) => key !== '')
    .sort();
  const has = (packages: JsonObject, key: string): boolean => Object.prototype.hasOwnProperty.call(packages, key);
  for (const key of lockKeys) {
    if (has(hiddenPackages, key)) continue;
    const locked = lockPackages[key];
    if (!isJsonObject(locked) || locked.optional !== true) {
      return incomplete(`non-optional package-lock entry absent from the hidden lockfile: ${key}`);
    }
  }
  for (const key of hiddenKeys) {
    if (!has(lockPackages, key)) return incomplete(`hidden lockfile package absent from package-lock.json: ${key}`);
    const hidden = hiddenPackages[key];
    const locked = lockPackages[key];
    if (!isJsonObject(hidden) || !isJsonObject(locked)) return incomplete(`unreadable package entry: ${key}`);
    for (const field of ['version', 'resolved', 'integrity'] as const) {
      if (hidden[field] !== locked[field]) return incomplete(`hidden lockfile ${field} differs: ${key}`);
    }
    if (!isContainedPackageKey(key)) return incomplete(`unsupported package path: ${key}`);
    const dir = path.join(pkgDir, key);
    if (!isRealDir(dir)) return incomplete(`package dir missing: ${key}`);
    const manifest = readJsonObject(path.join(dir, 'package.json'));
    const expectedName = typeof hidden.name === 'string' ? hidden.name : nameFromPackageKey(key);
    if (manifest?.name !== expectedName || manifest?.version !== hidden.version) {
      return incomplete(`package manifest differs from lockfile: ${key}`);
    }
  }

  const walk = walkTree(nm);
  if (!walk) return incomplete('tree unreadable');
  if (walk.unsupported) return incomplete(`unsupported file type: ${walk.unsupported}`);
  for (const file of walk.files) {
    if (file.type === 'f' && file.rel !== HIDDEN_LOCKFILE && file.stat.mtimeMs > hiddenStat.mtimeMs) {
      return incomplete(`newer than the hidden lockfile: ${file.rel}`);
    }
  }
  return { complete: true, walk, inventory: inventoryFromWalk(walk) };
}

// ── Seal and verify (§5.7.4, §5.7.6) ────────────────────────────────────────

export interface SealedRecord {
  version: 1;
  key: string;
  keyInputs: KeyInputs;
  /** Package dir the entry was adopted from. */
  source: string;
  sealedAt: string;
  /** Last time the entry was linked into a farm; GC ages from max(sealedAt, this). */
  lastLinkedAt: string;
  inventorySha256: string;
  inventory: InventoryItem[];
}

export type VerifyResult =
  | { ok: true; sealed: SealedRecord; allSingleLinked: boolean }
  | { ok: false; offendingPath: string; reason: string };

function readSealed(entryDir: string): SealedRecord | null {
  const raw = readJsonObject(path.join(entryDir, SEALED_FILE));
  if (
    !raw ||
    raw.version !== 1 ||
    typeof raw.key !== 'string' ||
    typeof raw.sealedAt !== 'string' ||
    typeof raw.lastLinkedAt !== 'string' ||
    typeof raw.inventorySha256 !== 'string' ||
    !Array.isArray(raw.inventory)
  ) {
    return null;
  }
  return raw as unknown as SealedRecord;
}

/**
 * The precondition of every link, convert and GC decision. One walk checks:
 * no write bits on any regular file, no mtime later than `sealedAt`, and an
 * inventory equal to SEALED's. A failure names the first offending path.
 */
export function verifyEntry(entryDir: string): VerifyResult {
  const fail = (offendingPath: string, reason: string): VerifyResult => ({ ok: false, offendingPath, reason });
  const sealed = readSealed(entryDir);
  if (!sealed) return fail(SEALED_FILE, 'SEALED missing or unreadable');
  if (sealed.key !== path.basename(entryDir)) return fail(SEALED_FILE, 'SEALED names a different key');
  if (sha256(JSON.stringify(sealed.inventory)) !== sealed.inventorySha256) {
    return fail(SEALED_FILE, 'SEALED inventory digest mismatch');
  }
  const sealedAtMs = Date.parse(sealed.sealedAt);
  if (!Number.isFinite(sealedAtMs)) return fail(SEALED_FILE, 'SEALED has no valid sealedAt');
  const walk = walkTree(path.join(entryDir, NODE_MODULES));
  if (!walk) return fail(NODE_MODULES, 'entry tree unreadable');
  if (walk.unsupported) return fail(walk.unsupported, 'unsupported file type');
  let allSingleLinked = true;
  for (const file of walk.files) {
    if (file.type === 'f') {
      if (file.stat.mode & 0o222) return fail(file.rel, 'writable');
      if (file.stat.nlink !== 1) allSingleLinked = false;
    }
    // Floor: file stamps carry sub-ms precision, sealedAt only ms.
    if (Math.floor(file.stat.mtimeMs) > sealedAtMs) return fail(file.rel, 'modified after seal');
  }
  const inventory = inventoryFromWalk(walk);
  if (inventory.sha256 !== sealed.inventorySha256) {
    return fail(firstInventoryDifference(sealed.inventory, inventory.items), 'inventory differs from SEALED');
  }
  return { ok: true, sealed, allSingleLinked };
}

// ── Pass ────────────────────────────────────────────────────────────────────

export interface DependencyCacheCounters {
  recovered: number;
  adopted: number;
  converted: number;
  convertMismatch: number;
  linked: number;
  quarantined: number;
  gcDeleted: number;
  /** Eligible trees left for a later pass by DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS. */
  deferred: number;
  /** Eligible, non-farm trees seen in topics a running container mounts. */
  privateInMountedTopics: number;
  privateInMountedTopicsBytes: number;
}

export interface DependencyCacheDecision {
  mode: 'report' | 'apply';
  op: string;
  path: string;
  key: string | null;
  estimatedBytes: number;
  detail?: string;
}

export interface DependencyCacheReport {
  mode: 'report' | 'apply';
  counters: DependencyCacheCounters;
  decisions: DependencyCacheDecision[];
  /** `false`: a key was needed and the agent image could not be inspected. `null`: no key was needed. */
  fingerprintAvailable: boolean | null;
}

export interface DependencyCachePass {
  readonly mode: 'report' | 'apply';
  readonly cacheRoot: string;
  /** Pass clock for GC ages. Seals use the wall clock: they are compared with file mtimes. */
  readonly now: number;
  /**
   * The environment fingerprint, resolved on first use so a pass that only
   * recovers or collects garbage never inspects the image. `null` means this
   * pass cannot compute a key: adopt, convert and link are skipped.
   */
  readonly fingerprint: () => string | null;
  readonly fingerprintState: { resolved: boolean; value: string | null };
  readonly counters: DependencyCacheCounters;
  readonly decisions: DependencyCacheDecision[];
  /** Reclaimable bytes of a dir — `dirSizeBytes`, the §5.8 primitive, injected to avoid an import cycle. */
  readonly reclaimableBytes: (dir: string) => number;
  /** Farm decisions verify each entry at most once per pass; link, convert and GC re-verify. */
  readonly verified: Map<string, VerifyResult>;
  readonly quarantinedThisPass: Set<string>;
  /** Adopts plus converts started this pass, against DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS. */
  mutations: number;
}

export function startDependencyCachePass(options: {
  mode: 'report' | 'apply';
  cacheRoot: string;
  now: number;
  reclaimableBytes: (dir: string) => number;
  fingerprint?: () => string | null;
}): DependencyCachePass {
  const source = options.fingerprint ?? (() => agentImageFingerprint());
  const fingerprintState: { resolved: boolean; value: string | null } = { resolved: false, value: null };
  const fingerprint = (): string | null => {
    if (!fingerprintState.resolved) {
      fingerprintState.resolved = true;
      fingerprintState.value = source();
      if (!fingerprintState.value) {
        log.warn('dependency-cache: environment fingerprint unavailable, skipping adopt, convert and link this pass', {
          cacheRoot: options.cacheRoot,
        });
      }
    }
    return fingerprintState.value;
  };
  return {
    mode: options.mode,
    cacheRoot: options.cacheRoot,
    now: options.now,
    fingerprint,
    fingerprintState,
    reclaimableBytes: options.reclaimableBytes,
    counters: {
      recovered: 0,
      adopted: 0,
      converted: 0,
      convertMismatch: 0,
      linked: 0,
      quarantined: 0,
      gcDeleted: 0,
      deferred: 0,
      privateInMountedTopics: 0,
      privateInMountedTopicsBytes: 0,
    },
    decisions: [],
    verified: new Map(),
    quarantinedThisPass: new Set(),
    mutations: 0,
  };
}

export function finishDependencyCachePass(pass: DependencyCachePass): DependencyCacheReport {
  const fingerprintAvailable = pass.fingerprintState.resolved ? pass.fingerprintState.value !== null : null;
  log.info('dependency-cache: pass complete', {
    mode: pass.mode,
    ...pass.counters,
    decisions: pass.decisions.length,
    fingerprintAvailable,
  });
  return { mode: pass.mode, counters: { ...pass.counters }, decisions: [...pass.decisions], fingerprintAvailable };
}

function decide(
  pass: DependencyCachePass,
  op: string,
  target: string,
  extra: { key?: string; estimatedBytes?: number; detail?: string } = {},
): void {
  const record: DependencyCacheDecision = {
    mode: pass.mode,
    op,
    path: target,
    key: extra.key ?? null,
    estimatedBytes: extra.estimatedBytes ?? 0,
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
  pass.decisions.push(record);
  log.info('dependency-cache: decision', { ...record });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workgroupDir(pass: DependencyCachePass, workgroupId: string): string {
  if (!workgroupId || workgroupId === '.' || workgroupId === '..' || /[/\\\0]/.test(workgroupId)) {
    throw new Error(`dependency-cache: invalid workgroup id ${JSON.stringify(workgroupId)}`);
  }
  return path.join(pass.cacheRoot, workgroupId);
}

function verifyOnce(pass: DependencyCachePass, entryDir: string): VerifyResult {
  const memo = pass.verified.get(entryDir);
  if (memo) return memo;
  const result = verifyEntry(entryDir);
  pass.verified.set(entryDir, result);
  return result;
}

function verifyFresh(pass: DependencyCachePass, entryDir: string): VerifyResult {
  const result = verifyEntry(entryDir);
  pass.verified.set(entryDir, result);
  return result;
}

/**
 * §5.7.6: rename to `<key>.quarantined-<ts>` with a WARN naming the first
 * offending path. A quarantined entry is never linked again; the next complete
 * private tree for the key re-adopts.
 */
function quarantineEntry(
  pass: DependencyCachePass,
  entryDir: string,
  failure: { offendingPath: string; reason: string },
): void {
  if (pass.quarantinedThisPass.has(entryDir)) return;
  pass.quarantinedThisPass.add(entryDir);
  pass.counters.quarantined += 1;
  const detail = `${failure.reason}: ${failure.offendingPath}`;
  decide(pass, 'quarantine', entryDir, { key: path.basename(entryDir), detail });
  if (pass.mode === 'report') {
    log.warn('dependency-cache: would quarantine entry', { entry: entryDir, ...failure });
    return;
  }
  const quarantinedAs = `${entryDir}.quarantined-${Date.now()}`;
  try {
    fs.renameSync(entryDir, quarantinedAs);
  } catch (err) {
    // Still never linked: every link and convert re-verifies, and fails again.
    log.warn('dependency-cache: quarantine rename failed', { entry: entryDir, ...failure, err: errorMessage(err) });
    return;
  }
  log.warn('dependency-cache: quarantined entry', { entry: entryDir, quarantinedAs, ...failure });
}

function quarantinedDirsFor(pass: DependencyCachePass, workgroupId: string, key: string): string[] {
  const wgDir = workgroupDir(pass, workgroupId);
  let names: string[];
  try {
    names = fs.readdirSync(wgDir);
  } catch {
    return [];
  }
  return names.filter((name) => name.startsWith(`${key}.quarantined-`)).map((name) => path.join(wgDir, name));
}

function warnNoEntry(pass: DependencyCachePass, workgroupId: string, key: string, pkgDir: string): void {
  log.warn('dependency-cache: no verified entry for key', {
    path: pkgDir,
    key,
    quarantined: quarantinedDirsFor(pass, workgroupId, key).length > 0,
  });
}

/** "Already a farm": the hidden lockfile — the one file every complete tree has — is the entry's inode. */
function sharesHiddenLockfile(nodeModulesDir: string, entryDir: string): boolean {
  const mine = lstatOrNull(path.join(nodeModulesDir, HIDDEN_LOCKFILE));
  const theirs = lstatOrNull(path.join(entryDir, NODE_MODULES, HIDDEN_LOCKFILE));
  return Boolean(mine && theirs && mine.isFile() && mine.dev === theirs.dev && mine.ino === theirs.ino);
}

function hasTempNames(pkgDir: string): boolean {
  return DEPENDENCY_CACHE_TEMP_NAMES.some((name) => lstatOrNull(path.join(pkgDir, name)) !== null);
}

function privateRootNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => isPrivateRootName(name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Our own renames add and remove entries in the package dir, which moves its
 * mtime — and a checkout's mtime is part of the sweep's idle signal
 * (`worktreeContentMtimeMs` in storage-manager.ts). Put it back, so the cache
 * never reads as agent activity.
 */
function withPackageDirTimesPreserved<T>(pkgDir: string, fn: () => T): T {
  const before = lstatOrNull(pkgDir);
  try {
    return fn();
  } finally {
    if (before) {
      try {
        fs.utimesSync(pkgDir, before.atimeMs / 1000, before.mtimeMs / 1000);
      } catch {
        // Best effort: a moved idle clock only delays a sweep.
      }
    }
  }
}

/**
 * `cp -al` semantics: recreate the directory structure, hardlink every regular
 * file, recreate every symlink as a symlink (never followed), and skip private
 * root dot entries. `dst` must not exist. On any failure the partial `dst` —
 * links and our own dirs only — is removed and the error rethrown, so EPERM or
 * EXDEV leaves the source exactly as it was.
 */
function linkTree(src: string, dst: string): void {
  fs.mkdirSync(dst);
  try {
    const stack: Array<[string, string, boolean]> = [[src, dst, true]];
    while (stack.length > 0) {
      const [from, to, atRoot] = stack.pop()!;
      for (const name of fs.readdirSync(from)) {
        if (atRoot && isPrivateRootName(name)) continue;
        const source = path.join(from, name);
        const target = path.join(to, name);
        const st = fs.lstatSync(source);
        if (st.isDirectory()) {
          fs.mkdirSync(target, { mode: (st.mode & 0o7777) | 0o700 });
          stack.push([source, target, false]);
        } else if (st.isFile()) {
          fs.linkSync(source, target);
        } else if (st.isSymbolicLink()) {
          fs.symlinkSync(fs.readlinkSync(source), target);
        } else {
          throw new Error(`unsupported file type: ${source}`);
        }
      }
    }
  } catch (err) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw err;
  }
}

function warnLinkFailure(op: string, pkgDir: string, err: unknown): void {
  log.warn('dependency-cache: link failed', {
    op,
    path: pkgDir,
    code: (err as NodeJS.ErrnoException).code ?? null,
    err: errorMessage(err),
  });
}

function touchLastLinked(pass: DependencyCachePass, entryDir: string, sealed: SealedRecord): void {
  const last = Date.parse(sealed.lastLinkedAt);
  if (Number.isFinite(last) && pass.now - last < LAST_LINKED_REFRESH_MS) return;
  const updated: SealedRecord = { ...sealed, lastLinkedAt: new Date(pass.now).toISOString() };
  const tmp = path.join(entryDir, `${SEALED_FILE}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(updated));
    fs.chmodSync(tmp, 0o444);
    fs.renameSync(tmp, path.join(entryDir, SEALED_FILE));
  } catch (err) {
    log.warn('dependency-cache: could not record lastLinkedAt', { entry: entryDir, err: errorMessage(err) });
  }
}

/** Bytes a convert frees: the private tree's, less the private dot entries that stay. */
function convertReclaimBytes(pass: DependencyCachePass, nodeModulesDir: string): number {
  const privateBytes = privateRootNames(nodeModulesDir).reduce(
    (sum, name) => sum + pass.reclaimableBytes(path.join(nodeModulesDir, name)),
    0,
  );
  return Math.max(0, pass.reclaimableBytes(nodeModulesDir) - privateBytes);
}

/**
 * Convert step 4, and recovery's completion of it: move each private root dot
 * entry from `.old` into `node_modules`, one rename each. A name already in
 * `node_modules` stops the move and keeps `.old`.
 */
function movePrivateEntries(
  oldDir: string,
  nodeModulesDir: string,
  onMoved?: (name: string) => void,
): 'moved' | 'blocked' {
  for (const name of privateRootNames(oldDir)) {
    if (lstatOrNull(path.join(nodeModulesDir, name))) {
      log.warn('dependency-cache: private entry name already in node_modules, keeping the old tree', {
        oldDir,
        name,
      });
      return 'blocked';
    }
    fs.renameSync(path.join(oldDir, name), path.join(nodeModulesDir, name));
    onMoved?.(name);
  }
  return 'moved';
}

// ── Operations ──────────────────────────────────────────────────────────────

export type PackageOutcome =
  | 'ineligible'
  | 'no-tree'
  | 'unkeyable'
  | 'farm'
  | 'incomplete'
  | 'adopted'
  | 'converted'
  | 'convert-mismatch'
  | 'quarantined'
  | 'no-entry'
  | 'deferred'
  | 'failed';

export type LinkOutcome = 'linked' | 'exists' | 'ineligible' | 'unkeyable' | 'no-entry' | 'quarantined' | 'failed';

export type RecoveryOutcome = 'clean' | 'recovered' | 'blocked' | 'failed';

export type ConvertStep = 'link-new' | 'rename-old' | 'rename-new' | `move-private:${string}` | 'delete-old';

export interface ConvertHooks {
  /** Test seam: called after each convert step. A throw simulates a crash there. */
  onStep?: (step: ConvertStep) => void;
}

interface PreparedPackage {
  pkgDir: string;
  nodeModulesDir: string;
  key: string;
  inputs: KeyInputs;
  entryDir: string;
}

function preparePackage(
  pass: DependencyCachePass,
  workgroupId: string,
  pkgDir: string,
): PreparedPackage | 'ineligible' | 'unkeyable' {
  if (!isEligiblePackageDir(pkgDir)) return 'ineligible';
  const fingerprint = pass.fingerprint();
  if (!fingerprint) return 'unkeyable';
  const keyed = dependencyKey(pkgDir, fingerprint);
  if (!keyed) return 'unkeyable';
  return {
    pkgDir,
    nodeModulesDir: path.join(pkgDir, NODE_MODULES),
    key: keyed.key,
    inputs: keyed.inputs,
    entryDir: path.join(workgroupDir(pass, workgroupId), keyed.key),
  };
}

/**
 * Claim one of the pass's adopt/convert slots. Past the cap the tree is
 * deferred: left exactly as it is, and the existing sweep rule applies to it.
 * A report pass counts its decisions the same way, so it predicts apply.
 */
function takeMutation(pass: DependencyCachePass, pkg: PreparedPackage): boolean {
  if (pass.mutations >= DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS) {
    pass.counters.deferred += 1;
    decide(pass, 'deferred', pkg.pkgDir, {
      key: pkg.key,
      detail: `per-pass cap of ${DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS} reached`,
    });
    return false;
  }
  pass.mutations += 1;
  return true;
}

/**
 * Adopt (§5.7.4): link the tree into `<key>.tmp/node_modules` (private dot
 * entries skipped), `chmod a-w` every regular file, write SEALED, rename to
 * `<key>`. The source keeps every byte; its files become the entry's inodes,
 * so it is the entry's first farm.
 */
function adopt(
  pass: DependencyCachePass,
  pkg: PreparedPackage,
  completeness: { walk: TreeWalk; inventory: Inventory },
): PackageOutcome {
  if (!takeMutation(pass, pkg)) return 'deferred';
  decide(pass, 'adopt', pkg.pkgDir, { key: pkg.key });
  if (pass.mode === 'report') {
    pass.counters.adopted += 1;
    return 'adopted';
  }
  const nowMs = Date.now();
  const future = completeness.walk.files.find((file) => Math.floor(file.stat.mtimeMs) > nowMs);
  if (future) {
    // Sealing it would fail verification at once and churn quarantines.
    log.warn('dependency-cache: adopt refused, tree holds a file dated in the future', {
      path: pkg.pkgDir,
      file: future.rel,
    });
    return 'failed';
  }
  const tmpDir = `${pkg.entryDir}${ENTRY_TMP_SUFFIX}`;
  const tmpNm = path.join(tmpDir, NODE_MODULES);
  try {
    fs.mkdirSync(path.dirname(pkg.entryDir), { recursive: true });
    // A stale half-built entry holds links only.
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir);
  } catch (err) {
    log.warn('dependency-cache: adopt could not prepare the entry', { path: pkg.pkgDir, err: errorMessage(err) });
    return 'failed';
  }
  try {
    linkTree(pkg.nodeModulesDir, tmpNm);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    warnLinkFailure('adopt', pkg.pkgDir, err);
    return 'failed';
  }
  try {
    const linked = walkTree(tmpNm);
    const inventory = linked && !linked.unsupported ? inventoryFromWalk(linked) : null;
    if (!linked || inventory?.sha256 !== completeness.inventory.sha256) {
      throw new Error('tree changed between the completeness check and the link');
    }
    for (const file of linked.files) {
      if (file.type === 'f') fs.chmodSync(path.join(tmpNm, file.rel), file.stat.mode & 0o7555);
    }
    const sealedAt = new Date().toISOString();
    const sealed: SealedRecord = {
      version: 1,
      key: pkg.key,
      keyInputs: pkg.inputs,
      source: pkg.pkgDir,
      sealedAt,
      lastLinkedAt: sealedAt,
      inventorySha256: inventory.sha256,
      inventory: inventory.items,
    };
    fs.writeFileSync(path.join(tmpDir, SEALED_FILE), JSON.stringify(sealed));
    fs.chmodSync(path.join(tmpDir, SEALED_FILE), 0o444);
    fs.renameSync(tmpDir, pkg.entryDir);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    log.warn('dependency-cache: adopt aborted', { path: pkg.pkgDir, key: pkg.key, err: errorMessage(err) });
    return 'failed';
  }
  pass.verified.delete(pkg.entryDir);
  pass.counters.adopted += 1;
  log.info('dependency-cache: adopted', { path: pkg.pkgDir, key: pkg.key, files: completeness.inventory.items.length });
  return 'adopted';
}

/**
 * Convert (§5.7.4, M3), after the entry was verified and the private tree
 * proven complete. Order is load-bearing: `.new` only ever holds farm links,
 * and private bytes move only after `.new` is in place, so every interruption
 * point is finished or reversed by `recoverPackageDir`.
 */
function convertVerified(
  pass: DependencyCachePass,
  pkg: PreparedPackage,
  sealed: SealedRecord,
  inventory: Inventory,
  hooks: ConvertHooks = {},
): PackageOutcome {
  if (inventory.sha256 !== sealed.inventorySha256) {
    const firstDifference = firstInventoryDifference(sealed.inventory, inventory.items);
    pass.counters.convertMismatch += 1;
    decide(pass, 'convert-mismatch', pkg.pkgDir, { key: pkg.key, detail: firstDifference });
    log.warn('dependency-cache: convert mismatch', {
      mode: pass.mode,
      path: pkg.pkgDir,
      key: pkg.key,
      firstDifference,
    });
    return 'convert-mismatch';
  }
  if (!takeMutation(pass, pkg)) return 'deferred';
  decide(pass, 'convert', pkg.pkgDir, { key: pkg.key, estimatedBytes: convertReclaimBytes(pass, pkg.nodeModulesDir) });
  if (pass.mode === 'report') {
    pass.counters.converted += 1;
    return 'converted';
  }
  if (hasTempNames(pkg.pkgDir)) {
    log.warn('dependency-cache: convert skipped, an interrupted operation is still pending', { path: pkg.pkgDir });
    return 'failed';
  }
  const newDir = path.join(pkg.pkgDir, FARM_NEW_NAME);
  const oldDir = path.join(pkg.pkgDir, FARM_OLD_NAME);
  const step = (name: ConvertStep): void => hooks.onStep?.(name);
  const result = withPackageDirTimesPreserved(pkg.pkgDir, (): PackageOutcome => {
    try {
      linkTree(path.join(pkg.entryDir, NODE_MODULES), newDir);
    } catch (err) {
      warnLinkFailure('convert', pkg.pkgDir, err);
      return 'failed';
    }
    try {
      step('link-new');
      fs.renameSync(pkg.nodeModulesDir, oldDir);
      step('rename-old');
      fs.renameSync(newDir, pkg.nodeModulesDir);
      step('rename-new');
      if (movePrivateEntries(oldDir, pkg.nodeModulesDir, (name) => step(`move-private:${name}`)) === 'blocked') {
        return 'failed';
      }
      fs.rmSync(oldDir, { recursive: true, force: true });
      step('delete-old');
    } catch (err) {
      log.warn('dependency-cache: convert interrupted, recovery finishes or reverses it next pass', {
        path: pkg.pkgDir,
        err: errorMessage(err),
      });
      return 'failed';
    }
    return 'converted';
  });
  if (result !== 'converted') return result;
  touchLastLinked(pass, pkg.entryDir, sealed);
  pass.counters.converted += 1;
  return 'converted';
}

/**
 * Convert a complete private tree into a farm of its key's verified entry.
 * With no verified entry for the key this is a no-op with a WARN; adoption is
 * `processPackageDir`'s job.
 */
export function convertPackageDir(
  pass: DependencyCachePass,
  workgroupId: string,
  pkgDir: string,
  hooks: ConvertHooks = {},
): PackageOutcome {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string') return pkg;
  if (!isRealDir(pkg.nodeModulesDir)) return 'no-tree';
  if (!isRealDir(pkg.entryDir)) {
    warnNoEntry(pass, workgroupId, pkg.key, pkgDir);
    return 'no-entry';
  }
  const verified = verifyFresh(pass, pkg.entryDir);
  if (!verified.ok) {
    quarantineEntry(pass, pkg.entryDir, verified);
    return 'quarantined';
  }
  if (sharesHiddenLockfile(pkg.nodeModulesDir, pkg.entryDir)) return 'farm';
  const completeness = checkCompleteness(pkgDir);
  if (!completeness.complete) {
    decide(pass, 'incomplete', pkgDir, { key: pkg.key, detail: completeness.reason });
    return 'incomplete';
  }
  return convertVerified(pass, pkg, verified.sealed, completeness.inventory, hooks);
}

/**
 * The sweep's per-package decision: an eligible tree that is not already a
 * farm is converted when its key has a verified entry, and adopted when it has
 * none. A tree sharing inodes with a quarantined entry is left private (the
 * existing 2-day rule then applies to it); it is never re-sealed.
 */
export function processPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): PackageOutcome {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string') return pkg;
  if (!isRealDir(pkg.nodeModulesDir)) return 'no-tree';
  if (hasTempNames(pkgDir)) return 'failed';

  if (isRealDir(pkg.entryDir)) {
    const verified = verifyOnce(pass, pkg.entryDir);
    if (!verified.ok) {
      quarantineEntry(pass, pkg.entryDir, verified);
      return 'quarantined';
    }
    if (sharesHiddenLockfile(pkg.nodeModulesDir, pkg.entryDir)) return 'farm';
  } else if (
    quarantinedDirsFor(pass, workgroupId, pkg.key).some((dir) => sharesHiddenLockfile(pkg.nodeModulesDir, dir))
  ) {
    return 'quarantined';
  }

  const completeness = checkCompleteness(pkgDir);
  if (!completeness.complete) {
    decide(pass, 'incomplete', pkgDir, { key: pkg.key, detail: completeness.reason });
    return 'incomplete';
  }
  if (isRealDir(pkg.entryDir)) {
    const verified = verifyFresh(pass, pkg.entryDir);
    if (!verified.ok) {
      quarantineEntry(pass, pkg.entryDir, verified);
      return 'quarantined';
    }
    return convertVerified(pass, pkg, verified.sealed, completeness.inventory);
  }
  return adopt(pass, pkg, completeness);
}

/**
 * Link (§5.7.4): a package dir with no `node_modules` whose key has a verified
 * entry gets a farm, built as `.new` and renamed into place.
 */
export function linkPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): LinkOutcome {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string') return pkg;
  if (lstatOrNull(pkg.nodeModulesDir)) return 'exists';
  if (hasTempNames(pkgDir)) {
    log.warn('dependency-cache: link skipped, an interrupted operation is still pending', { path: pkgDir });
    return 'failed';
  }
  if (!isRealDir(pkg.entryDir)) {
    warnNoEntry(pass, workgroupId, pkg.key, pkgDir);
    return 'no-entry';
  }
  const verified = verifyFresh(pass, pkg.entryDir);
  if (!verified.ok) {
    quarantineEntry(pass, pkg.entryDir, verified);
    return 'quarantined';
  }
  decide(pass, 'link', pkgDir, { key: pkg.key });
  if (pass.mode === 'report') {
    pass.counters.linked += 1;
    return 'linked';
  }
  const newDir = path.join(pkgDir, FARM_NEW_NAME);
  const result = withPackageDirTimesPreserved(pkgDir, (): LinkOutcome => {
    try {
      linkTree(path.join(pkg.entryDir, NODE_MODULES), newDir);
      fs.renameSync(newDir, pkg.nodeModulesDir);
    } catch (err) {
      fs.rmSync(newDir, { recursive: true, force: true });
      warnLinkFailure('link', pkgDir, err);
      return 'failed';
    }
    return 'linked';
  });
  if (result !== 'linked') return result;
  touchLastLinked(pass, pkg.entryDir, verified.sealed);
  pass.counters.linked += 1;
  return 'linked';
}

/**
 * True when `.new` is a complete farm of the key's verified entry — the only
 * case in which renaming it into place finishes an interrupted link.
 */
function newDirIsCompleteFarm(pass: DependencyCachePass, workgroupId: string, pkgDir: string): boolean {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string' || !isRealDir(pkg.entryDir)) return false;
  const verified = verifyFresh(pass, pkg.entryDir);
  if (!verified.ok) {
    quarantineEntry(pass, pkg.entryDir, verified);
    return false;
  }
  return inventoryOf(path.join(pkgDir, FARM_NEW_NAME))?.sha256 === verified.sealed.inventorySha256;
}

function plannedRecoveryStep(hasNm: boolean, hasOld: boolean, hasNew: boolean): string {
  if (!hasNm && hasOld) return 'restore the old tree as node_modules';
  if (hasNm && hasOld) return 'move private entries out of the old tree, then delete it';
  if (hasNm && hasNew) return 'delete the farm build dir';
  return 'rename the farm build dir into place when complete, else delete it';
}

/**
 * Recovery (§5.7.4), run first on every pass for every package dir holding a
 * temp name. Idempotent, and every branch either finishes or reverses the
 * interrupted operation:
 *   - `node_modules` missing, `.old` present: rename `.old` back (private
 *     entries have not moved yet, because step 4 runs only after step 3);
 *   - both present: finish steps 4 and 5; a private name already in
 *     `node_modules` keeps `.old` and stops, with a WARN;
 *   - `.new` and `node_modules` present: delete `.new` (farm links only);
 *   - `.new` alone: rename it into place when it is a complete farm of the
 *     verified entry, else delete it (an interrupted link had no tree before).
 *     Judging that needs the key, so with no environment fingerprint this one
 *     case waits, with a WARN, for a pass that has one.
 */
export function recoverPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): RecoveryOutcome {
  const nm = path.join(pkgDir, NODE_MODULES);
  const oldDir = path.join(pkgDir, FARM_OLD_NAME);
  const newDir = path.join(pkgDir, FARM_NEW_NAME);
  const state = (): [boolean, boolean, boolean] => [isRealDir(nm), isRealDir(oldDir), isRealDir(newDir)];
  const [hasNm0, hasOld0, hasNew0] = state();
  if (!hasOld0 && !hasNew0) return 'clean';

  if (pass.mode === 'report') {
    pass.counters.recovered += 1;
    decide(pass, 'recover', pkgDir, { detail: plannedRecoveryStep(hasNm0, hasOld0, hasNew0) });
    return 'recovered';
  }

  const steps: string[] = [];
  const outcome = withPackageDirTimesPreserved(pkgDir, (): RecoveryOutcome => {
    try {
      for (let round = 0; round < 4; round++) {
        const [hasNm, hasOld, hasNew] = state();
        if (!hasOld && !hasNew) return 'recovered';
        steps.push(plannedRecoveryStep(hasNm, hasOld, hasNew));
        if (!hasNm && hasOld) {
          fs.renameSync(oldDir, nm);
        } else if (hasNm && hasOld) {
          if (movePrivateEntries(oldDir, nm) === 'blocked') return 'blocked';
          fs.rmSync(oldDir, { recursive: true, force: true });
        } else if (hasNm && hasNew) {
          fs.rmSync(newDir, { recursive: true, force: true });
        } else if (pass.fingerprint() === null) {
          log.warn('dependency-cache: interrupted link left for a pass with an environment fingerprint', {
            path: pkgDir,
          });
          return 'blocked';
        } else if (newDirIsCompleteFarm(pass, workgroupId, pkgDir)) {
          fs.renameSync(newDir, nm);
        } else {
          fs.rmSync(newDir, { recursive: true, force: true });
        }
      }
      const [, hasOld, hasNew] = state();
      return !hasOld && !hasNew ? 'recovered' : 'failed';
    } catch (err) {
      log.warn('dependency-cache: recovery failed, retried next pass', { path: pkgDir, err: errorMessage(err) });
      return 'failed';
    }
  });
  decide(pass, 'recover', pkgDir, { detail: `${outcome}: ${steps.join('; ')}` });
  if (outcome === 'recovered') pass.counters.recovered += 1;
  return outcome;
}

/**
 * Read-only: is this package dir a farm of its key's verified entry? For
 * decisions that must not mutate (mounted topics, a refused claim). Does not
 * quarantine; the same pass's GC does.
 */
export function isFarmPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): boolean {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string' || !isRealDir(pkg.entryDir)) return false;
  return verifyOnce(pass, pkg.entryDir).ok && sharesHiddenLockfile(pkg.nodeModulesDir, pkg.entryDir);
}

function deleteCacheDir(pass: DependencyCachePass, dir: string, detail: string): void {
  decide(pass, 'gc-delete', dir, { estimatedBytes: pass.reclaimableBytes(dir), detail });
  pass.counters.gcDeleted += 1;
  if (pass.mode === 'report') return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn('dependency-cache: gc delete failed', { dir, err: errorMessage(err) });
  }
}

/**
 * Cache GC (§5.7.7), in the same pass as the sweep. Every entry is verified
 * (this is the at-least-hourly verify of §5.7.6) and deleted once no farm
 * shares any of its files (every regular file has nlink 1) and it is 14 days
 * past max(sealedAt, lastLinkedAt). Quarantined entries go after 7 days, and a
 * leftover `<key>.tmp` from an interrupted adopt holds links only.
 */
export function collectCacheGarbage(pass: DependencyCachePass): void {
  let workgroups: fs.Dirent[];
  try {
    workgroups = fs.readdirSync(pass.cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const workgroup of workgroups) {
    if (!workgroup.isDirectory()) continue;
    const wgDir = path.join(pass.cacheRoot, workgroup.name);
    let names: string[];
    try {
      names = fs.readdirSync(wgDir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const dir = path.join(wgDir, name);
      if (!isRealDir(dir)) continue;
      if (KEY_PATTERN.test(name)) {
        const verified = verifyFresh(pass, dir);
        if (!verified.ok) {
          quarantineEntry(pass, dir, verified);
          continue;
        }
        const lastUse = Math.max(Date.parse(verified.sealed.sealedAt), Date.parse(verified.sealed.lastLinkedAt) || 0);
        if (verified.allSingleLinked && pass.now - lastUse >= ENTRY_GC_AGE_MS) {
          deleteCacheDir(pass, dir, 'no farm links and aged');
        }
        continue;
      }
      if (name.endsWith(ENTRY_TMP_SUFFIX) && KEY_PATTERN.test(name.slice(0, -ENTRY_TMP_SUFFIX.length))) {
        deleteCacheDir(pass, dir, 'interrupted adopt');
        continue;
      }
      const quarantined = QUARANTINED_PATTERN.exec(name);
      if (quarantined && pass.now - Number(quarantined[2]) >= QUARANTINE_GC_AGE_MS) {
        deleteCacheDir(pass, dir, 'quarantined and aged');
      }
    }
  }
}
