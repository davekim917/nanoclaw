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
 * whole tree of `origin/main` — the one place that can answer "is anything
 * private sitting on the remote right now?"
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
    title: 'Public boundary scan of the remote',
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

/** Run the boundary checker over `snapshot`, against this install's registry. */
function scanSnapshot(snapshot: string): BoundaryScan {
  const result = spawnSync(
    'pnpm',
    [
      'run',
      'check:public-boundary',
      '--',
      '--root',
      snapshot,
      '--index',
      // The allowlist is current policy, not the policy of whatever content is
      // being inspected — same reasoning as `.husky/pre-push`'s `allowlist_path`.
      '--allowlist',
      path.join(INSTALL_ROOT, '.public-boundary-allowlist.json'),
    ],
    { cwd: INSTALL_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error) throw result.error;
  return { code: result.status ?? 2, detail: cleanCheckerOutput(result.stderr ?? '') };
}

/** Materialize `commit` in a throwaway detached worktree and hand it to `body`. */
function withSnapshot<T>(commit: string, body: (snapshot: string) => T): T {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-remote-boundary-'));
  const snapshot = path.join(parent, 'tree');
  // `-c core.hooksPath=/dev/null` for the same reason `.husky/pre-push`'s
  // `snapshot_commit` uses it: creating a worktree runs `post-checkout`, and now
  // that `core.hooksPath` is an absolute host path (scripts/pin-git-hooks-path.sh)
  // it resolves here, so a hook could otherwise run against a scratch tree.
  git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', snapshot, commit]);
  try {
    return body(snapshot);
  } finally {
    try {
      git(['worktree', 'remove', '--force', snapshot]);
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (err) {
      // Leaving a registered worktree behind would make every later
      // `git worktree` call noisier, so say so rather than swallowing it.
      console.error(`remote-boundary: could not remove the snapshot worktree: ${message(err)}`);
    }
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<number> {
  let scan: BoundaryScan;
  let commit: string;
  try {
    git(['fetch', '--quiet', 'origin', 'main']);
    commit = git(['rev-parse', '--short', REF]);
    scan = withSnapshot(commit, scanSnapshot);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    // Nothing was scanned, so there is no redacted checker output to send and
    // no finding to report. Fail the unit and let OnFailure carry it.
    console.error(`remote-boundary: could not scan ${REF_LABEL}: ${message(err)}`);
    return 1;
  }

  return reportScan(scan, commit, {
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
  });
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
