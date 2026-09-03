/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { markDeployBootHealthy } from './deploy-crash-guard.js';
import { formatBuildInfoLog, readBuildInfo } from './build-info.js';
import { DATA_DIR, REPO_ROOT } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { registerSecretsFromEnv } from './secret-scrubber.js';
import { getMessagingGroupByPlatform, updateMessagingGroup } from './db/messaging-groups.js';
import { ensureContainerRuntimeRunning, cleanupOrphansStrict } from './container-runtime.js';
import { warnActiveContainersOfShutdown, warnMarkedRunningSessionsOfStartup } from './host-restart-warn.js';
import { resetPhantomContainerStatus } from './db/sessions.js';
import { resetProcessingChannelIngress } from './db/channel-ingress-receipts.js';
import { stopAllContainers } from './container-runner.js';
import { writeUpstreamPolicySnapshot } from './container-updates.js';
import {
  getDeliveryAdapter,
  setDeliveryAdapter,
  startActiveDeliveryPoll,
  startSweepDeliveryPoll,
  stopDeliveryPolls,
} from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { runOnecliBootPreflight } from './onecli-preflight.js';
import { stopStorageMaintenanceWorker } from './storage-maintenance-worker.js';
import { resetStorageActivityState } from './storage-activity.js';
import { finishInterruptedSessionArchivals } from './storage-manager.js';
import { startWorktreeCleanup, stopWorktreeCleanup } from './worktree-cleanup.js';
import { startRepoFreshness, stopRepoFreshness } from './repo-freshness.js';
import { startPluginUpdater, stopPluginUpdater } from './plugin-updater.js';
import { startCommitScan, stopCommitScan } from './commit-scan.js';
import { startBacklogCanvas, stopBacklogCanvas } from './backlog-canvas.js';
import { startDailySummary, stopDailySummary } from './daily-summary.js';
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
  type WorkgroupMemoryReport,
} from './modules/workgroup/shared-dirs.js';
import { WORKGROUP_SHARED_FS } from './config.js';
// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';
import type Database from 'better-sqlite3';

export function runWorkgroupMemoryStartupGate(
  db: Database.Database,
  deps: {
    ensureRuntime?: () => void;
    cleanupStrict?: () => string[];
    reconcile?: (db: Database.Database) => WorkgroupMemoryReport[];
  } = {},
): WorkgroupMemoryReport[] {
  (deps.ensureRuntime ?? ensureContainerRuntimeRunning)();
  (deps.cleanupStrict ?? cleanupOrphansStrict)();
  return (deps.reconcile ?? reconcileWorkgroupMemory)(db);
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

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

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
  const db = initDb(dbPath);
  runMigrations(db);
  resetProcessingChannelIngress();

  // Workgroup FS reconciliation — runs after migrations to drain the
  // _migration036_report temp table. On FS failure, exit; restart is the recovery
  // (reconciler is idempotent).
  try {
    reconcileWorkgroupFsState(db);
  } catch (fsErr) {
    log.error('Workgroup FS reconciliation failed at startup', { err: fsErr });
    process.exit(1);
  }

  // Workgroup shared-FS consolidation — flag-gated (NANOCLAW_WORKGROUP_SHARED_FS,
  // default off). Moves each workgroup's shared dirs into data/workgroups/<id>/
  // (bind-mounted at /workspace/workgroup). Idempotent + fail-closed; runs
  // before any container spawn so the filesystem is quiesced during the move.
  if (WORKGROUP_SHARED_FS) {
    try {
      reconcileWorkgroupSharedDirs(db);
    } catch (sharedErr) {
      log.error('Workgroup shared-FS consolidation failed at startup', { err: sharedErr });
      process.exit(1);
    }
  }

  // Canonical memory reconciliation can create links only after install-scoped
  // container absence has been proved. A failed runtime listing is not
  // equivalent to "none running": cleanupOrphansStrict throws and startup
  // stops before any filesystem cutover. FIRST warn sessions still marked
  // 'running' (unclean previous host) that their containers are about to be
  // stopped — the on_wake note makes the next spawn account publicly instead
  // of the session going dark until a human pings.
  try {
    warnMarkedRunningSessionsOfStartup('host startup after an unclean stop');
  } catch (err) {
    log.error('host-restart startup warn failed', { err });
  }
  const memoryReports = runWorkgroupMemoryStartupGate(db);
  for (const report of memoryReports) {
    if (report.state.status === 'migration-required') {
      log.warn('Workgroup memory requires operator migration; automatic startup left it untouched', {
        workgroupId: report.workgroupId,
        sources: report.state.sources,
      });
    }
  }
  try {
    const pendingUpgrade = reconcilePendingUpgradeContexts(
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
      log.warn('Released orphaned repository ingress fences at startup', { ...fences });
    }
  } catch (fenceErr) {
    log.error('Orphaned repository ingress fence recovery failed at startup', { err: fenceErr });
  }

  log.info('Central DB ready', { path: dbPath });

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
  runDispatchReconcilerOnStartup();

  // 1c. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1d. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime was already proved available/quiescent before the
  // canonical memory reconciliation above.
  resetStorageActivityState();

  // 2-bis. Resolve any session archival a previous stop interrupted, before
  // the sweep can hand out work to a row still parked in 'archiving'.
  try {
    finishInterruptedSessionArchivals();
  } catch (err) {
    log.error('Interrupted session archival recovery failed', { err });
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

  // 2a. Reset phantom container_status='running' rows in central DB. Session
  // containers use --rm and don't survive the host restart, so any 'running'
  // row in sessions is stale by definition at this point. Without this, the
  // sweep wastes ticks enforcing SLA against containers that no longer exist
  // (see kill-ceiling / kill-claim warnings against 3-week-old sessions).
  const resetCount = resetPhantomContainerStatus();
  if (resetCount > 0) {
    log.info('Reset phantom container_status rows on startup', { count: resetCount });
  }

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
        return routeInbound({
          channelType: adapter.channelType,
          // The one host-side stamping seam: adapters stay instance-blind,
          // the host stamps the receiving instance on every inbound event.
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          isDM: message.isDM,
          recovered: message.recovered,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
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
      onMetadata(platformId, name, isGroup) {
        const mg = getMessagingGroupByPlatform(adapter.channelType, platformId);
        if (!mg) return; // router hasn't auto-created it yet — next inbound will
        const updates: Parameters<typeof updateMessagingGroup>[1] = {};
        if (name && mg.name !== name) updates.name = name;
        if (isGroup !== undefined) {
          const isGroupFlag = isGroup ? 1 : 0;
          if (mg.is_group !== isGroupFlag) updates.is_group = isGroupFlag;
        }
        if (Object.keys(updates).length === 0) return;
        updateMessagingGroup(mg.id, updates);
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

  // 4a. OneCLI control-API preflight — the credential call every spawn makes,
  // once, before this host starts accepting work. A control API this process
  // cannot reach means every spawn is refused at WARN and the fleet goes
  // silently deaf (2026-09-02: 11 minutes, 0/8 spawns, a clean-looking boot).
  // Failing here logs ERROR and exits non-zero BEFORE markDeployBootHealthy(),
  // so the unit-failure alert fires and the deploy stays rollback-eligible.
  await runOnecliBootPreflight();

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

  // 7. Start worktree cleanup cron (6h, first run 60s after startup)
  startWorktreeCleanup();
  log.info('Worktree cleanup started');

  // 7b. Local-only canonical recovery: advance clean host working trees from
  // refs already fetched by scoped containers (10min, first run 90s).
  startRepoFreshness();
  log.info('Repo freshness worker started');

  // 8. Start plugin auto-updater (hourly, first run 5min after startup)
  startPluginUpdater({
    notify: async (platformId, text) => {
      // Parse the jid format: <channel_type>:<platform_id>[:<thread_id>]
      const parts = platformId.split(':');
      if (parts.length < 2) {
        log.warn('Plugin updater notify: malformed jid', { platformId });
        return;
      }
      const channelType = parts[0];
      const realPlatformId = parts.slice(1).join(':');
      const adapter = getDeliveryAdapter();
      if (!adapter) {
        log.warn('Plugin updater notify: no delivery adapter yet', { platformId });
        return;
      }
      await adapter.deliver(channelType, realPlatformId, null, 'chat', JSON.stringify({ text }));
    },
  });
  log.info('Plugin updater started');

  // 9. Start commit-digest scanner (10min interval, first run 90s after
  //    startup) — records direct commits + external PRs to default branch
  //    as ship_log entries, complementing the agent-driven add_ship_log.
  startCommitScan();
  log.info('Commit scan started');

  // 10. Daily summary digest (5min tick; fires at DAILY_SUMMARY_HOUR in
  //     DAILY_SUMMARY_TZ once per day, posts per-group activity to the
  //     primary wired channel — or container.json's dailySummary
  //     override). Set DAILY_SUMMARY_ENABLED=0 to disable.
  if (process.env.DAILY_SUMMARY_ENABLED !== '0') {
    startDailySummary();
    log.info('Daily summary started');
  }

  // 10b. Live backlog board (5min tick, edits a Slack channel canvas in place).
  //      Opt-in per workgroup via container.json's backlogCanvas; no
  //      declaration anywhere means this loops over nothing.
  if (process.env.BACKLOG_CANVAS_ENABLED !== '0') {
    startBacklogCanvas();
    log.info('Backlog canvas started');
  }

  // 11. Restore any Remote Control session that was running before restart
  restoreRemoteControl();

  // 12. Start Discord slash-command client (gated on
  //     ENABLE_DISCORD_SLASH_COMMANDS=1).
  startDiscordSlashCommands().catch((err) => {
    log.error('Discord slash commands failed to start', { err });
  });

  // 13. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  // Startup completed — the deploy that produced this build is good; disarm
  // the crash-loop rollback guard.
  markDeployBootHealthy();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
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
  try {
    await stopStorageMaintenanceWorker();
  } catch (err) {
    // Worker teardown failure must not prevent channel teardown and container
    // reaping; those children otherwise linger until systemd's hard timeout.
    log.error('Storage maintenance worker failed to stop cleanly', { err });
  }
  stopWorktreeCleanup();
  stopRepoFreshness();
  stopPluginUpdater();
  stopCommitScan();
  stopDailySummary();
  stopBacklogCanvas();
  await stopDiscordSlashCommands();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
    // Warn mid-work sessions before their containers are stopped: the
    // on_wake note (due immediately) makes the post-restart spawn account
    // for the interruption publicly instead of the session going dark.
    try {
      warnActiveContainersOfShutdown('graceful host shutdown');
    } catch (err) {
      log.error('host-restart shutdown warn failed', { err });
    }
    // Synchronously stop agent containers before exit. Without this, child
    // subprocesses linger in the cgroup and systemd TimeoutStopSec stalls
    // every restart. Matches v1's GroupQueue.shutdown semantics.
    try {
      await stopAllContainers();
    } catch (err) {
      log.error('stopAllContainers threw', { err });
    }
  } finally {
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
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
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
