import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { getRecoverableLifecycleStatus } from './lookups.js';

/**
 * getRecoverableLifecycleStatus's SQL admits only rows SQLite calls
 * json_valid, and on SQLite 3.49 that set parses in JSON.parse too (JSON5,
 * trailing commas and raw control characters are rejected by both) — so a
 * real database cannot hand it an unparseable row. The skip still has to
 * hold if the two parsers ever disagree: one bad row must not throw out of
 * delivery recovery or hide a recoverable row behind it. Stub handles are the
 * only way to present that row, so this drives the op with them directly.
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
