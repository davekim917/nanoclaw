import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const root = '/home/ubuntu/nanoclaw-v2/data/v2-sessions';
const groups = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

type Row = {
  id: string;
  series_id: string | null;
  status: string;
  content: string;
  recurrence: string | null;
};

const results: Array<{ group: string; session: string; row: Row }> = [];

for (const g of groups) {
  const groupDir = path.join(root, g.name);
  let sessDirs: fs.Dirent[];
  try {
    sessDirs = fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('sess-'));
  } catch {
    continue;
  }
  for (const s of sessDirs) {
    const dbPath = path.join(groupDir, s.name, 'inbound.db');
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) continue;
    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue;
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, series_id, status, content, recurrence FROM messages_in
           WHERE kind = 'task' AND status IN ('pending','paused')
             AND content LIKE '%"script"%'`,
        )
        .all() as Row[];
      for (const r of rows) results.push({ group: g.name, session: s.name, row: r });
    } catch {
      /* table may not exist or schema differs */
    } finally {
      db.close();
    }
  }
}

console.log(JSON.stringify(results, null, 2));
console.error(`scanned ${groups.length} groups`);
