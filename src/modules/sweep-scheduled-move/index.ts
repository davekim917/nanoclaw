/**
 * Sweep family: scheduled-move recovery (seam 2, S2-PR7 — plan.md §5 "S2-PR7
 * scheduled-move recovery (G30)", §8 "S2-PR7 — scheduled-move recovery").
 * Registers T11 (scheduled-move-recovery) and T12 (audit-body-prune) on
 * `tick:housekeeping` at order 50/60 — order-free housekeeping work, run
 * every tick with no session fan-out.
 *
 * Moved from src/host-sweep.ts UNCHANGED (cut/paste, same statements, same
 * log strings, same thresholds). PR 2 registered both duties in-file as a
 * SHARED try/catch; this module keeps that behavior-preserving split into two
 * independently guarded registrations while KEEPING the identical
 * `scheduled-move-recovery: sweep hook failed` warn string on both, so a log
 * search for that string still finds every failure it used to.
 */
import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../../log.js';
import { getDb } from '../../db/connection.js';
import { sessionsBaseDir } from '../../session-manager.js';
import { parseSqliteUtc } from '../mailbox/sqlite-utc.js';
// Move recovery resolves its source session through the seam, like every other
// host caller. The KEEP-PATCH this module used to carry existed for an INJECTED
// sessions root, but no production caller ever injects one — the sweep's only
// call site passes `{}` — so the exemption protected test scaffolding rather
// than behaviour, and it is gone (mailbox seam PR 7 made the same change in
// host-sweep.ts).
import { withExistingNanoclawSession } from '../mailbox/session.js';
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
  /** Sessions root parent; defaults to the real DATA_DIR's parent of v2-sessions. */
  dataDir?: string;
  nowMs?: number;
}

// TaskRowSnapshot fields, parsed from the intent's detail_json (A-1: a type
// alias, not an empty-extends interface — clears the lone no-empty-interface lint).
type MoveIntentSnapshot = TaskRowSnapshot;

/**
 * Resolve the target channel-root session id (thread_id IS NULL, active) for a
 * (targetAgentGroupId, targetMessagingGroupId) pair from the central DB.
 * Defensive: returns null on any error (e.g. the `sessions` table is absent in a
 * minimal test DB, or no session exists yet because the move crashed before the
 * target insert). A null target session contributes 0 to the scoped count.
 */
function resolveTargetSessionId(
  centralDb: Database.Database,
  targetAgentGroupId: string,
  targetMessagingGroupId: string,
): string | null {
  try {
    const row = centralDb
      .prepare(
        "SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active' LIMIT 1",
      )
      .get(targetAgentGroupId, targetMessagingGroupId) as { id: string } | undefined;
    return row?.id ?? null;
  } catch {
    return null;
  }
}

interface ParsedIntentDetail {
  snapshot: MoveIntentSnapshot | null;
  targetAgentGroupId: string | null;
  targetMessagingGroupId: string | null;
}

function parseIntentDetail(detailJson: string | null): ParsedIntentDetail {
  if (!detailJson) return { snapshot: null, targetAgentGroupId: null, targetMessagingGroupId: null };
  try {
    const d = JSON.parse(detailJson) as {
      snapshot?: MoveIntentSnapshot;
      targetAgentGroupId?: string;
      targetMessagingGroupId?: string;
    };
    return {
      snapshot: d.snapshot ?? null,
      targetAgentGroupId: typeof d.targetAgentGroupId === 'string' ? d.targetAgentGroupId : null,
      targetMessagingGroupId: typeof d.targetMessagingGroupId === 'string' ? d.targetMessagingGroupId : null,
    };
  } catch {
    return { snapshot: null, targetAgentGroupId: null, targetMessagingGroupId: null };
  }
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
export async function recoverMoveIntents(centralDb: Database.Database, options: MoveRecoveryOptions): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const dataDir = options.dataDir ?? path.dirname(sessionsBaseDir());
  const sessionsRoot = options.dataDir ? path.join(options.dataDir, 'v2-sessions') : sessionsBaseDir();

  let intents: Array<{
    session_id: string;
    agent_group_id: string;
    series_id: string;
    detail_json: string | null;
    correlation_id: string | null;
    ts: string;
  }>;
  try {
    intents = centralDb
      .prepare(
        `SELECT session_id, agent_group_id, series_id, detail_json, correlation_id, ts
           FROM scheduled_audit
          WHERE action = 'move_intent' AND resolved_at IS NULL`,
      )
      .all() as typeof intents;
  } catch {
    // Table absent (feature not installed) — nothing to recover.
    return;
  }

  for (const intent of intents) {
    const tsMs = parseSqliteUtc(intent.ts);
    // Only act on intents older than one sweep interval — the normal in-flight
    // window is seconds; younger ones are likely still executing.
    if (Number.isNaN(tsMs) || nowMs - tsMs <= SWEEP_INTERVAL_MS) continue;
    if (!intent.correlation_id) continue;

    const detail = parseIntentDetail(intent.detail_json);
    const source = { agentGroupId: intent.agent_group_id, sessionId: intent.session_id };
    const targetSessionId =
      detail.targetAgentGroupId && detail.targetMessagingGroupId
        ? resolveTargetSessionId(centralDb, detail.targetAgentGroupId, detail.targetMessagingGroupId)
        : null;
    const target =
      detail.targetAgentGroupId && targetSessionId
        ? { agentGroupId: detail.targetAgentGroupId, sessionId: targetSessionId }
        : null;

    // Scoped {source, target} live count — M1 (never a fleet-wide series scan).
    const live = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
    if (live.unreadable) {
      // Live state UNKNOWN → skip this pass (leave unresolved). Never restore on
      // unknown (F6 / M2).
      log.warn('scheduled-move-recovery: scoped live count unreadable — deferring', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      continue;
    }
    if (live.count > 0) {
      // A live row exists at source or target → the move's row landed; the intent
      // breadcrumb has done its job. Stamp + purge; never restore (would double the
      // live rows).
      if (live.count > 1) {
        // >1 = a PRE-EXISTING duplicate the move inherited (it didn't create it — the
        // move's E-2 invariant already returned 500 and refused to claim success).
        // We resolve the intent WITHOUT auto-deduping: deleting a row the move didn't
        // own is its own data-loss risk, and leaving it unresolved would reintroduce
        // the ADV-S2 zombie repair row. The board's duplicate-successor health detector
        // surfaces the duplicate independently. Log it so it isn't silently swallowed.
        log.warn(
          'scheduled-move-recovery: >1 live row for series — pre-existing duplicate, resolving intent without dedup (surfaced via duplicate-successor health)',
          { seriesId: intent.series_id, correlationId: intent.correlation_id, liveCount: live.count },
        );
      }
      purgeIntentBody(centralDb, intent.correlation_id);
      continue;
    }

    // Zero live rows in scope → restore the source from the snapshot.
    if (!detail.snapshot) {
      // ADV-S2: body lost (purged but still unresolved) — unrecoverable. RESOLVE
      // it (stamp) so it does not surface forever as an unclearable repair row.
      log.warn('scheduled-move-recovery: unresolved intent with no snapshot — resolving (unrecoverable)', {
        seriesId: intent.series_id,
        correlationId: intent.correlation_id,
      });
      purgeIntentBody(centralDb, intent.correlation_id);
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
      purgeIntentBody(centralDb, intent.correlation_id);
      continue;
    }
    const snapshot = detail.snapshot;
    let outcome: 'restored' | 'deferred' | undefined;
    try {
      // Existing-only: the existsSync above already answered "is there a
      // session to restore into", and a recovery pass must never re-provision
      // one it has just been told is gone (invariant I-10).
      outcome = await withExistingNanoclawSession(intent.agent_group_id, intent.session_id, (mailbox) => {
        // Idempotency re-check: the restore + the resolved_at stamp span two DB
        // files (not atomic), so re-confirm a readable zero-live IMMEDIATELY before
        // insert. An unreadable re-check defers (never restore on unknown).
        const recheck = countLiveRowsInSessions(dataDir, [source, target], intent.series_id);
        if (recheck.unreadable) return 'deferred' as const;
        if (recheck.count === 0) {
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
          });
        }
        return 'restored' as const;
      });
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
    purgeIntentBody(centralDb, intent.correlation_id);
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
export function pruneAuditBodies(centralDb: Database.Database, options: { nowMs?: number }): void {
  const nowMs = options.nowMs ?? Date.now();
  const cutoff = new Date(nowMs - AUDIT_BODY_RETENTION_MS).toISOString();
  try {
    centralDb
      .prepare(
        `UPDATE scheduled_audit
            SET before_preview = NULL, after_preview = NULL, detail_json = NULL
          WHERE ts < ?
            AND (before_preview IS NOT NULL OR after_preview IS NOT NULL OR detail_json IS NOT NULL)`,
      )
      .run(cutoff);
  } catch {
    // Table absent — nothing to prune.
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
        await recoverMoveIntents(getDb(), {});
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
    run: () => {
      try {
        pruneAuditBodies(getDb(), {});
      } catch (err) {
        log.warn('scheduled-move-recovery: sweep hook failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-scheduled-move', registerScheduledMoveSweepDuties);
