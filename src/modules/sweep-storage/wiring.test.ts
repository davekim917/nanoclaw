/**
 * Production-barrel wiring case (rule added 2026-09-03 15:35Z after Codex hit
 * PR 7). src/host-sweep-registry.test.ts's direct `import
 * './modules/sweep-storage/index.js'` proves the registry mechanics but
 * masks whether `src/modules/index.ts` — the barrel `src/main.ts` actually
 * loads — carries this family's line. This file imports the barrel itself.
 *
 * No mocking: see src/modules/sweep-egress/wiring.test.ts's docstring — the
 * whole modules barrel is registration-only at import time.
 */
import { describe, expect, it } from 'vitest';

import { _listSweepRegistrationsForTesting } from '../../host-sweep.js';

describe('the production modules barrel registers the sweep-storage duty source', () => {
  it('the production modules barrel registers the sweep-storage duty source', async () => {
    await import('../index.js');

    const { duties } = _listSweepRegistrationsForTesting();
    expect(duties.some((d) => d.name === 'storage-maintenance')).toBe(true);
  });
});
