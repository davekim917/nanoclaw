import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { closeDb, initTestDb, runMigrations, getRawDb } from '../../../db/index.js';
import { isAnyAdmin } from './user-roles.js';

function now(): string {
  return new Date().toISOString();
}

function insertUser(id: string): void {
  getRawDb()
    .prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)")
    .run(id, now());
}

function insertRole(userId: string, role: 'owner' | 'admin', agentGroupId: string | null): void {
  if (agentGroupId) {
    getRawDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run(userId, role, agentGroupId, now());
  } else {
    getRawDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, NULL, ?)',
      )
      .run(userId, role, now());
  }
}

beforeEach(async () => {
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
});

afterEach(async () => {
  await closeDb();
});

describe('isAnyAdmin', () => {
  it('test_isAnyAdmin_owner_true', async () => {
    insertUser('u1');
    insertRole('u1', 'owner', null);
    expect(await isAnyAdmin('u1')).toBe(true);
  });

  it('test_isAnyAdmin_global_admin_true', async () => {
    // Global admin = role='admin' with no agent_group_id scope
    insertUser('u2');
    insertRole('u2', 'admin', null);
    expect(await isAnyAdmin('u2')).toBe(true);
  });

  it('test_isAnyAdmin_scoped_admin_true', async () => {
    insertUser('u3');
    getRawDb()
      .prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-1', 'Test', 'test', ?)")
      .run(now());
    insertRole('u3', 'admin', 'ag-1');
    expect(await isAnyAdmin('u3')).toBe(true);
  });

  it('test_isAnyAdmin_member_false', async () => {
    insertUser('u4');
    getRawDb()
      .prepare("INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('ag-2', 'Test2', 'test2', ?)")
      .run(now());
    // member is not a valid UserRoleKind — insert directly and verify isAnyAdmin returns false
    getRawDb()
      .prepare(
        'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, ?, NULL, ?)',
      )
      .run('u4', 'member', 'ag-2', now());
    expect(await isAnyAdmin('u4')).toBe(false);
  });

  it('test_isAnyAdmin_no_role_false', async () => {
    expect(await isAnyAdmin('u-nonexistent')).toBe(false);
  });
});
