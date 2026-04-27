#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { GROUPS_DIR, DATA_DIR } from '../src/config.js';
import { readContainerConfig } from '../src/container-config.js';

const execFileP = promisify(execFile);

const STORES_DIR = path.join(DATA_DIR, 'mnemon-metrics', 'stores');
const HEALTH_FILE = path.join(DATA_DIR, 'mnemon-health.json');

// Turn metrics: container hooks write to /workspace/agent/.mnemon-metrics.jsonl which
// host-side maps to `groups/<folder>/.mnemon-metrics.jsonl` (see container-runner.ts:519).
const TURN_METRICS_FILENAME = '.mnemon-metrics.jsonl';

async function main() {
  fs.mkdirSync(STORES_DIR, { recursive: true });

  let folders: string[] = [];
  try {
    folders = fs.readdirSync(GROUPS_DIR);
  } catch (err) {
    console.error('Failed to read groups dir:', err);
  }

  for (const folder of folders) {
    let cfg: ReturnType<typeof readContainerConfig>;
    try {
      cfg = readContainerConfig(folder);
    } catch {
      continue;
    }
    if (!cfg.mnemon?.enabled || !cfg.agentGroupId) continue;
    const store = cfg.agentGroupId;
    try {
      const { stdout } = await execFileP('mnemon', ['status', '--store', store]);
      const status = JSON.parse(stdout) as Record<string, unknown>;
      const row = JSON.stringify({ ts: new Date().toISOString(), store, ...status }) + '\n';
      fs.appendFileSync(path.join(STORES_DIR, `${store}.jsonl`), row);
    } catch (err) {
      console.warn(`mnemon status failed for store ${store}:`, err);
    }
  }

  // Aggregate health from per-group turn metrics events (written by container hooks
  // to /workspace/agent/.mnemon-metrics.jsonl, mounted to groups/<folder>/.mnemon-metrics.jsonl).
  const health: Record<string, { phase: 'ok' | 'unhealthy'; recent_unhealthy_events: Array<{ ts: string; reason: string }> }> = {};
  for (const folder of folders) {
    let cfg: ReturnType<typeof readContainerConfig>;
    try {
      cfg = readContainerConfig(folder);
    } catch {
      continue;
    }
    if (!cfg.mnemon?.enabled || !cfg.agentGroupId) continue;
    const groupMetricsPath = path.join(GROUPS_DIR, folder, TURN_METRICS_FILENAME);
    if (!fs.existsSync(groupMetricsPath)) continue;
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(groupMetricsPath, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines.slice(-1000)) {
      try {
        const row = JSON.parse(line) as { event_type?: string; store?: string; ts?: string; reason?: string };
        if (row.event_type !== 'unhealthy') continue;
        // The wrapper writes `store` from MNEMON_STORE; container hooks write `store` from the agentGroupId.
        // Either way, fall back to the group's agentGroupId if missing so a malformed row still surfaces.
        const store = row.store ?? cfg.agentGroupId;
        health[store] ??= { phase: 'ok', recent_unhealthy_events: [] };
        health[store].recent_unhealthy_events.push({ ts: row.ts ?? '', reason: row.reason ?? '' });
      } catch {
        // skip malformed
      }
    }
  }

  // Classify stores: unhealthy if any event in last hour
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [, h] of Object.entries(health)) {
    const recent = h.recent_unhealthy_events.filter((e) => Date.parse(e.ts) > cutoff);
    h.recent_unhealthy_events = recent;
    h.phase = recent.length > 0 ? 'unhealthy' : 'ok';
  }

  fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2) + '\n');
  console.log(`Collector run complete. Stores checked: ${folders.length}. Health file: ${HEALTH_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
