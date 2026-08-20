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
 * So `verb` below is a LABEL over one mechanism, not a switch between seven.
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
}

export const STATE_PRESENTATION: Record<ThreadState, StatePresentation> = {
  needs_you: { label: 'Needs you', verb: 'Answer', tone: 'attention', wantsAttention: true },
  // Not `Kill`. A stalled container has an operator with something to say to it
  // and no reason to destroy the context to say it — push it forward instead.
  stalled: { label: 'Stalled', verb: 'Push', tone: 'attention', wantsAttention: true },
  // Assign is the same send aimed at an agent with no session on the thread;
  // the composer's selector spans every wired agent, so this needs no endpoint
  // of its own.
  unassigned: { label: 'Unassigned', verb: 'Assign', tone: 'attention', wantsAttention: true },
  running: { label: 'Running', verb: 'Steer', tone: 'live', wantsAttention: false },
  // Parked work is work that needs an owner, and handing it over is a message
  // to whoever should take it — plus a composed note to the incumbent.
  parked: { label: 'Parked', verb: 'Hand to…', tone: 'quiet', wantsAttention: false },
  done: { label: 'Done', verb: 'Steer', tone: 'quiet', wantsAttention: false },
  // §5's seventh state and the COMMON case — 57 of 63 threads in a live 24h
  // window. It used to be the one row with no button, on the theory that a
  // thread nobody is waiting on wants nothing done to it. That was backwards:
  // an idle thread is exactly where an operator arrives with a new instruction.
  idle: { label: 'Idle', verb: 'Steer', tone: 'quiet', wantsAttention: false },
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
  const words = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (words.length === 0) return '·';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
