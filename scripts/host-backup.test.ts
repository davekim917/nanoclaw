import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock } from '../src/file-lock.js';

import {
  globToRegExp,
  readManifest,
  restore,
  runBackup,
  scanSources,
  snapshotSqlite,
  type BackupConfig,
  type ObjectVersion,
  type RestoreSource,
  type Uploader,
} from './host-backup.js';

let tmp: string;
let src: string;
let config: BackupConfig;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-backup-'));
  src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  config = { bucket: 'b', region: 'r', stateDir: path.join(tmp, 'state'), sources: [src] };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

/** A versioned bucket in memory: every upload is a new version stamped by one shared clock. */
class FakeBucket implements Uploader, RestoreSource {
  versions = new Map<string, { body: Buffer; at: string; id: string }[]>();
  tick = 0;
  failNextTree = false;
  partialFailNextTree = false;

  private put(key: string, body: Buffer) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++)).toISOString();
    const list = this.versions.get(key) ?? [];
    list.push({ body, at, id: `v${this.tick}` });
    this.versions.set(key, list);
  }

  current(key: string): Buffer | undefined {
    return this.versions.get(key)?.at(-1)?.body;
  }

  async uploadTree(dir: string, prefix: string) {
    if (this.failNextTree) {
      this.failNextTree = false;
      throw new Error('simulated upload failure');
    }
    const walk = (d: string) => {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else this.put(prefix + path.relative(dir, p), fs.readFileSync(p));
      }
    };
    walk(dir);
    if (this.partialFailNextTree) {
      this.partialFailNextTree = false;
      throw new Error('simulated failure after some files landed');
    }
  }

  async uploadFile(file: string, key: string) {
    this.put(key, fs.readFileSync(file));
  }

  async listManifests() {
    return [...this.versions]
      .filter(([k]) => k.startsWith('manifests/'))
      .map(([key, v]) => ({ key, lastModified: v.at(-1)!.at }));
  }

  async listVersions(prefix: string): Promise<ObjectVersion[]> {
    return [...this.versions]
      .filter(([k]) => k.startsWith(prefix))
      .flatMap(([Key, list]) => list.map((v) => ({ Key, VersionId: v.id, LastModified: v.at })));
  }

  async getObject(key: string, versionId: string | null, dest: string) {
    const list = this.versions.get(key) ?? [];
    const v = versionId ? list.find((x) => x.id === versionId) : list.at(-1);
    if (!v) throw new Error(`no such object ${key}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, v.body);
  }
}

const keyOf = (p: string) => `files/${p.replace(/^\/+/, '')}`;

async function manifestOf(bucket: FakeBucket, runId: string) {
  const file = path.join(tmp, `${runId}.jsonl.gz`);
  fs.writeFileSync(file, bucket.current(`manifests/${runId}.jsonl.gz`)!);
  return readManifest(file);
}
const quiet = { log: () => {}, remoteCheck: () => false };

describe('globToRegExp', () => {
  it('lets ** cross directories and keeps * and ? inside one segment', () => {
    expect(globToRegExp('/a/**/node_modules').test('/a/x/y/node_modules')).toBe(true);
    expect(globToRegExp('/a/*/worktrees').test('/a/x/worktrees')).toBe(true);
    expect(globToRegExp('/a/*/worktrees').test('/a/x/y/worktrees')).toBe(false);
    expect(globToRegExp('/a/v2.db.pre-*').test('/a/v2.db.pre-x')).toBe(true);
    expect(globToRegExp('/a/v?.db').test('/a/v2.db')).toBe(true);
    expect(globToRegExp('/a/v2.db').test('/a/v2xdb')).toBe(false);
  });
});

describe('scanSources', () => {
  it('prunes excluded paths, nested clones with a remote, and SQLite sidecars', () => {
    write('keep.txt', 'k');
    write('node_modules/x.js', 'x');
    write('clone/.git/HEAD', 'ref');
    write('clone/file.txt', 'c');
    write('local-repo/.git/HEAD', 'ref');
    write('local-repo/work.txt', 'w');
    write('db.sqlite-journal', '');
    const sqlite = new Database(path.join(src, 'db.sqlite'));
    sqlite.exec('CREATE TABLE t (x)');
    sqlite.close();
    write('orphan-journal', 'no sibling, so kept');
    fs.symlinkSync('keep.txt', path.join(src, 'link'));

    const scan = scanSources([src], ['**/node_modules'], (dir) => dir.endsWith('clone'));
    const rel = scan.files.map((f) => path.relative(src, f.path)).sort();
    expect(rel).toEqual([
      'db.sqlite',
      'keep.txt',
      'link',
      'local-repo/.git/HEAD',
      'local-repo/work.txt',
      'orphan-journal',
    ]);
    expect(scan.skippedClones).toEqual([path.join(src, 'clone')]);
    expect(scan.files.find((f) => f.path.endsWith('link'))).toMatchObject({ kind: 'symlink', target: 'keep.txt' });
  });

  it('skips Python virtualenvs and bare repositories with a remote', () => {
    write('keep.txt', 'k');
    write('tools/venv/pyvenv.cfg', 'home = /usr/bin');
    write('tools/venv/lib/site.py', 'x');
    write('mirrors/app.git/HEAD', 'ref');
    write('mirrors/app.git/objects/pack/p.pack', 'x');
    write('mirrors/app.git/refs/heads/main', 'sha');
    const scan = scanSources([src], [], (dir) => dir.endsWith('app.git'));
    expect(scan.files.map((f) => path.relative(src, f.path))).toEqual(['keep.txt']);
    expect(scan.skippedVenvs).toEqual([path.join(src, 'tools', 'venv')]);
    expect(scan.skippedClones).toEqual([path.join(src, 'mirrors', 'app.git')]);
  });

  it('keeps a source root that is itself a clone, minus its .git', () => {
    write('.git/HEAD', 'ref');
    write('untracked-config.json', '{}');
    const scan = scanSources([src], [], () => true);
    expect(scan.files.map((f) => path.relative(src, f.path))).toEqual(['untracked-config.json']);
  });

  it('keeps a -journal file whose sibling is not a SQLite database', () => {
    write('customer', 'plain text');
    write('customer-journal', 'notes');
    const scan = scanSources([src], [], () => false);
    expect(scan.files.map((f) => path.relative(src, f.path)).sort()).toEqual(['customer', 'customer-journal']);
  });

  it('withholds a sidecar and fails when its database cannot be read', () => {
    if (process.getuid?.() === 0) return;
    const dbPath = path.join(src, 'app.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (x)');
    db.close();
    write('app.db-journal', 'hot journal bytes');
    fs.chmodSync(dbPath, 0o000);
    try {
      const scan = scanSources([src], [], () => false);
      expect(scan.files.map((f) => path.relative(src, f.path))).toEqual([]);
      expect(scan.unreadable.sort()).toEqual([dbPath, path.join(src, 'app.db-journal')].sort());
    } finally {
      fs.chmodSync(dbPath, 0o644);
    }
  });

  it('classifies a SQLite file by its header, not its name', () => {
    const db = new Database(path.join(src, 'data.bin'));
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    db.close();
    const scan = scanSources([src], [], () => false);
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0].kind).toBe('sqlite');
  });

  it('reports a source it may not stat as unreadable instead of throwing', () => {
    const locked = path.join(tmp, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'f'), 'x');
    fs.chmodSync(locked, 0o000);
    try {
      const scan = scanSources([path.join(locked, 'f'), src], [], () => false);
      expect(scan.unreadable).toEqual(process.getuid?.() === 0 ? [] : [path.join(locked, 'f')]);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });

  it('lists a path once when sources overlap', () => {
    write('dir/a.txt', 'a');
    const scan = scanSources([src, path.join(src, 'dir')], [], () => false);
    expect(scan.files.map((f) => f.path)).toEqual([path.join(src, 'dir', 'a.txt')]);
  });

  it('fails a file name that is not valid UTF-8 instead of silently skipping it', () => {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${src}/`), Buffer.from([0xff, 0x2e, 0x74])]), 'x');
    const scan = scanSources([src], [], () => false);
    expect(scan.files).toEqual([]);
    expect(scan.unreadable).toHaveLength(1);
  });

  it('reports a missing source as unreadable', () => {
    const scan = scanSources([path.join(tmp, 'nope')], [], () => false);
    expect(scan.unreadable).toEqual([path.join(tmp, 'nope')]);
  });
});

describe('runBackup', () => {
  it('uploads everything once, then only what changed, and tombstones what disappeared', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'one');
    const b = write('dir/b.txt', 'two');

    const first = await runBackup(config, { uploader: bucket, ...quiet });
    expect(first.uploadedFiles).toBe(2);
    expect(first.failures).toEqual([]);
    expect(bucket.current(keyOf(a))?.toString()).toBe('one');

    const second = await runBackup(config, { uploader: bucket, ...quiet });
    expect(second.uploadedFiles).toBe(0);
    expect(bucket.versions.get(keyOf(a))).toHaveLength(1);

    fs.writeFileSync(a, 'one, edited');
    fs.rmSync(b);
    const third = await runBackup(config, { uploader: bucket, ...quiet });
    expect(third.uploadedFiles).toBe(1);
    expect(third.tombstoned).toBe(1);
    expect(bucket.current(keyOf(a))?.toString()).toBe('one, edited');
    expect(bucket.current(keyOf(b))?.length).toBe(0);
    expect((await manifestOf(bucket, third.runId)).entries.map((e) => e.path)).toEqual([a]);
  });

  it('does not re-upload a file whose mtime moved but whose content did not', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'same');
    await runBackup(config, { uploader: bucket, ...quiet });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(a, later, later);
    const again = await runBackup(config, { uploader: bucket, ...quiet });
    expect(again.uploadedFiles).toBe(0);
    expect(bucket.versions.get(keyOf(a))).toHaveLength(1);
  });

  it('retries a failed batch on the next run and reports the failure', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'one');
    bucket.failNextTree = true;
    const failed = await runBackup(config, { uploader: bucket, ...quiet });
    expect(failed.failures).toHaveLength(1);
    expect((await manifestOf(bucket, failed.runId)).entries).toEqual([]);
    const retried = await runBackup(config, { uploader: bucket, ...quiet });
    expect(retried.uploadedFiles).toBe(1);
    expect(bucket.current(keyOf(a))?.toString()).toBe('one');
  });

  it('re-uploads after a batch failed partway, even if the content went back to what was last recorded', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'A');
    await runBackup(config, { uploader: bucket, ...quiet });
    fs.writeFileSync(a, 'B');
    bucket.partialFailNextTree = true;
    const failed = await runBackup(config, { uploader: bucket, ...quiet });
    expect(failed.failures).toHaveLength(1);
    expect(bucket.current(keyOf(a))?.toString()).toBe('B');

    fs.writeFileSync(a, 'A');
    const healed = await runBackup(config, { uploader: bucket, ...quiet });
    expect(healed.uploadedFiles).toBe(1);
    expect(bucket.current(keyOf(a))?.toString()).toBe('A');
  });

  it('keeps an unreadable file in the manifest and does not tombstone it', async () => {
    if (process.getuid?.() === 0) return;
    const bucket = new FakeBucket();
    const a = write('a.txt', 'A');
    await runBackup(config, { uploader: bucket, ...quiet });
    fs.chmodSync(a, 0o000);
    fs.utimesSync(a, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    try {
      const result = await runBackup(config, { uploader: bucket, ...quiet });
      expect(result.failures.join('\n')).toMatch(/a\.txt/);
      expect(result.tombstoned).toBe(0);
      expect((await manifestOf(bucket, result.runId)).entries.map((e) => e.path)).toEqual([a]);
      expect(bucket.current(keyOf(a))?.toString()).toBe('A');
    } finally {
      fs.chmodSync(a, 0o644);
    }
  });

  it('keeps directory metadata under a directory that became unreadable', async () => {
    if (process.getuid?.() === 0) return;
    const bucket = new FakeBucket();
    write('outer/inner/f.txt', 'f');
    fs.chmodSync(path.join(src, 'outer', 'inner'), 0o700);
    await runBackup(config, { uploader: bucket, ...quiet });
    fs.chmodSync(path.join(src, 'outer'), 0o000);
    try {
      const result = await runBackup(config, { uploader: bucket, ...quiet });
      expect(result.failures.length).toBeGreaterThan(0);
      const manifest = await manifestOf(bucket, result.runId);
      const inner = manifest.dirs.find((d) => d.path === path.join(src, 'outer', 'inner'));
      expect(inner && inner.mode & 0o777).toBe(0o700);
      expect(manifest.entries.map((e) => e.path)).toEqual([path.join(src, 'outer', 'inner', 'f.txt')]);
    } finally {
      fs.chmodSync(path.join(src, 'outer'), 0o755);
    }
  });

  it('refuses to start while another run holds the lock', async () => {
    fs.mkdirSync(config.stateDir, { recursive: true });
    await withFileLock(path.join(config.stateDir, 'run.lock'), async () => {
      await expect(runBackup(config, { uploader: new FakeBucket(), ...quiet })).rejects.toThrow(/run lock/);
    });
    const result = await runBackup(config, { uploader: new FakeBucket(), ...quiet });
    expect(result.failures).toEqual([]);
  });

  it('keeps every SQLite copy of a chunk when a batch fills partway through it', async () => {
    const bucket = new FakeBucket();
    for (const name of ['one.db', 'two.db', 'three.db']) {
      const db = new Database(path.join(src, name));
      db.exec(`CREATE TABLE t (x); INSERT INTO t VALUES ('${name}')`);
      db.close();
    }
    config.batchBytes = 1;
    const result = await runBackup(config, { uploader: bucket, ...quiet });
    expect(result.failures).toEqual([]);
    expect(result.uploadedFiles).toBe(3);
  });

  it('captures a live SQLite database through the backup API, WAL content included', async () => {
    const bucket = new FakeBucket();
    const dbPath = path.join(src, 'live.db');
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3)');
    try {
      const result = await runBackup(config, { uploader: bucket, ...quiet });
      expect(result.failures).toEqual([]);
      const copy = path.join(tmp, 'copy.db');
      fs.writeFileSync(copy, bucket.current(keyOf(dbPath))!);
      const check = new Database(copy, { readonly: true });
      expect(check.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 3 });
      check.close();
      expect([...bucket.versions.keys()].some((k) => k.endsWith('-wal') || k.endsWith('-shm'))).toBe(false);

      writer.exec('INSERT INTO t VALUES (4)');
      const next = await runBackup(config, { uploader: bucket, ...quiet });
      expect(next.uploadedFiles).toBe(1);
    } finally {
      writer.close();
    }
  });

  it('backs up a command output as a generated file', async () => {
    const bucket = new FakeBucket();
    config.commands = [{ name: 'dump.sql', argv: ['sh', '-c', 'echo dumped'] }];
    const result = await runBackup(config, { uploader: bucket, ...quiet });
    const generated = path.join(config.stateDir, 'generated', 'dump.sql');
    expect(result.failures).toEqual([]);
    expect(bucket.current(keyOf(generated))?.toString()).toBe('dumped\n');
  });

  it('fails the run when a command fails', async () => {
    config.commands = [{ name: 'dump.sql', argv: ['sh', '-c', 'exit 3'] }];
    const result = await runBackup(config, { uploader: new FakeBucket(), ...quiet });
    expect(result.failures[0]).toMatch(/command dump.sql failed: exit 3/);
  });

  it('writes a manifest naming every path and its sha256', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'one');
    const result = await runBackup(config, { uploader: bucket, ...quiet });
    const manifest = await manifestOf(bucket, result.runId);
    expect(manifest.complete).toBe(true);
    expect(manifest.dirs.map((d) => d.path)).toEqual(expect.arrayContaining(['/', path.dirname(src), src]));
    expect(manifest.entries).toEqual([
      expect.objectContaining({
        path: a,
        kind: 'file',
        size: 3,
        sha256: '7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed',
      }),
    ]);
  });
});

describe('snapshotSqlite', () => {
  it('fails rather than producing an empty copy when the source stays locked', async () => {
    const dbPath = path.join(src, 'locked.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1)');
    db.exec('BEGIN EXCLUSIVE; INSERT INTO t VALUES (2)');
    try {
      await expect(snapshotSqlite(dbPath, path.join(tmp, 'out.db'), { busyTimeoutMs: 50 })).rejects.toThrow();
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });

  it('refuses a path that better-sqlite3 would trim', async () => {
    await expect(snapshotSqlite(path.join(src, 'x.db '), path.join(tmp, 'out.db'))).rejects.toThrow(/trims/);
  });

  it('gives up with an error once its time budget is spent', async () => {
    const dbPath = path.join(src, 'busy.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE t (x BLOB)');
    const insert = db.prepare('INSERT INTO t VALUES (randomblob(4096))');
    for (let i = 0; i < 200; i++) insert.run();
    await expect(snapshotSqlite(dbPath, path.join(tmp, 'out.db'), { pagesPerStep: 1, budgetMs: -1 })).rejects.toThrow(
      /not consistent within/,
    );
    db.close();
  });
});

describe('restore', () => {
  it('restores the content a chosen night recorded, not a later version', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'night one');
    await runBackup(config, { uploader: bucket, ...quiet, now: () => new Date('2026-01-01T00:00:00Z') });
    const firstManifest = (await bucket.listManifests())[0];

    fs.writeFileSync(a, 'night two');
    await runBackup(config, { uploader: bucket, ...quiet, now: () => new Date('2026-01-02T00:00:00Z') });

    const dest = path.join(tmp, 'restore');
    const result = await restore(bucket, { dest, asOf: new Date(firstManifest.lastModified), log: () => {} });
    expect(result.failures).toEqual([]);
    expect(fs.readFileSync(path.join(dest, a), 'utf8')).toBe('night one');

    const latest = path.join(tmp, 'restore-latest');
    await restore(bucket, { dest: latest, log: () => {} });
    expect(fs.readFileSync(path.join(latest, a), 'utf8')).toBe('night two');
  });

  it('limits a restore to a prefix and recreates symlinks', async () => {
    const bucket = new FakeBucket();
    write('keep/a.txt', 'a');
    write('other/b.txt', 'b');
    fs.symlinkSync('a.txt', path.join(src, 'keep', 'link'));
    await runBackup(config, { uploader: bucket, ...quiet });
    const dest = path.join(tmp, 'restore');
    const result = await restore(bucket, { dest, prefix: path.join(src, 'keep'), log: () => {} });
    expect(result.restored).toBe(2);
    expect(fs.readlinkSync(path.join(dest, src, 'keep', 'link'))).toBe('a.txt');
    expect(fs.existsSync(path.join(dest, src, 'other'))).toBe(false);
  });

  it('ignores objects under manifests/ that are not run manifests', async () => {
    const bucket = new FakeBucket();
    write('a.txt', 'a');
    await runBackup(config, { uploader: bucket, ...quiet });
    const probe = path.join(tmp, 'probe');
    fs.writeFileSync(probe, 'probe');
    await bucket.uploadFile(probe, 'manifests/_selftest/probe.txt');
    const result = await restore(bucket, { dest: path.join(tmp, 'restore'), log: () => {} });
    expect(result.restored).toBe(1);
  });

  it('refuses a destination that already exists', async () => {
    const dest = path.join(tmp, 'restore');
    fs.mkdirSync(dest);
    await expect(restore(new FakeBucket(), { dest, log: () => {} })).rejects.toThrow(/must not exist/);
  });

  it('restores the parent directory modes of a single restored file', async () => {
    const bucket = new FakeBucket();
    const secret = write('private/secret.txt', 's');
    fs.chmodSync(path.join(src, 'private'), 0o700);
    await runBackup(config, { uploader: bucket, ...quiet });
    const dest = path.join(tmp, 'restore');
    await restore(bucket, { dest, prefix: secret, log: () => {} });
    expect(fs.statSync(path.join(dest, src, 'private')).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dest, secret), 'utf8')).toBe('s');
  });

  it('refuses to reuse upload state recorded against another bucket', async () => {
    await runBackup(config, { uploader: new FakeBucket(), ...quiet });
    await expect(runBackup({ ...config, bucket: 'other' }, { uploader: new FakeBucket(), ...quiet })).rejects.toThrow(
      /fresh stateDir/,
    );
  });

  it('never writes through a restored symlink', async () => {
    const bucket = new FakeBucket();
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(outside);
    write('real/f.txt', 'f');
    fs.symlinkSync(outside, path.join(src, 'link'));
    await runBackup(config, { uploader: bucket, ...quiet });
    const manifestKey = (await bucket.listManifests())[0].key;
    const lines = zlib.gunzipSync(bucket.current(manifestKey)!).toString().trim().split('\n');
    const real = lines.map((l) => JSON.parse(l) as { e?: { path: string } }).find((r) => r.e?.path.endsWith('f.txt'))!;
    const beneathLink = path.join(src, 'link', 'f.txt');
    lines.splice(1, 0, JSON.stringify({ e: { ...real.e, path: beneathLink } }));
    await bucket.uploadFile(path.join(src, 'real', 'f.txt'), keyOf(beneathLink));
    const tampered = path.join(tmp, 'tampered.jsonl.gz');
    fs.writeFileSync(tampered, zlib.gzipSync(`${lines.join('\n')}\n`));
    await bucket.uploadFile(tampered, manifestKey);

    const result = await restore(bucket, { dest: path.join(tmp, 'restore'), log: () => {} });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(result.failures.join('\n')).toMatch(/could not recreate symlink/);
  });

  it('restores directory modes', async () => {
    const bucket = new FakeBucket();
    write('private/secret.txt', 's');
    fs.chmodSync(path.join(src, 'private'), 0o700);
    await runBackup(config, { uploader: bucket, ...quiet });
    const dest = path.join(tmp, 'restore');
    await restore(bucket, { dest, log: () => {} });
    expect(fs.statSync(path.join(dest, src, 'private')).mode & 0o777).toBe(0o700);
  });

  it('refuses a version whose content does not match the manifest hash', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'real');
    await runBackup(config, { uploader: bucket, ...quiet });
    bucket.versions.get(keyOf(a))![0].body = Buffer.from('tampered');
    const result = await restore(bucket, { dest: path.join(tmp, 'restore'), log: () => {} });
    expect(result.failures[0]).toMatch(/no retained version/);
  });
});
