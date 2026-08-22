import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { ATTENTION_ITEM_PREFIX, ATTENTION_MEMO_TTL_MS, clearAttentionMemo } from '../../attention-sources.js';
import type { AuthedRequestContext } from '../router.js';
import type { ContainerState } from '../../db/session-db.js';
import type { SessionTranscriptEntry } from './sessions.js';
import {
  buildThreadList,
  deriveNeedsYouReason,
  deriveThreadState,
  isScheduledTaskThread,
  mergeThreadTranscript,
  pickDoneProposal,
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
  // Reached through thread-close.ts's read side, which the list imports for
  // `readThreadClosures`. Neither is called on this path; stubbed so the module
  // graph resolves without the spawn path.
  isContainerRunning: () => false,
  killContainer: () => {},
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
  // Module-level memo, and vitest keeps module state across files in a worker:
  // an un-cleared one would serve a previous DB's attention items into this one.
  clearAttentionMemo();
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string, workgroupId?: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: iso(0) });
  // `createAgentGroup` does not carry workgroup_id; the reconcile path sets it.
  if (workgroupId) getDb().prepare('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?').run(workgroupId, id);
}

function seedWorkgroup(id: string): void {
  getDb().prepare('INSERT INTO workgroups (id, created_at) VALUES (?, ?)').run(id, iso(0));
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
  /** Migration 056's routing stamp — task sessions only. */
  taskRoutingPlatformId?: string | null;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status,
          title, title_generated_at, last_active, last_outbound_at, archived_at, created_at,
          task_routing_platform_id)
       VALUES (?, ?, ?, ?, ?, 'active', 'stopped', ?, ?, ?, ?, ?, ?, ?)`,
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
      opts.createdAt ?? iso(3_600_000),
      opts.taskRoutingPlatformId ?? null,
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

  // ── The zero-session item is not automatically unowned ────────────────────
  //
  // Claims are keyed by THREAD ID and live in workgroup files, not in
  // `sessions`, so an item with no session at all can still carry a parked
  // claim naming the human it waits on. That is why the two needs_you tests
  // run before the `sessionCount === 0` guard: `unassigned` means "nobody has
  // picked this up", which is a different and wrong claim about an item a
  // human owes an answer on.

  it('needs_you — a zero-session item whose parked note says waiting on a human', () => {
    expect(
      deriveThreadState({
        ...base,
        sessionCount: 0,
        claimState: 'parked',
        claimNote: 'waiting on the release owner to approve the release',
      }),
    ).toBe('needs_you');
  });

  it('unassigned — a zero-session item with no claim, or a park note that names no human', () => {
    expect(deriveThreadState({ ...base, sessionCount: 0, claimState: null, claimNote: '' })).toBe('unassigned');
    expect(deriveThreadState({ ...base, sessionCount: 0, claimState: 'parked', claimNote: 'handing this off' })).toBe(
      'unassigned',
    );
  });

  it('needs_you — a zero-session item flagged needsOperator', () => {
    expect(deriveThreadState({ ...base, sessionCount: 0, needsOperator: true })).toBe('needs_you');
  });

  it('the guard still outranks everything BELOW it — a zero-session item never reads as live work', () => {
    // Provider status, container liveness, tool timing and the residual park
    // all need a session to mean anything, so they stay under the guard.
    expect(
      deriveThreadState({
        ...base,
        sessionCount: 0,
        containerStatus: 'running',
        providerStatus: 'active',
        toolStartedAtMs: NOW - 31 * 60_000,
        claimState: 'parked',
        claimNote: 'handing this off',
      }),
    ).toBe('unassigned');
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

  it('idle — the residual DESIGN.md does not name', () => {
    expect(deriveThreadState(base)).toBe('idle');
  });
});

describe('the stall rule (§5.1)', () => {
  const stalling: ThreadStateInput = {
    sessionCount: 1,
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

// ── needs_you_reason (operator report 2026-08-21) ────────────────────────────

describe('deriveNeedsYouReason', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      id: 's1',
      agent_group_id: 'ag1',
      last_outbound_kind: null,
      last_active: null,
      last_outbound_at: null,
      attached_task_needs_input: null,
      attached_task_steer_question: null,
      ...over,
    }) as never;

  const noClaim = { state: null, note: '' };
  const askedRow = row({
    last_outbound_kind: 'chat-sdk:ask_question',
    last_outbound_at: iso(600_000),
    last_active: iso(900_000), // older than the outbound — still unanswered
  });

  it('a parked "waiting on" claim yields its note as the reason, verbatim', () => {
    const claim = {
      state: 'parked' as const,
      note: 'waiting on the release owner or backup reviewer: PR #956 mechanically ready at 64c1cca1',
    };
    expect(deriveNeedsYouReason([row()], claim)).toEqual({
      cause: 'parked_note',
      text: 'waiting on the release owner or backup reviewer: PR #956 mechanically ready at 64c1cca1',
      parked_ms: null,
    });
  });

  it('carries the claim PARK AGE alongside the note', () => {
    // The console does NOT reconcile a claim against reality — releasing one is
    // the claim owner's job, and a display that second-guesses its source
    // produces two disagreeing truths. Live evidence when this was written: two
    // claims still asserting a human owed a decision on a PR that had merged
    // hours earlier. The age is what makes that legible without the console
    // inventing a verdict.
    const claim = { state: 'parked' as const, note: 'waiting on a human: PR #956 ready', staleMs: 40 * 3_600_000 };
    expect(deriveNeedsYouReason([row()], claim)).toEqual({
      cause: 'parked_note',
      text: 'waiting on a human: PR #956 ready',
      parked_ms: 40 * 3_600_000,
    });
  });

  it('reports an unmeasured park age as null, never as zero', () => {
    // `claims-board.ts` writes staleMs = 0 when `parked_at` is missing or
    // unparseable. §12: an unmeasured value is not a zero — a zero here would
    // render "parked 0s ago", the exact opposite of what it means.
    for (const staleMs of [undefined, 0, -5]) {
      expect(deriveNeedsYouReason([row()], { state: 'parked', note: 'waiting on a human', staleMs })).toEqual({
        cause: 'parked_note',
        text: 'waiting on a human',
        parked_ms: null,
      });
    }
  });

  it('an unanswered ask_question yields the ask_question cause — honest, not a fabricated question', () => {
    const reason = deriveNeedsYouReason([askedRow], noClaim);
    expect(reason).toEqual({
      cause: 'ask_question',
      text: 'The agent asked a question and is waiting for a reply.',
    });
  });

  it('a task flagged needs_input quotes the worker’s own steer_question when it gave one', () => {
    const withQuestion = row({ attached_task_needs_input: 1, attached_task_steer_question: 'Repo path A or B?' });
    expect(deriveNeedsYouReason([withQuestion], noClaim)).toEqual({
      cause: 'task_needs_input',
      text: 'Repo path A or B?',
    });
  });

  it('a task flagged needs_input with no steer_question falls back to a plain statement, never a guess', () => {
    const noQuestion = row({ attached_task_needs_input: 1, attached_task_steer_question: null });
    expect(deriveNeedsYouReason([noQuestion], noClaim)).toEqual({
      cause: 'task_needs_input',
      text: 'A running task needs input to continue.',
    });
  });

  it('the parked note outranks a session cause on the same thread — mirrors deriveThreadState’s own precedence', () => {
    const claim = { state: 'parked' as const, note: 'waiting on ops to confirm the rollback' };
    expect(deriveNeedsYouReason([askedRow], claim)?.cause).toBe('parked_note');
  });

  it('is null — never a guess — when none of the three causes explains it', () => {
    // Parked, but the note does not say "waiting on"; no session is asking or
    // flagged. Nothing here names a cause, so nothing is rendered.
    expect(deriveNeedsYouReason([row()], { state: 'parked', note: 'handing this off' })).toBeNull();
    expect(deriveNeedsYouReason([row()], noClaim)).toBeNull();
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

// ── DEFECT 1 (operator report, 2026-08-20): the fake "tasks" channel + a
//    synthetic session's recoverable channel ─────────────────────────────────

function insertMessagingGroup(opts: {
  id: string;
  platformId: string;
  name?: string | null;
  channelType?: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.channelType ?? 'slack-test',
      opts.channelType ?? 'slack-test',
      opts.platformId,
      opts.name ?? null,
      iso(0),
    );
}

describe('buildThreadList — synthetic session channel recovery (§3.2 gap, DEFECT 1)', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('a synthetic (NULL thread_id) session lands in its messaging group channel, not unknown', async () => {
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-1', platformId: 'discord:1111:2222', name: 'general' });
    insertSession({ id: 's-null', agentGroupId: 'ag-1', threadId: null, messagingGroupId: 'mg-1' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.synthetic).toBe(true);
    // The load-bearing assertion: this FAILS against the prior behavior, which
    // unconditionally passed `null` to threadChannelKey for every synthetic
    // thread and always landed on UNKNOWN_CHANNEL_KEY regardless of
    // messaging_group_id.
    expect(threads[0]!.channel_key).toBe('discord:1111:2222');
    expect(threads[0]!.channel_name).toBe('general');
  });

  it('isScheduledTaskThread: matches the legacy shared session and every per-series session, nothing else', () => {
    expect(isScheduledTaskThread('system:tasks')).toBe(true);
    expect(isScheduledTaskThread('system:tasks:example-task-0001')).toBe(true);
    // No colon after the prefix — a channel that merely starts with the same
    // letters must never match.
    expect(isScheduledTaskThread('system:tasksxyz')).toBe(false);
    expect(isScheduledTaskThread('slack:CTESTCHAN01:1.1')).toBe(false);
  });

  it('an unanchored system:tasks:<series> thread flags scheduled_task and falls back to the honest "Unrouted tasks" label', async () => {
    seedAgentGroup('ag-1');
    // Verified against the live central DB (2026-08-20): a `ncl tasks`
    // execution's own isolated session never carries a messaging_group_id
    // (`resolveTaskSession` in session-manager.ts). A task that has never
    // POSTED (no `task_thread_anchors` row — see the describe block below)
    // genuinely has no channel to recover into, so it lands in the
    // `system:tasks` bucket §3.2 already documents — but with an honest label,
    // not the bare `tasks` that used to read as a peer of real channels.
    insertSession({ id: 's-task', agentGroupId: 'ag-1', threadId: 'system:tasks:example-task-0001' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.synthetic).toBe(false);
    expect(threads[0]!.scheduled_task).toBe(true);
    expect(threads[0]!.channel_key).toBe('system:tasks');
    expect(threads[0]!.channel_name).toBe('Unrouted tasks');
  });

  it('an ordinary channel thread is never flagged scheduled_task', async () => {
    seedAgentGroup('ag-1');
    insertSession({ id: 's-1', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:1.1' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.scheduled_task).toBe(false);
  });
});

// ── DEFECT 1, continued (coordinator follow-up, 2026-08-21): task_thread_anchors ──

function insertTaskAnchor(opts: {
  sessionId: string;
  platformId: string;
  channelType?: string;
  createdAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO task_thread_anchors (session_id, channel_type, platform_id, thread_platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(opts.sessionId, opts.channelType ?? 'slack-test', opts.platformId, 'slack:T1.1', opts.createdAt);
}

describe('buildThreadList — scheduled tasks resolve to where they actually posted (task_thread_anchors)', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('an anchored task thread resolves to its real channel and friendly name, not the tasks bucket', async () => {
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-1', platformId: 'slack:CTESTDISPATCH1', name: '#example-dispatch' });
    insertSession({ id: 's-task', agentGroupId: 'ag-1', threadId: 'system:tasks:example-task-0001' });
    insertTaskAnchor({ sessionId: 's-task', platformId: 'slack:CTESTDISPATCH1', createdAt: iso(60_000) });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    // The load-bearing assertion: against the prior behavior (no anchor
    // lookup at all) this is `system:tasks` / `Unrouted tasks`, exactly the
    // fake-channel defect the operator reported.
    expect(threads[0]!.channel_key).toBe('slack:CTESTDISPATCH1');
    expect(threads[0]!.channel_name).toBe('#example-dispatch');
    // The pill survives regardless of which branch resolved the channel —
    // it is what says "scheduled run", now that the row sits among real
    // channel threads instead of a segregated fake one.
    expect(threads[0]!.scheduled_task).toBe(true);
  });

  it('tie-break: a session re-pointed to a different channel resolves to the MOST RECENT anchor', async () => {
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-old', platformId: 'slack:CTESTOLDROOM1', name: '#example-old-room' });
    insertMessagingGroup({ id: 'mg-new', platformId: 'slack:CTESTNEWROOM2', name: '#example-new-room' });
    insertSession({ id: 's-task', agentGroupId: 'ag-1', threadId: 'system:tasks:example-task-0002' });
    // Verified live: a single session can carry two anchor rows because a
    // recurring series got re-pointed between runs. Inserted out of
    // chronological order on purpose — the rule keys on `created_at`, not
    // insertion or row order.
    insertTaskAnchor({ sessionId: 's-task', platformId: 'slack:CTESTNEWROOM2', createdAt: iso(60_000) });
    insertTaskAnchor({ sessionId: 's-task', platformId: 'slack:CTESTOLDROOM1', createdAt: iso(600_000) });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('slack:CTESTNEWROOM2');
    expect(threads[0]!.channel_name).toBe('#example-new-room');
  });

  it('tie-break across sessions: a thread with two anchored sessions resolves to the more recent one', async () => {
    // §3.1: nothing in the schema stops two agent groups sharing a series id,
    // so a task "thread" can in principle carry more than one session even
    // though today's live data never does. The rule has to be "most recent
    // anchor across the whole thread", not "the first session's anchor" —
    // this is the test that pins it against silently reading row order.
    seedAgentGroup('ag-a');
    seedAgentGroup('ag-b');
    insertMessagingGroup({ id: 'mg-a', platformId: 'slack:CTESTROOMA1', name: '#example-room-a' });
    insertMessagingGroup({ id: 'mg-b', platformId: 'slack:CTESTROOMB2', name: '#example-room-b' });
    const thread = 'system:tasks:shared-series-0003';
    insertSession({ id: 's-a', agentGroupId: 'ag-a', threadId: thread });
    insertSession({ id: 's-b', agentGroupId: 'ag-b', threadId: thread });
    insertTaskAnchor({ sessionId: 's-a', platformId: 'slack:CTESTROOMA1', createdAt: iso(600_000) });
    insertTaskAnchor({ sessionId: 's-b', platformId: 'slack:CTESTROOMB2', createdAt: iso(60_000) });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(1); // one thread, two sessions (§3.1)
    expect(threads[0]!.channel_key).toBe('slack:CTESTROOMB2');
    expect(threads[0]!.channel_name).toBe('#example-room-b');
  });

  it('an anchor for a DIFFERENT session never leaks onto an unrelated task thread', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    insertMessagingGroup({ id: 'mg-1', platformId: 'slack:CTESTROOMX1', name: '#example-room-x' });
    insertSession({ id: 's-anchored', agentGroupId: 'ag-1', threadId: 'system:tasks:series-anchored' });
    insertSession({ id: 's-bare', agentGroupId: 'ag-2', threadId: 'system:tasks:series-bare' });
    insertTaskAnchor({ sessionId: 's-anchored', platformId: 'slack:CTESTROOMX1', createdAt: iso(60_000) });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    const byThread = new Map(threads.map((t) => [t.thread_id, t]));
    expect(byThread.get('system:tasks:series-anchored')!.channel_key).toBe('slack:CTESTROOMX1');
    expect(byThread.get('system:tasks:series-bare')!.channel_key).toBe('system:tasks');
    expect(byThread.get('system:tasks:series-bare')!.channel_name).toBe('Unrouted tasks');
  });
});

// ── Migration 056: the routing stamp, and why it LOSES to an anchor ──────────

describe('buildThreadList — scheduled tasks fall back to their routing stamp (migration 056)', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('a task session with no anchor but a routing stamp resolves to the stamped channel', async () => {
    // The 53% of task sessions the anchor table can never cover: the series is
    // routed to a real channel but has not posted there yet (or posts through a
    // path that leaves no anchor). Its destination IS knowable at definition
    // time, so "Unrouted tasks" was a lie, not an absence.
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-1', platformId: 'slack:CTESTSWEEP001', name: '#example-sweep' });
    insertSession({
      id: 's-task',
      agentGroupId: 'ag-1',
      threadId: 'system:tasks:example-task-0010',
      taskRoutingPlatformId: 'slack:CTESTSWEEP001',
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('slack:CTESTSWEEP001');
    expect(threads[0]!.channel_name).toBe('#example-sweep');
    // Still a scheduled run — the pill is orthogonal to which branch resolved
    // the channel.
    expect(threads[0]!.scheduled_task).toBe(true);
  });

  it('PRECEDENCE: an anchor pointing at X beats a routing stamp saying Y', async () => {
    // The case the precedence exists for, and the reason it must not be
    // "simplified" into a single lookup. The stamp is only where an
    // UNADDRESSED reply lands by default; `ncl tasks`' own contract is that
    // the agent chooses its destination at fire time. A series re-pointed
    // between runs still carries its original stamp while its anchors have
    // already moved — the console must show where it is actually posting.
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-x', platformId: 'slack:CTESTACTUAL01', name: '#example-actual' });
    insertMessagingGroup({ id: 'mg-y', platformId: 'slack:CTESTSTAMPED2', name: '#example-stamped' });
    insertSession({
      id: 's-task',
      agentGroupId: 'ag-1',
      threadId: 'system:tasks:example-task-0011',
      taskRoutingPlatformId: 'slack:CTESTSTAMPED2',
    });
    insertTaskAnchor({ sessionId: 's-task', platformId: 'slack:CTESTACTUAL01', createdAt: iso(60_000) });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('slack:CTESTACTUAL01');
    expect(threads[0]!.channel_name).toBe('#example-actual');
  });

  it('a task session with NEITHER an anchor nor a stamp still lands in the labeled fallback', async () => {
    // No channel is invented. An `--isolated` series, or one scheduled by a
    // host caller with no --messaging-group, genuinely has no destination.
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-1', platformId: 'slack:CTESTCHAN01', name: '#example-chan' });
    insertSession({ id: 's-task', agentGroupId: 'ag-1', threadId: 'system:tasks:example-task-0012' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('system:tasks');
    expect(threads[0]!.channel_name).toBe('Unrouted tasks');
    expect(threads[0]!.scheduled_task).toBe(true);
  });

  it("a stamp never leaks onto another task thread, and doesn't touch ordinary channel threads", async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    insertMessagingGroup({ id: 'mg-1', platformId: 'slack:CTESTSTAMP001', name: '#example-stamp' });
    insertSession({
      id: 's-stamped',
      agentGroupId: 'ag-1',
      threadId: 'system:tasks:series-stamped',
      taskRoutingPlatformId: 'slack:CTESTSTAMP001',
    });
    insertSession({ id: 's-bare', agentGroupId: 'ag-2', threadId: 'system:tasks:series-bare' });
    insertSession({ id: 's-chat', agentGroupId: 'ag-1', threadId: 'slack:CTESTCHAN01:1.1' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    const byThread = new Map(threads.map((t) => [t.thread_id, t]));
    expect(byThread.get('system:tasks:series-stamped')!.channel_key).toBe('slack:CTESTSTAMP001');
    expect(byThread.get('system:tasks:series-bare')!.channel_key).toBe('system:tasks');
    expect(byThread.get('slack:CTESTCHAN01:1.1')!.channel_key).toBe('slack:CTESTCHAN01');
    expect(byThread.get('slack:CTESTCHAN01:1.1')!.scheduled_task).toBe(false);
  });

  it('tie-break across sessions: the most recently created stamped session wins', async () => {
    // §3.1 allows two agent groups to share a series id. Same "most recent
    // wins" rule as the anchors, keyed on session created_at because the stamp
    // itself carries no timestamp — pinned so it never silently becomes
    // "whichever row the query returned first".
    seedAgentGroup('ag-a');
    seedAgentGroup('ag-b');
    insertMessagingGroup({ id: 'mg-a', platformId: 'slack:CTESTOLDSTMP1', name: '#example-old-stamp' });
    insertMessagingGroup({ id: 'mg-b', platformId: 'slack:CTESTNEWSTMP2', name: '#example-new-stamp' });
    const thread = 'system:tasks:shared-series-0013';
    insertSession({
      id: 's-a',
      agentGroupId: 'ag-a',
      threadId: thread,
      taskRoutingPlatformId: 'slack:CTESTOLDSTMP1',
      createdAt: iso(7_200_000),
    });
    insertSession({
      id: 's-b',
      agentGroupId: 'ag-b',
      threadId: thread,
      taskRoutingPlatformId: 'slack:CTESTNEWSTMP2',
      createdAt: iso(600_000),
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.channel_key).toBe('slack:CTESTNEWSTMP2');
    expect(threads[0]!.channel_name).toBe('#example-new-stamp');
  });
});

// ── DEFECT 2 (operator report, 2026-08-20): one human, two DM channels ───────

describe('buildThreadList — DM dedupe by stable platform user id (DEFECT 2)', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  /** Mirrors the live shape: `user_dms.user_id` / `users.id` are instance-scoped
   *  (`<channel_type>:<raw id>`), one row per sibling bot, but the RAW id after
   *  the prefix is the same human on every sibling sharing the platform. */
  function seedDm(opts: {
    messagingGroupId: string;
    channelType: string;
    rawUserId: string;
    displayName: string;
  }): void {
    const userId = `${opts.channelType}:${opts.rawUserId}`;
    getDb()
      .prepare(`INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`)
      .run(userId, opts.displayName, iso(0));
    getDb()
      .prepare(`INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`)
      .run(userId, opts.channelType, opts.messagingGroupId, iso(0));
  }

  it('collapses two sibling-bot DM rooms for the same human into one channel_key, with both threads addressable through it', async () => {
    seedAgentGroup('ag-bot-a');
    seedAgentGroup('ag-bot-b');
    // Real shape (verified live): `platform_id` carries the bare platform
    // family ('slack', 'discord') — each bot instance gets its OWN DM
    // conversation id from the platform, so the id differs per sibling even
    // though the family segment does not. `channel_type` is what actually
    // varies per sibling instance ('slack-example' vs 'slack-example-codex'
    // live); baking the instance into `platform_id` itself (an earlier draft
    // of this test did that) is not a shape real data ever takes.
    insertMessagingGroup({
      id: 'mg-dm-a',
      platformId: 'slack:D0001',
      name: 'Example Human',
      channelType: 'slack-bota',
    });
    insertMessagingGroup({
      id: 'mg-dm-b',
      platformId: 'slack:D0002',
      name: 'Example Human',
      channelType: 'slack-botb',
    });
    seedDm({
      messagingGroupId: 'mg-dm-a',
      channelType: 'slack-bota',
      rawUserId: 'U999',
      displayName: 'Example Human',
    });
    seedDm({
      messagingGroupId: 'mg-dm-b',
      channelType: 'slack-botb',
      rawUserId: 'U999',
      displayName: 'Example Human',
    });
    insertSession({
      id: 's-dm-a',
      agentGroupId: 'ag-bot-a',
      threadId: 'slack:D0001:1700000001.11',
      messagingGroupId: 'mg-dm-a',
    });
    insertSession({
      id: 's-dm-b',
      agentGroupId: 'ag-bot-b',
      threadId: 'slack:D0002:1700000002.22',
      messagingGroupId: 'mg-dm-b',
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads).toHaveLength(2); // still two distinct THREADS — only the channel identity merges.

    const [a, b] = threads;
    // The load-bearing assertion: against the prior behavior these are
    // `slack:D0001` and `slack:D0002` — two different keys — which is exactly
    // the "same human listed twice" defect. A dedupe MUST make them equal.
    expect(a!.channel_key).toBe(b!.channel_key);
    expect(a!.channel_key).not.toBe('slack:D0001');
    expect(a!.channel_key).not.toBe('slack:D0002');
    expect(a!.channel_name).toBe('Example Human');
    expect(b!.channel_name).toBe('Example Human');

    // This is the whole mechanism the sidebar (ThreadConsole.tsx) relies on: it
    // groups strictly by `channel_key`, so an equal key is what makes "both
    // threads show when the merged entry is selected" and "counts sum" true
    // without that file needing to know anything about DMs or siblings.
    const sameKey = threads.filter((t) => t.channel_key === a!.channel_key);
    expect(sameKey).toHaveLength(2);
    expect(new Set(sameKey.map((t) => t.thread_id))).toEqual(
      new Set(['slack:D0001:1700000001.11', 'slack:D0002:1700000002.22']),
    );
  });

  it('does NOT dedupe two real, unrelated channels that happen to share a display name', async () => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    // Two ordinary group channels, same name, no user_dms row for either —
    // there is nothing DM-shaped here at all.
    insertMessagingGroup({ id: 'mg-a', platformId: 'slack:CTESTROOMA1', name: '#general' });
    insertMessagingGroup({ id: 'mg-b', platformId: 'slack:CTESTROOMB2', name: '#general' });
    insertSession({ id: 's-a', agentGroupId: 'ag-1', threadId: 'slack:CTESTROOMA1:1.1', messagingGroupId: 'mg-a' });
    insertSession({ id: 's-b', agentGroupId: 'ag-2', threadId: 'slack:CTESTROOMB2:2.2', messagingGroupId: 'mg-b' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    const byThread = new Map(threads.map((t) => [t.thread_id, t]));
    expect(byThread.get('slack:CTESTROOMA1:1.1')!.channel_key).toBe('slack:CTESTROOMA1');
    expect(byThread.get('slack:CTESTROOMB2:2.2')!.channel_key).toBe('slack:CTESTROOMB2');
  });

  it('leaves a DM room untouched when it has no user_dms row (documented gap, not a silent merge)', async () => {
    seedAgentGroup('ag-1');
    insertMessagingGroup({ id: 'mg-lonely', platformId: 'slack:D9999', name: 'Some Human', channelType: 'slack-bota' });
    insertSession({
      id: 's-lonely',
      agentGroupId: 'ag-1',
      threadId: 'slack:D9999:1.1',
      messagingGroupId: 'mg-lonely',
    });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.channel_key).toBe('slack:D9999');
    expect(threads[0]!.channel_name).toBe('Some Human');
  });
});

// ── The workgroup axis ───────────────────────────────────────────────────────

/**
 * The console filters by WORKGROUP, not agent group. `example-labs` is six sibling
 * agent groups sharing one workgroup and most threads are multi-agent, so an
 * agent-group filter made the operator pick one sibling and hid the rest of the
 * thread's participants.
 *
 * The rule that has to hold under test is that the workgroup only ever
 * SUBTRACTS: it is resolved against `agent_groups.workgroup_id` and intersected
 * with `ctx.scopes.allowed_group_ids`, which is agent-group scoped and stays the
 * ceiling. There is no workgroup permission concept.
 */
describe('buildThreadList — workgroup axis', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
    seedWorkgroup('example-labs');
    seedWorkgroup('example-dev');
    seedAgentGroup('ag-lab-1', 'example-labs');
    seedAgentGroup('ag-lab-2', 'example-labs');
    seedAgentGroup('ag-lab-3', 'example-labs');
    seedAgentGroup('ag-dev-1', 'example-dev');
    // An unassigned group — `workgroup_id` is nullable and a NULL must never
    // match a named workgroup.
    seedAgentGroup('ag-orphan');
  });

  it('resolves a workgroup to EVERY sibling in it', async () => {
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-b', agentGroupId: 'ag-lab-2', threadId: 'slack:CTESTCHAN01:2.2' });
    insertSession({ id: 's-c', agentGroupId: 'ag-lab-3', threadId: 'slack:CTESTCHAN01:3.3' });
    insertSession({ id: 's-d', agentGroupId: 'ag-dev-1', threadId: 'slack:CTESTCHAN01:4.4' });
    insertSession({ id: 's-e', agentGroupId: 'ag-orphan', threadId: 'slack:CTESTCHAN01:5.5' });

    const { threads } = await buildThreadList(makeCtx(), { ...LIST_OPTS, workgroupId: 'example-labs' }, deps());
    expect(threads.flatMap((t) => t.session_ids).sort()).toEqual(['s-a', 's-b', 's-c']);
  });

  it('keeps a multi-sibling thread whole — one row, every participant', async () => {
    const thread = 'slack:CTESTCHAN01:9.9';
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: thread });
    insertSession({ id: 's-b', agentGroupId: 'ag-lab-2', threadId: thread });
    insertSession({ id: 's-c', agentGroupId: 'ag-lab-3', threadId: thread });

    const { threads } = await buildThreadList(makeCtx(), { ...LIST_OPTS, workgroupId: 'example-labs' }, deps());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.participants.map((p) => p.agent_group_id).sort()).toEqual(['ag-lab-1', 'ag-lab-2', 'ag-lab-3']);
  });

  it('lets group_id NARROW within the workgroup, never widen out of it', async () => {
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-b', agentGroupId: 'ag-lab-2', threadId: 'slack:CTESTCHAN01:2.2' });
    insertSession({ id: 's-d', agentGroupId: 'ag-dev-1', threadId: 'slack:CTESTCHAN01:4.4' });

    const narrowed = await buildThreadList(
      makeCtx(),
      { ...LIST_OPTS, workgroupId: 'example-labs', groupId: 'ag-lab-2' },
      deps(),
    );
    expect(narrowed.threads.flatMap((t) => t.session_ids)).toEqual(['s-b']);

    // A group_id from ANOTHER workgroup is an empty intersection, not an escape.
    const crossed = await buildThreadList(
      makeCtx(),
      { ...LIST_OPTS, workgroupId: 'example-labs', groupId: 'ag-dev-1' },
      deps(),
    );
    expect(crossed.threads).toEqual([]);
  });

  it('shows a scoped caller ONLY the siblings they are already allowed', async () => {
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-b', agentGroupId: 'ag-lab-2', threadId: 'slack:CTESTCHAN01:2.2' });
    insertSession({ id: 's-c', agentGroupId: 'ag-lab-3', threadId: 'slack:CTESTCHAN01:3.3' });

    // Allowed two of the three siblings. Selecting the workgroup must not
    // become a back door to the third.
    const scoped = makeCtx({ no_filter: false, allowed_group_ids: ['ag-lab-1', 'ag-lab-2'] });
    const { threads } = await buildThreadList(scoped, { ...LIST_OPTS, workgroupId: 'example-labs' }, deps());
    expect(threads.flatMap((t) => t.session_ids).sort()).toEqual(['s-a', 's-b']);
  });

  it('shows a scoped caller only their own sibling of a SHARED thread', async () => {
    const thread = 'slack:CTESTCHAN01:9.9';
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: thread });
    insertSession({ id: 's-c', agentGroupId: 'ag-lab-3', threadId: thread });

    const scoped = makeCtx({ no_filter: false, allowed_group_ids: ['ag-lab-1'] });
    const { threads } = await buildThreadList(scoped, { ...LIST_OPTS, workgroupId: 'example-labs' }, deps());
    expect(threads).toHaveLength(1);
    expect(threads[0]!.participants.map((p) => p.agent_group_id)).toEqual(['ag-lab-1']);
  });

  it('yields zero rows for a workgroup the caller is allowed nothing in — never a 403', async () => {
    insertSession({ id: 's-d', agentGroupId: 'ag-dev-1', threadId: 'slack:CTESTCHAN01:4.4' });

    const scoped = makeCtx({ no_filter: false, allowed_group_ids: ['ag-lab-1'] });
    const { threads } = await buildThreadList(scoped, { ...LIST_OPTS, workgroupId: 'example-dev' }, deps());
    expect(threads).toEqual([]);
  });

  it('yields zero rows for an unknown workgroup rather than falling open', async () => {
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: 'slack:CTESTCHAN01:1.1' });
    const { threads } = await buildThreadList(makeCtx(), { ...LIST_OPTS, workgroupId: 'no-such-wg' }, deps());
    expect(threads).toEqual([]);
  });

  it('lists every workgroup when none is named', async () => {
    insertSession({ id: 's-a', agentGroupId: 'ag-lab-1', threadId: 'slack:CTESTCHAN01:1.1' });
    insertSession({ id: 's-d', agentGroupId: 'ag-dev-1', threadId: 'slack:CTESTCHAN01:4.4' });
    insertSession({ id: 's-e', agentGroupId: 'ag-orphan', threadId: 'slack:CTESTCHAN01:5.5' });

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads.flatMap((t) => t.session_ids).sort()).toEqual(['s-a', 's-d', 's-e']);
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
    for (const state of ['parked', 'idle', 'unassigned'] as const) {
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
      .prepare(`INSERT INTO thread_snoozes (thread_id, user_id, snoozed_at_activity, created_at) VALUES (?, ?, ?, ?)`)
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

// ── The assign selector's data (one primitive: send to a chosen agent) ───────

/**
 * The console's action model has ONE primitive — send a message to a chosen
 * agent — and the only difference between steering and assigning is whether the
 * chosen agent is already on the thread. That makes "which other agents could
 * hold this thread" part of the row, not a second fetch, and these tests bind
 * the two ways it lies: including agents already here (so the selector shows
 * them twice), and including agents wired to a DIFFERENT room.
 */
describe('assignable_agents', () => {
  function wire(mgId: string, platformId: string, agentGroupId: string): void {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
         VALUES (?, 'slack-testworkspace', 'testworkspace', ?, '#example-eng', ?)`,
      )
      .run(mgId, platformId, iso(0));
    getDb()
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
         VALUES (?, ?, ?, 'per-thread', ?)`,
      )
      .run(`mga-${mgId}-${agentGroupId}`, mgId, agentGroupId, iso(0));
  }

  beforeEach(() => {
    setupDb();
    for (const id of ['ag-here', 'ag-wired', 'ag-otherroom']) seedAgentGroup(id);
    wire('mg-1', 'slack:CTESTCHAN01', 'ag-here');
    wire('mg-1', 'slack:CTESTCHAN01', 'ag-wired');
    wire('mg-2', 'slack:COTHERCHAN2', 'ag-otherroom');
    insertSession({
      id: 's-here',
      agentGroupId: 'ag-here',
      threadId: 'slack:CTESTCHAN01:1700000000.11',
      messagingGroupId: 'mg-1',
    });
  });

  it('lists wired agents that are NOT already on the thread, and nobody from another room', async () => {
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.participants.map((p) => p.agent_group_id)).toEqual(['ag-here']);
    expect(threads[0]!.assignable_agents).toEqual([{ agent_group_id: 'ag-wired', name: 'persona:ag-wired' }]);
  });

  it('honours the §2a scope filter — an agent out of scope is not offered', async () => {
    const { threads } = await buildThreadList(
      makeCtx({ no_filter: false, allowed_group_ids: ['ag-here'] }),
      LIST_OPTS,
      deps(),
    );
    expect(threads[0]!.assignable_agents).toEqual([]);
  });

  it('is empty for a thread whose channel nothing names — there is no room to assign into', async () => {
    insertSession({ id: 's-orphan', agentGroupId: 'ag-here', threadId: null });
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    const synthetic = threads.find((t) => t.synthetic)!;
    expect(synthetic.channel_key).toBe(UNKNOWN_CHANNEL_KEY);
    expect(synthetic.assignable_agents).toEqual([]);
  });
});

// ── Close proposal + close state on the wire ─────────────────────────────────

describe('pickDoneProposal', () => {
  const row = (over: Record<string, unknown>) =>
    ({ id: 's1', agent_group_id: 'ag1', done_proposal: null, ...over }) as never;

  it('is null when no session carries one — there is no default', () => {
    expect(pickDoneProposal([row({}), row({ id: 's2' })])).toBeNull();
  });

  it('reads only the mirrored column, and the freshest statement wins', () => {
    const picked = pickDoneProposal([
      row({ id: 's-old', done_proposal: JSON.stringify({ reason: 'older', proposed_at: iso(600_000) }) }),
      row({
        id: 's-new',
        agent_group_id: 'ag2',
        done_proposal: JSON.stringify({ reason: 'newer', proposed_at: iso(60_000) }),
      }),
    ]);
    expect(picked).toEqual({
      reason: 'newer',
      proposed_at: new Date(NOW - 60_000).toISOString(),
      agent_group_id: 'ag2',
      session_id: 's-new',
    });
  });

  it('treats malformed, empty and undated records as absent rather than as a proposal', () => {
    expect(pickDoneProposal([row({ done_proposal: 'not json' })])).toBeNull();
    expect(
      pickDoneProposal([row({ done_proposal: JSON.stringify({ reason: '  ', proposed_at: iso(0) }) })]),
    ).toBeNull();
    expect(pickDoneProposal([row({ done_proposal: JSON.stringify({ reason: 'ok' }) })])).toBeNull();
    expect(pickDoneProposal([row({ done_proposal: JSON.stringify({ proposed_at: iso(0) }) })])).toBeNull();
  });
});

describe('needs_you_reason on the wire (operator report 2026-08-21)', () => {
  beforeEach(() => {
    closeDb();
    setupDb();
  });

  it('is absent for a thread that is not needs_you', async () => {
    seedAgentGroup('ag-plain');
    insertSession({ id: 's-plain', agentGroupId: 'ag-plain', threadId: 'slack:CTESTCHAN01:1.1' });
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.state).not.toBe('needs_you');
    expect(threads[0]!.needs_you_reason).toBeNull();
  });

  it('an ask_question thread carries the ask_question cause on the wire', async () => {
    seedAgentGroup('ag-ask');
    const thread = 'slack:CTESTCHAN01:1.2';
    insertSession({
      id: 's-asked',
      agentGroupId: 'ag-ask',
      threadId: thread,
      lastOutboundAt: iso(600_000),
      lastActive: iso(600_000),
    });
    // Same "unanswered ask_question" setup as the reply-target test above: the
    // outbound is newer than the last inbound.
    getDb()
      .prepare(`UPDATE sessions SET last_outbound_kind = 'chat-sdk:ask_question', last_active = ? WHERE id = ?`)
      .run(iso(900_000), 's-asked');

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.state).toBe('needs_you');
    expect(threads[0]!.needs_you_reason).toEqual({
      cause: 'ask_question',
      text: 'The agent asked a question and is waiting for a reply.',
    });
  });

  it('a task-needs-input thread carries its own steer_question on the wire', async () => {
    seedAgentGroup('ag-task');
    const thread = 'slack:CTESTCHAN01:1.3';
    insertSession({ id: 's-task', agentGroupId: 'ag-task', threadId: thread });
    getDb()
      .prepare(
        `INSERT INTO tasks
           (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
            child_session_id, status, task_content, request_hash, admitted_at, needs_input, steer_question, created_at)
         VALUES ('task-1', 'k1', 's-task', 'ag-task', 's-task', 'running', 'content', 'hash1', ?, 1, ?, ?)`,
      )
      .run(iso(0), 'Repo path A or B?', iso(0));

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps());
    expect(threads[0]!.state).toBe('needs_you');
    expect(threads[0]!.needs_you_reason).toEqual({ cause: 'task_needs_input', text: 'Repo path A or B?' });
  });

  it('a parked "waiting on" claim carries its note on the wire, from a real claim file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-claims-'));
    try {
      seedWorkgroup('wg-1');
      seedAgentGroup('ag-parked', 'wg-1');
      const thread = 'slack:CTESTCHAN01:1787277743.529519';
      insertSession({ id: 's-parked', agentGroupId: 'ag-parked', threadId: thread });
      const claimsDir = path.join(dir, 'wg-1', 'claims');
      fs.mkdirSync(claimsDir, { recursive: true });
      const note =
        'waiting on the release owner or backup reviewer: PR #956 mechanically ready at 64c1cca1 but the consequence lane has no recorded human ship';
      fs.writeFileSync(
        path.join(claimsDir, 'gh-963.json'),
        JSON.stringify({ owner: 'ollie', status: 'parked', parked_at: iso(0), note, thread_id: thread }),
      );

      const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps({ claimsRoot: dir }));
      expect(threads[0]!.state).toBe('needs_you');
      // `parked_at` is NOW, so the measured age is 0 — which renders as
      // "unmeasured", never "parked just now" (§12).
      expect(threads[0]!.needs_you_reason).toEqual({ cause: 'parked_note', text: note, parked_ms: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('close state on the thread payload', () => {
  beforeEach(() => {
    setupDb();
    seedAgentGroup('ag-close');
  });

  const listOne = async () => (await buildThreadList(makeCtx(), LIST_OPTS, deps())).threads[0]!;

  it('defaults to no proposal and TWO required confirmations', async () => {
    insertSession({ id: 's-plain', agentGroupId: 'ag-close', threadId: 'slack:C1:1.1' });
    const t = await listOne();
    expect(t.done_proposal).toBeNull();
    expect(t.closing).toBe(false);
    // Overriding an agent that still believes it has work costs two clicks.
    expect(t.close_confirmations_required).toBe(2);
  });

  it('an actual agent proposal surfaces with its reason and drops the count to ONE', async () => {
    insertSession({ id: 's-prop', agentGroupId: 'ag-close', threadId: 'slack:C1:1.2' });
    getDb()
      .prepare('UPDATE sessions SET done_proposal = ? WHERE id = ?')
      .run(JSON.stringify({ reason: 'shipped; suite green', proposed_at: iso(30_000) }), 's-prop');
    const t = await listOne();
    expect(t.done_proposal).toMatchObject({ reason: 'shipped; suite green', session_id: 's-prop' });
    expect(t.close_confirmations_required).toBe(1);
  });

  it('proposing does not move the thread out of running — it is a flag, not a state', async () => {
    insertSession({ id: 's-live', agentGroupId: 'ag-close', threadId: 'slack:C1:1.3' });
    getDb()
      .prepare('UPDATE sessions SET done_proposal = ? WHERE id = ?')
      .run(JSON.stringify({ reason: 'think I am done', proposed_at: iso(30_000) }), 's-live');
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, deps({ containerStatus: () => 'running' }));
    // The whole point of not minting a `proposes_closing` state: live work
    // keeps reading as live.
    expect(threads[0]!.state).toBe('running');
    expect(threads[0]!.done_proposal).not.toBeNull();
  });

  it('an in-flight close sets `closing`; a finished one does not', async () => {
    insertSession({ id: 's-closing', agentGroupId: 'ag-close', threadId: 'slack:C1:1.4' });
    const insert = (state: string) =>
      getDb()
        .prepare(
          `INSERT INTO thread_closures (thread_id, requested_by, requested_at, reason, agent_proposed, session_ids, state)
           VALUES ('slack:C1:1.4', 'u1', ?, NULL, 0, '["s-closing"]', ?)
           ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state`,
        )
        .run(iso(60_000), state);

    insert('awaiting_confirmation');
    expect((await listOne()).closing).toBe(true);
    insert('finalizing');
    expect((await listOne()).closing).toBe(true);
    insert('closed');
    expect((await listOne()).closing).toBe(false);
  });
});

// ── §2/§5 `unassigned`: ownerless items from a workgroup attention source ────

describe('attention-source rows in the thread list', () => {
  const WG = 'wg-example';
  const CHANNEL_KEY = 'slack:CEXAMPLE001';
  const tmpdirs: string[] = [];

  function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpdirs.push(dir);
    return dir;
  }

  /** A groups root holding one release board for {@link WG}. */
  function boardRoot(items: unknown[], asOf = '2026-08-20T11:30:00.000Z'): string {
    const root = tmp('threads-board-');
    const dir = path.join(root, WG, 'releases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'release-state.json'), JSON.stringify({ asOf, items }));
    return root;
  }

  function readyPr(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'EXAMPLE-APP#817',
      kind: 'pr',
      nextMover: 'human',
      owner: 'alice',
      why: 'CI green, mergeable CLEAN',
      since: iso(3_600_000),
      url: 'https://github.com/example-org/example-app/pull/817',
      title: "What's new digest",
      nextAction: '@releasebot ship 817',
      ...over,
    };
  }

  function declare(value: string | null): void {
    getDb().prepare(`UPDATE workgroups SET attention_sources = ? WHERE id = ?`).run(value, WG);
  }

  function attentionDeps(groupsRoot: string, over: Partial<ThreadListDeps> = {}): ThreadListDeps {
    return deps({ attentionEnv: { groupsRoot, claimsRoot: tmp('threads-attn-claims-') }, ...over });
  }

  beforeEach(() => {
    setupDb();
    seedWorkgroup(WG);
    seedAgentGroup('ag-example', WG);
  });

  afterEach(() => {
    while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
  });

  it('a declared source emits an ownerless row with a real channel key, and no sessions', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    getDb()
      .prepare(
        `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('mg-example', 'slack-testworkspace', 'testworkspace', CHANNEL_KEY, '#example-room', iso(0));

    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads).toHaveLength(1);
    const row = threads[0]!;
    expect(row.thread_id).toBe(`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`);
    expect(row.channel_key).toBe(CHANNEL_KEY);
    expect(row.channel_name).toBe('#example-room');
    expect(row.participants).toEqual([]);
    expect(row.session_ids).toEqual([]);
    expect(row.attention_source).toEqual({
      kind: 'release-board',
      as_of: '2026-08-20T11:30:00.000Z',
      url: 'https://github.com/example-org/example-app/pull/817',
      next_action: '@releasebot ship 817',
    });
  });

  it('emits nothing when the workgroup declares nothing', async () => {
    declare(null);
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads).toEqual([]);
  });

  it('emits nothing when the declaration is malformed — never a partial list', async () => {
    declare('[{"kind":"release-board","root":"releases"}]');
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads).toEqual([]);
  });

  it('ignores an unknown kind rather than throwing, and still emits the known source', async () => {
    declare(
      JSON.stringify([
        { kind: 'from-a-newer-trunk', root: 'findings', channel_key: CHANNEL_KEY },
        { kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY },
      ]),
    );
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads.map((t) => t.thread_id)).toEqual([`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`]);
  });

  it('a parked waiting-on item reaches needs_you, with the reason and the next action', async () => {
    // §5: the two `needs_you` checks precede the `sessionCount === 0` guard, so
    // an ownerless item whose note names a human lands `needs_you` — "a human
    // owes an answer" — not `unassigned` — "nobody has picked this up".
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads[0]!.state).toBe('needs_you');
    expect(threads[0]!.needs_you_reason).toEqual({
      cause: 'parked_note',
      text: 'waiting on alice: CI green, mergeable CLEAN — next: @releasebot ship 817',
      // No claim FILE behind a board item, so there is no `parked_at` to
      // measure. Null, never zero (§12).
      parked_ms: null,
    });
  });

  it('an ownerless item with no waiting-on note reaches unassigned, not needs_you', async () => {
    // The other half of the same branch. `deriveThreadState` is the ONE
    // function that decides, and nothing in the attention path sets `state`.
    expect(
      deriveThreadState({
        sessionCount: 0,
        claimState: null,
        claimNote: '',
        needsOperator: false,
        containerStatus: 'unknown',
        providerStatus: null,
        toolStartedAtMs: null,
        lastOutputAtMs: null,
        now: NOW,
      }),
    ).toBe('unassigned');
    // …and a parked claim whose note names nobody is likewise not `needs_you`.
    expect(
      deriveThreadState({
        sessionCount: 0,
        claimState: 'parked',
        claimNote: 'mechanically ready',
        needsOperator: false,
        containerStatus: 'unknown',
        providerStatus: null,
        toolStartedAtMs: null,
        lastOutputAtMs: null,
        now: NOW,
      }),
    ).toBe('unassigned');
  });

  it('the item id never becomes a channel key', async () => {
    // `threadChannelKey` would read `board:EXAMPLE-APP#817` as platform `board`
    // + channel `EXAMPLE-APP#817` and mint one fake sidebar bucket PER ITEM.
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads[0]!.channel_key).toBe(CHANNEL_KEY);
    expect(threads[0]!.channel_key).not.toContain(ATTENTION_ITEM_PREFIX);
    // …and the parser itself refuses the id, so no future caller can
    // reintroduce the bug by passing one in.
    expect(threadChannelKey(`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`)).toBe(UNKNOWN_CHANNEL_KEY);
  });

  it('merges into the ONE queue, ordered by activity alongside session rows', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    insertSession({
      id: 's-live',
      agentGroupId: 'ag-example',
      threadId: 'slack:CTESTCHAN01:1.1',
      lastOutboundAt: iso(60_000), // fresher than the board item's 1h-old `since`
    });
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(boardRoot([readyPr()])));
    expect(threads.map((t) => t.thread_id)).toEqual([
      'slack:CTESTCHAN01:1.1',
      `${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`,
    ]);
  });

  it('a group_id filter yields no attention rows — an ownerless item is on no agent', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const { threads } = await buildThreadList(
      makeCtx(),
      { ...LIST_OPTS, groupId: 'ag-example' },
      attentionDeps(boardRoot([readyPr()])),
    );
    expect(threads).toEqual([]);
  });

  it('a workgroup filter narrows, and an unknown workgroup yields zero rows rather than a 403 (§2a)', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const claimsRoot = tmp('threads-attn-claims-');
    const env = { groupsRoot, claimsRoot };
    expect(
      (await buildThreadList(makeCtx(), { ...LIST_OPTS, workgroupId: WG }, deps({ attentionEnv: env }))).threads,
    ).toHaveLength(1);
    expect(
      (await buildThreadList(makeCtx(), { ...LIST_OPTS, workgroupId: 'wg-nope' }, deps({ attentionEnv: env }))).threads,
    ).toEqual([]);
  });

  it('a scoped caller sees an item only through a workgroup one of its own agent groups is in', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const env = { groupsRoot, claimsRoot: tmp('threads-attn-claims-') };
    seedAgentGroup('ag-elsewhere');
    expect(
      (
        await buildThreadList(
          makeCtx({ no_filter: false, allowed_group_ids: ['ag-example'] }),
          LIST_OPTS,
          deps({ attentionEnv: env }),
        )
      ).threads,
    ).toHaveLength(1);
    expect(
      (
        await buildThreadList(
          makeCtx({ no_filter: false, allowed_group_ids: ['ag-elsewhere'] }),
          LIST_OPTS,
          deps({ attentionEnv: env }),
        )
      ).threads,
    ).toEqual([]);
  });

  it('a caller scoped to ONE sibling sees the whole workgroup’s items — deliberate', async () => {
    // Every other row on this endpoint gates at AGENT-GROUP level
    // (`s.agent_group_id IN allowed_group_ids`). Attention items gate at
    // WORKGROUP level, and that is the decision, not an oversight: the
    // workgroup is the documented data-pool boundary (docs/workgroups.md —
    // chat archive, shared files and Graphify retrieval all pool there), and
    // an attention item is ownerless by construction, so it carries no agent
    // group to test against. DESIGN.md §10 states the rule.
    //
    // The pre-existing test above proves CROSS-workgroup isolation, which is a
    // different and weaker claim: it passes whether the gate is per-workgroup
    // or per-agent-group. This one is the discriminating case, so a future
    // narrowing to agent-group granularity has to break a test that says out
    // loud it was chosen.
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const env = { groupsRoot: boardRoot([readyPr()]), claimsRoot: tmp('threads-attn-claims-') };
    seedAgentGroup('ag-sibling', WG); // a SECOND agent group in the SAME workgroup

    const { threads } = await buildThreadList(
      makeCtx({ no_filter: false, allowed_group_ids: ['ag-sibling'] }),
      LIST_OPTS,
      deps({ attentionEnv: env }),
    );
    // Entitled to `ag-sibling` only, yet the workgroup's item is visible —
    // and nothing about the item names `ag-sibling` or `ag-example`.
    expect(threads.map((t) => t.thread_id)).toEqual([`${ATTENTION_ITEM_PREFIX}EXAMPLE-APP#817`]);
  });

  it('marks staleness, never hides it: an ancient board still emits its rows', async () => {
    // No suppression threshold exists anywhere in this path, deliberately. An
    // empty feed is indistinguishable from a healthy one, and "nothing is
    // blocked on a human" is the one lie the feed exists to prevent.
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()], '2026-01-01T00:00:00.000Z');
    const { threads } = await buildThreadList(makeCtx(), LIST_OPTS, attentionDeps(groupsRoot));
    expect(threads).toHaveLength(1);
    expect(threads[0]!.attention_source!.as_of).toBe('2026-01-01T00:00:00.000Z');
  });

  it('memoizes the reader inside the TTL and re-reads after it', async () => {
    declare(JSON.stringify([{ kind: 'release-board', root: 'releases', channel_key: CHANNEL_KEY }]));
    const groupsRoot = boardRoot([readyPr()]);
    const env = { groupsRoot, claimsRoot: tmp('threads-attn-claims-') };
    expect((await buildThreadList(makeCtx(), LIST_OPTS, deps({ attentionEnv: env }))).threads).toHaveLength(1);

    // Delete the board: only the memo can still answer.
    fs.rmSync(path.join(groupsRoot, WG, 'releases'), { recursive: true, force: true });
    expect(
      (await buildThreadList(makeCtx(), LIST_OPTS, deps({ now: NOW + ATTENTION_MEMO_TTL_MS - 1, attentionEnv: env })))
        .threads,
    ).toHaveLength(1);
    expect(
      (await buildThreadList(makeCtx(), LIST_OPTS, deps({ now: NOW + ATTENTION_MEMO_TTL_MS, attentionEnv: env })))
        .threads,
    ).toEqual([]);
  });
});
