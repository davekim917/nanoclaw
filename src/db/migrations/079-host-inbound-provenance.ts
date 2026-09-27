import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Records which `.host/inbound.db` files THIS HOST created. Under the pre-deploy mount set `/workspace` is writable
 * and `.host` absent, so a container can plant its own `.host/inbound.db`, which the migration would then adopt
 * wholesale.
 * No filesystem or content signal can tell the host's file from a planted one: host and container share a uid, mode
 * and timestamps are forgeable, inode identity cannot separate an attacker from the rolled-back-host case, and a
 * planted file authors its own schema (a zero-row DB with a hostile TRIGGER wins any "prefer the non-empty side"
 * rule). So the answer lives in the host-only central DB, which no container mounts.
 * `device`/`inode` are decimal TEXT: `st_ino` can exceed 2^53, and a rounded inode compares equal to its neighbours,
 * failing OPEN. No FK to `sessions`: a record whose absence means REFUSAL must never vanish through an unrelated
 * cascade; removal is explicit, from the mailbox's `destroy`.
 */
export const migration079: Migration = {
  version: 79,
  name: 'host-inbound-provenance',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS host_inbound_provenance (
        agent_group_id TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        device         TEXT NOT NULL,
        inode          TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, session_id)
      )
    `);
  },
};
