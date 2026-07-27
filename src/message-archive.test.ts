import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { pathToFileURL } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: `/tmp/nanoclaw-message-archive-read-test-${process.pid}` }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

import {
  archiveMessageAndScheduleMemoryCuration,
  claimMemoryCurationEpisode,
  claimMemoryMaintenance,
  completeMemoryMaintenance,
  completeMemoryCurationEpisode,
  failMemoryMaintenance,
  failMemoryCurationEpisode,
  markMemoryCurationCredentialAvailable,
  markMemoryCurationCredentialUnavailable,
  memoryCurationAdmission,
  parseArchivePermalinks,
  queryArchiveExactLinks,
  readMemoryCurationEpisodeMessages,
  recordAcceptedGeneratedMemory,
  recordMemoryCurationCall,
  selectMemoryCurationCredential,
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
});

describe('memory curation episode queue', () => {
  function scheduledMessage(id: string, role: 'user' | 'assistant', sentAt: string) {
    return {
      id,
      agentGroupId: 'ag-a',
      messagingGroupId: 'mg-a',
      channelType: 'discord',
      channelName: 'ops',
      platformId: 'discord:g:c',
      threadId: 'discord:g:c:t',
      role,
      senderId: role === 'user' ? 'discord:u' : 'ag-a',
      senderName: role === 'user' ? 'Operator' : 'assistant',
      text: `${role} durable text ${id}`,
      sentAt,
    } as const;
  }

  it('archives and schedules atomically, then exposes only trusted workgroup members', () => {
    const start = Date.parse('2026-07-26T00:00:00.000Z');
    expect(
      archiveMessageAndScheduleMemoryCuration(scheduledMessage('u-1', 'user', '2026-07-26T00:00:00.000Z'), 'wg-a', {
        nowMs: start,
        debounceMs: 1000,
      }),
    ).toBe(true);
    expect(claimMemoryCurationEpisode('worker', { nowMs: start + 999 })).toBeNull();
    const episode = claimMemoryCurationEpisode('worker', { nowMs: start + 1000 });
    expect(episode).not.toBeNull();
    expect(readMemoryCurationEpisodeMessages(episode!, ['ag-foreign'])).toEqual([]);
    expect(readMemoryCurationEpisodeMessages(episode!, ['ag-a']).map((row) => row.id)).toEqual(['u-1']);
  });

  it('keeps arrivals during a lease pending after the claimed cursor completes', () => {
    const start = Date.parse('2026-07-26T00:00:00.000Z');
    archiveMessageAndScheduleMemoryCuration(scheduledMessage('u-1', 'user', new Date(start).toISOString()), 'wg-a', {
      nowMs: start,
      debounceMs: 0,
    });
    const first = claimMemoryCurationEpisode('worker-1', { nowMs: start })!;
    archiveMessageAndScheduleMemoryCuration(
      scheduledMessage('a-2', 'assistant', new Date(start + 1000).toISOString()),
      'wg-a',
      { nowMs: start + 1000, debounceMs: 1000 },
    );
    expect(completeMemoryCurationEpisode(first, { nowMs: start + 1100 })).toBe(true);
    expect(claimMemoryCurationEpisode('worker-2', { nowMs: start + 1999 })).toBeNull();
    const second = claimMemoryCurationEpisode('worker-2', { nowMs: start + 2000 })!;
    expect(readMemoryCurationEpisodeMessages(second, ['ag-a']).map((row) => row.id)).toEqual(['a-2']);
  });

  it('reclaims expired leases and retries failures without advancing handled state', () => {
    const start = Date.parse('2026-07-26T00:00:00.000Z');
    archiveMessageAndScheduleMemoryCuration(scheduledMessage('u-1', 'user', new Date(start).toISOString()), 'wg-a', {
      nowMs: start,
      debounceMs: 0,
    });
    const abandoned = claimMemoryCurationEpisode('dead-worker', { nowMs: start, leaseMs: 1000 })!;
    expect(claimMemoryCurationEpisode('early-worker', { nowMs: start + 999 })).toBeNull();
    const reclaimed = claimMemoryCurationEpisode('new-worker', { nowMs: start + 1000 })!;
    expect(reclaimed.claimedThroughRowid).toBe(abandoned.claimedThroughRowid);
    expect(failMemoryCurationEpisode(reclaimed, 'quota', { nowMs: start + 1000 })).toBe(true);
    expect(claimMemoryCurationEpisode('retry-too-early', { nowMs: start + 5 * 60_000 })).toBeNull();
    const retry = claimMemoryCurationEpisode('retry', { nowMs: start + 5 * 60_000 + 1000 })!;
    expect(readMemoryCurationEpisodeMessages(retry, ['ag-a']).map((row) => row.id)).toEqual(['u-1']);
  });

  it('reclaims the exact unprocessed archive slice in a fresh host process', () => {
    const restartRoot = `/tmp/nanoclaw-memory-curator-restart-${process.pid}`;
    fs.rmSync(restartRoot, { recursive: true, force: true });
    fs.mkdirSync(restartRoot, { recursive: true });
    const moduleUrl = pathToFileURL(path.resolve('src/message-archive.ts')).href;
    const tsx = path.resolve('node_modules/.bin/tsx');
    const start = Date.parse('2026-07-26T00:00:00.000Z');
    const first = spawnSync(
      tsx,
      [
        '-e',
        `import {
          archiveMessageAndScheduleMemoryCuration,
          claimMemoryCurationEpisode,
          failMemoryCurationEpisode
        } from ${JSON.stringify(moduleUrl)};
        const start = ${start};
        archiveMessageAndScheduleMemoryCuration({
          id: 'restart-message',
          agentGroupId: 'ag-a',
          messagingGroupId: 'mg-a',
          channelType: 'discord',
          channelName: 'ops',
          platformId: 'discord:g:c',
          threadId: 'thread-a',
          role: 'user',
          senderId: 'discord:u',
          senderName: 'Operator',
          text: 'This input must survive both OAuth keys being unavailable.',
          sentAt: new Date(start).toISOString()
        }, 'wg-a', { nowMs: start, debounceMs: 0 });
        const episode = claimMemoryCurationEpisode('first-host', { nowMs: start });
        if (!episode || !failMemoryCurationEpisode(episode, 'quota', { nowMs: start })) process.exit(2);
        console.log(JSON.stringify({ claimedThroughRowid: episode.claimedThroughRowid }));`,
      ],
      { cwd: restartRoot, encoding: 'utf8' },
    );
    expect(first.status, first.stderr).toBe(0);
    const firstClaim = JSON.parse(first.stdout) as { claimedThroughRowid: number };

    const second = spawnSync(
      tsx,
      [
        '-e',
        `import {
          claimMemoryCurationEpisode,
          readMemoryCurationEpisodeMessages
        } from ${JSON.stringify(moduleUrl)};
        const episode = claimMemoryCurationEpisode('restarted-host', { nowMs: ${start + 5 * 60_000 + 1} });
        if (!episode) process.exit(3);
        const messages = readMemoryCurationEpisodeMessages(episode, ['ag-a']);
        console.log(JSON.stringify({
          claimedThroughRowid: episode.claimedThroughRowid,
          handledRowid: episode.handledRowid,
          ids: messages.map((message) => message.id)
        }));`,
      ],
      { cwd: restartRoot, encoding: 'utf8' },
    );
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({
      claimedThroughRowid: firstClaim.claimedThroughRowid,
      handledRowid: 0,
      ids: ['restart-message'],
    });
    fs.rmSync(restartRoot, { recursive: true, force: true });
  });

  it('enforces rolling-hour and UTC-day call admission without deleting work', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    expect(memoryCurationAdmission({ nowMs: now, hourlyLimit: 2, dailyLimit: 3 }).allowed).toBe(true);
    expect(recordMemoryCurationCall('call-1', 'wg-a', { nowMs: now - 1000 })).toBe(true);
    expect(recordMemoryCurationCall('call-2', 'wg-a', { nowMs: now })).toBe(true);
    expect(memoryCurationAdmission({ nowMs: now, hourlyLimit: 2, dailyLimit: 3 })).toMatchObject({
      allowed: false,
      hourly: 2,
      daily: 2,
    });
    expect(recordMemoryCurationCall('call-2', 'wg-a', { nowMs: now })).toBe(false);
  });

  it('prunes call-accounting rows only after they are older than the admission windows', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    expect(recordMemoryCurationCall('expired-call', 'wg-a', { nowMs: now - 3 * 24 * 60 * 60_000 })).toBe(true);
    expect(memoryCurationAdmission({ nowMs: now, hourlyLimit: 2, dailyLimit: 3 })).toMatchObject({
      allowed: true,
      hourly: 0,
      daily: 0,
    });
    expect(recordMemoryCurationCall('expired-call', 'wg-a', { nowMs: now })).toBe(true);
  });

  it('round-robins credential slots durably and skips a cooling-down slot', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    const slots = ['oauth:primary', 'oauth:2'];
    expect(selectMemoryCurationCredential(slots, { nowMs: now }).slot).toBe('oauth:primary');
    expect(
      recordMemoryCurationCall('call-primary', 'wg-a', {
        nowMs: now,
        credentialSlot: 'oauth:primary',
      }),
    ).toBe(true);
    expect(selectMemoryCurationCredential(slots, { nowMs: now }).slot).toBe('oauth:2');
    expect(
      recordMemoryCurationCall('call-secondary', 'wg-a', {
        nowMs: now + 1,
        credentialSlot: 'oauth:2',
      }),
    ).toBe(true);
    expect(selectMemoryCurationCredential(slots, { nowMs: now + 1 }).slot).toBe('oauth:primary');

    const unavailableUntil = markMemoryCurationCredentialUnavailable('oauth:primary', 'quota', {
      nowMs: now + 2,
      retryAfterMs: 60_000,
    });
    expect(selectMemoryCurationCredential(slots, { nowMs: now + 30_000 })).toMatchObject({
      slot: 'oauth:2',
      unavailableSlots: ['oauth:primary'],
    });
    expect(selectMemoryCurationCredential(slots, { nowMs: Date.parse(unavailableUntil) }).slot).toBe('oauth:primary');
    markMemoryCurationCredentialAvailable('oauth:primary', { nowMs: now + 60_001 });
    expect(selectMemoryCurationCredential(slots, { nowMs: now + 60_001 }).unavailableSlots).toEqual([]);
  });

  it('reports the earliest durable retry without claiming work when every credential is unavailable', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    const primaryUntil = markMemoryCurationCredentialUnavailable('oauth:primary', 'quota', {
      nowMs: now,
      retryAfterMs: 120_000,
    });
    markMemoryCurationCredentialUnavailable('oauth:2', 'quota', {
      nowMs: now,
      retryAfterMs: 300_000,
    });
    expect(selectMemoryCurationCredential(['oauth:primary', 'oauth:2'], { nowMs: now })).toEqual({
      slot: null,
      retryAt: primaryUntil,
      unavailableSlots: ['oauth:primary', 'oauth:2'],
    });
  });

  it('durably leases threshold-triggered maintenance and retries without clearing it', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    recordAcceptedGeneratedMemory('wg-a', 49 * 1024, { nowMs: now });
    const first = claimMemoryMaintenance('maintenance-1', { nowMs: now });
    expect(first).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 1 });
    expect(failMemoryMaintenance(first!, { nowMs: now, retryMs: 1000 })).toBe(true);
    expect(claimMemoryMaintenance('too-early', { nowMs: now + 999 })).toBeNull();
    const retry = claimMemoryMaintenance('maintenance-2', { nowMs: now + 1000 });
    expect(retry).not.toBeNull();
    expect(completeMemoryMaintenance(retry!, { nowMs: now + 1000 })).toBe(true);
    expect(claimMemoryMaintenance('done', { nowMs: now + 2000 })).toBeNull();
  });
});
