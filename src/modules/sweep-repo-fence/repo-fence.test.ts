/**
 * S2-PR8 — repo fence + approvals scan (G08): T5 `approvals-reason-sweep`,
 * T22 `orphaned-repo-fence-release` (plan.md §8 F-8.1..F-8.3).
 *
 * F-8.1 and F-8.2 are the 9 cases ported unchanged (import-path updates only)
 * from `src/repo-fence-recovery.test.ts` — the source module itself does NOT
 * move here (see index.ts's header comment: `src/main.ts` and
 * `src/delivery.ts` / `src/modules/repository-workspaces/job-runner.ts` also
 * import it directly, both outside this family PR's ownership boundary), so
 * only the wrapper this file's sibling `index.ts` now owns moved; the test
 * for the underlying `repo-fence-recovery.ts` module moves with it because
 * every case in it is exercising that module's contract, which this duty is
 * the periodic (and only fully-automatic) caller of.
 *
 * F-8.3 is ported from `src/modules/approvals/reason-capture.test.ts`'s
 * `describe('reject-with-reason host sweep', ...)`. That file drives
 * `sweepAwaitingReasonRejects` against the REAL central DB (`initTestDb`) and
 * a real delivery adapter fake — a fixture style that cannot share a test
 * file with this suite's fully-mocked `db/sessions.js` / mailbox-session
 * seam (two `vi.mock` factories for the same module in one file is not
 * expressible; whichever runs last wins for every test in the file). The
 * scenario is ported here as an equivalent lightweight mock of
 * `getExpiredAwaitingReasonApprovals` / `getSession` / `deletePendingApproval`
 * / `finalizeReject`, consistent with this file's existing style — a REWRITE,
 * not a verbatim move; the original describe block is deliberately left in
 * place in `reason-capture.test.ts` (out of this family PR's ownership, and
 * its own `armReasonCapture` / `captureReasonReply` coverage in that file is
 * unrelated to this duty).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Spread the real module: `importOriginal` on the mailbox session seam below
// pulls in session-manager, which uses more of log.js than these four levels.
vi.mock('../../log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../log.js')>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

/**
 * Hermeticity HARD RULE (brief-common.md step 2). Neither duty body this file
 * exercises has any legitimate reason to shell out — reused from
 * `src/host-sweep-registry.test.ts`'s tripwire factory.
 */
const spawns: string[] = vi.hoisted(() => [] as string[]);
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`repo-fence.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}
vi.mock('child_process', () => childProcessTripwire(spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawns));

const mockWakeRepositoryMountSessions = vi.fn();
vi.mock('../../container-restart.js', () => ({
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

const sessions: TestSession[] = [];
/** F-8.2: counts every call, across both describe blocks, so a regression that
 *  makes the duty re-query sessions itself instead of reusing `ctx.sessions`
 *  cannot slip past a fresh-suite reset. */
const getActiveSessionsCalls = { count: 0 };

interface ApprovalRow {
  approval_id: string;
  session_id: string | null;
  expires_at: string;
}
const awaitingReasonApprovals: ApprovalRow[] = [];
const deletedApprovalIds: string[] = [];
const finalizeRejectCalls: Array<{ approvalId: string; sessionId: string; userId: string; reason?: string }> = [];

vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => agentGroups.get(id),
  getAllAgentGroups: () => [...agentGroups.values()],
}));

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (id: string) => ({ id, platform_id: `platform-${id}` }),
}));

vi.mock('../../db/sessions.js', () => ({
  getActiveSessions: () => {
    getActiveSessionsCalls.count += 1;
    return sessions.filter((session) => session.status === 'active');
  },
  getSessionsByAgentGroup: (id: string) => sessions.filter((session) => session.agent_group_id === id),
  // F-8.3's fakes — only what `sweepAwaitingReasonRejects` reads.
  getExpiredAwaitingReasonApprovals: (nowIso: string) =>
    awaitingReasonApprovals.filter((row) => row.expires_at <= nowIso),
  getSession: (id: string) => sessions.find((session) => session.id === id),
  deletePendingApproval: (approvalId: string) => {
    deletedApprovalIds.push(approvalId);
  },
}));

vi.mock('../approvals/finalize.js', () => ({
  finalizeReject: (approval: ApprovalRow, session: TestSession, userId: string, reason?: string) => {
    finalizeRejectCalls.push({ approvalId: approval.approval_id, sessionId: session.id, userId, reason });
  },
}));

type Fence = { epoch: string; generation: string; state: 'active' | 'released' };
const fences = new Map<string, Fence>();
const dueMessages = new Map<string, number>();
/** Session ids the recovery pass actually opened a mailbox session for. */
const openedSessions: string[] = [];

/** Sessions that are PRESENT but unopenable — EACCES, EMFILE, a corrupt file. */
const unreadableSessions = new Set<string>();
/** Sessions whose mailbox is genuinely gone (ENOENT/ENOTDIR). */
const missingDbSessions = new Set<string>();
let sessionsRoot = '';

/**
 * The subset of the fork mailbox session this pass touches, modelled in memory.
 *
 * The pass now goes through `withExistingMailboxSession`, so the seam is what
 * this suite substitutes — the raw open funnel it used to mock no longer has a
 * caller here.
 */
function modelMailbox(sessionId: string) {
  return {
    readRepoIngressFence: () => fences.get(sessionId) ?? null,
    countDueMessages: () => dueMessages.get(sessionId) ?? 0,
    releaseRepoIngressFence: (epoch: string, generation: string) => {
      const current = fences.get(sessionId);
      if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
        return { released: false, admittedRows: 0, wakeRequired: false };
      }
      fences.set(sessionId, { epoch, generation, state: 'released' });
      // The held rows this epoch tagged become due again on release.
      const held = dueMessages.get(sessionId) ?? 0;
      return { released: true, admittedRows: held, wakeRequired: held > 0 };
    },
  };
}

vi.mock('../../session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session-manager.js')>()),
  withExistingMailboxSession: async (
    _agentGroupId: string,
    sessionId: string,
    action: (mailbox: unknown) => unknown,
  ) => {
    // A vanished session resolves undefined — the seam never throws for it.
    if (missingDbSessions.has(sessionId)) return undefined;
    // Present but unopenable — must stay visible, never counted fence-free.
    if (unreadableSessions.has(sessionId)) throw new Error('SQLITE_CANTOPEN: unable to open database file');
    openedSessions.push(sessionId);
    return action(modelMailbox(sessionId));
  },
}));

import {
  ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS,
  releaseOrphanedRepoIngressFences,
  releaseOrphanedRepoIngressFencesAtStartup,
  releaseOrphanedRepoIngressFencesForDroppedMessage,
  sweepOrphanedRepoIngressFences,
  _resetOrphanedRepoFenceScanForTesting,
} from '../../repo-fence-recovery.js';
import * as repoFenceRecoveryModule from '../../repo-fence-recovery.js';
import { withWorkgroupRepositoryMountClaim } from '../../repository-workspaces.js';
import { sweepAwaitingReasonRejects } from '../approvals/reason-capture.js';
import * as reasonCaptureModule from '../approvals/reason-capture.js';
import { log } from '../../log.js';
// Side effect: registers this family's two duties via registerSweepDutySource
// (see ./index.ts) so `_listSweepRegistrationsForTesting()` below finds them —
// they are no longer inline in host-sweep.ts's own built-ins.
import './index.js';
import { SWEEP_DUTY_INVENTORY, _listSweepRegistrationsForTesting, type SweepTickContext } from '../../host-sweep.js';

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
  openedSessions.length = 0;
  fences.clear();
  dueMessages.clear();
  unreadableSessions.clear();
  missingDbSessions.clear();
  agentGroups.clear();
  agentGroups.set('ag-primary', { id: 'ag-primary', folder: 'wg-a', workgroup_id: 'wg-a' });
  agentGroups.set('ag-sibling', { id: 'ag-sibling', folder: 'sibling', workgroup_id: 'wg-a' });
  getActiveSessionsCalls.count = 0;
  awaitingReasonApprovals.length = 0;
  deletedApprovalIds.length = 0;
  finalizeRejectCalls.length = 0;
  _resetOrphanedRepoFenceScanForTesting();
});

afterEach(() => {
  fs.rmSync(sessionsRoot, { recursive: true, force: true });
  // Hermeticity HARD RULE step 2 — every test here runs a duty body.
  expect(spawns).toEqual([]);
  spawns.length = 0;
});

describe('orphaned fences whose publication is gone are released and their sessions woken after the loop', () => {
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
    expect(openedSessions.sort()).toEqual(['s-clean', 's-orphaned']);
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

  it('skips a session whose inbound DB is genuinely gone without calling it a failure', async () => {
    // PR #223's funnel is the classifier: ENOENT/ENOTDIR means gone, and a
    // session with no inbound DB has no fence — ordinary, not a fault. A
    // present-but-unopenable session (EACCES, EMFILE) stays visible instead.
    const orphaned = addSession('s1');
    addSession('s2');
    addSession('s3');
    fence(orphaned.id);
    missingDbSessions.add('s2');
    unreadableSessions.add('s3');

    const report = await releaseOrphanedRepoIngressFences('test');

    expect(report).toMatchObject({ scanned: 1, active: 1, released: 1, failed: 1 });
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
    // A competing setImmediate chain, not a wall-clock timer: the pass yields
    // with setImmediate, so this counts queue turns it actually conceded and
    // stays deterministic when the machine is saturated by a full parallel run.
    let macrotasks = 0;
    let stop = false;
    const chain = (): void => {
      if (stop) return;
      macrotasks += 1;
      setImmediate(chain);
    };
    setImmediate(chain);
    try {
      await releaseOrphanedRepoIngressFences('test');
      // 250 sessions → yields at index 100 and index 200.
      expect(macrotasks).toBeGreaterThanOrEqual(2);
    } finally {
      stop = true;
    }
  });
});

// ── F-8.2 ─────────────────────────────────────────────────────────────────────
it("the fence scan keeps its 5-minute internal throttle and reuses the tick's session list", async () => {
  const orphaned = addSession('s1');
  fence(orphaned.id);

  const first = await sweepOrphanedRepoIngressFences(sessions as never, 1_000);
  expect(first).toMatchObject({ released: 1 });

  fence(orphaned.id, PUBLISH_EPOCH, 'gen-second');
  const throttled = await sweepOrphanedRepoIngressFences(sessions as never, 1_000 + 60_000);
  expect(throttled).toBeNull();
  expect(fences.get(orphaned.id)?.state).toBe('active');

  const later = await sweepOrphanedRepoIngressFences(sessions as never, 1_000 + ORPHANED_REPO_FENCE_SCAN_INTERVAL_MS);
  expect(later).toMatchObject({ released: 1 });

  // The duty passes `ctx.sessions` straight through (constraint 4) — the
  // scan never re-queries the central DB itself, on either the throttled or
  // the real pass.
  expect(getActiveSessionsCalls.count).toBe(0);
});

/**
 * Codex review (efb8350a..10ada631, medium, accepted): the case above calls
 * `sweepOrphanedRepoIngressFences` directly, so the registered T22 wrapper —
 * the `registerSweepDuty({ name: id.T22, run: (ctx) => {...} })` block in
 * `./index.ts` that actually forwards `ctx.sessions` and owns the try/catch —
 * is never executed, making the "no extra getActiveSessions call" assertion
 * vacuous. These drive the wrapper itself, found by name via the same
 * registry accessor R-7 uses.
 */
function findRegisteredDuty(name: string) {
  const { duties } = _listSweepRegistrationsForTesting();
  const duty = duties.find((d) => d.name === name);
  if (!duty) throw new Error(`duty ${name} is not registered`);
  return duty;
}

function fakeTickCtx(tickSessions: TestSession[]): SweepTickContext {
  return {
    now: Date.now(),
    sessions: tickSessions as never,
    activeContainerSessionIds: new Set<string>(),
  } as unknown as SweepTickContext;
}

describe('the T22 registered wrapper', () => {
  it('forwards ctx.sessions untouched (never calls getActiveSessions) and keeps the 5-minute throttle across two runs', async () => {
    const t22 = findRegisteredDuty(SWEEP_DUTY_INVENTORY.T22);
    // Present on disk and fenced, but deliberately NOT pushed into the global
    // `sessions` array `getActiveSessions()` reads from — if the wrapper ever
    // fell back to re-querying instead of forwarding `ctx.sessions`, this
    // session would never be found and nothing would be released.
    const sentinel: TestSession = {
      id: 'sentinel-1',
      agent_group_id: 'ag-primary',
      messaging_group_id: 'mg-sentinel-1',
      thread_id: null,
      status: 'active',
    };
    fs.mkdirSync(path.join(sessionsRoot, sentinel.agent_group_id, sentinel.id), { recursive: true });
    fs.writeFileSync(path.join(sessionsRoot, sentinel.agent_group_id, sentinel.id, 'inbound.db'), '');
    fence(sentinel.id);

    await t22.run(fakeTickCtx([sentinel]) as never);

    expect(getActiveSessionsCalls.count).toBe(0);
    expect(openedSessions).toEqual(['sentinel-1']);
    expect(fences.get(sentinel.id)?.state).toBe('released');

    // Second run, moments later (well inside the 5-minute window) — a fresh
    // "active" fence on the same session must NOT be released; the wrapper
    // calls `sweepOrphanedRepoIngressFences(ctx.sessions)` with no explicit
    // clock argument, so this exercises the throttle against real wall time.
    openedSessions.length = 0;
    fence(sentinel.id, PUBLISH_EPOCH, 'gen-second');
    await t22.run(fakeTickCtx([sentinel]) as never);

    expect(openedSessions).toEqual([]);
    expect(fences.get(sentinel.id)?.state).toBe('active');
    expect(getActiveSessionsCalls.count).toBe(0);
  });

  it('logs "Orphaned repository fence sweep step failed" and does not throw when the scan itself throws', async () => {
    const t22 = findRegisteredDuty(SWEEP_DUTY_INVENTORY.T22);
    const spy = vi
      .spyOn(repoFenceRecoveryModule, 'sweepOrphanedRepoIngressFences')
      .mockRejectedValueOnce(new Error('boom'));
    try {
      await expect(t22.run(fakeTickCtx([]) as never)).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalledWith(
        'Orphaned repository fence sweep step failed',
        expect.objectContaining({ err: expect.any(Error) }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── F-8.3 ─────────────────────────────────────────────────────────────────────
describe('the approvals reason-reject scan finalizes elapsed holds', () => {
  it('finalizes a hold whose window elapsed as a plain reject', async () => {
    const session = addSession('s-hold');
    awaitingReasonApprovals.push({
      approval_id: 'appr-1',
      session_id: session.id,
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    await sweepAwaitingReasonRejects();

    expect(finalizeRejectCalls).toEqual([
      { approvalId: 'appr-1', sessionId: session.id, userId: '', reason: undefined },
    ]);
    expect(deletedApprovalIds).toEqual([]);
  });

  it('leaves a still-open hold untouched', async () => {
    const session = addSession('s-hold-open');
    // Not expired: `getExpiredAwaitingReasonApprovals` is the real function's
    // own filter, so a hold whose window hasn't elapsed is never returned to
    // the sweep in the first place.
    awaitingReasonApprovals.push({
      approval_id: 'appr-2',
      session_id: session.id,
      expires_at: '2999-01-01T00:00:00.000Z',
    });

    await sweepAwaitingReasonRejects();

    expect(finalizeRejectCalls).toEqual([]);
    expect(deletedApprovalIds).toEqual([]);
  });
});

/**
 * Codex review (efb8350a..10ada631, medium, accepted): the describe above
 * calls `sweepAwaitingReasonRejects` directly, so the registered T5 wrapper —
 * the `registerSweepDuty({ name: id.T5, run: async () => {...} })` block in
 * `./index.ts` that dynamically imports `../approvals/index.js` inside a
 * try/catch — is never executed. These drive the wrapper itself.
 */
describe('the T5 registered wrapper', () => {
  it('reaches the approvals finalizer through its own dynamic import', async () => {
    const t5 = findRegisteredDuty(SWEEP_DUTY_INVENTORY.T5);
    const session = addSession('s-wrapper-hold');
    awaitingReasonApprovals.push({
      approval_id: 'appr-wrapper',
      session_id: session.id,
      expires_at: '2026-01-01T00:00:00.000Z',
    });

    await t5.run(fakeTickCtx([]) as never);

    expect(finalizeRejectCalls).toEqual([
      { approvalId: 'appr-wrapper', sessionId: session.id, userId: '', reason: undefined },
    ]);
  });

  it('logs "Reject-with-reason sweep failed" and does not throw when the scan itself throws', async () => {
    const t5 = findRegisteredDuty(SWEEP_DUTY_INVENTORY.T5);
    const spy = vi.spyOn(reasonCaptureModule, 'sweepAwaitingReasonRejects').mockRejectedValueOnce(new Error('boom'));
    try {
      await expect(t5.run(fakeTickCtx([]) as never)).resolves.toBeUndefined();
      expect(log.error).toHaveBeenCalledWith(
        'Reject-with-reason sweep failed',
        expect.objectContaining({ err: expect.any(Error) }),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Tripwire self-check (brief-common.md HARD RULE step 3) ─────────────────
it('the child_process tripwire bites when a seam mock is removed', () => {
  const record: string[] = [];
  const tripwire = childProcessTripwire(record);
  expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
  expect(record).toEqual(['execSync']);
});
