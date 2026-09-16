import fs from 'fs';

import { CronExpressionParser } from 'cron-parser';

import { GROUPS_DIR, TIMEZONE } from '../../config.js';
import { resolveGroupProvider, resolveGroupTimezone } from '../../container-config.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  findTaskSessions,
  getActiveSessions,
  getSession,
  taskSeriesId,
  withQuietInvalidationSync,
} from '../../db/sessions.js';
import { withCentralSync } from '../../db/central-lease.js';
import { type TaskUpdate } from '../../modules/scheduling/db.js';
import type { CliTaskRow, NanoclawMailboxSession } from '../../modules/mailbox/index.js';
import {
  enforceRecurrenceLimit,
  makeTaskId,
  MAX_DAILY_FIRES,
  parseProcessAfter,
  validateRecurrence,
} from '../../modules/scheduling/create.js';
import { resolveTaskFlagIntent, validateTaskPin } from '../../modules/scheduling/task-flags.js';
import { parseTaskContent, parseTaskPin } from '../../modules/scheduling/task-content.js';
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

/**
 * Read a flag the caller SUPPLIED, refusing a value that is not usable.
 *
 * `str()` collapses "absent" and "supplied but empty" into `undefined`. That
 * is the right answer when reading an optional value and the wrong one for the
 * scope guards below, which branch on presence: `--session "$SESS"` with an
 * unset variable arrives as `session: ''` (parse-argv.ts:29 keeps it), and a
 * presence test built on `str()` reads that as absent and skips — failing open
 * on exactly the input that makes the mistake likely, and doing it to a script
 * silently, every run. That is this file's own class one level down: the guard
 * drops an input the caller cannot see.
 *
 * The empty string is the shape that gets here, because `''` is a valid string
 * and passes argument validation. The value-less `--session` shape does not:
 * it parses to `true` and `validateArgs` already rejects it with "--session
 * requires a value" (crud.ts:523). The non-string branch below is therefore
 * defence in depth for callers that bypass validation, not a live hole.
 *
 * No flag guarded here has an empty string as a meaningful value, so refusing
 * one rejects nothing legitimate.
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
 * The one place every `ncl tasks` verb resolves its targets, so the scope
 * invariant lives here rather than in each of the eight callers.
 *
 * `--session` names a session by id and `--group` names the scope the operator
 * believes they are inside; a session id that is not in that scope means the
 * two disagree, and the command is not the one that was typed. Answering it
 * with the session's real group — `--group A --session <a session of B>` —
 * runs the verb against B: destructively for `cancel --all` and `delete`, as a
 * read leak for `list`/`get`. Rejecting is the only reading that cannot be
 * wrong, since either flag alone already expresses whichever one was meant.
 *
 * Agent callers never reach this check: `groupArg` pins them to their own
 * group, so `ownSession` above has already answered "session not found" for
 * anything outside it — deliberately refusing to confirm the id exists
 * elsewhere. Naming both groups here is a host-caller affordance, and the host
 * caller is unrestricted by construction, so it reveals nothing it could not
 * already read.
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
 * ── Quiet-mark invalidation in this file: PROBE FIRST, then invalidate ──
 *
 * Every mutating command below writes due-ness straight into the session DB,
 * where the host sweep's quiet cache cannot see it, so each write runs inside
 * `withQuietInvalidationSync`: ONE fail-closed invalidation, then the statement,
 * in the same synchronous turn (see that helper — there is no second call and
 * none is owed). A swallowed central-DB failure would leave the row hidden
 * behind a mark nothing clears until `QUIET_SESSION_BACKOFF_MS` expires, past a
 * warmed restart, since S2-PR15 persists the mark.
 *
 * The call goes INSIDE the mailbox action, after the action's own read, not
 * around `withInbound`. These commands fan out across every session the caller
 * can see (`selectedSessions`) and typically one holds the series, so wrapping
 * the open would charge N central-DB writes and N spurious sweeps for one
 * mutation — and would put the funnel's await between the invalidation and the
 * statement. Each site instead asks its already-open handle whether this session
 * holds the target row and returns 0 when it does not — no invalidation, no
 * write. `getCliTaskRow(id)` is the probe for the per-series verbs, and it is a
 * strict SUPERSET of what they can touch: it matches
 * `(id = ? OR series_id = ?) AND kind = 'task'` at any status, while
 * pause/resume/cancel/update/delete all add a status filter to that same
 * predicate (src/mailbox/sqlite/tasks.ts:44-101). A miss therefore proves the
 * write would match nothing. Cancel-all probes with `listCliTaskSeries()`,
 * whose pending/paused set is exactly what `cancelAllTasks` updates.
 *
 * Inside the action there is no `await` between the invalidation and the write,
 * so no sweep tick can interleave between them at all — which is exactly why
 * one invalidation is enough.
 *
 * Reads (`list`, `show`) never invalidate.
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
    origin_session_id: content.originSessionId, // which session created the task (null for CLI-created)
    // The per-fire pin, EXACTLY as stored. Until this landed, `ncl tasks` had
    // no way to show an operator what a series was pinned to — which is half
    // of why a stranded `gpt-6-astra` pin survived 21 failed fires unnoticed.
    model_pin: pin.model,
    effort_pin: pin.effort,
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

  // Host caller: no implicit stamp — routing only via the explicit flags below.
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
  // Host execution is opt-in by a HOST OPERATOR only. The host-side classifier
  // (classifyForHostExecution) is a regex subset, not a sandbox — for
  // agent-authored script text the trust boundary has to be who set the flag,
  // not what the script looks like.
  if (scriptHost && ctx.caller === 'agent') {
    throw new Error('--script-host runs the script on the host and can only be set by a host operator');
  }
  // Wall-clock fields (--process-after, the cron grid) are interpreted in the
  // owning group's timezone, not the install's.
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

  // Each series runs in its own isolated session. Delivery and run-log
  // instructions come from the runtime system prompt, not persisted prompt
  // suffixes; the formatter strips old generated suffixes for compatibility.
  // `routing.platformId` is stamped onto the session as well as the task row:
  // same value, two readers. The row is what the fire path uses; the session
  // column is what the console reads to place a task in the channel it is
  // routed to (migration 056). NO_ROUTING passes null and stamps nothing.
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
    // `taskSeriesId` (`src/db/sessions.ts:182`) returns null for the bare
    // `system:tasks` an upgraded install may still hold; the old slice returned
    // `''` there, which fell through to the `--id is required` error below only
    // by accident of being falsy. Being explicit keeps that behaviour when the
    // shape changes.
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
  // Upstream's own op, not a fork copy of the same SELECT (invariant I-2). It
  // normalizes `lastRun` through Date.parse, which is a no-op for the ISO
  // timestamps this fork writes and repairs a naive legacy one.
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
      };
    });
    if (found) {
      // Read after the mailbox action: the log lives on disk and its lookup
      // goes through the async agent-groups leaf, so it cannot sit inside
      // the synchronous callback.
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
          // Probe (see the seam note above): no task row for this id/series here
          // means every verb's UPDATE/DELETE matches nothing, so this session is
          // owed neither a write nor an invalidation.
          if (!mailbox.getCliTaskRow(id)) return 0;
          return withQuietInvalidationSync(session.id, () => fn(mailbox, id));
        }, `ncl tasks ${action}`),
      )) ?? 0;
    if (n > 0) {
      // No before/after body: pause/resume/delete/cancel don't touch the
      // prompt, matching the dashboard's own pause/resume/cancel audit rows
      // (scheduled-mutations.ts) — a status-only change is the "after" here.
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
  for (const session of await selectedSessions(args, ctx)) {
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
    if (args.process_after !== undefined) parseProcessAfter(args.process_after, await tz);
    if (recurrence !== undefined) {
      validateRecurrence(recurrence, await tz);
      // Effective script AFTER this update: the new value when provided
      // (including an explicit clear), else whatever THIS task already has.
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

  // A new cron with the old armed timestamp fires off the new grid (or a day
  // late). Unless the caller pinned --process-after explicitly, re-derive the
  // next fire from the new expression — in the receiving group's zone.
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
  // `--model ""` CLEARS the per-fire pin, the same spelling `groups config
  // update` uses for a group pin (groups.ts:521), plus this verb's own
  // `"null"`/`"none"` clear words (`--script`, `--recurrence`). `str()` is
  // wrong here for the reason `suppliedFlag` exists one way up: it collapses
  // "absent" and "supplied empty" into `undefined`, and on THIS flag the empty
  // string is the whole request. Until this landed there was no spelling at
  // all — `--model ""` reported "nothing to update" and `--model null` came
  // back "unknown model: null", so the only way off a pin was another pin.
  const model = normalizeNullableString(args.model);
  const effort = normalizeNullableString(args.effort);
  if (model !== undefined || effort !== undefined) {
    // Only a SET needs the provider vocabulary; a clear has nothing to
    // validate, so it does not drag in the `--group` requirement.
    if (model || effort) {
      const group = groupArg(args, ctx);
      if (!group) throw new Error('--group is required to validate --model/--effort');
      const { flagIntent, error: flagError } = await resolveTaskFlagIntent(
        { model: model ?? undefined, effort: effort ?? undefined },
        { agent_group_id: group },
      );
      if (flagError) throw new Error(flagError);
      if (flagIntent?.turnModel) update.flagIntent = { ...update.flagIntent, turnModel: flagIntent.turnModel };
      if (flagIntent?.turnEffort) update.flagIntent = { ...update.flagIntent, turnEffort: flagIntent.turnEffort };
    }
    // Clears are applied AFTER the validated sets, and independently: a single
    // call may clear one axis while setting the other.
    if (model === null) update.flagIntent = { ...update.flagIntent, turnModel: null };
    if (effort === null) update.flagIntent = { ...update.flagIntent, turnEffort: null };
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
    // The group's zone is the one central read this write needs; resolved
    // BEFORE the session opens so the block below stays synchronous from its
    // row read to its write.
    const tz = await resolveGroupTimezone(session.agent_group_id);
    const sessionUpdate: TaskUpdate = { ...update, ...wallClockUpdate(tz) };
    const result = await withInbound(session, (mailbox) =>
      withCentralSync(() => {
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
          parseTaskContent(before.content).scriptHost
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

  // The same contradiction as --group/--session above, on the other axis:
  // `--id` names one series and `--all` names every live one in scope, and the
  // kill switch used to win silently by never reading `--id` at all. So
  // `cancel --id nightly-digest --all` cancelled the whole group's tasks while
  // the operator had named exactly one. The flag's own help already says "omit
  // with --all" — this enforces what it documents instead of assuming it.
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
        // The listing is the probe: `listCliTaskSeries()` returns the
        // pending/paused set, which is exactly what cancel-all updates.
        if (seriesIds.length === 0) return { seriesIds, n: 0 };
        // Upstream's `cancelTask()` with no id IS cancel-all; there is one
        // statement behind both names (invariant I-2).
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
 * Move exactly one task series through the dashboard's hardened transaction.
 * A task move changes its execution identity, so unlike ordinary task verbs it
 * never fans out and is available only through the host's 0600 ncl socket.
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
 * `ncl tasks repin` — retarget per-fire pins in bulk.
 *
 * The operator case is "a new model shipped; move everything pinned to the old
 * one" and, harder, "I am migrating this group's provider and every pin has to
 * move first". The second is why `--target-provider` exists: a pin is
 * validated against the group's CURRENT provider, so re-pinning a codex group's
 * tasks to a claude model ahead of the switch would be rejected by the very
 * check that is supposed to protect them. `--target-provider` says "validate
 * against the provider this group is about to become".
 *
 * MATCHING IS LITERAL by default. The fleet stores both `sonnet` (family alias
 * — deliberately tracks the install default across future bumps) and
 * `claude-sonnet-5` (frozen id) as pins for the same intent, and rewriting the
 * first is not the same act as rewriting the second: it converts a floating
 * choice into a frozen one. So `--from-model sonnet` hits only the literal
 * `sonnet` pins, `--match-resolved` unifies the two, and either way the report
 * lists the near-misses (same resolved model, different literal pin) so a
 * conservative default can never read as "there was nothing else".
 *
 * ALL-OR-NOTHING by default: every match is validated before the first write,
 * and one invalid target aborts the whole run rather than leaving half the
 * fleet re-pinned. `--skip-invalid` applies the valid subset instead.
 */
interface RepinCandidate {
  session: ScopedSession;
  seriesId: string;
  status: string;
  current: { model: string | null; effort: string | null };
  /** What the operator asked for, verbatim — may be an alias (`astra`). */
  next: { model?: string; effort?: string };
  /**
   * What actually gets written: the validator's RESOLVED values, for the axes
   * the operator set. Filled during validation, because the resolution and the
   * acceptance are one act — `astra` is accepted only BECAUSE it resolves to
   * `gpt-6-astra`, so storing the raw alias would persist a value the check
   * never approved. `codex.ts::resolveQueryModel` accepts only `gpt-*` and
   * silently falls back otherwise, which is a wrong-model-forever fire with no
   * error anywhere.
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
 * Does a stored pin match what the operator asked to move?
 *
 * `normalize` is applied UNCONDITIONALLY and is where an axis declares what
 * counts as the same value written differently; `resolver` is the semantic
 * widening that `--match-resolved` gates. The two are different questions:
 * `XHIGH` and `xhigh` are one effort spelled two ways, while `sonnet` and
 * `claude-sonnet-5` are two DIFFERENT pins that happen to resolve alike — the
 * first tracks the install default across bumps, the second freezes it.
 */
/**
 * Model resolution for MATCHING, in the vocabulary of the group whose task is
 * being matched. `resolveEffectiveModel` only expands Claude family aliases, so
 * using it everywhere meant `--from-model astra --match-resolved` found nothing
 * on a codex group whose pin is stored as `gpt-6-astra` — the alias resolves in
 * the codex vocabulary, not the claude one.
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
  if (wanted === undefined) return 'literal'; // no constraint on this axis
  if (stored === null) return null;
  if (normalize(stored) === normalize(wanted)) return 'literal';
  if (matchResolved && resolver(stored) === resolver(wanted)) return 'resolved';
  return null;
}

/** Model ids are case-sensitive; only surrounding whitespace is noise. */
function modelLiteral(v: string): string {
  return v.trim();
}

/**
 * Effort has no alias layer and no case significance — `XHIGH` IS `xhigh`, so
 * matching it is normalization, not the semantic widening `--match-resolved`
 * gates. Documented as a case-insensitive compare; this is what makes that true.
 */
function effortIdentity(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * The sessions a repin run walks.
 *
 * `--session` and `--group` defer to `selectedSessions` (which already narrows
 * a group to its task-system sessions). A fleet-wide run does NOT: the
 * unscoped `selectedSessions` fallback is every ACTIVE session on the host,
 * which is hundreds of mailbox opens for a handful of task rows, and mailbox
 * churn at that scale is a known way to stall the sweep. Every task series
 * lives in its own task-system session, so fanning out over `findTaskSessions`
 * per group reaches the same rows — and exactly the population `auditTaskPins`
 * reports, which is what makes the audit's suggested remedy actually apply.
 */
async function repinSessions(args: Record<string, unknown>, ctx: CallerContext): Promise<ScopedSession[]> {
  // The cross-group `--session` refusal lives in `selectedSessions` itself, so
  // every caller inherits it — including this one. Deliberately NOT repeated
  // here: a second copy of an invariant one layer down is how the two drift.
  if (str(args.session) || groupArg(args, ctx)) return selectedSessions(args, ctx);
  const sessions: ScopedSession[] = [];
  for (const group of await getAllAgentGroups()) {
    sessions.push(...(await findTaskSessions(group.id)).map((s) => ({ id: s.id, agent_group_id: s.agent_group_id })));
  }
  return sessions;
}

/**
 * ── CONTRADICTORY-INPUT REFUSALS ──
 *
 * One defect class, found five times in this file: TWO INPUTS THAT CANNOT BOTH
 * BE TRUE, RECONCILED BY SILENTLY CHOOSING ONE INSTEAD OF REFUSING. Silently
 * picking a winner is indefensible because BOTH readings are plausible to the
 * caller, so whichever the code drops was — half the time — the one that was
 * meant, and the command reports success either way.
 *
 * The two refusals below are the ones `repin` owns:
 *   `--target-provider` with `--all` — validated the whole fleet against one
 *     group's FUTURE provider, writing claude ids onto codex/opencode series;
 *   `--group` with `--all` — contradictory scopes, silently narrowed;
 *   `--all` with `--session` — `--all` says fleet-wide, `--session` says one
 *     session, and the session silently won.
 *
 * A sharper sub-shape, and the reason `suppliedFlag` is used below rather than
 * `str`: A GUARD DEFEATED BY ITS OWN PRESENCE TEST. `str('')` is `undefined`,
 * so `--group ""` read as "no group supplied" and the contradiction guards
 * never fired — silently widening a scoped repin to fleet-wide.
 *
 * The rest of the class lives elsewhere, deliberately not duplicated here:
 *   `--group A --session <B's>` — fixed in `selectedSessions` (#567), which
 *     every verb in this file inherits, this one included;
 *   `cancel --id X --all` — dropped the id and cancelled everything in scope;
 *     owned by its own single-purpose change;
 *   `create --isolated --thread` — silently prefers `--isolated`. Documented,
 *     not patched: it is non-destructive and fails safe toward the NARROWER
 *     option, so refusing would cost more than it buys.
 */
async function repinTasks(args: Record<string, unknown>, ctx: CallerContext) {
  // `suppliedFlag`, not `str`: `str('')` is `undefined`, so an empty flag reads
  // as ABSENT and skips the guard written to catch it. On this verb that fails
  // OPEN — `--group "" --all` and `--all --session ""` both silently widen a
  // scoped repin to fleet-wide. One helper, shared with every other verb here.
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
  // Narrows the walk to ONE series inside the chosen scope. It is not itself a
  // scope: the series id says nothing about which group owns it, so without
  // --group/--session/--all the run would still fan out over every group on the
  // host to find it. Requiring a scope alongside keeps that fan-out an explicit
  // `--all`, the same bargain every other filter on this verb makes.
  const seriesId = suppliedFlag(args, 'series_id', '--series-id');
  const targetProvider = suppliedFlag(args, 'target_provider', '--target-provider');
  // `--target-provider` describes ONE group's migration — it is the answer to
  // "what will this group's provider be after the switch". Applied fleet-wide
  // it validates every group against a provider only one of them is moving to,
  // so `--all --target-provider claude` would write claude model ids onto codex
  // and opencode series and report success: the exact stranded-pin condition
  // this PR exists to prevent, manufactured by the tool built to remedy it.
  if (targetProvider && !group) {
    throw new Error(
      '--target-provider requires --group: it names the provider ONE group is migrating to, ' +
        'and applying it fleet-wide would validate every group against a provider it is not moving to.',
    );
  }
  const matchResolved = bool(args.match_resolved);
  const dryRun = bool(args.dry_run);
  const skipInvalid = bool(args.skip_invalid);

  // One provider read per group, not per task: the fan-out below can span
  // every group on the host and each lookup is a central-DB round trip.
  // TWO providers, for two different questions, and conflating them broke both
  // halves of a migration repin:
  //
  //   MATCHING asks "what vocabulary was this stored pin WRITTEN in" — always
  //     the group's CURRENT provider. Resolving `astra` with claude's tables
  //     because the group is moving to claude finds nothing, since the stored
  //     value is `gpt-6-astra` in codex's.
  //   VALIDATION asks "will the new value RUN" — the target provider when one
  //     is given, because that is the whole point of re-pinning before a switch.
  const providerCache = new Map<string, string>();
  const currentProviderFor = async (agentGroupId: string): Promise<string> => {
    const cached = providerCache.get(agentGroupId);
    if (cached) return cached;
    // Through the seam, not `getContainerConfig` directly: the projection can
    // lag the authoritative file, and reading it here resolved aliases and
    // validated replacements in the WRONG vocabulary — the same wrong-answer
    // the migration audit had at its own call site.
    const resolved = await resolveGroupProvider(agentGroupId);
    providerCache.set(agentGroupId, resolved);
    return resolved;
  };
  const validationProviderFor = async (agentGroupId: string): Promise<string> =>
    targetProvider ?? currentProviderFor(agentGroupId);

  const candidates: RepinCandidate[] = [];
  const nearMisses: Array<{ session_id: string; series_id: string; model: string | null; effort: string | null }> = [];
  // Did `--series-id` name a series that exists in scope at all? Without this,
  // a typo'd or out-of-scope id is indistinguishable from "that series is not
  // pinned to --from-model" — both report zero matches, and the operator reads
  // the second as the first and moves on.
  let seriesSeen = false;

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
      // A pure NARROWING filter, applied before matching: `--series-id` picks
      // which series the --from-* filter is allowed to hit, it does not replace
      // it. Repin's contract is "retarget an existing pin", and a run that
      // skipped the from-check would be a blind overwrite of whatever that
      // series currently carries — `tasks update --model` is the verb for that.
      if (seriesId !== undefined && row.seriesId !== seriesId) continue;
      if (seriesId !== undefined) seriesSeen = true;
      const resolveModel = modelResolverFor(await currentProviderFor(session.agent_group_id));
      const modelHit = pinMatches(row.pin.model, fromModel, modelLiteral, resolveModel, matchResolved);
      const effortHit = pinMatches(row.pin.effort, fromEffort, effortIdentity, effortIdentity, matchResolved);
      if (modelHit === null || effortHit === null) {
        // Would this have matched if --match-resolved were on? Report it, so a
        // conservative literal match never silently looks exhaustive.
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

  // Refuse rather than report an empty run: "no series with that id is in
  // scope" and "that series is not pinned to --from-model" are different
  // answers, and only one of them means the operator's command was wrong.
  if (seriesId !== undefined && !seriesSeen) {
    throw new Error(`no task series ${seriesId} in scope — check --series-id against \`ncl tasks list\``);
  }

  // Validate EVERY match before writing anything. The target is checked against
  // each candidate's OWN group provider (a fleet-wide run spans providers), or
  // against --target-provider when re-pinning ahead of a migration.
  //
  // Validate the MERGED pin, not the delta. `updateTask` merges flagIntent, so
  // a model-only repin leaves the existing effort in place: a codex task at
  // {gpt-6-astra, ultra} repinned to a Claude model would store
  // {claude-…, ultra}, which is still invalid for Claude. Validating only the
  // half being written reports success and leaves the series broken — and it
  // breaks the one workflow this command exists for, because the provider
  // migration it was meant to unblock stays blocked.
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
    // Persist the RESOLVED value, but ONLY for the axis the operator asked to
    // change. Writing the resolved form of an untouched axis would rewrite a
    // pin nobody asked to rewrite — the exact thing this whole change exists
    // to prevent (`sonnet` quietly becoming `claude-sonnet-5`).
    // NO `?? candidate.next.*` fallback. That would persist the operator's raw
    // request when the validator returned something different — which is the
    // very defect this loop was added to fix, reintroduced one line later.
    // `validateTaskPin` now rejects a dropped axis outright, so a requested
    // axis always comes back resolved or not at all.
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
      // Resolved, so a dry run shows the value that will actually be stored.
      to: {
        model: c.write.model ?? c.next.model ?? c.current.model,
        effort: c.write.effort ?? c.next.effort ?? c.current.effort,
      },
    })),
    // Series whose RESOLVED pin matches but whose literal pin does not. Left
    // untouched by design; `--match-resolved` includes them.
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

  // ── WHAT IS AND IS NOT ATOMIC HERE ──
  //
  // VALIDATION is all-or-nothing: every match is checked before the first write
  // and one invalid target aborts the run, so a bad `--to-model` never lands
  // half a fleet. That is the guarantee this command makes and keeps.
  //
  // The WRITE phase cannot be, and pretending otherwise is the more dangerous
  // error. Each series lives in its OWN session database — that is the
  // architecture, not an oversight — so there is no transaction spanning them
  // and no honest rollback: undoing an applied repin is itself a write that can
  // fail. A mid-loop failure therefore leaves earlier series repinned.
  //
  // So the loop does not abort on a failed candidate. It records the failure,
  // continues, and REPORTS exactly which series moved and which did not.
  // Aborting would produce the same partial state while returning only an
  // error — the operator would know something broke but not what landed, which
  // is the worst of both.
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
            // Same probe as every other mutating verb here (see the seam note):
            // no row for this series in this session means no write and no
            // invalidation is owed.
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
              // `updateTask` MERGES, so an axis this run did not touch survives.
              // Recording it as null would say the pin was cleared — a durable
              // audit row that is wrong is worse than no row during an incident.
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
      ],
      handler: async (args, ctx) => getTask(args, ctx),
    },
    create: {
      access: 'open',
      description:
        `Create a scheduled task (recurring or one-shot) in the agent group system session.\n\n` +
        `Requires --prompt plus EITHER --recurrence (recurring; first run derived from the cron grid) OR --process-after (one-shot, ISO 8601 or naive wall-clock in the group's timezone). Always pass --name for a readable id.\n\n` +
        `Workflow default: use --script for deterministic polling and observation; wake for meaningful changes or due unfinished/recovery work. Time-driven reasoning, requested reports and full campaigns may run directly; record why in the prompt. Check active tasks for overlapping owner, purpose and schedule before creating a series.\n\n` +
        `--script contract (pre-task gate, runs BEFORE the agent wakes):\n` +
        `  bash, 120s default timeout (NANOCLAW_TASK_SCRIPT_TIMEOUT_MS override), 1MB output cap. Its LAST stdout line must be JSON:\n` +
        `    {"wakeAgent": <bool>, "data": {...}}\n` +
        `  wakeAgent=false marks the run handled without waking the agent (zero tokens);\n` +
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
            'Per-fire model pin, validated against the agent group\'s provider vocabulary. ""/"null"/"none" clears it, so the series falls back to the group\'s own model.',
        },
        {
          name: 'effort',
          type: 'string',
          description:
            'Per-fire effort pin, validated against the agent group\'s provider vocabulary. ""/"null"/"none" clears it.',
        },
      ],
      handler: async (args, ctx) => updateTaskCommand(args, ctx),
    },
    repin: {
      access: 'approval',
      // Host-only: a bulk pin rewrite is an operator act. An agent caller is
      // already scoped to its own group by groupArg, but the blast radius of a
      // wrong --from-model is every armed series it can see, and nothing about
      // running a scheduled fire needs it.
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
            'Also match pins that resolve to the same model (unifies the family alias "opus" with the frozen id "claude-opus-5[1m]"). Off by default: it converts a floating pin into a frozen one.',
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
            'Limit to ONE series inside the chosen scope. Narrows the --from-* match, it does not replace it; still needs --group, --session or --all. Refuses if no such series is in scope.',
        },
      ],
      examples: [
        `# See what a model bump would touch, fleet-wide, before touching anything:\nncl tasks repin --all --from-model claude-opus-5[1m] --to-model claude-opus-5-1[1m] --dry-run`,
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
