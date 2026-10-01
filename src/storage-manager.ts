/**
 * Host storage manager. Reclaims only regenerable storage: caches and dependency trees in idle worktrees,
 * per-session projections and Codex plugin caches rebuilt on spawn, this install's stopped containers, unused
 * images and bounded builder cache. Never canonical DBs, session DBs, source checkouts, .git directories, or
 * anything attached to a live or in-flight session.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  DATA_DIR,
  GROUPS_DIR,
  INSTALL_SLUG,
} from './config.js';
import { runningContainerMounts as inspectRunningContainerMounts } from './container-mounts.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import {
  collectCacheGarbage,
  DEPENDENCY_CACHE_DIRNAME,
  DEPENDENCY_CACHE_TEMP_NAMES,
  finishDependencyCachePass,
  hasPendingConversion,
  isEligiblePackageDir,
  isFarmPackageDir,
  processPackageDir,
  recoverPackageDir,
  startDependencyCachePass,
  type DependencyCacheMode,
  type DependencyCachePass,
  type DependencyCacheReport,
  type PackageOutcome,
} from './dependency-cache.js';
import { type RawStatements, withCentralSync, withRawDb } from './db/central-lease.js';
// Every `getRawDb()` here runs in the storage worker thread, on its own connection with no host lease to join;
// the one host-side entry point, `finishInterruptedSessionArchivals`, takes the lease. Pinned by
// `src/db/raw-outside-lease.test.ts`.
import { getRawDb } from './db/connection.js';
import { CONTAINER_CONFIGS_ALL_SQL } from './db/container-configs.js';
import type { ContainerConfigRow } from './types.js';
import { log } from './log.js';
import { listTopicCheckouts, resolveRepositoryWorkUnit } from './repository-workspaces.js';
import { STORAGE_INTERNAL_ENTRY_NAMES, tryRunWithStorageCleanupClaim } from './storage-activity.js';
// The one documented exemption on the host raw-access ratchet (`src/mailbox/RATCHET.json`): the probes run in a
// worker over an injected sessions root the DATA_DIR-keyed mailbox cannot address. They are read-only, never
// provision, and answer `null` ("could not tell", fail closed). Nothing else on the host opens a session DB.
import { resolveInboundDbPath, sessionMailboxDir, sessionMailboxPath } from './modules/mailbox/index.js';
import { sessionContextPathFor, sessionsBaseDir, threadsBaseDir, threadWorktreeDir } from './session-manager.js';

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
// `docker run` creates then starts within seconds; a container still never-started after this is a failed spawn.
const STALE_CREATED_CONTAINER_MS = 60 * 60 * 1000;
/** The only env inputs that decide storage-pressure refusal; exported so host scripts report the same policy. */
export const STORAGE_ADMISSION_POLICY_ENV_KEYS = [
  'NANOCLAW_STORAGE_MANAGER_ENABLED',
  'NANOCLAW_STORAGE_CLEANUP_THRESHOLD_PCT',
  'NANOCLAW_DOCKER_PRUNE_THRESHOLD_PCT',
  'NANOCLAW_STORAGE_ADMISSION_REFUSE_PCT',
] as const;
// A thread worktree dir idle this long is tarred (minus regenerable dirs) into data/thread-rescues/ and removed.
const DEFAULT_WORKTREE_RECLAIM_DAYS = 30;
// Bounded per pass so a cohort crossing the age threshold together is not one tar+rm stampede. The directory
// scan dominates a pass's cost, so the count is sized to drain the backlog, not to save work.
const DEFAULT_SESSION_RECLAIM_PER_TICK = 500;
// The real stampede guard is wall-clock (a session tree can be 5MB or 5GB): past it, remaining archive actions
// wait for the next tick. 0 stops all archiving (test hook); it does not disable the deadline.
const DEFAULT_SESSION_RECLAIM_MAX_SECONDS = 120;
// Longer than the reclaim horizons that create archives, so a wrongly reclaimed session stays restorable well
// past the point anyone would notice it missing.
const DEFAULT_RESCUE_RETENTION_DAYS = 30;
// 0 disables the count cap. Non-zero makes the oldest-idle sessions above the cap eligible regardless of age.
const DEFAULT_SESSION_ACTIVE_CAP = 0;
const THREAD_RESCUES_DIRNAME = 'thread-rescues';
/** Append-only record of every completed archival; the restore/finish authority. */
export const SESSION_RECLAIM_JOURNAL_FILENAME = 'reclaim-journal.jsonl';
// Excluded from rescue archives only (not worth the bytes). NOT a deletion allowlist:
// `REGENERABLE_SWEEP_DIR_NAMES` authorizes removal and is deliberately narrower. Do not merge them.
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

// Idle topic dependency trees go on a much shorter clock: npm has no content store or hardlinks, so every
// install is a full copy and topics carried ~130GB of them.
const DEFAULT_REGENERABLE_SWEEP_DAYS = 2;
const TOPICS_DIRNAME = 'v2-topics';
const TOPIC_WORKTREES_DIRNAME = 'worktrees';
// May we recursively delete this from a live checkout? A wrong entry destroys the only copy, so only names
// whose contents are reconstructible from a version-controlled file belong here. Deliberately excluded: `dist`,
// `build`, `.next`, `coverage` (often tracked, may hold uncommitted output), `.cache` (means anything), and
// `.venv`/`venv` (an ad-hoc `pip install` venv is unique state; do not re-add it as "just a cache").
// `__pycache__` qualifies: PEP 3147 bytecode is not importable without its `.py`, so it is never the only copy.
const REGENERABLE_SWEEP_DIR_NAMES = new Set<string>(['node_modules', '.pnpm-store', '.turbo', '__pycache__']);

const PRUNABLE_DIR_NAMES = new Set(['node_modules', '.pnpm-store', '.turbo', '.cache']);
const SKIP_DESCEND_DIR_NAMES = new Set(['.git']);

let lastStorageMaintenanceMs = 0;
let lastDockerPruneAttemptMs = 0;
let lastEmergencyDockerAttemptMs = 0;

type StorageMode = 'dry-run' | 'apply';
type StoragePool = 'session-cache' | 'thread-cache' | 'topic-cache' | 'docker';
type StorageActionKind =
  | 'delete-cache-dir'
  | 'delete-derived-file'
  | 'archive-thread-worktree'
  | 'archive-session'
  | 'sweep-regenerable-tree'
  | 'docker-prune-containers'
  | 'docker-prune-images'
  | 'docker-prune-builder-cache';

export interface StoragePolicy {
  enabled: boolean;
  filesystemPath: string;
  cleanupThresholdPct: number;
  admissionRefusePct: number;
  idleArtifactMs: number;
  worktreeReclaimMs: number;
  /** Its own knob so sessions and thread worktrees age on different clocks; unset falls back to `worktreeReclaimMs`. */
  sessionReclaimMs: number;
  sessionReclaimPerTick: number;
  sessionReclaimMaxMs: number;
  /** Age at which a rescue archive is pruned; 0 disables rescue retention. */
  rescueRetentionMs: number;
  /** Target ceiling on active sessions; 0 disables the count cap. */
  sessionActiveCap: number;
  /**
   * Idle threshold for sweeping regenerable dependency trees out of topic worktrees. A short clock without the
   * topic GC's git proofs, because these trees can never hold work. 0 disables the sweep.
   */
  regenerableSweepMs: number;
  /**
   * `NANOCLAW_DEPENDENCY_CACHE`: `off` leaves the sweep unchanged, `report` logs decisions and mutates nothing,
   * `apply` shares eligible npm trees as verified hardlink farms. Absent means `off`.
   */
  dependencyCacheMode?: DependencyCacheMode;
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

interface StorageActionReport {
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

type DockerImageDisposition = 'protected' | 'eligible' | 'unmanaged';

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
// Not `nanoclaw-install`: containers inherit image labels, and that key marks a container as this install's spawn.
const IMAGE_INSTALL_LABEL = 'nanoclaw.image.install';

function referencesImageId(reference: string, imageId: string): boolean {
  const hex = reference.startsWith('sha256:') ? reference.slice('sha256:'.length) : reference;
  return /^[0-9a-f]+$/.test(hex) && imageId.startsWith(`sha256:${hex}`);
}

export function classifyDockerImage(
  image: DockerImageInventory,
  context: DockerImageProtectionContext,
): DockerImageDispositionReport {
  const imageReferences = [...image.repoTags, ...(image.repoDigests ?? [])];
  const isCanonical = imageReferences.includes(context.canonicalImage) || image.id === context.canonicalImage;
  const isConfigured =
    imageReferences.some((reference) => context.configuredImages.has(reference)) ||
    context.configuredImages.has(image.id) ||
    [...context.configuredImages].some((reference) => referencesImageId(reference, image.id));
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
    liveTopics: number;
    freshTopics: number;
    /** Sweep candidates refused for want of a recorded manifest beside them. */
    noManifestTrees: number;
    unreadableTopics: number;
    unreadableSessions: number;
    noActivitySessions: number;
    budgetDeferredSessions: number;
  };
  warnings: string[];
  /** Present when the dependency cache ran in this pass (flag not `off`). */
  dependencyCache?: DependencyCacheReport;
}

export interface StorageReportOptions {
  mode?: StorageMode;
  policy?: Partial<StoragePolicy>;
  now?: number;
  isContainerRunning?: (sessionId: string) => boolean;
  sessionsRoot?: string;
  threadsRoot?: string;
  topicsRoot?: string;
  runningContainerMounts?: () => string[] | null;
  groupsRoot?: string;
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
 * Integer knobs with a hard floor. An unparseable or out-of-range value falls back to the default and warns once,
 * so a typo cannot silently disable or unbound reclaim.
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

let warnedBadRegenerableSweepDays = false;

/**
 * Unset means the default; any value that is not a plain non-negative integer ("" included) DISABLES the sweep,
 * so a typo meant to turn it off never turns it on. Mirrors `topicIdleReclaimDays` in worktree-cleanup.ts.
 */
function parseRegenerableSweepDays(): number {
  const raw = process.env.NANOCLAW_REGENERABLE_SWEEP_DAYS;
  if (raw === undefined) return DEFAULT_REGENERABLE_SWEEP_DAYS;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (!warnedBadRegenerableSweepDays) {
    warnedBadRegenerableSweepDays = true;
    log.warn('storage-manager: invalid NANOCLAW_REGENERABLE_SWEEP_DAYS, disabling regenerable sweep', { value: raw });
  }
  return 0;
}

let warnedBadDependencyCacheMode = false;

/**
 * Read from `process.env` at call time inside the storage worker, which inherits main.ts's loaded `.env`, so the
 * config.ts import-time capture trap does not apply. Unset means `off`; any other invalid value is `off` with one
 * WARN.
 */
function parseDependencyCacheMode(): DependencyCacheMode {
  const raw = process.env.NANOCLAW_DEPENDENCY_CACHE;
  if (raw === undefined) return 'off';
  if (raw === 'off' || raw === 'report' || raw === 'apply') return raw;
  if (!warnedBadDependencyCacheMode) {
    warnedBadDependencyCacheMode = true;
    log.warn('storage-manager: invalid NANOCLAW_DEPENDENCY_CACHE, dependency cache off', { value: raw });
  }
  return 'off';
}

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export interface StorageAdmissionPolicy {
  enabled: boolean;
  cleanupThresholdPct: number;
  admissionRefusePct: number;
}

export function resolveStorageAdmissionPolicy(
  env: Record<string, string | undefined> = process.env,
): StorageAdmissionPolicy {
  const cleanupThresholdPct = Math.min(
    99,
    parsePositiveInt(
      env.NANOCLAW_STORAGE_CLEANUP_THRESHOLD_PCT ?? env.NANOCLAW_DOCKER_PRUNE_THRESHOLD_PCT,
      DEFAULT_CLEANUP_THRESHOLD_PCT,
    ),
  );
  return {
    enabled: env.NANOCLAW_STORAGE_MANAGER_ENABLED !== '0',
    cleanupThresholdPct,
    admissionRefusePct: Math.min(
      99,
      Math.max(
        cleanupThresholdPct,
        parsePositiveInt(env.NANOCLAW_STORAGE_ADMISSION_REFUSE_PCT, DEFAULT_ADMISSION_REFUSE_PCT),
      ),
    ),
  };
}

export function resolveStoragePolicy(overrides: Partial<StoragePolicy> = {}): StoragePolicy {
  const admissionPolicy = resolveStorageAdmissionPolicy();
  const cleanupThreshold = admissionPolicy.cleanupThresholdPct;
  const admissionRefuse = admissionPolicy.admissionRefusePct;
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
  const sessionReclaimMaxSeconds = parseSessionKnob(
    'NANOCLAW_SESSION_RECLAIM_MAX_SECONDS',
    DEFAULT_SESSION_RECLAIM_MAX_SECONDS,
    0,
  );
  const rescueRetentionDays = parseSessionKnob('NANOCLAW_RESCUE_RETENTION_DAYS', DEFAULT_RESCUE_RETENTION_DAYS, 0);

  const policy: StoragePolicy = {
    enabled: admissionPolicy.enabled,
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
    sessionReclaimMaxMs: sessionReclaimMaxSeconds * 1000,
    sessionActiveCap,
    regenerableSweepMs: parseRegenerableSweepDays() * 24 * 60 * 60 * 1000,
    dependencyCacheMode: parseDependencyCacheMode(),
    rescueRetentionMs: rescueRetentionDays * 24 * 60 * 60 * 1000,
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

function getFilesystemUsage(targetPath: string): FilesystemUsage | null {
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

/**
 * Bytes a recursive delete of `root` would actually free: only regular files with link count 1, since a
 * hardlinked file keeps its blocks. Real usage still comes from `df`.
 */
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
        } else if (st.isFile() && st.nlink === 1) {
          total += st.size;
        }
      } catch {
        // Ignore files that disappear during the scan.
      }
    }
  }
  return total;
}

function findPrunableArtifactDirs(root: string): string[] {
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

const SESSION_ACTIVITY_FILES = ['inbound.db', 'outbound.db', 'archive.db', 'central.db', '.heartbeat'] as const;

// inbound.db is excluded from both idle gates: something (unidentified; the lazy on-open schema migration is the
// leading suspect) periodically rewrites every inbound.db in the fleet within minutes, which made every session
// look fresh and stalled the reaper. This is shielding, not a cure. It is safe because the host writes
// `sessions.last_active` on the same path and `sessionHasOpenWork` refuses any unconsumed inbound row. Known hole:
// a dir whose only file is inbound.db falls back to the full reading below (conservative: it preserves). The
// pre-apply revalidation keeps the full set, where a too-new reading only aborts one action.
const SESSION_AGE_SIGNAL_FILES = SESSION_ACTIVITY_FILES.filter((name) => name !== 'inbound.db');

function sessionLastActivityMs(sessPath: string, names: readonly string[] = SESSION_ACTIVITY_FILES): number {
  let newest = 0;
  for (const name of names) {
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
 * Is this session unsafe to reclaim? `null` ("could not tell") is treated exactly like `true`. Any unconsumed
 * inbound row counts, including a future `process_after` (a monthly recurrence is real pending work), and so do
 * durable follow-up promises in outbound `session_state`.
 */
export function sessionHasOpenWork(agentGroupId: string, sessionId: string, sessPath?: string): boolean | null {
  const inbound = dbHasRows(
    // The resolver, not the legacy name: a container can plant `inbound.db-journal` beside the legacy link, and a
    // hot journal fails every read-only open, which would make the session permanently unreclaimable. The
    // resolver opens `.host/inbound.db`, whose directory the container cannot write. Same inode.
    resolveInboundDbPath(sessPath ?? sessionMailboxDir({ agentGroupId, sessionId })),
    `SELECT 1 AS found
       FROM messages_in
      WHERE status IN ('processing', 'pending')
      LIMIT 1`,
  );
  if (inbound === null || inbound) return inbound;

  const outboundPath = sessPath
    ? path.join(sessPath, 'outbound.db')
    : sessionMailboxPath({ agentGroupId, sessionId }, 'outbound');
  const claimed = dbHasRows(outboundPath, "SELECT 1 AS found FROM processing_ack WHERE status = 'processing' LIMIT 1");
  if (claimed === null || claimed) return claimed;

  // Older outbound DBs lack session_state; dbHasRows would read that as unreadable and block every legacy session.
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

function collectThreadWorktreeActivity(
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
    rows = getRawDb()
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
  pool: 'session-cache' | 'thread-cache' | 'topic-cache';
  target: string;
  root: string;
  estimatedBytes: number;
  reason: string;
  targetType: ArtifactTargetType;
  /** Overrides the kind derived from `targetType`. */
  kind?: StorageActionKind;
  safety: string;
  canApply?: () => boolean;
}): StorageAction {
  return {
    id: args.id,
    pool: args.pool,
    kind: args.kind ?? (args.targetType === 'directory' ? 'delete-cache-dir' : 'delete-derived-file'),
    path: args.target,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety: args.safety,
    status: 'planned',
    apply: () => {
      let allowed = true;
      const claimed = tryRunWithStorageCleanupClaim(args.root, () => {
        // Inside the claim, deliberately: the claim refuses while any activity lease exists (our spawns), and
        // `canApply` asking the runtime covers external containers; outside it a container can start in between.
        // HARD CONSTRAINT: the claim creates and removes a marker inside `root`, bumping its mtime, so a guard
        // reading the mtime of `root` or anything this action deletes reads our own footprint and always refuses.
        // Only facts this pass does not write may be re-proven here.
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
    // Archive projections hold conversation history: require the canonical history table, not just any SQLite file.
    archiveReady: isReadableSqliteDatabase(path.join(dataRoot, 'archive.db'), 'messages_archive'),
    // A readable source first, so cleanup never turns a source-database outage into data loss.
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

// Every production reclaim entry point lands in the single storage worker of a single-process host, so this
// module-level budget is the serializer: anything starting while a pass is open draws from the same pool. If
// reclaim ever runs in more than one process, this must become a lock file.
let reclaimPassDepth = 0;
let reclaimBudgetRemaining = 0;
let reclaimEpochStartMs = 0;
let reclaimDeadlineAt = Number.POSITIVE_INFINITY;

// A lease on a stretch of time, not a per-call allowance: a pressure bypass or force prune between hourly ticks
// draws from the open epoch instead of minting a fresh budget.
const RECLAIM_BUDGET_EPOCH_MS = 45 * 60 * 1000;

function beginReclaimPass(perTick: number, maxMs: number, now: number): void {
  if (reclaimPassDepth === 0) {
    // Real elapsed time, not the injectable logical `now`: the deadline protects a real host from a real long tar.
    reclaimDeadlineAt = Date.now() + Math.max(0, maxMs);
    if (now - reclaimEpochStartMs >= RECLAIM_BUDGET_EPOCH_MS) {
      reclaimEpochStartMs = now;
      reclaimBudgetRemaining = Math.max(0, perTick);
    }
  }
  reclaimPassDepth += 1;
}

function endReclaimPass(): void {
  reclaimPassDepth = Math.max(0, reclaimPassDepth - 1);
  if (reclaimPassDepth === 0) reclaimDeadlineAt = Number.POSITIVE_INFINITY;
}

function reclaimDeadlinePassed(): boolean {
  return Date.now() >= reclaimDeadlineAt;
}

/** Reserve up to `want` archivals from the open pass; returns what was granted. */
function takeReclaimBudget(want: number): number {
  const granted = Math.max(0, Math.min(want, reclaimBudgetRemaining));
  reclaimBudgetRemaining -= granted;
  return granted;
}

export const SESSION_RESCUES_DIRNAME = 'session-rescues';
// Secret material never enters a rescue archive: creds/ is re-materialized on every spawn.
const SESSION_ARCHIVE_EXTRA_EXCLUDES = ['creds'];
// A live session dir makes tar warn "file changed as we read it", which overflows execFileSync's 1MB default
// maxBuffer (ENOBUFS) exactly when disk pressure needs reclaim to work. Applied to every tar call below.
const TAR_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Create a tar archive, tolerating GNU tar's exit 1 ("some files were changed while being archived"), the
 * expected outcome of archiving a dir its agent may still write; `--warning=no-file-changed` mutes only the
 * message. Exit 2 or anything else throws. Content correctness is decided by the caller's `-tf` read-back and
 * size/fsync checks, not this exit code.
 */
function tarCreate(args: string[], options: Parameters<typeof execFileSync>[2]): void {
  try {
    execFileSync('tar', args, options);
  } catch (err) {
    if ((err as { status?: number }).status !== 1) throw err;
  }
}

interface CentralSessionRow {
  status: string;
  last_activity: string | null;
}

/**
 * Central-DB row for a session dir, null when the row is gone (orphan dir), or 'unavailable' when the central DB
 * cannot be read, in which case session reclaim MUST NOT run.
 */
function centralSessionRow(sessionId: string): CentralSessionRow | null | 'unavailable' {
  try {
    const row = getRawDb()
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

function fsyncDir(dirPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(dirPath, fs.constants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems refuse fsync on a directory; the rename still landed.
  } finally {
    fs.closeSync(fd);
  }
}

function appendReclaimJournal(rescuesDir: string, entry: SessionReclaimJournalEntry): void {
  fs.mkdirSync(rescuesDir, { recursive: true });
  const fd = fs.openSync(reclaimJournalPath(rescuesDir), 'a');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // The line is durable, but its directory entry may not be on first create.
  fsyncDir(rescuesDir);
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

let reclaimJournalIdCache: { path: string; key: string; ids: Set<string> } | undefined;

/**
 * True once the reclaim decided to take this session, forever after: the journal line precedes every removal,
 * lines are never deleted, and ids are never reused, so unlike `status` or file existence this is monotone.
 * INTENT, NOT COMPLETION: the line precedes the `archiving -> closed` CAS, and a lost CAS keeps the directory,
 * so a caller that must not refuse a kept session pairs this with evidence of removal (see
 * `writeSessionMessageLocked`). Cached by the journal's size (plus mtime), valid only because the journal is
 * append-only: rotating or truncating it would serve stale answers.
 */
export function sessionWasReclaimed(sessionId: string, sessionsRoot: string = sessionsBaseDir()): boolean {
  const rescuesDir = path.join(path.dirname(sessionsRoot), SESSION_RESCUES_DIRNAME);
  const journalPath = reclaimJournalPath(rescuesDir);
  let key = 'absent';
  try {
    const st = fs.statSync(journalPath);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    // No journal: nothing has ever been reclaimed under this data root.
  }
  if (reclaimJournalIdCache?.path !== journalPath || reclaimJournalIdCache.key !== key) {
    reclaimJournalIdCache = { path: journalPath, key, ids: new Set(readReclaimJournal(rescuesDir).keys()) };
  }
  return reclaimJournalIdCache.ids.has(sessionId);
}

/** Published means still listable: a truncated zstd stream is a non-empty file. */
function isPublishedArchive(archivePath: string): boolean {
  try {
    const st = fs.statSync(archivePath);
    if (!st.isFile() || st.size === 0) return false;
    execFileSync('tar', ['-I', 'zstd -T0', '-tf', archivePath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10 * 60 * 1000,
      maxBuffer: TAR_MAX_BUFFER_BYTES,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The active triple is uniquely indexed (migration 049): if a fresh session claimed it while this row was
 * 'archiving', reviving it would violate the index, so the old row closes instead.
 */
function isConstraintViolation(err: unknown): boolean {
  return (
    typeof (err as { code?: unknown })?.code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

/** `db` is the worker's own handle, or the host's `withRawDb` facade from the boot-time finisher. */
function releaseArchivingRow(db: RawStatements, sessionId: string): 'active' | 'closed' | 'failed' {
  try {
    db.prepare("UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'archiving'").run(sessionId);
    return 'active';
  } catch (err) {
    // The only expected failure: a fresh session claimed this row's active triple while it was archiving.
    if (isConstraintViolation(err)) {
      db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(sessionId);
      log.warn('storage-manager: archiving row lost its triple to a newer session, closed instead', { sessionId });
      return 'closed';
    }
    // Anything else must not become a silent close, which would hide an intact dir from every sweep forever:
    // leave it 'archiving' for the startup finisher to retry, loudly.
    log.error('storage-manager: could not release an archiving session row; left for startup recovery', {
      sessionId,
      err,
    });
    return 'failed';
  }
}

/**
 * Archive-then-reclaim one whole session dir. The next inbound for the thread creates a fresh session (only
 * 'active' rows match); history stays in data/archive.db. Ordered so no crash can lose the dir without a
 * readable archive: revalidate, CAS active->archiving, temp tar, validate, atomic publish, journal, CAS
 * archiving->closed, rm. `finishInterruptedSessionArchivals` resolves whatever a crash left behind.
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
      // Past the pass's archiving time: leave the rest for the next tick.
      if (reclaimDeadlinePassed()) return false;
      let acted = true;
      const claimed = tryRunWithStorageCleanupClaim(args.sessPath, () => {
        if (!isPathInside(args.sessionsRoot, args.sessPath)) {
          throw new Error(`refusing to archive path outside sessions root: ${args.sessPath}`);
        }
        const st = fs.lstatSync(args.sessPath);
        if (!st.isDirectory() || st.isSymbolicLink()) {
          throw new Error(`refusing to archive non-directory or symlink: ${args.sessPath}`);
        }

        // Minutes of tar work can separate collection from apply; anything that made this session live wins.
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

        // Claim the row before touching the disk; an 'unavailable' DB throws and the dir is kept.
        if (args.sessionStatus === 'active') {
          const claimedRow = getRawDb()
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
          tarCreate(
            [
              '-I',
              'zstd -T0',
              // Expected on a live tree (see tarCreate); the -tf verify decides correctness. Other warnings stay on.
              '--warning=no-file-changed',
              ...ARCHIVE_EXCLUDED_DIR_NAMES.map((name) => `--exclude=${name}`),
              ...SESSION_ARCHIVE_EXTRA_EXCLUDES.map((name) => `--exclude=${name}`),
              '-cf',
              tempPath,
              '-C',
              path.dirname(args.sessPath),
              path.basename(args.sessPath),
            ],
            { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000, maxBuffer: TAR_MAX_BUFFER_BYTES },
          );
          const archiveSt = fs.statSync(tempPath);
          if (!archiveSt.isFile() || archiveSt.size === 0) {
            throw new Error(`rescue archive missing or empty: ${tempPath}`);
          }
          // Readable, not merely present: a truncated zstd stream would still license the delete.
          execFileSync('tar', ['-I', 'zstd -T0', '-tf', tempPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60 * 60 * 1000,
            maxBuffer: TAR_MAX_BUFFER_BYTES,
          });
          // The content must be durable too, or a crash publishes an empty archive that licenses deleting the
          // only copy.
          const tempFd = fs.openSync(tempPath, fs.constants.O_RDONLY);
          try {
            fs.fsyncSync(tempFd);
          } finally {
            fs.closeSync(tempFd);
          }
          // Publish atomically: a rescue path only ever exists complete.
          fs.renameSync(tempPath, archivePath);
          fsyncDir(args.rescuesDir);
        } catch (err) {
          fs.rmSync(tempPath, { force: true });
          if (args.sessionStatus === 'active') releaseArchivingRow(getRawDb(), args.sessionId);
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
          const closed = getRawDb()
            .prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'")
            .run(args.sessionId).changes;
          // The row stopped being ours after the claim; the archive is published and journaled, but removing the
          // dir is no longer our call.
          if (closed !== 1) {
            log.error('storage-manager: archiving row changed under an archival; dir kept', {
              sessionId: args.sessionId,
              rescuePath: archivePath,
            });
            acted = false;
            return;
          }
        }
        fs.rmSync(args.sessPath, { recursive: true, force: true });
        // The runner context file is a sibling of the session directory, so removing the directory leaks it.
        fs.rmSync(sessionContextPathFor(args.sessPath), { force: true });
      });
      return claimed && acted;
    },
  };
}

/**
 * Startup finisher for archivals a host stop interrupted. Idempotent and journal-gated: a `closed` dir is removed
 * only when a journal line names a published archive for it. Runs on the host at boot, under the central lease,
 * so row reads and status flips are one synchronous block.
 */
export async function finishInterruptedSessionArchivals(sessionsRoot: string = sessionsBaseDir()): Promise<{
  released: number;
  finished: number;
  lost: number;
  failed: number;
}> {
  const rescuesDir = path.join(path.dirname(sessionsRoot), SESSION_RESCUES_DIRNAME);
  const journal = readReclaimJournal(rescuesDir);
  const result = { released: 0, finished: 0, lost: 0, failed: 0 };

  await withCentralSync(
    () =>
      withRawDb((db) => {
        let archiving: Array<{ id: string; agent_group_id: string }>;
        try {
          archiving = db
            .prepare("SELECT id, agent_group_id FROM sessions WHERE status = 'archiving'")
            .all() as typeof archiving;
        } catch (err) {
          log.warn('storage-manager: could not read interrupted archivals', { err });
          return;
        }

        for (const row of archiving) {
          const sessPath = path.join(sessionsRoot, row.agent_group_id, row.id);
          const entry = journal.get(row.id);
          // Only this module writes 'archiving', so the line names this attempt; the archive is re-listed, not trusted.
          if (entry && isPublishedArchive(entry.rescue_path)) {
            const closed = db
              .prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'")
              .run(row.id).changes;
            if (closed !== 1) {
              result.failed += 1;
              continue;
            }
            if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
            fs.rmSync(sessionContextPathFor(sessPath), { force: true });
            result.finished += 1;
            continue;
          }
          if (!fs.existsSync(sessPath)) {
            // Dir gone with no readable archive: closing the row is the only honest state, but it is data loss and
            // is reported as such.
            db.prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(row.id);
            log.error('storage-manager: session directory lost with no readable rescue archive', {
              sessionId: row.id,
              agentGroupId: row.agent_group_id,
              rescuePath: entry?.rescue_path ?? null,
            });
            result.lost += 1;
            continue;
          }
          const outcome = releaseArchivingRow(db, row.id);
          if (outcome === 'failed') result.failed += 1;
          else result.released += 1;
        }
      }),
    'finish interrupted session archivals',
  );

  // Temp archives never became a rescue path; nothing references them.
  try {
    for (const name of fs.readdirSync(rescuesDir)) {
      if (name.endsWith('.tar.zst.tmp')) fs.rmSync(path.join(rescuesDir, name), { force: true });
    }
  } catch {
    // No rescues dir yet.
  }

  // Deliberately no "closed row with a journal line: remove its dir" pass. The ordinary reclaim re-archives such an
  // orphan, and the pass would let an old journal line delete a dir an operator has since restored.
  if (result.released + result.finished + result.lost + result.failed > 0) {
    log.info('storage-manager: resolved interrupted session archivals', result);
  }
  return result;
}

interface SessionReclaimCandidate {
  groupName: string;
  sessionId: string;
  sessPath: string;
  sessionStatus: 'active' | 'closed' | 'orphan';
  newestActivityMs: number;
  ageEligible: boolean;
  /**
   * The full-list mtime reading taken with the signals this candidate was judged on. Apply refuses on any
   * difference, so it must be the decision-time value, never a later reading.
   */
  collectedActivityMs: number;
}

/** Active-row count for the count cap; null means "cannot tell" (cap disabled). */
function activeSessionCount(): number | null {
  try {
    const row = getRawDb().prepare("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'").get() as
      | { n: number }
      | undefined;
    return typeof row?.n === 'number' ? row.n : null;
  } catch {
    return null;
  }
}

/**
 * Age-eligible plus count-overflow candidates, oldest-idle first, bounded by the pass budget. Blocked sessions
 * never reach here, so they cannot consume an overflow slot; the cap is a target, not a promise.
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

  // Pass 1: selection needs the whole population (the count cap is fleet-level), so nothing is archived here.
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
      // A dir with only inbound.db has no narrowed signal; fall back to the full reading rather than "infinitely old".
      const ageSignal = sessionLastActivityMs(sessPath, SESSION_AGE_SIGNAL_FILES) || lastActivity;
      // The 24h gate reads the age signal, not the full set (see SESSION_AGE_SIGNAL_FILES); the pre-apply
      // revalidation still compares the full set.
      if (args.now - ageSignal < args.policy.idleArtifactMs) {
        args.skipped.freshSessions += 1;
        continue;
      }

      // Reclaim requires both the on-disk signal and the central row to agree; an unreadable central DB disables
      // reclaim (fail closed) while ordinary cache pruning continues.
      const row = centralSessionRow(sessionId);
      if (row === 'unavailable' || row?.status === 'archiving') {
        cacheOnly.push({ groupName: groupDirent.name, sessionId, sessPath });
        continue;
      }
      const dbActivityMs = row ? parseSqliteUtc(row.last_activity ?? '') : NaN;
      const newestActivity = Number.isFinite(dbActivityMs) ? Math.max(ageSignal, dbActivityMs) : ageSignal;
      candidates.push({
        groupName: groupDirent.name,
        sessionId,
        sessPath,
        sessionStatus: row === null ? 'orphan' : row.status === 'closed' ? 'closed' : 'active',
        newestActivityMs: newestActivity,
        ageEligible: args.now - newestActivity >= args.policy.sessionReclaimMs,
        // The full-list reading from the same instant the gates above were evaluated.
        collectedActivityMs: lastActivity,
      });
    }
  }

  // Pass 2: bounded selection; everything not selected falls through to ordinary cache pruning.
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
        collectedActivityMs: candidate.collectedActivityMs,
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

    // Separate from findPrunableArtifactDirs: a generic "plugins" dir could be source; this is Codex's per-spawn cache.
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

/** Thread dirs in both layouts: `<root>/<threadKey>/worktrees` and `<root>/wg-<workgroup>/<threadKey>/worktrees`. */
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
 * Archive-then-reclaim one whole thread dir into thread-rescues/. Any tar failure keeps the dir: the archive is
 * the license to delete.
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
        tarCreate(
          [
            '-I',
            'zstd -T0',
            // Idle-gated, not guaranteed quiet: same tolerance as the session archive (see tarCreate).
            '--warning=no-file-changed',
            ...ARCHIVE_EXCLUDED_DIR_NAMES.map((name) => `--exclude=${name}`),
            '-cf',
            archivePath,
            '-C',
            path.dirname(args.threadDir),
            path.basename(args.threadDir),
          ],
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60 * 60 * 1000, maxBuffer: TAR_MAX_BUFFER_BYTES },
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

    // Long-idle: archive the whole dir instead of per-cache deletes, which the removal covers anyway.
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

/**
 * Lockfiles that make a `node_modules` reconstructible. Reconstructibility is per instance, not per name: the same
 * `node_modules` is unique state in a checkout with no lockfile, so each candidate must show one. `.pnpm-store`
 * (content-addressed), `.turbo` (input-hashed cache) and `__pycache__` (needs its `.py`) carry their reproducer
 * structurally. A lockfile proves a recorded state, not the current tree (`--no-save` packages are lost, as in CI).
 * `bun.lockb` and `npm-shrinkwrap.json` are omitted on purpose: omission only ever preserves a tree.
 */
const NODE_MODULES_REPRODUCERS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];

function hasRecordedReproducer(parentDir: string, name: string): boolean {
  if (name !== 'node_modules') return true;
  return NODE_MODULES_REPRODUCERS.some((manifest) => fs.existsSync(path.join(parentDir, manifest)));
}

/**
 * Real regenerable directories under a topic worktree subtree. Symlinks are never returned or descended: a
 * lockfile does not record that a tree was a link, so `node_modules -> ../shared` is unique state. Dependency-cache
 * temp names are never descended either (mid-convert they hold a private tree); their package dirs are reported in
 * `recoveryDirs`.
 */
function findRegenerableTargets(root: string, recoveryDirs: string[] = []): string[] {
  const targets: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of safeReaddirDirents(dir)) {
      const full = path.join(dir, entry.name);
      if (!isPathInside(root, full)) continue;

      // Dirents carry lstat semantics, so a symlink to a directory is not isDirectory(): this covers both.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DESCEND_DIR_NAMES.has(entry.name)) continue;
      if (DEPENDENCY_CACHE_TEMP_NAMES.includes(entry.name)) {
        if (!recoveryDirs.includes(dir)) recoveryDirs.push(dir);
        continue;
      }
      if (REGENERABLE_SWEEP_DIR_NAMES.has(entry.name)) {
        // Do not descend: the whole tree goes.
        targets.push(full);
        continue;
      }
      stack.push(full);
    }
  }
  return targets;
}

/**
 * A topic's regenerable targets, walked checkout by checkout through `listTopicCheckouts`; anything the lister skips
 * is never walked. One non-checkout entry is still a target: a regenerable store directly at the worktrees root
 * (taken, never descended). `null` when the root cannot be read, so the caller counts it unreadable instead of
 * sweeping it as empty.
 */
function findTopicRegenerableTargets(worktreeRoot: string, recoveryDirs: string[]): string[] | null {
  let checkouts: ReturnType<typeof listTopicCheckouts>;
  try {
    checkouts = listTopicCheckouts(worktreeRoot);
  } catch (err) {
    log.warn('storage-manager: topic worktrees root unreadable; skipping the topic', { worktreeRoot, err });
    return null;
  }
  const rootStores = safeReaddirDirents(worktreeRoot)
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && REGENERABLE_SWEEP_DIR_NAMES.has(entry.name))
    .map((entry) => path.join(worktreeRoot, entry.name));
  return [...rootStores, ...checkouts.flatMap((checkout) => findRegenerableTargets(checkout.path, recoveryDirs))];
}

/**
 * Newest `sessions.last_active` per topic, keyed `<workgroup>/<kind>-<id>`. `null` means the central DB could not
 * be read, and the caller then sweeps nothing.
 */
function topicSessionActivity(): Map<string, number> | null {
  interface Row {
    session_id: string;
    thread_id: string | null;
    messaging_group_id: string | null;
    platform_id: string | null;
    workgroup_id: string;
    idle_since: string | null;
  }
  let rows: Row[];
  try {
    rows = getRawDb()
      .prepare(
        `SELECT s.id AS session_id, s.thread_id, s.messaging_group_id, mg.platform_id,
                COALESCE(ag.workgroup_id, ag.folder) AS workgroup_id,
                COALESCE(s.last_active, s.created_at) AS idle_since
           FROM sessions s
           JOIN agent_groups ag ON ag.id = s.agent_group_id
           LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`,
      )
      .all() as Row[];
  } catch (err) {
    log.warn('storage-manager: topic session inventory failed; skipping the regenerable sweep', { err });
    return null;
  }

  const activity = new Map<string, number>();
  for (const row of rows) {
    let key: string;
    try {
      const unit = resolveRepositoryWorkUnit({
        workgroupId: row.workgroup_id,
        sessionId: row.session_id,
        platformId: row.platform_id,
        messagingGroupId: row.messaging_group_id,
        threadId: row.thread_id,
      });
      key = `${unit.workgroupId}/${unit.kind}-${unit.id}`;
    } catch {
      // An unresolvable identity is not evidence any topic is idle: drop it.
      continue;
    }
    const ms = row.idle_since ? parseSqliteUtc(row.idle_since) : NaN;
    if (!Number.isFinite(ms)) continue;
    if (ms > (activity.get(key) ?? 0)) activity.set(key, ms);
  }
  return activity;
}

function pathsOverlap(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return isPathInside(left, right) || isPathInside(right, left);
}

/**
 * The `worktrees/` side of a topic's idle clock: the newest child mtime, excluding our own lease and cleanup-claim
 * entries. The directory's own mtime is our footprint (every spawn and applied action adds and removes an entry),
 * which pinned the clock fresh; it is only the fallback for an empty `worktrees/`.
 */
function worktreeContentMtimeMs(worktreeRoot: string, ownMtimeMs: number): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
  } catch {
    // Unreadable after the lstat that got us here: fall back rather than invent freshness or staleness.
    return ownMtimeMs;
  }

  let newest = 0;
  for (const entry of entries) {
    if (STORAGE_INTERNAL_ENTRY_NAMES.includes(entry.name)) continue;
    try {
      const mtime = fs.lstatSync(path.join(worktreeRoot, entry.name)).mtimeMs;
      if (mtime > newest) newest = mtime;
    } catch {
      // Removed under us mid-walk; it contributes nothing either way.
    }
  }
  // No non-internal children: an empty or lease-only `worktrees/`.
  return newest === 0 ? ownMtimeMs : newest;
}

/** Why a candidate was refused. Every value is a reason to KEEP the tree. */
type SweepRefusal =
  | 'worktrees-unreadable'
  | 'inventory-unreadable'
  | 'recently-active'
  | 'container-mounted'
  | 'no-recorded-reproducer';

/**
 * Scan-time eligibility for one candidate; `null` means sweepable. Scan-time only: the reproducer gate already
 * makes losing any race a wasted `npm ci`, so apply re-runs only the container-mount lookup. The mtime checks
 * cannot be re-read once the pass starts, since this sweep writes into the tree it would be reading.
 */
function sweepEligibility(args: {
  now: number;
  idleMs: number;
  topicDir: string;
  target: string;
  mounts: string[];
  sessionActivity: Map<string, number>;
}): SweepRefusal | null {
  const worktreeRoot = path.join(args.topicDir, TOPIC_WORKTREES_DIRNAME);
  let worktreeStat: fs.Stats;
  try {
    worktreeStat = fs.lstatSync(worktreeRoot);
  } catch {
    return 'worktrees-unreadable';
  }
  if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) return 'worktrees-unreadable';

  const workgroupId = path.basename(path.dirname(args.topicDir));
  const lastActivity = Math.max(
    args.sessionActivity.get(`${workgroupId}/${path.basename(args.topicDir)}`) ?? 0,
    worktreeContentMtimeMs(worktreeRoot, worktreeStat.mtimeMs),
  );
  if (args.now - lastActivity < args.idleMs) return 'recently-active';

  if (args.mounts.some((mount) => pathsOverlap(args.topicDir, mount))) return 'container-mounted';

  if (!hasRecordedReproducer(path.dirname(args.target), path.basename(args.target))) {
    return 'no-recorded-reproducer';
  }
  return null;
}

/**
 * The one condition re-proven immediately before each delete: no container mounts the topic. A failed lookup
 * refuses. Safe under the cleanup claim because it reads the runtime, not the claim root.
 */
function topicIsUnmounted(topicDir: string, lookup: () => string[] | null): boolean {
  const mounts = lookup();
  if (mounts === null) return false;
  return !mounts.some((mount) => pathsOverlap(topicDir, mount));
}

/**
 * Sweep regenerable dependency trees out of idle topic worktrees. A different safety class from the topic GC:
 * these trees can never hold work, so the cost of a mistake is an `npm ci`, which buys a short clock and no git
 * proofs. Widening `REGENERABLE_SWEEP_DIR_NAMES` breaks that argument. Idle signal: the max of the topic
 * sessions' `last_active` and `worktreeContentMtimeMs`; never the tree's own mtime (moves on install, not use) or
 * the topic dir's (a bulk parent touch freshens the fleet). Every signal must be stale before anything is swept.
 */
function collectTopicRegenerableActions(args: {
  now: number;
  mode: StorageMode;
  topicsRoot: string;
  policy: StoragePolicy;
  runningMounts: () => string[] | null;
  skipped: StorageReport['skipped'];
  warnings: string[];
  dependencyCacheOut: { report?: DependencyCacheReport };
}): StorageAction[] {
  const actions: StorageAction[] = [];
  if (args.policy.regenerableSweepMs <= 0) return actions;
  if (!fs.existsSync(args.topicsRoot)) return actions;

  // Pass-level fail-closed: an unlistable runtime hides containers and an unreadable central DB leaves no activity
  // signal. Both snapshots serve only the scan; the apply-time guard re-reads from source.
  const mounts = args.runningMounts();
  if (mounts === null) {
    args.warnings.push('regenerable sweep skipped: container runtime mounts could not be listed');
    return actions;
  }
  const sessionActivity = topicSessionActivity();
  if (sessionActivity === null) {
    args.warnings.push('regenerable sweep skipped: topic session inventory unavailable');
    return actions;
  }
  const countRefusal = (refusal: SweepRefusal): void => {
    if (refusal === 'container-mounted') args.skipped.liveTopics += 1;
    else if (refusal === 'recently-active') args.skipped.freshTopics += 1;
    else if (refusal === 'no-recorded-reproducer') args.skipped.noManifestTrees += 1;
    else args.skipped.unreadableTopics += 1;
  };

  const idleDays = Math.round(args.policy.regenerableSweepMs / 86400000);
  const cache = startTopicDependencyCache({
    now: args.now,
    mode: args.mode,
    topicsRoot: args.topicsRoot,
    policy: args.policy,
    warnings: args.warnings,
  });
  for (const workgroupEntry of safeReaddirDirents(args.topicsRoot)) {
    if (!workgroupEntry.isDirectory() || workgroupEntry.isSymbolicLink()) continue;
    const workgroupDir = path.join(args.topicsRoot, workgroupEntry.name);
    for (const topicEntry of safeReaddirDirents(workgroupDir)) {
      if (!topicEntry.isDirectory() || topicEntry.isSymbolicLink()) continue;
      const topicDir = path.join(workgroupDir, topicEntry.name);
      const worktreeRoot = path.join(topicDir, TOPIC_WORKTREES_DIRNAME);
      const key = `${workgroupEntry.name}/${topicEntry.name}`;

      const recoveryDirs: string[] = [];
      const targets = findTopicRegenerableTargets(worktreeRoot, recoveryDirs);
      if (targets === null) {
        args.skipped.unreadableTopics += 1;
        continue;
      }
      const keptByCache = cache
        ? runTopicDependencyCache({
            cache,
            workgroupId: workgroupEntry.name,
            topicDir,
            worktreeRoot,
            targets,
            recoveryDirs,
            mounts,
            runningMounts: args.runningMounts,
          })
        : new Set<string>();

      for (const target of targets) {
        // A farm is exempt from the delete: it frees nothing another workspace still holds.
        if (keptByCache.has(target)) continue;
        // A package dir mid-conversion can hold private entries: never collected; apply re-checks under the claim.
        if (hasPendingConversion(path.dirname(target))) continue;
        const refusal = sweepEligibility({
          now: args.now,
          idleMs: args.policy.regenerableSweepMs,
          topicDir,
          target,
          mounts,
          sessionActivity,
        });
        if (refusal !== null) {
          countRefusal(refusal);
          // The only per-target reason; the rest are topic-wide, so the topic is abandoned.
          if (refusal === 'no-recorded-reproducer') continue;
          break;
        }

        actions.push(
          createDeleteArtifactAction({
            id: `topic-regenerable:${key}:${path.relative(worktreeRoot, target)}`,
            pool: 'topic-cache',
            target,
            root: worktreeRoot,
            estimatedBytes: dirSizeBytes(target),
            reason: `topic worktree idle for at least ${idleDays}d — ${path.basename(target)} is regenerated from a recorded manifest`,
            targetType: 'directory',
            kind: 'sweep-regenerable-tree',
            // Re-prove the mount lookup (an agent waking in the gap) and a newly pending conversion (possibly
            // private work) under the claim; other scan decisions are covered by the reproducer gate.
            canApply: () =>
              topicIsUnmounted(topicDir, args.runningMounts) && !hasPendingConversion(path.dirname(target)),
            safety:
              'Dependency-install tree under an idle topic worktree with a recorded manifest beside it, re-proven unmounted by the container runtime immediately before deletion.',
          }),
        );
      }
    }
  }
  if (cache) {
    collectCacheGarbage(cache.pass);
    // An `off` pass with nothing to clean stays silent.
    if (!cache.cleanupOnly || cache.pass.decisions.length > 0) {
      const report = finishDependencyCachePass(cache.pass);
      args.dependencyCacheOut.report = report;
      if (report.fingerprintAvailable === false) {
        args.warnings.push('dependency cache: agent image fingerprint unavailable, adopt/convert/link skipped');
      }
    }
  }
  return actions;
}

interface TopicDependencyCache {
  pass: DependencyCachePass;
  /** Operations really run: an applying storage pass with the flag at `apply` or `off`. */
  mutate: boolean;
  /** Flag `apply`: farms and trees this pass adopts or converts skip the delete, in dry-run reports too. */
  exemptFarms: boolean;
  /** Flag `off`, applying pass: recovery and cache GC only, so a rollback never strands an interrupted conversion. */
  cleanupOnly: boolean;
}

function startTopicDependencyCache(args: {
  now: number;
  mode: StorageMode;
  topicsRoot: string;
  policy: StoragePolicy;
  warnings: string[];
}): TopicDependencyCache | null {
  const flag = args.policy.dependencyCacheMode ?? 'off';
  if (flag === 'off' && args.mode !== 'apply') return null;
  const mutate = args.mode === 'apply' && flag !== 'report';
  // The fingerprint is lazy: an `off` pass never inspects the image; without one, only recovery and GC run.
  const pass = startDependencyCachePass({
    mode: mutate ? 'apply' : 'report',
    // A sibling of v2-topics, so every link stays on one filesystem and mount.
    cacheRoot: path.join(path.dirname(args.topicsRoot), DEPENDENCY_CACHE_DIRNAME),
    now: args.now,
    reclaimableBytes: dirSizeBytes,
  });
  return { pass, mutate, exemptFarms: flag === 'apply', cleanupOnly: flag === 'off' };
}

const KEPT_BY_CACHE: ReadonlySet<PackageOutcome> = new Set<PackageOutcome>(['farm', 'adopted', 'converted']);

/**
 * One topic's dependency-cache work: recovery, then adopt or convert eligible npm trees. No idle threshold (these
 * preserve content), but the same guards as a delete: never under a live mount, and only inside the topic's
 * cleanup claim with the mount lookup re-run under it. Returns the targets the delete must skip.
 */
function runTopicDependencyCache(args: {
  cache: TopicDependencyCache;
  workgroupId: string;
  topicDir: string;
  worktreeRoot: string;
  targets: string[];
  recoveryDirs: string[];
  mounts: string[];
  runningMounts: () => string[] | null;
}): Set<string> {
  const kept = new Set<string>();
  const { pass } = args.cache;
  const npmTargets = args.cache.cleanupOnly
    ? []
    : args.targets.filter(
        (target) => path.basename(target) === 'node_modules' && isEligiblePackageDir(path.dirname(target)),
      );
  if (npmTargets.length === 0 && args.recoveryDirs.length === 0) return kept;
  if (!isRealDirectory(args.worktreeRoot)) return kept;

  if (args.mounts.some((mount) => pathsOverlap(args.topicDir, mount))) {
    // Nothing is touched under a live mount; this only measures what agents keep private.
    for (const target of npmTargets) {
      if (isFarmPackageDir(pass, args.workgroupId, path.dirname(target))) continue;
      pass.counters.privateInMountedTopics += 1;
      pass.counters.privateInMountedTopicsBytes += dirSizeBytes(target);
    }
    return kept;
  }

  const run = (): Map<string, PackageOutcome> => {
    for (const dir of args.recoveryDirs) recoverPackageDir(pass, args.workgroupId, dir);
    const outcomes = new Map<string, PackageOutcome>();
    for (const target of npmTargets) {
      outcomes.set(target, processPackageDir(pass, args.workgroupId, path.dirname(target)));
    }
    return outcomes;
  };
  const result: { outcomes?: Map<string, PackageOutcome> } = {};
  try {
    if (args.cache.mutate) {
      tryRunWithStorageCleanupClaim(args.worktreeRoot, () => {
        if (!topicIsUnmounted(args.topicDir, args.runningMounts)) return;
        result.outcomes = run();
      });
    } else {
      result.outcomes = run();
    }
  } catch (err) {
    log.warn('storage-manager: dependency cache failed for a topic', { topicDir: args.topicDir, err });
  }

  if (!args.cache.exemptFarms) return kept;
  for (const target of npmTargets) {
    const outcome = result.outcomes?.get(target);
    // No outcome means the claim or mount re-check refused and nothing ran; an existing farm is still a farm.
    const isKept = outcome
      ? KEPT_BY_CACHE.has(outcome)
      : isFarmPackageDir(pass, args.workgroupId, path.dirname(target));
    if (isKept) kept.add(target);
  }
  return kept;
}

/** Age out rescue archives (`.tar.zst` only): the reclaim journal beside them is the permanent record. */
function collectRescueRetentionActions(args: {
  now: number;
  dataRoot: string;
  policy: StoragePolicy;
}): StorageAction[] {
  const actions: StorageAction[] = [];
  if (args.policy.rescueRetentionMs <= 0) return actions;
  const retentionDays = Math.round(args.policy.rescueRetentionMs / 86400000);

  for (const [dirName, pool] of [
    [SESSION_RESCUES_DIRNAME, 'session-cache'],
    [THREAD_RESCUES_DIRNAME, 'thread-cache'],
  ] as const) {
    const dir = path.join(args.dataRoot, dirName);
    for (const entry of safeReaddirDirents(dir)) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith('.tar.zst')) continue;
      const target = path.join(dir, entry.name);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(target);
      } catch {
        continue;
      }
      if (args.now - stats.mtimeMs < args.policy.rescueRetentionMs) continue;
      actions.push(
        createDeleteArtifactAction({
          id: `rescue-retention:${dirName}:${entry.name}`,
          pool,
          target,
          root: dir,
          estimatedBytes: stats.size,
          reason: `rescue archive older than ${retentionDays}d`,
          targetType: 'file',
          safety: `Rescue archive past the ${retentionDays}d retention window; the reclaim journal keeps the permanent record of what it held.`,
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
  status: string;
  createdAt: string;
  labels: Record<string, string>;
}

interface DockerInventory {
  containers: DockerContainerInventory[];
  images: DockerImageInventory[];
}

const DOCKER_INSPECT_BATCH_SIZE = 100;
const DOCKER_INSPECT_MAX_BUFFER_BYTES = 1024 * 1024;

function dockerOutput(args: string[], timeout = 30_000): string {
  return execFileSync(CONTAINER_RUNTIME_BIN, args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
    maxBuffer: DOCKER_INSPECT_MAX_BUFFER_BYTES,
  });
}

function nonEmptyLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function dockerJsonFormat(expressions: string[]): string {
  return expressions.map((expression) => `{{json ${expression}}}`).join('\t');
}

function parseDockerProjection(output: string, fields: number, subject: string): unknown[][] {
  return nonEmptyLines(output).map((line) => {
    const values = line.split('\t');
    if (values.length !== fields) {
      throw new Error(`docker ${subject} inspect returned a malformed projected record`);
    }
    try {
      return values.map((value) => JSON.parse(value) as unknown);
    } catch (err) {
      throw new Error(`docker ${subject} inspect returned an invalid projected record`, { cause: err });
    }
  });
}

function inspectBatches(ids: string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += DOCKER_INSPECT_BATCH_SIZE) {
    batches.push(ids.slice(index, index + DOCKER_INSPECT_BATCH_SIZE));
  }
  return batches;
}

function projectedString(value: unknown, subject: string): string {
  if (typeof value !== 'string') throw new Error(`docker ${subject} inspect returned an invalid projected record`);
  return value;
}

function projectedStringArray(value: unknown, subject: string): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`docker ${subject} inspect returned an invalid projected record`);
  }
  return value;
}

function projectedLabels(values: unknown[], keys: readonly string[], subject: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < keys.length; index += 1) {
    const value = values[index];
    if (value === null) continue;
    labels[keys[index]!] = projectedString(value, subject);
  }
  return labels;
}

function projectedLabelMap(value: unknown, subject: string): Record<string, string> {
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`docker ${subject} inspect returned an invalid projected record`);
  }
  const labels: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    labels[key] = projectedString(entry, subject);
  }
  return labels;
}

function inspectDockerContainers(ids?: string[]): DockerContainerInventory[] {
  const selectedIds = [...new Set(ids ?? nonEmptyLines(dockerOutput(['container', 'ls', '-a', '-q', '--no-trunc'])))];
  if (selectedIds.length === 0) return [];
  const installLabel = installLabelParts();
  const format = dockerJsonFormat([
    '.Id',
    '.Image',
    '.State.Running',
    '.State.Status',
    '.Created',
    `(index .Config.Labels "${installLabel.key}")`,
  ]);
  return inspectBatches(selectedIds).flatMap((batch) => {
    const rows = parseDockerProjection(
      dockerOutput(['container', 'inspect', '--format', format, ...batch]),
      6,
      'container',
    );
    if (rows.length !== batch.length) throw new Error('docker container inspect omitted a projected record');
    const containers = rows.map(([id, imageId, running, status, createdAt, label]) => {
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        typeof imageId !== 'string' ||
        imageId.length === 0 ||
        typeof running !== 'boolean' ||
        typeof status !== 'string' ||
        typeof createdAt !== 'string'
      ) {
        throw new Error('docker container inspect returned an invalid projected record');
      }
      return {
        id,
        imageId,
        running,
        status,
        createdAt,
        labels: projectedLabels([label], [installLabel.key], 'container'),
      };
    });
    const returnedIds = new Set(containers.map((container) => container.id));
    if (returnedIds.size !== batch.length || batch.some((id) => !returnedIds.has(id))) {
      throw new Error('docker container inspect returned inconsistent projected records');
    }
    return containers;
  });
}

function inspectDockerImages(ids?: string[]): DockerImageInventory[] {
  const selectedIds = [...new Set(ids ?? nonEmptyLines(dockerOutput(['image', 'ls', '-a', '-q', '--no-trunc'])))];
  if (selectedIds.length === 0) return [];
  const format = dockerJsonFormat([
    '.Id',
    '.RepoTags',
    '.RepoDigests',
    // Docker's InspectResponse omits Created when the image has no timestamp.
    '(index . "Created")',
    '.Size',
    // The whole labels map, not per-key `index`, which renders absent and empty alike: absent retention metadata
    // takes the legacy grace path, an empty value stays protected. `index` also tolerates a missing Labels map.
    '(index .Config "Labels")',
  ]);
  return inspectBatches(selectedIds).flatMap((batch) => {
    const rows = parseDockerProjection(dockerOutput(['image', 'inspect', '--format', format, ...batch]), 6, 'image');
    if (rows.length !== batch.length) throw new Error('docker image inspect omitted a projected record');
    const images = rows.map((row) => {
      const [id, repoTags, repoDigests, createdAt, sizeBytes, labels] = row;
      if (typeof id !== 'string' || id.length === 0 || (createdAt !== null && typeof createdAt !== 'string')) {
        throw new Error('docker image inspect returned an invalid projected record');
      }
      return {
        id,
        repoTags: projectedStringArray(repoTags, 'image'),
        repoDigests: projectedStringArray(repoDigests, 'image'),
        createdAt: createdAt ?? '',
        sizeBytes: typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) ? Math.max(0, sizeBytes) : 0,
        labels: projectedLabelMap(labels, 'image'),
      };
    });
    const returnedIds = new Set(images.map((image) => image.id));
    if (returnedIds.size !== batch.length || batch.some((id) => !returnedIds.has(id))) {
      throw new Error('docker image inspect returned inconsistent projected records');
    }
    return images;
  });
}

function readDockerInventory(): DockerInventory {
  return { containers: inspectDockerContainers(), images: inspectDockerImages() };
}

function readUnlessAbsent<T>(read: () => T, absent: T): T {
  try {
    return read();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return absent;
    throw err;
  }
}

function containerJsonImageTags(groupsRoot: string): string[] {
  return readUnlessAbsent(() => fs.readdirSync(groupsRoot), [])
    .map((folder) =>
      readUnlessAbsent(() => fs.readFileSync(path.join(groupsRoot, folder, 'container.json'), 'utf8'), null),
    )
    .filter((text): text is string => text !== null)
    .map((text) => (JSON.parse(text) as { imageTag?: unknown }).imageTag)
    .filter((tag): tag is string => typeof tag === 'string');
}

function configuredImageProtection(groupsRoot: string): { images: Set<string>; readable: boolean } {
  try {
    return {
      images: new Set(
        [
          // Raw and synchronous on purpose: runs in the storage worker (raw-DB allowlist); re-read before `rmi`.
          ...(getRawDb().prepare(CONTAINER_CONFIGS_ALL_SQL).all() as ContainerConfigRow[]).map(
            (config) => config.image_tag,
          ),
          ...containerJsonImageTags(groupsRoot),
        ]
          .map((tag) => tag?.trim())
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
  groupsRoot: string,
): DockerImageDispositionReport[] {
  const configured = configuredImageProtection(groupsRoot);
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

function removableContainer(container: DockerContainerInventory, underPressure: boolean, now: number): boolean {
  const installLabel = installLabelParts();
  if (container.running || container.labels[installLabel.key] !== installLabel.value) return false;
  if (container.status !== 'created') return underPressure;
  const createdMs = Date.parse(container.createdAt);
  return Number.isFinite(createdMs) && now - createdMs >= STALE_CREATED_CONTAINER_MS;
}

function removableImage(image: DockerImageDispositionReport, underPressure: boolean): boolean {
  if (image.disposition !== 'eligible') return false;
  if (underPressure) return true;
  return (
    image.repoTags.length === 0 &&
    (image.repoDigests ?? []).length === 0 &&
    image.labels[IMAGE_INSTALL_LABEL] === INSTALL_SLUG
  );
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
  groupsRoot: string,
): { actions: StorageAction[]; images: DockerImageDispositionReport[] } {
  let dockerRoot: string;
  try {
    dockerRoot = dockerRootDir();
  } catch (err) {
    warnings.push(`docker info failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('storage-manager: docker cleanup collection failed; cleanup skipped', { stage: 'info', err });
    return { actions: [], images: [] };
  }

  const dockerUsage = getFilesystemUsage(dockerRoot);
  if (!dockerUsage) {
    warnings.push(`df failed for Docker root ${dockerRoot}`);
    log.warn('storage-manager: docker cleanup collection failed; cleanup skipped', {
      stage: 'filesystem-usage',
      dockerRoot,
    });
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
    log.warn('storage-manager: docker cleanup collection failed; cleanup skipped', { stage: 'inventory', err });
    return { actions: [], images: [] };
  }
  const imageDispositions = classifyDockerInventory(inventory, policy, now, groupsRoot);

  let estimates: Partial<Record<'Images' | 'Containers' | 'Build Cache', number>> = {};
  try {
    estimates = dockerReclaimableBytes();
  } catch (err) {
    warnings.push(`docker system df failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn('storage-manager: docker reclaim estimate failed; cleanup estimates unavailable', { err });
  }

  const actions: StorageAction[] = [];
  const thresholdReason = `filesystem usage is ${pressurePct}% (threshold ${policy.cleanupThresholdPct}%, target ${policy.cleanupTargetPct}%)`;
  const underPressure = pressurePct >= policy.cleanupThresholdPct;
  for (const container of inventory.containers) {
    if (!removableContainer(container, underPressure, now)) continue;
    const dockerArgs = ['container', 'rm', container.id];
    actions.push(
      createDockerAction({
        id: `docker:container:${container.id}`,
        kind: 'docker-prune-containers',
        dockerArgs,
        estimatedBytes: 0,
        reason: container.status === 'created' ? 'never-started container past the spawn window' : thresholdReason,
        safety: 'Exact non-forced removal of a stopped container carrying this install label.',
        apply: () => {
          let current: DockerContainerInventory[];
          try {
            current = inspectDockerContainers([container.id]);
          } catch (err) {
            log.warn('storage-manager: docker container revalidation failed; removal skipped', {
              containerId: container.id,
              err,
            });
            return false;
          }
          const target = current[0];
          if (!target || !removableContainer(target, underPressure, Date.now())) return false;
          execFileSync(CONTAINER_RUNTIME_BIN, dockerArgs, { stdio: 'pipe', timeout: 120_000 });
          return true;
        },
      }),
    );
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

  const removable = imageDispositions
    .filter((image) => removableImage(image, underPressure))
    .sort((a, b) => {
      const aCreated = Date.parse(a.createdAt);
      const bCreated = Date.parse(b.createdAt);
      return (
        (Number.isFinite(aCreated) ? aCreated : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(bCreated) ? bCreated : Number.MAX_SAFE_INTEGER)
      );
    });
  for (const image of removable) {
    const dockerArgs = ['image', 'rm', '--no-prune', image.id];
    actions.push(
      createDockerAction({
        id: `docker:image:${image.id}`,
        kind: 'docker-prune-images',
        dockerArgs,
        estimatedBytes: image.sizeBytes,
        reason: removableImage(image, false)
          ? "this install's superseded image: no tag or digest selects it"
          : thresholdReason,
        safety: 'Exact non-forced removal after immediate protection and reference revalidation.',
        apply: () => {
          let currentInventory: DockerInventory;
          try {
            currentInventory = readDockerInventory();
          } catch (err) {
            log.warn('storage-manager: docker image revalidation failed; removal skipped', {
              imageId: image.id,
              err,
            });
            return false;
          }
          const current = classifyDockerInventory(currentInventory, policy, Date.now(), groupsRoot).find(
            (candidate) => candidate.id === image.id,
          );
          if (!current || !removableImage(current, underPressure)) return false;
          if (!removableImage(current, false) && usageAtOrBelowTarget(policy)) return false;
          execFileSync(CONTAINER_RUNTIME_BIN, dockerArgs, { stdio: 'pipe', timeout: 120_000 });
          return true;
        },
      }),
    );
  }
  return { actions, images: imageDispositions };
}

function summarize(actions: StorageActionReport[]): StorageReport['pools'] {
  const pools: StorageReport['pools'] = {
    'session-cache': { actions: 0, estimatedBytes: 0 },
    'thread-cache': { actions: 0, estimatedBytes: 0 },
    'topic-cache': { actions: 0, estimatedBytes: 0 },
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
    liveTopics: 0,
    freshTopics: 0,
    noManifestTrees: 0,
    unreadableTopics: 0,
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
  // Collection and apply are one reclaim pass: re-entry while it is open draws from the same budget.
  const passPolicy = resolveStoragePolicy(options.policy);
  beginReclaimPass(passPolicy.sessionReclaimPerTick, passPolicy.sessionReclaimMaxMs, options.now ?? Date.now());
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
  // DATA_DIR in production; the test's own tree whenever sessionsRoot is redirected.
  const topicsRoot = options.topicsRoot ?? path.join(path.dirname(sessionsRoot), TOPICS_DIRNAME);
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
    ? collectDockerActions(
        policy,
        now,
        mode,
        warnings,
        usageBefore,
        options.force === true,
        options.groupsRoot ?? GROUPS_DIR,
      )
    : { actions: [], images: [] };
  const dependencyCacheOut: { report?: DependencyCacheReport } = {};
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
    ...collectTopicRegenerableActions({
      now,
      mode,
      topicsRoot,
      policy,
      runningMounts: options.runningContainerMounts ?? inspectRunningContainerMounts,
      skipped,
      warnings,
      dependencyCacheOut,
    }),
    ...collectRescueRetentionActions({ now, dataRoot: path.dirname(sessionsRoot), policy }),
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
      dependencyCache: dependencyCacheOut.report?.counters ?? null,
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
    ...(dependencyCacheOut.report ? { dependencyCache: dependencyCacheOut.report } : {}),
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

  // Admission fires on every spawn, so without the cadence throttle usage in [threshold, refuse) turns spawn
  // traffic into full scan+apply passes. At >= admissionRefusePct the throttle is bypassed upstream.
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
  reclaimEpochStartMs = 0;
  reclaimDeadlineAt = Number.POSITIVE_INFINITY;
  warnedInvalidKnobs.clear();
  loggedSessionReclaimConfig = false;
}
