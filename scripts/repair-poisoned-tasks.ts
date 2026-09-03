/**
 * One-shot repair for recurring task rows poisoned by the in_reply_to
 * mis-stamping bug (fixed 2026-06-10 in container/agent-runner).
 *
 * Bug recap: resolveDestinationThread stamped destination sends with
 * in_reply_to = the NEWEST inbound row of the channel. Right after a task
 * fire, that row is often a sibling task's freshly-inserted future fire row,
 * so the sibling's next fire acquired a phantom "reply" written BEFORE it was
 * due. getPendingMessages' idempotency guard then suppressed it forever, and
 * (post-adb44439) the expiry reaper no longer recycled it. Every interleaved
 * recurring task died between 2026-05-27 and 05-31.
 *
 * Repair: for each pending recurring row that is overdue AND carries the
 * poison signature (a messages_out reply timestamped before its
 * process_after), advance process_after to the next cron occurrence —
 * mirroring src/modules/scheduling/recurrence.ts. The series resumes at its
 * normal slot; the phantom reply is ignored by the fixed due-aware guard.
 *
 * Usage:
 *   pnpm exec tsx scripts/repair-poisoned-tasks.ts          # dry run
 *   pnpm exec tsx scripts/repair-poisoned-tasks.ts --apply  # write changes
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR } from '../src/config.js';
import { resolveGroupTimezone } from '../src/container-config.js';
import { initDb } from '../src/db/connection.js';

const APPLY = process.argv.includes('--apply');

// The replacement `process_after` must land on the SAME grid the firing path
// will re-arm on (recurrence.ts), and that grid is the owning group's
// effective timezone, not the install-wide one. Computing it here from
// `TIMEZONE` put every override group's repaired series one slot off until its
// next normal re-arm. Opening the central DB is what `resolveGroupTimezone`
// needs; the script only ever reads from it.
initDb(path.join(DATA_DIR, 'v2.db'));

interface PendingRecurring {
  id: string;
  series_id: string | null;
  recurrence: string;
  process_after: string;
  content: string;
}

/** SQLite datetime('now') is UTC without a zone marker; ISO rows carry Z. */
function parseDbUtc(value: string): number {
  let s = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  return Date.parse(s);
}

const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
let poisoned = 0;
let skipped = 0;

for (const group of fs.readdirSync(sessionsRoot)) {
  const groupDir = path.join(sessionsRoot, group);
  if (!fs.statSync(groupDir).isDirectory()) continue;
  // The directory name IS the agent group id (storage-activity.ts:319).
  const tz = resolveGroupTimezone(group);
  for (const sess of fs.readdirSync(groupDir)) {
    const inboundPath = path.join(groupDir, sess, 'inbound.db');
    const outboundPath = path.join(groupDir, sess, 'outbound.db');
    if (!fs.existsSync(inboundPath) || !fs.existsSync(outboundPath)) continue;

    const inDb = new Database(inboundPath);
    const outDb = new Database(outboundPath, { readonly: true });
    try {
      const rows = inDb
        .prepare(
          `SELECT id, series_id, recurrence, process_after, content FROM messages_in
           WHERE status = 'pending'
             AND recurrence IS NOT NULL
             AND process_after IS NOT NULL
             AND datetime(process_after) <= datetime('now')`,
        )
        .all() as PendingRecurring[];

      for (const row of rows) {
        const reply = outDb
          .prepare('SELECT MIN(timestamp) AS ts FROM messages_out WHERE in_reply_to = ?')
          .get(row.id) as { ts: string | null };

        const label = `${group}/${sess} ${row.id} (series ${row.series_id}, cron "${row.recurrence}", due ${row.process_after})`;

        if (!reply.ts || parseDbUtc(reply.ts) >= parseDbUtc(row.process_after)) {
          // Overdue but not poison-signature — leave for the normal sweep
          // (the fixed guard will let it fire) and just report it.
          console.log(`SKIP (no poison signature): ${label}`);
          skipped++;
          continue;
        }

        const next = CronExpressionParser.parse(row.recurrence, { tz }).next().toISOString();
        console.log(`${APPLY ? 'REPAIR' : 'WOULD REPAIR'}: ${label}`);
        console.log(
          `    phantom reply at ${reply.ts} → process_after ${row.process_after} → ${next} (cron grid ${tz})`,
        );
        if (APPLY) {
          inDb.prepare('UPDATE messages_in SET process_after = ? WHERE id = ?').run(next, row.id);
        }
        poisoned++;
      }
    } finally {
      inDb.close();
      outDb.close();
    }
  }
}

console.log(`\n${APPLY ? 'Repaired' : 'Would repair'} ${poisoned} poisoned row(s); ${skipped} overdue-but-unpoisoned left alone.`);
if (!APPLY) console.log('Dry run — re-run with --apply to write.');
