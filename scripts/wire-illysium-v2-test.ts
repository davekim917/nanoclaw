/**
 * One-off: wire illie-v2 to Slack channel #illie-v2-test as agent group illysium-v2.
 * Runs against the live v2.db (WAL-safe alongside the service).
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { grantRole, hasAnyOwner } from '../src/db/user-roles.js';
import { upsertUser } from '../src/db/users.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

const CHANNEL_TYPE = 'slack-illysium';
const CHANNEL_ID = 'C0ATLGJ4X60';
const PLATFORM_ID = `${CHANNEL_TYPE}:${CHANNEL_ID}`;
const OWNER_USER_ID = `${CHANNEL_TYPE}:U08H7SULNER`;
const OWNER_DISPLAY = 'Dave';
const AGENT_FOLDER = 'illysium-v2';
const AGENT_NAME = 'illie-v2';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const now = new Date().toISOString();

  // 1. Owner user + role
  upsertUser({
    id: OWNER_USER_ID,
    kind: CHANNEL_TYPE,
    display_name: OWNER_DISPLAY,
    created_at: now,
  });
  let promoted = false;
  if (!hasAnyOwner()) {
    grantRole({
      user_id: OWNER_USER_ID,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    promoted = true;
  }

  // 2. Agent group
  let ag: AgentGroup | undefined = getAgentGroupByFolder(AGENT_FOLDER);
  if (!ag) {
    createAgentGroup({
      id: genId('ag'),
      name: AGENT_NAME,
      folder: AGENT_FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(AGENT_FOLDER)!;
    console.log(`Created agent group: ${ag.id} (${AGENT_FOLDER})`);
  } else {
    console.log(`Reusing agent group: ${ag.id} (${AGENT_FOLDER})`);
  }
  initGroupFilesystem(ag, {
    instructions:
      `# ${AGENT_NAME}\n\n` +
      `You are ${AGENT_NAME}, a v2 migration test agent for the Illysium Slack workspace. ` +
      `You're running side-by-side with the v1 agent (illie) for validation. Keep responses concise ` +
      `and helpful. If asked about v1 vs v2 differences, be honest about what's changed.`,
  });

  // 3. Messaging group (channel, not DM)
  let mg = getMessagingGroupByPlatform(CHANNEL_TYPE, PLATFORM_ID);
  if (!mg) {
    createMessagingGroup({
      id: genId('mg'),
      channel_type: CHANNEL_TYPE,
      platform_id: PLATFORM_ID,
      name: '#illie-v2-test',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(CHANNEL_TYPE, PLATFORM_ID)!;
    console.log(`Created messaging group: ${mg.id} (${PLATFORM_ID})`);
  } else {
    console.log(`Reusing messaging group: ${mg.id} (${PLATFORM_ID})`);
  }

  // 4. Wire
  const existing = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      trigger_rules: null,
      response_scope: 'all',
      session_mode: 'shared',
      priority: 0,
      default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: now,
    });
    console.log(`Wired ${mg.id} -> ${ag.id}`);
  } else {
    console.log(`Wiring already exists: ${existing.id}`);
  }

  console.log('');
  console.log('Done.');
  console.log(`  owner:  ${OWNER_USER_ID}${promoted ? ' (promoted on first owner)' : ''}`);
  console.log(`  agent:  ${AGENT_NAME} [${ag.id}] @ groups/${AGENT_FOLDER}`);
  console.log(`  wired:  ${CHANNEL_TYPE} ${PLATFORM_ID}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
