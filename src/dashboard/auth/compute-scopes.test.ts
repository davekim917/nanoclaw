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

async function seedAgentGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id.toUpperCase(), folder: id, agent_provider: null, created_at: now() });
}

async function seedUser(id: string): Promise<void> {
  await createUser({ id, kind: 'telegram', display_name: null, created_at: now() });
}

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  await seedAgentGroup('ag-1');
  await seedAgentGroup('ag-2');
});

afterEach(async () => {
  await closeDb();
});

describe('computeScopes', () => {
  it('test_computeScopes_no_roles_no_membership_locked_out', async () => {
    await seedUser('telegram:nobody');
    expect(await computeScopes('telegram:nobody')).toEqual({ role: 'member', allowed_group_ids: [], no_filter: false });
  });

  it('test_computeScopes_owner_no_filter', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await computeScopes('telegram:owner')).toEqual({ role: 'owner', allowed_group_ids: [], no_filter: true });
  });

  it('test_computeScopes_scoped_admin_unchanged', async () => {
    await seedUser('telegram:admin');
    await grantRole({
      user_id: 'telegram:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    expect(await computeScopes('telegram:admin')).toEqual({
      role: 'admin_of_group',
      allowed_group_ids: ['ag-1'],
      no_filter: false,
    });
  });

  it('test_computeScopes_member_via_agent_group_members', async () => {
    await seedUser('telegram:member');
    await addMember({ user_id: 'telegram:member', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(await computeScopes('telegram:member')).toEqual({
      role: 'member',
      allowed_group_ids: ['ag-1'],
      no_filter: false,
    });
  });

  it('test_computeScopes_member_scope_only_covers_their_own_groups', async () => {
    await seedUser('telegram:member');
    await addMember({ user_id: 'telegram:member', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    // ag-2 exists but the member was never added to it — must not leak in.
    const scopes = await computeScopes('telegram:member');
    expect(scopes.allowed_group_ids).toEqual(['ag-1']);
    expect(scopes.allowed_group_ids).not.toContain('ag-2');
  });

  it('test_computeScopes_member_unions_legacy_role_rows_and_agent_group_members', async () => {
    await seedUser('telegram:member');
    // Legacy path: a 'member' row directly in user_roles (dead-write path, kept for compat).
    getRawDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run('telegram:member', 'member', 'ag-1', now());
    // Real grant path: agent_group_members, on a different group.
    await addMember({ user_id: 'telegram:member', agent_group_id: 'ag-2', added_by: null, added_at: now() });
    expect(await computeScopes('telegram:member')).toEqual({
      role: 'member',
      allowed_group_ids: ['ag-1', 'ag-2'],
      no_filter: false,
    });
  });

  it('test_computeScopes_admin_and_global_admin_unaffected_by_membership_rows', async () => {
    await seedUser('telegram:owner');
    await grantRole({
      user_id: 'telegram:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    // Even with a membership row on top, owner behavior must stay byte-identical.
    await addMember({ user_id: 'telegram:owner', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(await computeScopes('telegram:owner')).toEqual({ role: 'owner', allowed_group_ids: [], no_filter: true });
  });
});
