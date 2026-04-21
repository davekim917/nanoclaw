import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-channel (messaging_group_agents) default tone profile.
 *
 * Ports v1's "always-on, system-prompt-injected default tone" feature, but at
 * the channel-wiring grain instead of v1's group grain. v1 used one tone per
 * agent_group; v2 needs variation within a group (e.g. illysium agent runs in
 * both Slack and Discord: Slack→engineering, Discord→assistant).
 *
 * Null falls through to container.json group-level `tone` (if set), then to
 * no tone injection (selection-guide MCP tool remains as runtime fallback).
 */
export const migration016: Migration = {
  version: 16,
  name: 'channel-tone',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('default_tone')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_tone TEXT`);
    }
  },
};
