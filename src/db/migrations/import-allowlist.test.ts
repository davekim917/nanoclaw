import fs from 'fs';
import { builtinModules } from 'module';
import path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * Migrations are frozen logic — once shipped, a migration's behavior must
 * never move underneath it because an application module it happened to
 * import evolved later. Migration 051 broke this once: it imported
 * message-archive.js and modules/memory/curator-*.js for a ledger read and
 * a maintenance-pending upsert, and because migrations/index.ts is loaded by
 * every DB-touching test, that pulled curator-contract.ts's
 * `../../secret-scrubber.js` import — and its `setLogScrubber(scrubSecrets)`
 * module-load side effect — into tests that partial-mock log.js and never
 * expected it, breaking them at collection.
 *
 * This test pins the shape that prevents a repeat: every migration source
 * file's static imports must resolve to a node builtin, `better-sqlite3`, a
 * sibling file inside this same directory (other migrations are frozen the
 * same way), or one of two verified side-effect-free utility modules
 * (`../../config.js`, `../../log.js` — neither imports secret-scrubber.js).
 * Anything else — message-archive.js, modules/**, secret-scrubber.js, or any
 * other evolving application module — must be duplicated inline instead
 * (see 051-memory-consolidated-facts.ts's header comment for the pattern).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'src', 'db', 'migrations');

const ALLOWED_DEEP_RELATIVE = new Set(['../../config.js', '../../log.js', '../connection.js', './connection.js']);

function migrationSourceFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function isAllowed(specifier: string): boolean {
  if (!specifier.startsWith('.')) {
    const bare = specifier.replace(/^node:/, '');
    return specifier === 'better-sqlite3' || builtinModules.includes(bare);
  }
  // A sibling file directly inside src/db/migrations/ — every migration in
  // this directory is frozen by the same rule, so importing one another
  // (e.g. 019-mnemon-ingest-db.ts's sub-migration files) is safe.
  if (/^\.\/[\w-]+\.js$/.test(specifier)) return true;
  return ALLOWED_DEEP_RELATIVE.has(specifier);
}

describe('migration import allowlist', () => {
  it('every migration file only imports node builtins, better-sqlite3, sibling migration files, or a verified side-effect-free utility module', () => {
    const violations: string[] = [];
    for (const file of migrationSourceFiles()) {
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!isAllowed(specifier)) violations.push(`${file}: ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('scans at least the current set of migration files (canary against an empty/broken glob)', () => {
    expect(migrationSourceFiles().length).toBeGreaterThan(50);
  });
});
