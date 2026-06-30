/**
 * Host storage manager.
 *
 * Reclaims only regenerable storage:
 *   - package/build caches inside idle session and thread worktrees
 *   - stopped NanoClaw containers from this install and legacy NanoClaw agents
 *   - unused NanoClaw images and bounded Docker builder cache
 *
 * It deliberately does not remove DBs, outboxes, source checkouts, .git
 * directories, or anything attached to a live/in-flight session.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { CONTAINER_INSTALL_LABEL, DATA_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { getDb } from './db/connection.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
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

const parsedIdleHours = Number(process.env.SESSION_ARTIFACT_IDLE_HOURS);
export const SESSION_ARTIFACT_IDLE_MS =
  (Number.isFinite(parsedIdleHours) && parsedIdleHours > 0 ? parsedIdleHours : DEFAULT_IDLE_HOURS) * 60 * 60 * 1000;

const PRUNABLE_DIR_NAMES = new Set(['node_modules', '.pnpm-store', '.turbo', '.cache']);
const SKIP_DESCEND_DIR_NAMES = new Set(['.git']);

let lastStorageMaintenanceMs = 0;
let lastDockerPruneAttemptMs = 0;

export type StorageMode = 'dry-run' | 'apply';
export type StoragePool = 'session-cache' | 'thread-cache' | 'docker';
export type StorageActionKind =
  | 'delete-cache-dir'
  | 'docker-prune-containers'
  | 'docker-prune-images'
  | 'docker-prune-builder-cache';

export interface StoragePolicy {
  enabled: boolean;
  filesystemPath: string;
  cleanupThresholdPct: number;
  admissionRefusePct: number;
  idleArtifactMs: number;
  scanCadenceMs: number;
  dockerPruneCadenceMs: number;
  dockerBuildCacheUnusedFor: string;
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

interface StorageAction extends StorageActionReport {
  apply: () => void;
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

  return {
    enabled: process.env.NANOCLAW_STORAGE_MANAGER_ENABLED !== '0',
    filesystemPath: DATA_DIR,
    cleanupThresholdPct: cleanupThreshold,
    admissionRefusePct: admissionRefuse,
    idleArtifactMs: idleHours * 60 * 60 * 1000,
    scanCadenceMs: scanHours * 60 * 60 * 1000,
    dockerPruneCadenceMs: dockerPruneHours * 60 * 60 * 1000,
    dockerBuildCacheUnusedFor:
      process.env.NANOCLAW_DOCKER_BUILD_CACHE_UNUSED_FOR || DEFAULT_DOCKER_BUILD_CACHE_UNUSED_FOR,
    ...overrides,
  };
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

function dbHasRows(dbPath: string, sql: string): boolean | null {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(sql).get() as { found: number } | undefined;
    return (row?.found ?? 0) > 0;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function sessionHasOpenWork(agentGroupId: string, sessionId: string, sessPath?: string): boolean | null {
  const inbound = dbHasRows(
    sessPath ? path.join(sessPath, 'inbound.db') : inboundDbPath(agentGroupId, sessionId),
    "SELECT 1 AS found FROM messages_in WHERE status IN ('pending','processing') LIMIT 1",
  );
  if (inbound === null || inbound) return inbound;

  const outbound = dbHasRows(
    sessPath ? path.join(sessPath, 'outbound.db') : outboundDbPath(agentGroupId, sessionId),
    "SELECT 1 AS found FROM processing_ack WHERE status = 'processing' LIMIT 1",
  );
  return outbound;
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
  }>;
  try {
    rows = getDb()
      .prepare(
        `SELECT s.id, s.agent_group_id, s.thread_id, s.last_active, mg.platform_id
           FROM sessions s
           JOIN messaging_groups mg ON mg.id = s.messaging_group_id
          WHERE s.messaging_group_id IS NOT NULL`,
      )
      .all() as typeof rows;
  } catch (err) {
    log.warn('storage-manager: failed to read thread worktree activity', { err });
    return activity;
  }

  for (const row of rows) {
    const worktreeDir = threadWorktreeDir(row.platform_id, row.thread_id);
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

function createDeleteCacheAction(args: {
  id: string;
  pool: 'session-cache' | 'thread-cache';
  target: string;
  root: string;
  estimatedBytes: number;
  reason: string;
}): StorageAction {
  return {
    id: args.id,
    pool: args.pool,
    kind: 'delete-cache-dir',
    path: args.target,
    estimatedBytes: args.estimatedBytes,
    reason: args.reason,
    safety: 'Regenerable cache directory under an idle NanoClaw-owned session/thread subtree.',
    status: 'planned',
    apply: () => {
      if (!isPathInside(args.root, args.target)) {
        throw new Error(`refusing to remove path outside root: ${args.target}`);
      }
      const st = fs.lstatSync(args.target);
      if (!st.isDirectory() || st.isSymbolicLink()) {
        throw new Error(`refusing to remove non-directory or symlink: ${args.target}`);
      }
      fs.rmSync(args.target, { recursive: true, force: true });
    },
  };
}

function collectSessionCacheActions(args: {
  now: number;
  root: string;
  policy: StoragePolicy;
  isContainerRunning: (sessionId: string) => boolean;
  skipped: StorageReport['skipped'];
}): StorageAction[] {
  const actions: StorageAction[] = [];
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

      for (const target of findPrunableArtifactDirs(sessPath)) {
        const estimatedBytes = dirSizeBytes(target);
        actions.push(
          createDeleteCacheAction({
            id: `session-cache:${groupDirent.name}:${sessionId}:${path.relative(sessPath, target)}`,
            pool: 'session-cache',
            target,
            root: sessPath,
            estimatedBytes,
            reason: `session has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`,
          }),
        );
      }
    }
  }
  return actions;
}

function collectThreadCacheActions(args: {
  now: number;
  root: string;
  policy: StoragePolicy;
  activityByWorktreeDir: Map<string, ThreadWorktreeActivity>;
  skipped: StorageReport['skipped'];
}): StorageAction[] {
  const actions: StorageAction[] = [];
  for (const threadDirent of safeReaddirDirents(args.root)) {
    if (!threadDirent.isDirectory() || threadDirent.isSymbolicLink()) continue;
    const worktreeDir = path.join(args.root, threadDirent.name, 'worktrees');
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

    for (const target of findPrunableArtifactDirs(worktreeDir)) {
      const estimatedBytes = dirSizeBytes(target);
      actions.push(
        createDeleteCacheAction({
          id: `thread-cache:${threadDirent.name}:${path.relative(worktreeDir, target)}`,
          pool: 'thread-cache',
          target,
          root: worktreeDir,
          estimatedBytes,
          reason: `thread worktree has been idle for at least ${Math.round(args.policy.idleArtifactMs / 3600000)}h`,
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
  kind: Exclude<StorageActionKind, 'delete-cache-dir'>;
  dockerArgs: string[];
  estimatedBytes: number;
  reason: string;
  safety: string;
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
    apply: () => {
      execFileSync(CONTAINER_RUNTIME_BIN, args.dockerArgs, {
        stdio: 'pipe',
        timeout: 120_000,
      });
    },
  };
}

function collectDockerActions(
  policy: StoragePolicy,
  now: number,
  mode: StorageMode,
  warnings: string[],
): StorageAction[] {
  let dockerRoot: string;
  try {
    dockerRoot = dockerRootDir();
  } catch (err) {
    warnings.push(`docker info failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const usage = getFilesystemUsage(dockerRoot);
  if (!usage) {
    warnings.push(`df failed for Docker root ${dockerRoot}`);
    return [];
  }

  if (
    mode === 'apply' &&
    lastDockerPruneAttemptMs > 0 &&
    now - lastDockerPruneAttemptMs < policy.dockerPruneCadenceMs
  ) {
    warnings.push('docker prune skipped by cadence throttle');
    return [];
  }

  let estimates: Partial<Record<'Images' | 'Containers' | 'Build Cache', number>> = {};
  try {
    estimates = dockerReclaimableBytes();
  } catch (err) {
    warnings.push(`docker system df failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actions: StorageAction[] = [];
  const thresholdReason = `Docker filesystem usage is ${usage.usagePct}% (threshold ${policy.cleanupThresholdPct}%)`;
  if (usage.usagePct >= policy.cleanupThresholdPct) {
    actions.push(
      createDockerAction({
        id: 'docker:containers:stopped-install-labeled',
        kind: 'docker-prune-containers',
        dockerArgs: ['container', 'prune', '-f', '--filter', `label=${CONTAINER_INSTALL_LABEL}`],
        estimatedBytes: estimates.Containers ?? 0,
        reason: thresholdReason,
        safety: 'Docker only removes stopped containers carrying this NanoClaw install label.',
      }),
      createDockerAction({
        id: 'docker:containers:stopped-nanoclaw-labeled',
        kind: 'docker-prune-containers',
        dockerArgs: ['container', 'prune', '-f', '--filter', `label=${DOCKER_PRUNE_IMAGE_LABEL}`],
        estimatedBytes: 0,
        reason: thresholdReason,
        safety:
          'Docker only removes stopped containers carrying the NanoClaw commit label, including legacy containers that predate install labels.',
      }),
      createDockerAction({
        id: 'docker:images:unused-nanoclaw',
        kind: 'docker-prune-images',
        dockerArgs: ['image', 'prune', '-a', '-f', '--filter', `label=${DOCKER_PRUNE_IMAGE_LABEL}`],
        estimatedBytes: estimates.Images ?? 0,
        reason: thresholdReason,
        safety: 'Docker only removes images unused by any container and carrying the NanoClaw image commit label.',
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
  return actions;
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
  };
}

export function getStorageReport(options: StorageReportOptions = {}): StorageReport {
  const mode = options.mode ?? 'dry-run';
  const now = options.now ?? Date.now();
  const policy = resolveStoragePolicy(options.policy);
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
      actions: [],
      pools: summarize([]),
      skipped,
      warnings: ['storage manager disabled by NANOCLAW_STORAGE_MANAGER_ENABLED=0'],
    };
  }

  const underCleanupThreshold = usageBefore !== null && usageBefore.usagePct < policy.cleanupThresholdPct;
  const cadenceActive =
    options.respectCadence === true &&
    !options.force &&
    (underCleanupThreshold || (lastStorageMaintenanceMs > 0 && now - lastStorageMaintenanceMs < policy.scanCadenceMs));

  if (cadenceActive) {
    return {
      timestamp: new Date(now).toISOString(),
      mode,
      policy,
      filesystem: { before: usageBefore, after: usageBefore, actualReclaimedBytes: 0 },
      estimatedReclaimableBytes: 0,
      actions: [],
      pools: summarize([]),
      skipped,
      warnings: ['expensive storage scan skipped by cadence throttle'],
    };
  }

  const actions: StorageAction[] = [
    ...collectSessionCacheActions({ now, root: sessionsRoot, policy, isContainerRunning, skipped }),
    ...collectThreadCacheActions({
      now,
      root: threadsRoot,
      policy,
      activityByWorktreeDir: fs.existsSync(threadsRoot) ? collectThreadWorktreeActivity(isContainerRunning) : new Map(),
      skipped,
    }),
    ...(includeDocker ? collectDockerActions(policy, now, mode, warnings) : []),
  ];

  lastStorageMaintenanceMs = now;

  if (mode === 'apply') {
    for (const action of actions) {
      try {
        action.apply();
        action.status = 'applied';
        if (action.pool === 'docker') {
          lastDockerPruneAttemptMs = now;
        }
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

  if (mode === 'apply') {
    log.info('storage-manager: maintenance complete', {
      usageBeforePct: usageBefore?.usagePct ?? null,
      usageAfterPct: usageAfter?.usagePct ?? null,
      estimatedMb: Math.round(actionReports.reduce((sum, a) => sum + a.estimatedBytes, 0) / 1024 / 1024),
      actualMb: Math.round(actualReclaimedBytes / 1024 / 1024),
      actions: actionReports.length,
      failedActions: actionReports.filter((a) => a.status === 'failed').length,
      skipped,
    });
  }

  return {
    timestamp: new Date(now).toISOString(),
    mode,
    policy,
    filesystem: { before: usageBefore, after: usageAfter, actualReclaimedBytes },
    estimatedReclaimableBytes: actionReports.reduce((sum, action) => sum + action.estimatedBytes, 0),
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
    const report = getStorageReport({ ...options, policy, mode: 'dry-run' });
    return { allowed: true, reason: 'disabled', report };
  }
  if (!before) {
    const report = getStorageReport({ ...options, policy, mode: 'dry-run' });
    return { allowed: true, reason: 'usage-unavailable', report };
  }
  if (before.usagePct < policy.cleanupThresholdPct) {
    const report = getStorageReport({ ...options, policy, mode: 'dry-run', respectCadence: true });
    return { allowed: true, reason: 'below-threshold', report };
  }

  const report = getStorageReport({ ...options, policy, mode: 'apply', force: true });
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
      action.apply();
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
}
