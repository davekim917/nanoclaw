/**
 * End-to-end through CodexProvider.gen() against a fake `codex` app-server:
 * the account snapshot is read at bind, a parked account never starts a turn,
 * a spare CODEX_HOME is drained first, and a healthy turn's result carries the
 * weekly window for turn_usage. Subprocess use is the same fake-binary pattern
 * as codex.recovery-integration.test.ts; nothing touches the network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getRateLimitSampleRows } from '../modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { CodexProvider } from './codex.js';

const ORIGINAL_ENV = {
  PATH: process.env.PATH,
  CODEX_HOME: process.env.CODEX_HOME,
  CODEX_FALLBACK_HOMES: process.env.CODEX_FALLBACK_HOMES,
  CODEX_HEALTH_PROBE_QUIET_MS: process.env.CODEX_HEALTH_PROBE_QUIET_MS,
  CODEX_HEALTH_PROBE_INTERVAL_MS: process.env.CODEX_HEALTH_PROBE_INTERVAL_MS,
  CODEX_HEALTH_PROBE_TIMEOUT_MS: process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS,
  FAKE_CODEX_STATE: process.env.FAKE_CODEX_STATE,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_CODEX_WEEKLY_BY_INSTANCE: process.env.FAKE_CODEX_WEEKLY_BY_INSTANCE,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const RESET_S = 1789603200;
const RESET_ISO = '2026-09-17T00:00:00.000Z';

let tmpDir = '';

beforeEach(() => {
  initTestSessionDb();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rate-limit-park-'));
});

afterEach(() => {
  closeSessionDb();
  restoreEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Fake app-server. `FAKE_CODEX_WEEKLY_BY_INSTANCE` is a comma list of weekly
 * usedPercent per spawned instance (instance 1 first), so a test can make the
 * primary account look spent and the fallback fresh.
 */
function writeFakeCodex(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
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
const weeklyByInstance = (process.env.FAKE_CODEX_WEEKLY_BY_INSTANCE ?? '20').split(',').map(Number);
const weekly = weeklyByInstance[Math.min(instance, weeklyByInstance.length) - 1];

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
  if (request.method === 'account/rateLimits/read') {
    send({
      id: request.id,
      result: {
        accountId: 'acct-' + instance,
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: ${RESET_S} },
          planType: 'pro',
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
    send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress', items: [] } } });
    setTimeout(() => {
      // A sparse rolling push mid-turn: only the weekly window, one point up.
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { secondary: { usedPercent: weekly + 1, windowDurationMins: 10080, resetsAt: ${RESET_S} } } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId, delta: 'turn result' } });
      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } } });
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
  if (request.method === 'turn/interrupt') send({ id: request.id, result: {} });
});
`,
    { mode: 0o755 },
  );
}

interface Run {
  events: Array<Record<string, unknown> & { type: string }>;
  requests: Array<{ instance: number; method: string; params?: Record<string, unknown> }>;
  spawned: number;
}

async function run(opts: { weeklyByInstance: string; fallbackHomes?: string[] }): Promise<Run> {
  const binDir = path.join(tmpDir, 'bin');
  const codexHome = path.join(tmpDir, 'codex-home');
  const statePath = path.join(tmpDir, 'spawn-count');
  const logPath = path.join(tmpDir, 'requests.jsonl');
  writeFakeCodex(binDir);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-from-auth' } }));

  process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  process.env.CODEX_HOME = codexHome;
  if (opts.fallbackHomes) process.env.CODEX_FALLBACK_HOMES = opts.fallbackHomes.join(':');
  else delete process.env.CODEX_FALLBACK_HOMES;
  process.env.FAKE_CODEX_STATE = statePath;
  process.env.FAKE_CODEX_LOG = logPath;
  process.env.FAKE_CODEX_WEEKLY_BY_INSTANCE = opts.weeklyByInstance;
  process.env.CODEX_HEALTH_PROBE_QUIET_MS = '60000';
  process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '1000';
  process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '1000';

  const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'medium' } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'do the task', cwd: tmpDir });
  const events: Run['events'] = [];
  for await (const event of query.events) {
    events.push(event as Run['events'][number]);
    if (event.type === 'result' || (event.type === 'error' && !event.retryable)) query.end();
  }
  const requests = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Run['requests'][number])
    : [];
  return { events, requests, spawned: Number(fs.readFileSync(statePath, 'utf8')) };
}

describe('Codex rate-limit read → park through gen()', () => {
  it('reads the snapshot at bind, runs a healthy turn, stamps the weekly window on the result and records pull + push rows', async () => {
    const { events, requests, spawned } = await run({ weeklyByInstance: '20' });
    expect(spawned).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const read = requests.find((r) => r.method === 'account/rateLimits/read');
    expect(read?.params).toEqual({ excludeResetCreditDetails: true });
    // The read precedes the thread and the turn — the park decision is made before either.
    const order = requests.map((r) => r.method);
    expect(order.indexOf('account/rateLimits/read')).toBeLessThan(order.indexOf('thread/start'));

    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      text: 'turn result',
      // The push mid-turn moved the weekly window to 21%; the result carries the latest snapshot.
      rateLimit: { type: 'seven_day', utilization: 0.21, resetsAt: RESET_ISO },
    });

    const rows = getRateLimitSampleRows();
    expect(
      rows.map((r) => [r.source, r.limit_type, r.utilization, r.account, r.credential_set, r.subscription_type]),
    ).toEqual([
      ['usage_pull', 'five_hour', 0.1, 'acct-1', 'codex:codex-home', 'pro'],
      ['usage_pull', 'seven_day', 0.2, 'acct-1', 'codex:codex-home', 'pro'],
      ['rate_limit_event', 'seven_day', 0.21, 'acct-1', 'codex:codex-home', 'pro'],
    ]);
    expect(rows[1]?.resets_at).toBe(RESET_ISO);
  }, 5_000);

  it('a spent primary with no spare CODEX_HOME never starts a turn: one quota error carrying the measured reset', async () => {
    const { events, requests, spawned } = await run({ weeklyByInstance: '92' });
    expect(spawned).toBe(1);
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(0);
    const error = events.find((e) => e.type === 'error');
    expect(error).toEqual({
      type: 'error',
      retryable: false,
      classification: 'quota',
      resetAt: RESET_ISO,
      message: `Codex rate limit [seven_day] 92% used, at or past the 90% park threshold (resets ${RESET_ISO})`,
    });
    // The reading that caused the park is on record for the fleet to see.
    expect(getRateLimitSampleRows().map((r) => [r.limit_type, r.utilization])).toEqual([
      ['five_hour', 0.1],
      ['seven_day', 0.92],
    ]);
  }, 5_000);

  it('a spent primary with a spare CODEX_HOME rotates to it and completes there, each account sampled under its own slot', async () => {
    const fallbackHome = path.join(tmpDir, 'codex-fallback-1');
    fs.mkdirSync(fallbackHome, { recursive: true });
    const { events, requests, spawned } = await run({ weeklyByInstance: '95,30', fallbackHomes: [fallbackHome] });
    expect(spawned).toBe(2);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      events.some((e) => e.type === 'progress' && String(e.message).includes('Codex OAuth rotating (quota)')),
    ).toBe(true);
    // Instance 1 was parked before any turn; instance 2 ran the one turn.
    const starts = requests.filter((r) => r.method === 'turn/start');
    expect(starts.map((r) => r.instance)).toEqual([2]);
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      rateLimit: { type: 'seven_day', utilization: 0.31, resetsAt: RESET_ISO },
    });
    const pulls = getRateLimitSampleRows().filter((r) => r.source === 'usage_pull' && r.limit_type === 'seven_day');
    expect(pulls.map((r) => [r.account, r.credential_set, r.utilization])).toEqual([
      ['acct-1', 'codex:codex-home', 0.95],
      ['acct-2', 'codex:codex-fallback-1', 0.3],
    ]);
  }, 5_000);
});
