/**
 * Topic checkouts for the nightly git safety net (scripts/git-safety.sh): every commit on no remote, every
 * uncommitted edit and new file, and every stash, written as a bundle, a gzipped patch and a tarball per checkout.
 *
 * Every topic checkout and the repository behind it sit under data/, bind-mounted read-write into agent
 * containers, so nothing here trusts them: git runs only through `runGit` (hardened config, no transport, a
 * timeout), nothing under data/ is ever written (`hostOwned` is the only way to name a write target), and a
 * failure is thrown and reported, never read as an empty result.
 */
import { spawnSync, type SpawnSyncReturns } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';

import { FILTER_DISCOVERY_ARGS, FILTER_DISCOVERY_ENV, parseFilterKeys, safeGitArgs, safeGitEnv } from './safe-git.js';

/** A repository a container can write. The type carries no capability: nothing in this module writes to one. */
interface ContainerWritableRepo {
  readonly trust: 'container-writable';
  readonly commonDir: string;
  readonly checkouts: readonly string[];
}

type Admission =
  | { kind: 'admitted'; checkout: string; commonDir: string }
  | { kind: 'unreadable'; checkout: string; reason: string };

/** A path proved to lie outside data/. Every file this module creates is named by one. */
type HostOwnedPath = string & { readonly hostOwned: unique symbol };

export interface TopicSnapshotOptions {
  dataRoot: string;
  outDir: string;
  manifestPath: string;
  patterns: readonly string[];
  timeoutMs: number;
  maxUntrackedBytes: number;
}

export interface TopicSnapshotResult {
  captured: number;
  bundled: number;
  unreadable: Admission[];
  failures: string[];
}

/** `cannotOpen`: git ran and refused (an exit or unusable output), as opposed to being killed or failing to start. */
class GitFailure extends Error {
  constructor(
    message: string,
    readonly cannotOpen: boolean,
  ) {
    super(message);
  }
}

// No transport, so a promisor remote's lazy fetch cannot run core.sshCommand; no CRLF or untracked-cache warnings,
// which would fail a benign read under runGit's stderr rule.
const HOST_GIT_OVERRIDES = [
  '-c',
  'protocol.allow=never',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'core.safecrlf=false',
  '-c',
  'core.untrackedCache=false',
];
const SECRET_SHAPED =
  /^(\.env|\.env\..*|.*\.env|.*\.pem|.*\.p8|.*\.key|credentials.*|\.netrc|id_rsa.*|id_ed25519.*|id_ecdsa.*|profiles\.yml|secrets\.ya?ml)$/;

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The real location of `p`, resolved through its nearest existing ancestor, so a symlinked parent cannot hide data/. */
function realLocation(p: string): string {
  const resolved = path.resolve(p);
  let existing = resolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, resolved));
}

function hostOwned(dataRoot: string, p: string): HostOwnedPath {
  if (isWithin(dataRoot, realLocation(p))) throw new Error(`refusing to write under ${dataRoot}: ${p}`);
  return path.resolve(p) as HostOwnedPath;
}

function hostChild(parent: HostOwnedPath, ...names: string[]): HostOwnedPath {
  for (const name of names) {
    if (name === '' || name === '.' || name === '..' || name.includes('/'))
      throw new Error(`not a child name: ${name}`);
  }
  return path.join(parent, ...names) as HostOwnedPath;
}

interface GitCall {
  args: readonly string[];
  /** A checkout to run in; discovery from it stops at its parent. */
  cwd?: string;
  gitDir?: HostOwnedPath;
  filters?: readonly string[];
  okStatus?: readonly number[];
  input?: string;
  stdinFd?: number;
  stdoutFd?: number;
  env?: NodeJS.ProcessEnv;
}

function runGit(call: GitCall, timeoutMs: number): SpawnSyncReturns<Buffer> {
  const env = safeGitEnv({
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: 'none',
    ...(call.cwd ? { GIT_CEILING_DIRECTORIES: path.dirname(call.cwd) } : {}),
    ...(call.gitDir ? { GIT_DIR: call.gitDir } : {}),
    ...call.env,
  });
  const result = spawnSync('git', safeGitArgs([...HOST_GIT_OVERRIDES, ...call.args], undefined, call.filters ?? []), {
    cwd: call.cwd ?? path.dirname(call.gitDir ?? os.tmpdir()),
    env,
    input: call.input,
    stdio: [call.stdinFd ?? (call.input === undefined ? 'ignore' : 'pipe'), call.stdoutFd ?? 'pipe', 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 512 * 1024 * 1024,
  });
  const where = call.cwd ?? call.gitDir;
  const command = `git ${call.args.join(' ')} in ${where}`;
  if (result.error || result.signal) {
    throw new GitFailure(
      `${command}: ${result.signal ? `killed after ${timeoutMs / 1000}s` : String(result.error)}`,
      false,
    );
  }
  if (!(call.okStatus ?? [0]).includes(result.status ?? -1)) {
    const stderr = result.stderr.toString().trim().split('\n').pop() ?? '';
    throw new GitFailure(`${command}: exit ${result.status}${stderr ? ` (${stderr})` : ''}`, true);
  }
  // Git reports what it could not read (a path, a ref) on stderr and still exits 0.
  if (result.status === 0 && result.stderr.length > 0) {
    throw new GitFailure(`${command}: ${result.stderr.toString().trim().split('\n')[0]}`, false);
  }
  return result;
}

/** The one path git printed, byte-exact: git ends it with a newline, and a path holding a newline is refused. */
function onePath(stdout: Buffer): string {
  const text = stdout.toString();
  if (!text.endsWith('\n')) throw new GitFailure(`expected one path, got ${JSON.stringify(text)}`, true);
  const value = text.slice(0, -1);
  if (value === '' || value.includes('\n'))
    throw new GitFailure(`refusing a path that holds a newline: ${JSON.stringify(text)}`, true);
  return value;
}

function lines(stdout: Buffer): string[] {
  return stdout
    .toString()
    .split('\n')
    .filter((line) => line !== '');
}

function admit(dataRoot: string, checkout: string, timeoutMs: number): Admission {
  const unreadable = (reason: string): Admission => ({ kind: 'unreadable', checkout, reason });
  if (checkout.includes('\n')) return unreadable('path holds a newline');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(checkout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return unreadable('vanished after listing');
  }
  if (stat.isSymbolicLink()) return unreadable('a symlink');
  if (!stat.isDirectory()) return unreadable('not a directory');
  try {
    const real = fs.realpathSync(checkout);
    const top = onePath(runGit({ cwd: checkout, args: ['rev-parse', '--show-toplevel'] }, timeoutMs).stdout);
    const common = onePath(
      runGit({ cwd: checkout, args: ['rev-parse', '--path-format=absolute', '--git-common-dir'] }, timeoutMs).stdout,
    );
    const gitDir = onePath(runGit({ cwd: checkout, args: ['rev-parse', '--absolute-git-dir'] }, timeoutMs).stdout);
    const commonDir = fs.realpathSync(common);
    if (top !== real) return unreadable(`git resolves it to ${top}`);
    if (!isWithin(dataRoot, commonDir)) return unreadable(`its repository ${commonDir} is outside ${dataRoot}`);
    // Reading a split index touches the shared index file's timestamps, which would write under data/.
    if (fs.readdirSync(gitDir).some((name) => name.startsWith('sharedindex.'))) return unreadable('a split index');
    return { kind: 'admitted', checkout: real, commonDir };
  } catch (err) {
    if (!(err instanceof GitFailure) || !err.cannotOpen) throw err;
    return unreadable(`git cannot open it: ${err.message}`);
  }
}

/** Filter drivers the repo's config defines; global and system config are already off (safeGitEnv). */
function repoFilterNames(checkout: string, timeoutMs: number): string[] {
  const keys = runGit(
    {
      cwd: checkout,
      args: ['config', '--includes', ...FILTER_DISCOVERY_ARGS],
      env: FILTER_DISCOVERY_ENV,
      okStatus: [0, 1],
    },
    timeoutMs,
  ).stdout;
  return parseFilterKeys(keys);
}

function groupRepos(admitted: readonly Admission[]): ContainerWritableRepo[] {
  const byCommon = new Map<string, string[]>();
  for (const entry of admitted) {
    if (entry.kind !== 'admitted') continue;
    const list = byCommon.get(entry.commonDir) ?? [];
    if (!list.includes(entry.checkout)) list.push(entry.checkout);
    byCommon.set(entry.commonDir, list);
  }
  return [...byCommon.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([commonDir, checkouts]) => ({ trust: 'container-writable', commonDir, checkouts: checkouts.sort() }));
}

function labelFor(commonDir: string): string {
  const base = commonDir
    .replace(/^\//, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/\.\.+/g, '_')
    .slice(-100);
  return `topic-${base}-${crypto.createHash('sha256').update(commonDir).digest('hex').slice(0, 12)}`;
}

/** A small regular file a container controls, read without following a link or blocking on a FIFO. */
function readPlainFile(file: string): Buffer | null {
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function verifyBundle(bundle: HostOwnedPath, objectsDir: string, scratchRoot: HostOwnedPath, timeoutMs: number): void {
  // `git bundle verify` checks prerequisites, not the pack; index-pack inflates every object and checks the trailer.
  const bytes = fs.readFileSync(bundle);
  const headerEnd = bytes.indexOf('\n\n');
  if (headerEnd < 0) throw new Error(`${bundle} has no bundle header`);
  const pack = hostChild(scratchRoot, 'verify.pack');
  fs.writeFileSync(pack, bytes.subarray(headerEnd + 2));
  const verifyDir = hostChild(scratchRoot, 'verify.git');
  runGit({ gitDir: verifyDir, args: ['init', '--bare', '-q', verifyDir] }, timeoutMs);
  const fd = fs.openSync(pack, 'r');
  try {
    runGit(
      {
        gitDir: verifyDir,
        stdinFd: fd,
        env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsDir },
        args: ['index-pack', '--stdin', '--fix-thin', '-o', hostChild(verifyDir, 'verify.idx')],
      },
      timeoutMs,
    );
  } finally {
    fs.closeSync(fd);
  }
}

/** Throws on any ref or reflog the host cannot read: git skips an unreadable ref directory or reflog without a word. */
function assertRefsReadable(commonDir: string): void {
  // Buffer paths: a name that is not UTF-8 would decode lossily and then read as absent.
  const walk = (entry: Buffer): void => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entry);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(entry, { encoding: 'buffer' })) {
          walk(Buffer.concat([entry, Buffer.from('/'), name]));
        }
      } else if (stat.isFile()) {
        fs.accessSync(entry, fs.constants.R_OK);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  };
  for (const name of ['refs', 'logs', 'packed-refs']) walk(Buffer.from(path.join(commonDir, name)));
}

/**
 * Every stash: the ref's tip plus every commit its reflog names, parsed here. `git stash list` walks that reflog and
 * silently drops an entry whose commit it cannot load, and prints nothing for a ref whose reflog was expired.
 */
function stashTips(commonDir: string, refTip: Buffer): string[] {
  const tips = new Set(lines(refTip));
  const reflog = readPlainFile(path.join(commonDir, 'logs', 'refs', 'stash'));
  for (const line of reflog ? lines(reflog) : []) {
    const entry = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) /.exec(line);
    if (!entry) throw new Error(`unparseable stash reflog line in ${commonDir}: ${JSON.stringify(line)}`);
    if (!/^0+$/.test(entry[2])) tips.add(entry[2]);
  }
  return [...tips];
}

function bundleRepo(repo: ContainerWritableRepo, dir: HostOwnedPath, options: TopicSnapshotOptions): number {
  const run = (call: GitCall) => runGit(call, options.timeoutMs);
  const at = repo.checkouts[0];
  assertRefsReadable(repo.commonDir);
  const updates: string[] = [];
  for (const line of lines(
    run({ cwd: at, args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'] }).stdout,
  )) {
    const [sha, name] = line.split(' ');
    updates.push(`create ${name} ${sha}`);
  }
  for (const sha of stashTips(
    repo.commonDir,
    run({ cwd: at, args: ['for-each-ref', '--format=%(objectname)', 'refs/stash'] }).stdout,
  )) {
    updates.push(`create refs/git-safety/stash/${sha} ${sha}`);
  }
  for (const checkout of repo.checkouts) {
    const symbolic = run({ cwd: checkout, args: ['symbolic-ref', '-q', 'HEAD'], okStatus: [0, 1] });
    if (symbolic.status === 0) continue;
    const head = lines(run({ cwd: checkout, args: ['rev-parse', '--verify', 'HEAD'] }).stdout)[0];
    updates.push(`create refs/git-safety/detached/${labelFor(checkout).slice('topic-'.length)} ${head}`);
  }
  if (updates.length === 0) return 0;
  const negatives = lines(run({ cwd: at, args: ['for-each-ref', '--format=^%(objectname)', 'refs/remotes'] }).stdout);
  const objectsDir = onePath(
    run({ cwd: at, args: ['rev-parse', '--path-format=absolute', '--git-path', 'objects'] }).stdout,
  );
  const shallow = readPlainFile(path.join(repo.commonDir, 'shallow'));

  const scratchRoot = hostOwned(options.dataRoot, fs.mkdtempSync(path.join(os.tmpdir(), 'git-safety-topic-')));
  try {
    const scratch = hostChild(scratchRoot, 'repo.git');
    run({ gitDir: scratch, args: ['init', '--bare', '-q', scratch] });
    fs.writeFileSync(hostChild(scratch, 'objects', 'info', 'alternates'), `${objectsDir}\n`);
    if (shallow) fs.writeFileSync(hostChild(scratch, 'shallow'), shallow);
    run({ gitDir: scratch, args: ['update-ref', '--stdin'], input: `${updates.join('\n')}\n` });
    const tips = updates.map((update) => update.split(' ')[1]);
    const revs = `${[...tips, ...negatives].join('\n')}\n`;
    const count = run({ gitDir: scratch, args: ['rev-list', '--count', '--stdin'], input: revs }).stdout.toString();
    if (!/^\d+\n$/.test(count)) throw new Error(`rev-list --count printed ${JSON.stringify(count)}`);
    const commits = Number(count);
    if (commits === 0) return 0;
    const bundle = hostChild(dir, 'unpushed-commits.bundle');
    fs.mkdirSync(dir, { recursive: true });
    run({ gitDir: scratch, args: ['bundle', 'create', '-q', bundle, '--stdin'], input: revs });
    verifyBundle(bundle, hostChild(scratch, 'objects'), scratchRoot, options.timeoutMs);
    return commits;
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function nulRecords(stdout: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < stdout.length; i += 1) {
    if (stdout[i] !== 0) continue;
    if (i > start) records.push(stdout.subarray(start, i));
    start = i + 1;
  }
  return records;
}

async function captureCheckout(
  checkout: string,
  label: string,
  dir: HostOwnedPath,
  options: TopicSnapshotOptions,
  say: (line: string) => void,
): Promise<boolean> {
  const run = (call: GitCall) => runGit(call, options.timeoutMs);
  const filters = repoFilterNames(checkout, options.timeoutMs);
  const status = run({
    cwd: checkout,
    filters,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=dirty'],
  }).stdout;
  if (status.length === 0) return false;

  const slug = labelFor(checkout).slice('topic-'.length);
  fs.mkdirSync(dir, { recursive: true });
  const headProbe = run({ cwd: checkout, args: ['rev-parse', '-q', '--verify', 'HEAD'], okStatus: [0, 1] });
  const base =
    headProbe.status === 0
      ? 'HEAD'
      : lines(run({ cwd: checkout, args: ['hash-object', '-t', 'tree', '--stdin'], input: '' }).stdout)[0];

  const work = hostOwned(options.dataRoot, fs.mkdtempSync(path.join(os.tmpdir(), 'git-safety-capture-')));
  try {
    const raw = hostChild(work, 'patch');
    const fd = fs.openSync(raw, 'w');
    try {
      run({
        cwd: checkout,
        filters,
        stdoutFd: fd,
        args: [
          'diff-index',
          '--no-color',
          '-p',
          '--binary',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=dirty',
          base,
        ],
      });
    } finally {
      fs.closeSync(fd);
    }
    if (fs.statSync(raw).size > 0) {
      const patch = hostChild(dir, `${slug}.patch.gz`);
      await pipeline(fs.createReadStream(raw), zlib.createGzip(), fs.createWriteStream(patch));
    }

    const kept: Buffer[] = [];
    const untracked = run({
      cwd: checkout,
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
    }).stdout;
    for (const file of nulRecords(untracked)) {
      const shown = JSON.stringify(file.toString());
      const name = file.subarray(file.lastIndexOf(0x2f) + 1).toString();
      if (SECRET_SHAPED.test(name)) {
        say(`${label}: ${checkout}: excluded ${shown} from snapshot (secret-shaped filename)`);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(Buffer.concat([Buffer.from(`${checkout}/`), file]));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        say(`${label}: ${checkout}: ${shown} vanished while listing`);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        say(`${label}: ${checkout}: skipped ${shown} (not a file or symlink)`);
        continue;
      }
      if (stat.isFile() && stat.size >= options.maxUntrackedBytes) {
        say(`${label}: ${checkout}: skipped ${shown} (${stat.size} bytes, >= ${options.maxUntrackedBytes} cap)`);
        continue;
      }
      kept.push(file);
    }
    if (kept.length > 0) {
      const list = hostChild(work, 'untracked.list');
      fs.writeFileSync(list, Buffer.concat(kept.flatMap((file) => [file, Buffer.from([0])])));
      const tarball = hostChild(dir, `${slug}-untracked.tgz`);
      // A checkout in use can lose a file between listing and archiving; any other unread file is a failure.
      const tar = spawnSync(
        'tar',
        ['--null', '--no-recursion', '--ignore-failed-read', '-C', checkout, '-T', list, '-czf', tarball],
        {
          env: { PATH: process.env.PATH, LC_ALL: 'C' },
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
        },
      );
      const warnings = tar.stderr ? lines(tar.stderr) : [];
      const unread = warnings.filter((line) => !/: Warning: Cannot stat: No such file or directory$/.test(line));
      if (tar.error || tar.signal || tar.status !== 0 || unread.length > 0) {
        throw new Error(
          `tar of untracked files in ${checkout}: ${unread.join('; ') || tar.signal || tar.error?.message || `exit ${tar.status}`}`,
        );
      }
      for (const warning of warnings) say(`${label}: ${checkout}: tar: ${warning}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  const head =
    headProbe.status === 0
      ? lines(run({ cwd: checkout, args: ['rev-parse', '--short', 'HEAD'] }).stdout)[0]
      : '(unborn)';
  const branch =
    lines(run({ cwd: checkout, args: ['rev-parse', '--abbrev-ref', 'HEAD'], okStatus: [0, 128] }).stdout)[0] ??
    '(unborn)';
  say(`${label}: ${checkout}  HEAD=${head} branch=${branch} uncommitted=${nulRecords(status).length}`);
  return true;
}

/** `raw` as a string only when it round-trips byte-exact; the decoder alone drops a leading BOM. */
function decodeName(raw: Buffer): string | null {
  let name: string;
  try {
    name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return null;
  }
  return Buffer.from(name).equals(raw) ? name : null;
}

/**
 * The paths `pattern` matches, by its own directory walk: `fs.globSync` skips a directory it cannot read, so an
 * unreadable topic would vanish from the run. Only ENOENT is absence, and past the first wildcard, where a
 * container chose the names, a symlink is listed rather than followed.
 */
function expand(pattern: string): { checkouts: string[]; unreadable: Admission[]; failures: string[] } {
  const isGlob = (segment: string): boolean => /[*?[]/.test(segment);
  const [rootSegment, ...segments] = path.resolve(pattern).split(path.sep);
  const unreadable: Admission[] = [];
  const failures: string[] = [];
  const failed = (where: string, err: unknown): void => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(`${where}: ${(err as Error).message}`);
  };
  let level = [rootSegment || path.sep];
  let untrusted = false;
  for (const [index, segment] of segments.entries()) {
    const wildcard = isGlob(segment);
    untrusted ||= wildcard;
    const last = index === segments.length - 1;
    const next: string[] = [];
    for (const dir of level) {
      let names = [segment];
      if (wildcard) {
        try {
          names = [];
          for (const raw of fs.readdirSync(dir, { encoding: 'buffer' })) {
            const name = decodeName(raw);
            if (name === null) {
              const shown = path.join(dir, raw.toString());
              unreadable.push({ kind: 'unreadable', checkout: shown, reason: 'its name is not byte-exact UTF-8' });
            } else if (path.matchesGlob(name, segment)) {
              names.push(name);
            }
          }
        } catch (err) {
          failed(dir, err);
          continue;
        }
      }
      for (const name of names) {
        const candidate = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = untrusted ? fs.lstatSync(candidate) : fs.statSync(candidate);
        } catch (err) {
          failed(candidate, err);
          continue;
        }
        if (last) next.push(candidate);
        else if (stat.isSymbolicLink())
          unreadable.push({ kind: 'unreadable', checkout: candidate, reason: 'a symlink' });
        else if (stat.isDirectory()) next.push(candidate);
      }
    }
    level = next;
  }
  return { checkouts: level, unreadable, failures };
}

/** True only when `p` provably no longer exists; any other error leaves the failure standing. */
function gone(p: string): boolean {
  try {
    fs.lstatSync(p);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export async function snapshotTopics(options: TopicSnapshotOptions): Promise<TopicSnapshotResult> {
  const dataRoot = fs.realpathSync(options.dataRoot);
  const resolved = { ...options, dataRoot };
  const outDir = hostOwned(dataRoot, options.outDir);
  const manifest = hostOwned(dataRoot, options.manifestPath);
  const say = (line: string): void => fs.appendFileSync(manifest, `${line}\n`);

  if (options.patterns.length === 0) throw new Error('no topic checkout patterns');
  const result: TopicSnapshotResult = { captured: 0, bundled: 0, unreadable: [], failures: [] };
  const found = new Set<string>();
  for (const pattern of options.patterns) {
    const expanded = expand(pattern);
    for (const checkout of expanded.checkouts) found.add(checkout);
    result.unreadable.push(...expanded.unreadable);
    result.failures.push(...expanded.failures);
    if (expanded.checkouts.length + expanded.unreadable.length + expanded.failures.length === 0) {
      result.failures.push(`pattern ${pattern}: matched nothing`);
    }
  }
  const checkouts = [...found].sort();
  const admissions: Admission[] = [];
  for (const checkout of checkouts) {
    try {
      const admission = admit(dataRoot, checkout, options.timeoutMs);
      admissions.push(admission);
      if (admission.kind === 'unreadable') result.unreadable.push(admission);
    } catch (err) {
      result.failures.push(`${checkout}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const removed: string[] = [];
  for (const repo of groupRepos(admissions)) {
    const label = labelFor(repo.commonDir);
    const dir = hostChild(outDir, label);
    try {
      const commits = bundleRepo(repo, dir, resolved);
      if (commits > 0) {
        result.bundled += 1;
        say(
          `${label}: bundled ${commits} commit(s) on no remote (built in a scratch repo; ${repo.commonDir} untouched)`,
        );
      }
    } catch (err) {
      if (gone(repo.commonDir)) removed.push(repo.commonDir);
      else result.failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const checkout of repo.checkouts) {
      try {
        if (await captureCheckout(checkout, label, dir, resolved, say)) result.captured += 1;
      } catch (err) {
        if (gone(checkout)) removed.push(checkout);
        else result.failures.push(`${label}: ${checkout}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // A checkout moved away and back mid-run (quarantine, migration rollback) still needed capturing.
  for (const entry of removed) {
    if (gone(entry)) say(`${entry} was removed during the run`);
    else result.failures.push(`${entry}: missing while captured, present after the run`);
  }

  if (result.unreadable.length > 0) {
    say(`topic checkouts git cannot open (not snapshotted): ${result.unreadable.length}`);
    for (const entry of result.unreadable) {
      if (entry.kind === 'unreadable') say(`  ${JSON.stringify(entry.checkout)}: ${entry.reason}`);
    }
  }
  return result;
}
