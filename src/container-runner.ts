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
  TASK_SCRIPT_TIMEOUT_MS,
  WORKGROUP_SHARED_FS,
} from './config.js';
import {
  CONTAINER_PLUGINS_DIR,
  effectiveTimezone,
  readContainerConfig,
  readContainerConfigForSpawn,
  validateMcpServers,
  writeContainerConfig,
  resolveContainerSecurity,
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
import { resolveSpawnProvider } from './provider-fallback.js';
import { markProviderAvailable } from './db/provider-health.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
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
// Owns the claude branch's model/effort resolution AND the `-e` strings it
// emits, so both are reachable from a unit test — buildContainerArgs is not.
import { claudeSpawnEnv } from './claude-spawn-defaults.js';
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
} from './onecli-secrets.js';
import {
  reconcileWorkgroupMemory,
  workgroupMemoryDir,
  workgroupSharedDir,
  WORKGROUP_CONTAINER_PATH,
  WORKGROUP_MEMORY_CONTAINER_PATH,
} from './modules/workgroup/shared-dirs.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
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

/** Docker environment for an agent's explicit Git identity. */
export function gitIdentityEnv(identity?: GitIdentity): Record<string, string> {
  if (!identity) return {};
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
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

/**
 * How a tracked container's terminal is observed (plan §4.3.3).
 *
 * `spawned` is today's shape: the `docker run --rm` client is a child of this
 * process and its `close` IS the container's exit. `adopted` is a container a
 * previous host process started and this one took over at boot: there is no
 * client child, so one `docker wait <name>` observer per container supplies the
 * same `close`-is-terminal signal — with one difference the union exists to
 * make explicit. A waiter's `close` is only a HINT: a docker-daemon restart
 * exits every waiter at once, so the close is checked against the runtime
 * (`runtimeShowsRunning`) before it finalizes, and re-armed when the container
 * is still there. `waiter` is therefore mutable: a re-arm swaps a fresh child
 * into the SAME channel object, which is what the registry's identity fence
 * compares. `terminal` fires exactly once, when the container is proven gone,
 * so exit callbacks ride it rather than the raw waiter and a re-arm cannot
 * fire them spuriously.
 */
export type SupervisionChannel =
  | { kind: 'spawned'; process: ChildProcess }
  | { kind: 'adopted'; waiter: ChildProcess; terminal: EventEmitter; settled: boolean };

/** One tracked container. */
interface ActiveContainerEntry {
  channel: SupervisionChannel;
  containerName: string;
  /**
   * When this host started observing the container. For a spawned entry that
   * is the spawn; for an adopted one it is the adoption instant — this host has
   * no spawn time for a container a previous host started, and 0 would exempt
   * every adopted session from the idle ceiling.
   */
  spawnedAt: number;
  adopted: boolean;
  /** null for an adopted entry: this host holds no lease for a container it did not spawn. */
  storageActivity: StorageActivityLease | null;
  /** Incarnation this process claimed in `session_claims` for this runtime. */
  claimIncarnation?: number;
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, ActiveContainerEntry>();

/**
 * Run `callback` once at the container's terminal. For a spawned entry that is
 * the client's `close`; for an adopted one it is the channel's `terminal`, which
 * `finalizeSession` fires only after the runtime confirmed the container is
 * gone — never a bare waiter exit, which a daemon restart produces for free.
 */
function channelOnClose(channel: SupervisionChannel, callback: () => void): void {
  if (channel.kind === 'spawned') channel.process.once('close', callback);
  else channel.terminal.once('close', callback);
}

/** Has the channel already delivered its terminal? */
function channelHasExited(channel: SupervisionChannel): boolean {
  return channel.kind === 'spawned' ? channel.process.exitCode !== null : channel.settled;
}

/**
 * The hard-kill fallback when `stopContainer` itself failed. Channel-aware
 * because a naive union is silently wrong here: SIGKILL on a spawned entry's
 * client stops its container, but SIGKILL on an adopted entry's WAITER would
 * abandon the container, so the adopted fallback targets the container by name
 * and only then the waiter — whose exit merely triggers the truth re-read.
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
 * Sessions this process has promised to bring back, each holding the TOKEN of
 * the promise — the in-memory shadow of the `respawn_after_stop` rows this host
 * wrote itself.
 *
 * The token is what makes the discharge safe against an in-flight wake. A wake
 * reads the session's token when it STARTS, and may only discharge a promise
 * whose token it read: a wake already running when the kill arrived read
 * `undefined` (or the previous promise's token) and so cannot clear the promise
 * the kill just made, even though it can still resolve `true` for a container
 * this kill is about to stop. Without that, the original wake's `true` cleared
 * the row while the replacement wake merely JOINED it, and the session went
 * down with nothing left for the next boot to recover.
 *
 * The map also keeps the discharge free for every wake that owes nothing:
 * without it `clearRespawnIntentOnWake` would put a central-DB write in front
 * of every ordinary message-driven spawn. Empty at boot by construction, which
 * is right — a promise made by a PREVIOUS host is owed to
 * `honorPendingStopIntents`, not to this map.
 */
const respawnIntents = new Map<string, number>();

/** Monotonic source of the promise tokens above; never reused within a process. */
let respawnIntentSeq = 0;

/** Test-only: drop this process's record of outstanding respawn promises. */
export function _resetStopIntentStateForTesting(): void {
  respawnIntents.clear();
}

/**
 * Test-only: the promise token a wake starting NOW would read, or undefined
 * when this host owes the session nothing.
 */
export function _respawnIntentTokenForTesting(sessionId: string): number | undefined {
  return respawnIntents.get(sessionId);
}

/**
 * The claimant id for `session_claims`, or null when this process has none.
 *
 * It is the host's durable lease instance id and nothing else. There is NO
 * `hostname:pid` fallback — plan §7.A′ point 2 proposed one and it is dropped
 * deliberately: a claim is only worth taking if a peer can answer it against
 * `host_instances` liveness, and an id that was never registered there always
 * reads as dead. A host running under a fallback id would therefore have every
 * one of its claims taken over by any overlapping host, which is the duplicate
 * container the claim exists to prevent. Refusing to claim is the safe half of
 * that trade, and it costs a single-host install nothing: a central DB that
 * cannot take the one-row lease INSERT could not take the claim row either.
 *
 * Fork-forward on upstream: upstream `6b0411c47` shipped the hostname:pid form
 * and its own later commit `692a0b603` ("claims answer to the host-instance
 * lease") replaced it with the lease id. The fork takes the end state directly,
 * so the claimant vocabulary never has to be migrated.
 *
 * The lease start in `main()` is fail-open by design (`shadowWrite`, #421), so
 * a host whose registration failed at boot reaches here with no id. One late
 * start is attempted from the spawn path — the DB may well be healthy again by
 * then — and it is also `shadowWrite`-wrapped, because a failed retry must
 * refuse this one spawn, not throw out of the wake path.
 *
 * That "one" is a real once, not one per caller: `lateLeaseStart` holds the
 * single in-flight attempt so two sessions waking in the same tick share it.
 * Without it both would see a null id, both would enter the starter, and the
 * host would end up with two registered instance ids and two renewal timers
 * while `host-instance.ts` keeps only the last — the earlier row then expires
 * unrenewed, and any claim taken under it reads as dead to every peer. The
 * slot is cleared when the attempt settles, so a failure is retried by the
 * next wake rather than latched for the life of the process.
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
 * Is THIS host's own lease still live, and can it be made live if not?
 *
 * `getHostInstanceId()` answers from process memory and keeps answering after
 * the renewal timer has been failing for longer than the TTL — upstream's
 * renew path only warns (src/host-instance.ts). Claiming under an expired
 * lease is the mirror image of the peer check below: our row reads as dead to
 * everyone else, so a peer takes the session over and spawns a duplicate while
 * our container is still running.
 *
 * So the lease is validated as a durable fact, not a remembered one, and one
 * inline renewal is attempted before giving up — a lapse is usually a
 * transient DB blip, and re-arming here is cheaper than refusing every spawn
 * until the 30 s timer next fires. The renewal is awaited and its failure
 * swallowed: it is shadow state, and a spawn refusal is the answer either way.
 *
 * Scope: this is the self-fence for the SPAWN path only. Containers that are
 * already running when the lease lapses are not touched — fencing those is
 * adoption's problem (series E/F), which is where a host learns what it is
 * still supervising.
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
 * Claim a session this process is about to run. The `session_claims` row is the
 * authority for which process/incarnation owns a session: losing the
 * compare-and-set means another live claimant got there first, and the caller
 * must not start a container for it. Returns the claimed incarnation, or null
 * when the claim was lost. Throws on a failed write — a claim that cannot be
 * recorded is a claim not held.
 *
 * A claim held by a LIVE peer host (a `host_instances` row that is not stopped
 * and whose lease is unexpired) is refused outright — two live hosts must never
 * trade a session back and forth. A claim whose holder is stopped,
 * lease-expired, or unknown (older claimant-id schemes) stays takeover-able: a
 * crashed claimant must never wedge a session. A claim this same process
 * already holds is takeover-able too, which is what lets a respawn win.
 *
 * A process with no durable instance id claims nothing at all — see
 * `resolveClaimantId` — so a spawn is refused rather than fenced by an id no
 * peer can answer, and a process whose OWN lease has lapsed is refused too
 * (`selfLeaseIsLive`): a claim every peer reads as dead is not a claim.
 *
 * Both of those reads, the peer read and the container read below all happen
 * inside this function and therefore inside the single `await` the spawn path
 * makes for the claim. The ordering argument is unchanged: the claim is still
 * the last `await` before `spawn()`, and the guard point stays adjacent to it.
 *
 * Two fences, in order (plan §4.3.4):
 *
 * P2 — the container half. An UNTRACKED container is still running for this
 * session: a survivor of the previous host that this one has not adopted.
 * Fence on the container, not the incarnation — a crashed host's claim is
 * deliberately takeover-able, so the incarnation cannot tell "nobody runs this
 * session" from "a survivor runs it". Steady state never pays: a clean exit
 * nulls `container_ref`, and a session this host tracks short-circuits on the
 * registry long before here. Fails CLOSED — "cannot prove absence" never reads
 * as "absent". The adopter holds the survivor by definition and skips it. A
 * runtime call, so it sits OUTSIDE the transaction below.
 *
 * P1 — the peer half, and the incarnation CAS, as ONE atomic step (#439, item
 * 1). The holder's liveness verdict and the conditional UPDATE were two
 * statements, and a peer whose lease had expired but renewed in between was
 * overwritten while its container kept running. `centralTransaction` opens
 * `BEGIN IMMEDIATE` under the fork's central lease, so the peer's renewal
 * waits behind the read → verdict → CAS instead of landing inside it. The
 * closure is DB calls only, sequential, with no other effect (plan §4.4).
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
  // No id means no claim was ever taken under one (`claimSessionRun` refuses
  // without it), so there is nothing this process could scope a release to.
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

/** Was this session's container adopted at boot rather than spawned by this host? */
export function isAdoptedContainer(sessionId: string): boolean {
  return activeContainers.get(sessionId)?.adopted ?? false;
}

/** Sessions whose tracked container this host adopted rather than spawned. */
export function getAdoptedSessionIds(): string[] {
  return [...activeContainers.entries()].filter(([, entry]) => entry.adopted).map(([sessionId]) => sessionId);
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

/**
 * Kill requests made against a session whose container does not exist YET.
 *
 * `killContainer` used to return silently for these. That is not a no-op from
 * the caller's side: `containerOwnsOutbound` is deliberately true for a
 * SPAWNING session — a wake issued a moment ago is about to hold the file — so
 * every caller that asks "is anyone there?" before killing gets `true`, calls
 * `killContainer`, and gets nothing. The container then comes up and keeps
 * running, and the caller's `onExit` work never runs: a confirmed thread close
 * leaves the fresh container alive, a self-mod rebuild leaves the old image
 * running, a provider self-heal never respawns on the fallback.
 *
 * A request recorded here is honoured at the last point before `docker run`
 * (the spawn is cancelled) or, if the process registered first, by killing it
 * once the wake settles. Either way `onExit` fires exactly once, so exit-driven
 * work runs for a spawning session exactly as it does for a running one.
 */
/** An exit callback may await (it usually re-reads the session row before a wake); its rejection is logged, never thrown into the emitter. */
export type ContainerExitCallback = () => unknown;

const pendingKills = new Map<string, { reason: string; onExit: ContainerExitCallback[] }>();

/**
 * A caller's precondition, re-proved by the WAKE PATH at the last instant.
 *
 * Same contract and same reasoning as `WriteGuard` in session-manager: `true`
 * proceeds, anything else refuses. Synchronous by requirement — it is called
 * with nothing awaited between it and `spawn()`.
 */
export type WakeGuardResult = boolean | { ok: false; reason: string };
export type WakeGuard = () => WakeGuardResult;

export interface WakeContainerOptions {
  /**
   * Re-proved immediately before `spawn()`, and again when a queued wake is
   * dequeued.
   *
   * Callers proved their preconditions and then called `wakeContainer`, which
   * awaits storage admission, an unbounded wait in the memory queue, a storage
   * lease, and all of `spawnContainer`'s preparation before the process exists.
   * A re-read at the call site cannot see inside any of that. The proof belongs
   * where the spawn is.
   */
  guard?: WakeGuard;
}

/** What a queued wake carries: the session AND the caller's still-unproved guard. */
interface QueuedWake {
  session: Session;
  guard?: WakeGuard;
}

/**
 * The wake guard nearly every caller wants: the central row is still ACTIVE at
 * the moment the process is created.
 *
 * Five call sites had written this by hand as a `getSession()` immediately
 * before `wakeContainer`, which proves it before the call rather than before
 * the spawn — and the wake then awaits storage admission, an unbounded memory
 * queue and all of `spawnContainer`'s preparation. One definition, evaluated in
 * the one place that is adjacent to `spawn()`.
 */
/**
 * Why this row cannot take a wake, or `null` when it can.
 *
 * THE one definition, used by the universal re-read on the wake path and by the
 * opt-in guard alike. Two copies is how the archive axis came to be checked in
 * one place and not the other.
 *
 * `archived_at` is a SECOND axis, not a shade of `status`. `archiveSessionById`
 * stamps it and leaves `status` alone, so a thread-close that archives without
 * closing leaves a row reading `active` — and a check that asked only about
 * `status` would wave a wake straight into a thread the operator was told was
 * finished. The archive-only close is the ordinary outcome, not an edge one.
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

/**
 * Seam 3 §4.5 I-1: a guard-path read that stays SYNCHRONOUS forever.
 * It executes the sessions leaf's own exported `SESSION_BY_ID_SQL` through
 * `withRawDb` — one constant, two executors, not a `*Sync` twin of
 * `getSession` (plan docs/specs/upstream-async-central-db-seam/plan.md §4.5).
 * A `WakeGuard` is `() => WakeGuardResult` and is evaluated inside a
 * `withCentralSync` block with nothing awaited between it and the spawn it
 * protects (`wakeRefusalFrom`'s three call sites); the lease is what keeps
 * this raw read out of an open driver transaction.
 */
function readSessionSync(sessionId: string): Session | undefined {
  return withRawDb((raw) => raw.prepare(SESSION_BY_ID_SQL).get(sessionId)) as Session | undefined;
}

/**
 * Evaluate a wake guard and normalize its answer.
 *
 * Called ONLY from inside a `withCentralSync` block. `evaluateGuardSync` is
 * the runtime half of the guard contract (§4.5 I-1): a guard that hands back a
 * promise — cast, or accidentally `async` — is a contract violation, not a
 * verdict, and it is reported as a refusal here so the caller's own refusal
 * paths (reservation release, storage-lease release) run exactly as for any
 * other "the guard did not say yes".
 */
function wakeRefusalFrom(guard: WakeGuard | undefined): string | null {
  if (!guard) return null;
  let verdict: WakeGuardResult;
  try {
    verdict = evaluateGuardSync(guard);
  } catch (err) {
    // A THROWN guard is a refusal, not an exception to propagate.
    //
    // `sessionStillActive` reads the central DB, and a DB read can throw —
    // transient I/O, corruption, a closed handle. Propagating that from the
    // dequeue took it out through `trackWake`'s generic catch, which resolves
    // `false` and never releases the memory reservation the dequeue is holding:
    // every RETURNED refusal on that path releases, a thrown one leaked a slot
    // off the admission budget permanently. Normalizing here means there is one
    // refusal shape and one set of cleanup paths, rather than a second exit
    // nobody wired.
    //
    // Refusing is also the right answer on its own terms: a guard that cannot
    // answer has not said yes.
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
 * `release` frees a reservation but leaves a QUEUED wake in the controller, and
 * a queued wake outlives the promise that created it: `wakeContainer` returns
 * false, `trackWake` settles, and the controller still holds the payload until
 * some later release drains it. Anything that concludes "this session has no
 * container and never will" has to say so to the controller too, or the wake it
 * thought it had cancelled starts minutes later.
 */
function cancelMemoryAdmission(sessionId: string): void {
  if (!memoryAdmission) return;
  if (containerShutdownInProgress) return;
  startDrained(memoryAdmission.cancel(sessionId));
}

/** Start whatever a release or cancel admitted in this session's place. */
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
 * Which container is registered for this session RIGHT NOW.
 *
 * `isContainerRunning` answers "is there one", which is not enough for a
 * caller that decided something about a specific container and then awaited:
 * the original can exit and a wake can register a replacement in that window,
 * and the boolean reads the same either way. The name is unique per spawn
 * (`${prefix}${folder}-${Date.now()}`) and the claim incarnation moves with the
 * runtime, so the pair identifies the entry across a replacement.
 *
 * Compare with `sameContainerIdentity`, never by object identity: this is a
 * snapshot, not the registry entry.
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
 * Could a container be writing this session's `outbound.db` right now?
 *
 * `outbound.db` has exactly ONE writer. The host may write it only while no
 * container owns it, and "owns it" includes a container that is still
 * SPAWNING — a wake issued a moment ago has not reached `isContainerRunning`
 * yet but is about to hold the file.
 *
 * Lives here rather than in a caller because it is a question about the
 * container registry above, and it now has two callers on different paths:
 * the sweep's stopped-container writes and the thread-close finalizer's
 * archive-or-kill decision. Two copies of this predicate would be two
 * definitions of "owns", which is the drift the seam work exists to remove.
 */
export function containerOwnsOutbound(sessionId: string): boolean {
  // A pending adoption is a survivor this host could not claim: alive,
  // untracked, and still writing. It owns the file until a runtime listing
  // proves it gone (`retryPendingAdoption` clears the entry on that proof).
  return isContainerRunning(sessionId) || isContainerSpawning(sessionId) || pendingAdoptions.has(sessionId);
}

/** Snapshot passed to isolated maintenance workers; never expose the mutable map. */
export function getActiveContainerSessionIds(): string[] {
  return [...activeContainers.keys()];
}

/**
 * The sessions whose storage the maintenance worker must not touch: every
 * tracked container plus every pending adoption — a survivor this host could
 * not claim is alive, untracked, and still using its directories, and it holds
 * its storage-activity lease until a runtime re-list proves it gone.
 */
export function getStorageProtectedSessionIds(): string[] {
  return [...new Set([...activeContainers.keys(), ...pendingAdoptions])];
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
export async function reconcileWorkgroupAtSpawn(
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): Promise<{ workgroupId: string }> {
  const declared = await resolveWorkgroupIdAtSpawn(agentGroup, containerConfig);

  return persistResolvedWorkgroupAtSpawn(agentGroup, declared);
}

/**
 * Persist the exact workgroup identity already resolved at admission.
 *
 * One central transaction (`centralTransaction`, plan §4.4): two driver
 * statements, awaited in sequence, nothing else inside the closure.
 */
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

    // Atomic conditional update: only update if the column is NULL or stale.
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

  // Return the resolved workgroup id so spawnContainer can thread it
  // through every downstream subsystem (buildMounts /workspace/workgroup
  // mount, buildArchiveProjection, applyOnecliSecrets, etc.) without each
  // re-deriving from agentGroups. Eliminates the race where two subsystems
  // inside the same spawn observe different workgroup ids under a
  // concurrent reconcile.
  return { workgroupId: declared };
}

/** Resolve the exact workgroup identity spawn reconciliation will persist. */
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
 * Re-read the session from the central DB and return it only while it is still
 * active. The wake path's status guard runs on the object the CALLER handed us,
 * but the path then awaits — storage admission, an unbounded wait in the memory
 * admission queue, the storage-activity lease — and a reclaim closes the row
 * (it never deletes it) at any point in that window. Spawning on a closed row
 * produces a container `getActiveSessions()` will never return: no stuck
 * detection, no heartbeat ceiling, no claim tolerance, for as long as it runs.
 *
 * So every await in the wake path is followed by this, and the fresh row — not
 * the caller's snapshot — is what continues. Callers keeping their own pre-wake
 * re-read are then belt-and-braces rather than load-bearing.
 *
 * Fail closed: a DB that cannot be read is treated as "do not spawn". The
 * inbound row stays pending and host-sweep retries on its next tick.
 *
 * Callers own the release of anything already held at their bail point — see
 * each call site; this helper deliberately holds and releases nothing.
 */
async function refreshActiveSession(session: Session, stage: string): Promise<Session | null> {
  let fresh: Session | undefined;
  try {
    fresh = await getSession(session.id);
  } catch (err) {
    log.warn('Container wake abandoned — session re-read failed', { sessionId: session.id, stage, err });
    return null;
  }
  // Every wake passes through here, guarded or not — and MOST callers pass no
  // guard: over twenty `wakeContainer` call sites hand in a session and nothing
  // else. So this is the only place an archive-only closure can be refused for
  // all of them, and it uses the same predicate the opt-in guard does.
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
export function wakeContainer(
  session: Session,
  priority: MemoryAdmissionPriority = 'interactive',
  options: WakeContainerOptions = {},
): Promise<boolean> {
  if (containerShutdownInProgress) {
    log.debug('Container wake ignored — host shutdown in progress', { sessionId: session.id });
    return Promise.resolve(false);
  }
  // P4 (plan §4.3.4): a survivor of the previous host that this one could not
  // claim at boot is alive and UNTRACKED, so the running fast path below cannot
  // see it. Consulted first, and routed to the adoption retry — never to the
  // spawn path, which would start a second container beside it.
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
  // Reclaim closes a session row (it never deletes it) and removes its dir, so
  // every by-id caller — support threads, approvals, pending questions,
  // dashboard steer, task completion — can still hand us an archived session.
  // Spawning on one produces a container getActiveSessions() will never
  // return: no stuck detection, no heartbeat ceiling, no claim tolerance, for
  // as long as it runs. The inbound row stays pending for a live session.
  // A fast path on the object the CALLER holds, which may be stale — the
  // authority is `refreshActiveSession` after the first await. Same predicate,
  // so the cheap answer and the authoritative one cannot disagree about what
  // makes a session unwakeable.
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
      // The survivor is gone: a fresh spawn is the correct answer, and the
      // ordinary path below takes it — the claim fence (P2) re-proves absence
      // on its own before the process exists.
    }
    return runWake(session, priority, options);
  });
}

/** The ordinary wake: storage admission → memory admission → reserved spawn. */
async function runWake(
  session: Session,
  priority: MemoryAdmissionPriority,
  options: WakeContainerOptions,
): Promise<boolean> {
  if (!(await checkStorageAdmission(session, false))) return false;
  // First await behind us. Nothing is held yet — storage admission takes no
  // lease and the memory request has not been made — so this bail releases
  // nothing. Everything below runs on the fresh row.
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

  // Priority is part of the atomic admission decision. A task-only wake must
  // never enter as interactive and be demoted afterward: it could otherwise
  // reserve free memory and bypass an older scheduled head before demotion.
  // The queued payload is what startReservedWake later resumes on, so it must
  // be the fresh row — not the caller's snapshot — even though that row is
  // itself re-read again at dequeue.
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

function startReservedWake(queued: QueuedWake): Promise<boolean> {
  const { session, guard } = queued;
  // The second running fast path, and P4 sits in front of it too: a queued
  // wake for a pending adoption must not spend its reservation on a spawn.
  if (pendingAdoptions.has(session.id)) {
    releaseMemoryReservation(session.id);
    return wakeContainer(session, 'interactive', { guard });
  }
  if (activeContainers.has(session.id)) return Promise.resolve(true);
  const existing = wakePromises.get(session.id);
  if (existing) return existing;

  return trackWake(session.id, async () => {
    // Dequeued from the memory-admission queue holding a reservation, carrying
    // the session object captured when the wake was first queued — which can be
    // an arbitrarily long wait. Re-read before spending the slot, and release
    // the reservation on a bail so the next queued session can take it.
    const dequeued = await refreshActiveSession(session, 'memory-admission-dequeue');
    if (!dequeued) {
      releaseMemoryReservation(session.id);
      return false;
    }
    // The caller's own precondition, asked at the dequeue too. The queue wait
    // is unbounded, and the session row being active again says nothing about
    // whether the caller still wants this wake — a thread the operator closed
    // while it queued, a destination revoked, a task cancelled. Under the
    // lease: the guard's reads are raw (§4.5 I-1).
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
  // Read at the START of this wake, which is what makes the discharge below
  // safe: `wakeContainer` hands a caller the EXISTING promise when one is in
  // flight, so a joined wake never reaches here and carries the original
  // wake's token rather than earning a fresh one.
  const respawnToken = respawnIntents.get(sessionId);
  const tracked = run()
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId, err });
      return false;
    })
    .then((woke) => {
      // The one place every wake ends, which is why the discharge sits here
      // rather than in each respawning caller's callback: those are all
      // fire-and-forget `void wakeContainer(...)`, so the callback resolving
      // says nothing about whether a container actually came back.
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

async function spawnReservedContainer(caller: Session, guard?: WakeGuard): Promise<boolean> {
  if (containerShutdownInProgress) return false;
  // Entry re-read. Reached both straight off an admitted request and as the
  // memory-queue dequeue continuation; either way a reservation is held by now,
  // so a bail here must give it back.
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
    // Read once at the actual spawn boundary. The same snapshot supplies the
    // authoritative workgroup declaration and every downstream spawn option.
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
  // Storage-admission promises are tracked for dedupe but are not consuming a
  // container slot. Count spawning sessions only until their process enters
  // activeContainers; the brief async handoff must not double-count one
  // process and incorrectly reject another wake at the cap.
  const inFlightWakes = [...spawningSessions].filter((sessionId) => !activeContainers.has(sessionId)).length;
  // A pending survivor is a container this host did not admit but which is
  // running all the same (seam 4 E/D2, #462 item 7): it occupies a slot.
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
    // Last re-read, after the final await and immediately before the actual
    // spawn. Two things are held here: the storage-activity lease, which the
    // `finally` below releases because `storageActivity` is still non-null, and
    // the memory reservation, which is ours to hand back explicitly.
    const spawnSession = await refreshActiveSession(session, 'pre-spawn');
    if (!spawnSession) {
      releaseMemoryReservation(session.id);
      return false;
    }
    // Asked here as well as at the last word before `docker run`, and asked
    // BEFORE `spawnContainer` does its preparation: that builds mounts, writes
    // a capabilities snapshot and clears the heartbeat file. A session someone
    // has already asked us to kill should not do that work at all, let alone
    // leave its traces on disk.
    const earlyCancellation = pendingKillCancellation(spawnSession.id);
    if (earlyCancellation) throw earlyCancellation;
    // The caller's own precondition, asked here for the same reason and again
    // as the last word before `spawn()`. `spawnContainer` builds mounts, writes
    // a capabilities snapshot and clears the heartbeat file; a wake whose
    // caller no longer wants it should not do that work or leave its traces.
    // Under the lease: the guard's reads are raw (§4.5 I-1).
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
  // Checked before anything below writes into this .git. A `commondir` file
  // sends Git to another repository's refs and objects (#669), so the canonical
  // carries a self-referential sentinel, bind-mounted read-only over its own
  // path like the object-alternates placeholders below. An existing canonical
  // gets it at its next spawn. Anything else found there is never overwritten:
  // the caller withholds this repository's mounts and logs it.
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

/** Module-lifetime (one boot) dedup so a repository whose hooks decision degrades doesn't alert on every spawn — see resolveScanPolicyHooksMount's doc comment. Keyed by gitDir, which is unique per canonical repository. */
const scanPolicyHooksAlerted = new Set<string>();

function alertScanPolicyHooksOnce(repository: { gitDir: string }, outcome: 'refuse' | 'withhold'): void {
  if (scanPolicyHooksAlerted.has(repository.gitDir)) return;
  scanPolicyHooksAlerted.add(repository.gitDir);
  log.error('managed-git-hooks: scan-policy repository degraded below the real hook', {
    outcome,
    // gitDir DOES contain the workgroup id and repo name as path segments
    // (#666 review P3-5: an earlier comment here incorrectly claimed
    // otherwise) — this is a host log line, not the count-only report
    // migrateExistingCanonicalHooksPath returns to callers, so it is fine
    // for it to be more specific.
    gitDir: repository.gitDir,
  });
}

export interface ScanPolicyHooksMountResult {
  /**
   * true only when even the refuse hook failed validation — the caller MUST
   * withhold every mount for this repository (gitDir, control mounts, lock,
   * origin pin), following the transfer-tombstone `continue` precedent
   * above, so git in that worktree fails outright rather than running with
   * no hook at all. `mounts` is always empty when this is true.
   */
  withhold: boolean;
  /** The managed-hooks mount to add for this repository — empty when the repo isn't scan-policy-configured at all, or `withhold` is true. */
  mounts: VolumeMount[];
}

/**
 * Resolves a canonical repository's `core.hooksPath` against
 * MANAGED_GIT_HOOKS_SCAN_DIR (the ONE value every writer uses — B12) and,
 * only for repositories actually configured that way, runs
 * decideHooksMountStrategy's scan -> refuse -> withhold fallback (see its
 * own doc comment in src/managed-git-hooks.ts for the full ordering
 * rationale). `core.hooksPath` IS the signal read here — this does not
 * re-derive "is this repo scan-policy" from the repo name; it reads
 * whatever value is already committed in the repo's own .git/config.
 *
 * Never throws for a degraded outcome: 'refuse' returns a mount (at the
 * SAME container path the real hook would use, so git still finds a hook
 * and still runs it — the refuse hook itself), and 'withhold' returns
 * `{ withhold: true }` for the caller to act on. Alerts (once per boot per
 * repository, via alertScanPolicyHooksOnce above) on both degraded
 * outcomes; the 'scan' (real hook) outcome is silent.
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
  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  const routingWritesStartedAt = Date.now();
  if (await hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    await writeDestinations(agentGroup.id, session.id);
  }
  await writeSessionRouting(agentGroup.id, session.id);
  logSpawnStage('routing-writes', routingWritesStartedAt);

  // Materialize the runner's immutable startup context before buildMounts
  // pushes its bind mount. The SQLite mailbox has no context to hand over, so
  // the file holds `null` — it exists so the spawn path stops diverging from
  // upstream's, and so an implementation that DOES need one (a networked
  // mailbox, say) is a registration away rather than a spawn-path change.
  const mailboxKey = { agentGroupId: agentGroup.id, sessionId: session.id };
  const mailbox = getAgentMailbox();
  writeSessionContext(agentGroup.id, session.id, await mailbox.runnerContext(mailboxKey));
  const mailboxEnvironment = await mailbox.runnerEnvironment(mailboxKey);

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
    // Fire-and-forget: only the shared base image is something this watcher
    // can fix by rebuilding (a per-agent override image built via
    // install_packages needs that self-mod re-run, not a base rebuild — see
    // rebuildHint() in agent-runner-image-check.ts). Never awaited — the
    // refusal below must return immediately; host-sweep retries the spawn
    // and picks up the new image once the detached rebuild lands.
    if (spawnImageRef === CONTAINER_IMAGE) requestContainerRebuild(depsCheck.message);
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
  // The in-memory claims above close ordinary concurrent spawn admission. The
  // per-session DB fence survives a host crash, so it is the recovery gate for
  // a publication/transfer that died after quiescence began. A replay with the
  // same deterministic action epoch releases it at the durable boundary.
  // Read-only, through the seam: a spawn must never provision a mailbox here
  // (invariant I-4). The session is closed before the read's verdict is acted
  // on, so nothing downstream of this spawn is inside a mailbox session for
  // this key (invariant I-3).
  //
  // The result is wrapped so "no mailbox" and "no fence" stay distinguishable:
  // the seam answers `undefined` for the first and `{ fence: null }` for the
  // second, and reading them as the same thing would let a spawn through for a
  // session whose inbound.db has been reclaimed. That fails closed on purpose —
  // a container with no mailbox to poll could otherwise recreate the host-owned
  // database under the writable parent mount. The direct open this replaced
  // threw for exactly this state. Since #749 `buildMounts` refuses such a spawn
  // outright rather than omitting the overlay, so this is now the first of two
  // fail-closed checks rather than the only one.
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
  logSpawnStage('repository-fence', repositoryFenceStartedAt);

  const providerDecisionStartedAt = Date.now();
  const providerDecision = await resolveSpawnProvider({
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

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = await resolveProviderContribution(spawnSession, agentGroup, containerConfig);

  // Wraps every stage logged inside buildMounts, so the sum of the parts can
  // be checked against the whole rather than assumed to account for it.
  const buildMountsStartedAt = Date.now();
  const mounts = await buildMounts(agentGroup, session, containerConfig, provider, contribution, resolvedWgId);
  logSpawnStage('build-mounts', buildMountsStartedAt);
  const containerName = `${CONTAINER_NAME_PREFIX}${agentGroup.folder}-${Date.now()}`;
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

  // Identical to session.messaging_group_id for chat sessions; for a task
  // session (which has none by construction) this resolves the series'
  // delivery destination so the gate judges WHERE THE TASK POSTS instead of
  // fail-closing on null. See resolveSlackSafetyMessagingGroupId.
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

  // Build args intentionally accumulate credentials late, after provider and
  // gateway resolution. Passing those values as `docker run -e KEY=value`
  // exposes them to any host process reader via the Docker CLI command line.
  // Keep the value-bearing surface in a 0600 host-only file instead; Docker
  // receives only that pathname. It is removed when the CLI process exits.
  // The per-agent `.context` directory is host-private: only this session's
  // individual context FILE is mounted into the container. Do not use
  // `<session>/.host`: its whole directory is mounted read-only at
  // `/workspace/.host`, which would make an otherwise mode-0600 env file
  // readable by the agent process.
  const dockerEnvironmentDir = path.dirname(sessionContextPath(agentGroup.id, session.id));

  // Snapshot host capabilities into the session dir so the container can
  // read a static JSON (Phase 5.3). Refreshed every spawn so newly-mounted
  // credentials / plugins / channel registrations appear immediately.
  // Deliberately AFTER buildContainerArgs: that call resolves the GitHub
  // token (minting/refreshing the App cache), and the snapshot's expiresAt
  // field must describe the credential THIS spawn actually injects — writing
  // it earlier surfaced the pre-spawn cache state instead (stale-low or
  // absent on cold start). Subject for the Slack owner-safety gate. Identical
  // to session.messaging_group_id for chat sessions; for a task session
  // (which has none by construction) this resolves the series' delivery
  // destination so the gate judges WHERE THE TASK POSTS instead of
  // fail-closing on null. See resolveSlackSafetyMessagingGroupId.
  if (!wikiActor) await writeCapabilitiesSnapshot(agentGroup.id, session.id, slackSafetyMessagingGroupId, resolvedWgId);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // THE CROSS-PROCESS SPAWN FENCE. Winning the claim is what licenses touching
  // this session's runtime state — the heartbeat clear immediately below
  // included. Losing it means another live claimant runs this session: abort,
  // and `trackWake` turns the throw into `false` so the sweep re-checks next
  // tick. A failed write throws for the same reason; a claim that cannot be
  // recorded is a claim not held.
  //
  // This is also the LAST `await` in the spawn path. Everything from here to
  // `spawn()` is synchronous, so the guard point below and the process creation
  // stay adjacent — the contract the comment block there states and seam 3
  // §4.5 I-1 pins.
  const claimIncarnation = await claimSessionRun(session.id, containerName);
  if (claimIncarnation === null) {
    throw new Error(`session ${session.id} is claimed by another live host process — not spawning a duplicate`);
  }

  // THE GUARD POINT, and the spawn, in ONE synchronous block under the central
  // lease (`withCentralSync`, plan §4.5 I-1). Everything above the claim
  // awaits — routing writes, the mailbox context, the dependency check, mount
  // construction, argument construction — and the caller's precondition was
  // last proved before all of it. This is the only place in the wake path
  // where "still true?" and "the process now exists" are adjacent, so this is
  // where the question belongs; the lease is what makes the guard's raw read
  // and the `spawn()` one indivisible turn that no driver transaction can
  // interleave. `src/db/central-lease.test.ts` pins that no `await` sits
  // between `evaluateGuardSync` and `spawn(` inside this block. The lease
  // acquire is the one await after the claim, and both questions below are
  // asked after it.
  //
  // The LAST word before the process exists, likewise inside the block: a
  // kill request landing in any earlier window is seen here even though the
  // check at the reserved spawn boundary already passed. Nothing awaits
  // between the check and `activeContainers.set`, so a request either loses to
  // this whole block and is honoured here, or arrives after registration and
  // takes the ordinary running-container path. `trackWake` settles it either
  // way.
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
      const lateCancellation = pendingKillCancellation(session.id);
      if (lateCancellation) throw lateCancellation;
      const guardRefusal = wakeRefusalFrom(guard);
      if (guardRefusal !== null) {
        throw new Error(`Container spawn refused by its guard: ${guardRefusal}`);
      }
      const dockerEnvironment = materializeDockerEnvironment(args, dockerEnvironmentDir, session.id);
      dockerEnvironmentFile = dockerEnvironment.file;
      const child = spawn(CONTAINER_RUNTIME_BIN, dockerEnvironment.args, { stdio: ['ignore', 'pipe', 'pipe'] });

      // The registry entry and the finalize fence below share this exact
      // channel object (`active.channel === channel` in finalizeSession).
      channel = { kind: 'spawned', process: child };
      activeContainers.set(session.id, {
        channel,
        containerName,
        spawnedAt: Date.now(),
        adopted: false,
        storageActivity,
        claimIncarnation,
      });
      everSeenRunningSessions.add(session.id);

      // Every child listener is attached HERE, in the same synchronous turn as
      // `spawn()`, before the block returns (#460 round 2). A runtime that
      // cannot launch (ENOENT, EACCES) emits `error` from a `process.nextTick`
      // queued inside `spawn()`; whether the continuation of the `await`
      // around this block runs before that tick is a scheduler detail
      // (Node ≥ 11 drains microtasks first, so today it does), and an `error`
      // with no listener is an uncaught exception that takes the host down.
      // Attaching inside the block makes the guarantee structural: the
      // listeners exist before anything queued by `spawn()` can run.
      // `src/session-claim-spawn.test.ts` pins it with a child whose `error`
      // fires from a microtask.

      // Log stderr. A container that dies at boot (unknown provider, missing
      // binary, bad config) explains itself only here — and debug is below the
      // default log level — so keep a tail to surface on a non-zero exit.
      captureContainerStderr(child.stderr, containerName, stderrTail);

      // stdout is unused in v2 (all IO is via session DB)
      child.stdout?.on('data', () => {});

      // No host-side idle timeout. Stale/stuck detection is driven by the host
      // sweep reading heartbeat mtime + processing_ack claim age + container_state
      // (see src/host-sweep.ts). This avoids killing long-running legitimate work
      // on a wall-clock timer.

      child.on('close', (code) => {
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

      child.on('error', (err) => {
        finalizeContainer();
        log.error('Container spawn error', { sessionId: session.id, err });
      });
    }, 'wake guard at spawn');
  } catch (err) {
    removeDockerEnvironmentFile(dockerEnvironmentFile);
    dockerEnvironmentFile = null;
    // Every refusal in the block above happens with the claim already held and
    // no process to release it: hand it back here, or the next legitimate wake
    // for this session is fenced out by a spawn that never happened. This
    // `await` is unreachable from the path that reaches `spawn()`.
    await releaseClaimQuietly(session.id, claimIncarnation);
    throw err;
  }
  // Every handler was registered inside the lease block above; only now may
  // this function yield. The `running` status write is awaited AFTER the exit
  // handlers exist: with a delayed driver a container that dies at boot would
  // otherwise emit close/error while the write is pending, before
  // finalizeContainer and the kill callbacks exist.
  await markContainerRunning(session.id);
}

/**
 * The one terminal for a tracked container, whichever channel observed it.
 *
 * Lifted out of `spawnContainer` so an adopted entry — which has no spawn
 * closure — finalizes through the same code. The identity fence is exactly as
 * strong as the closure's was: `active.channel === channel` compares the same
 * object the caller registered, which is what `active.process === container`
 * compared before. A late event from a runtime the registry has already
 * replaced deletes nothing and releases nothing shared.
 *
 * Synchronous by requirement: it runs from `close`/`error` handlers. The
 * durable writes are one detached tail (`finishSessionBookkeeping`), fenced on
 * the session claim so a peer host that took the session at N+1 is never
 * overwritten by this host's stale finish (#439, item 2).
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
    // An adopted entry holds no lease: this host did not spawn the container
    // and acquiring one at adoption would double-count the session against the
    // storage admission controller.
    if (active.storageActivity) {
      void active.storageActivity.release().catch((err) => {
        log.warn('Failed to release container storage activity lease', { sessionId, err });
      });
    }
    releaseMemoryReservation(sessionId);
    // Exit handlers are synchronous; the status write is fire-and-forget here
    // exactly as it was before the driver went async, with its failure logged.
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

  // A terminal event from a runtime the registry has already replaced. It
  // owns nothing shared any more: releasing its claim would clear the
  // REPLACEMENT's row and the status write would report a live container
  // stopped, so only its own storage lease is handed back.
  log.warn('Ignoring stale session finish', { sessionId, containerName: containerName ?? active?.containerName });
  if (storageActivity) {
    void storageActivity.release().catch((err) => {
      log.warn('Failed to release untracked container storage activity lease', { sessionId, err });
    });
  }
}

/**
 * The durable half of a container's finish: the `stopped` status write (and
 * the dashboard event it emits) and the claim release.
 *
 * Both are fenced on the claim row. The release always was — it matches
 * `claimed_by` AND `incarnation`, so a stale release is a no-op — but the
 * status write was not: after a peer host took the session at N+1, this host's
 * still-live child could report the peer's live container stopped (#439, item
 * 2). The fence read and the conditional status write are ONE atomic step
 * (`centralTransaction`, `BEGIN IMMEDIATE` under the central lease): a
 * replacement wake's claim CAS runs in its own transaction and so waits behind
 * this one, which closes the interleaving where the replacement claimed N+1
 * between this finish's read and its write and was then stamped `stopped`
 * after it had marked itself running. The dashboard event is emitted after
 * the commit — the closure is DB calls only (plan §4.4).
 *
 * A row that has moved past our incarnation, or is held by someone else,
 * means the finish is not ours to record. A transaction that fails proceeds
 * unfenced, exactly as before the fence existed — a central DB that cannot
 * answer a read will refuse the status write on its own terms. Entries with no
 * incarnation (the claim was refused, or never taken under a durable id) have
 * nothing to fence on and write as they always did.
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
  // The release is scoped to THIS runtime's own incarnation, so one still in
  // flight when a fresh spawn wins the next incarnation lands as a no-op
  // instead of unclaiming the live container.
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
 * A killed container never reaches its turn boundary, so it can never emit the
 * `turn_end` row that tells the host to delete this session's 💭 status.
 * Without this the thinking label survives as the run's only visible output —
 * permanently for a scheduled task, whose NORMAL exit is the idle reaper
 * killing it mid-stream. Dynamic import: delivery.ts imports this module.
 * Fire-and-forget and never throws — cleanup must not block the kill.
 *
 * Runs for a CANCELLED spawn too. No container reached a turn, so it is
 * usually a no-op, but the two paths are one event from a caller's point of
 * view and should not differ in what they leave behind.
 */
function clearStatusOnKill(sessionId: string, reason: string): void {
  void import('./delivery.js')
    .then((m) => m.clearSessionStatusOnKill(sessionId))
    .catch((err) => {
      log.warn('Failed to clear status on container kill — leaving as-is', {
        sessionId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      });
    });
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
  clearStatusOnKill(sessionId, reason);
  try {
    stopContainer(entry.containerName);
  } catch {
    channelKillFallback(entry, sessionId);
  }
}

/**
 * What a caller owes the session after the stop.
 *
 * `'respawn_after_stop'` is a PROMISE: this host will bring the session back,
 * and if it dies before doing so the next boot must finish the job. `'stop'`
 * means the session is meant to stay down. The two are not inferable from the
 * presence of an `onExit` callback — several callers pass one purely for
 * bookkeeping (`killThenFollowUp` resets orphaned claims and writes the ceiling
 * accounting for a kill that must STAY stopped), so the caller states it.
 */
export type StopIntent = 'stop' | 'respawn_after_stop';

/**
 * Kill a container for a session, INCLUDING one that is still spawning.
 *
 * `intent` records what the caller owes the session, durably, BEFORE the stop
 * is issued — it defaults to `'stop'`, so a caller has to opt in to a promise
 * it is going to keep.
 *
 * Three states, and only the third is a no-op:
 *   - running: stop it, and `onExit` fires on the process close, as always.
 *   - spawning: the request is recorded and honoured when the wake reaches its
 *     cancellation point or registers a process; `onExit` still fires. See
 *     `pendingKills`.
 *   - neither: nothing to kill and no exit to report, so `onExit` does NOT
 *     fire. Callers rely on that — `container-restart` treats "not running" as
 *     "this restart did not happen" rather than as an exit.
 */
export function killContainer(
  sessionId: string,
  reason: string,
  onExit?: ContainerExitCallback,
  intent: StopIntent = 'stop',
): void {
  if (!activeContainers.has(sessionId)) {
    if (pendingAdoptions.has(sessionId)) {
      // A survivor this host could not yet adopt: running, owned, untracked.
      // Stopped by name and proven gone before its hold is released and the
      // exit work runs (seam 4 E/D2, #462 item 2).
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

// ── Adoption (seam 4 series E, plan §4.3, §7.E) ───────────────────────────────

/** What `adoptRunningSessions` found and did, logged once per boot. */
export interface StartupReconciliation {
  /** Containers registered as adopted entries. */
  adopted: number;
  /** Containers stopped: no session label, no session row, or a session that cannot take a wake. */
  stopped: number;
  /** Containers left running unadopted because the claim could not be taken; the wake path retries (P4). */
  pendingClaim: number;
  /** Adopted sessions whose inbound DB carries an ACTIVE repository ingress fence (counted, not acted on). */
  fencedInbound: number;
}

/**
 * Sessions whose survivor could not be claimed at adoption: a write failure, a
 * lost CAS, or a claim a live peer holds. Alive and untracked — exactly what
 * the running fast path cannot see — so `wakeContainer` consults this set
 * FIRST and routes a hit to `retryPendingAdoption` rather than the spawn path.
 */
const pendingAdoptions = new Set<string>();

/**
 * Everything a running-but-unadopted survivor holds while it is pending: the
 * storage-activity leases for its session-dir and worktree roots, and a
 * memory-accounting reservation sized as a spawn of its group would be. The
 * claim, when this host holds it, is simply not released. Taken by
 * `holdAsPending` — the ONE step every path that leaves a survivor running
 * goes through — and released in exactly two places: adoption success, where
 * the registry entry takes the hold over, and proven absence
 * (`releasePendingHold`, from the re-list or a proven stop).
 */
interface PendingHold {
  /** The container's name when it was listed; null for a survivor held on an inventory failure. */
  containerName: string | null;
  lease: StorageActivityLease | null;
  /** MiB counted against the budget — saturating when the survivor does not fit. */
  reservedMb: number | null;
  /** False when the survivor would be refused as a spawn: its reservation is saturating and adoption stops it under its claim. */
  fits: boolean | null;
  /** The `docker wait` exit observer, armed when the name is known (#462 item 1). */
  waiter: ChildProcess | null;
  /**
   * Exit work handed to `killContainer` by a stop that could not be proven:
   * run once, when the observer (or a re-list) proves the container gone. A
   * one-shot caller — a restart with a wake message, a self-mod or provider
   * restart — relies on it to request the replacement.
   */
  parkedExits: ContainerExitCallback[];
}
const pendingHolds = new Map<string, PendingHold>();

/**
 * Observe a pending survivor's exit (#462 item 1). Without this a survivor
 * that exits with no further message keeps its holds until the next boot and
 * can starve unrelated queued sessions. Same discipline as the adopted
 * channel: a waiter close is a hint, checked against the runtime; gone →
 * release everything; still there (or unanswerable) → re-arm after backoff.
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
    // Only the waiter the hold still names may act; a released or transferred
    // hold, or a re-armed one, has moved on.
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

/**
 * Arm the exit observer once a survivor's pending state is FINAL for this
 * pass — not while `adoptRunningSession` is still deciding, because an
 * adoption that succeeds a moment later arms the registry's own waiter and
 * the extra observer would only have to be torn down again.
 */
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
 * Hold a running survivor this host is not (yet) supervising: mark it pending
 * (so `containerOwnsOutbound` is true and the wake path retries adoption),
 * lease its storage roots, and reserve its memory. Idempotent — a hold already
 * taken is kept, and a resource that could not be taken is retried on the
 * next call. `container` is null when the survivor was never listed (the
 * inventory failed) and its workgroup label is unknown.
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
      // A named hold is never re-pointed: the container it names is alive
      // and its waiter is the only thing watching it. Callers remove the
      // second container instead (`removeDuplicateContainer`).
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
        // The survivor is using this memory whether or not it fits: count it,
        // saturating, so admission blocks fresh spawns until it is adopted or
        // proven gone (#462 item 5) rather than spawning on top of it.
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

/**
 * Proven absence: give back everything the pending survivor held, then run
 * the exit work a stop parked on it — exactly once, after the release, in the
 * order a tracked container's `close` would have run it.
 */
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

/**
 * Adoption success: the registry entry takes the hold over. The lease moves
 * onto the entry (`finalizeSession` releases it) and the reservation stays in
 * the controller under the same id (`finalizeSession` releases that too).
 */
function transferPendingHold(sessionId: string): void {
  pendingAdoptions.delete(sessionId);
  const hold = pendingHolds.get(sessionId);
  pendingHolds.delete(sessionId);
  // The registry entry arms its own waiter; the pending observer stands down.
  if (hold) disarmPendingWaiter(hold);
}

/**
 * Stop a pending survivor by name (#462 item 2): `docker stop`, then a hard
 * kill if the stop did not take, and the hold is released — and the exit work
 * run — only once the runtime proves the container gone. A survivor that
 * cannot be stopped stays pending (owned, leased, counted) and the caller
 * retries on its next tick, exactly as it does for any owned outbound.
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
  // The exit work rides the hold either way: released now if the container is
  // proven gone, or by the observer when it eventually exits (#479 round 2).
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
 * Make an unlisted pending survivor stoppable (#479 round 2): a hold seeded on
 * an inventory failure carries no container name, so nothing can stop it by
 * name. Re-list from the runtime: found → the name is recorded and the exit
 * observer armed, `'running'`; not listed → the survivor is gone and its hold
 * is released, `'gone'`; the runtime cannot be asked → `'unknown'`, and the
 * caller must not report a restart it could not perform. A hold that already
 * carries a name is `'running'` without a listing.
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
 * The identity of the container running a session — its runtime name — for a
 * tracked entry or a pending survivor, or null when there is none. Stable
 * across adoption (the same docker process keeps its name when a pending
 * survivor is adopted), and different for every spawn (the name carries the
 * spawn instant), so a caller that must tell "the same container" from "a
 * replacement" across an await compares this, not `getContainerSpawnedAt`,
 * which flips from 0 to the adoption instant on adoption (#479 round 2).
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

/**
 * The runtime listing adoption reads, replaceable for tests. `adoptRunningSessions`
 * pins whatever it was handed so the wake-path retry re-lists through the same
 * source the boot pass did.
 */
let adoptionListing: () => InstallContainerScope[] = listInstallContainersWithScope;

/**
 * Backoff before an adopted entry's waiter is re-armed after a close the
 * runtime contradicted. `docker wait` against an unreachable daemon exits at
 * once, so a re-arm without a pause would spin.
 */
const ADOPTED_WAITER_REARM_MS = 5_000;
let adoptedWaiterRearmMs = ADOPTED_WAITER_REARM_MS;

export function hasPendingAdoption(sessionId: string): boolean {
  return pendingAdoptions.has(sessionId);
}

export function _resetAdoptionRetryStateForTesting(): void {
  pendingAdoptions.clear();
}

/**
 * Test-only: stand in for an adoption that failed its claim write.
 *
 * Series F ships the READER of `pendingAdoptions` before series E ships the
 * writer, so its deferral case has no other way to reach that state. Keep it
 * after E's merge only until `adoptRunningSessions` gives the suite a real
 * route into the state.
 */
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

/**
 * Listen on the CURRENT waiter of an adopted channel. `close` is a hint, not a
 * terminal (§4.3.3): `onWaiterClose` checks it against the runtime first.
 * `error` (the waiter could not even start) is handled the same way; the
 * `handled` latch keeps the pair from re-reading truth twice for one exit.
 */
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
 * The waiter-close truth re-read (plan §4.3.3, property 5). A docker-daemon
 * restart exits every waiter at once and would read as a fleet-wide terminal;
 * so the runtime is asked before anything is finalized. Still running →
 * re-arm. Cannot be asked → treated as still running, re-arm. Gone → the
 * container's real terminal, finalize. `No such container` from `docker wait`
 * lands on the "gone" side through the same read, so it is never re-armed.
 */
function onWaiterClose(
  sessionId: string,
  channel: AdoptedChannel,
  containerName: string,
  code: number | null,
  stderrTail: string[],
): void {
  if (activeContainers.get(sessionId)?.channel !== channel) {
    // A waiter the registry no longer owns (the entry was replaced or already
    // finalized). Nothing shared to touch; the fence inside logs it.
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
 * Register a container this host did not spawn, after its claim is held.
 *
 * Mirrors the spawn path's registration with two deliberate differences: the
 * channel is a `docker wait` observer, and `spawnedAt` is the adoption instant
 * — the honest ceiling anchor for a container whose real start this host
 * never saw. The storage-activity lease is the same one a spawn holds, taken
 * by the caller after `main()`'s startup reset of the previous host's markers. The heartbeat file is NOT cleared: it is the
 * survivor's own, and the sweep reads it as evidence the container is alive.
 * The `running` status write is awaited only after the waiter is armed, for
 * the same reason the spawn path attaches its exit handlers first.
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
  everSeenRunningSessions.add(session.id);
  armAdoptedWaiter(session.id, channel, containerName);
  // F1 hook: reconcileSurvivorWakeRows(session)
  await reconcileSurvivorWakeRows(session);
  // The waiter is armed and may have finalized during that await: the same
  // identity fence `finalizeSession` uses decides whether a running stamp is
  // still ours to write.
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
 * Reserve an adopted container's memory in the admission controller, sized
 * exactly as a spawn of the same agent group would be (`resolveContainerResources`
 * over the group's `container.json`). Without this the controller starts a
 * boot with survivors at 0 MiB reserved and can admit a full budget of fresh
 * spawns on top of containers that are already using theirs.
 *
 * A survivor the controller would refuse a spawn for — the request exceeds
 * the budget, or the budget is already spent by earlier survivors — is refused
 * here too: adoption never over-commits what a spawn could not. The caller
 * stops that container; its next wake re-enters admission like any spawn.
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
  // A queued request would otherwise be drained into a spawn later, for a
  // container this host is about to stop.
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
 * Take the claim for a survivor and register it. Property 1 (§7.E): claim
 * before adopt, and never adopt unfenced — every path out of a failed or lost
 * claim leaves the container running and untracked, recorded in
 * `pendingAdoptions` so the wake path retries rather than spawning into it.
 */
async function adoptRunningSession(
  session: Session,
  containerName: string,
  workgroupId: string | null,
): Promise<AdoptionOutcome> {
  // Hold everything FIRST. Whatever happens below, a survivor that stays
  // running stays owned, leased and counted until it is adopted or proven
  // gone; only those two outcomes give anything back.
  const hold = await holdAsPending(session, { name: containerName, workgroupId });
  const pending = (): AdoptionOutcome => {
    observePending(session.id);
    return { outcome: 'pending' };
  };
  if (!hold.lease) return pending();
  // Claim next. Only a container this host has claimed may be stopped for
  // local admission pressure: a survivor a live peer holds is the peer's turn,
  // and stopping it for our budget would be the interruption the lost-claim
  // path exists to avoid. Unclaimed and over-budget both leave it running.
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
  // Memory, under our own claim. A survivor that does not fit is ours to
  // stop — but the claim and the hold go back only once the container is
  // PROVEN gone. A stop that fails leaves a running container that must stay
  // claimed and pending, or a later wake would spawn a second writer beside it.
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
    // The waiter could not be created: the claim is held with nothing to
    // supervise it. Hand the claim back (the hold stays with the pending
    // entry) and let the wake path retry the whole step.
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
  // §4.3.6: a survivor may sit behind an ACTIVE fence the dead host wrote.
  // Counted so the case is visible; `releaseOrphanedRepoIngressFencesAtStartup`
  // owns the release and runs after adoption.
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
 * Remove a second container for a session this host already owns (tracked or
 * held pending) under `owner`. Stop, escalate to kill, and require proven
 * absence; a duplicate this host cannot remove fails the boot — when the owned
 * container exits, finalization would release the claim, reservation and
 * leases while the duplicate keeps writing the outbound DB, so there is no
 * safe state to continue from (#462 item 6).
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

/**
 * Hold a survivor pending without having seen its container: the inventory
 * could not be read, and the door said this session's container survived.
 * Fail closed — owned, leased, counted, retried on wake — rather than letting
 * the sweep and the wake path treat it as unowned.
 */
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
 * Adopt the containers a previous host process left running (plan §7.E).
 *
 * Runs once at boot, after the quiescence door and BEFORE every wake source and
 * before the orphaned-fence recovery (P3; `src/adoption-order.test.ts` pins
 * both). A listing failure adopts nothing and returns all zeros: adoption that
 * cannot see the runtime must not guess, and the boot door has already run its
 * own fail-closed proof. A container with no session label, no session row, or
 * a session that cannot take a wake is stopped — a survivor without an owner
 * is a writer without a reader.
 */
export async function adoptRunningSessions(
  deps: {
    list?: () => InstallContainerScope[];
    /**
     * D1's boot-scope partition (`quiesceWorkgroupsForBootMountChange(...)
     * .survivableSessionIds`): the sessions whose containers the door chose to
     * leave running, computed before anything was stopped. When given it is
     * THE candidate set — the same partition series G's startup warn skips —
     * and a listed container outside it is stopped here, fail-closed, because
     * the door meant to stop it. Absent, every listed container is a candidate
     * (the pre-D1 tree, and tests that drive the listing directly).
     */
    survivableSessionIds?: ReadonlySet<string> | readonly string[];
    /**
     * The sessions whose containers the door actually LEFT running — the
     * fail-closed seed when this pass's own inventory cannot be taken. Defaults
     * to `survivableSessionIds`. `main()` derives it from the door's counts:
     * under D1 the door stops the survivable containers too, so its partition
     * is a counterfactual and seeding it would create phantom holds for
     * containers the door just proved gone; the seed is then empty.
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
      // The door left these containers running; a listing this process
      // cannot take is no evidence they are gone. Every one is held pending —
      // owned and leased — until `retryPendingAdoption` can re-list.
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
  /**
   * Stop a container adoption will not take, and PROVE it gone. A stop that
   * fails or cannot be proven leaves a running writer, which is then held
   * pending exactly like a survivor whose claim was lost — owned, leased,
   * counted, retried on wake — unless there is no session to hold it for.
   */
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
      // Unreachable for a survivor under D1: a container with no session label
      // is one adoption could never claim, so the door fails it closed into
      // its stop set. Kept as a defensive stop for a listing the door did not
      // partition.
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
      // A second container for a session already tracked: two writers. Not
      // held pending on failure — the session is already owned by the tracked
      // entry, and a pending mark would route its wakes at the wrong container.
      removeDuplicateContainer(container, 'tracked', tracked.containerName);
      counts.stopped += 1;
      continue;
    }
    const held = pendingHolds.get(container.sessionId)?.containerName ?? null;
    if (held !== null && held !== container.name) {
      // A second container for a session already held pending under another
      // name: the same two writers. The hold keeps its container and its
      // waiter — re-pointing it would leave the first alive and untracked,
      // free to keep writing the outbound DB after the second is adopted or
      // exits, and a later wake would then start a third writer beside it.
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
  // F2 lives in `main()`, not here: `honorPendingStopIntents()` can spawn, and
  // this pass stays a pure inventory with no wake inside it (plan §7.F).
  log.info('Reconciled sessions at startup', { ...counts });
  return counts;
}

/**
 * P4: a wake for a session whose survivor could not be claimed at boot.
 *
 * Re-lists from the runtime. Container gone → cleared, `false`, and the caller
 * falls through to a fresh spawn, which is correct. Still there → the same
 * claim-then-register step boot took; a claim the runtime or the store refuses
 * THROWS, so `trackWake` reports the wake failed and the sweep retries — and
 * no spawn happens. A listing that cannot be taken throws for the same reason.
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
    // The session stopped being wakeable while its survivor waited: the same
    // answer boot gives such a container. Ownership is dropped only once the
    // stop is proven; otherwise it stays pending for the next wake.
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
    // Stopped for not fitting the memory budget and proven gone (the hold went
    // back with it): the ordinary path's own admission decides a spawn.
    return false;
  }
  log.info('Adopted a pending survivor on wake', { sessionId: session.id, containerName: survivor.name });
  return true;
}

/**
 * Record the DURABLE half of a stop request, so a host that dies mid-restart
 * does not forget it.
 *
 * A kill-with-respawn lives in an `onExit` callback, which is process memory: a
 * host that went down between the kill and the callback firing forgot the
 * restart entirely, and the operator saw "rebuild applied" with nothing coming
 * back. `honorPendingStopIntents()` consumes the row at the next startup.
 *
 * The intent comes from the CALLER, not from the presence of an `onExit`
 * callback. Several callers pass one for bookkeeping alone — the ceiling kill
 * resets orphaned claims and posts its accounting through `onExit`, and it must
 * stay stopped — so deriving the promise from the callback would resurrect
 * every one of those sessions at the next boot. Routing the write through this
 * one door is still the point: `killContainer` is the single stop every caller
 * goes through, so no caller can forget to ARM a recovery it did promise.
 *
 * Not awaited, because `killContainer` is synchronous and every one of its
 * callers depends on that. `shadowWrite` already swallows its own failures, so
 * the only thing an await would buy is ordering against the stop — and a stop
 * intent that lost its race with a host crash is exactly as recoverable as one
 * that was never written.
 */
function recordStopIntent(sessionId: string, intent: StopIntent): void {
  if (intent === 'respawn_after_stop') respawnIntents.set(sessionId, ++respawnIntentSeq);
  else respawnIntents.delete(sessionId);
  void shadowWrite('stop-intent', () => setStopIntent(sessionId, intent, new Date().toISOString()));
}

/**
 * Discharge a respawn promise this process made, now that the session has a
 * container again.
 *
 * Without this only `honorPendingStopIntents` ever clears the row, so a restart
 * that COMPLETED normally leaves `respawn_after_stop` behind and every later
 * boot replays it — waking a session nobody asked for, once per restart,
 * forever.
 *
 * `token` is what the waking side read from `respawnIntents` when it STARTED,
 * and only a wake that read THIS promise may discharge it. A wake already in
 * flight when the kill arrived read `undefined`, or an older promise's token,
 * and its `true` says nothing about the container this kill is about to stop —
 * clearing on it would leave the session down with nothing owed. A later wake
 * that merely joins that in-flight promise inherits its token and is refused
 * for the same reason; the replacement wake the kill's own callback starts
 * reads the current token and qualifies.
 *
 * Gated on `respawnIntents` so an ordinary message-driven wake costs no central
 * DB write: the map holds only the promises THIS process made and has not yet
 * discharged. A promise made by a host that died is not in it, which is
 * correct — that one belongs to `honorPendingStopIntents` at the next boot, and
 * it clears the row itself.
 *
 * Whoever woke the session discharges the promise: the promise is "this session
 * gets a container back", so a qualifying wake from any source satisfies it.
 */
function clearRespawnIntentOnWake(sessionId: string, token: number | undefined): void {
  if (token === undefined) return;
  if (respawnIntents.get(sessionId) !== token) return;
  respawnIntents.delete(sessionId);
  void shadowWrite('stop-intent-clear', () => setStopIntent(sessionId, null, new Date().toISOString()));
}

/**
 * Reconcile the unconsumed `on_wake` rows an ADOPTED session is carrying.
 *
 * E integration (seam4/e-adoption): E owns the CALL SITE and ships this as a
 * no-op stub of the same name and signature, called once per adopted session
 * from `registerAdoptedContainer` after the claim fence and the registry write
 * (its `// F1 hook` marker). At the merge E's stub body is replaced by this
 * one and the call site needs no change.
 *
 * `withExistingMailboxSession`, never the provisioning opener: a session with
 * no mailbox was never adoptable in the first place, and creating one here
 * would author an `outbound.db` the host must never create (invariant I-10).
 * An absent mailbox reads as `undefined` and reconciles nothing.
 *
 * Best-effort by construction. Adoption runs before every wake source at boot,
 * so one session whose inbound DB cannot be read must not abort the pass for
 * every other survivor; the cost of the failure is a stale note, and the sweep
 * has its own paths for that.
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
 * Honor stop intents that outlived their process.
 *
 * A kill-with-respawn used to live only in a volatile `onExit` callback: a host
 * dying between the kill and the respawn forgot the restart entirely. The
 * durable `respawn_after_stop` row is consumed here at startup — a session
 * whose container is still up gets its kill re-issued with the respawn
 * re-armed; one without a container gets the respawn directly. The intent
 * clears only once the respawn wake actually succeeds, so a failed wake is
 * retried at the next startup while the sweep retries it sooner.
 *
 * A plain `'stop'` intent is honoured by the time this runs — by the process
 * exit that recorded it, by the boot door, or by the wake that later gave the
 * session a container again, which never touches the row — so every plain
 * row this pass reads is cleared after the respawn promises are handled
 * (#474). Left alone, the rows accumulate one per session and the table stops
 * being evidence of anything. A session still awaiting claim-fenced adoption
 * keeps its row: its container is alive and not yet re-fenced.
 *
 * `wake` and `hasContainer` are injected with their production defaults. The
 * second exists because the branch it selects is the one an interrupted restart
 * takes, and a unit test cannot put a container into the registry without a
 * container runtime; both are `activeContainers` reads in production.
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
      // The session's container is alive but not yet re-fenced; acting on the
      // intent now could kill or respawn the wrong incarnation. The row stays
      // for the next recovery pass.
      log.warn('Deferring stop intent — session awaits claim-fenced adoption', { sessionId: intent.session_id });
      continue;
    }
    const session = await getSession(intent.session_id);
    // `unwakeableReason`, not a `status` test: `archiveSessionById` stamps only
    // `archived_at` and leaves `status` reading `active`, so an archive-only
    // close looks recoverable to a status check while `wakeContainer` refuses
    // it on the same axis. The intent would then never clear and never fire —
    // a row this pass rereads, and declines, at every boot forever.
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
      // The kill never completed — the container outlived the host that
      // ordered it. Re-issue the kill with the respawn re-armed.
      log.info('Re-issuing interrupted restart', { sessionId: session.id });
      killContainer(session.id, 'restart-intent-recovery', () => void respawn(), 'respawn_after_stop');
    } else {
      await respawn();
    }
  }
  await clearHonouredStopIntents(intents, hasContainer);
}

/**
 * Clear the plain `'stop'` rows the boot pass read, in one conditional write
 * (#474). Each row is matched on the value AND the `updated_at` that was read,
 * so only the row version the pass saw is cleared: a kill that re-armed the
 * row to `respawn_after_stop` since, or recorded a fresh `'stop'` for the same
 * session (a thread close landing while an earlier respawn was awaited), wrote
 * a newer stamp and is left for the next boot. Never a row whose session is
 * pending adoption.
 *
 * A plain row whose session was ADOPTED at this boot — its container is still
 * running — is a STALE request: the host died between recording the stop and
 * issuing it, and the kill's reason (an idle reap, a ceiling, a cancel) may no
 * longer hold. It is cleared like the rest, named on its own line, and never
 * acted on: the sweep re-issues a kill on its own evidence if one is still
 * warranted. `respawn_after_stop` rows keep the honour path above.
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
    // Bounded statements: one `(session_id, updated_at)` pair costs two bound
    // variables, and one statement over an install's whole backlog would trip
    // SQLite's bound-variable limit — then clear nothing, at every boot. The
    // chunks run inside one transaction so the clear is all-or-nothing, and a
    // failure is a WARN with the count, never a swallowed shadow write.
    const now = new Date().toISOString();
    // `RETURNING session_id` names the rows the conditional UPDATE actually
    // touched, which is a strict subset of `honoured`: a row rewritten since
    // the read carries a newer stamp and is skipped. The per-session lines
    // below are driven by that subset, so a line never claims a clear that did
    // not happen (#501). Row count and `changes` are the same number here, so
    // the aggregate `cleared` count is unchanged.
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
  // Logged whenever a plain row was read, so a boot that deferred every one
  // of them reads as such rather than as a boot that had nothing to clear.
  log.info('Cleared honoured stop intents at startup', {
    cleared,
    deferredPendingAdoption: pending.length,
  });
}

/**
 * The error a spawn should abort with when a kill was requested mid-wake.
 *
 * Consulted at BOTH points a spawn can still be stopped: once at the reserved
 * spawn boundary, before any of the preparation that writes to disk, and again
 * as the last word before `docker run`. Everything between those two awaits, so
 * one check cannot cover both — the same after-every-await discipline the rest
 * of this file follows.
 */
function pendingKillCancellation(sessionId: string): Error | null {
  const pending = pendingKills.get(sessionId);
  return pending ? new Error(`Container spawn cancelled by a kill request: ${pending.reason}`) : null;
}

/**
 * Settle a kill request recorded while the session was spawning.
 *
 * Called from `trackWake`'s completion, which is the ONE place every wake ends
 * — cancelled at the pre-spawn check, failed on admission or a lease, or
 * succeeded. Putting it there rather than at the cancellation point means a
 * wake that dies before ever reaching that point still settles the request,
 * instead of leaving a caller waiting on an `onExit` that can never come.
 */
function settlePendingKill(sessionId: string): void {
  const pending = pendingKills.get(sessionId);
  if (!pending) return;
  // A second wake is already in flight for this session. The request is against
  // the SESSION, not one attempt, so leave it for that wake to settle.
  if (isContainerSpawning(sessionId)) return;
  pendingKills.delete(sessionId);
  if (activeContainers.has(sessionId)) {
    // The wake got a process registered before the request could stop it. Kill
    // it now; the callbacks ride the real process exit, as they would have if
    // the request had arrived a moment later.
    stopRunningContainer(sessionId, pending.reason, pending.onExit);
    return;
  }
  // No container was ever started — but the wake may still be QUEUED. The
  // memory-admission controller keeps a queued payload after the wake promise
  // settles, so firing the exit work here without cancelling it would let a
  // caller clear and archive the session as final, and a later reservation
  // release would then drain the queue and spawn into it. `archiveSessionById`
  // sets only `archived_at`, so `sessionStillActive` would not catch that
  // spawn either: the row is still `active`.
  cancelMemoryAdmission(sessionId);
  // There is no process close to ride, so the exit work runs now — the
  // caller's contract is "this session has no container any more", and with the
  // queue cleared that is now true rather than nearly true.
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
 * Door 1 of host shutdown (plan §4.3.5): close the spawn path, leave every
 * running container alone.
 *
 * Replaces `stopAllContainers()` on the shutdown path. It keeps the two things
 * the shutdown flag actually buys — `containerShutdownInProgress`, which every
 * spawn re-checks up to the last word before `docker run`, and the memory
 * admission controller's shutdown, which drops its queue — and then waits only
 * for wakes still IN FLIGHT to settle, bounded by the grace period, so no
 * spawn can slip in after the snapshot. Containers already running are what
 * the next host adopts (`adoptRunningSessions`); stopping them here is the
 * per-restart interruption this seam removes. The unit file's `KillMode=mixed`
 * and the removal of its `ExecStop` are the other two doors — without those,
 * systemd still kills the client children and their containers with them.
 *
 * Returns what was left running, for the operator log and for the restart
 * warning's stopping set (series G): under this door that set is empty.
 */
/**
 * The sessions `beginContainerShutdown()` will stop, computed without stopping
 * anything — the restart warning's input (series G), asked BEFORE the door
 * runs so the note is in place before a container dies.
 *
 * Under door 1 this is the empty set: every running container is left for the
 * next host to adopt. Until the unit-file doors land, systemd's `ExecStop`
 * sweep still stops those containers after this process exits and they get no
 * note — accepted, because the three doors ship on the same restart (plan §7)
 * and a warn sized to `ExecStop` would be a warn for every session on every
 * restart thereafter.
 */
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
 * Stop every active container synchronously at host shutdown.
 *
 * NO LONGER on the shutdown path (plan §4.3.5, door 1): `beginContainerShutdown`
 * replaced it so containers survive a host restart and are adopted by the next
 * process. Kept exported, with its tests, as the rollback path — a build
 * reverted onto a unit that still stops nothing needs something that does —
 * and it is on the dead-code kill list for the day that rollback is no longer
 * plausible. Its pre-E rationale, for that reader:
 *
 * Without it, child container subprocesses lingered in the cgroup after the
 * parent exited and systemd stalled for `TimeoutStopSec` on every restart
 * before SIGKILLing them. v1 wired this into `GroupQueue.shutdown`; v2 lost it
 * during the v1→v2 rewrite and the host lingered similarly.
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
      if (channelHasExited(entry.channel)) {
        resolve();
        return;
      }
      channelOnClose(entry.channel, () => resolve());
    });
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
  // Hard-kill anything still tracked after the grace period.
  for (const [sessionId, entry] of activeContainers.entries()) {
    log.warn('Container did not exit within grace period; SIGKILL', {
      sessionId,
      containerName: entry.containerName,
    });
    channelKillFallback(entry, sessionId);
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
  /**
   * True when the OAuth set came from a per-group `<BASE>_<FOLDER>` scope
   * rather than the global pool. Slots are forwarded under their unscoped
   * `_N` names either way, so this flag is the ONLY thing that distinguishes
   * "global slot 2" from "this group's own slot 2" — different Anthropic
   * accounts whose rate-limit windows share no denominator.
   */
  oauthScoped: boolean;
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
    oauthScoped: oauth.scoped,
  };
}

/**
 * Wiki actors may receive model credentials and nothing else. Prefer the
 * subscription token set when both supported families are configured, then
 * fall back to the API-key rotation set.
 */
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
): { primary?: string; fallbacks: { index: number; value: string }[]; scoped: boolean } {
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

  // Last resort: when even the recovered view has no real `<base>` primary
  // (only numbered siblings exist — e.g. `onecli run --` placeholder + real
  // `_2`/`_3` in .env), promote the first sibling so the container's rotation
  // pool stays the same size. Without this, container-runner's `if (hostOauth)`
  // gate skips forwarding fallbacks entirely and non-scoped groups silently
  // lose their rotation pool, collapsing to OneCLI vault single-token mode.
  if (!primary && fallbacks.length > 0) {
    const promoted = fallbacks.shift()!;
    return { primary: promoted.value, fallbacks, scoped: false };
  }
  return { primary, fallbacks, scoped: false };
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
/**
 * The snapshot's bytes, rendered from the AWAITED capabilities. Split out so a
 * test can prove the await: `JSON.stringify` of a Promise is `{}` and no lint
 * rule sees it (seam-3 async-hazard class), so the proof is behavioural.
 */
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

/**
 * Resolve the scoped credentials emitted into a container at spawn. An
 * explicit gitIdentity is deliberately narrower than credentialFolder: it
 * replaces only Git attribution while every other credential keeps its
 * existing lookup order.
 */
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

// Canonical definition moved to db/container-configs.ts so light consumers
// (router flag parsing) don't import this module, which most of the test
// suite factory-mocks. Re-exported here for existing import sites.
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
 * Read-only mounts for a group's per-channel operating instructions —
 * `groups/<folder>/channel-instructions/*.md` at `/workspace/channel-instructions`.
 * Selected per wiring through `messaging_group_agents.instructions_profile`;
 * a SEPARATE layer from tone, which stays voice-only.
 *
 * Mounted FILE BY FILE rather than as one directory, and that is the whole
 * trick. Workgroup siblings share one rule set by symlink (each sibling group
 * points at the owning group's channel-instructions/<name>.md),
 * and a per-file symlink cannot survive a directory bind here: the mount sits
 * at /workspace/channel-instructions, two levels from container root, while
 * its host source sits at groups/<folder>/channel-instructions, three levels
 * from the project root — so a relative link like
 * ../../<owner>/channel-instructions/<name>.md resolves to a different place on
 * each side and dangles inside the container. Resolving host-side and binding
 * the real file at a literal destination sidesteps that entirely, and matches
 * how standing-instructions.md is already shared: the host resolves that one
 * host-side too (readGroupPersona), never in the container. A directory-level
 * symlink works as well, since realpathSync covers both shapes.
 *
 * SECURITY: same boundary as the symlink overlay in buildMounts — the group
 * dir is mounted RW, so an agent could plant
 * channel-instructions/x.md -> /etc/shadow and have the host bind it into its
 * own always-on prompt. `isAllowedTarget` must be the overlay allowlist (own
 * group dir, workgroup siblings, workgroup shared tree); anything resolving
 * outside is skipped loudly rather than mounted.
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
      // Dangling link or vanished file — nothing to bind, and a spawn must
      // not fail over a stale entry in an advisory directory.
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

/**
 * One line per synchronous stage of a spawn, so the next stall can be
 * attributed without another sampling session.
 *
 * #315 cost a day of investigation because the whole window between waking a
 * container and loading the mount allowlist emitted no logs at all — roughly
 * 1,450 lines of prologue, ending at the first OneCLI line, which is why the
 * OneCLI path was blamed for a block that had already finished by then.
 * Unconditional and unsampled: a stage that only stalls occasionally is
 * exactly the one a sampled log would miss.
 */
function logSpawnStage(stage: string, startedAt: number): void {
  log.info('Spawn stage timing', { stage, ms: Date.now() - startedAt });
}

export async function buildMounts(
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
): Promise<VolumeMount[]> {
  const projectRoot = process.cwd();
  // This value was reconciled under the spawn lock. It is the authority for
  // both cross-workgroup policy and the ordinary workgroup mounts below.
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
  // The policy chooses *which* registered roots may be offered. The existing
  // operator allowlist remains the final host-path gate, including its blocked
  // patterns and realpath checks. A policy grant can therefore never bypass it.
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

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its
  // own — a capability, never a provider name. See provider-container-registry.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    // Sync skill symlinks based on container.json selection before mounting.
    const skillSymlinksStartedAt = Date.now();
    syncSkillSymlinks(claudeDir, containerConfig);
    logSpawnStage('skill-symlinks', skillSymlinksStartedAt);

    // Worker subagent defs (orchestrator mode) — Claude-only: other providers
    // don't read ~/.claude/agents, and the defs' frontmatter is Claude-format.
    // Best-effort: the roster is optional, a copy failure must not abort the
    // spawn (pending messages would retry with no container at all).
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

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
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
  // signaling that rides on inbound.db.
  //
  // A FILE-level read-only overlay is NOT sufficient, and believing it was is
  // what #749 exploited. The overlay covers the file; SQLite's rollback
  // journal is a SIBLING PATH, and this parent mount is read-write, so a
  // container could create `/workspace/inbound.db-journal` beside it. A
  // journal carries no binding to its database's identity, so the host
  // replayed the container's hand-built journal as a HOT journal on its next
  // read-write open and wrote attacker-chosen pages into the host-owned
  // database — a forged `delivered` row, proven by the proof of concept on
  // #735.
  //
  // So the host keeps inbound.db in `<session>/.host/` and that DIRECTORY is
  // overlaid read-only below. SQLite only ever creates `-journal`/`-wal`/
  // `-shm` in the database's own directory, so there is no sibling path left
  // outside the protection. See src/modules/mailbox/host-inbound.ts.
  //
  // The SDK-level `readonly: true` open in container/agent-runner/src/db/
  // connection.ts is belt and suspenders. The mounts are the real boundary.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });
  // The runner's immutable startup context, host-owned and outside the
  // agent-writable session directory. spawnContainer writes it just after
  // writeSessionRouting, before this runs, so the bind source always exists.
  mounts.push({
    hostPath: sessionContextPath(agentGroup.id, session.id),
    containerPath: '/app/.nanoclaw-session.json',
    readonly: true,
  });
  // Move this session's inbound.db under `<session>/.host/` before the mounts
  // are built, and REFUSE THE SPAWN if it is not host-owned afterwards. A
  // container is the only thing that can plant a journal, so this is the seam
  // where the transitional legacy-path fallback in `resolveInboundDbPath` must
  // stop: no container ever runs against a session whose database still sits
  // in the directory it can write. Fail closed — a spawn that cannot migrate
  // retries rather than coming up unprotected (#749).
  await migrateInboundDbToHostDir(sessDir, { agentGroupId: agentGroup.id, sessionId: session.id });
  assertHostOwnedInboundDb(sessDir, session.id);
  mounts.push(...hostInboundMounts(sessDir));

  // Repository scope is derived by one canonical work-unit resolver.
  // Same-topic siblings therefore share a checkout; different topics receive
  // different roots even when they use one repo.
  //
  // Everything from here to the workgroup-mounts stage line below is
  // filesystem work: mkdir, realpath, readdir and lstat across the workgroup,
  // worktree and tombstone trees. Timed as one stage because it is one
  // contiguous run of sync fs calls with no natural seam.
  const workgroupMountsStartedAt = Date.now();
  const repositoryWorkUnit = await resolveSessionRepositoryWorkUnit(session, wgKey);
  const worktrees = topicWorktreesDir(repositoryWorkUnit);
  fs.mkdirSync(worktrees, { recursive: true });
  // Stable agent-facing path plus the exact host path. Git worktree metadata
  // records the latter, so the same pointer works from host and container.
  mounts.push({ hostPath: worktrees, containerPath: '/workspace/worktrees', readonly: false });
  mounts.push({ hostPath: worktrees, containerPath: worktrees, readonly: false });

  // Canonical working trees stay host-only. A linked worktree needs only the
  // common `.git`, origin pin, and one shared kernel-lock inode. All are bound
  // at their exact host paths so no container-relative back-pointer can leak
  // into Git's administrative records.
  //
  // Judged one repository at a time. Discovery's throwing form aborts the
  // whole spawn on the first unusable canonical — and a foreign `commondir`
  // naming a missing directory makes its Git probe exit 128 — so a single
  // tampered or half-migrated `.git` used to stop every container in the
  // workgroup instead of withholding one repository (#669 review).
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
      // The exact worktree left this source topic. Withholding the common Git
      // metadata makes the tombstone a spawn-time capability boundary too,
      // rather than relying only on the create_worktree MCP check.
      continue;
    }
    // A scan-policy repository whose managed hook AND its refuse fallback
    // both failed validation gets every mount withheld (same `continue`
    // shape as the tombstone check above) rather than running with no hook
    // at all — see resolveScanPolicyHooksMount's doc comment for the full
    // fallback order. Computed before the gitDir mount deliberately: a
    // partial withhold (say, gitDir mounted but hooks skipped) would still
    // let an agent push unscanned from that worktree.
    const hooksDecision = resolveScanPolicyHooksMount(repository);
    if (hooksDecision.withhold) {
      continue;
    }
    // The common object/ref/worktree store is writable, but host-executable
    // configuration, hooks, canonical main-worktree HEAD/index, the
    // `commondir` sentinel, and object-alternate escape hatches are immutable
    // overlays. Linked worktrees use their own .git/worktrees/<id>/HEAD and
    // index, so container Git can fetch/commit/push without being able to
    // clobber the host canonical checkout state.
    //
    // Computed before the gitDir mount, like the hooks decision above: a
    // canonical whose commondir is not the sentinel gets every mount withheld
    // (same `continue` shape), never the read-write .git alone.
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
    // Deduped by container path (#666 review B8): two scan-policy
    // repositories in one workgroup would otherwise both resolve to the
    // SAME containerPath (MANAGED_GIT_HOOKS_SCAN_DIR — one host-managed
    // directory for the whole install, not per-repo), and Docker rejects a
    // duplicate bind mount to the same container path.
    for (const mount of hooksDecision.mounts) {
      if (!mounts.some((existing) => existing.containerPath === mount.containerPath)) {
        mounts.push(mount);
      }
    }
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
  // spawn-template.md -> /workspace/workgroup/private-spawn-template.md, a
  // workgroup-shared-fs compat link) are skipped: realpathSync fails on the
  // host because that path doesn't resolve there, and the container's own
  // mount for it makes the symlink work inside the container anyway.
  //
  // SECURITY: the group dir is mounted RW at /workspace/agent, so an agent can
  // plant a symlink here pointing anywhere on the host and it would be
  // RW-mounted into its own container on the next spawn. Only overlay targets
  // that this agent is entitled to see anyway: its own group dir, a sibling
  // group dir in the SAME workgroup, or the workgroup shared tree. Anything
  // else is skipped with a loud warning.
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
    // Docker resolves a mount DESTINATION through the container's own
    // filesystem, and /workspace/agent is this group dir — so a relative
    // symlink that escapes upward redirects the destination out of the group
    // mount and back into the session-dir bind at /workspace (clone-as-codex's
    // `CLAUDE.local.md -> ../<seed>/CLAUDE.local.md` really attaches at
    // /workspace/<seed>/CLAUDE.local.md). runc then creates that parent as
    // ROOT, and host-side session reclaim can never delete it. Declare the
    // path Docker is going to use anyway, so the /workspace stub pre-creation
    // in spawnContainer creates it as the host user first.
    //
    // Derive that path by RESOLUTION, not by inspecting the link text. Two
    // review rounds died on lexical prediction: a `../` prefix test misses
    // `./../sib/X`, and normalizing the raw text still misses an intermediate
    // symlink (`foo -> sub/jump/T` where `sub/jump -> ../../sibling`), which
    // the container resolves but no amount of string work can. `realTarget` is
    // already fully resolved by realpathSync above, so map it back through the
    // container's view: /workspace/agent IS groupDir, therefore GROUPS_DIR is
    // /workspace, and a resolved sibling path is /workspace/<folder>/<rest>.
    // Anything resolving outside those roots was already refused as an
    // out-of-workgroup target, so it never reaches here.
    //
    // An ABSOLUTE raw target is the one case resolution must NOT drive: it
    // names a host path that does not exist inside the container, so nothing
    // there resolves it and Docker attaches at the literal name. Relative
    // targets are the opposite — the container resolves them against
    // /workspace/agent, chains and all — so those derive from realTarget.
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
      // Workgroup shared tree or anything else representable only at its
      // literal name — the stub loop then pre-creates that, which is correct
      // because Docker has no symlink to follow.
      return `/workspace/agent/${entry.name}`;
    };
    mounts.push({
      hostPath: realTarget,
      containerPath: containerPathFor(realTarget),
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

  // Stamped plugin content — nested RO mount, same pattern as container.json
  // just above. Immutable at runtime by the Agent Plugins contract: writes go
  // to plugin-data/, which stays RW via the group mount. initGroupFilesystem
  // creates the dir before mounts are built, so this is unconditional and a
  // group carrying no plugin gets an empty read-only directory. Distinct from
  // the fleet-wide ~/plugins -> /workspace/plugins mount, which is
  // operator-curated and shared by every group.
  const stampedPluginsDir = path.join(groupDir, 'plugins');
  mounts.push({ hostPath: stampedPluginsDir, containerPath: CONTAINER_PLUGINS_DIR, readonly: true });

  // Composer-managed CLAUDE.md — nested RO mount. Regenerated from the
  // shared base + fragments, all INLINED, on every spawn (claude-md-compose.ts);
  // any agent-side write would be clobbered, so enforce read-only. The shared
  // memory tree and standing-instructions source remain RW via the group mount.
  //
  // There used to be a second nested mount here for `.claude-fragments/`
  // (per-fragment files reached through symlinks from the composed doc) plus
  // a `/app/CLAUDE.md` mount backing a `.claude-shared.md` symlink in the
  // group dir. Both are gone: the composer now reads every section straight
  // from its host path and writes it into CLAUDE.md/AGENTS.md directly, so
  // nothing inside the container ever needs those paths.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
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
  logSpawnStage('workgroup-membership', workgroupMembershipStartedAt);

  // Awaited: the projection is rebuilt on a worker thread when its inputs have
  // moved, and skipped entirely when they have not. It used to run
  // synchronously here on every spawn, which parked the host event loop for
  // seconds at a time — the dominant cause of #315. Fail-closed is unchanged:
  // a build that runs and throws aborts the spawn.
  const archiveProjectionStartedAt = Date.now();
  await ensureArchiveProjection(archiveSrc, archiveDst, agentGroup.id, workgroupMemberIds);
  logSpawnStage('archive-projection', archiveProjectionStartedAt);
  mounts.push({ hostPath: archiveDst, containerPath: '/workspace/archive.db', readonly: true });
  // The workgroup's domain wiki, read-only, when the host keeps one (src/workgroup-wiki.ts).
  if (workgroupWiki) mounts.push(workgroupWiki.mount);

  const centralSrc = path.join(DATA_DIR, 'v2.db');
  const centralDst = path.join(sessionDir(agentGroup.id, session.id), 'central.db');
  // Still synchronous and still on the main thread: same pattern as the
  // archive projection but against the 20 MB central DB, so it was never the
  // headline cost. Left alone deliberately, and now measured rather than
  // assumed — see the PR body.
  const centralProjectionStartedAt = Date.now();
  buildCentralProjection(centralSrc, centralDst, agentGroup.id);
  logSpawnStage('central-projection', centralProjectionStartedAt);
  mounts.push({ hostPath: centralDst, containerPath: '/workspace/central.db', readonly: true });

  // Shared agent-runner source — read-only, same code for all groups. This
  // is the boot-time snapshot activated in main.ts (mailbox seam PR 0), not
  // the live checkout — see src/agent-runner-source.ts.
  const agentRunnerSrc = agentRunnerSourcePath();
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

  // Additional mounts from container config. This is where the silent window
  // ends — `validateAdditionalMounts` emits 'Mount allowlist loaded
  // successfully', the first log line after the prologue.
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
    const pluginScopes = loadPluginScopes(); // client plugins mount only in their workgroups
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(pluginsHostDir);
    } catch (err) {
      log.warn('Failed to read ~/plugins directory', { err });
    }
    warnUnmatchedPluginScopes(pluginScopes, entries);
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
          // DELIBERATELY no global-`~/.codex` fallback for `config.toml` /
          // `plugins` when hostCodex is a scoped `~/.codex-<folder>`. 822f1deb
          // added both so a scoped group inherited the host's
          // `[plugins.*]`/`[marketplaces.*]` config and plugin cache; that
          // inheritance is gone (4da9d288 registers plugins fresh from
          // /workspace/plugins, 87b12122 generates the peer config.toml), and
          // this branch is codex-as-peer only, where the runner always
          // redirects CODEX_HOME to /home/node/.codex-runtime. So nothing read
          // them — while as NESTED mounts into an RW bind whose source lacks
          // the entry, runc created both as ROOT in the operator's host
          // `~/.codex-<folder>/`. Pinned by src/provider-surfaces.test.ts.
          mounts.push({ hostPath: hostCodex, containerPath: '/home/node/.codex', readonly: false });
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

  // Host-computed upstreamPin/heldByMerge snapshot for the same audit script.
  // /workspace/project has no `.git` (it's a selective bind-mount allowlist,
  // not a checkout), so the audit's git-based upstream-policy derivation can
  // never run in-container. writeUpstreamPolicySnapshot() runs on the host
  // (host startup + before each /update-container invocation) and writes
  // this file; the container just reads it. See src/container-updates.ts.
  const upstreamPolicySnapshot = path.join(DATA_DIR, 'upstream-policy.json');
  if (fs.existsSync(upstreamPolicySnapshot)) {
    mounts.push({
      hostPath: upstreamPolicySnapshot,
      containerPath: '/workspace/project/.upstream-policy.json',
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

  // Per-channel operating instructions — see channelInstructionsMounts.
  mounts.push(...channelInstructionsMounts(groupDir, isAllowedOverlayTarget, agentGroup.id));

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
  'worker-frontier.md',
  'worker-codex.md',
  // Retired: renamed to worker-high.md so the tier name describes the rung
  // rather than a Claude model (the same def is gpt-5.6-sol on Codex). Listed
  // so groups that already have the old file get it pruned on next spawn.
  'worker-opus.md',
];

/**
 * Copy trunk worker subagent defs (container/agents/*.md) into
 * .claude-shared/agents/ — the container's ~/.claude/agents — so every Claude
 * group gets the native frontier worker. Cross-provider work uses the direct
 * CLI helper, without a wrapper agent. Copies, not symlinks: agent discovery
 * through dangling host symlinks is unverified, and the files are tiny.
 * Trunk is canonical: a managed def absent from the current trunk set is
 * pruned; operator-added defs (never in MANAGED_WORKER_DEFS) are untouched. A
 * group can shadow a trunk def with a same-name file in
 * groups/<folder>/.claude/agents/ (project scope outranks user scope).
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
 * Move every Docker environment assignment out of the process argument vector.
 *
 * A Docker `--env-file` is still visible to the daemon and the container — the
 * host is the authority for both — but a local process listing sees only its
 * opaque 0600 pathname, never OAuth tokens, API keys, proxy credentials or
 * serialized MCP credentials. Preserve entry order so Docker's existing
 * duplicate-key last-wins behavior is unchanged.
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
  // One agent group's `.context` directory is shared by its sessions. Scope
  // stale cleanup to this session so a new concurrent session can never unlink
  // the env file that a different Docker CLI process is still starting with.
  const scope = createHash('sha256').update(sessionScope).digest('hex');
  const filenamePrefix = `.docker-env-${scope}-`;
  // `docker run` reads the file during startup, so an old host may die after
  // creating it but before its close handler can unlink it. A future spawn may
  // remove only this session's opaque leaf names; unlink never follows a
  // hostile symlink. The per-session run claim prevents two live spawns from
  // sharing this scope.
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
  /**
   * Session this container is being spawned for. Stamped as the
   * `nanoclaw-session` label so a boot inventory can map a surviving
   * container back to its session without the in-process registry, which is
   * empty at startup.
   */
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
  /**
   * Messaging group the Slack owner-safety gate judges for this session.
   * Equals `sessionMessagingGroupId` for chat sessions; for a task session it
   * is the series' delivery destination. Kept SEPARATE from
   * `sessionMessagingGroupId` on purpose — a task session is still not "in"
   * that channel for assistant-name, channel-peer, or routing purposes.
   */
  slackSafetyMessagingGroupId?: string | null,
  /**
   * Non-secret runner configuration the registered mailbox contributes
   * (`AgentMailbox.runnerEnvironment`). Empty for the SQLite mailbox — the
   * session DBs are bind-mounted, so there is nothing to configure. Merged
   * first so nothing below can be shadowed by it, matching upstream's
   * spec-composition order.
   */
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
    for (const mount of mounts) {
      if (fs.realpathSync(mount.hostPath) !== mount.hostPath) throw new Error('Wiki runtime mount changed');
      args.push('-v', `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ':ro' : ''}`);
    }
    args.push('--entrypoint', 'bash', CONTAINER_IMAGE, '-c', 'exec /app/entrypoint.sh');
    return args;
  }
  // --init: tini as PID 1 reaps orphaned children (esbuild/gh corpses were
  // accumulating as zombies under bun, which doesn't reap as PID 1) and still
  // forwards signals to the entrypoint, so SIGTERM handling is unchanged.
  const args: string[] = [
    'run',
    '--rm',
    '--init',
    '--name',
    containerName,
    ...containerLabelArgs(agentGroup.id, sessionId, resolvedWgId),
  ];
  args.push(...dockerResourceLimitArgs(containerConfig.resources));
  // Privilege hardening — capabilities and setuid escalation. Resource
  // ceilings came from dockerResourceLimitArgs above; these two builders
  // never emit the same Docker flag.
  args.push(...securityArgs(containerConfig.security));

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  for (const [key, value] of Object.entries(mailboxEnvironment ?? {})) args.push('-e', `${key}=${value}`);
  // A per-group timezone override rides container.json (mirrored there by the
  // ncl write paths). The verdict comes from `effectiveTimezone`, the same
  // predicate `resolveGroupTimezone` applies to the DB row, so the container's
  // POSIX `TZ` and the host's scheduling grid can never disagree about which
  // override is honoured. Anything unconfirmed falls back to the install
  // timezone rather than to UTC, so a hand-edited file can't silently move an
  // agent's clock.
  args.push('-e', `TZ=${effectiveTimezone(containerConfig.timezone)}`);

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
  // fable models that reject non-adaptive thinking.)

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
  //   3. Per-agent container.json — `model`/`effort` (written by `ncl groups
  //      config update`) then the hand-authored `defaultModel`/`defaultEffort`
  //      — applies to every channel wired to this agent unless (2) overrides.
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
    // claudeSpawnEnv applies resolveEffectiveModel: family aliases first (so
    // `opus` keeps tracking DEFAULT_OPUS_MODEL rather than freezing), then
    // pinned short aliases (`opus5`, `opus48`, `sonnet5`, `fable`), then
    // ensureOpus1mSuffix on bare ids. The chat ack calls the same function, so
    // the confirmation the user sees is exactly what lands in
    // ANTHROPIC_DEFAULT_OPUS_MODEL.
    // Both the resolution and the `-e` strings themselves live in
    // claude-spawn-defaults.ts so they can be executed by a test;
    // buildContainerArgs cannot (live `onecli` shell calls). Emits the three
    // ANTHROPIC_DEFAULT_<FAMILY>_MODEL aliases always, and
    // NANOCLAW_EFFORT_OVERRIDE only when a channel wiring or the group's
    // container.json actually configures one — absent means the claude
    // provider applies its per-model-family default.
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

  // Per-channel operating instructions — a SEPARATE always-on layer from tone
  // above, which stays voice-only. No container.json fallback on purpose: the
  // group-wide equivalent is standing-instructions.md, already in every
  // prompt, so a second group-level slot here would just be a duplicate with
  // different precedence. Resolution is per-wiring or nothing. Profile content
  // injection happens container-side in agent-runner/src/index.ts, ahead of
  // the tone block, from the /workspace/channel-instructions mount.
  const instructionsProfile = channelDefaults?.channelInstructionsProfile ?? null;
  if (instructionsProfile) {
    args.push('-e', `NANOCLAW_INSTRUCTIONS_PROFILE=${instructionsProfile}`);
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
  // Pre-task script timeout override — forwarded CLAMPED (config.TASK_SCRIPT_TIMEOUT_MS),
  // unconditionally: when unset it is 120_000, identical to the container
  // default, so an unconfigured spawn is behaviorally unchanged. The gate
  // cannot be `process.env` alone — .env-only values never reach it at this
  // point (config.ts's import-order trap), and silently dropping a documented
  // operator override is what reintroduced the original 30s-kill failure.
  args.push('-e', `NANOCLAW_TASK_SCRIPT_TIMEOUT_MS=${TASK_SCRIPT_TIMEOUT_MS}`);
  // Points readUpstreamPolicy's snapshot fallback at the mounted file above
  // regardless of --repo. Load-bearing for the post-approval re-audit: the
  // agent reruns `container-updates.ts audit --repo <writable clone>`, and
  // that clone has no `upstream` remote either (it's a fresh git clone of
  // origin), so without this override the clone-relative default path
  // (`<clone>/.upstream-policy.json`) would never resolve to this file.
  args.push('-e', `NANOCLAW_UPSTREAM_POLICY=/workspace/project/.upstream-policy.json`);
  if (repositoryWorkUnit) {
    args.push('-e', `NANOCLAW_HOST_DATA_DIR=${DATA_DIR}`);
    args.push('-e', `NANOCLAW_HOST_TOPIC_WORKTREES_DIR=${topicWorktreesDir(repositoryWorkUnit)}`);
    args.push('-e', `NANOCLAW_WORK_UNIT_KEY=${repositoryWorkUnit.key}`);
    args.push('-e', `${CHECKOUT_MODE_ENV}=${effectiveCheckoutMode()}`);
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
    const peers = await getChannelPeers(sessionMessagingGroupId, agentGroup.id);
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
    // this agent by a shorthand nickname while Slack routes it as a different
    // bot handle (say `@beacon-codex`). Supplying
    // both aliases prevents the model from treating its own platform mention
    // as a request for a sibling.
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
    // Which credential set those slots came from. Scoped tokens are forwarded
    // under the same unscoped `_N` names as globals, so without this the
    // container cannot tell its slot 2 from the global pool's slot 2 — and
    // rate-limit utilization sampled against them is not comparable (see
    // rate_limit_samples in the container's outbound.db).
    args.push('-e', `NANOCLAW_OAUTH_CREDENTIAL_SET=${auth.oauthScoped ? `group:${credentialFolder}` : 'global'}`);
    // Operator-declared lane per slot (`<slot>:<lane>,...`). The container
    // reads this from its own env (see laneForSlot in providers/claude.ts),
    // and there is NO generic env passthrough into containers — the only one
    // is prefix-limited to RENDER_PG_/RENDER_REDIS_URL_ below. Without this
    // explicit forward the variable is simply undefined inside every
    // container and `lane` stays NULL forever no matter what .env says, with
    // no error anywhere to show for it. Forwarded only when declared, so an
    // install that never sets it sends nothing.
    const oauthLanes = process.env.CLAUDE_CODE_OAUTH_LANES;
    if (oauthLanes) args.push('-e', `CLAUDE_CODE_OAUTH_LANES=${oauthLanes}`);
    // Declare the scopes the forwarded token carries. NOT cosmetic: when the
    // CLI authenticates from CLAUDE_CODE_OAUTH_TOKEN it has no credential
    // record to read scopes from, so it synthesizes one and defaults scopes to
    // ["user:inference"] alone. Plan utilization is gated behind
    // `user:profile` — with the default the CLI reports
    // `rate_limits_available: false` and never even attempts the lookup, so
    // every usage_pull sample lands with a NULL utilization. Verified against
    // the shipped 2.1.219 binary and reproduced end to end: same token, same
    // proxy, scopes undeclared -> available:false / no windows; declared ->
    // available:true / five_hour + seven_day readings.
    args.push('-e', 'CLAUDE_CODE_OAUTH_SCOPES=user:inference user:profile');
  }

  // GitHub token for git-over-HTTPS + `gh` CLI. Per-agent-group: resolves
  // from container.json `githubTokenEnv`, then from
  // `GITHUB_TOKEN_<FOLDER_UPPER>`, then falls back to `GITHUB_TOKEN`.
  // OneCLI's proxy model doesn't fit git auth — we pass the real token.
  const ghToken = await resolveGitHubTokenForContainer(credentialFolder, containerConfig);
  if (ghToken) {
    // BY REFERENCE by default: the token is written to a per-group file that
    // is mounted read-only, and only the PATH goes into the container spec, so
    // `docker inspect` and the spawn argv carry no credential value. Because
    // the host rewrites that file in place (host sweep → refreshGroupGitHubTokenFiles),
    // a container that outlives its ~1h App token now picks up the re-mint on
    // its next git/gh call instead of dying with a frozen env. `GITHUB_TOKEN_IN_ENV=1`
    // restores value-forwarding for one release. See github-token-file.ts.
    const ghPlan = planGitHubTokenSpawn({ agentGroupId: agentGroup.id, token: ghToken });
    if (ghPlan.mount) {
      mounts.push(ghPlan.mount);
      // Re-resolution closure for the sweep. Registered per spawn so the sweep
      // rewrites the file using this group's own lookup order (githubTokenEnv →
      // scoped → global → App mint), not a host-wide default. Only registered
      // when a file was actually mounted — under the rollback flag there is
      // nothing on disk to keep fresh.
      registerGroupTokenRefresher(agentGroup.id, () =>
        resolveGitHubTokenForContainer(credentialFolder, containerConfig),
      );
    }
    args.push(...ghPlan.envArgs);
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
  // `<BASE>_<FOLDER_UPPER>` → `<BASE>` and is injected if found. An explicit
  // agent Git identity intentionally wins only for Git's four attribution
  // variables; every other scoped credential keeps its established lookup.
  for (const [base, v] of Object.entries(resolveScopedCredentialEnv(containerConfig, credentialFolder))) {
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

  // Pin pnpm's store to the group mount, for every provider. With no store-dir
  // set, pnpm hardlink-tests against $HOME (the image overlay layer — a
  // different device from any bind mount) and falls back to the nearest
  // bind-mount boundary it can find, which was scattering duplicate
  // multi-hundred-MB stores across every topic worktree and group dir.
  // /workspace/agent (groups/<folder>, mounted unconditionally above) is the
  // right target: same host filesystem as every workspace mount so hardlinks
  // work, and shared per GROUP rather than the flag-gated, ephemeral-when-off
  // /workspace/workgroup. Both env forms are set — pnpm 10 (current pin) and
  // pnpm 11 both honor `npm_config_*`, and `pnpm_config_*` is the
  // pnpm-specific form going forward — and env config outranks any .npmrc an
  // agent or repo may carry.
  args.push('-e', 'npm_config_store_dir=/workspace/agent/.pnpm-store');
  args.push('-e', 'pnpm_config_store_dir=/workspace/agent/.pnpm-store');

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
        ? await getWorkgroupOnecliSecretsById(resolvedWgId)
        : await getWorkgroupOnecliSecrets(agentGroup.id);
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

      // Awaited: these hit the OneCLI control API. They were synchronous
      // (execFileSync curl) until #315, which parked the host event loop for
      // the full round trip on every spawn. Ordering with the mount/env
      // assembly below is unchanged — the whole block is sequential inside
      // this one async function, and `args` is local to this call.
      await ensureOnecliAgent({
        name:
          identity === agentIdentifier ? agentGroup.name : `${agentGroup.name} (no Slack — non-owner-safe sessions)`,
        identifier: identity,
      });
      await applyOnecliSecrets(identity, effectiveSecrets);
      effectiveIdentifier = identity;
    }
    // Instrumented + retried once for the proved-transient class; see
    // `src/onecli-apply.ts` for why one retry and why only for that class.
    // A deterministic 4xx still throws straight out of here.
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
  // Single definition, shared with the GitHub token file lane so the two
  // cannot drift — see containerRunsAsHostUser.
  if (containerRunsAsHostUser(hostUid)) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Pre-create every nested /workspace mountpoint host-side as the host user.
  // /workspace is itself a bind of the session dir, so when Docker creates a
  // missing nested mountpoint (/workspace/agent, /workspace/worktrees,
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
      url: 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa,agent_run',
    };
  }
  if (canInject('pocket')) {
    // Auth header injected by the OneCLI gateway proxy at request time
    // (vault entry "Pocket" → public.heypocketai.com). Universal — the
    // operator's physical meeting-recorder device, available to every group
    // by default.
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
    slackUserTokenAllowed = await withCentralSync(
      () =>
        withRawDb((db) =>
          canUseSlackUserToken(
            db,
            agentGroup.id,
            slackSafetyMessagingGroupId ?? null,
            containerConfig.slack_user_token,
          ),
        ),
      'slack user-token gate',
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
        slackSafetyMessagingGroupId: slackSafetyMessagingGroupId ?? null,
        folder: agentGroup.folder,
        reason: slackSafetyMessagingGroupId == null ? 'no_messaging_group' : 'not_owner_dm_and_not_in_allowlist',
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

/**
 * Build the container SCOPE labels: the install label every container has
 * always carried, plus the four scope labels a boot inventory reads to decide
 * what a surviving container belongs to. Pure and exported for the same
 * reason `securityArgs` and `dockerResourceLimitArgs` are — the flag list is
 * testable without spawning, and only `buildContainerArgs` spreads it.
 *
 * `workgroupId` emits an EMPTY value rather than dropping the label, so
 * "this session has no workgroup" and "this container predates the labels"
 * stay distinguishable at the inventory.
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
 * Build the container PRIVILEGE hardening flags: drop every Linux capability
 * and forbid setuid escalation, overridable per-group via container.json
 * `security`. Defaults come from `resolveContainerSecurity`, the same
 * resolver `ncl groups config get` reports, so the audit and the spawn can
 * never disagree. Pure, so precedence is unit-testable without spawning.
 *
 * Resource ceilings (--memory, --pids-limit, --cpus) deliberately do NOT
 * belong here — `dockerResourceLimitArgs` below owns those, driven by
 * container.json `resources`. Emitting a flag from both builders is how a
 * spawn ends up with two contradictory values for the same Docker option.
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
  await updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
