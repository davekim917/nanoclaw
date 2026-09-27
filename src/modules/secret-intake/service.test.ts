/**
 * Secret intake service: what it validates before posting the card, who may open and submit the form, what reaches
 * the vault and the grants, and — the point of the feature — that the value reaches nothing else: not a card, an agent
 * note, a log line, a returned view or a grant call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'sk-live-SERVICE-SENTINEL-9d41e7';

const h = vi.hoisted(() => ({
  vault: new Map<string, { id: string; name: string }>(),
  createCalls: [] as Array<{ spec: unknown; value: string }>,
  updateCalls: [] as Array<{ ref: unknown; value: string }>,
  createFails: false,
  deliveries: [] as Array<{ args: unknown[] }>,
  notes: [] as string[],
  logs: [] as unknown[],
  groupGrants: [] as string[],
  workgroupGrants: [] as string[],
  owners: new Set<string>(['slack:UOWNER']),
  groups: new Map<string, { id: string; name: string; folder: string; workgroup_id: string | null }>(),
  workgroups: new Set<string>(['wg-a', 'wg-b']),
}));

vi.mock('../../onecli-secret-writer.js', () => ({
  findOnecliSecretByName: vi.fn(async (name: string) => h.vault.get(name)),
  createOnecliSecret: vi.fn(async (spec: { name: string }, value: string) => {
    h.createCalls.push({ spec, value });
    if (h.createFails) throw new Error('OneCLI secret create failed with HTTP 500 for "X"');
    const ref = { id: `id-${spec.name}`, name: spec.name };
    h.vault.set(spec.name, ref);
    return ref;
  }),
  updateOnecliSecretValue: vi.fn(async (ref: unknown, value: string) => {
    h.updateCalls.push({ ref, value });
  }),
}));
vi.mock('../../onecli-secret-grants.js', () => ({
  declareGroupSecret: vi.fn(async (groupId: string, name: string) => {
    h.groupGrants.push(`${groupId}:${name}`);
    return true;
  }),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => h.groups.get(id)),
  workgroupExists: vi.fn(async (id: string) => h.workgroups.has(id)),
  addWorkgroupOnecliSecret: vi.fn(async (id: string, name: string) => {
    h.workgroupGrants.push(`${id}:${name}`);
    return true;
  }),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => ({ id, agent_group_id: 'ag-1', messaging_group_id: 'mg-1' })),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(async () => ({ id: 'mg-1', channel_type: 'slack', platform_id: 'slack:C1' })),
}));
vi.mock('../../db/central-lease.js', () => ({
  withCentralSync: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: vi.fn(async (...args: unknown[]) => {
      h.deliveries.push({ args });
      return `msg-${h.deliveries.length}`;
    }),
  }),
}));
vi.mock('../approvals/primitive.js', () => ({
  pickOwnersFirst: vi.fn(async () => ['slack:UOWNER']),
  pickApprovalDelivery: vi.fn(async (approvers: string[]) => ({
    userId: approvers[0],
    messagingGroup: { channel_type: 'slack', platform_id: 'slack:D1', instance: 'slack' },
  })),
  notifyAgent: vi.fn(async (_session: unknown, text: string) => {
    h.notes.push(text);
  }),
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  isOwner: (id: string) => h.owners.has(id),
  isGlobalAdmin: () => false,
}));
vi.mock('../../log.js', () => {
  const record = (...args: unknown[]) => {
    h.logs.push(args);
  };
  return { log: { info: record, warn: record, error: record, debug: record } };
});

import { withCentralSync } from '../../db/central-lease.js';
import {
  __resetSecretIntakesForTest,
  getSecretIntake,
  grantSecret,
  secretIntakeHooks,
  startSecretIntake,
} from './service.js';

const hooks = secretIntakeHooks('slack');
const agentCaller = { kind: 'agent' as const, sessionId: 'sess-1', agentGroupId: 'ag-1' };
const newKey = {
  name: 'Linear-API-Key',
  rotate: false,
  hostPattern: 'api.linear.app',
  groups: [] as string[],
  workgroups: [] as string[],
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function everythingObservable(): string {
  return JSON.stringify({
    deliveries: h.deliveries,
    notes: h.notes,
    logs: h.logs,
    grants: [h.groupGrants, h.workgroupGrants],
  });
}

beforeEach(() => {
  __resetSecretIntakesForTest();
  h.vault.clear();
  h.createCalls.length = 0;
  h.updateCalls.length = 0;
  h.createFails = false;
  h.deliveries.length = 0;
  h.notes.length = 0;
  h.logs.length = 0;
  h.groupGrants.length = 0;
  h.workgroupGrants.length = 0;
  h.groups.clear();
  h.groups.set('ag-1', { id: 'ag-1', name: 'Helper', folder: 'donny', workgroup_id: 'wg-a' });
  h.groups.set('ag-2', { id: 'ag-2', name: 'Other', folder: 'other', workgroup_id: 'wg-b' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSecretIntake', () => {
  it('posts a card naming the host and grants, and grants the calling group by default', async () => {
    const view = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(view).toMatchObject({ secretName: 'Linear-API-Key', mode: 'create', status: 'pending', groups: ['ag-1'] });
    expect(h.deliveries).toHaveLength(1);
    const content = JSON.parse(h.deliveries[0].args[4] as string);
    expect(content).toMatchObject({ type: 'secret_intake', intakeId: view.intakeId });
    expect(content.body).toContain('api.linear.app');
    expect(content.body).toContain('Authorization: Bearer <secret>');
    expect(content.body).toContain('groups ag-1');
    expect(content.body).toContain('Agent "Helper"');
  });

  it.each([
    [{ name: 'bad name!' }, /Secret names/],
    [{ hostPattern: undefined }, /--host-pattern is required/],
    [{ hostPattern: 'https://api.linear.app/v1' }, /--host-pattern is required/],
    [{ valueFormat: 'Bearer' }, /containing \{value\}/],
    [{ valueFormat: 'Bearer {value}\nX-Other: 1' }, /one line/],
    [{ hostPattern: '*' }, /--host-pattern is required/],
    [{ hostPattern: '*.com' }, /--host-pattern is required/],
    [{ hostPattern: '*.linear.app' }, /--host-pattern is required/],
    [{ hostPattern: '*.co.uk' }, /--host-pattern is required/],
    [{ pathPattern: 'v1/*' }, /must start with \//],
    [{ headerName: 'Bad Header' }, /Invalid header name/],
    [{ groups: ['ag-2'] }, /only to its own group/],
    [{ workgroups: ['wg-b'] }, /only to its own workgroup/],
    [{ rotate: true, hostPattern: 'api.linear.app' }, /Drop those flags/],
  ])('refuses %o before posting anything', async (override, message) => {
    await expect(startSecretIntake({ ...newKey, ...override, caller: agentCaller })).rejects.toThrow(message);
    expect(h.deliveries).toHaveLength(0);
  });

  it('refuses a new name the vault already has, and a rotation of one it lacks', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/Pass --rotate/);
    await expect(
      startSecretIntake({ name: 'Missing', rotate: true, groups: [], workgroups: [], caller: agentCaller }),
    ).rejects.toThrow(/nothing to rotate/);
  });

  it('refuses a second pending intake for the same name', async () => {
    await startSecretIntake({ ...newKey, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/already waiting/);
  });

  it('caps the pending requests one session can hold', async () => {
    for (const n of ['A', 'B', 'C']) await startSecretIntake({ ...newKey, name: `Key-${n}`, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, name: 'Key-D', caller: agentCaller })).rejects.toThrow(/already has 3/);
    expect(h.deliveries).toHaveLength(3);
  });

  it('lets the host grant to any existing group and workgroup', async () => {
    const view = await startSecretIntake({
      ...newKey,
      groups: ['ag-1,ag-2'],
      workgroups: ['wg-b'],
      caller: { kind: 'host' },
    });
    expect(view.groups).toEqual(['ag-1', 'ag-2']);
    expect(view.workgroups).toEqual(['wg-b']);
    await expect(
      startSecretIntake({ ...newKey, name: 'Other-Key', workgroups: ['wg-nope'], caller: { kind: 'host' } }),
    ).rejects.toThrow(/Workgroup not found/);
  });
});

describe('the form', () => {
  it('stores nothing for a submit by someone other than an owner or global admin, and stays open', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await hooks.submit(intakeId, 'USTRANGER', SECRET)).toEqual({ ok: true });
    await settle();
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    expect(everythingObservable()).not.toContain(SECRET);
    await hooks.submit(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
  });

  it('answers open and submit without waiting on the central lease', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({ ok: true, form: { title: 'Store secret' } });
      expect(await hooks.submit(intakeId, 'UOWNER', SECRET)).toEqual({ ok: true });
    } finally {
      vi.mocked(withCentralSync).mockImplementation((async (fn: () => unknown) => fn()) as never);
    }
  });

  it('counts a submitted, still-storing intake as live for the same name', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      await hooks.submit(intakeId, 'UOWNER', SECRET);
      expect(getSecretIntake(intakeId)?.status).toBe('storing');
      await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/already waiting/);
    } finally {
      vi.mocked(withCentralSync).mockImplementation((async (fn: () => unknown) => fn()) as never);
    }
  });

  it('fails the intake, visibly, when the authority lookup throws', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementationOnce(async () => {
      throw new Error('central DB unavailable');
    });
    await hooks.submit(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)).toMatchObject({ status: 'failed', detail: 'central DB unavailable' });
    expect(h.createCalls).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('refuses an empty value or one with whitespace, keeping the intake pending', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await hooks.submit(intakeId, 'UOWNER', '  ')).toEqual({ ok: false, message: 'Paste the secret value.' });
    expect(await hooks.submit(intakeId, 'UOWNER', 'sk one')).toMatchObject({ ok: false });
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('stores the value, grants after the store, edits the card and tells the agent — without the value', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, workgroups: ['wg-a'], caller: agentCaller });
    expect(await hooks.submit(intakeId, 'UOWNER', `  ${SECRET}\n`)).toEqual({ ok: true });
    await settle();

    expect(h.createCalls).toEqual([
      {
        spec: {
          name: 'Linear-API-Key',
          hostPattern: 'api.linear.app',
          pathPattern: null,
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        },
        value: SECRET,
      },
    ]);
    expect(h.workgroupGrants).toEqual(['wg-a:Linear-API-Key']);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
    const edit = JSON.parse(h.deliveries[1].args[4] as string);
    expect(edit).toMatchObject({ operation: 'edit', messageId: 'msg-1' });
    expect(edit.text).toContain('Stored');
    expect(h.notes[0]).toContain('is stored in the vault');

    expect(everythingObservable()).not.toContain(SECRET);
    expect(JSON.stringify(getSecretIntake(intakeId))).not.toContain(SECRET);
    expect(await hooks.submit(intakeId, 'UOWNER', SECRET)).toMatchObject({ ok: false });
  });

  it('writes once when two submits race past the authority check', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    const results = await Promise.all([
      hooks.submit(intakeId, 'UOWNER', SECRET),
      hooks.submit(intakeId, 'UOWNER', SECRET),
    ]);
    await settle();
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.createCalls).toHaveLength(1);
  });

  it('rotates by value only', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const { intakeId } = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: { kind: 'host' },
    });
    await hooks.submit(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 'id-1', name: 'Linear-API-Key' }, value: SECRET }]);
    expect(h.createCalls).toHaveLength(0);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('grants nothing when the vault write fails, and says so', async () => {
    h.createFails = true;
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await hooks.submit(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.groupGrants).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('expires after 15 minutes', async () => {
    vi.useFakeTimers();
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.advanceTimersByTime(15 * 60_000);
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expired/),
    });
    expect(getSecretIntake(intakeId)?.status).toBe('expired');
  });
});

describe('grantSecret', () => {
  it('grants an existing secret and refuses one the vault lacks', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    expect(
      await grantSecret({ name: 'Linear-API-Key', groups: ['ag-2'], workgroups: ['wg-b'], caller: { kind: 'host' } }),
    ).toEqual({
      secretName: 'Linear-API-Key',
      addedGroups: ['ag-2'],
      addedWorkgroups: ['wg-b'],
      alreadyGranted: [],
    });
    await expect(
      grantSecret({ name: 'Nope', groups: ['ag-2'], workgroups: [], caller: { kind: 'host' } }),
    ).rejects.toThrow(/not in the vault/);
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: [], caller: agentCaller }),
    ).rejects.toThrow(/at least one/);
  });

  it('holds an agent to its own group and workgroup, as intake does', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: ['wg-b'], caller: agentCaller }),
    ).rejects.toThrow(/only to its own workgroup/);
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: ['ag-2'], workgroups: [], caller: agentCaller }),
    ).rejects.toThrow(/only to its own group/);
    expect(
      await grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: ['wg-a'], caller: agentCaller }),
    ).toMatchObject({ addedGroups: [], addedWorkgroups: ['wg-a'] });
    expect(h.groupGrants).toEqual([]);
  });
});
