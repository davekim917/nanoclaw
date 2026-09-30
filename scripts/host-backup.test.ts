import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  globToRegExp,
  restore,
  runBackup,
  scanSources,
  snapshotSqlite,
  type BackupConfig,
  type Manifest,
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
    write('db.sqlite', 'not really sqlite');
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
    expect(first.manifest.failures).toEqual([]);
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
    expect(third.manifest.entries.map((e) => e.path)).toEqual([a]);
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
    expect(failed.manifest.failures).toHaveLength(1);
    expect(failed.manifest.entries).toEqual([]);
    const retried = await runBackup(config, { uploader: bucket, ...quiet });
    expect(retried.uploadedFiles).toBe(1);
    expect(bucket.current(keyOf(a))?.toString()).toBe('one');
  });

  it('captures a live SQLite database through the backup API, WAL content included', async () => {
    const bucket = new FakeBucket();
    const dbPath = path.join(src, 'live.db');
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE t (x); INSERT INTO t VALUES (1), (2), (3)');
    try {
      const result = await runBackup(config, { uploader: bucket, ...quiet });
      expect(result.manifest.failures).toEqual([]);
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
    expect(result.manifest.failures).toEqual([]);
    expect(bucket.current(keyOf(generated))?.toString()).toBe('dumped\n');
  });

  it('fails the run when a command fails', async () => {
    config.commands = [{ name: 'dump.sql', argv: ['sh', '-c', 'exit 3'] }];
    const result = await runBackup(config, { uploader: new FakeBucket(), ...quiet });
    expect(result.manifest.failures[0]).toMatch(/command dump.sql failed: exit 3/);
  });

  it('writes a manifest naming every path and its sha256', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'one');
    const result = await runBackup(config, { uploader: bucket, ...quiet });
    const body = bucket.current(`manifests/${result.manifest.runId}.json.gz`)!;
    const manifest = JSON.parse(zlib.gunzipSync(body).toString()) as Manifest;
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

  it('refuses a version whose content does not match the manifest hash', async () => {
    const bucket = new FakeBucket();
    const a = write('a.txt', 'real');
    await runBackup(config, { uploader: bucket, ...quiet });
    bucket.versions.get(keyOf(a))![0].body = Buffer.from('tampered');
    const result = await restore(bucket, { dest: path.join(tmp, 'restore'), log: () => {} });
    expect(result.failures[0]).toMatch(/no retained version/);
  });
});
