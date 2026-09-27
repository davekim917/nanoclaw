/**
 * Escalates a recurring task that keeps failing to a human. The streak is
 * counted over `task_run_outcomes` (the provider's own `isError`), not the
 * occurrence status: a failing agent turn is still marked `completed` because
 * the agent did reply, so recurrence.ts's streak never sees it. The gate lane
 * escalates by deadline instead of count, evaluated every tick.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import {
  listSeriesWithFailures,
  markEscalated,
  pruneTaskRunOutcomes,
  readFailureStreak,
  readGateEpisode,
  type GateEpisode,
  type TaskRunOutcomeRow,
} from '../../db/task-run-outcomes.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { SWEEP_DUTY_INVENTORY, registerSweepDuty, registerSweepDutySource } from '../../host-sweep.js';
import { log } from '../../log.js';
import { notifyOperators } from '../../operator-alert.js';
import { formatLocalTime } from '../../timezone.js';
import { FALLBACK_BOUND_MS } from '../scheduling/observation.js';

/**
 * Consecutive failed runs before a human is told. Not `SCRIPT_FAIL_PAUSE_CAP`:
 * that counts occurrence status, which cannot see an agent-turn failure.
 * Known limit: on a daily series three failures is three days.
 */
export const TASK_FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * An episode is open while the current trailing-failure streak carries an
 * `escalated_at` stamp; a success ends the streak, so re-arm needs no write.
 * Re-arm is driven by success, not operator ack, so a missing ack can't pin it open.
 */
export function shouldEscalateTaskFailures(
  streak: number,
  alreadyEscalated: boolean,
  threshold = TASK_FAILURE_ESCALATION_THRESHOLD,
): boolean {
  return streak >= threshold && !alreadyEscalated;
}

/** Names what the group's provider is NOW: a stale pin/provider mismatch is the usual cause. */
export function formatTaskFailureAlert(input: {
  seriesId: string;
  groupName: string;
  streak: number;
  firstFailureAt: string;
  lastFailureAt: string;
  model: string | null;
  provider: string;
  detail: string | null;
}): string {
  const pin = input.model
    ? `Model that ran: \`${input.model}\` · group provider is now \`${input.provider}\`.`
    : `No per-task model pin recorded · group provider is \`${input.provider}\`.`;
  return [
    `*Scheduled task failing:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `${input.streak} consecutive failed runs, ${input.firstFailureAt} → ${input.lastFailureAt}.`,
    pin,
    `Error: ${input.detail ?? '(no text returned)'}`,
    '',
    `It is still firing on schedule and still failing. Check the pin against the group's provider ` +
      `(\`ncl groups config get --id <group>\`), then re-pin or clear it with \`ncl tasks update --id ${input.seriesId}\`. ` +
      `This alert re-arms on the next successful run.`,
  ].join('\n');
}

async function escalateSeries(
  agentGroupId: string,
  seriesId: string,
  streak: number,
  firstFailureAt: string,
  newest: TaskRunOutcomeRow,
) {
  const group = await getAgentGroup(agentGroupId);
  const provider = resolveProviderName(null, (await getContainerConfig(agentGroupId))?.provider);
  const tz = await resolveGroupTimezone(agentGroupId);
  const text = formatTaskFailureAlert({
    seriesId,
    groupName: group?.name ?? agentGroupId,
    streak,
    firstFailureAt: formatLocalTime(firstFailureAt, tz),
    lastFailureAt: formatLocalTime(newest.recorded_at, tz),
    model: newest.model,
    provider,
    detail: newest.detail,
  });

  // Stamp only on a delivery that reached someone: an unreachable operator
  // must leave the alert armed for the next tick.
  if (await notifyOperators(text, { source: 'task-failure-escalation', seriesId, agentGroupId })) {
    await markEscalated(newest.id);
    log.warn('Escalated a repeatedly failing scheduled task', { seriesId, agentGroupId, streak });
  } else {
    log.warn('Repeatedly failing scheduled task could NOT be escalated — nobody was told', {
      seriesId,
      agentGroupId,
      streak,
      text,
    });
  }
}

/**
 * Earliest start plus smallest bound, both minima over the episode, so a
 * later row can pull the deadline in but never push it out.
 */
export function gateEpisodeDeadlineMs(episode: Pick<GateEpisode, 'firstRecordedAt' | 'earliestSince' | 'boundMs'>): {
  startMs: number;
  deadlineMs: number;
} {
  const recordedMs = Date.parse(episode.firstRecordedAt);
  const sinceMs = episode.earliestSince === null ? Number.NaN : Date.parse(episode.earliestSince);
  const startMs = Number.isFinite(sinceMs) ? Math.min(recordedMs, sinceMs) : recordedMs;
  return { startMs, deadlineMs: startMs + (episode.boundMs ?? FALLBACK_BOUND_MS) };
}

/** `7_200_000` → `2h`; the largest unit that divides the bound exactly. */
function formatBound(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function formatGateEscalationAlert(input: {
  seriesId: string;
  groupName: string;
  start: string;
  boundMs: number;
  rows: number;
  observation: string | null;
  observedAt: string;
  detail: string | null;
}): string {
  return [
    `*Scheduled check overdue:* \`${input.seriesId}\` (group \`${input.groupName}\`)`,
    `Not ok since ${input.start}, past its ${formatBound(input.boundMs)} bound (${input.rows} consecutive non-ok result${input.rows === 1 ? '' : 's'}).`,
    `Latest: \`${input.observation ?? 'unknown'}\` at ${input.observedAt}: ${input.detail ?? '(no evidence recorded)'}`,
    '',
    `This alert re-arms after the next \`empty\` result or wake.`,
  ].join('\n');
}

async function escalateGateEpisode(agentGroupId: string, seriesId: string, nowMs: number): Promise<void> {
  const episode = await readGateEpisode(agentGroupId, seriesId);
  if (!episode || episode.escalated) return;
  const { startMs, deadlineMs } = gateEpisodeDeadlineMs(episode);
  if (nowMs < deadlineMs) return;

  const group = await getAgentGroup(agentGroupId);
  const tz = await resolveGroupTimezone(agentGroupId);
  const text = formatGateEscalationAlert({
    seriesId,
    groupName: group?.name ?? agentGroupId,
    start: formatLocalTime(new Date(startMs).toISOString(), tz),
    boundMs: episode.boundMs ?? FALLBACK_BOUND_MS,
    rows: episode.rows,
    observation: episode.newest.observation,
    observedAt: formatLocalTime(episode.newest.recorded_at, tz),
    detail: episode.newest.detail,
  });
  if (await notifyOperators(text, { source: 'task-gate-escalation', seriesId, agentGroupId })) {
    await markEscalated(episode.newest.id);
    log.warn('Escalated an overdue scheduled check', { seriesId, agentGroupId, rows: episode.rows });
  } else {
    log.warn('Overdue scheduled check could NOT be escalated — nobody was told', { seriesId, agentGroupId, text });
  }
}

export async function runTaskFailureEscalation(nowMs: number = Date.now()): Promise<void> {
  for (const { agent_group_id: agentGroupId, series_id: seriesId, source } of await listSeriesWithFailures()) {
    try {
      if (source === 'gate') {
        await escalateGateEpisode(agentGroupId, seriesId, nowMs);
        continue;
      }
      const { streak, escalated, firstFailureAt, newest } = await readFailureStreak(agentGroupId, seriesId);
      if (newest && firstFailureAt && shouldEscalateTaskFailures(streak, escalated)) {
        await escalateSeries(agentGroupId, seriesId, streak, firstFailureAt, newest);
      }
    } catch (err) {
      // Per series: one unreadable group must not stop the rest from escalating.
      log.warn('Task failure escalation check failed', { seriesId, agentGroupId, err });
    }
  }
}

function registerTaskEscalationSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T24,
    phase: 'tick:housekeeping',
    order: 135,
    // An observer: a throw here must not take down the duties that keep
    // sessions alive.
    run: async () => {
      try {
        await runTaskFailureEscalation();
      } catch (err) {
        log.warn('Task failure escalation sweep failed', { err });
      }
      try {
        const pruned = await pruneTaskRunOutcomes();
        if (pruned > 0) log.debug('Pruned expired task run outcomes', { pruned });
      } catch (err) {
        log.warn('Task run outcome prune failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-task-escalation', registerTaskEscalationSweepDuties);
