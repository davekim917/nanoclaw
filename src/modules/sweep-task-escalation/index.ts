/**
 * T24 `task-failure-escalation` — a recurring task that keeps failing reaches a
 * human instead of dying silently.
 *
 * The incident (2026-09-07, migration 075): a group migrated codex → claude at
 * 03:37Z kept four scheduled tasks pinned to `gpt-6-astra`. A task's model pin
 * is validated at CREATE time against the then-current provider and never
 * re-validated at fire time, so every later fire handed a codex model to Claude
 * and the turn errored. `pr-watch-a1b2` (cron `15,45 * * * *`) failed 21
 * consecutive times over ~14 hours. Nobody was told.
 *
 * The gap this closes is not "nothing was recorded" — it is that everything
 * recorded said SUCCESS. Each failing fire was marked `completed` (the agent
 * DID reply; its reply was the provider's error string), so the existing
 * `trailingFailedRuns` streak in `recurrence.ts` read 0 for all 21 fires and
 * neither its backoff nor its `SCRIPT_FAIL_PAUSE_CAP` pause could engage.
 *
 * So the streak here is counted over `task_run_outcomes`, which carries the
 * PROVIDER's own `isError` verdict rather than the occurrence row's status.
 * Both streaks are kept: `recurrence.ts` still throttles a broken pre-task
 * script off the occurrence rows, and this duty escalates an erroring agent
 * turn off the outcome ledger. They answer different questions and neither
 * subsumes the other.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import {
  listSeriesWithFailures,
  markEscalated,
  pruneTaskRunOutcomes,
  readFailureStreak,
  type TaskRunOutcomeRow,
} from '../../db/task-run-outcomes.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { SWEEP_DUTY_INVENTORY, registerSweepDuty, registerSweepDutySource } from '../../host-sweep.js';
import { log } from '../../log.js';
import { notifyOperators } from '../../operator-alert.js';
import { formatLocalTime } from '../../timezone.js';

/**
 * Consecutive failed runs before a human is told.
 *
 * THREE. The existing `SCRIPT_FAIL_PAUSE_CAP` of 8 is deliberately NOT reused:
 * it belongs to `recurrence.ts`'s streak over occurrence STATUS, which cannot
 * see an agent-turn failure at all (migration 075's three blockers), so its
 * number was never calibrated against this signal. Borrowing it would import a
 * threshold from a mechanism that has never observed the thing being counted.
 *
 * The arithmetic, on the incident's own `15,45 * * * *` cadence. Nothing
 * throttles these fires — the backoff in `recurrence.ts` keys off
 * `trailingFailedRuns`, which stays 0 here — so they stay on the raw 30-minute
 * grid and the third consecutive failure lands ~60 minutes in, plus at most one
 * 60s sweep tick. The real episode ran 14 hours across 21 fires; this ends it
 * at fire 3.
 *
 * (For contrast, had that backoff applied, 8 strikes would land at ~4h45m:
 * `min(2·2^(n-1), 60)` minutes of backoff pushes fires past the cron grid from
 * the fifth failure onward — 0, 30, 60, 90, 120, 165, 225, 285.)
 *
 * Why not lower: one failed fire is noise — a 429, a network blip, one
 * overloaded upstream. Two adjacent fires can still be a single provider
 * incident. Three consecutive with no success between them is a property of the
 * task, not of the minutes it ran in.
 *
 * The cost of being wrong is asymmetric and points this way: a false positive
 * is one DM; a false negative is the 14 hours that motivated this duty.
 *
 * KNOWN LIMIT, stated rather than papered over: on a DAILY series, three
 * consecutive failures is three days. A count alone cannot be right for both a
 * 30-minute and a 24-hour cadence. The natural follow-up is to escalate on
 * whichever comes first — N consecutive, or a streak older than a few hours —
 * but that is a second threshold, and one number that is right for the observed
 * incident beats two that are argued from no evidence.
 */
export const TASK_FAILURE_ESCALATION_THRESHOLD = 3;

/**
 * The decision, separated from every I/O the duty does so the threshold and the
 * anti-spam rule are testable without a database, an adapter or a clock.
 *
 * There is no "re-arm" action to take. An episode is open when the CURRENT
 * trailing-failure streak already carries an `escalated_at` stamp; a successful
 * run ends that streak, so the next one starts unstamped and the next run of N
 * alerts again. Recovery needs no write, and no marker can drift out of step
 * with the outcomes it summarizes.
 *
 * Re-arm is deliberately driven by an observed success rather than by an
 * operator acknowledgement: an acknowledgement that never comes would pin the
 * episode open forever, and a series that started working again could never
 * report breaking a second time.
 */
export function shouldEscalateTaskFailures(
  streak: number,
  alreadyEscalated: boolean,
  threshold = TASK_FAILURE_ESCALATION_THRESHOLD,
): boolean {
  return streak >= threshold && !alreadyEscalated;
}

/**
 * The alert body. "Task failed" costs a human an investigation; this is meant
 * to be a fix in one read, so it names the series, the group, the pin, what the
 * group's provider is NOW (the pin/provider mismatch IS the bug in the
 * motivating incident), the error, the count and the window.
 */
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

  // The episode is stamped only on a delivery that actually reached someone.
  // Stamping on a failed send is the false receipt that made the health
  // sentinel go quiet for three days (#538) — an unreachable operator must
  // leave the alert armed so the next tick tries again, not mark it spoken for.
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

export async function runTaskFailureEscalation(): Promise<void> {
  for (const { agent_group_id: agentGroupId, series_id: seriesId } of await listSeriesWithFailures()) {
    try {
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

export function registerTaskEscalationSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.T24,
    phase: 'tick:housekeeping',
    order: 135,
    // Wholly defensive: this duty is an OBSERVER. Nothing downstream depends on
    // it, and a tick that dies here would take the duties that actually keep
    // sessions alive down with it. A central DB that cannot be read (a
    // pre-migration boot, a fixture without the table) logs and yields the tick.
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
