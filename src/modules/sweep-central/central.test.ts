/**
 * Acceptance cases for the central-housekeeping sweep family (convergence
 * seam 2, S2-PR4 — F-4.1..F-4.4 in
 * docs/specs/upstream-host-sweep-seam/plan.md §8).
 *
 * F-4.4 lives in src/host-sweep-registry.test.ts (it proves a registry-level
 * property — a throw from this family's receipts-prune duty does not abort
 * the rest of the tick — not a property of this module's own code).
 *
 * F-4.1's steer-idempotency slice is MOVED, unchanged, from
 * src/host-sweep.test.ts (`describe('pruneSteerIdempotency — D7')`) — the
 * body it exercises moved from src/host-sweep.ts to
 * ./steer-idempotency.ts in this same commit. The receipts and
 * dashboard-token halves of F-4.1, and all of F-4.2/F-4.3, port the retention
 * / margin / cap / cooldown / backoff assertions that already prove these
 * duties' underlying behavior in their own files — this module only wraps
 * them at the tick:housekeeping registration boundary, so the ported
 * assertions here re-prove the exact numbers the wrapper now depends on
 * (7-day receipt retention, 1-day dashboard-token grace, the GitHub App
 * 10-minute refresh margin), without duplicating those files' full suites.
 *
 * F-4.3 (session-title and thread-title caps/cooldowns/backoffs) is split
 * across two SIBLING files in this module directory, not inlined here:
 * `session-title-sweep.test.ts` and `thread-title-retry.test.ts` need
 * mutually incompatible `vi.mock('../../llm.js', ...)` treatments (the
 * session-title half needs llm.js's REAL credential-rotation reset helpers;
 * the thread-title half fully mocks llm.js's `callHaiku`), and `vi.mock` is
 * hoisted per FILE, not per `describe` block — combining them in one file
 * would silently mis-mock one half. Both files carry an `F-4.3a`/`F-4.3b`
 * label in their top describe name so the case is still traceable to F-4.3.
 *
 * Codex review finding (efb8350a..838d84f6, accepted): F-4.1..F-4.3 above
 * call each duty's underlying function DIRECTLY, so a coordinate could be
 * right while the registered `run` wrapper itself no-ops or calls the wrong
 * dependency and the suite would stay green. The
 * "the registered duties call their expected dependency" describe below
 * closes that gap for T7/T9/T10/T17 by fetching each duty from the SAME
 * registry accessor R-7 uses (`_listSweepRegistrationsForTesting`, keyed by
 * `SWEEP_DUTY_INVENTORY`) and invoking its `run(ctx)`. T15 and T16 get the
 * same treatment in their own sibling files instead — for the identical
 * `vi.mock` per-file hoisting reason as F-4.3a/b above, since a mocked
 * dependency wrapped in a spy still needs the OTHER exports of that same
 * `vi.mock`'d module (llm.js) to stay real or fully mocked, matching that
 * file's own fixture, not this one's.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  claimChannelIngress,
  completeChannelIngress,
  pruneChannelIngressReceipts,
  type ChannelIngressReceiptKey,
} from '../../db/channel-ingress-receipts.js';
import { _listSweepRegistrationsForTesting, SWEEP_DUTY_INVENTORY, type SweepTickContext } from '../../host-sweep.js';
import { log } from '../../log.js';
import { pruneSteerIdempotency } from './steer-idempotency.js';
// Side-effect import — registers this family's duties into the shared
// registry singleton (via `registerSweepDutySource`) so
// `_listSweepRegistrationsForTesting()` below can find them by name. Every
// dependency below is spied via `vi.mock(..., importOriginal)` so the wrap
// still calls through to the real implementation by default — the existing
// direct-body cases above keep exercising real behavior unchanged.
import './index.js';

vi.mock('./steer-idempotency.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./steer-idempotency.js')>();
  return { ...real, pruneSteerIdempotency: vi.fn(real.pruneSteerIdempotency) };
});
vi.mock('../../db/channel-ingress-receipts.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/channel-ingress-receipts.js')>();
  return { ...real, pruneChannelIngressReceipts: vi.fn(real.pruneChannelIngressReceipts) };
});
vi.mock('../../dashboard/db/dashboard-tokens.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../dashboard/db/dashboard-tokens.js')>();
  return { ...real, pruneDashboardTokens: vi.fn(real.pruneDashboardTokens) };
});
vi.mock('../../github-app-token.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../github-app-token.js')>();
  return { ...real, refreshExpiringGitHubAppTokens: vi.fn(real.refreshExpiringGitHubAppTokens) };
});

// Hermeticity (brief-common.md HARD RULE): the "registered duties" describe
// below runs real duty bodies via the registry, not just direct function
// calls. A tripwire, not a functional mock — it records the call and then
// throws, so a caller that swallows the throw (every duty here already wraps
// its real work in try/catch) still fails the test via the recorded array.
// vi.hoisted, not a plain const: `vi.mock` factories are hoisted above ALL
// other top-level code (including a plain `const`), and this file's
// `import './index.js'` pulls in the full host-sweep.js graph — the same
// temporal-dead-zone hazard as session-title-sweep.test.ts's `h.tmpDir`.
const spawnState = vi.hoisted(() => ({ spawns: [] as string[] }));
function childProcessTripwire(record: string[]): Record<string, (...args: unknown[]) => never> {
  const spawnAttempted =
    (name: string) =>
    (...args: unknown[]): never => {
      record.push(name);
      throw new Error(`central.test: real process spawn attempted (${name}(${JSON.stringify(args[0])}))`);
    };
  return {
    exec: spawnAttempted('exec'),
    execFile: spawnAttempted('execFile'),
    spawn: spawnAttempted('spawn'),
    execSync: spawnAttempted('execSync'),
    execFileSync: spawnAttempted('execFileSync'),
    spawnSync: spawnAttempted('spawnSync'),
    fork: spawnAttempted('fork'),
  };
}
vi.mock('child_process', () => childProcessTripwire(spawnState.spawns));
vi.mock('node:child_process', () => childProcessTripwire(spawnState.spawns));

// ── F-4.1a — steer idempotency (moved unchanged from host-sweep.test.ts D7) ──

describe('pruneSteerIdempotency — D7', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    // Seed a user required by FK
    getRawDb()
      .prepare(
        "INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES ('u1', 'test', NULL, datetime('now'))",
      )
      .run();
  });

  afterEach(async () => {
    await closeDb();
  });

  it('test_prune_removes_old_applied', async () => {
    // applied row 2 min ago — should be deleted
    getRawDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted, applied_at)
       VALUES ('u1', 'key-old', 'task', 'task-1', 'msg-1', 'hi', 'h1', datetime('now', '-3 minutes'), 'applied', 1, datetime('now', '-2 minutes'))`,
      )
      .run();
    // applied row 30 sec ago — should remain
    getRawDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted, applied_at)
       VALUES ('u1', 'key-fresh', 'task', 'task-1', 'msg-2', 'hi', 'h2', datetime('now', '-31 seconds'), 'applied', 1, datetime('now', '-30 seconds'))`,
      )
      .run();

    await pruneSteerIdempotency();

    const rows = getRawDb().prepare("SELECT idempotency_key FROM steer_idempotency WHERE status = 'applied'").all() as {
      idempotency_key: string;
    }[];
    expect(rows.map((r) => r.idempotency_key)).not.toContain('key-old');
    expect(rows.map((r) => r.idempotency_key)).toContain('key-fresh');
  });

  it('test_prune_removes_old_pending', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
       VALUES ('u1', 'pend-old', 'task', 'task-2', 'msg-3', 'hi', 'h3', datetime('now', '-10 minutes'), 'pending', 0)`,
      )
      .run();

    await pruneSteerIdempotency();

    const rows = getRawDb().prepare("SELECT idempotency_key FROM steer_idempotency WHERE status = 'pending'").all();
    expect(rows.length).toBe(0);
  });

  it('test_prune_preserves_recent_pending', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
       VALUES ('u1', 'pend-new', 'task', 'task-3', 'msg-4', 'hi', 'h4', datetime('now', '-1 minute'), 'pending', 0)`,
      )
      .run();

    await pruneSteerIdempotency();

    const rows = getRawDb()
      .prepare("SELECT idempotency_key FROM steer_idempotency WHERE idempotency_key = 'pend-new'")
      .all();
    expect(rows.length).toBe(1);
  });

  it('test_sweep_calls_prune: pruneSteerIdempotency is exported and callable', async () => {
    // Verify the function is exported and can be called without error on an empty table
    await expect(pruneSteerIdempotency()).resolves.toBeUndefined();
  });
});

// ── F-4.1 ──────────────────────────────────────────────────────────────────
// "each prune duty deletes exactly the rows its retention window covers"
// — steer idempotency is proved above (D7); receipts and dashboard tokens
// below.

describe('F-4.1 — each prune duty deletes exactly the rows its retention window covers', () => {
  const key: ChannelIngressReceiptKey = {
    channelType: 'discord',
    instance: 'discord',
    platformId: 'discord:g:c',
    messageId: 'm1',
  };

  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
  });

  afterEach(() => closeDb());

  it('channel-ingress-receipt prune: deletes completed receipts past the 7-day retention, keeps fresh ones', () => {
    expect(claimChannelIngress(key)).toBe(true);
    completeChannelIngress(key);
    // Ported from src/db/channel-ingress-receipts.test.ts: 7-day default
    // retention, 8 days in the future crosses it.
    expect(pruneChannelIngressReceipts(Date.now() + 8 * 24 * 60 * 60 * 1000)).toBe(1);
    // A row inside the window is not touched.
    expect(claimChannelIngress(key)).toBe(true);
    completeChannelIngress(key);
    expect(pruneChannelIngressReceipts(Date.now())).toBe(0);
  });

  it('dashboard-token prune: deletes rows past expiry + 1-day grace, keeps rows inside the grace and unexpired rows', async () => {
    const { pruneDashboardTokens } = await import('../../dashboard/db/dashboard-tokens.js');
    getRawDb()
      .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES ('u1', 'test', NULL, datetime('now'))")
      .run();
    // Expired 2 days ago — past the 1-day grace, must be deleted.
    getRawDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-old', datetime('now', '-3 days'), datetime('now', '-2 days'))`,
      )
      .run();
    // Expired 12 hours ago — inside the 1-day grace, must survive.
    getRawDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-grace', datetime('now', '-1 day'), datetime('now', '-12 hours'))`,
      )
      .run();
    // Not yet expired — must survive.
    getRawDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-live', datetime('now'), datetime('now', '+1 hour'))`,
      )
      .run();

    await pruneDashboardTokens();

    const remaining = getRawDb().prepare('SELECT token_hmac FROM dashboard_tokens ORDER BY token_hmac').all() as {
      token_hmac: string;
    }[];
    expect(remaining.map((r) => r.token_hmac)).toEqual(['hmac-grace', 'hmac-live']);
  });
});

// ── F-4.2 ──────────────────────────────────────────────────────────────────
// "the GitHub App token refresh acts only inside the refresh margin" — ported
// from src/github-app-token.test.ts's
// "refreshExpiringGitHubAppTokens re-mints only tokens inside the margin".

describe('F-4.2 — the GitHub App token refresh acts only inside the refresh margin', () => {
  const INSTALLATION_ID = '155749655';
  let keyPath: string;

  beforeEach(() => {
    keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-app-central-')), 'key.pem');
    fs.writeFileSync(
      keyPath,
      crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function appEnv(): NodeJS.ProcessEnv {
    return {
      GITHUB_APP_ID: '4684388',
      GITHUB_APP_INSTALLATION_ID: INSTALLATION_ID,
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
    } as NodeJS.ProcessEnv;
  }

  function mintResponse(token: string, expiresInMs: number): Response {
    return new Response(JSON.stringify({ token, expires_at: new Date(Date.now() + expiresInMs).toISOString() }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('re-mints only when the cached token is inside the 10-minute refresh margin', async () => {
    const { clearGitHubAppTokenCache, mintOrReuseGitHubAppToken, refreshExpiringGitHubAppTokens } =
      await import('../../github-app-token.js');
    clearGitHubAppTokenCache();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_old', 30 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());

    // Fresh token, far from expiry: no-op, zero mints.
    const idle = vi.fn();
    vi.stubGlobal('fetch', idle);
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(0);
    expect(idle).not.toHaveBeenCalled();

    // A 5-min-life token is inside the 10-min refresh margin the moment it is
    // cached, so the sweep must re-mint it.
    clearGitHubAppTokenCache();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mintResponse('ghs_soon', 5 * 60 * 1000)));
    await mintOrReuseGitHubAppToken(appEnv());
    const refreshMock = vi.fn().mockResolvedValue(mintResponse('ghs_new', 60 * 60 * 1000));
    vi.stubGlobal('fetch', refreshMock);
    await expect(refreshExpiringGitHubAppTokens(appEnv())).resolves.toBe(1);
    await expect(mintOrReuseGitHubAppToken(appEnv())).resolves.toMatchObject({ token: 'ghs_new' });
  });
});

// ── Codex finding — the registered duty must call its dependency ───────────
// T15/T16's equivalent cases live in session-title-sweep.test.ts and
// thread-title-retry.test.ts (see the file header comment).

describe('the registered central-housekeeping duties call their expected dependency', () => {
  const fakeTickCtx: SweepTickContext = { now: Date.now(), sessions: [], activeContainerSessionIds: new Set() };

  function registeredDuty(name: string) {
    const duty = _listSweepRegistrationsForTesting().duties.find((d) => d.name === name);
    if (!duty) throw new Error(`duty not registered: ${name}`);
    return duty;
  }

  beforeEach(async () => {
    // Truncate, never reassign: the tripwire factory closed over THIS array.
    spawnState.spawns.length = 0;
    await initTestDb();
    const db = getRawDb();
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    getRawDb()
      .prepare(
        "INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES ('u1', 'test', NULL, datetime('now'))",
      )
      .run();
  });

  afterEach(async () => {
    await closeDb();
    // NOT vi.restoreAllMocks(): the module-level `vi.mock(..., importOriginal)`
    // factories above wrap each real function as `vi.fn(real.impl)`, not a
    // `vi.spyOn` — restoreAllMocks() would clear that wrapping's implementation
    // for the rest of the file (a bare vi.fn() has no "original" to restore
    // to), silently turning every later call-through into a no-op. Each test
    // below clears only the spy(s) it uses and restores its own vi.spyOn.
  });

  it("github-app-token-refresh calls refreshExpiringGitHubAppTokens with no arguments, and a throw is logged with the wrapper's own string", async () => {
    const { refreshExpiringGitHubAppTokens } = await import('../../github-app-token.js');
    const spy = vi.mocked(refreshExpiringGitHubAppTokens);
    spy.mockClear();

    await registeredDuty(SWEEP_DUTY_INVENTORY.T7).run(fakeTickCtx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      spy.mockImplementationOnce(() => {
        throw new Error('mint boom');
      });
      await registeredDuty(SWEEP_DUTY_INVENTORY.T7).run(fakeTickCtx);
      expect(warn).toHaveBeenCalledWith(
        'GitHub App token refresh sweep step failed',
        expect.objectContaining({ err: expect.any(Error) }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(spawnState.spawns).toEqual([]);
  });

  it('steer-idempotency-prune calls pruneSteerIdempotency and its real DB effect fires', async () => {
    const spy = vi.mocked(pruneSteerIdempotency);
    spy.mockClear();
    getRawDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, target_type, target_id, message_id, text, request_hash, reserved_at, status, echo_attempted, applied_at)
       VALUES ('u1', 'via-registry', 'task', 'task-1', 'msg-1', 'hi', 'h1', datetime('now', '-3 minutes'), 'applied', 1, datetime('now', '-2 minutes'))`,
      )
      .run();

    await registeredDuty(SWEEP_DUTY_INVENTORY.T9).run(fakeTickCtx);

    expect(spy).toHaveBeenCalledTimes(1);
    const rows = getRawDb().prepare("SELECT idempotency_key FROM steer_idempotency WHERE status = 'applied'").all();
    expect(rows).toEqual([]);
    expect(spawnState.spawns).toEqual([]);
  });

  it('channel-ingress-receipt-prune calls pruneChannelIngressReceipts and its real DB effect fires', async () => {
    const spy = vi.mocked(pruneChannelIngressReceipts);
    spy.mockClear();
    const key: ChannelIngressReceiptKey = {
      channelType: 'discord',
      instance: 'discord',
      platformId: 'discord:g:c',
      messageId: 'via-registry',
    };
    expect(claimChannelIngress(key)).toBe(true);
    completeChannelIngress(key);
    getRawDb()
      .prepare(
        `UPDATE channel_ingress_receipts SET completed_at = datetime('now', '-8 days') WHERE message_id = 'via-registry'`,
      )
      .run();

    await registeredDuty(SWEEP_DUTY_INVENTORY.T10).run(fakeTickCtx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
    expect(claimChannelIngress(key)).toBe(true);
    expect(spawnState.spawns).toEqual([]);
  });

  it('dashboard-token-prune calls pruneDashboardTokens and its real DB effect fires (fire-and-forget, so poll)', async () => {
    const { pruneDashboardTokens } = await import('../../dashboard/db/dashboard-tokens.js');
    const spy = vi.mocked(pruneDashboardTokens);
    spy.mockClear();
    getRawDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-via-registry', datetime('now', '-3 days'), datetime('now', '-2 days'))`,
      )
      .run();

    // The T17 `run` body is `void import(...).then(...)` — it returns before
    // the dynamic import resolves, so poll for the spy call rather than
    // awaiting `run()` itself. The duty interface's `run` is typed
    // `void | Promise<void>` to cover both sync and async duties; this one is
    // sync (see index.ts) so there's nothing to actually await here.
    void registeredDuty(SWEEP_DUTY_INVENTORY.T17).run(fakeTickCtx);
    const start = Date.now();
    while (spy.mock.calls.length === 0) {
      if (Date.now() - start > 1000) throw new Error('timed out waiting for pruneDashboardTokens to be called');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(spy).toHaveBeenCalledTimes(1);
    const remaining = getRawDb().prepare('SELECT token_hmac FROM dashboard_tokens').all();
    expect(remaining).toEqual([]);
    expect(spawnState.spawns).toEqual([]);
  });

  it('the child_process tripwire bites when a seam mock is removed', () => {
    const record: string[] = [];
    const tripwire = childProcessTripwire(record);
    expect(() => tripwire.execSync!('git pull')).toThrow(/real process spawn attempted/);
    expect(record).toEqual(['execSync']);
  });
});
