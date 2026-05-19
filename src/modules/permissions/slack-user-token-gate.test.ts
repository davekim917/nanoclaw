import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import { canUseSlackUserToken } from './slack-user-token-gate.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      display_name TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE user_roles (
      user_id        TEXT NOT NULL REFERENCES users(id),
      role           TEXT NOT NULL,
      agent_group_id TEXT REFERENCES agent_groups(id),
      granted_by     TEXT,
      granted_at     TEXT NOT NULL,
      PRIMARY KEY (user_id, role, agent_group_id)
    );
    CREATE TABLE messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE user_dms (
      user_id            TEXT NOT NULL REFERENCES users(id),
      channel_type       TEXT NOT NULL,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      resolved_at        TEXT NOT NULL,
      PRIMARY KEY (user_id, channel_type)
    );
  `);
  return db;
}

function seedOwnerDm(db: Database.Database) {
  // Insert: owner user "slack:dave", their DM messaging_group "mg-owner-dm-slack",
  // and a non-DM team channel "mg-team-eng"
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('slack:dave', 'human', 'Dave', '2026-01-01');
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
      VALUES ('slack:dave', 'owner', NULL, '2026-01-01');
    INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
      VALUES
        ('mg-owner-dm-slack', 'slack', 'D-OWNER-DM', 'dave-bo-dm', 0, '2026-01-01'),
        ('mg-team-eng', 'slack', 'C-TEAM-ENG', '#engineering', 1, '2026-01-01'),
        ('mg-eng-leads-private', 'slack', 'C-ENG-LEADS', '#eng-leads-private', 1, '2026-01-01');
    INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
      VALUES ('slack:dave', 'slack', 'mg-owner-dm-slack', '2026-01-01');
  `);
}

describe('canUseSlackUserToken — permission gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedOwnerDm(db);
  });

  it('test_capability_disabled_returns_false', () => {
    expect(canUseSlackUserToken(db, 'mg-owner-dm-slack', { enabled: false })).toBe(false);
    expect(canUseSlackUserToken(db, 'mg-owner-dm-slack', undefined)).toBe(false);
  });

  it('test_no_messaging_group_returns_false', () => {
    // Spawning without a session messaging_group (e.g., admin shell) — deny.
    expect(canUseSlackUserToken(db, null, { enabled: true })).toBe(false);
  });

  it('test_owner_dm_allowed_by_default', () => {
    // Default safe path: session is owner's 1:1 DM → allow.
    expect(canUseSlackUserToken(db, 'mg-owner-dm-slack', { enabled: true })).toBe(true);
  });

  it('test_team_channel_denied_by_default', () => {
    // Session is in #engineering (is_group=1) → deny.
    expect(canUseSlackUserToken(db, 'mg-team-eng', { enabled: true })).toBe(false);
  });

  it('test_team_channel_allowed_via_override', () => {
    // Operator explicitly trusts #eng-leads-private — added to also_allowed_in.
    expect(
      canUseSlackUserToken(db, 'mg-eng-leads-private', {
        enabled: true,
        also_allowed_in: ['mg-eng-leads-private'],
      }),
    ).toBe(true);
  });

  it('test_override_does_not_leak_to_unlisted_channels', () => {
    // Override is exact-match, not regex/glob. A different channel id stays denied.
    expect(
      canUseSlackUserToken(db, 'mg-team-eng', {
        enabled: true,
        also_allowed_in: ['mg-eng-leads-private'],
      }),
    ).toBe(false);
  });

  it('test_no_owner_role_denies_default_path', () => {
    // If no owner is recorded, the default gate has nothing to compare —
    // owner's DM lookup returns no row → deny. (Override still works.)
    const freshDb = makeDb();
    freshDb.exec(`
      INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
        VALUES ('mg-orphan', 'slack', 'D-ORPHAN', 'orphan', 0, '2026-01-01');
    `);
    expect(canUseSlackUserToken(freshDb, 'mg-orphan', { enabled: true })).toBe(false);
  });

  it('test_admin_user_dm_denied_default', () => {
    // user_dms entry exists for a non-owner (admin) — that's not the owner's DM,
    // so the default gate denies. Only role='owner' counts.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack:admin', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack:admin', 'admin', NULL, '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-admin-dm', 'slack', 'D-ADMIN-DM', 0, '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack:admin', 'slack', 'mg-admin-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(db, 'mg-admin-dm', { enabled: true })).toBe(false);
  });

  it('test_is_group_zero_required_even_for_owner_user_dms', () => {
    // Defense in depth: even if a user_dms row points at a channel that's
    // somehow flagged is_group=1 (data corruption / a buggy adapter), the
    // gate still denies. user_dms entries SHOULD always be is_group=0, but
    // we don't trust the data — the JOIN enforces it.
    db.exec(`
      UPDATE messaging_groups SET is_group = 1 WHERE id = 'mg-owner-dm-slack';
    `);
    expect(canUseSlackUserToken(db, 'mg-owner-dm-slack', { enabled: true })).toBe(false);
  });

  it('test_scoped_admin_does_not_satisfy_owner_check', () => {
    // user_roles also stores admins scoped to specific agent_groups
    // (agent_group_id NOT NULL). The default gate filters
    // `agent_group_id IS NULL` so scoped admins never satisfy it.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack:scoped', 'human', '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, created_at)
        VALUES ('ag-illie', 'illie', 'illysium', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack:scoped', 'owner', 'ag-illie', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-scoped-dm', 'slack', 'D-SCOPED-DM', 0, '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack:scoped', 'slack', 'mg-scoped-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(db, 'mg-scoped-dm', { enabled: true })).toBe(false);
  });

  it('test_override_works_when_user_dms_cache_cold', () => {
    // Codex P2 catch on PR #108: user_dms is populated lazily and a first-
    // time DM may not yet have a row. The default gate denies in that
    // case (correct fail-closed), but the explicit also_allowed_in
    // override MUST still work — it doesn't depend on user_dms at all.
    //
    // Note: the prewarm fix lives in router.ts (it now populates user_dms
    // on inbound DMs from a known user). This test pins the gate's
    // contract: an override allow-list entry succeeds regardless of cache
    // state, so even if the prewarm regresses or the operator is testing
    // before any inbound has flowed, the override is dependable.
    const freshDb = makeDb();
    freshDb.exec(`
      INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
        VALUES ('mg-cold-channel', 'slack', 'C-COLD', '#cold-channel', 1, '2026-01-01');
    `);
    expect(
      canUseSlackUserToken(freshDb, 'mg-cold-channel', {
        enabled: true,
        also_allowed_in: ['mg-cold-channel'],
      }),
    ).toBe(true);
  });
});
