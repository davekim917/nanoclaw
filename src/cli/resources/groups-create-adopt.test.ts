/**
 * `ncl groups create` folder race (seam 3 PR 4, Codex round 3).
 *
 * The command is documented "idempotent on --folder", and it was — the
 * `getAgentGroupByFolder` miss branch simply inserted. On the async driver that
 * lookup yields, so two operators (or an operator and a task script) running
 * the same create concurrently can both miss and both INSERT on the UNIQUE
 * folder key; the loser used to surface a raw SQLITE_CONSTRAINT_UNIQUE and
 * break the documented idempotence.
 *
 * The loss is driven deterministically: the leaf is stubbed to write the
 * winner's row and then reject with the driver's unique-violation code.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-groups-create-adopt') }));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

vi.mock('../../db/agent-groups.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/agent-groups.js')>();
  return { ...real, createAgentGroup: vi.fn(real.createAgentGroup) };
});

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getRawDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

const FOLDER = 'racy-agent';

function count(sql: string, ...params: unknown[]): number {
  return (
    getRawDb()
      .prepare(sql)
      .get(...params) as { c: number }
  ).c;
}

/** Write the row the concurrent winner would have written. */
function insertWinnerRow(): void {
  getRawDb()
    .prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('ag-winner', 'Winner', FOLDER, null, new Date().toISOString());
}

describe('groups create adopts the winner of a concurrent folder race', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initTestDb();
    runMigrations(getRawDb());
  });

  afterEach(async () => {
    vi.mocked(createAgentGroup).mockReset();
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns ok with the winner row and leaves exactly one agent group', async () => {
    vi.mocked(createAgentGroup).mockImplementationOnce(async () => {
      insertWinnerRow();
      throw Object.assign(new Error('UNIQUE constraint failed: agent_groups.folder'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      });
    });

    const resp = await dispatch(
      { id: 'req-create', command: 'groups-create', args: { folder: FOLDER, name: 'Loser' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const data = (resp as { ok: true; data: { id: string; folder: string } }).data;
    expect(data.id).toBe('ag-winner');
    expect(data.folder).toBe(FOLDER);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(1);

    // Adoption provisions the winner exactly as the existing-row branch does,
    // so the reused group is still fully configured on disk.
    expect(fs.existsSync(`${TEST_DIR}/groups/${FOLDER}`)).toBe(true);
  });

  it('still creates normally when nothing races it', async () => {
    const resp = await dispatch(
      { id: 'req-create-solo', command: 'groups-create', args: { folder: FOLDER, name: 'Solo' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(1);
    expect(count('SELECT COUNT(*) AS c FROM container_configs')).toBe(1);
  });
});
