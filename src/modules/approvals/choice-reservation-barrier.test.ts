/**
 * The reservation has to survive the DELIVERY WINDOW, not just the pending row.
 *
 * `resolveChoice` claims a click by flipping the row pending→approved
 * (choices.ts:115) and only then awaits delivery, restoring it to `pending`
 * when delivery throws (:138) or when no live session can take the answer
 * (:149). The card is open and clickable that entire time.
 *
 * While the reservation index covered only `pending`, that window was a hole:
 * a second request could claim the same choiceId and post its own card, and
 * the restore-to-`pending` would then violate the index and throw
 * SQLITE_CONSTRAINT_UNIQUE from a path with no catch — two live cards, the
 * first row stuck in `approved`, no answer and no receipt, and no later click
 * able to recover it (reproduced in review).
 *
 * These tests hold the delivery open on a barrier so the competing request
 * lands exactly inside that window. A stub choice handler stands in for
 * relayChoice so both failure modes are reachable on demand; everything else
 * is real — the real `requestApprovalOutcome` insert, the real migrated
 * schema, the real index.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { registerChoiceHandler, resolveChoice, type ChoiceHandlerContext } from './choices.js';
import { requestApprovalOutcome, type ApprovalOutcome } from './primitive.js';

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

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-choice-reservation-barrier') }));

// The real action, because the reservation index is scoped to it.
const ACTION = 'request_choice';
const USER = 'slack-fixture:U-clicker';
const CHOICE_ID = 'choice-dup';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection is attached only when a test rejects it; keep the runtime from
  // reporting the barrier itself as an unhandled rejection in the meantime.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

let session: Session;
let delivered: Array<Record<string, unknown>>;
let handlerImpl: (ctx: ChoiceHandlerContext) => Promise<Session | null>;
let entered: Deferred<void>;

registerChoiceHandler(ACTION, async (ctx: ChoiceHandlerContext) => {
  entered.resolve();
  return handlerImpl(ctx);
});

function now(): string {
  return new Date().toISOString();
}

/** The cards actually posted to the platform. */
function cards(): Array<Record<string, unknown>> {
  return delivered.filter((d) => d.type === 'ask_question');
}

function postCard(title: string, requestId = CHOICE_ID): Promise<ApprovalOutcome> {
  return requestApprovalOutcome({
    session,
    agentName: 'ag-1',
    action: ACTION,
    requestId,
    payload: { choiceId: requestId },
    title,
    question: 'Which change ships?',
    deliveryTarget: 'thread',
    options: [
      { label: 'Ship', value: 'ship' },
      { label: 'Hold', value: 'hold' },
    ],
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  entered = deferred<void>();
  handlerImpl = async () => null;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack-fixture',
    platform_id: 'slack:chan-1',
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

describe('the reservation spans the delivery window', () => {
  it('a failing delivery: the competing request is refused and the restore does not throw', async () => {
    expect(await postCard('First')).toBe('posted');
    const [row] = await getPendingApprovalsByAction(ACTION);

    const gate = deferred<Session | null>();
    handlerImpl = () => gate.promise;

    const click = resolveChoice(row, 'ship', USER);
    await entered.promise; // now inside the delivery window

    // The claim is taken, and the card is still live and clickable.
    expect((await getPendingApproval(row.approval_id))!.status).toBe('approved');

    // A second request for the same choiceId must lose, and post nothing.
    expect(await postCard('Second')).toBe('duplicate-request');
    expect(cards()).toHaveLength(1);

    gate.reject(new Error('platform down'));

    // The restore is the part that used to throw SQLITE_CONSTRAINT_UNIQUE.
    await expect(click).resolves.toBeUndefined();

    // Card left open, exactly one row, answerable again by a later click.
    expect((await getPendingApproval(row.approval_id))!.status).toBe('pending');
    expect(await getPendingApprovalsByAction(ACTION)).toHaveLength(1);
  });

  it('a null delivery: same window, same refusal, same clean restore', async () => {
    expect(await postCard('First')).toBe('posted');
    const [row] = await getPendingApprovalsByAction(ACTION);

    const gate = deferred<Session | null>();
    handlerImpl = () => gate.promise;

    const click = resolveChoice(row, 'ship', USER);
    await entered.promise;

    expect((await getPendingApproval(row.approval_id))!.status).toBe('approved');
    expect(await postCard('Second')).toBe('duplicate-request');
    expect(cards()).toHaveLength(1);

    // No live session could take the answer (choices.ts:142-151).
    gate.resolve(null);

    await expect(click).resolves.toBeUndefined();

    expect((await getPendingApproval(row.approval_id))!.status).toBe('pending');
    expect(await getPendingApprovalsByAction(ACTION)).toHaveLength(1);
  });

  it('a delivered answer frees the choiceId, because the row is gone', async () => {
    expect(await postCard('First')).toBe('posted');
    const [row] = await getPendingApprovalsByAction(ACTION);

    handlerImpl = async () => session;
    await resolveChoice(row, 'ship', USER);

    // Answered and deleted — the reservation is released with the row.
    expect(await getPendingApproval(row.approval_id)).toBeUndefined();
    expect(await postCard('Second')).toBe('posted');
    expect(cards()).toHaveLength(2);
  });
});
