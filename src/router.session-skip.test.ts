/**
 * Integration tests for the non-engaged session skip and the thread-history
 * backfill that makes it recoverable.
 *
 * These run over REAL session state — real central DB, real `resolveSession`,
 * real per-session `inbound.db` files — on purpose. The previous round of
 * tests for this feature mocked `resolveSession`, which meant the continuity
 * case asserted transcript formatting and proved nothing about whether a
 * skipped message actually comes back. The only mocks here are the things
 * that leave the process: the container runner, the archive writer (which is
 * also the seam the archive-failure case needs), and the Haiku thread titler.
 *
 * All identifiers are synthetic.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-router-session-skip' };
});

const TEST_DIR = '/tmp/nanoclaw-test-router-session-skip';

vi.mock('./message-archive.js', () => ({
  archiveMessage: vi.fn(),
}));

vi.mock('./topic-title.js', () => ({
  maybeRenameNewThread: vi.fn(),
}));

import {
  initTestDb,
  closeDb,
  getDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSessionForAgent, createSession } from './db/sessions.js';
import { inboundDbPath } from './session-manager.js';
import { archiveMessage } from './message-archive.js';
import { buildThreadContextBlock, THREAD_CONTEXT_LIMIT } from './thread-context.js';
import type { ChannelAdapter, InboundEvent } from './channels/adapter.js';
import type { IgnoredMessagePolicy, SessionMode } from './types.js';

const CHANNEL = 'slack-fixture';
const PLATFORM_ID = 'slack:C0FIXTURE1';
const THREAD = 'slack:C0FIXTURE1:1700000000.000100';
const AG = 'ag-fixture';
const MG = 'mg-fixture';

function now(): string {
  return new Date().toISOString();
}

/** Platform history the fake adapter replays, newest appended. */
let threadHistory: Array<{ sender: string; text: string; timestamp: string; isAnchor?: boolean }> = [];
let historyCalls: Array<{ threadId: string; opts?: { limit?: number; excludeMessageId?: string } }> = [];
let historyThrows = false;
let supportsFetchThreadHistory = true;

function makeAdapter(): ChannelAdapter {
  const adapter: ChannelAdapter = {
    name: CHANNEL,
    channelType: CHANNEL,
    supportsThreads: true,
    async setup() {},
    async teardown() {},
    isConnected: () => true,
    async deliver() {
      return undefined;
    },
  };
  if (supportsFetchThreadHistory) {
    adapter.fetchThreadHistory = async (threadId, opts) => {
      historyCalls.push({ threadId, opts });
      if (historyThrows) throw new Error('platform unreachable');
      return threadHistory.slice(-(opts?.limit ?? THREAD_CONTEXT_LIMIT));
    };
  }
  return adapter;
}

async function withAdapter<T>(fn: () => Promise<T>): Promise<T> {
  const { registerChannelAdapter, initChannelAdapters, teardownChannelAdapters } =
    await import('./channels/channel-registry.js');
  registerChannelAdapter(CHANNEL, { factory: () => makeAdapter() });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  try {
    return await fn();
  } finally {
    await teardownChannelAdapters();
  }
}

function wire(
  opts: {
    sessionMode?: SessionMode;
    ignoredMessagePolicy?: IgnoredMessagePolicy;
    engageMode?: 'mention' | 'mention-sticky';
    threads?: 0 | 1 | null;
  } = {},
): void {
  createAgentGroup({ id: AG, name: 'Fixture Agent', folder: 'fixture-agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: MG,
    channel_type: CHANNEL,
    platform_id: PLATFORM_ID,
    name: 'fixture-room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-fixture',
    messaging_group_id: MG,
    agent_group_id: AG,
    engage_mode: opts.engageMode ?? 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    // `drop` never reaches deliverToAgent at all, so `accumulate` is the only
    // policy the skip can act on — and the one that minted the phantom rows.
    ignored_message_policy: opts.ignoredMessagePolicy ?? 'accumulate',
    session_mode: opts.sessionMode ?? 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });
  if (opts.threads !== undefined && opts.threads !== null) {
    getDb().prepare('UPDATE messaging_group_agents SET threads = ? WHERE id = ?').run(opts.threads, 'mga-fixture');
  }
}

function event(opts: {
  id: string;
  text: string;
  sender?: string;
  isMention?: boolean;
  threadId?: string | null;
  kind?: 'chat' | 'chat-sdk';
  attachments?: unknown[];
  timestamp?: string;
}): InboundEvent {
  const content: Record<string, unknown> = { sender: opts.sender ?? 'Sender One', text: opts.text };
  if (opts.attachments) content.attachments = opts.attachments;
  return {
    channelType: CHANNEL,
    platformId: PLATFORM_ID,
    threadId: opts.threadId === undefined ? THREAD : opts.threadId,
    isDM: false,
    message: {
      id: opts.id,
      kind: opts.kind ?? 'chat-sdk',
      content: JSON.stringify(content),
      timestamp: opts.timestamp ?? now(),
      isMention: opts.isMention ?? false,
      isGroup: true,
    },
  };
}

/** Text of every trigger=1 row in the session's real inbound DB. */
function triggerTexts(sessionId: string): string[] {
  const db = new Database(inboundDbPath(AG, sessionId));
  try {
    return (
      db.prepare("SELECT content FROM messages_in WHERE trigger = 1 AND kind <> 'system' ORDER BY seq").all() as Array<{
        content: string;
      }>
    ).map((r) => JSON.parse(r.content).text as string);
  } finally {
    db.close();
  }
}

function inboundRowCount(sessionId: string): number {
  const db = new Database(inboundDbPath(AG, sessionId));
  try {
    return (db.prepare("SELECT COUNT(*) c FROM messages_in WHERE kind <> 'system'").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
  runMigrations(initTestDb());
  threadHistory = [];
  historyCalls = [];
  historyThrows = false;
  supportsFetchThreadHistory = true;
  vi.mocked(archiveMessage).mockReset();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('non-engaged session skip', () => {
  it('skips the session, archives the message, and replays it on the later mention', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');

      // 1. A non-waking message in a thread nobody has engaged.
      const chatter = event({ id: 'm-1', text: 'deploy finished, all green', sender: 'Sender One' });
      await routeInbound(chatter);
      threadHistory.push({ sender: 'Sender One', text: 'deploy finished, all green', timestamp: now() });

      expect(findSessionForAgent(AG, MG, THREAD)).toBeUndefined();
      expect(archiveMessage).toHaveBeenCalledTimes(1);

      // 2. A human replies — also non-waking. Still no session.
      await routeInbound(event({ id: 'm-2', text: 'nice, did staging pick it up?', sender: 'Sender Two' }));
      threadHistory.push({ sender: 'Sender Two', text: 'nice, did staging pick it up?', timestamp: now() });
      expect(findSessionForAgent(AG, MG, THREAD)).toBeUndefined();

      // 3. Someone mentions the agent. NOW the session exists, and both
      //    skipped messages come back as replayed context.
      await routeInbound(event({ id: 'm-3', text: '@agent what happened here?', isMention: true }));

      const session = findSessionForAgent(AG, MG, THREAD);
      expect(session).toBeDefined();
      expect(session!.engaged_at).toBeTruthy();

      const texts = triggerTexts(session!.id);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('[Thread context]');
      expect(texts[0]).toContain('deploy finished, all green');
      expect(texts[0]).toContain('nice, did staging pick it up?');
      expect(texts[0]).toContain('[Latest message]\n@agent what happened here?');
    });
  });

  it('recovers skipped messages even when the session was minted by another path first', async () => {
    // Defect (a) from the revert: the recovery must not depend on THIS call
    // being the one that created the row. The rule is `engaged_at IS NULL`,
    // which is a property of the session, so any door reaches it.
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'skipped before anyone engaged' }));
      threadHistory.push({
        sender: 'Sender One',
        text: 'skipped before anyone engaged',
        timestamp: '2026-08-01T00:00:00.000Z',
      });
      expect(findSessionForAgent(AG, MG, THREAD)).toBeUndefined();

      // Some other path mints the session — a scheduled task, an escalation,
      // an agent-to-agent route. It never engaged, so `engaged_at` is NULL.
      createSession({
        id: 'sess-other-path',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: '2026-08-02T00:00:00.000Z',
        created_at: '2026-08-02T00:00:00.000Z',
      });

      await routeInbound(event({ id: 'm-2', text: '@agent status?', isMention: true }));

      const texts = triggerTexts('sess-other-path');
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('[Thread context]');
      expect(texts[0]).toContain('skipped before anyone engaged');
    });
  });

  it('falls through to session creation when the archive throws — never silently drops', async () => {
    // The load-bearing case. Skipping writes no session row, so the archive
    // row is the message's only remaining copy. If it did not land, the skip
    // must not happen.
    wire();
    vi.mocked(archiveMessage).mockImplementation(() => {
      throw new Error('archive.db is locked');
    });
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'must not vanish' }));

      const session = findSessionForAgent(AG, MG, THREAD);
      expect(session).toBeDefined();
      expect(session!.engaged_at).toBeNull();
      expect(inboundRowCount(session!.id)).toBe(1);
    });
  });

  it('refuses to skip a message carrying attachments — a transcript cannot rebuild a file', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(
        event({ id: 'm-1', text: 'here is the trace', attachments: [{ filename: 'trace.txt', data: '' }] }),
      );
      expect(findSessionForAgent(AG, MG, THREAD)).toBeDefined();
    });
  });

  it('refuses to skip when the adapter cannot replay a thread', async () => {
    wire();
    supportsFetchThreadHistory = false;
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'no replay hook here' }));
      expect(findSessionForAgent(AG, MG, THREAD)).toBeDefined();
    });
  });

  it('refuses to skip when the wiring has threads disabled', async () => {
    wire({ threads: 0 });
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'threads off' }));
      // Thread policy strips the thread id, so the session is the chat-level one.
      expect(findSessionForAgent(AG, MG, null)).toBeDefined();
    });
  });

  it('refuses to skip in a non-per-thread session mode', async () => {
    wire({ sessionMode: 'agent-shared' });
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'agent-shared mode' }));
      const { getSessionsByAgentGroup } = await import('./db/sessions.js');
      expect(getSessionsByAgentGroup(AG)).toHaveLength(1);
    });
  });

  it('refuses to skip a channel-root message with no thread id', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'channel root', threadId: null }));
      expect(findSessionForAgent(AG, MG, null)).toBeDefined();
    });
  });

  it('skips both chat and chat-sdk kinds', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'plain chat kind', kind: 'chat' }));
      expect(findSessionForAgent(AG, MG, THREAD)).toBeUndefined();
      await routeInbound(event({ id: 'm-2', text: 'chat-sdk kind', kind: 'chat-sdk' }));
      expect(findSessionForAgent(AG, MG, THREAD)).toBeUndefined();
      expect(archiveMessage).toHaveBeenCalledTimes(2);
    });
  });

  it('still delivers the mention when the history fetch fails', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-1', text: 'skipped' }));
      historyThrows = true;
      await routeInbound(event({ id: 'm-2', text: '@agent hello', isMention: true }));

      const session = findSessionForAgent(AG, MG, THREAD);
      expect(session).toBeDefined();
      const texts = triggerTexts(session!.id);
      expect(texts).toEqual(['@agent hello']);
    });
  });

  it('asks the platform for at most THREAD_CONTEXT_LIMIT messages', async () => {
    wire();
    for (let i = 0; i < 120; i++) {
      threadHistory.push({ sender: 'Sender One', text: `chatter ${i}`, timestamp: now() });
    }
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      await routeInbound(event({ id: 'm-mention', text: '@agent summarize', isMention: true }));

      expect(THREAD_CONTEXT_LIMIT).toBe(50);
      expect(historyCalls).toHaveLength(1);
      expect(historyCalls[0].opts).toEqual({ limit: 50, excludeMessageId: 'm-mention' });

      const session = findSessionForAgent(AG, MG, THREAD)!;
      const text = triggerTexts(session.id)[0];
      // The adapter honored the cap, so the oldest 70 are gone — the accepted
      // cost of replaying instead of accumulating.
      expect(text).not.toContain('chatter 69:');
      expect(text).toContain('chatter 70');
      expect(text).toContain('chatter 119');
    });
  });
});

describe('mention-sticky reads engaged_at, not session existence', () => {
  it('does not stick to a thread the agent has never engaged in', async () => {
    wire({ engageMode: 'mention-sticky' });
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { wakeContainer } = await import('./container-runner.js');

      // A session exists but nobody engaged — the exact state the skip's
      // refusal cases leave behind.
      createSession({
        id: 'sess-unengaged',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: now(),
        created_at: now(),
      });

      await routeInbound(event({ id: 'm-1', text: 'just chatting' }));
      expect(wakeContainer).not.toHaveBeenCalled();

      // After a real mention, the stick engages.
      await routeInbound(event({ id: 'm-2', text: '@agent hi', isMention: true }));
      expect(findSessionForAgent(AG, MG, THREAD)!.engaged_at).toBeTruthy();
      vi.mocked(wakeContainer).mockClear();

      await routeInbound(event({ id: 'm-3', text: 'follow-up with no mention' }));
      expect(wakeContainer).toHaveBeenCalled();
    });
  });
});

describe('buildThreadContextBlock is caller-agnostic', () => {
  // The agent-to-agent wake path reaches a session through a different door.
  // It must apply the identical rule, so the rule is exercised directly on
  // the exported function rather than only through the router.
  it('replays the whole thread for an unengaged session, whoever is asking', async () => {
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { getChannelAdapter } = await import('./channels/channel-registry.js');

      await routeInbound(event({ id: 'm-1', text: 'skipped while unengaged' }));
      threadHistory.push({
        sender: 'Sender One',
        text: 'skipped while unengaged',
        timestamp: '2026-08-01T00:00:00.000Z',
      });

      createSession({
        id: 'sess-a2a',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: '2026-08-05T00:00:00.000Z',
        created_at: '2026-08-05T00:00:00.000Z',
      });
      const session = findSessionForAgent(AG, MG, THREAD)!;

      const block = await buildThreadContextBlock({
        session,
        adapter: getChannelAdapter(CHANNEL),
        threadId: THREAD,
      });
      expect(block).toContain('[Thread context]');
      expect(block).toContain('skipped while unengaged');
    });
  });

  it('cuts at the last response once the session is engaged', async () => {
    wire();
    await withAdapter(async () => {
      const { getChannelAdapter } = await import('./channels/channel-registry.js');
      createSession({
        id: 'sess-engaged',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: '2026-08-05T00:00:00.000Z',
        created_at: '2026-08-01T00:00:00.000Z',
      });
      getDb()
        .prepare('UPDATE sessions SET engaged_at = ?, last_outbound_at = ? WHERE id = ?')
        .run('2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z', 'sess-engaged');
      threadHistory.push(
        { sender: 'Sender One', text: 'before the reply', timestamp: '2026-08-02T12:00:00.000Z' },
        { sender: 'Sender Two', text: 'after the reply', timestamp: '2026-08-04T00:00:00.000Z' },
      );

      const session = findSessionForAgent(AG, MG, THREAD)!;
      const block = await buildThreadContextBlock({
        session,
        adapter: getChannelAdapter(CHANNEL),
        threadId: THREAD,
      });
      expect(block).toBe('[New in thread since last response]\nSender Two: after the reply');
    });
  });

  it('prependThreadContext composes the same block onto plain text', async () => {
    // The composed entry point takes RAW TEXT, not a JSON content string.
    wire();
    await withAdapter(async () => {
      const { routeInbound } = await import('./router.js');
      const { prependThreadContext } = await import('./thread-context.js');
      const { getChannelAdapter } = await import('./channels/channel-registry.js');

      await routeInbound(event({ id: 'm-1', text: 'skipped earlier' }));
      threadHistory.push({ sender: 'Sender One', text: 'skipped earlier', timestamp: '2026-08-01T00:00:00.000Z' });
      createSession({
        id: 'sess-plain',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: now(),
        created_at: now(),
      });
      const opts = {
        session: findSessionForAgent(AG, MG, THREAD)!,
        adapter: getChannelAdapter(CHANNEL),
        threadId: THREAD as string | null,
      };
      expect(await prependThreadContext('handle this', opts)).toBe(
        '[Thread context]\nSender One: skipped earlier\n[Latest message]\nhandle this',
      );
      // Nothing to add ⇒ the text comes back untouched, never JSON-mangled.
      expect(await prependThreadContext('handle this', { ...opts, threadId: null })).toBe('handle this');
    });
  });

  it('returns null when the adapter has no fetchThreadHistory', async () => {
    wire();
    supportsFetchThreadHistory = false;
    await withAdapter(async () => {
      const { getChannelAdapter } = await import('./channels/channel-registry.js');
      createSession({
        id: 'sess-nohook',
        agent_group_id: AG,
        messaging_group_id: MG,
        thread_id: THREAD,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: now(),
        created_at: now(),
      });
      const block = await buildThreadContextBlock({
        session: findSessionForAgent(AG, MG, THREAD)!,
        adapter: getChannelAdapter(CHANNEL),
        threadId: THREAD,
      });
      expect(block).toBeNull();
    });
  });
});
