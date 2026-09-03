import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

// Spread the real module: session-manager (now loaded for real, for the
// real-mailbox case) uses more of log.js than the four levels stubbed here.
vi.mock('./log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./log.js')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
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
/** Session rows that exist in the central DB but own no mailbox. */
const missingInboundDbs = new Set<string>();
/** Session mailboxes that exist but are unreadable (present file, no schema). */
const unreadableInboundDbs = new Set<string>();
/** Session ids the seam actually handed a mailbox session back for. */
const openedInboundDbs: string[] = [];
/** Fires before every mailbox open, so a test can reclaim a session mid-loop. */
let beforeInboundOpen: ((sessionId: string) => void) | null = null;
/**
 * Session ids that go through the REAL mailbox seam against a temp DATA_DIR
 * instead of the in-memory model below. The model keeps the engine's control
 * flow (activation failures, reclaimed sessions, drain gating) cheap to
 * express; the exact-generation ack contract is pinned against a real mailbox.
 */
const realMailboxSessions = vi.hoisted(() => new Set<string>());

// DATA_DIR is a per-run temp root: the real-mailbox case provisions actual
// session DBs under it, and nothing here can reach the install's data dir.
const testDataDir = vi.hoisted(() => {
  const nodeFs = require('fs') as typeof import('fs');
  const nodeOs = require('os') as typeof import('os');
  const nodePath = require('path') as typeof import('path');
  return { dir: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'container-restart-data-')) };
});
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  get DATA_DIR() {
    return testDataDir.dir;
  },
}));

// Only the outbound message write is stubbed; the rest of session-manager
// (the nesting guard, the provision/exists split) is the real thing, because
// the real-mailbox case runs through it.
vi.mock('./session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session-manager.js')>()),
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

// Real fs, except that a MODEL session's inbound.db existence is answered from
// the sets above — those sessions have no files on disk. A real-mailbox
// session, and every other path, falls through to the real answer.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const existsSync = ((target: fs.PathLike): boolean => {
    const match = String(target).match(/v2-sessions\/[^/]+\/([^/]+)\/inbound\.db$/);
    if (match && !realMailboxSessions.has(match[1]!)) return !missingInboundDbs.has(match[1]!);
    return real.existsSync(target);
  }) as typeof real.existsSync;
  const asNamespace = real as unknown as { default?: typeof real };
  return { ...real, existsSync, default: { ...(asNamespace.default ?? real), existsSync } };
});

const mockCountDueMessages = vi.fn((_sessionId: string) => 0);
const activeEpochs = new Map<string, { epoch: string; generation: string; state: 'active' | 'released' }>();
const acknowledgedEpochs = new Map<string, string>();
const processingSessions = new Set<string>();
const toolSessions = new Set<string>();
const activationFailures = new Set<string>();
/** Sessions whose rollback release throws — the incident's reclaimed DB. */
const releaseFailures = new Set<string>();
let autoAcknowledgeBarrier = true;
let barrierGeneration = 0;
const mockActivateRepoIngressFence = vi.fn((sessionId: string, epoch: string) => {
  if (activationFailures.has(sessionId)) throw new Error(`activation failed for ${sessionId}`);
  const prior = activeEpochs.get(sessionId);
  const active =
    prior?.state === 'active' && prior.epoch === epoch
      ? prior
      : { epoch, generation: `generation-${++barrierGeneration}`, state: 'active' as const };
  activeEpochs.set(sessionId, active);
  if (autoAcknowledgeBarrier) acknowledgedEpochs.set(sessionId, JSON.stringify([epoch, active.generation]));
  return active;
});
const mockReleaseRepoIngressFence = vi.fn((sessionId: string, epoch: string, generation: string) => {
  if (releaseFailures.has(sessionId)) throw new Error(`release failed for ${sessionId}`);
  const current = activeEpochs.get(sessionId);
  if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
    return { released: false, admittedRows: 0, wakeRequired: false };
  }
  activeEpochs.set(sessionId, { epoch, generation, state: 'released' });
  return { released: true, admittedRows: 0, wakeRequired: mockCountDueMessages(sessionId) > 0 };
});

/** The subset of NanoclawMailboxSession the barrier engine touches. */
function modelMailbox(sessionId: string): NanoclawMailboxSession {
  return {
    readRepoIngressFence: () => activeEpochs.get(sessionId) ?? null,
    activateRepoIngressFence: (epoch: string) => mockActivateRepoIngressFence(sessionId, epoch),
    releaseRepoIngressFence: (epoch: string, generation: string) =>
      mockReleaseRepoIngressFence(sessionId, epoch, generation),
    readRepositoryMountBarrierAck: () => acknowledgedEpochs.get(sessionId) ?? null,
    getProcessingClaimRows: () =>
      processingSessions.has(sessionId) ? [{ message_id: 'late', status_changed: new Date().toISOString() }] : [],
    getContainerState: () => (toolSessions.has(sessionId) ? { current_tool: 'Bash' } : null),
    countDueMessages: () => mockCountDueMessages(sessionId),
  } as unknown as NanoclawMailboxSession;
}

vi.mock('./modules/mailbox/session.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./modules/mailbox/session.js')>();
  const { SessionDbMissingError } = await import('./modules/mailbox/index.js');
  return {
    ...real,
    withExistingNanoclawSession: async (
      agentGroupId: string,
      sessionId: string,
      action: (mailbox: NanoclawMailboxSession) => unknown,
    ) => {
      if (realMailboxSessions.has(sessionId)) return real.withExistingNanoclawSession(agentGroupId, sessionId, action);
      beforeInboundOpen?.(sessionId);
      // The seam reports a vanished session as `undefined`, never as a throw.
      if (missingInboundDbs.has(sessionId)) return undefined;
      if (unreadableInboundDbs.has(sessionId)) throw new Error('no such table: messages_in');
      openedInboundDbs.push(sessionId);
      return action(modelMailbox(sessionId));
    },
    // Referenced only so the unused-import lint stays quiet if the real class
    // is needed by a future case; the engine imports it from the barrel.
    __SessionDbMissingError: SessionDbMissingError,
  };
});

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { getAgentMailbox } from './mailbox/index.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { withMailboxSession } from './session-manager.js';
import {
  quiesceAgentGroupsForRepositoryMounts,
  quiesceSessionsForRepositoryMounts,
  releaseRepositoryMountQuiescence,
  RepositoryMountQuiescenceError,
  restartAgentGroupContainers,
  wakeRepositoryMountSessions,
} from './container-restart.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockIsContainerSpawning.mockReturnValue(false);
  activeEpochs.clear();
  acknowledgedEpochs.clear();
  processingSessions.clear();
  toolSessions.clear();
  activationFailures.clear();
  releaseFailures.clear();
  missingInboundDbs.clear();
  unreadableInboundDbs.clear();
  openedInboundDbs.length = 0;
  beforeInboundOpen = null;
  autoAcknowledgeBarrier = true;
  barrierGeneration = 0;
  mockCountDueMessages.mockReturnValue(0);
  realMailboxSessions.clear();
});

describe('repository mount reconciliation', () => {
  it('activateRepositoryMountBarriers and release run through the mailbox session and keep the exact-generation ack contract', async () => {
    const session = makeSession('s-real', 'ag-real');
    const outboundPath = provisionRealMailbox('ag-real', 's-real');
    mockGetSessionsByAgentGroup.mockReturnValue([session]);
    const running = new Set(['s-real']);
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockIsContainerSpawning.mockReturnValue(false);
    mockKillContainer.mockImplementation((id) => {
      running.delete(id);
    });

    const epoch = 'repository-publish:real-1';
    const pending = quiesceSessionsForRepositoryMounts([session] as never, epoch, 5_000);
    await new Promise((resolve) => setImmediate(resolve));

    // Activation went through a mailbox session and fenced this session's
    // ingress: a row written now is epoch-tagged and inert, so nothing is due.
    const generation = await withMailboxSession('ag-real', 's-real', async (mailbox) => {
      const fork = mailbox as NanoclawMailboxSession;
      await mailbox.insertMessage({
        id: 'behind-the-fence',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: 'held',
        processAfter: null,
        recurrence: null,
      });
      expect(mailbox.countDueMessages()).toBe(0);
      const fence = fork.readRepoIngressFence();
      expect(fence?.state).toBe('active');
      expect(fence?.epoch).toBe(epoch);
      return fence!.generation;
    });

    // A stale-generation ack is NOT a drain — the container is still running
    // and must not be stopped on it.
    writeBarrierAck(outboundPath, JSON.stringify([epoch, 'generation-from-a-previous-barrier']));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(running.has('s-real')).toBe(true);

    // The exact activation token is.
    writeBarrierAck(outboundPath, JSON.stringify([epoch, generation]));
    const quiescence = await pending;
    expect(mockKillContainer).toHaveBeenCalledWith('s-real', 'repository mount set changed', undefined);
    expect(quiescence.barrierSessions.map((entry) => entry.id)).toEqual(['s-real']);
    expect(quiescence.barrierGenerations['s-real']).toBe(generation);
    expect(quiescence.barrierAcks['s-real']).toBe(JSON.stringify([epoch, generation]));

    // Release restores ingress: the row held behind the fence becomes due, and
    // the release reports this session as needing a wake.
    const wake = await releaseRepositoryMountQuiescence(quiescence);
    expect(wake.map((entry) => entry.id)).toEqual(['s-real']);
    await withMailboxSession('ag-real', 's-real', (mailbox) => {
      expect(mailbox.countDueMessages()).toBe(1);
      expect((mailbox as NanoclawMailboxSession).readRepoIngressFence()?.state).toBe('released');
    });
  });

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

    expect(await releaseRepositoryMountQuiescence(quiescence)).toEqual([]);
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
    // Fencing yields to the event loop, so it lands a turn after the call —
    // still strictly before any kill, which is what this test pins.
    await new Promise((resolve) => setImmediate(resolve));
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
    await releaseRepositoryMountQuiescence(quiescence);
  });

  it('returns every stopped or initially-idle session with durable due rows after release', async () => {
    const running = makeSession('s1', 'g1');
    const initiallyIdle = makeSession('s2', 'g1');
    const live = new Set(['s1']);
    mockIsContainerRunning.mockImplementation((id) => live.has(id));
    mockKillContainer.mockImplementation((id) => live.delete(id));
    mockCountDueMessages.mockImplementation((sessionId: string) => (sessionId === 's2' ? 1 : 0));

    const quiescence = await quiesceSessionsForRepositoryMounts(
      [running, initiallyIdle] as never,
      'repository-publish:req-2',
    );
    expect((await releaseRepositoryMountQuiescence(quiescence)).map((session) => session.id)).toEqual(['s2']);
  });

  it('fences around session rows whose inbound database no longer exists', async () => {
    // A reclaimed session directory used to throw out of activation and fail
    // the whole publication permanently. Such a row owns no ingress path, so
    // quiescence must skip it and still fence its live siblings.
    const live = makeSession('s1', 'g1');
    const reclaimed = makeSession('s2', 'g1');
    missingInboundDbs.add('s2');
    const running = new Set(['s1']);
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      running.delete(id);
    });

    const quiescence = await quiesceSessionsForRepositoryMounts(
      [live, reclaimed] as never,
      'repository-publish:req-missing',
    );

    expect(quiescence.barrierSessions.map((session) => session.id)).toEqual(['s1']);
    expect(activeEpochs.get('s1')?.state).toBe('active');
    expect(activeEpochs.has('s2')).toBe(false);
    expect(await releaseRepositoryMountQuiescence(quiescence)).toEqual([]);
    expect(activeEpochs.get('s1')?.state).toBe('released');
  });

  it('skips a session reclaimed between the eligibility filter and its own fence open', async () => {
    // The 2026-09-01 incident, exactly: the reclaim finished AFTER s2 passed
    // hasFenceableIngress and BEFORE its open, so the existsSync filter could
    // not see it. The open used to create an empty inbound.db in a resurrected
    // directory and fail the whole publication; it must now skip s2, fence s1,
    // and leave nothing behind for s2.
    const live = makeSession('s1', 'g1');
    const reclaimedMidLoop = makeSession('s2', 'g1');
    mockIsContainerRunning.mockReturnValue(false);
    beforeInboundOpen = (sessionId) => {
      if (sessionId === 's1') missingInboundDbs.add('s2');
    };

    const quiescence = await quiesceSessionsForRepositoryMounts(
      [live, reclaimedMidLoop] as never,
      'repository-publish:req-toctou',
    );

    expect(quiescence.barrierSessions.map((session) => session.id)).toEqual(['s1']);
    expect(activeEpochs.get('s1')?.state).toBe('active');
    expect(activeEpochs.has('s2')).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      'Repository mount barrier skipped: session inbound DB vanished after eligibility check',
      { sessionId: 's2', agentGroupId: 'g1' },
    );
    // Never opened, so nothing could have recreated its directory. The
    // "creates no file, no directory" half is pinned on the real funnel in
    // src/db/session-db.test.ts.
    expect(openedInboundDbs).not.toContain('s2');

    // Release walks the fenced set only — a skipped session has no generation,
    // and reaching it there would throw on that.
    expect(await releaseRepositoryMountQuiescence(quiescence)).toEqual([]);
    expect(activeEpochs.get('s1')?.state).toBe('released');
  });

  it('still fails closed when a session inbound DB is present but unreadable', async () => {
    // Only a VANISHED session is skippable. A schemaless DB is a real fault:
    // ingress exists and would go unfenced, so the publication must not run.
    const live = makeSession('s1', 'g1');
    const broken = makeSession('s2', 'g1');
    mockIsContainerRunning.mockReturnValue(false);
    unreadableInboundDbs.add('s2');

    await expect(
      quiesceSessionsForRepositoryMounts([live, broken] as never, 'repository-publish:req-schemaless'),
    ).rejects.toThrow(/session s2 .*inbound\.db.*no such table: messages_in/);
    // s1's barrier is rolled back rather than stranded.
    expect(activeEpochs.get('s1')?.state).toBe('released');
  });

  it('refuses to quiesce when a running container has no inbound database to fence', async () => {
    // The stop set is derived before the fenceable filter, so an inconsistent
    // host view fails fast instead of waiting out the full barrier timeout.
    const running = makeSession('s1', 'g1');
    missingInboundDbs.add('s1');
    mockIsContainerRunning.mockImplementation((id) => id === 's1');

    await expect(
      quiesceSessionsForRepositoryMounts([running] as never, 'repository-publish:req-inconsistent'),
    ).rejects.toThrow(/no inbound database to fence: s1/);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('yields to the event loop while fencing a large workgroup', async () => {
    // Fencing commits one fsync per session DB. Without yields a few thousand
    // sessions block every unrelated channel adapter for the whole cycle.
    const sessions = Array.from({ length: 250 }, (_, index) => makeSession(`s${index}`, 'g1'));
    mockIsContainerRunning.mockReturnValue(false);
    let macrotasksObserved = 0;
    const tick = setInterval(() => {
      macrotasksObserved += 1;
    }, 0);

    try {
      const quiescence = await quiesceSessionsForRepositoryMounts([...sessions] as never, 'repository-publish:req-big');
      expect(quiescence.barrierSessions).toHaveLength(250);
      expect(macrotasksObserved).toBeGreaterThan(0);
    } finally {
      clearInterval(tick);
    }
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

  it('hands back the sessions a failed rollback left fenced instead of a bare AggregateError', async () => {
    // Incident 2026-09-01: a partial rollback threw a plain AggregateError, so
    // the caller's `instanceof RepositoryMountQuiescenceError` branch never
    // matched, its `quiescence` stayed null, and no release was ever retried
    // for the sessions still fenced — they stayed active for 2.5 hours.
    const first = makeSession('s1', 'g1');
    const stranded = makeSession('s2', 'g1');
    const failing = makeSession('s3', 'g1');
    activationFailures.add('s3');
    releaseFailures.add('s2');
    mockIsContainerRunning.mockReturnValue(false);

    const error = await quiesceSessionsForRepositoryMounts(
      [first, stranded, failing] as never,
      'repository-publish:req-partial-rollback',
    ).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RepositoryMountQuiescenceError);
    const recovery = error as RepositoryMountQuiescenceError;
    expect(recovery.barriersReleased).toBe(false);
    expect(recovery.quiescence.epoch).toBe('repository-publish:req-partial-rollback');
    expect(recovery.quiescence.barrierSessions.map((session) => session.id)).toEqual(['s2']);
    expect(recovery.quiescence.barrierGenerations.s2).toBeDefined();
    // s1 rolled back cleanly; only s2 is still fenced and needs the retry.
    expect(activeEpochs.get('s1')?.state).toBe('released');
    expect(activeEpochs.get('s2')?.state).toBe('active');
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
    await new Promise((resolve) => setImmediate(resolve));
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
    await releaseRepositoryMountQuiescence(quiescence);
  });

  it('stops barrier-observing containers when the drain wait fails', async () => {
    // A container that observed the barrier has ended its query input stream
    // for good. Leaving it running after a failed quiescence turned every
    // later tool call into a cancellation the agent read as revoked access.
    const session = makeSession('s1', 'g1');
    const running = new Set(['s1']);
    autoAcknowledgeBarrier = false;
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      running.delete(id);
    });

    const error = await quiesceSessionsForRepositoryMounts([session] as never, 'repository-publish:req-stuck', 20).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RepositoryMountQuiescenceError);
    const recovery = error as RepositoryMountQuiescenceError;
    expect(recovery.message).toMatch(/timed out waiting for container poll admission/);
    expect(recovery.barriersReleased).toBe(true);
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'repository mount quiescence failed', undefined);
    expect(activeEpochs.get('s1')?.state).toBe('released');
  });

  it('attaches the exact stopped/due recovery set when post-kill stop proof times out', async () => {
    const first = makeSession('s1', 'g1');
    const stuck = makeSession('s2', 'g1');
    const running = new Set(['s1', 's2']);
    mockIsContainerRunning.mockImplementation((id) => running.has(id));
    mockKillContainer.mockImplementation((id) => {
      if (id === 's1') running.delete(id);
    });
    mockCountDueMessages.mockImplementation((sessionId: string) => (sessionId === 's1' ? 1 : 0));

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

/** Provision a REAL mailbox under the temp DATA_DIR and route the seam to it. */
function provisionRealMailbox(agentGroupId: string, sessionId: string): string {
  fs.mkdirSync(path.join(testDataDir.dir, 'v2-sessions', agentGroupId, sessionId), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId, sessionId });
  realMailboxSessions.add(sessionId);
  return path.join(testDataDir.dir, 'v2-sessions', agentGroupId, sessionId, 'outbound.db');
}

/**
 * Plant the acknowledgement the CONTAINER writes at its poll boundary. Raw,
 * because no host-side op writes it — the host only ever reads it.
 */
function writeBarrierAck(outboundPath: string, token: string): void {
  const db = new Database(outboundPath);
  try {
    db.prepare(
      `INSERT INTO session_state (key, value, updated_at) VALUES ('repository_mount_barrier_ack', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(token, new Date().toISOString());
  } finally {
    db.close();
  }
}

// --- Tests ---

describe('restartAgentGroupContainers', () => {
  // Pre-branch the wake-write was fire-and-forget, so its rejection escaped as
  // an unhandledRejection and the loop always finished. Awaiting it turned that
  // into control flow: the first failure killed the sessions ahead of it and
  // stranded every one behind it, half-restarting the group.
  it('keeps restarting after one session fails, and never kills that session', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([
      makeSession('s1', 'g1'),
      makeSession('s2', 'g1'),
      makeSession('s3', 'g1'),
    ]);
    mockIsContainerRunning.mockReturnValue(true);
    mockWriteSessionMessage.mockImplementation((_ag: string, sessionId: string) =>
      sessionId === 's2' ? Promise.reject(new Error('storage is being reclaimed')) : Promise.resolve(),
    );

    const count = await restartAgentGroupContainers('g1', 'test', 'Resuming.');

    expect(mockKillContainer.mock.calls.map((c) => c[0])).toEqual(['s1', 's3']);
    expect(count).toBe(2);
    expect(log.warn).toHaveBeenCalledWith(
      'Restart: wake message failed; leaving this container running',
      expect.objectContaining({ sessionId: 's2', err: expect.any(Error) }),
    );
    // clearAllMocks keeps implementations; leave the shared mock as found.
    mockWriteSessionMessage.mockReset();
  });

  it('does not count a session whose container exited during the wake write', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    let calls = 0;
    // Running at collection, gone by the time the write returns.
    mockIsContainerRunning.mockImplementation(() => {
      calls += 1;
      return calls < 2;
    });

    const count = await restartAgentGroupContainers('g1', 'test', 'Resuming.');

    expect(count, 'killContainer would no-op, so this is not a restart').toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('keeps going when the pending-work open throws, without killing that container', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    // The funnel now refuses under a reclaim claim, so this open throws for
    // reasons beyond a missing file — and it sits outside the wake-write's
    // try, where it could take the whole loop with it.
    missingInboundDbs.add('s1');

    const count = await restartAgentGroupContainers('g1', 'test', 'Resuming.');

    expect(mockKillContainer.mock.calls.map((c) => c[0])).toEqual(['s2']);
    expect(count).toBe(1);
  });

  it('skips sessions without a running container', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(false);

    const count = await restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('skips non-active sessions', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1', 'closed')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = await restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(0);
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('kills running containers and returns count', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockImplementation((id) => id === 's1');

    const count = await restartAgentGroupContainers('g1', 'test');

    expect(count).toBe(1);
    expect(mockKillContainer).toHaveBeenCalledTimes(1);
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('does not write wake message when wakeMessage is omitted', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    await restartAgentGroupContainers('g1', 'test');

    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    expect(mockKillContainer).toHaveBeenCalledWith('s1', 'test', undefined);
  });

  it('writes on_wake message and passes onExit callback when wakeMessage is provided', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    await restartAgentGroupContainers('g1', 'test', 'Resuming.');

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

  it('onExit callback calls wakeContainer with refreshed session', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    const freshSession = makeSession('s1', 'g1');
    mockGetSession.mockReturnValue(freshSession);

    await restartAgentGroupContainers('g1', 'test', 'Resuming.');

    // Simulate container exit by calling the onExit callback
    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockGetSession).toHaveBeenCalledWith('s1');
    expect(mockWakeContainer).toHaveBeenCalledWith(freshSession);
  });

  it('onExit callback does not wake if session no longer exists', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockGetSession.mockReturnValue(undefined);

    await restartAgentGroupContainers('g1', 'test', 'Resuming.');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    onExit();

    expect(mockWakeContainer).not.toHaveBeenCalled();
  });

  it('handles multiple running sessions with wake message', async () => {
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'g1'), makeSession('s2', 'g1')]);
    mockIsContainerRunning.mockReturnValue(true);

    const count = await restartAgentGroupContainers('g1', 'test', 'Config updated.');

    expect(count).toBe(2);
    expect(mockKillContainer).toHaveBeenCalledTimes(2);
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);

    // Each session gets its own on-wake message
    expect(mockWriteSessionMessage.mock.calls[0][1]).toBe('s1');
    expect(mockWriteSessionMessage.mock.calls[1][1]).toBe('s2');
  });

  it('wakes even without a wake message when in-flight messages are pending', async () => {
    // A provider switch mid-conversation kills a container holding claimed
    // messages — without an immediate respawn those messages stay dark until
    // the next inbound or a slow sweep backoff.
    mockGetSessionsByAgentGroup.mockReturnValue([makeSession('s1', 'ag1')]);
    mockIsContainerRunning.mockReturnValue(true);
    mockCountDueMessages.mockReturnValue(2);

    await restartAgentGroupContainers('ag1', 'provider switch');

    const onExit = mockKillContainer.mock.calls[0][2] as () => void;
    expect(typeof onExit).toBe('function');
    mockGetSession.mockReturnValue(makeSession('s1', 'ag1'));
    onExit();
    expect(mockWakeContainer).toHaveBeenCalled();
  });
});
