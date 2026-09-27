/**
 * Drop the chat-sdk's cached Slack user profiles so the next message refetches `users.info`.
 * `@chat-adapter/slack` caches display names for EIGHT DAYS, persisted across restarts, and
 * nothing invalidates it on a profile change, so a renamed bot keeps its old `sender` name.
 * Safe any time: the cache is a pure read-through of Slack.
 *
 * Usage: pnpm exec tsx scripts/bust-slack-profile-cache.ts [--dry-run]
 */
import { initDb, getRawDb } from '../src/db/connection.js';

const dryRun = process.argv.includes('--dry-run');

await initDb('data/v2.db');
const db = getRawDb();

// The reverse index is keyed by the OLD lowercased name, so it has to go too —
// otherwise a retired name keeps resolving to a live bot.
const rows = db
  .prepare(`SELECT key, value FROM chat_sdk_kv WHERE key LIKE 'slack:user:%' OR key LIKE 'slack:user-by-name:%'`)
  .all() as { key: string; value: string }[];

for (const r of rows) {
  let label = '';
  try {
    const v = JSON.parse(r.value) as { realName?: string };
    if (v?.realName) label = ` (cached as ${JSON.stringify(v.realName)})`;
  } catch {
    // Lists and other shapes have no realName; the key alone is enough.
  }
  console.log(`${dryRun ? 'would drop' : 'dropping'} ${r.key}${label}`);
}

if (!dryRun) {
  db.prepare(`DELETE FROM chat_sdk_kv WHERE key LIKE 'slack:user:%' OR key LIKE 'slack:user-by-name:%'`).run();
}

console.log(`${dryRun ? 'would drop' : 'dropped'} ${rows.length} cached profile row(s)`);
if (!dryRun && rows.length > 0) {
  console.log('Each is refetched from Slack on that user’s next message. No restart needed.');
}
