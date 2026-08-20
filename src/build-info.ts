/**
 * Build provenance — reads the dist/BUILD_INFO.json stamp written by
 * scripts/write-build-info.ts (postbuild) so "what is actually deployed" is
 * answerable from the running process, not just from the checkout on disk.
 */
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
