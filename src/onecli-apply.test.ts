/**
 * Instrumented OneCLI apply on the spawn path.
 *
 * Two behaviors are under test, and they are the two the live-host forensics
 * on issue #239 called for:
 *
 *   1. The retry decision — one attempt for the proved-transient class, none
 *      for a deterministic 4xx — and that a retry cannot corrupt the Docker
 *      argument array.
 *   2. The logging shape — that a refusal now names its cause instead of
 *      saying only that it happened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from './log.js';
import {
  applyOnecliContainerConfig,
  causeCodeOf,
  describeDiagnosis,
  runApplyWithRetry,
  type ApplyDeps,
} from './onecli-apply.js';
import { isRetryableStatus } from './onecli-preflight.js';

/** Error shaped like the SDK's `OneCLIRequestError` (carries `statusCode`). */
function requestError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`OneCLI returned ${statusCode}`), { statusCode });
}

/** What the SDK hands us for a transport fault, after `toOneCLIError` flattens it. */
function flattenedTransportError(): Error {
  return Object.assign(new Error('fetch failed'), { name: 'OneCLIError' });
}

function deps(overrides: Partial<ApplyDeps> = {}): ApplyDeps & { diagnoseCalls: Array<string | undefined> } {
  const diagnoseCalls: Array<string | undefined> = [];
  return {
    applyContainerConfig: async () => true,
    diagnose: async (agent) => {
      diagnoseCalls.push(agent);
      return { probe: 'control API answered 200 on the diagnostic probe — the failure was transient' };
    },
    now: (() => {
      let t = 0;
      return () => (t += 40);
    })(),
    sleep: async () => {},
    retryDelayMs: 0,
    diagnoseCalls,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runApplyWithRetry', () => {
  it('applies on the first attempt without retrying or probing', async () => {
    const d = deps();
    const result = await runApplyWithRetry([], { addHostMapping: false, agent: 'ag-1' }, d);

    expect(result.applied).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.durationsMs).toHaveLength(1);
    expect(d.diagnoseCalls).toEqual([]);
  });

  it('retries once when the SDK returns false, and reports the recovery', async () => {
    const calls: string[][] = [];
    const d = deps({
      applyContainerConfig: async (args) => {
        calls.push([...args]);
        // The SDK pushes its -e/-v flags only after the config fetch succeeds,
        // so a failed attempt leaves `args` untouched.
        if (calls.length === 1) return false;
        args.push('-e', 'HTTPS_PROXY=http://gateway');
        return true;
      },
    });
    const args: string[] = ['--rm'];

    const result = await runApplyWithRetry(args, { addHostMapping: false, agent: 'ag-1' }, d);

    expect(result.applied).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.durationsMs).toHaveLength(2);
    // No diagnostic probe on a recovered spawn — it only runs when both fail.
    expect(d.diagnoseCalls).toEqual([]);
    // Exactly one copy of the gateway flags: the failed attempt pushed nothing.
    expect(args).toEqual(['--rm', '-e', 'HTTPS_PROXY=http://gateway']);
  });

  it('probes for the flattened cause when both attempts return false', async () => {
    const d = deps({
      applyContainerConfig: async () => false,
      diagnose: async (agent) => {
        expect(agent).toBe('ag-1');
        return { probe: 'diagnostic probe failed: fetch failed (ECONNRESET)', causeCode: 'ECONNRESET' };
      },
    });

    const result = await runApplyWithRetry([], { addHostMapping: false, agent: 'ag-1' }, d);

    expect(result.applied).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.diagnosis).toMatchObject({
      outcome: 'returned-false',
      causeCode: 'ECONNRESET',
      probe: 'diagnostic probe failed: fetch failed (ECONNRESET)',
    });
  });

  it('retries a thrown transport fault, which the SDK has already flattened', async () => {
    let attempts = 0;
    const d = deps({
      applyContainerConfig: async () => {
        attempts++;
        if (attempts === 1) throw flattenedTransportError();
        return true;
      },
    });

    const result = await runApplyWithRetry([], { addHostMapping: false, agent: 'ag-1' }, d);

    expect(result.applied).toBe(true);
    expect(attempts).toBe(2);
  });

  it.each([408, 425, 429])('retries a momentary %i', async (status) => {
    let attempts = 0;
    const d = deps({
      applyContainerConfig: async () => {
        attempts++;
        if (attempts === 1) throw requestError(status);
        return true;
      },
    });

    const result = await runApplyWithRetry([], { addHostMapping: false, agent: 'ag-1' }, d);

    expect(result.applied).toBe(true);
    expect(attempts).toBe(2);
  });

  it.each([400, 401, 403, 404])('rethrows a deterministic %i without retrying', async (status) => {
    let attempts = 0;
    const d = deps({
      applyContainerConfig: async () => {
        attempts++;
        throw requestError(status);
      },
    });

    await expect(runApplyWithRetry([], { addHostMapping: false, agent: 'ag-1' }, d)).rejects.toThrow(
      `OneCLI returned ${status}`,
    );
    expect(attempts).toBe(1);
    // No probe either — a misconfiguration needs the real error, not a guess.
    expect(d.diagnoseCalls).toEqual([]);
  });

  it('shares its status classification with the boot preflight', () => {
    // Guards against the spawn path and the boot probe drifting apart on what
    // counts as transient.
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('applyOnecliContainerConfig logging shape', () => {
  it('logs nothing extra when the first attempt applies', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const result = await applyOnecliContainerConfig(
      [],
      { addHostMapping: false, agent: 'ag-1' },
      { ...deps(), applyContainerConfig: async () => true },
    );

    expect(result.applied).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with agent, attempts and durations when a retry recovers the spawn', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let attempts = 0;

    await applyOnecliContainerConfig(
      [],
      { addHostMapping: false, agent: 'ag-noslack' },
      {
        ...deps(),
        applyContainerConfig: async () => {
          attempts++;
          return attempts > 1;
        },
      },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('OneCLI gateway apply failed once, retry succeeded');
    expect(fields).toMatchObject({ agent: 'ag-noslack', attempts: 2, outcome: 'returned-false' });
    expect(fields.durationsMs).toHaveLength(2);
  });

  it('warns with the underlying cause, status and probe when the spawn is refused', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const result = await applyOnecliContainerConfig(
      [],
      { addHostMapping: false, agent: 'ag-1' },
      {
        ...deps(),
        applyContainerConfig: async () => {
          throw requestError(503);
        },
        diagnose: async () => ({
          probe: 'diagnostic probe failed: fetch failed (UND_ERR_SOCKET)',
          causeCode: 'UND_ERR_SOCKET',
        }),
      },
    );

    expect(result.applied).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('OneCLI gateway apply failed on both attempts — spawn will be refused');
    expect(fields).toMatchObject({
      agent: 'ag-1',
      attempts: 2,
      outcome: 'threw',
      statusCode: 503,
      causeCode: 'UND_ERR_SOCKET',
      message: 'OneCLI returned 503',
      probe: 'diagnostic probe failed: fetch failed (UND_ERR_SOCKET)',
    });
  });
});

describe('causeCodeOf', () => {
  it('recovers the undici code from a nested cause chain', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    expect(causeCodeOf(err)).toBe('ECONNRESET');
  });

  it('returns undefined for the flattened error the SDK actually hands us', () => {
    // The regression this whole module exists for: `toOneCLIError` copies the
    // message and drops `.cause`, so there is nothing left to recover — which
    // is why the diagnostic probe has to make its own request.
    expect(causeCodeOf(flattenedTransportError())).toBeUndefined();
  });
});

describe('describeDiagnosis', () => {
  it('renders a one-line cause for the refusal message', () => {
    expect(
      describeDiagnosis({
        outcome: 'returned-false',
        causeCode: 'ECONNRESET',
        probe: 'diagnostic probe failed: fetch failed (ECONNRESET)',
      }),
    ).toBe('SDK returned false; ECONNRESET; diagnostic probe failed: fetch failed (ECONNRESET)');
  });

  it('says so plainly when nothing was captured', () => {
    expect(describeDiagnosis(undefined)).toBe('no diagnosis captured');
  });
});
