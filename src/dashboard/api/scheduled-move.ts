/**
 * Scheduled Tasks Board move flow: `POST .../move/preview` (dry-run wiring + secret delta) and `POST .../move`
 * (cancel-first execute).
 * Move = cancel in source + scheduleTask into target, with a durable move_intent written before the cancel, a
 * preview→execute delta re-check, fail-closed compensation, and an exactly-one-live-row invariant. Both are gated at
 * the mutation tier because preview reveals vault secret NAMES.
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
import { TaskSeriesCollisionError, type TaskDef } from '../../db/scheduled-tasks.js';
import { type TaskRowSnapshot } from '../../modules/scheduling/db.js';
import { countLiveRowsInSessions } from '../../modules/scheduling/live-count.js';
import { log } from '../../log.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import { mergeWorkgroupAndGroupSecrets } from '../../onecli-secrets.js';
import { resolveTaskFlagIntent } from '../../modules/scheduling/task-flags.js';
import { parseTaskPin } from '../../modules/scheduling/task-content.js';
import { verbVerdict, type HealthState } from './scheduled-board-matrix.js';
import type { AuthHandler, AuthedRequestContext } from '../router.js';
import {
  canManageScheduled,
  decodeKey,
  encodeKey,
  invalidateScheduledCache,
  purgeIntentBody,
  rateLimit,
  sessionInboundPathFor,
  writeAudit,
  approvedRowChanged,
} from './scheduled-shared.js';

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
  // Production default MUST be DATA_DIR: a '' default resolves session DBs under <cwd>/v2-sessions and every real
  // move fails the missing-source guard.
  return { dataDir: DATA_DIR, groupsDir: GROUPS_DIR, nowMs: Date.now() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A group's per-group onecliSecrets from container.json, or [] if absent/unparseable; takes an injectable groupsDir.
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
 * Workgroup baseline ∪ per-group onecliSecrets, the same union the host applies at spawn. Names/UUIDs only; values
 * are never resolved host-side and the vault is never listed.
 */
async function effectiveSecrets(agentGroupId: string, folder: string, groupsDir: string): Promise<string[]> {
  const workgroup = await getWorkgroupOnecliSecrets(agentGroupId);
  const group = groupSecretsFromFolder(folder, groupsDir);
  return mergeWorkgroupAndGroupSecrets(workgroup, group);
}

interface SecretDelta {
  gains: string[];
  losses: string[];
  deltaHash: string;
}

/**
 * gains = effective(target) − effective(source), losses the reverse. The deltaHash binds the target identity as well
 * as the sorted delta, so a preview confirmed for one target can never be replayed against another with an identical
 * delta.
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

/**
 * scheduleTask's destination-wiring predicate, run without writing. Fail-closed: an unwired pair would route output
 * to a chat the target agent is not authorized for.
 */
async function isWired(agentGroupId: string, messagingGroupId: string): Promise<boolean> {
  const row = await getDb().get(
    'SELECT 1 AS ok FROM messaging_group_agents WHERE agent_group_id = ? AND messaging_group_id = ?',
    agentGroupId,
    messagingGroupId,
  );
  return !!row;
}

type SourceLiveRow = ScheduledTaskRow;

/**
 * Distinguishes a read that threw (`unreadable`, 503) from no live row (`row: null`, 409 stale_key, never a false
 * 503). A missing inbound.db is `row: null`.
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
    // Read-only seam: a preview must never provision or migrate the session. A locator resolving outside
    // data/v2-sessions reads as "no live row", never as unreadable.
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

interface MoveBody {
  targetAgentGroupId?: string;
  targetMessagingGroupId?: string;
  confirmedDeltaHash?: string;
}

/**
 * HTTP callers carry a scoped dashboard identity; the 0600 host socket is already the operator authentication
 * boundary.
 */
interface MoveAuthorization {
  actor: string;
  hostOperator: boolean;
  scopes?: AuthedRequestContext['scopes'];
}

interface ResolvedMove {
  source: { agentGroupId: string; sessionId: string; seriesId: string; folder: string };
  target: { agentGroupId: string; messagingGroupId: string; folder: string };
}

/**
 * Every failure that could reveal a resource or target to an unauthorized caller returns 404 (never 403): the
 * mutation gate, the source-scope check, and a missing source or target group.
 */
async function resolveAndGate(
  key: string,
  body: MoveBody,
  auth: MoveAuthorization,
): Promise<{ error: Response } | { ok: ResolvedMove }> {
  const decoded = decodeKey(key);
  if (!decoded) return { error: json({ error: 'not_found' }, 404) };

  // Mutation tier because preview reads secret names; 404, never 403.
  if (!auth.hostOperator) {
    if (!(await canManageScheduled(auth.actor))) return { error: json({ error: 'not_found' }, 404) };

    // Scope re-check from the decoded key: the key is never authorization.
    const scopes = auth.scopes;
    if (!scopes || (!scopes.no_filter && !scopes.allowed_group_ids.includes(decoded.agentGroupId))) {
      return { error: json({ error: 'not_found' }, 404) };
    }
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

function dashboardMoveAuthorization(ctx: AuthedRequestContext): MoveAuthorization {
  return { actor: ctx.user.id, hostOperator: false, scopes: ctx.scopes };
}

export const movePreviewHandler: AuthHandler = async (req, params, ctx) => {
  const { groupsDir, dataDir } = moveOpts();
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  const resolved = await resolveAndGate(params['key'] ?? '', body, dashboardMoveAuthorization(ctx));
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

function moveGuardState(status: string, processAfterMs: number | null, nowMs: number): HealthState {
  if (status === 'paused') return 'paused';
  // 'healthy' and 'late' route to the same admission test; 'late' when overdue so the guard's isDue/isNearDue checks
  // reflect reality.
  return processAfterMs !== null && processAfterMs <= nowMs ? 'late' : 'healthy';
}

function taskDefFromSnapshot(
  snapshot: SourceLiveRow,
  seriesId: string,
  targetAgentGroupId: string,
  targetMg: { platform_id: string; channel_type: string },
  targetRowId: string,
): TaskDef {
  let content: { prompt?: string; script?: string; quietStatus?: boolean; flagIntent?: TaskDef['flagIntent'] } = {};
  try {
    content = JSON.parse(snapshot.content) as typeof content;
  } catch {
    /* malformed — fall through with empty content; prompt falls back below */
  }
  return {
    id: targetRowId,
    agentGroupId: targetAgentGroupId,
    cron: snapshot.recurrence ?? '',
    processAfter: snapshot.process_after ?? new Date().toISOString(),
    // The moved row is the SAME occurrence and keeps its slot; otherwise scheduled_for would be stamped from
    // process_after (a staged grace time or a retry deadline).
    ...(snapshot.scheduled_for ? { scheduledFor: snapshot.scheduled_for } : {}),
    seriesId,
    prompt: typeof content.prompt === 'string' ? content.prompt : snapshot.content,
    // Preserves every task control: `scheduleTask` otherwise rebuilds content from a short allow-list and drops
    // controls such as scriptHost, threadAnchor, originSessionId, muteChat and chatLimit.
    rawContent: snapshot.content,
    // Never upsert a target task that carries the same series id; the scheduler re-checks this at its mailbox write
    // boundary to close the competing-writer race.
    rejectExistingLiveSeries: true,
    // A paused source is written paused at the target write itself; a pending insert followed by a pause leaves a
    // crash window where recovery blesses a runnable target.
    ...(snapshot.status === 'paused' ? { status: 'paused' as const } : {}),
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
 * Live rows for the series across exactly {source session, target session}, never a bare series_id fleet scan (an
 * unrelated group reusing the series id would falsify the count). Callers MUST treat `unreadable` as unknown: never
 * restore and never claim success on it.
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

async function targetSessionIdFor(targetAgentGroupId: string, seriesId: string): Promise<string | null> {
  return (await findSystemSession(targetAgentGroupId, taskThreadId(seriesId)))?.id ?? null;
}

async function executeMove(key: string, body: MoveBody, auth: MoveAuthorization): Promise<Response> {
  const { dataDir, groupsDir, nowMs } = moveOpts();
  const resolved = await resolveAndGate(key, body, auth);
  if ('error' in resolved) return resolved.error;
  const { source, target } = resolved.ok;

  const targetMg = await getMessagingGroup(target.messagingGroupId);
  if (!targetMg) return json({ error: 'not_found' }, 404);

  // Containment-checked open (defense in depth; decodeKey already rejects traversal).
  const sourceInbound = sessionInboundPathFor(dataDir, source.agentGroupId, source.sessionId);
  if (!sourceInbound) return json({ error: 'not_found' }, 404);
  if (!fs.existsSync(sourceInbound)) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);

  // Delta re-check: the hash binds the target identity, so a hash confirmed for another target will not match.
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

  // A read THROW (corrupt-but-existent inbound.db) is 503, never collapsed into the 409 for an ended series.
  const sourceRead = readSourceLiveRow(dataDir, source.agentGroupId, source.sessionId, source.seriesId);
  if (sourceRead.unreadable) return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);
  const snapshot = sourceRead.row;
  if (!snapshot) return json({ error: 'stale_key', reason: 'stale_key' }, 409);

  // The destination can use a different provider, so the stored pin is validated before cancelling anything; an
  // unusable pin would create a series that fails unattended.
  const pin = parseTaskPin(snapshot.content);
  const pinCheck = await resolveTaskFlagIntent(
    { model: pin.model ?? undefined, effort: pin.effort ?? undefined },
    { agent_group_id: target.agentGroupId },
  );
  if (pinCheck.error) return json({ error: 'target_pin_invalid', reason: 'target_pin_invalid' }, 409);

  // Fast failure before source cancellation; the scheduler repeats this exclusion inside the target mailbox
  // transaction because another writer can still create the series.
  const existingTargetSession = await targetSessionIdFor(target.agentGroupId, source.seriesId);
  if (
    existingTargetSession &&
    (existingTargetSession !== source.sessionId || target.agentGroupId !== source.agentGroupId)
  ) {
    try {
      const targetLive = await withExistingMailboxSession(target.agentGroupId, existingTargetSession, (mailbox) =>
        mailbox.getLiveTaskRow(source.seriesId),
      );
      if (targetLive) return json({ error: 'target_conflict', reason: 'target_conflict' }, 409);
    } catch {
      // A corrupt target is not an empty target: refuse before cancelling the source.
      return json({ error: 'session_unreadable', reason: 'session_unreadable' }, 503);
    }
  }

  // verbVerdict is the only guard source.
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
  const sourceCancellationReceiptId = `scheduled-move-cancel:${correlationId}`;
  // Durable move ownership, not a series identity: lets compensation and crash recovery tell a target row from THIS
  // move apart from unrelated work sharing the series id.
  const targetRowId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Durable move_intent BEFORE the cancel; correlation_id links the recovery.
  await writeAudit({
    actor: auth.actor,
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
      // The full target locator, so recovery counts live rows across exactly {source, target}.
      target: target.agentGroupId,
      targetAgentGroupId: target.agentGroupId,
      targetMessagingGroupId: target.messagingGroupId,
      targetRowId,
      sourceCancellationReceiptId,
    },
  });

  const restoreSnapshot: TaskRowSnapshot = {
    // FRESH id: the cancelled source row still holds snapshot.id (cancel never deletes), so reusing it would
    // PK-collide. Series identity is carried by series_id.
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    series_id: source.seriesId,
    status: wasPaused ? 'paused' : 'pending',
    process_after: snapshot.process_after,
    // A restore is the SAME occurrence and keeps its slot.
    scheduled_for: snapshot.scheduled_for,
    recurrence: snapshot.recurrence,
    content: snapshot.content,
    platform_id: snapshot.platform_id,
    channel_type: snapshot.channel_type,
    thread_id: snapshot.thread_id,
    kind: snapshot.kind,
  };

  // Cancel BY ROW ID, and only if that row is still exactly what was approved. Acquiring the mailbox yields, and in
  // that window the occurrence can complete and arm a successor or be admitted and fired. A 0-touch result (including
  // a vanished mailbox) aborts BEFORE inserting the target, so a no-op cancel can never leave a target-only series.
  const cancelTouched =
    (await withExistingMailboxSession(source.agentGroupId, source.sessionId, (mailbox) => {
      // Re-prove the approved occurrence inside the session, with nothing awaited between read and write. The id
      // alone is not enough: admission mutates a row in place (a run-now flips `trigger` and moves `process_after`
      // while id and status stay the same).
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
      // Inert, not merely unchanged: a move must not consume an occurrence armed to fire or being fired.
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
      return mailbox.cancelTaskRowWithMoveReceipt(snapshot.id, sourceCancellationReceiptId);
    })) ?? 0;
  if (cancelTouched === 0) {
    // Nothing was cancelled, so the intent has no compensation duty. Resolving it is essential when a concurrent move
    // won the source row: recovery must not mistake the winner's target for a collision and resurrect the source. Do
    // NOT insert into the target.
    log.warn('scheduled-move: cancel touched 0 rows — aborting before target insert', {
      seriesId: source.seriesId,
      rowId: snapshot.id,
    });
    await purgeIntentBody(correlationId);
    invalidateScheduledCache();
    return json({ error: 'stale_key', reason: 'stale_key' }, 409);
  }

  // A paused snapshot is inserted as paused atomically, never runnable in between.
  try {
    await scheduledTasks.scheduleTask(
      taskDefFromSnapshot(snapshot, source.seriesId, target.agentGroupId, targetMg, targetRowId),
    );
  } catch (err) {
    // Target insert failed → restore the source. Most failures need a readable zero across {source, target} first,
    // because a target may have landed before throwing; a TaskSeriesCollisionError proves this move wrote no target
    // row.
    log.warn('scheduled-move: target insert failed — restoring source', {
      seriesId: source.seriesId,
      err: err instanceof Error ? err.message : String(err),
    });
    let restored = false;
    try {
      const sourceLive = scopedLiveCount(
        dataDir,
        { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
        { agentGroupId: target.agentGroupId, sessionId: null },
        source.seriesId,
      );
      const targetLive =
        err instanceof TaskSeriesCollisionError
          ? null
          : scopedLiveCount(
              dataDir,
              { agentGroupId: source.agentGroupId, sessionId: source.sessionId },
              {
                agentGroupId: target.agentGroupId,
                sessionId: await targetSessionIdFor(target.agentGroupId, source.seriesId),
              },
              source.seriesId,
            );
      if (
        !sourceLive.unreadable &&
        sourceLive.count === 0 &&
        (!targetLive || (!targetLive.unreadable && targetLive.count === 0))
      ) {
        restored =
          (await withExistingMailboxSession(source.agentGroupId, source.sessionId, (mailbox) =>
            withCentralSync(() => {
              // A sweep tick during the awaited target insert can mark the source session quiet, hiding the restored
              // row. Invalidate BEFORE the restore, in the same synchronous turn: inbound.db and the central DB share
              // no transaction, so the mark must die first. FAIL-CLOSED: an invalidation error escapes to the catch
              // below, `purgeIntentBody` is skipped, and `recoverMoveIntents` still owns the repair.
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
        actor: auth.actor,
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
    if (err instanceof TaskSeriesCollisionError) {
      return json({ error: 'target_conflict', reason: 'target_conflict' }, 409);
    }
    return json({ error: 'move_failed', reason: 'move_failed' }, 500);
  }

  // Exactly one live row across {source, target}. A violation or an unreadable post-state returns an error and LEAVES
  // the move_intent unresolved for the recovery sweep; never claim success on a state that could not be observed.
  const tgtSessId = await targetSessionIdFor(target.agentGroupId, source.seriesId);
  let targetOwned: boolean;
  try {
    targetOwned = !!(
      tgtSessId &&
      (await withExistingMailboxSession(target.agentGroupId, tgtSessId, (mailbox) =>
        mailbox.getLiveTaskRowById(targetRowId),
      ))
    );
  } catch {
    log.error('scheduled-move: target ownership unreadable — leaving intent for recovery', {
      seriesId: source.seriesId,
      targetRowId,
    });
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'post_state_unreadable' }, 503);
  }
  if (!targetOwned) {
    log.error('scheduled-move: target ownership missing — leaving intent for recovery', {
      seriesId: source.seriesId,
      targetRowId,
    });
    invalidateScheduledCache();
    return json({ error: 'move_failed', reason: 'invariant_violated' }, 500);
  }
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

  // Resolve the intent, write one audit row per side (same-agent reroutes write both against one group), invalidate
  // the cache.
  await purgeIntentBody(correlationId);
  const secretDetail = { secretGainsCount: (await delta).gains.length, secretLossesCount: (await delta).losses.length };
  await writeAudit({
    actor: auth.actor,
    action: 'move',
    agentGroupId: source.agentGroupId,
    sessionId: source.sessionId,
    seriesId: source.seriesId,
    correlationId,
    detail: { direction: 'source', target: target.agentGroupId, ...secretDetail },
  });
  await writeAudit({
    actor: auth.actor,
    action: 'move',
    agentGroupId: target.agentGroupId,
    sessionId: tgtSessId ?? '',
    seriesId: source.seriesId,
    correlationId,
    detail: { direction: 'target', source: source.agentGroupId, ...secretDetail },
  });
  invalidateScheduledCache();

  return json({ moved: true });
}

export const moveExecuteHandler: AuthHandler = async (req, params, ctx) => {
  let body: MoveBody;
  try {
    body = (await req.json()) as MoveBody;
  } catch {
    return json({ error: 'invalid_request' }, 400);
  }

  // Rate limit bounds only interactive dashboard presses; the host socket serializes through its own boundary.
  const rl = rateLimit(ctx.user.id, 'move');
  if (!rl.ok) return json({ error: 'rate_limited', retry_after: rl.retryAfter }, 429);
  return executeMove(params['key'] ?? '', body, dashboardMoveAuthorization(ctx));
};

export interface HostTaskMoveRequest {
  sourceAgentGroupId: string;
  sourceSessionId: string;
  seriesId: string;
  targetAgentGroupId: string;
  targetMessagingGroupId: string;
}

/**
 * Host-operator entry point for the same move transaction. The local ncl socket is authenticated by its 0600
 * filesystem boundary, so no dashboard session is minted. The delta is still bound and rechecked, but names are never
 * returned to the CLI.
 */
export async function moveTaskAsHost(request: HostTaskMoveRequest): Promise<{
  moved: true;
  secretGainsCount: number;
  secretLossesCount: number;
}> {
  const key = encodeKey(request.sourceAgentGroupId, request.sourceSessionId, request.seriesId);
  const body: MoveBody = {
    targetAgentGroupId: request.targetAgentGroupId,
    targetMessagingGroupId: request.targetMessagingGroupId,
  };
  const auth: MoveAuthorization = { actor: 'host', hostOperator: true };
  const resolved = await resolveAndGate(key, body, auth);
  if ('error' in resolved) throw new Error('task move source or target was not found');

  const delta = await computeSecretDelta(
    resolved.ok.source.agentGroupId,
    resolved.ok.source.folder,
    resolved.ok.target.agentGroupId,
    resolved.ok.target.folder,
    resolved.ok.target.messagingGroupId,
    moveOpts().groupsDir,
  );
  body.confirmedDeltaHash = delta.deltaHash;
  const response = await executeMove(key, body, auth);
  const result = (await response.json()) as { moved?: unknown; error?: unknown; reason?: unknown };
  if (response.status !== 200 || result.moved !== true) {
    const reason =
      result.reason === 'target_conflict' || result.reason === 'target_pin_invalid' ? result.reason : 'move_failed';
    throw new Error(`task move failed: ${reason}`);
  }
  return { moved: true, secretGainsCount: delta.gains.length, secretLossesCount: delta.losses.length };
}
