/**
 * Scheduled Tasks Board move flow (Tasks D1 + D2):
 *   POST /dashboard/api/scheduled/:key/move/preview  — dry-run wiring + secret delta
 *   POST /dashboard/api/scheduled/:key/move           — cancel-first execute
 *
 * Move = cancel-in-source + scheduleTask-into-target, sequenced here (C2). All
 * the F1–F6 hardening lives in moveExecuteHandler: staged paused insert (F1),
 * durable move_intent before cancel + purge on resolve (F2/F5), preview→execute
 * delta TOCTOU re-check, fail-closed compensation, and the exactly-one-live-row
 * invariant. Both preview and execute are gated at the MUTATION tier
 * (canManageScheduled) — preview reads vault secret NAMES, so a scoped admin
 * must not be able to enumerate them (M5/SEC-1).
 *
 * See docs/specs/scheduled-tasks-board/design.md §4.0, §4.2, §4.4, §4.5.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { randomUUID } from 'crypto';

import { GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getWorkgroupOnecliSecrets } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDb } from '../../db/connection.js';
import { openInboundDb } from '../../db/session-db.js';
import * as scheduledTasks from '../../db/scheduled-tasks.js';
import { type TaskDef } from '../../db/scheduled-tasks.js';
import {
  cancelTask,
  pauseTask,
  restoreTaskRow,
  updateTask,
  type TaskRowSnapshot,
} from '../../modules/scheduling/db.js';
import { log } from '../../log.js';
import { mergeWorkgroupAndGroupSecrets } from '../../onecli-secrets.js';
import { GUARD_GRACE_MS, verbVerdict, type HealthState } from './scheduled-board-matrix.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  canManageScheduled,
  decodeKey,
  invalidateScheduledCache,
  purgeIntentBody,
  rateLimit,
  writeAudit,
} from './scheduled-shared.js';

// ── Test seam ─────────────────────────────────────────────────────────────────

interface MoveOptions {
  dataDir: string;
  groupsDir: string;
  nowMs: number;
}
let testOptions: { dataDir: string; nowMs: number } | null = null;
export function _setMoveTestOptions(opts: { dataDir: string; nowMs: number } | null): void {
  testOptions = opts;
}
function moveOpts(): MoveOptions {
  if (testOptions) {
    return {
      dataDir: testOptions.dataDir,
      groupsDir: path.join(testOptions.dataDir, 'groups'),
      nowMs: testOptions.nowMs,
    };
  }
  return { dataDir: '', groupsDir: GROUPS_DIR, nowMs: Date.now() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ── Secret-scope resolution (names only — values never leave the gateway) ───────

/**
 * Read a group's per-group onecliSecrets from its container.json. Returns [] if
 * the file is absent/unparseable. Folder-based so it's testable against an
 * injected groupsDir (mirrors readContainerConfig's configPath, but with an
 * overridable root for the move test seam).
 */
function groupSecretsFromFolder(folder: string, groupsDir: string): string[] {
  const p = path.join(groupsDir, folder, 'container.json');
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { onecliSecrets?: unknown };
    return Array.isArray(raw.onecliSecrets) ? (raw.onecliSecrets as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Effective secret scope for a group = workgroup baseline ∪ per-group
 * onecliSecrets (the same union the host applies at spawn —
 * mergeWorkgroupAndGroupSecrets). NAMES/UUIDs only; values are never resolved
 * host-side (§4.2 step 3 — enumeration bounded to source∪target effective sets,
 * never a vault listing).
 */
function effectiveSecrets(agentGroupId: string, folder: string, groupsDir: string): string[] {
  const workgroup = getWorkgroupOnecliSecrets(agentGroupId);
  const group = groupSecretsFromFolder(folder, groupsDir);
  return mergeWorkgroupAndGroupSecrets(workgroup, group);
}

export interface SecretDelta {
  gains: string[];
  losses: string[];
  deltaHash: string;
}

/**
 * Compute the move secret delta: gains = effective(target) − effective(source),
 * losses = effective(source) − effective(target). The deltaHash is a stable
 * sha256 over the sorted gains+losses so the execute handler can detect a
 * preview→execute change (TOCTOU, SEC-2).
 */
function computeSecretDelta(
  sourceAg: string,
  sourceFolder: string,
  targetAg: string,
  targetFolder: string,
  groupsDir: string,
): SecretDelta {
  const src = new Set(effectiveSecrets(sourceAg, sourceFolder, groupsDir));
  const tgt = new Set(effectiveSecrets(targetAg, targetFolder, groupsDir));
  const gains = [...tgt].filter((s) => !src.has(s)).sort();
  const losses = [...src].filter((s) => !tgt.has(s)).sort();
  const deltaHash = createHash('sha256').update(JSON.stringify({ gains, losses })).digest('hex');
  return { gains, losses, deltaHash };
}

export { computeSecretDelta };

// ── Wiring validation (no write) ────────────────────────────────────────────────

/**
 * Is `targetAgentGroupId` wired to `targetMessagingGroupId` via
 * messaging_group_agents? This is scheduleTask's destination-validation
 * predicate (scheduled-tasks.ts:158-165) run WITHOUT writing — fail-closed (C2):
 * an unwired pair means the move would route output to a chat the target agent
 * isn't authorized for.
 */
function isWired(agentGroupId: string, messagingGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?')
    .get(agentGroupId, messagingGroupId) as { ok: number } | undefined;
  return !!row;
}

// ── Source live row (for scriptPresent + the execute snapshot) ──────────────────

interface SourceLiveRow {
  id: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: string;
}

function readSourceLiveRow(
  dataDir: string,
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): SourceLiveRow | null {
  const inboundPath = path.join(dataDir, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
  if (!fs.existsSync(inboundPath)) return null;
  let db: Database.Database | null = null;
  try {
    db = new Database(inboundPath, { readonly: true });
    db.pragma('busy_timeout = 1000');
    return (
      (db
        .prepare(
          `SELECT id, status, process_after, recurrence, content, platform_id, channel_type, thread_id, kind
             FROM messages_in
            WHERE series_id = ? AND kind = 'task' AND status IN ('pending', 'paused')
            ORDER BY seq DESC LIMIT 1`,
        )
        .get(seriesId) as SourceLiveRow | undefined) ?? null
    );
  } catch (err) {
    log.warn('scheduled-move: source live row read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    db?.close();
  }
}

// ── Shared resolve + gate for both preview and execute ──────────────────────────

interface MoveBody {
  targetAgentGroupId?: string;
  targetMessagingGroupId?: string;
  confirmedDeltaHash?: string;
}

interface ResolvedMove {
  source: { agentGroupId: string; sessionId: string; seriesId: string; folder: string };
  target: { agentGroupId: string; messagingGroupId: string; folder: string };
}

/**
 * Decode + gate + resolve both ends. Every failure that could reveal the
 * existence of a resource/target to an unauthorized caller returns 404
 * disclose-as-not-found (never 403) — the mutation gate, the source-scope
 * check, and a missing source/target group all collapse to 404 (§4.2 "404
 * otherwise" + C7). Returns a Response on any reject, or the resolved ends.
 */
function resolveAndGate(
  key: string,
  body: MoveBody,
  ctx: AuthedRequestContext,
): { error: Response } | { ok: ResolvedMove } {
  const decoded = decodeKey(key);
  if (!decoded) return { error: json({ error: 'not_found' }, 404) };

  // Mutation-tier gate (preview reads secret names — M5/SEC-1). Non-manage →
  // 404, never 403 (don't reveal the resource exists).
  if (!canManageScheduled(ctx.user.id)) return { error: json({ error: 'not_found' }, 404) };

  // Scope re-check from the decoded key (never trust the key as authz, §4.5).
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return { error: json({ error: 'not_found' }, 404) };
  }

  const sourceAg = getAgentGroup(decoded.agentGroupId);
  if (!sourceAg) return { error: json({ error: 'not_found' }, 404) };

  const targetAgId = body.targetAgentGroupId;
  const targetMgId = body.targetMessagingGroupId;
  if (!targetAgId || !targetMgId) return { error: json({ error: 'invalid_request' }, 400) };

  const targetAg = getAgentGroup(targetAgId);
  if (!targetAg) return { error: json({ error: 'not_found' }, 404) };
  const targetMg = getMessagingGroup(targetMgId);
  if (!targetMg) return { error: json({ error: 'not_found' }, 404) };

  return {
    ok: {
      source: {
        agentGroupId: decoded.agentGroupId,
        sessionId: decoded.sessionId,
        seriesId: decoded.seriesId,
        folder: sourceAg.folder,
      },
      target: { agentGroupId: targetAgId, messagingGroupId: targetMgId, folder: targetAg.folder },
    },
  };
}

function isCrossWorkgroup(sourceAgId: string, targetAgId: string): boolean {
  const s = getAgentGroup(sourceAgId);
  const t = getAgentGroup(targetAgId);
  const sw = s?.workgroup_id ?? s?.folder;
  const tw = t?.workgroup_id ?? t?.folder;
  return sw !== tw;
}

// ── D1: preview handler ─────────────────────────────────────────────────────────

export const movePreviewHandler: AuthHandler = async (req, params, ctx) => {
  const { groupsDir, dataDir } = moveOpts();
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const resolved = resolveAndGate(params['key'] ?? '', body, ctx);
  if ('error' in resolved) return resolved.error;
  const { source, target } = resolved.ok;

  const wiringOk = isWired(target.agentGroupId, target.messagingGroupId);
  const delta = computeSecretDelta(source.agentGroupId, source.folder, target.agentGroupId, target.folder, groupsDir);

  const live = readSourceLiveRow(dataDir, source.agentGroupId, source.sessionId, source.seriesId);
  let scriptPresent = false;
  if (live) {
    try {
      scriptPresent = typeof (JSON.parse(live.content) as { script?: unknown }).script === 'string';
    } catch {
      /* malformed content — scriptPresent stays false */
    }
  }

  return json({
    wiringOk,
    gains: delta.gains,
    losses: delta.losses,
    crossWorkgroup: isCrossWorkgroup(source.agentGroupId, target.agentGroupId),
    scriptPresent,
    environmentDeltaChecked: false,
    deltaHash: delta.deltaHash,
  });
};

// ── D2: execute handler ─────────────────────────────────────────────────────────

function inboundPathOf(dataDir: string, agentGroupId: string, sessionId: string): string {
  return path.join(dataDir, 'v2-sessions', agentGroupId, sessionId, 'inbound.db');
}

/** Map the source live-row status to the §4.0 health state the move guard needs. */
function moveGuardState(status: string, processAfterMs: number | null, nowMs: number): HealthState {
  if (status === 'paused') return 'paused';
  // A pending row maps to healthy/late by overdue-ness; verbVerdict's move cell
  // keys on processAfterMs + claimed, so 'healthy' vs 'late' both route to the
  // same future-dated admission test. Use 'late' when overdue so the guard's
  // isDue/isNearDue checks reflect reality.
  return processAfterMs !== null && processAfterMs <= nowMs ? 'late' : 'healthy';
}

function parseUtcMs(s: string | null): number | null {
  if (!s) return null;
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Build the TaskDef that re-schedules the snapshot into the target session. */
function taskDefFromSnapshot(
  snapshot: SourceLiveRow,
  seriesId: string,
  targetAgentGroupId: string,
  targetMg: { platform_id: string; channel_type: string },
  processAfterOverride?: string,
): TaskDef {
  let content: { prompt?: string; script?: string; quietStatus?: boolean; flagIntent?: TaskDef['flagIntent'] } = {};
  try {
    content = JSON.parse(snapshot.content) as typeof content;
  } catch {
    /* malformed — fall through with empty content; prompt falls back below */
  }
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agentGroupId: targetAgentGroupId,
    cron: snapshot.recurrence ?? '',
    processAfter: processAfterOverride ?? snapshot.process_after ?? new Date().toISOString(),
    seriesId,
    prompt: typeof content.prompt === 'string' ? content.prompt : snapshot.content,
    ...(typeof content.script === 'string' ? { script: content.script } : {}),
    ...(content.quietStatus ? { quietStatus: true } : {}),
    ...(content.flagIntent ? { flagIntent: content.flagIntent } : {}),
    destination: {
      platformId: targetMg.platform_id,
      channelType: targetMg.channel_type,
      threadId: snapshot.thread_id,
    },
  };
}

/** Count live (pending/paused) rows for a series across BOTH the source and target sessions. */
function liveRowCountFleetWide(
  dataDir: string,
  source: { agentGroupId: string; sessionId: string },
  target: { agentGroupId: string; sessionId: string | null },
  seriesId: string,
): number {
  let count = 0;
  const sql =
    "SELECT COUNT(*) AS c FROM messages_in WHERE series_id = ? AND kind = 'task' AND status IN ('pending','paused')";
  const locs = [source, target.sessionId ? { agentGroupId: target.agentGroupId, sessionId: target.sessionId } : null];
  for (const loc of locs) {
    if (!loc) continue;
    const p = inboundPathOf(dataDir, loc.agentGroupId, loc.sessionId);
    if (!fs.existsSync(p)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(p, { readonly: true });
      db.pragma('busy_timeout = 1000');
      count += (db.prepare(sql).get(seriesId) as { c: number }).c;
    } catch {
      /* unreadable — counts as 0 for this location */
    } finally {
      db?.close();
    }
  }
  return count;
}

/** Resolve the target channel-root session id (after scheduleTask created it). */
function targetSessionIdFor(targetAgentGroupId: string, targetMessagingGroupId: string): string | null {
  const row = getDb()
    .prepare(
      "SELECT id FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active' LIMIT 1",
    )
    .get(targetAgentGroupId, targetMessagingGroupId) as { id: string } | undefined;
  return row?.id ?? null;
}

export const moveExecuteHandler: AuthHandler = async (req, params, ctx) => {
  const { dataDir, groupsDir, nowMs } = moveOpts();
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const resolved = resolveAndGate(params['key'] ?? '', body, ctx);
  if ('error' in resolved) return resolved.error;
  const { source, target } = resolved.ok;

  // Rate limit (move converts a keypress into container compute — §4.5/A14/S10).
  const rl = rateLimit(ctx.user.id, 'move');
  if (!rl.ok) return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const targetMg = getMessagingGroup(target.messagingGroupId);
  if (!targetMg) return json({ error: 'not_found' }, 404);

  // Step 0b: source session unreadable → fail closed (§3a).
  const sourceInbound = inboundPathOf(dataDir, source.agentGroupId, source.sessionId);
  if (!fs.existsSync(sourceInbound)) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);

  // Step 1: delta TOCTOU re-check (SEC-2).
  const delta = computeSecretDelta(source.agentGroupId, source.folder, target.agentGroupId, target.folder, groupsDir);
  if (body.confirmedDeltaHash !== delta.deltaHash) {
    return json({ error: 'delta_changed', reason: 'delta_changed' }, 409);
  }

  // Step 2: snapshot the source live row.
  const snapshot = readSourceLiveRow(dataDir, source.agentGroupId, source.sessionId, source.seriesId);
  // Stale key — no live source row to move (§3b: touched 0 → 409 stale_key).
  if (!snapshot) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  // Step 2a: §4.0 in-flight admission guard (verbVerdict is the ONLY guard source).
  const processAfterMs = parseUtcMs(snapshot.process_after);
  const guardState = moveGuardState(snapshot.status, processAfterMs, nowMs);
  const verdict = verbVerdict('move', {
    state: guardState,
    kind: snapshot.recurrence ? (snapshot.thread_id ? 'thread_loop' : 'recurring') : 'one_off',
    claimed: false,
    processAfterMs,
    nowMs,
  });
  if (!verdict.allowed) {
    return json(
      { error: verdict.reason ?? 'source_busy', reason: verdict.reason ?? 'source_busy' },
      verdict.status ?? 409,
    );
  }

  const wasPaused = snapshot.status === 'paused';
  const correlationId = randomUUID();
  const central = getDb();

  // Step 2b: durable move_intent BEFORE cancel (F2). Full snapshot in
  // detail_json; correlation_id links the recovery.
  writeAudit(central, {
    actor: ctx.user.id,
    action: 'move_intent',
    agentGroupId: source.agentGroupId,
    sessionId: source.sessionId,
    seriesId: source.seriesId,
    correlationId,
    detail: {
      snapshot: {
        id: snapshot.id,
        series_id: source.seriesId,
        status: snapshot.status,
        process_after: snapshot.process_after,
        recurrence: snapshot.recurrence,
        content: snapshot.content,
        platform_id: snapshot.platform_id,
        channel_type: snapshot.channel_type,
        thread_id: snapshot.thread_id,
        kind: snapshot.kind,
      },
      target: target.agentGroupId,
    },
  });

  const restoreSnapshot: TaskRowSnapshot = {
    // FRESH id — the cancelled source row still holds snapshot.id (cancel sets
    // status=completed, never deletes), so re-using it would PK-collide. Series
    // identity is carried by series_id, not the row id (restoreTaskRow preserves
    // series_id, A4).
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    series_id: source.seriesId,
    status: wasPaused ? 'paused' : 'pending',
    process_after: snapshot.process_after,
    recurrence: snapshot.recurrence,
    content: snapshot.content,
    platform_id: snapshot.platform_id,
    channel_type: snapshot.channel_type,
    thread_id: snapshot.thread_id,
    kind: snapshot.kind,
  };

  // Step 3: cancel the source live row (→ completed, recurrence cleared).
  {
    const srcDb = openInboundDb(sourceInbound);
    try {
      cancelTask(srcDb, source.seriesId);
    } finally {
      srcDb.close();
    }
  }

  // Step 4: re-schedule into the target. Paused snapshots take the staged path
  // (4a) so the row is never simultaneously pending + due (F1).
  try {
    if (wasPaused) {
      const stagedProcessAfter = new Date(nowMs + GUARD_GRACE_MS).toISOString();
      await scheduledTasks.scheduleTask(
        taskDefFromSnapshot(snapshot, source.seriesId, target.agentGroupId, targetMg, stagedProcessAfter),
        dataDir,
      );
      const tgtSessId = targetSessionIdFor(target.agentGroupId, target.messagingGroupId);
      if (tgtSessId) {
        const tgtDb = openInboundDb(inboundPathOf(dataDir, target.agentGroupId, tgtSessId));
        try {
          pauseTask(tgtDb, source.seriesId);
          if (snapshot.process_after) updateTask(tgtDb, source.seriesId, { processAfter: snapshot.process_after });
        } finally {
          tgtDb.close();
        }
      }
    } else {
      await scheduledTasks.scheduleTask(
        taskDefFromSnapshot(snapshot, source.seriesId, target.agentGroupId, targetMg),
        dataDir,
      );
    }
  } catch (err) {
    // Step 5: target insert failed → restore the source (idempotent — only when
    // zero live rows fleet-wide). Never delete a succeeded target.
    log.warn('scheduled-move: target insert failed — restoring source', {
      seriesId: source.seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    let restored = false;
    try {
      const tgtSessId = targetSessionIdFor(target.agentGroupId, target.messagingGroupId);
      const live = liveRowCountFleetWide(
        dataDir,
        { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
        { agentGroupId: target.agentGroupId, sessionId: tgtSessId },
        source.seriesId,
      );
      if (live === 0) {
        const srcDb = openInboundDb(sourceInbound);
        try {
          restoreTaskRow(srcDb, restoreSnapshot);
          restored = true;
        } finally {
          srcDb.close();
        }
      }
    } catch (restoreErr) {
      log.error('scheduled-move: source restore ALSO failed', {
        seriesId: source.seriesId,
        err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }
    if (!restored) {
      writeAudit(central, {
        actor: ctx.user.id,
        action: 'move_restore_failed',
        agentGroupId: source.agentGroupId,
        sessionId: source.sessionId,
        seriesId: source.seriesId,
        correlationId,
      });
    } else {
      purgeIntentBody(central, correlationId);
    }
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'move_failed' }, 500);
  }

  // Step 6: invariant — exactly one live row fleet-wide for the series.
  const tgtSessId = targetSessionIdFor(target.agentGroupId, target.messagingGroupId);
  const liveCount = liveRowCountFleetWide(
    dataDir,
    { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
    { agentGroupId: target.agentGroupId, sessionId: tgtSessId },
    source.seriesId,
  );
  if (liveCount !== 1) {
    log.error('scheduled-move: post-move invariant violated', { seriesId: source.seriesId, liveCount });
  }

  // Step 7: resolve the intent (stamp + purge body, F5) + two-sided move audit
  // (one row per group, shared correlation_id) + invalidate cache.
  purgeIntentBody(central, correlationId);
  const secretDetail = { secretGainsCount: delta.gains.length, secretLossesCount: delta.losses.length };
  writeAudit(central, {
    actor: ctx.user.id,
    action: 'move',
    agentGroupId: source.agentGroupId,
    sessionId: source.sessionId,
    seriesId: source.seriesId,
    correlationId,
    detail: { direction: 'source', target: target.agentGroupId, ...secretDetail },
  });
  writeAudit(central, {
    actor: ctx.user.id,
    action: 'move',
    agentGroupId: target.agentGroupId,
    sessionId: tgtSessId ?? '',
    seriesId: source.seriesId,
    correlationId,
    detail: { direction: 'target', source: source.agentGroupId, ...secretDetail },
  });
  invalidateScheduledCache();

  return json({ moved: true });
};
