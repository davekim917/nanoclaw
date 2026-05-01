/**
 * Reset chat-stream classifier watermarks so a CLASSIFIER_VERSION or
 * PROMPT_VERSION bump actually re-classifies already-scanned chat pairs.
 *
 * Usage:
 *   pnpm exec tsx scripts/reset-classifier-watermarks.ts                                       # dry-run, all groups
 *   pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId>                        # dry-run, one group
 *   pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply                               # execute, all groups
 *   pnpm exec tsx scripts/reset-classifier-watermarks.ts <agentGroupId> --apply
 *   pnpm exec tsx scripts/reset-classifier-watermarks.ts --apply --include-poisoned            # also clear poisoned dead_letters
 *
 * Default mode is DRY-RUN — the script prints what would be deleted but makes
 * no DB changes. Pass --apply to actually delete watermark rows. This is the
 * intended interaction model: review what will reset, then re-run with --apply.
 *
 * REQUIRED FIRST: stop the memory daemon before --apply.
 *   sudo systemctl stop nanoclaw-memory-daemon
 * Without stopping it, an in-flight sweep can re-INSERT a watermark row at
 * the in-flight pair's lastSentAt mid-cleanup, silently undoing the replay
 * (ultrareview bug_012). Re-start with `sudo systemctl start nanoclaw-
 * memory-daemon` after the script finishes — the next 60s sweep then reads
 * the archive from the beginning for cleared groups.
 *
 * --include-poisoned (ultrareview bug_013): also DELETE dead_letters rows
 * where poisoned_at IS NOT NULL. By default, classifier.ts:processGroup
 * short-circuits any pair whose dead_letters row is poisoned — so a pair
 * poisoned under v1 (especially via the v2 validateFactsAgainstSource
 * dropping all confabulated facts → empty-facts → 3-strikes poison) is
 * silently skipped on the re-classify, defeating the whole point of the
 * watermark reset for that pair. Pass --include-poisoned when the goal is
 * "reclassify EVERYTHING under the new prompt", not just "reclassify
 * everything that wasn't already in the dead-letter queue". The processed_
 * pairs row is keyed by (..., version, ...) so v1 + v2 rows still coexist;
 * facts already in mnemon are not deleted.
 *
 * Why this is needed:
 *   The daemon advances `scan_cursor` past every successfully-classified
 *   pair's sent_at timestamp. On subsequent sweeps it reads only rows AFTER
 *   the cursor — so when CLASSIFIER_VERSION/PROMPT_VERSION bump, the new
 *   prompt logic only runs on NEW chat pairs. Previously-classified pairs
 *   keep their v1 facts (including any confabulations) until manually
 *   re-processed.
 *
 *   `processed_pairs` is keyed by (..., classifier_version, prompt_version,
 *   ...), so old-version rows don't block new-version classification — the
 *   only blocker is the watermark. Resetting watermarks (= setting scan_cursor
 *   to NULL) forces the next sweep to re-read the entire archive for affected
 *   groups; new pairs get fresh v2 rows in processed_pairs while v1 rows stay
 *   put for audit.
 *
 * Side effects:
 *   - This script ONLY touches `data/mnemon-ingest.db` (`watermarks` table).
 *   - `processed_pairs` rows are PRESERVED (PK includes versions, naturally
 *     coexists with new-version rows after a re-classify sweep).
 *   - `dead_letters` rows are PRESERVED (operator review).
 *   - `~/.mnemon/data/<agentGroupId>/` is PRESERVED — facts from the old
 *     version stay in the graph. Re-classifying does not delete them.
 *     If the v1 prompt produced confabulations, run `mnemon forget` for
 *     specific facts after the re-classify sweep adds the v2 versions.
 *
 * After running this script, the daemon's next 60s sweep will re-read every
 * chat pair from archive.db for affected groups. Expect a temporary spike in
 * Anthropic/Codex API calls proportional to historical chat volume — for a
 * group with N pairs accumulated, the cost is N × 1 classifier call. Plan
 * cost accordingly before running on busy groups.
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { DATA_DIR } from '../src/config.js';
import { openMnemonIngestDb, runMnemonIngestMigrations } from '../src/db/migrations/019-mnemon-ingest-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const includePoisoned = args.includes('--include-poisoned');
  const targetGroupId = args.find((a) => !a.startsWith('--'));
  const mode = apply ? 'APPLY' : 'DRY-RUN';

  const ingestDb = openMnemonIngestDb(path.join(DATA_DIR, 'mnemon-ingest.db'));
  try {
    runMnemonIngestMigrations(ingestDb);

    if (targetGroupId) {
      const before = ingestDb
        .prepare('SELECT COUNT(*) as c, scan_cursor FROM watermarks WHERE agent_group_id = ?')
        .get(targetGroupId) as { c: number; scan_cursor: string | null } | undefined;

      const poisonedCount = includePoisoned
        ? (
            ingestDb
              .prepare(
                'SELECT COUNT(*) as c FROM dead_letters WHERE agent_group_id = ? AND poisoned_at IS NOT NULL',
              )
              .get(targetGroupId) as { c: number } | undefined
          )?.c ?? 0
        : 0;

      if ((!before || before.c === 0) && poisonedCount === 0) {
        console.log(
          `No watermark row${includePoisoned ? ' or poisoned dead_letters' : ''} for agent_group_id='${targetGroupId}'. Nothing to do.`,
        );
        process.exit(0);
      }

      if (before && before.c > 0) {
        console.log(`[${mode}] Would delete 1 watermark row for agent_group_id='${targetGroupId}'.`);
        console.log(`         Prior scan_cursor: ${before.scan_cursor ?? 'NULL'}`);
      }
      if (includePoisoned) {
        console.log(`[${mode}] Would delete ${poisonedCount} poisoned dead_letters row(s) for this group.`);
      }

      if (apply) {
        const r = ingestDb.prepare('DELETE FROM watermarks WHERE agent_group_id = ?').run(targetGroupId);
        console.log(`Deleted ${r.changes} watermark row(s).`);
        if (includePoisoned) {
          const dr = ingestDb
            .prepare('DELETE FROM dead_letters WHERE agent_group_id = ? AND poisoned_at IS NOT NULL')
            .run(targetGroupId);
          console.log(`Deleted ${dr.changes} poisoned dead_letters row(s).`);
        }
        console.log(`Next sweep will re-read this group's archive from the beginning.`);
      }
    } else {
      const all = ingestDb
        .prepare('SELECT agent_group_id, scan_cursor FROM watermarks ORDER BY agent_group_id')
        .all() as Array<{ agent_group_id: string; scan_cursor: string | null }>;

      const poisonedTotal = includePoisoned
        ? (
            ingestDb
              .prepare('SELECT COUNT(*) as c FROM dead_letters WHERE poisoned_at IS NOT NULL')
              .get() as { c: number }
          ).c
        : 0;

      if (all.length === 0 && poisonedTotal === 0) {
        console.log(`No watermark rows${includePoisoned ? ' or poisoned dead_letters' : ''} in data/mnemon-ingest.db. Nothing to do.`);
        process.exit(0);
      }

      if (all.length > 0) {
        console.log(`[${mode}] Would reset watermarks for ${all.length} group(s):`);
        for (const row of all) {
          console.log(`         ${row.agent_group_id} (scan_cursor=${row.scan_cursor ?? 'NULL'})`);
        }
      }
      if (includePoisoned) {
        console.log(`[${mode}] Would delete ${poisonedTotal} poisoned dead_letters row(s) (across all groups).`);
      }

      if (apply) {
        const r = ingestDb.prepare('DELETE FROM watermarks').run();
        console.log(`Deleted ${r.changes} watermark row(s) total.`);
        if (includePoisoned) {
          const dr = ingestDb.prepare('DELETE FROM dead_letters WHERE poisoned_at IS NOT NULL').run();
          console.log(`Deleted ${dr.changes} poisoned dead_letters row(s) total.`);
        }
        console.log(`Next sweep will re-read every group's archive from the beginning.`);
      }
    }

    if (!apply) {
      console.log('');
      console.log('Re-run with --apply to execute. Otherwise no changes were made.');
      if (!includePoisoned) {
        console.log(
          'If you want pairs poisoned under the OLD version to also retry, add --include-poisoned (see --help).',
        );
      }
    } else {
      console.log('');
      console.log('Note: processed_pairs preserved (PK includes version, so old + new rows coexist).');
      if (!includePoisoned) {
        console.log('Note: dead_letters rows preserved. Pairs with poisoned_at NOT NULL will not retry —');
        console.log('      pass --include-poisoned to also clear those.');
      }
      console.log('');
      console.log('Restart the daemon now: sudo systemctl start nanoclaw-memory-daemon');
    }
  } finally {
    ingestDb.close();
  }
}

main().catch((err) => {
  console.error('reset-classifier-watermarks failed:', err);
  process.exit(1);
});
