import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initTestDb, getRawDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import { observatoryIssueBriefHandler, _resetIssueBriefCacheForTesting } from './issue-brief.js';
import type { AuthedRequestContext } from './router.js';

import { readReleaseState as _rrsRaw } from './api/observatory.js';

const mockReadReleaseState = vi.mocked(_rrsRaw);

// Only the board read is stubbed; the URL parse, token resolution, GitHub
// shaping and cache all run for real against a stubbed global fetch.
vi.mock('./api/observatory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/observatory.js')>()),
  readReleaseState: vi.fn(),
}));

const ctx: AuthedRequestContext = {
  rawNodeReq: {} as never,
  user: { id: 'u1', kind: 'email', display_name: 'u1', created_at: '' },
  scopes: { role: 'owner', allowed_group_ids: [], no_filter: true },
};

const get = (qs: string): Request => new Request(`http://localhost/dashboard/api/observatory/issue-brief?${qs}`);

const boardItem = (url?: string) => ({
  asOf: '2026-08-18T00:00:00.000Z',
  items: [{ id: 'XZO#1', kind: 'finding' as const, title: 't', nextMover: 'human' as const, ...(url ? { url } : {}) }],
});

function ghResponses(issue: unknown, comments: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((u: string) => {
      const body = String(u).includes('/comments') ? comments : issue;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }),
  );
}

describe('observatoryIssueBriefHandler', () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getRawDb();
    runMigrations(db);
    getRawDb()
      .prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-1', 'Example', ?)`)
      .run(new Date().toISOString());
    await createAgentGroup({
      id: 'ag-1',
      name: 'example',
      folder: 'example-co',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = 'wg-1' WHERE id = 'ag-1'`).run();
    vi.stubEnv('GITHUB_TOKEN_EXAMPLE_CO', 'tok-scoped');
    _resetIssueBriefCacheForTesting();
  });
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('serves body, labels and the LAST comments from the item recorded URL', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem('https://github.com/example-org/example-repo/issues/803'));
    ghResponses(
      { state: 'open', body: 'the body QA wrote', labels: [{ name: 'needs-product-decision' }, 'p2'], comments: 5 },
      [
        { user: { login: 'old' }, created_at: '2026-08-10T00:00:00Z', body: 'ancient' },
        { user: { login: 'a' }, created_at: '2026-08-15T00:00:00Z', body: 'c1' },
        { user: { login: 'b' }, created_at: '2026-08-16T00:00:00Z', body: 'c2' },
        { user: { login: 'desk' }, created_at: '2026-08-17T00:00:00Z', body: 'proposed default: X, do-by Fri' },
      ],
    );
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(resp!.status).toBe(200);
    const brief = (await resp!.json()) as {
      labels: string[];
      body: string;
      comments: { author: string; body: string }[];
      commentCount: number;
    };
    expect(brief.body).toBe('the body QA wrote');
    expect(brief.labels).toEqual(['needs-product-decision', 'p2']);
    // Last three, oldest dropped — the newest comment is where a proposal lives.
    expect(brief.comments.map((c) => c.author)).toEqual(['a', 'b', 'desk']);
    expect(brief.commentCount).toBe(5);
    // The fetch used the workgroup-scoped token, not the bare fallback.
    const calls = vi.mocked(fetch).mock.calls;
    expect((calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-scoped' });
    expect(String(calls[0]![0])).toBe('https://api.github.com/repos/example-org/example-repo/issues/803');
  });

  it('refuses a recorded URL that is not a github issue/PR — the client cannot pick the host', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem('https://evil.example.com/github.com/x/y/issues/1'));
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(resp!.status).toBe(404);
    expect(((await resp!.json()) as { error: string }).error).toBe('item_url_not_github');
  });

  it('404s an item with no url, and an item not on the board', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem());
    expect((await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx))!.status).toBe(404);
    expect((await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%232'), {}, ctx))!.status).toBe(404);
  });

  it('a GitHub failure is a 502, never a crash — and is not cached', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem('https://github.com/o/r/issues/1'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const r1 = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(r1!.status).toBe(502);
    // Recovers on the next call once GitHub does.
    ghResponses({ state: 'open', body: 'ok now', labels: [], comments: 0 }, []);
    const r2 = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(r2!.status).toBe(200);
  });

  it('second read inside the TTL is served from cache — one GitHub round-trip per item', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem('https://github.com/o/r/pull/9'));
    ghResponses({ state: 'open', body: 'b', labels: [], comments: 0 }, []);
    await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    const callsAfterFirst = vi.mocked(fetch).mock.calls.length;
    await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(vi.mocked(fetch).mock.calls.length).toBe(callsAfterFirst);
  });

  it('long bodies are truncated server-side and say so', async () => {
    mockReadReleaseState.mockResolvedValue(boardItem('https://github.com/o/r/issues/2'));
    ghResponses({ state: 'open', body: 'x'.repeat(5000), labels: [], comments: 0 }, []);
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    const brief = (await resp!.json()) as { body: string; bodyTruncated: boolean };
    expect(brief.body.length).toBe(2000);
    expect(brief.bodyTruncated).toBe(true);
  });
});

// Workgroups are the data-pool boundary. The `workgroup` query value is
// caller-chosen, so the handler must refuse one the caller cannot see — with
// the same 404 an unknown workgroup gets — before it reads that workgroup's
// board, serves its cache, or resolves its scoped GitHub token.
describe('observatoryIssueBriefHandler — workgroup scope', () => {
  const scoped = (role: 'member' | 'admin_of_group', groupIds: string[]): AuthedRequestContext => ({
    ...ctx,
    scopes: { role, allowed_group_ids: groupIds, no_filter: false },
  });
  const globalAdmin: AuthedRequestContext = {
    ...ctx,
    scopes: { role: 'global_admin', allowed_group_ids: [], no_filter: true },
  };
  const ISSUE = { state: 'open', body: 'private body of workgroup one', labels: [], comments: 0 };

  beforeEach(async () => {
    await initTestDb();
    runMigrations(getRawDb());
    const at = new Date().toISOString();
    const ins = getRawDb().prepare(`INSERT INTO workgroups (id, display_name, created_at) VALUES (?, ?, ?)`);
    ins.run('wg-1', 'One', at);
    ins.run('wg-2', 'Two', at);
    for (const [id, folder, wg] of [
      ['ag-1', 'example-co', 'wg-1'],
      ['ag-2', 'other-co', 'wg-2'],
    ] as const) {
      await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: at });
      getRawDb().prepare(`UPDATE agent_groups SET workgroup_id = ? WHERE id = ?`).run(wg, id);
    }
    vi.stubEnv('GITHUB_TOKEN_EXAMPLE_CO', 'tok-wg-1');
    vi.stubEnv('GITHUB_TOKEN_OTHER_CO', 'tok-wg-2');
    _resetIssueBriefCacheForTesting();
    // Only wg-1 has a board; any other id reads as no board at all.
    mockReadReleaseState.mockImplementation(async (wg: string) =>
      wg === 'wg-1' ? boardItem('https://github.com/example-org/example-repo/issues/803') : null,
    );
    ghResponses(ISSUE, []);
  });
  afterEach(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    ['member', scoped('member', ['ag-2'])],
    ['admin_of_group', scoped('admin_of_group', ['ag-2'])],
  ])(
    'a %s scoped to workgroup 2 asking for workgroup 1 gets 404, and neither the board read nor the GitHub fetch happens',
    async (_role, caller) => {
      const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, caller);
      expect(resp!.status).toBe(404);
      expect(await resp!.json()).toEqual({ error: 'not_found' });
      expect(mockReadReleaseState).not.toHaveBeenCalled();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it('the refusal is indistinguishable from an unknown workgroup — existence does not leak', async () => {
    const caller = scoped('member', ['ag-2']);
    const denied = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, caller);
    const unknown = await observatoryIssueBriefHandler(get('workgroup=wg-nope&item=XZO%231'), {}, caller);
    expect(denied!.status).toBe(404);
    expect(unknown!.status).toBe(404);
    expect(await denied!.json()).toEqual(await unknown!.json());
    expect(mockReadReleaseState).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('a scoped caller with no groups at all gets 404 without a board read', async () => {
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, scoped('member', []));
    expect(resp!.status).toBe(404);
    expect(mockReadReleaseState).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('a brief an owner already cached is not served to a caller outside the workgroup', async () => {
    const warm = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, ctx);
    expect(warm!.status).toBe(200);
    const fetchesAfterWarm = vi.mocked(fetch).mock.calls.length;
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, scoped('member', ['ag-2']));
    expect(resp!.status).toBe(404);
    expect(JSON.stringify(await resp!.json())).not.toContain('private body');
    expect(vi.mocked(fetch).mock.calls.length).toBe(fetchesAfterWarm);
  });

  it.each([
    ['member of workgroup 1', scoped('member', ['ag-1'])],
    ['admin_of_group in workgroup 1', scoped('admin_of_group', ['ag-1'])],
    ['member of both workgroups', scoped('member', ['ag-1', 'ag-2'])],
    ['owner', ctx],
    ['global admin', globalAdmin],
  ])('a %s gets 200, fetched with workgroup 1’s own token', async (_who, caller) => {
    const resp = await observatoryIssueBriefHandler(get('workgroup=wg-1&item=XZO%231'), {}, caller);
    expect(resp!.status).toBe(200);
    expect(((await resp!.json()) as { body: string }).body).toBe('private body of workgroup one');
    expect(mockReadReleaseState).toHaveBeenCalledWith('wg-1');
    const calls = vi.mocked(fetch).mock.calls;
    expect((calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-wg-1' });
  });

  it('an unknown workgroup is a 404 for a scoped caller and for an owner', async () => {
    const scopedResp = await observatoryIssueBriefHandler(
      get('workgroup=wg-nope&item=XZO%231'),
      {},
      scoped('member', ['ag-1']),
    );
    expect(scopedResp!.status).toBe(404);
    // An owner passes the scope check on its first line (no_filter,
    // api/observatory.ts hasWorkgroupAccess), so the 404 is the board's: an
    // unknown workgroup has no board, hence no item.
    const ownerResp = await observatoryIssueBriefHandler(get('workgroup=wg-nope&item=XZO%231'), {}, ctx);
    expect(ownerResp!.status).toBe(404);
    expect(await ownerResp!.json()).toEqual({ error: 'item_not_on_board' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
