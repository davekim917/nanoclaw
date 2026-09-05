import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('run-log-test') }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

vi.mock('../../db/agent-groups.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/agent-groups.js')>()),
  getAgentGroup: (id: string) => (id === 'ag-test' ? { id, folder: 'g-test' } : undefined),
}));

import { deleteRunLog } from './run-log.js';

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const logDir = () => `${TEST_DIR}/groups/g-test/tasks`;
const logPath = () => `${logDir()}/series-1.md`;

describe('deleteRunLog', () => {
  it('refuses an id with path-traversal characters, same charset guard as appendRunLog', async () => {
    await expect(deleteRunLog('ag-test', '../evil')).rejects.toThrow(/invalid task id/);
    await expect(deleteRunLog('ag-test', 'has/slash')).rejects.toThrow(/invalid task id/);
  });

  it('is a no-op when the log file does not exist', async () => {
    expect(fs.existsSync(logPath())).toBe(false);
    await expect(deleteRunLog('ag-test', 'series-1')).resolves.toBeUndefined();
  });

  it('removes an existing log file', async () => {
    // Write the fixture directly rather than through appendRunLog: that
    // writer also resolves the group's timezone off the central DB, which
    // this file's fixture deliberately never initializes (deleteRunLog does
    // not need it, and that is the point being pinned here).
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(logPath(), '2026-01-01 00:00 — first run\n');
    expect(fs.existsSync(logPath())).toBe(true);

    await deleteRunLog('ag-test', 'series-1');

    expect(fs.existsSync(logPath())).toBe(false);
  });
});
