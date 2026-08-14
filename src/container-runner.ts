/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import { getHostCapabilities } from './capabilities.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_BUDGET,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
  WORKGROUP_SHARED_FS,
} from './config.js';
import {
  readContainerConfig,
  readContainerConfigForSpawn,
  validateMcpServers,
  writeContainerConfig,
  type ContainerConfig,
  type McpServerConfig,
} from './container-config.js';
import {
  formatMemoryMb,
  parseMemoryMb,
  resolveContainerResources,
  type ContainerResources,
} from './container-resources.js';
import { resolveSpawnProvider } from './provider-fallback.js';
import { markProviderAvailable } from './db/provider-health.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { checkAgentRunnerDepsDrift } from './agent-runner-image-check.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from './fs-safety.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
// resolveEffectiveModel applies the family-default map, MODEL_ALIAS_MAP and
// ensureOpus1mSuffix — see its use below.
import { resolveEffectiveModel, DEFAULT_OPUS_MODEL, DEFAULT_SONNET_MODEL, DEFAULT_HAIKU_MODEL } from './flag-parser.js';
import { readEnvFileMatching } from './env.js';
import {
  getAgentGroup,
  getAllAgentGroups,
  getWorkgroupOnecliSecrets,
  getWorkgroupOnecliSecretsById,
} from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { readRepoIngressFence } from './db/session-db.js';
import { buildArchiveProjection, buildCentralProjection } from './db/per-agent-projections.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { applyOnecliSecrets, mergeWorkgroupAndGroupSecrets, slackUserTokenSecrets } from './onecli-secrets.js';
import {
  reconcileWorkgroupMemory,
  workgroupMemoryDir,
  workgroupSharedDir,
  WORKGROUP_CONTAINER_PATH,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from './modules/workgroup/shared-dirs.js';
import type Database from 'better-sqlite3';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import YAML from 'yaml';

import { extractToolScopes, filterConfigSections, isToolEnabled } from './scoped-env.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import { buildContainerCodexConfig } from './providers/codex.js';
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import {
  CLAUDE_CODE_PROJECTS_DIR,
  graphifyRuntimeDir,
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  openInboundDb,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import {
  discoverCanonicalRepositories,
  isRepositoryLifecycleClaimed,
  isWorkgroupRepositoryMountClaimed,
  readOriginPin,
  readTransferTombstone,
  resolveRepositoryWorkUnit,
  transferTombstonesDir,
  topicGraphifyCacheDir,
  topicWorktreesDir,
  type RepositoryWorkUnit,
} from './repository-workspaces.js';
import { resolveStoragePolicy } from './storage-manager.js';
import { assertStorageAdmissionInBackground } from './storage-maintenance-worker.js';
import { acquireStorageActivityLease, type StorageActivityLease } from './storage-activity.js';
import { handleStoragePressureAlert } from './storage-pressure-alert.js';
import { MemoryAdmissionController, type MemoryAdmissionPriority } from './memory-admission.js';
import type { AgentGroup, Session } from './types.js';

export const DATAFOLD_MCP_SERVER = {
  type: 'http',
  url: 'https://app.datafold.com/mcp/',
  headers: { Authorization: 'Key onecli-managed' },
} as const satisfies McpServerConfig;

export function serializeMcpServersEnv(servers: Record<string, unknown>): string | null {
  const validated = validateMcpServers(servers as Record<string, McpServerConfig>);
  if (Object.keys(validated).length === 0) return null;
  return `NANOCLAW_MCP_SERVERS=${JSON.stringify(validated)}`;
}

// timeout 30s (SDK default is 5s): createAgent/applyContainerConfig run at
// spawn, and the gateway can be briefly slow when the host is reaping many
// stale containers against it at once. A 5s abort there fails the spawn and
// forces a ~60s sweep-retry (observed delaying the opencode-sibling spawns).
// 30s rides out the transient blip without hanging spawns indefinitely.
// @onecli-sh/sdk is EXACT-pinned, and the pin is COUPLED TO THE GATEWAY VERSION.
// OneCLI ships as two components (SDK + gateway container) sharing a wire
// contract: 0.5.x calls `/api/*`, 2.x calls `/v1/*`. Both must move together.
//
// Current state (2026-07-25): SDK 2.2.1 — upstream's pin — against gateway
// v1.42.0. Verified live rather than by compiling: getGatewaySkill() returns
// 200. v1.42.0 serves BOTH prefixes, which is why `src/onecli-secrets.ts`'s raw
// `/api/<resource>` call still works; don't assume that holds forever.
//
// History worth not repeating: a blind `^0.5.0` -> `^2.8.0` bump in #135 took
// the whole fleet down for ~1h against the then-current v1.18.6 gateway, which
// served only `/api`. ensureAgent 404'd, every spawn aborted, and the sweep
// retried at WARN forever with no escalation. Nothing caught it — build and
// tests pass because neither touches the live gateway, and the method names are
// IDENTICAL across both majors (only the path moved), so a surface or type check
// cannot see it. Verify any future bump by CALLING a running gateway.
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 });

// Default model constants moved to flag-parser.ts (DEFAULT_OPUS_MODEL etc.) —
// the chat ack has to resolve family aliases the same way this spawn path
// does, and flag-parser is the leaf both can import without a cycle. Edit them
// there; this file only consumes them.
// (DEFAULT_EFFORT removed 2026-06-10 — effort defaults are per-model-family
// in the claude provider; NANOCLAW_EFFORT_OVERRIDE is operator-override-only.)

/** Active containers tracked by session ID. */
const activeContainers = new Map<
  string,
  {
    process: ChildProcess;
    containerName: string;
    spawnedAt: number;
    storageActivity: StorageActivityLease;
  }
>();

/**
 * Sticky set: every session id whose container has *ever* been observed
 * running in this host process. Never cleared on container exit. Used by
 * the orchestrator-dispatch watchdog to distinguish "container has never
 * started yet" (still queued behind concurrency cap, or wake in flight)
 * from "container ran and exited" — only the latter is a legitimate
 * `container_exit` reap. Conflating them caused tasks to be terminally
 * marked `failed: container_exit` before their container had a chance to
 * spawn, then the container would actually run, complete, and the success
 * would never replace the stale terminal status.
 *
 * In-memory by design: a host restart kills all `--rm` containers anyway,
 * and the no-progress-timeout reaper covers tasks orphaned across a
 * restart, so persistence buys nothing here.
 */
const everSeenRunningSessions = new Set<string>();

export function hasContainerEverRun(sessionId: string): boolean {
  return everSeenRunningSessions.has(sessionId);
}

export function _resetEverSeenRunningForTest(): void {
  everSeenRunningSessions.clear();
}

/**
 * Wall-clock time the host spawned the container for this session, or 0 if
 * no container is tracked. Read by the host-sweep stuck-claim guard so a
 * fresh container gets a grace window to clear its own pre-existing
 * processing_ack rows before the SLA enforcer kills it.
 */
export function getContainerSpawnedAt(sessionId: string): number {
  return activeContainers.get(sessionId)?.spawnedAt ?? 0;
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();
const spawningSessions = new Set<string>();

let memoryAdmission: MemoryAdmissionController<Session> | null = null;
let containerShutdownInProgress = false;

export function resolveMemoryAdmissionBudgetMb(
  dockerMemoryMb: number,
  override: string = CONTAINER_MEMORY_BUDGET,
): number {
  if (!Number.isInteger(dockerMemoryMb) || dockerMemoryMb <= 0) {
    throw new Error(`Docker-visible memory must be a positive integer MiB value: ${dockerMemoryMb}`);
  }
  return override.trim() ? parseMemoryMb(override) : Math.max(1, Math.floor(dockerMemoryMb * 0.8));
}

export function detectDockerMemoryMb(): number {
  try {
    const raw = execFileSync(CONTAINER_RUNTIME_BIN, ['info', '--format', '{{.MemTotal}}'], {
      encoding: 'utf8',
      timeout: 10_000,
    }).trim();
    const bytes = Number(raw);
    if (Number.isFinite(bytes) && bytes > 0) return Math.floor(bytes / 1024 / 1024);
  } catch (err) {
    log.warn('Could not read Docker-visible memory; falling back to host total memory', { err });
  }
  return Math.floor(os.totalmem() / 1024 / 1024);
}

function getMemoryAdmission(): MemoryAdmissionController<Session> {
  if (!memoryAdmission) {
    const dockerMemoryMb = detectDockerMemoryMb();
    const budgetMb = resolveMemoryAdmissionBudgetMb(dockerMemoryMb);
    memoryAdmission = new MemoryAdmissionController<Session>(budgetMb);
    log.info('Initialized container memory admission', {
      dockerMemoryMb,
      budgetMb,
      budgetSource: CONTAINER_MEMORY_BUDGET.trim() ? 'CONTAINER_MEMORY_BUDGET' : '80% of Docker-visible RAM',
    });
  }
  return memoryAdmission;
}

function releaseMemoryReservation(sessionId: string): void {
  if (!memoryAdmission) return;
  if (containerShutdownInProgress) return;
  const ready = memoryAdmission.release(sessionId);
  for (const queuedSession of ready) {
    void startReservedWake(queuedSession).catch((err) => {
      log.warn('Queued container wake failed', { sessionId: queuedSession.id, err });
    });
  }
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function isContainerSpawning(sessionId: string): boolean {
  return spawningSessions.has(sessionId) || wakePromises.has(sessionId);
}

/** Snapshot passed to isolated maintenance workers; never expose the mutable map. */
export function getActiveContainerSessionIds(): string[] {
  return [...activeContainers.keys()];
}

// ── Workgroup reconciler ────────────────────────────────────────────────────
//
// Exported for unit testing. Production callers go through spawnContainer.

/**
 * Reconcile workgroup membership at spawn time. Run on every container wake
 * so that workgroup_id in the DB reflects the operator's declared intent
 * from container.json — when that intent is present.
 *
 * Precedence:
 *   1. container.json.workgroup_id (operator intent — overrides everything)
 *   2. Existing DB value on agent_groups.workgroup_id (preserves migration 036
 *      pairings and prior spawn state)
 *   3. agentGroup.folder (default to workgroup-of-1 when nothing else is set)
 *
 * Critical: when container.json is silent (`workgroup_id` undefined), do NOT
 * overwrite the DB value with `agentGroup.folder`. Migration 036 pairs
 * existing `*-codex` siblings into their seed sibling's workgroup but the FS
 * reconciler does not back-fill `workgroup_id` into existing container.json
 * files. Treating "config silent" as "operator declared workgroup-of-1" would
 * sever every migrated pairing on first spawn after deploy. Operator silence
 * means "preserve whatever's there" — not "force own-folder."
 *
 * The workgroup row is created idempotently before agent_groups is updated.
 */
export function reconcileWorkgroupAtSpawn(
  db: Database.Database,
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): { workgroupId: string } {
  const declared = resolveWorkgroupIdAtSpawn(db, agentGroup, containerConfig);

  return persistResolvedWorkgroupAtSpawn(db, agentGroup, declared);
}

/** Persist the exact workgroup identity already resolved at admission. */
export function persistResolvedWorkgroupAtSpawn(
  db: Database.Database,
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  declared: string,
): { workgroupId: string } {
  db.transaction(() => {
    db.prepare(
      `
      INSERT INTO workgroups (id, display_name, onecli_secrets, created_at)
      VALUES (?, ?, '[]', ?)
      ON CONFLICT(id) DO NOTHING
    `,
    ).run(declared, declared, new Date().toISOString());

    // Atomic conditional update: only update if the column is NULL or stale.
    db.prepare(
      `
      UPDATE agent_groups SET workgroup_id = ?
      WHERE id = ? AND (workgroup_id IS NULL OR workgroup_id != ?)
    `,
    ).run(declared, agentGroup.id, declared);
  })();

  // Return the resolved workgroup id so spawnContainer can thread it
  // through every downstream subsystem (buildMounts /workspace/workgroup
  // mount, buildArchiveProjection, applyOnecliSecrets, etc.) without each
  // re-deriving from agentGroups. Eliminates the race where two subsystems
  // inside the same spawn observe different workgroup ids under a
  // concurrent reconcile.
  return { workgroupId: declared };
}

/** Resolve the exact workgroup identity spawn reconciliation will persist. */
export function resolveWorkgroupIdAtSpawn(
  db: Database.Database,
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): string {
  if (containerConfig.workgroup_id !== undefined) return containerConfig.workgroup_id;
  const existing = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1').get(agentGroup.id) as
    | { workgroup_id: string | null }
    | undefined;
  return existing?.workgroup_id ?? agentGroup.folder;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * The container runs the v2 agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on
 * its next tick. Callers that care (e.g. the router's typing indicator)
 * can branch on the boolean.
 */
export function wakeContainer(session: Session, priority: MemoryAdmissionPriority = 'interactive'): Promise<boolean> {
  if (containerShutdownInProgress) {
    log.debug('Container wake ignored — host shutdown in progress', { sessionId: session.id });
    return Promise.resolve(false);
  }
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }

  return trackWake(session.id, async () => {
    if (!(await checkStorageAdmission(session, false))) return false;

    const admission = getMemoryAdmission();
    const agentGroup = getAgentGroup(session.agent_group_id);
    if (!agentGroup) {
      log.error('Container wake rejected — agent group not found', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
      });
      return false;
    }
    let effectiveResources;
    try {
      effectiveResources = resolveContainerResources(readContainerConfig(agentGroup.folder).resources);
    } catch (err) {
      log.error('Container wake rejected — invalid resource configuration', {
        sessionId: session.id,
        agentGroup: agentGroup.folder,
        err,
      });
      return false;
    }

    // Priority is part of the atomic admission decision. A task-only wake must
    // never enter as interactive and be demoted afterward: it could otherwise
    // reserve free memory and bypass an older scheduled head before demotion.
    const decision = admission.request(session.id, effectiveResources.memory.requestMb, session, priority);
    if (decision.status === 'rejected') {
      log.error('Container wake rejected — memory request exceeds host budget', {
        sessionId: session.id,
        agentGroup: agentGroup.folder,
        requestMb: decision.requestMb,
        budgetMb: decision.budgetMb,
      });
      return false;
    }
    if (decision.status === 'queued') {
      log.warn('Container wake queued — memory budget exhausted', {
        sessionId: session.id,
        agentGroup: agentGroup.folder,
        requestMb: decision.requestMb,
        budgetMb: decision.budgetMb,
        reservedMb: admission.reservedMb,
        position: decision.position,
        priority,
      });
      return false;
    }

    return spawnReservedContainer(session);
  });
}

/**
 * Temporary operator-controlled fence for controlled fleet canaries. When the
 * variable is absent every workgroup is admitted. When present, only exact,
 * comma-separated workgroup ids are admitted; an empty value deliberately
 * blocks all spawns. Inbound rows remain pending for a later ungated wake.
 */
export function isContainerSpawnWorkgroupAllowed(
  workgroupId: string,
  rawAllowlist = process.env.NANOCLAW_CONTAINER_SPAWN_WORKGROUP_ALLOWLIST,
): boolean {
  if (rawAllowlist === undefined) return true;
  const allowed = new Set(
    rawAllowlist
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return allowed.has(workgroupId);
}

function startReservedWake(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) return Promise.resolve(true);
  const existing = wakePromises.get(session.id);
  if (existing) return existing;

  return trackWake(session.id, async () => {
    if (!(await checkStorageAdmission(session, true))) {
      releaseMemoryReservation(session.id);
      return false;
    }
    return spawnReservedContainer(session);
  });
}

function trackWake(sessionId: string, run: () => Promise<boolean>): Promise<boolean> {
  const tracked = run()
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId, err });
      return false;
    })
    .finally(() => {
      if (wakePromises.get(sessionId) === tracked) wakePromises.delete(sessionId);
    });
  wakePromises.set(sessionId, tracked);
  return tracked;
}

async function checkStorageAdmission(session: Session, queued: boolean): Promise<boolean> {
  try {
    const storageAdmission = await assertStorageAdmissionInBackground(getActiveContainerSessionIds());
    if (storageAdmission.allowed) return true;
    log.warn(
      queued
        ? 'Queued container wake deferred — disk usage remains above storage admission threshold'
        : 'Container wake deferred — disk usage remains above storage admission threshold',
      {
        sessionId: session.id,
        reason: storageAdmission.reason,
        usagePct:
          storageAdmission.report.filesystem.after?.usagePct ?? storageAdmission.report.filesystem.before?.usagePct,
        admissionRefusePct: storageAdmission.report.policy.admissionRefusePct,
        estimatedReclaimableMb: Math.round(storageAdmission.report.estimatedReclaimableBytes / 1024 / 1024),
        actualReclaimedMb: Math.round(storageAdmission.report.filesystem.actualReclaimedBytes / 1024 / 1024),
        actions: storageAdmission.report.actions.length,
        failedActions: storageAdmission.report.actions.filter((a) => a.status === 'failed').length,
      },
    );
    void handleStoragePressureAlert(storageAdmission.report).catch((err) =>
      log.warn('storage-manager: admission pressure alert failed', { err }),
    );
    return false;
  } catch (err) {
    // Fail closed: if pressure cannot be checked, leave the inbound row pending
    // for the next sweep instead of spawning into potentially exhausted disk.
    log.warn('Container wake deferred — background storage admission failed', {
      sessionId: session.id,
      queued,
      err,
    });
    return false;
  }
}

async function spawnReservedContainer(session: Session): Promise<boolean> {
  if (containerShutdownInProgress) return false;
  const spawnAgentGroup = getAgentGroup(session.agent_group_id);
  if (!spawnAgentGroup) {
    log.error('Container wake rejected — agent group not found at reserved spawn', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
    });
    releaseMemoryReservation(session.id);
    return false;
  }
  let spawnContainerConfig: ContainerConfig;
  let spawnWorkgroupId: string;
  try {
    // Read once at the actual spawn boundary. The same snapshot supplies the
    // authoritative workgroup declaration and every downstream spawn option.
    spawnContainerConfig = readContainerConfigForSpawn(
      spawnAgentGroup.folder,
      process.env.NANOCLAW_CONTAINER_SPAWN_WORKGROUP_ALLOWLIST !== undefined,
    );
    spawnWorkgroupId = resolveWorkgroupIdAtSpawn(getDb(), spawnAgentGroup, spawnContainerConfig);
  } catch (err) {
    log.warn('Container wake rejected — unable to resolve authoritative spawn configuration', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      err,
    });
    releaseMemoryReservation(session.id);
    return false;
  }
  if (
    process.env.NANOCLAW_CONTAINER_SPAWN_WORKGROUP_ALLOWLIST !== undefined &&
    !isContainerSpawnWorkgroupAllowed(spawnWorkgroupId)
  ) {
    log.warn('Container wake deferred — workgroup excluded by operator canary fence', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      workgroupId: spawnWorkgroupId,
    });
    releaseMemoryReservation(session.id);
    return false;
  }
  const activeCount = activeContainers.size;
  // Storage-admission promises are tracked for dedupe but are not consuming a
  // container slot. Count spawning sessions only until their process enters
  // activeContainers; the brief async handoff must not double-count one
  // process and incorrectly reject another wake at the cap.
  const inFlightWakes = [...spawningSessions].filter((sessionId) => !activeContainers.has(sessionId)).length;
  if (MAX_CONCURRENT_CONTAINERS > 0 && activeCount + inFlightWakes >= MAX_CONCURRENT_CONTAINERS) {
    log.warn('Container wake deferred — concurrency cap reached', {
      sessionId: session.id,
      activeCount,
      inFlightWakes,
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    });
    releaseMemoryReservation(session.id);
    return false;
  }

  spawningSessions.add(session.id);
  let storageActivity: StorageActivityLease | null = null;
  try {
    storageActivity = await acquireContainerStorageActivity(session, spawnWorkgroupId);
    await spawnContainer(session, storageActivity, spawnAgentGroup, spawnContainerConfig, spawnWorkgroupId);
    storageActivity = null; // activeContainers owns it until process exit
    return true;
  } catch (err) {
    log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
    releaseMemoryReservation(session.id);
    return false;
  } finally {
    if (storageActivity) await storageActivity.release();
    spawningSessions.delete(session.id);
  }
}

async function acquireContainerStorageActivity(
  session: Session,
  admittedWorkgroupId: string,
): Promise<StorageActivityLease> {
  const roots = new Set<string>([sessionDir(session.agent_group_id, session.id)]);
  roots.add(topicWorktreesDir(resolveSessionRepositoryWorkUnit(session, admittedWorkgroupId)));

  const leases: StorageActivityLease[] = [];
  try {
    for (const root of [...roots].sort()) {
      leases.push(await acquireStorageActivityLease(root, session.id));
    }
  } catch (err) {
    await Promise.allSettled(leases.map((lease) => lease.release()));
    throw err;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await Promise.all(leases.map((lease) => lease.release()));
    },
  };
}

export function resolveSessionRepositoryWorkUnit(session: Session, workgroupId: string): RepositoryWorkUnit {
  const messagingGroup = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : null;
  return resolveRepositoryWorkUnit({
    workgroupId,
    sessionId: session.id,
    platformId: messagingGroup?.platform_id ?? null,
    messagingGroupId: session.messaging_group_id ?? null,
    threadId: session.thread_id ?? null,
  });
}

function canonicalGitControlMounts(gitDir: string, stateDir: string): VolumeMount[] {
  const config = path.join(gitDir, 'config');
  const head = path.join(gitDir, 'HEAD');
  const index = path.join(gitDir, 'index');
  const hooks = path.join(gitDir, 'hooks');
  const objectsInfo = path.join(gitDir, 'objects', 'info');
  const configStat = fs.lstatSync(config);
  if (configStat.isSymbolicLink() || !configStat.isFile()) throw new Error(`Unsafe canonical Git config: ${config}`);
  const headStat = fs.lstatSync(head);
  if (headStat.isSymbolicLink() || !headStat.isFile()) throw new Error(`Unsafe canonical Git HEAD: ${head}`);
  let indexSource = index;
  try {
    const indexStat = fs.lstatSync(index);
    if (indexStat.isSymbolicLink() || !indexStat.isFile()) throw new Error(`Unsafe canonical Git index: ${index}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // An unborn/just-initialized normal clone can legitimately lack an index.
    // Bind a host-owned empty placeholder over the container path so the RW
    // parent mount cannot be used to create the canonical main-worktree index.
    indexSource = path.join(stateDir, 'canonical-index-unavailable');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(indexSource, '', { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      const placeholderStat = fs.lstatSync(indexSource);
      if (placeholderStat.isSymbolicLink() || !placeholderStat.isFile() || placeholderStat.size !== 0) {
        throw new Error(`Unsafe canonical Git index placeholder: ${indexSource}`);
      }
    }
  }
  for (const directory of [hooks, objectsInfo]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe canonical Git control path: ${directory}`);
  }
  for (const name of ['alternates', 'http-alternates']) {
    const file = path.join(objectsInfo, name);
    try {
      fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== 0) {
        throw new Error(`Canonical repository has unsafe object alternates: ${file}`);
      }
    }
  }
  return [
    { hostPath: config, containerPath: config, readonly: true },
    { hostPath: head, containerPath: head, readonly: true },
    { hostPath: indexSource, containerPath: index, readonly: true },
    { hostPath: hooks, containerPath: hooks, readonly: true },
    { hostPath: objectsInfo, containerPath: objectsInfo, readonly: true },
  ];
}

async function spawnContainer(
  session: Session,
  storageActivity: StorageActivityLease,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  admittedWorkgroupId: string,
): Promise<void> {
  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Snapshot host capabilities into the session dir so the container can
  // read a static JSON (Phase 5.3). Refreshed every spawn so newly-mounted
  // credentials / plugins / channel registrations appear immediately.
  writeCapabilitiesSnapshot(agentGroup.id, session.id, session.messaging_group_id);

  // The config was read once at the reserved-spawn boundary and is threaded
  // through workgroup reconciliation, provider resolution, mounts, and args.
  const effectiveResources = resolveContainerResources(containerConfig.resources);

  // Refuse spawn if the agent-runner deps (package.json + bun.lock) on disk
  // don't match what's baked into the image we'd spawn from. Source is
  // bind-mounted live but node_modules is image-baked — adding a dep +
  // import without ./container/build.sh crash-loops every spawn with no
  // surfaced error. Passes the resolved imageTag (per-agent override or the
  // shared base) so derived images built via install_packages are checked
  // against their own label, not the base's. See src/agent-runner-image-check.ts.
  const spawnImageRef = containerConfig.imageTag || CONTAINER_IMAGE;
  const depsCheck = await checkAgentRunnerDepsDrift(spawnImageRef);
  if (!depsCheck.ok) {
    log.warn('Refusing spawn — agent-runner deps drift', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      imageRef: depsCheck.imageRef,
      expected: depsCheck.expected,
      actual: depsCheck.actual,
      message: depsCheck.message,
    });
    throw new Error(depsCheck.message);
  }

  // Ensure container.json has the agent group identity fields the runner needs.
  // Written at spawn time so the runner can read them from the RO mount.
  ensureRuntimeFields(containerConfig, agentGroup);

  // Workgroup reconciliation — runs at every spawn.
  // Keeps agent_groups.workgroup_id and workgroups rows in sync with the
  // operator's container.json.workgroup_id declaration. Idempotent and fast
  // (two indexed DB ops inside a transaction). Fail-closed: if the central DB
  // is unavailable the exception propagates up through spawnContainer and the
  // caller retries on the next sweep tick.
  //
  // The returned workgroupId is threaded through buildMounts and other
  // downstream subsystems so they don't each re-derive from agentGroups,
  // which would race against any concurrent reconcile.
  const { workgroupId: resolvedWgId } = persistResolvedWorkgroupAtSpawn(getDb(), agentGroup, admittedWorkgroupId);
  const repositoryWorkUnit = resolveSessionRepositoryWorkUnit(session, resolvedWgId);
  if (isWorkgroupRepositoryMountClaimed(resolvedWgId)) {
    throw new Error(`Repository mount reconciliation in progress for ${resolvedWgId}; spawn will retry`);
  }
  if (isRepositoryLifecycleClaimed(repositoryWorkUnit)) {
    throw new Error(`Repository lifecycle transition in progress for ${repositoryWorkUnit.key}; spawn will retry`);
  }
  // The in-memory claims above close ordinary concurrent spawn admission. The
  // per-session DB fence survives a host crash, so it is the recovery gate for
  // a publication/transfer that died after quiescence began. A replay with the
  // same deterministic action epoch releases it at the durable boundary.
  const repositoryFenceDb = openInboundDb(session.agent_group_id, session.id);
  try {
    const repositoryFence = readRepoIngressFence(repositoryFenceDb);
    if (repositoryFence?.state === 'active') {
      throw new Error(
        `Repository mount transition ${repositoryFence.epoch} is still active for session ${session.id}; spawn will retry`,
      );
    }
  } finally {
    repositoryFenceDb.close();
  }

  const [memoryReport] = reconcileWorkgroupMemory(getDb(), { workgroupIds: [resolvedWgId] });
  if (!memoryReport || memoryReport.state.status === 'migration-required') {
    throw new Error(
      `Workgroup memory migration-required for ${resolvedWgId}; refusing container spawn before operator migration`,
    );
  }

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  // Spawn-time provider fallback: if the primary provider is inside a
  // recorded unavailability window (exhausted account) and the group declares
  // a fallback, run the fallback instead of waking a container that can only
  // fail. Applied AFTER normal resolution because `session.agent_provider`
  // outranks container.json — and mirrored onto the config + a synthetic
  // session so every downstream consumer (mounts, credentials, instruction
  // composition, worker roster) agrees on one provider.
  const providerDecision = resolveSpawnProvider({
    agentGroupId: agentGroup.id,
    sessionProvider: session.agent_provider,
    containerConfig,
  });
  if (providerDecision.fallbackApplied) {
    containerConfig.provider = providerDecision.provider;
    // Assign unconditionally. A fallback that declares no model wants the new
    // provider's own default, NOT the primary's model id — keeping the old
    // value here would emit NANOCLAW_MODEL_OVERRIDE=<codex model> to a claude
    // container, which is the same class of failure as shipping the primary's
    // providerConfig across (see parseRawConfig in the agent-runner).
    containerConfig.model = providerDecision.model;
    containerConfig.effort = providerDecision.effort;
    log.warn('Provider fallback engaged — primary is in a recorded outage window', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      primaryProvider: providerDecision.primaryProvider,
      fallbackProvider: providerDecision.provider,
      model: providerDecision.model,
    });
  }
  if (!providerDecision.fallbackApplied) {
    // The window (if any) has expired and we are giving the primary another
    // go: close out that outage episode. Without this the failure streak
    // grows monotonically forever, so a provider healthy for weeks would
    // still open its next outage at the 6h backoff cap instead of 15m.
    markProviderAvailable(agentGroup.id, providerDecision.primaryProvider);
  }
  // Local shadow: the fallback must beat a stamped session row for THIS spawn
  // without persisting a provider change to the session.
  const spawnSession = providerDecision.fallbackApplied
    ? { ...session, agent_provider: providerDecision.provider }
    : session;

  const providerName = resolveProviderName(spawnSession.agent_provider, containerConfig.provider);
  initGroupFilesystem({ ...agentGroup, workgroup_id: resolvedWgId }, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(spawnSession, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution, resolvedWgId);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  // OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  const agentIdentifier = agentGroup.id;
  // Resolve per-channel (messaging_group_agents) default_model / default_effort
  // so buildContainerArgs can apply them ABOVE the per-agent container.json
  // defaults. Null/missing falls through. Agent-spawned sessions without a
  // messaging_group (e.g. pure agent-to-agent) skip this lookup.
  let channelDefaultModel: string | null = null;
  let channelDefaultEffort: string | null = null;
  let channelDefaultTone: string | null = null;
  if (session.messaging_group_id) {
    const { getMessagingGroupAgentByPair } = await import('./db/messaging-groups.js');
    const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, agentGroup.id);
    if (wiring) {
      channelDefaultModel = wiring.default_model;
      channelDefaultEffort = wiring.default_effort;
      channelDefaultTone = wiring.default_tone;
    }
  }

  const args = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    {
      channelDefaultModel,
      channelDefaultEffort,
      channelDefaultTone,
    },
    session.messaging_group_id ?? null,
    resolvedWgId,
    providerDecision.fallbackApplied,
    session.thread_id ?? null,
    repositoryWorkUnit,
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  // Admission and container preparation are asynchronous. Shutdown may begin
  // after wakeContainer's entry check but before the process exists; refuse
  // that late spawn so stopAllContainers cannot miss it in its snapshot.
  if (containerShutdownInProgress) {
    throw new Error('Container spawn cancelled because host shutdown is in progress');
  }
  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, {
    process: container,
    containerName,
    spawnedAt: Date.now(),
    storageActivity,
  });
  everSeenRunningSessions.add(session.id);
  markContainerRunning(session.id);

  // Log stderr. A container that dies at boot (unknown provider, missing
  // binary, bad config) explains itself only here — and debug is below the
  // default log level — so keep a tail to surface on a non-zero exit.
  const stderrTail: string[] = [];
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { container: agentGroup.folder });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // No host-side idle timeout. Stale/stuck detection is driven by the host
  // sweep reading heartbeat mtime + processing_ack claim age + container_state
  // (see src/host-sweep.ts). This avoids killing long-running legitimate work
  // on a wall-clock timer.

  let finalized = false;
  const finalizeContainer = (): void => {
    if (finalized) return;
    finalized = true;

    const active = activeContainers.get(session.id);
    // ChildProcess emits `close` after `error`. Finalize this exact process
    // only once, and never let a late event delete or release a replacement
    // container that was spawned for the same session in the meantime.
    if (active?.process === container) {
      activeContainers.delete(session.id);
      void active.storageActivity.release().catch((err) => {
        log.warn('Failed to release container storage activity lease', { sessionId: session.id, err });
      });
      releaseMemoryReservation(session.id);
      markContainerStopped(session.id);
      stopTypingRefresh(session.id);
      return;
    }

    void storageActivity.release().catch((err) => {
      log.warn('Failed to release untracked container storage activity lease', { sessionId: session.id, err });
    });
  };

  container.on('close', (code) => {
    finalizeContainer();
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code === 137) {
      log.warn('Container exited 137 — likely OOM kill or forced SIGKILL', {
        sessionId: session.id,
        containerName,
        memoryRequestMb: effectiveResources.memory.requestMb,
        memoryLimitMb: effectiveResources.memory.limitMb,
        stderrTail,
      });
    } else if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    finalizeContainer();
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });

  // A killed container never reaches its turn boundary, so it can never emit
  // the `turn_end` row that tells the host to delete this session's 💭 status.
  // Without this the thinking label survives as the run's only visible output —
  // permanently for a scheduled task, whose NORMAL exit is the idle reaper
  // killing it mid-stream. Dynamic import: delivery.ts imports this module.
  // Fire-and-forget and never throws — cleanup must not block the kill.
  void import('./delivery.js')
    .then((m) => m.clearSessionStatusOnKill(sessionId))
    .catch((err) => {
      log.warn('Failed to clear status on container kill — leaving as-is', {
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    });

  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Stop every active container synchronously at host shutdown.
 *
 * Load-bearing: without this, child container subprocesses linger in the
 * cgroup after the parent exits and systemd stalls for `TimeoutStopSec`
 * (default 90s) on every restart before SIGKILLing them. v1 wired this
 * into `GroupQueue.shutdown`; v2 lost it during the v1→v2 rewrite and the
 * host lingers similarly.
 *
 * Issues `docker stop` (SIGTERM then docker's own timeout → SIGKILL) to
 * every tracked container in parallel, waits for their close events up
 * to `gracePeriodMs`, then hard-kills anything still alive.
 */
export async function stopAllContainers(gracePeriodMs: number = 10_000): Promise<void> {
  containerShutdownInProgress = true;
  memoryAdmission?.shutdown();
  const entries = Array.from(activeContainers.entries());
  if (entries.length === 0) return;
  log.info('Stopping all containers', { count: entries.length, gracePeriodMs });
  const exits = entries.map(([sessionId, entry]) => {
    const exited = new Promise<void>((resolve) => {
      if (entry.process.exitCode !== null) {
        resolve();
        return;
      }
      entry.process.once('close', () => resolve());
    });
    try {
      stopContainer(entry.containerName);
    } catch (err) {
      log.warn('stopContainer threw; falling back to SIGKILL', { sessionId, err });
      try {
        entry.process.kill('SIGKILL');
      } catch {
        // process already gone — ignore
      }
    }
    return exited;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, gracePeriodMs);
  });
  await Promise.race([Promise.all(exits).then(() => undefined), timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  // Hard-kill anything still tracked after the grace period.
  for (const [sessionId, entry] of activeContainers.entries()) {
    log.warn('Container did not exit within grace period; SIGKILL', {
      sessionId,
      containerName: entry.containerName,
    });
    try {
      entry.process.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Resolve a host env var value, folder-scoped.
 *
 * Lookup order:
 *   1. `<BASE>_<FOLDER_UPPER>` (dashes→underscores) — scoped variant
 *   2. `<BASE>` — unscoped default
 */
function resolveScopedEnv(baseName: string, folder: string): string | undefined {
  const conv = `${baseName}_${folder.toUpperCase().replace(/-/g, '_')}`;
  return process.env[conv] ?? process.env[baseName];
}

export interface AtlassianMcpServer {
  type: 'stdio';
  command: 'mcp-atlassian';
  args: [];
  env: {
    JIRA_URL: string;
    JIRA_USERNAME: 'onecli-managed';
    JIRA_API_TOKEN: 'onecli-managed';
    CONFLUENCE_URL: string;
    CONFLUENCE_USERNAME: 'onecli-managed';
    CONFLUENCE_API_TOKEN: 'onecli-managed';
  };
}

export function resolveAtlassianMcpServer(configuredBaseUrl: string | undefined): AtlassianMcpServer | null {
  if (!configuredBaseUrl) return null;
  try {
    const parsed = new URL(configuredBaseUrl);
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.atlassian.net') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '')
    ) {
      return null;
    }
    const baseUrl = parsed.origin;
    return {
      type: 'stdio',
      command: 'mcp-atlassian',
      args: [],
      env: {
        JIRA_URL: baseUrl,
        JIRA_USERNAME: 'onecli-managed',
        JIRA_API_TOKEN: 'onecli-managed',
        CONFLUENCE_URL: `${baseUrl}/wiki`,
        CONFLUENCE_USERNAME: 'onecli-managed',
        CONFLUENCE_API_TOKEN: 'onecli-managed',
      },
    };
  } catch {
    return null;
  }
}

/**
 * Resolved Anthropic credentials for a single agent group. Forwarded
 * inside the container under their unscoped names so the agent-runner's
 * existing rotation regex (`/^CLAUDE_CODE_OAUTH_TOKEN_(\d+)$/`,
 * `/^ANTHROPIC_API_KEY_(\d+)$/`) matches verbatim.
 */
export interface ResolvedAnthropicAuth {
  oauthPrimary?: string;
  oauthFallbacks: { index: number; value: string }[];
  apiKeyPrimary?: string;
  apiKeyFallbacks: { index: number; value: string }[];
}

/**
 * Per-group Anthropic credentials. Default behaviour: every container
 * receives the global `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (and
 * their `_N` rotation siblings). To pin a workplace account to a single
 * agent group, set `<BASE>_<FOLDER_UPPER>` (and optional rotation
 * siblings `<BASE>_<FOLDER_UPPER>_<N>`) in `.env` — when the per-group
 * primary is present, the *entire* rotation set comes from the per-group
 * variant and the global tokens are not forwarded. This prevents a
 * workplace account from ever falling back to a personal one (or vice
 * versa) on retryable errors.
 *
 * Folder names are uppercased and hyphens are normalised to underscores,
 * matching `resolveScopedEnv`. Folder names that match `^\d+$` collide
 * with the rotation suffix and per-group resolution is skipped for them.
 */
export function resolveAnthropicAuth(
  folder: string,
  env: NodeJS.ProcessEnv = process.env,
  envFile: Record<string, string> = {},
): ResolvedAnthropicAuth {
  const oauth = resolveScopedRotationSet('CLAUDE_CODE_OAUTH_TOKEN', folder, env, envFile);
  const apiKey = resolveScopedRotationSet('ANTHROPIC_API_KEY', folder, env, envFile);
  return {
    oauthPrimary: oauth.primary,
    oauthFallbacks: oauth.fallbacks,
    apiKeyPrimary: apiKey.primary,
    apiKeyFallbacks: apiKey.fallbacks,
  };
}

/**
 * Resolve the host-side `.codex/` directory to mount for a given agent
 * group's container. Mirrors the per-group OAuth pattern from
 * `resolveAnthropicAuth` but for Codex, which stores credentials as an
 * `auth.json` file rather than env-var tokens.
 *
 * Convention: a per-group dir at `~/.codex-<folder>/` (with a real
 * `auth.json`) wins over the global `~/.codex/`. Operators create it by
 * running `CODEX_HOME=~/.codex-<folder> codex login` once, which logs the
 * user into a SEPARATE ChatGPT/OpenAI account and writes that account's
 * tokens to the scoped dir.
 *
 * Falls back to the global `~/.codex/` when no per-group dir exists, so
 * existing single-account installs keep working unchanged.
 *
 * Exported for unit testing — keeps the resolver pure (no side effects)
 * and lets test fixtures stand in for a real homedir.
 */
export function resolveCodexAuthDir(folder: string, homedir: string = os.homedir()): string {
  const scoped = path.join(homedir, `.codex-${folder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(homedir, '.codex');
}

/**
 * Resolved fallback OAuth dir for a codex container: host path → container
 * mount path. Returned in declared order; index 0 maps to `.codex-fallback-1`,
 * index 1 to `.codex-fallback-2`, etc.
 */
export interface CodexAuthFallback {
  hostPath: string;
  containerPath: string;
}

const CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH = '/home/node/.codex-host-primary';

/**
 * Filter a `codexAuthFallbacks` declaration into a deduped, validated list
 * of fallback mounts. Entries are silently skipped when:
 *   - the declared host path doesn't have an `auth.json`
 *   - the path resolves to the same dir as the primary mount
 *   - the entry has already been seen earlier in the list
 *
 * `~/` is expanded relative to `homedir`. Both the mount block and the
 * env-forward block call this so they stay in sync without sharing state.
 *
 * Exported for unit testing.
 */
export function resolveCodexAuthFallbacks(
  declarations: string[] | undefined,
  primaryHostPath: string,
  homedir: string = os.homedir(),
): CodexAuthFallback[] {
  if (!Array.isArray(declarations) || declarations.length === 0) return [];
  const out: CodexAuthFallback[] = [];
  const seen = new Set<string>([primaryHostPath]);
  for (const decl of declarations) {
    if (typeof decl !== 'string' || !decl.trim()) continue;
    const expanded = decl.startsWith('~/') ? path.join(homedir, decl.slice(2)) : decl;
    if (seen.has(expanded)) continue;
    if (!fs.existsSync(path.join(expanded, 'auth.json'))) {
      log.warn('codexAuthFallbacks: entry skipped (no auth.json)', { hostPath: expanded });
      continue;
    }
    seen.add(expanded);
    out.push({ hostPath: expanded, containerPath: `/home/node/.codex-fallback-${out.length + 1}` });
  }
  return out;
}

/**
 * Build a session-local CODEX_HOME for one fallback identity. Only the two
 * pieces of mutable identity/history state that must survive are bind-mounted
 * from the host home: auth.json and sessions/. Config, hooks, agents, and
 * plugin state are generated inside the NanoClaw session.
 */
export function materializeCodexFallbackRuntime(fallback: CodexAuthFallback, runtimeHostPath: string): VolumeMount[] {
  fs.mkdirSync(runtimeHostPath, { recursive: true });
  assertRealDirectory(runtimeHostPath);
  assertRealDirectory(fallback.hostPath);
  removeUntrustedPathEntry(runtimeHostPath, 'plugins');
  removeUntrustedPathEntry(runtimeHostPath, '.tmp');

  const fallbackAuth = path.join(fallback.hostPath, 'auth.json');
  const fallbackAuthStat = fs.lstatSync(fallbackAuth, { throwIfNoEntry: false });
  if (!fallbackAuthStat || fallbackAuthStat.isSymbolicLink() || !fallbackAuthStat.isFile()) {
    throw new Error(`Unsafe fallback auth file: ${fallbackAuth}`);
  }
  // Container-owned base config — same generated content as the primary home.
  // The fallback host dir contributes credentials (auth.json) and history
  // (sessions/) only; its config.toml, if any, never reaches the container.
  replaceUntrustedFile(runtimeHostPath, 'config.toml', buildContainerCodexConfig());

  // Docker file bind targets must exist before the parent runtime-home mount.
  replaceUntrustedFile(runtimeHostPath, 'auth.json', '');

  const mounts: VolumeMount[] = [
    { hostPath: runtimeHostPath, containerPath: fallback.containerPath, readonly: false },
    {
      hostPath: fallbackAuth,
      containerPath: `${fallback.containerPath}/auth.json`,
      readonly: false,
    },
  ];

  const hostSessions = path.join(fallback.hostPath, 'sessions');
  const hostSessionsStat = fs.lstatSync(hostSessions, { throwIfNoEntry: false });
  if (hostSessionsStat === undefined) {
    fs.mkdirSync(hostSessions);
  } else if (hostSessionsStat.isSymbolicLink() || !hostSessionsStat.isDirectory()) {
    throw new Error(`Unsafe fallback sessions directory: ${hostSessions}`);
  }
  replaceUntrustedDirectory(runtimeHostPath, 'sessions');
  mounts.push({
    hostPath: hostSessions,
    containerPath: `${fallback.containerPath}/sessions`,
    readonly: false,
  });
  return mounts;
}

/**
 * Sentinel value injected by `onecli run --` as the host service's
 * CLAUDE_CODE_OAUTH_TOKEN. The wrapper's own proxy substitutes it for a
 * real vault token at request time — but the literal string is never a
 * usable bearer credential. If we read it as the "host primary" and
 * forward it to a container, the container's Claude Max OAuth bypass
 * path strips OneCLI's container-side substitution and sends
 * "placeholder" verbatim to api.anthropic.com, producing
 * `401 Invalid bearer token`. Treat it as absent.
 */
const PLACEHOLDER_SENTINEL = 'placeholder';

function _filterPlaceholder(v: string | undefined): string | undefined {
  return v === PLACEHOLDER_SENTINEL ? undefined : v;
}

function resolveScopedRotationSet(
  base: string,
  folder: string,
  env: NodeJS.ProcessEnv,
  envFile: Record<string, string> = {},
): { primary?: string; fallbacks: { index: number; value: string }[] } {
  const folderTok = folder.toUpperCase().replace(/-/g, '_');
  const isPureDigits = /^\d+$/.test(folderTok);

  // Effective credential view, placeholder-filtered: process.env first, then
  // the `.env` file OVERLAID on top (disk wins). The host loads `.env` into
  // process.env ONCE at startup, so any per-group `<base>_<FOLDER>`, scoped
  // numbered sibling, or global `<base>_N` that was added OR changed in `.env`
  // after the host started is invisible in process.env until a full host
  // restart. We read `.env` fresh at each spawn and let it win, so an operator
  // editing per-group tokens sees the change on the next container respawn —
  // no host bounce. Disk-wins also subsumes the placeholder-shadow recovery:
  // `onecli run --` injects `<base>=placeholder` into process.env, which the
  // filter strips, and the real value from `.env` shows through. Previously
  // ONLY the global `<base>` primary was disk-recovered (a single `??`), so
  // scoped sets and numbered siblings fell through to the global pool until a
  // restart. (Incidents: 2026-06-25 placeholder shadow, 2026-06-27 a group ran
  // weeks on the global pool while its scoped 3-account set sat unseen.)
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const fv = _filterPlaceholder(v);
    if (fv) merged[k] = fv;
  }
  for (const [k, v] of Object.entries(envFile)) {
    const fv = _filterPlaceholder(v);
    if (fv) merged[k] = fv;
  }

  const scopedPrimaryKey = `${base}_${folderTok}`;
  const scopedPrimary = !isPureDigits ? merged[scopedPrimaryKey] : undefined;

  if (scopedPrimary) {
    const fallbacks: { index: number; value: string }[] = [];
    const fallbackPrefix = `${scopedPrimaryKey}_`;
    for (const [k, v] of Object.entries(merged)) {
      if (!k.startsWith(fallbackPrefix)) continue;
      const tail = k.slice(fallbackPrefix.length);
      if (!/^\d+$/.test(tail)) continue;
      fallbacks.push({ index: Number(tail), value: v });
    }
    fallbacks.sort((a, b) => a.index - b.index);
    return { primary: scopedPrimary, fallbacks };
  }

  const primary = merged[base];
  const fallbacks: { index: number; value: string }[] = [];
  const fallbackRe = new RegExp(`^${base}_(\\d+)$`);
  for (const [k, v] of Object.entries(merged)) {
    const m = k.match(fallbackRe);
    if (!m) continue;
    fallbacks.push({ index: Number(m[1]), value: v });
  }
  fallbacks.sort((a, b) => a.index - b.index);

  // Last resort: when even the recovered view has no real `<base>` primary
  // (only numbered siblings exist — e.g. `onecli run --` placeholder + real
  // `_2`/`_3` in .env), promote the first sibling so the container's rotation
  // pool stays the same size. Without this, container-runner's `if (hostOauth)`
  // gate skips forwarding fallbacks entirely and non-scoped groups silently
  // lose their rotation pool, collapsing to OneCLI vault single-token mode.
  if (!primary && fallbacks.length > 0) {
    const promoted = fallbacks.shift()!;
    return { primary: promoted.value, fallbacks };
  }
  return { primary, fallbacks };
}

/**
 * Remove every `-e <key>=...` pair from args whose key matches. Used to
 * delete placeholder values OneCLI injects for credentials we plan to
 * substitute with the real value ourselves. Mutates args in place.
 */
export function stripEnvEntry(args: string[], key: string, onlyValue?: string): void {
  const prefix = `${key}=`;
  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === '-e' && args[i + 1].startsWith(prefix)) {
      if (onlyValue !== undefined && args[i + 1] !== `${prefix}${onlyValue}`) continue;
      args.splice(i, 2);
    }
  }
}

/**
 * Append a host to the container's NO_PROXY / no_proxy env entries,
 * merging with any value OneCLI (or an earlier step) already set. Mutates
 * args in place. If neither form is present, adds both uppercase and
 * lowercase entries — Node respects uppercase, many Python/Go tools only
 * read lowercase.
 */
function mergeNoProxy(args: string[], host: string): void {
  const keys = ['NO_PROXY', 'no_proxy'];
  let touchedAny = false;
  for (const key of keys) {
    const prefix = `${key}=`;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== '-e' || !args[i + 1].startsWith(prefix)) continue;
      const existing = args[i + 1].slice(prefix.length);
      const parts = existing
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.includes(host)) parts.push(host);
      args[i + 1] = `${key}=${parts.join(',')}`;
      touchedAny = true;
    }
  }
  if (!touchedAny) {
    args.push('-e', `NO_PROXY=${host}`);
    args.push('-e', `no_proxy=${host}`);
  }
}

/**
 * Host dir holding per-group GCP service-account key files. Drop a key at
 * `~/.config/nanoclaw-gcp/<credentialFolder>.json` (0600) to grant a group
 * BigQuery / gcloud / gsutil access. Mirrors the gws accounts-dir convention.
 */
const GCP_SA_KEYS_DIR = path.join(os.homedir(), '.config', 'nanoclaw-gcp');
/**
 * Container path for the mounted key — a DEDICATED dir, deliberately NOT inside
 * `~/.config/gcloud`. Bind-mounting a file under the gcloud config dir makes
 * Docker create that dir root-owned, so gcloud/bq can no longer write their own
 * state ("Could not setup log file"). `bq`/`gcloud` CLIs authenticate via the
 * agent-runner's `gcloud auth activate-service-account` at startup; client libs
 * + `gcloud auth application-default` read it through GOOGLE_APPLICATION_CREDENTIALS.
 */
const GCP_KEY_CONTAINER_PATH = '/home/node/.gcp/service-account.json';

/**
 * gcloud's config dir for these containers. Historically the default
 * `~/.config/gcloud` was unusable: the gws accounts mount
 * (`/home/node/.config/gws/accounts`) made Docker create `/home/node/.config`
 * ROOT-owned, but the container runs as `node` (uid 1001) — so gcloud/bq
 * couldn't create their config dir and activation failed with "Could not
 * create directory [/home/node/.config/gcloud]". The image now pre-creates
 * `/home/node/.config` node-owned (container/Dockerfile permissions block),
 * so the default would work again — but a dedicated dir keeps gcloud state
 * isolated from cred mounts, so CLOUDSDK_CONFIG stays pointed here. As a
 * container env var it's also inherited by `docker exec`, so manual gcloud/bq
 * invocations see the activated account too.
 */
const GCP_CLOUDSDK_CONFIG_CONTAINER_PATH = '/home/node/.gcloud-config';

/**
 * Resolve a per-group GCP service-account key file on the host.
 *
 * Why a file mount and not the OneCLI vault: vault secrets are HTTP-header
 * injection on a host pattern (`onecli@1.4.x` types: anthropic | generic). A
 * service-account key is a private key that gcloud uses to MINT short-lived
 * tokens locally — there is no static header to inject and the vault can't
 * materialize it as a file. This follows the gws/wix code-mount pattern,
 * which deliberately bypasses the agent-facing `additionalMounts` path (that
 * blocks credential-shaped paths and sandboxes targets away from `~/.config`).
 *
 * Keyed on `credentialFolder` so sibling groups that inherit a parent's creds
 * via `credentialFolder` share the one key (e.g. example-retail-codex/-opencode
 * resolve to example-retail's key). Returns the absolute host path, or null when
 * no key is configured — the common case, leaving such groups untouched.
 */
function resolveGcpServiceAccountKey(credentialFolder: string): string | null {
  const keyPath = path.join(GCP_SA_KEYS_DIR, `${credentialFolder}.json`);
  try {
    // statSync follows symlinks, so a sibling symlink → real key resolves true.
    return fs.existsSync(keyPath) && fs.statSync(keyPath).isFile() ? keyPath : null;
  } catch {
    return null;
  }
}

/**
 * Phase 5.3: write a capabilities snapshot into the session dir at
 * every container spawn. Container's get_capabilities MCP tool reads
 * this JSON directly — no round-trip, always fresh per spawn.
 */
function writeCapabilitiesSnapshot(
  agentGroupId: string,
  sessionId: string,
  sessionMessagingGroupId: string | null,
): void {
  try {
    const caps = getHostCapabilities(agentGroupId, sessionMessagingGroupId);
    const outPath = path.join(sessionDir(agentGroupId, sessionId), 'capabilities.json');
    fs.writeFileSync(outPath, JSON.stringify(caps, null, 2) + '\n');
  } catch (err) {
    log.warn('Failed to write capabilities snapshot', { err });
  }
}

function resolveGitHubToken(folder: string, cfg: ContainerConfig): string | undefined {
  if (cfg.githubTokenEnv) {
    const v = process.env[cfg.githubTokenEnv];
    if (v) return v;
  }
  return resolveScopedEnv('GITHUB_TOKEN', folder);
}

/**
 * Credential env vars auto-forwarded per agent group via <NAME>_<FOLDER>
 * → <NAME> resolution. Non-sensitive tool-config vars belong in the image
 * or container.json — this list is for things whose *value* differs per
 * group.
 */
const SCOPED_CREDENTIAL_VARS = [
  'RENDER_API_KEY',
  'RENDER_WORKSPACE_ID',
  'SNOWFLAKE_ACCOUNT',
  'SNOWFLAKE_USER',
  'SNOWFLAKE_PASSWORD',
  'SNOWFLAKE_WAREHOUSE',
  'SNOWFLAKE_ROLE',
  'SNOWFLAKE_DATABASE',
  'DBT_CLOUD_ACCOUNT_ID',
  'DBT_CLOUD_API_TOKEN',
  // dbt Cloud email/password login path — v1 carried these; skills that
  // use the email+password flow (not just Account-ID/API-Token) need them.
  'DBT_CLOUD_EMAIL',
  'DBT_CLOUD_PASSWORD',
  'DBT_CLOUD_API_URL',
  // dbt-mcp (dbt-labs/dbt-mcp) — Discovery + Semantic Layer + Admin API.
  // Token reuses DBT_CLOUD_API_TOKEN; these are the additional vars dbt-mcp
  // requires that the raw REST flow does not.
  'DBT_HOST',
  'DBT_MULTICELL_ACCOUNT_PREFIX',
  'DBT_PROD_ENV_ID',
  'DBT_DEV_ENV_ID',
  'DBT_USER_ID',
  'DBT_MCP_DISABLE_TOOLS',
  // Looker API3 credentials — agent shell needs these to do the /login
  // dance (POST /api/4.0/login → access_token) for direct REST calls.
  // Previously only flowed to the looker MCP subprocess; this exposes
  // them to the container's main env in parallel so curl/scripts can
  // authenticate without going through the MCP tool surface.
  'LOOKER_BASE_URL',
  'LOOKER_CLIENT_ID',
  'LOOKER_CLIENT_SECRET',
  'ATLASSIAN_BASE_URL',
  'SELECT_ORGANIZATION_ID',
  // OPENAI_API_KEY and DEEPGRAM_API_KEY removed 2026-07-27 — see the matching
  // note in capabilities.ts SCOPED_ENV_NAMES, which this list must stay in sync
  // with. Neither is in use; forwarding them only propagated a placeholder and a
  // dead vault entry. The codex provider still forwards OPENAI_API_KEY itself
  // from ctx.hostEnv (src/providers/codex.ts), so its fallback auth is intact.
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  // Omni API — required by the omni skill; absent → first call fails 401.
  'OMNI_BASE_URL',
  'OMNI_API_KEY',
  // Railway CLI / API — `railway login` uses this token; absent → CLI hangs
  // on interactive auth inside the container.
  'RAILWAY_API_TOKEN',
  // Browser-auth skill (Playwright geo-fenced login flows) — absent → login
  // form can't be filled and the skill times out on the first call.
  'BROWSER_AUTH_URL',
  'BROWSER_AUTH_EMAIL',
  'BROWSER_AUTH_PASSWORD',
  // Supabase CLI: project ref + DB password for `supabase link`, access token
  // for management API (`supabase projects list`, etc.).
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  // Git commit identity. Env vars take precedence over `git -c user.name=...`
  // overrides used by the in-container git_commit MCP tool, so setting these
  // per-group attributes commits to the human, not "agent".
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

// Canonical definition moved to db/container-configs.ts so light consumers
// (router flag parsing) don't import this module, which most of the test
// suite factory-mocks. Re-exported here for existing import sites.
export { resolveProviderName } from './db/container-configs.js';

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        agentGroupFolder: agentGroup.folder,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  // Resolved workgroup id from reconcileWorkgroupAtSpawn. Threaded in by
  // spawnContainer so every subsystem sees the same value, eliminating the
  // race where re-deriving inside buildMounts could observe a different
  // workgroup than reconcile just settled on. Defaults to the agentGroup
  // field for direct callers (tests, etc.) that don't go through
  // spawnContainer.
  resolvedWgId?: string,
): VolumeMount[] {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    syncSkillSymlinks(claudeDir, containerConfig);

    // Worker subagent defs (orchestrator mode) — Claude-only: other providers
    // don't read ~/.claude/agents, and the defs' frontmatter is Claude-format.
    // Best-effort: the roster is optional, a copy failure must not abort the
    // spawn (pending messages would retry with no container at all).
    if (provider === 'claude') {
      try {
        syncWorkerAgentDefs(claudeDir);
      } catch (err) {
        log.warn('Worker agent def sync failed — spawning without roster', {
          group: agentGroup.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup, provider);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/).
  //
  // The session dir parent is mounted RW because the container legitimately
  // writes: outbound.db (its own), outbox/<id>/ (file deliveries), and
  // .heartbeat (liveness touch).
  //
  // inbound.db, however, is host-owned and MUST be unwritable from the
  // container. Without this, a compromised agent could forge admin
  // approvals by directly INSERT-ing into the `delivered` table, trivially
  // bypassing the email-gate, send_file ack, and any future host→container
  // signaling that rides on inbound.db. The file-level RO overlay below
  // reuses the same host file; Docker applies mount rules in order, so the
  // `:ro` on inbound.db overrides the parent mount's RW permission for
  // that specific path.
  //
  // The SDK-level `readonly: true` open in container/agent-runner/src/db/
  // connection.ts is belt and suspenders. The mount is the real boundary.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });
  const inboundDbFile = path.join(sessDir, 'inbound.db');
  if (fs.existsSync(inboundDbFile)) {
    mounts.push({ hostPath: inboundDbFile, containerPath: '/workspace/inbound.db', readonly: true });
  }

  // Repository and Graphify scope are derived by one canonical work-unit
  // resolver. Same-topic siblings therefore share both checkout and index;
  // different topics receive different roots even when they use one repo.
  const wgKey = resolvedWgId ?? agentGroup.workgroup_id ?? agentGroup.folder;
  const repositoryWorkUnit = resolveSessionRepositoryWorkUnit(session, wgKey);
  const graphifyCache = topicGraphifyCacheDir(repositoryWorkUnit);
  const worktrees = topicWorktreesDir(repositoryWorkUnit);
  const graphifyRuntime = graphifyRuntimeDir();
  fs.mkdirSync(graphifyCache, { recursive: true });
  fs.mkdirSync(graphifyRuntime, { recursive: true });
  fs.mkdirSync(worktrees, { recursive: true });
  mounts.push({ hostPath: graphifyCache, containerPath: '/workspace/.cache/graphify', readonly: false });
  mounts.push({ hostPath: graphifyRuntime, containerPath: '/run/nanoclaw-graphify', readonly: false });
  // Stable agent-facing path plus the exact host path. Git worktree metadata
  // records the latter, so the same pointer works from host and container.
  mounts.push({ hostPath: worktrees, containerPath: '/workspace/worktrees', readonly: false });
  mounts.push({ hostPath: worktrees, containerPath: worktrees, readonly: false });

  // Canonical working trees stay host-only. A linked worktree needs only the
  // common `.git`, origin pin, and one shared kernel-lock inode. All are bound
  // at their exact host paths so no container-relative back-pointer can leak
  // into Git's administrative records.
  for (const repository of discoverCanonicalRepositories(wgKey)) {
    if (!readOriginPin(wgKey, repository.name)) {
      throw new Error(`Canonical repository ${wgKey}/${repository.name} is missing its host origin pin`);
    }
    const transfers = transferTombstonesDir(wgKey, repository.name);
    fs.mkdirSync(transfers, { recursive: true, mode: 0o700 });
    mounts.push({ hostPath: transfers, containerPath: transfers, readonly: true });
    if (readTransferTombstone(repositoryWorkUnit, repository.name)) {
      // The exact worktree left this source topic. Withholding the common Git
      // metadata makes the tombstone a spawn-time capability boundary too,
      // rather than relying only on the create_worktree MCP check.
      continue;
    }
    mounts.push({ hostPath: repository.gitDir, containerPath: repository.gitDir, readonly: false });
    // The common object/ref/worktree store is writable, but host-executable
    // configuration, hooks, canonical main-worktree HEAD/index, and
    // object-alternate escape hatches are immutable overlays. Linked
    // worktrees use their own .git/worktrees/<id>/HEAD and index, so container
    // Git can fetch/commit/push without being able to clobber the host
    // canonical checkout state.
    mounts.push(...canonicalGitControlMounts(repository.gitDir, path.dirname(repository.lockPath)));
    mounts.push({ hostPath: repository.lockPath, containerPath: repository.lockPath, readonly: false });
    mounts.push({ hostPath: repository.originPinPath, containerPath: repository.originPinPath, readonly: true });
  }

  // Agent group folder at /workspace/agent (RW for working files + shared memory)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Sibling-group symlink overlay. clone-as-codex creates relative symlinks
  // (e.g. groups/helper-codex/EXAMPLE -> ../helper/EXAMPLE) so two siblings share the
  // same source repos / sources / conversations on the host. Inside the
  // container, those symlinks would dereference to /workspace/helper/EXAMPLE,
  // which isn't mounted — so create_worktree, conversation reads, and source
  // discovery all fail with ENOENT. Overlay each host-resolvable
  // symlink with a bind mount at the same container path so the entry
  // appears as a real directory inside the container, transparently
  // pointing at the source group's files.
  //
  // Absolute symlinks whose targets only exist inside the container (e.g.
  // .claude-shared.md -> /app/CLAUDE.md) are skipped: realpathSync fails
  // on the host because /app doesn't exist there, and the existing /app
  // mount makes the symlink work inside the container anyway.
  //
  // SECURITY: the group dir is mounted RW at /workspace/agent, so an agent can
  // plant a symlink here pointing anywhere on the host and it would be
  // RW-mounted into its own container on the next spawn. Only overlay targets
  // that this agent is entitled to see anyway: its own group dir, a sibling
  // group dir in the SAME workgroup, or the workgroup shared tree. Anything
  // else is skipped with a loud warning.
  const allowedOverlayRoots = [
    workgroupSharedDir(wgKey),
    ...getAllAgentGroups()
      .filter((g) => (g.workgroup_id ?? g.folder) === wgKey)
      .map((g) => path.resolve(GROUPS_DIR, g.folder)),
    groupDir,
  ].map((p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  });
  const isAllowedOverlayTarget = (target: string): boolean =>
    allowedOverlayRoots.some((root) => target === root || target.startsWith(root + path.sep));
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(groupDir, entry.name);
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(linkPath);
    } catch {
      continue;
    }
    if (!isAllowedOverlayTarget(realTarget)) {
      log.warn('Refusing symlink-overlay mount outside workgroup boundary', {
        agentGroupId: agentGroup.id,
        link: linkPath,
        target: realTarget,
      });
      continue;
    }
    mounts.push({
      hostPath: realTarget,
      containerPath: `/workspace/agent/${entry.name}`,
      readonly: false,
      overlayAllowedRoots: allowedOverlayRoots,
    });
  }

  // Workgroup shared filesystem — flag-gated. Bind-mount data/workgroups/<id>/
  // at /workspace/workgroup so every sibling in the workgroup shares one tree
  // (the "house"); /workspace/agent stays private (the "bedroom"). The seed's
  // shared dirs are compat-symlinked to this path by reconcileWorkgroupSharedDirs
  // (container-absolute targets, skipped by the overlay loop above), so existing
  // /workspace/agent/<name> reader paths resolve through it with no repoint.
  // Also mounts when a prior migration left a .migrated marker, so flipping the
  // flag off after enabling doesn't dangle the compat symlinks.
  // Use the resolved wgId from spawnContainer when available — it's already
  // been settled by reconcileWorkgroupAtSpawn under the writer lock, so every
  // subsystem inside this spawn sees the same value. Fall back to the
  // agentGroup field for direct callers (tests, scripts).
  const wgId = wgKey;
  const wgShared = workgroupSharedDir(wgId);
  if (WORKGROUP_SHARED_FS || fs.existsSync(path.join(wgShared, '.migrated'))) {
    fs.mkdirSync(wgShared, { recursive: true });
    mounts.push({ hostPath: wgShared, containerPath: WORKGROUP_CONTAINER_PATH, readonly: false });
  }
  // These nested mounts are unconditional. In memory-only mode
  // /workspace/workgroup itself is container-local, so the lock needs its own
  // host bind to make every provider and sibling flock the exact same inode.
  // In full shared-FS mode the file overlay comes after the parent mount,
  // which also prevents the container from unlinking/replacing the inode.
  mounts.push(...resolveWorkgroupMemoryMounts(wgId));

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. The shared
  // memory tree and standing-instructions source remain RW via the group mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Ordered .claude mounts (group-shared parent + skills + per-session project
  // overlay + native-memory overlay). Validate the exact final legacy
  // native-memory mount and replace it with the canonical workgroup tree RO;
  // the guarded provider-neutral path above remains RW. Gated on
  // defaultSurfaces: a provider that owns its agent surfaces
  // (providesAgentSurfaces) must not get Claude state mounted.
  if (defaultSurfaces) {
    mounts.push(
      ...replaceClaudeNativeMemoryMount(getSessionClaudeMounts(agentGroup, session), {
        provider,
        agentGroupId: agentGroup.id,
        workgroupId: wgId,
      }),
    );
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-agent archive + central projections (NOT the global files).
  //
  // Mounting the global archive.db / v2.db cross-exposed every tenant's
  // chat history and topology to every container — the container has shell +
  // raw SQLite access at /workspace, so MCP filter-by-agent_group_id was
  // advisory-only. A compromised agent could `sqlite3 /workspace/archive.db
  // 'SELECT text FROM messages_archive WHERE agent_group_id = X'` for any X.
  //
  // Each container now gets a freshly-built projection containing ONLY rows
  // for its own agent_group_id, regenerated on every spawn at
  // data/v2-sessions/<ag>/<sess>/{archive,central}.db.
  const archiveSrc = path.join(DATA_DIR, 'archive.db');
  const archiveDst = path.join(sessionDir(agentGroup.id, session.id), 'archive.db');
  // Ensure the session dir exists for the projection writes below. In production
  // initSessionFolder already created it; this is a defensive no-op there. It
  // also decouples the projections from getSessionClaudeMounts, which is now
  // gated on defaultSurfaces and no longer creates this dir as a side effect.
  fs.mkdirSync(sessionDir(agentGroup.id, session.id), { recursive: true });

  // Resolve the workgroup member set from central DB. The archive.db source doesn't
  // carry agent_groups/workgroups schema; the host pre-resolves and passes the set
  // so the projection can use a parameterized IN list (R5: chat archive widens to
  // the entire workgroup; C1: workgroup boundary enforced at projection time).
  //
  // W3 fail-closed: if the spawning agent has NULL workgroup_id, abort spawn.
  // Legacy fallback: if the central DB doesn't have the workgroup_id column yet
  // (pre-migration-036 installs), pass undefined so projection uses single-agent filter.
  //
  // Use the wgId resolved by spawnContainer when available — it's the same
  // value the /workspace/workgroup mount above saw, eliminating the race
  // where two subsystems inside the same spawn could observe different
  // workgroup ids under a concurrent reconcile.
  let workgroupMemberIds: string[] | undefined;
  try {
    if (resolvedWgId) {
      const memberRows = getDb()
        .prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ?`)
        .all(resolvedWgId) as Array<{ id: string }>;
      // W3 fail-closed: if the spawning agent is no longer a member of the
      // workgroup reconcile settled on, refuse to build a projection that
      // would silently drop them. The reconcile just updated
      // agent_groups.workgroup_id for THIS agent to resolvedWgId; if that
      // write hasn't yet been observed (or if a second reconcile undid it
      // mid-spawn), the projection would lie.
      if (!memberRows.some((r) => r.id === agentGroup.id)) {
        throw new Error(
          `Workgroup-scoped projection: agent ${agentGroup.id} is not a member of workgroup ${resolvedWgId} at projection time ` +
            `(refusing to fall through to legacy single-agent filter; this is the W3 fail-closed path).`,
        );
      }
      workgroupMemberIds = memberRows.map((r) => r.id);
    } else {
      const centralCheck = getDb().prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>;
      if (centralCheck.some((c) => c.name === 'workgroup_id')) {
        const agRow = getDb().prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(agentGroup.id) as
          | { workgroup_id: string | null }
          | undefined;
        if (agRow && agRow.workgroup_id === null) {
          throw new Error(
            `Workgroup-scoped projection: invalid workgroup for agent ${agentGroup.id} — workgroup_id is NULL`,
          );
        }
        if (agRow && agRow.workgroup_id) {
          const memberRows = getDb()
            .prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ?`)
            .all(agRow.workgroup_id) as Array<{ id: string }>;
          workgroupMemberIds = memberRows.map((r) => r.id);
        }
      }
    }
  } catch (err) {
    // Re-throw W3 fail-closed (both the NULL-workgroup error and the
    // member-check error share the 'Workgroup-scoped projection' prefix);
    // otherwise fall through to legacy single-agent filter.
    if (err instanceof Error && err.message.includes('Workgroup-scoped projection')) {
      throw err;
    }
    log.warn('workgroup membership resolution failed; falling back to single-agent projection', {
      err: err instanceof Error ? err.message : String(err),
      agentGroupId: agentGroup.id,
    });
  }

  buildArchiveProjection(archiveSrc, archiveDst, agentGroup.id, workgroupMemberIds);
  mounts.push({ hostPath: archiveDst, containerPath: '/workspace/archive.db', readonly: true });

  const centralSrc = path.join(DATA_DIR, 'v2.db');
  const centralDst = path.join(sessionDir(agentGroup.id, session.id), 'central.db');
  buildCentralProjection(centralSrc, centralDst, agentGroup.id);
  mounts.push({ hostPath: centralDst, containerPath: '/workspace/central.db', readonly: true });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Spawn-task template — host-shared, not per-group. Overlays the
  // group folder so the worker contract path `/workspace/agent/
  // spawn-template.md` stays stable while the canonical content lives
  // at repo root. Spawning is a host-level primitive (`spawn_task` MCP
  // is registered for every container that opts in), so the template
  // should be too — not buried in a single agent group's folder where
  // it can drift per-install.
  const spawnTemplateSrc = path.join(projectRoot, 'container', 'spawn-template.md');
  if (fs.existsSync(spawnTemplateSrc)) {
    mounts.push({
      hostPath: spawnTemplateSrc,
      containerPath: '/workspace/agent/spawn-template.md',
      readonly: true,
    });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Plugin mounts: every subdir of ~/plugins is mounted RO at
  // /workspace/plugins/<name>. Claude Code SDK auto-discovers via
  // CLAUDE_PLUGINS_ROOT (set in buildContainerArgs). Per-group
  // excludePlugins deny list skips named plugins — useful for limiting
  // a group's tool surface (e.g. security agents without codex).
  //
  // Special case: if codex plugin is mounted and the host's ~/.codex dir
  // exists, mount that RW so the Codex CLI can use the host's OAuth
  // session and persist refresh tokens.
  const pluginsHostDir = path.join(os.homedir(), 'plugins');
  if (fs.existsSync(pluginsHostDir)) {
    // Plugins whose capability ships in-tree: mounting them would duplicate the
    // in-tree skill and (via CLAUDE_PLUGINS_ROOT auto-discovery) start a second
    // MCP server with a different allowed root. Host/OSS-only by design.
    const IN_TREE_SHADOWED_PLUGINS = ['design-artifact-loop', 'gitnexus'];
    const excluded = new Set([...IN_TREE_SHADOWED_PLUGINS, ...(containerConfig.excludePlugins ?? [])]);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsHostDir);
    } catch (err) {
      log.warn('Failed to read ~/plugins directory', { err });
    }
    for (const entry of entries) {
      if (excluded.has(entry)) continue;
      const pluginHostPath = path.join(pluginsHostDir, entry);
      try {
        if (!fs.statSync(pluginHostPath).isDirectory()) continue;
      } catch {
        continue;
      }
      mounts.push({
        hostPath: pluginHostPath,
        containerPath: `/workspace/plugins/${entry}`,
        readonly: true,
      });
    }

    // Host ~/.wix mount: opt-in via container.json `wixHostAuth: true`. RW
    // because the Wix CLI rewrites ~/.wix/auth/account.json on OAuth token
    // refresh. Mounted straight to /home/node/.wix — NOT via additionalMounts,
    // which validateAdditionalMounts sandboxes under /workspace/extra (where
    // the CLI's os.homedir()-based ~/.wix lookup would never find it). The
    // CLI's *.wix.com traffic is NO_PROXY-bypassed in the gateway block below.
    if (containerConfig.wixHostAuth === true) {
      const hostWix = path.join(os.homedir(), '.wix');
      if (fs.existsSync(hostWix)) {
        mounts.push({ hostPath: hostWix, containerPath: '/home/node/.wix', readonly: false });
      }
    }

    // Host ~/.codex mount: opt-in via container.json `codexHostAuth: true`.
    // RW because the Codex CLI rewrites auth.json on token refresh — RO
    // breaks long-running sessions when access tokens expire. Token-theft
    // risk is unchanged regardless of RO/RW (read access alone is enough),
    // so the security improvement is the OPT-IN itself: pre-2026-05-03 the
    // mount fired on every group that had the codex plugin available;
    // now operators must explicitly grant Codex host auth per group.
    if (containerConfig.codexHostAuth === true && !excluded.has('codex') && entries.includes('codex')) {
      const providerHasCodexMount = providerContribution.mounts?.some((m) => m.containerPath === '/home/node/.codex');

      // Primary host-codex mount fires only when the provider didn't
      // already contribute one. provider=codex paths bring their own
      // session-local copy of auth.json at /home/node/.codex (see
      // src/providers/codex.ts's container-config registry contribution);
      // codex-as-peer setups (provider=claude with the codex plugin) rely
      // on this block to surface the host's ~/.codex directly.
      const primaryHostPath = resolveCodexAuthDir(agentGroup.folder);
      if (providerHasCodexMount && fs.existsSync(path.join(primaryHostPath, 'auth.json'))) {
        mounts.push({
          hostPath: primaryHostPath,
          containerPath: CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH,
          readonly: true,
        });
      }

      if (!providerHasCodexMount) {
        // Per-group resolution: ~/.codex-<folder>/ wins if it has an
        // auth.json, otherwise fall back to the global ~/.codex/.
        //
        // NB: Keyed on `agentGroup.folder`, NOT `containerConfig.credentialFolder`.
        // A codex sibling typically WANTS its own Codex account (different
        // OpenAI/ChatGPT identity than the Claude source); credentialFolder
        // is for env-var creds (LOOKER, DBT, GitHub tokens) which the sibling
        // should inherit. Conflating the two would silently override the
        // sibling's purpose-built ~/.codex-<sibling>/ dir with the source's.
        const hostCodex = primaryHostPath;
        if (fs.existsSync(hostCodex)) {
          mounts.push({ hostPath: hostCodex, containerPath: '/home/node/.codex', readonly: false });
          const globalCodex = path.join(os.homedir(), '.codex');
          if (hostCodex !== globalCodex) {
            const scopedConfig = path.join(hostCodex, 'config.toml');
            const globalConfig = path.join(globalCodex, 'config.toml');
            if (!fs.existsSync(scopedConfig) && fs.existsSync(globalConfig)) {
              mounts.push({
                hostPath: globalConfig,
                containerPath: '/home/node/.codex/config.toml',
                readonly: true,
              });
            }
            const scopedPlugins = path.join(hostCodex, 'plugins');
            const globalPlugins = path.join(globalCodex, 'plugins');
            if (!fs.existsSync(scopedPlugins) && fs.existsSync(globalPlugins)) {
              mounts.push({
                hostPath: globalPlugins,
                containerPath: '/home/node/.codex/plugins',
                readonly: true,
              });
            }
          }
        }
      }

      // codexAuthFallbacks: ordered list of additional ~/.codex* dirs to
      // mount as fallback OAuth identities. INDEPENDENT of the primary
      // mount source — fallbacks target /home/node/.codex-fallback-N/
      // which never conflicts with /home/node/.codex. So they fire
      // regardless of whether the primary came from the provider's
      // per-session copy (provider=codex, the original Example-Retail-codex case) or
      // from the direct host mount above (codex-as-peer). Without this
      // independence the fallback was effectively dead code for the very
      // configuration we built it for.
      //
      // Resolution + filtering lives in `resolveCodexAuthFallbacks`; each
      // survivor mounts at /home/node/.codex-fallback-N/ in declared order.
      // The container provider reads CODEX_FALLBACK_HOMES and rotates on
      // UsageLimitExceeded / ServerOverloaded / coarse-systemError. RW
      // because codex refresh-rotates tokens in-place.
      //
      // primaryHostPath for dedup uses resolveCodexAuthDir — the host path
      // the primary auth came from, regardless of whether the actual
      // /home/node/.codex mount source is that path or a session-local
      // copy. Lets a fallback declaration matching the primary be skipped.
      const resolvedFallbacks = resolveCodexAuthFallbacks(containerConfig.codexAuthFallbacks, primaryHostPath);
      resolvedFallbacks.forEach((entry, index) => {
        if (providerHasCodexMount) {
          const fallbackRuntime = path.join(
            sessionDir(agentGroup.id, session.id),
            'codex-fallbacks',
            String(index + 1),
          );
          mounts.push(...materializeCodexFallbackRuntime(entry, fallbackRuntime));
        } else {
          mounts.push({ hostPath: entry.hostPath, containerPath: entry.containerPath, readonly: false });
        }
      });
    }
  }

  // Project source tree at /workspace/project (RO). Lets agents read the
  // NanoClaw codebase — useful for self-diagnostic questions ("why did
  // you do X?"), self-mod context, and understanding their own runtime.
  // We mount a selective allowlist rather than the whole project root
  // to exclude .env, data/, groups/, repo-tokens/, node_modules/, dist/,
  // logs/, and other sensitive or bulky paths.
  //
  // scripts/ and prompts/ are INTENTIONALLY excluded: v1 commit 3a31f9d
  // removed them from the allowlist after noting that scripts/ exposes
  // credential path topology (wire-*, migrate-*, init-* scripts reference
  // host paths) and prompts/ was unused agent-facing content. Keep them
  // out unless there's a specific capability that needs them and a clear
  // review of what's in them.
  // projectRoot (declared at top of buildMounts) is equivalent to
  // path.resolve(GROUPS_DIR, '..') since GROUPS_DIR is <projectRoot>/groups.
  const sourceEntries = [
    'src',
    'container',
    'docs',
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'AGENTS.md',
    'tsconfig.json',
  ];
  for (const entry of sourceEntries) {
    const hostEntry = path.join(projectRoot, entry);
    if (fs.existsSync(hostEntry)) {
      mounts.push({
        hostPath: hostEntry,
        containerPath: `/workspace/project/${entry}`,
        readonly: true,
      });
    }
  }

  // Narrow exception to the scripts/ exclusion above: the dependency-audit
  // script is the one scripts/ file agents must be able to run. The weekly
  // update-advisory pre-check and /update-container both invoke
  // `bun /workspace/project/scripts/container-updates.ts`; without this mount
  // that resolves to a nonexistent path and the audit dies with "Module not
  // found". It reads only manifests already mounted here (package.json,
  // container/*) and imports src/container-updates.ts (mounted via 'src'), so
  // it exposes no credential-path topology — the reason scripts/ is excluded.
  const auditScript = path.join(projectRoot, 'scripts', 'container-updates.ts');
  if (fs.existsSync(auditScript)) {
    mounts.push({
      hostPath: auditScript,
      containerPath: '/workspace/project/scripts/container-updates.ts',
      readonly: true,
    });
  }

  // Tone profiles — project-relative, shared across all groups. Read-only:
  // groups select a profile in their CLAUDE.md; the files themselves are
  // managed via the /add-tone-profile skill on the host.
  const toneProfilesDir = path.resolve(GROUPS_DIR, '..', 'tone-profiles');
  if (fs.existsSync(toneProfilesDir)) {
    mounts.push({
      hostPath: toneProfilesDir,
      containerPath: '/workspace/tone-profiles',
      readonly: true,
    });
  }

  // Group-owned tone profiles — overlay, resolved BEFORE the shared set by
  // the container (agent-runner/src/tone-profiles.ts). This is what lets a
  // voice be selected per channel without publishing it: agent personas live
  // here, in the private groups repo, invisible to other workgroups, and are
  // chosen through `default_tone` exactly like a shared profile. A group can
  // also shadow a shared name for itself alone.
  const groupToneProfilesDir = path.join(groupDir, 'tone-profiles');
  if (fs.existsSync(groupToneProfilesDir)) {
    mounts.push({
      hostPath: groupToneProfilesDir,
      containerPath: '/workspace/tone-profiles-group',
      readonly: true,
    });
  }

  // Host-side credential dirs — gated by the per-agent `tools` allowlist in
  // container.json. Two modes:
  //
  //   tools = undefined  → legacy behavior, mount every credential surface.
  //                        Preserves the pre-v2-tools-port default.
  //   tools = [...]      → filter + stage per-tool. E.g. `snowflake:archive-one`
  //                        stages only the [connections.archive-one] section of
  //                        connections.toml and its referenced private
  //                        keys; `aws:work` stages only [work] from
  //                        ~/.aws/credentials (scoped = exactly the named
  //                        profiles, no implicit [default]); bare unscoped
  //                        `aws` stages all profiles; `dbt:snowflake-db`
  //                        stages a profiles.yml containing only that profile.
  //
  // Rationale for the gate (see docs/V2_BACKLOG.md → scoped credentials):
  //   OneCLI's proxy covers API-level secrets (keys flowing through
  //   HTTPS_PROXY). Filesystem credentials — private keys, INI/TOML with
  //   raw passwords, service-account JSONs — are *not* OneCLI-mediated.
  //   Without per-agent scoping every agent can `cat` every other agent's
  //   creds. v1 enforced this at mount time; v2 now does too when `tools`
  //   is set.
  const home = os.homedir();
  const tools = containerConfig.tools;
  const stagingRoot = path.join(sessDir, 'creds');

  // Prepare a clean per-cred staging subdir. Caller passes the dir name;
  // returns the absolute path. We rm+mkdir to avoid stale files leaking
  // between spawns of the same session (e.g. after an agent re-scope).
  const stageDir = (name: string): string => {
    const p = path.join(stagingRoot, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---- Gmail MCP (legacy per-account dirs) --------------------------------
  if (isToolEnabled(tools, 'gmail') || isToolEnabled(tools, 'gmail-readonly')) {
    const g = extractToolScopes(tools, 'gmail');
    const r = extractToolScopes(tools, 'gmail-readonly');
    const scopedAccounts = [...new Set([...g.scopes, ...r.scopes])];
    const anyScoped = scopedAccounts.length > 0 && !tools?.includes('gmail');

    if (anyScoped) {
      // First scoped account gets the primary path; extras mounted at named paths.
      const primary = scopedAccounts[0];
      const primaryDir = path.join(home, `.gmail-mcp-${primary}`);
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      for (let i = 1; i < scopedAccounts.length; i++) {
        const acctDir = path.join(home, `.gmail-mcp-${scopedAccounts[i]}`);
        if (fs.existsSync(acctDir)) {
          mounts.push({
            hostPath: acctDir,
            containerPath: `/home/node/.gmail-mcp-${scopedAccounts[i]}`,
            readonly: true,
          });
        }
      }
    } else {
      // Unscoped (or tools undefined): mount primary + every .gmail-mcp-*/
      const primaryDir = path.join(home, '.gmail-mcp');
      if (fs.existsSync(primaryDir)) {
        mounts.push({ hostPath: primaryDir, containerPath: '/home/node/.gmail-mcp', readonly: true });
      }
      try {
        for (const entry of fs.readdirSync(home)) {
          if (!entry.startsWith('.gmail-mcp-')) continue;
          const dir = path.join(home, entry);
          try {
            if (!fs.statSync(dir).isDirectory()) continue;
          } catch {
            continue;
          }
          mounts.push({ hostPath: dir, containerPath: `/home/node/${entry}`, readonly: true });
        }
      } catch {
        // home may not be readable — skip
      }
    }
  }

  // ---- Google Calendar MCP ------------------------------------------------
  if (isToolEnabled(tools, 'calendar')) {
    const calDir = path.join(home, '.config', 'google-calendar-mcp');
    const { scopes: calAccts, isScoped: calScoped } = extractToolScopes(tools, 'calendar');
    if (fs.existsSync(calDir)) {
      if (calScoped) {
        // Filter tokens.json to allowed accounts; fail CLOSED on parse error
        // (do NOT fall back to the full dir — that defeats the scope).
        const tokensPath = path.join(calDir, 'tokens.json');
        if (fs.existsSync(tokensPath)) {
          try {
            const all = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')) as Record<string, unknown>;
            const filtered: Record<string, unknown> = {};
            for (const a of calAccts) if (all[a]) filtered[a] = all[a];
            const dest = stageDir('google-calendar-mcp');
            fs.writeFileSync(path.join(dest, 'tokens.json'), JSON.stringify(filtered, null, 2), { mode: 0o600 });
            // Copy non-token files (settings etc.) as-is.
            for (const entry of fs.readdirSync(calDir)) {
              if (entry === 'tokens.json') continue;
              const src = path.join(calDir, entry);
              try {
                if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dest, entry));
              } catch {
                continue;
              }
            }
            mounts.push({
              hostPath: dest,
              containerPath: '/home/node/.config/google-calendar-mcp',
              readonly: true,
            });
          } catch (err) {
            log.warn('Calendar tokens filter failed — skipping mount (fail closed)', {
              agent: agentGroup.folder,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        mounts.push({ hostPath: calDir, containerPath: '/home/node/.config/google-calendar-mcp', readonly: true });
      }
    }

    // Calendar reuses the Gmail OAuth app keys. If gmail isn't enabled for
    // this agent, mount JUST the keys file (not the full gmail dir, which
    // would leak Gmail tokens to a calendar-only scope).
    if (!isToolEnabled(tools, 'gmail')) {
      const oauthKeys = path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json');
      if (fs.existsSync(oauthKeys)) {
        mounts.push({
          hostPath: oauthKeys,
          containerPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
          readonly: true,
        });
      }
    }
  }

  // ---- Google Workspace (gws-style accounts dir) --------------------------
  if (isToolEnabled(tools, 'google-workspace')) {
    const gwsAccountsDir = path.join(home, '.config', 'gws', 'accounts');
    if (fs.existsSync(gwsAccountsDir)) {
      const { scopes: gwsAccts, isScoped: gwsScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwsScoped) {
        // Each account has its own JSON file under accounts/. Stage only
        // the allowed ones. Entries can be files (<acct>.json) or dirs.
        const dest = stageDir('gws-accounts');
        for (const acct of gwsAccts) {
          const fileCandidate = path.join(gwsAccountsDir, `${acct}.json`);
          const dirCandidate = path.join(gwsAccountsDir, acct);
          try {
            if (fs.existsSync(fileCandidate) && fs.statSync(fileCandidate).isFile()) {
              fs.copyFileSync(fileCandidate, path.join(dest, `${acct}.json`));
              fs.chmodSync(path.join(dest, `${acct}.json`), 0o600);
            } else if (fs.existsSync(dirCandidate) && fs.statSync(dirCandidate).isDirectory()) {
              fs.cpSync(dirCandidate, path.join(dest, acct), { recursive: true });
            } else {
              log.warn('google-workspace account not found in gws dir', { acct, agent: agentGroup.folder });
            }
          } catch (err) {
            log.warn('google-workspace scoped copy failed', {
              acct,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        mounts.push({ hostPath: dest, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      } else {
        mounts.push({ hostPath: gwsAccountsDir, containerPath: '/home/node/.config/gws/accounts', readonly: true });
      }
    }

    // Legacy google_workspace_mcp/credentials/ — same pattern.
    const gwCredsDir = path.join(home, '.google_workspace_mcp', 'credentials');
    if (fs.existsSync(gwCredsDir)) {
      const { scopes: gwAccts, isScoped: gwScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwScoped) {
        const dest = stageDir('google-workspace-mcp-credentials');
        for (const entry of fs.readdirSync(gwCredsDir)) {
          // match entries that START with an allowed account name (allows
          // <acct>.json, <acct>_token.json, etc. — v1 pattern).
          if (!gwAccts.some((a) => entry.startsWith(a))) continue;
          const src = path.join(gwCredsDir, entry);
          try {
            if (fs.statSync(src).isFile()) {
              fs.copyFileSync(src, path.join(dest, entry));
              fs.chmodSync(path.join(dest, entry), 0o600);
            }
          } catch {
            continue;
          }
        }
        mounts.push({
          hostPath: dest,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      } else {
        mounts.push({
          hostPath: gwCredsDir,
          containerPath: '/home/node/.google_workspace_mcp/credentials',
          readonly: true,
        });
      }
    }
  }

  // ---- GCP service-account key (BigQuery / gcloud / gsutil) ---------------
  // Mount a per-group SA key into a dedicated container path. The agent-runner
  // activates it for the `gcloud`/`bq` CLIs at startup; client libs read it via
  // GOOGLE_APPLICATION_CREDENTIALS (wired in buildContainerArgs, along with the
  // googleapis.com proxy bypass). Gated on the key file existing (see
  // resolveGcpServiceAccountKey) — groups without one are untouched.
  {
    const gcpKey = resolveGcpServiceAccountKey(containerConfig.credentialFolder ?? agentGroup.folder);
    if (gcpKey) {
      mounts.push({ hostPath: gcpKey, containerPath: GCP_KEY_CONTAINER_PATH, readonly: true });
    }
  }

  // ---- Snowflake (connections.toml + keys) --------------------------------
  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(home, '.snowflake');
    const origToml = path.join(snowflakeDir, 'connections.toml');
    if (fs.existsSync(snowflakeDir) && fs.existsSync(origToml)) {
      const { scopes: allowedConns, isScoped: filterConns } = extractToolScopes(tools, 'snowflake');
      const dest = stageDir('snowflake');

      // Rewrite host paths → /home/node paths so in-container CLIs find
      // their own keys. snowflake-connector-python historically doesn't
      // expand `~`, so we normalize to absolute /home/node/... paths.
      const homePattern = new RegExp(escapeRegex(snowflakeDir) + '/', 'g');
      let tomlContent = fs.readFileSync(origToml, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
      if (filterConns) tomlContent = filterConfigSections(tomlContent, allowedConns);
      fs.writeFileSync(path.join(dest, 'connections.toml'), tomlContent, { mode: 0o600 });

      const origConfig = path.join(snowflakeDir, 'config.toml');
      if (fs.existsSync(origConfig)) {
        const configContent = fs.readFileSync(origConfig, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
        fs.writeFileSync(path.join(dest, 'config.toml'), configContent, { mode: 0o600 });
      }

      // Copy only key files that the (possibly filtered) toml actually
      // references — never the whole keys/ dir under scoping.
      const keysDir = path.join(snowflakeDir, 'keys');
      if (fs.existsSync(keysDir)) {
        const referenced = new Set<string>();
        for (const m of tomlContent.matchAll(/private_key_path\s*=\s*"[^"]*\/keys\/([^"]+)"/g)) {
          referenced.add(m[1]);
        }
        const destKeys = path.join(dest, 'keys');
        fs.mkdirSync(destKeys, { recursive: true });
        for (const entry of fs.readdirSync(keysDir, { withFileTypes: true, recursive: true })) {
          if (!entry.isFile()) continue;
          const srcPath = path.join(entry.parentPath, entry.name);
          const relPath = path.relative(keysDir, srcPath);
          // When filtering, skip any key not referenced by allowed conns.
          // When not filtering, copy everything.
          if (filterConns && referenced.size > 0 && !referenced.has(relPath)) continue;
          const destPath = path.join(destKeys, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      }

      // Mount RW: snow CLI writes to ~/.snowflake/logs/.
      mounts.push({ hostPath: dest, containerPath: '/home/node/.snowflake', readonly: false });

      // Dual-mount at host absolute path too — some snowflake libs record
      // the originally-resolved absolute path in session state and retry
      // reads at that path. The container sees the same staging dir.
      if (snowflakeDir !== '/home/node/.snowflake') {
        mounts.push({ hostPath: dest, containerPath: snowflakeDir, readonly: false });
      }
    }
  }

  // ---- AWS (~/.aws/{credentials,config}) ----------------------------------
  // Scoped `aws:<profile>` stages EXACTLY the named profiles — no implicit
  // `default`. A scoped group must not inherit whatever account `default`
  // points at: that is a cross-tenant leak (e.g. an `aws:example-retail` Example Retail
  // group silently picking up a personal/Example Labs `default`). A group that
  // genuinely needs the default profile requests it explicitly via
  // `aws:default[:<other>]`.
  //
  // Unscoped bare `aws` still stages every profile — intentional broad access
  // (e.g. a personal cross-domain agent). Consequence: adding a new profile to
  // the host `~/.aws` only fans out to groups that opted into unscoped `aws`,
  // never to scoped groups.
  if (isToolEnabled(tools, 'aws')) {
    const awsDir = path.join(home, '.aws');
    if (fs.existsSync(awsDir)) {
      const { scopes: allowedProfiles, isScoped: filterProfiles } = extractToolScopes(tools, 'aws');
      const dest = stageDir('aws');

      const origCreds = path.join(awsDir, 'credentials');
      if (fs.existsSync(origCreds)) {
        let content = fs.readFileSync(origCreds, 'utf-8');
        if (filterProfiles) content = filterConfigSections(content, allowedProfiles);
        fs.writeFileSync(path.join(dest, 'credentials'), content, { mode: 0o600 });
      }
      const origConfig = path.join(awsDir, 'config');
      if (fs.existsSync(origConfig)) {
        let content = fs.readFileSync(origConfig, 'utf-8');
        if (filterProfiles) {
          // AWS config uses `[profile foo]` rather than `[foo]` — transform
          // to compare raw name against the allowlist.
          content = filterConfigSections(content, allowedProfiles, {
            headerTransform: (h) => h.replace(/^profile\s+/, ''),
          });
        }
        fs.writeFileSync(path.join(dest, 'config'), content, { mode: 0o600 });
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.aws', readonly: true });
    }
  }

  // ---- gcloud (~/.gcloud-keys/*.json) -------------------------------------
  if (isToolEnabled(tools, 'gcloud')) {
    const gcloudKeysDir = path.join(home, '.gcloud-keys');
    if (fs.existsSync(gcloudKeysDir)) {
      const { scopes: gcloudScopes, isScoped: gcloudScoped } = extractToolScopes(tools, 'gcloud');
      const dest = stageDir('gcloud-keys');

      if (gcloudScoped) {
        // v1 convention: GCLOUD_KEY_<SCOPE>=<filename.json> env var in the
        // host process env maps scope → key file. Keep the same contract.
        for (const s of gcloudScopes) {
          const envKey = `GCLOUD_KEY_${s.toUpperCase()}`;
          const keyFile = process.env[envKey];
          if (!keyFile) {
            log.warn('gcloud scope has no GCLOUD_KEY_<SCOPE> mapping in env', { scope: s, envKey });
            continue;
          }
          const srcPath = path.join(gcloudKeysDir, keyFile);
          if (!fs.existsSync(srcPath)) {
            log.warn('gcloud key file not found', { srcPath, scope: s });
            continue;
          }
          const destPath = path.join(dest, keyFile);
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      } else {
        // Unscoped: copy every .json under the keys dir.
        for (const entry of fs.readdirSync(gcloudKeysDir)) {
          if (!entry.endsWith('.json')) continue;
          const srcPath = path.join(gcloudKeysDir, entry);
          try {
            if (fs.statSync(srcPath).isFile()) {
              const destPath = path.join(dest, entry);
              fs.copyFileSync(srcPath, destPath);
              fs.chmodSync(destPath, 0o600);
            }
          } catch {
            continue;
          }
        }
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.gcloud-keys', readonly: true });
    }
  }

  // ---- dbt (~/.dbt/profiles.yml) ------------------------------------------
  if (isToolEnabled(tools, 'dbt')) {
    const dbtDir = path.join(home, '.dbt');
    const origProfiles = path.join(dbtDir, 'profiles.yml');
    if (fs.existsSync(origProfiles)) {
      const { scopes, isScoped } = extractToolScopes(tools, 'dbt');
      const dest = stageDir('dbt');
      try {
        let profiles = YAML.parse(fs.readFileSync(origProfiles, 'utf-8')) as Record<string, unknown>;
        if (isScoped) {
          const filtered: Record<string, unknown> = {};
          for (const name of scopes) {
            if (profiles[name] !== undefined) filtered[name] = profiles[name];
          }
          profiles = filtered;
        }
        fs.writeFileSync(path.join(dest, 'profiles.yml'), YAML.stringify(profiles), { mode: 0o600 });
        mounts.push({ hostPath: dest, containerPath: '/home/node/.dbt', readonly: true });
      } catch (err) {
        log.warn('dbt profiles stage failed — skipping mount (fail closed)', {
          agent: agentGroup.folder,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

export function resolveWorkgroupMemoryMount(workgroupId: string, dataDir: string = DATA_DIR): VolumeMount {
  return {
    hostPath: workgroupMemoryDir(workgroupId, dataDir),
    containerPath: WORKGROUP_MEMORY_CONTAINER_PATH,
    readonly: false,
  };
}

export const WORKGROUP_MEMORY_LOCK_CONTAINER_PATH = `${WORKGROUP_CONTAINER_PATH}/.memory-write.lock`;

/**
 * Prepare the stable workgroup-wide kernel-lock inode and return its exact
 * file bind mount. The sidecar lives beside (never inside) the canonical
 * memory tree, so coordination metadata cannot affect memory tree hashes.
 *
 * The first caller creates the file exclusively at 0600. Later callers only
 * inspect the existing inode through O_NOFOLLOW and never truncate, unlink, or
 * rewrite it; the in-container writer owns the flock-protected metadata.
 */
export function resolveWorkgroupMemoryLockMount(workgroupId: string, dataDir: string = DATA_DIR): VolumeMount {
  const workgroupDir = path.dirname(workgroupMemoryDir(workgroupId, dataDir));
  const lockPath = path.join(workgroupDir, '.memory-write.lock');
  fs.mkdirSync(workgroupDir, { recursive: true });

  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'wx+', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  }

  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Workgroup memory lock is not a regular file: ${lockPath}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  return {
    hostPath: lockPath,
    containerPath: WORKGROUP_MEMORY_LOCK_CONTAINER_PATH,
    readonly: false,
  };
}

/** Provider-neutral nested mounts, ordered memory first and lock overlay last. */
export function resolveWorkgroupMemoryMounts(workgroupId: string, dataDir: string = DATA_DIR): VolumeMount[] {
  return [resolveWorkgroupMemoryMount(workgroupId, dataDir), resolveWorkgroupMemoryLockMount(workgroupId, dataDir)];
}

export function replaceClaudeNativeMemoryMount(
  claudeMounts: readonly VolumeMount[],
  options: {
    provider: string;
    agentGroupId: string;
    workgroupId: string;
    dataDir?: string;
  },
): VolumeMount[] {
  const dataDir = options.dataDir ?? DATA_DIR;
  const expectedNative: VolumeMount = {
    hostPath: path.join(
      dataDir,
      'v2-sessions',
      options.agentGroupId,
      '.claude-shared',
      'projects',
      CLAUDE_CODE_PROJECTS_DIR,
      'memory',
    ),
    containerPath: `/home/node/.claude/projects/${CLAUDE_CODE_PROJECTS_DIR}/memory`,
    readonly: false,
  };
  const actualNative = claudeMounts.at(-1);
  if (
    !actualNative ||
    actualNative.hostPath !== expectedNative.hostPath ||
    actualNative.containerPath !== expectedNative.containerPath ||
    actualNative.readonly !== expectedNative.readonly
  ) {
    throw new Error(`Provider ${options.provider} did not return the exact final Claude native-memory mount contract`);
  }
  return [
    ...claudeMounts.slice(0, -1),
    {
      hostPath: workgroupMemoryDir(options.workgroupId, dataDir),
      containerPath: expectedNative.containerPath,
      readonly: true,
    },
  ];
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>)
 * so it's dangling on the host but valid inside the container.
 */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink: boolean;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Every worker-def filename this feature has ever shipped. Load-bearing for
 * SECURITY: prune targets come ONLY from this trusted in-source list, never
 * from container-writable state — `.claude-shared/agents/` is RW-mounted into
 * the container (session-claude-mounts.ts), so an earlier design that read a
 * manifest file from there let an agent poison it with `../../../v2.db` and
 * make the host delete an arbitrary path on the next spawn. When you RENAME or
 * REMOVE a def from container/agents/, add its OLD filename here so it gets
 * pruned from groups that already have it. Current names may stay listed
 * (they're re-copied every spawn, so listing them is a harmless no-op).
 */
const MANAGED_WORKER_DEFS = [
  'worker-fast.md',
  'worker.md',
  'worker-high.md',
  'worker-codex.md',
  // Retired: renamed to worker-high.md so the tier name describes the rung
  // rather than a Claude model (the same def is gpt-5.6-sol on Codex). Listed
  // so groups that already have the old file get it pruned on next spawn.
  'worker-opus.md',
];

/**
 * Copy trunk worker subagent defs (container/agents/*.md) into
 * .claude-shared/agents/ — the container's ~/.claude/agents — so every Claude
 * group gets the orchestrator worker roster (worker-fast, worker, worker-high,
 * worker-codex). Copies, not symlinks: agent discovery through dangling host
 * symlinks is unverified, and the files are tiny. Trunk is canonical: a
 * managed def absent from the current trunk set is pruned; operator-added defs
 * (never in MANAGED_WORKER_DEFS) are untouched. A group can shadow a trunk def
 * with a same-name file in groups/<folder>/.claude/agents/ (project scope
 * outranks user scope).
 */
function syncWorkerAgentDefs(claudeDir: string): void {
  const srcDir = path.join(process.cwd(), 'container', 'agents');
  if (!fs.existsSync(srcDir)) return;
  const dstDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(dstDir, { recursive: true });

  const current = new Set(fs.readdirSync(srcDir).filter((e) => e.endsWith('.md')));
  // Prune managed defs retired from trunk. Names are compile-time constants,
  // so no traversal is possible even though dstDir is container-writable.
  for (const name of MANAGED_WORKER_DEFS) {
    if (!current.has(name)) {
      try {
        fs.rmSync(path.join(dstDir, name), { force: true });
      } catch {
        /* e.g. a dir shadowing the name — skip; not worth aborting the spawn */
      }
    }
  }
  for (const entry of current) {
    fs.copyFileSync(path.join(srcDir, entry), path.join(dstDir, entry));
  }
}

/**
 * Ensure container.json has the runtime identity fields the runner needs.
 * Written at spawn time so they're always current even if the DB values
 * change (e.g. group rename). Only writes if values differ to avoid
 * unnecessary file churn.
 */
function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): void {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  // NOTE: `assistantName` is NOT force-synced here. The agent's user-facing
  // name varies per channel — the same agent_group can show as "Example Assistant" in
  // Slack, "Example Agent" in Discord, etc. The per-session resolver lives in
  // `resolveAssistantName` below; container-runner passes the result as
  // the NANOCLAW_ASSISTANT_NAME env var on every spawn so the in-container
  // runner can prefer it over container.json's static value. Keeping the
  // file untouched preserves whatever the operator (or
  // `container_configs.assistant_name`) wrote without per-channel churn.
  if (dirty) {
    // Race-safe write: re-read container.json immediately before persisting
    // and merge our identity fields onto the freshest disk state. Without
    // this, a concurrent config-mutating script can have its
    // update silently clobbered when our write lands later in the spawn
    // flow with a stale in-memory containerConfig.
    //
    // This read/merge/write shape preserves any operator-owned fields written
    // after the spawn began.
    const fresh = readContainerConfig(agentGroup.folder);
    fresh.agentGroupId = agentGroup.id;
    fresh.groupName = agentGroup.name;
    writeContainerConfig(agentGroup.folder, fresh);
    // Sync the in-memory copy with anything the concurrent writer may have
    // added between our read and write — downstream spawn code reads other
    // fields from containerConfig and would otherwise miss those updates.
    if (fresh.tools !== undefined) containerConfig.tools = fresh.tools;
    if (fresh.mcpServers !== undefined) containerConfig.mcpServers = fresh.mcpServers;
  }
}

/**
 * Per-session resolution of the agent's user-facing name. Used to populate
 * `NANOCLAW_ASSISTANT_NAME` for every spawn.
 *
 * Precedence:
 *   1. `container_configs.assistant_name` (operator-set per-agent override —
 *      already merged into `containerConfig.assistantName` by readContainerConfig)
 *      WHEN it differs from `agent_group.name` (i.e., operator-intentional).
 *   2. Platform bot display from the session's channel — what users actually
 *      see in chat. Slack first (most installs), then Discord.
 *   3. `agent_group.name` (structural fallback — admin/cli sessions, freshly-
 *      booted adapters before identity fetch completes).
 *
 * Same agent_group routed to different channels gets different names; on the
 * Slack Example Retail channel "Example Assistant", on Discord "Example Agent", on admin sessions "example-retail".
 */
export async function resolveAssistantName(
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  sessionMessagingGroupId: string | null,
): Promise<string> {
  // Operator-set explicit override (CLI: `ncl groups config update <id> --assistant-name=…`).
  // `readContainerConfig` collapses `row.assistant_name ?? group.name` so we
  // can only tell it's operator-set when it diverges from `group.name`.
  if (containerConfig.assistantName && containerConfig.assistantName !== agentGroup.name) {
    return containerConfig.assistantName;
  }

  if (sessionMessagingGroupId) {
    const { getMessagingGroup } = await import('./db/messaging-groups.js');
    const mg = getMessagingGroup(sessionMessagingGroupId);
    if (mg) {
      const { getSlackBotDisplayName } = await import('./channels/slack-mentions.js');
      const slack = getSlackBotDisplayName(mg.channel_type);
      if (slack) return slack;
      const { getDiscordBotDisplayName } = await import('./channels/discord.js');
      const discord = getDiscordBotDisplayName(mg.channel_type);
      if (discord) return discord;
    }
  }

  return agentGroup.name;
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
export function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  const requested =
    containerConfig.skills === 'all'
      ? (() => {
          const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
          return fs.existsSync(sharedSkillsDir)
            ? fs
                .readdirSync(sharedSkillsDir)
                .filter((entry) => {
                  try {
                    return fs.statSync(path.join(sharedSkillsDir, entry)).isDirectory();
                  } catch {
                    return false;
                  }
                })
                .sort()
            : [];
        })()
      : containerConfig.skills;

  return [...new Set([...requested, 'graphify'])];
}

/** Universal, bounded Graphify runtime flags applied to every provider. */
export function graphifyContainerArgs(): string[] {
  return [
    '-e',
    'NANOCLAW_CONTAINER=1',
    '--tmpfs',
    '/workspace/.graphify-stage:rw,size=201326592,mode=0700,uid=1001,gid=1001',
  ];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  channelDefaults?: {
    channelDefaultModel: string | null;
    channelDefaultEffort: string | null;
    channelDefaultTone: string | null;
  },
  sessionMessagingGroupId?: string | null,
  // Resolved workgroup id from spawnContainer → reconcileWorkgroupAtSpawn.
  // Threaded in so NANOCLAW_WORKGROUP_ID and the workgroup OneCLI secret
  // resolution stay aligned with the /workspace/workgroup mount and the
  // archive projection (race-fix).
  resolvedWgId?: string,
  /**
   * Set when a spawn-time provider fallback diverged from container.json.
   * Drives the NANOCLAW_PROVIDER_OVERRIDE/_MODEL_OVERRIDE bridge — the
   * container reads its provider from the bind-mounted file, which the host
   * does not rewrite per spawn.
   */
  providerFallbackApplied?: boolean,
  /**
   * Routing id of this session's thread, surfaced as NANOCLAW_THREAD_ID.
   * The `work-claims` skill stamps it onto a claim so an escalation can link
   * back to where the work was happening — the field it used to write
   * (`session_id`) was free text and resolved to nothing. Null for
   * channel-level sessions, which have no thread to link to.
   */
  sessionThreadId?: string | null,
  repositoryWorkUnit?: RepositoryWorkUnit,
): Promise<string[]> {
  // --init: tini as PID 1 reaps orphaned children (esbuild/gh corpses were
  // accumulating as zombies under bun, which doesn't reap as PID 1) and still
  // forwards signals to the entrypoint, so SIGTERM handling is unchanged.
  const args: string[] = ['run', '--rm', '--init', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];
  args.push(...dockerResourceLimitArgs(containerConfig.resources));
  args.push(...graphifyContainerArgs());

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Claude Code behavior locks — duplicated from settings.json env block so
  // the values are set regardless of the SDK's settings-loading order.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
  // Allow long foreground worker-codex calls without lengthening the default
  // timeout for ordinary Bash calls.
  args.push('-e', 'BASH_MAX_TIMEOUT_MS=3600000');
  args.push('-e', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80');
  // Claude Code 2.1+ has a built-in auto-compact window default that is well
  // under 200k even when the session uses a 1M-context model (claude-opus-4-7[1m]).
  // Without this override, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 fires against the
  // CLI's small default window — sessions compact far earlier than the model's
  // actual capacity. Setting 1_000_000 matches the [1m] capacity so 80% fires
  // around 800k tokens. For non-[1m] sessions the percentage-based trigger still
  // fires at 80% of the model's own context window before this override matters.
  // The CLI itself hints at this value: "override with CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000".
  args.push('-e', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000');
  // (Removed 2026-06-10: CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 +
  // MAX_THINKING_TOKENS=127999. They forced the CLI's legacy fixed-budget
  // thinking mode for explicit 4-6 selections so thinking blocks stayed
  // visible for progress labels — superseded by the provider passing
  // `thinking: {type: 'adaptive', display: 'summarized'}` on every query
  // (claude.ts), which yields visible summarized thinking on every 4.6+
  // model, and they could conflict with always-adaptive models like
  // claude-fable-5 that reject non-adaptive thinking.)

  // Default `opus` alias resolution and default effort. The constants
  // at the top of this file (DEFAULT_OPUS_MODEL etc.) are the single
  // source of truth — they're the only "default" surface. Per-channel
  // and per-group layers can override; per-session flags override on
  // top of those. Short aliases (opus46, opus47, etc.) live in the
  // agent-runner flag parser's MODEL_ALIAS_MAP, independent of these.
  //
  // Precedence (most specific wins):
  //   1. Per-session flag in chat (-m / -m1 / -e / -e1) — handled inside
  //      the agent-runner's flag parser, not here.
  //   2. Per-channel wiring (messaging_group_agents.default_model/effort)
  //      — passed via channelDefaults when session has a messaging_group.
  //   3. Per-agent container.json (defaultModel / defaultEffort) —
  //      applies to every channel wired to this agent unless (2) overrides.
  //   4. The DEFAULT_* constants above.
  //
  // ANTHROPIC_DEFAULT_<FAMILY>_MODEL is the SDK's alias resolver
  // short-circuit: whatever string is in that env var gets sent to the
  // API verbatim when the agent or a subagent uses the bare alias.
  // ensureOpus1mSuffix is load-bearing here: a bare `claude-opus-*` reaching
  // ANTHROPIC_DEFAULT_OPUS_MODEL (e.g. via set_channel_model, which does not
  // resolve aliases, or a hand-set channel/container default) makes the CLI's
  // auto-compact window collapse to 200k under proxy auth and force-compact
  // long sessions. Normalizing at this consumption point guarantees the 1M
  // window regardless of how a bare value got into the DB.
  // Bare FAMILY aliases in a channel/group default (`sonnet`, `opus`,
  // `haiku`) resolve to the DEFAULT_* constants at this same consumption
  // point. This lets an operator pin a channel to "current sonnet" instead
  // of a frozen concrete id — a future family-default bump (e.g. Sonnet 5 →
  // 5.1) then propagates on respawn with no DB edit. Without this, the bare
  // alias would reach the API verbatim and 400 (see comment above).
  // Channel defaults are provider-specific. A Codex wiring must not be sent
  // through Claude's ANTHROPIC_* aliases (and, during a provider fallback,
  // must not pin the fallback to the primary provider's model). The runner
  // applies the channel layer only while the primary provider is active;
  // fallback model/effort travel through the existing provider-fallback bridge
  // below.
  const activeChannelModel = providerFallbackApplied ? null : channelDefaults?.channelDefaultModel;
  const activeChannelEffort = providerFallbackApplied ? null : channelDefaults?.channelDefaultEffort;

  if (provider === 'codex') {
    // The Codex provider reads model/reasoning_effort from its strict
    // providerConfig schema. These spawn-scoped envs are overlaid into that
    // config by agent-runner/src/config.ts, so a per-channel pin beats the
    // per-agent container config without mutating the mounted file.
    const codexModel = activeChannelModel ?? containerConfig.model ?? containerConfig.defaultModel;
    const codexEffort = activeChannelEffort ?? containerConfig.effort ?? containerConfig.defaultEffort;
    if (codexModel) args.push('-e', `NANOCLAW_CODEX_MODEL_OVERRIDE=${codexModel}`);
    if (codexEffort) args.push('-e', `NANOCLAW_CODEX_EFFORT_OVERRIDE=${codexEffort}`);
  } else {
    // resolveEffectiveModel maps family aliases first (so `opus` keeps
    // tracking DEFAULT_OPUS_MODEL rather than freezing), then pinned short
    // aliases (`opus5`, `opus48`, `sonnet5`, `fable`), then applies
    // ensureOpus1mSuffix to bare ids. The chat ack calls the same function, so
    // the confirmation the user sees is exactly what lands in
    // ANTHROPIC_DEFAULT_OPUS_MODEL here.
    const rawDefaultModel = activeChannelModel ?? containerConfig.defaultModel ?? DEFAULT_OPUS_MODEL;
    const defaultOpusModel = resolveEffectiveModel(rawDefaultModel);
    args.push('-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${defaultOpusModel}`);
    args.push('-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`);
    args.push('-e', `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`);

    // NANOCLAW_EFFORT_OVERRIDE is an OPERATOR override (per-channel wiring or
    // per-group container.json) — injected only when one is actually set.
    // When absent, the claude provider applies per-model-family defaults.
    const defaultEffort = activeChannelEffort ?? containerConfig.defaultEffort;
    if (defaultEffort) {
      args.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${defaultEffort}`);
    }
  }

  // Provider fallback bridge. The container reads its provider and model from
  // the bind-mounted container.json, which the host does not rewrite per
  // spawn — so a spawn-time fallback has to travel as env, exactly like
  // NANOCLAW_ASSISTANT_NAME beats the file's static value. Emitted only when
  // the effective provider actually diverges from the file, so a normal
  // spawn's environment is unchanged.
  if (providerFallbackApplied && containerConfig.provider) {
    args.push('-e', `NANOCLAW_PROVIDER_OVERRIDE=${containerConfig.provider}`);
    if (containerConfig.model) {
      args.push('-e', `NANOCLAW_MODEL_OVERRIDE=${containerConfig.model}`);
    }
  }

  // Per-channel default tone profile — ports v1's "always-on tone" feature.
  // Precedence: per-channel wiring (messaging_group_agents.default_tone) →
  // per-agent container.json `tone` → unset (agent falls back to the
  // get_tone_profile MCP tool for on-demand selection). Profile content
  // injection happens container-side in agent-runner/src/index.ts.
  const defaultTone = channelDefaults?.channelDefaultTone ?? containerConfig.tone ?? null;
  if (defaultTone) {
    args.push('-e', `NANOCLAW_DEFAULT_TONE=${defaultTone}`);
  }

  // Per-session assistant name. Resolved channel-aware so the same
  // agent_group can say "I am Example Assistant" on Slack Example Retail, "I am Example Agent" on Discord, etc.
  // The in-container runner prefers NANOCLAW_ASSISTANT_NAME over
  // container.json's static value (see container/agent-runner/src/config.ts).
  // Falls back to agent_group.name when no channel bot is registered
  // (admin/cli sessions, freshly-booted adapters).
  const resolvedAssistantName = await resolveAssistantName(
    agentGroup,
    containerConfig,
    sessionMessagingGroupId ?? null,
  );
  args.push('-e', `NANOCLAW_ASSISTANT_NAME=${resolvedAssistantName}`);
  if (sessionThreadId) args.push('-e', `NANOCLAW_THREAD_ID=${sessionThreadId}`);
  if (repositoryWorkUnit) {
    args.push('-e', `NANOCLAW_HOST_DATA_DIR=${DATA_DIR}`);
    args.push('-e', `NANOCLAW_HOST_TOPIC_WORKTREES_DIR=${topicWorktreesDir(repositoryWorkUnit)}`);
    args.push('-e', `NANOCLAW_WORK_UNIT_KEY=${repositoryWorkUnit.key}`);
  }

  // Workgroup awareness — the agent learns which workgroup (multi-agent
  // tenant boundary) it belongs to, so prompts grounded in "my workgroup is
  // X" reach the right scope. Omitted when the agent has no workgroup row
  // (pre-migration-036 installs / fresh standalone agents).
  //
  // Read directly from the DB rather than from `agentGroup` because the
  // typed `AgentGroup` interface doesn't surface workgroup_id (column was
  // added in migration 036; the row carries it but the type predates it).
  // Mirrors the existing W3 fail-closed lookup at container-runner.ts:1068.
  //
  // Try/catch fail-soft: pre-migration-036 installs don't have the
  // workgroup_id column at all. `SELECT workgroup_id FROM ...` throws
  // `no such column` on those schemas. Codex P1 on PR #113 caught this
  // turning a best-effort prompt addendum into a hard spawn failure.
  // The W3 path at line 1066 uses PRAGMA table_info to guard the same
  // case; here we use try/catch because the workgroup line is purely
  // additive — silent fall-through is the right semantic.
  try {
    // Use the resolved wgId from spawnContainer when available — same value
    // the /workspace/workgroup mount + archive projection already saw.
    const wgId =
      resolvedWgId ??
      (
        getDb().prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(agentGroup.id) as
          | { workgroup_id: string | null }
          | undefined
      )?.workgroup_id;
    if (wgId) {
      args.push('-e', `NANOCLAW_WORKGROUP_ID=${wgId}`);
    }
  } catch {
    // Pre-migration-036 schema. Omit the env var; the container's
    // buildSystemPromptAddendum already treats absence as "no workgroup".
  }

  // Peer identity injection — every agent_group operating on the same
  // platform-side channel as THIS session, with its bot user_id resolved
  // for canonical `<@U…>` mentions. The container's
  // buildSystemPromptAddendum reads NANOCLAW_PEERS and renders an
  // identity block: "You are X (@handle, <@uid>). Peers: ...". This gives the
  // model an explicit self and peer name→user_id mapping per turn so prose handoff
  // ("@Example Assistant Codex" → `<@UTEST00024>`) doesn't depend on chat-history
  // inference. Self user_id is included separately so the agent
  // recognizes inbound @-mentions to itself.
  //
  // Sibling-adapter awareness: Example Assistant and Example Assistant Codex on the same Slack channel
  // have separate messaging_groups (one per bot adapter). getChannelPeers
  // matches on messaging_groups.platform_id, surfacing peers across
  // sibling adapters. See src/db/messaging-groups.ts for the rationale.
  //
  // Empty when the agent has no session-side messaging_group (admin/cli
  // shell) or no other agent is wired to the platform channel. The
  // container treats absence as "no peers" and omits the section.
  if (sessionMessagingGroupId) {
    const { getChannelPeers, getMessagingGroup } = await import('./db/messaging-groups.js');
    const { getSlackBotDisplayName, getKnownSlackBots } = await import('./channels/slack-mentions.js');
    const { getDiscordBotDisplayName, getKnownDiscordBots } = await import('./channels/discord.js');
    const peers = getChannelPeers(sessionMessagingGroupId, agentGroup.id);
    const slackBots = getKnownSlackBots();
    const discordBots = getKnownDiscordBots();
    const peerEntries = peers.map((p) => {
      // Look up user_id in EITHER registry — channel_type is the disjoint
      // key (Slack channel_types start with `slack-`, Discord with
      // `discord-`). Slack registry wins when both happen to be populated
      // for a given channel_type (shouldn't occur in practice).
      const slackBot = slackBots.get(p.channel_type);
      const discordBot = discordBots.get(p.channel_type);
      let userId: string | undefined;
      let name: string = p.name;
      if (slackBot) {
        userId = slackBot.userId;
        name = getSlackBotDisplayName(p.channel_type) ?? p.name;
      } else if (discordBot) {
        userId = discordBot.userId;
        name = getDiscordBotDisplayName(p.channel_type) ?? p.name;
      }
      return { name, userId };
    });
    // Self identity — same dual-registry lookup. The channel-facing display
    // name is deliberately distinct from assistantName: an operator may call
    // this agent "ollie" while Slack routes it as @illie-codex. Supplying
    // both aliases prevents the model from treating its own platform mention
    // as a request for a sibling.
    const selfMg = getMessagingGroup(sessionMessagingGroupId);
    let selfUserId: string | undefined;
    let selfName: string | undefined;
    if (selfMg) {
      const slackBot = slackBots.get(selfMg.channel_type);
      const discordBot = discordBots.get(selfMg.channel_type);
      if (slackBot) {
        selfUserId = slackBot.userId;
        selfName = getSlackBotDisplayName(selfMg.channel_type) ?? undefined;
      } else if (discordBot) {
        selfUserId = discordBot.userId;
        selfName = getDiscordBotDisplayName(selfMg.channel_type) ?? undefined;
      }
    }
    if (peerEntries.length > 0 || selfUserId || selfName) {
      args.push(
        '-e',
        `NANOCLAW_PEERS=${JSON.stringify({ self: { name: selfName, userId: selfUserId }, peers: peerEntries })}`,
      );
    }
  }

  // v1 settings.json env block (src/container-runner.ts:1703-1709): SDK
  // capabilities that need explicit opt-in. Porting as plain env since
  // v2's container reads env, not a settings.json mount point.
  args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  args.push('-e', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1');
  args.push('-e', 'ENABLE_TOOL_SEARCH=true');

  // Forward CODEX_FALLBACK_HOMES when fallback codex auth dirs were mounted.
  // Source of truth is the mounts array — buildMounts decided which entries
  // survived (auth.json exists, not deduped against primary). Reconstructing
  // from mounts keeps the env var aligned with what's actually accessible.
  // Format: colon-joined container paths in mount order, which is the same
  // as declaration order in codexAuthFallbacks (see resolveCodexAuthFallbacks).
  const codexFallbackPaths = mounts
    .filter((m) => /^\/home\/node\/\.codex-fallback-\d+$/.test(m.containerPath))
    .map((m) => m.containerPath);
  if (codexFallbackPaths.length > 0) {
    args.push('-e', `CODEX_FALLBACK_HOMES=${codexFallbackPaths.join(':')}`);
  }

  if (mounts.some((m) => m.containerPath === CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH)) {
    args.push('-e', `CODEX_PRIMARY_HOST_HOME=${CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH}`);
  }

  // Credential-lookup folder. Defaults to `agent_groups.folder`; sibling
  // groups (codex clones, etc.) can override via container.json's
  // `credentialFolder` field to inherit the source group's scoped env vars
  // (LOOKER_*, DBT_*, GITHUB_TOKEN_*, RENDER_PG_*, GIT_AUTHOR_*, Claude
  // OAuth, Codex auth dir, etc.) without duplicating every var with a
  // sibling-specific suffix.
  //
  // Identity-bound concerns (containerName, group dir mount, log fields)
  // stay on `agentGroup.folder` so siblings
  // remain individually addressable.
  const credentialFolder = containerConfig.credentialFolder ?? agentGroup.folder;

  // GCP service-account key (BigQuery / gcloud / gsutil). Resolved once here;
  // drives the ADC env vars below and the googleapis.com proxy bypass further
  // down. null (no key file) for every group that hasn't opted in.
  const gcpKey = resolveGcpServiceAccountKey(credentialFolder);

  // Per-group Anthropic credentials. Default behaviour reads the global
  // `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` (and `_N` rotation
  // siblings); the per-group form `<BASE>_<FOLDER_UPPER>` overrides the
  // global and pins the *entire* rotation set to the workplace/account
  // tokens for this group only — preventing fallback onto a different
  // account on retryable errors.
  // Pass ALL Anthropic credential keys from `.env` read fresh at spawn — base,
  // scoped `_<FOLDER>`, and numbered `_N` (and scoped-numbered) variants — so
  // resolveScopedRotationSet can let disk win over the host's stale startup
  // snapshot. This makes per-group token edits take effect on the next
  // container respawn without a full host restart, and recovers a
  // placeholder-shadowed global primary. See resolveScopedRotationSet.
  // (Incidents 2026-06-25, 2026-06-27.)
  const auth = resolveAnthropicAuth(
    credentialFolder,
    process.env,
    readEnvFileMatching(/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(_|$)/),
  );

  // Anthropic custom-upstream auth (ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY)
  // is forwarded inside the OneCLI gateway block below, after the gateway
  // applies, so the custom host can be excluded from the proxy via NO_PROXY
  // and the forwarded key is authoritative. See the bypass block there.

  // OAuth path (Claude Max subscription). When CLAUDE_CODE_OAUTH_TOKEN is
  // set on the host we forward it + any CLAUDE_CODE_OAUTH_TOKEN_N fallbacks
  // so the provider can rotate through multiple Max accounts on retryable
  // errors (weekly cap, 429, rate_limit). The OneCLI proxy is still applied
  // below, but we add api.anthropic.com to NO_PROXY so Anthropic traffic
  // bypasses OneCLI's credential-injection layer — otherwise the proxy
  // overwrites whatever OAuth the SDK sent with the single vault entry,
  // defeating in-process rotation. Everything else (Gmail, GitHub, Exa,
  // Braintrust, etc.) still routes through OneCLI.
  const hostOauth = auth.oauthPrimary;
  const oauthBypassAnthropic = Boolean(hostOauth);
  if (hostOauth) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
    for (const fb of auth.oauthFallbacks) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}=${fb.value}`);
    }
  }

  // GitHub token for git-over-HTTPS + `gh` CLI. Per-agent-group: resolves
  // from container.json `githubTokenEnv`, then from
  // `GITHUB_TOKEN_<FOLDER_UPPER>`, then falls back to `GITHUB_TOKEN`.
  // OneCLI's proxy model doesn't fit git auth — we pass the real token.
  const ghToken = resolveGitHubToken(credentialFolder, containerConfig);
  if (ghToken) {
    args.push('-e', `GH_TOKEN=${ghToken}`);
    args.push('-e', `GITHUB_TOKEN=${ghToken}`);
    // Optional URL-scoped credential allowlist. When set, entrypoint.sh
    // configures git's credential helper to only return the token for the
    // listed orgs (comma-separated), and skips the global `gh auth login`
    // so gh's own auth store can't bypass the URL scope. Without this,
    // a container with a broad GitHub token can clone/push to any org
    // the token grants. Per-agent-group via GITHUB_ALLOWED_ORGS_<FOLDER>.
    const ghOrgs = resolveScopedEnv('GITHUB_ALLOWED_ORGS', credentialFolder);
    if (ghOrgs) args.push('-e', `GITHUB_ALLOWED_ORGS=${ghOrgs}`);
  } else {
    log.warn('No GitHub token resolved for agent group — git push/PR will fail', {
      folder: agentGroup.folder,
    });
  }

  // Claude Code SDK reads this to discover plugins at
  // /workspace/plugins/<name>/ (mounted by buildMounts from ~/plugins/).
  args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');
  // Loop root for the design-artifact-loop skill: the vendored SKILL.md tells the
  // agent "$DESIGN_ARTIFACT_LOOP_ROOT if set" — export it to the agent's shell so
  // that instruction is TRUE in containers and authoring lands where the vendored
  // design_review tool (pinned to the same path by its wrapper) will accept it.
  args.push('-e', 'DESIGN_ARTIFACT_LOOP_ROOT=/workspace/agent/design-artifact-loop');

  // Scoped credential env vars: each base resolves via
  // `<BASE>_<FOLDER_UPPER>` → `<BASE>` and is injected if found.
  for (const base of SCOPED_CREDENTIAL_VARS) {
    const v = resolveScopedEnv(base, credentialFolder);
    if (v) args.push('-e', `${base}=${v}`);
  }

  // Folder-scoped verbatim env vars: pass through env vars whose name starts
  // with a known prefix AND whose post-prefix tail starts with the folder
  // token followed by `_` or end-of-string. These are raw connection strings
  // (RENDER_PG_URL_EXAMPLE_LABS_example-app_MAIN, etc.) that don't collapse to a base
  // name — the agent uses the full name as-is. Gate on folder to keep
  // cross-group data access from leaking.
  //
  // SECURITY (cross-tenant audit 2026-05-03): the previous check used
  // `includes('_<TOK>_')`, which let folder=example-agent inherit EXAMPLE_DEV_* vars
  // (substring overlap with example-dev). The strict prefix-anchored match
  // here, combined with the folder-name collision check at create_agent
  // time, eliminates the ambiguity.
  const folderTok = credentialFolder.toUpperCase().replace(/-/g, '_');
  const verbatimPrefixes = ['RENDER_PG_', 'RENDER_REDIS_URL_'];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    const matchedPrefix = verbatimPrefixes.find((p) => k.startsWith(p));
    if (!matchedPrefix) continue;
    const tail = k.slice(matchedPrefix.length);
    if (tail !== folderTok && !tail.startsWith(`${folderTok}_`)) continue;
    args.push('-e', `${k}=${v}`);
  }

  // GCP credentials: point ADC / client libs at the mounted key and default the
  // project from the key's own `project_id`, so client libs and `bq`/`gcloud`
  // (once the agent-runner activates the service account at startup) need no
  // flags. Set regardless of gateway state since ADC works without the proxy;
  // the googleapis.com bypass is added later in the gateway block. Lockstep
  // with the mount via `gcpKey`.
  if (gcpKey) {
    args.push('-e', `GOOGLE_APPLICATION_CREDENTIALS=${GCP_KEY_CONTAINER_PATH}`);
    // Redirect gcloud's config dir to a node-writable path (see const comment).
    args.push('-e', `CLOUDSDK_CONFIG=${GCP_CLOUDSDK_CONFIG_CONTAINER_PATH}`);
    try {
      const projectId = (JSON.parse(fs.readFileSync(gcpKey, 'utf-8')) as { project_id?: string }).project_id;
      if (projectId) {
        args.push('-e', `CLOUDSDK_CORE_PROJECT=${projectId}`);
        args.push('-e', `GOOGLE_CLOUD_PROJECT=${projectId}`);
      }
    } catch (err) {
      log.warn('GCP service-account key unreadable for project default — agent must pass --project', {
        folder: credentialFolder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  const providerEnv = { ...(providerContribution.env ?? {}) };
  // OpenCode reads its model/effort selectors directly from OPENCODE_* env
  // vars (the provider contribution supplies the per-agent DB defaults). A
  // channel wiring is more specific, so replace those values before emitting
  // the environment rather than relying on duplicate Docker `-e` flags. The
  // same path covers an OpenCode provider fallback, where containerConfig has
  // already been replaced with the declared fallback model/effort.
  if (provider === 'opencode') {
    const opencodeModel = activeChannelModel ?? (providerFallbackApplied ? containerConfig.model : undefined);
    const opencodeEffort = activeChannelEffort ?? (providerFallbackApplied ? containerConfig.effort : undefined);
    if (opencodeModel) providerEnv.OPENCODE_MODEL = opencodeModel;
    if (opencodeEffort) providerEnv.OPENCODE_EFFORT = opencodeEffort;
  }
  for (const [key, value] of Object.entries(providerEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection.
  // Must ensureAgent first for non-admin groups, otherwise applyContainerConfig
  // rejects the unknown agent identifier and returns false.
  //
  // The gateway runs for EVERY container so all tools (Slack, GitHub,
  // Snowflake, Exa, …) get vault credential injection. When the operator
  // routes Anthropic to a custom upstream via ANTHROPIC_BASE_URL, only that
  // one host is excluded from the proxy (NO_PROXY entry added in the bypass
  // block below, alongside the OAuth bypass) and authenticates with the
  // forwarded ANTHROPIC_API_KEY — OneCLI keeps handling every other host.
  // Same per-host bypass mechanism already used for snowflake/aws/github.
  //
  // Gateway failure is treated as transient and throws — the caller
  // (router/host-sweep) catches, leaves the inbound message pending, and the
  // next sweep tick retries. Spawning a container with no credentials would
  // only mask the misconfiguration.
  {
    // The OneCLI identity this container's proxy is wired to. Defaults to the
    // per-group identity; a non-owner-safe session carrying a Slack user-token
    // secret is reassigned to `<group>-noslack` below (Slack withheld).
    let effectiveIdentifier = agentIdentifier;
    if (agentIdentifier) {
      // Per-group + workgroup secret scoping — declarative model, fail-closed.
      // Workgroup-level secrets are the baseline; per-group onecliSecrets extend
      // (additive) — neither list can subtract from the other. No-op when the
      // merged list is empty (preserves whatever assignment the operator set via
      // UI/CLI — e.g. the 3 mode-all agents intentionally left untouched).
      // Use the resolved wgId from spawnContainer when available — the JOIN on
      // agent_groups.workgroup_id below can return a different workgroup if a
      // concurrent reconcile flipped it between reconcileWorkgroupAtSpawn
      // and this lookup (race-fix).
      const workgroupSecrets = resolvedWgId
        ? getWorkgroupOnecliSecretsById(resolvedWgId)
        : getWorkgroupOnecliSecrets(agentGroup.id);
      const mergedSecrets = mergeWorkgroupAndGroupSecrets(workgroupSecrets, containerConfig.onecliSecrets);

      // Slack user-token scoping — the credential-layer half of the Slack
      // boundary (the MCP half is canUseSlackUserToken below). The OneCLI
      // agent identity is per-GROUP, so all sessions of this group share one
      // secret set; we cannot strip Slack per-session on a single identity
      // without racing concurrent sessions. Instead, non-owner-safe sessions
      // (a Slack-credential-trust classification — NOTHING to do with
      // session_mode; every channel stays per-thread) spawn under a SECOND
      // identity `<group>-noslack` whose secret set excludes the Slack user
      // token. The proxy then has no Slack token to inject for that container →
      // both `curl slack.com/api/*` and the MCP fail closed. Owner-safe sessions
      // (owner DM or also_allowed_in) keep the
      // primary identity + full set. Only ONE extra identity per affected
      // group, so well clear of the gateway's list-pagination ceiling.
      //
      // Suffix is `-noslack` (not `::shared`) because OneCLI identifiers are
      // constrained to lowercase letters, numbers, and hyphens (`onecli agents
      // create --identifier`). agentGroup.id already satisfies that, so the
      // suffixed form is valid. Collision would require a real agent_group
      // literally named `<group>-noslack`, which we never create.
      const slackSecrets = slackUserTokenSecrets(mergedSecrets, containerConfig.slack_user_token?.onecli_secret_names);
      let identity = agentIdentifier;
      let effectiveSecrets = mergedSecrets;
      if (slackSecrets.length > 0) {
        const { isOwnerSafeSlackSession } = await import('./modules/permissions/slack-user-token-gate.js');
        const ownerSafe = isOwnerSafeSlackSession(
          getDb(),
          agentGroup.id,
          sessionMessagingGroupId ?? null,
          containerConfig.slack_user_token?.also_allowed_in,
        );
        if (!ownerSafe) {
          identity = `${agentIdentifier}-noslack`;
          effectiveSecrets = mergedSecrets.filter((s) => !slackSecrets.includes(s));
          log.info('Slack user-token secret withheld for non-owner-safe session', {
            folder: agentGroup.folder,
            sessionMessagingGroupId: sessionMessagingGroupId ?? null,
            withheld: slackSecrets,
            identity,
          });
        }
      }

      await onecli.ensureAgent({
        name:
          identity === agentIdentifier ? agentGroup.name : `${agentGroup.name} (no Slack — non-owner-safe sessions)`,
        identifier: identity,
      });
      applyOnecliSecrets(identity, effectiveSecrets);
      effectiveIdentifier = identity;
    }
    const onecliApplied = await onecli.applyContainerConfig(args, {
      addHostMapping: false,
      agent: effectiveIdentifier,
    });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });

    // CA bundle env vars for bundled-CA clients. OneCLI's SDK sets
    // SSL_CERT_FILE / NODE_EXTRA_CA_CERTS / DENO_CERT, but each tool below
    // checks its own var instead. Pointing them at the combined bundle
    // makes future Python/curl/AWS clients trust OneCLI's MITM CA without
    // bespoke NO_PROXY entries. The bypasses below stay as the faster path
    // for hosts where MITM is gratuitous.
    args.push('-e', 'REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'PIP_CERT=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'CURL_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'AWS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem');

    // Proxy bypasses for hosts where OneCLI's MITM either breaks the client
    // (bundled CA) or hijacks the auth path with provider routing.
    //
    // Bundled-CA bypass — OneCLI re-signs every CONNECT with its local CA
    // even when injections_applied=0. Clients that ship their own CA bundle
    // reject this and emit "Could not connect to <backend>".
    //   - snowflake-connector-python (snowflake MCP + dbt-snowflake) → certifi
    //   - boto3 / aws-sdk, especially STS → bundled cacerts
    if (isToolEnabled(containerConfig.tools, 'snowflake') || isToolEnabled(containerConfig.tools, 'dbt')) {
      mergeNoProxy(args, 'snowflakecomputing.com');
    }
    if (isToolEnabled(containerConfig.tools, 'aws')) {
      mergeNoProxy(args, 'amazonaws.com');
    }
    // GitHub bypass — git's smart-HTTP protocol uses Basic auth
    // (base64(user:GH_TOKEN)). OneCLI v1.18.6+ recognizes github.com as a
    // known provider and tries to strip+replace that header with its
    // connected-app credential, returning 401 "app not connected
    // provider=github" for any agent without a vault link. Sending the
    // forwarded GH_TOKEN directly to GitHub authenticates both git protocol
    // and api.github.com (gh CLI) equivalently.
    if (ghToken) {
      mergeNoProxy(args, 'github.com');
    }
    // GCP bypass — the SA key mints tokens at oauth2.googleapis.com and calls
    // *.googleapis.com (BigQuery, Storage, …) directly. The key is self-
    // authenticating, so OneCLI injection adds nothing and its MITM CA breaks
    // gcloud/google-auth (they trust their own bundled roots, not the system
    // store where OneCLI's CA lives). Suffix match: a bare `googleapis.com`
    // entry covers oauth2/sts/bigquery/storage/cloudresourcemanager. Gated on
    // the mounted key so only GCP-enabled groups bypass.
    if (gcpKey) {
      mergeNoProxy(args, 'googleapis.com');
    }
    // Codex / ChatGPT bypass — codex streams via WebSocket to
    // wss://chatgpt.com/backend-api/codex/responses. OneCLI's MITM doesn't
    // speak WS Upgrade and returns 405 Method Not Allowed, so codex retries
    // five times before falling back to HTTP polling. That retry storm can
    // also stall the codex AppServer enough that getCodexAuthStatus times
    // out and reports loggedIn:false even when auth.json is valid. Bypass
    // is unconditional — non-codex agents don't talk to chatgpt.com.
    mergeNoProxy(args, 'chatgpt.com');
    // pip / Python package install bypass — pip uses certifi and rejects
    // OneCLI's CA with "SSL: CERTIFICATE_VERIFY_FAILED, self-signed
    // certificate in certificate chain". Breaks `install_packages` self-mod
    // and any Python tool that pip-installs at runtime (dbt extensions,
    // ad-hoc packages). Wheels live on files.pythonhosted.org.
    mergeNoProxy(args, 'pypi.org');
    mergeNoProxy(args, 'pythonhosted.org');

    // Wix CLI OAuth bypass — `wix login`/`whoami`/dev/publish talk to *.wix.com
    // (manage/editor/users.wix.com) with the CLI's own OAuth token from the
    // mounted ~/.wix. OneCLI's MITM on those hosts breaks the CLI ("not
    // authenticated"), same class as the chatgpt.com case above. Bypass only
    // `wix.com` (matches *.wix.com) — the Wix REST API on `www.wixapis.com` is
    // a DIFFERENT domain, so it stays on the gateway and keeps getting the
    // injected API key. Gated on the ~/.wix auth mount so only Wix-enabled
    // groups bypass.
    if (containerConfig.wixHostAuth === true) {
      mergeNoProxy(args, 'wix.com');
    }

    // OAuth bypass: when a host OAuth token is forwarded, tell the
    // in-container HTTPS_PROXY (just configured by OneCLI) to skip
    // api.anthropic.com. Without this, OneCLI's proxy would intercept the
    // Anthropic request and substitute the single vault credential,
    // defeating the provider-level rotation across CLAUDE_CODE_OAUTH_TOKEN_N.
    // We merge with any existing NO_PROXY rather than overwrite so localhost /
    // onecli internal bypasses that OneCLI added stay intact.
    //
    // Also re-append the real OAuth token values AFTER OneCLI applied,
    // because OneCLI injects `-e CLAUDE_CODE_OAUTH_TOKEN=placeholder` to
    // make the SDK happy while relying on its proxy to substitute the real
    // token at request time. Under the bypass path the proxy never fires
    // for api.anthropic.com, so the placeholder would be sent verbatim and
    // the API would reject it as an invalid bearer. Docker's `-e` duplicate-
    // key semantics: last entry wins, so pushing our real values after
    // OneCLI's placeholder is all we need.
    if (oauthBypassAnthropic) {
      mergeNoProxy(args, 'api.anthropic.com');
      // OneCLI also injects `-e ANTHROPIC_API_KEY=placeholder`. The SDK
      // prefers ANTHROPIC_API_KEY over the OAuth token, and with
      // api.anthropic.com bypassed the proxy never substitutes the real
      // value — the literal "placeholder" reaches Anthropic as the bearer
      // (401 Invalid API key; bit a provider-fallback spawn 2026-08-05).
      // Strip only the sentinel: a real key forwarded by the
      // custom-upstream block below is pushed after this and wins.
      stripEnvEntry(args, 'ANTHROPIC_API_KEY', PLACEHOLDER_SENTINEL);
      stripEnvEntry(args, 'CLAUDE_CODE_OAUTH_TOKEN');
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
      for (const fb of auth.oauthFallbacks) {
        const key = `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}`;
        stripEnvEntry(args, key);
        args.push('-e', `${key}=${fb.value}`);
      }
    }

    // Custom-upstream Anthropic auth: when ANTHROPIC_BASE_URL routes Anthropic
    // to a custom endpoint (e.g. a key-rotating proxy), exclude that one host
    // from the OneCLI proxy so its MITM doesn't intercept the request, and
    // authenticate with the forwarded ANTHROPIC_API_KEY (+ _N rotation). OneCLI
    // does not manage Anthropic in this mode; it keeps injecting for every
    // other host. Forwarded here, after the gateway applied, so these are the
    // authoritative env values.
    if (process.env.ANTHROPIC_BASE_URL) {
      args.push('-e', `ANTHROPIC_BASE_URL=${process.env.ANTHROPIC_BASE_URL}`);
      if (auth.apiKeyPrimary) {
        args.push('-e', `ANTHROPIC_API_KEY=${auth.apiKeyPrimary}`);
      }
      for (const fb of auth.apiKeyFallbacks) {
        args.push('-e', `ANTHROPIC_API_KEY_${fb.index}=${fb.value}`);
      }
      try {
        mergeNoProxy(args, new URL(process.env.ANTHROPIC_BASE_URL).hostname);
      } catch {
        log.warn('ANTHROPIC_BASE_URL is not a valid URL — no NO_PROXY bypass added', {
          value: process.env.ANTHROPIC_BASE_URL,
        });
      }
    }
  }

  // Egress lockdown when enabled — throws if it can't be established, aborting
  // the spawn rather than running with open egress. Otherwise the host gateway.
  if (ensureEgressNetwork()) {
    args.push(...egressNetworkArgs());
    log.info('Egress lockdown active', { containerName, network: EGRESS_NETWORK });
  } else {
    args.push(...hostGatewayArgs());
  }

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Pre-create every nested /workspace mountpoint host-side as the host user.
  // /workspace is itself a bind of the session dir, so when Docker creates a
  // missing nested mountpoint (/workspace/agent, /workspace/.cache/graphify,
  // /workspace/project/README.md, ...) it materializes that stub inside the
  // session dir owned by ROOT — which the storage manager (host user) can
  // then never delete once the session idles out. Docker leaves pre-existing
  // stubs' ownership alone. Best-effort: a failure here just reproduces the
  // old behavior (root-owned stub), loudly.
  const workspaceHostRoot = mounts.find((m) => m.containerPath === '/workspace')?.hostPath;
  if (workspaceHostRoot) {
    for (const mount of mounts) {
      if (!mount.containerPath.startsWith('/workspace/')) continue;
      const stubPath = path.join(workspaceHostRoot, mount.containerPath.slice('/workspace/'.length));
      try {
        if (fs.existsSync(stubPath)) continue;
        // statSync, not lstatSync: a symlink source (AGENTS.md -> CLAUDE.md)
        // must stub as what it RESOLVES to — lstat said "not a file" for the
        // symlink, the stub became a directory, and Docker then failed the
        // file bind-mount with "not a directory" on every owner-group spawn.
        const sourceIsFile = fs.existsSync(mount.hostPath) && fs.statSync(mount.hostPath).isFile();
        if (sourceIsFile) {
          fs.mkdirSync(path.dirname(stubPath), { recursive: true });
          fs.writeFileSync(stubPath, '');
        } else {
          fs.mkdirSync(stubPath, { recursive: true });
        }
      } catch (err) {
        log.warn('Failed to pre-create workspace mountpoint stub — Docker will create it root-owned', {
          stubPath,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Volume mounts
  for (const mount of mounts) {
    // Symlink-overlay sources live under agent-writable trees; re-validate at
    // the last moment before the docker arg is emitted so a target swapped
    // after buildMounts' check aborts the spawn instead of mounting. Docker's
    // -v takes a pathname (no fd-based binds), so a sub-millisecond race
    // between this check and runc's own resolution remains — accepted: it
    // requires a concurrent same-workgroup process, which already shares the
    // trees these roots allow.
    if (mount.overlayAllowedRoots) {
      let recheck: string;
      try {
        recheck = fs.realpathSync(mount.hostPath);
      } catch {
        throw new Error(`Overlay mount source vanished before spawn: ${mount.hostPath}`);
      }
      const allowed = mount.overlayAllowedRoots.some((root) => recheck === root || recheck.startsWith(root + path.sep));
      if (recheck !== mount.hostPath || !allowed) {
        throw new Error(
          `Overlay mount source changed between validation and spawn (${mount.hostPath} -> ${recheck}); aborting spawn`,
        );
      }
    }
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Assemble additional MCP servers: container.json's mcpServers (stdio
  // subprocesses the group declares) plus universal HTTP/stdio MCPs
  // (granola, deepwiki, context7, exa, pocket) injected when the relevant
  // key is present on the host. Per-group mcpServers from container.json
  // merged on top so groups can override. Use excludeMcpServers in
  // container.json to opt OUT of specific universals per-group.
  //
  // Granola is a local stdio wrapper around the Granola REST API — replaces
  // the hosted mcp.granola.ai/mcp endpoint (OAuth-only, tokens expired every
  // few hours) with a static-key REST client auto-authed by OneCLI.
  const mcpServers: Record<string, unknown> = { ...(containerConfig.mcpServers ?? {}) };
  const mcpExcluded = new Set(containerConfig.excludeMcpServers ?? []);
  const canInject = (name: string): boolean => !mcpExcluded.has(name) && !mcpServers[name];

  if (canInject('granola')) {
    // Local stdio MCP wrapping Granola's REST API. Replaces the hosted
    // mcp.granola.ai/mcp endpoint whose OAuth session tokens expired silently
    // every few hours and left agents stuck on "Session expired. Please sign
    // in again." OneCLI injects the static `grn_*` bearer token at the HTTPS
    // proxy based on the `public-api.granola.ai` host pattern — see the
    // `GranolaAPI` vault secret. No refresh worker needed.
    mcpServers.granola = {
      type: 'stdio',
      command: 'bun',
      args: ['/app/src/granola-mcp-server.ts'],
    };
  }
  if (canInject('deepwiki')) {
    mcpServers.deepwiki = { type: 'http', url: 'https://mcp.deepwiki.com/mcp' };
  }
  if (canInject('context7')) {
    mcpServers.context7 = {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp'],
      env: {},
    };
  }
  if (canInject('exa')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Exa-MCP" → mcp.exa.ai).
    mcpServers.exa = {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa,company_research_exa,people_search_exa,deep_researcher_start,deep_researcher_check,deep_search_exa',
    };
  }
  if (canInject('pocket')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Pocket" → public.heypocketai.com).
    mcpServers.pocket = {
      type: 'http',
      url: 'https://public.heypocketai.com/mcp',
    };
  }
  if (canInject('linear') && isToolEnabled(containerConfig.tools, 'linear')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Linear" → mcp.linear.app). Linear's hosted MCP accepts
    // a Personal API Key or OAuth access token as `Authorization: Bearer`.
    // Gated by `tools: ["linear"]` in container.json so groups opt in.
    mcpServers.linear = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    };
  }
  if (canInject('datafold') && isToolEnabled(containerConfig.tools, 'datafold')) {
    // Official Datafold Streamable HTTP MCP. Datafold requires
    // `Authorization: Key <api-key>`; OneCLI overwrites the placeholder
    // header at the proxy boundary for app.datafold.com.
    mcpServers.datafold = DATAFOLD_MCP_SERVER;
  }
  if (canInject('atlassian') && isToolEnabled(containerConfig.tools, 'atlassian')) {
    // sooperset/mcp-atlassian — stdio Python MCP server (72 tools across
    // Jira + Confluence). Installed via /opt/atlassian-venv in the
    // Dockerfile, symlinked to /usr/local/bin/mcp-atlassian.
    //
    // Why direct REST instead of Rovo MCP: the official Rovo MCP requires
    // a per-user permission grant from an Atlassian org admin to expose
    // Jira/Confluence tools — without it, the user only sees 2 Teamwork
    // Graph tools and even those error. Direct REST against
    // <site>.atlassian.net works with any user's standard product seats.
    //
    // The MCP server constructs `Authorization: Basic base64(USERNAME:
    // API_TOKEN)` from env vars at request time. Placeholder values satisfy
    // startup validation; OneCLI replaces the header at the proxy boundary.
    // The site URL is tenant-specific and must come from scoped host config.
    const atlassianServer = resolveAtlassianMcpServer(resolveScopedEnv('ATLASSIAN_BASE_URL', credentialFolder));
    if (!atlassianServer) {
      log.warn('Atlassian tool enabled without a valid scoped ATLASSIAN_BASE_URL; MCP omitted', {
        folder: credentialFolder,
      });
    } else {
      mcpServers.atlassian = atlassianServer;
    }
  }
  if (canInject('looker') && isToolEnabled(containerConfig.tools, 'looker')) {
    // Google's MCP Toolbox for Databases (--prebuilt looker). The toolbox
    // binary is baked into the image (see container/Dockerfile). Credentials
    // are resolved per-group via LOOKER_*_<FOLDER> → LOOKER_* and embedded
    // in the env block here because the MCP SDK's stdio transport only
    // inherits HOME/LOGNAME/PATH/SHELL/TERM/USER by default — container env
    // vars don't reach the child process unless explicitly passed.
    const baseUrl = resolveScopedEnv('LOOKER_BASE_URL', credentialFolder);
    const clientId = resolveScopedEnv('LOOKER_CLIENT_ID', credentialFolder);
    const clientSecret = resolveScopedEnv('LOOKER_CLIENT_SECRET', credentialFolder);
    if (baseUrl && clientId && clientSecret) {
      mcpServers.looker = {
        type: 'stdio',
        command: 'toolbox',
        args: ['--stdio', '--prebuilt', 'looker'],
        env: {
          LOOKER_BASE_URL: baseUrl,
          LOOKER_CLIENT_ID: clientId,
          LOOKER_CLIENT_SECRET: clientSecret,
          LOOKER_VERIFY_SSL: resolveScopedEnv('LOOKER_VERIFY_SSL', credentialFolder) ?? 'true',
        },
      };
    } else {
      log.warn('Looker tool enabled but credentials missing', {
        folder: agentGroup.folder,
        hasBaseUrl: !!baseUrl,
        hasClientId: !!clientId,
        hasClientSecret: !!clientSecret,
      });
    }
  }
  if (canInject('dbt-mcp') && isToolEnabled(containerConfig.tools, 'dbt-mcp')) {
    // dbt-labs/dbt-mcp — Discovery + Semantic Layer + Admin API for dbt Cloud.
    // Binary baked into image via uv (Python 3.12). Token reuses the existing
    // DBT_CLOUD_API_TOKEN_<FOLDER> as DBT_TOKEN. Read-only by default: CLI
    // and LSP toolsets disabled (no local dbt project mounted), and the three
    // mutating Admin tools disabled. Override via DBT_MCP_DISABLE_TOOLS_<FOLDER>.
    const host = resolveScopedEnv('DBT_HOST', credentialFolder);
    const token = resolveScopedEnv('DBT_CLOUD_API_TOKEN', credentialFolder);
    const prodEnvId = resolveScopedEnv('DBT_PROD_ENV_ID', credentialFolder);
    if (host && token && prodEnvId) {
      const env: Record<string, string> = {
        DBT_HOST: host,
        DBT_TOKEN: token,
        DBT_PROD_ENV_ID: prodEnvId,
        DBT_MCP_ENABLE_DBT_CLI: 'false',
        DBT_MCP_ENABLE_LSP: 'false',
        DISABLE_TOOLS:
          resolveScopedEnv('DBT_MCP_DISABLE_TOOLS', credentialFolder) ?? 'trigger_job_run,cancel_job_run,retry_job_run',
      };
      const devEnvId = resolveScopedEnv('DBT_DEV_ENV_ID', credentialFolder);
      if (devEnvId) env.DBT_DEV_ENV_ID = devEnvId;
      const userId = resolveScopedEnv('DBT_USER_ID', credentialFolder);
      if (userId) env.DBT_USER_ID = userId;
      const multicell = resolveScopedEnv('DBT_MULTICELL_ACCOUNT_PREFIX', credentialFolder);
      if (multicell) env.MULTICELL_ACCOUNT_PREFIX = multicell;
      mcpServers['dbt-mcp'] = {
        type: 'stdio',
        command: 'dbt-mcp',
        args: [],
        env,
      };
    } else {
      log.warn('dbt-mcp tool enabled but credentials missing', {
        folder: agentGroup.folder,
        hasHost: !!host,
        hasToken: !!token,
        hasProdEnvId: !!prodEnvId,
      });
    }
  }
  // Slack user-token (xoxp-) MCP — korotovsky/slack-mcp-server, baked into the
  // image. Gated per-spawn: only registers if the session is the owner's 1:1
  // DM with this agent (default) OR the session's messaging_group_id is in
  // container.json's slack_user_token.also_allowed_in override list. Fail-
  // closed by default so adding the agent to a team channel doesn't leak the
  // owner's DMs through it.
  //
  // The token is xoxp- placeholder here; OneCLI gateway substitutes the real
  // Bearer header for outbound slack.com calls based on the workgroup's
  // assigned `Slack-User-Token-<Workspace>` vault secret. Gateway rules for
  // slack.com hosts must be configured at the OneCLI side (see
  // docs/slack-user-token.md).
  //
  // Proxy: korotovsky's HTTP client honors only SLACK_MCP_PROXY, not the
  // standard HTTPS_PROXY. We can't compute the gateway URL here (it's
  // injected by applyContainerConfig into the container's env, not the host
  // process). The slack-mcp-wrapper.sh baked into the image copies the
  // container's HTTPS_PROXY into SLACK_MCP_PROXY at startup — see
  // container/slack-mcp-wrapper.sh.
  // Resolve allowed-or-not BEFORE branching so the deny path runs even when
  // the operator left slack_user_token unset/disabled. A static
  // `slack-user-token` entry in container.json.mcpServers would otherwise
  // sneak past — `delete` runs unconditionally on deny.
  // (Codex P2 catch on PR #108 follow-up.)
  let slackUserTokenAllowed = false;
  if (containerConfig.slack_user_token?.enabled) {
    const { canUseSlackUserToken } = await import('./modules/permissions/slack-user-token-gate.js');
    slackUserTokenAllowed = canUseSlackUserToken(
      getDb(),
      agentGroup.id,
      sessionMessagingGroupId ?? null,
      containerConfig.slack_user_token,
    );
  }
  if (slackUserTokenAllowed) {
    mcpServers['slack-user-token'] = {
      type: 'stdio',
      command: 'slack-mcp-server',
      // `--transport stdio` is REQUIRED by v1.3.0 — omitting it means the
      // server starts without a transport and MCP init handshake fails.
      args: ['--transport', 'stdio'],
      env: {
        SLACK_MCP_XOXP_TOKEN: 'xoxp-onecli-managed-placeholder',
        // Caches default to `.users_cache.json` + `.channels_cache_v2.json`
        // in the working directory. With --rm containers the cache vanishes
        // per spawn, so the first call after spawn pays a one-time
        // listing cost — acceptable for low-spawn frequency. If perf
        // becomes a concern, mount a writable cache path and set
        // SLACK_MCP_USERS_CACHE / SLACK_MCP_CHANNELS_CACHE to absolute
        // paths there. Empty values fall through to the default — we do
        // NOT set them.
      },
    };
  } else {
    // Strip any pre-declared `slack-user-token` entry that came from
    // container.json.mcpServers (operator mistake, stale config, or copy-
    // paste). The host-side env-var copy is the only one we control here;
    // container-side enforcement is at container/agent-runner/src/index.ts
    // via the SLACK_USER_TOKEN_RESERVED list. (Codex P2 catch on PR #108.)
    delete mcpServers['slack-user-token'];
    if (containerConfig.slack_user_token?.enabled) {
      log.info('slack-user-token MCP gated off for this session', {
        sessionMessagingGroupId: sessionMessagingGroupId ?? null,
        folder: agentGroup.folder,
        reason: sessionMessagingGroupId == null ? 'no_messaging_group' : 'not_owner_dm_and_not_in_allowlist',
      });
    }
  }

  const mcpServersEnv = serializeMcpServersEnv(mcpServers);
  if (mcpServersEnv) {
    args.push('-e', mcpServersEnv);
  }

  // Override entrypoint so we skip tini's stdin-read wait (host-spawned
  // sessions don't pipe stdin — all IO flows through the mounted session
  // DBs). Run the image's entrypoint.sh directly via bash so credential and
  // provider setup fires before bun starts.
  args.push('--entrypoint', 'bash');

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec /app/entrypoint.sh');

  return args;
}

export function dockerResourceLimitArgs(resources?: ContainerResources): string[] {
  const effective = resolveContainerResources(resources);
  const args = [
    '--memory',
    formatMemoryMb(effective.memory.limitMb),
    '--memory-reservation',
    formatMemoryMb(effective.memory.requestMb),
    '--memory-swap',
    formatMemoryMb(effective.memory.memorySwapLimitMb),
  ];
  if (effective.cpus !== undefined) args.push('--cpus', String(effective.cpus));
  args.push('--pids-limit', String(effective.pidsLimit));
  return args;
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Write both
    // formats: pnpm 10 global installs still honor the legacy .npmrc keys,
    // while pnpm 11 reads the global allowBuilds YAML map. Every entry here
    // passed strict npm-name validation before the admin approved it.
    const legacyAllowlist = npmPackages
      .map((pkg) => `echo 'only-built-dependencies[]=${pkg}' >> /root/.npmrc`)
      .join(' && ');
    const allowBuilds = JSON.stringify(Object.fromEntries(npmPackages.map((pkg) => [pkg, true])));
    dockerfile += `RUN ${legacyAllowlist} && pnpm config set --global --json allowBuilds '${allowBuilds}' && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  const retentionCreatedAt = new Date().toISOString();
  const retentionHours = resolveStoragePolicy().candidateRetentionHours;
  dockerfile += `LABEL nanoclaw.retention.created_at=${JSON.stringify(retentionCreatedAt)}\n`;
  dockerfile += `LABEL nanoclaw.retention.hours=${retentionHours}\n`;
  dockerfile += `LABEL nanoclaw.retention.owner=${JSON.stringify(agentGroupId)}\n`;
  dockerfile += 'LABEL nanoclaw.image.role=agent-group\n';
  dockerfile += `LABEL nanoclaw.agent_group_id=${JSON.stringify(agentGroupId)}\n`;
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync. exec buffers
    // stdout/stderr (matching the old stdio: 'pipe') and rejects on a non-zero
    // exit, so error propagation is unchanged.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
