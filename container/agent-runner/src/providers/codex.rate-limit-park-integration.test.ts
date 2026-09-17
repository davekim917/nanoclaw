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
  FAKE_CODEX_UNTRUSTED_HOME_MATCH: process.env.FAKE_CODEX_UNTRUSTED_HOME_MATCH,
  CODEX_HEALTH_PROBE_QUIET_MS: process.env.CODEX_HEALTH_PROBE_QUIET_MS,
  CODEX_HEALTH_PROBE_INTERVAL_MS: process.env.CODEX_HEALTH_PROBE_INTERVAL_MS,
  CODEX_HEALTH_PROBE_TIMEOUT_MS: process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS,
  FAKE_CODEX_STATE: process.env.FAKE_CODEX_STATE,
  FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
  FAKE_CODEX_WEEKLY_BY_INSTANCE: process.env.FAKE_CODEX_WEEKLY_BY_INSTANCE,
  FAKE_CODEX_RESET_BY_INSTANCE: process.env.FAKE_CODEX_RESET_BY_INSTANCE,
  FAKE_CODEX_PUSH_WEEKLY_BY_INSTANCE: process.env.FAKE_CODEX_PUSH_WEEKLY_BY_INSTANCE,
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
 * primary account look spent and the fallback fresh. `FAKE_CODEX_RESET_BY_INSTANCE`
 * is the matching list of weekly `resetsAt` epoch seconds (default RESET_S), so
 * two spent accounts can state different resets.
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
const resetByInstance = (process.env.FAKE_CODEX_RESET_BY_INSTANCE ?? '${RESET_S}').split(',').map(Number);
const resetS = resetByInstance[Math.min(instance, resetByInstance.length) - 1];
// The weekly usedPercent this instance PUSHES mid-turn (default: one point up).
// A push past the park threshold makes the NEXT turn on this same app-server park.
const pushByInstance = (process.env.FAKE_CODEX_PUSH_WEEKLY_BY_INSTANCE ?? '').split(',').map(Number);
const pushedRaw = pushByInstance[instance - 1];
const pushWeekly = Number.isFinite(pushedRaw) && pushedRaw > 0 ? pushedRaw : weekly + 1;

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
    // FAKE_CODEX_UNTRUSTED_HOME_MATCH models the silent failure: this home's
    // handlers load and codex reports them untrusted, so they would never be
    // dispatched. Scoped by substring so a rotation can land on an untrusted
    // fallback while the primary was fine.
    const untrustedMatch = process.env.FAKE_CODEX_UNTRUSTED_HOME_MATCH;
    const trustStatus = untrustedMatch && home.includes(untrustedMatch) ? 'untrusted' : 'trusted';
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
      trustStatus,
    }));
    send({ id: request.id, result: { data: [{ cwd: process.cwd(), hooks: rows, warnings: [], errors: [] }] } });
    return;
  }
  if (request.method === 'account/rateLimits/read') {
    send({
      id: request.id,
      result: {
        accountId: 'acct-' + instance,
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: resetS },
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
      send({ method: 'account/rateLimits/updated', params: { rateLimits: { secondary: { usedPercent: pushWeekly, windowDurationMins: 10080, resetsAt: resetS } } } });
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
  /** The generator's own throw, when `tolerateThrow` is set. */
  thrown?: string;
}

async function run(opts: {
  weeklyByInstance: string;
  /** Weekly `resetsAt` epoch seconds per spawned instance; every instance states RESET_S when unset. */
  resetByInstance?: string;
  fallbackHomes?: string[];
  /** Substring of a CODEX_HOME whose hooks the fake reports as untrusted. */
  untrustedHomeMatch?: string;
  /** Capture a generator throw instead of propagating it, so the request log can still be read. */
  tolerateThrow?: boolean;
  /** Consecutive queries on the SAME provider instance (default 1) — a container's later wakes. */
  queries?: number;
  /** Turns pushed into EACH query after its first result (default 0) — the poll-loop's `query.push` path. */
  pushedTurns?: number;
  /** Weekly usedPercent each instance pushes mid-turn (comma list, blank = default weekly+1). */
  pushWeeklyByInstance?: string;
}): Promise<Run> {
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
  if (opts.resetByInstance) process.env.FAKE_CODEX_RESET_BY_INSTANCE = opts.resetByInstance;
  else delete process.env.FAKE_CODEX_RESET_BY_INSTANCE;
  if (opts.pushWeeklyByInstance) process.env.FAKE_CODEX_PUSH_WEEKLY_BY_INSTANCE = opts.pushWeeklyByInstance;
  else delete process.env.FAKE_CODEX_PUSH_WEEKLY_BY_INSTANCE;
  if (opts.untrustedHomeMatch) process.env.FAKE_CODEX_UNTRUSTED_HOME_MATCH = opts.untrustedHomeMatch;
  else delete process.env.FAKE_CODEX_UNTRUSTED_HOME_MATCH;
  process.env.CODEX_HEALTH_PROBE_QUIET_MS = '60000';
  process.env.CODEX_HEALTH_PROBE_INTERVAL_MS = '1000';
  process.env.CODEX_HEALTH_PROBE_TIMEOUT_MS = '1000';

  const provider = new CodexProvider({ providerConfig: { reasoning_effort: 'medium' } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const events: Run['events'] = [];
  let thrown: string | undefined;
  for (let n = 0; n < (opts.queries ?? 1) && thrown === undefined; n++) {
    const query = provider.query({ prompt: 'do the task', cwd: tmpDir });
    let turnsLeft = opts.pushedTurns ?? 0;
    try {
      for await (const event of query.events) {
        events.push(event as Run['events'][number]);
        if (event.type === 'result' && turnsLeft > 0) {
          turnsLeft--;
          query.push('and the next task');
        } else if (event.type === 'result' || (event.type === 'error' && !event.retryable)) {
          query.end();
        }
      }
    } catch (err) {
      if (!opts.tolerateThrow) throw err;
      thrown = err instanceof Error ? err.message : String(err);
      query.end();
    }
  }
  const requests = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Run['requests'][number])
    : [];
  return { events, requests, spawned: Number(fs.readFileSync(statePath, 'utf8')), thrown };
}

describe('Codex rate-limit read → park through gen()', () => {
  it('reads the snapshot at bind, runs a healthy turn, stamps the weekly window on the result and records pull + push rows', async () => {
    const { events, requests, spawned } = await run({ weeklyByInstance: '20' });
    expect(spawned).toBe(1);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    const read = requests.find((r) => r.method === 'account/rateLimits/read');
    // No params at all — codex 0.153.4 deserializes this method's params as
    // unit and refuses a params map carrying fields with `invalid type: map,
    // expected unit`, which killed every bind-time read in production while the
    // container pinned it (#817). The pin is now 0.154.0 (ARG CODEX_VERSION,
    // container/Dockerfile:41) and the no-params shape is kept deliberately as
    // the cross-version one. Asserted here too because this is the end-to-end
    // path: a params shape a pinned binary rejects costs every `usage_pull` row
    // the test below expects.
    expect(read).toBeDefined();
    expect(read && 'params' in read).toBe(false);
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

  it('a weekly window under the 95% threshold (92%) still runs the turn', async () => {
    // 92 < CODEX_PARK_USED_PERCENT (95): the 5% headroom rule (#811) leaves
    // this account in service; the reading is recorded, not acted on.
    const { events, requests, spawned } = await run({ weeklyByInstance: '92' });
    expect(spawned).toBe(1);
    expect(requests.some((r) => r.method === 'turn/start')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.find((e) => e.type === 'result')).toMatchObject({
      text: 'turn result',
      rateLimit: { type: 'seven_day', utilization: 0.93, resetsAt: RESET_ISO },
    });
  }, 5_000);

  it('a spent primary (96%) with no spare CODEX_HOME never starts a turn: one quota error carrying the measured reset', async () => {
    const { events, requests, spawned } = await run({ weeklyByInstance: '96' });
    expect(spawned).toBe(1);
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(0);
    const error = events.find((e) => e.type === 'error');
    expect(error).toEqual({
      type: 'error',
      retryable: false,
      classification: 'quota',
      resetAt: RESET_ISO,
      message: `Codex rate limit [seven_day] 96% used, at or past the 95% park threshold (resets ${RESET_ISO})`,
    });
    // The reading that caused the park is on record for the fleet to see.
    expect(getRateLimitSampleRows().map((r) => [r.limit_type, r.utilization])).toEqual([
      ['five_hour', 0.1],
      ['seven_day', 0.96],
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

  it('a container already on its fallback whose fallback then parks wraps back to the primary — the 2026-09-16 outage', async () => {
    // Query 1: primary (96%) parks → fallback (30%) runs. Query 2 starts on the
    // fallback (CODEX_HOME moved): it now parks (97%) → the ring offers the
    // primary again (20%, its window rolled over) and the turn completes there.
    // Before this the cursor was forward-only: query 2 had nothing left and the
    // poll-loop parked the whole provider until the FALLBACK's reset.
    const fallbackHome = path.join(tmpDir, 'codex-fallback-1');
    fs.mkdirSync(fallbackHome, { recursive: true });
    const { events, requests, spawned } = await run({
      weeklyByInstance: '96,30,97,20',
      fallbackHomes: [fallbackHome],
      queries: 2,
    });
    expect(spawned).toBe(4);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(requests.filter((r) => r.method === 'turn/start').map((r) => r.instance)).toEqual([2, 4]);
    const rotations = events.filter((e) => e.type === 'progress' && String(e.message).includes('Codex OAuth rotating'));
    expect(rotations.map((e) => String(e.message))).toEqual([
      expect.stringContaining('→ account 2/2'),
      expect.stringContaining('→ account 1/2'),
    ]);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(2);
  }, 5_000);

  it('a later turn PUSHED into the same query gets a fresh ring: fallback parks → back to the primary', async () => {
    // Round-2 review finding: the poll-loop keeps one query open and pushes
    // later turns into it (poll-loop.ts `pushToQuery` → `query.push`). A tried-set scoped to the query
    // would keep both homes marked after turn 1's rotation, and turn 2's park
    // on the fallback would find nothing left — the outage again.
    //
    // Turn 1: primary (96%) parks → fallback (30%) runs and PUSHES 97% at the
    // end of its turn. Turn 2, pushed into the same query, starts on that same
    // fallback app-server: the pre-turn check sees 97% → park → the ring must
    // offer the primary (instance 3, 20%) and complete there.
    const fallbackHome = path.join(tmpDir, 'codex-fallback-1');
    fs.mkdirSync(fallbackHome, { recursive: true });
    const { events, requests, spawned } = await run({
      weeklyByInstance: '96,30,20',
      pushWeeklyByInstance: ',97',
      fallbackHomes: [fallbackHome],
      pushedTurns: 1,
    });
    expect(spawned).toBe(3);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(requests.filter((r) => r.method === 'turn/start').map((r) => r.instance)).toEqual([2, 3]);
    expect(events.filter((e) => e.type === 'result')).toHaveLength(2);
    const rotations = events.filter((e) => e.type === 'progress' && String(e.message).includes('Codex OAuth rotating'));
    expect(rotations.map((e) => String(e.message))).toEqual([
      expect.stringContaining('→ account 2/2'),
      expect.stringContaining('→ account 1/2'),
    ]);
  }, 5_000);

  it('every account spent: one quota error carrying the EARLIEST reset in the ring, not the last account tried', async () => {
    const fallbackHome = path.join(tmpDir, 'codex-fallback-1');
    fs.mkdirSync(fallbackHome, { recursive: true });
    // Primary resets a day later than RESET_S; the fallback resets at RESET_S.
    // The host parks (agent_group, 'codex') on what this error says, so it must
    // be the instant the FIRST account is back, whichever was tried last.
    const { events, requests, spawned } = await run({
      weeklyByInstance: '96,97',
      resetByInstance: `${RESET_S + 86_400},${RESET_S}`,
      fallbackHomes: [fallbackHome],
    });
    expect(spawned).toBe(2);
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ retryable: false, classification: 'quota', resetAt: RESET_ISO });
    expect(String(errors[0]?.message)).toContain('all 2 Codex accounts tried this turn');
  }, 5_000);

  // The fail-closed wiring itself, driven through the real provider rather than
  // by calling the verifier directly — otherwise deleting any of the four
  // `await verifyCodexHookTrust(...)` lines in codex.ts leaves every test green.
  it('REFUSES the very first spawn when the app-server reports the generated guard chain untrusted', async () => {
    const { events, requests, spawned, thrown } = await run({
      weeklyByInstance: '20',
      untrustedHomeMatch: 'codex-home',
      tolerateThrow: true,
    });
    expect(spawned).toBe(1);
    expect(thrown).toMatch(/hook trust verification failed/i);
    // The point of failing closed: no turn ever ran under an inert guard.
    expect(requests.some((r) => r.method === 'thread/start' || r.method === 'thread/resume')).toBe(false);
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  }, 5_000);

  it('REFUSES the rotated spawn when only the FALLBACK home reports the guard chain untrusted', async () => {
    // The site that is easiest to lose in a refactor: CODEX_HOME has just moved,
    // trust entries are keyed on the absolute hooks.json path, and the primary
    // having been fine proves nothing about the home the turn will actually run in.
    const fallbackHome = path.join(tmpDir, 'codex-fallback-1');
    fs.mkdirSync(fallbackHome, { recursive: true });
    const { requests, spawned, thrown } = await run({
      weeklyByInstance: '95,30',
      fallbackHomes: [fallbackHome],
      untrustedHomeMatch: 'codex-fallback-1',
      tolerateThrow: true,
    });
    expect(spawned).toBe(2);
    expect(thrown).toMatch(/hook trust verification failed/i);
    expect(thrown).toContain('codex-fallback-1');
    // Instance 1 was parked before any turn; instance 2 is refused before one.
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
  }, 5_000);
});
