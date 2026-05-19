import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildCentralProjection, buildArchiveProjection } from './per-agent-projections.js';
import { migration025 } from './migrations/025-agent-group-capabilities.js';
import { migration026 } from './migrations/026-tasks-and-dispatch-routing.js';
import { migration036 } from './migrations/036-workgroup-id.js';

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
  db.close();
  return p;
}

function addWorkgroup(p: string, wgId: string, storeId: string): void {
  withDb(p, (db) => {
    db.prepare(
      `INSERT INTO workgroups (id, mnemon_store_id, created_at) VALUES (?, ?, '2026-01-01')`,
    ).run(wgId, storeId);
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
    db.prepare(`
      INSERT INTO messages_archive
        (id, agent_group_id, messaging_group_id, channel_type, thread_id, role,
         sender_id, sender_name, text, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')
    `).run(
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
    db.prepare(
      `INSERT OR IGNORE INTO workgroups (id, created_at) VALUES (?, '2026-01-01T00:00:00Z')`,
    ).run(wgId);
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
    addArchiveMsg(src, { id: 'm1-parent', agent_group_id: 'ag-parent', role: 'user', sender_id: 'u-123', text: 'hello', sent_at: '2026-01-01T10:00:00Z', thread_id: 'thread-1' });
    addArchiveMsg(src, { id: 'm1-codex', agent_group_id: 'ag-codex', role: 'user', sender_id: 'u-123', text: 'hello', sent_at: '2026-01-01T10:00:00Z', thread_id: 'thread-1' });

    // Two distinct assistant replies (different sender_id → different GROUP BY bucket → 2 rows)
    addArchiveMsg(src, { id: 'a1-parent', agent_group_id: 'ag-parent', role: 'assistant', sender_id: 'ag-parent', text: 'reply from parent', sent_at: '2026-01-01T10:01:00Z', thread_id: 'thread-1' });
    addArchiveMsg(src, { id: 'a1-codex', agent_group_id: 'ag-codex', role: 'assistant', sender_id: 'ag-codex', text: 'reply from codex', sent_at: '2026-01-01T10:01:00Z', thread_id: 'thread-1' });

    const dst = tmpPath('b3-dedup-dst');
    buildArchiveProjection(src, dst, 'ag-parent', ['ag-parent', 'ag-codex']);

    const rows = getAllArchiveRows(dst);
    const userRows = rows.filter((r) => r.role === 'user');
    const assistantRows = rows.filter((r) => r.role === 'assistant');

    expect(userRows).toHaveLength(1); // deduped
    expect(assistantRows).toHaveLength(2); // distinct sender_id → both survive
  });

  it('test_archive_standalone_workgroup_no_dedup_needed', () => {
    // Single agent, its own workgroup — no sibling rows → no dedup, just normal copy
    const src = makeArchiveSrc('b3-standalone-src');
    addWorkgroup(src, 'solo-wg', 'ag-solo');
    addAgentWithWorkgroup(src, 'ag-solo', 'solo', 'solo-wg');

    addArchiveMsg(src, { id: 'm1', agent_group_id: 'ag-solo', role: 'user', sender_id: 'u-1', text: 'hi', sent_at: '2026-01-01T10:00:00Z' });
    addArchiveMsg(src, { id: 'a1', agent_group_id: 'ag-solo', role: 'assistant', sender_id: 'ag-solo', text: 'hey', sent_at: '2026-01-01T10:01:00Z' });

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

    addArchiveMsg(src, { id: 'm-wg1', agent_group_id: 'ag-wg1', role: 'user', sender_id: 'u-1', text: 'msg from wg1', sent_at: '2026-01-01T10:00:00Z' });
    addArchiveMsg(src, { id: 'm-wg2', agent_group_id: 'ag-wg2', role: 'user', sender_id: 'u-2', text: 'msg from wg2', sent_at: '2026-01-01T10:00:00Z' });

    const dst = tmpPath('b3-iso-dst');
    buildArchiveProjection(src, dst, 'ag-wg1', ['ag-wg1']);

    const rows = getAllArchiveRows(dst);
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => (r.agent_group_id === 'ag-wg1'))).toBe(true);
  });

  it('test_archive_empty_workgroup_member_list_produces_empty_projection', () => {
    // W3 fail-closed responsibility moved to caller (container-runner spawn path) —
    // when caller passes an empty workgroup member set, projection contains zero rows.
    // Caller is expected to throw BEFORE calling if workgroup_id is invalid; this test
    // verifies the projection itself doesn't crash on the edge case.
    const src = makeArchiveSrc('b3-empty-wg-src');
    addArchiveMsg(src, { id: 'm1', agent_group_id: 'ag-some', role: 'user', sender_id: 'u', text: 'hi', sent_at: '2026-01-01T10:00:00Z' });

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
    addArchiveMsg(src, { id: 'aaa-lower', agent_group_id: 'ag-d1', role: 'user', sender_id: 'u-x', text: 'dup', sent_at: '2026-01-01T09:00:00Z' });
    addArchiveMsg(src, { id: 'zzz-higher', agent_group_id: 'ag-d2', role: 'user', sender_id: 'u-x', text: 'dup', sent_at: '2026-01-01T09:00:00Z' });

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
      db.prepare(
        `INSERT INTO ship_log (id, agent_group_id, title, shipped_at) VALUES (?, ?, ?, '2026-01-01')`,
      ).run('sl-a', 'ag-ship-a', 'Ship A');
      db.prepare(
        `INSERT INTO ship_log (id, agent_group_id, title, shipped_at) VALUES (?, ?, ?, '2026-01-01')`,
      ).run('sl-b', 'ag-ship-b', 'Ship B');
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
