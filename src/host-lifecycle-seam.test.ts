/**
 * Drift tripwire for the ported upstream host-lifecycle seam (S2-PR0).
 *
 * The files in UPSTREAM_FILES (src/host-lifecycle-seam-manifest.ts) are byte-for-byte
 * copies of nanocoai/nanoclaw@<upstream sha>. This test fails when either is
 * hand-edited without regenerating src/host-lifecycle-seam/UPSTREAM-MANIFEST.json, so
 * drift surfaces on the next host test run instead of at the next upstream sync.
 *
 * A manifest (rather than `git show <sha>:<path>`) is used because the fork's CI
 * clone does not carry upstream commits — see docs/specs/upstream-host-sweep-seam/plan.md
 * §4.6.1, same pattern as src/mailbox-seam-upstream.test.ts.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { UPSTREAM_FILES, type HostLifecycleSeamManifest } from './host-lifecycle-seam-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'src/host-lifecycle-seam/UPSTREAM-MANIFEST.json');
const manifest: HostLifecycleSeamManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('every ported upstream file matches UPSTREAM-MANIFEST.json', () => {
  it('the manifest covers exactly UPSTREAM_FILES — no omission possible', () => {
    expect(new Set(Object.keys(manifest.files))).toEqual(new Set(UPSTREAM_FILES));
  });

  for (const relPath of UPSTREAM_FILES) {
    it(`${relPath} matches upstream ${manifest.upstream}`, () => {
      const abs = path.join(REPO_ROOT, relPath);
      const expectedHash = manifest.files[relPath];
      expect(expectedHash, `${relPath} is not in UPSTREAM-MANIFEST.json`).toBeTruthy();
      expect(fs.existsSync(abs), `${relPath} is listed in the manifest but missing from the working tree`).toBe(true);
      const actualHash = sha256(fs.readFileSync(abs));
      expect(
        actualHash,
        `${relPath} drifted from upstream ${manifest.upstream}; regenerate with scripts/host-lifecycle-seam-manifest.ts --update ${manifest.upstream} only when intentionally syncing upstream`,
      ).toBe(expectedHash);
    });
  }
});
