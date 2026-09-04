/**
 * Production-wiring proof for the scheduled-move-recovery sweep family
 * (S2-PR7, Codex round on efb8350a..73e6c960 — finding F2).
 *
 * src/host-sweep-registry.test.ts imports this module directly (lead-
 * sanctioned, so R-7 can assert on the registry deterministically — see the
 * build report's "Deviations" section). That direct import alone would stay
 * green even if the production wiring line for this family were deleted
 * from src/modules/index.ts, silently masking a real regression: nothing
 * would then prove the PRODUCTION barrel — the file src/main.ts actually
 * loads at its own import time — still registers T11/T12.
 *
 * This test instead imports the barrel itself (`../index.js`) with no seam
 * mocks, following src/main.memory-startup-order.test.ts's precedent that
 * importing the barrel's full graph is already safe unmocked: registration
 * is side-effect-free (it pushes closures into arrays; it never executes a
 * duty body), so nothing here reaches docker, git, or the filesystem outside
 * process-level module loading.
 */
import { describe, expect, it } from 'vitest';

import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
// The production barrel — same import main.ts makes. Its own top-level
// import of ../mailbox/compose.js and the rest of the default module set is
// exactly what src/main.memory-startup-order.test.ts already proves safe to
// load unmocked.
import '../index.js';

describe('the production modules barrel registers the scheduled-move duty source', () => {
  it('T11 (scheduled-move-recovery) and T12 (audit-body-prune) are registered after importing ../index.js', () => {
    const { duties } = _listSweepRegistrationsForTesting();
    const names = new Set(duties.map((d) => d.name));
    expect(names.has(SWEEP_DUTY_INVENTORY.T11)).toBe(true);
    expect(names.has(SWEEP_DUTY_INVENTORY.T12)).toBe(true);
  });
});
