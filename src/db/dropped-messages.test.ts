/**
 * The dropped-sender ledger, on the async driver (seam 3 PR 3).
 *
 * This leaf had no test file before the conversion: it is two statements, and
 * both were synchronous one-liners. Converting them to `DbDriver.run/all`
 * changes how the parameters reach better-sqlite3 — `recordDroppedMessage`
 * passes a NAMED-parameter object through the driver's single-object overload
 * and `getUnregisteredSenders` passes a positional `?`. A regression there
 * (wrong overload, dropped binding) would be invisible until an operator read
 * an empty `ncl dropped-messages list`, so both shapes are pinned here.
 *
 * Everything below runs on `getDb()`. The raw handle is deliberately not used:
 * this file is new, and `src/db/raw-db-ratchet.test.ts` only ever shrinks. The
 * schema comes from migration 008 itself rather than a restated CREATE TABLE,
 * so the fixture cannot drift from the live one.
 */
import type Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './index.js';
import { migration008 } from './migrations/008-dropped-messages.js';
import { getUnregisteredSenders, recordDroppedMessage } from './dropped-messages.js';

/** Migration 008's `up` only ever calls `exec`, so a recorder captures its exact DDL. */
function migration008Ddl(): string {
  const statements: string[] = [];
  migration008.up({ exec: (sql: string) => statements.push(sql) } as unknown as Database.Database);
  return statements.join('\n');
}

type Drop = Parameters<typeof recordDroppedMessage>[0];

const drop = (over: Partial<Drop> = {}): Drop => ({
  channel_type: 'slack',
  platform_id: 'C-1',
  user_id: null,
  sender_name: 'Someone',
  reason: 'no_agent_wired',
  messaging_group_id: 'mg-1',
  agent_group_id: null,
  ...over,
});

describe('the dropped-sender ledger', () => {
  beforeEach(async () => {
    await initTestDb();
    await getDb().exec(migration008Ddl());
  });
  afterEach(() => closeDb());

  it('records a first drop with every named parameter bound', async () => {
    await recordDroppedMessage(drop());

    const [row] = await getUnregisteredSenders();
    expect(row.channel_type).toBe('slack');
    expect(row.platform_id).toBe('C-1');
    expect(row.sender_name).toBe('Someone');
    expect(row.reason).toBe('no_agent_wired');
    expect(row.messaging_group_id).toBe('mg-1');
    expect(row.message_count).toBe(1);
    expect(row.first_seen).toBe(row.last_seen);
  });

  it('aggregates repeat drops from one (channel_type, platform_id) onto a single counted row', async () => {
    await recordDroppedMessage(drop());
    await recordDroppedMessage(drop({ user_id: 'U-9', reason: 'no_agent_engaged' }));

    const rows = await getUnregisteredSenders();
    expect(rows).toHaveLength(1);
    expect(rows[0].message_count).toBe(2);
    // The upsert keeps the newest reason and fills a previously-null user id.
    expect(rows[0].reason).toBe('no_agent_engaged');
    expect(rows[0].user_id).toBe('U-9');
  });

  it('lists newest-first and honours the positional LIMIT parameter', async () => {
    await recordDroppedMessage(drop({ platform_id: 'C-1' }));
    await recordDroppedMessage(drop({ platform_id: 'C-2' }));
    await recordDroppedMessage(drop({ platform_id: 'C-3' }));
    // last_seen comes from Date.now() and three drops can share a millisecond,
    // so the ordering fixture is written explicitly rather than by wall clock.
    for (const [platformId, lastSeen] of [
      ['C-1', '2026-08-01T00:00:00.000Z'],
      ['C-2', '2026-08-03T00:00:00.000Z'],
      ['C-3', '2026-08-02T00:00:00.000Z'],
    ]) {
      await getDb().run(`UPDATE unregistered_senders SET last_seen = ? WHERE platform_id = ?`, lastSeen, platformId);
    }

    expect((await getUnregisteredSenders()).map((r) => r.platform_id)).toEqual(['C-2', 'C-3', 'C-1']);
    expect((await getUnregisteredSenders(2)).map((r) => r.platform_id)).toEqual(['C-2', 'C-3']);
  });
});
