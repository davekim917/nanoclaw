import fs from 'fs';
import { execSync, spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: `/tmp/nanoclaw-message-archive-read-test-${process.pid}` }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

import {
  archiveMessage,
  parseArchivePermalinks,
  queryArchiveExactLinks,
  recentConversationSenders,
  sanitizeArchiveFtsQuery,
  searchArchiveEvidence,
  upsertArchiveMessage,
} from './message-archive.js';

function add(
  id: string,
  agentGroupId: string,
  text: string,
  threadId: string | null = 'discord:g:c:t',
  messagingGroupId = 'mg',
): void {
  upsertArchiveMessage({
    id,
    agentGroupId,
    messagingGroupId,
    channelType: 'discord',
    channelName: 'room',
    platformId: 'discord:g:c',
    threadId,
    role: 'user',
    senderId: 'discord:u',
    senderName: 'Operator',
    text,
    sentAt: `2026-07-25T00:00:0${id.length}.000Z`,
  });
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('archive retrieval helpers', () => {
  it('removes high-frequency stop words from bounded FTS candidate generation', () => {
    expect(sanitizeArchiveFtsQuery('Where is https://siptrue.com DNS hosted?')).toBe('"siptrue" OR "dns" OR "hosted"');
  });

  it('scopes FTS candidates to trusted workgroup member ids and prioritizes current thread', () => {
    add('a', 'ag-a', 'SipTrue DNS is managed in Wix.');
    add('b', 'ag-a', 'SipTrue DNS notes from another thread.', 'discord:g:c:other');
    add('x', 'ag-foreign', 'SipTrue DNS is managed by a malicious foreign row.');

    const rows = searchArchiveEvidence({
      memberAgentGroupIds: ['ag-a'],
      query: 'Where is SipTrue DNS managed?',
      currentMessagingGroupId: 'mg',
      currentThreadId: 'discord:g:c:t',
      currentNormalizedContent: '',
      candidateLimit: 20,
    });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(
      searchArchiveEvidence({
        memberAgentGroupIds: [],
        query: 'SipTrue DNS',
        currentMessagingGroupId: 'mg',
        currentThreadId: 'discord:g:c:t',
        currentNormalizedContent: '',
        candidateLimit: 20,
      }),
    ).toEqual([]);
  });

  it('uses the actual messaging group as the current-thread boundary when thread_id is null', () => {
    add('dm-current', 'ag-a', 'Deployment owner is Jordan.', null, 'mg-current');
    add('dm-other', 'ag-a', 'Deployment owner is Taylor with extra deployment detail.', null, 'mg-other');

    const rows = searchArchiveEvidence({
      memberAgentGroupIds: ['ag-a'],
      query: 'deployment owner',
      currentMessagingGroupId: 'mg-current',
      currentThreadId: null,
      currentNormalizedContent: '',
      candidateLimit: 20,
    });

    expect(rows.map((row) => row.id)).toEqual(['dm-current', 'dm-other']);
    expect(rows.map((row) => row.rank)).toEqual(['current-thread', 'workgroup']);
  });

  it('parses and resolves exact Slack/Discord permalinks with trusted scope only', () => {
    upsertArchiveMessage({
      id: 'slack-row',
      agentGroupId: 'ag-a',
      messagingGroupId: 'mg-s',
      channelType: 'slack-team',
      channelName: 'ops',
      platformId: 'slack:C123ABC',
      threadId: 'slack:C123ABC:1770000000.123456',
      role: 'user',
      senderId: 'slack:U1',
      senderName: 'Operator',
      text: 'Slack exact evidence',
      sentAt: '2026-07-25T00:00:00.000Z',
    });
    upsertArchiveMessage({
      id: '333333333333333333:ag-a',
      agentGroupId: 'ag-a',
      messagingGroupId: 'mg-d',
      channelType: 'discord',
      channelName: 'ops',
      platformId: 'discord:111111111111111111:222222222222222222',
      threadId: 'discord:111111111111111111:222222222222222222:444444444444444444',
      role: 'user',
      senderId: 'discord:U1',
      senderName: 'Operator',
      text: 'Discord exact evidence',
      sentAt: '2026-07-25T00:00:01.000Z',
    });
    const query =
      'Compare https://acme.slack.com/archives/C123ABC/p1770000000123456?thread_ts=1770000000.123456 and https://discord.com/channels/111111111111111111/444444444444444444/333333333333333333';
    expect(parseArchivePermalinks(query)).toHaveLength(2);
    expect(
      queryArchiveExactLinks({ memberAgentGroupIds: ['ag-a'], normalizedContent: query, candidateLimit: 10 }).map(
        (r) => r.id,
      ),
    ).toEqual(['slack-row', '333333333333333333:ag-a']);
    expect(
      queryArchiveExactLinks({ memberAgentGroupIds: ['ag-foreign'], normalizedContent: query, candidateLimit: 10 }),
    ).toEqual([]);
    expect(queryArchiveExactLinks({ memberAgentGroupIds: [], normalizedContent: query, candidateLimit: 10 })).toEqual(
      [],
    );
  });

  it('resolves a Discord thread permalink by routing when an outbound platform message id was not archived', () => {
    for (const [id, agentGroupId, text] of [
      ['internal-assistant-id', 'ag-a', 'Assistant thread evidence'],
      ['foreign-id', 'ag-foreign', 'Foreign thread evidence'],
    ] as const) {
      upsertArchiveMessage({
        id,
        agentGroupId,
        messagingGroupId: 'mg-d',
        channelType: 'discord',
        channelName: 'ops',
        platformId: 'discord:111111111111111111:222222222222222222',
        threadId: 'discord:111111111111111111:222222222222222222:444444444444444444',
        role: 'assistant',
        senderId: agentGroupId,
        senderName: 'assistant',
        text,
        sentAt: '2026-07-25T00:00:02.000Z',
      });
    }

    const query = 'Read https://discord.com/channels/111111111111111111/444444444444444444/999999999999999999';
    expect(
      queryArchiveExactLinks({ memberAgentGroupIds: ['ag-a'], normalizedContent: query, candidateLimit: 10 }).map(
        (row) => row.id,
      ),
    ).toEqual(['internal-assistant-id']);
  });

  it('does not broaden an unknown Discord root-channel message link to unrelated channel history', () => {
    upsertArchiveMessage({
      id: 'unrelated-root-message:ag-a',
      agentGroupId: 'ag-a',
      messagingGroupId: 'mg-d',
      channelType: 'discord',
      channelName: 'ops',
      platformId: 'discord:111111111111111111:222222222222222222',
      threadId: null,
      role: 'user',
      senderId: 'discord:U1',
      senderName: 'Operator',
      text: 'Unrelated channel-root evidence',
      sentAt: '2026-07-25T00:00:03.000Z',
    });

    const query = 'Read https://discord.com/channels/111111111111111111/222222222222222222/999999999999999999';
    expect(
      queryArchiveExactLinks({ memberAgentGroupIds: ['ag-a'], normalizedContent: query, candidateLimit: 10 }),
    ).toEqual([]);
  });

  // idx_archive_conv_recent lets the planner satisfy `ORDER BY sent_at DESC,
  // id DESC` by walking the index instead of temp-B-tree sorting. That is only
  // result-preserving because `id` is a UNIQUE primary key, which makes the
  // tie-break total — sent_at alone is not (47k duplicated values on the live
  // archive). Pin the ordering under duplicate sent_at so a future index or
  // ORDER BY edit that drops the tie-break fails here.
  it('orders sender recall by the total (sent_at, id) key when sent_at ties', () => {
    for (const id of ['m-b', 'm-a', 'm-c']) {
      upsertArchiveMessage({
        id,
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-tie',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        role: 'user',
        senderId: `discord:${id}`,
        senderName: `Sender ${id}`,
        text: `tie ${id}`,
        sentAt: '2026-07-25T00:00:05.000Z',
      });
    }

    expect(
      recentConversationSenders({
        memberAgentGroupIds: ['ag-a'],
        messagingGroupId: 'mg-tie',
        threadId: 'discord:g:c:t',
      }),
    ).toEqual([
      { senderName: 'Sender m-c', senderId: 'discord:m-c' },
      { senderName: 'Sender m-b', senderId: 'discord:m-b' },
      { senderName: 'Sender m-a', senderId: 'discord:m-a' },
    ]);
  });
});

describe('archive evidence candidate ordering', () => {
  // Pins the CTE tie-break in searchArchiveEvidence. 12 rows share one text, so
  // they share a bm25 score and a current_rank; candidateLimit 1 sets the inner
  // cut at 8, which lands inside that tie. rowid ASC keeps the 8 oldest rowids,
  // and the outer sort (sent_at DESC) then picks m07 as the newest survivor.
  //
  // Honest scope: deleting ', messages_archive_fts.rowid ASC' does NOT currently
  // fail this — SQLite happens to emit FTS matches in rowid order and its sorter
  // is stable, so the result is the same either way (verified). This is a
  // determinism pin, not a tripwire: it fails if a SQLite upgrade, a new index,
  // or a CTE rewrite ever makes the tied set come out in a different order.
  it('keeps a tie-straddling candidate cut deterministic', () => {
    for (let i = 0; i < 12; i++) {
      upsertArchiveMessage({
        id: `m${String(i).padStart(2, '0')}`,
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-1',
        channelType: 'slack',
        channelName: 'room',
        platformId: 'slack:C1',
        threadId: 'thr-other',
        role: 'user',
        senderId: 'slack:U1',
        senderName: 'Sender',
        text: 'alpha',
        sentAt: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
      });
    }

    const rows = searchArchiveEvidence({
      memberAgentGroupIds: ['ag-a'],
      query: 'alpha',
      currentMessagingGroupId: 'mg-1',
      currentThreadId: 'thr-current',
      currentNormalizedContent: 'unrelated current message',
      candidateLimit: 1,
    });

    expect(rows.map((r) => r.id)).toEqual(['m07']);
  });
});

describe('archiveMessage', () => {
  const message = (id: string, text: string) => ({
    id,
    agentGroupId: 'ag-a',
    messagingGroupId: 'mg-a',
    channelType: 'discord',
    channelName: 'ops',
    platformId: 'discord:g:c',
    threadId: 'discord:g:c:t',
    role: 'user' as const,
    senderId: 'discord:u',
    senderName: 'Operator',
    text,
    sentAt: '2026-07-26T00:00:00.000Z',
  });

  const found = (query: string) =>
    searchArchiveEvidence({
      memberAgentGroupIds: ['ag-a'],
      query,
      currentMessagingGroupId: 'mg-a',
      currentThreadId: 'discord:g:c:t',
      currentNormalizedContent: '',
      candidateLimit: 20,
    }).map((row) => row.id);

  it('writes the row and reports it', () => {
    expect(archiveMessage(message('a-1', 'durable archive text'))).toBe(true);
    expect(found('durable archive')).toEqual(['a-1']);
  });

  it('reports false for empty text instead of writing', () => {
    expect(archiveMessage(message('a-2', ''))).toBe(false);
    expect(found('durable archive')).toEqual([]);
  });

  // router.ts's non-engaged session skip uses the boolean as a durability
  // precondition, so a write failure must surface rather than be swallowed.
  it('throws on a write failure rather than reporting success', () => {
    expect(() => archiveMessage({ ...message('a-3', 'text'), sentAt: null as unknown as string })).toThrow();
  });
});
