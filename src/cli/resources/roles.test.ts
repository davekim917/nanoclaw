/**
 * Portable-SQL correctness for `ncl roles grant`/`revoke` (theme T2 PR 4,
 * case 20): granting a role twice is a no-op, and revoking a global
 * (agent_group_id NULL) role matches on the null-safe comparison rather than
 * `=` (which is never true against NULL).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// NOT spread: log.ts installs process-wide uncaughtException/unhandledRejection
// handlers (including process.exit(1)) at module scope — importOriginal() would
// install those in this test file's worker. Kept as a complete stub instead.
// (davekim917/nanoclaw#355 review thread)
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
}));

import { initMigratedTestDb, closeDb, getDb, createAgentGroup } from '../../db/index.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { lookup } from '../registry.js';
// Side-effect import: registers `roles-grant` / `roles-revoke`.
import './roles.js';

const hostCtx = { caller: 'host' as const };

beforeEach(async () => {
  await initMigratedTestDb();
  await createUser({ id: 'user-1', kind: 'human', display_name: null, created_at: new Date().toISOString() });
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent One',
    folder: 'agent-one',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  await closeDb();
});

describe('roles-grant / roles-revoke portable SQL (case 20)', () => {
  it('granting a scoped role twice is a no-op', async () => {
    await lookup('roles-grant')!.handler({ user: 'user-1', role: 'admin', group: 'ag-1' }, hostCtx);
    await lookup('roles-grant')!.handler({ user: 'user-1', role: 'admin', group: 'ag-1' }, hostCtx);
    const rows = await getDb().get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id = ?',
      'user-1',
      'admin',
      'ag-1',
    );
    expect(rows!.n).toBe(1);
  });

  it('revoking a global role matches a NULL agent_group_id', async () => {
    // Seed the global row directly — ON CONFLICT DO NOTHING on a PRIMARY KEY
    // that includes a nullable column does not dedupe two NULL inserts
    // (SQLite's NULL != NULL applies to PK uniqueness same as any UNIQUE
    // index), so this test seeds one row rather than granting twice.
    await getDb().run(
      'INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, ?, NULL, NULL, ?)',
      'user-1',
      'owner',
      new Date().toISOString(),
    );

    await lookup('roles-revoke')!.handler({ user: 'user-1', role: 'owner' }, hostCtx);

    const row = await getDb().get(
      'SELECT * FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL',
      'user-1',
      'owner',
    );
    expect(row).toBeUndefined();
  });

  it('revoking a non-existent role throws', async () => {
    await expect(lookup('roles-revoke')!.handler({ user: 'user-1', role: 'admin' }, hostCtx)).rejects.toThrow(
      'role not found',
    );
  });
});
