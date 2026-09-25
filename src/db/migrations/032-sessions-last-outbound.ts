import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Tracks the outbound side of each session in the central DB so the inbox
 * board can render `last_outbound_at` / `last_outbound_kind` without
 * opening N per-session `outbound.db` files per request.
 *
 *   last_outbound_at   — ISO timestamp of the most recent successful
 *                        host→platform delivery.
 *   last_outbound_kind — granular kind tag. For ordinary kinds the raw
 *                        `messages_out.kind` (e.g., 'chat', 'system'); for
 *                        chat-sdk messages the dotted form
 *                        'chat-sdk:<content.type>' (e.g.,
 *                        'chat-sdk:ask_question') so the dashboard can
 *                        derive the "needs me without an attached task"
 *                        signal from a single column.
 *
 * `sessions.last_active` already tracks the inbound side (host-writes-in path
 * in session-manager.ts). Keeping outbound separate means we can render
 * "agent asked at 14:02, you replied at 14:05" without an additional join.
 *
 * Both columns are nullable: every existing session predates the column,
 * and the inbox treats NULL as "no outbound on record yet" — same lane as
 * "newer than 24h activity" gating.
 */
export const migration032: Migration = {
  version: 32,
  name: 'sessions-last-outbound',
  up: (db: Database.Database) => {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN last_outbound_at   TEXT;
      ALTER TABLE sessions ADD COLUMN last_outbound_kind TEXT;
    `);
  },
};
