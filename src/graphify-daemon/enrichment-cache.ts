import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { ExtractionBundle, SourceInput } from '../graphify/types.js';

export interface PersistedEnrichment {
  sourceId: string;
  workgroupId: string;
  contentHash: string;
  code?: ExtractionBundle;
  semantic?: ExtractionBundle;
}

export interface SemanticQueueItem {
  source: SourceInput;
  segments: string[];
  baseBundle?: ExtractionBundle;
  imagePath?: string;
  documentPath?: string;
  sourceRoot?: string;
  rootRelativePath?: string;
  priority: number;
}

interface QueueRow {
  source_json: string;
  segments_json: string;
  base_json: string | null;
  image_path: string | null;
  document_path: string | null;
  source_root: string | null;
  root_relative_path: string | null;
  priority: number;
}

export class EnrichmentRepository {
  private readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    // Full-corpus workers enqueue semantic jobs while the control daemon serves
    // status reads from a separate connection. WAL keeps those readers from
    // blocking a worker commit long enough to abort the entire safety scan.
    // Set the timeout before negotiating journal mode so a concurrent opener
    // also waits rather than failing immediately during startup.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enrichments (
        source_id TEXT PRIMARY KEY, workgroup_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        code_json TEXT, semantic_json TEXT, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS enrichments_workgroup ON enrichments(workgroup_id);
      CREATE TABLE IF NOT EXISTS semantic_queue (
        source_id TEXT PRIMARY KEY, workgroup_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        source_json TEXT NOT NULL, segments_json TEXT NOT NULL, base_json TEXT, image_path TEXT,
        document_path TEXT, source_root TEXT, root_relative_path TEXT,
        priority INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL, enqueued_at TEXT NOT NULL, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS semantic_queue_ready ON semantic_queue(state, available_at, priority DESC, enqueued_at);
      UPDATE semantic_queue SET state = 'pending' WHERE state = 'running';
    `);
    for (const sql of [
      'ALTER TABLE semantic_queue ADD COLUMN document_path TEXT',
      'ALTER TABLE semantic_queue ADD COLUMN source_root TEXT',
      'ALTER TABLE semantic_queue ADD COLUMN root_relative_path TEXT',
      'ALTER TABLE semantic_queue ADD COLUMN base_json TEXT',
    ]) {
      try {
        this.db.exec(sql);
      } catch {
        /* additive column already exists */
      }
    }
    // Older daemons counted expected background preemption as a failed
    // semantic attempt. Heal that retry debt on open so jobs which lost five
    // races to freshness are not stranded forever in the terminal state.
    this.db
      .prepare(
        `UPDATE semantic_queue
            SET state='pending', attempts=0, available_at=?, last_error=NULL
          WHERE last_error IN ('preempted', 'deferred')`,
      )
      .run(new Date().toISOString());
  }
  close(): void {
    this.db.close();
  }
  load(workgroupId: string): PersistedEnrichment[] {
    const rows = this.db.prepare('SELECT * FROM enrichments WHERE workgroup_id = ?').all(workgroupId) as Array<{
      source_id: string;
      workgroup_id: string;
      content_hash: string;
      code_json: string | null;
      semantic_json: string | null;
    }>;
    return rows.map((row) => ({
      sourceId: row.source_id,
      workgroupId: row.workgroup_id,
      contentHash: row.content_hash,
      ...(row.code_json ? { code: JSON.parse(row.code_json) as ExtractionBundle } : {}),
      ...(row.semantic_json ? { semantic: JSON.parse(row.semantic_json) as ExtractionBundle } : {}),
    }));
  }
  get(sourceId: string): PersistedEnrichment | undefined {
    const row = this.db.prepare('SELECT * FROM enrichments WHERE source_id = ?').get(sourceId) as
      | {
          source_id: string;
          workgroup_id: string;
          content_hash: string;
          code_json: string | null;
          semantic_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      sourceId: row.source_id,
      workgroupId: row.workgroup_id,
      contentHash: row.content_hash,
      ...(row.code_json ? { code: JSON.parse(row.code_json) as ExtractionBundle } : {}),
      ...(row.semantic_json ? { semantic: JSON.parse(row.semantic_json) as ExtractionBundle } : {}),
    };
  }
  hasCurrent(sourceId: string, contentHash: string, kind: 'code' | 'semantic'): boolean {
    const column = kind === 'code' ? 'code_json' : 'semantic_json';
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM enrichments WHERE source_id = ? AND content_hash = ? AND ${column} IS NOT NULL`,
      )
      .get(sourceId, contentHash) as { present: number } | undefined;
    return row?.present === 1;
  }
  put(entry: PersistedEnrichment): void {
    const prior = this.db
      .prepare('SELECT content_hash, code_json, semantic_json FROM enrichments WHERE source_id = ?')
      .get(entry.sourceId) as
      | { content_hash: string; code_json: string | null; semantic_json: string | null }
      | undefined;
    const sameVersion = prior?.content_hash === entry.contentHash;
    this.db
      .prepare(
        `INSERT INTO enrichments (source_id, workgroup_id, content_hash, code_json, semantic_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET workgroup_id=excluded.workgroup_id, content_hash=excluded.content_hash,
        code_json=excluded.code_json, semantic_json=excluded.semantic_json, updated_at=excluded.updated_at`,
      )
      .run(
        entry.sourceId,
        entry.workgroupId,
        entry.contentHash,
        entry.code ? JSON.stringify(entry.code) : sameVersion ? (prior?.code_json ?? null) : null,
        entry.semantic ? JSON.stringify(entry.semantic) : sameVersion ? (prior?.semantic_json ?? null) : null,
        new Date().toISOString(),
      );
  }
  enqueue(items: SemanticQueueItem[]): void {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`INSERT INTO semantic_queue
      (source_id, workgroup_id, content_hash, source_json, segments_json, base_json, image_path, document_path, source_root, root_relative_path,
       priority, state, attempts, available_at, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        workgroup_id=excluded.workgroup_id, content_hash=excluded.content_hash, source_json=excluded.source_json,
        segments_json=excluded.segments_json, base_json=excluded.base_json, image_path=excluded.image_path, document_path=excluded.document_path,
        source_root=excluded.source_root, root_relative_path=excluded.root_relative_path, priority=MAX(priority, excluded.priority),
        state=CASE WHEN semantic_queue.content_hash=excluded.content_hash THEN semantic_queue.state ELSE 'pending' END,
        attempts=CASE WHEN semantic_queue.content_hash=excluded.content_hash THEN semantic_queue.attempts ELSE 0 END,
        available_at=CASE WHEN semantic_queue.content_hash=excluded.content_hash THEN semantic_queue.available_at ELSE excluded.available_at END`);
    this.db.transaction((batch: SemanticQueueItem[]) => {
      for (const item of batch)
        statement.run(
          item.source.id,
          item.source.workgroupId,
          item.source.contentHash,
          JSON.stringify(item.source),
          JSON.stringify(item.segments),
          item.baseBundle ? JSON.stringify(item.baseBundle) : null,
          item.imagePath ?? null,
          item.documentPath ?? null,
          item.sourceRoot ?? null,
          item.rootRelativePath ?? null,
          item.priority,
          now,
          now,
        );
    })(items);
  }
  claimBatch(maxItems = 25, maxBytes = 256 * 1024, workgroupIds?: string[]): SemanticQueueItem[] {
    return this.db.transaction(() => {
      if (workgroupIds && workgroupIds.length === 0) return [];
      const scope = workgroupIds ? ` AND workgroup_id IN (${workgroupIds.map(() => '?').join(',')})` : '';
      const rows = this.db
        .prepare(
          `SELECT source_json, segments_json, base_json, image_path, document_path, source_root, root_relative_path, priority FROM semantic_queue
        WHERE state='pending' AND datetime(available_at) <= datetime(?)${scope} ORDER BY priority DESC, enqueued_at LIMIT ?`,
        )
        .all(new Date().toISOString(), ...(workgroupIds ?? []), maxItems * 4) as QueueRow[];
      const selected: SemanticQueueItem[] = [];
      let bytes = 0;
      let imageMode: boolean | undefined;
      for (const row of rows) {
        const source = JSON.parse(row.source_json) as SourceInput;
        const segments = JSON.parse(row.segments_json) as string[];
        const isAsset = Boolean(row.image_path || row.document_path);
        if (imageMode === undefined) imageMode = isAsset;
        if (isAsset !== imageMode || (isAsset && selected.length > 0)) continue;
        const size = Buffer.byteLength(segments.join('\n\n'));
        if (selected.length && bytes + size > maxBytes) continue;
        selected.push({
          source,
          segments,
          ...(row.base_json ? { baseBundle: JSON.parse(row.base_json) as ExtractionBundle } : {}),
          ...(row.image_path ? { imagePath: row.image_path } : {}),
          ...(row.document_path ? { documentPath: row.document_path } : {}),
          ...(row.source_root ? { sourceRoot: row.source_root } : {}),
          ...(row.root_relative_path ? { rootRelativePath: row.root_relative_path } : {}),
          priority: row.priority,
        });
        bytes += size;
        if (selected.length >= maxItems) break;
      }
      const mark = this.db.prepare("UPDATE semantic_queue SET state='running' WHERE source_id=?");
      for (const item of selected) mark.run(item.source.id);
      return selected;
    })();
  }
  complete(sourceIds: string[]): void {
    const statement = this.db.prepare('DELETE FROM semantic_queue WHERE source_id=?');
    this.db.transaction((ids: string[]) => {
      for (const id of ids) statement.run(id);
    })(sourceIds);
  }
  removeSources(sourceIds: string[]): void {
    if (sourceIds.length === 0) return;
    const removeQueued = this.db.prepare('DELETE FROM semantic_queue WHERE source_id=?');
    const removeEnrichment = this.db.prepare('DELETE FROM enrichments WHERE source_id=?');
    this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        removeQueued.run(id);
        removeEnrichment.run(id);
      }
    })(sourceIds);
  }
  pruneWorkgroup(workgroupId: string, retainedSourceIds: string[]): void {
    this.db.exec(`CREATE TEMP TABLE IF NOT EXISTS retained_enrichment_sources (
      source_id TEXT PRIMARY KEY
    ) WITHOUT ROWID`);
    const clearRetained = this.db.prepare('DELETE FROM retained_enrichment_sources');
    const retain = this.db.prepare('INSERT OR IGNORE INTO retained_enrichment_sources (source_id) VALUES (?)');
    this.db.transaction((sourceIds: string[]) => {
      clearRetained.run();
      for (const sourceId of sourceIds) retain.run(sourceId);
      this.db
        .prepare(
          `DELETE FROM semantic_queue
            WHERE workgroup_id=?
              AND NOT EXISTS (
                SELECT 1 FROM retained_enrichment_sources retained
                 WHERE retained.source_id=semantic_queue.source_id
              )`,
        )
        .run(workgroupId);
      this.db
        .prepare(
          `DELETE FROM enrichments
            WHERE workgroup_id=?
              AND NOT EXISTS (
                SELECT 1 FROM retained_enrichment_sources retained
                 WHERE retained.source_id=enrichments.source_id
              )`,
        )
        .run(workgroupId);
      clearRetained.run();
    })(retainedSourceIds);
  }
  defer(sourceIds: string[], delayMs = 5_000): void {
    const availableAt = new Date(Date.now() + delayMs).toISOString();
    const statement = this.db.prepare("UPDATE semantic_queue SET state='pending', available_at=? WHERE source_id=?");
    this.db.transaction((ids: string[]) => {
      for (const id of ids) statement.run(availableAt, id);
    })(sourceIds);
  }
  retry(sourceIds: string[], error: string): void {
    const rows = this.db
      .prepare(
        `SELECT source_id, attempts FROM semantic_queue WHERE source_id IN (${sourceIds.map(() => '?').join(',')})`,
      )
      .all(...sourceIds) as Array<{ source_id: string; attempts: number }>;
    const statement = this.db.prepare(
      'UPDATE semantic_queue SET state=?, attempts=?, available_at=?, last_error=? WHERE source_id=?',
    );
    for (const row of rows) {
      const attempt = row.attempts + 1;
      const terminal = attempt >= 5;
      statement.run(
        terminal ? 'failed' : 'pending',
        attempt,
        new Date(Date.now() + Math.min(60_000, 5_000 * 2 ** (attempt - 1))).toISOString(),
        error.slice(0, 2000),
        row.source_id,
      );
    }
  }
  pending(workgroupId?: string): number {
    const row = workgroupId
      ? this.db
          .prepare(
            "SELECT count(*) AS count FROM semantic_queue WHERE workgroup_id=? AND state IN ('pending','running')",
          )
          .get(workgroupId)
      : this.db.prepare("SELECT count(*) AS count FROM semantic_queue WHERE state IN ('pending','running')").get();
    return (row as { count: number }).count;
  }
  clearWorkgroup(workgroupId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM semantic_queue WHERE workgroup_id=?').run(workgroupId);
      this.db.prepare('DELETE FROM enrichments WHERE workgroup_id=?').run(workgroupId);
    })();
  }
}
