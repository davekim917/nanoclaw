/**
 * `event.message.nativeId` (channels/adapter.ts) is the only source router.ts
 * trusts for the row's `platformMsgId` content field — see the write site in
 * `deliverToAgent` (router.ts, `writeSessionMessageIfNew(..., {
 * platformMessageId: event.message.nativeId })`).
 *
 * `event.message.id` is the routing/dedup key alone and is set on EVERY
 * event, synthetic or not. `nativeId` is set ONLY by main.ts's `onInbound`
 * for genuine, non-CLI adapter ingress; every `onInboundEvent` caller — the
 * CLI `to:` admin transport (channels/cli.ts:231-247), Discord slash commands
 * (channels/discord-slash-commands.ts:356), `ncl messaging-groups send`
 * (cli/resources/messaging-groups.ts:173) — constructs its own `InboundEvent`
 * without it. This suite exercises the real router against those exact event
 * shapes, real central DB, so a future caller that reintroduces
 * `event.message.id` at the write site (review finding F4, PR #710) fails a
 * router-level test rather than only a fixture-poked formatter test.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    wakeContainer: vi.fn().mockResolvedValue(undefined),
    isContainerRunning: vi.fn().mockReturnValue(false),
    getActiveContainerCount: vi.fn().mockReturnValue(0),
    killContainer: vi.fn(),
  };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-router-native-id') }));

import type { InboundEvent } from './channels/adapter.js';
import {
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initMigratedTestDb,
  closeDb,
} from './db/index.js';
import { findSession } from './db/sessions.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-123',
    name: 'General',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The written row's content, for the one message a routed event produces. */
async function routedContent(event: InboundEvent): Promise<Record<string, unknown>> {
  const { routeInbound } = await import('./router.js');
  await routeInbound(event);
  const session = await findSession('mg-1', null);
  expect(session).toBeDefined();
  const db = new Database(inboundDbPath('ag-1', session!.id), { readonly: true });
  try {
    const rows = db
      .prepare("SELECT content FROM messages_in WHERE kind IN ('chat', 'chat-sdk') ORDER BY seq")
      .all() as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    return JSON.parse(rows[0].content) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

describe('platformMsgId is stamped only from event.message.nativeId', () => {
  it('genuine adapter ingress (main.ts onInbound sets nativeId = message.id for non-CLI adapters) stamps it', async () => {
    const content = await routedContent({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: 'native-msg-1',
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({ text: 'hello', sender: 'User', senderId: '222' }),
        nativeId: 'native-msg-1',
      },
    });
    expect(content).toMatchObject({ platformMsgId: 'native-msg-1' });
  });

  it('CLI `to:` admin transport (channels/cli.ts:231-247) carries no nativeId, so nothing is stamped', async () => {
    // Exact shape cli.ts builds for a `to:`-addressed line: a host-synthesized
    // `cli-<ms>-<rand>` id, no nativeId, sender/senderId are the caller's own
    // choice — none of that reaches onInboundEvent's nativeId field.
    const cliId = `cli-${Date.now()}-ab12cd`;
    const content = await routedContent({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: cliId,
        kind: 'chat',
        timestamp: now(),
        content: JSON.stringify({ text: 'ship it', sender: 'Alice', senderId: 'UOWNER' }),
      },
    });
    expect(content).toMatchObject({ sender: 'Alice', senderId: 'UOWNER' });
    expect(content.platformMsgId).toBeUndefined();
  });

  it('Discord slash command (channels/discord-slash-commands.ts:346-358) carries no nativeId, so nothing is stamped', async () => {
    const syntheticId = `slash-update-container-${Date.now()}-x1y2z3`;
    const content = await routedContent({
      channelType: 'discord',
      platformId: 'chan-123',
      threadId: null,
      message: {
        id: syntheticId,
        kind: 'chat-sdk',
        timestamp: now(),
        content: JSON.stringify({
          text: 'audit',
          sender: 'admin',
          senderId: '111',
          senderName: 'admin',
          isMention: true,
        }),
      },
    });
    expect(content.platformMsgId).toBeUndefined();
  });
});
