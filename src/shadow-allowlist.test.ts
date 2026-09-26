/**
 * The shadow-host allowlist at each seam that consults it. Every case drives
 * the real seam with a name no list holds — a module, duty, action or key
 * added after this file was written — and shows a shadow refuses it while a
 * host with the flag unset admits it. shadow-allowlist-registries.test.ts
 * checks the lists against the live registries.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flag = vi.hoisted(() => ({ on: false }));
vi.mock('./shadow-flag.js', () => ({ isShadowProcess: () => flag.on, readShadowFlag: () => flag.on }));

// Complete stub, not a spread: log.ts installs process-wide exit handlers at
// module scope.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, registerChannelAdapter } from './channels/channel-registry.js';
import { dispatch } from './cli/dispatch.js';
import { register } from './cli/registry.js';
import { getDeliveryAction, onDeliveryAdapterReady, registerDeliveryAction, setDeliveryAdapter } from './delivery.js';
import type { ChannelDeliveryAdapter } from './delivery.js';
import { readEnvFile, readEnvFileMatching } from './env.js';
import { readEnvValue } from './env-file.js';
import { unguarded } from './guard/index.js';
import { onHostStart, startHostModules } from './host-lifecycle.js';
import { startShadowHostModules } from './shadow-host.js';
import {
  _dutiesForPhaseForTesting,
  _resetSweepRegistryForTesting,
  registerSlaObservationHook,
  registerSweepDuty,
  runSlaObservationHooks,
  type SweepSessionContext,
} from './host-sweep.js';
import type { NanoclawMailboxSession } from './modules/mailbox/index.js';
import { getApprovalHandler, registerApprovalHandler } from './modules/approvals/primitive.js';
import { scrubbedShadowEnvKeys, scrubShadowProcessEnv } from './shadow-allowlist.js';

afterEach(() => {
  flag.on = false;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('environment', () => {
  let root: string;
  const writeEnv = (text: string): void => fs.writeFileSync(path.join(root, '.env'), text);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-allowlist-'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads every key when the flag is unset', () => {
    writeEnv('SLACK_BOT_TOKEN=xoxb-synthetic\nWEBHOOK_PORT=3999\n');
    expect(readEnvValue(root, 'SLACK_BOT_TOKEN')).toBe('xoxb-synthetic');
    expect(readEnvFile(['SLACK_BOT_TOKEN'])).toEqual({ SLACK_BOT_TOKEN: 'xoxb-synthetic' });
    expect(readEnvFileMatching(/^SLACK_/)).toEqual({ SLACK_BOT_TOKEN: 'xoxb-synthetic' });
  });

  it('on a shadow, reads allowlisted keys and nothing else, from .env and the process environment', () => {
    flag.on = true;
    writeEnv('SLACK_BOT_TOKEN=xoxb-synthetic\nWEBHOOK_PORT=3999\n');
    vi.stubEnv('GITHUB_TOKEN', 'ghp-synthetic');
    expect(readEnvValue(root, 'WEBHOOK_PORT')).toBe('3999');
    expect(readEnvValue(root, 'SLACK_BOT_TOKEN')).toBeUndefined();
    expect(readEnvValue(root, 'GITHUB_TOKEN')).toBeUndefined();
    expect(readEnvFile(['SLACK_BOT_TOKEN', 'WEBHOOK_PORT'])).toEqual({ WEBHOOK_PORT: '3999' });
    expect(readEnvFileMatching(/^SLACK_/)).toEqual({});
  });

  it('on a shadow, a credential written into .env while the host runs never reads back', () => {
    flag.on = true;
    writeEnv('WEBHOOK_PORT=3999\n');
    expect(readEnvValue(root, 'SLACK_BOT_TOKEN_EXAMPLE')).toBeUndefined();
    writeEnv('WEBHOOK_PORT=3999\nSLACK_BOT_TOKEN_EXAMPLE=xoxb-synthetic\nNEW_VENDOR_API_KEY=k-synthetic\n');
    expect(readEnvValue(root, 'SLACK_BOT_TOKEN_EXAMPLE')).toBeUndefined();
    expect(readEnvValue(root, 'NEW_VENDOR_API_KEY')).toBeUndefined();
    expect(readEnvFileMatching(/^(SLACK_|NEW_VENDOR_)/)).toEqual({});
  });

  it('on a shadow, the entry-shim scrub removes every process-environment key off the list', () => {
    flag.on = true;
    vi.stubEnv('WEBHOOK_PORT', '3999');
    vi.stubEnv('ZZ_SHADOW_PROBE_TOKEN', 'synthetic');
    const saved = { ...process.env };
    let after: NodeJS.ProcessEnv;
    try {
      scrubShadowProcessEnv();
      after = { ...process.env };
    } finally {
      for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    }
    expect(after.ZZ_SHADOW_PROBE_TOKEN).toBeUndefined();
    expect(after.WEBHOOK_PORT).toBe('3999');
    expect(after.PATH).toBe(saved.PATH);
    expect(scrubbedShadowEnvKeys()).toContain('ZZ_SHADOW_PROBE_TOKEN');
    expect(scrubbedShadowEnvKeys()).not.toContain('PATH');
  });

  it('on a shadow, host-side code finds no OneCLI proxy, so a credentialed host call fails closed', async () => {
    flag.on = true;
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:10255');
    vi.stubEnv('https_proxy', 'http://127.0.0.1:10255');
    const saved = { ...process.env };
    try {
      scrubShadowProcessEnv();
      expect(process.env.HTTPS_PROXY).toBeUndefined();
      expect(process.env.https_proxy).toBeUndefined();
      vi.resetModules();
      const { askJev } = await import('./typesafe.js');
      await expect(
        askJev({ agent_final_message: 'synthetic' }, { q: { type: 'noul', instructions: 'synthetic' } }),
      ).rejects.toThrow(/no OneCLI gateway proxy/);
    } finally {
      for (const [key, value] of Object.entries(saved)) process.env[key] = value;
    }
  });

  it('the scrub changes nothing when the flag is unset', () => {
    vi.stubEnv('ZZ_SHADOW_PROBE_TOKEN', 'synthetic');
    scrubShadowProcessEnv();
    expect(process.env.ZZ_SHADOW_PROBE_TOKEN).toBe('synthetic');
  });
});

describe('host-module starts', () => {
  const started: string[] = [];
  onHostStart(function zzShadowProbeModule() {
    started.push('zzShadowProbeModule');
  });
  onHostStart(() => {
    started.push('anonymous');
  });
  const ctx = { db: {} as never, signal: new AbortController().signal };

  beforeEach(() => {
    started.length = 0;
  });

  it('start every module when the flag is unset', async () => {
    await startHostModules(ctx);
    expect(started).toEqual(['zzShadowProbeModule', 'anonymous']);
  });

  it('start none a shadow allowlist does not name, anonymous callbacks included', async () => {
    flag.on = true;
    await startShadowHostModules(ctx);
    expect(started).toEqual([]);
  });

  it('main.ts routes a shadow through the allowlisted start', () => {
    const main = fs.readFileSync(path.resolve('src/main.ts'), 'utf8');
    expect(main).toContain(
      'if (isShadowHost()) await startShadowHostModules({ db: getDb(), signal: hostAbortController.signal });',
    );
  });
});

describe('sweep duties and hooks', () => {
  const ran: string[] = [];
  const probe = (name: string) => ({ name, run: () => void ran.push(name) });

  function registerProbes(): void {
    _resetSweepRegistryForTesting({ builtins: false });
    registerSweepDuty({ ...probe('zz-shadow-probe-duty'), phase: 'tick:housekeeping', order: 1 });
    registerSweepDuty({ ...probe('usage-rollup'), phase: 'tick:housekeeping', order: 2 });
    registerSlaObservationHook({ ...probe('zz-shadow-probe-hook'), order: 1 });
    registerSlaObservationHook({ ...probe('orphan-claim-reset'), order: 2 });
  }

  beforeEach(() => {
    ran.length = 0;
  });
  afterEach(() => {
    _resetSweepRegistryForTesting();
  });

  it('run every duty and hook when the flag is unset', async () => {
    registerProbes();
    expect(_dutiesForPhaseForTesting('tick:housekeeping').map((d) => d.name)).toEqual([
      'zz-shadow-probe-duty',
      'usage-rollup',
    ]);
    await runSlaObservationHooks({} as SweepSessionContext, null, {} as NanoclawMailboxSession);
    expect(ran).toEqual(['zz-shadow-probe-hook', 'orphan-claim-reset']);
  });

  it('on a shadow, run only the names the allowlist holds', async () => {
    flag.on = true;
    registerProbes();
    expect(_dutiesForPhaseForTesting('tick:housekeeping').map((d) => d.name)).toEqual(['usage-rollup']);
    await runSlaObservationHooks({} as SweepSessionContext, null, {} as NanoclawMailboxSession);
    expect(ran).toEqual(['orphan-claim-reset']);
  });
});

describe('delivery-adapter-ready callbacks', () => {
  it('on a shadow, never run a callback the allowlist does not name', async () => {
    flag.on = true;
    const ready = vi.fn();
    onDeliveryAdapterReady(function zzShadowProbeReady(adapter) {
      ready(adapter);
    });
    flag.on = false;
    const unlisted = vi.fn();
    onDeliveryAdapterReady(function zzUnsetProbeReady(adapter) {
      unlisted(adapter);
    });
    setDeliveryAdapter({ deliver: vi.fn() } as unknown as ChannelDeliveryAdapter);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ready).not.toHaveBeenCalled();
    expect(unlisted).toHaveBeenCalledTimes(1);
  });
});

describe('delivery actions', () => {
  registerDeliveryAction('zz_shadow_probe_action', async () => {}, unguarded('test — shadow allowlist probe'));

  it('resolve every registered action when the flag is unset', () => {
    expect(getDeliveryAction('zz_shadow_probe_action')).toBeDefined();
    expect(getDeliveryAction('turn_end')).toBeDefined();
  });

  it('on a shadow, resolve only the actions the allowlist holds', () => {
    flag.on = true;
    expect(getDeliveryAction('zz_shadow_probe_action')).toBeUndefined();
    expect(getDeliveryAction('turn_end')).toBeDefined();
  });
});

describe('approval replays', () => {
  registerApprovalHandler('zz_shadow_probe_approval', async () => {});
  registerApprovalHandler('change_model', async () => {});

  it('resolve every handler when the flag is unset', () => {
    expect(getApprovalHandler('zz_shadow_probe_approval')).toBeDefined();
  });

  it('on a shadow, resolve only the approvals the allowlist holds', () => {
    flag.on = true;
    expect(getApprovalHandler('zz_shadow_probe_approval')).toBeUndefined();
    expect(getApprovalHandler('change_model')).toBeDefined();
  });
});

describe('channel adapters', () => {
  const cliFactory = vi.fn(() => null);
  const probeFactory = vi.fn(() => null);
  registerChannelAdapter('cli', { factory: cliFactory });
  registerChannelAdapter('zz-shadow-probe', { factory: probeFactory });
  const setup = (() => ({})) as unknown as (adapter: ChannelAdapter) => ChannelSetup;

  beforeEach(() => {
    cliFactory.mockClear();
    probeFactory.mockClear();
  });

  it('build every adapter when the flag is unset', async () => {
    await initChannelAdapters(setup);
    expect(cliFactory).toHaveBeenCalledTimes(1);
    expect(probeFactory).toHaveBeenCalledTimes(1);
  });

  it('on a shadow, never build an adapter other than the CLI channel, so it never reads credentials', async () => {
    flag.on = true;
    await initChannelAdapters(setup);
    expect(cliFactory).toHaveBeenCalledTimes(1);
    expect(probeFactory).not.toHaveBeenCalled();
  });
});

describe('ncl commands', () => {
  const handler = vi.fn(async () => 'ran');
  register({
    name: 'zz-shadow-probe-run',
    description: 'test probe',
    access: 'open',
    parseArgs: () => ({}),
    handler,
  });

  it('on a shadow, refuse a command the allowlist does not name before its guard or handler', async () => {
    flag.on = true;
    const res = await dispatch({ id: 'r1', command: 'zz-shadow-probe-run', args: {} }, { caller: 'host' });
    expect(res).toEqual({
      id: 'r1',
      ok: false,
      error: { code: 'forbidden', message: expect.stringContaining('not served on a shadow host') },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('call sites', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');

  it('the entry shim scrubs the environment before the application module graph loads', () => {
    const source = read('src/index.ts');
    const scrub = source.indexOf('scrubShadowProcessEnv();');
    const app = source.indexOf("await import('./main.js')");
    expect(scrub).toBeGreaterThan(-1);
    expect(app).toBeGreaterThan(scrub);
  });

  it('main() copies .env into the environment only for keys the allowlist admits', () => {
    expect(read('src/main.ts')).toMatch(/if \(key && shadowMayReadEnvKey\(key\) && /);
  });
});
