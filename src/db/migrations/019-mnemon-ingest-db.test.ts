import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMnemonIngestMigrations } from './019-mnemon-ingest-db.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

const dbs: Database.Database[] = [];
function tracked(db: Database.Database): Database.Database {
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbs.length = 0;
});

describe('migration 019: mnemon-ingest-db', () => {
  it('test_migration_creates_tables', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    expect(tables).toContain('processed_pairs');
    expect(tables).toContain('processed_sources');
    expect(tables).toContain('watermarks');
    expect(tables).toContain('dead_letters');
  });

  it('test_v2_adds_emitted_and_dropped_low_importance_columns', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);

    const pairCols = (
      db.prepare(`PRAGMA table_info(processed_pairs)`).all() as { name: string; dflt_value: string | null }[]
    ).reduce<Record<string, string | null>>((acc, c) => ((acc[c.name] = c.dflt_value), acc), {});
    expect(pairCols).toHaveProperty('facts_emitted');
    expect(pairCols).toHaveProperty('facts_dropped_low_importance');

    const sourceCols = (
      db.prepare(`PRAGMA table_info(processed_sources)`).all() as { name: string; dflt_value: string | null }[]
    ).reduce<Record<string, string | null>>((acc, c) => ((acc[c.name] = c.dflt_value), acc), {});
    expect(sourceCols).toHaveProperty('facts_emitted');
    expect(sourceCols).toHaveProperty('facts_dropped_low_importance');

    // Counters apply to BOTH paths — chat-pair AND source-ingest. Default 0
    // means pre-existing rows (and any caller still using legacy INSERT shape)
    // get clean zero values rather than NULL.
    expect(pairCols.facts_emitted).toBe('0');
    expect(pairCols.facts_dropped_low_importance).toBe('0');
    expect(sourceCols.facts_emitted).toBe('0');
    expect(sourceCols.facts_dropped_low_importance).toBe('0');
  });

  it('test_v2_idempotent — running migration twice does not duplicate columns', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);
    // ALTER TABLE ADD COLUMN is not idempotent in SQLite — running twice would
    // throw "duplicate column name". The schema_version guard must prevent that.
    expect(() => runMnemonIngestMigrations(db)).not.toThrow();
  });

  it('test_processed_pairs_pk_orphan_distinction', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);

    const now = new Date().toISOString();
    const base = {
      agent_group_id: 'ag-1',
      user_run_first_id: 'run-1',
      classifier_version: 'v1',
      prompt_version: 'v1',
      classified_at: now,
      facts_written: 2,
    };

    db.prepare(
      `
      INSERT INTO processed_pairs
        (agent_group_id, user_run_first_id, classifier_version, prompt_version, is_orphan, classified_at, facts_written)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      base.agent_group_id,
      base.user_run_first_id,
      base.classifier_version,
      base.prompt_version,
      1,
      base.classified_at,
      base.facts_written,
    );

    db.prepare(
      `
      INSERT INTO processed_pairs
        (agent_group_id, user_run_first_id, classifier_version, prompt_version, is_orphan, classified_at, facts_written)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      base.agent_group_id,
      base.user_run_first_id,
      base.classifier_version,
      base.prompt_version,
      0,
      base.classified_at,
      base.facts_written,
    );

    const count = (db.prepare('SELECT COUNT(*) AS c FROM processed_pairs').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('test_processed_sources_pk_agent_group_distinction', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);

    const now = new Date().toISOString();
    const shared = {
      content_sha256: 'abc123',
      extractor_version: 'v1',
      prompt_version: 'v1',
      source_path: '/some/file.md',
      ingested_at: now,
      facts_written: 3,
    };

    db.prepare(
      `
      INSERT INTO processed_sources
        (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'ag-1',
      shared.content_sha256,
      shared.extractor_version,
      shared.prompt_version,
      shared.source_path,
      shared.ingested_at,
      shared.facts_written,
    );

    db.prepare(
      `
      INSERT INTO processed_sources
        (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'ag-2',
      shared.content_sha256,
      shared.extractor_version,
      shared.prompt_version,
      shared.source_path,
      shared.ingested_at,
      shared.facts_written,
    );

    const count = (db.prepare('SELECT COUNT(*) AS c FROM processed_sources').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('test_dead_letters_retry_index', () => {
    const db = tracked(freshDb());
    runMnemonIngestMigrations(db);

    const now = new Date();
    const past1 = new Date(now.getTime() - 120_000).toISOString();
    const past2 = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();
    const nowIso = now.toISOString();

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('dl-1', 'turn-pair', 'key-1', 'ag-1', 1, nowIso, past1, null);

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('dl-2', 'turn-pair', 'key-2', 'ag-1', 1, nowIso, past2, null);

    db.prepare(
      `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('dl-3', 'turn-pair', 'key-3', 'ag-1', 3, nowIso, null, nowIso);

    const dueRows = db
      .prepare(
        `
        SELECT id FROM dead_letters
        WHERE poisoned_at IS NULL AND next_retry_at <= ?
        ORDER BY next_retry_at
      `,
      )
      .all(nowIso) as { id: string }[];

    expect(dueRows.map((r) => r.id)).toEqual(['dl-1', 'dl-2']);

    const futureRow = db
      .prepare(
        `
      INSERT INTO dead_letters (id, item_type, item_key, agent_group_id, failure_count, last_attempted_at, next_retry_at, poisoned_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run('dl-4', 'turn-pair', 'key-4', 'ag-1', 1, nowIso, future, null);
    expect(futureRow.changes).toBe(1);

    const dueAfterFuture = db
      .prepare(`SELECT id FROM dead_letters WHERE poisoned_at IS NULL AND next_retry_at <= ? ORDER BY next_retry_at`)
      .all(nowIso) as { id: string }[];
    expect(dueAfterFuture.map((r) => r.id)).toEqual(['dl-1', 'dl-2']);
  });
});
