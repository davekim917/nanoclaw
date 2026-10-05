import { describe, expect, it } from 'vitest';

import { PROVENANCE_CAVEAT, selectOperatorMessages, type InboundRow } from './operator-messages.js';

const human = (text: string, isBot = false) => JSON.stringify({ text, author: { isBot, fullName: 'Op' } });
const row = (id: string, kind: string, content: string, timestamp = '2026-10-01T10:00:00.000Z'): InboundRow => ({
  id,
  kind,
  timestamp,
  content,
});

describe('selectOperatorMessages', () => {
  it('keeps one message per platform event however many agents it was fanned out to', () => {
    const out = selectOperatorMessages([
      { agentGroupId: 'ag-a', row: row('ev1:ag-a', 'chat-sdk', human('stop doing X')) },
      { agentGroupId: 'ag-b', row: row('ev1:ag-b', 'chat-sdk', human('stop doing X')) },
    ]);
    expect(out).toEqual([
      {
        key: 'ev1',
        timestamp: '2026-10-01T10:00:00.000Z',
        source: 'chat',
        agentGroupIds: ['ag-a', 'ag-b'],
        text: 'stop doing X',
      },
    ]);
  });

  it('strips a thread-context prefix down to the message itself', () => {
    const replay = '[Thread context]\nbot: earlier answer\nOp: older ask\n[Latest message]\nno, the other table';
    const [msg] = selectOperatorMessages([{ agentGroupId: 'ag-a', row: row('ev2:ag-a', 'chat-sdk', human(replay)) }]);
    expect(msg.text).toBe('no, the other table');
  });

  it('counts dashboard steers and leaves out bot, system and malformed rows', () => {
    const out = selectOperatorMessages([
      { agentGroupId: 'ag-a', row: row('s1', 'chat', JSON.stringify({ text: 'steer', _via: 'dashboard' })) },
      { agentGroupId: 'ag-a', row: row('b1:ag-a', 'chat-sdk', human('bot reply', true)) },
      { agentGroupId: 'ag-a', row: row('c1:ag-a', 'chat', JSON.stringify({ text: 'agent traffic' })) },
      { agentGroupId: 'ag-a', row: row('m1:ag-a', 'chat-sdk', '{not json') },
    ]);
    expect(out.map((m) => [m.key, m.source])).toEqual([['s1', 'dashboard']]);
  });

  it('labels every count an upper bound, because a user-token post looks exactly like a typed one', () => {
    expect(PROVENANCE_CAVEAT).toMatch(/^upper bound: .*user token/);
  });
});
