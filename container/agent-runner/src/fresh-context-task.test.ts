/**
 * `freshContext` task fires: a batch of flagged task rows starts the provider
 * with no resumed continuation; anything else resumes exactly as before.
 * Drives the real `runPollLoop` against a provider that records the
 * continuation each query was handed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { getInboundDb } from './mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, QueryInput } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import { isFreshContextTaskBatch } from './fresh-context-task.js';

class RecordingProvider extends MockProvider {
  readonly continuations: Array<string | undefined> = [];
  query(input: QueryInput): AgentQuery {
    this.continuations.push(input.continuation);
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

function insertRow(id: string, kind: 'task' | 'chat', content: object): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, datetime('now'), 'pending', 'chan-1', 'discord', NULL, ?)`,
    )
    .run(id, kind, JSON.stringify(content));
}

async function runOneBatch(provider: RecordingProvider): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: controller.signal });
  const start = Date.now();
  while (provider.continuations.length === 0) {
    if (Date.now() - start > 4000) throw new Error('provider never queried');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Let the turn finish so the new continuation is persisted.
  await new Promise((resolve) => setTimeout(resolve, 300));
  controller.abort();
  await loop.catch(() => {});
}

describe('fresh-context task fires', () => {
  it('a flagged task fire starts with no resumed continuation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'check the watch', freshContext: true });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBeUndefined();
    // The fresh turn's own session is what gets stored, not the old one.
    expect(getContinuation('mock')).toStartWith('mock-session-');
  });

  it('an unflagged task fire resumes the stored continuation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'check the watch' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });

  it('a chat row batched with a flagged fire keeps the conversation', async () => {
    setContinuation('mock', 'prior-session');
    insertRow('t1', 'task', { prompt: 'check the watch', freshContext: true });
    insertRow('c1', 'chat', { sender: 'Alice', text: 'and what about yesterday?' });
    const provider = new RecordingProvider();

    await runOneBatch(provider);

    expect(provider.continuations[0]).toBe('prior-session');
  });
});

describe('isFreshContextTaskBatch', () => {
  const row = (kind: string, content: object | string): MessageInRow =>
    ({ id: 'x', kind, content: typeof content === 'string' ? content : JSON.stringify(content) }) as MessageInRow;

  it('is true only when every non-system row is a flagged task', () => {
    expect(isFreshContextTaskBatch([row('task', { prompt: 'p', freshContext: true })])).toBe(true);
    expect(
      isFreshContextTaskBatch([row('system', { text: 'recall' }), row('task', { prompt: 'p', freshContext: true })]),
    ).toBe(true);
    expect(isFreshContextTaskBatch([row('task', { prompt: 'p' })])).toBe(false);
    expect(isFreshContextTaskBatch([row('task', { prompt: 'p', freshContext: 'yes' })])).toBe(false);
    expect(isFreshContextTaskBatch([row('task', 'not json')])).toBe(false);
    expect(isFreshContextTaskBatch([row('system', { text: 'recall' })])).toBe(false);
    expect(isFreshContextTaskBatch([])).toBe(false);
  });
});
