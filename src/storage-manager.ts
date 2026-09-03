/**
 * Host storage manager.
 *
 * Reclaims only regenerable storage:
 *   - package/build caches inside idle session and thread worktrees
 *   - dependency-install trees inside idle topic worktrees (data/v2-topics)
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
import { runningContainerMounts as inspectRunningContainerMounts } from './container-mounts.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getDb } from './db/connection.js';
import { getAllContainerConfigs } from './db/container-configs.js';
import { log } from './log.js';
import { resolveRepositoryWorkUnit } from './repository-workspaces.js';
import { tryRunWithStorageCleanupClaim } from './storage-activity.js';
// The session-directory LAYOUT, not the data: this file's reclaim probes open
// their own read-only handles (they run in a worker thread over an injected
// sessions root, which the DATA_DIR-keyed mailbox cannot address), so all they
// need from the seam is where a session's two files live. `session-manager`'s
// `inboundDbPath`/`outboundDbPath` wrappers go away with PR 7.
import { sessionMailboxPath } from './modules/mailbox/index.js';
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
// Archive-then-reclaim: a thread worktree dir idle this long is tarred
// (minus regenerable dirs) into data/thread-rescues/ and then removed.
// Owner-approved policy 2026-08-05; 47GB of never-reclaimed checkouts
// (oldest from May) motivated it.
const DEFAULT_WORKTREE_RECLAIM_DAYS = 30;
// Session archival is bounded per pass. Without a cap, one cohort of sessions
// crossing the age threshold together is a single-tick tar+rm stampede (1,041
// archives on 2026-08-05 was exactly that).
//
// Measured 2026-08-19: the 50 archives of one tick applied in 10s (~0.2s each),
// while the unavoidable scan over all 6,939 session dirs cost ~15s. The count
// was sized far below what the work justified — the expensive half of a pass
// happens whether the budget is 50 or 500. Against ~250 sessions created per
// day, 50/tick × 24 hourly ticks left only 4.8x headroom and a five-day drain
// on the standing backlog; 500 makes it ~48x and under a day.
const DEFAULT_SESSION_RECLAIM_PER_TICK = 500;
// The honest stampede guard is wall-clock, not count: a session tree can be
// 5MB or 5GB, so N archives is not a bound on anything. Once this much time
// has gone into archiving in the current pass, remaining archive actions skip
// and are reconsidered next tick. 0 stops all archiving (test hook), it does
// not disable the deadline.
const DEFAULT_SESSION_RECLAIM_MAX_SECONDS = 120;
// Rescue archives were written from 2026-08-05 onward and never pruned:
// 1,152 session archives (4.6GB) plus 393 thread archives (1.8GB) by
// 2026-08-19. Retention is deliberately longer than the reclaim horizons that
// create them, so a wrongly-reclaimed session stays restorable well past the
// point anyone would notice it missing.
const DEFAULT_RESCUE_RETENTION_DAYS = 30;
// 0 disables the count cap. Non-zero makes the oldest-idle sessions above the
// cap eligible regardless of age.
const DEFAULT_SESSION_ACTIVE_CAP = 0;
export const THREAD_RESCUES_DIRNAME = 'thread-rescues';
/** Append-only record of every completed archival; the restore/finish authority. */
export const SESSION_RECLAIM_JOURNAL_FILENAME = 'reclaim-journal.jsonl';
// Regenerable trees excluded from rescue archives — pure reinstallable weight.
// NOT a deletion allowlist: skipping a tree here only declines to copy it, and
// the original stays on disk. `REGENERABLE_SWEEP_DIR_NAMES` below is the list
// that authorizes removal, and it is deliberately narrower. Do not merge them.
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

// Regenerable trees under an idle topic worktree are swept on a much shorter
// clock than anything else here. Measured 2026-09-01: one sampled topic held
// 1.5GB, 1.3GB of it node_modules, across ~547 topics — ~130GB of dependency
// trees. npm is authoritative for the repos that dominate that (13 `npm ci`
// invocations across their CI workflows), and npm has no content store and no
// hardlinks, so every install is a full copy and nothing dedupes them.
const DEFAULT_REGENERABLE_SWEEP_DAYS = 2;
const TOPICS_DIRNAME = 'v2-topics';
const TOPIC_WORKTREES_DIRNAME = 'worktrees';
// DELIBERATELY NARROWER THAN `ARCHIVE_EXCLUDED_DIR_NAMES` — do not merge the
// two lists. They answer different questions:
//
//   - the archive list answers "is it worth the bytes to tar this?" A name on
//     it is merely not worth archiving; the original stays on disk either way,
//     so a wrong entry costs nothing.
//   - THIS list answers "may we recursively delete this from a live checkout?"
//     A wrong entry destroys the only copy.
//
// So this one holds ONLY names whose contents are reconstructible from a file
// that is itself under version control. Every exclusion below is on the archive
// list and deliberately not here:
//
//   - `dist`, `build`, `.next`, `coverage` — plenty of repos track them, and an
//     agent's uncommitted output can sit in them.
//   - `.cache` — a generic name that can mean anything, which is the same
//     argument in weaker form.
//   - `.venv` (and any `venv`/`.venv*` spelling) — the tempting one, and still
//     wrong. A virtualenv is reconstructible only if a requirements.txt or
//     lockfile pins it; one grown by ad-hoc `pip install` with nothing
//     committed is unique state, and nothing here can tell the two apart
//     without the per-target git machinery this sweep exists to avoid. Do not
//     re-add it on "it's just a dependency cache" reasoning. Measured
//     2026-09-01: zero `.venv*` or `venv` directories anywhere under
//     data/v2-topics (depth 8), so it was never buying anything either.
//
// `__pycache__` survives that bar where `.venv` does not: PEP 3147 bytecode is
// not importable without its adjacent `.py`, so a `__pycache__/*.pyc` can never
// be the only copy of anything. Verified on CPython 3.12 — removing the source
// and keeping `__pycache__` raises ModuleNotFoundError rather than importing.
// Worst case for deleting it is a recompile on next import.
//
// Cost of the narrowing is close to zero: the measurement that motivated this
// sweep was node_modules at ~1.3GB of a 1.5GB topic.
const REGENERABLE_SWEEP_DIR_NAMES = new Set<string>(['node_modules', '.pnpm-store', '.turbo', '__pycache__']);

const PRUNABLE_DIR_NAMES = new Set(['node_modules', '.pnpm-store', '.turbo', '.cache']);
const SKIP_DESCEND_DIR_NAMES = new Set(['.git']);

let lastStorageMaintenanceMs = 0;
let lastDockerPruneAttemptMs = 0;
let lastEmergencyDockerAttemptMs = 0;

export type StorageMode = 'dry-run' | 'apply';
export type StoragePool = 'session-cache' | 'thread-cache' | 'topic-cache' | 'docker';
export type StorageActionKind =
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
  /** Wall-clock ceiling on the archiving portion of one maintenance pass. */
  sessionReclaimMaxMs: number;
  /** Age at which a rescue archive is pruned; 0 disables rescue retention. */
  rescueRetentionMs: number;
  /** Target ceiling on active sessions; 0 disables the count cap. */
  sessionActiveCap: number;
  /**
   * Idle threshold for sweeping regenerable dependency-install trees out of topic
   * worktrees. Its own (short) clock: unlike a whole topic dir, these trees can
   * never hold work, so they do not need the topic GC's git proofs, quarantine,
   * or CAS machinery. 0 disables the sweep.
   */
  regenerableSweepMs: number;
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
    /** Topics skipped because a running container bind-mounts them. */
    liveTopics: number;
    /** Topics skipped because they are inside the regenerable sweep's idle window. */
    freshTopics: number;
    /** Sweep candidates refused for want of a recorded manifest beside them. */
    noManifestTrees: number;
    /** Topics whose worktrees or activity inventory could not be read. */
    unreadableTopics: number;
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
  topicsRoot?: string;
  /** Injection seam for the real docker mount lookup the regenerable sweep gates on. */
  runningContainerMounts?: () => string[] | null;
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

let warnedBadRegenerableSweepDays = false;

/**
 * Idle days before regenerable trees are swept out of a topic worktree.
 *
 * UNSET (not in the environment at all) -> the deliberate default. Set to
 * anything that is not a plain non-negative integer — "" included (negative,
 * decimal, exponent notation, "abc", "NaN") -> DISABLED (0), not the default.
 * A typo meant to turn this off must never silently turn it on, so this is
 * fail-closed in the direction of doing nothing. Mirrors `topicIdleReclaimDays`
 * in worktree-cleanup.ts, which guards the same tree on the same reasoning.
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
  const sessionReclaimMaxSeconds = parseSessionKnob(
    'NANOCLAW_SESSION_RECLAIM_MAX_SECONDS',
    DEFAULT_SESSION_RECLAIM_MAX_SECONDS,
    0,
  );
  const rescueRetentionDays = parseSessionKnob('NANOCLAW_RESCUE_RETENTION_DAYS', DEFAULT_RESCUE_RETENTION_DAYS, 0);

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
    sessionReclaimMaxMs: sessionReclaimMaxSeconds * 1000,
    sessionActiveCap,
    regenerableSweepMs: parseRegenerableSweepDays() * 24 * 60 * 60 * 1000,
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

const SESSION_ACTIVITY_FILES = ['inbound.db', 'outbound.db', 'archive.db', 'central.db', '.heartbeat'] as const;

// inbound.db is excluded from both idle gates, because something rewrites
// every inbound.db in the fleet within a couple of minutes and resets the
// whole mtime clock at once: 5,027 files on 2026-08-15 20:21-20:22 UTC, and
// 2,167 of 2,404 on 2026-08-25 16:34-16:35 UTC.
//
// WHAT IS KNOWN vs WHAT IS ASSUMED. The rewrites are measured — file counts
// and timestamps are from the live tree. The WRITER IS NOT IDENTIFIED. The
// lazy on-open schema migration (`migrateMessagesInTable`) is the leading
// hypothesis and is named here because it fits the shape, but attribution was
// never confirmed, and commit dfa6e3db (2026-08-19) already added
// manifest-and-restore around the reconcile pass on that theory and the event
// still recurred on 08-25. `migrateMessagesInTable` has ~10 call sites
// (now `src/modules/mailbox/schema.ts`, reached from every open funnel) with
// no mtime bookkeeping on any of them, so the leak — whatever it is — is still
// live and can poison any future consumer of inbound.db mtime.
//
// Excluding inbound from the gates is therefore SHIELDING, not a cure. It is
// still the right shield: the host writes inbound.db and `sessions.last_active`
// in the same path, so the central row already carries every real inbound
// event, and `sessionHasOpenWork` independently refuses any session holding an
// unconsumed inbound row. The other files stay in — they are container- and
// host-written and can legitimately outrun the central row.
//
// The 2026-08-15 fix narrowed only the long-horizon reclaim age and left the
// 24h freshness gate on the full set, reasoning that a too-new reading there
// was harmless. It is not: a fleet-wide rewrite makes every session look fresh
// and stalls the reaper entirely (328 sessions on 2026-08-25, 103 on 08-26,
// against ~1,300/day before). Both gates now read this list — with one
// documented hole: a session dir whose ONLY file is inbound.db has no narrowed
// signal at all, and the `|| lastActivity` fallback below puts its inbound
// mtime back in charge, migration rewrites included. That cohort is
// never-woken sessions, the direction is conservative (it preserves), and it
// predates this change; it is knowingly left alone rather than silently
// claimed as covered.
//
// The full set stays correct for the PRE-APPLY revalidation, which only asks
// "did anything at all touch this directory since planning" and where a
// too-new reading genuinely is harmless — it aborts one action, not the pass.
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
export function sessionHasOpenWork(agentGroupId: string, sessionId: string, sessPath?: string): boolean | null {
  const inbound = dbHasRows(
    sessPath ? path.join(sessPath, 'inbound.db') : sessionMailboxPath({ agentGroupId, sessionId }, 'inbound'),
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
        // Inside the claim, deliberately: the two protections compose only
        // here. The claim refuses while any NanoClaw activity lease marker is
        // present, so it covers our own spawn path; a `canApply` that asks the
        // container runtime covers externally started containers, which plant
        // no marker. Run outside the claim and a NanoClaw container can start
        // between the check and the delete — inside, it cannot.
        //
        // HARD CONSTRAINT for anything added here, learned by shipping it
        // wrong: `tryRunWithStorageCleanupClaim` creates and removes its own
        // marker file inside `root`, which bumps `root`'s mtime. So a guard
        // that reads the mtime of `root` (or of anything under it that this
        // action deletes) is reading this pass's own footprint, and will refuse
        // every time — a gate that looks conservative and is simply broken.
        // Facts of that shape have to be settled at scan time; only facts this
        // pass does not itself write can be re-proven here.
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
let reclaimEpochStartMs = 0;
let reclaimDeadlineAt = Number.POSITIVE_INFINITY;

// The budget is a lease on a stretch of time, not a per-call allowance. Under
// the hourly scan cadence each tick opens a new epoch; anything that fires in
// between — a pressure bypass, a force prune, a second call a minute later —
// draws from the epoch already open instead of minting itself a fresh 50.
const RECLAIM_BUDGET_EPOCH_MS = 45 * 60 * 1000;

function beginReclaimPass(perTick: number, maxMs: number, now: number): void {
  if (reclaimPassDepth === 0) {
    // Real elapsed time, not the (possibly injected) logical `now`: the
    // deadline exists to protect a real host from a real long tar.
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

/** True once the pass has spent its archiving time budget. */
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
// Secret material never enters a rescue archive: creds/ is re-materialized on
// every spawn.
const SESSION_ARCHIVE_EXTRA_EXCLUDES = ['creds'];
// Node's execFileSync defaults maxBuffer to 1MB per stream. A session dir is
// archived while its agent may still be writing to it, so tar's "file changed
// as we read it" warning is expected, not exceptional, and reliably blows past
// that default — every archive-session then fails with `spawnSync tar
// ENOBUFS` right when disk pressure needs the reclaim to actually work. Applied
// to every tar invocation below (create and `-tf` verify/listing alike).
const TAR_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Create a tar archive, tolerating GNU tar's documented exit 1 ("some files
 * were changed while being archived" — `man tar` RETURN VALUE, verified on
 * this box against tar 1.35 by forcing the race: exit 1, and unaffected by
 * `--warning=no-file-changed`, which mutes only the message, not the status).
 * That is the expected outcome of archiving a dir its agent may still be
 * writing to, not a failure — treating it as fatal is what made every
 * archive-session on a live tree fail before this fix. Exit 2 (or anything
 * else, including a fatal subprocess failure passed through from zstd) still
 * throws. Safety is not weakened: content correctness is decided by the
 * `-tf` read-back and size/fsync checks the caller runs afterward, not by
 * this exit code, so a genuinely truncated or corrupt archive still fails
 * fast there.
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
  // The line is durable but its directory entry may not be on first create.
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
 * True once the reclaim has decided to take this session, and true forever
 * after.
 *
 * This is the generation token for a session id. Every path that removes a
 * session directory appends the journal line first — `:1207` before the
 * `rmSync` at `:1230`, for all three `prior_status` values, and
 * `finishInterruptedSessionArchivals` only removes a directory when a line for
 * it already exists. Nothing ever deletes a line: rescue retention prunes only
 * `*.tar.zst`, and says so. Session ids are never reused.
 *
 * So this is the one fact about a session id that is monotone (`false -> true`,
 * once) and that outlives both the central row and the directory — which is
 * exactly what `status` and file existence are not, since a row is `closed`
 * for reasons other than reclaim (rotation supersedes a predecessor) and a
 * path can be deleted and recreated.
 *
 * INTENT, NOT COMPLETION. The line precedes the `archiving -> closed` CAS at
 * `:1215`, and `:1221` keeps the directory when that CAS loses. A caller that
 * must not refuse a session the reclaim ended up keeping has to pair this with
 * evidence the removal happened — see `writeSessionMessageLocked`.
 *
 * ponytail: size-keyed cache rather than a parse per call — the journal grows
 * one line per session ever reclaimed and this sits on the ingestion path.
 * `appendReclaimJournal` is the only writer and only ever appends, so the size
 * is strictly increasing and an exact key on its own. Truncating or rotating
 * the journal breaks that invariant — a size that repeats an earlier value
 * would serve a stale answer. `mtimeMs` rides along because it is the same
 * stat and costs nothing, and it covers a rewrite that lands on a repeated
 * size; it is a second belt, not the argument. If the journal ever does get
 * rotated, key this on content, not on the stat. A stat rather than an
 * in-process invalidation hook because the reclaim runs in a worker thread
 * whose appends no hook would see.
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

/**
 * A published rescue archive is one we can still LIST, not merely one that
 * exists with bytes in it. Recovery uses this to decide whether a session dir
 * may be removed, and a truncated zstd stream is a non-empty file.
 */
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
 * Put an interrupted archival's row back. The active triple is uniquely
 * indexed (migration 049), so if a fresh session claimed this session's triple
 * while it was 'archiving', reviving it as 'active' would violate that index —
 * the old row is history at that point and closes instead.
 */
function isConstraintViolation(err: unknown): boolean {
  return (
    typeof (err as { code?: unknown })?.code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

function releaseArchivingRow(sessionId: string): 'active' | 'closed' | 'failed' {
  try {
    getDb().prepare("UPDATE sessions SET status = 'active' WHERE id = ? AND status = 'archiving'").run(sessionId);
    return 'active';
  } catch (err) {
    // The ONLY expected failure: a fresh session claimed this row's active
    // triple while it was archiving (migration 049). That row is history now.
    if (isConstraintViolation(err)) {
      getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(sessionId);
      log.warn('storage-manager: archiving row lost its triple to a newer session, closed instead', { sessionId });
      return 'closed';
    }
    // Anything else (locked DB, disk full) must NOT become a silent close —
    // that would hide an intact session dir from every sweep forever. Leave it
    // in 'archiving' and let the next startup finisher retry, loudly.
    log.error('storage-manager: could not release an archiving session row; left for startup recovery', {
      sessionId,
      err,
    });
    return 'failed';
  }
}

/**
 * Archive-then-reclaim one whole session dir. findSessionForAgent only matches
 * status='active', so the next inbound for the same thread creates a FRESH
 * session with a fresh dir (initSessionFolder is idempotent) — conversation
 * history stays in the canonical data/archive.db. The rescue
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
      // The pass has spent its archiving time; leave the rest for the next
      // tick rather than holding the storage worker for an unbounded stretch.
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
          tarCreate(
            [
              '-I',
              'zstd -T0',
              // The tree is live while we read it (the agent may still be
              // writing), so tar's own "file changed as we read it" notice
              // (and the exit 1 that comes with it, tolerated by tarCreate
              // above) is the expected case here, not a sign of trouble —
              // silencing the message just cuts noise, since suppressing it
              // does NOT change the exit status. Correctness is decided by
              // the `-tf` verify pass and the size/fsync checks below, not by
              // the exit code or by parsing warning text, so none of this
              // hides a genuinely corrupt archive. Every OTHER warning class
              // stays on.
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
          // Readable, not merely present: a truncated zstd stream is a file
          // with bytes in it and would still license the delete.
          execFileSync('tar', ['-I', 'zstd -T0', '-tf', tempPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 60 * 60 * 1000,
            maxBuffer: TAR_MAX_BUFFER_BYTES,
          });
          // tar exited, but its bytes may still be page cache. The rename is
          // durable; the CONTENT has to be too, or a crash publishes an empty
          // archive that then licenses deleting the only copy.
          const tempFd = fs.openSync(tempPath, fs.constants.O_RDONLY);
          try {
            fs.fsyncSync(tempFd);
          } finally {
            fs.closeSync(tempFd);
          }
          // Publish atomically — a rescue path only ever exists complete.
          fs.renameSync(tempPath, archivePath);
          fsyncDir(args.rescuesDir);
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
          const closed = getDb()
            .prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'")
            .run(args.sessionId).changes;
          // The row stopped being ours between the claim and here. The archive
          // is published and journalled, so nothing is lost — but the dir now
          // belongs to whoever moved the row, and removing it is not our call.
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
        // The runner context file is a SIBLING of the session directory
        // (<group>/.context/<session>.json), so removing the directory does
        // not take it. Left behind, every reclaimed session leaks one.
        fs.rmSync(sessionContextPathFor(args.sessPath), { force: true });
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
  lost: number;
  failed: number;
} {
  const rescuesDir = path.join(path.dirname(sessionsRoot), SESSION_RESCUES_DIRNAME);
  const journal = readReclaimJournal(rescuesDir);
  const result = { released: 0, finished: 0, lost: 0, failed: 0 };

  let archiving: Array<{ id: string; agent_group_id: string }>;
  try {
    archiving = getDb()
      .prepare("SELECT id, agent_group_id FROM sessions WHERE status = 'archiving'")
      .all() as typeof archiving;
  } catch (err) {
    log.warn('storage-manager: could not read interrupted archivals', { err });
    return result;
  }

  for (const row of archiving) {
    const sessPath = path.join(sessionsRoot, row.agent_group_id, row.id);
    const entry = journal.get(row.id);
    // 'archiving' is a state only this module writes, so a journal line for a
    // row still in it names THIS attempt — no stale-line ambiguity. The
    // archive is re-listed here rather than trusted from its size.
    if (entry && isPublishedArchive(entry.rescue_path)) {
      const closed = getDb()
        .prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'")
        .run(row.id).changes;
      if (closed !== 1) {
        result.failed += 1;
        continue;
      }
      if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
      // Sibling of the session directory — see the note in the archival path.
      fs.rmSync(sessionContextPathFor(sessPath), { force: true });
      result.finished += 1;
      continue;
    }
    if (!fs.existsSync(sessPath)) {
      // Dir gone with no readable archive behind it. Closing the row is the
      // only honest state — the session cannot run — but this is data loss and
      // it gets said out loud rather than counted as a success.
      getDb().prepare("UPDATE sessions SET status = 'closed' WHERE id = ? AND status = 'archiving'").run(row.id);
      log.error('storage-manager: session directory lost with no readable rescue archive', {
        sessionId: row.id,
        agentGroupId: row.agent_group_id,
        rescuePath: entry?.rescue_path ?? null,
      });
      result.lost += 1;
      continue;
    }
    const outcome = releaseArchivingRow(row.id);
    if (outcome === 'failed') result.failed += 1;
    else result.released += 1;
  }

  // Temp archives never became a rescue path; nothing references them.
  try {
    for (const name of fs.readdirSync(rescuesDir)) {
      if (name.endsWith('.tar.zst.tmp')) fs.rmSync(path.join(rescuesDir, name), { force: true });
    }
  } catch {
    // No rescues dir yet.
  }

  // ponytail: there is deliberately NO "closed row with a journal line, remove
  // its dir" pass. A crash between the close and the rm leaves an orphan dir on
  // a closed row, which the ordinary reclaim walk already re-archives on its
  // next tick. Adding the pass back would mean a journal line from an OLD
  // archival could authorize deleting a dir an operator has since restored.
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
   * The full-list mtime reading taken at the same instant as the age and
   * central-row signals this candidate was judged on. Apply re-reads it and
   * refuses on any difference, so this must be the DECISION-time value: a
   * reading taken later would absorb activity that arrived during planning and
   * quietly certify a stale decision as current.
   */
  collectedActivityMs: number;
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
      // A dir with only inbound.db (created, never woken) has no narrowed
      // signal at all; fall back to the full reading rather than reading 0 as
      // "infinitely old".
      const ageSignal = sessionLastActivityMs(sessPath, SESSION_AGE_SIGNAL_FILES) || lastActivity;
      // The 24h gate reads the age signal, NOT the full activity set. A lazy
      // inbound.db schema migration rewrites the whole fleet's inbound files
      // in minutes, and against the full set that reads as fleet-wide
      // freshness and stalls the reaper for a day. Nothing is lost by
      // excluding inbound here: sessionHasOpenWork() above already refuses any
      // session with an unconsumed inbound row, and the pre-apply
      // revalidation still compares the FULL set, so a real inbound write
      // between planning and applying still aborts the archive.
      if (args.now - ageSignal < args.policy.idleArtifactMs) {
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
      const newestActivity = Number.isFinite(dbActivityMs) ? Math.max(ageSignal, dbActivityMs) : ageSignal;
      candidates.push({
        groupName: groupDirent.name,
        sessionId,
        sessPath,
        sessionStatus: row === null ? 'orphan' : row.status === 'closed' ? 'closed' : 'active',
        newestActivityMs: newestActivity,
        ageEligible: args.now - newestActivity >= args.policy.sessionReclaimMs,
        // `lastActivity` is the full-list reading from the top of this
        // iteration — the same instant the gates above were evaluated.
        collectedActivityMs: lastActivity,
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
        tarCreate(
          [
            '-I',
            'zstd -T0',
            // Same rationale as the session-archive create call (tarCreate
            // tolerates tar's exit 1 there too): this path is idle-gated,
            // not guaranteed quiet, and the maxBuffer bump below is a
            // bounded ceiling rather than a bug fix on its own.
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

/**
 * Is this candidate's content reconstructible from something on disk?
 *
 * THE INVARIANT THE WHOLE SWEEP RESTS ON, made checkable. Three review rounds
 * removed one directory name each (dist/build/.next/coverage, then .venv, then
 * node_modules was challenged) and each time the same property was being
 * enforced one name later. A name list cannot express it: the property is
 * per-INSTANCE, not per-name — the same `node_modules` is reproducible in a
 * checkout that committed a lockfile and is unique state in one that did not.
 * So it is asked per candidate instead.
 *
 * `node_modules` is a materialized tree whose reproducer is a SEPARATE file
 * that may or may not exist, so it must be shown one. The other three names
 * carry their own reproducer structurally and need no gate:
 *
 *   - `.pnpm-store` is content-addressed. Every entry is keyed by the integrity
 *     hash of a published tarball, so it cannot hold anything authored here.
 *   - `.turbo` is a task cache keyed by a hash of its inputs; a hit is by
 *     definition equivalent to re-running the task that produced it.
 *   - `__pycache__` is PEP 3147 bytecode, not importable without the adjacent
 *     `.py` (verified on CPython 3.12), so it can never be the only copy.
 *
 * HONEST RESIDUAL: a lockfile proves a recorded state is reconstructible, not
 * that the CURRENT tree is. Packages added by `npm install --no-save` are, by
 * construction, unrecorded, and `npm ci` would drop them in CI too — they are a
 * transient build input, not a work product. Closing even that would take a
 * manifest-vs-tree diff per candidate, which is the per-target machinery this
 * sweep exists to avoid.
 *
 * Deliberately NOT listed: `bun.lockb` and `npm-shrinkwrap.json`. Both are real
 * lockfiles, but every name omitted here only ever preserves a tree, so the
 * short list is the safe direction and widening it is a decision to take on
 * purpose, not by drift.
 */
const NODE_MODULES_REPRODUCERS = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'];

function hasRecordedReproducer(parentDir: string, name: string): boolean {
  if (name !== 'node_modules') return true;
  return NODE_MODULES_REPRODUCERS.some((manifest) => fs.existsSync(path.join(parentDir, manifest)));
}

/**
 * Real regenerable directories under a topic worktree subtree.
 *
 * SYMLINKS ARE NEVER RETURNED, whatever they are named. A lockfile reproduces a
 * dependency tree's contents; it does not record that the tree was a link, or
 * where it pointed, so a hand-made `node_modules -> ../shared` mapping is
 * unique state wearing a disposable name. 13 such links exist in production.
 * Skipping the class outright is a shorter argument than gating it, and the
 * walk never descends through one either, so nothing outside the topic is
 * reachable from here.
 */
function findRegenerableTargets(root: string): string[] {
  const targets: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of safeReaddirDirents(dir)) {
      const full = path.join(dir, entry.name);
      if (!isPathInside(root, full)) continue;

      // Dirents carry lstat semantics: a symlink to a directory reports
      // isSymbolicLink() and NOT isDirectory(), so this covers both.
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DESCEND_DIR_NAMES.has(entry.name)) continue;
      if (REGENERABLE_SWEEP_DIR_NAMES.has(entry.name)) {
        // Do not descend: the whole tree goes, and a nested node_modules inside
        // it would only be counted twice.
        targets.push(full);
        continue;
      }
      stack.push(full);
    }
  }
  return targets;
}

/**
 * Newest `sessions.last_active` per topic, keyed `<workgroup>/<kind>-<id>` —
 * the last two path segments of a topic state dir, so the map is independent
 * of which root the caller scans.
 *
 * `null` means the central DB could not be read, and the caller then sweeps
 * nothing: without it there is no message-driven activity signal at all.
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
    rows = getDb()
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
      // An unresolvable identity cannot be attributed to a topic dir. It is
      // not evidence that any topic is idle, so it is simply dropped.
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

/** Why a candidate was refused. Every value is a reason to KEEP the tree. */
type SweepRefusal =
  | 'worktrees-unreadable'
  | 'inventory-unreadable'
  | 'recently-active'
  | 'container-mounted'
  | 'no-recorded-reproducer';

/**
 * Scan-time eligibility for one candidate. `null` means sweepable.
 *
 * SCAN-TIME ONLY, deliberately. Rounds 3-5 pushed toward revalidating each of
 * these again at apply time, and the honest bound on what that buys is small:
 * the recorded-reproducer gate above already proves every candidate rebuildable
 * from a committed lockfile, which turns losing any of these races from data
 * loss into a wasted `npm ci`. The apply path therefore re-runs exactly one
 * check — the container-mount lookup, which is the only condition that can flip
 * for a reason we both care about and can observe cheaply. Two of the others
 * cannot honestly be re-read at all once the pass has started: this sweep is a
 * writer into the tree it would be reading, so a deletion bumps its parent's
 * mtime and the cleanup claim bumps `worktrees/`.
 *
 * Empirical support for the sizing, not just the argument: the manual sweep has
 * removed 101 of 208 trees on the live host with agents running, against these
 * four checks and no revalidation whatsoever, with zero incidents.
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
    worktreeStat.mtimeMs,
  );
  if (args.now - lastActivity < args.idleMs) return 'recently-active';

  if (args.mounts.some((mount) => pathsOverlap(args.topicDir, mount))) return 'container-mounted';

  if (!hasRecordedReproducer(path.dirname(args.target), path.basename(args.target))) {
    return 'no-recorded-reproducer';
  }
  return null;
}

/**
 * The one condition re-proven immediately before each delete.
 *
 * An agent waking and its container mounting the topic between collection and
 * deletion is the realistic case, and it is the only one worth a syscall here:
 * a lookup is ~114ms, and a lockfile-backed tree taken from under a live
 * container costs a reinstall rather than any work. A lookup that fails refuses
 * the action — an unlistable runtime is a container we cannot see.
 *
 * Safe to call under the cleanup claim because it reads the container runtime
 * and nothing under the claim root; see the constraint documented at the
 * `canApply` call in createDeleteArtifactAction.
 */
function topicIsUnmounted(topicDir: string, lookup: () => string[] | null): boolean {
  const mounts = lookup();
  if (mounts === null) return false;
  return !mounts.some((mount) => pathsOverlap(topicDir, mount));
}

/**
 * Sweep regenerable dependency-install trees out of idle topic worktrees.
 *
 * A DIFFERENT SAFETY CLASS from the topic GC in worktree-cleanup.ts, which is
 * why this is a separate pass on a separate clock. That GC removes whole topic
 * dirs, which can hold uncommitted work, so it needs git proofs, quarantine and
 * a 7-to-30-day horizon. `REGENERABLE_SWEEP_DIR_NAMES` is restricted to trees
 * that are 100% derived from package.json and lockfiles and can never hold
 * work — which is what buys the short clock and lets this skip the git proofs.
 * The only real hazard left is deleting one out from under a container that is
 * using it, and the cost of being wrong is an `npm ci`, not lost work. Hence a
 * 2-day default. Widening that list is what would break this argument; see the
 * comment at its declaration.
 *
 * IDLE SIGNAL — `max(sessions.last_active for the topic's participants,
 * mtime of <topic>/worktrees)`. Deliberately NOT:
 *   - the regenerable tree's own mtime. It moves on install, not on use, so a
 *     tree installed in June and read every day since still dates to June. It
 *     measures the last `npm ci`, not activity.
 *   - the topic dir's own mtime. Any bulk metadata touch on the parent bumps
 *     every topic at once (#203: 360 topic dirs sharing a 2-second window),
 *     which here would make the whole fleet look fresh and silently disable
 *     the sweep. `worktrees/` is the deeper real signal for the same reason
 *     the topic GC reads it: it is the bind-mount source, and the
 *     `.nanoclaw-storage-active` lease dirs are created and removed directly
 *     under it on every container spawn.
 * `last_active` covers the converse hole — turns that touch no file under
 * `worktrees/` at all. The MAX is taken so that a fresh reading on ANY signal
 * preserves the tree; every signal must be stale before anything is swept.
 */
function collectTopicRegenerableActions(args: {
  now: number;
  topicsRoot: string;
  policy: StoragePolicy;
  runningMounts: () => string[] | null;
  skipped: StorageReport['skipped'];
  warnings: string[];
}): StorageAction[] {
  const actions: StorageAction[] = [];
  if (args.policy.regenerableSweepMs <= 0) return actions;
  if (!fs.existsSync(args.topicsRoot)) return actions;

  // Pass-level fail-closed, before walking hundreds of topics: a runtime we
  // cannot list is a container we cannot see, and a central DB we cannot read
  // leaves no activity signal worth acting on. Both snapshots are then reused
  // as the SCAN's view of the world — the scan is a cheap filter, and the
  // apply-time guard below re-reads everything from source.
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
  for (const workgroupEntry of safeReaddirDirents(args.topicsRoot)) {
    if (!workgroupEntry.isDirectory() || workgroupEntry.isSymbolicLink()) continue;
    const workgroupDir = path.join(args.topicsRoot, workgroupEntry.name);
    for (const topicEntry of safeReaddirDirents(workgroupDir)) {
      if (!topicEntry.isDirectory() || topicEntry.isSymbolicLink()) continue;
      const topicDir = path.join(workgroupDir, topicEntry.name);
      const worktreeRoot = path.join(topicDir, TOPIC_WORKTREES_DIRNAME);
      const key = `${workgroupEntry.name}/${topicEntry.name}`;

      for (const target of findRegenerableTargets(worktreeRoot)) {
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
          // `no-recorded-reproducer` is the only per-TARGET reason. The rest are
          // properties of the topic and answer the same for every candidate
          // under it, so the topic is abandoned rather than re-asked.
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
            // Collection and apply are separated by the rest of the pass, which
            // can be minutes, and an agent waking in that window is the one
            // condition worth a syscall to re-prove. It runs under the cleanup
            // claim, so it composes with the claim's own lease check to cover
            // both NanoClaw and external containers. Everything else the scan
            // decided is held by the recorded-reproducer gate: losing those
            // races costs a reinstall, not work.
            canApply: () => topicIsUnmounted(topicDir, args.runningMounts),
            safety:
              'Dependency-install tree under an idle topic worktree with a recorded manifest beside it, re-proven unmounted by the container runtime immediately before deletion.',
          }),
        );
      }
    }
  }
  return actions;
}

/**
 * Age out rescue archives. Archive-then-reclaim wrote these from 2026-08-05
 * onward and nothing ever removed them, so the rescue dirs are a monotonically
 * growing copy of everything the reclaimer has ever taken. Only `.tar.zst`
 * files are eligible — the reclaim journal beside them is the permanent record
 * of what was reclaimed and outlives the archives themselves.
 */
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
  // Same derivation as the rescue dirs below: DATA_DIR in production, and the
  // test's own tree whenever sessionsRoot is redirected.
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
    ...collectTopicRegenerableActions({
      now,
      topicsRoot,
      policy,
      runningMounts: options.runningContainerMounts ?? inspectRunningContainerMounts,
      skipped,
      warnings,
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
  reclaimEpochStartMs = 0;
  reclaimDeadlineAt = Number.POSITIVE_INFINITY;
  warnedInvalidKnobs.clear();
  loggedSessionReclaimConfig = false;
}
