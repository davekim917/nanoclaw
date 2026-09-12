import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildCentralProjection,
  buildArchiveProjection,
  appendArchiveProjection,
  removeStaleProjectionSidecars,
  decideArchiveProjectionMode,
  readArchiveScopeSignature,
  ARCHIVE_DEDUP_KEY_SQL,
  ARCHIVE_PROJECTION_STAMP_VERSION,
  type ArchiveProjectionStamp,
} from './per-agent-projections.js';
import { ARCHIVE_MUTATION_MARKS_SQL } from '../message-archive.js';
import { migration025 } from './migrations/025-agent-group-capabilities.js';
import { migration026 } from './migrations/026-tasks-and-dispatch-routing.js';

const tmpFiles: string[] = [];

function tmpPath(label: string): string {
  const p = path.join(os.tmpdir(), `ncproj-${label}-${process.pid}-${Date.now()}.db`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  tmpFiles.length = 0;
});

function makeSrcFile(label: string): string {
  const p = tmpPath(label);
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE agent_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      agent_provider TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped',
      last_active TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
      name TEXT, is_group INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict', created_at TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
    CREATE TABLE backlog_items (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, priority TEXT, tags TEXT,
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      updated_at TEXT, resolved_at TEXT, notes TEXT
    );
    CREATE TABLE ship_log (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, pr_url TEXT, branch TEXT, tags TEXT, shipped_at TEXT NOT NULL
    );
  `);
  migration025.up(db);
  migration026.up(db);
  db.close();
  return p;
}

function withDb(p: string, fn: (db: Database.Database) => void): void {
  const db = new Database(p);
  db.pragma('foreign_keys = ON');
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function addAgent(p: string, agId: string): void {
  withDb(p, (db) => {
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z')`).run(
      agId,
      agId,
      agId,
    );
  });
}

function addSession(p: string, sessId: string, agId: string): void {
  withDb(p, (db) => {
    db.prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, '2026-01-01T00:00:00Z')`).run(
      sessId,
      agId,
    );
  });
}

function addTask(p: string, taskId: string, parentAgId: string, parentSessId: string, targetAgId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
         target_agent_group_id, task_content, request_hash, admitted_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'content', 'hash', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(taskId, taskId, parentSessId, parentAgId, targetAgId);
  });
}

function addCapability(p: string, agId: string): void {
  // FK enforcement is ON when writing to src — but agent_group exists so it's fine
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_at)
       VALUES (?, 'orchestrator', '{}', '2026-01-01T00:00:00Z')`,
    ).run(agId);
  });
}

function countRows(p: string, table: string): number {
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function tableExists(p: string, table: string): boolean {
  const db = new Database(p, { readonly: true });
  try {
    return db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table) !== undefined;
  } finally {
    db.close();
  }
}

// ── Archive projection helpers (B3) ────────────────────────────────────────

/**
 * Create a source archive.db containing workgroups + agent_groups (for the
 * workgroup JOIN in buildArchiveProjection) plus messages_archive rows.
 */
function makeArchiveSrc(label: string): string {
  const p = tmpPath(label);
  const db = new Database(p);
  db.pragma('foreign_keys = OFF'); // FK enforcement not needed in archive src
  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE agent_groups (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      folder       TEXT NOT NULL UNIQUE,
      workgroup_id TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      channel_name        TEXT
    );
  `);
  // The real archive's mutation counters, from the writer that owns them, so
  // the fixture cannot drift from what `initSchema` actually creates.
  db.exec(ARCHIVE_MUTATION_MARKS_SQL);
  db.close();
  return p;
}

function addWorkgroup(p: string, wgId: string, storeId: string): void {
  withDb(p, (db) => {
    db.prepare(`INSERT INTO workgroups (id, mnemon_store_id, created_at) VALUES (?, ?, '2026-01-01')`).run(
      wgId,
      storeId,
    );
  });
}

function addAgentWithWorkgroup(p: string, agId: string, folder: string, wgId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, '2026-01-01')`,
    ).run(agId, agId, folder, wgId);
  });
}

interface ArchiveRow {
  id: string;
  agent_group_id: string;
  messaging_group_id?: string;
  channel_type?: string;
  thread_id?: string;
  role: string;
  sender_id?: string;
  sender_name?: string;
  text: string;
  sent_at: string;
}

function addArchiveMsg(p: string, row: ArchiveRow): void {
  withDb(p, (db) => {
    db.prepare(
      `
      INSERT INTO messages_archive
        (id, agent_group_id, messaging_group_id, channel_type, thread_id, role,
         sender_id, sender_name, text, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')
    `,
    ).run(
      row.id,
      row.agent_group_id,
      row.messaging_group_id ?? 'mg-1',
      row.channel_type ?? 'slack',
      row.thread_id ?? 'thread-1',
      row.role,
      row.sender_id ?? null,
      row.sender_name ?? null,
      row.text,
      row.sent_at,
    );
  });
}

function getAllArchiveRows(p: string): Array<Record<string, unknown>> {
  const db = new Database(p, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM messages_archive ORDER BY id`).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// ── Central projection src with workgroups (B4) ────────────────────────────

function makeSrcFileWithWorkgroups(label: string): string {
  const p = makeSrcFile(label);
  const db = new Database(p);
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE workgroups (
      id              TEXT PRIMARY KEY,
      display_name    TEXT,
      onecli_secrets  TEXT NOT NULL DEFAULT '[]',
      mnemon_store_id TEXT,
      created_at      TEXT NOT NULL
    );
  `);
  // Add workgroup_id column to agent_groups
  const cols = (db.prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes('workgroup_id')) {
    db.exec(`ALTER TABLE agent_groups ADD COLUMN workgroup_id TEXT;`);
  }
  db.close();
  return p;
}

function addAgentToSrc(p: string, agId: string, wgId?: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, workgroup_id, created_at) VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
    ).run(agId, agId, agId, wgId ?? null);
  });
}

function addWorkgroupToSrc(p: string, wgId: string): void {
  withDb(p, (db) => {
    db.prepare(`INSERT OR IGNORE INTO workgroups (id, created_at) VALUES (?, '2026-01-01T00:00:00Z')`).run(wgId);
  });
}

// ── B3: buildArchiveProjection (workgroup-widened with dedup) ─────────────────

describe('buildArchiveProjection — workgroup-widened (B3)', () => {
  it('test_archive_pooled_with_dedup_for_paired_workgroup', () => {
    // Two siblings share workgroup "my-wg". Same user msg (same text/sent_at/sender_id/thread)
    // appears for both agents → dedup → 1 row. Two assistant rows with different sender_id → 2 rows.
    const src = makeArchiveSrc('b3-dedup-src');
    addWorkgroup(src, 'my-wg', 'ag-parent');
    addAgentWithWorkgroup(src, 'ag-parent', 'my-group', 'my-wg');
    addAgentWithWorkgroup(src, 'ag-codex', 'my-group-codex', 'my-wg');

    // Same user message duplicated across both sibling agents
    addArchiveMsg(src, {
      id: 'm1-parent',
      agent_group_id: 'ag-parent',
      role: 'user',
      sender_id: 'u-123',
      text: 'hello',
      sent_at: '2026-01-01T10:00:00Z',
      thread_id: 'thread-1',
    });
    addArchiveMsg(src, {
      id: 'm1-codex',
      agent_group_id: 'ag-codex',
      role: 'user',
      sender_id: 'u-123',
      text: 'hello',
      sent_at: '2026-01-01T10:00:00Z',
      thread_id: 'thread-1',
    });

    // Two distinct assistant replies (different sender_id → different GROUP BY bucket → 2 rows)
    addArchiveMsg(src, {
      id: 'a1-parent',
      agent_group_id: 'ag-parent',
      role: 'assistant',
      sender_id: 'ag-parent',
      text: 'reply from parent',
      sent_at: '2026-01-01T10:01:00Z',
      thread_id: 'thread-1',
    });
    addArchiveMsg(src, {
      id: 'a1-codex',
      agent_group_id: 'ag-codex',
      role: 'assistant',
      sender_id: 'ag-codex',
      text: 'reply from codex',
      sent_at: '2026-01-01T10:01:00Z',
      thread_id: 'thread-1',
    });

    const dst = tmpPath('b3-dedup-dst');
    buildArchiveProjection(src, dst, 'ag-parent', ['ag-parent', 'ag-codex']);

    const rows = getAllArchiveRows(dst);
    const userRows = rows.filter((r) => r.role === 'user');
    const assistantRows = rows.filter((r) => r.role === 'assistant');

    expect(userRows).toHaveLength(1); // deduped
    expect(assistantRows).toHaveLength(2); // distinct sender_id → both survive

    // Attribution: every row in this projection file is served to the
    // spawning agent's container, so agent_group_id must be the spawning
    // agent — NOT a sibling picked by MIN(...) from the dedup bucket.
    // Before this fix the user row carried agent_group_id='ag-codex' (the
    // alphabetically lower sibling id), giving the projection a sibling's
    // attribution for content the spawning agent never sent.
    expect(rows.every((r) => r.agent_group_id === 'ag-parent')).toBe(true);
  });

  it('test_archive_standalone_workgroup_no_dedup_needed', () => {
    // Single agent, its own workgroup — no sibling rows → no dedup, just normal copy
    const src = makeArchiveSrc('b3-standalone-src');
    addWorkgroup(src, 'solo-wg', 'ag-solo');
    addAgentWithWorkgroup(src, 'ag-solo', 'solo', 'solo-wg');

    addArchiveMsg(src, {
      id: 'm1',
      agent_group_id: 'ag-solo',
      role: 'user',
      sender_id: 'u-1',
      text: 'hi',
      sent_at: '2026-01-01T10:00:00Z',
    });
    addArchiveMsg(src, {
      id: 'a1',
      agent_group_id: 'ag-solo',
      role: 'assistant',
      sender_id: 'ag-solo',
      text: 'hey',
      sent_at: '2026-01-01T10:01:00Z',
    });

    const dst = tmpPath('b3-standalone-dst');
    buildArchiveProjection(src, dst, 'ag-solo', ['ag-solo']);

    const rows = getAllArchiveRows(dst);
    expect(rows).toHaveLength(2);
  });

  it('test_archive_isolation_across_workgroups', () => {
    // Two workgroups — projection for wg1 must NOT contain wg2 rows
    const src = makeArchiveSrc('b3-iso-src');
    addWorkgroup(src, 'wg1', 'ag-wg1');
    addWorkgroup(src, 'wg2', 'ag-wg2');
    addAgentWithWorkgroup(src, 'ag-wg1', 'group1', 'wg1');
    addAgentWithWorkgroup(src, 'ag-wg2', 'group2', 'wg2');

    addArchiveMsg(src, {
      id: 'm-wg1',
      agent_group_id: 'ag-wg1',
      role: 'user',
      sender_id: 'u-1',
      text: 'msg from wg1',
      sent_at: '2026-01-01T10:00:00Z',
    });
    addArchiveMsg(src, {
      id: 'm-wg2',
      agent_group_id: 'ag-wg2',
      role: 'user',
      sender_id: 'u-2',
      text: 'msg from wg2',
      sent_at: '2026-01-01T10:00:00Z',
    });

    const dst = tmpPath('b3-iso-dst');
    buildArchiveProjection(src, dst, 'ag-wg1', ['ag-wg1']);

    const rows = getAllArchiveRows(dst);
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.agent_group_id === 'ag-wg1')).toBe(true);
  });

  it('test_archive_empty_workgroup_member_list_produces_empty_projection', () => {
    // W3 fail-closed responsibility moved to caller (container-runner spawn path) —
    // when caller passes an empty workgroup member set, projection contains zero rows.
    // Caller is expected to throw BEFORE calling if workgroup_id is invalid; this test
    // verifies the projection itself doesn't crash on the edge case.
    const src = makeArchiveSrc('b3-empty-wg-src');
    addArchiveMsg(src, {
      id: 'm1',
      agent_group_id: 'ag-some',
      role: 'user',
      sender_id: 'u',
      text: 'hi',
      sent_at: '2026-01-01T10:00:00Z',
    });

    const dst = tmpPath('b3-empty-wg-dst');
    // Empty member set → falls through to legacy single-agent filter for the agent_id passed
    buildArchiveProjection(src, dst, 'ag-some', []);

    // With empty members, function falls back to legacy single-agent filter (length=0 check),
    // and ag-some has one row, so we expect 1 row.
    const rows = getAllArchiveRows(dst);
    expect(rows).toHaveLength(1);
  });

  it('test_dedup_picks_lowest_id_deterministically', () => {
    // Two identical rows from siblings; MIN(id) picks lexicographically smallest
    const src = makeArchiveSrc('b3-minid-src');
    addWorkgroup(src, 'wg-d', 'ag-d1');
    addAgentWithWorkgroup(src, 'ag-d1', 'group-d1', 'wg-d');
    addAgentWithWorkgroup(src, 'ag-d2', 'group-d2', 'wg-d');

    // Both get the "same" user message — id 'aaa-...' < 'zzz-...'
    addArchiveMsg(src, {
      id: 'aaa-lower',
      agent_group_id: 'ag-d1',
      role: 'user',
      sender_id: 'u-x',
      text: 'dup',
      sent_at: '2026-01-01T09:00:00Z',
    });
    addArchiveMsg(src, {
      id: 'zzz-higher',
      agent_group_id: 'ag-d2',
      role: 'user',
      sender_id: 'u-x',
      text: 'dup',
      sent_at: '2026-01-01T09:00:00Z',
    });

    const dst = tmpPath('b3-minid-dst');
    buildArchiveProjection(src, dst, 'ag-d1', ['ag-d1', 'ag-d2']);

    const rows = getAllArchiveRows(dst);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('aaa-lower');
  });
});

// ── B4: buildCentralProjection (per-table strategy, comment only) ─────────────

describe('buildCentralProjection — per-table isolation (B4)', () => {
  it('test_backlog_items_isolated_per_agent', () => {
    const src = makeSrcFileWithWorkgroups('b4-backlog-src');
    addWorkgroupToSrc(src, 'wg-b4');
    addAgentToSrc(src, 'ag-a', 'wg-b4');
    addAgentToSrc(src, 'ag-b', 'wg-b4');

    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO backlog_items (id, agent_group_id, title, status, created_at) VALUES (?, ?, ?, 'open', '2026-01-01')`,
      ).run('bi-a', 'ag-a', 'Task for A');
      db.prepare(
        `INSERT INTO backlog_items (id, agent_group_id, title, status, created_at) VALUES (?, ?, ?, 'open', '2026-01-01')`,
      ).run('bi-b', 'ag-b', 'Task for B');
    });

    const dst = tmpPath('b4-backlog-dst');
    buildCentralProjection(src, dst, 'ag-a');

    // Projection for ag-a must ONLY contain ag-a's backlog rows
    const db = new Database(dst, { readonly: true });
    try {
      const rows = db.prepare(`SELECT id FROM backlog_items`).all() as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('bi-a');
    } finally {
      db.close();
    }
  });

  it('test_ship_log_isolated_per_agent', () => {
    const src = makeSrcFileWithWorkgroups('b4-ship-src');
    addWorkgroupToSrc(src, 'wg-b4s');
    addAgentToSrc(src, 'ag-ship-a', 'wg-b4s');
    addAgentToSrc(src, 'ag-ship-b', 'wg-b4s');

    withDb(src, (db) => {
      db.prepare(`INSERT INTO ship_log (id, agent_group_id, title, shipped_at) VALUES (?, ?, ?, '2026-01-01')`).run(
        'sl-a',
        'ag-ship-a',
        'Ship A',
      );
      db.prepare(`INSERT INTO ship_log (id, agent_group_id, title, shipped_at) VALUES (?, ?, ?, '2026-01-01')`).run(
        'sl-b',
        'ag-ship-b',
        'Ship B',
      );
    });

    const dst = tmpPath('b4-ship-dst');
    buildCentralProjection(src, dst, 'ag-ship-a');

    const db = new Database(dst, { readonly: true });
    try {
      const rows = db.prepare(`SELECT id FROM ship_log`).all() as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sl-a');
    } finally {
      db.close();
    }
  });

  it('test_agent_group_capabilities_per_agent', () => {
    // Parent has orchestrator role; codex twin should NOT see parent's capability
    const src = makeSrcFileWithWorkgroups('b4-cap-src');
    addWorkgroupToSrc(src, 'wg-b4c');
    addAgentToSrc(src, 'ag-parent-cap', 'wg-b4c');
    addAgentToSrc(src, 'ag-codex-cap', 'wg-b4c');

    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_at)
         VALUES (?, 'orchestrator', '{}', '2026-01-01')`,
      ).run('ag-parent-cap');
    });

    const dst = tmpPath('b4-cap-dst');
    buildCentralProjection(src, dst, 'ag-codex-cap');

    // ag-codex-cap projection must have 0 capability rows (ag-parent-cap's role must not pool)
    expect(countRows(dst, 'agent_group_capabilities')).toBe(0);
  });

  it('test_tasks_isolated_per_parent', () => {
    const src = makeSrcFileWithWorkgroups('b4-task-src');
    addWorkgroupToSrc(src, 'wg-b4t');
    addAgentToSrc(src, 'ag-orch-t', 'wg-b4t');
    addAgentToSrc(src, 'ag-other-t', 'wg-b4t');
    addAgentToSrc(src, 'ag-target-t', 'wg-b4t');
    addSession(src, 'sess-t-orch', 'ag-orch-t');
    addSession(src, 'sess-t-other', 'ag-other-t');

    addTask(src, 'task-orch-t', 'ag-orch-t', 'sess-t-orch', 'ag-target-t');
    addTask(src, 'task-other-t', 'ag-other-t', 'sess-t-other', 'ag-target-t');

    const dst = tmpPath('b4-task-dst');
    buildCentralProjection(src, dst, 'ag-orch-t');

    expect(countRows(dst, 'tasks')).toBe(1);
    const db = new Database(dst, { readonly: true });
    try {
      const task = db.prepare(`SELECT task_id FROM tasks`).get() as { task_id: string };
      expect(task.task_id).toBe('task-orch-t');
    } finally {
      db.close();
    }
  });
});

describe('buildCentralProjection', () => {
  it('test_projection_copies_tasks_for_orchestrator', () => {
    const src = makeSrcFile('p1s');
    addAgent(src, 'ag-orch');
    addAgent(src, 'ag-target');
    addAgent(src, 'other-group');
    addSession(src, 'sess-orch', 'ag-orch');
    addSession(src, 'sess-other', 'other-group');
    addTask(src, 'task-orch', 'ag-orch', 'sess-orch', 'ag-target');
    addTask(src, 'task-other', 'other-group', 'sess-other', 'ag-target');
    addCapability(src, 'ag-orch');

    const dst = tmpPath('p1d');
    buildCentralProjection(src, dst, 'ag-orch');

    expect(countRows(dst, 'tasks')).toBe(1);
    expect(countRows(dst, 'agent_group_capabilities')).toBe(1);

    const db = new Database(dst, { readonly: true });
    try {
      const task = db.prepare(`SELECT task_id FROM tasks`).get() as { task_id: string } | undefined;
      expect(task?.task_id).toBe('task-orch');
    } finally {
      db.close();
    }
  });

  it('test_projection_excludes_other_orchestrators_tasks', () => {
    const src = makeSrcFile('p2s');
    addAgent(src, 'ag-orch');
    addAgent(src, 'ag-target');
    addAgent(src, 'other-group');
    addSession(src, 'sess-orch', 'ag-orch');
    addSession(src, 'sess-other', 'other-group');
    addTask(src, 'task-orch', 'ag-orch', 'sess-orch', 'ag-target');
    addTask(src, 'task-other', 'other-group', 'sess-other', 'ag-target');
    addCapability(src, 'ag-orch');

    const dst = tmpPath('p2d');
    buildCentralProjection(src, dst, 'other-group');

    expect(countRows(dst, 'tasks')).toBe(1);
    const db = new Database(dst, { readonly: true });
    try {
      const task = db.prepare(`SELECT task_id FROM tasks`).get() as { task_id: string } | undefined;
      expect(task?.task_id).toBe('task-other');
    } finally {
      db.close();
    }
    expect(countRows(dst, 'agent_group_capabilities')).toBe(0);
  });

  it('test_projection_works_with_no_data_rows', () => {
    const src = makeSrcFile('p3s');
    const dst = tmpPath('p3d');

    expect(() => buildCentralProjection(src, dst, 'ag-none')).not.toThrow();

    expect(tableExists(dst, 'tasks')).toBe(true);
    expect(tableExists(dst, 'agent_group_capabilities')).toBe(true);
    expect(tableExists(dst, 'backlog_items')).toBe(true);
    expect(tableExists(dst, 'ship_log')).toBe(true);
    expect(countRows(dst, 'tasks')).toBe(0);
    expect(countRows(dst, 'agent_group_capabilities')).toBe(0);
  });

  it('test_container_configs_filtered_to_self_only', () => {
    // container_configs is per-agent; the projection must only carry this
    // agent's own row, never any other group's config.
    const src = makeSrcFile('p-cc-src');
    addAgent(src, 'ag-self');
    addAgent(src, 'ag-other');
    withDb(src, (db) => {
      db.exec(`
        CREATE TABLE container_configs (
          agent_group_id TEXT PRIMARY KEY,
          provider       TEXT,
          model          TEXT,
          effort         TEXT,
          config_json    TEXT,
          updated_at     TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO container_configs (agent_group_id, provider, model, effort, config_json, updated_at)
         VALUES (?, ?, ?, ?, '{}', '2026-01-01')`,
      ).run('ag-self', 'opencode', 'opencode/kimi-k2.6', 'medium');
      db.prepare(
        `INSERT INTO container_configs (agent_group_id, provider, model, effort, config_json, updated_at)
         VALUES (?, ?, ?, ?, '{}', '2026-01-01')`,
      ).run('ag-other', 'codex', 'gpt-5.5', 'high');
    });

    const dst = tmpPath('p-cc-dst');
    buildCentralProjection(src, dst, 'ag-self');

    expect(countRows(dst, 'container_configs')).toBe(1);
    const db = new Database(dst, { readonly: true });
    try {
      const row = db.prepare(`SELECT agent_group_id, model FROM container_configs`).get() as {
        agent_group_id: string;
        model: string;
      };
      expect(row.agent_group_id).toBe('ag-self');
      expect(row.model).toBe('opencode/kimi-k2.6');
    } finally {
      db.close();
    }
  });

  it('test_denied_models_projected_wholesale_across_providers', () => {
    // denied_models is operator policy (not tenant-scoped) — every row is
    // projected so the agent can filter its `opencode models` output against
    // the full set without needing to know its own provider first.
    const src = makeSrcFile('p-dm-src');
    addAgent(src, 'ag-self');
    withDb(src, (db) => {
      db.exec(`
        CREATE TABLE denied_models (
          provider   TEXT NOT NULL,
          slug       TEXT NOT NULL,
          reason     TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (provider, slug)
        );
      `);
      db.prepare(`INSERT INTO denied_models (provider, slug, reason, created_at) VALUES (?, ?, ?, '2026-01-01')`).run(
        'opencode',
        'anthropic/claude-opus-4-7',
        'wrong billing tier',
      );
      db.prepare(`INSERT INTO denied_models (provider, slug, reason, created_at) VALUES (?, ?, ?, '2026-01-01')`).run(
        'codex',
        'gpt-5.5-mini',
        'placeholder reason',
      );
    });

    const dst = tmpPath('p-dm-dst');
    buildCentralProjection(src, dst, 'ag-self');

    expect(countRows(dst, 'denied_models')).toBe(2);
  });

  it('test_existing_backlog_and_shiplog_still_copied', () => {
    const src = makeSrcFile('p4s');
    addAgent(src, 'ag-1');
    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO backlog_items (id, agent_group_id, title, status, created_at)
         VALUES ('b1', 'ag-1', 'Fix bug', 'open', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO ship_log (id, agent_group_id, title, shipped_at)
         VALUES ('s1', 'ag-1', 'Ship v1', '2026-01-01')`,
      ).run();
    });

    const dst = tmpPath('p4d');
    buildCentralProjection(src, dst, 'ag-1');

    expect(countRows(dst, 'backlog_items')).toBe(1);
    expect(countRows(dst, 'ship_log')).toBe(1);
  });
});

// ── #360: incremental append instead of a full rebuild ───────────────────────

/** The columns that decide what a container sees. Archive ids are not among them. */
function contentRows(p: string): Array<Record<string, unknown>> {
  return getAllArchiveRows(p)
    .map((r) => ({
      agent_group_id: r.agent_group_id,
      messaging_group_id: r.messaging_group_id,
      thread_id: r.thread_id,
      role: r.role,
      sender_id: r.sender_id,
      text: r.text,
      sent_at: r.sent_at,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function ftsHits(p: string, term: string): number {
  const db = new Database(p, { readonly: true });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM messages_archive_fts WHERE messages_archive_fts MATCH ?`)
      .get(term) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function maxRowid(p: string, scope: string[]): number {
  const db = new Database(p, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(MAX(rowid), 0) AS m FROM messages_archive WHERE agent_group_id IN (${scope
          .map(() => '?')
          .join(', ')})`,
      )
      .get(...scope) as { m: number };
    return row.m;
  } finally {
    db.close();
  }
}

function twoSiblingSource(label: string): string {
  const src = makeArchiveSrc(label);
  addWorkgroup(src, 'wg-append', 'ag-test-a');
  addAgentWithWorkgroup(src, 'ag-test-a', 'folder-test-a', 'wg-append');
  addAgentWithWorkgroup(src, 'ag-test-b', 'folder-test-b', 'wg-append');
  // The same user message archived against both siblings, plus one reply each.
  addArchiveMsg(src, {
    id: 'm1-a',
    agent_group_id: 'ag-test-a',
    role: 'user',
    sender_id: 'u-1',
    text: 'first question',
    sent_at: '2026-01-01T10:00:00Z',
  });
  addArchiveMsg(src, {
    id: 'm1-b',
    agent_group_id: 'ag-test-b',
    role: 'user',
    sender_id: 'u-1',
    text: 'first question',
    sent_at: '2026-01-01T10:00:00Z',
  });
  addArchiveMsg(src, {
    id: 'r1-a',
    agent_group_id: 'ag-test-a',
    role: 'assistant',
    sender_id: 'ag-test-a',
    text: 'first answer',
    sent_at: '2026-01-01T10:01:00Z',
  });
  return src;
}

describe('appendArchiveProjection — #360', () => {
  const scope = ['ag-test-a', 'ag-test-b'];

  it('lands the same row set as a fresh full build of the grown source', () => {
    const src = twoSiblingSource('append-equiv-src');
    const dst = tmpPath('append-equiv-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const watermark = maxRowid(src, scope);

    addArchiveMsg(src, {
      id: 'm2-a',
      agent_group_id: 'ag-test-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'second question',
      sent_at: '2026-01-01T11:00:00Z',
    });
    addArchiveMsg(src, {
      id: 'm2-b',
      agent_group_id: 'ag-test-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'second question',
      sent_at: '2026-01-01T11:00:00Z',
    });
    addArchiveMsg(src, {
      id: 'r2-b',
      agent_group_id: 'ag-test-b',
      role: 'assistant',
      sender_id: 'ag-test-b',
      text: 'second answer',
      sent_at: '2026-01-01T11:01:00Z',
    });

    const { written, merged } = appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope);
    // The sibling pair collapses to one row, so three new source rows land as two.
    expect(written).toBe(2);
    expect(merged).toBe(0);

    const expected = tmpPath('append-equiv-expected');
    buildArchiveProjection(src, expected, 'ag-test-a', scope);
    expect(contentRows(dst)).toEqual(contentRows(expected));
    expect(getAllArchiveRows(dst)).toHaveLength(getAllArchiveRows(expected).length);
  });

  it('inserts nothing for a sibling duplicate of an already-projected message', () => {
    const src = twoSiblingSource('append-dup-src');
    const dst = tmpPath('append-dup-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const before = getAllArchiveRows(dst);
    const watermark = maxRowid(src, scope);

    // The sibling's copy of the FIRST question arrives late — it is content-
    // identical to a row the full build already collapsed and projected.
    addArchiveMsg(src, {
      id: 'm1-b-late',
      agent_group_id: 'ag-test-b',
      role: 'user',
      sender_id: 'u-1',
      text: 'first question',
      sent_at: '2026-01-01T10:00:00Z',
    });

    // Nothing new is inserted, and the merge is a no-op because the late copy
    // carries no metadata the projected row is missing.
    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope)).toEqual({ written: 0, merged: 0 });
    expect(getAllArchiveRows(dst)).toEqual(before);
  });

  it('makes appended rows findable through messages_archive_fts', () => {
    const src = twoSiblingSource('append-fts-src');
    const dst = tmpPath('append-fts-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const watermark = maxRowid(src, scope);
    expect(ftsHits(dst, 'zarquon')).toBe(0);

    addArchiveMsg(src, {
      id: 'm3-a',
      agent_group_id: 'ag-test-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'the zarquon question',
      sent_at: '2026-01-01T12:00:00Z',
    });
    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope).written).toBe(1);
    expect(ftsHits(dst, 'zarquon')).toBe(1);
  });

  it('resolves the dedup guard through an index, not a scan of the projection', () => {
    // The guard runs once per candidate row against a projection that reaches
    // 240 MB on the live host. If the planner ever stops using
    // idx_archive_thread(agent_group_id, thread_id, sent_at) for it — an `IS`
    // on a nullable column that stopped being index-usable, a dropped index —
    // the append quietly becomes quadratic and is slower than the full rebuild
    // it replaced.
    const src = twoSiblingSource('append-plan-src');
    const dst = tmpPath('append-plan-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);

    const db = new Database(dst, { readonly: true });
    try {
      // The REAL predicate, imported, not retyped: a future edit to
      // ARCHIVE_DEDUP_KEY_SQL that loses the index has to fail here, which it
      // could not do if this test carried its own copy of the SQL.
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM messages_archive WHERE ${ARCHIVE_DEDUP_KEY_SQL}`).all({
          agent_group_id: 'ag-test-a',
          thread_id: 'thread-1',
          sent_at: '2026-01-01T10:00:00Z',
          messaging_group_id: 'mg-1',
          role: 'user',
          sender_id: 'u-1',
          text: 'first question',
        }) as Array<{ detail: string }>
      )
        .map((r) => r.detail)
        .join(' | ');
      expect(plan, `dedup guard fell back to a table scan: ${plan}`).toMatch(/USING (COVERING )?INDEX/);
      expect(plan).not.toMatch(/SCAN messages_archive(?! USING)/);
    } finally {
      db.close();
    }
  });

  it('merges a late duplicate into the projected row instead of discarding it', () => {
    const src = twoSiblingSource('append-merge-src');
    const dst = tmpPath('append-merge-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const watermark = maxRowid(src, scope);

    // The projected copy of 'first question' came from a row with no
    // sender_name and no channel_name. The sibling's copy arrives later WITH
    // both. The full build would fold them in with MAX(); an append that just
    // dropped the duplicate would leave the projection permanently missing
    // them, since the stamp advances either way and thread-search reads them.
    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO messages_archive
           (id, agent_group_id, messaging_group_id, channel_type, thread_id, role,
            sender_id, sender_name, text, sent_at, created_at, channel_name)
         VALUES ('m1-b-late', 'ag-test-b', 'mg-1', 'slack', 'thread-1', 'user',
                 'u-1', 'Real Name', 'first question', '2026-01-01T10:00:00Z',
                 '2026-01-01T00:00:00Z', 'general')`,
      ).run();
    });

    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope)).toEqual({ written: 0, merged: 1 });

    const mergedRow = getAllArchiveRows(dst).find((r) => r.text === 'first question');
    expect(mergedRow?.sender_name).toBe('Real Name');
    expect(mergedRow?.channel_name).toBe('general');

    // Full parity with a fresh full build, ids included.
    const expected = tmpPath('append-merge-expected');
    buildArchiveProjection(src, expected, 'ag-test-a', scope);
    expect(getAllArchiveRows(dst)).toEqual(getAllArchiveRows(expected));
  });

  it('never lets a NULL in the late copy erase metadata already projected', () => {
    const src = twoSiblingSource('append-nullsafe-src');
    // Give the FIRST copy the metadata, so the late one has NULLs where the
    // projected row has values. SQLite's scalar max() returns NULL if either
    // argument is NULL, so a bare max() here would wipe the projected name.
    withDb(src, (db) => {
      db.prepare("UPDATE messages_archive SET sender_name = 'Real Name' WHERE id = 'm1-a'").run();
    });
    const dst = tmpPath('append-nullsafe-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const watermark = maxRowid(src, scope);

    withDb(src, (db) => {
      db.prepare(
        `INSERT INTO messages_archive
           (id, agent_group_id, messaging_group_id, channel_type, thread_id, role,
            sender_id, sender_name, text, sent_at, created_at, channel_name)
         VALUES ('m1-b-null', 'ag-test-b', 'mg-1', 'slack', 'thread-1', 'user',
                 'u-1', NULL, 'first question', '2026-01-01T10:00:00Z',
                 '2026-01-01T00:00:00Z', NULL)`,
      ).run();
    });

    // merged 0 is the assertion, not an accident: the NULL-safe fold produces
    // exactly what is already stored, so nothing is rewritten. A bare
    // max(sender_name, @sender_name) would instead have written NULL over the
    // name and reported a merge.
    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope)).toEqual({ written: 0, merged: 0 });
    const mergedRow = getAllArchiveRows(dst).find((r) => r.text === 'first question');
    expect(mergedRow?.sender_name).toBe('Real Name');

    const expected = tmpPath('append-nullsafe-expected');
    buildArchiveProjection(src, expected, 'ag-test-a', scope);
    expect(getAllArchiveRows(dst)).toEqual(getAllArchiveRows(expected));
  });

  it('appends in legacy single-agent mode, guarding on the primary key', () => {
    const src = twoSiblingSource('append-legacy-src');
    const dst = tmpPath('append-legacy-dst');
    buildArchiveProjection(src, dst, 'ag-test-a');
    const watermark = maxRowid(src, ['ag-test-a']);

    addArchiveMsg(src, {
      id: 'legacy-new',
      agent_group_id: 'ag-test-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'legacy addition',
      sent_at: '2026-01-01T13:00:00Z',
    });
    // A verbatim repeat under a DIFFERENT id is a genuinely distinct legacy row
    // and must survive: legacy mode has no dedup in the full build either.
    addArchiveMsg(src, {
      id: 'legacy-new-2',
      agent_group_id: 'ag-test-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'legacy addition',
      sent_at: '2026-01-01T13:00:00Z',
    });
    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark)).toEqual({ written: 2, merged: 0 });

    const expected = tmpPath('append-legacy-expected');
    buildArchiveProjection(src, expected, 'ag-test-a');
    expect(getAllArchiveRows(dst)).toEqual(getAllArchiveRows(expected));

    // Re-running the same append is a no-op: every id is already present, and
    // legacy mode never merges.
    expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark)).toEqual({ written: 0, merged: 0 });
  });
});

// ── Foreign hot-journal replay (#668 / #676 item 1) ──────────────────────────
//
// The session directory is bind-mounted read-write into the container
// (`src/container-runner.ts:4439`) with only `archive.db` overlaid read-only
// (`:4812`), so a container can plant `archive.db-journal` beside the projection
// even though it cannot rewrite the db itself. A rollback journal is not bound
// to its database's identity — its per-page checksums are seeded by a nonce in
// the journal's own header — so a hand-built journal is replayed as a HOT
// journal on the host's next read-write (append) open, injecting the container's
// chosen page images. The host is the sole legitimate writer and never leaves a
// live journal between spawns (a crash-time journal pairs with a removed stamp
// and forces a rebuild), so appendArchiveProjection strips any sidecar first.
describe('appendArchiveProjection — foreign hot-journal is never replayed (#668/#676)', () => {
  const PAGE_SIZE = 4096;
  const JOURNAL_MAGIC = 'd9d505f920a163d7';

  // SQLite rollback-journal per-page checksum: seeded by the journal header's
  // own nonce (cksumInit), then every 200th byte from the tail of the page.
  function pageChecksum(cksumInit: number, page: Buffer): number {
    let c = cksumInit >>> 0;
    for (let i = PAGE_SIZE - 200; i > 0; i -= 200) c = (c + page[i]) >>> 0;
    return c >>> 0;
  }

  // A well-formed rollback journal whose replay restores `restoreToDb` byte for
  // byte — exactly what a container with shell access and a readable copy of the
  // page layout can assemble by hand.
  function buildHotJournalRestoringTo(restoreToDb: string): Buffer {
    const image = fs.readFileSync(restoreToDb);
    const nPages = Math.ceil(image.length / PAGE_SIZE);
    const sectorSize = 512;
    const cksumInit = 0x0badf00d;
    const header = Buffer.alloc(sectorSize);
    Buffer.from(JOURNAL_MAGIC, 'hex').copy(header, 0);
    header.writeUInt32BE(nPages, 8); // nRec
    header.writeUInt32BE(cksumInit, 12); // cksumInit (nonce)
    header.writeUInt32BE(nPages, 16); // nOrig — truncate the db to this many pages
    header.writeUInt32BE(sectorSize, 20);
    header.writeUInt32BE(PAGE_SIZE, 24);
    const parts: Buffer[] = [header];
    for (let pageNo = 1; pageNo <= nPages; pageNo++) {
      const page = Buffer.alloc(PAGE_SIZE);
      image.copy(page, 0, (pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE);
      const rec = Buffer.alloc(4 + PAGE_SIZE + 4);
      rec.writeUInt32BE(pageNo, 0);
      page.copy(rec, 4);
      rec.writeUInt32BE(pageChecksum(cksumInit, page), 4 + PAGE_SIZE);
      parts.push(rec);
    }
    return Buffer.concat(parts);
  }

  function forgeRow(dbPath: string, id: string, text: string): void {
    withDb(dbPath, (db) => {
      db.prepare(
        `INSERT INTO messages_archive
           (id, agent_group_id, messaging_group_id, channel_type, thread_id, role,
            sender_id, sender_name, text, sent_at, created_at)
         VALUES (?, 'ag-test-a', 'mg-1', 'slack', 'thread-1', 'user', 'victim', 'Victim', ?, '2026-01-01T09:59:00Z', '2026-01-01T00:00:00Z')`,
      ).run(id, text);
    });
  }

  it('discards a planted hot journal and lands only the legitimate appended rows', () => {
    const scope = ['ag-test-a', 'ag-test-b'];
    const src = twoSiblingSource('hotjrnl-src');
    const dst = tmpPath('hotjrnl-dst');
    buildArchiveProjection(src, dst, 'ag-test-a', scope);
    const watermark = maxRowid(src, scope);

    // The attacker's target state: the projection as-is plus a forged row the
    // agent never received. Label it with the querying agent's own id so #668's
    // seed-time MIN/MAX foreign-agent check could not catch the spread either.
    const poison = tmpPath('hotjrnl-poison');
    fs.copyFileSync(dst, poison);
    forgeRow(poison, 'forged-1', 'FORGED HISTORY injected via a planted hot journal');
    const journal = buildHotJournalRestoringTo(poison);

    // Control: prove the journal is genuinely HOT — replayed verbatim by SQLite
    // against a byte-identical projection opened WITHOUT the guard. Otherwise a
    // malformed journal would make the real assertion pass vacuously.
    const control = tmpPath('hotjrnl-control');
    fs.copyFileSync(dst, control);
    fs.writeFileSync(`${control}-journal`, journal);
    tmpFiles.push(`${control}-journal`);
    const controlDb = new Database(control); // default DELETE mode, as the host uses
    controlDb.exec('BEGIN IMMEDIATE');
    controlDb.exec('COMMIT');
    controlDb.close();
    expect(getAllArchiveRows(control).some((r) => r.id === 'forged-1')).toBe(true);

    // Plant the same journal next to the real projection and grow the source so
    // the host takes the append path on the next spawn.
    fs.writeFileSync(`${dst}-journal`, journal);
    tmpFiles.push(`${dst}-journal`);
    addArchiveMsg(src, {
      id: 'm2-a',
      agent_group_id: 'ag-test-a',
      role: 'user',
      sender_id: 'u-1',
      text: 'second question',
      sent_at: '2026-01-01T11:00:00Z',
    });

    // The real host append open (per-agent-projections.ts).
    appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope);

    // The forged row must NOT have been injected, and the sidecar must be gone.
    expect(getAllArchiveRows(dst).some((r) => r.id === 'forged-1')).toBe(false);
    expect(fs.existsSync(`${dst}-journal`)).toBe(false);

    // And the projection is exactly a fresh full build of the grown source —
    // the legitimate append still happened; only the planted journal was lost.
    const expected = tmpPath('hotjrnl-expected');
    buildArchiveProjection(src, expected, 'ag-test-a', scope);
    expect(contentRows(dst)).toEqual(contentRows(expected));
  });
});

describe('removeStaleProjectionSidecars — dangling links (#751)', () => {
  it('rebuilds and appends with a dangling journal beside the projection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncproj-sidecar-'));
    try {
      const src = twoSiblingSource('dangling-sidecar-src');
      const dst = path.join(dir, 'archive.db');
      const target = path.join(dir, 'absent-target');
      const scope = ['ag-test-a', 'ag-test-b'];
      fs.symlinkSync(target, `${dst}-journal`);
      buildArchiveProjection(src, dst, 'ag-test-a', scope);
      const before = contentRows(dst);
      const watermark = maxRowid(src, scope);
      addArchiveMsg(src, {
        id: 'sidecar-new-row',
        agent_group_id: 'ag-test-a',
        role: 'assistant',
        sender_id: 'ag-test-a',
        text: 'new row after cleanup',
        sent_at: '2026-01-01T10:02:00Z',
      });
      fs.symlinkSync(target, `${dst}-journal`);
      expect(appendArchiveProjection(src, dst, 'ag-test-a', watermark, scope).written).toBe(1);
      expect(contentRows(dst)).toHaveLength(before.length + 1);
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.lstatSync(`${dst}-journal`, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['-journal', '-wal', '-shm'])('unlinks a dangling %s without creating its target', (suffix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncproj-sidecar-'));
    try {
      const dst = path.join(dir, 'archive.db');
      const target = path.join(dir, 'absent-target');
      fs.symlinkSync(target, `${dst}${suffix}`);
      expect(fs.existsSync(`${dst}${suffix}`)).toBe(false);
      expect(fs.lstatSync(`${dst}${suffix}`).isSymbolicLink()).toBe(true);

      expect(removeStaleProjectionSidecars(dst)).toEqual([suffix]);
      expect(fs.lstatSync(`${dst}${suffix}`, { throwIfNoEntry: false })).toBeUndefined();
      expect(fs.existsSync(target)).toBe(false);
      expect(removeStaleProjectionSidecars(dst)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlinks sidecars without modifying an existing symlink target', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncproj-sidecar-'));
    try {
      const dst = path.join(dir, 'archive.db');
      const target = path.join(dir, 'preserved-target');
      fs.writeFileSync(target, 'preserve me');
      fs.symlinkSync(target, `${dst}-journal`);
      fs.writeFileSync(`${dst}-wal`, 'stale');
      fs.writeFileSync(`${dst}-shm`, 'stale');

      expect(removeStaleProjectionSidecars(dst)).toEqual(['-journal', '-wal', '-shm']);
      expect(fs.readFileSync(target, 'utf8')).toBe('preserve me');
      expect(removeStaleProjectionSidecars(dst)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('surfaces errors other than a missing sidecar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncproj-sidecar-'));
    try {
      const dst = path.join(dir, 'archive.db');
      fs.mkdirSync(`${dst}-journal`);
      expect(() => removeStaleProjectionSidecars(dst)).toThrow();
      expect(fs.statSync(`${dst}-journal`).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readArchiveScopeSignature — #360', () => {
  it("counts only the scope's own rows and its own mutations", () => {
    const src = twoSiblingSource('signature-src');
    addAgentWithWorkgroup(src, 'ag-test-c', 'folder-test-c', 'wg-other');
    addArchiveMsg(src, {
      id: 'other-1',
      agent_group_id: 'ag-test-c',
      role: 'user',
      sender_id: 'u-9',
      text: 'other workgroup',
      sent_at: '2026-01-01T10:00:00Z',
    });

    const scope = ['ag-test-a', 'ag-test-b'];
    const mine = readArchiveScopeSignature(src, 'ag-test-a', scope);
    expect(mine.count).toBe(3);
    expect(mine.mutations).toBe(0);

    // An edit in the OTHER workgroup moves its counter, never mine.
    withDb(src, (db) => {
      db.prepare("UPDATE messages_archive SET text = 'edited elsewhere' WHERE id = 'other-1'").run();
    });
    expect(readArchiveScopeSignature(src, 'ag-test-a', scope)).toEqual(mine);
    expect(readArchiveScopeSignature(src, 'ag-test-c', ['ag-test-c']).mutations).toBe(1);

    // An edit inside my scope does move mine.
    withDb(src, (db) => {
      db.prepare("UPDATE messages_archive SET text = 'edited here' WHERE id = 'r1-a'").run();
    });
    expect(readArchiveScopeSignature(src, 'ag-test-a', scope).mutations).toBe(1);
  });

  it('reports an unknown mutation count for an archive with no marks table', () => {
    const src = tmpPath('signature-nomarks');
    const db = new Database(src);
    db.exec(`
      CREATE TABLE messages_archive (
        id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT,
        channel_type TEXT NOT NULL, platform_id TEXT, thread_id TEXT, role TEXT NOT NULL,
        sender_id TEXT, sender_name TEXT, text TEXT NOT NULL, sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL, channel_name TEXT
      );
    `);
    db.close();
    expect(readArchiveScopeSignature(src, 'ag-test-a', ['ag-test-a']).mutations).toBeNull();
  });

  it('waits on a writer holding the source lock rather than failing instantly', () => {
    const src = twoSiblingSource('signature-busy');
    // An EXCLUSIVE transaction left open on the source is what the host's
    // synchronous archive writer looks like mid-commit. v1 touched the source
    // only when it was already rebuilding; v2 reads it on every spawn, so this
    // is now on the hot path and must wait rather than abort the spawn.
    const writer = new Database(src);
    writer.exec('BEGIN EXCLUSIVE');
    try {
      const startedAt = Date.now();
      let threw: unknown = null;
      try {
        readArchiveScopeSignature(src, 'ag-test-a', ['ag-test-a', 'ag-test-b']);
      } catch (err) {
        threw = err;
      }
      const elapsed = Date.now() - startedAt;
      // Whether it eventually wins or eventually gives up, it must have WAITED
      // — an unset busy timeout returns SQLITE_BUSY in microseconds.
      expect(elapsed, `gave up after ${elapsed}ms, so no busy timeout was in effect`).toBeGreaterThan(500);
      if (threw) expect(String((threw as { code?: string }).code)).toMatch(/SQLITE_BUSY/);
    } finally {
      writer.exec('ROLLBACK');
      writer.close();
    }
  }, 30_000);

  it('reads a missing source as an empty, unedited scope', () => {
    expect(readArchiveScopeSignature(tmpPath('absent'), 'ag-test-a')).toEqual({
      count: 0,
      maxRowid: 0,
      mutations: 0,
    });
  });
});

describe('decideArchiveProjectionMode — #360', () => {
  function stamp(overrides: Partial<ArchiveProjectionStamp> = {}): ArchiveProjectionStamp {
    return {
      version: ARCHIVE_PROJECTION_STAMP_VERSION,
      agentGroupId: 'ag-test-a',
      scope: ['ag-test-a', 'ag-test-b'],
      rows: { count: 10, maxRowid: 100 },
      mutations: 0,
      ...overrides,
    };
  }

  let dst: string;
  beforeEach(() => {
    dst = tmpPath('decide-dst');
    fs.writeFileSync(dst, 'not empty');
  });

  it('reuses when the scope has not moved', () => {
    expect(decideArchiveProjectionMode(dst, stamp(), stamp())).toEqual({ mode: 'reused', sinceRowid: null });
  });

  it('appends when both counters grew', () => {
    const next = stamp({ rows: { count: 12, maxRowid: 140 } });
    expect(decideArchiveProjectionMode(dst, stamp(), next)).toEqual({ mode: 'appended', sinceRowid: 100 });
  });

  it('rebuilds when the row count went down', () => {
    const next = stamp({ rows: { count: 9, maxRowid: 100 } });
    expect(decideArchiveProjectionMode(dst, stamp(), next).mode).toBe('rebuilt');
  });

  it('rebuilds when maxRowid moved without the count moving', () => {
    const next = stamp({ rows: { count: 10, maxRowid: 140 } });
    expect(decideArchiveProjectionMode(dst, stamp(), next).mode).toBe('rebuilt');
  });

  it('rebuilds when maxRowid went DOWN at an unchanged count', () => {
    // A restore from backup can land a file with the same number of rows and a
    // lower high-water mark. Reuse would serve rows the source no longer has,
    // and append would start from a watermark above everything present.
    const next = stamp({ rows: { count: 10, maxRowid: 60 } });
    expect(decideArchiveProjectionMode(dst, stamp(), next).mode).toBe('rebuilt');
  });

  it('rebuilds on any maxRowid decrease, whatever the count did', () => {
    for (const count of [8, 10, 12]) {
      const next = stamp({ rows: { count, maxRowid: 60 } });
      expect(decideArchiveProjectionMode(dst, stamp(), next).mode, `count ${count}`).toBe('rebuilt');
    }
  });

  it('rebuilds on an in-place edit, which no watermark can see', () => {
    const next = stamp({ rows: { count: 10, maxRowid: 100 }, mutations: 1 });
    expect(decideArchiveProjectionMode(dst, stamp(), next).mode).toBe('rebuilt');
    // ...including when rows were appended in the same window.
    const both = stamp({ rows: { count: 12, maxRowid: 140 }, mutations: 1 });
    expect(decideArchiveProjectionMode(dst, stamp(), both).mode).toBe('rebuilt');
  });

  it('rebuilds when either side could not count mutations', () => {
    expect(decideArchiveProjectionMode(dst, stamp({ mutations: null }), stamp()).mode).toBe('rebuilt');
    expect(decideArchiveProjectionMode(dst, stamp(), stamp({ mutations: null })).mode).toBe('rebuilt');
  });

  it('rebuilds for a v1 stamp, a changed scope, a changed agent and a missing projection', () => {
    expect(decideArchiveProjectionMode(dst, null, stamp()).mode).toBe('rebuilt');
    expect(decideArchiveProjectionMode(dst, stamp({ version: 1 }), stamp()).mode).toBe('rebuilt');
    expect(decideArchiveProjectionMode(dst, stamp({ scope: ['ag-test-a'] }), stamp()).mode).toBe('rebuilt');
    expect(decideArchiveProjectionMode(dst, stamp({ agentGroupId: 'ag-test-b' }), stamp()).mode).toBe('rebuilt');
    fs.writeFileSync(dst, '');
    expect(decideArchiveProjectionMode(dst, stamp(), stamp()).mode).toBe('rebuilt');
  });
});
