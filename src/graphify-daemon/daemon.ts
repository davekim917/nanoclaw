import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

import Database from 'better-sqlite3';
import chokidar, { type FSWatcher } from 'chokidar';

import {
  discoverWorkgroup,
  discoverSourcePath,
  isGraphifyDefaultExcludedPath,
  type DiscoverWorkgroupOptions,
  type DiscoveredSource,
} from '../graphify/discovery.js';
import { preprocessDiscoveredSource, type PreprocessedSource } from '../graphify/extractors.js';
import { WorkgroupGraphStore, type SourceReconciliation, type SourceStateAppend } from '../graphify/store.js';
import {
  discoverCanonicalRepositories,
  resolveRepositoryWorkUnit,
  topicStateDir,
  topicWorktreesDir,
} from '../repository-workspaces.js';
import type {
  ExtractionBundle,
  GraphAffectedResult,
  GraphExplainResult,
  GraphPathResult,
  GraphQueryResult,
  SourceInput,
  WorkgroupGraphStatus,
} from '../graphify/types.js';
import { ArchiveConversationReader, type ConversationGraphSource } from './archive.js';
import { BackgroundGraphRunner, type BackgroundResult } from './background-runner.js';
import { CodexSemanticBackend } from './codex-backend.js';
import { GraphifyCodeWorker, type BinaryPreprocessResult, type CodeWorkerSource } from './code-worker.js';
import {
  EnrichmentRepository,
  type PersistedEnrichment,
  type SemanticQueueClaim,
  type SemanticQueueItem,
} from './enrichment-cache.js';
import { runIsolatedReconcile, type IsolatedReconcileResult } from './isolated-reconcile.js';
import { runIsolatedSourceReconcile } from './isolated-source-reconcile.js';
import { IsolatedGraphifyWatchers } from './isolated-watchers.js';
import { runIsolatedRead } from './isolated-read.js';
import { createReconcileStore, type ReconcileStore, type ReconcileStoreFactory } from './reconcile-store-worker.js';
import type {
  DaemonWorkgroupStatus,
  GraphifyFilesystemChange,
  TrustedOverlayContext,
  WorkgroupDescriptor,
  WorkgroupRoot,
} from './types.js';
import { acquireStorageActivityLease, type StorageActivityLease } from '../storage-activity.js';

export const DEFAULT_FULL_RECONCILE_MS = 6 * 60 * 60_000;
export const DEFAULT_CATALOG_REFRESH_MS = 60_000;
const MAX_RECONCILE_BATCH_SOURCES = 25;
const MAX_RECONCILE_BATCH_CONTRIBUTIONS = 500;
const MAX_RECONCILE_BATCH_TEXT_BYTES = 1024 * 1024;
const MAX_INCREMENTAL_FILESYSTEM_CHANGES = 1_000;

interface CodeSourceBuild {
  source: DiscoveredSource;
  root: WorkgroupRoot;
}
interface WorkgroupState {
  descriptor: WorkgroupDescriptor;
  store?: WorkgroupGraphStore;
  dirty: boolean;
  reconciling?: Promise<void>;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  serveStaleDuringStartup?: boolean;
  lastFailure?: string;
  pendingEnrichment: number;
  backgroundQueued?: boolean;
  archiveFingerprint?: string;
  archiveDirty?: boolean;
  reconcileFailures: number;
  epoch: number;
  dirtyVersion: number;
  archiveVersion: number;
  enrichmentVersion: number;
  fullReindexRequested: boolean;
  fullReindexVersion: number;
  reconcileAborts: Set<AbortController>;
  activeReads: number;
  promotionGate?: Promise<void>;
  pendingFilesystemChanges: Map<string, GraphifyFilesystemChange>;
  fullScanRequired: boolean;
  fullScanVersion: number;
  /** Sticky: a watcher hit ENOSPC, so filesystem coverage is incomplete. */
  watcherDegraded?: boolean;
}

interface BackgroundRunnerLike {
  run<T>(
    job: (signal: AbortSignal) => Promise<T>,
    options?: { preemptActive?: boolean; priority?: 'freshness' | 'normal' | 'enrichment' },
  ): Promise<BackgroundResult<T>>;
  stop?(): Promise<void> | void;
}

interface SemanticBackendLike {
  extract(source: SourceInput, segments: string[], signal?: AbortSignal): Promise<ExtractionBundle>;
  extractBatch?(
    items: Array<{ source: SourceInput; segments: string[]; imagePath?: string; imageRoot?: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, ExtractionBundle>>;
}

interface CodeWorkerLike {
  extract(
    workgroupId: string,
    sourceRoot: string,
    prefix: string,
    sources: CodeWorkerSource[],
    signal?: AbortSignal,
  ): Promise<Map<string, ExtractionBundle>>;
  preprocess?(sourceRoot: string, source: CodeWorkerSource, signal?: AbortSignal): Promise<BinaryPreprocessResult>;
  cleanupOrphans?(): Promise<void>;
}

export interface GraphifyRepositorySnapshot {
  repo: string;
  generation: string;
  snapshotPath: string;
  sourcePrefix: string;
}

/**
 * One host-committed catalog with every selected immutable generation already
 * pinned. The adapter owns catalog hashing, generation markers, and recovery;
 * Graphify holds `release` until its candidate is committed or aborted.
 */
export interface GraphifyPinnedCatalog {
  workgroupId: string;
  catalogHash: string;
  repositories: GraphifyRepositorySnapshot[];
  /** Mutable canonical mount targets and repo-store internals omitted from ordinary root discovery. */
  excludedRoots: string[];
  /** Re-read the committed record and prove this exact hash/generation selection is still current. */
  isCurrent(): Promise<boolean>;
  /** Optional early cancellation supplied by a catalog/freshness watcher. */
  changeSignal?: AbortSignal;
  release(): Promise<void>;
}

export interface GraphifyRepositorySnapshotAdapter {
  pinCommittedCatalog(input: { workgroupId: string; signal?: AbortSignal }): Promise<GraphifyPinnedCatalog>;
  subscribe?(
    workgroupId: string,
    onChange: () => void,
  ): Promise<() => Promise<void> | void> | (() => Promise<void> | void);
}

export interface GraphifyOverlayResolutionRequest {
  workgroupId: string;
  agentGroupId: string;
  sessionId: string;
  platformId: string | null;
  messagingGroupId: string | null;
  threadId: string | null;
  threadWorktrees: boolean;
}

export interface GraphifyOverlayLocation {
  sourceRoot: string;
  /** Exact canonical namespaced root leased by spawn, checkout, and cleanup. */
  workUnitRoot: string;
}

export type GraphifyOverlayResolver = (
  request: GraphifyOverlayResolutionRequest,
) => GraphifyOverlayLocation | Promise<GraphifyOverlayLocation>;

export interface WorkgroupGraphDaemonOptions {
  dataDir: string;
  groupsDir: string;
  centralDbPath?: string;
  archivePath?: string;
  containerImage?: string;
  graphifyVersion?: string;
  installLabel?: string;
  discover?: (options: DiscoverWorkgroupOptions) => Promise<DiscoveredSource[]>;
  archiveReader?: ArchiveConversationReader;
  backgroundRunner?: BackgroundRunnerLike;
  semanticBackend?: SemanticBackendLike;
  codeWorker?: CodeWorkerLike;
  /** Upstream structural extraction (code symbols, documents). Cheap, deterministic. */
  enableEnrichment?: boolean;
  /**
   * Our Codex semantic layer: an LLM re-reads each source and emits entity and
   * assertion nodes on top of the structural graph. One model call per 25
   * sources, re-queued whenever content changes, so it is a standing cost that
   * scales with corpus churn rather than corpus value. Off by default — the
   * structural graph already answers code-and-conversation retrieval on its own.
   */
  enableSemanticEnrichment?: boolean;
  threadWorktrees?: boolean;
  debounceMs?: number;
  archivePollMs?: number;
  fullReconcileMs?: number;
  semanticMinIntervalMs?: number;
  semanticPumpDelayMs?: number;
  reconcileRetryBaseMs?: number;
  preemptRetryMs?: number;
  catalogRefreshMs?: number;
  reconcileStoreFactory?: ReconcileStoreFactory;
  isolateReconcile?: boolean;
  scheduleEnrichmentAfterReconcile?: boolean;
  watchFilesystem?: boolean;
  repositorySnapshots?: GraphifyRepositorySnapshotAdapter;
  /** Repo-workspace adapter; production integration must pass the spawn path resolver here. */
  resolveOverlay?: GraphifyOverlayResolver;
  acquireOverlayReadClaim?: (workUnitRoot: string, holderId: string) => Promise<StorageActivityLease>;
}

/** Host-visible even when the systemd service uses PrivateTmp=yes. */
export function graphifyJobsRoot(dataDir: string): string {
  return join(dataDir, 'graphify', 'jobs');
}

function hash(...parts: string[]): string {
  const value = createHash('sha256');
  for (const part of parts) value.update(part).update('\0');
  return value.digest('hex');
}

function portable(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}
function prefixed(prefix: string, path: string): string {
  return posix.join(prefix, portable(path));
}
function stableSourceId(workgroupId: string, relativePath: string): string {
  return `source_${hash(workgroupId, relativePath)}`;
}
function sourceExtractionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `deterministic extraction failed: ${message}`.slice(0, 1_000);
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === 'AbortError');
}

class CatalogChangedError extends Error {
  constructor(readonly catalogHash: string) {
    super(`Graphify committed catalog changed while reconciling: ${catalogHash}`);
    this.name = 'CatalogChangedError';
  }
}

function containedBy(candidate: string, root: string): boolean {
  const offset = relative(resolve(root), resolve(candidate));
  return offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset));
}

interface ReconcileRoot extends WorkgroupRoot {
  excludedRoots?: string[];
}

interface ReconcileCatalogPlan {
  roots: ReconcileRoot[];
  pinned?: GraphifyPinnedCatalog;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function mergeBundles(...bundles: Array<ExtractionBundle | undefined>): ExtractionBundle {
  const nodes = new Map();
  const edges = new Map();
  const hyperedges = new Map();
  for (const bundle of bundles) {
    for (const node of bundle?.nodes ?? []) nodes.set(node.id, node);
    for (const edge of bundle?.edges ?? []) edges.set(edge.id, edge);
    for (const hyperedge of bundle?.hyperedges ?? []) hyperedges.set(hyperedge.id, hyperedge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], hyperedges: [...hyperedges.values()] };
}

function deterministicBundle(source: DiscoveredSource, prepared: PreprocessedSource): ExtractionBundle {
  const rootId = `document_${hash(source.id, 'root')}`;
  const evidence = [{ sourceId: source.id, relativePath: source.relativePath }];
  const nodes: ExtractionBundle['nodes'] = [
    {
      id: rootId,
      name: posix.basename(source.relativePath),
      type: source.kind,
      // Chunk nodes own the searchable body. Repeating the entire source on
      // the root doubles FTS/storage cost and makes one SQLite insert scale
      // with the full file rather than a bounded chunk.
      description: source.relativePath,
      properties: { ...prepared.metadata, redactionCount: prepared.redactionCount, binary: prepared.binary },
      evidence,
    },
  ];
  const edges: ExtractionBundle['edges'] = [];
  prepared.semanticSegments.forEach((segment, index) => {
    const id = `chunk_${hash(source.id, String(index), segment)}`;
    nodes.push({
      id,
      name: `${posix.basename(source.relativePath)} chunk ${index + 1}`,
      type: 'document_chunk',
      description: segment,
      properties: { ordinal: index },
      evidence,
    });
    edges.push({
      id: `edge_${hash(source.id, rootId, id)}`,
      from: rootId,
      to: id,
      type: 'contains',
      structural: true,
      evidence,
    });
  });
  const structuralIds = new Map(prepared.nodes.map((node) => [node.id, `struct_${hash(source.id, node.id)}`]));
  for (const node of prepared.nodes)
    nodes.push({
      id: structuralIds.get(node.id)!,
      name: node.name,
      type: node.type,
      properties: node.properties,
      evidence: [{ ...evidence[0], ...(node.line ? { line: node.line } : {}) }],
    });
  for (const edge of prepared.edges) {
    const from = structuralIds.get(edge.source);
    const to = structuralIds.get(edge.target);
    if (!from || !to) continue;
    edges.push({
      id: `struct_edge_${hash(source.id, edge.id)}`,
      from,
      to,
      type: edge.type,
      structural: true,
      properties: edge.properties,
      evidence: [{ ...evidence[0], ...(edge.line ? { line: edge.line } : {}) }],
    });
  }
  return { nodes, edges, hyperedges: [] };
}

function canonicalPart(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '_');
}

/** Canonical entity identity is workgroup-wide, while every contribution and edge remains source-owned. */
export function namespaceSemantic(source: SourceInput, bundle: ExtractionBundle): ExtractionBundle {
  const canonicalIds = new Map(
    bundle.nodes.map((node) => [
      node.id,
      `entity_${hash(source.workgroupId, canonicalPart(node.type), canonicalPart(node.name))}`,
    ]),
  );
  const assertionIds = new Map(bundle.nodes.map((node) => [node.id, `assertion_${hash(source.id, node.id)}`]));
  const evidence = [{ sourceId: source.id, relativePath: source.relativePath }];
  const nodes = new Map<string, ExtractionBundle['nodes'][number]>();
  for (const node of bundle.nodes) {
    const canonicalId = canonicalIds.get(node.id)!;
    nodes.set(canonicalId, {
      id: canonicalId,
      name: node.name,
      type: node.type,
      properties: { canonicalType: canonicalPart(node.type), canonicalName: canonicalPart(node.name) },
    });
    nodes.set(assertionIds.get(node.id)!, {
      ...node,
      id: assertionIds.get(node.id)!,
      type: 'source_assertion',
      properties: { ...node.properties, assertedType: node.type, canonicalEntityId: canonicalId },
      evidence,
    });
  }
  const rootId =
    source.kind === 'conversation' ? `conversation_${hash(source.id, 'root')}` : `document_${hash(source.id, 'root')}`;
  const edges: ExtractionBundle['edges'] = [];
  for (const [localId, canonicalId] of canonicalIds) {
    const assertionId = assertionIds.get(localId)!;
    edges.push({
      id: `semantic_mentions_${hash(source.id, assertionId)}`,
      from: rootId,
      to: assertionId,
      type: 'mentions',
      structural: false,
      evidence,
    });
    edges.push({
      id: `semantic_grounded_${hash(source.id, assertionId)}`,
      from: assertionId,
      to: rootId,
      type: 'grounded_in',
      structural: false,
      evidence,
    });
    edges.push({
      id: `semantic_asserts_${hash(source.id, assertionId, canonicalId)}`,
      from: assertionId,
      to: canonicalId,
      type: 'asserts',
      structural: false,
      evidence,
    });
    edges.push({
      id: `semantic_supported_${hash(source.id, assertionId, canonicalId)}`,
      from: canonicalId,
      to: assertionId,
      type: 'supported_by',
      structural: false,
      evidence,
    });
  }
  for (const edge of bundle.edges) {
    const from = assertionIds.get(edge.from);
    const to = assertionIds.get(edge.to);
    if (!from || !to || from === to) continue;
    edges.push({ ...edge, id: `semantic_edge_${hash(source.id, edge.id)}`, from, to, structural: false, evidence });
  }
  return {
    nodes: [...nodes.values()],
    edges,
    hyperedges: bundle.hyperedges
      .map((hyperedge) => ({
        ...hyperedge,
        id: `semantic_hyperedge_${hash(source.id, hyperedge.id)}`,
        members: hyperedge.members
          .map((member) => ({ ...member, nodeId: assertionIds.get(member.nodeId) ?? '' }))
          .filter((member) => member.nodeId),
        evidence,
      }))
      .filter((hyperedge) => hyperedge.members.length > 0),
  };
}

/** Connect source-owned structural code nodes to the document/SQL source root. */
export function bridgeCodeBundle(source: SourceInput, bundle: ExtractionBundle): ExtractionBundle {
  const rootId = `document_${hash(source.id, 'root')}`;
  const evidence = [{ sourceId: source.id, relativePath: source.relativePath }];
  const ownedNodes = bundle.nodes.filter((node) =>
    node.evidence?.some((item) => item.sourceId === source.id && item.relativePath === source.relativePath),
  );
  const bridges = ownedNodes.flatMap((node) => [
    {
      id: `code_implements_${hash(source.id, node.id)}`,
      from: rootId,
      to: node.id,
      type: 'implements',
      structural: false,
      evidence,
    },
    {
      id: `code_implemented_in_${hash(source.id, node.id)}`,
      from: node.id,
      to: rootId,
      type: 'implemented_in',
      structural: false,
      evidence,
    },
  ]);
  return { ...bundle, edges: [...bundle.edges, ...bridges] };
}

function binarySectionBundle(source: SourceInput, result: BinaryPreprocessResult): ExtractionBundle {
  const rootId = `document_${hash(source.id, 'root')}`;
  const base = { sourceId: source.id, relativePath: source.relativePath };
  const nodes: ExtractionBundle['nodes'] = [];
  const edges: ExtractionBundle['edges'] = [];
  result.sections.forEach((section, index) => {
    const evidence = [{ ...base, ...section.provenance }];
    const id = `binary_section_${hash(source.id, section.locator, String(index))}`;
    nodes.push({
      id,
      name: section.locator,
      type: section.kind,
      description: section.text,
      properties: { locator: section.locator },
      evidence,
    });
    edges.push({
      id: `binary_edge_${hash(source.id, id)}`,
      from: rootId,
      to: id,
      type: 'contains',
      structural: true,
      evidence,
    });
  });
  return { nodes, edges, hyperedges: [] };
}

export class WorkgroupGraphDaemon {
  private readonly centralDbPath: string;
  private readonly archivePath: string;
  private readonly discover: (options: DiscoverWorkgroupOptions) => Promise<DiscoveredSource[]>;
  private readonly archiveReader: ArchiveConversationReader;
  private readonly background: BackgroundRunnerLike;
  private readonly semantic?: SemanticBackendLike;
  private readonly codeWorker?: CodeWorkerLike;
  private readonly enableEnrichment: boolean;
  private readonly enableSemanticEnrichment: boolean;
  private readonly states = new Map<string, WorkgroupState>();
  private readonly enrichmentRepository: EnrichmentRepository;
  private readonly reconcileStoreFactory: ReconcileStoreFactory;
  private readonly isolateReconcile: boolean;
  private readonly scheduleEnrichmentAfterReconcile: boolean;
  private readonly watchFilesystem: boolean;
  private readonly isolatedWatchers?: IsolatedGraphifyWatchers;
  private readonly attempted = new Set<string>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly catalogSubscriptions = new Map<string, () => Promise<void> | void>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly paused = new Set<string>();
  private semanticPumpRunning = false;
  private semanticWakeTimer?: NodeJS.Timeout;
  private lastSemanticStartedAt = 0;
  private readonly threadWorktrees: boolean;
  private closing = false;

  constructor(private readonly options: WorkgroupGraphDaemonOptions) {
    this.centralDbPath = options.centralDbPath ?? join(options.dataDir, 'v2.db');
    this.archivePath = options.archivePath ?? join(options.dataDir, 'archive.db');
    this.discover = options.discover ?? discoverWorkgroup;
    this.archiveReader = options.archiveReader ?? new ArchiveConversationReader(this.archivePath);
    this.background =
      options.backgroundRunner ?? new BackgroundGraphRunner({ sessionsRoot: join(options.dataDir, 'v2-sessions') });
    this.enableEnrichment = options.enableEnrichment ?? true;
    this.enableSemanticEnrichment = options.enableSemanticEnrichment ?? false;
    this.threadWorktrees = options.threadWorktrees ?? process.env.NANOCLAW_THREAD_WORKTREES === '1';
    this.enrichmentRepository = new EnrichmentRepository(join(options.dataDir, 'graphify', 'enrichment.db'));
    this.reconcileStoreFactory = options.reconcileStoreFactory ?? createReconcileStore;
    this.isolateReconcile = options.isolateReconcile ?? !import.meta.url.endsWith('.ts');
    this.scheduleEnrichmentAfterReconcile = options.scheduleEnrichmentAfterReconcile ?? true;
    this.watchFilesystem = options.watchFilesystem ?? true;
    if (this.watchFilesystem && !import.meta.url.endsWith('.ts')) {
      this.isolatedWatchers = new IsolatedGraphifyWatchers({
        onDirty: (workgroupId, changes, fullScan) => {
          if (!this.states.has(workgroupId) || this.closing) return;
          this.markFilesystemChanges(workgroupId, changes, fullScan);
        },
        onError: (workgroupId, error) => {
          const degraded = String(error).includes('ENOSPC');
          const mark = (state: WorkgroupState): void => {
            state.lastFailure = `filesystem watcher: ${error}`;
            // A watch that never registered means change events for those paths
            // are simply never delivered. `lastFailure` is cleared by the next
            // successful reconcile, so without a sticky flag the daemon forgets
            // it is half-blind and keeps serving stale reads as fresh.
            if (degraded) state.watcherDegraded = true;
          };
          if (workgroupId && this.states.has(workgroupId)) mark(this.requireState(workgroupId));
          else for (const state of this.states.values()) mark(state);
        },
      });
    }
    const jobsRoot = graphifyJobsRoot(options.dataDir);
    // Structural extraction and semantic enrichment used to share one flag, so
    // the cheap upstream half could not be run without the expensive LLM half.
    this.semantic =
      options.semanticBackend ??
      (this.enableEnrichment && this.enableSemanticEnrichment
        ? new CodexSemanticBackend({ tempRoot: jobsRoot })
        : undefined);
    this.codeWorker =
      options.codeWorker ??
      (this.enableEnrichment && options.containerImage
        ? new GraphifyCodeWorker({
            image: options.containerImage,
            graphifyVersion: options.graphifyVersion ?? '0.9.25',
            tempRoot: jobsRoot,
            installLabel: options.installLabel,
          })
        : undefined);
  }

  async refreshCatalog(): Promise<WorkgroupDescriptor[]> {
    const db = new Database(this.centralDbPath, { readonly: true, fileMustExist: true });
    let rows: Array<{ workgroup_id: string; agent_group_id: string | null; folder: string | null }>;
    try {
      rows = db
        .prepare(
          `
        SELECT w.id AS workgroup_id, a.id AS agent_group_id, a.folder
          FROM workgroups w LEFT JOIN agent_groups a ON a.workgroup_id = w.id
         ORDER BY w.id, a.id
      `,
        )
        .all() as typeof rows;
    } finally {
      db.close();
    }
    const grouped = new Map<string, Array<{ id: string; folder: string }>>();
    for (const row of rows) {
      const members = grouped.get(row.workgroup_id) ?? [];
      if (row.agent_group_id && row.folder) members.push({ id: row.agent_group_id, folder: row.folder });
      grouped.set(row.workgroup_id, members);
    }
    const descriptors: WorkgroupDescriptor[] = [];
    for (const [id, members] of grouped) {
      const candidates: WorkgroupRoot[] = [];
      const shared = join(this.options.dataDir, 'workgroups', id);
      if (existsSync(shared)) candidates.push({ absolutePath: shared, prefix: 'workgroup' });
      for (const member of members) {
        const root = join(this.options.groupsDir, member.folder);
        if (existsSync(root)) candidates.push({ absolutePath: root, prefix: `agents/${member.id}` });
      }
      // Canonical repositories are host-only normal clones outside all
      // agent-writable workgroup roots. Graphify reads their clean working
      // trees directly; topic overlays below add in-progress changes only to
      // the requesting topic's query.
      for (const repository of discoverCanonicalRepositories(id, this.options.dataDir)) {
        candidates.push({ absolutePath: repository.path, prefix: `repositories/${repository.name}` });
      }
      const seen = new Set<string>();
      const roots: WorkgroupRoot[] = [];
      for (const candidate of candidates) {
        const actual = await realpath(candidate.absolutePath);
        if (seen.has(actual)) continue;
        seen.add(actual);
        roots.push({ ...candidate, absolutePath: actual });
      }
      const descriptor = { id, memberIds: members.map((member) => member.id), roots };
      descriptors.push(descriptor);
      const existing = this.states.get(id);
      if (existing) {
        const prior = JSON.stringify(existing.descriptor);
        existing.descriptor = descriptor;
        if (JSON.stringify(descriptor) !== prior) {
          existing.dirty = true;
          existing.dirtyVersion += 1;
          existing.fullScanRequired = true;
          existing.fullScanVersion += 1;
        }
      } else
        this.states.set(id, {
          descriptor,
          dirty: true,
          pendingEnrichment: 0,
          reconcileFailures: 0,
          epoch: 0,
          dirtyVersion: 1,
          archiveVersion: 0,
          enrichmentVersion: 0,
          fullReindexRequested: false,
          fullReindexVersion: 0,
          reconcileAborts: new Set(),
          activeReads: 0,
          pendingFilesystemChanges: new Map(),
          fullScanRequired: true,
          fullScanVersion: 1,
        });
    }
    const active = new Set(descriptors.map((descriptor) => descriptor.id));
    for (const [id, state] of this.states) {
      if (active.has(id) || (state.descriptor.memberIds.length === 0 && state.descriptor.roots.length === 0)) continue;
      state.descriptor = { id, memberIds: [], roots: [] };
      state.dirty = true;
      state.dirtyVersion += 1;
      state.fullScanRequired = true;
      state.fullScanVersion += 1;
    }
    return descriptors;
  }

  async start(): Promise<void> {
    const descriptors = await this.refreshCatalog();
    await this.syncRepositoryCatalogSubscriptions(descriptors);
    // Queue rows are only ever claimed for workgroups that have a live state,
    // so rows belonging to a deleted workgroup can never be processed — they
    // just inflate the backlog and the database forever. Guarded on a non-empty
    // catalog so a transient empty read can't wipe every queue.
    if (descriptors.length > 0)
      this.enrichmentRepository.pruneOrphanWorkgroups(descriptors.map((descriptor) => descriptor.id));
    for (const descriptor of descriptors) {
      const state = this.requireState(descriptor.id);
      const completedAt = this.readExistingLastCompletedAt(descriptor.id);
      if (completedAt) {
        state.lastCompletedAt = completedAt;
        state.serveStaleDuringStartup = true;
        this.pruneEnrichmentToCurrentGeneration(state);
      }
    }
    try {
      await this.codeWorker?.cleanupOrphans?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const state of this.states.values()) state.lastFailure = `Graphify orphan cleanup: ${message}`;
    }
    await this.pollArchiveOnce(false);
    await this.syncWatchers(descriptors);
    for (const descriptor of descriptors) this.queueReconcile(descriptor.id);
    const archivePoll = setInterval(
      () => {
        void this.pollArchiveOnce();
      },
      Math.min(10_000, this.options.archivePollMs ?? 10_000),
    );
    archivePoll.unref();
    this.timers.push(archivePoll);
    const full = setInterval(() => {
      for (const id of this.states.keys()) {
        this.markDirty(id);
        this.queueReconcile(id);
      }
    }, this.options.fullReconcileMs ?? DEFAULT_FULL_RECONCILE_MS);
    full.unref();
    this.timers.push(full);
    const catalog = setInterval(() => {
      void this.refreshCatalog()
        .then(async (current) => {
          if (this.closing) return;
          await this.syncRepositoryCatalogSubscriptions(current);
          await this.syncWatchers(current);
          for (const [id, state] of this.states)
            if (state.dirty || state.archiveDirty || state.fullReindexRequested) this.queueReconcile(id);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          for (const state of this.states.values()) state.lastFailure = `catalog refresh: ${message}`;
        });
    }, this.options.catalogRefreshMs ?? DEFAULT_CATALOG_REFRESH_MS);
    catalog.unref();
    this.timers.push(catalog);
  }

  hasWorkgroup(workgroupId: string): boolean {
    return this.states.has(workgroupId);
  }
  markDirty(workgroupId: string): void {
    const state = this.requireState(workgroupId);
    state.dirty = true;
    state.dirtyVersion += 1;
    state.fullScanRequired = true;
    state.fullScanVersion += 1;
  }
  markFilesystemChanges(workgroupId: string, changes: GraphifyFilesystemChange[], fullScan = false): void {
    const state = this.requireState(workgroupId);
    if (fullScan || changes.length === 0 || changes.length > MAX_INCREMENTAL_FILESYSTEM_CHANGES) {
      this.markDirty(workgroupId);
    } else {
      for (const change of changes) state.pendingFilesystemChanges.set(`${change.root}\0${change.path}`, change);
      state.dirty = true;
      state.dirtyVersion += 1;
    }
    this.queueReconcile(workgroupId);
  }
  async reindex(workgroupId: string, full: boolean): Promise<void> {
    const state = this.requireState(workgroupId);
    if (full) {
      state.fullReindexRequested = true;
      state.fullReindexVersion += 1;
      // Invalidate every running enrichment result at request time, before the
      // durable background request waits behind interactive work.
      state.epoch += 1;
    }
    state.dirty = true;
    state.dirtyVersion += 1;
    state.fullScanRequired = true;
    state.fullScanVersion += 1;
    this.queueReconcile(workgroupId);
  }
  pause(workgroupId: string): void {
    const state = this.requireState(workgroupId);
    this.paused.add(workgroupId);
    for (const controller of state.reconcileAborts) controller.abort('workgroup indexing paused');
  }
  resume(workgroupId: string): void {
    const state = this.requireState(workgroupId);
    this.paused.delete(workgroupId);
    if (state.dirty || state.archiveDirty || state.fullReindexRequested) this.queueReconcile(workgroupId);
    this.kickSemanticPump();
  }

  async pollArchiveOnce(queueChanges = true): Promise<string[]> {
    if (!existsSync(this.archivePath)) return [];
    const archive = new Database(this.archivePath, { readonly: true, fileMustExist: true });
    const changed: string[] = [];
    try {
      // One grouped pass for every workgroup, not one scan each. The previous
      // shape ran a per-workgroup aggregate that summed length(text) — which
      // forces SQLite to read every matching row's text, including overflow
      // pages — on a fresh handle (so, a cold cache) every 10 seconds. That
      // one poll was reading ~22 MB/s around the clock, held the disk at 90%
      // utilization, and the resulting IO stalls are what froze the host's
      // event loop. Appends move count/max_rowid and deletes move count, so
      // the byte sum bought no change-detection the counters didn't already
      // give — the archive is insert-only (src/message-archive.ts).
      const totals = new Map<string, { count: number; max_rowid: number | null; max_sent: string | null }>();
      for (const row of archive
        .prepare(
          `SELECT agent_group_id, count(*) AS count, max(rowid) AS max_rowid, max(sent_at) AS max_sent
             FROM messages_archive
            WHERE role IN ('user','assistant') AND channel_type <> 'agent'
            GROUP BY agent_group_id`,
        )
        .all() as { agent_group_id: string; count: number; max_rowid: number | null; max_sent: string | null }[]) {
        totals.set(row.agent_group_id, { count: row.count, max_rowid: row.max_rowid, max_sent: row.max_sent });
      }

      for (const [id, state] of this.states) {
        if (state.descriptor.memberIds.length === 0) continue;
        let count = 0;
        let maxRowid: number | null = null;
        let maxSent: string | null = null;
        for (const memberId of state.descriptor.memberIds) {
          const member = totals.get(memberId);
          if (!member) continue;
          count += member.count;
          if (member.max_rowid !== null && (maxRowid === null || member.max_rowid > maxRowid)) {
            maxRowid = member.max_rowid;
          }
          if (member.max_sent !== null && (maxSent === null || member.max_sent > maxSent)) {
            maxSent = member.max_sent;
          }
        }
        const fingerprint = JSON.stringify({ count, max_rowid: maxRowid, max_sent: maxSent });
        if (state.archiveFingerprint !== undefined && state.archiveFingerprint !== fingerprint) {
          changed.push(id);
          state.archiveDirty = true;
          state.archiveVersion += 1;
          if (queueChanges) this.queueReconcile(id);
        }
        state.archiveFingerprint = fingerprint;
      }
    } finally {
      archive.close();
    }
    return changed;
  }

  async ensureFresh(
    workgroupId: string,
    timeoutMs = 30_000,
    context?: TrustedOverlayContext,
  ): Promise<DaemonWorkgroupStatus> {
    await this.waitForFreshness(workgroupId, timeoutMs, context);
    return await this.statusAsync(workgroupId);
  }

  private async waitForFreshness(
    workgroupId: string,
    timeoutMs: number,
    context?: TrustedOverlayContext,
  ): Promise<void> {
    if (context) await this.validateOverlayContext(workgroupId, context);
    const state = this.requireState(workgroupId);
    const deadline = Date.now() + timeoutMs;
    while (
      !this.paused.has(workgroupId) &&
      (state.dirty || state.archiveDirty || state.reconciling) &&
      Date.now() < deadline
    ) {
      // A restart safety scan must not make an already-complete generation
      // unavailable. Watchers are active and the background lane will promote
      // a new atomic generation when the downtime reconciliation finishes.
      if (state.serveStaleDuringStartup && state.lastCompletedAt) {
        if (!state.reconciling) this.queueReconcile(workgroupId);
        break;
      }
      // A full rebuild is intentionally background-only. Interactive queries
      // continue to use the last complete generation while it is pending.
      if (state.fullReindexRequested && !state.reconciling) {
        this.queueReconcile(workgroupId);
        break;
      }
      if (!state.reconciling) {
        const controller = new AbortController();
        const operation = state.dirty
          ? this.canReconcileIncrementally(state)
            ? this.reconcileFilesystemChanges(state, controller.signal)
            : this.reconcile(state, controller.signal)
          : this.reconcileArchive(state, controller.signal);
        this.trackReconciliation(state, operation, controller);
      }
      const active = state.reconciling;
      if (!active) break;
      try {
        const outcome = await Promise.race([
          active.then(() => 'completed' as const),
          new Promise<'timeout'>((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), Math.max(1, deadline - Date.now()));
            timer.unref();
          }),
        ]);
        if (outcome === 'timeout') break;
      } catch (error) {
        if (!state.store) throw error;
        break;
      }
    }
  }

  private canReconcileIncrementally(state: WorkgroupState): boolean {
    return (
      !state.fullScanRequired &&
      Boolean(state.lastCompletedAt) &&
      state.pendingFilesystemChanges.size > 0 &&
      existsSync(this.graphPath(state.descriptor.id))
    );
  }

  /**
   * Interactive reads use the last complete generation immediately. Initial
   * reads still wait for the first usable baseline; callers that explicitly
   * require the newest mutation use ensureFresh().
   */
  private async prepareRead(workgroupId: string, context?: TrustedOverlayContext): Promise<WorkgroupState> {
    const state = this.requireState(workgroupId);
    if (state.lastCompletedAt && existsSync(this.graphPath(workgroupId))) {
      if (context) await this.validateOverlayContext(workgroupId, context);
      if (
        !this.paused.has(workgroupId) &&
        (state.dirty || state.archiveDirty || state.fullReindexRequested) &&
        !state.reconciling &&
        !state.backgroundQueued
      )
        this.queueReconcile(workgroupId);
      return state;
    }
    await this.waitForFreshness(workgroupId, 30_000, context);
    return this.requireState(workgroupId);
  }

  async query(
    workgroupId: string,
    term: string,
    limit = 20,
    context?: TrustedOverlayContext,
  ): Promise<GraphQueryResult> {
    const state = await this.prepareRead(workgroupId, context);
    return await this.withStableGeneration(state, async () => {
      const base = this.isolateReconcile
        ? await runIsolatedRead<GraphQueryResult>(this.graphPath(workgroupId), workgroupId, 'query', { term, limit })
        : this.requireStore(state).query(term, { limit });
      if (!context) return base;
      return await this.withOverlay(workgroupId, context, (store) => {
        const overlay = store.query(term, { limit });
        const nodes = [
          ...overlay.nodes,
          ...base.nodes.filter((node) => !overlay.nodes.some((item) => item.id === node.id)),
        ].slice(0, limit);
        return {
          term,
          nodes,
          edges: [...overlay.edges, ...base.edges],
          hyperedges: [...overlay.hyperedges, ...base.hyperedges],
          indexedGeneration: Math.max(overlay.indexedGeneration, base.indexedGeneration),
        };
      });
    });
  }

  async explain(
    workgroupId: string,
    reference: string,
    depth = 2,
    context?: TrustedOverlayContext,
  ): Promise<GraphExplainResult | null> {
    const state = await this.prepareRead(workgroupId, context);
    return await this.withStableGeneration(state, async () => {
      const baseStore = context || !this.isolateReconcile ? this.requireStore(state) : undefined;
      if (!context)
        return this.isolateReconcile
          ? await runIsolatedRead<GraphExplainResult | null>(this.graphPath(workgroupId), workgroupId, 'explain', {
              reference,
              depth,
            })
          : this.explainDepth(baseStore!, this.resolveReference(baseStore!, reference), depth);
      return await this.withOverlay(workgroupId, context, (store) => {
        try {
          return this.explainDepth(store, this.resolveReference(store, reference), depth);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('unknown graph reference')) {
            return this.explainDepth(baseStore!, this.resolveReference(baseStore!, reference), depth);
          }
          throw error;
        }
      });
    });
  }
  async path(
    workgroupId: string,
    from: string,
    to: string,
    maxDepth = 8,
    context?: TrustedOverlayContext,
  ): Promise<GraphPathResult | null> {
    const state = await this.prepareRead(workgroupId, context);
    return await this.withStableGeneration(state, async () => {
      const baseStore = context || !this.isolateReconcile ? this.requireStore(state) : undefined;
      const basePath = (): GraphPathResult | null =>
        baseStore!.path(this.resolveReference(baseStore!, from), this.resolveReference(baseStore!, to), { maxDepth });
      if (!context)
        return this.isolateReconcile
          ? await runIsolatedRead<GraphPathResult | null>(this.graphPath(workgroupId), workgroupId, 'path', {
              from,
              to,
              maxDepth,
            })
          : basePath();
      return await this.withOverlay(workgroupId, context, (store) => {
        try {
          return (
            store.path(this.resolveReference(store, from), this.resolveReference(store, to), { maxDepth }) ?? basePath()
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('unknown graph reference')) return basePath();
          throw error;
        }
      });
    });
  }
  async affected(
    workgroupId: string,
    reference: string,
    maxDepth = 8,
    context?: TrustedOverlayContext,
  ): Promise<GraphAffectedResult> {
    const state = await this.prepareRead(workgroupId, context);
    return await this.withStableGeneration(state, async () => {
      const baseStore = context || !this.isolateReconcile ? this.requireStore(state) : undefined;
      const base = (): GraphAffectedResult =>
        baseStore!.affected(this.resolveReference(baseStore!, reference), { maxDepth });
      if (!context)
        return this.isolateReconcile
          ? await runIsolatedRead<GraphAffectedResult>(this.graphPath(workgroupId), workgroupId, 'affected', {
              reference,
              maxDepth,
            })
          : base();
      return await this.withOverlay(workgroupId, context, (store) => {
        try {
          return store.affected(this.resolveReference(store, reference), { maxDepth });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('unknown graph reference')) return base();
          throw error;
        }
      });
    });
  }

  status(workgroupId: string): DaemonWorkgroupStatus {
    const state = this.requireState(workgroupId);
    return this.withFreshness(state, this.requireStore(state).status());
  }

  private withFreshness(state: WorkgroupState, status: WorkgroupGraphStatus): DaemonWorkgroupStatus {
    const queue = this.enrichmentRepository.counts(state.descriptor.id);
    return {
      ...status,
      freshness: {
        dirty: state.dirty || Boolean(state.archiveDirty) || state.fullReindexRequested,
        reconciling: Boolean(state.reconciling),
        lastStartedAt: state.lastStartedAt,
        lastCompletedAt: state.lastCompletedAt,
        lagMs: state.lastCompletedAt
          ? Math.max(0, Date.now() - Date.parse(state.lastCompletedAt))
          : Number.MAX_SAFE_INTEGER,
        pendingEnrichment: state.pendingEnrichment + queue.pending + queue.running,
        // Terminal failures leave the pending count entirely, so a queue that is
        // quietly failing every item looked identical to one that drained.
        failedEnrichment: queue.failed,
        enrichmentEligible: this.isEnrichmentEligible(state.descriptor.id, state),
        watcherDegraded: Boolean(state.watcherDegraded),
        lastFailure: state.lastFailure,
        paused: this.paused.has(state.descriptor.id),
      },
    };
  }

  async statusAsync(workgroupId: string): Promise<DaemonWorkgroupStatus> {
    if (!this.isolateReconcile) return this.status(workgroupId);
    const state = this.requireState(workgroupId);
    const status = await this.withStableGeneration(state, () =>
      runIsolatedRead<WorkgroupGraphStatus>(this.graphPath(workgroupId), workgroupId, 'status', {}),
    );
    return this.withFreshness(state, status);
  }

  async validateOverlayContext(workgroupId: string, context: TrustedOverlayContext): Promise<void> {
    const db = new Database(this.centralDbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT s.id FROM sessions s JOIN agent_groups a ON a.id = s.agent_group_id
        WHERE s.id = ? AND s.agent_group_id = ? AND a.workgroup_id = ?`,
        )
        .get(context.sessionId, context.agentGroupId, workgroupId);
      if (!row) throw new Error('trusted Graphify overlay context does not belong to requested workgroup');
    } finally {
      db.close();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const state of this.states.values())
      for (const controller of state.reconcileAborts) controller.abort('Graphify daemon stopping');
    for (const timer of this.timers) clearInterval(timer);
    if (this.semanticWakeTimer) clearTimeout(this.semanticWakeTimer);
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
    await Promise.all([...this.catalogSubscriptions.values()].map((release) => release()));
    this.catalogSubscriptions.clear();
    await this.isolatedWatchers?.close();
    await this.background.stop?.();
    for (const state of this.states.values()) state.store?.close();
    this.enrichmentRepository.close();
  }

  /** Build-only entrypoint used by the isolated production worker. */
  async buildCandidateOnce(workgroupId: string, signal?: AbortSignal): Promise<IsolatedReconcileResult> {
    return await this.reconcileInProcess(this.requireState(workgroupId), signal, false);
  }

  private async syncWatchers(descriptors: WorkgroupDescriptor[]): Promise<void> {
    if (this.closing) return;
    if (this.isolatedWatchers) {
      await this.isolatedWatchers.sync(descriptors, this.options.debounceMs ?? 3_000);
      return;
    }
    const desired = new Set<string>();
    for (const descriptor of descriptors) {
      const state = this.requireState(descriptor.id);
      for (const root of descriptor.roots) desired.add(`${descriptor.id}\0${root.absolutePath}`);
      // Avoid a host-wide recursive crawl at process start. The serialized
      // first reconciliation establishes the baseline, then activates this
      // workgroup's immediate freshness watchers.
      if (state.lastCompletedAt) this.ensureWatchers(descriptor);
    }
    for (const [key, watcher] of this.watchers) {
      if (desired.has(key)) continue;
      await watcher.close();
      this.watchers.delete(key);
    }
  }

  private async syncRepositoryCatalogSubscriptions(descriptors: WorkgroupDescriptor[]): Promise<void> {
    const adapter = this.options.repositorySnapshots;
    if (!adapter?.subscribe) return;
    const active = new Set(descriptors.map((descriptor) => descriptor.id));
    for (const descriptor of descriptors) {
      if (this.catalogSubscriptions.has(descriptor.id)) continue;
      const release = await adapter.subscribe(descriptor.id, () => {
        if (this.closing || !this.states.has(descriptor.id)) return;
        const state = this.requireState(descriptor.id);
        state.dirty = true;
        state.dirtyVersion += 1;
        state.fullScanRequired = true;
        state.fullScanVersion += 1;
        for (const controller of state.reconcileAborts) controller.abort('repository catalog changed');
        this.queueReconcile(descriptor.id);
      });
      this.catalogSubscriptions.set(descriptor.id, release);
    }
    for (const [workgroupId, release] of this.catalogSubscriptions) {
      if (active.has(workgroupId)) continue;
      await release();
      this.catalogSubscriptions.delete(workgroupId);
    }
  }

  private ensureWatchers(descriptor: WorkgroupDescriptor): void {
    if (this.closing || !this.watchFilesystem || this.isolatedWatchers) return;
    const state = this.requireState(descriptor.id);
    for (const root of descriptor.roots) {
      const key = `${descriptor.id}\0${root.absolutePath}`;
      if (this.watchers.has(key)) continue;
      const watcher = chokidar.watch(root.absolutePath, {
        ignoreInitial: true,
        followSymlinks: false,
        awaitWriteFinish: false,
        ignored: (candidate) => isGraphifyDefaultExcludedPath(root.absolutePath, candidate),
      });
      let debounce: NodeJS.Timeout | undefined;
      const changes = new Map<string, GraphifyFilesystemChange>();
      let fullScan = false;
      watcher.on('all', (event, candidate) => {
        const path = resolve(root.absolutePath, candidate);
        if (basename(path) === '.graphifyignore' || event === 'unlinkDir') {
          fullScan = true;
          changes.clear();
        } else if (event === 'add' || event === 'change' || event === 'unlink') {
          changes.set(path, { root: root.absolutePath, path, kind: event });
          if (changes.size > MAX_INCREMENTAL_FILESYSTEM_CHANGES) {
            fullScan = true;
            changes.clear();
          }
        } else {
          return;
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          if (!this.states.has(descriptor.id)) return;
          this.markFilesystemChanges(descriptor.id, [...changes.values()], fullScan);
          changes.clear();
          fullScan = false;
        }, this.options.debounceMs ?? 3_000);
        debounce.unref();
      });
      watcher.on('error', (error) => {
        state.lastFailure = `filesystem watcher: ${error instanceof Error ? error.message : String(error)}`;
      });
      this.watchers.set(key, watcher);
    }
  }

  private queueReconcile(workgroupId: string): void {
    const state = this.requireState(workgroupId);
    if (state.backgroundQueued || this.closing) return;
    state.backgroundQueued = true;
    void this.background
      .run(
        async (signal) => {
          if (this.paused.has(workgroupId)) throw new Error('workgroup indexing paused');
          const controller = new AbortController();
          const reconcileSignal = anySignal([signal, controller.signal]);
          const prior = state.reconciling;
          const operation = (async () => {
            if (prior) await prior;
            if (reconcileSignal.aborted || this.paused.has(workgroupId)) {
              throw new Error('workgroup indexing paused');
            }
            if (state.fullReindexRequested) await this.prepareFullReindex(state);
            if (state.dirty) {
              if (this.canReconcileIncrementally(state)) await this.reconcileFilesystemChanges(state, reconcileSignal);
              else await this.reconcile(state, reconcileSignal);
            } else if (state.archiveDirty) await this.reconcileArchive(state, reconcileSignal);
          })();
          await this.trackReconciliation(state, operation, controller);
        },
        // Admission still yields to chat. Once admitted, the deterministic
        // atomic baseline must finish or a busy workgroup can discard hours
        // of progress forever. OS/cgroup priority keeps it subordinate; only
        // manual pause, shutdown, and preemptible Docker/Codex jobs abort.
        { preemptActive: false, priority: 'freshness' },
      )
      .then((result) => {
        state.backgroundQueued = false;
        if ((result.status === 'preempted' || result.status === 'deferred') && !this.closing) {
          const timer = setTimeout(() => this.queueReconcile(workgroupId), this.options.preemptRetryMs ?? 5_000);
          timer.unref();
        } else if (result.status === 'failed' && !this.paused.has(workgroupId)) {
          state.lastFailure = result.error.message;
          state.reconcileFailures += 1;
          if (!this.closing) {
            const delay = Math.min(
              60_000,
              (this.options.reconcileRetryBaseMs ?? 5_000) * 2 ** Math.min(4, state.reconcileFailures - 1),
            );
            const timer = setTimeout(() => this.queueReconcile(workgroupId), delay);
            timer.unref();
          }
        } else if (result.status === 'completed') {
          state.reconcileFailures = 0;
          if ((state.dirty || state.archiveDirty || state.fullReindexRequested) && !this.closing)
            this.queueReconcile(workgroupId);
        }
      });
  }

  private trackReconciliation(
    state: WorkgroupState,
    operation: Promise<void>,
    controller: AbortController,
  ): Promise<void> {
    state.reconcileAborts.add(controller);
    const tracked = operation.finally(() => {
      state.reconcileAborts.delete(controller);
      if (state.reconciling === tracked) {
        state.reconciling = undefined;
        this.kickSemanticPump();
      }
    });
    state.reconciling = tracked;
    return tracked;
  }

  private async prepareFullReindex(state: WorkgroupState): Promise<void> {
    const workgroupId = state.descriptor.id;
    const requestVersion = state.fullReindexVersion;
    // The normal reconcile already builds an empty private candidate. Keep the
    // last complete live generation open until that candidate validates and is
    // atomically promoted; a maintenance request must never create read
    // downtime for an otherwise healthy workgroup.
    this.enrichmentRepository.clearWorkgroup(workgroupId);
    state.pendingEnrichment = 0;
    for (const key of [...this.attempted]) if (key.startsWith(`code:${workgroupId}:`)) this.attempted.delete(key);
    for (const key of [...this.retryAttempts.keys()])
      if (key.startsWith(`code:${workgroupId}:`)) this.retryAttempts.delete(key);
    state.archiveDirty = false;
    state.fullReindexRequested = state.fullReindexVersion !== requestVersion;
  }

  private async reconcile(state: WorkgroupState, signal?: AbortSignal): Promise<void> {
    if (this.options.repositorySnapshots) {
      for (;;) {
        if (signal?.aborted) throw new Error('Graphify reconcile aborted before catalog pin');
        const pinned = await this.options.repositorySnapshots.pinCommittedCatalog({
          workgroupId: state.descriptor.id,
          signal,
        });
        try {
          if (pinned.workgroupId !== state.descriptor.id)
            throw new Error(`Graphify catalog workgroup mismatch: ${pinned.workgroupId}`);
          const mutableRepositoryRoots = state.descriptor.roots.flatMap((root) =>
            pinned.repositories.map((repo) => {
              const candidate = join(root.absolutePath, repo.repo);
              if (!containedBy(candidate, root.absolutePath) || resolve(candidate) === resolve(root.absolutePath)) {
                throw new Error(`Graphify repository name escapes workgroup root: ${repo.repo}`);
              }
              return candidate;
            }),
          );
          const roots: ReconcileRoot[] = [
            ...state.descriptor.roots.map((root) => ({
              ...root,
              excludedRoots: [...pinned.excludedRoots, ...mutableRepositoryRoots],
            })),
            ...pinned.repositories.map((repo) => ({
              absolutePath: repo.snapshotPath,
              prefix: repo.sourcePrefix,
            })),
          ];
          const reconcileSignal = pinned.changeSignal
            ? anySignal([signal ?? new AbortController().signal, pinned.changeSignal])
            : signal;
          await this.reconcileInProcess(state, reconcileSignal, true, { roots, pinned });
          return;
        } catch (error) {
          const catalogChanged = error instanceof CatalogChangedError || !(await pinned.isCurrent());
          if (!catalogChanged || signal?.aborted || this.closing) throw error;
          // The candidate was private and has been discarded. Pin one fresh
          // committed catalog and restart; never supplement a mixed candidate.
        } finally {
          await pinned.release();
        }
      }
    }
    if (!this.isolateReconcile) {
      await this.reconcileInProcess(state, signal);
      return;
    }
    state.lastStartedAt = new Date().toISOString();
    const dirtyVersion = state.dirtyVersion;
    const archiveVersion = state.archiveVersion;
    const enrichmentVersion = state.enrichmentVersion;
    const fullScanVersion = state.fullScanVersion;
    const filesystemChanges = new Map(state.pendingFilesystemChanges);
    let candidatePath: string | undefined;
    let result: IsolatedReconcileResult;
    try {
      result = await runIsolatedReconcile({
        dataDir: this.options.dataDir,
        groupsDir: this.options.groupsDir,
        centralDbPath: this.centralDbPath,
        archivePath: this.archivePath,
        workgroupId: state.descriptor.id,
        enableEnrichment: this.enableEnrichment,
        enableSemanticEnrichment: this.enableSemanticEnrichment,
        signal,
      });
      candidatePath = result.candidatePath;
      if (!candidatePath) throw new Error('isolated Graphify reconcile did not return a candidate database');
      const candidateStatus = await runIsolatedRead<WorkgroupGraphStatus>(
        candidatePath,
        state.descriptor.id,
        'status',
        {},
      );
      if (candidateStatus.completeGeneration <= 0)
        throw new Error('isolated Graphify reconcile returned an incomplete candidate database');
      await this.promoteCandidate(state, candidatePath);
      this.pruneEnrichmentToCurrentGeneration(state);
      candidatePath = undefined;
    } catch (error) {
      if (candidatePath) {
        await rm(candidatePath, { force: true });
        await rm(`${candidatePath}-wal`, { force: true });
        await rm(`${candidatePath}-shm`, { force: true });
      }
      throw error;
    }
    for (const [key, change] of filesystemChanges)
      if (state.pendingFilesystemChanges.get(key) === change) state.pendingFilesystemChanges.delete(key);
    state.fullScanRequired = state.fullScanVersion !== fullScanVersion;
    state.dirty =
      state.dirtyVersion !== dirtyVersion ||
      state.enrichmentVersion !== enrichmentVersion ||
      state.fullScanRequired ||
      state.pendingFilesystemChanges.size > 0;
    state.archiveDirty = state.archiveVersion !== archiveVersion;
    state.lastCompletedAt = result.completedAt;
    state.serveStaleDuringStartup = false;
    state.lastFailure = undefined;
    this.ensureWatchers(state.descriptor);
    if (this.enableEnrichment && !this.paused.has(state.descriptor.id))
      this.scheduleEnrichment(state, result.codeSources, []);
  }

  private async reconcileInProcess(
    state: WorkgroupState,
    signal?: AbortSignal,
    promote = true,
    catalogPlan: ReconcileCatalogPlan = { roots: state.descriptor.roots },
  ): Promise<IsolatedReconcileResult> {
    state.lastStartedAt = new Date().toISOString();
    const dirtyVersion = state.dirtyVersion;
    const archiveVersion = state.archiveVersion;
    const enrichmentVersion = state.enrichmentVersion;
    const fullScanVersion = state.fullScanVersion;
    const filesystemChanges = new Map(state.pendingFilesystemChanges);
    const directory = join(this.options.dataDir, 'graphify', 'workgroups', state.descriptor.id);
    const livePath = join(directory, 'index.db');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory)) {
      if (entry.startsWith('index.next-')) await rm(join(directory, entry), { force: true });
    }
    const nextPath = join(directory, `index.next-${hash(randomToken(), state.lastStartedAt)}.db`);
    let next: ReconcileStore | undefined;
    try {
      next = this.reconcileStoreFactory(nextPath, state.descriptor.id);
      const generation = await next.beginGeneration('fast-reconcile');
      const codeSources: CodeSourceBuild[] = [];
      let indexBatch: SourceReconciliation[] = [];
      let stateBatch: SourceStateAppend[] = [];
      let batchContributions = 0;
      let batchTextBytes = 0;
      let semanticBatch: SemanticQueueItem[] = [];
      let rasterQueued = 0;
      const flushSources = async (): Promise<void> => {
        if (indexBatch.length === 0 && stateBatch.length === 0) return;
        if (indexBatch.length > 0) await next!.appendSources(indexBatch, generation);
        if (stateBatch.length > 0) await next!.appendSourceStates(stateBatch, generation);
        indexBatch = [];
        stateBatch = [];
        batchContributions = 0;
        batchTextBytes = 0;
        // better-sqlite3 mutations are synchronous. Bound each critical
        // section and return control so status/pause/preemption can run.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) throw new Error('fast reconcile preempted by interactive chat');
      };
      const flushSemantic = (): void => {
        if (semanticBatch.length === 0) return;
        this.enrichmentRepository.enqueue(semanticBatch);
        semanticBatch = [];
      };
      const queueSemantic = (item: SemanticQueueItem): void => {
        semanticBatch.push(item);
        if (semanticBatch.length >= 25) flushSemantic();
      };
      for (const root of catalogPlan.roots) {
        if (signal?.aborted) throw new Error('fast reconcile preempted by interactive chat');
        const discovered = await this.discover({ workgroupId: state.descriptor.id, root: root.absolutePath, signal });
        const found = root.excludedRoots?.length
          ? discovered.filter(
              (source) => !root.excludedRoots!.some((excluded) => containedBy(source.absolutePath, excluded)),
            )
          : discovered;
        for (const original of found) {
          if (signal?.aborted) throw new Error('fast reconcile preempted by interactive chat');
          const relativePath = prefixed(root.prefix, original.relativePath);
          const id = stableSourceId(state.descriptor.id, relativePath);
          const source = { ...original, id, relativePath, workgroupId: state.descriptor.id };
          const input = this.toInput(source);
          if (source.state !== 'pending' && source.state !== 'indexed') {
            stateBatch.push({ source: input, state: source.state, error: source.stateReason });
            if (indexBatch.length + stateBatch.length >= MAX_RECONCILE_BATCH_SOURCES) await flushSources();
            continue;
          }
          let preprocessed: PreprocessedSource;
          try {
            preprocessed = await preprocessDiscoveredSource(source);
          } catch (error) {
            if (isAbortFailure(error, signal)) throw error;
            stateBatch.push({ source: input, state: 'failed', error: sourceExtractionFailure(error) });
            if (indexBatch.length + stateBatch.length >= MAX_RECONCILE_BATCH_SOURCES) await flushSources();
            continue;
          }
          const cached = this.enrichmentRepository.get(source.id);
          const baseBundle = deterministicBundle(source, preprocessed);
          indexBatch.push({
            source: input,
            bundle: mergeBundles(
              baseBundle,
              cached?.contentHash === source.sha256 ? cached.code : undefined,
              cached?.contentHash === source.sha256 ? cached.semantic : undefined,
            ),
          });
          const indexed = indexBatch[indexBatch.length - 1].bundle;
          batchContributions += indexed.nodes.length + indexed.edges.length + indexed.hyperedges.length;
          batchTextBytes += indexed.nodes.reduce(
            (total, node) => total + Buffer.byteLength(node.name) + Buffer.byteLength(node.description ?? ''),
            0,
          );
          if (
            indexBatch.length + stateBatch.length >= MAX_RECONCILE_BATCH_SOURCES ||
            batchContributions >= MAX_RECONCILE_BATCH_CONTRIBUTIONS ||
            batchTextBytes >= MAX_RECONCILE_BATCH_TEXT_BYTES
          )
            await flushSources();
          codeSources.push({ source, root });

          if (
            this.enableEnrichment &&
            this.semantic &&
            !this.paused.has(state.descriptor.id) &&
            !(cached?.contentHash === source.sha256 && cached.semantic)
          ) {
            const semanticCode = source.kind === 'code' && /\.(?:sql|toml)$/i.test(source.relativePath);
            if ((source.kind !== 'code' || semanticCode) && preprocessed.semanticSegments.length > 0) {
              queueSemantic({
                source: input,
                segments: preprocessed.semanticSegments,
                baseBundle,
                priority: source.kind === 'document' ? 60 : semanticCode ? 50 : 40,
              });
            }
            if (this.codeWorker?.preprocess && /\.(?:pdf|docx|xlsx)$/i.test(source.relativePath)) {
              queueSemantic({
                source: input,
                segments: [],
                baseBundle,
                documentPath: source.absolutePath,
                sourceRoot: root.absolutePath,
                rootRelativePath: portable(relative(root.absolutePath, source.absolutePath)),
                priority: 55,
              });
            }
            if (rasterQueued < 100 && source.kind === 'image' && /\.(?:png|jpe?g|webp)$/i.test(source.relativePath)) {
              rasterQueued += 1;
              queueSemantic({
                source: input,
                segments: [`Raster image at ${source.relativePath}`],
                baseBundle,
                imagePath: source.absolutePath,
                sourceRoot: root.absolutePath,
                priority: 5,
              });
            }
          }
        }
      }
      const conversations = existsSync(this.archivePath)
        ? this.archiveReader.read(state.descriptor.id, state.descriptor.memberIds)
        : [];
      for (const conversation of conversations) {
        const cached = this.enrichmentRepository.get(conversation.input.id);
        indexBatch.push({
          source: conversation.input,
          bundle: mergeBundles(
            conversation.bundle,
            cached?.contentHash === conversation.input.contentHash ? cached.semantic : undefined,
          ),
        });
        const indexed = indexBatch[indexBatch.length - 1].bundle;
        batchContributions += indexed.nodes.length + indexed.edges.length + indexed.hyperedges.length;
        batchTextBytes += indexed.nodes.reduce(
          (total, node) => total + Buffer.byteLength(node.name) + Buffer.byteLength(node.description ?? ''),
          0,
        );
        if (
          indexBatch.length + stateBatch.length >= MAX_RECONCILE_BATCH_SOURCES ||
          batchContributions >= MAX_RECONCILE_BATCH_CONTRIBUTIONS ||
          batchTextBytes >= MAX_RECONCILE_BATCH_TEXT_BYTES
        )
          await flushSources();
      }
      await flushSources();
      flushSemantic();
      if (catalogPlan.pinned && !(await catalogPlan.pinned.isCurrent()))
        throw new CatalogChangedError(catalogPlan.pinned.catalogHash);
      await next.completeGeneration(generation);
      await next.close();
      next = undefined;
      // The candidate is private, so force every committed WAL page into the
      // main file and validate it before handing promotion back to the parent.
      // DELETE mode also ensures the atomic rename cannot inherit sidecars
      // belonging to the previous live generation.
      const candidate = new Database(nextPath);
      try {
        candidate.pragma('wal_checkpoint(TRUNCATE)');
        candidate.pragma('journal_mode = DELETE');
        const quickCheck = candidate.pragma('quick_check', { simple: true });
        if (quickCheck !== 'ok') throw new Error(`Graphify candidate integrity check failed: ${String(quickCheck)}`);
      } finally {
        candidate.close();
      }
      const completedAt = new Date().toISOString();
      if (!promote) return { codeSources, completedAt, candidatePath: nextPath };
      if (catalogPlan.pinned && !(await catalogPlan.pinned.isCurrent()))
        throw new CatalogChangedError(catalogPlan.pinned.catalogHash);
      state.store?.close();
      state.store = undefined;
      await rename(nextPath, livePath);
      state.store = new WorkgroupGraphStore(livePath, state.descriptor.id);
      this.pruneEnrichmentToCurrentGeneration(state);
      for (const [key, change] of filesystemChanges)
        if (state.pendingFilesystemChanges.get(key) === change) state.pendingFilesystemChanges.delete(key);
      state.fullScanRequired = state.fullScanVersion !== fullScanVersion;
      state.dirty =
        state.dirtyVersion !== dirtyVersion ||
        state.enrichmentVersion !== enrichmentVersion ||
        state.fullScanRequired ||
        state.pendingFilesystemChanges.size > 0;
      state.archiveDirty = state.archiveVersion !== archiveVersion;
      state.lastCompletedAt = completedAt;
      state.serveStaleDuringStartup = false;
      state.lastFailure = undefined;
      this.ensureWatchers(state.descriptor);
      if (this.scheduleEnrichmentAfterReconcile && this.enableEnrichment && !this.paused.has(state.descriptor.id))
        this.scheduleEnrichment(state, codeSources, conversations);
      return { codeSources, completedAt: state.lastCompletedAt };
    } catch (error) {
      await next?.abort();
      await rm(nextPath, { force: true });
      if (!state.store && existsSync(livePath)) state.store = new WorkgroupGraphStore(livePath, state.descriptor.id);
      state.dirty = true;
      state.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  /** Apply ordinary watcher changes transactionally without rebuilding the corpus. */
  private async reconcileFilesystemChanges(state: WorkgroupState, signal?: AbortSignal): Promise<void> {
    const livePath = this.graphPath(state.descriptor.id);
    if (!existsSync(livePath)) {
      state.fullScanRequired = true;
      state.fullScanVersion += 1;
      await this.reconcile(state, signal);
      return;
    }
    state.lastStartedAt = new Date().toISOString();
    const dirtyVersion = state.dirtyVersion;
    const changes = new Map(state.pendingFilesystemChanges);
    const upserts: SourceReconciliation[] = [];
    const deletes: string[] = [];
    const codeSources: CodeSourceBuild[] = [];
    const semanticItems: SemanticQueueItem[] = [];
    let rasterQueued = 0;

    for (const change of changes.values()) {
      if (signal?.aborted) throw new Error('filesystem reconcile preempted by interactive chat');
      const root = state.descriptor.roots.find((candidate) => candidate.absolutePath === change.root);
      if (!root) {
        state.fullScanRequired = true;
        state.fullScanVersion += 1;
        await this.reconcile(state, signal);
        return;
      }
      const rootRelativePath = portable(relative(root.absolutePath, resolve(change.path)));
      const relativePath = prefixed(root.prefix, rootRelativePath);
      const id = stableSourceId(state.descriptor.id, relativePath);
      const original = await discoverSourcePath({
        workgroupId: state.descriptor.id,
        root: root.absolutePath,
        path: change.path,
        signal,
      });
      if (!original) {
        deletes.push(id);
        continue;
      }
      if (original.state !== 'pending' && original.state !== 'indexed') {
        // Metadata-only and failure state transitions use the full generation
        // path so their status rows retain exactly the same semantics.
        state.fullScanRequired = true;
        state.fullScanVersion += 1;
        await this.reconcile(state, signal);
        return;
      }
      const source = { ...original, id, relativePath, workgroupId: state.descriptor.id };
      const input = this.toInput(source);
      let prepared: PreprocessedSource;
      try {
        prepared = await preprocessDiscoveredSource(source);
      } catch (error) {
        if (isAbortFailure(error, signal)) throw error;
        // The full path records extraction failures as source state instead of
        // retrying one bad watcher event forever.
        state.fullScanRequired = true;
        state.fullScanVersion += 1;
        await this.reconcile(state, signal);
        return;
      }
      const cached = this.enrichmentRepository.get(source.id);
      const baseBundle = deterministicBundle(source, prepared);
      upserts.push({
        source: input,
        bundle: mergeBundles(
          baseBundle,
          cached?.contentHash === source.sha256 ? cached.code : undefined,
          cached?.contentHash === source.sha256 ? cached.semantic : undefined,
        ),
      });
      codeSources.push({ source, root });

      if (
        this.enableEnrichment &&
        this.semantic &&
        !this.paused.has(state.descriptor.id) &&
        !(cached?.contentHash === source.sha256 && cached.semantic)
      ) {
        const semanticCode = source.kind === 'code' && /\.(?:sql|toml)$/i.test(source.relativePath);
        if ((source.kind !== 'code' || semanticCode) && prepared.semanticSegments.length > 0) {
          semanticItems.push({
            source: input,
            segments: prepared.semanticSegments,
            baseBundle,
            priority: source.kind === 'document' ? 60 : semanticCode ? 50 : 40,
          });
        }
        if (this.codeWorker?.preprocess && /\.(?:pdf|docx|xlsx)$/i.test(source.relativePath)) {
          semanticItems.push({
            source: input,
            segments: [],
            baseBundle,
            documentPath: source.absolutePath,
            sourceRoot: root.absolutePath,
            rootRelativePath,
            priority: 55,
          });
        }
        if (rasterQueued < 100 && source.kind === 'image' && /\.(?:png|jpe?g|webp)$/i.test(source.relativePath)) {
          rasterQueued += 1;
          semanticItems.push({
            source: input,
            segments: [`Raster image at ${source.relativePath}`],
            baseBundle,
            imagePath: source.absolutePath,
            sourceRoot: root.absolutePath,
            priority: 5,
          });
        }
      }
    }

    if (this.isolateReconcile)
      await runIsolatedSourceReconcile({
        path: livePath,
        workgroupId: state.descriptor.id,
        reason: 'filesystem-reconcile',
        upserts,
        deletes,
        signal,
      });
    else this.requireStore(state).reconcileSources('filesystem-reconcile', upserts, deletes);

    this.enrichmentRepository.removeSources(deletes);

    for (const [key, change] of changes)
      if (state.pendingFilesystemChanges.get(key) === change) state.pendingFilesystemChanges.delete(key);
    state.dirty =
      state.dirtyVersion !== dirtyVersion || state.fullScanRequired || state.pendingFilesystemChanges.size > 0;
    state.lastCompletedAt = new Date().toISOString();
    state.serveStaleDuringStartup = false;
    state.lastFailure = undefined;
    if (semanticItems.length > 0) this.enrichmentRepository.enqueue(semanticItems);
    if (this.enableEnrichment && !this.paused.has(state.descriptor.id)) {
      this.scheduleEnrichment(state, codeSources, []);
      if (semanticItems.length > 0) this.kickSemanticPump();
    }
  }

  /** Atomically update only changed archive-backed sources without scanning or copying roots. */
  private async reconcileArchive(state: WorkgroupState, signal?: AbortSignal): Promise<void> {
    const directory = join(this.options.dataDir, 'graphify', 'workgroups', state.descriptor.id);
    const livePath = join(directory, 'index.db');
    if (!existsSync(livePath)) {
      state.dirty = true;
      await this.reconcile(state, signal);
      return;
    }
    state.lastStartedAt = new Date().toISOString();
    const archiveVersion = state.archiveVersion;
    try {
      if (signal?.aborted) throw new Error('archive reconcile preempted by interactive chat');
      const store = this.requireStore(state);
      const conversations = this.archiveReader.read(state.descriptor.id, state.descriptor.memberIds);
      const incoming = new Set(conversations.map((item) => item.input.id));
      const sourceStates = ['pending', 'indexed', 'metadata_only', 'quarantined', 'failed', 'deleted'] as const;
      const deletes = sourceStates
        .flatMap((kind) => store.listSourcesByState(kind))
        .filter((source) => source.relativePath.startsWith('conversations/') && !incoming.has(source.id))
        .map((source) => source.id);
      const upserts = conversations.map((conversation) => {
        const cached = this.enrichmentRepository.get(conversation.input.id);
        return {
          source: conversation.input,
          bundle: mergeBundles(
            conversation.bundle,
            cached?.contentHash === conversation.input.contentHash ? cached.semantic : undefined,
          ),
        };
      });
      const reconciled = this.isolateReconcile
        ? await runIsolatedSourceReconcile({
            path: livePath,
            workgroupId: state.descriptor.id,
            reason: 'archive-reconcile',
            upserts,
            deletes,
            signal,
          })
        : store.reconcileSources('archive-reconcile', upserts, deletes);
      // Remove even already-deleted legacy rows: reconcileSources only reports
      // newly deleted IDs, while the shared enrichment DB may still contain
      // queue/cache residue from an older daemon.
      this.enrichmentRepository.removeSources(deletes);
      state.archiveDirty = state.archiveVersion !== archiveVersion;
      state.lastCompletedAt = new Date().toISOString();
      state.lastFailure = undefined;
      if (this.enableEnrichment && !this.paused.has(state.descriptor.id)) {
        const changed = new Set(reconciled.upsertedSourceIds);
        this.scheduleEnrichment(
          state,
          [],
          conversations.filter((item) => changed.has(item.input.id)),
        );
      }
    } catch (error) {
      state.archiveDirty = true;
      state.lastFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  private scheduleEnrichment(
    state: WorkgroupState,
    builds: CodeSourceBuild[],
    conversations: ConversationGraphSource[],
  ): void {
    if (this.closing) return;
    if (this.codeWorker) {
      const buildRoots = new Map(builds.map((item) => [`${item.root.prefix}\0${item.root.absolutePath}`, item.root]));
      for (const root of buildRoots.values()) {
        const candidates = builds.filter(
          (item) =>
            item.root.absolutePath === root.absolutePath &&
            item.source.kind === 'code' &&
            !/\.toml$/i.test(item.source.relativePath) &&
            !this.hasCurrentEnrichment(item.source.id, item.source.sha256, 'code'),
        );
        let batch: DiscoveredSource[] = [];
        let bytes = 0;
        const flush = (): void => {
          if (batch.length) this.enqueueCode(state, root, batch);
          batch = [];
          bytes = 0;
        };
        for (const item of candidates) {
          if (batch.length >= 4_000 || bytes + item.source.bytes > 64 * 1024 * 1024) flush();
          batch.push(item.source);
          bytes += item.source.bytes;
        }
        flush();
      }
    }
    if (this.semantic) {
      let queued: SemanticQueueItem[] = [];
      const flush = (): void => {
        if (queued.length === 0) return;
        this.enrichmentRepository.enqueue(queued);
        queued = [];
      };
      for (const item of conversations) {
        if (this.hasCurrentEnrichment(item.input.id, item.input.contentHash, 'semantic')) continue;
        queued.push({
          source: item.input,
          segments: item.bundle.nodes.map((node) => node.description ?? '').filter(Boolean),
          baseBundle: item.bundle,
          priority: 100,
        });
        if (queued.length >= 25) flush();
      }
      flush();
      this.kickSemanticPump();
    }
  }

  private enqueueCode(state: WorkgroupState, root: WorkgroupRoot, batch: DiscoveredSource[]): void {
    const key = `code:${state.descriptor.id}:${hash(...batch.map((source) => `${source.id}:${source.sha256}`))}`;
    if (this.attempted.has(key)) return;
    this.attempted.add(key);
    state.pendingEnrichment += 1;
    const epoch = state.epoch;
    const sources: CodeWorkerSource[] = batch.map((source) => ({
      ...source,
      rootRelativePath: portable(relative(root.absolutePath, source.absolutePath)),
    }));
    void this.background
      .run(async (signal) => {
        const output = await this.codeWorker!.extract(
          state.descriptor.id,
          root.absolutePath,
          root.prefix,
          sources,
          signal,
        );
        if (state.epoch !== epoch) return;
        const entries: PersistedEnrichment[] = [];
        const upserts: Array<{ source: SourceInput; bundle: ExtractionBundle; force: boolean }> = [];
        for (const source of batch) {
          const bundle = output.get(source.id);
          if (!bundle) continue;
          const input = this.toInput(source);
          const current = this.requireStore(state).getSourceById(input.id);
          if (current?.state !== 'indexed' || current.contentHash !== input.contentHash) continue;
          let preprocessed: PreprocessedSource;
          try {
            preprocessed = await preprocessDiscoveredSource(source);
          } catch (error) {
            if (isAbortFailure(error, signal)) throw error;
            this.markDirty(state.descriptor.id);
            this.queueReconcile(state.descriptor.id);
            continue;
          }
          const prior = this.enrichmentRepository.get(source.id);
          const entry: PersistedEnrichment = {
            ...(prior?.contentHash === source.sha256 ? prior : {}),
            sourceId: source.id,
            workgroupId: state.descriptor.id,
            contentHash: source.sha256,
            code: bridgeCodeBundle(input, bundle),
          };
          entries.push(entry);
          upserts.push({
            source: input,
            force: true,
            bundle: mergeBundles(deterministicBundle(source, preprocessed), entry.code, entry.semantic),
          });
        }
        if (upserts.length > 0) {
          state.enrichmentVersion += 1;
          if (this.isolateReconcile)
            await runIsolatedSourceReconcile({
              path: join(this.options.dataDir, 'graphify', 'workgroups', state.descriptor.id, 'index.db'),
              workgroupId: state.descriptor.id,
              reason: 'code-enrichment',
              upserts,
              deletes: [],
              signal,
            });
          else this.requireStore(state).reconcileSources('code-enrichment', upserts, []);
          for (const entry of entries) {
            this.enrichmentRepository.put(entry);
          }
        }
      })
      .then((result) => {
        state.pendingEnrichment = Math.max(0, state.pendingEnrichment - 1);
        if (state.epoch !== epoch) {
          this.attempted.delete(key);
          return;
        }
        if (result.status === 'completed') {
          this.retryAttempts.delete(key);
        } else if (result.status === 'preempted' || result.status === 'deferred') {
          this.attempted.delete(key);
          const timer = setTimeout(() => this.enqueueCode(state, root, batch), 5_000);
          timer.unref();
        } else {
          this.attempted.delete(key);
          if (batch.length > 1) {
            this.retryAttempts.delete(key);
            const midpoint = Math.ceil(batch.length / 2);
            this.enqueueCode(state, root, batch.slice(0, midpoint));
            this.enqueueCode(state, root, batch.slice(midpoint));
            return;
          }
          state.lastFailure = `code enrichment: ${result.error.message}`;
          const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
          this.retryAttempts.set(key, attempt);
          if (attempt < 5) {
            const timer = setTimeout(
              () => this.enqueueCode(state, root, batch),
              Math.min(60_000, 5_000 * 2 ** (attempt - 1)),
            );
            timer.unref();
          }
        }
      });
  }

  private rearmSemanticPump(delayMs: number): void {
    if (this.semanticWakeTimer) return;
    this.semanticWakeTimer = setTimeout(() => {
      this.semanticWakeTimer = undefined;
      this.kickSemanticPump();
    }, delayMs);
    this.semanticWakeTimer.unref();
  }

  /**
   * Deterministic freshness has priority over enrichment, but only for the
   * workgroups that actually have freshness work pending. This used to be a
   * fleet-wide veto: any single dirty/queued workgroup blocked every sibling's
   * queue, and on a multi-workgroup install with live chat traffic the fleet
   * was never simultaneously clean, so nothing ever drained. `backgroundQueued`
   * still covers the original concern — a large workgroup waiting behind
   * another owner of the serialized lane is ineligible on its own account.
   */
  private isEnrichmentEligible(workgroupId: string, state: WorkgroupState): boolean {
    return (
      !this.paused.has(workgroupId) &&
      !state.dirty &&
      !state.archiveDirty &&
      !state.reconciling &&
      !state.backgroundQueued &&
      !state.fullReindexRequested
    );
  }

  private kickSemanticPump(): void {
    if (this.semanticPumpRunning || this.closing || !this.semantic) return;
    const wait = (this.options.semanticMinIntervalMs ?? 30_000) - (Date.now() - this.lastSemanticStartedAt);
    if (wait > 0) {
      this.rearmSemanticPump(wait);
      return;
    }
    const active = [...this.states.entries()]
      .filter(([id, state]) => this.isEnrichmentEligible(id, state))
      .map(([id]) => id);
    const batch = active.length === 0 ? [] : this.enrichmentRepository.claimBatch(25, 256 * 1024, active);
    if (batch.length === 0) {
      // Nothing claimable right now (every workgroup busy, or the queue is
      // empty). Keep waking so a workgroup going quiet resumes the drain.
      this.rearmSemanticPump(this.options.semanticPumpDelayMs ?? 5_000);
      return;
    }
    // Pin the exact row versions we claimed. The source can change under us
    // mid-batch, which re-enqueues the row as fresh work; settling by id alone
    // would then clobber that newer version.
    const claims: SemanticQueueClaim[] = batch.map((item) => ({
      sourceId: item.source.id,
      contentHash: item.source.contentHash,
    }));
    const epochs = new Map(
      batch.map((item) => [item.source.workgroupId, this.states.get(item.source.workgroupId)?.epoch ?? 0]),
    );
    this.semanticPumpRunning = true;
    this.lastSemanticStartedAt = Date.now();
    void this.background
      .run(async (signal) => {
        const prepared = batch.map((item) => ({ ...item }));
        const binary = new Map<string, ExtractionBundle>();
        for (const item of prepared.filter((candidate) => candidate.documentPath)) {
          if (!this.codeWorker?.preprocess || !item.sourceRoot || !item.rootRelativePath || !item.documentPath) {
            throw new Error('binary preprocess adapter is unavailable');
          }
          const result = await this.codeWorker.preprocess(
            item.sourceRoot,
            {
              id: item.source.id,
              workgroupId: item.source.workgroupId,
              relativePath: item.source.relativePath,
              absolutePath: item.documentPath,
              rootRelativePath: item.rootRelativePath,
              kind: item.source.kind,
              bytes: item.source.sizeBytes ?? 0,
              mtimeMs: item.source.modifiedAt ? Date.parse(item.source.modifiedAt) : 0,
              sha256: item.source.contentHash,
              state: 'pending',
            },
            signal,
          );
          if (result.status === 'failed') throw new Error(`binary preprocess failed: ${result.error ?? 'unknown'}`);
          binary.set(item.source.id, binarySectionBundle(item.source, result));
          item.segments = result.sections.map((section) => `[${section.locator}]\n${section.text}`);
        }
        const semanticInputs = prepared.filter((item) => item.segments.length > 0);
        let semantic: Map<string, ExtractionBundle>;
        if (semanticInputs.length === 0) semantic = new Map();
        else if (this.semantic!.extractBatch)
          semantic = await this.semantic!.extractBatch(
            semanticInputs.map((item) => ({
              ...item,
              ...(item.imagePath ? { imageRoot: item.sourceRoot } : {}),
            })),
            signal,
          );
        else {
          semantic = new Map<string, ExtractionBundle>();
          for (const item of semanticInputs)
            semantic.set(item.source.id, await this.semantic!.extract(item.source, item.segments, signal));
        }
        const workgroups = new Map<
          string,
          Array<{ source: SourceInput; bundle: ExtractionBundle; force: boolean; entry: PersistedEnrichment }>
        >();
        for (const item of prepared) {
          const state = this.states.get(item.source.workgroupId);
          if (!state || state.epoch !== epochs.get(item.source.workgroupId)) continue;
          if (!item.baseBundle)
            throw new Error(`semantic queue item ${item.source.id} has no deterministic base bundle`);
          const current = this.requireStore(state).getSourceById(item.source.id);
          if (current?.state !== 'indexed' || current.contentHash !== item.source.contentHash) continue;
          const semanticBundle = semantic.get(item.source.id);
          const binaryBundle = binary.get(item.source.id);
          if (!semanticBundle && !binaryBundle) continue;
          const prior = this.enrichmentRepository.get(item.source.id);
          const entry: PersistedEnrichment = {
            ...(prior?.contentHash === item.source.contentHash ? prior : {}),
            sourceId: item.source.id,
            workgroupId: item.source.workgroupId,
            contentHash: item.source.contentHash,
            ...(binaryBundle ? { code: binaryBundle } : {}),
            ...(semanticBundle ? { semantic: namespaceSemantic(item.source, semanticBundle) } : {}),
          };
          const group = workgroups.get(item.source.workgroupId) ?? [];
          group.push({
            source: item.source,
            force: true,
            entry,
            bundle: mergeBundles(item.baseBundle, entry.code, entry.semantic),
          });
          workgroups.set(item.source.workgroupId, group);
        }
        for (const [workgroupId, items] of workgroups) {
          const state = this.requireState(workgroupId);
          state.enrichmentVersion += 1;
          if (this.isolateReconcile)
            await runIsolatedSourceReconcile({
              path: join(this.options.dataDir, 'graphify', 'workgroups', workgroupId, 'index.db'),
              workgroupId,
              reason: 'semantic-enrichment',
              upserts: items,
              deletes: [],
              signal,
            });
          else this.requireStore(state).reconcileSources('semantic-enrichment', items, []);
          for (const item of items) {
            this.enrichmentRepository.put(item.entry);
          }
        }
        this.enrichmentRepository.complete(claims);
        return { appliedWorkgroups: [...workgroups.keys()] };
      })
      .then((result) => {
        this.semanticPumpRunning = false;
        if (result.status === 'failed') {
          const message = result.error.message;
          this.enrichmentRepository.retry(claims, message);
          for (const item of batch) {
            const state = this.states.get(item.source.workgroupId);
            if (state) state.lastFailure = `semantic enrichment: ${message}`;
          }
        } else if (result.status === 'preempted' || result.status === 'deferred') {
          // Interactive turns and freshness work are expected to win this
          // lane. Requeue without consuming the real failure retry budget.
          this.enrichmentRepository.defer(claims, this.options.semanticPumpDelayMs ?? 5_000);
        }
        if (!this.closing) {
          const timer = setTimeout(() => this.kickSemanticPump(), this.options.semanticPumpDelayMs ?? 5_000);
          timer.unref();
        }
      });
  }

  private toInput(source: DiscoveredSource): SourceInput {
    return {
      id: source.id,
      workgroupId: source.workgroupId,
      kind: source.kind,
      relativePath: source.relativePath,
      contentHash: source.sha256,
      sizeBytes: source.bytes,
      modifiedAt: new Date(source.mtimeMs).toISOString(),
    };
  }

  private hasCurrentEnrichment(sourceId: string, contentHash: string, kind: 'code' | 'semantic'): boolean {
    return this.enrichmentRepository.hasCurrent(sourceId, contentHash, kind);
  }

  private pruneEnrichmentToCurrentGeneration(state: WorkgroupState): void {
    const store = this.requireStore(state);
    const retainedSourceIds = [...store.listSourcesByState('indexed'), ...store.listSourcesByState('pending')].map(
      (source) => source.id,
    );
    this.enrichmentRepository.pruneWorkgroup(state.descriptor.id, retainedSourceIds);
  }

  private requireState(workgroupId: string): WorkgroupState {
    const state = this.states.get(workgroupId);
    if (!state) throw new Error(`unknown workgroup: ${workgroupId}`);
    return state;
  }

  private async withStableGeneration<T>(state: WorkgroupState, operation: () => Promise<T> | T): Promise<T> {
    while (state.promotionGate) await state.promotionGate;
    state.activeReads += 1;
    try {
      return await operation();
    } finally {
      state.activeReads -= 1;
    }
  }

  private async promoteCandidate(state: WorkgroupState, candidatePath: string): Promise<void> {
    const directory = join(this.options.dataDir, 'graphify', 'workgroups', state.descriptor.id);
    const expectedPrefix = `${directory}${sep}index.next-`;
    if (!candidatePath.startsWith(expectedPrefix) || !candidatePath.endsWith('.db'))
      throw new Error(`isolated Graphify reconcile returned an invalid candidate path: ${candidatePath}`);
    if (state.promotionGate) throw new Error(`Graphify promotion already active for ${state.descriptor.id}`);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.promotionGate = gate;
    try {
      while (state.activeReads > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      state.store?.close();
      state.store = undefined;
      const livePath = this.graphPath(state.descriptor.id);
      await rm(`${livePath}-wal`, { force: true });
      await rm(`${livePath}-shm`, { force: true });
      await rename(candidatePath, livePath);
      state.store = new WorkgroupGraphStore(livePath, state.descriptor.id);
    } finally {
      if (state.promotionGate === gate) state.promotionGate = undefined;
      release();
    }
  }

  private requireStore(state: WorkgroupState): WorkgroupGraphStore {
    if (!state.store) {
      const path = this.graphPath(state.descriptor.id);
      state.store = new WorkgroupGraphStore(path, state.descriptor.id);
    }
    return state.store;
  }

  private graphPath(workgroupId: string): string {
    return join(this.options.dataDir, 'graphify', 'workgroups', workgroupId, 'index.db');
  }

  private readExistingLastCompletedAt(workgroupId: string): string | undefined {
    const path = join(this.options.dataDir, 'graphify', 'workgroups', workgroupId, 'index.db');
    if (!existsSync(path)) return undefined;
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT completed_at FROM generations
            WHERE completed_at IS NOT NULL ORDER BY generation DESC LIMIT 1`,
        )
        .get() as { completed_at: string } | undefined;
      return row?.completed_at;
    } catch (error) {
      if (error instanceof Error && error.message.includes('no such table')) return undefined;
      throw error;
    } finally {
      db.close();
    }
  }

  private resolveReference(store: WorkgroupGraphStore, reference: string): string {
    if (store.explain(reference)) return reference;
    const exact = store
      .query(reference, { limit: 100 })
      .nodes.filter((node) => node.name.toLocaleLowerCase() === reference.toLocaleLowerCase());
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) throw new Error(`ambiguous graph reference: ${reference}`);
    throw new Error(`unknown graph reference: ${reference}`);
  }

  private explainDepth(store: WorkgroupGraphStore, nodeId: string, depth: number): GraphExplainResult | null {
    const root = store.explain(nodeId);
    if (!root || depth <= 1) return root;
    const incoming = new Map(root.incoming.map((edge) => [`${edge.id}:${edge.from}:${edge.to}`, edge]));
    const outgoing = new Map(root.outgoing.map((edge) => [`${edge.id}:${edge.from}:${edge.to}`, edge]));
    const hyperedges = new Map(root.hyperedges.map((edge) => [edge.id, edge]));
    let frontier = [nodeId];
    const seen = new Set(frontier);
    for (let level = 1; level < depth; level += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        const detail = store.explain(id);
        if (!detail) continue;
        for (const edge of detail.incoming) {
          incoming.set(`${edge.id}:${edge.from}:${edge.to}`, edge);
          if (!seen.has(edge.from)) next.push(edge.from);
        }
        for (const edge of detail.outgoing) {
          outgoing.set(`${edge.id}:${edge.from}:${edge.to}`, edge);
          if (!seen.has(edge.to)) next.push(edge.to);
        }
        for (const edge of detail.hyperedges) hyperedges.set(edge.id, edge);
      }
      frontier = next.filter((id) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (!frontier.length) break;
    }
    return {
      ...root,
      incoming: [...incoming.values()],
      outgoing: [...outgoing.values()],
      hyperedges: [...hyperedges.values()],
    };
  }

  private async withOverlay<T>(
    workgroupId: string,
    context: TrustedOverlayContext,
    operation: (store: WorkgroupGraphStore) => T,
  ): Promise<T> {
    await this.validateOverlayContext(workgroupId, context);
    const db = new Database(this.centralDbPath, { readonly: true, fileMustExist: true });
    let row: { platform_id: string | null; messaging_group_id: string | null; thread_id: string | null };
    try {
      row = db
        .prepare(
          `SELECT mg.platform_id, s.messaging_group_id, s.thread_id FROM sessions s
        LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id WHERE s.id = ?`,
        )
        .get(context.sessionId) as typeof row;
    } finally {
      db.close();
    }
    const defaultResolve: GraphifyOverlayResolver = (request) => {
      const unit = resolveRepositoryWorkUnit({
        workgroupId: request.workgroupId,
        sessionId: request.sessionId,
        platformId: request.platformId,
        messagingGroupId: request.messagingGroupId,
        threadId: request.threadId,
      });
      return {
        sourceRoot: topicWorktreesDir(unit, this.options.dataDir),
        workUnitRoot: topicStateDir(unit, this.options.dataDir),
      };
    };
    const location = await (this.options.resolveOverlay ?? defaultResolve)({
      workgroupId,
      agentGroupId: context.agentGroupId,
      sessionId: context.sessionId,
      platformId: row?.platform_id ?? null,
      messagingGroupId: row?.messaging_group_id ?? null,
      threadId: row?.thread_id ?? null,
      threadWorktrees: this.threadWorktrees,
    });
    const root = location.sourceRoot;
    const acquireRead = this.options.acquireOverlayReadClaim ?? acquireStorageActivityLease;
    const lease = existsSync(root)
      ? await acquireRead(location.workUnitRoot, `graphify:${workgroupId}:${context.sessionId}`)
      : undefined;
    const overlayDir = join(this.options.dataDir, 'graphify', 'overlays');
    let overlayPath: string | undefined;
    let store: WorkgroupGraphStore | undefined;
    try {
      await mkdir(overlayDir, { recursive: true, mode: 0o700 });
      overlayPath = join(overlayDir, `${hash(workgroupId, context.agentGroupId, context.sessionId, randomToken())}.db`);
      store = new WorkgroupGraphStore(overlayPath, workgroupId);
      const generation = store.beginGeneration('thread-overlay');
      if (existsSync(root)) {
        const found = await this.discover({ workgroupId, root });
        const mapped = found.map((original) => {
          const relativePath = `overlay/${hash(workgroupId, location.workUnitRoot)}/${original.relativePath}`;
          return { ...original, id: stableSourceId(workgroupId, relativePath), relativePath };
        });
        for (const source of mapped) {
          if (source.state !== 'pending' && source.state !== 'indexed')
            store.markSourceState(this.toInput(source), source.state, generation, source.stateReason);
          else {
            try {
              store.upsertSource(
                this.toInput(source),
                deterministicBundle(source, await preprocessDiscoveredSource(source)),
                generation,
              );
            } catch (error) {
              if (isAbortFailure(error)) throw error;
              store.markSourceState(this.toInput(source), 'failed', generation, sourceExtractionFailure(error));
            }
          }
        }
      }
      store.completeGeneration(generation);
      return operation(store);
    } finally {
      store?.close();
      if (overlayPath) await rm(overlayPath, { force: true });
      await lease?.release();
    }
  }
}

function randomToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
