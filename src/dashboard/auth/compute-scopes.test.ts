/**
 * Tests for computeScopes — the dashboard scope derivation used by
 * requireAuth (router.ts) and authMeHandler (api/auth-me.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeScopes } from './compute-scopes.js';
import { closeDb, createAgentGroup, getRawDb, initTestDb, runMigrations } from '../../db/index.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { addMember } from '../../modules/permissions/db/agent-group-members.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  seedAgentGroup('ag-1');
  seedAgentGroup('ag-2');
});

afterEach(async () => {
  await closeDb();
});

describe('computeScopes', () => {
  it('test_computeScopes_no_roles_no_membership_locked_out', () => {
    seedUser('telegram:nobody');
    expect(computeScopes('telegram:nobody')).toEqual({ role: 'member', allowed_group_ids: [], no_filter: false });
  });

  it('test_computeScopes_owner_no_filter', () => {
    seedUser('telegram:owner');
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    expect(computeScopes('telegram:owner')).toEqual({ role: 'owner', allowed_group_ids: [], no_filter: true });
  });

  it('test_computeScopes_scoped_admin_unchanged', () => {
    seedUser('telegram:admin');
    grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(computeScopes('telegram:admin')).toEqual({
      role: 'admin_of_group',
      allowed_group_ids: ['ag-1'],
      no_filter: false,
    });
  });

  it('test_computeScopes_member_via_agent_group_members', () => {
    seedUser('telegram:member');
    addMember({ user_id: 'telegram:member', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(computeScopes('telegram:member')).toEqual({
      role: 'member',
      allowed_group_ids: ['ag-1'],
      no_filter: false,
    });
  });

  it('test_computeScopes_member_scope_only_covers_their_own_groups', () => {
    seedUser('telegram:member');
    addMember({ user_id: 'telegram:member', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    // ag-2 exists but the member was never added to it — must not leak in.
    const scopes = computeScopes('telegram:member');
    expect(scopes.allowed_group_ids).toEqual(['ag-1']);
    expect(scopes.allowed_group_ids).not.toContain('ag-2');
  });

  it('test_computeScopes_member_unions_legacy_role_rows_and_agent_group_members', () => {
    seedUser('telegram:member');
    // Legacy path: a 'member' row directly in user_roles (dead-write path, kept for compat).
    getRawDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run('telegram:member', 'member', 'ag-1', now());
    // Real grant path: agent_group_members, on a different group.
    addMember({ user_id: 'telegram:member', agent_group_id: 'ag-2', added_by: null, added_at: now() });
    expect(computeScopes('telegram:member')).toEqual({
      role: 'member',
      allowed_group_ids: ['ag-1', 'ag-2'],
      no_filter: false,
    });
  });

  it('test_computeScopes_admin_and_global_admin_unaffected_by_membership_rows', () => {
    seedUser('telegram:owner');
    grantRole({ user_id: 'telegram:owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    // Even with a membership row on top, owner behavior must stay byte-identical.
    addMember({ user_id: 'telegram:owner', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(computeScopes('telegram:owner')).toEqual({ role: 'owner', allowed_group_ids: [], no_filter: true });
  });
});
