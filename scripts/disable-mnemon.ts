#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { readContainerConfig, updateContainerConfig } from '../src/container-config.js';
import { initDb } from '../src/db/connection.js';
import { findSessionByAgentGroup } from '../src/db/sessions.js';
import { DATA_DIR } from '../src/config.js';

const PROJECT_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'v2.db');

function cancelScheduledTasksForStore(store: string): void {
  const session = findSessionByAgentGroup(store);
  if (!session) {
    console.log(`  [disable] no active session for ${store} — skipping task cancellation`);
    return;
  }

  const inboundDbPath = path.join(DATA_DIR, 'v2-sessions', store, session.id, 'inbound.db');
  if (!fs.existsSync(inboundDbPath)) {
    console.log(`  [disable] inbound.db not found for session ${session.id} — skipping task cancellation`);
    return;
  }

  const db = new Database(inboundDbPath);
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  try {
    const seriesIds = [
      `mnemon-synth-${store}`,
      `mnemon-gc-${store}`,
      `mnemon-reconcile-${store}`,
    ];
    for (const seriesId of seriesIds) {
      const result = db
        .prepare(
          "UPDATE messages_in SET status = 'cancelled', recurrence = NULL WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')",
        )
        .run(seriesId);
      if (result.changes > 0) {
        console.log(`  [disable] cancelled task series: ${seriesId}`);
      }
    }
  } finally {
    db.close();
  }
}

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: disable-mnemon.ts <group-folder>');
    process.exit(1);
  }

  const cfg = readContainerConfig(folder);
  if (!cfg.agentGroupId) {
    console.error(`no agentGroupId in groups/${folder}/container.json`);
    process.exit(1);
  }
  const store = cfg.agentGroupId;

  initDb(DB_PATH);

  // Remove mnemon block from container.json entirely (not just set enabled=false).
  updateContainerConfig(folder, (config) => {
    delete config.mnemon;
  });
  console.log(`[disable] removed mnemon block from groups/${folder}/container.json`);

  // Remove the store entry from rollout JSON.
  const rolloutPath = path.join(PROJECT_ROOT, 'data', 'mnemon-rollout.json');
  try {
    const rollout = JSON.parse(fs.readFileSync(rolloutPath, 'utf8')) as Record<string, unknown>;
    delete rollout[store];
    fs.writeFileSync(rolloutPath, JSON.stringify(rollout, null, 2) + '\n');
    console.log(`[disable] removed ${store} from mnemon-rollout.json`);
  } catch {
    console.log('[disable] mnemon-rollout.json not found or empty — skipping');
  }

  // Cancel the three scheduled task series (does NOT delete mnemon store data).
  cancelScheduledTasksForStore(store);

  console.log(`mnemon disabled for ${folder}. Store data at ~/.mnemon/data/${store}/ is preserved.`);
  console.log('Next: sudo systemctl restart nanoclaw-v2');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
