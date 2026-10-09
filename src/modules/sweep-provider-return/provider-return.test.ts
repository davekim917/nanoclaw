import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerObservation, SweepSessionContext, WakePlan } from '../../host-sweep.js';
import type { Session } from '../../types.js';

const spawns = vi.hoisted(() => [] as string[]);
vi.mock('child_process', () => {
  const tripwire = (name: string) => (): never => {
    spawns.push(name);
    throw new Error(`provider-return.test: real process spawn attempted (${name})`);
  };
  return {
    exec: tripwire('exec'),
    execFile: tripwire('execFile'),
    execFileSync: tripwire('execFileSync'),
    execSync: tripwire('execSync'),
    spawn: tripwire('spawn'),
    spawnSync: tripwire('spawnSync'),
    fork: tripwire('fork'),
  };
});

const state = vi.hoisted(() => ({
  primaryUnavailable: false,
  fallbackUnavailable: false,
  liveClaims: 0,
  registered: { containerName: 'nanoclaw-v2-g-1', claimIncarnation: 1 } as {
    containerName: string;
    claimIncarnation: number;
  } | null,
  providerFallback: { provider: 'codex' } as { provider: string } | undefined,
}));
const killContainer = vi.hoisted(() => vi.fn());
const requestWake = vi.hoisted(() => vi.fn(async () => true));
const outboundWrites = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('../../db/provider-health.js', () => ({
  isProviderUnavailable: vi.fn(async (_group: string, provider: string) =>
    provider === 'claude' ? state.primaryUnavailable : state.fallbackUnavailable,
  ),
}));
vi.mock('../../container-config.js', () => ({
  readContainerConfig: () => ({ provider: 'claude', providerFallback: state.providerFallback }),
}));
vi.mock('../../container-runner.js', () => ({
  containerIdentityFor: () => state.registered,
  // No container owns outbound.db here, so a thread line the duty wrote would land and fail the test.
  containerOwnsOutbound: () => false,
  killContainer,
  sameContainerIdentity: (
    a: { containerName: string; claimIncarnation: number } | null,
    b: { containerName: string; claimIncarnation: number } | null,
  ) => !!a && !!b && a.containerName === b.containerName && a.claimIncarnation === b.claimIncarnation,
  sessionStillActive: () => () => true,
}));
vi.mock('../../request-wake.js', () => ({ requestWake }));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, _s: string, action: (m: unknown) => unknown) =>
    action({
      readSessionRouting: () => ({ platform_id: 'slack:C1', channel_type: 'slack', thread_id: 'T1' }),
      writeOutboundDirect: (row: Record<string, unknown>) => outboundWrites.push(row),
    }),
}));

const { _fallbackMarkerCacheSizeForTesting, _resetProviderReturnForTesting, isBetweenTurns, sweepProviderReturn } =
  await import('./index.js');

const session = {
  id: 'sess-1',
  agent_group_id: 'ag-1',
  agent_provider: null,
  thread_id: 'T1',
} as unknown as Session;

const idlePlan: WakePlan = {
  dueCount: 0,
  wakePriority: 'interactive',
  admittedTasks: 0,
  workContinuation: null,
  continuationWakeEligible: false,
  hasOutbound: true,
};

function observation(overrides: Partial<ContainerObservation> = {}): ContainerObservation {
  return {
    containerState: { provider_executing: 0 } as ContainerObservation['containerState'],
    processingClaimCount: 0,
    lastOutboundAtMs: 0,
    lastInboundAtMs: 0,
    containerIdentity: { containerName: 'nanoclaw-v2-g-1', claimIncarnation: 1 },
    ...overrides,
  };
}

const wakeRows: Array<Record<string, unknown>> = [];
function context(overrides: { plan?: Partial<WakePlan>; observed?: ContainerObservation | null } = {}) {
  const mailbox = {
    countDueMessages: () => 0,
    readWorkContinuation: () => null,
    getContainerState: () => ({ provider_executing: 0 }),
    getProcessingClaimRows: () => Array.from({ length: state.liveClaims }),
    insertDeferredMessageWithContextIfNew: (row: Record<string, unknown>) => {
      wakeRows.push(row);
      return true;
    },
  };
  return {
    session,
    agentGroupId: 'ag-1',
    agentGroupFolder: 'g',
    plan: { ...idlePlan, ...overrides.plan },
    observed: overrides.observed === undefined ? observation() : overrides.observed,
    run: async (action: (m: unknown) => unknown) => action(mailbox),
  } as unknown as SweepSessionContext;
}

beforeEach(() => {
  state.primaryUnavailable = false;
  state.fallbackUnavailable = false;
  state.liveClaims = 0;
  state.registered = { containerName: 'nanoclaw-v2-g-1', claimIncarnation: 1 };
  state.providerFallback = { provider: 'codex' };
  killContainer.mockReset();
  requestWake.mockClear();
  outboundWrites.length = 0;
  wakeRows.length = 0;
  _resetProviderReturnForTesting();
});

afterEach(() => {
  expect(spawns).toEqual([]);
});

describe('isBetweenTurns', () => {
  it('holds only with nothing due, claimed, executing or running as a continuation', () => {
    const observed = observation();
    expect(isBetweenTurns(idlePlan, observed)).toBe(true);
    expect(isBetweenTurns({ ...idlePlan, dueCount: 1 }, observed)).toBe(false);
    expect(isBetweenTurns(idlePlan, observation({ processingClaimCount: 1 }))).toBe(false);
    expect(
      isBetweenTurns(
        idlePlan,
        observation({ containerState: { provider_executing: 1 } as ContainerObservation['containerState'] }),
      ),
    ).toBe(false);
    const running = { phase: 'running' } as WakePlan['workContinuation'];
    expect(isBetweenTurns({ ...idlePlan, workContinuation: running }, observed)).toBe(false);
    const queued = { phase: 'queued' } as WakePlan['workContinuation'];
    expect(isBetweenTurns({ ...idlePlan, workContinuation: queued }, observed)).toBe(true);
  });
});

describe('sweepProviderReturn', () => {
  it('restarts a fallback container between turns once the primary is available, and respawns it without a thread line', async () => {
    const readMarker = vi.fn(() => true);
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(true);

    expect(wakeRows).toHaveLength(1);
    expect(wakeRows[0]).toMatchObject({ onWake: 1 });
    expect(String(wakeRows[0].content)).toContain('move it back to claude');
    // The runner posts the thread line from these fields once the primary answers the wake.
    expect(JSON.parse(String(wakeRows[0].content))._system).toEqual({
      kind: 'provider_fallback_return',
      provider: 'claude',
      from: 'codex',
    });
    expect(killContainer).toHaveBeenCalledTimes(1);
    const [sessionId, , onExit, intent] = killContainer.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(intent).toBe('respawn_after_stop');

    await onExit();
    // The primary has not answered yet: the line is the runner's to post once it does.
    expect(outboundWrites).toHaveLength(0);
    expect(requestWake).toHaveBeenCalledWith(session, 'container-restart', expect.anything());
  });

  it('leaves the fallback alone while the primary is still in its window', async () => {
    state.primaryUnavailable = true;
    const readMarker = vi.fn(() => true);
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(false);
    expect(readMarker).not.toHaveBeenCalled();
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('stays put when both providers are in cooldown', async () => {
    state.primaryUnavailable = true;
    state.fallbackUnavailable = true;
    await expect(sweepProviderReturn(context(), { readMarker: () => true })).resolves.toBe(false);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('does not kill a container that took a turn after the observation', async () => {
    state.liveClaims = 1;
    await expect(sweepProviderReturn(context(), { readMarker: () => true })).resolves.toBe(false);
    expect(wakeRows).toHaveLength(0);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('never interrupts a turn', async () => {
    const readMarker = vi.fn(() => true);
    await expect(
      sweepProviderReturn(context({ observed: observation({ processingClaimCount: 1 }) }), { readMarker }),
    ).resolves.toBe(false);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('ignores a container started on the primary, inspecting it once', async () => {
    const readMarker = vi.fn(() => false);
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(false);
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(false);
    expect(readMarker).toHaveBeenCalledTimes(1);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('drops a cached judgement once its container is gone', async () => {
    const readMarker = vi.fn((_containerName: string) => false);
    await sweepProviderReturn(context(), { readMarker });
    state.registered = { containerName: 'nanoclaw-v2-g-2', claimIncarnation: 2 };
    const replacement = observation({ containerIdentity: { containerName: 'nanoclaw-v2-g-2', claimIncarnation: 2 } });
    await sweepProviderReturn(context({ observed: replacement }), { readMarker });
    expect(readMarker.mock.calls.map(([name]) => name)).toEqual(['nanoclaw-v2-g-1', 'nanoclaw-v2-g-2']);
    expect(_fallbackMarkerCacheSizeForTesting()).toBe(1);
  });

  it('retries an unanswered inspect on the next tick instead of caching it', async () => {
    const readMarker = vi.fn(() => {
      throw new Error('daemon unreachable');
    });
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(false);
    await expect(sweepProviderReturn(context(), { readMarker })).resolves.toBe(false);
    expect(readMarker).toHaveBeenCalledTimes(2);
  });

  it('writes no wake row for a container replaced while the mailbox window opened', async () => {
    const replacingContext = context();
    const open = replacingContext.run;
    (replacingContext as { run: typeof open }).run = (action) => {
      state.registered = { containerName: 'nanoclaw-v2-g-2', claimIncarnation: 2 };
      return open(action);
    };
    await expect(sweepProviderReturn(replacingContext, { readMarker: () => true })).resolves.toBe(true);
    expect(wakeRows).toHaveLength(0);
    expect(killContainer).not.toHaveBeenCalled();
  });

  it('does not kill a replacement registered since the observation', async () => {
    state.registered = { containerName: 'nanoclaw-v2-g-2', claimIncarnation: 2 };
    await expect(sweepProviderReturn(context(), { readMarker: () => true })).resolves.toBe(true);
    expect(wakeRows).toHaveLength(0);
    expect(killContainer).not.toHaveBeenCalled();
  });
});
