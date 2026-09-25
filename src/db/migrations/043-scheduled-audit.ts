import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Migration 043 — scheduled_audit
 *
 * Central-DB (`data/v2.db`) provenance table for the Scheduled Tasks Board.
 * `cancelTask` marks rows `completed` (C1 forbids new status values), so
 * board-cancellation is indistinguishable from a natural completion in the
 * session DBs alone. Distinguishability — and the move/edit/pause/resume/
 * run_now audit trail the drawer renders — comes from THIS table, not a
 * content stamp. See docs/specs/scheduled-tasks-board/design.md §4.3, §4.4.
 *
 * Central-DB only: this migration never touches a session `inbound.db`
 * (C1/C3 — the firing path is untouched).
 *
 * Columns (design §4.4):
 *   ts                 — server timestamp; defaults to datetime('now').
 *   actor              — the user_id that performed the action.
 *   action             — edit|pause|resume|run_now|cancel|move|move_intent|
 *                        move_restore_failed. No CHECK constraint — values are
 *                        enforced in the app layer so the enum can widen without
 *                        a migration.
 *   agent_group_id/    — locate the affected series. Move rows are written one
 *   session_id/          per side (source + target groups), sharing a
 *   series_id            correlation_id so each side's audit tail is complete
 *                        without a cross-scope read.
 *   before_hash/        — sha256 of the prompt body before/after an edit
 *   after_hash           (createHash precedent, steer.ts). Scripts are
 *                        hash-only — never stored verbatim.
 *   before_preview/     — first 512 chars of the prompt body before/after.
 *   after_preview        Scripts are NOT previewed (hash-only).
 *   before_len/         — body lengths, for at-a-glance diff size.
 *   after_len
 *   detail_json         — non-body structured detail: cron change, move
 *                        source→target, secret-delta COUNTS + hashes only
 *                        (names are never persisted — that would re-open the
 *                        enumeration hole §4.5 closes). move_intent rows carry
 *                        the FULL source-row snapshot here, purged on resolve.
 *   correlation_id      — links the two sides of a move; prune-exempt.
 *   resolved_at         — move_intent / move_restore_failed rows: stamped on
 *                        success by the execute handler or the sweep recovery
 *                        hook; the detail_json body is purged at the same time.
 *
 * Indexes: series (drawer tail by series), correlation (move two-sided join),
 * unresolved (sweep recovery scan: WHERE action=? AND resolved_at IS NULL).
 */
export const migration043: Migration = {
  version: 43,
  name: 'scheduled-audit',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              TEXT NOT NULL DEFAULT (datetime('now')),
        actor           TEXT NOT NULL,
        action          TEXT NOT NULL,
        agent_group_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        series_id       TEXT NOT NULL,
        before_hash     TEXT,
        after_hash      TEXT,
        before_preview  TEXT,
        after_preview   TEXT,
        before_len      INTEGER,
        after_len       INTEGER,
        detail_json     TEXT,
        correlation_id  TEXT,
        resolved_at     TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_series ON scheduled_audit(series_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_correlation ON scheduled_audit(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_audit_unresolved ON scheduled_audit(action, resolved_at);
    `);
  },
};
