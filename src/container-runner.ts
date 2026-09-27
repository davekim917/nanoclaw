/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, exec, execFileSync, spawn } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import { agentRunnerSourcePath } from './agent-runner-source.js';
import { assertWikiActorConfig, wikiEnrollment } from './wiki-admission/policy.js';
import { privateWikiRuntime, wikiProviderContribution, wikiRuntimeEnvironment } from './wiki-admission/runtime.js';
import { getHostCapabilities } from './capabilities.js';
import {
  CONTAINER_GROUP_LABEL_KEY,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_BUDGET,
  CONTAINER_NAME_PREFIX,
  CONTAINER_ROLE_LABEL_KEY,
  CONTAINER_SESSION_LABEL_KEY,
  CONTAINER_WORKGROUP_LABEL_KEY,
  DATA_DIR,
  EGRESS_LOCKDOWN,
  GROUPS_DIR,
  HOST_LEASE_TTL_MS,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TASK_LIST_ENABLED,
  TASK_SCRIPT_TIMEOUT_MS,
  WORKGROUP_SHARED_FS,
} from './config.js';
import {
  CONTAINER_PLUGINS_DIR,
  effectiveOutcomeReporting,
  effectiveTimezone,
  readContainerConfig,
  readContainerConfigForSpawn,
  updateContainerConfig,
  writeContainerConfigScalars,
  validateMcpServers,
  resolveContainerSecurity,
  splitExcludedPlugins,
  type ContainerConfig,
  type GitIdentity,
  type McpServerConfig,
  type SecurityConfig,
} from './container-config.js';
import {
  formatMemoryMb,
  parseMemoryMb,
  resolveContainerResources,
  type ContainerResources,
} from './container-resources.js';
import { applyProviderFallbackRuntime, providerFallbackRuntimeEnv, resolveSpawnProvider } from './provider-fallback.js';
import { markProviderAvailable } from './db/provider-health.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import {
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  killContainerHard,
  listInstallContainersWithScope,
  readonlyMountArgs,
  runtimeShowsRunning,
  stopContainer,
  waitForContainerExit,
  type InstallContainerScope,
} from './container-runtime.js';
import { checkAgentRunnerDepsDrift } from './agent-runner-image-check.js';
import { requestContainerRebuild } from './container-rebuild-watcher.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import {
  assertRealDirectory,
  removeUntrustedPathEntry,
  replaceUntrustedDirectory,
  replaceUntrustedFile,
} from './fs-safety.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { claudeSpawnEnv } from './claude-spawn-defaults.js';
import { CODEX_FAMILY_DEFAULTS } from './flag-parser.js';
import { readEnvFileMatching } from './env.js';
import { resolveGitHubToken as resolveGitHubTokenForContainer } from './github-token.js';
export { resolveGitHubToken } from './github-token.js';
import { containerRunsAsHostUser, planGitHubTokenSpawn, registerGroupTokenRefresher } from './github-token-file.js';
import { CHECKOUT_MODE_ENV, effectiveCheckoutMode } from './checkout-mode.js';
import {
  getAgentGroup,
  getAllAgentGroups,
  getWorkgroupOnecliSecrets,
  getWorkgroupOnecliSecretsById,
} from './db/agent-groups.js';
import { centralTransaction, evaluateGuardSync, withCentralSync, withRawDb } from './db/central-lease.js';
import { getDb, hasTable } from './db/connection.js';
import {
  getLiveHostInstance,
  getSessionClaim,
  listSessionsWithStopIntent,
  releaseSessionClaim,
  renewHostInstanceLease,
  setStopIntent,
  shadowWrite,
  tryClaimSession,
  type SessionClaimRow,
} from './db/coordination.js';
import { getHostInstanceId, startHostInstanceLease } from './host-instance.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession, SESSION_BY_ID_SQL, updateSession } from './db/sessions.js';
import { buildCentralProjection } from './db/per-agent-projections.js';
import { ensureArchiveProjection } from './db/archive-projection-worker.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { applyOnecliContainerConfig, describeDiagnosis } from './onecli-apply.js';
import {
  applyOnecliSecrets,
  ensureOnecliAgent,
  mergeWorkgroupAndGroupSecrets,
  slackUserTokenSecrets,
  typesafeKeyPlaceholderEnv,
} from './onecli-secrets.js';
import {
  reconcileWorkgroupMemory,
  workgroupMemoryDir,
  workgroupSharedDir,
  WORKGROUP_CONTAINER_PATH,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from './modules/workgroup/shared-dirs.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
import { protectReadonlyHostPaths, readWorkgroupReadonlyPaths } from './workgroup-readonly-paths.js';
import {
  assertWorkgroupReadAccessMountStable,
  isDuplicateWorkgroupReadAccessMount,
  isWorkgroupReadAccessNamespace,
  resolveWorkgroupReadAccess,
  workgroupReadAccessInstructions,
} from './workgroup-read-access.js';
import { resolveWorkgroupWiki, workgroupWikiInstructions } from './workgroup-wiki.js';
import { loadPluginScopes, pluginAllowedForWorkgroup, warnUnmatchedPluginScopes } from './plugin-scopes.js';
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
import { OPENCODE_XDG_CONTAINER_PATH, OPENCODE_XDG_ENV, stageOpenCodeAuth } from './providers/opencode.js';
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import { getAgentMailbox } from './mailbox/index.js';
import { assertHostOwnedInboundDb, hostInboundMounts, migrateInboundDbToHostDir } from './modules/mailbox/index.js';
import {
  CLAUDE_CODE_PROJECTS_DIR,
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  _emitContainerStateEvent,
  sessionContextPath,
  sessionDir,
  withExistingMailboxSession,
  writeSessionContext,
  writeSessionRouting,
} from './session-manager.js';
import {
  classifyCanonicalRepositories,
  isRepositoryLifecycleClaimed,
  isWorkgroupRepositoryMountClaimed,
  readOriginPin,
  readTransferTombstone,
  resolveRepositoryWorkUnit,
  transferTombstonesDir,
  topicWorktreesDir,
  type RepositoryWorkUnit,
} from './repository-workspaces.js';
import {
  decideHooksMountStrategy,
  MANAGED_GIT_HOOKS_REFUSE_DIR,
  MANAGED_GIT_HOOKS_SCAN_DIR,
} from './managed-git-hooks.js';
import { repositoryConfigPath, safeGitConfigGet } from './safe-git.js';
import {
  canonicalCommondirPath,
  ensureCanonicalCommondirSentinel,
  ForeignCanonicalCommondirError,
} from './canonical-git-commondir.js';
import { resolveStoragePolicy } from './storage-manager.js';
import { assertStorageAdmissionInBackground } from './storage-maintenance-worker.js';
import { acquireStorageActivityLease, type StorageActivityLease } from './storage-activity.js';
import { handleStoragePressureAlert } from './storage-pressure-alert.js';
import { MemoryAdmissionController, type MemoryAdmissionPriority } from './memory-admission.js';
import { effectiveMcpServers } from './fleet-mcp-servers.js';
import type { AgentGroup, Session } from './types.js';

export const DATAFOLD_MCP_SERVER = {
  type: 'http',
  url: 'https://app.datafold.com/mcp/',
  headers: { Authorization: 'Key onecli-managed' },
} as const satisfies McpServerConfig;

const HOST_ONLY_MCP_FIELDS = ['displayName', 'description', 'plugin'] as const;

/**
 * Omits entries with a non-empty plugin root: the runner resolves those from container.json, then overlays this by
 * name. HOST_ONLY_MCP_FIELDS are stripped from what this payload carries; `instructions` deliberately still crosses.
 */
export function serializeMcpServersEnv(
  servers: Record<string, unknown>,
  groupServers: Record<string, McpServerConfig>,
): string | null {
  const validated = validateMcpServers(servers as Record<string, McpServerConfig>);
  const additional = Object.entries(validated).filter(
    ([name]) => !(groupServers[name] as { pluginRoot?: string } | undefined)?.pluginRoot,
  );
  if (additional.length === 0) return null;
  const forContainer = Object.fromEntries(
    additional.map(([name, server]) => {
      const copy = { ...(server as unknown as Record<string, unknown>) };
      for (const field of HOST_ONLY_MCP_FIELDS) delete copy[field];
      return [name, copy];
    }),
  );
  return `NANOCLAW_MCP_SERVERS=${JSON.stringify(forContainer)}`;
}

export function gitIdentityEnv(identity?: GitIdentity): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

// 30s timeout (SDK default 5s): the gateway can be slow while the host reaps many containers, and a 5s abort
// fails the spawn. The @onecli-sh/sdk pin is COUPLED TO THE GATEWAY VERSION (0.5.x calls /api/*, 2.x calls
// /v1/*); method names are identical across majors, so builds and tests cannot catch a mismatch. Verify any
// bump by calling a running gateway.
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 });

/**
 * Emitted for every provider and both spawn branches: a Claude-primary group can fall back to Codex, whose CLI
 * has no family aliases of its own.
 */
export function codexFamilyAliasEnv(): string[] {
  return ['-e', `NANOCLAW_CODEX_MODEL_ALIASES=${JSON.stringify(CODEX_FAMILY_DEFAULTS)}`];
}

/**
 * `adopted`: a container a previous host started, observed via `docker wait`. A waiter's `close` is only a
 * HINT (a docker-daemon restart exits every waiter), so it is checked against the runtime before finalizing and
 * re-armed in place: `waiter` is swapped inside the SAME channel object, which the registry's identity fence
 * compares. `terminal` fires exactly once, when the container is proven gone.
 */
export type SupervisionChannel =
  | { kind: 'spawned'; process: ChildProcess }
  | { kind: 'adopted'; waiter: ChildProcess; terminal: EventEmitter; settled: boolean };

interface ActiveContainerEntry {
  channel: SupervisionChannel;
  containerName: string;
  /**
   * When this host started observing it: the adoption instant for an adopted entry (0 would exempt it from the
   * idle ceiling).
   */
  spawnedAt: number;
  adopted: boolean;
  /** null for an adopted entry: this host holds no lease for a container it did not spawn. */
  storageActivity: StorageActivityLease | null;
  claimIncarnation?: number;
}

const activeContainers = new Map<string, ActiveContainerEntry>();

/** For an adopted entry this rides `terminal`, never a bare waiter exit (a daemon restart produces those for free). */
function channelOnClose(channel: SupervisionChannel, callback: () => void): void {
  if (channel.kind === 'spawned') channel.process.once('close', callback);
  else channel.terminal.once('close', callback);
}

function channelHasExited(channel: SupervisionChannel): boolean {
  return channel.kind === 'spawned' ? channel.process.exitCode !== null : channel.settled;
}

/**
 * SIGKILL on an adopted entry's WAITER would abandon the container, so the adopted fallback stops the container
 * by name first.
 */
function channelKillFallback(entry: ActiveContainerEntry, sessionId: string): void {
  if (entry.channel.kind === 'spawned') {
    try {
      entry.channel.process.kill('SIGKILL');
    } catch {
      // process already gone — ignore
    }
    return;
  }
  try {
    killContainerHard(entry.containerName);
  } catch (err) {
    log.warn('docker kill failed for an adopted container', { sessionId, containerName: entry.containerName, err });
  }
  try {
    entry.channel.waiter.kill();
  } catch {
    // waiter already gone — ignore
  }
}

/**
 * Outstanding respawn promises (in-memory shadow of this host's `respawn_after_stop` rows), each with a token.
 * A wake may discharge only a promise whose token it read when it STARTED, so a wake already in flight when a
 * kill arrived cannot clear the promise that kill just made.
 */
const respawnIntents = new Map<string, number>();

let respawnIntentSeq = 0;

export function _resetStopIntentStateForTesting(): void {
  respawnIntents.clear();
}

export function _respawnIntentTokenForTesting(sessionId: string): number | undefined {
  return respawnIntents.get(sessionId);
}

/**
 * Deliberately NO `hostname:pid` fallback claimant id: an id never registered in `host_instances` reads as dead,
 * so any overlapping host would take over every claim. `lateLeaseStart` holds the single in-flight late lease
 * start so concurrent wakes share it (two would register two instance ids); it is cleared on settle.
 */
let lateLeaseStart: Promise<void> | null = null;

async function resolveClaimantId(): Promise<string | null> {
  const existing = getHostInstanceId();
  if (existing) return existing;
  lateLeaseStart ??= shadowWrite('host instance lease (late start from the spawn path)', () =>
    startHostInstanceLease({ leaseTtlMs: HOST_LEASE_TTL_MS }),
  ).finally(() => {
    lateLeaseStart = null;
  });
  await lateLeaseStart;
  return getHostInstanceId();
}

/**
 * `getHostInstanceId()` answers from memory even after renewals have failed past the TTL, and a claim under an
 * expired lease lets a peer take the session over while our container runs. So validate durably, with one
 * inline renewal attempt. Spawn path only.
 */
async function selfLeaseIsLive(instanceId: string): Promise<boolean> {
  if (await getLiveHostInstance(instanceId, new Date().toISOString())) return true;
  /* eslint-disable no-catch-all/no-catch-all -- the renewal is shadow state; its failure is answered by refusing the spawn */
  try {
    await renewHostInstanceLease(instanceId, new Date(Date.now() + HOST_LEASE_TTL_MS).toISOString());
  } catch (err) {
    log.warn('Inline host instance lease renewal failed', { instanceId, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
  return (await getLiveHostInstance(instanceId, new Date().toISOString())) !== undefined;
}

/**
 * Returns the claimed incarnation, or null when the claim was lost (do not start a container). Throws on a
 * failed write. A claim held by a LIVE peer host is refused; a stopped, lease-expired or unknown holder is
 * takeover-able so a crashed claimant never wedges a session. After it, only the central lease may be awaited.
 * P2 (container fence): an untracked container still running for the session fails the claim; fails CLOSED,
 * and is a runtime call so it sits outside the transaction. P1: the peer-liveness read and the incarnation CAS
 * run in one `BEGIN IMMEDIATE` transaction so a peer's lease renewal cannot land between them.
 */
async function claimSessionRun(
  sessionId: string,
  containerRef: string,
  opts: { adopting?: boolean } = {},
): Promise<number | null> {
  const self = await resolveClaimantId();
  if (!self) {
    log.warn('Refusing session claim: no durable host instance id — lease not started', { sessionId });
    return null;
  }
  if (!(await selfLeaseIsLive(self))) {
    log.warn("Refusing session claim: this host's lease is not live", { sessionId, instanceId: self });
    return null;
  }
  if (!opts.adopting && !activeContainers.has(sessionId)) {
    const previous = await getSessionClaim(sessionId);
    if (previous?.container_ref) {
      let running: boolean;
      try {
        running = runtimeShowsRunning(previous.container_ref);
      } catch (err) {
        log.warn('Refusing session claim — cannot prove the previous container is gone', {
          sessionId,
          containerRef: previous.container_ref,
          err,
        });
        return null;
      }
      if (running) {
        log.warn('Refusing session claim — a container is still running for this session', {
          sessionId,
          containerRef: previous.container_ref,
        });
        return null;
      }
    }
  }
  return centralTransaction(async () => {
    const current = await getSessionClaim(sessionId);
    if (current?.claimed_by && current.claimed_by !== self) {
      const holder = await getLiveHostInstance(current.claimed_by, new Date().toISOString());
      if (holder) {
        log.warn('Refusing session claim held by a live peer host', {
          sessionId,
          holder: current.claimed_by,
          claimant: self,
        });
        return null;
      }
    }
    return tryClaimSession({
      sessionId,
      instanceId: self,
      expectedIncarnation: current?.incarnation ?? 0,
      containerRef,
      now: new Date().toISOString(),
    });
  }, 'session-claim');
}

/** Release our claim at this incarnation. Never throws — a failed release is
 *  self-healing (the next claimant's CAS supersedes it). */
async function releaseClaimQuietly(sessionId: string, incarnation: number): Promise<void> {
  const self = getHostInstanceId();
  if (!self) return;
  await shadowWrite('session-claim-release', () =>
    releaseSessionClaim({
      sessionId,
      instanceId: self,
      incarnation,
      now: new Date().toISOString(),
    }),
  );
}

/**
 * Spawn wall-clock ms, or 0 when untracked. Gives a fresh container a grace window in the stuck-claim guard.
 */
export function getContainerSpawnedAt(sessionId: string): number {
  return activeContainers.get(sessionId)?.spawnedAt ?? 0;
}

export function isAdoptedContainer(sessionId: string): boolean {
  return activeContainers.get(sessionId)?.adopted ?? false;
}

export function getAdoptedSessionIds(): string[] {
  return [...activeContainers.entries()].filter(([, entry]) => entry.adopted).map(([sessionId]) => sessionId);
}

/**
 * In-flight wakes by session: dedupes concurrent `wakeContainer` calls during async spawn setup, which would
 * otherwise pass the `activeContainers` check and spawn a duplicate container.
 */
const wakePromises = new Map<string, Promise<boolean>>();
const spawningSessions = new Set<string>();

/**
 * Kill requests for a session still SPAWNING. Honoured at the last point before `docker run` (spawn cancelled)
 * or by killing the process once the wake settles; either way `onExit` fires exactly once.
 */
/** An exit callback may await (it usually re-reads the session row before a wake); its rejection is logged, never thrown into the emitter. */
export type ContainerExitCallback = () => unknown;

const pendingKills = new Map<string, { reason: string; onExit: ContainerExitCallback[] }>();

/**
 * A caller's precondition, re-proved by the WAKE PATH at the last instant.
 *
 * `true` proceeds, anything else refuses. Must be synchronous: nothing may be awaited between it and `spawn()`.
 */
export type WakeGuardResult = boolean | { ok: false; reason: string };
export type WakeGuard = () => WakeGuardResult;

export interface WakeContainerOptions {
  /**
   * Re-proved immediately before `spawn()` and when a queued wake is dequeued: the wake path awaits admission,
   * queues and leases, so a call-site check goes stale.
   */
  guard?: WakeGuard;
}

interface QueuedWake {
  session: Session;
  guard?: WakeGuard;
}

/**
 * Why this row cannot take a wake, or `null` when it can: THE one definition for the wake path and the opt-in
 * guard. `archived_at` is a second axis: an archive-only thread close leaves `status` reading `active`.
 */
function unwakeableReason(fresh: Session | undefined): string | null {
  if (!fresh) return 'session no longer exists';
  if (fresh.status !== 'active') return `session is ${fresh.status}`;
  if (fresh.archived_at != null) return 'session is archived';
  return null;
}

export function sessionStillActive(sessionId: string): WakeGuard {
  return () => {
    const reason = unwakeableReason(readSessionSync(sessionId));
    return reason === null ? true : { ok: false, reason };
  };
}

/** Stays SYNCHRONOUS: evaluated inside `withCentralSync` with nothing awaited before the spawn it protects. */
function readSessionSync(sessionId: string): Session | undefined {
  return withRawDb((raw) => raw.prepare(SESSION_BY_ID_SQL).get(sessionId)) as Session | undefined;
}

/**
 * Call ONLY inside `withCentralSync`. A guard that returns a promise, or throws, is reported as a refusal so the
 * caller's refusal cleanup (reservation and storage-lease release) runs on one path.
 */
function wakeRefusalFrom(guard: WakeGuard | undefined): string | null {
  if (!guard) return null;
  let verdict: WakeGuardResult;
  try {
    verdict = evaluateGuardSync(guard);
  } catch (err) {
    // A thrown guard is a refusal: propagating it would skip the dequeue's memory-reservation release.
    return `guard threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (verdict === true) return null;
  if (verdict === false) return 'guard refused';
  return verdict.reason;
}

let memoryAdmission: MemoryAdmissionController<QueuedWake> | null = null;
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

function getMemoryAdmission(): MemoryAdmissionController<QueuedWake> {
  if (!memoryAdmission) {
    const dockerMemoryMb = detectDockerMemoryMb();
    const budgetMb = resolveMemoryAdmissionBudgetMb(dockerMemoryMb);
    memoryAdmission = new MemoryAdmissionController<QueuedWake>(budgetMb);
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
  startDrained(memoryAdmission.release(sessionId));
}

/**
 * Drop this session's admission entirely — reservation AND any queued request.
 *
 * `release` alone leaves a QUEUED wake in the controller, which would start minutes later.
 */
function cancelMemoryAdmission(sessionId: string): void {
  if (!memoryAdmission) return;
  if (containerShutdownInProgress) return;
  startDrained(memoryAdmission.cancel(sessionId));
}

function startDrained(ready: QueuedWake[]): void {
  for (const queued of ready) {
    void startReservedWake(queued).catch((err) => {
      log.warn('Queued container wake failed', { sessionId: queued.session.id, err });
    });
  }
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Which container is registered for this session RIGHT NOW (the name is unique per spawn; the incarnation moves
 * with the runtime). Compare with `sameContainerIdentity`, never by object identity.
 */
export interface ContainerIdentity {
  containerName: string;
  claimIncarnation: number | undefined;
}

export function containerIdentityFor(sessionId: string): ContainerIdentity | null {
  const entry = activeContainers.get(sessionId);
  if (!entry) return null;
  return { containerName: entry.containerName, claimIncarnation: entry.claimIncarnation };
}

/** Same registered container? Null on either side is "no identity", never a match. */
export function sameContainerIdentity(a: ContainerIdentity | null, b: ContainerIdentity | null): boolean {
  if (!a || !b) return false;
  return a.containerName === b.containerName && a.claimIncarnation === b.claimIncarnation;
}

export function isContainerSpawning(sessionId: string): boolean {
  return spawningSessions.has(sessionId) || wakePromises.has(sessionId);
}

/**
 * `outbound.db` has ONE writer: the host may write it only while no container owns it, and a SPAWNING or
 * pending-adoption container counts as owning it.
 */
export function containerOwnsOutbound(sessionId: string): boolean {
  return isContainerRunning(sessionId) || isContainerSpawning(sessionId) || pendingAdoptions.has(sessionId);
}

/** Snapshot passed to isolated maintenance workers; never expose the mutable map. */
export function getActiveContainerSessionIds(): string[] {
  return [...activeContainers.keys()];
}

/** Tracked containers plus pending adoptions: an unclaimed survivor is still using its directories. */
export function getStorageProtectedSessionIds(): string[] {
  return [...new Set([...activeContainers.keys(), ...pendingAdoptions])];
}

/**
 * Precedence: container.json `workgroup_id`, then the existing DB value, then the folder. When container.json is
 * silent, never overwrite the DB value with the folder: that would sever sibling pairings made by migration.
 */
export async function reconcileWorkgroupAtSpawn(
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): Promise<{ workgroupId: string }> {
  const declared = await resolveWorkgroupIdAtSpawn(agentGroup, containerConfig);

  return persistResolvedWorkgroupAtSpawn(agentGroup, declared);
}

/** One central transaction: two driver statements awaited in sequence, nothing else inside the closure. */
export async function persistResolvedWorkgroupAtSpawn(
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  declared: string,
): Promise<{ workgroupId: string }> {
  await centralTransaction(async () => {
    const db = getDb();
    await db.run(
      `
      INSERT INTO workgroups (id, display_name, onecli_secrets, created_at)
      VALUES (?, ?, '[]', ?)
      ON CONFLICT(id) DO NOTHING
    `,
      declared,
      declared,
      new Date().toISOString(),
    );

    await db.run(
      `
      UPDATE agent_groups SET workgroup_id = ?
      WHERE id = ? AND (workgroup_id IS NULL OR workgroup_id != ?)
    `,
      declared,
      agentGroup.id,
      declared,
    );
  }, 'persistResolvedWorkgroupAtSpawn');

  // Callers thread this id through every spawn subsystem so none re-derives it under a concurrent reconcile.
  return { workgroupId: declared };
}

export async function resolveWorkgroupIdAtSpawn(
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): Promise<string> {
  if (containerConfig.workgroup_id !== undefined) return containerConfig.workgroup_id;
  const existing = await getDb().get<{ workgroup_id: string | null }>(
    'SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1',
    agentGroup.id,
  );
  return existing?.workgroup_id ?? agentGroup.folder;
}

/**
 * Re-read the session and return it only while still wakeable. Every await in the wake path is followed by this:
 * a reclaim can close the row in any await window, and a container spawned on a closed row escapes stuck
 * detection and the heartbeat ceiling. Fails closed. Holds and releases nothing; callers release what they hold.
 */
async function refreshActiveSession(session: Session, stage: string): Promise<Session | null> {
  let fresh: Session | undefined;
  try {
    fresh = await getSession(session.id);
  } catch (err) {
    log.warn('Container wake abandoned — session re-read failed', { sessionId: session.id, stage, err });
    return null;
  }
  // Most wakeContainer callers pass no guard, so this is the only place an archive-only close is refused for all.
  const reason = unwakeableReason(fresh);
  if (reason !== null) {
    log.warn('Container wake abandoned — session cannot take a wake', {
      sessionId: session.id,
      stage,
      status: fresh?.status ?? 'missing',
      archivedAt: fresh?.archived_at ?? null,
      reason,
    });
    return null;
  }
  return fresh ?? null;
}

/**
 * No-op if already running or mid-spawn (the in-flight promise is reused). Never throws: `false` means a
 * transient spawn failure; the inbound row stays pending and host-sweep retries.
 */
export function wakeContainer(
  session: Session,
  priority: MemoryAdmissionPriority = 'interactive',
  options: WakeContainerOptions = {},
): Promise<boolean> {
  if (containerShutdownInProgress) {
    log.debug('Container wake ignored — host shutdown in progress', { sessionId: session.id });
    return Promise.resolve(false);
  }
  // A pending adoption is an untracked live survivor: route to the adoption retry, never to a second spawn.
  const pendingAdoption = pendingAdoptions.has(session.id);
  if (!pendingAdoption && activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  // Fast path on the caller's possibly stale row; `refreshActiveSession` is the authority after the first await.
  const callerReason = unwakeableReason(session);
  if (callerReason !== null) {
    log.warn('Container wake refused — session cannot take a wake', {
      sessionId: session.id,
      status: session.status,
      reason: callerReason,
    });
    return Promise.resolve(false);
  }

  return trackWake(session.id, async () => {
    if (pendingAdoption) {
      if (await retryPendingAdoption(session)) return true;
      // Survivor gone: spawn normally; the claim fence (P2) re-proves absence.
    }
    return runWake(session, priority, options);
  });
}

async function runWake(
  session: Session,
  priority: MemoryAdmissionPriority,
  options: WakeContainerOptions,
): Promise<boolean> {
  if (!(await checkStorageAdmission(session, false))) return false;
  const admitted = await refreshActiveSession(session, 'storage-admission');
  if (!admitted) return false;

  const admission = getMemoryAdmission();
  const agentGroup = await getAgentGroup(admitted.agent_group_id);
  if (!agentGroup) {
    log.error('Container wake rejected — agent group not found', {
      sessionId: admitted.id,
      agentGroupId: admitted.agent_group_id,
    });
    return false;
  }
  let effectiveResources;
  try {
    effectiveResources = resolveContainerResources(readContainerConfig(agentGroup.folder).resources);
  } catch (err) {
    log.error('Container wake rejected — invalid resource configuration', {
      sessionId: admitted.id,
      agentGroup: agentGroup.folder,
      err,
    });
    return false;
  }

  // Priority is part of the atomic admission decision: a task wake entering as interactive could bypass an older
  // scheduled head before demotion. Queue the fresh row, not the caller's snapshot.
  const decision = admission.request(
    admitted.id,
    effectiveResources.memory.requestMb,
    { session: admitted, guard: options.guard },
    priority,
  );
  if (decision.status === 'rejected') {
    log.error('Container wake rejected — memory request exceeds host budget', {
      sessionId: admitted.id,
      agentGroup: agentGroup.folder,
      requestMb: decision.requestMb,
      budgetMb: decision.budgetMb,
    });
    return false;
  }
  if (decision.status === 'queued') {
    log.warn('Container wake queued — memory budget exhausted', {
      sessionId: admitted.id,
      agentGroup: agentGroup.folder,
      requestMb: decision.requestMb,
      budgetMb: decision.budgetMb,
      reservedMb: admission.reservedMb,
      position: decision.position,
      priority,
    });
    return false;
  }

  return spawnReservedContainer(admitted, options.guard);
}

/** Operator canary fence: unset admits all; set admits only exact comma-separated ids; empty blocks all spawns. */
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

function startReservedWake(queued: QueuedWake): Promise<boolean> {
  const { session, guard } = queued;
  // A queued wake for a pending adoption must not spend its reservation on a spawn.
  if (pendingAdoptions.has(session.id)) {
    releaseMemoryReservation(session.id);
    return wakeContainer(session, 'interactive', { guard });
  }
  if (activeContainers.has(session.id)) return Promise.resolve(true);
  const existing = wakePromises.get(session.id);
  if (existing) return existing;

  return trackWake(session.id, async () => {
    // The queue wait is unbounded: re-read before spending the slot, and release the reservation on a bail.
    const dequeued = await refreshActiveSession(session, 'memory-admission-dequeue');
    if (!dequeued) {
      releaseMemoryReservation(session.id);
      return false;
    }
    // The caller's guard too: the row being active says nothing about whether the caller still wants the wake.
    // Under the lease: the guard's reads are raw.
    const dequeueRefusal = await withCentralSync(() => wakeRefusalFrom(guard), 'wake guard at dequeue');
    if (dequeueRefusal !== null) {
      log.warn('Queued container wake refused by its guard at the dequeue', {
        sessionId: session.id,
        reason: dequeueRefusal,
      });
      releaseMemoryReservation(session.id);
      return false;
    }
    if (!(await checkStorageAdmission(dequeued, true))) {
      releaseMemoryReservation(dequeued.id);
      return false;
    }
    const admitted = await refreshActiveSession(dequeued, 'queued-storage-admission');
    if (!admitted) {
      releaseMemoryReservation(dequeued.id);
      return false;
    }
    return await spawnReservedContainer(admitted, guard);
  });
}

function trackWake(sessionId: string, run: () => Promise<boolean>): Promise<boolean> {
  // Read at wake START: a joined wake gets the existing promise and never reaches here.
  const respawnToken = respawnIntents.get(sessionId);
  const tracked = run()
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId, err });
      return false;
    })
    .then((woke) => {
      // Discharge here, where every wake ends: callers' fire-and-forget `wakeContainer` calls never observe success.
      if (woke) clearRespawnIntentOnWake(sessionId, respawnToken);
      return woke;
    })
    .finally(() => {
      if (wakePromises.get(sessionId) === tracked) wakePromises.delete(sessionId);
      settlePendingKill(sessionId);
    });
  wakePromises.set(sessionId, tracked);
  return tracked;
}

async function checkStorageAdmission(session: Session, queued: boolean): Promise<boolean> {
  try {
    const storageAdmission = await assertStorageAdmissionInBackground(getStorageProtectedSessionIds());
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
    // Fail closed: leave the row pending rather than spawn into possibly exhausted disk.
    log.warn('Container wake deferred — background storage admission failed', {
      sessionId: session.id,
      queued,
      err,
    });
    return false;
  }
}

async function spawnReservedContainer(caller: Session, guard?: WakeGuard): Promise<boolean> {
  if (containerShutdownInProgress) return false;
  // A reservation is held by now, so a bail must release it.
  const session = await refreshActiveSession(caller, 'reserved-spawn');
  if (!session) {
    releaseMemoryReservation(caller.id);
    return false;
  }
  const spawnAgentGroup = await getAgentGroup(session.agent_group_id);
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
    // Read once at the spawn boundary; this snapshot supplies the workgroup and every spawn option.
    spawnContainerConfig = readContainerConfigForSpawn(
      spawnAgentGroup.folder,
      process.env.NANOCLAW_CONTAINER_SPAWN_WORKGROUP_ALLOWLIST !== undefined,
    );
    spawnWorkgroupId = await resolveWorkgroupIdAtSpawn(spawnAgentGroup, spawnContainerConfig);
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
  // Count spawning sessions only until they enter activeContainers, or one process is double-counted at the cap.
  const inFlightWakes = [...spawningSessions].filter((sessionId) => !activeContainers.has(sessionId)).length;
  const pendingSurvivors = pendingAdoptions.size;
  if (MAX_CONCURRENT_CONTAINERS > 0 && activeCount + inFlightWakes + pendingSurvivors >= MAX_CONCURRENT_CONTAINERS) {
    log.warn('Container wake deferred — concurrency cap reached', {
      sessionId: session.id,
      activeCount,
      inFlightWakes,
      pendingSurvivors,
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    });
    releaseMemoryReservation(session.id);
    return false;
  }

  spawningSessions.add(session.id);
  let storageActivity: StorageActivityLease | null = null;
  try {
    storageActivity = await acquireContainerStorageActivity(session, spawnWorkgroupId);
    // Last re-read before spawn. The `finally` releases the storage lease; the memory reservation is ours to release.
    const spawnSession = await refreshActiveSession(session, 'pre-spawn');
    if (!spawnSession) {
      releaseMemoryReservation(session.id);
      return false;
    }
    // Asked before `spawnContainer` prepares mounts, snapshots and the heartbeat file, and again before `docker run`.
    const earlyCancellation = pendingKillCancellation(spawnSession.id);
    if (earlyCancellation) throw earlyCancellation;
    // Same for the caller's guard. Under the lease: the guard's reads are raw.
    const earlyGuardRefusal = await withCentralSync(() => wakeRefusalFrom(guard), 'wake guard before preparation');
    if (earlyGuardRefusal !== null) {
      throw new Error(`Container spawn refused by its guard: ${earlyGuardRefusal}`);
    }
    await spawnContainer(spawnSession, storageActivity, spawnAgentGroup, spawnContainerConfig, spawnWorkgroupId, guard);
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
  roots.add(topicWorktreesDir(await resolveSessionRepositoryWorkUnit(session, admittedWorkgroupId)));

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

export async function resolveSessionRepositoryWorkUnit(
  session: Session,
  workgroupId: string,
): Promise<RepositoryWorkUnit> {
  const messagingGroup = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : null;
  return resolveRepositoryWorkUnit({
    workgroupId,
    sessionId: session.id,
    platformId: messagingGroup?.platform_id ?? null,
    messagingGroupId: session.messaging_group_id ?? null,
    threadId: session.thread_id ?? null,
  });
}

export function canonicalGitControlMounts(gitDir: string, stateDir: string): VolumeMount[] {
  // A foreign `commondir` would send Git to another repository's refs and objects, so the canonical carries a
  // read-only self-referential sentinel; anything else found there is never overwritten (mounts are withheld).
  const commondir = canonicalCommondirPath(gitDir);
  const commondirState = ensureCanonicalCommondirSentinel(gitDir);
  if (commondirState !== 'sentinel') throw new ForeignCanonicalCommondirError(commondir, commondirState);
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
    // A fresh clone can lack an index: bind a host-owned empty placeholder so the RW parent mount cannot be used
    // to create the canonical main-worktree index.
    indexSource = path.join(stateDir, 'canonical-index-unavailable');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(indexSource, '', { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      const placeholderStat = fs.lstatSync(indexSource);
      if (placeholderStat.isSymbolicLink() || !placeholderStat.isFile() || placeholderStat.size !== 0) {
        throw new Error(`Unsafe canonical Git index placeholder: ${indexSource}`, { cause: writeError });
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
        throw new Error(`Canonical repository has unsafe object alternates: ${file}`, { cause: error });
      }
    }
  }
  return [
    { hostPath: config, containerPath: config, readonly: true },
    { hostPath: head, containerPath: head, readonly: true },
    { hostPath: indexSource, containerPath: index, readonly: true },
    { hostPath: hooks, containerPath: hooks, readonly: true },
    { hostPath: objectsInfo, containerPath: objectsInfo, readonly: true },
    { hostPath: commondir, containerPath: commondir, readonly: true },
  ];
}

const scanPolicyHooksAlerted = new Set<string>();

function alertScanPolicyHooksOnce(repository: { gitDir: string }, outcome: 'refuse' | 'withhold'): void {
  if (scanPolicyHooksAlerted.has(repository.gitDir)) return;
  scanPolicyHooksAlerted.add(repository.gitDir);
  log.error('managed-git-hooks: scan-policy repository degraded below the real hook', {
    outcome,
    gitDir: repository.gitDir,
  });
}

export interface ScanPolicyHooksMountResult {
  /**
   * true when even the refuse hook failed validation: the caller MUST withhold every mount for this repository,
   * so git fails outright rather than running with no hook. `mounts` is then empty.
   */
  withhold: boolean;
  mounts: VolumeMount[];
}

/**
 * Only for repositories whose committed `core.hooksPath` is MANAGED_GIT_HOOKS_SCAN_DIR: runs the scan -> refuse ->
 * withhold fallback (`decideHooksMountStrategy`). Never throws for a degraded outcome; the refuse hook mounts at
 * the same container path as the real one. Degraded outcomes alert once per boot.
 */
export function resolveScanPolicyHooksMount(repository: { gitDir: string }): ScanPolicyHooksMountResult {
  const configuredHooksPath = safeGitConfigGet(repositoryConfigPath(repository.gitDir), 'core.hooksPath');
  if (configuredHooksPath !== MANAGED_GIT_HOOKS_SCAN_DIR) return { withhold: false, mounts: [] };
  const strategy = decideHooksMountStrategy();
  if (strategy === 'scan') {
    return {
      withhold: false,
      mounts: [{ hostPath: MANAGED_GIT_HOOKS_SCAN_DIR, containerPath: MANAGED_GIT_HOOKS_SCAN_DIR, readonly: true }],
    };
  }
  if (strategy === 'refuse') {
    alertScanPolicyHooksOnce(repository, 'refuse');
    return {
      withhold: false,
      mounts: [{ hostPath: MANAGED_GIT_HOOKS_REFUSE_DIR, containerPath: MANAGED_GIT_HOOKS_SCAN_DIR, readonly: true }],
    };
  }
  alertScanPolicyHooksOnce(repository, 'withhold');
  return { withhold: true, mounts: [] };
}

async function spawnContainer(
  session: Session,
  storageActivity: StorageActivityLease,
  agentGroup: AgentGroup,
  containerConfig: ContainerConfig,
  admittedWorkgroupId: string,
  guard?: WakeGuard,
): Promise<void> {
  const wikiActor = wikiEnrollment(agentGroup.id, containerConfig.wikiMaintenance === true);
  if (wikiActor) assertWikiActorConfig(containerConfig, wikiActor, admittedWorkgroupId);
  const routingWritesStartedAt = Date.now();
  if (await hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    await writeDestinations(agentGroup.id, session.id);
  }
  await writeSessionRouting(agentGroup.id, session.id);
  logSpawnStage('routing-writes', routingWritesStartedAt);

  // Written before buildMounts pushes its bind mount. The SQLite mailbox has no context, so the file holds `null`.
  const mailboxKey = { agentGroupId: agentGroup.id, sessionId: session.id };
  const mailbox = getAgentMailbox();
  writeSessionContext(agentGroup.id, session.id, await mailbox.runnerContext(mailboxKey));
  const mailboxEnvironment = await mailbox.runnerEnvironment(mailboxKey);

  const effectiveResources = resolveContainerResources(containerConfig.resources);

  // node_modules is image-baked while source is bind-mounted live: a dep added without an image rebuild
  // crash-loops every spawn. Checked against the image actually spawned (a per-agent image carries its own label).
  const spawnImageRef = containerConfig.imageTag || CONTAINER_IMAGE;
  const depsDriftStartedAt = Date.now();
  const depsCheck = await checkAgentRunnerDepsDrift(spawnImageRef);
  logSpawnStage('deps-drift-check', depsDriftStartedAt);
  if (!depsCheck.ok) {
    log.warn('Refusing spawn — agent-runner deps drift', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      imageRef: depsCheck.imageRef,
      expected: depsCheck.expected,
      actual: depsCheck.actual,
      // 'unresolved' + retried=true is the transient-relabel shape: the label
      // map came back empty twice. Anything else is a settled answer.
      lookup: depsCheck.lookup.kind,
      retried: depsCheck.retried,
      message: depsCheck.message,
    });
    // Only the shared base image is fixable by a rebuild (a per-agent image needs its self-mod re-run). Never
    // awaited: refuse now; host-sweep retries once the detached rebuild lands.
    if (spawnImageRef === CONTAINER_IMAGE) requestContainerRebuild(depsCheck.message);
    throw new Error(depsCheck.message);
  }

  // Written at spawn so the runner can read the identity fields from the RO mount.
  await ensureRuntimeFields(containerConfig, agentGroup);

  // Fail-closed: a central-DB error propagates and the sweep retries. The returned id is threaded downstream so no
  // subsystem re-derives it under a concurrent reconcile.
  const workgroupPersistStartedAt = Date.now();
  const { workgroupId: resolvedWgId } = await persistResolvedWorkgroupAtSpawn(agentGroup, admittedWorkgroupId);
  logSpawnStage('workgroup-persist', workgroupPersistStartedAt);
  const repositoryFenceStartedAt = Date.now();
  const repositoryWorkUnit = await resolveSessionRepositoryWorkUnit(session, resolvedWgId);
  if (isWorkgroupRepositoryMountClaimed(resolvedWgId)) {
    throw new Error(`Repository mount reconciliation in progress for ${resolvedWgId}; spawn will retry`);
  }
  if (isRepositoryLifecycleClaimed(repositoryWorkUnit)) {
    throw new Error(`Repository lifecycle transition in progress for ${repositoryWorkUnit.key}; spawn will retry`);
  }
  // The per-session DB fence survives a host crash, so it gates recovery of a publication/transfer that died
  // mid-quiescence. Read-only through the seam: a spawn must never provision a mailbox. The wrapper keeps "no
  // mailbox" (`undefined`) distinct from "no fence" (`{ fence: null }`): conflating them would admit a spawn whose
  // inbound.db was reclaimed, and the container could recreate the host-owned DB under its writable mount.
  const repositoryFenceRead = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
    fence: mailbox.readRepoIngressFence(),
  }));
  if (!repositoryFenceRead) {
    throw new Error(`Session ${session.id} has no inbound mailbox to poll; spawn will retry`);
  }
  const repositoryFence = repositoryFenceRead.fence;
  if (repositoryFence?.state === 'active') {
    throw new Error(
      `Repository mount transition ${repositoryFence.epoch} is still active for session ${session.id}; spawn will retry`,
    );
  }

  const [memoryReport] = await withCentralSync(
    () => withRawDb((db) => reconcileWorkgroupMemory(db, { workgroupIds: [resolvedWgId] })),
    'workgroup memory reconcile at spawn',
  );
  if (!memoryReport || memoryReport.state.status === 'migration-required') {
    throw new Error(
      `Workgroup memory migration-required for ${resolvedWgId}; refusing container spawn before operator migration`,
    );
  }

  // Spawn-time provider fallback: a primary inside a recorded outage window runs the declared fallback instead.
  // Applied after normal resolution because `session.agent_provider` outranks container.json, and mirrored onto
  // the config and a synthetic session so every downstream consumer agrees on one provider.
  logSpawnStage('repository-fence', repositoryFenceStartedAt);

  const providerDecisionStartedAt = Date.now();
  const providerDecision = await resolveSpawnProvider({
    agentGroupId: agentGroup.id,
    sessionProvider: session.agent_provider,
    containerConfig,
  });
  if (providerDecision.fallbackApplied) {
    // Assign unconditionally: a fallback with no model wants its provider's default, never the primary's model/effort.
    applyProviderFallbackRuntime(containerConfig, providerDecision);
    log.warn('Provider fallback engaged — primary is in a recorded outage window', {
      sessionId: session.id,
      agentGroup: agentGroup.name,
      primaryProvider: providerDecision.primaryProvider,
      fallbackProvider: providerDecision.provider,
      model: providerDecision.model,
    });
  }
  if (!providerDecision.fallbackApplied) {
    // Close the outage episode, or the failure streak grows forever and the next outage opens at the 6h backoff cap.
    await markProviderAvailable(agentGroup.id, providerDecision.primaryProvider);
  }
  // Local shadow: the fallback must beat a stamped session row for THIS spawn
  // without persisting a provider change to the session.
  const spawnSession = providerDecision.fallbackApplied
    ? { ...session, agent_provider: providerDecision.provider }
    : session;

  logSpawnStage('provider-decision', providerDecisionStartedAt);

  const providerName = resolveProviderName(spawnSession.agent_provider, containerConfig.provider);
  const groupFilesystemStartedAt = Date.now();
  initGroupFilesystem({ ...agentGroup, workgroup_id: resolvedWgId }, { provider: providerName });
  logSpawnStage('group-filesystem-init', groupFilesystemStartedAt);

  // Computed once and threaded through buildMounts and buildContainerArgs so its side effects fire once.
  const { provider, contribution } = await resolveProviderContribution(spawnSession, agentGroup, containerConfig);

  const buildMountsStartedAt = Date.now();
  const mounts = await buildMounts(agentGroup, session, containerConfig, provider, contribution, resolvedWgId);
  logSpawnStage('build-mounts', buildMountsStartedAt);
  const containerName = `${CONTAINER_NAME_PREFIX}${agentGroup.folder}-${Date.now()}`;
  const agentIdentifier = agentGroup.id;
  // Per-wiring defaults outrank container.json; sessions with no messaging group skip the lookup.
  let channelDefaultModel: string | null = null;
  let channelDefaultEffort: string | null = null;
  let channelDefaultTone: string | null = null;
  let channelInstructionsProfile: string | null = null;
  if (session.messaging_group_id) {
    const { getMessagingGroupAgentByPair } = await import('./db/messaging-groups.js');
    const wiring = await getMessagingGroupAgentByPair(session.messaging_group_id, agentGroup.id);
    if (wiring) {
      channelDefaultModel = wiring.default_model;
      channelDefaultEffort = wiring.default_effort;
      channelDefaultTone = wiring.default_tone;
      channelInstructionsProfile = wiring.instructions_profile;
    }
  }

  // For a task session (no messaging group) this is the series' delivery destination, so the Slack gate judges
  // where the task posts instead of failing closed on null.
  const { resolveSlackSafetyMessagingGroupId } = await import('./modules/permissions/task-slack-subject.js');
  const slackSafetyMessagingGroupId = await resolveSlackSafetyMessagingGroupId(session);

  const args = await buildContainerArgs(
    mounts,
    containerName,
    session.id,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    {
      channelDefaultModel,
      channelDefaultEffort,
      channelDefaultTone,
      channelInstructionsProfile,
    },
    session.messaging_group_id ?? null,
    resolvedWgId,
    providerDecision.fallbackApplied,
    session.thread_id ?? null,
    repositoryWorkUnit,
    slackSafetyMessagingGroupId,
    mailboxEnvironment,
  );

  // Credentials go in a 0600 host-only env file, never `docker run -e KEY=value` (visible to any host process on
  // the command line). It lives in the host-private `.context` dir, never `<session>/.host`, which is mounted
  // read-only into the container.
  const dockerEnvironmentDir = path.dirname(sessionContextPath(agentGroup.id, session.id));

  // Deliberately AFTER buildContainerArgs: that resolves the GitHub token, and the snapshot's expiresAt must
  // describe the credential this spawn injects.
  if (!wikiActor) await writeCapabilitiesSnapshot(agentGroup.id, session.id, slackSafetyMessagingGroupId, resolvedWgId);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // THE CROSS-PROCESS SPAWN FENCE: winning the claim licenses touching this session's runtime state (the heartbeat
  // clear below included). Only the central-lease acquisition awaits after it; the guard, spawn and registration run
  // synchronously inside that callback.
  const claimIncarnation = await claimSessionRun(session.id, containerName);
  if (claimIncarnation === null) {
    throw new Error(`session ${session.id} is claimed by another live host process — not spawning a duplicate`);
  }

  // THE GUARD POINT and the spawn, in ONE synchronous block under the central lease: the only place where "still
  // true?" and "the process now exists" are adjacent, and a test pins that nothing is awaited between them.
  // Pending kills are checked here too; nothing awaits between that check and registration, so a kill either
  // lands here or takes the running-container path.
  let channel: SupervisionChannel;
  let dockerEnvironmentFile: string | null = null;
  const stderrTail: string[] = [];
  // ChildProcess emits `close` after `error`; finalize this exact channel once.
  let finalized = false;
  const finalizeContainer = (): void => {
    if (finalized) return;
    finalized = true;
    removeDockerEnvironmentFile(dockerEnvironmentFile);
    dockerEnvironmentFile = null;
    finalizeSession(session.id, channel, storageActivity, containerName);
  };
  try {
    await withCentralSync(() => {
      // Clear any orphan heartbeat: its stale mtime could trigger an immediate ceiling kill before the new
      // container touches the file.
      fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

      // Shutdown may have begun during async preparation; refuse so stopAllContainers cannot miss this spawn.
      if (containerShutdownInProgress) {
        throw new Error('Container spawn cancelled because host shutdown is in progress');
      }
      const lateCancellation = pendingKillCancellation(session.id);
      if (lateCancellation) throw lateCancellation;
      const guardRefusal = wakeRefusalFrom(guard);
      if (guardRefusal !== null) {
        throw new Error(`Container spawn refused by its guard: ${guardRefusal}`);
      }
      const dockerEnvironment = materializeDockerEnvironment(args, dockerEnvironmentDir, session.id);
      dockerEnvironmentFile = dockerEnvironment.file;
      const child = spawn(CONTAINER_RUNTIME_BIN, dockerEnvironment.args, { stdio: ['ignore', 'pipe', 'pipe'] });

      channel = { kind: 'spawned', process: child };
      activeContainers.set(session.id, {
        channel,
        containerName,
        spawnedAt: Date.now(),
        adopted: false,
        storageActivity,
        claimIncarnation,
      });

      // Every child listener is attached HERE, in the same synchronous turn as the spawn: a runtime that cannot
      // launch emits `error` from a nextTick queued inside it, and an `error` with no listener crashes the host.

      // Keep a stderr tail for a non-zero exit: a container that dies at boot explains itself only here.
      captureContainerStderr(child.stderr, containerName, stderrTail);

      // stdout is unused in v2 (all IO is via session DB)
      child.stdout?.on('data', () => {});

      // No host-side idle timeout: stuck detection is host-sweep's (heartbeat mtime, claim age, container_state).

      child.on('close', (code) => {
        finalizeContainer();
        const hostStopped = !settleUnexpectedExit(session.id, containerName);
        // code null = killed by signal (normal shutdown path), not a boot failure.
        if (code === 137) {
          log.warn('Container exited 137 — likely OOM kill or forced SIGKILL', {
            sessionId: session.id,
            containerName,
            memoryRequestMb: effectiveResources.memory.requestMb,
            memoryLimitMb: effectiveResources.memory.limitMb,
            stderrTail,
          });
        } else if (hostStopped) {
          // A host stop exits 143 by design; logging it as non-zero would fire the crash-loop vital on every reap.
          log.info('Container stopped by host', { sessionId: session.id, code, containerName });
        } else if (code !== 0 && code !== null && stderrTail.length > 0) {
          log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
        } else {
          log.info('Container exited', { sessionId: session.id, code, containerName });
        }
      });

      child.on('error', (err) => {
        finalizeContainer();
        log.error('Container spawn error', { sessionId: session.id, err });
      });
    }, 'wake guard at spawn');
  } catch (err) {
    removeDockerEnvironmentFile(dockerEnvironmentFile);
    dockerEnvironmentFile = null;
    // Refusals above hold the claim with no process to release it: release here, or the next wake is fenced out.
    await releaseClaimQuietly(session.id, claimIncarnation);
    throw err;
  }
  // Only now may this function yield: the `running` write is awaited after the exit handlers exist, so a
  // container dying at boot cannot emit close/error before they do.
  await markContainerRunning(session.id);
}

/**
 * The one terminal for a tracked container, whichever channel observed it. The identity fence
 * (`active.channel === channel`) makes a late event from a replaced runtime delete and release nothing shared.
 * Synchronous (runs from `close`/`error` handlers); durable writes are a detached, claim-fenced tail.
 */
export function finalizeSession(
  sessionId: string,
  channel: SupervisionChannel,
  storageActivity: StorageActivityLease | null,
  containerName?: string,
): void {
  const active = activeContainers.get(sessionId);
  if (active?.channel === channel) {
    activeContainers.delete(sessionId);
    // An adopted entry holds no storage lease (acquiring one would double-count the session).
    if (active.storageActivity) {
      void active.storageActivity.release().catch((err) => {
        log.warn('Failed to release container storage activity lease', { sessionId, err });
      });
    }
    releaseMemoryReservation(sessionId);
    // Exit handlers are synchronous, so the status write is fire-and-forget.
    void finishSessionBookkeeping(sessionId, active.claimIncarnation);
    stopTypingRefresh(sessionId);
    if (active.channel.kind === 'adopted') {
      active.channel.settled = true;
      // Exit callbacks attached through `channelOnClose` ride this, after the
      // registry delete — the same order a spawned entry's `close` gives them.
      active.channel.terminal.emit('close');
    }
    return;
  }

  // A terminal from a runtime the registry already replaced: releasing its claim or writing status would clobber
  // the REPLACEMENT, so only its own storage lease is handed back.
  log.warn('Ignoring stale session finish', { sessionId, containerName: containerName ?? active?.containerName });
  if (storageActivity) {
    void storageActivity.release().catch((err) => {
      log.warn('Failed to release untracked container storage activity lease', { sessionId, err });
    });
  }
}

/**
 * The `stopped` status write and the claim release, both fenced on the claim row. The fence read and conditional
 * write are ONE `centralTransaction`, so a replacement's claim CAS cannot interleave and be stamped `stopped`
 * after marking itself running. The dashboard event is emitted after commit.
 */
const FINISH_FENCE_ATTEMPTS = 3;
const FINISH_FENCE_RETRY_MS = 100;

async function finishSessionBookkeeping(sessionId: string, claimIncarnation: number | undefined): Promise<void> {
  let fenced: 'ours' | 'stale' | 'unfenced' | 'unavailable' = 'unfenced';
  if (claimIncarnation !== undefined) {
    const self = getHostInstanceId();
    fenced = 'unavailable';
    for (let attempt = 1; attempt <= FINISH_FENCE_ATTEMPTS && fenced === 'unavailable'; attempt += 1) {
      try {
        fenced = await centralTransaction(async () => {
          const claim = await getSessionClaim(sessionId);
          if (claim) {
            const movedOn = claim.incarnation !== claimIncarnation;
            const heldByAnother = claim.claimed_by !== null && claim.claimed_by !== self;
            if (movedOn || heldByAnother) {
              log.warn('Ignoring stale session finish', {
                sessionId,
                fence: 'claim',
                ourIncarnation: claimIncarnation,
                incarnation: claim.incarnation,
                holder: claim.claimed_by,
              });
              return 'stale';
            }
          }
          await updateSession(sessionId, { container_status: 'stopped' });
          return 'ours';
        }, 'session-finish');
      } catch (err) {
        log.warn('Stale-finish fence failed — retrying', { sessionId, attempt, err });
        if (attempt < FINISH_FENCE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, FINISH_FENCE_RETRY_MS * attempt));
        }
      }
    }
    // Never write unfenced: a missed `stopped` stamp is recovered by the
    // phantom reset at the next boot, an overwritten `running` is not.
    if (fenced === 'unavailable') {
      log.error('Stale-finish fence unavailable; leaving container_status untouched', {
        sessionId,
        attempts: FINISH_FENCE_ATTEMPTS,
      });
    }
  }
  if (fenced === 'stale') return;
  try {
    if (fenced === 'ours') await _emitContainerStateEvent(sessionId, 'stopped');
    else if (fenced === 'unfenced') await markContainerStopped(sessionId);
  } catch (err) {
    log.warn('markContainerStopped failed after container exit', { sessionId, err });
  }
  // Scoped to THIS runtime's incarnation, so a late release cannot unclaim a fresh spawn's live container.
  if (claimIncarnation !== undefined) await releaseClaimQuietly(sessionId, claimIncarnation);
}

export function captureContainerStderr(
  stderr: NodeJS.ReadableStream | null,
  containerName: string,
  stderrTail: string[],
): void {
  stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      log.debug(line, { containerName });
      stderrTail.push(line);
      if (stderrTail.length > 10) stderrTail.shift();
    }
  });
}

/**
 * A killed container never emits `turn_end`, so without this its 💭 status label survives (permanently for a
 * scheduled task, whose normal exit is the idle reaper). Dynamic import: delivery.ts imports this module.
 * Fire-and-forget, never throws. Runs for a cancelled spawn too.
 */
function clearStatusOnKill(sessionId: string, reason: string): void {
  void import('./delivery.js')
    .then(async (m) => {
      const { settleTaskListOnKill } = await import('./task-list-host.js');
      await Promise.all([m.clearSessionStatusOnKill(sessionId), settleTaskListOnKill(sessionId, reason)]);
    })
    .catch((err) => {
      log.warn('Failed to clear status on container kill — leaving as-is', {
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

/** Containers the host itself is stopping; their stop path settles the task list, so the close handler must not. */
const hostStoppedContainers = new Set<string>();

/**
 * Settle the task list after an exit the host did not ask for. Exit codes are not consulted (an adopted
 * container's `docker wait` exits 0 regardless). Returns false for a host stop.
 */
function settleUnexpectedExit(sessionId: string, containerName: string): boolean {
  if (hostStoppedContainers.delete(containerName)) return false;
  void import('./task-list-host.js').then((m) => m.settleTaskListOnKill(sessionId, 'container-exit'));
  return true;
}

/** Stop a RUNNING container, attaching every exit callback before the stop. */
function stopRunningContainer(sessionId: string, reason: string, onExit: ContainerExitCallback[]): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;
  for (const callback of onExit) {
    channelOnClose(entry.channel, () => {
      void Promise.resolve()
        .then(callback)
        .catch((err: unknown) => log.warn('Container exit callback failed', { sessionId, reason, err }));
    });
  }
  log.info('Killing container', { sessionId, reason, containerName: entry.containerName, adopted: entry.adopted });
  hostStoppedContainers.add(entry.containerName);
  clearStatusOnKill(sessionId, reason);
  try {
    stopContainer(entry.containerName);
  } catch {
    channelKillFallback(entry, sessionId);
  }
}

/**
 * `'respawn_after_stop'` is a PROMISE that this host (or, if it dies first, the next boot) brings the session
 * back; `'stop'` means stay down. Not inferable from `onExit`: some callers pass one purely for bookkeeping.
 */
export type StopIntent = 'stop' | 'respawn_after_stop';

/**
 * Kill a container, INCLUDING one still spawning (recorded in `pendingKills`; `onExit` still fires). `intent` is
 * recorded durably BEFORE the stop. With no container at all, `onExit` does NOT fire: container-restart relies on
 * that to read "not running" as "this restart did not happen".
 */
export function killContainer(
  sessionId: string,
  reason: string,
  onExit?: ContainerExitCallback,
  intent: StopIntent = 'stop',
): void {
  if (!activeContainers.has(sessionId)) {
    if (pendingAdoptions.has(sessionId)) {
      // A survivor not yet adopted: stopped by name and proven gone before its hold is released and exit work runs.
      recordStopIntent(sessionId, intent);
      stopPendingSurvivor(sessionId, reason, onExit ? [onExit] : []);
      return;
    }
    if (!isContainerSpawning(sessionId)) return;
    recordStopIntent(sessionId, intent);
    const pending = pendingKills.get(sessionId) ?? { reason, onExit: [] };
    if (onExit) pending.onExit.push(onExit);
    pendingKills.set(sessionId, pending);
    log.info('Container kill deferred — a wake is in flight for this session', { sessionId, reason });
    return;
  }
  recordStopIntent(sessionId, intent);
  stopRunningContainer(sessionId, reason, onExit ? [onExit] : []);
}

export interface StartupReconciliation {
  adopted: number;
  /** Containers stopped: no session label, no session row, or a session that cannot take a wake. */
  stopped: number;
  /** Containers left running unadopted because the claim could not be taken; the wake path retries (P4). */
  pendingClaim: number;
  /** Adopted sessions whose inbound DB carries an ACTIVE repository ingress fence (counted, not acted on). */
  fencedInbound: number;
}

/** Unclaimed survivors: alive and untracked, so `wakeContainer` checks this FIRST and routes to the adoption retry. */
const pendingAdoptions = new Set<string>();

/**
 * What a pending survivor holds (storage leases, a saturating memory reservation; a held claim is kept). Taken only
 * by `holdAsPending`; released only on adoption success (the registry entry takes it over) or proven absence.
 */
interface PendingHold {
  /** The container's name when it was listed; null for a survivor held on an inventory failure. */
  containerName: string | null;
  lease: StorageActivityLease | null;
  /** MiB counted against the budget — saturating when the survivor does not fit. */
  reservedMb: number | null;
  /** False when the survivor would be refused as a spawn: its reservation is saturating and adoption stops it under its claim. */
  fits: boolean | null;
  waiter: ChildProcess | null;
  /** Exit work from a stop that could not be proven; runs once, when the container is proven gone. */
  parkedExits: ContainerExitCallback[];
}
const pendingHolds = new Map<string, PendingHold>();

/**
 * Without this a survivor that exits silently keeps its holds until the next boot. A waiter close is a hint checked
 * against the runtime: gone → release everything; still there or unanswerable → re-arm after backoff.
 */
function armPendingWaiter(sessionId: string, hold: PendingHold, containerName: string): void {
  let waiter: ChildProcess;
  try {
    waiter = waitForContainerExit(containerName);
  } catch (err) {
    log.warn('Could not arm the exit observer for a pending survivor', { sessionId, containerName, err });
    return;
  }
  hold.waiter = waiter;
  waiter.stdout?.on('data', () => {});
  waiter.stderr?.on('data', () => {});
  let handled = false;
  const onExit = (): void => {
    if (handled) return;
    handled = true;
    // Only the waiter the hold still names may act.
    if (pendingHolds.get(sessionId)?.waiter !== waiter) return;
    if (containerProvenGone(containerName)) {
      log.info('Pending survivor exited — releasing its hold', { sessionId, containerName });
      hold.waiter = null;
      void releasePendingHold(sessionId);
      return;
    }
    const timer = setTimeout(() => {
      if (pendingHolds.get(sessionId)?.waiter === waiter) armPendingWaiter(sessionId, hold, containerName);
    }, adoptedWaiterRearmMs);
    timer.unref();
  };
  waiter.on('close', onExit);
  waiter.on('error', onExit);
}

/** Armed only once the pending state is final for this pass; a successful adoption arms the registry's own waiter. */
function observePending(sessionId: string): void {
  const hold = pendingHolds.get(sessionId);
  if (!hold || !hold.containerName || hold.waiter) return;
  armPendingWaiter(sessionId, hold, hold.containerName);
}

function disarmPendingWaiter(hold: PendingHold): void {
  const waiter = hold.waiter;
  hold.waiter = null;
  if (!waiter) return;
  try {
    waiter.kill();
  } catch {
    // already gone — ignore
  }
}

/**
 * Mark a running survivor pending (so `containerOwnsOutbound` is true and wakes retry adoption), lease its storage
 * roots and reserve its memory. Idempotent; a resource not taken is retried next call. `container` is null when
 * the inventory failed.
 */
async function holdAsPending(
  session: Session,
  container: { name: string; workgroupId: string | null } | null,
): Promise<PendingHold> {
  pendingAdoptions.add(session.id);
  let hold = pendingHolds.get(session.id);
  if (!hold) {
    hold = { containerName: null, lease: null, reservedMb: null, fits: null, waiter: null, parkedExits: [] };
    pendingHolds.set(session.id, hold);
  }
  if (container && hold.containerName !== container.name) {
    if (hold.containerName !== null) {
      // A named hold is never re-pointed: its waiter is the only thing watching that live container.
      throw new Error(
        `pending hold for session ${session.id} names ${hold.containerName}; refusing to re-point it at ${container.name}`,
      );
    }
    hold.containerName = container.name;
  }
  if (!hold.lease) {
    try {
      hold.lease = await acquireContainerStorageActivity(
        session,
        await adoptedWorkgroupId(session, container?.workgroupId ?? null),
      );
    } catch (err) {
      log.error('Could not take the storage-activity lease for a pending survivor', {
        sessionId: session.id,
        containerName: container?.name ?? null,
        err,
      });
    }
  }
  if (hold.fits === null) {
    const memory = await reserveAdoptedMemory(session);
    if (memory.ok) {
      hold.reservedMb = memory.requestMb;
      hold.fits = true;
    } else {
      hold.fits = false;
      if (memory.requestMb !== undefined) {
        // Saturating: the survivor uses this memory whether or not it fits, so admission blocks fresh spawns.
        getMemoryAdmission().reserveSaturating(session.id, memory.requestMb);
        hold.reservedMb = memory.requestMb;
      }
      log.warn(
        'A pending survivor does not fit the memory budget — counted against it, saturating, until adopted or gone',
        {
          sessionId: session.id,
          containerName: container?.name ?? null,
          reason: memory.reason,
          reservedMb: hold.reservedMb,
        },
      );
    }
  }
  return hold;
}

/** Proven absence: release everything, then run parked exit work exactly once, after the release. */
async function releasePendingHold(sessionId: string): Promise<void> {
  pendingAdoptions.delete(sessionId);
  const hold = pendingHolds.get(sessionId);
  pendingHolds.delete(sessionId);
  if (!hold) return;
  disarmPendingWaiter(hold);
  if (hold.reservedMb !== null) releaseMemoryReservation(sessionId);
  if (hold.lease) {
    try {
      await hold.lease.release();
    } catch (err) {
      log.warn("Failed to release a pending survivor's storage activity lease", { sessionId, err });
    }
  }
  const parked = hold.parkedExits.splice(0);
  for (const callback of parked) {
    void Promise.resolve()
      .then(callback)
      .catch((err: unknown) => log.warn('Container exit callback failed', { sessionId, err }));
  }
}

/** Adoption success: the lease and reservation move to the registry entry, which `finalizeSession` releases. */
function transferPendingHold(sessionId: string): void {
  pendingAdoptions.delete(sessionId);
  const hold = pendingHolds.get(sessionId);
  pendingHolds.delete(sessionId);
  if (hold) disarmPendingWaiter(hold);
}

/**
 * Release (and exit work) happens only once the runtime proves the container gone; a survivor that cannot be
 * stopped stays pending and the caller retries.
 */
function stopPendingSurvivor(sessionId: string, reason: string, onExit: ContainerExitCallback[]): void {
  const hold = pendingHolds.get(sessionId);
  const containerName = hold?.containerName ?? null;
  if (!hold || !containerName) {
    log.warn('Cannot stop a pending survivor whose container was never listed — a wake will re-list it', {
      sessionId,
      reason,
    });
    return;
  }
  log.info('Killing container', { sessionId, reason, containerName, pending: true });
  hostStoppedContainers.add(containerName);
  clearStatusOnKill(sessionId, reason);
  try {
    stopContainer(containerName);
  } catch (err) {
    log.warn('docker stop failed for a pending survivor — escalating to docker kill', {
      sessionId,
      containerName,
      err,
    });
  }
  if (!containerProvenGone(containerName)) {
    try {
      killContainerHard(containerName);
    } catch (err) {
      log.warn('docker kill failed for a pending survivor', { sessionId, containerName, err });
    }
  }
  hold.parkedExits.push(...onExit);
  if (!containerProvenGone(containerName)) {
    log.warn('A pending survivor could not be stopped — keeping it pending with its exit work parked', {
      sessionId,
      containerName,
      reason,
      parkedExits: hold.parkedExits.length,
    });
    return;
  }
  void releasePendingHold(sessionId);
}

/**
 * A hold seeded on an inventory failure has no name, so nothing can stop it: re-list. `'unknown'` means the
 * runtime could not be asked, and the caller must not report a restart it could not perform.
 */
export async function resolvePendingSurvivor(sessionId: string): Promise<'running' | 'gone' | 'unknown'> {
  const hold = pendingHolds.get(sessionId);
  if (!hold) return pendingAdoptions.has(sessionId) ? 'unknown' : 'gone';
  if (hold.containerName) return 'running';
  let listed: InstallContainerScope | undefined;
  try {
    listed = adoptionListing().find((container) => container.sessionId === sessionId);
  } catch (err) {
    log.warn('Could not re-list an unlisted pending survivor', { sessionId, err });
    return 'unknown';
  }
  if (!listed) {
    log.info('Unlisted pending survivor is gone — releasing its hold', { sessionId });
    await releasePendingHold(sessionId);
    return 'gone';
  }
  hold.containerName = listed.name;
  observePending(sessionId);
  return 'running';
}

/**
 * The runtime name of the session's container (tracked or pending), or null. Stable across adoption and unique per
 * spawn: compare this, not `getContainerSpawnedAt` (which flips from 0 on adoption), to detect a replacement.
 */
export function getContainerIdentity(sessionId: string): string | null {
  return activeContainers.get(sessionId)?.containerName ?? pendingHolds.get(sessionId)?.containerName ?? null;
}

/** Is the container provably gone? A runtime that cannot be asked never proves absence. */
function containerProvenGone(containerName: string): boolean {
  try {
    return !runtimeShowsRunning(containerName);
  } catch {
    return false;
  }
}

/** Replaceable for tests; `adoptRunningSessions` pins it so the wake-path retry re-lists through the same source. */
let adoptionListing: () => InstallContainerScope[] = listInstallContainersWithScope;

/** `docker wait` against an unreachable daemon exits at once, so a re-arm without this pause would spin. */
const ADOPTED_WAITER_REARM_MS = 5_000;
let adoptedWaiterRearmMs = ADOPTED_WAITER_REARM_MS;

export function hasPendingAdoption(sessionId: string): boolean {
  return pendingAdoptions.has(sessionId);
}

export function _resetAdoptionRetryStateForTesting(): void {
  pendingAdoptions.clear();
}

/** Test-only: stand in for an adoption that failed its claim write. */
export function _markPendingAdoptionForTesting(sessionId: string): void {
  pendingAdoptions.add(sessionId);
}

export function _resetAdoptionStateForTesting(options: { waiterRearmMs?: number } = {}): void {
  pendingAdoptions.clear();
  pendingHolds.clear();
  adoptionListing = listInstallContainersWithScope;
  adoptedWaiterRearmMs = options.waiterRearmMs ?? ADOPTED_WAITER_REARM_MS;
}

type AdoptedChannel = Extract<SupervisionChannel, { kind: 'adopted' }>;

/** `close` is a hint checked by `onWaiterClose`; `error` (waiter could not start) is handled the same way, once. */
function armAdoptedWaiter(sessionId: string, channel: AdoptedChannel, containerName: string): void {
  const waiter = channel.waiter;
  const stderrTail: string[] = [];
  waiter.stdout?.on('data', () => {});
  waiter.stderr?.on('data', (chunk: Buffer | string) => {
    const line = String(chunk).trim();
    if (!line) return;
    stderrTail.push(line);
    if (stderrTail.length > 5) stderrTail.shift();
  });
  let handled = false;
  const onExit = (code: number | null): void => {
    if (handled) return;
    handled = true;
    onWaiterClose(sessionId, channel, containerName, code, stderrTail);
  };
  waiter.on('close', onExit);
  waiter.on('error', (err) => {
    log.warn('Adopted container waiter failed', { sessionId, containerName, err });
    onExit(null);
  });
}

/**
 * A docker-daemon restart exits every waiter at once, so ask the runtime before finalizing. Running or unanswerable
 * → re-arm; gone (including `No such container`) → finalize.
 */
function onWaiterClose(
  sessionId: string,
  channel: AdoptedChannel,
  containerName: string,
  code: number | null,
  stderrTail: string[],
): void {
  if (activeContainers.get(sessionId)?.channel !== channel) {
    // A waiter the registry no longer owns; the fence inside logs it.
    finalizeSession(sessionId, channel, null, containerName);
    return;
  }
  let running: boolean;
  try {
    running = runtimeShowsRunning(containerName);
  } catch (err) {
    log.warn(
      'Adopted container waiter exited but the runtime could not be asked — treating it as running and re-arming',
      {
        sessionId,
        containerName,
        code,
        stderrTail,
        err,
      },
    );
    scheduleWaiterRearm(sessionId, channel, containerName);
    return;
  }
  if (running) {
    log.warn('Adopted container waiter exited but the container is still running — re-arming', {
      sessionId,
      containerName,
      code,
      stderrTail,
    });
    scheduleWaiterRearm(sessionId, channel, containerName);
    return;
  }
  log.info('Adopted container exited', { sessionId, containerName, code, stderrTail });
  finalizeSession(sessionId, channel, null, containerName);
  settleUnexpectedExit(sessionId, containerName);
}

function scheduleWaiterRearm(sessionId: string, channel: AdoptedChannel, containerName: string): void {
  const timer = setTimeout(() => {
    // Replaced or finalized while the backoff ran: nothing to observe any more.
    if (activeContainers.get(sessionId)?.channel !== channel) return;
    try {
      channel.waiter = waitForContainerExit(containerName);
    } catch (err) {
      log.warn('Could not re-arm the adopted container waiter — retrying after backoff', {
        sessionId,
        containerName,
        err,
      });
      scheduleWaiterRearm(sessionId, channel, containerName);
      return;
    }
    armAdoptedWaiter(sessionId, channel, containerName);
  }, adoptedWaiterRearmMs);
  timer.unref();
}

/**
 * Adoption registration differs from a spawn's in two ways: the channel is a `docker wait` observer, and
 * `spawnedAt` is the adoption instant. The heartbeat file is NOT cleared (it is the survivor's evidence of life).
 */
/** The workgroup an adopted container's storage roots belong to: its label, else its group's declaration. */
async function adoptedWorkgroupId(session: Session, labelled: string | null): Promise<string> {
  if (labelled) return labelled;
  const agentGroup = await getAgentGroup(session.agent_group_id);
  return agentGroup?.workgroup_id ?? session.agent_group_id;
}

async function registerAdoptedContainer(
  session: Session,
  containerName: string,
  claimIncarnation: number,
  storageActivity: StorageActivityLease,
): Promise<void> {
  const channel: AdoptedChannel = {
    kind: 'adopted',
    waiter: waitForContainerExit(containerName),
    terminal: new EventEmitter(),
    settled: false,
  };
  activeContainers.set(session.id, {
    channel,
    containerName,
    spawnedAt: Date.now(),
    adopted: true,
    storageActivity,
    claimIncarnation,
  });
  armAdoptedWaiter(session.id, channel, containerName);
  await reconcileSurvivorWakeRows(session);
  // The waiter may have finalized during that await: the identity fence decides if the running stamp is ours.
  if (activeContainers.get(session.id)?.channel !== channel) {
    log.debug('Adopted container finalized during reconcile — skipping the running stamp', { sessionId: session.id });
    return;
  }
  try {
    await markContainerRunning(session.id);
  } catch (err) {
    log.warn('markContainerRunning failed after adoption', { sessionId: session.id, err });
  }
}

type AdoptionOutcome =
  | { outcome: 'adopted'; fencedInbound: boolean }
  | { outcome: 'pending' }
  | { outcome: 'stopped'; reason: string };

/**
 * Reserve a survivor's memory exactly as a spawn of its group would, or boot admits a full budget of fresh spawns
 * on top of survivors. A survivor a spawn would be refused for is refused here too; the caller stops it.
 */
async function reserveAdoptedMemory(
  session: Session,
): Promise<{ ok: true; requestMb: number } | { ok: false; reason: string; requestMb?: number }> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return { ok: false, reason: 'agent group not found' };
  let requestMb: number;
  try {
    requestMb = resolveContainerResources(readContainerConfig(agentGroup.folder).resources).memory.requestMb;
  } catch (err) {
    return { ok: false, reason: `invalid resource configuration: ${err instanceof Error ? err.message : String(err)}` };
  }
  const decision = getMemoryAdmission().request(session.id, requestMb, { session }, 'interactive');
  if (decision.status === 'admitted') return { ok: true, requestMb };
  // A queued request would otherwise drain into a spawn for a container we are about to stop.
  cancelMemoryAdmission(session.id);
  return {
    ok: false,
    requestMb,
    reason:
      decision.status === 'rejected'
        ? `memory request ${requestMb} MiB exceeds the host budget ${decision.budgetMb} MiB`
        : `memory budget exhausted: ${requestMb} MiB requested, ${decision.budgetMb} MiB budget`,
  };
}

/**
 * Claim before adopt, never unfenced: a failed or lost claim leaves the container running and untracked in
 * `pendingAdoptions`, so wakes retry adoption rather than spawn into it.
 */
async function adoptRunningSession(
  session: Session,
  containerName: string,
  workgroupId: string | null,
): Promise<AdoptionOutcome> {
  // Hold everything FIRST: a survivor that stays running stays owned, leased and counted.
  const hold = await holdAsPending(session, { name: containerName, workgroupId });
  const pending = (): AdoptionOutcome => {
    observePending(session.id);
    return { outcome: 'pending' };
  };
  if (!hold.lease) return pending();
  // Claim next: only a container this host claimed may be stopped for local admission pressure.
  let claimIncarnation: number | null;
  try {
    claimIncarnation = await claimSessionRun(session.id, containerName, { adopting: true });
  } catch (err) {
    log.error('Session claim write failed during adoption — leaving the container unadopted for retry', {
      sessionId: session.id,
      containerName,
      err,
    });
    return pending();
  }
  if (claimIncarnation === null) {
    log.warn('Session adoption skipped — another live host process holds the claim', {
      sessionId: session.id,
      containerName,
    });
    return pending();
  }
  // Claim and hold go back only once the container is PROVEN gone: a failed stop must stay claimed and pending,
  // or a later wake spawns a second writer beside it.
  if (!hold.fits) {
    log.warn('Adoption refused — the container does not fit the memory admission budget; stopping it', {
      sessionId: session.id,
      containerName,
    });
    const stopped = stopUnadoptable(containerName, 'does not fit the memory admission budget', session.id);
    if (!stopped || !containerProvenGone(containerName)) {
      log.warn(
        'Adoption refused for memory but the container is not proven gone — keeping its claim and retrying on wake',
        {
          sessionId: session.id,
          containerName,
          stopIssued: stopped,
        },
      );
      return pending();
    }
    await releaseClaimQuietly(session.id, claimIncarnation);
    await releasePendingHold(session.id);
    return { outcome: 'stopped', reason: 'does not fit the memory admission budget' };
  }
  try {
    await registerAdoptedContainer(session, containerName, claimIncarnation, hold.lease);
  } catch (err) {
    // No waiter: hand the claim back (the hold stays pending) and let the wake path retry.
    log.error('Could not register an adopted container — releasing its claim for retry', {
      sessionId: session.id,
      containerName,
      err,
    });
    activeContainers.delete(session.id);
    await releaseClaimQuietly(session.id, claimIncarnation);
    return pending();
  }
  transferPendingHold(session.id);
  // Counted only; `releaseOrphanedRepoIngressFencesAtStartup` releases a dead host's fence after adoption.
  let fencedInbound = false;
  try {
    fencedInbound =
      (await withExistingMailboxSession(
        session.agent_group_id,
        session.id,
        (mailbox) => mailbox.readRepoIngressFence()?.state === 'active',
      )) === true;
  } catch (err) {
    log.warn("Could not read an adopted session's inbound fence", { sessionId: session.id, err });
  }
  return { outcome: 'adopted', fencedInbound };
}

/** Issue `docker stop`; true when the stop call succeeded (not a proof the container is gone). */
function stopUnadoptable(containerName: string, why: string, sessionId: string | null): boolean {
  try {
    stopContainer(containerName);
    log.info('Stopped an unadoptable container at startup', { containerName, sessionId, why });
    return true;
  } catch (err) {
    log.warn('Failed to stop an unadoptable container at startup', { containerName, sessionId, why, err });
    return false;
  }
}

/**
 * A duplicate this host cannot prove removed fails the boot: when the owned container exits, finalization would
 * release claim, reservation and leases while the duplicate keeps writing the outbound DB.
 */
function removeDuplicateContainer(
  container: { name: string; sessionId: string | null },
  kind: 'tracked' | 'pending',
  owner: string,
): void {
  stopUnadoptable(container.name, `session already has a ${kind} container`, container.sessionId);
  if (!containerProvenGone(container.name)) {
    try {
      killContainerHard(container.name);
    } catch (err) {
      log.warn('docker kill failed for a duplicate container', { containerName: container.name, err });
    }
  }
  if (containerProvenGone(container.name)) return;
  log.error('Boot cannot continue: a duplicate container for an owned session could not be stopped', {
    sessionId: container.sessionId,
    containerName: container.name,
    ownedContainerName: owner,
    kind,
  });
  throw new Error(
    `Boot cannot continue: duplicate container ${container.name} for a ${kind} session could not be stopped (${owner} keeps it)`,
  );
}

/** Inventory unreadable but the door said this session survived: fail closed (owned, leased, retried on wake). */
async function holdUnlistedSurvivor(sessionId: string): Promise<void> {
  pendingAdoptions.add(sessionId);
  try {
    const session = await getSession(sessionId);
    if (session) await holdAsPending(session, null);
  } catch (err) {
    log.warn('Could not read the session row for an unlisted survivor — held pending without its resources', {
      sessionId,
      err,
    });
  }
}

/**
 * Runs once at boot, after the quiescence door and BEFORE every wake source and the orphaned-fence recovery
 * (`src/adoption-order.test.ts` pins both). A listing failure adopts nothing. A container with no session label,
 * no session row, or an unwakeable session is stopped.
 */
export async function adoptRunningSessions(
  deps: {
    list?: () => InstallContainerScope[];
    /** The door's survivable partition: when given, THE candidate set; a listed container outside it is stopped. */
    survivableSessionIds?: ReadonlySet<string> | readonly string[];
    /**
     * Sessions the door actually LEFT running: the fail-closed seed when this pass cannot list. Defaults to
     * `survivableSessionIds`; empty when the door stopped the survivable containers too.
     */
    heldOnInventoryFailure?: ReadonlySet<string> | readonly string[];
  } = {},
): Promise<StartupReconciliation> {
  if (deps.list) adoptionListing = deps.list;
  const asSet = (ids: ReadonlySet<string> | readonly string[] | undefined): ReadonlySet<string> | null =>
    ids === undefined ? null : ids instanceof Set ? (ids as ReadonlySet<string>) : new Set(ids as readonly string[]);
  const survivable = asSet(deps.survivableSessionIds);
  const heldOnFailure = asSet(deps.heldOnInventoryFailure) ?? survivable;
  const counts: StartupReconciliation = { adopted: 0, stopped: 0, pendingClaim: 0, fencedInbound: 0 };
  let containers: InstallContainerScope[];
  try {
    containers = adoptionListing();
  } catch (err) {
    if (heldOnFailure && heldOnFailure.size > 0) {
      // An unlistable runtime is no evidence these are gone: hold each pending until a re-list succeeds.
      log.warn('Session adoption listing failed — holding every survivable session as pending', {
        err,
        sessions: [...heldOnFailure],
      });
      for (const sessionId of heldOnFailure) {
        await holdUnlistedSurvivor(sessionId);
        counts.pendingClaim += 1;
      }
      log.info('Reconciled sessions at startup', { ...counts });
      return counts;
    }
    if (heldOnFailure) {
      log.warn('Adoption inventory failed; nothing left running by the boot door, nothing held', { err });
      return counts;
    }
    log.warn('Session adoption skipped — runtime listing failed', { err });
    return counts;
  }
  /** Stop and PROVE gone; a stop that fails or cannot be proven is held pending (unless there is no session). */
  const stopOrHold = async (container: InstallContainerScope, why: string, session: Session | undefined) => {
    if (stopUnadoptable(container.name, why, container.sessionId) && containerProvenGone(container.name)) {
      counts.stopped += 1;
      return;
    }
    if (!session) {
      log.error('An unadoptable container could not be stopped and has no session to hold it for', {
        containerName: container.name,
        sessionId: container.sessionId,
        why,
      });
      return;
    }
    log.warn('An unadoptable container could not be stopped — holding it pending', {
      containerName: container.name,
      sessionId: session.id,
      why,
    });
    await holdAsPending(session, container);
    observePending(session.id);
    counts.pendingClaim += 1;
  };
  const readSession = async (container: InstallContainerScope): Promise<Session | undefined> => {
    try {
      return await getSession(container.sessionId!);
    } catch (err) {
      log.error('Session adoption deferred — the session row could not be read', {
        sessionId: container.sessionId,
        containerName: container.name,
        err,
      });
      return undefined;
    }
  };
  for (const container of containers) {
    if (!container.sessionId) {
      // Defensive: under the boot door an unlabelled container is already in its stop set.
      await stopOrHold(container, 'no session label', undefined);
      continue;
    }
    if (survivable && !survivable.has(container.sessionId)) {
      await stopOrHold(container, 'outside the boot-scope survivable partition', await readSession(container));
      continue;
    }
    let session: Session | undefined;
    try {
      session = await getSession(container.sessionId);
    } catch (err) {
      log.error('Session adoption deferred — the session row could not be read', {
        sessionId: container.sessionId,
        containerName: container.name,
        err,
      });
      pendingAdoptions.add(container.sessionId);
      counts.pendingClaim += 1;
      continue;
    }
    const reason = unwakeableReason(session);
    if (reason !== null) {
      await stopOrHold(container, reason, session);
      continue;
    }
    const tracked = activeContainers.get(container.sessionId);
    if (tracked) {
      // Duplicate of a tracked session: not held pending on failure (a pending mark would misroute its wakes).
      removeDuplicateContainer(container, 'tracked', tracked.containerName);
      counts.stopped += 1;
      continue;
    }
    const held = pendingHolds.get(container.sessionId)?.containerName ?? null;
    if (held !== null && held !== container.name) {
      // Duplicate of a pending hold: never re-point the hold, or the first container runs on untracked.
      removeDuplicateContainer(container, 'pending', held);
      counts.stopped += 1;
      continue;
    }
    const result = await adoptRunningSession(session!, container.name, container.workgroupId);
    if (result.outcome === 'pending') {
      counts.pendingClaim += 1;
      continue;
    }
    if (result.outcome === 'stopped') {
      counts.stopped += 1;
      continue;
    }
    counts.adopted += 1;
    if (result.fencedInbound) counts.fencedInbound += 1;
  }
  // `honorPendingStopIntents()` runs in `main()`: it can spawn, and this pass must stay a pure inventory.
  log.info('Reconciled sessions at startup', { ...counts });
  return counts;
}

/**
 * P4: re-list. Gone → `false`, and the caller spawns fresh. Still there → claim-then-register as boot did; a
 * refused claim or an unlistable runtime THROWS, so no spawn happens and the sweep retries.
 */
async function retryPendingAdoption(session: Session): Promise<boolean> {
  const survivor = adoptionListing().find((container) => container.sessionId === session.id);
  if (!survivor) {
    await releasePendingHold(session.id);
    log.info('Pending adoption cleared — the container is gone, a fresh spawn is correct', {
      sessionId: session.id,
    });
    return false;
  }
  const fresh = await refreshActiveSession(session, 'pending-adoption');
  if (!fresh) {
    // Ownership is dropped only once the stop is proven; otherwise it stays pending for the next wake.
    if (
      !stopUnadoptable(survivor.name, 'session cannot take a wake', session.id) ||
      !containerProvenGone(survivor.name)
    ) {
      throw new Error(`session ${session.id} has a running container that could not be stopped — not spawning`);
    }
    await releasePendingHold(session.id);
    return false;
  }
  const result = await adoptRunningSession(fresh, survivor.name, survivor.workgroupId);
  if (result.outcome === 'pending') {
    throw new Error(`session ${session.id} has a running container this host could not claim — not spawning`);
  }
  if (result.outcome === 'stopped') {
    // Stopped for the memory budget and proven gone: ordinary admission decides a spawn.
    return false;
  }
  log.info('Adopted a pending survivor on wake', { sessionId: session.id, containerName: survivor.name });
  return true;
}

/**
 * The DURABLE half of a stop request (`onExit` is process memory), consumed by `honorPendingStopIntents()` at the
 * next startup. The intent comes from the CALLER, never from the presence of `onExit`: deriving it would resurrect
 * every bookkeeping-only kill at the next boot. Not awaited because `killContainer` must stay synchronous.
 */
function recordStopIntent(sessionId: string, intent: StopIntent): void {
  if (intent === 'respawn_after_stop') respawnIntents.set(sessionId, ++respawnIntentSeq);
  else respawnIntents.delete(sessionId);
  void shadowWrite('stop-intent', () => setStopIntent(sessionId, intent, new Date().toISOString()));
}

/**
 * Discharge this process's respawn promise once the session has a container again; otherwise every later boot
 * replays it. Only a wake that read THIS promise's token when it started may discharge it (see `respawnIntents`).
 */
function clearRespawnIntentOnWake(sessionId: string, token: number | undefined): void {
  if (token === undefined) return;
  if (respawnIntents.get(sessionId) !== token) return;
  respawnIntents.delete(sessionId);
  void shadowWrite('stop-intent-clear', () => setStopIntent(sessionId, null, new Date().toISOString()));
}

/**
 * Reconcile the unconsumed `on_wake` rows an ADOPTED session carries. `withExistingMailboxSession`, never the
 * provisioning opener: the host must never create an `outbound.db`. Best-effort: one unreadable session DB must
 * not abort the boot pass.
 */
export async function reconcileSurvivorWakeRows(session: Session): Promise<{ converted: number; withdrawn: number }> {
  /* eslint-disable no-catch-all/no-catch-all -- one unreadable session DB must not abort the boot pass */
  try {
    const result = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox.reconcileSurvivorWakeRows(),
    );
    if (!result) return { converted: 0, withdrawn: 0 };
    if (result.converted > 0 || result.withdrawn > 0) {
      log.info('Reconciled unconsumed on_wake rows for an adopted session', { sessionId: session.id, ...result });
    }
    return result;
  } catch (err) {
    log.warn('Could not reconcile on_wake rows for an adopted session', { sessionId: session.id, err });
    return { converted: 0, withdrawn: 0 };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/**
 * Consume durable `respawn_after_stop` rows at startup: a session whose container is still up gets its kill
 * re-issued with the respawn re-armed; otherwise it is respawned directly. The intent clears only once the wake
 * succeeds. Plain `'stop'` rows are already honoured and are cleared after. A session pending adoption keeps its row.
 */
export async function honorPendingStopIntents(
  wake: (session: Session) => Promise<boolean> = wakeContainer,
  hasContainer: (sessionId: string) => boolean = isContainerRunning,
): Promise<void> {
  let intents: SessionClaimRow[];
  /* eslint-disable no-catch-all/no-catch-all -- an unreadable coordination table must not block startup */
  try {
    intents = await listSessionsWithStopIntent();
  } catch (err) {
    log.warn('Failed to read pending stop intents', { err });
    return;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  for (const intent of intents) {
    if (intent.stop_intent !== 'respawn_after_stop') continue;
    if (pendingAdoptions.has(intent.session_id)) {
      // Alive but not yet re-fenced: acting now could kill or respawn the wrong incarnation.
      log.warn('Deferring stop intent — session awaits claim-fenced adoption', { sessionId: intent.session_id });
      continue;
    }
    const session = await getSession(intent.session_id);
    // `unwakeableReason`, not `status`: an archive-only close reads `active`, and the row would be declined forever.
    const unwakeable = session ? unwakeableReason(session) : 'session no longer exists';
    if (!session || unwakeable !== null) {
      log.info('Clearing a stop intent for a session that can no longer be woken', {
        sessionId: intent.session_id,
        reason: unwakeable,
      });
      await shadowWrite('stop-intent-clear', () => setStopIntent(intent.session_id, null, new Date().toISOString()));
      continue;
    }
    const respawn = async (): Promise<void> => {
      const woke = await wake(session);
      if (woke) {
        await shadowWrite('stop-intent-clear', () => setStopIntent(session.id, null, new Date().toISOString()));
      }
    };
    if (hasContainer(session.id)) {
      // The container outlived the host that ordered the kill: re-issue it with the respawn re-armed.
      log.info('Re-issuing interrupted restart', { sessionId: session.id });
      killContainer(session.id, 'restart-intent-recovery', () => void respawn(), 'respawn_after_stop');
    } else {
      await respawn();
    }
  }
  await clearHonouredStopIntents(intents, hasContainer);
}

/**
 * Clear the plain `'stop'` rows the boot pass read, matching value AND the `updated_at` read, so a row rewritten
 * since is left for the next boot. A row whose session was ADOPTED this boot is a stale request: cleared and
 * logged, never acted on (the sweep re-kills on its own evidence).
 */
/** Rows per clear statement: two bound variables each, well inside SQLite's limit. */
const STOP_INTENT_CLEAR_CHUNK = 400;

async function clearHonouredStopIntents(
  intents: SessionClaimRow[],
  hasContainer: (sessionId: string) => boolean,
): Promise<void> {
  const plain = intents.filter((intent) => intent.stop_intent === 'stop');
  if (plain.length === 0) return;
  const pending = plain.filter((intent) => pendingAdoptions.has(intent.session_id));
  const honoured = plain.filter((intent) => !pendingAdoptions.has(intent.session_id));
  let cleared = 0;
  if (honoured.length > 0) {
    // Chunked to stay under SQLite's bound-variable limit, inside one transaction so the clear is all-or-nothing.
    const now = new Date().toISOString();
    // `RETURNING` names the rows actually cleared (a subset), so a log line never claims a clear that did not happen.
    let clearedIds: string[];
    /* eslint-disable no-catch-all/no-catch-all -- a failed clear must not block startup; it is reported and retried next boot */
    try {
      clearedIds = await centralTransaction(async () => {
        const ids: string[] = [];
        for (let at = 0; at < honoured.length; at += STOP_INTENT_CLEAR_CHUNK) {
          const chunk = honoured.slice(at, at + STOP_INTENT_CLEAR_CHUNK);
          const rows = await getDb().all<{ session_id: string }>(
            `UPDATE session_claims SET stop_intent = NULL, updated_at = ?
               WHERE stop_intent = 'stop' AND (session_id, updated_at) IN (VALUES ${chunk.map(() => '(?, ?)').join(', ')})
             RETURNING session_id`,
            now,
            ...chunk.flatMap((intent) => [intent.session_id, intent.updated_at]),
          );
          for (const row of rows) ids.push(row.session_id);
        }
        return ids;
      }, 'stop-intent-clear');
    } catch (err) {
      log.warn('Failed to clear honoured stop intents at startup — left for the next boot', {
        rows: honoured.length,
        err,
      });
      return;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    cleared = clearedIds.length;
    for (const sessionId of clearedIds) {
      if (hasContainer(sessionId)) {
        log.info('Cleared a stale plain stop intent for an adopted survivor', { sessionId });
      }
    }
  }
  log.info('Cleared honoured stop intents at startup', {
    cleared,
    deferredPendingAdoption: pending.length,
  });
}

/** Checked at the reserved spawn boundary AND as the last word before `docker run`: everything between awaits. */
function pendingKillCancellation(sessionId: string): Error | null {
  const pending = pendingKills.get(sessionId);
  return pending ? new Error(`Container spawn cancelled by a kill request: ${pending.reason}`) : null;
}

/** Called from `trackWake`'s completion, where every wake ends, so a wake that dies early still settles the request. */
function settlePendingKill(sessionId: string): void {
  const pending = pendingKills.get(sessionId);
  if (!pending) return;
  // Another wake is in flight: the request is against the SESSION, so leave it for that wake.
  if (isContainerSpawning(sessionId)) return;
  pendingKills.delete(sessionId);
  if (activeContainers.has(sessionId)) {
    // A process registered before the request could stop it: kill it; callbacks ride its exit.
    stopRunningContainer(sessionId, pending.reason, pending.onExit);
    return;
  }
  // The wake may still be QUEUED in the admission controller: cancel it, or a later release would spawn into a
  // session the caller already archived as final (an archive-only close still reads `active`).
  cancelMemoryAdmission(sessionId);
  // No process close to ride, so the exit work runs now.
  clearStatusOnKill(sessionId, pending.reason);
  for (const callback of pending.onExit) {
    try {
      void Promise.resolve()
        .then(callback)
        .catch((err: unknown) =>
          log.warn('Container kill exit callback failed after a cancelled spawn', { sessionId, err }),
        );
    } catch (err) {
      log.warn('Container kill exit callback threw after a cancelled spawn', { sessionId, err });
    }
  }
}

/**
 * Door 1 of host shutdown: close the spawn path (every spawn re-checks `containerShutdownInProgress`), drop the
 * admission queue, wait for in-flight wakes, and leave running containers for the next host to adopt. The unit's
 * `KillMode=mixed` and empty `ExecStop` are the other doors; without them systemd still kills the containers.
 */
/** Under door 1 this is empty: every running container is left for the next host to adopt. */
export function planContainerShutdown(): ReadonlySet<string> {
  return new Set<string>();
}

export async function beginContainerShutdown(
  gracePeriodMs: number = 10_000,
): Promise<{ running: number; adopted: number; spawning: number; stopping: number }> {
  containerShutdownInProgress = true;
  memoryAdmission?.shutdown();
  const inFlight = [...wakePromises.values()];
  const running = activeContainers.size;
  const adopted = getAdoptedSessionIds().length;
  const stopping = planContainerShutdown().size;
  log.info('Container shutdown begun — leaving running containers for the next host to adopt', {
    running,
    adopted,
    stopping,
    spawning: inFlight.length,
    gracePeriodMs,
  });
  if (inFlight.length > 0) {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, gracePeriodMs);
    });
    await Promise.race([Promise.allSettled(inFlight).then(() => undefined), timeout]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  return { running, adopted, spawning: inFlight.length, stopping };
}

/**
 * NOT on the shutdown path (containers survive a host restart and are adopted); kept as the rollback path for a
 * unit that still stops nothing. Stops every tracked container, waits up to `gracePeriodMs`, then kills.
 */
export async function stopAllContainers(gracePeriodMs: number = 10_000): Promise<void> {
  containerShutdownInProgress = true;
  memoryAdmission?.shutdown();
  const entries = Array.from(activeContainers.entries());
  if (entries.length === 0) return;
  log.info('Stopping all containers', { count: entries.length, gracePeriodMs });
  const exits = entries.map(([sessionId, entry]) => {
    const exited = new Promise<void>((resolve) => {
      if (channelHasExited(entry.channel)) {
        resolve();
        return;
      }
      channelOnClose(entry.channel, () => resolve());
    });
    hostStoppedContainers.add(entry.containerName);
    try {
      stopContainer(entry.containerName);
    } catch (err) {
      log.warn('stopContainer threw; falling back to SIGKILL', { sessionId, err });
      channelKillFallback(entry, sessionId);
    }
    return exited;
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, gracePeriodMs);
  });
  await Promise.race([Promise.all(exits).then(() => undefined), timeout]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  for (const [sessionId, entry] of activeContainers.entries()) {
    log.warn('Container did not exit within grace period; SIGKILL', {
      sessionId,
      containerName: entry.containerName,
    });
    channelKillFallback(entry, sessionId);
  }
}

/** `<BASE>_<FOLDER_UPPER>` (dashes→underscores), else `<BASE>`. */
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

/** Forwarded under their unscoped names so the runner's `_N` rotation regexes match verbatim. */
export interface ResolvedAnthropicAuth {
  oauthPrimary?: string;
  oauthFallbacks: { index: number; value: string }[];
  apiKeyPrimary?: string;
  apiKeyFallbacks: { index: number; value: string }[];
  /**
   * The OAuth set came from a per-group scope. Slots are forwarded under unscoped `_N` names either way, so this
   * is the ONLY thing distinguishing "global slot 2" from "this group's slot 2" (different accounts).
   */
  oauthScoped: boolean;
}

/**
 * When `<BASE>_<FOLDER_UPPER>` is set, the ENTIRE rotation set comes from the per-group variant and global tokens
 * are not forwarded, so a workplace account never falls back to a personal one. Folders matching `^\d+$` collide
 * with the rotation suffix and skip per-group resolution.
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
    oauthScoped: oauth.scoped,
  };
}

/** Wiki actors receive model credentials only: the subscription token set if present, else the API-key set. */
export function wikiModelAuth(auth: ResolvedAnthropicAuth): Record<string, string> {
  if (auth.oauthPrimary) {
    return Object.fromEntries([
      ['CLAUDE_CODE_OAUTH_TOKEN', auth.oauthPrimary],
      ...auth.oauthFallbacks.map(({ index, value }) => [`CLAUDE_CODE_OAUTH_TOKEN_${index}`, value]),
    ]);
  }
  if (auth.apiKeyPrimary) {
    return Object.fromEntries([
      ['ANTHROPIC_API_KEY', auth.apiKeyPrimary],
      ...auth.apiKeyFallbacks.map(({ index, value }) => [`ANTHROPIC_API_KEY_${index}`, value]),
    ]);
  }
  throw new Error('Wiki Claude model authentication unavailable');
}

/** The isolated runtime has no model-only route through the locked network. */
export function assertWikiEgressAllowed(egressLockdown: boolean): void {
  if (egressLockdown) throw new Error('Wiki maintenance requires direct model egress');
}

/** `~/.codex-<folder>/` with a real `auth.json` (a separate account via `CODEX_HOME=… codex login`) wins over `~/.codex/`. */
export function resolveCodexAuthDir(folder: string, homedir: string = os.homedir()): string {
  const scoped = path.join(homedir, `.codex-${folder}`);
  if (fs.existsSync(path.join(scoped, 'auth.json'))) return scoped;
  return path.join(homedir, '.codex');
}

/** Index 0 maps to `.codex-fallback-1`, index 1 to `.codex-fallback-2`, etc. */
export interface CodexAuthFallback {
  hostPath: string;
  containerPath: string;
}

const CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH = '/home/node/.codex-host-primary';

/**
 * Entries without an `auth.json`, equal to the primary, or already seen are silently skipped. Both the mount block
 * and the env-forward block call this so they stay in sync.
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
 * A credential-staging failure caused by HOST STATE: a syscall error (bare `E…` code; Node's own `ERR_…`
 * validation codes are bugs and must rethrow), an `Unsafe …` staging refusal, or `Invalid group folder` (live
 * folders can fail the grammar). A PEER credential is withheld on these; anything else rethrows, or a TypeError
 * would silently disable a provider fleet-wide.
 */
const HOST_STATE_REFUSAL = /^(Unsafe |Invalid group folder )/;

function isHostStateFailure(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) || HOST_STATE_REFUSAL.test(err.message);
}

/**
 * A session-local CODEX_HOME whose only host coupling is `auth.json`, FILE-bind-mounted so an in-container OAuth
 * refresh writes back to the host; the rest of the host home (config, hooks, AGENTS.md, transcripts) never reaches
 * the container.
 */
export function stageCodexAuth(hostHomePath: string, runtimeHostPath: string, containerPath: string): VolumeMount[] {
  fs.mkdirSync(runtimeHostPath, { recursive: true });
  assertRealDirectory(runtimeHostPath);
  assertRealDirectory(hostHomePath);
  removeUntrustedPathEntry(runtimeHostPath, 'plugins');
  removeUntrustedPathEntry(runtimeHostPath, '.tmp');

  const hostAuth = path.join(hostHomePath, 'auth.json');
  const hostAuthStat = fs.lstatSync(hostAuth, { throwIfNoEntry: false });
  if (!hostAuthStat || hostAuthStat.isSymbolicLink() || !hostAuthStat.isFile()) {
    throw new Error(`Unsafe codex auth file: ${hostAuth}`);
  }
  replaceUntrustedFile(runtimeHostPath, 'config.toml', buildContainerCodexConfig());

  // Docker file bind targets must exist before the parent runtime-home mount.
  replaceUntrustedFile(runtimeHostPath, 'auth.json', '');

  return [
    { hostPath: runtimeHostPath, containerPath, readonly: false },
    { hostPath: hostAuth, containerPath: `${containerPath}/auth.json`, readonly: false },
  ];
}

/** Adds `sessions/`, the one piece of mutable history a rotated-to identity must keep. */
export function materializeCodexFallbackRuntime(fallback: CodexAuthFallback, runtimeHostPath: string): VolumeMount[] {
  const mounts = stageCodexAuth(fallback.hostPath, runtimeHostPath, fallback.containerPath);

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
 * `onecli run --` injects this literal as the host's CLAUDE_CODE_OAUTH_TOKEN. Forwarded to a container it reaches
 * api.anthropic.com verbatim (`401 Invalid bearer token`), so treat it as absent.
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
): { primary?: string; fallbacks: { index: number; value: string }[]; scoped: boolean } {
  const folderTok = folder.toUpperCase().replace(/-/g, '_');
  const isPureDigits = /^\d+$/.test(folderTok);

  // process.env overlaid by a fresh read of `.env` (disk wins): the host loads `.env` once at startup, so token
  // edits would otherwise need a host restart. This also recovers values shadowed by the placeholder.
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
    return { primary: scopedPrimary, fallbacks, scoped: true };
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

  // Only numbered siblings exist (e.g. placeholder primary + real `_2`/`_3`): promote the first, or the
  // `if (hostOauth)` gate skips forwarding and the group loses its rotation pool.
  if (!primary && fallbacks.length > 0) {
    const promoted = fallbacks.shift()!;
    return { primary: promoted.value, fallbacks, scoped: false };
  }
  return { primary, fallbacks, scoped: false };
}

/** Remove every `-e <key>=...` pair from args. Mutates args in place. */
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
 * Merges into existing entries; adds both NO_PROXY and no_proxy when neither exists (Node reads uppercase, many
 * Python/Go tools only lowercase). Mutates args in place.
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

/** Per-group GCP service-account keys: `~/.config/nanoclaw-gcp/<credentialFolder>.json` (0600). */
const GCP_SA_KEYS_DIR = path.join(os.homedir(), '.config', 'nanoclaw-gcp');
/**
 * A dedicated dir, deliberately NOT under `~/.config/gcloud`: a file bind there makes Docker create the dir
 * root-owned, and gcloud/bq can no longer write their own state.
 */
const GCP_KEY_CONTAINER_PATH = '/home/node/.gcp/service-account.json';

/** Keeps gcloud state isolated from credential mounts; as container env it is also inherited by `docker exec`. */
const GCP_CLOUDSDK_CONFIG_CONTAINER_PATH = '/home/node/.gcloud-config';

/**
 * A file mount, not the OneCLI vault: gcloud MINTS tokens from the private key locally, so there is no header to
 * inject. Keyed on `credentialFolder` so siblings share the parent's key. Null when none is configured.
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

/** Split out so a test can prove the await: `JSON.stringify` of a Promise is `{}` and no lint rule catches it. */
export async function renderCapabilitiesSnapshot(
  agentGroupId: string,
  sessionMessagingGroupId: string | null,
  workgroupId?: string,
): Promise<string> {
  const caps = await getHostCapabilities(agentGroupId, sessionMessagingGroupId, workgroupId);
  return JSON.stringify(caps, null, 2) + '\n';
}

async function writeCapabilitiesSnapshot(
  agentGroupId: string,
  sessionId: string,
  sessionMessagingGroupId: string | null,
  workgroupId: string,
): Promise<void> {
  try {
    const rendered = await renderCapabilitiesSnapshot(agentGroupId, sessionMessagingGroupId, workgroupId);
    const outPath = path.join(sessionDir(agentGroupId, sessionId), 'capabilities.json');
    fs.writeFileSync(outPath, rendered);
  } catch (err) {
    log.warn('Failed to write capabilities snapshot', { err });
  }
}

/** Forwarded per group via `<NAME>_<FOLDER>` → `<NAME>`: only vars whose VALUE differs per group belong here. */
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
  'DBT_CLOUD_EMAIL',
  'DBT_CLOUD_PASSWORD',
  'DBT_CLOUD_API_URL',
  'DBT_HOST',
  'DBT_MULTICELL_ACCOUNT_PREFIX',
  'DBT_PROD_ENV_ID',
  'DBT_DEV_ENV_ID',
  'DBT_USER_ID',
  'DBT_MCP_DISABLE_TOOLS',
  'LOOKER_BASE_URL',
  'LOOKER_CLIENT_ID',
  'LOOKER_CLIENT_SECRET',
  'ATLASSIAN_BASE_URL',
  'SELECT_ORGANIZATION_ID',
  // Must stay in sync with capabilities.ts SCOPED_ENV_NAMES.
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESIDENTIAL_PROXY_URL',
  'OMNI_BASE_URL',
  'OMNI_API_KEY',
  'RAILWAY_API_TOKEN',
  'BROWSER_AUTH_URL',
  'BROWSER_AUTH_EMAIL',
  'BROWSER_AUTH_PASSWORD',
  'SUPABASE_PROJECT_REF',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
  // Env vars outrank the git_commit tool's `git -c user.name=` overrides, so these attribute commits to the human.
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

/** An explicit gitIdentity replaces only Git attribution; every other credential keeps its lookup order. */
export function resolveScopedCredentialEnv(
  containerConfig: Pick<ContainerConfig, 'gitIdentity'>,
  credentialFolder: string,
  resolve: (base: string, folder: string) => string | undefined = resolveScopedEnv,
): Record<string, string> {
  const configuredGitEnv = gitIdentityEnv(containerConfig.gitIdentity);
  const resolved: Record<string, string> = {};
  for (const base of SCOPED_CREDENTIAL_VARS) {
    const value = configuredGitEnv[base] ?? resolve(base, credentialFolder);
    if (value) resolved[base] = value;
  }
  return resolved;
}

export { resolveProviderName } from './db/container-configs.js';

async function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): Promise<{ provider: string; contribution: ProviderContainerContribution }> {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? await fn({
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

/**
 * Mounted FILE BY FILE: sibling groups share rules by per-file symlink, and a relative link resolves differently
 * inside a directory bind (different depth), so the host resolves each file and binds the real one.
 * SECURITY: the group dir is agent-writable, so a planted `x.md -> /etc/shadow` would enter the agent's prompt;
 * `isAllowedTarget` must be the overlay allowlist, and anything outside is skipped loudly.
 */
export function channelInstructionsMounts(
  groupDir: string,
  isAllowedTarget: (target: string) => boolean,
  agentGroupId: string,
): VolumeMount[] {
  const dir = path.join(groupDir, 'channel-instructions');
  let resolvedDir: string;
  try {
    resolvedDir = fs.realpathSync(dir);
  } catch {
    return [];
  }
  if (!isAllowedTarget(resolvedDir)) {
    log.warn('Refusing channel-instructions mount outside workgroup boundary', {
      agentGroupId,
      dir,
      target: resolvedDir,
    });
    return [];
  }

  const mounts: VolumeMount[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(resolvedDir);
  } catch {
    return [];
  }
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const linkPath = path.join(resolvedDir, entry);
    let realFile: string;
    try {
      realFile = fs.realpathSync(linkPath);
      if (!fs.statSync(realFile).isFile()) continue;
    } catch {
      // Dangling or vanished: a stale entry must not fail the spawn.
      continue;
    }
    if (!isAllowedTarget(realFile)) {
      log.warn('Refusing channel-instructions file outside workgroup boundary', {
        agentGroupId,
        file: linkPath,
        target: realFile,
      });
      continue;
    }
    mounts.push({
      hostPath: realFile,
      containerPath: `/workspace/channel-instructions/${entry}`,
      readonly: true,
    });
  }
  return mounts;
}

/** Unconditional and unsampled: an occasional stall is exactly what a sampled log would miss. */
function logSpawnStage(stage: string, startedAt: number): void {
  log.info('Spawn stage timing', { stage, ms: Date.now() - startedAt });
}

export async function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  // Reconciled by spawnContainer so every subsystem sees one value; direct callers (tests) fall back to the row.
  resolvedWgId?: string,
): Promise<VolumeMount[]> {
  const projectRoot = process.cwd();
  const wgKey = resolvedWgId ?? agentGroup.workgroup_id ?? agentGroup.folder;
  const wikiActor = wikiEnrollment(agentGroup.id, containerConfig.wikiMaintenance === true);
  if (wikiActor) {
    assertWikiActorConfig(containerConfig, wikiActor, wgKey);
    if (provider !== (containerConfig.provider ?? 'claude')) throw new Error('Wiki provider override refused');
    const sessDir = sessionDir(agentGroup.id, session.id);
    await migrateInboundDbToHostDir(sessDir, { agentGroupId: agentGroup.id, sessionId: session.id });
    assertHostOwnedInboundDb(sessDir, session.id);
    const members = await withCentralSync(
      () =>
        withRawDb((db) =>
          (db.prepare('SELECT id FROM agent_groups WHERE workgroup_id = ?').all(wgKey) as Array<{ id: string }>).map(
            (r) => r.id,
          ),
        ),
      'wiki archive membership',
    );
    if (!members.includes(agentGroup.id)) throw new Error('Wiki actor is outside its workgroup');
    const archiveDst = path.join(sessDir, 'archive.db');
    await ensureArchiveProjection(path.join(DATA_DIR, 'archive.db'), archiveDst, agentGroup.id, members);
    const contribution = wikiProviderContribution(providerContribution, sessDir, provider);
    const mounts: VolumeMount[] = [
      { hostPath: sessDir, containerPath: '/workspace', readonly: false },
      ...hostInboundMounts(sessDir),
      {
        hostPath: sessionContextPath(agentGroup.id, session.id),
        containerPath: '/app/.nanoclaw-session.json',
        readonly: true,
      },
      { hostPath: agentRunnerSourcePath(), containerPath: '/app/src', readonly: true },
      { hostPath: archiveDst, containerPath: '/workspace/archive.db', readonly: true },
      ...privateWikiRuntime(
        path.join(DATA_DIR, 'wiki-admission', 'runtime', agentGroup.id, session.id),
        containerConfig,
      ),
      ...contribution.mounts,
    ];
    return mounts;
  }
  const workgroupReadAccessStartedAt = Date.now();
  const workgroupReadAccess = await resolveWorkgroupReadAccess(wgKey);
  // The operator allowlist stays the final host-path gate: a policy grant can never bypass it.
  const validatedWorkgroupReadAccess = workgroupReadAccess
    ? validateAdditionalMounts(workgroupReadAccess.requests, `${agentGroup.name} (workgroup read access)`).map(
        (mount) => ({
          ...mount,
          workgroupReadAccess: true as const,
        }),
      )
    : [];
  logSpawnStage('workgroup-read-access', workgroupReadAccessStartedAt);
  // Resolved once, against this session's /workspace, so the composed doc and the mount set agree.
  const workgroupWiki = resolveWorkgroupWiki(wgKey, sessionDir(agentGroup.id, session.id));

  // Default agent surfaces apply unless the provider's registration declares its own (a capability, never a name).
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    const skillSymlinksStartedAt = Date.now();
    syncSkillSymlinks(claudeDir, containerConfig);
    logSpawnStage('skill-symlinks', skillSymlinksStartedAt);

    // Claude-only (other providers don't read ~/.claude/agents). Best-effort: a copy failure must not abort the spawn.
    if (provider === 'claude') {
      const workerAgentDefsStartedAt = Date.now();
      try {
        syncWorkerAgentDefs(claudeDir);
      } catch (err) {
        log.warn('Worker agent def sync failed — spawning without roster', {
          group: agentGroup.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      logSpawnStage('worker-agent-defs', workerAgentDefsStartedAt);
    }

    const claudeMdStartedAt = Date.now();
    await composeGroupClaudeMd(agentGroup, provider, {
      workgroupId: wgKey,
      workgroupReadAccessInstructions: workgroupReadAccessInstructions(
        workgroupReadAccess,
        validatedWorkgroupReadAccess,
      ),
      workgroupWikiInstructions: workgroupWikiInstructions(workgroupWiki),
    });
    logSpawnStage('claude-md-compose', claudeMdStartedAt);
  }

  const mounts: VolumeMount[] = [];
  mounts.push(...validatedWorkgroupReadAccess);
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace, RW for outbound.db, outbox/ and .heartbeat. inbound.db is host-owned and MUST be
  // unwritable: a FILE-level read-only overlay is NOT enough, because SQLite's rollback journal is a sibling path a
  // container could plant and the host would replay as a hot journal (a proven forgery). So inbound.db lives in
  // `<session>/.host/` and that DIRECTORY is overlaid read-only (see src/modules/mailbox/host-inbound.ts).
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });
  // Host-owned, outside the agent-writable session dir; written by spawnContainer before this runs.
  mounts.push({
    hostPath: sessionContextPath(agentGroup.id, session.id),
    containerPath: '/app/.nanoclaw-session.json',
    readonly: true,
  });
  // Migrate inbound.db under `.host/` and REFUSE THE SPAWN unless it is host-owned: no container may run against a
  // database in a directory it can write. Fail closed.
  await migrateInboundDbToHostDir(sessDir, { agentGroupId: agentGroup.id, sessionId: session.id });
  assertHostOwnedInboundDb(sessDir, session.id);
  mounts.push(...hostInboundMounts(sessDir));

  // One canonical work-unit resolver: same-topic siblings share a checkout; different topics get different roots.
  const workgroupMountsStartedAt = Date.now();
  const repositoryWorkUnit = await resolveSessionRepositoryWorkUnit(session, wgKey);
  const worktrees = topicWorktreesDir(repositoryWorkUnit);
  fs.mkdirSync(worktrees, { recursive: true });
  // Stable agent-facing path plus the exact host path. Git worktree metadata
  // records the latter, so the same pointer works from host and container.
  mounts.push({ hostPath: worktrees, containerPath: '/workspace/worktrees', readonly: false });
  mounts.push({ hostPath: worktrees, containerPath: worktrees, readonly: false });

  // Canonical working trees stay host-only; linked worktrees get the common `.git`, origin pin and kernel lock at
  // their exact host paths. Judged per repository, so one tampered `.git` withholds that repository, not the spawn.
  const canonicals = classifyCanonicalRepositories(wgKey);
  for (const broken of canonicals.unusable) {
    log.error(
      broken.commondir
        ? 'canonical repository withheld: its .git holds a commondir that is not the sentinel (#669: re-raise)'
        : 'canonical repository withheld: it is not a usable normal clone',
      { workgroupId: wgKey, repository: broken.name, path: broken.path, reason: broken.reason },
    );
  }
  for (const repository of canonicals.repositories) {
    if (!readOriginPin(wgKey, repository.name)) {
      throw new Error(`Canonical repository ${wgKey}/${repository.name} is missing its host origin pin`);
    }
    const transfers = transferTombstonesDir(wgKey, repository.name);
    fs.mkdirSync(transfers, { recursive: true, mode: 0o700 });
    mounts.push({ hostPath: transfers, containerPath: transfers, readonly: true });
    if (readTransferTombstone(repositoryWorkUnit, repository.name)) {
      // Left this topic: withholding the common Git metadata makes the tombstone a spawn-time boundary too.
      continue;
    }
    // Hook AND refuse fallback both invalid: withhold every mount. Decided before the gitDir mount, since a partial
    // withhold would still let an agent push unscanned.
    const hooksDecision = resolveScanPolicyHooksMount(repository);
    if (hooksDecision.withhold) {
      continue;
    }
    // The common store is writable, but config, hooks, canonical HEAD/index, the `commondir` sentinel and
    // object-alternates are immutable overlays, so container Git cannot clobber the canonical checkout. A
    // canonical whose commondir is not the sentinel gets every mount withheld, never the read-write .git alone.
    let controlMounts: VolumeMount[];
    try {
      controlMounts = canonicalGitControlMounts(repository.gitDir, path.dirname(repository.lockPath));
    } catch (error) {
      if (!(error instanceof ForeignCanonicalCommondirError)) throw error;
      log.error('canonical repository withheld: its .git holds a commondir that is not the sentinel (#669: re-raise)', {
        workgroupId: wgKey,
        repository: repository.name,
        path: error.path,
        state: error.state,
      });
      continue;
    }
    mounts.push({ hostPath: repository.gitDir, containerPath: repository.gitDir, readonly: false });
    mounts.push(...controlMounts);
    // Deduped: every scan-policy repository resolves to the SAME container path, and Docker rejects duplicate binds.
    for (const mount of hooksDecision.mounts) {
      if (!mounts.some((existing) => existing.containerPath === mount.containerPath)) {
        mounts.push(mount);
      }
    }
    mounts.push({ hostPath: repository.lockPath, containerPath: repository.lockPath, readonly: false });
    mounts.push({ hostPath: repository.originPinPath, containerPath: repository.originPinPath, readonly: true });
  }

  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Sibling-group symlink overlay: a relative symlink into a sibling group would dangle inside the container, so
  // each host-resolvable one is bind-mounted at its container path. Absolute targets that exist only in the
  // container are skipped. SECURITY: the group dir is agent-writable, so only targets the agent is entitled to
  // (own group, same-workgroup siblings, the workgroup shared tree) are overlaid; anything else is skipped loudly.
  const allowedOverlayRoots = [
    workgroupSharedDir(wgKey),
    ...(await getAllAgentGroups())
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
    let rawTarget: string;
    try {
      realTarget = fs.realpathSync(linkPath);
      rawTarget = fs.readlinkSync(linkPath);
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
    // Docker resolves a mount DESTINATION through the container's filesystem, so an upward-escaping relative link
    // lands in the /workspace session bind, where runc would create the parent as ROOT and reclaim could never
    // delete it; declaring the path lets spawn pre-create it as the host user. Derive it by RESOLUTION
    // (`realTarget`), never by lexical inspection of the link text, which misses intermediate symlinks. An
    // ABSOLUTE raw target is the exception: nothing in the container resolves it, so Docker uses the literal name.
    const containerPathFor = (resolved: string): string => {
      if (path.isAbsolute(rawTarget)) return `/workspace/agent/${entry.name}`;
      const inOwnGroup = path.relative(groupDir, resolved);
      if (inOwnGroup && !inOwnGroup.startsWith('..') && !path.isAbsolute(inOwnGroup)) {
        return path.posix.join('/workspace/agent', ...inOwnGroup.split(path.sep));
      }
      const inGroups = path.relative(GROUPS_DIR, resolved);
      if (inGroups && !inGroups.startsWith('..') && !path.isAbsolute(inGroups)) {
        return path.posix.join('/workspace', ...inGroups.split(path.sep));
      }
      // Representable only at its literal name (Docker has no symlink to follow).
      return `/workspace/agent/${entry.name}`;
    };
    mounts.push({
      hostPath: realTarget,
      containerPath: containerPathFor(realTarget),
      readonly: false,
      overlayAllowedRoots: allowedOverlayRoots,
    });
  }

  // Workgroup shared tree at /workspace/workgroup (flag-gated). Also mounted when a prior migration left a
  // `.migrated` marker, so turning the flag off does not dangle the compat symlinks.
  const wgId = wgKey;
  const wgShared = workgroupSharedDir(wgId);
  if (WORKGROUP_SHARED_FS || fs.existsSync(path.join(wgShared, '.migrated'))) {
    fs.mkdirSync(wgShared, { recursive: true });
    mounts.push({ hostPath: wgShared, containerPath: WORKGROUP_CONTAINER_PATH, readonly: false });
  }
  // Unconditional: in memory-only mode /workspace/workgroup is container-local, and the lock needs a host bind so
  // every provider and sibling flocks the same inode. In shared-FS mode it must follow the writable parent mount,
  // so the container cannot unlink or replace the inode.
  mounts.push(...resolveWorkgroupMemoryMounts(wgId));

  // Nested RO mount over the RW group dir: the agent can read its config but not modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Stamped plugin content, nested RO (writes go to plugin-data/). Unconditional: the dir always exists.
  const stampedPluginsDir = path.join(groupDir, 'plugins');
  mounts.push({ hostPath: stampedPluginsDir, containerPath: CONTAINER_PLUGINS_DIR, readonly: true });

  // Regenerated on every spawn, so any agent-side write would be clobbered: enforce read-only.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Gated on defaultSurfaces: a provider that owns its agent surfaces must not get Claude state mounted.
  if (defaultSurfaces) {
    mounts.push(
      ...replaceClaudeNativeMemoryMount(getSessionClaudeMounts(agentGroup, session), {
        provider,
        agentGroupId: agentGroup.id,
        workgroupId: wgId,
      }),
    );
  }

  // Per-agent projections, NEVER the global archive.db / v2.db: the container has raw SQLite access, so mounting
  // the globals would expose every tenant's chat history. Each spawn gets a projection of its own rows only.
  const archiveSrc = path.join(DATA_DIR, 'archive.db');
  const archiveDst = path.join(sessionDir(agentGroup.id, session.id), 'archive.db');
  // Defensive: projections need the session dir even when getSessionClaudeMounts (which also creates it) is skipped.
  fs.mkdirSync(sessionDir(agentGroup.id, session.id), { recursive: true });

  // The host pre-resolves the workgroup member set (archive.db has no agent_groups schema) so the projection can
  // use a parameterized IN list. Fails closed when the spawning agent has no workgroup; a DB without the
  // workgroup_id column falls back to the single-agent filter.
  logSpawnStage('workgroup-mounts', workgroupMountsStartedAt);

  const workgroupMembershipStartedAt = Date.now();
  let workgroupMemberIds: string[] | undefined;
  try {
    // One lease block: the membership read and the fail-closed check below
    // see a single snapshot of agent_groups.
    workgroupMemberIds = await withCentralSync(
      () =>
        withRawDb((db): string[] | undefined => {
          if (resolvedWgId) {
            const memberRows = db
              .prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ?`)
              .all(resolvedWgId) as Array<{ id: string }>;
            // Fail closed if the agent is no longer a member of the workgroup reconcile settled on: the projection
            // would lie.
            if (!memberRows.some((r) => r.id === agentGroup.id)) {
              throw new Error(
                `Workgroup-scoped projection: agent ${agentGroup.id} is not a member of workgroup ${resolvedWgId} at projection time ` +
                  `(refusing to fall through to legacy single-agent filter; this is the W3 fail-closed path).`,
              );
            }
            return memberRows.map((r) => r.id);
          } else {
            const centralCheck = db.prepare(`PRAGMA table_info(agent_groups)`).all() as Array<{ name: string }>;
            if (centralCheck.some((c) => c.name === 'workgroup_id')) {
              const agRow = db.prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(agentGroup.id) as
                | { workgroup_id: string | null }
                | undefined;
              if (agRow && agRow.workgroup_id === null) {
                throw new Error(
                  `Workgroup-scoped projection: invalid workgroup for agent ${agentGroup.id} — workgroup_id is NULL`,
                );
              }
              if (agRow && agRow.workgroup_id) {
                const memberRows = db
                  .prepare(`SELECT id FROM agent_groups WHERE workgroup_id = ?`)
                  .all(agRow.workgroup_id) as Array<{ id: string }>;
                return memberRows.map((r) => r.id);
              }
            }
          }
          return undefined;
        }),
      'workgroup projection membership',
    );
  } catch (err) {
    // Re-throw the fail-closed errors (shared 'Workgroup-scoped projection' prefix); otherwise fall back to the
    // single-agent filter.
    if (err instanceof Error && err.message.includes('Workgroup-scoped projection')) {
      throw err;
    }
    log.warn('workgroup membership resolution failed; falling back to single-agent projection', {
      err: err instanceof Error ? err.message : String(err),
      agentGroupId: agentGroup.id,
    });
  }
  logSpawnStage('workgroup-membership', workgroupMembershipStartedAt);

  // Rebuilt on a worker thread, only when its inputs moved: a synchronous rebuild stalls the host event loop for
  // seconds. A build that throws aborts the spawn.
  const archiveProjectionStartedAt = Date.now();
  await ensureArchiveProjection(archiveSrc, archiveDst, agentGroup.id, workgroupMemberIds);
  logSpawnStage('archive-projection', archiveProjectionStartedAt);
  mounts.push({ hostPath: archiveDst, containerPath: '/workspace/archive.db', readonly: true });
  // The workgroup's domain wiki, read-only, when the host keeps one (src/workgroup-wiki.ts).
  if (workgroupWiki) mounts.push(workgroupWiki.mount);

  const centralSrc = path.join(DATA_DIR, 'v2.db');
  const centralDst = path.join(sessionDir(agentGroup.id, session.id), 'central.db');
  // Synchronous on the main thread, deliberately: the central DB is small and this was measured as cheap.
  const centralProjectionStartedAt = Date.now();
  buildCentralProjection(centralSrc, centralDst, agentGroup.id);
  logSpawnStage('central-projection', centralProjectionStartedAt);
  mounts.push({ hostPath: centralDst, containerPath: '/workspace/central.db', readonly: true });

  // The boot-time snapshot activated in main.ts, not the live checkout (see src/agent-runner-source.ts).
  const agentRunnerSrc = agentRunnerSourcePath();
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Host-shared template overlaying the group folder, so `/workspace/agent/spawn-template.md` is stable and cannot
  // drift per group.
  const spawnTemplateSrc = path.join(projectRoot, 'container', 'spawn-template.md');
  if (fs.existsSync(spawnTemplateSrc)) {
    mounts.push({
      hostPath: spawnTemplateSrc,
      containerPath: '/workspace/agent/spawn-template.md',
      readonly: true,
    });
  }

  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const mountAllowlistStartedAt = Date.now();
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    logSpawnStage('mount-allowlist', mountAllowlistStartedAt);
    for (const mount of validated) {
      if (!workgroupReadAccess || !isWorkgroupReadAccessNamespace(mount.containerPath)) {
        mounts.push(mount);
        continue;
      }
      if (isDuplicateWorkgroupReadAccessMount(mount, validatedWorkgroupReadAccess)) {
        log.info('Deduplicated legacy workgroup read-access mount', {
          group: agentGroup.id,
          hostPath: mount.hostPath,
          containerPath: mount.containerPath,
        });
        continue;
      }
      throw new Error(
        `Additional mount ${mount.containerPath} collides with the host-owned ${'/workspace/extra/work'} namespace; declare the workgroup grant in ${path.join(DATA_DIR, 'workgroup-read-access.json')}`,
      );
    }
  }

  // Every ~/plugins subdir is mounted RO at /workspace/plugins/<name>. Only TOP-LEVEL excludePlugins entries are
  // honoured here; a sub-path entry is honoured by each runner/composer walker that would REGISTER the sub-plugin
  // (`isExcludedPluginPath`), because the host cannot predict container-side path resolution (masking with an
  // empty mount failed: an absolute symlink is absent to the host and live in the container).
  const pluginsHostDir = path.join(os.homedir(), 'plugins');
  if (fs.existsSync(pluginsHostDir)) {
    // Capability ships in-tree: mounting would duplicate the skill and start a second MCP server.
    const IN_TREE_SHADOWED_PLUGINS = ['design-artifact-loop', 'gitnexus'];
    const declared = splitExcludedPlugins(containerConfig.excludePlugins);
    const excluded = new Set([...IN_TREE_SHADOWED_PLUGINS, ...declared.topLevel]);
    const pluginScopes = loadPluginScopes(); // client plugins mount only in their workgroups
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsHostDir);
    } catch (err) {
      log.warn('Failed to read ~/plugins directory', { err });
    }
    warnUnmatchedPluginScopes(pluginScopes, entries);
    // Every declared exclusion must equal an entry on disk (exact `readdirSync` string, sub-paths segment by
    // segment), else REFUSE the spawn: an exclusion that matches nothing silently fails open (e.g. `codex` declared
    // withheld while the plugin and the host Codex OAuth session mount anyway), and no string validator can catch
    // every unmatchable name. Checks the NORMALIZED set from `splitExcludedPlugins`, so a sub-path under an
    // excluded ancestor is not refused (the ancestor already withholds it).
    const missing: string[] = [];
    for (const entry of [...declared.topLevel, ...declared.subPaths]) {
      let cursor = pluginsHostDir;
      for (const segment of entry.split('/')) {
        let listing: string[];
        try {
          listing = fs.readdirSync(cursor);
        } catch {
          missing.push(entry);
          break;
        }
        if (!listing.includes(segment)) {
          missing.push(entry);
          break;
        }
        cursor = path.join(cursor, segment);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `excludePlugins names ${missing.length === 1 ? 'an entry' : 'entries'} that do not exist under ${pluginsHostDir}: ` +
          `${missing.map((m) => JSON.stringify(m)).join(', ')} (group ${agentGroup.id}). ` +
          'An exclusion that matches nothing withholds nothing — fix or remove the entry.',
      );
    }
    for (const entry of entries) {
      if (excluded.has(entry) || !pluginAllowedForWorkgroup(entry, wgKey, pluginScopes)) continue;
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

    // Opt-in via `wixHostAuth`. RW because the Wix CLI rewrites its auth on refresh; mounted at /home/node/.wix
    // directly because additionalMounts sandboxes under /workspace/extra, where the CLI would never look.
    if (containerConfig.wixHostAuth === true) {
      const hostWix = path.join(os.homedir(), '.wix');
      if (fs.existsSync(hostWix)) {
        mounts.push({ hostPath: hostWix, containerPath: '/home/node/.wix', readonly: false });
      }
    }

    // Codex credential for every container; the withholding lever is excluding the `codex` plugin (made
    // fail-closed by the refusal above).
    if (!excluded.has('codex') && entries.includes('codex')) {
      const providerHasCodexMount = providerContribution.mounts?.some((m) => m.containerPath === '/home/node/.codex');

      // Staging throws on a malformed host home. Fatal for provider=codex (the credential IS the session); for any
      // other provider Codex is a PEER capability, so a host-state failure is logged and WITHHELD rather than
      // crash-looping every container.
      const stageOrWithhold = (what: string, stage: () => VolumeMount[]): VolumeMount[] => {
        try {
          return stage();
        } catch (err) {
          if (providerHasCodexMount || !isHostStateFailure(err)) throw err;
          log.warn('Codex credential withheld from peer container (staging failed)', {
            agentGroupId: agentGroup.id,
            containerPath: what,
            error: err.message,
          });
          return [];
        }
      };

      // provider=codex also gets the RO host home, the ONE place a container sees a whole host Codex home:
      // `refreshCodexAuthFromHost` re-reads auth.json there when the host REPLACES it, which a file bind would miss.
      const primaryHostPath = resolveCodexAuthDir(agentGroup.folder);
      if (providerHasCodexMount && fs.existsSync(path.join(primaryHostPath, 'auth.json'))) {
        mounts.push({
          hostPath: primaryHostPath,
          containerPath: CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH,
          readonly: true,
        });
      }

      if (!providerHasCodexMount && fs.existsSync(path.join(primaryHostPath, 'auth.json'))) {
        // STAGED, not bind-mounted: only `auth.json` is file-bound, so a prompt-injected agent cannot reach or plant
        // the operator's hooks/config/AGENTS.md that the next host-side `codex` run would execute. Keyed on
        // `agentGroup.folder`, NOT `credentialFolder`: a codex sibling usually wants its own ChatGPT identity.
        mounts.push(
          ...stageOrWithhold('/home/node/.codex', () =>
            stageCodexAuth(
              primaryHostPath,
              path.join(sessionDir(agentGroup.id, session.id), 'codex-peer'),
              '/home/node/.codex',
            ),
          ),
        );
      }

      // Fallback OAuth identities at /home/node/.codex-fallback-N/. Only provider=codex fallbacks carry `sessions/`
      // (rotation lands mid-session there); a peer's fallback is a credential only, since no peer runner reads it.
      const resolvedFallbacks = resolveCodexAuthFallbacks(containerConfig.codexAuthFallbacks, primaryHostPath);
      resolvedFallbacks.forEach((entry, index) => {
        const fallbackRuntime = path.join(sessionDir(agentGroup.id, session.id), 'codex-fallbacks', String(index + 1));
        mounts.push(
          ...stageOrWithhold(entry.containerPath, () =>
            providerHasCodexMount
              ? materializeCodexFallbackRuntime(entry, fallbackRuntime)
              : stageCodexAuth(entry.hostPath, fallbackRuntime, entry.containerPath),
          ),
        );
      });
    }
  }

  // Host OpenCode credential for every non-OpenCode container, AUTH ONLY. Withheld on a host-state failure like
  // the peer Codex stage: an agent that symlinked `/workspace/opencode-xdg` must not break its later spawns.
  if (provider !== 'opencode') {
    try {
      mounts.push(
        ...stageOpenCodeAuth(
          sessionDir(agentGroup.id, session.id),
          agentGroup.folder,
          agentGroup.id,
          process.env.HOME || os.homedir(),
        ).mounts,
      );
    } catch (err) {
      if (!isHostStateFailure(err)) throw err;
      log.warn('OpenCode credential withheld from container (staging failed)', {
        agentGroupId: agentGroup.id,
        containerPath: OPENCODE_XDG_CONTAINER_PATH,
        error: err.message,
      });
    }
  }

  // Project source at /workspace/project (RO), as a selective allowlist that excludes .env, data/, groups/,
  // repo-tokens/, logs/ and bulky paths. scripts/ and prompts/ are INTENTIONALLY excluded (scripts/ exposes
  // credential path topology); keep them out without a specific need and a review of their contents.
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

  // The one scripts/ exception: agents run the dependency audit, which reads only mounted manifests and src/, so
  // it exposes no credential-path topology.
  const auditScript = path.join(projectRoot, 'scripts', 'container-updates.ts');
  if (fs.existsSync(auditScript)) {
    mounts.push({
      hostPath: auditScript,
      containerPath: '/workspace/project/scripts/container-updates.ts',
      readonly: true,
    });
  }

  // /workspace/project has no `.git`, so the audit's upstream-policy derivation runs on the host and the container
  // reads this snapshot (src/container-updates.ts).
  const upstreamPolicySnapshot = path.join(DATA_DIR, 'upstream-policy.json');
  if (fs.existsSync(upstreamPolicySnapshot)) {
    mounts.push({
      hostPath: upstreamPolicySnapshot,
      containerPath: '/workspace/project/.upstream-policy.json',
      readonly: true,
    });
  }

  const toneProfilesDir = path.resolve(GROUPS_DIR, '..', 'tone-profiles');
  if (fs.existsSync(toneProfilesDir)) {
    mounts.push({
      hostPath: toneProfilesDir,
      containerPath: '/workspace/tone-profiles',
      readonly: true,
    });
  }

  // Group-owned tone profiles, resolved BEFORE the shared set, so a private persona can be selected per channel
  // (and can shadow a shared name) without publishing it.
  const groupToneProfilesDir = path.join(groupDir, 'tone-profiles');
  if (fs.existsSync(groupToneProfilesDir)) {
    mounts.push({
      hostPath: groupToneProfilesDir,
      containerPath: '/workspace/tone-profiles-group',
      readonly: true,
    });
  }

  mounts.push(...channelInstructionsMounts(groupDir, isAllowedOverlayTarget, agentGroup.id));

  // Filesystem credentials (private keys, INI/TOML with raw passwords, service-account JSON) are NOT
  // OneCLI-mediated, so they are gated by the per-agent `tools` allowlist: undefined mounts every surface (legacy);
  // a list stages only the named scopes (e.g. `snowflake:archive-one` stages one connections.toml section + keys).
  const home = os.homedir();
  const tools = containerConfig.tools;
  const stagingRoot = path.join(sessDir, 'creds');

  // rm+mkdir so stale files cannot leak between spawns of the same session (e.g. after a re-scope).
  const stageDir = (name: string): string => {
    const p = path.join(stagingRoot, name);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    fs.mkdirSync(p, { recursive: true });
    return p;
  };

  const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

    // Calendar reuses Gmail's OAuth app keys: mount JUST the keys file (the gmail dir would leak Gmail tokens).
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

  if (isToolEnabled(tools, 'google-workspace')) {
    const gwsAccountsDir = path.join(home, '.config', 'gws', 'accounts');
    if (fs.existsSync(gwsAccountsDir)) {
      const { scopes: gwsAccts, isScoped: gwsScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwsScoped) {
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

    const gwCredsDir = path.join(home, '.google_workspace_mcp', 'credentials');
    if (fs.existsSync(gwCredsDir)) {
      const { scopes: gwAccts, isScoped: gwScoped } = extractToolScopes(tools, 'google-workspace');
      if (gwScoped) {
        const dest = stageDir('google-workspace-mcp-credentials');
        for (const entry of fs.readdirSync(gwCredsDir)) {
          // Prefix match: allows <acct>.json, <acct>_token.json, etc.
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

  // Per-group SA key at a dedicated path; gated on the key file existing.
  {
    const gcpKey = resolveGcpServiceAccountKey(containerConfig.credentialFolder ?? agentGroup.folder);
    if (gcpKey) {
      mounts.push({ hostPath: gcpKey, containerPath: GCP_KEY_CONTAINER_PATH, readonly: true });
    }
  }

  if (isToolEnabled(tools, 'snowflake')) {
    const snowflakeDir = path.join(home, '.snowflake');
    const origToml = path.join(snowflakeDir, 'connections.toml');
    if (fs.existsSync(snowflakeDir) && fs.existsSync(origToml)) {
      const { scopes: allowedConns, isScoped: filterConns } = extractToolScopes(tools, 'snowflake');
      const dest = stageDir('snowflake');

      // Rewrite host paths to absolute /home/node paths: snowflake-connector-python does not expand `~`.
      const homePattern = new RegExp(escapeRegex(snowflakeDir) + '/', 'g');
      let tomlContent = fs.readFileSync(origToml, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
      if (filterConns) tomlContent = filterConfigSections(tomlContent, allowedConns);
      fs.writeFileSync(path.join(dest, 'connections.toml'), tomlContent, { mode: 0o600 });

      const origConfig = path.join(snowflakeDir, 'config.toml');
      if (fs.existsSync(origConfig)) {
        const configContent = fs.readFileSync(origConfig, 'utf-8').replace(homePattern, '/home/node/.snowflake/');
        fs.writeFileSync(path.join(dest, 'config.toml'), configContent, { mode: 0o600 });
      }

      // Copy only key files the (possibly filtered) toml references, never the whole keys/ dir under scoping.
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
          if (filterConns && referenced.size > 0 && !referenced.has(relPath)) continue;
          const destPath = path.join(destKeys, relPath);
          fs.mkdirSync(path.dirname(destPath), { recursive: true });
          fs.copyFileSync(srcPath, destPath);
          fs.chmodSync(destPath, 0o600);
        }
      }

      // Mount RW: snow CLI writes to ~/.snowflake/logs/.
      mounts.push({ hostPath: dest, containerPath: '/home/node/.snowflake', readonly: false });

      // Also at the host absolute path: some snowflake libs retry reads at the originally resolved path.
      if (snowflakeDir !== '/home/node/.snowflake') {
        mounts.push({ hostPath: dest, containerPath: snowflakeDir, readonly: false });
      }
    }
  }

  // Scoped `aws:<profile>` stages EXACTLY the named profiles, no implicit `default` (inheriting whatever account
  // `default` points at is a cross-tenant leak); request it as `aws:default`. Bare `aws` stages every profile.
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
          // AWS config uses `[profile foo]` headers.
          content = filterConfigSections(content, allowedProfiles, {
            headerTransform: (h) => h.replace(/^profile\s+/, ''),
          });
        }
        fs.writeFileSync(path.join(dest, 'config'), content, { mode: 0o600 });
      }
      mounts.push({ hostPath: dest, containerPath: '/home/node/.aws', readonly: true });
    }
  }

  if (isToolEnabled(tools, 'gcloud')) {
    const gcloudKeysDir = path.join(home, '.gcloud-keys');
    if (fs.existsSync(gcloudKeysDir)) {
      const { scopes: gcloudScopes, isScoped: gcloudScoped } = extractToolScopes(tools, 'gcloud');
      const dest = stageDir('gcloud-keys');

      if (gcloudScoped) {
        // GCLOUD_KEY_<SCOPE>=<filename.json> in the host env maps scope → key file.
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

  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return protectReadonlyHostPaths(mounts, readWorkgroupReadonlyPaths());
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
 * The workgroup kernel-lock inode, beside (never inside) the memory tree so it cannot affect tree hashes. Created
 * exclusively at 0600; later callers only inspect it via O_NOFOLLOW and never truncate, unlink or rewrite it.
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

/** Symlinks target container paths (/app/skills/<name>), so they dangle on the host by design. */
function syncSkillSymlinks(claudeDir: string, containerConfig: import('./container-config.js').ContainerConfig): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

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
      // A template overlay (src/group-skills.ts) or a stale skill copy shadowing the shared one: nothing tells them
      // apart, so warn rather than skip silently.
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
 * Every worker-def filename ever shipped. SECURITY: prune targets come ONLY from this in-source list, never from
 * `.claude-shared/agents/` (container-writable), or an agent could make the host delete an arbitrary path. When a
 * def is renamed or removed, add its OLD filename here so existing groups get it pruned.
 */
const MANAGED_WORKER_DEFS = [
  'worker-fast.md',
  'worker.md',
  'worker-high.md',
  'worker-codex.md',
  // Retired (renamed to worker-high.md).
  'worker-opus.md',
  // Retired: trunk ships no worker def; this list is the only thing that removes existing copies.
  'worker-frontier.md',
];

// A stale user-scope `worker-high.md` shares its bare in-container name with the orchestrate plugin's live
// `worker-high` shim; pruning it removes any ambiguity about which one a dispatch resolves to.

/**
 * Copy trunk worker defs (container/agents/*.md) into .claude-shared/agents/; managed defs absent from trunk are
 * pruned, operator-added defs are untouched. Trunk ships NO defs, so a missing `container/agents/` must not return
 * early: that would never prune retired copies.
 */
function syncWorkerAgentDefs(claudeDir: string): void {
  const srcDir = path.join(process.cwd(), 'container', 'agents');
  const dstDir = path.join(claudeDir, 'agents');
  fs.mkdirSync(dstDir, { recursive: true });

  let current: Set<string>;
  try {
    current = new Set(fs.readdirSync(srcDir).filter((e) => e.endsWith('.md')));
  } catch (err) {
    // ENOENT only (trunk ships no defs). Any other error is not an answer about trunk, and swallowing it would prune
    // every managed def: rethrow so the caller spawns without touching the group's files.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    current = new Set<string>();
  }
  // Names are compile-time constants, so no traversal is possible even though dstDir is container-writable.
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

/** Written at spawn so identity fields track DB changes (e.g. a rename); writes only when values differ. */
async function ensureRuntimeFields(
  containerConfig: import('./container-config.js').ContainerConfig,
  agentGroup: AgentGroup,
): Promise<void> {
  let dirty = false;
  if (containerConfig.agentGroupId !== agentGroup.id) {
    containerConfig.agentGroupId = agentGroup.id;
    dirty = true;
  }
  if (containerConfig.groupName !== agentGroup.name) {
    containerConfig.groupName = agentGroup.name;
    dirty = true;
  }
  // `assistantName` is NOT synced here: it varies per channel and reaches the runner as NANOCLAW_ASSISTANT_NAME.
  if (dirty) {
    // Through the ONE mutation primitive, which holds the group's file lock across read → mutate → write, so a
    // concurrent writer's field (e.g. `excludePlugins`) is not silently discarded.
    const fresh = await updateContainerConfig(agentGroup.folder, (config) => {
      config.agentGroupId = agentGroup.id;
      config.groupName = agentGroup.name;
    });
    // Pick up fields a writer that got in first may have added; downstream spawn code reads this copy.
    if (fresh.tools !== undefined) containerConfig.tools = fresh.tools;
    if (fresh.mcpServers !== undefined) containerConfig.mcpServers = fresh.mcpServers;
  }
}

/**
 * The agent's user-facing name for this session: an operator override (only detectable when it differs from
 * `agent_group.name`), else the channel's platform bot display name (Slack, then Discord), else the group name.
 */
export async function resolveAssistantName(
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  sessionMessagingGroupId: string | null,
): Promise<string> {
  if (containerConfig.assistantName && containerConfig.assistantName !== agentGroup.name) {
    return containerConfig.assistantName;
  }

  if (sessionMessagingGroupId) {
    const { getMessagingGroup } = await import('./db/messaging-groups.js');
    const mg = await getMessagingGroup(sessionMessagingGroupId);
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

  return [...new Set(requested)];
}

const DOCKER_ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCKER_ENV_FILE = /^\.docker-env-[a-f0-9]{64}-\d+-[0-9a-f-]{36}$/;

export interface DockerEnvironmentMaterialization {
  /** Docker args with every value-bearing -e/--env argument replaced by one --env-file pathname. */
  args: string[];
  /** Host-private file that must be removed once the Docker CLI process exits. */
  file: string | null;
}

/**
 * Move every Docker env assignment into a 0600 `--env-file`, so a host process listing never sees credential
 * values. Order is preserved (Docker's duplicate-key last-wins behavior).
 */
export function materializeDockerEnvironment(
  args: readonly string[],
  directory: string,
  sessionScope: string,
): DockerEnvironmentMaterialization {
  const environment: string[] = [];
  const sanitized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument !== '-e' && argument !== '--env') {
      sanitized.push(argument);
      continue;
    }
    const assignment = args[++index];
    if (assignment === undefined) throw new Error(`Docker ${argument} is missing its environment assignment`);
    const separator = assignment.indexOf('=');
    const key = separator < 0 ? assignment : assignment.slice(0, separator);
    const value = separator < 0 ? '' : assignment.slice(separator + 1);
    if (!DOCKER_ENV_KEY.test(key) || /[\r\n]/.test(value)) {
      throw new Error(`Unsafe Docker environment assignment for ${key || 'unknown key'}`);
    }
    environment.push(`${key}=${value}`);
  }
  if (environment.length === 0) return { args: sanitized, file: null };
  if (sanitized[0] !== 'run') throw new Error('Docker environment materialization requires a docker run command');

  assertRealDirectory(directory);
  // `.context` is shared by the group's sessions: scope stale cleanup to this session so a concurrent spawn's env
  // file is never unlinked.
  const scope = createHash('sha256').update(sessionScope).digest('hex');
  const filenamePrefix = `.docker-env-${scope}-`;
  // A host can die between creating the file and unlinking it: remove only this session's leaf names (unlink never
  // follows a symlink); the per-session run claim prevents two live spawns sharing the scope.
  for (const entry of fs.readdirSync(directory)) {
    if (DOCKER_ENV_FILE.test(entry) && entry.startsWith(filenamePrefix)) fs.unlinkSync(path.join(directory, entry));
  }
  const filename = `${filenamePrefix}${process.pid}-${randomUUID()}`;
  const file = path.join(directory, filename);
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${environment.join('\n')}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
        // eslint-disable-next-line no-catch-all/no-catch-all -- retain the original write failure
      } catch {
        // The descriptor may have been closed by the operation that failed.
      }
    }
    removeDockerEnvironmentFile(file);
    throw error;
  }
  sanitized.splice(1, 0, '--env-file', file);
  return { args: sanitized, file };
}

/** Best-effort cleanup for a file this process created under the host-only session-context directory. */
export function removeDockerEnvironmentFile(file: string | null): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
    // eslint-disable-next-line no-catch-all/no-catch-all -- cleanup must not mask container finalization
  } catch {
    // The next host-directory provenance sweep will surface an unexpected entry.
  }
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  /** Stamped as the `nanoclaw-session` label so boot inventory can map a survivor back to its session. */
  sessionId: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  channelDefaults?: {
    channelDefaultModel: string | null;
    channelDefaultEffort: string | null;
    channelDefaultTone: string | null;
    channelInstructionsProfile?: string | null;
  },
  sessionMessagingGroupId?: string | null,
  resolvedWgId?: string,
  /**
   * A spawn-time fallback was applied; the override bridge is needed even when the target equals the file's
   * provider.
   */
  providerFallbackApplied?: boolean,
  /** Surfaced as NANOCLAW_THREAD_ID; null for channel-level sessions. */
  sessionThreadId?: string | null,
  repositoryWorkUnit?: RepositoryWorkUnit,
  /**
   * What the Slack owner-safety gate judges (a task session's delivery destination). Kept SEPARATE from
   * `sessionMessagingGroupId`: a task session is not "in" that channel for naming, peers or routing.
   */
  slackSafetyMessagingGroupId?: string | null,
  /** Non-secret mailbox runner config; merged first so nothing below can be shadowed by it. */
  mailboxEnvironment?: Record<string, string>,
): Promise<string[]> {
  const wikiActor = wikiEnrollment(agentGroup.id, containerConfig.wikiMaintenance === true);
  if (wikiActor) {
    assertWikiEgressAllowed(EGRESS_LOCKDOWN);
    assertWikiActorConfig(containerConfig, wikiActor, resolvedWgId ?? '');
    if (
      providerFallbackApplied ||
      provider !== (containerConfig.provider ?? 'claude') ||
      Object.keys(mailboxEnvironment ?? {}).length
    ) {
      throw new Error('Wiki runtime override refused');
    }
    const contribution = wikiProviderContribution(providerContribution, sessionDir(agentGroup.id, sessionId), provider);
    const auth: Record<string, string> = { ...contribution.env };
    if (provider === 'claude') {
      if (process.env.ANTHROPIC_BASE_URL) throw new Error('Wiki runtime requires direct model authentication');
      const resolved = resolveAnthropicAuth(
        agentGroup.folder,
        process.env,
        readEnvFileMatching(/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(_|$)/),
      );
      Object.assign(auth, wikiModelAuth(resolved));
    }
    const env = wikiRuntimeEnvironment(
      provider,
      containerConfig.model,
      containerConfig.effort,
      auth,
      wikiActor.policy.workgroupId,
    );
    env.TZ = effectiveTimezone(containerConfig.timezone);
    const args = [
      'run',
      '--rm',
      '--init',
      '--name',
      containerName,
      ...containerLabelArgs(agentGroup.id, sessionId, resolvedWgId),
      ...dockerResourceLimitArgs(containerConfig.resources),
      ...securityArgs(),
      '--user',
      `${process.getuid?.() || 1001}:${process.getgid?.() || 1001}`,
    ];
    for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
    if (provider === 'claude') args.push(...claudeSpawnEnv(containerConfig));
    args.push(...codexFamilyAliasEnv());
    for (const mount of mounts) {
      if (fs.realpathSync(mount.hostPath) !== mount.hostPath) throw new Error('Wiki runtime mount changed');
      args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`);
    }
    args.push('--entrypoint', 'bash', CONTAINER_IMAGE, '-c', 'exec /app/entrypoint.sh');
    return args;
  }
  // --init: tini as PID 1 reaps orphaned children (bun does not) and still forwards signals.
  const args: string[] = [
    'run',
    '--rm',
    '--init',
    '--name',
    containerName,
    ...containerLabelArgs(agentGroup.id, sessionId, resolvedWgId),
  ];
  args.push(...dockerResourceLimitArgs(containerConfig.resources));
  args.push(...securityArgs(containerConfig.security));

  // Only vars read by code we don't own; NanoClaw-specific config lives in container.json.
  for (const [key, value] of Object.entries(mailboxEnvironment ?? {})) args.push('-e', `${key}=${value}`);
  // `effectiveTimezone` is the same predicate host scheduling uses, so container `TZ` and the host grid agree;
  // anything unconfirmed falls back to the install timezone, never UTC.
  args.push('-e', `TZ=${effectiveTimezone(containerConfig.timezone)}`);

  // Duplicated from settings.json so it holds regardless of the SDK's settings-loading order.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=1');
  // Allow long foreground worker-codex calls without lengthening the default
  // timeout for ordinary Bash calls.
  args.push('-e', 'BASH_MAX_TIMEOUT_MS=3600000');
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW and the subagent caps come from claudeSpawnEnv so the early-returning wiki
  // branch gets the same values.

  // Model precedence: per-session chat flag (runner-side), per-channel wiring, container.json `model`/`effort` then
  // `defaultModel`/`defaultEffort`, then the flag-parser DEFAULT_* constants. Channel defaults are
  // provider-specific: never applied during a provider fallback (the fallback bridge below carries its model).
  const activeChannelModel = providerFallbackApplied ? null : channelDefaults?.channelDefaultModel;
  const activeChannelEffort = providerFallbackApplied ? null : channelDefaults?.channelDefaultEffort;

  args.push(...codexFamilyAliasEnv());
  if (provider === 'codex') {
    // Overlaid onto the Codex providerConfig by the runner, so a per-channel pin beats container.json without
    // mutating the mounted file.
    const codexModel = activeChannelModel ?? containerConfig.model ?? containerConfig.defaultModel;
    const codexEffort = activeChannelEffort ?? containerConfig.effort ?? containerConfig.defaultEffort;
    if (codexModel) args.push('-e', `NANOCLAW_CODEX_MODEL_OVERRIDE=${codexModel}`);
    if (codexEffort) args.push('-e', `NANOCLAW_CODEX_EFFORT_OVERRIDE=${codexEffort}`);
  } else {
    // claudeSpawnEnv resolves family and short aliases and adds the Opus 1M suffix (a bare `claude-opus-*` would
    // collapse the auto-compact window to 200k). The chat ack uses the same function. NANOCLAW_EFFORT_OVERRIDE is
    // emitted only when configured; absent means the per-model-family default.
    args.push(
      ...claudeSpawnEnv(containerConfig, { model: activeChannelModel, effort: activeChannelEffort }, (message) =>
        log.warn('Claude spawn default refused', {
          sessionId,
          agentGroup: agentGroup.name,
          detail: message,
        }),
      ),
    );
  }

  // container.json is not rewritten per spawn, so a fallback travels as env. The explicit marker is required even
  // when the target equals the file's provider.
  if (providerFallbackApplied && containerConfig.provider) {
    for (const [key, value] of Object.entries(
      providerFallbackRuntimeEnv({ provider: containerConfig.provider, model: containerConfig.model }),
    )) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Spawn-only capability: old containers retain their existing explicit-human reply path.
  if (effectiveOutcomeReporting(containerConfig)) args.push('-e', 'NANOCLAW_OUTCOME_REPORTING=1');
  // Spawn-only too: an adopted container keeps the tool list it started with; the
  // host delivery gate (TASK_LIST_ENABLED) is what reaches it.
  if (TASK_LIST_ENABLED) args.push('-e', 'NANOCLAW_TASK_LIST=1');

  // Tone: per-channel wiring, then container.json `tone`, else unset (the agent selects on demand).
  const defaultTone = channelDefaults?.channelDefaultTone ?? containerConfig.tone ?? null;
  if (defaultTone) {
    args.push('-e', `NANOCLAW_DEFAULT_TONE=${defaultTone}`);
  }

  // Per-wiring or nothing, on purpose: the group-wide equivalent is standing-instructions.md, already in every prompt.
  const instructionsProfile = channelDefaults?.channelInstructionsProfile ?? null;
  if (instructionsProfile) {
    args.push('-e', `NANOCLAW_INSTRUCTIONS_PROFILE=${instructionsProfile}`);
  }

  const resolvedAssistantName = await resolveAssistantName(
    agentGroup,
    containerConfig,
    sessionMessagingGroupId ?? null,
  );
  args.push('-e', `NANOCLAW_ASSISTANT_NAME=${resolvedAssistantName}`);
  if (sessionThreadId) args.push('-e', `NANOCLAW_THREAD_ID=${sessionThreadId}`);
  // Forwarded CLAMPED and unconditionally: .env-only values never reach `process.env` here (config.ts import-order
  // trap), and dropping the override lets tasks be killed at the container default.
  args.push('-e', `NANOCLAW_TASK_SCRIPT_TIMEOUT_MS=${TASK_SCRIPT_TIMEOUT_MS}`);
  // Forces the snapshot path: the agent's writable clone used for re-audits has no `upstream` remote either.
  args.push('-e', `NANOCLAW_UPSTREAM_POLICY=/workspace/project/.upstream-policy.json`);
  if (repositoryWorkUnit) {
    args.push('-e', `NANOCLAW_HOST_DATA_DIR=${DATA_DIR}`);
    args.push('-e', `NANOCLAW_HOST_TOPIC_WORKTREES_DIR=${topicWorktreesDir(repositoryWorkUnit)}`);
    args.push('-e', `NANOCLAW_WORK_UNIT_KEY=${repositoryWorkUnit.key}`);
    args.push('-e', `${CHECKOUT_MODE_ENV}=${effectiveCheckoutMode()}`);
  }

  // Fail-soft: the workgroup line is a best-effort prompt addendum, and schemas without the workgroup_id column
  // throw `no such column`.
  try {
    const wgId =
      resolvedWgId ??
      (await withCentralSync(
        () =>
          withRawDb(
            (db) =>
              (
                db.prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(agentGroup.id) as
                  | { workgroup_id: string | null }
                  | undefined
              )?.workgroup_id,
          ),
        'workgroup id for container env',
      ));
    if (wgId) {
      args.push('-e', `NANOCLAW_WORKGROUP_ID=${wgId}`);
    }
  } catch {
    // Old schema: omit the env var; the runner treats absence as "no workgroup".
  }

  // NANOCLAW_PEERS: every agent group on the same platform channel with its bot user_id, so the model has an
  // explicit self and peer name→`<@uid>` mapping. getChannelPeers matches on platform_id, so sibling adapters
  // (one messaging group per bot) are included. Absent means no peers.
  if (sessionMessagingGroupId) {
    const { getChannelPeers, getMessagingGroup } = await import('./db/messaging-groups.js');
    const { getSlackBotDisplayName, getKnownSlackBots } = await import('./channels/slack-mentions.js');
    const { getDiscordBotDisplayName, getKnownDiscordBots } = await import('./channels/discord.js');
    const peers = await getChannelPeers(sessionMessagingGroupId, agentGroup.id);
    const slackBots = getKnownSlackBots();
    const discordBots = getKnownDiscordBots();
    const peerEntries = peers.map((p) => {
      // channel_type is the disjoint key between the Slack and Discord registries.
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
    // The channel-facing display name is deliberately distinct from assistantName; supplying both keeps the model
    // from treating its own platform mention as a request for a sibling.
    const selfMg = await getMessagingGroup(sessionMessagingGroupId);
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

  // SDK capabilities that need explicit opt-in (settings.json env block equivalents).
  args.push('-e', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1');
  args.push('-e', 'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1');
  args.push('-e', 'ENABLE_TOOL_SEARCH=true');

  // Derived from the mounts buildMounts actually kept, in declaration order.
  const codexFallbackPaths = mounts
    .filter((m) => /^\/home\/node\/\.codex-fallback-\d+$/.test(m.containerPath))
    .map((m) => m.containerPath);
  if (codexFallbackPaths.length > 0) {
    args.push('-e', `CODEX_FALLBACK_HOMES=${codexFallbackPaths.join(':')}`);
  }

  if (mounts.some((m) => m.containerPath === CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH)) {
    args.push('-e', `CODEX_PRIMARY_HOST_HOME=${CODEX_PRIMARY_HOST_HOME_CONTAINER_PATH}`);
  }

  // `credentialFolder` lets siblings inherit the source group's scoped credentials (env vars, OAuth, Codex dir).
  //
  // Identity-bound concerns (container name, group dir mount, log fields) stay on `agentGroup.folder`.
  const credentialFolder = containerConfig.credentialFolder ?? agentGroup.folder;

  // Null for every group without a key file; drives the ADC env vars and the googleapis.com proxy bypass.
  const gcpKey = resolveGcpServiceAccountKey(credentialFolder);

  // Reads `.env` fresh at spawn so per-group token edits apply on respawn without a host restart (see
  // resolveScopedRotationSet).
  const auth = resolveAnthropicAuth(
    credentialFolder,
    process.env,
    readEnvFileMatching(/^(CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY)(_|$)/),
  );

  // Custom-upstream auth (ANTHROPIC_BASE_URL + key) is forwarded in the OneCLI gateway block below, after the
  // gateway applies, so its host can join NO_PROXY and the forwarded key is authoritative.

  // OAuth primary + `_N` fallbacks are forwarded so the provider can rotate accounts on retryable errors, and
  // api.anthropic.com joins NO_PROXY: the OneCLI proxy would overwrite the OAuth header with its single vault
  // entry, defeating rotation.
  const hostOauth = auth.oauthPrimary;
  const oauthBypassAnthropic = Boolean(hostOauth);
  if (hostOauth) {
    args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
    for (const fb of auth.oauthFallbacks) {
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}=${fb.value}`);
    }
    // Scoped and global tokens share the unscoped `_N` names; this says which set the slots came from.
    const oauthCredentialSet = auth.oauthScoped ? `group:${credentialFolder}` : 'global';
    args.push('-e', `NANOCLAW_OAUTH_CREDENTIAL_SET=${oauthCredentialSet}`);
    // Must be forwarded explicitly: there is no generic env passthrough, and without it `lane` stays NULL silently.
    const oauthLanes = process.env.CLAUDE_CODE_OAUTH_LANES;
    if (oauthLanes) args.push('-e', `CLAUDE_CODE_OAUTH_LANES=${oauthLanes}`);
    // `user:inference` only, all a setup-token credential holds. Do NOT add `user:profile`: the CLI would call
    // profile endpoints that 403 and then 429 for these tokens. Declared because unset makes the CLI treat an env
    // token as profile-capable.
    args.push('-e', 'CLAUDE_CODE_OAUTH_SCOPES=user:inference');
  }

  // OneCLI's proxy model doesn't fit git auth, so the real token is passed.
  const ghToken = await resolveGitHubTokenForContainer(credentialFolder, containerConfig);
  if (ghToken) {
    // BY REFERENCE by default: only the PATH of a read-only per-group file reaches the container spec, so no
    // credential is in `docker inspect` or argv, and the host sweep rewrites it in place so a long-lived container
    // picks up the ~1h App token re-mint. `GITHUB_TOKEN_IN_ENV=1` restores value-forwarding.
    const ghPlan = planGitHubTokenSpawn({ agentGroupId: agentGroup.id, token: ghToken });
    if (ghPlan.mount) {
      mounts.push(ghPlan.mount);
      // Registered per spawn so the sweep re-resolves with this group's own lookup order.
      registerGroupTokenRefresher(agentGroup.id, () =>
        resolveGitHubTokenForContainer(credentialFolder, containerConfig),
      );
    }
    args.push(...ghPlan.envArgs);
    // Optional per-group org allowlist: entrypoint.sh restricts git's credential helper to these orgs only; the gh
    // wrapper and direct reads of the mounted token keep its full reach.
    const ghOrgs = resolveScopedEnv('GITHUB_ALLOWED_ORGS', credentialFolder);
    if (ghOrgs) args.push('-e', `GITHUB_ALLOWED_ORGS=${ghOrgs}`);
  } else {
    log.warn('No GitHub token resolved for agent group — git push/PR will fail', {
      folder: agentGroup.folder,
    });
  }

  args.push('-e', 'CLAUDE_PLUGINS_ROOT=/workspace/plugins');
  // The vendored skill honours $DESIGN_ARTIFACT_LOOP_ROOT; the design_review tool accepts only this same path.
  args.push('-e', 'DESIGN_ARTIFACT_LOOP_ROOT=/workspace/agent/design-artifact-loop');

  // An explicit agent Git identity wins only for Git's four attribution variables.
  for (const [base, v] of Object.entries(resolveScopedCredentialEnv(containerConfig, credentialFolder))) {
    if (v) args.push('-e', `${base}=${v}`);
  }

  // Raw connection strings (e.g. RENDER_PG_URL_<FOLDER>_MAIN) passed through verbatim. SECURITY: the tail must
  // START with the folder token followed by `_` or end-of-string; a substring match let one folder inherit
  // another folder's vars.
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

  // ADC env and the default project come from the mounted key; set regardless of gateway state (ADC needs no proxy).
  if (gcpKey) {
    args.push('-e', `GOOGLE_APPLICATION_CREDENTIALS=${GCP_KEY_CONTAINER_PATH}`);
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

  // Pin pnpm's store to the group mount: unset, pnpm falls back to arbitrary bind-mount boundaries and scatters
  // multi-hundred-MB stores; /workspace/agent is on the same host filesystem as every workspace mount, so
  // hardlinks work. Both env forms for pnpm 10/11; env config outranks any .npmrc.
  args.push('-e', 'npm_config_store_dir=/workspace/agent/.pnpm-store');
  args.push('-e', 'pnpm_config_store_dir=/workspace/agent/.pnpm-store');

  const providerEnv = { ...(providerContribution.env ?? {}) };
  // A channel wiring (or an OpenCode fallback) replaces the OPENCODE_* selectors here rather than relying on
  // duplicate Docker `-e` flags.
  if (provider === 'opencode') {
    const opencodeModel = activeChannelModel ?? (providerFallbackApplied ? containerConfig.model : undefined);
    const opencodeEffort = activeChannelEffort ?? (providerFallbackApplied ? containerConfig.effort : undefined);
    if (opencodeModel) providerEnv.OPENCODE_MODEL = opencodeModel;
    if (opencodeEffort) providerEnv.OPENCODE_EFFORT = opencodeEffort;
  }
  for (const [key, value] of Object.entries(providerEnv)) {
    args.push('-e', `${key}=${value}`);
  }

  // Keyed on the MOUNT: an OpenCode session gets this env from its provider contribution, and a withheld staging
  // must not be pointed at a path it has no mount for.
  if (provider !== 'opencode' && mounts.some((m) => m.containerPath === OPENCODE_XDG_CONTAINER_PATH)) {
    for (const [key, value] of Object.entries(OPENCODE_XDG_ENV)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // OneCLI gateway for EVERY container. ensureAgent must run first, or applyContainerConfig rejects the unknown
  // identifier. Gateway failure throws: the inbound message stays pending and the sweep retries (a container with
  // no credentials would only mask the misconfiguration).
  {
    // Defaults to the per-group identity; reassigned to `<group>-noslack` below for non-owner-safe sessions.
    let effectiveIdentifier = agentIdentifier;
    if (agentIdentifier) {
      // Workgroup secrets are the baseline and per-group onecliSecrets extend them (never subtract). Fail-closed;
      // a no-op when the merged list is empty.
      const workgroupSecrets = resolvedWgId
        ? await getWorkgroupOnecliSecretsById(resolvedWgId)
        : await getWorkgroupOnecliSecrets(agentGroup.id);
      const mergedSecrets = mergeWorkgroupAndGroupSecrets(workgroupSecrets, containerConfig.onecliSecrets);

      // The Slack user token is the whole Slack boundary (Slack access is `curl slack.com/api/*` through the
      // proxy). Identities are per-GROUP, so non-owner-safe sessions spawn under a second identity `<group>-noslack`
      // whose secret set excludes the token, and Slack calls fail closed. `-noslack` because OneCLI identifiers
      // allow only lowercase letters, digits and hyphens.
      const slackSecrets = slackUserTokenSecrets(mergedSecrets, containerConfig.slack_user_token?.onecli_secret_names);
      let identity = agentIdentifier;
      let effectiveSecrets = mergedSecrets;
      if (slackSecrets.length > 0) {
        const { isOwnerSafeSlackSession } = await import('./modules/permissions/slack-user-token-gate.js');
        const ownerSafe = await withCentralSync(
          () =>
            withRawDb((db) =>
              isOwnerSafeSlackSession(
                db,
                agentGroup.id,
                slackSafetyMessagingGroupId ?? null,
                containerConfig.slack_user_token?.also_allowed_in,
              ),
            ),
          'slack owner-safe check',
        );
        if (!ownerSafe) {
          identity = `${agentIdentifier}-noslack`;
          effectiveSecrets = mergedSecrets.filter((s) => !slackSecrets.includes(s));
          log.info('Slack user-token secret withheld for non-owner-safe session', {
            folder: agentGroup.folder,
            sessionMessagingGroupId: sessionMessagingGroupId ?? null,
            slackSafetyMessagingGroupId: slackSafetyMessagingGroupId ?? null,
            withheld: slackSecrets,
            identity,
          });
        }
      }

      // Awaited: synchronous control-API calls stall the host event loop for the round trip.
      await ensureOnecliAgent({
        name:
          identity === agentIdentifier ? agentGroup.name : `${agentGroup.name} (no Slack — non-owner-safe sessions)`,
        identifier: identity,
      });
      await applyOnecliSecrets(identity, effectiveSecrets);
      effectiveIdentifier = identity;
      args.push(...typesafeKeyPlaceholderEnv(provider, effectiveSecrets));
    }
    // Retried once for the proved-transient class only (src/onecli-apply.ts); a deterministic 4xx throws.
    const applyResult = await applyOnecliContainerConfig(
      args,
      { addHostMapping: false, agent: effectiveIdentifier },
      { applyContainerConfig: (a, o) => onecli.applyContainerConfig(a, o) },
    );
    if (!applyResult.applied) {
      throw new Error(
        `OneCLI gateway not applied — refusing to spawn container without credentials (${describeDiagnosis(
          applyResult.diagnosis,
        )})`,
      );
    }
    log.info('OneCLI gateway applied', {
      containerName,
      agent: effectiveIdentifier ?? null,
      attempts: applyResult.attempts,
      durationsMs: applyResult.durationsMs,
    });

    // Point tools that check their own CA var at the combined bundle so they trust OneCLI's MITM CA.
    args.push('-e', 'REQUESTS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'PIP_CERT=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'CURL_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'AWS_CA_BUNDLE=/tmp/onecli-combined-ca.pem');
    args.push('-e', 'GIT_SSL_CAINFO=/tmp/onecli-combined-ca.pem');

    // NO_PROXY bypasses for hosts where OneCLI's MITM breaks the client or hijacks its auth. OneCLI re-signs every
    // CONNECT even with no injection, so clients with a bundled CA (snowflake-connector, boto3/STS) reject it.
    if (isToolEnabled(containerConfig.tools, 'snowflake') || isToolEnabled(containerConfig.tools, 'dbt')) {
      mergeNoProxy(args, 'snowflakecomputing.com');
    }
    if (isToolEnabled(containerConfig.tools, 'aws')) {
      mergeNoProxy(args, 'amazonaws.com');
    }
    // git sends Basic auth; OneCLI treats github.com as a known provider and replaces the header with its
    // connected-app credential (401 for agents without a vault link).
    if (ghToken) {
      mergeNoProxy(args, 'github.com');
    }
    // The SA key is self-authenticating and gcloud/google-auth trust only their bundled roots; one `googleapis.com`
    // entry suffix-matches every Google API host.
    if (gcpKey) {
      mergeNoProxy(args, 'googleapis.com');
    }
    // Codex streams over WebSocket to chatgpt.com, and OneCLI's MITM returns 405 for WS Upgrade (a retry storm that
    // can make codex report loggedIn:false). Unconditional: non-codex agents don't talk to chatgpt.com.
    mergeNoProxy(args, 'chatgpt.com');
    // pip trusts certifi, not OneCLI's CA, so installs (including `install_packages` self-mod) fail without this.
    mergeNoProxy(args, 'pypi.org');
    mergeNoProxy(args, 'pythonhosted.org');

    // The Wix CLI's own OAuth breaks under MITM. Only `wix.com`: the REST API on `www.wixapis.com` stays on the
    // gateway for key injection.
    if (containerConfig.wixHostAuth === true) {
      mergeNoProxy(args, 'wix.com');
    }

    // Skip the proxy for api.anthropic.com so it cannot replace the OAuth header with its single vault credential
    // (defeating rotation), and re-append the real token AFTER OneCLI's `CLAUDE_CODE_OAUTH_TOKEN=placeholder`
    // (Docker `-e`: last wins); under the bypass the placeholder would otherwise reach the API verbatim.
    if (oauthBypassAnthropic) {
      mergeNoProxy(args, 'api.anthropic.com');
      // OneCLI also injects `ANTHROPIC_API_KEY=placeholder`, which the SDK prefers over OAuth: strip only the
      // sentinel, so a real key forwarded by the custom-upstream block below still wins.
      stripEnvEntry(args, 'ANTHROPIC_API_KEY', PLACEHOLDER_SENTINEL);
      stripEnvEntry(args, 'CLAUDE_CODE_OAUTH_TOKEN');
      args.push('-e', `CLAUDE_CODE_OAUTH_TOKEN=${hostOauth}`);
      for (const fb of auth.oauthFallbacks) {
        const key = `CLAUDE_CODE_OAUTH_TOKEN_${fb.index}`;
        stripEnvEntry(args, key);
        args.push('-e', `${key}=${fb.value}`);
      }
    }

    // Custom upstream via ANTHROPIC_BASE_URL: exclude that host from the proxy and authenticate with the forwarded
    // key (+ `_N` rotation). Forwarded here, after the gateway applied, so these are the authoritative values.
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

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  // Single definition, shared with the GitHub token file lane so the two
  // cannot drift — see containerRunsAsHostUser.
  if (containerRunsAsHostUser(hostUid)) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Pre-create nested /workspace mountpoints as the host user: Docker would create missing ones inside the session
  // dir owned by ROOT, which reclaim can then never delete. Best-effort.
  const workspaceHostRoot = mounts.find((m) => m.containerPath === '/workspace')?.hostPath;
  if (workspaceHostRoot) {
    for (const mount of mounts) {
      if (!mount.containerPath.startsWith('/workspace/')) continue;
      const stubPath = path.join(workspaceHostRoot, mount.containerPath.slice('/workspace/'.length));
      try {
        if (fs.existsSync(stubPath)) continue;
        // statSync, not lstatSync: a symlink source (AGENTS.md -> CLAUDE.md) must stub as what it RESOLVES to, or
        // Docker fails the file bind with "not a directory".
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

  for (const mount of mounts) {
    // Overlay sources live under agent-writable trees: re-validate right before emitting the arg so a target
    // swapped after buildMounts aborts the spawn. A residual race with runc's own resolution is accepted: it needs a
    // concurrent same-workgroup process, which already shares the trees these roots allow.
    if (mount.overlayAllowedRoots) {
      let recheck: string;
      try {
        recheck = fs.realpathSync(mount.hostPath);
      } catch (e) {
        throw new Error(`Overlay mount source vanished before spawn: ${mount.hostPath}`, { cause: e });
      }
      const allowed = mount.overlayAllowedRoots.some((root) => recheck === root || recheck.startsWith(root + path.sep));
      if (recheck !== mount.hostPath || !allowed) {
        throw new Error(
          `Overlay mount source changed between validation and spawn (${mount.hostPath} -> ${recheck}); aborting spawn`,
        );
      }
    }
    if (mount.workgroupReadAccess) assertWorkgroupReadAccessMountStable(mount);
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Fleet defaults are merged by `effectiveMcpServers`; add fleet-wide tools to data/fleet-mcp-servers.json, not
  // here. Below are only servers gated on `tools` AND on scoped host credentials resolved in this function.
  const mcpServers: Record<string, unknown> = effectiveMcpServers(containerConfig);
  const mcpExcluded = new Set(containerConfig.excludeMcpServers ?? []);
  const canInject = (name: string): boolean => !mcpExcluded.has(name) && !mcpServers[name];

  if (canInject('linear') && isToolEnabled(containerConfig.tools, 'linear')) {
    // Auth header injected by the OneCLI gateway (vault entry "Linear").
    mcpServers.linear = {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    };
  }
  if (canInject('datafold') && isToolEnabled(containerConfig.tools, 'datafold')) {
    // OneCLI overwrites the placeholder `Authorization: Key` header at the proxy boundary.
    mcpServers.datafold = DATAFOLD_MCP_SERVER;
  }
  if (canInject('atlassian') && isToolEnabled(containerConfig.tools, 'atlassian')) {
    // Direct REST (not Rovo MCP, which needs an org-admin permission grant to expose Jira/Confluence tools).
    // Placeholder credentials satisfy startup validation; OneCLI replaces the Basic header at the proxy boundary.
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
    // Credentials are embedded in the env block because the MCP SDK's stdio transport passes only
    // HOME/LOGNAME/PATH/SHELL/TERM/USER to the child by default.
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
    // Read-only by default: CLI/LSP toolsets and the mutating Admin tools are disabled (override per folder via
    // DBT_MCP_DISABLE_TOOLS_<FOLDER>).
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
      // Every Admin API tool needs DBT_ACCOUNT_ID, or dbt-mcp fails it with an empty error before any HTTP call.
      const accountId = resolveScopedEnv('DBT_CLOUD_ACCOUNT_ID', credentialFolder);
      if (accountId) env.DBT_ACCOUNT_ID = accountId;
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

  const mcpServersEnv = serializeMcpServersEnv(mcpServers, containerConfig.mcpServers ?? {});
  if (mcpServersEnv) {
    args.push('-e', mcpServersEnv);
  }

  // Skip tini's stdin-read wait (no stdin is piped) and run entrypoint.sh via bash so credential and provider
  // setup fire before bun starts.
  args.push('--entrypoint', 'bash');

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec /app/entrypoint.sh');

  return args;
}

/**
 * The install label plus the four scope labels a boot inventory reads. `workgroupId` emits an EMPTY value rather
 * than dropping the label, so "no workgroup" and "predates the labels" stay distinguishable.
 */
export function containerLabelArgs(agentGroupId: string, sessionId: string, workgroupId?: string): string[] {
  return [
    '--label',
    CONTAINER_INSTALL_LABEL,
    '--label',
    `${CONTAINER_GROUP_LABEL_KEY}=${agentGroupId}`,
    '--label',
    `${CONTAINER_SESSION_LABEL_KEY}=${sessionId}`,
    '--label',
    `${CONTAINER_WORKGROUP_LABEL_KEY}=${workgroupId ?? ''}`,
    '--label',
    `${CONTAINER_ROLE_LABEL_KEY}=agent`,
  ];
}

/**
 * Drop every capability and forbid setuid escalation, overridable via container.json `security`. Resource
 * ceilings belong ONLY to `dockerResourceLimitArgs`: a flag emitted by both would give Docker contradictory values.
 */
export function securityArgs(security?: SecurityConfig): string[] {
  const effective = resolveContainerSecurity(security);
  const args: string[] = [];

  if (effective.noNewPrivileges) {
    args.push('--security-opt', 'no-new-privileges:true');
  }
  for (const cap of effective.capDrop) args.push('--cap-drop', cap);
  for (const cap of effective.capAdd) args.push('--cap-add', cap);

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
  if (effective.cpuShares !== undefined) args.push('--cpu-shares', String(effective.cpuShares));
  args.push('--pids-limit', String(effective.pidsLimit));
  return args;
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = await getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = await getContainerConfig(agentGroup.id);
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
    // pnpm skips build scripts unless allowlisted: write both the legacy .npmrc keys (pnpm 10) and the allowBuilds
    // map (pnpm 11). Every entry passed strict npm-name validation before admin approval.
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

  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes).
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  await writeContainerConfigScalars(agentGroup.id, agentGroup.folder, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
