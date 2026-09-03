/**
 * Tests for the Scheduled Tasks Board read assembly + health derivation
 * (Tasks B1 + B2).
 *
 * TDD: written before the implementation. Builds on-disk session fixtures
 * (inbound.db / outbound.db) under a temp data dir, plus an in-memory central
 * DB, and drives assembleSnapshot / deriveHealth directly.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import Database from 'better-sqlite3';

import { initTestDb, closeDb, getDb } from '../../db/connection.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { ensureSchema } from '../../modules/mailbox/schema.js';
import { invalidateScheduledCache, getScheduledCache, SWEEP_INTERVAL_MS } from './scheduled-shared.js';
import {
  assembleSnapshot,
  deriveHealth,
  _resetAssemblyInFlightForTesting,
  type HealthCtx,
  type ScheduledAssemblyOptions,
} from './scheduled-assembly.js';

// Unique per-file temp dir (mkdtemp) — never a fixed /tmp path a sibling file or
// a parallel agent process could rm out from under these fixtures mid-test.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sched-assembly-'));
const NOW = Date.parse('2026-06-13T12:00:00Z');

function isoIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function setupCentralDb(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, created_at TEXT NOT NULL, UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
      thread_id TEXT, status TEXT DEFAULT 'active', created_at TEXT NOT NULL
    );
  `);
}

function addGroup(id: string, name: string, folder: string, provider: string | null = null): void {
  getDb()
    .prepare(
      "INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, name, folder, provider);
}

function addMg(id: string, channelType: string, platformId: string, name: string): void {
  getDb()
    .prepare(
      "INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
    )
    .run(id, channelType, platformId, name);
}

function addSession(
  id: string,
  agentGroupId: string,
  messagingGroupId: string | null,
  threadId: string | null = null,
): void {
  getDb()
    .prepare(
      "INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, ?, ?, 'active', datetime('now'))",
    )
    .run(id, agentGroupId, messagingGroupId, threadId);
}

function sessionDir(agentGroupId: string, sessionId: string): string {
  return path.join(TEST_DIR, 'v2-sessions', agentGroupId, sessionId);
}

function seedSessionDbs(agentGroupId: string, sessionId: string): { inbound: string; outbound: string } {
  const dir = sessionDir(agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const inbound = path.join(dir, 'inbound.db');
  const outbound = path.join(dir, 'outbound.db');
  ensureSchema(inbound, 'inbound');
  ensureSchema(outbound, 'outbound');
  return { inbound, outbound };
}

interface SeedRow {
  id: string;
  series_id?: string;
  status?: string;
  recurrence?: string | null;
  process_after?: string | null;
  timestamp?: string;
  content?: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  kind?: string;
}

function insertInboundRow(inboundPath: string, row: SeedRow): void {
  const db = openInboundDb(inboundPath);
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM messages_in').get() as { m: number }).m + 2;
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, content, platform_id, channel_type, thread_id)
     VALUES (@id, @seq, @kind, @timestamp, @status, @processAfter, @recurrence, @seriesId, @content, @platformId, @channelType, @threadId)`,
  ).run({
    id: row.id,
    seq,
    kind: row.kind ?? 'task',
    timestamp: row.timestamp ?? isoIn(-3600_000),
    status: row.status ?? 'pending',
    processAfter: row.process_after ?? null,
    recurrence: row.recurrence ?? '0 9 * * *',
    seriesId: row.series_id ?? row.id,
    content: row.content ?? JSON.stringify({ prompt: 'do thing' }),
    platformId: row.platform_id ?? null,
    channelType: row.channel_type ?? null,
    threadId: row.thread_id ?? null,
  });
  db.close();
}

function setProcessingAck(outboundPath: string, messageId: string): void {
  const db = new Database(outboundPath);
  db.pragma('journal_mode = DELETE');
  db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', datetime('now'))",
  ).run(messageId);
  db.close();
}

const ALL_SCOPES = { role: 'owner' as const, allowed_group_ids: [], no_filter: true };

function opts(): ScheduledAssemblyOptions {
  return { dataDir: TEST_DIR, nowMs: NOW };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  setupCentralDb();
  invalidateScheduledCache();
  // Drop any single-flight promise a sibling test file left behind — vitest can
  // schedule files into the same worker, and a leaked in-flight assembly would
  // make assembleSnapshot return another file's snapshot (cross-file flake).
  _resetAssemblyInFlightForTesting();
});

afterEach(() => {
  // Reset shared singletons on the way out too — leave nothing for the next
  // file to inherit (hermetic regardless of order).
  invalidateScheduledCache();
  _resetAssemblyInFlightForTesting();
  closeDb();
  vi.restoreAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

// ── B1: assembly ──────────────────────────────────────────────────────────────
describe('assembleSnapshot — chunking + cache + partial', () => {
  it('test_assembly_yields_between_sessions', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    for (const s of ['sess-1', 'sess-2', 'sess-3']) {
      addSession(s, 'ag-1', 'mg-1');
      const { inbound } = seedSessionDbs('ag-1', s);
      insertInboundRow(inbound, { id: `${s}-row`, process_after: isoIn(3600_000) });
    }

    const spy = vi.spyOn(global, 'setImmediate');
    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    // At least one yield per session — assembly never runs as one block (§4.9).
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(snap.rows.length).toBe(3);
  });

  it('test_gen_mismatch_skips_cache_populate', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, { id: 'r1', process_after: isoIn(3600_000) });

    // Invalidate AFTER the assembly captured its start-gen but BEFORE it
    // resolves: hook the yield to fire the mutation mid-flight.
    const realSetImmediate = global.setImmediate;
    let bumped = false;
    vi.spyOn(global, 'setImmediate').mockImplementation(((cb: () => void, ...args: unknown[]) => {
      if (!bumped) {
        bumped = true;
        invalidateScheduledCache(); // a mutation lands mid-assembly
      }
      return (realSetImmediate as unknown as (c: () => void, ...a: unknown[]) => NodeJS.Immediate)(cb, ...args);
    }) as typeof setImmediate);

    await assembleSnapshot(ALL_SCOPES, opts());
    // The assembly's start-gen is now stale → it must NOT populate the cache.
    expect(getScheduledCache().data).toBeNull();
  });

  it('test_unreadable_session_is_partial', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    // Good session.
    addSession('good', 'ag-1', 'mg-1');
    const good = seedSessionDbs('ag-1', 'good');
    insertInboundRow(good.inbound, { id: 'good-row', process_after: isoIn(3600_000) });
    // Bad session — corrupt inbound.db (not a valid sqlite file).
    addSession('bad', 'ag-1', 'mg-1');
    const badDir = sessionDir('ag-1', 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'inbound.db'), 'this is not sqlite');

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    // Good session's row present; bad session counted as unreadable; no throw.
    expect(snap.rows.some((r) => r.series_id === 'good-row')).toBe(true);
    expect(snap.counts.unreadable).toBeGreaterThanOrEqual(1);
  });

  it('populates the cache under a matching generation and uses readonly opens', async () => {
    addGroup('ag-1', 'G1', 'g1', 'claude');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, {
      id: 'r1',
      process_after: isoIn(3600_000),
      platform_id: 'd:1',
      channel_type: 'discord',
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    // Cache populated (no mutation mid-flight) with the same object.
    expect(getScheduledCache().data).toBe(snap);
    expect(getScheduledCache().expiresMs).toBeGreaterThan(NOW);
    // Row carries the joined provider + channel.
    const row = snap.rows.find((r) => r.series_id === 'r1')!;
    expect(row.provider).toBe('claude');
    expect(row.channel_name).toBe('chan-1');
    expect(row.next_fire_utc).toBeTruthy();
    expect(Array.isArray(row.available_verbs)).toBe(true);
  });

  it('single-flights concurrent callers', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, { id: 'r1', process_after: isoIn(3600_000) });

    const [a, b] = await Promise.all([assembleSnapshot(ALL_SCOPES, opts()), assembleSnapshot(ALL_SCOPES, opts())]);
    // Same in-flight assembly shared.
    expect(a).toBe(b);
  });

  it('scope-filters sessions to allowed_group_ids', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addGroup('ag-2', 'G2', 'g2');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addMg('mg-2', 'discord', 'd:2', 'chan-2');
    addSession('s1', 'ag-1', 'mg-1');
    addSession('s2', 'ag-2', 'mg-2');
    insertInboundRow(seedSessionDbs('ag-1', 's1').inbound, { id: 'r1', process_after: isoIn(3600_000) });
    insertInboundRow(seedSessionDbs('ag-2', 's2').inbound, { id: 'r2', process_after: isoIn(3600_000) });

    const snap = await assembleSnapshot(
      { role: 'admin_of_group', allowed_group_ids: ['ag-1'], no_filter: false },
      opts(),
    );
    expect(snap.rows.every((r) => r.agent_group_id === 'ag-1')).toBe(true);
    expect(snap.rows.some((r) => r.series_id === 'r2')).toBe(false);
  });

  it('returns ALL live rows for a duplicate-successor series', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    // Two live pending rows sharing one series_id (the duplicate-successor bug).
    insertInboundRow(inbound, { id: 'dup-a', series_id: 'dup', process_after: isoIn(3600_000) });
    insertInboundRow(inbound, { id: 'dup-b', series_id: 'dup', process_after: isoIn(7200_000) });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const dupRows = snap.rows.filter((r) => r.series_id === 'dup');
    // Both fireable rows surface (not just MAX(seq)) so neither stays hidden.
    expect(dupRows.length).toBe(2);
  });
});

describe('assembleSnapshot — isolated system task sessions', () => {
  it('enumerates unstamped and routing-stamped system-session rows', async () => {
    addGroup('ag-1', 'G1', 'g1', 'claude');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');

    addSession('sys-unstamped', 'ag-1', null, 'system:tasks:series-unstamped');
    insertInboundRow(seedSessionDbs('ag-1', 'sys-unstamped').inbound, {
      id: 'unstamped-row',
      series_id: 'series-unstamped',
      process_after: isoIn(3600_000),
      content: JSON.stringify({ prompt: 'compile the system-session quokka report' }),
      platform_id: null,
      channel_type: null,
      thread_id: null,
    });

    addSession('sys-stamped', 'ag-1', null, 'system:tasks:series-stamped');
    insertInboundRow(seedSessionDbs('ag-1', 'sys-stamped').inbound, {
      id: 'stamped-row',
      series_id: 'series-stamped',
      process_after: isoIn(3600_000),
      platform_id: 'd:1',
      channel_type: 'discord',
      thread_id: 'chat-thread-42',
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const unstamped = snap.rows.find((r) => r.series_id === 'series-unstamped')!;
    const stamped = snap.rows.find((r) => r.series_id === 'series-stamped')!;

    expect(unstamped).toMatchObject({
      agent_group_id: 'ag-1',
      provider: 'claude',
      channel_name: null,
      channel_type: null,
      thread_id: null,
      kind: 'recurring',
      health: 'healthy',
    });
    expect(unstamped.available_verbs).toContain('move');
    expect(snap.search_index[unstamped.key]).toContain('quokka');

    expect(stamped).toMatchObject({
      channel_name: 'chan-1',
      channel_type: 'discord',
      thread_id: 'chat-thread-42',
      kind: 'thread_loop',
      health: 'healthy',
    });
    expect(stamped.available_verbs).not.toContain('move');
  });

  it('derives overdue health for a system-session row', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addSession('sys-overdue', 'ag-1', null, 'system:tasks:series-overdue');
    insertInboundRow(seedSessionDbs('ag-1', 'sys-overdue').inbound, {
      id: 'overdue-row',
      series_id: 'series-overdue',
      recurrence: '0 9 * * *',
      process_after: isoIn(-13 * 3600_000),
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const overdue = snap.rows.find((r) => r.series_id === 'series-overdue')!;
    expect(overdue.health).toBe('stalled');
    expect(overdue.available_verbs).toContain('run_now');
  });
});

// ── B2: health derivation ──────────────────────────────────────────────────────
describe('deriveHealth', () => {
  function ctx(over: Partial<HealthCtx>): HealthCtx {
    return {
      status: 'pending',
      recurrence: '0 9 * * *',
      processAfterMs: NOW + 3600_000,
      timestampMs: NOW - 3600_000,
      ackPresent: false,
      outboundReadable: true,
      nowMs: NOW,
      isOneOff: false,
      ...over,
    };
  }

  it('paused status → paused', () => {
    expect(deriveHealth(ctx({ status: 'paused' }))).toBe('paused');
  });

  it('test_unknown_when_outbound_unreadable_and_overdue', () => {
    const h = deriveHealth(ctx({ processAfterMs: NOW - 60_000, outboundReadable: false }));
    expect(h).toBe('unknown');
  });

  it('processing claim → processing', () => {
    expect(deriveHealth(ctx({ ackPresent: true, processAfterMs: NOW - 1000 }))).toBe('processing');
  });

  it('test_late_visible_immediately', () => {
    // Overdue by 1 min, within stall grace → late (immediately visible).
    expect(deriveHealth(ctx({ processAfterMs: NOW - 60_000 }))).toBe('late');
  });

  it('test_stall_grace_capped_24h', () => {
    // Weekly cron overdue by 48h → stalled, NOT healthy (24h absolute cap).
    expect(deriveHealth(ctx({ recurrence: '0 9 * * 1', processAfterMs: NOW - 48 * 3600_000 }))).toBe('stalled');
  });

  it('stalled when overdue beyond cadence-scaled grace', () => {
    // Daily cron (interval 24h → grace = min(max(12h, 2sweeps), 24h) = 12h);
    // overdue 13h → stalled.
    expect(deriveHealth(ctx({ recurrence: '0 9 * * *', processAfterMs: NOW - 13 * 3600_000 }))).toBe('stalled');
  });

  it('test_healthy_within_grace', () => {
    expect(deriveHealth(ctx({ processAfterMs: NOW + 3600_000 }))).toBe('healthy');
  });

  it('one-off uses 2-sweep overdue interval for stall grace', () => {
    // A one-off overdue beyond 2 sweeps but the grace is min(max(2sweeps,2sweeps),24h)=2min;
    // overdue 10 min → stalled.
    expect(deriveHealth(ctx({ isOneOff: true, recurrence: null, processAfterMs: NOW - 10 * 60_000 }))).toBe('stalled');
  });

  it('SWEEP_INTERVAL_MS feeds the grace floor', () => {
    // Sanity: the imported constant is the one used in the grace formula.
    expect(SWEEP_INTERVAL_MS).toBe(60_000);
  });
});

// ── B2: strand + duplicate detectors (exercised via assembleSnapshot) ──────────
describe('residual-strand + duplicate detection', () => {
  it('test_strand_detected', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    // Terminal (completed) row, recurrence STILL set, no live successor, aged
    // 3 sweeps — the swallowed-parse-error strand signature (§4.1).
    insertInboundRow(inbound, {
      id: 'strand-1',
      status: 'completed',
      recurrence: '0 9 * * *',
      process_after: isoIn(-3 * SWEEP_INTERVAL_MS),
      timestamp: isoIn(-3 * SWEEP_INTERVAL_MS),
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const strandRow = snap.rows.find((r) => r.series_id === 'strand-1');
    expect(strandRow).toBeDefined();
    expect(strandRow!.health).toBe('strand');
  });

  it('test_duplicate_successor_flagged', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, { id: 'd-a', series_id: 'dups', process_after: isoIn(3600_000) });
    insertInboundRow(inbound, { id: 'd-b', series_id: 'dups', process_after: isoIn(7200_000) });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const rows = snap.rows.filter((r) => r.series_id === 'dups');
    expect(rows.length).toBe(2);
    // Both flagged unhealthy (duplicate-successor) — not silently healthy.
    expect(rows.every((r) => r.health === 'stalled')).toBe(true);
  });

  // ── S7: channel-name map keys on NUL, not space (collision-safe) ──────────────
  it('test_channel_name_nul_key_no_collision', async () => {
    addGroup('ag-1', 'G1', 'g1');
    // Two messaging groups whose `channel_type + ' ' + platform_id` would COLLIDE
    // under a literal space ("a b c"), but are DISTINCT under a NUL separator.
    addMg('mg-1', 'a', 'b c', 'chan-ONE'); // space key: "a b c"
    addMg('mg-2', 'a b', 'c', 'chan-TWO'); // space key: "a b c"  ← same!
    addSession('s1', 'ag-1', 'mg-1');
    addSession('s2', 'ag-1', 'mg-2');
    // Task rows whose destination (channel_type, platform_id) matches each MG.
    insertInboundRow(seedSessionDbs('ag-1', 's1').inbound, {
      id: 'r1',
      series_id: 'ser-1',
      process_after: isoIn(3600_000),
      channel_type: 'a',
      platform_id: 'b c',
    });
    insertInboundRow(seedSessionDbs('ag-1', 's2').inbound, {
      id: 'r2',
      series_id: 'ser-2',
      process_after: isoIn(3600_000),
      channel_type: 'a b',
      platform_id: 'c',
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const row1 = snap.rows.find((r) => r.series_id === 'ser-1')!;
    const row2 = snap.rows.find((r) => r.series_id === 'ser-2')!;
    // Under a NUL key the two destinations resolve to DISTINCT channel names.
    expect(row1.channel_name).toBe('chan-ONE');
    expect(row2.channel_name).toBe('chan-TWO');
  });

  it('processing health reflects a real processing_ack in outbound.db', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound, outbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, { id: 'claimed', process_after: isoIn(-1000) });
    setProcessingAck(outbound, 'claimed');

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    expect(snap.rows.find((r) => r.series_id === 'claimed')!.health).toBe('processing');
  });
});

// ── search_index (prompt/title search fast-follow) ───────────────────────────
describe('assembleSnapshot — search_index', () => {
  it('test_search_index_includes_prompt_and_script_not_on_wire_row', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, {
      id: 'r1',
      series_id: 'morning-brief',
      process_after: isoIn(3600_000),
      content: JSON.stringify({ prompt: 'Compile the QUARTERLY Zebra report', script: 'echo PLATYPUS' }),
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const row = snap.rows.find((r) => r.series_id === 'morning-brief')!;
    expect(row).toBeTruthy();

    // The index carries the lowercased prompt + script (+ name) for this key...
    const blob = snap.search_index[row.key];
    expect(blob).toContain('zebra'); // prompt body
    expect(blob).toContain('platypus'); // script body
    expect(blob).toContain('morning-brief'); // series_id still searchable

    // ...but the WIRE row must NOT carry prompt/script (lean-list invariant).
    expect('prompt' in row).toBe(false);
    expect('script' in row).toBe(false);
  });

  it('test_search_index_falls_back_to_raw_content_when_not_json', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    // Non-JSON content → parseContent falls back to raw content as the prompt,
    // so even a legacy/malformed row stays searchable.
    insertInboundRow(inbound, {
      id: 'r1',
      series_id: 'legacy-task',
      process_after: isoIn(3600_000),
      content: 'plain text WALRUS reminder',
    });

    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const row = snap.rows.find((r) => r.series_id === 'legacy-task')!;
    expect(snap.search_index[row.key]).toContain('walrus');
  });
});

// ── cancelled rows drop off the board (not "stalled") ────────────────────────
describe('assembleSnapshot — cancelled exclusion', () => {
  it('test_cancelled_recurring_latest_row_excluded', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    // Recurring series whose LATEST row is cancelled (cron still set) — an
    // intentionally-terminated task. Must NOT appear on the board at all (it was
    // mislabeled 'stalled' before this fix).
    insertInboundRow(inbound, {
      id: 'r1',
      series_id: 'old-cancelled',
      status: 'cancelled',
      recurrence: '0 9 * * *',
      process_after: isoIn(-30 * 86400_000),
    });
    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    expect(snap.rows.find((r) => r.series_id === 'old-cancelled')).toBeUndefined();
  });

  it('test_cancelled_exclusion_leaves_live_pending_recurring_healthy', async () => {
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, {
      id: 'r1',
      series_id: 'live-daily',
      status: 'pending',
      recurrence: '0 9 * * *',
      process_after: isoIn(3600_000),
    });
    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    const row = snap.rows.find((r) => r.series_id === 'live-daily');
    expect(row?.health).toBe('healthy');
  });

  it('test_strand_detection_preserved_after_cancelled_exclusion', async () => {
    // REGRESSION GUARD: a completed-but-still-recurring latest row (the genuine
    // fired-but-no-successor silent death) MUST still surface as 'strand'. We
    // excluded only 'cancelled', not the terminal statuses strand relies on.
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, {
      id: 'r1',
      series_id: 'dead-synth',
      status: 'completed',
      recurrence: '0 9 * * *',
      process_after: isoIn(-30 * 86400_000), // aged far past 2×SWEEP
      timestamp: '2026-05-14 09:00:00',
    });
    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    expect(snap.rows.find((r) => r.series_id === 'dead-synth')?.health).toBe('strand');
  });

  it('test_cancelled_latest_hides_series_even_with_earlier_pending', async () => {
    // The cancel is the latest event (highest seq) → series terminated; an
    // earlier pending row of the same series must not resurrect it on the board.
    addGroup('ag-1', 'G1', 'g1');
    addMg('mg-1', 'discord', 'd:1', 'chan-1');
    addSession('sess-1', 'ag-1', 'mg-1');
    const { inbound } = seedSessionDbs('ag-1', 'sess-1');
    insertInboundRow(inbound, {
      id: 'r-old',
      series_id: 'superseded',
      status: 'pending',
      recurrence: '0 9 * * *',
      process_after: isoIn(-2 * 86400_000),
    });
    insertInboundRow(inbound, {
      id: 'r-cancel',
      series_id: 'superseded',
      status: 'cancelled',
      recurrence: '0 9 * * *',
      process_after: isoIn(-1 * 86400_000),
    });
    const snap = await assembleSnapshot(ALL_SCOPES, opts());
    expect(snap.rows.find((r) => r.series_id === 'superseded')).toBeUndefined();
  });
});
