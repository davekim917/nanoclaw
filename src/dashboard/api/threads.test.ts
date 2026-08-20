import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import type { AuthedRequestContext } from '../router.js';
import type { ContainerState } from '../../db/session-db.js';
import type { SessionTranscriptEntry } from './sessions.js';
import {
  buildThreadList,
  deriveThreadState,
  mergeThreadTranscript,
  replyTargetSessionId,
  threadChannelKey,
  UNKNOWN_CHANNEL_KEY,
  type ThreadListDeps,
  type ThreadStateInput,
} from './threads.js';

// container-runner drags in the whole spawn path (docker, mounts, onecli). The
// thread list only wants two functions off it, and both are injectable or
// trivially stubbed.
vi.mock('../../container-runner.js', () => ({
  getActiveContainerSessionIds: () => [],
  resolveAssistantName: (group: { name: string }) => Promise.resolve(`persona:${group.name}`),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-08-20T12:00:00.000Z');

function iso(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString();
}

function makeCtx(opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: iso(0) },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? true,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: iso(0) });
}

function insertSession(opts: {
  id: string;
  agentGroupId: string;
  threadId: string | null;
  messagingGroupId?: string | null;
  title?: string | null;
  titleGeneratedAt?: string | null;
  lastOutboundAt?: string | null;
  lastActive?: string | null;
  archivedAt?: string | null;
  agentProvider?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status,
          title, title_generated_at, last_active, last_outbound_at, archived_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'stopped', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.agentGroupId,
      opts.messagingGroupId ?? null,
      opts.threadId,
      opts.agentProvider ?? null,
      opts.title ?? null,
      opts.titleGeneratedAt ?? null,
      opts.lastActive ?? iso(60_000),
      // Non-null so the never-engaged filter (shared with sessions.ts) keeps the row.
      opts.lastOutboundAt ?? iso(60_000),
      opts.archivedAt ?? null,
      iso(3_600_000),
    );
}

const LIST_OPTS = { groupId: null, includeArchived: false, sinceHours: 168, limit: 200 };

function deps(over: Partial<ThreadListDeps> = {}): ThreadListDeps {
  return {
    now: NOW,
    activeContainerSessionIds: () => [],
    containerStatus: () => 'stale',
    containerState: () => null,
    claimsRoot: '/nonexistent-claims-root',
    avatarByChannelType: () => null,
    ...over,
  };
}

// ── §3.2 channel key ─────────────────────────────────────────────────────────

describe('threadChannelKey', () => {
  const known = new Set([
    'slack:CTESTCHAN01',
    'slack:DTESTUSER01',
    'discord:123456789012345678:123456789098765432',
    'discord:@me:123456789055556666',
  ]);

  it('takes the middle segment of a standard three-part Slack thread id', () => {
    expect(threadChannelKey('slack:CTESTCHAN01:1700000000.444444', known)).toBe('slack:CTESTCHAN01');
    // …and without the wiring directory, from the shape alone.
    expect(threadChannelKey('slack:COTHERCHAN2:1700000000.555555')).toBe('slack:COTHERCHAN2');
  });

  it('collapses every thread in one channel to the same key', () => {
    const a = threadChannelKey('slack:CTESTCHAN01:1700000000.444444', known);
    const b = threadChannelKey('slack:CTESTCHAN01:1700000000.333333', known);
    expect(a).toBe(b);
  });

  it('keeps Slack DM ids (channel segment beginning D) as their own channel', () => {
    expect(threadChannelKey('slack:DTESTUSER01:1700000000.111111', known)).toBe('slack:DTESTUSER01');
    // One-colon form — a DM thread id with no timestamp at all.
    expect(threadChannelKey('slack:DTESTUSER01', known)).toBe('slack:DTESTUSER01');
    // Trailing empty timestamp, present in the live data.
    expect(threadChannelKey('slack:DTESTUSER02:')).toBe('slack:DTESTUSER02');
  });

  it('keeps Discord guild AND channel snowflakes — the middle segment alone is the guild', () => {
    const general = 'discord:123456789012345678:123456789098765432';
    expect(threadChannelKey(`${general}:123456789033334444`, known)).toBe(general);
    expect(threadChannelKey(general, known)).toBe(general);
    // Two different channels in the SAME guild must not collapse together.
    expect(threadChannelKey('discord:123456789012345678:123456789011112222')).not.toBe(threadChannelKey(general));
    expect(threadChannelKey('discord:@me:123456789055556666', known)).toBe('discord:@me:123456789055556666');
  });

  it('buckets the tasks pseudo-channel', () => {
    expect(threadChannelKey('system:tasks:example-task-0001')).toBe('system:tasks');
    expect(threadChannelKey('system:tasks:example-task-0002')).toBe('system:tasks');
  });

  it('degrades legacy bare thread ids to one stable bucket', () => {
    expect(threadChannelKey('1700000000.222222')).toBe(UNKNOWN_CHANNEL_KEY);
    expect(threadChannelKey('spawn-abcdef0123456789')).toBe(UNKNOWN_CHANNEL_KEY);
  });

  it('never throws on a malformed id', () => {
    for (const bad of [null, undefined, '', '   ', ':', '::', ':foo', 'slack:', 'discord:123456789012345678']) {
      expect(() => threadChannelKey(bad)).not.toThrow();
      expect(threadChannelKey(bad)).toBe(UNKNOWN_CHANNEL_KEY);
    }
  });
});

// ── §5 the six states ────────────────────────────────────────────────────────

describe('deriveThreadState', () => {
  const base: ThreadStateInput = {
    sessionCount: 1,
    allArchived: false,
    claimState: null,
    claimNote: '',
    needsOperator: false,
    containerStatus: 'stale',
    providerStatus: null,
    toolStartedAtMs: null,
    lastOutputAtMs: null,
    now: NOW,
  };

  it('unassigned — a work item with no thread and no session', () => {
    expect(deriveThreadState({ ...base, sessionCount: 0 })).toBe('unassigned');
  });

  it('needs_you — a parked claim whose note says waiting on a human', () => {
    expect(deriveThreadState({ ...base, claimState: 'parked', claimNote: 'waiting on the operator to answer' })).toBe(
      'needs_you',
    );
  });

  it('needs_you — a session sitting on an unanswered question', () => {
    expect(deriveThreadState({ ...base, needsOperator: true })).toBe('needs_you');
  });

  it('stalled — tool_started_at older than 30m with no newer output', () => {
    expect(deriveThreadState({ ...base, toolStartedAtMs: NOW - 31 * 60_000 })).toBe('stalled');
  });

  it('running — heartbeat fresh', () => {
    expect(deriveThreadState({ ...base, containerStatus: 'running' })).toBe('running');
  });

  it('parked — a claim in parked state with no waiting-on note', () => {
    expect(deriveThreadState({ ...base, claimState: 'parked', claimNote: 'handing this off' })).toBe('parked');
  });

  it('done — every backing session archived', () => {
    expect(deriveThreadState({ ...base, allArchived: true })).toBe('done');
  });

  it('idle — the residual DESIGN.md does not name', () => {
    expect(deriveThreadState(base)).toBe('idle');
  });
});

describe('the stall rule (§5.1)', () => {
  const stalling: ThreadStateInput = {
    sessionCount: 1,
    allArchived: false,
    claimState: null,
    claimNote: '',
    needsOperator: false,
    // A wedged tool stops the heartbeat, so a stalled thread reads `stale`.
    containerStatus: 'stale',
    providerStatus: 'active',
    toolStartedAtMs: NOW - 45 * 60_000,
    lastOutputAtMs: NOW - 50 * 60_000,
    now: NOW,
  };

  it('fires on tool age alone — current_tool is never consulted', () => {
    // The input carries no tool NAME at all: the Codex fleet reports the
    // generic `CodexItem` and half the fleet is non-Claude (§5.1).
    expect(deriveThreadState(stalling)).toBe('stalled');
    expect(Object.keys(stalling)).not.toContain('currentTool');
  });

  it('does not fire while the tool is younger than 30m', () => {
    expect(deriveThreadState({ ...stalling, toolStartedAtMs: NOW - 29 * 60_000 })).not.toBe('stalled');
  });

  it('does not fire when output landed after the tool started', () => {
    expect(deriveThreadState({ ...stalling, lastOutputAtMs: NOW - 60_000 })).not.toBe('stalled');
  });

  it('surfaces provider_status = failed, which nothing read before', () => {
    expect(deriveThreadState({ ...stalling, providerStatus: 'failed', toolStartedAtMs: null })).toBe('stalled');
  });
});

// ── §3.1 thread grouping ─────────────────────────────────────────────────────

describe('buildThreadList — grouping', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('collapses a six-agent thread to ONE row carrying six participants', async () => {
    const thread = 'slack:CFIXTURECH3:1700000000.666666';
    for (let i = 1; i <= 6; i++) {
      seedAgentGroup(`ag-${i}`);
      insertSession({
        id: `s-${i}`,
        agentGroupId: `ag-${i}`,
        threadId: thread,
        // Agent 6 spoke most recently, agent 1 longest ago.
        lastOutboundAt: iso((7 - i) * 60_000),
        lastActive: iso((7 - i) * 60_000 + 1_000),
      });
    }

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());

    expect(threads).toHaveLength(1);
    const row = threads[0]!;
    expect(row.thread_id).toBe(thread);
    expect(row.synthetic).toBe(false);
    expect([...row.session_ids].sort()).toEqual(['s-1', 's-2', 's-3', 's-4', 's-5', 's-6']);
    expect(row.participants.map((p) => p.agent_group_id)).toEqual(['ag-6', 'ag-5', 'ag-4', 'ag-3', 'ag-2', 'ag-1']);
    // §10.2: identity is inline, resolved through the persona name.
    expect(row.participants[0]!.name).toBe('persona:ag-6');
    expect(row.channel_key).toBe('slack:CFIXTURECH3');
  });

  it('keeps distinct threads in one channel as distinct rows', async () => {
    seedAgentGroup('ag-1');
    insertSession({ id: 's-a', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-b', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:2.2' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((t) => t.channel_key))).toEqual(new Set(['slack:CTESTCHAN01']));
  });

  it('does not drop sessions with a NULL thread_id — they get a synthetic key', async () => {
    seedAgentGroup('ag-1');
    insertSession({ id: 's-null', agentGroupId: 'ag-1', threadId: null });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.thread_id).toBe('session:s-null');
    expect(threads[0]!.synthetic).toBe(true);
    expect(threads[0]!.channel_key).toBe(UNKNOWN_CHANNEL_KEY);
    expect(threads[0]!.session_ids).toEqual(['s-null']);
  });

  it('takes the title from whichever session generated one most recently', async () => {
    const thread = 'slack:CTESTCHAN01:9.9';
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    insertSession({
      id: 's-1',
      agentGroupId: 'ag-1',
      threadId: thread,
      title: 'older title',
      titleGeneratedAt: iso(600_000),
    });
    insertSession({
      id: 's-2',
      agentGroupId: 'ag-2',
      threadId: thread,
      title: 'newer title',
      titleGeneratedAt: iso(60_000),
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.title).toBe('newer title');
  });

  it('resolves the channel key to a friendly name from messaging_groups', async () => {
    seedAgentGroup('ag-1');
    getDb()
      .prepare(
        `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('mg-1', 'slack-testworkspace', 'testworkspace', 'slack:COTHERCHAN2', '#example-room', iso(0));
    insertSession({
      id: 's-1',
      agentGroupId: 'ag-1',
      threadId: 'slack:COTHERCHAN2:1700000000.555555',
      messagingGroupId: 'mg-1',
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('slack:COTHERCHAN2');
    expect(threads[0]!.channel_name).toBe('#example-room');
  });

  it('recomputes liveness per §3.4 and surfaces provider_status for live containers only', async () => {
    const thread = 'slack:CTESTCHAN01:5.5';
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    insertSession({ id: 's-live', agentGroupId: 'ag-1', threadId: thread });
    insertSession({ id: 's-dead', agentGroupId: 'ag-2', threadId: thread });

    const probed: string[] = [];
    const failed: ContainerState = {
      current_tool: 'CodexItem',
      tool_declared_timeout_ms: null,
      tool_started_at: null,
      provider_status: 'failed',
    } as ContainerState;

    const { threads } = await buildThreadList(
      makeCtx(),
      LIST_OPTS,
      deps({
        activeContainerSessionIds: () => ['s-live'],
        containerStatus: (_ag, id) => (id === 's-live' ? 'running' : 'stale'),
        containerState: (_ag, id) => {
          probed.push(id);
          return failed;
        },
      }),
    );

    // The bound: only the session with a live container process was opened.
    expect(probed).toEqual(['s-live']);
    expect(threads[0]!.provider_status).toBe('failed');
    expect(threads[0]!.container_status).toBe('running');
    expect(threads[0]!.state).toBe('stalled');
  });

  it('resolves participant provider through resolveProviderName, not the deprecated agent_groups column', async () => {
    const thread = 'slack:CTESTCHAN01:7.7';
    seedAgentGroup('ag-codex');
    seedAgentGroup('ag-default');
    insertSession({ id: 's-codex', agentGroupId: 'ag-codex', threadId: thread, agentProvider: 'CODEX' });
    // No session provider and no container_configs row → the documented
    // 'claude' floor, never an empty string.
    insertSession({ id: 's-default', agentGroupId: 'ag-default', threadId: thread });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    const byAgent = new Map(threads[0]!.participants.map((p) => [p.agent_group_id, p.provider]));
    expect(byAgent.get('ag-codex')).toBe('codex');
    expect(byAgent.get('ag-default')).toBe('claude');
  });

  it('normalizes the naive last_outbound_at column to ISO-8601 UTC on the wire', async () => {
    seedAgentGroup('ag-1');
    insertSession({
      id: 's-1',
      agentGroupId: 'ag-1',
      threadId: 'slack:CTESTCHAN01:1.1',
      // Exactly the shape `bumpLastOutbound` writes — no zone marker.
      lastOutboundAt: '2026-08-20 06:16:56',
      lastActive: '2026-08-20T06:00:00.000Z',
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.last_activity_at).toBe('2026-08-20T06:16:56.000Z');
  });

  it('honours scope — an out-of-scope group yields no rows rather than a 403', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    insertSession({ id: 's-1', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-2', agentGroupId: 'ag-2', threadId: 'slack:CTESTCHAN01:2.2' });

    const scoped = makeCtx({ no_filter: false, allowed_group_ids: ['ag-1'] });
    const { threads } = await buildThreadList(scoped, LIST_OPTS, deps());
    expect(threads.map((t) => t.session_ids)).toEqual([['s-1']]);
  });
});

// ── §10.3 reply targeting + snooze ───────────────────────────────────────────

/**
 * A thread is N sessions and the steer path writes into exactly ONE inbound
 * queue, so the console has to name a session before it can send anything.
 * These tests pin the default it names — "the agent whose state drove the row's
 * urgency" — because the tempting shortcut is `session_ids[0]`, which routinely
 * addresses an agent that never asked the question.
 */
describe('replyTargetSessionId (§10.3)', () => {
  const rows = [{ id: 's-fresh' }, { id: 's-asked' }, { id: 's-old' }];
  const asked = (r: { id: string }): boolean => r.id === 's-asked';
  const nobody = (): boolean => false;

  it('names the session actually sitting on the question, not the freshest', () => {
    expect(replyTargetSessionId('needs_you', rows, { needsOperator: asked, pickedSessionId: null })).toBe('s-asked');
  });

  it('names the session whose container_state the row is rendering when it stalled', () => {
    expect(replyTargetSessionId('stalled', rows, { needsOperator: nobody, pickedSessionId: 's-old' })).toBe('s-old');
    expect(replyTargetSessionId('running', rows, { needsOperator: nobody, pickedSessionId: 's-old' })).toBe('s-old');
  });

  it('falls back to the most recently active session for every other state', () => {
    for (const state of ['parked', 'done', 'idle', 'unassigned'] as const) {
      expect(replyTargetSessionId(state, rows, { needsOperator: asked, pickedSessionId: 's-old' })).toBe('s-fresh');
    }
    // …and also when the state's own driver cannot be identified.
    expect(replyTargetSessionId('needs_you', rows, { needsOperator: nobody, pickedSessionId: null })).toBe('s-fresh');
    expect(replyTargetSessionId('stalled', rows, { needsOperator: nobody, pickedSessionId: null })).toBe('s-fresh');
  });

  it('returns null rather than inventing a target for a thread with no sessions', () => {
    expect(replyTargetSessionId('unassigned', [], { needsOperator: nobody, pickedSessionId: null })).toBeNull();
  });
});

describe('buildThreadList — reply target and snooze', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('gives every participant the session a reply to THEM lands in', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    const thread = 'slack:CTESTCHAN01:1700000000.11';
    insertSession({
      id: 's-1',
      agentGroupId: 'ag-1',
      threadId: thread,
      lastOutboundAt: iso(600_000),
      lastActive: iso(600_000),
    });
    insertSession({
      id: 's-2',
      agentGroupId: 'ag-2',
      threadId: thread,
      lastOutboundAt: iso(60_000),
      lastActive: iso(60_000),
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.participants.map((p) => [p.agent_group_id, p.session_id])).toEqual([
      ['ag-2', 's-2'],
      ['ag-1', 's-1'],
    ]);
    // Nothing is asking and nothing is live, so the default is the freshest.
    expect(threads[0]!.reply_target_session_id).toBe('s-2');
  });

  it('aims at the session that asked, even when another agent spoke more recently', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    const thread = 'slack:CTESTCHAN01:1700000000.11';
    insertSession({
      id: 's-asked',
      agentGroupId: 'ag-1',
      threadId: thread,
      lastOutboundAt: iso(600_000),
      lastActive: iso(900_000),
    });
    insertSession({
      id: 's-chatty',
      agentGroupId: 'ag-2',
      threadId: thread,
      lastOutboundAt: iso(60_000),
      lastActive: iso(60_000),
    });
    // An unanswered `ask_question`: the outbound is newer than the last inbound.
    getDb()
      .prepare(`UPDATE sessions SET last_outbound_kind = 'chat-sdk:ask_question', last_active = ? WHERE id = ?`)
      .run(iso(900_000), 's-asked');

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.state).toBe('needs_you');
    expect(threads[0]!.reply_target_session_id).toBe('s-asked');
  });

  it('aims at the session whose container_state it is rendering when the row is stalled', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    const thread = 'slack:CTESTCHAN01:1700000000.11';
    // Both sessions last spoke BEFORE the tool started — that is what makes the
    // 30-minute stall rule fire (§5): a newer output would mean it un-wedged.
    insertSession({
      id: 's-wedged',
      agentGroupId: 'ag-1',
      threadId: thread,
      lastOutboundAt: iso(90 * 60_000),
      lastActive: iso(90 * 60_000),
    });
    insertSession({
      id: 's-fine',
      agentGroupId: 'ag-2',
      threadId: thread,
      lastOutboundAt: iso(50 * 60_000),
      lastActive: iso(50 * 60_000),
    });

    const { threads } = await buildThreadList(
      makeCtx(),
      LIST_OPTS,
      deps({
        activeContainerSessionIds: () => ['s-wedged'],
        containerState: (_ag, id) =>
          id === 's-wedged'
            ? ({ current_tool: 'Bash', tool_started_at: iso(45 * 60_000), provider_status: 'active' } as never)
            : null,
      }),
    );
    expect(threads[0]!.state).toBe('stalled');
    expect(threads[0]!.reply_target_session_id).toBe('s-wedged');
  });

  it('reports no snooze by default', async () => {
    seedAgentGroup('ag-1');
    insertSession({ id: 's-1', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:1700000000.11' });
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.snoozed).toBe(false);
  });

  it('reports the caller’s own snooze, and drops it once the thread moves', async () => {
    seedAgentGroup('ag-1');
    const thread = 'slack:CTESTCHAN01:1700000000.11';
    insertSession({ id: 's-1', agentGroupId: 'ag-1', threadId: thread, lastOutboundAt: iso(60_000) });
    getDb()
      .prepare(
        `INSERT INTO thread_snoozes (thread_id, user_id, snoozed_at_activity, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(thread, 'u1', iso(60_000), iso(0));

    expect((await buildThreadList(makeCtx(), LIST_OPTS, deps())).threads[0]!.snoozed).toBe(true);
    // Another operator sees the thread untouched — a snooze is one queue's view.
    const other = makeCtx();
    other.user.id = 'u2';
    expect((await buildThreadList(other, LIST_OPTS, deps())).threads[0]!.snoozed).toBe(false);

    // The thread speaks again: the same row stops hiding it, with no sweep.
    getDb().prepare('UPDATE sessions SET last_outbound_at = ? WHERE id = ?').run(iso(0), 's-1');
    expect((await buildThreadList(makeCtx(), LIST_OPTS, deps())).threads[0]!.snoozed).toBe(false);
  });
});

// ── §10.1 merged transcript ──────────────────────────────────────────────────

describe('mergeThreadTranscript', () => {
  it('interleaves two sessions in timestamp order and tags each message with its agent', () => {
    const bySession: Record<string, SessionTranscriptEntry[]> = {
      'sess-a': [
        { direction: 'in', kind: 'chat', seq: 2, timestamp: '2026-08-20T10:00:00.000Z', text: 'question' },
        { direction: 'out', kind: 'chat', seq: 3, timestamp: '2026-08-20T10:00:30.000Z', text: 'a-answers' },
      ],
      'sess-b': [
        // Same `seq` values as sess-a — proof that seq cannot order a thread.
        { direction: 'out', kind: 'chat', seq: 3, timestamp: '2026-08-20T10:00:10.000Z', text: 'b-answers-first' },
        { direction: 'out', kind: 'chat', seq: 5, timestamp: '2026-08-20T10:01:00.000Z', text: 'b-follows-up' },
      ],
    };

    const merged = mergeThreadTranscript(
      [
        { sessionId: 'sess-a', agentGroupId: 'ag-a', agentName: 'Alpha' },
        { sessionId: 'sess-b', agentGroupId: 'ag-b', agentName: 'Bravo' },
      ],
      (_ag, sessionId) => bySession[sessionId] ?? [],
    );

    expect(merged.map((m) => m.text)).toEqual(['question', 'b-answers-first', 'a-answers', 'b-follows-up']);
    expect(merged.map((m) => m.agent_name)).toEqual(['Alpha', 'Bravo', 'Alpha', 'Bravo']);
    expect(merged.map((m) => m.session_id)).toEqual(['sess-a', 'sess-b', 'sess-a', 'sess-b']);
    expect(merged.map((m) => m.agent_group_id)).toEqual(['ag-a', 'ag-b', 'ag-a', 'ag-b']);
  });

  it('keeps the newest tail and returns it oldest-first', () => {
    const entries: SessionTranscriptEntry[] = Array.from({ length: 5 }, (_, i) => ({
      direction: 'out' as const,
      kind: 'chat',
      seq: i + 1,
      timestamp: new Date(Date.parse('2026-08-20T10:00:00.000Z') + i * 1000).toISOString(),
      text: `m${i}`,
    }));
    const merged = mergeThreadTranscript([{ sessionId: 's', agentGroupId: 'ag', agentName: 'A' }], () => entries, 2);
    expect(merged.map((m) => m.text)).toEqual(['m3', 'm4']);
  });

  it('ties break deterministically when two sessions share a millisecond', () => {
    const at = '2026-08-20T10:00:00.000Z';
    const merged = mergeThreadTranscript(
      [
        { sessionId: 'zzz', agentGroupId: 'ag-z', agentName: 'Z' },
        { sessionId: 'aaa', agentGroupId: 'ag-a', agentName: 'A' },
      ],
      (_ag, sessionId) => [{ direction: 'out', kind: 'chat', seq: 1, timestamp: at, text: sessionId }],
    );
    expect(merged.map((m) => m.text)).toEqual(['aaa', 'zzz']);
  });
});
