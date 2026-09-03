/**
 * Guard: fixture roots stay per-process.
 *
 * Issue #274 — 53 suites built fixtures under a fixed `/tmp/nanoclaw-<suite>`
 * root, so two worktrees running the same suite at the same time corrupted each
 * other's state. The failure never surfaced as an assertion; it surfaced as a
 * `disk I/O error` or a missing directory in whichever run lost the race. Every
 * fixture root now comes from `uniqueTmpRoot` (src/test-setup.ts).
 *
 * This test fails if a fixed root comes back.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirrors vitest.config.ts `include`: these four trees recursively, plus
// `container/*.test.ts` at the top level only. container/agent-runner runs
// under Bun with its own setup layer, so vitest never loads it and this guard
// does not reach it.
const SCANNED_DIRS = ['src', 'setup', 'scripts', 'tests'];
const SCANNED_FLAT_DIRS = ['container'];

/**
 * Files allowed to keep a `/tmp/nanoclaw…` literal, with the reason. A suite
 * only belongs here if the literal is inert data — never a path it writes to.
 */
const FIXED_PATH_EXEMPT: Record<string, string> = {
  'src/cli/transport-errors.test.ts': 'formats a socket-path error message; the path is never opened or created',
  'src/fixture-roots.test.ts': 'this guard',
};

function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.test.ts')) out.push(path.relative(REPO_ROOT, full));
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(REPO_ROOT, dir));
  for (const dir of SCANNED_FLAT_DIRS) {
    const full = path.join(REPO_ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        out.push(path.relative(REPO_ROOT, path.join(full, entry.name)));
      }
    }
  }
  return out.sort();
}

const FILES = testFiles();

describe('fixture roots are per-process', () => {
  it('scans the vitest test files', () => {
    // A path or glob change that silently empties the scan would make every
    // other assertion here vacuous.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain('src/delivery.test.ts');
    // Top-level container suites are in vitest's include list and must be
    // scanned; the agent-runner tree below them must not be.
    expect(FILES).toContain('container/entrypoint.test.ts');
    expect(FILES.filter((f) => f.startsWith('container/agent-runner/'))).toEqual([]);
  });

  it('no test builds fixtures under a fixed /tmp/nanoclaw path', () => {
    const nanoclawTmp = /(['"`])(\/tmp\/nanoclaw[^'"`\n]*)\1/;
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file in FIXED_PATH_EXEMPT) continue;
      const match = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').match(nanoclawTmp);
      if (match) offenders.push(`${file}: ${match[2]}`);
    }
    // Use uniqueTmpRoot('<suite>') instead — see src/test-setup.ts.
    expect(offenders).toEqual([]);
  });

  it('no test joins a fixed name directly onto os.tmpdir()', () => {
    // `path.join(os.tmpdir(), 'fixed-name')` is the same hazard spelled
    // portably. A literal passed to mkdtemp is fine: mkdtemp appends random
    // characters, so the result is already unique.
    const fixedJoin = /(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"])([^'"\n]*)\1\s*\)/g;
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file in FIXED_PATH_EXEMPT) continue;
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      for (const match of source.matchAll(fixedJoin)) {
        const preceding = source.slice(Math.max(0, match.index - 40), match.index);
        if (/mkdtemp(Sync)?\($/.test(preceding)) continue;
        offenders.push(`${file}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uniqueTmpRoot hands out a fresh, uncreated, process-scoped path', () => {
    const first = uniqueTmpRoot('guard-selfcheck');
    const second = uniqueTmpRoot('guard-selfcheck');
    expect(first).not.toBe(second);
    expect(path.basename(first)).toMatch(new RegExp(`^nanoclaw-guard-selfcheck-${process.pid}-[0-9a-f]{8}$`));
    expect(fs.existsSync(first)).toBe(false);
  });
});
