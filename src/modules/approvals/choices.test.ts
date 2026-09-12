/**
 * Choice receipts (migration 077, choice_receipts) — the durable record
 * `resolveChoice` writes once a click's answer has been delivered, so a
 * consumer outside this host can verify what a card resolved to after the
 * backing `pending_approvals` row is gone.
 *
 * Real central DB (initMigratedTestDb); resolveChoice is exercised directly
 * with a stub ChoiceHandler, no delivery adapter/channel registry needed
 * (editChoiceCard no-ops without one — see choices.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getChoiceReceipt, getChoiceReceiptsByRequestId } from '../../db/choice-receipts.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { registerChoiceHandler, resolveChoice, type ChoiceHandlerContext } from './choices.js';

const ACTION = 'test-choice';
const USER = 'slack-fixture:U-clicker';

function now(): string {
  return new Date().toISOString();
}

function fakeSession(id: string): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
}

async function seedApproval(over: Partial<PendingApproval> = {}): Promise<PendingApproval> {
  const id = over.approval_id ?? `appr-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: id,
    request_id: over.request_id ?? `choice-${id}`,
    action: ACTION,
    payload: '{}',
    created_at: now(),
    title: 'Ship it?',
    options_json: JSON.stringify([
      { label: 'Ship A', value: 'ship-a' },
      { label: 'Hold', value: 'hold' },
    ]),
    session_id: 'requester-session',
    agent_group_id: 'ag-1',
    channel_type: 'slack-fixture',
    platform_id: 'slack:chan-1',
    thread_id: 'slack:chan-1:1.0',
    platform_message_id: 'card-msg-1',
    ...over,
  });
  return (await getPendingApproval(id))!;
}

let handler: ReturnType<typeof vi.fn<(ctx: ChoiceHandlerContext) => Promise<Session | null>>>;

beforeEach(async () => {
  await initMigratedTestDb();
  handler = vi.fn<(ctx: ChoiceHandlerContext) => Promise<Session | null>>();
  registerChoiceHandler(ACTION, (ctx: ChoiceHandlerContext) => handler(ctx));

  // pending_approvals.session_id / agent_group_id are FK-constrained
  // (module-approvals-pending-approvals.ts) — seed the rows the approval
  // insert below references. The delivered-to session is a bare object the
  // stub handler returns and is never itself looked up by id, so it needs
  // no row (see migration 077: choice_receipts carries no FK to sessions).
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createSession(fakeSession('requester-session'));
});

afterEach(() => {
  vi.restoreAllMocks();
  return closeDb();
});

describe('choice receipts', () => {
  it('a resolved click writes exactly one receipt with the right value, user and choice id', async () => {
    const approval = await seedApproval();
    const target = fakeSession('sess-target');
    handler.mockResolvedValue(target);

    await resolveChoice(approval, 'ship-a', USER);

    const receipt = await getChoiceReceipt(approval.approval_id);
    expect(receipt).toBeDefined();
    expect(receipt).toMatchObject({
      request_id: approval.request_id,
      approval_id: approval.approval_id,
      action: ACTION,
      agent_group_id: 'ag-1',
      session_id: 'sess-target',
      platform_id: 'slack:chan-1',
      thread_id: 'slack:chan-1:1.0',
      platform_message_id: 'card-msg-1',
      value: 'ship-a',
      label: 'Ship A',
      clicker_user_id: USER,
    });
    expect(receipt!.resolved_at).toBeTruthy();

    const count = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM choice_receipts'))!.n;
    expect(count).toBe(1);
  });

  it('a losing second click writes nothing and never reaches delivery', async () => {
    const approval = await seedApproval();
    handler.mockResolvedValue(fakeSession('sess-target'));

    await resolveChoice(approval, 'ship-a', USER);
    // Second click re-reads the (now-deleted) row the way the response
    // handler would find it — nothing left to resolve.
    const gone = await getPendingApproval(approval.approval_id);
    expect(gone).toBeUndefined();

    // Simulate the race directly: a second resolveChoice call against the
    // same approval object no longer wins the CAS.
    await resolveChoice(approval, 'hold', 'slack-fixture:U-other');

    // The handler must fire exactly once. Asserting only the receipt count
    // (as this test used to) survives removing the CAS guard entirely: the
    // second call would still deliver to the handler a second time, and only
    // fail the receipt's write (a PK conflict on approval_id) — silently, if
    // that write path is ever again given an ON CONFLICT DO NOTHING. Asserting
    // delivery directly catches the CAS removal regardless of the write path.
    expect(handler).toHaveBeenCalledTimes(1);
    const count = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM choice_receipts'))!.n;
    expect(count).toBe(1);
    const receipt = await getChoiceReceipt(approval.approval_id);
    expect(receipt!.value).toBe('ship-a');
  });

  it('two approvals sharing one reused choiceId each keep their own receipt (review finding F2)', async () => {
    // Defense in depth for the receipts table itself, independent of the
    // creation-time refusal in modules/interactive/choice.ts
    // (choice.test.ts "refuses a choiceId that already has a pending
    // approval"): even if two PENDING approvals ever end up sharing a
    // request_id — pending_approvals.request_id carries no UNIQUE
    // constraint — each resolves to its OWN receipt, keyed by the
    // host-minted approval_id, not one receipt silently standing in for
    // both (migration 077).
    const a = await seedApproval({ approval_id: 'appr-reused-a', request_id: 'choice-shared' });
    const b = await seedApproval({ approval_id: 'appr-reused-b', request_id: 'choice-shared' });
    handler.mockResolvedValueOnce(fakeSession('sess-a')).mockResolvedValueOnce(fakeSession('sess-b'));

    await resolveChoice(a, 'ship-a', USER);
    await resolveChoice(b, 'hold', 'slack-fixture:U-other');

    expect(handler).toHaveBeenCalledTimes(2);
    const count = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM choice_receipts'))!.n;
    expect(count).toBe(2);
    expect(await getChoiceReceipt('appr-reused-a')).toMatchObject({ value: 'ship-a', clicker_user_id: USER });
    expect(await getChoiceReceipt('appr-reused-b')).toMatchObject({
      value: 'hold',
      clicker_user_id: 'slack-fixture:U-other',
    });
    const byRequestId = await getChoiceReceiptsByRequestId('choice-shared');
    expect(byRequestId.map((r) => r.approval_id).sort()).toEqual(['appr-reused-a', 'appr-reused-b']);
  });

  it('an undeliverable answer (card left open) writes nothing', async () => {
    const approval = await seedApproval();
    handler.mockResolvedValue(null); // no live session can take it

    await resolveChoice(approval, 'ship-a', USER);

    expect(await getChoiceReceipt(approval.approval_id)).toBeUndefined();
    // Card left open: the row goes back to pending, not deleted.
    const row = await getPendingApproval(approval.approval_id);
    expect(row?.status).toBe('pending');
  });

  it('a receipt-insert failure still delivers, and logs the error', async () => {
    const approval = await seedApproval();
    const target = fakeSession('sess-target');
    handler.mockResolvedValue(target);
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);

    // Force the write to fail without touching delivery.
    await getDb().exec('DROP TABLE choice_receipts');

    await expect(resolveChoice(approval, 'ship-a', USER)).resolves.toBeUndefined();

    // The click was still consumed: the row is gone, not left open.
    expect(await getPendingApproval(approval.approval_id)).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to write choice receipt — answer was still delivered',
      expect.objectContaining({ approvalId: approval.approval_id, requestId: approval.request_id }),
    );
  });
});
