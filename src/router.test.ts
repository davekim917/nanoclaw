/**
 * Tests for pre-fanout intercept dispatch in routeInbound (Task C2).
 * These tests exercise only the intercept/filter/pass paths added in C2,
 * using vi.mock to stub out all I/O (DB, session, container wake).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// ── Mock everything that touches I/O ──

vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(),
  hasTable: vi.fn(() => true),
}));
vi.mock('./db/container-configs.js', async (importOriginal) => ({
  // resolveProviderName is pure — keep it real so flag parsing sees the
  // genuine provider cascade. getContainerConfig hits the central DB; stub
  // it to "no config row" (provider falls back to 'claude').
  ...(await importOriginal<typeof import('./db/container-configs.js')>()),
  getContainerConfig: vi.fn(() => undefined),
}));

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroupWithAgentCount: vi.fn(),
  getMessagingGroupAgents: vi.fn(() => []),
  createMessagingGroup: vi.fn(),
  createMessagingGroupAgent: vi.fn(),
}));

vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(() => null),
}));

vi.mock('./db/dropped-messages.js', () => ({
  recordDroppedMessage: vi.fn(),
}));

vi.mock('./db/sessions.js', () => ({
  findSessionForAgent: vi.fn(() => undefined),
  getSession: vi.fn(() => null),
}));

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(() => null),
  // Static behavior-faithful fallback (fork: plain mention groups) — the real
  // registry never returns undefined; it resolves undeclared adapters through
  // fallbackChannelDefaults.
  getChannelDefaults: vi.fn(() => ({
    dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'request_approval' },
    group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
    mentions: 'platform',
  })),
  hasDeclaredChannelDefaults: vi.fn(() => false),
}));

vi.mock('./session-manager.js', () => ({
  resolveSession: vi.fn(),
  writeSessionMessage: vi.fn(),
  writeOutboundDirect: vi.fn(),
}));

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn(),
}));

vi.mock('./attachment-downloader.js', () => ({
  persistInboundAttachments: vi.fn((_, __, ___, content: string) => content),
}));

vi.mock('./modules/bash-gate/index.js', () => ({
  cancelPendingGatesForSession: vi.fn(),
  sessionHasActiveGates: vi.fn(() => false),
}));

vi.mock('./modules/typing/index.js', () => ({
  startTypingRefresh: vi.fn(),
  stopTypingRefresh: vi.fn(),
}));

vi.mock('./log.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('./message-archive.js', () => ({
  upsertArchiveMessage: vi.fn(),
}));

vi.mock('./flag-parser.js', () => ({
  parseMessageFlags: vi.fn(() => ({ intent: undefined, errors: [], warnings: [], cleanedText: null })),
  formatFlagConfirmation: vi.fn(() => null),
}));

vi.mock('./topic-title.js', () => ({
  maybeRenameNewThread: vi.fn(),
}));

vi.mock('./modules/permissions/db/user-roles.js', () => ({
  isAnyAdmin: vi.fn(() => false),
}));

// ── Imports after mocks ──

import {
  routeInbound,
  setSenderResolver,
  setAccessGate,
  setUnwiredChannelResolver,
  setChannelRequestGate,
  registerMessageInterceptor,
  isSlackChannelType,
  isDiscordChannelType,
} from './router.js';
import { getMessagingGroupWithAgentCount, getMessagingGroupAgents } from './db/messaging-groups.js';
import { writeSessionMessage, writeOutboundDirect, resolveSession } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { getSession } from './db/sessions.js';
import { isAnyAdmin } from './modules/permissions/db/user-roles.js';
import { registerInterceptHandler, clearInterceptHandlers } from './command-gate.js';
import type { ChannelAdapter, InboundEvent } from './channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

function makeMg(overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id: 'mg-1',
    channel_type: 'slack-test',
    platform_id: 'platform-1',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    session_mode: 'per-thread',
    priority: 0,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChatEvent(text: string, overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'slack-test',
    platformId: 'platform-1',
    threadId: null,
    isDM: true,
    message: {
      id: `msg-${Date.now()}`,
      kind: 'chat',
      content: JSON.stringify({ text }),
      timestamp: new Date().toISOString(),
      isMention: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearInterceptHandlers();
  // Reset singleton hook state
  setSenderResolver(() => 'u1');
  setAccessGate(() => ({ allowed: true }));
  setUnwiredChannelResolver(() => []);
  setChannelRequestGate(() => Promise.resolve());
  registerMessageInterceptor(() => Promise.resolve(false));
  vi.mocked(isAnyAdmin).mockReturnValue(true);
});

afterEach(() => {
  clearInterceptHandlers();
});

describe('C2: pre-fanout intercept dispatch', () => {
  it('test_routeInbound_intercept_skips_fanout', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    registerInterceptHandler('dashboard_token_issue', handlerSpy);

    const event = makeChatEvent('/dashboard-token');
    await routeInbound(event);

    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(handlerSpy).toHaveBeenCalledWith({
      userId: 'u1',
      replyMessagingGroupId: 'mg-1',
      command: '/dashboard-token',
      args: '',
    });
    expect(writeSessionMessage).not.toHaveBeenCalled();
    expect(wakeContainer).not.toHaveBeenCalled();
  });

  it('test_routeInbound_intercept_fanout_with_multiple_agents', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 2 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([
      makeAgent({ id: 'mga-1', agent_group_id: 'ag-1' }),
      makeAgent({ id: 'mga-2', agent_group_id: 'ag-2' }),
    ]);

    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    registerInterceptHandler('dashboard_token_issue', handlerSpy);

    const event = makeChatEvent('/dashboard-token');
    await routeInbound(event);

    // Must be called EXACTLY ONCE — pre-fanout, not per-agent
    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('test_routeInbound_intercept_5s_timeout', async () => {
    vi.useFakeTimers();

    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const neverResolves = new Promise<void>(() => {});
    registerInterceptHandler('dashboard_token_issue', () => neverResolves);

    const event = makeChatEvent('/dashboard-token');
    const routePromise = routeInbound(event);

    // Advance timers past 5s timeout
    await vi.advanceTimersByTimeAsync(6000);
    await routePromise;

    // Should have returned without crashing; no session messages written
    expect(writeSessionMessage).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('test_routeInbound_pass_path_unchanged', async () => {
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const mg = makeMg();
    const agent = makeAgent();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([agent]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    const session = {
      id: 's-1',
      agent_group_id: 'ag-1',
      messaging_group_id: 'mg-1',
      thread_id: null,
      agent_provider: null,
      status: 'active' as const,
      container_status: 'idle' as const,
      last_active: null,
      created_at: new Date().toISOString(),
    };
    vi.mocked(resolveSession).mockReturnValue({ session, created: true });
    vi.mocked(getSession).mockReturnValue(session);
    vi.mocked(wakeContainer).mockResolvedValue(false);

    const event = makeChatEvent('hello world');
    await routeInbound(event);

    // Normal path: writeSessionMessage called (fan-out ran)
    expect(writeSessionMessage).toHaveBeenCalledOnce();
    expect(wakeContainer).toHaveBeenCalledWith(session, 'interactive');
  });

  it('test_routeInbound_intercept_filter_drops', async () => {
    const mg = makeMg();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent()]);

    const event = makeChatEvent('/help');
    await routeInbound(event);

    expect(writeSessionMessage).not.toHaveBeenCalled();
  });
});

// Issue 1 from the @Bo -e max thread: Bo-codex's accumulate-mode wiring on
// the shared MR channel ran the flag dispatcher even though @Bo was the
// addressed agent. Two side effects to prevent:
//   (a) Bo-codex's bot user emits a duplicate "effort → X" notice — visible
//       channel noise from an agent the operator wasn't talking to.
//   (b) Bo-codex's session_state gets `max` stored as effort even though
//       Codex's reasoning_effort schema doesn't accept it; the value is
//       silently invalid and the next spawn either throws or falls back.
// Fix: deliverToAgent now gates the flag dispatcher on `wake === true`.
describe('flag dispatcher wake gate', () => {
  it('skips parseMessageFlags when wake=false (accumulate path)', async () => {
    const { parseMessageFlags } = await import('./flag-parser.js');
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const mg = makeMg({ id: 'mg-shared', is_group: 1 });
    const accumulateAgent = makeAgent({
      id: 'mga-bocodex',
      agent_group_id: 'ag-bocodex',
      // Mention-mode but accumulate policy: NOT addressed by this message
      // (isMention=true is for the OTHER agent in the channel), still
      // gets the message delivered as silent context.
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
    });
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([accumulateAgent]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-bocodex',
      name: 'Bo-codex',
      folder: 'madison-reed-codex',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(resolveSession).mockReturnValue({
      session: {
        id: 's-bocodex',
        agent_group_id: 'ag-bocodex',
        messaging_group_id: 'mg-shared',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      created: true,
    });

    // The message is NOT a mention for this agent (engages=false) but the
    // accumulate policy still delivers it. The text carries a `-e` flag
    // meant for the OTHER bot.
    const event = makeChatEvent('@Bo -e max', {
      message: { ...makeChatEvent('@Bo -e max').message, isMention: false },
    });
    await routeInbound(event);

    // The dispatcher must NOT run on the accumulate-path delivery.
    expect(parseMessageFlags).not.toHaveBeenCalled();
    // The host must NOT post a sibling "effort → max" notice.
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('still runs parseMessageFlags when wake=true (the addressed agent)', async () => {
    const { parseMessageFlags } = await import('./flag-parser.js');
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const mg = makeMg();
    const agent = makeAgent();
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([agent]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-1',
      name: 'Bo',
      folder: 'madison-reed',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(resolveSession).mockReturnValue({
      session: {
        id: 's-1',
        agent_group_id: 'ag-1',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      created: true,
    });

    // Real mention → engages=true → wake=true → dispatcher runs.
    const event = makeChatEvent('-e high');
    await routeInbound(event);

    expect(parseMessageFlags).toHaveBeenCalled();
  });

  it('falls back to agent_groups.agent_provider when the container_configs row is missing (mid-run-created group)', async () => {
    // Groups created mid-run have no container_configs row until
    // backfillContainerConfigs at the next host restart (group-init.ts FK
    // ordering note), but create flows stamp agent_groups.agent_provider.
    // Without this rung a fresh codex sibling parses flags with the claude
    // vocabulary until restart (codex-review finding on PR #124). The
    // suite-level getContainerConfig mock already returns undefined.
    const { parseMessageFlags } = await import('./flag-parser.js');
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const mg = makeMg();
    const agent = makeAgent({ id: 'mga-newcodex', agent_group_id: 'ag-newcodex' });
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({ mg, agentCount: 1 });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([agent]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-newcodex',
      name: 'fresh-codex-sibling',
      folder: 'fresh-codex-sibling',
      agent_provider: 'codex',
      created_at: new Date().toISOString(),
    });
    vi.mocked(resolveSession).mockReturnValue({
      session: {
        id: 's-newcodex',
        agent_group_id: 'ag-newcodex',
        messaging_group_id: 'mg-1',
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: null,
        created_at: new Date().toISOString(),
      },
      created: true,
    });

    const event = makeChatEvent('-m gpt-5.5 hello');
    await routeInbound(event);

    expect(parseMessageFlags).toHaveBeenCalledWith(expect.any(String), 'codex');
  });
});

describe('thread context fetch', () => {
  it('uses last_outbound_at as the cutoff and does not replay stale anchors', async () => {
    const { getAgentGroup } = await import('./db/agent-groups.js');
    const { getChannelAdapter } = await import('./channels/channel-registry.js');
    const fetchThreadHistory = vi.fn().mockResolvedValue([
      {
        sender: 'Dave',
        text: '@Axie do you have access to my Pocket meetings?',
        timestamp: '2026-06-28T22:00:00.000Z',
        isAnchor: true,
      },
      {
        sender: 'assistant',
        text: 'Pocket yes, fully wired.',
        timestamp: '2026-06-28T22:39:40.000Z',
      },
      {
        sender: 'Dave',
        text: 'old user follow-up before the prior response finished',
        timestamp: '2026-06-28T22:38:00.000Z',
      },
      {
        sender: 'Mike',
        text: 'fresh context after the prior response',
        timestamp: '2026-06-28T23:00:00.000Z',
      },
    ]);

    const adapter: ChannelAdapter = {
      name: 'discord',
      channelType: 'discord',
      supportsThreads: true,
      setup: vi.fn(),
      teardown: vi.fn(),
      isConnected: vi.fn(() => true),
      deliver: vi.fn(),
      fetchThreadHistory,
    };
    vi.mocked(getChannelAdapter).mockReturnValue(adapter);
    vi.mocked(getMessagingGroupWithAgentCount).mockReturnValue({
      mg: makeMg({
        id: 'mg-discord-number',
        channel_type: 'discord',
        platform_id: 'discord:g:c',
        is_group: 1,
      }),
      agentCount: 1,
    });
    vi.mocked(getMessagingGroupAgents).mockReturnValue([makeAgent({ agent_group_id: 'ag-number' })]);
    vi.mocked(getAgentGroup).mockReturnValue({
      id: 'ag-number',
      name: 'number-drinks',
      folder: 'number-drinks',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    vi.mocked(resolveSession).mockReturnValue({
      session: {
        id: 'sess-thread',
        agent_group_id: 'ag-number',
        messaging_group_id: 'mg-discord-number',
        thread_id: 'discord:g:c:t',
        agent_provider: null,
        status: 'active',
        container_status: 'idle',
        last_active: '2026-06-28T22:36:57.000Z',
        last_outbound_at: '2026-06-28 22:39:40',
        created_at: new Date().toISOString(),
      },
      created: false,
    });

    await routeInbound(
      makeChatEvent('@Axie great, I created staging', {
        channelType: 'discord',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        isDM: false,
        message: {
          id: 'latest-msg',
          kind: 'chat-sdk',
          content: JSON.stringify({ sender: 'Dave', text: '@Axie great, I created staging' }),
          timestamp: '2026-06-28T23:32:27.486Z',
          isMention: true,
          isGroup: true,
        },
      }),
    );

    expect(fetchThreadHistory).toHaveBeenCalledWith('discord:g:c:t', {
      limit: 50,
      excludeMessageId: 'latest-msg',
    });
    expect(writeSessionMessage).toHaveBeenCalledOnce();
    const written = vi.mocked(writeSessionMessage).mock.calls[0]![2];
    const text = JSON.parse(written.content).text as string;
    expect(text).toContain('[New in thread since last response]');
    expect(text).toContain('Mike: fresh context after the prior response');
    expect(text).toContain('[Latest message]\n@Axie great, I created staging');
    expect(text).not.toContain('Pocket meetings');
    expect(text).not.toContain('Pocket yes');
    expect(text).not.toContain('old user follow-up');
  });
});

// Regression: PR #133 codex review — the isChannelVariant refactor dropped
// bare-base matching from these predicates. Bare 'slack'/'discord' are the
// default single-workspace/first-party adapters and MUST pass; variants
// (slack-<ws>, discord-<suffix>) must too. whatsapp-cloud-style sibling
// channels must NOT match a different base.
describe('channel-type predicates accept bare base and variants', () => {
  it('isSlackChannelType: bare + variant pass, others fail', () => {
    expect(isSlackChannelType('slack')).toBe(true);
    expect(isSlackChannelType('slack-illysium')).toBe(true);
    expect(isSlackChannelType('discord')).toBe(false);
    expect(isSlackChannelType('slackish')).toBe(false);
  });

  it('isDiscordChannelType: bare + variant pass, others fail', () => {
    expect(isDiscordChannelType('discord')).toBe(true);
    expect(isDiscordChannelType('discord-second')).toBe(true);
    expect(isDiscordChannelType('slack')).toBe(false);
    expect(isDiscordChannelType('discordia')).toBe(false);
  });
});
