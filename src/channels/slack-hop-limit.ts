/**
 * Slack sibling-bot loop governor: two of our bots in one channel can @-mention each other forever, and every turn is
 * a container wake.
 * Upstream's `SLACK_A2A_MAX_HOPS` idea ported standalone, WITHOUT upstream's default drop of bot-authored inbound:
 * siblings talking in ordinary channels is a feature here. Deviations: only OUR bots count (third-party app traffic
 * is bot-authored but never part of a loop); counters are per thread, not per room, so one runaway cannot mute other
 * threads; the default is 24, not 6, because real sibling handoffs run longer.
 * Any human message resets the thread's counter; `0` disables the governor.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

export const DEFAULT_MAX_BOT_HOPS = 24;

/** Re-read at most this often so `SLACK_MAX_BOT_HOPS` changes without a restart. */
const CONFIG_TTL_MS = 30_000;

/**
 * Capped and evicted in insertion order; a wrongly evicted counter only restores ungoverned behavior for that thread.
 */
const MAX_TRACKED_THREADS = 1000;

export function parseMaxBotHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_BOT_HOPS;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_BOT_HOPS;
}

let cached: { at: number; maxHops: number } | null = null;

function readMaxBotHops(): number {
  const now = Date.now();
  if (cached && now - cached.at < CONFIG_TTL_MS) return cached.maxHops;
  cached = { at: now, maxHops: parseMaxBotHops(readEnvFile(['SLACK_MAX_BOT_HOPS']).SLACK_MAX_BOT_HOPS) };
  return cached.maxHops;
}

interface HopInbound {
  threadId: string;
  /** Authored by one of OUR bots in this workspace. */
  isSiblingBot: boolean;
  /** Only a human resets the counter. */
  isHuman: boolean;
}

export interface SlackHopGovernor {
  /** False ⇒ drop. Never false for a human or a foreign bot. */
  admit(inbound: HopInbound): boolean;
  hops(threadId: string): number;
}

export function createSlackHopGovernor(
  instanceKey: string,
  getMaxHops: () => number = readMaxBotHops,
): SlackHopGovernor {
  const hops = new Map<string, number>();
  /** So a runaway logs once, not per message. */
  const muted = new Set<string>();

  const bump = (threadId: string, count: number): void => {
    hops.delete(threadId);
    hops.set(threadId, count);
    if (hops.size <= MAX_TRACKED_THREADS) return;
    const oldest = hops.keys().next();
    if (!oldest.done) {
      hops.delete(oldest.value);
      muted.delete(oldest.value);
    }
  };

  return {
    admit(inbound: HopInbound): boolean {
      if (inbound.isHuman) {
        hops.delete(inbound.threadId);
        muted.delete(inbound.threadId);
        return true;
      }
      // Third-party bots are the access gate's business, not this governor's.
      if (!inbound.isSiblingBot) return true;

      const maxHops = getMaxHops();
      if (maxHops === 0) return true;

      const count = hops.get(inbound.threadId) ?? 0;
      if (count >= maxHops) {
        // Warn on the transition only.
        if (!muted.has(inbound.threadId)) {
          muted.add(inbound.threadId);
          log.warn('Slack hop limit reached — dropping sibling-bot messages until a human speaks', {
            instanceKey,
            threadId: inbound.threadId,
            maxHops,
          });
        }
        return false;
      }
      bump(inbound.threadId, count + 1);
      return true;
    },
    hops(threadId: string): number {
      return hops.get(threadId) ?? 0;
    },
  };
}
