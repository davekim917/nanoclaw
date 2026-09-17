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
 * with nobody working on anything?" — and asks it of the OUTCOME, not of any
 * cause, so it holds for causes nobody has found yet. It is an observer: it
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
 * How long a due occurrence may sit before a human is told.
 *
 * A flat hour, not a multiple of the series' cadence. The rows this looks at
 * already exclude every session where a container holds a claim, so what is
 * being timed is not "a slow turn" but "due work and nobody working" — and
 * that has no legitimate reason to last longer on a daily series than on a
 * 5-minute one. A spawn queue or a provider park that lasts an hour is itself
 * worth the DM. Sixty sweep ticks is also far past any retry backoff
 * (`BACKOFF_BASE_MS * 2 ** MAX_TRIES`, src/modules/sweep-session-core/index.ts:47-48,
 * tops out under 3 minutes).
 */
export const TASK_OVERDUE_ALERT_MS = 60 * 60 * 1000;

/**
 * Floor between two alerts from this process. A fleet-wide cause (the host
 * cannot spawn at all) makes every session with a schedule overdue in the same
 * tick; the first DM says so and the rest arrive one per window instead of as a
 * burst. Un-sent alerts stay armed — nothing is stamped for them.
 */
export const TASK_OVERDUE_ALERT_MIN_GAP_MS = 5 * 60 * 1000;

// One alert per occurrence per host process. In memory on purpose: a host
// restart clears it together with `process.uptime()` below, so a still-stuck
// occurrence alerts again only after another full TASK_OVERDUE_ALERT_MS of
// THIS host watching it — a repeat that is news, not spam. An occurrence id is
// never reused (`task-<ms>-<rand>`, recurrence.ts), so an entry is only ever
// stale, never wrong; stale ones are dropped per session below.
const alerted = new Map<string, Set<string>>();
let lastAlertAtMs = 0;

/** Test-only: forget every alert and the rate floor. */
export function _resetOverdueAlertsForTesting(): void {
  alerted.clear();
  lastAlertAtMs = 0;
}

/**
 * The cutoff a row's `process_after` must precede to count as overdue, or null
 * while this host has not itself been up for the full window. A host that was
 * down for six hours comes back to rows six hours overdue that its very next
 * tick will wake; only time the sweep was actually running counts against them.
 */
export function overdueCutoffMs(nowMs: number, hostUptimeMs: number): number | null {
  return hostUptimeMs < TASK_OVERDUE_ALERT_MS ? null : nowMs - TASK_OVERDUE_ALERT_MS;
}

export function formatOverdueAlert(input: {
  seriesId: string;
  occurrenceId: string;
  groupName: string;
  sessionId: string;
  dueAt: string;
  overdueMinutes: number;
  containerRunning: boolean;
}): string {
  return [
    `*Scheduled task not running:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `Occurrence \`${input.occurrenceId}\` has been due since ${input.dueAt} (${input.overdueMinutes} min) ` +
      `and nothing has claimed it. The series cannot advance until it completes.`,
    input.containerRunning
      ? `A container IS running for session \`${input.sessionId}\` and holds no claim — it is not selecting this row.`
      : `No container is running for session \`${input.sessionId}\` — the wake is not landing (spawn refused, queue full, provider parked).`,
    '',
    `Start with \`logs/nanoclaw.error.log\` for that session. This alert fires once per occurrence.`,
  ].join('\n');
}

export async function escalateOverdueOccurrences(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerRunning: boolean,
  nowMs = Date.now(),
  hostUptimeMs = process.uptime() * 1000,
): Promise<void> {
  const cutoffMs = overdueCutoffMs(nowMs, hostUptimeMs);
  if (cutoffMs === null) return;

  const overdue = mailbox.listOverdueRecurringRows(new Date(cutoffMs).toISOString());
  const seen = alerted.get(session.id);
  if (overdue.length === 0) {
    if (seen) alerted.delete(session.id);
    return;
  }

  for (const row of overdue) {
    if (seen?.has(row.id)) continue;
    if (nowMs - lastAlertAtMs < TASK_OVERDUE_ALERT_MIN_GAP_MS) return;

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
    });

    // Stamped only on a delivery that reached someone — same rule, and same
    // reason, as task-failure-escalation (src/modules/sweep-task-escalation/index.ts:152-155).
    lastAlertAtMs = nowMs;
    const context = { source: 'task-overdue', seriesId, occurrenceId: row.id, sessionId: session.id };
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
