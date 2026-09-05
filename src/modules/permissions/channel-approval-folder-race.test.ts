/**
 * Channel-registration agent folder race (seam 3 PR 4, Codex round 3).
 *
 * `createNewAgentGroup` derives a folder in a `while (await
 * getAgentGroupByFolder(...))` loop and then inserts. The loop yields on the
 * async driver, so two approvers naming agents that normalize to the same
 * folder can both settle on it and both INSERT on the UNIQUE folder key.
 *
 * Losing is NOT adoptable here — the winner's row is a different operator's
 * agent, with its own name and its own channel to wire — so the loser must
 * re-allocate and get its OWN group. Before the fix the raw unique violation
 * escaped, and it escaped from a router interceptor that had ALREADY deleted
 * the approver's `awaitingNameInput` entry: no agent, no card, no message.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-channel-approval-folder-race') }));

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
import { createNewAgentGroup } from './channel-approval.js';

function now(): string {
  return new Date().toISOString();
}

function count(sql: string): number {
  return (getRawDb().prepare(sql).get() as { c: number }).c;
}

/** Write the row the concurrent winner would have written for `folder`. */
function insertWinnerRow(folder: string): void {
  getRawDb()
    .prepare('INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(`ag-winner-${folder}`, 'Winner', folder, null, now());
}

describe('createNewAgentGroup survives a concurrent folder allocation', () => {
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

  it('re-allocates onto the next suffix instead of throwing', async () => {
    vi.mocked(createAgentGroup).mockImplementationOnce(async () => {
      insertWinnerRow('helper');
      throw Object.assign(new Error('UNIQUE constraint failed: agent_groups.folder'), {
        code: 'SQLITE_CONSTRAINT_UNIQUE',
      });
    });

    const ag = await createNewAgentGroup('Helper');

    // Our group exists, on its own folder, and the winner keeps theirs.
    expect(ag.folder).toBe('helper-2');
    expect(ag.name).toBe('Helper');
    expect(count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(2);
    expect(fs.existsSync(`${TEST_DIR}/groups/helper-2`)).toBe(true);
  });

  it('keeps re-allocating across several consecutive losses', async () => {
    for (const folder of ['helper', 'helper-2', 'helper-3']) {
      vi.mocked(createAgentGroup).mockImplementationOnce(async () => {
        insertWinnerRow(folder);
        throw Object.assign(new Error('UNIQUE constraint failed: agent_groups.folder'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      });
    }

    const ag = await createNewAgentGroup('Helper');

    expect(ag.folder).toBe('helper-4');
    expect(count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(4);
  });

  it('gives up with a clear error once the attempt bound is exhausted', async () => {
    for (const folder of ['helper', 'helper-2', 'helper-3', 'helper-4', 'helper-5']) {
      vi.mocked(createAgentGroup).mockImplementationOnce(async () => {
        insertWinnerRow(folder);
        throw Object.assign(new Error('UNIQUE constraint failed: agent_groups.folder'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      });
    }

    await expect(createNewAgentGroup('Helper')).rejects.toThrow(/Could not allocate a folder/);
  });

  it('creates normally when nothing races it', async () => {
    const ag = await createNewAgentGroup('Helper');

    expect(ag.folder).toBe('helper');
    expect(count('SELECT COUNT(*) AS c FROM agent_groups')).toBe(1);
  });
});
