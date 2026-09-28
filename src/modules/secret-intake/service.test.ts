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
  groupAdmins: new Set<string>(['slack:UADMIN1|ag-1', 'slack:UADMIN2|ag-2']),
  originType: 'slack',
  notifyFails: false,
  ownerIds: ['slack:UOWNER'],
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
  getSession: vi.fn(async (id: string) => ({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'T1',
  })),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(async () => ({
    id: 'mg-1',
    channel_type: h.originType,
    platform_id: 'slack:C1',
    name: 'ops',
  })),
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
  pickOwnersFirst: vi.fn(async () => h.ownerIds),
  pickApprovalDelivery: vi.fn(async (approvers: string[]) =>
    approvers[0].startsWith('discord')
      ? {
          userId: approvers[0],
          messagingGroup: { channel_type: 'discord', platform_id: 'discord:D9', instance: 'discord' },
        }
      : { userId: approvers[0], messagingGroup: { channel_type: 'slack', platform_id: 'slack:D1', instance: 'slack' } },
  ),
  notifyAgent: vi.fn(async (_session: unknown, text: string) => {
    if (h.notifyFails) throw new Error('session DB unavailable');
    h.notes.push(text);
  }),
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  isOwner: (id: string) => h.owners.has(id),
  isGlobalAdmin: () => false,
  isAdminOfAgentGroup: (id: string, group: string) => h.groupAdmins.has(`${id}|${group}`),
}));
vi.mock('../permissions/user-dm.js', () => ({
  resolveUserChannelType: vi.fn(async (id: string) => id.slice(0, id.indexOf(':'))),
}));
vi.mock('../permissions/db/users.js', () => ({
  getUser: vi.fn(async (id: string) => ({ id, display_name: `name-of-${id}` })),
}));
vi.mock('../../router.js', () => ({
  isSlackChannelType: (type: string) => type === 'slack' || type.startsWith('slack-'),
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
const submitValue = (intakeId: string, userId: string, value: string) =>
  hooks.submit(intakeId, userId, { secret_value: value });
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
  h.originType = 'slack';
  h.notifyFails = false;
  h.ownerIds = ['slack:UOWNER'];
  h.groups.set('ag-1', { id: 'ag-1', name: 'Helper', folder: 'helper', workgroup_id: 'wg-a' });
  h.groups.set('ag-2', { id: 'ag-2', name: 'Other', folder: 'other', workgroup_id: 'wg-b' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSecretIntake', () => {
  it('posts the card into the requesting thread, or to an owner DM for the host', async () => {
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:C1', 'T1']);
    await startSecretIntake({ ...newKey, name: 'Host-Key', caller: { kind: 'host' } });
    expect(h.deliveries[1].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
    expect(JSON.parse(h.deliveries[1].args[4] as string).body).toContain('Only an owner or global admin can enter it.');
  });

  it('sends a rotation to an owner DM, since only an owner can fill it', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    await startSecretIntake({ name: 'Linear-API-Key', rotate: true, groups: [], workgroups: [], caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
  });

  it("picks an owner's Slack DM over an earlier owner's Discord DM", async () => {
    h.ownerIds = ['discord:UFIRST', 'slack-inst:UOWNER'];
    await startSecretIntake({ ...newKey, caller: { kind: 'host' } });
    expect(h.deliveries[0].args.slice(0, 2)).toEqual(['slack', 'slack:D1']);
  });

  it('sends a card from a platform that cannot open forms to an owner DM instead', async () => {
    h.originType = 'discord';
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
  });

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

  it("refuses a second pending intake for the same name from someone else, but replaces the requester's own", async () => {
    const first = await startSecretIntake({ ...newKey, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, caller: { kind: 'host' } })).rejects.toThrow(/already waiting/);
    const second = await startSecretIntake({ ...newKey, hostPattern: 'api2.linear.app', caller: agentCaller });
    expect(getSecretIntake(first.intakeId)?.status).toBe('expired');
    expect(JSON.parse(h.deliveries[1].args[4] as string)).toMatchObject({ operation: 'edit', messageId: 'msg-1' });
    expect(JSON.parse(h.deliveries[1].args[4] as string).text).toContain('Replaced by a newer request');
    expect(await hooks.open(first.intakeId, 'UOWNER')).toMatchObject({ ok: false });
    expect(getSecretIntake(second.intakeId)?.status).toBe('pending');
  });

  it('lets a session at its cap replace one of its own requests', async () => {
    for (const n of ['A', 'B', 'C']) await startSecretIntake({ ...newKey, name: `Key-${n}`, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, name: 'Key-A', caller: agentCaller })).resolves.toMatchObject({
      status: 'pending',
    });
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
  it('stores nothing for a submit by someone with no authority, says so in the thread, and stays open', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await submitValue(intakeId, 'USTRANGER', SECRET)).toEqual({ ok: true });
    await settle();
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    const note = h.deliveries.at(-1)!.args;
    expect(note.slice(0, 4)).toEqual(['slack', 'slack:C1', 'T1', 'chat']);
    expect(JSON.parse(note[4] as string).text).toMatch(/Only an owner, a global admin or an admin of "Helper"/);
    expect(everythingObservable()).not.toContain(SECRET);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
  });

  it('refuses the form up front when the lease answers in time and the clicker has no authority', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await hooks.open(intakeId, 'USTRANGER')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Only/),
    });
    expect(await hooks.open(intakeId, 'UADMIN2')).toMatchObject({ ok: false });
    expect(await hooks.open(intakeId, 'UADMIN1')).toMatchObject({ ok: true });
  });

  it("lets an admin of the requesting agent's group store it, and tells the owner without the value", async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
    const fyi = h.deliveries.find((d) => d.args[1] === 'slack:D1' && d.args[3] === 'chat');
    expect(fyi).toBeDefined();
    const text = JSON.parse(fyi!.args[4] as string).text as string;
    expect(text).toContain('name-of-slack:UADMIN1');
    expect(text).toContain('Linear-API-Key');
    expect(text).toContain('api.linear.app');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('sends the owner no notice when an owner stores it', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.deliveries.some((d) => d.args[1] === 'slack:D1')).toBe(false);
  });

  it('refuses an admin of another group', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN2', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('never lets a group admin rotate; an owner still can', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const { intakeId } = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: agentCaller,
    });
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).toContain('Only an owner or global admin can enter it.');
    expect(await hooks.open(intakeId, 'UADMIN1')).toMatchObject({ ok: false });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(1);
  });

  it('sends the owner notice even when a later follow-up fails', async () => {
    h.notifyFails = true;
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
    expect(h.deliveries.some((d) => d.args[1] === 'slack:D1' && d.args[3] === 'chat')).toBe(true);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
  });

  it('answers open and submit without waiting on the central lease', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({ ok: true, form: { title: 'Store secret' } });
      expect(await submitValue(intakeId, 'UOWNER', SECRET)).toEqual({ ok: true });
    } finally {
      vi.mocked(withCentralSync).mockImplementation((async (fn: () => unknown) => fn()) as never);
    }
  });

  it('counts a submitted, still-storing intake as live for the same name', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      await submitValue(intakeId, 'UOWNER', SECRET);
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
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)).toMatchObject({ status: 'failed', detail: 'central DB unavailable' });
    expect(h.createCalls).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('refuses an empty value or one with whitespace, keeping the intake pending', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await submitValue(intakeId, 'UOWNER', '  ')).toEqual({
      ok: false,
      field: 'secret_value',
      message: 'Paste a value for "Secret value".',
    });
    expect(await submitValue(intakeId, 'UOWNER', 'sk one')).toMatchObject({ ok: false });
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('stores the value, grants after the store, edits the card and tells the agent — without the value', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, workgroups: ['wg-a'], caller: agentCaller });
    expect(await submitValue(intakeId, 'UOWNER', `  ${SECRET}\n`)).toEqual({ ok: true });
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
    expect(h.notes[0]).toContain('Secret "Linear-API-Key" stored in the vault');

    expect(everythingObservable()).not.toContain(SECRET);
    expect(JSON.stringify(getSecretIntake(intakeId))).not.toContain(SECRET);
    expect(await submitValue(intakeId, 'UOWNER', SECRET)).toMatchObject({ ok: false });
  });

  it('writes once when two submits race past the authority check', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    const results = await Promise.all([
      submitValue(intakeId, 'UOWNER', SECRET),
      submitValue(intakeId, 'UOWNER', SECRET),
    ]);
    await settle();
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.createCalls).toHaveLength(1);
  });

  it('grants nothing new on a rotation unless asked', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const view = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: agentCaller,
    });
    expect(view.groups).toEqual([]);
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).toContain('New grants: none; current holders keep it');
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).not.toContain('nobody yet');
    await submitValue(view.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.groupGrants).toEqual([]);
    expect(JSON.parse(h.deliveries[1].args[4] as string).text).toContain('New grants: none; current holders keep it');
    expect(h.notes[0]).toContain('New grants: none; current holders keep it');
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
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 'id-1', name: 'Linear-API-Key' }, value: SECRET }]);
    expect(h.createCalls).toHaveLength(0);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('grants nothing when the vault write fails, and says so', async () => {
    h.createFails = true;
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.groupGrants).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('stays open for a day, then expires', async () => {
    vi.useFakeTimers();
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.advanceTimersByTime(24 * 60 * 60_000 - 1);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expired/),
    });
    expect(getSecretIntake(intakeId)?.status).toBe('expired');
  });
});

describe('declared fields', () => {
  const CLIENT_ID = 'cid-SENTINEL-4f1a';
  const API_SECRET = 'as-SENTINEL-77b0';
  const COMPOSED = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
  const basic = {
    ...newKey,
    name: 'Example-Client',
    hostPattern: 'auth.example.com',
    compose: 'basic',
    fields: ['client_id|Client ID', 'client_secret|Client secret'],
  };
  const separate = {
    ...newKey,
    name: 'Example-API',
    hostPattern: 'api.example.com',
    fields: ['api_key|API key|X-Api-Key', 'api_secret?|API secret|X-Api-Secret|Token {value}'],
  };
  const rotation = {
    rotate: true,
    groups: [] as string[],
    workgroups: [] as string[],
    caller: { kind: 'host' as const },
  };

  it('opens one input per field and lists them on the card, basic defaulting to Basic', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    const body = JSON.parse(h.deliveries[0].args[4] as string).body as string;
    expect(body).toContain('asks for "Client ID", "Client secret"');
    expect(body).toContain('Basic <secret>');
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      ok: true,
      form: {
        inputs: [
          { id: 'client_id', label: 'Client ID', optional: false },
          { id: 'client_secret', label: 'Client secret', optional: false },
        ],
      },
    });
  });

  it('basic stores base64 of "<first>:<second>" as one secret, exposing none of the three values', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    expect(
      await hooks.submit(intakeId, 'UADMIN1', { client_id: ` ${CLIENT_ID} `, client_secret: `${SECRET}\n` }),
    ).toEqual({ ok: true });
    await settle();
    expect(h.createCalls).toEqual([
      { spec: expect.objectContaining({ name: 'Example-Client', valueFormat: 'Basic {value}' }), value: COMPOSED },
    ]);
    const observed = everythingObservable() + JSON.stringify(getSecretIntake(intakeId));
    for (const leaked of [CLIENT_ID, SECRET, COMPOSED]) expect(observed).not.toContain(leaked);
  });

  it('separate stores each field as its own secret with its own header, and grants every one', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, workgroups: ['wg-a'], caller: agentCaller });
    const body = JSON.parse(h.deliveries[0].args[4] as string).body as string;
    expect(body).toContain('"API key" → Example-API-api_key');
    expect(body).toContain('"API secret" (optional)');
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      form: {
        inputs: [
          { id: 'api_key', optional: false },
          { id: 'api_secret', optional: true },
        ],
      },
    });
    await hooks.submit(intakeId, 'UOWNER', { api_key: SECRET, api_secret: API_SECRET });
    await settle();
    expect(h.createCalls).toEqual([
      {
        spec: expect.objectContaining({ name: 'Example-API-api_key', headerName: 'X-Api-Key', valueFormat: '{value}' }),
        value: SECRET,
      },
      {
        spec: expect.objectContaining({
          name: 'Example-API-api_secret',
          headerName: 'X-Api-Secret',
          valueFormat: 'Token {value}',
        }),
        value: API_SECRET,
      },
    ]);
    expect(h.workgroupGrants).toEqual(['wg-a:Example-API-api_key', 'wg-a:Example-API-api_secret']);
    expect(getSecretIntake(intakeId)?.secrets).toEqual(['Example-API-api_key', 'Example-API-api_secret']);
    const observed = everythingObservable() + JSON.stringify(getSecretIntake(intakeId));
    for (const leaked of [SECRET, API_SECRET]) expect(observed).not.toContain(leaked);
  });

  it('stores nothing, and grants nothing, for a blank optional field', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, caller: agentCaller });
    await hooks.submit(intakeId, 'UOWNER', { api_key: SECRET, api_secret: '' });
    await settle();
    expect(h.createCalls.map((c) => (c.spec as { name: string }).name)).toEqual(['Example-API-api_key']);
    expect(h.groupGrants).toEqual(['ag-1:Example-API-api_key']);
  });

  it('a rotation replaces only the fields filled in', async () => {
    h.vault.set('Example-API-api_key', { id: 'k', name: 'Example-API-api_key' });
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    const { intakeId } = await startSecretIntake({
      ...rotation,
      name: 'Example-API',
      fields: ['api_key|API key', 'api_secret|API secret'],
    });
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      form: { inputs: [{ optional: true }, { optional: true }] },
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { api_key: '', api_secret: '' })).toMatchObject({
      ok: false,
      message: 'Fill in at least one field.',
    });
    await hooks.submit(intakeId, 'UOWNER', { api_key: '', api_secret: API_SECRET });
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 's', name: 'Example-API-api_secret' }, value: API_SECRET }]);
    expect(everythingObservable()).not.toContain(API_SECRET);
  });

  it('a basic rotation takes both fields again', async () => {
    h.vault.set('Example-Client', { id: 'id-1', name: 'Example-Client' });
    const { intakeId } = await startSecretIntake({
      ...rotation,
      name: 'Example-Client',
      compose: 'basic',
      fields: basic.fields,
    });
    await hooks.submit(intakeId, 'UOWNER', { client_id: CLIENT_ID, client_secret: SECRET });
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 'id-1', name: 'Example-Client' }, value: COMPOSED }]);
    expect(everythingObservable()).not.toContain(COMPOSED);
  });

  it('refuses an empty required field, whitespace, or a colon in a basic first field, keeping it open', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: CLIENT_ID, client_secret: ' ' })).toMatchObject({
      ok: false,
      field: 'client_secret',
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: 'a b', client_secret: SECRET })).toMatchObject({
      ok: false,
      field: 'client_id',
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: 'a:b', client_secret: SECRET })).toMatchObject({
      ok: false,
      field: 'client_id',
      message: expect.stringMatching(/colon/),
    });
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('reports the secrets already stored when a later one fails, grants none, and still tells the owner', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, caller: agentCaller });
    const { createOnecliSecret } = await import('../../onecli-secret-writer.js');
    vi.mocked(createOnecliSecret).mockImplementationOnce(async (spec, value) => {
      h.createCalls.push({ spec, value });
      h.vault.set(spec.name, { id: 'x', name: spec.name });
      return { id: 'x', name: spec.name };
    });
    h.createFails = true;
    await hooks.submit(intakeId, 'UADMIN1', { api_key: SECRET, api_secret: API_SECRET });
    await settle();
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    const notice = h.deliveries.find((d) => d.args[1] === 'slack:D1');
    expect(JSON.parse(notice?.args[4] as string).text).toContain('stored secret "Example-API-api_key" for agent');
    expect(JSON.parse(notice?.args[4] as string).text).not.toContain('Example-API-api_secret');
    expect(JSON.parse(notice?.args[4] as string).text).toContain('nothing was granted');
    expect(JSON.parse(notice?.args[4] as string).text).not.toContain('Granted to');
    expect(h.notes[0]).toContain('was only partly stored');
    expect(getSecretIntake(intakeId)?.detail).toContain('"Example-API-api_key" stored but granted to no one');
    expect(h.groupGrants).toEqual([]);
    expect(everythingObservable()).not.toContain(API_SECRET);
  });

  it.each([
    [{ fields: ['a|A|X-A', 'a|B|X-B'] }, /declared twice/],
    [{ fields: ['a|A|Bad Header', 'b|B|X-B'] }, /Invalid header name/],
    [{ fields: ['a|A|X-Same', 'b|B|x-same'] }, /Two fields are sent as header/],
    [{ fields: ['a|A', 'b|B|X-B'] }, /"a" needs a header/],
    [{ fields: ['a|A|X-A', 'b|B|X-B'], headerName: 'X-C' }, /its own header/],
    [{ compose: 'basic', fields: ['a|A', 'b?|B'] }, /exactly two required fields/],
    [{ compose: 'basic', fields: ['a|A', 'b|B', 'c|C'] }, /exactly two required fields/],
    [{ compose: 'basic', fields: ['a|A|X-A', 'b|B'] }, /only --compose separate/],
    [{ compose: 'separate', fields: ['a|A|X-A'] }, /two or more fields/],
    [{ fields: ['a?|A'] }, /cannot be optional/],
    [{ compose: 'basic' }, /--compose needs --field/],
    [{ fields: ['Bad-Name|A'] }, /Field name/],
    [{ fields: ['a|A|X-A', 'b|B|X-B', 'c|C|X-C', 'd|D|X-D', 'e|E|X-E', 'f|F|X-F'] }, /At most 5/],
  ])('refuses %o', async (overrides, error) => {
    await expect(startSecretIntake({ ...newKey, ...overrides, caller: agentCaller })).rejects.toThrow(error);
    expect(h.deliveries).toHaveLength(0);
  });

  it('refuses a request whose secrets overlap one already waiting', async () => {
    await startSecretIntake({ ...separate, caller: agentCaller });
    await expect(
      startSecretIntake({ ...newKey, name: 'Example-API-api_secret', caller: { kind: 'host' } }),
    ).rejects.toThrow(/already waiting/);
  });

  it('refuses a header or format on a rotation field', async () => {
    h.vault.set('Example-API-api_key', { id: 'k', name: 'Example-API-api_key' });
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    await expect(
      startSecretIntake({ ...rotation, name: 'Example-API', fields: ['api_key|K|X-Api-Key', 'api_secret|S'] }),
    ).rejects.toThrow(/drop the header and format/);
  });

  it('refuses a separate secret name that would exist, and a rotation of one that does not', async () => {
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    await expect(startSecretIntake({ ...separate, caller: agentCaller })).rejects.toThrow(
      /"Example-API-api_secret" already exists/,
    );
    await expect(
      startSecretIntake({ ...rotation, name: 'Example-API', fields: ['api_key|K', 'api_secret|S'] }),
    ).rejects.toThrow(/"Example-API-api_key" is not in the vault/);
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
