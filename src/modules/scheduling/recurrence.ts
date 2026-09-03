/**
 * Sweep hook for recurring tasks.
 *
 * Every sweep tick, find `messages_in` rows that are `completed` AND still
 * have a `recurrence` cron expression. For each, compute the next run via
 * cron-parser, insert a fresh pending row (copying series_id forward), then
 * clear the recurrence on the original so it isn't re-cloned next tick.
 *
 * Called from `src/host-sweep.ts` inside `MODULE-HOOK:scheduling-recurrence`.
 * When scheduling ships inline (current state through PR #7), the hook is a
 * direct dynamic import. When scheduling moves to the modules branch in
 * PR #8, the install skill re-fills the marker on install.
 */
import { touchSessionActivity } from '../../db/sessions.js';
import { CronExpressionParser } from 'cron-parser';

import { resolveGroupTimezone } from '../../container-config.js';
import { log } from '../../log.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import type { Session } from '../../types.js';
import { appendRunLog } from './run-log.js';

// Consecutive pre-task-script failures (the series' trailing FAILED runs —
// derived from occurrence rows, no stored counter) throttle a broken monitor
// script instead of letting it wake a container at raw cron cadence forever.
// A deliberate wakeAgent=false gate is a normal completed run and never backs
// off. Mirrors the stuck-message retry in host-sweep.ts (BACKOFF_BASE_MS
// doubling, MAX_TRIES → failed): fail loud, don't spin.
const SCRIPT_FAIL_PAUSE_CAP = 8;
const SCRIPT_BACKOFF_CAP_MIN = 60;

/**
 * Auto-pause used to terminate in a run-log line and a host warning, and
 * nothing read either. A paused series is an ABSORBING STATE: it stops firing,
 * so it stops being the reason anyone looks at it, and it stays dead until a
 * human happens to run `ncl tasks get`. Measured 2026-08-17: two series paused
 * this way, one for 15 days, and the failing script in one of them had since
 * started working — it would never have run again.
 *
 * So the pause now owes someone an action. The note is DUE IMMEDIATELY rather
 * than on-wake: an on-wake note is only read when something else wakes the
 * container, and for a group whose only wake source was the series that just
 * paused, that is never. A due row makes the sweep wake it (host-sweep.ts's
 * `dueCount > 0` branch), so the obligation lands even on an otherwise idle
 * agent. Dedup id is the series, so one pause raises one note.
 */
function notifyOwnerOfPause(
  mailbox: NanoclawMailboxSession,
  session: Session,
  seriesId: string,
  scriptFails: number,
): void {
  try {
    mailbox.insertDeferredMessageWithContextIfNew({
      id: `task-paused-${seriesId}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text:
          `[system] Scheduled series \`${seriesId}\` auto-paused after ${scriptFails} consecutive ` +
          `script failures and is NOT running. Diagnose the script, then either fix it and run ` +
          `\`ncl tasks resume ${seriesId}\`, or post once to the humans who depend on it naming what ` +
          `you need. Do not leave it paused silently — while it is paused, whatever it watches is unwatched.`,
        sender: 'system',
        senderId: 'system',
        _system: { kind: 'task-auto-paused', seriesId, scriptFails },
      }),
      processAfter: new Date().toISOString(),
      recurrence: null,
      onWake: 0,
    });
  } catch (err) {
    // Same rule as the run-log note: the sweep must not crash over a notice.
    log.warn('Could not write auto-pause notice', { seriesId, err });
  }
}

/** 2, 4, 8, 16, 32, 60, 60… minutes for fails = 1, 2, 3… */
export function scriptBackoffMinutes(fails: number): number {
  return Math.min(2 * 2 ** (fails - 1), SCRIPT_BACKOFF_CAP_MIN);
}

/** Host-written line in the series run log — no agent session exists to call
 *  append-log when a script-gated series is auto-paused. Uses the shared
 *  appendRunLog helper (one writer format); appendRunLog throws on a bad
 *  series charset or a missing agent group, and the sweep must not crash
 *  over a log line, so failures are logged and swallowed. */
function appendHostTaskNote(agentGroupId: string, seriesId: string, note: string): void {
  try {
    appendRunLog(agentGroupId, seriesId, note);
  } catch (err) {
    log.warn('Could not append host task note to run log', { agentGroupId, seriesId, err });
  }
}

/**
 * Fan out completed recurring tasks into their next occurrence.
 *
 * Takes the sweep's own mailbox SESSION rather than a raw handle. `host-sweep.ts`
 * is the only production caller and already holds a session for this key, so
 * opening a second one here would trip the same-key nesting guard (invariant
 * I-3); a session parameter is the seam's sanctioned object, and unlike a
 * handle it keeps this file off the ratchet's raw-access allowlist (I-9).
 */
export async function handleRecurrence(mailbox: NanoclawMailboxSession, session: Session): Promise<void> {
  const recurring = mailbox.getCompletedRecurringRows();
  // Resolved per call, not cached at module load: a group timezone change
  // (approved `groups config update --timezone`) shifts the series from the
  // very next re-arm. The occurrence already armed keeps its absolute UTC
  // instant — changing the override deliberately does not reach into live
  // session DBs to rewrite `process_after`, so one more fire can land at the
  // old local time before the series settles onto the new grid.
  const tz = resolveGroupTimezone(session.agent_group_id);

  for (const msg of recurring) {
    try {
      // Interpret the cron expression in the user's timezone. v1 did this
      // (src/v1/task-scheduler.ts:20-49); without it, a task written "0 9 * * *"
      // by an agent running in a user's local TZ fires at 09:00 UTC instead of
      // 09:00 user-local.
      const interval = CronExpressionParser.parse(msg.recurrence, { tz });
      const cronNext = interval.next().toDate();
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const scriptFails = mailbox.trailingFailedRuns(msg.series_id ?? msg.id);

      if (scriptFails >= SCRIPT_FAIL_PAUSE_CAP) {
        // Re-arm PAUSED at the cron time so `ncl tasks resume` revives the
        // series in place; leave the why in the run log. Insert + clear are
        // one transaction: a crash between them would leave the predecessor
        // still recurrence-armed next to a live successor → double-fire.
        mailbox.armNextRecurrence(msg.id, msg, newId, cronNext.toISOString(), 'paused');
        touchSessionActivity(session.id);
        appendHostTaskNote(
          session.agent_group_id,
          msg.series_id,
          `auto-paused after ${scriptFails} consecutive script failures (host); fix the script, then \`ncl tasks resume ${msg.series_id}\``,
        );
        notifyOwnerOfPause(mailbox, session, msg.series_id ?? msg.id, scriptFails);
        log.warn('Task series auto-paused: script keeps failing', {
          seriesId: msg.series_id,
          scriptFails,
          sessionId: session.id,
        });
        continue;
      }

      const backoffAt = scriptFails > 0 ? Date.now() + scriptBackoffMinutes(scriptFails) * 60_000 : 0;
      const nextRun = new Date(Math.max(cronNext.getTime(), backoffAt)).toISOString();

      mailbox.armNextRecurrence(msg.id, msg, newId, nextRun);
      touchSessionActivity(session.id);

      log.info('Inserted next recurrence', {
        originalId: msg.id,
        newId,
        seriesId: msg.series_id,
        nextRun,
        ...(scriptFails > 0 && { scriptFails, backoffMin: scriptBackoffMinutes(scriptFails) }),
        sessionId: session.id,
      });
    } catch (err) {
      log.error('Failed to compute next recurrence', {
        messageId: msg.id,
        recurrence: msg.recurrence,
        err,
      });
    }
  }
}
