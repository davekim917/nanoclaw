/**
 * Shared seeding for the session-claim suites (seam 4 series A′ and E):
 * `src/session-claim-spawn.test.ts`, `src/container-adoption.test.ts` and
 * `src/container-supervision-channel.test.ts`.
 *
 * Every suite runs the REAL coordination accessors over a real, fully migrated
 * SQLite central DB under its own per-process fixture root — the CAS and the
 * scoped release are the behavior under test, and a hand-rolled in-memory
 * claim store would prove only that the suite agrees with itself. The mocks
 * (log, container runtime, admission, OneCLI) stay in each test file: vitest
 * hoists `vi.mock` per file and nothing here may name the raw central handle
 * (src/db/raw-db-ratchet.test.ts) or the logger (src/log-mock-tripwire.test.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect } from 'vitest';

import { getDb, initDb } from '../db/connection.js';
import { runMigrations } from '../db/index.js';
import { getAgentMailbox } from '../mailbox/index.js';
import type { Session } from '../types.js';

export const CLAIM_HARNESS_STAMP = '2026-09-05T00:00:00.000Z';
export const CLAIM_HARNESS_AGENT_GROUP_ID = 'ag-session-claim';
// Deliberately a folder that does not exist under groups/: readContainerConfig
// returns the empty config for it, so the spawn path runs end to end with no
// disk fixture — the same lever src/container-runner.test.ts pulls.
export const CLAIM_HARNESS_AGENT_GROUP_FOLDER = '__session-claim-test__';

/**
 * A real, fully migrated central DB on disk rather than a hand-rolled subset:
 * the spawn path reads a dozen tables before it reaches the claim, and a
 * partial schema turns a missing table into a spawn refusal that looks exactly
 * like the refusals the cases assert. Migrated through a throwaway handle so
 * no suite names the raw central handle.
 */
export async function openClaimHarnessDb(dataDir: string, groupsDir: string): Promise<void> {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(groupsDir, CLAIM_HARNESS_AGENT_GROUP_FOLDER), { recursive: true });
  const dbPath = path.join(dataDir, `central-${crypto.randomUUID()}.db`);
  const seed = new BetterSqlite3(dbPath);
  runMigrations(seed);
  seed.close();
  await initDb(dbPath, { role: 'test' });
  await getDb().run(
    "INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-session-claim', 'session claim', ?)",
    CLAIM_HARNESS_STAMP,
  );
  await getDb().run(
    'INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
    CLAIM_HARNESS_AGENT_GROUP_ID,
    'session claim',
    CLAIM_HARNESS_AGENT_GROUP_FOLDER,
    'wg-session-claim',
    CLAIM_HARNESS_STAMP,
  );
}

/**
 * `thread_id` is the session id, never null. `idx_sessions_active_triple` is
 * unique over (agent_group_id, messaging_group_id, thread_id), so two active
 * sessions of one group with null thread ids collide — which is exactly what a
 * case seeding two sessions needs to avoid.
 */
export async function seedSession(
  dataDir: string,
  id: string,
  options: { status?: 'active' | 'closed' | 'archiving'; archivedAt?: string | null } = {},
): Promise<void> {
  // A real inbound/outbound mailbox under the temp DATA_DIR: the spawn path
  // refuses a session it cannot prove a mailbox for, and that refusal sits
  // above the claim.
  fs.mkdirSync(path.join(dataDir, 'v2-sessions', CLAIM_HARNESS_AGENT_GROUP_ID, id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId: CLAIM_HARNESS_AGENT_GROUP_ID, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at, archived_at)
     VALUES (?, ?, NULL, ?, NULL, ?, 'stopped', NULL, ?, ?)`,
    id,
    CLAIM_HARNESS_AGENT_GROUP_ID,
    id,
    options.status ?? 'active',
    CLAIM_HARNESS_STAMP,
    options.archivedAt ?? null,
  );
}

export function callerSnapshot(id: string): Session {
  return {
    id,
    agent_group_id: CLAIM_HARNESS_AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: CLAIM_HARNESS_STAMP,
  };
}

/** A `session_claims` row held by someone else, at the given incarnation. */
export async function seedForeignClaim(sessionId: string, holder: string, incarnation: number): Promise<void> {
  await getDb().run(
    `INSERT INTO session_claims (session_id, incarnation, claimed_by, claimed_at, container_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId,
    incarnation,
    holder,
    CLAIM_HARNESS_STAMP,
    `nanoclaw-v2-${holder}`,
    CLAIM_HARNESS_STAMP,
  );
}

/**
 * A `host_instances` row for a peer. `lease`: 'live' is an unexpired lease,
 * 'expired' is a host that crashed without stamping `stopped_at`, and 'stopped'
 * is one that shut down gracefully. Only the first reads as live.
 */
export async function seedHostInstance(instanceId: string, lease: 'live' | 'expired' | 'stopped'): Promise<void> {
  await getDb().run(
    `INSERT INTO host_instances (instance_id, install_id, hostname, pid, started_at, lease_expires_at, stopped_at)
     VALUES (?, 'test-install', 'peer', 4242, ?, ?, ?)`,
    instanceId,
    CLAIM_HARNESS_STAMP,
    lease === 'expired' ? CLAIM_HARNESS_STAMP : new Date(Date.now() + 90_000).toISOString(),
    lease === 'stopped' ? new Date().toISOString() : null,
  );
}

/** The `sessions.container_status` column, which is what `markContainerRunning`/`markContainerStopped` write. */
export async function containerStatusOf(sessionId: string): Promise<string | undefined> {
  const row = await getDb().get<{ container_status: string }>(
    'SELECT container_status FROM sessions WHERE id = ?',
    sessionId,
  );
  return row?.container_status;
}

/**
 * Budget for every wait. Deliberately generous and expressed as a DEADLINE
 * rather than a poll count: these are real timers over a real spawn prelude,
 * and under a loaded full-suite run that prelude takes seconds. A genuine hang
 * still fails, just later and with the same message.
 */
export const WAIT_BUDGET_MS = 30_000;

export async function until(done: () => boolean, describeFailure: string): Promise<void> {
  const deadline = Date.now() + WAIT_BUDGET_MS;
  while (!done() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(done(), describeFailure).toBe(true);
}
