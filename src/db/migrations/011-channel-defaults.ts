import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Per-channel (messaging_group_agents) default model + effort.
 *
 * v1 stored model/effort per chat-JID (per-channel in v2 terms). My
 * initial v2 port put them on container.json which is per-agent-group
 * — wrong granularity. This migration moves to the right layer: the
 * messaging_group_agents wiring row, so `illysium/agents-xzo` can pin
 * opus-4-7 while `illysium/agents-sunday` uses opus-4-6.
 *
 * Both nullable — absence falls through to per-agent-group
 * (container.json) → host env → hardcoded default.
 */
export const migration011: Migration = {
  version: 11,
  name: 'channel-defaults',
  up: (db: Database.Database) => {
    const cols = new Set(
      (db.prepare("PRAGMA table_info('messaging_group_agents')").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has('default_model')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_model TEXT`);
    }
    if (!cols.has('default_effort')) {
      db.exec(`ALTER TABLE messaging_group_agents ADD COLUMN default_effort TEXT`);
    }
  },
};
