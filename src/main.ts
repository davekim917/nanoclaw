/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { activateAgentRunnerSource, pruneAgentRunnerSnapshots } from './agent-runner-source.js';
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { markDeployBootHealthy } from './deploy-crash-guard.js';
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
import { DATA_DIR, HOST_LEASE_TTL_MS, REPO_ROOT } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
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
// Side-effect only: each registers its onHostStart/onHostShutdown timer with
// src/host-lifecycle.ts at import time. See "7–10b" in startNanoClaw below.
// managed-git-hooks.js is NOT one of these — it's a one-shot startup step
// with a harder deadline (before anything can spawn), called explicitly
// below via initializeManagedGitHooks, not registered as a timer.
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
import { routeInbound } from './router.js';
import { log } from './log.js';
import { startDashboard } from './dashboard/index.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';
import { reconcilePendingUpgradeContexts } from './session-manager.js';
import { releaseOrphanedRepoIngressFencesAtStartup } from './repo-fence-recovery.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import { getResponseHandlers, getShutdownCallbacks, type ResponsePayload } from './response-registry.js';

// Upstream host-lifecycle seam (docs/specs/upstream-host-sweep-seam/plan.md §4.1).
// Aborted as the first shutdown action so `HostStartContext.signal` carries real
// semantics for any module that registers a start callback.
export const hostAbortController = new AbortController();

/**
 * Dedupe marker for the boot-time build-drift alert (see the drift check in
 * `main()`, below). Mirrors the small-JSON-state-file idiom already used for
 * boot-time markers (`daily-summary.ts`'s STATE_PATH, `deploy-crash-guard.ts`'s
 * attempts/manifest files): a marker under `data/` (gitignored), read/write
 * wrapped so a corrupt or unwritable file degrades to "alert again" rather
 * than blocking boot. Holds just the last-alerted (buildSha, headSha) pair —
 * nothing else is needed to decide "have we already told the owner about
 * this exact drift".
 */
interface BuildDriftAlertState {
  buildSha: string;
  headSha: string;
}

const BUILD_DRIFT_ALERT_STATE_PATH = path.join(DATA_DIR, 'build-drift-alert.json');

/** Never throws — a corrupt or missing marker reads as "no prior alert". */
function readBuildDriftAlertState(): BuildDriftAlertState | null {
  try {
    return JSON.parse(fs.readFileSync(BUILD_DRIFT_ALERT_STATE_PATH, 'utf8')) as BuildDriftAlertState;
  } catch {
    return null;
  }
}

/** Best-effort; never throws. A failed write just means the next boot re-alerts. */
function writeBuildDriftAlertState(state: BuildDriftAlertState): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BUILD_DRIFT_ALERT_STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    log.warn('build-drift: could not write dedupe marker (may re-alert next boot)', { err: String(err) });
  }
}

/**
 * Boot-time build-drift check: does the running build match the checkout?
 * Never throws and never blocks boot — a stale build is wrong, not unsafe,
 * and a refusal here would take the fleet down for it. See describeBuildDrift
 * (build-info.ts) for what "drift" means and why it matters more than plain
 * staleness (agent-runner source activates on a restart; host src/ does not).
 *
 * Dedupe: a crash-looping host would otherwise DM the owner every boot for
 * the same stale build, so the owner is only messaged again once the
 * (buildSha, headSha) pair actually changes from the last recorded alert.
 * The WARN log line, by contrast, is unconditional on every drifted boot —
 * it costs nothing and belongs in the logs every time.
 */
async function checkBuildDrift(buildInfo: ReturnType<typeof readBuildInfo>): Promise<void> {
  try {
    const headSha = readCheckoutHead(REPO_ROOT);
    const drift = describeBuildDrift(buildInfo, headSha);
    if (!drift) return;

    // The WARN is unconditional: the mismatch is true and the log is cheap.
    log.warn(drift.msg, drift.data);

    const buildSha = buildInfo!.sha;
    const head = headSha!;

    // The DM is not. This checkout is pulled through the day without a rebuild
    // always following, so a sha mismatch is the normal state — DMing on every
    // one would fire on nearly every boot, and an alert that noisy gets muted.
    // A null diff means git could not tell us; treat that as material and
    // alert, because an unreadable diff is not evidence of safety.
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
      // Only a verified delivery is recorded. Stamping the marker before the
      // send would remember a FAILED alert as sent and never retry it — the
      // same false-receipt defect that muted host alerting for three days
      // (fork #538, PR #556).
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

/**
 * Load .env file values into process.env, without overriding vars already set.
 * Mirrors V1's readEnvFile behavior — needed so ANTHROPIC_BASE_URL,
 * ANTHROPIC_API_KEY, and other env-driven config flows work even when
 * the host is started without those vars in the shell environment.
 */
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

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// Orchestrator-dispatch reconciler startup hook — called from main() AFTER initDb,
// since the reconciler queries the central DB.
import { runReconcilerOnStartup as runDispatchReconcilerOnStartup } from './modules/orchestrator-dispatch/index.js';

// Workgroup FS reconciler — drains the migration-036 report after migrations.
import { reconcileWorkgroupFsState } from './modules/workgroup/fs-reconcile.js';
import {
  reconcileWorkgroupMemory,
  reconcileWorkgroupSharedDirs,
  sharedDirsReconcileWouldChange,
  workgroupMemoryReconcileWouldChange,
  type WorkgroupMemoryReport,
} from './modules/workgroup/shared-dirs.js';
import { WORKGROUP_SHARED_FS } from './config.js';
// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
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
 * Canonical-memory reconciliation for the workgroups the boot door proved
 * quiescent.
 *
 * It no longer stops anything: `cleanupOrphansStrict()` moved out to
 * `quiesceWorkgroupsForBootMountChange`, which runs once, ahead of every
 * reconcile, and proves its own scope (plan §7.D). This gate is now the
 * runtime check plus the cutover, and it must never be called from outside a
 * quiescence door — src/workgroup-reconcile-doors.test.ts pins that.
 */
export function runWorkgroupMemoryStartupGate(
  db: Database.Database,
  deps: {
    /**
     * Confines the cutover's WRITES to the workgroups the boot door proved
     * quiescent. Every workgroup is still reported: `main()` derives the
     * pending-pre-turn-context targets and the migration-required operator
     * warnings from these reports, and an ordinary boot changes nothing, so
     * scoping the report set would silently skip both on almost every start.
     */
    mutateWorkgroupIds?: string[];
    ensureRuntime?: () => void;
    reconcile?: (db: Database.Database, dirs: { mutateWorkgroupIds?: string[] }) => WorkgroupMemoryReport[];
  } = {},
): WorkgroupMemoryReport[] {
  (deps.ensureRuntime ?? ensureContainerRuntimeRunning)();
  return (deps.reconcile ?? reconcileWorkgroupMemory)(db, { mutateWorkgroupIds: deps.mutateWorkgroupIds });
}

/** Seams the boot mount-change block injects in tests; real work by default. */
export interface BootMountQuiescenceDeps {
  workgroupIds?: (db: Database.Database) => string[];
  memoryWouldChange?: (db: Database.Database, workgroupId: string) => boolean;
  sharedWouldChange?: (db: Database.Database, workgroupId: string) => boolean;
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
  reconcileShared?: (db: Database.Database, dirs: { workgroupIds?: string[] }) => void;
  memoryGate?: (db: Database.Database, opts: { mutateWorkgroupIds?: string[] }) => WorkgroupMemoryReport[];
  prune?: () => void;
  fatal?: (message: string, err: unknown) => never;
}

/**
 * The sessions whose containers a boot leaves running, as the fail-closed seed
 * adoption holds pending when its own inventory cannot be taken (seam 4 E,
 * `heldOnInventoryFailure`). Under D2 the door's returned survivors ARE the
 * post-stop inventory — the containers it proved still running after its
 * last pass — so they are the seed directly. Not inferred from the counts: a
 * newcomer stopped in the second pass makes `stopped` reach `containers`
 * while the final partition still holds survivors, and those must be held
 * (owned, leased, counted) rather than left unprotected. A door that stopped
 * everything returns no survivors, and the seed is then empty on its own.
 * Exported for the unit test only.
 */
export function adoptionSeedFor(scope: Pick<BootQuiescenceScope, 'survivableSessionIds'>): string[] {
  return [...scope.survivableSessionIds];
}

function bootFatal(message: string, err: unknown): never {
  log.error(message, { err });
  process.exit(1);
}

/**
 * The boot mount-change block: decide the scope, prove it, then reconcile.
 *
 * Order is the safety argument (plan §4.1, §7.D), and every step of it is
 * asserted in src/boot-quiescence-order.test.ts:
 *
 *   1. warn sessions still marked 'running' by an unclean previous host —
 *      BEFORE anything is stopped, which is where `main()` has always had it,
 *      and it is DB-only so it stays ahead of every docker call;
 *   2. probe the container runtime, bounded, before the door's unbounded
 *      inventory — the order main has;
 *   3. evaluate the predicates once, as the door's input;
 *   4. quiesce — the ONLY thing that stops containers at boot, and it throws
 *      before anything below runs if it cannot prove its scope is down;
 *   5. the door re-evaluates the predicates on the now-quiescent tree and
 *      partitions against THAT answer; the same set drives the reconciles.
 *      Group directories are container-writable, so the pre-stop snapshot can
 *      be stale by the time the stops finish, and a scope built from it would
 *      call a flipped workgroup's sessions survivable;
 *   6. shared-FS consolidation, scoped to the post-stop set. It used to run
 *      BEFORE the quiescence proof (plan §3.5, divergence 4), masked only by
 *      the flag defaulting off;
 *   7. canonical-memory cutover, scoped to the same set;
 *   8. snapshot pruning, after both cutovers.
 *
 * Steps 2 and 3 are swapped relative to §7.D's listed order, deliberately: the
 * plan's order writes the accountability note after the stops, so a door that
 * fails part way through them would leave the sessions it already killed with
 * no note at all. Warning first is what `main()` did before this PR.
 *
 * D1 measures: `quiesceWorkgroupsForBootMountChange` still stops the whole
 * install regardless of the scope it computes, so this boot behaves exactly
 * as the one before it. The scope decision runs in production, and its
 * `survivable` count is the milestone-1 counterfactual, before D2 is allowed
 * to act on it.
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
  const memoryWouldChange = deps.memoryWouldChange ?? workgroupMemoryReconcileWouldChange;
  const sharedWouldChange = deps.sharedWouldChange ?? sharedDirsReconcileWouldChange;
  const fatal = deps.fatal ?? bootFatal;

  const allWorkgroupIds = listWorkgroupIds(db);
  // D2 note (not built — see initializeManagedGitHooks's own call site in
  // startNanoClaw, and its module's doc comments): once a D2 survivable-
  // container path exists, THIS predicate is where "this workgroup's wiki
  // repo's core.hooksPath is about to change" must also count as a mount
  // change — a survivor that keeps its pre-migration `.git/config` file
  // mount would otherwise carry no hook at all until its next respawn. That
  // check has to be computed here, BEFORE the door runs (same
  // changedBeforeQuiescence snapshot timing as the other two predicates),
  // even though the actual hooksPath write happens AFTER the door returns
  // (initializeManagedGitHooks runs later in startNanoClaw, once this
  // function's stops are known to be done).
  const evaluateChanged = (): string[] =>
    allWorkgroupIds.filter((id) => memoryWouldChange(db, id) || (sharedFsEnabled && sharedWouldChange(db, id)));

  // Bounded probe BEFORE the unbounded inventory, which is the order main has.
  // There `ensureContainerRuntimeRunning()` (a 10 s-timeout `docker info`) ran
  // immediately ahead of `cleanupOrphansStrict()`; here the door's
  // `listInstallContainersWithScope` is an unbounded `docker ps`, so without
  // this a stalled daemon hangs the boot instead of failing it. The memory
  // gate keeps its own call: idempotent, and fast when the daemon is healthy.
  (deps.ensureRuntime ?? ensureContainerRuntimeRunning)();

  // The pre-stop evaluation is the door's INPUT, and nothing more. The group
  // directories these predicates read are bind-mounted writable into live
  // containers, so a still-running agent can flip a workgroup from settled to
  // needs-reconcile between this snapshot and the stops completing.
  const changedBeforeQuiescence = evaluateChanged();

  // One read, for the door's known-session test. A container whose session row
  // is gone or archived has nothing for adoption to resolve, so it can never
  // be classified survivable.
  const knownSessionIds = await (
    deps.activeSessionIds ?? (async () => (await getActiveSessions()).map((session) => session.id))
  )();

  // The startup warn runs INSIDE the door, after its pre-stop partition and
  // before its first stop (`beforeStop`): the note is written from the session
  // rows an unclean previous host left marked 'running', and under D2 it must
  // skip the survivors — their containers are not interrupted, and the note
  // says they were. That skip set exists only once the door has listed and
  // partitioned, and the note still has to precede the stop pass, which can
  // outlast the heartbeat freshness window (#441). A door that dies half way
  // through its stops leaves the note already written for every must-stop
  // session; a door whose listing fails writes none, and the boot fails there.
  // The door calls it a second time only when its post-stop re-evaluation
  // moved sessions INTO must-stop: those were skipped by the first note as
  // survivable and are about to be interrupted after all, so they — and only
  // they — get theirs then (the skip set is every other known session).
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
    // Re-run on the quiescent tree. The door partitions against THIS answer,
    // so the scope it returns and the cutover below can never disagree about
    // which workgroups changed.
    reevaluateChanged: evaluateChanged,
    beforeStop,
  });

  // The authoritative set: one evaluation, inside the door, after the proof.
  // A workgroup that flipped while the stops were in flight is in it, so it is
  // reconciled here and is must-stop in the partition — never left out of both.
  const changedWorkgroupIds = scope.changedWorkgroupIds;
  const flipped = changedWorkgroupIds.filter((id) => !changedBeforeQuiescence.includes(id));
  log.info('Boot quiescence rescope', {
    changedBefore: changedBeforeQuiescence.length,
    changedAfter: changedWorkgroupIds.length,
    // Non-empty means a live agent wrote to a group directory while the door
    // was stopping it. Harmless under D1; under D2 it is the case the door's
    // own re-validation has to cover (see quiesceWorkgroupsForBootMountChange).
    ...(flipped.length > 0 ? { flipped } : {}),
  });

  // Workgroup shared-FS consolidation — flag-gated (NANOCLAW_WORKGROUP_SHARED_FS,
  // default off). Moves each workgroup's shared dirs into data/workgroups/<id>/
  // (bind-mounted at /workspace/workgroup). Idempotent + fail-closed.
  if (sharedFsEnabled) {
    try {
      (deps.reconcileShared ?? reconcileWorkgroupSharedDirs)(db, { workgroupIds: changedWorkgroupIds });
    } catch (sharedErr) {
      fatal('Workgroup shared-FS consolidation failed at startup', sharedErr);
    }
  }

  const memoryReports = (deps.memoryGate ?? runWorkgroupMemoryStartupGate)(db, {
    mutateWorkgroupIds: changedWorkgroupIds,
  });

  // Prune old agent-runner-source snapshots now that the boot door above has
  // stopped every container left running by an unclean previous host — pruning
  // any earlier is unsafe (a bind mount pins the directory, not its entries).
  // `defaultReferencedPaths` reads docker rather than the in-process registry
  // (src/agent-runner-source.ts), so this stays correct under D2, when an
  // adopted container is a live reference this call must not delete out from
  // under.
  (deps.prune ?? pruneAgentRunnerSnapshots)();

  return { changedWorkgroupIds, scope, memoryReports };
}

/**
 * Which fields `onMetadata`'s one-shot channel-metadata discovery should
 * persist for a channel it just saw.
 *
 * `is_group` is a plain refresh — one boolean, one writer, nothing to lose.
 *
 * `name` is the interesting one, because two writers produce it and they are
 * not equally informed. `reportChannelMetadata` (chat-sdk-bridge.ts) does a
 * generic per-channel fetch and reports whatever raw string the platform hangs
 * on the conversation. The classification seam (`resolveConversation` /
 * `resolveChannelName`, run by the approval flow in channel-approval.ts and by
 * the router's auto-wire) can enrich that: a Slack MPDM's platform-side name is
 * an internal `mpdm-alice--bob--carol-1` slug, and the classifier replaces it
 * with the participant roster a human would recognize. The raw fetch has no way
 * to produce that answer and no way to know it is undoing one — which is why,
 * before provenance, every host restart quietly overwrote the roster name with
 * the slug again.
 *
 * So the decision is not made by looking at the name. It is made by comparing
 * where the incoming value came from with where the stored value came from,
 * via `channelNameProvenanceAccepts` (db/messaging-groups.ts), which owns the
 * invariant and the ordering. `onMetadata` is always an `adapter`-sourced
 * refresh on its own adapter's platform.
 *
 * Wiring status deliberately plays no part any more. The old rule ("unwired →
 * set-once, wired → refresh") existed only to settle the race between these two
 * writers on a channel's first inbound event; provenance settles it directly
 * and in the same direction regardless of who wins the network round trip, so
 * the wiring test is gone along with the `isWired` argument.
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

  const buildInfo = readBuildInfo(REPO_ROOT);
  if (buildInfo) {
    const { msg, data } = formatBuildInfoLog(buildInfo);
    log[buildInfo.dirty ? 'warn' : 'info'](msg, data);
  } else {
    log.warn('dist/BUILD_INFO.json missing — cannot report build provenance (older dist, or a dev run)');
  }

  // 0. Claim exclusive host ownership before any startup work that can
  // mutate shared state. The socket binds early but remains not-ready until
  // every existing boot gate has completed below.
  await startCliServer();

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // Does the running build match the checkout? WARNs and DMs the owner on
  // drift; never blocks boot (see checkBuildDrift's own doc comment).
  //
  // Deliberately below both gates above, not beside the provenance log it
  // reads. It sends an outbound DM and writes a shared dedupe marker, which
  // is exactly the "startup work that can mutate shared state" the ownership
  // claim exists to fence: two hosts racing to start would otherwise both
  // alert and both write the marker before one of them is rejected. Running
  // after the circuit breaker also means a crash-looping host is throttled
  // before it can message anyone.
  await checkBuildDrift(buildInfo);

  // 0a. Load .env into process.env (for secrets not injected by the shell,
  //     like ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY which determine whether
  //     we use direct proxy or OneCLI gateway). Does NOT override vars already
  //     in the process environment — shell-set values take precedence.
  loadEnvIntoProcess();

  // 0b. Register secret values from .env for outbound scrubbing.
  registerSecretsFromEnv();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  await initDb(dbPath);
  // The migration runner stays synchronous on the raw handle (plan §4.3
  // amendment): it runs at boot with no concurrent central-DB activity, and
  // the boot-time workgroup reconcilers below take the same handle.
  const db = getRawDb();
  runMigrations(db);

  // 1-a. Register this host process in `host_instances` and start renewing
  // its lease. Ahead of everything that can spawn, so the row exists before
  // any container work; write-only shadow state — nothing reads it yet
  // (docs/specs/upstream-restart-survival-seam/plan.md §7.A). Through
  // `shadowWrite` for the same reason: a failed INSERT (contention, a locked
  // file) must log and let boot continue, never turn shadow state into a
  // startup dependency. The double-start throw is unreachable here (one call).
  await shadowWrite('host instance lease start', () => startHostInstanceLease({ leaseTtlMs: HOST_LEASE_TTL_MS }));
  const hostInstanceId = getHostInstanceId();
  if (hostInstanceId) {
    // Plan §6 series-A evidence: exactly one per boot, instance id + ttl. Its
    // absence after a boot means the registration failed (WARN above).
    log.info('Host instance lease started', { instanceId: hostInstanceId, ttlMs: HOST_LEASE_TTL_MS });
  }

  // 1-0. Materialize the archive schema before ANY service that can spawn.
  //
  // `archive_row_marks` and its triggers are created by the archive's lazy
  // open, which fires on the first archive WRITE. Until they exist every
  // projection freshness stamp reports an unknown mutation count and fails
  // closed, so every spawn does the full 19 s rebuild #360 exists to remove.
  //
  // Ahead of the dashboard for the same reason the OneCLI preflight below is:
  // `startDashboard()` exposes endpoints that reach `wakeContainer` — a
  // scheduled task's run-now, for one — so a dashboard-triggered spawn during
  // the window would rebuild, and so would every spawn until unrelated chat
  // traffic happened to open the archive. Ahead of channel recovery too, which
  // archives messages: otherwise the one-time "Archive row-marks schema
  // created" line would land from a recovery thread on some boots and from
  // here on others, which is useless as a deploy gate.
  //
  // Nothing above this point can spawn, and the archive is a standalone file
  // that depends only on DATA_DIR, so this is the earliest honest position.
  ensureArchiveSchema();

  // Snapshot the agent-runner source for this boot (mailbox seam PR 0) —
  // must happen before anything can spawn a container, so every spawn this
  // process makes mounts the same tree, not the live checkout mid-`git pull`.
  activateAgentRunnerSource();

  await resetProcessingChannelIngress();

  // Workgroup FS reconciliation — runs after migrations to drain the
  // _migration036_report temp table. On FS failure, exit; restart is the recovery
  // (reconciler is idempotent).
  try {
    reconcileWorkgroupFsState(db);
  } catch (fsErr) {
    log.error('Workgroup FS reconciliation failed at startup', { err: fsErr });
    process.exit(1);
  }

  // Boot mount-change block: scope → quiescence proof → both reconciles →
  // snapshot prune. Nothing here mutates a mount before the proof returns; a
  // listing failure or a stop that does not take throws out of startup, which
  // is what "prove install-scoped container absence" has always meant.
  const { scope, memoryReports } = await runBootMountQuiescence(db);

  // Two resets of the previous host's residue, BEFORE adoption — both are
  // "everything the last host marked is stale", which is true only until
  // adoption re-marks what survived (src/adoption-order.test.ts pins the
  // order). The storage-activity markers and cleanup claims: adoption takes a
  // fresh lease for every survivor, and a reset after it would strip exactly
  // that marker and let the storage manager clean a root a survivor is using.
  resetStorageActivityState();
  // The phantom `container_status` rows: before adoption every 'running' row
  // is a previous host's, and the sweep would otherwise waste ticks enforcing
  // SLA against containers that no longer exist; adoption then writes
  // `running` for the sessions it took over, and a reset after it would flip
  // them back to 'stopped' while their containers run.
  const resetCount = await resetPhantomContainerStatus();
  if (resetCount > 0) {
    log.info('Reset phantom container_status rows on startup', { count: resetCount });
  }

  // Adopt the containers the boot door left running (seam 4 series E, plan
  // §7.E). Immediately after the door's return, and before every wake source
  // (the dashboard, the channel adapters, the sweep, delivery) and before the
  // orphaned-fence recovery below — src/adoption-order.test.ts pins both: no
  // wake can spawn a second container beside an untracked survivor, and the
  // recovery still runs against its premise (a fresh process holds no mount
  // claims, so every active fence it finds is orphaned).
  //
  // The candidate set is the door's own partition, `survivableSessionIds` —
  // the same set the startup warn skips. Under D1 that partition is computed
  // AFTER the stops and the door still stops the survivable containers too, so
  // the set is empty and this adopts nothing until D2 flips the stop set. D2
  // also needs a PRE-stop partition for the warn's skip set (the door's D2
  // note); this post-stop one is the adoption contract.
  //
  // If adoption's own inventory then fails, the fail-closed seed is only what
  // the door actually LEFT running (`adoptionSeedFor`): under D2 that is the
  // post-stop survivable set; a boot that stopped everything seeds nothing.
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
      // A session DB the pass could not read no longer stops startup, so it has
      // to be loud instead. Counts, not silence: a rising `skipped` is the shape
      // of a systemic problem that a per-session error line would bury.
      log.warn('Startup reconciliation could not process every session DB', pendingUpgrade);
    }
    if (pendingUpgrade.admitted > 0) {
      log.info('Admitted pending pre-turn contexts during startup', pendingUpgrade);
    }
  } catch (pendingErr) {
    log.error('Pending pre-turn context reconciliation failed at startup', { err: pendingErr });
    process.exit(1);
  }

  // Incident 2026-09-01: a failed repository publication left 1401 session
  // inbound DBs fenced with no publication left to release them, and the
  // workgroup went silently deaf. The mount/lifecycle claims that mark a
  // publication "in flight" are process-local Sets (src/repository-workspaces.ts),
  // so a fresh process holds none: every active fence found here belongs to a
  // publication that died with the previous process and is orphaned by
  // definition. Per-session failures are isolated inside the pass and never
  // exit the process — a fence is a liveness problem, not a boot invariant.
  try {
    const fences = await releaseOrphanedRepoIngressFencesAtStartup();
    if (fences.released > 0 || fences.failed > 0) {
      // An adopted session behind an active fence is one of these releases;
      // the count from adoption makes that visible beside the release count.
      log.warn('Released orphaned repository ingress fences at startup', {
        ...fences,
        adoptedWithActiveFence: reconciled.fencedInbound,
      });
    }
  } catch (fenceErr) {
    log.error('Orphaned repository ingress fence recovery failed at startup', { err: fenceErr });
  }

  log.info('Central DB ready', { path: dbPath });

  // 1-bis. OneCLI control-API preflight — the credential call every spawn
  // makes, once, before ANY ingress opens. A control API this process cannot
  // reach means every spawn is refused at WARN and the fleet goes silently
  // deaf (2026-09-02: 11 minutes, 0/8 spawns, a clean-looking boot).
  //
  // Ahead of the dashboard and the channel adapters deliberately: past that
  // point an inbound message can reach routeInbound() and wake a container
  // while the probe is still retrying, which both contends with the probe and
  // means the exit below would kill a host that has already accepted work.
  // Failing here logs ERROR and exits non-zero BEFORE markDeployBootHealthy(),
  // so the unit-failure alert fires and the deploy stays rollback-eligible.
  await runOnecliBootPreflight();

  // 1-ter. Host-managed pre-push secret-scan hooks: refresh the boot-snapshot
  // directories and run the scan-policy core.hooksPath migration pass. Must
  // run after runBootMountQuiescence (the boot door may stop containers
  // whose workgroup's mounts are about to change — see its own D2 note
  // above) and before startDashboard()/honorPendingStopIntents()/
  // initChannelAdapters() below, all three of which can already trigger a
  // spawn. A spawn that mounts a scan-policy (wiki) repo depends on this
  // having already run at least once THIS process
  // (resolveScanPolicyHooksMount -> decideHooksMountStrategy in
  // container-runner.ts/managed-git-hooks.ts falls back to the refuse
  // hook, never throws the whole spawn, when it hasn't — see
  // managed-git-hooks.ts's own doc comments on why this is a direct call
  // here, not an onHostStart registrant with the six timer modules below).
  initializeManagedGitHooks();

  // Host-computed upstreamPin/heldByMerge snapshot for the container-updates
  // audit. Containers can't derive this themselves (/workspace/project has no
  // `.git`), so the host computes it here where git works and refreshes it
  // again in handleUpdateContainer before each interactive audit. Best-effort:
  // log and continue, never block boot on a dependency-audit side channel.
  try {
    await writeUpstreamPolicySnapshot(REPO_ROOT, path.join(DATA_DIR, 'upstream-policy.json'));
  } catch (err) {
    log.error('Upstream policy snapshot failed at startup', { err });
  }

  // 1a. Start dashboard — after migrations (028 must exist) and before
  //     channel adapters so the HTTP server is up regardless of channel config.
  startDashboard();

  // 1b. Orchestrator-dispatch reconciler startup scan — must run after migrations
  // so the tasks table exists. Recovers any tasks left in 'pending' with
  // admitted_at set but no child_session_id (host crashed mid-completion).
  await runDispatchReconcilerOnStartup();

  // 1c. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  await backfillContainerConfigs();

  // 1d. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. (The storage-activity reset moved ahead of adoption, above.)

  // 2-bis. Resolve any session archival a previous stop interrupted, before
  // the sweep can hand out work to a row still parked in 'archiving'.
  try {
    await finishInterruptedSessionArchivals();
  } catch (err) {
    log.error('Interrupted session archival recovery failed', { err });
  }

  // 2-ter. Drain the pending rows left in sessions closed before S19 learned
  // to expire them (#520). Bounded and self-draining — a session whose rows
  // are expired stops pinning `sessionHasOpenWork`, reclaim removes its
  // directory, and the next boot skips it on a statSync. Non-fatal.
  try {
    await drainClosedSessionPendingBacklog();
  } catch (err) {
    log.error('Closed-session pending backlog drain failed', { err });
  }

  // 2a. Surface agent-runner deps drift at boot, not when an agent silently
  // stops responding. Non-fatal — the hard gate lives in spawnContainer, this
  // is just an early operator signal.
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

  // 2a. (The phantom container_status reset moved ahead of adoption, above.)

  // 2b. Re-issue any restart a previous host ordered but did not live to
  // finish. `respawn_after_stop` is the durable half of a kill whose respawn
  // was only ever a process-memory callback, so this is where "rebuild
  // applied" with nothing coming back gets recovered.
  //
  // This is the FIRST thing in startup that may deliberately spawn a
  // container, so it sits below every startup-only reset and every pre-spawn
  // gate, and `src/stop-intent-recovery.test.ts` pins that order:
  //
  //   - `resetStorageActivityState()` recursively deletes the active-lease
  //     directory. Above it, a recovery spawn's own lease is deleted out from
  //     under the live container it belongs to.
  //   - `resetPhantomContainerStatus()` rewrites every `running` row to
  //     `stopped` on the premise that no container survived the restart.
  //     Above it, the recovery's fresh container is flipped to `stopped` while
  //     it runs, and the sweep then reasons about a session it cannot see.
  //   - `runOnecliBootPreflight()` proves the credential API every spawn calls.
  //   - `releaseOrphanedRepoIngressFencesAtStartup()` treats every active fence
  //     as orphaned because a fresh process holds no mount claims. A spawn
  //     above it can break that premise; below it, nothing does.
  //
  // E integration (seam4/e-adoption): E's `adoptRunningSessions()` lands
  // earlier, right after D1's boot door, and E moves the two resets above it.
  // Either way this call stays BELOW adoption, which is the ordering that
  // matters: a survivor must be registered and claim-fenced before an intent
  // against it is acted on, and a session still awaiting its fence is skipped
  // here rather than killed at the wrong incarnation.
  //
  // E also leaves a `// F2 hook` marker at the END of `adoptRunningSessions`,
  // and this call deliberately does NOT move there: it can spawn, and adoption
  // must stay a pure inventory pass with no wake inside it. §7.F says `main()`.
  // The recovery wake goes through the seam like every other wake (T0 PR 3
  // gate): the module-internal default exists for the unit tests, main()
  // injects requestWake so a recovered restart records the same wake signal a
  // live one does.
  await honorPendingStopIntents((session) => requestWake(session, 'container-restart'));

  // 3. Channel adapters
  // Gateway READY can arrive while adapters are still initializing. Hold its
  // recovery callback until every adapter identity, the sibling allow-list,
  // and the delivery bridge are ready.
  let releaseChannelRecoveryReady!: () => void;
  const channelRecoveryReady = new Promise<void>((resolve) => {
    releaseChannelRecoveryReady = resolve;
  });
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        // The event shape — instance stamping and the trust-bearing
        // `nativeId` — is built by the ingress producer, so it is testable
        // against the real router rather than only reachable from here.
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
        // The provenance check runs again INSIDE the write (#416 site 5): the
        // read above and this write are separated by an await, and the
        // router's classified name may land between them.
        await applyChannelMetadataUpdates(mg.id, updates, incoming);
        log.info('Channel metadata persisted', {
          channelType: adapter.channelType,
          platformId,
          mgId: mg.id,
          updates,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });
  // Wire the access gate's sibling-bot allow-list now that channel adapters are
  // up and their known-bot registries are populated. A message authored by one
  // of our own bots (Example Agent, Example Agent-Codex, Example Agent-OpenCode, …) is then allowed to
  // engage siblings even under a `strict` messaging group — without this, a
  // strict mg drops sibling @-mentions as `not_member` and cross-agent handoff
  // silently fails (only owner/admins/members get through). Dynamic imports so
  // a build without a given channel adapter still links; the provider reads the
  // registries live, so it reflects later identity fetches too.
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

  // 4. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. The factory now
  // also carries our support-thread surfaces (deleteMessage/postParent/
  // createThread). See createChannelDeliveryAdapter in channel-registry.ts.
  setDeliveryAdapter(createChannelDeliveryAdapter());

  // 4a. The `ncl` socket has been bound and refusing a second host since
  // the pre-DB ownership step above, but it has been refusing every request with `not-ready`
  // until now: everything that can mutate central-DB state on this process's
  // behalf — archive init, FS reconciliation, the OneCLI preflight,
  // container-config backfill, channel adapters, and the delivery bridge
  // just above — has to be up first, or an `ncl` call racing them could read
  // or write into state that is still mid-setup (PR #453 review, round 2).
  markCliServerReady();

  // 4b. Host module lifecycle (upstream seam) — modules register onHostStart/
  // onHostShutdown callbacks at import time; this is where registered start
  // work actually begins (docs/specs/upstream-host-sweep-seam/plan.md §4.1).
  // PR 0 registers nothing, so this is inert by construction.
  await startHostModules({ db: getDb(), signal: hostAbortController.signal });

  // Start recovery only after permissions and delivery are fully wired. A
  // replay can immediately exercise either surface (sibling bots, unknown
  // sender/channel approval), so it must not race partial host startup.
  releaseChannelRecoveryReady();
  void recoverAllChannelsAfterStartup(Date.now() - 10 * 60 * 1000)
    .then(() => {
      log.info('Initial channel recovery pass finished');
    })
    .catch((err) => {
      // Per-adapter failures schedule their own retry; this guard reports an
      // unexpected aggregate failure without affecting live ingress.
      log.error('Initial channel recovery coordinator failed', { err });
    });
  startChannelRecoveryMonitor();

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7–10b. Worktree cleanup, repo freshness, plugin updater, commit scan,
  // daily summary, and backlog canvas each start themselves via onHostStart
  // — see src/host-lifecycle.ts and each module's own registration.

  // 11. Restore any Remote Control session that was running before restart
  restoreRemoteControl();

  // 12. Start Discord slash-command client (gated on
  //     ENABLE_DISCORD_SLASH_COMMANDS=1).
  startDiscordSlashCommands().catch((err) => {
    log.error('Discord slash commands failed to start', { err });
  });

  // Startup completed — the deploy that produced this build is good; disarm
  // the crash-loop rollback guard.
  markDeployBootHealthy();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  // Upstream host-lifecycle seam: abort registered modules' signal, then run
  // their onHostShutdown callbacks LIFO, before any other shutdown work
  // (docs/specs/upstream-host-sweep-seam/plan.md §4.1).
  hostAbortController.abort();
  await stopHostModules();
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopChannelRecoveryMonitor();
  // Worktree cleanup, repo freshness, plugin updater, commit scan, daily
  // summary, backlog canvas, and storage-maintenance stop themselves via
  // stopHostModules() above (each guards its own stop failure).
  await stopDiscordSlashCommands();
  // Stop accepting CLI requests before teardown, but keep the kernel claim
  // until process exit. A replacement host must not open or migrate the
  // central DB while this process is still tearing it down.
  await stopCliServer({ retainOwnership: true });
  try {
    await teardownChannelAdapters();
    // Warn mid-work sessions before their containers are stopped: the
    // on_wake note (due immediately) makes the post-restart spawn account
    // for the interruption publicly instead of the session going dark.
    try {
      // The stopping set is the door's own plan, asked before the door runs
      // (series E, door 1): under it no running container is stopped, so this
      // is the empty set and adopted-to-be sessions get no interruption note.
      // Sessions the unit's `ExecStop` still stops until the unit-file doors
      // land get none either — accepted, the doors ship on one restart.
      await warnActiveContainersOfShutdown('graceful host shutdown', planContainerShutdown());
    } catch (err) {
      log.error('host-restart shutdown warn failed', { err });
    }
    // Door 1 (plan §4.3.5): close the spawn path and let in-flight wakes
    // settle, but leave running containers ALONE — the next host adopts them.
    // This used to be `stopAllContainers()`, added because lingering client
    // children stalled systemd for `TimeoutStopSec` on every restart; the unit
    // now carries `KillMode=mixed` (the client children are reaped by systemd
    // once this process exits, without touching the daemon-owned containers)
    // and no `ExecStop` sweep, which is what makes leaving them alive here
    // both safe and observable. Both unit-file lines are the other two doors;
    // rollback restores them FIRST (plan §5).
    try {
      await beginContainerShutdown();
    } catch (err) {
      log.error('beginContainerShutdown threw', { err });
    }
  } finally {
    // Stamp `stopped_at` FIRST so a graceful exit is durably distinguishable
    // from a crash even if the teardown above threw — in the `try` a throw
    // from teardownChannelAdapters() would skip it and leave the row looking
    // crash-ended for the 90 s lease TTL. Never throws.
    await stopHostInstanceLease();
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

export function isDirectExecution(moduleUrl: string, argvEntry: string | undefined): boolean {
  return !!argvEntry && pathToFileURL(path.resolve(argvEntry)).href === moduleUrl;
}

/**
 * Start the service: signal handlers + main(). Called by the entry bootstrap
 * (src/index.ts) after the deploy crash guard has run.
 */
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

// Support running src/main.ts directly (e.g. tsx) without the bootstrap;
// the guard is a no-op when no deploy manifest exists.
if (isDirectExecution(import.meta.url, process.argv[1])) {
  startNanoClaw();
}
