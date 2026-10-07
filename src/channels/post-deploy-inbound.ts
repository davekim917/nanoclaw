/**
 * After every boot, each chat platform must show live inbound, and keep showing it. Boot, preflight, outbound and
 * reactions can all stay green while an adapter drops messages. A platform fails when its adapter errors reach a
 * threshold and are at least as many as the messages it routed: one routed message must not hide a stream of
 * failures, as a plain Discord message hid the 2026-10-06 mention failures, while adapters' routine API errors on a
 * busy platform stay outnumbered by its traffic.
 */
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

/**
 * Errors the adapters log for a failed outbound or lookup request. A REST call made on the inbound path logs its own
 * inbound error as well, so these say nothing about inbound health; counted, the Discord 429 bursts on posting at the
 * morning peak would page a quiet platform several times a week.
 */
const OUTBOUND_ERRORS = new Set([
  'Discord API error',
  'Discord interaction API error',
  'Slack rejected blocks (invalid_blocks)',
  'Slack response_url failed',
]);

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
      if (!OUTBOUND_ERRORS.has(message)) tally.errors.set(message, (tally.errors.get(message) ?? 0) + 1);
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

function verdictFor(liveInbound: number, errors: number, failingErrorThreshold: number): PlatformVerdict {
  if (errors >= failingErrorThreshold && errors >= liveInbound) return 'failing';
  return liveInbound > 0 ? 'verified' : 'unverified';
}

export function evaluatePlatforms(failingErrorThreshold: number): PlatformReport[] {
  return [...tallies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, t]) => {
      const liveInbound = sum(t.inbound.values());
      const verdict = verdictFor(liveInbound, sum(t.errors.values()), failingErrorThreshold);
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
      return `${report.platform}: FAILING — ${errorTotal} adapter error(s) against ${report.liveInbound} live inbound: ${errors}`;
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
  /** Whether this boot followed a successful `deploy.sh`, or was a manual, crash or hot-patch restart. */
  afterDeploy: boolean;
  platforms: PlatformReport[];
}

export interface PostDeployCheckDeps {
  build: string | null;
  afterDeploy: boolean;
  windowMs: number;
  /** How often the monitor judges the errors and inbound since its last look, for as long as the host runs. */
  monitorIntervalMs: number;
  /** Adapter errors, at least as many as the live inbound beside them, that make a platform `failing`. */
  failingErrorThreshold: number;
  notify: (text: string) => Promise<boolean>;
  reportPath: string;
}

export const POST_DEPLOY_REPORT_PATH = path.join(REPO_ROOT, 'logs', 'post-deploy-inbound.json');

/** Ten minutes, so a restart's first messages can arrive before anyone is paged. */
export const INBOUND_MONITOR_INTERVAL_MS = 10 * 60_000;
/** Three, because one routine API error must not turn a quiet platform into a failing one. */
export const POST_DEPLOY_FAILING_ERROR_THRESHOLD = 3;

function writeReport(file: string, report: PostDeployReport): void {
  try {
    atomicJson(file, report);
  } catch (err) {
    log.warn('post-deploy inbound: report not written', { file, err });
  }
}

/**
 * Starts the boot window and the monitor. The report says `running`, refreshed at each monitor tick, until the window
 * closes, so nobody reads a previous boot's verdict as this one's. The monitor then keeps judging each interval on its
 * own and pages once when a platform starts failing, however long after boot.
 */
export function startPostDeployInboundCheck(deps: PostDeployCheckDeps): void {
  const startedAt = new Date().toISOString();
  let done = false;
  const snapshot = (): PostDeployReport => ({
    build: deps.build,
    startedAt,
    windowMs: deps.windowMs,
    state: done ? 'done' : 'running',
    afterDeploy: deps.afterDeploy,
    platforms: evaluatePlatforms(deps.failingErrorThreshold),
  });
  const header = `${deps.afterDeploy ? 'Post-deploy' : 'Post-restart'} inbound check${deps.build ? ` (build ${deps.build})` : ''}`;
  writeReport(deps.reportPath, snapshot());

  const send = (text: string): void => {
    void deps.notify(text).catch((err: unknown) => log.warn('post-deploy inbound: alert failed', { err, text }));
  };

  let previous = evaluatePlatforms(deps.failingErrorThreshold);
  const failing = new Set<string>();
  const monitor = setInterval(() => {
    const current = evaluatePlatforms(deps.failingErrorThreshold);
    const interval = current.map((now) => {
      const before = previous.find((p) => p.platform === now.platform);
      const liveInbound = now.liveInbound - (before?.liveInbound ?? 0);
      const adapterErrors = Object.fromEntries(
        Object.entries(now.adapterErrors)
          .map(([message, n]) => [message, n - (before?.adapterErrors[message] ?? 0)] as const)
          .filter(([, n]) => n > 0),
      );
      const verdict = verdictFor(liveInbound, sum(Object.values(adapterErrors)), deps.failingErrorThreshold);
      return { ...now, verdict, liveInbound, adapterErrors };
    });
    previous = current;
    if (!done) writeReport(deps.reportPath, snapshot());
    const started = interval.filter((r) => r.verdict === 'failing' && !failing.has(r.platform));
    for (const r of interval) {
      if (r.verdict === 'failing') failing.add(r.platform);
      else if (r.verdict === 'verified' && failing.delete(r.platform)) {
        log.info('Inbound check: platform recovered', { platform: r.platform });
      }
    }
    if (started.length === 0) return;
    const minutes = Math.round(deps.monitorIntervalMs / 60_000);
    log.error('Inbound check: platform failing', { platforms: started });
    send(`${header}, last ${minutes} min:\n${started.map(describe).join('\n')}`);
  }, deps.monitorIntervalMs);
  monitor.unref?.();

  const final = setTimeout(() => {
    done = true;
    const report = snapshot();
    writeReport(deps.reportPath, report);
    const healthy = report.platforms.length > 0 && report.platforms.every((p) => p.verdict === 'verified');
    log[healthy ? 'info' : 'error']('Post-deploy inbound check finished', { ...report });
    const alreadyPaged = report.platforms.every((p) => p.verdict === 'verified' || failing.has(p.platform));
    if (!healthy && !(report.platforms.length > 0 && alreadyPaged)) {
      const minutes = Math.round(deps.windowMs / 60_000);
      const lines = report.platforms.length > 0 ? report.platforms.map(describe) : ['no chat adapter started'];
      send(`${header} after ${minutes} min:\n${lines.join('\n')}`);
      for (const p of report.platforms) if (p.verdict === 'failing') failing.add(p.platform);
    }
  }, deps.windowMs);
  final.unref?.();
}
