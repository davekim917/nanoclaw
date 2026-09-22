/**
 * Rebuild each billed agent turn from data the host already persists — no
 * change to the router, sweep or runner, and nothing leaves the host here.
 *
 *   turn_usage (central DB)             cost, model, effort, trigger, end time, duration
 *   <session>/inbound.db messages_in    the trigger=1 rows the turn consumed
 *   <session>/outbound.db messages_out  what it wrote: `chat` replies and everything else
 *
 * Attribution is by time window per session, keyed on turn START (`ts` minus
 * `duration_ms`): a row is consumed by the first turn that starts after it is
 * due. Keying on the previous turn's END mis-credits every row that fell due
 * while a turn was running — measured on 2026-09-18, that sent ~$860 of
 * scheduled turns to "no trigger". "Due" is `process_after` when set, because a
 * recurring task's row is written about a day before it fires, so its
 * `timestamp` is its creation time. Still an approximation — good enough to
 * size a prize, not to bill one.
 *
 * Session DBs are opened read-only, queried once, and closed at once: they are
 * live, and a long-held reader would stall a container's commit
 * (`journal_mode=DELETE`, container/agent-runner/src/mailbox/sqlite/connection.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { CLAUDE_USAGE_TRUSTED_FROM, isUntrustedTurnUsage, UNTRUSTED_USAGE_NOTE } from '../../src/db/usage-trust.js';

export const ROOT = process.env.NANOCLAW_ROOT ?? '/home/ubuntu/nanoclaw-v2';

/**
 * Workgroups the Jev work is focused on for now — a SCOPE choice, not a
 * data-sharing restriction. The operator approved sending every workgroup's
 * content to TypeSafe on 2026-09-18 and chose one workgroup to start with;
 * widening the focus needs only a go on the work. Set it per run with
 * JEV_SHADOW_FOCUS (comma-separated workgroup ids); it defaults to `main`, the
 * operator's own. Keyed on workgroup id, not folder
 * name, so a new sibling group lands in its workgroup's focus automatically.
 * `scope: 'all'` reads every group.
 */
export const FOCUS_WORKGROUPS = new Set(
  (process.env.JEV_SHADOW_FOCUS ?? 'main')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Poll jitter: a row due just after a turn's recorded start can still be read by it. */
const START_SLACK_MS = 60_000;

export interface TurnInput {
  kind: string;
  seriesId: string | null;
  text: string;
  /** The untruncated JSON content, only when `raw: true` was asked for. */
  raw?: string;
}

export interface TurnRecord {
  turnId: string | null;
  ts: string;
  start: string;
  sessionId: string;
  folder: string;
  trigger: string;
  provider: string;
  model: string | null;
  effort: string | null;
  steps: number | null;
  costUsd: number;
  inputs: TurnInput[];
  /** Delivered `chat` replies only. */
  outputs: string[];
  /** Every other outbound kind written in the turn (status, task_log, system, …) with counts. */
  otherWrites: Record<string, number>;
  /** `task_log` texts: the ledger notes a task writes instead of (or besides) a chat reply. */
  logs: string[];
}

function text(content: string): string {
  try {
    const c = JSON.parse(content) as Record<string, unknown>;
    for (const k of ['text', 'prompt', 'message', 'content']) {
      if (typeof c[k] === 'string' && c[k]) return c[k] as string;
    }
    return content;
  } catch (err) {
    // Plain-text content is legitimate; anything else is a real bug.
    if (err instanceof SyntaxError) return content;
    throw err;
  }
}

function sessionDirs(): Map<string, string> {
  const base = path.join(ROOT, 'data', 'v2-sessions');
  const index = new Map<string, string>();
  for (const group of fs.readdirSync(base)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(base, group));
    } catch (err) {
      // v2-sessions holds a few plain files beside the group dirs.
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw err;
    }
    for (const s of entries) if (s.startsWith('sess-')) index.set(s, path.join(base, group, s));
  }
  return index;
}

function readOnce<T>(file: string, sql: string, params: unknown[]): T[] {
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export function loadTurns(opts: {
  since: string;
  scope: 'all' | 'focus';
  folders?: Set<string>;
  maxChars?: number;
  raw?: boolean;
}): { turns: TurnRecord[]; skippedOutOfFocus: number; missingSession: number; untrustedCost: number } {
  const maxChars = opts.maxChars ?? 3000;
  const central = new Database(path.join(ROOT, 'data', 'v2.db'), { readonly: true, fileMustExist: true });
  const rows = central
    .prepare(
      `SELECT t.turn_id, t.ts, t.session_id, t.trigger, t.provider, t.model, t.effort, t.steps,
              COALESCE(t.duration_ms, 0) AS duration_ms, COALESCE(t.cost_usd, 0) AS cost_usd,
              COALESCE(ag.folder, t.agent_group_id) AS folder, ag.workgroup_id AS workgroup
         FROM turn_usage t LEFT JOIN agent_groups ag ON ag.id = t.agent_group_id
        WHERE datetime(t.ts) >= datetime(?)
        ORDER BY t.session_id, t.ts`,
    )
    .all(opts.since) as Array<Record<string, string | number | null>>;
  central.close();

  const dirs = sessionDirs();
  const turns: TurnRecord[] = [];
  let skippedOutOfFocus = 0;
  let missingSession = 0;
  let untrustedCost = 0;
  let prevSession = '';
  let prevStartMs = 0;

  for (const r of rows) {
    const folder = String(r.folder);
    const sessionId = String(r.session_id);
    const ts = String(r.ts);
    const endMs = Date.parse(ts);
    const startMs = endMs - Number(r.duration_ms);
    if (sessionId !== prevSession) {
      prevSession = sessionId;
      prevStartMs = 0;
    }
    const windowLo = iso(prevStartMs + START_SLACK_MS);
    const windowHi = iso(startMs + START_SLACK_MS);
    prevStartMs = startMs;

    // After the window bookkeeping above, like the other skips, so the next
    // turn's attribution window still starts where this one did. Every report
    // here sums cost_usd, and inside the #1061 window that column is not a
    // figure — the turn is dropped, not zeroed, and counted below.
    if (isUntrustedTurnUsage(String(r.provider), ts)) {
      untrustedCost += 1;
      continue;
    }
    if (opts.folders && !opts.folders.has(folder)) continue;
    if (opts.scope === 'focus' && !FOCUS_WORKGROUPS.has(String(r.workgroup ?? ''))) {
      skippedOutOfFocus += 1;
      continue;
    }
    const dir = dirs.get(sessionId);
    if (!dir) {
      missingSession += 1;
      continue;
    }
    const inputs = readOnce<{ kind: string; series_id: string | null; content: string }>(
      path.join(dir, 'inbound.db'),
      `SELECT kind, series_id, content FROM messages_in
        WHERE trigger = 1 AND COALESCE(process_after, timestamp) > ? AND COALESCE(process_after, timestamp) <= ?
        ORDER BY seq`,
      [windowLo, windowHi],
    ).map((m) => ({
      kind: m.kind,
      seriesId: m.series_id,
      text: text(m.content).slice(0, maxChars),
      ...(opts.raw ? { raw: m.content } : {}),
    }));
    const written = readOnce<{ kind: string; content: string }>(
      path.join(dir, 'outbound.db'),
      `SELECT kind, content FROM messages_out WHERE timestamp > ? AND timestamp <= ? ORDER BY seq`,
      [iso(startMs - 5000), iso(endMs + 5000)],
    );
    const otherWrites: Record<string, number> = {};
    for (const w of written) if (w.kind !== 'chat') otherWrites[w.kind] = (otherWrites[w.kind] ?? 0) + 1;

    turns.push({
      turnId: (r.turn_id as string) ?? null,
      ts,
      start: iso(startMs),
      sessionId,
      folder,
      trigger: String(r.trigger),
      provider: String(r.provider),
      model: (r.model as string) ?? null,
      effort: (r.effort as string) ?? null,
      steps: (r.steps as number) ?? null,
      costUsd: Number(r.cost_usd),
      inputs,
      outputs: written.filter((w) => w.kind === 'chat').map((w) => text(w.content).slice(0, maxChars)),
      otherWrites,
      logs: written.filter((w) => w.kind === 'task_log').map((w) => text(w.content).slice(0, maxChars)),
    });
  }
  if (untrustedCost > 0) {
    console.error(
      `jev-shadow: ${untrustedCost} Claude turn(s) before ${CLAUDE_USAGE_TRUSTED_FROM} left out — cost_usd there is ${UNTRUSTED_USAGE_NOTE}`,
    );
  }
  return { turns, skippedOutOfFocus, missingSession, untrustedCost };
}
