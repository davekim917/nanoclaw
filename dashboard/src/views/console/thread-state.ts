import type { ThreadSummary, ThreadState } from '../../lib/api.js';

/**
 * How each of DESIGN.md §5's states renders: its label, its ONE verb, its
 * urgency tone, and whether it wants the operator's attention.
 *
 * `wantsAttention` is the switch DESIGN §4.1 hangs the hybrid line on, and it
 * is a COST control, not a styling choice: message bodies live in each
 * session's own DB files with no central rollup, so previewing every row means
 * opening hundreds of files per refresh. Only these three states pay for it.
 */
export interface StatePresentation {
  label: string;
  /**
   * §5: exactly one primary verb per state. NULL only for `idle`, whose row of
   * the table reads `—` — the one state §1's "every row ends in a verb" does
   * not reach, because a thread nobody is waiting on wants nothing done to it.
   * Such a row is still openable; it simply carries no button.
   */
  verb: string | null;
  tone: 'attention' | 'live' | 'quiet';
  wantsAttention: boolean;
  /**
   * What pressing the verb actually does, or null when nothing today can do it.
   *
   * - `compose` — open the reply composer on the thread's target session and
   *   send through `POST /dashboard/api/sessions/:id/message`. This is the ONE
   *   steer path that works on an arbitrary thread (DESIGN §10.3); the
   *   `observatory/steer|nudge|assign` trio spawns a one-shot task and accepts
   *   only claims or release-board items, so it cannot reach a thread row.
   * - `close` — archive every session on the thread
   *   (`POST /dashboard/api/sessions/:id/archive`), which is exactly what sets
   *   the `archived_at` that §5 computes `done` from.
   */
  action: 'compose' | 'close' | null;
  /**
   * Why the verb is inert, rendered verbatim as the disabled button's `title`.
   *
   * §1 says every row ends in a verb, and hiding an affordance because its
   * backend is missing quietly turns that into a lie. A disabled button that
   * says WHY is the honest rendering: the operator learns the capability is
   * named but not built, instead of wondering where the button went.
   */
  inertReason: string | null;
}

const KILL_INERT =
  'No dashboard-reachable kill path exists. killContainer() is host-internal and every caller is a ' +
  'host-side sweep or the ncl socket CLI; exposing it over HTTP needs a guarded action in src/guard/, ' +
  'which is a privileged surface nobody has approved. Kill it with `ncl groups restart` for now.';

const ASSIGN_INERT =
  'Assign turns an unowned work item into a thread, and POST /observatory/assign takes a release-board ' +
  'item id. A row in this queue is derived from sessions, so it already HAS a thread and there is no ' +
  'item to assign. §5 says this state is unreachable until the release-board join lands.';

const REASSIGN_INERT =
  'Nothing can change a claim’s owner. Claims are per-workgroup JSON files written by the owning ' +
  'agent; the dashboard reads them and the assign/nudge/steer endpoints all address items or claims by ' +
  'slug without ever rewriting `owner`. Steer the agent instead, or hand the claim over in the thread.';

export const STATE_PRESENTATION: Record<ThreadState, StatePresentation> = {
  needs_you: {
    label: 'Needs you',
    verb: 'Answer',
    tone: 'attention',
    wantsAttention: true,
    action: 'compose',
    inertReason: null,
  },
  stalled: { label: 'Stalled', verb: 'Kill', tone: 'attention', wantsAttention: true, action: null, inertReason: KILL_INERT },
  unassigned: {
    label: 'Unassigned',
    verb: 'Assign',
    tone: 'attention',
    wantsAttention: true,
    action: null,
    inertReason: ASSIGN_INERT,
  },
  running: { label: 'Running', verb: 'Steer', tone: 'live', wantsAttention: false, action: 'compose', inertReason: null },
  parked: {
    label: 'Parked',
    verb: 'Reassign',
    tone: 'quiet',
    wantsAttention: false,
    action: null,
    inertReason: REASSIGN_INERT,
  },
  done: { label: 'Done', verb: 'Close', tone: 'quiet', wantsAttention: false, action: 'close', inertReason: null },
  // §5: the seventh state, and the COMMON case — 57 of 63 threads in a live
  // 24h window. Verb is `—` in the table, so this row carries none.
  idle: { label: 'Idle', verb: null, tone: 'quiet', wantsAttention: false, action: null, inertReason: null },
};

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
export const LANE_ORDER: ThreadState[] = ['needs_you', 'stalled', 'unassigned', 'running', 'parked', 'idle', 'done'];

/** Queue sort key: urgency first (DESIGN §1 — status is a sort, never a column). */
export function urgencyRank(state: ThreadState): number {
  const i = LANE_ORDER.indexOf(state);
  return i === -1 ? LANE_ORDER.length : i;
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

/** Two initials for the avatar fallback — a friendly display name, never an id. */
export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
