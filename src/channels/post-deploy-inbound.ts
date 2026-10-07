/**
 * After a deploy, each chat platform must show live inbound. Boot, preflight, outbound and reactions can all stay
 * green while an adapter drops every message. Adapter errors alone do not fail a platform that is receiving messages:
 * adapters log routine API errors every day.
 */
import fs from 'fs';
import path from 'path';

import type { Logger } from 'chat';

import { REPO_ROOT } from '../config.js';
import { log } from '../log.js';
import { atomicJson } from '../repository-workspaces.js';

interface PlatformTally {
  inbound: Map<string, number>;
  errors: Map<string, number>;
}

const tallies = new Map<string, PlatformTally>();
const platformByChannelType = new Map<string, string>();

function tallyFor(platform: string): PlatformTally {
  let t = tallies.get(platform);
  if (!t) {
    t = { inbound: new Map(), errors: new Map() };
    tallies.set(platform, t);
  }
  return t;
}

/** The host log JSON-encodes values, and an Error has no enumerable fields, so it would print as `{}`. */
function loggable(value: unknown): unknown {
  return value instanceof Error ? { message: value.message, stack: value.stack } : value;
}

function logData(channelType: string, args: unknown[]): Record<string, unknown> {
  const [first] = args;
  if (args.length === 1 && first && typeof first === 'object' && !Array.isArray(first) && !(first instanceof Error)) {
    const fields = Object.fromEntries(Object.entries(first).map(([key, value]) => [key, loggable(value)]));
    return { ...fields, channelType };
  }
  return args.length === 0 ? { channelType } : { args: args.map(loggable), channelType };
}

export function createAdapterLogger(channelType: string, platform: string, prefix: string = platform): Logger {
  platformByChannelType.set(channelType, platform);
  const tally = tallyFor(platform);
  if (!tally.inbound.has(channelType)) tally.inbound.set(channelType, 0);
  const tag = `[chat-sdk:${prefix}]`;
  return {
    child: (childPrefix: string) => createAdapterLogger(channelType, platform, `${prefix}:${childPrefix}`),
    debug: (message: string, ...args: unknown[]) => log.debug(`${tag} ${message}`, logData(channelType, args)),
    info: (message: string, ...args: unknown[]) => log.info(`${tag} ${message}`, logData(channelType, args)),
    warn: (message: string, ...args: unknown[]) => log.warn(`${tag} ${message}`, logData(channelType, args)),
    error: (message: string, ...args: unknown[]) => {
      log.error(`${tag} ${message}`, logData(channelType, args));
      tally.errors.set(message, (tally.errors.get(message) ?? 0) + 1);
    },
  };
}

/** Live messages the host accepted; a recovery replay arrives over REST and says nothing about the event path. */
export function recordLiveInbound(channelType: string): void {
  const platform = platformByChannelType.get(channelType);
  if (!platform) return;
  const inbound = tallyFor(platform).inbound;
  inbound.set(channelType, (inbound.get(channelType) ?? 0) + 1);
}

export type PlatformVerdict = 'verified' | 'failing' | 'unverified';

export interface PlatformReport {
  platform: string;
  verdict: PlatformVerdict;
  liveInbound: number;
  /** A platform can be verified by one bot while another bot or workspace on it receives nothing. */
  liveInboundByChannelType: Record<string, number>;
  adapterErrors: Record<string, number>;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function evaluatePlatforms(failingErrorThreshold: number): PlatformReport[] {
  return [...tallies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, t]) => {
      const liveInbound = sum(t.inbound.values());
      const verdict: PlatformVerdict =
        liveInbound > 0 ? 'verified' : sum(t.errors.values()) >= failingErrorThreshold ? 'failing' : 'unverified';
      return {
        platform,
        verdict,
        liveInbound,
        liveInboundByChannelType: Object.fromEntries([...t.inbound.entries()].sort(([a], [b]) => a.localeCompare(b))),
        adapterErrors: Object.fromEntries(t.errors),
      };
    });
}

function describe(report: PlatformReport): string {
  const errorTotal = sum(Object.values(report.adapterErrors));
  const errors = Object.entries(report.adapterErrors)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([message, n]) => `"${message}" ×${n}`)
    .join(', ');
  const silent = Object.entries(report.liveInboundByChannelType)
    .filter(([, n]) => n === 0)
    .map(([channelType]) => channelType);
  switch (report.verdict) {
    case 'verified':
      return (
        `${report.platform}: verified (${report.liveInbound} live inbound)` +
        (silent.length > 0 ? `; no messages yet on ${silent.join(', ')}` : '')
      );
    case 'failing':
      return `${report.platform}: FAILING — no live inbound, ${errorTotal} adapter error(s): ${errors}`;
    case 'unverified':
      return (
        `${report.platform}: unverified — no live inbound` +
        (errorTotal > 0 ? `, ${errorTotal} adapter error(s): ${errors}` : '')
      );
  }
}

export interface PostDeployReport {
  build: string | null;
  startedAt: string;
  windowMs: number;
  state: 'running' | 'done';
  /** Set when a restart interrupted the previous window and this one replaced it. */
  restartedWindow?: boolean;
  platforms: PlatformReport[];
}

export interface PostDeployCheckDeps {
  build: string | null;
  windowMs: number;
  earlyCheckMs: number;
  /** Adapter errors that make a platform with no inbound `failing` rather than `unverified`. */
  failingErrorThreshold: number;
  notify: (text: string) => Promise<boolean>;
  reportPath: string;
  restartedWindow?: boolean;
}

export const POST_DEPLOY_REPORT_PATH = path.join(REPO_ROOT, 'logs', 'post-deploy-inbound.json');

/** The early report waits ten minutes so a restart's first messages can arrive before anyone is paged. */
export const POST_DEPLOY_EARLY_CHECK_MS = 10 * 60_000;
/** Three, because one routine API error must not turn a quiet platform into a failing one. */
export const POST_DEPLOY_FAILING_ERROR_THRESHOLD = 3;

/** A window still `running` on disk at boot was cut short by a restart, so this boot owes the verdict. */
export function previousWindowUnfinished(reportPath: string = POST_DEPLOY_REPORT_PATH): boolean {
  try {
    return (JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<PostDeployReport>).state === 'running';
  } catch {
    return false;
  }
}

function writeReport(file: string, report: PostDeployReport): void {
  try {
    atomicJson(file, report);
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
    ...(deps.restartedWindow ? { restartedWindow: true } : {}),
    platforms: evaluatePlatforms(deps.failingErrorThreshold),
  });
  const header = `Post-deploy inbound check${deps.build ? ` (build ${deps.build})` : ''}`;
  writeReport(deps.reportPath, snapshot('running'));

  const send = (text: string): void => {
    void deps.notify(text).catch((err: unknown) => log.warn('post-deploy inbound: alert failed', { err, text }));
  };

  const early =
    deps.earlyCheckMs < deps.windowMs
      ? setTimeout(() => {
          const failing = snapshot('running').platforms.filter((r) => r.verdict === 'failing');
          if (failing.length === 0) return;
          log.error('Post-deploy inbound check: platform failing', { platforms: failing });
          send(`${header}: ${failing.map(describe).join('\n')}\nThe final verdict follows when the window closes.`);
        }, deps.earlyCheckMs)
      : undefined;
  early?.unref?.();

  const final = setTimeout(() => {
    clearTimeout(early);
    const report = snapshot('done');
    writeReport(deps.reportPath, report);
    const healthy = report.platforms.length > 0 && report.platforms.every((p) => p.verdict === 'verified');
    log[healthy ? 'info' : 'error']('Post-deploy inbound check finished', { ...report });
    if (!healthy) {
      const minutes = Math.round(deps.windowMs / 60_000);
      const lines = report.platforms.length > 0 ? report.platforms.map(describe) : ['no chat adapter started'];
      send(`${header} after ${minutes} min:\n${lines.join('\n')}`);
    }
  }, deps.windowMs);
  final.unref?.();
}
