/**
 * Agent-to-agent parity with a normally-engaged session.
 *
 * A2A wakes a target session directly instead of going through router.ts, so
 * three things the channel path does for free had to be done here too:
 * thread-history backfill, central-archive mirroring, and outbound secret
 * scrubbing. These tests pin each one.
 *
 * Own DATA_DIR (not the one agent-route.test.ts uses) — that file's fixed
 * /tmp path collides when two vitest runs overlap.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const TEST_DIR = uniqueTmpRoot('test-a2a-parity');

vi.mock('../../container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../container-runner.js')>();
  const { getSession } = await import('../../db/sessions.js');
  return {
    ...real,
    wakeContainer: vi.fn().mockResolvedValue(true),
    isContainerRunning: vi.fn().mockReturnValue(false),
    getActiveContainerCount: vi.fn().mockReturnValue(0),
    killContainer: vi.fn(),
    // The real definition: the route builds this guard and the wake path is
    // what evaluates it, next to `spawn()`.
    sessionStillActive: (sessionId: string) => () => {
      const fresh = getSession(sessionId);
      if (!fresh) return { ok: false, reason: 'session no longer exists' };
      if (fresh.status !== 'active') return { ok: false, reason: `session is ${fresh.status}` };
      if (fresh.archived_at != null) return { ok: false, reason: 'session is archived' };
      return true;
    },
  };
});

const getChannelAdapter = vi.fn();
vi.mock('../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapter: (key: string) => getChannelAdapter(key),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

// One-shot hook fired inside the return-path lookup — the await that now sits
// between the cross-tenant wiring check and the session it authorizes. Same
// seam shape as `raceCloses` in src/db/scheduled-tasks.test.ts; inert unless a
// test arms it.
const duringReturnPathLookup = vi.hoisted(() => ({ run: null as (() => void) | null }));

vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      const hook = duringReturnPathLookup.run;
      duringReturnPathLookup.run = null;
      hook?.();
      return actual.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

const A = 'ag-src';
const B = 'ag-dst';
const MG = 'mg-slack';
const THREAD = 'thr-42';

function now(): string {
  return new Date().toISOString();
}

async function route(content: string, sourceSessionId: string) {
  const { routeAgentMessage } = await import('./agent-route.js');
  const { getSession } = await import('../../db/sessions.js');
  await routeAgentMessage(
    { id: `out-${Math.random().toString(36).slice(2, 8)}`, platform_id: B, content, in_reply_to: null },
    getSession(sourceSessionId)!,
  );
}

async function targetInbound(): Promise<Array<{ content: string; channel_type: string | null }>> {
  const { getSessionsByAgentGroup } = await import('../../db/sessions.js');
  const { inboundDbPath } = await import('../../mailbox/sqlite/paths.js');
  const sessions = getSessionsByAgentGroup(B);
  expect(sessions.length).toBeGreaterThanOrEqual(1);
  const db = new Database(inboundDbPath(B, sessions[0].id), { readonly: true });
  const rows = db
    .prepare("SELECT content, channel_type FROM messages_in WHERE kind = 'chat' ORDER BY seq")
    .all() as Array<{ content: string; channel_type: string | null }>;
  db.close();
  return rows;
}

function archiveRows(): Array<Record<string, string | null>> {
  const db = new Database(path.join(TEST_DIR, 'archive.db'), { readonly: true });
  const rows = db.prepare('SELECT * FROM messages_archive ORDER BY rowid').all() as Array<
    Record<string, string | null>
  >;
  db.close();
  return rows;
}

describe('a2a parity with a normally-engaged session', () => {
  let sourceSessionId: string;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    getChannelAdapter.mockReset();
    getChannelAdapter.mockReturnValue(undefined);

    const { initTestDb, runMigrations, createAgentGroup } = await import('../../db/index.js');
    const { createMessagingGroup } = await import('../../db/messaging-groups.js');
    const { getRawDb } = await import('../../db/connection.js');
    const { resolveSession } = await import('../../session-manager.js');

    await initTestDb();
    const db = getRawDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'Source Agent', folder: 'src-agent', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'Target Agent', folder: 'dst-agent', agent_provider: null, created_at: now() });
    createMessagingGroup({
      id: MG,
      channel_type: 'slack',
      platform_id: 'C-GENERAL',
      name: 'General',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    // Target wired to the same chat — without this the route falls back to an
    // agent-shared session with no chat surface (the cross-tenant gate).
    getRawDb()
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope,
           ignored_message_policy, session_mode, priority, created_at)
         VALUES ('mga-1', ?, ?, 'mention', 'all', 'drop', 'per-thread', 0, ?)`,
      )
      .run(MG, B, now());
    getRawDb()
      .prepare(
        `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
         VALUES (?, 'target', 'agent', ?, ?)`,
      )
      .run(A, B, now());

    sourceSessionId = resolveSession(A, MG, THREAD, 'per-thread').session.id;
  });

  afterEach(async () => {
    const { closeDb } = await import('../../db/index.js');
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('backfills platform thread history on a fresh target session, like a mention wake', async () => {
    const fetchThreadHistory = vi.fn().mockResolvedValue([
      { sender: 'Operator', text: 'the invoice job is failing again', timestamp: now() },
      { sender: 'Source Agent', text: 'looking at it', timestamp: now() },
    ]);
    getChannelAdapter.mockReturnValue({ fetchThreadHistory });

    await route(JSON.stringify({ text: 'take over the invoice job' }), sourceSessionId);

    expect(fetchThreadHistory).toHaveBeenCalledWith(THREAD, { limit: 50, excludeMessageId: undefined });
    const rows = await targetInbound();
    expect(rows).toHaveLength(1);
    const text = JSON.parse(rows[0].content).text as string;
    expect(text).toContain('[Thread context]');
    expect(text).toContain('Operator: the invoice job is failing again');
    expect(text).toContain('[Latest message]\ntake over the invoice job');
  });

  it('does not backfill for an agent-shared target (no chat surface to read)', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    getRawDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(B);
    const fetchThreadHistory = vi.fn().mockResolvedValue([{ sender: 'Operator', text: 'hi', timestamp: now() }]);
    getChannelAdapter.mockReturnValue({ fetchThreadHistory });

    await route(JSON.stringify({ text: 'do the thing' }), sourceSessionId);

    expect(fetchThreadHistory).not.toHaveBeenCalled();
    const rows = await targetInbound();
    expect(JSON.parse(rows[0].content).text).toBe('do the thing');
  });

  /**
   * The cross-tenant wiring gate must hold when the link is MADE, not when the
   * message arrived.
   *
   * `messaging_group_agents` decides whether the target may inherit the
   * caller's chat. The return-path lookup between that check and the session it
   * authorizes became awaiting behind the mailbox seam, so a wiring revoked in
   * the window left a target session bound to a chat the target is no longer
   * authorized for — and a default `send_message` from that session posts into
   * it, which is precisely what the 2026-05-03 cross-tenant audit added this
   * gate to stop.
   */
  it('does not inherit the caller chat when the wiring is revoked during the return-path lookup', async () => {
    const { getRawDb } = await import('../../db/connection.js');
    const fetchThreadHistory = vi.fn().mockResolvedValue([{ sender: 'Operator', text: 'hi', timestamp: now() }]);
    getChannelAdapter.mockReturnValue({ fetchThreadHistory });

    // Revoked inside the lookup, after the pre-check proved it.
    duringReturnPathLookup.run = () => {
      getRawDb().prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(B);
    };

    await route(JSON.stringify({ text: 'do the thing' }), sourceSessionId);

    // Agent-shared, exactly as if the revocation had landed one moment earlier.
    const { getSessionsByAgentGroup } = await import('../../db/sessions.js');
    const targets = getSessionsByAgentGroup(B);
    expect(targets).toHaveLength(1);
    expect(targets[0].messaging_group_id).toBeNull();
    // No chat surface, so no history to backfill from one.
    expect(fetchThreadHistory).not.toHaveBeenCalled();
    const rows = await targetInbound();
    expect(JSON.parse(rows[0].content).text).toBe('do the thing');
  });

  it('routes the message even when the thread-history fetch throws', async () => {
    getChannelAdapter.mockReturnValue({
      fetchThreadHistory: vi.fn().mockRejectedValue(new Error('slack 503')),
    });

    await route(JSON.stringify({ text: 'still delivered' }), sourceSessionId);

    const rows = await targetInbound();
    expect(JSON.parse(rows[0].content).text).toBe('still delivered');
  });

  it('mirrors the routed message into the central archive', async () => {
    await route(JSON.stringify({ text: 'index this handoff' }), sourceSessionId);

    const rows = archiveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_group_id: B,
      messaging_group_id: MG,
      channel_type: 'agent',
      platform_id: A,
      thread_id: THREAD,
      role: 'user',
      sender_id: A,
      sender_name: 'Source Agent',
      text: 'index this handoff',
    });
  });

  it('archives what the peer sent, not the backfilled thread transcript', async () => {
    getChannelAdapter.mockReturnValue({
      fetchThreadHistory: vi
        .fn()
        .mockResolvedValue([{ sender: 'Operator', text: 'unrelated chatter', timestamp: now() }]),
    });

    await route(JSON.stringify({ text: 'just my brief' }), sourceSessionId);

    expect(archiveRows()[0].text).toBe('just my brief');
  });

  it('drops an admin slash command from a peer, as the channel gate would', async () => {
    await route(JSON.stringify({ text: '/clear' }), sourceSessionId);
    await route(JSON.stringify({ text: '/files' }), sourceSessionId);

    const { getSessionsByAgentGroup } = await import('../../db/sessions.js');
    expect(getSessionsByAgentGroup(B)).toHaveLength(0);
  });

  it('lets an unrecognised slash command through, like the channel gate', async () => {
    await route(JSON.stringify({ text: '/team-plan the migration' }), sourceSessionId);

    const rows = await targetInbound();
    expect(JSON.parse(rows[0].content).text).toBe('/team-plan the migration');
  });

  it('scrubs registered secrets out of routed content and the archive', async () => {
    const { registerSecrets } = await import('../../secret-scrubber.js');
    registerSecrets({ SOME_API_KEY: 'sk-live-abcdef123456' });

    await route(JSON.stringify({ text: 'use sk-live-abcdef123456 for the call' }), sourceSessionId);

    const rows = await targetInbound();
    const text = JSON.parse(rows[0].content).text as string;
    expect(text).not.toContain('sk-live-abcdef123456');
    expect(text).toContain('[REDACTED]');
    expect(archiveRows()[0].text).not.toContain('sk-live-abcdef123456');
  });
});
