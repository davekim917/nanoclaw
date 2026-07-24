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
    fixture.emit('item/started', { item: { id: 'reason-1', type: 'reasoning' } });
    await Bun.sleep(35);
    fixture.emit('turn/completed', { status: 'completed' });
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
    fixture.emit('turn/completed', { status: 'completed' });
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
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('turn/completed', {
      turn: {
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
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    fixture.emit('item/agentMessage/delta', { delta: 'completed result' });
    fixture.emit('turn/completed', {
      turn: {
        status: 'completed',
        items: [{ id: 'command-1', type: 'commandExecution', status: 'completed', exitCode: 0 }],
      },
    });
    const events = await resultPromise;

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'result', text: 'completed result' });
  });

  it('preserves a current-schema failed turn instead of misclassifying its open command as desync', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      return { error: { code: -32601, message: 'unexpected method' } };
    });

    const resultPromise = collectTurn(fixture.server);
    fixture.emit('item/started', { item: { id: 'command-1', type: 'commandExecution' } });
    fixture.emit('turn/completed', {
      turn: {
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
