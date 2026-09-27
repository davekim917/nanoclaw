/**
 * scripts/q.ts — sqlite3 CLI replacement for skill SQL invocations.
 *
 * Usage:
 *   pnpm exec tsx scripts/q.ts <db-path> "<sql>"
 *
 * Queries (stmt.reader) print rows in
 * sqlite3 CLI default ("list") format — pipe-separated, no header —
 * so existing skill text reads identically.
 *
 * Why this exists: setup/verify.ts codifies that NanoClaw avoids
 * depending on the sqlite3 CLI binary; setup never installs or probes
 * for it. Skills that shell out to `sqlite3` therefore fail on hosts
 * where it isn't preinstalled (common on fresh Ubuntu).
 */
import Database from 'better-sqlite3';

const [, , dbPath, sql] = process.argv;

if (!dbPath || sql === undefined) {
  console.error('Usage: pnpm exec tsx scripts/q.ts <db-path> "<sql>"');
  process.exit(2);
}

const db = new Database(dbPath);
try {
  try {
    const stmt = db.prepare(sql);
    if (stmt.reader) {
      const rows = stmt.all() as Record<string, unknown>[];
      for (const row of rows) {
        console.log(
          Object.values(row)
            .map((v) => (v === null ? '' : String(v)))
            .join('|'),
        );
      }
    } else {
      stmt.run();
    }
  } catch (e: unknown) {
    // Compound SQL (always a mutation in skills) throws on prepare: fall back to db.exec().
    if (e instanceof Error && /more than one statement/i.test(e.message)) {
      db.exec(sql);
    } else {
      throw e;
    }
  }
} finally {
  db.close();
}
