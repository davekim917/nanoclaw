/**
 * Fix: the router auto-creates messaging_groups with adapter-native platform_id
 * format (slack:<id>, not slack-illysium:<id>). Re-wire illysium-v2 agent to the
 * auto-created row and remove the wrong one.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb, getDb } from '../src/db/connection.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';

const CHANNEL_TYPE = 'slack-illysium';
const CORRECT_PLATFORM_ID = 'slack:C0ATLGJ4X60';
const WRONG_PLATFORM_ID = 'slack-illysium:C0ATLGJ4X60';
const AGENT_FOLDER = 'illysium-v2';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const db = getDb();
  const now = new Date().toISOString();

  const ag = getAgentGroupByFolder(AGENT_FOLDER);
  if (!ag) throw new Error(`agent group ${AGENT_FOLDER} not found`);

  const correctMg = getMessagingGroupByPlatform(CHANNEL_TYPE, CORRECT_PLATFORM_ID);
  const wrongMg = getMessagingGroupByPlatform(CHANNEL_TYPE, WRONG_PLATFORM_ID);

  if (!correctMg) throw new Error('correct mg not found — send a test message first');

  // 1. Wire agent to the correct (auto-created) mg if not already
  const wiring = getMessagingGroupAgentByPair(correctMg.id, ag.id);
  if (!wiring) {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: correctMg.id,
      agent_group_id: ag.id,
      trigger_rules: null,
      response_scope: 'all',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`Wired ${correctMg.id} -> ${ag.id}`);
  } else {
    console.log(`Wiring already correct: ${wiring.id}`);
  }

  // 2. Delete the wrong mg row + its wiring (if any)
  if (wrongMg) {
    db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(wrongMg.id);
    db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(wrongMg.id);
    console.log(`Removed wrong mg: ${wrongMg.id} (${WRONG_PLATFORM_ID})`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
