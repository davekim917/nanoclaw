/**
 * Finds sessions whose last agent message promised further work but armed
 * nothing (no `continue_work`, no `wait`) and nothing happened since, then
 * wakes them once per message asking the agent to do it, queue it, or drop it.
 *
 * PROMISE_THRESHOLD is only valid for PROMISE_QUESTION's exact wording, and the
 * labelled set it was chosen against was never checked in: rewording the
 * question leaves the threshold unvalidatable.
 *
 * Modes (`NANOCLAW_PROMISE_WATCH`): `off` (default; agent text leaves the host
 * for TypeSafe only on opt-in), `shadow` (log only), `nudge`. A nudge can make
 * an agent speak in a client-facing channel. Wake ids are keyed by message and
 * the daily cap is file-backed, so neither resets on restart.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { containerOwnsOutbound } from '../../container-runner.js';
import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { getSessionsActiveSince } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY, writeSystemWake } from '../../host-sweep.js';
import { log } from '../../log.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { askJev, type JevQuestion } from '../../typesafe.js';
import type { Session } from '../../types.js';

export const QUIET_MS = 24 * 60 * 60_000;
export const MAX_AGE_MS = 72 * 60 * 60_000;
const SCAN_INTERVAL_MS = 30 * 60_000;
const PROMISE_THRESHOLD = 0.85;
export const NUDGE_DAILY_CAP = 10;
const MAX_MESSAGE_CHARS = 6_000;
const NUDGE_ID_PREFIX = 'promise-nudge-';

export type PromiseWatchMode = 'off' | 'shadow' | 'nudge';

/** Opt-in: agent text goes to a third party (TypeSafe), so anything but an explicit mode is off. */
export function promiseWatchMode(raw: string | undefined): PromiseWatchMode {
  return raw === 'shadow' || raw === 'nudge' ? raw : 'off';
}

export interface SessionSnapshot {
  latestChat: { id: string; timestamp: string; text: string } | null;
  latestInboundAt: string | null;
  nextFutureProcessAfter: string | null;
  dueCount: number;
  hasContinuation: boolean;
}

/**
 * Evaluated twice, at scan and again at admission, because the Jev call opens
 * a window in which any of this can change.
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
  // "Nothing happened since" takes the later of two signals, a tie counting as
  // activity: last_active (host clock, catches adapter timestamps earlier than
  // arrival) and the newest inbound row (catches host writers that don't bump
  // last_active). Both only ever ADD activity.
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

/** Taken inside the synchronous admission block, right before the write. */
export function admissible(
  fresh: Session | undefined,
  containerOwns: boolean,
  snap: SessionSnapshot,
  messageId: string,
  now: number,
): boolean {
  if (!fresh || containerOwns) return false;
  return snap.latestChat?.id === messageId && candidateReason(fresh, snap, now) === 'candidate';
}

/** The promise question from the backtest (V2), plus scheduled-time wording it missed. */
const PROMISE_QUESTION: JevQuestion = {
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

function nudgeText(promisedAt: string, excerpt: string): string {
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

/**
 * Head AND tail when too long: a commitment lands at the end of a message at
 * least as often as at the start, and a human judges the flag from this text.
 */
const LOG_TEXT_LIMIT = 4_000;
const LOG_TEXT_EDGE = 1_800;

export function flaggedText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= LOG_TEXT_LIMIT) return flat;
  const dropped = flat.length - LOG_TEXT_EDGE * 2;
  return `${flat.slice(0, LOG_TEXT_EDGE)} […${dropped} chars omitted…] ${flat.slice(-LOG_TEXT_EDGE)}`;
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

    // The log carries the whole message for human review; the nudge quotes a
    // short opening so it doesn't paste a wall into the agent's next turn.
    const excerpt = chat.text.replace(/\s+/g, ' ').trim().slice(0, 160);
    const fields = {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      messageId: chat.id,
      p,
      text: flaggedText(chat.text),
    };
    if (deps.mode !== 'nudge') {
      decided.set(chat.id, now);
      log.info('promise-watch: would nudge (shadow)', fields);
      continue;
    }
    // Reserve before writing so a crash after the wake row lands can't leave
    // it uncounted.
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

/** A real UTC calendar day in YYYY-MM-DD form (rejects 2026-99-99 and 2026-02-31). */
function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** A missing file is a fresh count; an unreadable or malformed one fails CLOSED. */
export function fileCapStore(file: string = CAP_FILE): NudgeCapStore {
  return {
    reserve: (day, cap) => {
      let state = { day: '', count: 0 };
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { day?: unknown; count?: unknown };
        if (
          typeof parsed.day !== 'string' ||
          !isCalendarDay(parsed.day) ||
          typeof parsed.count !== 'number' ||
          !Number.isSafeInteger(parsed.count) ||
          parsed.count < 0
        ) {
          throw new Error('malformed');
        }
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
    // Only the central lease is awaited; inside it one synchronous block
    // re-checks and writes, so nothing interleaves between check and insert
    // (archive/close need the same lease; a spawn registers in memory first).
    nudge: async (session, messageId, text, p) => {
      const outcome = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        withCentralSync((): NudgeOutcome => {
          const fresh = withRawDb(
            (db) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as Session | undefined,
          );
          if (
            !admissible(
              fresh,
              fresh ? containerOwnsOutbound(fresh.id) : true,
              readSnapshot(mailbox),
              messageId,
              Date.now(),
            )
          ) {
            return 'stale';
          }
          const written = writeSystemWake(mailbox, fresh!, `${NUDGE_ID_PREFIX}${messageId}`, text, {
            kind: 'promise_nudge',
            message_id: messageId,
            p,
          });
          return written ? 'nudged' : 'duplicate';
        }, 'promise-watch admission'),
      );
      return outcome ?? 'stale';
    },
    cap: fileCapStore(),
  };
}

let lastScanAt = 0;
let scanning = false;

function registerPromiseWatchSweepDuties(): void {
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
