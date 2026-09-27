import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, REPO_ROOT, TIMEZONE } from '../../config.js';
import { resolveGroupProvider, resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  findTaskSessions,
  getActiveSessions,
  getSession,
  taskSeriesId,
  withQuietInvalidationSync,
  setTaskRoutingPlatformId,
} from '../../db/sessions.js';
import { withCentralSync } from '../../db/central-lease.js';
import { type TaskUpdate } from '../../modules/scheduling/db.js';
import type { CliTaskRow, NanoclawMailboxSession } from '../../modules/mailbox/index.js';
import { dispatchSeriesId, validateDispatchKey } from '../../modules/mailbox/index.js';
import {
  enforceRecurrenceLimit,
  makeTaskId,
  MAX_DAILY_FIRES,
  parseProcessAfter,
  validateRecurrence,
} from '../../modules/scheduling/create.js';
import { resolveTaskFlagIntent, validateTaskPin } from '../../modules/scheduling/task-flags.js';
import { parseTaskContent, parseTaskPin } from '../../modules/scheduling/task-content.js';
import { taskFiresFresh } from '../../modules/scheduling/fresh-context.js';
import { writeAudit } from '../../dashboard/api/scheduled-shared.js';
import { moveTaskAsHost } from '../../dashboard/api/scheduled-move.js';
import { resolveTaskSession, withExistingMailboxSession } from '../../session-manager.js';
import { resolveEffectiveModel, vocabFor } from '../../flag-parser.js';
import { log } from '../../log.js';
import { registerResource } from '../crud.js';
import { appendRunLog } from '../../modules/scheduling/run-log.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';

type TaskStatus = 'pending' | 'paused';

type TaskRow = CliTaskRow;

/** All-null means unaddressed output is discarded. */
interface TaskRouting {
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

const NO_ROUTING: TaskRouting = { platformId: null, channelType: null, threadId: null };

interface ScopedSession {
  id: string;
  agent_group_id: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a flag the caller SUPPLIED, refusing an unusable value. `str()` collapses "absent" and "supplied empty" into
 * `undefined`, so a presence guard built on it fails OPEN on `--session "$UNSET"` (which arrives as `''`). No guarded
 * flag has a meaningful empty value.
 */
function suppliedFlag(args: Record<string, unknown>, key: string, cliName: string): string | undefined {
  if (args[key] === undefined) return undefined;
  const value = str(args[key]);
  if (value === undefined) {
    throw new Error(`${cliName} was supplied without a usable value: give it one, or omit ${cliName} entirely`);
  }
  return value;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/**
 * The best identity CallerContext carries: neither transport threads a human user id through, so it is "host" or
 * "agent:<group>", never invented.
 */
function actorFor(ctx: CallerContext): string {
  return ctx.caller === 'agent' ? `agent:${ctx.agentGroupId}` : 'host';
}

function firstRunIso(value: unknown, recurrence: string | null, tz: string = TIMEZONE): string {
  if (str(value) === undefined && recurrence) {
    const next = CronExpressionParser.parse(recurrence, { tz }).next().toISOString();
    if (!next) throw new Error('recurrence did not produce a next run');
    return next;
  }
  return parseProcessAfter(value, tz);
}

function normalizeNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return String(value);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'none') return null;
  return value;
}

function statusFilter(args: Record<string, unknown>): TaskStatus | undefined {
  const status = str(args.status);
  if (!status) return undefined;
  if (status !== 'pending' && status !== 'paused') {
    throw new Error('--status must be pending or paused');
  }
  return status;
}

function groupArg(args: Record<string, unknown>, ctx: CallerContext): string | undefined {
  if (ctx.caller === 'agent') return ctx.agentGroupId;
  return suppliedFlag(args, 'group', '--group') ?? suppliedFlag(args, 'agent_group_id', '--agent-group-id');
}

async function ownSession(sessionId: string, ctx: CallerContext): Promise<ScopedSession> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId) {
    throw new Error(`session not found: ${sessionId}`);
  }
  return { id: session.id, agent_group_id: session.agent_group_id };
}

/**
 * The one place every `ncl tasks` verb resolves targets. A `--session` outside `--group` means the two disagree, and
 * answering with the session's real group would run the verb (destructively, or as a read leak) against a group the
 * operator did not name, so it is refused. Agent callers never reach this: `groupArg` pins them to their own group,
 * and `ownSession` answers "not found" without confirming the id exists elsewhere.
 */
async function selectedSessions(args: Record<string, unknown>, ctx: CallerContext): Promise<ScopedSession[]> {
  const sessionId = suppliedFlag(args, 'session', '--session');
  const group = groupArg(args, ctx);
  if (sessionId) {
    const session = await ownSession(sessionId, ctx);
    if (group && session.agent_group_id !== group) {
      throw new Error(
        `session ${sessionId} belongs to agent group ${session.agent_group_id}, not ${group}: ` +
          'pass --session on its own to target that session, or --group on its own to target this group',
      );
    }
    return [session];
  }

  if (group) {
    // One session per live task series — the loops below already fan out across them.
    return (await findTaskSessions(group)).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id }));
  }

  if (ctx.caller === 'agent') return [];
  return (await getActiveSessions()).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id }));
}

/** Existing-only: listing or mutating must never create a mailbox. `undefined` means this session has none. */
function withInbound<T>(session: ScopedSession, fn: (mailbox: NanoclawMailboxSession) => T): Promise<T | undefined> {
  return withExistingMailboxSession(session.agent_group_id, session.id, fn);
}

/**
 * Quiet-mark invalidation: PROBE FIRST, then invalidate. Every mutating verb writes due-ness straight into a session
 * DB the sweep's quiet cache cannot see, so each write runs inside `withQuietInvalidationSync` (one fail-closed
 * invalidation, then the statement, same synchronous turn).
 * The call sits INSIDE the mailbox action, after its own read, not around `withInbound`: verbs fan out across
 * sessions and usually one holds the series, so wrapping the open would cost N invalidations and put an await between
 * invalidation and write. `getCliTaskRow(id)` is the probe for per-series verbs and a strict SUPERSET of what they
 * can touch (every verb adds a status filter to the same predicate), so a miss proves the write matches nothing.
 * Cancel-all probes with `listCliTaskSeries()`, exactly the set it updates. Reads never invalidate.
 */

function toOutput(session: ScopedSession, row: TaskRow) {
  const content = parseTaskContent(row.content);
  const pin = parseTaskPin(row.content);
  return {
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    series_id: row.series_id ?? row.row_id,
    row_id: row.row_id,
    status: row.status,
    process_after: row.process_after,
    recurrence: row.recurrence,
    prompt: content.prompt.length > 120 ? content.prompt.slice(0, 117) + '...' : content.prompt,
    has_script: content.script ? 1 : 0,
    script_host: content.scriptHost ? 1 : 0,
    thread_anchor: content.threadAnchor ? 1 : 0,
    context: taskFiresFresh(row.content) ? 'fresh' : 'continuous',
    origin_session_id: content.originSessionId, // which session created the task (null for CLI-created)
    // The per-fire pin exactly as stored.
    model_pin: pin.model,
    effort_pin: pin.effort,
    created_at: row.timestamp,
    tries: row.tries,
    // Null means discarded (isolated).
    routed: row.platform_id
      ? { channel_type: row.channel_type, platform_id: row.platform_id, thread_id: row.thread_id }
      : null,
  };
}

function taskId(args: Record<string, unknown>): string {
  const id = str(args.id);
  if (!id) throw new Error('task series id is required');
  return id;
}

/**
 * Agent callers derive routing from their OWN session, never agent-supplied ids: default stamps the session's
 * channel, `--thread` also its thread (falling back to channel-only with a note), `--isolated` or no messaging group
 * stamps nothing. `--messaging-group`/`--thread-id` are host-only raw stamps, rejected from agents. Host callers get
 * no implicit stamp.
 */
async function resolveTaskRouting(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ routing: TaskRouting; note?: string }> {
  const messagingGroupArg = str(args.messaging_group);
  const threadIdArg = str(args.thread_id);

  if (ctx.caller === 'agent') {
    if (messagingGroupArg !== undefined || threadIdArg !== undefined) {
      throw new Error('--messaging-group / --thread-id are host-only; an agent cannot set raw routing');
    }
    if (bool(args.isolated)) return { routing: NO_ROUTING };

    const callingSession = await getSession(ctx.sessionId);
    if (!callingSession?.messaging_group_id) return { routing: NO_ROUTING };

    const mg = await getMessagingGroup(callingSession.messaging_group_id);
    if (!mg) throw new Error(`routing failed: messaging group not found for session ${ctx.sessionId}`);

    if (bool(args.thread)) {
      if (callingSession.thread_id) {
        return {
          routing: { platformId: mg.platform_id, channelType: mg.channel_type, threadId: callingSession.thread_id },
        };
      }
      return {
        routing: { platformId: mg.platform_id, channelType: mg.channel_type, threadId: null },
        note: '--thread requested from a non-thread session — stamped channel routing instead',
      };
    }
    return { routing: { platformId: mg.platform_id, channelType: mg.channel_type, threadId: null } };
  }

  if (threadIdArg !== undefined && messagingGroupArg === undefined) {
    throw new Error('--thread-id requires --messaging-group');
  }
  if (messagingGroupArg === undefined) return { routing: NO_ROUTING };
  const mg = await getMessagingGroup(messagingGroupArg);
  if (!mg) throw new Error(`messaging group not found: ${messagingGroupArg}`);
  return { routing: { platformId: mg.platform_id, channelType: mg.channel_type, threadId: threadIdArg ?? null } };
}

async function createTask(args: Record<string, unknown>, ctx: CallerContext) {
  const group = groupArg(args, ctx);
  if (!group) throw new Error('--group is required');
  const prompt = str(args.prompt);
  if (!prompt) throw new Error('--prompt is required');
  const recurrence = normalizeNullableString(args.recurrence) ?? null;
  const script = normalizeNullableString(args.script) ?? null;
  const scriptHost = bool(args.script_host);
  if (scriptHost && !script) throw new Error('--script-host requires --script');
  // Only a HOST OPERATOR may opt into host execution: the host-side classifier is a regex subset, not a sandbox, so
  // for agent-authored script text the trust boundary is who set the flag.
  if (scriptHost && ctx.caller === 'agent') {
    throw new Error('--script-host runs the script on the host and can only be set by a host operator');
  }
  // Wall-clock fields are interpreted in the owning group's timezone.
  const tz = await resolveGroupTimezone(group);
  validateRecurrence(recurrence, tz);
  enforceRecurrenceLimit(recurrence, bool(args.dangerously_override_recurrence_limit), script != null, tz);
  const processAfter = firstRunIso(args.process_after, recurrence, tz);
  const id = makeTaskId(args.name);
  const originSessionId = ctx.caller === 'agent' ? ctx.sessionId : null;
  const { routing, note: routingNote } = await resolveTaskRouting(args, ctx);
  const { flagIntent, error: flagError } = await resolveTaskFlagIntent(
    { model: str(args.model), effort: str(args.effort) },
    { agent_group_id: group },
  );
  if (flagError) throw new Error(flagError);

  // `routing.platformId` is stamped on the session as well as the task row: the row drives the fire path, the session
  // column places the task in the console (migration 056).
  const { session } = await resolveTaskSession(group, id, routing.platformId);

  const created = await withInbound(session, (mailbox) =>
    withCentralSync(
      () =>
        withQuietInvalidationSync(session.id, () => {
          mailbox.insertTaskRow({
            id,
            seriesId: id,
            processAfter,
            recurrence,
            platformId: routing.platformId,
            channelType: routing.channelType,
            threadId: routing.threadId,
            content: JSON.stringify({
              prompt,
              script,
              ...(scriptHost ? { scriptHost: true } : {}),
              ...(args.thread_anchor !== undefined && !bool(args.thread_anchor) ? { threadAnchor: false } : {}),
              originSessionId,
              ...(flagIntent && (flagIntent.turnModel || flagIntent.turnEffort) ? { flagIntent } : {}),
              // Enforced by the agent-runner: chat-kind outbound writes are dropped.
              ...(bool(args.mute_chat) ? { muteChat: true } : {}),
              ...(bool(args.quiet_status) ? { quietStatus: true } : {}),
              ...(bool(args.continuous) ? { continuous: true } : {}),
              // Per-turn chat send budget.
              ...(chatLimitArg(args) !== undefined ? { chatLimit: chatLimitArg(args) } : {}),
            }),
          });
          return mailbox.getCliTaskRow(id);
        }),
      'ncl tasks create',
    ),
  );
  if (!created) throw new Error('task system session inbound.db not found');
  await writeAudit({
    actor: actorFor(ctx),
    action: 'create',
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    seriesId: id,
    after: prompt,
    ...(script !== null ? { scriptAfter: script } : {}),
    detail: { recurrence, processAfter },
  });
  const output = toOutput(session, created);
  return routingNote ? { ...output, routing_note: routingNote } : output;
}

async function dispatchTask(args: Record<string, unknown>, ctx: CallerContext) {
  const group = groupArg(args, ctx);
  if (!group) throw new Error('--group is required');
  if (!(await getAgentGroup(group))) throw new Error('agent group not found');
  const contextKey = args.context_key;
  const eventKey = args.event_key;
  validateDispatchKey(contextKey, '--context-key');
  validateDispatchKey(eventKey, '--event-key');
  const retryOf = args.retry_of;
  if (retryOf !== undefined) validateDispatchKey(retryOf, '--retry-of');
  const prompt = str(args.prompt);
  if (!prompt?.trim() || prompt.length > 64_000) throw new Error('--prompt must contain 1–64000 characters');
  const { routing, note } = await resolveTaskRouting(args, ctx);
  // A colliding replay must not mutate the existing route, so no re-stamp.
  const { session } = await resolveTaskSession(group, dispatchSeriesId(contextKey));
  const admitted = await withInbound(session, (mailbox) =>
    withCentralSync(
      () =>
        withQuietInvalidationSync(session.id, () =>
          mailbox.dispatchTaskEvent({
            contextKey,
            eventKey,
            retryOf,
            prompt,
            originSessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
            ...routing,
            muteChat: bool(args.mute_chat),
            quietStatus: bool(args.quiet_status),
          }),
        ),
      'ncl tasks dispatch',
    ),
  );
  if (!admitted) throw new Error('task session mailbox unavailable');
  if (routing.platformId !== null && session.task_routing_platform_id !== routing.platformId) {
    await setTaskRoutingPlatformId(session.id, routing.platformId);
  }
  if (admitted.admission === 'inserted')
    await writeAudit({
      actor: actorFor(ctx),
      action: 'create',
      agentGroupId: group,
      sessionId: session.id,
      seriesId: admitted.seriesId,
      after: prompt,
      detail: { dispatch: { contextKey, eventKey, retryOf: retryOf ?? null, attempt: admitted.attempt } },
    });
  return {
    admission: admitted.admission,
    row_id: admitted.rowId,
    series_id: admitted.seriesId,
    session_id: session.id,
    agent_group_id: group,
    status: admitted.status,
    attempt: admitted.attempt,
    ...(note ? { routing_note: note } : {}),
  };
}

/**
 * Append one host-timestamped line to a task's run log
 * (`<GROUPS_DIR>/<folder>/tasks/<series>.md`). This is NOT a delivery — it writes
 * nothing to messages_out; it just records what happened so the agent (and human)
 * can see when and why each run happened. Inside a task run the series is derived from
 * the caller's own task session, so the agent supplies only --msg.
 */
async function appendTaskLog(
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<{ series: string; timestamp: string; path: string; ok: true }> {
  const msg = str(args.msg);
  if (!msg) throw new Error('--msg is required');

  let series = str(args.id);
  let group = groupArg(args, ctx);
  if (!series && ctx.caller === 'agent' && ctx.sessionId) {
    const sess = await getSession(ctx.sessionId);
    // Null for a bare legacy `system:tasks`, which then fails the `--id is required` check below.
    const derived = taskSeriesId(sess?.thread_id ?? null);
    if (sess && derived !== null) {
      series = derived;
      group ??= sess.agent_group_id;
    }
  }
  if (!series) throw new Error('--id is required (no task session to derive it from)');
  if (!group) throw new Error('could not resolve the agent group');

  // Group scope is enforced by groupArg (a cli_scope=group caller can only
  // ever resolve its own folder), so a foreign id at worst writes a stray log
  // under the caller's OWN folder — no leak. appendRunLog guards the charset.
  return { ...(await appendRunLog(group, series, msg)), ok: true };
}

/**
 * Run history for one task series, aggregated over its occurrence rows: number
 * of successful fires, the last fire time, and failed fires (a row reaches
 * `failed` after MAX_TRIES on a stuck claim). Cancelled occurrences are
 * `cancelled`, not `completed`, so they never inflate the run count.
 */
function seriesStats(
  mailbox: NanoclawMailboxSession,
  seriesKey: string,
): { runs: number; last_run: string | null; failed_runs: number } {
  // Upstream's own op (invariant I-2).
  const stats = mailbox.getTaskStats(seriesKey);
  return { runs: stats.runs, last_run: stats.lastRun, failed_runs: stats.failedRuns };
}

/** Last ~10 lines of a series' run log (`tasks/<series>.md`), newest last. */
async function tailRunLog(agentGroupId: string, seriesKey: string, lines = 10): Promise<string[]> {
  const ag = await getAgentGroup(agentGroupId);
  if (!ag) return [];
  const file = `${GROUPS_DIR}/${ag.folder}/tasks/${seriesKey}.md`;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-lines);
}

/**
 * A task series is CronJob-like: the live (pending/paused) row is the next run,
 * and the `completed` rows are its run history. Enrich each listed series with
 * that history — run count, failures, last fire, next fire, schedule, and a
 * pointer to the agent's own run log — so `tasks list` reads as a compact
 * run-history table.
 */
function enrichListRow(mailbox: NanoclawMailboxSession, base: ReturnType<typeof toOutput>) {
  const seriesKey = base.series_id;
  const stats = seriesStats(mailbox, seriesKey);
  return {
    ...base,
    schedule: base.recurrence ?? 'once',
    runs: stats.runs,
    failed_runs: stats.failed_runs,
    last_run: stats.last_run,
    next_run: base.process_after,
    log: `tasks/${seriesKey}.md`,
  };
}

async function listTasks(args: Record<string, unknown>, ctx: CallerContext) {
  const status = statusFilter(args);
  const rows = [];
  for (const session of await selectedSessions(args, ctx)) {
    const sessionRows = await withInbound(session, (mailbox) =>
      mailbox.listCliTaskSeries(status).map((row) => enrichListRow(mailbox, toOutput(session, row))),
    );
    if (sessionRows) rows.push(...sessionRows);
  }
  return rows;
}

async function getTask(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of await selectedSessions(args, ctx)) {
    const settlementRequested =
      bool(args.settlement) || bool(args.observer_settlement) || bool(args.future_inputs_settled);
    const settlementSession = settlementRequested ? await getSession(session.id) : undefined;
    const found = await withInbound(session, (mailbox) => {
      const row = mailbox.getCliTaskRow(id);
      if (!row) return undefined;
      const seriesKey = row.series_id ?? row.row_id;
      const stats = seriesStats(mailbox, seriesKey);
      const content = parseTaskContent(row.content);
      return {
        ...toOutput(session, row),
        prompt: content.prompt,
        script: content.script,
        origin_session_id: content.originSessionId,
        completed_runs: stats.runs,
        failed_runs: stats.failed_runs,
        seriesKey,
        ...(settlementRequested
          ? {
              settlement: mailbox.readTaskSettlement(
                row.row_id,
                settlementSession?.thread_id ?? null,
                bool(args.observer_settlement),
                bool(args.future_inputs_settled),
              ),
            }
          : {}),
      };
    });
    if (found) {
      // Read after the mailbox action: the log lookup is async and cannot sit inside the synchronous callback.
      const { seriesKey, ...output } = found;
      return { ...output, recent_log: await tailRunLog(session.agent_group_id, seriesKey) };
    }
  }
  throw new Error(`task not found: ${id}`);
}

async function mutateTask(
  args: Record<string, unknown>,
  ctx: CallerContext,
  action: 'pause' | 'resume' | 'delete' | 'cancel',
  fn: (mailbox: NanoclawMailboxSession, id: string) => number,
) {
  const id = taskId(args);
  let touched = 0;
  for (const session of await selectedSessions(args, ctx)) {
    const n =
      (await withInbound(session, (mailbox) =>
        withCentralSync(() => {
          // Probe first (see the invalidation note above).
          if (!mailbox.getCliTaskRow(id)) return 0;
          return withQuietInvalidationSync(session.id, () => fn(mailbox, id));
        }, `ncl tasks ${action}`),
      )) ?? 0;
    if (n > 0) {
      // No body before/after: these verbs change status only, matching the dashboard's audit rows.
      await writeAudit({
        actor: actorFor(ctx),
        action,
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        seriesId: id,
      });
    }
    touched += n;
  }
  if (touched === 0) throw new Error(`no live task matched: ${id}`);
  return { series_id: id, touched };
}

function chatLimitArg(args: Record<string, unknown>): number | undefined {
  const raw = args.chat_limit;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('--chat-limit must be a non-negative integer');
  return n;
}

async function updateTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  const update: TaskUpdate = {};
  if (typeof args.prompt === 'string') {
    // An empty prompt is refused as in `create`: `--prompt "$(cat missing.md)"` would otherwise blank a live series
    // into a recurring no-op that still spawns a container.
    if (!args.prompt.trim()) throw new Error('--prompt must not be empty; omit it to keep the current prompt');
    update.prompt = args.prompt;
  }
  if (chatLimitArg(args) !== undefined) update.chatLimit = chatLimitArg(args);
  if (args.quiet_status !== undefined) update.quietStatus = bool(args.quiet_status);
  if (args.continuous !== undefined) update.continuous = bool(args.continuous);
  const recurrence = normalizeNullableString(args.recurrence);
  const script = normalizeNullableString(args.script);

  // An unscoped host update can span groups with different timezones, and both the persisted instant and the 24h
  // recurrence ceiling depend on the zone, so EVERY matched session validates in its own zone before the first write.
  // Only live rows count: `getCliTaskRow()` falls back to terminal history, which `updateTask()` never writes, and a
  // same-id terminal row elsewhere must not veto the edit. Sequential so only one mailbox is open at a time.
  const matched: { session: ScopedSession; row: TaskRow }[] = [];
  for (const session of await selectedSessions(args, ctx)) {
    const row = await withInbound(session, (mailbox) => mailbox.getCliTaskRow(id));
    if (row && (row.status === 'pending' || row.status === 'paused')) matched.push({ session, row });
  }

  const validationZones =
    matched.length > 0
      ? matched.map((m) => ({ tz: resolveGroupTimezone(m.session.agent_group_id), row: m.row }))
      : // Nothing matched: still validate the input so a typo is reported as one.
        [{ tz: TIMEZONE, row: undefined }];

  for (const { tz, row } of validationZones) {
    if (args.process_after !== undefined) parseProcessAfter(args.process_after, await tz);
    if (recurrence !== undefined) {
      validateRecurrence(recurrence, await tz);
      // The effective script AFTER this update, including an explicit clear.
      const scriptAfter: string | null =
        script !== undefined ? script : row ? parseTaskContent(row.content).script : null;
      enforceRecurrenceLimit(
        recurrence,
        bool(args.dangerously_override_recurrence_limit),
        scriptAfter != null,
        await tz,
      );
    }
  }
  if (recurrence !== undefined) update.recurrence = recurrence;

  // A new cron with the old armed timestamp fires off the new grid, so unless `--process-after` is pinned the next
  // fire is re-derived in the receiving group's zone.
  const rearmFromCron = recurrence !== undefined && recurrence !== null && args.process_after === undefined;
  const hasWallClockUpdate = args.process_after !== undefined || rearmFromCron;

  function wallClockUpdate(tz: string): TaskUpdate {
    if (!hasWallClockUpdate) return {};
    if (args.process_after !== undefined) return { processAfter: parseProcessAfter(args.process_after, tz) };
    return { processAfter: CronExpressionParser.parse(recurrence!, { tz }).next().toDate().toISOString() };
  }
  if (script !== undefined) update.script = script;
  if (args.script_host !== undefined) {
    const scriptHost = bool(args.script_host);
    // Agents may clear the flag (strictly safer) but never set it.
    if (scriptHost && ctx.caller === 'agent') {
      throw new Error('--script-host runs the script on the host and can only be set by a host operator');
    }
    // Only catches the same-call clear; setting scriptHost on an already-scriptless task is a silent no-op in
    // host-script.ts.
    if (scriptHost && script === null) throw new Error('--script-host requires --script');
    update.scriptHost = scriptHost;
  }
  if (args.thread_anchor !== undefined) update.threadAnchor = bool(args.thread_anchor);
  // `--model ""` (or this verb's `null`/`none`) CLEARS the per-fire pin. `str()` would collapse the empty string,
  // which on this flag is the whole request.
  const model = normalizeNullableString(args.model);
  const effort = normalizeNullableString(args.effort);
  if (model !== undefined || effort !== undefined) {
    // `--group` is required for a clear too: series ids are unique per group, not fleet-wide, so an unscoped clear
    // could silently unpin a same-named series in another group.
    const group = groupArg(args, ctx);
    if (!group) throw new Error('--group is required to set or clear --model/--effort');
    if (model || effort) {
      const { flagIntent, error: flagError } = await resolveTaskFlagIntent(
        { model: model ?? undefined, effort: effort ?? undefined },
        { agent_group_id: group },
      );
      if (flagError) throw new Error(flagError);
      if (flagIntent?.turnModel) update.flagIntent = { ...update.flagIntent, turnModel: flagIntent.turnModel };
      if (flagIntent?.turnEffort) update.flagIntent = { ...update.flagIntent, turnEffort: flagIntent.turnEffort };
    }
    // Clears apply after the validated sets and independently, so one call may clear one axis and set the other.
    if (model === null) update.flagIntent = { ...update.flagIntent, turnModel: null };
    if (effort === null) update.flagIntent = { ...update.flagIntent, turnEffort: null };
  }
  // `wallClockUpdate` adds exactly one key, so the reported field list is the same for every session even though the
  // instant differs.
  const fields = hasWallClockUpdate ? [...Object.keys(update), 'processAfter'] : Object.keys(update);
  if (fields.length === 0) throw new Error('nothing to update');

  let touched = 0;
  for (const { session } of matched) {
    // One value per session, and the only one: what is written is what is audited and reported (merging per-session
    // parts only at the write once audited nothing). The zone is resolved before the session opens so the block stays
    // synchronous from row read to write.
    const tz = await resolveGroupTimezone(session.agent_group_id);
    const sessionUpdate: TaskUpdate = { ...update, ...wallClockUpdate(tz) };
    const result = await withInbound(session, (mailbox) =>
      withCentralSync(() => {
        const before = mailbox.getCliTaskRow(id);
        // `before` doubles as the probe.
        if (!before) return { before, n: 0 };
        // An agent swapping the script on a host-flagged series would get its own script run on the host, so it is
        // rejected unless the same call clears the flag.
        if (
          ctx.caller === 'agent' &&
          sessionUpdate.script !== undefined &&
          sessionUpdate.scriptHost !== false &&
          before &&
          parseTaskContent(before.content).scriptHost
        ) {
          throw new Error('this series runs its script on the host — an operator must make script changes');
        }
        // The recurrence ceiling is enforced AGAIN against the row this write lands on: the pre-pass decided the
        // script exemption from an earlier mailbox read, and opening a mailbox yields, so another caller may have
        // cleared that script in between. Deciding from `before`, with nothing awaited before the write, ties the
        // exemption to its row.
        if (recurrence !== undefined) {
          const scriptNow: string | null =
            script !== undefined ? script : before ? parseTaskContent(before.content).script : null;
          enforceRecurrenceLimit(recurrence, bool(args.dangerously_override_recurrence_limit), scriptNow != null, tz);
        }
        const n = withQuietInvalidationSync(session.id, () => mailbox.updateTask(id, sessionUpdate));
        return { before, n };
      }, 'ncl tasks update'),
    );
    if (!result) continue;
    const { before, n } = result;
    if (n > 0) {
      await writeAudit({
        actor: actorFor(ctx),
        action: 'update',
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        seriesId: id,
        before: before ? parseTaskContent(before.content).prompt : undefined,
        ...(sessionUpdate.prompt !== undefined ? { after: sessionUpdate.prompt } : {}),
        ...(sessionUpdate.script !== undefined && sessionUpdate.script !== null
          ? { scriptAfter: sessionUpdate.script }
          : {}),
        detail: {
          ...(sessionUpdate.recurrence !== undefined ? { recurrence: sessionUpdate.recurrence } : {}),
          ...(sessionUpdate.processAfter !== undefined ? { processAfter: sessionUpdate.processAfter } : {}),
          // Records the pin from and to. A clear destroys a value (and `--model "$UNSET"` now means clear), so
          // without `from` nothing could say what the series was pinned to.
          ...(sessionUpdate.flagIntent !== undefined
            ? {
                pin: {
                  from: before ? parseTaskPin(before.content) : null,
                  // The MERGED result, not the delta: an untouched axis keeps its value.
                  to: {
                    model:
                      sessionUpdate.flagIntent.turnModel === undefined
                        ? before
                          ? parseTaskPin(before.content).model
                          : null
                        : sessionUpdate.flagIntent.turnModel,
                    effort:
                      sessionUpdate.flagIntent.turnEffort === undefined
                        ? before
                          ? parseTaskPin(before.content).effort
                          : null
                        : sessionUpdate.flagIntent.turnEffort,
                  },
                },
              }
            : {}),
        },
      });
    }
    touched += n;
  }
  if (touched === 0) throw new Error(`no live task matched: ${id}`);
  return { series_id: id, touched, fields };
}

async function cancelTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  if (!bool(args.all)) {
    return mutateTask(args, ctx, 'cancel', (mailbox, id) => mailbox.cancelTask(id));
  }

  // `--id` with `--all` is a contradiction (one series versus every series), refused rather than letting the kill
  // switch silently win.
  const named = suppliedFlag(args, 'id', '--id');
  if (named) {
    throw new Error(
      `--all cancels every live task in scope, but --id ${named} names one: ` +
        'pass --id on its own to cancel that series, or --all on its own to cancel them all',
    );
  }

  let touched = 0;
  for (const session of await selectedSessions(args, ctx)) {
    const result = await withInbound(session, (mailbox) =>
      withCentralSync(() => {
        const seriesIds = mailbox.listCliTaskSeries().map((r) => r.series_id ?? r.row_id);
        // The listing is the probe: exactly the pending/paused set cancel-all updates.
        if (seriesIds.length === 0) return { seriesIds, n: 0 };
        // Upstream's `cancelTask()` with no id IS cancel-all (invariant I-2).
        return { seriesIds, n: withQuietInvalidationSync(session.id, () => mailbox.cancelTask()) };
      }, 'ncl tasks cancel-all'),
    );
    if (!result) continue;
    if (result.n > 0) {
      for (const seriesId of result.seriesIds) {
        await writeAudit({
          actor: actorFor(ctx),
          action: 'cancel',
          agentGroupId: session.agent_group_id,
          sessionId: session.id,
          seriesId,
          detail: { bulk: true },
        });
      }
    }
    touched += result.n;
  }
  return { cancelled: touched };
}

/**
 * Moves one series through the dashboard's hardened transaction. A move changes execution identity, so it never fans
 * out and is host-only (0600 socket).
 */
async function moveTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  if (ctx.caller !== 'host') throw new Error('tasks move is operator-only');
  const seriesId = taskId(args);
  const sourceAgentGroupId = suppliedFlag(args, 'group', '--group');
  const sourceSessionId = suppliedFlag(args, 'session', '--session');
  const targetAgentGroupId = suppliedFlag(args, 'target_group', '--target-group');
  const targetMessagingGroupId = suppliedFlag(args, 'target_messaging_group', '--target-messaging-group');
  if (!sourceAgentGroupId || !sourceSessionId || !targetAgentGroupId || !targetMessagingGroupId) {
    throw new Error('--group, --session, --target-group, and --target-messaging-group are required');
  }
  return moveTaskAsHost({
    sourceAgentGroupId,
    sourceSessionId,
    seriesId,
    targetAgentGroupId,
    targetMessagingGroupId,
  });
}

/**
 * `ncl tasks run <id>` — fire a task on demand without disturbing its schedule.
 * Inserts a fresh pending occurrence (same series, content, no recurrence) due
 * now, which the next sweep delivers through the normal fire path. Unlike
 * `update --process-after now`, it neither consumes a one-shot nor force-advances
 * a recurring series' armed occurrence, so it is safe for testing a task.
 */
async function runTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of await selectedSessions(args, ctx)) {
    const fired = await withInbound(session, (mailbox) =>
      withCentralSync(() => {
        const row = mailbox.getCliTaskRow(id);
        // No row, no fire, no invalidation.
        if (!row) return undefined;
        const seriesKey = row.series_id ?? row.row_id;
        const rowId = makeTaskId(`${seriesKey}-run`);
        // recurrence=NULL is load-bearing: handleRecurrence must not re-arm a run-now row into a phantom series.
        // Routing carries over from the source row.
        withQuietInvalidationSync(session.id, () =>
          mailbox.insertTaskRow({
            id: rowId,
            seriesId: seriesKey,
            processAfter: new Date().toISOString(),
            recurrence: null,
            platformId: row.platform_id,
            channelType: row.channel_type,
            threadId: row.thread_id,
            content: row.content,
          }),
        );
        return { series_id: seriesKey, row_id: rowId, status: 'pending' };
      }, 'ncl tasks run'),
    );
    if (fired) {
      await writeAudit({
        actor: actorFor(ctx),
        action: 'run_now',
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        seriesId: fired.series_id,
      });
      return fired;
    }
  }
  throw new Error(`task not found: ${id}`);
}

/**
 * `ncl tasks repin`: retarget per-fire pins in bulk. `--target-provider` validates against the provider a group is
 * ABOUT to become, since re-pinning ahead of a provider switch would otherwise be rejected by the current provider's
 * check.
 * MATCHING IS LITERAL by default: `sonnet` (a floating family alias) and `claude-sonnet-5` (frozen) are different
 * pins, and rewriting the first freezes it. `--match-resolved` unifies them, and near-misses are always reported so a
 * literal run never looks exhaustive.
 * ALL-OR-NOTHING validation by default; `--skip-invalid` applies the valid subset.
 */
interface RepinCandidate {
  session: ScopedSession;
  seriesId: string;
  status: string;
  current: { model: string | null; effort: string | null };
  /** Verbatim; may be an alias. */
  next: { model?: string; effort?: string };
  /**
   * What is written: the validator's RESOLVED values for the axes the operator set. Acceptance and resolution are one
   * act, so storing the raw alias would persist a value the check never approved (and `codex.ts::resolveQueryModel`
   * silently falls back on a non-`gpt-*` value).
   */
  write: { model?: string; effort?: string };
  matchedVia: 'literal' | 'resolved';
}

interface RepinRejection {
  session_id: string;
  series_id: string;
  reason: string;
}

/**
 * `normalize` always applies (same value spelled differently, e.g. effort case); `resolver` is the semantic widening
 * `--match-resolved` gates (two pins that resolve alike are still different pins).
 */
/**
 * In the vocabulary of the task's group: provider spellings normalize first, then family names expand, so `astra`
 * also finds a codex pin stored as `gpt-6-astra`.
 */
function modelResolverFor(provider: string): (v: string) => string {
  const vocab = vocabFor(provider);
  return (v: string) => resolveEffectiveModel(vocab.resolveModel(v.trim()));
}

function pinMatches(
  stored: string | null,
  wanted: string | undefined,
  normalize: (v: string) => string,
  resolver: (v: string) => string,
  matchResolved: boolean,
): 'literal' | 'resolved' | null {
  if (wanted === undefined) return 'literal'; // No constraint on this axis.
  if (stored === null) return null;
  if (normalize(stored) === normalize(wanted)) return 'literal';
  if (matchResolved && resolver(stored) === resolver(wanted)) return 'resolved';
  return null;
}

/** Model ids are case-sensitive; only surrounding whitespace is noise. */
function modelLiteral(v: string): string {
  return v.trim();
}

/** Effort has no alias layer and no case significance, so this is normalization, not `--match-resolved` widening. */
function effortIdentity(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * A fleet-wide run walks `findTaskSessions` per group, not the unscoped `selectedSessions` fallback: that is every
 * active session (hundreds of mailbox opens, a known sweep staller), and task series live only in task sessions,
 * which is also exactly what `auditTaskPins` reports.
 */
async function repinSessions(args: Record<string, unknown>, ctx: CallerContext): Promise<ScopedSession[]> {
  // The cross-group `--session` refusal lives in `selectedSessions`; do not duplicate it here.
  if (str(args.session) || groupArg(args, ctx)) return selectedSessions(args, ctx);
  const sessions: ScopedSession[] = [];
  for (const group of await getAllAgentGroups()) {
    sessions.push(...(await findTaskSessions(group.id)).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id })));
  }
  return sessions;
}

/**
 * CONTRADICTORY-INPUT REFUSALS. Two inputs that cannot both be true are refused, never reconciled by silently picking
 * one: either reading is plausible, and the command reports success whichever was dropped. Owned here:
 * `--target-provider` with `--all` (would validate the fleet against one group's future provider), `--group` with
 * `--all`, and `--all` with `--session`. `suppliedFlag`, not `str`, is used because `--group ""` would otherwise read
 * as absent and widen a scoped repin to fleet-wide.
 * Elsewhere: `--group A --session <B's>` (`selectedSessions`) and `cancel --id X --all`. `create --isolated --thread`
 * silently prefers `--isolated` by design: non-destructive and fails toward the narrower option.
 */
async function repinTasks(args: Record<string, unknown>, ctx: CallerContext) {
  const fromModel = suppliedFlag(args, 'from_model', '--from-model');
  const toModel = suppliedFlag(args, 'to_model', '--to-model');
  const fromEffort = suppliedFlag(args, 'from_effort', '--from-effort');
  const toEffort = suppliedFlag(args, 'to_effort', '--to-effort');
  if (!toModel && !toEffort) {
    throw new Error('nothing to set — pass --to-model and/or --to-effort');
  }
  if (toModel && !fromModel) throw new Error('--to-model requires --from-model (repin retargets an existing pin)');
  if (toEffort && !fromEffort) throw new Error('--to-effort requires --from-effort (repin retargets an existing pin)');

  const group = groupArg(args, ctx);
  const sessionId = suppliedFlag(args, 'session', '--session');
  if (!group && !sessionId && !bool(args.all)) {
    throw new Error('a scope is required: --group <id>, --session <id>, or --all for fleet-wide');
  }
  if (group && bool(args.all)) {
    throw new Error('--group and --all are contradictory scopes; pass one or the other');
  }
  if (bool(args.all) && sessionId !== undefined) {
    throw new Error(
      '--all and --session are contradictory scopes: --all is fleet-wide, --session is one session. ' +
        '--session alone is already a complete scope.',
    );
  }
  // Narrows the walk to one series inside the chosen scope; it is not a scope itself, so a scope is still required.
  const seriesId = suppliedFlag(args, 'series_id', '--series-id');
  const targetProvider = suppliedFlag(args, 'target_provider', '--target-provider');
  // `--target-provider` describes ONE group's migration; fleet-wide it would write one provider's ids onto every
  // other provider's series and report success.
  if (targetProvider && !group) {
    throw new Error(
      '--target-provider requires --group: it names the provider ONE group is migrating to, ' +
        'and applying it fleet-wide would validate every group against a provider it is not moving to.',
    );
  }
  const matchResolved = bool(args.match_resolved);
  const dryRun = bool(args.dry_run);
  const skipInvalid = bool(args.skip_invalid);

  // One provider read per group, not per task. MATCHING uses the group's CURRENT provider (the vocabulary the stored
  // pin was written in); VALIDATION uses the target provider when given (will the new value run). Conflating them
  // broke both halves of a migration repin.
  const providerCache = new Map<string, string>();
  const currentProviderFor = async (agentGroupId: string): Promise<string> => {
    const cached = providerCache.get(agentGroupId);
    if (cached) return cached;
    // Through the seam, not `getContainerConfig`: the projection can lag the authoritative file and resolve in the
    // wrong vocabulary.
    const resolved = await resolveGroupProvider(agentGroupId);
    providerCache.set(agentGroupId, resolved);
    return resolved;
  };
  const validationProviderFor = async (agentGroupId: string): Promise<string> =>
    targetProvider ?? currentProviderFor(agentGroupId);

  const candidates: RepinCandidate[] = [];
  const nearMisses: Array<{ session_id: string; series_id: string; model: string | null; effort: string | null }> = [];
  // WHERE `--series-id` was seen, not just whether. Not seen: a typo would otherwise read as "not pinned to
  // --from-model". Seen in several sessions: series ids are not globally unique (`<slug>-<4hex>`), so under `--all`
  // one id could re-pin several series; refused before any write.
  const seriesSeenIn = new Set<string>();

  for (const session of await repinSessions(args, ctx)) {
    const rows =
      (await withInbound(session, (mailbox) =>
        mailbox.listCliTaskSeries().map((row) => ({
          seriesId: row.series_id ?? row.row_id,
          status: row.status,
          pin: parseTaskPin(row.content),
        })),
      )) ?? [];
    for (const row of rows) {
      // A NARROWING filter only: the --from-* match still applies, since repin retargets an existing pin (`tasks
      // update --model` is the blind overwrite).
      if (seriesId !== undefined && row.seriesId !== seriesId) continue;
      if (seriesId !== undefined) seriesSeenIn.add(`${session.agent_group_id}/${session.id}`);
      const resolveModel = modelResolverFor(await currentProviderFor(session.agent_group_id));
      const modelHit = pinMatches(row.pin.model, fromModel, modelLiteral, resolveModel, matchResolved);
      const effortHit = pinMatches(row.pin.effort, fromEffort, effortIdentity, effortIdentity, matchResolved);
      if (modelHit === null || effortHit === null) {
        // Would --match-resolved have matched? Reported so a literal match never silently looks exhaustive.
        const asResolvedModel = pinMatches(row.pin.model, fromModel, modelLiteral, resolveModel, true);
        const asResolvedEffort = pinMatches(row.pin.effort, fromEffort, effortIdentity, effortIdentity, true);
        if (!matchResolved && asResolvedModel !== null && asResolvedEffort !== null) {
          nearMisses.push({
            session_id: session.id,
            series_id: row.seriesId,
            model: row.pin.model,
            effort: row.pin.effort,
          });
        }
        continue;
      }
      const next: { model?: string; effort?: string } = {};
      if (toModel) next.model = toModel;
      if (toEffort) next.effort = toEffort;
      candidates.push({
        session,
        seriesId: row.seriesId,
        status: row.status,
        current: row.pin,
        next,
        write: {},
        matchedVia: modelHit === 'resolved' || effortHit === 'resolved' ? 'resolved' : 'literal',
      });
    }
  }

  // "No such series in scope" and "not pinned to --from-model" are different answers; only the first means the
  // command was wrong.
  if (seriesId !== undefined && seriesSeenIn.size === 0) {
    throw new Error(`no task series ${seriesId} in scope — check --series-id against \`ncl tasks list\``);
  }
  // An ambiguous id is refused, never resolved by picking one.
  if (seriesId !== undefined && seriesSeenIn.size > 1) {
    throw new Error(
      `--series-id ${seriesId} is ambiguous: it names a series in ${seriesSeenIn.size} sessions ` +
        `(${[...seriesSeenIn].sort().join(', ')}). Series ids are unique within an agent group, not across the ` +
        'fleet — narrow the run with --group <id> or --session <id>.',
    );
  }

  // Validate EVERY match before writing, each against its OWN group's provider (or --target-provider). Validate the
  // MERGED pin, not the delta: `updateTask` merges flagIntent, so a model-only repin keeps an effort that may be
  // invalid for the new provider.
  const rejected: RepinRejection[] = [];
  const applicable: RepinCandidate[] = [];
  for (const candidate of candidates) {
    const provider = await validationProviderFor(candidate.session.agent_group_id);
    const merged = {
      model: candidate.next.model ?? candidate.current.model,
      effort: candidate.next.effort ?? candidate.current.effort,
    };
    const { flagIntent, error } = validateTaskPin(merged, provider);
    if (error) {
      rejected.push({ session_id: candidate.session.id, series_id: candidate.seriesId, reason: error });
      continue;
    }
    // Persist the RESOLVED value only for the axes the operator asked to change; resolving an untouched axis would
    // rewrite a pin nobody asked about. No `?? candidate.next.*` fallback: that would persist the raw request the
    // validator did not return.
    if (candidate.next.model !== undefined) candidate.write.model = flagIntent?.turnModel;
    if (candidate.next.effort !== undefined) candidate.write.effort = flagIntent?.turnEffort;
    applicable.push(candidate);
  }

  const report = (applied: number) => ({
    matched: candidates.length,
    applied,
    rejected,
    dry_run: dryRun,
    match_resolved: matchResolved,
    changes: candidates.map((c) => ({
      agent_group_id: c.session.agent_group_id,
      session_id: c.session.id,
      series_id: c.seriesId,
      status: c.status,
      matched_via: c.matchedVia,
      from: { model: c.current.model, effort: c.current.effort },
      // Resolved, so a dry run shows what will be stored.
      to: {
        model: c.write.model ?? c.next.model ?? c.current.model,
        effort: c.write.effort ?? c.next.effort ?? c.current.effort,
      },
    })),
    // Resolved-but-not-literal matches, left untouched by design.
    near_misses: nearMisses,
  });

  if (rejected.length > 0 && !skipInvalid) {
    throw new Error(
      `refusing to re-pin: ${rejected.length} of ${candidates.length} matched series would get an invalid pin, ` +
        `and a half-applied bulk re-pin is worse than none.\n` +
        rejected.map((r) => `  ${r.series_id}: ${r.reason}`).join('\n') +
        `\n\nFix the target value, pass --target-provider <provider> if you are re-pinning ahead of a provider ` +
        `migration, or pass --skip-invalid to apply the ${applicable.length} valid change(s) and skip these.`,
    );
  }

  if (dryRun) return report(0);

  // VALIDATION is all-or-nothing; the WRITE phase cannot be: each series lives in its own session DB, with no
  // spanning transaction and no honest rollback. So a failed candidate is recorded and the loop continues, reporting
  // exactly which series moved. Aborting would leave the same partial state while hiding what landed.
  let applied = 0;
  const failed: Array<{ session_id: string; series_id: string; reason: string }> = [];
  for (const candidate of applicable) {
    const flagIntent: TaskUpdate['flagIntent'] = {};
    if (candidate.write.model) flagIntent.turnModel = candidate.write.model;
    if (candidate.write.effort) flagIntent.turnEffort = candidate.write.effort;
    try {
      const n =
        (await withInbound(candidate.session, (mailbox) =>
          withCentralSync(() => {
            // Same probe as every other mutating verb.
            if (!mailbox.getCliTaskRow(candidate.seriesId)) return 0;
            return withQuietInvalidationSync(candidate.session.id, () =>
              mailbox.updateTask(candidate.seriesId, { flagIntent }),
            );
          }, 'ncl tasks repin'),
        )) ?? 0;
      if (n > 0) {
        await writeAudit({
          actor: actorFor(ctx),
          action: 'update',
          agentGroupId: candidate.session.agent_group_id,
          sessionId: candidate.session.id,
          seriesId: candidate.seriesId,
          detail: {
            repin: {
              from: { model: candidate.current.model, effort: candidate.current.effort },
              // `updateTask` MERGES, so an untouched axis survives; recording it as null would falsely say it was
              // cleared.
              to: {
                model: candidate.write.model ?? candidate.current.model,
                effort: candidate.write.effort ?? candidate.current.effort,
              },
            },
          },
        });
        applied += 1;
      }
    } catch (e) {
      failed.push({
        session_id: candidate.session.id,
        series_id: candidate.seriesId,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (failed.length > 0) {
    log.warn('Bulk repin partially applied', { applied, failed: failed.length, failures: failed });
  }
  return { ...report(applied), failed };
}

registerResource({
  name: 'task',
  plural: 'tasks',
  table: 'messages_in',
  description:
    'Scheduled task — prompt plus run time. Tasks run from the agent group system session and the agent chooses delivery destination at fire time.',
  idColumn: 'series_id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'series_id', type: 'string', description: 'Stable task handle.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group that owns the task.' },
    { name: 'session_id', type: 'string', description: 'System session that runs the task.' },
    { name: 'status', type: 'string', description: 'Live state.', enum: ['pending', 'paused'] },
    {
      name: 'process_after',
      type: 'string',
      // Not flagged required: with --recurrence the first run is derived from the
      // cron grid (firstRunIso). Required only for one-shots, enforced in the
      // create handler — so the generic col.required validator must stay off here.
      description:
        "Next run time (ISO 8601, or naive wall-clock read in the owning group's timezone). Required for one-shots; with --recurrence the first run is derived from the cron grid, also in that timezone.",
      updatable: true,
    },
    { name: 'recurrence', type: 'string', description: 'Optional cron expression.', updatable: true },
    { name: 'prompt', type: 'string', description: 'Task prompt.', required: true, updatable: true },
    { name: 'script', type: 'string', description: 'Optional pre-task bash script.', updatable: true },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List live tasks with per-series run history (schedule, runs, failures, next fire).',
      args: [
        { name: 'status', type: 'string', description: 'Filter by live state.', enum: ['pending', 'paused'] },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
        {
          name: 'all',
          type: 'boolean',
          description: 'List across all groups (host default when no --group; accepted for explicitness).',
        },
      ],
      handler: async (args, ctx) => listTasks(args, ctx),
      // Server-rendered run-history table (frame `human` field) — the container
      // agent gets the same legible view as the host CLI without a Bun-side
      // formatter copy.
      formatHuman: (rows) => formatTasksTable(rows as Parameters<typeof formatTasksTable>[0]),
    },
    get: {
      access: 'open',
      description: 'Get a task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
        {
          name: 'settlement',
          type: 'boolean',
          description: 'Include host-owned execution/outcome settlement facts; unknown must defer.',
        },
        {
          name: 'observer_settlement',
          type: 'boolean',
          description:
            'Legacy recurring observer cutover: exclude only its own future inert recurrence; all owned follow-ups still block.',
        },
        {
          name: 'future_inputs_settled',
          type: 'boolean',
          description:
            'Observer whose follow-ups are separate episodes: count not-yet-due pending inputs (future waits) instead of blocking on them; due, paused and processing inputs still block.',
        },
      ],
      handler: async (args, ctx) => getTask(args, ctx),
    },
    dispatch: {
      access: 'open',
      description:
        'Admit an immediate event exactly once within an isolated context. Identical retries return the original admission; changed content or routing rejects. New context keys create fresh sessions. Admission is not successful work. Retain rows/sessions while keys can replay; manual deletion invalidates dedupe. Only failed or expired events may recover, at most twice, using --retry-of.',
      args: [
        {
          name: 'context_key',
          type: 'string',
          required: true,
          description: 'Stable bounded phase or observation key.',
        },
        { name: 'event_key', type: 'string', required: true, description: 'Stable event key within this context.' },
        {
          name: 'retry_of',
          type: 'string',
          description: 'Failed or expired predecessor event key; never use for a completed event.',
        },
        {
          name: 'prompt',
          type: 'string',
          required: true,
          description: 'Bounded current brief, up to 64000 characters.',
        },
        {
          name: 'group',
          type: 'string',
          description: 'Host target group; agent callers are scoped to their own group.',
        },
        { name: 'thread', type: 'boolean', description: 'Bind the calling agent session thread.' },
        { name: 'isolated', type: 'boolean', description: 'No implicit output destination.' },
        { name: 'mute_chat', type: 'boolean', description: 'Disable chat sends for internal phases.' },
        { name: 'quiet_status', type: 'boolean', description: 'Disable streaming status posts.' },
        { name: 'messaging_group', type: 'string', description: 'Host-only output messaging group.' },
        { name: 'thread_id', type: 'string', description: 'Host-only output thread, with --messaging-group.' },
      ],
      handler: async (args, ctx) => dispatchTask(args, ctx),
    },
    create: {
      access: 'open',
      description:
        `Create a scheduled task (recurring or one-shot) in the agent group system session.\n\n` +
        `Requires --prompt plus EITHER --recurrence (recurring; first run derived from the cron grid) OR --process-after (one-shot, ISO 8601 or naive wall-clock in the group's timezone). Always pass --name for a readable id.\n\n` +
        `Workflow default: use --script for deterministic polling and observation; wake for meaningful changes or due unfinished/recovery work. Time-driven reasoning, requested reports and full campaigns may run directly; record why in the prompt. Check active tasks for overlapping owner, purpose and schedule before creating a series.\n\n` +
        `--script contract (pre-task gate, runs BEFORE the agent wakes):\n` +
        `  bash, 120s default timeout (NANOCLAW_TASK_SCRIPT_TIMEOUT_MS override), 1MB output cap. Its LAST stdout line must be JSON:\n` +
        `    {"wakeAgent": false, "observation": {"kind": ..., "evidence": ..., "bound": "4h", "since"?: ...}, "data": {...}}\n` +
        `    {"wakeAgent": true, "data": {...}}\n` +
        `  wakeAgent=false handles the run without waking the agent (zero tokens) and declares what it saw: kind empty (nothing to do), unreadable, blocked, or unfinished (with since, ISO-8601, when the open work started); evidence is non-empty; bound (90m|4h|2d) is how long a result other than empty may stand before the operator is told.\n` +
        `  Print that line with the task-observation skill's helper, which escapes the JSON and refuses an invalid observation: /app/skills/task-observation/task_observation.py in a container; a --script-host script runs on the host, where /app does not exist, and uses ${path.join(REPO_ROOT, 'container/skills/task-observation/task_observation.py')}.\n` +
        `  wakeAgent=true wakes the agent with data attached to the prompt.\n` +
        `  DO: print the JSON as the very last line, exit 0, keep data small (a summary, not a dump).\n` +
        `  DON'T: print anything after the JSON, prompt for input, or rely on an earlier process's memory or temporary files.\n` +
        `  Always test with bash -c '<script>' before scheduling.\n` +
        `  Persist state between fires under the group workspace. Keep discovered/pending work separate from completed acknowledgements: only acknowledge after the required outcome is verified, so a failed turn remains retryable.\n` +
        `  Use good judgement on whether to share with the user the script (only if they are technical), a description of the script condition, or whether there's no need.\n\n` +
        `Frequency limit: recurrences more frequent than ${MAX_DAILY_FIRES} fires/day are refused unless the task\n` +
        `carries a --script gate (the script decides whether each fire needs you — a gated fire that\n` +
        `finds nothing costs zero tokens) or you pass --dangerously-override-recurrence-limit after\n` +
        `the user explicitly confirmed they want an ungated frequent task.\n\n` +
        `Failure backoff: a script that ERRORS repeatedly backs the series off (2,4,8,…60 min between fires; each errored fire counts as a failed run); after 8 consecutive failures the series is auto-paused with a note in its run log — fix the script, then \`ncl tasks resume <id>\`. A wakeAgent=false run never backs off, but only an empty observation (or a wake) is a success: consecutive unreadable/blocked/unfinished/error/invalid/undeclared (no observation) results past their bound page the operator once. \`ncl tasks get <id>\` shows failed_runs and the run log.\n\n` +
        `Routing (where an unaddressed reply lands): an agent caller stamps its own channel by default (thread null) — a normal reply with no explicit destination lands there; --thread also binds your own thread (falls back to channel if you aren't in a thread session); --isolated stamps no routing (unaddressed replies are discarded, only an explicit <message to=...> reaches anyone). --messaging-group/--thread-id are host-only raw stamps.`,
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Short descriptive name → readable task id (<slug>-<hex>). Without it, ids are t-<hex>.',
        },
        { name: 'prompt', type: 'string', description: 'Task prompt the agent wakes to.', required: true },
        {
          name: 'recurrence',
          type: 'string',
          description:
            'Cron expression (instance TZ). First run derives from the cron grid when --process-after is omitted.',
        },
        {
          name: 'dangerously_override_recurrence_limit',
          type: 'boolean',
          description:
            'Schedule more than 4 fires/day anyway. Only after the user explicitly confirmed they understand the quota/token cost and you agree it is right.',
        },
        {
          name: 'process_after',
          type: 'string',
          description:
            "First/next run time (ISO 8601, or naive wall-clock read in the owning group's timezone). Required for one-shots.",
        },
        {
          name: 'script',
          type: 'string',
          description: 'Pre-task gate script (bash) — see the --script contract above.',
        },
        {
          name: 'script_host',
          type: 'boolean',
          description:
            'Run --script on the host at fire time instead of in the container — a gated (wakeAgent=false) fire skips the container boot entirely. Requires --script. Only classifier-clean scripts actually run host-side; anything the classifier flags (destructive filesystem ops, destructive SQL/cloud/infra commands) transparently falls back to the normal container execution for that fire.',
        },
        {
          name: 'thread_anchor',
          type: 'boolean',
          description:
            "false = this series' channel posts are never glued into a rolling day-thread. Use for one-thread-per-item series (a new root per smoke run / ticket / incident). Default true: consecutive posts within a UTC day thread under one anchor.",
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        {
          name: 'thread',
          type: 'boolean',
          description:
            'Agent callers only: also bind the calling session\'s own thread (parity with the legacy scope:"thread"). Falls back to channel-only if the caller is not a thread session.',
        },
        {
          name: 'isolated',
          type: 'boolean',
          description: 'Stamp no routing — an unaddressed reply is discarded; only an explicit send reaches anyone.',
        },
        {
          name: 'mute_chat',
          type: 'boolean',
          description:
            'Physically disable chat sends from this task — the agent-runner drops them at the write layer. For tasks whose contract is file/board output only (e.g. a watcher).',
        },
        {
          name: 'chat_limit',
          type: 'string',
          description:
            'Max chat sends per turn, enforced by the agent-runner at the write layer (e.g. 1 for a digest task — extra work-log messages are dropped). Omit for unlimited.',
        },
        {
          name: 'quiet_status',
          type: 'boolean',
          description:
            'Suppress streaming status/thinking posts while preserving final chat sends. Use with --chat-limit for one-message scheduled orchestrators.',
        },
        {
          name: 'continuous',
          type: 'boolean',
          description:
            'Resume one conversation across fires. Default: each scheduled fire starts fresh, thread-bound or not. Use only when a fire relies on what earlier fires said, not on files or task state.',
        },
        {
          name: 'messaging_group',
          type: 'string',
          description: 'Host-only: stamp routing to this messaging group id (rejected from an agent caller).',
        },
        {
          name: 'thread_id',
          type: 'string',
          description: 'Host-only: raw thread id, paired with --messaging-group (rejected from an agent caller).',
        },
        {
          name: 'model',
          type: 'string',
          description: "Per-fire model pin, validated against the agent group's provider vocabulary.",
        },
        {
          name: 'effort',
          type: 'string',
          description: "Per-fire effort pin, validated against the agent group's provider vocabulary.",
        },
      ],
      examples: [
        `# Recurring — --recurrence alone is enough; the first run comes off the cron grid:\nncl tasks create --name "sales briefing" --prompt "Send the weekday sales briefing" --recurrence "0 9 * * 1-5"`,
        `# One-shot — --process-after required (UTC, offset, or naive-local in the instance TZ):\nncl tasks create --name "ping" --prompt "Remind me to call Dana" --process-after "tomorrow 18:00"`,
        `# Monitor — script gates the run; the agent wakes only when something matters:\nncl tasks create --name "alert watch" --recurrence "*/15 * * * *" \\\n  --prompt "Investigate the alerts in the script data and notify me if serious" \\\n  --script 'set -o pipefail\nH=/app/skills/task-observation/task_observation.py\nc=$(curl -sf https://example.com/api/alerts | jq -e length) || { python3 "$H" --kind unreadable --evidence "alerts API unreadable" --bound 1h; exit 0; }\nif [ "$c" -gt 0 ]; then python3 "$H" --wake --data "{\\"alerts\\": $c}"; else python3 "$H" --kind empty --evidence "0 alerts" --bound 1h; fi'`,
      ],
      handler: async (args, ctx) => createTask(args, ctx),
    },
    'append-log': {
      access: 'open',
      description:
        'Append a one-line note to a task run log (tasks/<id>.md).\n\nOptional: every task run auto-logs its final text, so use this only for additive mid-run notes. The host stamps the local timestamp; you supply --msg. This is a LOG ENTRY, not a message — it sends nothing to anyone. Inside a task run --id is auto-derived from your session.',
      examples: [
        `# Inside a task run (--id auto-derived) — optional progress note:\nncl tasks append-log --msg "one feed returned 403; continuing with the remaining feeds"`,
      ],
      args: [
        {
          name: 'msg',
          type: 'string',
          description:
            'Your work-log entry: what you did and why it mattered (like a human work log). The host prepends the local timestamp; this is logged, never sent to the user.',
          required: true,
        },
        {
          name: 'id',
          type: 'string',
          description: 'Task series id. Auto-derived when called from inside a task run; required otherwise.',
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
      ],
      handler: async (args, ctx) => appendTaskLog(args, ctx),
    },
    move: {
      access: 'open',
      hostOnly: true,
      description:
        'Move one live task series to a wired target agent group without changing its series identity. OPERATOR-ONLY.\n\n' +
        'This is the CLI entry point for the same cancel-first, durable-intent, compensating move transaction used by the Scheduled Tasks Board. It preserves the occurrence slot, recurrence, task controls, pins, routing and audit trail; it refuses a busy source, unreadable state, invalid destination pin, or a target series collision.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        { name: 'group', type: 'string', description: 'Source agent group id.', required: true },
        { name: 'session', type: 'string', description: 'Exact source task session id.', required: true },
        { name: 'target_group', type: 'string', description: 'Destination agent group id.', required: true },
        {
          name: 'target_messaging_group',
          type: 'string',
          description: 'Destination messaging group id already wired to --target-group.',
          required: true,
        },
      ],
      handler: async (args, ctx) => moveTaskCommand(args, ctx),
    },
    update: {
      access: 'open',
      description: 'Update a live task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        { name: 'prompt', type: 'string', description: 'Replace the task prompt.' },
        {
          name: 'process_after',
          type: 'string',
          description: "New next-run time (ISO 8601, or naive wall-clock read in the owning group's timezone).",
        },
        {
          name: 'chat_limit',
          type: 'string',
          description: 'Max chat sends per turn (agent-runner enforced). 0 = mute.',
        },
        {
          name: 'quiet_status',
          type: 'boolean',
          description: 'Enable or disable streaming status suppression without muting final chat sends.',
        },
        {
          name: 'continuous',
          type: 'boolean',
          description: 'true = fires resume one conversation; false = each scheduled fire starts fresh (the default).',
        },
        { name: 'recurrence', type: 'string', description: 'New cron expression; "null"/"none" clears it (one-shot).' },
        {
          name: 'dangerously_override_recurrence_limit',
          type: 'boolean',
          description:
            'Schedule more than 4 fires/day anyway. Only after the user explicitly confirmed they understand the quota/token cost and you agree it is right.',
        },
        { name: 'script', type: 'string', description: 'New pre-task script; "null"/"none" removes it.' },
        {
          name: 'script_host',
          type: 'boolean',
          description:
            'Run --script on the host at fire time instead of in the container. Requires the task to have --script set.',
        },
        {
          name: 'thread_anchor',
          type: 'boolean',
          description:
            "false = this series' channel posts are never glued into a rolling day-thread (one-thread-per-item series).",
        },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
        {
          name: 'model',
          type: 'string',
          description:
            'Per-fire model pin, validated against the agent group\'s provider vocabulary. ""/"null"/"none" clears it, so the series falls back to the group\'s own model. Needs --group either way (auto-filled inside a container): series ids are unique within a group, not fleet-wide.',
        },
        {
          name: 'effort',
          type: 'string',
          description:
            'Per-fire effort pin, validated against the agent group\'s provider vocabulary. ""/"null"/"none" clears it. Needs --group either way.',
        },
      ],
      handler: async (args, ctx) => updateTaskCommand(args, ctx),
    },
    repin: {
      access: 'approval',
      // Host-only: a wrong --from-model would hit every armed series in view, and no scheduled fire needs it.
      hostOnly: true,
      description:
        'Retarget per-fire model/effort pins in bulk (e.g. move everything pinned to one model onto its successor). OPERATOR-ONLY.\n\n' +
        'Matching is LITERAL: --from-model sonnet matches only pins stored as "sonnet", not "claude-sonnet-5". That is deliberate — the family alias tracks the install default across future bumps while the frozen id does not, so rewriting one is not the same act as rewriting the other. --match-resolved unifies them; either way the report lists near-misses (same resolved model, different literal pin) so a literal run never reads as exhaustive.\n\n' +
        'Matching is also by VALUE, so several series in a group share a pin. --series-id narrows a run to one of them. To take a series OFF a pin entirely rather than onto another, use `ncl tasks update --model "" --effort ""`.\n\n' +
        "Every match is validated against its own group's provider BEFORE the first write, and one invalid target aborts the whole run — a half-applied bulk re-pin is worse than none. --skip-invalid applies the valid subset instead.\n\n" +
        'Re-pinning AHEAD of a provider migration needs --target-provider: pins are otherwise validated against the provider the group still has, which would reject every correct new value. That is the supported path out of a `groups config update --provider` refusal.\n\n' +
        'Always --dry-run first.',
      args: [
        {
          name: 'from_model',
          type: 'string',
          description: 'Match series whose stored model pin is exactly this (see --match-resolved).',
        },
        { name: 'to_model', type: 'string', description: 'New model pin. Requires --from-model.' },
        {
          name: 'from_effort',
          type: 'string',
          description: 'Match series whose stored effort pin is exactly this (case-insensitive).',
        },
        { name: 'to_effort', type: 'string', description: 'New effort pin. Requires --from-effort.' },
        {
          name: 'match_resolved',
          type: 'boolean',
          description:
            'Also match pins that resolve to the same model (unifies the family alias "opus" with the frozen id it currently resolves to, e.g. "claude-opus-5-5[1m]"). Off by default: it converts a floating pin into a frozen one.',
        },
        {
          name: 'target_provider',
          type: 'string',
          description:
            "Validate the new pins against this provider instead of each group's current one. Use when re-pinning ahead of a `groups config update --provider` migration.",
          enum: ['claude', 'codex', 'opencode'],
        },
        {
          name: 'dry_run',
          type: 'boolean',
          description: 'Report what WOULD change (and what would be rejected) without writing anything.',
        },
        {
          name: 'skip_invalid',
          type: 'boolean',
          description: 'Apply the valid subset instead of refusing the whole run when some targets are invalid.',
        },
        { name: 'group', type: 'string', description: 'Limit to one agent group id.' },
        { name: 'all', type: 'boolean', description: 'Run fleet-wide across every group (required without --group).' },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
        {
          name: 'series_id',
          type: 'string',
          description:
            'Limit to ONE series inside the chosen scope. Narrows the --from-* match, it does not replace it; still needs --group, --session or --all. Refuses if no such series is in scope, and refuses as ambiguous if the id names a series in more than one session (ids are unique within a group, not fleet-wide).',
        },
      ],
      examples: [
        `# See what a model bump would touch, fleet-wide, before touching anything:\nncl tasks repin --all --from-model claude-opus-5[1m] --to-model claude-opus-5-5[1m] --dry-run`,
        `# Fix an effort pin the target provider does not have (claude/codex xhigh -> opencode high):\nncl tasks repin --group ag-123 --target-provider opencode --from-effort xhigh --to-effort high`,
        `# Clear the way for a codex -> claude migration, then run the switch:\nncl tasks repin --group ag-123 --target-provider claude --from-model gpt-6-astra --to-model claude-sonnet-5`,
        `# Move ONE series off a pin several series share:\nncl tasks repin --group ag-123 --series-id task-abc --from-model sonnet --to-model opus --dry-run`,
      ],
      handler: async (args, ctx) => repinTasks(args, ctx),
    },
    cancel: {
      access: 'open',
      description: 'Cancel a live task by series id, or use --all as a kill switch.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id (omit with --all).' },
        { name: 'all', type: 'boolean', description: 'Cancel every live task in scope — kill switch.' },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => cancelTaskCommand(args, ctx),
    },
    run: {
      access: 'open',
      description:
        'Fire a task now without changing its schedule (queues an extra run due immediately). Safe for testing — unlike update --process-after now, it neither consumes a one-shot nor advances a recurring series.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => runTaskCommand(args, ctx),
    },
    pause: {
      access: 'open',
      description: 'Pause a pending task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => mutateTask(args, ctx, 'pause', (mailbox, id) => mailbox.pauseTask(id)),
    },
    resume: {
      access: 'open',
      description: 'Resume a paused task by series id.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => mutateTask(args, ctx, 'resume', (mailbox, id) => mailbox.resumeTask(id)),
    },
    delete: {
      access: 'open',
      description: 'Hard-delete a task series and its history.',
      args: [
        { name: 'id', type: 'string', description: 'Task series id.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id (host callers; auto-filled to your own group inside a container).',
        },
        { name: 'session', type: 'string', description: 'Limit to one task session id.' },
      ],
      handler: async (args, ctx) => mutateTask(args, ctx, 'delete', (mailbox, id) => mailbox.deleteTask(id)),
    },
  },
});
