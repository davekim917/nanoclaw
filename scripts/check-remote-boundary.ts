#!/usr/bin/env tsx
/**
 * Daily host-side public-boundary scan of the `origin/main` TREE against the LIVE install
 * registry. The husky hooks are skippable (`--no-verify`), don't resolve inside containers, and
 * see only one push's objects; CI runs `--portable` because shipping the registry would publish it.
 *
 * NOT covered, a documented hole (keep this honest if the scope changes): unmerged topic branches,
 * commit MESSAGES, and content deleted from main. Scanning every head naively is hours per run.
 *
 * Transmits only the checker's own output, which never includes the matched value.
 * `data/systemd/nanoclaw-remote-boundary.{service,timer}` are reference copies the deployer installs.
 *
 * Exit: 0 clean or findings delivered; 1 findings nobody was told about, or the scan could not
 * run (the unit's OnFailure is the backstop for both).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { notifyOwner } from '../src/notify-owner.js';

/** From this file's location, not the cwd: an alerting job must not scan one install and alert another. */
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const REF = 'refs/remotes/origin/main';
const REF_LABEL = 'origin/main';

/** Keep one alert inside a chat message. Findings beyond this are counted, not listed. */
export const MAX_ALERT_LINES = 40;

export interface BoundaryScan {
  /** `scripts/check-public-boundary.ts`'s exit code: 0 clean, 1 findings or a degraded gate, 2 could not run. */
  code: number;
  /** Its stderr, with runtime noise stripped by `cleanCheckerOutput`. */
  detail: string;
}

export interface Alert {
  title: string;
  body: string;
}

export interface Reporter {
  /** Delivery result code, with `src/notify-owner.ts`'s contract: 0 delivered, 1 tried and failed, 2 cannot try. */
  notify(alert: Alert): Promise<number>;
  log(line: string): void;
  logError(line: string): void;
}

/**
 * Drops Node's own process warnings. Deliberately narrow (two runtime-only shapes), so an
 * unanticipated checker message still reaches the owner verbatim.
 */
export function cleanCheckerOutput(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
}

export function trimDetail(detail: string): string {
  const lines = detail.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= MAX_ALERT_LINES) return lines.join('\n');
  const shown = lines.slice(0, MAX_ALERT_LINES);
  return [...shown, `… and ${lines.length - MAX_ALERT_LINES} more line(s) — run the scan locally for the rest`].join(
    '\n',
  );
}

/** Exit 2 (could not run) alerts too: a gate that silently cannot run is what this job prevents. */
export function decideAlert(scan: BoundaryScan, commit: string): Alert | null {
  if (scan.code === 0) return null;
  const at = `${REF_LABEL} @ ${commit}`;
  const headline =
    scan.code === 1
      ? `The public-boundary scan of ${at} did not pass.`
      : `The public-boundary scan of ${at} could not run (exit ${scan.code}) — the remote is currently UNCHECKED.`;
  const detail = trimDetail(scan.detail) || '(the checker produced no output)';
  return {
    // Names the surface, not "the remote": the alert must not imply more than it checked.
    title: `Public boundary scan of the ${REF_LABEL} tree`,
    // The checker prints file:line and a category, never the matched value.
    body: `${headline}\n\nRedacted checker output:\n${detail}\n\nTriage: pnpm run check:public-boundary -- --index on a checkout of ${REF_LABEL}.`,
  };
}

/** Only 0 means the owner actually saw it. */
export function describeDelivery(code: number): string {
  if (code === 0) return 'delivered';
  if (code === 2) return 'could not be attempted';
  return 'was attempted and failed';
}

export async function reportScan(scan: BoundaryScan, commit: string, reporter: Reporter): Promise<number> {
  const alert = decideAlert(scan, commit);
  if (!alert) {
    reporter.log(`remote-boundary: clean (${REF_LABEL} @ ${commit})`);
    return 0;
  }
  const code = await reporter.notify(alert);
  if (code === 0) {
    reporter.log(`remote-boundary: alert sent to the owner DM (${REF_LABEL} @ ${commit})`);
    return 0;
  }
  // A finding nobody was told about fails the job, so the unit's OnFailure fires.
  reporter.logError(
    `remote-boundary: THE REMOTE HAS A FINDING BUT NOBODY WAS TOLD — the owner DM ${describeDelivery(code)}.\n` +
      `${alert.title}\n${alert.body}`,
  );
  return 1;
}

function git(args: string[], cwd = INSTALL_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface CheckerResult {
  status: number | null;
  stderr: string;
  error?: Error;
}

/** Injected so tests pin the checker invocation. */
export type RunChecker = (root: string) => CheckerResult;

// No --allowlist: an index scan reads the snapshot's committed copy, never the install checkout's.
const REAL_RUN_CHECKER: RunChecker = (root) => {
  const result = spawnSync('pnpm', ['run', 'check:public-boundary', '--', '--root', root, '--index'], {
    cwd: INSTALL_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stderr: result.stderr ?? '', error: result.error };
};

export function scanSnapshot(snapshot: string, runChecker: RunChecker = REAL_RUN_CHECKER): BoundaryScan {
  const result = runChecker(snapshot);
  if (result.error) throw result.error;
  return { code: result.status ?? 2, detail: cleanCheckerOutput(result.stderr) };
}

interface SnapshotRun<T> {
  value: T;
  /** Why cleanup did not fully succeed, or `null`. Never thrown away — see `reportCleanup`. */
  cleanupError: string | null;
}

/** Injected so a rewrite that swallows a `worktree remove` failure fails a test. */
export interface CleanupOps {
  removeWorktree(snapshot: string): void;
  removeDirectory(parent: string): void;
}

const REAL_CLEANUP: CleanupOps = {
  removeWorktree: (snapshot) => git(['worktree', 'remove', '--force', snapshot]),
  removeDirectory: (parent) => fs.rmSync(parent, { recursive: true, force: true }),
};

/** Attempts EVERY step: a worktree-remove failure must not skip removing the directory. */
export function cleanupSnapshot(parent: string, snapshot: string, ops: CleanupOps = REAL_CLEANUP): string | null {
  const failures: string[] = [];
  try {
    ops.removeWorktree(snapshot);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    failures.push(`could not remove the snapshot worktree ${snapshot}: ${message(err)}`);
  }
  try {
    ops.removeDirectory(parent);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    failures.push(`could not remove the snapshot directory ${parent}: ${message(err)}`);
  }
  return failures.length > 0 ? failures.join('; ') : null;
}

/**
 * A cleanup failure leaves a registration in the live checkout's shared git metadata, so it must
 * exit non-zero. Only ever raises the exit code; callers report the scan FIRST.
 */
export function reportCleanup(cleanupError: string | null, scanExit: number, reporter: Reporter): number {
  if (cleanupError === null) return scanExit;
  reporter.logError(
    `remote-boundary: ${cleanupError}. A stale worktree registration may be left in the shared git metadata — ` +
      'run `git worktree prune` in the install root.',
  );
  return scanExit === 0 ? 1 : scanExit;
}

/** Scan verdict first, then cleanup; exported so a test pins the order. */
export async function reportOutcome(
  scan: BoundaryScan,
  commit: string,
  cleanupError: string | null,
  reporter: Reporter,
): Promise<number> {
  const scanExit = await reportScan(scan, commit, reporter);
  return reportCleanup(cleanupError, scanExit, reporter);
}

function withSnapshot<T>(commit: string, body: (snapshot: string) => T): SnapshotRun<T> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remote-boundary-'));
  const snapshot = path.join(parent, 'tree');
  // No hooks: `worktree add` fires `post-checkout`, which becomes load-bearing the day someone
  // adds `.husky/post-checkout`.
  git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', snapshot, commit]);
  let value: T;
  try {
    value = body(snapshot);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    // Still clean up; the original failure stands, so a cleanup error can only be logged.
    const cleanupError = cleanupSnapshot(parent, snapshot);
    if (cleanupError !== null) console.error(`remote-boundary: ${cleanupError}`);
    throw err;
  }
  return { value, cleanupError: cleanupSnapshot(parent, snapshot) };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<number> {
  let scan: BoundaryScan;
  let commit: string;
  let cleanupError: string | null;
  try {
    git(['fetch', '--quiet', 'origin', 'main']);
    commit = git(['rev-parse', '--short', REF]);
    ({ value: scan, cleanupError } = withSnapshot(commit, (snapshot) => scanSnapshot(snapshot)));
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    // Nothing was scanned: fail the unit and let OnFailure carry it.
    console.error(`remote-boundary: could not scan ${REF_LABEL}: ${message(err)}`);
    return 1;
  }

  const reporter: Reporter = {
    notify: async (alert) => {
      const delivery = await notifyOwner({ title: alert.title, body: alert.body });
      if (delivery.code !== 0) console.error(`remote-boundary: owner DM failed: ${delivery.message}`);
      return delivery.code;
    },
    log: (line) => console.log(line),
    logError: (line) => console.error(line),
  };

  return reportOutcome(scan, commit, cleanupError, reporter);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`remote-boundary: ${message(err)}`);
      process.exitCode = 1;
    });
}
