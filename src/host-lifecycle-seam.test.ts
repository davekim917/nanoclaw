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

describe('the DbDriver shim has exactly one importer', () => {
  it('only src/host-lifecycle.ts imports src/db/driver.ts', () => {
    const SRC_ROOT = path.join(REPO_ROOT, 'src');
    const DRIVER_ABS = path.join(SRC_ROOT, 'db', 'driver.ts');
    const IMPORT_RE = /(?:import|export)[^;]*?from\s+['"](\.[^'"]+)['"]/g;

    const files = fs
      .readdirSync(SRC_ROOT, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts'))
      .map((e) => path.join(e.parentPath, e.name))
      .filter((f) => !f.includes(`${path.sep}node_modules${path.sep}`) && !f.includes(`${path.sep}dist${path.sep}`));

    const importers = new Set<string>();
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const match of content.matchAll(IMPORT_RE)) {
        const specifier = match[1];
        if (!specifier.endsWith('.js')) continue;
        const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (resolved === DRIVER_ABS) {
          importers.add(path.relative(REPO_ROOT, file));
        }
      }
    }

    expect(
      importers,
      "src/db/driver.ts is a type-only stand-in for upstream's async DbDriver, replaced (not extended) " +
        'when the DbDriver seam lands — nobody but src/host-lifecycle.ts may depend on it',
    ).toEqual(new Set(['src/host-lifecycle.ts']));
  });
});
