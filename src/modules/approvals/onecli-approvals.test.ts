/**
 * OneCLI credential approvals — restart-surviving, row-keyed resolution.
 *
 * The point of these tests is the host-restart seam. A credential card can sit
 * in an admin's DM for minutes while the host is restarted underneath it, and
 * the old map-keyed shape meant the click after that restart resolved nothing:
 * the startup sweep blanket-expired every surviving row and the click landed on
 * an absent map entry.
 *
 * A "restart" here is a real one for every piece of state that matters:
 * `vi.resetModules()` throws away the module graph (and with it the in-memory
 * `pending` map), and the central DB is a file reopened by the fresh graph. The
 * only thing carried across is the SQLite file, exactly as in production.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { MessagingGroup, PendingApproval } from '../../types.js';

const sdk = vi.hoisted(() => ({
  /** Every callback handed to `configureManualApproval`, one per "process". */
  callbacks: [] as ((request: Record<string, unknown>) => Promise<'approve' | 'deny'>)[],
  stop: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval(cb: (request: Record<string, unknown>) => Promise<'approve' | 'deny'>): {
      stop: () => void;
    } {
      sdk.callbacks.push(cb);
      return { stop: sdk.stop };
    }
  },
}));

const dm = vi.hoisted(() => ({ ensure: vi.fn() }));

// Only the platform call is stubbed, and at the leaf: `ensureUserDm` is what
// would otherwise open a real DM. Both `pickApprover` and `pickApprovalDelivery`
// stay real, so the cross-tenant approver check runs against actual user_roles
// rows — that check is the fork customization the port has to keep working
// after a restart, when the in-memory approver set it used to read is gone.
//
// Mocking `./primitive.js` instead would silently break these tests: a mock
// factory's module survives `vi.resetModules()`, so the mocked module (and the
// DB connection it closed over) would stay bound to the FIRST test's graph and
// `pickApprover` would answer from a previous test's database.
vi.mock('../permissions/user-dm.js', () => ({ ensureUserDm: dm.ensure }));

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

let TEST_DIR: string;
let DB_PATH: string;

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, ONECLI_URL: 'https://onecli.test', ONECLI_API_KEY: 'test-key' };
});

const ADMIN = 'slack:U-ADMIN';
const OUTSIDER = 'slack:U-OUTSIDER';

const DM: MessagingGroup = {
  id: 'mg-dm',
  channel_type: 'slack',
  platform_id: 'D-ADMIN',
  instance: 'slack-acme',
  name: 'admin dm',
  is_group: 0,
  unknown_sender_policy: 'strict',
  created_at: '2026-09-01T00:00:00.000Z',
};

function gatewayRequest(id: string, expiresAt: string): Record<string, unknown> {
  return {
    id,
    method: 'POST',
    url: 'https://api.example.com/v1/send',
    host: 'api.example.com',
    path: '/v1/send',
    headers: {},
    bodyPreview: '{"to":"someone@example.com"}',
    agent: { id: 'onecli-agent', name: 'Acme', externalId: 'ag-1' },
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt,
    timeoutSeconds: 300,
  };
}

interface Boot {
  approvals: typeof import('./onecli-approvals.js');
  sessions: typeof import('../../db/sessions.js');
}

/**
 * Start a "host process": fresh module graph, same DB file on disk.
 * `seed` runs only on the first boot, against that boot's module instances.
 */
async function boot(seed?: boolean): Promise<Boot> {
  vi.resetModules();
  const dbIndex = await import('../../db/index.js');
  dbIndex.initDb(DB_PATH);
  if (seed) {
    dbIndex.runMigrations(dbIndex.getDb());
    const agentGroups = await import('../../db/agent-groups.js');
    const users = await import('../permissions/db/users.js');
    const roles = await import('../permissions/db/user-roles.js');
    agentGroups.createAgentGroup({
      id: 'ag-1',
      name: 'Acme',
      folder: 'acme',
      agent_provider: null,
      created_at: '2026-09-01T00:00:00.000Z',
    });
    for (const id of [ADMIN, OUTSIDER]) {
      users.upsertUser({ id, kind: 'human', display_name: id, created_at: '2026-09-01T00:00:00.000Z' });
    }
    roles.grantRole({
      user_id: ADMIN,
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: ADMIN,
      granted_at: '2026-09-01T00:00:00.000Z',
    });
  }
  return {
    approvals: await import('./onecli-approvals.js'),
    sessions: await import('../../db/sessions.js'),
  };
}

function makeAdapter(): ChannelDeliveryAdapter & { deliver: ReturnType<typeof vi.fn> } {
  const deliver = vi.fn().mockResolvedValue('slack-msg-1');
  return { deliver } as unknown as ChannelDeliveryAdapter & { deliver: ReturnType<typeof vi.fn> };
}

/** Let the handler's floating promises (re-attach, delivery) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function cardCalls(adapter: { deliver: ReturnType<typeof vi.fn> }): Record<string, unknown>[] {
  return adapter.deliver.mock.calls.map((c) => JSON.parse(c[4] as string) as Record<string, unknown>);
}

beforeEach(() => {
  TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onecli-approvals-'));
  DB_PATH = path.join(TEST_DIR, 'v2.db');
  sdk.callbacks.length = 0;
  sdk.stop.mockClear();
  dm.ensure.mockReset();
  dm.ensure.mockImplementation(async (userId: string) => (userId === ADMIN ? DM : null));
});

afterEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('OneCLI approvals survive a host restart', () => {
  it('re-arms the surviving card and lets a post-restart click decide the held request', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const request = gatewayRequest('req-uuid-1', inFuture);

    // ── Process 1: card delivered, row written, callback waiting.
    const first = await boot(true);
    const adapter1 = makeAdapter();
    first.approvals.startOneCLIApprovalHandler(adapter1);
    await settle();

    const orphaned = sdk.callbacks[0](request);
    orphaned.catch(() => {});
    await settle();

    expect(cardCalls(adapter1)).toHaveLength(1);
    expect(cardCalls(adapter1)[0]).toMatchObject({ type: 'ask_question', title: 'Credentials Request' });
    // The card must be addressed to the instance that owns the DM, not the
    // bare channel type — dispatch is exact-key.
    expect(adapter1.deliver.mock.calls[0][6]).toBe('slack-acme');

    const rows = first.sessions.getPendingApprovalsByAction('onecli_credential');
    expect(rows).toHaveLength(1);
    const approvalId = rows[0].approval_id;
    expect(rows[0].request_id).toBe('req-uuid-1');
    expect(rows[0].instance).toBe('slack-acme');

    // ── Restart. The process dies mid-decision; the gateway is still holding
    // the request, so it comes back on the fresh process's first poll.
    first.approvals.stopOneCLIApprovalHandler();

    const second = await boot();
    const adapter2 = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter2);
    await settle();

    // Re-attach must not expire a still-open row.
    expect(second.sessions.getPendingApproval(approvalId)?.status).toBe('pending');

    const redelivered = sdk.callbacks[1](request);
    await settle();

    // No second card: the surviving one was re-armed by request_id.
    expect(cardCalls(adapter2).filter((c) => c.type === 'ask_question')).toHaveLength(0);

    // ── The admin clicks the card posted BEFORE the restart.
    const claimed = await second.approvals.resolveOneCLIApproval(approvalId, 'approve', ADMIN);
    expect(claimed).toBe(true);

    // The guarded action replays: the held credentialed request is decided by
    // the post-restart callback, which is what the SDK submits to the gateway.
    await expect(redelivered).resolves.toBe('approve');
    expect(second.sessions.getPendingApproval(approvalId)).toBeUndefined();
  });

  it('keeps the cross-tenant approver check after the restart, with the in-memory set gone', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const request = gatewayRequest('req-uuid-2', inFuture);

    const first = await boot(true);
    const adapter1 = makeAdapter();
    first.approvals.startOneCLIApprovalHandler(adapter1);
    await settle();
    sdk.callbacks[0](request).catch(() => {});
    await settle();
    const approvalId = first.sessions.getPendingApprovalsByAction('onecli_credential')[0].approval_id;
    first.approvals.stopOneCLIApprovalHandler();

    const second = await boot();
    second.approvals.startOneCLIApprovalHandler(makeAdapter());
    await settle();

    // Someone who is not an approver for ag-1 clicks the surviving card.
    const claimed = await second.approvals.resolveOneCLIApproval(approvalId, 'approve', OUTSIDER);
    expect(claimed).toBe(true);
    // Refused, not decided: the row is untouched and still clickable.
    expect(second.sessions.getPendingApproval(approvalId)?.status).toBe('pending');

    // The real approver still gets through. Nothing is armed in memory here, so
    // the decision is held on the row for the gateway's redelivery rather than
    // discarded — see the redelivery tests below.
    expect(await second.approvals.resolveOneCLIApproval(approvalId, 'approve', ADMIN)).toBe(true);
    expect(second.sessions.getPendingApproval(approvalId)?.status).toBe('approved');
  });
});

describe('expired OneCLI approval cards', () => {
  /** A pending row whose gateway TTL has already passed, as left by a crash. */
  async function seedOverdueRow(boot0: Boot, approvalId: string): Promise<void> {
    boot0.sessions.createPendingApproval({
      approval_id: approvalId,
      session_id: null,
      request_id: 'req-uuid-dead',
      action: 'onecli_credential',
      payload: JSON.stringify({}),
      created_at: '2026-09-01T00:00:00.000Z',
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'D-ADMIN',
      instance: 'slack-acme',
      platform_message_id: 'slack-msg-1',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      status: 'pending',
      title: 'Credentials Request',
      question: '*Agent:* Acme',
      options_json: '[]',
    } as Partial<PendingApproval> as Parameters<typeof boot0.sessions.createPendingApproval>[0]);
  }

  it('edits an overdue card to an honest timeout on re-attach instead of silently dropping it', async () => {
    const first = await boot(true);
    await seedOverdueRow(first, 'oa-dead1');

    const second = await boot();
    const adapter = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();

    const edits = cardCalls(adapter).filter((c) => c.operation === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].messageId).toBe('slack-msg-1');
    expect(edits[0].text).toContain('⏱️ Timed out — host restarted before resolution');
    // The card's own content survives the edit — an expired card that loses
    // the question no longer says what was being decided.
    expect(edits[0].text).toContain('Credentials Request');
    expect(edits[0].text).toContain('*Agent:* Acme');
    // Edits dispatch exact-key too.
    expect(adapter.deliver.mock.calls[0][6]).toBe('slack-acme');

    expect(second.sessions.getPendingApproval('oa-dead1')).toBeUndefined();
  });

  it('expires overdue rows on the row-driven sweep, not just on a timer that died with its process', async () => {
    const first = await boot(true);
    await seedOverdueRow(first, 'oa-dead2');

    const second = await boot();
    const adapter = makeAdapter();
    // Re-attach handles the boot case; drive the periodic sweep directly on a
    // row that appears while the process is already running.
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();
    adapter.deliver.mockClear();

    await seedOverdueRow(second, 'oa-dead3');
    await second.approvals.expireOverdueApprovals();

    const edits = cardCalls(adapter).filter((c) => c.operation === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('⏱️ Timed out — no response');
    expect(second.sessions.getPendingApproval('oa-dead3')).toBeUndefined();
  });

  it('refuses a click on a card the sweep already expired, rather than deciding it twice', async () => {
    const first = await boot(true);
    await seedOverdueRow(first, 'oa-dead4');

    const second = await boot();
    const adapter = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();
    adapter.deliver.mockClear();

    // Re-attach expired and deleted the row; the card in the DM still shows
    // live buttons until the edit lands, so a click can still arrive.
    expect(second.sessions.getPendingApproval('oa-dead4')).toBeUndefined();
    const claimed = await second.approvals.resolveOneCLIApproval('oa-dead4', 'approve', ADMIN);
    expect(claimed).toBe(false);
    expect(adapter.deliver).not.toHaveBeenCalled();
  });

  it('does not re-decide a row another path already claimed', async () => {
    const first = await boot(true);
    const adapter = makeAdapter();
    first.approvals.startOneCLIApprovalHandler(adapter);
    await settle();

    // Seeded after boot on purpose: this is the sweep-vs-click race inside one
    // process, where the sweep has claimed the row but not yet deleted it.
    first.sessions.createPendingApproval({
      approval_id: 'oa-claimed',
      session_id: null,
      request_id: 'req-uuid-claimed',
      action: 'onecli_credential',
      payload: JSON.stringify({}),
      created_at: '2026-09-01T00:00:00.000Z',
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'D-ADMIN',
      instance: 'slack-acme',
      platform_message_id: 'slack-msg-2',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      status: 'approved',
      title: 'Credentials Request',
      question: '*Agent:* Acme',
      options_json: '[]',
    } as Partial<PendingApproval> as Parameters<typeof first.sessions.createPendingApproval>[0]);

    adapter.deliver.mockClear();

    const claimed = await first.approvals.resolveOneCLIApproval('oa-claimed', 'reject', ADMIN);
    expect(claimed).toBe(true);
    // Status untouched, no edit delivered — the compare-and-swap refused it.
    expect(first.sessions.getPendingApproval('oa-claimed')?.status).toBe('approved');
    expect(adapter.deliver).not.toHaveBeenCalled();
  });
});

describe('decisions made before the gateway redelivers', () => {
  /** A card that survived the restart, with the gateway still holding it. */
  function seedSurvivingRow(boot0: Boot, approvalId: string, expiresAt: string, status = 'pending'): void {
    boot0.sessions.createPendingApproval({
      approval_id: approvalId,
      session_id: null,
      request_id: 'req-uuid-held',
      action: 'onecli_credential',
      payload: JSON.stringify({}),
      created_at: '2026-09-01T00:00:00.000Z',
      agent_group_id: 'ag-1',
      channel_type: 'slack',
      platform_id: 'D-ADMIN',
      instance: 'slack-acme',
      platform_message_id: 'slack-msg-held',
      expires_at: expiresAt,
      status,
      title: 'Credentials Request',
      question: '*Agent:* Acme',
      options_json: '[]',
    } as Partial<PendingApproval> as Parameters<typeof boot0.sessions.createPendingApproval>[0]);
  }

  it('holds a click that lands before the first redelivery and applies it when the request comes back', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const first = await boot(true);
    seedSurvivingRow(first, 'oa-held', inFuture);

    const second = await boot();
    const adapter = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();
    adapter.deliver.mockClear();

    // The admin clicks in the window between boot and the gateway's first
    // poll: nothing is armed in memory yet, but the request is NOT gone.
    expect(await second.approvals.resolveOneCLIApproval('oa-held', 'approve', ADMIN)).toBe(true);

    // The decision is held on the row, not thrown away, and the card is not
    // yet corrected — we do not know the request is dead.
    expect(second.sessions.getPendingApproval('oa-held')?.status).toBe('approved');
    expect(adapter.deliver).not.toHaveBeenCalled();

    // The gateway redelivers. The held decision is applied to the real
    // request, and no second card is posted.
    const redelivered = sdk.callbacks[0](gatewayRequest('req-uuid-held', inFuture));
    await expect(redelivered).resolves.toBe('approve');
    expect(cardCalls(adapter).filter((c) => c.type === 'ask_question')).toHaveLength(0);
    expect(second.sessions.getPendingApproval('oa-held')).toBeUndefined();
  });

  it('carries a held rejection through to the redelivered request', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const first = await boot(true);
    seedSurvivingRow(first, 'oa-held-rej', inFuture);

    const second = await boot();
    second.approvals.startOneCLIApprovalHandler(makeAdapter());
    await settle();

    expect(await second.approvals.resolveOneCLIApproval('oa-held-rej', 'reject', ADMIN)).toBe(true);
    expect(second.sessions.getPendingApproval('oa-held-rej')?.status).toBe('rejected');

    await expect(sdk.callbacks[0](gatewayRequest('req-uuid-held', inFuture))).resolves.toBe('deny');
  });

  it('tells the human the truth once the held decision outlives the request', async () => {
    const first = await boot(true);
    // Decision recorded, TTL already passed: the gateway never came back.
    seedSurvivingRow(first, 'oa-stale', new Date(Date.now() - 60_000).toISOString(), 'approved');

    const second = await boot();
    const adapter = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();

    const edits = cardCalls(adapter).filter((c) => c.operation === 'edit');
    expect(edits).toHaveLength(1);
    expect(edits[0].text).toContain('the original request ended when the host restarted');
    expect(second.sessions.getPendingApproval('oa-stale')).toBeUndefined();
  });

  it('drops an unconsumed rejection without correcting the card', async () => {
    const first = await boot(true);
    seedSurvivingRow(first, 'oa-stale-rej', new Date(Date.now() - 60_000).toISOString(), 'rejected');

    const second = await boot();
    const adapter = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter);
    await settle();

    // "❌ Rejected" is already accurate — the request was denied either way.
    expect(cardCalls(adapter).filter((c) => c.operation === 'edit')).toHaveLength(0);
    expect(second.sessions.getPendingApproval('oa-stale-rej')).toBeUndefined();
  });
});

describe('approver-set authorization', () => {
  it('fails closed when the last eligible approver is revoked after the card is issued', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const first = await boot(true);
    const adapter1 = makeAdapter();
    first.approvals.startOneCLIApprovalHandler(adapter1);
    await settle();
    sdk.callbacks[0](gatewayRequest('req-uuid-revoke', inFuture)).catch(() => {});
    await settle();
    const approvalId = first.sessions.getPendingApprovalsByAction('onecli_credential')[0].approval_id;

    // Every admin/owner role goes away while the card sits in the DM.
    first.approvals.stopOneCLIApprovalHandler();
    const second = await boot();
    const dbIndex = await import('../../db/index.js');
    dbIndex.getDb().prepare('DELETE FROM user_roles').run();

    const adapter2 = makeAdapter();
    second.approvals.startOneCLIApprovalHandler(adapter2);
    await settle();
    adapter2.deliver.mockClear();

    // An empty approver set must refuse the click, not skip the check.
    expect(await second.approvals.resolveOneCLIApproval(approvalId, 'approve', ADMIN)).toBe(true);
    expect(await second.approvals.resolveOneCLIApproval(approvalId, 'approve', OUTSIDER)).toBe(true);
    // Including the legacy no-identity path. This is the case the membership
    // check alone cannot cover: `userId &&` short-circuits, so without an
    // explicit empty-set guard an unidentified callback decides a credentialed
    // request that nobody is authorized to decide.
    expect(await second.approvals.resolveOneCLIApproval(approvalId, 'approve', '')).toBe(true);
    expect(second.sessions.getPendingApproval(approvalId)?.status).toBe('pending');
    expect(adapter2.deliver).not.toHaveBeenCalled();
  });

  it('still honors a legacy no-identity click while eligible approvers exist', async () => {
    const inFuture = new Date(Date.now() + 300_000).toISOString();
    const first = await boot(true);
    const adapter = makeAdapter();
    first.approvals.startOneCLIApprovalHandler(adapter);
    await settle();
    const held = sdk.callbacks[0](gatewayRequest('req-uuid-legacy', inFuture));
    await settle();
    const approvalId = first.sessions.getPendingApprovalsByAction('onecli_credential')[0].approval_id;

    // Adapters predating userId propagation send an empty id. With a real
    // approver set that still resolves, with a warning — fork behavior kept.
    expect(await first.approvals.resolveOneCLIApproval(approvalId, 'approve', '')).toBe(true);
    await expect(held).resolves.toBe('approve');
  });
});
