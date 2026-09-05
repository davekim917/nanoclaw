/**
 * Boot preflight for the OneCLI control API.
 *
 * The behavior under test is the boot decision: a failing control API must
 * exit the process, a succeeding one must let startup continue and emit the
 * greppable health line.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
  pickProbeAgent,
  probeOnecliControlApi,
  runOnecliBootPreflight,
  type PreflightDeps,
} from './onecli-preflight.js';

/** Error shaped like the SDK's `OneCLIRequestError` (carries `statusCode`). */
function requestError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`OneCLI returned ${statusCode}`), { statusCode });
}

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps & { exitCodes: number[] } {
  const exitCodes: number[] = [];
  return {
    getContainerConfig: async () => ({ env: {}, caCertificate: '', caCertificateContainerPath: '/ca.pem' }),
    probeAgent: async () => 'ag-probe',
    onecliConfigured: () => true,
    now: () => 0,
    sleep: async () => {},
    attempts: 3,
    retryDelayMs: 0,
    exit: ((code: number) => {
      exitCodes.push(code);
      return undefined as never;
    }) as PreflightDeps['exit'],
    exitCodes,
    ...overrides,
  };
}

describe('boot wiring', () => {
  /**
   * The gate has to close before anything can accept work. Past the dashboard
   * and the channel adapters an inbound message reaches routeInbound() and can
   * wake a container mid-probe, which both contends with the probe and means
   * the exit would kill a host that has already taken work on.
   */
  it('runs the preflight before the dashboard and the channel adapters', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'main.ts'), 'utf-8');
    const mainStart = source.indexOf('export async function main(): Promise<void> {');
    expect(mainStart).toBeGreaterThan(-1);
    const main = source.slice(mainStart);

    const preflight = main.indexOf('\n  await runOnecliBootPreflight();');
    const dashboard = main.indexOf('\n  startDashboard();');
    const adapters = main.indexOf('\n  await initChannelAdapters(');

    expect(preflight).toBeGreaterThan(-1);
    expect(dashboard).toBeGreaterThan(-1);
    expect(adapters).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(dashboard);
    expect(preflight).toBeLessThan(adapters);
  });
});

describe('pickProbeAgent', () => {
  it('picks the oldest agent group, breaking ties by id', () => {
    expect(
      pickProbeAgent([
        { id: 'ag-b', created_at: '2026-05-01T00:00:00.000Z' },
        { id: 'ag-a', created_at: '2026-04-01T00:00:00.000Z' },
        { id: 'ag-c', created_at: '2026-06-01T00:00:00.000Z' },
      ]),
    ).toBe('ag-a');

    expect(
      pickProbeAgent([
        { id: 'ag-z', created_at: '2026-04-01T00:00:00.000Z' },
        { id: 'ag-a', created_at: '2026-04-01T00:00:00.000Z' },
      ]),
    ).toBe('ag-a');
  });

  it('returns null when the install has no agent groups yet', () => {
    expect(pickProbeAgent([])).toBeNull();
  });
});

describe('probeOnecliControlApi', () => {
  it('probes with the same shape the spawn path applies', async () => {
    const calls: Array<{ agent?: string }> = [];
    const result = await probeOnecliControlApi(
      deps({
        getContainerConfig: async (options) => {
          calls.push(options);
          return {};
        },
        now: (() => {
          const ticks = [1_000, 1_042];
          return () => ticks.shift() ?? 0;
        })(),
      }),
    );

    expect(calls).toEqual([{ agent: 'ag-probe' }]);
    expect(result).toEqual({ status: 'ok', agent: 'ag-probe', latencyMs: 42, attempts: 1 });
  });

  it('probes the default agent when no agent group exists', async () => {
    const calls: Array<{ agent?: string }> = [];
    const result = await probeOnecliControlApi(
      deps({
        probeAgent: async () => null,
        getContainerConfig: async (options) => {
          calls.push(options);
          return {};
        },
      }),
    );

    expect(calls).toEqual([{}]);
    expect(result.status).toBe('ok');
  });

  it('skips entirely when the install is not wired to a gateway', async () => {
    const getContainerConfig = vi.fn(async () => ({}));
    const result = await probeOnecliControlApi(deps({ onecliConfigured: () => false, getContainerConfig }));

    expect(result.status).toBe('skipped');
    expect(getContainerConfig).not.toHaveBeenCalled();
  });

  it('retries a transport failure and passes when the gateway comes up', async () => {
    let attempt = 0;
    const sleeps: number[] = [];
    const result = await probeOnecliControlApi(
      deps({
        retryDelayMs: 2_000,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        getContainerConfig: async () => {
          attempt += 1;
          if (attempt < 3) throw new Error('fetch failed');
          return {};
        },
      }),
    );

    expect(result).toMatchObject({ status: 'ok', attempts: 3 });
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it('fails after exhausting attempts on a persistent transport failure', async () => {
    const err = new Error('fetch failed');
    const result = await probeOnecliControlApi(deps({ getContainerConfig: async () => Promise.reject(err) }));

    expect(result).toEqual({ status: 'failed', agent: 'ag-probe', attempts: 3, httpStatus: undefined, err });
  });

  it('retries a 5xx but fails a configuration 4xx immediately', async () => {
    const serverErrorCalls = vi.fn(async () => Promise.reject(requestError(503)));
    const serverError = await probeOnecliControlApi(deps({ getContainerConfig: serverErrorCalls }));
    expect(serverError).toMatchObject({ status: 'failed', attempts: 3, httpStatus: 503 });
    expect(serverErrorCalls).toHaveBeenCalledTimes(3);

    for (const status of [400, 401, 403]) {
      const calls = vi.fn(async () => Promise.reject(requestError(status)));
      const result = await probeOnecliControlApi(deps({ getContainerConfig: calls }));
      expect(result).toMatchObject({ status: 'failed', attempts: 1, httpStatus: status });
      expect(calls).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a momentary 4xx instead of taking the host down', async () => {
    for (const status of [408, 425, 429]) {
      let attempt = 0;
      const result = await probeOnecliControlApi(
        deps({
          getContainerConfig: async () => {
            attempt += 1;
            if (attempt < 3) throw requestError(status);
            return {};
          },
        }),
      );
      expect(result).toMatchObject({ status: 'ok', attempts: 3 });
    }

    const rateLimited = vi.fn(async () => Promise.reject(requestError(429)));
    const exhausted = await probeOnecliControlApi(deps({ getContainerConfig: rateLimited }));
    expect(exhausted).toMatchObject({ status: 'failed', attempts: 3, httpStatus: 429 });
    expect(rateLimited).toHaveBeenCalledTimes(3);
  });

  it('treats a 404 for an unregistered probe agent as reachable when the default agent answers', async () => {
    const calls: Array<{ agent?: string }> = [];
    const result = await probeOnecliControlApi(
      deps({
        getContainerConfig: async (options) => {
          calls.push(options);
          if (options.agent) throw requestError(404);
          return {};
        },
      }),
    );

    expect(calls).toEqual([{ agent: 'ag-probe' }, {}]);
    expect(result).toMatchObject({ status: 'ok-agent-unregistered', agent: 'ag-probe', attempts: 1 });
  });

  it('fails when the default-agent re-probe also cannot reach the control API', async () => {
    const result = await probeOnecliControlApi(
      deps({
        getContainerConfig: async (options) => {
          if (options.agent) throw requestError(404);
          throw new Error('fetch failed');
        },
      }),
    );

    expect(result).toMatchObject({ status: 'failed', agent: 'ag-probe', attempts: 3 });
  });
});

describe('runOnecliBootPreflight', () => {
  it('exits non-zero when the control API the spawn path uses is unreachable', async () => {
    const d = deps({ getContainerConfig: async () => Promise.reject(new Error('fetch failed')) });
    await runOnecliBootPreflight(d);

    expect(d.exitCodes).toEqual([1]);
  });

  it('exits non-zero on a deterministic 4xx misconfiguration', async () => {
    const d = deps({ getContainerConfig: async () => Promise.reject(requestError(401)) });
    await runOnecliBootPreflight(d);

    expect(d.exitCodes).toEqual([1]);
  });

  it('continues and emits the greppable health line on success', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const d = deps({
        now: (() => {
          const ticks = [5_000, 5_081];
          return () => ticks.shift() ?? 0;
        })(),
      });
      const result = await runOnecliBootPreflight(d);

      expect(d.exitCodes).toEqual([]);
      expect(result).toMatchObject({ status: 'ok', agent: 'ag-probe', latencyMs: 81 });

      const lines = stdout.mock.calls.map((call) => String(call[0]));
      const health = lines.find((line) => line.includes('OneCLI preflight ok'));
      expect(health).toBeDefined();
      expect(health).toContain('ag-probe');
      expect(health).toContain('81');
    } finally {
      stdout.mockRestore();
    }
  });

  it('continues without exiting when only the probe agent is missing from the vault', async () => {
    const d = deps({
      getContainerConfig: async (options) => {
        if (options.agent) throw requestError(404);
        return {};
      },
    });
    const result = await runOnecliBootPreflight(d);

    expect(d.exitCodes).toEqual([]);
    expect(result.status).toBe('ok-agent-unregistered');
  });

  it('continues without probing when the install is not wired to a gateway', async () => {
    const d = deps({ onecliConfigured: () => false });
    const result = await runOnecliBootPreflight(d);

    expect(d.exitCodes).toEqual([]);
    expect(result.status).toBe('skipped');
  });
});
