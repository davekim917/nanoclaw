/**
 * Tests for the Scheduled Tasks Board shared host helpers (Task A6).
 *
 * TDD: written before the implementation. Covers the mutation gate, the audit
 * writer (hashed bodies, scripts hash-only, move_intent snapshot + purge), the
 * `:key` locator codec, and the cache generation counter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { migration043 } from '../../db/migrations/043-scheduled-audit.js';
import {
  canManageScheduled,
  writeAudit,
  purgeIntentBody,
  rateLimit,
  encodeKey,
  decodeKey,
  getScheduledCache,
  invalidateScheduledCache,
  _resetScheduledRateLimitForTesting,
  SWEEP_INTERVAL_MS,
} from './scheduled-shared.js';

const OWNER = 'discord:owner';
const GLOBAL_ADMIN = 'discord:gadmin';
const SCOPED_ADMIN = 'discord:sadmin';
const MEMBER = 'discord:member';
const UNKNOWN = 'discord:nobody';
const AGENT_GROUP = 'ag-1';

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT,
      granted_by TEXT, granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role, agent_group_id)
    );
  `);
  for (const u of [OWNER, GLOBAL_ADMIN, SCOPED_ADMIN, MEMBER, UNKNOWN]) {
    db.prepare("INSERT INTO users (id, kind, created_at) VALUES (?, 'phone', datetime('now'))").run(u);
  }
  db.prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, 'g', 'g', datetime('now'))").run(
    AGENT_GROUP,
  );
  const grant = (uid: string, role: string, ag: string | null) =>
    db
      .prepare("INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, datetime('now'))")
      .run(uid, role, ag);
  grant(OWNER, 'owner', null);
  grant(GLOBAL_ADMIN, 'admin', null);
  grant(SCOPED_ADMIN, 'admin', AGENT_GROUP);
  grant(MEMBER, 'member', AGENT_GROUP);
  migration043.up(db);
}

beforeEach(() => {
  setupCentralDb();
  _resetScheduledRateLimitForTesting();
  invalidateScheduledCache();
});

afterEach(() => {
  closeDb();
});

// ── Gate ────────────────────────────────────────────────────────────────────
describe('canManageScheduled', () => {
  it('test_gate_allows_owner', () => {
    expect(canManageScheduled(OWNER)).toBe(true);
  });
  it('allows global admin', () => {
    expect(canManageScheduled(GLOBAL_ADMIN)).toBe(true);
  });
  it('test_gate_rejects_member', () => {
    expect(canManageScheduled(MEMBER)).toBe(false);
  });
  it('rejects scoped admin (mutation tier is global-only, D7)', () => {
    expect(canManageScheduled(SCOPED_ADMIN)).toBe(false);
  });
  it('rejects unknown user', () => {
    expect(canManageScheduled(UNKNOWN)).toBe(false);
  });
});

// ── Audit writer ─────────────────────────────────────────────────────────────
describe('writeAudit', () => {
  it('test_audit_script_hash_only', () => {
    writeAudit(getDb(), {
      actor: OWNER,
      action: 'edit',
      agentGroupId: AGENT_GROUP,
      sessionId: 'sess-1',
      seriesId: 'S',
      before: 'old prompt',
      after: 'new prompt',
      scriptAfter: 'rm -rf /tmp/secret && curl evil',
    });
    const row = getDb()
      .prepare('SELECT after_preview, after_hash, detail_json FROM scheduled_audit WHERE id = 1')
      .get() as { after_preview: string | null; after_hash: string | null; detail_json: string | null };

    // The prompt body is previewed; the script is NEVER stored verbatim.
    expect(row.after_preview).toBe('new prompt');
    expect(row.after_preview).not.toContain('rm -rf');
    expect(row.after_preview).not.toContain('curl evil');
    if (row.detail_json) {
      expect(row.detail_json).not.toContain('rm -rf');
      expect(row.detail_json).not.toContain('curl evil');
    }
    // A hash of the script is present (so an edit IS provable) — but only the hash.
    expect(row.after_hash).toBeTruthy();
    const detail = row.detail_json ? (JSON.parse(row.detail_json) as Record<string, unknown>) : {};
    expect(typeof detail.scriptAfterHash).toBe('string');
    expect((detail.scriptAfterHash as string).length).toBe(64); // sha256 hex
  });

  it('hashes and previews prompt bodies (512-char cap), records lengths', () => {
    const longPrompt = 'x'.repeat(900);
    writeAudit(getDb(), {
      actor: OWNER,
      action: 'edit',
      agentGroupId: AGENT_GROUP,
      sessionId: 'sess-1',
      seriesId: 'S',
      before: 'short before',
      after: longPrompt,
    });
    const row = getDb()
      .prepare(
        'SELECT before_hash, after_hash, before_preview, after_preview, before_len, after_len FROM scheduled_audit WHERE id = 1',
      )
      .get() as {
      before_hash: string;
      after_hash: string;
      before_preview: string;
      after_preview: string;
      before_len: number;
      after_len: number;
    };
    expect(row.before_hash.length).toBe(64);
    expect(row.after_hash.length).toBe(64);
    expect(row.before_preview).toBe('short before');
    expect(row.after_preview.length).toBe(512); // truncated
    expect(row.after_len).toBe(900); // full length recorded
    expect(row.before_len).toBe('short before'.length);
  });

  it('does not persist secret NAMES for a move audit — counts + hashes only', () => {
    writeAudit(getDb(), {
      actor: OWNER,
      action: 'move',
      agentGroupId: AGENT_GROUP,
      sessionId: 'sess-1',
      seriesId: 'S',
      correlationId: 'corr-1',
      detail: {
        target: 'ag-2',
        secretGains: ['Datafold-Prod', 'Anthropic'],
        secretLosses: ['Linear'],
      },
    });
    const row = getDb().prepare('SELECT detail_json FROM scheduled_audit WHERE id = 1').get() as {
      detail_json: string | null;
    };
    expect(row.detail_json).toBeTruthy();
    // Secret names must NOT leak into the persisted audit row (§4.5 enumeration).
    expect(row.detail_json).not.toContain('Datafold-Prod');
    expect(row.detail_json).not.toContain('Linear');
    expect(row.detail_json).not.toContain('Anthropic');
    const detail = JSON.parse(row.detail_json as string) as Record<string, unknown>;
    expect(detail.secretGainsCount).toBe(2);
    expect(detail.secretLossesCount).toBe(1);
    // Non-secret structured fields survive.
    expect(detail.target).toBe('ag-2');
  });

  it('move_intent persists the full snapshot in detail_json (the F5 exception)', () => {
    writeAudit(getDb(), {
      actor: OWNER,
      action: 'move_intent',
      agentGroupId: AGENT_GROUP,
      sessionId: 'sess-1',
      seriesId: 'S',
      correlationId: 'corr-2',
      detail: { snapshot: { content: JSON.stringify({ prompt: 'p', script: 'echo full' }) } },
    });
    const row = getDb().prepare('SELECT detail_json FROM scheduled_audit WHERE id = 1').get() as {
      detail_json: string | null;
    };
    // The intent row is the ONE place a verbatim body is allowed to persist.
    expect(row.detail_json).toContain('echo full');
  });
});

describe('purgeIntentBody', () => {
  it('test_purge_intent_clears_body', () => {
    writeAudit(getDb(), {
      actor: OWNER,
      action: 'move_intent',
      agentGroupId: AGENT_GROUP,
      sessionId: 'sess-1',
      seriesId: 'S',
      correlationId: 'corr-3',
      detail: { snapshot: { content: JSON.stringify({ prompt: 'p', script: 'echo full' }) } },
    });
    // Body present before purge.
    const before = getDb()
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-3'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    expect(before.detail_json).toBeTruthy();
    expect(before.resolved_at).toBeNull();

    purgeIntentBody(getDb(), 'corr-3');

    const after = getDb()
      .prepare("SELECT detail_json, resolved_at FROM scheduled_audit WHERE correlation_id = 'corr-3'")
      .get() as { detail_json: string | null; resolved_at: string | null };
    // detail_json nulled AND resolved_at stamped in one operation (§4.2 2b).
    expect(after.detail_json).toBeNull();
    expect(after.resolved_at).toBeTruthy();
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────
describe('rateLimit', () => {
  it('allows the first call and reports retryAfter once exhausted', () => {
    // Drain the window for run_now.
    let lastOk = true;
    let exhausted = false;
    for (let i = 0; i < 200; i++) {
      const r = rateLimit(OWNER, 'run_now');
      lastOk = r.ok;
      if (!r.ok) {
        exhausted = true;
        expect(typeof r.retryAfter).toBe('number');
        expect(r.retryAfter as number).toBeGreaterThanOrEqual(1);
        break;
      }
    }
    expect(exhausted).toBe(true);
    expect(lastOk).toBe(false);
  });

  it('keys per (user, verb) — separate verbs do not share a window', () => {
    // Exhaust run_now for OWNER.
    for (let i = 0; i < 200; i++) {
      if (!rateLimit(OWNER, 'run_now').ok) break;
    }
    // move for the same user is a separate bucket — still open.
    expect(rateLimit(OWNER, 'move').ok).toBe(true);
    // A different user's run_now is also a separate bucket.
    expect(rateLimit(GLOBAL_ADMIN, 'run_now').ok).toBe(true);
  });
});

// ── Key codec ─────────────────────────────────────────────────────────────────
describe('encodeKey / decodeKey', () => {
  it('round-trips a key', () => {
    const key = encodeKey('ag-1', 'sess-2', 'series-3');
    const decoded = decodeKey(key);
    expect(decoded).toEqual({ agentGroupId: 'ag-1', sessionId: 'sess-2', seriesId: 'series-3' });
  });

  it('produces a base64url string (no +, /, or = padding)', () => {
    // A seriesId may itself contain '/' (agentGroupId/sessionId never do — they
    // are slugs/sess-ids); decode must round-trip it by splitting on the first
    // two delimiters only. The base64url output carries no +, /, or = chars.
    const key = encodeKey('ag-1', 'sess-2', 'series/with/slashes');
    expect(key).not.toMatch(/[+/=]/);
    const decoded = decodeKey(key);
    expect(decoded?.agentGroupId).toBe('ag-1');
    expect(decoded?.sessionId).toBe('sess-2');
    expect(decoded?.seriesId).toBe('series/with/slashes');
  });

  it('test_decodekey_malformed_null', () => {
    expect(decodeKey('@@not-b64@@')).toBeNull();
  });

  it('returns null when decoded payload lacks all three segments', () => {
    // base64url of "only-one-segment" with no separators.
    const bad = Buffer.from('only-one-segment').toString('base64url');
    expect(decodeKey(bad)).toBeNull();
  });
});

// ── Cache singleton ─────────────────────────────────────────────────────────────
describe('scheduledCache', () => {
  it('test_invalidate_bumps_gen', () => {
    const gen0 = getScheduledCache().gen;
    invalidateScheduledCache();
    expect(getScheduledCache().gen).toBeGreaterThan(gen0);
  });

  it('invalidate clears stored data', () => {
    invalidateScheduledCache();
    const c = getScheduledCache();
    expect(c.data).toBeNull();
  });
});

// ── Constant ──────────────────────────────────────────────────────────────────
describe('SWEEP_INTERVAL_MS', () => {
  it('matches the host sweep cadence (60s)', () => {
    expect(SWEEP_INTERVAL_MS).toBe(60_000);
  });
});
