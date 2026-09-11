import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A complete stub, not a spread: log.ts installs process-wide handlers at
// module scope (see storage-manager.test.ts for the same note).
vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

const runsAsHostUser = vi.hoisted(() => ({ value: true }));
vi.mock('./github-token-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./github-token-file.js')>()),
  containerRunsAsHostUser: () => runsAsHostUser.value,
}));

import {
  _resetCheckoutModeForTesting,
  CHECKOUT_MODE_ENV,
  decideCheckoutMode,
  effectiveCheckoutMode,
} from './checkout-mode.js';
import { log } from './log.js';

const saved = process.env[CHECKOUT_MODE_ENV];

beforeEach(() => {
  vi.clearAllMocks();
  runsAsHostUser.value = true;
  delete process.env[CHECKOUT_MODE_ENV];
  _resetCheckoutModeForTesting();
});

afterEach(() => {
  if (saved === undefined) delete process.env[CHECKOUT_MODE_ENV];
  else process.env[CHECKOUT_MODE_ENV] = saved;
  _resetCheckoutModeForTesting();
});

describe('checkout mode flag', () => {
  it('defaults to worktree and accepts the two named modes', () => {
    expect(decideCheckoutMode(undefined, true)).toEqual({ mode: 'worktree', warning: null });
    expect(decideCheckoutMode('worktree', true)).toEqual({ mode: 'worktree', warning: null });
    expect(decideCheckoutMode('clone', true)).toEqual({ mode: 'clone', warning: null });
  });

  it('an unknown value is worktree with a warning, so a typo never enables clones', () => {
    for (const raw of ['Clone', 'clones', '', ' clone', 'on']) {
      const decision = decideCheckoutMode(raw, true);
      expect(decision.mode, raw).toBe('worktree');
      expect(decision.warning, raw).toMatch(/NANOCLAW_CHECKOUT_MODE/);
    }
  });

  it('refuses clone unless containers run as the host uid', () => {
    const decision = decideCheckoutMode('clone', false);
    expect(decision.mode).toBe('worktree');
    expect(decision.warning).toMatch(/host uid/);
    // Worktree mode needs no such precondition.
    expect(decideCheckoutMode('worktree', false)).toEqual({ mode: 'worktree', warning: null });
  });

  it('resolves once per process from the environment and warns once on refusal', () => {
    process.env[CHECKOUT_MODE_ENV] = 'clone';
    runsAsHostUser.value = false;
    expect(effectiveCheckoutMode()).toBe('worktree');
    expect(effectiveCheckoutMode()).toBe('worktree');
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);

    // Memoized for the process: changing the environment needs a restart.
    runsAsHostUser.value = true;
    expect(effectiveCheckoutMode()).toBe('worktree');

    _resetCheckoutModeForTesting();
    expect(effectiveCheckoutMode()).toBe('clone');
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  });
});
