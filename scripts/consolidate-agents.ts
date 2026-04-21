/**
 * Consolidate all Discord channels to Axie, remove extra agent groups.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from '../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'v2.db');

async function main() {
  initDb(dbPath);
  const db = getDb();

  const axieId = 'ag-1776402507183-cf39lq';
  const extraIds = [
    'ag-1776730254286-ymspki7',  // Xerus
    'ag-1776730254288-peom5ns',  // Number Drinks
    'ag-1776730254283-lr6y4uv',  // Dirtmarket
    'ag-1776730254291-3nnxxrq',  // Video Agent
    'ag-1776730254289-nykmx1s',  // Axis Labs
  ];

  // Remove extra agent groups and their wiring/destinations
  for (const id of extraIds) {
    db.prepare('DELETE FROM agent_destinations WHERE agent_group_id = ?').run(id);
    db.prepare('DELETE FROM messaging_group_agents WHERE agent_group_id = ?').run(id);
    const deleted = db.prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
    console.log(`Removed agent group ${id} (changed: ${deleted.changes})`);
  }

  // Remove existing Discord wiring (all channels)
  db.prepare(`
    DELETE FROM messaging_group_agents WHERE messaging_group_id IN (
      SELECT id FROM messaging_groups WHERE channel_type = 'discord'
    )
  `).run();
  console.log('Cleared existing Discord wiring');

  // Also clear Slack wiring for the primary 'slack' workspace channels
  // (data-team, dataops, xzo, agents-xzo - these belong to the future Slack workspace)
  db.prepare(`
    DELETE FROM messaging_group_agents WHERE messaging_group_id IN (
      SELECT id FROM messaging_groups WHERE channel_type = 'slack'
    )
  `).run();
  console.log('Cleared primary Slack wiring (future workspace)');

  // Wire all Discord channels to Axie
  const discordMgs = db.prepare(
    "SELECT id, name FROM messaging_groups WHERE channel_type = 'discord'"
  ).all() as Array<{ id: string; name: string | null }>;

  for (const mg of discordMgs) {
    const name = (mg.name || '').replace(/[^a-z0-9]/gi, '').slice(0, 10);
    const id = `mga-d${name}-${mg.id.slice(-8)}`;
    db.prepare(`
      INSERT INTO messaging_group_agents
        (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, default_model, default_effort, created_at)
      VALUES (?, ?, ?, 'mention', NULL, 'all', 'drop', 'per-thread', 0, NULL, NULL, datetime('now'))
    `).run(id, mg.id, axieId);
    console.log(`  Wired: ${mg.name || '(main)'} → Axie`);
  }

  // Add Axie destination for Discord main
  const discordMain = db.prepare(
    "SELECT id FROM messaging_groups WHERE channel_type = 'discord' AND platform_id LIKE '%1479489866193571902' LIMIT 1"
  ).get() as { id: string } | undefined;
  if (discordMain) {
    db.prepare(`
      INSERT OR IGNORE INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
      VALUES (?, 'discord-main', 'channel', ?, datetime('now'))
    `).run(axieId, discordMain.id);
    console.log('Added Axie destination: discord-main');
  }

  console.log('\nDone. Remaining agent groups:');
  for (const row of db.prepare('SELECT name, folder FROM agent_groups ORDER BY name').all() as any[]) {
    console.log(`  ${row.name} (${row.folder})`);
  }

  console.log('\nWiring:');
  for (const row of db.prepare(`
    SELECT mg.channel_type, mg.name, ag.name as agent
    FROM messaging_group_agents mga
    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    JOIN agent_groups ag ON ag.id = mga.agent_group_id
    ORDER BY mg.channel_type, mg.name
  `).all() as any[]) {
    console.log(`  ${row.channel_type}: ${row.name} → ${row.agent}`);
  }
}

main().catch(console.error);
