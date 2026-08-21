import type { ThreadSummary, ThreadState } from '../../lib/api.js';

/**
 * How each of DESIGN.md §5's states renders: its label, the WORD on its verb
 * button, its urgency tone, and whether it wants the operator's attention.
 *
 * **There is one primitive: send a message to a chosen agent.** Two parameters,
 * which agent and what text. Steer, push-forward, ship, assign and reassign are
 * all that same action — the only difference is whether the chosen agent is
 * already on the thread, and that difference is the selector's, not a verb's.
 *
 * So `verb` below is a LABEL over one mechanism, not a switch between six.
 * Every state has one, `idle` included, and none of them is ever inert: a
 * stalled thread gets a message, not a kill. There is deliberately no `action`
 * field and no `inertReason` — nothing left for either to discriminate.
 *
 * `wantsAttention` is the switch DESIGN §4.1 hangs the hybrid line on, and it
 * is a COST control, not a styling choice: message bodies live in each
 * session's own DB files with no central rollup, so previewing every row means
 * opening hundreds of files per refresh. Only these three states pay for it.
 */
export interface StatePresentation {
  label: string;
  /**
   * The word on the button. Different words, one action — what changes between
   * `Answer` and `Push` is what the operator is likely to type, never what
   * pressing it does.
   */
  verb: string;
  tone: 'attention' | 'live' | 'quiet';
  wantsAttention: boolean;
  /**
   * How this lane reads in an empty state, as a predicate: "nothing here
   * ${emptyPhrase}". The legacy board carried the same field on its filter
   * chips — a narrowed question deserves its narrowing spoken back, and the
   * label alone ("nothing here Needs you") does not read as English.
   */
  emptyPhrase: string;
}

export const STATE_PRESENTATION: Record<ThreadState, StatePresentation> = {
  needs_you: { label: 'Needs you', verb: 'Answer', tone: 'attention', wantsAttention: true, emptyPhrase: 'needs you' },
  // Not `Kill`. A stalled container has an operator with something to say to it
  // and no reason to destroy the context to say it — push it forward instead.
  stalled: { label: 'Stalled', verb: 'Push', tone: 'attention', wantsAttention: true, emptyPhrase: 'is stalled' },
  // Assign is the same send aimed at an agent with no session on the thread;
  // the composer's selector spans every wired agent, so this needs no endpoint
  // of its own.
  unassigned: {
    label: 'Unassigned',
    verb: 'Assign',
    tone: 'attention',
    wantsAttention: true,
    emptyPhrase: 'is unassigned',
  },
  running: { label: 'Running', verb: 'Steer', tone: 'live', wantsAttention: false, emptyPhrase: 'is running' },
  // Parked work is work that needs an owner, and handing it over is a message
  // to whoever should take it — plus a composed note to the incumbent.
  parked: { label: 'Parked', verb: 'Hand to…', tone: 'quiet', wantsAttention: false, emptyPhrase: 'is parked' },
  // §5's sixth state and the COMMON case — 57 of 63 threads in a live 24h
  // window. It used to be the one row with no button, on the theory that a
  // thread nobody is waiting on wants nothing done to it. That was backwards:
  // an idle thread is exactly where an operator arrives with a new instruction.
  idle: { label: 'Idle', verb: 'Steer', tone: 'quiet', wantsAttention: false, emptyPhrase: 'is idle' },
};

/**
 * `snoozed` is a pseudo-lane, NOT an eighth state: a snooze is this operator's
 * own view decision and a thread can be snoozed while it is running. It is a
 * lane rather than a silent filter so a snoozed thread is always reachable —
 * hiding work with no way back is how a queue starts lying.
 */
export type Lane = ThreadState | 'all' | 'snoozed';

/**
 * Which session a reply to this thread lands in, and which participant that is.
 *
 * The server names a default (`reply_target_session_id`) — the agent whose
 * state drove the row's urgency. This resolves it to a participant so the UI
 * can show and change it. Falls back to the first participant, which is the
 * most recently active agent on the thread.
 */
export function replyTarget(
  thread: Pick<ThreadSummary, 'participants' | 'reply_target_session_id'>,
): ThreadSummary['participants'][number] | null {
  const byId = thread.participants.find((p) => p.session_id === thread.reply_target_session_id);
  return byId ?? thread.participants[0] ?? null;
}

/**
 * Sidebar lane order, and the list's sort key.
 *
 * NOT §5's table order. That table is ordered by DERIVATION precedence — its
 * "`Unassigned` outranks everything" is a computability argument (an item with
 * no session has no container, claim or transcript to consult), and the server
 * owns it. Display order is urgency: what the operator should look at first.
 */
export const LANE_ORDER: ThreadState[] = ['needs_you', 'stalled', 'unassigned', 'running', 'parked', 'idle'];

/** Queue sort key: urgency first (DESIGN §1 — status is a sort, never a column). */
export function urgencyRank(state: ThreadState): number {
  const i = LANE_ORDER.indexOf(state);
  return i === -1 ? LANE_ORDER.length : i;
}

/**
 * The lanes where the OLDEST row leads.
 *
 * Ported from `commitments.ts`: anything that has already failed its promise
 * comes first, oldest first, because the oldest breach is the one the system has
 * been lying about longest. An unassigned thread is breached at birth, so it
 * sorts with the breaches rather than into a tidy backlog of its own.
 *
 * Everything else stays newest-first: `running` and `idle` are not promises
 * anyone is waiting on, and there the freshest row is the interesting one.
 *
 * Written out rather than read off `wantsAttention` on purpose — that flag is a
 * COST control (§4.1's preview budget) and the two would drift the first time
 * one of them changed for its own reason.
 */
const OLDEST_FIRST: ReadonlySet<ThreadState> = new Set<ThreadState>(['needs_you', 'stalled', 'unassigned']);

export function leadsWithOldest(state: ThreadState): boolean {
  return OLDEST_FIRST.has(state);
}

/**
 * An ISO instant as epoch ms, or `null` when there is no instant.
 *
 * `null`, never `0`. See `compareByActivity` — the whole point is that "unknown"
 * is not a position on a time axis.
 */
export function activityMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Compare two rows by age, in the direction the lane asks for — with UNKNOWN
 * age sorting last EITHER WAY.
 *
 * That null term is explicit and load-bearing (`exceptions.ts:165-172`): an item
 * with no timestamp has no place on a time axis, and defaulting it to zero would
 * park every undated row at one end and call that an ordering. It used to land
 * last here only by accident — `0` is smaller than every real instant, so a
 * DESCENDING comparator happened to push it down. Flipping any lane to ascending
 * silently inverts that accident and floats every undated row to the top of the
 * lane the operator is meant to trust most.
 */
export function compareByActivity(a: string | null, b: string | null, oldestFirst: boolean): number {
  const am = activityMs(a);
  const bm = activityMs(b);
  if (am === null || bm === null) return (am === null ? 1 : 0) - (bm === null ? 1 : 0);
  return oldestFirst ? am - bm : bm - am;
}

/** The queue's full ordering: urgency lane first, then age in that lane's direction. */
export function compareThreads(
  a: Pick<ThreadSummary, 'state' | 'last_activity_at'>,
  b: Pick<ThreadSummary, 'state' | 'last_activity_at'>,
): number {
  const rank = urgencyRank(a.state) - urgencyRank(b.state);
  if (rank !== 0) return rank;
  return compareByActivity(a.last_activity_at, b.last_activity_at, leadsWithOldest(a.state));
}

/** What the queue narrowed to, in words. Empty string means "not narrowed at all". */
export function queueFilterPhrase(o: { lane: Lane; channelName: string | null; query: string }): string {
  const parts = [
    o.lane === 'all' ? null : o.lane === 'snoozed' ? 'is snoozed' : STATE_PRESENTATION[o.lane].emptyPhrase,
    o.channelName ? `lives in ${o.channelName}` : null,
    o.query.trim() ? `matches “${o.query.trim()}”` : null,
  ].filter(Boolean);
  return parts.join(' and ');
}

/**
 * What an empty queue says — four different facts, four different sentences.
 *
 * The legacy board learned this twice (`Observatory.tsx`'s ledger-empty and its
 * claims card) and the console shipped with one `no threads in view` covering
 * all of them:
 *
 * 1. **Nothing exists at all.** Not a filter result. Saying "all clear" over an
 *    empty window congratulates the reader on nothing.
 * 2. **A lane is genuinely clear.** That is GOOD NEWS and has to say so — an
 *    empty attention feed is an answer, not an absence of one.
 * 3. **A channel filter with no hits**, and
 * 4. **a search miss** — both get the narrowing spoken back, because a board
 *    that answers a narrowed question with a bare "nothing here" makes the
 *    operator re-derive their own filters to understand the emptiness.
 */
export function emptyQueueMessage(o: {
  /** Threads in the window at all, before any filter. */
  total: number;
  lane: Lane;
  /** The display name of the active channel filter, or null for all channels. */
  channelName: string | null;
  query: string;
}): string {
  if (o.total === 0) return 'no threads in this window yet';

  const narrowedByHand = Boolean(o.channelName) || o.query.trim() !== '';
  if (!narrowedByHand) {
    if (o.lane === 'all') return 'nothing un-snoozed here';
    if (o.lane === 'snoozed') return 'nothing is snoozed';
    // The good news case, said as good news.
    return `All clear — nothing ${STATE_PRESENTATION[o.lane].emptyPhrase}`;
  }
  return `nothing here ${queueFilterPhrase(o)}`;
}

/**
 * Whether the live line (tool + elapsed) and the liveness rule render at all.
 *
 * DESIGN §4 says "running rows only", but §6 and the Row artboard both require
 * a STALLED row to show its rule holding still — that stillness is the signal.
 * Both readings agree on the actual gate: a tool is in flight. A thread with no
 * `tool_started_at` has nothing to show either way.
 */
export function showsLiveLine(thread: Pick<ThreadSummary, 'state' | 'tool_started_at'>): boolean {
  if (!thread.tool_started_at) return false;
  return thread.state === 'running' || thread.state === 'stalled';
}

/**
 * §5.1: `current_tool` fidelity varies by provider. Claude reports readable
 * tool names; Codex reports the generic wire name `CodexItem` and roughly half
 * the fleet is non-Claude. Nothing STATEFUL depends on this string — stall
 * detection is age-only — so the honest move is to say "working" rather than
 * print a wire constant at the operator.
 */
const OPAQUE_TOOL_NAMES = new Set(['CodexItem', 'codexitem', 'unknown', '']);

export function toolLabel(currentTool: string | null): string {
  const t = (currentTool ?? '').trim();
  return OPAQUE_TOOL_NAMES.has(t) ? 'working' : t;
}

/**
 * Elapsed time since an ISO instant, in the artboard's shape: `18s`,
 * `3m 12s`, `2h 04m`. Monospace at the call site (DESIGN §7 — every
 * machine-produced value), which is what makes these comparable down a column.
 */
export function elapsed(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
}

/**
 * The participant who filed a `done_proposal`, by friendly name (§11: never an
 * internal id). Falls back to the raw `agent_group_id` only if that agent
 * somehow is not in `participants` any more — the mirror can lag a real
 * retraction by up to one sweep tick, so this is a display fallback, not
 * evidence the proposal is stale.
 */
export function proposalAuthorName(thread: Pick<ThreadSummary, 'participants' | 'done_proposal'>): string {
  const proposal = thread.done_proposal;
  if (!proposal) return '';
  return thread.participants.find((p) => p.agent_group_id === proposal.agent_group_id)?.name ?? proposal.agent_group_id;
}

/** Two initials for the avatar fallback — a friendly display name, never an id. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
