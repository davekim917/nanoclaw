/**
 * S5 end to end: a host-gated wake whose result cannot be recorded is not
 * admitted. The next tick runs the script again, and only a recorded execution
 * is handed to the container.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('host-gate-admission') }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

import { closeDb, createAgentGroup, getDb, initMigratedTestDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { admitDueTaskContexts, initSessionFolder, withExistingMailboxSession } from '../../session-manager.js';
import { allowSubprocess } from '../../test-hermeticity.js';
import { insertTaskRow } from '../scheduling/db.js';
import { _prepareDueWakeForTesting } from './index.js';

const AG = 'ag-gate';
const SESS = 'sess-gate';

beforeEach(async () => {
  allowSubprocess(['bash']);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  await initMigratedTestDb();
  await createAgentGroup({
    id: AG,
    name: 'Gate',
    folder: 'gate',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: 'system:tasks:watch',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

describe('S5 withholds a host-gated occurrence it could not record', () => {
  it('is not admitted, is re-run next tick, and is admitted only once its result is on record', async () => {
    const inbound = new Database(inboundDbPath(AG, SESS));
    insertTaskRow(inbound, {
      id: 'occ-wake',
      seriesId: 'watch',
      processAfter: '2020-01-01T00:00:00.000Z',
      recurrence: null,
      content: JSON.stringify({
        prompt: 'handle it',
        script: `echo run >> ${TEST_DATA_DIR}/runs\necho '{"wakeAgent":true,"data":{"n":1}}'`,
        scriptHost: true,
      }),
    });
    const tick = () => withExistingMailboxSession(AG, SESS, (mailbox) => _prepareDueWakeForTesting(mailbox, AG, SESS));
    const row = () =>
      inbound.prepare('SELECT status, trigger, content FROM messages_in WHERE id = ?').get('occ-wake') as {
        status: string;
        trigger: number;
        content: string;
      };
    const runs = () => fs.readFileSync(`${TEST_DATA_DIR}/runs`, 'utf8').trim().split('\n').length;

    await getDb().run('ALTER TABLE task_run_outcomes RENAME TO task_run_outcomes_unreachable');
    expect((await tick())?.admittedTasks).toBe(0);
    expect(row()).toMatchObject({ status: 'pending', trigger: 0 });
    expect(JSON.parse(row().content).scriptOutput).toBeUndefined();

    expect((await tick())?.admittedTasks).toBe(0);
    expect(runs()).toBe(2);

    await getDb().run('ALTER TABLE task_run_outcomes_unreachable RENAME TO task_run_outcomes');
    expect((await tick())?.admittedTasks).toBe(1);
    expect(runs()).toBe(3);
    expect(row()).toMatchObject({ status: 'pending', trigger: 1 });
    expect(JSON.parse(row().content).scriptOutput).toEqual({ n: 1 });
    expect(
      await getDb().all("SELECT observation, outcome FROM task_run_outcomes WHERE outbound_id = 'gate:occ-wake'"),
    ).toEqual([{ observation: 'wake', outcome: 'ok' }]);
    inbound.close();
  });

  it('withholds only the unrecorded row; the rest of the session is admitted', async () => {
    const inbound = new Database(inboundDbPath(AG, SESS));
    for (const id of ['occ-unrecorded', 'occ-recorded']) {
      insertTaskRow(inbound, {
        id,
        seriesId: id,
        processAfter: '2020-01-01T00:00:00.000Z',
        recurrence: null,
        content: JSON.stringify({ prompt: 'host-gated', script: 'true', scriptHost: true }),
      });
    }
    const trigger = (id: string) =>
      (inbound.prepare('SELECT trigger FROM messages_in WHERE id = ?').get(id) as { trigger: number }).trigger;
    const admit = (withheld: ReadonlySet<string>) =>
      withExistingMailboxSession(AG, SESS, (mailbox) => admitDueTaskContexts(mailbox, AG, SESS, withheld));

    expect(await admit(new Set(['occ-unrecorded']))).toBe(1);
    expect(trigger('occ-unrecorded')).toBe(0);
    expect(trigger('occ-recorded')).toBe(1);

    expect(await admit(new Set())).toBe(1);
    expect(trigger('occ-unrecorded')).toBe(1);
    inbound.close();
  });
});
