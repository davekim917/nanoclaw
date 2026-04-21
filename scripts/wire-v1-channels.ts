/**
 * Wire V1 channels to V2 — run once after V1→V2 migration.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../src/db/connection.js';
import {
  createAgentGroup,
  getAgentGroupByFolder,
} from '../src/db/agent-groups.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
} from '../src/db/messaging-groups.js';
import { writeContainerConfig, initContainerConfig } from '../src/container-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

function ensureFolderAndConfig(folder: string, containerConfig?: Record<string, unknown>): void {
  const folderPath = path.join(GROUPS_DIR, folder);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    console.log(`  [folder] created: ${folder}/`);
  } else {
    console.log(`  [folder] exists: ${folder}/`);
  }

  initContainerConfig(folder);

  if (containerConfig) {
    const existing = fs.existsSync(path.join(GROUPS_DIR, folder, 'container.json'))
      ? JSON.parse(fs.readFileSync(path.join(GROUPS_DIR, folder, 'container.json'), 'utf8'))
      : { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [] };
    const merged = { ...existing, ...containerConfig };
    writeContainerConfig(folder, merged);
    console.log(`  [container.json] written for ${folder}`);
  }
}

function getOrCreateAgentGroup(folder: string, name: string): string {
  const existing = getAgentGroupByFolder(folder);
  if (existing) {
    console.log(`  [agent-group] already exists: ${folder} → ${existing.id}`);
    return existing.id;
  }
  const id = generateId('ag');
  createAgentGroup({ id, name, folder, agent_provider: null, created_at: now() });
  console.log(`  [agent-group] created: ${name} (${folder}) → ${id}`);
  return id;
}

function wireChannel(
  channelType: string,
  platformId: string,
  name: string,
  agentGroupId: string,
  isGroup: number,
): void {
  const existing = getMessagingGroupByPlatform(channelType, platformId);
  let mgId: string;
  if (existing) {
    mgId = existing.id;
    console.log(`  [messaging-group] already exists: ${name} → ${mgId}`);
  } else {
    mgId = generateId('mg');
    createMessagingGroup({
      id: mgId, channel_type: channelType, platform_id: platformId,
      name, is_group: isGroup, unknown_sender_policy: 'public', created_at: now(),
    });
    console.log(`  [messaging-group] created: ${name} → ${mgId}`);
  }

  const wiring = getMessagingGroupAgentByPair(mgId, agentGroupId);
  if (wiring) {
    console.log(`  [wiring] already exists: ${mgId} → ${agentGroupId}`);
  } else {
    const wiringId = generateId('mga');
    createMessagingGroupAgent({
      id: wiringId, messaging_group_id: mgId, agent_group_id: agentGroupId,
      engage_mode: 'mention', engage_pattern: null, sender_scope: 'all',
      ignored_message_policy: 'drop', session_mode: 'per-thread',
      priority: 0, default_model: null, default_effort: null, created_at: now(),
    });
    console.log(`  [wiring] created: ${mgId} → ${agentGroupId}`);
  }
}

function addDestination(agentGroupId: string, localName: string, targetId: string): void {
  const db = getDb();
  const existing = db.prepare(
    'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND local_name = ?'
  ).get(agentGroupId, localName);
  if (existing) {
    console.log(`  [destination] already exists: ${localName} → ${targetId}`);
    return;
  }
  db.prepare(
    'INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(agentGroupId, localName, 'channel', targetId, now());
  console.log(`  [destination] added: ${localName} → ${targetId}`);
}

async function main() {
  console.log('\n=== V1 → V2 Channel Wiring ===\n');

  const dbPath = path.join(PROJECT_ROOT, 'data', 'v2.db');
  initDb(dbPath);
  console.log('[db] initialized\n');

  const illieV2Id = 'ag-1776377699463-2axxhg';
  const discordMainMgId = 'mg-1776404343731-7041k0';

  // 1. Discord main → wire illie-v2
  console.log('--- Discord main → illie-v2 ---');
  wireChannel('discord', 'discord:1479489865702703155:1479489866193571902', 'main', illieV2Id, 0);
  addDestination(illieV2Id, 'discord-main', discordMainMgId);
  console.log('');

  // 2. Missing agent groups
  const groupsToCreate = [
    {
      folder: 'dirt-market', name: 'Dirtmarket',
      discordChannelId: 'discord:1479489865702703155:1479517125369659474',
      tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'railway', 'exa'],
    },
    {
      folder: 'xerus', name: 'Xerus',
      discordChannelId: 'discord:1479489865702703155:1479516870867550250',
      tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'exa'],
    },
    {
      folder: 'number-drinks', name: 'Number Drinks',
      discordChannelId: 'discord:1479489865702703155:1479517050249412739',
      tools: ['gmail:numberdrinks', 'calendar', 'granola', 'google-workspace', 'exa'],
    },
    {
      folder: 'axis-labs', name: 'Axis Labs',
      discordChannelId: 'discord:1479489865702703155:1479520261081665587',
      tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'railway', 'exa',
              'snowflake', 'aws', 'gcloud', 'dbt', 'render', 'browser-auth', 'github'],
    },
    {
      folder: 'video-agent', name: 'Video Agent',
      discordChannelId: 'discord:1493845672603160638:1493845672603160638',
      additionalMounts: [{ hostPath: '/home/ubuntu/video-agent', containerPath: 'video-agent', readonly: false }],
    },
  ];

  for (const g of groupsToCreate) {
    console.log(`--- Agent group: ${g.name} (${g.folder}) ---`);
    const config: Record<string, unknown> = { gitnexusInjectAgentsMd: true };
    if (g.tools) config.tools = g.tools;
    if (g.additionalMounts) config.additionalMounts = g.additionalMounts;
    ensureFolderAndConfig(g.folder, config);
    const agId = getOrCreateAgentGroup(g.folder, g.name);
    wireChannel('discord', g.discordChannelId, g.folder, agId, 1);
    console.log('');
  }

  // 3. Missing Slack channels
  console.log('--- Missing Slack channels ---');

  // apollo-dataops, promoraven → slack-illysium workspace, illie-v2
  wireChannel('slack-illysium', 'slack:C08NABQNXFY', 'apollo-dataops', illieV2Id, 1);
  wireChannel('slack-illysium', 'slack:C08HA74QZT4', 'promoraven', illieV2Id, 1);

  // data-team, dataops → primary slack workspace (these are Sunday workspace but
  // we skipped Sunday; wire to illie-v2 for now so they're reachable)
  wireChannel('slack', 'slack:C04KSK2E2UV', 'data-team', illieV2Id, 1);
  wireChannel('slack', 'slack:C02ERDGV0A2', 'dataops', illieV2Id, 1);
  console.log('');

  // 4. Agent destinations for notifyJid
  console.log('--- Agent destinations (notifyJid) ---');
  const agentsXzoMg = getMessagingGroupByPlatform('slack', 'slack:C0AJA89MN2E');
  if (agentsXzoMg) addDestination(illieV2Id, 'slack-agents-xzo', agentsXzoMg.id);

  const xzoMg = getMessagingGroupByPlatform('slack', 'slack:C09GBH38ZSS');
  if (xzoMg) addDestination(illieV2Id, 'slack-xzo', xzoMg.id);
  console.log('');

  // 5. Summary
  console.log('=== Wiring Complete ===\n');
  const db = getDb();
  const agentGroups = db.prepare('SELECT name, folder, id FROM agent_groups ORDER BY name').all();
  const wiring = db.prepare(`
    SELECT mg.channel_type, mg.name as mg_name, ag.name as ag_name
    FROM messaging_group_agents mga
    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    JOIN agent_groups ag ON ag.id = mga.agent_group_id
    ORDER BY mg.channel_type, mg.name
  `).all();

  console.log(`Agent Groups (${agentGroups.length}):`);
  for (const ag of agentGroups as any[]) console.log(`  ${ag.name} (${ag.folder})`);

  console.log(`\nWiring (${wiring.length} channels):`);
  for (const w of wiring as any[]) console.log(`  ${w.channel_type}: ${w.mg_name} → ${w.ag_name}`);
  console.log('');
}

main().catch(console.error);
