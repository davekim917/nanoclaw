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

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-cli-tasks') }));

import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createSession, findSessionByAgentGroup, getSessionsByAgentGroup, taskThreadId } from '../../db/sessions.js';
import { countDueMessages } from '../../modules/mailbox/ops/sweep.js';
import { initSessionFolder } from '../../session-manager.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { dispatch } from '../dispatch.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';
import './tasks.js';
import '../commands/index.js'; // registers tasks-help for the help-topic test

function now(): string {
  return new Date().toISOString();
}

function createGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function createChatSession(group: string, id: string): void {
  createSession({
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
function createMgSession(group: string, id: string, mgId: string, threadId: string | null = null): void {
  createSession({
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

function createMg(id: string, channelType = 'slack', platformId = 'C123'): void {
  createMessagingGroup({
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
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createGroup('ag-1');
    createGroup('ag-2');
    createChatSession('ag-1', 'chat-1');
    createChatSession('ag-2', 'chat-2');
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it("computes an unscoped --process-after in EACH matched group's timezone", async () => {
    // An unscoped host `tasks update` fans out across every active session,
    // which can span groups whose timezone overrides differ. Computing the
    // instant once from whichever group matched first would write one group's
    // wall-clock reading onto another group's series.
    createGroup('ag-tokyo');
    createGroup('ag-kolkata');
    ensureContainerConfig('ag-tokyo');
    ensureContainerConfig('ag-kolkata');
    updateContainerConfigScalars('ag-tokyo', { timezone: 'Asia/Tokyo' }); // UTC+9, no DST
    updateContainerConfigScalars('ag-kolkata', { timezone: 'Asia/Kolkata' }); // UTC+5:30, no DST

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
      createGroup('ag-honolulu');
      createGroup('ag-tokyo-cap');
      ensureContainerConfig('ag-honolulu');
      ensureContainerConfig('ag-tokyo-cap');
      updateContainerConfigScalars('ag-honolulu', { timezone: 'Pacific/Honolulu' });
      updateContainerConfigScalars('ag-tokyo-cap', { timezone: 'Asia/Tokyo' });

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
    createGroup('ag-terminal-a');
    createGroup('ag-terminal-b');

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
    const sessions = getSessionsByAgentGroup('ag-1');
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
    createMg('mg-1');
    createMgSession('ag-1', 'chan-1', 'mg-1');
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

    expect(findSessionByAgentGroup('ag-1')?.id).toBe('chat-1');
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
      createMg('mg-1');
      createMgSession('ag-1', 'chan-1', 'mg-1');
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
      const session = getDb()
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
      createMg('mg-1');
      createMgSession('ag-1', 'chan-iso', 'mg-1');
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
      const session = getDb()
        .prepare(
          `SELECT messaging_group_id, task_routing_platform_id FROM sessions
            WHERE agent_group_id = 'ag-1' AND thread_id LIKE 'system:tasks:%'`,
        )
        .get() as { messaging_group_id: string | null; task_routing_platform_id: string | null };
      expect(session.task_routing_platform_id).toBeNull();
      expect(session.messaging_group_id).toBeNull();
    });

    it("--thread additionally binds the calling session's own thread", async () => {
      createMg('mg-1');
      createMgSession('ag-1', 'thread-1', 'mg-1', 'thread-xyz');
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
      createMg('mg-1');
      createMgSession('ag-1', 'chan-2', 'mg-1'); // channel-root session, no thread_id
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
      createMg('mg-1');
      createMgSession('ag-1', 'chan-3', 'mg-1');
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
      createMg('mg-1');
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
      createMg('mg-1');
      createMgSession('ag-1', 'chan-4', 'mg-1');
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
  });

  describe('scheduled_audit trail (fleet-hardening Phase 0.2)', () => {
    function auditRows(seriesId: string) {
      return getDb()
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
      createGroup('ag-audit-tokyo');
      createGroup('ag-audit-kolkata');
      ensureContainerConfig('ag-audit-tokyo');
      ensureContainerConfig('ag-audit-kolkata');
      updateContainerConfigScalars('ag-audit-tokyo', { timezone: 'Asia/Tokyo' });
      updateContainerConfigScalars('ag-audit-kolkata', { timezone: 'Asia/Kolkata' });

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
      const kolkataSession = getSessionsByAgentGroup('ag-audit-kolkata').find(
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
        getDb()
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
    expect(lines[0]).toMatch(/SERIES\s+SCHEDULE\s+RUNS\s+FAILED\s+LAST RUN\s+NEXT RUN\s+STATUS\s+AGE\s+PROMPT/);
    expect(lines[1]).toContain('1h'); // AGE column — created 1h ago
    expect(lines[1]).toContain('task-5bbe082a-6298-4699'); // FULL series id — copy-pasteable into `tasks get --id`
    expect(lines[1]).toContain('* * * * *');
    expect(lines[1]).toContain('1m ago'); // 09:04:30 vs 09:05:30
    expect(lines[1]).toContain('in 30s'); // 09:06:00 vs 09:05:30
    expect(lines[1]).toContain('…'); // prompt truncated
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
