/**
 * Scheduled-task inventory grouped by provider (claude / codex / opencode).
 * Reads the central DB for the group→provider map, then every session
 * inbound.db for live task rows (pending|paused), deduped by series.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

const central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true });
const groups = central
  .prepare(
    `SELECT ag.id, ag.name, COALESCE(NULLIF(cc.provider,''), ag.agent_provider, 'claude') AS provider
     FROM agent_groups ag LEFT JOIN container_configs cc ON cc.agent_group_id = ag.id`,
  )
  .all() as Array<{ id: string; name: string; provider: string }>;
const byId = new Map(groups.map((g) => [g.id, g]));

const sessionsRoot = path.join(DATA_DIR, 'v2-sessions');
type Task = {
  group: string;
  provider: string;
  title: string;
  cron: string | null;
  next: string | null;
  pin: string | null;
  scope: string;
  category: string;
};
const tasks: Task[] = [];

function categorize(title: string): string {
  const t = title.toLowerCase();
  if (/mnemon|memory (extract|synth|curat)|source.ingest|recall/.test(t)) return 'module';
  return 'operator';
}

for (const ag of fs.existsSync(sessionsRoot) ? fs.readdirSync(sessionsRoot) : []) {
  const grp = byId.get(ag);
  if (!grp) continue; // orphaned/test session dir — skip
  const agDir = path.join(sessionsRoot, ag);
  if (!fs.statSync(agDir).isDirectory()) continue;
  const seen = new Set<string>();
  for (const sess of fs.readdirSync(agDir)) {
    const dbPath = path.join(agDir, sess, 'inbound.db');
    if (!fs.existsSync(dbPath)) continue;
    let rows: Array<{ series_id: string | null; id: string; content: string; recurrence: string | null; process_after: string | null; thread_id: string | null }>;
    try {
      rows = new Database(dbPath, { readonly: true })
        .prepare(
          `SELECT series_id, id, content, recurrence, process_after, thread_id
           FROM messages_in WHERE kind='task' AND status IN ('pending','paused')`,
        )
        .all() as never;
    } catch {
      continue;
    }
    for (const r of rows) {
      const key = r.series_id || r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(r.content) as Record<string, unknown>;
      } catch {
        /* keep raw */
      }
      const prompt = String(parsed.prompt ?? r.content).replace(/\s+/g, ' ').trim();
      const fi = parsed.flagIntent as { turnModel?: string; turnEffort?: string } | undefined;
      const pin = fi?.turnModel ? `${fi.turnModel}${fi.turnEffort ? '/' + fi.turnEffort : ''}` : null;
      tasks.push({
        group: grp.name,
        provider: grp.provider,
        title: prompt.slice(0, 64),
        cron: r.recurrence,
        next: r.process_after,
        pin,
        scope: r.thread_id ? 'thread' : 'channel',
        category: categorize(prompt),
      });
    }
  }
}

for (const provider of ['claude', 'codex', 'opencode']) {
  const pt = tasks.filter((t) => t.provider === provider);
  if (pt.length === 0) continue;
  console.log(`\n${'='.repeat(70)}\n${provider.toUpperCase()}  —  ${pt.length} task(s)\n${'='.repeat(70)}`);
  const groupsWith = [...new Set(pt.map((t) => t.group))].sort();
  for (const g of groupsWith) {
    console.log(`\n▸ ${g}`);
    for (const t of pt.filter((x) => x.group === g).sort((a, b) => (a.cron || '').localeCompare(b.cron || ''))) {
      const cron = (t.cron || 'one-shot').padEnd(14);
      const pin = t.pin ? `  [${t.pin}]` : '';
      const cat = t.category === 'module' ? ' (module)' : '';
      console.log(`   ${cron} ${t.title}${pin}${cat}`);
    }
  }
}

const c = (p: string) => tasks.filter((t) => t.provider === p);
console.log(
  `\n${'='.repeat(70)}\nTOTAL: ${tasks.length} live tasks — ` +
    `claude ${c('claude').length}, codex ${c('codex').length}, opencode ${c('opencode').length}` +
    `  |  operator ${tasks.filter((t) => t.category === 'operator').length}, module ${tasks.filter((t) => t.category === 'module').length}`,
);
