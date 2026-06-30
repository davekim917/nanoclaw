/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { getHostCapabilities } from './capabilities.js';
import {
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_INSTALL_LABEL,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_MEMORY_RESERVATION,
  CONTAINER_MEMORY_SWAP_LIMIT,
  CONTAINER_PIDS_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
  WORKGROUP_SHARED_FS,
} from './config.js';
import {
  getRecallScope,
  readContainerConfig,
  validateMcpServers,
  writeContainerConfig,
  type ContainerConfig,
  type McpServerConfig,
  type RecallScope,
} from './container-config.js';
import { getContainerConfig, resolveProviderName } from './db/container-configs.js';
import { updateContainerConfigScalars, updateContainerConfigJson } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { checkAgentRunnerDepsDrift } from './agent-runner-image-check.js';
import { EGRESS_NETWORK, egressNetworkArgs, ensureEgressNetwork } from './egress-lockdown.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { ensureOpus1mSuffix } from './flag-parser.js';
import { readEnvFileMatching } from './env.js';
import { getAgentGroup, getWorkgroupOnecliSecrets } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { findSessionByAgentGroupAndMessagingGroup } from './db/sessions.js';
import { buildArchiveProjection, buildCentralProjection } from './db/per-agent-projections.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { applyOnecliSecrets, mergeWorkgroupAndGroupSecrets, slackUserTokenSecrets } from './onecli-secrets.js';
import { workgroupSharedDir, WORKGROUP_CONTAINER_PATH } from './modules/workgroup/shared-dirs.js';
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
import { getSessionClaudeMounts } from './session-claude-mounts.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  threadWorktreeDir,
  writeSessionRouting,
} from './session-manager.js';
import { assertStorageAdmission } from './storage-manager.js';
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
const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 });

// Default model + effort. SINGLE source of truth for what containers
// resolve `opus` / `sonnet` / `haiku` aliases to and what reasoning
// effort they use when the user hasn't specified anything.
//
// To change the install-wide default, edit these constants. Per-channel
// (messaging_group_agents.default_model/effort) and per-group
// (container.json defaultModel/defaultEffort) layers can still override.
// Per-session flags (-m / -e) and sticky config override on top of those.
const DEFAULT_OPUS_MODEL = 'claude-opus-4-8[1m]';
const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
// (DEFAULT_EFFORT removed 2026-06-10 — effort defaults are per-model-family
// in the claude provider; NANOCLAW_EFFORT_OVERRIDE is operator-override-only.)

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string; spawnedAt: number }>();

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

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
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
 * Race / spawn-order safety: parent lookup is by FOLDER (not by sibling id),
 * so spawning illie-codex before illie still resolves to illie's id once
 * illie's agent_groups row exists. If the parent row doesn't exist yet, we
 * fall back to the calling group's own id (workgroup-of-1) so the container
 * can still spawn; this is the CD-4 spawn-order race documented in
 * docs/workgroups.md § Staleness window. (Codex P1 catch on PR #107.)
 */
export function reconcileWorkgroupAtSpawn(
  db: Database.Database,
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  containerConfig: Pick<ContainerConfig, 'workgroup_id'>,
): void {
  // Determine declared workgroup_id with the precedence above.
  let declared: string;
  if (containerConfig.workgroup_id !== undefined) {
    declared = containerConfig.workgroup_id;
  } else {
    const existing = db.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ? LIMIT 1').get(agentGroup.id) as
      | { workgroup_id: string | null }
      | undefined;
    declared = existing?.workgroup_id ?? agentGroup.folder;
  }

  // Look up the seed agent_groups row for the declared workgroup id (folder).
  const parentRow = db.prepare('SELECT id FROM agent_groups WHERE folder = ? LIMIT 1').get(declared) as
    | { id: string }
    | undefined;
  const mnemonStoreId = parentRow?.id ?? agentGroup.id;

  db.transaction(() => {
    // Insert workgroup row idempotently. ON CONFLICT DO NOTHING preserves any
    // mnemon_store_id already set by a prior spawn or migration 036.
    db.prepare(
      `
      INSERT INTO workgroups (id, display_name, onecli_secrets, mnemon_store_id, created_at)
      VALUES (?, ?, '[]', ?, datetime('now'))
      ON CONFLICT(id) DO NOTHING
    `,
    ).run(declared, declared, mnemonStoreId);

    // Atomic conditional update: only update if the column is NULL or stale.
    db.prepare(
      `
      UPDATE agent_groups SET workgroup_id = ?
      WHERE id = ? AND (workgroup_id IS NULL OR workgroup_id != ?)
    `,
    ).run(declared, agentGroup.id, declared);
  })();
}

/**
 * Pattern for a valid mnemon store identifier. Must align with the in-container
 * mnemon-wrapper regex (`container/mnemon-wrapper.sh:12`: `^[a-zA-Z0-9_-]+$`),
 * with an added 128-char length cap as defense-in-depth. Crucially REJECTS:
 *   - `..` (path traversal — the `.` class char is not allowed at all)
 *   - `/` or `\` (path separators)
 *   - empty / whitespace-only strings
 *   - shell metacharacters that could break --store arg parsing
 *
 * Why host-side validation: even though .env write is already privileged, an
 * unvalidated env override would let a `.env` line like
 * `MNEMON_STORE_illie_codex=../../.ssh` escape ~/.mnemon/data and bind-mount
 * an arbitrary host path RW into the container before the container wrapper
 * could reject it. Validate at the host resolution point so every caller
 * (env mount, container env, write redirection) is protected before any
 * filesystem operation runs.
 *
 * Why align with the container wrapper (not stricter or looser): a value
 * accepted by the host but rejected by the wrapper produces a silent recall
 * outage — mount succeeds, env is set, then every `mnemon recall` invocation
 * inside the container exits with code 2 and returns empty. The two patterns
 * must agree. (Codex P2 catches on PR #107.)
 */
const STORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidStoreId(value: string): boolean {
  return STORE_ID_PATTERN.test(value);
}

/**
 * Resolve the MNEMON_STORE value for a container spawn.
 *
 * Precedence (most specific wins):
 *   1. MNEMON_STORE_<folder> env override (case-insensitive fallback per PR #105)
 *   2. If recallScope === 'self': agentGroup.id (honors explicit isolation opt-out)
 *   3. workgroups.mnemon_store_id for this agent's workgroup
 *   4. agentGroup.id (graceful fallback when no workgroup row exists)
 *
 * The `recallScope` parameter controls behavior at step 2: when a group has
 * declared `memory.recall_scope: 'self'` for isolation, both the mount and the
 * in-container `MNEMON_STORE` env must point at the group's own store, not the
 * workgroup canonical — otherwise in-container `mnemon recall` reads the
 * shared store, bypassing the documented self-only contract. The host-side
 * recall-injection path already honors recall_scope; this keeps the
 * container-side symmetric. (Codex P2 catch on PR #107.)
 *
 * Throws if any source produces a value that fails {@link isValidStoreId} —
 * fail-closed posture prevents an .env mistake or attacker-controlled path
 * traversal from escaping `~/.mnemon/data` via the mount or container env.
 */
export function resolveMnemonStore(
  db: Database.Database,
  agentGroup: Pick<AgentGroup, 'id' | 'folder'>,
  env: NodeJS.ProcessEnv = process.env,
  recallScope?: RecallScope,
): string {
  const scopedKey = `MNEMON_STORE_${agentGroup.folder.replace(/-/g, '_')}`;
  const envOverride = env[scopedKey] ?? env[scopedKey.toUpperCase()];
  if (envOverride) {
    if (!isValidStoreId(envOverride)) {
      throw new Error(
        `resolveMnemonStore: ${scopedKey} value is not a valid store id (got ${JSON.stringify(envOverride)}). ` +
          `Must match /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/ with no '..' sequences.`,
      );
    }
    return envOverride;
  }

  if (recallScope === 'self') {
    if (!isValidStoreId(agentGroup.id)) {
      throw new Error(
        `resolveMnemonStore: agent_group.id is not a valid store id (got ${JSON.stringify(agentGroup.id)}).`,
      );
    }
    return agentGroup.id;
  }

  const wgRow = db
    .prepare(
      `SELECT w.mnemon_store_id FROM workgroups w
       JOIN agent_groups a ON a.workgroup_id = w.id
       WHERE a.id = ?`,
    )
    .get(agentGroup.id) as { mnemon_store_id: string | null } | undefined;

  const resolved = wgRow?.mnemon_store_id ?? agentGroup.id;
  if (!isValidStoreId(resolved)) {
    throw new Error(
      `resolveMnemonStore: resolved store id is invalid (got ${JSON.stringify(resolved)} for agent_group ${agentGroup.id}). ` +
        `Workgroup row or agent_groups.id has an unexpected shape.`,
    );
  }
  return resolved;
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
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }

  const storageAdmission = assertStorageAdmission({ isContainerRunning });
  if (!storageAdmission.allowed) {
    log.warn('Container wake deferred — disk usage remains above storage admission threshold', {
      sessionId: session.id,
      reason: storageAdmission.reason,
      usagePct:
        storageAdmission.report.filesystem.after?.usagePct ?? storageAdmission.report.filesystem.before?.usagePct,
      admissionRefusePct: storageAdmission.report.policy.admissionRefusePct,
      estimatedReclaimableMb: Math.round(storageAdmission.report.estimatedReclaimableBytes / 1024 / 1024),
      actualReclaimedMb: Math.round(storageAdmission.report.filesystem.actualReclaimedBytes / 1024 / 1024),
      actions: storageAdmission.report.actions.length,
      failedActions: storageAdmission.report.actions.filter((a) => a.status === 'failed').length,
    });
    return Promise.resolve(false);
  }

  const activeCount = activeContainers.size;
  const inFlightWakes = wakePromises.size;
  if (MAX_CONCURRENT_CONTAINERS > 0 && activeCount + inFlightWakes >= MAX_CONCURRENT_CONTAINERS) {
    log.warn('Container wake deferred — concurrency cap reached', {
      sessionId: session.id,
      activeCount,
      inFlightWakes,
      maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
    });
    return Promise.resolve(false);
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and default reply routing so any admin
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

  // Read container config once — threaded through provider resolution,
  // buildMounts, and buildContainerArgs so we don't re-read the file.
  const containerConfig = readContainerConfig(agentGroup.folder);

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
  reconcileWorkgroupAtSpawn(getDb(), agentGroup, containerConfig);

  // Per-group filesystem state lives forever after first creation. Init is
  // idempotent: it only writes paths that don't already exist, so this call
  // is a no-op for groups that have spawned before. Runs before the provider
  // contribution so a surfaces-providing provider finds the group dir ready.
  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = buildMounts(agentGroup, session, containerConfig, provider, contribution);
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
  );

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the
  // sweep's ceiling check treats a missing file as "fresh spawn, give grace"
  // (host-sweep.ts line 87). Without this, the stale mtime can trigger an
  // immediate kill before the new container touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName, spawnedAt: Date.now() });
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

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    // code null = killed by signal (normal shutdown path), not a boot failure.
    if (code !== 0 && code !== null && stderrTail.length > 0) {
      log.warn('Container exited non-zero', { sessionId: session.id, code, containerName, stderrTail });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
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
function stripEnvEntry(args: string[], key: string): void {
  const prefix = `${key}=`;
  for (let i = args.length - 2; i >= 0; i--) {
    if (args[i] === '-e' && args[i + 1].startsWith(prefix)) {
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
 * gcloud's config dir for these containers. The default `~/.config/gcloud` is
 * unusable here: the gws accounts mount (`/home/node/.config/gws/accounts`)
 * makes Docker create `/home/node/.config` ROOT-owned, but the container runs
 * as `node` (uid 1001) — so gcloud/bq can't create their config dir and
 * activation fails with "Could not create directory [/home/node/.config/gcloud]".
 * Point CLOUDSDK_CONFIG at a node-writable home dir instead. As a container env
 * var it's also inherited by `docker exec`, so manual gcloud/bq invocations see
 * the activated account too.
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
 * via `credentialFolder` share the one key (e.g. madison-reed-codex/-opencode
 * resolve to madison-reed's key). Returns the absolute host path, or null when
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
  'OPENAI_API_KEY',
  'BRAINTRUST_API_KEY',
  'EXA_API_KEY',
  'DEEPGRAM_API_KEY',
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

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    composeGroupClaudeMd(agentGroup);
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

  // Thread-scoped worktrees: shared bind-mount across all sibling agents
  // (Claude + Codex) in the same thread, so collaborative code edits land
  // in one repo checkout regardless of which agent ran them. The session
  // dir mount above provides `/workspace/worktrees` by default; this layered
  // mount overrides it with the thread-keyed path. Docker applies mounts
  // in declaration order — inner overrides outer for the subpath.
  //
  // The thread key collapses to `<mg>:msg-<first-msg-id>` when threadId is
  // null (DM channels) so every conversation still gets a deterministic
  // worktree identity rather than sharing one global `<mg>:none` dir.
  //
  // Gated on NANOCLAW_THREAD_WORKTREES=1 for backward-compat: existing
  // single-agent deployments keep their session-scoped worktrees and don't
  // lose access on container restart after this deploy. Set the env var to
  // opt in (required for sibling-agent collaboration to share code state).
  if (session.messaging_group_id && process.env.NANOCLAW_THREAD_WORKTREES === '1') {
    // Two-bot sibling design: illie (slack-illysium) and illie-codex
    // (slack-illiecodex) each have their own MG row in this channel,
    // but they share the same platform_id (the Slack channel id) and the
    // same thread_id from chat-sdk-bridge. Keying threadWorktreeDir on
    // platform_id + thread_id resolves both bots to the same worktree dir,
    // so collaborative code edits in a thread are visible across siblings.
    const mg = getMessagingGroup(session.messaging_group_id);
    if (mg) {
      const tDir = threadWorktreeDir(mg.platform_id, session.thread_id);
      fs.mkdirSync(tDir, { recursive: true });
      mounts.push({ hostPath: tDir, containerPath: '/workspace/worktrees', readonly: false });
    }
  }

  // Channel-root inbound.db at /workspace/channel-inbound.db (read-only).
  // Scheduled tasks live in the channel-root session for this (agent, MG)
  // pair, not in the calling thread's session. The container's `list_tasks`
  // MCP tool reads from this mount so any thread can list/inspect tasks
  // scoped to the channel. Writes still go through the host system-action
  // path, which routes to the same channel-root inbound.db.
  //
  // Always mount when a channel-root session exists, including when the
  // current session IS the channel-root — duplicate bind-mount of the same
  // file is harmless and keeps `getChannelInboundDb()` uniform.
  if (session.messaging_group_id) {
    const channelSession = findSessionByAgentGroupAndMessagingGroup(agentGroup.id, session.messaging_group_id);
    if (channelSession) {
      const channelInboundFile = path.join(sessionDir(agentGroup.id, channelSession.id), 'inbound.db');
      if (fs.existsSync(channelInboundFile)) {
        mounts.push({
          hostPath: channelInboundFile,
          containerPath: '/workspace/channel-inbound.db',
          readonly: true,
        });
      }
    }
  }

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Sibling-group symlink overlay. clone-as-codex creates relative symlinks
  // (e.g. groups/illie-codex/XZO -> ../illie/XZO) so two siblings share the
  // same source repos / sources / conversations on the host. Inside the
  // container, those symlinks would dereference to /workspace/illie/XZO,
  // which isn't mounted — so create_worktree, conversations reads, mnemon
  // source-ingest all fail with ENOENT. Overlay each host-resolvable
  // symlink with a bind mount at the same container path so the entry
  // appears as a real directory inside the container, transparently
  // pointing at the source group's files.
  //
  // Absolute symlinks whose targets only exist inside the container (e.g.
  // .claude-shared.md -> /app/CLAUDE.md) are skipped: realpathSync fails
  // on the host because /app doesn't exist there, and the existing /app
  // mount makes the symlink work inside the container anyway.
  for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = path.join(groupDir, entry.name);
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(linkPath);
    } catch {
      continue;
    }
    mounts.push({ hostPath: realTarget, containerPath: `/workspace/agent/${entry.name}`, readonly: false });
  }

  // Workgroup shared filesystem — flag-gated. Bind-mount data/workgroups/<id>/
  // at /workspace/workgroup so every sibling in the workgroup shares one tree
  // (the "house"); /workspace/agent stays private (the "bedroom"). The seed's
  // shared dirs are compat-symlinked to this path by reconcileWorkgroupSharedDirs
  // (container-absolute targets, skipped by the overlay loop above), so existing
  // /workspace/agent/<name> reader paths resolve through it with no repoint.
  // Also mounts when a prior migration left a .migrated marker, so flipping the
  // flag off after enabling doesn't dangle the compat symlinks.
  const wgId = agentGroup.workgroup_id || agentGroup.folder;
  const wgShared = workgroupSharedDir(wgId);
  if (WORKGROUP_SHARED_FS || fs.existsSync(path.join(wgShared, '.migrated'))) {
    fs.mkdirSync(wgShared, { recursive: true });
    mounts.push({ hostPath: wgShared, containerPath: WORKGROUP_CONTAINER_PATH, readonly: false });
  }

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
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

  // .claude mount triple (group-shared parent + per-session projects overlay
  // + group-shared memory overlay). See session-claude-mounts.ts for the
  // ordering invariant and the race it prevents. Gated on defaultSurfaces: a
  // provider that owns its agent surfaces (providesAgentSurfaces) must not get
  // the Claude state mounted. No-op for claude/codex/opencode (all default).
  if (defaultSurfaces) {
    mounts.push(...getSessionClaudeMounts(agentGroup, session));
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
  let workgroupMemberIds: string[] | undefined;
  try {
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
  } catch (err) {
    // Re-throw W3 fail-closed; otherwise fall through to legacy single-agent filter
    if (err instanceof Error && err.message.includes('workgroup_id is NULL')) {
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

  // Memory store: RW mount so sqlite can create journal/lock files.
  //
  // CRITICAL: the mount path must match the resolved MNEMON_STORE env value, NOT
  // just agentGroup.id. With PR #105's env override + PR #106's workgroups.mnemon_store_id
  // resolution, the codex twin's MNEMON_STORE points at the parent's store id —
  // mounting only ~/.mnemon/data/<agentGroup.id> would leave the parent's store
  // directory absent from the container, so recall would see an empty store.
  // (Codex review on PR #105 caught this — the original cross-tenant narrowing
  // comment was correct, but the implementation tied the mount to the wrong id.)
  //
  // Cross-tenant narrowing still holds: resolveMnemonStore is bounded to the
  // spawning agent's workgroup (via workgroups.mnemon_store_id JOIN on agent_groups)
  // or to an explicit env override. Never mounts ~/.mnemon/ at large.
  if (containerConfig.memory?.enabled === true) {
    // Pass recall_scope so 'self' opt-outs mount their own store, not the
    // workgroup canonical (Codex P2 catch on PR #107 — host-side
    // recall-injection honors recall_scope; this keeps the container-side
    // symmetric so in-container `mnemon recall` reads from the same store).
    const recallScope = getRecallScope(containerConfig.memory);
    const resolvedStore = resolveMnemonStore(getDb(), agentGroup, process.env, recallScope);
    const mnemonDataDir = path.join(os.homedir(), '.mnemon', 'data', resolvedStore);
    fs.mkdirSync(mnemonDataDir, { recursive: true });
    mounts.push({
      hostPath: mnemonDataDir,
      containerPath: `/home/node/.mnemon/data/${resolvedStore}`,
      readonly: false,
    });
  }

  // Built-in nanoclaw-hooks plugin: project-relative, always mounted.
  // Provides the GitNexus repo-readiness guard (PreToolUse) and the
  // post-commit blast-radius verification hook (PostToolUse). Unlike
  // external plugins, this one ships with NanoClaw itself. Same
  // discovery path (CLAUDE_PLUGINS_ROOT → /workspace/plugins/*).
  const builtinPlugin = path.resolve(GROUPS_DIR, '..', 'container', 'nanoclaw-plugin');
  if (fs.existsSync(builtinPlugin)) {
    mounts.push({
      hostPath: builtinPlugin,
      containerPath: '/workspace/plugins/nanoclaw-hooks',
      readonly: true,
    });
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
    const excluded = new Set(containerConfig.excludePlugins ?? []);
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
      // per-session copy (provider=codex, the original MR-codex case) or
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
      resolvedFallbacks.forEach((entry) => {
        mounts.push({ hostPath: entry.hostPath, containerPath: entry.containerPath, readonly: false });
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

  // Host-side credential dirs — gated by the per-agent `tools` allowlist in
  // container.json. Two modes:
  //
  //   tools = undefined  → legacy behavior, mount every credential surface.
  //                        Preserves the pre-v2-tools-port default.
  //   tools = [...]      → filter + stage per-tool. E.g. `snowflake:sunday`
  //                        stages only the [connections.sunday] section of
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
  // points at: that is a cross-tenant leak (e.g. an `aws:ihm-mr` Madison Reed
  // group silently picking up a personal/Illysium `default`). A group that
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
    let isSymlink = false;
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
    let exists = false;
    try {
      fs.lstatSync(linkPath);
      exists = true;
    } catch {
      /* missing */
    }
    if (!exists) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    }
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
  // name varies per channel — the same agent_group can show as "Bo" in
  // Slack, "Axie" in Discord, etc. The per-session resolver lives in
  // `resolveAssistantName` below; container-runner passes the result as
  // the NANOCLAW_ASSISTANT_NAME env var on every spawn so the in-container
  // runner can prefer it over container.json's static value. Keeping the
  // file untouched preserves whatever the operator (or
  // `container_configs.assistant_name`) wrote without per-channel churn.
  if (dirty) {
    // Race-safe write: re-read container.json immediately before persisting
    // and merge our identity fields onto the freshest disk state. Without
    // this, a concurrent writer (e.g. enable-memory.ts flipping
    // memory.enabled, or any future config-mutating script) can have its
    // update silently clobbered when our write lands later in the spawn
    // flow with a stale in-memory containerConfig.
    //
    // Real-world incident: bulk-enable-memory across 11 groups left 2
    // (video-agent, xerus — the two without a pre-existing agentGroupId
    // in container.json) with memory.enabled=false on disk despite the
    // bulk script writing memory.enabled=true, because the spawn flow's
    // ensureRuntimeFields write-back lost the race.
    const fresh = readContainerConfig(agentGroup.folder);
    fresh.agentGroupId = agentGroup.id;
    fresh.groupName = agentGroup.name;
    writeContainerConfig(agentGroup.folder, fresh);
    // Sync the in-memory copy with anything the concurrent writer may have
    // added between our read and write — downstream spawn code reads other
    // fields from containerConfig and would otherwise miss those updates.
    if (fresh.memory !== undefined) containerConfig.memory = fresh.memory;
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
 * Slack MR channel "Bo", on Discord "Axie", on admin sessions "madison-reed".
 */
async function resolveAssistantName(
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
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  _provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  channelDefaults?: {
    channelDefaultModel: string | null;
    channelDefaultEffort: string | null;
    channelDefaultTone: string | null;
  },
  sessionMessagingGroupId?: string | null,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];
  args.push(...dockerResourceLimitArgs());

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // Claude Code behavior locks — duplicated from settings.json env block so
  // the values are set regardless of the SDK's settings-loading order.
  args.push('-e', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY=0');
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
  const defaultOpusModel = ensureOpus1mSuffix(
    channelDefaults?.channelDefaultModel ?? containerConfig.defaultModel ?? DEFAULT_OPUS_MODEL,
  );
  args.push('-e', `ANTHROPIC_DEFAULT_OPUS_MODEL=${defaultOpusModel}`);
  args.push('-e', `ANTHROPIC_DEFAULT_SONNET_MODEL=${DEFAULT_SONNET_MODEL}`);
  args.push('-e', `ANTHROPIC_DEFAULT_HAIKU_MODEL=${DEFAULT_HAIKU_MODEL}`);

  // NANOCLAW_EFFORT_OVERRIDE is an OPERATOR override (per-channel wiring or
  // per-group container.json) — injected only when one is actually set.
  // When absent, the claude provider applies per-model-family defaults
  // (opus → xhigh, fable/sonnet → high, haiku → none; see
  // defaultEffortForModel in agent-runner claude.ts). The old unconditional
  // `?? DEFAULT_EFFORT` fold made every model inherit one blanket value,
  // which breaks per-family defaults (sonnet rejects xhigh) and masked
  // whether the operator had chosen anything at all.
  const defaultEffort = channelDefaults?.channelDefaultEffort ?? containerConfig.defaultEffort;
  if (defaultEffort) {
    args.push('-e', `NANOCLAW_EFFORT_OVERRIDE=${defaultEffort}`);
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
  // agent_group can say "I am Bo" on Slack MR, "I am Axie" on Discord, etc.
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
    const agRow = getDb().prepare(`SELECT workgroup_id FROM agent_groups WHERE id = ?`).get(agentGroup.id) as
      | { workgroup_id: string | null }
      | undefined;
    if (agRow?.workgroup_id) {
      args.push('-e', `NANOCLAW_WORKGROUP_ID=${agRow.workgroup_id}`);
    }
  } catch {
    // Pre-migration-036 schema. Omit the env var; the container's
    // buildSystemPromptAddendum already treats absence as "no workgroup".
  }

  // Peer identity injection — every agent_group operating on the same
  // platform-side channel as THIS session, with its bot user_id resolved
  // for canonical `<@U…>` mentions. The container's
  // buildSystemPromptAddendum reads NANOCLAW_PEERS and renders an
  // identity block: "You are X (<@uid>). Peers: ...". This gives the
  // model an explicit name→user_id mapping per turn so prose handoff
  // ("@Bo-codex" → `<@U0B3X1QUAKV>`) doesn't depend on chat-history
  // inference. Self user_id is included separately so the agent
  // recognizes inbound @-mentions to itself.
  //
  // Sibling-adapter awareness: Bo and Bo-codex on the same Slack channel
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
    // Self user_id — same dual-registry lookup. Discord-only sessions
    // also get the self-mention guard text in the runtime prompt.
    const selfMg = getMessagingGroup(sessionMessagingGroupId);
    let selfUserId: string | undefined;
    if (selfMg) {
      selfUserId = slackBots.get(selfMg.channel_type)?.userId ?? discordBots.get(selfMg.channel_type)?.userId;
    }
    if (peerEntries.length > 0 || selfUserId) {
      args.push('-e', `NANOCLAW_PEERS=${JSON.stringify({ self: { userId: selfUserId }, peers: peerEntries })}`);
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
    .filter((m) => m.containerPath.startsWith('/home/node/.codex-fallback-'))
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
  // Identity-bound concerns (containerName, group dir mount, MNEMON_STORE
  // override env-key, log fields) stay on `agentGroup.folder` so siblings
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

  // Scoped credential env vars: each base resolves via
  // `<BASE>_<FOLDER_UPPER>` → `<BASE>` and is injected if found.
  for (const base of SCOPED_CREDENTIAL_VARS) {
    const v = resolveScopedEnv(base, credentialFolder);
    if (v) args.push('-e', `${base}=${v}`);
  }

  // Folder-scoped verbatim env vars: pass through env vars whose name starts
  // with a known prefix AND whose post-prefix tail starts with the folder
  // token followed by `_` or end-of-string. These are raw connection strings
  // (RENDER_PG_URL_ILLYSIUM_ILLYSE_MAIN, etc.) that don't collapse to a base
  // name — the agent uses the full name as-is. Gate on folder to keep
  // cross-group data access from leaking.
  //
  // SECURITY (cross-tenant audit 2026-05-03): the previous check used
  // `includes('_<TOK>_')`, which let folder=axie inherit AXIE_DEV_* vars
  // (substring overlap with axie-dev). The strict prefix-anchored match
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

  // Per-group opt-in flags from container.json.
  if (containerConfig.gitnexusInjectAgentsMd) {
    args.push('-e', 'GITNEXUS_INJECT_AGENTS_MD=true');
  }
  if (containerConfig.ollamaAdminTools) {
    args.push('-e', 'OLLAMA_ADMIN_TOOLS=true');
  }

  // Memory env vars: injected only when memory is enabled for this group.
  //
  // MNEMON_STORE resolution precedence (most specific wins):
  //   1. MNEMON_STORE_<folder> env override (case-insensitive fallback, PR #105)
  //   2. recall_scope === 'self' → agentGroup.id (honors isolation opt-out)
  //   3. workgroups.mnemon_store_id for this agent's workgroup (set by the
  //      reconciler at spawn time — ensures illie-codex shares illie's store)
  //   4. agentGroup.id (graceful fallback when workgroups row is absent)
  //
  // Must agree with the mount path resolved in buildMounts — both call
  // resolveMnemonStore with the same recallScope argument.
  if (containerConfig.memory?.enabled === true) {
    const recallScope = getRecallScope(containerConfig.memory);
    const mnemonStore = resolveMnemonStore(getDb(), agentGroup, process.env, recallScope);
    args.push('-e', `MNEMON_STORE=${mnemonStore}`);
    args.push('-e', 'MNEMON_READ_ONLY=1');
    args.push('-e', 'MNEMON_EMBED_ENDPOINT=http://host.docker.internal:11434');
    args.push('-e', 'MNEMON_EMBED_MODEL=nomic-embed-text');
  }

  // Provider-contributed env vars (e.g. XDG_DATA_HOME, OPENCODE_*, NO_PROXY).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
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
      const workgroupSecrets = getWorkgroupOnecliSecrets(agentGroup.id);
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

  // Volume mounts
  for (const mount of mounts) {
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
    // API_TOKEN)` from env vars at request time. Placeholder values here
    // satisfy the server's startup validation; OneCLI's gateway overrides
    // the constructed header with the real Basic from the vault entry
    // "Atlassian" (hostPattern: madison-reed.atlassian.net) before the
    // request leaves the container. Site URLs are non-secret config and
    // stay literal. Hard-coded to madison-reed today; if other groups
    // ever wire Atlassian we'd resolve site per-folder.
    mcpServers.atlassian = {
      type: 'stdio',
      command: 'mcp-atlassian',
      args: [],
      env: {
        JIRA_URL: 'https://madison-reed.atlassian.net',
        JIRA_USERNAME: 'onecli-managed',
        JIRA_API_TOKEN: 'onecli-managed',
        CONFLUENCE_URL: 'https://madison-reed.atlassian.net/wiki',
        CONFLUENCE_USERNAME: 'onecli-managed',
        CONFLUENCE_API_TOKEN: 'onecli-managed',
      },
    };
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
  // DBs). Run the image's entrypoint.sh directly via bash so XDG / gws /
  // GitHub-auth / Render / GitNexus setup fires before bun starts.
  args.push('--entrypoint', 'bash');

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec /app/entrypoint.sh');

  return args;
}

export function dockerResourceLimitArgs(): string[] {
  const args: string[] = [];
  pushDockerLimit(args, '--memory', CONTAINER_MEMORY_LIMIT);
  pushDockerLimit(args, '--memory-reservation', CONTAINER_MEMORY_RESERVATION);
  pushDockerLimit(args, '--memory-swap', CONTAINER_MEMORY_SWAP_LIMIT);
  if (CONTAINER_PIDS_LIMIT > 0) {
    args.push('--pids-limit', String(CONTAINER_PIDS_LIMIT));
  }
  return args;
}

function pushDockerLimit(args: string[], flag: string, value: string): void {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '0') return;
  args.push(flag, trimmed);
}

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
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  // Write Dockerfile to temp file and build
  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      stdio: 'pipe',
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
