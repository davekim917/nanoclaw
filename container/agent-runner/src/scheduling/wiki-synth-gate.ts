import { Database } from 'bun:sqlite';

const DEFAULT_INBOUND_DB = '/workspace/inbound.db';
const DEFAULT_MNEMON_DATA_DIR = '/home/node/.mnemon/data';

interface LatestChangeRow {
  latest_change: string | null;
}

interface LastCompletedRow {
  last_completed_run: string | null;
}

export interface WikiSynthGateResult {
  wakeAgent: boolean;
  data: {
    reason: 'memory-changed' | 'no-memory-change';
    latestMemoryChange: string | null;
    lastCompletedRun: string | null;
    baselineAt: string | null;
  };
}

/**
 * Wake wiki synthesis only when Mnemon changed after the last successfully
 * completed occurrence of this task series.
 *
 * `process_after` is the occurrence start time, not its completion time. That
 * is deliberate: a fact written while synthesis is running remains newer than
 * the run and is picked up next time instead of being hidden by a later ack.
 */
export function evaluateWikiSynthGate(
  seriesId: string,
  mnemonDbPath: string,
  inboundDbPath: string = DEFAULT_INBOUND_DB,
  baselineAt: string | null = null,
): WikiSynthGateResult {
  const mnemon = new Database(mnemonDbPath, { readonly: true });
  const inbound = new Database(inboundDbPath, { readonly: true });

  try {
    const memory = mnemon
      .prepare(
        `SELECT MAX(changed_at) AS latest_change
           FROM (
             SELECT MAX(updated_at) AS changed_at FROM insights
             UNION ALL
             SELECT MAX(deleted_at) AS changed_at FROM insights
             UNION ALL
             SELECT MAX(created_at) AS changed_at FROM edges
             UNION ALL
             SELECT MAX(created_at) AS changed_at
               FROM oplog
              WHERE operation NOT LIKE 'recall%'
                AND operation NOT IN ('search', 'diff-skip')
           )`,
      )
      .get() as LatestChangeRow;
    const task = inbound
      .prepare(
        `SELECT MAX(process_after) AS last_completed_run
           FROM messages_in
          WHERE kind = 'task'
            AND series_id = ?
            AND status = 'completed'`,
      )
      .get(seriesId) as LastCompletedRow;

    const latestMemoryChange = memory.latest_change;
    const lastCompletedRun = task.last_completed_run;
    const comparisonBoundary = lastCompletedRun ?? baselineAt;
    const latestMs = latestMemoryChange ? Date.parse(latestMemoryChange) : Number.NaN;
    const boundaryMs = comparisonBoundary ? Date.parse(comparisonBoundary) : Number.NaN;

    if (latestMemoryChange && Number.isNaN(latestMs)) {
      throw new Error(`invalid Mnemon timestamp: ${latestMemoryChange}`);
    }
    if (comparisonBoundary && Number.isNaN(boundaryMs)) {
      throw new Error(`invalid synthesis boundary: ${comparisonBoundary}`);
    }

    const wakeAgent = latestMemoryChange !== null && (comparisonBoundary === null || latestMs > boundaryMs);
    return {
      wakeAgent,
      data: {
        reason: wakeAgent ? 'memory-changed' : 'no-memory-change',
        latestMemoryChange,
        lastCompletedRun,
        baselineAt,
      },
    };
  } finally {
    inbound.close();
    mnemon.close();
  }
}

function main(): void {
  const seriesId = process.argv[2];
  const baselineAt = process.argv[3] ?? null;
  const store = process.env.MNEMON_STORE;
  if (!seriesId) throw new Error('wiki synth gate requires a task series id');
  if (!store || !/^[a-zA-Z0-9_-]+$/.test(store)) throw new Error('MNEMON_STORE is missing or invalid');

  const mnemonDbPath = `${DEFAULT_MNEMON_DATA_DIR}/${store}/mnemon.db`;
  console.log(JSON.stringify(evaluateWikiSynthGate(seriesId, mnemonDbPath, DEFAULT_INBOUND_DB, baselineAt)));
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    // Fail open: a broken gate must not silently suppress memory maintenance.
    console.log(
      JSON.stringify({
        wakeAgent: true,
        data: { gateError: err instanceof Error ? err.message : String(err) },
      }),
    );
  }
}
