import fs from 'fs';

const METRICS_PATH = '/workspace/agent/.mnemon-metrics.jsonl';

export interface TurnMetricRow {
  hook: 'prime' | 'remind' | 'nudge';
  store: string;
  latencyMs: number;
}

export function emitTurnMetric(row: TurnMetricRow): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event_type: 'turn',
    ...row,
  }) + '\n';
  try { fs.appendFileSync(METRICS_PATH, line); } catch { /* swallow per W2 */ }
}

export function emitUnhealthyEvent(store: string, reason: string): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event_type: 'unhealthy',
    store,
    reason,
  }) + '\n';
  try { fs.appendFileSync(METRICS_PATH, line); } catch { /* swallow */ }
}
