/**
 * The container-side ncl transport, R3: it used to open both session DBs with
 * bun:sqlite by path. It now goes through the registered mailbox's operations,
 * so this exercises the round trip against the in-memory session pair.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { getAgentMailbox } from '../mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { pollResponse, writeRequest } from './ncl.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('ncl container transport', () => {
  test('ncl transport round-trips a request and response through mailbox operations', async () => {
    const mailbox = getAgentMailbox();
    const requestId = 'cli-r3-round-trip';

    await writeRequest(mailbox, { id: requestId, command: 'groups-list', args: { json: true } });

    const outRow = getOutboundDb().prepare('SELECT * FROM messages_out WHERE id = ?').get(requestId) as {
      seq: number;
      kind: string;
      content: string;
    };
    expect(outRow.kind).toBe('system');
    // Container writes claim odd sequences; the host claims even ones.
    expect(outRow.seq % 2).toBe(1);
    expect(JSON.parse(outRow.content)).toEqual({
      action: 'cli_request',
      requestId,
      command: 'groups-list',
      args: { json: true },
    });

    // The host answers by writing a pending cli_response into inbound.db.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
         VALUES (?, ?, 'system', ?, 'pending', 0, ?)`,
      )
      .run(
        'resp-1',
        2,
        '2026-09-03T00:00:00.000Z',
        JSON.stringify({
          action: 'cli_response',
          requestId,
          frame: { id: requestId, ok: true, data: [{ name: 'acme' }], human: 'acme' },
        }),
      );

    const frame = await pollResponse(mailbox, requestId, 5_000);
    expect(frame).toEqual({ id: requestId, ok: true, data: [{ name: 'acme' }], human: 'acme' });

    // The response row is acked so the agent-runner's poll skips it.
    const ack = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('resp-1') as {
      status: string;
    };
    expect(ack.status).toBe('completed');
  });

  test('pollResponse returns null when no response arrives before the deadline', async () => {
    const mailbox = getAgentMailbox();
    expect(await pollResponse(mailbox, 'cli-never-answered', 10)).toBeNull();
  });
});
