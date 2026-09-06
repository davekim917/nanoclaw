/**
 * Portable-SQL correctness for `ncl members add`/`remove` (theme T2 PR 4,
 * case 20): adding a member twice is a no-op. `agent_group_members`'s
 * PRIMARY KEY columns are both NOT NULL, so `ON CONFLICT (user_id,
 * agent_group_id) DO NOTHING` genuinely dedupes — no NULL-PK caveat here
 * (unlike the global-role case in roles.test.ts).
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

import { initTestDb, closeDb, getRawDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createUser } from '../../modules/permissions/db/users.js';
import { lookup } from '../registry.js';
// Side-effect import: registers `members-add` / `members-remove`.
import './members.js';

const hostCtx = { caller: 'host' as const };

beforeEach(async () => {
  await initTestDb();
  runMigrations(getRawDb());
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

describe('members-add / members-remove portable SQL (case 20)', () => {
  it('adding a member twice is a no-op', async () => {
    await lookup('members-add')!.handler({ user: 'user-1', group: 'ag-1' }, hostCtx);
    await lookup('members-add')!.handler({ user: 'user-1', group: 'ag-1' }, hostCtx);
    const row = getRawDb()
      .prepare('SELECT COUNT(*) AS n FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('user-1', 'ag-1') as { n: number };
    expect(row.n).toBe(1);
  });

  it('remove deletes the membership', async () => {
    await lookup('members-add')!.handler({ user: 'user-1', group: 'ag-1' }, hostCtx);
    await lookup('members-remove')!.handler({ user: 'user-1', group: 'ag-1' }, hostCtx);
    const row = getRawDb()
      .prepare('SELECT * FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('user-1', 'ag-1');
    expect(row).toBeUndefined();
  });

  it('removing a non-existent membership throws', async () => {
    await expect(lookup('members-remove')!.handler({ user: 'user-1', group: 'ag-1' }, hostCtx)).rejects.toThrow(
      'member not found',
    );
  });
});
