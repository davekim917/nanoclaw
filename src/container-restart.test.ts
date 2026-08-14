import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockIsContainerRunning = vi.fn<(id: string) => boolean>();
const mockIsContainerSpawning = vi.fn<(id: string) => boolean>();
const mockKillContainer = vi.fn<(id: string, reason: string, onExit?: () => void) => void>();
const mockWakeContainer = vi.fn();
vi.mock('./container-runner.js', () => ({
  isContainerRunning: (...args: unknown[]) => mockIsContainerRunning(args[0] as string),
  isContainerSpawning: (...args: unknown[]) => mockIsContainerSpawning(args[0] as string),
  killContainer: (...args: unknown[]) =>
    mockKillContainer(args[0] as string, args[1] as string, args[2] as (() => void) | undefined),
  wakeContainer: (...args: unknown[]) => mockWakeContainer(...args),
}));

const mockGetSessionsByAgentGroup = vi.fn();
const mockGetSession = vi.fn();
vi.mock('./db/sessions.js', () => ({
  getSessionsByAgentGroup: (...args: unknown[]) => mockGetSessionsByAgentGroup(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

const mockWriteSessionMessage = vi.fn();
type MockSessionDb = { sessionId: string; close: ReturnType<typeof vi.fn> };
vi.mock('./session-manager.js', () => ({
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
  openInboundDb: (...args: unknown[]) => ({ sessionId: args[1] as string, close: vi.fn() }),
  openOutboundDb: (...args: unknown[]) => ({ sessionId: args[1] as string, close: vi.fn() }),
}));

const mockCountDueMessages = vi.fn((..._args: unknown[]) => 0);
const activeEpochs = new Map<string, { epoch: string; generation: string; state: 'active' | 'released' }>();
const acknowledgedEpochs = new Map<string, string>();
const processingSessions = new Set<string>();
const toolSessions = new Set<string>();
const activationFailures = new Set<string>();
let autoAcknowledgeBarrier = true;
let barrierGeneration = 0;
const mockActivateRepoIngressFence = vi.fn((db: MockSessionDb, epoch: string) => {
  if (activationFailures.has(db.sessionId)) throw new Error(`activation failed for ${db.sessionId}`);
  const prior = activeEpochs.get(db.sessionId);
  const active =
    prior?.state === 'active' && prior.epoch === epoch
      ? prior
      : { epoch, generation: `generation-${++barrierGeneration}`, state: 'active' as const };
  activeEpochs.set(db.sessionId, active);
  if (autoAcknowledgeBarrier) acknowledgedEpochs.set(db.sessionId, JSON.stringify([epoch, active.generation]));
  return active;
});
const mockReleaseRepoIngressFence = vi.fn((db: MockSessionDb, epoch: string, generation: string) => {
  const current = activeEpochs.get(db.sessionId);
  if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
    return { released: false, admittedRows: 0, wakeRequired: false };
  }
  activeEpochs.set(db.sessionId, { epoch, generation, state: 'released' });
  return { released: true, admittedRows: 0, wakeRequired: mockCountDueMessages(db) > 0 };
});
vi.mock('./db/session-db.js', () => ({
  countDueMessages: (...args: unknown[]) => mockCountDueMessages(...args),
  activateRepoIngressFence: (...args: unknown[]) =>
    mockActivateRepoIngressFence(args[0] as MockSessionDb, args[1] as string),
  releaseRepoIngressFence: (...args: unknown[]) =>
    mockReleaseRepoIngressFence(args[0] as MockSessionDb, args[1] as string, args[2] as string),
  repoIngressFenceAckToken: (fence: { epoch: string; generation: string }) =>
    JSON.stringify([fence.epoch, fence.generation]),
  readRepoIngressFence: (db: MockSessionDb) => activeEpochs.get(db.sessionId) ?? null,
  readRepositoryMountBarrierAck: (db: MockSessionDb) => acknowledgedEpochs.get(db.sessionId) ?? null,
  getProcessingClaims: (db: MockSessionDb) => (processingSessions.has(db.sessionId) ? [{ message_id: 'late' }] : []),
  getContainerState: (db: MockSessionDb) => (toolSessions.has(db.sessionId) ? { current_tool: 'Bash' } : null),
}));

import {
  quiesceAgentGroupsForRepositoryMounts,
  quiesceSessionsForRepositoryMounts,
  releaseRepositoryMountQuiescence,
  RepositoryMountQuiescenceError,
  restartAgentGroupContainers,
  wakeRepositoryMountSessions,
} from './container-restart.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsContainerSpawning.mockReturnValue(false);
  activeEpochs.clear();
  acknowledgedEpochs.clear();
  processingSessions.clear();
  toolSessions.clear();
  activationFailures.clear();
  autoAcknowledgeBarrier = true;
  barrierGeneration = 0;
  mockCountDueMessages.mockReturnValue(0);
});

describe('repository mount reconciliation', () => {
  it('stops every affected sibling and wakes the exact set after claim release', async () => {
    const sessions = [makeSession('s1', 'g1'), makeSession('s2', 'g2')];
    mockGetSessionsByAgentGroup.mockImplementation((id) => sessions.filter((session) => session.agent_group_id === id));
    const running = new Set(['s1', 's2']);
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      running.delete(id);
    });

    const quiescence = await quiesceAgentGroupsForRepositoryMounts(['g1', 'g2']);
    expect(mockKillContainer.mock.calls.map(([id]) => id).sort()).toEqual(['s1', 's2']);
    expect(quiescence.sessions.map((session) => session.id).sort()).toEqual(['s1', 's2']);
    expect(quiescence.barrierSessions.map((session) => session.id).sort()).toEqual(['s1', 's2']);

    expect(releaseRepositoryMountQuiescence(quiescence)).toEqual([]);
    wakeRepositoryMountSessions(quiescence.sessions);
    expect(mockWakeContainer).toHaveBeenCalledTimes(2);
  });

  it('does not kill after fence activation until exact poll ack, processing, and current tool all drain', async () => {
    const session = makeSession('s1', 'g1');
    const running = new Set(['s1']);
    autoAcknowledgeBarrier = false;
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      running.delete(id);
    });

    const pending = quiesceSessionsForRepositoryMounts([session] as never, 'repository-transfer:req-1');
    expect(activeEpochs.get('s1')).toEqual({
      epoch: 'repository-transfer:req-1',
      generation: 'generation-1',
      state: 'active',
    });

    // Model a claim/tool that was already admitted as the fence committed.
    // Neither an absent ACK nor a matching ACK with live work may authorize kill.
    processingSessions.add('s1');
    toolSessions.add('s1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockKillContainer).not.toHaveBeenCalled();

    acknowledgedEpochs.set('s1', JSON.stringify(['repository-transfer:req-1', 'generation-1']));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockKillContainer).not.toHaveBeenCalled();

    processingSessions.delete('s1');
    toolSessions.delete('s1');
    const quiescence = await pending;
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'repository mount set changed', undefined);
    expect(quiescence.epoch).toBe('repository-transfer:req-1');
    releaseRepositoryMountQuiescence(quiescence);
  });

  it('returns every stopped or initially-idle session with durable due rows after release', async () => {
    const running = makeSession('s1', 'g1');
    const initiallyIdle = makeSession('s2', 'g1');
    const live = new Set(['s1']);
    mockIsContainerRunning.mockImplementation((id) => live.has(id));
    mockKillContainer.mockImplementation((id) => live.delete(id));
    mockCountDueMessages.mockImplementation((db: unknown) => ((db as MockSessionDb).sessionId === 's2' ? 1 : 0));

    const quiescence = await quiesceSessionsForRepositoryMounts(
      [running, initiallyIdle] as never,
      'repository-publish:req-2',
    );
    expect(releaseRepositoryMountQuiescence(quiescence).map((session) => session.id)).toEqual(['s2']);
  });

  it('does not roll back a crash-left same-epoch barrier when a later session activation fails', async () => {
    const first = makeSession('s1', 'g1');
    const second = makeSession('s2', 'g1');
    activeEpochs.set('s1', {
      epoch: 'repository-transfer:req-replay',
      generation: 'crash-generation',
      state: 'active',
    });
    activationFailures.add('s2');
    mockIsContainerRunning.mockReturnValue(false);

    await expect(
      quiesceSessionsForRepositoryMounts([first, second] as never, 'repository-transfer:req-replay'),
    ).rejects.toThrow(/activation failed for s2/);
    expect(activeEpochs.get('s1')).toEqual({
      epoch: 'repository-transfer:req-replay',
      generation: 'crash-generation',
      state: 'active',
    });
    expect(mockReleaseRepoIngressFence).not.toHaveBeenCalled();
  });

  it('rejects a stale ACK when replay reactivates a released action epoch with a fresh generation', async () => {
    const session = makeSession('s1', 'g1');
    const running = new Set(['s1']);
    autoAcknowledgeBarrier = false;
    activeEpochs.set('s1', {
      epoch: 'repository-publish:req-replayed',
      generation: 'released-generation',
      state: 'released',
    });
    acknowledgedEpochs.set('s1', JSON.stringify(['repository-publish:req-replayed', 'released-generation']));
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => running.delete(id));

    const pending = quiesceSessionsForRepositoryMounts([session] as never, 'repository-publish:req-replayed');
    expect(activeEpochs.get('s1')).toEqual({
      epoch: 'repository-publish:req-replayed',
      generation: 'generation-1',
      state: 'active',
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(mockKillContainer).not.toHaveBeenCalled();

    acknowledgedEpochs.set('s1', JSON.stringify(['repository-publish:req-replayed', 'generation-1']));
    const quiescence = await pending;
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    releaseRepositoryMountQuiescence(quiescence);
  });

  it('attaches the exact stopped/due recovery set when post-kill stop proof times out', async () => {
    const first = makeSession('s1', 'g1');
    const stuck = makeSession('s2', 'g1');
    const running = new Set(['s1', 's2']);
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      if (id === 's1') running.delete(id);
    });
    mockCountDueMessages.mockImplementation((db: unknown) => ((db as MockSessionDb).sessionId === 's1' ? 1 : 0));

    const error = await quiesceSessionsForRepositoryMounts(
      [first, stuck] as never,
      'repository-publish:req-partial',
      20,
    ).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(RepositoryMountQuiescenceError);
    const recovery = error as RepositoryMountQuiescenceError;
    expect(recovery.barriersReleased).toBe(true);
    expect(recovery.quiescence.sessions.map((session) => session.id)).toEqual(['s1', 's2']);
    expect(recovery.releaseWakeSessions.map((session) => session.id)).toEqual(['s1']);
    expect(activeEpochs.get('s1')?.state).toBe('released');
    expect(activeEpochs.get('s2')?.state).toBe('released');
  });
});

// --- Helpers ---

function makeSession(id: string, agentGroupId: string, status = 'active') {
  return { id, agent_group_id: agentGroupId, status };
}

// --- Tests ---

describe('restartAgentGroupContainers', () => {
  it('skips sessions without a running container', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(false);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('skips non-active sessions', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1', 'closed')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('kills running containers and returns count', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockImplementation((id) => id === 's1');

    const count = restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('does not write wake message when wakeMessage is omitted', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test');

    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('writes on_wake message and passes onExit callback when wakeMessage is provided', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Should write an on-wake message
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = mockWriteSessionMessage.mock.calls[0];
    expect(agentGroupId).toBe('g1');
    expect(sessionId).toBe('s1');
    expect(msg.onWake).toBe(1);
    expect(JSON.parse(msg.content).text).toBe('Resuming.');

    // Should pass an onExit callback to killContainer
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    const onExit = mockKillContainer.mock.calls[0][2];
    expect(typeof onExit).toBe('function');
  });

  it('onExit callback calls wakeContainer with refreshed session', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    const freshSession = makeSession('s1', 'g1');
    mockGetSession.mockReturnValue(freshSession);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Simulate container exit by calling the onExit callback
    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockGetSession).toHaveBeenCalledWith('s1');
    expect(mockWakeContainer).toHaveBeenCalledWith(freshSession);
  });

  it('onExit callback does not wake if session no longer exists', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockGetSession.mockReturnValue(undefined);

    restartAgentGroupContainers('g1', 'test', 'Resuming.');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('handles multiple running sessions with wake message', () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = restartAgentGroupContainers('g1', 'test', 'Config updated.');

    expect(count).toBe(2);
    expect(mockKillContainer).toHaveBeenCalledTimes(2);
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);

    // Each session gets its own on-wake message
    expect(mockWriteSessionMessage.mock.calls[0][1]).toBe('s1');
    expect(mockWriteSessionMessage.mock.calls[1][1]).toBe('s2');
  });

  it('wakes even without a wake message when in-flight messages are pending', () => {
    // A provider switch mid-conversation kills a container holding claimed
    // messages — without an immediate respawn those messages stay dark until
    // the next inbound or a slow sweep backoff.
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'ag1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockCountDueMessages.mockReturnValue(2);

    restartAgentGroupContainers('ag1', 'provider switch');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    expect(typeof onExit).toBe('function');
    mockGetSession.mockReturnValue(makeSession('s1', 'ag1'));
    onExit();
    expect(mockWakeContainer).toHaveBeenCalled();
  });
});
