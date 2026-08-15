import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  captureCheckout,
  prestageLegacyCheckoutFileHashes,
  type LegacyCheckoutCandidate,
} from './repository-migration.js';
import {
  MAX_CACHE_DOCUMENT_BYTES,
  MAX_CACHE_PATH_BYTES,
  MAX_SYMLINK_TARGET_BYTES,
  loadRepositoryMigrationPrestageCache,
} from './repository-migration-prestage.js';
import { resolveRepositoryWorkUnit } from './repository-workspaces.js';

let root: string;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function candidate(checkoutPath: string): LegacyCheckoutCandidate {
  return {
    workgroupId: 'wg-prestage',
    repo: 'prestage-repo',
    checkoutPath,
    workUnit: resolveRepositoryWorkUnit({
      workgroupId: 'wg-prestage',
      sessionId: 'session-prestage',
      platformId: 'slack:C1',
      messagingGroupId: 'mg-prestage',
      threadId: 'thread-prestage',
    }),
  };
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

function cacheEnvelope(entries: unknown[]): string {
  const entriesSha256 = createHash('sha256')
    .update(canonicalJson({ version: 1, entries }))
    .digest('hex');
  return JSON.stringify({ version: 1, entries, entriesSha256 });
}

function writePrivateCache(cachePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(cachePath), 0o700);
  fs.writeFileSync(cachePath, contents, { mode: 0o600 });
  fs.chmodSync(cachePath, 0o600);
}

function currentEuid(): number {
  if (!process.geteuid) throw new Error('test requires a POSIX effective UID');
  return process.geteuid();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-migration-prestage-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('repository migration live prestage cache', () => {
  it('reuses only an exact stat-and-symlink identity during the final capture', () => {
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    git(checkout, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked\n');
    git(checkout, ['add', 'tracked.txt']);
    git(checkout, ['commit', '-q', '-m', 'base']);
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'oneone\n');
    fs.symlinkSync('untracked.txt', path.join(checkout, 'visible-link'));
    const uncached = captureCheckout(candidate(checkout));

    const cachePath = path.join(root, 'host-only-cache', 'file-hashes-v1.json');
    const prestage = loadRepositoryMigrationPrestageCache(cachePath);
    const staged = prestageLegacyCheckoutFileHashes(candidate(checkout), prestage);
    expect(staged.files).toBe(3);
    expect(staged.rehashedFiles).toBe(3);
    expect(git(checkout, ['for-each-ref', '--format=%(refname)', 'refs/nanoclaw-rescue'])).toBe('');
    expect(fs.existsSync(path.join(root, 'data', 'repositories'))).toBe(false);
    prestage.flush({ pruneUntouched: true });
    expect(fs.existsSync(cachePath)).toBe(true);
    expect(fs.lstatSync(cachePath).mode & 0o7777).toBe(0o600);
    expect(fs.lstatSync(cachePath).uid).toBe(currentEuid());
    expect(fs.lstatSync(path.dirname(cachePath)).mode & 0o7777).toBe(0o700);
    expect(fs.lstatSync(path.dirname(cachePath)).uid).toBe(currentEuid());

    const finalCache = loadRepositoryMigrationPrestageCache(cachePath);
    const firstFinal = captureCheckout(candidate(checkout), undefined, { fileHashCache: finalCache });
    expect(finalCache.stats()).toMatchObject({ reusedEntries: 3, rehashedEntries: 0 });
    expect(firstFinal).toEqual(uncached);
    expect(firstFinal.files.map((entry) => entry.path)).toEqual(['tracked.txt', 'untracked.txt', 'visible-link']);

    fs.unlinkSync(path.join(checkout, 'visible-link'));
    fs.symlinkSync('tracked.txt', path.join(checkout, 'visible-link'));
    fs.writeFileSync(path.join(checkout, 'untracked.txt'), 'twotwo\n');
    const changed = captureCheckout(candidate(checkout), undefined, { fileHashCache: finalCache });
    expect(finalCache.stats()).toMatchObject({ reusedEntries: 4, rehashedEntries: 2 });
    expect(changed.files.find((entry) => entry.path === 'untracked.txt')?.sha256).toBe(
      createHash('sha256').update('twotwo\n').digest('hex'),
    );
    expect(changed.files.find((entry) => entry.path === 'untracked.txt')?.size).toBe(
      firstFinal.files.find((entry) => entry.path === 'untracked.txt')?.size,
    );
    expect(changed.files.find((entry) => entry.path === 'visible-link')?.symlinkTarget).toBe('tracked.txt');

    git(checkout, ['switch', '-q', '-c', 'fresh-final-capture']);
    fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'new committed HEAD\n');
    git(checkout, ['add', 'tracked.txt']);
    git(checkout, ['commit', '-q', '-m', 'fresh final state']);
    fs.unlinkSync(path.join(checkout, 'untracked.txt'));
    fs.writeFileSync(path.join(checkout, 'new-path.txt'), 'new path\n');
    const fresh = captureCheckout(candidate(checkout), undefined, { fileHashCache: finalCache });
    expect(fresh.head).not.toBe(firstFinal.head);
    expect(fresh.branch).toBe('fresh-final-capture');
    expect(fresh.indexEntriesZBase64).not.toBe(firstFinal.indexEntriesZBase64);
    expect(fresh.statusZBase64).not.toBe(firstFinal.statusZBase64);
    expect(fresh.files.map((entry) => entry.path)).toEqual(['new-path.txt', 'tracked.txt', 'visible-link']);
  });

  it('does not reuse a digest for a different path, even when files share an inode', () => {
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(first, 'same inode\n');
    fs.linkSync(first, second);

    const cache = loadRepositoryMigrationPrestageCache(path.join(root, 'cache.json'));
    expect(cache.hash(first, 'file').reused).toBe(false);
    expect(cache.hash(second, 'file').reused).toBe(false);
    expect(cache.stats()).toMatchObject({ rehashedEntries: 2, reusedEntries: 0 });
  });

  it('rehashes inode, mode, and type replacements even when names and sizes remain stable', () => {
    const file = path.join(root, 'replacement');
    const temporary = path.join(root, 'replacement-next');
    fs.writeFileSync(file, 'same-size\n', { mode: 0o600 });
    const cache = loadRepositoryMigrationPrestageCache(path.join(root, 'cache.json'));
    cache.hash(file, 'file');

    fs.writeFileSync(temporary, 'same-size\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
    expect(cache.hash(file, 'file').reused).toBe(false);
    fs.chmodSync(file, 0o640);
    expect(cache.hash(file, 'file').reused).toBe(false);

    const link = path.join(root, 'type-change');
    fs.symlinkSync('replacement', link);
    cache.hash(link, 'symlink');
    fs.unlinkSync(link);
    fs.writeFileSync(link, 'replacement\n');
    expect(cache.hash(link, 'file').reused).toBe(false);
  });

  it('rejects malformed or unsafe persistent cache state before it can be used', () => {
    const parent = path.join(root, 'host-only-cache');
    fs.mkdirSync(parent, { mode: 0o700 });
    const cachePath = path.join(parent, 'file-hashes-v1.json');
    fs.writeFileSync(cachePath, '{', { mode: 0o600 });
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/schema is invalid|JSON/);

    fs.writeFileSync(cachePath, cacheEnvelope([]), { mode: 0o600 });
    fs.chmodSync(cachePath, 0o644);
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/regular 0600 file/);
    fs.chmodSync(cachePath, 0o600);
    fs.chmodSync(parent, 0o755);
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/host-only 0700 directory/);
  });

  it('rejects checksum tampering and bounded-document/schema violations before cache entries are trusted', () => {
    const parent = path.join(root, 'host-only-cache');
    const cachePath = path.join(parent, 'file-hashes-v1.json');
    const entry = {
      path: '/tmp/valid-cache-path',
      type: 'file',
      dev: '1',
      ino: '2',
      ctimeNs: '3',
      size: '4',
      mode: 0o600,
      sha256: 'a'.repeat(64),
    };
    writePrivateCache(cachePath, cacheEnvelope([entry]));
    const tampered = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { entries: Array<{ sha256: string }> };
    tampered.entries[0].sha256 = 'b'.repeat(64);
    fs.writeFileSync(cachePath, JSON.stringify(tampered), { mode: 0o600 });
    fs.chmodSync(cachePath, 0o600);
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/schema is invalid/);

    const oversizedPath = `/${'x'.repeat(MAX_CACHE_PATH_BYTES)}`;
    writePrivateCache(cachePath, cacheEnvelope([{ ...entry, path: oversizedPath }]));
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/schema is invalid/);

    const oversizedTarget = Buffer.alloc(MAX_SYMLINK_TARGET_BYTES + 1, 0x61).toString('base64');
    writePrivateCache(cachePath, cacheEnvelope([{ ...entry, type: 'symlink', symlinkTargetBase64: oversizedTarget }]));
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/schema is invalid/);

    writePrivateCache(cachePath, cacheEnvelope([]));
    fs.truncateSync(cachePath, MAX_CACHE_DOCUMENT_BYTES + 1);
    expect(() => loadRepositoryMigrationPrestageCache(cachePath)).toThrow(/above the .*byte limit/);
  });

  it('rejects cache and parent symlinks and prunes untouched entries from a completed prestage', () => {
    const cachePath = path.join(root, 'host-only-cache', 'file-hashes-v1.json');
    const keep = path.join(root, 'keep.txt');
    const stale = path.join(root, 'stale.txt');
    fs.writeFileSync(keep, 'keep\n');
    fs.writeFileSync(stale, 'stale\n');
    const initial = loadRepositoryMigrationPrestageCache(cachePath);
    initial.hash(keep, 'file');
    initial.hash(stale, 'file');
    initial.flush();

    const current = loadRepositoryMigrationPrestageCache(cachePath);
    expect(current.hash(keep, 'file').reused).toBe(true);
    current.flush({ pruneUntouched: true });
    expect(current.stats().prunedEntries).toBe(1);
    const pruned = loadRepositoryMigrationPrestageCache(cachePath);
    expect(pruned.hash(stale, 'file').reused).toBe(false);

    const target = path.join(root, 'target-cache');
    fs.writeFileSync(target, cacheEnvelope([]), { mode: 0o600 });
    const symlinkParent = path.join(root, 'symlink-parent');
    fs.symlinkSync(path.dirname(cachePath), symlinkParent);
    expect(() => loadRepositoryMigrationPrestageCache(path.join(symlinkParent, 'file-hashes-v1.json'))).toThrow(
      /host-only 0700 directory/,
    );

    const symlinkCache = path.join(root, 'host-only-cache', 'symlink-cache.json');
    fs.symlinkSync(target, symlinkCache);
    expect(() => loadRepositoryMigrationPrestageCache(symlinkCache)).toThrow();
  });
});
