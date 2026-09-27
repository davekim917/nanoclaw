/**
 * Both duties keep the identical `scheduled-move-recovery: sweep hook failed`
 * warn string so one log search finds every failure.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { withCentralSync } from '../../db/central-lease.js';
import { taskThreadId, withQuietInvalidationSync } from '../../db/sessions.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { readSessionInbound } from '../mailbox/index.js';
import { type TaskRowSnapshot } from '../scheduling/db.js';
import { countLiveRowsInSessions } from '../scheduling/live-count.js';
import { purgeIntentBody } from '../../dashboard/api/scheduled-shared.js';
import {
  registerSweepDuty,
  registerSweepDutySource,
  SWEEP_DUTY_INVENTORY,
  SWEEP_INTERVAL_MS,
} from '../../host-sweep.js';

const id = SWEEP_DUTY_INVENTORY;

interface MoveRecoveryOptions {
  nowMs?: number;
}

type MoveIntentSnapshot = TaskRowSnapshot;

/**
 * Every target per-series session, including closed ones: a move writes into
 * `taskSeriesId(seriesId)`, and a completed target may have closed while its
 * row stays durable. A DB failure is UNKNOWN, not "no target": defer.
 */
async function resolveTargetSessions(
  targetAgentGroupId: string,
  seriesId: string,
): Promise<{ sessions: Array<{ agentGroupId: string; sessionId: string; status: string }>; unreadable: boolean }> {
  try {
    const sessions = await getDb().all<{ id: string; status: string }>(
      `SELECT id, status FROM sessions
        WHERE agent_group_id = ? AND messaging_group_id IS NULL AND thread_id = ?
        ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
      targetAgentGroupId,
      taskThreadId(seriesId),
    );
    return {
      sessions: sessions.map((session) => ({
        agentGroupId: targetAgentGroupId,
        sessionId: session.id,
        status: session.status,
      })),
      unreadable: false,
    };
  } catch {
    return { sessions: [], unreadable: true };
  }
}

/** SQLite's "no such table" — the feature is not installed, not a failure. */
function isMissingTable(err: unknown): boolean {
  return err instanceof Error && /no such table/i.test(err.message);
}

interface ParsedIntentDetail {
  snapshot: MoveIntentSnapshot | null;
  targetAgentGroupId: string | null;
  targetMessagingGroupId: string | null;
  targetRowId: string | null;
  sourceCancellationReceiptId: string | null;
}

function parseIntentDetail(detailJson: string | null): ParsedIntentDetail {
  if (!detailJson) {
    return {
      snapshot: null,
      targetAgentGroupId: null,
      targetMessagingGroupId: null,
      targetRowId: null,
      sourceCancellationReceiptId: null,
    };
  }
  try {
    const d = JSON.parse(detailJson) as {
      snapshot?: MoveIntentSnapshot;
      targetAgentGroupId?: string;
      targetMessagingGroupId?: string;
      targetRowId?: string;
      sourceCancellationReceiptId?: string;
    };
    return {
      snapshot: d.snapshot ?? null,
      targetAgentGroupId: typeof d.targetAgentGroupId === 'string' ? d.targetAgentGroupId : null,
      targetMessagingGroupId: typeof d.targetMessagingGroupId === 'string' ? d.targetMessagingGroupId : null,
      targetRowId: typeof d.targetRowId === 'string' ? d.targetRowId : null,
      sourceCancellationReceiptId:
        typeof d.sourceCancellationReceiptId === 'string' ? d.sourceCancellationReceiptId : null,
    };
  } catch {
    return {
      snapshot: null,
      targetAgentGroupId: null,
      targetMessagingGroupId: null,
      targetRowId: null,
      sourceCancellationReceiptId: null,
    };
  }
}

/** Did this exact move, rather than an overlapping request, cancel the source? */
function sourceOwnsCancellation(
  dataDir: string,
  source: { agentGroupId: string; sessionId: string },
  receiptId: string,
): { owned: boolean; unreadable: boolean } {
  try {
    const owned = readSessionInbound({ ...source, dataDir }, (mailbox) =>
      mailbox.hasMoveCancellationReceipt(receiptId),
    );
    return { owned: owned ?? false, unreadable: false };
  } catch {
    return { owned: false, unreadable: true };
  }
}

/** Does any target task session contain the exact row this move reserved before cancel? */
function targetOwnsIntent(
  dataDir: string,
  targets: Array<{ agentGroupId: string; sessionId: string }>,
  targetRowId: string,
  seriesId: string,
): { owned: boolean; unreadable: boolean } {
  let unreadable = false;
  for (const target of targets) {
    try {
      const row = readSessionInbound({ ...target, dataDir }, (mailbox) => mailbox.getTaskRowById(targetRowId));
      // Bind the id to the series too, so an id collision cannot suppress a
      // repair for another series.
      if (row?.series_id === seriesId) return { owned: true, unreadable: false };
    } catch {
      unreadable = true;
    }
  }
  return { owned: false, unreadable };
}

/**
 * Consume unresolved `move_intent` rows older than one sweep interval. The live
 * count is scoped to exactly {source, target}, never a bare series_id scan
 * another group could satisfy. Any live row means the move resolved itself
 * (stamp, never restore: that would double it); a readable ZERO means restore
 * from the snapshot, re-checked immediately before insert. An UNREADABLE count
 * is unknown: skip this pass, never restore. An intent that can never be
 * restored is stamped resolved rather than left as an unclearable repair row.
 */
export async function recoverMoveIntents(options: MoveRecoveryOptions): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  // One sessions root, always the real one: an injectable root split reads
  // and writes across different trees.
  const dataDir = path.dirname(sessionsBaseDir());
  const sessionsRoot = sessionsBaseDir();

  let intents: Array<{
    session_id: string;
    agent_group_id: string;
    series_id: string;
    detail_json: string | null;
    correlation_id: string | null;
    ts: string;
  }>;
  try {
    intents = await getDb().all<(typeof intents)[number]>(
      `SELECT session_id, agent_group_id, series_id, detail_json, correlation_id, ts
           FROM scheduled_audit
          WHERE action = 'move_intent' AND resolved_at IS NULL`,
    );
  } catch (err) {
    // Only a missing table (feature not installed) means nothing to recover.
    if (isMissingTable(err)) return;
    throw err;
  }

  for (const intent of intents) {
    const tsMs = parseSqliteUtc(intent.ts);
    // Younger intents are likely still executing.
    if (Number.isNaN(tsMs) || nowMs - tsMs <= SWEEP_INTERVAL_MS) continue;
    if (!intent.correlation_id) continue;

    const detail = parseIntentDetail(intent.detail_json);
    const source = { agentGroupId: intent.agent_group_id, sessionId: intent.session_id };
    const targetResolution = detail.targetAgentGroupId
      ? await resolveTargetSessions(detail.targetAgentGroupId, intent.series_id)
      : { sessions: [], unreadable: false };
    if (targetResolution.unreadable) {
      log.warn('scheduled-move-recovery: target session lookup unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    // Legacy intents can only count a live target row, which only an active
    // session can hold.
    const target = targetResolution.sessions.find((session) => session.status === 'active') ?? null;

    // A receipt-bearing intent compensates only a source cancellation it can
    // prove it performed; without the receipt an overlapping move may have won.
    // Pre-receipt intents keep the legacy policy so an upgrade can't strand a source.
    const sourceCancellation = detail.sourceCancellationReceiptId
      ? sourceOwnsCancellation(dataDir, source, detail.sourceCancellationReceiptId)
      : null;
    if (sourceCancellation?.unreadable) {
      log.warn('scheduled-move-recovery: source cancellation receipt unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    if (detail.sourceCancellationReceiptId && !sourceCancellation?.owned) {
      await purgeIntentBody(intent.correlation_id);
      continue;
    }

    // A same-series target row does not prove the move landed (a colliding
    // manual run could have made it); only the reserved row id does.
    const ownedTarget = detail.targetRowId
      ? targetOwnsIntent(dataDir, targetResolution.sessions, detail.targetRowId, intent.series_id)
      : null;
    if (ownedTarget?.unreadable) {
      log.warn('scheduled-move-recovery: target ownership unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    const sourceLive = countLiveRowsInSessions(dataDir, [source], intent.series_id);
    if (sourceLive.unreadable) {
      log.warn('scheduled-move-recovery: source live count unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    if (detail.targetRowId) {
      if (sourceLive.count > 0 || ownedTarget?.owned) {
        await purgeIntentBody(intent.correlation_id);
        continue;
      }
      // No owned target: compensate even if another same-series target row
      // exists; it is not ours, and must not turn a rejected move into source loss.
    } else {
      // Legacy intent: no target row id, so only the conservative rule is safe.
      const live = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
      if (live.unreadable) {
        log.warn('scheduled-move-recovery: scoped live count unreadable — deferring', {
          seriesId: intent.series_id,
          correlationId: intent.correlation_id,
        });
        continue;
      }
      if (live.count > 0) {
        if (live.count > 1) {
          log.warn('scheduled-move-recovery: >1 live row for legacy series — resolving without dedup', {
            seriesId: intent.series_id,
            correlationId: intent.correlation_id,
            liveCount: live.count,
          });
        }
        await purgeIntentBody(intent.correlation_id);
        continue;
      }
    }

    if (!detail.snapshot) {
      // Body lost: unrecoverable. Resolve so it doesn't surface forever.
      log.warn('scheduled-move-recovery: unresolved intent with no snapshot — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      await purgeIntentBody(intent.correlation_id);
      continue;
    }

    const inboundPath = path.join(sessionsRoot, intent.agent_group_id, intent.session_id, 'inbound.db');
    if (!fs.existsSync(inboundPath)) {
      // Source session gone: unrecoverable. Resolve.
      log.warn('scheduled-move-recovery: source inbound.db missing — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      await purgeIntentBody(intent.correlation_id);
      continue;
    }
    const snapshot = detail.snapshot;
    let outcome: 'restored' | 'deferred' | undefined;
    try {
      // Existing-only: recovery must never re-provision a session it was told is gone.
      outcome = await withExistingMailboxSession(intent.agent_group_id, intent.session_id, (mailbox) =>
        withCentralSync(() => {
          // Idempotency re-check. Legacy intents have no ownership record, so they
          // use the scoped count.
          const sourceRecheck = countLiveRowsInSessions(dataDir, [source], intent.series_id);
          if (sourceRecheck.unreadable || sourceRecheck.count > 0) return 'deferred' as const;
          if (
            detail.sourceCancellationReceiptId &&
            !mailbox.hasMoveCancellationReceipt(detail.sourceCancellationReceiptId)
          ) {
            return 'deferred' as const;
          }
          if (detail.targetRowId) {
            const ownership = targetOwnsIntent(
              dataDir,
              targetResolution.sessions,
              detail.targetRowId,
              intent.series_id,
            );
            if (ownership.unreadable || ownership.owned) return 'deferred' as const;
          } else {
            const legacyRecheck = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
            if (legacyRecheck.unreadable || legacyRecheck.count > 0) return 'deferred' as const;
          }
          {
            // The fan-out may have just marked this source quiet (it had no live
            // task), which would hide the restored due row, even across restart.
            // Invalidate BEFORE the restore: the two DBs share no transaction, and
            // the reverse order can leave a restored row hidden behind a persisted
            // mark. FAIL-CLOSED: the invalidation throws on error or an inactive
            // session, leaving the intent unresolved for the next pass.
            withQuietInvalidationSync(intent.session_id, () =>
              mailbox.restoreTaskRow({
                // Fresh id — the cancelled source row may still hold the snapshot id.
                id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                series_id: snapshot.series_id,
                status: snapshot.status,
                process_after: snapshot.process_after,
                // Optional: older intents lack it; restoreTaskRow falls back.
                scheduled_for: snapshot.scheduled_for,
                recurrence: snapshot.recurrence,
                content: snapshot.content,
                platform_id: snapshot.platform_id,
                channel_type: snapshot.channel_type,
                thread_id: snapshot.thread_id,
                kind: snapshot.kind,
              }),
            );
          }
          return 'restored' as const;
        }, 'scheduled-move recovery restore'),
      );
    } catch (err) {
      log.error('scheduled-move-recovery: restore failed', {
        seriesId: intent.series_id,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (outcome === undefined) {
      // The mailbox vanished between the existsSync and the open.
      log.error('scheduled-move-recovery: restore failed', {
        seriesId: intent.series_id,
        err: 'source inbound mailbox vanished before the restore',
      });
      continue;
    }
    if (outcome === 'deferred') {
      log.warn('scheduled-move-recovery: re-check unreadable — deferring restore', {
        seriesId: intent.series_id,
      });
      continue;
    }
    // Stamp AFTER the restore: a crash before this re-evaluates next pass,
    // finds a live row, and stamps without re-restoring.
    await purgeIntentBody(intent.correlation_id);
  }
}

const AUDIT_BODY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * NULLs only the preview/detail body columns past 90 days; the action-metadata
 * row stays for the series' lifetime (cancel-vs-completed depends on it).
 */
export async function pruneAuditBodies(options: { nowMs?: number }): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - AUDIT_BODY_RETENTION_MS).toISOString();
  try {
    await getDb().run(
      `UPDATE scheduled_audit
          SET before_preview = NULL, after_preview = NULL, detail_json = NULL
        WHERE ts < ?
          AND (before_preview IS NOT NULL OR after_preview IS NOT NULL OR detail_json IS NOT NULL)`,
      cutoff,
    );
  } catch (err) {
    // Table absent — nothing to prune. Anything else surfaces.
    if (!isMissingTable(err)) throw err;
  }
}

export function registerScheduledMoveSweepDuties(): void {
  registerSweepDuty({
    name: id.T11,
    phase: 'tick:housekeeping',
    order: 50,
    run: async () => {
      try {
        await recoverMoveIntents({});
      } catch (err) {
        log.warn('scheduled-move-recovery: sweep hook failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.T12,
    phase: 'tick:housekeeping',
    order: 60,
    run: async () => {
      try {
        await pruneAuditBodies({});
      } catch (err) {
        log.warn('scheduled-move-recovery: sweep hook failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-scheduled-move', registerScheduledMoveSweepDuties);
