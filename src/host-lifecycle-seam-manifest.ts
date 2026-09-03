/**
 * Upstream host-lifecycle-seam manifest.
 *
 * The files listed in UPSTREAM_FILES are ported byte-for-byte from upstream
 * nanocoai/nanoclaw and must never be hand-edited — src/host-lifecycle-seam.test.ts
 * fails the build if either of them drifts from src/host-lifecycle-seam/UPSTREAM-MANIFEST.json.
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
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/host-lifecycle-seam/UPSTREAM-MANIFEST.json');

/** Every file ported verbatim from upstream for the host-lifecycle seam (S2-PR0). */
export const UPSTREAM_FILES = ['src/host-lifecycle.ts', 'src/host-lifecycle.test.ts'] as const;

export interface HostLifecycleSeamManifest {
  upstream: string;
  files: Record<string, string>;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hashes the working tree's current copy of every UPSTREAM_FILES entry. */
export function computeManifest(upstream: string): HostLifecycleSeamManifest {
  const files: Record<string, string> = {};
  for (const relPath of UPSTREAM_FILES) {
    const abs = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`host-lifecycle-seam-manifest: UPSTREAM_FILES entry missing from the working tree: ${relPath}`);
    }
    files[relPath] = sha256(fs.readFileSync(abs));
  }
  return { upstream, files: sortKeys(files) };
}

/** Hashes upstream's copy of every UPSTREAM_FILES entry at the given sha, via `git show`. */
export function computeManifestFromGit(upstreamSha: string): HostLifecycleSeamManifest {
  const files: Record<string, string> = {};
  for (const relPath of UPSTREAM_FILES) {
    let content: Buffer;
    try {
      content = execFileSync('git', ['show', `${upstreamSha}:${relPath}`], {
        cwd: REPO_ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(
        `host-lifecycle-seam-manifest: ${relPath} not found at upstream ${upstreamSha} (git show failed): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    files[relPath] = sha256(content);
  }
  return { upstream: upstreamSha, files: sortKeys(files) };
}

function sortKeys(files: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return sorted;
}

export function readManifest(): HostLifecycleSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as HostLifecycleSeamManifest;
}

export function writeManifest(manifest: HostLifecycleSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}
