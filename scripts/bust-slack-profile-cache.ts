/**
 * Drop the chat-sdk's cached Slack user profiles so the next message refetches
 * `users.info`.
 *
 * Why this exists: `@chat-adapter/slack` caches each user's displayName and
 * realName in `chat_sdk_kv` for EIGHT DAYS (`USER_CACHE_TTL_MS`), persisted, so
 * it survives host restarts. Nothing invalidates it when a profile changes. So
 * renaming a bot in Slack has no visible effect for up to a week: siblings keep
 * receiving the old `sender` name and — because that is what they read in the
 * transcript — keep writing the old name back out in prose.
 *
 * Seen in practice: after a batch of bot renames, a sibling kept referring to
 * another agent by its retired name for six days in ordinary prose, while
 * Slack itself had been serving the new `real_name` the whole time.
 *
 * Safe to run any time. The cache is a pure read-through of Slack, which is
 * authoritative, so the only cost of a needless bust is one `users.info` per
 * user on next contact.
 *
 * Usage: pnpm exec tsx scripts/bust-slack-profile-cache.ts [--dry-run]
 */
import { initDb, getDb } from '../src/db/connection.js';

const dryRun = process.argv.includes('--dry-run');

initDb('data/v2.db');
const db = getDb();

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
