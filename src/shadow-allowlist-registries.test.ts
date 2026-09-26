/**
 * The shadow allowlists against the live registries, populated the way the
 * host populates them: the channel, module and ncl barrels. A name that no
 * longer matches a registration fails here, so a rename cannot silently turn
 * an allowlisted duty off, and every registration the lists do not name is
 * shown to be refused at its seam. Behaviour of each seam with an unknown
 * name: shadow-allowlist.test.ts.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('./shadow-flag.js', () => ({ isShadowProcess: () => flag.on, readShadowFlag: () => flag.on }));

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import './channels/index.js';
import './modules/index.js';
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { getRegisteredChannelNames } from './channels/channel-registry.js';
import { dispatch } from './cli/dispatch.js';
import { listCommands, lookup } from './cli/registry.js';
import { getDeliveryAction } from './delivery.js';
import {
  _dutiesForPhaseForTesting,
  _listSweepRegistrationsForTesting,
  _resetSweepRegistryForTesting,
} from './host-sweep.js';
import { getApprovalHandler } from './modules/approvals/primitive.js';
import {
  SHADOW_APPROVAL_ACTIONS,
  SHADOW_CHANNELS,
  SHADOW_CLI_COMMANDS,
  SHADOW_DELIVERY_ACTIONS,
  SHADOW_HOST_MODULES,
  SHADOW_SWEEP_DUTIES,
} from './shadow-allowlist.js';

afterEach(() => {
  flag.on = false;
});

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('every allowlisted name is a live registration', () => {
  it('sweep duties, SLA hooks and kill follow-ups', () => {
    const { duties, slaObservationHooks, killFollowUps } = _listSweepRegistrationsForTesting();
    const registered = new Set([...duties, ...slaObservationHooks, ...killFollowUps].map((r) => r.name));
    expect([...SHADOW_SWEEP_DUTIES].filter((name) => !registered.has(name))).toEqual([]);
  });

  it('channel adapters', () => {
    const registered = new Set(getRegisteredChannelNames());
    expect([...SHADOW_CHANNELS].filter((name) => !registered.has(name))).toEqual([]);
  });

  it('ncl commands', () => {
    expect([...SHADOW_CLI_COMMANDS].filter((name) => !lookup(name))).toEqual([]);
  });

  it('delivery actions', () => {
    expect([...SHADOW_DELIVERY_ACTIONS].filter((name) => !getDeliveryAction(name))).toEqual([]);
  });

  it('approval replays', () => {
    expect([...SHADOW_APPROVAL_ACTIONS].filter((name) => !getApprovalHandler(name))).toEqual([]);
  });

  it('host-module starts, each registered as a named function the allowlist can name', () => {
    const calls = sourceFiles(path.resolve('src'))
      .filter((file) => !file.endsWith(path.join('src', 'host-lifecycle.ts')))
      .flatMap((file) => fs.readFileSync(file, 'utf8').match(/^\s*onHostStart\(.*/gm) ?? []);
    expect(calls.length).toBeGreaterThan(0);
    const names = calls.map((call) => /^\s*onHostStart\((?:async )?function (\w+)\(/.exec(call)?.[1]);
    expect(calls.filter((_, i) => !names[i])).toEqual([]);
    expect([...SHADOW_HOST_MODULES].filter((name) => !names.includes(name))).toEqual([]);
  });
});

/**
 * Every free-function call in main(), classified. A start added to main()
 * runs outside every registry the allowlists gate, so it fails here until
 * someone decides which kind it is. CHECKOUT: acts only on this checkout's
 * database, data directory, sockets and containers, or only reads. GATED: runs
 * behind the named shadow check, pinned below. The database-handle getters are
 * checkout-scoped by name pattern, so the raw handle is not named here.
 */
const MAIN_CHECKOUT_CALLS = new Set([
  'activateAgentRunnerSource',
  'adapterInboundEvent',
  'adoptRunningSessions',
  'adoptionSeedFor',
  'applyChannelMetadataUpdates',
  'backfillContainerConfigs',
  'bootFatal',
  'checkAgentRunnerDepsDrift',
  'checkBuildDrift',
  'createChannelDeliveryAdapter',
  'drainClosedSessionPendingBacklog',
  'enforceStartupBackoff',
  'enforceUpgradeTripwire',
  'ensureArchiveSchema',
  'enterShadowHostMode',
  'finishInterruptedSessionArchivals',
  'formatBuildInfoLog',
  'getBots',
  'getHostInstanceId',
  'getMessagingGroupByPlatform',
  'honorPendingStopIntents',
  'import',
  'initChannelAdapters',
  'initDb',
  'initializeManagedGitHooks',
  'isShadowHost',
  'loadEnvIntoProcess',
  'makeOnAction',
  'markCliServerReady',
  'markDeployBootHealthy',
  'onConnectionRestored',
  'onInbound',
  'onInboundEvent',
  'onMetadata',
  'readBuildInfo',
  'reconcilePendingUpgradeContexts',
  'reconcileWorkgroupFsState',
  'recoverAllChannelsAfterStartup',
  'recoverChannelAdapter',
  'registerSecretsFromEnv',
  'releaseChannelRecoveryReady',
  'releaseOrphanedRepoIngressFencesAtStartup',
  'requestWake',
  'resetPhantomContainerStatus',
  'resetProcessingChannelIngress',
  'resetStorageActivityState',
  'resolveChannelMetadataUpdates',
  'restoreRemoteControl',
  'routeInbound',
  'runBootMountQuiescence',
  'runDispatchReconcilerOnStartup',
  'runMigrations',
  'runOnecliBootPreflight',
  'setDeliveryAdapter',
  'setSiblingBotIdsProvider',
  'shadowMayStartChannel',
  'shadowWrite',
  'startActiveDeliveryPoll',
  'startChannelRecoveryMonitor',
  'startCliServer',
  'startDashboard',
  'startHostInstanceLease',
  'startHostSweep',
  'startSweepDeliveryPoll',
  'writeUpstreamPolicySnapshot',
]);
const MAIN_GATED_CALLS: Record<string, string> = {
  startDiscordSlashCommands: "if (shadowMayStartChannel('discord')) {\n    startDiscordSlashCommands()",
  startHostModules: 'else await startHostModules(',
  startShadowHostModules: 'if (isShadowHost()) await startShadowHostModules(',
};

function mainCalls(source: string): string[] {
  const head = 'export async function main(): Promise<void> {';
  const start = source.indexOf(head);
  const end = source.indexOf('\n}\n', start);
  const body = source
    .slice(start + head.length, end)
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g, "''");
  const names = new Set([...body.matchAll(/(?<![\w.$])(?<!new )([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]));
  for (const keyword of [
    'if',
    'for',
    'while',
    'return',
    'switch',
    'catch',
    'function',
    'typeof',
    'await',
    'void',
    'async',
  ]) {
    names.delete(keyword);
  }
  return [...names].filter((name) => !/^get\w*Db$/.test(name)).sort();
}

describe('main() starts nothing the allowlists have not classified', () => {
  const source = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
  const calls = mainCalls(source);

  it('every call in main() is checkout-scoped or behind a named shadow check', () => {
    expect(calls.length).toBeGreaterThan(40);
    expect(calls.filter((name) => !MAIN_CHECKOUT_CALLS.has(name) && !(name in MAIN_GATED_CALLS))).toEqual([]);
  });

  it('the classification names nothing main() no longer calls', () => {
    const stale = [...MAIN_CHECKOUT_CALLS, ...Object.keys(MAIN_GATED_CALLS)].filter((name) => !calls.includes(name));
    expect(stale).toEqual([]);
  });

  it('each gated call sits behind its shadow check', () => {
    for (const [name, guarded] of Object.entries(MAIN_GATED_CALLS)) {
      expect(source, name).toContain(guarded);
    }
  });
});

describe('on a shadow, every live registration the lists do not name is refused at its seam', () => {
  it('ncl commands', async () => {
    flag.on = true;
    const refused = listCommands().filter((cmd) => !SHADOW_CLI_COMMANDS.has(cmd.name));
    expect(refused.length).toBeGreaterThan(0);
    for (const cmd of refused) {
      const res = await dispatch({ id: cmd.name, command: cmd.name, args: {} }, { caller: 'host' });
      expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
  });

  it('sweep duties, in every phase', () => {
    flag.on = true;
    _resetSweepRegistryForTesting();
    const { duties } = _listSweepRegistrationsForTesting();
    const offList = duties.filter((duty) => !SHADOW_SWEEP_DUTIES.has(duty.name));
    expect(offList.length).toBeGreaterThan(0);
    const phases = new Set(duties.map((duty) => duty.phase));
    const admitted = [...phases].flatMap((phase) => _dutiesForPhaseForTesting(phase).map((duty) => duty.name));
    expect(admitted.filter((name) => !SHADOW_SWEEP_DUTIES.has(name))).toEqual([]);
    expect(admitted.length).toBe(duties.length - offList.length);
    flag.on = false;
    _resetSweepRegistryForTesting();
  });
});
