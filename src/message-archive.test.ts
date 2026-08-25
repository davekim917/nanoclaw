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
  archiveMessageAndScheduleMemoryCuration,
  claimMemoryCurationEpisode,
  claimMemoryMaintenance,
  MEMORY_MAINTENANCE_SIZE_THRESHOLD,
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
  recentConversationSenderNames,
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
      recentConversationSenderNames({
        memberAgentGroupIds: ['ag-a'],
        messagingGroupId: 'mg-tie',
        threadId: 'discord:g:c:t',
      }),
    ).toEqual(['Sender m-c', 'Sender m-b', 'Sender m-a']);
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
    // A literal join, not Node's ancestor-walk resolution — silently missing
    // in a worktree without its own install. Same fallback as run-migrations.ts's resolveTsx().
    const localTsx = path.resolve('node_modules/.bin/tsx');
    const tsx = fs.existsSync(localTsx)
      ? localTsx
      : (() => {
          try {
            return execSync('which tsx', { encoding: 'utf8' }).trim();
          } catch {
            return 'npx';
          }
        })();
    // npx (last-resort fallback) needs the package name as its first arg; a
    // direct tsx binary does not.
    const tsxArgs = (args: string[]) => (tsx.endsWith('npx') ? ['tsx', ...args] : args);
    const start = Date.parse('2026-07-26T00:00:00.000Z');
    const first = spawnSync(
      tsx,
      tsxArgs([
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
      ]),
      { cwd: restartRoot, encoding: 'utf8' },
    );
    expect(first.status, first.stderr).toBe(0);
    const firstClaim = JSON.parse(first.stdout) as { claimedThroughRowid: number };

    const second = spawnSync(
      tsx,
      tsxArgs([
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
      ]),
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
    recordAcceptedGeneratedMemory('wg-a', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1024, { nowMs: now });
    const first = claimMemoryMaintenance('maintenance-1', { nowMs: now });
    expect(first).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 1 });
    expect(failMemoryMaintenance(first!, { nowMs: now, retryMs: 1000 })).toBe(true);
    expect(claimMemoryMaintenance('too-early', { nowMs: now + 999 })).toBeNull();
    const retry = claimMemoryMaintenance('maintenance-2', { nowMs: now + 1000 });
    expect(retry).not.toBeNull();
    expect(completeMemoryMaintenance(retry!, { nowMs: now + 1000 })).toBe(true);
    expect(claimMemoryMaintenance('done', { nowMs: now + 2000 })).toBeNull();
  });

  // Bug: recordAcceptedGeneratedMemory's ON CONFLICT branch unconditionally set
  // not_before = excluded.not_before (= now of the accepted write), wiping out
  // any future not_before a prior failMemoryMaintenance had set. That let a
  // permanently-failing maintenance pass get retried on every subsequent
  // accepted episode write instead of waiting out the 6h backoff.
  it('an accepted generated-memory write does not pull a future not_before backoff backwards', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    recordAcceptedGeneratedMemory('wg-a', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now });
    const job = claimMemoryMaintenance('worker-1', { nowMs: now });
    expect(job).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 1 });
    const retryMs = 6 * 60 * 60_000;
    expect(failMemoryMaintenance(job!, { nowMs: now, retryMs })).toBe(true);
    const notBefore = now + retryMs;

    // An accepted episode write lands well inside the 6h backoff window.
    recordAcceptedGeneratedMemory('wg-a', 10, { nowMs: now + 1000 });

    // The backoff must still hold: one ms before the ORIGINAL not_before still
    // yields nothing...
    expect(claimMemoryMaintenance('too-early', { nowMs: notBefore - 1 })).toBeNull();
    // ...and claiming exactly at it succeeds, with acceptedUpdates reflecting
    // the accepted write in between — the counter increment must keep working
    // even though the backoff timestamp itself is protected.
    const retried = claimMemoryMaintenance('worker-2', { nowMs: notBefore });
    expect(retried).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 2 });
  });

  it('a fresh workgroup INSERT still seeds not_before to now, so maintenance is immediately claimable', () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    recordAcceptedGeneratedMemory('wg-fresh', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now });
    expect(claimMemoryMaintenance('worker', { nowMs: now })).toMatchObject({ workgroupId: 'wg-fresh' });
  });

  // P2-AC15. completeMemoryMaintenance used to zero the counter unconditionally,
  // erasing updates accepted while the lease was held. It now subtracts the
  // job's claim-time snapshot (floored at 0), and a caller can reassert
  // maintenance_pending immediately when a pass leaves the consolidation tail
  // non-empty, instead of waiting for MEMORY_MAINTENANCE_UPDATE_THRESHOLD more
  // updates to accrue.
  it("completeMemoryMaintenance subtracts the job's snapshot count and reasserts pending on a remaining tail", () => {
    const now = Date.parse('2026-07-26T12:00:00.000Z');
    for (let i = 0; i < 29; i++) recordAcceptedGeneratedMemory('wg-a', 10, { nowMs: now });
    // 30th call forces maintenance_pending via the size branch (well under the
    // 50-update threshold) so the counter lands on exactly 30, matching the AC.
    recordAcceptedGeneratedMemory('wg-a', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now });
    const job = claimMemoryMaintenance('worker-1', { nowMs: now });
    expect(job).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 30 });
    for (let i = 0; i < 10; i++) recordAcceptedGeneratedMemory('wg-a', 10, { nowMs: now + 1 });
    expect(completeMemoryMaintenance(job!, { nowMs: now + 2 })).toBe(true);

    // Floor-not-zero: 30 subtracted from (30 + 10) leaves 10, not 0. Read it
    // back by forcing the workgroup pending again (size-threshold branch, which
    // also increments the counter by one) and re-claiming.
    recordAcceptedGeneratedMemory('wg-a', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now + 3 });
    const after = claimMemoryMaintenance('worker-2', { nowMs: now + 3 });
    expect(after).toMatchObject({ workgroupId: 'wg-a', acceptedUpdates: 11 });
    expect(completeMemoryMaintenance(after!, { nowMs: now + 4 })).toBe(true);

    // Reassert: a pass that leaves the tail non-empty re-arms immediately,
    // without waiting for the threshold.
    recordAcceptedGeneratedMemory('wg-b', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now });
    const jobB = claimMemoryMaintenance('worker-3', { nowMs: now });
    expect(completeMemoryMaintenance(jobB!, { nowMs: now + 1, reassertPending: true })).toBe(true);
    expect(claimMemoryMaintenance('worker-4', { nowMs: now + 1 })).toMatchObject({ workgroupId: 'wg-b' });

    // F1 finding: a stale `reassertPending: false` (this pass's own tail WAS
    // fully drained) must not clobber a re-arm mid-pass accrual independently
    // earned. Claim with a 30-update snapshot, accrue 60 more while the lease
    // is held (90 total), complete with reassertPending: false — the floored
    // counter is 90 - 30 = 60, which is >= MEMORY_MAINTENANCE_UPDATE_THRESHOLD
    // (50), so pending must still be 1, and the persisted counter must read
    // 60 (not 0, not 90).
    recordAcceptedGeneratedMemory('wg-c', MEMORY_MAINTENANCE_SIZE_THRESHOLD + 1, { nowMs: now });
    for (let i = 0; i < 29; i++) recordAcceptedGeneratedMemory('wg-c', 10, { nowMs: now });
    const jobC = claimMemoryMaintenance('worker-5', { nowMs: now });
    expect(jobC).toMatchObject({ workgroupId: 'wg-c', acceptedUpdates: 30 });
    for (let i = 0; i < 60; i++) recordAcceptedGeneratedMemory('wg-c', 10, { nowMs: now + 1 });
    expect(completeMemoryMaintenance(jobC!, { nowMs: now + 2, reassertPending: false })).toBe(true);
    expect(claimMemoryMaintenance('worker-6', { nowMs: now + 2 })).toMatchObject({
      workgroupId: 'wg-c',
      acceptedUpdates: 60,
    });
  });

  it('keeps the maintenance size threshold mirrored on the generated-memory warn line', async () => {
    // The constant is hand-mirrored because importing curator-contract here
    // would close a runtime cycle. Left stale it fires every sweep for any
    // workgroup past the old cap, claiming and completing a job that does
    // nothing. The test file has no cycle, so it can assert the mirror.
    const { GENERATED_MEMORY_WARN_BYTES } = await import('./modules/memory/curator-contract.js');
    expect(MEMORY_MAINTENANCE_SIZE_THRESHOLD).toBe(GENERATED_MEMORY_WARN_BYTES);
  });
});
