/**
 * Repository-ingress fence: the per-session mirror of a publication fence.
 *
 * While a fence is active every inbound row is auto-tagged inert by the guard
 * triggers (`schema.ts`), so nothing wakes the container mid-publication;
 * release restores each tagged row's original trigger exactly once, keyed on
 * the exact [epoch, generation] pair. Internal to `src/modules/mailbox/`.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { migrateMessagesInTable } from '../schema.js';

export interface RepoIngressFence {
  epoch: string;
  generation: string;
  state: 'active' | 'released';
}

export function repoIngressFenceAckToken(fence: Pick<RepoIngressFence, 'epoch' | 'generation'>): string {
  return JSON.stringify([fence.epoch, fence.generation]);
}

export interface RepoIngressAdmissionResult {
  admittedRows: number;
  wakeRequired: boolean;
}

export interface RepoIngressReleaseResult extends RepoIngressAdmissionResult {
  released: boolean;
}

const REPOSITORY_MOUNT_BARRIER_ACK_KEY = 'repository_mount_barrier_ack';

/** Exact-epoch acknowledgement written by the container at a provider-idle poll boundary. */
export function readRepositoryMountBarrierAck(outDb: Database.Database): string | null {
  try {
    const row = outDb.prepare('SELECT value FROM session_state WHERE key = ?').get(REPOSITORY_MOUNT_BARRIER_ACK_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    // Missing/corrupt outbound state is never an acknowledgement.
    return null;
  }
}

export function readRepoIngressFence(db: Database.Database): RepoIngressFence | null {
  const row = db.prepare('SELECT epoch, generation, state FROM repo_ingress_fence WHERE id = 1').get() as
    | RepoIngressFence
    | undefined;
  return row ?? null;
}

/** Activate the per-session DB mirror of a publication fence. Idempotent for the same epoch. */
export function activateRepoIngressFence(db: Database.Database, epoch: string): RepoIngressFence {
  if (!epoch) throw new Error('repository ingress fence epoch must not be empty');
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (current?.state === 'active' && current.epoch !== epoch) {
      throw new Error(`repository ingress fence ${current.epoch} is already active`);
    }
    if (current?.state === 'active') return current;
    const generation = randomUUID();
    db.prepare(
      `INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, ?, ?, 'active')
       ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, generation = excluded.generation, state = 'active'`,
    ).run(epoch, generation);
    return { epoch, generation, state: 'active' as const };
  })();
}

function admitTaggedRows(db: Database.Database, epoch: string, messageId?: string): RepoIngressAdmissionResult {
  const idFilter = messageId === undefined ? '' : " AND (id = @messageId OR id = 'recall-' || @messageId)";
  const wakeRequired =
    (db
      .prepare(
        `SELECT 1 FROM messages_in
           WHERE repo_fence_epoch = @epoch
             AND repo_fence_original_trigger = 1
             AND status = 'pending'
             AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))${idFilter}
           LIMIT 1`,
      )
      .get({ epoch, messageId: messageId ?? null }) as { 1: number } | undefined) !== undefined;
  const result = db
    .prepare(
      `UPDATE messages_in
       SET trigger = repo_fence_original_trigger,
           repo_fence_epoch = NULL,
           repo_fence_original_trigger = NULL
       WHERE repo_fence_epoch = @epoch${idFilter}`,
    )
    .run({ epoch, messageId: messageId ?? null });
  return { admittedRows: result.changes, wakeRequired };
}

/**
 * Admit one logical inbound unit after a writer discovers its observed fence
 * epoch was already released or replaced. Replays are harmless.
 */
export function admitRepoIngressFenceMessage(
  db: Database.Database,
  epoch: string,
  messageId: string,
): RepoIngressAdmissionResult {
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (current?.state === 'active' && current.epoch === epoch) {
      return { admittedRows: 0, wakeRequired: false };
    }
    return admitTaggedRows(db, epoch, messageId);
  })();
}

/** Release a matching active epoch and restore every tagged row exactly once. */
export function releaseRepoIngressFence(
  db: Database.Database,
  epoch: string,
  generation: string,
): RepoIngressReleaseResult {
  migrateMessagesInTable(db);
  return db.transaction(() => {
    const current = readRepoIngressFence(db);
    if (!current || current.epoch !== epoch || current.generation !== generation || current.state !== 'active') {
      return { released: false, admittedRows: 0, wakeRequired: false };
    }
    db.prepare(
      "UPDATE repo_ingress_fence SET state = 'released' WHERE id = 1 AND epoch = ? AND generation = ? AND state = 'active'",
    ).run(epoch, generation);
    const admitted = admitTaggedRows(db, epoch);
    return { released: true, ...admitted };
  })();
}
