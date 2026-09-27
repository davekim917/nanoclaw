/** Fork inbound selection; `limit` arrives through upstream's MailboxOperations.getPendingMessages(limit, …) contract. */
import { getOutboundDb, openInboundDb } from '../../mailbox/sqlite/connection.js';
import { isClearCommand } from '../../formatter.js';
import type { MessageInRow } from '../../db/messages-in.js';

// inbound.db is opened read-only, so an older session DB without on_wake degrades instead of ALTERing.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

// datetime('now') values are UTC without a zone marker, which Date.parse reads as LOCAL: normalize first.
function parseDbUtc(value: string): number {
  let s = value.includes('T') ? value : value.replace(' ', 'T');
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
  return Date.parse(s);
}

export interface PendingSelectionDiagnostics {
  /** Physical inbound rows materialized across the bounded candidate queries. */
  inboundRowsRead: number;
  /** Maximum physical inbound rows those queries can materialize for this call. */
  inboundRowBudget: number;
}

function activeRepositoryMountBarrier(db: ReturnType<typeof openInboundDb>): string | null {
  try {
    const row = db
      .prepare("SELECT epoch, generation FROM repo_ingress_fence WHERE id = 1 AND state = 'active'")
      .get() as { epoch: string; generation: string } | undefined;
    return row ? JSON.stringify([row.epoch, row.generation]) : null;
  } catch (error) {
    // A pre-fence session DB cannot hold an active barrier (the host migrates before publishing one); other read
    // failures stay fail-closed.
    if (error instanceof Error && /no such table: repo_ingress_fence/i.test(error.message)) return null;
    throw error;
  }
}

/** Fresh, host-visible read used at both outer and active-query admission seams. */
export function getActiveRepositoryMountBarrier(): string | null {
  const inbound = openInboundDb();
  try {
    return activeRepositoryMountBarrier(inbound);
  } finally {
    inbound.close();
  }
}

/**
 * The admission gate's boundary read, consumed here to save a second open. Only an ACTIVE token
 * short-circuits: a memoized null still reads, so the memo can hold rows back one tick, never release early.
 */
let tickBarrier: string | null | undefined;

export function setTickRepositoryBarrier(token: string | null): void {
  tickBarrier = token;
}

export function clearTickRepositoryBarrier(): void {
  tickBarrier = undefined;
}

function takeTickRepositoryBarrier(): string | null | undefined {
  const token = tickBarrier;
  tickBarrier = undefined;
  return token;
}

function recallTargetId(m: MessageInRow): string | null {
  if (m.kind !== 'system' || !m.id.startsWith('recall-')) return null;
  try {
    const content = JSON.parse(m.content) as { subtype?: unknown };
    return content.subtype === 'recall_context' ? m.id.slice('recall-'.length) : null;
  } catch {
    return null;
  }
}

/** A host-owned marker keeps its paired delayed/lifecycle turn invisible until due admission replaces it. */
function deferredRecallTargetId(m: MessageInRow): string | null {
  if (m.kind !== 'system' || !m.id.startsWith('recall-')) return null;
  try {
    const content = JSON.parse(m.content) as { subtype?: unknown; deferred?: unknown };
    return content.subtype === 'recall_context' && content.deferred === true ? m.id.slice('recall-'.length) : null;
  } catch {
    return null;
  }
}

/**
 * Keep recall-enabled batches atomic. A real workgroup runtime is always recall-enabled, so every recall-bearing
 * trigger must have its partner (accumulated context, system rows and /clear bear none); a harness batch with no
 * valid pair keeps legacy behavior.
 */
export function retainCompleteRecallUnits(rows: MessageInRow[]): MessageInRow[] {
  const ids = new Set(rows.map((row) => row.id));
  const recallByTarget = new Map<string, string>();
  for (const row of rows) {
    const targetId = recallTargetId(row);
    if (targetId !== null && ids.has(targetId)) recallByTarget.set(targetId, row.id);
  }
  const recallRequired = Boolean(process.env.NANOCLAW_WORKGROUP_ID) || recallByTarget.size > 0;
  if (!recallRequired) return rows.filter((row) => recallTargetId(row) === null);

  return rows.filter((row) => {
    const targetId = recallTargetId(row);
    if (targetId !== null) return ids.has(targetId);
    const requiresRecall =
      row.trigger === 1 &&
      row.kind !== 'system' &&
      !((row.kind === 'chat' || row.kind === 'chat-sdk') && isClearCommand(row));
    return !requiresRecall || recallByTarget.has(row.id);
  });
}

/**
 * Most recent `limit` logical trigger units, chronological, excluding rows acked in outbound.db. A
 * `recall-<X>` row and `<X>` are one unit, so a prompt boundary never splits the pair.
 */
export function selectPendingRows(
  limit: number,
  isFirstPoll: boolean,
  diagnostics?: PendingSelectionDiagnostics,
): MessageInRow[] {
  if (takeTickRepositoryBarrier()) return [];
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    // While the host's fence is active, materialize nothing: the caller must reach the poll-boundary ack first.
    if (activeRepositoryMountBarrier(inbound) !== null) return [];
    const maxUnits = Math.max(1, Math.floor(limit));
    const recentLimit = maxUnits * 4 + 8;
    const wakeLimit = maxUnits + 2;
    // +2: an exact bootstrap lookup, so a cold burst can't strand the once-per-context capability/index pair.
    const inboundRowBudget = 2 * (recentLimit + wakeLimit) + 2;
    if (diagnostics) {
      diagnostics.inboundRowsRead = 0;
      diagnostics.inboundRowBudget = inboundRowBudget;
    }

    const onWakeFilter = hasOnWakeColumn(inbound) && !isFirstPoll ? 'AND on_wake = 0' : '';
    const dueFilter = `
         status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
         ${onWakeFilter}`;
    const recent = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE ${dueFilter}
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(recentLimit) as MessageInRow[];

    // Separately bounded wake window: a long trigger=0 tail must not suppress an older due trigger. More than one
    // row because completed rows can stay pending until the host syncs processing_ack.
    const wakes = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE ${dueFilter}
           AND trigger = 1
           AND kind != 'system'
         ORDER BY seq DESC
         LIMIT ?`,
      )
      .all(wakeLimit) as MessageInRow[];

    const bootstrap = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE ${dueFilter}
           AND kind = 'system'
           AND json_valid(content)
           AND json_extract(content, '$.subtype') = 'recall_context'
           AND json_type(content, '$.trustedCapabilities') = 'object'
         ORDER BY seq DESC
         LIMIT 1`,
      )
      .get() as MessageInRow | undefined;

    if (diagnostics) diagnostics.inboundRowsRead += recent.length + wakes.length + (bootstrap ? 1 : 0);
    if (recent.length === 0 && wakes.length === 0 && !bootstrap) return [];

    const candidateById = new Map<string, MessageInRow>();
    for (const row of [...recent, ...wakes, ...(bootstrap ? [bootstrap] : [])]) candidateById.set(row.id, row);

    // Complete recall pairs split by either window; at most one exact partner per candidate.
    const partnerIds = new Set<string>();
    for (const row of candidateById.values()) {
      const targetId = recallTargetId(row);
      partnerIds.add(targetId ?? `recall-${row.id}`);
    }
    for (const id of candidateById.keys()) partnerIds.delete(id);

    if (partnerIds.size > 0) {
      const placeholders = [...partnerIds].map(() => '?').join(', ');
      const partners = inbound
        .prepare(
          `SELECT * FROM messages_in
           WHERE ${dueFilter}
             AND id IN (${placeholders})
           ORDER BY seq DESC`,
        )
        .all(...partnerIds) as MessageInRow[];
      if (diagnostics) diagnostics.inboundRowsRead += partners.length;
      for (const row of partners) candidateById.set(row.id, row);
    }

    const pending = [...candidateById.values()].sort((a, b) => {
      const bySeq = (b.seq ?? Number.NEGATIVE_INFINITY) - (a.seq ?? Number.NEGATIVE_INFINITY);
      if (bySeq !== 0) return bySeq;
      const byTimestamp = parseDbUtc(b.timestamp) - parseDbUtc(a.timestamp);
      return byTimestamp !== 0 ? byTimestamp : b.id.localeCompare(a.id);
    });
    // Hide a due deferred wake and its marker until the host sweep replaces the marker with fresh recall, so no
    // admission path claims it as ordinary context. Seeing either half identifies the pair.
    const deferredTargetIds = new Set(pending.map(deferredRecallTargetId).filter((id): id is string => id !== null));
    const visiblePending = pending.filter(
      (row) => deferredRecallTargetId(row) === null && !deferredTargetIds.has(row.id),
    );
    if (visiblePending.length === 0) return [];

    const candidateIds = visiblePending.map((row) => row.id);
    const candidatePlaceholders = candidateIds.map(() => '?').join(', ');

    const ackedAt = new Map(
      (
        outbound
          .prepare(
            `SELECT message_id, status_changed
               FROM processing_ack
              WHERE message_id IN (${candidatePlaceholders})`,
          )
          .all(...candidateIds) as Array<{ message_id: string; status_changed: string }>
      ).map((row) => [row.message_id, parseDbUtc(row.status_changed)] as const),
    );

    // Idempotency: a row with a real response in messages_out is handled even if processing_ack was lost. Progress
    // rows are not answers. A reply counts only if written at/after the row became due (process_after): a task's
    // output must not "answer" a sibling's not-yet-due fire row and stall that series.
    const respondedAt = new Map<string, number>();
    for (const r of outbound
      .prepare(
        `SELECT in_reply_to AS id, MAX(timestamp) AS ts
         FROM messages_out
         WHERE in_reply_to IS NOT NULL
           AND kind != 'status'
           AND in_reply_to IN (${candidatePlaceholders})
         GROUP BY in_reply_to`,
      )
      .all(...candidateIds) as Array<{ id: string; ts: string }>) {
      respondedAt.set(r.id, parseDbUtc(r.ts));
    }
    const pendingById = new Map(visiblePending.map((m) => [m.id, m]));
    const isAcked = (id: string): boolean => {
      const ts = ackedAt.get(id);
      if (ts === undefined) return false;
      const row = pendingById.get(id);
      if (!row || row.process_after == null) return true;
      // Admission may recycle recall-<X> after a backoff or task edit. An ack
      // from before the new due boundary belongs to the prior generation.
      return ts >= parseDbUtc(row.process_after);
    };
    const isResponded = (id: string): boolean => {
      const ts = respondedAt.get(id);
      if (ts === undefined) return false;
      const row = pendingById.get(id);
      if (!row || row.process_after == null) return true;
      return ts >= parseDbUtc(row.process_after);
    };

    // Drop completed rows, then keep a recall row only when its target is in the same eligible snapshot: an orphan
    // `recall-<X>` (e.g. X was /clear) would otherwise become a standalone prompt or stay pending forever.
    const eligible = visiblePending.filter((m) => !isAcked(m.id) && !isResponded(m.id));
    const paired = retainCompleteRecallUnits(eligible);

    const unitKey = (m: MessageInRow): string => recallTargetId(m) ?? m.id;
    const selectedKeys: string[] = [];
    const selectedSet = new Set<string>();
    const protectedKeys = new Set<string>();
    const evictOldestUnprotected = (): void => {
      for (let index = selectedKeys.length - 1; index >= 0; index--) {
        const candidate = selectedKeys[index]!;
        if (protectedKeys.has(candidate)) continue;
        selectedKeys.splice(index, 1);
        selectedSet.delete(candidate);
        return;
      }
    };

    // Rows are DESC. Select newest logical units, not newest physical rows.
    for (const row of paired) {
      const key = unitKey(row);
      if (selectedSet.has(key)) continue;
      if (selectedKeys.length >= maxUnits) break;
      selectedKeys.push(key);
      selectedSet.add(key);
    }

    // Always retain the once-per-context bootstrap unit, even past the unit limit.
    const bootstrapRow = paired.find((row) => {
      if (row.kind !== 'system') return false;
      try {
        const content = JSON.parse(row.content) as Record<string, unknown>;
        return content.subtype === 'recall_context' && Object.hasOwn(content, 'trustedCapabilities');
      } catch {
        return false;
      }
    });
    if (bootstrapRow) {
      const bootstrapKey = unitKey(bootstrapRow);
      if (!selectedSet.has(bootstrapKey)) {
        if (selectedKeys.length >= maxUnits) evictOldestUnprotected();
        selectedKeys.push(bootstrapKey);
        selectedSet.add(bootstrapKey);
      }
      protectedKeys.add(bootstrapKey);
    }

    // Keep one real wake unit whenever the snapshot has one: trigger=0 context must not hide a due row.
    if (!paired.some((m) => selectedSet.has(unitKey(m)) && m.trigger === 1 && m.kind !== 'system')) {
      const newestWake = paired.find((m) => m.trigger === 1 && m.kind !== 'system');
      if (newestWake) {
        if (selectedKeys.length >= maxUnits) evictOldestUnprotected();
        selectedKeys.push(unitKey(newestWake));
        selectedSet.add(unitKey(newestWake));
      }
    }

    // Reverse the selected DESC rows so the prompt remains chronological.
    return paired.filter((m) => selectedSet.has(unitKey(m))).reverse();
  } finally {
    inbound.close();
  }
}

export type TurnTrigger = 'human' | 'agent' | 'scheduled' | 'continuation' | 'on_wake' | 'ceiling_respawn' | 'unknown';

const CEILING_RESPAWN_ID_PREFIX = 'ceiling-respawn-';

/**
 * Host-authored notices are marked by `senderId: 'system'`, not channel_type: genuine agent-to-agent messages
 * also carry channel_type='agent'.
 */
function isSystemAuthored(m: MessageInRow): boolean {
  try {
    const parsed = JSON.parse(m.content) as { senderId?: unknown; sender?: unknown };
    return parsed.senderId === 'system' || parsed.sender === 'system';
  } catch {
    return false;
  }
}

/**
 * `ceiling_respawn` has its own bucket (recovery turns cost differently); other host notices collapse into
 * `on_wake`. `continuation` is hardcoded by poll-loop.ts, which has no representative row.
 */
export function classifyTrigger(rows: MessageInRow[]): TurnTrigger {
  if (rows.some(isSystemAuthored)) {
    return rows.some((m) => m.id.startsWith(CEILING_RESPAWN_ID_PREFIX)) ? 'ceiling_respawn' : 'on_wake';
  }
  if (rows.some((m) => m.channel_type === 'agent')) return 'agent';
  if (rows.some((m) => m.kind === 'task')) return 'scheduled';
  if (rows.some((m) => m.kind === 'chat' || m.kind === 'chat-sdk')) return 'human';
  return 'unknown';
}

/** Return an admitted batch to pending without completing it, so a post-fence container retries it. */
export function releaseProcessingClaims(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'processing'");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}
