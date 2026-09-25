import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getRecoverableLifecycleStatus, getTaskListSettlement } from './lookups.js';

/**
 * getRecoverableLifecycleStatus's SQL admits only rows SQLite calls
 * json_valid, and on SQLite 3.49 that set parses in JSON.parse too (JSON5,
 * trailing commas and raw control characters are rejected by both) — so a
 * real database cannot hand it an unparseable row. The skip still has to
 * hold if the two parsers ever disagree: one bad row must not throw out of
 * delivery recovery or hide a recoverable row behind it. Stub handles are the
 * only way to present that row, so this drives the op with them directly.
 *
 * The stub routes on the op's literal SQL, so a query edit there must update
 * it deliberately:
 *   - inbound `.get` answers the receipt lookup, recognised by its
 *     `platform_message_id` column (lookups.ts:151-154); the `SELECT 1`
 *     delivered probe (lookups.ts:155) gets `undefined`, i.e. "no later
 *     public message was delivered";
 *   - outbound `.all` answers the candidate scan, recognised by its
 *     `kind = 'status'` filter (lookups.ts:156-165); every other outbound
 *     statement is the later-public-ids `.iterate` (lookups.ts:188-190),
 *     answered empty.
 */
function handles(
  rows: Array<{ id: string; seq: number; content: string; in_reply_to?: string | null }>,
  receipts: Record<string, { platform_message_id: string | null; lifecycle_terminal_at: string | null }>,
): { inbound: Database.Database; outbound: Database.Database } {
  const inbound = {
    prepare: (sql: string) => ({
      get: (id: string) => (sql.includes('platform_message_id') ? receipts[id] : undefined),
    }),
  } as unknown as Database.Database;
  const outbound = {
    prepare: (sql: string) =>
      sql.includes("kind = 'status'")
        ? {
            all: () =>
              rows.map((r) => ({
                channel_type: 'slack',
                platform_id: 'C1',
                thread_id: 'T1',
                in_reply_to: null,
                ...r,
              })),
          }
        : { iterate: () => [] },
  } as unknown as Database.Database;
  return { inbound, outbound };
}

const liveness = JSON.stringify({ reporting: { version: 1, purpose: 'liveness' } });

describe('getRecoverableLifecycleStatus', () => {
  it('skips a row whose content does not parse and recovers the next one, reply anchor included', () => {
    const { inbound, outbound } = handles(
      [
        { id: 'bad', seq: 3, content: '{not json' },
        { id: 'good', seq: 2, content: liveness, in_reply_to: 'msg-7' },
      ],
      {
        bad: { platform_message_id: 'pm-bad', lifecycle_terminal_at: null },
        good: { platform_message_id: 'pm-good', lifecycle_terminal_at: null },
      },
    );
    expect(getRecoverableLifecycleStatus(inbound, outbound)).toEqual({
      outboundId: 'good',
      channelType: 'slack',
      platformId: 'C1',
      threadId: 'T1',
      inReplyTo: 'msg-7',
      platformMessageId: 'pm-good',
    });
  });

  it('answers null when the only candidate does not parse', () => {
    const { inbound, outbound } = handles([{ id: 'bad', seq: 1, content: '{not json' }], {
      bad: { platform_message_id: 'pm-bad', lifecycle_terminal_at: null },
    });
    expect(getRecoverableLifecycleStatus(inbound, outbound)).toBeNull();
  });
});

describe('getTaskListSettlement', () => {
  const killedAt = '2026-09-25T12:00:00.000Z';

  function dbs(taskListValue: string | null): { inbound: Database.Database; outbound: Database.Database } {
    const inbound = new Database(':memory:');
    inbound.exec('CREATE TABLE delivered (message_out_id TEXT, platform_message_id TEXT, status TEXT)');
    const outbound = new Database(':memory:');
    outbound.exec(`
      CREATE TABLE session_state (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE messages_out (id TEXT, kind TEXT, timestamp TEXT, channel_type TEXT, platform_id TEXT, thread_id TEXT);
      INSERT INTO messages_out VALUES ('tl-1', 'task_list', '2026-09-25T11:59:00.000Z', 'slack', 'C1', 'T1');
    `);
    if (taskListValue !== null) {
      outbound.prepare("INSERT INTO session_state (key, value) VALUES ('task_list', ?)").run(taskListValue);
    }
    return { inbound, outbound };
  }

  const liveList = JSON.stringify({ version: 1, touchedAt: '2026-09-25T11:59:30.000Z' });

  it('settles a live list touched before the kill: its undelivered rows go stale', () => {
    const { inbound, outbound } = dbs(liveList);
    expect(getTaskListSettlement(inbound, outbound, killedAt)).toEqual({ staleRowIds: ['tl-1'], edit: null });
  });

  it('treats an unparseable task_list record as nothing to settle instead of throwing', () => {
    const { inbound, outbound } = dbs('{"version": 1, "touchedAt"');
    expect(getTaskListSettlement(inbound, outbound, killedAt)).toBeNull();
  });

  it('treats an outbound DB with no session_state table as nothing to settle instead of throwing', () => {
    const { inbound, outbound } = dbs(liveList);
    outbound.exec('DROP TABLE session_state');
    expect(getTaskListSettlement(inbound, outbound, killedAt)).toBeNull();
  });
});
