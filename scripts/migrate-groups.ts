/**
 * Clean migration: 9 Discord agent groups (one per channel) + 1 Slack illysium group.
 *
 * Steps:
 * 1. Remove dead channels + their sessions
 * 2. Rename existing agent groups: 'illie'→'illysium' (folder already correct), 'Axie'→'main' (folder already correct)
 * 3. Create remaining agent groups (number, axis-labs, axie-dev, madison-reed, dirtmarket, xerus, video-agent)
 * 4. Ensure folder + container.json for all groups
 * 5. Delete orphaned sessions (old Discord sessions still pointing to wrong agent groups)
 * 6. Wire all channels correctly
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { initDb, getDb } from '../src/db/connection.js';
import { createAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../src/db/agent-groups.js';
import { writeContainerConfig } from '../src/container-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

function now() { return new Date().toISOString(); }
function genId(prefix: string) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`; }

// V1 container configs per folder
const GROUP_CONFIGS: Record<string, { tools?: string[]; gitnexusInjectAgentsMd?: boolean; additionalMounts?: Array<{hostPath:string;containerPath:string;readonly?:boolean}> }> = {
  'main': {
    tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'railway', 'exa'],
    gitnexusInjectAgentsMd: true,
  },
  'illysium': {
    tools: [
      'gmail-readonly:illysium', 'calendar:illysium', 'github:illysium', 'granola',
      'snowflake:apollo', 'snowflake:apollo_wgs', 'snowflake:xzo_dev', 'snowflake:xzo_prod',
      'dbt:apollo-snowflake', 'dbt:xzo-snowflake',
      'google-workspace:illysium', 'render:illysium', 'exa',
      'browser-auth:illyse', 'aws:xzo', 'aws:apollo',
    ],
    gitnexusInjectAgentsMd: true,
  },
  'number-drinks': {
    tools: ['gmail:numberdrinks', 'calendar', 'granola', 'google-workspace', 'exa'],
    gitnexusInjectAgentsMd: true,
  },
  'axis-labs': {
    tools: [
      'gmail', 'calendar', 'granola', 'google-workspace', 'railway', 'exa',
      'snowflake', 'aws', 'gcloud', 'dbt', 'render', 'browser-auth', 'github',
    ],
    gitnexusInjectAgentsMd: true,
  },
  'axie-dev': {
    tools: [],
    gitnexusInjectAgentsMd: true,
  },
  'madison-reed': {
    tools: ['gmail:madison-reed', 'calendar:madison-reed', 'granola', 'google-workspace:madison-reed', 'exa'],
    gitnexusInjectAgentsMd: true,
  },
  'dirt-market': {
    tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'railway', 'exa'],
    gitnexusInjectAgentsMd: true,
  },
  'xerus': {
    tools: ['gmail', 'calendar', 'granola', 'google-workspace', 'exa'],
    gitnexusInjectAgentsMd: true,
  },
  'video-agent': {
    tools: [],
    additionalMounts: [{ hostPath: '/home/ubuntu/video-agent', containerPath: 'video-agent', readonly: false }],
  },
};

// Channel → agent group folder wiring
const CHANNEL_WIRING = [
  // Discord — each channel gets its own agent group
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479489866193571902', name: 'main',         folder: 'main',         isGroup: 0 },
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479516831168593974', name: 'illysium',    folder: 'illysium',    isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479517050249412739', name: 'number',      folder: 'number-drinks', isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479520261081665587', name: 'axis-labs',   folder: 'axis-labs',   isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1491839654528548989:1491839654528548989', name: 'axie-dev',    folder: 'axie-dev',    isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1491825196087377960:1491825196087377960', name: 'madison-reed',folder: 'madison-reed', isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479517125369659474', name: 'dirtmarket', folder: 'dirt-market', isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479516870867550250', name: 'xerus',       folder: 'xerus',       isGroup: 1 },
  { channelType: 'discord', platformId: 'discord:1493845672603160638:1493845672603160638', name: 'video-agent', folder: 'video-agent', isGroup: 1 },
  // Slack illysium — all point to illysium agent group
  { channelType: 'slack-illysium', platformId: 'slack:C08NABQNXFY', name: 'apollo-dataops', folder: 'illysium', isGroup: 1 },
  { channelType: 'slack-illysium', platformId: 'slack:C08HA74QZT4', name: 'promoraven',     folder: 'illysium', isGroup: 1 },
  { channelType: 'slack-illysium', platformId: 'slack:C09GBH38ZSS', name: 'xzo',           folder: 'illysium', isGroup: 1 },
  { channelType: 'slack-illysium', platformId: 'slack:C0AJA89MN2E', name: 'agents-xzo',    folder: 'illysium', isGroup: 1 },
];

const REMOVE_CHANNELS = [
  { channelType: 'discord', platformId: 'discord:1479489865702703155:1479516849371873403', name: 'sunday' },
  { channelType: 'slack',   platformId: 'slack:C02ERDGV0A2', name: 'dataops' },
  { channelType: 'slack',   platformId: 'slack:C04KSK2E2UV', name: 'data-team' },
  { channelType: 'slack-illysium', platformId: 'slack:C0ATLGJ4X60', name: 'illie-v2-test' },
];

async function main() {
  initDb(path.join(PROJECT_ROOT, 'data', 'v2.db'));
  const db = getDb();

  // ── 0. Remove dead channels + their sessions ─────────────────────────────
  console.log('=== Remove dead channels ===');
  for (const ch of REMOVE_CHANNELS) {
    const mg = db.prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?').get(ch.channelType, ch.platformId) as { id: string } | undefined;
    if (mg) {
      db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(mg.id);
      db.prepare('DELETE FROM sessions WHERE messaging_group_id = ?').run(mg.id);
      db.prepare('DELETE FROM agent_destinations WHERE target_id = ?').run(mg.id);
      db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mg.id);
      console.log(`  Removed: ${ch.channelType}:${ch.name}`);
    } else {
      console.log(`  Not found: ${ch.channelType}:${ch.name}`);
    }
  }

  // ── 1. Rename existing agent groups to match folder names ───────────────
  console.log('\n=== Rename agent groups ===');
  const ags = getAllAgentGroups() as any[];
  for (const ag of ags) {
    if (ag.folder === 'illysium' && ag.name !== 'illysium') {
      db.prepare('UPDATE agent_groups SET name = ? WHERE id = ?').run('illysium', ag.id);
      console.log(`  Renamed: '${ag.name}' → 'illysium' (${ag.id})`);
    } else if (ag.folder === 'main' && ag.name !== 'main') {
      db.prepare('UPDATE agent_groups SET name = ? WHERE id = ?').run('main', ag.id);
      console.log(`  Renamed: '${ag.name}' → 'main' (${ag.id})`);
    } else {
      console.log(`  Unchanged: ${ag.name} (${ag.folder})`);
    }
  }

  // ── 2. Create remaining agent groups ──────────────────────────────────
  console.log('\n=== Create agent groups ===');
  const existingFolders = new Set((getAllAgentGroups() as any[]).map((ag: any) => ag.folder));
  for (const folder of Object.keys(GROUP_CONFIGS)) {
    if (existingFolders.has(folder)) {
      console.log(`  Exists: ${folder}`);
    } else {
      const id = genId('ag');
      createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: now() });
      console.log(`  Created: ${folder} → ${id}`);
    }
  }

  // ── 3. Ensure folders + container.json ─────────────────────────────────
  console.log('\n=== Folders + container.json ===');
  for (const folder of Object.keys(GROUP_CONFIGS)) {
    const folderPath = path.join(GROUPS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
      console.log(`  Created folder: ${folder}/`);
    } else {
      console.log(`  Folder exists: ${folder}/`);
    }

    const cfg = GROUP_CONFIGS[folder];
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      ...(cfg.tools !== undefined ? { tools: cfg.tools } : {}),
      gitnexusInjectAgentsMd: cfg.gitnexusInjectAgentsMd ?? false,
      ...(cfg.additionalMounts ? { additionalMounts: cfg.additionalMounts } : {}),
    };
    writeContainerConfig(folder, config);
    console.log(`  container.json: ${folder}`);
  }

  // ── 4. Remove duplicate slack channels (were on wrong workspace) ──────────
  console.log('\n=== Remove duplicate Slack MGs (channel_type=slack) ===');
  const dupSlackMgs = (db.prepare("SELECT id, name FROM messaging_groups WHERE channel_type = 'slack'").all() as any[]);
  for (const mg of dupSlackMgs) {
    db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(mg.id);
    db.prepare('DELETE FROM sessions WHERE messaging_group_id = ?').run(mg.id);
    db.prepare('DELETE FROM agent_destinations WHERE target_id = ?').run(mg.id);
    db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(mg.id);
    console.log(`  Removed: slack:${mg.name} (${mg.id})`);
  }

  // ── 5. Clear Discord wiring + re-wire ──────────────────────────────────
  console.log('\n=== Wire all channels ===');
  db.prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id IN (
    SELECT id FROM messaging_groups WHERE channel_type = 'discord'
  )`).run();
  console.log('  Cleared Discord wiring');

  for (const ch of CHANNEL_WIRING) {
    const ag = getAgentGroupByFolder(ch.folder);
    if (!ag) { console.log(`  SKIP: no AG for folder ${ch.folder}`); continue; }

    let mg = db.prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?').get(ch.channelType, ch.platformId) as { id: string } | undefined;
    if (!mg) {
      const mgId = genId('mg');
      db.prepare(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
         VALUES (?, ?, ?, ?, ?, 'public', ?)`
      ).run(mgId, ch.channelType, ch.platformId, ch.name, ch.isGroup, now());
      mg = { id: mgId };
      console.log(`  Created MG: ${ch.channelType}:${ch.name}`);
    }

    // Clear old wiring for this MG and re-wire
    db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(mg.id);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, default_model, default_effort, created_at)
       VALUES (?, ?, ?, 'mention', NULL, 'all', 'drop', 'per-thread', 0, NULL, NULL, ?)`
    ).run(genId('mga'), mg.id, ag.id, now());

    db.prepare(
      `INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'channel', ?, ?)`
    ).run(ag.id, `${ch.channelType.replace('-', '_')}_${ch.name.replace(/-/g, '_')}`, mg.id, now());

    console.log(`  ${ch.channelType}:${ch.name} → ${ch.folder}`);
  }

  // ── 5. Summary ─────────────────────────────────────────────────────────
  console.log('\n=== Agent Groups ===');
  for (const ag of db.prepare('SELECT id, name, folder FROM agent_groups ORDER BY folder').all() as any[]) {
    console.log(`  ${ag.name} (${ag.folder}) → ${ag.id}`);
  }

  console.log('\n=== Wiring ===');
  for (const row of db.prepare(
    `SELECT mg.channel_type, mg.name, ag.name as agent, ag.folder
     FROM messaging_group_agents mga
     JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
     JOIN agent_groups ag ON ag.id = mga.agent_group_id
     ORDER BY mg.channel_type, mg.name`
  ).all() as any[]) {
    console.log(`  ${row.channel_type}: ${row.name || '(main)'} → ${row.folder}`);
  }
}

main().catch(console.error);
