/**
 * Read-only workgroup dashboard endpoints (fleet-hardening Phase 3):
 *   GET /dashboard/api/workgroups              — workgroups visible to the caller
 *   GET /dashboard/api/workgroup/:id/summary    — releases board.md + newest gate log tail
 *   GET /dashboard/api/workgroup/:id/usage      — per-agent-group usage_daily rollup
 *   GET /dashboard/api/workgroup/:id/claims     — work-claims + task-series summary
 *
 * Scopes have no workgroup dimension (`ctx.scopes.allowed_group_ids` is a list
 * of agent_group ids) — membership is derived by joining `agent_groups.workgroup_id`.
 * Same disclose-as-not-found pattern as scheduled-read.ts: an out-of-scope or
 * nonexistent workgroup id is a 404, never a 403.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import type { UsageDailyRow } from '../../db/usage.js';
import { isCostApplicable } from '../../db/usage.js';
import { log } from '../../log.js';
import { isStalePastGrace, shouldEscalate } from '../../modules/claims/escalation.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import { assembleSnapshot, type ScheduledSnapshot } from './scheduled-assembly.js';
import { getScheduledCache } from './scheduled-shared.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Workgroup resolution + scope check ──────────────────────────────────────

interface WorkgroupRow {
  id: string;
  display_name: string | null;
}

/**
 * Resolve a workgroup id to its row AND verify the caller has scope on it,
 * in one step — never trust the route param as a filesystem path or authz
 * input directly. `no_filter` callers see every workgroup; scoped callers
 * must have at least one allowed agent group whose `workgroup_id` matches.
 * Returns null on either not-found or out-of-scope (disclose-as-not-found).
 */
function resolveWorkgroup(id: string, ctx: AuthedRequestContext): WorkgroupRow | null {
  const row = getDb().prepare('SELECT id, display_name FROM workgroups WHERE id = ?').get(id) as
    | WorkgroupRow
    | undefined;
  if (!row) return null;
  if (ctx.scopes.no_filter) return row;
  if (ctx.scopes.allowed_group_ids.length === 0) return null;
  const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
  const hit = getDb()
    .prepare(`SELECT 1 FROM agent_groups WHERE workgroup_id = ? AND id IN (${placeholders}) LIMIT 1`)
    .get(row.id, ...ctx.scopes.allowed_group_ids);
  return hit ? row : null;
}

function workgroupAgentGroupIds(workgroupId: string): string[] {
  return (
    getDb().prepare('SELECT id FROM agent_groups WHERE workgroup_id = ?').all(workgroupId) as Array<{ id: string }>
  ).map((r) => r.id);
}

// ── GET /dashboard/api/workgroups ───────────────────────────────────────────

export const workgroupsListHandler: AuthHandler = async (_req, _params, ctx) => {
  let rows: WorkgroupRow[];
  try {
    if (ctx.scopes.no_filter) {
      rows = getDb()
        .prepare('SELECT id, display_name FROM workgroups ORDER BY COALESCE(display_name, id)')
        .all() as WorkgroupRow[];
    } else if (ctx.scopes.allowed_group_ids.length === 0) {
      rows = [];
    } else {
      const placeholders = ctx.scopes.allowed_group_ids.map(() => '?').join(', ');
      rows = getDb()
        .prepare(
          `SELECT DISTINCT w.id, w.display_name FROM workgroups w
             JOIN agent_groups a ON a.workgroup_id = w.id
            WHERE a.id IN (${placeholders})
            ORDER BY COALESCE(w.display_name, w.id)`,
        )
        .all(...ctx.scopes.allowed_group_ids) as WorkgroupRow[];
    }
  } catch (err) {
    log.warn('workgroupsListHandler: DB error', { err });
    return json({ error: 'internal_error' }, 500);
  }
  return json({ workgroups: rows.map((r) => ({ id: r.id, name: r.display_name ?? r.id })) });
};

// ── GET /dashboard/api/workgroup/:id/summary ────────────────────────────────

/** `groups/<workgroupId>/releases/board.md` — raw markdown, or null if absent. */
function readBoardMd(releasesDir: string): string | null {
  try {
    return fs.readFileSync(path.join(releasesDir, 'board.md'), 'utf8');
  } catch {
    return null;
  }
}

/** Tail (~last `tailLines`) of the newest `releases/gates/*.jsonl` file, or []. */
function readNewestGatesTail(releasesDir: string, tailLines: number): Record<string, unknown>[] {
  const gatesDir = path.join(releasesDir, 'gates');
  let files: string[];
  try {
    files = fs
      .readdirSync(gatesDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }
  const newest = files[files.length - 1];
  if (!newest) return [];

  let lines: string[];
  try {
    lines = fs.readFileSync(path.join(gatesDir, newest), 'utf8').trimEnd().split('\n').filter(Boolean);
  } catch {
    return [];
  }

  const out: Record<string, unknown>[] = [];
  for (const line of lines.slice(-tailLines)) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* skip an unparseable line rather than fail the whole tail */
    }
  }
  return out;
}

const GATE_TAIL_LINES = 50;

export const workgroupSummaryHandler: AuthHandler = async (_req, params, ctx) => {
  const wg = resolveWorkgroup(params['id'] ?? '', ctx);
  if (!wg) return json({ error: 'not_found' }, 404);

  const releasesDir = path.join(GROUPS_DIR, wg.id, 'releases');
  return json({
    board: readBoardMd(releasesDir),
    gates: readNewestGatesTail(releasesDir, GATE_TAIL_LINES),
  });
};

// ── GET /dashboard/api/workgroup/:id/usage ──────────────────────────────────

const DEFAULT_USAGE_DAYS = 14;
const MAX_USAGE_DAYS = 90;

export const workgroupUsageHandler: AuthHandler = async (req, params, ctx) => {
  const wg = resolveWorkgroup(params['id'] ?? '', ctx);
  if (!wg) return json({ error: 'not_found' }, 404);

  const url = new URL(req.url);
  const daysParam = parseInt(url.searchParams.get('days') ?? '', 10);
  const days = Math.min(
    Math.max(Number.isFinite(daysParam) && daysParam > 0 ? daysParam : DEFAULT_USAGE_DAYS, 1),
    MAX_USAGE_DAYS,
  );
  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  let usage: UsageDailyRow[];
  try {
    const agentGroupIds = workgroupAgentGroupIds(wg.id);
    if (agentGroupIds.length === 0) {
      usage = [];
    } else {
      const placeholders = agentGroupIds.map(() => '?').join(', ');
      const rawRows = getDb()
        .prepare(
          `SELECT * FROM usage_daily
            WHERE agent_group_id IN (${placeholders}) AND date >= ?
            ORDER BY date DESC, agent_group_id, provider, model`,
        )
        .all(...agentGroupIds, sinceDate) as Omit<UsageDailyRow, 'cost_applicable'>[];
      // cost_applicable is computed from provider, not a stored column — see
      // isCostApplicable's doc for why (Codex has no per-token cost field, so
      // its rows sum cost_usd to 0 identically to a real zero-spend row).
      usage = rawRows.map((row) => ({ ...row, cost_applicable: isCostApplicable(row.provider) }));
    }
  } catch (err) {
    log.warn('workgroupUsageHandler: DB error', { workgroupId: wg.id, err });
    return json({ error: 'internal_error' }, 500);
  }

  return json({ usage });
};

// ── GET /dashboard/api/workgroup/:id/claims ─────────────────────────────────

interface RawClaim {
  owner?: unknown;
  claimed_at?: unknown;
  ttl_hours?: unknown;
  note?: unknown;
  escalated_at?: unknown;
}

export interface ClaimEntry {
  slug: string;
  owner: string | null;
  claimed_at: string | null;
  ttl_hours: number | null;
  note: string | null;
  escalated_at: string | null;
  stale: boolean;
  escalated: boolean;
}

/**
 * `data/workgroups/<id>/claims/*.json` — reuses the pure `isStalePastGrace` /
 * `shouldEscalate` functions from the claims escalation module (never
 * reimplements the staleness math). `escalated` means "currently escalated
 * and not yet eligible for a fresh escalation" — a claim that went stale,
 * escalated, and was then taken over (re-claimed) reads as un-escalated again.
 * Missing/unreadable claims dir → [], never a 500.
 */
function readClaims(dataDir: string, workgroupId: string, now: number): ClaimEntry[] {
  const dir = path.join(dataDir, 'workgroups', workgroupId, 'claims');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const out: ClaimEntry[] = [];
  for (const file of files) {
    let claim: RawClaim;
    try {
      claim = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as RawClaim;
    } catch (err) {
      log.warn('workgroupClaimsHandler: unparseable claim JSON, skipping', { file, err });
      continue;
    }
    const claimedAt = typeof claim.claimed_at === 'string' ? claim.claimed_at : null;
    const ttlHours = typeof claim.ttl_hours === 'number' ? claim.ttl_hours : null;
    const stale = claimedAt !== null && ttlHours !== null ? isStalePastGrace(claimedAt, ttlHours, now).stale : false;
    out.push({
      slug: path.basename(file, '.json'),
      owner: typeof claim.owner === 'string' ? claim.owner : null,
      claimed_at: claimedAt,
      ttl_hours: ttlHours,
      note: typeof claim.note === 'string' ? claim.note : null,
      escalated_at: typeof claim.escalated_at === 'string' ? claim.escalated_at : null,
      stale,
      escalated: stale && !shouldEscalate(claim, now),
    });
  }
  return out;
}

export interface WorkgroupSeriesRow {
  series_id: string;
  agent_group_id: string;
  agent_group_name: string;
  cron: string | null;
  health: string;
  next_fire_utc: string | null;
  next_fire_local: string | null;
  last_fires: unknown[];
  script_host: boolean;
}

export const workgroupClaimsHandler: AuthHandler = async (_req, params, ctx) => {
  const wg = resolveWorkgroup(params['id'] ?? '', ctx);
  if (!wg) return json({ error: 'not_found' }, 404);

  const claims = readClaims(DATA_DIR, wg.id, Date.now());

  let series: WorkgroupSeriesRow[] = [];
  try {
    const agentGroupIds = new Set(workgroupAgentGroupIds(wg.id));
    if (agentGroupIds.size > 0) {
      const nowMs = Date.now();
      // Reuse the scheduled-board's warm full-fleet cache (never assemble
      // scoped — that would poison the shared cache other read handlers rely
      // on being full-fleet); same pattern as scheduled-read.ts.
      const cache = getScheduledCache();
      let snapshot: ScheduledSnapshot;
      if (cache.data && cache.expiresMs > nowMs) {
        snapshot = cache.data as unknown as ScheduledSnapshot;
      } else {
        snapshot = await assembleSnapshot(
          { role: 'owner', allowed_group_ids: [], no_filter: true },
          { dataDir: DATA_DIR, nowMs },
        );
      }
      series = snapshot.rows
        .filter((r) => agentGroupIds.has(r.agent_group_id))
        .map((r) => ({
          series_id: r.series_id,
          agent_group_id: r.agent_group_id,
          agent_group_name: r.agent_group_name,
          cron: r.cron,
          health: r.health,
          next_fire_utc: r.next_fire_utc,
          next_fire_local: r.next_fire_local,
          last_fires: r.last_fires,
          script_host: r.script_host,
        }));
    }
  } catch (err) {
    log.warn('workgroupClaimsHandler: task-series summary assembly failed', { workgroupId: wg.id, err });
    series = [];
  }

  return json({ claims, series });
};
