import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  shadow: false,
  home: '',
  exec: vi.fn(async (_file: string, _args: string[]) => ({ stdout: 'Already up to date.\n', stderr: '' })),
  hostStart: [] as Array<() => void>,
  info: vi.fn(),
  syncCodex: vi.fn(),
}));

vi.mock('./shadow-host.js', () => ({ isShadowHost: () => state.shadow }));
vi.mock('child_process', () => {
  const execFile: unknown = () => {
    throw new Error('execFile called directly — expected promisify.custom path only');
  };
  (execFile as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = (file: string, args: string[]) =>
    state.exec(file, args);
  return { execFile };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => state.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});
// Complete stub, not a spread: log.ts installs process-wide exit handlers.
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { debug: vi.fn(), info: state.info, warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('./host-lifecycle.js', () => ({
  onHostStart: (cb: () => void) => state.hostStart.push(cb),
  onHostShutdown: vi.fn(),
}));
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => null }));
vi.mock('./codex-sync.js', () => ({
  syncCodexSubagents: state.syncCodex,
  syncCodexLocalMarketplacePluginCache: state.syncCodex,
}));
vi.mock('./opencode-sync.js', () => ({ syncOpenCodeSubagents: state.syncCodex }));
vi.mock('./codex-skill-materialize.js', () => ({ refreshMaterializedCodexSkills: state.syncCodex }));
vi.mock('./design-artifact-loop-vendor.js', () => ({ vendorDesignArtifactLoop: vi.fn(() => []) }));

const { refreshCodexPluginSurfaces, runPluginUpdates, stopPluginUpdater } = await import('./plugin-updater.js');

describe('plugin updater under shadow mode', () => {
  beforeAll(() => {
    state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-updater-shadow-'));
    fs.mkdirSync(path.join(state.home, 'plugins', 'demo', '.git'), { recursive: true });
  });
  afterAll(() => {
    fs.rmSync(state.home, { recursive: true, force: true });
  });
  beforeEach(() => {
    state.exec.mockClear();
    state.info.mockClear();
    state.syncCodex.mockClear();
  });
  afterEach(() => {
    stopPluginUpdater();
    vi.useRealTimers();
  });

  it('pulls ~/plugins repos when shadow mode is off', async () => {
    state.shadow = false;
    const results = await runPluginUpdates();
    expect(results).toEqual([{ plugin: 'demo', changed: false }]);
    expect(state.exec).toHaveBeenCalledWith('git', ['pull', '--ff-only']);
  });

  it('never pulls ~/plugins on a shadow host', async () => {
    state.shadow = true;
    expect(await runPluginUpdates()).toEqual([]);
    expect(state.exec).not.toHaveBeenCalled();
  });

  it('upgrades the Codex marketplace and refreshes plugin mirrors when shadow mode is off', async () => {
    state.shadow = false;
    await refreshCodexPluginSurfaces();
    expect(state.exec).toHaveBeenCalledWith('codex', ['plugin', 'marketplace', 'upgrade']);
    expect(state.syncCodex).toHaveBeenCalled();
  });

  it('never upgrades the Codex marketplace or rewrites plugin mirrors on a shadow host', async () => {
    state.shadow = true;
    expect(await refreshCodexPluginSurfaces()).toEqual({});
    expect(state.exec).not.toHaveBeenCalled();
    expect(state.syncCodex).not.toHaveBeenCalled();
  });

  it('host start schedules the updater when shadow mode is off', () => {
    vi.useFakeTimers();
    state.shadow = false;
    expect(state.hostStart).toHaveLength(1);
    state.hostStart[0]();
    expect(vi.getTimerCount()).toBe(2);
    expect(state.info).toHaveBeenCalledWith('Plugin updater started');
  });

  it('host start schedules nothing on a shadow host', () => {
    vi.useFakeTimers();
    state.shadow = true;
    state.hostStart[0]();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.info).not.toHaveBeenCalledWith('Plugin updater started');
  });
});
