/**
 * Acceptance cases for the ported upstream coordination accessors
 * (docs/specs/upstream-restart-survival-seam/plan.md §7.A).
 *
 * The accessors themselves are byte-identical to upstream and never edited
 * (src/durable-host-seam.test.ts pins that). These cases exist because the
 * fork depends on specific SEMANTICS of theirs in later series — the CAS
 * fence, the holder-scoped release, the strict `>` lease comparison — so a
 * future upstream re-pin that changes any of them fails here rather than in
 * production.
 *
 * Real in-memory driver, no mocks: the assertions are about SQL behavior. The
 * schema comes from migration 071 itself rather than a restated CREATE TABLE,
 * so the fixture cannot drift from the live one, and the raw handle is
 * deliberately not used — this file is new and `src/db/raw-db-ratchet.test.ts`
 * only ever shrinks.
 */
import type Database from 'better-sqlite3';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './index.js';
import { migration071 } from './migrations/071-host-coordination.js';
import {
  clearDeliveryAttempt,
  getDeliveryAttempt,
  getLiveHostInstance,
  getSessionClaim,
  markHostInstanceStopped,
  recordDeliveryAttempt,
  registerHostInstance,
  releaseSessionClaim,
  renewHostInstanceLease,
  setStopIntent,
  tryClaimSession,
  writeWakeSignal,
} from './coordination.js';

/** Migration 071's `up` only ever calls `exec`, so a recorder captures its exact DDL. */
function migration071Ddl(): string {
  const statements: string[] = [];
  migration071.up({ exec: (sql: string) => statements.push(sql) } as unknown as Database.Database);
  return statements.join('\n');
}

const INSTANCE = 'host-a';
const OTHER = 'host-b';
const NOW = '2026-09-05T12:00:00.000Z';
const LATER = '2026-09-05T12:01:30.000Z';
const MUCH_LATER = '2026-09-05T13:00:00.000Z';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

describe('coordination accessors', () => {
  beforeEach(async () => {
    await initTestDb();
    await getDb().exec(migration071Ddl());
  });
  afterEach(() => closeDb());

  it('registerHostInstance is idempotent on instance_id and clears stopped_at', async () => {
    await registerHostInstance({
      instanceId: INSTANCE,
      installId: 'install',
      hostname: 'box',
      pid: 42,
      now: NOW,
      leaseExpiresAt: LATER,
    });
    await markHostInstanceStopped(INSTANCE, LATER);
    await registerHostInstance({
      instanceId: INSTANCE,
      installId: 'install',
      now: LATER,
      leaseExpiresAt: MUCH_LATER,
    });

    const rows = await getDb().all<{ instance_id: string; stopped_at: string | null; lease_expires_at: string }>(
      'SELECT * FROM host_instances',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].stopped_at).toBeNull();
    expect(rows[0].lease_expires_at).toBe(MUCH_LATER);
  });

  it('renewHostInstanceLease returns false for a stopped row and for a missing id', async () => {
    await registerHostInstance({ instanceId: INSTANCE, installId: 'install', now: NOW, leaseExpiresAt: LATER });
    expect(await renewHostInstanceLease(INSTANCE, MUCH_LATER)).toBe(true);

    await markHostInstanceStopped(INSTANCE, LATER);
    expect(await renewHostInstanceLease(INSTANCE, MUCH_LATER)).toBe(false);
    expect(await renewHostInstanceLease('never-registered', MUCH_LATER)).toBe(false);
  });

  it('getLiveHostInstance hides an expired lease', async () => {
    // lease_expires_at EQUAL to `now` is already expired — the comparison is
    // strict `>`, which is what makes a lease that lapsed this millisecond
    // read as not-live rather than live for one more tick.
    await registerHostInstance({ instanceId: INSTANCE, installId: 'install', now: NOW, leaseExpiresAt: LATER });
    expect(await getLiveHostInstance(INSTANCE, NOW)).toBeDefined();
    expect(await getLiveHostInstance(INSTANCE, LATER)).toBeUndefined();
    expect(await getLiveHostInstance('never-registered', NOW)).toBeUndefined();
  });

  it('tryClaimSession creates the row at expectedIncarnation 0 and returns 1', async () => {
    const claimed = await tryClaimSession({
      sessionId: 's1',
      instanceId: INSTANCE,
      expectedIncarnation: 0,
      containerRef: 'ctr-1',
      now: NOW,
    });
    expect(claimed).toBe(1);

    const row = await getSessionClaim('s1');
    expect(row?.incarnation).toBe(1);
    expect(row?.claimed_by).toBe(INSTANCE);
    expect(row?.container_ref).toBe('ctr-1');
  });

  it('tryClaimSession returns null on a stale expected incarnation and leaves the row untouched', async () => {
    await tryClaimSession({ sessionId: 's1', instanceId: INSTANCE, expectedIncarnation: 0, now: NOW });
    const stale = await tryClaimSession({
      sessionId: 's1',
      instanceId: OTHER,
      expectedIncarnation: 0,
      now: MUCH_LATER,
    });

    expect(stale).toBeNull();
    const row = await getSessionClaim('s1');
    expect(row?.incarnation).toBe(1);
    expect(row?.claimed_by).toBe(INSTANCE);
    expect(row?.claimed_at).toBe(NOW);
  });

  it('releaseSessionClaim releases only the holder’s own incarnation', async () => {
    await tryClaimSession({ sessionId: 's1', instanceId: INSTANCE, expectedIncarnation: 0, now: NOW });

    expect(await releaseSessionClaim({ sessionId: 's1', instanceId: OTHER, incarnation: 1, now: LATER })).toBe(false);
    expect((await getSessionClaim('s1'))?.claimed_by).toBe(INSTANCE);

    expect(await releaseSessionClaim({ sessionId: 's1', instanceId: INSTANCE, incarnation: 2, now: LATER })).toBe(
      false,
    );
    expect((await getSessionClaim('s1'))?.claimed_by).toBe(INSTANCE);

    expect(await releaseSessionClaim({ sessionId: 's1', instanceId: INSTANCE, incarnation: 1, now: LATER })).toBe(true);
    expect((await getSessionClaim('s1'))?.claimed_by).toBeNull();
  });

  it('recordDeliveryAttempt returns the running count and clearDeliveryAttempt removes the row', async () => {
    expect(await recordDeliveryAttempt({ messageId: 'm1', sessionId: 's1', now: NOW, nextAttemptAt: LATER })).toBe(1);
    expect(
      await recordDeliveryAttempt({
        messageId: 'm1',
        sessionId: 's1',
        now: LATER,
        nextAttemptAt: MUCH_LATER,
        error: 'boom',
      }),
    ).toBe(2);

    const row = await getDeliveryAttempt('m1');
    expect(row?.attempts).toBe(2);
    expect(row?.last_error).toBe('boom');

    await clearDeliveryAttempt('m1');
    expect(await getDeliveryAttempt('m1')).toBeUndefined();
  });

  it('setStopIntent upserts without disturbing an existing incarnation', async () => {
    // No row yet: the upsert seeds incarnation 0 so the intent has a home.
    await setStopIntent('s1', 'stop', NOW);
    expect((await getSessionClaim('s1'))?.incarnation).toBe(0);

    await tryClaimSession({ sessionId: 's1', instanceId: INSTANCE, expectedIncarnation: 0, now: NOW });
    await setStopIntent('s1', 'respawn_after_stop', LATER);

    const row = await getSessionClaim('s1');
    expect(row?.stop_intent).toBe('respawn_after_stop');
    expect(row?.incarnation).toBe(1);
    expect(row?.claimed_by).toBe(INSTANCE);
    expect(row?.updated_at).toBe(LATER);
  });

  it('every timestamp written is ISO-8601 UTC', async () => {
    await registerHostInstance({ instanceId: INSTANCE, installId: 'install', now: NOW, leaseExpiresAt: LATER });
    await tryClaimSession({ sessionId: 's1', instanceId: INSTANCE, expectedIncarnation: 0, now: NOW });
    await recordDeliveryAttempt({ messageId: 'm1', sessionId: 's1', now: NOW, nextAttemptAt: LATER });
    await writeWakeSignal('s1', 'test', NOW);

    const host = await getDb().get<{ started_at: string; lease_expires_at: string }>('SELECT * FROM host_instances');
    const claim = await getSessionClaim('s1');
    const attempt = await getDeliveryAttempt('m1');
    const signal = await getDb().get<{ created_at: string }>('SELECT * FROM wake_signals');

    for (const value of [
      host?.started_at,
      host?.lease_expires_at,
      claim?.claimed_at,
      claim?.updated_at,
      attempt?.last_attempt_at,
      signal?.created_at,
    ]) {
      expect(value).toMatch(ISO_UTC);
    }
  });
});
