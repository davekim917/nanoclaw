import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import type { AppServer } from './codex-app-server.js';
import { runOneTurn, type CodexTurnHealthConfig } from './codex.js';

interface RecordedRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const FAST_HEALTH: CodexTurnHealthConfig = {
  quietMs: 1,
  intervalMs: 4,
  timeoutMs: 4,
  probeFailureLimit: 3,
  inactiveSnapshotLimit: 2,
  stillWorkingNoticeMs: 12,
};

function fakeServer(
  respond: (request: RecordedRequest) => { result?: unknown; error?: { code: number; message: string } } | null,
): { server: AppServer; requests: RecordedRequest[]; emit: (method: string, params: Record<string, unknown>) => void } {
  const requests: RecordedRequest[] = [];
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  const server = {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line) as RecordedRequest;
          requests.push(request);
          const response = respond(request);
          if (response) {
            queueMicrotask(() => {
              const handler = pending.get(request.id);
              pending.delete(request.id);
              handler?.resolve({ id: request.id, ...response } as never);
            });
          }
          return true;
        },
      },
      kill() {
        return true;
      },
    },
    readline: { close() {} },
    pending,
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;

  return {
    server,
    requests,
    emit(method, params) {
      for (const handler of [...server.notificationHandlers]) handler({ method, params });
    },
  };
}

async function collectTurn(
  server: AppServer,
  health: CodexTurnHealthConfig = FAST_HEALTH,
): Promise<Array<{ type: string; classification?: string }>> {
  const events: Array<{ type: string; classification?: string }> = [];
  for await (const event of runOneTurn(
    server,
    'thread-1',
    'do the work',
    'gpt-test',
    '/workspace',
    () => true,
    () => {},
    { currentTurnId: null },
    health,
  )) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('runOneTurn Codex control-plane health integration', () => {
  it('keeps a notification-silent open reasoning item alive while probes report active', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'active' } } } };
      if (request.method === 'thread/list') return { result: { data: [] } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'reason-1', type: 'reasoning' },
    });
    await Bun.sleep(35);
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(fixture.requests.filter((request) => request.method === 'thread/read').length).toBeGreaterThan(1);
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThan(1);
    expect(
      events.some(
        (event) => event.type === 'progress' && 'message' in event && event.message?.includes('still active'),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('keeps a quiet root alive while a descendant reports active', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: {} };
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'idle' } } } };
      if (request.method === 'thread/list') return { result: { data: [{ status: { type: 'active' } }] } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    await Bun.sleep(25);
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThan(0);
  });

  it('rejects a successful turn that abandons an open command execution', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ id: 'command-1', type: 'commandExecution', status: 'inProgress' }],
      },
    });
    const events = await resultPromise;

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      classification: 'protocol_desync',
    });
    expect(events.some((event) => event.type === 'result')).toBe(false);
  });

  it('accepts a successful turn whose final snapshot closes a missed command completion notification', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'completed result',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 }],
      },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'completed result' });
  });

  it('accepts a completed parent turn while its persistent collaboration item remains open', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    const collaborationItem = {
      id: 'collab-1',
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'inProgress',
      receiverThreadIds: ['child-1'],
    };
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: collaborationItem,
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'The child completed its assigned work.',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [collaborationItem],
      },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      text: 'The child completed its assigned work.',
    });
  });

  it('ignores child thread lifecycle notifications while the parent turn remains active', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    let settled = false;
    const resultPromise = collectTurn(fixture.server).then((events) => {
      settled = true;
      return events;
    });
    fixture.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    fixture.emit('item/started', {
      threadId: 'child-1',
      turnId: 'child-turn-1',
      item: { id: 'child-command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('thread/status/changed', {
      threadId: 'child-1',
      status: { type: 'systemError' },
    });
    fixture.emit('turn/completed', {
      threadId: 'child-1',
      turn: {
        id: 'child-turn-1',
        status: 'failed',
        error: { message: 'child failed' },
        items: [{ id: 'child-command-1', type: 'commandExecution', status: 'failed' }],
      },
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);

    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'parent result',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'parent result' });
  });

  it('uses the turn/start response to reject stale same-thread notifications when turn/started is dropped', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    await Bun.sleep(0);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-old',
      item: { id: 'stale-command', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-old',
        status: 'failed',
        items: [{ id: 'stale-command', type: 'commandExecution', status: 'inProgress' }],
        error: { message: 'stale turn failed' },
      },
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'current result',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'current result' });
  });

  it('ignores malformed lifecycle notifications that omit required scope identifiers', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    let settled = false;
    const resultPromise = collectTurn(fixture.server).then((events) => {
      settled = true;
      return events;
    });
    await Bun.sleep(0);
    fixture.emit('item/started', {
      item: { id: 'unscoped-command', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      turn: {
        id: 'turn-1',
        status: 'failed',
        items: [],
        error: { message: 'unscoped failure' },
      },
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);

    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'scoped result',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'scoped result' });
  });

  it('backfills an empty completed-turn snapshot before judging an open execution item', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') {
        return {
          result: {
            thread: {
              turns: [
                {
                  id: 'turn-1',
                  status: 'completed',
                  items: [{ id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 }],
                },
              ],
            },
          },
        };
      }
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'completed after backfill',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(fixture.requests.some((request) => request.method === 'thread/read')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'completed after backfill' });
  });

  it('backfills a non-empty summary view before judging an open execution item', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') {
        return {
          result: {
            thread: {
              turns: [
                {
                  id: 'turn-1',
                  status: 'completed',
                  itemsView: 'full',
                  items: [{ id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 }],
                },
              ],
            },
          },
        };
      }
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'completed after summary backfill',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        itemsView: 'summary',
        items: [{ id: 'message-1', type: 'agentMessage', text: 'display summary' }],
      },
    });
    const events = await resultPromise;

    expect(fixture.requests.some((request) => request.method === 'thread/read')).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'completed after summary backfill' });
  });

  it('retries transient completed-turn backfill failures before recovery', async () => {
    let readAttempts = 0;
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') {
        readAttempts++;
        if (readAttempts < 3) {
          return { error: { code: -32000, message: 'temporary read failure' } };
        }
        return {
          result: {
            thread: {
              turns: [
                {
                  id: 'turn-1',
                  status: 'completed',
                  itemsView: 'full',
                  items: [{ id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 }],
                },
              ],
            },
          },
        };
      }
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server, { ...FAST_HEALTH, quietMs: 10_000 });
    fixture.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      delta: 'completed after retries',
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(readAttempts).toBe(3);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'completed after retries' });
  });

  it('fails closed after three completed-turn backfill failures', async () => {
    let readAttempts = 0;
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') {
        readAttempts++;
        return { error: { code: -32000, message: 'persistent read failure' } };
      }
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server, { ...FAST_HEALTH, quietMs: 10_000 });
    fixture.emit('turn/started', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed', items: [] },
    });
    const events = await resultPromise;

    expect(readAttempts).toBe(3);
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      classification: 'protocol_desync',
    });
  });

  it('does not misclassify an interrupted turn with open work as protocol desync', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'interrupted',
        items: [{ id: 'command-1', type: 'commandExecution', status: 'inProgress' }],
      },
    });
    const events = await resultPromise;
    const error = events.find((event) => event.type === 'error');

    expect(error).toMatchObject({ type: 'error' });
    expect(error?.classification).toBeUndefined();
    expect(events.some((event) => event.classification === 'protocol_desync')).toBe(false);
  });

  it('preserves a current-schema failed turn instead of misclassifying its open command as desync', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution' },
    });
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: {
          message: 'usage limit reached',
          codexErrorInfo: { type: 'UsageLimitExceeded' },
        },
      },
    });
    const events = await resultPromise;

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      classification: 'quota',
    });
    expect(events.some((event) => event.classification === 'protocol_desync')).toBe(false);
  });

  it('classifies a truly unresponsive app-server after three bounded probes', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: {} };
      if (request.method === 'thread/read') return null;
      return { result: { data: [] } };
    });

    const events = await collectTurn(fixture.server);
    const error = events.find((event) => event.type === 'error');

    expect(fixture.requests.filter((request) => request.method === 'thread/read')).toHaveLength(3);
    expect(error).toMatchObject({ type: 'error', classification: 'control_plane_unresponsive' });
  });

  it('requires repeated responsive inactive snapshots before protocol recovery', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: {} };
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'idle' } } } };
      if (request.method === 'thread/list') return { result: { data: [] } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const events = await collectTurn(fixture.server);
    const error = events.find((event) => event.type === 'error');

    expect(fixture.requests.filter((request) => request.method === 'thread/read')).toHaveLength(2);
    expect(error).toMatchObject({ type: 'error', classification: 'protocol_desync' });
  });
});
