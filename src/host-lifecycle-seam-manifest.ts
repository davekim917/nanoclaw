/**
 * Upstream seam-port manifest (host-lifecycle seam + the seam-3 DbDriver layer).
 *
 * The file(s) listed in UPSTREAM_FILES are ported byte-for-byte from upstream
 * nanocoai/nanoclaw and must never be hand-edited — src/host-lifecycle-seam.test.ts
 * fails the build if any of them drifts from src/host-lifecycle-seam/UPSTREAM-MANIFEST.json.
 *
 * To intentionally sync with a newer upstream commit, re-run:
 *   pnpm exec tsx scripts/host-lifecycle-seam-manifest.ts --update <upstream-sha>
 * from a worktree that has upstream's commit objects (e.g. after `git fetch
 * upstream`), review the resulting diff, then commit the regenerated manifest
 * alongside the ported file changes.
 *
 * See docs/specs/upstream-host-sweep-seam/plan.md §4.6.1. Same vendor-then-CLI-shim
 * split, and the same manifest-over-`git show` reasoning (CI's clone carries no
 * upstream objects), as src/mailbox-seam-manifest.ts + scripts/mailbox-seam-manifest.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashFilesAtGitSha } from './seam-manifest-git.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/host-lifecycle-seam/UPSTREAM-MANIFEST.json');

/**
 * Every file ported verbatim from upstream, across both seams that have landed
 * one: the host-lifecycle seam (`src/host-lifecycle.ts`) and the async
 * central-DB driver layer (everything under `src/db/driver*` /
 * `src/db/drivers/` / `src/db/testing/` plus `src/db/compose.ts`).
 *
 * The driver files replaced the fork's type-only `DbDriver` stand-in, whose
 * "exactly one importer" pin retired with it — a stand-in needs its blast radius
 * capped, a real upstream file needs byte-equality, and that is this manifest's
 * job. `src/db/connection.ts` is deliberately NOT here: it is fork-adapted
 * (`getRawDb`/`hasTableRaw`, fork init semantics), so the upstream ratchet
 * measures it as ordinary divergence instead.
 *
 * All entries share one pinned upstream commit, so a re-pin re-hashes them all.
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
 * Upstream files this fork CANNOT carry byte-for-byte, with the fork-owned test that
 * covers the same invariants instead. Same shape and same reasoning as
 * src/mailbox-seam-manifest.ts's UNPORTABLE_UPSTREAM_FILES — see
 * that file's header comment for the general rationale.
 *
 * This is not a deferral and never becomes one: adding such a file to UPSTREAM_FILES
 * would put a permanently red test in CI (three of its cases hard-code assumptions this
 * fork's boot topology does not share). The seam test asserts both halves of that — the
 * fork-owned replacement exists with a written reason, and the upstream path stays out
 * of UPSTREAM_FILES.
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
