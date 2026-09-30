#!/usr/bin/env tsx
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import Database from 'better-sqlite3';

const DEFAULT_CONFIG_PATH = '/etc/nanoclaw-backup/config.json';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SQLITE_SIDECARS = ['-journal', '-wal', '-shm'];
const MAX_KEY_PATH_BYTES = 1000;
const DEFAULT_BATCH_BYTES = 8 * 1024 ** 3;

export interface BackupConfig {
  bucket: string;
  region: string;
  stateDir: string;
  sources: string[];
  exclude?: string[];
  commands?: { name: string; argv: string[] }[];
  batchBytes?: number;
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

interface BackupState {
  entries: Record<string, StateEntry>;
}

export interface Manifest {
  version: 1;
  runId: string;
  hostname: string;
  startedAt: string;
  finishedAt: string;
  failures: string[];
  entries: ManifestEntry[];
}

interface ScannedFile {
  path: string;
  kind: EntryKind;
  stat: fs.Stats;
  stamp: string;
  target?: string;
}

export interface Scan {
  files: ScannedFile[];
  unreadable: string[];
  skippedClones: string[];
  warnings: string[];
}

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

function readHead(file: string, bytes: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function statStamp(st: fs.Stats): string {
  return `${st.size}:${st.mtimeMs}:${st.ino}`;
}

function sqliteStamp(file: string, st: fs.Stats): string {
  const wal = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
  return `${statStamp(st)}|${wal ? statStamp(wal) : '-'}`;
}

export function scanSources(
  sources: string[],
  exclude: string[],
  remoteCheck: (dir: string) => boolean = hasRemote,
): Scan {
  const excludes = exclude.map(globToRegExp);
  const scan: Scan = { files: [], unreadable: [], skippedClones: [], warnings: [] };
  const excluded = (p: string) => excludes.some((re) => re.test(p));

  const visitFile = (p: string, st: fs.Stats, siblings: Set<string>) => {
    if (Buffer.byteLength(p) > MAX_KEY_PATH_BYTES || /[\p{Cc}\\]/u.test(p)) {
      scan.warnings.push(`skipped (path cannot be an S3 key as-is): ${JSON.stringify(p)}`);
      return;
    }
    if (st.isSymbolicLink()) {
      scan.files.push({ path: p, kind: 'symlink', stat: st, stamp: statStamp(st), target: fs.readlinkSync(p) });
      return;
    }
    if (!st.isFile()) return;
    const base = path.basename(p);
    const sidecar = SQLITE_SIDECARS.find((s) => base.endsWith(s));
    if (sidecar && siblings.has(base.slice(0, -sidecar.length))) return;
    let isSqlite: boolean;
    try {
      isSqlite = st.size >= 512 && readHead(p, 16).equals(SQLITE_MAGIC);
    } catch (err) {
      scan.warnings.push(`unreadable file ${p}: ${message(err)}`);
      return;
    }
    scan.files.push({
      path: p,
      kind: isSqlite ? 'sqlite' : 'file',
      stat: st,
      stamp: isSqlite ? sqliteStamp(p, st) : statStamp(st),
    });
  };

  const visitDir = (dir: string, isRoot: boolean) => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      scan.unreadable.push(dir);
      scan.warnings.push(`unreadable directory ${dir}: ${message(err)}`);
      return;
    }
    const siblings = new Set(names);
    const skipGitDir = names.includes('.git') && remoteCheck(dir);
    if (skipGitDir && !isRoot) {
      scan.skippedClones.push(dir);
      return;
    }
    for (const name of names.sort()) {
      if (skipGitDir && name === '.git') continue;
      const p = path.join(dir, name);
      if (excluded(p)) continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) visitDir(p, false);
      else visitFile(p, st, siblings);
    }
  };

  for (const src of sources) {
    const root = path.resolve(src);
    const st = fs.lstatSync(root, { throwIfNoEntry: false });
    if (!st) {
      scan.unreadable.push(root);
      scan.warnings.push(`source missing: ${root}`);
      continue;
    }
    if (excluded(root)) continue;
    if (st.isDirectory()) visitDir(root, true);
    else visitFile(root, st, new Set(fs.readdirSync(path.dirname(root))));
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
  { pagesPerStep = 1024, budgetMs = 10 * 60_000 } = {},
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(src, { readonly: true, fileMustExist: true, timeout: 15_000 });
  const started = Date.now();
  let restarts = 0;
  let lastRemaining = Infinity;
  try {
    await db.backup(dest, {
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
  const copy = new Database(dest);
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
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
        const err = job.src in parsed ? parsed[job.src] : `sqlite worker for uid ${uid} exited ${code}`;
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

function awsUploader(bucket: string, run: (args: string[]) => Promise<void> = runAws): Uploader {
  const common = ['--only-show-errors', '--no-progress', '--checksum-algorithm', 'CRC32'];
  return {
    uploadTree: (dir, prefix) => run(['s3', 'cp', dir, `s3://${bucket}/${prefix}`, '--recursive', ...common]),
    uploadFile: (file, key) => run(['s3', 'cp', file, `s3://${bucket}/${key}`, ...common]),
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

function loadState(file: string): BackupState {
  if (!fs.existsSync(file)) return { entries: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BackupState;
}

function saveState(file: string, state: BackupState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function toManifestEntry(e: StateEntry): ManifestEntry {
  const { stamp: _stamp, ...rest } = e;
  return rest;
}

function runIdFor(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

function underAny(p: string, dirs: string[]): boolean {
  return dirs.some((d) => p === d || p.startsWith(`${d}${path.sep}`));
}

export interface RunOptions {
  uploader: Uploader;
  snapshotter?: SqliteSnapshotter;
  remoteCheck?: (dir: string) => boolean;
  now?: () => Date;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface RunResult {
  manifest: Manifest;
  uploadedFiles: number;
  uploadedBytes: number;
  tombstoned: number;
  scannedBytes: number;
  skippedClones: string[];
  warnings: string[];
}

export async function runBackup(config: BackupConfig, opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const started = now();
  const runId = runIdFor(started);
  const stateFile = path.join(config.stateDir, 'state.json');
  const staging = path.join(config.stateDir, 'staging');
  const generated = path.join(config.stateDir, 'generated');
  const batchBytes = config.batchBytes ?? DEFAULT_BATCH_BYTES;
  const failures: string[] = [];
  const state = loadState(stateFile);

  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(generated, { recursive: true, mode: 0o700 });
  const generatedSeen = new Set<string>();
  for (const cmd of config.commands ?? []) {
    const out = path.join(generated, cmd.name);
    generatedSeen.add(out);
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
  const sources = [...config.sources, ...(generatedSeen.size ? [generated] : [])];

  const scan = scanSources(sources, config.exclude ?? [], opts.remoteCheck);
  for (const dir of scan.unreadable) failures.push(`could not read ${dir}`);
  const scannedBytes = scan.files.reduce((n, f) => n + (f.kind === 'symlink' ? 0 : f.stat.size), 0);
  log(
    `host-backup: scanned ${scan.files.length} paths (${gib(scannedBytes)}), skipped ${scan.skippedClones.length} git clones with a remote`,
  );

  const seen = new Set(scan.files.map((f) => f.path));
  const changed = scan.files.filter((f) => state.entries[f.path]?.stamp !== f.stamp);
  const tombstones = Object.keys(state.entries).filter((p) => !seen.has(p) && !underAny(p, scan.unreadable));
  log(`host-backup: ${changed.length} changed since the last upload, ${tombstones.length} gone`);

  let uploadedFiles = 0;
  let uploadedBytes = 0;
  if (opts.dryRun) {
    const bytes = changed.reduce((n, f) => n + (f.kind === 'symlink' ? 0 : f.stat.size), 0);
    log(`host-backup: dry run, would stage up to ${gib(bytes)}`);
  } else {
    const snapshotter = opts.snapshotter ?? makeSqliteSnapshotter(path.join(config.stateDir, 'sqlite-work'));
    let pending: { file: ScannedFile; entry: StateEntry }[] = [];
    let pendingBytes = 0;

    const flush = async () => {
      if (pending.length === 0) return;
      try {
        await opts.uploader.uploadTree(staging, 'files/');
        for (const { entry } of pending) state.entries[entry.path] = entry;
        uploadedFiles += pending.length;
        uploadedBytes += pendingBytes;
        saveState(stateFile, state);
        log(`host-backup: uploaded ${uploadedFiles} files (${gib(uploadedBytes)}) so far`);
      } catch (err) {
        failures.push(`upload of a ${pending.length}-file batch failed: ${message(err)}`);
      }
      fs.rmSync(staging, { recursive: true, force: true });
      pending = [];
      pendingBytes = 0;
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

    const stage = async (f: ScannedFile, staged: string, sha256: string, size: number) => {
      const entry = record(f, sha256, size);
      const prev = state.entries[f.path];
      if (prev && prev.sha256 === sha256) {
        state.entries[f.path] = entry;
        fs.rmSync(staged, { force: true });
        return;
      }
      pending.push({ file: f, entry });
      pendingBytes += size;
      if (pendingBytes >= batchBytes) await flush();
    };

    const stagedPath = (p: string) => path.join(staging, p.replace(/^\/+/, ''));

    for (const f of changed.filter((c) => c.kind === 'symlink')) {
      state.entries[f.path] = record(f, '', 0);
    }

    for (const f of changed.filter((c) => c.kind === 'file')) {
      try {
        const { sha256, size } = await copyHashed(f.path, stagedPath(f.path));
        await stage(f, stagedPath(f.path), sha256, size);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        failures.push(`could not read ${f.path}: ${message(err)}`);
      }
    }

    const sqlite = changed.filter((c) => c.kind === 'sqlite');
    const SQLITE_CHUNK = 200;
    for (let i = 0; i < sqlite.length; i += SQLITE_CHUNK) {
      const chunk = sqlite.slice(i, i + SQLITE_CHUNK);
      const results = await snapshotter(
        chunk.map((f) => ({ src: f.path, dest: stagedPath(f.path), uid: f.stat.uid, gid: f.stat.gid })),
      );
      for (const f of chunk) {
        const err = results.get(f.path);
        if (err !== null) {
          if (fs.existsSync(f.path)) failures.push(`sqlite backup of ${f.path} failed: ${err ?? 'no result'}`);
          fs.rmSync(stagedPath(f.path), { force: true });
          continue;
        }
        const staged = stagedPath(f.path);
        await stage(f, staged, await sha256File(staged), fs.statSync(staged).size);
      }
    }
    await flush();

    if (tombstones.length > 0) {
      const empties = tombstones.filter((p) => state.entries[p].kind !== 'symlink');
      for (const p of empties) {
        fs.mkdirSync(path.dirname(stagedPath(p)), { recursive: true });
        fs.writeFileSync(stagedPath(p), '');
      }
      try {
        if (empties.length > 0) await opts.uploader.uploadTree(staging, 'files/');
        for (const p of tombstones) delete state.entries[p];
        saveState(stateFile, state);
      } catch (err) {
        failures.push(`tombstone upload failed: ${message(err)}`);
      }
      fs.rmSync(staging, { recursive: true, force: true });
    }
    saveState(stateFile, state);
  }

  const manifest: Manifest = {
    version: 1,
    runId,
    hostname: os.hostname(),
    startedAt: started.toISOString(),
    finishedAt: now().toISOString(),
    failures,
    entries: Object.values(state.entries)
      .filter((e) => seen.has(e.path))
      .map(toManifestEntry)
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
  if (!opts.dryRun) {
    const file = path.join(config.stateDir, 'manifests', `${runId}.json.gz`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(manifest)), { mode: 0o600 });
    try {
      await opts.uploader.uploadFile(file, `manifests/${runId}.json.gz`);
      pruneLocalManifests(path.dirname(file), 7);
    } catch (err) {
      failures.push(`manifest upload failed: ${message(err)}`);
    }
  }
  return {
    manifest,
    uploadedFiles,
    uploadedBytes,
    tombstoned: tombstones.length,
    scannedBytes,
    skippedClones: scan.skippedClones,
    warnings: scan.warnings,
  };
}

function pruneLocalManifests(dir: string, keep: number): void {
  const names = fs.readdirSync(dir).sort();
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
  const json = (args: string[]): unknown => {
    const res = spawnSync('aws', [...args, '--output', 'json'], { encoding: 'utf8', maxBuffer: 1024 ** 3 });
    if (res.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(' ')} failed: ${res.stderr.trim()}`);
    return res.stdout.trim() ? JSON.parse(res.stdout) : {};
  };
  return {
    listManifests: async () => {
      const out = json(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', 'manifests/']) as {
        Contents?: { Key: string; LastModified: string }[];
      };
      return (out.Contents ?? []).map((c) => ({ key: c.Key, lastModified: c.LastModified }));
    },
    listVersions: async (prefix) => {
      const out = json(['s3api', 'list-object-versions', '--bucket', bucket, '--prefix', prefix]) as {
        Versions?: ObjectVersion[];
      };
      return out.Versions ?? [];
    },
    getObject: async (key, versionId, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      json([
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

export interface RestoreResult {
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
  const manifests = (await source.listManifests())
    .filter((m) => new Date(m.lastModified) <= asOf)
    .sort((a, b) => a.lastModified.localeCompare(b.lastModified));
  const chosen = manifests.at(-1);
  if (!chosen) throw new Error(`no manifest written at or before ${asOf.toISOString()}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-restore-'));
  try {
    await source.getObject(chosen.key, null, path.join(tmp, 'manifest.json.gz'));
    const manifest = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(path.join(tmp, 'manifest.json.gz'))).toString(),
    ) as Manifest;
    const cutoff = new Date(chosen.lastModified).getTime();
    const prefix = opts.prefix ? path.resolve(opts.prefix) : '/';
    const wanted = manifest.entries.filter(
      (e) => e.path === prefix || e.path.startsWith(prefix === '/' ? '/' : `${prefix}/`),
    );
    log(`host-restore: manifest ${chosen.key} (${manifest.entries.length} entries), restoring ${wanted.length}`);

    const versions = new Map<string, ObjectVersion[]>();
    for (const v of await source.listVersions(`files/${prefix.replace(/^\/+/, '')}`)) {
      if (new Date(v.LastModified).getTime() > cutoff) continue;
      versions.set(v.Key, [...(versions.get(v.Key) ?? []), v]);
    }
    const failures: string[] = [];
    let restored = 0;
    for (const e of wanted) {
      const out = path.join(opts.dest, e.path);
      if (e.kind === 'symlink') {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.rmSync(out, { force: true });
        fs.symlinkSync(e.target ?? '', out);
        restored++;
        continue;
      }
      const candidates = (versions.get(`files/${e.path.replace(/^\/+/, '')}`) ?? []).sort((a, b) =>
        b.LastModified.localeCompare(a.LastModified),
      );
      let ok = false;
      for (const v of candidates) {
        await source.getObject(`files/${e.path.replace(/^\/+/, '')}`, v.VersionId, out);
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
      fs.chmodSync(out, e.mode & 0o7777);
      if (process.getuid?.() === 0) fs.chownSync(out, e.uid, e.gid);
      fs.utimesSync(out, new Date(e.mtimeMs), new Date(e.mtimeMs));
      restored++;
    }
    return { manifest: chosen.key, restored, failures };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function loadConfig(file: string): BackupConfig {
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupConfig;
  for (const key of ['bucket', 'region', 'stateDir'] as const) {
    if (typeof config[key] !== 'string' || !config[key]) throw new Error(`${file}: "${key}" is required`);
  }
  if (!Array.isArray(config.sources) || config.sources.length === 0) throw new Error(`${file}: "sources" is empty`);
  return config;
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
    for (const w of result.warnings) console.log(`host-backup: warning: ${w}`);
    console.log(
      `host-backup: ${result.manifest.runId}: ${result.manifest.entries.length} paths in the manifest, uploaded ${result.uploadedFiles} files (${gib(result.uploadedBytes)}), ${result.tombstoned} gone`,
    );
    if (result.manifest.failures.length > 0) {
      for (const f of result.manifest.failures.slice(0, 20)) console.error(`host-backup: FAILED: ${f}`);
      console.error(
        `host-backup: error: ${result.manifest.failures.length} failures; first: ${result.manifest.failures[0]}`,
      );
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
