/**
 * Acceptance cases H-2..H-7 and H-11 for the host mailbox module
 * (docs/specs/upstream-mailbox-seam/plan.md §8).
 *
 * Everything runs through the registered mailbox — `getAgentMailbox()` and
 * `withMailboxSession` — never through a raw opener, except where a case has
 * to plant state the host does not write (a legacy table shape, container-side
 * processing acks) or read a column no op exposes.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-mailbox-module-test';

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-mailbox-module-test/data',
}));

vi.mock('../../log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../log.js')>()),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { getAgentMailbox } from '../../mailbox/index.js';
import type { InboundMessage, MailboxSessionKey } from '../../mailbox/types.js';
import { SessionDbMissingError } from './openers.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import { sessionOutboundStorageStat, type NanoclawMailboxSession } from './index.js';

const DATA_DIR = path.join(TEST_ROOT, 'data');

let counter = 0;
function freshKey(): MailboxSessionKey {
  counter += 1;
  return { agentGroupId: `ag-mailbox-${counter}`, sessionId: `s-mailbox-${counter}` };
}

function dbPath(key: MailboxSessionKey, side: 'inbound' | 'outbound'): string {
  return path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId, `${side}.db`);
}

/** Raw read/write helper — only for planting or inspecting state no op exposes. */
function raw<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The fork session type the registered mailbox actually hands to an action. */
function fork(mailbox: unknown): NanoclawMailboxSession {
  return mailbox as NanoclawMailboxSession;
}

/** Upstream's `InboundWrite` shape — the one `MailboxSession.insertMessage` declares. */
const message = (id: string, overrides: Partial<InboundMessage> = {}): InboundMessage => ({
  id,
  kind: 'chat',
  timestamp: new Date().toISOString(),
  platformId: 'slack:C1',
  channelType: 'slack',
  threadId: null,
  content: `content ${id}`,
  processAfter: null,
  recurrence: null,
  ...overrides,
});

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('NanoclawAgentMailbox', () => {
  it('legacy delivered table gains platform_message_id and status after prepare() then session()', async () => {
    const key = freshKey();
    const inbound = dbPath(key, 'inbound');
    fs.mkdirSync(path.dirname(inbound), { recursive: true });
    // A pre-migration session DB: messages_in present, delivered still on its
    // original two-column shape. prepare() must leave it alone (the file
    // exists) and the first session() must migrate it.
    raw(inbound, (db) => {
      db.exec(`
        CREATE TABLE messages_in (
          id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
          status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, tries INTEGER DEFAULT 0,
          platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
        );
        CREATE TABLE delivered (message_out_id TEXT PRIMARY KEY, delivered_at TEXT NOT NULL);
      `);
    });

    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    const deliveredIds = await mailbox.session(key, async (m) => {
      m.markDelivered('out-1', 'p-legacy');
      return m.getDeliveredIds();
    });

    const columnsAfter = raw(inbound, (db) =>
      (db.prepare("PRAGMA table_info('delivered')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    expect(columnsAfter).toContain('platform_message_id');
    expect(columnsAfter).toContain('status');
    expect(deliveredIds.has('out-1')).toBe(true);
  });

  it('a legacy inbound DB missing delivered and session_routing regains them after prepare() and session()', async () => {
    const key = freshKey();
    const inbound = dbPath(key, 'inbound');
    fs.mkdirSync(path.dirname(inbound), { recursive: true });
    // The v1 to v2 migration provisions over a directory whose inbound DB
    // already exists and predates most of the baseline. Skipping provisioning
    // because the file is present leaves a session whose every later spawn
    // fails on `ALTER TABLE session_routing`.
    raw(inbound, (db) => {
      db.exec(`CREATE TABLE messages_in (
        id TEXT PRIMARY KEY, seq INTEGER UNIQUE, kind TEXT NOT NULL, timestamp TEXT NOT NULL,
        status TEXT DEFAULT 'pending', process_after TEXT, recurrence TEXT, tries INTEGER DEFAULT 0,
        platform_id TEXT, channel_type TEXT, thread_id TEXT, content TEXT NOT NULL
      );`);
    });

    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    const tables = raw(inbound, (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const table of ['messages_in', 'delivered', 'destinations', 'session_routing', 'repo_ingress_fence']) {
      expect(tables).toContain(table);
    }

    // The routing write is the op that used to fail on every spawn.
    await mailbox.session(key, async (m) => {
      m.setRouting({ channelType: 'slack', platformId: 'slack:C1', threadId: null });
    });
    expect(
      raw(inbound, (db) =>
        db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing WHERE id = 1').get(),
      ),
    ).toEqual({ channel_type: 'slack', platform_id: 'slack:C1', thread_id: null });
  });

  it('prepare() does not seed the migration memo — the first session() still applies the schema', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    // Hostile state: a table disappears after provisioning. If prepare() had
    // recorded this path in the migration memo, session() would skip the
    // schema and every later op on session_routing would throw.
    raw(dbPath(key, 'inbound'), (db) => db.exec('DROP TABLE session_routing'));

    await mailbox.session(key, async (m) => {
      fork(m).upsertSessionRouting({ channel_type: 'slack', platform_id: 'slack:C1', thread_id: null });
    });

    const routing = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT channel_type, platform_id FROM session_routing WHERE id = 1').get(),
    );
    expect(routing).toEqual({ channel_type: 'slack', platform_id: 'slack:C1' });
  });

  it('inbound and writable outbound handles run journal_mode=DELETE then busy_timeout=5000', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    // Spy AFTER provisioning so only the session()'s own opens are recorded.
    const perHandle = new Map<object, string[]>();
    const original = Database.prototype.pragma;
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      source: string,
      options?: Database.PragmaOptions,
    ) {
      const seen = perHandle.get(this) ?? [];
      seen.push(source);
      perHandle.set(this, seen);
      return original.call(this, source, options as Database.PragmaOptions);
    } as typeof Database.prototype.pragma);

    await mailbox.session(key, async (m) => {
      // Forces both the read-only and the writable outbound handles open.
      m.getContainerState();
      m.deleteOrphanProcessingClaims();
    });

    const sequences = [...perHandle.values()];
    const readWrite = sequences.filter(
      (calls) => calls[0] === 'journal_mode = DELETE' && calls[1] === 'busy_timeout = 5000',
    );
    // Inbound and the writable outbound both take the DELETE-then-timeout pair.
    expect(readWrite.length).toBe(2);
    // The read-only outbound handle sets busy_timeout only — it may not write.
    expect(sequences).toContainEqual(['busy_timeout = 5000']);
  });

  it('fresh session DB has upstream baseline plus fork schema', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);

    const inbound = dbPath(key, 'inbound');
    const tables = raw(inbound, (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    for (const table of ['messages_in', 'delivered', 'destinations', 'session_routing', 'repo_ingress_fence']) {
      expect(tables).toContain(table);
    }

    const columns = (file: string, table: string) =>
      raw(file, (db) =>
        (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name),
      );
    expect(columns(inbound, 'messages_in')).toEqual(
      expect.arrayContaining(['repo_fence_epoch', 'repo_fence_original_trigger', 'series_id', 'trigger', 'on_wake']),
    );
    expect(columns(inbound, 'session_routing')).toEqual(expect.arrayContaining(['spawn_task_id', 'session_id']));
    expect(columns(inbound, 'delivered')).toEqual(expect.arrayContaining(['platform_message_id', 'status', 'error']));
    expect(columns(dbPath(key, 'outbound'), 'container_state')).toContain('provider_executing');

    const triggers = raw(inbound, (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    expect(triggers.sort()).toEqual([
      'messages_in_repo_fence_auto_tag_insert',
      'messages_in_repo_fence_auto_tag_trigger_update',
      'messages_in_repo_fence_insert_guard',
      'messages_in_repo_fence_update_guard',
    ]);

    const indexes = raw(inbound, (db) =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    );
    expect(indexes).toContain('idx_messages_in_series_seq');
  });

  it('markDelivered upserts over a pending row and clears error', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    await mailbox.session(key, async (mailboxSession) => {
      const m = fork(mailboxSession);
      m.markPending('out-42');
      m.markDeliveryFailed('out-42', 'boom');
      m.markDelivered('out-42', 'p1');
    });

    const row = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT status, platform_message_id, error FROM delivered WHERE message_out_id = ?').get('out-42'),
    ) as { status: string; platform_message_id: string | null; error: string | null };
    expect(row).toEqual({ status: 'delivered', platform_message_id: 'p1', error: null });
  });

  it('withMailboxSession throws on same-key nesting and allows other keys', async () => {
    const outer = freshKey();
    const other = freshKey();
    getAgentMailbox().prepare(outer);
    getAgentMailbox().prepare(other);

    await expect(
      withMailboxSession(outer.agentGroupId, outer.sessionId, async () =>
        withMailboxSession(outer.agentGroupId, outer.sessionId, async () => 'unreachable'),
      ),
    ).rejects.toThrow(/Nested mailbox session/);

    const nestedOther = await withMailboxSession(outer.agentGroupId, outer.sessionId, async () =>
      withMailboxSession(other.agentGroupId, other.sessionId, async (m) => m.countDueMessages()),
    );
    expect(nestedOther).toBe(0);
  });

  // A session row can exist with NO mailbox on disk yet — the shape
  // `resolveSession` hands back before anything provisions it. Every read must
  // take `exists()` at face value there; a WRITE on a session the caller is in
  // the middle of creating must not, or it silently drops the write and the
  // caller never learns. That is exactly what happened to the spawn_task_id
  // stamp in orchestrator-dispatch: skipped on a child with no mailbox, which
  // then ran with no way to report progress or completion.
  //
  // Deliberately keyed on the fully-absent shape, not the half-provisioned one
  // (inbound.db present, outbound.db not): `exists()` answers on inbound.db
  // ALONE, so that second shape is PRESENT and its outbound reads degrade to
  // empty — pinned by 'a session with only inbound.db exists' below.
  it('an unprovisioned mailbox is absent to withExistingMailboxSession and provisioned by withMailboxSession', async () => {
    const key = freshKey();
    expect(fs.existsSync(dbPath(key, 'inbound'))).toBe(false);

    const read = await withExistingMailboxSession(key.agentGroupId, key.sessionId, async (m) =>
      fork(m).countDueMessages(),
    );
    expect(read).toBeUndefined();
    // The read did not repair it either — reads never provision.
    expect(fs.existsSync(dbPath(key, 'inbound'))).toBe(false);

    const written = await withMailboxSession(key.agentGroupId, key.sessionId, async (m) => {
      fork(m).setSessionRoutingSpawnTaskId('task-unprovisioned');
      return fork(m).readSessionRouting();
    });
    expect(written).not.toBeUndefined();
    expect(fs.existsSync(dbPath(key, 'outbound'))).toBe(true);
    const routing = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT spawn_task_id FROM session_routing WHERE id = 1').get(),
    ) as { spawn_task_id: string | null };
    expect(routing.spawn_task_id).toBe('task-unprovisioned');
  });

  it('fence holds ingress out of countDueMessages until released with the exact generation', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    const fence = await mailbox.session(key, async (m) => fork(m).activateRepoIngressFence('epoch-1'));
    expect(fence.state).toBe('active');

    await mailbox.session(key, async (m) => {
      // The fork's own insert shape (trigger 0|1) through the same override
      // that accepts upstream's boolean-flag `InboundWrite`.
      await fork(m).insertMessage({
        id: 'm-fenced',
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: 'slack:C1',
        channelType: 'slack',
        threadId: null,
        content: 'content m-fenced',
        processAfter: null,
        recurrence: null,
        trigger: 1,
      });
    });

    // Tagged inert by the AFTER INSERT guard — invisible to the wake count.
    const whileFenced = await mailbox.session(key, async (m) => m.countDueMessages());
    expect(whileFenced).toBe(0);

    const wrongGeneration = await mailbox.session(key, async (m) =>
      fork(m).releaseRepoIngressFence('epoch-1', 'not-the-generation'),
    );
    expect(wrongGeneration).toEqual({ released: false, admittedRows: 0, wakeRequired: false });
    expect(await mailbox.session(key, async (m) => m.countDueMessages())).toBe(0);

    const released = await mailbox.session(key, async (m) =>
      fork(m).releaseRepoIngressFence('epoch-1', fence.generation),
    );
    expect(released.released).toBe(true);
    expect(released.admittedRows).toBe(1);
    expect(released.wakeRequired).toBe(true);
    expect(await mailbox.session(key, async (m) => m.countDueMessages())).toBe(1);

    // The original trigger value is restored, not merely set to 1.
    const row = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT trigger, repo_fence_epoch FROM messages_in WHERE id = ?').get('m-fenced'),
    ) as { trigger: number; repo_fence_epoch: string | null };
    expect(row).toEqual({ trigger: 1, repo_fence_epoch: null });
  });

  it('an unreadable session is present, not vanished — only ENOENT/ENOTDIR report as missing', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    const sessionDir = path.dirname(dbPath(key, 'inbound'));

    // Genuinely gone: both files removed. exists() is false and session()
    // reports the vanished session that sweep/delivery branch on.
    const goneKey = freshKey();
    expect(await mailbox.exists(goneKey)).toBe(false);
    await expect(mailbox.session(goneKey, async () => 'unreachable')).rejects.toBeInstanceOf(SessionDbMissingError);

    // Present but unreadable: the directory cannot be traversed. `existsSync`
    // reports that as absent, which would make container-restart skip the
    // session and leave its ingress unfenced. It must reach the opener and
    // fail there on the real error instead.
    fs.chmodSync(sessionDir, 0o000);
    try {
      expect(await mailbox.exists(key)).toBe(true);
      await expect(mailbox.session(key, async () => 'unreachable')).rejects.not.toBeInstanceOf(SessionDbMissingError);
    } finally {
      fs.chmodSync(sessionDir, 0o700);
    }
  });

  it('a session with only inbound.db exists, and its outbound reads degrade instead of failing', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    // The never-woken cohort: outbound.db is the CONTAINER's file, and a
    // session that never spawned one has only ever had inbound.db. Requiring
    // both files made every read path skip these sessions entirely — their
    // task admission and due-message handling stopped, and a repository
    // transition left their ingress unfenced while it still took host writes.
    fs.rmSync(dbPath(key, 'outbound'));

    expect(await mailbox.exists(key)).toBe(true);

    const observed = await mailbox.session(key, async (m) => {
      const session = fork(m);
      await m.insertMessage(message('m-inbound-only'));
      // Inbound work is unaffected.
      expect(m.countDueMessages()).toBe(1);
      // Nothing outbound blows up; every read answers empty.
      session.syncProcessingAcks();
      return {
        hasOutbound: session.hasOutbound(),
        claims: session.getProcessingClaimRows(),
        containerState: session.getContainerState(),
        continuation: session.readWorkContinuation(),
        barrierAck: session.readRepositoryMountBarrierAck(),
        lastOutboundAt: session.latestOutboundTimestamp(),
        due: session.getDueOutboundMessages(),
        noticed: session.outboundHasContentLike('anything'),
        answered: session.hasNonStatusReplyTo('m-inbound-only'),
      };
    });

    expect(observed).toEqual({
      hasOutbound: false,
      claims: [],
      containerState: null,
      continuation: null,
      barrierAck: null,
      lastOutboundAt: null,
      due: [],
      noticed: false,
      answered: false,
    });
    // The read path did not provision the file it found missing (invariant I-4).
    expect(fs.existsSync(dbPath(key, 'outbound'))).toBe(false);
  });

  it('syncProcessingAcks applies terminal acks from outbound to inbound in one session', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    await mailbox.session(key, async (m) => {
      await m.insertMessage(message('m-done'));
      await m.insertMessage(message('m-script-failed'));
      await m.insertMessage(message('m-untouched'));
    });

    // Container-side rows: the host never writes these.
    raw(dbPath(key, 'outbound'), (db) => {
      const stmt = db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)');
      const now = new Date().toISOString();
      stmt.run('m-done', 'completed', now);
      stmt.run('m-script-failed', 'script-skip:error', now);
      stmt.run('m-untouched', 'processing', now);
    });

    const sessionSpy = vi.spyOn(mailbox, 'session');
    await mailbox.session(key, async (m) => fork(m).syncProcessingAcks());
    expect(sessionSpy).toHaveBeenCalledTimes(1);

    const statuses = raw(dbPath(key, 'inbound'), (db) =>
      Object.fromEntries(
        (db.prepare('SELECT id, status FROM messages_in').all() as Array<{ id: string; status: string }>).map((r) => [
          r.id,
          r.status,
        ]),
      ),
    );
    expect(statuses).toEqual({ 'm-done': 'completed', 'm-script-failed': 'failed', 'm-untouched': 'pending' });
  });
});

/**
 * The named reads PR 3 moved into the module when the delivery family stopped
 * receiving a raw handle (plan §4.5b, invariant I-9). Each op replaced exactly
 * one SELECT a delivery action handler used to run on the loop's handle, so
 * each is pinned against the row shapes those callers depend on.
 */
describe('delivery-family lookups', () => {
  it('getRecentInboundChatSenders returns only chat rows, newest first, capped at the limit', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    await mailbox.session(key, async (m) => {
      await m.insertMessage(message('c-old', { kind: 'chat', timestamp: '2026-01-01T00:00:00.000Z' }));
      await m.insertMessage(message('c-new', { kind: 'chat-sdk', timestamp: '2026-01-02T00:00:00.000Z' }));
      await m.insertMessage(message('t-task', { kind: 'task', timestamp: '2026-01-03T00:00:00.000Z' }));
      await m.insertMessage(message('s-system', { kind: 'system', timestamp: '2026-01-04T00:00:00.000Z' }));
    });

    const all = await mailbox.session(key, (m) => fork(m).getRecentInboundChatSenders(10));
    expect(all.map((r) => r.content)).toEqual(['content c-new', 'content c-old']);
    const capped = await mailbox.session(key, (m) => fork(m).getRecentInboundChatSenders(1));
    expect(capped.map((r) => r.content)).toEqual(['content c-new']);
  });

  it('getChannelDestination resolves a channel by name and ignores other destination types', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    await mailbox.session(key, (m) =>
      fork(m).replaceDestinationRows([
        {
          name: 'ops',
          display_name: 'Ops',
          type: 'channel',
          channel_type: 'slack',
          platform_id: 'slack:C-OPS',
          agent_group_id: null,
        },
        {
          name: 'peer',
          display_name: 'Peer',
          type: 'agent',
          channel_type: 'agent',
          platform_id: 'ag-peer',
          agent_group_id: 'ag-peer',
        },
      ]),
    );

    expect(await mailbox.session(key, (m) => fork(m).getChannelDestination('ops'))).toEqual({
      channel_type: 'slack',
      platform_id: 'slack:C-OPS',
    });
    // An agent destination is not a channel, and an unknown name is not an error.
    expect(await mailbox.session(key, (m) => fork(m).getChannelDestination('peer'))).toBeNull();
    expect(await mailbox.session(key, (m) => fork(m).getChannelDestination('nope'))).toBeNull();
  });

  it('getLatestTaskContent returns the series’ newest task body by timestamp', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    raw(dbPath(key, 'inbound'), (db) => {
      const stmt = db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, series_id, content)
         VALUES (?, ?, 'task', ?, 'pending', 0, ?, ?)`,
      );
      stmt.run('fire-1', 2, '2026-01-01T00:00:00.000Z', 'series-A', JSON.stringify({ threadAnchor: true }));
      stmt.run('fire-2', 4, '2026-01-02T00:00:00.000Z', 'series-A', JSON.stringify({ threadAnchor: false }));
      stmt.run('other', 6, '2026-01-03T00:00:00.000Z', 'series-B', JSON.stringify({ threadAnchor: true }));
    });

    const content = await mailbox.session(key, (m) => fork(m).getLatestTaskContent('series-A'));
    expect(JSON.parse(content!)).toEqual({ threadAnchor: false });
    expect(await mailbox.session(key, (m) => fork(m).getLatestTaskContent('missing'))).toBeNull();
  });

  it('getLatestRoutedTaskRow skips occurrences that carry no route', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    raw(dbPath(key, 'inbound'), (db) => {
      const stmt = db.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, series_id, channel_type, platform_id, content)
         VALUES (?, ?, 'task', ?, 'pending', 0, 'series-S', ?, ?, ?)`,
      );
      stmt.run('routed', 2, '2026-01-01T00:00:00.000Z', 'slack', 'slack:C1', '{"prompt":"older but routed"}');
      // Higher seq, but no route — must not shadow the routed row.
      stmt.run('unrouted', 4, '2026-01-02T00:00:00.000Z', null, null, '{"prompt":"newer, no route"}');
    });

    expect(await mailbox.session(key, (m) => fork(m).getLatestRoutedTaskRow('series-S'))).toEqual({
      channel_type: 'slack',
      platform_id: 'slack:C1',
      content: '{"prompt":"older but routed"}',
    });
    expect(await mailbox.session(key, (m) => fork(m).getLatestRoutedTaskRow('series-none'))).toBeNull();
  });

  it('getInboundRoutingAnchor answers only for rows in this session', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    await mailbox.session(key, async (m) => {
      await m.insertMessage(message('anchor-1', { platformId: 'ag-peer', channelType: 'agent', threadId: null }));
    });

    expect(await mailbox.session(key, (m) => fork(m).getInboundRoutingAnchor('anchor-1'))).toEqual({
      platform_id: 'ag-peer',
      channel_type: 'agent',
      thread_id: null,
      source_session_id: null,
    });
    // The miss is load-bearing: schedule_wake rejects an anchor it cannot find.
    expect(await mailbox.session(key, (m) => fork(m).getInboundRoutingAnchor('elsewhere'))).toBeNull();
  });

  it('listOutboundMessageIds returns every outbound id, due or not', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);
    // Container-side rows: the host never writes messages_out.
    raw(dbPath(key, 'outbound'), (db) => {
      const stmt = db.prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content, deliver_after)
         VALUES (?, ?, 'chat', 'slack:C1', 'slack', '{}', ?)`,
      );
      stmt.run('out-due', '2026-01-01T00:00:00.000Z', null);
      stmt.run('out-later', '2026-01-01T00:00:01.000Z', '2099-01-01T00:00:00.000Z');
    });

    const ids = await mailbox.session(key, (m) => fork(m).listOutboundMessageIds());
    expect(new Set(ids)).toEqual(new Set(['out-due', 'out-later']));
    // Only the undeferred one is due — the pair is what lets the drain tell
    // "nothing outstanding" from "nothing due yet".
    const due = await mailbox.session(key, (m) => fork(m).getDueOutboundMessages());
    expect(due.map((r) => r.id)).toEqual(['out-due']);
  });
});

describe('sessionOutboundStorageStat', () => {
  it('reports mtime and size, and refuses to answer for a missing file or a hot journal', () => {
    const key = freshKey();
    expect(sessionOutboundStorageStat(key.agentGroupId, key.sessionId)).toBeNull();

    getAgentMailbox().prepare(key);
    const stat = sessionOutboundStorageStat(key.agentGroupId, key.sessionId);
    expect(stat).not.toBeNull();
    expect(stat!.size).toBeGreaterThan(0);

    // A hot journal means a rollback is still owed on the file, so the stat is
    // ambiguous and must not arm the quiet gate.
    fs.writeFileSync(`${dbPath(key, 'outbound')}-journal`, 'rollback pending');
    expect(sessionOutboundStorageStat(key.agentGroupId, key.sessionId)).toBeNull();
  });
});
