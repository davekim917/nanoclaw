/**
 * A scheduled task has NO default of its own.
 *
 * Until 2026-09-07 a Claude-only branch in the poll loop forced an unpinned
 * PURE task wake onto `sonnet` at `xhigh`, independent of the group's own
 * configured model and effort. That made "scheduled" silently mean "a
 * different, cheaper agent than the one that answers in chat" — a policy the
 * group's container config had no say in and no way to see.
 *
 * But "no default of its own" must not become "inherits the interactive one".
 * The sticky model/effort live in `session_state` — the session's own durable
 * DB — and chat and task messages share a session, so a PURE task wake that
 * simply fell through to `applyFlagBatch` would fire on whatever `-m` a human
 * last typed in that thread. That is the same defect the 2026-07-02 sonnet
 * block was written to fix; it is fixed here by SUPPRESSING the sticky on a
 * pure task wake rather than by substituting a hardcoded default.
 *
 * These tests pin the resolution at the seam that decides it: what the poll
 * loop actually hands the provider as `QueryInput.model` / `.effort`.
 * `undefined` is the whole point — it means "no per-turn override", which is
 * what lets the group default (and, failing that, the provider's own family
 * default) apply, exactly as it does for interactive chat.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { getStickyModel, getStickyEffort } from './modules/mailbox/session-state.js';
import type { AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';

/** MockProvider that records every QueryInput the loop hands it. */
class RecordingProvider extends MockProvider {
  readonly inputs: QueryInput[] = [];

  query(input: QueryInput): AgentQuery {
    this.inputs.push(input);
    return super.query(input);
  }
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/**
 * Canonical ISO-8601 UTC, never `datetime('now')`. The naive
 * `YYYY-MM-DD HH:MM:SS` form that SQLite's `datetime()` produces parses as
 * LOCAL time in `new Date()` and breaks string comparison against the ISO
 * values production writes — so a fixture using it silently stops exercising
 * the storage invariant it is supposed to stand in for, and does so only on
 * hosts whose timezone is not UTC.
 */
function insertTask(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'task', ?, 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify(content));
}

function insertChat(id: string, content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', ?, 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify(content));
}

function deliverableOut() {
  return getUndeliveredMessages().filter(
    (m) => !(m.kind === 'system' && (JSON.parse(m.content) as { action?: string }).action === 'turn_end'),
  );
}

/** Wait until the loop has issued at least `n` queries. */
async function runUntilQueryCount(provider: RecordingProvider, n: number): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 6000)),
  ]);
  const start = Date.now();
  while (provider.inputs.length < n) {
    if (Date.now() - start > 5000) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

async function runUntilQueried(provider: RecordingProvider): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: '/tmp', signal: controller.signal }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
  ]);
  const start = Date.now();
  while (deliverableOut().length === 0) {
    if (Date.now() - start > 3000) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('scheduled-task model/effort resolution (claude)', () => {
  it('an UNPINNED task wake carries no per-turn model or effort — the group default applies', async () => {
    insertTask('t1', { prompt: 'daily digest' });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');

    await runUntilQueried(provider);

    expect(provider.inputs.length).toBeGreaterThan(0);
    // Pre-fix this was `sonnet` / `xhigh`, injected by the poll loop itself.
    expect(provider.inputs[0].model).toBeUndefined();
    expect(provider.inputs[0].effort).toBeUndefined();
  });

  it("a task's OWN pin still reaches the provider unchanged", async () => {
    insertTask('t2', {
      prompt: 'weekly build',
      flagIntent: { turnModel: 'claude-fable-5-1[1m]', turnEffort: 'medium' },
    });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');

    await runUntilQueried(provider);

    expect(provider.inputs[0].model).toBe('claude-fable-5-1[1m]');
    expect(provider.inputs[0].effort).toBe('medium');
  });

  it('a MODEL-only pin no longer drags an xhigh effort along with it', async () => {
    insertTask('t3', { prompt: 'nightly', flagIntent: { turnModel: 'claude-opus-5[1m]' } });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');

    await runUntilQueried(provider);

    expect(provider.inputs[0].model).toBe('claude-opus-5[1m]');
    // Pre-fix: 'xhigh', which the provider would then clamp against opus.
    expect(provider.inputs[0].effort).toBeUndefined();
  });

  it('a mixed chat + task batch is unaffected (it never took the default either)', async () => {
    insertChat('c1', { sender: 'Alice', text: 'and while you are there' });
    insertTask('t4', { prompt: 'daily digest' });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');

    await runUntilQueried(provider);

    expect(provider.inputs[0].model).toBeUndefined();
    expect(provider.inputs[0].effort).toBeUndefined();
  });
});

describe('a pure task wake does not inherit the interactive sticky', () => {
  it('an unpinned task ignores a sticky model/effort set earlier in the same session', async () => {
    // Turn 1: a human sets a sticky the way chat actually sets one — a
    // flagIntent carrying stickyModel/stickyEffort, which applyFlagBatch
    // writes through to session_state.
    insertChat('c-sticky', {
      sender: 'Alice',
      text: 'use opus from now on',
      flagIntent: { stickyModel: 'claude-opus-5[1m]', stickyEffort: 'xhigh' },
    });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');
    await runUntilQueryCount(provider, 1);

    // Turn 2: a pure, unpinned task wake. Inserted only after the chat turn
    // has been queried — inserting both up front lets the loop batch them
    // into ONE mixed turn, which is a different case (covered below).
    insertTask('t-after-sticky', { prompt: 'nightly digest' });
    await runUntilQueryCount(provider, 2);

    expect(provider.inputs.length).toBeGreaterThanOrEqual(2);

    // POSITIVE CONTROL. Without this the assertions below pass trivially on a
    // session where the sticky was never written at all — "undefined" would
    // then be measuring nothing. The sticky must really be set and durable.
    expect(getStickyModel()).toBe('claude-opus-5[1m]');
    expect(getStickyEffort()).toBe('xhigh');

    // The chat turn itself DOES use the sticky — that is the human's choice
    // and must not be disturbed.
    expect(provider.inputs[0].model).toBe('claude-opus-5[1m]');
    expect(provider.inputs[0].effort).toBe('xhigh');

    // The pure task wake does NOT. It carries no per-turn override, so the
    // group's configured model applies. Pre-fix this was 'claude-opus-5[1m]'
    // / 'xhigh' — a nightly task riding a model a human picked yesterday.
    expect(provider.inputs[1].model).toBeUndefined();
    expect(provider.inputs[1].effort).toBeUndefined();
  });

  it("a task's OWN pin still wins over a sticky", async () => {
    insertChat('c-sticky2', {
      sender: 'Alice',
      text: 'opus please',
      flagIntent: { stickyModel: 'claude-opus-5[1m]', stickyEffort: 'xhigh' },
    });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');
    await runUntilQueryCount(provider, 1);

    insertTask('t-pinned', {
      prompt: 'weekly build',
      flagIntent: { turnModel: 'claude-fable-5-1[1m]', turnEffort: 'medium' },
    });
    await runUntilQueryCount(provider, 2);

    expect(getStickyModel()).toBe('claude-opus-5[1m]');
    expect(provider.inputs[1].model).toBe('claude-fable-5-1[1m]');
    expect(provider.inputs[1].effort).toBe('medium');
  });

  it('a MIXED chat + task batch keeps the sticky — that turn is a human conversation', async () => {
    // The mirror of the bug: silently downgrading a turn a human is part of,
    // just because a task happened to be batched into it, would be equally
    // wrong. Only a PURE task wake is suppressed.
    insertChat('c-sticky3', {
      sender: 'Alice',
      text: 'opus please',
      flagIntent: { stickyModel: 'claude-opus-5[1m]' },
    });
    const provider = new RecordingProvider({}, () => '<message to="discord-test">done</message>');
    await runUntilQueryCount(provider, 1);

    insertChat('c-later', { sender: 'Alice', text: 'and while you are there' });
    insertTask('t-mixed', { prompt: 'daily digest' });
    await runUntilQueryCount(provider, 2);

    expect(getStickyModel()).toBe('claude-opus-5[1m]');
    expect(provider.inputs[1].model).toBe('claude-opus-5[1m]');
  });
});
