#!/usr/bin/env tsx
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { mnemonBinaryAvailable } from '../src/modules/mnemon/binary.js';
import { writeFileAtomic } from '../src/modules/mnemon/index.js';
import { ensureStore } from '../src/modules/mnemon/store.js';
import { readContainerConfig, updateContainerConfig } from '../src/container-config.js';
import { scheduleTask } from '../src/db/scheduled-tasks.js';
import { initDb } from '../src/db/connection.js';
import { getMessagingGroupsByAgentGroup } from '../src/db/messaging-groups.js';

type Destination = { platformId: string; channelType: string; threadId: null };

function pickDestination(agentGroupId: string, folder: string): Destination | undefined {
  const wired = getMessagingGroupsByAgentGroup(agentGroupId);
  if (wired.length === 0) {
    console.warn(`[mnemon] no messaging groups wired to ${folder} — tasks will run silently (no chat output destination)`);
    return undefined;
  }
  if (wired.length > 1) {
    console.warn(
      `[mnemon] ${folder} is wired to ${wired.length} messaging groups; routing wiki output to first: ${wired[0].name ?? '(unnamed)'} (${wired[0].channel_type}:${wired[0].platform_id})`,
    );
  }
  return { platformId: wired[0].platform_id, channelType: wired[0].channel_type, threadId: null };
}

const PROJECT_ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'v2.db');

function nextRun(cron: string): string {
  try {
    const interval = CronExpressionParser.parse(cron, { tz: 'UTC' });
    return interval.next().toISOString();
  } catch {
    return new Date(Date.now() + 86400000).toISOString();
  }
}

const NOTABLE_RULE =
  '\n\nReport back ONLY if something notable happened: new wiki pages created, contradictions detected, or errors hit. If the run was a no-op or routine maintenance, exit silently — do NOT post "all clear" or "logged as no-op" messages. The operator will check the wiki/log.md if they want details.';

const SYNTH_PROMPT =
  'Read mnemon facts for this group. Update wiki pages compiled from mnemon insights. Append entry to wiki/log.md per the wiki container skill.' +
  NOTABLE_RULE;
const GC_PROMPT = "Run `mnemon gc` for this group's store. Review retention suggestions." + NOTABLE_RULE;
const RECONCILE_PROMPT =
  'Cross-check mnemon entity graph against wiki pages. Flag wiki pages whose entity has been deleted from mnemon for operator review.' +
  NOTABLE_RULE;

async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('usage: enable-mnemon.ts <group-folder>');
    process.exit(1);
  }

  if (!(await mnemonBinaryAvailable())) {
    console.error('mnemon binary not on host PATH. Install per docs/mnemon.md.');
    process.exit(1);
  }

  const cfg = readContainerConfig(folder);
  if (!cfg.agentGroupId) {
    console.error(`no agentGroupId in groups/${folder}/container.json`);
    process.exit(1);
  }
  const store = cfg.agentGroupId;

  initDb(DB_PATH);

  await ensureStore(store);

  const rolloutPath = path.join(PROJECT_ROOT, 'data', 'mnemon-rollout.json');
  let rollout: Record<string, unknown> = {};
  try {
    rollout = JSON.parse(fs.readFileSync(rolloutPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* missing is fine */
  }
  rollout[store] = { phase: 'shadow', enabled_at: new Date().toISOString(), graduated_at: null };
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  writeFileAtomic(rolloutPath, JSON.stringify(rollout, null, 2) + '\n');

  updateContainerConfig(folder, (config) => {
    config.mnemon = { enabled: true, embeddings: true };
  });

  const SYNTH_CRON = '0 3 * * *';
  const GC_CRON = '0 4 * * 0';
  const RECONCILE_CRON = '0 5 * * 0';

  const destination = pickDestination(store, folder);

  await scheduleTask({
    id: `mnemon-synth-${store}`,
    agentGroupId: store,
    cron: SYNTH_CRON,
    processAfter: nextRun(SYNTH_CRON),
    seriesId: `mnemon-synth-${store}`,
    prompt: SYNTH_PROMPT,
    destination,
    quietStatus: true,
  });
  await scheduleTask({
    id: `mnemon-gc-${store}`,
    agentGroupId: store,
    cron: GC_CRON,
    processAfter: nextRun(GC_CRON),
    seriesId: `mnemon-gc-${store}`,
    prompt: GC_PROMPT,
    destination,
    quietStatus: true,
  });
  await scheduleTask({
    id: `mnemon-reconcile-${store}`,
    agentGroupId: store,
    cron: RECONCILE_CRON,
    processAfter: nextRun(RECONCILE_CRON),
    seriesId: `mnemon-reconcile-${store}`,
    prompt: RECONCILE_PROMPT,
    destination,
    quietStatus: true,
  });

  console.log(`mnemon enabled for ${folder}. Phase 1 (shadow) active.`);
  console.log('Next: sudo systemctl restart nanoclaw-v2');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
