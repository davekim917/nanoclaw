/**
 * Fleet-wide scheduled-task inventory.
 *
 * Scheduled tasks live as recurring rows in each session's inbound.db
 * (messages_in WHERE recurrence IS NOT NULL). This sweeps every session,
 * joins agent group + channel from the central DB, and prints one block per
 * active series: who runs it, where output lands, the cron (rendered in the
 * service timezone), next fire, and the prompt/script it carries.
 *
 * Usage:
 *   pnpm exec tsx scripts/list-scheduled-tasks.ts             # active series
 *   pnpm exec tsx scripts/list-scheduled-tasks.ts --all       # + cancelled/expired latest rows
 *   pnpm exec tsx scripts/list-scheduled-tasks.ts --full      # full prompt + script bodies
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE as CONFIG_TIMEZONE } from '../src/config.js';
import { resolveGroupTimezone } from '../src/container-config.js';
import { initDb } from '../src/db/connection.js';

const SHOW_ALL = process.argv.includes('--all');
const FULL = process.argv.includes('--full');

/**
 * Cron expressions are interpreted by the HOST process (recurrence.ts), whose
 * timezone comes from its own environment — on Linux that's the systemd
 * unit's Environment=TZ=..., which an ad-hoc shell doesn't inherit. Read it
 * from the unit so this report matches what the service actually does;
 * fall back to the local config resolution.
 */
function resolveServiceTimezone(): string {
  try {
    const env = execFileSync('systemctl', ['show', 'nanoclaw-v2', '-p', 'Environment', '--value'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const m = env.match(/(?:^|\s)TZ=(\S+)/);
    if (m) return m[1];
  } catch {
    /* not Linux/systemd or unit absent — fall through */
  }
  return CONFIG_TIMEZONE;
}
const TIMEZONE = resolveServiceTimezone();

interface TaskRow {
  id: string;
  series_id: string | null;
  recurrence: string;
  process_after: string | null;
  status: string;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
const agentGroups = new Map(
  (central.prepare('SELECT id, name, folder, agent_provider FROM agent_groups').all() as Array<{
    id: string;
    name: string;
    folder: string;
    agent_provider: string | null;
  }>).map((g) => [g.id, g]),
);
const messagingGroups = new Map(
  (central.prepare('SELECT id, name, channel_type, platform_id FROM messaging_groups').all() as Array<{
    id: string;
    name: string | null;
    channel_type: string;
    platform_id: string;
  }>).map((m) => [m.id, m]),
);
const sessions = new Map(
  (central.prepare('SELECT id, agent_group_id, messaging_group_id, thread_id FROM sessions').all() as Array<{
    id: string;
    agent_group_id: string;
    messaging_group_id: string;
    thread_id: string | null;
  }>).map((s) => [s.id, s]),
);
// Channel destination → messaging group name, for rows whose output target
// differs from the session's own messaging group.
const mgByDestination = new Map(
  [...messagingGroups.values()].map((m) => [`${m.channel_type}\0${m.platform_id}`, m]),
);
central.close();
// Reopened through the shared connection so this report resolves a group's
// timezone the same way the firing path does, instead of re-reading
// container_configs itself. Read-only use.
await initDb(path.join(DATA_DIR, 'v2.db'));

function fmtWhen(iso: string | null, tz: string): string {
  if (!iso) return '-';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return `${d.toISOString().slice(0, 16)}Z (${d.toLocaleString('en-US', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })} ${tz})`;
}

function clip(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return FULL || oneLine.length <= n ? s.trim() : `${oneLine.slice(0, n)}…`;
}

const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
let count = 0;

for (const groupDir of fs.readdirSync(sessionsRoot).sort()) {
  const groupPath = path.join(sessionsRoot, groupDir);
  if (!fs.statSync(groupPath).isDirectory()) continue;
  // The directory name IS the agent group id (storage-activity.ts:319). A
  // group with a timezone override runs its whole series on that grid, so both
  // the cron interpretation and the rendered fire time report it — every line
  // already names the zone it is in, so nothing here reads ambiguously.
  const groupTz = resolveGroupTimezone(groupDir, TIMEZONE);
  for (const sessDir of fs.readdirSync(groupPath).sort()) {
    const inboundPath = path.join(groupPath, sessDir, 'inbound.db');
    if (!fs.existsSync(inboundPath)) continue;

    const db = new Database(inboundPath, { readonly: true });
    let rows: TaskRow[];
    try {
      // Latest row per series tells the series' current state; older rows of
      // the same series are history (recurrence cleared on completion).
      rows = db
        .prepare(
          `SELECT id, series_id, recurrence, process_after, status, kind,
                  platform_id, channel_type, thread_id, content
           FROM messages_in
           WHERE recurrence IS NOT NULL
             AND seq = (SELECT MAX(m2.seq) FROM messages_in m2 WHERE m2.series_id = messages_in.series_id)
           ORDER BY process_after`,
        )
        .all() as TaskRow[];
    } finally {
      db.close();
    }

    for (const row of rows) {
      if (!SHOW_ALL && row.status !== 'pending') continue;

      const session = sessions.get(sessDir);
      const ag = agentGroups.get(session?.agent_group_id ?? groupDir);
      const sessionMg = session ? messagingGroups.get(session.messaging_group_id) : undefined;
      const destMg =
        row.channel_type && row.platform_id
          ? mgByDestination.get(`${row.channel_type}\0${row.platform_id}`)
          : undefined;

      let content: Record<string, unknown> = {};
      try {
        content = JSON.parse(row.content);
      } catch {
        /* show raw below */
      }
      const prompt = typeof content.prompt === 'string' ? content.prompt : row.content;
      const script = typeof content.script === 'string' ? (content.script as string) : null;

      count++;
      console.log(`\n━━━ ${row.series_id ?? row.id} ${row.status !== 'pending' ? `[${row.status.toUpperCase()}]` : ''}`);
      console.log(`  agent group : ${ag ? `${ag.name} (${ag.folder}${ag.agent_provider ? `, ${ag.agent_provider}` : ''})` : groupDir}`);
      console.log(`  channel     : ${destMg?.name ?? sessionMg?.name ?? '?'} [${row.channel_type ?? sessionMg?.channel_type ?? '?'}] ${row.thread_id ? `thread ${row.thread_id}` : 'channel root'}`);
      console.log(`  session     : ${groupDir}/${sessDir}`);
      console.log(`  cron        : ${row.recurrence}  (interpreted in ${groupTz})`);
      console.log(`  next fire   : ${fmtWhen(row.process_after, groupTz)}`);
      if (content.quietStatus) console.log(`  quietStatus : true`);
      if (content.flagIntent) console.log(`  flagIntent  : ${JSON.stringify(content.flagIntent)}`);
      console.log(`  prompt      : ${clip(prompt, 160)}`);
      if (script) console.log(`  pre-script  : ${clip(script, 160)}`);
    }
  }
}

console.log(`\n${count} ${SHOW_ALL ? 'series' : 'active series'} total. (--all includes non-pending, --full prints whole prompts/scripts)`);
