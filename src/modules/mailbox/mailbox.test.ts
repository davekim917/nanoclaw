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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` runs before imports and mocks. The global test setup installs
// uniqueTmpRoot before this module loads, so the mock can use this per-run root.
const { TEST_ROOT } = vi.hoisted(() => ({
  TEST_ROOT: globalThis.uniqueTmpRoot('mailbox-module-test'),
}));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: `${TEST_ROOT}/data`,
}));

vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

import { getAgentMailbox } from '../../mailbox/index.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import type { InboundMessage, MailboxSessionKey } from '../../mailbox/types.js';
import {
  hostInboundDirFor,
  inboundDbIsHostOwned,
  migrateInboundDbToHostDir,
  resolveInboundDbPath,
} from './host-inbound.js';
import { SessionDbMissingError } from './openers.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import { shouldReapIdleTaskContainer } from '../sweep-idle-reap/index.js';
import { decideStuckAction } from '../sweep-container-health/index.js';
import { withExistingNanoclawOutbound } from './index.js';
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

// A real central DB: `destroy()` forgets the session's host-inbound provenance
// record there (migration 079), and the migration the destroy case drives reads
// and writes it too.
beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await initMigratedTestDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// The per-test cleanup above already removes the root; this is the final sweep
// so a crashed or skipped case cannot leave this process's root behind.
afterAll(() => {
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
        INSERT INTO delivered (message_out_id, delivered_at)
        VALUES ('legacy-existing', '2026-01-01T00:00:00.000Z');
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
    expect(columnsAfter).toContain('lifecycle_terminal_at');
    expect(deliveredIds.has('out-1')).toBe(true);
    expect(deliveredIds.has('legacy-existing')).toBe(true);
    expect(
      raw(inbound, (db) =>
        db
          .prepare('SELECT message_out_id, delivered_at FROM delivered WHERE message_out_id = ?')
          .get('legacy-existing'),
      ),
    ).toEqual({ message_out_id: 'legacy-existing', delivered_at: '2026-01-01T00:00:00.000Z' });
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
      expect(m.markLifecycleTerminal('out-42')).toBe(true);
    });

    const firstTerminalAt = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT lifecycle_terminal_at FROM delivered WHERE message_out_id = ?').pluck().get('out-42'),
    ) as string;
    await mailbox.session(key, async (mailboxSession) => {
      expect(fork(mailboxSession).markLifecycleTerminal('out-42')).toBe(true);
    });

    const row = raw(dbPath(key, 'inbound'), (db) =>
      db
        .prepare(
          'SELECT status, platform_message_id, error, lifecycle_terminal_at FROM delivered WHERE message_out_id = ?',
        )
        .get('out-42'),
    ) as { status: string; platform_message_id: string | null; error: string | null; lifecycle_terminal_at: string };
    expect(row).toMatchObject({ status: 'delivered', platform_message_id: 'p1', error: null });
    expect(new Date(row.lifecycle_terminal_at).toISOString()).toBe(row.lifecycle_terminal_at);
    expect(row.lifecycle_terminal_at).toBe(firstTerminalAt);
    // An old reader names only the columns it knows. The additive field is ignored.
    expect(
      raw(dbPath(key, 'inbound'), (db) =>
        db.prepare('SELECT status, platform_message_id, error FROM delivered WHERE message_out_id = ?').get('out-42'),
      ),
    ).toEqual({ status: 'delivered', platform_message_id: 'p1', error: null });
  });

  /**
   * Every timestamp a JS writer puts in a session DB is ISO-8601 UTC.
   *
   * `datetime('now')` yields the naive `YYYY-MM-DD HH:MM:SS` shape, which
   * `new Date()` misparses as LOCAL time and which sorts below ISO as TEXT.
   * `markPending` wrote that into the same `delivered_at` column its two
   * siblings fill with bound ISO, so a still-pending row compared and ordered
   * differently from a resolved one.
   */
  it('markPending writes delivered_at as ISO, like its siblings', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    await mailbox.session(key, async (mailboxSession) => {
      const m = fork(mailboxSession);
      m.markPending('out-iso-pending');
      m.markPending('out-iso-resolved');
      m.markDelivered('out-iso-resolved', 'p1');
    });

    const rows = raw(dbPath(key, 'inbound'), (db) =>
      db.prepare('SELECT message_out_id, delivered_at FROM delivered ORDER BY message_out_id').all(),
    ) as Array<{ message_out_id: string; delivered_at: string }>;
    for (const row of rows) {
      expect(row.delivered_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isNaN(Date.parse(row.delivered_at))).toBe(false);
    }
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

  /**
   * The mirror cohort, and the invariant three review findings on this PR were
   * circling: an outbound-only session — inbound.db gone, outbound.db present.
   *
   * `exists()` is inbound-keyed, so the mailbox-session funnel cannot see this
   * session at all and answers `undefined`. Every caller that read
   * outbound-owned state through it therefore reported that state as EMPTY
   * when it was not. The outbound-keyed funnel asks the question that matches
   * the file it touches, and reads the row.
   */
  it('the outbound funnel reads an outbound-only session the mailbox funnel cannot see', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    raw(dbPath(key, 'outbound'), (db) =>
      db
        .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
        .run(
          'done_proposal',
          JSON.stringify({ reason: 'done here', proposed_at: new Date().toISOString() }),
          new Date().toISOString(),
        ),
    );
    // The host-owned half goes; the container's half stays.
    fs.rmSync(dbPath(key, 'inbound'));

    // The inbound-keyed funnel is blind to it.
    expect(await getAgentMailbox().exists(key)).toBe(false);
    expect(
      await withExistingMailboxSession(key.agentGroupId, key.sessionId, (m) => fork(m).readDoneProposal()),
    ).toBeUndefined();

    // The outbound-keyed one reads the record that is really there.
    const proposal = await withExistingNanoclawOutbound(key.agentGroupId, key.sessionId, (outbound) =>
      outbound.readDoneProposal(),
    );
    expect(proposal).toMatchObject({ reason: 'done here' });
  });

  // The funnel closes its handles the moment the action RETURNS, so an async
  // action would resume onto closed handles. Both halves of the refusal are
  // pinned: the compile error a TypeScript caller gets, and the throw that
  // catches everything the types cannot see.
  it('refuses an async action at compile time', () => {
    // Compiled, never CALLED: the assertion is the `@ts-expect-error` below,
    // which fails the build the day an async action stops being an error.
    // Running it would only prove the runtime half, which the next case owns.
    const wouldNotCompile = async (): Promise<void> => {
      // @ts-expect-error an async action needs an extra `never` argument that
      // nothing can supply — this line ceasing to error IS the regression.
      await withExistingNanoclawOutbound('ag-compile', 'sess-compile', async (outbound) => {
        await Promise.resolve();
        return outbound.readDoneProposal();
      });
    };
    expect(typeof wouldNotCompile).toBe('function');
  });

  it('refuses a thenable-returning action at runtime, with the handles closed', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    const asyncAction = (async () => undefined) as unknown as (outbound: unknown) => undefined;
    await expect(withExistingNanoclawOutbound(key.agentGroupId, key.sessionId, asyncAction as never)).rejects.toThrow(
      /requires a synchronous action/,
    );
  });

  it('the outbound funnel answers undefined only when outbound.db is genuinely absent', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    fs.rmSync(dbPath(key, 'outbound'));

    expect(
      await withExistingNanoclawOutbound(key.agentGroupId, key.sessionId, (outbound) => outbound.readDoneProposal()),
    ).toBeUndefined();
    // A read never provisions the file the container owns.
    expect(fs.existsSync(dbPath(key, 'outbound'))).toBe(false);
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
        // Every outbound READ degrades, not just the ones with an obvious
        // caller: `deliverSessionMessages` calls this for every recently active
        // session, and a throw here is caught as `pending`, so its
        // quiet-delivery cache never arms and the sweep reopens and refails the
        // same session on every pass.
        outboundIds: session.listOutboundMessageIds(),
        noticed: session.outboundHasContentLike('anything'),
        answered: session.hasNonStatusReplyTo('m-inbound-only'),
        // These three opened the accessors directly, ignoring the degrade this
        // whole case documents. The reads threw; worse, the CLEAR took the
        // WRITABLE handle and authored the container-owned outbound.db the
        // host must never create (invariant I-10) — checked below.
        proposal: session.readDoneProposal(),
        continuationPresence: session.readContinuationPresence(),
        cleared: session.clearWorkContinuation(),
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
      outboundIds: [],
      noticed: false,
      answered: false,
      proposal: null,
      continuationPresence: null,
      cleared: null,
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
 * `withdrawUnconsumedWake` takes back a restart announcement whose restart did
 * not happen. It may do that ONLY on a proof that no container could have
 * claimed the message, and the inbound row's own `status` is not that proof: a
 * container claims by writing `processing_ack` in `outbound.db`, and the row it
 * claimed stays `pending` in `inbound.db` until a later sweep tick syncs it.
 *
 * These run the real op over real session files, because the thing under test
 * is a read that crosses from inbound.db to outbound.db.
 */
describe('withdrawUnconsumedWake claim proof', () => {
  const NOBODY_OWNS = () => false;

  /** A restart announcement: an `on_wake` trigger plus its recall partner. */
  async function seedWakeRow(key: MailboxSessionKey): Promise<void> {
    const mailbox = getAgentMailbox();
    await mailbox.session(key, (m) =>
      fork(m).insertMessageWithContextIfNew(
        {
          id: 'restart-1',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          platformId: 'ag-1',
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ text: 'Resuming.' }),
          processAfter: null,
          recurrence: null,
          onWake: 1,
        },
        {
          id: 'recall-restart-1',
          kind: 'system',
          timestamp: new Date().toISOString(),
          platformId: 'ag-1',
          channelType: 'agent',
          threadId: null,
          content: JSON.stringify({ subtype: 'recall_context' }),
          processAfter: null,
          recurrence: null,
          trigger: 0,
        },
      ),
    );
  }

  function inboundIds(key: MailboxSessionKey): string[] {
    return raw(dbPath(key, 'inbound'), (db) =>
      (db.prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>).map((r) => r.id),
    );
  }

  it('withdraws the row and its recall partner when nothing could have claimed it', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    await seedWakeRow(key);

    const withdrawn = await getAgentMailbox().session(key, (m) =>
      fork(m).withdrawUnconsumedWake('restart-1', NOBODY_OWNS),
    );

    expect(withdrawn).toBe(true);
    expect(inboundIds(key)).toEqual([]);
  });

  /**
   * The interleave Codex reported. A replacement container claims the row
   * between the write and the withdrawal; its claim lands in `outbound.db`, and
   * `messages_in.status` is STILL `pending` because no sweep tick has synced it
   * yet. The guarded DELETE alone would match and destroy the message the
   * replacement is about to act on.
   */
  it('preserves a row a container has already claimed, while inbound still reads pending', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    await seedWakeRow(key);

    // The container's claim — written where a container writes it. Planted
    // raw because the host owns no op that writes outbound processing_ack.
    raw(dbPath(key, 'outbound'), (db) => {
      db.prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)').run(
        'restart-1',
        'processing',
        new Date().toISOString(),
      );
    });
    // The precondition that makes this case interesting rather than trivial.
    expect(
      raw(
        dbPath(key, 'inbound'),
        (db) =>
          (db.prepare('SELECT status FROM messages_in WHERE id = ?').get('restart-1') as { status: string }).status,
      ),
    ).toBe('pending');

    const withdrawn = await getAgentMailbox().session(key, (m) =>
      fork(m).withdrawUnconsumedWake('restart-1', NOBODY_OWNS),
    );

    expect(withdrawn).toBe(false);
    expect(inboundIds(key)).toEqual(['recall-restart-1', 'restart-1']);
  });

  it('preserves the row while a container owns outbound.db, ack or no ack', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    await seedWakeRow(key);

    // No ack yet: a fresh replacement mid-first-poll has selected the row and
    // not written its claim. Ownership is the only thing that can see it.
    const withdrawn = await getAgentMailbox().session(key, (m) =>
      fork(m).withdrawUnconsumedWake('restart-1', () => true),
    );

    expect(withdrawn).toBe(false);
    expect(inboundIds(key)).toEqual(['recall-restart-1', 'restart-1']);
  });

  it('preserves the row when outbound.db is present but unopenable', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    await seedWakeRow(key);

    // Present, so the absent-outbound shortcut does not apply, and not a
    // database, so the ack read cannot answer. Unprovable means preserve.
    fs.writeFileSync(dbPath(key, 'outbound'), 'not a database at all');

    const withdrawn = await getAgentMailbox().session(key, (m) =>
      fork(m).withdrawUnconsumedWake('restart-1', NOBODY_OWNS),
    );

    expect(withdrawn).toBe(false);
    expect(inboundIds(key)).toEqual(['recall-restart-1', 'restart-1']);
  });

  it('withdraws when the session has no outbound.db at all — no container has ever run', async () => {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    await seedWakeRow(key);
    fs.rmSync(dbPath(key, 'outbound'));

    const withdrawn = await getAgentMailbox().session(key, (m) =>
      fork(m).withdrawUnconsumedWake('restart-1', NOBODY_OWNS),
    );

    expect(withdrawn).toBe(true);
    expect(inboundIds(key)).toEqual([]);
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

/**
 * Cross-process contract for the one reaper term the host cannot derive on its
 * own. A due inbound row, a processing claim and a work_continuation record are
 * all host-visible; `provider_executing` is the container telling the host it is
 * busy during work that shows up in none of them — the pre-task script batch and
 * every turn after the first one in a stream. The write side lives in
 * container/agent-runner/src/modules/mailbox/container-state.ts and its own
 * tests pin it; this pins that the host's module-side reader sees what that
 * writer wrote. Both ends name the literal column, so a rename on either side
 * goes red on its own test.
 */
describe('provider_executing across the container to host seam', () => {
  // Byte-identical to the runner's publishProviderExecuting UPSERT.
  const busyUpsert =
    'INSERT INTO container_state (id, provider_executing, updated_at) VALUES (1, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET provider_executing = excluded.provider_executing, ' +
    'updated_at = excluded.updated_at';

  it('keeps a task container the runner flagged busy, and reaps it once the flag clears', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    // Exactly what the runner writes when it enters an unclaimed work window
    // (a pre-task script, a pushed follow-up turn, a durable continuation).
    raw(dbPath(key, 'outbound'), (db) => db.prepare(busyUpsert).run(1, new Date().toISOString()));

    const busy = await mailbox.session(key, (m) => fork(m).getContainerState());
    expect(busy?.provider_executing).toBe(1);
    // Nothing due, nothing claimed, no continuation — every other term says
    // "idle", which is precisely the mid-work kill this guards.
    expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, busy?.provider_executing === 1, false)).toBe(false);

    raw(dbPath(key, 'outbound'), (db) => db.prepare(busyUpsert).run(0, new Date().toISOString()));

    const idle = await mailbox.session(key, (m) => fork(m).getContainerState());
    expect(idle?.provider_executing).toBe(0);
    // The reaper's purpose is intact: a container that finished still goes.
    expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, idle?.provider_executing === 1, false)).toBe(true);
  });

  it('reads the flag on the wider shape a booted container leaves behind', async () => {
    const key = freshKey();
    const mailbox = getAgentMailbox();
    mailbox.prepare(key);

    // The case above is a session the host prepared and no container has
    // booted yet. In production the host reads this row only while a container
    // is alive, and that container's own ensureNanoclawOutboundSchema has
    // added the provider and memory columns — a different read tier. Pin both,
    // so narrowing the tier list cannot take the flag away from either.
    raw(dbPath(key, 'outbound'), (db) => {
      for (const column of [
        'provider_status TEXT',
        'provider_last_event_at TEXT',
        'provider_last_probe_at TEXT',
        'provider_probe_failures INTEGER',
        'provider_recovery_attempts INTEGER',
        'provider_failure_reason TEXT',
        'memory_current_bytes INTEGER',
        'memory_peak_bytes INTEGER',
        'memory_max_bytes INTEGER',
        'memory_oom_events INTEGER',
        'memory_oom_kill_events INTEGER',
        'memory_max_events INTEGER',
        'memory_telemetry_at TEXT',
      ]) {
        db.exec(`ALTER TABLE container_state ADD COLUMN ${column}`);
      }
      db.prepare(busyUpsert).run(1, new Date().toISOString());
    });

    const busy = await mailbox.session(key, (m) => fork(m).getContainerState());
    expect(busy?.provider_executing).toBe(1);
    expect(shouldReapIdleTaskContainer('system:tasks:task-1', 0, 0, busy?.provider_executing === 1, false)).toBe(false);
  });
});

/**
 * `provider_query_event_at` across the same seam, and across runner versions.
 * The column is created by the CONTAINER (its ensureNanoclawOutboundSchema
 * backfill, container/agent-runner/src/modules/mailbox/schema.ts), so after a
 * deploy an adopted container on the old runner snapshot keeps an outbound.db
 * without it. The host must read that DB without throwing and must NOT forgive
 * a claim from it: the old claim rule applies until the container respawns
 * onto the new runner.
 */
describe('provider_query_event_at across the container to host seam', () => {
  // The booted shape an older runner leaves behind: every fork column up to
  // memory_max_events, and not the new one.
  const OLD_RUNNER_COLUMNS = [
    'provider_status TEXT',
    'provider_last_event_at TEXT',
    'provider_last_probe_at TEXT',
    'provider_probe_failures INTEGER',
    'provider_recovery_attempts INTEGER',
    'provider_failure_reason TEXT',
    'memory_current_bytes INTEGER',
    'memory_peak_bytes INTEGER',
    'memory_max_bytes INTEGER',
    'memory_oom_events INTEGER',
    'memory_oom_kill_events INTEGER',
    'memory_max_events INTEGER',
    'memory_telemetry_at TEXT',
  ];
  const NOW = Date.parse('2026-09-23T12:00:00.000Z');
  const MIN = 60_000;
  // A mid-turn follow-up claimed 5 min ago; the last provider event (heartbeat)
  // is older than the claim and well inside the ceiling: a long think.
  const claims = [{ message_id: 'm-checkin', status_changed: new Date(NOW - 5 * MIN).toISOString() }];
  const heartbeatMtimeMs = NOW - 8 * MIN;

  function sessionWith(columns: string[], write: (db: Database.Database) => void): MailboxSessionKey {
    const key = freshKey();
    getAgentMailbox().prepare(key);
    raw(dbPath(key, 'outbound'), (db) => {
      for (const column of columns) db.exec(`ALTER TABLE container_state ADD COLUMN ${column}`);
      write(db);
    });
    return key;
  }

  it('an old-runner DB without the column reads cleanly and gives no forgiveness', async () => {
    const key = sessionWith(OLD_RUNNER_COLUMNS, (db) =>
      db
        .prepare('INSERT INTO container_state (id, provider_executing, updated_at) VALUES (1, 1, ?)')
        .run(new Date(NOW).toISOString()),
    );
    const state = await getAgentMailbox().session(key, (m) => fork(m).getContainerState());
    // Read through the next tier down, not an error and not null.
    expect(state?.provider_executing).toBe(1);
    expect(state?.memory_max_events).toBeNull();
    expect(state?.provider_query_event_at).toBeUndefined();
    expect(decideStuckAction({ now: NOW, heartbeatMtimeMs, containerState: state ?? null, claims }).action).toBe(
      'kill-claim',
    );
  });

  it('a new-runner DB with the column stamped forgives the claim; NULL (no event this query) does not', async () => {
    const stamp = (value: string | null) =>
      sessionWith([...OLD_RUNNER_COLUMNS, 'provider_query_event_at TEXT'], (db) =>
        db
          .prepare(
            'INSERT INTO container_state (id, provider_executing, provider_query_event_at, updated_at) VALUES (1, 1, ?, ?)',
          )
          .run(value, new Date(NOW).toISOString()),
      );
    const live = await getAgentMailbox().session(stamp(new Date(NOW - 20 * MIN).toISOString()), (m) =>
      fork(m).getContainerState(),
    );
    expect(live?.provider_query_event_at).toBe(new Date(NOW - 20 * MIN).toISOString());
    expect(decideStuckAction({ now: NOW, heartbeatMtimeMs, containerState: live ?? null, claims })).toEqual({
      action: 'ok',
    });

    const gate = await getAgentMailbox().session(stamp(null), (m) => fork(m).getContainerState());
    expect(gate?.provider_query_event_at).toBeNull();
    expect(decideStuckAction({ now: NOW, heartbeatMtimeMs, containerState: gate ?? null, claims }).action).toBe(
      'kill-claim',
    );
  });
});

describe('prepare() provisions but never migrates — #749', () => {
  /**
   * Migration is the SPAWN path's job, and this pins that it is not also
   * provisioning's.
   *
   * A container's `/workspace` is a read-WRITE bind of the session directory,
   * fixed at spawn, and the read-only `.host` overlay exists only in a mount
   * set built at spawn. Creating `.host/` from `prepare()` would therefore
   * create it UNDERNEATH any container already running — inside that
   * container's writable mount, with no overlay over it — handing it both the
   * host's journal path and the authoritative file. And `prepare()` genuinely
   * runs against live sessions: any in-session task create reaches it
   * (`src/db/scheduled-tasks.ts`), as does the documented-reset re-provision
   * (`src/session-manager.ts`).
   *
   * So a session that has only been provisioned keeps exactly its pre-#749
   * shape, and becomes host-owned at its next spawn instead.
   */
  it('provisions the legacy name and leaves the session NOT host-owned', () => {
    const key = freshKey();
    const sessionPath = path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId);

    getAgentMailbox().prepare(key);

    expect(fs.existsSync(dbPath(key, 'inbound'))).toBe(true);
    expect(fs.existsSync(path.join(sessionPath, '.host'))).toBe(false);
    expect(inboundDbIsHostOwned(sessionPath)).toBe(false);
    // The schema was ensured on the path a host opener will actually resolve,
    // not on a second, empty database under `.host/`.
    expect(resolveInboundDbPath(sessionPath)).toBe(dbPath(key, 'inbound'));
  });

  it('destroy() takes the host-owned directory with it', async () => {
    const key = freshKey();
    const sessionPath = path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId);
    getAgentMailbox().prepare(key);
    // Migrate the way the spawn path does, so there IS a `.host/` to remove.
    await migrateInboundDbToHostDir(sessionPath, key);
    expect(fs.existsSync(hostInboundDirFor(sessionPath))).toBe(true);

    await getAgentMailbox().destroy(key);

    // Upstream's `destroy` only knows the legacy name and its sidecars, so the
    // host-owned copy and its journal sit one level below anything it removes
    // and would otherwise outlive the session that owned them.
    expect(fs.existsSync(hostInboundDirFor(sessionPath))).toBe(false);
    expect(fs.existsSync(dbPath(key, 'inbound'))).toBe(false);
    expect(fs.existsSync(dbPath(key, 'outbound'))).toBe(false);
  });

  it('still does not migrate when re-preparing an already provisioned session', () => {
    const key = freshKey();
    const sessionPath = path.join(DATA_DIR, 'v2-sessions', key.agentGroupId, key.sessionId);
    getAgentMailbox().prepare(key);

    getAgentMailbox().prepare(key);

    expect(fs.existsSync(path.join(sessionPath, '.host'))).toBe(false);
    expect(inboundDbIsHostOwned(sessionPath)).toBe(false);
  });
});
