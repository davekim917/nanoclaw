/**
 * Build provenance — reads the dist/BUILD_INFO.json stamp written by
 * scripts/write-build-info.ts (postbuild) so "what is actually deployed" is
 * answerable from the running process, not just from the checkout on disk.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface BuildInfo {
  sha: string;
  shortSha: string;
  builtAt: string;
  branch: string;
  dirty: boolean;
}

/** Returns null (never throws) when the file is missing or unparseable — an older dist or a dev run. */
export function readBuildInfo(repoRoot: string): BuildInfo | null {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'dist', 'BUILD_INFO.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuildInfo>;
    if (
      typeof parsed.sha !== 'string' ||
      typeof parsed.shortSha !== 'string' ||
      typeof parsed.builtAt !== 'string' ||
      typeof parsed.branch !== 'string' ||
      typeof parsed.dirty !== 'boolean'
    ) {
      return null;
    }
    return parsed as BuildInfo;
  } catch {
    return null;
  }
}

export function formatBuildInfoLog(info: BuildInfo): { msg: string; data: Record<string, unknown> } {
  return {
    msg: info.dirty ? 'Running a build compiled from a DIRTY tree (BUILD_ALLOW_DIRTY was used)' : 'Build provenance',
    data: { sha: info.sha, shortSha: info.shortSha, builtAt: info.builtAt, branch: info.branch, dirty: info.dirty },
  };
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The checkout's current HEAD sha, or null (never throws) when git is
 * missing, `repoRoot` isn't a repo, or the command otherwise fails — a boot
 * gate reading this must fail closed to "nothing to compare", not crash.
 */
export function readCheckoutHead(repoRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return SHA_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * PURE (no I/O) so it's directly testable. Returns null when there's nothing
 * to report: either input is null, or the running build's sha matches HEAD.
 * Otherwise names both shas.
 *
 * Deliberately does NOT claim the two build halves are mismatched right now.
 * Build/checkout drift is the NORMAL state on this install (frequent pulls
 * without an immediate rebuild), and it is usually still LATENT:
 * `activateAgentRunnerSource()` (agent-runner-source.ts) only re-snapshots
 * `container/agent-runner/src` from the working tree at the NEXT restart, so
 * until then both halves stay consistent with each other, merely stale
 * relative to the checkout. The risk this names is what the NEXT restart
 * does: it re-snapshots agent-runner source but does not rebuild `dist/`, so
 * a restart taken while this is true is what actually splits the two halves.
 */
export function describeBuildDrift(
  info: BuildInfo | null,
  head: string | null,
): { msg: string; data: Record<string, unknown> } | null {
  if (!info || !head || info.sha === head) return null;
  return {
    msg:
      `Running host is executing build ${info.shortSha} (${info.sha}), an OLDER build than the checkout's current ` +
      `HEAD ${head.slice(0, 7)} (${head}). A restart alone will not fix this — restart does not rebuild, so the ` +
      'next restart just respawns the same stale dist/. Rebuild (e.g. scripts/deploy.sh, or pull + `pnpm run build`) ' +
      'and restart to pick up the checkout. Note: a plain restart DOES re-snapshot agent-runner source from the ' +
      'working tree at boot (activateAgentRunnerSource) while host src/ does not — so although the two halves are ' +
      'consistent right now, the NEXT restart risks splitting them: newer agent-runner code running against this ' +
      'older host build.',
    data: { buildSha: info.sha, headSha: head, builtAt: info.builtAt },
  };
}

/**
 * Whether a drift changes what the RUNNING host executes.
 *
 * Sha inequality alone is the normal state on this install: the checkout is
 * pulled through the day and a rebuild does not always follow, so alerting on
 * every mismatch would fire on nearly every boot. An alert that fires that
 * often gets muted, which is the failure this whole alerting path exists to
 * avoid — so the DM is gated on materiality while the WARN is not.
 *
 * Only `src/**` is compiled into `dist/` (tsconfig `include: ["src*"]`), so
 * nothing else can change the running host by rebuilding:
 *
 * - `docs/`, root markdown — never executed.
 * - `scripts/` — run from the checkout by systemd timers, so those changes are
 *   already live and a rebuild is irrelevant to them.
 * - `container/agent-runner/**` — a real concern, but a SEPARATE one: that half
 *   activates from the working tree at boot via `activateAgentRunnerSource()`,
 *   so it is never stale-because-unbuilt.
 * - test files under `src` — these ARE compiled into `dist/` (verified: the
 *   live checkout's dist holds 391 `*.test.js`), but nothing reachable from
 *   `dist/index.js` imports them, so they cannot change the running host's
 *   behaviour.
 */
export function isMaterialDrift(changedPaths: string[]): boolean {
  return changedPaths.some(isMaterialPath);
}

/** Test files: compiled, but nothing reachable from the host entrypoint imports them. */
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

/**
 * Whether ONE changed path can change what a rebuild would deploy.
 *
 * Exported so the alert body and the gate cannot drift apart: the call site
 * filters with this same predicate instead of restating the rule.
 *
 * The top-level build is `tsc && pnpm run build:spa`, so it produces two
 * runtime artifacts rather than one. The compiled host output covers the src
 * tree; the second is the dashboard SPA, built from its own Vite project and
 * served directly by `src/dashboard/static.ts`, so a dashboard-only change is
 * user-facing and would otherwise have read as harmless here. Dependency
 * manifests count for the same reason: they need the deploy install-and-build
 * flow before they are live.
 */
export function isMaterialPath(changedPath: string): boolean {
  if (changedPath === 'package.json' || changedPath === 'pnpm-lock.yaml') return true;
  if (TEST_FILE_RE.test(changedPath)) return false;
  return changedPath.startsWith('src/') || changedPath.startsWith('dashboard/');
}

/**
 * Paths changed between two commits, or **null when git cannot tell us** —
 * an unknown sha after a force-push, a shallow clone, git missing. Null is
 * not "nothing changed": the caller must treat it as material and alert,
 * because an unreadable diff is not evidence of safety.
 */
export function changedPathsBetween(repoRoot: string, fromSha: string, toSha: string): string[] | null {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${fromSha}..${toSha}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    return out.split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

/**
 * Commit count between two shas (`git rev-list --count`), or null on the
 * same failures as {@link changedPathsBetween} — same never-throws contract.
 * Purely cosmetic: used to make the DM readable ("N commits of drift"), never
 * to decide materiality. A null here does not change what the alert does,
 * only what it says.
 */
export function commitCountBetween(repoRoot: string, fromSha: string, toSha: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${fromSha}..${toSha}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
