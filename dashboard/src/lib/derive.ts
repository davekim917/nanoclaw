/*
 * Client-side parsers + grouping helpers for the redesign.
 *
 * The designer's mockup assumed a few fields the server doesn't emit yet:
 *   - goal           — one-line summary of what the worker is doing
 *   - linear_id      — Linear ticket identifier (XZO-54, etc.)
 *   - phase          — integer 1..5 representing worker phase
 *   - needs_input    — boolean: worker stopped to ask the operator something
 *
 * goal / linear_id / phase are derivable from existing data
 * (task_content + last_progress_message) so we parse them here.
 * needs_input now lives on the task row (migration 029) — workers signal
 * it explicitly via the spawn_request_steer MCP tool, the host clears it
 * on the next successful steer write.
 */
import type { TaskSummary, TaskDetail, TranscriptEntry } from './api.js';

const LINEAR_RE = /\b([A-Z]{2,5}-\d+)\b/;
const PHASE_RE = /\bphase\s+([1-5])\b/i;

/**
 * Extract the goal line from a markdown brief.
 * Strategy:
 *   1. Look for the line under `## Goal` (skip blanks), strip markdown
 *      decorations (`**bold**`, leading `Resolve `, trailing Linear URL).
 *   2. Fallback to the first non-heading line.
 *   3. Fallback to the truncated task_content.
 */
export function extractGoal(taskContent: string, maxLen = 140): string {
  const lines = taskContent.split('\n');
  let inGoal = false;
  let goalLine = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+goal\b/i.test(trimmed)) {
      inGoal = true;
      continue;
    }
    if (inGoal) {
      if (trimmed === '' || trimmed.startsWith('##')) {
        if (goalLine) break;
        if (trimmed.startsWith('##')) break;
        continue;
      }
      if (/^linear\s*:/i.test(trimmed)) continue;
      goalLine = trimmed;
      break;
    }
  }
  if (!goalLine) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      goalLine = trimmed;
      break;
    }
  }
  if (!goalLine) goalLine = taskContent.trim();

  let cleaned = goalLine
    .replace(/\*\*/g, '')
    .replace(/^Resolve\s+(?:\*\*)?[A-Z]{2,5}-\d+(?:\*\*)?\s*[—–-]\s*/i, '')
    .replace(/^Resolve\s+/i, '')
    .replace(/\s+Linear\s*:.*$/i, '')
    .trim();
  if (cleaned.length > maxLen) cleaned = cleaned.slice(0, maxLen - 1).trimEnd() + '…';
  return cleaned;
}

export function extractLinearId(taskContent: string): string | null {
  const m = taskContent.match(LINEAR_RE);
  return m ? m[1] : null;
}

/**
 * Parse the active worker phase from the last spawn_progress message.
 * "Phase 1 setup complete: …" → 1. "Phase 2 implement complete: …" → 2.
 * Returns null when unparseable (older completed tasks with stale messages).
 */
export function extractPhase(lastProgressMessage?: string): number | null {
  if (!lastProgressMessage) return null;
  const m = lastProgressMessage.match(PHASE_RE);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

export type Heat = 'hot' | 'warm' | 'cold';

/**
 * Heat tier for visual emphasis in the card stream.
 *   hot:  fresh running, recent failure — full contrast
 *   warm: default
 *   cold: long-done, cancelled, or older than 24h — dimmed
 */
export function heatOf(
  task: { status: TaskSummary['status']; admitted_at: string; needs_input?: number | undefined },
  now = Date.now()
): Heat {
  if (task.needs_input) return 'hot';
  const ageMin = (now - new Date(task.admitted_at).getTime()) / 60000;
  if (task.status === 'running' && ageMin < 15) return 'hot';
  if (task.status === 'failed' && ageMin < 360) return 'hot';
  if (task.status === 'completed' && ageMin > 720) return 'cold';
  if (task.status === 'cancelled') return 'cold';
  if (ageMin > 1440) return 'cold';
  return 'warm';
}

export function relAge(iso: string, now = Date.now()): string {
  const ms = now - new Date(iso).getTime();
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface Counts {
  total: number;
  // In-flight only: excludes `completed` and `cancelled`. Used by the
  // "tasks live" headline. The operator's mental model: "live" = "things
  // I still need to think about or that are still doing work" — a task
  // that shipped or was cancelled is no longer live.
  live: number;
  failed: number;
  needs: number;
  running: number;
  done: number;
  cancelled: number;
  pending: number;
}

export function countTasks(tasks: TaskSummary[]): Counts {
  const c: Counts = {
    total: tasks.length,
    live: 0,
    failed: 0, needs: 0, running: 0, done: 0, cancelled: 0, pending: 0,
  };
  for (const t of tasks) {
    if (t.needs_input) c.needs++;
    switch (t.status) {
      case 'failed': c.failed++; break;
      case 'running': c.running++; break;
      case 'completed': c.done++; break;
      case 'cancelled': c.cancelled++; break;
      case 'pending': c.pending++; break;
    }
  }
  c.live = c.total - c.done - c.cancelled;
  return c;
}

export interface StreamGroups {
  needsMe: TaskSummary[];
  running: TaskSummary[];
  pending: TaskSummary[];
  done: TaskSummary[];
  cold: TaskSummary[];
}

/**
 * Partition tasks into attention groups for the mobile stream.
 *   needsMe = failed OR worker explicitly requested steer
 *   running = running AND not waiting on operator
 */
export function streamGroups(tasks: TaskSummary[]): StreamGroups {
  const g: StreamGroups = { needsMe: [], running: [], pending: [], done: [], cold: [] };
  for (const t of tasks) {
    if (t.status === 'failed' || t.needs_input) g.needsMe.push(t);
    else if (t.status === 'running') g.running.push(t);
    else if (t.status === 'pending') g.pending.push(t);
    else if (t.status === 'completed') g.done.push(t);
    else if (t.status === 'cancelled') g.cold.push(t);
  }
  return g;
}

/**
 * Build a phase timeline for the task detail view by mining spawn_progress
 * messages out of the transcript. Falls back to task.last_progress_message
 * when transcript hasn't loaded yet.
 */
export interface PhaseStep {
  phase: number;
  label: string;
  message: string;
  timestamp: string;
  status: 'done' | 'active' | 'pending' | 'failed';
}

const PHASE_LABELS: Record<number, string> = {
  1: 'Setup',
  2: 'Implement',
  3: 'Verify',
  4: 'Ship',
  5: 'Report',
};

export function buildPhaseTimeline(
  task: TaskDetail,
  transcript: TranscriptEntry[]
): PhaseStep[] {
  const progressByPhase = new Map<number, { msg: string; ts: string }>();
  for (const entry of transcript) {
    if (entry.direction !== 'outbound') continue;
    const text = textOfEntry(entry);
    if (!text) continue;
    const phase = extractPhase(text);
    if (phase !== null) {
      progressByPhase.set(phase, { msg: text, ts: entry.timestamp });
    }
  }
  if (progressByPhase.size === 0 && task.last_progress_message) {
    const p = extractPhase(task.last_progress_message);
    if (p !== null) {
      progressByPhase.set(p, {
        msg: task.last_progress_message,
        ts: task.admitted_at,
      });
    }
  }

  const currentPhase = Math.max(0, ...Array.from(progressByPhase.keys()));
  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
  const failedAt = task.status === 'failed' ? currentPhase || 1 : null;

  return [1, 2, 3, 4, 5].map((p): PhaseStep => {
    const got = progressByPhase.get(p);
    let status: PhaseStep['status'];
    if (failedAt !== null && p === failedAt) status = 'failed';
    else if (p < currentPhase) status = 'done';
    else if (p === currentPhase && !isTerminal) status = 'active';
    else if (p === currentPhase && task.status === 'completed') status = 'done';
    else status = 'pending';
    return {
      phase: p,
      label: PHASE_LABELS[p],
      message: got?.msg ?? '',
      timestamp: got?.ts ?? '',
      status,
    };
  });
}

export function textOfEntry(entry: TranscriptEntry): string {
  if (typeof entry.content === 'string') return entry.content;
  if (entry.content && typeof entry.content === 'object') {
    const t = (entry.content as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  try {
    return JSON.stringify(entry.content);
  } catch {
    return '';
  }
}
