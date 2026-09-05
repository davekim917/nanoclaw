/**
 * T0 PR 1 gate: the `requestWake` seam lands with ZERO callers.
 *
 * This PR only adds `src/request-wake.ts` and its unit test; it converts no
 * existing wake call site. PR 3 of this series (docs/specs/upstream-theme-ports/plan.md
 * T0 §4.2) is the one that flips call sites onto the seam and replaces this
 * gate with the fuller AST-based chokepoint test that also resolves dynamic
 * imports. Until then, this plain-text scan is the tripwire: it fails the
 * moment any file other than `src/request-wake.ts` itself calls
 * `requestWake(`, which would mean a call site landed here by accident
 * ahead of its own PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      out.push(full);
    }
  }
  return out;
}

describe('requestWake has zero callers (T0 PR 1 — inert by design)', () => {
  it('is called only inside src/request-wake.ts and src/request-wake.test.ts', () => {
    const callSitePattern = /\brequestWake\(/;
    const callers: string[] = [];
    for (const file of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, file);
      if (rel === 'request-wake.ts' || rel === 'request-wake.test.ts' || rel === 'request-wake-inert.test.ts') {
        continue;
      }
      const source = fs.readFileSync(file, 'utf8');
      if (callSitePattern.test(source)) {
        callers.push(rel);
      }
    }
    expect(callers).toEqual([]);
  });
});
