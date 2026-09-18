/**
 * Sweep family: promise watch.
 *
 * An agent that ends a turn with "I'll confirm tomorrow that the nightly
 * succeeded" and arms nothing — no `continue_work`, no `wait` — has made a
 * promise only prose remembers, and prose has no control effect. When nothing
 * else ever happens in that session, the promise is simply dropped. A backtest
 * over 30 days of fleet finals found 4–10 such dropped promises a week that
 * nothing surfaced (Jev harness-accountability backtest, 2026-09-18).
 *
 * This duty finds them and, once per message, wakes the session with a system
 * note asking the agent to do it, queue it, or say it no longer applies.
 *
 * A session is a candidate only when all of these hold (all cheap, all local):
 *   - its newest chat row is the agent's, and nothing inbound came after it;
 *   - that row is QUIET_MS..MAX_AGE_MS old (a promise for "tomorrow" gets a day);
 *   - no container is running, no future-dated row is pending (a `wait` or a
 *     scheduled wake), and no work continuation is saved.
 * Only then is the message sent to TypeSafe's Jev with one question — does it
 * commit to further work on the agent's own initiative — and a probability at
 * or above PROMISE_THRESHOLD counts (precision 0.92 on 150 hand-labelled
 * finals at that threshold).
 *
 * Modes (`NANOCLAW_PROMISE_WATCH`): `off`, `shadow` (default — log the decision,
 * wake nothing), `nudge` (write the wake row). A nudge can make an agent speak
 * in a client-facing channel, so production decisions are read in shadow
 * before it is switched on. A wake row's id is keyed by the promising message,
 * so no message is ever nudged twice, and NUDGE_DAILY_CAP bounds a bad day.
 *
 * `tick:housekeeping`, order 136. The scan runs detached every
 * SCAN_INTERVAL_MS so a slow Jev call never holds the sweep tick.
 */
import { getSessionsActiveSince } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY, writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { askJev, type JevQuestion } from '../../typesafe.js';
import type { Session } from '../../types.js';

export const QUIET_MS = 24 * 60 * 60_000;
export const MAX_AGE_MS = 72 * 60 * 60_000;
export const SCAN_INTERVAL_MS = 30 * 60_000;
export const PROMISE_THRESHOLD = 0.85;
export const NUDGE_DAILY_CAP = 10;
const MAX_MESSAGE_CHARS = 6_000;
export const NUDGE_ID_PREFIX = 'promise-nudge-';

export type PromiseWatchMode = 'off' | 'shadow' | 'nudge';

export function promiseWatchMode(raw: string | undefined): PromiseWatchMode {
  return raw === 'off' || raw === 'nudge' ? raw : 'shadow';
}

/** What the scan reads from one session's DBs. */
export interface SessionSnapshot {
  latestChat: { id: string; timestamp: string; text: string } | null;
  latestInboundAt: string | null;
  nextFutureProcessAfter: string | null;
  hasContinuation: boolean;
}

/** Why a session is or is not worth asking Jev about. Pure; the rule the tests pin. */
export function candidateReason(
  session: Pick<Session, 'container_status' | 'archived_at'>,
  snap: SessionSnapshot,
  now: number,
): 'candidate' | string {
  if (session.archived_at) return 'archived';
  if (session.container_status !== 'stopped') return 'container-live';
  if (!snap.latestChat || !snap.latestChat.text.trim()) return 'no-chat';
  const chatAt = Date.parse(snap.latestChat.timestamp);
  if (!Number.isFinite(chatAt)) return 'bad-timestamp';
  if (snap.latestInboundAt && Date.parse(snap.latestInboundAt) > chatAt) return 'activity-after';
  const age = now - chatAt;
  if (age < QUIET_MS) return 'too-recent';
  if (age > MAX_AGE_MS) return 'too-old';
  if (snap.nextFutureProcessAfter) return 'wake-pending';
  if (snap.hasContinuation) return 'continuation-saved';
  return 'candidate';
}

/** The promise question from the backtest (V2), plus scheduled-time wording it missed. */
export const PROMISE_QUESTION: JevQuestion = {
  type: 'noul',
  instructions:
    'The agent commits itself to doing further work after this message on its own initiative — for example ' +
    '"I\'ll retry", "fixing now", "next I will", "will follow up", "a worker is building", "queued for 10:55 PM", ' +
    '"I\'ll confirm tomorrow", or naming a later time or wake at which it will take the next step. A promise that ' +
    'only takes effect if the user first does or says something (e.g. "say the word and I\'ll run it", "if you ' +
    'approve, I\'ll merge") is NOT an unconditional promise. Saying it will do nothing, is stopping, or is waiting ' +
    'is NOT a promise.',
  criteria: {
    true: 'The message commits the agent to a specific next action it will take without being asked again.',
    false: 'No unconditional commitment: a report, a question, an offer conditional on the user, or an explicit stop.',
  },
};

/** Emails, phone numbers and long digit runs out before the text leaves the host. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]')
    .slice(0, MAX_MESSAGE_CHARS);
}

export function nudgeText(promisedAt: string, excerpt: string): string {
  return (
    `[system] Promise check. Your last message in this conversation (${promisedAt}) committed to further work, ` +
    `and nothing has happened here since — no continue_work, no wait, no later message. The message began: ` +
    `"${excerpt}". If you did it elsewhere, or it no longer applies, end this turn without posting anything. ` +
    `If it is still owed, do it now, or queue it with continue_work, and post only the result.`
  );
}

function chatText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

export interface ScanDeps {
  now: () => number;
  mode: PromiseWatchMode;
  listSessions: (sinceIso: string) => Promise<Session[]>;
  snapshot: (session: Session) => Promise<SessionSnapshot | undefined>;
  classify: (text: string) => Promise<number>;
  nudge: (session: Session, messageId: string, text: string, p: number) => Promise<boolean>;
}

/** Decided message ids, so a candidate is asked about once, not every scan. */
const decided = new Map<string, number>();
let nudgeDay = '';
let nudgesToday = 0;

export async function scanOnce(deps: ScanDeps): Promise<{ asked: number; promises: number; nudged: number }> {
  const now = deps.now();
  for (const [id, at] of decided) if (now - at > MAX_AGE_MS) decided.delete(id);
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== nudgeDay) {
    nudgeDay = day;
    nudgesToday = 0;
  }

  let asked = 0;
  let promises = 0;
  let nudged = 0;
  for (const session of await deps.listSessions(new Date(now - MAX_AGE_MS).toISOString())) {
    let snap: SessionSnapshot | undefined;
    try {
      snap = await deps.snapshot(session);
    } catch (err) {
      log.debug('promise-watch: session unreadable', { sessionId: session.id, err });
      continue;
    }
    if (!snap || candidateReason(session, snap, now) !== 'candidate') continue;
    const chat = snap.latestChat!;
    if (decided.has(chat.id)) continue;

    let p: number;
    try {
      p = await deps.classify(redact(chat.text));
    } catch (err) {
      // Not recorded as decided: a Jev outage retries on the next scan.
      log.warn('promise-watch: classify failed', { sessionId: session.id, err });
      continue;
    }
    asked += 1;
    decided.set(chat.id, now);
    if (p < PROMISE_THRESHOLD) continue;
    promises += 1;

    const excerpt = chat.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const fields = { sessionId: session.id, agentGroupId: session.agent_group_id, messageId: chat.id, p, excerpt };
    if (deps.mode !== 'nudge') {
      log.info('promise-watch: would nudge (shadow)', fields);
      continue;
    }
    if (nudgesToday >= NUDGE_DAILY_CAP) {
      log.warn('promise-watch: daily nudge cap reached, skipping', fields);
      continue;
    }
    if (await deps.nudge(session, chat.id, nudgeText(chat.timestamp, excerpt), p)) {
      nudgesToday += 1;
      nudged += 1;
      log.info('promise-watch: nudged', fields);
    }
  }
  return { asked, promises, nudged };
}

/** Test seam: forget decided ids and the daily counter. */
export function _resetPromiseWatchForTesting(): void {
  decided.clear();
  nudgeDay = '';
  nudgesToday = 0;
}

function productionDeps(mode: PromiseWatchMode): ScanDeps {
  return {
    now: Date.now,
    mode,
    listSessions: getSessionsActiveSince,
    snapshot: (session) =>
      withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
        const row = mailbox.latestOutboundChat();
        return {
          latestChat: row ? { id: row.id, timestamp: row.timestamp, text: chatText(row.content) } : null,
          latestInboundAt: mailbox.latestInboundTimestamp(),
          nextFutureProcessAfter: mailbox.getNextFutureProcessAfter(),
          hasContinuation: mailbox.readWorkContinuation() !== null,
        };
      }),
    classify: async (text) => {
      const answers = await askJev({ agent_final_message: text }, { promises_future: PROMISE_QUESTION });
      const p = answers.promises_future?.noul;
      if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('malformed Jev answer');
      return p;
    },
    nudge: async (session, messageId, text, p) =>
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        writeSystemWake(mailbox, session, `${NUDGE_ID_PREFIX}${messageId}`, text, {
          kind: 'promise_nudge',
          message_id: messageId,
          p,
        }),
      )) === true,
  };
}

let lastScanAt = 0;
let scanning = false;

export function registerPromiseWatchSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK5,
    phase: 'tick:housekeeping',
    order: 136,
    run: () => {
      const mode = promiseWatchMode(
        process.env.NANOCLAW_PROMISE_WATCH ?? readEnvFile(['NANOCLAW_PROMISE_WATCH']).NANOCLAW_PROMISE_WATCH,
      );
      if (mode === 'off' || scanning || Date.now() - lastScanAt < SCAN_INTERVAL_MS) return;
      lastScanAt = Date.now();
      scanning = true;
      // Detached: the tick never waits on Jev.
      void scanOnce(productionDeps(mode))
        .then((r) => {
          if (r.asked > 0) log.info('promise-watch: scan done', { mode, ...r });
        })
        .catch((err) => log.warn('promise-watch: scan failed', { err }))
        .finally(() => {
          scanning = false;
        });
    },
  });
}

registerSweepDutySource('promise-watch', registerPromiseWatchSweepDuties);
