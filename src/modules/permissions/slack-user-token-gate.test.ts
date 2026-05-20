import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import { canUseSlackUserToken } from './slack-user-token-gate.js';

/**
 * Mini-schema for gate tests. Mirrors the relevant columns from production
 * migrations (`001-initial.ts`, `036-workgroup-id.ts`) — agent_groups has
 * `workgroup_id`, messaging_groups carry `is_group`, messaging_group_agents
 * wires DM messaging_groups to their owning agent_group.
 */
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
    CREATE TABLE messaging_group_agents (
      id                 TEXT PRIMARY KEY,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
      created_at         TEXT NOT NULL,
      UNIQUE(messaging_group_id, agent_group_id)
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

/**
 * Default scaffolding: workgroup "mr" with sibling agents bo (Claude) and
 * bo-codex (Codex). Each has its own DM messaging_group with the owner
 * (Dave). One team channel and one private leads channel are wired to both
 * agents (used by the override tests).
 *
 *   agent_groups: ag-bo (wg mr), ag-bo-codex (wg mr)
 *   users:        slack-mr:UDAVE, slack-mr-codex:UDAVE (same human, different adapters)
 *   user_roles:   slack-mr:UDAVE is global owner (one record only)
 *   messaging_groups:
 *     mg-bo-dm (1:1, wired to ag-bo)
 *     mg-bo-codex-dm (1:1, wired to ag-bo-codex)
 *     mg-team-eng (channel, wired to both)
 *     mg-eng-leads-private (channel, wired to both — override test)
 *   user_dms: each adapter's UDAVE user → its respective DM mg
 */
function seedMrWorkgroup(db: Database.Database) {
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES
        ('slack-mr:UDAVE', 'human', 'Dave', '2026-01-01'),
        ('slack-mr-codex:UDAVE', 'human', 'Dave', '2026-01-01');
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
      VALUES ('slack-mr:UDAVE', 'owner', NULL, '2026-01-01');
    INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
      VALUES
        ('ag-bo', 'bo', 'bo', 'mr', '2026-01-01'),
        ('ag-bo-codex', 'bo-codex', 'bo-codex', 'mr', '2026-01-01');
    INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
      VALUES
        ('mg-bo-dm', 'slack-mr', 'slack:D-BO', 'dave-bo-dm', 0, '2026-01-01'),
        ('mg-bo-codex-dm', 'slack-mr-codex', 'slack:D-BO-CODEX', 'dave-bo-codex-dm', 0, '2026-01-01'),
        ('mg-team-eng', 'slack-mr', 'slack:C-TEAM-ENG', '#engineering', 1, '2026-01-01'),
        ('mg-eng-leads-private', 'slack-mr', 'slack:C-ENG-LEADS', '#eng-leads-private', 1, '2026-01-01');
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
      VALUES
        ('mga-bo-dm', 'mg-bo-dm', 'ag-bo', '2026-01-01'),
        ('mga-bo-codex-dm', 'mg-bo-codex-dm', 'ag-bo-codex', '2026-01-01'),
        ('mga-team-bo', 'mg-team-eng', 'ag-bo', '2026-01-01'),
        ('mga-team-bo-codex', 'mg-team-eng', 'ag-bo-codex', '2026-01-01'),
        ('mga-leads-bo', 'mg-eng-leads-private', 'ag-bo', '2026-01-01'),
        ('mga-leads-bo-codex', 'mg-eng-leads-private', 'ag-bo-codex', '2026-01-01');
    INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
      VALUES
        ('slack-mr:UDAVE', 'slack-mr', 'mg-bo-dm', '2026-01-01'),
        ('slack-mr-codex:UDAVE', 'slack-mr-codex', 'mg-bo-codex-dm', '2026-01-01');
  `);
}

describe('canUseSlackUserToken — permission gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedMrWorkgroup(db);
  });

  // ── Capability / structural denies ─────────────────────────────────────────

  it('test_capability_disabled_returns_false', () => {
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-bo-dm', { enabled: false })).toBe(false);
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-bo-dm', undefined)).toBe(false);
  });

  it('test_no_messaging_group_returns_false', () => {
    // Spawning without a session messaging_group (e.g., admin shell) — deny.
    expect(canUseSlackUserToken(db, 'ag-bo', null, { enabled: true })).toBe(false);
  });

  // ── Default safe path: owner DMs ───────────────────────────────────────────

  it('test_bo_dm_allowed_by_default', () => {
    // Session is the owner's 1:1 DM with bo (the agent on which the owner
    // role was directly granted). Allow.
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-bo-dm', { enabled: true })).toBe(true);
  });

  it('test_bo_codex_dm_allowed_via_sibling_workgroup', () => {
    // CRITICAL regression test — the production bug that motivated this PR.
    //
    // bo-codex has its own Slack adapter (`slack-mr-codex`) so the same
    // human appears as a different user_id (`slack-mr-codex:UDAVE`). The
    // operator only has owner role on `slack-mr:UDAVE`. The gate must
    // still allow because both DMs are wired to agents in the SAME
    // workgroup (mr) — sibling adapters of the same human operator.
    expect(canUseSlackUserToken(db, 'ag-bo-codex', 'mg-bo-codex-dm', { enabled: true })).toBe(true);
  });

  // ── Team channels ─────────────────────────────────────────────────────────

  it('test_team_channel_denied_by_default', () => {
    // Session is in #engineering (is_group=1) → deny.
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-team-eng', { enabled: true })).toBe(false);
  });

  it('test_team_channel_allowed_via_override', () => {
    // Operator explicitly trusts #eng-leads-private — added to also_allowed_in.
    expect(
      canUseSlackUserToken(db, 'ag-bo', 'mg-eng-leads-private', {
        enabled: true,
        also_allowed_in: ['mg-eng-leads-private'],
      }),
    ).toBe(true);
  });

  it('test_override_does_not_leak_to_unlisted_channels', () => {
    // Override is exact-match, not regex/glob. A different channel id stays denied.
    expect(
      canUseSlackUserToken(db, 'ag-bo', 'mg-team-eng', {
        enabled: true,
        also_allowed_in: ['mg-eng-leads-private'],
      }),
    ).toBe(false);
  });

  // ── No-owner / wrong-owner state ──────────────────────────────────────────

  it('test_no_owner_role_denies_default_path', () => {
    // No user_roles row exists for the owner role. Even a properly-wired
    // DM in a workgroup denies. (Override still works — see next test.)
    const freshDb = makeDb();
    freshDb.exec(`
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-orphan', 'orphan', 'orphan', 'orphan', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
        VALUES ('mg-orphan-dm', 'slack-orphan', 'slack:D-ORPHAN', 'orphan-dm', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-orphan', 'mg-orphan-dm', 'ag-orphan', '2026-01-01');
    `);
    expect(canUseSlackUserToken(freshDb, 'ag-orphan', 'mg-orphan-dm', { enabled: true })).toBe(false);
  });

  it('test_admin_user_dm_denied_default', () => {
    // user_dms entry exists for an admin (not owner) in this workgroup.
    // Default gate requires role='owner', so an admin's DM cannot satisfy.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-mr:UADMIN', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-mr:UADMIN', 'admin', NULL, '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-admin-dm', 'slack-mr', 'slack:D-ADMIN', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-admin', 'mg-admin-dm', 'ag-bo', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-mr:UADMIN', 'slack-mr', 'mg-admin-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-admin-dm', { enabled: true })).toBe(false);
  });

  it('test_scoped_owner_does_not_satisfy_default', () => {
    // user_roles also stores owners scoped to specific agent_groups
    // (agent_group_id NOT NULL). The default gate filters
    // `agent_group_id IS NULL` so scoped owners never satisfy it.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-mr:USCOPED', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-mr:USCOPED', 'owner', 'ag-bo', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-scoped-dm', 'slack-mr', 'slack:D-SCOPED', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-scoped', 'mg-scoped-dm', 'ag-bo', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-mr:USCOPED', 'slack-mr', 'mg-scoped-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-scoped-dm', { enabled: true })).toBe(false);
  });

  // ── Cross-workgroup defense ────────────────────────────────────────────────

  it('test_cross_workgroup_owner_does_not_authorize_other_workgroup_dm', () => {
    // CRITICAL: Codex P1 catch on PR #110. If a deployment hosts multiple
    // workgroups (e.g., madison-reed AND illysium), an owner in one
    // workgroup must NOT authorize the slack-user-token MCP in a DM
    // belonging to a different workgroup — even if user_id handles collide.
    //
    // Setup: workgroup `illy` exists with its own agent and DM. The session
    // is in illy's DM, but the only owner record is `slack-mr:UDAVE` from
    // the mr workgroup. Gate must deny.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES ('slack-illy:UCOLLIDE', 'human', '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-illie', 'illie', 'illie', 'illy', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-illie-dm', 'slack-illy', 'slack:D-ILLIE', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-illie-dm', 'mg-illie-dm', 'ag-illie', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-illy:UCOLLIDE', 'slack-illy', 'mg-illie-dm', '2026-01-01');
    `);
    // No owner record for illy workgroup → gate denies even though mr has
    // a global owner.
    expect(canUseSlackUserToken(db, 'ag-illie', 'mg-illie-dm', { enabled: true })).toBe(false);
  });

  it('test_owner_dm_outside_session_workgroup_does_not_authorize', () => {
    // The handle-collision attack the workgroup model defeats:
    //
    // - Workgroup illy exists with agent ag-illie and user-dm for slack-illy:UDAVE.
    // - The MR owner (slack-mr:UDAVE) has the global owner role.
    // - The session is in mg-illie-dm (illy workgroup).
    //
    // A handle-parsing gate would have matched the MR owner via its handle
    // to the illy DM and allowed. The workgroup gate requires the owner's
    // OWN user_dms to be in the session's workgroup — not just a handle
    // match. Deny.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES ('slack-illy:UDAVE', 'human', '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-illie', 'illie', 'illie', 'illy', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-illie-dm', 'slack-illy', 'slack:D-ILLIE', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-illie', 'mg-illie-dm', 'ag-illie', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-illy:UDAVE', 'slack-illy', 'mg-illie-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(db, 'ag-illie', 'mg-illie-dm', { enabled: true })).toBe(false);
  });

  it('test_owner_in_both_workgroups_authorizes_only_their_own', () => {
    // The dual-workgroup operator: Dave is owner of BOTH mr and illy.
    // Each workgroup's DM independently authorizes only itself. The
    // workgroups don't bleed into each other.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES
          ('slack-illy:UDAVE', 'human', '2026-01-01'),
          ('slack-illy-codex:UDAVE', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-illy:UDAVE', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES
          ('ag-illie', 'illie', 'illie', 'illy', '2026-01-01'),
          ('ag-illie-codex', 'illie-codex', 'illie-codex', 'illy', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES
          ('mg-illie-dm', 'slack-illy', 'slack:D-ILLIE', 0, '2026-01-01'),
          ('mg-illie-codex-dm', 'slack-illy-codex', 'slack:D-ILLIE-CODEX', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES
          ('mga-illie', 'mg-illie-dm', 'ag-illie', '2026-01-01'),
          ('mga-illie-codex', 'mg-illie-codex-dm', 'ag-illie-codex', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES
          ('slack-illy:UDAVE', 'slack-illy', 'mg-illie-dm', '2026-01-01'),
          ('slack-illy-codex:UDAVE', 'slack-illy-codex', 'mg-illie-codex-dm', '2026-01-01');
    `);
    // Both workgroups' DMs allow now (each has its own owner record + DM)
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-bo-dm', { enabled: true })).toBe(true);
    expect(canUseSlackUserToken(db, 'ag-bo-codex', 'mg-bo-codex-dm', { enabled: true })).toBe(true);
    expect(canUseSlackUserToken(db, 'ag-illie', 'mg-illie-dm', { enabled: true })).toBe(true);
    expect(canUseSlackUserToken(db, 'ag-illie-codex', 'mg-illie-codex-dm', { enabled: true })).toBe(true);
  });

  it('test_workspace_literally_named_with_codex_suffix_isolated', () => {
    // Codex's #2 P1 catch: an operator could legitimately name a Slack
    // workspace ending in `-codex`. Earlier suffix-stripping logic would
    // collapse `slack-acme-codex` with `slack-acme` (different workspaces).
    // The workgroup gate doesn't parse channel_type strings — workspaces
    // are isolated by their agent_groups' workgroup_id values regardless
    // of how they're named.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES
          ('slack-acme:UDAVE', 'human', '2026-01-01'),
          ('slack-acme-codex:UDAVE', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-acme:UDAVE', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES
          ('ag-acme', 'acme', 'acme', 'acme', '2026-01-01'),
          ('ag-acme-codex-ws', 'acme-codex-ws', 'acme-codex-ws', 'acme-codex-ws', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES
          ('mg-acme-dm', 'slack-acme', 'slack:D-ACME', 0, '2026-01-01'),
          ('mg-acme-codex-ws-dm', 'slack-acme-codex', 'slack:D-ACME-CODEX-WS', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES
          ('mga-acme', 'mg-acme-dm', 'ag-acme', '2026-01-01'),
          ('mga-acme-codex-ws', 'mg-acme-codex-ws-dm', 'ag-acme-codex-ws', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES
          ('slack-acme:UDAVE', 'slack-acme', 'mg-acme-dm', '2026-01-01'),
          ('slack-acme-codex:UDAVE', 'slack-acme-codex', 'mg-acme-codex-ws-dm', '2026-01-01');
    `);
    // The DM in the "acme-codex-ws" workspace must NOT inherit acme's owner
    // (and vice versa). String-parsing approaches collapsed these; the
    // workgroup model keeps them isolated.
    expect(canUseSlackUserToken(db, 'ag-acme', 'mg-acme-dm', { enabled: true })).toBe(true); // own owner
    expect(canUseSlackUserToken(db, 'ag-acme-codex-ws', 'mg-acme-codex-ws-dm', { enabled: true })).toBe(false); // no owner
  });

  // ── Defense-in-depth: is_group = 0 / standalone workgroup ────────────────

  it('test_is_group_one_denies_even_with_workgroup_match', () => {
    // The override path is the only way for a channel (is_group=1) to
    // satisfy the gate. The default path requires is_group=0.
    db.exec(`UPDATE messaging_groups SET is_group = 1 WHERE id = 'mg-bo-dm';`);
    expect(canUseSlackUserToken(db, 'ag-bo', 'mg-bo-dm', { enabled: true })).toBe(false);
  });

  it('test_standalone_workgroup_works_with_own_owner', () => {
    // A standalone (workgroup-of-1) agent works the same way — workgroup_id
    // equals the agent's own slug.
    const sd = makeDb();
    sd.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-solo:UDAVE', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-solo:UDAVE', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-solo', 'solo', 'solo', 'solo', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-solo-dm', 'slack-solo', 'slack:D-SOLO', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-solo', 'mg-solo-dm', 'ag-solo', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-solo:UDAVE', 'slack-solo', 'mg-solo-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(sd, 'ag-solo', 'mg-solo-dm', { enabled: true })).toBe(true);
  });

  it('test_workgroup_id_null_denies', () => {
    // Pre-migration installs without workgroup_id set: gate denies (we
    // can't determine the trust boundary without workgroup membership).
    // The override path still works for explicit operator authorization.
    const pre = makeDb();
    pre.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-pre:UDAVE', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-pre:UDAVE', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-pre', 'pre', 'pre', NULL, '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-pre-dm', 'slack-pre', 'slack:D-PRE', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-pre', 'mg-pre-dm', 'ag-pre', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-pre:UDAVE', 'slack-pre', 'mg-pre-dm', '2026-01-01');
    `);
    expect(canUseSlackUserToken(pre, 'ag-pre', 'mg-pre-dm', { enabled: true })).toBe(false);
  });

  it('test_override_works_when_user_dms_cache_cold', () => {
    // The override path is independent of every other check — no
    // workgroup, no user_dms, no owner record required. Defense in case
    // the router prewarm regresses or fresh-install operators test before
    // any inbound has flowed.
    const cold = makeDb();
    cold.exec(`
      INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
        VALUES ('mg-cold', 'slack-cold', 'slack:D-COLD', 'cold-dm', 0, '2026-01-01');
    `);
    expect(
      canUseSlackUserToken(cold, 'ag-irrelevant', 'mg-cold', {
        enabled: true,
        also_allowed_in: ['mg-cold'],
      }),
    ).toBe(true);
  });
});
