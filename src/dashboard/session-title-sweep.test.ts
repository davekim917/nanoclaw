import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getRawDb } from '../db/index.js';
import { log } from '../log.js';

// The sweep reads inbound/outbound DBs from `${DATA_DIR}/v2-sessions/...`.
// Point DATA_DIR at a temp folder so we can write minimal session DBs the
// sweep will pick up.
let TMP_DIR: string;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get DATA_DIR() {
    return TMP_DIR;
  },
}));

// isBackendConfigured() and callTitleBackend()'s production path now resolve
// credentials the same way src/llm.ts's callHaiku does — including merging
// in `.env`-file values via readEnvFileMatching() whenever passed
// process.env directly (see src/llm.test.ts for the same stub, for the same
// reason: this repo's real on-disk `.env` holds real OAuth tokens, and tests
// must never read them). Credential slots for the tests below come
// exclusively from process.env, set explicitly per test.
vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFileMatching: vi.fn(() => ({})),
}));

import Database from 'better-sqlite3';
import {
  __resetCallHaikuSlotCacheForTest,
  __resetCredentialRotationGateForTest,
  __setCredentialRotationGateMinIntervalForTest,
} from '../llm.js';
import {
  runSessionTitleSweep,
  setTitleBackendForTest,
  _resetTitleBackendForTest,
  _resetCooldownForTest,
  _getCooldownStateForTest,
  BREAKER_COOLDOWN_BASE_MS,
  postProcessTitle,
  CONCURRENCY_CAP,
} from './session-title-sweep.js';

function now(): string {
  return new Date().toISOString();
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function authHeader(call: unknown[]): string | undefined {
  const init = call[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.authorization;
}

/**
 * Credential/proxy env vars that isBackendConfigured() and callTitleBackend()
 * resolve through when no test override is set. Most tests in this file use
 * setTitleBackendForTest() and never reach this resolution at all, but the
 * "no backend configured" and credential-rotation tests below deliberately
 * exercise the real production path — those must never inherit this shell's
 * ambient CLAUDE_CODE_OAUTH_TOKEN/HTTPS_PROXY (both of which are set on a
 * live NanoClaw host).
 */
const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_2',
  'CLAUDE_CODE_OAUTH_TOKEN_3',
  'CLAUDE_CODE_OAUTH_TOKEN_4',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

let originalCredentialEnv: Partial<Record<(typeof CREDENTIAL_ENV_KEYS)[number], string>>;

async function setupDb(): Promise<void> {
  await initTestDb();
  const db = getRawDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedSession(
  id: string,
  agentGroupId: string,
  opts: { title?: string | null; title_generated_at?: string | null; title_basis_seq?: number | null } = {},
): void {
  getRawDb()
    .prepare(
      // Distinct thread per session, mirroring real task sessions
      // (`system:tasks:<seriesId>`) — migration 049 folds NULLs, so two
      // active NULL/NULL rows per agent group is a shape production never has.
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, NULL, ?, 'active', ?)",
    )
    .run(id, agentGroupId, `system:tasks:${id}`, now());
  if (opts.title !== undefined || opts.title_generated_at !== undefined || opts.title_basis_seq !== undefined) {
    getRawDb()
      .prepare(`UPDATE sessions SET title = ?, title_generated_at = ?, title_basis_seq = ? WHERE id = ?`)
      .run(opts.title ?? null, opts.title_generated_at ?? null, opts.title_basis_seq ?? null, id);
  }
}

/**
 * Write a minimal inbound.db at the sweep's expected path with a small
 * batch of messages. Returns the highest seq written so callers can pin
 * the basis-seq comparison.
 */
function writeInboundMessages(
  agentGroupId: string,
  sessionId: string,
  messages: Array<{ kind: string; content: string }>,
): number {
  const dir = path.join(TMP_DIR, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'inbound.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT NOT NULL,
      platform_id TEXT,
      channel_type TEXT,
      thread_id TEXT,
      content TEXT,
      process_after TEXT,
      recurrence TEXT,
      series_id TEXT,
      trigger INTEGER NOT NULL DEFAULT 1,
      source_session_id TEXT,
      tries INTEGER NOT NULL DEFAULT 0
    );
  `);
  let seq = 0;
  for (const m of messages) {
    seq += 2;
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(`msg-${sessionId}-${seq}`, seq, m.kind, now(), m.content);
  }
  db.close();
  return seq;
}

beforeEach(async () => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'session-title-'));
  await setupDb();
  seedAgentGroup('ag-1');

  originalCredentialEnv = {};
  for (const key of CREDENTIAL_ENV_KEYS) {
    originalCredentialEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Shared "which credential slot is alive" cache lives in src/llm.ts and is
  // process-wide by design (see callWithCredentialRotation) — reset it so
  // tests don't inherit a sticky slot from an earlier test in this file.
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
  // The "production credential rotation" tests below exercise the real
  // callWithCredentialRotation path (src/llm.ts), which now serializes
  // behind a process-wide gate with a real 1s minimum spacing between
  // calls. These tests use REAL timers (no vi.useFakeTimers() in this
  // file's default describe blocks), so leaving the real interval in place
  // would make the suite measurably slower without testing anything this
  // file cares about — gate timing itself is covered in src/llm.test.ts.
  __setCredentialRotationGateMinIntervalForTest(0);
});

afterEach(async () => {
  await closeDb();
  _resetTitleBackendForTest();
  // The cooldown tests below deliberately trip the breaker, which engages a
  // real cooldown in this module-level singleton state. Without a reset,
  // that cooldown would silently suppress every OTHER test in this file for
  // (real) minutes afterward.
  _resetCooldownForTest();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  // The breaker tests below spy on log.warn; without a restore, vitest keeps
  // the same spy (and its accumulated call history) alive into later tests.
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const key of CREDENTIAL_ENV_KEYS) {
    const original = originalCredentialEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  __resetCallHaikuSlotCacheForTest();
  __resetCredentialRotationGateForTest();
});

describe('postProcessTitle', () => {
  it('strips quotes, preamble, trailing periods, and caps length', () => {
    expect(postProcessTitle('"EXAMPLE-71 rollout fix"')).toBe('EXAMPLE-71 rollout fix');
    expect(postProcessTitle('Title: Slack auto-wire debug')).toBe('Slack auto-wire debug');
    expect(postProcessTitle('Done.')).toBe('Done');
    expect(postProcessTitle('a'.repeat(120)).length).toBe(60);
    expect(postProcessTitle('  whitespace\nand newlines  ')).toBe('whitespace and newlines');
  });
});

describe('runSessionTitleSweep', () => {
  it('generates a title for a session that has none', async () => {
    seedSession('sess-fresh', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fresh', [
      { kind: 'chat', content: JSON.stringify({ text: 'fix the rollout for EXAMPLE-71' }) },
    ]);
    setTitleBackendForTest(async () => 'EXAMPLE-71 rollout fix');

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);

    const row = getRawDb()
      .prepare('SELECT title, title_basis_seq, title_generated_at FROM sessions WHERE id = ?')
      .get('sess-fresh') as { title: string; title_basis_seq: number; title_generated_at: string };
    expect(row.title).toBe('EXAMPLE-71 rollout fix');
    expect(row.title_basis_seq).toBeGreaterThan(0);
    expect(row.title_generated_at).toBeTruthy();
  });

  it('skips a session with a recent title (<1h cooldown)', async () => {
    seedSession('sess-recent', 'ag-1', {
      title: 'existing',
      title_generated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      title_basis_seq: 2,
    });
    writeInboundMessages('ag-1', 'sess-recent', [{ kind: 'chat', content: '{"text":"more chat"}' }]);

    const backend = vi.fn(async () => 'WOULD REGENERATE');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('does NOT refresh when cooldown passed but <10 new messages', async () => {
    seedSession('sess-stale-but-quiet', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 50,
    });
    // Write enough messages so the max seq is only 5 beyond basis_seq.
    // Each writeInboundMessages call resets seq at 0, so we seed the table
    // directly with high seqs.
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-stale-but-quiet');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
    );
    db.prepare(`INSERT INTO messages_in VALUES ('m1', 54, 'chat', ?, 'pending', '{"text":"hi"}')`).run(now());
    db.close();

    const backend = vi.fn(async () => 'newer title');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('refreshes when cooldown passed AND ≥10 new messages', async () => {
    seedSession('sess-busy', 'ag-1', {
      title: 'old title',
      title_generated_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      title_basis_seq: 10,
    });
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-busy');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT);`,
    );
    // Seed messages at seqs that include rows ≥10 past basis_seq=10
    for (let i = 1; i <= 12; i++) {
      db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat', ?, 'pending', ?)`).run(
        `m-${i}`,
        10 + i,
        now(),
        JSON.stringify({ text: `msg ${i}` }),
      );
    }
    db.close();

    setTitleBackendForTest(async () => 'refreshed title');
    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);

    const row = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-busy') as { title: string };
    expect(row.title).toBe('refreshed title');
  });

  it('honors concurrency cap of 3', async () => {
    // Seed 5 candidates that all need a title.
    for (let i = 1; i <= 5; i++) {
      seedSession(`sess-c-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-c-${i}`, [{ kind: 'chat', content: '{"text":"x"}' }]);
    }
    let inFlight = 0;
    let peak = 0;
    setTitleBackendForTest(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return 'parallel title';
    });

    const result = await runSessionTitleSweep();
    expect(peak).toBeLessThanOrEqual(CONCURRENCY_CAP);
    expect(result.generated).toBe(CONCURRENCY_CAP);
  });

  it('swallows backend failures and continues other candidates', async () => {
    seedSession('sess-ok', 'ag-1');
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-ok', [{ kind: 'chat', content: '{"text":"ok"}' }]);
    writeInboundMessages('ag-1', 'sess-fail', [{ kind: 'chat', content: '{"text":"will fail"}' }]);

    const backend = vi.fn(async (_s, user: string) => {
      if (user.includes('will fail')) throw new Error('boom');
      return 'all good';
    });
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(1);

    const ok = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-ok') as { title: string | null };
    const fail = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-fail') as {
      title: string | null;
    };
    expect(ok.title).toBe('all good');
    expect(fail.title).toBeNull();
  });

  it('circuit breaker: 3 consecutive transient (429) failures collapse into ONE warn, not one per candidate', async () => {
    // This sweep was measured at 120 failed 429 calls in a single day,
    // starving the other host Haiku callers. Three candidates all hitting a
    // rate limit in the same tick must log ONE breaker warn, not three
    // individual "backend call failed" warns.
    for (let i = 1; i <= 3; i++) {
      seedSession(`sess-429-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-429-${i}`, [{ kind: 'chat', content: `{"text":"msg ${i}"}` }]);
    }
    const backend = vi.fn(async () => {
      const err = new Error('rate limited') as Error & { status?: number };
      err.status = 429;
      throw err;
    });
    setTitleBackendForTest(backend);
    const warnSpy = vi.spyOn(log, 'warn');

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(result.skipped).toBe(3);
    expect(backend).toHaveBeenCalledTimes(3);

    const breakerWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('circuit breaker tripped'));
    const cooldownWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('cooldown engaged'));
    const perCandidateWarns = warnSpy.mock.calls.filter(
      ([msg]) => String(msg) === 'session-title: backend call failed',
    );
    expect(breakerWarns.length).toBe(1);
    expect(perCandidateWarns.length).toBe(0);
    // A tripped breaker also engages the sweep-level cooldown — the part
    // that actually cuts call volume, not just log noise (see the
    // "circuit breaker cooldown" describe block below for the full behavior).
    expect(cooldownWarns.length).toBe(1);

    // Every failed candidate is still stamped so it doesn't clog next tick —
    // the breaker changes LOGGING, not the existing backoff/retry semantics.
    for (let i = 1; i <= 3; i++) {
      const row = getRawDb()
        .prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?')
        .get(`sess-429-${i}`) as { title: string | null; title_generated_at: string | null };
      expect(row.title).toBeNull();
      expect(row.title_generated_at).toBeTruthy();
    }
  });

  it('circuit breaker does NOT trip on fewer than 3 consecutive transient failures', async () => {
    seedSession('sess-429-a', 'ag-1');
    seedSession('sess-ok', 'ag-1');
    writeInboundMessages('ag-1', 'sess-429-a', [{ kind: 'chat', content: '{"text":"will 429"}' }]);
    writeInboundMessages('ag-1', 'sess-ok', [{ kind: 'chat', content: '{"text":"fine"}' }]);

    const backend = vi.fn(async (_s, user: string) => {
      if (user.includes('will 429')) {
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return 'all good';
    });
    setTitleBackendForTest(backend);
    const warnSpy = vi.spyOn(log, 'warn');

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);
    expect(result.skipped).toBe(1);

    const breakerWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('circuit breaker'));
    const perCandidateWarns = warnSpy.mock.calls.filter(
      ([msg]) => String(msg) === 'session-title: backend call failed',
    );
    expect(breakerWarns.length).toBe(0);
    expect(perCandidateWarns.length).toBe(1);
  });

  describe('production credential rotation (real callTitleBackend, no test override)', () => {
    // These tests exercise the ACTUAL production path — isBackendConfigured()
    // and callTitleBackend()'s real HTTP call through src/llm.ts's
    // callWithCredentialRotation — rather than setTitleBackendForTest()'s
    // stub. That is the path that used to pin to
    // process.env.CLAUDE_CODE_OAUTH_TOKEN (slot 1) with no rotation, so it
    // 429'd forever on an exhausted primary credential while slots 2-4 sat
    // unused. beforeEach() above already strips ambient credential/proxy env
    // and mocks readEnvFileMatching() so this never touches a real token.
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-slot-1-token';
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('rotates to a second credential slot on a quota-exhaustion 429 instead of tripping the breaker', async () => {
      seedSession('sess-rotate', 'ag-1');
      writeInboundMessages('ag-1', 'sess-rotate', [
        { kind: 'chat', content: JSON.stringify({ text: 'fix the rollout for EXAMPLE-71' }) },
      ]);

      // Slot 1: quota-exhaustion 429 (no retry-after — the shape that needs
      // rotation, not backoff). Slot 2: succeeds.
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: { type: 'rate_limit_error' } }, { status: 429 }))
        .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'EXAMPLE-71 rollout fix' }] }));

      const warnSpy = vi.spyOn(log, 'warn');

      const result = await runSessionTitleSweep();

      expect(result.generated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-1-token');
      expect(authHeader(fetchMock.mock.calls[1])).toBe('Bearer oauth-slot-2-token');

      // Rotation absorbed the 429 at the request layer — the breaker/cooldown
      // (a DIFFERENT, coarser mechanism for when every slot is exhausted)
      // never engaged.
      const breakerWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('circuit breaker'));
      const cooldownWarns = warnSpy.mock.calls.filter(([msg]) => String(msg).includes('cooldown engaged'));
      expect(breakerWarns.length).toBe(0);
      expect(cooldownWarns.length).toBe(0);

      const row = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-rotate') as {
        title: string | null;
      };
      expect(row.title).toBe('EXAMPLE-71 rollout fix');
    });

    it('isBackendConfigured() reports true from a non-primary slot alone', async () => {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      // Only slot 2 configured — the old primary-only check would have
      // reported "not configured" here and made the sweep a no-op.
      process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = 'oauth-slot-2-token';

      seedSession('sess-slot2-only', 'ag-1');
      writeInboundMessages('ag-1', 'sess-slot2-only', [{ kind: 'chat', content: '{"text":"hello"}' }]);
      fetchMock.mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'slot 2 title' }] }));

      const result = await runSessionTitleSweep();

      expect(result.generated).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(authHeader(fetchMock.mock.calls[0])).toBe('Bearer oauth-slot-2-token');
    });
  });

  describe('circuit breaker cooldown (sweep-level — the part that actually cuts call volume)', () => {
    // Per-tick breaker log dedup (above) is real but only collapses log
    // lines: with CONCURRENCY_CAP=3, a fully-failed batch has nothing left
    // to "abandon" that tick. This cooldown is what stops the sweep from
    // issuing 3 more doomed Haiku calls on the VERY NEXT tick.
    function seedFailingBatch(prefix: string): void {
      for (let i = 1; i <= 3; i++) {
        seedSession(`${prefix}-${i}`, 'ag-1');
        writeInboundMessages('ag-1', `${prefix}-${i}`, [{ kind: 'chat', content: `{"text":"${prefix} ${i}"}` }]);
      }
    }
    function rateLimitedBackend() {
      return vi.fn(async (): Promise<string> => {
        const err = new Error('rate limited') as Error & { status?: number };
        err.status = 429;
        throw err;
      });
    }

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'));
    });

    it('a tripped breaker suppresses the next tick entirely — the backend is never called', async () => {
      const backend = rateLimitedBackend();
      setTitleBackendForTest(backend);
      seedFailingBatch('sess-cd-a');

      const first = await runSessionTitleSweep();
      expect(first).toEqual({ generated: 0, skipped: 3 });
      expect(backend).toHaveBeenCalledTimes(3);
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(BREAKER_COOLDOWN_BASE_MS);

      backend.mockClear();
      // Fresh untitled candidates exist — if the cooldown weren't
      // suppressing the tick, these would be picked up and burn 3 more calls.
      seedFailingBatch('sess-cd-b');
      vi.setSystemTime(new Date('2026-08-31T00:01:00.000Z')); // 1 min later — well inside the 5-min cooldown

      const second = await runSessionTitleSweep();
      expect(second).toEqual({ generated: 0, skipped: 0 });
      expect(backend).not.toHaveBeenCalled();
    });

    it('the cooldown expires and the sweep resumes', async () => {
      const backend = rateLimitedBackend();
      setTitleBackendForTest(backend);
      seedFailingBatch('sess-cd-c');
      await runSessionTitleSweep();
      backend.mockClear();

      vi.setSystemTime(new Date('2026-08-31T00:05:01.000Z')); // just past the 5-min base cooldown
      seedFailingBatch('sess-cd-d');
      const resumed = await runSessionTitleSweep();

      expect(backend).toHaveBeenCalledTimes(3); // resumed — cooldown expired
      expect(resumed.skipped).toBe(3);
      // Still failing on the very first batch after the cooldown expired —
      // this is the "sustained rate-limit" case that must escalate.
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(BREAKER_COOLDOWN_BASE_MS * 2);
    });

    it('a success resets the escalation back to the base cooldown', async () => {
      const backend = rateLimitedBackend();
      setTitleBackendForTest(backend);
      seedFailingBatch('sess-cd-e');
      await runSessionTitleSweep(); // trip #1 -> 5 min
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(BREAKER_COOLDOWN_BASE_MS);

      vi.setSystemTime(new Date('2026-08-31T00:05:01.000Z'));
      seedFailingBatch('sess-cd-f');
      await runSessionTitleSweep(); // trip #2, first batch after cooldown expiry -> escalates to 10 min
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(BREAKER_COOLDOWN_BASE_MS * 2);

      // Expire the 10-min cooldown, but succeed this time.
      vi.setSystemTime(new Date('2026-08-31T00:15:02.000Z'));
      setTitleBackendForTest(async () => 'a real title');
      seedSession('sess-cd-success', 'ag-1');
      writeInboundMessages('ag-1', 'sess-cd-success', [{ kind: 'chat', content: '{"text":"real content"}' }]);
      const successTick = await runSessionTitleSweep();
      expect(successTick.generated).toBeGreaterThan(0);
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(0); // escalation reset by the success

      // A trip immediately after that success must start over at the BASE
      // cooldown, not continue escalating from the prior 10-minute run.
      const backendAgain = rateLimitedBackend();
      setTitleBackendForTest(backendAgain);
      seedFailingBatch('sess-cd-g');
      await runSessionTitleSweep();
      expect(_getCooldownStateForTest().lastCooldownMs).toBe(BREAKER_COOLDOWN_BASE_MS);
    });
  });

  it('returns {0, 0} when no candidates exist', async () => {
    const result = await runSessionTitleSweep();
    expect(result).toEqual({ generated: 0, skipped: 0 });
  });

  it('skips a session whose inbound.db is missing', async () => {
    seedSession('sess-no-db', 'ag-1');
    const backend = vi.fn(async () => 'should not be called');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
  });

  it('no-op when no backend is configured (key missing AND no test override)', async () => {
    // Production mode: ANTHROPIC_API_KEY is unset (OneCLI vault path) and
    // the test override has been reset. Sweep must short-circuit without
    // doing DB writes or candidate picks.
    seedSession('sess-no-backend', 'ag-1');
    writeInboundMessages('ag-1', 'sess-no-backend', [{ kind: 'chat', content: '{"text":"x"}' }]);
    _resetTitleBackendForTest();
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const result = await runSessionTitleSweep();
      expect(result).toEqual({ generated: 0, skipped: 0 });
      // No row should be stamped — gate runs BEFORE pickCandidates.
      const row = getRawDb()
        .prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?')
        .get('sess-no-backend') as { title: string | null; title_generated_at: string | null };
      expect(row.title).toBeNull();
      expect(row.title_generated_at).toBeNull();
    } finally {
      if (originalKey !== undefined) process.env['ANTHROPIC_API_KEY'] = originalKey;
    }
  });

  it('re-entrancy guard: a second concurrent sweep call is a no-op (Q3)', async () => {
    seedSession('sess-1', 'ag-1');
    seedSession('sess-2', 'ag-1');
    writeInboundMessages('ag-1', 'sess-1', [{ kind: 'chat', content: '{"text":"a"}' }]);
    writeInboundMessages('ag-1', 'sess-2', [{ kind: 'chat', content: '{"text":"b"}' }]);
    const backend = vi.fn(async () => {
      // Hold the backend mid-flight so the second sweep starts before the
      // first finishes — without the re-entrancy guard this would double-
      // batch the same candidates.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return 'title';
    });
    setTitleBackendForTest(backend);

    const [a, b] = await Promise.all([runSessionTitleSweep(), runSessionTitleSweep()]);
    // Exactly one of the calls did the work; the other returned 0/0.
    const totals = [a.generated + a.skipped, b.generated + b.skipped];
    expect(totals).toContain(0);
    expect(totals.some((n) => n > 0)).toBe(true);
  });

  it('failure backoff stamps title_generated_at so the row is skipped next tick (Q3)', async () => {
    seedSession('sess-fail', 'ag-1');
    writeInboundMessages('ag-1', 'sess-fail', [{ kind: 'chat', content: '{"text":"x"}' }]);
    setTitleBackendForTest(async () => {
      throw new Error('boom');
    });

    const first = await runSessionTitleSweep();
    expect(first.generated).toBe(0);
    expect(first.skipped).toBe(1);

    // The failure stamps a recent `title_generated_at`; the candidate
    // query filters out rows with title_generated_at within the cooldown
    // window. Next sweep tick should not pick this session.
    const row = getRawDb().prepare('SELECT title_generated_at FROM sessions WHERE id = ?').get('sess-fail') as {
      title_generated_at: string | null;
    };
    expect(row.title_generated_at).toBeTruthy();

    const backendSecond = vi.fn(async () => 'should not run');
    setTitleBackendForTest(backendSecond);
    const second = await runSessionTitleSweep();
    expect(second.generated).toBe(0);
    expect(backendSecond).not.toHaveBeenCalled();
  });

  it('stamps an empty/contentless session so it exits the candidate pool (clog fix)', async () => {
    // An active NULL-title session with an inbound.db that has NO messages.
    // Pre-fix this was skipped WITHOUT stamping, so it re-entered the candidate
    // set forever and (in bulk) starved real sessions. It must now be stamped.
    seedSession('sess-empty', 'ag-1');
    writeInboundMessages('ag-1', 'sess-empty', []); // empty db, slice.maxSeq < 0
    const backend = vi.fn(async () => 'unused');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
    const row = getRawDb().prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?').get('sess-empty') as {
      title: string | null;
      title_generated_at: string | null;
    };
    expect(row.title).toBeNull();
    expect(row.title_generated_at).toBeTruthy(); // stamped → won't clog next tick
  });

  it('skips a session that has never woken the agent (trigger=0 only — bot-spam thread)', async () => {
    // mention-mode channel: a bot message lands with trigger=0 ("accumulate
    // as context only" — never wakes a container). It has real content, so
    // pre-fix this would burn a Haiku call every tick. Post-fix it's treated
    // like an empty session: stamped and skipped, no backend call.
    seedSession('sess-unwoken', 'ag-1');
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-unwoken');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT, trigger INTEGER NOT NULL DEFAULT 1);`,
    );
    db.prepare(`INSERT INTO messages_in VALUES ('m1', 2, 'chat', ?, 'pending', ?, 0)`).run(
      now(),
      JSON.stringify({ text: 'Snowflake alert: query failed' }),
    );
    db.close();

    const backend = vi.fn(async () => 'unused');
    setTitleBackendForTest(backend);

    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(0);
    expect(backend).not.toHaveBeenCalled();
    const row = getRawDb()
      .prepare('SELECT title, title_generated_at FROM sessions WHERE id = ?')
      .get('sess-unwoken') as {
      title: string | null;
      title_generated_at: string | null;
    };
    expect(row.title).toBeNull();
    expect(row.title_generated_at).toBeTruthy(); // stamped → won't clog next tick
  });

  it('titles a session once a real wake (trigger=1) arrives after bot-only traffic', async () => {
    seedSession('sess-later-woken', 'ag-1');
    const dir = path.join(TMP_DIR, 'v2-sessions', 'ag-1', 'sess-later-woken');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'inbound.db'));
    db.exec(
      `CREATE TABLE messages_in (id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT, trigger INTEGER NOT NULL DEFAULT 1);`,
    );
    db.prepare(`INSERT INTO messages_in VALUES ('m1', 2, 'chat', ?, 'pending', ?, 0)`).run(
      now(),
      JSON.stringify({ text: 'Snowflake alert: query failed' }),
    );
    db.prepare(`INSERT INTO messages_in VALUES ('m2', 4, 'chat', ?, 'pending', ?, 1)`).run(
      now(),
      JSON.stringify({ text: '@bot please look into this' }),
    );
    db.close();

    setTitleBackendForTest(async () => 'Snowflake failure triage');
    const result = await runSessionTitleSweep();
    expect(result.generated).toBe(1);
    const row = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-later-woken') as {
      title: string | null;
    };
    expect(row.title).toBe('Snowflake failure triage');
  });

  it('a backlog of empty shells does NOT starve a real recently-active session (clog fix)', async () => {
    // 15 empty shells, seeded FIRST (lowest rowids) and marked long-inactive.
    // Pre-fix the candidate query (oldest-rowid-first, LIMIT cap*4=12) returned
    // only these 12 empties → 0 generated, and the real session below — seeded
    // last, highest rowid — was never reached. The new ordering (untitled +
    // most-recently-active first) surfaces the real session instead.
    for (let i = 1; i <= 15; i++) {
      seedSession(`sess-empty-${i}`, 'ag-1');
      writeInboundMessages('ag-1', `sess-empty-${i}`, []);
      getRawDb()
        .prepare("UPDATE sessions SET last_active = '2026-01-01T00:00:00Z' WHERE id = ?")
        .run(`sess-empty-${i}`);
    }
    seedSession('sess-real', 'ag-1');
    writeInboundMessages('ag-1', 'sess-real', [
      { kind: 'chat', content: JSON.stringify({ text: 'deploy the EXAMPLE-99 hotfix' }) },
    ]);
    getRawDb().prepare('UPDATE sessions SET last_active = ? WHERE id = ?').run(now(), 'sess-real');

    setTitleBackendForTest(async () => 'EXAMPLE-99 hotfix deploy');
    const result = await runSessionTitleSweep();

    const real = getRawDb().prepare('SELECT title FROM sessions WHERE id = ?').get('sess-real') as {
      title: string | null;
    };
    expect(real.title).toBe('EXAMPLE-99 hotfix deploy'); // not starved
    expect(result.generated).toBeGreaterThanOrEqual(1);
  });
});
