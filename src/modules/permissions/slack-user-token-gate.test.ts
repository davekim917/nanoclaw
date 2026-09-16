import Database from 'better-sqlite3';
import { describe, expect, it, beforeEach } from 'vitest';

import { isOwnerSafeSlackSession } from './slack-user-token-gate.js';

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
 * Default scaffolding: workgroup "retail" with sibling agents primary (Claude) and
 * example-assistant-codex (Codex). Each has its own DM messaging_group with the owner
 * (Operator). One team channel and one private leads channel are wired to both
 * agents (used by the override tests).
 *
 *   agent_groups: ag-primary (wg retail), ag-example-assistant-codex (wg retail)
 *   users:        slack-retail:UOWNER, slack-retail-codex:UOWNER (same human, different adapters)
 *   user_roles:   slack-retail:UOWNER is global owner (one record only)
 *   messaging_groups:
 *     mg-primary-dm (1:1, wired to ag-primary)
 *     mg-example-assistant-codex-dm (1:1, wired to ag-example-assistant-codex)
 *     mg-team-eng (channel, wired to both)
 *     mg-eng-leads-private (channel, wired to both — override test)
 *   user_dms: each adapter's UOWNER user → its respective DM mg
 */
function seedRetailWorkgroup(db: Database.Database) {
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES
        ('slack-retail:UOWNER', 'human', 'Operator', '2026-01-01'),
        ('slack-retail-codex:UOWNER', 'human', 'Operator', '2026-01-01');
    INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
      VALUES ('slack-retail:UOWNER', 'owner', NULL, '2026-01-01');
    INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
      VALUES
        ('ag-primary', 'primary', 'primary', 'retail', '2026-01-01'),
        ('ag-example-assistant-codex', 'example-assistant-codex', 'example-assistant-codex', 'retail', '2026-01-01');
    INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
      VALUES
        ('mg-primary-dm', 'slack-retail', 'slack:D-PRIMARY', 'operator-primary-dm', 0, '2026-01-01'),
        ('mg-example-assistant-codex-dm', 'slack-retail-codex', 'slack:D-example-assistant-codex', 'operator-example-assistant-codex-dm', 0, '2026-01-01'),
        ('mg-team-eng', 'slack-retail', 'slack:C-TEAM-ENG', '#engineering', 1, '2026-01-01'),
        ('mg-eng-leads-private', 'slack-retail', 'slack:C-ENG-LEADS', '#eng-leads-private', 1, '2026-01-01');
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
      VALUES
        ('mga-primary-dm', 'mg-primary-dm', 'ag-primary', '2026-01-01'),
        ('mga-example-assistant-codex-dm', 'mg-example-assistant-codex-dm', 'ag-example-assistant-codex', '2026-01-01'),
        ('mga-team-primary', 'mg-team-eng', 'ag-primary', '2026-01-01'),
        ('mga-team-example-assistant-codex', 'mg-team-eng', 'ag-example-assistant-codex', '2026-01-01'),
        ('mga-leads-primary', 'mg-eng-leads-private', 'ag-primary', '2026-01-01'),
        ('mga-leads-example-assistant-codex', 'mg-eng-leads-private', 'ag-example-assistant-codex', '2026-01-01');
    INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
      VALUES
        ('slack-retail:UOWNER', 'slack-retail', 'mg-primary-dm', '2026-01-01'),
        ('slack-retail-codex:UOWNER', 'slack-retail-codex', 'mg-example-assistant-codex-dm', '2026-01-01');
  `);
}

describe('isOwnerSafeSlackSession — owner-safety gate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedRetailWorkgroup(db);
  });

  // ── Structural denies ─────────────────────────────────────────────────────

  it('test_no_messaging_group_returns_false', () => {
    // Spawning without a session messaging_group (e.g., admin shell) — deny.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', null, undefined)).toBe(false);
  });

  // ── Default safe path: owner DMs ───────────────────────────────────────────

  it('test_bo_dm_allowed_by_default', () => {
    // Session is the owner's 1:1 DM with primary (the agent on which the owner
    // role was directly granted). Allow.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-primary-dm', undefined)).toBe(true);
  });

  it('test_example-assistant-codex_dm_allowed_via_sibling_workgroup', () => {
    // CRITICAL regression test — the production bug that motivated this PR.
    //
    // example-assistant-codex has its own Slack adapter (`slack-retail-codex`) so the same
    // human appears as a different user_id (`slack-retail-codex:UOWNER`). The
    // operator only has owner role on `slack-retail:UOWNER`. The gate must
    // still allow because both DMs are wired to agents in the SAME
    // workgroup (retail) — sibling adapters of the same human operator.
    expect(isOwnerSafeSlackSession(db, 'ag-example-assistant-codex', 'mg-example-assistant-codex-dm', undefined)).toBe(
      true,
    );
  });

  // ── Team channels ─────────────────────────────────────────────────────────

  it('test_team_channel_denied_by_default', () => {
    // Session is in #engineering (is_group=1) → deny.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-team-eng', undefined)).toBe(false);
  });

  it('test_team_channel_allowed_via_override', () => {
    // Operator explicitly trusts #eng-leads-private — added to also_allowed_in.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-eng-leads-private', ['mg-eng-leads-private'])).toBe(true);
  });

  it('test_override_does_not_leak_to_unlisted_channels', () => {
    // Override is exact-match, not regex/glob. A different channel id stays denied.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-team-eng', ['mg-eng-leads-private'])).toBe(false);
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
    expect(isOwnerSafeSlackSession(freshDb, 'ag-orphan', 'mg-orphan-dm', undefined)).toBe(false);
  });

  it('test_admin_user_dm_denied_default', () => {
    // user_dms entry exists for an admin (not owner) in this workgroup.
    // Default gate requires role='owner', so an admin's DM cannot satisfy.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-retail:UADMIN', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-retail:UADMIN', 'admin', NULL, '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-admin-dm', 'slack-retail', 'slack:D-ADMIN', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-admin', 'mg-admin-dm', 'ag-primary', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-retail:UADMIN', 'slack-retail', 'mg-admin-dm', '2026-01-01');
    `);
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-admin-dm', undefined)).toBe(false);
  });

  it('test_scoped_owner_does_not_satisfy_default', () => {
    // user_roles also stores owners scoped to specific agent_groups
    // (agent_group_id NOT NULL). The default gate filters
    // `agent_group_id IS NULL` so scoped owners never satisfy it.
    db.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-retail:USCOPED', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-retail:USCOPED', 'owner', 'ag-primary', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-scoped-dm', 'slack-retail', 'slack:D-SCOPED', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-scoped', 'mg-scoped-dm', 'ag-primary', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-retail:USCOPED', 'slack-retail', 'mg-scoped-dm', '2026-01-01');
    `);
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-scoped-dm', undefined)).toBe(false);
  });

  // ── Cross-workgroup defense ────────────────────────────────────────────────

  it('test_cross_workgroup_owner_does_not_authorize_other_workgroup_dm', () => {
    // CRITICAL: Codex P1 catch on PR #110. If a deployment hosts multiple
    // workgroups (e.g., example-retail AND example-labs), an owner in one
    // workgroup must NOT authorize the Slack user token in a DM
    // belonging to a different workgroup — even if user_id handles collide.
    //
    // Setup: workgroup `labs` exists with its own agent and DM. The session
    // is in labs's DM, but the only owner record is `slack-retail:UOWNER` from
    // the retail workgroup. Gate must deny.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES ('slack-labs:UCOLLIDE', 'human', '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-helper', 'helper', 'helper', 'labs', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-helper-dm', 'slack-labs', 'slack:D-HELPER', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-helper-dm', 'mg-helper-dm', 'ag-helper', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-labs:UCOLLIDE', 'slack-labs', 'mg-helper-dm', '2026-01-01');
    `);
    // No owner record for labs workgroup → gate denies even though retail has
    // a global owner.
    expect(isOwnerSafeSlackSession(db, 'ag-helper', 'mg-helper-dm', undefined)).toBe(false);
  });

  it('test_owner_dm_outside_session_workgroup_does_not_authorize', () => {
    // The handle-collision attack the workgroup model defeats:
    //
    // - Workgroup labs exists with agent ag-helper and user-dm for slack-labs:UOWNER.
    // - The Retail owner (slack-retail:UOWNER) has the global owner role.
    // - The session is in mg-helper-dm (labs workgroup).
    //
    // A handle-parsing gate would have matched the Retail owner via its handle
    // to the labs DM and allowed. The workgroup gate requires the owner's
    // OWN user_dms to be in the session's workgroup — not just a handle
    // match. Deny.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES ('slack-labs:UOWNER', 'human', '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-helper', 'helper', 'helper', 'labs', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-helper-dm', 'slack-labs', 'slack:D-HELPER', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-helper', 'mg-helper-dm', 'ag-helper', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-labs:UOWNER', 'slack-labs', 'mg-helper-dm', '2026-01-01');
    `);
    expect(isOwnerSafeSlackSession(db, 'ag-helper', 'mg-helper-dm', undefined)).toBe(false);
  });

  it('test_owner_in_both_workgroups_authorizes_only_their_own', () => {
    // The dual-workgroup operator: Operator is owner of BOTH retail and labs.
    // Each workgroup's DM independently authorizes only itself. The
    // workgroups don't bleed into each other.
    db.exec(`
      INSERT INTO users (id, kind, created_at)
        VALUES
          ('slack-labs:UOWNER', 'human', '2026-01-01'),
          ('slack-labs-codex:UOWNER', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-labs:UOWNER', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES
          ('ag-helper', 'helper', 'helper', 'labs', '2026-01-01'),
          ('ag-helper-codex', 'helper-codex', 'helper-codex', 'labs', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES
          ('mg-helper-dm', 'slack-labs', 'slack:D-HELPER', 0, '2026-01-01'),
          ('mg-helper-codex-dm', 'slack-labs-codex', 'slack:D-HELPER-CODEX', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES
          ('mga-helper', 'mg-helper-dm', 'ag-helper', '2026-01-01'),
          ('mga-helper-codex', 'mg-helper-codex-dm', 'ag-helper-codex', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES
          ('slack-labs:UOWNER', 'slack-labs', 'mg-helper-dm', '2026-01-01'),
          ('slack-labs-codex:UOWNER', 'slack-labs-codex', 'mg-helper-codex-dm', '2026-01-01');
    `);
    // Both workgroups' DMs allow now (each has its own owner record + DM)
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-primary-dm', undefined)).toBe(true);
    expect(isOwnerSafeSlackSession(db, 'ag-example-assistant-codex', 'mg-example-assistant-codex-dm', undefined)).toBe(
      true,
    );
    expect(isOwnerSafeSlackSession(db, 'ag-helper', 'mg-helper-dm', undefined)).toBe(true);
    expect(isOwnerSafeSlackSession(db, 'ag-helper-codex', 'mg-helper-codex-dm', undefined)).toBe(true);
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
          ('slack-acme:UOWNER', 'human', '2026-01-01'),
          ('slack-acme-codex:UOWNER', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-acme:UOWNER', 'owner', NULL, '2026-01-01');
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
          ('slack-acme:UOWNER', 'slack-acme', 'mg-acme-dm', '2026-01-01'),
          ('slack-acme-codex:UOWNER', 'slack-acme-codex', 'mg-acme-codex-ws-dm', '2026-01-01');
    `);
    // The DM in the "acme-codex-ws" workspace must NOT inherit acme's owner
    // (and vice versa). String-parsing approaches collapsed these; the
    // workgroup model keeps them isolated.
    expect(isOwnerSafeSlackSession(db, 'ag-acme', 'mg-acme-dm', undefined)).toBe(true); // own owner
    expect(isOwnerSafeSlackSession(db, 'ag-acme-codex-ws', 'mg-acme-codex-ws-dm', undefined)).toBe(false); // no owner
  });

  // ── Defense-in-depth: is_group = 0 / standalone workgroup ────────────────

  it('test_is_group_one_denies_even_with_workgroup_match', () => {
    // The override path is the only way for a channel (is_group=1) to
    // satisfy the gate. The default path requires is_group=0.
    db.exec(`UPDATE messaging_groups SET is_group = 1 WHERE id = 'mg-primary-dm';`);
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-primary-dm', undefined)).toBe(false);
  });

  it('test_standalone_workgroup_works_with_own_owner', () => {
    // A standalone (workgroup-of-1) agent works the same way — workgroup_id
    // equals the agent's own slug.
    const sd = makeDb();
    sd.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-solo:UOWNER', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-solo:UOWNER', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-solo', 'solo', 'solo', 'solo', '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-solo-dm', 'slack-solo', 'slack:D-SOLO', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-solo', 'mg-solo-dm', 'ag-solo', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-solo:UOWNER', 'slack-solo', 'mg-solo-dm', '2026-01-01');
    `);
    expect(isOwnerSafeSlackSession(sd, 'ag-solo', 'mg-solo-dm', undefined)).toBe(true);
  });

  it('test_workgroup_id_null_denies', () => {
    // Pre-migration installs without workgroup_id set: gate denies (we
    // can't determine the trust boundary without workgroup membership).
    // The override path still works for explicit operator authorization.
    const pre = makeDb();
    pre.exec(`
      INSERT INTO users (id, kind, created_at) VALUES ('slack-pre:UOWNER', 'human', '2026-01-01');
      INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
        VALUES ('slack-pre:UOWNER', 'owner', NULL, '2026-01-01');
      INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at)
        VALUES ('ag-pre', 'pre', 'pre', NULL, '2026-01-01');
      INSERT INTO messaging_groups (id, channel_type, platform_id, is_group, created_at)
        VALUES ('mg-pre-dm', 'slack-pre', 'slack:D-PRE', 0, '2026-01-01');
      INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
        VALUES ('mga-pre', 'mg-pre-dm', 'ag-pre', '2026-01-01');
      INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
        VALUES ('slack-pre:UOWNER', 'slack-pre', 'mg-pre-dm', '2026-01-01');
    `);
    expect(isOwnerSafeSlackSession(pre, 'ag-pre', 'mg-pre-dm', undefined)).toBe(false);
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
    expect(isOwnerSafeSlackSession(cold, 'ag-irrelevant', 'mg-cold', ['mg-cold'])).toBe(true);
  });
});

describe('isOwnerSafeSlackSession — credential-layer predicate', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedRetailWorkgroup(db);
  });

  it('owner 1:1 DM is owner-safe', () => {
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-primary-dm', undefined)).toBe(true);
  });

  it('sibling Codex DM is owner-safe via workgroup match', () => {
    expect(isOwnerSafeSlackSession(db, 'ag-example-assistant-codex', 'mg-example-assistant-codex-dm', undefined)).toBe(
      true,
    );
  });

  it('group channel is NOT owner-safe by default (→ non-owner-safe → Slack withheld)', () => {
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-team-eng', undefined)).toBe(false);
  });

  it('group channel becomes owner-safe when listed in also_allowed_in', () => {
    // This is exactly how Operator's personal Discord channel (is_group=1) is
    // marked owner-safe so siblings keep full Slack there.
    expect(isOwnerSafeSlackSession(db, 'ag-primary', 'mg-team-eng', ['mg-team-eng'])).toBe(true);
  });

  it('no messaging group (admin shell) is NOT owner-safe — fail-closed', () => {
    expect(isOwnerSafeSlackSession(db, 'ag-primary', null, ['mg-team-eng'])).toBe(false);
  });
});
