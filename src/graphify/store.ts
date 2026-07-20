import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';

import {
  SOURCE_KINDS,
  SOURCE_STATES,
  type ExtractionBundle,
  type GraphAffectedResult,
  type GraphEdge,
  type GraphEdgeWithEvidence,
  type GraphEvidence,
  type GraphExplainResult,
  type GraphHyperedge,
  type GraphHyperedgeWithEvidence,
  type GraphNode,
  type GraphNodeWithEvidence,
  type GraphPathResult,
  type GraphQueryResult,
  type SourceInput,
  type SourceRecord,
  type SourceState,
  type SourceStateCounts,
  type WorkgroupGraphStatus,
} from './types.js';

const SCHEMA_VERSION = 1;
const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_TRAVERSAL_DEPTH = 8;
const MAX_TRAVERSAL_DEPTH = 64;

type SqlValue = string | number | bigint | Buffer | null;

interface SourceRow {
  id: string;
  workgroup_id: string;
  kind: SourceInput['kind'];
  relative_path: string;
  content_hash: string;
  size_bytes: number | null;
  modified_at: string | null;
  state: SourceState;
  generation: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  name: string;
  type: string;
  description: string | null;
  properties_json: string | null;
  confidence: number | null;
}

interface EdgeRow {
  source_id: string;
  id: string;
  from_node: string;
  to_node: string;
  type: string;
  structural: number;
  description: string | null;
  properties_json: string | null;
  confidence: number | null;
}

interface HyperedgeRow {
  source_id: string;
  id: string;
  type: string;
  name: string | null;
  description: string | null;
  properties_json: string | null;
  confidence: number | null;
}

interface EvidenceRow {
  source_id: string;
  relative_path: string;
  line: number | null;
  page: number | null;
  sheet: string | null;
  message_id: string | null;
  sent_at: string | null;
  excerpt: string | null;
}

interface PathRow {
  node_path: string;
  edge_path: string;
  depth: number;
}

interface PathEdgeReference {
  sourceId: string;
  id: string;
}

export interface SourceReconciliation {
  source: SourceInput;
  bundle: ExtractionBundle;
  force?: boolean;
}

export interface SourceStateAppend {
  source: SourceInput;
  state: Exclude<SourceState, 'indexed'>;
  error?: string;
}

export interface SourceReconciliationResult {
  generation: number;
  upsertedSourceIds: string[];
  deletedSourceIds: string[];
  unchangedSourceIds: string[];
}

/**
 * Synchronous, single-writer store for one workgroup graph.
 *
 * Callers must serialize mutation calls through the owning daemon. SQLite still
 * protects the database from accidental concurrent writes, while DELETE journal
 * mode keeps committed changes visible across bind mounts.
 */
export class WorkgroupGraphStore {
  private readonly db: Database.Database;
  private closed = false;

  constructor(
    dbPath: string,
    public readonly workgroupId: string,
  ) {
    if (!workgroupId.trim()) {
      throw new Error('workgroupId must not be empty');
    }

    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    try {
      this.db.pragma('journal_mode = DELETE');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      this.initializeSchema();
      this.claimWorkgroup();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  beginGeneration(reason: string): number {
    this.assertOpen();
    if (!reason.trim()) throw new Error('generation reason must not be empty');

    return this.db
      .transaction(() => {
        const current = this.readMetadataNumber('current_generation');
        const generation = current + 1;
        const now = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO generations (generation, reason, started_at)
           VALUES (?, ?, ?)`,
          )
          .run(generation, reason, now);
        this.writeMetadata('current_generation', String(generation));
        return generation;
      })
      .immediate();
  }

  completeGeneration(generation: number): void {
    this.assertOpen();
    this.assertGenerationNumber(generation);

    this.db
      .transaction(() => {
        const result = this.db
          .prepare(
            `UPDATE generations
              SET completed_at = ?
            WHERE generation = ?`,
          )
          .run(new Date().toISOString(), generation);
        if (result.changes === 0) {
          throw new Error(`unknown generation ${generation}`);
        }
        const complete = this.readMetadataNumber('complete_generation');
        if (generation > complete) {
          this.writeMetadata('complete_generation', String(generation));
        }
      })
      .immediate();
  }

  upsertSource(source: SourceInput, bundle: ExtractionBundle, generation: number): void {
    this.upsertSources([{ source, bundle }], generation);
  }

  /**
   * Apply a bounded batch inside one transaction while keeping the caller's
   * generation open. Full-corpus builders use this to avoid retaining every
   * extracted bundle in memory before the private next-generation DB is
   * promoted.
   */
  upsertSources(upserts: SourceReconciliation[], generation: number): void {
    this.assertOpen();
    this.assertGenerationNumber(generation);
    const seen = new Set<string>();
    for (const { source, bundle } of upserts) {
      if (seen.has(source.id)) throw new Error(`duplicate upserted source id ${source.id}`);
      seen.add(source.id);
      this.validateSource(source);
      this.validateBundle(source, bundle);
    }

    this.db
      .transaction(() => {
        this.requireGeneration(generation);
        for (const { source } of upserts) {
          this.assertPathOwnership(source);
          this.removeSourceContributions(source.id);
        }
        this.removeOrphanedNodes();
        for (const { source, bundle } of upserts) {
          this.writeSource(source, 'indexed', generation);
          for (const node of bundle.nodes) this.writeNode(source, node);
          for (const edge of bundle.edges) this.writeEdge(source, edge);
          for (const hyperedge of bundle.hyperedges) this.writeHyperedge(source, hyperedge);
        }
        this.removeOrphanedNodes();
      })
      .immediate();
  }

  /**
   * Append a bounded batch to a brand-new, incomplete graph generation.
   *
   * Unlike upsertSources(), this deliberately performs no replacement or
   * whole-graph orphan cleanup. Strict source INSERTs preserve duplicate id
   * and path detection across batches. Callers must only use this while
   * building a private next-generation database whose complete generation is
   * still zero.
   */
  appendSources(upserts: SourceReconciliation[], generation: number): void {
    this.assertOpen();
    this.assertGenerationNumber(generation);
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const { source, bundle } of upserts) {
      if (seenIds.has(source.id)) throw new Error(`duplicate appended source id ${source.id}`);
      if (seenPaths.has(source.relativePath)) throw new Error(`duplicate appended source path ${source.relativePath}`);
      seenIds.add(source.id);
      seenPaths.add(source.relativePath);
      this.validateSource(source);
      this.validateBundle(source, bundle);
    }

    this.db
      .transaction(() => {
        this.requireGeneration(generation);
        if (this.readMetadataNumber('complete_generation') !== 0) {
          throw new Error('appendSources requires a private graph with no complete generation');
        }
        for (const { source, bundle } of upserts) {
          this.insertSource(source, 'indexed', generation);
          for (const node of bundle.nodes) this.writeNode(source, node);
          for (const edge of bundle.edges) this.writeEdge(source, edge);
          for (const hyperedge of bundle.hyperedges) this.writeHyperedge(source, hyperedge);
        }
      })
      .immediate();
  }

  /**
   * Append state-only sources while building a private generation.
   *
   * There cannot be source contributions to remove in a brand-new graph, so
   * the live-graph orphan sweep in markSourceState() would only rescan every
   * node already appended. Keeping this path insert-only makes metadata and
   * extraction failures O(1) with respect to the corpus built so far.
   */
  appendSourceStates(items: SourceStateAppend[], generation: number): void {
    this.assertOpen();
    this.assertGenerationNumber(generation);
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    for (const { source, state } of items) {
      if (seenIds.has(source.id)) throw new Error(`duplicate appended source id ${source.id}`);
      if (seenPaths.has(source.relativePath)) throw new Error(`duplicate appended source path ${source.relativePath}`);
      seenIds.add(source.id);
      seenPaths.add(source.relativePath);
      this.validateSource(source);
      if (!SOURCE_STATES.includes(state)) throw new Error(`invalid source state: ${String(state)}`);
    }

    this.db
      .transaction(() => {
        this.requireGeneration(generation);
        if (this.readMetadataNumber('complete_generation') !== 0) {
          throw new Error('appendSourceStates requires a private graph with no complete generation');
        }
        for (const { source, state, error } of items) this.insertSource(source, state, generation, error);
      })
      .immediate();
  }

  markSourceState(source: SourceInput, state: SourceState, generation: number, error?: string): void {
    this.assertOpen();
    this.validateSource(source);
    if (!SOURCE_STATES.includes(state)) {
      throw new Error(`invalid source state: ${String(state)}`);
    }
    this.assertGenerationNumber(generation);

    this.db
      .transaction(() => {
        this.requireGeneration(generation);
        this.assertPathOwnership(source);
        if (state !== 'indexed') {
          this.removeSourceContributions(source.id);
        }
        this.writeSource(source, state, generation, error);
        this.removeOrphanedNodes();
      })
      .immediate();
  }

  deleteSource(sourceId: string, generation: number): void {
    this.assertOpen();
    if (!sourceId.trim()) throw new Error('source id must not be empty');
    this.assertGenerationNumber(generation);

    this.db
      .transaction(() => {
        this.requireGeneration(generation);
        const existing = this.getSourceByIdInternal(sourceId);
        if (!existing) return;
        this.removeSourceContributions(sourceId);
        this.db
          .prepare(
            `UPDATE sources
              SET state = 'deleted', generation = ?, error = NULL, updated_at = ?
            WHERE id = ? AND workgroup_id = ?`,
          )
          .run(generation, new Date().toISOString(), sourceId, this.workgroupId);
        this.removeOrphanedNodes();
      })
      .immediate();
  }

  /**
   * Atomically reconcile a bounded set of sources in the live graph.
   *
   * Sources whose indexed content hash is unchanged are deliberately left
   * untouched, including their generation and graph contributions. This is
   * the inexpensive path used by archive polling: a new chat segment updates
   * only that segment instead of copying or rewriting the whole graph.
   */
  reconcileSources(
    reason: string,
    upserts: SourceReconciliation[],
    deleteSourceIds: string[],
  ): SourceReconciliationResult {
    this.assertOpen();
    if (!reason.trim()) throw new Error('generation reason must not be empty');

    const seen = new Set<string>();
    for (const item of upserts) {
      if (seen.has(item.source.id)) throw new Error(`duplicate reconciled source id ${item.source.id}`);
      seen.add(item.source.id);
      this.validateSource(item.source);
      this.validateBundle(item.source, item.bundle);
    }
    for (const sourceId of deleteSourceIds) {
      if (!sourceId.trim()) throw new Error('source id must not be empty');
      if (seen.has(sourceId)) throw new Error(`source ${sourceId} cannot be both upserted and deleted`);
      if (seen.has(`delete:${sourceId}`)) throw new Error(`duplicate deleted source id ${sourceId}`);
      seen.add(`delete:${sourceId}`);
    }

    const currentRows = this.db
      .prepare(`SELECT * FROM sources WHERE workgroup_id = ?`)
      .all(this.workgroupId) as SourceRow[];
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const changed = upserts.filter(({ source, force }) => {
      if (force) return true;
      const current = currentById.get(source.id);
      return !current || current.state !== 'indexed' || current.content_hash !== source.contentHash;
    });
    const changedIds = new Set(changed.map(({ source }) => source.id));
    const unchangedSourceIds = upserts
      .filter(({ source }) => !changedIds.has(source.id))
      .map(({ source }) => source.id);
    const deletedSourceIds = deleteSourceIds.filter((sourceId) => {
      const current = currentById.get(sourceId);
      return current !== undefined && current.state !== 'deleted';
    });

    if (changed.length === 0 && deletedSourceIds.length === 0) {
      return {
        generation: this.readMetadataNumber('complete_generation'),
        upsertedSourceIds: [],
        deletedSourceIds: [],
        unchangedSourceIds,
      };
    }

    return this.db
      .transaction(() => {
        const generation = this.readMetadataNumber('current_generation') + 1;
        const now = new Date().toISOString();
        this.db
          .prepare(`INSERT INTO generations (generation, reason, started_at) VALUES (?, ?, ?)`)
          .run(generation, reason, now);
        this.writeMetadata('current_generation', String(generation));

        for (const sourceId of deletedSourceIds) {
          this.removeSourceContributions(sourceId);
          this.db
            .prepare(
              `UPDATE sources
          SET state = 'deleted', generation = ?, error = NULL, updated_at = ?
          WHERE id = ? AND workgroup_id = ?`,
            )
            .run(generation, now, sourceId, this.workgroupId);
        }
        for (const { source } of changed) {
          this.assertPathOwnership(source);
          this.removeSourceContributions(source.id);
        }
        this.removeOrphanedNodes();

        for (const { source, bundle } of changed) {
          this.writeSource(source, 'indexed', generation);
          for (const node of bundle.nodes) this.writeNode(source, node);
          for (const edge of bundle.edges) this.writeEdge(source, edge);
          for (const hyperedge of bundle.hyperedges) this.writeHyperedge(source, hyperedge);
        }
        this.removeOrphanedNodes();
        this.db
          .prepare(`UPDATE generations SET completed_at = ? WHERE generation = ?`)
          .run(new Date().toISOString(), generation);
        this.writeMetadata('complete_generation', String(generation));
        return {
          generation,
          upsertedSourceIds: changed.map(({ source }) => source.id),
          deletedSourceIds,
          unchangedSourceIds,
        };
      })
      .immediate();
  }

  getSource(relativePath: string): SourceRecord | null {
    this.assertOpen();
    this.validateRelativePath(relativePath);
    const row = this.db
      .prepare(
        `SELECT * FROM sources
          WHERE workgroup_id = ? AND relative_path = ?`,
      )
      .get(this.workgroupId, relativePath) as SourceRow | undefined;
    return row ? this.mapSource(row) : null;
  }

  getSourceById(sourceId: string): SourceRecord | null {
    this.assertOpen();
    return this.getSourceByIdInternal(sourceId);
  }

  listSourcesByState(state: SourceState): SourceRecord[] {
    this.assertOpen();
    if (!SOURCE_STATES.includes(state)) {
      throw new Error(`invalid source state: ${String(state)}`);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM sources
          WHERE workgroup_id = ? AND state = ?
          ORDER BY relative_path`,
      )
      .all(this.workgroupId, state) as SourceRow[];
    return rows.map((row) => this.mapSource(row));
  }

  query(term: string, options: { limit?: number } = {}): GraphQueryResult {
    this.assertOpen();
    const normalized = term.trim();
    const limit = this.normalizeLimit(options.limit);
    if (!normalized) {
      return {
        term,
        nodes: [],
        edges: [],
        hyperedges: [],
        indexedGeneration: this.readMetadataNumber('complete_generation'),
      };
    }

    const nodeIds: string[] = [];
    const seen = new Set<string>();
    const addRows = (rows: Array<{ id: string }>): void => {
      for (const row of rows) {
        if (!seen.has(row.id) && nodeIds.length < limit) {
          seen.add(row.id);
          nodeIds.push(row.id);
        }
      }
    };

    // Keep exact identifiers and names ahead of full-text results. Do not use
    // a leading-wildcard LIKE here: on a multi-gigabyte workgroup graph that
    // forces an unindexed scan before FTS and can block interactive queries
    // for more than a minute.
    addRows(
      this.db
        .prepare(
          `SELECT DISTINCT n.id
             FROM nodes n
             JOIN source_nodes sn ON sn.node_id = n.id
             JOIN sources s ON s.id = sn.source_id
            WHERE s.workgroup_id = ? AND s.state = 'indexed'
              AND (n.id = ? COLLATE NOCASE OR n.name = ? COLLATE NOCASE)
            ORDER BY
              CASE WHEN n.id = ? COLLATE NOCASE THEN 0 ELSE 1 END,
              n.name, n.id
            LIMIT ?`,
        )
        .all(this.workgroupId, normalized, normalized, normalized, limit) as Array<{
        id: string;
      }>,
    );

    if (nodeIds.length < limit) {
      const ftsQuery = this.toFtsQuery(normalized);
      if (ftsQuery) {
        addRows(
          this.db
            .prepare(
              `SELECT DISTINCT node_fts.node_id AS id
                 FROM node_fts
                 JOIN sources s ON s.id = node_fts.source_id
                WHERE node_fts MATCH ?
                  AND s.workgroup_id = ? AND s.state = 'indexed'
                ORDER BY node_fts.node_id
                LIMIT ?`,
            )
            .all(ftsQuery, this.workgroupId, limit - nodeIds.length) as Array<{
            id: string;
          }>,
        );
      }
    }

    if (nodeIds.length < limit) {
      const prefixQuery = this.toFtsQuery(normalized, true);
      if (prefixQuery) {
        addRows(
          this.db
            .prepare(
              `SELECT DISTINCT node_fts.node_id AS id
                 FROM node_fts
                 JOIN sources s ON s.id = node_fts.source_id
                WHERE node_fts MATCH ?
                  AND s.workgroup_id = ? AND s.state = 'indexed'
                ORDER BY node_fts.node_id
                LIMIT ?`,
            )
            .all(prefixQuery, this.workgroupId, limit - nodeIds.length) as Array<{
            id: string;
          }>,
        );
      }
    }

    const nodes = this.loadNodes(nodeIds);
    return {
      term,
      nodes,
      edges: this.loadEdgesBetween(nodeIds),
      hyperedges: this.loadHyperedgesForNodes(nodeIds),
      indexedGeneration: this.generationForNodeIds(nodeIds),
    };
  }

  explain(nodeId: string): GraphExplainResult | null {
    this.assertOpen();
    const node = this.loadNode(nodeId);
    if (!node) return null;

    const outgoing = this.loadEdges(
      `SELECT e.* FROM edges e
        JOIN sources s ON s.id = e.source_id
       WHERE s.workgroup_id = ? AND s.state = 'indexed' AND e.from_node = ?
       ORDER BY e.type, e.to_node, e.id, e.source_id`,
      [this.workgroupId, nodeId],
    );
    const incoming = this.loadEdges(
      `SELECT e.* FROM edges e
        JOIN sources s ON s.id = e.source_id
       WHERE s.workgroup_id = ? AND s.state = 'indexed' AND e.to_node = ?
       ORDER BY e.type, e.from_node, e.id, e.source_id`,
      [this.workgroupId, nodeId],
    );

    return {
      node,
      evidence: node.evidence,
      incoming,
      outgoing,
      hyperedges: this.loadHyperedgesForNodes([nodeId]),
      indexedGeneration: this.generationForNodeIds([nodeId]),
    };
  }

  path(from: string, to: string, options: { maxDepth?: number } = {}): GraphPathResult | null {
    this.assertOpen();
    const maxDepth = this.normalizeDepth(options.maxDepth);
    if (!this.loadNode(from) || !this.loadNode(to)) return null;

    const row = this.db
      .prepare(
        `WITH RECURSIVE walk(current_node, node_path, edge_path, depth) AS (
           SELECT ?, json_array(?), json_array(), 0
           UNION ALL
           SELECT e.to_node,
                  json_insert(walk.node_path, '$[#]', e.to_node),
                  json_insert(
                    walk.edge_path,
                    '$[#]',
                    json_object('sourceId', e.source_id, 'id', e.id)
                  ),
                  walk.depth + 1
             FROM walk
             JOIN edges e ON e.from_node = walk.current_node
             JOIN sources s ON s.id = e.source_id
            WHERE s.workgroup_id = ? AND s.state = 'indexed'
              AND walk.depth < ?
              AND NOT EXISTS (
                SELECT 1 FROM json_each(walk.node_path)
                 WHERE json_each.value = e.to_node
              )
         )
         SELECT node_path, edge_path, depth
           FROM walk
          WHERE current_node = ?
          ORDER BY depth
          LIMIT 1`,
      )
      .get(from, from, this.workgroupId, maxDepth, to) as PathRow | undefined;
    if (!row) return null;

    const nodeIds = JSON.parse(row.node_path) as string[];
    const edgeReferences = JSON.parse(row.edge_path) as PathEdgeReference[];
    const edges = edgeReferences
      .map((reference) => this.loadEdge(reference.sourceId, reference.id))
      .filter((edge): edge is GraphEdgeWithEvidence => edge !== null);

    return {
      from,
      to,
      nodes: this.loadNodes(nodeIds),
      edges,
      indexedGeneration: this.generationForNodeIds(nodeIds),
    };
  }

  affected(nodeId: string, options: { maxDepth?: number } = {}): GraphAffectedResult {
    this.assertOpen();
    const maxDepth = this.normalizeDepth(options.maxDepth);
    if (!this.loadNode(nodeId)) {
      return {
        source: nodeId,
        nodes: [],
        edges: [],
        indexedGeneration: this.readMetadataNumber('complete_generation'),
      };
    }

    const rows = this.db
      .prepare(
        `WITH RECURSIVE impacted(node_id, depth, node_path) AS (
           SELECT ?, 0, json_array(?)
           UNION ALL
           SELECT e.from_node,
                  impacted.depth + 1,
                  json_insert(impacted.node_path, '$[#]', e.from_node)
             FROM impacted
             JOIN edges e ON e.to_node = impacted.node_id AND e.structural = 1
             JOIN sources s ON s.id = e.source_id
            WHERE s.workgroup_id = ? AND s.state = 'indexed'
              AND impacted.depth < ?
              AND NOT EXISTS (
                SELECT 1 FROM json_each(impacted.node_path)
                 WHERE json_each.value = e.from_node
              )
         )
         SELECT node_id, min(depth) AS depth
           FROM impacted
          WHERE depth > 0
          GROUP BY node_id
          ORDER BY depth, node_id`,
      )
      .all(nodeId, nodeId, this.workgroupId, maxDepth) as Array<{
      node_id: string;
      depth: number;
    }>;
    const nodeIds = rows.map((row) => row.node_id);
    const traversalIds = [nodeId, ...nodeIds];
    const placeholders = traversalIds.map(() => '?').join(', ');
    const edges = nodeIds.length
      ? this.loadEdges(
          `SELECT e.* FROM edges e
            JOIN sources s ON s.id = e.source_id
           WHERE s.workgroup_id = ? AND s.state = 'indexed'
             AND e.structural = 1
             AND e.from_node IN (${placeholders})
             AND e.to_node IN (${placeholders})
           ORDER BY e.from_node, e.to_node, e.id, e.source_id`,
          [this.workgroupId, ...traversalIds, ...traversalIds],
        )
      : [];

    return {
      source: nodeId,
      nodes: this.loadNodes(nodeIds),
      edges,
      indexedGeneration: this.generationForNodeIds(traversalIds),
    };
  }

  status(): WorkgroupGraphStatus {
    this.assertOpen();
    const counts = Object.fromEntries(SOURCE_STATES.map((state) => [state, 0])) as SourceStateCounts;
    const rows = this.db
      .prepare(
        `SELECT state, count(*) AS count
           FROM sources
          WHERE workgroup_id = ?
          GROUP BY state`,
      )
      .all(this.workgroupId) as Array<{ state: SourceState; count: number }>;
    for (const row of rows) counts[row.state] = row.count;

    const jobRow = this.db
      .prepare(
        `SELECT count(*) AS count FROM jobs
          WHERE workgroup_id = ? AND state IN ('pending', 'running')`,
      )
      .get(this.workgroupId) as { count: number };

    return {
      workgroupId: this.workgroupId,
      counts,
      currentGeneration: this.readMetadataNumber('current_generation'),
      completeGeneration: this.readMetadataNumber('complete_generation'),
      pendingJobs: counts.pending + jobRow.count,
      failures: this.listSourcesByState('failed'),
      quarantines: this.listSourcesByState('quarantined'),
    };
  }

  lastCompletedAt(): string | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        `SELECT completed_at
           FROM generations
          WHERE completed_at IS NOT NULL
          ORDER BY generation DESC
          LIMIT 1`,
      )
      .get() as { completed_at: string } | undefined;
    return row?.completed_at;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS generations (
        generation INTEGER PRIMARY KEY,
        reason TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER,
        modified_at TEXT,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (workgroup_id, relative_path),
        FOREIGN KEY (generation) REFERENCES generations(generation)
      );

      CREATE INDEX IF NOT EXISTS sources_state_idx
        ON sources(workgroup_id, state, relative_path);
      CREATE INDEX IF NOT EXISTS sources_hash_idx
        ON sources(workgroup_id, content_hash);

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        properties_json TEXT,
        confidence REAL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS source_nodes (
        source_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        PRIMARY KEY (source_id, node_id),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        id TEXT NOT NULL,
        from_node TEXT NOT NULL,
        to_node TEXT NOT NULL,
        type TEXT NOT NULL,
        structural INTEGER NOT NULL CHECK (structural IN (0, 1)),
        description TEXT,
        properties_json TEXT,
        confidence REAL,
        PRIMARY KEY (source_id, id),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
        FOREIGN KEY (from_node) REFERENCES nodes(id),
        FOREIGN KEY (to_node) REFERENCES nodes(id)
      );

      CREATE INDEX IF NOT EXISTS edges_from_idx ON edges(from_node, structural);
      CREATE INDEX IF NOT EXISTS edges_to_idx ON edges(to_node, structural);

      CREATE TABLE IF NOT EXISTS hyperedges (
        source_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        name TEXT,
        description TEXT,
        properties_json TEXT,
        confidence REAL,
        PRIMARY KEY (source_id, id),
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS hyperedge_members (
        source_id TEXT NOT NULL,
        hyperedge_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        role TEXT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (source_id, hyperedge_id, ordinal),
        FOREIGN KEY (source_id, hyperedge_id)
          REFERENCES hyperedges(source_id, id) ON DELETE CASCADE,
        FOREIGN KEY (node_id) REFERENCES nodes(id)
      );

      CREATE INDEX IF NOT EXISTS hyperedge_members_node_idx
        ON hyperedge_members(node_id);

      CREATE TABLE IF NOT EXISTS evidence (
        evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        line INTEGER,
        page INTEGER,
        sheet TEXT,
        message_id TEXT,
        sent_at TEXT,
        excerpt TEXT,
        FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS evidence_entity_idx
        ON evidence(entity_kind, entity_id, source_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
        node_id UNINDEXED,
        source_id UNINDEXED,
        name,
        type,
        description
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        workgroup_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        FOREIGN KEY (generation) REFERENCES generations(generation)
      );

      CREATE INDEX IF NOT EXISTS jobs_state_idx
        ON jobs(workgroup_id, state, generation);
    `);
  }

  private claimWorkgroup(): void {
    const existing = this.db.prepare(`SELECT value FROM metadata WHERE key = 'workgroup_id'`).get() as
      | { value: string }
      | undefined;
    if (existing && existing.value !== this.workgroupId) {
      throw new Error(`graph belongs to workgroup ${existing.value}, not ${this.workgroupId}`);
    }
    this.db
      .transaction(() => {
        this.writeMetadata('workgroup_id', this.workgroupId);
        this.writeMetadata('schema_version', String(SCHEMA_VERSION));
        if (!this.hasMetadata('current_generation')) {
          this.writeMetadata('current_generation', '0');
        }
        if (!this.hasMetadata('complete_generation')) {
          this.writeMetadata('complete_generation', '0');
        }
      })
      .immediate();
  }

  private writeNode(source: SourceInput, node: GraphNode): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO nodes (
           id, name, type, description, properties_json, confidence, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = excluded.type,
           description = excluded.description,
           properties_json = excluded.properties_json,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        node.id,
        node.name,
        node.type,
        node.description ?? null,
        this.stringifyProperties(node.properties),
        node.confidence ?? null,
        now,
      );
    this.db.prepare(`INSERT INTO source_nodes (source_id, node_id) VALUES (?, ?)`).run(source.id, node.id);
    this.db
      .prepare(
        `INSERT INTO node_fts (node_id, source_id, name, type, description)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(node.id, source.id, node.name, node.type, node.description ?? '');
    this.writeEvidence(source, 'node', node.id, node.evidence);
  }

  private writeEdge(source: SourceInput, edge: GraphEdge): void {
    this.assertNodesExist([edge.from, edge.to], `edge ${edge.id}`);
    this.db
      .prepare(
        `INSERT INTO edges (
           source_id, id, from_node, to_node, type, structural,
           description, properties_json, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        edge.id,
        edge.from,
        edge.to,
        edge.type,
        edge.structural ? 1 : 0,
        edge.description ?? null,
        this.stringifyProperties(edge.properties),
        edge.confidence ?? null,
      );
    this.writeEvidence(source, 'edge', edge.id, edge.evidence);
  }

  private writeHyperedge(source: SourceInput, hyperedge: GraphHyperedge): void {
    this.assertNodesExist(
      hyperedge.members.map((member) => member.nodeId),
      `hyperedge ${hyperedge.id}`,
    );
    this.db
      .prepare(
        `INSERT INTO hyperedges (
           source_id, id, type, name, description, properties_json, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        hyperedge.id,
        hyperedge.type,
        hyperedge.name ?? null,
        hyperedge.description ?? null,
        this.stringifyProperties(hyperedge.properties),
        hyperedge.confidence ?? null,
      );
    const insertMember = this.db.prepare(
      `INSERT INTO hyperedge_members (
         source_id, hyperedge_id, node_id, role, ordinal
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    hyperedge.members.forEach((member, ordinal) => {
      insertMember.run(source.id, hyperedge.id, member.nodeId, member.role ?? null, ordinal);
    });
    this.writeEvidence(source, 'hyperedge', hyperedge.id, hyperedge.evidence);
  }

  private writeEvidence(
    source: SourceInput,
    entityKind: 'node' | 'edge' | 'hyperedge',
    entityId: string,
    items: GraphEvidence[] | undefined,
  ): void {
    const evidence = items?.length ? items : [{ sourceId: source.id, relativePath: source.relativePath }];
    const insert = this.db.prepare(
      `INSERT INTO evidence (
         source_id, entity_kind, entity_id, relative_path,
         line, page, sheet, message_id, sent_at, excerpt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of evidence) {
      insert.run(
        item.sourceId,
        entityKind,
        entityId,
        item.relativePath,
        item.line ?? null,
        item.page ?? null,
        item.sheet ?? null,
        item.messageId ?? null,
        item.sentAt ?? null,
        item.excerpt ?? null,
      );
    }
  }

  private writeSource(source: SourceInput, state: SourceState, generation: number, error?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sources (
           id, workgroup_id, kind, relative_path, content_hash,
           size_bytes, modified_at, state, generation, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workgroup_id = excluded.workgroup_id,
           kind = excluded.kind,
           relative_path = excluded.relative_path,
           content_hash = excluded.content_hash,
           size_bytes = excluded.size_bytes,
           modified_at = excluded.modified_at,
           state = excluded.state,
           generation = excluded.generation,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .run(
        source.id,
        this.workgroupId,
        source.kind,
        source.relativePath,
        source.contentHash,
        source.sizeBytes ?? null,
        source.modifiedAt ?? null,
        state,
        generation,
        error ?? null,
        now,
        now,
      );
  }

  private insertSource(source: SourceInput, state: SourceState, generation: number, error?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sources (
           id, workgroup_id, kind, relative_path, content_hash,
           size_bytes, modified_at, state, generation, error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        source.id,
        this.workgroupId,
        source.kind,
        source.relativePath,
        source.contentHash,
        source.sizeBytes ?? null,
        source.modifiedAt ?? null,
        state,
        generation,
        error ?? null,
        now,
        now,
      );
  }

  private removeSourceContributions(sourceId: string): void {
    this.db.prepare(`DELETE FROM node_fts WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM evidence WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM edges WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM hyperedges WHERE source_id = ?`).run(sourceId);
    this.db.prepare(`DELETE FROM source_nodes WHERE source_id = ?`).run(sourceId);
  }

  private removeOrphanedNodes(): void {
    this.db.exec(`
      DELETE FROM nodes
       WHERE NOT EXISTS (
               SELECT 1 FROM source_nodes WHERE source_nodes.node_id = nodes.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM edges
                WHERE edges.from_node = nodes.id OR edges.to_node = nodes.id
             )
         AND NOT EXISTS (
               SELECT 1 FROM hyperedge_members
                WHERE hyperedge_members.node_id = nodes.id
             )
    `);
  }

  private loadNode(nodeId: string): GraphNodeWithEvidence | null {
    const row = this.db
      .prepare(
        `SELECT n.* FROM nodes n
          WHERE n.id = ?
            AND EXISTS (
              SELECT 1 FROM source_nodes sn
              JOIN sources s ON s.id = sn.source_id
              WHERE sn.node_id = n.id
                AND s.workgroup_id = ? AND s.state = 'indexed'
            )`,
      )
      .get(nodeId, this.workgroupId) as NodeRow | undefined;
    return row ? this.mapNode(row) : null;
  }

  private loadNodes(nodeIds: string[]): GraphNodeWithEvidence[] {
    return nodeIds
      .map((nodeId) => this.loadNode(nodeId))
      .filter((node): node is GraphNodeWithEvidence => node !== null);
  }

  private mapNode(row: NodeRow): GraphNodeWithEvidence {
    const node: GraphNodeWithEvidence = {
      id: row.id,
      name: row.name,
      type: row.type,
      evidence: this.loadEvidence('node', row.id),
    };
    if (row.description !== null) node.description = row.description;
    const properties = this.parseProperties(row.properties_json);
    if (properties) node.properties = properties;
    if (row.confidence !== null) node.confidence = row.confidence;
    return node;
  }

  private loadEdgesBetween(nodeIds: string[]): GraphEdgeWithEvidence[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(', ');
    return this.loadEdges(
      `SELECT e.* FROM edges e
        JOIN sources s ON s.id = e.source_id
       WHERE s.workgroup_id = ? AND s.state = 'indexed'
         AND e.from_node IN (${placeholders})
         AND e.to_node IN (${placeholders})
       ORDER BY e.from_node, e.to_node, e.type, e.id, e.source_id`,
      [this.workgroupId, ...nodeIds, ...nodeIds],
    );
  }

  private loadEdges(sql: string, parameters: SqlValue[]): GraphEdgeWithEvidence[] {
    const rows = this.db.prepare(sql).all(...parameters) as EdgeRow[];
    const merged = new Map<string, GraphEdgeWithEvidence>();
    for (const row of rows) {
      const key = [row.id, row.from_node, row.to_node, row.type, row.structural].join('\u001f');
      const evidence = this.loadEvidence('edge', row.id, row.source_id);
      const existing = merged.get(key);
      if (existing) {
        existing.evidence = this.dedupeEvidence([...existing.evidence, ...evidence]);
        continue;
      }
      const edge: GraphEdgeWithEvidence = {
        id: row.id,
        from: row.from_node,
        to: row.to_node,
        type: row.type,
        structural: row.structural === 1,
        evidence,
      };
      if (row.description !== null) edge.description = row.description;
      const properties = this.parseProperties(row.properties_json);
      if (properties) edge.properties = properties;
      if (row.confidence !== null) edge.confidence = row.confidence;
      merged.set(key, edge);
    }
    return [...merged.values()];
  }

  private loadEdge(sourceId: string, edgeId: string): GraphEdgeWithEvidence | null {
    return (
      this.loadEdges(
        `SELECT e.* FROM edges e
          JOIN sources s ON s.id = e.source_id
         WHERE s.workgroup_id = ? AND s.state = 'indexed'
           AND e.source_id = ? AND e.id = ?`,
        [this.workgroupId, sourceId, edgeId],
      )[0] ?? null
    );
  }

  private loadHyperedgesForNodes(nodeIds: string[]): GraphHyperedgeWithEvidence[] {
    if (nodeIds.length === 0) return [];
    const placeholders = nodeIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT DISTINCT h.* FROM hyperedges h
          JOIN sources s ON s.id = h.source_id
          JOIN hyperedge_members hm
            ON hm.source_id = h.source_id AND hm.hyperedge_id = h.id
         WHERE s.workgroup_id = ? AND s.state = 'indexed'
           AND hm.node_id IN (${placeholders})
         ORDER BY h.type, h.id, h.source_id`,
      )
      .all(this.workgroupId, ...nodeIds) as HyperedgeRow[];
    return rows.map((row) => this.mapHyperedge(row));
  }

  private mapHyperedge(row: HyperedgeRow): GraphHyperedgeWithEvidence {
    const members = this.db
      .prepare(
        `SELECT node_id, role FROM hyperedge_members
          WHERE source_id = ? AND hyperedge_id = ?
          ORDER BY ordinal`,
      )
      .all(row.source_id, row.id) as Array<{
      node_id: string;
      role: string | null;
    }>;
    const hyperedge: GraphHyperedgeWithEvidence = {
      id: row.id,
      type: row.type,
      members: members.map((member) =>
        member.role === null ? { nodeId: member.node_id } : { nodeId: member.node_id, role: member.role },
      ),
      evidence: this.loadEvidence('hyperedge', row.id, row.source_id),
    };
    if (row.name !== null) hyperedge.name = row.name;
    if (row.description !== null) hyperedge.description = row.description;
    const properties = this.parseProperties(row.properties_json);
    if (properties) hyperedge.properties = properties;
    if (row.confidence !== null) hyperedge.confidence = row.confidence;
    return hyperedge;
  }

  private loadEvidence(
    entityKind: 'node' | 'edge' | 'hyperedge',
    entityId: string,
    sourceId?: string,
  ): GraphEvidence[] {
    const sourceClause = sourceId ? 'AND e.source_id = ?' : '';
    const parameters: SqlValue[] = [this.workgroupId, entityKind, entityId, ...(sourceId ? [sourceId] : [])];
    const rows = this.db
      .prepare(
        `SELECT e.source_id, e.relative_path, e.line, e.page, e.sheet,
                e.message_id, e.sent_at, e.excerpt
           FROM evidence e
           JOIN sources s ON s.id = e.source_id
          WHERE s.workgroup_id = ? AND s.state = 'indexed'
            AND e.entity_kind = ? AND e.entity_id = ? ${sourceClause}
          ORDER BY e.relative_path, e.source_id, e.evidence_id`,
      )
      .all(...parameters) as EvidenceRow[];
    return this.dedupeEvidence(rows.map((row) => this.mapEvidence(row)));
  }

  private mapEvidence(row: EvidenceRow): GraphEvidence {
    const evidence: GraphEvidence = {
      sourceId: row.source_id,
      relativePath: row.relative_path,
    };
    if (row.line !== null) evidence.line = row.line;
    if (row.page !== null) evidence.page = row.page;
    if (row.sheet !== null) evidence.sheet = row.sheet;
    if (row.message_id !== null) evidence.messageId = row.message_id;
    if (row.sent_at !== null) evidence.sentAt = row.sent_at;
    if (row.excerpt !== null) evidence.excerpt = row.excerpt;
    return evidence;
  }

  private dedupeEvidence(items: GraphEvidence[]): GraphEvidence[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private generationForNodeIds(nodeIds: string[]): number {
    if (nodeIds.length === 0) {
      return this.readMetadataNumber('complete_generation');
    }
    const placeholders = nodeIds.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT coalesce(max(s.generation), 0) AS generation
           FROM source_nodes sn
           JOIN sources s ON s.id = sn.source_id
          WHERE s.workgroup_id = ? AND s.state = 'indexed'
            AND sn.node_id IN (${placeholders})`,
      )
      .get(this.workgroupId, ...nodeIds) as { generation: number };
    return row.generation;
  }

  private validateSource(source: SourceInput): void {
    if (!source.id.trim()) throw new Error('source id must not be empty');
    if (source.workgroupId !== this.workgroupId) {
      throw new Error(`source ${source.id} belongs to workgroup ${source.workgroupId}, not ${this.workgroupId}`);
    }
    if (!SOURCE_KINDS.includes(source.kind)) {
      throw new Error(`invalid source kind: ${String(source.kind)}`);
    }
    this.validateRelativePath(source.relativePath);
    if (!source.contentHash.trim()) {
      throw new Error(`source ${source.id} content hash must not be empty`);
    }
    if (source.sizeBytes !== undefined && (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0)) {
      throw new Error(`source ${source.id} has an invalid size`);
    }
  }

  private validateBundle(source: SourceInput, bundle: ExtractionBundle): void {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const hyperedgeIds = new Set<string>();

    for (const node of bundle.nodes) {
      this.requireEntityIdentity(node.id, node.name, 'node');
      if (nodeIds.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
      nodeIds.add(node.id);
      this.validateEvidence(source, node.evidence);
    }
    for (const edge of bundle.edges) {
      this.requireEntityIdentity(edge.id, edge.type, 'edge');
      if (!edge.from.trim() || !edge.to.trim()) {
        throw new Error(`edge ${edge.id} must have from and to node ids`);
      }
      if (edgeIds.has(edge.id)) throw new Error(`duplicate edge id ${edge.id}`);
      edgeIds.add(edge.id);
      this.validateEvidence(source, edge.evidence);
    }
    for (const hyperedge of bundle.hyperedges) {
      this.requireEntityIdentity(hyperedge.id, hyperedge.type, 'hyperedge');
      if (hyperedge.members.length === 0) {
        throw new Error(`hyperedge ${hyperedge.id} must have members`);
      }
      if (hyperedgeIds.has(hyperedge.id)) {
        throw new Error(`duplicate hyperedge id ${hyperedge.id}`);
      }
      hyperedgeIds.add(hyperedge.id);
      this.validateEvidence(source, hyperedge.evidence);
    }
  }

  private validateEvidence(source: SourceInput, evidence: GraphEvidence[] | undefined): void {
    for (const item of evidence ?? []) {
      if (item.sourceId !== source.id || item.relativePath !== source.relativePath) {
        throw new Error(`evidence source must match owning source ${source.id} at ${source.relativePath}`);
      }
      this.validateRelativePath(item.relativePath);
      for (const [label, value] of [
        ['line', item.line],
        ['page', item.page],
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
          throw new Error(`evidence ${label} must be a positive integer`);
        }
      }
    }
  }

  private validateRelativePath(relativePath: string): void {
    if (!relativePath.trim()) throw new Error('relative path must not be empty');
    const portable = relativePath.replaceAll('\\', '/');
    const normalized = posix.normalize(portable);
    if (
      portable.startsWith('/') ||
      /^[A-Za-z]:\//.test(portable) ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      throw new Error(`relative path escapes workgroup: ${relativePath}`);
    }
  }

  private assertPathOwnership(source: SourceInput): void {
    const conflicting = this.db
      .prepare(
        `SELECT id FROM sources
          WHERE workgroup_id = ? AND relative_path = ? AND id <> ?`,
      )
      .get(this.workgroupId, source.relativePath, source.id) as { id: string } | undefined;
    if (conflicting) {
      throw new Error(`relative path ${source.relativePath} already belongs to source ${conflicting.id}`);
    }
  }

  private assertNodesExist(nodeIds: string[], owner: string): void {
    const unique = [...new Set(nodeIds)];
    if (unique.length === 0) return;
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`).all(...unique) as Array<{
      id: string;
    }>;
    const found = new Set(rows.map((row) => row.id));
    const missing = unique.filter((id) => !found.has(id));
    if (missing.length) {
      throw new Error(`${owner} references missing nodes: ${missing.join(', ')}`);
    }
  }

  private requireEntityIdentity(id: string, secondary: string, kind: string): void {
    if (!id.trim() || !secondary.trim()) {
      throw new Error(`${kind} id and type/name must not be empty`);
    }
  }

  private requireGeneration(generation: number): void {
    const row = this.db.prepare(`SELECT 1 AS found FROM generations WHERE generation = ?`).get(generation) as
      | { found: number }
      | undefined;
    if (!row) throw new Error(`unknown generation ${generation}`);
  }

  private assertGenerationNumber(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error(`invalid generation ${generation}`);
    }
  }

  private mapSource(row: SourceRow): SourceRecord {
    const source: SourceRecord = {
      id: row.id,
      workgroupId: row.workgroup_id,
      kind: row.kind,
      relativePath: row.relative_path,
      contentHash: row.content_hash,
      state: row.state,
      generation: row.generation,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.size_bytes !== null) source.sizeBytes = row.size_bytes;
    if (row.modified_at !== null) source.modifiedAt = row.modified_at;
    if (row.error !== null) source.error = row.error;
    return source;
  }

  private getSourceByIdInternal(sourceId: string): SourceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM sources WHERE id = ? AND workgroup_id = ?`)
      .get(sourceId, this.workgroupId) as SourceRow | undefined;
    return row ? this.mapSource(row) : null;
  }

  private normalizeLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_QUERY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('query limit must be a positive integer');
    }
    return Math.min(limit, 200);
  }

  private normalizeDepth(depth: number | undefined): number {
    if (depth === undefined) return DEFAULT_TRAVERSAL_DEPTH;
    if (!Number.isSafeInteger(depth) || depth < 1) {
      throw new Error('maxDepth must be a positive integer');
    }
    return Math.min(depth, MAX_TRAVERSAL_DEPTH);
  }

  private toFtsQuery(term: string, prefix = false): string | null {
    const tokens = term.match(/[\p{L}\p{N}_-]+/gu);
    if (!tokens?.length) return null;
    return tokens.map((token) => `"${token.replaceAll('"', '""')}"${prefix ? '*' : ''}`).join(' AND ');
  }

  private stringifyProperties(properties: Record<string, unknown> | undefined): string | null {
    return properties === undefined ? null : JSON.stringify(properties);
  }

  private parseProperties(value: string | null): Record<string, unknown> | undefined {
    if (value === null) return undefined;
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  }

  private hasMetadata(key: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM metadata WHERE key = ?`).get(key));
  }

  private readMetadataNumber(key: string): number {
    const row = this.db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  private writeMetadata(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('graph store is closed');
  }
}
