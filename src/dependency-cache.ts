/**
 * Host-side npm dependency cache: one sealed, read-only `node_modules` per lockfile per workgroup, hardlinked into
 * each workspace (a "farm"); the hidden lockfile, which npm rewrites on every run, stays per-tree, and so does a
 * converted workspace's copy of any per-install file (`perInstallPredicate`) that differs from the entry's. Sole
 * owner of verify/adopt/convert/link/seal/recovery (spec: docs/specs/repository-branch-clones/plan.md §5.7); the
 * storage sweep only decides WHEN.
 *
 * The cache root must share a filesystem and mount with `v2-topics` (`link(2)` returns EXDEV across mounts).
 * Agents share the host uid, so read-only bits guard against accidents, not tampering. A `report` pass mutates
 * nothing.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

export const DEPENDENCY_CACHE_DIRNAME = 'dependency-cache';
/**
 * Convert/link build target. Holds farm links, plus links to per-install files the tree it replaces still holds,
 * so deleting it never loses private bytes.
 */
export const FARM_NEW_NAME = '.node_modules.nanoclaw-new';
export const FARM_OLD_NAME = '.node_modules.nanoclaw-old';
/** Never descended into by the regenerable sweep (they hold private bytes mid-convert). */
export const DEPENDENCY_CACHE_TEMP_NAMES: readonly string[] = [FARM_NEW_NAME, FARM_OLD_NAME];

export type DependencyCacheMode = 'off' | 'report' | 'apply';

const NODE_MODULES = 'node_modules';
const HIDDEN_LOCKFILE = '.package-lock.json';
/** Root dot entries that ARE shared; every other root dot entry is workspace-private. */
const SHARED_ROOT_DOT_NAMES = new Set(['.bin', HIDDEN_LOCKFILE]);
const SEALED_FILE = 'SEALED';
const CONTENT_CHUNK_BYTES = 1024 * 1024;
const ENTRY_TMP_SUFFIX = '.tmp';
const KEY_PATTERN = /^[0-9a-f]{64}$/;
const QUARANTINED_PATTERN = /^([0-9a-f]{64})\.quarantined-(\d+)$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ENTRY_GC_AGE_MS = 14 * DAY_MS;
const QUARANTINE_GC_AGE_MS = 7 * DAY_MS;
// Hourly is enough for day-granular GC; rewriting SEALED on every link would be write amplification.
const LAST_LINKED_REFRESH_MS = 60 * 60 * 1000;
/** Adopts plus convert attempts per pass; each reads a whole tree, so this bounds a pass's I/O too. */
export const DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS = 5;

/** The agent container's platform; the key names it and completeness refuses trees built for another. */
export interface InstallPlatform {
  readonly os: string;
  readonly cpu: string;
}

const INSTALL_PLATFORM: InstallPlatform = { os: 'linux', cpu: process.arch };

const fingerprintByImage = new Map<string, string>();

export function envFingerprint(nodeVersion: string, arch: string = INSTALL_PLATFORM.cpu): string {
  return `node=${nodeVersion};platform=${INSTALL_PLATFORM.os};arch=${arch}`;
}

function parseFingerprint(fingerprint: string): { node: string; platform: string; arch: string } | null {
  const match = /^node=([^;]+);platform=([^;]+);arch=([^;]+)$/.exec(fingerprint);
  return match ? { node: match[1]!, platform: match[2]!, arch: match[3]! } : null;
}

/**
 * The agent image's NODE_VERSION plus linux/arch, memoized on success. `null` when uninspectable: callers skip the
 * pass rather than guess.
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

/**
 * Content-mismatch verdicts by package dir, so a mismatching tree is read once, not every pass. Valid while the
 * inventory, hidden-lockfile mtime and entry content manifest are unchanged; a stale verdict only keeps a tree
 * private. Lives in the one persistent storage worker, so a restart costs one capped re-read per tree.
 */
interface ConvertMismatchVerdict {
  inventorySha256: string;
  hiddenLockfileMtimeMs: number;
  entryContentSha256: string;
}

const convertMismatchMemo = new Map<string, ConvertMismatchVerdict>();

function pruneConvertMismatchMemo(): void {
  for (const pkgDir of convertMismatchMemo.keys()) {
    if (!fs.existsSync(pkgDir)) convertMismatchMemo.delete(pkgDir);
  }
}

function sameVerdict(a: ConvertMismatchVerdict, b: ConvertMismatchVerdict): boolean {
  return (
    a.inventorySha256 === b.inventorySha256 &&
    a.hiddenLockfileMtimeMs === b.hiddenLockfileMtimeMs &&
    a.entryContentSha256 === b.entryContentSha256
  );
}

export function _resetDependencyCacheForTesting(): void {
  fingerprintByImage.clear();
  convertMismatchMemo.clear();
}

export function _convertMismatchMemoSizeForTesting(): number {
  return convertMismatchMemo.size;
}

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

/** §5.7.1: npm lockfile v2+ and no `workspaces`; everything else keeps the existing sweep rule. */
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

interface PackageFiles {
  lock: Buffer;
  manifest: Buffer;
  /** `null` when the package dir has no `.npmrc`. */
  npmrc: Buffer | null;
}

function readPackageFiles(pkgDir: string): PackageFiles | null {
  let lock: Buffer;
  let manifest: Buffer;
  try {
    lock = fs.readFileSync(path.join(pkgDir, 'package-lock.json'));
    manifest = fs.readFileSync(path.join(pkgDir, 'package.json'));
  } catch {
    return null;
  }
  try {
    return { lock, manifest, npmrc: fs.readFileSync(path.join(pkgDir, '.npmrc')) };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { lock, manifest, npmrc: null } : null;
  }
}

/** §5.7.2: length-framed sha256 of lockfile, package.json, `.npmrc` and fingerprint. `null` when unreadable. */
export function dependencyKey(pkgDir: string, fingerprint: string): { key: string; inputs: KeyInputs } | null {
  const files = readPackageFiles(pkgDir);
  if (!files) return null;
  const { lock, manifest } = files;
  const npmrc = files.npmrc ?? Buffer.alloc(0);
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

/**
 * The install stamp contract shared with the repos that run `npm ci`: written by that tool only after an `npm ci`
 * that ran lifecycle scripts, as a private root dot entry, so a reader may skip `npm ci` when every field it checks
 * equals a fresh computation. `--ignore-scripts` installs of one lockfile leave native bindings unbuilt.
 */
const INSTALL_STAMP_NAME = '.install-stamp.json';

interface InstallStamp {
  v: 1;
  lockSha256: string;
  pkgSha256: string;
  npmrcSha256: string | null;
  node: string;
  npm: string;
  platform: string;
  arch: string;
  libc: string | null;
  scripts: true;
  writer: string;
  at: string;
}

function parseInstallStamp(raw: unknown): InstallStamp | null {
  if (!isJsonObject(raw) || raw.v !== 1 || raw.scripts !== true) return null;
  const strings = ['lockSha256', 'pkgSha256', 'node', 'npm', 'platform', 'arch', 'writer', 'at'] as const;
  if (strings.some((field) => typeof raw[field] !== 'string')) return null;
  for (const field of ['npmrcSha256', 'libc'] as const) {
    if (raw[field] !== null && typeof raw[field] !== 'string') return null;
  }
  const stamp = raw as unknown as InstallStamp;
  return {
    v: 1,
    lockSha256: stamp.lockSha256,
    pkgSha256: stamp.pkgSha256,
    npmrcSha256: stamp.npmrcSha256,
    node: stamp.node,
    npm: stamp.npm,
    platform: stamp.platform,
    arch: stamp.arch,
    libc: stamp.libc,
    scripts: true,
    writer: stamp.writer,
    at: stamp.at,
  };
}

type StampPackageFields = Pick<InstallStamp, 'lockSha256' | 'pkgSha256' | 'npmrcSha256'>;

/**
 * The stamp fields a package dir's own bytes give, or `null` when those bytes no longer produce `inputs`: the dir
 * changed after it was keyed, so a stamp could describe another key's tree.
 */
function stampPackageFields(pkgDir: string, inputs: KeyInputs): StampPackageFields | null {
  const files = readPackageFiles(pkgDir);
  if (!files) return null;
  const fields: StampPackageFields = {
    lockSha256: sha256(files.lock),
    pkgSha256: sha256(files.manifest),
    npmrcSha256: files.npmrc ? sha256(files.npmrc) : null,
  };
  const keyed =
    fields.lockSha256 === inputs.packageLockSha256 &&
    fields.pkgSha256 === inputs.packageJsonSha256 &&
    (fields.npmrcSha256 ?? sha256(Buffer.alloc(0))) === inputs.npmrcSha256;
  return keyed ? fields : null;
}

function majorMinor(version: string): string | null {
  const match = /^v?(\d+)\.(\d+)(\.|$)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : null;
}

/** The contract's skip test, against the agent image's environment: what a check inside the container computes. */
function stampMatches(stamp: InstallStamp, fields: StampPackageFields, fingerprint: string): boolean {
  const env = parseFingerprint(fingerprint);
  const node = env && majorMinor(env.node);
  return (
    env !== null &&
    node !== null &&
    stamp.lockSha256 === fields.lockSha256 &&
    stamp.pkgSha256 === fields.pkgSha256 &&
    stamp.npmrcSha256 === fields.npmrcSha256 &&
    majorMinor(stamp.node) === node &&
    stamp.platform === env.platform &&
    stamp.arch === env.arch &&
    stamp.libc === LINK_PLATFORM.libc
  );
}

type InventoryItem = [relativePath: string, type: 'f' | 'l', size: number];

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

/** Regular files and symlinks sorted by path, private root dot entries skipped, symlinks never followed. */
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

function fileSha256(file: string): string {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(CONTENT_CHUNK_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * sha256 over every file's bytes (or symlink target) and exec bits: proves the content equality that makes
 * deleting a private tree lossless. Reads every byte, so only adopt and convert compute it.
 */
function contentManifestSha256(root: string, walk: TreeWalk): string | null {
  const manifest = createHash('sha256');
  try {
    for (const file of walk.files) {
      const full = path.join(root, file.rel);
      const content = file.type === 'f' ? fileSha256(full) : sha256(fs.readlinkSync(full));
      manifest.update(`${file.rel}\0${file.type}\0${content}\0${(file.stat.mode & 0o111).toString(8)}\n`);
    }
  } catch {
    return null;
  }
  return manifest.digest('hex');
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

/** The deepest lockfile package dir holding `rel` (relative to `node_modules`), or `null` when none does. */
function owningPackageKey(rel: string, packages: JsonObject): string | null {
  const segments = `${NODE_MODULES}/${rel}`.split('/');
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i] !== NODE_MODULES) continue;
    const end = i + 1 + (segments[i + 1]!.startsWith('@') ? 2 : 1);
    if (end >= segments.length) continue;
    const key = segments.slice(0, end).join('/');
    if (Object.prototype.hasOwnProperty.call(packages, key)) return key;
  }
  return null;
}

/**
 * Files two installs of one lockfile may legitimately hold with different bytes: the hidden lockfile, and every
 * file of a package whose lockfile entry says `hasInstallScript`. Its lifecycle script writes into its own dir:
 * node-gyp's `build/Makefile` and `config.gypi` embed the absolute install path, esbuild swaps its JS shim for the
 * native binary, and `--ignore-scripts` skips both. Read from the hidden lockfile of the tree the others are
 * compared with, so one entry always yields one predicate.
 */
function perInstallPredicate(referenceNodeModulesDir: string): (rel: string) => boolean {
  const packages = packagesOf(readJsonObject(path.join(referenceNodeModulesDir, HIDDEN_LOCKFILE))) ?? {};
  return (rel) => {
    if (rel === HIDDEN_LOCKFILE) return true;
    const owner = owningPackageKey(rel, packages);
    const entry = owner === null ? undefined : packages[owner];
    return isJsonObject(entry) && entry.hasInstallScript === true;
  };
}

/** Per-install items keep path and type only: their size may differ between installs. */
function comparableInventory(items: InventoryItem[], perInstall: (rel: string) => boolean): Inventory {
  const comparable = items.map(([rel, type, size]): InventoryItem => [rel, type, perInstall(rel) ? -1 : size]);
  return { items: comparable, sha256: sha256(JSON.stringify(comparable)) };
}

function sameContent(a: string, aStat: fs.Stats, b: string, bStat: fs.Stats): boolean {
  if (aStat.isSymbolicLink() || bStat.isSymbolicLink()) {
    return aStat.isSymbolicLink() && bStat.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  return (
    aStat.isFile() &&
    bStat.isFile() &&
    aStat.size === bStat.size &&
    (aStat.mode & 0o111) === (bStat.mode & 0o111) &&
    fileSha256(a) === fileSha256(b)
  );
}

interface ContentComparison {
  /** First path whose bytes, symlink target or exec bits differ from the entry's, per-install files excluded. */
  difference: string | null;
  /** Per-install files that differ from the entry's: the farm keeps the workspace's own. */
  keepOwn: TreeFile[];
}

/**
 * Compares every file of a tree with the entry's copy, stopping at the first difference that bars a convert.
 * Assumes equal comparable inventories. `null` when either tree is unreadable.
 */
function compareWithEntry(
  entryNodeModulesDir: string,
  nodeModulesDir: string,
  walk: TreeWalk,
  perInstall: (rel: string) => boolean,
): ContentComparison | null {
  const keepOwn: TreeFile[] = [];
  try {
    for (const file of walk.files) {
      const entryFile = path.join(entryNodeModulesDir, file.rel);
      const own = path.join(nodeModulesDir, file.rel);
      if (sameContent(entryFile, fs.lstatSync(entryFile), own, file.stat)) continue;
      if (!perInstall(file.rel)) return { difference: file.rel, keepOwn };
      keepOwn.push(file);
    }
  } catch {
    return null;
  }
  return { difference: null, keepOwn };
}

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

/** npm-install-checks 7.1.2 `checkList`: `!value` refuses; else named, only negations, or exactly `any`. */
function platformListAccepts(value: string, list: unknown): boolean {
  const entries = typeof list === 'string' ? [list] : list;
  if (!Array.isArray(entries)) return true;
  if (entries.length === 1 && entries[0] === 'any') return true;
  let negated = 0;
  let match = false;
  for (const entry of entries) {
    if (typeof entry !== 'string') continue;
    if (entry.startsWith('!')) {
      negated += 1;
      if (entry.slice(1) === value) return false;
    } else if (entry === value) {
      match = true;
    }
  }
  return match || negated === entries.length;
}

/** The first `os`/`cpu` constraint of an installed package that `platform` fails, as `cpu=["arm64"]`. */
function foreignPlatform(entry: JsonObject, platform: InstallPlatform): string | null {
  for (const [field, value] of [
    ['os', platform.os],
    ['cpu', platform.cpu],
  ] as const) {
    if (entry[field] !== undefined && !platformListAccepts(value, entry[field])) {
      return `${field}=${JSON.stringify(entry[field])}`;
    }
  }
  return null;
}

/**
 * A tree is complete when:
 *   (1) every hidden-lockfile package entry (root excluded) matches package-lock.json {version, resolved,
 *       integrity}, and every package-lock entry absent from the hidden lockfile is `optional: true`;
 *   (2) every hidden-lockfile package path is a real directory whose package.json name and version match;
 *   (3) no regular file is newer than the hidden lockfile; and
 *   (4) every installed package that declares `os` or `cpu` accepts the install platform.
 *
 * (1) does not ask why an optional package is absent: adopt and convert never change a workspace's file set.
 * Linking into a fresh workspace needs `checkLinkCompleteness`. libc is not checked in (4): real trees hold -gnu
 * and -musl builds side by side.
 */
export function checkCompleteness(pkgDir: string, platform: InstallPlatform = INSTALL_PLATFORM): Completeness {
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
    const foreign = foreignPlatform(hidden, platform);
    if (foreign) return incomplete(`installed for another platform: ${key} (${foreign})`);
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

interface SealedRecord {
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
  /** `contentManifestSha256` of the sealed tree; identifies the entry a remembered convert mismatch was against. */
  contentSha256: string;
  /** The source tree's install stamp at adoption; absent on entries sealed before stamps gated adoption. */
  installStamp?: unknown;
}

interface EntryIdentity {
  inventory: InventoryItem[];
  inventorySha256: string;
  contentSha256: string;
}

/** What a report pass would have sealed, so later same-key trees report their convert. */
interface WouldSealEntry extends EntryIdentity {
  source: string;
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
    typeof raw.contentSha256 !== 'string' ||
    !Array.isArray(raw.inventory)
  ) {
    return null;
  }
  return raw as unknown as SealedRecord;
}

/** Precondition of every link, convert and GC decision: no write bits, no mtime after sealedAt, same inventory. */
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

interface DependencyCacheCounters {
  recovered: number;
  adopted: number;
  converted: number;
  convertMismatch: number;
  linked: number;
  quarantined: number;
  gcDeleted: number;
  /** Eligible trees left for a later pass by DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS. */
  deferred: number;
  /** Whole-tree content reads (adopt, report-mode adopt, convert attempts); each took a cap slot. */
  contentReads: number;
  /** Eligible, non-farm trees seen in topics a running container mounts. */
  privateInMountedTopics: number;
  privateInMountedTopicsBytes: number;
}

interface DependencyCacheDecision {
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
  /** Resolved lazily so recover/GC-only passes never inspect the image. `null`: skip adopt/convert/link. */
  readonly fingerprint: () => string | null;
  readonly fingerprintState: { resolved: boolean; value: string | null };
  readonly counters: DependencyCacheCounters;
  readonly decisions: DependencyCacheDecision[];
  /** Reclaimable bytes of a dir — `dirSizeBytes`, the §5.8 primitive, injected to avoid an import cycle. */
  readonly reclaimableBytes: (dir: string) => number;
  /** Farm decisions verify each entry at most once per pass; link, convert and GC re-verify. */
  readonly verified: Map<string, VerifyResult>;
  readonly quarantinedThisPass: Set<string>;
  /** Report passes only: entries this pass would have sealed, by entry dir. */
  readonly wouldSeal: Map<string, WouldSealEntry>;
  /** Adopts plus convert attempts (content reads) this pass, against DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS. */
  mutations: number;
}

export function startDependencyCachePass(options: {
  mode: 'report' | 'apply';
  cacheRoot: string;
  now: number;
  reclaimableBytes: (dir: string) => number;
  fingerprint?: () => string | null;
}): DependencyCachePass {
  pruneConvertMismatchMemo();
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
      contentReads: 0,
      privateInMountedTopics: 0,
      privateInMountedTopicsBytes: 0,
    },
    decisions: [],
    verified: new Map(),
    quarantinedThisPass: new Set(),
    wouldSeal: new Map(),
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

/** §5.7.6: rename aside with a WARN; never linked again, and the next complete private tree re-adopts. */
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

/** No entry is ordinary (INFO); a quarantined entry is not (WARN). */
function warnNoEntry(pass: DependencyCachePass, workgroupId: string, key: string, pkgDir: string): void {
  const quarantined = quarantinedDirsFor(pass, workgroupId, key).length > 0;
  const detail = { path: pkgDir, key, quarantined };
  if (quarantined) log.warn('dependency-cache: no verified entry for key', detail);
  else log.info('dependency-cache: no verified entry for key', detail);
}

/**
 * The first regular file in the entry's inventory that is not per-install (a farm may hold its own copy of
 * those); with no readable SEALED, the first such file a short walk finds.
 */
function sampleSharedFile(entryDir: string, sealed: SealedRecord | null): string | null {
  const root = path.join(entryDir, NODE_MODULES);
  const perInstall = perInstallPredicate(root);
  const record = sealed ?? readSealed(entryDir);
  if (record) return record.inventory.find(([rel, type]) => type === 'f' && !perInstall(rel))?.[0] ?? null;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isFile() && !perInstall(childRel)) return childRel;
      if (entry.isDirectory()) stack.push(childRel);
    }
  }
  return null;
}

/** "Already a farm": the sampled file is the entry's own inode. */
function sharesEntryInodes(nodeModulesDir: string, entryDir: string, sealed: SealedRecord | null): boolean {
  const rel = sampleSharedFile(entryDir, sealed);
  if (!rel) return false;
  const mine = lstatOrNull(path.join(nodeModulesDir, rel));
  const theirs = lstatOrNull(path.join(entryDir, NODE_MODULES, rel));
  return Boolean(mine && theirs && mine.isFile() && mine.dev === theirs.dev && mine.ino === theirs.ino);
}

/**
 * A pending convert/link temp name: `.old` can hold private bytes and `node_modules` beside it private entries
 * already moved out, so the sweep never deletes that `node_modules`.
 */
export function hasPendingConversion(pkgDir: string): boolean {
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

/** Restore the package dir's times: its mtime is part of the sweep's idle signal, and our renames move it. */
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
 * `cp -al` minus private root dot entries, symlinks recreated, never followed. The root hidden lockfile is COPIED
 * (owner-writable, mtime kept): npm rewrites it every run, so a shared inode would be unlinked or leak one
 * workspace's edit into all. `dst` must not exist; on failure the partial `dst` is removed and the source is untouched.
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
        } else if (st.isFile() && atRoot && name === HIDDEN_LOCKFILE) {
          fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(target, (st.mode & 0o7777) | 0o200);
          // Completeness rule (3) compares file mtimes with this one.
          fs.utimesSync(target, st.atimeMs / 1000, st.mtimeMs / 1000);
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

function adoptableStamp(pkg: PreparedPackage): InstallStamp | null {
  const stamp = parseInstallStamp(readJsonObject(path.join(pkg.nodeModulesDir, INSTALL_STAMP_NAME)));
  const fields = stampPackageFields(pkg.pkgDir, pkg.inputs);
  return stamp && fields && stampMatches(stamp, fields, pkg.fingerprint) ? stamp : null;
}

/**
 * Writes the entry's stamp, with the copy's own package-dir fields, into a tree that now holds the entry's
 * content, when it passes the skip test there. Never replaces a stamp already in `nodeModulesDir`: that is the
 * workspace's own private file. Best effort: a missing stamp only costs a reinstall.
 */
function stampCopy(pkg: PreparedPackage, nodeModulesDir: string, sealed: SealedRecord): void {
  const entryStamp = parseInstallStamp(sealed.installStamp);
  if (!entryStamp) return;
  const fields = stampPackageFields(pkg.pkgDir, pkg.inputs);
  if (!fields || !stampMatches(entryStamp, fields, pkg.fingerprint)) return;
  const target = path.join(nodeModulesDir, INSTALL_STAMP_NAME);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...entryStamp, ...fields }));
    fs.linkSync(tmp, target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      log.warn('dependency-cache: could not write install stamp', { path: pkg.pkgDir, err: errorMessage(err) });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
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

/** Bytes a convert frees: the private tree's, less the private dot entries and kept per-install files that stay. */
function convertReclaimBytes(pass: DependencyCachePass, nodeModulesDir: string, keepOwn: TreeFile[]): number {
  const privateBytes = privateRootNames(nodeModulesDir).reduce(
    (sum, name) => sum + pass.reclaimableBytes(path.join(nodeModulesDir, name)),
    0,
  );
  const keptBytes = keepOwn.reduce((sum, file) => sum + (file.stat.nlink === 1 ? file.stat.size : 0), 0);
  return Math.max(0, pass.reclaimableBytes(nodeModulesDir) - privateBytes - keptBytes);
}

/** Move each private root dot entry from `.old` into `node_modules`; a name already there stops and keeps `.old`. */
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
  | 'unstamped'
  | 'failed';

export type LinkOutcome =
  | 'linked'
  | 'exists'
  | 'ineligible'
  | 'unkeyable'
  | 'no-entry'
  | 'quarantined'
  | 'incomplete'
  | 'failed';

/** Install platform plus libc family; the agent image (node:22-slim, Debian) is glibc, npm's `glibc`. */
export interface LinkPlatform extends InstallPlatform {
  readonly libc: string;
}

const LINK_PLATFORM: LinkPlatform = { ...INSTALL_PLATFORM, libc: 'glibc' };

/** A musl build by name: `…-linuxmusl-…` (sharp) or `…-musl` (rollup, lightningcss, css-inline, unrs). */
const MUSL_BUILD_NAME = /(^|[-/])(linux)?musl($|[-/])/;

export type LinkCompleteness = { complete: true } | { complete: false; reason: string };

/** Node resolution: the nearest `node_modules/<name>` walking up from `from`. `null` when the lockfile has none. */
function resolveDependency(packages: JsonObject, from: string, name: string): string | null {
  let base = from;
  for (;;) {
    const candidate = base === '' ? `${NODE_MODULES}/${name}` : `${base}/${NODE_MODULES}/${name}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    if (base === '') return null;
    const parent = base.lastIndexOf(`/${NODE_MODULES}/`);
    base = parent === -1 ? '' : base.slice(0, parent);
  }
}

/**
 * Names required through a non-optional edge: dependencies and non-optional peers, plus the root's devDependencies
 * (never a dependency's). A name also listed in optionalDependencies is optional, as in arborist.
 */
function requiredNames(key: string, entry: JsonObject): string[] {
  const names = new Set<string>();
  const addAll = (field: unknown): void => {
    if (isJsonObject(field)) for (const name of Object.keys(field)) names.add(name);
  };
  addAll(entry.dependencies);
  if (key === '') addAll(entry.devDependencies);
  const peerMeta = isJsonObject(entry.peerDependenciesMeta) ? entry.peerDependenciesMeta : {};
  if (isJsonObject(entry.peerDependencies)) {
    for (const name of Object.keys(entry.peerDependencies)) {
      const meta = peerMeta[name];
      if (!(isJsonObject(meta) && meta.optional === true)) names.add(name);
    }
  }
  if (isJsonObject(entry.optionalDependencies)) {
    for (const name of Object.keys(entry.optionalDependencies)) names.delete(name);
  }
  return [...names];
}

/** npm's platform test on a lockfile entry: os/cpu, and libc when it declares one. */
function platformExcludes(entry: JsonObject, platform: LinkPlatform): boolean {
  if (foreignPlatform(entry, platform) !== null) return true;
  return entry.libc !== undefined && !platformListAccepts(platform.libc, entry.libc);
}

/**
 * Precondition of LINKING an entry into a package dir that never installed it (§5.7.5): unlike rule (1), refuses
 * an entry missing an optional package npm WOULD install here, or a fresh checkout loses its native binary.
 *
 * An absent package-lock entry is excused when:
 *   (a) its lockfile `os`/`cpu`, or a declared `libc`, exclude this platform (npm-install-checks 7.1.2);
 *   (b) it declares `os`/`cpu` but no `libc`, is named as a musl build, and this platform is glibc (older
 *       lockfiles omit `libc`; npm skips these after reading the package manifest);
 *   (c) every entry requiring it through a non-optional edge (by node resolution, at least one) is itself
 *       absent and excused. Optional edges are ignored, as npm's optional-set pruning ignores them (arborist
 *       `optional-set.js`): a failed `cpu-features` takes `nan` with it though an installed `ssh2` lists `nan`
 *       as optional. Least fixpoint, so a cycle with no excused root excuses nothing;
 *   (d) it declares `hasInstallScript` and nothing installed requires it through a non-optional edge: npm
 *       removes an optional package whose install script fails, with every package requiring it that way, and
 *       the entry was installed from this lockfile for this platform, where that build failed.
 * Anything else absent refuses the link, as does an absent non-`optional` entry.
 *
 * Reads `package-lock.json` from `pkgDir` (the key pins its bytes) and the hidden lockfile from `nodeModulesDir`.
 */
export function checkLinkCompleteness(
  pkgDir: string,
  nodeModulesDir: string,
  platform: LinkPlatform = LINK_PLATFORM,
): LinkCompleteness {
  const lockPackages = packagesOf(readJsonObject(path.join(pkgDir, 'package-lock.json')));
  const hiddenPackages = packagesOf(readJsonObject(path.join(nodeModulesDir, HIDDEN_LOCKFILE)));
  if (!lockPackages || !hiddenPackages) return { complete: false, reason: 'lockfile packages unreadable' };
  const installed = (key: string): boolean => key === '' || Object.prototype.hasOwnProperty.call(hiddenPackages, key);
  const absent = Object.keys(lockPackages)
    .filter((key) => !installed(key))
    .sort();
  if (absent.length === 0) return { complete: true };
  for (const key of absent) {
    const entry = lockPackages[key];
    if (!isJsonObject(entry) || entry.optional !== true) {
      return { complete: false, reason: `non-optional package absent: ${key}` };
    }
  }

  const requiredBy = new Map<string, Set<string>>();
  for (const [key, entry] of Object.entries(lockPackages)) {
    if (!isJsonObject(entry)) continue;
    for (const name of requiredNames(key, entry)) {
      const target = resolveDependency(lockPackages, key, name);
      if (target === null || target === key) continue;
      const requirers = requiredBy.get(target) ?? new Set<string>();
      requirers.add(key);
      requiredBy.set(target, requirers);
    }
  }

  const excused = new Set<string>();
  for (const key of absent) {
    const entry = lockPackages[key] as JsonObject;
    const muslBuild =
      platform.libc === 'glibc' &&
      (entry.os !== undefined || entry.cpu !== undefined) &&
      entry.libc === undefined &&
      MUSL_BUILD_NAME.test(typeof entry.name === 'string' ? entry.name : nameFromPackageKey(key));
    const failedBuild =
      entry.hasInstallScript === true && [...(requiredBy.get(key) ?? [])].every((by) => !installed(by));
    if (platformExcludes(entry, platform) || muslBuild || failedBuild) excused.add(key);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const key of absent) {
      if (excused.has(key)) continue;
      const requirers = requiredBy.get(key);
      if (requirers && requirers.size > 0 && [...requirers].every((by) => !installed(by) && excused.has(by))) {
        excused.add(key);
        grew = true;
      }
    }
  }
  const missing = absent.find((key) => !excused.has(key));
  return missing === undefined
    ? { complete: true }
    : { complete: false, reason: `optional package this platform installs is absent: ${missing}` };
}

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
  fingerprint: string;
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
    fingerprint,
    entryDir: path.join(workgroupDir(pass, workgroupId), keyed.key),
  };
}

/**
 * True once the pass has used its adopt/convert slots: the tree is left as is for the existing sweep rule. A
 * mutating caller takes its slot with `pass.mutations += 1`; report passes count the same way to predict apply.
 */
function deferIfCapped(pass: DependencyCachePass, pkg: PreparedPackage): boolean {
  if (pass.mutations < DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS) return false;
  pass.counters.deferred += 1;
  decide(pass, 'deferred', pkg.pkgDir, {
    key: pkg.key,
    detail: `per-pass cap of ${DEPENDENCY_CACHE_MAX_MUTATIONS_PER_PASS} reached`,
  });
  return true;
}

/**
 * Adopt (§5.7.4): link into `<key>.tmp/node_modules`, `chmod a-w`, write SEALED with the source's install stamp,
 * rename to `<key>`. The source becomes the entry's first farm. A report pass records what it would seal, so later
 * same-key trees report a convert, not a second adopt.
 */
function adopt(
  pass: DependencyCachePass,
  pkg: PreparedPackage,
  completeness: { walk: TreeWalk; inventory: Inventory },
  installStamp: InstallStamp,
): PackageOutcome {
  if (deferIfCapped(pass, pkg)) return 'deferred';
  pass.mutations += 1;
  decide(pass, 'adopt', pkg.pkgDir, { key: pkg.key });
  if (pass.mode === 'report') {
    pass.counters.contentReads += 1;
    const contentSha256 = contentManifestSha256(pkg.nodeModulesDir, completeness.walk);
    if (contentSha256) {
      pass.wouldSeal.set(pkg.entryDir, {
        source: pkg.pkgDir,
        inventory: completeness.inventory.items,
        inventorySha256: completeness.inventory.sha256,
        contentSha256,
      });
    }
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
    // The one read of every byte: what convert will require of a private tree.
    pass.counters.contentReads += 1;
    const contentSha256 = contentManifestSha256(tmpNm, linked);
    if (!contentSha256) throw new Error('entry content unreadable');
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
      contentSha256,
      installStamp,
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

function convertMismatch(pass: DependencyCachePass, pkg: PreparedPackage, firstDifference: string): PackageOutcome {
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

/**
 * Convert (§5.7.4): deletes private bytes, so requires inventory AND content equality with the entry, except that
 * a per-install file need only match in path and type and the farm keeps the workspace's own copy when its bytes
 * differ. Order is load-bearing: `.new` holds only farm links and links to inodes the replaced tree still holds,
 * and private dot entries move only after `.new` is in place, so `recoverPackageDir` can finish or reverse every
 * interruption. `sealed` is null only for a report pass, whose would-be entry is its source's `node_modules`.
 */
function convertVerified(
  pass: DependencyCachePass,
  pkg: PreparedPackage,
  identity: EntryIdentity,
  entryNodeModulesDir: string,
  sealed: SealedRecord | null,
  completeness: { walk: TreeWalk; inventory: Inventory },
  hooks: ConvertHooks = {},
): PackageOutcome {
  const { inventory } = completeness;
  const perInstall = perInstallPredicate(entryNodeModulesDir);
  const expected = comparableInventory(identity.inventory, perInstall);
  const actual = comparableInventory(inventory.items, perInstall);
  if (actual.sha256 !== expected.sha256) {
    return convertMismatch(pass, pkg, firstInventoryDifference(expected.items, actual.items));
  }
  if (pass.mode === 'apply' && !sealed) return 'failed';
  const verdict: ConvertMismatchVerdict = {
    inventorySha256: inventory.sha256,
    hiddenLockfileMtimeMs: completeness.walk.files.find((file) => file.rel === HIDDEN_LOCKFILE)?.stat.mtimeMs ?? -1,
    entryContentSha256: identity.contentSha256,
  };
  const known = convertMismatchMemo.get(pkg.pkgDir);
  if (known && sameVerdict(known, verdict)) {
    // Known mismatch, nothing changed: no read, no slot.
    pass.counters.convertMismatch += 1;
    decide(pass, 'convert-mismatch', pkg.pkgDir, {
      key: pkg.key,
      detail: 'memoized: content differed on an earlier pass and the tree is unchanged',
    });
    return 'convert-mismatch';
  }
  // Slot taken before the read so the cap bounds reads.
  if (deferIfCapped(pass, pkg)) return 'deferred';
  pass.mutations += 1;
  pass.counters.contentReads += 1;
  const comparison = compareWithEntry(entryNodeModulesDir, pkg.nodeModulesDir, completeness.walk, perInstall);
  if (comparison?.difference !== null) {
    convertMismatchMemo.set(pkg.pkgDir, verdict);
    return convertMismatch(
      pass,
      pkg,
      comparison
        ? `content differs (file bytes, symlink target or exec bits): ${comparison.difference}`
        : 'content unreadable',
    );
  }
  const { keepOwn } = comparison;
  convertMismatchMemo.delete(pkg.pkgDir);
  decide(pass, 'convert', pkg.pkgDir, {
    key: pkg.key,
    estimatedBytes: convertReclaimBytes(pass, pkg.nodeModulesDir, keepOwn),
    ...(keepOwn.length > 0 ? { detail: `keeps its own ${keepOwn.map((file) => file.rel).join(', ')}` } : {}),
  });
  if (pass.mode === 'report' || !sealed) {
    pass.counters.converted += 1;
    return 'converted';
  }
  if (hasPendingConversion(pkg.pkgDir)) {
    log.warn('dependency-cache: convert skipped, an interrupted operation is still pending', { path: pkg.pkgDir });
    return 'failed';
  }
  const newDir = path.join(pkg.pkgDir, FARM_NEW_NAME);
  const oldDir = path.join(pkg.pkgDir, FARM_OLD_NAME);
  const step = (name: ConvertStep): void => hooks.onStep?.(name);
  const result = withPackageDirTimesPreserved(pkg.pkgDir, (): PackageOutcome => {
    try {
      linkTree(entryNodeModulesDir, newDir);
      for (const file of keepOwn) {
        const own = path.join(pkg.nodeModulesDir, file.rel);
        const target = path.join(newDir, file.rel);
        fs.unlinkSync(target);
        if (file.type === 'f') fs.linkSync(own, target);
        else fs.symlinkSync(fs.readlinkSync(own), target);
      }
      const hiddenLockfile = path.join(newDir, HIDDEN_LOCKFILE);
      const hidden = fs.statSync(hiddenLockfile);
      const newestMs = Math.max(
        fs.statSync(path.join(entryNodeModulesDir, HIDDEN_LOCKFILE)).mtimeMs,
        ...keepOwn.filter((file) => file.type === 'f').map((file) => fs.statSync(path.join(newDir, file.rel)).mtimeMs),
      );
      if (newestMs > hidden.mtimeMs) {
        fs.utimesSync(hiddenLockfile, hidden.atimeMs / 1000, (Math.ceil(newestMs) + 1) / 1000);
      }
    } catch (err) {
      fs.rmSync(newDir, { recursive: true, force: true });
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
  // A kept per-install file is the workspace's own build output, which the entry's stamp does not vouch for.
  if (keepOwn.every((file) => file.rel === HIDDEN_LOCKFILE)) stampCopy(pkg, pkg.nodeModulesDir, sealed);
  touchLastLinked(pass, pkg.entryDir, sealed);
  pass.counters.converted += 1;
  return 'converted';
}

/** No-op with a WARN when the key has no verified entry; adoption is `processPackageDir`'s job. */
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
  if (sharesEntryInodes(pkg.nodeModulesDir, pkg.entryDir, verified.sealed)) return 'farm';
  const completeness = checkCompleteness(pkgDir);
  if (!completeness.complete) {
    decide(pass, 'incomplete', pkgDir, { key: pkg.key, detail: completeness.reason });
    return 'incomplete';
  }
  return convertVerified(
    pass,
    pkg,
    verified.sealed,
    path.join(pkg.entryDir, NODE_MODULES),
    verified.sealed,
    completeness,
    hooks,
  );
}

/**
 * Convert when the key has a verified entry, adopt when none. A tree sharing inodes with a quarantined entry
 * stays private and is never re-sealed. Report passes count a would-be entry as existing.
 */
export function processPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): PackageOutcome {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string') return pkg;
  if (!isRealDir(pkg.nodeModulesDir)) return 'no-tree';
  if (hasPendingConversion(pkgDir)) return 'failed';

  const entryExists = isRealDir(pkg.entryDir);
  const wouldBe = entryExists ? undefined : pass.wouldSeal.get(pkg.entryDir);
  if (entryExists) {
    const verified = verifyOnce(pass, pkg.entryDir);
    if (!verified.ok) {
      quarantineEntry(pass, pkg.entryDir, verified);
      return 'quarantined';
    }
    if (sharesEntryInodes(pkg.nodeModulesDir, pkg.entryDir, verified.sealed)) return 'farm';
  } else if (wouldBe?.source === pkgDir) {
    // The would-be entry's source: adopt would have made it the first farm.
    return 'farm';
  } else if (
    quarantinedDirsFor(pass, workgroupId, pkg.key).some((dir) => sharesEntryInodes(pkg.nodeModulesDir, dir, null))
  ) {
    return 'quarantined';
  }

  const completeness = checkCompleteness(pkgDir);
  if (!completeness.complete) {
    decide(pass, 'incomplete', pkgDir, { key: pkg.key, detail: completeness.reason });
    return 'incomplete';
  }
  const perInstall = perInstallPredicate(pkg.nodeModulesDir);
  if (!completeness.inventory.items.some(([rel, type]) => type === 'f' && !perInstall(rel))) {
    // Nothing a farm is sure to share, so no file could prove a tree is a farm.
    return 'ineligible';
  }
  if (entryExists) {
    const verified = verifyFresh(pass, pkg.entryDir);
    if (!verified.ok) {
      quarantineEntry(pass, pkg.entryDir, verified);
      return 'quarantined';
    }
    return convertVerified(
      pass,
      pkg,
      verified.sealed,
      path.join(pkg.entryDir, NODE_MODULES),
      verified.sealed,
      completeness,
    );
  }
  if (wouldBe) return convertVerified(pass, pkg, wouldBe, path.join(wouldBe.source, NODE_MODULES), null, completeness);
  const installStamp = adoptableStamp(pkg);
  if (!installStamp) {
    // An entry is linked into checkouts that never installed it, so it must be a tree whose lifecycle scripts ran.
    decide(pass, 'unstamped', pkgDir, { key: pkg.key, detail: `no ${INSTALL_STAMP_NAME} matching this tree` });
    return 'unstamped';
  }
  return adopt(pass, pkg, completeness, installStamp);
}

/** Link (§5.7.4): build `.new` from the verified entry and rename it into place. */
export function linkPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): LinkOutcome {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string') return pkg;
  if (lstatOrNull(pkg.nodeModulesDir)) return 'exists';
  if (hasPendingConversion(pkgDir)) {
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
  // A link hands this workspace content it never installed, so the entry must
  // also hold every optional package npm would install here (§5.7.5).
  const strict = checkLinkCompleteness(pkgDir, path.join(pkg.entryDir, NODE_MODULES));
  if (!strict.complete) {
    decide(pass, 'link-refused', pkgDir, { key: pkg.key, detail: strict.reason });
    log.warn('dependency-cache: link refused, entry lacks a package this platform installs', {
      path: pkgDir,
      key: pkg.key,
      reason: strict.reason,
    });
    return 'incomplete';
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
      stampCopy(pkg, newDir, verified.sealed);
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

/** The only case in which renaming `.new` into place finishes an interrupted link. */
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
 *   - `.new` and `node_modules` present: delete `.new` (farm links, and links to inodes `node_modules` holds);
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

/** Read-only farm check for decisions that must not mutate; never quarantines (the pass's GC does). */
export function isFarmPackageDir(pass: DependencyCachePass, workgroupId: string, pkgDir: string): boolean {
  const pkg = preparePackage(pass, workgroupId, pkgDir);
  if (typeof pkg === 'string' || !isRealDir(pkg.entryDir)) return false;
  const verified = verifyOnce(pass, pkg.entryDir);
  return verified.ok && sharesEntryInodes(pkg.nodeModulesDir, pkg.entryDir, verified.sealed);
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
 * Cache GC (§5.7.7), also the hourly verify. Deletes an entry no farm shares (every file nlink 1) 14 days past
 * max(sealedAt, lastLinkedAt); quarantined after 7 days; a leftover `<key>.tmp` holds links only.
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
