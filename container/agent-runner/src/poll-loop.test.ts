import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import {
  dispatchFileAttachment,
  dispatchResultText,
  handleEvent,
  isAdmissibleTrigger,
  isAupRefusal,
  isCorruptionError,
  selectInTurnFollowUps,
  transientOverloadDelayMs,
} from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: pure trigger=0 batch defers (no push)', () => {
    // The agent is mid-stream on an earlier turn — a non-mention shouldn't
    // interrupt thinking-blocks with content the bot wasn't addressed in.
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise during active turn' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'C', text: 'more noise' }, { trigger: 0 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 chat rides along when batch contains a chat trigger=1', () => {
    // Warm-container regression: prior implementation dropped trigger=0
    // unconditionally in the in-turn filter, stranding accumulated context
    // whenever the next mention also arrived in-turn (long-lived container
    // that never cold-restarts). Agent saw the mention but lost prior context.
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'mid-turn mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: /clear is not a real trigger — does not unlock trigger=0 ride-along', () => {
    // /clear is trigger=1 but excluded later in the loop (resets the
    // session). It must not gate trigger=0 context into the prompt — the
    // prompt would render only the context block and the /clear would be
    // handled separately. Defer until a real trigger arrives.
    insertMessage('m1', 'chat', { sender: 'A', text: 'old non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: non-recall system row trigger=1 does not unlock trigger=0', () => {
    // System rows (other than recall_context) are dropped by the filter —
    // they should not gate trigger=0 ride-along either.
    insertMessage('m1', 'chat', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('s1', 'system', { subtype: 'something_else' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 task rows do NOT ride along — only chat/chat-sdk do', () => {
    // The original `m.trigger !== 1` guard rejected trigger=0 of any kind.
    // The new ride-along is restricted to chat/chat-sdk; tasks and webhooks
    // still gate on their own trigger=1.
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('t1', 'task', { script: 'noop', wakeAgent: false }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: chat-sdk parity — trigger=0 chat-sdk rides along like chat', () => {
    insertMessage('m1', 'chat-sdk', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('m2', 'chat-sdk', { sender: 'B', text: 'mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: trigger=0 webhook does NOT ride — only chat/chat-sdk do', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('w1', 'webhook', { url: '/x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: malformed recall content/id is dropped, not crashed on', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    // Not JSON
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('s-bad', 'system', datetime('now'), 'pending', 0, 'not-json')`,
      )
      .run();
    // Recall-shaped but no recall- prefix
    insertMessage('s-noprefix', 'system', { subtype: 'recall_context', text: 'x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: /clear alongside a real mention — /clear excluded, real batch admitted', () => {
    insertMessage('clr', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('ctx', 'chat', { sender: 'B', text: 'old context' }, { trigger: 0 });
    insertMessage('real', 'chat', { sender: 'C', text: 'hey @bot' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    // /clear stays out; the real batch (real + ctx) goes through.
    expect(ids).toEqual(['ctx', 'real']);
  });

  it('isAdmissibleTrigger: returns true only for non-system, non-/clear, trigger=1 rows', () => {
    insertMessage('a', 'chat', { sender: 'A', text: 'hi' }, { trigger: 1 });
    insertMessage('b', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('c', 'chat', { sender: 'A', text: 'ctx' }, { trigger: 0 });
    insertMessage('d', 'system', { subtype: 'something' }, { trigger: 1 });
    insertMessage('e', 'task', { name: 'cron' }, { trigger: 1 });
    const byId = Object.fromEntries(getPendingMessages().map((m) => [m.id, m]));
    expect(isAdmissibleTrigger(byId.a)).toBe(true);
    expect(isAdmissibleTrigger(byId.b)).toBe(false);
    expect(isAdmissibleTrigger(byId.c)).toBe(false);
    expect(isAdmissibleTrigger(byId.d)).toBe(false);
    expect(isAdmissibleTrigger(byId.e)).toBe(true);
  });

  it('selectInTurnFollowUps: recall_context only rides when paired trigger is admitted', () => {
    // Pair admission must be checked against the post-filter trigger set,
    // not the raw snapshot. /clear's id should NOT satisfy a recall pair.
    insertMessage('clear-id', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    insertMessage(
      'recall-clear-id',
      'system',
      { subtype: 'recall_context', text: 'facts' },
      {
        trigger: 0,
      },
    );
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);

    // But a recall paired with a real trigger does ride along.
    insertMessage('real-mention', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage(
      'recall-real-mention',
      'system',
      { subtype: 'recall_context', text: 'facts' },
      {
        trigger: 0,
      },
    );
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['real-mention', 'recall-real-mention']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X is in processing_ack', () => {
    // The host writes recall-X paired to inbound row X. If X is a /clear
    // (handled and markCompleted'd inline by the runner) or a task gated
    // by pre-task script, X gets a 'completed' processing_ack but recall-X
    // never does. Without the orphan drain, recall-X would surface as a
    // standalone "[Recalled context]" prompt with no user message on the
    // next cold-start iteration.
    insertMessage('X', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    insertMessage('Y', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    // Simulate X being completed (as the /clear handler would do).
    markCompleted(['X']);
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    // recall-X must be gone; Y is still pending.
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X has a messages_out reply', () => {
    // The respondedIds idempotency guard treats X as completed if the
    // agent already wrote a reply. recall-X must drain on this signal too.
    insertMessage('X', 'chat', { sender: 'A', text: 'old mention' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    getInboundDb()
      // Use raw INSERT so we don't trigger the markCompleted helper here.
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('Y', 'chat', datetime('now'), 'pending', 1, '{"text":"hi"}')`,
      )
      .run();
    // Simulate the agent having replied to X already.
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('out-1', 'chat', datetime('now'), 'X', '{"text":"replied"}')`,
      )
      .run();
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: due task row survives a phantom reply written BEFORE it was due (poison guard)', () => {
    // Regression for the 2026-05-27..31 scheduled-task die-off: a sibling
    // task's output was stamped in_reply_to = this row's id hours before
    // this row's process_after. A reply can't precede its question — the
    // row must still fire.
    const dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // due 1h ago
    insertMessage('t-next', 'task', { prompt: 'daily briefing' }, { processAfter: dueAt });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('phantom', 'chat', datetime('now', '-3 hours'), 't-next', '{"text":"sibling task output"}')`,
      )
      .run();
    const ids = getPendingMessages().map((m) => m.id);
    expect(ids).toEqual(['t-next']);
  });

  it('getPendingMessages: task row IS filtered when the reply came after it was due (crash-dup protection)', () => {
    // The original guard's purpose: container died between writing the
    // reply and markCompleted. Reply timestamp >= process_after means the
    // row genuinely ran — don't re-process it.
    const dueAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // due 2h ago
    insertMessage('t-ran', 'task', { prompt: 'daily briefing' }, { processAfter: dueAt });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('real-reply', 'chat', datetime('now', '-1 hour'), 't-ran', '{"text":"briefing output"}')`,
      )
      .run();
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);
  });

  it('getPendingMessages: due-aware guard handles SQLite-format process_after (retryWithBackoff shape)', () => {
    // process_after can be ISO (scheduleTask) or 'YYYY-MM-DD HH:MM:SS'
    // (datetime-based backoff). Both must compare correctly as UTC.
    insertMessage('t-backoff', 'task', { prompt: 'retry me' }, { processAfter: '2026-01-01 00:00:00' });
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('late-reply', 'chat', datetime('now'), 't-backoff', '{"text":"done"}')`,
      )
      .run();
    // Reply (now) is after due (2026-01-01) → genuinely handled → filtered.
    expect(getPendingMessages().map((m) => m.id)).toEqual([]);
  });

  it('getPendingMessages: legitimate paired recall-X + X both still returned (no false positive drain)', () => {
    // The drain only fires when X is acked or replied-to. A normal pair
    // with both rows still pending must come through untouched.
    insertMessage('X', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['X', 'recall-X']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('skips system rows (recall_context) when picking the routing anchor', () => {
    // recall_context is inserted before its paired inbound message and would
    // otherwise hijack inReplyTo, making outbound replies attach to recall-X
    // instead of the real user message X.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('recall-m1', 'system', datetime('now', '-1 second'), 'pending', NULL, NULL, NULL,
               '{"subtype":"recall_context","facts":[]}')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('m1');
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
  });

  it('treats platform_id-set + thread_id-null as authoritative (no session_routing fallback)', () => {
    // Daily background tasks (wiki-synthesise) are scheduled with
    // destination={platformId, channelType, threadId:null} so the report
    // posts to the channel root. A wake triggered by a thread chat earlier
    // populates session_routing with that thread, but the task's explicit
    // null thread_id MUST NOT be overridden by the session's thread.
    // (Real-world manifestation: madison-reed synth on 2026-05-01 scheduled
    // for discord channel root, landed in a stale session thread because
    // the prior `??` fallback treated null as "missing".)
    const db = getInboundDb();
    // session_routing isn't part of initTestSessionDb's schema; create it
    // inline with the same structure src/session-manager.ts writes in
    // production (CREATE TABLE happens on first writeSessionRouting call).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:thread-from-prior-wake')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('synth-1', 'task', datetime('now'), 'pending', 'discord:G:C', 'discord', NULL,
               '{"prompt":"synth","quietStatus":true}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('discord:G:C');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBeNull(); // NOT 'slack:C123:thread-from-prior-wake'
  });

  it('falls back to session_routing per-field when message has no platform_id (a-to-a case)', () => {
    // Agent-to-agent inbounds carry channel_type='agent' but no platform_id
    // (the message originates from another agent, not a Slack/Discord
    // channel). The reply still needs to route to the session's home
    // channel/thread, so fall back to session_routing for all three fields.
    const db = getInboundDb();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:home-thread')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('a2a-1', 'chat', datetime('now'), 'pending', NULL, 'agent', NULL,
               '{"sender":"sibling-agent","text":"hi"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('slack:C123');
    expect(routing.channelType).toBe('slack');
    expect(routing.threadId).toBe('slack:C123:home-thread');
  });

  it('task in batch dominates routing — chat-row thread does not hijack', () => {
    // A scheduled task fires while an older chat row from a thread is still
    // pending in the batch (host hadn't synced processing_ack yet, or the
    // container restarted and clearStaleProcessingAcks wiped its claim, and
    // the prior turn's outbound didn't set in_reply_to so respondedIds didn't
    // catch the chat). Without task-row priority, extractRouting picks the
    // older chat row as `first` and the task's reply lands in that thread
    // instead of the channel root.
    //
    // Real-world manifestation: 2026-05-07, illyse Slack agent — every */15
    // task fired into the originating thread instead of #agents-xzo root.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('chat-old', 2, 'chat-sdk', datetime('now', '-1 hour'), 'pending',
               'slack:C0AJA89MN2E', 'slack-illysium',
               'slack:C0AJA89MN2E:1778100372.246009',
               '{"text":"original user request that opened the thread"}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('task-new', 4, 'task', datetime('now'), 'pending',
               'slack:C0AJA89MN2E', 'slack-illysium', NULL,
               '{"prompt":"poll inbox"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('task-new');
    expect(routing.threadId).toBeNull();
    expect(routing.platformId).toBe('slack:C0AJA89MN2E');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(
    id: string,
    kind: string,
    content: object,
    channelType: string | null,
    platformId: string | null,
  ): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('dispatchResultText — unwrapped output fallback', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function routing(channelType: string | null, platformId: string | null) {
    return { channelType, platformId, threadId: null, inReplyTo: null, quietStatus: false };
  }

  it('routes wrapped <message to=...> blocks to their named destinations', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    dispatchResultText('<message to="discord-side">explicit reply</message>', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].platform_id).toBe('chan-9');
    expect(JSON.parse(out[0].content).text).toBe('explicit reply');
  });

  it('multi-destination + unwrapped text → routes to origin destination (the fix)', () => {
    // Two destinations wired (e.g. agent-shared mode, or auto-wired channels).
    // The agent forgot to wrap and produced bare text. Origin = slack-main
    // because routing.channelType+platformId match it.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    dispatchResultText('Sorry, I dropped the wrapping. Here is my actual answer.', routing('slack', 'C-MAIN'));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-MAIN');
    expect(JSON.parse(out[0].content).text).toContain('Here is my actual answer.');
  });

  it('multi-destination + unwrapped text + unresolvable origin → drops (no broadcast)', () => {
    // Routing has no platformId match in destinations table, and we have
    // multiple destinations — there's no safe target, drop the text.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    dispatchResultText('unwrapped reply with no resolvable origin', routing('telegram', 'unknown-chat'));

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('single-destination + unwrapped text + null routing → routes to the only destination', () => {
    // Legacy behavior preserved: cron-fired tasks with stripped routing in
    // a single-destination group still get rescued.
    seedDestination('slack-only', 'slack', 'C-ONLY');

    dispatchResultText('bare text from a null-routed source', routing(null, null));

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-ONLY');
  });

  it('wrapped output + scratchpad does NOT trigger fallback', () => {
    // If the agent wrapped at least one block, scratchpad is just notes
    // — don't double-deliver via fallback.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');

    dispatchResultText(
      'thinking out loud<message to="slack-main">final answer</message>more notes',
      routing('slack', 'C-MAIN'),
    );

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('final answer');
  });

  it('only <internal> tags → empty scratchpad → no delivery', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');

    dispatchResultText('<internal>just thinking</internal>', routing('slack', 'C-MAIN'));

    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('stages provider-generated files into outbox and routes them to the origin destination', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES ('in-1', 'chat', datetime('now'), 'completed', 1, 'C-MAIN', 'slack', 'thread-1', '{}')`,
      )
      .run();

    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-'));
    const outboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-'));
    const sourcePath = path.join(sourceDir, 'cafe.png');
    fs.writeFileSync(sourcePath, Buffer.from('png-bytes'));

    const delivered = dispatchFileAttachment(
      { path: sourcePath, text: 'Preview', filename: '../cafe.png' },
      { ...routing('slack', 'C-MAIN'), inReplyTo: 'trigger-1' },
      outboxRoot,
    );

    expect(delivered).toBe(true);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-MAIN');
    // thread_id resolves from the destination's latest inbound row, but
    // in_reply_to must be the TURN's triggering message — never the latest
    // inbound row, which can be a sibling task's unfired future row (the
    // 2026-05 scheduled-task poison).
    expect(out[0].thread_id).toBe('thread-1');
    expect(out[0].in_reply_to).toBe('trigger-1');
    const content = JSON.parse(out[0].content);
    expect(content).toEqual({ text: 'Preview', files: ['cafe.png'] });
    expect(fs.readFileSync(path.join(outboxRoot, out[0].id, 'cafe.png'), 'utf-8')).toBe('png-bytes');
  });

  it('does not broadcast provider-generated files when the origin cannot be resolved', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    seedDestination('discord-side', 'discord', 'chan-9');
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-image-'));
    const sourcePath = path.join(sourceDir, 'cafe.png');
    fs.writeFileSync(sourcePath, Buffer.from('png-bytes'));

    const delivered = dispatchFileAttachment(
      { path: sourcePath },
      routing('slack', 'C-UNKNOWN'),
      fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-')),
    );

    expect(delivered).toBe(false);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('dispatchResultText — unclosed-wrapper tolerance', () => {
  // Production repro (illie-codex, 2026-05-17 Slack thread C0AJA89MN2E):
  // the agent emitted two `<message to="slack_illysium_agents_xzo">`
  // openers in one final response with NO closing `</message>` tag for
  // either. The old regex required a close → zero matches → the entire
  // text fell through to the unwrapped-fallback path and Slack saw the
  // raw `<message to="…">` XML in chat. The tolerant parser slices each
  // body to "next opener / explicit close / EOT" and routes each block,
  // so a single forgotten close no longer leaks markup.
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }
  function routing(channelType: string | null, platformId: string | null) {
    return { channelType, platformId, threadId: null, inReplyTo: null, quietStatus: false };
  }

  it('single unclosed opener at end-of-text → body extends to EOT and routes normally', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    dispatchResultText('<message to="slack-main">no closing tag, please ship this', routing('slack', 'C-MAIN'));
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].channel_type).toBe('slack');
    expect(JSON.parse(out[0].content).text).toBe('no closing tag, please ship this');
  });

  it('two consecutive unclosed openers (same dest) → two sends, no markup leak', () => {
    // Mirrors the illie-codex production repro: two `<message to="…">`
    // openers, no closes. Each becomes its own outbound row.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    dispatchResultText(
      '<message to="slack-main">first body\nspans multiple lines\n' + '<message to="slack-main">second body acked',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const texts = out.map((r) => JSON.parse(r.content).text);
    expect(texts).toEqual(['first body\nspans multiple lines', 'second body acked']);
    // No <message…> markup should reach the wire.
    for (const t of texts) {
      expect(t).not.toContain('<message');
      expect(t).not.toContain('</message>');
    }
  });

  it('explicit close before next opener wins as the body endpoint', () => {
    seedDestination('slack-main', 'slack', 'C-MAIN');
    dispatchResultText(
      '<message to="slack-main">first done</message>\nbetween\n' + '<message to="slack-main">second still open',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    expect(JSON.parse(out[0].content).text).toBe('first done');
    expect(JSON.parse(out[1].content).text).toBe('second still open');
    // The "between" text is scratchpad — never delivered (a partial wrap
    // counts as wrapped output, so the fallback doesn't fire).
  });

  it('opener with empty to="" → block dropped, no markup leaks via fallback', () => {
    // Malformed opener — drop the block and ensure any residual `<message…>`
    // text in the fallback path gets stripped before reaching the user.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    dispatchResultText('<message to="">malformed body</message>\nrest of reply', routing('slack', 'C-MAIN'));
    const out = getUndeliveredMessages();
    // Since the malformed opener's body becomes scratchpad and there are
    // no successful sends, the fallback fires on the combined scratchpad.
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).toContain('malformed body');
    expect(text).toContain('rest of reply');
    expect(text).not.toContain('<message');
    expect(text).not.toContain('</message>');
  });

  it('stray `<message…>` markup in scratchpad-only text gets stripped from fallback', () => {
    // Defensive: an agent that emits orphan opener tokens with no
    // matching close but ALSO no valid destination resolution should
    // never expose raw markup to the user. The opener regex requires
    // a `to="…"` attribute, so a bare `<message>` literal (no `to`)
    // doesn't even match — but if one slips in via a different path
    // (e.g. an unknown destination plus a stripped wrapper), the strip
    // catches it.
    seedDestination('slack-main', 'slack', 'C-MAIN');
    dispatchResultText(
      'pre-text\n<message to="unknown-destination">body</message>\npost-text',
      routing('slack', 'C-MAIN'),
    );
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const text = JSON.parse(out[0].content).text;
    expect(text).not.toContain('<message');
    expect(text).not.toContain('</message>');
  });
});

describe('processQuery done-flag invariant (codex F4 regression guard)', () => {
  it('result handler does NOT flip done — provider stream stays open across turns', async () => {
    // Codex F4 (2026-05-05): a prior commit set `done = true` synchronously
    // inside the `event.type === 'result'` branch. The polling interval
    // gates on `done`, so flipping it after the first result starved every
    // follow-up trigger=1 row in the session — the host wouldn't wake a
    // second container (this one was still running) and there was no
    // processing claim, so recovery fell back to the 30-min absolute
    // heartbeat ceiling. The provider's events generator stays open until
    // explicit `query.end()`/abort (see container/agent-runner/src/providers/
    // claude.ts:1080); only the outer for-await returning should flip
    // `done`. This guard catches re-introduction of the synchronous flip.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('./poll-loop.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    // Anchor on `markCompleted(initialBatchIds);` — the only call site is
    // inside the result handler (other completion paths use `markCompleted(skipped)`
    // or `markCompleted(keptIds)`). The 20 lines BEFORE this anchor are
    // the result-handler body up to the `} else if (event.type === 'result') {`
    // line. Anywhere in that window flipping `done` is the regression.
    const anchorIdx = lines.findIndex((l) => l.includes('markCompleted(initialBatchIds)'));
    expect(anchorIdx).toBeGreaterThan(-1);
    const handlerWindow = lines.slice(Math.max(0, anchorIdx - 20), anchorIdx + 1).join('\n');
    // Strip line comments before the regression check so the explanatory
    // comment naming the prohibited code doesn't itself trip the assertion.
    const codeOnly = handlerWindow
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    expect(codeOnly).not.toContain('done = true');
  });

  it('does NOT throw on a retryable (api_retry) event; surfaces only if no result arrives', async () => {
    // 2026-06-26: processQuery threw on EVERY error event, including the SDK's
    // own `api_retry` retry signal (retryable:true). That dead-turned long
    // ultracode turns with a bogus "Error: API retry" the SDK would have
    // recovered from. The handler must `continue` on a retryable event (let the
    // SDK's internal retry finish) and only surface it post-loop when the stream
    // ended without a result. Source-anchored like the F4 guard above — driving
    // processQuery needs full stream+session-DB fixtures this file avoids.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('./poll-loop.ts', import.meta.url), 'utf8');
    const errIdx = src.indexOf("if (event.type === 'error') {");
    expect(errIdx).toBeGreaterThan(-1);
    const handler = src.slice(errIdx, errIdx + 700);
    // retryable branch continues instead of throwing
    expect(handler).toContain('if (event.retryable)');
    expect(handler).toContain('lastRetryableErr = err;');
    expect(handler).toContain('continue;');
    // and the post-loop surface exists so a never-recovering stream isn't silent
    expect(src).toContain('if (!sawResult && lastRetryableErr) throw lastRetryableErr;');
  });
});

describe('isAupRefusal', () => {
  it('test_isAupRefusal_matches_canonical_anthropic_envelope', () => {
    const refusal =
      'API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy ' +
      '(https://www.anthropic.com/legal/aup). Try rephrasing the request or attempting a different approach. ' +
      'If you are seeing this refusal repeatedly, try running /model claude-sonnet-4-20250514 to switch models.';
    expect(isAupRefusal(refusal)).toBe(true);
  });

  it('test_isAupRefusal_does_not_match_legitimate_prose_about_policy', () => {
    // Discussion of the policy URL alone shouldn't trip the detector — both
    // anchors are required.
    expect(isAupRefusal('See https://www.anthropic.com/legal/aup for details on the usage policy.')).toBe(false);
    expect(isAupRefusal('Claude Code is unable to respond when offline.')).toBe(false);
  });

  it('test_isAupRefusal_returns_false_for_empty_and_short_text', () => {
    expect(isAupRefusal('')).toBe(false);
    expect(isAupRefusal('Done.')).toBe(false);
    expect(isAupRefusal('API Error: rate limit exceeded.')).toBe(false);
  });
});

describe('handleEvent — terminal-error visibility (Layer-1 fix)', () => {
  // Background: when a provider yields `{type:'error', retryable:false}`
  // (e.g. codex hard turn-timeout, claude quota exhaustion), the user
  // used to see nothing — the for-await would exit, the next turn would
  // also time out the same way, and 30 min later host-sweep silently
  // reaped the container. The fix surfaces the error on the user's
  // delivery channel as a normal chat outbound. Retryable errors stay
  // quiet (the runner retries upstream); only the terminal branch posts.
  function routingFixture() {
    return {
      channelType: 'slack',
      platformId: 'C-TEST',
      threadId: 'T-TEST',
      inReplyTo: null,
      quietStatus: false,
    };
  }

  it('retryable=false writes a visible chat outbound on the session route', () => {
    handleEvent({ type: 'error', message: 'Turn timed out after 300000ms', retryable: false }, routingFixture());
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('chat');
    expect(out[0].channel_type).toBe('slack');
    expect(out[0].platform_id).toBe('C-TEST');
    expect(out[0].thread_id).toBe('T-TEST');
    const body = JSON.parse(out[0].content) as { text: string };
    expect(body.text).toContain('Turn timed out after 300000ms');
    expect(body.text).toContain('pick up from your next message');
  });

  it('retryable=true is silent — runner is still working on a fix internally', () => {
    handleEvent({ type: 'error', message: 'API retry', retryable: true }, routingFixture());
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('classification is included in the chat surface for terminal errors', () => {
    handleEvent({ type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' }, routingFixture());
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const body = JSON.parse(out[0].content) as { text: string };
    expect(body.text).toContain('Rate limit');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

describe('transientOverloadDelayMs — server-overload backoff schedule', () => {
  // base 1500ms, cap 30_000ms, full jitter (delay ∈ [ceil/2, ceil]).
  it('grows exponentially then clamps at the 30s cap', () => {
    // rand=1 → top of the jitter band = the full ceiling for that attempt.
    expect(transientOverloadDelayMs(0, 1)).toBe(1500); // 1500 * 2^0
    expect(transientOverloadDelayMs(1, 1)).toBe(3000); // 1500 * 2^1
    expect(transientOverloadDelayMs(4, 1)).toBe(24000); // 1500 * 2^4
    expect(transientOverloadDelayMs(5, 1)).toBe(30000); // 48000 → clamped
    expect(transientOverloadDelayMs(29, 1)).toBe(30000); // last attempt, still clamped
  });

  it('applies full jitter — never below half the ceiling, never above it', () => {
    // rand=0 → bottom of the band = ceil/2.
    expect(transientOverloadDelayMs(0, 0)).toBe(750);
    expect(transientOverloadDelayMs(5, 0)).toBe(15000); // clamped ceil 30000 / 2
    // 30 attempts capped at 30s each ≈ 13 min worst case — under the host
    // sweep's 30-min idle ceiling (heartbeat is touched across each sleep).
    let worstCaseMs = 0;
    for (let n = 0; n < 30; n++) worstCaseMs += transientOverloadDelayMs(n, 1);
    expect(worstCaseMs).toBeLessThan(30 * 60 * 1000);
  });
});
