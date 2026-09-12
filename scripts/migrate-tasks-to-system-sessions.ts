/**
 * Migrate live scheduled-task series out of chat sessions into per-series
 * isolated system sessions (`system:tasks:<seriesId>`) — the ncl-tasks model.
 *
 * Part of the 2026-07 scheduling consolidation: routing columns
 * (platform_id/channel_type/thread_id) are carried verbatim, so a migrated
 * series keeps posting to exactly the channel/thread it always did (the
 * container fire path inherits the row's routing; see
 * container/agent-runner/src/formatter.ts extractRouting and
 * poll-loop.ts resolveDestinationThread).
 *
 * Per legacy live row (kind='task', status pending|paused, in a session whose
 * thread_id is not system:*):
 *   1. resolveTaskSession(agentGroupId, seriesId) — find/create the system session
 *   2. insertTaskRow into its inbound.db preserving id/series/status/schedule/
 *      content/routing verbatim
 *   3. cancelSeriesWithStrandClear on the source inbound.db (kills the live row
 *      AND clears recurrence on terminal strands so the series can't resurrect
 *      in the chat session)
 *
 * Safety:
 *   - dry-run by default; --apply to execute
 *   - every source inbound.db is backed up to <db>.pre-consolidation-<epoch>
 *     before its first write
 *   - a series whose live row is already due (process_after <= now) or claimed
 *     is SKIPPED (migrate it on a later run, after the fire completes)
 *   - idempotent: if the target system session already has a live row for the
 *     series, the source row is treated as a duplicate leftover and only the
 *     source cancel runs
 *   - rows whose agent group no longer exists in the central DB are junk
 *     (test residue); deleted only with --delete-junk
 *
 * Usage:
 *   pnpm exec tsx scripts/migrate-tasks-to-system-sessions.ts             # dry-run
 *   pnpm exec tsx scripts/migrate-tasks-to-system-sessions.ts --apply
 *   pnpm exec tsx scripts/migrate-tasks-to-system-sessions.ts --apply --series <id>
 *   pnpm exec tsx scripts/migrate-tasks-to-system-sessions.ts --apply --delete-junk
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

// Session provisioning goes through the registered mailbox; this standalone
// entrypoint loads the composition slot itself.
import '../src/mailbox/compose.js';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { getActiveSessions, isTaskThread } from '../src/db/sessions.js';
import { cancelSeriesWithStrandClear, deleteTask, insertTaskRow } from '../src/modules/scheduling/db.js';
import { sessionMailboxDir } from '../src/mailbox/sqlite/paths.js';
import { readSessionInbound, resolveInboundDbPath, type ScheduledTaskRow } from '../src/modules/mailbox/index.js';
import { resolveTaskSession } from '../src/session-manager.js';

await initDb(path.join(DATA_DIR, 'v2.db'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DELETE_JUNK = args.includes('--delete-junk');
const seriesFilter = args.includes('--series') ? args[args.indexOf('--series') + 1] : null;

// Row shape is the mailbox module's — one definition of the scheduled-task row.
type LiveRow = ScheduledTaskRow;

/**
 * A raw read-write handle. Still here because the row mutators this script
 * drives (`insertTaskRow`, `cancelSeriesWithStrandClear`, `deleteTask` in
 * src/modules/scheduling/db.ts) take a `Database` handle; they move onto the
 * mailbox session in the scheduling batch of the seam series
 * (docs/specs/upstream-mailbox-seam/plan.md §5 PR 4), and this opener goes
 * with them. Every READ below already goes through the module.
 */
function openRw(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

const backedUp = new Set<string>();
function backupOnce(dbPath: string): void {
  if (backedUp.has(dbPath)) return;
  const dest = `${dbPath}.pre-consolidation-${Math.floor(Date.now() / 1000)}`;
  fs.copyFileSync(dbPath, dest);
  backedUp.add(dbPath);
  console.log(`  [backup] ${dest}`);
}

/**
 * `listLiveTaskRows` only SELECTs `status IN ('pending', 'paused')`, so this
 * should never trip in practice — but `ScheduledTaskRow.status` (shared with
 * every other board surface, some of which read rows in every status) is a
 * raw `string`, and `insertTaskRow`'s `TaskRowInsert.status` takes the
 * narrower union. Fail closed rather than cast past the mismatch: an
 * unexpected value here means the SQL filter and this script's assumption
 * have drifted, and writing it into the target session unnarrowed would
 * silently corrupt the migrated row's status instead of surfacing the drift.
 */
function narrowLiveTaskStatus(status: string): 'pending' | 'paused' | null {
  return status === 'pending' || status === 'paused' ? status : null;
}

let migrated = 0;
let skippedDue = 0;
let skippedBadStatus = 0;
let junk = 0;
let duplicates = 0;

for (const session of await getActiveSessions()) {
  if (isTaskThread(session.thread_id)) continue; // already on the new model
  // The resolver, not the legacy name (#749): `openRw` below journals beside
  // whatever path it is given, and the legacy name sits in the session
  // directory the container has bind-mounted read-write.
  const srcPath = resolveInboundDbPath(
    sessionMailboxDir({ agentGroupId: session.agent_group_id, sessionId: session.id }),
  );
  // Read-only seam: a survey pass must never provision or migrate a session it
  // is only reading. `undefined` is "no mailbox" — nothing to consolidate.
  // 5s busy_timeout because this is an operator-run one-shot against a LIVE
  // fleet: a session that is briefly busy must be waited for, not silently
  // skipped and left un-consolidated.
  const rows =
    readSessionInbound(
      { agentGroupId: session.agent_group_id, sessionId: session.id },
      (mailbox) => mailbox.listLiveTaskRows(),
      { busyTimeoutMs: 5000 },
    ) ?? [];
  if (rows.length === 0) continue;

  // One live row per series — newest wins if a strand left more than one.
  const bySeries = new Map<string, LiveRow>();
  for (const r of rows) {
    const key = r.series_id ?? r.id;
    if (!bySeries.has(key)) bySeries.set(key, r);
  }

  for (const [seriesId, row] of bySeries) {
    if (seriesFilter && seriesId !== seriesFilter) continue;
    const label = `${seriesId} (${session.agent_group_id} / ${session.id})`;

    const ag = await getAgentGroup(session.agent_group_id);
    if (!ag) {
      junk++;
      console.log(`JUNK      ${label} — agent group not in central DB${DELETE_JUNK ? '' : ' (use --delete-junk)'}`);
      if (APPLY && DELETE_JUNK) {
        backupOnce(srcPath);
        const db = openRw(srcPath);
        try {
          const n = deleteTask(db, seriesId);
          console.log(`  [deleted] ${n} row(s)`);
        } finally {
          db.close();
        }
      }
      continue;
    }

    // Fail closed on a status `listLiveTaskRows`'s own SQL filter should have
    // ruled out. See `narrowLiveTaskStatus` above.
    const liveStatus = narrowLiveTaskStatus(row.status);
    if (liveStatus === null) {
      skippedBadStatus++;
      console.log(
        `SKIP-STATUS ${label} — live row has unexpected status '${row.status}' (expected pending|paused); investigate before rerunning`,
      );
      continue;
    }

    // Don't race an imminent/claimed fire — the host may be mid-delivery.
    if (liveStatus === 'pending' && row.process_after && new Date(row.process_after).getTime() <= Date.now()) {
      skippedDue++;
      console.log(`SKIP-DUE  ${label} — live row is due/claimed (process_after=${row.process_after}); rerun later`);
      continue;
    }

    const route = row.platform_id ? `${row.channel_type}:${row.platform_id}${row.thread_id ? ' thread' : ''}` : 'none';
    console.log(
      `MIGRATE   ${label} — ${liveStatus}, next=${row.process_after ?? '-'}, cron=${row.recurrence ?? 'once'}, route=${route}`,
    );
    if (!APPLY) {
      migrated++;
      continue;
    }

    const { session: target } = await resolveTaskSession(session.agent_group_id, seriesId);
    const targetPath = resolveInboundDbPath(
      sessionMailboxDir({ agentGroupId: session.agent_group_id, sessionId: target.id }),
    );
    const targetDb = openRw(targetPath);
    try {
      const existing = targetDb
        .prepare("SELECT id FROM messages_in WHERE series_id = ? AND status IN ('pending','paused')")
        .get(seriesId) as { id: string } | undefined;
      if (existing) {
        duplicates++;
        console.log(`  [dup] target already live (${existing.id}) — cancelling source only`);
      } else {
        insertTaskRow(targetDb, {
          id: row.id,
          seriesId,
          processAfter: row.process_after,
          recurrence: row.recurrence,
          content: row.content,
          status: liveStatus,
          platformId: row.platform_id,
          channelType: row.channel_type,
          threadId: row.thread_id,
        });
      }
    } finally {
      targetDb.close();
    }

    backupOnce(srcPath);
    const srcRw = openRw(srcPath);
    try {
      const n = cancelSeriesWithStrandClear(srcRw, seriesId);
      console.log(`  [done] target=${target.id}, source rows touched=${n}`);
    } finally {
      srcRw.close();
    }
    migrated++;
  }
}

console.log(
  `\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${migrated} migrated, ${duplicates} duplicate-target, ${skippedDue} skipped-due, ${skippedBadStatus} skipped-bad-status, ${junk} junk${APPLY ? '' : ' (no changes made)'}`,
);
