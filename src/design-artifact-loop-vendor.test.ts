/**
 * Drift tripwire for the vendored design-artifact-loop copies.
 *
 * ~/plugins/design-artifact-loop is the development home; the container tree
 * carries byte-identical vendored copies (see scripts/vendor-design-artifact-loop.ts).
 * This test fails when either side is edited without re-running the vendor
 * script, so drift surfaces on the next host test run instead of months later.
 *
 * Skipped entirely on machines without the plugin repo (fresh NanoClaw installs
 * have only the vendored copies — that is fine; they are self-contained).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PLUGIN_ROOT, TREE_ROOT, VENDORED } from './design-artifact-loop-vendor.js';
const hasPluginRepo = fs.existsSync(PLUGIN_ROOT);

function listFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

describe.skipIf(!hasPluginRepo)('design-artifact-loop vendored copies match the plugin repo', () => {
  for (const { from, to, dir } of VENDORED) {
    it(`${to} matches plugin ${from}`, () => {
      const src = path.join(PLUGIN_ROOT, from);
      const dst = path.join(TREE_ROOT, to);
      if (dir) {
        const srcFiles = listFiles(src);
        expect(listFiles(dst)).toEqual(srcFiles);
        for (const f of srcFiles) {
          expect(
            fs.readFileSync(path.join(dst, f)).equals(fs.readFileSync(path.join(src, f))),
            `${to}/${f} drifted`,
          ).toBe(true);
        }
      } else {
        expect(
          fs.readFileSync(dst).equals(fs.readFileSync(src)),
          `${to} drifted — run scripts/vendor-design-artifact-loop.ts`,
        ).toBe(true);
      }
    });
  }
});

// Tree-only wrapper contract (runs everywhere — no plugin repo needed): the env pin
// MUST precede the dynamic engine import (the vendored state.ts resolves the loop
// root at module load), and the import target must exist. A reorder or a broken
// re-vendor otherwise ships silently and hard-fails design_review in every container.
describe('design-review wrapper contract', () => {
  const wrapperPath = path.join(TREE_ROOT, 'container/agent-runner/src/mcp-tools/design-review/index.ts');
  const src = fs.readFileSync(wrapperPath, 'utf-8');

  it('pins DESIGN_ARTIFACT_LOOP_ROOT before importing the engine', () => {
    const pin = src.indexOf('process.env.DESIGN_ARTIFACT_LOOP_ROOT ??=');
    const imp = src.indexOf("await import('./design-review.js')");
    expect(pin).toBeGreaterThan(-1);
    expect(imp).toBeGreaterThan(-1);
    expect(pin).toBeLessThan(imp);
  });

  it('imports an engine module that exists', () => {
    expect(fs.existsSync(path.join(path.dirname(wrapperPath), 'design-review.ts'))).toBe(true);
  });
});
