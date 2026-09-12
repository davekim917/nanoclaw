/**
 * `platform_msg_id="…"` — the platform-native id of the specific inbound
 * message a row represents (e.g. a Slack `ts`), so the agent can cite the
 * exact message it was answering and an external verifier can check that
 * citation against the platform's own API.
 *
 * `content.platformMsgId` is a host-only field: the host strips it from
 * every write except its own routed-message write (src/host-origin.ts
 * PLATFORM_MSG_ID_FIELD, src/router.ts), so a row carrying it here was
 * written by the host from a genuine inbound event. This suite pokes the
 * field directly into fixture rows (as if a write had slipped past the
 * host-side strip) to prove the RENDERER's own exclusions hold independently
 * of that write-side guarantee.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { formatMessages } from './formatter.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';

const TS = '1699999999.123456';
let seq = 1;

function insert(
  id: string,
  kind: 'chat' | 'chat-sdk' | 'system',
  content: object,
  channelType: string | null = 'slack',
  platformId: string | null = 'slack:chan-1',
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, seq, channel_type, platform_id, content)
       VALUES (?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
    )
    .run(id, kind, new Date().toISOString(), seq++, channelType, platformId, JSON.stringify(content));
}

/** The rendered <message …> opening tag for one row. */
function tagFor(id: string): string {
  const out = formatMessages(getPendingMessages().filter((m) => m.id === id));
  const tag = out.match(/<message[^>]*>/)?.[0];
  expect(tag).toBeDefined();
  return tag!;
}

beforeEach(() => {
  initTestSessionDb();
  seq = 1;
});

afterEach(() => {
  closeSessionDb();
});

describe('platform_msg_id', () => {
  it('renders a Slack message ts', () => {
    insert('slack-1', 'chat', { text: 'hi', sender: 'Alice', senderId: 'U1', platformMsgId: TS });
    expect(tagFor('slack-1')).toContain(`platform_msg_id="${TS}"`);
  });

  it('never appears on a host note (origin="host"), even if content carries the field', () => {
    insert(
      'host-1',
      'chat',
      { text: 'choice resolved', sender: 'system', senderId: 'system', origin: 'host', platformMsgId: TS },
      'agent',
      'ag-self',
    );
    expect(tagFor('host-1')).not.toContain('platform_msg_id=');
  });

  it('never appears on a system row', () => {
    insert('sys-1', 'system', { text: 'recall context', platformMsgId: TS });
    const out = formatMessages(getPendingMessages().filter((m) => m.id === 'sys-1'));
    expect(out).not.toContain('platform_msg_id=');
  });

  it('never appears on a spawn envelope', () => {
    insert('spawn-1', 'chat', { text: 'go', _spawn: { task_id: 'task-1' }, platformMsgId: TS });
    expect(tagFor('spawn-1')).not.toContain('platform_msg_id=');
  });

  it('is absent when the field is absent (an ordinary a2a or CLI-authored row)', () => {
    insert('plain-1', 'chat', { text: 'no id here', sender: 'peer', senderId: 'agent:peer' }, 'agent', 'ag-peer');
    expect(tagFor('plain-1')).not.toContain('platform_msg_id=');
  });

  it('escapes special characters', () => {
    insert('esc-1', 'chat', { text: 'hi', sender: 'Alice', platformMsgId: '1"><&' });
    expect(tagFor('esc-1')).toContain('platform_msg_id="1&quot;&gt;&lt;&amp;"');
  });
});
