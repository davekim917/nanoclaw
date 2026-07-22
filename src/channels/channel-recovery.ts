import type { ChannelAdapter, ChannelConnectionRestored, ChannelRecoveryTarget } from './adapter.js';
import { getActiveAdapters } from './channel-registry.js';
import { getMessagingGroupsByChannel } from '../db/messaging-groups.js';
import { getActiveSessions } from '../db/sessions.js';
import { log } from '../log.js';

const MONITOR_INTERVAL_MS = 1_000;
export const EVENT_LOOP_STALL_THRESHOLD_MS = 5_000;

interface RecoveryDrain {
  pending: ChannelConnectionRestored | null;
  promise: Promise<void>;
}

interface RecoveryRetry {
  attempt: number;
  timer: NodeJS.Timeout | null;
  info: ChannelConnectionRestored;
}

const recoveries = new Map<string, RecoveryDrain>();
const recoveryRetries = new Map<string, RecoveryRetry>();
let monitor: NodeJS.Timeout | null = null;
let lastMonitorTickMs = 0;
let retriesEnabled = true;

/**
 * Buffers live adapter callbacks until the first startup catch-up pass has
 * finished. Recovery-emitted events bypass the queue so the catch-up itself
 * cannot deadlock. Queued live events retain arrival order while the gate is
 * draining, including events arriving between release and the final drain.
 */
export class StartupChannelIngressGate {
  private state: 'holding' | 'draining' | 'open' = 'holding';
  private readonly ready: Promise<void>;
  private releaseReady!: () => void;
  private tail: Promise<void> = Promise.resolve();

  constructor() {
    this.ready = new Promise<void>((resolve) => {
      this.releaseReady = resolve;
    });
  }

  run(recovered: boolean, route: () => Promise<void>): void | Promise<void> {
    if (recovered || this.state === 'open') return route();
    const queued = this.tail.then(() => this.ready).then(route);
    // The route callback owns logging. Keep the queue alive after one failure
    // so later live events are not stranded behind a rejected tail.
    this.tail = queued.catch(() => undefined);
  }

  async open(): Promise<void> {
    if (this.state === 'open') return;
    if (this.state === 'holding') {
      this.state = 'draining';
      this.releaseReady();
    }
    for (;;) {
      const observed = this.tail;
      await observed;
      if (observed === this.tail) break;
    }
    this.state = 'open';
  }
}

function adapterKey(adapter: ChannelAdapter): string {
  return adapter.instance ?? adapter.channelType;
}

function clearRecoveryRetry(key: string): void {
  const retry = recoveryRetries.get(key);
  if (retry?.timer) clearTimeout(retry.timer);
  recoveryRetries.delete(key);
}

function mergeRecoveryInfo(
  current: ChannelConnectionRestored,
  incoming: ChannelConnectionRestored,
): ChannelConnectionRestored {
  const currentMs = Date.parse(current.since);
  const incomingMs = Date.parse(incoming.since);
  const sinceMs = Number.isFinite(currentMs)
    ? Number.isFinite(incomingMs)
      ? Math.min(currentMs, incomingMs)
      : currentMs
    : incomingMs;
  return {
    since: Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : incoming.since,
    reason: incoming.reason,
  };
}

function scheduleRecoveryRetry(adapter: ChannelAdapter, info: ChannelConnectionRestored): void {
  if (!retriesEnabled) return;
  const key = adapterKey(adapter);
  const existing = recoveryRetries.get(key);
  if (existing) {
    existing.info = mergeRecoveryInfo(existing.info, info);
    if (existing.timer) return;
  }
  const attempt = (existing?.attempt ?? 0) + 1;
  const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
  const retry: RecoveryRetry = { attempt, timer: null, info: existing?.info ?? info };
  retry.timer = setTimeout(() => {
    retry.timer = null;
    if (!retriesEnabled) return;
    void recoverChannelAdapter(adapter, retry.info);
  }, delayMs);
  retry.timer.unref();
  recoveryRetries.set(key, retry);
  log.warn('Channel recovery incomplete — retry scheduled', {
    channelType: adapter.channelType,
    instance: key,
    since: retry.info.since,
    attempt,
    delayMs,
  });
}

/** Build a bounded recovery set: every wired conversation root plus active threads. */
export function getChannelRecoveryTargets(adapter: ChannelAdapter): ChannelRecoveryTarget[] {
  const key = adapterKey(adapter);
  const groups = getMessagingGroupsByChannel(adapter.channelType).filter(
    (group) => (group.instance ?? group.channel_type) === key,
  );
  const sessionsByGroup = new Map<string, Set<string>>();
  for (const session of getActiveSessions()) {
    if (!session.messaging_group_id || !session.thread_id) continue;
    const threads = sessionsByGroup.get(session.messaging_group_id) ?? new Set<string>();
    threads.add(session.thread_id);
    sessionsByGroup.set(session.messaging_group_id, threads);
  }

  const targets = new Map<string, ChannelRecoveryTarget>();
  for (const group of groups) {
    const isDM = group.is_group === 0;
    const root: ChannelRecoveryTarget = { platformId: group.platform_id, threadId: null, isDM };
    targets.set(`${group.platform_id}\u0000`, root);
    for (const threadId of sessionsByGroup.get(group.id) ?? []) {
      targets.set(`${group.platform_id}\u0000${threadId}`, { platformId: group.platform_id, threadId, isDM });
    }
  }
  return [...targets.values()];
}

export function recoverChannelAdapter(adapter: ChannelAdapter, info: ChannelConnectionRestored): Promise<void> {
  if (!adapter.recoverMissedMessages) return Promise.resolve();
  const key = adapterKey(adapter);
  const retry = recoveryRetries.get(key);
  if (retry) info = mergeRecoveryInfo(retry.info, info);
  const existing = recoveries.get(key);
  if (existing) {
    existing.pending = existing.pending ? mergeRecoveryInfo(existing.pending, info) : info;
    return existing.promise;
  }

  const drain = { pending: info } as RecoveryDrain;
  drain.promise = (async () => {
    while (drain.pending) {
      const next = drain.pending;
      drain.pending = null;
      try {
        const targets = getChannelRecoveryTargets(adapter);
        const result = await adapter.recoverMissedMessages!({ ...next, targets });
        const context = {
          channelType: adapter.channelType,
          instance: key,
          reason: next.reason,
          since: next.since,
          ...result,
        };
        if (result.failedTargets === 0) {
          clearRecoveryRetry(key);
          log.info('Channel recovery complete', context);
        } else {
          log.warn('Channel recovery pass incomplete', context);
          scheduleRecoveryRetry(adapter, next);
        }
      } catch (err) {
        log.warn('Channel recovery failed', {
          channelType: adapter.channelType,
          instance: key,
          reason: next.reason,
          since: next.since,
          err,
        });
        scheduleRecoveryRetry(adapter, next);
      }
    }
  })().finally(() => {
    if (recoveries.get(key) === drain) recoveries.delete(key);
  });
  recoveries.set(key, drain);
  return drain.promise;
}

export function recoverAllChannelsAfterStall(sinceMs: number): void {
  const since = new Date(sinceMs).toISOString();
  for (const adapter of getActiveAdapters()) {
    void recoverChannelAdapter(adapter, { since, reason: 'event-loop-stall' });
  }
}

/** Catch up every capable adapter after host downtime, including webhooks. */
export async function recoverAllChannelsAfterStartup(sinceMs: number): Promise<void> {
  const since = new Date(sinceMs).toISOString();
  await Promise.all(
    getActiveAdapters().map((adapter) => recoverChannelAdapter(adapter, { since, reason: 'host-startup' })),
  );
}

export function observeEventLoopTick(nowMs: number, previousTickMs: number): number {
  if (previousTickMs > 0) {
    const lagMs = nowMs - previousTickMs - MONITOR_INTERVAL_MS;
    if (lagMs >= EVENT_LOOP_STALL_THRESHOLD_MS) {
      log.warn('Host event loop stall detected — starting channel catch-up', { lagMs });
      recoverAllChannelsAfterStall(previousTickMs);
    }
  }
  return nowMs;
}

export function startChannelRecoveryMonitor(): void {
  retriesEnabled = true;
  if (monitor) return;
  lastMonitorTickMs = Date.now();
  monitor = setInterval(() => {
    lastMonitorTickMs = observeEventLoopTick(Date.now(), lastMonitorTickMs);
  }, MONITOR_INTERVAL_MS);
  monitor.unref();
}

export function stopChannelRecoveryMonitor(): void {
  if (monitor) clearInterval(monitor);
  monitor = null;
  lastMonitorTickMs = 0;
  retriesEnabled = false;
  for (const key of recoveryRetries.keys()) clearRecoveryRetry(key);
}
