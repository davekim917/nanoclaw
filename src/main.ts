import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { activateAgentRunnerSource, pruneAgentRunnerSnapshots } from './agent-runner-source.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';
import {
  POST_DEPLOY_EARLY_CHECK_MS,
  POST_DEPLOY_EARLY_ERROR_THRESHOLD,
  POST_DEPLOY_REPORT_PATH,
  startPostDeployInboundCheck,
} from './channels/post-deploy-inbound.js';
import { markDeployBootHealthy } from './deploy-crash-guard.js';
import { bootFollowsSuccessfulDeploy } from './deploy-status.js';
import { notifyOperators } from './operator-alert.js';
import {
  changedPathsBetween,
  commitCountBetween,
  describeBuildDrift,
  formatBuildInfoLog,
  isMaterialDrift,
  isMaterialPath,
  readBuildInfo,
  readCheckoutHead,
} from './build-info.js';
import { DATA_DIR, HOST_LEASE_TTL_MS, POST_DEPLOY_INBOUND_WINDOW_MS, REPO_ROOT } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { shadowWrite } from './db/coordination.js';
import { getDb, getRawDb, initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { registerSecretsFromEnv } from './secret-scrubber.js';
import {
  channelNameProvenance,
  channelNameProvenanceAccepts,
  getMessagingGroupByPlatform,
  applyChannelMetadataUpdates,
} from './db/messaging-groups.js';
import type { ChannelNameSource, MessagingGroupUpdates } from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning } from './container-runtime.js';
import { warnActiveContainersOfShutdown, warnMarkedRunningSessionsOfStartup } from './host-restart-warn.js';
import { notifyOwner } from './notify-owner.js';
import { requestWake } from './request-wake.js';
import { getActiveSessions, resetPhantomContainerStatus } from './db/sessions.js';
import { resetProcessingChannelIngress } from './db/channel-ingress-receipts.js';
import {
  adoptRunningSessions,
  beginContainerShutdown,
  honorPendingStopIntents,
  planContainerShutdown,
} from './container-runner.js';
import { quiesceWorkgroupsForBootMountChange, type BootQuiescenceScope } from './container-restart.js';
import { writeUpstreamPolicySnapshot } from './container-updates.js';
import { setDeliveryAdapter, startActiveDeliveryPoll, startSweepDeliveryPoll, stopDeliveryPolls } from './delivery.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { ensureArchiveSchema } from './message-archive.js';
import { startHostModules, stopHostModules } from './host-lifecycle.js';
import { runOnecliBootPreflight } from './onecli-preflight.js';
import { resetStorageActivityState } from './storage-activity.js';
import { finishInterruptedSessionArchivals } from './storage-manager.js';
import { drainClosedSessionPendingBacklog } from './session-close-expiry.js';
// Side-effect only: each registers its onHostStart/onHostShutdown timer with src/host-lifecycle.ts at import.
// managed-git-hooks is not one of these: it must finish before anything can spawn, so it is called explicitly.
import './worktree-cleanup.js';
import './repo-freshness.js';
import { initializeManagedGitHooks } from './managed-git-hooks.js';
import './plugin-updater.js';
import './commit-scan.js';
import './backlog-canvas.js';
import './daily-summary.js';
import { restoreRemoteControl } from './remote-control.js';
import { startDiscordSlashCommands, stopDiscordSlashCommands } from './channels/discord-slash-commands.js';
import {
  recoverChannelAdapter,
  recoverAllChannelsAfterStartup,
  startChannelRecoveryMonitor,
  stopChannelRecoveryMonitor,
} from './channels/channel-recovery.js';
import { makeOnAction } from './channels/action-response.js';
import { secretIntakeHooks } from './modules/secret-intake/service.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { startDashboard } from './dashboard/index.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';
import { reconcilePendingUpgradeContexts } from './session-manager.js';
import { releaseOrphanedRepoIngressFencesAtStartup } from './repo-fence-recovery.js';

// The registry lives in response-registry.ts: modules register at top level during import, which would hit a
// TDZ error if the array lived here.
import { getResponseHandlers, type ResponsePayload } from './response-registry.js';

// Aborted as the first shutdown action, so `HostStartContext.signal` is meaningful to start callbacks.
export const hostAbortController = new AbortController();

/** Last-alerted (buildSha, headSha) pair for the boot build-drift DM; a corrupt or missing file means alert again. */
interface BuildDriftAlertState {
  buildSha: string;
  headSha: string;
}

const BUILD_DRIFT_ALERT_STATE_PATH = path.join(DATA_DIR, 'build-drift-alert.json');

function readBuildDriftAlertState(): BuildDriftAlertState | null {
  try {
    return JSON.parse(fs.readFileSync(BUILD_DRIFT_ALERT_STATE_PATH, 'utf8')) as BuildDriftAlertState;
  } catch {
    return null;
  }
}

/** Best-effort; a failed write just means the next boot re-alerts. */
function writeBuildDriftAlertState(state: BuildDriftAlertState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUILD_DRIFT_ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    log.warn('build-drift: could not write dedupe marker (may re-alert next boot)', { err: String(err) });
  }
}

/**
 * Boot-time build-drift check. Never throws and never blocks boot: a stale build is wrong, not unsafe. The WARN
 * logs on every drifted boot; the owner DM is deduped on the (buildSha, headSha) pair so a crash loop cannot spam.
 */
async function checkBuildDrift(buildInfo: ReturnType<typeof readBuildInfo>): Promise<void> {
  try {
    const headSha = readCheckoutHead(REPO_ROOT);
    const drift = describeBuildDrift(buildInfo, headSha);
    if (!drift) return;

    log.warn(drift.msg, drift.data);

    const buildSha = buildInfo!.sha;
    const head = headSha!;

    // A sha mismatch is the normal state (the checkout is pulled without rebuilds), so DM only when the diff is
    // material. A null diff means git could not tell: treat it as material.
    const changed = changedPathsBetween(REPO_ROOT, buildSha, head);
    if (changed !== null && !isMaterialDrift(changed)) {
      log.info('build-drift: stale build, but nothing compiled into dist/ differs — not alerting', {
        buildSha,
        headSha: head,
        changedFiles: changed.length,
      });
      return;
    }
    const materialPaths = (changed ?? []).filter(isMaterialPath);
    const commitCount = changed === null ? null : commitCountBetween(REPO_ROOT, buildSha, head);

    const prior = readBuildDriftAlertState();
    if (prior && prior.buildSha === buildSha && prior.headSha === head) return; // already alerted this pair

    const result = await notifyOwner({
      title: 'Host is running a stale build',
      body:
        `The running host is executing build ${buildInfo!.shortSha} (${buildSha}), an older build than the ` +
        `checkout's current HEAD ${head.slice(0, 7)} (${head}).\n\n` +
        (changed === null
          ? 'Could not diff the two commits (the built sha may have been rebased away, or git failed) — alerting ' +
            'out of caution, since an unreadable diff is not evidence the drift is harmless.\n\n'
          : `${commitCount !== null ? `${commitCount} commit(s)` : 'an unknown number of commits'} of drift, ` +
            `including ${materialPaths.length} compiled file(s) that differ: ` +
            `${materialPaths.slice(0, 3).join(', ')}${materialPaths.length > 3 ? ', …' : ''}.\n\n`) +
        'A restart alone will not fix this — restart does not rebuild. Run the build and restart — e.g. ' +
        '`scripts/deploy.sh`, or pull + `pnpm run build` + a host restart.\n\n' +
        'Note: a plain restart DOES re-snapshot agent-runner source from the working tree while host src/ does ' +
        'not — so although the two halves are consistent right now, the NEXT restart risks splitting them: newer ' +
        'agent-runner code running against this older host build.',
    });
    if (result.code === 0) {
      // Record only a verified delivery: stamping first would remember a failed alert as sent and never retry.
      writeBuildDriftAlertState({ buildSha, headSha: head });
    } else {
      log.warn('build-drift: could not DM the owner', { code: result.code, message: result.message });
    }
  } catch (err) {
    log.warn('build-drift: check failed, continuing boot', { err: err instanceof Error ? err.message : String(err) });
  }
}

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

/** Load .env into process.env without overriding vars already set in the shell. */
function loadEnvIntoProcess(): void {
  const envPath = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return; // .env not present — fine
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key && !Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = value;
    }
  }
}

// Channel barrel: each enabled channel self-registers on import.
import './channels/index.js';

// Modules barrel, imported for its registration side effects.
import './modules/index.js';

// Called from main() after initDb: the reconciler queries the central DB.
import { runReconcilerOnStartup as runDispatchReconcilerOnStartup } from './modules/orchestrator-dispatch/index.js';

import { reconcileWorkgroupFsState } from './modules/workgroup/fs-reconcile.js';
import {
  describeMutation,
  reconcileWorkgroupMemory,
  reconcileWorkgroupSharedDirs,
  sharedDirsPendingChange,
  workgroupMemoryPendingChange,
  type SharedDirsPendingChange,
  type WorkgroupMemoryPendingChange,
  type WorkgroupMemoryReport,
} from './modules/workgroup/shared-dirs.js';
import { WORKGROUP_SHARED_FS } from './config.js';
// Populates the `ncl` registry before the CLI server accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { markCliServerReady, startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { adapterInboundEvent } from './channels/inbound-event.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';
import type Database from 'better-sqlite3';

/**
 * Canonical-memory reconciliation for the workgroups the boot door proved quiescent. Must never be called from
 * outside a quiescence door (src/workgroup-reconcile-doors-ratchet.test.ts pins that).
 */
export function runWorkgroupMemoryStartupGate(
  db: Database.Database,
  deps: {
    /**
     * Confines the cutover's writes to these workgroups. Every workgroup is still reported: `main()` derives
     * pre-turn-context targets and migration warnings from the full report set.
     */
    mutateWorkgroupIds?: string[];
    ensureRuntime?: () => void;
    reconcile?: (db: Database.Database, dirs: { mutateWorkgroupIds?: string[] }) => WorkgroupMemoryReport[];
  } = {},
): WorkgroupMemoryReport[] {
  (deps.ensureRuntime ?? ensureContainerRuntimeRunning)();
  return (deps.reconcile ?? reconcileWorkgroupMemory)(db, { mutateWorkgroupIds: deps.mutateWorkgroupIds });
}

export interface BootMountQuiescenceDeps {
  workgroupIds?: (db: Database.Database) => string[];
  memoryPendingChange?: (db: Database.Database, workgroupId: string) => WorkgroupMemoryPendingChange | null;
  sharedPendingChange?: (db: Database.Database, workgroupId: string) => SharedDirsPendingChange | null;
  sharedFsEnabled?: boolean;
  activeSessionIds?: () => Promise<string[]>;
  ensureRuntime?: () => void;
  quiesce?: (
    changedWorkgroupIds: string[],
    options: {
      knownWorkgroupIds: string[];
      knownSessionIds: string[];
      reevaluateChanged: () => string[];
      beforeStop: (partition: {
        pass: 1 | 2;
        survivableSessionIds: string[];
        mustStopSessionIds: string[];
      }) => Promise<void>;
    },
  ) => Promise<BootQuiescenceScope>;
  warnStartup?: (reason: string, skipSessionIds: ReadonlySet<string>) => Promise<void>;
  reconcileShared?: (db: Database.Database, dirs: { workgroupIds?: string[] }) => unknown;
  memoryGate?: (db: Database.Database, opts: { mutateWorkgroupIds?: string[] }) => WorkgroupMemoryReport[];
  prune?: () => void;
  fatal?: (message: string, err: unknown) => never;
}

/**
 * The fail-closed adoption seed when adoption's own inventory fails: the door's returned survivors, the
 * containers it proved still running. Not inferred from counts: a newcomer stopped in the second pass makes
 * `stopped` reach `containers` while survivors remain, and those must be held. Exported for the unit test.
 */
export function adoptionSeedFor(scope: Pick<BootQuiescenceScope, 'survivableSessionIds'>): string[] {
  return [...scope.survivableSessionIds];
}

function bootFatal(message: string, err: unknown): never {
  log.error(message, { err });
  process.exit(1);
}

/**
 * The boot mount-change block. Order is the safety argument, asserted in src/boot-quiescence-order.test.ts:
 * warn sessions an unclean previous host left 'running' (DB-only, before any stop); probe the runtime (bounded)
 * before the door's unbounded inventory; evaluate predicates as the door's input; quiesce (the only boot-time
 * stopper; throws before anything below if it cannot prove its scope is down); re-evaluate on the quiescent tree,
 * since group dirs are container-writable and the pre-stop snapshot can be stale; then shared-FS consolidation and
 * the canonical-memory cutover on that post-stop set; then snapshot pruning.
 */
export async function runBootMountQuiescence(
  db: Database.Database,
  deps: BootMountQuiescenceDeps = {},
): Promise<{ changedWorkgroupIds: string[]; scope: BootQuiescenceScope; memoryReports: WorkgroupMemoryReport[] }> {
  const sharedFsEnabled = deps.sharedFsEnabled ?? WORKGROUP_SHARED_FS;
  const listWorkgroupIds =
    deps.workgroupIds ??
    ((database: Database.Database): string[] =>
      (database.prepare(`SELECT id FROM workgroups ORDER BY id`).all() as Array<{ id: string }>).map((row) => row.id));
  const memoryPending = deps.memoryPendingChange ?? workgroupMemoryPendingChange;
  const sharedPending = deps.sharedPendingChange ?? sharedDirsPendingChange;
  const fatal = deps.fatal ?? bootFatal;

  const allWorkgroupIds = listWorkgroupIds(db);
  // The latest evaluation, kept so the door's post-stop answer — the one it partitioned against — is what gets
  // logged and what scopes the reconciles, not a fourth read of a tree live containers may have written since.
  const pending = new Map<
    string,
    { memory: WorkgroupMemoryPendingChange | null; shared: SharedDirsPendingChange | null }
  >();
  // A workgroup is "changed" (its containers must stop) only for a write that changes what an existing path in a
  // live mount resolves to. A pending link creation is taken at a boot that finds the workgroup idle, never live.
  // Once a D2 survivable-container path exists, a pending wiki core.hooksPath change must also count as a mount
  // change here, before the door runs: a survivor keeps its pre-migration `.git/config` mount and has no hook.
  const evaluateChanged = (): string[] => {
    pending.clear();
    for (const id of allWorkgroupIds) {
      pending.set(id, { memory: memoryPending(db, id), shared: sharedFsEnabled ? sharedPending(db, id) : null });
    }
    return allWorkgroupIds.filter((id) => {
      const entry = pending.get(id)!;
      return entry.memory !== null || entry.shared?.invalidatesMounts === true;
    });
  };

  // Bounded probe before the door's unbounded `docker ps`, so a stalled daemon fails the boot instead of hanging.
  (deps.ensureRuntime ?? ensureContainerRuntimeRunning)();

  // Only the door's input: live containers can flip a workgroup between this snapshot and the stops completing.
  const changedBeforeQuiescence = evaluateChanged();

  // A container whose session row is gone or archived has nothing to adopt, so it is never survivable.
  const knownSessionIds = await (
    deps.activeSessionIds ?? (async () => (await getActiveSessions()).map((session) => session.id))
  )();

  // Runs inside the door, after its pre-stop partition and before its first stop: the note must skip survivors
  // and still precede a stop pass that can outlast the heartbeat window. The door calls it again only for
  // sessions its post-stop re-evaluation moved into must-stop.
  const warnStartup = deps.warnStartup ?? warnMarkedRunningSessionsOfStartup;
  const beforeStop = async (partition: {
    pass: 1 | 2;
    survivableSessionIds: string[];
    mustStopSessionIds: string[];
  }): Promise<void> => {
    const skip =
      partition.pass === 1
        ? new Set(partition.survivableSessionIds)
        : new Set(knownSessionIds.filter((id) => !partition.mustStopSessionIds.includes(id)));
    try {
      await warnStartup('host startup after an unclean stop', skip);
    } catch (err) {
      log.error('host-restart startup warn failed', { err });
    }
  };

  const scope = await (deps.quiesce ?? quiesceWorkgroupsForBootMountChange)(changedBeforeQuiescence, {
    knownWorkgroupIds: allWorkgroupIds,
    knownSessionIds,
    // The door partitions against this answer, so its scope and the cutover cannot disagree.
    reevaluateChanged: evaluateChanged,
    beforeStop,
  });

  // The authoritative set: a workgroup that flipped during the stops is reconciled here and must-stop in the
  // partition, never left out of both.
  const changedWorkgroupIds = scope.changedWorkgroupIds;
  const flipped = changedWorkgroupIds.filter((id) => !changedBeforeQuiescence.includes(id));
  log.info('Boot quiescence rescope', {
    changedBefore: changedBeforeQuiescence.length,
    changedAfter: changedWorkgroupIds.length,
    // Non-empty means a live agent wrote to a group directory while the door was stopping it.
    ...(flipped.length > 0 ? { flipped } : {}),
  });
  // Every write runs with the workgroup's containers stopped. The changed set was stopped by the door; a workgroup
  // with only link creations pending is written at a boot where nothing of it survived, and otherwise waits.
  const surviving = new Set(scope.survivingWorkgroupIds);
  const idleLinkWorkgroupIds: string[] = [];
  for (const [workgroupId, entry] of pending) {
    if (changedWorkgroupIds.includes(workgroupId)) {
      log.info('Boot quiescence changed workgroup', {
        workgroupId,
        predicate: entry.memory ? 'memory' : 'shared-dirs',
        ...(entry.memory
          ? { reason: entry.memory.reason, ...(entry.memory.folder ? { folder: entry.memory.folder } : {}) }
          : { write: entry.shared ? describeMutation(entry.shared) : 'none' }),
      });
    } else if (entry.shared && !entry.shared.invalidatesMounts) {
      const idle = !surviving.has(workgroupId);
      if (idle) idleLinkWorkgroupIds.push(workgroupId);
      log.info(
        idle
          ? 'Boot quiescence link creation on an idle workgroup'
          : 'Boot quiescence link creation deferred, containers kept',
        {
          workgroupId,
          write: describeMutation(entry.shared),
        },
      );
    }
  }
  const reconcileWorkgroupIds = [...changedWorkgroupIds, ...idleLinkWorkgroupIds];

  // Flag-gated (NANOCLAW_WORKGROUP_SHARED_FS, default off). Idempotent and fail-closed.
  if (sharedFsEnabled) {
    try {
      (deps.reconcileShared ?? reconcileWorkgroupSharedDirs)(db, { workgroupIds: reconcileWorkgroupIds });
    } catch (sharedErr) {
      fatal('Workgroup shared-FS consolidation failed at startup', sharedErr);
    }
  }

  const memoryReports = (deps.memoryGate ?? runWorkgroupMemoryStartupGate)(db, {
    mutateWorkgroupIds: changedWorkgroupIds,
  });

  // Only after the door has stopped the previous host's containers: a bind mount pins the directory, not its
  // entries. `defaultReferencedPaths` reads docker, so adopted containers stay protected.
  (deps.prune ?? pruneAgentRunnerSnapshots)();

  return { changedWorkgroupIds, scope, memoryReports };
}

/**
 * Which fields `onMetadata`'s one-shot channel-metadata discovery should persist. `name` has two writers: the
 * raw platform fetch and the classification seam (e.g. a Slack MPDM roster instead of its `mpdm-…` slug). The
 * decision compares provenance via `channelNameProvenanceAccepts`, never the name itself or wiring status, so a
 * restart cannot overwrite a classified name with the raw slug.
 */
export function resolveChannelMetadataUpdates(
  mg: { name: string | null; name_source?: string | null; channel_type: string; is_group: number },
  name: string | undefined,
  isGroup: boolean | undefined,
  incoming: { platform: string; source: ChannelNameSource },
): MessagingGroupUpdates {
  const updates: { is_group?: number } = {};
  if (isGroup !== undefined) {
    const isGroupFlag = isGroup ? 1 : 0;
    if (mg.is_group !== isGroupFlag) updates.is_group = isGroupFlag;
  }
  if (name && name !== mg.name && channelNameProvenanceAccepts(mg, incoming)) {
    return { ...updates, name, name_source: channelNameProvenance(incoming.platform, incoming.source) };
  }
  return updates;
}

export async function main(): Promise<void> {
  log.info('NanoClaw starting');
  // Read before the Discord deploy announcer consumes the status file.
  const deployBoot = bootFollowsSuccessfulDeploy();

  const buildInfo = readBuildInfo(REPO_ROOT);
  if (buildInfo) {
    const { msg, data } = formatBuildInfoLog(buildInfo);
    log[buildInfo.dirty ? 'warn' : 'info'](msg, data);
  } else {
    log.warn('dist/BUILD_INFO.json missing — cannot report build provenance (older dist, or a dev run)');
  }

  // Claim exclusive host ownership before any startup work that can mutate shared state; the socket stays
  // not-ready until every boot gate below completes.
  await startCliServer();

  await enforceStartupBackoff();

  // Below both gates above: it sends a DM and writes a shared dedupe marker, so two racing hosts must not both
  // run it, and a crash-looping host is throttled before it can message anyone.
  await checkBuildDrift(buildInfo);

  // Shell-set values take precedence over .env.
  loadEnvIntoProcess();

  registerSecretsFromEnv();

  // Refuse to start if this install was updated outside the sanctioned path (raw `git pull`).
  enforceUpgradeTripwire();

  const dbPath = path.join(DATA_DIR, 'v2.db');
  await initDb(dbPath);
  // The migration runner stays synchronous on the raw handle: nothing else touches the central DB at boot.
  const db = getRawDb();
  runMigrations(db);

  // Ahead of everything that can spawn. Through `shadowWrite`: a failed INSERT must log and let boot continue,
  // never make this shadow state a startup dependency.
  await shadowWrite('host instance lease start', () => startHostInstanceLease({ leaseTtlMs: HOST_LEASE_TTL_MS }));
  const hostInstanceId = getHostInstanceId();
  if (hostInstanceId) {
    // Exactly one per boot; its absence means registration failed.
    log.info('Host instance lease started', { instanceId: hostInstanceId, ttlMs: HOST_LEASE_TTL_MS });
  }

  // Before ANY service that can spawn (the dashboard's run-now included): until the archive's row-mark schema
  // exists every projection freshness stamp fails closed, and every spawn does the full rebuild.
  ensureArchiveSchema();

  // Before anything can spawn, so every spawn this process makes mounts the same tree, not a checkout mid-pull.
  activateAgentRunnerSource();

  await resetProcessingChannelIngress();

  // Drains the migration-036 report. On FS failure, exit: the reconciler is idempotent and restart recovers.
  try {
    reconcileWorkgroupFsState(db);
  } catch (fsErr) {
    log.error('Workgroup FS reconciliation failed at startup', { err: fsErr });
    process.exit(1);
  }

  // Nothing here mutates a mount before the quiescence proof returns; a failed listing or stop throws out of boot.
  const { scope, memoryReports } = await runBootMountQuiescence(db);

  // Both resets must run before adoption (src/adoption-order.test.ts): after it, this one would strip the fresh
  // lease adoption takes for a survivor, letting the storage manager clean a root in use.
  resetStorageActivityState();
  // After adoption this would flip the rows adoption just marked `running` back to 'stopped'.
  const resetCount = await resetPhantomContainerStatus();
  if (resetCount > 0) {
    log.info('Reset phantom container_status rows on startup', { count: resetCount });
  }

  // Before every wake source and before the orphaned-fence recovery (src/adoption-order.test.ts): no wake may
  // spawn a second container beside an untracked survivor, and the recovery's premise (a fresh process holds no
  // mount claims) must still hold. If adoption's inventory fails, the seed is only what the door left running.
  const reconciled = await adoptRunningSessions({
    survivableSessionIds: scope.survivableSessionIds,
    heldOnInventoryFailure: adoptionSeedFor(scope),
  });
  for (const report of memoryReports) {
    if (report.state.status === 'migration-required') {
      log.warn('Workgroup memory requires operator migration; automatic startup left it untouched', {
        workgroupId: report.workgroupId,
        sources: report.state.sources,
      });
    }
  }
  try {
    const pendingUpgrade = await reconcilePendingUpgradeContexts(
      db,
      memoryReports
        .filter((report) => report.state.status !== 'migration-required')
        .map((report) => report.workgroupId),
    );
    if (pendingUpgrade.skipped > 0 || pendingUpgrade.stubsRemoved > 0) {
      // An unreadable session DB no longer stops startup, so report counts: a rising `skipped` is systemic.
      log.warn('Startup reconciliation could not process every session DB', pendingUpgrade);
    }
    if (pendingUpgrade.admitted > 0) {
      log.info('Admitted pending pre-turn contexts during startup', pendingUpgrade);
    }
  } catch (pendingErr) {
    log.error('Pending pre-turn context reconciliation failed at startup', { err: pendingErr });
    process.exit(1);
  }

  // Mount/lifecycle claims are process-local, so every active fence a fresh process finds belongs to a dead
  // publication and is orphaned. Per-session failures never exit: a fence is a liveness problem, not a boot one.
  try {
    const fences = await releaseOrphanedRepoIngressFencesAtStartup();
    if (fences.released > 0 || fences.failed > 0) {
      log.warn('Released orphaned repository ingress fences at startup', {
        ...fences,
        adoptedWithActiveFence: reconciled.fencedInbound,
      });
    }
  } catch (fenceErr) {
    log.error('Orphaned repository ingress fence recovery failed at startup', { err: fenceErr });
  }

  log.info('Central DB ready', { path: dbPath });

  // Before ANY ingress opens: an unreachable control API makes every spawn refuse at WARN and the fleet goes
  // deaf. Past the adapters, a message could wake a container while this retries and the exit would kill a host
  // that accepted work. Failing exits before markDeployBootHealthy(), keeping the deploy rollback-eligible.
  await runOnecliBootPreflight();

  // After runBootMountQuiescence and before startDashboard()/honorPendingStopIntents()/initChannelAdapters(),
  // all of which can spawn: a spawn mounting a scan-policy repo depends on this having run once this process.
  initializeManagedGitHooks();

  // Containers cannot derive this (/workspace/project has no `.git`). Best-effort; never blocks boot.
  try {
    await writeUpstreamPolicySnapshot(REPO_ROOT, path.join(DATA_DIR, 'upstream-policy.json'));
  } catch (err) {
    log.error('Upstream policy snapshot failed at startup', { err });
  }

  // After migrations (028) and before channel adapters, so the HTTP server is up regardless of channel config.
  startDashboard();

  // Recovers tasks left 'pending' with admitted_at set but no child_session_id (host crashed mid-completion).
  await runDispatchReconcilerOnStartup();

  await backfillContainerConfigs();

  // Before the sweep can hand out work to a row still parked in 'archiving'.
  try {
    await finishInterruptedSessionArchivals();
  } catch (err) {
    log.error('Interrupted session archival recovery failed', { err });
  }

  try {
    await drainClosedSessionPendingBacklog();
  } catch (err) {
    log.error('Closed-session pending backlog drain failed', { err });
  }

  // Early operator signal only; the hard gate lives in spawnContainer.
  void (async () => {
    try {
      const { checkAgentRunnerDepsDrift } = await import('./agent-runner-image-check.js');
      const r = await checkAgentRunnerDepsDrift();
      if (!r.ok) {
        log.warn('agent-runner image deps drift detected at boot — spawns will be refused until rebuild', {
          expected: r.expected,
          actual: r.actual,
          message: r.message,
        });
      }
    } catch (err) {
      log.warn('agent-runner deps drift check failed at boot', { err });
    }
  })();

  // The first deliberate spawn in startup, so it sits below every startup-only reset, pre-spawn gate and
  // adoption (src/stop-intent-recovery.test.ts pins the order): above the resets its container's lease and
  // `running` row would be wiped; above the fence recovery it would break that pass's premise; above adoption
  // it could act on a survivor not yet registered. It must not move into `adoptRunningSessions`, which stays a
  // pure inventory pass with no wake.
  await honorPendingStopIntents((session) => requestWake(session, 'container-restart'));

  // Gateway READY can arrive while adapters are still initializing; hold its recovery callback until every
  // adapter identity, the sibling allow-list and the delivery bridge are ready.
  let releaseChannelRecoveryReady!: () => void;
  const channelRecoveryReady = new Promise<void>((resolve) => {
    releaseChannelRecoveryReady = resolve;
  });
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        return routeInbound(adapterInboundEvent(adapter, platformId, threadId, message)).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
          throw err;
        });
      },
      onInboundEvent(event) {
        return routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
          throw err;
        });
      },
      onConnectionRestored(info) {
        return channelRecoveryReady.then(() => recoverChannelAdapter(adapter, info));
      },
      async onMetadata(platformId, name, isGroup) {
        const mg = await getMessagingGroupByPlatform(adapter.channelType, platformId);
        if (!mg) return; // router hasn't auto-created it yet — next inbound will
        const incoming = { platform: adapter.channelType, source: 'adapter' as const };
        const updates = resolveChannelMetadataUpdates(mg, name, isGroup, incoming);
        if (Object.keys(updates).length === 0) return;
        // Checked again inside the write: the router's classified name may land during the await.
        await applyChannelMetadataUpdates(mg.id, updates, incoming);
        log.info('Channel metadata persisted', {
          channelType: adapter.channelType,
          platformId,
          mgId: mg.id,
          updates,
        });
      },
      onAction: makeOnAction(adapter.channelType, dispatchResponse),
      secretIntake: secretIntakeHooks(adapter.channelType),
    };
  });
  // Lets our own sibling bots engage each other under a `strict` messaging group, where they would otherwise be
  // dropped as `not_member`. Dynamic imports so a build without an adapter still links.
  {
    const { setSiblingBotIdsProvider } = await import('./modules/permissions/index.js');
    const botRegistries: Array<() => ReadonlyMap<string, { userId: string }>> = [];
    try {
      const m = await import('./channels/discord.js');
      if (typeof m.getKnownDiscordBots === 'function') botRegistries.push(m.getKnownDiscordBots);
    } catch {
      /* discord adapter not installed */
    }
    try {
      const m = await import('./channels/slack-mentions.js');
      if (typeof m.getKnownSlackBots === 'function') botRegistries.push(m.getKnownSlackBots);
    } catch {
      /* slack adapter not installed */
    }
    setSiblingBotIdsProvider(() => {
      const ids = new Set<string>();
      for (const getBots of botRegistries) {
        for (const { userId } of getBots().values()) ids.add(userId);
      }
      return ids;
    });
    log.info('Sibling-bot allow-list wired for access gate', { registries: botRegistries.length });
  }

  // Dispatches by exact registry key (instance ?? channelType): an offline named instance is never rerouted
  // through a sibling bot.
  setDeliveryAdapter(createChannelDeliveryAdapter());
  if (deployBoot) {
    startPostDeployInboundCheck({
      build: buildInfo?.shortSha ?? null,
      windowMs: POST_DEPLOY_INBOUND_WINDOW_MS,
      earlyCheckMs: POST_DEPLOY_EARLY_CHECK_MS,
      earlyErrorThreshold: POST_DEPLOY_EARLY_ERROR_THRESHOLD,
      notify: notifyOperators,
      reportPath: POST_DEPLOY_REPORT_PATH,
    });
    log.info('Post-deploy inbound check started', { windowMs: POST_DEPLOY_INBOUND_WINDOW_MS });
  }

  // Everything that can mutate central-DB state on this process's behalf is up only now; an earlier `ncl` call
  // could read or write mid-setup state.
  markCliServerReady();

  await startHostModules({ db: getDb(), signal: hostAbortController.signal });

  // A replay can immediately exercise permissions and delivery, so it must not race partial startup.
  releaseChannelRecoveryReady();
  void recoverAllChannelsAfterStartup(Date.now() - 10 * 60 * 1000)
    .then(() => {
      log.info('Initial channel recovery pass finished');
    })
    .catch((err) => {
      log.error('Initial channel recovery coordinator failed', { err });
    });
  startChannelRecoveryMonitor();

  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  startHostSweep();
  log.info('Host sweep started');

  // Worktree cleanup, repo freshness, plugin updater, commit scan, daily summary and backlog canvas start via
  // onHostStart (src/host-lifecycle.ts).

  restoreRemoteControl();

  startDiscordSlashCommands().catch((err) => {
    log.error('Discord slash commands failed to start', { err });
  });

  markDeployBootHealthy();

  log.info('NanoClaw running');
}

async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  // Before any other shutdown work: abort the modules' signal, then run their onHostShutdown callbacks LIFO.
  hostAbortController.abort();
  await stopHostModules();
  stopDeliveryPolls();
  stopHostSweep();
  stopChannelRecoveryMonitor();
  await stopDiscordSlashCommands();
  // Keep the kernel claim until process exit: a replacement host must not open or migrate the central DB while
  // this one is still tearing it down.
  await stopCliServer({ retainOwnership: true });
  try {
    await teardownChannelAdapters();
    // Before their containers stop: the on_wake note makes the post-restart spawn account for the interruption.
    try {
      await warnActiveContainersOfShutdown('graceful host shutdown', planContainerShutdown());
    } catch (err) {
      log.error('host-restart shutdown warn failed', { err });
    }
    // Close the spawn path but leave running containers alone for the next host to adopt. Safe only because the
    // unit carries `KillMode=mixed` and no `ExecStop` sweep; a rollback restores those first.
    try {
      await beginContainerShutdown();
    } catch (err) {
      log.error('beginContainerShutdown threw', { err });
    }
  } finally {
    // In `finally`, so a teardown throw cannot leave the row looking crash-ended for the lease TTL.
    await stopHostInstanceLease();
    // We got here via a signal, not a crash, so the next start must not count as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

export function isDirectExecution(moduleUrl: string, argvEntry: string | undefined): boolean {
  return !!argvEntry && pathToFileURL(path.resolve(argvEntry)).href === moduleUrl;
}

/** Signal handlers + main(); called by src/index.ts after the deploy crash guard has run. */
export function startNanoClaw(): void {
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => log.fatal('Shutdown handler failed', { err, signal: 'SIGTERM' }));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => log.fatal('Shutdown handler failed', { err, signal: 'SIGINT' }));
  });
  main().catch((err) => {
    log.fatal('Startup failed', { err });
    process.exit(1);
  });
}

// Supports running src/main.ts directly (e.g. tsx); the guard is a no-op without a deploy manifest.
if (isDirectExecution(import.meta.url, process.argv[1])) {
  startNanoClaw();
}
