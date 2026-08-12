/**
 * Regression cover for `findAnySessionForMessagingGroup`.
 *
 * Claims escalation asked for a CHANNEL-ROOT session as its delivery pipe
 * (`findSession(mg, null)`), but every channel in this fleet runs a per-thread
 * session policy, so no root session exists and the lookup returned undefined
 * on every tick — a full day of "no live session for escalation channel"
 * warnings and zero escalations delivered. The escalation unit tests never
 * caught it because they inject `resolveSession`; the defect lived in the
 * default dependency, so the cover has to sit on the lookup itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, getDb } from './connection.js';
import { findAnySessionForMessagingGroup, findSession } from './sessions.js';

const MG = 'mg-dispatch';

function setup(): void {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL,
      messaging_group_id TEXT, thread_id TEXT, agent_provider TEXT,
      status TEXT DEFAULT 'active', container_status TEXT DEFAULT 'stopped',
      last_active TEXT, created_at TEXT NOT NULL
    );
  `);
}

function addSession(id: string, threadId: string | null, createdAt: string, status = 'active'): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
       VALUES (?, 'ag-1', ?, ?, ?, ?)`,
    )
    .run(id, MG, threadId, status, createdAt);
}

describe('findAnySessionForMessagingGroup', () => {
  beforeEach(setup);
  afterEach(() => closeDb());

  it('returns a thread session when the channel has no root session', () => {
    addSession('sess-thread-a', 'slack:C1:111.1', '2026-08-11T10:00:00Z');
    addSession('sess-thread-b', 'slack:C1:222.2', '2026-08-11T12:00:00Z');

    // The old lookup — this is the exact call that silently failed all day.
    expect(findSession(MG, null)).toBeUndefined();

    expect(findAnySessionForMessagingGroup(MG)?.id).toBe('sess-thread-b');
  });

  it('prefers the channel-root session when one exists, even if older', () => {
    addSession('sess-root', null, '2026-08-11T09:00:00Z');
    addSession('sess-thread', 'slack:C1:333.3', '2026-08-11T23:00:00Z');

    expect(findAnySessionForMessagingGroup(MG)?.id).toBe('sess-root');
  });

  it('ignores non-active sessions', () => {
    addSession('sess-dead', 'slack:C1:444.4', '2026-08-11T23:00:00Z', 'archived');
    addSession('sess-live', 'slack:C1:555.5', '2026-08-11T10:00:00Z');

    expect(findAnySessionForMessagingGroup(MG)?.id).toBe('sess-live');
  });

  it('never returns a system session', () => {
    // System sessions have no channel a human reads; delivering there would
    // drop the escalation on the floor just as silently as the original bug.
    addSession('sess-system', 'system:health-sentinel', '2026-08-11T23:00:00Z');
    addSession('sess-real', 'slack:C1:666.6', '2026-08-11T10:00:00Z');

    expect(findAnySessionForMessagingGroup(MG)?.id).toBe('sess-real');
  });

  it('returns undefined when the channel has no sessions at all', () => {
    expect(findAnySessionForMessagingGroup(MG)).toBeUndefined();
  });
});
