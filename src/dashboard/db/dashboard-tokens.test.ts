import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { closeDb, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import { consumeDashboardToken, issueDashboardToken } from './dashboard-tokens.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string): void {
  getRawDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, now());
}

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  seedUser('u1');
  seedUser('u2');
});

afterEach(async () => {
  await closeDb();
});

describe('dashboard_tokens DAO', () => {
  it('test_issueDashboardToken_creates_row', async () => {
    const record = await issueDashboardToken('u1', 'hmac-abc', 24);
    expect(record.user_id).toBe('u1');
    expect(record.token_hmac).toBe('hmac-abc');
    expect(record.used_at).toBeNull();
    expect(record.id).toBeGreaterThan(0);

    const row = getRawDb().prepare('SELECT * FROM dashboard_tokens WHERE token_hmac = ?').get('hmac-abc') as
      | { user_id: string; used_at: string | null }
      | undefined;
    expect(row?.user_id).toBe('u1');
    expect(row?.used_at).toBeNull();
  });

  it('test_issueDashboardToken_duplicate_hmac_throws', async () => {
    await issueDashboardToken('u1', 'hmac-abc', 24);
    await expect(issueDashboardToken('u2', 'hmac-abc', 24)).rejects.toThrow();
  });

  it('test_consumeDashboardToken_valid', async () => {
    await issueDashboardToken('u1', 'hmac-x', 24);
    const record = await consumeDashboardToken('hmac-x');
    expect(record).not.toBeNull();
    expect(record!.user_id).toBe('u1');
    expect(record!.used_at).not.toBeNull();

    const row = getRawDb().prepare('SELECT used_at FROM dashboard_tokens WHERE token_hmac = ?').get('hmac-x') as
      | { used_at: string | null }
      | undefined;
    expect(row?.used_at).not.toBeNull();
  });

  it('test_consumeDashboardToken_already_used', async () => {
    await issueDashboardToken('u1', 'hmac-y', 24);
    await consumeDashboardToken('hmac-y');
    const second = await consumeDashboardToken('hmac-y');
    expect(second).toBeNull();
  });

  it('test_consumeDashboardToken_expired', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at)
         VALUES ('u1', 'hmac-z', datetime('now', '-25 hours'), datetime('now', '-1 hour'))`,
      )
      .run();
    const result = await consumeDashboardToken('hmac-z');
    expect(result).toBeNull();
  });

  it('test_consumeDashboardToken_concurrent_safety', async () => {
    await issueDashboardToken('u1', 'hmac-c', 24);
    // The driver serializes non-transactional statements onto one connection
    // (no driver transaction opens here — seam 3 §4.1), so two sequential
    // awaits still simulate concurrent attempts the same way the original
    // synchronous calls did.
    const r1 = await consumeDashboardToken('hmac-c');
    const r2 = await consumeDashboardToken('hmac-c');
    const successes = [r1, r2].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
  });
});
