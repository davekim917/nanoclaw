/**
 * Enable the memory integration for a single group.
 *
 * Usage: pnpm exec tsx scripts/enable-memory.ts <group-folder>
 *
 * Steps:
 *   1. Set memory.enabled = true in groups/<g>/container.json (atomic write).
 *   2. Bootstrap memory state via shared helper:
 *        a. Create the 7 sources subdirs (idempotent).
 *        b. Create the mnemon store for the agentGroupId if it doesn't exist.
 *        c. Schedule the daily synthesise task (idempotent via seriesId).
 *   3. Stop running containers for this group so the next inbound message
 *      respawns with MNEMON_STORE set.
 *
 * Side-effect bootstrap (step 2) is shared with `create_agent` so default-on
 * groups born via the delivery action get the same scaffolding. See
 * `scripts/lib/bootstrap-memory-for-group.ts` for why.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { bootstrapMemoryForGroup } from '../src/modules/memory/bootstrap.js';
import { restartGroupContainers } from './lib/restart-group-containers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: pnpm exec tsx scripts/enable-memory.ts <group-folder>');
    process.exit(1);
  }

  const groupDir = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(groupDir)) {
    console.error(`Group folder not found: ${groupDir}`);
    process.exit(1);
  }

  const containerJsonPath = path.join(groupDir, 'container.json');
  if (!fs.existsSync(containerJsonPath)) {
    console.error(`container.json not found: ${containerJsonPath}`);
    process.exit(1);
  }

  initDb(DB_PATH);

  // Step 1: container.json — set memory.enabled = true
  const raw = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8')) as Record<string, unknown>;
  const agentGroupId = raw.agentGroupId as string | undefined;
  if (!agentGroupId) {
    console.error(`container.json for '${folder}' is missing agentGroupId field`);
    process.exit(1);
  }

  raw.memory = { enabled: true };
  atomicWriteJson(containerJsonPath, raw);
  console.log(`[1/3] memory.enabled = true written to groups/${folder}/container.json`);

  // Step 2: shared bootstrap (sources/ + mnemon store + synth task)
  const r = await bootstrapMemoryForGroup(folder, agentGroupId);
  console.log(`[2/3] sources subdirs created/verified`);
  if (r.step2_mnemonStoreStatus === 'created') {
    console.log(`      mnemon store created for ${agentGroupId}`);
  } else if (r.step2_mnemonStoreStatus === 'exists') {
    console.log(`      mnemon store already exists for ${agentGroupId}`);
  } else if (r.step2_mnemonStoreStatus === 'binary-missing') {
    console.warn(`      Warning: mnemon binary not in PATH — store not created (${r.step2_mnemonStoreError})`);
  } else {
    console.warn(`      Warning: mnemon store create failed: ${r.step2_mnemonStoreError}`);
  }
  if (r.step3_synthTaskScheduled) {
    console.log(`      daily synth task scheduled (Opus + effort=high, seriesId: ${r.step3_synthSeriesId})`);
  } else {
    console.warn(`      Warning: synth task scheduling failed (re-run to retry)`);
  }

  // Step 3: restart any running container — see Codex F4 / F3 deferral notes
  // in scripts/lib/restart-group-containers.ts header.
  const restart = restartGroupContainers(folder);
  if (restart.errors.length > 0) {
    console.warn(`[3/3] container restart errors (best-effort): ${restart.errors.join('; ')}`);
  }
  if (restart.stopped > 0) {
    console.log(`[3/3] stopped ${restart.stopped} running container(s) — next inbound message respawns with capture hooks active`);
  } else {
    console.log(`[3/3] no running containers to restart`);
  }

  console.log(
    `\nMemory enabled for ${folder}.\n` +
      `  • Host daemon picks up the new watcher on its next 60s sweep.\n` +
      `  • The container respawns on the next inbound message with capture hooks wired.\n` +
      `\n` +
      `If you see no captures landing in groups/${folder}/sources/inbox/ after the next agent\n` +
      `tool call, a container may have started during the toggle window and missed MNEMON_STORE.\n` +
      `Re-run this script — it's idempotent and will catch the now-running container.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
