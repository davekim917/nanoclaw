import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { CodexProvider } from './codex.js';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_HEALTH_PROBE_QUIET_MS: process.env.CODEX_HEALTH_PROBE_QUIET_MS,
  CODEX_HEALTH_PROBE_INTERVAL_MS: process.env.CODEX_HEALTH_PROBE_INTERVAL_MS,
  CODEX_HEALTH_PROBE_TIMEOUT_MS: process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS,
  CODEX_HEALTH_PROBE_FAILURE_LIMIT: process.env.CODEX_HEALTH_PROBE_FAILURE_LIMIT,
  CODEX_INACTIVE_SNAPSHOT_LIMIT: process.env.CODEX_INACTIVE_SNAPSHOT_LIMIT,
  CODEX_HEALTH_STILL_WORKING_NOTICE_MS: process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS,
  FAKE_CODEX_STATE: process.env.FAKE_CODEX_STATE,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_CODEX_FAILURE_MODE: process.env.FAKE_CODEX_FAILURE_MODE,
  CODEX_PRIMARY_HOST_HOME: process.env.CODEX_PRIMARY_HOST_HOME,
  CODEX_FALLBACK_HOMES: process.env.CODEX_FALLBACK_HOMES,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

let tmpDir = '';

beforeEach(() => {
  initTestSessionDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recovery-'));
});

afterEach(() => {
  closeSessionDb();
  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodexProvider app-server-only recovery', () => {
  for (const scenario of [
    {
      failureMode: 'unresponsive',
      title:
        'replaces an unresponsive app-server, resumes the same thread, and continues without duplicating the prompt',
    },
    {
      failureMode: 'unfinished-command',
      title:
        'replaces an app-server that completes with an unfinished command and resumes without duplicating the prompt',
    },
  ] as const) {
    it(
      scenario.title,
      async () => {
        const binDir = path.join(tmpDir, 'bin');
        const codexHome = path.join(tmpDir, 'codex-home');
        const statePath = path.join(tmpDir, 'spawn-count');
        const logPath = path.join(tmpDir, 'requests.jsonl');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(codexHome, { recursive: true });

        const fakeCodexPath = path.join(binDir, 'codex');
        fs.writeFileSync(
          fakeCodexPath,
          `#!/usr/bin/env bun
import fs from 'fs';
import readline from 'readline';

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const failureMode = process.env.FAKE_CODEX_FAILURE_MODE;
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const instance = previous + 1;
fs.writeFileSync(statePath, String(instance));

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (value) => fs.appendFileSync(logPath, JSON.stringify({ instance, ...value }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  // verifyCodexHookTrust (codex-companion-setup.ts) refuses the spawn unless
  // every generated guard handler reads back dispatchable. The provider writes
  // hooks.json AND its trust entries immediately before each spawn, so a
  // faithful fake reports exactly those two handlers trusted and enabled —
  // which is what a real codex 0.154.0 does against the same home (measured).
  if (request.method === 'hooks/list') {
    const home = process.env.CODEX_HOME || (process.env.HOME || '/home/node') + '/.codex';
    const hooksPath = home + '/hooks.json';
    const rows = ['pre_tool_use', 'post_tool_use'].map((event, index) => ({
      key: hooksPath + ':' + event + ':0:0',
      eventName: event,
      handlerType: 'command',
      sourcePath: hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: index,
      enabled: true,
      isManaged: false,
      trustStatus: 'trusted',
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
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
  if (request.method === 'thread/start') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'thread/resume') {
    send({ id: request.id, result: { thread: { id: 'thread-1', status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'turn/start') {
    send({ id: request.id, result: { turn: { id: 'turn-' + instance } } });
    send({
      method: 'turn/started',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-' + instance, status: 'inProgress', items: [] },
      },
    });
    if (instance === 1 && failureMode === 'unfinished-command') {
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-' + instance,
            item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: 'turn-' + instance,
              status: 'completed',
              items: [{ id: 'command-1', type: 'commandExecution', status: 'inProgress' }],
            },
          },
        });
      }, 5);
    }
    if (instance > 1) {
      setTimeout(() => {
        send({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-' + instance,
            delta: 'recovered result',
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-' + instance, status: 'completed', items: [] },
          },
        });
      }, 5);
    }
    return;
  }
  if (request.method === 'thread/read') {
    if (instance > 1) send({ id: request.id, result: { thread: { status: { type: 'active' } } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
  }
});
`,
          { mode: 0o755 },
        );

        process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
        process.env.CODEX_HOME = codexHome;
        process.env.FAKE_CODEX_STATE = statePath;
        process.env.FAKE_CODEX_LOG = logPath;
        process.env.FAKE_CODEX_FAILURE_MODE = scenario.failureMode;
        process.env.CODEX_HEALTH_PROBE_QUIET_MS = '5';
        process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '5';
        process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '5';
        process.env.CODEX_HEALTH_PROBE_FAILURE_LIMIT = '2';
        process.env.CODEX_INACTIVE_SNAPSHOT_LIMIT = '2';
        process.env.CODEX_HEALTH_STILL_WORKING_NOTICE_MS = '1000';

        const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'ultra' } });
        provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
        const query = provider.query({ prompt: 'perform the original task once', cwd: tmpDir });
        const events: Array<{ type: string; text?: string | null; message?: string }> = [];
        for await (const event of query.events) {
          events.push(event);
          if (event.type === 'result') query.end();
        }

        expect(fs.readFileSync(statePath, 'utf8')).toBe('2');
        expect(
          events.some((event) => event.type === 'progress' && event.message?.includes('restarting app-server')),
        ).toBe(true);
        expect(events.find((event) => event.type === 'result')).toMatchObject({
          type: 'result',
          text: 'recovered result',
        });
        expect(events.some((event) => event.type === 'error')).toBe(false);

        const requests = fs
          .readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map(
            (line) =>
              JSON.parse(line) as { instance: number; method: string; params?: { input?: Array<{ text?: string }> } },
          );
        const starts = requests.filter((request) => request.method === 'turn/start');
        expect(starts).toHaveLength(2);
        expect(starts[0]?.params?.input?.[0]?.text).toBe('perform the original task once');
        expect(starts[1]?.params?.input?.[0]?.text).toContain(
          'Continue the same user request from the persisted thread state',
        );
        expect(starts[1]?.params?.input?.[0]?.text).not.toContain('perform the original task once');
        expect(requests.some((request) => request.instance === 2 && request.method === 'thread/resume')).toBe(true);
      },
      5_000,
    );
  }
});

it('runs a third no-fallback attempt after control-plane recovery and same-thread primary-auth refresh', async () => {
  const binDir = path.join(tmpDir, 'bin');
  const codexHome = path.join(tmpDir, 'codex-home');
  const hostCodexHome = path.join(tmpDir, 'host-codex-home');
  const statePath = path.join(tmpDir, 'spawn-count');
  const logPath = path.join(tmpDir, 'requests.jsonl');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(hostCodexHome, { recursive: true });
  fs.writeFileSync(path.join(hostCodexHome, 'auth.json'), '{"access_token":"fresh"}');

  fs.writeFileSync(
    path.join(binDir, 'codex'),
    `#!/usr/bin/env bun
import fs from 'fs';
import readline from 'readline';

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const instance = previous + 1;
fs.writeFileSync(statePath, String(instance));

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (value) => fs.appendFileSync(logPath, JSON.stringify({ instance, ...value }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  // verifyCodexHookTrust (codex-companion-setup.ts) refuses the spawn unless
  // every generated guard handler reads back dispatchable. The provider writes
  // hooks.json AND its trust entries immediately before each spawn, so a
  // faithful fake reports exactly those two handlers trusted and enabled —
  // which is what a real codex 0.154.0 does against the same home (measured).
  if (request.method === 'hooks/list') {
    const home = process.env.CODEX_HOME || (process.env.HOME || '/home/node') + '/.codex';
    const hooksPath = home + '/hooks.json';
    const rows = ['pre_tool_use', 'post_tool_use'].map((event, index) => ({
      key: hooksPath + ':' + event + ':0:0',
      eventName: event,
      handlerType: 'command',
      sourcePath: hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: index,
      enabled: true,
      isManaged: false,
      trustStatus: 'trusted',
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
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
    const turnId = 'turn-' + instance;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [] } },
    });
    setTimeout(() => {
      if (instance === 1) {
        send({
          method: 'item/started',
          params: {
            threadId: 'thread-1', turnId,
            item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: turnId,
              status: 'completed',
              items: [{ id: 'command-1', type: 'commandExecution', status: 'inProgress' }],
            },
          },
        });
      } else if (instance === 2) {
        send({ method: 'thread/status/changed', params: { threadId: 'thread-1', status: { type: 'systemError' } } });
      } else {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, delta: 'third-attempt result' },
        });
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } },
        });
      }
    }, 5);
    return;
  }
  if (request.method === 'thread/read') {
    send({ id: request.id, result: { thread: { status: { type: 'active' } } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
  }
});
`,
    { mode: 0o755 },
  );

  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_PRIMARY_HOST_HOME = hostCodexHome;
  delete process.env.CODEX_FALLBACK_HOMES;
  process.env.FAKE_CODEX_STATE = statePath;
  process.env.FAKE_CODEX_LOG = logPath;
  process.env.CODEX_HEALTH_PROBE_QUIET_MS = '60000';
  process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '1000';
  process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '1000';

  const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'ultra' } });
  expect(provider.fallbackHomes).toEqual([]);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'perform the original task once', cwd: tmpDir });
  const events: Array<{ type: string; text?: string | null }> = [];
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'result') query.end();
  }

  expect(fs.readFileSync(statePath, 'utf8')).toBe('3');
  expect(events.find((event) => event.type === 'result')).toMatchObject({ text: 'third-attempt result' });
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toBe('{"access_token":"fresh"}');

  const starts = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { method: string; params?: { input?: Array<{ text?: string }> } })
    .filter((request) => request.method === 'turn/start');
  expect(starts).toHaveLength(3);
  expect(starts[0]?.params?.input?.[0]?.text).toBe('perform the original task once');
  expect(starts[1]?.params?.input?.[0]?.text).toContain(
    'Continue the same user request from the persisted thread state',
  );
  expect(starts[2]?.params?.input?.[0]?.text).toContain(
    'Continue the same user request from the persisted thread state',
  );
  expect(
    starts.slice(1).every((start) => !start.params?.input?.[0]?.text?.includes('perform the original task once')),
  ).toBe(true);
}, 5_000);

// Cost attribution across the outer retry loop. One logical turn can span
// several runOneTurn invocations, and EVERY attempt is billed: the provider
// charged for the requests the failed attempt made, and the retry's requests
// are distinct requests, so the turn total is their sum. That holds whether the
// retry resumed the same thread or started a fresh one.
//
// The contract used to be the opposite for the fresh-thread case: the
// accumulator was recreated, on the stated grounds that keeping it "would
// double-count". It would not — the same tokens are never added twice — so the
// reset simply dropped spend the meter had already been billed for. Changed
// deliberately; the two dedupe guards below are what stop a genuine
// double-count, and they are unchanged.
describe('CodexProvider usage accounting across a recovery retry', () => {
  for (const scenario of [
    {
      resumeStale: false,
      title: 'same-thread retry keeps the pre-crash requests in the turn total',
      // 100/10/5/2 before the desync + 200/20/7/3 after the resume.
      expected: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 5 },
      // 2 item/completed before the desync + 1 after.
      expectedSteps: 3,
    },
    {
      resumeStale: true,
      title: 'fresh-thread retry carries the failed attempt forward (its tokens were billed)',
      // The original request is re-sent against thread-2, and thread-1's
      // requests were still paid for: 100/10/5/2 + 200/20/7/3.
      expected: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 5 },
      // 2 item/completed on the dead thread + 1 on the fresh one.
      expectedSteps: 3,
    },
    {
      resumeStale: true,
      replay: true,
      title: "fresh-thread retry counts a request whose payload matches the dead thread's",
      // The dedupe guards are thread-scoped and must NOT survive the switch. A
      // fresh thread's first payload is `{last: X, total: X}` — the same shape
      // the dead thread's first payload had — and the re-sent prompt makes the
      // counts likely to match byte-for-byte. That is a genuine second request,
      // not a repeat, so it books: 100/10/5/2 + 100/10/5/2 + 200/20/7/3.
      // Carrying `lastUsageKey` across the switch suppresses it (300/30/12/5),
      // and carrying `countedItemIds` re-suppresses `done-a` (3 steps).
      expected: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 17, cacheWriteTokens: 7 },
      expectedSteps: 4,
    },
    {
      resumeStale: false,
      replay: true,
      title: 'same-thread retry ignores records the resumed app-server replays',
      // Identical to the plain same-thread case: the replayed usage payload
      // and the replayed item/completed must add nothing. Without the guards
      // this books 400/40/17/7 and 4 steps.
      expected: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 5 },
      expectedSteps: 3,
    },
  ] as const) {
    it(
      scenario.title,
      async () => {
        const binDir = path.join(tmpDir, 'bin');
        const codexHome = path.join(tmpDir, 'codex-home');
        const statePath = path.join(tmpDir, 'spawn-count');
        const logPath = path.join(tmpDir, 'requests.jsonl');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(codexHome, { recursive: true });

        // Instance 1 reports one model request's usage, then completes the turn
        // with an unfinished command item — a protocol_desync the provider
        // recovers from by respawning app-server and re-resuming. Instance 2
        // reports a second request's usage and finishes.
        fs.writeFileSync(
          path.join(binDir, 'codex'),
          `#!/usr/bin/env bun
import fs from 'fs';
import readline from 'readline';

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const resumeStale = process.env.FAKE_CODEX_RESUME_STALE === '1';
const replay = process.env.FAKE_CODEX_REPLAY === '1';
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const instance = previous + 1;
fs.writeFileSync(statePath, String(instance));

let currentThread = 'thread-1';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (value) => fs.appendFileSync(logPath, JSON.stringify({ instance, ...value }) + '\\n');
const usage = (last, total) =>
  send({ method: 'thread/tokenUsage/updated', params: { threadId: currentThread, tokenUsage: { last, total } } });

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  // verifyCodexHookTrust (codex-companion-setup.ts) refuses the spawn unless
  // every generated guard handler reads back dispatchable. The provider writes
  // hooks.json AND its trust entries immediately before each spawn, so a
  // faithful fake reports exactly those two handlers trusted and enabled —
  // which is what a real codex 0.154.0 does against the same home (measured).
  if (request.method === 'hooks/list') {
    const home = process.env.CODEX_HOME || (process.env.HOME || '/home/node') + '/.codex';
    const hooksPath = home + '/hooks.json';
    const rows = ['pre_tool_use', 'post_tool_use'].map((event, index) => ({
      key: hooksPath + ':' + event + ':0:0',
      eventName: event,
      handlerType: 'command',
      sourcePath: hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: index,
      enabled: true,
      isManaged: false,
      trustStatus: 'trusted',
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
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
  if (request.method === 'thread/resume') {
    if (resumeStale) {
      send({ id: request.id, error: { code: -32000, message: 'thread not found' } });
      return;
    }
    currentThread = 'thread-1';
    send({ id: request.id, result: { thread: { id: currentThread, status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'thread/start') {
    currentThread = 'thread-' + instance;
    send({ id: request.id, result: { thread: { id: currentThread, status: { type: 'idle' } } } });
    return;
  }
  if (request.method === 'turn/start') {
    const turnId = 'turn-' + instance;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({
      method: 'turn/started',
      params: { threadId: currentThread, turn: { id: turnId, status: 'inProgress', items: [] } },
    });
    setTimeout(() => {
      if (instance === 1) {
        usage(
          { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 2 },
          { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 2 },
        );
        for (const id of ['done-a', 'done-b']) {
          send({
            method: 'item/completed',
            params: { threadId: currentThread, turnId, item: { id, type: 'commandExecution', status: 'completed' } },
          });
        }
        send({
          method: 'item/started',
          params: {
            threadId: currentThread,
            turnId,
            item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
          },
        });
        send({
          method: 'turn/completed',
          params: {
            threadId: currentThread,
            turn: {
              id: turnId,
              status: 'completed',
              items: [{ id: 'command-1', type: 'commandExecution', status: 'inProgress' }],
            },
          },
        });
        return;
      }
      if (replay) {
        // A resumed app-server re-emitting the last pre-crash records:
        // byte-identical usage, and an item/completed already counted.
        usage(
          { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 2 },
          { inputTokens: 100, outputTokens: 10, cachedInputTokens: 5, cacheWriteInputTokens: 2 },
        );
        send({
          method: 'item/completed',
          params: {
            threadId: currentThread,
            turnId,
            item: { id: 'done-a', type: 'commandExecution', status: 'completed' },
          },
        });
      }
      usage(
        { inputTokens: 200, outputTokens: 20, cachedInputTokens: 7, cacheWriteInputTokens: 3 },
        { inputTokens: 300, outputTokens: 30, cachedInputTokens: 12, cacheWriteInputTokens: 5 },
      );
      send({
        method: 'item/completed',
        params: {
          threadId: currentThread,
          turnId,
          item: { id: 'msg-1', type: 'agentMessage', text: 'recovered result' },
        },
      });
      send({
        method: 'turn/completed',
        params: { threadId: currentThread, turn: { id: turnId, status: 'completed', items: [] } },
      });
    }, 5);
    return;
  }
  if (request.method === 'thread/read') {
    send({ id: request.id, result: { thread: { status: { type: 'active' } } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
  }
});
`,
          { mode: 0o755 },
        );

        process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
        process.env.CODEX_HOME = codexHome;
        process.env.FAKE_CODEX_STATE = statePath;
        process.env.FAKE_CODEX_LOG = logPath;
        process.env.FAKE_CODEX_RESUME_STALE = scenario.resumeStale ? '1' : '0';
        process.env.FAKE_CODEX_REPLAY = 'replay' in scenario && scenario.replay ? '1' : '0';
        // Long quiet window: the desync is raised by turn/completed itself, so
        // the liveness probe must not race in and reclassify the failure.
        process.env.CODEX_HEALTH_PROBE_QUIET_MS = '60000';
        process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '1000';
        process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '1000';

        const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'ultra' } });
        provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
        const query = provider.query({ prompt: 'perform the original task once', cwd: tmpDir });
        const events: Array<{
          type: string;
          usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
          steps?: number | null;
        }> = [];
        for await (const event of query.events) {
          events.push(event as (typeof events)[number]);
          if (event.type === 'result') query.end();
        }

        // Two app-server instances ⇒ the retry really happened.
        expect(fs.readFileSync(statePath, 'utf8')).toBe('2');
        expect(events.some((event) => event.type === 'error')).toBe(false);
        const result = events.find((event) => event.type === 'result');
        expect(result?.usage).toMatchObject(scenario.expected);
        // `steps` shares the accumulator, so it must carry and reset identically.
        expect(result?.steps).toBe(scenario.expectedSteps);
      },
      5_000,
    );
  }
});

// The original blocker this whole accumulator design exists to prevent: codex's
// `thread/tokenUsage/updated.total` is THREAD-scoped and survives a container
// respawn, so a resumed thread replays a carried-forward total. Only `last` is
// ever read, so a fresh container's first turn bills its own requests, not the
// thread's history.
describe('codex usage stays container-respawn safe', () => {
  // NOT the load-bearing test. This is a lint over source text: it catches a
  // literal revert to `tokenUsage.total`, and nothing else — a destructure or
  // a rename sails past it. The behavioural guard is
  // `codex.token-usage.test.ts` > 'reports only this turn`s requests when a
  // respawned container resumes a long-lived thread', which drives a fake
  // app-server carrying a thread-scoped total and asserts the turn bills only
  // its own requests. Delete THAT and this grep protects nothing.
  it('reads only tokenUsage.last, never tokenUsage.total', () => {
    const src = fs.readFileSync(new URL('./codex.ts', import.meta.url), 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const i = line.indexOf('//');
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join('\n');
    expect(codeOnly).toContain('tokenUsage?.last');
    expect(codeOnly).not.toMatch(/tokenUsage\??\.total/);
  });
});

// Deliverable A (Codex side): a credential-exhaustion turn rotates to the
// fallback CODEX_HOME and tells the resumed thread explicitly that its
// credential was swapped (mirrors claude.ts's poll-loop rotation notice, via
// the shared `formatCredentialRotationNotice` helper — codex.ts:1535-1540
// appends it to whatever `resolveCodexRestartTransition` (called at
// codex.ts:1519) produces for the resumed/restarted thread). No persistence
// here: the ring's active home is `process.env.CODEX_HOME` (see the doc
// comment on `CodexProvider.rotateCodexHome` in codex.ts), so a container
// respawn starts on the primary.
describe('CodexProvider OAuth-rotation notice', () => {
  it('rotates on UsageLimitExceeded and tells the resumed thread it was rotated', async () => {
    const binDir = path.join(tmpDir, 'bin');
    const codexHome = path.join(tmpDir, 'codex-home');
    const fallbackHome = path.join(tmpDir, 'codex-fallback');
    const statePath = path.join(tmpDir, 'spawn-count');
    const logPath = path.join(tmpDir, 'requests.jsonl');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });

    // Instance 1 fails its turn with a structured UsageLimitExceeded — the
    // exact shape `classifyCodexError` maps to classification 'quota',
    // which `isCodexOAuthRotationEligible` treats as rotation-eligible.
    // Instance 2 (spawned on the fallback CODEX_HOME) completes normally.
    fs.writeFileSync(
      path.join(binDir, 'codex'),
      `#!/usr/bin/env bun
import fs from 'fs';
import readline from 'readline';

const statePath = process.env.FAKE_CODEX_STATE;
const logPath = process.env.FAKE_CODEX_LOG;
const previous = fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, 'utf8')) : 0;
const instance = previous + 1;
fs.writeFileSync(statePath, String(instance));

const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const log = (value) => fs.appendFileSync(logPath, JSON.stringify({ instance, ...value }) + '\\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  log({ method: request.method, params: request.params });
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  // verifyCodexHookTrust (codex-companion-setup.ts) refuses the spawn unless
  // every generated guard handler reads back dispatchable. The provider writes
  // hooks.json AND its trust entries immediately before each spawn, so a
  // faithful fake reports exactly those two handlers trusted and enabled —
  // which is what a real codex 0.154.0 does against the same home (measured).
  if (request.method === 'hooks/list') {
    const home = process.env.CODEX_HOME || (process.env.HOME || '/home/node') + '/.codex';
    const hooksPath = home + '/hooks.json';
    const rows = ['pre_tool_use', 'post_tool_use'].map((event, index) => ({
      key: hooksPath + ':' + event + ':0:0',
      eventName: event,
      handlerType: 'command',
      sourcePath: hooksPath,
      source: 'user',
      pluginId: null,
      displayOrder: index,
      enabled: true,
      isManaged: false,
      trustStatus: 'trusted',
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
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
    const turnId = 'turn-' + instance;
    send({ id: request.id, result: { turn: { id: turnId } } });
    send({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [] } },
    });
    setTimeout(() => {
      if (instance === 1) {
        send({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: {
              id: turnId,
              status: 'failed',
              items: [],
              error: { message: 'usage limit reached', codexErrorInfo: { type: 'UsageLimitExceeded' } },
            },
          },
        });
      } else {
        send({
          method: 'item/agentMessage/delta',
          params: { threadId: 'thread-1', turnId, delta: 'recovered result' },
        });
        send({
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } },
        });
      }
    }, 5);
    return;
  }
  if (request.method === 'thread/read') {
    send({ id: request.id, result: { thread: { status: { type: 'active' } } } });
    return;
  }
  if (request.method === 'thread/list') {
    send({ id: request.id, result: { data: [] } });
    return;
  }
  if (request.method === 'turn/interrupt') {
    send({ id: request.id, result: {} });
  }
});
`,
      { mode: 0o755 },
    );

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_FALLBACK_HOMES = fallbackHome;
    process.env.FAKE_CODEX_STATE = statePath;
    process.env.FAKE_CODEX_LOG = logPath;
    process.env.CODEX_HEALTH_PROBE_QUIET_MS = '60000';
    process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '1000';
    process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '1000';

    const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'ultra' } });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'perform the original task once', cwd: tmpDir });
    const events: Array<{ type: string; text?: string | null; message?: string }> = [];
    for await (const event of query.events) {
      events.push(event);
      if (event.type === 'result') query.end();
    }

    expect(fs.readFileSync(statePath, 'utf8')).toBe('2');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'progress' && event.message?.includes('Codex OAuth rotating'))).toBe(
      true,
    );
    expect(events.find((event) => event.type === 'result')).toMatchObject({
      type: 'result',
      text: 'recovered result',
    });

    const requests = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { instance: number; method: string; params?: { input?: Array<{ text?: string }> } },
      );
    const starts = requests.filter((request) => request.method === 'turn/start');
    expect(starts).toHaveLength(2);
    expect(starts[0]?.params?.input?.[0]?.text).toBe('perform the original task once');
    // Rotation is eligible on a resumed thread here (thread/resume succeeds),
    // so the resumed prompt is the short recovery nudge — NOT the original
    // request — plus the rotation notice appended after it.
    const secondPromptText = starts[1]?.params?.input?.[0]?.text ?? '';
    expect(secondPromptText).toContain('Continue the same user request from the persisted thread state');
    expect(secondPromptText).toContain('<runner-credential-rotation>');
    expect(secondPromptText).toContain('slot 2 of 2');
    expect(secondPromptText).toContain('does not apply to this attempt');
    expect(secondPromptText).not.toContain('perform the original task once');

    // Live rotation still takes effect immediately (this is NOT persistence
    // — the same process's CODEX_HOME env just reflects the in-memory
    // rotation the running turn performed).
    expect(process.env.CODEX_HOME).toBe(fallbackHome);
  }, 5_000);
});
