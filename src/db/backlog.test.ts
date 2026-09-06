/**
 * ship_log / backlog_items / commit_digest_state, on the async driver (seam 3 PR 5d).
 *
 * This leaf had no test file before the conversion. Every export was a
 * synchronous `db.prepare(...).run/get/all` inside a `withCentralSync(() =>
 * withRawDb(...))` belt; PR 5d replaces each with `getDb().run/get/all`, which
 * changes how parameters reach better-sqlite3 — a named-parameter object now
 * goes through the driver's SINGLE-OBJECT overload rather than being handed to
 * a prepared statement directly. A wrong overload or a dropped binding would be
 * invisible to the type checker and would only surface as an empty `ncl
 * backlog` or a silently unwritten ship-log row, so every export's parameter
 * shape is exercised here against a real DB.
 *
 * Everything runs on `getDb()`; the raw handle is deliberately not named
 * (`src/db/raw-db-ratchet.test.ts` only shrinks). The schema comes from
 * migration 015 itself rather than a restated CREATE TABLE, so the fixture
 * cannot drift from the live one.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addBacklogItem,
  addShipLogEntry,
  deleteBacklogItem,
  getBacklog,
  getBacklogItemById,
  getBacklogPaginated,
  getBacklogResolvedSince,
  getCommitDigestState,
  getShipLog,
  getShipLogPaginated,
  getShipLogSince,
  updateBacklogItem,
  upsertCommitDigestState,
  type BacklogItem,
  type ShipLogEntry,
} from './backlog.js';
import { closeDb, getDb, initTestDb } from './index.js';
import { migration015 } from './migrations/015-backlog.js';

/** Migration 015's `up` only ever calls `exec`, so a recorder captures its exact DDL. */
function migration015Ddl(): string {
  const statements: string[] = [];
  migration015.up({ exec: (sql: string) => statements.push(sql) } as unknown as Database.Database);
  return statements.join('\n');
}

const ship = (over: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
  id: 'ship-1',
  agent_group_id: 'ag-1',
  title: 'shipped a thing',
  description: null,
  pr_url: null,
  branch: null,
  tags: null,
  shipped_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

const item = (over: Partial<BacklogItem> = {}): BacklogItem => ({
  id: 'bl-1',
  agent_group_id: 'ag-1',
  title: 'an open item',
  description: null,
  status: 'open',
  priority: 'medium',
  tags: null,
  notes: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  resolved_at: null,
  ...over,
});

describe('the backlog leaf on the async driver', () => {
  beforeEach(async () => {
    await initTestDb();
    await getDb().exec(migration015Ddl());
  });
  afterEach(() => closeDb());

  it('writes and reads back every ship_log column', async () => {
    await addShipLogEntry(
      ship({ description: 'why', pr_url: 'https://example.invalid/pr/1', branch: 'feat/x', tags: 'a,b' }),
    );

    const [row] = await getShipLog('ag-1');
    expect(row.id).toBe('ship-1');
    expect(row.title).toBe('shipped a thing');
    expect(row.description).toBe('why');
    expect(row.pr_url).toBe('https://example.invalid/pr/1');
    expect(row.branch).toBe('feat/x');
    expect(row.tags).toBe('a,b');
    expect(row.shipped_at).toBe('2026-09-01T00:00:00.000Z');
  });

  it('scopes ship_log reads to the agent group and honours the limit', async () => {
    await addShipLogEntry(ship({ id: 'ship-1', shipped_at: '2026-09-01T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'ship-2', shipped_at: '2026-09-02T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'ship-other', agent_group_id: 'ag-2' }));

    expect((await getShipLog('ag-1')).map((r) => r.id)).toEqual(['ship-2', 'ship-1']);
    expect((await getShipLog('ag-1', 1)).map((r) => r.id)).toEqual(['ship-2']);
    expect((await getShipLog('ag-2')).map((r) => r.id)).toEqual(['ship-other']);
  });

  it('paginates ship_log with a total that counts the whole group', async () => {
    await addShipLogEntry(ship({ id: 'ship-1', shipped_at: '2026-09-01T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'ship-2', shipped_at: '2026-09-02T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'ship-3', shipped_at: '2026-09-03T00:00:00.000Z' }));

    expect(await getShipLogPaginated('ag-1', 2, 0)).toEqual({
      data: [expect.objectContaining({ id: 'ship-3' }), expect.objectContaining({ id: 'ship-2' })],
      total: 3,
    });
    expect((await getShipLogPaginated('ag-1', 2, 2)).data.map((r) => r.id)).toEqual(['ship-1']);
    expect(await getShipLogPaginated('ag-empty')).toEqual({ data: [], total: 0 });
  });

  it('reads ship_log from a cutoff, oldest first', async () => {
    await addShipLogEntry(ship({ id: 'old', shipped_at: '2026-08-01T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'mid', shipped_at: '2026-09-01T00:00:00.000Z' }));
    await addShipLogEntry(ship({ id: 'new', shipped_at: '2026-09-02T00:00:00.000Z' }));

    expect((await getShipLogSince('ag-1', '2026-09-01T00:00:00.000Z')).map((r) => r.id)).toEqual(['mid', 'new']);
  });

  it('writes and reads back every backlog_items column', async () => {
    await addBacklogItem(item({ description: 'detail', tags: 'x', notes: 'n', priority: 'high' }));

    const row = await getBacklogItemById('bl-1');
    expect(row).toMatchObject({
      id: 'bl-1',
      agent_group_id: 'ag-1',
      title: 'an open item',
      description: 'detail',
      status: 'open',
      priority: 'high',
      tags: 'x',
      notes: 'n',
      resolved_at: null,
    });
    expect(await getBacklogItemById('bl-missing')).toBeNull();
  });

  it('orders the backlog by priority then recency and filters by status', async () => {
    await addBacklogItem(item({ id: 'low', priority: 'low' }));
    await addBacklogItem(item({ id: 'high', priority: 'high' }));
    await addBacklogItem(item({ id: 'medium', priority: 'medium' }));
    await addBacklogItem(item({ id: 'wip', priority: 'high', status: 'in_progress' }));

    expect((await getBacklog('ag-1')).map((r) => r.id)).toEqual(['high', 'wip', 'medium', 'low']);
    expect((await getBacklog('ag-1', 'in_progress')).map((r) => r.id)).toEqual(['wip']);
    expect((await getBacklog('ag-1', 'open', 2)).map((r) => r.id)).toEqual(['high', 'medium']);
  });

  it('paginates the backlog with and without a status filter', async () => {
    await addBacklogItem(item({ id: 'a', priority: 'high' }));
    await addBacklogItem(item({ id: 'b', priority: 'medium' }));
    await addBacklogItem(item({ id: 'c', priority: 'low', status: 'in_progress' }));

    expect(await getBacklogPaginated('ag-1', undefined, 2, 0)).toEqual({
      data: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })],
      total: 3,
    });
    expect(await getBacklogPaginated('ag-1', 'in_progress')).toEqual({
      data: [expect.objectContaining({ id: 'c' })],
      total: 1,
    });
  });

  it('updates only the supplied fields, stamps updated_at, and reports whether a row changed', async () => {
    await addBacklogItem(item());

    expect(await updateBacklogItem('bl-1', {})).toBe(false);
    expect(await updateBacklogItem('bl-1', { status: 'resolved', resolved_at: '2026-09-03T00:00:00.000Z' })).toBe(true);

    const row = (await getBacklogItemById('bl-1'))!;
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).toBe('2026-09-03T00:00:00.000Z');
    expect(row.title).toBe('an open item');
    expect(row.updated_at).not.toBe('2026-09-01T00:00:00.000Z');
  });

  it('scopes an update and a delete to the owning agent group', async () => {
    await addBacklogItem(item());

    expect(await updateBacklogItem('bl-1', { title: 'stolen' }, 'ag-other')).toBe(false);
    expect((await getBacklogItemById('bl-1'))!.title).toBe('an open item');
    expect(await updateBacklogItem('bl-1', { title: 'mine' }, 'ag-1')).toBe(true);

    expect(await deleteBacklogItem('bl-1', 'ag-other')).toBe(false);
    expect(await deleteBacklogItem('bl-1', 'ag-1')).toBe(true);
    expect(await getBacklogItemById('bl-1')).toBeNull();
  });

  it('reads items resolved since a cutoff, including wont_fix, oldest first', async () => {
    await addBacklogItem(item({ id: 'early', status: 'resolved', resolved_at: '2026-08-01T00:00:00.000Z' }));
    await addBacklogItem(item({ id: 'kept', status: 'resolved', resolved_at: '2026-09-02T00:00:00.000Z' }));
    await addBacklogItem(item({ id: 'wontfix', status: 'wont_fix', resolved_at: '2026-09-01T00:00:00.000Z' }));
    await addBacklogItem(item({ id: 'open' }));

    expect((await getBacklogResolvedSince('ag-1', '2026-09-01T00:00:00.000Z')).map((r) => r.id)).toEqual([
      'wontfix',
      'kept',
    ]);
  });

  it('upserts the commit-digest watermark on the repo path', async () => {
    expect(await getCommitDigestState('/repos/x')).toBeNull();

    await upsertCommitDigestState({
      repo_path: '/repos/x',
      agent_group_id: 'ag-1',
      last_commit_sha: 'aaa',
      last_scan: '2026-09-01T00:00:00.000Z',
    });
    expect(await getCommitDigestState('/repos/x')).toMatchObject({ last_commit_sha: 'aaa', agent_group_id: 'ag-1' });

    await upsertCommitDigestState({
      repo_path: '/repos/x',
      agent_group_id: 'ag-1',
      last_commit_sha: 'bbb',
      last_scan: '2026-09-02T00:00:00.000Z',
    });
    expect(await getCommitDigestState('/repos/x')).toMatchObject({
      last_commit_sha: 'bbb',
      last_scan: '2026-09-02T00:00:00.000Z',
    });
  });
});
