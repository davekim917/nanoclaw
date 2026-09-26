/**
 * Aged-occurrence alarm — a recurring occurrence that is due, wake-eligible and
 * untouched for an hour reaches a human.
 *
 * Every per-session guard in the sweep answers a narrow question and declines
 * correctly when it is not its case: the wake duty does not spawn behind a
 * running container, the idle-task reap does not reap while work is due, the
 * ceiling skips a container that never touched its heartbeat, claim-stuck ages
 * claims and there are none, and `expireStalePending` exempts recurring rows.
 * A due row the runner never selects therefore satisfies all of them at once,
 * forever, and the series stops with nothing logged above INFO (observed live
 * 2026-09-15: one series silent for 57 hours across two containers).
 *
 * This asks the one question none of them does — "has due scheduled work sat
 * for an hour with nobody working on IT?" — and asks it of the OUTCOME, not of
 * any cause, so it holds for causes nobody has found yet. It is an observer: it
 * completes, kills and re-arms nothing.
 *
 * It complements `task-failure-escalation` (T24), which counts runs that
 * happened and failed; an occurrence that never runs leaves no outcome row for
 * T24 to count.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { log } from '../../log.js';
import { notifyOperators } from '../../operator-alert.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import { parseSqliteUtc, sqliteUtcToIso } from '../mailbox/sqlite-utc.js';

/**
 * How long a due occurrence may sit before a human is told, measured from its
 * `process_after` alone.
 *
 * A flat hour, not a multiple of the series' cadence. The rows this looks at
 * exclude every occurrence a container has acknowledged, so what is being
 * timed is not "a slow turn on this row" but "due work nobody has picked up" —
 * and that has no legitimate reason to last longer on a daily series than on
 * a 5-minute one. A spawn queue, a provider park or a turn on another row that
 * holds the session for an hour is itself worth the DM. Sixty sweep ticks is
 * also far past any retry backoff (`BACKOFF_BASE_MS * 2 ** MAX_TRIES` in
 * sweep-session-core tops out under 3 minutes).
 *
 * Host uptime does not enter into it. A host that was down comes back to rows
 * that are already late; the attempt gap below lets its first tick send at
 * most one DM, and by the next attempt the rows its wakes reached have been
 * claimed and drop out.
 */
export const TASK_OVERDUE_ALERT_MS = 60 * 60 * 1000;

/**
 * Floor between two alert ATTEMPTS from this process — delivered or not.
 *
 * A fleet-wide cause (the host cannot spawn at all) makes every session with a
 * schedule overdue in the same tick; the first DM says so and the rest arrive
 * one per window instead of as a burst.
 *
 * It advances on a FAILED attempt too, deliberately. A failed attempt can cost
 * the sweep up to `OPERATOR_ALERT_DEADLINE_MS` (src/operator-alert.ts), and if
 * nobody is reachable, not advancing would have every overdue session spend
 * that again on every tick. Holding the other alerts back costs nothing: they
 * go to the same recipients, who were just shown to be unreachable. This gap
 * decides only WHEN the next attempt happens; whether an occurrence still owes
 * an alert is the `alerted` set's business, and a failed attempt leaves it owing.
 */
export const TASK_OVERDUE_ATTEMPT_MIN_GAP_MS = 5 * 60 * 1000;

// One DELIVERED alert per occurrence per host process. In memory on purpose: a
// still-stuck occurrence alerts once more from each new host process, so the
// repeats are bounded by the number of restarts, and a restart loop cannot hide
// a stuck row. An occurrence id is never reused (`task-<ms>-<rand>`,
// recurrence.ts), so an entry is only ever stale, never wrong; stale ones are
// dropped per session below.
const alerted = new Map<string, Set<string>>();
let lastAttemptAtMs = 0;

/** Test-only: forget every delivered alert and the attempt gap. */
export function _resetOverdueAlertsForTesting(): void {
  alerted.clear();
  lastAttemptAtMs = 0;
}

function formatOverdueAlert(input: {
  seriesId: string;
  occurrenceId: string;
  groupName: string;
  sessionId: string;
  dueAt: string;
  overdueMinutes: number;
  containerRunning: boolean;
  queuedBehindActiveWork: boolean;
}): string {
  const session = `session \`${input.sessionId}\``;
  let where: string;
  if (input.queuedBehindActiveWork) {
    where = input.containerRunning
      ? `A container IS running for ${session}, and its turn on another message has not ended — this row is waiting behind it.`
      : `No container is running for ${session}, yet another message still holds a processing claim from an earlier one.`;
  } else {
    where = input.containerRunning
      ? `A container IS running for ${session} and holds no claim — it is not selecting this row.`
      : `No container is running for ${session} — the wake is not landing (spawn refused, queue full, provider parked).`;
  }
  return [
    `*Scheduled task not running:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `Occurrence \`${input.occurrenceId}\` has been due since ${input.dueAt} (${input.overdueMinutes} min) ` +
      (input.queuedBehindActiveWork ? 'and is queued behind active work.' : 'and nothing has claimed it.') +
      ' The series cannot advance until it completes.',
    where,
    '',
    `Start with \`logs/nanoclaw.error.log\` for that session. This alert fires once per occurrence per host process.`,
  ].join('\n');
}

export async function escalateOverdueOccurrences(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerRunning: boolean,
  nowMs = Date.now(),
): Promise<void> {
  const { rows: overdue, queuedBehindActiveWork } = mailbox.listOverdueRecurringRows(
    new Date(nowMs - TASK_OVERDUE_ALERT_MS).toISOString(),
  );
  const seen = alerted.get(session.id);
  if (overdue.length === 0) {
    if (seen) alerted.delete(session.id);
    return;
  }

  for (const row of overdue) {
    if (seen?.has(row.id)) continue;
    if (nowMs - lastAttemptAtMs < TASK_OVERDUE_ATTEMPT_MIN_GAP_MS) return;

    const seriesId = row.seriesId ?? row.id;
    const group = await getAgentGroup(session.agent_group_id);
    const tz = await resolveGroupTimezone(session.agent_group_id);
    const text = formatOverdueAlert({
      seriesId,
      occurrenceId: row.id,
      groupName: group?.name ?? session.agent_group_id,
      sessionId: session.id,
      dueAt: formatLocalTime(sqliteUtcToIso(row.processAfter), tz),
      overdueMinutes: Math.floor((nowMs - parseSqliteUtc(row.processAfter)) / 60_000),
      containerRunning,
      queuedBehindActiveWork,
    });

    // The attempt gap advances whatever happens next (see the constant).
    lastAttemptAtMs = nowMs;
    const context = { source: 'task-overdue', seriesId, occurrenceId: row.id, sessionId: session.id };
    // The OCCURRENCE is stamped only on a delivery that reached someone — same
    // rule, and same reason, as task-failure-escalation
    // (sweep-task-escalation). A failed attempt
    // leaves it owing, to be retried once the attempt gap has passed.
    if (await notifyOperators(text, context)) {
      const stamped = alerted.get(session.id) ?? new Set<string>();
      stamped.add(row.id);
      alerted.set(session.id, stamped);
      log.warn('Escalated a due scheduled occurrence nothing is running', context);
    } else {
      log.warn('Due scheduled occurrence nothing is running could NOT be escalated — nobody was told', {
        ...context,
        text,
      });
    }
  }
}
