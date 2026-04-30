import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldRecallForKind,
  shouldRecall,
  maybeInjectRecall,
  clearMemoryEnabledCacheForTest,
  setMemoryEnabledOverride,
  setHealthRecorder,
  setStoreForTest,
  type SessionMessageInput,
  type RoutingAddr,
} from './recall-injection.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('./mnemon-impl.js', () => ({
  MnemonStore: class {
    recall = vi.fn().mockResolvedValue({ facts: [], totalAvailable: 0, latencyMs: 0, fromCache: false });
  },
}));

const mockDb = {
  prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
  close: vi.fn(),
};

vi.mock('../../session-manager.js', () => ({
  openInboundDb: vi.fn(() => mockDb),
}));

vi.mock('../../db/session-db.js', () => ({
  insertMessage: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(overrides: Partial<SessionMessageInput> = {}): SessionMessageInput {
  return {
    id: 'msg-1',
    kind: 'chat',
    timestamp: new Date().toISOString(),
    channelType: 'slack',
    platformId: 'U123',
    threadId: null,
    content: JSON.stringify({ text: "What's the current architecture for Apollo's data pipeline?" }),
    trigger: 1,
    ...overrides,
  };
}

function makeRouting(channelType: string | null = 'slack'): RoutingAddr {
  return { channelType, platformId: 'P1', threadId: null };
}

// ---------------------------------------------------------------------------
// shouldRecallForKind
// ---------------------------------------------------------------------------

describe('shouldRecallForKind', () => {
  it('test_shouldRecallForKind_excludes_agent_channel', () => {
    expect(shouldRecallForKind('chat', 'agent')).toBe(false);
  });

  it('test_shouldRecallForKind_includes_real_chat', () => {
    expect(shouldRecallForKind('chat', 'slack')).toBe(true);
    expect(shouldRecallForKind('chat', 'discord')).toBe(true);
    expect(shouldRecallForKind('chat', null)).toBe(true);
  });

  it('test_shouldRecallForKind_excludes_task', () => {
    expect(shouldRecallForKind('task', null)).toBe(false);
    expect(shouldRecallForKind('task', 'slack')).toBe(false);
  });

  it('test_shouldRecallForKind_system_excluded', () => {
    expect(shouldRecallForKind('system', null)).toBe(false);
    expect(shouldRecallForKind('system', 'slack')).toBe(false);
  });

  it('test_shouldRecallForKind_webhook_and_chat_sdk_included', () => {
    expect(shouldRecallForKind('webhook', null)).toBe(true);
    expect(shouldRecallForKind('chat-sdk', null)).toBe(true);
    expect(shouldRecallForKind('chat-sdk', 'agent')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// shouldRecall
// ---------------------------------------------------------------------------

describe('shouldRecall', () => {
  it('test_shouldRecall_filters_acks', () => {
    expect(shouldRecall('ok')).toBe(false);
    expect(shouldRecall('yes')).toBe(false);
    expect(shouldRecall('thanks')).toBe(false);
    expect(shouldRecall('👍')).toBe(false);
    expect(shouldRecall('')).toBe(false);
    expect(shouldRecall('yes thanks')).toBe(false);
  });

  it('test_shouldRecall_passes_substantive', () => {
    expect(shouldRecall("What's the current architecture for Apollo's data pipeline?")).toBe(true);
    expect(shouldRecall('This is a longer question about something')).toBe(true);
    expect(shouldRecall('one two three four')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// maybeInjectRecall
// ---------------------------------------------------------------------------

describe('maybeInjectRecall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMemoryEnabledCacheForTest();
    setMemoryEnabledOverride(null);
    mockDb.prepare.mockReturnValue({ all: vi.fn().mockReturnValue([]) });
    mockDb.close.mockReset();
  });

  afterEach(() => {
    setMemoryEnabledOverride(null);
    setHealthRecorder(null);
  });

  it('test_maybeInjectRecall_no_op_on_trigger_zero', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const msg = makeMsg({ trigger: 0 });
    await maybeInjectRecall({ agentGroupId: 'ag-1', sessionId: 'sess-1', inboundMessage: msg, routing: makeRouting() });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_recursion_guard', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    const msg = makeMsg({ kind: 'system' });
    await maybeInjectRecall({ agentGroupId: 'ag-1', sessionId: 'sess-1', inboundMessage: msg, routing: makeRouting() });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_no_op_on_disabled_group', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => false);
    const msg = makeMsg();
    await maybeInjectRecall({
      agentGroupId: 'ag-disabled',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('test_maybeInjectRecall_writes_system_msg_on_success', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => true);

    const instanceRecall = vi.fn().mockResolvedValue({
      facts: [
        { id: 'f1', content: 'Fact one', category: 'fact', importance: 3, entities: [], score: 0.9, createdAt: '' },
        { id: 'f2', content: 'Fact two', category: 'insight', importance: 4, entities: [], score: 0.8, createdAt: '' },
      ],
      totalAvailable: 2,
      latencyMs: 50,
      fromCache: false,
    });
    setStoreForTest({ recall: instanceRecall } as never);

    const msg = makeMsg({ id: 'msg-enable-1' });
    await maybeInjectRecall({
      agentGroupId: 'ag-enabled',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });

    expect(insertMessage).toHaveBeenCalledOnce();
    const call = vi.mocked(insertMessage).mock.calls[0] as [unknown, { kind: string; id: string; content: string }];
    expect(call[1].kind).toBe('system');
    expect(call[1].id).toBe('recall-msg-enable-1');
    const content = JSON.parse(call[1].content) as { subtype: string };
    expect(content.subtype).toBe('recall_context');
  });

  it('test_maybeInjectRecall_no_op_on_recall_error', async () => {
    const { insertMessage } = await import('../../db/session-db.js');
    setMemoryEnabledOverride(() => true);

    const errorRecall = vi.fn().mockRejectedValue(new Error('timeout'));
    setStoreForTest({ recall: errorRecall } as never);

    const healthFn = vi.fn();
    setHealthRecorder({ recordRecallFailOpen: healthFn });

    const msg = makeMsg({ id: 'msg-err-1' });
    await maybeInjectRecall({
      agentGroupId: 'ag-error',
      sessionId: 'sess-1',
      inboundMessage: msg,
      routing: makeRouting(),
    });

    expect(insertMessage).not.toHaveBeenCalled();
    expect(healthFn).toHaveBeenCalledOnce();
  });
});
