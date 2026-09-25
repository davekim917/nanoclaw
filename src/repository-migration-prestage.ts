/**
 * Host-only, performance-only cache for the expensive byte hashes collected
 * while inventorying legacy checkouts. A cache hit is never treated as proof
 * that a checkout is unchanged: callers still enumerate paths and take a new
 * lstat snapshot at the final quiescent capture.
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

export type PrestagedFileType = 'file' | 'symlink';

// The live inventory is expected to include roughly one million paths. These
// limits cap parser/memory exposure while leaving headroom for that fleet.
const MAX_CACHE_ENTRIES = 1_250_000;
export const MAX_CACHE_DOCUMENT_BYTES = 768 * 1024 * 1024;
export const MAX_CACHE_PATH_BYTES = 4096;
export const MAX_SYMLINK_TARGET_BYTES = 4096;
const MAX_NUMERIC_FIELD_LENGTH = 32;

interface PrestagedFileIdentity {
  path: string;
  type: PrestagedFileType;
  dev: string;
  ino: string;
  ctimeNs: string;
  size: string;
  mode: number;
  /** The link text is part of a symlink's identity, not merely its hash input. */
  symlinkTargetBase64?: string;
}

interface PrestagedFileEntry extends PrestagedFileIdentity {
  sha256: string;
}

interface PrestagedFileCacheDocument {
  version: 1;
  entries: PrestagedFileEntry[];
  entriesSha256: string;
}

export interface PrestagedFileHash {
  type: PrestagedFileType;
  mode: number;
  size: number;
  sha256: string;
  symlinkTargetBase64?: string;
  reused: boolean;
}

export interface RepositoryMigrationPrestageStats {
  entries: number;
  reusedEntries: number;
  reusedBytes: number;
  rehashedEntries: number;
  rehashedBytes: number;
  prunedEntries: number;
  uncacheableEntries: number;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function entriesSha256(entries: readonly PrestagedFileEntry[]): string {
  return sha256(Buffer.from(canonicalJson({ version: 1, entries })));
}

function sameIdentity(left: PrestagedFileIdentity, right: PrestagedFileIdentity): boolean {
  return (
    left.path === right.path &&
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeNs === right.ctimeNs &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.symlinkTargetBase64 === right.symlinkTargetBase64
  );
}

function numberSize(value: bigint, file: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`repository migration cache cannot represent file larger than Number.MAX_SAFE_INTEGER: ${file}`);
  }
  return Number(value);
}

function snapshot(file: string, expectedType: PrestagedFileType): PrestagedFileIdentity {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute, { bigint: true });
  const type: PrestagedFileType | null = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : null;
  if (type !== expectedType)
    throw new Error(`expected ${expectedType} during repository migration capture: ${absolute}`);
  const target = type === 'symlink' ? fs.readlinkSync(absolute, { encoding: 'buffer' }).toString('base64') : undefined;
  return {
    path: absolute,
    type,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    size: stat.size.toString(),
    mode: Number(stat.mode & BigInt(0o7777)),
    ...(target === undefined ? {} : { symlinkTargetBase64: target }),
  };
}

function withinUtf8Limit(value: string, limit: number): boolean {
  return Buffer.byteLength(value, 'utf8') <= limit;
}

function validUnsignedDecimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_NUMERIC_FIELD_LENGTH && /^\d+$/.test(value);
}

function validBase64(value: string, maxBytes: number): boolean {
  if (value.length > Math.ceil(maxBytes / 3) * 4) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length <= maxBytes && decoded.toString('base64') === value;
}

function isCacheDocument(value: unknown): value is PrestagedFileCacheDocument {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Array.isArray(record.entries) ||
    record.entries.length > MAX_CACHE_ENTRIES ||
    typeof record.entriesSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.entriesSha256)
  ) {
    return false;
  }
  const paths = new Set<string>();
  const validEntries = record.entries.every((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Record<string, unknown>;
    const valid =
      typeof candidate.path === 'string' &&
      path.isAbsolute(candidate.path) &&
      withinUtf8Limit(candidate.path, MAX_CACHE_PATH_BYTES) &&
      (candidate.type === 'file' || candidate.type === 'symlink') &&
      validUnsignedDecimal(candidate.dev) &&
      validUnsignedDecimal(candidate.ino) &&
      validUnsignedDecimal(candidate.ctimeNs) &&
      validUnsignedDecimal(candidate.size) &&
      typeof candidate.mode === 'number' &&
      Number.isInteger(candidate.mode) &&
      candidate.mode >= 0 &&
      candidate.mode <= 0o7777 &&
      typeof candidate.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(candidate.sha256) &&
      (candidate.type === 'symlink'
        ? typeof candidate.symlinkTargetBase64 === 'string' &&
          validBase64(candidate.symlinkTargetBase64, MAX_SYMLINK_TARGET_BYTES)
        : candidate.symlinkTargetBase64 === undefined);
    const entryPath = candidate.path;
    if (!valid || typeof entryPath !== 'string' || paths.has(entryPath)) return false;
    paths.add(entryPath);
    return true;
  });
  return validEntries && entriesSha256(record.entries as PrestagedFileEntry[]) === record.entriesSha256;
}

function writeAtomically(file: string, value: PrestagedFileCacheDocument): void {
  ensureHostOnlyCacheParent(path.dirname(file), true);
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_CACHE_DOCUMENT_BYTES) {
    throw new Error(
      `repository migration prestage cache is ${bytes.length} bytes, above the ${MAX_CACHE_DOCUMENT_BYTES}-byte limit; ` +
        'reduce the prestage scope or remove stale cache entries before the offline run',
    );
  }
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) throw new Error('repository migration prestage cache requires O_NOFOLLOW support');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    const stat = fs.fstatSync(fd);
    assertHostOwnedPrivateRegularFile(stat, temporary);
    fs.writeFileSync(fd, bytes);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
      fd = undefined;
    }
    fs.renameSync(temporary, file);
    const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // The temporary file was atomically published or was never created.
    fs.rmSync(temporary, { force: true });
  }
}

function effectiveUid(): number {
  if (typeof process.geteuid !== 'function') {
    throw new Error('repository migration prestage cache requires a POSIX effective UID');
  }
  return process.geteuid();
}

function ensureHostOnlyCacheParent(directory: string, create: boolean): void {
  const expected = path.resolve(directory);
  if (create) fs.mkdirSync(expected, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(expected);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o7777) !== 0o700 ||
    stat.uid !== effectiveUid() ||
    fs.realpathSync(expected) !== expected
  ) {
    throw new Error(`repository migration prestage cache parent is not a host-only 0700 directory: ${directory}`);
  }
}

function assertHostOwnedPrivateRegularFile(stat: fs.Stats, file: string): void {
  if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.uid !== effectiveUid()) {
    throw new Error(`repository migration prestage cache is not a regular 0600 file: ${file}`);
  }
}

function readCacheFile(file: string): Buffer {
  ensureHostOnlyCacheParent(path.dirname(file), false);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (!noFollow) throw new Error('repository migration prestage cache requires O_NOFOLLOW support');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    assertHostOwnedPrivateRegularFile(stat, file);
    if (stat.size > MAX_CACHE_DOCUMENT_BYTES) {
      throw new Error(
        `repository migration prestage cache is ${stat.size} bytes, above the ${MAX_CACHE_DOCUMENT_BYTES}-byte limit; ` +
          'remove it and re-run --prestage before taking the fleet offline',
      );
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function cacheabilityFailure(identity: PrestagedFileIdentity): string | null {
  if (!withinUtf8Limit(identity.path, MAX_CACHE_PATH_BYTES)) {
    return `path exceeds ${MAX_CACHE_PATH_BYTES} UTF-8 bytes`;
  }
  if (
    identity.type === 'symlink' &&
    (!identity.symlinkTargetBase64 || !validBase64(identity.symlinkTargetBase64, MAX_SYMLINK_TARGET_BYTES))
  ) {
    return `symlink target exceeds ${MAX_SYMLINK_TARGET_BYTES} bytes or is not canonical base64`;
  }
  return null;
}

/**
 * Cache persisted between a live prestage and a later offline migration.
 * Its contents are advisory only; malformed or unsafe persisted state is
 * rejected before a final offline run can consume it.
 */
export class RepositoryMigrationPrestageCache {
  private readonly entries = new Map<string, PrestagedFileEntry>();
  private readonly counters = {
    reusedEntries: 0,
    reusedBytes: 0,
    rehashedEntries: 0,
    rehashedBytes: 0,
    prunedEntries: 0,
    uncacheableEntries: 0,
  };
  private readonly touched = new Set<string>();
  private readonly uncacheableReasons = new Map<string, number>();
  private dirty = false;

  constructor(
    private readonly cachePath: string,
    initialEntries: readonly PrestagedFileEntry[] = [],
  ) {
    for (const entry of initialEntries) this.entries.set(entry.path, entry);
  }

  private recordUncacheable(reason: string): void {
    this.counters.uncacheableEntries += 1;
    this.uncacheableReasons.set(reason, (this.uncacheableReasons.get(reason) ?? 0) + 1);
  }

  private makeRoomForNewEntry(): boolean {
    while (this.entries.size >= MAX_CACHE_ENTRIES) {
      const stale = [...this.entries.keys()].find((entryPath) => !this.touched.has(entryPath));
      if (!stale) return false;
      this.entries.delete(stale);
      this.counters.prunedEntries += 1;
      this.dirty = true;
    }
    return true;
  }

  hash(file: string, expectedType: PrestagedFileType): PrestagedFileHash {
    // A live prestage can race normal work. Never save a digest unless the
    // post-read identity is byte-for-byte identical to the pre-read identity.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = snapshot(file, expectedType);
      const cached = this.entries.get(before.path);
      const size = numberSize(BigInt(before.size), before.path);
      this.touched.add(before.path);
      if (cached && sameIdentity(cached, before)) {
        this.counters.reusedEntries += 1;
        this.counters.reusedBytes += size;
        return {
          type: before.type,
          mode: before.mode,
          size,
          sha256: cached.sha256,
          ...(before.symlinkTargetBase64 === undefined ? {} : { symlinkTargetBase64: before.symlinkTargetBase64 }),
          reused: true,
        };
      }

      const bytes =
        before.type === 'symlink' ? Buffer.from(before.symlinkTargetBase64!, 'base64') : fs.readFileSync(before.path);
      const after = snapshot(before.path, expectedType);
      if (!sameIdentity(before, after)) continue;

      const entry: PrestagedFileEntry = { ...after, sha256: sha256(bytes) };
      const cacheability = cacheabilityFailure(entry);
      if (cacheability) {
        this.recordUncacheable(cacheability);
      } else if (this.entries.has(entry.path) || this.makeRoomForNewEntry()) {
        this.entries.set(entry.path, entry);
        this.dirty = true;
      } else {
        this.recordUncacheable(`entry count exceeds ${MAX_CACHE_ENTRIES}`);
      }
      this.counters.rehashedEntries += 1;
      this.counters.rehashedBytes += size;
      return {
        type: after.type,
        mode: after.mode,
        size,
        sha256: entry.sha256,
        ...(after.symlinkTargetBase64 === undefined ? {} : { symlinkTargetBase64: after.symlinkTargetBase64 }),
        reused: false,
      };
    }
    throw new Error(`repository migration prestage file changed repeatedly while hashing: ${path.resolve(file)}`);
  }

  stats(): RepositoryMigrationPrestageStats {
    return { entries: this.entries.size, ...this.counters };
  }

  flush(options: { pruneUntouched?: boolean } = {}): void {
    if (options.pruneUntouched) {
      for (const entryPath of this.entries.keys()) {
        if (this.touched.has(entryPath)) continue;
        this.entries.delete(entryPath);
        this.counters.prunedEntries += 1;
        this.dirty = true;
      }
      if (this.counters.uncacheableEntries > 0) {
        const reasons = [...this.uncacheableReasons.entries()]
          .map(([reason, count]) => `${count} ${reason}`)
          .join('; ');
        throw new Error(
          `repository migration prestage cache could not safely store ${this.counters.uncacheableEntries} current entry(s): ` +
            `${reasons}. Narrow the prestage scope or adjust the bounded cache before taking the fleet offline.`,
        );
      }
    }
    if (!this.dirty) return;
    const entries = [...this.entries.values()].sort((left, right) => left.path.localeCompare(right.path));
    writeAtomically(this.cachePath, {
      version: 1,
      entries,
      entriesSha256: entriesSha256(entries),
    });
    this.dirty = false;
  }
}

export function loadRepositoryMigrationPrestageCache(cachePath: string): RepositoryMigrationPrestageCache {
  const resolved = path.resolve(cachePath);
  let entries: PrestagedFileEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(readCacheFile(resolved).toString('utf8'));
    if (!isCacheDocument(parsed)) throw new Error(`repository migration prestage cache schema is invalid: ${resolved}`);
    entries = parsed.entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return new RepositoryMigrationPrestageCache(resolved, entries);
}
