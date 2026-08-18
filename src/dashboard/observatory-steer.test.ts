import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, getDb } from '../db/connection.js';
import { observatorySteerHandler, recordClaimThread, _resetSteerDedupeForTesting } from './observatory-steer.js';
import type { AuthedRequestContext } from './router.js';

import { dispatch as _dispatchRaw } from '../cli/dispatch.js';
import { readClaims as _readClaimsRaw } from '../claims-board.js';
import { readReleaseState as _readReleaseStateRaw } from './api/observatory.js';
import { getChannelAdapter as _getChannelAdapterRaw } from '../channels/channel-registry.js';
import { claimsBaseDir as _claimsBaseDirRaw } from '../modules/claims/escalation.js';

const mockDispatch = vi.mocked(_dispatchRaw);
const mockReadClaims = vi.mocked(_readClaimsRaw);
const mockReleaseState = vi.mocked(_readReleaseStateRaw);
const mockGetAdapter = vi.mocked(_getChannelAdapterRaw);
const mockClaimsRoot = vi.mocked(_claimsBaseDirRaw);

// Same seams nudge.test.ts stubs, same reason: task machinery and claim reads
// have their own suites. What THIS one pins is everything in front of them —
// who may steer, whether the operator's words survive intact, which thread the
// task lands in, and what happens when there is no thread yet.
vi.mock('../cli/dispatch.js', () => ({ dispatch: vi.fn() }));
vi.mock('../claims-board.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../claims-board.js')>()),
  readClaims: vi.fn(),
}));
vi.mock('./api/observatory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/observatory.js')>()),
  readReleaseState: vi.fn(),
}));
vi.mock('../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../channels/channel-registry.js')>()),
  getChannelAdapter: vi.fn(() => undefined),
}));
// Pinned to a temp root so the handler's OWN record-back is exercised for real
// and can never reach into the live data dir.
vi.mock('../modules/claims/escalation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/claims/escalation.js')>()),
  claimsBaseDir: vi.fn(),
}));

const OWNER = 'u-owner';
const MEMBER = 'u-member';
const STRANGER = 'u-stranger';

function ctxFor(userId: string): AuthedRequestContext {
  return {
    rawNodeReq: {} as never,
    user: { id: userId, kind: 'email', display_name: userId === OWNER ? 'Olive Owner' : null, created_at: '' },
    scopes: { role: userId === OWNER ? 'owner' : 'member', allowed_group_ids: [], no_filter: userId === OWNER },
  };
}

function post(body: unknown): Request {
  return new Request('http://localhost/dashboard/api/observatory/steer', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const CLAIM = {
  slug: 'wallet-tieout',
  owner: 'ava',
  note: 'waiting on a review',
  threadId: 'slack:C0EXAMPLE1:1712345678.900100',
  state: 'stale' as const,
  staleMs: 9 * 3600000,
  escalated: false,
};

const THREADLESS = { ...CLAIM, slug: 'no-thread-yet', threadId: null };

const claimsAre = (claims: object[]): void => void mockReadClaims.mockReturnValue(claims as never);

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  _resetSteerDedupeForTesting();
  mockGetAdapter.mockReturnValue(undefined);
  mockReleaseState.mockReturnValue(null);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-claims-'));
  mockClaimsRoot.mockReturnValue(tmpRoot);

  const db = initTestDb();
  db.exec(`
    CREATE TABLE workgroups (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, workgroup_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE user_roles (user_id TEXT NOT NULL, role TEXT NOT NULL, agent_group_id TEXT, granted_at TEXT);
    CREATE TABLE agent_group_members (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, user_id TEXT NOT NULL, added_at TEXT
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_group_agents (
      id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL, agent_group_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    -- migration 050: the item's missing "file", one thread per item.
    CREATE TABLE observatory_item_threads (
      workgroup_id TEXT NOT NULL, item_id TEXT NOT NULL, thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      PRIMARY KEY (workgroup_id, item_id)
    );
    INSERT INTO workgroups VALUES ('wg-1', datetime('now'));
    INSERT INTO agent_groups VALUES ('ag-1', 'ava', 'ava', 'claude', 'wg-1', datetime('now'));
    INSERT INTO user_roles (user_id, role, agent_group_id) VALUES ('${OWNER}', 'owner', NULL);
    INSERT INTO agent_group_members (id, agent_group_id, user_id, added_at) VALUES ('m1', 'ag-1', '${MEMBER}', datetime('now'));
    INSERT INTO messaging_groups VALUES ('mg-1', 'slack-acme', 'slack:C0EXAMPLE1', '#qa-room', datetime('now'));
    INSERT INTO messaging_group_agents VALUES ('w1', 'mg-1', 'ag-1', datetime('now'));
  `);
  mockDispatch.mockResolvedValue({ id: 'x', ok: true, data: { series_id: 'steer-ab12' } });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const steer = (
  userId = OWNER,
  body: object = { workgroupId: 'wg-1', claimSlug: CLAIM.slug, agentGroupId: 'ag-1', text: 'drop it, ship 869 first' },
) => observatorySteerHandler(post(body), {}, ctxFor(userId));

describe('observatorySteerHandler — a claim that already has a thread', () => {
  it('posts the operator’s words into that thread, verbatim and attributed', async () => {
    claimsAre([CLAIM]);
    const res = (await steer())!;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      seriesId: 'steer-ab12',
      threadId: CLAIM.threadId,
      threadCreated: false,
    });

    const [frame, callerCtx] = mockDispatch.mock.calls[0]!;
    expect(frame.command).toBe('tasks-create');
    expect(callerCtx).toEqual({ caller: 'host' });
    expect(frame.args.group).toBe('ag-1');
    expect(frame.args.messaging_group).toBe('mg-1'); // resolved from the thread id's platform prefix
    expect(frame.args.thread_id).toBe(CLAIM.threadId);
    expect(frame.args.recurrence).toBeUndefined(); // one-shot, never a series

    const prompt = frame.args.prompt as string;
    expect(prompt).toContain('Olive Owner steered this from the Observatory');
    expect(prompt).toContain(CLAIM.slug);
    expect(prompt).toContain('drop it, ship 869 first'); // the delta from nudge: the human's own words
    expect(prompt).toContain('name what blocks you');
  });

  it('refuses when the agent is not wired to the thread’s channel', async () => {
    claimsAre([{ ...CLAIM, threadId: 'slack:C0OTHERROOM:1712345678.900100' }]);
    const res = (await steer())!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'agent_not_wired_to_thread_channel' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('reports a failed task create rather than claiming success', async () => {
    claimsAre([CLAIM]);
    mockDispatch.mockResolvedValue({ id: 'x', ok: false, error: 'nope' } as never);
    const res = (await steer())!;
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: 'task_create_failed' });
  });
});

describe('observatorySteerHandler — a claim with no thread', () => {
  it('will not pick a room on its own', async () => {
    claimsAre([THREADLESS]);
    const res = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: THREADLESS.slug,
      agentGroupId: 'ag-1',
      text: 'start this',
    }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'claim_has_no_thread' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('opens a thread in the room the operator NAMED, and records it back onto the claim file', async () => {
    claimsAre([THREADLESS]);
    const postParent = vi.fn().mockResolvedValue({ messageId: '1712999999.000100' });
    const createThread = vi.fn().mockResolvedValue({ threadId: '1712999999.000100', messageId: '1713000000.000200' });
    mockGetAdapter.mockReturnValue({ postParent, createThread } as never);

    // The claim file as claim.sh writes it — flat JSON, no thread_id yet.
    const dir = path.join(tmpRoot, 'wg-1', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${THREADLESS.slug}.json`),
      JSON.stringify({
        owner: 'ava',
        claimed_at: '2026-08-17T12:04:58Z',
        ttl_hours: 2,
        note: 'keep me',
        status: 'active',
      }),
    );

    const res = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: THREADLESS.slug,
      agentGroupId: 'ag-1',
      text: 'start this in qa',
      channel: '#qa-room',
    }))!;

    expect(res.status).toBe(200);
    // Encoded form (`<platform_id>:<bare>`) — chat-sdk routes on that, not the bare ts.
    expect(await res.json()).toMatchObject({
      ok: true,
      threadId: 'slack:C0EXAMPLE1:1712999999.000100',
      threadCreated: true,
      recordedOnClaim: true,
    });
    expect(postParent).toHaveBeenCalledWith('slack:C0EXAMPLE1', expect.stringContaining(THREADLESS.slug));
    expect(createThread).toHaveBeenCalledWith(
      'slack:C0EXAMPLE1',
      '1712999999.000100',
      THREADLESS.slug,
      'start this in qa',
    );
    expect(mockDispatch.mock.calls[0]![0].args.thread_id).toBe('slack:C0EXAMPLE1:1712999999.000100');

    // The handler's OWN record-back, against the same schema claim.sh owns:
    // thread_id added, every other field preserved.
    const written = JSON.parse(fs.readFileSync(path.join(dir, `${THREADLESS.slug}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(written).toEqual({
      owner: 'ava',
      claimed_at: '2026-08-17T12:04:58Z',
      ttl_hours: 2,
      note: 'keep me',
      status: 'active',
      thread_id: 'slack:C0EXAMPLE1:1712999999.000100',
    });
  });

  it('never overwrites a thread the owning agent backfilled first', () => {
    const dir = path.join(tmpRoot, 'wg-1', 'claims');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'raced.json'), JSON.stringify({ owner: 'ava', thread_id: 'slack:C0THEIRS:1.2' }));

    expect(recordClaimThread('wg-1', 'raced', 'slack:C0OURS:9.9', tmpRoot)).toBe(false);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'raced.json'), 'utf8')) as Record<string, unknown>;
    expect(after['thread_id']).toBe('slack:C0THEIRS:1.2');
  });

  it('reports a missing claim file instead of throwing', () => {
    expect(recordClaimThread('wg-1', 'never-existed', 'slack:C0X:1.2', tmpRoot)).toBe(false);
  });

  it('refuses a room the agent is not wired to, and one that cannot open threads', async () => {
    claimsAre([THREADLESS]);
    const notWired = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: THREADLESS.slug,
      agentGroupId: 'ag-1',
      text: 'x',
      channel: '#somewhere-else',
    }))!;
    expect(notWired.status).toBe(409);
    expect(await notWired.json()).toMatchObject({ error: 'agent_not_wired_to_channel' });

    mockGetAdapter.mockReturnValue({} as never); // adapter with no postParent/createThread
    const noThreads = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: THREADLESS.slug,
      agentGroupId: 'ag-1',
      text: 'x',
      channel: '#qa-room',
    }))!;
    expect(noThreads.status).toBe(409);
    expect(await noThreads.json()).toMatchObject({ error: 'channel_cannot_open_threads' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});

describe('observatorySteerHandler — release-board items', () => {
  const itemsAre = (items: object[]) => mockReleaseState.mockReturnValue({ asOf: '', items } as never);

  it('opens a thread in the room the BOARD gives the item, and steers into it', async () => {
    const postParent = vi.fn().mockResolvedValue({ messageId: '1712999999.000100' });
    const createThread = vi.fn().mockResolvedValue({ threadId: '1712999999.000100', messageId: '1713000000.000200' });
    mockGetAdapter.mockReturnValue({ postParent, createThread } as never);
    itemsAre([{ id: 'XZ#912', kind: 'pr', title: 'money writes', nextMover: 'agent', channel: '#qa-room' }]);

    const res = (await steer(OWNER, {
      workgroupId: 'wg-1',
      itemId: 'XZ#912',
      agentGroupId: 'ag-1',
      text: 'ship it once CI is green',
    }))!;

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      threadId: 'slack:C0EXAMPLE1:1712999999.000100',
      threadCreated: true,
    });
    expect(postParent).toHaveBeenCalledWith('slack:C0EXAMPLE1', expect.stringContaining('XZ#912'));
    expect(createThread).toHaveBeenCalledWith(
      'slack:C0EXAMPLE1',
      '1712999999.000100',
      'XZ#912',
      'ship it once CI is green',
    );
    expect(mockDispatch.mock.calls[0]![0].args.thread_id).toBe('slack:C0EXAMPLE1:1712999999.000100');
    expect(mockDispatch.mock.calls[0]![0].args.prompt).toContain('XZ#912');
  });

  it('takes the room from the board, NOT from the request — a browser cannot redirect the post', async () => {
    const postParent = vi.fn().mockResolvedValue({ messageId: '1.1' });
    const createThread = vi.fn().mockResolvedValue({ threadId: '1.1', messageId: '1.2' });
    mockGetAdapter.mockReturnValue({ postParent, createThread } as never);
    itemsAre([{ id: 'XZ#912', kind: 'pr', title: 't', nextMover: 'agent', channel: '#qa-room' }]);

    const res = (await steer(OWNER, {
      workgroupId: 'wg-1',
      itemId: 'XZ#912',
      agentGroupId: 'ag-1',
      text: 'x',
      channel: '#somewhere-the-operator-typed',
    }))!;

    expect(res.status).toBe(200);
    // #qa-room is the board's channel; the request's channel is ignored outright.
    expect(postParent).toHaveBeenCalledWith('slack:C0EXAMPLE1', expect.anything());
  });

  it('reports an item with no room rather than picking one', async () => {
    itemsAre([{ id: 'XZ#1', kind: 'pr', title: 't', nextMover: 'agent' }]);
    const res = (await steer(OWNER, { workgroupId: 'wg-1', itemId: 'XZ#1', agentGroupId: 'ag-1', text: 'ship it' }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'item_has_no_room' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('refuses a room this agent is not wired to', async () => {
    itemsAre([{ id: 'XZ#2', kind: 'pr', title: 't', nextMover: 'agent', channel: '#not-wired' }]);
    const res = (await steer(OWNER, { workgroupId: 'wg-1', itemId: 'XZ#2', agentGroupId: 'ag-1', text: 'x' }))!;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'agent_not_wired_to_channel' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('404s an item that is not on the board at all', async () => {
    itemsAre([]);
    const res = (await steer(OWNER, { workgroupId: 'wg-1', itemId: 'XZ#9', agentGroupId: 'ag-1', text: 'ship it' }))!;
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'item_not_on_board' });
  });

  /* obs.C.33 — an item has no file to write a thread id back to (a claim does),
   * so the board was stateless about ships: a second press opened a SECOND
   * thread for the same work and the agent got the same ask twice in two
   * places. `observatory_item_threads` is that missing file. */
  describe('one item, one thread', () => {
    const threading = () => {
      const postParent = vi.fn().mockResolvedValue({ messageId: '1.1' });
      const createThread = vi
        .fn()
        .mockImplementation((_p, parent: string) => Promise.resolve({ threadId: parent, messageId: '1.2' }));
      mockGetAdapter.mockReturnValue({ postParent, createThread } as never);
      itemsAre([{ id: 'XZ#912', kind: 'pr', title: 'money writes', nextMover: 'agent', channel: '#qa-room' }]);
      return { postParent, createThread };
    };
    const rows = () =>
      getDb().prepare('SELECT workgroup_id, item_id, thread_id, created_by FROM observatory_item_threads').all();
    const ship = (text: string) => steer(OWNER, { workgroupId: 'wg-1', itemId: 'XZ#912', agentGroupId: 'ag-1', text });

    it('records the thread the first steer opened, against the item and the operator', async () => {
      threading();
      const res = (await ship('ship it'))!;
      expect(await res.json()).toMatchObject({ threadCreated: true });
      expect(rows()).toEqual([
        { workgroup_id: 'wg-1', item_id: 'XZ#912', thread_id: 'slack:C0EXAMPLE1:1.1', created_by: OWNER },
      ]);
    });

    it('a second steer continues that thread instead of opening another', async () => {
      const { postParent } = threading();
      await ship('ship it');
      expect(postParent).toHaveBeenCalledTimes(1);

      const res = (await ship('actually, hold for CI'))!;
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        threadId: 'slack:C0EXAMPLE1:1.1',
        threadCreated: false,
        existing: true,
      });
      // No parent post, no new thread, and the ask still landed in the first one.
      expect(postParent).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(1);
      expect(mockDispatch.mock.calls[1]![0].args.thread_id).toBe('slack:C0EXAMPLE1:1.1');
    });

    it('two concurrent steers open exactly one thread, and both land in it', async () => {
      const { postParent } = threading();
      // Distinct text: the text-keyed double-click guard must not be what
      // saves this — the point is that two genuine sends still share a thread.
      const [a, b] = await Promise.all([ship('ship it'), ship('and watch the promote')]);

      expect(postParent).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(1);
      const bodies = (await Promise.all([a!.json(), b!.json()])) as {
        threadId: string;
        threadCreated: boolean;
        existing?: boolean;
      }[];
      expect(bodies.map((r) => r.threadId)).toEqual(['slack:C0EXAMPLE1:1.1', 'slack:C0EXAMPLE1:1.1']);
      // Exactly one of them created it; the other says it continued one.
      expect(bodies.filter((r) => r.threadCreated)).toHaveLength(1);
      expect(bodies.filter((r) => r.existing)).toHaveLength(1);
    });

    it('refuses to continue a recorded thread the agent is not wired to', async () => {
      threading();
      getDb()
        .prepare(
          `INSERT INTO observatory_item_threads VALUES ('wg-1', 'XZ#912', 'slack:C0OTHERROOM:9.9', '2026-08-18T00:00:00.000Z', '${OWNER}')`,
        )
        .run();
      const res = (await ship('ship it'))!;
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'agent_not_wired_to_thread_channel' });
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("scopes the memory to the workgroup — another workgroup's XZ#912 is not this one", async () => {
      threading();
      getDb()
        .prepare(
          `INSERT INTO observatory_item_threads VALUES ('wg-other', 'XZ#912', 'slack:C0OTHERROOM:9.9', '2026-08-18T00:00:00.000Z', '${OWNER}')`,
        )
        .run();
      const res = (await ship('ship it'))!;
      expect(await res.json()).toMatchObject({ threadId: 'slack:C0EXAMPLE1:1.1', threadCreated: true });
    });
  });
});

describe('observatorySteerHandler — the gate', () => {
  it('rejects an empty or whitespace-only steer before anything else happens', async () => {
    claimsAre([CLAIM]);
    for (const text of ['', '   \n  ']) {
      const res = (await steer(OWNER, { workgroupId: 'wg-1', claimSlug: CLAIM.slug, agentGroupId: 'ag-1', text }))!;
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'empty_text' });
    }
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('caps the length — nobody pastes a log into an agent’s prompt', async () => {
    claimsAre([CLAIM]);
    const res = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: CLAIM.slug,
      agentGroupId: 'ag-1',
      text: 'x'.repeat(2001),
    }))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'text_too_long' });
  });

  it('a member cannot steer, and a stranger is not told the group exists', async () => {
    claimsAre([CLAIM]);
    expect((await steer(MEMBER))!.status).toBe(403);
    expect((await steer(STRANGER))!.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('requires the ids, rejects malformed json, and steers one thing at a time', async () => {
    claimsAre([CLAIM]);
    expect((await observatorySteerHandler(post('{nope'), {}, ctxFor(OWNER)))!.status).toBe(400);
    expect((await steer(OWNER, { workgroupId: 'wg-1', text: 'hi' }))!.status).toBe(400);
    const both = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: 'a',
      itemId: 'b',
      agentGroupId: 'ag-1',
      text: 'hi',
    }))!;
    expect(both.status).toBe(400);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('404s a claim that is not on the board', async () => {
    claimsAre([]);
    expect((await steer())!.status).toBe(404);
  });

  it('swallows an accidental double-click but lets a second thought through', async () => {
    claimsAre([CLAIM]);
    expect((await steer())!.status).toBe(200);
    expect((await steer())!.status).toBe(429); // same words, same claim, same minute
    const different = (await steer(OWNER, {
      workgroupId: 'wg-1',
      claimSlug: CLAIM.slug,
      agentGroupId: 'ag-1',
      text: 'actually, hold off',
    }))!;
    expect(different.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });
});
