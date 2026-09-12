/**
 * `event.message.nativeId` (channels/adapter.ts) is the only source router.ts
 * trusts for the row's `platformMsgId` content field — see the write site in
 * `deliverToAgent` (router.ts, `writeSessionMessageIfNew(..., {
 * platformMessageId: event.message.nativeId })`).
 *
 * `event.message.id` is the routing/dedup key alone and is set on EVERY
 * event, synthetic or not. `nativeId` is set ONLY by the ingress producer
 * `adapterInboundEvent` (channels/inbound-event.ts), which main.ts's
 * `onInbound` delegates to, and only for non-CLI adapters; every
 * `onInboundEvent` caller — the CLI `to:` admin transport
 * (channels/cli.ts:231-247), Discord slash commands
 * (channels/discord-slash-commands.ts:356), `ncl messaging-groups send`
 * (cli/resources/messaging-groups.ts:173) — constructs its own `InboundEvent`
 * without it.
 *
 * Both halves are driven through their REAL producer against the real router
 * and a real central DB, so the two mutations that matter fail here: deleting
 * the `nativeId` assignment (genuine platform ingress loses its stamp) and
 * deleting the `'cli'` exclusion (plain CLI chat gains a false one). A test
 * that hands `nativeId` to the router directly catches neither — it never
 * runs the code that decides the field (review finding, PR #710).
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

import type { InboundEvent, InboundMessage } from './channels/adapter.js';
import { adapterInboundEvent, type IngressAdapter } from './channels/inbound-event.js';
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

/** Two wired conversations: a genuine platform one, and the CLI adapter's own. */
const WIRED: Array<{ mgId: string; mgaId: string; channelType: string; platformId: string }> = [
  { mgId: 'mg-1', mgaId: 'mga-1', channelType: 'discord', platformId: 'chan-123' },
  { mgId: 'mg-cli', mgaId: 'mga-cli', channelType: 'cli', platformId: 'cli-local' },
];

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
  for (const { mgId, mgaId, channelType, platformId } of WIRED) {
    await createMessagingGroup({
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: `Room ${mgId}`,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: mgId,
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
  }
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The written row's content, for the one message a routed event produces. */
async function routedContent(event: InboundEvent, mgId = 'mg-1'): Promise<Record<string, unknown>> {
  const { routeInbound } = await import('./router.js');
  await routeInbound(event);
  const session = await findSession(mgId, null);
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

/** An adapter's own inbound message, as an adapter hands it to `onInbound`. */
function inboundMessage(over: Partial<InboundMessage> & Pick<InboundMessage, 'id'>): InboundMessage {
  return {
    kind: 'chat',
    timestamp: now(),
    content: { text: 'hello', sender: 'User', senderId: '222' },
    ...over,
  };
}

describe('platformMsgId is stamped only from genuine adapter ingress', () => {
  it('a platform adapter’s ingress, built by the real producer, stamps the platform id', async () => {
    // The exact call main.ts's onInbound makes: adapter identity plus the
    // adapter's own message. Deleting the `nativeId` assignment in
    // adapterInboundEvent drops the stamp and fails here.
    const adapter: IngressAdapter = { channelType: 'discord', instance: undefined };
    const content = await routedContent(
      adapterInboundEvent(adapter, 'chan-123', null, inboundMessage({ id: 'native-msg-1' })),
    );

    expect(content).toMatchObject({ platformMsgId: 'native-msg-1' });
  });

  it('the CLI adapter’s own plain chat, through the same producer, stamps nothing', async () => {
    // The CLI adapter reaches onInbound exactly like a platform adapter, but
    // its id is host-synthesized (`cli-<ms>-<rand>`, src/channels/cli.ts).
    // Deleting the `'cli'` exclusion in adapterInboundEvent gives this line
    // false platform provenance and fails here.
    const adapter: IngressAdapter = { channelType: 'cli', instance: undefined };
    const content = await routedContent(
      adapterInboundEvent(
        adapter,
        'cli-local',
        null,
        inboundMessage({
          id: `cli-${Date.now()}-ab12cd`,
          content: { text: 'ship it', sender: 'Alice', senderId: 'UOWNER' },
        }),
      ),
      'mg-cli',
    );

    expect(content).toMatchObject({ sender: 'Alice', senderId: 'UOWNER' });
    expect(content.platformMsgId).toBeUndefined();
  });

  it('CLI `to:` admin transport (channels/cli.ts:231-247) carries no nativeId, so nothing is stamped', async () => {
    // Exact shape cli.ts builds for a `to:`-addressed line: it calls
    // onInboundEvent with its own InboundEvent, never the producer above, so
    // a host-synthesized `cli-<ms>-<rand>` id cannot reach platformMsgId.
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
