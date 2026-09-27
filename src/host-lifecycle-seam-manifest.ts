/**
 * Upstream seam-port manifest (host-lifecycle seam and the DbDriver layer): UPSTREAM_FILES are ported byte-for-byte
 * and must never be hand-edited (src/host-lifecycle-seam.test.ts fails on drift). Hashes live in a manifest because
 * CI's clone carries no upstream objects. To re-pin, run
 * `pnpm exec tsx scripts/host-lifecycle-seam-manifest.ts --update <upstream-sha>` from a worktree with upstream's
 * objects and commit the manifest with the ported changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashFilesAtGitSha } from './seam-manifest-git.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/host-lifecycle-seam/UPSTREAM-MANIFEST.json');

/**
 * One pinned upstream commit for all entries. `src/db/connection.ts` is deliberately absent: it is fork-adapted, so
 * the upstream ratchet measures it as ordinary divergence.
 */
export const UPSTREAM_FILES = [
  'src/db/compose.ts',
  'src/db/driver-registry.test.ts',
  'src/db/driver-registry.ts',
  'src/db/driver.ts',
  'src/db/drivers/shared.ts',
  'src/db/drivers/sqlite.conformance.test.ts',
  'src/db/drivers/sqlite.test.ts',
  'src/db/drivers/sqlite.ts',
  'src/db/testing/driver-conformance.ts',
  'src/host-lifecycle.ts',
] as const;

/**
 * Upstream files this fork CANNOT carry byte-for-byte, each with the fork-owned test covering the same invariants.
 * Never a deferral: in UPSTREAM_FILES they would be a permanently red test.
 */
export const UNPORTABLE_UPSTREAM_FILES: ReadonlyArray<{
  upstream: string;
  forkTest: string;
  reason: string;
}> = [
  {
    upstream: 'src/host-lifecycle.test.ts',
    forkTest: 'src/host-lifecycle.test.ts',
    reason:
      "Two of upstream's eight cases describe upstream's own tree, not this fork's: both " +
      'read src/index.ts for the boot-order strings (this fork boots in src/main.ts — ' +
      "src/index.ts is a 15-line deploy-crash-guard shim, per that file's own header " +
      'comment, "do not add imports here beyond the guard"). The five remaining ' +
      'registry-behavior cases and the two boot-order cases (path-swapped to src/main.ts) ' +
      'are kept in the fork-owned src/host-lifecycle.test.ts at the same path, and so is ' +
      "upstream's approvals case: S2-PR14 moved src/modules/approvals/index.ts onto " +
      'onHostShutdown, so that case is carried verbatim and nothing is deferred.',
  },
] as const;

export interface HostLifecycleSeamManifest {
  upstream: string;
  files: Record<string, string>;
}

/** Hashes upstream's copy of every UPSTREAM_FILES entry at the given sha, via `git show`. */
export function computeManifestFromGit(upstreamSha: string): HostLifecycleSeamManifest {
  return {
    upstream: upstreamSha,
    files: hashFilesAtGitSha('host-lifecycle-seam-manifest', REPO_ROOT, upstreamSha, UPSTREAM_FILES),
  };
}

export function readManifest(): HostLifecycleSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as HostLifecycleSeamManifest;
}

export function writeManifest(manifest: HostLifecycleSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}
