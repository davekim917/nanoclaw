/**
 * Idempotently update the existing Monday #axie-dev package advisory.
 * A deterministic pre-task audit suppresses the model entirely on a clean run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { scheduleTask, type TaskDef } from '../src/db/scheduled-tasks.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_GROUP_ID = 'ag-1776735605480-ymhokes';
const CHANNEL_PLATFORM_ID = 'discord:1479489865702703155:1491839654528548989';
// Preserve the live series identity so rerunning this script updates, not duplicates, it.
const SERIES_ID = 'task-1782756339349-y4fdli';
const script = fs.readFileSync(path.join(repoRoot, 'scripts/container-updates-precheck.sh'), 'utf8');

export const prompt = `You are running the weekly latest-stable dependency advisory. The deterministic shared audit already ran; scriptOutput is its complete source of truth.

Post exactly one concise advisory to #axie-dev. Do not re-query registries, inspect manifests, edit files, open PRs, merge, deploy, or restart anything.

Group outdated items by surface: host, container, bootstrap, and plugins. For each, show current -> latest and include the audit item ID. Plugin items are clones under ~/plugins tracked by their .claude-plugin/plugin.json version; they are updated with git pull in the clone, not by /update-container. Call out unknown/blocked items with their exact diagnostic; never describe them as current. If Graphify appears, state whether it is a routine version bump or requires Graphify review based on the diagnostic.

End with: "Run /update-container to choose and prepare reviewed PRs." This scheduled task is advisory only.`;

export function taskDefinition(): TaskDef {
  return {
    id: SERIES_ID,
    agentGroupId: AGENT_GROUP_ID,
    cron: '0 14 * * 1',
    processAfter: '2026-07-20T18:00:00.000Z',
    seriesId: SERIES_ID,
    prompt,
    script,
    quietStatus: true,
    destination: { platformId: CHANNEL_PLATFORM_ID, channelType: 'discord', threadId: null },
  };
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const def = taskDefinition();
  await scheduleTask(def);
  console.log(`Scheduled ${SERIES_ID} on ${AGENT_GROUP_ID} -> #axie-dev (${def.cron}, quietStatus=true)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
