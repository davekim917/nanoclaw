#!/usr/bin/env tsx
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';

import { withFileLock } from '../src/file-lock.js';

const DEFAULT_CONFIG_PATH = '/etc/nanoclaw-backup/config.json';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SQLITE_SIDECARS = ['-journal', '-wal', '-shm'];
const MAX_KEY_PATH_BYTES = 1000;
const DEFAULT_BATCH_BYTES = 8 * 1024 ** 3;
const SQLITE_CHUNK_FILES = 200;
const BATCH_FILES = 50_000;
const MANIFEST_KEY = /^manifests\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.jsonl\.gz$/;

export interface BackupConfig {
  bucket: string;
  region: string;
  stateDir: string;
  sources: string[];
  exclude?: string[];
  commands?: { name: string; argv: string[] }[];
  gated?: { flag: string; sources?: string[]; exclude?: string[]; commands?: { name: string; argv: string[] }[] }[];
  batchBytes?: number;
}

export function applyGates(config: BackupConfig): BackupConfig {
  const merged = { ...config, exclude: [...(config.exclude ?? [])], commands: [...(config.commands ?? [])] };
  for (const gate of config.gated ?? []) {
    const flag = fs.lstatSync(gate.flag, { throwIfNoEntry: false });
    if (!flag?.isFile() || (process.getuid?.() === 0 && flag.uid !== 0)) continue;
    merged.sources = [...merged.sources, ...(gate.sources ?? [])];
    merged.exclude.push(...(gate.exclude ?? []));
    merged.commands.push(...(gate.commands ?? []));
  }
  const bad = merged.commands.find((cmd) => cmd.name !== path.basename(cmd.name) || /^\.*$/.test(cmd.name));
  if (bad) throw new Error(`command name ${JSON.stringify(bad.name)} must be a plain file name`);
  return merged;
}

type EntryKind = 'file' | 'sqlite' | 'symlink';

interface ManifestEntry {
  path: string;
  kind: EntryKind;
  size: number;
  sha256: string;
  mode: number;
  uid: number;
  gid: number;
  mtimeMs: number;
  target?: string;
}

interface StateEntry extends ManifestEntry {
  stamp: string;
}

interface DirEntry {
  path: string;
  mode: number;
  uid: number;
  gid: number;
}

interface Manifest {
  runId: string;
  hostname: string;
  startedAt: string;
  finishedAt: string;
  failures: string[];
  entries: ManifestEntry[];
  dirs: DirEntry[];
}

interface FileStat {
  size: number;
  mtimeMs: number;
  mode: number;
  uid: number;
  gid: number;
}

interface ScannedFile {
  path: string;
  kind: EntryKind;
  stat: FileStat;
  stamp: string;
  target?: string;
}

interface ScanReport {
  unreadable: string[];
  skippedClones: string[];
  skippedVenvs: string[];
  warnings: string[];
}

interface Scan extends ScanReport {
  files: ScannedFile[];
  dirs: DirEntry[];
}

type ScanItem = { dir: DirEntry } | { file: ScannedFile };

export interface Uploader {
  uploadTree(dir: string, prefix: string): Promise<void>;
  uploadFile(file: string, key: string): Promise<void>;
}

type SqliteSnapshotter = (
  jobs: { src: string; dest: string; uid: number; gid: number }[],
) => Promise<Map<string, string | null>>;

export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i++;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function hasRemote(dir: string): boolean {
  const res = spawnSync('git', ['-c', 'safe.directory=*', '-C', dir, 'remote'], { encoding: 'utf8' });
  return res.status === 0 && res.stdout.trim() !== '';
}

function hasSqliteMagic(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.equals(SQLITE_MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

function sqliteHeader(file: string): 'sqlite' | 'other' | 'missing' | 'unreadable' {
  try {
    return hasSqliteMagic(file) ? 'sqlite' : 'other';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function statStamp(st: fs.Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}:${st.mode}:${st.uid}:${st.gid}`;
}

function sqliteStamp(file: string, st: fs.Stats): string {
  const wal = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
  return `${statStamp(st)}|${wal ? statStamp(wal) : '-'}`;
}

const slim = (st: fs.Stats): FileStat => ({
  size: st.size,
  mtimeMs: st.mtimeMs,
  mode: st.mode,
  uid: st.uid,
  gid: st.gid,
});

function* walkSources(
  sources: string[],
  exclude: string[],
  report: ScanReport,
  remoteCheck: (dir: string) => boolean = hasRemote,
  knownKind: (file: string, stamp: string) => EntryKind | undefined = () => undefined,
): Generator<ScanItem> {
  const excludes = exclude.map(globToRegExp);
  const excluded = (p: string) => excludes.some((re) => re.test(p));
  const walked = new Set<string>();
  const fileSources = new Set(sources.map((src) => path.resolve(src)));
  const emittedFileSources = new Set<string>();
  const emittedDirs = new Set<string>();
  const lossless = (raw: Buffer, where: string): string | undefined => {
    const text = raw.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(raw)) return text;
    report.unreadable.push(where);
    report.warnings.push(`cannot back up a name that is not valid UTF-8: ${JSON.stringify(where)}`);
    return undefined;
  };
  const readNames = (dir: string): string[] =>
    fs
      .readdirSync(dir, { encoding: 'buffer' })
      .map((raw) => lossless(raw, path.join(dir, raw.toString('latin1'))))
      .filter((name): name is string => name !== undefined);
  const dirItem = (dir: string): ScanItem | undefined => {
    if (emittedDirs.has(dir)) return undefined;
    emittedDirs.add(dir);
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    return st ? { dir: { path: dir, mode: st.mode, uid: st.uid, gid: st.gid } } : undefined;
  };

  const visitFile = (p: string, st: fs.Stats, siblings: Set<string>): ScannedFile | undefined => {
    if (fileSources.has(p)) {
      if (emittedFileSources.has(p)) return undefined;
      emittedFileSources.add(p);
    }
    if (Buffer.byteLength(p) > MAX_KEY_PATH_BYTES || /[\p{Cc}\\]/u.test(p)) {
      report.unreadable.push(p);
      report.warnings.push(
        `cannot back up (path cannot be an S3 key as-is; rename or exclude it): ${JSON.stringify(p)}`,
      );
      return undefined;
    }
    if (st.isSymbolicLink()) {
      const target = lossless(fs.readlinkSync(p, { encoding: 'buffer' }), p);
      return target === undefined
        ? undefined
        : { path: p, kind: 'symlink', stat: slim(st), stamp: statStamp(st), target };
    }
    if (!st.isFile()) return undefined;
    const base = path.basename(p);
    const sidecar = SQLITE_SIDECARS.find((s) => base.endsWith(s));
    const owner = sidecar ? path.join(path.dirname(p), base.slice(0, -sidecar.length)) : '';
    if (sidecar && siblings.has(path.basename(owner))) {
      const probe = sqliteHeader(owner);
      if (probe === 'sqlite') return undefined;
      if (probe === 'unreadable') {
        report.unreadable.push(p);
        report.warnings.push(`cannot tell whether ${p} is a SQLite sidecar: ${owner} is unreadable`);
        return undefined;
      }
    }
    let isSqlite: boolean;
    try {
      const known = knownKind(p, statStamp(st));
      isSqlite = known ? known === 'sqlite' : st.size >= 512 && hasSqliteMagic(p);
    } catch (err) {
      report.unreadable.push(p);
      report.warnings.push(`unreadable file ${p}: ${message(err)}`);
      return undefined;
    }
    return {
      path: p,
      kind: isSqlite ? 'sqlite' : 'file',
      stat: slim(st),
      stamp: isSqlite ? sqliteStamp(p, st) : statStamp(st),
    };
  };

  function* visitDir(dir: string, isRoot: boolean): Generator<ScanItem> {
    if (walked.has(dir)) return;
    const self = dirItem(dir);
    if (self) yield self;
    let names: string[];
    try {
      names = readNames(dir);
    } catch (err) {
      report.unreadable.push(dir);
      report.warnings.push(`unreadable directory ${dir}: ${message(err)}`);
      return;
    }
    const siblings = new Set(names);
    if (!isRoot && siblings.has('pyvenv.cfg')) {
      report.skippedVenvs.push(dir);
      return;
    }
    const isBareRepo = siblings.has('HEAD') && siblings.has('objects') && siblings.has('refs');
    const skipGitDir = (siblings.has('.git') || isBareRepo) && remoteCheck(dir);
    if (skipGitDir && (!isRoot || isBareRepo)) {
      report.skippedClones.push(dir);
      return;
    }
    walked.add(dir);
    for (const name of names.sort()) {
      if (skipGitDir && name === '.git') continue;
      const p = path.join(dir, name);
      if (excluded(p)) continue;
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(p, { throwIfNoEntry: false });
      } catch (err) {
        report.unreadable.push(p);
        report.warnings.push(`unreadable path ${p}: ${message(err)}`);
        continue;
      }
      if (!st) continue;
      if (st.isDirectory()) yield* visitDir(p, false);
      else {
        const file = visitFile(p, st, siblings);
        if (file) yield { file };
      }
    }
  }

  for (const src of sources) {
    const root = path.resolve(src);
    if (excluded(root)) continue;
    const ancestors: string[] = [];
    for (let up = path.dirname(root); ; up = path.dirname(up)) {
      ancestors.unshift(up);
      if (up === path.dirname(up)) break;
    }
    for (const dir of ancestors) {
      const item = dirItem(dir);
      if (item) yield item;
    }
    let st: fs.Stats | undefined;
    let siblings = new Set<string>();
    try {
      st = fs.lstatSync(root, { throwIfNoEntry: false });
      if (st && !st.isDirectory()) siblings = new Set(readNames(path.dirname(root)));
    } catch (err) {
      report.unreadable.push(root);
      report.warnings.push(`unreadable source ${root}: ${message(err)}`);
      continue;
    }
    if (!st) {
      report.unreadable.push(root);
      report.warnings.push(`source missing: ${root}`);
    } else if (st.isDirectory()) yield* visitDir(root, true);
    else {
      const file = visitFile(root, st, siblings);
      if (file) yield { file };
    }
  }
}

export function scanSources(sources: string[], exclude: string[], remoteCheck: (dir: string) => boolean): Scan {
  const scan: Scan = { files: [], dirs: [], unreadable: [], skippedClones: [], skippedVenvs: [], warnings: [] };
  for (const item of walkSources(sources, exclude, scan, remoteCheck)) {
    if ('dir' in item) scan.dirs.push(item.dir);
    else scan.files.push(item.file);
  }
  return scan;
}

async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function copyHashed(src: string, dest: string): Promise<{ sha256: string; size: number }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  for await (const chunk of fs.createReadStream(src)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return { sha256: hash.digest('hex'), size };
}

export async function snapshotSqlite(
  src: string,
  dest: string,
  { pagesPerStep = 1024, budgetMs = 10 * 60_000, busyTimeoutMs = 15_000 } = {},
): Promise<void> {
  if (src !== src.trim() || dest !== dest.trim()) {
    throw new Error('better-sqlite3 trims file names, so a path with leading or trailing whitespace cannot be copied');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true, fileMustExist: true, timeout: busyTimeoutMs });
  const started = Date.now();
  let restarts = 0;
  let lastRemaining = Infinity;
  let copied: { totalPages: number; remainingPages: number };
  try {
    copied = await db.backup(dest, {
      progress: ({ remainingPages }) => {
        if (remainingPages > lastRemaining) restarts++;
        lastRemaining = remainingPages;
        if (Date.now() - started > budgetMs) {
          throw new Error(`not consistent within ${budgetMs / 1000}s (writers restarted the copy ${restarts} times)`);
        }
        return pagesPerStep;
      },
    });
  } finally {
    db.close();
  }
  if (copied.totalPages === 0 || !(fs.statSync(dest, { throwIfNoEntry: false })?.size ?? 0)) {
    throw new Error(`backup copied nothing (${copied.totalPages} pages); the source was likely locked throughout`);
  }
  const copy = new Database(dest, { fileMustExist: true });
  try {
    copy.pragma('journal_mode = DELETE');
    const result = copy.pragma('quick_check', { simple: true });
    if (result !== 'ok') throw new Error(`quick_check on the copy returned ${String(result)}`);
  } finally {
    copy.close();
  }
}

async function snapshotInProcess(jobs: { src: string; dest: string }[]): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  for (const job of jobs) {
    try {
      await snapshotSqlite(job.src, job.dest);
      results.set(job.src, null);
    } catch (err) {
      results.set(job.src, message(err));
    }
  }
  return results;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);

function makeSqliteSnapshotter(workDir: string): SqliteSnapshotter {
  return async (jobs) => {
    if (process.getuid?.() !== 0) return snapshotInProcess(jobs);
    const results = new Map<string, string | null>();
    const byOwner = new Map<string, typeof jobs>();
    for (const job of jobs) {
      const key = job.uid === 0 ? '0:0' : `${job.uid}:${job.gid}`;
      byOwner.set(key, [...(byOwner.get(key) ?? []), job]);
    }
    for (const [owner, group] of byOwner) {
      const [uid, gid] = owner.split(':').map(Number);
      if (uid === 0) {
        for (const [k, v] of await snapshotInProcess(group)) results.set(k, v);
        continue;
      }
      const dir = path.join(workDir, String(uid));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(workDir, { recursive: true, mode: 0o711 });
      fs.chmodSync(workDir, 0o711);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.chownSync(dir, uid, gid);
      const work = group.map((job, i) => ({ src: job.src, dest: path.join(dir, `${i}.db`) }));
      const child = spawn(process.execPath, [...process.execArgv, SCRIPT_PATH, 'sqlite-worker'], {
        uid,
        gid,
        stdio: ['pipe', 'pipe', 'inherit'],
        cwd: dir,
      });
      child.stdin.end(JSON.stringify(work));
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? 1)));
      let parsed: Record<string, string | null> = {};
      try {
        parsed = JSON.parse(out) as Record<string, string | null>;
      } catch {
        parsed = {};
      }
      group.forEach((job, i) => {
        const err =
          job.src in parsed
            ? parsed[job.src]
            : `sqlite worker for uid ${uid} exited ${code} (it must be able to read the script and ${dir})`;
        if (err === null) {
          fs.mkdirSync(path.dirname(job.dest), { recursive: true });
          fs.renameSync(work[i].dest, job.dest);
        }
        results.set(job.src, err);
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return results;
  };
}

async function sqliteWorker(): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const jobs = JSON.parse(input) as { src: string; dest: string }[];
  process.stdout.write(JSON.stringify(Object.fromEntries(await snapshotInProcess(jobs))));
}

function awsUploader(bucket: string): Uploader {
  const common = ['--only-show-errors', '--no-progress', '--checksum-algorithm', 'CRC32'];
  return {
    uploadTree: (dir, prefix) => runAws(['s3', 'cp', dir, `s3://${bucket}/${prefix}`, '--recursive', ...common]),
    uploadFile: (file, key) => runAws(['s3', 'cp', file, `s3://${bucket}/${key}`, ...common]),
  };
}

function runAws(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('aws', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`aws ${args[0]} ${args[1]} exited ${code}`)),
    );
  });
}

interface StateRow {
  path: string;
  kind: EntryKind | null;
  size: number | null;
  sha256: string | null;
  mode: number | null;
  uid: number | null;
  gid: number | null;
  mtime_ms: number | null;
  target: string | null;
  stamp: string | null;
  dirty: number;
}

type KnownEntry = StateEntry & { dirty: boolean };

const DIR_RETAINED = `d.seen_run = @run OR EXISTS (
  SELECT 1 FROM entries e WHERE e.seen_run = @run AND e.sha256 IS NOT NULL
    AND e.path > d.path || '/' AND e.path < d.path || '0')`;

function prepareStatements(db: Database.Database) {
  return {
    get: db.prepare<[string], StateRow>('SELECT * FROM entries WHERE path = ?'),
    see: db.prepare('UPDATE entries SET seen_run = ? WHERE path = ?'),
    seeUnder: db.prepare('UPDATE entries SET seen_run = ? WHERE path = ? OR substr(path, 1, length(?)) = ?'),
    seeDirsUnder: db.prepare('UPDATE dirs SET seen_run = ? WHERE path = ? OR substr(path, 1, length(?)) = ?'),
    putDir: db.prepare(`INSERT INTO dirs (path, mode, uid, gid, seen_run) VALUES (@path, @mode, @uid, @gid, @run)
      ON CONFLICT(path) DO UPDATE SET mode = excluded.mode, uid = excluded.uid, gid = excluded.gid,
        seen_run = excluded.seen_run`),
    retainedDirs: db.prepare<[{ run: string }], DirEntry>(
      `SELECT path, mode, uid, gid FROM dirs d WHERE ${DIR_RETAINED} ORDER BY path`,
    ),
    pruneDirs: db.prepare<[{ run: string }]>(`DELETE FROM dirs AS d WHERE NOT (${DIR_RETAINED})`),
    put: db.prepare(`INSERT INTO entries
      (path, kind, size, sha256, mode, uid, gid, mtime_ms, target, stamp, dirty, seen_run)
      VALUES (@path, @kind, @size, @sha256, @mode, @uid, @gid, @mtimeMs, @target, @stamp, 0, @run)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size, sha256 = excluded.sha256,
        mode = excluded.mode, uid = excluded.uid, gid = excluded.gid, mtime_ms = excluded.mtime_ms,
        target = excluded.target, stamp = excluded.stamp, dirty = 0, seen_run = excluded.seen_run`),
    dirty: db.prepare(`INSERT INTO entries (path, dirty, seen_run) VALUES (?, 1, ?)
      ON CONFLICT(path) DO UPDATE SET dirty = 1`),
    clean: db.prepare('UPDATE entries SET dirty = 0 WHERE path = ?'),
    unseen: db.prepare<[string], { path: string; kind: EntryKind | null }>(
      'SELECT path, kind FROM entries WHERE seen_run IS NOT ?',
    ),
    remove: db.prepare('DELETE FROM entries WHERE path = ?'),
    manifest: db.prepare<[string], StateRow>(
      'SELECT * FROM entries WHERE seen_run = ? AND sha256 IS NOT NULL ORDER BY path',
    ),
  };
}

class StateStore {
  private readonly db: Database.Database;
  private readonly stmts: ReturnType<typeof prepareStatements>;
  private pendingOps = 0;

  constructor(file: string, bucket: string) {
    this.db = new Database(file);
    fs.chmodSync(file, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('bucket', ?)").run(bucket);
    const bound = this.db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'bucket'").get()?.value;
    if (bound !== bucket) {
      this.db.close();
      throw new Error(
        `${file} records uploads to bucket ${bound}, not ${bucket}; use a fresh stateDir for a new bucket`,
      );
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS entries (
      path TEXT PRIMARY KEY, kind TEXT, size INTEGER, sha256 TEXT, mode INTEGER, uid INTEGER, gid INTEGER,
      mtime_ms REAL, target TEXT, stamp TEXT, dirty INTEGER NOT NULL DEFAULT 0, seen_run TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS dirs (
      path TEXT PRIMARY KEY, mode INTEGER NOT NULL, uid INTEGER NOT NULL, gid INTEGER NOT NULL, seen_run TEXT)`);
    this.stmts = prepareStatements(this.db);
    this.db.exec('BEGIN');
  }

  private op(): void {
    if (++this.pendingOps >= 5000) this.sync();
  }

  sync(): void {
    this.db.exec('COMMIT; BEGIN');
    this.pendingOps = 0;
  }

  close(): void {
    this.db.exec('COMMIT');
    this.db.close();
  }

  get(p: string): KnownEntry | undefined {
    const row = this.stmts.get.get(p);
    if (!row) return undefined;
    return { ...fromRow(row), stamp: row.stamp ?? '', dirty: row.dirty === 1 };
  }

  see(p: string, run: string): void {
    this.stmts.see.run(run, p);
    this.op();
  }

  seeUnder(p: string, run: string): void {
    const under = p.endsWith('/') ? p : `${p}/`;
    this.stmts.seeUnder.run(run, p, under, under);
    this.stmts.seeDirsUnder.run(run, p, under, under);
    this.op();
  }

  putDir(d: DirEntry, run: string): void {
    this.stmts.putDir.run({ ...d, run });
    this.op();
  }

  *retainedDirs(run: string): Generator<DirEntry> {
    yield* this.stmts.retainedDirs.iterate({ run });
  }

  pruneDirs(run: string): void {
    this.stmts.pruneDirs.run({ run });
    this.sync();
  }

  put(e: StateEntry, run: string): void {
    this.stmts.put.run({ ...e, target: e.target ?? null, run });
    this.op();
  }

  markDirty(paths: string[], run: string): void {
    for (const p of paths) this.stmts.dirty.run(p, run);
    this.sync();
  }

  markClean(paths: string[]): void {
    for (const p of paths) this.stmts.clean.run(p);
    this.sync();
  }

  unseen(run: string): { path: string; kind: EntryKind | null }[] {
    return this.stmts.unseen.all(run);
  }

  remove(paths: string[]): void {
    for (const p of paths) this.stmts.remove.run(p);
    this.sync();
  }

  *manifestEntries(run: string): Generator<ManifestEntry> {
    for (const row of this.stmts.manifest.iterate(run)) yield fromRow(row);
  }
}

function fromRow(row: StateRow): ManifestEntry {
  return {
    path: row.path,
    kind: row.kind ?? 'file',
    size: row.size ?? 0,
    sha256: row.sha256 ?? '',
    mode: row.mode ?? 0o600,
    uid: row.uid ?? 0,
    gid: row.gid ?? 0,
    mtimeMs: row.mtime_ms ?? 0,
    ...(row.target !== null ? { target: row.target } : {}),
  };
}

function runIdFor(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

interface RunOptions {
  uploader: Uploader;
  remoteCheck?: (dir: string) => boolean;
  now?: () => Date;
  dryRun?: boolean;
  log?: (line: string) => void;
}

interface RunResult {
  runId: string;
  failures: string[];
  manifestEntries: number;
  scannedFiles: number;
  scannedBytes: number;
  changedFiles: number;
  uploadedFiles: number;
  uploadedBytes: number;
  tombstoned: number;
  warnings: string[];
}

export async function runBackup(config: BackupConfig, opts: RunOptions): Promise<RunResult> {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o711 });
  fs.chmodSync(config.stateDir, 0o711);
  return withFileLock(path.join(config.stateDir, 'run.lock'), () => runLocked(config, opts), {
    waitSec: 0,
    label: 'the host backup run lock (another run is in progress)',
  });
}

async function runLocked(config: BackupConfig, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = now();
  const runId = runIdFor(started);
  const pass = crypto.randomUUID();
  const staging = path.join(config.stateDir, 'staging');
  const generated = path.join(config.stateDir, 'generated');
  const manifestDir = path.join(config.stateDir, 'manifests');
  const batchBytes = config.batchBytes ?? DEFAULT_BATCH_BYTES;
  const failures: string[] = [];
  const report: ScanReport = { unreadable: [], skippedClones: [], skippedVenvs: [], warnings: [] };
  const result: RunResult = {
    runId,
    failures,
    manifestEntries: 0,
    scannedFiles: 0,
    scannedBytes: 0,
    changedFiles: 0,
    uploadedFiles: 0,
    uploadedBytes: 0,
    tombstoned: 0,
    warnings: report.warnings,
  };

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(generated, { recursive: true, mode: 0o700 });
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  for (const cmd of config.commands ?? []) {
    const out = path.join(generated, cmd.name);
    if (opts.dryRun) continue;
    const fd = fs.openSync(`${out}.tmp`, 'w', 0o600);
    const res = spawnSync(cmd.argv[0], cmd.argv.slice(1), { stdio: ['ignore', fd, 'pipe'] });
    fs.closeSync(fd);
    if (res.status !== 0 || res.error) {
      const why = res.error ? message(res.error) : `exit ${res.status}: ${String(res.stderr).trim().slice(0, 200)}`;
      failures.push(`command ${cmd.name} failed: ${why}`);
      fs.rmSync(`${out}.tmp`, { force: true });
      continue;
    }
    fs.renameSync(`${out}.tmp`, out);
  }
  const outputs = new Set((config.commands ?? []).map((cmd) => cmd.name));
  for (const name of opts.dryRun ? [] : fs.readdirSync(generated)) {
    if (!outputs.has(name)) fs.rmSync(path.join(generated, name), { force: true });
  }
  const sources = [...config.sources, generated];

  const store = new StateStore(path.join(config.stateDir, 'state.db'), config.bucket);
  try {
    return await backupWith(store);
  } finally {
    store.close();
  }

  async function backupWith(store: StateStore): Promise<RunResult> {
    const stagedPath = (p: string) => path.join(staging, p.replace(/^\/+/, ''));

    const commit = async (paths: string[], what: string, onSuccess: () => void): Promise<boolean> => {
      store.markDirty(paths, pass);
      try {
        await opts.uploader.uploadTree(staging, 'files/');
        onSuccess();
        store.markClean(paths);
        return true;
      } catch (err) {
        failures.push(`upload of ${what} failed: ${message(err)}`);
        return false;
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { mode: 0o700 });
      }
    };

    let pending: StateEntry[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending;
      const bytes = pendingBytes;
      pending = [];
      pendingBytes = 0;
      const ok = await commit(
        batch.map((e) => e.path),
        `a ${batch.length}-file batch`,
        () => {
          for (const entry of batch) store.put(entry, pass);
        },
      );
      if (ok) {
        result.uploadedFiles += batch.length;
        result.uploadedBytes += bytes;
        log(`host-backup: uploaded ${result.uploadedFiles} files (${gib(result.uploadedBytes)}) so far`);
      }
    };

    const record = (f: ScannedFile, sha256: string, size: number): StateEntry => ({
      path: f.path,
      kind: f.kind,
      size,
      sha256,
      mode: f.stat.mode,
      uid: f.stat.uid,
      gid: f.stat.gid,
      mtimeMs: f.stat.mtimeMs,
      stamp: f.stamp,
      ...(f.target !== undefined ? { target: f.target } : {}),
    });

    const stage = (f: ScannedFile, prev: KnownEntry | undefined, sha256: string, size: number) => {
      const entry = record(f, sha256, size);
      if (prev && prev.sha256 === sha256 && !prev.dirty) {
        store.put(entry, pass);
        fs.rmSync(stagedPath(f.path), { force: true });
        return;
      }
      pending.push(entry);
      pendingBytes += size;
    };

    const snapshotter = makeSqliteSnapshotter(path.join(config.stateDir, 'sqlite-work'));
    let sqliteQueue: { file: ScannedFile; prev: KnownEntry | undefined }[] = [];
    let sqliteQueueBytes = 0;
    const drainSqlite = async () => {
      if (sqliteQueue.length === 0) return;
      const chunk = sqliteQueue;
      sqliteQueue = [];
      sqliteQueueBytes = 0;
      const results = await snapshotter(
        chunk.map(({ file: f }) => ({ src: f.path, dest: stagedPath(f.path), uid: f.stat.uid, gid: f.stat.gid })),
      );
      for (const { file: f, prev } of chunk) {
        const err = results.get(f.path);
        const staged = stagedPath(f.path);
        if (err !== null) {
          if (sqliteHeader(f.path) !== 'missing')
            failures.push(`sqlite backup of ${f.path} failed: ${err ?? 'no result'}`);
          fs.rmSync(staged, { force: true });
          continue;
        }
        stage(f, prev, await sha256File(staged), fs.statSync(staged).size);
      }
      if (pendingBytes >= batchBytes || pending.length >= BATCH_FILES) await flush();
    };

    const knownKind = (file: string, stamp: string) => {
      const prev = store.get(file);
      return prev && (prev.stamp === stamp || prev.stamp.startsWith(`${stamp}|`)) ? prev.kind : undefined;
    };
    let changedBytes = 0;
    for (const item of walkSources(sources, config.exclude ?? [], report, opts.remoteCheck, knownKind)) {
      if ('dir' in item) {
        store.putDir(item.dir, pass);
        continue;
      }
      const f = item.file;
      result.scannedFiles++;
      if (f.kind !== 'symlink') result.scannedBytes += f.stat.size;
      const prev = store.get(f.path);
      if (prev) store.see(f.path, pass);
      if (prev && prev.stamp === f.stamp && !prev.dirty) continue;
      result.changedFiles++;
      if (opts.dryRun) {
        if (f.kind !== 'symlink') changedBytes += f.stat.size;
        continue;
      }
      if (f.kind === 'symlink') {
        store.put(record(f, '', 0), pass);
      } else if (f.kind === 'sqlite') {
        sqliteQueue.push({ file: f, prev });
        sqliteQueueBytes += f.stat.size;
        if (sqliteQueue.length >= SQLITE_CHUNK_FILES || sqliteQueueBytes >= batchBytes) await drainSqlite();
      } else {
        try {
          const { sha256, size } = await copyHashed(f.path, stagedPath(f.path));
          stage(f, prev, sha256, size);
        } catch (err) {
          fs.rmSync(stagedPath(f.path), { force: true });
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
            failures.push(`could not read ${f.path}: ${message(err)}`);
        }
        if (pendingBytes >= batchBytes || pending.length >= BATCH_FILES) await flush();
      }
    }
    await drainSqlite();
    await flush();

    for (const p of report.unreadable) {
      failures.push(`could not read ${p}`);
      store.seeUnder(p, pass);
    }
    log(
      `host-backup: scanned ${result.scannedFiles} paths (${gib(result.scannedBytes)}), ${result.changedFiles} changed; skipped ${report.skippedClones.length} git clones with a remote and ${report.skippedVenvs.length} Python venvs`,
    );

    const gone = store.unseen(pass);
    result.tombstoned = gone.length;
    if (opts.dryRun) {
      log(`host-backup: dry run, would stage up to ${gib(changedBytes)} and tombstone ${gone.length} paths`);
      return result;
    }
    if (gone.length > 0) {
      const empties = gone
        .filter((g) => g.kind !== 'symlink')
        .map((g) => g.path)
        .filter((p) => {
          try {
            fs.mkdirSync(path.dirname(stagedPath(p)), { recursive: true });
            fs.writeFileSync(stagedPath(p), '');
            return true;
          } catch (err) {
            failures.push(`could not stage the tombstone for ${p}: ${message(err)}`);
            return false;
          }
        });
      const staged = new Set(empties);
      const all = gone.filter((g) => g.kind === 'symlink' || staged.has(g.path)).map((g) => g.path);
      if (empties.length === 0) store.remove(all);
      else await commit(empties, `${empties.length} tombstones`, () => store.remove(all));
    }

    const manifestFile = path.join(manifestDir, `${runId}.jsonl.gz`);
    result.manifestEntries = await writeManifest(manifestFile, {
      header: { runId, hostname: os.hostname(), startedAt: started.toISOString() },
      entries: store.manifestEntries(pass),
      dirs: store.retainedDirs(pass),
      trailer: () => ({ finishedAt: now().toISOString(), failures }),
    });
    store.pruneDirs(pass);
    try {
      await opts.uploader.uploadFile(manifestFile, `manifests/${runId}.jsonl.gz`);
      pruneLocalManifests(manifestDir, 7);
    } catch (err) {
      failures.push(`manifest upload failed: ${message(err)}`);
    }
    return result;
  }
}

async function writeManifest(
  file: string,
  parts: {
    header: { runId: string; hostname: string; startedAt: string };
    entries: Iterable<ManifestEntry>;
    dirs: Iterable<DirEntry>;
    trailer: () => { finishedAt: string; failures: string[] };
  },
): Promise<number> {
  const gzip = zlib.createGzip();
  const out = fs.createWriteStream(file, { mode: 0o600 });
  gzip.pipe(out);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
  const line = async (value: unknown) => {
    if (!gzip.write(`${JSON.stringify(value)}\n`)) await new Promise<void>((r) => gzip.once('drain', () => r()));
  };
  await line({ header: parts.header });
  let count = 0;
  for (const e of parts.entries) {
    await line({ e });
    count++;
  }
  for (const d of parts.dirs) await line({ d });
  await line({ trailer: parts.trailer() });
  gzip.end();
  await done;
  return count;
}

export async function readManifest(
  file: string,
  keep: (p: string) => boolean = () => true,
): Promise<Manifest & { complete: boolean }> {
  const manifest: Manifest & { complete: boolean } = {
    runId: '',
    hostname: '',
    startedAt: '',
    finishedAt: '',
    failures: [],
    entries: [],
    dirs: [],
    complete: false,
  };
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const raw of lines) {
    if (!raw) continue;
    const row = JSON.parse(raw) as {
      header?: { runId: string; hostname: string; startedAt: string };
      e?: ManifestEntry;
      d?: DirEntry;
      trailer?: { finishedAt: string; failures: string[] };
    };
    if (row.header) Object.assign(manifest, row.header);
    else if (row.e && keep(row.e.path)) manifest.entries.push(row.e);
    else if (row.d && keep(row.d.path)) manifest.dirs.push(row.d);
    else if (row.trailer) {
      Object.assign(manifest, row.trailer);
      manifest.complete = true;
    }
  }
  return manifest;
}

function pruneLocalManifests(dir: string, keep: number): void {
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl.gz'))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(dir, name));
}

export interface ObjectVersion {
  Key: string;
  VersionId: string;
  LastModified: string;
}

export interface RestoreSource {
  listManifests(): Promise<{ key: string; lastModified: string }[]>;
  getObject(key: string, versionId: string | null, dest: string): Promise<void>;
  listVersions(prefix: string): Promise<ObjectVersion[]>;
}

function awsRestoreSource(bucket: string): RestoreSource {
  const aws = (args: string[]): string => {
    const res = spawnSync('aws', args, { encoding: 'utf8', maxBuffer: 1024 ** 3 });
    if (res.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${res.stderr.trim()}`);
    return res.stdout;
  };
  const rows = (out: string) =>
    out
      .split('\n')
      .filter((l) => l && l !== 'None')
      .map((l) => l.split('\t'));
  return {
    listManifests: async () =>
      rows(
        aws([
          's3api',
          'list-objects-v2',
          '--bucket',
          bucket,
          '--prefix',
          'manifests/',
          '--query',
          'Contents[].[Key,LastModified]',
          '--output',
          'text',
        ]),
      ).map(([key, lastModified]) => ({ key, lastModified })),
    listVersions: async (prefix) =>
      rows(
        aws([
          's3api',
          'list-object-versions',
          '--bucket',
          bucket,
          '--prefix',
          prefix,
          '--query',
          'Versions[].[Key,VersionId,LastModified]',
          '--output',
          'text',
        ]),
      ).map(([Key, VersionId, LastModified]) => ({ Key, VersionId, LastModified })),
    getObject: async (key, versionId, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      aws([
        's3api',
        'get-object',
        '--bucket',
        bucket,
        '--key',
        key,
        ...(versionId ? ['--version-id', versionId] : []),
        dest,
      ]);
    },
  };
}

interface RestoreResult {
  manifest: string;
  restored: number;
  failures: string[];
}

export async function restore(
  source: RestoreSource,
  opts: { dest: string; asOf?: Date; prefix?: string; log?: (line: string) => void },
): Promise<RestoreResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const asOf = opts.asOf ?? new Date();
  fs.mkdirSync(path.dirname(path.resolve(opts.dest)), { recursive: true });
  try {
    fs.mkdirSync(opts.dest, { mode: 0o700 });
  } catch (err) {
    throw new Error(`${opts.dest} must not exist yet: restore creates it, private, so nothing else can write into it`, {
      cause: err,
    });
  }
  const manifests = (await source.listManifests())
    .filter((m) => MANIFEST_KEY.test(m.key) && new Date(m.lastModified) <= asOf)
    .sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  const chosen = manifests.at(-1);
  if (!chosen) throw new Error(`no manifest written at or before ${asOf.toISOString()}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-restore-'));
  try {
    const prefix = opts.prefix ? path.resolve(opts.prefix) : '/';
    const within = (p: string) => p === prefix || p.startsWith(prefix === '/' ? '/' : `${prefix}/`);
    const withinOrAncestor = (p: string) => within(p) || prefix.startsWith(p === '/' ? '/' : `${p}/`);
    await source.getObject(chosen.key, null, path.join(tmp, 'manifest.jsonl.gz'));
    const manifest = await readManifest(path.join(tmp, 'manifest.jsonl.gz'), withinOrAncestor);
    manifest.entries = manifest.entries.filter((e) => within(e.path));
    if (!manifest.complete) throw new Error(`${chosen.key} is truncated (no trailer line)`);
    for (const f of manifest.failures) log(`host-restore: warning: that night's run reported: ${f}`);
    log(`host-restore: manifest ${chosen.key}, restoring ${manifest.entries.length} paths under ${prefix}`);

    const cutoff = new Date(chosen.lastModified).getTime();
    const versions = new Map<string, ObjectVersion[]>();
    for (const v of await source.listVersions(`files/${prefix.replace(/^\/+/, '')}`)) {
      if (new Date(v.LastModified).getTime() > cutoff) continue;
      versions.set(v.Key, [...(versions.get(v.Key) ?? []), v]);
    }
    const failures: string[] = [];
    let restored = 0;
    const outPath = (p: string) => path.join(opts.dest, p);
    for (const d of manifest.dirs) fs.mkdirSync(outPath(d.path), { recursive: true });

    for (const e of manifest.entries.filter((w) => w.kind !== 'symlink')) {
      const out = outPath(e.path);
      const key = `files/${e.path.replace(/^\/+/, '')}`;
      const candidates = (versions.get(key) ?? []).sort((a, b) => b.LastModified.localeCompare(a.LastModified));
      let ok = false;
      for (const v of candidates) {
        await source.getObject(key, v.VersionId, out);
        if ((await sha256File(out)) === e.sha256) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        fs.rmSync(out, { force: true });
        failures.push(`no retained version of ${e.path} matches sha256 ${e.sha256}`);
        continue;
      }
      applyMetadata(out, e);
      fs.utimesSync(out, new Date(e.mtimeMs), new Date(e.mtimeMs));
      restored++;
    }

    for (const e of manifest.entries.filter((w) => w.kind === 'symlink')) {
      const out = outPath(e.path);
      try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.symlinkSync(e.target ?? '', out);
        if (process.getuid?.() === 0) fs.lchownSync(out, e.uid, e.gid);
        restored++;
      } catch (err) {
        failures.push(`could not recreate symlink ${e.path}: ${message(err)}`);
      }
    }

    for (const d of [...manifest.dirs].sort((a, b) => b.path.length - a.path.length)) {
      applyMetadata(outPath(d.path), d);
    }
    return { manifest: chosen.key, restored, failures };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function applyMetadata(out: string, meta: { mode: number; uid: number; gid: number }): void {
  if (process.getuid?.() === 0) fs.lchownSync(out, meta.uid, meta.gid);
  if (!fs.lstatSync(out).isSymbolicLink()) fs.chmodSync(out, meta.mode & 0o7777);
}

function loadConfig(file: string): BackupConfig {
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupConfig;
  for (const key of ['bucket', 'region', 'stateDir'] as const) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`${file}: "${key}" is required`);
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new Error(`${file}: "sources" is empty`);
  return applyGates(config);
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  if (cmd === 'sqlite-worker') {
    await sqliteWorker();
    return 0;
  }
  const config = loadConfig(flag(args, '--config') ?? DEFAULT_CONFIG_PATH);
  process.env.AWS_REGION ??= config.region;
  if (cmd === 'run') {
    const result = await runBackup(config, {
      uploader: awsUploader(config.bucket),
      dryRun: args.includes('--dry-run'),
    });
    for (const w of result.warnings.slice(0, 50)) console.log(`host-backup: warning: ${w}`);
    console.log(
      `host-backup: ${result.runId}: ${result.manifestEntries} paths in the manifest, uploaded ${result.uploadedFiles} files (${gib(result.uploadedBytes)}), ${result.tombstoned} gone`,
    );
    if (result.failures.length > 0) {
      for (const f of result.failures.slice(0, 20)) console.error(`host-backup: FAILED: ${f}`);
      console.error(`host-backup: error: ${result.failures.length} failures; first: ${result.failures[0]}`);
      return 1;
    }
    return 0;
  }
  if (cmd === 'restore') {
    const dest = flag(args, '--dest');
    if (!dest) throw new Error('restore needs --dest <dir>');
    const asOf = flag(args, '--as-of');
    const result = await restore(awsRestoreSource(config.bucket), {
      dest,
      prefix: flag(args, '--prefix'),
      asOf: asOf ? new Date(asOf) : undefined,
    });
    console.log(`host-restore: restored ${result.restored} paths from ${result.manifest} into ${dest}`);
    for (const f of result.failures) console.error(`host-restore: FAILED: ${f}`);
    return result.failures.length ? 1 : 0;
  }
  console.error(
    'usage: host-backup.ts run [--dry-run] | restore --dest <dir> [--as-of <iso>] [--prefix <path>] [--config <file>]',
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`host-backup: error: ${message(err)}`);
      process.exitCode = 1;
    });
}
