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

const SYNTH_PROMPT =
  'Read mnemon facts for this group. Update wiki pages compiled from mnemon insights. Append entry to wiki/log.md per the wiki container skill.';
const GC_PROMPT = "Run `mnemon gc` for this group's store. Review retention suggestions and report back.";
const RECONCILE_PROMPT =
  'Cross-check mnemon entity graph against wiki pages. Flag wiki pages whose entity has been deleted from mnemon for operator review.';

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

  await scheduleTask({
    id: `mnemon-synth-${store}`,
    agentGroupId: store,
    cron: SYNTH_CRON,
    processAfter: nextRun(SYNTH_CRON),
    seriesId: `mnemon-synth-${store}`,
    prompt: SYNTH_PROMPT,
  });
  await scheduleTask({
    id: `mnemon-gc-${store}`,
    agentGroupId: store,
    cron: GC_CRON,
    processAfter: nextRun(GC_CRON),
    seriesId: `mnemon-gc-${store}`,
    prompt: GC_PROMPT,
  });
  await scheduleTask({
    id: `mnemon-reconcile-${store}`,
    agentGroupId: store,
    cron: RECONCILE_CRON,
    processAfter: nextRun(RECONCILE_CRON),
    seriesId: `mnemon-reconcile-${store}`,
    prompt: RECONCILE_PROMPT,
  });

  console.log(`mnemon enabled for ${folder}. Phase 1 (shadow) active.`);
  console.log('Next: sudo systemctl restart nanoclaw-v2');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
