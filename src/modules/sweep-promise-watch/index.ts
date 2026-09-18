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
 *   - its newest chat row is the agent's, and the host has recorded no
 *     activity since it (by the host's clock — see `candidateReason`);
 *   - that row is QUIET_MS..MAX_AGE_MS old (a promise for "tomorrow" gets a day);
 *   - no container is running, nothing is due or future-dated in the inbox (a
 *     `wait`, a scheduled wake), and no work continuation is saved.
 * The same check runs again at admission, right before the wake row is written.
 * Only then is the message sent to TypeSafe's Jev with one question — does it
 * commit to further work on the agent's own initiative — and a probability at
 * or above PROMISE_THRESHOLD counts (precision 0.92 on 150 hand-labelled
 * finals at that threshold).
 *
 * Modes (`NANOCLAW_PROMISE_WATCH`): `off` (default — agent text leaves the host
 * for TypeSafe only when an operator opts in), `shadow` (log the decision, wake
 * nothing), `nudge` (write the wake row). A nudge can make an agent speak
 * in a client-facing channel, so production decisions are read in shadow
 * before it is switched on. A wake row's id is keyed by the promising message,
 * so no message is ever nudged twice, and NUDGE_DAILY_CAP — counted in a
 * host-owned file, so a restart does not reset it — bounds a bad day.
 *
 * `tick:housekeeping`, order 136. The scan runs detached every
 * SCAN_INTERVAL_MS so a slow Jev call never holds the sweep tick.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { getSession, getSessionsActiveSince } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY, writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
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

/** Opt-in: agent text goes to a third party (TypeSafe), so anything but an explicit mode is off. */
export function promiseWatchMode(raw: string | undefined): PromiseWatchMode {
  return raw === 'shadow' || raw === 'nudge' ? raw : 'off';
}

/** What the scan reads from one session's DBs. */
export interface SessionSnapshot {
  latestChat: { id: string; timestamp: string; text: string } | null;
  latestInboundAt: string | null;
  nextFutureProcessAfter: string | null;
  dueCount: number;
  hasContinuation: boolean;
}

/**
 * Why a session is or is not worth asking Jev about. Pure; the rule the tests
 * pin. Evaluated twice: at scan time, and again at admission right before the
 * wake row is written, because the Jev call opens a window in which anything
 * here can change.
 */
export function candidateReason(
  session: Pick<Session, 'status' | 'container_status' | 'archived_at' | 'last_active'>,
  snap: SessionSnapshot,
  now: number,
): 'candidate' | string {
  if (session.status !== 'active') return 'not-active';
  if (session.archived_at) return 'archived';
  if (session.container_status !== 'stopped') return 'container-live';
  if (!snap.latestChat || !snap.latestChat.text.trim()) return 'no-chat';
  const chatAt = Date.parse(snap.latestChat.timestamp);
  if (!Number.isFinite(chatAt)) return 'bad-timestamp';
  // "Nothing happened since" takes the later of two signals, and a tie counts
  // as activity. sessions.last_active is the host's clock, stamped on routed
  // inbound and container start (session-manager.ts) — it catches a row whose
  // adapter timestamp reads earlier than its arrival. The newest inbound row's
  // own timestamp catches host writers that insert directly without bumping
  // last_active (host-restart notes, CLI delivery actions). Both only ever ADD
  // activity, so each covers the other's blind spot and neither can create a
  // false "quiet". Rows that arrived mid-turn, before the final chat, carry
  // earlier stamps on both and correctly do not count.
  const lastActive = session.last_active ? Date.parse(session.last_active) : NaN;
  const lastInbound = snap.latestInboundAt ? Date.parse(snap.latestInboundAt) : NaN;
  if (
    (Number.isFinite(lastActive) && lastActive >= chatAt) ||
    (Number.isFinite(lastInbound) && lastInbound >= chatAt)
  ) {
    return 'activity-after';
  }
  const age = now - chatAt;
  if (age < QUIET_MS) return 'too-recent';
  if (age > MAX_AGE_MS) return 'too-old';
  if (snap.dueCount > 0) return 'wake-due';
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

/** Outcome of the admission step that writes a nudge. */
export type NudgeOutcome = 'nudged' | 'duplicate' | 'stale';

/** Durable per-day nudge count, so a host restart does not reset the cap. */
export interface NudgeCapStore {
  /** Take one of today's `cap` slots; false when none is left or the count cannot be trusted. */
  reserve(day: string, cap: number): boolean;
}

export interface ScanDeps {
  now: () => number;
  mode: PromiseWatchMode;
  listSessions: (sinceIso: string) => Promise<Session[]>;
  snapshot: (session: Session) => Promise<SessionSnapshot | undefined>;
  classify: (text: string) => Promise<number>;
  /** Re-checks eligibility against fresh state, then writes the wake row. */
  nudge: (session: Session, messageId: string, text: string, p: number) => Promise<NudgeOutcome>;
  cap: NudgeCapStore;
}

/** Decided message ids, so a candidate is asked about once per process, not every scan. */
const decided = new Map<string, number>();

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export async function scanOnce(deps: ScanDeps): Promise<{ asked: number; promises: number; nudged: number }> {
  const now = deps.now();
  for (const [id, at] of decided) if (now - at > MAX_AGE_MS) decided.delete(id);
  const day = new Date(now).toISOString().slice(0, 10);

  let asked = 0;
  let promises = 0;
  let nudged = 0;
  for (const session of await deps.listSessions(new Date(now - MAX_AGE_MS).toISOString())) {
    // Each snapshot is synchronous SQLite on the host thread: yield between
    // sessions so delivery and timers are never held behind the whole scan.
    await yieldToEventLoop();
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
    if (p < PROMISE_THRESHOLD) {
      decided.set(chat.id, now);
      continue;
    }
    promises += 1;

    const excerpt = chat.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const fields = { sessionId: session.id, agentGroupId: session.agent_group_id, messageId: chat.id, p, excerpt };
    if (deps.mode !== 'nudge') {
      decided.set(chat.id, now);
      log.info('promise-watch: would nudge (shadow)', fields);
      continue;
    }
    // Reserve before writing: a crash after the wake row lands must not leave
    // it uncounted. A reservation the admission then refuses is simply lost,
    // which errs toward fewer nudges.
    if (!deps.cap.reserve(day, NUDGE_DAILY_CAP)) {
      // Not decided: tomorrow's allowance may still reach it inside the window.
      log.warn('promise-watch: daily nudge cap reached, skipping', fields);
      continue;
    }
    let outcome: NudgeOutcome;
    try {
      outcome = await deps.nudge(session, chat.id, nudgeText(chat.timestamp, excerpt), p);
    } catch (err) {
      // Not decided: a failed write retries on the next scan.
      log.warn('promise-watch: nudge write failed', { ...fields, err });
      continue;
    }
    decided.set(chat.id, now);
    if (outcome === 'nudged') {
      nudged += 1;
      log.info('promise-watch: nudged', fields);
    } else {
      log.info(`promise-watch: not nudged (${outcome})`, fields);
    }
  }
  return { asked, promises, nudged };
}

/** Test seam: forget decided ids. */
export function _resetPromiseWatchForTesting(): void {
  decided.clear();
}

function readSnapshot(mailbox: NanoclawMailboxSession): SessionSnapshot {
  const row = mailbox.latestOutboundChat();
  return {
    latestChat: row ? { id: row.id, timestamp: row.timestamp, text: chatText(row.content) } : null,
    latestInboundAt: mailbox.latestInboundTimestamp(),
    nextFutureProcessAfter: mailbox.getNextFutureProcessAfter(),
    dueCount: mailbox.countDueMessages(),
    hasContinuation: mailbox.readWorkContinuation() !== null,
  };
}

const CAP_FILE = path.join(DATA_DIR, 'promise-watch-nudges.json');

/**
 * The per-day count lives in a small host-owned file so a restart does not
 * reset it. A missing file is a fresh count; a file that exists but cannot be
 * read or parsed fails CLOSED — no slot is granted until it is repaired.
 */
export function fileCapStore(file: string = CAP_FILE): NudgeCapStore {
  return {
    reserve: (day, cap) => {
      let state = { day: '', count: 0 };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: unknown; count?: unknown };
        if (typeof parsed.day !== 'string' || typeof parsed.count !== 'number') throw new Error('malformed');
        state = { day: parsed.day, count: parsed.count };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('promise-watch: nudge cap file unreadable, refusing to nudge', { file, err });
          return false;
        }
      }
      const count = state.day === day ? state.count : 0;
      if (count >= cap) return false;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ day, count: count + 1 }));
      fs.renameSync(tmp, file);
      return true;
    },
  };
}

function productionDeps(mode: PromiseWatchMode): ScanDeps {
  return {
    now: Date.now,
    mode,
    listSessions: getSessionsActiveSince,
    snapshot: (session) => withExistingMailboxSession(session.agent_group_id, session.id, readSnapshot),
    classify: async (text) => {
      const answers = await askJev({ agent_final_message: text }, { promises_future: PROMISE_QUESTION });
      const p = answers.promises_future?.noul;
      if (typeof p !== 'number' || !Number.isFinite(p)) throw new Error('malformed Jev answer');
      return p;
    },
    // Admission: re-read the session row and the mailbox, and write only if
    // the same message is still the newest chat and the session is still a
    // candidate. The Jev call is the gap this closes.
    nudge: async (session, messageId, text, p) => {
      // Hold the mailbox first; the central re-read is the LAST await, and
      // everything after it — snapshot, check, write — is synchronous, so no
      // archive, close or spawn can land between the check and the insert.
      const outcome = await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
        const fresh = await getSession(session.id);
        if (!fresh) return 'stale' as const;
        const snap = readSnapshot(mailbox);
        if (snap.latestChat?.id !== messageId || candidateReason(fresh, snap, Date.now()) !== 'candidate') {
          return 'stale' as const;
        }
        const written = writeSystemWake(mailbox, fresh, `${NUDGE_ID_PREFIX}${messageId}`, text, {
          kind: 'promise_nudge',
          message_id: messageId,
          p,
        });
        return written ? ('nudged' as const) : ('duplicate' as const);
      });
      return outcome ?? 'stale';
    },
    cap: fileCapStore(),
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
