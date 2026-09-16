import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    TIMEZONE: 'UTC',
  };
});

// A hook that fires INSIDE each mailbox acquisition, numbered, so a test can
// act in the window the async funnel opened between two passes over the same
// session. Real implementation otherwise.
const onMailboxAcquire = vi.hoisted(() => ({ run: null as ((call: number) => void | Promise<void>) | null, calls: 0 }));
vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      onMailboxAcquire.calls += 1;
      // Awaited: the hook reads the session list through the async central
      // leaf now, and the whole point is that its mutation lands BEFORE the
      // session opens, not somewhere in the middle of the action.
      await onMailboxAcquire.run?.(onMailboxAcquire.calls);
      return real.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-cli-tasks') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getRawDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { resolveGroupProvider } from '../../container-config.js';
import { auditTaskPins, formatStrandedPins, formatLateStrandedPins } from '../../modules/scheduling/pin-audit.js';
import { validateTaskPin } from '../../modules/scheduling/task-flags.js';
import { createSession, findSessionByAgentGroup, getSessionsByAgentGroup, taskThreadId } from '../../db/sessions.js';
import { countDueMessages } from '../../modules/mailbox/ops/sweep.js';
import { initSessionFolder } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { dispatch } from '../dispatch.js';
import { parseArgv } from '../parse-argv.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';
import './tasks.js';
import './groups.js'; // registers groups-config-update for the provider-migration tests
import '../commands/index.js'; // registers tasks-help for the help-topic test

function now(): string {
  return new Date().toISOString();
}

async function createGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

async function createChatSession(group: string, id: string): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

/** A session wired to a real messaging group — the shape a channel session actually has. */
async function createMgSession(group: string, id: string, mgId: string, threadId: string | null = null): Promise<void> {
  await createSession({
    id,
    agent_group_id: group,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder(group, id);
}

async function createMg(id: string, channelType = 'slack', platformId = 'C123'): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: 'general',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
}

function agentCtx(group = 'ag-1', session = 'chat-1'): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: session, messagingGroupId: 'mg-1' };
}

// Admission takes a mailbox SESSION now (mailbox seam PR 7). The fixtures keep
// their own handle on the same file for assertions; session DBs are
// journal_mode=DELETE, so the committed rows are visible on it afterwards.
async function admitDueTaskContexts(agentGroupId: string, sessionId: string): Promise<number> {
  const module = await import('../../session-manager.js');
  return (
    (await module.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
      module.admitDueTaskContexts(mailbox, agentGroupId, sessionId),
    )) ?? 0
  );
}

describe('tasks CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    await createGroup('ag-1');
    await createGroup('ag-2');
    await createChatSession('ag-1', 'chat-1');
    await createChatSession('ag-2', 'chat-2');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('rejects a move from an agent caller before it can inspect task state', async () => {
    const result = await dispatch(
      {
        id: 'agent-move',
        command: 'tasks-move',
        args: {
          id: 'series-1',
          group: 'ag-1',
          session: 'sess-1',
          target_group: 'ag-2',
          target_messaging_group: 'mg-2',
        },
      },
      agentCtx(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('agent task move unexpectedly succeeded');
    expect(result.error?.code).toBe('forbidden');
  });

  it("computes an unscoped --process-after in EACH matched group's timezone", async () => {
    // An unscoped host `tasks update` fans out across every active session,
    // which can span groups whose timezone overrides differ. Computing the
    // instant once from whichever group matched first would write one group's
    // wall-clock reading onto another group's series.
    await createGroup('ag-tokyo');
    await createGroup('ag-kolkata');
    await ensureContainerConfig('ag-tokyo');
    await ensureContainerConfig('ag-kolkata');
    await updateContainerConfigScalars('ag-tokyo', { timezone: 'Asia/Tokyo' }); // UTC+9, no DST
    await updateContainerConfigScalars('ag-kolkata', { timezone: 'Asia/Kolkata' }); // UTC+5:30, no DST

    const made: Record<string, { series_id: string; session_id: string }> = {};
    for (const group of ['ag-tokyo', 'ag-kolkata']) {
      const resp = await dispatch(
        {
          id: `create-${group}`,
          command: 'tasks-create',
          args: { group, prompt: 'digest', name: 'digest', process_after: '2026-01-15T09:00:00Z' },
        },
        { caller: 'host' },
      );
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      made[group] = resp.data as { series_id: string; session_id: string };
    }

    // Force a shared series id so one unscoped update matches both groups —
    // the exact collision the fan-out has to survive.
    const sharedId = made['ag-tokyo'].series_id;
    const kolkataDb = new Database(inboundDbPath('ag-kolkata', made['ag-kolkata'].session_id));
    kolkataDb.prepare('UPDATE messages_in SET id = ?, series_id = ? WHERE kind = ?').run(sharedId, sharedId, 'task');
    kolkataDb.close();

    const updated = await dispatch(
      { id: 'tz-fanout', command: 'tasks-update', args: { id: sharedId, process_after: '2026-10-01T09:00:00' } },
      { caller: 'host' },
    );
    expect(updated.ok).toBe(true);

    const processAfterOf = (group: string): string => {
      const db = new Database(inboundDbPath(group, made[group].session_id), { readonly: true });
      const row = db.prepare("SELECT process_after FROM messages_in WHERE kind = 'task'").get() as {
        process_after: string;
      };
      db.close();
      return row.process_after;
    };

    // 09:00 local: Tokyo is UTC+9, Kolkata UTC+5:30. One shared value for both
    // would mean the fan-out used a single group's zone.
    expect(processAfterOf('ag-tokyo')).toBe('2026-10-01T00:00:00.000Z');
    expect(processAfterOf('ag-kolkata')).toBe('2026-10-01T03:30:00.000Z');
  });

  it('enforces the recurrence ceiling in EVERY matched timezone, not a representative one', async () => {
    // The ceiling counts fires in a rolling 24h window, and that count is
    // zone-dependent when a cron's fires cluster on one weekday. Pinned clock:
    // Monday 2026-01-05T00:00:00Z, cron "0 19,20,21,22,23 * * 1".
    //   Asia/Tokyo (+9)      → local Mon 09:00; window catches all 5 fires.
    //   Pacific/Honolulu (-10) → local Sun 14:00; window ends before any fire.
    // Validating only the first match would let the 5-fire cron through.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T00:00:00.000Z'));
    try {
      await createGroup('ag-honolulu');
      await createGroup('ag-tokyo-cap');
      await ensureContainerConfig('ag-honolulu');
      await ensureContainerConfig('ag-tokyo-cap');
      await updateContainerConfigScalars('ag-honolulu', { timezone: 'Pacific/Honolulu' });
      await updateContainerConfigScalars('ag-tokyo-cap', { timezone: 'Asia/Tokyo' });

      const made: Record<string, { series_id: string; session_id: string }> = {};
      // Honolulu first: it is the permissive zone, so it is what a
      // first-match-wins validator would have used.
      for (const group of ['ag-honolulu', 'ag-tokyo-cap']) {
        const r = await dispatch(
          {
            id: `cap-create-${group}`,
            command: 'tasks-create',
            args: { group, prompt: 'digest', name: 'capped', process_after: '2999-01-01T00:00:00Z' },
          },
          { caller: 'host' },
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        made[group] = r.data as { series_id: string; session_id: string };
      }
      const sharedId = made['ag-honolulu'].series_id;
      const tdb = new Database(inboundDbPath('ag-tokyo-cap', made['ag-tokyo-cap'].session_id));
      tdb.prepare('UPDATE messages_in SET id = ?, series_id = ? WHERE kind = ?').run(sharedId, sharedId, 'task');
      tdb.close();

      const updated = await dispatch(
        { id: 'cap-update', command: 'tasks-update', args: { id: sharedId, recurrence: '0 19,20,21,22,23 * * 1' } },
        { caller: 'host' },
      );
      expect(updated.ok).toBe(false);

      // Rejected before any write: neither series took the new cron.
      for (const group of ['ag-honolulu', 'ag-tokyo-cap']) {
        const db = new Database(inboundDbPath(group, made[group].session_id), { readonly: true });
        const row = db.prepare("SELECT recurrence FROM messages_in WHERE kind = 'task'").get() as {
          recurrence: string | null;
        };
        db.close();
        expect(row.recurrence).toBeNull();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes a same-id terminal row in another session from an unscoped update's validation set", async () => {
    // selectTask() prioritizes a live row but falls back to terminal
    // (completed/cancelled) history when a session has none for the matched
    // id — right for getTask and the audit before/after lookups, wrong for
    // the unscoped-update validation set, which must cover exactly the rows
    // updateTask() can actually mutate. Left unfiltered, a scriptless
    // terminal row in one session could subject a SCRIPTED live task in
    // another session to the (script-exempt) recurrence ceiling.
    await createGroup('ag-terminal-a');
    await createGroup('ag-terminal-b');

    const a = await dispatch(
      {
        id: 'create-a',
        command: 'tasks-create',
        args: {
          group: 'ag-terminal-a',
          prompt: 'digest',
          name: 'scripted',
          process_after: '2026-01-15T09:00:00Z',
          script: 'echo \'{"wakeAgent": false}\'',
        },
      },
      { caller: 'host' },
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const { series_id: sharedId, session_id: sessionA } = a.data as { series_id: string; session_id: string };

    const b = await dispatch(
      {
        id: 'create-b',
        command: 'tasks-create',
        args: { group: 'ag-terminal-b', prompt: 'digest', name: 'scriptless', process_after: '2026-01-15T09:00:00Z' },
      },
      { caller: 'host' },
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const { session_id: sessionB } = b.data as { series_id: string; session_id: string };

    // Force the same series id onto B's row, then terminate it — the exact
    // shape selectTask()'s live-first fallback exists for.
    const bDb = new Database(inboundDbPath('ag-terminal-b', sessionB));
    bDb
      .prepare("UPDATE messages_in SET id = ?, series_id = ?, status = 'cancelled' WHERE kind = ?")
      .run(sharedId, sharedId, 'task');
    bDb.close();

    // Every 5 minutes comfortably exceeds the 4-fire/24h ceiling in any zone:
    // rejected if B's scriptless terminal row is (wrongly) validated,
    // accepted if it's excluded — A's own row IS scripted, so A is exempt.
    const updated = await dispatch(
      { id: 'terminal-exclude', command: 'tasks-update', args: { id: sharedId, recurrence: '*/5 * * * *' } },
      { caller: 'host' },
    );
    expect(updated.ok).toBe(true);

    const aDb = new Database(inboundDbPath('ag-terminal-a', sessionA), { readonly: true });
    const row = aDb.prepare("SELECT recurrence FROM messages_in WHERE kind = 'task'").get() as {
      recurrence: string | null;
    };
    aDb.close();
    expect(row.recurrence).toBe('*/5 * * * *');
  });

  it('create writes the task into the group system session, not the caller chat session', async () => {
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'tasks-create',
        args: { prompt: 'send a briefing', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const created = resp.data as { series_id: string; session_id: string; status: string };
    expect(created.status).toBe('pending');
    expect(created.session_id).not.toBe('chat-1');

    // The task lands in its own isolated per-series session, not the chat session.
    const sessions = await getSessionsByAgentGroup('ag-1');
    const taskSession = sessions.find((s) => s.id === created.session_id);
    expect(taskSession?.thread_id).toBe(taskThreadId(created.series_id));

    const chatDb = new Database(inboundDbPath('ag-1', 'chat-1'), { readonly: true });
    expect(chatDb.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({
      count: 0,
    });
    chatDb.close();

    const systemDb = new Database(inboundDbPath('ag-1', created.session_id), { readonly: true });
    const row = systemDb.prepare("SELECT id, content, trigger FROM messages_in WHERE kind = 'task'").get() as {
      id: string;
      content: string;
      trigger: number;
    };
    const content = JSON.parse(row.content);
    expect(content).toMatchObject({ originSessionId: 'chat-1' });
    expect(content.prompt).toBe('send a briefing');
    expect(content.prompt).not.toContain('Task delivery contract');
    expect(row.trigger).toBe(0);
    expect(systemDb.prepare('SELECT id FROM messages_in WHERE id = ?').get(`recall-${row.id}`)).toBeUndefined();
    systemDb.close();
  });

  // Codex round 2, H1 (b). `ncl tasks` writes due-ness straight into the
  // session DB, where the host sweep's quiet cache cannot see it, so every
  // mutating command brackets its write with `withQuietInvalidationSync`.
  // Fail-closed: a central DB that refuses the invalidation must refuse the
  // command, not land a task row behind a mark nothing will clear. (What the
  // bracket does on each side is asserted on real SQLite in
  // src/db/migrations/068-sessions-sweep-quiet-until.test.ts.)
  it('create writes nothing when the quiet-mark invalidation fails', async () => {
    const sessionsModule = await import('../../db/sessions.js');
    const spy = vi.spyOn(sessionsModule, 'withQuietInvalidationSync').mockImplementation((id: string) => {
      throw new sessionsModule.QuietInvalidationError(id, new Error('central DB is read-only'));
    });

    const resp = await dispatch(
      {
        id: 'req-faulted',
        command: 'tasks-create',
        args: { prompt: 'should not land', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );
    spy.mockRestore();

    expect(resp.ok, 'a refused invalidation reported success').toBe(false);
    if (resp.ok) return;
    expect(resp.error.message).toMatch(/quiet-mark invalidation failed/);

    // The per-series session was resolved (and its inbound.db provisioned)
    // before the bracket, so an empty mailbox is the abort, not a missing
    // session.
    const taskSessions = (await getSessionsByAgentGroup('ag-1')).filter((sess) =>
      sess.thread_id?.startsWith('system:tasks'),
    );
    expect(taskSessions).toHaveLength(1);
    const db = new Database(inboundDbPath('ag-1', taskSessions[0]!.id), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages_in WHERE kind = 'task'").get()).toEqual({ count: 0 });
    db.close();
  });

  // The narrowing the probe buys (lead review, 2026-09-04): a group-scoped
  // mutation visits every session `selectedSessions` returns, and wrapping the
  // per-session OPEN would charge 2N central-DB writes plus N spurious sweeps
  // for one series. The probe means only the session that holds the row is
  // invalidated.
  it('pause invalidates only the session that holds the series', async () => {
    const created = await dispatch(
      {
        id: 'req-narrow-create',
        command: 'tasks-create',
        args: { prompt: 'the only series', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { series_id: seriesId, session_id: holder } = created.data as { series_id: string; session_id: string };

    // A second task session in the same group, holding a different series — it
    // is in the fan-out and must be left alone.
    const other = await dispatch(
      {
        id: 'req-narrow-other',
        command: 'tasks-create',
        args: { prompt: 'a different series', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const bystander = (other.data as { session_id: string }).session_id;
    expect(bystander).not.toBe(holder);

    const sessionsModule = await import('../../db/sessions.js');
    const original = sessionsModule.withQuietInvalidationSync;
    const invalidated: string[] = [];
    const spy = vi
      .spyOn(sessionsModule, 'withQuietInvalidationSync')
      .mockImplementation(<T>(id: string, write: () => T) => {
        invalidated.push(id);
        return original(id, write);
      });

    const resp = await dispatch(
      { id: 'req-narrow-pause', command: 'tasks-pause', args: { id: seriesId, group: 'ag-1' } },
      agentCtx(),
    );
    spy.mockRestore();

    expect(resp.ok).toBe(true);
    expect(invalidated, 'the fan-out invalidated a session that does not hold the series').toEqual([holder]);
  });

  it('create and update persist quiet-status independently from the chat budget', async () => {
    const resp = await dispatch(
      {
        id: 'quiet-create',
        command: 'tasks-create',
        args: {
          prompt: 'publish one consolidated verdict',
          process_after: '2026-01-15T09:00:00Z',
          quiet_status: true,
          chat_limit: '1',
        },
      },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    const created = resp.data as { series_id: string; session_id: string };
    const db = new Database(inboundDbPath('ag-1', created.session_id));
    const before = JSON.parse(
      (db.prepare("SELECT content FROM messages_in WHERE kind = 'task'").get() as { content: string }).content,
    ) as Record<string, unknown>;
    expect(before).toMatchObject({ quietStatus: true, chatLimit: 1 });
    db.close();

    const updated = await dispatch(
      {
        id: 'quiet-update',
        command: 'tasks-update',
        args: { id: created.series_id, quiet_status: false },
      },
      agentCtx(),
    );
    expect(updated.ok).toBe(true);

    const updatedDb = new Database(inboundDbPath('ag-1', created.session_id), { readonly: true });
    const after = JSON.parse(
      (updatedDb.prepare("SELECT content FROM messages_in WHERE kind = 'task'").get() as { content: string }).content,
    ) as Record<string, unknown>;
    expect(after).toMatchObject({ quietStatus: false, chatLimit: 1 });
    updatedDb.close();
  });

  it('tasks-list attaches a server-rendered human table (so the container agent gets it too)', async () => {
    await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'briefing', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx(),
    );
    const resp = await dispatch({ id: 'l', command: 'tasks-list', args: {} }, agentCtx());
    expect(resp.ok).toBe(true);
    if (!resp.ok) return;
    // Red-on-delete guard for the dispatch wiring: the host renders format-tasks
    // once and ships it as `human`, so the Bun container prints the aligned
    // table instead of a raw column dump (it cannot import the host formatter).
    expect(resp.human).toBeDefined();
    expect(resp.human).toMatch(/SERIES\s+SCHEDULE\s+RUNS\s+FAILED\s+LAST RUN\s+NEXT RUN/);
    expect(resp.human).toContain('briefing-');
  });

  it('recurrence more frequent than 4x/day is refused with the quota warning', async () => {
    const resp = await dispatch(
      { id: 'c', command: 'tasks-create', args: { prompt: 'x', name: 'spam', recurrence: '*/2 * * * *' } },
      agentCtx(),
    );
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('this task has not been scheduled');
      expect(resp.error.message).toContain('ncl tasks create --help');
      expect(resp.error.message).toContain('--dangerously-override-recurrence-limit');
    }
  });

  it('exactly 4 fires/day passes; the override flag bypasses the limit', async () => {
    const four = await dispatch(
      { id: 'c4', command: 'tasks-create', args: { prompt: 'x', name: 'four', recurrence: '0 0,6,12,18 * * *' } },
      agentCtx(),
    );
    expect(four.ok).toBe(true);

    const overridden = await dispatch(
      {
        id: 'co',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'fast', recurrence: '*/30 * * * *', dangerously_override_recurrence_limit: true },
      },
      agentCtx(),
    );
    expect(overridden.ok).toBe(true);
  });

  it('update rejects an empty --prompt instead of blanking the series', async () => {
    // A wired channel session, so the create actually stamps routing and the
    // "nothing was touched" assertion below has something real to check.
    await createMg('mg-1');
    await createMgSession('ag-1', 'chan-1', 'mg-1');
    const created = await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'keep me', name: 'blank-guard', recurrence: '0 9 * * *' },
      },
      agentCtx('ag-1', 'chan-1'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;
    expect((created.data as { routed: unknown }).routed).toEqual({
      channel_type: 'slack',
      platform_id: 'C123',
      thread_id: null,
    });

    for (const prompt of ['', '   \n']) {
      const upd = await dispatch(
        { id: 'u', command: 'tasks-update', args: { id: seriesId, prompt } },
        agentCtx('ag-1', 'chan-1'),
      );
      expect(upd.ok).toBe(false);
      if (!upd.ok) expect(upd.error.message).toContain('--prompt must not be empty');
    }

    // The row is untouched: prompt intact AND the routing stamp the fork
    // writes at create time still on it, so a refused update cannot strand a
    // series with no delivery target.
    const got = await dispatch({ id: 'g', command: 'tasks-get', args: { id: seriesId } }, agentCtx('ag-1', 'chan-1'));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect((got.data as { prompt: string }).prompt).toBe('keep me');
    expect((got.data as { routed: unknown }).routed).toEqual({
      channel_type: 'slack',
      platform_id: 'C123',
      thread_id: null,
    });
  });

  it('update still accepts a non-empty prompt and a whitespace-padded one', async () => {
    const created = await dispatch(
      { id: 'c2', command: 'tasks-create', args: { prompt: 'before', name: 'blank-ok', recurrence: '0 9 * * *' } },
      agentCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;

    const upd = await dispatch(
      { id: 'u2', command: 'tasks-update', args: { id: seriesId, prompt: '  after  ' } },
      agentCtx(),
    );
    expect(upd.ok).toBe(true);

    const got = await dispatch({ id: 'g2', command: 'tasks-get', args: { id: seriesId } }, agentCtx());
    expect(got.ok).toBe(true);
    // Stored verbatim — the guard only rejects, it never trims what it accepts.
    if (got.ok) expect((got.data as { prompt: string }).prompt).toBe('  after  ');
  });

  it('a --script gate exempts frequent recurrence — the sanctioned monitor pattern', async () => {
    const scripted = await dispatch(
      {
        id: 'cs',
        command: 'tasks-create',
        args: {
          prompt: 'triage queue',
          name: 'watch',
          recurrence: '*/10 * * * *',
          script: 'echo {"wakeAgent": false}',
        },
      },
      agentCtx(),
    );
    expect(scripted.ok).toBe(true);

    // update --recurrence on a task that already has a script: also exempt.
    if (!scripted.ok) return;
    const seriesId = (scripted.data as { series_id: string }).series_id;
    const upd = await dispatch(
      { id: 'us', command: 'tasks-update', args: { id: seriesId, recurrence: '*/5 * * * *' } },
      agentCtx(),
    );
    expect(upd.ok).toBe(true);

    // …but clearing the script in the same update re-arms the guard.
    const cleared = await dispatch(
      { id: 'uc', command: 'tasks-update', args: { id: seriesId, recurrence: '*/5 * * * *', script: 'none' } },
      agentCtx(),
    );
    expect(cleared.ok).toBe(false);
  });

  // The script exemption is decided from a row read in one mailbox pass and
  // applied to a write in a LATER one. Opening a mailbox yields, so between
  // the two another caller can clear the script that exempted the frequent
  // cron — and the pre-seam code, which read and wrote in one synchronous
  // run, had no such window. `tasks update` makes exactly two acquisitions:
  // the match read, then the write. This clears the script in between.
  it('a script cleared between the match read and the write re-arms the recurrence ceiling', async () => {
    const scripted = await dispatch(
      {
        id: 'cr',
        command: 'tasks-create',
        args: { prompt: 'triage', name: 'racer', recurrence: '*/10 * * * *', script: 'echo hi' },
      },
      agentCtx(),
    );
    expect(scripted.ok).toBe(true);
    if (!scripted.ok) return;
    const seriesId = (scripted.data as { series_id: string }).series_id;

    onMailboxAcquire.calls = 0;
    onMailboxAcquire.run = async (call) => {
      if (call !== 2) return; // 1 is the match read; act just before the write
      const sess = (await getSessionsByAgentGroup('ag-1')).find((x) => x.thread_id === taskThreadId(seriesId));
      const db = new Database(inboundDbPath('ag-1', sess!.id));
      const row = db
        .prepare("SELECT id, content FROM messages_in WHERE series_id = ? AND kind = 'task'")
        .get(seriesId) as {
        id: string;
        content: string;
      };
      const content = JSON.parse(row.content) as Record<string, unknown>;
      delete content.script;
      db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(content), row.id);
      db.close();
    };

    const upd = await dispatch(
      { id: 'ur', command: 'tasks-update', args: { id: seriesId, recurrence: '*/5 * * * *' } },
      agentCtx(),
    );
    onMailboxAcquire.run = null;

    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.message).toMatch(/has not been scheduled/);
  });

  it('--script-host round-trips through create, update, and get', async () => {
    const created = await dispatch(
      {
        id: 'ch',
        command: 'tasks-create',
        args: {
          prompt: 'triage queue',
          name: 'host-gated',
          group: 'ag-1',
          recurrence: '*/10 * * * *',
          script: 'echo {"wakeAgent": false}',
          script_host: true,
        },
      },
      // Host ctx: agents can no longer SET --script-host (trust boundary,
      // see the dedicated describe below); clearing it stays agent-allowed.
      { caller: 'host' },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;
    expect((created.data as { script_host: number }).script_host).toBe(1);

    const got = await dispatch({ id: 'gh', command: 'tasks-get', args: { id: seriesId } }, agentCtx());
    expect(got.ok).toBe(true);
    if (got.ok) expect((got.data as { script_host: number }).script_host).toBe(1);

    const cleared = await dispatch(
      { id: 'uh', command: 'tasks-update', args: { id: seriesId, script_host: false } },
      agentCtx(),
    );
    expect(cleared.ok).toBe(true);
    const gotAfter = await dispatch({ id: 'gh2', command: 'tasks-get', args: { id: seriesId } }, agentCtx());
    expect(gotAfter.ok).toBe(true);
    if (gotAfter.ok) expect((gotAfter.data as { script_host: number }).script_host).toBe(0);
  });

  it('--script-host without --script is refused on create and on update', async () => {
    const created = await dispatch(
      { id: 'ns', command: 'tasks-create', args: { prompt: 'x', name: 'no-script', script_host: true, group: 'ag-1' } },
      { caller: 'host' },
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain('--script-host requires --script');

    const withScript = await dispatch(
      {
        id: 'ws',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'has-script', process_after: '2999-01-01T00:00:00Z', script: 'echo ok' },
      },
      agentCtx(),
    );
    expect(withScript.ok).toBe(true);
    if (!withScript.ok) return;
    const seriesId = (withScript.data as { series_id: string }).series_id;

    const badUpdate = await dispatch(
      { id: 'bu', command: 'tasks-update', args: { id: seriesId, script_host: true, script: 'none', group: 'ag-1' } },
      { caller: 'host' },
    );
    expect(badUpdate.ok).toBe(false);
    if (!badUpdate.ok) expect(badUpdate.error.message).toContain('--script-host requires --script');
  });

  it('--thread-anchor false round-trips through create, update, and get', async () => {
    const created = await dispatch(
      {
        id: 'ta1',
        command: 'tasks-create',
        args: {
          prompt: 'one root per smoke run',
          name: 'per-item-threads',
          process_after: '2999-01-01T00:00:00Z',
          thread_anchor: false,
        },
      },
      agentCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;
    expect((created.data as { thread_anchor: number }).thread_anchor).toBe(0);

    // Default (flag omitted) is anchored.
    const plain = await dispatch(
      {
        id: 'ta2',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'anchored', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx(),
    );
    expect(plain.ok).toBe(true);
    if (plain.ok) expect((plain.data as { thread_anchor: number }).thread_anchor).toBe(1);

    // Update flips it back on.
    const updated = await dispatch(
      { id: 'ta3', command: 'tasks-update', args: { id: seriesId, thread_anchor: true } },
      agentCtx(),
    );
    expect(updated.ok).toBe(true);
    const got = await dispatch({ id: 'ta4', command: 'tasks-get', args: { id: seriesId } }, agentCtx());
    expect(got.ok).toBe(true);
    if (got.ok) expect((got.data as { thread_anchor: number }).thread_anchor).toBe(1);
  });

  it('agents cannot set --script-host, change a host-flagged script, and can only clear the flag', async () => {
    // Agent tries to SET the flag on create → refused.
    const agentCreate = await dispatch(
      {
        id: 'ac',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'agent-host', script: 'echo ok', script_host: true },
      },
      agentCtx(),
    );
    expect(agentCreate.ok).toBe(false);
    if (!agentCreate.ok) expect(agentCreate.error.message).toContain('host operator');

    // Host creates a host-flagged series.
    const hostCreate = await dispatch(
      {
        id: 'hc',
        command: 'tasks-create',
        args: {
          prompt: 'x',
          name: 'host-flagged',
          group: 'ag-1',
          process_after: '2999-01-01T00:00:00Z',
          script: 'echo {"wakeAgent": false}',
          script_host: true,
        },
      },
      { caller: 'host' },
    );
    expect(hostCreate.ok).toBe(true);
    if (!hostCreate.ok) return;
    const seriesId = (hostCreate.data as { series_id: string }).series_id;

    // Agent tries to SET the flag on update → refused.
    const agentSet = await dispatch(
      { id: 'as', command: 'tasks-update', args: { id: seriesId, script_host: true } },
      agentCtx(),
    );
    expect(agentSet.ok).toBe(false);
    if (!agentSet.ok) expect(agentSet.error.message).toContain('host operator');

    // Agent tries to swap the SCRIPT on a host-flagged series → refused
    // (its script text would run on the host next fire).
    const agentScript = await dispatch(
      { id: 'asc', command: 'tasks-update', args: { id: seriesId, script: 'echo pwned' } },
      agentCtx(),
    );
    expect(agentScript.ok).toBe(false);
    if (!agentScript.ok) expect(agentScript.error.message).toContain('operator must make script changes');

    // Agent clearing the flag (with or without a script change) → allowed;
    // execution moves back to the container, which is strictly safer.
    const agentClear = await dispatch(
      { id: 'acl', command: 'tasks-update', args: { id: seriesId, script_host: false, script: 'echo fine' } },
      agentCtx(),
    );
    expect(agentClear.ok).toBe(true);
    const gotAfter = await dispatch({ id: 'gac', command: 'tasks-get', args: { id: seriesId } }, agentCtx());
    expect(gotAfter.ok).toBe(true);
    if (gotAfter.ok) expect((gotAfter.data as { script_host: number }).script_host).toBe(0);
  });

  it('the limit also guards update --recurrence (no create-slow-then-update bypass)', async () => {
    const created = await dispatch(
      { id: 'c', command: 'tasks-create', args: { prompt: 'x', name: 'sneak', recurrence: '0 9 * * *' } },
      agentCtx(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const seriesId = (created.data as { series_id: string }).series_id;

    const upd = await dispatch(
      { id: 'u', command: 'tasks-update', args: { id: seriesId, recurrence: '* * * * *' } },
      agentCtx(),
    );
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.message).toContain('this task has not been scheduled');
  });

  it('tasks create --help carries the script contract and the frequency-limit caveat', async () => {
    // --help and `tasks help create` render the same deep verb help.
    const resp = await dispatch({ id: 'h', command: 'tasks-create', args: { help: true } }, agentCtx());
    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const text = resp.data as string;
      expect(text).toContain('wakeAgent');
      expect(text).toContain('Frequency limit');
    }
  });

  it('agent-shared lookup skips the task system session', async () => {
    await dispatch(
      {
        id: 'req-1',
        command: 'tasks-create',
        args: { prompt: 'send a briefing', process_after: '2026-01-15T09:00:00Z' },
      },
      agentCtx(),
    );

    expect((await findSessionByAgentGroup('ag-1'))?.id).toBe('chat-1');
  });

  it('group-scoped agents cannot list tasks from another group session', async () => {
    const resp = await dispatch(
      { id: 'req-1', command: 'tasks-list', args: { session: 'chat-2' } },
      agentCtx('ag-1', 'chat-1'),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('--name yields a short, readable, fs/thread-safe id', async () => {
    const r = await dispatch(
      {
        id: 'rn',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'Morning Joke!!', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = (r.data as { series_id: string }).series_id;
    expect(id).toMatch(/^morning-joke-[0-9a-f]{4}$/);
    expect(id).toMatch(/^[a-z0-9-]+$/); // safe as thread suffix / filename / --id
  });

  it('no name yields a t-<hex> id', async () => {
    const r = await dispatch(
      { id: 'rnn', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { series_id: string }).series_id).toMatch(/^t-[0-9a-f]{6}$/);
  });

  it('recurring create derives the first run from the cron grid when --process-after is omitted', async () => {
    const r = await dispatch(
      { id: 'rec', command: 'tasks-create', args: { prompt: 'x', name: 'nightly', recurrence: '0 9 * * 1-5' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = r.data as { process_after: string; recurrence: string };
    expect(task.recurrence).toBe('0 9 * * 1-5');
    // First fire snapped onto the cron grid (TIMEZONE=UTC in this suite).
    const firstRun = new Date(task.process_after);
    expect(Number.isNaN(firstRun.getTime())).toBe(false);
    expect(firstRun.getUTCHours()).toBe(9);
    expect(firstRun.getTime()).toBeGreaterThan(Date.now());
  });

  it('one-shot create still requires --process-after (nothing to derive it from)', async () => {
    const r = await dispatch(
      { id: 'os', command: 'tasks-create', args: { prompt: 'x', name: 'once' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('--process-after is required');
  });

  it('run queues an extra immediate occurrence without consuming the scheduled one', async () => {
    const created = await dispatch(
      {
        id: 'c',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'pingable', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { series_id, session_id } = created.data as { series_id: string; session_id: string };

    const run = await dispatch({ id: 'r', command: 'tasks-run', args: { id: series_id } }, agentCtx('ag-1', 'chat-1'));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const fired = run.data as { series_id: string; row_id: string; status: string };
    expect(fired.series_id).toBe(series_id);
    expect(fired.row_id).not.toBe(series_id);
    expect(fired.status).toBe('pending');

    const dbPath = inboundDbPath('ag-1', session_id);
    const db = new Database(dbPath);
    const pending = db
      .prepare(
        "SELECT id, recurrence, process_after, trigger FROM messages_in WHERE kind = 'task' AND status = 'pending' AND series_id = ?",
      )
      .all(series_id) as Array<{ id: string; recurrence: string | null; process_after: string; trigger: number }>;
    // Original scheduled row + the new run-now occurrence both still pending.
    expect(pending).toHaveLength(2);
    const runRow = pending.find((p) => p.id === fired.row_id);
    expect(runRow?.recurrence).toBeNull(); // never re-armed into a phantom series
    expect(new Date(runRow!.process_after).getTime()).toBeLessThanOrEqual(Date.now());
    expect(runRow?.trigger).toBe(0);

    const memoryRoot = `${TEST_DIR}/workgroups/ag-1/memory`;
    fs.mkdirSync(`${memoryRoot}/system`, { recursive: true });
    fs.writeFileSync(`${memoryRoot}/index.md`, '# Current canon\nrun-now memory written after scheduling');
    fs.writeFileSync(`${memoryRoot}/system/definition.md`, '# Definition\nfresh context at admission');

    expect(await admitDueTaskContexts('ag-1', session_id)).toBe(1);
    const pair = db
      .prepare('SELECT id, seq, kind, trigger, content FROM messages_in WHERE id IN (?, ?) ORDER BY seq')
      .all(`recall-${fired.row_id}`, fired.row_id) as Array<{
      id: string;
      seq: number;
      kind: string;
      trigger: number;
      content: string;
    }>;
    expect(pair.map((row) => row.id)).toEqual([`recall-${fired.row_id}`, fired.row_id]);
    expect(pair[1]!.seq - pair[0]!.seq).toBe(2);
    expect(pair[0]).toMatchObject({ kind: 'system', trigger: 0 });
    expect(pair[1]).toMatchObject({ kind: 'task', trigger: 1 });
    const recall = JSON.parse(pair[0]!.content);
    expect(recall).toMatchObject({
      subtype: 'recall_context',
      trustedCapabilities: { agentGroupId: 'ag-1' },
    });
    expect(recall.trustedCapabilities.services).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Exa' })]),
    );
    expect(JSON.stringify(recall.memoryEvidence)).toContain('run-now memory written after scheduling');
    expect(await admitDueTaskContexts('ag-1', session_id)).toBe(0);
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM messages_in WHERE id IN (?, ?)')
          .get(`recall-${fired.row_id}`, fired.row_id) as { count: number }
      ).count,
    ).toBe(2);
    db.close();
  });

  it('task object exposes origin_session_id and created_at', async () => {
    const r = await dispatch(
      {
        id: 'ro',
        command: 'tasks-create',
        args: { prompt: 'x', name: 'o', process_after: '2999-01-01T00:00:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.data as { origin_session_id: string | null; created_at: string };
    expect(d.origin_session_id).toBe('chat-1'); // the session that created it
    expect(d.created_at).toBeTruthy();
  });

  it('each task gets its own isolated session, and list fans out across them', async () => {
    const a = await dispatch(
      { id: 'r-a', command: 'tasks-create', args: { prompt: 'task A', process_after: '2026-01-15T09:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    const b = await dispatch(
      { id: 'r-b', command: 'tasks-create', args: { prompt: 'task B', process_after: '2026-01-15T09:00:00Z' } },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const ta = a.data as { session_id: string; series_id: string };
    const tb = b.data as { session_id: string; series_id: string };

    // Distinct per-series sessions — not one shared system:tasks session.
    expect(ta.session_id).not.toBe(tb.session_id);

    // list (no --session) fans out across every task session in the group.
    const list = await dispatch({ id: 'r-l', command: 'tasks-list', args: {} }, agentCtx('ag-1', 'chat-1'));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = (list.data as Array<{ series_id: string }>).map((t) => t.series_id);
    expect(ids).toContain(ta.series_id);
    expect(ids).toContain(tb.series_id);
  });

  it('list enriches each series with run history (CronJob view)', async () => {
    const created = await dispatch(
      {
        id: 'r-agg',
        command: 'tasks-create',
        args: { prompt: 'brain digest', recurrence: '0 9 * * *', 'process-after': '2026-01-15T09:05:00Z' },
      },
      agentCtx('ag-1', 'chat-1'),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { session_id, series_id } = created.data as { session_id: string; series_id: string };

    // Seed three completed fires for this series into its own session inbound.db.
    const db = new Database(inboundDbPath('ag-1', session_id));
    const ins = db.prepare(
      'INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content, series_id, process_after) ' +
        "VALUES (?, ?, datetime('now'), 'completed', 0, 'task', '{}', ?, ?)",
    );
    ins.run('run-1', 100, series_id, '2026-01-15T09:02:00Z');
    ins.run('run-2', 102, series_id, '2026-01-15T09:03:00Z');
    ins.run('run-3', 104, series_id, '2026-01-15T09:04:00Z');
    db.close();

    const list = await dispatch({ id: 'r-agg-l', command: 'tasks-list', args: {} }, agentCtx('ag-1', 'chat-1'));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const row = (list.data as Array<Record<string, unknown>>).find((t) => t.series_id === series_id);
    expect(row).toBeDefined();
    expect(row?.runs).toBe(3);
    // max completed process_after, normalized to canonical ISO by upstream's
    // getTaskStats — the fixture wrote a second-precision stamp; every stamp
    // the host actually writes is already `.000Z`-shaped.
    expect(row?.last_run).toBe('2026-01-15T09:04:00.000Z');
    expect(String(row?.next_run)).toMatch(/^2026-01-15T09:05:00/); // the live pending occurrence
    expect(row?.schedule).toBe('0 9 * * *');
    expect(row?.log).toBe(`tasks/${series_id}.md`);
  });

  // The schedule→admit→wake primitive without a container: a task created
  // through the real `ncl tasks create` path is inert until the host sweep
  // injects fresh context, then the normal due-message query sees it.
  describe('a due task becomes wakeable only after fresh context admission', () => {
    it('countDueMessages sees an admitted past task and ignores a future one', async () => {
      const created = await dispatch(
        { id: 'r-due', command: 'tasks-create', args: { prompt: 'run me', 'process-after': '2020-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const systemId = (created.data as { session_id: string }).session_id;

      const dueDb = new Database(inboundDbPath('ag-1', systemId));
      expect(countDueMessages(dueDb)).toBe(0);
      expect(await admitDueTaskContexts('ag-1', systemId)).toBe(1);
      expect(countDueMessages(dueDb)).toBe(1); // host sweep would wake this session
      dueDb.close();

      // A far-future task in the same system session is not yet due.
      const future = await dispatch(
        { id: 'r-fut', command: 'tasks-create', args: { prompt: 'later', 'process-after': '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(future.ok).toBe(true);

      const stillDb = new Database(inboundDbPath('ag-1', systemId), { readonly: true });
      expect(countDueMessages(stillDb)).toBe(1); // still just the one past task
      stillDb.close();
    });
  });

  describe('append-log', () => {
    const logFile = (folder: string, series: string) => `${TEST_DIR}/groups/${folder}/tasks/${series}.md`;

    it('writes a host-timestamped line to the run log and creates the file (explicit --id)', async () => {
      const resp = await dispatch(
        { id: 'al-1', command: 'tasks-append-log', args: { id: 'my-task-1', msg: 'did the thing; it worked' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      const content = fs.readFileSync(logFile('ag-1', 'my-task-1'), 'utf8').trim();
      // Local-time stamp (formatLocalStamp): "YYYY-MM-DD HH:mm".
      expect(content).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} — did the thing; it worked$/);
    });

    it('derives the series from the caller task session when --id is omitted', async () => {
      const created = await dispatch(
        {
          id: 'al-c',
          command: 'tasks-create',
          args: { name: 'derive-me', prompt: 'x', 'process-after': '2999-01-01T00:00:00Z' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id, session_id } = created.data as { series_id: string; session_id: string };

      // The fire runs INSIDE that task session, so no --id is needed.
      const resp = await dispatch(
        { id: 'al-2', command: 'tasks-append-log', args: { msg: 'auto-derived run' } },
        agentCtx('ag-1', session_id),
      );
      expect(resp.ok).toBe(true);
      if (!resp.ok) return;
      expect((resp.data as { series: string }).series).toBe(series_id);
      expect(fs.readFileSync(logFile('ag-1', series_id), 'utf8')).toContain('auto-derived run');
    });

    it('requires --msg', async () => {
      const resp = await dispatch(
        { id: 'al-3', command: 'tasks-append-log', args: { id: 'my-task-1' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('--msg is required');
    });

    it('errors when there is no --id and the caller is not in a task session', async () => {
      // chat-1 is a normal chat session, not system:tasks:* → nothing to derive.
      const resp = await dispatch(
        { id: 'al-4', command: 'tasks-append-log', args: { msg: 'orphan' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toMatch(/--id is required/);
    });
  });

  describe('routing stamped at create', () => {
    it('an agent caller from a plain chat session (no messaging group) stamps nothing', async () => {
      const r = await dispatch(
        { id: 'r1', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'), // chat-1 has messaging_group_id: null
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { routed: unknown }).routed).toBeNull();
    });

    it("default stamps the calling session's own channel, thread null", async () => {
      await createMg('mg-1');
      await createMgSession('ag-1', 'chan-1', 'mg-1');
      const r = await dispatch(
        { id: 'r2', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chan-1'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(
        (r.data as { routed: { channel_type: string; platform_id: string; thread_id: string | null } }).routed,
      ).toEqual({ channel_type: 'slack', platform_id: 'C123', thread_id: null });

      // Migration 056: the same routing lands on the task SESSION as well as
      // the task row, so the console can place the task in the channel it is
      // routed to. `messaging_group_id` must stay NULL — it is delivery.ts's
      // task-session discriminator (`task_log` appends, `isTaskSessionPost`).
      const session = getRawDb()
        .prepare(
          `SELECT messaging_group_id, task_routing_platform_id FROM sessions
            WHERE agent_group_id = 'ag-1' AND thread_id LIKE 'system:tasks:%'`,
        )
        .get() as { messaging_group_id: string | null; task_routing_platform_id: string | null };
      expect(session.task_routing_platform_id).toBe('C123');
      expect(session.messaging_group_id).toBeNull();
    });

    it('an --isolated task stamps nothing on its session either', async () => {
      // Absent is honest: an isolated series has no destination, so the console
      // leaves it in the "Unrouted tasks" bucket rather than inventing one.
      await createMg('mg-1');
      await createMgSession('ag-1', 'chan-iso', 'mg-1');
      const r = await dispatch(
        {
          id: 'r2b',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', isolated: true },
        },
        agentCtx('ag-1', 'chan-iso'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const session = getRawDb()
        .prepare(
          `SELECT messaging_group_id, task_routing_platform_id FROM sessions
            WHERE agent_group_id = 'ag-1' AND thread_id LIKE 'system:tasks:%'`,
        )
        .get() as { messaging_group_id: string | null; task_routing_platform_id: string | null };
      expect(session.task_routing_platform_id).toBeNull();
      expect(session.messaging_group_id).toBeNull();
    });

    it("--thread additionally binds the calling session's own thread", async () => {
      await createMg('mg-1');
      await createMgSession('ag-1', 'thread-1', 'mg-1', 'thread-xyz');
      const r = await dispatch(
        {
          id: 'r3',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', thread: true },
        },
        agentCtx('ag-1', 'thread-1'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { routed: { thread_id: string | null }; routing_note?: string };
      expect(data.routed.thread_id).toBe('thread-xyz');
      expect(data.routing_note).toBeUndefined();
    });

    it('--thread from a non-thread session falls back to channel-only with a note', async () => {
      await createMg('mg-1');
      await createMgSession('ag-1', 'chan-2', 'mg-1'); // channel-root session, no thread_id
      const r = await dispatch(
        {
          id: 'r4',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', thread: true },
        },
        agentCtx('ag-1', 'chan-2'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const data = r.data as { routed: { thread_id: string | null }; routing_note?: string };
      expect(data.routed.thread_id).toBeNull();
      expect(data.routing_note).toMatch(/non-thread session/);
    });

    it('--isolated stamps nothing even from a messaging-group-wired session', async () => {
      await createMg('mg-1');
      await createMgSession('ag-1', 'chan-3', 'mg-1');
      const r = await dispatch(
        {
          id: 'r5',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', isolated: true },
        },
        agentCtx('ag-1', 'chan-3'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { routed: unknown }).routed).toBeNull();
    });

    it('an agent caller passing --messaging-group is rejected', async () => {
      const r = await dispatch(
        {
          id: 'r6',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', messaging_group: 'mg-1' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('host-only');
    });

    it('an agent caller passing --thread-id is rejected', async () => {
      const r = await dispatch(
        {
          id: 'r7',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', thread_id: 'some-thread' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('host-only');
    });

    it('a host caller stamps routing only via --messaging-group/--thread-id, never implicitly', async () => {
      await createMg('mg-1');
      const bare = await dispatch(
        {
          id: 'r8',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', group: 'ag-1' },
        },
        { caller: 'host' },
      );
      expect(bare.ok).toBe(true);
      if (bare.ok) expect((bare.data as { routed: unknown }).routed).toBeNull();

      const stamped = await dispatch(
        {
          id: 'r9',
          command: 'tasks-create',
          args: {
            prompt: 'x',
            process_after: '2999-01-01T00:00:00Z',
            group: 'ag-1',
            messaging_group: 'mg-1',
            thread_id: 'host-thread',
          },
        },
        { caller: 'host' },
      );
      expect(stamped.ok).toBe(true);
      if (!stamped.ok) return;
      expect((stamped.data as { routed: { thread_id: string } }).routed).toEqual({
        channel_type: 'slack',
        platform_id: 'C123',
        thread_id: 'host-thread',
      });
    });

    it('--thread-id without --messaging-group is rejected for a host caller', async () => {
      const r = await dispatch(
        {
          id: 'r10',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', group: 'ag-1', thread_id: 'x' },
        },
        { caller: 'host' },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('--messaging-group');
    });

    it('run copies routing forward from the source row', async () => {
      await createMg('mg-1');
      await createMgSession('ag-1', 'chan-4', 'mg-1');
      const created = await dispatch(
        { id: 'r11', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chan-4'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id, session_id } = created.data as { series_id: string; session_id: string };

      const run = await dispatch(
        { id: 'r12', command: 'tasks-run', args: { id: series_id } },
        agentCtx('ag-1', 'chan-4'),
      );
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      const { row_id } = run.data as { row_id: string };

      const db = new Database(inboundDbPath('ag-1', session_id), { readonly: true });
      const row = db
        .prepare('SELECT platform_id, channel_type, thread_id FROM messages_in WHERE id = ?')
        .get(row_id) as { platform_id: string; channel_type: string; thread_id: string | null };
      db.close();
      expect(row).toEqual({ platform_id: 'C123', channel_type: 'slack', thread_id: null });
    });
  });

  describe('--model/--effort per-fire pin', () => {
    it('create validates and lands the pin in content.flagIntent', async () => {
      const r = await dispatch(
        {
          id: 'f1',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', model: 'sonnet', effort: 'low' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { session_id, series_id } = r.data as { session_id: string; series_id: string };
      const db = new Database(inboundDbPath('ag-1', session_id), { readonly: true });
      const row = db.prepare("SELECT content FROM messages_in WHERE kind = 'task' AND id = ?").get(series_id) as {
        content: string;
      };
      db.close();
      const content = JSON.parse(row.content);
      expect(content.flagIntent).toEqual({ turnModel: 'sonnet', turnEffort: 'low' });
    });

    it('create rejects an unknown model', async () => {
      const r = await dispatch(
        {
          id: 'f2',
          command: 'tasks-create',
          args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', model: 'gpt-5.5' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain('unknown model');
    });

    it('update merges flagIntent — a model-only update keeps a prior effort pin', async () => {
      const created = await dispatch(
        {
          id: 'f3',
          command: 'tasks-create',
          args: { prompt: 'x', name: 'pin', process_after: '2999-01-01T00:00:00Z', effort: 'low' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id, session_id } = created.data as { series_id: string; session_id: string };

      const upd = await dispatch(
        { id: 'f4', command: 'tasks-update', args: { id: series_id, model: 'sonnet', group: 'ag-1' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(upd.ok).toBe(true);

      const db = new Database(inboundDbPath('ag-1', session_id), { readonly: true });
      const row = db.prepare("SELECT content FROM messages_in WHERE kind = 'task' AND id = ?").get(series_id) as {
        content: string;
      };
      db.close();
      const content = JSON.parse(row.content);
      expect(content.flagIntent).toEqual({ turnModel: 'sonnet', turnEffort: 'low' });
    });

    // #842: before this, a pinned series could only be re-pinned, never
    // unpinned — `--model ""` answered "nothing to update" and `--model null`
    // was rejected by the vocabulary validator.
    describe('clearing a pin (#842)', () => {
      async function pinnedSeries(id: string, pin: Record<string, string>) {
        const created = await dispatch(
          {
            id,
            command: 'tasks-create',
            args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z', ...pin },
          },
          agentCtx('ag-1', 'chat-1'),
        );
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('create failed');
        return created.data as { session_id: string; series_id: string };
      }

      function storedContent(sessionId: string, seriesId: string) {
        const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
        const row = db.prepare("SELECT content FROM messages_in WHERE kind = 'task' AND id = ?").get(seriesId) as {
          content: string;
        };
        db.close();
        return JSON.parse(row.content) as Record<string, unknown>;
      }

      it.each(['', 'null', 'none'])('--model %o --effort %o drops the envelope key entirely', async (clear) => {
        const { session_id, series_id } = await pinnedSeries(`clr-${clear || 'empty'}`, {
          model: 'sonnet',
          effort: 'low',
        });
        const upd = await dispatch(
          {
            id: `u-${clear || 'empty'}`,
            command: 'tasks-update',
            args: { id: series_id, model: clear, effort: clear },
          },
          agentCtx('ag-1', 'chat-1'),
        );
        expect(upd.ok).toBe(true);
        // Not `flagIntent: {}` — an empty object reads as "still pinned" to an
        // operator diffing the envelope.
        expect(storedContent(session_id, series_id)).not.toHaveProperty('flagIntent');
      });

      it('clears one axis while setting the other in the same call', async () => {
        const { session_id, series_id } = await pinnedSeries('clr-mixed', { model: 'sonnet', effort: 'low' });
        const upd = await dispatch(
          { id: 'u-mixed', command: 'tasks-update', args: { id: series_id, model: '', effort: 'high', group: 'ag-1' } },
          agentCtx('ag-1', 'chat-1'),
        );
        expect(upd.ok).toBe(true);
        expect(storedContent(session_id, series_id).flagIntent).toEqual({ turnEffort: 'high' });
      });

      it('a clear-only update needs no --group: there is no vocabulary to validate against', async () => {
        const { session_id, series_id } = await pinnedSeries('clr-nogroup', { model: 'sonnet' });
        const upd = await dispatch(
          { id: 'u-nogroup', command: 'tasks-update', args: { id: series_id, model: '' } },
          { caller: 'host' },
        );
        expect(upd.ok).toBe(true);
        expect(storedContent(session_id, series_id)).not.toHaveProperty('flagIntent');
      });

      it('an effort clear leaves a model pin standing', async () => {
        const { session_id, series_id } = await pinnedSeries('clr-effort', { model: 'sonnet', effort: 'low' });
        const upd = await dispatch(
          { id: 'u-effort', command: 'tasks-update', args: { id: series_id, effort: '' } },
          agentCtx('ag-1', 'chat-1'),
        );
        expect(upd.ok).toBe(true);
        expect(storedContent(session_id, series_id).flagIntent).toEqual({ turnModel: 'sonnet' });
      });
    });
  });

  describe('scheduled_audit trail (fleet-hardening Phase 0.2)', () => {
    function auditRows(seriesId: string) {
      return getRawDb()
        .prepare(
          'SELECT actor, action, agent_group_id, session_id, series_id, before_hash, after_hash, ts ' +
            'FROM scheduled_audit WHERE series_id = ? ORDER BY id ASC',
        )
        .all(seriesId) as Array<{
        actor: string;
        action: string;
        agent_group_id: string;
        session_id: string;
        series_id: string;
        before_hash: string | null;
        after_hash: string | null;
        ts: string;
      }>;
    }

    it('create writes one audit row: actor is the calling agent group, action create, after set', async () => {
      const r = await dispatch(
        {
          id: 'a-c',
          command: 'tasks-create',
          args: { prompt: 'send a briefing', name: 'audited', process_after: '2999-01-01T00:00:00Z' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const { series_id } = r.data as { series_id: string };

      const rows = auditRows(series_id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: 'agent:ag-1', action: 'create', agent_group_id: 'ag-1' });
      expect(rows[0]!.before_hash).toBeNull();
      expect(rows[0]!.after_hash).toBeTruthy();
      expect(rows[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // explicit ISO, not sqlite's naive default
    });

    it('records the instant it actually wrote, per group, on a schedule-only update', async () => {
      // The written value and the audited value must be the same object. When
      // the per-session merge happened at the write call while the audit read
      // the pre-merge update, a schedule-only edit wrote a new instant and
      // recorded nothing — and each group can receive a different instant.
      await createGroup('ag-audit-tokyo');
      await createGroup('ag-audit-kolkata');
      await ensureContainerConfig('ag-audit-tokyo');
      await ensureContainerConfig('ag-audit-kolkata');
      await updateContainerConfigScalars('ag-audit-tokyo', { timezone: 'Asia/Tokyo' });
      await updateContainerConfigScalars('ag-audit-kolkata', { timezone: 'Asia/Kolkata' });

      const made: Record<string, { series_id: string }> = {};
      for (const group of ['ag-audit-tokyo', 'ag-audit-kolkata']) {
        const r = await dispatch(
          {
            id: `audit-create-${group}`,
            command: 'tasks-create',
            args: { group, prompt: 'digest', name: 'audited-digest', process_after: '2999-01-01T00:00:00Z' },
          },
          { caller: 'host' },
        );
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        made[group] = r.data as { series_id: string };
      }
      const sharedId = made['ag-audit-tokyo'].series_id;
      const kolkataSession = (await getSessionsByAgentGroup('ag-audit-kolkata')).find(
        (sess) => sess.thread_id === taskThreadId(made['ag-audit-kolkata'].series_id),
      )!;
      const kdb = new Database(inboundDbPath('ag-audit-kolkata', kolkataSession.id));
      kdb.prepare('UPDATE messages_in SET id = ?, series_id = ? WHERE kind = ?').run(sharedId, sharedId, 'task');
      kdb.close();

      const updated = await dispatch(
        { id: 'audit-tz', command: 'tasks-update', args: { id: sharedId, process_after: '2026-10-01T09:00:00' } },
        { caller: 'host' },
      );
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      // The reported field list names what changed, even though the only
      // changed field is computed per session.
      expect((updated.data as { fields: string[] }).fields).toContain('processAfter');

      const details = (
        getRawDb()
          .prepare("SELECT agent_group_id, detail_json FROM scheduled_audit WHERE series_id = ? AND action = 'update'")
          .all(sharedId) as Array<{ agent_group_id: string; detail_json: string | null }>
      ).map((r) => ({ group: r.agent_group_id, processAfter: JSON.parse(r.detail_json ?? '{}').processAfter }));

      expect(details).toHaveLength(2);
      expect(details.find((d) => d.group === 'ag-audit-tokyo')?.processAfter).toBe('2026-10-01T00:00:00.000Z');
      expect(details.find((d) => d.group === 'ag-audit-kolkata')?.processAfter).toBe('2026-10-01T03:30:00.000Z');
    });

    it('update writes before+after with differing hashes when the prompt changes', async () => {
      const created = await dispatch(
        { id: 'a-u0', command: 'tasks-create', args: { prompt: 'v1', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id } = created.data as { series_id: string };

      const updated = await dispatch(
        { id: 'a-u1', command: 'tasks-update', args: { id: series_id, prompt: 'v2' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(updated.ok).toBe(true);

      const rows = auditRows(series_id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'update']);
      const editRow = rows[1]!;
      expect(editRow.before_hash).toBeTruthy();
      expect(editRow.after_hash).toBeTruthy();
      expect(editRow.before_hash).not.toBe(editRow.after_hash);
    });

    it('cancel writes an audit row', async () => {
      const created = await dispatch(
        { id: 'a-x0', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id } = created.data as { series_id: string };

      const cancelled = await dispatch(
        { id: 'a-x1', command: 'tasks-cancel', args: { id: series_id } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(cancelled.ok).toBe(true);

      const rows = auditRows(series_id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'cancel']);
    });

    it('delete writes an audit row', async () => {
      const created = await dispatch(
        { id: 'a-d0', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id } = created.data as { series_id: string };

      const deleted = await dispatch(
        { id: 'a-d1', command: 'tasks-delete', args: { id: series_id } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(deleted.ok).toBe(true);

      const rows = auditRows(series_id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'delete']);
    });

    // The fork treats the run-log file as durable history that survives a
    // series' close (src/modules/sweep-scheduling/index.ts's S19 duty comment).
    // `deleteRunLog` exists (ported from upstream) but `mutateTask`'s delete
    // path never calls it — this pins that `ncl tasks delete` is a mailbox-row
    // operation only, never a filesystem one.
    it('delete leaves the series run log on disk', async () => {
      const created = await dispatch(
        { id: 'a-d2', command: 'tasks-create', args: { prompt: 'x', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id } = created.data as { series_id: string };

      const logged = await dispatch(
        { id: 'a-d2-log', command: 'tasks-append-log', args: { id: series_id, msg: 'ran once' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(logged.ok).toBe(true);
      const logPath = `${TEST_DIR}/groups/ag-1/tasks/${series_id}.md`;
      expect(fs.existsSync(logPath)).toBe(true);

      const deleted = await dispatch(
        { id: 'a-d2-del', command: 'tasks-delete', args: { id: series_id } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(deleted.ok).toBe(true);

      expect(fs.existsSync(logPath), 'the run log must survive the delete').toBe(true);
      expect(fs.readFileSync(logPath, 'utf8')).toContain('ran once');
    });

    it('pause, resume, and run each write their own action row; a host caller is recorded as actor "host"', async () => {
      const created = await dispatch(
        {
          id: 'a-p0',
          command: 'tasks-create',
          args: { prompt: 'x', group: 'ag-1', process_after: '2999-01-01T00:00:00Z' },
        },
        { caller: 'host' },
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { series_id } = created.data as { series_id: string };

      const paused = await dispatch(
        { id: 'a-p1', command: 'tasks-pause', args: { id: series_id, group: 'ag-1' } },
        { caller: 'host' },
      );
      expect(paused.ok).toBe(true);
      const resumed = await dispatch(
        { id: 'a-p2', command: 'tasks-resume', args: { id: series_id, group: 'ag-1' } },
        { caller: 'host' },
      );
      expect(resumed.ok).toBe(true);
      const ran = await dispatch(
        { id: 'a-p3', command: 'tasks-run', args: { id: series_id, group: 'ag-1' } },
        { caller: 'host' },
      );
      expect(ran.ok).toBe(true);

      const rows = auditRows(series_id);
      expect(rows.map((r) => r.action)).toEqual(['create', 'pause', 'resume', 'run_now']);
      expect(rows.every((r) => r.actor === 'host')).toBe(true);
    });

    it('bulk cancel (--all) writes one audit row per live series', async () => {
      const a = await dispatch(
        { id: 'a-b0', command: 'tasks-create', args: { prompt: 'A', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      const b = await dispatch(
        { id: 'a-b1', command: 'tasks-create', args: { prompt: 'B', process_after: '2999-01-01T00:00:00Z' } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      const seriesA = (a.data as { series_id: string }).series_id;
      const seriesB = (b.data as { series_id: string }).series_id;

      const cancelled = await dispatch(
        { id: 'a-b2', command: 'tasks-cancel', args: { all: true } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(cancelled.ok).toBe(true);
      if (cancelled.ok) expect((cancelled.data as { cancelled: number }).cancelled).toBe(2);

      expect(auditRows(seriesA).map((r) => r.action)).toEqual(['create', 'cancel']);
      expect(auditRows(seriesB).map((r) => r.action)).toEqual(['create', 'cancel']);
    });
  });
  /**
   * `--session` names a session by id; `--group` names the scope the operator
   * believes they are working inside. Nothing used to check that the first is
   * inside the second, so `--group A --session <a session of B>` silently
   * operated on B — `cancel --all` and `delete` destructively, `list`/`get` as
   * a read leak. The guard lives in `selectedSessions`, the one place every
   * verb resolves its targets through, so all eight get it from one check.
   *
   * Agent callers were never exposed: `groupArg` pins them to their own group
   * and `ownSession` answers "session not found" for anything outside it,
   * deliberately refusing to confirm the id exists elsewhere. That path is
   * unchanged — these cases are the host caller's.
   */
  /**
   * The same class as the scope guard above, on the other axis: `--id` names
   * one series, `--all` names every live one in scope, and `cancelTaskCommand`
   * branched on `--all` without ever reading `--id`. The kill switch won
   * silently, so `cancel --id <one series> --all` destroyed the whole group's
   * tasks while the operator had named exactly one.
   */
  /** Two live series in ag-1, so a kill switch has something to over-cancel. */
  async function twoSeries(): Promise<string[]> {
    const ids: string[] = [];
    for (const name of ['alpha', 'beta']) {
      const r = await dispatch(
        {
          id: `ka-${name}`,
          command: 'tasks-create',
          args: { prompt: name, name, process_after: '2999-01-15T09:00:00Z' },
        },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(r.ok).toBe(true);
      if (r.ok) ids.push((r.data as { series_id: string }).series_id);
    }
    return ids;
  }

  async function liveInGroup(): Promise<string[]> {
    const list = await dispatch({ id: 'ka-list', command: 'tasks-list', args: {} }, agentCtx('ag-1', 'chat-1'));
    expect(list.ok).toBe(true);
    if (!list.ok) return [];
    // Fan-out across per-series sessions has no defined order; every caller
    // here asserts membership, so sort once at the seam.
    return (list.data as Array<{ series_id: string }>).map((t) => t.series_id).sort();
  }

  /**
   * The class one level down: a guard the caller believes is protecting them,
   * skipped by a value the caller cannot see. `--id "$TASK_ID"` with an unset
   * variable reaches the handler as `id: ''`, and a presence test written on
   * `str()` reads that as absent — so every scope guard in this file used to
   * fail open on the shell shape that makes the mistake likely, silently and
   * on every run of the script.
   *
   * These go through `parseArgv` rather than hand-built args objects: the
   * empty string is produced by the argv path (parse-argv.ts:29), and a test
   * that constructs `{ id: '' }` directly can pass while the CLI still fails.
   */
  describe('a supplied-but-empty flag is refused, never read as absent', () => {
    /** Exactly what the shell hands the dispatcher. */
    function shell(argv: string[]): Record<string, unknown> {
      return parseArgv(argv).args;
    }

    it('parseArgv really does preserve an empty flag value (the premise)', () => {
      expect(shell(['tasks', 'cancel', '--id', '', '--all'])).toEqual({ id: '', all: true });
      // A bare flag before the next one becomes `true`, which validateArgs
      // rejects on its own — so the empty string is the shape that reaches a guard.
      expect(shell(['tasks', 'cancel', '--session', '--all'])).toEqual({ session: true, all: true });
    });

    it('cancel --id "" --all is refused instead of cancelling everything', async () => {
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        { id: 'ef-id', command: 'tasks-cancel', args: shell(['tasks', 'cancel', '--id', '', '--all']) },
        agentCtx('ag-1', 'chat-1'),
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('--id');
      expect(await liveInGroup()).toEqual([alpha, beta].sort()); // nothing cancelled
    });

    // Not a hole, and marked so the boundary is not rediscovered: a value-less
    // `--id` parses to `true`, and validateArgs rejects that before any handler
    // runs. The empty string is the shape that survives validation, because
    // `''` is a valid string — which is why it is the only one guarded above.
    it('a bare --id is already refused one layer up, by argument validation', async () => {
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        { id: 'ef-bare', command: 'tasks-cancel', args: shell(['tasks', 'cancel', '--id', '--all']) },
        agentCtx('ag-1', 'chat-1'),
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('requires a value');
      expect(await liveInGroup()).toEqual([alpha, beta].sort());
    });

    it('--session "" does not silently widen one session to the whole group', async () => {
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        {
          id: 'ef-sess',
          command: 'tasks-cancel',
          args: shell(['tasks', 'cancel', '--group', 'ag-1', '--session', '', '--all']),
        },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('--session');
      expect(await liveInGroup()).toEqual([alpha, beta].sort());
    });

    it('--group "" does not fall through to the unscoped host-wide fan-out', async () => {
      // The severe one: an empty --group defeated #567's cross-group guard by
      // making `groupArg` return undefined, so the command cancelled tasks in
      // groups the operator never named.
      const [alpha, beta] = await twoSeries();
      const seeded = await dispatch(
        { id: 'ef-ag2', command: 'tasks-create', args: { prompt: 'ag-2 work', process_after: '2999-01-15T09:00:00Z' } },
        agentCtx('ag-2', 'chat-2'),
      );
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      const otherGroupSeries = (seeded.data as { series_id: string }).series_id;

      const resp = await dispatch(
        { id: 'ef-grp', command: 'tasks-cancel', args: shell(['tasks', 'cancel', '--group', '', '--all']) },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) expect(resp.error.message).toContain('--group');
      expect(await liveInGroup()).toEqual([alpha, beta].sort());

      // And the group that was never named still has its task.
      const other = await dispatch({ id: 'ef-l2', command: 'tasks-list', args: {} }, agentCtx('ag-2', 'chat-2'));
      expect(other.ok).toBe(true);
      if (other.ok) {
        expect((other.data as Array<{ series_id: string }>).map((t) => t.series_id)).toContain(otherGroupSeries);
      }
    });

    it('an omitted flag is still absent — the host-wide fan-out is unchanged', async () => {
      // The regression that matters: refusing empty must not turn "not passed"
      // into an error. `cancel --all` with no scope is still the kill switch.
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        { id: 'ef-omit', command: 'tasks-cancel', args: shell(['tasks', 'cancel', '--all']) },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(true);
      if (resp.ok) expect((resp.data as { cancelled: number }).cancelled).toBe(2);
      expect(await liveInGroup()).toEqual([]);
      expect([alpha, beta]).toHaveLength(2);
    });

    it('a populated flag is still read normally — list --group still scopes', async () => {
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        { id: 'ef-ok', command: 'tasks-list', args: shell(['tasks', 'list', '--group', 'ag-1']) },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(true);
      if (resp.ok) {
        expect((resp.data as Array<{ series_id: string }>).map((t) => t.series_id).sort()).toEqual(
          [alpha, beta].sort(),
        );
      }
    });
  });

  describe('cancel --all and --id cannot both be given', () => {
    it('refuses the contradiction and cancels nothing', async () => {
      const [alpha, beta] = await twoSeries();

      const resp = await dispatch(
        { id: 'ka-both', command: 'tasks-cancel', args: { all: true, id: alpha } },
        agentCtx('ag-1', 'chat-1'),
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.message).toContain(alpha); // the series that was named
        expect(resp.error.message).toContain('--all'); // the flag that contradicted it
      }
      // Nothing destroyed: the named series AND the bystander both survive.
      const live = await liveInGroup();
      expect(live).toContain(alpha);
      expect(live).toContain(beta);
    });

    it('--all on its own is still the kill switch, and --id on its own still cancels one', async () => {
      const [alpha, beta] = await twoSeries();

      const one = await dispatch(
        { id: 'ka-one', command: 'tasks-cancel', args: { id: alpha } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(one.ok).toBe(true);
      expect(await liveInGroup()).toEqual([beta]);

      const all = await dispatch(
        { id: 'ka-all', command: 'tasks-cancel', args: { all: true } },
        agentCtx('ag-1', 'chat-1'),
      );
      expect(all.ok).toBe(true);
      if (all.ok) expect((all.data as { cancelled: number }).cancelled).toBe(1);
      expect(await liveInGroup()).toEqual([]);
    });
  });

  describe('--session must belong to --group', () => {
    /** A live task series in ag-2, plus the isolated session that holds it. */
    async function taskInOtherGroup(): Promise<{ sessionId: string; seriesId: string }> {
      const created = await dispatch(
        {
          id: 'xg-seed',
          command: 'tasks-create',
          args: { prompt: 'ag-2 work', recurrence: '0 9 * * *', process_after: '2999-01-15T09:00:00Z' },
        },
        agentCtx('ag-2', 'chat-2'),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('fixture failed');
      const { session_id, series_id } = created.data as { session_id: string; series_id: string };
      return { sessionId: session_id, seriesId: series_id };
    }

    /** The series' live rows, read back through the session that owns them. */
    async function liveSeries(sessionId: string): Promise<string[]> {
      const list = await dispatch(
        { id: 'xg-read', command: 'tasks-list', args: { session: sessionId } },
        {
          caller: 'host',
        },
      );
      expect(list.ok).toBe(true);
      if (!list.ok) return [];
      return (list.data as Array<{ series_id: string }>).map((t) => t.series_id);
    }

    it('cancel --all refuses a cross-group session, and the other group keeps its series', async () => {
      const { sessionId, seriesId } = await taskInOtherGroup();

      const resp = await dispatch(
        { id: 'xg-cancel', command: 'tasks-cancel', args: { group: 'ag-1', session: sessionId, all: true } },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.message).toContain('ag-2'); // the group that owns the session
        expect(resp.error.message).toContain('ag-1'); // the scope the operator asked for
      }
      // The point of the guard: ag-2's series is still there.
      expect(await liveSeries(sessionId)).toContain(seriesId);
    });

    it('delete refuses a cross-group session, and the other group keeps its series', async () => {
      const { sessionId, seriesId } = await taskInOtherGroup();

      const resp = await dispatch(
        { id: 'xg-del', command: 'tasks-delete', args: { group: 'ag-1', session: sessionId, id: seriesId } },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.message).toContain('ag-2');
        expect(resp.error.message).toContain('ag-1');
      }
      expect(await liveSeries(sessionId)).toContain(seriesId);
    });

    it('list refuses a cross-group session instead of returning its rows', async () => {
      const { sessionId, seriesId } = await taskInOtherGroup();

      const resp = await dispatch(
        { id: 'xg-list', command: 'tasks-list', args: { group: 'ag-1', session: sessionId } },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.message).toContain('ag-2');
        expect(resp.error.message).toContain('ag-1');
      }
      // And nothing of ag-2's leaked into the response.
      expect(JSON.stringify(resp)).not.toContain(seriesId);
    });

    it('the same-group --session case is unchanged — read and mutate both still work', async () => {
      const { sessionId, seriesId } = await taskInOtherGroup();

      const list = await dispatch(
        { id: 'sg-list', command: 'tasks-list', args: { group: 'ag-2', session: sessionId } },
        { caller: 'host' },
      );
      expect(list.ok).toBe(true);
      if (list.ok) {
        expect((list.data as Array<{ series_id: string }>).map((t) => t.series_id)).toContain(seriesId);
      }

      const paused = await dispatch(
        { id: 'sg-pause', command: 'tasks-pause', args: { group: 'ag-2', session: sessionId, id: seriesId } },
        { caller: 'host' },
      );
      expect(paused.ok).toBe(true);
      if (paused.ok) expect((paused.data as { touched: number }).touched).toBe(1);
    });

    it('the no---session case is unchanged — a group scope still fans out, an unscoped call still spans groups', async () => {
      const { seriesId } = await taskInOtherGroup();

      const scoped = await dispatch(
        { id: 'ns-list', command: 'tasks-list', args: { group: 'ag-2' } },
        {
          caller: 'host',
        },
      );
      expect(scoped.ok).toBe(true);
      if (scoped.ok) {
        expect((scoped.data as Array<{ series_id: string }>).map((t) => t.series_id)).toContain(seriesId);
      }

      // No --group and no --session: the host-wide fan-out, still unfiltered.
      const unscoped = await dispatch({ id: 'ns-all', command: 'tasks-list', args: {} }, { caller: 'host' });
      expect(unscoped.ok).toBe(true);
      if (unscoped.ok) {
        expect((unscoped.data as Array<{ series_id: string }>).map((t) => t.series_id)).toContain(seriesId);
      }
    });

    it('an agent caller still gets the existence-oracle-safe "not found", not the new message', async () => {
      const { sessionId } = await taskInOtherGroup();

      const resp = await dispatch(
        { id: 'xg-agent', command: 'tasks-list', args: { session: sessionId } },
        agentCtx('ag-1', 'chat-1'),
      );

      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.message).toContain('session not found');
        expect(resp.error.message).not.toContain('ag-2'); // never confirms which group holds it
      }
    });
  });
});

describe('formatTasksTable', () => {
  const now = Date.parse('2026-01-15T09:05:30Z');
  const rows = [
    {
      series_id: 'task-5bbe082a-6298-4699',
      schedule: '* * * * *',
      runs: 7,
      failed_runs: 2,
      last_run: '2026-01-15T09:04:30Z',
      next_run: '2026-01-15T09:06:00Z',
      status: 'pending',
      log: 'tasks/task-5bbe082a.md',
      created_at: '2026-01-15T08:05:30Z', // 1h before now
      prompt: 'You are NanoClaw, wired into the company brain, your job this run is to read it',
    },
  ];

  it('renders an aligned table with run history', () => {
    const lines = formatTasksTable(rows, now).split('\n');
    expect(lines[0]).toMatch(/SERIES\s+SCHEDULE\s+RUNS\s+FAILED\s+LAST RUN\s+NEXT RUN\s+STATUS\s+PIN\s+AGE\s+PROMPT/);
    expect(lines[1]).toContain('1h'); // AGE column — created 1h ago
    expect(lines[1]).toContain('task-5bbe082a-6298-4699'); // FULL series id — copy-pasteable into `tasks get --id`
    expect(lines[1]).toContain('* * * * *');
    expect(lines[1]).toContain('1m ago'); // 09:04:30 vs 09:05:30
    expect(lines[1]).toContain('in 30s'); // 09:06:00 vs 09:05:30
    expect(lines[1]).toContain('…'); // prompt truncated
  });

  it('renders the per-fire PIN, and a dash when there is none', () => {
    // The point of the column: `ncl tasks list` prints the HUMAN view unless
    // --json is passed, so a pin only in the structured response is a pin the
    // operator still cannot see.
    const line = (r: Parameters<typeof formatTasksTable>[0][number]) => formatTasksTable([r], now).split('\n')[1];
    expect(line({ series_id: 'a', model_pin: 'claude-sonnet-5', effort_pin: 'xhigh' })).toContain(
      'claude-sonnet-5@xhigh',
    );
    expect(line({ series_id: 'b', model_pin: 'sonnet', effort_pin: null })).toContain('sonnet');
    expect(line({ series_id: 'c', model_pin: null, effort_pin: 'high' })).toContain('@high');
    // Unpinned renders as '-', not as an empty cell that reads like a bug.
    expect(line({ series_id: 'd', model_pin: null, effort_pin: null })).toMatch(/\s-\s/);
  });

  it('handles a never-fired series and an empty list', () => {
    expect(formatTasksTable([], now)).toBe('No tasks.');
    const oneShot = formatTasksTable(
      [
        {
          series_id: 'task-x',
          schedule: 'once',
          runs: 0,
          last_run: null,
          next_run: '2026-01-15T09:00:00Z',
          status: 'pending',
        },
      ],
      now,
    ).split('\n')[1];
    expect(oneShot).toContain('once');
    expect(oneShot).toMatch(/\bdue\b/); // next_run in the past → due
    expect(oneShot).toContain('-'); // last_run '-' (never fired)
  });
});

describe('deep verb help (ncl tasks help create)', () => {
  it('resolves through the dispatcher fallback and renders the full contract + examples', async () => {
    // Side-effect import mirrors the CLI server boot: registers <plural>-help.
    await import('../commands/index.js');
    const resp = await dispatch({ id: 'h1', command: 'tasks-help-create', args: {} }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const text = resp.data as string;
      expect(text).toContain('ncl tasks create');
      expect(text).toContain('wakeAgent'); // full multi-line script contract present
      expect(text).toContain('Examples:'); // examples block rendered
    }
  });

  it('rejects an unknown verb with a pointer back to resource help', async () => {
    await import('../commands/index.js');
    const resp = await dispatch({ id: 'h2', command: 'tasks-help-frobnicate', args: {} }, { caller: 'host' });
    expect(resp.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider-migration pin semantics (2026-09-07 incident).
//
// These live HERE rather than in their own file on purpose: the fixture below
// reaches the transitional synchronous central-DB handle (`getRawDb`) to run
// migrations, and `src/db/raw-db-ratchet.test.ts` pins that referrer set as
// only-ever-shrinking. A new test file would have widened it. This file is
// already pinned and already carries the exact task fixture these need.
//
// A pin is validated ONCE, at create/update time, against the group's provider
// as it stood then; nothing re-validates it at fire time. A codex->claude
// switch therefore left a half-hourly series pinned to a codex model, and it
// failed 21 consecutive fires over 14 hours before anyone noticed. The fix is
// to WARN LOUDLY and proceed (repeated task failure is escalated on its own
// now, and refusing would block legitimate migrations behind a flag nobody
// asked for), plus a bulk re-pin command that can validate against the
// provider a group is moving TO.
// ---------------------------------------------------------------------------
/** A group with a container config, a real group folder, and a provider set. */
async function makePinGroup(id: string, provider: string | null): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await ensureContainerConfig(id);
  if (provider) await updateContainerConfigScalars(id, { provider });
  const dir = `${TEST_DIR}/groups/${id}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    `${dir}/container.json`,
    JSON.stringify(
      { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all', provider },
      null,
      2,
    ) + '\n',
  );
}

/** A group whose container.json omits `provider` entirely — not `null`, absent. */
async function makeNoProviderKeyGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  await ensureContainerConfig(id);
  const dir = `${TEST_DIR}/groups/${id}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    `${dir}/container.json`,
    JSON.stringify({ mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' }, null, 2) +
      '\n',
  );
}

async function makePinnedTask(
  group: string,
  name: string,
  pin: { model?: string; effort?: string },
): Promise<{ series_id: string; session_id: string }> {
  const r = await dispatch(
    {
      id: `create-${name}`,
      command: 'tasks-create',
      args: { group, name, prompt: 'x', process_after: '2999-01-01T00:00:00Z', ...pin },
    },
    { caller: 'host' },
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error.message);
  return r.data as { series_id: string; session_id: string };
}

function storedTaskPin(group: string, sessionId: string, seriesId: string): unknown {
  const db = new Database(inboundDbPath(group, sessionId), { readonly: true });
  const row = db.prepare("SELECT content FROM messages_in WHERE kind = 'task' AND id = ?").get(seriesId) as {
    content: string;
  };
  db.close();
  return (JSON.parse(row.content) as { flagIntent?: unknown }).flagIntent;
}

async function configUpdate(args: Record<string, unknown>) {
  return dispatch({ id: `cfg-${Math.random()}`, command: 'groups-config-update', args }, { caller: 'host' });
}

async function repin(args: Record<string, unknown>) {
  return dispatch({ id: `repin-${Math.random()}`, command: 'tasks-repin', args }, { caller: 'host' });
}

describe('provider vocabularies do not nest', () => {
  // The premise the audit rests on. Verified against the live parser: an effort
  // level valid on one provider is a hard error on another, in BOTH directions
  // — so a migration cannot be waved through on "the new provider is a superset".
  const cases: Array<[string, string, boolean]> = [
    // NOTE `ultracode` is absent here on purpose: it is valid CHAT vocabulary
    // on claude but is not a valid task PIN on any provider (see the dedicated
    // case below). Pin validity is strictly narrower than chat validity, and
    // listing it as `true` here would assert the opposite.
    ['claude', 'ultra', false],
    ['claude', 'xhigh', true],
    ['codex', 'ultra', true],
    ['codex', 'ultracode', false],
    ['codex', 'xhigh', true],
    ['opencode', 'xhigh', false],
    ['opencode', 'ultra', false],
    ['opencode', 'ultracode', false],
    ['opencode', 'high', true],
  ];
  it.each(cases)('effort %s on %s valid=%s', (provider, effort, valid) => {
    expect(validateTaskPin({ effort }, provider).error === undefined).toBe(valid);
  });

  it('pin validity is NARROWER than chat validity: ultracode is claude chat, never a pin', () => {
    // `-e ultracode` is accepted in chat on a claude group. As a PIN it is
    // refused on every provider, because the parser splits it into
    // `turnEffort: 'xhigh'` plus a separate flag and only the effort is stored
    // — so accepting it would persist something other than what was asked for.
    for (const provider of ['claude', 'codex', 'opencode']) {
      expect(validateTaskPin({ effort: 'ultracode' }, provider).error).toBeDefined();
    }
    expect(validateTaskPin({ effort: 'xhigh' }, 'claude').error).toBeUndefined();
  });

  it('a codex model id is not a claude model id, and vice versa', () => {
    expect(validateTaskPin({ model: 'gpt-6-astra' }, 'claude').error).toContain('unknown model');
    expect(validateTaskPin({ model: 'claude-sonnet-5' }, 'codex').error).toContain('unknown model');
    expect(validateTaskPin({ model: 'claude-sonnet-5' }, 'opencode').error).toContain('unknown model');
  });
});

describe('groups config update --provider refuses on stranded task pins', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('REFUSES a codex→claude switch that would strand a gpt-* model pin (the 2026-09-07 incident)', async () => {
    await makePinGroup('ag-codex', 'codex');
    const task = await makePinnedTask('ag-codex', 'pr-watch', { model: 'gpt-6-astra', effort: 'high' });

    const r = await configUpdate({ id: 'ag-codex', provider: 'claude' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Actionable on its own: the series, its literal pin, the reason, and the
    // exact remedy — the --from-model the fix needs is readable right here.
    expect(r.error.message).toContain('Refusing to switch ag-codex');
    expect(r.error.message).toContain(task.series_id);
    expect(r.error.message).toContain('gpt-6-astra');
    expect(r.error.message).toContain('unknown model');
    expect(r.error.message).toContain('ncl tasks repin');
    expect(r.error.message).toContain('--target-provider claude');

    // Nothing was written — not the DB row, not container.json.
    const row = getRawDb()
      .prepare('SELECT provider FROM container_configs WHERE agent_group_id = ?')
      .get('ag-codex') as { provider: string | null };
    expect(row.provider).toBe('codex');
    expect(JSON.parse(fs.readFileSync(`${TEST_DIR}/groups/ag-codex/container.json`, 'utf8')).provider).toBe('codex');
  });

  it('REFUSES on an effort-only stranding (claude xhigh → opencode, the next instance of this class)', async () => {
    await makePinGroup('ag-claude', 'claude');
    await makePinnedTask('ag-claude', 'smoke', { effort: 'xhigh' });

    const r = await configUpdate({ id: 'ag-claude', provider: 'opencode' });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('unknown effort level: xhigh');
    expect(r.error.message).toContain('expected low|medium|high|max');
  });

  it('allows the switch when every armed pin is valid under the new provider', async () => {
    await makePinGroup('ag-ok', 'claude');
    // xhigh is valid on codex too; a paused series is audited the same as pending.
    await makePinnedTask('ag-ok', 'ok-1', { effort: 'xhigh' });
    const paused = await makePinnedTask('ag-ok', 'ok-2', { effort: 'high' });
    await dispatch(
      { id: 'pause', command: 'tasks-pause', args: { id: paused.series_id, group: 'ag-ok' } },
      { caller: 'host' },
    );

    expect((await configUpdate({ id: 'ag-ok', provider: 'codex' })).ok).toBe(true);
  });

  it('audits PAUSED series too — a paused task resumes into the same broken fire', async () => {
    await makePinGroup('ag-paused', 'codex');
    const task = await makePinnedTask('ag-paused', 'sleeper', { model: 'gpt-6-astra' });
    await dispatch(
      { id: 'pause2', command: 'tasks-pause', args: { id: task.series_id, group: 'ag-paused' } },
      { caller: 'host' },
    );

    const stranded = await auditTaskPins('ag-paused', 'claude');
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ seriesId: task.series_id, status: 'paused', model: 'gpt-6-astra' });

    expect((await configUpdate({ id: 'ag-paused', provider: 'claude' })).ok).toBe(false);
  });

  it('unpinned tasks never strand — they have nothing to strand', async () => {
    await makePinGroup('ag-bare', 'codex');
    await makePinnedTask('ag-bare', 'bare', {});
    expect(await auditTaskPins('ag-bare', 'claude')).toEqual([]);
    expect((await configUpdate({ id: 'ag-bare', provider: 'claude' })).ok).toBe(true);
  });

  it('leaves the pin BYTE-IDENTICAL — refusing never rewrites what it refuses over', async () => {
    await makePinGroup('ag-keep', 'codex');
    const task = await makePinnedTask('ag-keep', 'kept', { model: 'gpt-6-astra', effort: 'high' });

    expect((await configUpdate({ id: 'ag-keep', provider: 'claude' })).ok).toBe(false);

    expect(storedTaskPin('ag-keep', task.session_id, task.series_id)).toEqual({
      turnModel: 'gpt-6-astra',
      turnEffort: 'high',
    });
  });

  it('has NO --force: a suppression-shaped flag does not get past the refusal', async () => {
    await makePinGroup('ag-noflag', 'codex');
    await makePinnedTask('ag-noflag', 'pinned', { model: 'gpt-6-astra' });
    const r = await configUpdate({
      id: 'ag-noflag',
      provider: 'claude',
      force: true,
      'dangerously-strand-invalid-task-pins': true,
    });
    expect(r.ok).toBe(false);
  });

  it('a non-provider config update is never gated on the audit', async () => {
    await makePinGroup('ag-other', 'codex');
    await makePinnedTask('ag-other', 'pinned', { model: 'gpt-6-astra' });
    expect((await configUpdate({ id: 'ag-other', assistant_name: 'Renamed' })).ok).toBe(true);
  });

  it('audits against container.json, not the DB projection, when the two disagree', async () => {
    // `container.json` is authoritative — the spawn path and the runner read
    // it; `container_configs` is a read-side projection that can lag. Deciding
    // "is this a migration?" from the projection meant a group whose ROW
    // already said claude while the FILE still said codex skipped the audit,
    // and then this handler wrote the file — performing the real switch with
    // every gpt-* pin carried into Claude unexamined.
    await makePinGroup('ag-drift', 'codex');
    const task = await makePinnedTask('ag-drift', 'drifted', { model: 'gpt-6-astra' });

    // Desync exactly as an older DB-only edit would: row says claude, file codex.
    await updateContainerConfigScalars('ag-drift', { provider: 'claude' });
    expect(JSON.parse(fs.readFileSync(`${TEST_DIR}/groups/ag-drift/container.json`, 'utf8')).provider).toBe('codex');

    const r = await configUpdate({ id: 'ag-drift', provider: 'claude' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(task.series_id);
    expect(r.error.message).toContain('gpt-6-astra');
    // The authoritative file is untouched by the refusal.
    expect(JSON.parse(fs.readFileSync(`${TEST_DIR}/groups/ag-drift/container.json`, 'utf8')).provider).toBe('codex');
  });

  it('resolves the provider through ONE seam — repin and the audit cannot disagree', async () => {
    // The same invariant was found unfixed at three call sites across two
    // review rounds (the audit, repin's matching, and create/update pin
    // validation). It now lives in `resolveGroupProvider`; this asserts the
    // consequence rather than the implementation — with the row and the file
    // disagreeing, BOTH the audit and repin must answer with the file.
    await makePinGroup('ag-seam', 'codex');
    const t = await makePinnedTask('ag-seam', 'seamed', { model: 'gpt-6-astra' });
    await updateContainerConfigScalars('ag-seam', { provider: 'claude' }); // projection lies

    // repin matches in the FILE's vocabulary (codex), not the row's (claude)
    const r = await repin({ group: 'ag-seam', from_model: 'astra', to_model: 'gpt-5.6-sol', match_resolved: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { applied: number }).applied).toBe(1);
    expect(storedTaskPin('ag-seam', t.session_id, t.series_id)).toEqual({ turnModel: 'gpt-5.6-sol' });

    // ...and the audit reads the same file, so the switch is still a migration
    expect((await configUpdate({ id: 'ag-seam', provider: 'claude' })).ok).toBe(false);
  });

  it('an ABSENT provider key resolves to claude — the spawn default, not the projection', async () => {
    // The resolver must agree with what actually BOOTS, including where the
    // spawn path's answer comes from a default rather than a stored value.
    // `container-runner.ts` calls resolveProviderName(session, file.provider)
    // on the bind-mounted file; a missing key therefore runs Claude. Consulting
    // the row for the absent case makes this switch read as a no-op:
    // fromProvider would be the row's `codex`, equal to the requested `codex`,
    // so the audit is SKIPPED and `codex` is written into the authoritative
    // file — stranding the claude pin below in the exact migration this
    // resolver exists to make safe. Pre-fix this returns ok:true.
    await makeNoProviderKeyGroup('ag-nokey');
    const task = await makePinnedTask('ag-nokey', 'unkeyed', { model: 'sonnet' });
    // The projection goes stale AFTER the pin exists — a DB-only provider edit,
    // a restore, an older code path. The file still has no provider key.
    await updateContainerConfigScalars('ag-nokey', { provider: 'codex' });

    // Assert the CONSEQUENCE first: pre-fix this is ok:true, the audit never
    // runs, and the file is rewritten to codex under the pin below.
    const r = await configUpdate({ id: 'ag-nokey', provider: 'codex' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain(task.series_id);
    // ...and the authoritative file still has no provider key, so the group
    // keeps booting Claude rather than being silently migrated.
    expect(JSON.parse(fs.readFileSync(`${TEST_DIR}/groups/ag-nokey/container.json`, 'utf8')).provider).toBeUndefined();
    expect(await resolveGroupProvider('ag-nokey')).toBe('claude');
  });

  it('an absent container.json resolves to claude, and never to the projection', async () => {
    // readContainerConfig returns an empty config for a missing/malformed file
    // rather than throwing, so this lands on the same default the spawn path
    // would use. The row is not a fallback for it.
    await createAgentGroup({
      id: 'ag-nofile',
      name: 'ag-nofile',
      folder: 'ag-nofile',
      agent_provider: null,
      created_at: now(),
    });
    await ensureContainerConfig('ag-nofile');
    await updateContainerConfigScalars('ag-nofile', { provider: 'opencode' });
    expect(fs.existsSync(`${TEST_DIR}/groups/ag-nofile/container.json`)).toBe(false);

    expect(await resolveGroupProvider('ag-nofile')).toBe('claude');
  });

  it('a session-level provider still outranks both stores', async () => {
    // The absent-key fix removes the ROW as a fallback; it must not disturb
    // the per-session sticky override, which is a real running-provider signal.
    await makeNoProviderKeyGroup('ag-sticky');
    await updateContainerConfigScalars('ag-sticky', { provider: 'claude' });
    expect(await resolveGroupProvider('ag-sticky', 'codex')).toBe('codex');
  });

  it('the remedy command is runnable and matches the axis that actually stranded', async () => {
    // Two defects in one message, both found in review:
    //  - it always carried --dry-run, so an operator following it verbatim
    //    previewed, changed nothing, and hit the identical refusal again;
    //  - an EFFORT-only strand was handed a --from-model command, which
    //    matches nothing.
    await makePinGroup('ag-effort-only', 'codex');
    // Valid model under both, effort valid only under codex.
    await makePinnedTask('ag-effort-only', 'effort-strand', { model: 'gpt-6-astra', effort: 'ultra' });

    const r = await configUpdate({ id: 'ag-effort-only', provider: 'claude' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = r.error.message;

    // The applying command must be present, i.e. a repin line that is not
    // itself a preview. Pre-fix EVERY suggested command ended in --dry-run.
    const commandLines = msg.split('\n').filter((l) => l.includes('ncl tasks repin'));
    expect(commandLines.length).toBeGreaterThan(0);
    expect(commandLines.some((l) => l.includes('--dry-run'))).toBe(false);
    expect(msg).toContain('WITHOUT --dry-run to apply');

    // The effort axis stranded, so the effort axis is what the remedy offers.
    expect(msg).toContain('--from-effort ultra');
  });

  it('a post-switch strand says the switch LANDED, never that it was refused', async () => {
    // The post-write re-audit reused the refusal text, which says the switch
    // is being refused — but by then it has already been applied to both the
    // DB row and the authoritative container.json. An operator reading it
    // would go looking for a switch to retry that already happened.
    const stranded = [
      {
        seriesId: 'series-late',
        sessionId: 'sess-late',
        status: 'pending',
        model: 'sonnet',
        effort: null,
        reason: 'model not valid',
      },
    ];
    const late = formatLateStrandedPins(stranded, 'ag-late', 'claude', 'codex');

    expect(late).toContain('HAS BEEN APPLIED');
    expect(late).toContain('Do NOT re-run the switch');
    expect(late).not.toContain('Refusing to switch');
    // The group is already on the new provider, so the COMMAND must not tell
    // the operator to validate against a provider it already has. Checked on
    // the command lines, not the whole message — the prose mentions the flag
    // by name to explain its absence.
    const lateCommands = late.split('\n').filter((l) => l.includes('ncl tasks repin'));
    expect(lateCommands.length).toBeGreaterThan(0);
    expect(lateCommands.some((l) => l.includes('--target-provider'))).toBe(false);
    expect(late).toContain('--from-model sonnet');

    // ...and the pre-switch text still says the opposite, deliberately.
    const refusal = formatStrandedPins(stranded, 'ag-late', 'claude', 'codex');
    expect(refusal).toContain('Refusing to switch');
    expect(refusal).toContain('--target-provider codex');
  });

  it('re-stating the SAME provider is not a migration and is never refused', async () => {
    await makePinGroup('ag-same', 'codex');
    await makePinnedTask('ag-same', 'pinned', { model: 'gpt-6-astra' });
    expect((await configUpdate({ id: 'ag-same', provider: 'codex' })).ok).toBe(true);
  });

  it('KNOWN GAP, deliberate: a retired model id passes the vocabulary check', () => {
    // `VALID_MODEL_RE` is a SHAPE check, so any well-formed claude-opus-<n>-<n>
    // validates. A pin written today to a retired id is legal at creation and
    // unrunnable at fire time — the same class as a wrong-provider pin, reached
    // by retirement instead of migration. NOT fixed here: a membership set
    // would be a second copy of a vocabulary that lives in one place, and the
    // last tightening of this regex rejected the fork's own DEFAULT_HAIKU_MODEL
    // and silently fell through to the Opus default at the spawn seam.
    // Scheduled-task failure escalation covers the fire-time symptom; `ncl
    // tasks repin` is the remediation when a model actually retires. This test
    // exists so the gap stays a recorded decision, not a rediscovery.
    expect(validateTaskPin({ model: 'claude-opus-4-7' }, 'claude').error).toBeUndefined();
    expect(validateTaskPin({ model: 'claude-opus-9-3' }, 'claude').error).toBeUndefined();
  });
});

describe('ncl tasks repin', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
    await makePinGroup('ag-1', 'claude');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('--dry-run reports the change and writes nothing', async () => {
    const t = await makePinnedTask('ag-1', 'bump', { model: 'claude-sonnet-5', effort: 'xhigh' });

    const r = await repin({
      group: 'ag-1',
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5[1m]',
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { matched: number; applied: number; changes: Array<Record<string, unknown>> };
    expect(data.matched).toBe(1);
    expect(data.applied).toBe(0);
    expect(data.changes[0]).toMatchObject({
      series_id: t.series_id,
      from: { model: 'claude-sonnet-5', effort: 'xhigh' },
      to: { model: 'claude-opus-5[1m]', effort: 'xhigh' },
    });

    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({
      turnModel: 'claude-sonnet-5',
      turnEffort: 'xhigh',
    });
  });

  // #842: matching is by pin VALUE, so sibling series in a group share a match.
  // --series-id is how one of them is isolated.
  describe('--series-id (#842)', () => {
    it('narrows a value match to one series and leaves its siblings alone', async () => {
      const target = await makePinnedTask('ag-1', 'target', { model: 'claude-sonnet-5' });
      const sibling = await makePinnedTask('ag-1', 'sibling', { model: 'claude-sonnet-5' });

      const r = await repin({
        group: 'ag-1',
        series_id: target.series_id,
        from_model: 'claude-sonnet-5',
        to_model: 'claude-opus-5[1m]',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { applied: number }).applied).toBe(1);
      expect(storedTaskPin('ag-1', target.session_id, target.series_id)).toEqual({ turnModel: 'claude-opus-5[1m]' });
      expect(storedTaskPin('ag-1', sibling.session_id, sibling.series_id)).toEqual({ turnModel: 'claude-sonnet-5' });
    });

    it('refuses an id that is not in scope instead of reporting an empty run', async () => {
      await makePinnedTask('ag-1', 'only', { model: 'claude-sonnet-5' });
      const r = await repin({
        group: 'ag-1',
        series_id: 'no-such-series',
        from_model: 'claude-sonnet-5',
        to_model: 'claude-opus-5[1m]',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('no task series no-such-series in scope');
    });

    it('REFUSES an id that names a series in more than one group rather than repinning both', async () => {
      // Series ids are unique within an agent group, not fleet-wide: a named
      // task's id is `<slug>-<4hex>` (scheduling/create.ts:67), so two groups
      // running a task of the same name collide on a 1-in-65536 draw. Under
      // `--all`, a filter that promised ONE series would then rewrite several.
      await makePinGroup('ag-2', 'claude');
      const first = await makePinnedTask('ag-1', 'shared', { model: 'claude-sonnet-5' });
      const second = await makePinnedTask('ag-2', 'shared', { model: 'claude-sonnet-5' });
      // Force the collision the id scheme permits but rarely produces.
      const db = new Database(inboundDbPath('ag-2', second.session_id));
      db.prepare("UPDATE messages_in SET series_id = ? WHERE kind = 'task'").run(first.series_id);
      db.close();

      const r = await repin({
        all: true,
        series_id: first.series_id,
        from_model: 'claude-sonnet-5',
        to_model: 'claude-opus-5[1m]',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('ambiguous');
      expect(r.error.message).toContain('--group');
      // Nothing was written on the way to the refusal.
      expect(storedTaskPin('ag-1', first.session_id, first.series_id)).toEqual({ turnModel: 'claude-sonnet-5' });
    });

    it('still honours --from-model: a series in scope that does not match is not rewritten', async () => {
      const t = await makePinnedTask('ag-1', 'other-pin', { model: 'claude-fable-5-1[1m]' });
      const r = await repin({
        group: 'ag-1',
        series_id: t.series_id,
        from_model: 'claude-sonnet-5',
        to_model: 'claude-opus-5[1m]',
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { matched: number; applied: number }).applied).toBe(0);
      expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnModel: 'claude-fable-5-1[1m]' });
    });
  });

  it('retargets a model pin in bulk and leaves the effort pin alone', async () => {
    const a = await makePinnedTask('ag-1', 'a', { model: 'claude-sonnet-5', effort: 'xhigh' });
    const b = await makePinnedTask('ag-1', 'b', { model: 'claude-sonnet-5' });
    const untouched = await makePinnedTask('ag-1', 'c', { model: 'claude-fable-5-1[1m]', effort: 'medium' });

    const r = await repin({ group: 'ag-1', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5[1m]' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { applied: number }).applied).toBe(2);

    expect(storedTaskPin('ag-1', a.session_id, a.series_id)).toEqual({
      turnModel: 'claude-opus-5[1m]',
      turnEffort: 'xhigh',
    });
    expect(storedTaskPin('ag-1', b.session_id, b.series_id)).toEqual({ turnModel: 'claude-opus-5[1m]' });
    expect(storedTaskPin('ag-1', untouched.session_id, untouched.series_id)).toEqual({
      turnModel: 'claude-fable-5-1[1m]',
      turnEffort: 'medium',
    });
  });

  it('bulk-changes EFFORT the same way — the invalidation class is symmetric', async () => {
    const t = await makePinnedTask('ag-1', 'eff', { model: 'claude-opus-5[1m]', effort: 'xhigh' });
    const r = await repin({ group: 'ag-1', from_effort: 'xhigh', to_effort: 'high' });
    expect(r.ok).toBe(true);
    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({
      turnModel: 'claude-opus-5[1m]',
      turnEffort: 'high',
    });
  });

  it('refuses the WHOLE run when any target is invalid — never half-applies', async () => {
    const a = await makePinnedTask('ag-1', 'a', { model: 'claude-sonnet-5' });
    const b = await makePinnedTask('ag-1', 'b', { model: 'claude-sonnet-5' });

    const r = await repin({ group: 'ag-1', from_model: 'claude-sonnet-5', to_model: 'gpt-6-astra' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('refusing to re-pin');
    expect(r.error.message).toContain('unknown model: gpt-6-astra');

    for (const t of [a, b]) {
      expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnModel: 'claude-sonnet-5' });
    }
  });

  it('--target-provider is what makes re-pinning AHEAD of a migration possible', async () => {
    await makePinGroup('ag-codex', 'codex');
    const t = await makePinnedTask('ag-codex', 'pr-watch', { model: 'gpt-6-astra', effort: 'high' });

    // Without it the group is still codex, so the correct new value is rejected.
    const blocked = await repin({ group: 'ag-codex', from_model: 'gpt-6-astra', to_model: 'claude-sonnet-5' });
    expect(blocked.ok).toBe(false);

    const ahead = await repin({
      group: 'ag-codex',
      target_provider: 'claude',
      from_model: 'gpt-6-astra',
      to_model: 'claude-sonnet-5',
    });
    expect(ahead.ok).toBe(true);
    expect(storedTaskPin('ag-codex', t.session_id, t.series_id)).toEqual({
      turnModel: 'claude-sonnet-5',
      turnEffort: 'high',
    });

    // ...and the migration the audit refused now goes through.
    expect((await configUpdate({ id: 'ag-codex', provider: 'claude' })).ok).toBe(true);
  });

  it('matches LITERALLY by default and reports the near-miss instead of silently looking exhaustive', async () => {
    const alias = await makePinnedTask('ag-1', 'alias', { model: 'sonnet' });
    const frozen = await makePinnedTask('ag-1', 'frozen', { model: 'claude-sonnet-5' });

    const literal = await repin({
      group: 'ag-1',
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5[1m]',
      dry_run: true,
    });
    expect(literal.ok).toBe(true);
    if (!literal.ok) return;
    const data = literal.data as {
      matched: number;
      near_misses: Array<{ series_id: string; model: string | null }>;
    };
    expect(data.matched).toBe(1);
    // `sonnet` resolves to claude-sonnet-5 but is a DIFFERENT pin: it tracks
    // the install default across future bumps. Rewriting it would freeze it.
    expect(data.near_misses).toEqual([expect.objectContaining({ series_id: alias.series_id, model: 'sonnet' })]);
    expect(frozen.series_id).toBeTruthy();

    const unified = await repin({
      group: 'ag-1',
      from_model: 'claude-sonnet-5',
      to_model: 'claude-opus-5[1m]',
      match_resolved: true,
      dry_run: true,
    });
    expect(unified.ok).toBe(true);
    if (!unified.ok) return;
    expect((unified.data as { matched: number }).matched).toBe(2);
  });

  it('requires a --from- for every --to-, and a scope', async () => {
    // Asserting the MESSAGE, not just !ok: "no such command" is also !ok, and
    // a test that cannot tell those apart proves nothing about this verb.
    const noFrom = await repin({ group: 'ag-1', to_model: 'claude-opus-5[1m]' });
    expect(noFrom.ok).toBe(false);
    if (!noFrom.ok) expect(noFrom.error.message).toContain('--to-model requires --from-model');

    const noTo = await repin({ group: 'ag-1', from_model: 'claude-sonnet-5' });
    expect(noTo.ok).toBe(false);
    if (!noTo.ok) expect(noTo.error.message).toContain('nothing to set');

    const noScope = await repin({ from_model: 'claude-sonnet-5', to_model: 'claude-opus-5[1m]' });
    expect(noScope.ok).toBe(false);
    if (!noScope.ok) expect(noScope.error.message).toContain('a scope is required');
  });

  it('--all spans groups and validates each against ITS OWN provider', async () => {
    await makePinGroup('ag-codex', 'codex');
    const claudeTask = await makePinnedTask('ag-1', 'c', { effort: 'xhigh' });
    const codexTask = await makePinnedTask('ag-codex', 'x', { effort: 'xhigh' });

    // `ultracode` is claude-only, so a fleet-wide run must refuse on the codex
    // group rather than validating everything against one representative.
    const mixed = await repin({ all: true, from_effort: 'xhigh', to_effort: 'ultracode' });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.error.message).toContain('ultracode is Claude-only');

    // `high` is valid on both, so the same run applies everywhere.
    const ok = await repin({ all: true, from_effort: 'xhigh', to_effort: 'high' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((ok.data as { applied: number }).applied).toBe(2);
    expect(storedTaskPin('ag-1', claudeTask.session_id, claudeTask.series_id)).toEqual({ turnEffort: 'high' });
    expect(storedTaskPin('ag-codex', codexTask.session_id, codexTask.series_id)).toEqual({ turnEffort: 'high' });
  });

  it('exposes the pin in tasks list — in the HUMAN view, not only in --json', async () => {
    const t = await makePinnedTask('ag-1', 'visible', { model: 'claude-sonnet-5', effort: 'xhigh' });
    const listed = await dispatch({ id: 'ls', command: 'tasks-list', args: { group: 'ag-1' } }, { caller: 'host' });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    // Machine contract.
    const rows = listed.data as Array<{ series_id: string; model_pin: string | null; effort_pin: string | null }>;
    expect(rows.find((r) => r.series_id === t.series_id)).toMatchObject({
      model_pin: 'claude-sonnet-5',
      effort_pin: 'xhigh',
    });

    // And what an operator running `ncl tasks list` actually sees. The client
    // prints `human` verbatim when present, so a pin absent from the table is
    // a pin the audit tells you to fix and gives you no way to read.
    expect(listed.human).toBeDefined();
    expect(listed.human).toContain('PIN');
    expect(listed.human).toContain('claude-sonnet-5@xhigh');
  });

  it('persists the RESOLVED model, not the alias the operator typed', async () => {
    // `astra` is accepted only BECAUSE it resolves to `gpt-6-astra`. Storing
    // the raw alias persists a value the validator never approved, and
    // codex.ts::resolveQueryModel accepts only `gpt-*` — it would silently fall
    // back to the configured model on every fire, forever, with no error.
    await makePinGroup('ag-cx', 'codex');
    const t = await makePinnedTask('ag-cx', 'alias', { model: 'gpt-5.6-sol' });

    const r = await repin({ group: 'ag-cx', from_model: 'gpt-5.6-sol', to_model: 'astra' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(storedTaskPin('ag-cx', t.session_id, t.series_id)).toEqual({ turnModel: 'gpt-6-astra' });
    // The dry-run/report view must show the stored value too, not the alias.
    expect((r.data as { changes: Array<{ to: { model: string } }> }).changes[0].to.model).toBe('gpt-6-astra');
  });

  it('validates the MERGED pin, not just the half being written', async () => {
    // updateTask MERGES flagIntent. A codex task at {gpt-6-astra, ultra}
    // repinned to a Claude model would store {claude-…, ultra} — still invalid
    // for Claude, so the provider migration this command exists to unblock
    // stays blocked while the repin reports success.
    await makePinGroup('ag-mix', 'codex');
    const t = await makePinnedTask('ag-mix', 'mixed', { model: 'gpt-6-astra', effort: 'ultra' });

    const modelOnly = await repin({
      group: 'ag-mix',
      target_provider: 'claude',
      from_model: 'gpt-6-astra',
      to_model: 'claude-sonnet-5',
    });
    expect(modelOnly.ok).toBe(false);
    if (modelOnly.ok) return;
    expect(modelOnly.error.message).toContain('unknown effort level: ultra');
    // ...and nothing was written, so the series is not left half-migrated.
    expect(storedTaskPin('ag-mix', t.session_id, t.series_id)).toEqual({
      turnModel: 'gpt-6-astra',
      turnEffort: 'ultra',
    });

    // Moving BOTH axes is accepted, and that is what actually clears the
    // provider switch.
    const both = await repin({
      group: 'ag-mix',
      target_provider: 'claude',
      from_model: 'gpt-6-astra',
      to_model: 'claude-sonnet-5',
      from_effort: 'ultra',
      to_effort: 'xhigh',
    });
    expect(both.ok).toBe(true);
    expect(storedTaskPin('ag-mix', t.session_id, t.series_id)).toEqual({
      turnModel: 'claude-sonnet-5',
      turnEffort: 'xhigh',
    });
    expect((await configUpdate({ id: 'ag-mix', provider: 'claude' })).ok).toBe(true);
  });

  it('matches --from-effort case-insensitively without --match-resolved', async () => {
    // Effort has no alias layer: `XHIGH` IS `xhigh`, so matching it is
    // normalization, not the semantic widening --match-resolved gates. The
    // registry documents a case-insensitive compare; before this, `--from-effort
    // XHIGH` reported zero changes unless an unrelated model flag was added.
    const t = await makePinnedTask('ag-1', 'case', { effort: 'xhigh' });
    const r = await repin({ group: 'ag-1', from_effort: 'XHIGH', to_effort: 'high' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { applied: number }).applied).toBe(1);
    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnEffort: 'high' });
  });

  it('model matching stays case-SENSITIVE — an id is not an effort level', async () => {
    await makePinnedTask('ag-1', 'model-case', { model: 'claude-sonnet-5' });
    const r = await repin({
      group: 'ag-1',
      from_model: 'CLAUDE-SONNET-5',
      to_model: 'claude-opus-5[1m]',
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { matched: number }).matched).toBe(0);
  });

  it('INHERITS the cross-group --session refusal from selectedSessions (#567)', async () => {
    // `repin` carries no guard of its own for this: the invariant lives in
    // `selectedSessions`, which every verb in this file calls, and a second
    // copy here is how the two would drift. This test is the proof that the
    // inheritance actually holds for the fleet-wide bulk path, not an
    // assumption that calling the helper is enough.
    await makePinGroup('ag-other-grp', 'claude');
    const mine = await makePinnedTask('ag-1', 'mine', { effort: 'high' });
    const theirs = await makePinnedTask('ag-other-grp', 'theirs', { effort: 'high' });

    const r = await repin({ group: 'ag-1', session: theirs.session_id, from_effort: 'high', to_effort: 'xhigh' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('belongs to agent group');

    // Neither group's pin moved.
    expect(storedTaskPin('ag-other-grp', theirs.session_id, theirs.series_id)).toEqual({ turnEffort: 'high' });
    expect(storedTaskPin('ag-1', mine.session_id, mine.series_id)).toEqual({ turnEffort: 'high' });
  });

  it('the durable audit row records the MERGED pin, not a cleared axis', async () => {
    // updateTask merges, so an untouched axis survives. Recording it as null
    // says the pin was cleared — a wrong audit row is worse than none when
    // someone is reconstructing an incident.
    const t = await makePinnedTask('ag-1', 'audited', { model: 'claude-sonnet-5', effort: 'xhigh' });
    expect((await repin({ group: 'ag-1', from_model: 'claude-sonnet-5', to_model: 'claude-opus-5[1m]' })).ok).toBe(
      true,
    );

    const row = getRawDb()
      .prepare("SELECT detail_json FROM scheduled_audit WHERE series_id = ? AND action = 'update' ORDER BY id DESC")
      .get(t.series_id) as { detail_json: string };
    const detail = JSON.parse(row.detail_json) as { repin: { to: { model: string; effort: string } } };
    expect(detail.repin.to).toEqual({ model: 'claude-opus-5[1m]', effort: 'xhigh' });
  });

  describe('contradictory inputs are refused, never silently reconciled', () => {
    // One class, three instances. Silently picking a winner is indefensible
    // because both readings are plausible to the caller, so whichever the code
    // drops was — half the time — the one that was meant, and the command
    // reports success either way.

    it('--target-provider requires --group: fleet-wide it would strand pins it was built to fix', async () => {
      await makePinGroup('ag-cx2', 'codex');
      const codexTask = await makePinnedTask('ag-cx2', 'cx', { model: 'gpt-6-astra' });
      // ag-1 is a claude group, so its pin must be claude vocabulary — `create`
      // rejects a codex id here, which is the create-time half already working.
      const claudeTask = await makePinnedTask('ag-1', 'cl', { model: 'claude-sonnet-5' });

      const r = await repin({
        all: true,
        target_provider: 'claude',
        from_model: 'gpt-6-astra',
        to_model: 'claude-sonnet-5',
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('--target-provider requires --group');

      // Without the guard this wrote a Claude model id onto a CODEX group's
      // series and reported success — the stranded-pin condition this PR exists
      // to prevent, manufactured by the remediation tool.
      expect(storedTaskPin('ag-cx2', codexTask.session_id, codexTask.series_id)).toEqual({
        turnModel: 'gpt-6-astra',
      });
      expect(storedTaskPin('ag-1', claudeTask.session_id, claudeTask.series_id)).toEqual({
        turnModel: 'claude-sonnet-5',
      });
    });

    it('--all and --session are refused together — the session used to silently win', async () => {
      const r = await repin({ all: true, session: 'sess-anything', from_effort: 'high', to_effort: 'xhigh' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('contradictory scopes');
      expect(r.error.message).toContain('--session alone is already a complete scope');
    });

    it('--session alone IS a complete scope — the refusal message promises that', async () => {
      // Self-caught: the `--all`/`--session` refusal I added tells the operator
      // "--session alone is already a complete scope", while the scope check
      // above it rejected exactly that. An error message that instructs you to
      // do something the code forbids is worse than no message.
      const t = await makePinnedTask('ag-1', 'sess-scope', { effort: 'high' });
      const r = await repin({ session: t.session_id, from_effort: 'high', to_effort: 'xhigh' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((r.data as { applied: number }).applied).toBe(1);
      expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnEffort: 'xhigh' });
    });

    it('an EMPTY flag does not read as absent — the guard defeated by its own presence test', async () => {
      // `str('')` is undefined, so `--group ""` used to read as "no group" and
      // skip the contradiction guard entirely, silently widening a scoped repin
      // to FLEET-WIDE. Same for `--all --session ""`. Fails open, which is the
      // dangerous direction.
      const empties: Array<Record<string, unknown>> = [
        { group: '', all: true, from_effort: 'high', to_effort: 'xhigh' },
        { all: true, session: '', from_effort: 'high', to_effort: 'xhigh' },
      ];
      for (const args of empties) {
        const r = await repin(args);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.message).toContain('without a usable value');
      }

      // `--target-provider ""` never reaches the handler: the registry's own
      // enum validation rejects it first, with a better message than mine.
      // Asserted rather than assumed, so a later change that drops the enum
      // does not silently reopen the empty-flag hole on this flag too.
      const emptyProvider = await repin({
        group: 'ag-1',
        target_provider: '',
        from_effort: 'high',
        to_effort: 'xhigh',
      });
      expect(emptyProvider.ok).toBe(false);
      if (!emptyProvider.ok) expect(emptyProvider.error.message).toContain('--target-provider must be one of');
    });

    it('--group and --all are refused together rather than one silently winning', async () => {
      const r = await repin({ group: 'ag-1', all: true, from_effort: 'high', to_effort: 'xhigh' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('contradictory scopes');
    });
  });

  it('rejects a pin whose axis the parser DROPS rather than errors on', async () => {
    // `-m1 haiku -e1 xhigh` is a WARNING in chat, not an error: the parser
    // applies the model, skips the effort, and the human reads "skipped
    // effort" on screen. A pin has no such reader — it fires unattended for
    // weeks — so "accepted, minus a piece you asked for" is indistinguishable
    // from "accepted" at every later read.
    expect(validateTaskPin({ model: 'haiku', effort: 'xhigh' }, 'claude').error).toContain('dropped by validation');
    expect(validateTaskPin({ model: 'sonnet', effort: 'xhigh' }, 'claude').error).toBeUndefined();

    // And repin must not store the raw request when validation returned
    // something else — that is the round-1 defect reappearing in the fallback.
    const t = await makePinnedTask('ag-1', 'dropaxis', { model: 'claude-sonnet-5', effort: 'xhigh' });
    const r = await repin({
      group: 'ag-1',
      from_model: 'claude-sonnet-5',
      to_model: 'haiku',
      from_effort: 'xhigh',
      to_effort: 'xhigh',
    });
    expect(r.ok).toBe(false);
    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({
      turnModel: 'claude-sonnet-5',
      turnEffort: 'xhigh',
    });
  });

  it("--match-resolved resolves aliases in the TARGET GROUP's vocabulary, not always claude's", async () => {
    // `resolveEffectiveModel` only expands claude family aliases, so a codex
    // group storing `gpt-6-astra` was unreachable via its own alias `astra`.
    await makePinGroup('ag-cxr', 'codex');
    const t = await makePinnedTask('ag-cxr', 'astra-pin', { model: 'gpt-6-astra' });

    const r = await repin({
      group: 'ag-cxr',
      from_model: 'astra',
      to_model: 'gpt-5.6-sol',
      match_resolved: true,
      dry_run: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { matched: number; changes: Array<{ series_id: string }> };
    expect(data.matched).toBe(1);
    expect(data.changes[0].series_id).toBe(t.series_id);
  });

  it('rejects ultracode as a pin instead of silently storing plain xhigh', async () => {
    // The parser represents `ultracode` as turnEffort:'xhigh' PLUS a separate
    // turnUltracode flag; the stored pin carries only the effort. Accepting it
    // would report success and persist `xhigh`, losing what was asked for.
    expect(validateTaskPin({ effort: 'ultracode' }, 'claude').error).toContain('cannot be a task pin');
    expect(validateTaskPin({ effort: 'xhigh' }, 'claude').error).toBeUndefined();

    const t = await makePinnedTask('ag-1', 'uc', { effort: 'high' });
    const r = await repin({ group: 'ag-1', from_effort: 'high', to_effort: 'ultracode' });
    expect(r.ok).toBe(false);
    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnEffort: 'high' });
  });

  it('matches source pins in the CURRENT vocabulary while validating against the TARGET', async () => {
    // The two questions are different: matching asks what vocabulary the stored
    // pin was WRITTEN in (always the group's current provider), validation asks
    // whether the new value will RUN (the target, when migrating). Resolving
    // `astra` with claude's tables because the group is moving to claude finds
    // nothing — the stored value is `gpt-6-astra` in codex's.
    await makePinGroup('ag-mig', 'codex');
    const t = await makePinnedTask('ag-mig', 'mig', { model: 'gpt-6-astra' });

    const r = await repin({
      group: 'ag-mig',
      target_provider: 'claude',
      from_model: 'astra',
      to_model: 'claude-sonnet-5',
      match_resolved: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.data as { applied: number }).applied).toBe(1);
    expect(storedTaskPin('ag-mig', t.session_id, t.series_id)).toEqual({ turnModel: 'claude-sonnet-5' });
    // ...and that is what clears the migration the audit refuses.
    expect((await configUpdate({ id: 'ag-mig', provider: 'claude' })).ok).toBe(true);
  });

  it('reports partial completion rather than claiming the write phase is atomic', async () => {
    // Validation is all-or-nothing; the WRITE cannot be — each series lives in
    // its own session database, so there is no transaction spanning them and no
    // honest rollback. The command must therefore say exactly what landed.
    const a = await makePinnedTask('ag-1', 'p1', { effort: 'high' });
    const b = await makePinnedTask('ag-1', 'p2', { effort: 'high' });
    const r = await repin({ group: 'ag-1', from_effort: 'high', to_effort: 'xhigh' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data as { applied: number; failed: unknown[] };
    expect(data.applied).toBe(2);
    // `failed` is always present, so a caller reading it cannot mistake
    // "partial" for "complete" just because nothing failed this time.
    expect(data.failed).toEqual([]);
    for (const t of [a, b]) {
      expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({ turnEffort: 'xhigh' });
    }
  });

  it('an effort-only repin leaves the model pin literally untouched', async () => {
    // The merged-validation fix must not become a merged-REWRITE: resolving the
    // untouched axis would turn the family alias `sonnet` (tracks the install
    // default) into a frozen id nobody asked to freeze.
    const t = await makePinnedTask('ag-1', 'alias-keep', { model: 'sonnet', effort: 'high' });
    const r = await repin({ group: 'ag-1', from_effort: 'high', to_effort: 'xhigh' });
    expect(r.ok).toBe(true);
    expect(storedTaskPin('ag-1', t.session_id, t.series_id)).toEqual({
      turnModel: 'sonnet',
      turnEffort: 'xhigh',
    });
  });
});
