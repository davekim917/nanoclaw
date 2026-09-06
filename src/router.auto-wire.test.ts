/**
 * Workspace-trust auto-wire, over the REAL insertion path.
 *
 * `src/router.test.ts` covers this feature's decisions with
 * `createMessagingGroupAgent` mocked, which is the right seam for asking what
 * the wiring would look like — and no seam at all for asking whether the
 * insert can run. #482 put the uniqueness proof and the insert in one
 * `centralTransaction`; the exported writer opens a transaction of its own and
 * the central lease refuses to nest, so every eligible channel threw
 * `CentralLeaseReentrancyError` into the caller's "could not auto-wire" catch
 * and fell through to the approval gate. A mocked writer cannot see that: the
 * whole failure lives in the real one.
 *
 * So this suite runs the router against a real central DB and asserts on the
 * row. The only mocks are things that leave the process.
 *
 * All identifiers are synthetic.
 */
import fs from 'fs';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-router-auto-wire') }));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

// Spread the real module: the router reads `sessionStillActive` off it against
// this suite's own DB, so only the process-leaving exports are replaced.
vi.mock('./container-runner.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...real,
    wakeContainer: vi.fn().mockResolvedValue(true),
    isContainerRunning: vi.fn().mockReturnValue(false),
    getActiveContainerCount: vi.fn().mockReturnValue(0),
    killContainer: vi.fn(),
  };
});

vi.mock('./message-archive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./message-archive.js')>()),
  archiveMessage: vi.fn(),
}));

vi.mock('./topic-title.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./topic-title.js')>()),
  maybeRenameNewThread: vi.fn(),
}));

import {
  initTestDb,
  closeDb,
  getRawDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import type { InboundEvent } from './channels/adapter.js';

// A Slack variant, so the channel type carries the workspace identity that
// makes "the workspace already trusts this bot" a safe inference.
const CHANNEL = 'slack-fixture';
const INCUMBENT_MG = 'mg-incumbent';
const INCUMBENT_PLATFORM_ID = 'slack:C0FIXTURE2';
const NEW_PLATFORM_ID = 'slack:C0FIXTURE3';
const AG_INCUMBENT = 'ag-incumbent';
const AG_SECOND = 'ag-second';

function now(): string {
  return new Date().toISOString();
}

async function agentGroup(id: string, folder: string): Promise<void> {
  await createAgentGroup({ id, name: `Agent ${id}`, folder, agent_provider: null, created_at: now() });
}

/** One already-wired channel in the workspace — the incumbent auto-wire inherits from. */
async function seedIncumbent(): Promise<void> {
  await agentGroup(AG_INCUMBENT, 'incumbent-agent');
  await createMessagingGroup({
    id: INCUMBENT_MG,
    channel_type: CHANNEL,
    platform_id: INCUMBENT_PLATFORM_ID,
    name: 'incumbent-room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-incumbent',
    messaging_group_id: INCUMBENT_MG,
    agent_group_id: AG_INCUMBENT,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: 'engineering',
    instructions_profile: null,
    created_at: now(),
  });
}

/** A second agent wired elsewhere in the SAME workspace — uniqueness is lost. */
async function seedCompetingWiring(): Promise<void> {
  await agentGroup(AG_SECOND, 'second-agent');
  await createMessagingGroup({
    id: 'mg-second',
    channel_type: CHANNEL,
    platform_id: 'slack:C0FIXTURE4',
    name: 'second-room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-second',
    messaging_group_id: 'mg-second',
    agent_group_id: AG_SECOND,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: now(),
  });
}

function mentionInNewRoom(): InboundEvent {
  return {
    channelType: CHANNEL,
    platformId: NEW_PLATFORM_ID,
    threadId: null,
    isDM: false,
    message: {
      id: 'msg-auto-wire-1',
      kind: 'chat',
      timestamp: now(),
      isMention: true,
      isGroup: true,
      content: JSON.stringify({ text: '@bot hello', sender: 'someone', senderId: 'U0FIXTURE' }),
    },
  } as unknown as InboundEvent;
}

/** Every wiring row for the freshly created channel, whatever agent it names. */
function wiringsForNewRoom(): Array<{ agent_group_id: string; default_tone: string | null }> {
  return getRawDb()
    .prepare(
      `SELECT mga.agent_group_id, mga.default_tone
         FROM messaging_group_agents mga
         JOIN messaging_groups m ON m.id = mga.messaging_group_id
        WHERE m.platform_id = ?`,
    )
    .all(NEW_PLATFORM_ID) as Array<{ agent_group_id: string; default_tone: string | null }>;
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  vi.clearAllMocks();
  await initTestDb();
  runMigrations(getRawDb());
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('workspace-trust auto-wire, real insertion path', () => {
  it('wires a new channel to the sole incumbent and leaves the row in the DB', async () => {
    await seedIncumbent();
    const { routeInbound } = await import('./router.js');

    await routeInbound(mentionInNewRoom());

    // The row is the assertion. A writer that threw — reentrancy included —
    // is swallowed by the caller's fall-through, so only the DB can tell a
    // successful auto-wire from a silent refusal.
    expect(wiringsForNewRoom()).toEqual([{ agent_group_id: AG_INCUMBENT, default_tone: 'engineering' }]);
    // And the companion destination the writer allocates in the same
    // transaction, which a caller that skipped the leaf would also have lost.
    // Two: one for the seeded incumbent channel, one for this new one.
    expect(
      getRawDb().prepare('SELECT COUNT(*) AS n FROM agent_destinations WHERE agent_group_id = ?').get(AG_INCUMBENT),
    ).toEqual({ n: 2 });
  });

  it('refuses when the workspace already holds wirings to two agent groups', async () => {
    await seedIncumbent();
    await seedCompetingWiring();
    const { routeInbound } = await import('./router.js');

    await routeInbound(mentionInNewRoom());

    // Falls through to the approval gate instead: no wiring, either way.
    expect(wiringsForNewRoom()).toEqual([]);
  });
});
