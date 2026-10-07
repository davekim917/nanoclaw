import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Module = typeof import('./post-deploy-inbound.js');

const WINDOW_MS = 30 * 60_000;
const MONITOR_MS = 10 * 60_000;
const MINUTE = 60_000;

let mod: Module;
let dir: string;
let reportPath: string;
let alerts: string[];

function readReport(): {
  state: string;
  afterDeploy: boolean;
  platforms: Array<{ platform: string; verdict: string; liveInbound: number }>;
} {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
}

function start(afterDeploy = true): void {
  mod.startPostDeployInboundCheck({
    build: 'abc1234',
    afterDeploy,
    windowMs: WINDOW_MS,
    monitorIntervalMs: MONITOR_MS,
    failingErrorThreshold: 3,
    notify: async (text) => {
      alerts.push(text);
      return true;
    },
    reportPath,
  });
}

const circular = { error: 'TypeError: Converting circular structure to JSON' };

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
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('post-deploy inbound check', () => {
  it('alerts at the first monitor check and fails a platform whose adapter errors while no message arrives', async () => {
    const discord = mod.createAdapterLogger('discord', 'discord').child('gateway');
    mod.createAdapterLogger('slack', 'slack');
    start();

    mod.recordLiveInbound('slack');
    for (let i = 0; i < 4; i++) {
      discord.error('Error forwarding Gateway event', { error: 'TypeError: Converting circular structure to JSON' });
    }
    await vi.advanceTimersByTimeAsync(MONITOR_MS - 1);
    expect(alerts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('discord: FAILING');
    expect(alerts[0]).toContain('"Error forwarding Gateway event" ×4');
    expect(alerts[0]).not.toContain('slack');
    expect(readReport().state).toBe('running');

    await vi.advanceTimersByTimeAsync(WINDOW_MS - MONITOR_MS);
    expect(alerts).toHaveLength(1);
    const report = readReport();
    expect(report.state).toBe('done');
    expect(report.platforms.map((p) => [p.platform, p.verdict])).toEqual([
      ['discord', 'failing'],
      ['slack', 'verified'],
    ]);
  });

  it('does not alert on routine adapter errors on a platform routing more messages than it logs errors', async () => {
    const codexBot = mod.createAdapterLogger('discord-codex', 'discord');
    mod.createAdapterLogger('discord', 'discord');
    start();

    for (let i = 0; i < 5; i++) codexBot.error('Discord API error', { status: 404 });
    await vi.advanceTimersByTimeAsync(MONITOR_MS / 2);
    for (let i = 0; i < 6; i++) mod.recordLiveInbound('discord');
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(alerts).toEqual([]);
    expect(readReport().platforms).toEqual([
      expect.objectContaining({
        platform: 'discord',
        verdict: 'verified',
        liveInbound: 6,
        liveInboundByChannelType: { discord: 6, 'discord-codex': 0 },
      }),
    ]);
  });

  it('fails Discord when one plain message routed and then every bot failed to forward mentions, as on 2026-10-06', async () => {
    const channelTypes = ['discord', 'discord-codex', 'discord-opencode'];
    const bots = channelTypes.map((channelType) => mod.createAdapterLogger(channelType, 'discord').child('gateway'));
    const plainMessage = () => channelTypes.forEach((channelType) => mod.recordLiveInbound(channelType));
    const mention = () =>
      bots.forEach((bot) =>
        bot.error('Error forwarding Gateway event', { type: 'GATEWAY_MESSAGE_CREATE', ...circular }),
      );
    start();

    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    plainMessage();
    for (let minute = 5; minute < 30; minute++) {
      if (minute >= 12 && minute % 3 === 0) mention();
      if (minute === 22) plainMessage();
      await vi.advanceTimersByTimeAsync(MINUTE);
    }

    expect(alerts).toEqual([expect.stringContaining('discord: FAILING — 9 adapter error(s) against 0 live inbound')]);
    expect(readReport()).toMatchObject({ state: 'done' });
    expect(readReport().platforms).toEqual([
      expect.objectContaining({ platform: 'discord', verdict: 'failing', liveInbound: 6 }),
    ]);
  });

  it('pages once through a sustained outage, though quiet intervals with no traffic come between', async () => {
    const discord = mod.createAdapterLogger('discord', 'discord');
    start();
    for (const errors of [3, 0, 3, 0, 4]) {
      for (let i = 0; i < errors; i++) discord.error('Error forwarding Gateway event', circular);
      await vi.advanceTimersByTimeAsync(MONITOR_MS);
    }
    expect(alerts).toEqual([expect.stringContaining('discord: FAILING')]);
  });

  it('does not count outbound REST errors, so a burst of 429s on a quiet platform does not page', async () => {
    const discord = mod.createAdapterLogger('discord', 'discord');
    mod.createAdapterLogger('slack', 'slack');
    start();
    for (let i = 0; i < 9; i++) discord.error('Discord API error', { method: 'POST', status: 429 });
    mod.recordLiveInbound('discord');
    mod.recordLiveInbound('slack');
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(alerts).toEqual([]);
    expect(readReport().platforms).toEqual([
      expect.objectContaining({ platform: 'discord', verdict: 'verified', adapterErrors: {} }),
      expect.objectContaining({ platform: 'slack', verdict: 'verified' }),
    ]);
  });

  it('alerts once when forward errors with only occasional successes start long after the boot window', async () => {
    const discord = mod.createAdapterLogger('discord', 'discord');
    start();
    for (let minute = 0; minute < 120; minute += 5) {
      mod.recordLiveInbound('discord');
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
    }
    expect(alerts).toEqual([]);

    for (let minute = 120; minute < 160; minute += 5) {
      discord.error('Error forwarding Gateway event', circular);
      discord.error('Error forwarding Gateway event', circular);
      if (minute % 20 === 0) mod.recordLiveInbound('discord');
      await vi.advanceTimersByTimeAsync(5 * MINUTE);
    }
    expect(alerts).toEqual([expect.stringContaining('discord: FAILING')]);
    expect(alerts[0]).toContain('last 10 min');
    expect(readReport().platforms).toEqual([expect.objectContaining({ verdict: 'verified' })]);
  });

  it('reports a quiet platform as unverified, never healthy, and one routine error does not make it failing', async () => {
    mod.createAdapterLogger('slack', 'slack');
    const discord = mod.createAdapterLogger('discord', 'discord');
    start();
    mod.recordLiveInbound('slack');
    discord.error('Error handling Gateway message', { error: 'Unknown Channel' });

    await vi.advanceTimersByTimeAsync(WINDOW_MS - 1);
    expect(readReport().state).toBe('running');
    expect(alerts).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('discord: unverified — no live inbound, 1 adapter error(s)');
    expect(alerts[0]).toContain('slack: verified');
  });

  it('logs the message and stack of an Error an adapter passes, which the host log would print as {}', async () => {
    const { log } = await import('../log.js');
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const slack = mod.createAdapterLogger('slack', 'slack');

    slack.error('Error in socket mode async handler', { error: new Error('socket closed') });
    slack.error('Failed to resolve token for team', new Error('no installation'));

    expect(error).toHaveBeenNthCalledWith(1, '[chat-sdk:slack] Error in socket mode async handler', {
      channelType: 'slack',
      error: { message: 'socket closed', stack: expect.stringContaining('socket closed') },
    });
    expect(error).toHaveBeenNthCalledWith(2, '[chat-sdk:slack] Failed to resolve token for team', {
      channelType: 'slack',
      args: [{ message: 'no installation', stack: expect.stringContaining('no installation') }],
    });
  });

  it('opens a window on a boot that did not follow a deploy, and says it was a restart', async () => {
    mod.createAdapterLogger('slack', 'slack');
    start(false);
    expect(readReport()).toMatchObject({ state: 'running', afterDeploy: false });
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(alerts).toEqual([expect.stringMatching(/^Post-restart inbound check \(build abc1234\) after 30 min:/)]);
  });

  it('alerts when no chat adapter started at all, instead of reading an empty list as healthy', async () => {
    start();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(alerts).toEqual([expect.stringContaining('no chat adapter started')]);
  });
});
