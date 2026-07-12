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

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroup } from '../src/db/agent-groups.js';
import { getActiveSessions, isTaskThread } from '../src/db/sessions.js';
import { cancelSeriesWithStrandClear, deleteTask, insertTaskRow } from '../src/modules/scheduling/db.js';
import { inboundDbPath, resolveTaskSession } from '../src/session-manager.js';

initDb(path.join(DATA_DIR, 'v2.db'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DELETE_JUNK = args.includes('--delete-junk');
const seriesFilter = args.includes('--series') ? args[args.indexOf('--series') + 1] : null;

interface LiveRow {
  id: string;
  series_id: string | null;
  status: 'pending' | 'paused';
  process_after: string | null;
  recurrence: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

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

let migrated = 0;
let skippedDue = 0;
let junk = 0;
let duplicates = 0;

for (const session of getActiveSessions()) {
  if (isTaskThread(session.thread_id)) continue; // already on the new model
  const srcPath = inboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(srcPath)) continue;

  const src = new Database(srcPath, { readonly: true });
  let rows: LiveRow[];
  try {
    rows = src
      .prepare(
        `SELECT id, series_id, status, process_after, recurrence, content,
                platform_id, channel_type, thread_id
           FROM messages_in
          WHERE kind = 'task' AND status IN ('pending', 'paused')
          ORDER BY seq DESC`,
      )
      .all() as LiveRow[];
  } finally {
    src.close();
  }
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

    const ag = getAgentGroup(session.agent_group_id);
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

    // Don't race an imminent/claimed fire — the host may be mid-delivery.
    if (row.status === 'pending' && row.process_after && new Date(row.process_after).getTime() <= Date.now()) {
      skippedDue++;
      console.log(`SKIP-DUE  ${label} — live row is due/claimed (process_after=${row.process_after}); rerun later`);
      continue;
    }

    const route = row.platform_id ? `${row.channel_type}:${row.platform_id}${row.thread_id ? ' thread' : ''}` : 'none';
    console.log(
      `MIGRATE   ${label} — ${row.status}, next=${row.process_after ?? '-'}, cron=${row.recurrence ?? 'once'}, route=${route}`,
    );
    if (!APPLY) {
      migrated++;
      continue;
    }

    const { session: target } = resolveTaskSession(session.agent_group_id, seriesId);
    const targetPath = inboundDbPath(session.agent_group_id, target.id);
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
          status: row.status,
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
  `\n${APPLY ? 'APPLIED' : 'DRY-RUN'}: ${migrated} migrated, ${duplicates} duplicate-target, ${skippedDue} skipped-due, ${junk} junk${APPLY ? '' : ' (no changes made)'}`,
);
