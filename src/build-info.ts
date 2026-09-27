/** Reads the dist/BUILD_INFO.json stamp (scripts/write-build-info.ts) so the running process knows what it runs. */
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

/** HEAD sha, or null (never throws) on any git failure, so a boot gate fails closed to "nothing to compare". */
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
 * Null when either input is null or the shas match. Does not claim the halves are split now: agent-runner source is
 * re-snapshotted only at the next restart, which does not rebuild `dist/`, so that restart is what splits them.
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
 * Whether a drift changes what the RUNNING host executes; sha inequality alone is normal here, and a DM on every
 * boot would get muted. docs and scripts/ (run from the checkout) never need a rebuild, and agent-runner source
 * activates from the working tree at boot.
 */
export function isMaterialDrift(changedPaths: string[]): boolean {
  return changedPaths.some(isMaterialPath);
}

/** Test files: compiled, but nothing reachable from the host entrypoint imports them. */
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;

/**
 * Whether ONE changed path can change what a rebuild deploys; shared by the gate and the alert body. The build
 * emits the host (`src/`) and the dashboard SPA (`dashboard/`); dependency manifests need install-and-build too.
 */
export function isMaterialPath(changedPath: string): boolean {
  if (changedPath === 'package.json' || changedPath === 'pnpm-lock.yaml') return true;
  if (TEST_FILE_RE.test(changedPath)) return false;
  return changedPath.startsWith('src/') || changedPath.startsWith('dashboard/');
}

/** Changed paths, or null when git cannot tell (unknown sha, shallow clone): the caller must treat that as material. */
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

/** Commit count, or null on the same failures as changedPathsBetween; cosmetic only, never decides materiality. */
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
