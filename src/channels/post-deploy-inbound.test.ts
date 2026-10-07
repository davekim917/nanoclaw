import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Module = typeof import('./post-deploy-inbound.js');

const WINDOW_MS = 30 * 60_000;
const EARLY_MS = 10 * 60_000;

let mod: Module;
let dir: string;
let reportPath: string;
let alerts: string[];

function readReport(): { state: string; platforms: Array<{ platform: string; verdict: string; liveInbound: number }> } {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function start(): void {
  mod.startPostDeployInboundCheck({
    build: 'abc1234',
    windowMs: WINDOW_MS,
    earlyCheckMs: EARLY_MS,
    earlyErrorThreshold: 3,
    notify: async (text) => {
      alerts.push(text);
      return true;
    },
    reportPath,
  });
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  mod = await import('./post-deploy-inbound.js');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'post-deploy-inbound-'));
  reportPath = path.join(dir, 'post-deploy-inbound.json');
  alerts = [];
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('post-deploy inbound check', () => {
  it('alerts at the early check and fails a platform whose adapter errors while no message arrives', async () => {
    const discord = mod.createAdapterLogger('discord', 'discord').child('gateway');
    mod.createAdapterLogger('slack', 'slack');
    start();

    mod.recordLiveInbound('slack');
    for (let i = 0; i < 4; i++) {
      discord.error('Error forwarding Gateway event', { error: 'TypeError: Converting circular structure to JSON' });
    }
    await vi.advanceTimersByTimeAsync(EARLY_MS - 1);
    expect(alerts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('discord: FAILING');
    expect(alerts[0]).toContain('"Error forwarding Gateway event" ×4');
    expect(alerts[0]).not.toContain('slack');
    expect(readReport().state).toBe('running');

    await vi.advanceTimersByTimeAsync(WINDOW_MS - EARLY_MS);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('discord: FAILING');
    expect(alerts[1]).toContain('slack: verified (1 live inbound)');
    const report = readReport();
    expect(report.state).toBe('done');
    expect(report.platforms.map((p) => [p.platform, p.verdict])).toEqual([
      ['discord', 'failing'],
      ['slack', 'verified'],
    ]);
  });

  it('does not alert on routine adapter errors once the platform receives a message', async () => {
    const codexBot = mod.createAdapterLogger('discord-codex', 'discord');
    mod.createAdapterLogger('discord', 'discord');
    start();

    for (let i = 0; i < 5; i++) codexBot.error('Discord API error', { status: 404 });
    await vi.advanceTimersByTimeAsync(EARLY_MS / 2);
    mod.recordLiveInbound('discord');
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(alerts).toEqual([]);
    expect(readReport().platforms).toEqual([
      expect.objectContaining({ platform: 'discord', verdict: 'verified', liveInbound: 1 }),
    ]);
  });

  it('reports a platform with no inbound and no errors as unverified, never healthy', async () => {
    mod.createAdapterLogger('slack', 'slack');
    mod.createAdapterLogger('discord', 'discord');
    start();
    mod.recordLiveInbound('discord');

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(readReport().state).toBe('running');
    expect(alerts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('slack: unverified');
    expect(alerts[0]).toContain('discord: verified');
  });
});
