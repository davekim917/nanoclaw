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
}

export const STATE_PRESENTATION: Record<ThreadState, StatePresentation> = {
  needs_you: { label: 'Needs you', verb: 'Answer', tone: 'attention', wantsAttention: true },
  stalled: { label: 'Stalled', verb: 'Kill', tone: 'attention', wantsAttention: true },
  unassigned: { label: 'Unassigned', verb: 'Assign', tone: 'attention', wantsAttention: true },
  running: { label: 'Running', verb: 'Steer', tone: 'live', wantsAttention: false },
  parked: { label: 'Parked', verb: 'Reassign', tone: 'quiet', wantsAttention: false },
  done: { label: 'Done', verb: 'Close', tone: 'quiet', wantsAttention: false },
  // §5: the seventh state, and the COMMON case — 57 of 63 threads in a live
  // 24h window. Verb is `—` in the table, so this row carries none.
  idle: { label: 'Idle', verb: null, tone: 'quiet', wantsAttention: false },
};

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
