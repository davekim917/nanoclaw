#!/usr/bin/env tsx
/**
 * Daily whole-tree public-boundary scan of what actually reached the remote.
 *
 * WHY A PERIODIC SCAN AND NOT JUST THE HOOK
 * ------------------------------------------
 * `.husky/pre-commit`, `.husky/commit-msg` and `.husky/pre-push` gate content on
 * its way OUT of a checkout. They are necessary but they are not a gate:
 *
 *   - `git push --no-verify` skips them outright.
 *   - Container agents push with `core.hooksPath` pointing at a host path that
 *     is unresolvable inside the container, so git runs no hook — by design
 *     (`scripts/pin-git-hooks-path.sh` explains why that must stay true).
 *   - A hook only ever sees the objects one push carries, never the tree as a
 *     whole, so anything that landed before the gate existed stays invisible.
 *
 * CI cannot cover it either: `.github/workflows/ci.yml` runs the checker with
 * `--portable` (structural patterns only) because a GitHub runner has no
 * `data/v2.db`, and shipping the identifier registry to CI would publish the
 * very thing the registry exists to keep private.
 *
 * So this runs on the host, daily, against the LIVE install registry, over the
 * tree of `origin/main`.
 *
 * WHAT THIS DOES NOT COVER — do not read it as "is anything private on the
 * remote right now?"
 * ------------------------------------------------------------------------
 * It answers the narrower question "is anything private in the `origin/main`
 * TREE right now?". Three things reach the remote and are never scanned here:
 *
 *   1. Unmerged topic branches — anything pushed to a ref that has not merged.
 *   2. Commit MESSAGES — this scans trees only. `.husky/commit-msg` gates them
 *      locally, but that hook is skippable and does not resolve inside a
 *      container, which is the bypass path this job exists to backstop.
 *   3. Content deleted from main — present in remote history, absent from the
 *      current tip's tree.
 *
 * That is a documented hole, not an oversight: `git ls-remote --heads origin`
 * is 300 branches and one whole-tree `--index` scan measures 27.8s on this
 * host, so scanning every head naively is ~2.3 hours per run. Closing it needs
 * a scanned-tip cursor, per-commit message scanning and changed-path scanning
 * — a design, not a patch. Tracked in issue #592.
 *
 * A backstop that overstates its own coverage is worse than one with a hole
 * someone can see, so keep this paragraph honest if the scope changes.
 *
 * WHAT IS TRANSMITTED
 * -------------------
 * Only the checker's own output. It prints `file:line category` and a count and
 * never the matched value (see the finding loop in
 * `scripts/check-public-boundary.ts`'s `main`), so the alert body is redacted at
 * the source. Nothing here reads, reconstructs or forwards an identifier value.
 *
 * INSTALLATION
 * ------------
 * `data/systemd/nanoclaw-remote-boundary.{service,timer}` are reference copies,
 * tracked but NOT installed by this script — the deployer installs and enables
 * them. Manual run: `pnpm exec tsx scripts/check-remote-boundary.ts`.
 *
 * EXIT CODES
 * ----------
 *   0 — clean, or findings that were delivered to the owner.
 *   1 — something to say and nobody was told (delivery failed or was
 *       impossible), or the scan could not be run at all. The unit's
 *       `OnFailure=nanoclaw-unit-alert@%n.service` is the backstop for both.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { notifyOwner } from '../src/notify-owner.js';

/**
 * This install's root, derived from THIS FILE's location rather than the cwd —
 * same reasoning as `src/notify-owner.ts`'s `INSTALL_ROOT`: an alerting job must
 * not scan one install and alert another because of where it was invoked from.
 * It is also what makes `data/v2.db` resolvable, since the checker reaches the
 * registry through the snapshot's common checkout (`findMainCheckoutRoot` in
 * `scripts/check-public-boundary.ts:442`).
 */
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

/** The remote-tracking ref this scans. */
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
 * Drop Node's own process warnings from the checker's stderr.
 *
 * Node prints `(node:<pid>) [UNDICI-EHPA] Warning: …` plus a `(Use \`node
 * --trace-warnings …\`)` follow-up on stderr for every process in the chain, so
 * an unfiltered capture puts three PID-bearing lines in front of the finding
 * that matters. The filter is deliberately narrow — two literal shapes emitted
 * by the runtime, never by the checker — so a checker message this file has not
 * anticipated still reaches the owner verbatim.
 */
export function cleanCheckerOutput(stderr: string): string {
  return stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\)/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
}

/** The detail block for an alert: the checker's own lines, capped. */
export function trimDetail(detail: string): string {
  const lines = detail.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length <= MAX_ALERT_LINES) return lines.join('\n');
  const shown = lines.slice(0, MAX_ALERT_LINES);
  return [...shown, `… and ${lines.length - MAX_ALERT_LINES} more line(s) — run the scan locally for the rest`].join(
    '\n',
  );
}

/**
 * What, if anything, to tell the owner.
 *
 * Exit 1 and exit 2 are different problems but the same decision: the first
 * means the remote is carrying something it should not, the second means the
 * gate could not run — and a gate that silently cannot run is the failure this
 * whole job exists to prevent. Both alert; only a clean 0 is silent.
 */
export function decideAlert(scan: BoundaryScan, commit: string): Alert | null {
  if (scan.code === 0) return null;
  const at = `${REF_LABEL} @ ${commit}`;
  const headline =
    scan.code === 1
      ? `The public-boundary scan of ${at} did not pass.`
      : `The public-boundary scan of ${at} could not run (exit ${scan.code}) — the remote is currently UNCHECKED.`;
  const detail = trimDetail(scan.detail) || '(the checker produced no output)';
  return {
    // Names the surface, not "the remote": this scans one tree (see the scope
    // note in the header), and the alert should not imply more than it checked.
    title: `Public boundary scan of the ${REF_LABEL} tree`,
    // The checker prints file:line and a category, never the matched value.
    body: `${headline}\n\nRedacted checker output:\n${detail}\n\nTriage: pnpm run check:public-boundary -- --index on a checkout of ${REF_LABEL}.`,
  };
}

/** Turn `src/notify-owner.ts`'s exit code into words. Only 0 means the owner actually saw it. */
export function describeDelivery(code: number): string {
  if (code === 0) return 'delivered';
  if (code === 2) return 'could not be attempted';
  return 'was attempted and failed';
}

/**
 * The whole decision, given a scan result. Split from the IO above it so the
 * findings/clean/delivery-failure branches are testable without git, a network,
 * or a real Slack workspace.
 */
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
  // Same posture as scripts/check-onecli-gateway-fds.sh: a finding nobody was
  // told about is a failure of this job, not a footnote. Exiting non-zero is
  // what makes the unit's OnFailure alert fire.
  reporter.logError(
    `remote-boundary: THE REMOTE HAS A FINDING BUT NOBODY WAS TOLD — the owner DM ${describeDelivery(code)}.\n` +
      `${alert.title}\n${alert.body}`,
  );
  return 1;
}

function git(args: string[], cwd = INSTALL_ROOT): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Where to read `.public-boundary-allowlist.json` from for a scan of `snapshot`.
 *
 * `snapshot` IS a checkout of the commit being scanned (`withSnapshot`), so its
 * own working copy of the file already is that commit's COMMITTED allowlist —
 * no separate `git show` is needed. The install checkout's own copy
 * (`INSTALL_ROOT/.public-boundary-allowlist.json`, the old source of this
 * argument) is NOT a safe substitute: it lags `origin/main` between a merge
 * and the next deploy, and it can hold an uncommitted edit — the same class of
 * hole `.husky/pre-push` closed for pushed refs (#651).
 *
 * Three cases, told apart by `lstat` (not `stat`, which follows a symlink and
 * would silently exempt whatever the link points at — the hook's own read,
 * `git show <sha>:path`, cannot be fooled this way, since it returns a
 * symlink blob's literal target STRING, which then fails `JSON.parse` and
 * aborts the hook closed; this function makes the same case fail closed
 * explicitly instead of relying on `JSON.parse` to eventually notice):
 *
 *   - Missing (`ENOENT`) — a commit that predates the file, or a ref that
 *     never carried it (the long-lived `channels`/`providers` sibling
 *     branches). Falls back to an empty allowlist written to a throwaway
 *     temp file — exempts nothing, still the strictest outcome — rather than
 *     letting the checker's own missing-file error turn "nothing to exempt"
 *     into a "could not run" alert.
 *   - Present but not a regular file (a symlink, most plausibly, but this
 *     also covers a directory or anything else committed under that path) —
 *     throws. This is not a case to paper over with a fallback: the tree
 *     claims to carry a reviewed policy file at this path and does not, so
 *     the scan should fail loudly rather than silently treat "who knows
 *     what this is" as either "reviewed" or "empty".
 *   - Present and a regular file — that IS the committed allowlist, used
 *     as-is.
 *
 * `usedFallback` says which of the first two happened, so a caller that
 * knows which commit is being scanned can log it — this function does not,
 * and stays pure filesystem logic with no `commit` argument, deliberately
 * split out so it is testable without git, a network or a real `pnpm`
 * invocation — same reasoning as `CleanupOps` above.
 */
export function resolveAllowlistPath(snapshot: string): { path: string; usedFallback: boolean; cleanup: () => void } {
  const treeAllowlist = path.join(snapshot, '.public-boundary-allowlist.json');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(treeAllowlist);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remote-boundary-allowlist-'));
    const emptyAllowlist = path.join(dir, 'allowlist.json');
    fs.writeFileSync(emptyAllowlist, '{"entries": []}\n');
    return { path: emptyAllowlist, usedFallback: true, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }
  if (!stat.isFile()) {
    throw new Error(
      `${treeAllowlist} is committed but is not a regular file (a symlink, most likely) — refusing to treat it as the allowlist`,
    );
  }
  return { path: treeAllowlist, usedFallback: false, cleanup: () => {} };
}

/** One invocation of the boundary checker, as `scanSnapshot` builds it. */
export interface CheckerInvocation {
  root: string;
  allowlistPath: string;
}

/** The checker's raw process result, ahead of `scanSnapshot`'s `BoundaryScan` mapping. */
export interface CheckerResult {
  status: number | null;
  stderr: string;
  error?: Error;
}

/**
 * Runs the checker, injected so `scanSnapshot`'s OWN logic — the allowlist
 * fallback, the fallback log line, and above all which path actually reaches
 * `--allowlist` — is testable without a real `pnpm` invocation. Same
 * reasoning as `CleanupOps`: without this seam, a rewrite that silently
 * passes the wrong path (or drops `--allowlist` entirely) would still make
 * `resolveAllowlistPath`'s own tests pass, having tested only half the wire.
 */
export type RunChecker = (invocation: CheckerInvocation) => CheckerResult;

const REAL_RUN_CHECKER: RunChecker = ({ root, allowlistPath }) => {
  const result = spawnSync(
    'pnpm',
    ['run', 'check:public-boundary', '--', '--root', root, '--index', '--allowlist', allowlistPath],
    { cwd: INSTALL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { status: result.status, stderr: result.stderr ?? '', error: result.error };
};

/** Run the boundary checker over `snapshot` (a checkout of `commit`), against this install's registry. */
export function scanSnapshot(snapshot: string, commit: string, runChecker: RunChecker = REAL_RUN_CHECKER): BoundaryScan {
  const allowlist = resolveAllowlistPath(snapshot);
  if (allowlist.usedFallback) {
    // Non-fatal, and it does not change the scan's outcome (empty exempts
    // nothing either way), but a later alert about a finding on this commit
    // should explain itself rather than leave "why wasn't this exempted?"
    // unanswered.
    console.error(
      `remote-boundary: ${REF_LABEL} @ ${commit} has no committed .public-boundary-allowlist.json — scanning with an empty allowlist`,
    );
  }
  try {
    const result = runChecker({ root: snapshot, allowlistPath: allowlist.path });
    if (result.error) throw result.error;
    return { code: result.status ?? 2, detail: cleanCheckerOutput(result.stderr) };
  } finally {
    allowlist.cleanup();
  }
}

export interface SnapshotRun<T> {
  value: T;
  /** Why cleanup did not fully succeed, or `null`. Never thrown away — see `reportCleanup`. */
  cleanupError: string | null;
}

/**
 * The two cleanup steps, injected so `cleanupSnapshot` is testable without git
 * or a filesystem. Without this seam, a rewrite that silently swallows a
 * `worktree remove` failure passes every test — verified by mutation, which is
 * the whole failure mode this file is guarding against.
 */
export interface CleanupOps {
  removeWorktree(snapshot: string): void;
  removeDirectory(parent: string): void;
}

const REAL_CLEANUP: CleanupOps = {
  removeWorktree: (snapshot) => git(['worktree', 'remove', '--force', snapshot]),
  removeDirectory: (parent) => fs.rmSync(parent, { recursive: true, force: true }),
};

/**
 * Attempt EVERY cleanup step, then report. Removing the worktree and removing
 * the temp directory are independent, so a failure in the first must not skip
 * the second — that would trade a stale registration for a stale registration
 * AND a leaked directory.
 */
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
 * Turn a cleanup failure into a non-zero exit, without letting it mask — or be
 * masked by — the scan's own verdict.
 *
 * The failure this closes: `git worktree remove` fails, the error is logged and
 * swallowed, the scan result returns normally and the job exits 0. The unit's
 * `OnFailure` never fires, while the directory has been deleted and the
 * registration is left behind in the SHARED git metadata of a live checkout
 * that already carries 23 worktrees. Repeat daily. A cleanup failure that
 * reports success is the same defect as a hook that never runs.
 *
 * Callers report the scan FIRST, so a finding still reaches the owner even when
 * cleanup then fails; this only ever raises the exit code, never lowers it.
 */
export function reportCleanup(cleanupError: string | null, scanExit: number, reporter: Reporter): number {
  if (cleanupError === null) return scanExit;
  reporter.logError(
    `remote-boundary: ${cleanupError}. A stale worktree registration may be left in the shared git metadata — ` +
      'run `git worktree prune` in the install root.',
  );
  return scanExit === 0 ? 1 : scanExit;
}

/**
 * The whole reporting decision for one run: scan verdict first, then cleanup.
 *
 * Exported and used by `main` rather than inlined there, so the ORDER and the
 * fact that both are reported are pinned by a test. Inlined, deleting the
 * `reportCleanup` call would leave every test green — which is the failure mode
 * this function exists to prevent, one level up.
 */
export async function reportOutcome(
  scan: BoundaryScan,
  commit: string,
  cleanupError: string | null,
  reporter: Reporter,
): Promise<number> {
  const scanExit = await reportScan(scan, commit, reporter);
  return reportCleanup(cleanupError, scanExit, reporter);
}

/** Materialize `commit` in a throwaway detached worktree and hand it to `body`. */
function withSnapshot<T>(commit: string, body: (snapshot: string) => T): SnapshotRun<T> {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remote-boundary-'));
  const snapshot = path.join(parent, 'tree');
  // `-c core.hooksPath=/dev/null`, matching `.husky/pre-push`'s
  // `snapshot_commit`. `worktree add` fires `post-checkout`, and now that
  // `core.hooksPath` is an absolute host path (scripts/pin-git-hooks-path.sh)
  // that shim RESOLVES here, where it previously did not.
  //
  // Defensive today, not load-bearing: the shim exits before doing anything
  // unless a matching hook file exists — `.husky/_/h:6` is
  // `[ ! -f "$s" ] && exit 0` against `s=$(dirname "$(dirname "$0")")/$n`
  // (`.husky/_/h:4`) — and `.husky/` carries only `commit-msg`, `pre-commit`
  // and `pre-push`. So no `post-checkout` runs against a scratch tree today.
  // It becomes load-bearing the day someone adds `.husky/post-checkout`, which
  // is exactly when nobody would think to look here.
  git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', snapshot, commit]);
  let value: T;
  try {
    value = body(snapshot);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    // The scan itself failed. Still clean up, then let the original failure
    // stand — main() already exits non-zero on it, so there is no structured
    // return left to carry a cleanup error and it is logged here instead.
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
    ({ value: scan, cleanupError } = withSnapshot(commit, (snapshot) => scanSnapshot(snapshot, commit)));
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    // Nothing was scanned, so there is no redacted checker output to send and
    // no finding to report. Fail the unit and let OnFailure carry it.
    console.error(`remote-boundary: could not scan ${REF_LABEL}: ${message(err)}`);
    return 1;
  }

  const reporter: Reporter = {
    // `notifyOwner` posts to Slack directly and reports success only on a
    // verified `ok: true`; `src/notify-owner.ts`'s header records why the CLI
    // socket is not a delivery path. Called in process rather than through
    // `scripts/notify-owner.ts` because that file is only the CLI wrapper around
    // this same function, with the same 0/1/2 contract — `src/main.ts` imports
    // it the same way.
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
