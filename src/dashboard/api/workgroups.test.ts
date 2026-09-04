/**
 * Tests for the workgroup dashboard read endpoints (fleet-hardening Phase 3):
 *   GET /dashboard/api/workgroups
 *   GET /dashboard/api/workgroup/:id/summary
 *   GET /dashboard/api/workgroup/:id/usage
 *   GET /dashboard/api/workgroup/:id/claims
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

// Config is mocked to a test-only root because workgroups.ts reads
// GROUPS_DIR/releases/*.md and DATA_DIR/workgroups/*/claims/*.json directly.
// The literal path is inlined (not a referenced const) because vi.mock
// factories are hoisted above top-level variable declarations.
vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('workgroups-api-test') }));

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { ensureSchema } from '../../modules/mailbox/schema.js';
import { invalidateScheduledCache } from './scheduled-shared.js';
import { _resetAssemblyInFlightForTesting } from './scheduled-assembly.js';
import {
  workgroupsListHandler,
  workgroupSummaryHandler,
  workgroupUsageHandler,
  workgroupClaimsHandler,
} from './workgroups.js';
import type { AuthedRequestContext } from '../router.js';

function now(): string {
  return new Date().toISOString();
}

function makeCtx(opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {}): AuthedRequestContext {
  return {
    user: { id: 'u1', kind: 'dashboard', display_name: 'u1', created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'member',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

function makeReq(url: string): Request {
  return new Request(url);
}

function setupDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, workgroup_id TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE workgroups (
      id TEXT PRIMARY KEY, display_name TEXT, onecli_secrets TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT, created_at TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    );
    -- Health derivation resolves the owning group's timezone override.
    CREATE TABLE container_configs (agent_group_id TEXT PRIMARY KEY, timezone TEXT, updated_at TEXT);
    CREATE TABLE usage_daily (
      date TEXT NOT NULL, agent_group_id TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '', turns INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (date, agent_group_id, provider, model)
    );
  `);
}

function addWorkgroup(id: string, displayName: string | null = null): void {
  getDb()
    .prepare("INSERT INTO workgroups (id, display_name, created_at) VALUES (?, ?, datetime('now'))")
    .run(id, displayName);
}

function addGroup(id: string, workgroupId: string, name = id): void {
  getDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, 'claude', ?, datetime('now'))",
    )
    .run(id, name, id, workgroupId);
}

function addSession(id: string, agentGroupId: string): void {
  getDb()
    .prepare("INSERT INTO sessions (id, agent_group_id, status, created_at) VALUES (?, ?, 'active', datetime('now'))")
    .run(id, agentGroupId);
}

function addUsage(
  row: Partial<{
    date: string;
    agent_group_id: string;
    provider: string;
    model: string;
    turns: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
  }> & { date: string; agent_group_id: string },
): void {
  getDb()
    .prepare(
      `INSERT INTO usage_daily (date, agent_group_id, provider, model, turns, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (@date, @agent_group_id, @provider, @model, @turns, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cost_usd)`,
    )
    .run({
      provider: 'claude',
      model: 'sonnet',
      turns: 1,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0.01,
      ...row,
    });
}

function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
}

function seedSessionDb(agentGroupId: string, sessionId: string): string {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const inbound = path.join(dir, 'inbound.db');
  ensureSchema(inbound, 'inbound');
  return inbound;
}

function insertTaskRow(
  inboundPath: string,
  row: { id: string; series_id?: string; content?: string; recurrence?: string | null; process_after?: string },
): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content)
     VALUES (@id, @seq, 'task', @timestamp, 'pending', @processAfter, @recurrence, @seriesId, @content)`,
  ).run({
    id: row.id,
    seq,
    timestamp: now(),
    processAfter: row.process_after ?? new Date(Date.now() + 3600_000).toISOString(),
    recurrence: row.recurrence ?? '0 9 * * *',
    seriesId: row.series_id ?? row.id,
    content: row.content ?? JSON.stringify({ prompt: 'do a thing' }),
  });
  db.close();
}

function claimsDir(workgroupId: string): string {
  return path.join(TEST_DIR, 'workgroups', workgroupId, 'claims');
}

function writeClaim(workgroupId: string, slug: string, claim: Record<string, unknown>): void {
  const dir = claimsDir(workgroupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(claim));
}

function releasesDir(workgroupId: string): string {
  return path.join(TEST_DIR, 'groups', workgroupId, 'releases');
}

beforeEach(() => {
  setupDb();
  invalidateScheduledCache();
  _resetAssemblyInFlightForTesting();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('workgroupsListHandler', () => {
  beforeEach(() => {
    addWorkgroup('wg-1', 'Workgroup One');
    addWorkgroup('wg-2', null);
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-2');
  });

  it('owner with no_filter sees every workgroup', async () => {
    const res = (await workgroupsListHandler(
      makeReq('http://localhost/dashboard/api/workgroups'),
      {},
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { workgroups: { id: string; name: string }[] };
    expect(body.workgroups).toEqual([
      { id: 'wg-1', name: 'Workgroup One' },
      { id: 'wg-2', name: 'wg-2' }, // display_name null → falls back to id
    ]);
  });

  it('scoped caller sees only workgroups reachable via an allowed agent group', async () => {
    const res = (await workgroupsListHandler(
      makeReq('http://localhost/dashboard/api/workgroups'),
      {},
      makeCtx({ allowed_group_ids: ['ag-1'] }),
    ))!;
    const body = (await res.json()) as { workgroups: { id: string }[] };
    expect(body.workgroups.map((w) => w.id)).toEqual(['wg-1']);
  });

  /**
   * This endpoint is the console's PRIMARY selector, so its scope rule is now
   * load-bearing for the whole surface: a workgroup the caller is allowed no
   * sibling in must not be offered at all, and one they are allowed SOME
   * siblings in must be offered exactly once (not once per sibling).
   */
  it('offers a partially-permitted workgroup once, and omits one with no permitted sibling', async () => {
    addGroup('ag-1b', 'wg-1');
    addGroup('ag-1c', 'wg-1');
    addGroup('ag-2b', 'wg-2');

    const res = (await workgroupsListHandler(
      makeReq('http://localhost/dashboard/api/workgroups'),
      {},
      makeCtx({ allowed_group_ids: ['ag-1b'] }),
    ))!;
    const body = (await res.json()) as { workgroups: { id: string }[] };
    expect(body.workgroups.map((w) => w.id)).toEqual(['wg-1']);
  });

  it('caller with no allowed groups gets an empty list (no leak)', async () => {
    const res = (await workgroupsListHandler(
      makeReq('http://localhost/dashboard/api/workgroups'),
      {},
      makeCtx({ allowed_group_ids: [] }),
    ))!;
    const body = (await res.json()) as { workgroups: unknown[] };
    expect(body.workgroups).toEqual([]);
  });
});

describe('workgroupSummaryHandler', () => {
  beforeEach(() => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
  });

  it('returns 404 for a nonexistent workgroup', async () => {
    const res = (await workgroupSummaryHandler(
      makeReq('http://localhost/dashboard/api/workgroup/nope/summary'),
      { id: 'nope' },
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(404);
  });

  it('returns 404 for an out-of-scope workgroup (disclose-as-not-found)', async () => {
    addWorkgroup('wg-2');
    addGroup('ag-2', 'wg-2');
    const res = (await workgroupSummaryHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-2/summary'),
      { id: 'wg-2' },
      makeCtx({ allowed_group_ids: ['ag-1'] }),
    ))!;
    expect(res.status).toBe(404);
  });

  it('missing board.md and gates dir → {board: null, gates: []}, never a 500', async () => {
    const res = (await workgroupSummaryHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/summary'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { board: string | null; gates: unknown[] };
    expect(body.board).toBeNull();
    expect(body.gates).toEqual([]);
  });

  it('reads board.md raw and the newest gates file tail', async () => {
    const dir = releasesDir('wg-1');
    fs.mkdirSync(path.join(dir, 'gates'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'board.md'), '# Release Board\n\nsome content');
    fs.writeFileSync(
      path.join(dir, 'gates', '2026-08-04.jsonl'),
      `${JSON.stringify({ ts: '2026-08-04T00:00:00Z', action: 'old' })}\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'gates', '2026-08-05.jsonl'),
      `${JSON.stringify({ ts: '2026-08-05T00:00:00Z', action: 'newest-1' })}\n${JSON.stringify({ ts: '2026-08-05T01:00:00Z', action: 'newest-2' })}\n`,
    );

    const res = (await workgroupSummaryHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/summary'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { board: string; gates: { action: string }[] };
    expect(body.board).toContain('# Release Board');
    // Only the newest (2026-08-05) file's lines, never the older 2026-08-04 file.
    expect(body.gates.map((g) => g.action)).toEqual(['newest-1', 'newest-2']);
  });
});

describe('workgroupUsageHandler', () => {
  beforeEach(() => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
    addGroup('ag-2', 'wg-1');
  });

  it('returns 404 for an out-of-scope workgroup', async () => {
    const res = (await workgroupUsageHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/usage'),
      { id: 'wg-1' },
      makeCtx({ allowed_group_ids: [] }),
    ))!;
    expect(res.status).toBe(404);
  });

  it('no usage rows yet → {usage: []}', async () => {
    const res = (await workgroupUsageHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/usage'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { usage: unknown[] };
    expect(body.usage).toEqual([]);
  });

  it('aggregates rows across every agent group in the workgroup, date desc', async () => {
    const today = new Date().toISOString().slice(0, 10);
    addUsage({ date: today, agent_group_id: 'ag-1', turns: 3 });
    addUsage({ date: today, agent_group_id: 'ag-2', turns: 5 });
    // Outside the default 14-day window (60 days ago) — excluded.
    addUsage({ date: '2020-01-01', agent_group_id: 'ag-1', turns: 99 });
    // Different workgroup entirely — never leaks in.
    addWorkgroup('wg-other');
    addGroup('ag-other', 'wg-other');
    addUsage({ date: today, agent_group_id: 'ag-other', turns: 42 });

    const res = (await workgroupUsageHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/usage'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    const body = (await res.json()) as { usage: { agent_group_id: string; turns: number }[] };
    expect(body.usage.map((r) => r.agent_group_id).sort()).toEqual(['ag-1', 'ag-2']);
    expect(body.usage.every((r) => r.turns !== 99 && r.turns !== 42)).toBe(true);
  });
});

describe('workgroupClaimsHandler', () => {
  beforeEach(() => {
    addWorkgroup('wg-1');
    addGroup('ag-1', 'wg-1');
  });

  it('returns 404 for an out-of-scope workgroup', async () => {
    const res = (await workgroupClaimsHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/claims'),
      { id: 'wg-1' },
      makeCtx({ allowed_group_ids: [] }),
    ))!;
    expect(res.status).toBe(404);
  });

  it('missing claims dir → {claims: []}, never a 500', async () => {
    const res = (await workgroupClaimsHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/claims'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: unknown[]; series: unknown[] };
    expect(body.claims).toEqual([]);
    expect(body.series).toEqual([]);
  });

  it('computes stale/escalated flags by reusing the escalation module functions', async () => {
    const oldIso = new Date(Date.now() - 10 * 3600_000).toISOString(); // 10h ago
    writeClaim('wg-1', 'stale-unescalated', { owner: 'ava', claimed_at: oldIso, ttl_hours: 1 }); // stale, never escalated
    writeClaim('wg-1', 'stale-escalated', {
      owner: 'bo',
      claimed_at: oldIso,
      ttl_hours: 1,
      escalated_at: new Date(Date.now() - 1000).toISOString(), // escalated after claiming, still current
    });
    writeClaim('wg-1', 'fresh', { owner: 'cy', claimed_at: new Date().toISOString(), ttl_hours: 4 }); // not stale

    const res = (await workgroupClaimsHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/claims'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    const body = (await res.json()) as {
      claims: { slug: string; stale: boolean; escalated: boolean }[];
    };
    const bySlug = Object.fromEntries(body.claims.map((c) => [c.slug, c]));
    expect(bySlug['stale-unescalated']).toMatchObject({ stale: true, escalated: false });
    expect(bySlug['stale-escalated']).toMatchObject({ stale: true, escalated: true });
    expect(bySlug['fresh']).toMatchObject({ stale: false, escalated: false });
  });

  it('projects script_host from content.scriptHost for the workgroup task-series summary', async () => {
    addSession('sess-1', 'ag-1');
    const inbound = seedSessionDb('ag-1', 'sess-1');
    insertTaskRow(inbound, {
      id: 'row-hosted',
      series_id: 'series-hosted',
      content: JSON.stringify({ prompt: 'hosted', script: 'echo hi', scriptHost: true }),
    });
    insertTaskRow(inbound, {
      id: 'row-plain',
      series_id: 'series-plain',
      content: JSON.stringify({ prompt: 'plain' }),
    });

    const res = (await workgroupClaimsHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/claims'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    const body = (await res.json()) as { series: { series_id: string; script_host: boolean }[] };
    const bySeries = Object.fromEntries(body.series.map((s) => [s.series_id, s.script_host]));
    expect(bySeries['series-hosted']).toBe(true);
    expect(bySeries['series-plain']).toBe(false);
  });

  it('a live task series from a DIFFERENT workgroup never leaks into the series summary', async () => {
    addWorkgroup('wg-2');
    addGroup('ag-2', 'wg-2');
    addSession('sess-2', 'ag-2');
    const inbound = seedSessionDb('ag-2', 'sess-2');
    insertTaskRow(inbound, { id: 'row-other', series_id: 'series-other' });

    const res = (await workgroupClaimsHandler(
      makeReq('http://localhost/dashboard/api/workgroup/wg-1/claims'),
      { id: 'wg-1' },
      makeCtx({ no_filter: true }),
    ))!;
    const body = (await res.json()) as { series: { series_id: string }[] };
    expect(body.series.map((s) => s.series_id)).not.toContain('series-other');
  });
});
