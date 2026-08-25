import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { CodexProvider } from './codex.js';

/**
 * `thread/tokenUsage/updated` fires once per MODEL REQUEST, not once per turn.
 * The fake app-server below emits three of them for a single turn, with the
 * numbers taken from a real codex 0.145.0 rollout log: each notification's
 * `last` is one request, and `total` is the thread's running total, whose
 * successive differences equal those `last` values.
 *
 * Recording `last` (what this provider used to do) bills a whole multi-request
 * turn as its final request — 6,860 output tokens instead of 32,687. The
 * result event must carry `total`.
 */
const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_HEALTH_STILL_WORKING_NOTICE_MS: process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS,
};

let tmpDir = '';

beforeEach(() => {
  initTestSessionDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-usage-'));
});

afterEach(() => {
  closeSessionDb();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodexProvider token usage', () => {
  it('reports the thread-cumulative `total`, not the final request`s `last`', async () => {
    const binDir = path.join(tmpDir, 'bin');
    const codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });

    fs.writeFileSync(
      path.join(binDir, 'codex'),
      `#!/usr/bin/env bun
import readline from 'readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const breakdown = (input, cachedInput, output, reasoning) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cachedInput,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (request.method === 'thread/start' || request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn-1' } } });
    send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress', items: [] } },
    });
    setTimeout(() => {
      // Three model requests inside ONE turn.
      const steps = [
        { last: breakdown(127058, 119552, 305, 77), total: breakdown(8116919, 7769856, 25671, 12693) },
        { last: breakdown(127391, 126720, 156, 45), total: breakdown(8244310, 7896576, 25827, 12738) },
        { last: breakdown(129606, 126720, 6860, 2955), total: breakdown(8373916, 8023296, 32687, 15693) },
      ];
      for (const step of steps) {
        send({
          method: 'thread/tokenUsage/updated',
          params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { ...step, modelContextWindow: 258400 } },
        });
      }
      send({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'done' },
      });
      send({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } },
      });
    }, 5);
    return;
  }
  if (request.method === 'thread/read') return;
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') send({ id: request.id, result: {} });
});
`,
      { mode: 0o755 },
    );

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '10000';

    const provider = new CodexProvider({ providerConfig: {} });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'run a multi-request turn', cwd: tmpDir });

    let result: { type: string; usage?: unknown } | undefined;
    for await (const event of query.events) {
      if (event.type === 'result') {
        result = event;
        query.end();
      }
    }

    expect(result?.usage).toMatchObject({
      inputTokens: 8_373_916,
      outputTokens: 32_687,
      cacheReadTokens: 8_023_296,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  }, 10_000);
});
