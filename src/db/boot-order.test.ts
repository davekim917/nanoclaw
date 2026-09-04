/**
 * Structural boot-order tripwire for the async central-DB connection.
 *
 * `initDb()` returns a Promise from seam-3 PR 1 on. A forgotten `await` there
 * is invisible at runtime until the first query: `runMigrations` would receive
 * whatever `getRawDb()` returns before the driver exists (an exception) or, once
 * the driver does exist but is a stale one, the wrong handle. `getRawDb()` also
 * throws "Database not initialized" if the `await` is dropped entirely, so the
 * failure would land at boot — but as an opaque throw from a helper rather than
 * as a named invariant, which is why the ordering is pinned here instead.
 *
 * Same style, and the same reason for existing, as the #370 ordering case in
 * src/archive-write-path.test.ts ("materializes the archive schema before
 * anything that can spawn"): a text scan over src/main.ts with comment lines
 * stripped first, because the prose in that file names these calls on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('central-DB boot order in src/main.ts', () => {
  const main = fs
    .readFileSync(path.join(REPO_ROOT, 'src/main.ts'), 'utf-8')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');

  const at = (needle: string): number => {
    const index = main.indexOf(needle);
    expect(index, `src/main.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  it('awaits initDb', () => {
    expect(
      main,
      'initDb() is async from seam 3 PR 1; an unawaited call leaves the driver unset for everything below it',
    ).toMatch(/await initDb\(/);
  });

  it('runs migrations only after the driver exists', () => {
    expect(at('await initDb(')).toBeLessThan(at('runMigrations('));
    expect(at('await initDb(')).toBeLessThan(at('getRawDb()'));
  });

  it('hands the host-module lifecycle the driver, not the raw handle', () => {
    // HostStartContext.db is upstream's async DbDriver now that the fork's
    // type-only stand-in is gone, so main() must pass getDb() there. Passing
    // getRawDb() would compile only for as long as some other alias kept the
    // two types interchangeable.
    expect(main).toMatch(/startHostModules\(\{\s*db: getDb\(\)/);
  });
});
