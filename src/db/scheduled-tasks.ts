/**
 * scheduleTask — public API for inserting recurring tasks into a session's
 * inbound.db. Resolves the active session by agent_group_id only (drops the
 * messaging-group filter that was historically hard-coded to Discord MG).
 * Tasks belong to the agent group, not a specific messaging surface.
 *
 * Idempotent via series_id: re-running with the same seriesId UPDATEs the
 * existing row's cron + processAfter + content rather than inserting a
 * duplicate.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../config.js';
import { createSession, findSessionByAgentGroup } from './sessions.js';
import { ensureSchema } from './session-db.js';
import { nextEvenSeq } from './session-db.js';

export interface TaskDef {
  id: string;
  agentGroupId: string;
  cron: string;
  processAfter: string;
  seriesId: string;
  prompt: string;
  tz?: string;
}

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initStubSessionFolder(dataDir: string, agentGroupId: string, sessionId: string): void {
  const dir = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const inboundPath = path.join(dir, 'inbound.db');
  ensureSchema(inboundPath, 'inbound');
  const outboundPath = path.join(dir, 'outbound.db');
  ensureSchema(outboundPath, 'outbound');
}

async function resolveActiveSession(
  agentGroupId: string,
  dataDir: string,
): Promise<{ id: string }> {
  const existing = findSessionByAgentGroup(agentGroupId);
  if (existing) return { id: existing.id };

  const sessionId = generateSessionId();
  createSession({
    id: sessionId,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initStubSessionFolder(dataDir, agentGroupId, sessionId);
  return { id: sessionId };
}

export async function scheduleTask(def: TaskDef, _dataDir?: string): Promise<void> {
  const dataDir = _dataDir ?? DATA_DIR;
  const session = await resolveActiveSession(def.agentGroupId, dataDir);
  const inboundDbPath = path.join(
    dataDir,
    'v2-sessions',
    def.agentGroupId,
    session.id,
    'inbound.db',
  );

  const db = new Database(inboundDbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  try {
    const content = JSON.stringify({ prompt: def.prompt });
    // Idempotency: active series (pending/paused) → UPDATE; terminal rows (completed/failed/cancelled)
    // are treated as absent so a fresh row is inserted, enabling re-scheduling after cancellation.
    const activeRow = db
      .prepare("SELECT id FROM messages_in WHERE series_id = ? AND status IN ('pending', 'paused')")
      .get(def.seriesId) as { id: string } | undefined;

    if (activeRow) {
      db.prepare(
        `UPDATE messages_in
            SET process_after = ?,
                recurrence    = ?,
                content       = ?,
                tries         = 0
          WHERE id = ?`,
      ).run(def.processAfter, def.cron, content, activeRow.id);
    } else {
      const seq = nextEvenSeq(db);
      db.prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, tries, process_after, recurrence, series_id, content)
         VALUES (?, ?, 'task', datetime('now'), 'pending', 0, ?, ?, ?, ?)`,
      ).run(def.id, seq, def.processAfter, def.cron, def.seriesId, content);
    }
  } finally {
    db.close();
  }
}
