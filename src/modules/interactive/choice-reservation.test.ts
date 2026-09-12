/**
 * The choiceId reservation, with the fast path taken away.
 *
 * `handleRequestChoice` reads for a live card before it asks for one
 * (src/modules/interactive/choice.ts), but that read and the insert are
 * separated by several awaits and delivery is excluded per session
 * (src/delivery.ts `inflightDeliveries`, keyed on session.id), so two
 * sessions of one agent group can both see "nothing pending". The
 * concurrency test in choice.test.ts drives that window as it actually
 * occurs; this file pins the guarantee underneath it by removing the
 * pre-check entirely — `getPendingApprovalByRequestId` is stubbed to the
 * answer a losing racer gets — so the only thing left that can refuse the
 * second ask is migration 078's partial unique index, honoured as
 * 'duplicate-request' at the insert.
 *
 * Delete that migration (or stop honouring its result in
 * requestApprovalOutcome) and this file posts two cards for one choiceId.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { REQUEST_CHOICE_ACTION } from './choice.js';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn(), sessionMessageExists: vi.fn().mockResolvedValue(false) };
});

// The whole point of this file: the caller's pre-check always answers "no
// live card", exactly as it does for the racer that read before the winner
// inserted. Everything else in the module stays real.
vi.mock('../../db/sessions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/sessions.js')>()),
  getPendingApprovalByRequestId: vi.fn().mockResolvedValue(undefined),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-choice-reservation') }));

const CHANNEL = 'slack-fixture';
const OWN = 'slack:chan-1';
const OPTIONS = [
  { label: 'Ship', value: 'ship' },
  { label: 'Hold', value: 'hold' },
];

let session: Session;
let delivered: Array<Record<string, unknown>>;

function now(): string {
  return new Date().toISOString();
}

/** Every line written into a session. */
function notes(): string[] {
  return vi
    .mocked(writeSessionMessage)
    .mock.calls.map((call) => (JSON.parse(call[2].content) as { text: string }).text);
}

async function ask(choiceId: string, title: string): Promise<void> {
  await getDeliveryAction(REQUEST_CHOICE_ACTION)!(
    { action: REQUEST_CHOICE_ACTION, choiceId, title, question: 'Which change ships?', options: OPTIONS },
    session,
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: CHANNEL,
    platform_id: OWN,
    name: 'Team room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'slack:chan-1:100.1',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);

  delivered = [];
  let seq = 0;
  setDeliveryAdapter({
    async deliver(_ct: string, _pid: string, _tid: string | null, _kind: string, content: string) {
      delivered.push(JSON.parse(content) as Record<string, unknown>);
      seq += 1;
      return `pm-${seq}`;
    },
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('the choiceId reservation is the database insert, not the pre-check', () => {
  it('refuses the second ask with no pre-check to catch it: one row, one card, one refusal', async () => {
    await ask('choice-dup', 'First');
    await ask('choice-dup', 'Second');

    const matching = (await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)).filter(
      (r) => r.request_id === 'choice-dup',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].title).toBe('First');
    expect(matching[0].status).toBe('pending');

    // No second card was posted, so nobody can be shown the losing ask.
    expect(delivered.filter((d) => d.type === 'ask_question')).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ type: 'ask_question', title: 'First' });

    // And the loser is told, in the same words a plain reuse gets.
    expect(notes()).toEqual(['request_choice failed: choiceId "choice-dup" already has a pending answer.']);
  });

  it('leaves no row behind for the refused ask', async () => {
    await ask('choice-dup', 'First');
    await ask('choice-dup', 'Second');

    // Every row for this action, whatever its status — a losing insert must
    // not leave an expired or orphaned row for a sweep to trip over later.
    const all = await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION);
    expect(all).toHaveLength(1);
  });

  it('lets a different choiceId through, so the index refuses reuse and nothing else', async () => {
    await ask('choice-a', 'First');
    await ask('choice-b', 'Second');

    const all = await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION);
    expect(all.map((r) => r.request_id).sort()).toEqual(['choice-a', 'choice-b']);
    expect(delivered.filter((d) => d.type === 'ask_question')).toHaveLength(2);
    expect(notes()).toEqual([]);
  });
});
