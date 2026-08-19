/**
 * Host storage manager.
 *
 * Reclaims only regenerable storage:
 *   - package/build caches inside idle session and thread worktrees
 *   - per-session archive/central database projections rebuilt on container spawn
 *   - per-session Codex plugin caches rebuilt on container spawn
 *   - stopped containers carrying this NanoClaw install's ownership label
 *   - unused NanoClaw images and bounded Docker builder cache
 *
 * It deliberately does not remove canonical DBs, session inbound/outbound DBs,
 * source checkouts, .git directories, or anything attached to a live/in-flight
 * session.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CONTAINER_IMAGE, CONTAINER_IMAGE_BASE, CONTAINER_INSTALL_LABEL, DATA_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getDb } from './db/connection.js';
import { getAllContainerConfigs } from './db/container-configs.js';
import { log } from './log.js';
import { tryRunWithStorageCleanupClaim } from './storage-activity.js';
import {
  inboundDbPath,
  outboundDbPath,
  sessionsBaseDir,
  threadsBaseDir,
  threadWorktreeDir,
} from './session-manager.js';

const DOCKER_PRUNE_IMAGE_LABEL = 'nanoclaw.commit';
const DEFAULT_CLEANUP_THRESHOLD_PCT = 85;
const DEFAULT_ADMISSION_REFUSE_PCT = 90;
const DEFAULT_SCAN_INTERVAL_HOURS = 1;
const DEFAULT_DOCKER_PRUNE_INTERVAL_HOURS = 6;
const DEFAULT_DOCKER_BUILD_CACHE_UNUSED_FOR = '168h';
const DEFAULT_IDLE_HOURS = 24;
const DEFAULT_CLEANUP_TARGET_MARGIN_PCT = 3;
const DEFAULT_EMERGENCY_RETRY_SECONDS = 60;
const DEFAULT_IMAGE_RETENTION_HOURS = 168;
const DEFAULT_LEGACY_IMAGE_GRACE_HOURS = 168;
// Archive-then-reclaim: a thread worktree dir idle this long is tarred
// (minus regenerable dirs) into data/thread-rescues/ and then removed.
// Owner-approved policy 2026-08-05; 47GB of never-reclaimed checkouts
// (oldest from May) motivated it.
const DEFAULT_WORKTREE_RECLAIM_DAYS = 30;
// Session archival is bounded per pass. Without a cap, one cohort of sessions
// crossing the age threshold together is a single-tick tar+rm stampede (1,041
// archives on 2026-08-05 was exactly that).
const DEFAULT_SESSION_RECLAIM_PER_TICK = 50;
// 0 disables the count cap. Non-zero makes the oldest-idle sessions above the
// cap eligible regardless of age.
const DEFAULT_SESSION_ACTIVE_CAP = 0;
export const THREAD_RESCUES_DIRNAME = 'thread-rescues';
/** Append-only record of every completed archival; the restore/finish authority. */
export const SESSION_RECLAIM_JOURNAL_FILENAME = 'reclaim-journal.jsonl';
// Regenerable trees excluded from rescue archives — pure reinstallable weight.
const ARCHIVE_EXCLUDED_DIR_NAMES = [
  'node_modules',
  '.pnpm-store',
  '.turbo',
  '.cache',
  '.next',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
];

const parsedIdleHours = Number(process.env.SESSION_ARTIFACT_IDLE_HOURS);
export const SESSION_ARTIFACT_IDLE_MS =
  (Number.isFinite(parsedIdleHours) && parsedIdleHours > 0 ? parsedIdleHours : DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;

const PRUNABLE_DIR_NAMES = new Set(['node_modules', '.pnpm-store', '.turbo', '.cache']);
const SKIP_DESCEND_DIR_NAMES = new Set(['.git']);

let lastStorageMaintenanceMs = 0;
let lastDockerPruneAttemptMs = 0;
let lastEmergencyDockerAttemptMs = 0;

export type StorageMode = 'dry-run' | 'apply';
export type StoragePool = 'session-cache' | 'thread-cache' | 'docker';
export type StorageActionKind =
  | 'delete-cache-dir'
  | 'delete-derived-file'
  | 'archive-thread-worktree'
  | 'archive-session'
  | 'docker-prune-containers'
  | 'docker-prune-images'
  | 'docker-prune-builder-cache';

export interface StoragePolicy {
  enabled: boolean;
  filesystemPath: string;
  cleanupThresholdPct: number;
  admissionRefusePct: number;
  idleArtifactMs: number;
  /** Archive-then-reclaim threshold for whole thread worktree dirs. */
  worktreeReclaimMs: number;
  /**
   * Archive-then-reclaim threshold for whole SESSION dirs. Its own knob, so
   * sessions and thread worktrees can age out on different clocks; unset it
   * falls back to `worktreeReclaimMs` (the pre-split behavior).
   */
  sessionReclaimMs: number;
  /** Ceiling on session archivals per maintenance pass. */
  sessionReclaimPerTick: number;
  /** Target ceiling on active sessions; 0 disables the count cap. */
  sessionActiveCap: number;
  scanCadenceMs: number;
  dockerPruneCadenceMs: number;
  dockerBuildCacheUnusedFor: string;
  cleanupTargetPct: number;
  emergencyRetryMs: number;
  candidateRetentionHours: number;
  legacyImageGraceHours: number;
}

export interface FilesystemUsage {
  path: string;
  usedBytes: number;
  availableBytes: number;
  sizeBytes: number;
  usagePct: number;
}

export interface StorageActionReport {
  id: string;
  pool: StoragePool;
  kind: StorageActionKind;
  path?: string;
  dockerArgs?: string[];
  estimatedBytes: number;
  reason: string;
  safety: string;
  status: 'planned' | 'applied' | 'skipped' | 'failed';
  error?: string;
}

export interface DockerImageInventory {
  id: string;
  repoTags: string[];
  repoDigests?: string[];
  createdAt: string;
  sizeBytes: number;
  labels: Record<string, string>;
}

export type DockerImageDisposition = 'protected' | 'eligible' | 'unmanaged';

export interface DockerImageDispositionReport extends DockerImageInventory {
  disposition: DockerImageDisposition;
  protectionReason:
    | 'canonical-image'
    | 'configured-image'
    | 'container-referenced'
    | 'configuration-unreadable'
    | 'retention-lease'
    | 'invalid-retention-metadata'
    | 'legacy-grace'
    | 'expired-unreferenced'
    | 'unmanaged-image';
  owner: string | null;
  leaseExpiresAt: string | null;
}

export interface DockerImageProtectionContext {
  now: number;
  canonicalImage: string;
  configuredImages: Set<string>;
  containerImageIds: Set<string>;
  candidateRetentionHours: number;
  legacyGraceHours: number;
  configurationReadable: boolean;
}

const RETENTION_CREATED_AT_LABEL = 'nanoclaw.retention.created_at';
const RETENTION_HOURS_LABEL = 'nanoclaw.retention.hours';
const RETENTION_OWNER_LABEL = 'nanoclaw.retention.owner';
const IMAGE_ROLE_LABEL = 'nanoclaw.image.role';

export function classifyDockerImage(
  image: DockerImageInventory,
  context: DockerImageProtectionContext,
): DockerImageDispositionReport {
  const imageReferences = [...image.repoTags, ...(image.repoDigests ?? [])];
  const isCanonical = imageReferences.includes(context.canonicalImage) || image.id === context.canonicalImage;
  const isConfigured =
    imageReferences.some((reference) => context.configuredImages.has(reference)) ||
    context.configuredImages.has(image.id);
  const isContainerReferenced = context.containerImageIds.has(image.id);
  const isNanoClawTag = image.repoTags.some(
    (tag) => tag === CONTAINER_IMAGE_BASE || tag.startsWith(`${CONTAINER_IMAGE_BASE}:`),
  );
  const isManaged =
    isCanonical ||
    isConfigured ||
    isNanoClawTag ||
    Boolean(image.labels[DOCKER_PRUNE_IMAGE_LABEL]) ||
    Boolean(image.labels[IMAGE_ROLE_LABEL]);

  const base = {
    ...image,
    owner: image.labels[RETENTION_OWNER_LABEL]?.trim() || null,
    leaseExpiresAt: null as string | null,
  };
  const protectedResult = (
    protectionReason: DockerImageDispositionReport['protectionReason'],
  ): DockerImageDispositionReport => ({ ...base, disposition: 'protected', protectionReason });

  if (!isManaged) {
    return { ...base, disposition: 'unmanaged', protectionReason: 'unmanaged-image' };
  }

  const createdLabel = image.labels[RETENTION_CREATED_AT_LABEL];
  const hoursLabel = image.labels[RETENTION_HOURS_LABEL];
  const hasAnyRetentionMetadata =
    createdLabel !== undefined || hoursLabel !== undefined || image.labels[RETENTION_OWNER_LABEL] !== undefined;
  let invalidRetentionMetadata = false;
  let activeLeaseReason: 'retention-lease' | 'legacy-grace' | null = null;
  if (hasAnyRetentionMetadata) {
    const createdMs = createdLabel ? Date.parse(createdLabel) : NaN;
    const hours = hoursLabel === undefined || hoursLabel.trim() === '' ? NaN : Number(hoursLabel);
    if (!Number.isFinite(createdMs) || !Number.isFinite(hours) || hours < 0) {
      invalidRetentionMetadata = true;
    } else {
      const leaseExpiresMs = createdMs + hours * 60 * 60 * 1000;
      base.leaseExpiresAt = new Date(leaseExpiresMs).toISOString();
      if (hours > 0 && context.now < leaseExpiresMs) activeLeaseReason = 'retention-lease';
    }
  } else {
    const createdMs = Date.parse(image.createdAt);
    if (!Number.isFinite(createdMs)) {
      invalidRetentionMetadata = true;
    } else {
      const legacyExpiresMs = createdMs + context.legacyGraceHours * 60 * 60 * 1000;
      base.leaseExpiresAt = new Date(legacyExpiresMs).toISOString();
      if (context.now < legacyExpiresMs) activeLeaseReason = 'legacy-grace';
    }
  }

  if (isCanonical) return protectedResult('canonical-image');
  if (isConfigured) return protectedResult('configured-image');
  if (isContainerReferenced) return protectedResult('container-referenced');
  if (!context.configurationReadable) return protectedResult('configuration-unreadable');
  if (invalidRetentionMetadata) return protectedResult('invalid-retention-metadata');
  if (activeLeaseReason) return protectedResult(activeLeaseReason);
  return { ...base, disposition: 'eligible', protectionReason: 'expired-unreferenced' };
}

interface StorageAction extends StorageActionReport {
  apply: () => void | boolean;
}

export interface StorageReport {
  timestamp: string;
  mode: StorageMode;
  policy: StoragePolicy;
  filesystem: {
    before: FilesystemUsage | null;
    after: FilesystemUsage | null;
    actualReclaimedBytes: number;
  };
  estimatedReclaimableBytes: number;
  pressure: {
    level: 'unknown' | 'normal' | 'cleanup' | 'critical';
    cleanupTargetPct: number;
    targetReached: boolean;
    nextEmergencyRetryAt: string | null;
  };
  images: {
    dispositions: DockerImageDispositionReport[];
    protectedCount: number;
    protectedBytes: number;
    eligibleCount: number;
    eligibleBytes: number;
  };
  actions: StorageActionReport[];
  pools: Record<StoragePool, { actions: number; estimatedBytes: number }>;
  skipped: {
    liveSessions: number;
    liveThreads: number;
    busySessions: number;
    freshSessions: number;
    freshThreads: number;
    unreadableSessions: number;
    noActivitySessions: number;
    /** Eligible sessions left for a later pass by the per-tick budget. */
    budgetDeferredSessions: number;
  };
  warnings: string[];
}

export interface StorageReportOptions {
  mode?: StorageMode;
  policy?: Partial<StoragePolicy>;
  now?: number;
  isContainerRunning?: (sessionId: string) => boolean;
  sessionsRoot?: string;
  threadsRoot?: string;
  includeDocker?: boolean;
  respectCadence?: boolean;
  force?: boolean;
}

export interface StorageAdmissionResult {
  allowed: boolean;
  reason: 'below-threshold' | 'cleanup-succeeded' | 'still-over-threshold' | 'disabled' | 'usage-unavailable';
  report: StorageReport;
}

export interface ThreadWorktreeActivity {
  lastActivityMs: number;
  hasRunningContainer: boolean;
  hasBusySession: boolean;
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(value, fallback);
  return Math.floor(parsed);
}

const warnedInvalidKnobs = new Set<string>();
let loggedSessionReclaimConfig = false;

/**
 * Session-reclaim knobs are integers with a hard floor. An unparseable or
 * out-of-range value falls back to the default and warns exactly once per
 * process, so a typo degrades to the documented behavior instead of silently
 * disabling (or unbounding) reclaim.
 */
function parseSessionKnob(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) {
    if (!warnedInvalidKnobs.has(name)) {
      warnedInvalidKnobs.add(name);
      log.warn('storage-manager: invalid session reclaim knob, using default', { knob: name, value: raw, fallback });
    }
    return fallback;
  }
  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function resolveStoragePolicy(overrides: Partial<StoragePolicy> = {}): StoragePolicy {
  const cleanupThreshold = Math.min(
    99,
    parsePositiveInt(
      process.env.NANOCLAW_STORAGE_CLEANUP_THRESHOLD_PCT ?? process.env.NANOCLAW_DOCKER_PRUNE_THRESHOLD_PCT,
      DEFAULT_CLEANUP_THRESHOLD_PCT,
    ),
  );
  const admissionRefuse = Math.min(
    99,
    Math.max(
      cleanupThreshold,
      parsePositiveInt(process.env.NANOCLAW_STORAGE_ADMISSION_REFUSE_PCT, DEFAULT_ADMISSION_REFUSE_PCT),
    ),
  );
  const idleHours = parsePositiveNumber(process.env.SESSION_ARTIFACT_IDLE_HOURS, DEFAULT_IDLE_HOURS);
  const scanHours = parsePositiveNumber(process.env.NANOCLAW_STORAGE_SCAN_INTERVAL_HOURS, DEFAULT_SCAN_INTERVAL_HOURS);
  const dockerPruneHours = parsePositiveNumber(
    process.env.NANOCLAW_DOCKER_PRUNE_INTERVAL_HOURS,
    DEFAULT_DOCKER_PRUNE_INTERVAL_HOURS,
  );
  const cleanupTarget = Math.max(
    1,
    Math.min(
      cleanupThreshold,
      parsePositiveInt(
        process.env.NANOCLAW_STORAGE_CLEANUP_TARGET_PCT,
        cleanupThreshold - DEFAULT_CLEANUP_TARGET_MARGIN_PCT,
      ),
    ),
  );

  const sessionReclaimDays = process.env.NANOCLAW_SESSION_RECLAIM_DAYS?.trim()
    ? parseSessionKnob('NANOCLAW_SESSION_RECLAIM_DAYS', 0, 1)
    : 0;
  const sessionReclaimPerTick = parseSessionKnob(
    'NANOCLAW_SESSION_RECLAIM_PER_TICK',
    DEFAULT_SESSION_RECLAIM_PER_TICK,
    1,
  );
  const sessionActiveCap = parseSessionKnob('NANOCLAW_SESSION_ACTIVE_CAP', DEFAULT_SESSION_ACTIVE_CAP, 0);

  const policy: StoragePolicy = {
    enabled: process.env.NANOCLAW_STORAGE_MANAGER_ENABLED !== '0',
    filesystemPath: DATA_DIR,
    cleanupThresholdPct: cleanupThreshold,
    admissionRefusePct: admissionRefuse,
    idleArtifactMs: idleHours * 60 * 60 * 1000,
    worktreeReclaimMs:
      parsePositiveNumber(process.env.NANOCLAW_THREAD_WORKTREE_RECLAIM_DAYS, DEFAULT_WORKTREE_RECLAIM_DAYS) *
      24 *
      60 *
      60 *
      1000,
    sessionReclaimMs: sessionReclaimDays * 24 * 60 * 60 * 1000,
    sessionReclaimPerTick,
    sessionActiveCap,
    scanCadenceMs: scanHours * 60 * 60 * 1000,
    dockerPruneCadenceMs: dockerPruneHours * 60 * 60 * 1000,
    dockerBuildCacheUnusedFor:
      process.env.NANOCLAW_DOCKER_BUILD_CACHE_UNUSED_FOR || DEFAULT_DOCKER_BUILD_CACHE_UNUSED_FOR,
    cleanupTargetPct: cleanupTarget,
    emergencyRetryMs:
      parsePositiveNumber(process.env.NANOCLAW_STORAGE_EMERGENCY_RETRY_SECONDS, DEFAULT_EMERGENCY_RETRY_SECONDS) * 1000,
    candidateRetentionHours: parseNonNegativeNumber(
      process.env.NANOCLAW_IMAGE_RETENTION_HOURS,
      DEFAULT_IMAGE_RETENTION_HOURS,
    ),
    legacyImageGraceHours: parseNonNegativeNumber(
      process.env.NANOCLAW_LEGACY_IMAGE_GRACE_HOURS,
      DEFAULT_LEGACY_IMAGE_GRACE_HOURS,
    ),
    ...overrides,
  };

  // Compatibility default: an install that never sets the session knob keeps
  // ageing sessions on the shared worktree clock exactly as before the split.
  if (overrides.sessionReclaimMs === undefined && sessionReclaimDays === 0) {
    policy.sessionReclaimMs = policy.worktreeReclaimMs;
  }

  if (!loggedSessionReclaimConfig) {
    loggedSessionReclaimConfig = true;
    log.info('storage-manager: session reclaim config', {
      sessionReclaimDays: policy.sessionReclaimMs / 86400000,
      sessionReclaimPerTick: policy.sessionReclaimPerTick,
      sessionActiveCap: policy.sessionActiveCap,
      worktreeReclaimDays: policy.worktreeReclaimMs / 86400000,
      sessionKnobSet: sessionReclaimDays > 0,
    });
  }

  return policy;
}

function parseDfOutput(output: string, targetPath: string): FilesystemUsage | null {
  const lines = output.trim().split('\n');
  if (lines.length < 2) return null;
  const fields = lines[1]!.trim().split(/\s+/);
  if (fields.length < 5) return null;

  const sizeKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  const availableKb = Number(fields[3]);
  const pctText = fields[4]!;
  const usagePct = pctText.endsWith('%') ? Number(pctText.slice(0, -1)) : NaN;
  if (![sizeKb, usedKb, availableKb, usagePct].every(Number.isFinite)) return null;

  return {
    path: targetPath,
    sizeBytes: sizeKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availableKb * 1024,
    usagePct,
  };
}

export function getFilesystemUsage(targetPath: string): FilesystemUsage | null {
  const probePath = fs.existsSync(targetPath) ? targetPath : process.cwd();
  try {
    const output = execFileSync('df', ['-Pk', probePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return parseDfOutput(output, targetPath);
  } catch {
    return null;
  }
}

function parseSqliteUtc(s: string): number {
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z');
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function dirSizeBytes(root: string): number {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          stack.push(full);
        } else if (st.isFile()) {
          total += st.size;
        }
      } catch {
        // Ignore files that disappear during the scan.
      }
    }
  }
  return total;
}

export function findPrunableArtifactDirs(root: string): string[] {
  const found: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!isPathInside(root, full)) continue;
      if (SKIP_DESCEND_DIR_NAMES.has(entry.name)) continue;

      if (PRUNABLE_DIR_NAMES.has(entry.name)) {
        found.push(full);
        continue;
      }

      if (entry.name === '.next') {
        const nextCache = path.join(full, 'cache');
        try {
          const st = fs.lstatSync(nextCache);
          if (st.isDirectory() && !st.isSymbolicLink()) {
            found.push(nextCache);
          }
        } catch {
          // No cache dir.
        }
      }

      stack.push(full);
    }
  }
  return found;
}

function safeReaddirDirents(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sessionLastActivityMs(sessPath: string): number {
  let newest = 0;
  for (const name of ['inbound.db', 'outbound.db', 'archive.db', 'central.db', '.heartbeat']) {
    try {
      const m = fs.statSync(path.join(sessPath, name)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      // File missing.
    }
  }
  return newest;
}

function dbHasRows(dbPath: string, sql: string, params: unknown[] = []): boolean | null {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(sql).get(...params) as { found: number } | undefined;
    return (row?.found ?? 0) > 0;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Is this session unsafe to reclaim?
 *
 * `null` means "could not tell" (unreadable DB) and callers treat it exactly
 * like `true` — reclaim fails closed.
 *
 * Any UNCONSUMED inbound row counts, including a `process_after` in the
 * future: a monthly recurrence is real pending work even though the session
 * has looked idle for weeks, and the due-only predicate this replaced could
 * not see it. Durable follow-up promises (`work_continuation`, and its legacy
 * `pending_next` spelling) live in outbound `session_state` and are checked
 * too — a container between turns owes that work even with no live claim.
 */
function sessionHasOpenWork(agentGroupId: string, sessionId: string, sessPath?: string): boolean | null {
  const inbound = dbHasRows(
    sessPath ? path.join(sessPath, 'inbound.db') : inboundDbPath(agentGroupId, sessionId),
    `SELECT 1 AS found
       FROM messages_in
      WHERE status IN ('processing', 'pending')
      LIMIT 1`,
  );
  if (inbound === null || inbound) return inbound;

  const outboundPath = sessPath ? path.join(sessPath, 'outbound.db') : outboundDbPath(agentGroupId, sessionId);
  const claimed = dbHasRows(outboundPath, "SELECT 1 AS found FROM processing_ack WHERE status = 'processing' LIMIT 1");
  if (claimed === null || claimed) return claimed;

  // session_state is absent from older outbound DBs; a missing table reads as
  // null (unreadable) from dbHasRows, which would block every legacy session.
  if (!sessionStateTableExists(outboundPath)) return false;
  return dbHasRows(
    outboundPath,
    `SELECT 1 AS found
       FROM session_state
      WHERE key IN ('work_continuation', 'pending_next')
        AND value IS NOT NULL
        AND trim(value) NOT IN ('', 'null')
      LIMIT 1`,
  );
}

function sessionStateTableExists(dbPath: string): boolean {
  return isReadableSqliteDatabase(dbPath, 'session_state');
}

export function collectThreadWorktreeActivity(
  isContainerRunning: (sessionId: string) => boolean,
): Map<string, ThreadWorktreeActivity> {
  const activity = new Map<string, ThreadWorktreeActivity>();
  let rows: Array<{
    id: string;
    agent_group_id: string;
    thread_id: string | null;
    last_active: string | null;
    platform_id: string;
    wg: string;
  }>;
  try {
    rows = getDb()
      .prepare(
        `SELECT s.id, s.agent_group_id, s.thread_id, s.last_active, mg.platform_id,
                COALESCE(ag.workgroup_id, ag.folder) AS wg
           FROM sessions s
           JOIN messaging_groups mg ON mg.id = s.messaging_group_id
           JOIN agent_groups ag ON ag.id = s.agent_group_id
          WHERE s.messaging_group_id IS NOT NULL`,
      )
      .all() as typeof rows;
  } catch (err) {
    log.warn('storage-manager: failed to read thread worktree activity', { err });
    return activity;
  }

  for (const row of rows) {
    const worktreeDir = threadWorktreeDir(row.platform_id, row.thread_id, row.wg);
    const current = activity.get(worktreeDir) ?? {
      lastActivityMs: 0,
      hasRunningContainer: false,
      hasBusySession: false,
    };
    const parsedLastActive = row.last_active ? parseSqliteUtc(row.last_active) : NaN;
    if (Number.isFinite(parsedLastActive) && parsedLastActive > current.lastActivityMs) {
      current.lastActivityMs = parsedLastActive;
    }
    if (isContainerRunning(row.id)) {
      current.hasRunningContainer = true;
    }
    const openWork = sessionHasOpenWork(row.agent_group_id, row.id);
    if (openWork !== false) {
      current.hasBusySession = true;
    }
    activity.set(worktreeDir, current);
  }
  return activity;
}

type ArtifactTargetType = 'directory' | 'file';

function createDeleteArtifactAction(args: {
  id: string;
  pool: 'session-cache' | 'thread-cache';
  target: string;
  root: string;
  estimatedBytes: number;
  reason: string;
  targetType: ArtifactTargetType;
  safety: string;
  canApply?: () => boolean;
}): StorageAction {
  return {
    id: args.id,
    pool: args.pool,
    kind: args.targetType === 'directory' ? 'delete-cache-dir' : 'delete-derived-file',
    path: args.target,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety: args.safety,
    status: 'planned',
    apply: () => {
      let allowed = true;
      const claimed = tryRunWithStorageCleanupClaim(args.root, () => {
        if (args.canApply && !args.canApply()) {
          allowed = false;
          return;
        }
        if (!isPathInside(args.root, args.target)) {
          throw new Error(`refusing to remove path outside root: ${args.target}`);
        }
        const st = fs.lstatSync(args.target);
        if (args.targetType === 'directory' && (!st.isDirectory() || st.isSymbolicLink())) {
          throw new Error(`refusing to remove non-directory or symlink: ${args.target}`);
        }
        if (args.targetType === 'file' && (!st.isFile() || st.isSymbolicLink())) {
          throw new Error(`refusing to remove non-file or symlink: ${args.target}`);
        }
        fs.rmSync(args.target, { recursive: true, force: true });
      });
      return claimed && allowed;
    },
  };
}

interface SessionProjectionSources {
  archiveReady: boolean;
  centralReady: boolean;
}

function isReadableSqliteDatabase(dbPath: string, requiredTable?: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (requiredTable) {
      const row = db
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(requiredTable) as { found: number } | undefined;
      return row?.found === 1;
    }
    db.pragma('schema_version');
    return true;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function sessionProjectionSources(sessionsRoot: string): SessionProjectionSources {
  const dataRoot = path.dirname(sessionsRoot);
  return {
    // Archive projections hold conversation history. Require the canonical history table,
    // not merely a file that happens to open as SQLite, before reclaiming any projection.
    archiveReady: isReadableSqliteDatabase(path.join(dataRoot, 'archive.db'), 'messages_archive'),
    // central.db is a per-session projection too. Its canonical source must be readable
    // before reclamation so cleanup never turns a source-database outage into data loss.
    centralReady: isReadableSqliteDatabase(path.join(dataRoot, 'v2.db')),
  };
}

function regularFileSize(filePath: string): number | null {
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile() && !st.isSymbolicLink() ? st.size : null;
  } catch {
    return null;
  }
}

function isRealDirectory(dirPath: string): boolean {
  try {
    const st = fs.lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

// ── Reclaim serializer ───────────────────────────────────────────────────────
// Every production reclaim entry point (hourly maintenance, pressure
// admission, force prune) lands in the single storage worker thread of a
// single-process host, so one module-level budget IS the serializer: whoever
// opens the pass sets the budget, anything that starts while it is open draws
// from the same pool instead of getting a second one.
// ponytail: if reclaim ever runs in more than one process, this becomes a lock
// file under the sessions root — the call sites do not change.
let reclaimPassDepth = 0;
let reclaimBudgetRemaining = 0;

function beginReclaimPass(perTick: number): void {
  if (reclaimPassDepth === 0) reclaimBudgetRemaining = Math.max(0, perTick);
  reclaimPassDepth += 1;
}

function endReclaimPass(): void {
  reclaimPassDepth = Math.max(0, reclaimPassDepth - 1);
}

/** Reserve up to `want` archivals from the open pass; returns what was granted. */
function takeReclaimBudget(want: number): number {
  const granted = Math.max(0, Math.min(want, reclaimBudgetRemaining));
  reclaimBudgetRemaining -= granted;
  return granted;
}

export const SESSION_RESCUES_DIRNAME = 'session-rescues';
// Secret material and per-spawn regenerables never enter a rescue archive:
// creds/ is re-materialized on every spawn; the graphify dirs are caches.
const SESSION_ARCHIVE_EXTRA_EXCLUDES = ['creds', 'graphify-cache', '.graphify-stage'];

interface CentralSessionRow {
  status: string;
  last_activity: string | null;
}

/**
 * Central-DB row for a session dir, or null when the row is gone (orphan
 * dir), or 'unavailable' when the central DB cannot be read — in which case
 * session reclaim MUST NOT run (fail closed: without the row we cannot see
 * status or true activity).
 */
function centralSessionRow(sessionId: string): CentralSessionRow | null | 'unavailable' {
  try {
    const row = getDb()
      .prepare('SELECT status, COALESCE(last_active, created_at) AS last_activity FROM sessions WHERE id = ?')
      .get(sessionId) as CentralSessionRow | undefined;
    return row ?? null;
  } catch {
    return 'unavailable';
  }
}

export interface SessionReclaimJournalEntry {
  ts: string;
  session_id: string;
  agent_group_id: string;
  prior_status: 'active' | 'closed' | 'orphan';
  rescue_path: string;
}

function reclaimJournalPath(rescuesDir: string): string {
  return path.join(rescuesDir, SESSION_RECLAIM_JOURNAL_FILENAME);
}

/**
 * Record one archival durably BEFORE the dir is removed. This line is what
 * makes both recovery directions mechanical: a crash between publish and rm is
 * finished from it at startup, and an operator restore reads the rescue path
 * and the status to put back.
 */
function appendReclaimJournal(rescuesDir: string, entry: SessionReclaimJournalEntry): void {
  fs.mkdirSync(rescuesDir, { recursive: true });
  const fd = fs.openSync(reclaimJournalPath(rescuesDir), 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readReclaimJournal(rescuesDir: string): Map<string, SessionReclaimJournalEntry> {
  const entries = new Map<string, SessionReclaimJournalEntry>();
  let raw: string;
  try {
    raw = fs.readFileSync(reclaimJournalPath(rescuesDir), 'utf-8');
  } catch {
    return entries;
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as SessionReclaimJournalEntry;
      if (typeof entry.session_id === 'string' && typeof entry.rescue_path === 'string') {
        entries.set(entry.session_id, entry);
      }
    } catch {
      // A torn final line from a crash mid-append: ignore, keep the rest.
    }
  }
  return entries;
}

function isPublishedArchive(archivePath: string): boolean {
  try {
    const st = fs.statSync(archivePath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Put an interrupted archival's row back. The active triple is uniquely
 * indexed (migration 049), so if a fresh session claimed this session's triple
 * while it was 'archiving', reviving it as 'active' would violate that index —
 * the old row is history at that point and closes instead.
 */
function releaseArchivingRow(sessionId: string): void {
  try {
    getDb().prepare("UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'archiving'").run(sessionId);
  } catch (err) {
    getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(sessionId);
    log.warn('storage-manager: archiving row could not return to active, closed instead', { sessionId, err });
  }
}

/**
 * Archive-then-reclaim one whole session dir. findSessionForAgent only matches
 * status='active', so the next inbound for the same thread creates a FRESH
 * session with a fresh dir (initSessionFolder is idempotent) — conversation
 * history stays in the canonical data/archive.db and Graphify. The rescue
 * archive preserves the session DBs, provider continuity files, and any
 * worktree content minus regenerable trees and creds.
 *
 * The lifecycle is ordered so no crash can lose the dir without a readable
 * archive standing in for it:
 *   revalidate → CAS active→archiving → temp tar → validate → atomic publish
 *   → journal → CAS archiving→closed → rm
 * `archiving` is a real, sweep-invisible state; `finishInterruptedSessionArchivals`
 * resolves whatever a crash left behind.
 */
function createArchiveSessionAction(args: {
  id: string;
  sessionId: string;
  agentGroupId: string;
  sessionStatus: 'active' | 'closed' | 'orphan';
  sessPath: string;
  sessionsRoot: string;
  rescuesDir: string;
  estimatedBytes: number;
  reason: string;
  collectedActivityMs: number;
  isContainerRunning: (sessionId: string) => boolean;
}): StorageAction {
  return {
    id: args.id,
    pool: 'session-cache',
    kind: 'archive-session',
    path: args.sessPath,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety:
      'Whole long-idle session dir; DBs and worktree content preserved in a zstd rescue archive before removal (creds and regenerable trees excluded). Re-validated immediately before acting, and the row is held in "archiving" until the archive is published so the next inbound message creates a fresh session.',
    status: 'planned',
    apply: () => {
      let acted = true;
      const claimed = tryRunWithStorageCleanupClaim(args.sessPath, () => {
        if (!isPathInside(args.sessionsRoot, args.sessPath)) {
          throw new Error(`refusing to archive path outside sessions root: ${args.sessPath}`);
        }
        const st = fs.lstatSync(args.sessPath);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          throw new Error(`refusing to archive non-directory or symlink: ${args.sessPath}`);
        }

        // Collection and apply are separated by the rest of the pass, which
        // can be minutes of tar work. Anything that made this session live in
        // between wins; the next pass will reconsider it.
        if (args.isContainerRunning(args.sessionId)) {
          acted = false;
          return;
        }
        if (sessionHasOpenWork(args.agentGroupId, args.sessionId, args.sessPath) !== false) {
          acted = false;
          return;
        }
        if (sessionLastActivityMs(args.sessPath) !== args.collectedActivityMs) {
          acted = false;
          return;
        }

        // Claim the row before touching the disk. An 'unavailable' DB throws
        // out of here and the dir is kept (fail closed).
        if (args.sessionStatus === 'active') {
          const claimedRow = getDb()
            .prepare("UPDATE sessions SET status = 'archiving' WHERE id = ? AND status = 'active'")
            .run(args.sessionId).changes;
          if (claimedRow !== 1) {
            acted = false;
            return;
          }
        }

        fs.mkdirSync(args.rescuesDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveName = `${args.sessPath.slice(args.sessionsRoot.length + 1).replace(/[/\\]/g, '__')}-${stamp}.tar.zst`;
        const archivePath = path.join(args.rescuesDir, archiveName);
        const tempPath = `${archivePath}.tmp`;
        try {
          fs.rmSync(tempPath, { force: true });
          execFileSync(
            'tar',
            [
              '-I',
              'zstd -T0',
              ...ARCHIVE_EXCLUDED_DIR_NAMES.map((name) => `--exclude=${name}`),
              ...SESSION_ARCHIVE_EXTRA_EXCLUDES.map((name) => `--exclude=${name}`),
              '-cf',
              tempPath,
              '-C',
              path.dirname(args.sessPath),
              path.basename(args.sessPath),
            ],
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 },
          );
          const archiveSt = fs.statSync(tempPath);
          if (!archiveSt.isFile() || archiveSt.size === 0) {
            throw new Error(`rescue archive missing or empty: ${tempPath}`);
          }
          // Readable, not merely present: a truncated zstd stream is a file
          // with bytes in it and would still license the delete.
          execFileSync('tar', ['-I', 'zstd -T0', '-tf', tempPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60 * 60 * 1000,
          });
          // Publish atomically — a rescue path only ever exists complete.
          fs.renameSync(tempPath, archivePath);
        } catch (err) {
          fs.rmSync(tempPath, { force: true });
          if (args.sessionStatus === 'active') releaseArchivingRow(args.sessionId);
          throw err;
        }

        appendReclaimJournal(args.rescuesDir, {
          ts: new Date().toISOString(),
          session_id: args.sessionId,
          agent_group_id: args.agentGroupId,
          prior_status: args.sessionStatus,
          rescue_path: archivePath,
        });
        if (args.sessionStatus === 'active') {
          getDb()
            .prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'")
            .run(args.sessionId);
        }
        fs.rmSync(args.sessPath, { recursive: true, force: true });
      });
      return claimed && acted;
    },
  };
}

/**
 * Startup finisher for archivals a host stop interrupted. Idempotent, and
 * deliberately journal-gated: a `closed` session dir is only removed when a
 * journal line names a published archive for it, so the ~1,200 sessions closed
 * by ordinary session-close paths are never touched.
 */
export function finishInterruptedSessionArchivals(sessionsRoot: string = sessionsBaseDir()): {
  released: number;
  finished: number;
} {
  const rescuesDir = path.join(path.dirname(sessionsRoot), SESSION_RESCUES_DIRNAME);
  const journal = readReclaimJournal(rescuesDir);
  let released = 0;
  let finished = 0;

  const removeDir = (sessPath: string): void => {
    if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
  };

  let archiving: Array<{ id: string; agent_group_id: string }>;
  try {
    archiving = getDb()
      .prepare("SELECT id, agent_group_id FROM sessions WHERE status = 'archiving'")
      .all() as typeof archiving;
  } catch (err) {
    log.warn('storage-manager: could not read interrupted archivals', { err });
    return { released, finished };
  }

  for (const row of archiving) {
    const sessPath = path.join(sessionsRoot, row.agent_group_id, row.id);
    const entry = journal.get(row.id);
    if (entry && isPublishedArchive(entry.rescue_path)) {
      // Crashed between publishing the archive and closing the row.
      getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(row.id);
      removeDir(sessPath);
      finished += 1;
      continue;
    }
    if (!fs.existsSync(sessPath)) {
      // Dir already gone with no archive to point at: the row cannot go back
      // to active, and leaving it 'archiving' hides it from every sweep.
      getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(row.id);
      finished += 1;
      continue;
    }
    releaseArchivingRow(row.id);
    released += 1;
  }

  for (const [sessionId, entry] of journal) {
    const sessPath = path.join(sessionsRoot, entry.agent_group_id, sessionId);
    if (!fs.existsSync(sessPath)) continue;
    if (!isPublishedArchive(entry.rescue_path)) continue;
    let status: string | undefined;
    try {
      status = (
        getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string } | undefined
      )?.status;
    } catch {
      continue;
    }
    if (status !== undefined && status !== 'closed') continue;
    removeDir(sessPath);
    finished += 1;
  }

  // Temp archives never became a rescue path; nothing references them.
  try {
    for (const name of fs.readdirSync(rescuesDir)) {
      if (name.endsWith('.tar.zst.tmp')) fs.rmSync(path.join(rescuesDir, name), { force: true });
    }
  } catch {
    // No rescues dir yet.
  }

  if (released > 0 || finished > 0) {
    log.info('storage-manager: resolved interrupted session archivals', { released, finished });
  }
  return { released, finished };
}

interface SessionReclaimCandidate {
  groupName: string;
  sessionId: string;
  sessPath: string;
  sessionStatus: 'active' | 'closed' | 'orphan';
  newestActivityMs: number;
  ageEligible: boolean;
}

/** Active-row count for the count cap; null means "cannot tell" — cap disabled. */
function activeSessionCount(): number | null {
  try {
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'").get() as
      | { n: number }
      | undefined;
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

/**
 * One union pass over the reclaim candidates: age-eligible ∪ count-overflow,
 * oldest-idle first, bounded by the pass budget. Blocked sessions never reach
 * here, so a blocked old session cannot consume an overflow slot — the
 * next-oldest unblocked one does, and the cap stays a target rather than a
 * promise.
 */
function selectSessionsToArchive(
  candidates: SessionReclaimCandidate[],
  policy: StoragePolicy,
): { selected: Set<string>; deferred: number } {
  const ageEligible = candidates.filter((candidate) => candidate.ageEligible);
  const cap = policy.sessionActiveCap;
  const activeCount = cap > 0 ? activeSessionCount() : null;
  const deficit = cap > 0 && activeCount !== null ? Math.max(0, activeCount - cap) : 0;
  const overflowPool =
    deficit > 0 ? candidates.filter((candidate) => !candidate.ageEligible && candidate.sessionStatus === 'active') : [];

  const want = ageEligible.length + Math.min(deficit, overflowPool.length);
  if (want === 0) return { selected: new Set(), deferred: 0 };

  const granted = takeReclaimBudget(Math.min(want, policy.sessionReclaimPerTick));
  const union = [...ageEligible, ...overflowPool].sort((a, b) => a.newestActivityMs - b.newestActivityMs);
  return {
    selected: new Set(union.slice(0, granted).map((candidate) => candidate.sessPath)),
    deferred: want - granted,
  };
}

function collectSessionCacheActions(args: {
  now: number;
  root: string;
  policy: StoragePolicy;
  isContainerRunning: (sessionId: string) => boolean;
  skipped: StorageReport['skipped'];
  projectionSources: SessionProjectionSources;
  warnings: string[];
}): StorageAction[] {
  const actions: StorageAction[] = [];
  const dataRoot = path.dirname(args.root);
  const canonicalArchive = path.join(dataRoot, 'archive.db');
  const canonicalCentral = path.join(dataRoot, 'v2.db');
  const rescuesDir = path.join(dataRoot, SESSION_RESCUES_DIRNAME);
  let warnedArchiveSourceUnavailable = false;
  let warnedCentralSourceUnavailable = false;

  // Pass 1: everything that survives the blocker checks, with the reclaim
  // classification attached. Selection needs the whole population (the count
  // cap is a fleet-level fact), so no dir is archived during the walk.
  const candidates: SessionReclaimCandidate[] = [];
  const cacheOnly: Array<{ groupName: string; sessionId: string; sessPath: string }> = [];

  for (const groupDirent of safeReaddirDirents(args.root)) {
    if (!groupDirent.isDirectory() || groupDirent.isSymbolicLink()) continue;
    const groupPath = path.join(args.root, groupDirent.name);

    for (const sessDirent of safeReaddirDirents(groupPath)) {
      if (!sessDirent.isDirectory() || sessDirent.isSymbolicLink()) continue;
      if (!sessDirent.name.startsWith('sess-')) continue;

      const sessionId = sessDirent.name;
      if (args.isContainerRunning(sessionId)) {
        args.skipped.liveSessions += 1;
        continue;
      }

      const sessPath = path.join(groupPath, sessionId);
      const busy = sessionHasOpenWork(groupDirent.name, sessionId, sessPath);
      if (busy !== false) {
        if (busy === null) args.skipped.unreadableSessions += 1;
        else args.skipped.busySessions += 1;
        continue;
      }

      const lastActivity = sessionLastActivityMs(sessPath);
      if (lastActivity === 0) {
        args.skipped.noActivitySessions += 1;
        continue;
      }
      if (args.now - lastActivity < args.policy.idleArtifactMs) {
        args.skipped.freshSessions += 1;
        continue;
      }

      // Reclaim requires BOTH the on-disk signal and the central-DB row (when
      // one exists) to agree the session has been quiet; an unreadable central
      // DB disables reclaim entirely (fail closed) while the ordinary cache
      // pruning below continues to work.
      const row = centralSessionRow(sessionId);
      if (row === 'unavailable' || row?.status === 'archiving') {
        cacheOnly.push({ groupName: groupDirent.name, sessionId, sessPath });
        continue;
      }
      const dbActivityMs = row ? parseSqliteUtc(row.last_activity ?? '') : NaN;
      const newestActivity = Number.isFinite(dbActivityMs) ? Math.max(lastActivity, dbActivityMs) : lastActivity;
      candidates.push({
        groupName: groupDirent.name,
        sessionId,
        sessPath,
        sessionStatus: row === null ? 'orphan' : row.status === 'closed' ? 'closed' : 'active',
        newestActivityMs: newestActivity,
        ageEligible: args.now - newestActivity >= args.policy.sessionReclaimMs,
      });
    }
  }

  // Pass 2: bounded, oldest-first selection; everything not selected falls
  // through to ordinary cache pruning as it always did.
  const { selected, deferred } = selectSessionsToArchive(candidates, args.policy);
  args.skipped.budgetDeferredSessions += deferred;

  for (const candidate of candidates) {
    if (!selected.has(candidate.sessPath)) {
      cacheOnly.push(candidate);
      continue;
    }
    actions.push(
      createArchiveSessionAction({
        id: `session-reclaim:${candidate.groupName}:${candidate.sessionId}`,
        sessionId: candidate.sessionId,
        agentGroupId: candidate.groupName,
        sessionStatus: candidate.sessionStatus,
        sessPath: candidate.sessPath,
        sessionsRoot: args.root,
        rescuesDir,
        estimatedBytes: dirSizeBytes(candidate.sessPath),
        reason: `session ${candidate.sessionStatus === 'active' ? 'idle' : candidate.sessionStatus} for at least ${Math.round(args.policy.sessionReclaimMs / 86400000)}d — archived to ${SESSION_RESCUES_DIRNAME}/ then reclaimed`,
        collectedActivityMs: sessionLastActivityMs(candidate.sessPath),
        isContainerRunning: args.isContainerRunning,
      }),
    );
  }

  for (const { groupName, sessionId, sessPath } of cacheOnly) {
    for (const target of findPrunableArtifactDirs(sessPath)) {
      const estimatedBytes = dirSizeBytes(target);
      actions.push(
        createDeleteArtifactAction({
          id: `session-cache:${groupName}:${sessionId}:${path.relative(sessPath, target)}`,
          pool: 'session-cache',
          target,
          root: sessPath,
          estimatedBytes,
          reason: `session has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`,
          targetType: 'directory',
          safety: 'Regenerable cache directory under an idle NanoClaw-owned session subtree.',
        }),
      );
    }

    // This exact path is intentionally separate from findPrunableArtifactDirs:
    // a generic "plugins" directory could be source content, while this one
    // is Codex's session-local cache and is recreated on every spawn.
    const codexPluginCache = path.join(sessPath, 'codex', 'plugins');
    if (isRealDirectory(codexPluginCache)) {
      actions.push(
        createDeleteArtifactAction({
          id: `session-cache:${groupName}:${sessionId}:codex/plugins`,
          pool: 'session-cache',
          target: codexPluginCache,
          root: sessPath,
          estimatedBytes: dirSizeBytes(codexPluginCache),
          reason: `session has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`,
          targetType: 'directory',
          safety: 'Codex session plugin cache only; recreated from mounted /workspace/plugins on container spawn.',
        }),
      );
    }

    const projectionReason = `session has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`;
    const archiveProjection = path.join(sessPath, 'archive.db');
    const archiveProjectionBytes = regularFileSize(archiveProjection);
    if (archiveProjectionBytes !== null) {
      if (args.projectionSources.archiveReady) {
        actions.push(
          createDeleteArtifactAction({
            id: `session-projection:${groupName}:${sessionId}:archive.db`,
            pool: 'session-cache',
            target: archiveProjection,
            root: sessPath,
            estimatedBytes: archiveProjectionBytes,
            reason: projectionReason,
            targetType: 'file',
            safety:
              'Per-session archive projection only; rebuilt from the readable canonical data/archive.db on container spawn.',
            canApply: () => isReadableSqliteDatabase(canonicalArchive, 'messages_archive'),
          }),
        );
      } else if (!warnedArchiveSourceUnavailable) {
        args.warnings.push(
          'session archive projections retained: canonical data/archive.db is unavailable or unreadable',
        );
        warnedArchiveSourceUnavailable = true;
      }
    }

    const centralProjection = path.join(sessPath, 'central.db');
    const centralProjectionBytes = regularFileSize(centralProjection);
    if (centralProjectionBytes !== null) {
      if (args.projectionSources.centralReady) {
        actions.push(
          createDeleteArtifactAction({
            id: `session-projection:${groupName}:${sessionId}:central.db`,
            pool: 'session-cache',
            target: centralProjection,
            root: sessPath,
            estimatedBytes: centralProjectionBytes,
            reason: projectionReason,
            targetType: 'file',
            safety:
              'Per-session central projection only; rebuilt from the readable canonical data/v2.db on container spawn.',
            canApply: () => isReadableSqliteDatabase(canonicalCentral),
          }),
        );
      } else if (!warnedCentralSourceUnavailable) {
        args.warnings.push('session central projections retained: canonical data/v2.db is unavailable or unreadable');
        warnedCentralSourceUnavailable = true;
      }
    }
  }

  return actions;
}

/**
 * Enumerate thread dirs across BOTH on-disk layouts:
 *   flat:   <root>/<threadKey>/worktrees
 *   nested: <root>/wg-<workgroup>/<threadKey>/worktrees   (shared-FS rework)
 * The pre-rework collector only looked at the flat layout, which made the
 * entire nested population invisible to cleanup (observed live: 47GB of
 * never-reclaimed checkouts, oldest 3 months).
 */
function* threadDirs(root: string): Generator<{ threadDir: string; label: string }> {
  for (const dirent of safeReaddirDirents(root)) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    const direct = path.join(root, dirent.name);
    if (fs.existsSync(path.join(direct, 'worktrees'))) {
      yield { threadDir: direct, label: dirent.name };
      continue;
    }
    for (const nested of safeReaddirDirents(direct)) {
      if (!nested.isDirectory() || nested.isSymbolicLink()) continue;
      const nestedDir = path.join(direct, nested.name);
      if (fs.existsSync(path.join(nestedDir, 'worktrees'))) {
        yield { threadDir: nestedDir, label: `${dirent.name}/${nested.name}` };
      }
    }
  }
}

/**
 * Archive-then-reclaim one whole thread dir: tar (zstd) the checkout minus
 * regenerable trees into <dataRoot>/thread-rescues/, verify the archive is a
 * non-empty file, and only then remove the thread dir. Any tar failure keeps
 * the dir untouched — the archive is the license to delete.
 */
function createArchiveThreadWorktreeAction(args: {
  id: string;
  threadDir: string;
  threadsRoot: string;
  rescuesDir: string;
  estimatedBytes: number;
  reason: string;
}): StorageAction {
  return {
    id: args.id,
    pool: 'thread-cache',
    kind: 'archive-thread-worktree',
    path: args.threadDir,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety:
      'Whole idle thread dir; source and untracked files preserved in a zstd rescue archive before removal. Regenerable trees (node_modules, build caches) excluded from the archive.',
    status: 'planned',
    apply: () => {
      return tryRunWithStorageCleanupClaim(args.threadDir, () => {
        if (!isPathInside(args.threadsRoot, args.threadDir)) {
          throw new Error(`refusing to archive path outside threads root: ${args.threadDir}`);
        }
        const st = fs.lstatSync(args.threadDir);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          throw new Error(`refusing to archive non-directory or symlink: ${args.threadDir}`);
        }
        fs.mkdirSync(args.rescuesDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archiveName = `${args.threadDir.slice(args.threadsRoot.length + 1).replace(/[/\\]/g, '__')}-${stamp}.tar.zst`;
        const archivePath = path.join(args.rescuesDir, archiveName);
        execFileSync(
          'tar',
          [
            '-I',
            'zstd -T0',
            ...ARCHIVE_EXCLUDED_DIR_NAMES.map((name) => `--exclude=${name}`),
            '-cf',
            archivePath,
            '-C',
            path.dirname(args.threadDir),
            path.basename(args.threadDir),
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000 },
        );
        const archiveSt = fs.statSync(archivePath);
        if (!archiveSt.isFile() || archiveSt.size === 0) {
          throw new Error(`rescue archive missing or empty: ${archivePath}`);
        }
        fs.rmSync(args.threadDir, { recursive: true, force: true });
      });
    },
  };
}

function collectThreadCacheActions(args: {
  now: number;
  root: string;
  policy: StoragePolicy;
  activityByWorktreeDir: Map<string, ThreadWorktreeActivity>;
  skipped: StorageReport['skipped'];
}): StorageAction[] {
  const actions: StorageAction[] = [];
  const rescuesDir = path.join(path.dirname(args.root), THREAD_RESCUES_DIRNAME);
  for (const { threadDir, label } of threadDirs(args.root)) {
    const worktreeDir = path.join(threadDir, 'worktrees');
    let st: fs.Stats;
    try {
      st = fs.statSync(worktreeDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const activity = args.activityByWorktreeDir.get(worktreeDir);
    if (activity?.hasRunningContainer) {
      args.skipped.liveThreads += 1;
      continue;
    }
    if (activity?.hasBusySession) {
      args.skipped.busySessions += 1;
      continue;
    }

    const lastActivity = activity?.lastActivityMs || st.mtimeMs;
    if (lastActivity === 0) continue;
    if (args.now - lastActivity < args.policy.idleArtifactMs) {
      args.skipped.freshThreads += 1;
      continue;
    }

    // Long-idle: archive the whole thread dir and reclaim it. Emitting this
    // INSTEAD of per-cache deletes — the removal covers the caches anyway.
    if (args.now - lastActivity >= args.policy.worktreeReclaimMs) {
      actions.push(
        createArchiveThreadWorktreeAction({
          id: `thread-worktree:${label}`,
          threadDir,
          threadsRoot: args.root,
          rescuesDir,
          estimatedBytes: dirSizeBytes(threadDir),
          reason: `thread worktree idle for at least ${Math.round(args.policy.worktreeReclaimMs / 86400000)}d — archived to ${THREAD_RESCUES_DIRNAME}/ then reclaimed`,
        }),
      );
      continue;
    }

    for (const target of findPrunableArtifactDirs(worktreeDir)) {
      const estimatedBytes = dirSizeBytes(target);
      actions.push(
        createDeleteArtifactAction({
          id: `thread-cache:${label}:${path.relative(worktreeDir, target)}`,
          pool: 'thread-cache',
          target,
          root: worktreeDir,
          estimatedBytes,
          reason: `thread worktree has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`,
          targetType: 'directory',
          safety: 'Regenerable cache directory under an idle NanoClaw-owned thread worktree subtree.',
        }),
      );
    }
  }
  return actions;
}

function dockerRootDir(): string {
  const output = execFileSync(CONTAINER_RUNTIME_BIN, ['info', '--format', '{{.DockerRootDir}}'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return output.trim() || '/';
}

function parseDockerSizeBytes(text: string | undefined): number {
  if (!text) return 0;
  const match = text.trim().match(/^([0-9.]+)\s*([KMGTPE]?B)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = match[2]!.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
    PB: 1000 ** 5,
    EB: 1000 ** 6,
  };
  return Math.round(amount * (multipliers[unit] ?? 1));
}

function dockerReclaimableBytes(): Partial<Record<'Images' | 'Containers' | 'Build Cache', number>> {
  const output = execFileSync(CONTAINER_RUNTIME_BIN, ['system', 'df', '--format', '{{json .}}'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  const result: Partial<Record<'Images' | 'Containers' | 'Build Cache', number>> = {};
  for (const line of output.trim().split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { Type?: string; Reclaimable?: string };
      if (row.Type === 'Images' || row.Type === 'Containers' || row.Type === 'Build Cache') {
        result[row.Type] = parseDockerSizeBytes(row.Reclaimable);
      }
    } catch {
      // Ignore unknown Docker output lines.
    }
  }
  return result;
}

function createDockerAction(args: {
  id: string;
  kind: Exclude<
    StorageActionKind,
    'delete-cache-dir' | 'delete-derived-file' | 'archive-thread-worktree' | 'archive-session'
  >;
  dockerArgs: string[];
  estimatedBytes: number;
  reason: string;
  safety: string;
  apply?: () => void | boolean;
}): StorageAction {
  return {
    id: args.id,
    pool: 'docker',
    kind: args.kind,
    dockerArgs: args.dockerArgs,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety: args.safety,
    status: 'planned',
    apply:
      args.apply ??
      (() => {
        execFileSync(CONTAINER_RUNTIME_BIN, args.dockerArgs, {
          stdio: 'pipe',
          timeout: 120_000,
        });
      }),
  };
}

interface DockerContainerInventory {
  id: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
}

interface DockerInventory {
  containers: DockerContainerInventory[];
  images: DockerImageInventory[];
}

function dockerOutput(args: string[], timeout = 30_000): string {
  return execFileSync(CONTAINER_RUNTIME_BIN, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
  });
}

function nonEmptyLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function inspectDockerContainers(ids?: string[]): DockerContainerInventory[] {
  const selectedIds = [...new Set(ids ?? nonEmptyLines(dockerOutput(['container', 'ls', '-a', '-q', '--no-trunc'])))];
  if (selectedIds.length === 0) return [];
  const rows = JSON.parse(dockerOutput(['container', 'inspect', ...selectedIds])) as Array<{
    Id?: string;
    Image?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> | null };
  }>;
  return rows
    .filter((row): row is typeof row & { Id: string } => typeof row.Id === 'string' && row.Id.length > 0)
    .map((row) => ({
      id: row.Id,
      imageId: row.Image ?? '',
      running: row.State?.Running === true,
      labels: row.Config?.Labels ?? {},
    }));
}

function inspectDockerImages(ids?: string[]): DockerImageInventory[] {
  const selectedIds = [...new Set(ids ?? nonEmptyLines(dockerOutput(['image', 'ls', '-a', '-q', '--no-trunc'])))];
  if (selectedIds.length === 0) return [];
  const rows = JSON.parse(dockerOutput(['image', 'inspect', ...selectedIds])) as Array<{
    Id?: string;
    RepoTags?: string[] | null;
    RepoDigests?: string[] | null;
    Created?: string;
    Size?: number;
    Config?: { Labels?: Record<string, string> | null };
  }>;
  return rows
    .filter((row): row is typeof row & { Id: string } => typeof row.Id === 'string' && row.Id.length > 0)
    .map((row) => ({
      id: row.Id,
      repoTags: Array.isArray(row.RepoTags) ? row.RepoTags : [],
      repoDigests: Array.isArray(row.RepoDigests) ? row.RepoDigests : [],
      createdAt: row.Created ?? '',
      sizeBytes: Number.isFinite(row.Size) ? Math.max(0, Number(row.Size)) : 0,
      labels: row.Config?.Labels ?? {},
    }));
}

function readDockerInventory(): DockerInventory {
  return { containers: inspectDockerContainers(), images: inspectDockerImages() };
}

function configuredImageProtection(): { images: Set<string>; readable: boolean } {
  try {
    return {
      images: new Set(
        getAllContainerConfigs()
          .map((config) => config.image_tag?.trim())
          .filter((tag): tag is string => Boolean(tag)),
      ),
      readable: true,
    };
  } catch (err) {
    log.warn('storage-manager: failed to read configured image tags; image deletion disabled', { err });
    return { images: new Set(), readable: false };
  }
}

function classifyDockerInventory(
  inventory: DockerInventory,
  policy: StoragePolicy,
  now: number,
): DockerImageDispositionReport[] {
  const configured = configuredImageProtection();
  const containerImageIds = new Set(inventory.containers.map((container) => container.imageId).filter(Boolean));
  return inventory.images.map((image) =>
    classifyDockerImage(image, {
      now,
      canonicalImage: CONTAINER_IMAGE,
      configuredImages: configured.images,
      containerImageIds,
      candidateRetentionHours: policy.candidateRetentionHours,
      legacyGraceHours: policy.legacyImageGraceHours,
      configurationReadable: configured.readable,
    }),
  );
}

function installLabelParts(): { key: string; value: string } {
  const equals = CONTAINER_INSTALL_LABEL.indexOf('=');
  return {
    key: equals === -1 ? CONTAINER_INSTALL_LABEL : CONTAINER_INSTALL_LABEL.slice(0, equals),
    value: equals === -1 ? '' : CONTAINER_INSTALL_LABEL.slice(equals + 1),
  };
}

function usageAtOrBelowTarget(policy: StoragePolicy): boolean {
  const usage = getFilesystemUsage(policy.filesystemPath);
  return usage !== null && usage.usagePct <= policy.cleanupTargetPct;
}

function builderSupportsMinFreeSpace(): boolean {
  try {
    return dockerOutput(['builder', 'prune', '--help'], 10_000).includes('--min-free-space');
  } catch {
    return false;
  }
}

function collectDockerActions(
  policy: StoragePolicy,
  now: number,
  mode: StorageMode,
  warnings: string[],
  usageBefore: FilesystemUsage | null,
  force: boolean,
): { actions: StorageAction[]; images: DockerImageDispositionReport[] } {
  let dockerRoot: string;
  try {
    dockerRoot = dockerRootDir();
  } catch (err) {
    warnings.push(`docker info failed: ${err instanceof Error ? err.message : String(err)}`);
    return { actions: [], images: [] };
  }

  const dockerUsage = getFilesystemUsage(dockerRoot);
  if (!dockerUsage) {
    warnings.push(`df failed for Docker root ${dockerRoot}`);
    return { actions: [], images: [] };
  }

  const pressurePct = usageBefore?.usagePct ?? dockerUsage.usagePct;
  const critical = pressurePct >= policy.admissionRefusePct;
  if (mode === 'apply' && !force) {
    if (critical && lastEmergencyDockerAttemptMs > 0 && now - lastEmergencyDockerAttemptMs < policy.emergencyRetryMs) {
      warnings.push('docker cleanup skipped by emergency retry throttle');
      return { actions: [], images: [] };
    }
    if (!critical && lastDockerPruneAttemptMs > 0 && now - lastDockerPruneAttemptMs < policy.dockerPruneCadenceMs) {
      warnings.push('docker cleanup skipped by cadence throttle');
      return { actions: [], images: [] };
    }
  }
  if (mode === 'apply' && critical) lastEmergencyDockerAttemptMs = now;

  let inventory: DockerInventory;
  try {
    inventory = readDockerInventory();
  } catch (err) {
    warnings.push(`docker inventory failed: ${err instanceof Error ? err.message : String(err)}`);
    return { actions: [], images: [] };
  }
  const imageDispositions = classifyDockerInventory(inventory, policy, now);

  let estimates: Partial<Record<'Images' | 'Containers' | 'Build Cache', number>> = {};
  try {
    estimates = dockerReclaimableBytes();
  } catch (err) {
    warnings.push(`docker system df failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actions: StorageAction[] = [];
  const thresholdReason = `filesystem usage is ${pressurePct}% (threshold ${policy.cleanupThresholdPct}%, target ${policy.cleanupTargetPct}%)`;
  if (pressurePct >= policy.cleanupThresholdPct) {
    const installLabel = installLabelParts();
    for (const container of inventory.containers) {
      if (container.running || container.labels[installLabel.key] !== installLabel.value) continue;
      const dockerArgs = ['container', 'rm', container.id];
      actions.push(
        createDockerAction({
          id: `docker:container:${container.id}`,
          kind: 'docker-prune-containers',
          dockerArgs,
          estimatedBytes: 0,
          reason: thresholdReason,
          safety: 'Exact non-forced removal of a stopped container carrying this install label.',
          apply: () => {
            let current: DockerContainerInventory[];
            try {
              current = inspectDockerContainers([container.id]);
            } catch {
              return false;
            }
            const target = current[0];
            if (!target || target.running || target.labels[installLabel.key] !== installLabel.value) return false;
            execFileSync(CONTAINER_RUNTIME_BIN, dockerArgs, { stdio: 'pipe', timeout: 120_000 });
            return true;
          },
        }),
      );
    }
  }

  actions.push(
    createDockerAction({
      id: 'docker:builder-cache:unused-for',
      kind: 'docker-prune-builder-cache',
      dockerArgs: ['builder', 'prune', '-a', '-f', '--filter', `until=${policy.dockerBuildCacheUnusedFor}`],
      estimatedBytes: estimates['Build Cache'] ?? 0,
      reason: `BuildKit cache unused for ${policy.dockerBuildCacheUnusedFor} is pruned on cadence; ${thresholdReason}`,
      safety: 'Docker removes only BuildKit cache records unused for at least the configured age window.',
    }),
  );

  if (critical) {
    if (builderSupportsMinFreeSpace()) {
      const targetAvailableBytes = Math.ceil(
        ((100 - policy.cleanupTargetPct) / 100) * (usageBefore?.sizeBytes ?? dockerUsage.sizeBytes),
      );
      const dockerArgs = ['builder', 'prune', '-a', '-f', '--min-free-space', `${targetAvailableBytes}B`];
      actions.push(
        createDockerAction({
          id: 'docker:builder-cache:min-free-space',
          kind: 'docker-prune-builder-cache',
          dockerArgs,
          estimatedBytes: 0,
          reason: `critical pressure requires bounded BuildKit reclamation toward ${policy.cleanupTargetPct}%`,
          safety: 'Uses Docker BuildKit min-free-space; it does not remove named images or containers.',
          apply: () => {
            if (usageAtOrBelowTarget(policy)) return false;
            execFileSync(CONTAINER_RUNTIME_BIN, dockerArgs, { stdio: 'pipe', timeout: 120_000 });
            return true;
          },
        }),
      );
    } else {
      warnings.push('Docker builder does not support --min-free-space; aggressive BuildKit cleanup skipped');
    }
  }

  if (pressurePct >= policy.cleanupThresholdPct) {
    const eligible = imageDispositions
      .filter((image) => image.disposition === 'eligible')
      .sort((a, b) => {
        const aCreated = Date.parse(a.createdAt);
        const bCreated = Date.parse(b.createdAt);
        return (
          (Number.isFinite(aCreated) ? aCreated : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(bCreated) ? bCreated : Number.MAX_SAFE_INTEGER)
        );
      });
    for (const image of eligible) {
      const dockerArgs = ['image', 'rm', image.id];
      actions.push(
        createDockerAction({
          id: `docker:image:${image.id}`,
          kind: 'docker-prune-images',
          dockerArgs,
          estimatedBytes: image.sizeBytes,
          reason: thresholdReason,
          safety: 'Exact non-forced removal after immediate protection and reference revalidation.',
          apply: () => {
            if (usageAtOrBelowTarget(policy)) return false;
            let currentInventory: DockerInventory;
            try {
              currentInventory = readDockerInventory();
            } catch {
              return false;
            }
            const current = classifyDockerInventory(currentInventory, policy, Date.now()).find(
              (candidate) => candidate.id === image.id,
            );
            if (!current || current.disposition !== 'eligible') return false;
            execFileSync(CONTAINER_RUNTIME_BIN, dockerArgs, { stdio: 'pipe', timeout: 120_000 });
            return true;
          },
        }),
      );
    }
  }
  return { actions, images: imageDispositions };
}

function summarize(actions: StorageActionReport[]): StorageReport['pools'] {
  const pools: StorageReport['pools'] = {
    'session-cache': { actions: 0, estimatedBytes: 0 },
    'thread-cache': { actions: 0, estimatedBytes: 0 },
    docker: { actions: 0, estimatedBytes: 0 },
  };
  for (const action of actions) {
    pools[action.pool].actions += 1;
    pools[action.pool].estimatedBytes += action.estimatedBytes;
  }
  return pools;
}

function withoutApply(action: StorageAction): StorageActionReport {
  const { apply: _apply, ...report } = action;
  return report;
}

function emptySkipped(): StorageReport['skipped'] {
  return {
    liveSessions: 0,
    liveThreads: 0,
    busySessions: 0,
    freshSessions: 0,
    freshThreads: 0,
    unreadableSessions: 0,
    noActivitySessions: 0,
    budgetDeferredSessions: 0,
  };
}

function summarizeImages(dispositions: DockerImageDispositionReport[]): StorageReport['images'] {
  const protectedImages = dispositions.filter((image) => image.disposition === 'protected');
  const eligibleImages = dispositions.filter((image) => image.disposition === 'eligible');
  return {
    dispositions,
    protectedCount: protectedImages.length,
    protectedBytes: protectedImages.reduce((sum, image) => sum + image.sizeBytes, 0),
    eligibleCount: eligibleImages.length,
    eligibleBytes: eligibleImages.reduce((sum, image) => sum + image.sizeBytes, 0),
  };
}

function pressureReport(usage: FilesystemUsage | null, policy: StoragePolicy): StorageReport['pressure'] {
  const level =
    usage === null
      ? 'unknown'
      : usage.usagePct >= policy.admissionRefusePct
        ? 'critical'
        : usage.usagePct >= policy.cleanupThresholdPct
          ? 'cleanup'
          : 'normal';
  return {
    level,
    cleanupTargetPct: policy.cleanupTargetPct,
    targetReached: usage !== null && usage.usagePct <= policy.cleanupTargetPct,
    nextEmergencyRetryAt:
      level === 'critical' && lastEmergencyDockerAttemptMs > 0
        ? new Date(lastEmergencyDockerAttemptMs + policy.emergencyRetryMs).toISOString()
        : null,
  };
}

/** Build a cheap report from a filesystem probe without inventorying caches or Docker. */
export function createStorageStatusReport(
  policy: StoragePolicy,
  usage: FilesystemUsage | null,
  now = Date.now(),
  warnings: string[] = [],
): StorageReport {
  return {
    timestamp: new Date(now).toISOString(),
    mode: 'dry-run',
    policy,
    filesystem: { before: usage, after: usage, actualReclaimedBytes: 0 },
    estimatedReclaimableBytes: 0,
    pressure: pressureReport(usage, policy),
    images: summarizeImages([]),
    actions: [],
    pools: summarize([]),
    skipped: emptySkipped(),
    warnings,
  };
}

export function getStorageReport(options: StorageReportOptions = {}): StorageReport {
  // The whole pass — collection AND apply — is one reclaim pass. Anything that
  // re-enters storage maintenance while this is open draws from the same
  // budget instead of opening a second one.
  const passPolicy = resolveStoragePolicy(options.policy);
  beginReclaimPass(passPolicy.sessionReclaimPerTick);
  try {
    return runStorageReportPass(options, passPolicy);
  } finally {
    endReclaimPass();
  }
}

function runStorageReportPass(options: StorageReportOptions, policy: StoragePolicy): StorageReport {
  const mode = options.mode ?? 'dry-run';
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  const usageBefore = getFilesystemUsage(policy.filesystemPath);
  const skipped = emptySkipped();
  const sessionsRoot = options.sessionsRoot ?? sessionsBaseDir();
  const threadsRoot = options.threadsRoot ?? threadsBaseDir();
  const isContainerRunning = options.isContainerRunning ?? (() => false);
  const includeDocker = options.includeDocker ?? true;

  if (!policy.enabled) {
    return {
      timestamp: new Date(now).toISOString(),
      mode,
      policy,
      filesystem: { before: usageBefore, after: usageBefore, actualReclaimedBytes: 0 },
      estimatedReclaimableBytes: 0,
      pressure: pressureReport(usageBefore, policy),
      images: summarizeImages([]),
      actions: [],
      pools: summarize([]),
      skipped,
      warnings: ['storage manager disabled by NANOCLAW_STORAGE_MANAGER_ENABLED=0'],
    };
  }

  const criticalPressure = usageBefore !== null && usageBefore.usagePct >= policy.admissionRefusePct;
  const cadenceActive =
    options.respectCadence === true &&
    !options.force &&
    !criticalPressure &&
    lastStorageMaintenanceMs > 0 &&
    now - lastStorageMaintenanceMs < policy.scanCadenceMs;

  if (cadenceActive) {
    return {
      timestamp: new Date(now).toISOString(),
      mode,
      policy,
      filesystem: { before: usageBefore, after: usageBefore, actualReclaimedBytes: 0 },
      estimatedReclaimableBytes: 0,
      pressure: pressureReport(usageBefore, policy),
      images: summarizeImages([]),
      actions: [],
      pools: summarize([]),
      skipped,
      warnings: ['expensive storage scan skipped by cadence throttle'],
    };
  }

  const dockerCollection = includeDocker
    ? collectDockerActions(policy, now, mode, warnings, usageBefore, options.force === true)
    : { actions: [], images: [] };
  const actions: StorageAction[] = [
    ...collectSessionCacheActions({
      now,
      root: sessionsRoot,
      policy,
      isContainerRunning,
      skipped,
      projectionSources: sessionProjectionSources(sessionsRoot),
      warnings,
    }),
    ...collectThreadCacheActions({
      now,
      root: threadsRoot,
      policy,
      activityByWorktreeDir: fs.existsSync(threadsRoot) ? collectThreadWorktreeActivity(isContainerRunning) : new Map(),
      skipped,
    }),
    ...dockerCollection.actions,
  ];

  lastStorageMaintenanceMs = now;

  if (mode === 'apply') {
    for (const action of actions) {
      try {
        const applied = action.apply();
        action.status = applied === false ? 'skipped' : 'applied';
      } catch (err) {
        action.status = 'failed';
        action.error = err instanceof Error ? err.message : String(err);
        log.warn('storage-manager: action failed', { action: withoutApply(action), err });
      }
    }
  }

  const usageAfter = mode === 'apply' ? getFilesystemUsage(policy.filesystemPath) : usageBefore;
  const actualReclaimedBytes =
    usageBefore && usageAfter ? Math.max(0, usageBefore.usedBytes - usageAfter.usedBytes) : 0;
  const actionReports = actions.map(withoutApply);
  if (
    mode === 'apply' &&
    (actionReports.some((action) => action.pool === 'docker' && action.status === 'applied') ||
      actualReclaimedBytes > 0)
  ) {
    lastDockerPruneAttemptMs = now;
  }

  if (mode === 'apply') {
    log.info('storage-manager: maintenance complete', {
      usageBeforePct: usageBefore?.usagePct ?? null,
      usageAfterPct: usageAfter?.usagePct ?? null,
      estimatedMb: Math.round(actionReports.reduce((sum, a) => sum + a.estimatedBytes, 0) / 1024 / 1024),
      actualMb: Math.round(actualReclaimedBytes / 1024 / 1024),
      actions: actionReports.length,
      failedActions: actionReports.filter((a) => a.status === 'failed').length,
      skippedActions: actionReports.filter((a) => a.status === 'skipped').length,
      skipped,
    });
  }

  return {
    timestamp: new Date(now).toISOString(),
    mode,
    policy,
    filesystem: { before: usageBefore, after: usageAfter, actualReclaimedBytes },
    estimatedReclaimableBytes: actionReports.reduce((sum, action) => sum + action.estimatedBytes, 0),
    pressure: pressureReport(usageAfter, policy),
    images: summarizeImages(dockerCollection.images),
    actions: actionReports,
    pools: summarize(actionReports),
    skipped,
    warnings,
  };
}

export function runStorageMaintenance(options: Omit<StorageReportOptions, 'mode'> = {}): StorageReport {
  return getStorageReport({ ...options, mode: 'apply', respectCadence: options.respectCadence ?? true });
}

export function assertStorageAdmission(options: Omit<StorageReportOptions, 'mode'> = {}): StorageAdmissionResult {
  const policy = resolveStoragePolicy(options.policy);
  const before = getFilesystemUsage(policy.filesystemPath);
  if (!policy.enabled) {
    const report = createStorageStatusReport(policy, before, options.now, [
      'storage manager disabled by NANOCLAW_STORAGE_MANAGER_ENABLED=0',
    ]);
    return { allowed: true, reason: 'disabled', report };
  }
  if (!before) {
    const report = createStorageStatusReport(policy, null, options.now, ['filesystem usage probe unavailable']);
    return { allowed: true, reason: 'usage-unavailable', report };
  }
  if (before.usagePct < policy.cleanupThresholdPct) {
    const report = createStorageStatusReport(policy, before, options.now);
    return { allowed: true, reason: 'below-threshold', report };
  }

  // respectCadence: admission fires on EVERY container spawn, so without the
  // throttle any usage in the [threshold, refuse) band turns spawn traffic
  // into full session-tree scan+apply passes (observed live: one ~40s pass
  // per spawn for hours at 85-89%). Inside the cadence window admission
  // decides from current usage alone; at >= admissionRefusePct the throttle
  // is bypassed upstream (criticalPressure), so emergency passes still scan.
  const report = getStorageReport({ ...options, policy, mode: 'apply', force: false, respectCadence: true });
  const afterPct = report.filesystem.after?.usagePct ?? before.usagePct;
  if (afterPct >= policy.admissionRefusePct) {
    return { allowed: false, reason: 'still-over-threshold', report };
  }
  return { allowed: true, reason: 'cleanup-succeeded', report };
}

export function pruneIdleSessionArtifacts(
  now: number = Date.now(),
  root: string = sessionsBaseDir(),
  isContainerRunning: (sessionId: string) => boolean = () => false,
): void {
  const report = getStorageReport({
    mode: 'apply',
    now,
    sessionsRoot: root,
    threadsRoot: path.join(root, '__no-thread-root__'),
    includeDocker: false,
    isContainerRunning,
    policy: { filesystemPath: root },
    force: true,
  });
  const removed = report.actions.filter((a) => a.pool === 'session-cache' && a.status === 'applied');
  if (removed.length > 0) {
    log.info('Pruned idle session artifacts', {
      dirsRemoved: removed.length,
      mbFreed: Math.round(removed.reduce((sum, a) => sum + a.estimatedBytes, 0) / 1024 / 1024),
      idleThresholdHours: Math.round(report.policy.idleArtifactMs / 3600000),
    });
  }
}

export function pruneIdleThreadArtifacts(
  now: number = Date.now(),
  root: string = threadsBaseDir(),
  activityByWorktreeDir: Map<string, ThreadWorktreeActivity> = new Map(),
): void {
  const policy = resolveStoragePolicy({ filesystemPath: root });
  const skipped = emptySkipped();
  const actions = collectThreadCacheActions({ now, root, policy, activityByWorktreeDir, skipped });
  let applied = 0;
  let estimated = 0;
  for (const action of actions) {
    try {
      if (action.apply() === false) continue;
      applied += 1;
      estimated += action.estimatedBytes;
    } catch (err) {
      log.warn('pruneIdleThreadArtifacts: rm failed', { path: action.path, err });
    }
  }
  if (applied > 0) {
    log.info('Pruned idle thread artifacts', {
      dirsRemoved: applied,
      mbFreed: Math.round(estimated / 1024 / 1024),
      idleThresholdHours: Math.round(policy.idleArtifactMs / 3600000),
    });
  }
}

export function _resetStorageManagerThrottleForTesting(): void {
  lastStorageMaintenanceMs = 0;
  lastDockerPruneAttemptMs = 0;
  lastEmergencyDockerAttemptMs = 0;
  reclaimPassDepth = 0;
  reclaimBudgetRemaining = 0;
  warnedInvalidKnobs.clear();
  loggedSessionReclaimConfig = false;
}
