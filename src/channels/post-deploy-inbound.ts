/**
 * After a deploy, each chat platform must show live inbound. Boot, preflight, outbound and reactions can all stay
 * green while an adapter drops every message, as a dependency bump did to Discord. Adapter errors alone do not fail a
 * platform that is receiving messages: the Discord adapter logs routine API errors every day.
 */
import fs from 'fs';
import path from 'path';

import type { Logger } from 'chat';

import { REPO_ROOT } from '../config.js';
import { log } from '../log.js';

interface PlatformTally {
  inbound: number;
  errors: Map<string, number>;
  channelTypes: Set<string>;
}

const tallies = new Map<string, PlatformTally>();
const platformByChannelType = new Map<string, string>();

function tallyFor(platform: string): PlatformTally {
  let t = tallies.get(platform);
  if (!t) {
    t = { inbound: 0, errors: new Map(), channelTypes: new Set() };
    tallies.set(platform, t);
  }
  return t;
}

function logData(channelType: string, args: unknown[]): Record<string, unknown> {
  const [first] = args;
  if (args.length === 1 && first && typeof first === 'object' && !Array.isArray(first)) {
    return { channelType, ...(first as Record<string, unknown>) };
  }
  return args.length === 0 ? { channelType } : { channelType, args };
}

export function createAdapterLogger(channelType: string, platform: string, prefix: string = platform): Logger {
  platformByChannelType.set(channelType, platform);
  tallyFor(platform).channelTypes.add(channelType);
  const tag = `[chat-sdk:${prefix}]`;
  return {
    child: (childPrefix: string) => createAdapterLogger(channelType, platform, `${prefix}:${childPrefix}`),
    debug: (message: string, ...args: unknown[]) => log.debug(`${tag} ${message}`, logData(channelType, args)),
    info: (message: string, ...args: unknown[]) => log.info(`${tag} ${message}`, logData(channelType, args)),
    warn: (message: string, ...args: unknown[]) => log.warn(`${tag} ${message}`, logData(channelType, args)),
    error: (message: string, ...args: unknown[]) => {
      log.error(`${tag} ${message}`, logData(channelType, args));
      const errors = tallyFor(platform).errors;
      errors.set(message, (errors.get(message) ?? 0) + 1);
    },
  };
}

/** Live messages only: a recovery replay is fetched over REST and says nothing about the event path. */
export function recordLiveInbound(channelType: string): void {
  const platform = platformByChannelType.get(channelType);
  if (platform) tallyFor(platform).inbound += 1;
}

export type PlatformVerdict = 'verified' | 'failing' | 'unverified';

export interface PlatformReport {
  platform: string;
  verdict: PlatformVerdict;
  liveInbound: number;
  adapterErrors: Record<string, number>;
  channelTypes: string[];
}

export function evaluatePlatforms(): PlatformReport[] {
  return [...tallies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, t]) => ({
      platform,
      verdict: t.inbound > 0 ? 'verified' : t.errors.size > 0 ? 'failing' : 'unverified',
      liveInbound: t.inbound,
      adapterErrors: Object.fromEntries(t.errors),
      channelTypes: [...t.channelTypes].sort(),
    }));
}

function errorCount(report: PlatformReport): number {
  return Object.values(report.adapterErrors).reduce((a, b) => a + b, 0);
}

function describe(report: PlatformReport): string {
  const errors = Object.entries(report.adapterErrors)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([message, n]) => `"${message}" ×${n}`)
    .join(', ');
  switch (report.verdict) {
    case 'verified':
      return `${report.platform}: verified (${report.liveInbound} live inbound)`;
    case 'failing':
      return `${report.platform}: FAILING — no live inbound, ${errorCount(report)} adapter error(s): ${errors}`;
    case 'unverified':
      return `${report.platform}: unverified — no live inbound and no adapter errors`;
  }
}

export interface PostDeployReport {
  build: string | null;
  startedAt: string;
  windowMs: number;
  state: 'running' | 'done';
  platforms: PlatformReport[];
}

export interface PostDeployCheckDeps {
  build: string | null;
  windowMs: number;
  earlyCheckMs: number;
  earlyErrorThreshold: number;
  notify: (text: string) => Promise<boolean>;
  reportPath: string;
}

export const POST_DEPLOY_REPORT_PATH = path.join(REPO_ROOT, 'logs', 'post-deploy-inbound.json');

/**
 * Ten minutes and three errors, so the early report is not a page for the routine API errors an adapter logs
 * (about two a day on Discord) landing before the first message after a restart.
 */
export const POST_DEPLOY_EARLY_CHECK_MS = 10 * 60_000;
export const POST_DEPLOY_EARLY_ERROR_THRESHOLD = 3;

function writeReport(file: string, report: PostDeployReport): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(`${file}.tmp`, file);
  } catch (err) {
    log.warn('post-deploy inbound: report not written', { file, err });
  }
}

/** The report says `running` until the window closes, so nobody reads a previous deploy's verdict as this one's. */
export function startPostDeployInboundCheck(deps: PostDeployCheckDeps): void {
  const startedAt = new Date().toISOString();
  const snapshot = (state: PostDeployReport['state']): PostDeployReport => ({
    build: deps.build,
    startedAt,
    windowMs: deps.windowMs,
    state,
    platforms: evaluatePlatforms(),
  });
  const header = `Post-deploy inbound check${deps.build ? ` (build ${deps.build})` : ''}`;
  writeReport(deps.reportPath, snapshot('running'));

  const send = (text: string): void => {
    void deps.notify(text).catch((err: unknown) => log.warn('post-deploy inbound: alert failed', { err, text }));
  };

  const early = setTimeout(() => {
    const failing = evaluatePlatforms().filter(
      (r) => r.verdict === 'failing' && errorCount(r) >= deps.earlyErrorThreshold,
    );
    if (failing.length === 0) return;
    writeReport(deps.reportPath, snapshot('running'));
    log.error('Post-deploy inbound check: platform failing', { platforms: failing });
    send(`${header}: ${failing.map(describe).join('\n')}\nThe final verdict follows when the window closes.`);
  }, deps.earlyCheckMs);
  early.unref?.();

  const final = setTimeout(() => {
    const report = snapshot('done');
    writeReport(deps.reportPath, report);
    const minutes = Math.round(deps.windowMs / 60_000);
    const lines = report.platforms.map(describe);
    const healthy = report.platforms.every((p) => p.verdict === 'verified');
    log[healthy ? 'info' : 'error']('Post-deploy inbound check finished', { ...report });
    if (!healthy) {
      send(`${header} after ${minutes} min:\n${lines.join('\n')}`);
    }
  }, deps.windowMs);
  final.unref?.();
}
