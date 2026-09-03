/**
 * Issue #300 (see src/mailbox-seam-unreachable-scripts.test.ts for the full
 * proof and its rationale). This half covers the one check that needs to
 * import a scripts/ module: scripts/verify-workgroup-memory-runtime.ts
 * imports `parseMigrationReport` (a value import) from
 * scripts/migrate-workgroup-memory.ts, which has a top-level
 * `reconcilePendingUpgradeContexts` call — but only inside `runCli()`,
 * itself gated behind `pathToFileURL(process.argv[1]) === import.meta.url`.
 * That's false for any importer other than migrate-workgroup-memory.ts
 * itself run directly, so loading the module for a value export never
 * executes runCli() or reaches the seam through it.
 *
 * src/mailbox-seam-unreachable-scripts.test.ts's tsconfig rootDir is `src/`,
 * so it cannot import a scripts/ module — hence this separate file, which
 * vitest.config.ts already includes via `scripts/**\/*.test.ts`.
 */
import { describe, expect, it } from 'vitest';

describe('scripts/verify-workgroup-memory-runtime.ts — importing migrate-workgroup-memory.ts for parseMigrationReport', () => {
  it('does not execute runCli() (and so never reaches reconcilePendingUpgradeContexts / the mailbox seam)', async () => {
    const mod = await import('./migrate-workgroup-memory.js');
    // If runCli() had executed on import, it would have thrown or exited
    // long before this resolves (no argv[1] usage report, no report file).
    // Its only externally visible effect from a bare import is exposing
    // parseMigrationReport and the report types the verify script consumes.
    expect(typeof mod.parseMigrationReport).toBe('function');
  });
});
