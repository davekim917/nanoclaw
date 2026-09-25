/**
 * Sweep family: scheduled-move recovery. Registers T11
 * (scheduled-move-recovery) and T12 (audit-body-prune) on `tick:housekeeping` at order 50/60 — order-free housekeeping work, run
 * every tick with no session fan-out.
 *
 * The two duties are independently guarded registrations that KEEP the identical
 * `scheduled-move-recovery: sweep hook failed` warn string on both, so a log
 * search for that string still finds every failure it used to.
 */
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { withCentralSync } from '../../db/central-lease.js';
import { taskThreadId, withQuietInvalidationSync } from '../../db/sessions.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';
// Move recovery resolves its source session through the seam, like every other
// host caller. The raw-opener exemption this module used to carry existed for
// an INJECTED sessions root, but no production caller ever injects one — the
// sweep's only call site passes `{}` — so it protected test scaffolding rather
// than behaviour, and it is gone.
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

// ─── Scheduled-move recovery + audit-body prune (D3 / D4) ─────────────────────

interface MoveRecoveryOptions {
  nowMs?: number;
}

// TaskRowSnapshot fields, parsed from the intent's detail_json (A-1: a type
// alias, not an empty-extends interface — clears the lone no-empty-interface lint).
type MoveIntentSnapshot = TaskRowSnapshot;

/**
 * Resolve every target per-series system session, including closed sessions.
 * `scheduleTask` writes a move into `taskSeriesId(seriesId)`, not the
 * channel-root session — checking the latter after a crash can mistake a
 * successful target insert for zero live rows and restore the source on top of
 * it. A completed target occurrence can have closed before recovery while its
 * exact row remains durable, so active-only `findSystemSession()` is too weak
 * for ownership proof. A database failure is UNKNOWN, not "no target":
 * recovery must defer rather than compensate blindly.
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
      // The generated id is the durable ownership token, but bind it to the
      // intent's series too: an impossible id collision must not suppress a
      // source repair for another series.
      if (row?.series_id === seriesId) return { owned: true, unreadable: false };
    } catch {
      unreadable = true;
    }
  }
  return { owned: false, unreadable };
}

/**
 * Consume unresolved `move_intent` rows older than one sweep interval (D3).
 *
 * SCOPED predicate (M1): the live-row count is taken over EXACTLY {source
 * session, target session} — never a bare-series_id fleet scan that an unrelated
 * group reusing the same series_id could falsely satisfy. A crash BEFORE the
 * move's cancel leaves the SOURCE live; a crash after a successful target insert
 * leaves the TARGET live. If either holds a live row → stamp + purge (the move
 * resolved itself), never restore (would double the live rows). If the scoped
 * count is a readable ZERO → restore the source from the snapshot, re-checking
 * zero-live immediately before the insert (idempotent compensation, M10).
 *
 * FAIL-SAFE (F6 / M2): if the scoped count is UNREADABLE, the live state is
 * UNKNOWN — skip this intent this pass (leave it unresolved for a clean later
 * pass), NEVER restore on unknown.
 *
 * ADV-S2: an intent that can NEVER be restored (no snapshot body, or the source
 * inbound.db is gone) is RESOLVED (resolved_at stamped) rather than surfacing
 * forever as an unclearable 'stalled' repair row.
 *
 * Autonomous, not just observable. Additive — no firing-path change (C1).
 */
export async function recoverMoveIntents(options: MoveRecoveryOptions): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  // ONE sessions root, always the real one. `dataDir` used to be injectable and
  // no production caller ever injected it — the sweep's only call site passes
  // `{}`. Worse, once the restore moved onto the seam a non-default root
  // silently SPLIT this function: the live count and the inbound.db pre-check
  // honoured the injected root while `withExistingNanoclawSession` resolved
  // through DATA_DIR, so reads and writes could address different trees. The
  // option is gone rather than threaded, which makes that split unrepresentable.
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
    // Table absent (feature not installed) — nothing to recover. Anything
    // else (a driver that is not initialized, a locked file) is a real
    // failure and surfaces through the duty's own catch.
    if (isMissingTable(err)) return;
    throw err;
  }

  for (const intent of intents) {
    const tsMs = parseSqliteUtc(intent.ts);
    // Only act on intents older than one sweep interval — the normal in-flight
    // window is seconds; younger ones are likely still executing.
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
    // Legacy intents can only count a live target row. An active task session
    // is the only status that can hold one; durable ownership below searches
    // closed sessions too.
    const target = targetResolution.sessions.find((session) => session.status === 'active') ?? null;

    // A receipt-bearing intent compensates only a source cancellation it can
    // prove it performed. If no receipt exists, the source may have been
    // changed by an overlapping winning move; resolving this loser is the
    // safe direction. Pre-receipt intents retain their historical recovery
    // policy below so an upgrade cannot strand an already-cancelled source.
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

    // New intents reserve a target row id before source cancellation. A
    // same-series row is not enough to prove the move landed: it can be a
    // manual run that collided after preflight. Legacy intents lack this field
    // and retain the old scoped-count fallback below.
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
      // Source is gone and no owned target exists. Continue to compensation
      // even if a different target row uses this series id; it is not ours to
      // overwrite, and it must not turn a rejected move into source loss.
    } else {
      // Legacy intent: its audit payload cannot identify a target row, so the
      // conservative historical rule is the only safe classification.
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

    // Zero live rows in scope → restore the source from the snapshot.
    if (!detail.snapshot) {
      // ADV-S2: body lost (purged but still unresolved) — unrecoverable. RESOLVE
      // it (stamp) so it does not surface forever as an unclearable repair row.
      log.warn('scheduled-move-recovery: unresolved intent with no snapshot — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      await purgeIntentBody(intent.correlation_id);
      continue;
    }

    const inboundPath = path.join(sessionsRoot, intent.agent_group_id, intent.session_id, 'inbound.db');
    if (!fs.existsSync(inboundPath)) {
      // ADV-S2: the source session is gone — cannot restore. RESOLVE so it does
      // not zombie as a permanent stalled repair row.
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
      // Existing-only: the existsSync above already answered "is there a
      // session to restore into", and a recovery pass must never re-provision
      // one it has just been told is gone (invariant I-10).
      outcome = await withExistingMailboxSession(intent.agent_group_id, intent.session_id, (mailbox) =>
        withCentralSync(() => {
          // Idempotency re-check: a durable target row id distinguishes this
          // move from unrelated same-series work. Legacy intents still use the
          // old scoped count because they have no ownership record to consult.
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
            // This duty runs in tick:housekeeping — AFTER the session fan-out and
            // after the quiet-mark flush. The fan-out saw a source with no live
            // task (that is the crash state this recovery exists for) and may have
            // just marked it quiet, so the row about to be restored is a DUE task
            // hiding behind a mark taken seconds ago, and the persisted mark
            // would survive a restart. The central-DB invalidation clears it.
            //
            // Invalidate BEFORE the restore, in the same synchronous turn (Codex
            // pre-pass Part C, round 3 H1): inbound.db and the central DB are two
            // separate files with no shared transaction, so a crash between the
            // two statements is possible even with no `await` between them.
            // Invalidate-then-restore's worst case is one wasted sweep of a
            // session that then finds nothing new to restore (the idempotency
            // re-check above already tolerates a repeated call); the reverse
            // leaves the restored row durable while the persisted quiet mark
            // survives the crash, hiding a due task for up to
            // `QUIET_SESSION_BACKOFF_MS` after a warmed restart.
            //
            // FAIL-CLOSED (Codex round 2, H1; round 3, H2): the invalidation
            // throws — on a central-DB error AND on a session row that is gone or
            // no longer active — and the throw escapes the mailbox action into
            // this loop's catch, which logs and leaves the intent UNRESOLVED for
            // the next recovery pass. A swallowed failure would instead restore
            // the row behind a mark nothing clears and then stamp the intent
            // resolved — the one outcome no later pass can repair.
            withQuietInvalidationSync(intent.session_id, () =>
              mailbox.restoreTaskRow({
                // Fresh id — the cancelled source row may still hold the snapshot id.
                id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                series_id: snapshot.series_id,
                status: snapshot.status,
                process_after: snapshot.process_after,
                // Optional on the parsed audit body: an intent written before the
                // column existed has none, and restoreTaskRow falls back.
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
      // The mailbox went away between the existsSync above and the open. The
      // pre-seam open threw here and landed in the catch; same outcome, said
      // out loud rather than as an exception.
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
    // Stamp + purge AFTER the restore (so a crash before this makes the next
    // pass re-evaluate; now a live row exists → it stamps without re-restoring).
    await purgeIntentBody(intent.correlation_id);
  }
}

const AUDIT_BODY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Prune `scheduled_audit` bodies older than 90 days (D4): NULL the
 * `before_preview`/`after_preview`/`detail_json` columns ONLY, keeping the
 * action-metadata row (actor/action/ts/hashes/correlation_id/resolved_at) for
 * the series' lifetime. This bounds the plaintext footprint while preserving
 * cancel-vs-completed distinguishability (the `action='cancel'` join, §4.3)
 * indefinitely. Design §4.4 retention.
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

/**
 * Registers T11/T12. A named export, not just an import-time side effect, so
 * it can be handed to `registerSweepDutySource` below — the registry replays
 * every recorded source's registrar on a default (builtins-restoring) test
 * reset, which is what lets this module's duties survive
 * `_resetSweepRegistryForTesting()` in src/host-sweep-registry.test.ts instead
 * of only host-sweep.ts's own in-file builtins coming back.
 */
export function registerScheduledMoveSweepDuties(): void {
  registerSweepDuty({
    name: id.T11,
    phase: 'tick:housekeeping',
    order: 50,
    // MODULE-HOOK:scheduled-move-recovery — autonomous recovery of unresolved
    // move intents. Additive (same pattern as the recurrence hook); touches only
    // scheduled_audit (central) + the move's own session inbound rows — no
    // firing-path change (C1).
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
    // 90d audit-body prune, the companion of the move recovery above.
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
