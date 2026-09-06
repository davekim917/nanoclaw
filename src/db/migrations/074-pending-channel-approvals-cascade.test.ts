import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration074 } from './074-pending-channel-approvals-cascade.js';
import { migrations, runMigrations } from './index.js';

/** The full ledger minus 074, so the fixture can be seeded at the pre-fix schema. */
const before = migrations.filter((m) => m !== migration074);

type Card = { messaging_group_id: string; agent_group_id: string; title: string };

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO agent_groups (id, name, folder, created_at)
      VALUES ('ag-1', 'Agent One', 'agent-one', '2026-01-01T00:00:00.000Z');
    INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at)
      VALUES ('mg-kept', 'cli', 'chan-kept', 'cli', '2026-01-01T00:00:00.000Z'),
             ('mg-deleted', 'cli', 'chan-deleted', 'cli', '2026-01-01T00:00:00.000Z');
  `);
}

function card(messagingGroupId: string, title: string): string {
  return `INSERT INTO pending_channel_approvals
            (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title)
            VALUES ('${messagingGroupId}', 'ag-1', '{}', 'user-1', '2026-01-01T00:00:00.000Z', '${title}')`;
}

function cards(db: Database.Database): Card[] {
  return db
    .prepare('SELECT messaging_group_id, agent_group_id, title FROM pending_channel_approvals ORDER BY title')
    .all() as Card[];
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migration074', () => {
  it('deletes orphaned rows and leaves rows with a live parent alone', () => {
    const db = freshDb();
    try {
      runMigrations(db, before);
      seed(db);
      db.exec(card('mg-kept', 'kept'));
      // The orphan this migration exists to clear: its parent messaging group
      // is gone, which is only reachable with FK enforcement off (#487).
      db.pragma('foreign_keys = OFF');
      db.exec(card('mg-deleted', 'orphan'));
      db.exec(`DELETE FROM messaging_groups WHERE id = 'mg-deleted'`);
      db.pragma('foreign_keys = ON');
      expect(cards(db)).toHaveLength(2);
      expect(db.pragma('foreign_key_check')).toHaveLength(1);

      runMigrations(db, migrations);

      expect(cards(db)).toEqual([{ messaging_group_id: 'mg-kept', agent_group_id: 'ag-1', title: 'kept' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare('SELECT name FROM schema_version WHERE name = ?').pluck().get(migration074.name)).toBe(
        migration074.name,
      );
    } finally {
      db.close();
    }
  });

  it('cascades a messaging-group delete to its pending card and keeps the others', () => {
    const db = freshDb();
    try {
      runMigrations(db, migrations);
      seed(db);
      db.exec(card('mg-kept', 'kept'));
      db.exec(card('mg-deleted', 'deleted'));

      db.prepare('DELETE FROM messaging_groups WHERE id = ?').run('mg-deleted');

      expect(cards(db)).toEqual([{ messaging_group_id: 'mg-kept', agent_group_id: 'ag-1', title: 'kept' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('keeps the tip column list and still refuses a card for an unknown messaging group', () => {
    const db = freshDb();
    try {
      runMigrations(db, before);
      const columnsBefore = db.prepare(`PRAGMA table_info('pending_channel_approvals')`).all();
      runMigrations(db, migrations);

      expect(db.prepare(`PRAGMA table_info('pending_channel_approvals')`).all()).toEqual(columnsBefore);
      expect(db.prepare(`PRAGMA foreign_key_list('pending_channel_approvals')`).all()).toMatchObject([
        { table: 'agent_groups', from: 'agent_group_id', to: 'id', on_delete: 'NO ACTION' },
        { table: 'messaging_groups', from: 'messaging_group_id', to: 'id', on_delete: 'CASCADE' },
      ]);

      seed(db);
      expect(() => db.exec(card('mg-missing', 'rejected'))).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }
  });
});
