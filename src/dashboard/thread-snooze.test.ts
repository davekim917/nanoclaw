import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getRawDb } from '../db/index.js';
import type { AuthedRequestContext } from './router.js';
import * as userRoles from '../modules/permissions/db/user-roles.js';
import { isSnoozed, readThreadSnoozes, threadSnoozeHandler, threadUnsnoozeHandler } from './thread-snooze.js';

// Same precedent as archive.test.ts, whose gate this one deliberately matches.
vi.mock('../modules/permissions/db/user-roles.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/permissions/db/user-roles.js')>();
  return { ...real, hasAdminPrivilege: vi.fn(() => true) };
});

/**
 * Snooze is the triage mode's `S` verdict, and the one place Phase 3 needed a
 * store that did not exist. These tests pin the two decisions that make it
 * honest rather than a hidden archive:
 *
 *  - it EXPIRES BY ACTIVITY, not by a clock — the whole point is "until it
 *    moves", so a thread that moves is visible again with no sweep involved;
 *  - it is PER USER, so one operator's triage never blanks another's queue;
 *  - it is gated on ADMIN PRIVILEGE even though visibility would do, so this
 *    surface has no lone exception to the privilege every other mutating verb
 *    demands. The reasoning is in thread-snooze.ts's header; this test is what
 *    stops someone loosening it back on the merits.
 */

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function ctx(opts: { userId?: string; no_filter?: boolean; allowed?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: opts.userId ?? 'u1', kind: 'dashboard', display_name: 'u1', created_at: iso(0) },
    scopes: {
      role: opts.no_filter === false ? 'admin_of_group' : 'owner',
      allowed_group_ids: opts.allowed ?? [],
      no_filter: opts.no_filter ?? true,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function seedSession(id: string, agentGroupId: string, threadId: string | null, lastOutboundAt: string): void {
  getRawDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, container_status,
                             last_active, last_outbound_at, created_at)
       VALUES (?, ?, NULL, ?, 'active', 'stopped', ?, ?, ?)`,
    )
    .run(id, agentGroupId, threadId, lastOutboundAt, lastOutboundAt, iso(3_600_000));
}

const post = (): Request => new Request('http://localhost/x', { method: 'POST' });

beforeEach(async () => {
  await closeDb();
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: iso(0) });
  createAgentGroup({ id: 'ag-2', name: 'ag-2', folder: 'ag-2', agent_provider: null, created_at: iso(0) });
  vi.mocked(userRoles.hasAdminPrivilege).mockReturnValue(true);
});

describe('isSnoozed — expiry is a comparison, never a timer', () => {
  it('holds while the thread has not moved', () => {
    expect(isSnoozed('2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z')).toBe(true);
    expect(isSnoozed('2026-08-20T09:00:00.000Z', '2026-08-20T08:00:00.000Z')).toBe(true);
  });

  it('lifts the moment the thread moves', () => {
    expect(isSnoozed('2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.001Z')).toBe(false);
    expect(isSnoozed('2026-08-20T09:00:00.000Z', '2026-08-20T11:00:00.000Z')).toBe(false);
  });

  it('handles a thread that had no activity when it was snoozed', () => {
    expect(isSnoozed(null, null)).toBe(true);
    expect(isSnoozed(null, '2026-08-20T09:00:00.000Z')).toBe(false);
  });

  it('treats an unreadable stamp as no snooze rather than a permanent hide', () => {
    expect(isSnoozed('not-a-date', '2026-08-20T09:00:00.000Z')).toBe(false);
  });
});

describe('the endpoints', () => {
  it('records the thread’s current activity and reads back as snoozed', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    const res = await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as { snoozed_at_activity: string | null }).snoozed_at_activity).toBe(iso(60_000));

    const map = readThreadSnoozes('u1', ['slack:CTESTCHAN01:1700000000.11']);
    expect(isSnoozed(map.get('slack:CTESTCHAN01:1700000000.11'), iso(60_000))).toBe(true);
    // …and once the thread moves, the same row stops hiding it.
    expect(isSnoozed(map.get('slack:CTESTCHAN01:1700000000.11'), iso(0))).toBe(false);
  });

  it('takes the newest activity across every session on the thread', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(600_000));
    seedSession('s-2', 'ag-2', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    const res = await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    expect(((await res!.json()) as { snoozed_at_activity: string | null }).snoozed_at_activity).toBe(iso(60_000));
  });

  it('re-snoozing an already-moved thread re-arms it at the new mark', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(600_000));
    await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    getRawDb().prepare('UPDATE sessions SET last_outbound_at = ? WHERE id = ?').run(iso(0), 's-1');
    await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    const rows = getRawDb().prepare('SELECT * FROM thread_snoozes').all() as { snoozed_at_activity: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snoozed_at_activity).toBe(iso(0));
  });

  it('stores ISO even when the session column it reads is naive', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    // Exactly the shape `bumpLastOutbound` writes — no zone marker. Nothing
    // downstream normalizes this table (053 works off an allowlist), so the
    // write site is the only place that can get it right.
    getRawDb()
      .prepare('UPDATE sessions SET last_outbound_at = ?, last_active = ? WHERE id = ?')
      .run('2026-08-20 06:16:56', '2026-08-20 06:00:00', 's-1');
    await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    const row = getRawDb().prepare('SELECT snoozed_at_activity, created_at FROM thread_snoozes').get() as {
      snoozed_at_activity: string;
      created_at: string;
    };
    expect(row.snoozed_at_activity).toBe('2026-08-20T06:16:56.000Z');
    expect(row.created_at).toMatch(/Z$/);
  });

  it('is per user — one operator’s snooze is invisible to another', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx({ userId: 'u1' }));
    expect(readThreadSnoozes('u2', ['slack:CTESTCHAN01:1700000000.11']).size).toBe(0);
  });

  it('un-snoozes', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    const res = await threadUnsnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    expect(res!.status).toBe(200);
    expect(readThreadSnoozes('u1', ['slack:CTESTCHAN01:1700000000.11']).size).toBe(0);
  });

  it('addresses a session with no platform thread by its synthetic key', async () => {
    seedSession('s-lonely', 'ag-1', null, iso(60_000));
    const res = await threadSnoozeHandler(post(), { id: 'session:s-lonely' }, ctx());
    expect(res!.status).toBe(200);
  });

  it('accepts a percent-encoded thread id', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    const res = await threadSnoozeHandler(post(), { id: encodeURIComponent('slack:CTESTCHAN01:1700000000.11') }, ctx());
    expect(res!.status).toBe(200);
    expect(readThreadSnoozes('u1', ['slack:CTESTCHAN01:1700000000.11']).size).toBe(1);
  });

  it('404s a caller who can see the thread but holds no admin privilege', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    vi.mocked(userRoles.hasAdminPrivilege).mockReturnValue(false);
    const res = await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    expect(res!.status).toBe(404);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_snoozes').get()).toEqual({ n: 0 });

    const un = await threadUnsnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.11' }, ctx());
    expect(un!.status).toBe(404);
  });

  /**
   * The other half of the "attention rows are never snoozed" contract — the
   * list side is pinned in `api/threads.test.ts`. An ownerless item is a board
   * entry with no session behind it, so there is no row for this query to find
   * and no honest activity mark to record against. The console must therefore
   * not offer the verb on those rows at all (`isOwnerlessItem` gates the detail
   * pane's button and Triage's `S`); this is what keeps that a fact about the
   * server rather than a UI convention someone can quietly undo.
   */
  it('404s an ownerless attention item, which has no session to snooze', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    const res = await threadSnoozeHandler(post(), { id: 'board:EXAMPLE-APP#817' }, ctx());
    expect(res!.status).toBe(404);
    const un = await threadUnsnoozeHandler(post(), { id: 'board:EXAMPLE-APP#817' }, ctx());
    expect(un!.status).toBe(404);
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_snoozes').get()).toEqual({ n: 0 });
  });

  it('404s an unknown thread and an out-of-scope one identically (§2a)', async () => {
    seedSession('s-1', 'ag-1', 'slack:CTESTCHAN01:1700000000.11', iso(60_000));
    const unknown = await threadSnoozeHandler(post(), { id: 'slack:CTESTCHAN01:1700000000.99' }, ctx());
    const scoped = await threadSnoozeHandler(
      post(),
      { id: 'slack:CTESTCHAN01:1700000000.11' },
      ctx({ no_filter: false, allowed: ['ag-2'] }),
    );
    expect(unknown!.status).toBe(404);
    expect(scoped!.status).toBe(404);
    expect(await unknown!.json()).toEqual(await scoped!.json());
    expect(getRawDb().prepare('SELECT COUNT(*) AS n FROM thread_snoozes').get()).toEqual({ n: 0 });
  });
});

describe('readThreadSnoozes', () => {
  it('asks for nothing when the page is empty', () => {
    expect(readThreadSnoozes('u1', []).size).toBe(0);
  });
});
