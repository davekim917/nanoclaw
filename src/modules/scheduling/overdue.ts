/**
 * Aged-occurrence alarm: a recurring occurrence that is due, wake-eligible and
 * untouched for an hour reaches a human. Every per-session sweep guard declines
 * correctly for its own case, so a due row the runner never selects can satisfy
 * all of them forever with nothing logged above INFO. This asks of the OUTCOME
 * ("due work nobody picked up for an hour"), so it holds for unknown causes. An
 * observer only: it completes, kills and re-arms nothing. It also reports a
 * pre-task result that has not reached the failure-escalation ledger for an
 * hour (`listStuckGateResults`), which counts only runs that happened.
 */
import { resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { taskSeriesId } from '../../db/sessions.js';
import { log } from '../../log.js';
import { notifyOperators } from '../../operator-alert.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import type { NanoclawMailboxSession } from '../mailbox/index.js';
import type { StuckGateResults } from '../mailbox/ops/sweep.js';
import { parseSqliteUtc, sqliteUtcToIso } from '../mailbox/sqlite-utc.js';

/**
 * How long a due occurrence may sit before a human is told, from its
 * `process_after` alone. A flat hour, not a cadence multiple: acknowledged
 * occurrences are excluded, so this times "due work nobody picked up", which has
 * no reason to last longer on a daily series. Far past any retry backoff.
 */
const TASK_OVERDUE_ALERT_MS = 60 * 60 * 1000;

/**
 * Floor between two alert ATTEMPTS, delivered or not, so a fleet-wide cause
 * yields one DM per window instead of a burst. It advances on a FAILED attempt
 * too: each can cost up to the operator-alert deadline, and the recipients were
 * just shown unreachable. Whether an occurrence still owes an alert is the
 * `alerted` set's business.
 */
export const TASK_OVERDUE_ATTEMPT_MIN_GAP_MS = 5 * 60 * 1000;

// One DELIVERED alert per stuck item per host process (occurrence id,
// `withheld:<id>`, `gate-row:<outbound id>`). In memory on purpose: repeats are
// bounded by restarts, and a restart loop cannot hide a stuck row. The ids are
// never reused, so an entry can only be stale, never wrong.
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

function formatWithheldAlert(input: {
  seriesId: string;
  occurrenceId: string;
  groupName: string;
  dueAt: string;
  overdueMinutes: number;
}): string {
  return [
    `*Scheduled check result not recorded:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `Occurrence \`${input.occurrenceId}\` has been due since ${input.dueAt} (${input.overdueMinutes} min) and its host-run ` +
      'script has no recorded result, so it is held back: it neither wakes the agent nor completes, and the series ' +
      'cannot advance. The script runs again every sweep tick until a result is recorded.',
    '',
    `Start with \`logs/nanoclaw.error.log\` ("Host-gated result could not be recorded"). This alert fires once per occurrence per host process.`,
  ].join('\n');
}

function formatUndeliveredGateAlert(input: {
  seriesId: string;
  occurrenceId: string | null;
  groupName: string;
  sessionId: string;
  writtenAt: string;
  waitingMinutes: number;
}): string {
  const occurrence = input.occurrenceId === null ? 'an occurrence' : `occurrence \`${input.occurrenceId}\``;
  return [
    `*Scheduled check result not recorded:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `The pre-task script result for ${occurrence}, written at ${input.writtenAt} (${input.waitingMinutes} min ago), ` +
      `has not been recorded. Delivery retries it every poll and never gives it up, so every later message from ` +
      `session \`${input.sessionId}\` is held behind it.`,
    '',
    `Start with \`logs/nanoclaw.error.log\` ("Gate result not recorded"). This alert fires once per result per host process.`,
  ].join('\n');
}

interface PendingAlert {
  key: string;
  source: string;
  seriesId: string;
  occurrenceId: string | null;
  sentLog: string;
  unsentLog: string;
  render(groupName: string, tz: string): string;
}

function pendingAlerts(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerRunning: boolean,
  nowMs: number,
): PendingAlert[] {
  const cutoffIso = new Date(nowMs - TASK_OVERDUE_ALERT_MS).toISOString();
  const minutesSince = (stamp: string): number => Math.floor((nowMs - parseSqliteUtc(stamp)) / 60_000);
  const { rows: overdue, queuedBehindActiveWork } = mailbox.listOverdueRecurringRows(cutoffIso);
  let stuck: StuckGateResults = { undeliveredGateRows: [], withheldHostGatedRows: [] };
  try {
    stuck = mailbox.listStuckGateResults(cutoffIso);
  } catch (err) {
    log.warn('Stuck gate-result check failed — unclaimed occurrences are still checked', {
      sessionId: session.id,
      err,
    });
  }
  const { undeliveredGateRows, withheldHostGatedRows } = stuck;

  const unclaimed = overdue.map((row): PendingAlert => {
    const seriesId = row.seriesId ?? row.id;
    return {
      key: row.id,
      source: 'task-overdue',
      seriesId,
      occurrenceId: row.id,
      sentLog: 'Escalated a due scheduled occurrence nothing is running',
      unsentLog: 'Due scheduled occurrence nothing is running could NOT be escalated — nobody was told',
      render: (groupName, tz) =>
        formatOverdueAlert({
          seriesId,
          occurrenceId: row.id,
          groupName,
          sessionId: session.id,
          dueAt: formatLocalTime(sqliteUtcToIso(row.processAfter), tz),
          overdueMinutes: minutesSince(row.processAfter),
          containerRunning,
          queuedBehindActiveWork,
        }),
    };
  });
  const withheld = withheldHostGatedRows.map((row): PendingAlert => {
    const seriesId = row.seriesId ?? row.id;
    return {
      key: `withheld:${row.id}`,
      source: 'task-gate-withheld',
      seriesId,
      occurrenceId: row.id,
      sentLog: 'Escalated a host-gated occurrence withheld without a recorded result',
      unsentLog: 'Withheld host-gated occurrence could NOT be escalated — nobody was told',
      render: (groupName, tz) =>
        formatWithheldAlert({
          seriesId,
          occurrenceId: row.id,
          groupName,
          dueAt: formatLocalTime(sqliteUtcToIso(row.processAfter), tz),
          overdueMinutes: minutesSince(row.processAfter),
        }),
    };
  });
  const unrecorded = undeliveredGateRows.map((row): PendingAlert => {
    const seriesId = row.seriesId ?? taskSeriesId(session.thread_id) ?? row.occurrenceId ?? row.id;
    return {
      key: `gate-row:${row.id}`,
      source: 'task-gate-unrecorded',
      seriesId,
      occurrenceId: row.occurrenceId,
      sentLog: 'Escalated a pre-task result delivery has not recorded',
      unsentLog: 'Unrecorded pre-task result could NOT be escalated — nobody was told',
      render: (groupName, tz) =>
        formatUndeliveredGateAlert({
          seriesId,
          occurrenceId: row.occurrenceId,
          groupName,
          sessionId: session.id,
          writtenAt: formatLocalTime(sqliteUtcToIso(row.writtenAt), tz),
          waitingMinutes: minutesSince(row.writtenAt),
        }),
    };
  });
  return [...unclaimed, ...withheld, ...unrecorded];
}

export async function escalateOverdueOccurrences(
  mailbox: NanoclawMailboxSession,
  session: Session,
  containerRunning: boolean,
  nowMs = Date.now(),
): Promise<void> {
  const pending = pendingAlerts(mailbox, session, containerRunning, nowMs);
  const seen = alerted.get(session.id);
  if (pending.length === 0) {
    if (seen) alerted.delete(session.id);
    return;
  }

  for (const alert of pending) {
    if (seen?.has(alert.key)) continue;
    if (nowMs - lastAttemptAtMs < TASK_OVERDUE_ATTEMPT_MIN_GAP_MS) return;

    const group = await getAgentGroup(session.agent_group_id);
    const tz = await resolveGroupTimezone(session.agent_group_id);
    const text = alert.render(group?.name ?? session.agent_group_id, tz);

    lastAttemptAtMs = nowMs;
    const context = {
      source: alert.source,
      seriesId: alert.seriesId,
      occurrenceId: alert.occurrenceId,
      sessionId: session.id,
    };
    // Stamped only on a delivery that reached someone; a failed attempt leaves it owing.
    if (await notifyOperators(text, context)) {
      const stamped = alerted.get(session.id) ?? new Set<string>();
      stamped.add(alert.key);
      alerted.set(session.id, stamped);
      log.warn(alert.sentLog, context);
    } else {
      log.warn(alert.unsentLog, { ...context, text });
    }
  }
}
