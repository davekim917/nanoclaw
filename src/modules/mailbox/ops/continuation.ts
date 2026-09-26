/**
 * Durable work-continuation state, stored by the runner in outbound
 * `session_state` and read (and, for recovery admission, written) by the host.
 *
 * Moved verbatim out of `src/host-sweep.ts` for the mailbox seam
 * (docs/specs/upstream-mailbox-seam/plan.md §4.4, "Sweep / container state"):
 * the SQL belongs to the module that owns the session DBs, the throttle and
 * cap policy stays in the sweep. Internal to `src/modules/mailbox/`.
 *
 * This file is the ONE host-side implementation of the continuation record —
 * its type, its size cap and its parser (invariant I-2). `ops/session-state.ts`
 * owns the neighbouring keys (raw presence, force-clear, done proposal) and
 * imports the record from here rather than parsing it a second time.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { parseSqliteUtc } from '../sqlite-utc.js';

/** Hard cap on automatic resume attempts for one continuation record. */
export const WORK_CONTINUATION_RESUME_MAX_ATTEMPTS = 2;

/** Longest task string a continuation record may carry before it is treated as absent. */
export const WORK_CONTINUATION_TASK_MAX_CHARS = 500;

export interface HostWorkContinuation {
  id: string;
  task: string;
  source_message_id?: string;
  phase: 'queued' | 'running';
  chain: number;
  runner_id?: string;
  resume_attempts: number;
  recovery_episode: number;
}

/**
 * Is a `work_continuation` row present at all?
 *
 * Deliberately NOT `readWorkContinuation() !== null`: that one validates the
 * record and answers null for a malformed one. The reclaim/GC gate wants the
 * conservative question — anything written there is work someone promised —
 * so a record this module would reject still retains the session's storage.
 */
export function hasWorkContinuationRow(outDb: Database.Database): boolean {
  return outDb.prepare("SELECT 1 FROM session_state WHERE key = 'work_continuation'").get() !== undefined;
}

export function canAttemptContinuationRecovery(continuation: HostWorkContinuation): boolean {
  return continuation.resume_attempts < WORK_CONTINUATION_RESUME_MAX_ATTEMPTS;
}

/**
 * A capped record a runner already claimed. No runner picks up a queued record
 * that carries a `runner_id`, and the host authorizes no attempt past the cap,
 * so only real inbound — which arrives as a due row — can re-arm it. Holding a
 * container open for it waits out the absolute ceiling for nothing.
 */
export function isContinuationParked(continuation: HostWorkContinuation): boolean {
  return (
    continuation.phase === 'queued' &&
    continuation.runner_id !== undefined &&
    !canAttemptContinuationRecovery(continuation)
  );
}

export function readWorkContinuation(outDb: Database.Database): HostWorkContinuation | null {
  try {
    const row = outDb.prepare("SELECT value FROM session_state WHERE key = 'work_continuation'").get() as
      | { value: string }
      | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<HostWorkContinuation>;
      if (
        typeof parsed.id !== 'string' ||
        parsed.id === '' ||
        typeof parsed.task !== 'string' ||
        parsed.task.trim() === '' ||
        parsed.task.length > WORK_CONTINUATION_TASK_MAX_CHARS ||
        (parsed.phase !== 'queued' && parsed.phase !== 'running') ||
        !Number.isSafeInteger(parsed.chain) ||
        (parsed.chain ?? -1) < 0 ||
        !Number.isSafeInteger(parsed.resume_attempts) ||
        (parsed.resume_attempts ?? -1) < 0 ||
        (parsed.recovery_episode !== undefined &&
          (!Number.isSafeInteger(parsed.recovery_episode) || parsed.recovery_episode < 0)) ||
        (parsed.runner_id !== undefined && (typeof parsed.runner_id !== 'string' || parsed.runner_id === ''))
      ) {
        return null;
      }
      return {
        id: parsed.id,
        task: parsed.task.trim(),
        ...(typeof parsed.source_message_id === 'string' &&
        parsed.source_message_id.length > 0 &&
        parsed.source_message_id.length <= 1024
          ? { source_message_id: parsed.source_message_id }
          : {}),
        phase: parsed.phase,
        chain: parsed.chain as number,
        ...(parsed.runner_id ? { runner_id: parsed.runner_id } : {}),
        resume_attempts: parsed.resume_attempts as number,
        recovery_episode: parsed.recovery_episode ?? 0,
      };
    }

    // Rollout compatibility: the fresh runner owns migration/deletion because
    // the host normally opens outbound.db read-only. A valid legacy promise is
    // sufficient to wake once; the runner converts it before executing.
    const legacy = outDb.prepare("SELECT value FROM session_state WHERE key = 'pending_next'").get() as
      | { value: string }
      | undefined;
    if (!legacy) return null;
    const parsed = JSON.parse(legacy.value) as { task?: unknown; chain?: unknown };
    if (
      typeof parsed.task !== 'string' ||
      parsed.task.trim() === '' ||
      parsed.task.length > WORK_CONTINUATION_TASK_MAX_CHARS
    ) {
      return null;
    }
    return {
      id: 'legacy-pending-next',
      task: parsed.task.trim(),
      phase: 'queued',
      chain: Number.isSafeInteger(parsed.chain) && (parsed.chain as number) >= 0 ? (parsed.chain as number) : 0,
      resume_attempts: 0,
      recovery_episode: 0,
    };
  } catch {
    return null;
  }
}

/**
 * Durable throttle timestamp for an already-attempted recovery. The active
 * container registry is cleared on exit, but session_state survives the
 * crash, so a fast-failing replacement cannot be respawned every sweep tick.
 */
export function readContinuationRecoveryAttemptAt(
  outDb: Database.Database,
  continuation: HostWorkContinuation,
): number {
  if (continuation.id === 'legacy-pending-next' || continuation.resume_attempts === 0) return 0;
  try {
    const row = outDb.prepare("SELECT updated_at FROM session_state WHERE key = 'work_continuation'").get() as
      | { updated_at: string }
      | undefined;
    if (!row) return 0;
    const parsed = parseSqliteUtc(row.updated_at);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function incrementWorkContinuationResumeAttempt(
  outDb: Database.Database,
  expectedId: string,
): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const current = readWorkContinuation(outDb);
    if (
      !current ||
      current.id !== expectedId ||
      current.id === 'legacy-pending-next' ||
      current.resume_attempts >= WORK_CONTINUATION_RESUME_MAX_ATTEMPTS
    ) {
      return null;
    }
    // The stopped-container host is authorizing one fresh runner to consume
    // this recovery attempt. Clear the prior runner claim so the container can
    // distinguish this authorized start from a capped attempt that has already
    // run and is merely hitchhiking on an unrelated wake.
    const updated: HostWorkContinuation = {
      ...current,
      phase: 'queued',
      resume_attempts: current.resume_attempts + 1,
    };
    delete updated.runner_id;
    outDb
      .prepare("UPDATE session_state SET value = ?, updated_at = ? WHERE key = 'work_continuation'")
      .run(JSON.stringify(updated), new Date().toISOString());
    return updated;
  })();
}

export function migrateLegacyWorkContinuationForRecovery(outDb: Database.Database): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const legacy = readWorkContinuation(outDb);
    if (!legacy || legacy.id !== 'legacy-pending-next') return null;
    const migrated: HostWorkContinuation = {
      ...legacy,
      id: randomUUID(),
      resume_attempts: 1,
    };
    outDb
      .prepare(
        `INSERT INTO session_state (key, value, updated_at) VALUES ('work_continuation', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(migrated), new Date().toISOString());
    outDb.prepare("DELETE FROM session_state WHERE key = 'pending_next'").run();
    return migrated;
  })();
}

export function restoreWorkContinuationResumeAttempt(
  outDb: Database.Database,
  attempted: HostWorkContinuation,
  previous: HostWorkContinuation,
): HostWorkContinuation | null {
  return outDb.transaction(() => {
    const current = readWorkContinuation(outDb);
    if (
      !current ||
      current.id !== attempted.id ||
      current.resume_attempts !== attempted.resume_attempts ||
      previous.resume_attempts !== attempted.resume_attempts - 1
    ) {
      return null;
    }
    if (previous.id === 'legacy-pending-next') {
      outDb.prepare("DELETE FROM session_state WHERE key = 'work_continuation'").run();
      outDb
        .prepare(
          `INSERT INTO session_state (key, value, updated_at) VALUES ('pending_next', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(JSON.stringify({ task: previous.task, chain: previous.chain }), new Date().toISOString());
      return previous;
    }
    const restored = { ...previous };
    outDb
      .prepare("UPDATE session_state SET value = ?, updated_at = ? WHERE key = 'work_continuation'")
      .run(JSON.stringify(restored), new Date().toISOString());
    return restored;
  })();
}
