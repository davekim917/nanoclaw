import type { ChannelAdapter, ChannelConnectionRestored, ChannelRecoveryTarget } from './adapter.js';
import { getActiveAdapters } from './channel-registry.js';
import { getMessagingGroupsByChannel } from '../db/messaging-groups.js';
import { getActiveSessions } from '../db/sessions.js';
import { log } from '../log.js';

const MONITOR_INTERVAL_MS = 1_000;
const EVENT_LOOP_STALL_THRESHOLD_MS = 5_000;

// Unthrottled stall-triggered catch-up self-sustains: each pass's REST scans (and their decompression) can stall the
// loop long enough to trigger the next. So at most one stall pass runs per cooldown window, with stalls inside the
// window coalesced (earliest `since` wins) into one deferred pass, and stall passes expand threads only for sessions
// active within the horizon. Roots are never bounded, and transport-resumed and host-startup passes keep the full
// set, since those cover long gaps.
export const STALL_RECOVERY_COOLDOWN_MS = 5 * 60_000;
export const STALL_TARGET_ACTIVITY_HORIZON_MS = 48 * 60 * 60_000;

interface RecoveryDrain {
  pending: ChannelConnectionRestored | null;
  promise: Promise<void>;
}

// Transient failures back off to a 15-minute ceiling and park after 8 consecutive failed passes. Only transport-level
// triggers (ready/resumed, host-startup) un-park an adapter; stall-triggered recovery does not, so a recovery storm
// cannot un-park itself. Dropping the in-memory `since` on un-park is safe: the bridge re-applies the durable gap
// floor.
const RECOVERY_RETRY_MAX_DELAY_MS = 15 * 60_000;
const RECOVERY_PARK_AFTER_ATTEMPTS = 8;

interface RecoveryRetry {
  attempt: number;
  timer: NodeJS.Timeout | null;
  info: ChannelConnectionRestored;
  parked?: boolean;
}

const recoveries = new Map<string, RecoveryDrain>();
const recoveryRetries = new Map<string, RecoveryRetry>();
let monitor: NodeJS.Timeout | null = null;
let lastMonitorTickMs = 0;
let retriesEnabled = true;

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
  if (attempt > RECOVERY_PARK_AFTER_ATTEMPTS) {
    recoveryRetries.set(key, { attempt, timer: null, info: existing?.info ?? info, parked: true });
    log.error('Channel recovery parked after repeated failures — resumes on next transport event', {
      channelType: adapter.channelType,
      instance: key,
      since: (existing?.info ?? info).since,
      attempt,
    });
    return;
  }
  const delayMs = Math.min(RECOVERY_RETRY_MAX_DELAY_MS, 1_000 * 2 ** Math.min(attempt - 1, 10));
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

/**
 * Adapters with native thread discovery get roots only; others get roots plus known threads. With `activeSinceMs`,
 * thread expansion only includes sessions active since then; sessions with no parseable activity are included
 * (fail-open).
 */
export async function getChannelRecoveryTargets(
  adapter: ChannelAdapter,
  opts: { activeSinceMs?: number } = {},
): Promise<ChannelRecoveryTarget[]> {
  const key = adapterKey(adapter);
  const groups = (await getMessagingGroupsByChannel(adapter.channelType)).filter(
    (group) => (group.instance ?? group.channel_type) === key,
  );
  const sessionsByGroup = new Map<string, Set<string>>();
  if (adapter.recoveryDiscoversThreads !== true) {
    for (const session of await getActiveSessions()) {
      if (!session.messaging_group_id || !session.thread_id) continue;
      if (opts.activeSinceMs !== undefined) {
        const activityMs = Date.parse(session.last_active ?? session.created_at ?? '');
        if (Number.isFinite(activityMs) && activityMs < opts.activeSinceMs) continue;
      }
      const threads = sessionsByGroup.get(session.messaging_group_id) ?? new Set<string>();
      threads.add(session.thread_id);
      sessionsByGroup.set(session.messaging_group_id, threads);
    }
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
  let retry = recoveryRetries.get(key);
  if (retry?.parked) {
    if (info.reason === 'event-loop-stall') return Promise.resolve();
    clearRecoveryRetry(key);
    retry = undefined;
  }
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
        const targets = await getChannelRecoveryTargets(
          adapter,
          next.reason === 'event-loop-stall' ? { activeSinceMs: Date.now() - STALL_TARGET_ACTIVITY_HORIZON_MS } : {},
        );
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
          const retryInfo = drain.pending ? mergeRecoveryInfo(next, drain.pending) : next;
          drain.pending = null;
          scheduleRecoveryRetry(adapter, retryInfo);
        }
      } catch (err) {
        log.warn('Channel recovery failed', {
          channelType: adapter.channelType,
          instance: key,
          reason: next.reason,
          since: next.since,
          err,
        });
        const retryInfo = drain.pending ? mergeRecoveryInfo(next, drain.pending) : next;
        drain.pending = null;
        scheduleRecoveryRetry(adapter, retryInfo);
      }
    }
  })().finally(() => {
    if (recoveries.get(key) === drain) recoveries.delete(key);
  });
  recoveries.set(key, drain);
  return drain.promise;
}

let lastStallPassStartedAtMs = 0;
let pendingStallSinceMs: number | null = null;
let pendingStallTimer: NodeJS.Timeout | null = null;

export function _resetStallRecoveryCooldownForTesting(): void {
  lastStallPassStartedAtMs = 0;
  pendingStallSinceMs = null;
  if (pendingStallTimer) clearTimeout(pendingStallTimer);
  pendingStallTimer = null;
}

export function recoverAllChannelsAfterStall(sinceMs: number): void {
  const now = Date.now();
  const elapsed = now - lastStallPassStartedAtMs;
  if (elapsed < STALL_RECOVERY_COOLDOWN_MS) {
    // Coalesce into one deferred pass rather than dropping the gap or firing now.
    pendingStallSinceMs = Math.min(pendingStallSinceMs ?? sinceMs, sinceMs);
    if (!pendingStallTimer) {
      pendingStallTimer = setTimeout(() => {
        pendingStallTimer = null;
        const deferredSinceMs = pendingStallSinceMs;
        pendingStallSinceMs = null;
        if (deferredSinceMs !== null) recoverAllChannelsAfterStall(deferredSinceMs);
      }, STALL_RECOVERY_COOLDOWN_MS - elapsed);
      pendingStallTimer.unref();
    }
    return;
  }
  lastStallPassStartedAtMs = now;
  const since = new Date(sinceMs).toISOString();
  for (const adapter of getActiveAdapters()) {
    void recoverChannelAdapter(adapter, { since, reason: 'event-loop-stall' });
  }
}

export async function recoverAllChannelsAfterStartup(sinceMs: number): Promise<void> {
  const since = new Date(sinceMs).toISOString();
  await Promise.all(
    getActiveAdapters().map((adapter) => recoverChannelAdapter(adapter, { since, reason: 'host-startup' })),
  );
}

function observeEventLoopTick(nowMs: number, previousTickMs: number): number {
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
