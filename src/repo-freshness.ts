/**
 * Repo freshness worker (repo-store rework).
 *
 * For every workgroup bare mirror (`data/workgroups/<wg>/.repos/<name>.git`):
 *   1. `git fetch origin` in the mirror (advances refs/heads via the
 *      +refs/heads/*:refs/heads/* refspec; never --prune — mirrors hold
 *      parked/rescue branches that exist nowhere on origin). Fetches run
 *      with HOST credentials, so origins are pinned in host-owned metadata
 *      (data/repo-store/<wg>.json, TOFU + github-only) and config drift in
 *      the agent-writable mirror skips the fetch loudly.
 *   2. Re-point the mirror's HEAD symref at the remote's default branch
 *      (`ls-remote --symref origin HEAD`), so default-branch renames follow.
 *   3. Advance the browsing snapshot at `data/workgroups/<wg>/<name>/` to the
 *      exact mirror HEAD OID: fetch objects FROM THE LOCAL MIRROR (no second
 *      network trip), then `checkout --detach <oid>`. Detached on purpose —
 *      there is no branch to park, which is the whole point of the topology.
 *   4. Record `.repos/<name>.freshness.json` (ts, oid, ref, fetchOk) so
 *      agents and operators can see exactly how fresh the snapshot is.
 *
 * Failures are LOUD (log.error + ok:false in the freshness file) — a stale
 * browsing tree that looks current is precisely the failure mode this
 * subsystem exists to kill.
 *
 * ACCEPTED TRADEOFF: the snapshot advance (checkout --detach <oid>) mutates
 * the live tree in place, so a reader can see a mixed-generation tree for
 * the seconds a checkout takes. An off-path build + rename swap would be
 * atomic but breaks the RO bind mounts into running containers (they keep
 * the old inode). Graphify publishes atomically from its own generation
 * store and re-reconciles, and a failed checkout is recorded + retried next
 * cycle, so the window is transient and visible.
 *
 * Runs on its own serialized interval, NOT inside the 60s host sweep: fetches
 * are network-bound and must never delay message delivery. All git calls are
 * async (execFile) so the event loop stays free.
 *
 * ponytail: one flat serialized loop, no per-repo scheduling or backoff —
 * add per-repo backoff if a chronically-failing remote ever makes the cycle
 * too slow.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const execFileP = promisify(execFile);

const FRESHNESS_INTERVAL_MS = 10 * 60 * 1000;
const STARTUP_DELAY_MS = 90_000;
const GIT_TIMEOUT_MS = 120_000;
const MIGRATION_LOCK_TTL_MS = 2 * 60 * 60 * 1000;

export interface RepoFreshness {
  ts: string;
  oid: string | null;
  ref: string | null;
  fetchOk: boolean;
  error?: string;
}

// The host service runs behind the onecli gateway proxy, which overrides the
// Authorization header for matched hosts. GitHub creds are env-only (never in
// the vault), so a proxied fetch always fails auth. Pins are github.com-only;
// bypass the proxy so git uses the host's own credential helper directly.
const GIT_ENV = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, 'github.com'].filter(Boolean).join(','),
  no_proxy: [process.env.no_proxy, 'github.com'].filter(Boolean).join(','),
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: 'utf-8',
    env: GIT_ENV,
  });
  return stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function workgroupsRoot(): string {
  return path.join(DATA_DIR, 'workgroups');
}

interface MirrorTarget {
  workgroupId: string;
  repo: string;
  mirrorPath: string;
  snapshotPath: string;
}

export function discoverMirrors(root: string = workgroupsRoot()): MirrorTarget[] {
  const targets: MirrorTarget[] = [];
  let wgs: string[];
  try {
    wgs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return targets;
  }
  for (const wg of wgs) {
    const reposDir = path.join(root, wg, '.repos');
    // A live migration owns this workgroup's repo store for its duration —
    // advancing snapshots mid-swap would race the cutover renames.
    const lockFile = path.join(reposDir, '.migration-lock');
    if (fs.existsSync(lockFile)) {
      // Respect a live migration, but recover from a stale lock (killed
      // migration, or agent-planted DoS — the tree is agent-writable): locks
      // older than the TTL are ignored loudly.
      let lockAgeMs = 0;
      try {
        lockAgeMs = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        /* vanished between check and stat — treat as no lock */
      }
      if (lockAgeMs < MIGRATION_LOCK_TTL_MS) {
        log.info('repo-freshness: migration lock present, skipping workgroup', { workgroupId: wg });
        continue;
      }
      log.warn('repo-freshness: IGNORING stale migration lock (older than TTL)', {
        workgroupId: wg,
        lockAgeMs,
      });
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(reposDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Never follow symlinked mirror entries — the workgroup tree is
      // agent-writable, and a symlink here could point the worker (and the
      // snapshot it maintains) at a foreign repo.
      if (!entry.name.endsWith('.git') || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const mirrorPath = path.join(reposDir, entry.name);
      if (!fs.existsSync(path.join(mirrorPath, 'HEAD'))) continue;
      const repo = entry.name.slice(0, -'.git'.length);
      targets.push({ workgroupId: wg, repo, mirrorPath, snapshotPath: path.join(root, wg, repo) });
    }
  }
  return targets;
}

function writeFreshness(target: MirrorTarget, freshness: RepoFreshness): void {
  const file = path.join(path.dirname(target.mirrorPath), `${target.repo}.freshness.json`);
  try {
    // .repos is agent-writable: a symlink planted at the freshness path would
    // make a direct write follow it to an arbitrary host file. rename()
    // REPLACES a symlink instead of following it, so temp-write + rename is
    // symlink-safe and atomic for readers.
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(freshness, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn('repo-freshness: failed to write freshness file', { file, err });
  }
}

/** Parse `ls-remote --symref origin HEAD` → `refs/heads/<default>` or null. */
function parseSymrefHead(out: string | null): string | null {
  const m = out?.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD/m);
  return m ? m[1] : null;
}

/**
 * Host-owned origin pins, outside the agent-writable workgroup tree
 * (`data/repo-store/<wg>.json`). The worker fetches with HOST credentials, so
 * the fetch target must not be steerable by editing agent-writable git
 * config: an origin is pinned on first sight (trust-on-first-use; migration
 * and clone_repo both create mirrors with sanctioned origins), must be a
 * github.com HTTPS URL, and any later drift in the mirror's config makes the
 * worker skip the repo loudly instead of fetching the new target.
 */
function pinsRoot(root: string): string {
  // Production: data/repo-store (host-owned, outside the agent-writable
  // workgroups tree). Non-default roots (tests) get a sibling dir so pin
  // state never leaks across runs.
  return root === workgroupsRoot() ? path.join(DATA_DIR, 'repo-store') : `${root}.repo-pins`;
}
function originPinsFile(root: string, workgroupId: string): string {
  return path.join(pinsRoot(root), `${fsSafe(workgroupId)}.json`);
}
function fsSafe(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}
function readOriginPins(root: string, workgroupId: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(originPinsFile(root, workgroupId), 'utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}
function writeOriginPin(root: string, workgroupId: string, repo: string, url: string): void {
  const file = originPinsFile(root, workgroupId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pins = readOriginPins(root, workgroupId);
  pins[repo] = url;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pins, null, 2));
  fs.renameSync(tmp, file);
}
export function isPinnableOrigin(url: string): boolean {
  // Test-only escape hatch: fixtures use local-path remotes. Production
  // never sets this — a local-path origin would let host-credentialed git
  // read arbitrary host repos into a workgroup snapshot.
  if (process.env.NANOCLAW_FRESHNESS_ALLOW_ANY_ORIGIN === '1') return true;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com';
  } catch {
    return false;
  }
}

/** Real, non-symlinked directory whose realpath stays under <root>. */
function containedRealDir(candidate: string, root: string): boolean {
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return false;
    const real = fs.realpathSync(candidate);
    const rootReal = fs.realpathSync(root);
    return real === rootReal || real.startsWith(rootReal + path.sep);
  } catch {
    return false;
  }
}

export async function refreshOne(target: MirrorTarget, root: string = workgroupsRoot()): Promise<RepoFreshness> {
  const { mirrorPath, snapshotPath, workgroupId, repo } = target;
  const ctx = { workgroupId, repo };
  const ts = new Date().toISOString();

  // The workgroup tree is agent-writable: refuse symlinked or escaping
  // mirror/snapshot paths before ANY host git operation touches them.
  const wgRoot = path.join(root, workgroupId);
  if (!containedRealDir(mirrorPath, wgRoot)) {
    log.error('repo-freshness: mirror path is symlinked or escapes the workgroup tree — skipping', {
      ...ctx,
      mirrorPath,
    });
    return { ts, oid: null, ref: null, fetchOk: false, error: 'mirror path rejected' };
  }
  if (fs.existsSync(snapshotPath) && !containedRealDir(snapshotPath, wgRoot)) {
    log.error('repo-freshness: snapshot path is symlinked or escapes the workgroup tree — skipping', {
      ...ctx,
      snapshotPath,
    });
    return { ts, oid: null, ref: null, fetchOk: false, error: 'snapshot path rejected' };
  }

  // Origin pin check BEFORE fetching with host credentials.
  const mirrorOrigin = await tryGit(mirrorPath, ['config', '--get', 'remote.origin.url']);
  const pins = readOriginPins(root, workgroupId);
  const pinned = pins[repo];
  if (mirrorOrigin) {
    if (pinned === undefined) {
      if (!isPinnableOrigin(mirrorOrigin)) {
        log.error('repo-freshness: mirror origin is not a pinnable github.com HTTPS URL — skipping fetch', {
          ...ctx,
          mirrorOrigin,
        });
        const freshnessEarly: RepoFreshness = {
          ts,
          oid: null,
          ref: null,
          fetchOk: false,
          error: 'origin not pinnable',
        };
        writeFreshness(target, freshnessEarly);
        return freshnessEarly;
      }
      writeOriginPin(root, workgroupId, repo, mirrorOrigin);
    } else if (pinned !== mirrorOrigin) {
      log.error('repo-freshness: mirror origin DRIFTED from host pin — skipping fetch', {
        ...ctx,
        pinned,
        mirrorOrigin,
      });
      const freshnessDrift: RepoFreshness = {
        ts,
        oid: null,
        ref: null,
        fetchOk: false,
        error: 'origin drifted from pin',
      };
      writeFreshness(target, freshnessDrift);
      return freshnessDrift;
    }
  }

  // Automatic gc in the mirror could repack/prune objects while a container
  // clone is reading them; the mirror only grows via fetch, so gc stays an
  // explicit operator action. Idempotent, cheap, and also covers mirrors
  // created before this setting existed.
  await tryGit(mirrorPath, ['config', 'gc.auto', '0']);

  // NO --prune: migration-created mirrors hold parked/rescue branches that
  // exist nowhere on origin; with the refs/heads mirror refspec, prune would
  // delete them. Remote-deleted branches lingering in the mirror are noise,
  // not risk — the snapshot tracks HEAD only.
  const fetched = mirrorOrigin ? await tryGit(mirrorPath, ['fetch', 'origin']) : '';
  const fetchOk = fetched !== null;
  if (!fetchOk) {
    log.error('repo-freshness: mirror fetch FAILED — snapshot is stale', { ...ctx, mirrorPath });
  }

  const freshness: RepoFreshness = { ts, oid: null, ref: null, fetchOk };

  // Follow a default-branch rename. Only meaningful after a successful
  // fetch; ls-remote is its own network call, so skip it when fetch failed.
  // A symref lookup failure must be VISIBLE — silently keeping the old HEAD
  // would report a stale default branch as fresh.
  if (fetchOk && mirrorOrigin) {
    const symrefOut = await tryGit(mirrorPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const symref = parseSymrefHead(symrefOut);
    if (symref) {
      const set = await tryGit(mirrorPath, ['symbolic-ref', 'HEAD', symref]);
      if (set === null) {
        freshness.error = 'default-branch symref update failed';
        log.warn('repo-freshness: symbolic-ref HEAD update failed', { ...ctx, symref });
      }
    } else {
      freshness.error = 'default-branch symref lookup failed';
      log.warn('repo-freshness: ls-remote --symref failed or unparsable — keeping current HEAD', ctx);
    }
  }

  freshness.ref = await tryGit(mirrorPath, ['symbolic-ref', 'HEAD']);
  const oid = await tryGit(mirrorPath, ['rev-parse', 'HEAD']);
  freshness.oid = oid;

  if (!oid) {
    freshness.error = 'mirror HEAD unresolvable';
    log.error('repo-freshness: mirror HEAD unresolvable', { ...ctx, mirrorPath });
    writeFreshness(target, freshness);
    return freshness;
  }

  // Snapshot advance. Missing snapshot (freshly migrated repo, or a failed
  // clone_repo half-step) is (re)created from the mirror.
  if (!fs.existsSync(path.join(snapshotPath, '.git'))) {
    const cloned = await tryGit(path.dirname(snapshotPath), ['clone', mirrorPath, snapshotPath]);
    if (cloned === null) {
      freshness.error = 'snapshot clone failed';
      log.error('repo-freshness: snapshot clone failed', { ...ctx, snapshotPath });
      writeFreshness(target, freshness);
      return freshness;
    }
    const realUrl = await tryGit(mirrorPath, ['config', '--get', 'remote.origin.url']);
    if (realUrl) await tryGit(snapshotPath, ['remote', 'set-url', 'origin', realUrl]);
    // Detached from birth — a snapshot on a branch invites exactly the
    // branch-parking this topology exists to prevent.
    await tryGit(snapshotPath, ['checkout', '--detach']);
  }

  const status = await tryGit(snapshotPath, ['status', '--porcelain']);
  if (status === null || status.length > 0) {
    // The snapshot is mounted RO into containers, so dirt here means either a
    // pre-RO-mount container wrote to it or an operator did. Never clobber —
    // scream instead.
    freshness.error = status === null ? 'snapshot status failed' : 'snapshot has local modifications';
    log.error('repo-freshness: snapshot NOT advanced', { ...ctx, snapshotPath, reason: freshness.error });
    writeFreshness(target, freshness);
    return freshness;
  }

  const already = await tryGit(snapshotPath, ['rev-parse', 'HEAD']);
  if (already !== oid) {
    // Objects come from the local mirror — no network, no credentials.
    const fetchedLocal = await tryGit(snapshotPath, ['fetch', mirrorPath, oid]);
    const detached = fetchedLocal === null ? null : await tryGit(snapshotPath, ['checkout', '--detach', oid]);
    if (detached === null) {
      freshness.error = 'snapshot advance failed';
      log.error('repo-freshness: snapshot advance failed', { ...ctx, snapshotPath, oid });
    } else {
      log.info('repo-freshness: snapshot advanced', { ...ctx, oid: oid.slice(0, 12) });
    }
  }

  writeFreshness(target, freshness);
  return freshness;
}

let running = false;

export async function runFreshnessOnce(root: string = workgroupsRoot()): Promise<void> {
  if (running) return; // serialized — a slow cycle must not stack another
  running = true;
  try {
    const targets = discoverMirrors(root);
    for (const target of targets) {
      try {
        await refreshOne(target, root);
      } catch (err) {
        log.error('repo-freshness: unexpected failure', { repo: target.repo, err });
      }
    }
  } finally {
    running = false;
  }
}

let intervalHandle: NodeJS.Timeout | null = null;
let startupHandle: NodeJS.Timeout | null = null;

export function startRepoFreshness(): void {
  if (intervalHandle || startupHandle) return;
  startupHandle = setTimeout(() => {
    startupHandle = null;
    void runFreshnessOnce();
  }, STARTUP_DELAY_MS);
  intervalHandle = setInterval(() => {
    void runFreshnessOnce();
  }, FRESHNESS_INTERVAL_MS);
}

export function stopRepoFreshness(): void {
  if (startupHandle) {
    clearTimeout(startupHandle);
    startupHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
