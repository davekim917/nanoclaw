/**
 * One-shot cleanup: strip stale `opus-4-7` model pins from live scheduled
 * tasks so they adopt the current scheduled-task default (Claude → Sonnet@high).
 *
 * Background: recurring operational tasks (daily briefings, email recaps,
 * meeting digests, wiki lint/synth, package-drift checks) were created with an
 * explicit `-m opus-4-7` when 4-7 was the newest Opus. The global default moved
 * to Opus 4.8 on 2026-05-28, but these per-fire pins were frozen in each task's
 * `content.flagIntent` and never updated — so every daily automation kept firing
 * on 4-7. This removes the frozen pin (the whole `flagIntent`, which only ever
 * held that model/effort) so the task falls through to the runtime default.
 *
 * Scope: every session `inbound.db` under DATA_DIR/v2-sessions; live task rows
 * only (status pending|paused). Leaves non-4-7 pins (deliberate opus-4-8/sonnet
 * choices) untouched. Idempotent.
 *
 * Usage:
 *   pnpm exec tsx scripts/clear-stale-opus47-task-pins.ts            # dry run (preview)
 *   pnpm exec tsx scripts/clear-stale-opus47-task-pins.ts --apply    # write changes
 *
 * Run with the host STOPPED to avoid contending with the single inbound.db
 * writer (do it in the same window as the deploy restart).
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';
import { resolveInboundDbPath } from '../src/modules/mailbox/index.js';

const apply = process.argv.includes('--apply');
const STALE = /opus-?4-?7/i;
const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');

if (!fs.existsSync(sessionsRoot)) {
  console.error(`No sessions dir at ${sessionsRoot}`);
  process.exit(1);
}

let totalScanned = 0;
let totalChanged = 0;

for (const ag of fs.readdirSync(sessionsRoot)) {
  const agDir = path.join(sessionsRoot, ag);
  if (!fs.statSync(agDir).isDirectory()) continue;
  for (const sess of fs.readdirSync(agDir)) {
    // The resolver, not the legacy name — see #749. The legacy name is a hard
    // link to the same inode, so a read-write open through it journals into the
    // container-writable session directory.
    const dbPath = resolveInboundDbPath(path.join(agDir, sess));
    if (!fs.existsSync(dbPath)) continue;
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 5000');
    try {
      const rows = db
        .prepare(
          "SELECT id, content, recurrence, status FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused')",
        )
        .all() as Array<{ id: string; content: string; recurrence: string | null; status: string }>;
      for (const r of rows) {
        totalScanned++;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(r.content) as Record<string, unknown>;
        } catch {
          continue;
        }
        const fi = parsed.flagIntent as { turnModel?: string; stickyModel?: string } | undefined;
        const model = fi?.turnModel ?? fi?.stickyModel;
        if (!model || !STALE.test(model)) continue;

        delete parsed.flagIntent;
        const preview = String(parsed.prompt ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, 50);
        console.log(
          `${apply ? 'CLEAR     ' : 'WOULD CLEAR'} ${ag}/${sess} ${r.id} [${r.status}${r.recurrence ? ' recur' : ''}] ${model} → default  "${preview}"`,
        );
        if (apply) db.prepare('UPDATE messages_in SET content = ? WHERE id = ?').run(JSON.stringify(parsed), r.id);
        totalChanged++;
      }
    } finally {
      db.close();
    }
  }
}

console.log(
  `\n${apply ? 'Cleared' : 'Would clear'} ${totalChanged} stale opus-4-7 task pin(s) (scanned ${totalScanned} live task rows).`,
);
if (!apply && totalChanged > 0) console.log('Dry run — re-run with --apply to write.');
