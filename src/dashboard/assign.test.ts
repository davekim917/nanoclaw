import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, getRawDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { clearAttentionMemo } from '../attention-sources.js';
import { assignAttentionItem, ASSIGN_DEDUPE_MS } from './assign.js';
import { readItemAssignment } from './db/item-assignments.js';
import type { AuthedRequestContext } from './router.js';

import { dispatch as _dispatchRaw } from '../cli/dispatch.js';

const mockDispatch = vi.mocked(_dispatchRaw);

// The task machinery has its own tests; here it is a seam. What THIS suite
// pins is everything in front of it: who may assign, which items and channels
// are reachable, that a double press queues once, and that the prompt is
// composed from the board rather than from the request body.
vi.mock('../cli/dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/dispatch.js')>()),
  dispatch: vi.fn(),
}));

const OWNER = 'u-owner';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const STRANGER = 'u-stranger';

const WG = 'wg-example';
const CHANNEL_KEY = 'slack:CEXAMPLE001';
const OTHER_CHANNEL_KEY = 'slack:CEXAMPLE002';
const ITEM_ID = 'EXAMPLE-APP#817';

const tmpdirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

/** A groups root holding one release board for {@link WG}. */
function boardRoot(items: unknown[]): string {
  const root = tmp('assign-board-');
  const dir = path.join(root, WG, 'releases');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'release-state.json'), JSON.stringify({ asOf: '2026-08-20T11:30:00.000Z', items }));
  return root;
}

function readyPr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ITEM_ID,
    kind: 'pr',
    nextMover: 'human',
    owner: 'alice',
    why: 'CI green, mergeable CLEAN',
    since: '2026-08-20T10:00:00.000Z',
    url: 'https://github.com/example-org/example-app/pull/817',
    title: "What's new digest",
    nextAction: '@releasebot ship 817',
    ...over,
  };
}

let env: { groupsRoot: string; claimsRoot: string };

function ctxFor(userId: string, scopes: Partial<AuthedRequestContext['scopes']> = {}): AuthedRequestContext {
  return {
    rawNodeReq: {} as never,
    user: {
      id: userId,
      kind: 'email',
      display_name: userId === OWNER ? 'Olive Owner' : null,
      created_at: '',
    },
    scopes: {
      role: userId === OWNER ? 'owner' : 'member',
      allowed_group_ids: [],
      no_filter: userId === OWNER,
      ...scopes,
    },
  } as AuthedRequestContext;
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearAttentionMemo();
  await initTestDb();
  const db = getRawDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO workgroups (id, created_at) VALUES ('${WG}', '2026-08-01T00:00:00.000Z');
    UPDATE workgroups SET attention_sources =
      '[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]' WHERE id = '${WG}';

    INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at)
      VALUES ('ag-wired', 'ava', 'ava', 'claude', '${WG}', '2026-08-01T00:00:00.000Z'),
             ('ag-elsewhere', 'bea', 'bea', 'claude', '${WG}', '2026-08-01T00:00:00.000Z');

    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('${OWNER}', 'email', 'Olive Owner', '2026-08-01T00:00:00.000Z'),
             ('${ADMIN}', 'email', 'Ada Admin', '2026-08-01T00:00:00.000Z'),
             ('${MEMBER}', 'email', NULL, '2026-08-01T00:00:00.000Z'),
             ('${STRANGER}', 'email', NULL, '2026-08-01T00:00:00.000Z');

    INSERT INTO user_roles (user_id, role, agent_group_id, granted_at)
      VALUES ('${OWNER}', 'owner', NULL, '2026-08-01T00:00:00.000Z'),
             ('${ADMIN}', 'admin', 'ag-wired', '2026-08-01T00:00:00.000Z');
    INSERT INTO agent_group_members (user_id, agent_group_id, added_at)
      VALUES ('${MEMBER}', 'ag-wired', '2026-08-01T00:00:00.000Z');

    INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, created_at)
      VALUES ('mg-room',  'slack-testworkspace', 'testworkspace', '${CHANNEL_KEY}',       '#example-room',  '2026-08-01T00:00:00.000Z'),
             ('mg-other', 'slack-testworkspace', 'testworkspace', '${OTHER_CHANNEL_KEY}', '#example-other', '2026-08-01T00:00:00.000Z');
    INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
      VALUES ('w1', 'mg-room',  'ag-wired',     'per-thread', '2026-08-01T00:00:00.000Z'),
             ('w2', 'mg-other', 'ag-elsewhere', 'per-thread', '2026-08-01T00:00:00.000Z');
  `);
  env = { groupsRoot: boardRoot([readyPr()]), claimsRoot: tmp('assign-claims-') };
  mockDispatch.mockResolvedValue({ id: 'x', ok: true, data: { series_id: 'assign-example-app-817-ab12' } });
});

afterEach(async () => {
  await closeDb();
  while (tmpdirs.length) fs.rmSync(tmpdirs.pop()!, { recursive: true, force: true });
});

const assign = (
  userId = OWNER,
  body: object = { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
  scopes: Partial<AuthedRequestContext['scopes']> = {},
) => assignAttentionItem(body, ctxFor(userId, scopes), env);

describe('assignAttentionItem', () => {
  it('queues real work: a one-shot task for the chosen agent in the item’s own room', async () => {
    const res = await assign();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      seriesId: 'assign-example-app-817-ab12',
      channel: '#example-room',
      agent: 'ava',
      etaSeconds: 120,
    });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [frame, callerCtx] = mockDispatch.mock.calls[0]!;
    expect(frame.command).toBe('tasks-create');
    expect(callerCtx).toEqual({ caller: 'host' });
    expect(frame.args.group).toBe('ag-wired');
    // The room the ITEM's source declared, resolved through the wiring — not a
    // channel name off the request.
    expect(frame.args.messaging_group).toBe('mg-room');
    expect(frame.args.recurrence).toBeUndefined(); // one-shot, never a series
    // Due now: the sweep admits it on its next tick rather than at some future
    // date nobody chose.
    expect(Date.parse(frame.args.process_after as string)).toBeLessThanOrEqual(Date.now());
  });

  it('composes the prompt from the board, never from the request body', async () => {
    await assign(OWNER, {
      itemId: `board:${ITEM_ID}`,
      agentGroupId: 'ag-wired',
      prompt: 'rm -rf /',
      title: 'attacker title',
    } as object);
    const prompt = mockDispatch.mock.calls[0]![0].args.prompt as string;
    expect(prompt).not.toContain('rm -rf /');
    expect(prompt).not.toContain('attacker title');
    expect(prompt).toContain(ITEM_ID);
    expect(prompt).toContain("What's new digest");
    expect(prompt).toContain('@releasebot ship 817');
    expect(prompt).toContain('Olive Owner');
  });

  it('records the assignment, so the row can stop reading as ownerless', async () => {
    await assign();
    // The NATURAL id — the `board:` stamp is a rendering concern (migration 058).
    expect(await readItemAssignment(WG, ITEM_ID)).toMatchObject({
      agentGroupId: 'ag-wired',
      assignedBy: OWNER,
    });
    expect(await readItemAssignment(WG, `board:${ITEM_ID}`)).toBeNull();
  });

  it('accepts the natural id as well as the stamped one — same item, same row', async () => {
    const res = await assign(OWNER, { itemId: ITEM_ID, agentGroupId: 'ag-wired' });
    expect(res.status).toBe(200);
    expect(await readItemAssignment(WG, ITEM_ID)).not.toBeNull();
  });

  // ── The refusals ──────────────────────────────────────────────────────────

  it('refuses an agent that is not wired to the item’s channel — visibly, so the operator can pick another', async () => {
    const res = await assign(OWNER, { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-elsewhere' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'agent_not_wired_to_channel', channel: CHANNEL_KEY });
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(await readItemAssignment(WG, ITEM_ID)).toBeNull();
  });

  it('404s an out-of-scope agent group, and the body reveals nothing about it', async () => {
    // Scoped to a DIFFERENT group: `ag-wired` exists, is wired, and is a
    // perfectly good target — this caller simply may not see it.
    const res = await assign(
      ADMIN,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-elsewhere'],
      },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    // §2a: identical to what a nonexistent id returns. No channel, no agent
    // name, no "forbidden" — nothing an oracle could read.
    expect(body).toEqual({ error: 'not_found' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('an unknown agent group and an out-of-scope one are indistinguishable', async () => {
    const unknown = await assign(
      ADMIN,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-nope' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-elsewhere'],
      },
    );
    const outOfScope = await assign(
      ADMIN,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-elsewhere'],
      },
    );
    expect(unknown.status).toBe(outOfScope.status);
    expect(await unknown.json()).toEqual(await outOfScope.json());
  });

  it('404s an item that is not on the ownerless feed, even though it is on the board', async () => {
    // `nextMover: 'agent'` — a real board row, deliberately NOT an ownerless
    // item. Reading the raw board instead of the attention producer would have
    // made this assignable.
    env.groupsRoot = boardRoot([readyPr({ nextMover: 'agent' })]);
    clearAttentionMemo();
    const res = await assign();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('404s an item whose workgroup the caller cannot see, identically to an unknown item', async () => {
    // A SECOND workgroup declaring its own board, with the same agent wired to
    // the same room. Everything about the target agent is fine; the only thing
    // wrong is that the item lives in a workgroup this caller holds nothing in.
    const wg2Root = tmp('assign-board2-');
    const dir = path.join(wg2Root, 'wg-other-example', 'releases');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'release-state.json'),
      JSON.stringify({ asOf: '2026-08-20T11:30:00.000Z', items: [readyPr({ id: 'OTHER-APP#42' })] }),
    );
    getRawDb()
      .prepare(`INSERT INTO workgroups (id, attention_sources, created_at) VALUES (?, ?, ?)`)
      .run(
        'wg-other-example',
        `[{"kind":"release-board","root":"releases","channel_key":"${CHANNEL_KEY}"}]`,
        '2026-08-01T00:00:00.000Z',
      );
    clearAttentionMemo();
    env.groupsRoot = wg2Root;

    const scopes = { no_filter: false, allowed_group_ids: ['ag-wired'] };
    const outOfScope = await assign(ADMIN, { itemId: 'board:OTHER-APP#42', agentGroupId: 'ag-wired' }, scopes);
    const nonexistent = await assign(ADMIN, { itemId: 'board:NOPE#1', agentGroupId: 'ag-wired' }, scopes);

    expect(outOfScope.status).toBe(404);
    expect(await outOfScope.json()).toEqual(await nonexistent.json());
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a workgroup narrowing that names somewhere else resolves to absent, never a 403', async () => {
    const res = await assign(OWNER, {
      itemId: `board:${ITEM_ID}`,
      agentGroupId: 'ag-wired',
      workgroupId: 'wg-somewhere-else',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a member of the target group is refused, and told nothing more than absence', async () => {
    const res = await assign(
      MEMBER,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-wired'],
      },
    );
    expect(res.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a stranger with the scope but no privilege is refused', async () => {
    const res = await assign(
      STRANGER,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-wired'],
      },
    );
    expect(res.status).toBe(404);
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('an admin of the target group may assign', async () => {
    const res = await assign(
      ADMIN,
      { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-wired' },
      {
        no_filter: false,
        allowed_group_ids: ['ag-wired'],
      },
    );
    expect(res.status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('rejects a request missing either id', async () => {
    expect((await assign(OWNER, { agentGroupId: 'ag-wired' })).status).toBe(400);
    expect((await assign(OWNER, { itemId: `board:${ITEM_ID}` })).status).toBe(400);
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it('a double submit queues the work ONCE', async () => {
    const first = await assign();
    const second = await assign();
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already_assigned' });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('two simultaneous presses still queue once — the reservation precedes the dispatch', async () => {
    const [a, b] = await Promise.all([assign(), assign()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('a second agent cannot be handed the same item while the first assignment is fresh', async () => {
    getRawDb()
      .prepare(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, created_at)
         VALUES ('w3', 'mg-room', 'ag-elsewhere', 'per-thread', '2026-08-01T00:00:00.000Z')`,
      )
      .run();
    expect((await assign()).status).toBe(200);
    const second = await assign(OWNER, { itemId: `board:${ITEM_ID}`, agentGroupId: 'ag-elsewhere' });
    expect(second.status).toBe(409);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('an assignment older than the window releases the item — an agent that never took it must not strand it', async () => {
    await assign();
    getRawDb()
      .prepare(`UPDATE observatory_item_assignments SET assigned_at = ? WHERE item_id = ?`)
      .run(new Date(Date.now() - ASSIGN_DEDUPE_MS - 1000).toISOString(), ITEM_ID);
    expect((await assign()).status).toBe(200);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
  });

  it('a failed dispatch releases the reservation, so the operator can try again', async () => {
    mockDispatch.mockResolvedValueOnce({ id: 'x', ok: false, error: 'boom' } as never);
    const failed = await assign();
    expect(failed.status).toBe(502);
    expect(await readItemAssignment(WG, ITEM_ID)).toBeNull();
    expect((await assign()).status).toBe(200);
  });
});
