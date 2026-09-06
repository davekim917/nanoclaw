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

import { randomUUID } from 'crypto';

import { DATA_DIR, GROUPS_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getWorkgroupOnecliSecrets } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { withCentralSync } from '../../db/central-lease.js';
import { getDb } from '../../db/connection.js';
import { findSystemSession, taskThreadId, withQuietInvalidationSync } from '../../db/sessions.js';
import { readSessionInbound, type ScheduledTaskRow } from '../../modules/mailbox/index.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import * as scheduledTasks from '../../db/scheduled-tasks.js';
import { type TaskDef } from '../../db/scheduled-tasks.js';
import { type TaskRowSnapshot } from '../../modules/scheduling/db.js';
import { countLiveRowsInSessions } from '../../modules/scheduling/live-count.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { mergeWorkgroupAndGroupSecrets } from '../../onecli-secrets.js';
import { GUARD_GRACE_MS, verbVerdict, type HealthState } from './scheduled-board-matrix.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  canManageScheduled,
  decodeKey,
  invalidateScheduledCache,
  purgeIntentBody,
  rateLimit,
  sessionInboundPathFor,
  writeAudit,
  approvedRowChanged,
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
  // Production default MUST be DATA_DIR (matches readOpts in scheduled-read.ts).
  // A '' default resolved session DBs under <cwd>/v2-sessions instead of
  // <cwd>/data/v2-sessions → every real move hit the missing-source guard and
  // returned session_unreadable (move broken outside tests, which inject a dir).
  return { dataDir: DATA_DIR, groupsDir: GROUPS_DIR, nowMs: Date.now() };
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
async function effectiveSecrets(agentGroupId: string, folder: string, groupsDir: string): Promise<string[]> {
  const workgroup = await getWorkgroupOnecliSecrets(agentGroupId);
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
 * sha256 that BINDS the move target identity (E-4) in addition to the sorted
 * gains+losses, so a preview confirmed for targetA can never be replayed on an
 * execute targeting a different targetB that happens to produce identical
 * gains/losses — execute recomputes from the BODY's target and 409s on mismatch
 * (TOCTOU, SEC-2 + target-rebind, E-4).
 */
async function computeSecretDelta(
  sourceAg: string,
  sourceFolder: string,
  targetAg: string,
  targetFolder: string,
  targetMessagingGroupId: string,
  groupsDir: string,
): Promise<SecretDelta> {
  const src = new Set(await effectiveSecrets(sourceAg, sourceFolder, groupsDir));
  const tgt = new Set(await effectiveSecrets(targetAg, targetFolder, groupsDir));
  const gains = [...tgt].filter((s) => !src.has(s)).sort();
  const losses = [...src].filter((s) => !tgt.has(s)).sort();
  // Canonical, key-ordered payload — the target identity is part of the hashed
  // surface so the confirmed hash is tied to the exact (targetAg, targetMg) pair.
  const deltaHash = createHash('sha256')
    .update(
      JSON.stringify({
        targetAgentGroupId: targetAg,
        targetMessagingGroupId,
        gains,
        losses,
      }),
    )
    .digest('hex');
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
async function isWired(agentGroupId: string, messagingGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?',
    agentGroupId,
    messagingGroupId,
  );
  return !!row;
}

// ── Source live row (for scriptPresent + the execute snapshot) ──────────────────

// Read through the mailbox module's named ops, so the row shape is the
// module's. (The WRITE half of this flow still opens a raw inbound handle for
// modules/scheduling/db.ts's task mutators — see the file header note.)
type SourceLiveRow = ScheduledTaskRow;

/**
 * Read the source series' live row. The result DISTINGUISHES three cases (ADV-S1,
 * mirroring resolveTarget in scheduled-mutations.ts):
 *   - { unreadable: true }       → the file exists but the read threw → 503
 *   - { unreadable: false, row } → a live row (or null when the series ended) →
 *                                  null maps to 409 stale_key, never a false 503.
 * A missing inbound.db is `row: null` (the caller's pre-cancel existsSync guard
 * already mapped that to 503 in execute; preview treats it as "no script").
 */
interface SourceLiveReadResult {
  unreadable: boolean;
  row: SourceLiveRow | null;
}

function readSourceLiveRow(
  dataDir: string,
  agentGroupId: string,
  sessionId: string,
  seriesId: string,
): SourceLiveReadResult {
  try {
    // Read-only seam: a move PREVIEW must never provision or migrate the
    // session it is previewing (invariant I-4). The module applies the same
    // canonicalize-and-contain check the pre-seam chokepoint did, so a
    // locator that resolves outside data/v2-sessions — like a session with no
    // mailbox — reads as "no live row", never as unreadable.
    const row = readSessionInbound({ dataDir, agentGroupId, sessionId }, (mailbox) => mailbox.getLiveTaskRow(seriesId));
    return { unreadable: false, row: row ?? null };
  } catch (err) {
    log.warn('scheduled-move: source live row read failed', {
      seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { unreadable: true, row: null };
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
async function resolveAndGate(
  key: string,
  body: MoveBody,
  ctx: AuthedRequestContext,
): Promise<{ error: Response } | { ok: ResolvedMove }> {
  const decoded = decodeKey(key);
  if (!decoded) return { error: json({ error: 'not_found' }, 404) };

  // Mutation-tier gate (preview reads secret names — M5/SEC-1). Non-manage →
  // 404, never 403 (don't reveal the resource exists).
  if (!(await canManageScheduled(ctx.user.id))) return { error: json({ error: 'not_found' }, 404) };

  // Scope re-check from the decoded key (never trust the key as authz, §4.5).
  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(decoded.agentGroupId)) {
    return { error: json({ error: 'not_found' }, 404) };
  }

  const sourceAg = await getAgentGroup(decoded.agentGroupId);
  if (!sourceAg) return { error: json({ error: 'not_found' }, 404) };

  const targetAgId = body.targetAgentGroupId;
  const targetMgId = body.targetMessagingGroupId;
  if (!targetAgId || !targetMgId) return { error: json({ error: 'invalid_request' }, 400) };

  const targetAg = await getAgentGroup(targetAgId);
  if (!targetAg) return { error: json({ error: 'not_found' }, 404) };
  const targetMg = await getMessagingGroup(targetMgId);
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

export async function isCrossWorkgroup(sourceAgId: string, targetAgId: string): Promise<boolean> {
  const s = await getAgentGroup(sourceAgId);
  const t = await getAgentGroup(targetAgId);
  if (s?.workgroup_id == null || t?.workgroup_id == null) return true;
  return s.workgroup_id !== t.workgroup_id;
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

  const resolved = await resolveAndGate(params['key'] ?? '', body, ctx);
  if ('error' in resolved) return resolved.error;
  const { source, target } = resolved.ok;

  const wiringOk = await isWired(target.agentGroupId, target.messagingGroupId);
  const delta = computeSecretDelta(
    source.agentGroupId,
    source.folder,
    target.agentGroupId,
    target.folder,
    target.messagingGroupId,
    groupsDir,
  );

  const live = readSourceLiveRow(dataDir, source.agentGroupId, source.sessionId, source.seriesId).row;
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
    gains: (await delta).gains,
    losses: (await delta).losses,
    crossWorkgroup: await isCrossWorkgroup(source.agentGroupId, target.agentGroupId),
    scriptPresent,
    environmentDeltaChecked: false,
    deltaHash: (await delta).deltaHash,
  });
};

// ── D2: execute handler ─────────────────────────────────────────────────────────

/** Map the source live-row status to the §4.0 health state the move guard needs. */
function moveGuardState(status: string, processAfterMs: number | null, nowMs: number): HealthState {
  if (status === 'paused') return 'paused';
  // A pending row maps to healthy/late by overdue-ness; verbVerdict's move cell
  // keys on processAfterMs + claimed, so 'healthy' vs 'late' both route to the
  // same future-dated admission test. Use 'late' when overdue so the guard's
  // isDue/isNearDue checks reflect reality.
  return processAfterMs !== null && processAfterMs <= nowMs ? 'late' : 'healthy';
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
    // The moved row is the SAME occurrence, so it keeps the slot it was armed
    // for. Without this the destination's scheduled_for would be stamped from
    // process_after — which is the staged grace time on the paused path, and
    // the retry deadline for a source row sitting in backoff.
    ...(snapshot.scheduled_for ? { scheduledFor: snapshot.scheduled_for } : {}),
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

/**
 * Count live rows for the series across exactly {source session, target session}
 * (H1 helper). `unreadable` callers MUST honor: never restore / never claim
 * success on an unknown post-state. Replaces the old bare-series_id fleet scan
 * (M1: an unrelated group reusing the series_id no longer causes a false count).
 */
function scopedLiveCount(
  dataDir: string,
  source: { agentGroupId: string; sessionId: string },
  target: { agentGroupId: string; sessionId: string | null },
  seriesId: string,
): { count: number; unreadable: boolean } {
  const locators = [source];
  if (target.sessionId && target.sessionId !== source.sessionId) {
    locators.push({ agentGroupId: target.agentGroupId, sessionId: target.sessionId });
  }
  return countLiveRowsInSessions(dataDir, locators, seriesId);
}

/** Resolve the target per-series system session id (after scheduleTask created it). */
async function targetSessionIdFor(targetAgentGroupId: string, seriesId: string): Promise<string | null> {
  return (await findSystemSession(targetAgentGroupId, taskThreadId(seriesId)))?.id ?? null;
}

export const moveExecuteHandler: AuthHandler = async (req, params, ctx) => {
  const { dataDir, groupsDir, nowMs } = moveOpts();
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const resolved = await resolveAndGate(params['key'] ?? '', body, ctx);
  if ('error' in resolved) return resolved.error;
  const { source, target } = resolved.ok;

  // Rate limit (move converts a keypress into container compute — §4.5/A14/S10).
  const rl = rateLimit(ctx.user.id, 'move');
  if (!rl.ok) return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);

  const targetMg = await getMessagingGroup(target.messagingGroupId);
  if (!targetMg) return json({ error: 'not_found' }, 404);

  // Step 0a: M4 — containment-checked source open (null → 404; decodeKey already
  // rejects traversal, this is defense in depth — never an open outside the tree).
  const sourceInbound = sessionInboundPathFor(dataDir, source.agentGroupId, source.sessionId);
  if (!sourceInbound) return json({ error: 'not_found' }, 404);
  // Step 0b: source session unreadable → fail closed (§3a).
  if (!fs.existsSync(sourceInbound)) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);

  // Step 1: delta TOCTOU re-check (SEC-2 + target-rebind E-4). The hash binds the
  // target identity, so a hash confirmed for a different target won't match.
  const delta = computeSecretDelta(
    source.agentGroupId,
    source.folder,
    target.agentGroupId,
    target.folder,
    target.messagingGroupId,
    groupsDir,
  );
  if (body.confirmedDeltaHash !== (await delta).deltaHash) {
    return json({ error: 'delta_changed', reason: 'delta_changed' }, 409);
  }

  // Step 2: snapshot the source live row. ADV-S1: a read THROW (corrupt-but-
  // existent inbound.db) is 503 session_unreadable — distinguished from an empty
  // result (the series ended/moved → 409 stale_key), never collapsed into 409.
  const sourceRead = readSourceLiveRow(dataDir, source.agentGroupId, source.sessionId, source.seriesId);
  if (sourceRead.unreadable) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);
  const snapshot = sourceRead.row;
  // Stale key — no live source row to move (§3b: touched 0 → 409 stale_key).
  if (!snapshot) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  // Step 2a: §4.0 in-flight admission guard (verbVerdict is the ONLY guard source).
  const processAfterMs = parseUtcTimestampMs(snapshot.process_after);
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

  // Step 2b: durable move_intent BEFORE cancel (F2). Full snapshot in
  // detail_json; correlation_id links the recovery.
  await writeAudit({
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
        scheduled_for: snapshot.scheduled_for,
        recurrence: snapshot.recurrence,
        content: snapshot.content,
        platform_id: snapshot.platform_id,
        channel_type: snapshot.channel_type,
        thread_id: snapshot.thread_id,
        kind: snapshot.kind,
      },
      // M1: the FULL target locator so recovery can scope its live-count to
      // exactly {source session, target session} — not a bare series_id fleet
      // scan that an unrelated group's same-series_id row could falsely satisfy.
      target: target.agentGroupId,
      targetAgentGroupId: target.agentGroupId,
      targetMessagingGroupId: target.messagingGroupId,
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
    // The occurrence's slot survives the move-and-compensate round trip; a
    // restore is the SAME occurrence, not a new one.
    scheduled_for: snapshot.scheduled_for,
    recurrence: snapshot.recurrence,
    content: snapshot.content,
    platform_id: snapshot.platform_id,
    channel_type: snapshot.channel_type,
    thread_id: snapshot.thread_id,
    kind: snapshot.kind,
  };

  // Step 3: cancel the source live row (→ cancelled, recurrence cleared).
  // Capture the touched count (E-2): the §2a guard already proved the source is
  // live, so a 0-touch cancel is unexpected — but if it happens, abort BEFORE
  // inserting the target so a no-op cancel can never leave a target-only series.
  //
  // Existing-only (invariant I-10): the §2a guard just proved the source row
  // is live, so the mailbox is there. `undefined` means it vanished under the
  // guard, which reads as 0 touched and takes the abort branch below rather
  // than inserting into the target — the same fail-safe direction the pre-seam
  // open's throw had.
  //
  // BY ROW ID, and only if that row is still exactly what was approved.
  // Everything above — the delta hash, the verdict, the move_intent body,
  // `restoreSnapshot` — describes the single occurrence `snapshot.id`. The
  // pre-seam code could cancel the SERIES here because the read and the cancel
  // were one synchronous run with no yield between them, so nothing could
  // change. Acquiring the mailbox now yields, and in that window the
  // occurrence can complete and arm a successor, or be admitted and fired
  // where it stands. Every refusal below returns 0 touched and takes the abort
  // branch, which is what "the key went stale" already means here.
  const cancelTouched =
    (await withExistingMailboxSession(source.agentGroupId, source.sessionId, (mailbox) => {
      // Re-prove the approved occurrence, inside the session, with nothing
      // awaited between the read and the write.
      //
      // The id alone is not enough, and that is the whole finding: admission
      // MUTATES a task row in place. A dashboard run-now landing in this
      // acquisition window flips `trigger` 0 → 1 and moves `process_after`
      // while the id and the `pending` status stay exactly as §2's read saw
      // them — so an id-scoped cancel would cancel an occurrence that is now
      // triggered (and possibly claimed by a container mid-fire), and the
      // move would then recreate the stale snapshot in the target.
      const current = mailbox.getLiveTaskRow(source.seriesId);
      if (!current || current.id !== snapshot.id) return 0;
      const changed = approvedRowChanged(snapshot, current);
      if (changed) {
        log.warn('scheduled-move: the approved occurrence changed under the move — refusing', {
          seriesId: source.seriesId,
          rowId: snapshot.id,
          field: changed,
        });
        return 0;
      }
      // Inert, absolutely and not merely unchanged. §2a's verdict passed
      // `claimed: false` without proving it; a move must not consume an
      // occurrence that is armed to fire or already being fired.
      if (current.trigger !== 0) {
        log.warn('scheduled-move: the approved occurrence is admitted — refusing', {
          seriesId: source.seriesId,
          rowId: snapshot.id,
        });
        return 0;
      }
      if (mailbox.getProcessingClaimRows().some((claim) => claim.message_id === snapshot.id)) {
        log.warn('scheduled-move: the approved occurrence is claimed — refusing', {
          seriesId: source.seriesId,
          rowId: snapshot.id,
        });
        return 0;
      }
      return mailbox.cancelTaskRow(snapshot.id);
    })) ?? 0;
  if (cancelTouched === 0) {
    // Nothing was cancelled (the approved occurrence stopped being live between
    // the guard and here) — leave the intent unresolved for the recovery sweep
    // and do NOT insert.
    log.warn('scheduled-move: cancel touched 0 rows — aborting before target insert', {
      seriesId: source.seriesId,
      rowId: snapshot.id,
    });
    return json({ error: 'stale_key', reason: 'stale_key' }, 409);
  }

  // Step 4: re-schedule into the target. Paused snapshots take the staged path
  // (4a) so the row is never simultaneously pending + due (F1).
  try {
    if (wasPaused) {
      const stagedProcessAfter = new Date(nowMs + GUARD_GRACE_MS).toISOString();
      await scheduledTasks.scheduleTask(
        taskDefFromSnapshot(snapshot, source.seriesId, target.agentGroupId, targetMg, stagedProcessAfter),
      );
      const tgtSessId = await targetSessionIdFor(target.agentGroupId, source.seriesId);
      if (tgtSessId) {
        // A DIFFERENT key from the source session above, and that session is
        // closed by now — the two opens are sequential, never nested, which is
        // what the same-key nesting guard (invariant I-3) forbids.
        //
        // `scheduleTask` just provisioned this mailbox, so `undefined` is a
        // genuine fault: staging exists so the row is never simultaneously
        // pending and due, and skipping it would land a paused move as
        // pending. Throwing takes the restore path, as the pre-seam open did.
        const staged = await withExistingMailboxSession(target.agentGroupId, tgtSessId, (mailbox) => {
          mailbox.pauseTask(source.seriesId);
          // keepScheduledFor: this restores the row's RUN time after the
          // staged grace insert. scheduleTask already stamped the occurrence's
          // slot from the snapshot, and moving it again here would overwrite it
          // with the run time.
          if (snapshot.process_after) {
            mailbox.updateTask(source.seriesId, {
              processAfter: snapshot.process_after,
              keepScheduledFor: true,
            });
          }
          return true;
        });
        if (!staged) throw new Error(`target task session ${tgtSessId} has no inbound mailbox to stage into`);
      }
    } else {
      await scheduledTasks.scheduleTask(taskDefFromSnapshot(snapshot, source.seriesId, target.agentGroupId, targetMg));
    }
  } catch (err) {
    // Step 5: target insert failed → restore the source — but ONLY when the
    // scoped {source,target} live count is a readable ZERO. M2/F6: if the count
    // is UNREADABLE, the post-state is UNKNOWN, so we must NOT restore (a blind
    // restore on top of a live row we couldn't see would double it). Never
    // delete a succeeded target.
    log.warn('scheduled-move: target insert failed — restoring source', {
      seriesId: source.seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    let restored = false;
    try {
      const tgtSessId = await targetSessionIdFor(target.agentGroupId, source.seriesId);
      const live = scopedLiveCount(
        dataDir,
        { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
        { agentGroupId: target.agentGroupId, sessionId: tgtSessId },
        source.seriesId,
      );
      if (!live.unreadable && live.count === 0) {
        restored =
          (await withExistingMailboxSession(source.agentGroupId, source.sessionId, (mailbox) =>
            withCentralSync(() => {
              // The source was cancelled, then the target insert was AWAITED — a
              // sweep tick can land in that await, see a source with no live task
              // and mark it quiet. Restoring the pending row here puts due work
              // back behind that mark, and S2-PR15 would carry it across a
              // restart. The central-DB invalidation is what clears it.
              //
              // Invalidate BEFORE the restore, in the same synchronous turn
              // (Codex pre-pass Part C, round 3 H1): inbound.db and the central DB
              // are two separate files with no shared transaction, so a crash
              // between them is survivable only if the mark dies first. Its worst
              // case is one wasted sweep of a session whose restore then fails;
              // the reverse leaves a restored due row hidden behind a persisted
              // quiet mark for up to `QUIET_SESSION_BACKOFF_MS` after a warmed
              // restart. This also keeps the invalidation before `purgeIntentBody`
              // below: a crash between the two still leaves the intent for
              // `recoverMoveIntents` to finish.
              //
              // FAIL-CLOSED (Codex round 2, H1; round 3, H2): the invalidation
              // inside `withQuietInvalidationSync` throws — on a central-DB error
              // AND on a session row that is gone or no longer active — and the
              // throw escapes into the `restoreErr` catch below. `restored` stays
              // false, the `move_restore_failed` audit row is written and
              // `purgeIntentBody` is SKIPPED, so `recoverMoveIntents` still owns
              // the repair. A swallowed failure would restore the row behind a
              // mark nothing clears and then purge the only record of it.
              withQuietInvalidationSync(source.sessionId, () => mailbox.restoreTaskRow(restoreSnapshot));
              return true;
            }, 'scheduled-move source restore'),
          )) ?? false;
      }
    } catch (restoreErr) {
      log.error('scheduled-move: source restore ALSO failed', {
        seriesId: source.seriesId,
        err: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }
    if (!restored) {
      await writeAudit({
        actor: ctx.user.id,
        action: 'move_restore_failed',
        agentGroupId: source.agentGroupId,
        sessionId: source.sessionId,
        seriesId: source.seriesId,
        correlationId,
      });
    } else {
      await purgeIntentBody(correlationId);
    }
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'move_failed' }, 500);
  }

  // Step 6: invariant — exactly one live row across {source, target} for the
  // series. E-2: a violation is NOT logged-and-200'd — we return an error and
  // LEAVE the move_intent unresolved so the recovery sweep repairs it. An
  // UNREADABLE post-state is equally not-success (never claim a move succeeded
  // on a state we couldn't observe).
  const tgtSessId = await targetSessionIdFor(target.agentGroupId, source.seriesId);
  const post = scopedLiveCount(
    dataDir,
    { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
    { agentGroupId: target.agentGroupId, sessionId: tgtSessId },
    source.seriesId,
  );
  if (post.unreadable) {
    log.error('scheduled-move: post-move live count UNREADABLE — leaving intent for recovery', {
      seriesId: source.seriesId,
    });
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'post_state_unreadable' }, 503);
  }
  if (post.count !== 1) {
    log.error('scheduled-move: post-move invariant violated — leaving intent for recovery', {
      seriesId: source.seriesId,
      liveCount: post.count,
    });
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'invariant_violated' }, 500);
  }

  // Step 7: resolve the intent (stamp + purge body, F5) + two-sided move audit
  // (one row per side, shared correlation_id) + invalidate cache. Same-agent
  // reroutes intentionally write both directions against the same group.
  await purgeIntentBody(correlationId);
  const secretDetail = { secretGainsCount: (await delta).gains.length, secretLossesCount: (await delta).losses.length };
  await writeAudit({
    actor: ctx.user.id,
    action: 'move',
    agentGroupId: source.agentGroupId,
    sessionId: source.sessionId,
    seriesId: source.seriesId,
    correlationId,
    detail: { direction: 'source', target: target.agentGroupId, ...secretDetail },
  });
  await writeAudit({
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
