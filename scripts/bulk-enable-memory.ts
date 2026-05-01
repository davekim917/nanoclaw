/**
 * Bulk-enable the memory integration across all groups under groups/.
 *
 * Usage: pnpm exec tsx scripts/bulk-enable-memory.ts
 *
 * Differs from enable-memory.ts (single-group) in three ways:
 *
 *   1. Iterates every directory under groups/ that has a container.json with
 *      an agentGroupId. Skips groups already memory-enabled.
 *   2. Staggers synth-task processAfter offsets across groups (Codex F6) so
 *      the first run of the daily Opus/high synth task fires at most one
 *      group at a time, not 11 simultaneous.
 *   3. Two-pass docker-stop with a settle window (architecture-advisor
 *      recommendation): stop containers immediately, wait 30s for any
 *      in-flight spawns to land, stop the now-running containers a second
 *      time. Closes most of the spawn-race window without coordinated
 *      locking (Codex F3 deferral).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { GROUPS_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { bootstrapMemoryForGroup } from '../src/modules/memory/bootstrap.js';
import { restartGroupContainers } from './lib/restart-group-containers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'v2.db');

// 5-minute spacing between groups; 11 groups → max 55min of stagger.
// Each fired synth turn takes ~2-5min on Opus/high, so this also bounds
// peak concurrent classifier-host load to one group at a time.
// Per-group cron is e.g. "3 3 * * *", "8 3 * * *", "13 3 * * *" — picking
// non-:00 minutes is also good API-wide jitter etiquette.
const STAGGER_INTERVAL_MINUTES = 5;
const STAGGER_FIRST_MINUTE = 3; // start at 03:03, then 03:08, 03:13, ...
// Settle window before the second-pass restart. Long enough for an in-flight
// spawn to complete `docker run` (typically 1-3s) plus a safety margin.
const SETTLE_SECONDS = 30;

interface CandidateGroup {
  folder: string;
  agentGroupId: string;
  alreadyEnabled: boolean;
}

function synthCronForIndex(i: number): string {
  // Distributes across 03:03–03:53 in 5-min steps. Up to 11 groups fits.
  const minute = STAGGER_FIRST_MINUTE + (i % 11) * STAGGER_INTERVAL_MINUTES;
  return `${minute} 3 * * *`;
}

function lintCronForIndex(i: number): string {
  // Same stagger pattern as synth, except weekly: Sundays 10:03–10:53 ET.
  // Avoids 11+ Opus calls firing simultaneously every Sunday morning.
  const minute = STAGGER_FIRST_MINUTE + (i % 11) * STAGGER_INTERVAL_MINUTES;
  return `${minute} 10 * * 0`;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Discover every group under groups/ and resolve its agentGroupId. If
 * container.json lacks the field (Codex F8 — observed for video-agent and
 * xerus on this install), backfill it by looking up the folder name in the
 * central DB and writing the value back. Skip a group only if NEITHER the
 * file nor the DB knows the ID — that's a genuinely orphan folder.
 */
function discoverGroups(): CandidateGroup[] {
  const out: CandidateGroup[] = [];
  for (const entry of fs.readdirSync(GROUPS_DIR)) {
    const dir = path.join(GROUPS_DIR, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const containerJsonPath = path.join(dir, 'container.json');
    if (!fs.existsSync(containerJsonPath)) continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8')) as Record<string, unknown>;
    } catch {
      console.warn(`  skipping ${entry}: container.json is not valid JSON`);
      continue;
    }

    let agentGroupId = raw.agentGroupId as string | undefined;
    if (!agentGroupId) {
      // F8 backfill: look up by folder name in the central DB.
      const dbRow = getAgentGroupByFolder(entry);
      if (!dbRow) {
        console.warn(`  skipping ${entry}: no agentGroupId in container.json AND no row in agent_groups for this folder`);
        continue;
      }
      agentGroupId = dbRow.id;
      raw.agentGroupId = agentGroupId;
      atomicWriteJson(containerJsonPath, raw);
      console.log(`  • ${entry}: backfilled agentGroupId=${agentGroupId} from agent_groups`);
    }

    const alreadyEnabled = ((raw.memory as Record<string, unknown> | undefined)?.enabled as boolean | undefined) === true;
    out.push({ folder: entry, agentGroupId, alreadyEnabled });
  }
  return out;
}

async function main(): Promise<void> {
  initDb(DB_PATH);

  const groups = discoverGroups();
  console.log(`Discovered ${groups.length} groups under ${GROUPS_DIR}`);
  const newlyEnabled = groups.filter((g) => !g.alreadyEnabled);
  const reconcile = groups.filter((g) => g.alreadyEnabled);
  console.log(`  ${newlyEnabled.length} to flip on, ${reconcile.length} already enabled (will reconcile bootstrap state)`);

  if (groups.length === 0) {
    console.log('No groups discovered. Nothing to do.');
    return;
  }

  // F7 fix: reconcile EVERY group, not just newly-enabled ones. If a previous
  // run died after writing memory.enabled=true but before bootstrap completed,
  // skipping alreadyEnabled groups would silently abandon the partially-
  // bootstrapped group. bootstrap is fully idempotent (mkdir -p, mnemon
  // already-exists, scheduleTask upsert), so re-running it is cheap and safe.
  // Per-group cron from synthCronForIndex distributes daily fires across
  // 03:03–03:53 — F6 fix: cron itself is staggered, not just first processAfter.
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const synthCron = synthCronForIndex(i);
    const lintCron = lintCronForIndex(i);
    const tag = g.alreadyEnabled ? 'reconcile' : 'enable';
    console.log(
      `\n[${i + 1}/${groups.length}] ${g.folder} (${tag}, agentGroupId=${g.agentGroupId}, synth='${synthCron}', lint='${lintCron}')`,
    );

    // Step 1: container.json — write memory.enabled=true (idempotent: re-write
    // is a no-op when already true). Persist agentGroupId here too in case
    // discoverGroups backfilled it (atomicWriteJson is one-shot).
    const containerJsonPath = path.join(GROUPS_DIR, g.folder, 'container.json');
    const raw = JSON.parse(fs.readFileSync(containerJsonPath, 'utf8')) as Record<string, unknown>;
    raw.memory = { enabled: true };
    raw.agentGroupId = g.agentGroupId;
    atomicWriteJson(containerJsonPath, raw);
    console.log(`  • memory.enabled = true`);

    // Step 2: shared bootstrap (sources subdirs, mnemon store, synth + lint tasks with per-group crons)
    const bs = await bootstrapMemoryForGroup(g.folder, g.agentGroupId, { synthCron, lintCron });
    console.log(`  • sources subdirs: ok`);
    console.log(`  • mnemon store: ${bs.step2_mnemonStoreStatus}${bs.step2_mnemonStoreError ? ` (${bs.step2_mnemonStoreError.trim()})` : ''}`);
    console.log(`  • synth task: ${bs.step3_synthTaskScheduled ? `scheduled (cron='${bs.step3_synthCron}')` : 'FAILED — re-run to retry'}`);
    console.log(`  • lint task:  ${bs.step4_lintTaskScheduled ? `scheduled (cron='${bs.step4_lintCron}')` : 'FAILED — re-run to retry'}`);

    // Step 3: first-pass docker stop
    const r1 = restartGroupContainers(g.folder);
    if (r1.errors.length > 0) console.warn(`  • restart errors (best-effort): ${r1.errors.join('; ')}`);
    console.log(`  • first-pass restart: stopped ${r1.stopped} container(s)`);
  }

  // Pass 2: settle + second-pass docker stop. Codex F3 mitigation — catches
  // any container that was mid-spawn during pass 1 and started after our
  // first docker stop. Architecture-advisor recommended this two-pass
  // pattern as the cheapest way to close the race without introducing
  // coordinated locking.
  console.log(`\nSettle window: waiting ${SETTLE_SECONDS}s for any in-flight spawns to land before second-pass restart…`);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_SECONDS * 1000));

  console.log(`Second-pass restart across all groups:`);
  for (const g of groups) {
    const r2 = restartGroupContainers(g.folder);
    if (r2.errors.length > 0) console.warn(`  • ${g.folder}: errors ${r2.errors.join('; ')}`);
    if (r2.stopped > 0) console.log(`  • ${g.folder}: stopped ${r2.stopped} late-spawning container(s)`);
  }

  console.log(
    `\nBulk enable complete.\n` +
      `  • ${groups.length} groups reconciled (${newlyEnabled.length} newly enabled, ${reconcile.length} re-bootstrapped).\n` +
      `  • Synth tasks distributed across 03:03–03:53 local time, ${STAGGER_INTERVAL_MINUTES}min apart.\n` +
      `  • Memory daemon picks up new watchers on its next 60s sweep.\n` +
      `\n` +
      `If you see a group with no captures landing in groups/<folder>/sources/inbox/ after\n` +
      `the next agent tool call, re-run scripts/enable-memory.ts <folder>. The single-group\n` +
      `script is idempotent and will catch any container that started during the toggle.`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
