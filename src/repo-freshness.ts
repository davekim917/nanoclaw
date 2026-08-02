/**
 * Repo freshness worker (repo-store rework).
 *
 * For every workgroup bare mirror (`data/workgroups/<wg>/.repos/<name>.git`):
 *   1. `git fetch origin --prune` in the mirror (advances refs/heads — the
 *      mirror's fetch refspec is +refs/heads/*:refs/heads/*).
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

export interface RepoFreshness {
  ts: string;
  oid: string | null;
  ref: string | null;
  fetchOk: boolean;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: 'utf-8' });
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
    let entries: string[];
    try {
      entries = fs.readdirSync(reposDir).filter((n) => n.endsWith('.git'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const mirrorPath = path.join(reposDir, entry);
      if (!fs.existsSync(path.join(mirrorPath, 'HEAD'))) continue;
      const repo = entry.slice(0, -'.git'.length);
      targets.push({ workgroupId: wg, repo, mirrorPath, snapshotPath: path.join(root, wg, repo) });
    }
  }
  return targets;
}

function writeFreshness(target: MirrorTarget, freshness: RepoFreshness): void {
  const file = path.join(path.dirname(target.mirrorPath), `${target.repo}.freshness.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(freshness, null, 2));
  } catch (err) {
    log.warn('repo-freshness: failed to write freshness file', { file, err });
  }
}

/** Parse `ls-remote --symref origin HEAD` → `refs/heads/<default>` or null. */
function parseSymrefHead(out: string | null): string | null {
  const m = out?.match(/^ref:\s+(refs\/heads\/\S+)\s+HEAD/m);
  return m ? m[1] : null;
}

export async function refreshOne(target: MirrorTarget): Promise<RepoFreshness> {
  const { mirrorPath, snapshotPath, workgroupId, repo } = target;
  const ctx = { workgroupId, repo };
  const ts = new Date().toISOString();

  const fetched = await tryGit(mirrorPath, ['fetch', 'origin', '--prune']);
  const fetchOk = fetched !== null;
  if (!fetchOk) {
    log.error('repo-freshness: mirror fetch FAILED — snapshot is stale', { ...ctx, mirrorPath });
  }

  // Follow a default-branch rename. Only meaningful after a successful
  // fetch; ls-remote is its own network call, so skip it when fetch failed.
  if (fetchOk) {
    const symref = parseSymrefHead(await tryGit(mirrorPath, ['ls-remote', '--symref', 'origin', 'HEAD']));
    if (symref) await tryGit(mirrorPath, ['symbolic-ref', 'HEAD', symref]);
  }

  const ref = await tryGit(mirrorPath, ['symbolic-ref', 'HEAD']);
  const oid = await tryGit(mirrorPath, ['rev-parse', 'HEAD']);
  const freshness: RepoFreshness = { ts, oid, ref, fetchOk };

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
        await refreshOne(target);
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
