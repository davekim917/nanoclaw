/**
 * Production-barrel wiring case (rule added 2026-09-03 15:35Z after Codex hit
 * PR 7). src/host-sweep-registry.test.ts's direct `import
 * './modules/sweep-usage/index.js'` proves the registry mechanics but masks
 * whether `src/modules/index.ts` — the barrel `src/main.ts` actually loads —
 * carries this family's line. This file imports the barrel itself.
 *
 * No mocking: `src/main.memory-startup-order.test.ts` already imports
 * `src/main.ts` (which top-level `import`s `./modules/index.js`
 * unconditionally, not gated behind `isDirectExecution`) with zero `vi.mock`
 * calls and passes — the whole modules barrel is registration-only at import
 * time, the same property host-sweep.ts's own import graph has (documented
 * in the sibling family test files, e.g. src/modules/sweep-egress/wiring.test.ts
 * on the S2-PR6 branch).
 */
import { describe, expect, it } from 'vitest';

import { _listSweepRegistrationsForTesting } from '../../host-sweep.js';

describe('the production modules barrel registers the sweep-usage duty source', () => {
  it('the production modules barrel registers the sweep-usage duty source', async () => {
    await import('../index.js');

    const { duties } = _listSweepRegistrationsForTesting();
    const duty = duties.find((d) => d.name === 'usage-rollup');
    // Codex round on 89f2d24c (F1): presence alone doesn't prove the barrel
    // carries the SAME registration the family module intends — assert the
    // plan-mandated coordinates too (phase/order encode 21 load-bearing
    // ordering constraints, plan.md §4.3), not just that some duty by this
    // name exists somewhere in the registry.
    expect(duty).toBeDefined();
    expect(duty?.phase).toBe('tick:post-session');
    expect(duty?.order).toBe(40);
  });
});
