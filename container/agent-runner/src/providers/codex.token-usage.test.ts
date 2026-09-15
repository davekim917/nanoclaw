import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { CodexProvider } from './codex.js';

/**
 * `thread/tokenUsage/updated` fires once per MODEL REQUEST, not once per turn,
 * and carries both `last` (that one request) and `total` (the whole thread).
 * The fake app-server below emits several of them per turn, with the numbers
 * taken from a real codex 0.145.0 rollout log — each `total` difference equals
 * the next record's own `last`.
 *
 * Two failure modes are pinned here, in opposite directions:
 *
 *  - Recording only the FINAL `last` bills a multi-request turn as its last
 *    request: 6,860 output tokens instead of 7,321.
 *  - Recording `total` bills the whole THREAD as one turn on the first turn
 *    after a container respawn, because the delta baseline that would have
 *    subtracted it (turn-usage.ts's module-global memo) died with the old
 *    process while the codex thread did not. The second test is that case.
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

/** One `thread/tokenUsage/updated` payload: `[input, cachedInput, output, reasoning]`. */
type Breakdown = [number, number, number, number];

/** One emitted usage notification. `turnId` defaults to the turn under test. */
type UsageStep = { last: Breakdown; total: Breakdown; turnId?: string };

/**
 * Write a fake codex app-server that emits the given per-request
 * `{ last, total }` pairs inside ONE turn, then completes it.
 */
function writeFakeCodex(binDir: string, steps: UsageStep[]): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'codex'),
    `#!/usr/bin/env bun
import readline from 'readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const breakdown = ([input, cachedInput, output, reasoning]) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cachedInput,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});
const steps = ${JSON.stringify(steps)};

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  // Healthy account snapshot: the provider reads this at every app-server
  // bind (codex-rate-limit-tracker.ts) and would wait out its deadline on a
  // fake that stays silent.
  if (request.method === 'account/rateLimits/read') {
    send({
      id: request.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: 20, windowDurationMins: 10080 },
        },
      },
    });
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
      for (const step of steps) {
        send({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: step.turnId ?? 'turn-1',
            tokenUsage: {
              last: breakdown(step.last),
              total: breakdown(step.total),
              modelContextWindow: 258400,
            },
          },
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
}

/** Run one turn against the fake app-server and return its `result` usage. */
async function runTurnUsage(steps: UsageStep[]): Promise<unknown> {
  const binDir = path.join(tmpDir, 'bin');
  const codexHome = path.join(tmpDir, 'codex-home');
  writeFakeCodex(binDir, steps);
  fs.mkdirSync(codexHome, { recursive: true });

  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '10000';

  const provider = new CodexProvider({ providerConfig: {} });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'run a multi-request turn', cwd: tmpDir });

  let usage: unknown;
  for await (const event of query.events) {
    if (event.type === 'result') {
      usage = event.usage;
      query.end();
    }
  }
  return usage;
}

describe('CodexProvider token usage', () => {
  it('sums every request`s `last` across the turn, not just the final one', async () => {
    const usage = await runTurnUsage([
      { last: [127058, 119552, 305, 77], total: [8116919, 7769856, 25671, 12693] },
      { last: [127391, 126720, 156, 45], total: [8244310, 7896576, 25827, 12738] },
      { last: [129606, 126720, 6860, 2955], total: [8373916, 8023296, 32687, 15693] },
    ]);

    expect(usage).toMatchObject({
      inputTokens: 127058 + 127391 + 129606,
      outputTokens: 305 + 156 + 6860,
      cacheReadTokens: 119552 + 126720 + 126720,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  }, 10_000);

  it('reports only this turn`s requests when a respawned container resumes a long-lived thread', async () => {
    // The regression this pins: a container respawn resumes the PERSISTED
    // codex thread, so the fresh app-server's very first notification already
    // carries the thread's carried-forward `total` (8.3M input here) while
    // `last` is just this turn's one small request. Reporting `total` booked
    // the entire pre-restart thread history as one turn — turn-usage.ts's
    // delta memo is a module global that died with the old process, and its
    // reset check cannot help because the value went UP, not down.
    const usage = await runTurnUsage([{ last: [4210, 3900, 118, 40], total: [8378126, 8027196, 32805, 15733] }]);

    expect(usage).toMatchObject({
      inputTokens: 4210,
      outputTokens: 118,
      cacheReadTokens: 3900,
      cacheWriteTokens: 0,
      costUsd: null,
    });
  }, 10_000);

  it('counts a byte-identical repeat of one usage notification once', async () => {
    // Codex re-emits `thread/tokenUsage/updated` with an identical payload
    // (4,630 adjacent identical pairs over 209 local rollouts). Summing
    // `last` double-counts every repeat; the running counter proves it is a
    // repeat rather than a second request, because a real request advances it.
    const repeated: UsageStep = { last: [127058, 119552, 305, 77], total: [8116919, 7769856, 25671, 12693] };
    const usage = await runTurnUsage([
      repeated,
      repeated,
      { last: [129606, 126720, 6860, 2955], total: [8246525, 7896576, 32531, 15648] },
    ]);

    expect(usage).toMatchObject({
      inputTokens: 127058 + 129606,
      outputTokens: 305 + 6860,
      cacheReadTokens: 119552 + 126720,
    });
  }, 10_000);

  it('ignores a usage notification tagged with a different turn', async () => {
    // `thread/tokenUsage/updated` carries a `turnId` but sits under the
    // `thread/` namespace, which the active-turn filter used to exempt from
    // turn matching entirely. A late, reordered, or replayed-on-resume
    // payload from a PRIOR turn therefore summed into the live turn.
    const usage = await runTurnUsage([
      { last: [999999, 888888, 77777, 6666], total: [8116919, 7769856, 25671, 12693], turnId: 'turn-0' },
      { last: [4210, 3900, 118, 40], total: [8378126, 8027196, 32805, 15733] },
    ]);

    expect(usage).toMatchObject({
      inputTokens: 4210,
      outputTokens: 118,
      cacheReadTokens: 3900,
    });
  }, 10_000);

  it('leaves usage undefined when the app-server reported no token usage at all', async () => {
    // A coverage gap must stay visible as a NULL-token row (see TurnUsageInfo),
    // never as a fabricated all-zero turn.
    expect(await runTurnUsage([])).toBeUndefined();
  }, 10_000);
});
