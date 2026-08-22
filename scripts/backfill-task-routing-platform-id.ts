/**
 * scripts/backfill-task-routing-platform-id.ts — one-off backfill for
 * `sessions.task_routing_platform_id` (migration 056).
 *
 * Migration 056 added the column NULL-by-default and deliberately shipped
 * with no backfill (see its header): the stamp's only source is a task's
 * `messages_in` rows, which live in a per-session `inbound.db`, and a schema
 * migration must not open thousands of session files to reconstruct one
 * column. This script does that reconstruction as a separate, explicit step.
 *
 * For each session whose `thread_id` is task-shaped (`system:tasks` or
 * `system:tasks:<seriesId>`, `messaging_group_id IS NULL` — see `isTaskThread`
 * / migration 056) with `task_routing_platform_id IS NULL`, read that
 * session's own `inbound.db` and look at every row that carries the task's
 * `series_id` AND a real channel (`channel_type IS NOT NULL AND != 'agent'` —
 * `channel_type = 'agent'` rows are agent-to-agent traffic, e.g. a restart
 * notice, that happens to share the series_id; their "platform_id" is a
 * target agent_group_id, not a `messaging_groups.platform_id`, and picking
 * one up as if it were routing produced real false conflicts in the live
 * data — see the script header comment above the query for a worked
 * example). If every remaining row agrees on one `platform_id`, stamp it
 * (already channel-key shape, e.g. `slack:CTESTCHAN01`). If the rows
 * disagree, or the inbound DB is missing/locked/unreadable, or the session
 * has no such row at all — SKIP. Never guess.
 *
 * Never writes `messaging_group_id` or anything else. `messaging_group_id IS
 * NULL` is a load-bearing discriminator read by `src/delivery.ts` (`task_log`
 * routing and `isTaskSessionPost`) — this script only ever reads it as a
 * filter, never writes it.
 *
 * Safety:
 *   - dry-run by default; --apply to write
 *   - central DB opened read-only unless --apply
 *   - every session inbound.db opened read-only, ALWAYS — this script never
 *     writes to a session DB, apply or not
 *   - idempotent: only ever updates rows still NULL, both in the in-memory
 *     filter and the UPDATE's own WHERE clause
 *
 * Usage:
 *   pnpm exec tsx scripts/backfill-task-routing-platform-id.ts          # dry run
 *   pnpm exec tsx scripts/backfill-task-routing-platform-id.ts --apply
 */
import path from 'path';
import { pathToFileURL } from 'url';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { isTaskThread, TASKS_SYSTEM_THREAD_ID } from '../src/db/sessions.js';

// Deliberately NOT `inboundDbPath` from `../src/session-manager.js` — that
// helper resolves against the module-level `DATA_DIR` singleton (itself
// pinned to `process.cwd()` at import time), so it silently ignores the
// `dataDir` parameter this script takes for fixture testing. Same join
// `sessionDir` does, just parameterized.
function inboundDbPath(dataDir: string, agentGroupId: string, sessionId: string): string {
  return path.join(dataDir, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
}

export interface CandidateSession {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
  task_routing_platform_id: string | null;
}

export type Outcome =
  | { kind: 'skip-non-task-thread' }
  | { kind: 'skip-already-stamped' }
  | { kind: 'resolved'; platformId: string }
  | { kind: 'unresolvable' }
  | { kind: 'conflict'; platformIds: string[] };

/**
 * Pure decision: given a session's thread/stamp state and the distinct
 * `platform_id` values seen across its task `messages_in` rows, decide what
 * (if anything) to write. No file IO — the only part under test.
 */
export function decideRoutingStamp(
  session: Pick<CandidateSession, 'thread_id' | 'task_routing_platform_id'>,
  taskMessageRows: { platform_id: string | null }[],
): Outcome {
  if (!isTaskThread(session.thread_id)) return { kind: 'skip-non-task-thread' };
  if (session.task_routing_platform_id != null) return { kind: 'skip-already-stamped' };

  const distinct = [
    ...new Set(taskMessageRows.map((r) => r.platform_id).filter((v): v is string => v != null)),
  ].sort();
  if (distinct.length === 0) return { kind: 'unresolvable' };
  if (distinct.length > 1) return { kind: 'conflict', platformIds: distinct };
  return { kind: 'resolved', platformId: distinct[0]! };
}

function hasRoutingColumn(db: Database.Database): boolean {
  return (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).some(
    (c) => c.name === 'task_routing_platform_id',
  );
}

export function runBackfill(apply: boolean, dataDir: string = DATA_DIR): void {
  const dbPath = path.join(dataDir, 'v2.db');
  const centralDb = new Database(dbPath, { readonly: !apply, fileMustExist: true });

  let examined = 0;
  let alreadyStamped = 0;
  let resolvable = 0;
  let written = 0;
  let unresolvable = 0;
  let conflict = 0;
  let unreadable = 0;
  const conflictIds: string[] = [];
  const unreadableIds: string[] = [];

  try {
    const stampColumnPresent = hasRoutingColumn(centralDb);
    if (apply && !stampColumnPresent) {
      throw new Error(
        'sessions.task_routing_platform_id does not exist on this DB — migration 056 has not run here. Aborting; no changes made.',
      );
    }
    if (!stampColumnPresent) {
      console.log(
        'NOTE: task_routing_platform_id column does not exist on this DB yet (migration 056 not applied). Treating every candidate as unstamped.\n',
      );
    }

    // Column interpolated, not parameterized — PRAGMA-derived name, never
    // user input. Every other value below is a bound parameter.
    const stampExpr = stampColumnPresent ? 'task_routing_platform_id' : 'NULL';
    const sessions = centralDb
      .prepare(
        `SELECT id, agent_group_id, thread_id, ${stampExpr} AS task_routing_platform_id
           FROM sessions
          WHERE messaging_group_id IS NULL
            AND (thread_id = ? OR thread_id LIKE ?)`,
      )
      .all(TASKS_SYSTEM_THREAD_ID, `${TASKS_SYSTEM_THREAD_ID}:%`) as CandidateSession[];

    for (const session of sessions) {
      examined++;

      if (!isTaskThread(session.thread_id)) continue; // unreachable given the WHERE above; defensive only
      if (session.task_routing_platform_id != null) {
        alreadyStamped++;
        continue;
      }

      const inPath = inboundDbPath(dataDir, session.agent_group_id, session.id);
      let rows: { platform_id: string | null }[];
      try {
        const inDb = new Database(inPath, { readonly: true, fileMustExist: true });
        try {
          inDb.pragma('busy_timeout = 2000');
          // channel_type = 'agent' rows are agent-to-agent traffic (see
          // src/modules/agent-to-agent/) that happens to share the task's
          // series_id — a restart notice, an approval recall note. Their
          // "platform_id" is a target agent_group_id, not a
          // `messaging_groups.platform_id`, so they are never a legitimate
          // routing signal and must be excluded before we even look at
          // distinctness (verified live: every task session where this
          // fired was otherwise unanimous — the a2a row was the only
          // disagreement).
          rows = inDb
            .prepare(
              `SELECT platform_id FROM messages_in
                WHERE series_id IS NOT NULL AND channel_type IS NOT NULL AND channel_type != 'agent'`,
            )
            .all() as {
            platform_id: string | null;
          }[];
        } finally {
          inDb.close();
        }
      } catch (err) {
        unreadable++;
        unreadableIds.push(session.id);
        console.log(
          `SKIP (inbound db unreadable): ${session.id} (${session.agent_group_id}) — ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const outcome = decideRoutingStamp(session, rows);
      switch (outcome.kind) {
        case 'skip-non-task-thread':
        case 'skip-already-stamped':
          // Unreachable here — already handled above — kept so the switch
          // covers the pure function's full result union.
          break;
        case 'unresolvable':
          unresolvable++;
          console.log(`UNRESOLVABLE: ${session.id} (${session.agent_group_id}) — no platform_id found in messages_in`);
          break;
        case 'conflict':
          conflict++;
          conflictIds.push(session.id);
          console.log(
            `CONFLICT: ${session.id} (${session.agent_group_id}) — distinct platform_ids: ${outcome.platformIds.join(', ')} — skipped, needs a human`,
          );
          break;
        case 'resolved':
          resolvable++;
          console.log(`${apply ? 'WRITE' : 'WOULD WRITE'}: ${session.id} (${session.agent_group_id}) -> ${outcome.platformId}`);
          if (apply) {
            const info = centralDb
              .prepare('UPDATE sessions SET task_routing_platform_id = ? WHERE id = ? AND task_routing_platform_id IS NULL')
              .run(outcome.platformId, session.id);
            if (info.changes > 0) written++;
          }
          break;
      }
    }
  } finally {
    centralDb.close();
  }

  console.log('');
  console.log(`${apply ? 'APPLIED' : 'DRY-RUN'} summary:`);
  console.log(`  sessions examined:  ${examined}`);
  console.log(`  already stamped:    ${alreadyStamped}`);
  console.log(`  resolvable:         ${resolvable}`);
  console.log(`  ${apply ? 'written' : 'would-write'}:        ${apply ? written : resolvable}`);
  console.log(`  unresolvable:       ${unresolvable}`);
  console.log(`  conflicting (skip): ${conflict}${conflictIds.length ? ` — ${conflictIds.join(', ')}` : ''}`);
  console.log(`  unreadable (skip):  ${unreadable}${unreadableIds.length ? ` — ${unreadableIds.join(', ')}` : ''}`);
  if (!apply) console.log('\nDry run — no changes made. Re-run with --apply to write.');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runBackfill(process.argv.includes('--apply'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
