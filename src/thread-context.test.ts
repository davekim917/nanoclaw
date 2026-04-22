import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-context' };
});

const TEST_DIR = '/tmp/nanoclaw-test-thread-context';

import Database from 'better-sqlite3';
import { initTestDb, getDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, inboundDbPath } from './session-manager.js';
import { upsertArchiveMessage } from './message-archive.js';
import { injectThreadContext } from './thread-context.js';
import { getSession } from './db/sessions.js';

function now(): string {
  return new Date().toISOString();
}

function isoMinus(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function seed(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'discord:g:c',
    name: 'Test Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function readInboundCtxRows(
  agentGroupId: string,
  sessionId: string,
): Array<{ id: string; trigger: number; content: string; timestamp: string }> {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  try {
    return db
      .prepare("SELECT id, trigger, content, timestamp FROM messages_in WHERE id LIKE 'ctx:%' ORDER BY timestamp ASC")
      .all() as Array<{ id: string; trigger: number; content: string; timestamp: string }>;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('injectThreadContext', () => {
  it('injects prior thread messages from archive as trigger=0 rows', () => {
    seed();
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-A', 'per-thread');

    // Seed 3 prior messages in the thread (older than the trigger)
    for (let i = 0; i < 3; i++) {
      upsertArchiveMessage({
        id: `prev-${i}:ag-1`,
        agentGroupId: 'ag-1',
        messagingGroupId: 'mg-1',
        channelType: 'discord',
        channelName: 'test',
        platformId: 'discord:g:c',
        threadId: 'thread-A',
        role: 'user',
        senderId: 'u1',
        senderName: 'Dave',
        text: `prior message ${i}`,
        sentAt: isoMinus(10 - i), // each one slightly newer than last
      });
    }

    const triggerTs = now();
    const injected = injectThreadContext(
      session,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-A' },
      triggerTs,
    );

    expect(injected).toBe(3);
    const rows = readInboundCtxRows('ag-1', session.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.trigger === 0)).toBe(true);
    expect(rows.map((r) => JSON.parse(r.content).text)).toEqual([
      'prior message 0',
      'prior message 1',
      'prior message 2',
    ]);

    // Watermark advanced to the latest archived sent_at
    const refreshed = getSession(session.id);
    expect(refreshed?.last_archive_at).toBeTruthy();
  });

  it('does not re-inject rows below the watermark on subsequent wakes', () => {
    seed();
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-B', 'per-thread');

    upsertArchiveMessage({
      id: 'a1:ag-1',
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'discord',
      channelName: null,
      platformId: 'discord:g:c',
      threadId: 'thread-B',
      role: 'user',
      senderId: null,
      senderName: 'Dave',
      text: 'first',
      sentAt: isoMinus(5),
    });

    const t1 = now();
    const n1 = injectThreadContext(
      session,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-B' },
      t1,
    );
    expect(n1).toBe(1);

    // Second wake with same archive state — nothing new beyond watermark.
    const refreshed = getSession(session.id)!;
    const n2 = injectThreadContext(
      refreshed,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-B' },
      now(),
    );
    expect(n2).toBe(0);
  });

  it('excludes messages at or after the trigger timestamp', () => {
    seed();
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-C', 'per-thread');

    const triggerTs = isoMinus(2);
    // One message strictly before the trigger — should be included
    upsertArchiveMessage({
      id: 'before:ag-1',
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'discord',
      channelName: null,
      platformId: 'discord:g:c',
      threadId: 'thread-C',
      role: 'user',
      senderId: null,
      senderName: 'Dave',
      text: 'before',
      sentAt: isoMinus(3),
    });
    // One at/after the trigger — should be excluded
    upsertArchiveMessage({
      id: 'after:ag-1',
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'discord',
      channelName: null,
      platformId: 'discord:g:c',
      threadId: 'thread-C',
      role: 'user',
      senderId: null,
      senderName: 'Dave',
      text: 'after',
      sentAt: isoMinus(1),
    });

    const n = injectThreadContext(
      session,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-C' },
      triggerTs,
    );
    expect(n).toBe(1);
    const rows = readInboundCtxRows('ag-1', session.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('before');
  });

  it('is idempotent under duplicate injection (ctx id collision)', () => {
    seed();
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-D', 'per-thread');

    upsertArchiveMessage({
      id: 'x:ag-1',
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'discord',
      channelName: null,
      platformId: 'discord:g:c',
      threadId: 'thread-D',
      role: 'user',
      senderId: null,
      senderName: 'Dave',
      text: 'only',
      sentAt: isoMinus(5),
    });

    const triggerTs = now();
    const n1 = injectThreadContext(
      session,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-D' },
      triggerTs,
    );
    expect(n1).toBe(1);

    // Simulate watermark-advance failure by forcing the session's watermark
    // back to null and re-running — should INSERT OR IGNORE, not throw.
    getDb().prepare('UPDATE sessions SET last_archive_at = NULL WHERE id = ?').run(session.id);
    const refreshed = getSession(session.id)!;
    expect(refreshed.last_archive_at).toBeNull();

    expect(() =>
      injectThreadContext(
        refreshed,
        { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-D' },
        triggerTs,
      ),
    ).not.toThrow();

    const rows = readInboundCtxRows('ag-1', session.id);
    expect(rows).toHaveLength(1); // still just one ctx row
  });

  it('returns 0 when no prior messages exist in window', () => {
    seed();
    const { session } = resolveSession('ag-1', 'mg-1', 'thread-E', 'per-thread');
    const n = injectThreadContext(
      session,
      { channelType: 'discord', platformId: 'discord:g:c', threadId: 'thread-E' },
      now(),
    );
    expect(n).toBe(0);
  });
});
