/**
 * #1028: a Codex coordinator's roster must carry each child's model and
 * effort BEFORE the turn ends.
 *
 * With outcome reporting on (the default) the agent replies through
 * send_message mid-turn, and that row is stamped from the persisted snapshot
 * at the moment it is written. The roster used to be enriched only after
 * turn/completed, so a default Codex install showed the agent path with no
 * model or effort. This drives the real runOneTurn against a fake app-server
 * and inspects the roster while the turn is still open.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { _resetConfig, _setConfigForTest } from '../config.js';
import {
  _forgetOwnershipForTest,
  clearSubagents,
  formatStatusSubtext,
  hydrateTurnStatus,
  resetTurnStatus,
  setOwnConversation,
  setTurnSettings,
} from '../turn-status.js';
import type { AppServer } from './codex-app-server.js';
import { runOneTurn, type CodexTurnHealthConfig } from './codex.js';
import type { ProviderEvent } from './types.js';

interface RecordedRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const HEALTH: CodexTurnHealthConfig = {
  quietMs: 1_000,
  intervalMs: 1_000,
  timeoutMs: 50,
  probeFailureLimit: 3,
  inactiveSnapshotLimit: 2,
  stillWorkingNoticeMs: 60_000,
};

function fakeServer(respond: (request: RecordedRequest) => { result?: unknown } | null) {
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
    emit(method: string, params: Record<string, unknown>) {
      for (const handler of [
        ...(server as unknown as { notificationHandlers: ((n: unknown) => void)[] }).notificationHandlers,
      ])
        handler({ method, params });
    },
  };
}

function childActivity(id: string, threadId: string) {
  return {
    threadId: 'thread-1',
    turnId: 'turn-1',
    item: { id, type: 'subAgentActivity', kind: 'spawned', agentThreadId: threadId, agentPath: '/root/researcher' },
  };
}

beforeEach(() => {
  initTestSessionDb();
  _resetConfig();
  _setConfigForTest({});
  resetTurnStatus();
  setTurnSettings('gpt-5.6-sol', 'high');
  setOwnConversation('slack', 'slack:C1');
});

afterEach(() => {
  resetTurnStatus();
  _resetConfig();
  closeSessionDb();
});

describe('Codex subagent roster enrichment (#1028)', () => {
  it('has model and effort in the persisted roster before turn/completed', async () => {
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'active' } } } };
      if (request.method === 'thread/list')
        return {
          result: {
            data: [
              { id: 'child-1', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
              { id: 'child-2', model: 'gpt-5.6-sol', reasoning_effort: 'medium' },
            ],
          },
        };
      return null;
    });

    const events: ProviderEvent[] = [];
    const done = (async () => {
      for await (const event of runOneTurn(
        fixture.server,
        'thread-1',
        'delegate',
        'gpt-5.6-sol',
        '/workspace',
        () => true,
        () => {},
        { currentTurnId: null },
        HEALTH,
      ))
        events.push(event);
    })();

    await Bun.sleep(5);
    fixture.emit('item/started', childActivity('a-1', 'child-1'));
    fixture.emit('item/started', childActivity('a-2', 'child-2'));
    // The same child reporting again must not trigger another read.
    fixture.emit('item/started', childActivity('a-3', 'child-1'));
    await Bun.sleep(20);

    // Mid-turn: what the MCP subprocess would see when send_message stamps.
    _forgetOwnershipForTest();
    hydrateTurnStatus();
    expect(formatStatusSubtext()).toBe('gpt-5.6-sol · high · 2 subagents: 2x gpt-5.6-sol/medium');

    const listsBeforeEnd = fixture.requests.filter((r) => r.method === 'thread/list').length;
    expect(listsBeforeEnd).toBeGreaterThanOrEqual(1);
    expect(listsBeforeEnd).toBeLessThanOrEqual(2);

    fixture.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    await done;
    expect(events.at(-1)?.type).toBe('result');
  });

  // Review of #1034: a read still in flight when the turn dies on an error
  // path must not write into the roster poll-loop has since cleared, or this
  // turn's workers appear under the NEXT turn's reply.
  it('drops a read that lands after the turn ended on an error', async () => {
    const held: RecordedRequest[] = [];
    const fixture = fakeServer((request) => {
      if (request.method === 'turn/start') return { result: { turn: { id: 'turn-1' } } };
      if (request.method === 'thread/read') return { result: { thread: { status: { type: 'active' } } } };
      if (request.method === 'thread/list') {
        held.push(request);
        return null; // answered by hand below, after the turn is over
      }
      return null;
    });

    const done = (async () => {
      for await (const _event of runOneTurn(
        fixture.server,
        'thread-1',
        'delegate',
        'gpt-5.6-sol',
        '/workspace',
        () => true,
        () => {},
        { currentTurnId: null },
        HEALTH,
      ));
    })();

    await Bun.sleep(5);
    fixture.emit('item/started', childActivity('a-1', 'child-1'));
    await Bun.sleep(5);
    expect(held.length).toBe(1);
    fixture.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' }, items: [] },
    });
    await done.catch(() => {});

    // poll-loop clears the roster at the turn boundary...
    clearSubagents();
    // ...and only then does the orphaned read answer.
    const pending = (fixture.server as unknown as { pending: Map<number, { resolve: (v: never) => void }> }).pending;
    pending.get(held[0].id)?.resolve({
      id: held[0].id,
      result: { data: [{ id: 'child-1', model: 'gpt-5.6-sol', reasoning_effort: 'medium' }] },
    } as never);
    await Bun.sleep(5);

    expect(formatStatusSubtext()).toBe('gpt-5.6-sol · high');
  });
});
