/**
 * Observatory console — thread-keyed work list (DESIGN.md §3, §5, §10).
 *
 *   GET /dashboard/api/threads        — the queue, one row per THREAD
 *   GET /dashboard/api/threads/:id    — one thread + its merged transcript
 *
 * Why this exists alongside `sessions.ts`: `sessions` is keyed on
 * `(agent_group_id, messaging_group_id, thread_id)`, so a thread carrying six
 * agents is six rows and a session-keyed list renders ~40% duplicates (§3.1).
 * `sessions.ts` still backs the inbox board and is untouched.
 *
 * Three rules from the design contract are load-bearing here:
 *
 *  - **Group by thread, key channels off `thread_id`** (§3.1/§3.2).
 *    `messaging_groups` holds one row per sibling bot per channel, so grouping
 *    on `messaging_group_id` lists the same channel once per wired bot.
 *  - **Never trust `sessions.container_status`** (§3.4) — liveness is
 *    recomputed from `.heartbeat` mtime, same as `sessions.ts`.
 *  - **`container_state.provider_status` must surface** (§5). It is written by
 *    every provider and, before this endpoint, read by nothing.
 *
 * Cost control: `container_state` lives in each session's own `outbound.db`,
 * so reading it means opening a file per session. We open it ONLY for sessions
 * the host currently holds a live container process for
 * (`getActiveContainerSessionIds()`, an in-memory Map — see the comment on
 * {@link liveContainerState}). Everything else on the row comes from one
 * central-DB query plus a `statSync` per session.
 */
import { getDb } from '../../db/connection.js';
import { getContainerConfig, resolveProviderName } from '../../db/container-configs.js';
import { TASKS_SYSTEM_THREAD_ID, isTaskThread } from '../../db/sessions.js';
import { readSessionOutbound, type ContainerState } from '../../modules/mailbox/index.js';
import { getActiveContainerSessionIds, resolveAssistantName } from '../../container-runner.js';
import { readContainerConfig } from '../../container-config.js';
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { readClaims, type BoardClaim } from '../../claims-board.js';
import {
  isAttentionItemId,
  readAttentionItems,
  stripAttentionItemPrefix,
  workgroupIdsForAgentGroups,
  workgroupIdsWithAttentionSources,
  type AttentionItem,
  type AttentionSourceEnv,
} from '../../attention-sources.js';
import { log } from '../../log.js';
import type { AgentGroup, SessionMode } from '../../types.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { isSnoozed, readThreadSnoozes } from '../thread-snooze.js';
import { ASSIGN_DEDUPE_MS, assignmentKey, readItemAssignments, readUserDisplayNames } from '../db/item-assignments.js';
import { readThreadClosures, type ThreadCloseState } from '../thread-close.js';
import { requiredConfirmations } from '../thread-close-guard.js';
import {
  deriveContainerStatus,
  readSessionTranscript,
  type ContainerStatus,
  type SessionTranscriptEntry,
} from './sessions.js';

/* ─── Channel key (§3.2) ───────────────────────────────────────────────────── */

/** Bucket for thread ids that carry no recoverable channel — see {@link threadChannelKey}. */
export const UNKNOWN_CHANNEL_KEY = 'unknown';

/**
 * Platforms whose channel identity needs more than `<platform>:<channel>`.
 *
 * Discord addresses a channel as `<platform>:<guild>:<channel>`, which is also
 * exactly what `messaging_groups.platform_id` stores for it. DESIGN.md §3.2
 * states the middle segment is the key; that is true for Slack and false for
 * Discord, where the middle segment is the GUILD and taking it would collapse
 * every Discord channel in the install into one bucket.
 */
const EXTRA_SEGMENT_PLATFORMS: Record<string, number> = { discord: 3 };

/** Deepest channel key we will ever consider (Discord threads carry four segments). */
const MAX_KEY_SEGMENTS = 4;

/**
 * The platform channel a thread belongs to, parsed from its `thread_id`.
 *
 * `known` is the set of `messaging_groups.platform_id` values, and it is the
 * authority when it has an answer: the longest prefix of the thread id that is
 * a real wired channel wins. It is optional so the parser stays unit-testable
 * and so an un-wired channel still lands somewhere sensible.
 *
 * Shapes handled, all present in the live data:
 *
 * | thread_id                        | key                     |
 * |----------------------------------|-------------------------|
 * | `slack:CTESTCHAN01:1700000000.44` | `slack:CTESTCHAN01`     |
 * | `slack:DTESTUSER01`              | `slack:DTESTUSER01`     |
 * | `slack:DTESTUSER02:`             | `slack:DTESTUSER02`     |
 * | `discord:<guild>:<ch>:<thread>`  | `discord:<guild>:<ch>`  |
 * | `system:tasks:example-task-0001`  | `system:tasks`          |
 * | `spawn-abcdef01…` / `1700000000.22` | `unknown`            |
 *
 * Never throws. Anything it cannot read degrades to {@link UNKNOWN_CHANNEL_KEY},
 * which is a real, stable bucket rather than a per-row singleton — a legacy
 * bare-timestamp thread genuinely has no channel, and inventing one per row
 * would fill the sidebar with noise.
 */
export function threadChannelKey(threadId: string | null | undefined, known?: ReadonlySet<string>): string {
  if (typeof threadId !== 'string') return UNKNOWN_CHANNEL_KEY;
  // An attention-source item id is a DEDUPE KEY, not a thread id, and it is
  // `<prefix>:<repo>#<n>` shaped — which this parser would happily read as a
  // platform plus a channel, minting one fake sidebar bucket PER ITEM. That is
  // exactly the per-row bucket §3.2 forbids. The item's real channel comes
  // from the install's declaration and is attached by `buildThreadList`; this
  // guard is here rather than only at that call site so no future caller can
  // reintroduce the bug by passing an item id in.
  if (isAttentionItemId(threadId)) return UNKNOWN_CHANNEL_KEY;
  const segments = threadId.trim().split(':');
  const platform = segments[0];
  // A bare id (legacy timestamp, `spawn-<hash>`) or an empty leading segment
  // names no channel. Both are stable, neither is guessable.
  if (!platform || segments.length < 2 || !segments[1]) return UNKNOWN_CHANNEL_KEY;

  if (known) {
    for (let n = Math.min(segments.length, MAX_KEY_SEGMENTS); n >= 2; n--) {
      const candidate = segments.slice(0, n).join(':');
      if (known.has(candidate)) return candidate;
    }
  }

  const want = EXTRA_SEGMENT_PLATFORMS[platform] ?? 2;
  const depth = Math.min(want, segments.length);
  // A `discord:<guild>` with no channel segment is not a channel key; fall back
  // rather than emit a guild id that would swallow the whole server.
  if (depth < want && want > 2) return UNKNOWN_CHANNEL_KEY;
  const key = segments.slice(0, depth).join(':');
  return segments[depth - 1] ? key : UNKNOWN_CHANNEL_KEY;
}

/* ─── State (§5) ───────────────────────────────────────────────────────────── */

/**
 * DESIGN.md §5's states.
 *
 * `idle` was reported back as a gap during this build and §5 now carries it:
 * the named states did not partition the space. A thread whose container is
 * not running, that holds no claim, and whose last tool call finished
 * normally matches none of the others — 57 of 63 threads in a live 24h
 * window. Dropping them would hide real work, so they get an honest residual
 * label, and no verb.
 *
 * There used to be a `done` state, reached only when every backing session
 * was archived by the operator's own Close/Dismiss action. It is gone along
 * with that action: `done` was never "the agent finished" — it was "an
 * operator stopped looking at this" — and a lane that can only be reached by
 * looking away misreports hidden, possibly still-running work as complete. A
 * thread whose sessions are archived now falls through to `idle`, which is
 * the honest read: no container running, nothing claimed.
 */
export type ThreadState = 'unassigned' | 'needs_you' | 'stalled' | 'running' | 'parked' | 'idle';

/** §5: a tool that started this long ago with nothing newer out is stuck. */
export const STALL_AFTER_MS = 30 * 60_000;

export interface ThreadStateInput {
  /** How many sessions back this work item. Zero = an unowned item with no thread yet. */
  sessionCount: number;
  /** The claim held on this thread, if any. */
  claimState: BoardClaim['state'] | null;
  claimNote: string;
  /** Any backing session is waiting on a human (task `needs_input`, or an unanswered `ask_question`). */
  needsOperator: boolean;
  /** Recomputed from heartbeat mtime — never `sessions.container_status` (§3.4). */
  containerStatus: ContainerStatus;
  /** `container_state.provider_status`, or null when we did not probe / it is unset. */
  providerStatus: string | null;
  toolStartedAtMs: number | null;
  /** Newest outbound across the thread's sessions, epoch ms. */
  lastOutputAtMs: number | null;
  now: number;
}

/** §5's "waiting on <human>" park note. */
const WAITING_ON_NOTE = /\bwaiting on\b/i;

/**
 * {@link ThreadSummary.needs_you_reason} — see {@link deriveNeedsYouReason}
 * for how each variant is produced and why its text is never fabricated.
 */
export type NeedsYouReason =
  | {
      cause: 'parked_note';
      text: string;
      /**
       * How long the claim has been parked, in ms — or null when the claim
       * carries no readable `parked_at`.
       *
       * **The console never reconciles a claim against reality.** Releasing a
       * claim is the claim OWNER's job; a display that second-guesses its own
       * source produces two disagreeing truths, and the one that is wrong is
       * whichever the operator did not happen to be looking at. So a note
       * saying a human owes a decision on a PR that merged hours ago still
       * renders — with its AGE beside it, which is the honest signal and the
       * one that makes the staleness legible without inventing a verdict.
       *
       * Null, never zero: §12 — "an unmeasured value is not a zero", and a
       * zero here would read as "parked just now", the exact opposite of what
       * an unreadable timestamp means.
       */
      parked_ms: number | null;
    }
  | { cause: 'ask_question'; text: string }
  | { cause: 'task_needs_input'; text: string };

/**
 * Which state a thread is in. Pure — every input is resolved by
 * the caller so this is directly testable and so the release board can feed
 * ownerless items through the same function once §10.3 lands.
 *
 * Priority follows §5's own table order, and the two `needs_you` tests run
 * BEFORE the `unassigned` guard. That order is deliberate and load-bearing.
 *
 * `unassigned` used to be hoisted to the top, justified by "a work item with no
 * session cannot have a container, a claim or a transcript, so nothing below it
 * can compute anyway". That reasoning is right about containers and transcripts
 * and WRONG about claims: claims are keyed by THREAD ID and live in workgroup
 * files, not in `sessions`, so a zero-session item can perfectly well carry a
 * parked claim whose note names the human it is waiting on. Hoisting the guard
 * made every such item report `unassigned` — "nobody has picked this up" — when
 * the true claim is `needs_you` — "a human owes an answer". Different meaning,
 * and no error anywhere to notice it.
 *
 * The guard still sits above everything else, because every branch below it
 * (provider status, container liveness, tool timing, the residual park) does
 * need a session to mean anything.
 *
 * This exists so ownerless work items — a ready-but-unshipped PR blocked on a
 * human, fed in with `sessionCount: 0` and a parked claim — flow through the
 * SAME state function as everything else, rather than a producing surface
 * setting `state` directly and inventing its own lane semantics.
 */
export function deriveThreadState(input: ThreadStateInput): ThreadState {
  if (input.claimState === 'parked' && WAITING_ON_NOTE.test(input.claimNote)) return 'needs_you';
  if (input.needsOperator) return 'needs_you';

  if (input.sessionCount === 0) return 'unassigned';

  // §5.1: this must NOT depend on `current_tool` being readable. Codex reports
  // the generic `CodexItem` and roughly half the fleet is non-Claude, so the
  // rule is age-only. `provider_status = 'failed'` is the same operator
  // situation reached a different way — a thread that has stopped moving and
  // needs a push.
  if (input.providerStatus === 'failed') return 'stalled';
  if (
    input.toolStartedAtMs !== null &&
    input.now - input.toolStartedAtMs > STALL_AFTER_MS &&
    (input.lastOutputAtMs === null || input.lastOutputAtMs <= input.toolStartedAtMs)
  ) {
    return 'stalled';
  }

  // §5 says "heartbeat fresh AND a tool in flight". Reported as underspecified:
  // taken literally, a healthy container between tool calls has no state at
  // all. Liveness is the gate here; whether a tool is in flight rides on
  // `tool_started_at` / `current_tool`, which is what §6's activity rule
  // animates from.
  if (input.containerStatus === 'running' || input.providerStatus === 'active') return 'running';

  if (input.claimState === 'parked') return 'parked';
  return 'idle';
}

/* ─── Wire shapes ──────────────────────────────────────────────────────────── */

export interface ThreadParticipant {
  agent_group_id: string;
  name: string;
  /**
   * The session a reply addressed to THIS participant lands in — its most
   * recent session on the thread (§10.3).
   *
   * A thread is N sessions, one per participating agent, and the steer path
   * (`POST /dashboard/api/sessions/:id/message`) writes into exactly one
   * inbound queue. So "reply to this thread" is not a well-formed request until
   * an agent is named: this field is what makes naming one possible, and
   * {@link ThreadSummary.reply_target_session_id} is the default choice.
   *
   * Usually one session per agent per thread, but `sessions` is keyed on
   * `(agent_group_id, messaging_group_id, thread_id)` — a sibling bot wired
   * through two messaging groups can hold two. The freshest wins, since the
   * participant list is already ordered most-recent-first.
   */
  session_id: string;
  avatarUrl: string | null;
  /**
   * Resolved through `resolveProviderName` (session → container config →
   * 'claude'). On the wire because §5.1 makes provider a rendering concern:
   * a Codex row's `current_tool` is the generic `CodexItem`, so the live line
   * has to know not to promise a readable step name.
   */
  provider: string;
}

/** An agent the thread can be handed to — see {@link ThreadSummary.assignable_agents}. */
export interface ThreadAgentOption {
  agent_group_id: string;
  name: string;
}

export interface ThreadSummary {
  /** Durable identity (§3.1). Synthetic `session:<id>` when the session has no thread. */
  thread_id: string;
  /** True when `thread_id` above is synthetic — the session's `sessions.thread_id` is NULL. */
  synthetic: boolean;
  channel_key: string;
  /** Human channel name resolved from `messaging_groups`; falls back to the key's last segment. */
  channel_name: string;
  title: string | null;
  /** Most-recent speaker first. */
  participants: ThreadParticipant[];
  /**
   * Every other agent wired to this thread's channel — the ones the operator
   * can HAND the thread to.
   *
   * The console has one primitive, "send a message to a chosen agent", and the
   * only difference between steering and assigning is whether the chosen agent
   * is already on the thread. So the selector needs both lists, and they arrive
   * separately rather than merged: the split is what tells the operator that
   * picking from the lower group will open a session that does not exist yet.
   *
   * Scope-filtered like everything else on this wire, and empty for a thread
   * whose channel no wiring names (a synthetic `session:<id>` key, a legacy
   * bare-timestamp thread) — those genuinely have no room to assign into.
   */
  assignable_agents: ThreadAgentOption[];
  /**
   * ISO-8601 UTC, ALWAYS — normalized on the way out.
   * `sessions.last_outbound_at` is stored naive (`YYYY-MM-DD HH:MM:SS`), and a
   * browser reading that with `new Date()` silently shifts it by the viewer's
   * offset. Nothing naive is allowed onto this wire.
   */
  last_activity_at: string | null;
  state: ThreadState;
  /**
   * WHY this row is `needs_you` — present ONLY when `state` is `needs_you`,
   * and null even then if the cause cannot be named (see
   * {@link deriveNeedsYouReason}). An operator opened a `needs_you` thread
   * whose newest message was a completion report and read the flag as a false
   * positive; the actual cause was a parked claim's note two hops away
   * (operator report 2026-08-21) — this field is the row saying so directly
   * instead of making the operator go find it.
   */
  needs_you_reason: NeedsYouReason | null;
  session_ids: string[];
  /** Freshest liveness across the thread's sessions, from heartbeat mtime. */
  container_status: ContainerStatus;
  /** `container_state.provider_status` — null when no session was probed or the column is unset. */
  provider_status: string | null;
  current_tool: string | null;
  /** ISO-8601 UTC, normalized — see {@link ThreadSummary.last_activity_at}. */
  tool_started_at: string | null;
  /**
   * Which session the console's Answer / Steer composer aims at by default
   * (§10.3). The rule is "the agent whose state drove this row's urgency":
   *
   * - `needs_you` → the session actually sitting on the unanswered question,
   * - `stalled` / `running` → the session whose `container_state` was picked,
   * - anything else → the most recently active session.
   *
   * A DEFAULT, never a lock: the operator can retarget any participant, and
   * the send always names the session explicitly. Null only when the thread
   * somehow has no sessions, which the list path cannot currently produce.
   */
  reply_target_session_id: string | null;
  /**
   * This caller's own snooze is still in force — the thread has not moved since
   * they took it. Per-user view state, not a state in §5's sense: a thread can
   * be snoozed while it is running. See `thread-snooze.ts`.
   */
  snoozed: boolean;
  /**
   * True for a `ncl tasks` execution's own isolated session (DEFECT 1, operator
   * report 2026-08-20). Its `thread_id` is `system:tasks` or
   * `system:tasks:<seriesId>` ({@link isScheduledTaskThread}), and it never
   * carries a `messaging_group_id` (`resolveTaskSession` in
   * session-manager.ts), so there is no live-room channel to recover it into —
   * it lands in the `system:tasks` → `tasks` pseudo-channel bucket
   * (§3.2's own documented shape) and this flag is how the row says so, rather
   * than reading as an ordinary channel thread.
   */
  scheduled_task: boolean;
  /**
   * The agent's own `propose_done` record — "I believe this is finished, and
   * here is why" — or null.
   *
   * **A flag, not a state, and that is a decision.** §5's states are mutually
   * exclusive lanes describing where the WORK is, and a proposal is orthogonal
   * to all of them: an agent that proposes closing at the end of a turn is
   * very often still `running`, because its container has not exited yet.
   * Minting a `proposes_closing` state would push that row out of `running`
   * and stop the console reporting live work as live — which is precisely the
   * failure that got the Dismiss action removed. A proposal rides ALONGSIDE
   * the state instead, so a row can honestly read "running · proposes
   * closing".
   *
   * **Unreachable except by an actual agent.** Its only source is
   * `sessions.done_proposal`, which is only ever written by the host sweep
   * copying the container's own `session_state.done_proposal`, which is only
   * ever written by the `propose_done` MCP tool. No derivation, no default, no
   * host-side path can produce one — and it is retracted by `continue_work`
   * and by the next real user message.
   *
   * Mirror-sourced, so it lags a live proposal by up to one sweep interval.
   * The close path does NOT read this — it re-reads the container's own copy
   * for the one thread it is acting on (`thread-close.ts`).
   */
  done_proposal: ThreadDoneProposal | null;
  /**
   * An operator-confirmed close is in flight: the wrap-up request has gone to
   * the agents and the sequence is waiting on them, or finalizing. Not a §5
   * state either — the work is still whatever it was until it stops.
   */
  closing: boolean;
  /**
   * How many explicit operator confirmations a close of THIS thread needs
   * right now — 1 when an agent has proposed, 2 when none has.
   *
   * On the wire so the console can label the button honestly before the
   * operator commits to anything. It is NOT the authority: the server counts
   * confirmations again in the `threads.close` guard, so a client that renders
   * one button where two are required gets a 409, never a close.
   */
  close_confirmations_required: 1 | 2;
  /**
   * Present ONLY on a row produced by a workgroup attention source
   * (`src/attention-sources.ts`) — an ownerless work item that has no session
   * and therefore no thread yet (§2, §5 `unassigned`). Absent on every row
   * derived from `sessions`.
   *
   * It carries the provenance the operator needs to weigh the row: which kind
   * of source claimed it, when that source last regenerated, and where a
   * person goes to act.
   */
  attention_source?: ThreadAttentionSource;
}

/** {@link ThreadSummary.attention_source}. */
export interface ThreadAttentionSource {
  /** The declared source kind — `release-board`, etc. */
  kind: string;
  /**
   * When THIS ROW'S source last regenerated, ISO-8601 UTC, or null when
   * nothing could be read at all.
   *
   * Per source, never an aggregate over the feed. An aggregate here once took
   * the oldest contributor's timestamp, so one dead generator made every row
   * on the page — including boards refreshed minutes earlier — report as a
   * week old, and no reader could tell which source had actually died.
   *
   * **On the wire so the row can wear its age — never so anything can suppress
   * it.** There is no staleness threshold anywhere in this path, deliberately:
   * a stale feed showing real work with a visible age is strictly better than
   * an empty feed, because an empty one is indistinguishable from healthy.
   */
  as_of: string | null;
  /**
   * Has this row's source missed the cadence the install declared for it?
   *
   * Three values, and the third is the point. `null` means NO CLAIM — the
   * source declared no `refresh_hours`, or its `as_of` could not be read.
   * DESIGN.md §12: *"undeclared must never read as independent"*, so an
   * unchecked source renders like any other unmarked row rather than being
   * vouched for. Computed host-side (`sourceStaleness`) because the cadence is
   * install config, not something a client should be handed and re-derive.
   *
   * A `true` here MARKS the row. It never hides it: the work is real either
   * way, and a stale source additionally produces its own row saying so.
   */
  stale: boolean | null;
  /** Where a person goes to act on this item, or null. Never invented. */
  url: string | null;
  /** What a person has to do, in the source's own words. */
  next_action: string;
  /**
   * Who this ownerless item has already been handed to, or null — **only
   * while the reservation is fresh** (younger than `ASSIGN_DEDUPE_MS`, the
   * SAME window `reserveItemAssignment`'s write-side `WHERE` already uses).
   *
   * **The reason the Assign affordance is not a trap.** An attention item is
   * derived on every poll from a board plus the claims directory, so assigning
   * one changes nothing an operator can see until the agent boots and claims
   * the work — minutes later. Without this field the row still reads
   * `Unassigned` with a live Assign button, and the operator presses it again,
   * queueing a second task at a second agent for the same work.
   *
   * The row's STATE deliberately stays `unassigned`: §5 computes it from "a
   * work item with no session at all", which is still literally true — no
   * session exists until the assigned agent speaks. What changes is the verb,
   * which §12 requires to be a disabled control with a reachable explanation
   * ("Assigned to X, 2m ago") rather than a live button that can only be
   * refused. State and verb are separate zones in §4's row anatomy, so the
   * headline is not contradicted by what sits beside it.
   *
   * **Once the window elapses this reverts to null and the row is assignable
   * again**, matching what the write side already allows: a lapsed
   * reservation must not go on presenting inert history as live work in
   * progress (a PR that merged, un-suppressing the item, then reopened days
   * later must not still say "waiting for it to pick the work up" about an
   * agent that finished or never started). The row does not lose the fact
   * someone was already asked — see {@link assigned_expired}.
   */
  assigned: ThreadItemAssignment | null;
  /**
   * The SAME reservation as {@link assigned}, surfaced instead of it once the
   * window has elapsed — never both at once, and null whenever there is no
   * reservation at all.
   *
   * This is the distinction between "nobody has been asked" and "someone was
   * asked and it did not take": the row is assignable again either way, but
   * the operator should be able to tell them apart without digging. Reading
   * the row's own history costs nothing extra — the query already fetched it
   * — so it is surfaced rather than dropped.
   */
  assigned_expired: ThreadItemAssignment | null;
}

/** {@link ThreadAttentionSource.assigned}. */
export interface ThreadItemAssignment {
  agent_group_id: string;
  /** The name the item's own room knows this agent by, resolved like a participant's. */
  agent_name: string;
  /** ISO-8601 UTC. */
  at: string;
  /** Display name of whoever assigned it, resolved at read time so a rename shows. */
  by: string;
}

/** {@link ThreadSummary.done_proposal} — the proposal plus who made it. */
export interface ThreadDoneProposal {
  reason: string;
  /** ISO-8601 UTC, as the agent wrote it. */
  proposed_at: string;
  agent_group_id: string;
  session_id: string;
}

/**
 * §5/CLAUDE.md: `ncl tasks` fires in an isolated session whose thread_id is
 * `${TASKS_SYSTEM_THREAD_ID}:<seriesId>` (`resolveTaskSession`, one session per
 * recurring series). Exported so the row-level pill and its test share one
 * definition of "this is a scheduled task" with the channel-key parser, which
 * already treats the same prefix as `system:tasks` (`threadChannelKey`'s
 * `EXTRA_SEGMENT_PLATFORMS` fallback — this is NOT a second, competing rule).
 *
 * Delegates rather than restating the rule. It used to be a verbatim copy of
 * `isTaskThread` (`src/db/sessions.ts:157`), which is the shape that
 * drifts: two copies agree until one is edited. Kept as a named export because
 * the pill, the filter and their tests read better for it, but there is now
 * exactly one definition.
 */
export function isScheduledTaskThread(threadId: string): boolean {
  return isTaskThread(threadId);
}

/** Anything that leaves this module as a timestamp goes out as ISO-8601 UTC. */
function isoOrNull(s: string | null | undefined): string | null {
  const ms = parseUtcTimestampMs(s);
  return ms === null ? null : new Date(ms).toISOString();
}

export interface ThreadTranscriptEntry extends SessionTranscriptEntry {
  session_id: string;
  agent_group_id: string;
  agent_name: string;
}

/* ─── Query ────────────────────────────────────────────────────────────────── */

interface ThreadSessionRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  /**
   * Task sessions only: the channel the series is ROUTED to (migration 056).
   * Rides along on the `sessions` SELECT below — reading it costs zero extra
   * queries. See {@link threadRoutingChannel} for why it never outranks an
   * anchor.
   */
  task_routing_platform_id: string | null;
  agent_provider: string | null;
  title: string | null;
  title_generated_at: string | null;
  last_active: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;
  archived_at: string | null;
  created_at: string;
  /** Mirror of the container's `session_state.done_proposal` — see {@link ThreadSummary.done_proposal}. */
  done_proposal: string | null;
  attached_task_status: string | null;
  attached_task_needs_input: number | null;
  /** The worker's own free-text question from `spawn_request_steer`, or null when it gave none. */
  attached_task_steer_question: string | null;
}

const DEFAULT_SINCE_HOURS = 168; // 7d — §3.3's stated working set
const MAX_SINCE_HOURS = 24 * 90;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * Every active session in scope whose newest activity is inside the window.
 *
 * `datetime()` wraps both sides because the columns are NOT one format:
 * `last_active` / `created_at` are ISO-8601 with `Z`, while `last_outbound_at`
 * is written naive by `bumpLastOutbound`. The same mismatch is why ordering
 * uses numeric `julianday()` values in SQL rather than a string comparison,
 * which silently sorts every ISO value above every naive one.
 */
async function selectScopedSessions(
  ctx: AuthedRequestContext,
  opts: {
    workgroupId?: string | null;
    groupId: string | null;
    includeArchived: boolean;
    sinceHours: number | null;
    limit: number;
    offset?: number;
    threadId?: string | null;
  },
  now: number,
): Promise<ThreadSessionRow[]> {
  const conditions: string[] = ["s.status = 'active'"];
  const values: unknown[] = [];

  if (!ctx.scopes.no_filter) {
    const ids = ctx.scopes.allowed_group_ids;
    if (ids.length === 0) return [];
    conditions.push(`s.agent_group_id IN (${ids.map(() => '?').join(', ')})`);
    values.push(...ids);
  }
  if (opts.workgroupId) {
    // The PRIMARY axis. Siblings share a workgroup, so filtering by agent group
    // forced the operator to pick one sibling and hid the rest of the thread's
    // participants — see CLAUDE.md "Siblings share a workgroup".
    //
    // This can never WIDEN scope. The clause above is a separate AND term, so a
    // caller allowed two siblings of a six-sibling workgroup still sees exactly
    // those two; the workgroup only ever subtracts. Same rule as §2a for
    // `group_id`: an out-of-scope or unknown workgroup yields zero rows, not a
    // 403.
    conditions.push('s.agent_group_id IN (SELECT id FROM agent_groups WHERE workgroup_id = ?)');
    values.push(opts.workgroupId);
  }
  if (opts.groupId) {
    // §2a: an out-of-scope group_id yields zero rows rather than a 403. Still
    // supported, and now a NARROWING term inside the selected workgroup.
    conditions.push('s.agent_group_id = ?');
    values.push(opts.groupId);
  }
  if (!opts.includeArchived) conditions.push('s.archived_at IS NULL');

  if (opts.threadId) {
    // Detail path: one named thread, no time window. The synthetic key for a
    // NULL-thread session is built the same way `groupByThread` builds it, so
    // `session:<id>` addresses that row directly.
    conditions.push(`COALESCE(s.thread_id, 'session:' || s.id) = ?`);
    values.push(opts.threadId);
  } else if (opts.sinceHours !== null) {
    conditions.push(`datetime(COALESCE(s.last_outbound_at, s.last_active, s.created_at)) >= datetime(?)`);
    values.push(new Date(now - opts.sinceHours * 3_600_000).toISOString());
  }

  // Same never-engaged filter as sessions.ts: an inbound that never woke an
  // agent mints a session row and would otherwise clutter the queue forever.
  conditions.push("(s.last_outbound_at IS NOT NULL OR s.container_status <> 'stopped' OR t.task_id IS NOT NULL)");

  // Limit thread keys rather than sessions: sibling adapters can contribute
  // multiple rows to one thread, and callers need all of those participants.
  // `julianday()` gives the SQL page boundary the same ordering as `activityMs`
  // for both ISO-8601 and legacy naive UTC timestamps.
  const sql = `
    WITH scoped_sessions AS (
      SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.task_routing_platform_id, s.agent_provider,
             s.title, s.title_generated_at, s.last_active, s.last_outbound_at, s.last_outbound_kind,
             s.archived_at, s.created_at, s.done_proposal,
             t.status         AS attached_task_status,
             t.needs_input    AS attached_task_needs_input,
             t.steer_question AS attached_task_steer_question,
             COALESCE(s.thread_id, 'session:' || s.id) AS thread_key,
             MAX(
               COALESCE(julianday(s.last_outbound_at), -1.0e300),
               COALESCE(julianday(s.last_active), -1.0e300),
               COALESCE(julianday(s.created_at), -1.0e300)
             ) AS activity
        FROM sessions s
   LEFT JOIN (
              SELECT task_id, child_session_id, status, needs_input, steer_question, admitted_at,
                     ROW_NUMBER() OVER (PARTITION BY child_session_id ORDER BY admitted_at DESC) AS rn
                FROM tasks
               WHERE child_session_id IS NOT NULL
                 AND status IN ('pending', 'running')
            ) t ON t.child_session_id = s.id AND t.rn = 1
       WHERE ${conditions.join(' AND ')}
    ), thread_page AS (
      SELECT thread_key
        FROM scoped_sessions
       GROUP BY thread_key
       ORDER BY MAX(activity) DESC, thread_key ASC
       LIMIT ?
      OFFSET ?
    )
    SELECT id, agent_group_id, messaging_group_id, thread_id, task_routing_platform_id, agent_provider,
           title, title_generated_at, last_active, last_outbound_at, last_outbound_kind,
           archived_at, created_at, done_proposal,
           attached_task_status, attached_task_needs_input, attached_task_steer_question
      FROM scoped_sessions
     WHERE thread_key IN (SELECT thread_key FROM thread_page)
  `;
  return getDb().all<ThreadSessionRow>(sql, ...values, opts.limit, opts.offset ?? 0);
}

export interface ChannelDirectory {
  known: Set<string>;
  names: Map<string, string>;
  /** `messaging_groups.id` → `platform_id` — the join a synthetic (NULL-thread_id) session needs. */
  byId: Map<string, string>;
  /**
   * `platform_id` of a DM room → a stable cross-instance key for the human on
   * the other end. See {@link buildThreadList}'s DM-collapse comment for why
   * this exists and what it deliberately does not cover.
   */
  dmDedupeKey: Map<string, string>;
}

/** `messaging_groups.platform_id` → friendly name, and the key set §3.2 parses against. */
export async function readChannelDirectory(): Promise<ChannelDirectory> {
  const known = new Set<string>();
  const names = new Map<string, string>();
  const byId = new Map<string, string>();
  const dmDedupeKey = new Map<string, string>();
  try {
    const rows = await getDb().all<{
      id: string;
      platform_id: string;
      name: string | null;
    }>('SELECT id, platform_id, name FROM messaging_groups');
    for (const r of rows) {
      known.add(r.platform_id);
      byId.set(r.id, r.platform_id);
      if (r.name && !names.has(r.platform_id)) names.set(r.platform_id, r.name);
    }
  } catch (err) {
    log.warn('threads: could not read messaging_groups directory', { err });
  }

  // DEFECT 2 (operator report, 2026-08-20): one human DMing two sibling bots
  // mints two `messaging_groups` rows with the same `name` but a different
  // `platform_id` — one DM room per (bot instance, human). `user_dms` already
  // resolves each DM room back to `(channel_type, raw platform user id)`; the
  // RAW id is what survives across sibling instances on the same platform (a
  // Slack workspace's `U…` id, a Discord account id, are shared by every bot
  // app installed there), even though `user_dms.user_id` and `users.id` are
  // themselves instance-scoped (`<channel_type>:<raw id>`, one `users` row per
  // instance — verified live: the same Slack human has SIX `users` rows, one
  // per sibling bot). So the raw id, not `user_id`, not `users.id`, is the one
  // thing stable enough to key on, and it is what collapses the DM rooms to
  // one sidebar entry.
  //
  // Deliberately NOT covered: a DM room with no `user_dms` row (12 of 13 live
  // DM rooms are covered; the remainder — lazily resolved, or older than the
  // table — pass through unmerged rather than falling back to a bare `name`
  // match. `messaging_groups.is_group` looks like a candidate discriminator
  // but is only reliably 0 for rows the router itself created as a DM; the
  // schema default is also 0, so a name-based fallback keyed on it risks
  // merging two real, unrelated channels that happen to share a display name
  // — exactly what the operator said must never happen. There is no live case
  // that needs the fallback today (zero name collisions among the uncovered
  // rows), so it is left out rather than built speculatively.
  try {
    const dmRows = await getDb().all<{
      platform_id: string;
      channel_type: string;
      user_id: string;
      display_name: string | null;
    }>(
      `SELECT mg.platform_id AS platform_id, ud.channel_type AS channel_type, ud.user_id AS user_id,
              u.display_name AS display_name
         FROM user_dms ud
         JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
         LEFT JOIN users u ON u.id = ud.user_id`,
    );
    for (const r of dmRows) {
      const rawUserId = r.user_id.startsWith(`${r.channel_type}:`)
        ? r.user_id.slice(r.channel_type.length + 1)
        : r.user_id;
      const platformFamily = r.platform_id.split(':')[0] ?? r.channel_type;
      const key = `dm:${platformFamily}:${rawUserId}`;
      dmDedupeKey.set(r.platform_id, key);
      if (r.display_name && !names.has(key)) names.set(key, r.display_name);
    }
  } catch (err) {
    log.warn('threads: could not read user_dms directory', { err });
  }

  // A scheduled-task thread that never posted anywhere real (no
  // `task_thread_anchors` row — see `buildThreadList`) falls back to the
  // `system:tasks` bucket. It used to print the bare last segment, `tasks`,
  // which read as a peer of real channels; naming it here, through the same
  // `names` map every other channel resolves through, is the honest label the
  // operator asked for once anchored tasks stopped needing this bucket at all.
  //
  // NOT dead with the legacy shared SESSION gone. This key is a CHANNEL key,
  // not a thread id: `threadChannelKey` takes two segments for the `system`
  // platform (`EXTRA_SEGMENT_PLATFORMS` only widens Discord), so every live
  // per-series thread `system:tasks:<seriesId>` still collapses to exactly
  // `system:tasks` here. Removing this mapping would regress the label to the
  // bare `tasks` for currently-running tasks.
  if (!names.has(TASKS_SYSTEM_THREAD_ID)) names.set(TASKS_SYSTEM_THREAD_ID, 'Unrouted tasks');

  return { known, names, byId, dmDedupeKey };
}

/** Last segment of a channel key — the honest fallback when no wiring names it. */
function channelKeyLabel(key: string): string {
  const segments = key.split(':');
  return segments[segments.length - 1] || key;
}

/**
 * Every agent wired to a channel, indexed by `messaging_groups.platform_id` —
 * which is exactly what {@link threadChannelKey} resolves a thread id to.
 *
 * This is the whole answer to "which agents can this thread be handed to". An
 * agent not wired to the room cannot be made to speak in it (the rule
 * `observatory-steer.ts` already enforces per-send), so the assign selector and
 * the assign write path both read this one function rather than each deciding
 * what "wired" means.
 *
 * One query over the wiring table — tens to low hundreds of rows on a real
 * install, not one query per thread.
 */
export interface WiredAgent {
  agent_group_id: string;
  /** `agent_groups.name` — the infrastructure name. Display names resolve separately. */
  name: string;
  folder: string;
  messaging_group_id: string;
  session_mode: SessionMode;
}

export async function wiredAgentsByChannel(): Promise<Map<string, WiredAgent[]>> {
  const byChannel = new Map<string, WiredAgent[]>();
  let rows: (WiredAgent & { platform_id: string })[];
  try {
    // `session_mode` is per WIRING (messaging_group_agents), not per channel,
    // and the COALESCE default is `per-thread` — the operational default
    // `getMessagingGroupAgents` hydrates to, not the stale `shared` in the
    // CREATE TABLE. Reading it off `messaging_groups` would not even compile
    // against the real schema.
    rows = await getDb().all<WiredAgent & { platform_id: string }>(
      `SELECT mg.platform_id                          AS platform_id,
              mg.id                                   AS messaging_group_id,
              COALESCE(mga.session_mode,'per-thread') AS session_mode,
              ag.id                                   AS agent_group_id,
              ag.name                                 AS name,
              ag.folder                               AS folder
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups     ag ON ag.id = mga.agent_group_id`,
    );
  } catch (err) {
    log.warn('threads: wiring lookup failed', { err });
    return byChannel;
  }
  for (const r of rows) {
    const list = byChannel.get(r.platform_id) ?? [];
    // A sibling bot can be wired to one channel through two messaging groups;
    // the first one wins so the selector never lists the same agent twice.
    if (!list.some((a) => a.agent_group_id === r.agent_group_id)) {
      list.push({
        agent_group_id: r.agent_group_id,
        name: r.name,
        folder: r.folder,
        messaging_group_id: r.messaging_group_id,
        session_mode: r.session_mode,
      });
    }
    byChannel.set(r.platform_id, list);
  }
  return byChannel;
}

/* ─── Per-session probes ───────────────────────────────────────────────────── */

/**
 * `container_state` for one session, or null.
 *
 * Callers MUST gate this on the session actually having a live container — see
 * {@link liveContainerState}. Opening a per-session SQLite file is the single
 * most expensive thing on this path.
 */
export function readContainerState(agentGroupId: string, sessionId: string): ContainerState | null {
  try {
    // Read-only seam, never `withExistingMailboxSession`: the console must not
    // provision, migrate or schema-ensure a session it is only listing
    // (docs/specs/upstream-mailbox-seam/plan.md I-4). The two options restate
    // exactly what this probe did before the seam — the write path's 5s
    // busy_timeout, because this is one named live session rather than a fleet
    // fan-out, and the hot-journal rollback that keeps a SIGKILLed container's
    // outbound.db from failing every later read. A session with no mailbox
    // answers `undefined`, which is the same "nothing to show" as a null row.
    return (
      readSessionOutbound({ agentGroupId, sessionId }, (mailbox) => mailbox.getContainerState(), {
        busyTimeoutMs: 5000,
        recoverJournal: true,
      }) ?? null
    );
  } catch (err) {
    log.warn('threads: container_state probe failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * The bound (§4 of the brief, DESIGN §3.3/§4.1).
 *
 * We probe `container_state` only for sessions the host is currently running a
 * container process for. `getActiveContainerSessionIds()` is an in-memory Map
 * read in `container-runner.ts` — zero I/O.
 *
 * **DO NOT "optimize" this to a fresh-heartbeat gate.** That is the obvious
 * next narrowing and it silently deletes stall detection. The runner touches
 * `.heartbeat` once per provider event (`container/agent-runner/src/poll-loop.ts`,
 * the `touchHeartbeat()` call right after `handleEvent`), so a tool wedged for
 * 30 minutes emits no events and therefore no touches: **a stalled session's
 * heartbeat is stale by construction.** `host-sweep.ts` relies on exactly that
 * — a stale heartbeat is what makes it consult `container_state` at all. Gate
 * on freshness and the only rows you would ever probe are the healthy ones.
 *
 * A session with no live container cannot be `running` and cannot be `stalled`
 * either — its `container_state` row is a fossil from a container that already
 * exited, and a message to that agent wakes a fresh one regardless.
 *
 * Working set on the live install: tens of live containers against ~1,900
 * sessions in the 7d window, so this opens roughly 1% of the files a naive
 * implementation would.
 */
function liveContainerState(
  rows: ThreadSessionRow[],
  liveIds: ReadonlySet<string>,
  probe: (agentGroupId: string, sessionId: string) => ContainerState | null,
): Map<string, ContainerState> {
  const out = new Map<string, ContainerState>();
  for (const row of rows) {
    if (!liveIds.has(row.id)) continue;
    const state = probe(row.agent_group_id, row.id);
    if (state) out.set(row.id, state);
  }
  return out;
}

/* ─── Agent identity (§10.2) ───────────────────────────────────────────────── */

export interface AgentIdentity {
  agent_group_id: string;
  name: string;
  canonicalName: string;
  avatarUrl: string | null;
  provider: string;
}

interface IdentityKey {
  agentGroupId: string;
  messagingGroupId: string | null;
  sessionProvider: string | null;
}

const identityKey = (k: IdentityKey): string => `${k.agentGroupId}|${k.messagingGroupId ?? ''}`;

/**
 * Identity for exactly the agent groups that appear in the page.
 *
 * Keyed on `(agent_group_id, messaging_group_id)` because the same agent shows
 * a different bot display name per channel — resolving with `null` (what
 * `ObservatoryAgent.name` does) would print the infrastructure name on a row
 * whose Slack message is signed with the bot's channel display name — the two
 * routinely differ. There are ~20 agents and a handful of channels each,
 * so the memo is small and every miss costs one `readContainerConfig` read.
 */
async function resolveIdentities(
  pairs: Array<IdentityKey>,
  avatarByChannelType: (channelType: string) => string | null,
): Promise<Map<string, AgentIdentity>> {
  const wanted = new Map<string, IdentityKey>();
  for (const p of pairs) wanted.set(identityKey(p), p);
  if (wanted.size === 0) return new Map();

  const agentIds = [...new Set([...wanted.values()].map((p) => p.agentGroupId))];
  const groups = new Map(
    (
      await getDb().all<AgentGroup>(
        `SELECT * FROM agent_groups WHERE id IN (${agentIds.map(() => '?').join(', ')})`,
        ...agentIds,
      )
    ).map((g) => [g.id, g]),
  );

  // One query for every participating agent's wired channel types, then the
  // avatar registry lookup — the per-agent query observatory.ts runs would be
  // ~20 round trips here.
  const avatars = new Map<string, string | null>();
  try {
    const rows = await getDb().all<{ agent_group_id: string; channel_type: string }>(
      `SELECT mga.agent_group_id AS agent_group_id, mg.channel_type AS channel_type
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
        WHERE mga.agent_group_id IN (${agentIds.map(() => '?').join(', ')})`,
      ...agentIds,
    );
    for (const r of rows) {
      if (avatars.get(r.agent_group_id)) continue;
      avatars.set(r.agent_group_id, avatarByChannelType(r.channel_type));
    }
  } catch (err) {
    log.warn('threads: avatar lookup failed', { err });
  }

  const out = new Map<string, AgentIdentity>();
  await Promise.all(
    [...wanted.entries()].map(async ([key, pair]) => {
      const group = groups.get(pair.agentGroupId);
      if (!group) return;
      let name = group.name;
      // `sessions.agent_provider` → `container_configs.provider` → 'claude',
      // via the one function that owns that precedence. NOT
      // `agent_groups.agent_provider`, which is @deprecated in types.ts.
      let provider = resolveProviderName(pair.sessionProvider, (await getContainerConfig(group.id))?.provider);
      try {
        const config = readContainerConfig(group.folder);
        // container.json is authoritative for the runtime (see CLAUDE.md
        // "Container Config"), so it wins over the DB projection when set.
        provider = resolveProviderName(pair.sessionProvider, config.provider ?? provider);
        name = await resolveAssistantName(group, config, pair.messagingGroupId);
      } catch (err) {
        // A missing container.json must never blank a row — the infrastructure
        // name is always a correct, if less friendly, answer.
        log.warn('threads: identity resolution fell back to agent_groups.name', {
          agentGroupId: pair.agentGroupId,
          err,
        });
      }
      out.set(key, {
        agent_group_id: group.id,
        name,
        canonicalName: group.name,
        avatarUrl: avatars.get(group.id) ?? null,
        provider,
      });
    }),
  );
  return out;
}

/* ─── Claims (§5) ──────────────────────────────────────────────────────────── */

/**
 * Claims for every workgroup the page touches, indexed by thread.
 *
 * Three of the states (`needs_you`, `parked`, and half of `done`) are
 * claim-derived, and claims are per-workgroup files rather than DB rows. One
 * directory scan per workgroup — a handful — not one per thread.
 */
export async function readClaimsByThread(
  agentGroupIds: string[],
  now: number,
  claimsRoot?: string,
): Promise<Map<string, BoardClaim>> {
  const byThread = new Map<string, BoardClaim>();
  if (agentGroupIds.length === 0) return byThread;
  let workgroupIds: string[];
  try {
    workgroupIds = (
      await getDb().all<{ workgroup_id: string }>(
        `SELECT DISTINCT workgroup_id FROM agent_groups
          WHERE workgroup_id IS NOT NULL AND id IN (${agentGroupIds.map(() => '?').join(', ')})`,
        ...agentGroupIds,
      )
    ).map((r) => r.workgroup_id);
  } catch (err) {
    log.warn('threads: workgroup lookup for claims failed', { err });
    return byThread;
  }
  for (const wg of workgroupIds) {
    const claims = claimsRoot !== undefined ? readClaims(wg, now, claimsRoot) : readClaims(wg, now);
    for (const c of claims) {
      if (!c.threadId) continue;
      const existing = byThread.get(c.threadId);
      // Parked outranks a live claim on the same thread: it is the one that
      // names a state the operator has to act on.
      if (!existing || (existing.state !== 'parked' && c.state === 'parked')) byThread.set(c.threadId, c);
    }
  }
  return byThread;
}

/* ─── Task-thread anchors (DEFECT 1, continued 2026-08-21) ─────────────────── */

/** One session's most-recently-created `task_thread_anchors` row. */
export interface TaskAnchor {
  platformId: string;
  atMs: number;
}

/**
 * `task_thread_anchors.session_id → the channel it most recently posted in`
 * (migration 048). `system:tasks:<seriesId>` carries no `messaging_group_id` —
 * that is exactly why it fell into the fake `tasks` bucket in the first place
 * (see the comment on the synthetic-thread branch in `buildThreadList`) — but
 * a task that has actually POSTED leaves a per-post row here, in real
 * channel-key shape (`platform_id`), which is the thing that lets it live in
 * its real channel instead.
 *
 * Coverage is partial by construction: verified live (2026-08-21), only 63 of
 * 135 `system:tasks:*` sessions have ever posted anywhere, because a task that
 * never ran to a successful delivery genuinely has no channel to belong to —
 * that is the `system:tasks` fallback bucket's whole reason to still exist,
 * not a gap to paper over.
 *
 * One query for the whole page's session ids — never one per thread, same
 * rule `liveContainerState` already enforces for `container_state`.
 */
async function readTaskThreadAnchors(sessionIds: string[]): Promise<Map<string, TaskAnchor>> {
  const bySession = new Map<string, TaskAnchor>();
  if (sessionIds.length === 0) return bySession;
  let rows: { session_id: string; platform_id: string; created_at: string }[];
  try {
    rows = await getDb().all<{ session_id: string; platform_id: string; created_at: string }>(
      `SELECT session_id, platform_id, created_at FROM task_thread_anchors
        WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`,
      ...sessionIds,
    );
  } catch (err) {
    log.warn('threads: task_thread_anchors lookup failed', { err });
    return bySession;
  }
  for (const r of rows) {
    // A single session can carry more than one anchor row — verified live,
    // two sessions each have two, because a recurring series can get
    // re-pointed to a different channel between runs. Most recent wins: that
    // is the channel it is CURRENTLY posting to, which is the question being
    // asked here, not "everywhere it has ever posted".
    const atMs = parseUtcTimestampMs(r.created_at) ?? -Infinity;
    const existing = bySession.get(r.session_id);
    if (!existing || atMs > existing.atMs) bySession.set(r.session_id, { platformId: r.platform_id, atMs });
  }
  return bySession;
}

/**
 * The channel a scheduled-task THREAD is currently anchored to, or null when
 * it has never posted. A thread can in principle carry more than one session
 * (§3.1 — nothing stops two agent groups sharing a series id), so the
 * tie-break is the same "most recent wins" rule as within a single session's
 * anchors, just applied across every session in the thread rather than one.
 */
function threadAnchorChannel(rows: ThreadSessionRow[], anchors: ReadonlyMap<string, TaskAnchor>): string | null {
  let best: TaskAnchor | null = null;
  for (const row of rows) {
    const a = anchors.get(row.id);
    if (a && (!best || a.atMs > best.atMs)) best = a;
  }
  return best?.platformId ?? null;
}

/**
 * The channel a scheduled-task thread is ROUTED to — `sessions.task_routing_platform_id`,
 * stamped at task-definition time (migration 056) — or null when nothing
 * stamped it.
 *
 * **This is not the same question `threadAnchorChannel` answers, and that is
 * why it loses to it.** `ncl tasks`' own contract is that "the agent chooses
 * delivery destination at fire time"; the stamp is only the default landing
 * place for an unaddressed reply. So a series can post somewhere other than
 * its stamp, and a series that was re-pointed between runs certainly does.
 * The anchor is a record of where a post ACTUALLY landed, the stamp is a
 * record of where one would land by default — the record of fact must win, or
 * the console shows a re-pointed series in the room it has stopped posting to.
 * Do not "simplify" the precedence by dropping one of the two.
 *
 * Costs no query: the column rides along on the `sessions` SELECT the list
 * already runs. Same cross-session tie-break as the anchors (§3.1 allows a
 * thread to carry more than one session), keyed on session `created_at` since
 * the stamp itself carries no timestamp.
 */
function threadRoutingChannel(rows: ThreadSessionRow[]): string | null {
  let best: { platformId: string; atMs: number } | null = null;
  for (const row of rows) {
    if (!row.task_routing_platform_id) continue;
    const atMs = parseUtcTimestampMs(row.created_at) ?? -Infinity;
    if (!best || atMs > best.atMs) best = { platformId: row.task_routing_platform_id, atMs };
  }
  return best?.platformId ?? null;
}

/* ─── Attention sources (§2, §5 `unassigned`, §10) ─────────────────────────── */

/**
 * The ownerless work items this caller may see, under this request's filters.
 *
 * §5 records `unassigned` as unreachable "until the release-board/findings
 * join in §10 lands" — this is that join, and it is deliberately the ONLY
 * place a row enters the queue without a session behind it.
 *
 * Every filter here is a NARROWING term intersected with the caller's ceiling,
 * exactly like `selectScopedSessions` (§2a/§3.5): an unknown or out-of-scope
 * workgroup yields zero items rather than a 403.
 *
 * `group_id` yields nothing at all, and that is correct rather than a gap. An
 * agent-group filter asks "what is THIS agent on"; an ownerless item is
 * definitionally on no agent, so including it would answer a question the
 * operator did not ask. The workgroup axis — §3.5's primary one — is the axis
 * these items actually have.
 *
 * **`since_hours` never excludes one of these rows, at any value — not a
 * generous default, none at all.** That window is a working-set filter for
 * session-backed threads (§3.3): a conversation nobody has spoken in for a
 * week is stale and belongs out of view. An ownerless item is the opposite of
 * stale — it is blocked ON A HUMAN, so the longer it has waited the MORE it
 * needs surfacing, never less. Two production items sat unclaimed for 21-22
 * days before that was noticed (operator report 2026-08-20), and that
 * invisibility was the entire reason this join exists; running the same
 * recency cutoff over these rows exactly inverts their semantics and would
 * silently reintroduce the bug this feed was built to fix. So the loop below
 * never computes a cutoff — an unparseable `since` needs no special case for
 * that reason either: age decides SORT order only (§12 — an unmeasured value
 * sorts last, never a zero), and, now, so does every OTHER age. Every other
 * narrowing above (scope, workgroup, `group_id`, §2a absent-not-403) still
 * applies unchanged.
 */
export async function selectScopedAttentionItems(
  ctx: AuthedRequestContext,
  opts: { workgroupId?: string | null; groupId: string | null; sinceHours: number | null; threadId?: string | null },
  now: number,
  env: AttentionSourceEnv,
): Promise<AttentionItem[]> {
  const empty: AttentionItem[] = [];
  if (opts.groupId) return empty;

  let workgroupIds: string[];
  if (ctx.scopes.no_filter) {
    workgroupIds = await workgroupIdsWithAttentionSources();
  } else {
    if (ctx.scopes.allowed_group_ids.length === 0) return empty;
    workgroupIds = await workgroupIdsForAgentGroups(ctx.scopes.allowed_group_ids);
  }
  if (opts.workgroupId) workgroupIds = workgroupIds.filter((id) => id === opts.workgroupId);
  if (workgroupIds.length === 0) return empty;

  const items: AttentionItem[] = [];
  for (const wg of workgroupIds) {
    for (const item of (await readAttentionItems(wg, now, env)).items) {
      // `threadId` narrows to that one row (detail/assign path); every other
      // item is in scope regardless of `since` — see the doc comment above.
      // `opts.sinceHours` is deliberately never read here.
      if (opts.threadId) {
        if (item.id === opts.threadId) items.push(item);
        continue;
      }
      items.push(item);
    }
  }
  return items;
}

/* ─── Assembly ─────────────────────────────────────────────────────────────── */

/** Liveness ordering: the freshest wins when a thread's sessions disagree. */
const STATUS_RANK: Record<ContainerStatus, number> = { running: 3, idle: 2, stale: 1, unknown: 0 };

export interface ThreadListDeps {
  now?: number;
  /** Session ids the host currently holds a container process for. */
  activeContainerSessionIds?: () => string[];
  containerStatus?: (agentGroupId: string, sessionId: string) => ContainerStatus;
  containerState?: (agentGroupId: string, sessionId: string) => ContainerState | null;
  /** Injected claims root for tests; defaults to readClaims' own live base dir. */
  claimsRoot?: string;
  avatarByChannelType?: (channelType: string) => string | null;
  /** Wiring lookup for the assign selector; defaults to {@link wiredAgentsByChannel}. */
  wiredAgents?: () => Map<string, WiredAgent[]> | Promise<Map<string, WiredAgent[]>>;
  /** Injected roots for attention sources (tests); defaults to the live ones. */
  attentionEnv?: AttentionSourceEnv;
}

function activityMs(row: ThreadSessionRow): number {
  return Math.max(
    parseUtcTimestampMs(row.last_outbound_at) ?? -Infinity,
    parseUtcTimestampMs(row.last_active) ?? -Infinity,
    parseUtcTimestampMs(row.created_at) ?? -Infinity,
  );
}

/** Which of §5's two `needsOperator` sub-causes a single session is sitting on, if either. */
type NeedsOperatorCause = 'task_needs_input' | 'ask_question';

function sessionNeedsOperatorCause(row: ThreadSessionRow): NeedsOperatorCause | null {
  if (row.attached_task_needs_input === 1) return 'task_needs_input';
  if (
    row.last_outbound_kind === 'chat-sdk:ask_question' &&
    (parseUtcTimestampMs(row.last_active) ?? 0) < (parseUtcTimestampMs(row.last_outbound_at) ?? 0)
  ) {
    return 'ask_question';
  }
  return null;
}

/**
 * §5 / sessions.ts: this session is sitting on an unanswered question.
 *
 * A thin boolean wrapper around {@link sessionNeedsOperatorCause} — one
 * predicate, not two copies of it, so `deriveThreadState`'s gate and
 * `deriveNeedsYouReason`'s cause can never quietly disagree about what counts.
 */
function sessionNeedsOperator(row: ThreadSessionRow): boolean {
  return sessionNeedsOperatorCause(row) !== null;
}

/** Generic, honest text for the two causes with no per-row content to quote (see {@link deriveNeedsYouReason}). */
const ASK_QUESTION_REASON_TEXT = 'The agent asked a question and is waiting for a reply.';
const TASK_NEEDS_INPUT_REASON_TEXT = 'A running task needs input to continue.';

/**
 * {@link ThreadSummary.needs_you_reason} — WHY a `needs_you` row is `needs_you`.
 *
 * An operator opened a `needs_you` thread whose newest message was a
 * completion report and read the flag as a false positive; the real cause was
 * a parked claim's note (operator report 2026-08-21). §5 derives `needs_you`
 * from three distinct causes and this file surfaced none of them — this
 * function is the fix, and it is deliberately a separate pass over the same
 * inputs `deriveThreadState` already resolved, not a rider bolted onto that
 * function's return value, so a caller that only wants the state keeps paying
 * nothing for the reason.
 *
 * Mirrors `deriveThreadState`'s own precedence — claim note first, then
 * whichever session in activity order actually tripped
 * {@link sessionNeedsOperatorCause} — so this can only ever explain a
 * `needs_you` this module actually computed, never a different reading of it.
 *
 * **Text is never fabricated.** Cause 1 quotes the claim note verbatim — the
 * operator (or another agent) wrote it, and it is already a headline
 * (`noteHeadline`, capped at 200 chars) by the time it reaches here. Cause 3
 * quotes the worker's own `steer_question` when it gave one — real text it
 * actually wrote, not invented — and falls back to a plain statement when it
 * didn't. Cause 2 has no per-row question text available at all: the actual
 * `ask_question` content lives in the session's own per-agent DB file, and
 * §4.1 is explicit that opening those per row is a cost this list endpoint
 * does not pay; the text says only what is actually known, that a question is
 * pending.
 *
 * Returns null when none of the three causes explains it — never a guess.
 */
export function deriveNeedsYouReason(
  ordered: ThreadSessionRow[],
  claim: { state: BoardClaim['state'] | null; note: string; staleMs?: number },
): NeedsYouReason | null {
  if (claim.state === 'parked' && WAITING_ON_NOTE.test(claim.note)) {
    // `BoardClaim.staleMs` for a PARKED claim is `now - parked_at`
    // (claims-board.ts), and it is 0 when `parked_at` is missing or
    // unparseable — which is "unmeasured", not "just now". See the field.
    const parkedMs = typeof claim.staleMs === 'number' && claim.staleMs > 0 ? claim.staleMs : null;
    return { cause: 'parked_note', text: claim.note, parked_ms: parkedMs };
  }
  for (const row of ordered) {
    const cause = sessionNeedsOperatorCause(row);
    if (cause === 'task_needs_input') {
      return { cause, text: row.attached_task_steer_question?.trim() || TASK_NEEDS_INPUT_REASON_TEXT };
    }
    if (cause === 'ask_question') return { cause, text: ASK_QUESTION_REASON_TEXT };
  }
  return null;
}

/**
 * The thread's standing close proposal — the freshest one across its sessions.
 *
 * Pure and exported so the "only an agent can produce this" rule is directly
 * testable: the ONLY input is the mirrored `done_proposal` column, an
 * unparseable or empty value yields null rather than a default, and there is
 * no branch that constructs one from anything else. A thread with six agents
 * on it needs one answer, and the newest statement is the current one.
 */
export function pickDoneProposal(ordered: ThreadSessionRow[]): ThreadDoneProposal | null {
  let best: ThreadDoneProposal | null = null;
  let bestAt = -Infinity;
  for (const row of ordered) {
    if (!row.done_proposal) continue;
    let parsed: { reason?: unknown; proposed_at?: unknown };
    try {
      parsed = JSON.parse(row.done_proposal) as { reason?: unknown; proposed_at?: unknown };
    } catch {
      continue;
    }
    if (typeof parsed.reason !== 'string' || parsed.reason.trim() === '') continue;
    if (typeof parsed.proposed_at !== 'string') continue;
    const at = parseUtcTimestampMs(parsed.proposed_at);
    if (at === null || at <= bestAt) continue;
    bestAt = at;
    best = {
      reason: parsed.reason.trim(),
      proposed_at: new Date(at).toISOString(),
      agent_group_id: row.agent_group_id,
      session_id: row.id,
    };
  }
  return best;
}

/**
 * Which session a reply to this thread should land in by default (§10.3).
 *
 * Pure and exported because this is the seam the whole action bar hangs off:
 * a thread is N inbound queues and the steer path writes to exactly one, so
 * picking the wrong one sends the operator's answer to an agent that never
 * asked. "The agent whose state drove the row's urgency" is the rule; the
 * fallback is the most recently active session, which is `ordered[0]` because
 * the caller already sorted by activity.
 *
 * `pickedSessionId` is the session whose `container_state` the row is
 * rendering — the failed one, or the one holding a tool. It is null whenever
 * no session was probed.
 */
export function replyTargetSessionId<T extends { id: string }>(
  state: ThreadState,
  ordered: T[],
  opts: { needsOperator: (row: T) => boolean; pickedSessionId: string | null },
): string | null {
  if (state === 'needs_you') {
    const asked = ordered.find((r) => opts.needsOperator(r));
    if (asked) return asked.id;
  }
  if ((state === 'stalled' || state === 'running') && opts.pickedSessionId) return opts.pickedSessionId;
  return ordered[0]?.id ?? null;
}

interface ThreadAccum {
  threadId: string;
  synthetic: boolean;
  rows: ThreadSessionRow[];
}

/** Group scoped session rows by thread id, folding NULL threads to `session:<id>`. */
function groupByThread(rows: ThreadSessionRow[]): ThreadAccum[] {
  const byThread = new Map<string, ThreadAccum>();
  for (const row of rows) {
    // A NULL thread_id is real work — a task session that never got a platform
    // thread — so it gets a synthetic per-session key rather than being dropped
    // or folded into one giant "no thread" row.
    const synthetic = !row.thread_id;
    const key = row.thread_id ?? `session:${row.id}`;
    const existing = byThread.get(key);
    if (existing) existing.rows.push(row);
    else byThread.set(key, { threadId: key, synthetic, rows: [row] });
  }
  return [...byThread.values()];
}

/**
 * The console's thread queue.
 *
 * ## How a scheduled-task thread gets its channel
 *
 * A `system:tasks:<seriesId>` session carries no `messaging_group_id` — that
 * NULL is `src/delivery.ts`'s discriminator for "this is a task session" and
 * must stay NULL — so the channel is resolved in three steps, most-truthful
 * first:
 *
 *   a. `task_thread_anchors` — where the series MOST RECENTLY POSTED, reduced
 *      by `created_at` across every session in the thread. A record of fact.
 *   b. `sessions.task_routing_platform_id` — the routing stamp written at
 *      task-definition time (migration 056): where an unaddressed reply lands
 *      by default. A record of intent, and only that: `ncl tasks` lets the
 *      agent pick a different destination at fire time.
 *   c. neither — the `system:tasks` bucket, labeled "Unrouted tasks". A task
 *      that never posted and was scheduled with no routing genuinely has no
 *      channel, and §4.1 says absent is honest, never invented.
 *
 * (a) beating (b) is not cosmetic. A re-pointed series' stamp still names its
 * old home while its anchors name the new one, and the console must show where
 * the work is landing now.
 *
 * Neither (a) nor (b) costs an extra query per row: the anchors are one
 * batched lookup for the whole page (`readTaskThreadAnchors`) and the stamp
 * rides along on the `sessions` SELECT.
 */
export async function buildThreadList(
  ctx: AuthedRequestContext,
  opts: {
    /** Primary axis — every agent group carrying this `workgroup_id`, intersected with scope. */
    workgroupId?: string | null;
    groupId: string | null;
    includeArchived: boolean;
    sinceHours: number | null;
    limit: number;
    /** Number of grouped session threads to skip before collecting this page. */
    offset?: number;
    threadId?: string | null;
  },
  deps: ThreadListDeps = {},
): Promise<{ threads: ThreadSummary[] }> {
  const now = deps.now ?? Date.now();
  const statusOf = deps.containerStatus ?? deriveContainerStatus;
  const probeState = deps.containerState ?? readContainerState;
  const avatarLookup = deps.avatarByChannelType ?? ((ct: string) => getKnownSlackBots().get(ct)?.imageUrl ?? null);

  // Ownerless work items (§2, §5 `unassigned`) — read BEFORE the session query
  // so an install whose only blocked work is on a board still gets a queue.
  // The reader is memoized (`ATTENTION_MEMO_TTL_MS`); this is not a file open
  // per poll.
  const attentionItems = await selectScopedAttentionItems(ctx, opts, now, deps.attentionEnv ?? {});

  const rows = await selectScopedSessions(ctx, opts, now);
  if (rows.length === 0 && attentionItems.length === 0) return { threads: [] };

  const { known, names, byId, dmDedupeKey } = await readChannelDirectory();
  const grouped = groupByThread(rows)
    .map((t) => ({ ...t, activity: Math.max(...t.rows.map(activityMs)) }))
    .sort((a, b) => b.activity - a.activity || a.threadId.localeCompare(b.threadId))
    .slice(0, opts.limit);

  const pagedRows = grouped.flatMap((t) => t.rows);
  const liveIds = new Set((deps.activeContainerSessionIds ?? getActiveContainerSessionIds)());
  const states = liveContainerState(pagedRows, liveIds, probeState);
  const claims = await readClaimsByThread([...new Set(pagedRows.map((r) => r.agent_group_id))], now, deps.claimsRoot);
  // One query for every task-thread session on the page — never one per
  // thread. See `readTaskThreadAnchors`.
  const taskAnchors = await readTaskThreadAnchors(
    pagedRows.filter((r) => r.thread_id && isScheduledTaskThread(r.thread_id)).map((r) => r.id),
  );

  // Channel keys are needed BEFORE identity resolution now, because the wired
  // agents a thread can be handed to are resolved for display through the same
  // memo as its participants — one pass, not two conventions for a bot's name.
  //
  // A synthetic thread (§3.1: `sessions.thread_id IS NULL`) has no thread_id
  // for `threadChannelKey` to parse — there is nothing to parse — so the old
  // code passed `null` and always landed on UNKNOWN_CHANNEL_KEY even though
  // the session's own `messaging_group_id` often resolves the same channel a
  // real thread on that room would (DEFECT 1, operator report 2026-08-20,
  // verified against the live DB: most of these are old per-agent-group
  // bootstrap sessions with a real `messaging_group_id`, not `ncl tasks` runs —
  // see {@link isScheduledTaskThread} below for the actually task-shaped
  // thread_ids, which carry no messaging_group_id at all and so cannot be
  // recovered this way). `groupByThread` keys a synthetic accum by
  // `session:<id>`, so it is always exactly one row.
  //
  // This is deliberately NOT a call into `threadChannelKey` with the synthetic
  // `session:<id>` pseudo-id — that id is not a real platform shape, and
  // parsing it would mint a per-row bucket, exactly what §3.2 says never to do.
  //
  // A scheduled-task thread (DEFECT 1, continued 2026-08-21) is neither of the
  // above: it has a real thread_id (`system:tasks:<seriesId>`), so
  // `threadChannelKey` WOULD parse it — straight to the `system:tasks` fake
  // bucket, since these sessions never carry a `messaging_group_id` either.
  // `task_thread_anchors` is the one place the real destination survives, so
  // it is tried FIRST for a task thread, and only falls through to
  // `threadChannelKey`'s `system:tasks` bucket when the thread has never
  // posted anywhere (§4.1 doctrine: absent is honest, never invented).
  const channelKeys = new Map(
    grouped.map((t) => {
      if (t.synthetic) {
        const mgId = t.rows[0]?.messaging_group_id;
        const platformId = mgId ? byId.get(mgId) : undefined;
        return [t.threadId, platformId ?? UNKNOWN_CHANNEL_KEY] as const;
      }
      if (isScheduledTaskThread(t.threadId)) {
        // Precedence is (a) anchor, (b) routing stamp, (c) fallback bucket,
        // and the ORDER IS LOAD-BEARING — see `threadRoutingChannel`. The
        // anchor is where a post actually landed; the stamp is only where an
        // unaddressed reply would land by default, and the agent chooses its
        // destination at fire time. A series re-pointed between runs must
        // resolve to where it is actually posting, so fact outranks default.
        const anchored = threadAnchorChannel(t.rows, taskAnchors);
        if (anchored) return [t.threadId, anchored] as const;
        const routed = threadRoutingChannel(t.rows);
        if (routed) return [t.threadId, routed] as const;
      }
      return [t.threadId, threadChannelKey(t.threadId, known)] as const;
    }),
  );
  const wiredByChannel = await (deps.wiredAgents ?? wiredAgentsByChannel)();
  const inScope = (agentGroupId: string): boolean =>
    ctx.scopes.no_filter || ctx.scopes.allowed_group_ids.includes(agentGroupId);

  const identities = await resolveIdentities(
    [
      ...pagedRows.map((r) => ({
        agentGroupId: r.agent_group_id,
        messagingGroupId: r.messaging_group_id,
        sessionProvider: r.agent_provider,
      })),
      ...[...new Set([...channelKeys.values(), ...attentionItems.map((i) => i.channel_key)])].flatMap((key) =>
        (wiredByChannel.get(key) ?? [])
          .filter((a) => inScope(a.agent_group_id))
          .map((a) => ({
            agentGroupId: a.agent_group_id,
            messagingGroupId: a.messaging_group_id,
            sessionProvider: null,
          })),
      ),
    ],
    avatarLookup,
  );
  // One query for the whole page's snoozes, never one per row. Per-user by
  // construction — see thread-snooze.ts on why this is not archive.
  //
  // SESSION THREADS ONLY. `thread_snoozes` has exactly one writer
  // (`threadSnoozeHandler`), and it refuses any id that resolves to no row in
  // `sessions` — which every `board:` attention id does, by construction. So no
  // snooze row for an attention item can exist, and asking for one was a
  // parameter the query could never match. Attention rows report `snoozed:
  // false` below for the same reason, and the console does not offer the verb
  // on them (`isOwnerlessItem` in the triage panel and the detail actions).
  const snoozes = await readThreadSnoozes(
    ctx.user.id,
    grouped.map((t) => t.threadId),
  );
  // Same rule: one query for the page's in-flight closes, never one per row.
  // Fleet-wide (not per-user) — a close is a decision about the WORK, unlike a
  // snooze, so every operator looking at the row must see that it is closing.
  const closures: Map<string, ThreadCloseState> = await readThreadClosures(grouped.map((t) => t.threadId));
  // Same rule again: one query for every attention item on the page. Empty when
  // there are none, which is every install that declares no attention source.
  const assignments = await readItemAssignments([...new Set(attentionItems.map((i) => i.workgroupId))]);
  const assignerNames = await readUserDisplayNames([...new Set([...assignments.values()].map((a) => a.assignedBy))]);

  const threads: ThreadSummary[] = grouped.map((thread) => {
    const ordered = [...thread.rows].sort((a, b) => activityMs(b) - activityMs(a));

    const participants: ThreadParticipant[] = [];
    const seenAgents = new Set<string>();
    for (const row of ordered) {
      if (seenAgents.has(row.agent_group_id)) continue;
      seenAgents.add(row.agent_group_id);
      const id = identities.get(
        identityKey({
          agentGroupId: row.agent_group_id,
          messagingGroupId: row.messaging_group_id,
          sessionProvider: row.agent_provider,
        }),
      );
      participants.push({
        agent_group_id: row.agent_group_id,
        name: id?.name ?? row.agent_group_id,
        // `ordered` is activity-desc and this loop takes the first row per
        // agent, so this is that agent's freshest session on the thread.
        session_id: row.id,
        avatarUrl: id?.avatarUrl ?? null,
        provider: id?.provider ?? resolveProviderName(row.agent_provider, null),
      });
    }

    // §4: the title is generated per session, so siblings on one thread each
    // hold their own. The freshest one wins; `title_generated_at` is the stamp
    // the title sweep writes, and it falls back to session activity when an
    // older row predates that column being populated.
    let title: string | null = null;
    let titleAt = -Infinity;
    for (const row of ordered) {
      if (!row.title) continue;
      const at = parseUtcTimestampMs(row.title_generated_at) ?? activityMs(row);
      if (at > titleAt) {
        titleAt = at;
        title = row.title;
      }
    }

    let containerStatus: ContainerStatus = 'unknown';
    for (const row of ordered) {
      const s = statusOf(row.agent_group_id, row.id);
      if (STATUS_RANK[s] > STATUS_RANK[containerStatus]) containerStatus = s;
    }

    // The most interesting container_state across the thread: a failed provider
    // outranks a tool in flight, which outranks anything idle.
    let picked: ContainerState | null = null;
    // Which session `picked` came from — the Kill/Steer target when this row is
    // stalled or running (§10.3). Tracked alongside rather than re-derived,
    // because "the container_state we rendered" and "the session that owns it"
    // must never disagree.
    let pickedSessionId: string | null = null;
    for (const row of ordered) {
      const s = states.get(row.id);
      if (!s) continue;
      if (!picked) {
        picked = s;
        pickedSessionId = row.id;
      } else if (s.provider_status === 'failed') {
        picked = s;
        pickedSessionId = row.id;
      } else if (picked.provider_status !== 'failed' && !picked.tool_started_at && s.tool_started_at) {
        picked = s;
        pickedSessionId = row.id;
      }
    }

    // Hoisted out of the return literal: TypeScript's control-flow analysis
    // narrows `picked` to `never` when it is read after the arrow functions
    // below, and reading it once here is clearer than three `?.` chains anyway.
    const providerStatus: string | null = picked?.provider_status ?? null;
    const currentTool: string | null = picked?.current_tool ?? null;
    const toolStartedAt: string | null = isoOrNull(picked?.tool_started_at);
    const toolStartedAtMs: number | null = parseUtcTimestampMs(picked?.tool_started_at);

    const lastOutputAtMs = ordered.reduce<number | null>((acc, row) => {
      const ms = parseUtcTimestampMs(row.last_outbound_at);
      return ms !== null && (acc === null || ms > acc) ? ms : acc;
    }, null);
    const lastActivity = ordered[0]
      ? (ordered[0].last_outbound_at ?? ordered[0].last_active ?? ordered[0].created_at)
      : null;
    const claim = claims.get(thread.threadId) ?? null;
    // Wiring lookups (assignable_agents, and the identity fan-out above) key
    // off the RAW platform_id — that is what `messaging_group_agents` is
    // actually wired against, and DM dedupe (below) must never change which
    // agents a thread can be handed to.
    const channelKey = channelKeys.get(thread.threadId) ?? UNKNOWN_CHANNEL_KEY;
    // DEFECT 2 (operator report, 2026-08-20): the WIRE-facing channel identity
    // collapses two DM rooms with the same human on the other end into one key
    // — see the comment on `dmDedupeKey` in `readChannelDirectory`. Never used
    // for wiring lookups, only for what the row and the sidebar display.
    const displayChannelKey = dmDedupeKey.get(channelKey) ?? channelKey;

    const onThread = new Set(participants.map((p) => p.agent_group_id));
    const assignableAgents: ThreadAgentOption[] = (wiredByChannel.get(channelKey) ?? [])
      .filter((a) => !onThread.has(a.agent_group_id) && inScope(a.agent_group_id))
      .map((a) => ({
        agent_group_id: a.agent_group_id,
        name:
          identities.get(
            identityKey({
              agentGroupId: a.agent_group_id,
              messagingGroupId: a.messaging_group_id,
              sessionProvider: null,
            }),
          )?.name ?? a.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const state = deriveThreadState({
      sessionCount: ordered.length,
      claimState: claim?.state ?? null,
      claimNote: claim?.note ?? '',
      needsOperator: ordered.some(sessionNeedsOperator),
      containerStatus,
      providerStatus,
      toolStartedAtMs,
      lastOutputAtMs,
      now,
    });
    const lastActivityAt = isoOrNull(lastActivity);
    const doneProposal = pickDoneProposal(ordered);
    const closure = closures.get(thread.threadId);
    // Gated on `state` defensively, in addition to `deriveNeedsYouReason`'s own
    // same-inputs derivation: a reason must never ride on a row this module
    // did not itself call `needs_you` (see the field's own doc).
    const needsYouReason =
      state === 'needs_you'
        ? deriveNeedsYouReason(ordered, {
            state: claim?.state ?? null,
            note: claim?.note ?? '',
            staleMs: claim?.staleMs,
          })
        : null;

    return {
      thread_id: thread.threadId,
      synthetic: thread.synthetic,
      channel_key: displayChannelKey,
      channel_name: names.get(displayChannelKey) ?? channelKeyLabel(displayChannelKey),
      title,
      participants,
      assignable_agents: assignableAgents,
      last_activity_at: lastActivityAt,
      state,
      needs_you_reason: needsYouReason,
      session_ids: ordered.map((r) => r.id),
      container_status: containerStatus,
      provider_status: providerStatus,
      current_tool: currentTool,
      tool_started_at: toolStartedAt,
      reply_target_session_id: replyTargetSessionId(state, ordered, {
        needsOperator: sessionNeedsOperator,
        pickedSessionId,
      }),
      snoozed: snoozes.has(thread.threadId) && isSnoozed(snoozes.get(thread.threadId), lastActivityAt),
      scheduled_task: isScheduledTaskThread(thread.threadId),
      done_proposal: doneProposal,
      closing: closure !== undefined && closure.state !== 'closed',
      close_confirmations_required: requiredConfirmations(doneProposal !== null),
    };
  });

  /**
   * The standing assignment on one attention item, resolved for display and
   * split by freshness.
   *
   * The agent's name comes from the SAME identity memo a participant's does
   * (per `(agent, messaging_group)`, §10.2) rather than `agent_groups.name` —
   * a row that said `<workgroup>-<role>` where the room shows a friendly name
   * would be the exact defect §10.2 records. Falls back to the wiring's own
   * name, then to the id, so a row never renders blank.
   *
   * Applies the SAME staleness window the write side already enforces
   * (`ASSIGN_DEDUPE_MS`, via `reserveItemAssignment`'s upsert `WHERE`): a
   * reservation older than that is exactly what an assign attempt would
   * already overwrite, so the read side must agree rather than going on
   * presenting it as live. This is what stops a merged-then-reopened board
   * item (nothing deletes the row when the PR merges and the item stops being
   * emitted) from rendering as still assigned to whoever claimed it, possibly
   * days earlier, with no fresh dispatch behind it — the row goes back to
   * `assigned_expired` instead, never deleted, never mutated.
   */
  const assignmentOf = (
    item: AttentionItem,
  ): { assigned: ThreadItemAssignment | null; assigned_expired: ThreadItemAssignment | null } => {
    const found = assignments.get(assignmentKey(item.workgroupId, stripAttentionItemPrefix(item.id)));
    if (!found) return { assigned: null, assigned_expired: null };
    const wiring = (wiredByChannel.get(item.channel_key) ?? []).find((a) => a.agent_group_id === found.agentGroupId);
    const identity = wiring
      ? identities.get(
          identityKey({
            agentGroupId: found.agentGroupId,
            messagingGroupId: wiring.messaging_group_id,
            sessionProvider: null,
          }),
        )
      : undefined;
    const resolved: ThreadItemAssignment = {
      agent_group_id: found.agentGroupId,
      agent_name: identity?.name ?? wiring?.name ?? found.agentGroupId,
      at: found.assignedAt,
      by: assignerNames.get(found.assignedBy) ?? found.assignedBy,
    };
    const assignedMs = parseUtcTimestampMs(found.assignedAt);
    // Mirrors the write side's `WHERE assigned_at < staleBefore` exactly: that
    // upsert succeeds (row is re-assignable) once `now - assignedMs` exceeds
    // the window, so "fresh" here is the same `<=` the write side implies.
    const stale = assignedMs === null || now - assignedMs > ASSIGN_DEDUPE_MS;
    return stale ? { assigned: null, assigned_expired: resolved } : { assigned: resolved, assigned_expired: null };
  };

  const attentionThreads: ThreadSummary[] = attentionItems.map((item) => {
    const displayChannelKey = dmDedupeKey.get(item.channel_key) ?? item.channel_key;
    // §5's ONE action reaches these rows too: every agent wired to the item's
    // declared channel can be handed the work, and choosing one creates the
    // session the item does not have yet ("Assign is the verb that creates the
    // thread" — §2).
    const assignableAgents: ThreadAgentOption[] = (wiredByChannel.get(item.channel_key) ?? [])
      .filter((a) => inScope(a.agent_group_id))
      .map((a) => ({
        agent_group_id: a.agent_group_id,
        name:
          identities.get(
            identityKey({
              agentGroupId: a.agent_group_id,
              messagingGroupId: a.messaging_group_id,
              sessionProvider: null,
            }),
          )?.name ?? a.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // NOT set directly — §5: one function decides what state a row is in, and
    // a producing surface that sets `state` itself invents its own lane
    // semantics beside the six. `sessionCount: 0` plus a parked claim whose
    // note names a human is exactly the input `deriveThreadState`'s hoisted
    // `needs_you` checks were written for; anything else lands `unassigned`.
    const state = deriveThreadState({
      sessionCount: item.sessionCount,
      claimState: item.claimState,
      claimNote: item.claimNote ?? '',
      needsOperator: false,
      containerStatus: 'unknown',
      providerStatus: null,
      toolStartedAtMs: null,
      lastOutputAtMs: null,
      now,
    });
    const lastActivityAt = isoOrNull(item.since);
    const { assigned, assigned_expired } = assignmentOf(item);
    return {
      thread_id: item.id,
      synthetic: false,
      channel_key: displayChannelKey,
      channel_name: names.get(displayChannelKey) ?? channelKeyLabel(displayChannelKey),
      title: item.title,
      participants: [],
      assignable_agents: assignableAgents,
      last_activity_at: lastActivityAt,
      state,
      // The claim note this item carries IS the reason, in the source's own
      // words plus what a person has to do about it. Two real strings joined,
      // never text this module composed about work it cannot see. No park age:
      // the item's own age is on the meta line, and there is no claim file
      // behind it whose `parked_at` could be measured.
      needs_you_reason:
        state === 'needs_you' && item.claimNote
          ? { cause: 'parked_note', text: `${item.claimNote} — next: ${item.nextAction}`, parked_ms: null }
          : null,
      session_ids: [],
      container_status: 'unknown',
      provider_status: null,
      current_tool: null,
      tool_started_at: null,
      reply_target_session_id: null,
      // Never snoozable — see the note on `snoozes` above. Stated as the
      // constant it actually is rather than as a lookup that can only ever
      // miss, so nothing downstream reads the possibility of a snooze into a
      // row that can never carry one.
      snoozed: false,
      scheduled_task: false,
      done_proposal: null,
      closing: false,
      close_confirmations_required: requiredConfirmations(false),
      attention_source: {
        kind: item.sourceKind,
        as_of: item.sourceAsOf,
        stale: item.sourceStale,
        url: item.url,
        next_action: item.nextAction,
        // Keyed on the item's NATURAL id — the `board:` prefix is a rendering
        // stamp and migration 058 deliberately does not store it.
        assigned,
        assigned_expired,
      },
    };
  });

  if (attentionThreads.length === 0) return { threads };
  // Merged into ONE queue, never a separate inbox (§2), and sorted on the same
  // axis as the session rows — freshest first — so the wire order is one order.
  //
  // But the two kinds are capped SEPARATELY and the merged list is not re-cut.
  // A single cap over the merged list would have been a recency cutoff wearing
  // a different hat: `last_activity_at` on one of these rows is `item.since`,
  // the moment it STARTED waiting, so the longer an item had been blocked on a
  // human the further down it sorted and the sooner the cap dropped it — the
  // most-stalled item is the first to disappear, which is precisely the
  // invisibility `selectScopedAttentionItems` had its `since_hours` window
  // lifted to end (two items unclaimed for 21-22 days, operator report
  // 2026-08-20). Age must decide ORDER and never membership.
  //
  // Each kind therefore gets its own budget of `limit`: session threads were
  // already cut to `limit` above, so a busy board cannot push a live thread off
  // the page, and a busy workgroup cannot push a stalled item off it either.
  // The trade is that one page can carry up to 2x `limit` rows — deliberate,
  // because the alternative is one lane starving the other, which is the bug.
  const merged = [...threads, ...cappedByAge(attentionThreads, opts.limit)].sort(
    (a, b) =>
      (parseUtcTimestampMs(b.last_activity_at) ?? -Infinity) - (parseUtcTimestampMs(a.last_activity_at) ?? -Infinity),
  );
  return { threads: merged };
}

/**
 * At most `limit` attention rows, keeping the OLDEST — the ones that have been
 * blocked on a human longest.
 *
 * The direction is the whole point. These rows are bounded only by files an
 * agent writes, so some cap has to exist; sorting oldest-first before it means
 * that if the cap ever bites it drops the freshest arrival rather than the
 * item nobody has looked at in three weeks.
 *
 * A row with no measurable age sorts LAST here and is dropped first, matching
 * the console's own rule (§12, `compareByActivity`): unmeasured is not a
 * position on a time axis, and letting `-Infinity` stand in for "oldest" would
 * float every undated row past real, measured waits.
 */
function cappedByAge(rows: ThreadSummary[], limit: number): ThreadSummary[] {
  if (rows.length <= limit) return rows;
  return [...rows]
    .sort((a, b) => {
      const am = parseUtcTimestampMs(a.last_activity_at);
      const bm = parseUtcTimestampMs(b.last_activity_at);
      if (am === null || bm === null) return (am === null ? 1 : 0) - (bm === null ? 1 : 0);
      return am - bm;
    })
    .slice(0, limit);
}

export const threadsHandler: AuthHandler = async (req, _params, ctx) => {
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '', 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const sinceHours = Math.min(
    parseInt(url.searchParams.get('since_hours') ?? '', 10) || DEFAULT_SINCE_HOURS,
    MAX_SINCE_HOURS,
  );
  const includeArchivedRaw = url.searchParams.get('include_archived');
  try {
    const body = await buildThreadList(ctx, {
      workgroupId: url.searchParams.get('workgroup'),
      groupId: url.searchParams.get('group_id'),
      includeArchived: includeArchivedRaw === '1' || includeArchivedRaw === 'true',
      sinceHours,
      limit,
    });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    log.warn('threadsHandler: failed', { err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

/* ─── Thread detail — merged transcript (§10.1) ────────────────────────────── */

const THREAD_TRANSCRIPT_TAIL = 200;

/**
 * One thread's transcript, merged across every participating session.
 *
 * Ordered by TIMESTAMP, not `seq`: `seq` is unique within a session only, so
 * two agents on one thread both hold a `seq` 7 that mean different moments.
 * Ties break on session id then seq purely so the order is deterministic across
 * requests — two messages sharing a millisecond have no true order.
 */
export function mergeThreadTranscript(
  sessions: Array<{ sessionId: string; agentGroupId: string; agentName: string }>,
  readOne: (agentGroupId: string, sessionId: string) => SessionTranscriptEntry[] = readSessionTranscript,
  tail: number = THREAD_TRANSCRIPT_TAIL,
): ThreadTranscriptEntry[] {
  const merged: ThreadTranscriptEntry[] = [];
  for (const s of sessions) {
    for (const entry of readOne(s.agentGroupId, s.sessionId)) {
      merged.push({ ...entry, session_id: s.sessionId, agent_group_id: s.agentGroupId, agent_name: s.agentName });
    }
  }
  merged.sort((a, b) => {
    const at = parseUtcTimestampMs(a.timestamp) ?? 0;
    const bt = parseUtcTimestampMs(b.timestamp) ?? 0;
    if (at !== bt) return at - bt;
    if (a.session_id !== b.session_id) return a.session_id < b.session_id ? -1 : 1;
    return a.seq - b.seq;
  });
  // Keep the TAIL of the conversation — the newest messages — while returning
  // it oldest-first, which is the order a transcript reads in.
  return merged.slice(-tail);
}

export interface ThreadDetailDeps extends ThreadListDeps {
  transcript?: (agentGroupId: string, sessionId: string) => SessionTranscriptEntry[];
}

export async function buildThreadDetail(
  threadId: string,
  ctx: AuthedRequestContext,
  deps: ThreadDetailDeps = {},
): Promise<{ thread: ThreadSummary; transcript: ThreadTranscriptEntry[] } | null> {
  // Reuse the list path so the detail header can never disagree with the row
  // the operator clicked — but scoped to this one thread, so the detail read
  // never pays for the whole queue. `include_archived` is on: an archived
  // thread must still be readable by direct link.
  const { threads } = await buildThreadList(
    ctx,
    { groupId: null, includeArchived: true, sinceHours: DEFAULT_SINCE_HOURS, limit: 1, threadId },
    deps,
  );
  const thread = threads[0];
  if (!thread) return null;

  // An ownerless work item (§2/§5 `unassigned`) has no sessions at all, and
  // `IN ()` is not valid SQLite — the query below would throw and the detail
  // pane would 500 on exactly the rows the console just learned to show. Its
  // transcript is honestly empty: there is no conversation yet, which is the
  // whole reason the row exists.
  if (thread.session_ids.length === 0) return { thread, transcript: [] };

  const byName = new Map(thread.participants.map((p) => [p.agent_group_id, p.name]));
  const rows = await getDb().all<{ id: string; agent_group_id: string }>(
    `SELECT id, agent_group_id FROM sessions WHERE id IN (${thread.session_ids.map(() => '?').join(', ')})`,
    ...thread.session_ids,
  );

  return {
    thread,
    transcript: mergeThreadTranscript(
      rows.map((r) => ({
        sessionId: r.id,
        agentGroupId: r.agent_group_id,
        agentName: byName.get(r.agent_group_id) ?? r.agent_group_id,
      })),
      deps.transcript,
    ),
  };
}

export const threadsDetailHandler: AuthHandler = async (_req, params, ctx) => {
  // Thread ids carry `:` and `.`, both legal unencoded path characters — but a
  // client that percent-encodes them must work too.
  const raw = params['id'] ?? '';
  let threadId = raw;
  try {
    threadId = decodeURIComponent(raw);
  } catch {
    /* not percent-encoded — use it verbatim */
  }
  if (!threadId) {
    return new Response(JSON.stringify({ error: 'thread_not_found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await buildThreadDetail(threadId, ctx);
    // §2a: nonexistent and out-of-scope collapse to the same 404 — the list
    // path already applied the scope filter, so a thread the caller may not see
    // simply is not in it.
    if (!body) {
      return new Response(JSON.stringify({ error: 'thread_not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    log.warn('threadsDetailHandler: failed', { threadId, err });
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
