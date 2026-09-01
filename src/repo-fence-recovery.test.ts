/**
 * Regression tests for the 2026-09-01 19:10 UTC orphaned-fence incident.
 *
 * A repository publication fenced ~1400 session inbound DBs in one
 * workgroup with the epoch `repository-publish:repo-1788289675241-b13bcab3ec972233`,
 * then failed on a session whose DB had just been reclaimed. Its strict release
 * fails fast, so every session behind that one stayed fenced; delivery retried
 * three times, dropped the message, and 1401 of 1638 session DBs were still
 * `state = 'active'` 2.5 hours later — inbound held at trigger=0, every spawn
 * refused, the whole workgroup silently deaf. These tests pin the recovery that
 * did not exist.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockWakeRepositoryMountSessions = vi.fn();
vi.mock('./container-restart.js', () => ({
  wakeRepositoryMountSessions: (...args: unknown[]) => mockWakeRepositoryMountSessions(...args),
}));

interface TestSession {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
}

const agentGroups = new Map<string, { id: string; folder: string; workgroup_id: string | null }>();
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => agentGroups.get(id),
  getAllAgentGroups: () => [...agentGroups.values()],
}));

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => ({ id, platform_id: `platform-${id}` }),
}));

const sessions: TestSession[] = [];
vi.mock('./db/sessions.js', () => ({
  getActiveSessions: () => sessions.filter((session) => session.status === 'active'),
  getSessionsByAgentGroup: (id: string) => sessions.filter((session) => session.agent_group_id === id),
}));

type Fence = { epoch: string; generation: string; state: 'active' | 'released' };
type MockDb = { sessionId: string; close: () => void };
const fences = new Map<string, Fence>();
const dueMessages = new Map<string, number>();
const closedDbs: string[] = [];

vi.mock('./db/session-db.js', () => ({
  readRepoIngressFence: (db: MockDb) => fences.get(db.sessionId) ?? null,
  countDueMessages: (db: MockDb) => dueMessages.get(db.sessionId) ?? 0,
  releaseRepoIngressFence: (db: MockDb, epoch: string, generation: string) => {
    const current = fences.get(db.sessionId);
    if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
      return { released: false, admittedRows: 0, wakeRequired: false };
    }
    fences.set(db.sessionId, { epoch, generation, state: 'released' });
    // The held rows this epoch tagged become due again on release.
    const held = dueMessages.get(db.sessionId) ?? 0;
    return { released: true, admittedRows: held, wakeRequired: held > 0 };
  },
}));

/** Session rows whose inbound DB was reclaimed out from under the host. */
const unreadableSessions = new Set<string>();
let sessionsRoot = '';
vi.mock('./session-manager.js', () => ({
  inboundDbPath: (agentGroupId: string, sessionId: string) =>
    path.join(sessionsRoot, agentGroupId, sessionId, 'inbound.db'),
  openInboundDb: (_agentGroupId: string, sessionId: string): MockDb => {
    if (unreadableSessions.has(sessionId)) {
      // Exactly what better-sqlite3 throws for a reclaimed session directory.
      throw new TypeError('Cannot open database because the directory does not exist');
    }
    return { sessionId, close: () => closedDbs.push(sessionId) };
  },
}));

import {
  ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS,
  releaseOrphanedRepoIngressFences,
  releaseOrphanedRepoIngressFencesAtStartup,
  releaseOrphanedRepoIngressFencesForDroppedMessage,
  sweepOrphanedRepoIngressFences,
  _resetOrphanedRepoFenceScanForTesting,
} from './repo-fence-recovery.js';
import { withWorkgroupRepositoryMountClaim } from './repository-workspaces.js';

const PUBLISH_EPOCH = 'repository-publish:repo-1788289675241-b13bcab3ec972233';

function addSession(id: string, agentGroupId = 'ag-primary'): TestSession {
  const session: TestSession = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: `mg-${id}`,
    thread_id: null,
    status: 'active',
  };
  sessions.push(session);
  fs.mkdirSync(path.join(sessionsRoot, agentGroupId, id), { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, agentGroupId, id, 'inbound.db'), '');
  return session;
}

function fence(sessionId: string, epoch = PUBLISH_EPOCH, generation = `gen-${sessionId}`): void {
  fences.set(sessionId, { epoch, generation, state: 'active' });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fence-'));
  sessions.length = 0;
  closedDbs.length = 0;
  fences.clear();
  dueMessages.clear();
  unreadableSessions.clear();
  agentGroups.clear();
  agentGroups.set('ag-primary', { id: 'ag-primary', folder: 'wg-a', workgroup_id: 'wg-a' });
  agentGroups.set('ag-sibling', { id: 'ag-sibling', folder: 'sibling', workgroup_id: 'wg-a' });
  _resetOrphanedRepoFenceScanForTesting();
});

afterEach(() => {
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
});

describe('orphaned repository ingress fence recovery (incident 2026-09-01)', () => {
  it('releases a fence whose publication is gone and wakes the session holding its trigger=1 rows', async () => {
    const orphaned = addSession('s-orphaned');
    addSession('s-clean');
    fence(orphaned.id);
    // The rows the fence auto-tagged and held at trigger=0.
    dueMessages.set(orphaned.id, 4);

    const report = await releaseOrphanedRepoIngressFences('test');

    expect(report).toMatchObject({ scanned: 2, active: 1, released: 1, inFlight: 0, failed: 0, woken: 1 });
    expect(fences.get(orphaned.id)?.state).toBe('released');
    expect(mockWakeRepositoryMountSessions).toHaveBeenCalledTimes(1);
    expect(mockWakeRepositoryMountSessions).toHaveBeenCalledWith([orphaned]);
    // Every opened handle is closed — a leaked one makes the session
    // unreclaimable until the next host start.
    expect(closedDbs.sort()).toEqual(['s-clean', 's-orphaned']);
  });

  it('leaves a fence alone while its publication still holds the workgroup mount claim', async () => {
    const inFlight = addSession('s-in-flight');
    fence(inFlight.id);
    dueMessages.set(inFlight.id, 2);

    const report = await withWorkgroupRepositoryMountClaim('wg-a', () => releaseOrphanedRepoIngressFences('test'));

    expect(report).toMatchObject({ active: 1, released: 0, inFlight: 1 });
    expect(fences.get(inFlight.id)?.state).toBe('active');
    expect(mockWakeRepositoryMountSessions).not.toHaveBeenCalled();
  });

  it('releases every active fence at startup, because a fresh process holds no claims', async () => {
    // The incident's own recovery shape: the host restarts, the publication
    // that owned the epoch died with the previous process, and its in-memory
    // claim died with it — so every fence still on disk is orphaned.
    const fenced = ['s1', 's2', 's3'].map((id) => addSession(id));
    for (const session of fenced) fence(session.id);
    dueMessages.set('s2', 1);

    const report = await releaseOrphanedRepoIngressFencesAtStartup();

    expect(report).toMatchObject({ scanned: 3, active: 3, released: 3, inFlight: 0, failed: 0, woken: 0 });
    expect([...fences.values()].every((entry) => entry.state === 'released')).toBe(true);
    // No spawn from inside boot: channel adapters, the delivery polls and
    // resetPhantomContainerStatus all run later in main(). The released rows
    // are due again, and the host sweep's due-message wake picks them up.
    expect(mockWakeRepositoryMountSessions).not.toHaveBeenCalled();
  });

  it('leaves zero active fences for the epoch of a publication the delivery layer gave up on', async () => {
    // 1401 of 1638: activation fenced the whole workgroup, the publication
    // failed, its strict release fail-fast stranded everything behind the one
    // bad session, and delivery dropped the row after three attempts.
    const fenced = ['s1', 's2', 's3'].map((id) => addSession(id));
    const sibling = addSession('s4', 'ag-sibling');
    for (const session of [...fenced, sibling]) fence(session.id);
    unreadableSessions.add('s2');
    dueMessages.set('s3', 7);

    const report = await releaseOrphanedRepoIngressFencesForDroppedMessage({ kind: 'system' }, fenced[0] as never);

    expect(report).toMatchObject({ released: 3, failed: 1, inFlight: 0 });
    const stillActive = [...fences.entries()]
      .filter(([, entry]) => entry.epoch === PUBLISH_EPOCH && entry.state === 'active')
      .map(([id]) => id);
    // Only the session whose DB no longer exists — it has no ingress to fence,
    // and PR #223 stops it being created at all.
    expect(stillActive).toEqual(['s2']);
    expect(mockWakeRepositoryMountSessions).toHaveBeenCalledWith([fenced[2]]);
  });

  it('does not run the workgroup pass for a dropped chat row', async () => {
    const orphaned = addSession('s1');
    fence(orphaned.id);

    expect(await releaseOrphanedRepoIngressFencesForDroppedMessage({ kind: 'chat' }, orphaned as never)).toBeNull();
    expect(fences.get(orphaned.id)?.state).toBe('active');
  });

  it('keeps going past a session whose inbound DB was reclaimed mid-pass', async () => {
    // The failure that started the incident: one unopenable session DB aborted
    // the loop that was supposed to un-fence all the others.
    const first = addSession('s1');
    addSession('s2');
    const last = addSession('s3');
    for (const id of ['s1', 's2', 's3']) fence(id);
    unreadableSessions.add('s2');

    const report = await releaseOrphanedRepoIngressFences('test');

    expect(report).toMatchObject({ scanned: 2, active: 2, released: 2, failed: 1 });
    expect(fences.get(first.id)?.state).toBe('released');
    expect(fences.get('s2')?.state).toBe('active');
    expect(fences.get(last.id)?.state).toBe('released');
  });

  it('bounds the sweep to one full pass per scan interval', async () => {
    const orphaned = addSession('s1');
    fence(orphaned.id);

    const first = await sweepOrphanedRepoIngressFences(sessions as never, 1_000);
    expect(first).toMatchObject({ released: 1 });

    fence(orphaned.id, PUBLISH_EPOCH, 'gen-second');
    expect(await sweepOrphanedRepoIngressFences(sessions as never, 1_000 + 60_000)).toBeNull();
    expect(fences.get(orphaned.id)?.state).toBe('active');

    const later = await sweepOrphanedRepoIngressFences(sessions as never, 1_000 + ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS);
    expect(later).toMatchObject({ released: 1 });
    expect(fences.get(orphaned.id)?.state).toBe('released');
  });

  it('yields to the event loop every 100 sessions so a 1600-session pass cannot freeze the host', async () => {
    for (let i = 0; i < 250; i += 1) addSession(`s${i}`);
    let macrotasks = 0;
    const tick = setInterval(() => {
      macrotasks += 1;
    }, 1);
    try {
      await releaseOrphanedRepoIngressFences('test');
      expect(macrotasks).toBeGreaterThan(0);
    } finally {
      clearInterval(tick);
    }
  });
});
