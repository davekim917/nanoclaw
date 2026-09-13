import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { writeMessageOut } from '../db/messages-out.js';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { setChatLimit } from '../modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { applyChatBudget } from '../poll-loop.js';
import { requestChoice } from './request-choice.js';

// Assert against the real in-memory session DB rather than mocking
// writeMessageOut — mock.module is process-global under bun (see self-mod.test.ts).
function outbound(kind: string): Array<{ id: string; content: Record<string, unknown> }> {
  const rows = getOutboundDb()
    .prepare(`SELECT id, content FROM messages_out WHERE kind = ? ORDER BY seq`)
    .all(kind) as Array<{ id: string; content: string }>;
  return rows.map((r) => ({ id: r.id, content: JSON.parse(r.content) as Record<string, unknown> }));
}

// Same seeding as task-delivery.test.ts.
function seedSessionRouting(channelType: string | null, platformId: string | null, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare(
    'INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)',
  ).run(channelType, platformId, threadId);
}

function seedDestination(
  name: string,
  type: 'channel' | 'agent',
  channelType: string | null,
  platformId: string | null,
  agentGroupId: string | null = null,
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(name, name, type, channelType, platformId, agentGroupId);
}

const OPTIONS = [
  { label: 'Ship A', value: 'ship-a', style: 'primary' },
  { label: 'Ship all (2)', value: 'ship-all' },
  { label: 'Hold', value: 'hold', style: 'danger' },
];
const ASK = { title: 'Release', question: 'Which change ships?', options: OPTIONS };
const RELEASE_SCOPE = {
  purpose: 'release_ship',
  repository: 'owner/repository',
  pullRequest: 42,
  base: 'main',
  headSha: 'a'.repeat(40),
};

function inConversation(): void {
  seedSessionRouting('slack', 'slack:chan-1', 'slack:chan-1:100.1');
}

function inTask(): void {
  seedSessionRouting(null, null, 'system:tasks:watch-1');
  seedDestination('release-room', 'channel', 'slack', 'slack:chan-2');
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  // The chat budget is module state shared by every test file in this bun
  // process; a muted budget left behind would drop later files' chat writes.
  setChatLimit(null);
  closeSessionDb();
});

describe('request_choice', () => {
  it('in a conversation: writes one system action with no routing and returns its choice id', async () => {
    inConversation();
    const result = await requestChoice.handler(ASK);

    expect(result.isError).toBeUndefined();
    const rows = outbound('system');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.content).toEqual({ action: 'request_choice', choiceId: row.id, ...ASK });
    expect(result.content[0]?.text).toContain(`choice_id: ${row.id}`);
    expect(result.content[0]?.text).toContain('does not wait');
  });

  it('carries a key through', async () => {
    inConversation();
    await requestChoice.handler({ ...ASK, key: 'release:web' });
    expect(outbound('system')[0].content.key).toBe('release:web');
  });

  it('carries approvers through', async () => {
    inConversation();
    await requestChoice.handler({ ...ASK, approvers: ['slack:admin-1', 'slack:admin-2'] });
    expect(outbound('system')[0].content.approvers).toEqual(['slack:admin-1', 'slack:admin-2']);
  });

  it('transports a valid release scope without agent-controlled presentation', async () => {
    inConversation();
    const result = await requestChoice.handler({ approvalScope: RELEASE_SCOPE });

    expect(result.isError).toBeUndefined();
    expect(outbound('system')[0].content).toEqual({
      action: 'request_choice',
      choiceId: outbound('system')[0].id,
      approvalScope: RELEASE_SCOPE,
    });
  });

  it('with `to`: resolves the channel destination into the action', async () => {
    inTask();
    const result = await requestChoice.handler({ ...ASK, to: 'release-room' });

    expect(result.isError).toBeUndefined();
    expect(outbound('system')[0].content).toMatchObject({
      action: 'request_choice',
      to: 'release-room',
      channelType: 'slack',
      platformId: 'slack:chan-2',
    });
  });

  it('refuses a task session without `to`, naming the destinations it could use', async () => {
    inTask();
    const result = await requestChoice.handler(ASK);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('pass "to"');
    expect(result.content[0]?.text).toContain('release-room');
    expect(outbound('system')).toHaveLength(0);
  });

  it('refuses an unknown or non-channel destination', async () => {
    inTask();
    seedDestination('peer-agent', 'agent', null, null, 'ag-2');

    const unknown = await requestChoice.handler({ ...ASK, to: 'nowhere' });
    const agent = await requestChoice.handler({ ...ASK, to: 'peer-agent' });

    expect(unknown.content[0]?.text).toContain('Unknown destination "nowhere"');
    expect(agent.content[0]?.text).toContain('"peer-agent" is not a channel destination');
    expect(outbound('system')).toHaveLength(0);
  });

  it('posts from a muted task, where a chat write is dropped', async () => {
    inTask();
    // The real muteChat path: a task row with muteChat zeroes the chat budget.
    applyChatBudget([
      { kind: 'task', content: JSON.stringify({ prompt: 'watch', muteChat: true }) } as Parameters<
        typeof applyChatBudget
      >[0][number],
    ]);

    const result = await requestChoice.handler({ ...ASK, to: 'release-room' });
    await writeMessageOut({
      id: 'chat-1',
      kind: 'chat',
      platform_id: 'slack:chan-2',
      channel_type: 'slack',
      thread_id: null,
      content: JSON.stringify({ text: 'progress' }),
    });

    expect(result.isError).toBeUndefined();
    expect(outbound('system')).toHaveLength(1);
    expect(outbound('chat')).toHaveLength(0);
  });

  it.each([
    ['no options', { ...ASK, options: [] }, /1 to 10/],
    [
      'eleven options',
      { ...ASK, options: Array.from({ length: 11 }, (_, i) => ({ label: `L${i}`, value: `v${i}` })) },
      /1 to 10/,
    ],
    [
      'duplicate values',
      {
        ...ASK,
        options: [
          { label: 'A', value: 'same' },
          { label: 'B', value: 'same' },
        ],
      },
      /unique/,
    ],
    ['a missing value', { ...ASK, options: [{ label: 'A' }] }, /non-empty value/],
    ['a bare string option', { ...ASK, options: ['Hold'] }, /non-empty label/],
    ['an unknown style', { ...ASK, options: [{ label: 'A', value: 'a', style: 'loud' }] }, /unknown style/],
    ['a missing title', { question: 'Q', options: OPTIONS }, /title and question/],
    ['a string PR in release scope', { approvalScope: { ...RELEASE_SCOPE, pullRequest: '42' } }, /approvalScope/],
    ['a boolean PR in release scope', { approvalScope: { ...RELEASE_SCOPE, pullRequest: true } }, /approvalScope/],
    ['a zero PR in release scope', { approvalScope: { ...RELEASE_SCOPE, pullRequest: 0 } }, /approvalScope/],
    ['a fractional PR in release scope', { approvalScope: { ...RELEASE_SCOPE, pullRequest: 42.5 } }, /approvalScope/],
    ['an unsafe PR in release scope', { approvalScope: { ...RELEASE_SCOPE, pullRequest: Number.MAX_SAFE_INTEGER + 1 } }, /approvalScope/],
    ['a malformed repository in release scope', { approvalScope: { ...RELEASE_SCOPE, repository: 'owner repo' } }, /approvalScope/],
    ['a malformed base in release scope', { approvalScope: { ...RELEASE_SCOPE, base: 'main branch' } }, /approvalScope/],
    ['a short SHA in release scope', { approvalScope: { ...RELEASE_SCOPE, headSha: 'a'.repeat(39) } }, /approvalScope/],
    ['an upper-case SHA in release scope', { approvalScope: { ...RELEASE_SCOPE, headSha: 'A'.repeat(40) } }, /approvalScope/],
    ['a wrong purpose in release scope', { approvalScope: { ...RELEASE_SCOPE, purpose: 'other' } }, /approvalScope/],
    ['an extra release scope key', { approvalScope: { ...RELEASE_SCOPE, extra: true } }, /approvalScope/],
    ['a malformed key', { ...ASK, key: 'has spaces' }, /key must be/],
    ['an over-long key', { ...ASK, key: 'k'.repeat(129) }, /key must be/],
    ['approvers that are not a list', { ...ASK, approvers: 'slack:admin-1' }, /approvers must hold/],
    ['an empty approvers list', { ...ASK, approvers: [] }, /approvers must hold/],
    ['an approver without a namespace', { ...ASK, approvers: ['admin-1'] }, /approvers must hold/],
    [
      'too many approvers',
      { ...ASK, approvers: Array.from({ length: 21 }, (_, i) => `slack:user-${i}`) },
      /approvers must hold/,
    ],
  ])('rejects %s and writes nothing', async (_name, args, message) => {
    inConversation();
    const result = await requestChoice.handler(args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(message);
    expect(outbound('system')).toHaveLength(0);
  });
});
