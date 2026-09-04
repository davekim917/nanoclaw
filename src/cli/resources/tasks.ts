import fs from 'fs';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  findTaskSessions,
  getActiveSessions,
  getSession,
  isTaskThread,
  TASKS_SYSTEM_THREAD_ID,
  withQuietInvalidationSync,
} from '../../db/sessions.js';
import { type TaskUpdate } from '../../modules/scheduling/db.js';
import type { CliTaskRow, NanoclawMailboxSession } from '../../modules/mailbox/index.js';
import {
  enforceRecurrenceLimit,
  makeTaskId,
  MAX_DAILY_FIRES,
  parseProcessAfter,
  validateRecurrence,
} from '../../modules/scheduling/create.js';
import { resolveTaskFlagIntent } from '../../modules/scheduling/task-flags.js';
import { writeAudit } from '../../dashboard/api/scheduled-shared.js';
import { resolveTaskSession, withExistingMailboxSession } from '../../session-manager.js';
import { registerResource } from '../crud.js';
import { appendRunLog } from '../../modules/scheduling/run-log.js';
import { formatTasksTable } from '../format-tasks.js';
import type { CallerContext } from '../frame.js';

type TaskStatus = 'pending' | 'paused';

/** The board row shape is the mailbox module's — this file no longer selects it. */
type TaskRow = CliTaskRow;

/** Routing a task series posts to on fire; all-null means unaddressed output is discarded. */
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

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

/**
 * scheduled_audit actor string — the best identity CallerContext actually
 * carries. Neither transport threads a human user_id through to the CLI
 * dispatch layer (the host socket's auth boundary is the 0600 socket file
 * itself, socket-server.ts; an agent caller is identified by its own group),
 * so unlike the dashboard's `ctx.user.id`, "host" and "agent:<group>" are all
 * that's available here — never invented.
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
  return str(args.group) ?? str(args.agent_group_id);
}

function ownSession(sessionId: string, ctx: CallerContext): ScopedSession {
  const session = getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId) {
    throw new Error(`session not found: ${sessionId}`);
  }
  return { id: session.id, agent_group_id: session.agent_group_id };
}

function selectedSessions(args: Record<string, unknown>, ctx: CallerContext): ScopedSession[] {
  const sessionId = str(args.session);
  if (sessionId) return [ownSession(sessionId, ctx)];

  const group = groupArg(args, ctx);
  if (group) {
    // One session per live task series — the loops below already fan out across them.
    return findTaskSessions(group).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id }));
  }

  if (ctx.caller === 'agent') return [];
  return getActiveSessions().map((s) => ({ id: s.id, agent_group_id: s.agent_group_id }));
}

/**
 * Run one CLI operation against a task session's mailbox.
 *
 * Existing-only (invariant I-10): `ncl tasks` fans out across every session
 * the caller can see, and listing or mutating one must never be what creates
 * a mailbox. `undefined` is "this session has none", which every call site
 * below already treats as "nothing here".
 */
function withInbound<T>(session: ScopedSession, fn: (mailbox: NanoclawMailboxSession) => T): Promise<T | undefined> {
  return withExistingMailboxSession(session.agent_group_id, session.id, fn);
}

/**
 * ── Quiet-mark invalidation in this file: PROBE FIRST, then bracket ──
 *
 * Every mutating command below writes due-ness straight into the session DB,
 * where the host sweep's quiet cache cannot see it, so each write is bracketed
 * by `withQuietInvalidationSync` — fail-closed before it, advisory after (see
 * that helper). A swallowed central-DB failure would leave the row hidden
 * behind a mark nothing clears until `QUIET_SESSION_BACKOFF_MS` expires, past a
 * warmed restart, since S2-PR15 persists the mark.
 *
 * The bracket goes INSIDE the mailbox action, after the action's own read, not
 * around `withInbound`. These commands fan out across every session the caller
 * can see (`selectedSessions`) and typically one holds the series, so wrapping
 * the open would charge 2N central-DB writes and N spurious sweeps for one
 * mutation. Each site instead asks its already-open handle whether this session
 * holds the target row and returns 0 when it does not — no invalidation, no
 * write. `getCliTaskRow(id)` is the probe for the per-series verbs, and it is a
 * strict SUPERSET of what they can touch: it matches
 * `(id = ? OR series_id = ?) AND kind = 'task'` at any status, while
 * pause/resume/cancel/update/delete all add a status filter to that same
 * predicate (src/mailbox/sqlite/tasks.ts:44-101). A miss therefore proves the
 * write would match nothing. Cancel-all probes with `listCliTaskSeries()`,
 * whose pending/paused set is exactly what `cancelAllTasks` updates.
 *
 * Inside the action there is also no `await` between the invalidation and the
 * write, so no sweep tick can interleave between them at all.
 *
 * Reads (`list`, `show`) never invalidate.
 */

function parseContent(raw: string): {
  prompt: string;
  script: string | null;
  scriptHost: boolean;
  threadAnchor: boolean;
  originSessionId: string | null;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      script: typeof parsed.script === 'string' ? parsed.script : null,
      scriptHost: parsed.scriptHost === true,
      threadAnchor: parsed.threadAnchor !== false,
      originSessionId: typeof parsed.originSessionId === 'string' ? parsed.originSessionId : null,
    };
  } catch {
    // LEGACY-COMPAT(v1-tasks): plain-string content from rows that predate the
    // JSON envelope. Removable once no pre-v2 session DBs remain in the wild.
    return { prompt: raw, script: null, scriptHost: false, threadAnchor: true, originSessionId: null };
  }
}

function toOutput(session: ScopedSession, row: TaskRow) {
  const content = parseContent(row.content);
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
    origin_session_id: content.originSessionId, // which session created the task (null for CLI-created)
    created_at: row.timestamp,
    tries: row.tries,
    // Where an unaddressed reply lands on fire; null = discarded (isolated).
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
 * Resolve the routing a new task series stamps, host-authoritatively.
 *
 * Agent callers derive routing from their OWN session (never agent-supplied
 * ids — the cross-tenant leak class actions.ts's header warns about): default
 * stamps the session's channel (thread null); `--thread` additionally binds
 * the session's own thread (falls back to channel-only, with a note, if the
 * caller isn't a thread session); `--isolated` or a session with no
 * messaging group stamps nothing. `--messaging-group`/`--thread-id` are
 * host-only raw stamps and are rejected outright from an agent caller.
 *
 * Host callers get no implicit stamp — routing only via the host-only flags.
 */
function resolveTaskRouting(
  args: Record<string, unknown>,
  ctx: CallerContext,
): { routing: TaskRouting; note?: string } {
  const messagingGroupArg = str(args.messaging_group);
  const threadIdArg = str(args.thread_id);

  if (ctx.caller === 'agent') {
    if (messagingGroupArg !== undefined || threadIdArg !== undefined) {
      throw new Error('--messaging-group / --thread-id are host-only; an agent cannot set raw routing');
    }
    if (bool(args.isolated)) return { routing: NO_ROUTING };

    const callingSession = getSession(ctx.sessionId);
    if (!callingSession?.messaging_group_id) return { routing: NO_ROUTING };

    const mg = getMessagingGroup(callingSession.messaging_group_id);
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

  // Host caller: no implicit stamp — routing only via the explicit flags below.
  if (threadIdArg !== undefined && messagingGroupArg === undefined) {
    throw new Error('--thread-id requires --messaging-group');
  }
  if (messagingGroupArg === undefined) return { routing: NO_ROUTING };
  const mg = getMessagingGroup(messagingGroupArg);
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
  // Host execution is opt-in by a HOST OPERATOR only. The host-side classifier
  // (classifyForHostExecution) is a regex subset, not a sandbox — for
  // agent-authored script text the trust boundary has to be who set the flag,
  // not what the script looks like.
  if (scriptHost && ctx.caller === 'agent') {
    throw new Error('--script-host runs the script on the host and can only be set by a host operator');
  }
  // Wall-clock fields (--process-after, the cron grid) are interpreted in the
  // owning group's timezone, not the install's.
  const tz = resolveGroupTimezone(group);
  validateRecurrence(recurrence, tz);
  enforceRecurrenceLimit(recurrence, bool(args.dangerously_override_recurrence_limit), script != null, tz);
  const processAfter = firstRunIso(args.process_after, recurrence, tz);
  const id = makeTaskId(args.name);
  const originSessionId = ctx.caller === 'agent' ? ctx.sessionId : null;
  const { routing, note: routingNote } = resolveTaskRouting(args, ctx);
  const { flagIntent, error: flagError } = resolveTaskFlagIntent(
    { model: str(args.model), effort: str(args.effort) },
    { agent_group_id: group },
  );
  if (flagError) throw new Error(flagError);

  // Each series runs in its own isolated session. Delivery and run-log
  // instructions come from the runtime system prompt, not persisted prompt
  // suffixes; the formatter strips old generated suffixes for compatibility.
  // `routing.platformId` is stamped onto the session as well as the task row:
  // same value, two readers. The row is what the fire path uses; the session
  // column is what the console reads to place a task in the channel it is
  // routed to (migration 056). NO_ROUTING passes null and stamps nothing.
  const { session } = resolveTaskSession(group, id, routing.platformId);

  const created = await withInbound(session, (mailbox) =>
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
          // Physical send suppression, enforced by the agent-runner: chat-kind
          // outbound writes are dropped for tasks carrying muteChat.
          ...(bool(args.mute_chat) ? { muteChat: true } : {}),
          // Streaming status is useful interactively but noisy for scheduled
          // orchestrators that publish one consolidated channel message.
          ...(bool(args.quiet_status) ? { quietStatus: true } : {}),
          // Per-turn chat send budget (e.g. 1 for a standup whose contract is
          // one digest post — trailing work-log messages get dropped).
          ...(chatLimitArg(args) !== undefined ? { chatLimit: chatLimitArg(args) } : {}),
        }),
      });
      return mailbox.getCliTaskRow(id);
    }),
  );
  if (!created) throw new Error('task system session inbound.db not found');
  writeAudit(getDb(), {
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

/**
 * Append one host-timestamped line to a task's run log
 * (`<GROUPS_DIR>/<folder>/tasks/<series>.md`). This is NOT a delivery — it writes
 * nothing to messages_out; it just records what happened so the agent (and human)
 * can see when and why each run happened. Inside a task run the series is derived from
 * the caller's own task session, so the agent supplies only --msg.
 */
function appendTaskLog(
  args: Record<string, unknown>,
  ctx: CallerContext,
): { series: string; timestamp: string; path: string; ok: true } {
  const msg = str(args.msg);
  if (!msg) throw new Error('--msg is required');

  let series = str(args.id);
  let group = groupArg(args, ctx);
  if (!series && ctx.caller === 'agent' && ctx.sessionId) {
    const sess = getSession(ctx.sessionId);
    if (sess && sess.thread_id && isTaskThread(sess.thread_id)) {
      series = sess.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
      group ??= sess.agent_group_id;
    }
  }
  if (!series) throw new Error('--id is required (no task session to derive it from)');
  if (!group) throw new Error('could not resolve the agent group');

  // Group scope is enforced by groupArg (a cli_scope=group caller can only
  // ever resolve its own folder), so a foreign id at worst writes a stray log
  // under the caller's OWN folder — no leak. appendRunLog guards the charset.
  return { ...appendRunLog(group, series, msg), ok: true };
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
  // Upstream's own op, not a fork copy of the same SELECT (invariant I-2). It
  // normalizes `lastRun` through Date.parse, which is a no-op for the ISO
  // timestamps this fork writes and repairs a naive legacy one.
  const stats = mailbox.getTaskStats(seriesKey);
  return { runs: stats.runs, last_run: stats.lastRun, failed_runs: stats.failedRuns };
}

/** Last ~10 lines of a series' run log (`tasks/<series>.md`), newest last. */
function tailRunLog(agentGroupId: string, seriesKey: string, lines = 10): string[] {
  const ag = getAgentGroup(agentGroupId);
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
  for (const session of selectedSessions(args, ctx)) {
    const sessionRows = await withInbound(session, (mailbox) =>
      mailbox.listCliTaskSeries(status).map((row) => enrichListRow(mailbox, toOutput(session, row))),
    );
    if (sessionRows) rows.push(...sessionRows);
  }
  return rows;
}

async function getTask(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of selectedSessions(args, ctx)) {
    const found = await withInbound(session, (mailbox) => {
      const row = mailbox.getCliTaskRow(id);
      if (!row) return undefined;
      const seriesKey = row.series_id ?? row.row_id;
      const stats = seriesStats(mailbox, seriesKey);
      const content = parseContent(row.content);
      return {
        ...toOutput(session, row),
        prompt: content.prompt,
        script: content.script,
        origin_session_id: content.originSessionId,
        completed_runs: stats.runs,
        failed_runs: stats.failed_runs,
        recent_log: tailRunLog(session.agent_group_id, seriesKey),
      };
    });
    if (found) return found;
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
  for (const session of selectedSessions(args, ctx)) {
    const n =
      (await withInbound(session, (mailbox) => {
        // Probe (see the seam note above): no task row for this id/series here
        // means every verb's UPDATE/DELETE matches nothing, so this session is
        // owed neither a write nor an invalidation.
        if (!mailbox.getCliTaskRow(id)) return 0;
        return withQuietInvalidationSync(session.id, () => fn(mailbox, id));
      })) ?? 0;
    if (n > 0) {
      // No before/after body: pause/resume/delete/cancel don't touch the
      // prompt, matching the dashboard's own pause/resume/cancel audit rows
      // (scheduled-mutations.ts) — a status-only change is the "after" here.
      writeAudit(getDb(), {
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
    // `create` refuses an empty prompt (`--prompt is required`); `update` must
    // too. A shell substitution over a missing file (`--prompt "$(cat gone.md)"`)
    // otherwise blanks a live series in place, and every later occurrence wakes
    // the agent with no instruction at all — a recurring series quietly turns
    // into a recurring no-op that still burns a container spawn. Whitespace is
    // treated as empty for the same reason `create` does.
    if (!args.prompt.trim()) throw new Error('--prompt must not be empty; omit it to keep the current prompt');
    update.prompt = args.prompt;
  }
  if (chatLimitArg(args) !== undefined) update.chatLimit = chatLimitArg(args);
  if (args.quiet_status !== undefined) update.quietStatus = bool(args.quiet_status);
  const recurrence = normalizeNullableString(args.recurrence);
  const script = normalizeNullableString(args.script);

  // An unscoped host `tasks update` fans out across every active session,
  // which can span groups with different timezone overrides. There is no
  // representative zone here: the persisted instant differs per group, and so
  // does the recurrence ceiling, which counts fires in a rolling 24h window —
  // a cron whose fires cluster on one weekday can be past that window in one
  // zone and still inside it in another. So EVERY matched session validates in
  // its own zone, and all of that happens before the first write.
  //
  // codex: getCliTaskRow() prioritizes a live row but falls back to terminal
  // (completed/cancelled) history when a session has none — right for getTask
  // and the audit before/after lookups below, which want that history, but
  // WRONG here: updateTask() only ever mutates pending/paused rows, so a
  // terminal row can never be one of the writes this validates for. Left
  // unfiltered, a live series edited in one session can be rejected by a
  // same-id terminal row's stale script/timezone in a different one. Require
  // live status at the one place `matched` is built, rather than in
  // getCliTaskRow() itself, which other callers rely on for terminal history.
  //
  // Sequential, not a `Promise.all` fan-out: each iteration opens one
  // session's mailbox and closes it before the next, exactly as the raw open
  // this replaced did.
  const matched: { session: ScopedSession; row: TaskRow }[] = [];
  for (const session of selectedSessions(args, ctx)) {
    const row = await withInbound(session, (mailbox) => mailbox.getCliTaskRow(id));
    if (row && (row.status === 'pending' || row.status === 'paused')) matched.push({ session, row });
  }

  const validationZones =
    matched.length > 0
      ? matched.map((m) => ({ tz: resolveGroupTimezone(m.session.agent_group_id), row: m.row }))
      : // Nothing matched: still validate the input shape so a typo is reported
        // as one, rather than as "no live task matched".
        [{ tz: TIMEZONE, row: undefined }];

  for (const { tz, row } of validationZones) {
    if (args.process_after !== undefined) parseProcessAfter(args.process_after, tz);
    if (recurrence !== undefined) {
      validateRecurrence(recurrence, tz);
      // Effective script AFTER this update: the new value when provided
      // (including an explicit clear), else whatever THIS task already has.
      const scriptAfter: string | null = script !== undefined ? script : row ? parseContent(row.content).script : null;
      enforceRecurrenceLimit(recurrence, bool(args.dangerously_override_recurrence_limit), scriptAfter != null, tz);
    }
  }
  if (recurrence !== undefined) update.recurrence = recurrence;

  // A new cron with the old armed timestamp fires off the new grid (or a day
  // late). Unless the caller pinned --process-after explicitly, re-derive the
  // next fire from the new expression — in the receiving group's zone.
  const rearmFromCron = recurrence !== undefined && recurrence !== null && args.process_after === undefined;
  const hasWallClockUpdate = args.process_after !== undefined || rearmFromCron;

  function wallClockUpdate(agentGroupId: string): TaskUpdate {
    if (!hasWallClockUpdate) return {};
    const tz = resolveGroupTimezone(agentGroupId);
    if (args.process_after !== undefined) return { processAfter: parseProcessAfter(args.process_after, tz) };
    return { processAfter: CronExpressionParser.parse(recurrence!, { tz }).next().toDate().toISOString() };
  }
  if (script !== undefined) update.script = script;
  if (args.script_host !== undefined) {
    const scriptHost = bool(args.script_host);
    // Same trust boundary as createTask: agents may clear the flag (execution
    // moves back to the container — strictly safer) but never set it.
    if (scriptHost && ctx.caller === 'agent') {
      throw new Error('--script-host runs the script on the host and can only be set by a host operator');
    }
    // ponytail: only catches the same-call clear (--script-host true --script none);
    // a scriptHost=true call that leaves an already-scriptless task alone is a
    // silent no-op in host-script.ts rather than a hard error — narrower check,
    // add the existing-row lookup (mirrors the scriptAfter derivation above) if
    // that gap ever bites in practice.
    if (scriptHost && script === null) throw new Error('--script-host requires --script');
    update.scriptHost = scriptHost;
  }
  if (args.thread_anchor !== undefined) update.threadAnchor = bool(args.thread_anchor);
  const model = str(args.model);
  const effort = str(args.effort);
  if (model !== undefined || effort !== undefined) {
    const group = groupArg(args, ctx);
    if (!group) throw new Error('--group is required to validate --model/--effort');
    const { flagIntent, error: flagError } = resolveTaskFlagIntent({ model, effort }, { agent_group_id: group });
    if (flagError) throw new Error(flagError);
    if (flagIntent && (flagIntent.turnModel || flagIntent.turnEffort)) update.flagIntent = flagIntent;
  }
  // `wallClockUpdate` contributes exactly one key when it contributes any, so
  // the reported field list is the same for every session even though the
  // instant behind `processAfter` differs per group.
  const fields = hasWallClockUpdate ? [...Object.keys(update), 'processAfter'] : Object.keys(update);
  if (fields.length === 0) throw new Error('nothing to update');

  let touched = 0;
  for (const { session } of matched) {
    // One value per session, and the ONLY one: what gets written is what gets
    // audited and what gets reported. Merging the per-session part at the
    // `updateTask` call while the audit kept reading the pre-merge object is
    // how a schedule-only update wrote a new instant and recorded nothing.
    const sessionUpdate: TaskUpdate = { ...update, ...wallClockUpdate(session.agent_group_id) };
    const result = await withInbound(session, (mailbox) => {
      const before = mailbox.getCliTaskRow(id);
      // The probe is free here: `before` is the same superset read the seam
      // note describes, and `updateTask` narrows it further still.
      if (!before) return { before, n: 0 };
      // Close the indirect path to host execution: an agent swapping the
      // script text on a series a host operator flagged scriptHost would get
      // its own script run on the host next fire. Unless the same call also
      // clears the flag, reject.
      if (
        ctx.caller === 'agent' &&
        sessionUpdate.script !== undefined &&
        sessionUpdate.scriptHost !== false &&
        before &&
        parseContent(before.content).scriptHost
      ) {
        throw new Error('this series runs its script on the host — an operator must make script changes');
      }
      // The recurrence ceiling is enforced AGAIN, here, against the row this
      // write will actually land on. The pre-pass above validates the input
      // shape and reports a typo before the first write — that part has to
      // stay ahead of the loop — but its script exemption was decided from a
      // row read in an EARLIER mailbox pass. Opening a mailbox yields, so
      // between the two passes another caller can clear the script that
      // exempted a `*/5 * * * *`, and the high-frequency recurrence lands on a
      // now-scriptless series. Re-deciding from `before`, with nothing awaited
      // between the read and the write, is what ties the exemption to the row
      // it exempts. The inverse ordering is covered too: a change that became
      // valid while this call was in flight is no longer rejected on a stale
      // read.
      if (recurrence !== undefined) {
        const scriptNow: string | null =
          script !== undefined ? script : before ? parseContent(before.content).script : null;
        enforceRecurrenceLimit(
          recurrence,
          bool(args.dangerously_override_recurrence_limit),
          scriptNow != null,
          resolveGroupTimezone(session.agent_group_id),
        );
      }
      const n = withQuietInvalidationSync(session.id, () => mailbox.updateTask(id, sessionUpdate));
      return { before, n };
    });
    if (!result) continue;
    const { before, n } = result;
    if (n > 0) {
      writeAudit(getDb(), {
        actor: actorFor(ctx),
        action: 'update',
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        seriesId: id,
        before: before ? parseContent(before.content).prompt : undefined,
        ...(sessionUpdate.prompt !== undefined ? { after: sessionUpdate.prompt } : {}),
        ...(sessionUpdate.script !== undefined && sessionUpdate.script !== null
          ? { scriptAfter: sessionUpdate.script }
          : {}),
        detail: {
          ...(sessionUpdate.recurrence !== undefined ? { recurrence: sessionUpdate.recurrence } : {}),
          ...(sessionUpdate.processAfter !== undefined ? { processAfter: sessionUpdate.processAfter } : {}),
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

  let touched = 0;
  for (const session of selectedSessions(args, ctx)) {
    const result = await withInbound(session, (mailbox) => {
      const seriesIds = mailbox.listCliTaskSeries().map((r) => r.series_id ?? r.row_id);
      // The listing is the probe: `listCliTaskSeries()` returns the
      // pending/paused set, which is exactly what cancel-all updates.
      if (seriesIds.length === 0) return { seriesIds, n: 0 };
      // Upstream's `cancelTask()` with no id IS cancel-all; there is one
      // statement behind both names (invariant I-2).
      return { seriesIds, n: withQuietInvalidationSync(session.id, () => mailbox.cancelTask()) };
    });
    if (!result) continue;
    if (result.n > 0) {
      for (const seriesId of result.seriesIds) {
        writeAudit(getDb(), {
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
 * `ncl tasks run <id>` — fire a task on demand without disturbing its schedule.
 * Inserts a fresh pending occurrence (same series, content, no recurrence) due
 * now, which the next sweep delivers through the normal fire path. Unlike
 * `update --process-after now`, it neither consumes a one-shot nor force-advances
 * a recurring series' armed occurrence, so it is safe for testing a task.
 */
async function runTaskCommand(args: Record<string, unknown>, ctx: CallerContext) {
  const id = taskId(args);
  for (const session of selectedSessions(args, ctx)) {
    const fired = await withInbound(session, (mailbox) => {
      const row = mailbox.getCliTaskRow(id);
      // The probe is free here too — no row, no fire, no invalidation.
      if (!row) return undefined;
      const seriesKey = row.series_id ?? row.row_id;
      const rowId = makeTaskId(`${seriesKey}-run`);
      // recurrence=NULL is load-bearing: a run-now row must not be re-armed by
      // handleRecurrence into a phantom series. Routing carries forward from
      // the source row — an on-demand fire reports to the same destination
      // the series is wired to.
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
    });
    if (fired) {
      writeAudit(getDb(), {
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
      ],
      handler: async (args, ctx) => getTask(args, ctx),
    },
    create: {
      access: 'open',
      description:
        `Create a scheduled task (recurring or one-shot) in the agent group system session.\n\n` +
        `Requires --prompt plus EITHER --recurrence (recurring; first run derived from the cron grid) OR --process-after (one-shot, ISO 8601 or naive wall-clock in the group's timezone). Always pass --name for a readable id.\n\n` +
        `--script contract (pre-task gate, runs BEFORE the agent wakes):\n` +
        `  bash, 30s timeout, 1MB output cap. Its LAST stdout line must be JSON:\n` +
        `    {"wakeAgent": <bool>, "data": {...}}\n` +
        `  wakeAgent=false marks the run handled without waking the agent (zero tokens);\n` +
        `  wakeAgent=true wakes the agent with data attached to the prompt.\n` +
        `  DO: print the JSON as the very last line, exit 0, keep data small (a summary, not a dump).\n` +
        `  DON'T: print anything after the JSON, prompt for input, or rely on state from previous runs.\n` +
        `  Always test with bash -c '<script>' before scheduling.\n` +
        `  Persist state between fires under the group workspace (e.g. a last-seen id file).\n` +
        `  Use good judgement on whether to share with the user the script (only if they are technical), a description of the script condition, or whether there's no need.\n\n` +
        `Frequency limit: recurrences more frequent than ${MAX_DAILY_FIRES} fires/day are refused unless the task\n` +
        `carries a --script gate (the script decides whether each fire needs you — a gated fire that\n` +
        `finds nothing costs zero tokens) or you pass --dangerously-override-recurrence-limit after\n` +
        `the user explicitly confirmed they want an ungated frequent task.\n\n` +
        `Failure backoff: a script that ERRORS repeatedly backs the series off (2,4,8,…60 min between fires; each errored fire counts as a failed run); after 8 consecutive failures the series is auto-paused with a note in its run log — fix the script, then \`ncl tasks resume <id>\`. A deliberate wakeAgent=false is a normal run and never backs off. \`ncl tasks get <id>\` shows failed_runs and the run log.\n\n` +
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
        `# Monitor — script gates the run; the agent wakes only when something matters:\nncl tasks create --name "alert watch" --recurrence "*/15 * * * *" \\\n  --prompt "Investigate the alerts in the script data and notify me if serious" \\\n  --script 'c=$(curl -sf https://example.com/api/alerts | jq length) || exit 0\necho "{\\"wakeAgent\\": $([ "$c" -gt 0 ] && echo true || echo false), \\"data\\": {\\"alerts\\": $c}}"'`,
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
          description: "Per-fire model pin, validated against the agent group's provider vocabulary.",
        },
        {
          name: 'effort',
          type: 'string',
          description: "Per-fire effort pin, validated against the agent group's provider vocabulary.",
        },
      ],
      handler: async (args, ctx) => updateTaskCommand(args, ctx),
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
