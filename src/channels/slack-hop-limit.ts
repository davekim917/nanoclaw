/**
 * Slack sibling-bot loop governor.
 *
 * Two of our own bots wired into the same Slack channel can feed each other:
 * A @-mentions B, B answers and @-mentions A, and neither ever stops because
 * nothing in the stack counts consecutive bot-authored turns. Each turn is a
 * full container wake, so a runaway is expensive long before anyone notices.
 *
 * This is upstream's `SLACK_A2A_MAX_HOPS` idea (nanocoai/nanoclaw
 * `.claude/skills/slack-a2a-rooms/src/channels/slack-a2a.ts`) ported standalone.
 * What is deliberately NOT ported is the layer it sits on upstream —
 * `slack-a2a-guard.ts`, which DROPS every bot-authored inbound by default and
 * admits it only inside allowlisted A2A rooms. This fork's siblings talk to
 * each other in ordinary channels as a first-class feature
 * (`isSiblingBotSender` in src/modules/permissions/access.ts admits them past
 * the access gate on purpose), so a default drop would break the product.
 * Here bot traffic flows by default and only a runaway is bounded.
 *
 * Three deviations from upstream's policy, all because this runs in live
 * channels rather than a purpose-built room:
 *
 *  - **Only OUR bots count.** Upstream counts every bot-authored message.
 *    Live channels carry third-party app traffic (CI, GitHub, alerting) that
 *    is bot-authored but can never be part of an agent loop, and counting it
 *    would silence a genuine sibling handoff that had not spoken yet. The
 *    governor counts only senders in this workspace's known-sibling registry.
 *  - **Per thread, not per room.** A loop is a thread-level phenomenon, and
 *    this fork's sessions are per-thread. Keying per room would let a runaway
 *    in one thread mute siblings in every other thread of the same channel.
 *  - **A generous default.** Upstream's 6 fits a two-bot room with a human in
 *    the loop. Real sibling handoffs here run longer, so the default is 24 —
 *    high enough that no observed exchange reaches it, low enough that an
 *    unattended loop is bounded (at this fleet's typical turn latency, 24
 *    turns is about an hour).
 *
 * The counter resets on any human message in the thread, and `0` disables the
 * governor entirely.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

/** Consecutive sibling-bot turns allowed in one thread with no human. */
export const DEFAULT_MAX_BOT_HOPS = 24;

/** `SLACK_MAX_BOT_HOPS` is re-read at most this often, so an operator can
 *  change it without a host restart. */
const CONFIG_TTL_MS = 30_000;

/**
 * Bound on tracked threads. A counter is one small integer, but the host runs
 * for weeks across many channels, so the map is capped and evicts in insertion
 * order — the oldest thread to reach the cap is also the least likely to still
 * be mid-loop, and a wrongly evicted counter only restores the ungoverned
 * behavior for that thread.
 */
const MAX_TRACKED_THREADS = 1000;

/** `0` disables the governor; anything not a non-negative integer is the default. */
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

/** The inbound facts the governor needs, projected off the Chat SDK message. */
interface HopInbound {
  /** Thread the message arrived in — the counter key. */
  threadId: string;
  /** Authored by one of OUR bots in this workspace. */
  isSiblingBot: boolean;
  /** Authored by a human (not any bot). Only a human resets the counter. */
  isHuman: boolean;
}

export interface SlackHopGovernor {
  /** False ⇒ drop this message. Never false for a human or a foreign bot. */
  admit(inbound: HopInbound): boolean;
  /** Current consecutive-hop count for a thread. Tests and diagnostics. */
  hops(threadId: string): number;
}

/**
 * Build a governor for one bridge instance (one bot identity). `getMaxHops` is
 * injectable for tests; production reads `.env` behind a short TTL cache.
 */
export function createSlackHopGovernor(
  instanceKey: string,
  getMaxHops: () => number = readMaxBotHops,
): SlackHopGovernor {
  const hops = new Map<string, number>();
  /** Threads already at the limit — so a runaway logs once, not per message. */
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
        // A human spoke — the exchange is supervised again. Reset the thread.
        hops.delete(inbound.threadId);
        muted.delete(inbound.threadId);
        return true;
      }
      // Third-party bots are not part of an agent loop and are governed
      // (and usually dropped) by the access gate, not here.
      if (!inbound.isSiblingBot) return true;

      const maxHops = getMaxHops();
      if (maxHops === 0) return true;

      const count = hops.get(inbound.threadId) ?? 0;
      if (count >= maxHops) {
        // Warn on the transition only: a runaway keeps sending, and one log
        // line per dropped message would bury the event that matters.
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
