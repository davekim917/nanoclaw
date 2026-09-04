import { randomUUID } from 'crypto';
import { withQuietInvalidation } from '../../db/sessions.js';

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../../config.js';
import { resolveTaskSession, withExistingMailboxSession } from '../../session-manager.js';
import { parseZonedToUtc } from '../../timezone.js';

export const MAX_DAILY_FIRES = 4;

const RECURRENCE_LIMIT_WARNING =
  'Warning: this task has not been scheduled. Frequent running tasks consume the ' +
  "user's subscription quota or unnecessarily use tokens and can cause the user's " +
  'account to be banned. Instead, use a pre-task run script that you write that can ' +
  'check some kind of external condition, usually via one or more API calls. The ' +
  'script returns a decision programmatically whether the task needs to be run now ' +
  'or not. For example, an API call to GitHub to check if there are open PRs, and ' +
  'only run when there are new open PRs.\n' +
  'Run `ncl tasks create --help` to get full directions on how to write a script and test it.\n\n' +
  'Note: if and only if you explicitly need to schedule a task more frequently and ' +
  "you've verified with the user that they understand and that this is what they " +
  'want and based on your judgment you agree that this is the right thing to do in ' +
  'this situation, you can override this with --dangerously-override-recurrence-limit';

export interface PreparedScheduledTask {
  name?: string;
  prompt: string;
  recurrence: string | null;
  script: string | null;
  processAfter: string;
  muteChat?: boolean;
}

export interface ScheduledTaskRow {
  row_id: string;
  series_id: string | null;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  timestamp: string;
  tries: number;
  seq: number;
}

/**
 * Short, readable, filesystem/thread-safe task id. With a name → `<slug>-<4hex>`;
 * without one → `t-<6hex>`. Always matches /^[a-z0-9-]+$/ so it is safe as a
 * thread suffix, filename, and copy-pasteable CLI argument.
 */
export function makeTaskId(name: unknown): string {
  const hex = (n: number): string => randomUUID().replace(/-/g, '').slice(0, n);
  const slug =
    typeof name === 'string'
      ? name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24)
          .replace(/-+$/g, '')
      : '';
  return slug ? `${slug}-${hex(4)}` : `t-${hex(6)}`;
}

export function parseProcessAfter(value: unknown, tz: string = TIMEZONE): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('--process-after is required');
  const date = parseZonedToUtc(value, tz);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --process-after: ${value}`);
  return date.toISOString();
}

export function validateRecurrence(value: string | null | undefined, tz: string = TIMEZONE): void {
  if (!value) return;
  try {
    CronExpressionParser.parse(value, { tz });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid --recurrence: ${msg}`, { cause: err });
  }
}

export function enforceRecurrenceLimit(
  recurrence: string | null,
  override: boolean,
  hasScript: boolean,
  tz: string = TIMEZONE,
): void {
  // A gate script is the sanctioned mitigation: a skipped fire costs no agent
  // tokens, so scripted tasks may poll faster without the explicit override.
  if (!recurrence || override || hasScript) return;
  const horizon = Date.now() + 24 * 60 * 60 * 1000;
  const interval = CronExpressionParser.parse(recurrence, { tz });
  let fires = 0;
  while (fires <= MAX_DAILY_FIRES) {
    const next = interval.next();
    if (next.getTime() > horizon) break;
    fires++;
  }
  if (fires > MAX_DAILY_FIRES) throw new Error(RECURRENCE_LIMIT_WARNING);
}

/**
 * Validate task semantics and derive its first run without writing anything.
 * `timezone` grounds wall-clock interpretation (cron grid, naive
 * --process-after) — pass the owning group's effective timezone
 * (`resolveGroupTimezone`); it defaults to the install-global one.
 */
export function prepareScheduledTask(input: {
  name?: string;
  prompt: string;
  recurrence?: string | null;
  processAfter?: string;
  script?: string | null;
  muteChat?: boolean;
  dangerouslyOverrideRecurrenceLimit?: boolean;
  timezone?: string;
}): PreparedScheduledTask {
  if (!input.prompt) throw new Error('--prompt is required');
  const recurrence = input.recurrence ?? null;
  const script = input.script ?? null;
  const tz = input.timezone ?? TIMEZONE;
  validateRecurrence(recurrence, tz);
  enforceRecurrenceLimit(recurrence, input.dangerouslyOverrideRecurrenceLimit === true, script !== null, tz);

  let processAfter: string;
  if (input.processAfter === undefined && recurrence) {
    const next = CronExpressionParser.parse(recurrence, { tz }).next().toISOString();
    if (!next) throw new Error(`--recurrence has no upcoming run: ${recurrence}`);
    processAfter = next;
  } else {
    processAfter = parseProcessAfter(input.processAfter, tz);
  }

  return {
    name: input.name,
    prompt: input.prompt,
    recurrence,
    script,
    processAfter,
    muteChat: input.muteChat === true,
  };
}

/**
 * Persist a prepared task through NanoClaw's single task/session representation.
 *
 * Asynchronous since mailbox seam PR 7: the write goes through the seam, whose
 * `session()` is a promise. `resolveTaskSession` above provisions the mailbox,
 * so this uses the existing-only funnel and treats `undefined` as the same
 * hard error the pre-seam existsSync guard raised (invariant I-10 — a task
 * writer must not be what resurrects a reclaimed session directory).
 */
export async function createScheduledTask(
  agentGroupId: string,
  task: PreparedScheduledTask,
  options?: { status?: 'pending' | 'paused'; originSessionId?: string | null },
): Promise<{ session: { id: string; agent_group_id: string }; row: ScheduledTaskRow }> {
  const id = makeTaskId(task.name);
  const { session } = resolveTaskSession(agentGroupId, id);

  // Bracketed by `withQuietInvalidation`: the insert changes when this session
  // next has work due, and due-ness lives only in the session DB where the host
  // sweep's quiet cache cannot see it. Fail-closed before the write (a refused
  // central-DB invalidation aborts the create rather than landing a row behind a
  // mark nothing clears), re-invalidated after it — the mailbox funnel is
  // awaited, so a sweep tick can flush a mark inside that window.
  const row = await withQuietInvalidation(session.id, () =>
    withExistingMailboxSession(agentGroupId, session.id, (mailbox) => {
      mailbox.insertTaskRow({
        id,
        seriesId: id,
        processAfter: task.processAfter,
        recurrence: task.recurrence,
        content: JSON.stringify({
          prompt: task.prompt,
          script: task.script,
          originSessionId: options?.originSessionId ?? null,
          // Physical send suppression: the agent-runner drops chat-kind
          // outbound writes for tasks carrying muteChat (watcher-style tasks
          // whose contract is board/file output, never channel posts).
          ...(task.muteChat ? { muteChat: true } : {}),
        }),
        status: options?.status ?? 'pending',
      });
      return mailbox.getCreatedTaskRow(id) as ScheduledTaskRow;
    }),
  );
  if (!row) throw new Error('task system session inbound.db not found');

  return { session: { id: session.id, agent_group_id: session.agent_group_id }, row };
}
