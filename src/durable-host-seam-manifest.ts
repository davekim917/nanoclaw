/**
 * Upstream durable-host seam manifest. UPSTREAM_FILES are ported byte-for-byte from upstream and must never be
 * hand-edited: src/durable-host-seam-tripwire.test.ts fails on drift from src/durable-host-seam/UPSTREAM-MANIFEST.json.
 * To re-sync, run `pnpm exec tsx scripts/durable-host-seam-manifest.ts --update <upstream-sha>` from a worktree
 * holding upstream's objects and commit the regenerated manifest with the ported files. A manifest rather than
 * `git show`, because CI's clone carries no upstream objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashFilesAtGitSha } from './seam-manifest-git.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = path.join(REPO_ROOT, 'src/durable-host-seam/UPSTREAM-MANIFEST.json');

/**
 * Verbatim, so byte-equality is the invariant. Separate from src/host-lifecycle-seam/UPSTREAM-MANIFEST.json so
 * re-pinning one seam's sha does not re-hash the other's files.
 */
export const UPSTREAM_FILES = ['src/db/coordination.ts', 'src/host-instance.ts'] as const;

export interface DurableHostSeamManifest {
  upstream: string;
  files: Record<string, string>;
}

export function computeManifestFromGit(upstreamSha: string): DurableHostSeamManifest {
  return {
    upstream: upstreamSha,
    files: hashFilesAtGitSha('durable-host-seam-manifest', REPO_ROOT, upstreamSha, UPSTREAM_FILES),
  };
}

export function readManifest(): DurableHostSeamManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as DurableHostSeamManifest;
}

export function writeManifest(manifest: DurableHostSeamManifest): void {
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}
