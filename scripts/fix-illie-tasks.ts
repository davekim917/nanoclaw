/**
 * Fix: wire xzo + agents-xzo Slack to illie, migrate illie's Discord illysium
 * channel task, add number-drinks recap to Axie's main session.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';
import { initDb, getDb } from '../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'v2-sessions');

function now(): string { return new Date().toISOString(); }
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function openInboundDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = DELETE');
  return db;
}

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) as maxSeq FROM messages_in').get() as { maxSeq: number };
  return (row.maxSeq | 1) + 1;
}

async function main() {
  initDb(path.join(PROJECT_ROOT, 'data', 'v2.db'));
  const db = getDb();
  const illieId = 'ag-1776377699463-2axxhg';
  const axieId = 'ag-1776402507183-cf39lq';

  // ── 1. Wire xzo + agents-xzo Slack to illie ─────────────────────────────
  console.log('--- Wire xzo + agents-xzo to illie ---');
  for (const [name, platformId] of [
    ['xzo', 'slack:C09GBH38ZSS'],
    ['agents-xzo', 'slack:C0AJA89MN2E'],
  ] as [string, string][]) {
    const mg = db.prepare('SELECT id FROM messaging_groups WHERE platform_id = ?').get(platformId) as { id: string } | undefined;
    if (!mg) { console.log(`  MG not found: ${name}`); continue; }
    db.prepare('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?').run(mg.id);
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, default_model, default_effort, created_at)
       VALUES (?, ?, ?, 'mention', NULL, 'all', 'drop', 'per-thread', 0, NULL, NULL, datetime('now'))`
    ).run(`mga-${name}-${mg.id.slice(-8)}`, mg.id, illieId);
    db.prepare("INSERT OR IGNORE INTO agent_destinations VALUES (?, ?, ?, ?, datetime('now'))").run(
      illieId, `slack-${name}`, 'channel', mg.id);
    console.log(`  Wired: slack:${name} → illie`);
  }

  // ── 2. Add number-drinks recap to Axie's main session ──────────────────
  console.log('\n--- Add number-drinks recap to Axie main session ---');
  const axieSessId = 'sess-1776426894592-x6ln5f';
  const axieSessDir = path.join(SESSIONS_DIR, axieId, axieSessId);
  const axieIn = openInboundDb(path.join(axieSessDir, 'inbound.db'));
  const existingSeries = new Set(
    (axieIn.prepare("SELECT series_id FROM messages_in WHERE kind = 'task'").all() as { series_id: string }[]).map(r => r.series_id)
  );
  if (existingSeries.has('task-email-recap-numberdrinks')) {
    console.log('  Already exists — skipping');
  } else {
    axieIn.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, NULL, ?, ?)`
    ).run(
      'task-email-recap-numberdrinks', nextEvenSeq(axieIn),
      '2026-04-21T16:00:00.000Z', '0 12 * * *',
      'discord:1479489865702703155:1479517050249412739', 'discord',
      JSON.stringify({ prompt: `Daily Email Recap — Number Drinks

Scan dave@numberdrinks.com for emails from the last 24h.

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/numberdrinks.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/numberdrinks.json gws gmail +read --id <ID> --headers

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Action Required**
**Newsletters**
**Cleanup**`, script: null }),
      'task-email-recap-numberdrinks'
    );
    console.log('  Inserted: task-email-recap-numberdrinks');
  }
  axieIn.close();

  // ── 3. Migrate illie's Discord illysium channel task ──────────────────
  console.log('\n--- Migrate illie Discord illysium task ---');
  const illieSessId = (db.prepare(
    "SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = (SELECT id FROM messaging_groups WHERE platform_id = 'discord:1479489865702703155:1479516831168593974') AND status = 'active' LIMIT 1"
  ).get(illieId) as { id: string } | undefined)?.id;

  let illieSessDir = '';
  let illieSessionId = illieSessId;
  if (illieSessionId) {
    illieSessDir = path.join(SESSIONS_DIR, illieId, illieSessionId);
    if (!fs.existsSync(illieSessDir)) {
      console.log(`  Session dir missing, will find alternate`);
      illieSessionId = undefined;
    }
  }

  if (!illieSessionId) {
    const dirs = fs.readdirSync(path.join(SESSIONS_DIR, illieId)).filter(d => d.startsWith('sess-'));
    for (const d of dirs) {
      const dir = path.join(SESSIONS_DIR, illieId, d);
      if (fs.existsSync(path.join(dir, 'inbound.db'))) {
        illieSessionId = d;
        illieSessDir = dir;
        break;
      }
    }
    if (!illieSessionId) {
      illieSessionId = 'sess-1776731585802-242url9';
      illieSessDir = path.join(SESSIONS_DIR, illieId, illieSessionId);
      if (!fs.existsSync(illieSessDir)) fs.mkdirSync(illieSessDir, { recursive: true });
    }
  }
  console.log(`  Using session: ${illieSessionId}`);

  const illieIn = openInboundDb(path.join(illieSessDir, 'inbound.db'));
  const illieSeries = new Set(
    (illieIn.prepare("SELECT series_id FROM messages_in WHERE kind = 'task'").all() as { series_id: string }[]).map(r => r.series_id)
  );
  if (illieSeries.has('task-email-recap-illysium')) {
    console.log('  Already exists — skipping');
  } else {
    illieIn.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
       VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, NULL, ?, ?)`
    ).run(
      'task-email-recap-illysium', nextEvenSeq(illieIn),
      '2026-04-21T16:00:00.000Z', '0 12 * * *',
      'discord:1479489865702703155:1479516831168593974', 'discord',
      JSON.stringify({ prompt: `Daily Email Recap — Illysium

Scan dave@illysium.ai for emails from the last 24h.

Use gws gmail to search and read emails:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/illysium.json gws gmail +triage --query "newer_than:1d" --max 50
Then read each with:
  GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/illysium.json gws gmail +read --id <ID> --headers

FORMAT — follow exactly:
- Each email = ONE line: priority emoji + **sender** + subject + → action
- Priority emojis: 🔴 urgent/today, 🟡 this week, ⚪ FYI
- Group by priority (🔴 first), not by time
- NO sub-bullets, no multi-line descriptions — one line per email max
- Example: 🔴 **GitHub** — PR #42 review requested → review and approve
- Newsletters: just sender + recommendation: ❌ unsub | 🏷️ filter | ✅ keep
- Cleanup: one-liner filter rule suggestions only
- Omit sections entirely if empty
- If no emails, say so in one line

Sections (in order):
**Action Required**
**Newsletters**
**Cleanup**`, script: null }),
      'task-email-recap-illysium'
    );
    console.log('  Inserted: task-email-recap-illysium');
  }
  illieIn.close();

  // ── 4. Summary ──────────────────────────────────────────────────────────
  console.log('\n=== Final Wiring ===');
  for (const row of db.prepare(
    `SELECT mg.channel_type, mg.name, ag.name as agent FROM messaging_group_agents mga
     JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
     JOIN agent_groups ag ON ag.id = mga.agent_group_id
     ORDER BY mg.channel_type, mg.name`
  ).all() as any[]) {
    console.log(`  ${row.channel_type}: ${row.name || '(main)'} → ${row.agent}`);
  }

  console.log('\n=== Axie Tasks ===');
  const axieIn2 = openInboundDb(path.join(SESSIONS_DIR, axieId, axieSessId, 'inbound.db'));
  for (const row of axieIn2.prepare("SELECT id, recurrence, process_after FROM messages_in WHERE kind = 'task' ORDER BY id").all() as any[]) {
    console.log(`  ${row.id} [${row.recurrence}]`);
  }
  axieIn2.close();

  console.log('\nDone.');
}

main().catch(console.error);
