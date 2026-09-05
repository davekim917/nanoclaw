/**
 * Drift tripwire for the ported upstream durable-host seam (seam 4, series A).
 *
 * src/db/coordination.ts and src/host-instance.ts are byte-for-byte copies of
 * nanocoai/nanoclaw@<upstream sha>. This test fails when either is hand-edited
 * without regenerating src/durable-host-seam/UPSTREAM-MANIFEST.json, so drift
 * surfaces on the next host test run instead of at the next upstream sync.
 *
 * A manifest (rather than `git show <sha>:<path>`) is used because the fork's CI
 * clone does not carry upstream commits — same pattern and same reasoning as
 * src/host-lifecycle-seam.test.ts and src/mailbox-seam-upstream.test.ts.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { UPSTREAM_FILES, type DurableHostSeamManifest } from './durable-host-seam-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'src/durable-host-seam/UPSTREAM-MANIFEST.json');
const manifest: DurableHostSeamManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('coordination.ts and host-instance.ts are byte-identical to upstream', () => {
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
        `${relPath} drifted from upstream ${manifest.upstream}; regenerate with scripts/durable-host-seam-manifest.ts --update ${manifest.upstream} only when intentionally syncing upstream`,
      ).toBe(expectedHash);
    });
  }
});

describe('main.ts wires the lease as shadow state', () => {
  const main = fs.readFileSync(path.join(REPO_ROOT, 'src/main.ts'), 'utf8');

  // A failed `host_instances` INSERT at boot must log and let the host come
  // up — the lease is write-only shadow state (plan §7.A), never a startup
  // dependency. Pinned structurally: the only call to the starter goes
  // through upstream's `shadowWrite`, which swallows and warns.
  it('starts the lease only through shadowWrite so a failed registration cannot abort boot', () => {
    const calls = main.match(/startHostInstanceLease\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(main).toMatch(/shadowWrite\([^)]*\(\) => startHostInstanceLease\(\)\)/);
  });

  it("stops the lease as the first statement of shutdown()'s finally block", () => {
    const finallyBlock = main.slice(main.indexOf('} finally {', main.indexOf('async function shutdown')));
    const firstStatement = finallyBlock.replace(/^\} finally \{\s*/, '').replace(/^(\s*\/\/[^\n]*\n)+/, '');
    expect(firstStatement.startsWith('await stopHostInstanceLease();')).toBe(true);
  });
});
