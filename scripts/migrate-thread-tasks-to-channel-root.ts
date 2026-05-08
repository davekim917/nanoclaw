/**
 * One-shot migration: move live (pending|paused) `kind='task'` rows out of
 * thread-bound session inbound.dbs and into the corresponding channel-root
 * session's inbound.db.
 *
 * Why: pre-2026-05-08, the MCP `schedule_task` handler (`src/modules/scheduling/actions.ts`)
 * wrote tasks to the calling session's inbound.db. When called from inside a
 * Slack/Discord thread, the task ended up in that thread's session DB —
 * invisible from any other thread, and dead if the thread session is ever
 * deactivated. The fix routes new tasks correctly; this script migrates
 * pre-fix tasks.
 *
 * Safety:
 *   1. Stop the host service before running this. Do not run while
 *      `sweepSession` is iterating sessions, otherwise `handleRecurrence` can
 *      clone a fresh row mid-migration. Restart afterward.
 *   2. We clear `recurrence` on the source row BEFORE inserting into
 *      channel-root. If the script crashes between steps, the source row is
 *      now inert — `handleRecurrence` won't clone it.
 *   3. Idempotent on `series_id`: if a row with the same series already
 *      exists in the channel-root session with status pending|paused, skip.
 *
 * Usage:
 *   sudo systemctl stop nanoclaw-v2
 *   pnpm exec tsx scripts/migrate-thread-tasks-to-channel-root.ts [--dry-run]
 *   sudo systemctl start nanoclaw-v2
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { initDb, getDb } from '../src/db/connection.js';
import { resolveActiveSession } from '../src/db/scheduled-tasks.js';
import { findSessionByAgentGroupAndMessagingGroup } from '../src/db/sessions.js';
import { ensureSchema, nextEvenSeq } from '../src/db/session-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

interface SourceTask {
  id: string;
  series_id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
}

interface MigrationResult {
  scanned_sessions: number;
  thread_sessions_with_live_tasks: number;
  tasks_migrated: number;
  tasks_skipped_already_migrated: number;
  tasks_skipped_no_messaging_group: number;
  errors: string[];
}

function generateTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

interface SessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  status: string;
}

async function migrateOnce(dryRun: boolean): Promise<MigrationResult> {
  const result: MigrationResult = {
    scanned_sessions: 0,
    thread_sessions_with_live_tasks: 0,
    tasks_migrated: 0,
    tasks_skipped_already_migrated: 0,
    tasks_skipped_no_messaging_group: 0,
    errors: [],
  };

  // Find every thread-bound session (has a thread_id) that's still active
  // OR archived but might still have undelivered live tasks.
  const threadSessions = getDb()
    .prepare(
      `SELECT id, agent_group_id, messaging_group_id, thread_id, status
         FROM sessions
        WHERE thread_id IS NOT NULL`,
    )
    .all() as SessionRow[];

  for (const sess of threadSessions) {
    const inboundPath = path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, sess.id, 'inbound.db');
    if (!fs.existsSync(inboundPath)) continue;
    result.scanned_sessions += 1;

    const sourceDb = new Database(inboundPath);
    sourceDb.pragma('journal_mode = DELETE');
    sourceDb.pragma('busy_timeout = 5000');
    let liveTasks: SourceTask[];
    try {
      liveTasks = sourceDb
        .prepare(
          `SELECT id, series_id, status, process_after, recurrence, content, platform_id, channel_type
             FROM messages_in
            WHERE kind = 'task' AND status IN ('pending', 'paused')`,
        )
        .all() as SourceTask[];
    } catch (err) {
      result.errors.push(`Failed to read live tasks from ${inboundPath}: ${(err as Error).message}`);
      sourceDb.close();
      continue;
    }
    if (liveTasks.length === 0) {
      sourceDb.close();
      continue;
    }
    result.thread_sessions_with_live_tasks += 1;

    if (!sess.messaging_group_id) {
      result.tasks_skipped_no_messaging_group += liveTasks.length;
      console.warn(
        `[skip] thread session ${sess.id} has no messaging_group_id — ${liveTasks.length} live task(s) cannot be routed to a channel-root session. Manual review required.`,
      );
      sourceDb.close();
      continue;
    }

    let channelSessionId: string;
    let channelSessionPreexisting: boolean;
    if (dryRun) {
      // Find-only — never create a session in dry-run, otherwise inspecting
      // the migration plan has side effects.
      const existing = findSessionByAgentGroupAndMessagingGroup(sess.agent_group_id, sess.messaging_group_id);
      channelSessionPreexisting = !!existing;
      channelSessionId = existing ? existing.id : `(would-create-new)`;
    } else {
      try {
        const channel = await resolveActiveSession(sess.agent_group_id, sess.messaging_group_id);
        channelSessionId = channel.id;
        channelSessionPreexisting = true; // already created or just resolved
      } catch (err) {
        result.errors.push(
          `Failed to resolve channel-root for (${sess.agent_group_id}, ${sess.messaging_group_id}): ${(err as Error).message}`,
        );
        sourceDb.close();
        continue;
      }
    }

    const channelInboundPath =
      !dryRun || channelSessionPreexisting
        ? path.join(DATA_DIR, 'v2-sessions', sess.agent_group_id, channelSessionId, 'inbound.db')
        : null;
    let channelDb: Database.Database | null = null;
    if (channelInboundPath) {
      ensureSchema(channelInboundPath, 'inbound');
      channelDb = new Database(channelInboundPath);
      channelDb.pragma('journal_mode = DELETE');
      channelDb.pragma('busy_timeout = 5000');
    }

    try {
      for (const task of liveTasks) {
        // Idempotent: skip if channel-root already has a live row for this
        // series. (Only checkable when channelDb is open — dry-run with no
        // pre-existing channel session has no DB to query, so we just report
        // a planned migrate.)
        const existing = channelDb
          ? (channelDb
              .prepare(
                `SELECT id FROM messages_in
                  WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')`,
              )
              .get(task.series_id) as { id: string } | undefined)
          : undefined;
        if (existing) {
          result.tasks_skipped_already_migrated += 1;
          if (!dryRun) {
            // Belt and suspenders: still mark the source as migrated so we
            // don't repeat-process on subsequent runs.
            sourceDb
              .prepare(
                "UPDATE messages_in SET status = 'migrated', recurrence = NULL WHERE id = ?",
              )
              .run(task.id);
          }
          console.log(
            `[skip-already] series=${task.series_id} (channel-root already has live row ${existing.id})`,
          );
          continue;
        }

        if (dryRun) {
          console.log(
            `[dry-run] migrate series=${task.series_id} from session=${sess.id} → ${channelSessionId}${channelSessionPreexisting ? '' : ' (channel-root would be created)'}`,
          );
          continue;
        }

        // CRITICAL ORDER: clear recurrence on source FIRST so a crash now
        // can't be re-cloned by handleRecurrence.
        sourceDb
          .prepare("UPDATE messages_in SET status = 'migrated', recurrence = NULL WHERE id = ?")
          .run(task.id);

        const newId = generateTaskId();
        const seq = nextEvenSeq(channelDb!);
        channelDb!
          .prepare(
            `INSERT INTO messages_in
               (id, seq, kind, timestamp, status, tries, process_after, recurrence, series_id, content, platform_id, channel_type, thread_id)
             VALUES (?, ?, 'task', datetime('now'), ?, 0, ?, ?, ?, ?, ?, ?, NULL)`,
          )
          .run(
            newId,
            seq,
            task.status, // preserve pending/paused
            task.process_after,
            task.recurrence,
            task.series_id,
            task.content,
            task.platform_id,
            task.channel_type,
          );

        result.tasks_migrated += 1;
        console.log(
          `[migrate] series=${task.series_id} ${sess.id} → ${channelSessionId} (old=${task.id} new=${newId} cron=${task.recurrence ?? 'one-shot'} after=${task.process_after})`,
        );
      }
    } finally {
      channelDb?.close();
      sourceDb.close();
    }
  }

  return result;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  initDb(DB_PATH);

  console.log(
    dryRun
      ? '== Migration dry-run — no rows will be written =='
      : '== Migration LIVE run ==\nMake sure the host service is stopped (sudo systemctl stop nanoclaw-v2).',
  );

  const result = await migrateOnce(dryRun);
  console.log('\n== Summary ==');
  console.log(`  Scanned thread sessions:                 ${result.scanned_sessions}`);
  console.log(`  Thread sessions with live tasks:         ${result.thread_sessions_with_live_tasks}`);
  console.log(`  Tasks migrated:                          ${result.tasks_migrated}`);
  console.log(`  Tasks skipped (already in channel-root): ${result.tasks_skipped_already_migrated}`);
  console.log(`  Tasks skipped (no messaging_group_id):   ${result.tasks_skipped_no_messaging_group}`);
  if (result.errors.length > 0) {
    console.log(`  Errors:`);
    for (const e of result.errors) console.log(`    - ${e}`);
    process.exitCode = 1;
  }
  if (dryRun) {
    console.log('\nRe-run without --dry-run to apply.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
