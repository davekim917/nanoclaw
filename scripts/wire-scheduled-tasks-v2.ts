/**
 * V1 → V2 scheduled-tasks migration (corrected rewrite of wire-scheduled-tasks.ts).
 *
 * Why a rewrite: the original migration had three bugs:
 *   1. Every task hardcoded `platform_id` to the main Discord channel — wrong
 *      for per-channel tasks (numberdrinks posted to main instead of
 *      number-drinks).
 *   2. `process_after` was hardcoded to 16:00 UTC (= 12:00 ET) for all
 *      "8am" tasks — 4 hours late. Cron was left as v1's `0 12 * * *`
 *      which, evaluated in host's America/Los_Angeles tz, fires at 19:00
 *      UTC = 3pm ET. Wrong twice.
 *   3. Only migrated ~2 of 10 user tasks, and routed `numberdrinks` into
 *      illysium's agent group instead of number-drinks.
 *
 * What this does:
 *   - Pulls prompts live from v1's store/messages.db (authoritative source)
 *   - Maps each task to the correct v2 (agent_group_id, messaging_group_id,
 *     platform_id) triple, keyed off v1 group_folder
 *   - Rewrites cron expressions into ET-local form (v1 empty-tz = UTC; host
 *     TIMEZONE is now America/New_York via systemd drop-in)
 *   - Ensures a single "task session" per target agent_group + messaging_group,
 *     registered in v2.db.sessions so host-sweep finds it
 *   - Inserts tasks idempotently (skip if series_id already present)
 *   - Also ports the hourly plugin-update notifier to axie-dev
 *
 * Cleans up the 2 pre-existing mis-routed task rows left by the old script.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

import { initDb, getDb } from '../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const V2_DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SESSIONS_DIR = path.join(V2_DATA_DIR, 'v2-sessions');
const V1_STORE = '/home/ubuntu/nanoclaw/store/messages.db';

interface ChannelTarget {
  agentGroupId: string;
  messagingGroupId: string;
  platformId: string;
}

// Per-channel targeting. v1 group_folder → v2 routing triple.
const CHANNEL_MAP: Record<string, ChannelTarget> = {
  main: {
    agentGroupId: 'ag-1776402507183-cf39lq',
    messagingGroupId: 'mg-1776404343731-7041k0',
    platformId: 'discord:1479489865702703155:1479489866193571902',
  },
  illysium: {
    agentGroupId: 'ag-1776377699463-2axxhg',
    messagingGroupId: 'mg-discord-illysium',
    platformId: 'discord:1479489865702703155:1479516831168593974',
  },
  'number-drinks': {
    agentGroupId: 'ag-1776735605479-6p0461m',
    messagingGroupId: 'mg-discord-number',
    platformId: 'discord:1479489865702703155:1479517050249412739',
  },
  'madison-reed': {
    agentGroupId: 'ag-1776735605480-vosgej2',
    messagingGroupId: 'mg-discord-madison-reed',
    platformId: 'discord:1479489865702703155:1491825196087377960',
  },
  'axie-dev': {
    agentGroupId: 'ag-1776735605480-ymhokes',
    messagingGroupId: 'mg-discord-axie-dev',
    platformId: 'discord:1479489865702703155:1491839654528548989',
  },
};

// v1 cron (evaluated as UTC) → v2 cron (evaluated in America/New_York).
// v1's "0 12 * * *" meant 12:00 UTC = 08:00 EDT. In ET-local, that's "0 8 * * *".
// Subtract 4 from the hour field (EDT = UTC-4). Host TIMEZONE is now ET.
function cronUtcToEt(cronUtc: string): string {
  const parts = cronUtc.trim().split(/\s+/);
  if (parts.length !== 5) return cronUtc;
  const [min, hrRaw, dom, mon, dow] = parts;
  const hrNum = parseInt(hrRaw, 10);
  if (Number.isNaN(hrNum)) return cronUtc; // e.g. `*` — leave alone
  const etHr = ((hrNum - 4) % 24 + 24) % 24;
  return `${min} ${etHr} ${dom} ${mon} ${dow}`;
}

interface V1Task {
  id: string;
  group_folder: string;
  prompt: string;
  schedule_value: string;
  script: string | null;
  task_type: string | null;
  context_mode: string | null;
}

function readV1Tasks(): V1Task[] {
  const db = new Database(V1_STORE, { readonly: true });
  const rows = db.prepare(`
    SELECT id, group_folder, prompt, schedule_value, script, task_type, context_mode
    FROM scheduled_tasks
    WHERE status = 'active'
      AND schedule_type = 'cron'
      AND group_folder != 'sunday'
      AND id NOT LIKE '\\_\\_%' ESCAPE '\\'
  `).all() as V1Task[];
  db.close();
  return rows;
}

// The system task in v1 (__plugin_updater) ran hourly and posted to axie-dev
// per the user's screenshot. Port as a user task so it shows up in chat.
function pluginUpdaterTask(): V1Task {
  return {
    id: 'task-plugin-updater',
    group_folder: 'axie-dev',
    prompt: [
      'Check for plugin updates and post a notification for anything that changed.',
      '',
      'Scope: scan the plugins the container has installed (see /workspace/plugins if mounted, or',
      'use `pnpm -w list --depth=0` on the plugin packages). For each plugin that has a newer',
      'version available upstream, post one line to this channel:',
      '',
      '  Plugin update: Updated: <plugin-name>',
      '',
      'If multiple updated, you may combine on one line (comma-separated). If nothing updated,',
      'say nothing — silent success. Do not retry or wait; a fresh run fires every hour.',
    ].join('\n'),
    schedule_value: '0 * * * *',
    script: null,
    task_type: 'container',
    context_mode: 'isolated',
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function openInboundDb(sessDir: string): Database.Database {
  const db = new Database(path.join(sessDir, 'inbound.db'));
  db.pragma('journal_mode = DELETE');
  return db;
}

function nextEvenSeq(db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages_in').get() as { maxSeq: number };
  let seq = row.maxSeq + 2;
  if (seq % 2 !== 0) seq++;
  return seq;
}

function findOrCreateTaskSession(target: ChannelTarget): { sessionId: string; sessDir: string; created: boolean } {
  const db = getDb();
  // Reuse existing active session for this (agent_group, messaging_group) if it exists on disk.
  const existing = db.prepare(`
    SELECT id FROM sessions
    WHERE agent_group_id = ? AND messaging_group_id = ? AND status = 'active' AND thread_id IS NULL
    ORDER BY created_at ASC LIMIT 1
  `).get(target.agentGroupId, target.messagingGroupId) as { id: string } | undefined;

  if (existing) {
    const dir = path.join(SESSIONS_DIR, target.agentGroupId, existing.id);
    if (fs.existsSync(path.join(dir, 'inbound.db'))) {
      return { sessionId: existing.id, sessDir: dir, created: false };
    }
  }

  const sessionId = generateId('sess');
  db.prepare(`
    INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
    VALUES (?, ?, ?, NULL, NULL, 'active', 'stopped', ?, ?)
  `).run(sessionId, target.agentGroupId, target.messagingGroupId, nowIso(), nowIso());

  const sessDir = path.join(SESSIONS_DIR, target.agentGroupId, sessionId);
  fs.mkdirSync(sessDir, { recursive: true });

  // Schemas cribbed from src/db/session-db.ts — keeping this script self-contained
  // and free of cross-imports that pull in the live v2 runtime.
  const inboundDb = openInboundDb(sessDir);
  inboundDb.exec(`
    CREATE TABLE IF NOT EXISTS messages_in (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      kind           TEXT NOT NULL,
      timestamp      TEXT NOT NULL,
      status         TEXT NOT NULL,
      status_changed TEXT,
      process_after  TEXT,
      recurrence     TEXT,
      tries          INTEGER NOT NULL DEFAULT 0,
      trigger        INTEGER NOT NULL DEFAULT 1,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL,
      series_id      TEXT
    );
  `);
  inboundDb.close();

  const outboundDb = new Database(path.join(sessDir, 'outbound.db'));
  outboundDb.pragma('journal_mode = DELETE');
  outboundDb.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id             TEXT PRIMARY KEY,
      seq            INTEGER UNIQUE,
      in_reply_to    TEXT,
      timestamp      TEXT NOT NULL,
      deliver_after  TEXT,
      recurrence     TEXT,
      kind           TEXT NOT NULL,
      platform_id    TEXT,
      channel_type   TEXT,
      thread_id      TEXT,
      content        TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS processing_ack (message_id TEXT PRIMARY KEY, status TEXT NOT NULL, claimed_at TEXT);
    CREATE TABLE IF NOT EXISTS session_state (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS container_state (id INTEGER PRIMARY KEY CHECK (id = 1), last_tool TEXT, last_tool_at TEXT, last_tool_timeout_ms INTEGER);
  `);
  outboundDb.close();

  return { sessionId, sessDir, created: true };
}

function insertTask(sessDir: string, target: ChannelTarget, task: V1Task): boolean {
  const db = openInboundDb(sessDir);
  try {
    const exists = db.prepare('SELECT 1 FROM messages_in WHERE series_id = ?').get(task.id) as { 1: number } | undefined;
    if (exists) return false;

    const etCron = cronUtcToEt(task.schedule_value);
    // Compute first processAfter: next ET match of the cron, fire-and-forget past-due OK.
    // We leave this cheap — the host sweep's CronExpressionParser uses TIMEZONE at
    // run-time to compute subsequent fires, so the initial processAfter only needs
    // to be roughly right. Set to "now" so it fires on next sweep and the cron
    // takes over thereafter.
    const processAfter = nowIso();

    db.prepare(`
      INSERT INTO messages_in (id, seq, timestamp, status, tries, trigger, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
      VALUES (?, ?, datetime('now'), 'pending', 0, 1, ?, ?, 'task', ?, ?, NULL, ?, ?)
    `).run(
      task.id,
      nextEvenSeq(db),
      processAfter,
      etCron,
      target.platformId,
      'discord',
      JSON.stringify({ prompt: task.prompt, script: task.script }),
      task.id,
    );
    return true;
  } finally {
    db.close();
  }
}

// Remove the 2 pre-existing mis-routed task rows from their orphan sessions.
// Those sessions aren't in v2.db so host-sweep never saw them anyway.
function cleanOrphanTaskRows(): void {
  const orphans = [
    { dir: path.join(SESSIONS_DIR, 'ag-1776377699463-2axxhg/sess-1776378082946-cfn96b'), id: 'task-email-recap-illysium' },
    { dir: path.join(SESSIONS_DIR, 'ag-1776377699463-2axxhg/sess-1776730598650-ohl9921'), id: 'task-email-recap-numberdrinks' },
  ];
  for (const o of orphans) {
    const dbPath = path.join(o.dir, 'inbound.db');
    if (!fs.existsSync(dbPath)) continue;
    const db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    const r = db.prepare('DELETE FROM messages_in WHERE id = ?').run(o.id);
    db.close();
    if (r.changes > 0) console.log(`  [clean] removed ${o.id} from ${path.basename(o.dir)}`);
  }
}

async function main(): Promise<void> {
  console.log('\n=== v1→v2 scheduled-tasks migration (v2) ===\n');

  initDb(path.join(V2_DATA_DIR, 'v2.db'));

  console.log('[clean] removing pre-existing mis-routed task rows');
  cleanOrphanTaskRows();
  console.log();

  const tasks: V1Task[] = [...readV1Tasks(), pluginUpdaterTask()];
  console.log(`[v1] ${tasks.length} tasks to migrate\n`);

  let inserted = 0;
  let skipped = 0;
  for (const task of tasks) {
    const target = CHANNEL_MAP[task.group_folder];
    if (!target) {
      console.log(`  [skip] ${task.id} — no v2 target for group_folder='${task.group_folder}'`);
      skipped++;
      continue;
    }
    const { sessionId, sessDir, created } = findOrCreateTaskSession(target);
    if (created) console.log(`  [session] created ${sessionId} for ${task.group_folder}`);

    const ok = insertTask(sessDir, target, task);
    if (ok) {
      const etCron = cronUtcToEt(task.schedule_value);
      console.log(`  [task]  inserted ${task.id}  UTC(${task.schedule_value}) → ET(${etCron})  → ${task.group_folder}`);
      inserted++;
    } else {
      console.log(`  [task]  skipped  ${task.id} — already present in session`);
      skipped++;
    }
  }

  console.log(`\nDone. inserted=${inserted} skipped=${skipped}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
