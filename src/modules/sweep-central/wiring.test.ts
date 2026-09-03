/**
 * Series-wide follow-up from S2-PR7's Codex round (upstream #310): every
 * family's registry test (here, src/host-sweep-registry.test.ts) imports
 * `./modules/sweep-central/index.js` DIRECTLY, so it would stay green even if
 * the PRODUCTION barrel (src/modules/index.ts, the file src/main.ts actually
 * imports) forgot the line that wires this family in — a real regression the
 * registry test cannot see.
 *
 * This proves the production barrel itself does the registering. Modeled on
 * src/main.test.ts's L-4 case and src/guard/conformance.test.ts: the
 * production barrel is safe to import with no mocking (registration is a
 * module-load-time array push, not an invocation of any duty body — nothing
 * here reaches docker, git, GitHub, Discord, an LLM or a worker thread), so
 * no hermeticity tripwire is needed in this file.
 *
 * `_listSweepDutySourcesForTesting` is not exported from src/host-sweep.ts —
 * falls back to checking this family's six duties by name via
 * `_listSweepRegistrationsForTesting()`, the same accessor R-7 uses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const CENTRAL_DUTY_NAMES = [
  'github-app-token-refresh', // T7
  'steer-idempotency-prune', // T9
  'channel-ingress-receipt-prune', // T10
  'session-title-sweep', // T15
  'thread-title-retry', // T16
  'dashboard-token-prune', // T17
];

beforeEach(() => {
  vi.resetModules();
});

describe('the production modules barrel registers the central duty source', () => {
  it("importing src/modules/index.js registers this family's six duties; they are absent before it", async () => {
    // host-sweep.js registers its OWN in-file built-ins the moment it is
    // imported, independent of any family module — so import it FIRST (dynamic,
    // post-reset, so this gets a fresh instance) to prove the six
    // sweep-central names are specifically ABSENT prior to the barrel import,
    // not just "the registry hasn't loaded yet".
    const hostSweep = await import('../../host-sweep.js');
    const before = new Set(hostSweep._listSweepRegistrationsForTesting().duties.map((d) => d.name));
    for (const name of CENTRAL_DUTY_NAMES) {
      expect(before.has(name), `"${name}" must not be registered before the barrel imports`).toBe(false);
    }

    // Production barrel — side-effect imports populate the real registries.
    // Same pattern as src/guard/conformance.test.ts and src/main.test.ts's L-4.
    await import('../index.js');

    const after = new Set(hostSweep._listSweepRegistrationsForTesting().duties.map((d) => d.name));
    for (const name of CENTRAL_DUTY_NAMES) {
      expect(after.has(name), `"${name}" must be registered once the barrel has imported`).toBe(true);
    }
  });
});
