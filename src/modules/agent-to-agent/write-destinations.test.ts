/**
 * `writeDestinations` projects the central `agent_destinations` ACL into a
 * session's `inbound.db`. The projection is REPLACE-shaped, so the set it
 * writes is the whole answer to "where may this agent send" — which makes the
 * moment the set is resolved load-bearing.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('write-destinations-test') }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
}));

// Models the ONE interleave that matters here: an admin revoking a destination
// inside the mailbox funnel's await, after the set has been resolved and before
// `replaceDestinationRows` overwrites the whole map. Same shape as
// `raceRevokes` in src/db/scheduled-tasks.test.ts. Inert unless a test arms it,
// so the rest of this file runs against the real session-manager.
const raceRevokes = vi.hoisted(() => ({ sessionId: null as string | null, localName: null as string | null }));

vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: async (agentGroupId: string, sessionId: string, action: never) => {
      if (raceRevokes.sessionId === sessionId) {
        const localName = raceRevokes.localName;
        raceRevokes.sessionId = null;
        raceRevokes.localName = null;
        const { getDb: centralDb } = await import('../../db/connection.js');
        centralDb()
          .prepare('DELETE FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?')
          .run(agentGroupId, localName);
      }
      return actual.withExistingMailboxSession(agentGroupId, sessionId, action);
    },
  };
});

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ensureSchema } from '../../db/session-db.js';
import { createDestination } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

const AGENT_GROUP_ID = 'ag-dest';
const SESSION_ID = 'sess-dest';

const now = () => new Date().toISOString();

function sessionDir(): string {
  return path.join(TEST_DIR, 'v2-sessions', AGENT_GROUP_ID, SESSION_ID);
}

function inboundPath(): string {
  return path.join(sessionDir(), 'inbound.db');
}

/** The projected rows the container actually resolves names against. */
function projectedNames(): string[] {
  const db = new Database(inboundPath(), { readonly: true });
  const rows = db.prepare('SELECT name FROM destinations ORDER BY name').all() as Array<{ name: string }>;
  db.close();
  return rows.map((r) => r.name);
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Dest Agent',
    folder: 'dest-agent',
    agent_provider: null,
    created_at: now(),
  });
  for (const [id, platformId, name] of [
    ['mg-keep', 'slack:C-KEEP', 'Keep'],
    ['mg-revoked', 'slack:C-REVOKED', 'Revoked'],
  ] as const) {
    createMessagingGroup({
      id,
      channel_type: 'slack',
      platform_id: platformId,
      name,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  }
  createDestination({
    agent_group_id: AGENT_GROUP_ID,
    local_name: 'keep',
    target_type: 'channel',
    target_id: 'mg-keep',
    created_at: now(),
  });
  createDestination({
    agent_group_id: AGENT_GROUP_ID,
    local_name: 'revoked',
    target_type: 'channel',
    target_id: 'mg-revoked',
    created_at: now(),
  });

  // The mailbox must already exist — `writeDestinations` is existing-only.
  fs.mkdirSync(sessionDir(), { recursive: true });
  ensureSchema(inboundPath(), 'inbound');
  ensureSchema(path.join(sessionDir(), 'outbound.db'), 'outbound');

  raceRevokes.sessionId = null;
  raceRevokes.localName = null;
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('writeDestinations', () => {
  it('projects every wired destination', async () => {
    await writeDestinations(AGENT_GROUP_ID, SESSION_ID);
    expect(projectedNames()).toEqual(['keep', 'revoked']);
  });

  /**
   * A destination revoked during the open must not be reinstated by the write.
   *
   * The set used to be resolved BEFORE the funnel, and the funnel yields. The
   * write is REPLACE-shaped, so a set resolved on entry does not merely miss
   * the revocation — it rewrites the whole map from the pre-revocation
   * snapshot, handing the running container back an ACL entry an admin just
   * took away. Resolving inside the callback (no yield between the resolve and
   * `replaceDestinationRows`) is what makes the projected set the set as of the
   * write.
   */
  it('drops a destination revoked inside the funnel instead of reinstating it', async () => {
    raceRevokes.sessionId = SESSION_ID;
    raceRevokes.localName = 'revoked';

    await writeDestinations(AGENT_GROUP_ID, SESSION_ID);

    // The revocation is real in the central DB...
    expect(
      getDb().prepare('SELECT local_name FROM agent_destinations WHERE agent_group_id = ?').all(AGENT_GROUP_ID),
    ).toEqual([{ local_name: 'keep' }]);
    // ...and the projection the container reads agrees with it. Resolved before
    // the funnel, this was ['keep', 'revoked'].
    expect(projectedNames()).toEqual(['keep']);
  });
});
