/**
 * Issue #300 (see src/mailbox-seam-unreachable-scripts.test.ts for the full
 * proof and its rationale). This half covers the checks that need to import
 * a scripts/ module:
 *
 *   - scripts/verify-workgroup-memory-runtime.ts imports
 *     `parseMigrationReport` (a value import) from
 *     scripts/migrate-workgroup-memory.ts, which has a top-level
 *     `reconcilePendingUpgradeContexts` call — but only inside `runCli()`,
 *     itself gated behind `pathToFileURL(process.argv[1]) === import.meta.url`.
 *     That's false for any importer other than migrate-workgroup-memory.ts
 *     itself run directly, so loading the module for a value export never
 *     executes runCli() or reaches the seam through it.
 *   - scripts/verify-workgroup-memory-runtime.ts itself has the same
 *     `isMain` guard around its own `runCli()`, so a bare import of it is
 *     equally safe — but that was never actually exercised here (only its
 *     migrate-workgroup-memory.ts dependency was imported directly), so a
 *     future top-level mailbox call or seam-reaching import added directly
 *     to the verifier would have broken standalone execution while every
 *     test in this file stayed green. Imported directly below to close that
 *     gap.
 *
 * src/mailbox-seam-unreachable-scripts.test.ts's tsconfig rootDir is `src/`,
 * so it cannot import a scripts/ module — hence this separate file, which
 * vitest.config.ts already includes via `scripts/**\/*.test.ts`.
 *
 * `src/test-setup.ts`'s global `beforeEach` registers the real mailbox
 * factory before every test in the suite (via a dynamic `import` of
 * `mailbox/compose.js`, which is idempotent after the first run because ESM
 * caches the module — it doesn't re-register on later tests). That means a
 * bare `await import('./migrate-workgroup-memory.js')` here would run with a
 * mailbox factory already registered, so an accidental top-level seam call
 * in the script would silently succeed instead of throwing — proving
 * nothing about the actual standalone `tsx` execution context, where no
 * factory is ever registered. Each `it` below unregisters the factory
 * (`resetAgentMailboxForTesting`) and calls `vi.resetModules()` so the
 * dynamic imports underneath re-evaluate their top-level code against a
 * fresh, genuinely unregistered module graph, then restores the previous
 * factory afterward so later test files are unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerAgentMailbox, resetAgentMailboxForTesting, type AgentMailboxFactory } from '../src/mailbox/index.js';

const NOT_REGISTERED = 'No agent mailbox registered';

describe('scripts/verify-workgroup-memory-runtime.ts — importing migrate-workgroup-memory.ts for parseMigrationReport', () => {
  let previousFactory: AgentMailboxFactory | undefined;

  beforeEach(() => {
    previousFactory = resetAgentMailboxForTesting();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    if (previousFactory) registerAgentMailbox(previousFactory);
  });

  it('does not execute runCli() (and so never reaches reconcilePendingUpgradeContexts / the mailbox seam)', async () => {
    const mod = await import('./migrate-workgroup-memory.js');
    // If runCli() had executed on import, it would have thrown or exited
    // long before this resolves (no argv[1] usage report, no report file).
    // Its only externally visible effect from a bare import is exposing
    // parseMigrationReport and the report types the verify script consumes.
    // With the mailbox factory unregistered (above), a top-level seam call
    // anywhere in this module's transitive graph would throw
    // "No agent mailbox registered" instead of resolving.
    expect(typeof mod.parseMigrationReport).toBe('function');
  });

  it('the verifier module itself (verify-workgroup-memory-runtime.ts) is also safe to import bare', async () => {
    const mod = await import('./verify-workgroup-memory-runtime.js');
    // scripts/verify-workgroup-memory-runtime.ts has the same isMain guard
    // around its own runCli() (`pathToFileURL(process.argv[1]) ===
    // import.meta.url`), false for any importer other than the script run
    // directly — so a bare import here never executes runCli() either. With
    // the mailbox factory unregistered above, a top-level seam call
    // anywhere in ITS transitive import graph (not just
    // migrate-workgroup-memory.ts's) would throw "No agent mailbox
    // registered" instead of resolving.
    expect(typeof mod.verifyWorkgroupMemoryRuntime).toBe('function');
  });
});

describe('negative control: the reset + resetModules harness actually detects a real top-level seam hit', () => {
  let previousFactory: AgentMailboxFactory | undefined;

  beforeEach(() => {
    previousFactory = resetAgentMailboxForTesting();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
    if (previousFactory) registerAgentMailbox(previousFactory);
  });

  it('rejects with "No agent mailbox registered" when a module with a top-level seam call is imported', async () => {
    await expect(import('./__fixtures__/mailbox-seam-top-level-call.fixture.js')).rejects.toThrow(NOT_REGISTERED);
  });
});
