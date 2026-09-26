/**
 * Production wiring case (added post-review, series-wide rule): every other
 * case in this directory drives `./index.js` directly, which masks whether
 * `src/modules/index.ts` — the barrel `src/main.ts` actually imports — still
 * carries this family's one import line. This file is the only one that
 * imports the real production barrel and checks the effect, the same
 * "no seam-2 mocks, plain dynamic import + `vi.resetModules()`" approach
 * `src/main.test.ts`'s T-5 case uses to prove `./modules/index.js` registers
 * for real (that file lives on the lifecycle-port branch lineage, not this
 * one, but the pattern is the established precedent). No `_listSweepDutySourcesForTesting`
 * accessor exists on `src/host-sweep.ts` (out of this family's ownership to
 * add — the registry internals belong to S2-PR2), so this asserts the
 * fallback: T6/T14 present by name in the full registration list.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

describe('the production modules barrel registers the orchestrator duty source', () => {
  it('importing ../index.js registers orchestrator-reconciler and completed-task-auto-archive', async () => {
    // Production barrel — side-effect imports populate the sweep duty
    // registry, same pattern as src/main.test.ts's T-5 case importing
    // ./modules/index.js and src/guard/conformance.test.ts.
    await import('../index.js');
    const { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY } = await import('../../host-sweep.js');

    const names = new Set(_listSweepRegistrationsForTesting().duties.map((d) => d.name));

    expect(names).toContain(SWEEP_DUTY_INVENTORY.T6);
    expect(names).toContain(SWEEP_DUTY_INVENTORY.T14);
  });
});
