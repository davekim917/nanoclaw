/**
 * Fork inbound selection — the two-window bounded pending query, recall-unit
 * atomicity, ack/response idempotency and the repository-fence gate.
 *
 * Moved verbatim from db/messages-in.ts, which is now upstream's thin compat
 * shim. `limit` replaces the internal maxMessagesPerPrompt read so the value
 * arrives through upstream's MailboxOperations.getPendingMessages(limit, …)
 * contract; the compat shim passes exactly the same number.
 */
import { getOutboundDb, openInboundDb } from '../../mailbox/sqlite/connection.js';
import { isClearCommand } from '../../formatter.js';
import type { MessageInRow } from '../../db/messages-in.js';

// Cache whether inbound.db has the on_wake column (added in v2.0.48).
// The container opens inbound.db read-only, so it can't ALTER —
// gracefully degrade when running against an older session DB.
let _hasOnWake: boolean | null = null;
function hasOnWakeColumn(db: ReturnType<typeof openInboundDb>): boolean {
  if (_hasOnWake !== null) return _hasOnWake;
  const cols = new Set(
    (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name),
  );
  _hasOnWake = cols.has('on_wake');
  return _hasOnWake;
}

// Parse the two timestamp shapes that live in the session DBs into epoch ms.
// SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' — UTC but with no
// zone marker, which Date.parse would read as LOCAL time. scheduleTask writes
// ISO 'YYYY-MM-DDTHH:MM:SS.SSSZ'. Normalize to explicit-UTC before parsing.
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
    // A pre-fence session DB cannot contain an active barrier. The host's
    // activation path migrates the DB before publishing one, so every real
    // barrier is visible here. Other read failures remain fail-closed.
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
 * The token the admission gate read at this poll tick's boundary
 * (`modules/mailbox/admission.ts`), consumed by the selection below so a fenced
 * poll opens `inbound.db` once instead of twice.
 *
 * Only an ACTIVE token short-circuits. A memoized `null` still lets the
 * selection do its own read, so a fence that commits between the boundary and
 * the selection is still seen — the memo can only hold rows back for one extra
 * tick, never release them early. `initTestSessionDb()` clears it.
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
 * Keep recall-enabled batches atomic in both cold-start and in-turn paths.
 *
 * A standalone harness or pre-workgroup batch with no valid recall pair keeps
 * its legacy trigger behavior. A real workgroup runtime is always
 * recall-enabled (NANOCLAW_WORKGROUP_ID is trusted host configuration), so
 * every admissible trigger must have its own recall partner even when the
 * entire observed batch is damaged. Accumulated context and /clear are not
 * recall-bearing triggers.
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
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 *
 * Returns the most recent `limit` logical trigger units in chronological
 * order. A host-injected `recall-<X>` row and its target `<X>` are one unit,
 * so a prompt boundary can never split the pair. Accumulated context
 * (trigger=0) still rides along with wake-eligible rows. Host's
 * countDueMessages gates waking on trigger=1 separately (see
 * src/db/session-db.ts).
 */
export function selectPendingRows(
  limit: number,
  isFirstPoll: boolean,
  diagnostics?: PendingSelectionDiagnostics,
): MessageInRow[] {
  // The admission gate already read the fence at this tick's boundary — an
  // active token short-circuits before the open (see setTickRepositoryBarrier).
  if (takeTickRepositoryBarrier()) return [];
  const inbound = openInboundDb();
  const outbound = getOutboundDb();

  try {
    // Host publication/transfer activates this fence before quiescence. Do
    // not even materialize accumulated trigger=0 context while it is active:
    // the caller must reach the explicit poll-boundary acknowledgement first.
    if (activeRepositoryMountBarrier(inbound) !== null) return [];
    const maxUnits = Math.max(1, Math.floor(limit));
    const recentLimit = maxUnits * 4 + 8;
    const wakeLimit = maxUnits + 2;
    // One extra exact bootstrap lookup ensures a cold burst larger than the
    // prompt limit cannot strand the only once-per-context capability/index
    // pair outside the recent window. Its target is covered by the bounded
    // partner query below.
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

    // A long trigger=0 tail can fill the recent window while an older task or
    // mention is the row that actually woke the container. Fetch a separately
    // bounded wake window so that tail cannot suppress every due trigger.
    // More than one row is intentional: recently completed rows can remain
    // pending in inbound.db until the host syncs processing_ack.
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

    // Complete any recall pair split by either bounded window. Each candidate
    // requests at most one exact partner id, so this query can materialize no
    // more rows than the two initial windows combined.
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
    // Deferred host wakes are stored as trigger=0 chat plus a paired marker.
    // Once due, a concurrent real inbound can wake a warm/fresh container
    // before the host sweep replaces that marker with fresh recall. Hide both
    // rows here so neither outer-turn nor in-turn admission can claim the wake
    // as ordinary accumulated context. The exact-partner query above ensures
    // that seeing either half is enough to identify and remove the full pair.
    const deferredTargetIds = new Set(pending.map(deferredRecallTargetId).filter((id): id is string => id !== null));
    const visiblePending = pending.filter(
      (row) => deferredRecallTargetId(row) === null && !deferredTargetIds.has(row.id),
    );
    if (visiblePending.length === 0) return [];

    const candidateIds = visiblePending.map((row) => row.id);
    const candidatePlaceholders = candidateIds.map(() => '?').join(', ');

    // Filter out messages already acknowledged in outbound.db
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

    // Idempotency guard: a message that already has a real response in
    // messages_out has been handled — even if processing_ack was wiped by
    // clearStaleProcessingAcks or messages_in.status never got synced to
    // 'completed' because the previous container died between writing
    // messages_out and calling markCompleted. Progress/status rows are not
    // answers; a restart after a thinking update must still retry the input.
    //
    // Due-aware refinement (2026-06-10): a reply can never precede its
    // question. resolveDestinationThread used to stamp destination sends with
    // in_reply_to = the NEWEST inbound row of the channel, so a task turn's
    // output could claim to "answer" a sibling task's future, not-yet-due
    // fire row — permanently suppressing that series (the row stays pending,
    // recurrence never advances). Only honor a reply as the answer to a row
    // if it was written at/after the row became due (process_after). Rows
    // without process_after (chat) keep the original any-reply semantics.
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

    // Orphan recall_context drain: a `recall-<X>` row is paired to inbound
    // row `<X>` by the host's recall-injection (it strips the prefix to
    // pair). When `<X>` finishes (status='completed' in processing_ack, or
    // a messages_out row exists) but `recall-<X>` was never claimed —
    // happens when X is a /clear command (handled+completed inline at
    // poll-loop.ts:148) or a task gated by pre-task script — the orphan
    // recall sits pending. Without this filter, the cold-start path's
    // accept-any-recall_context filter would later turn the orphan into a
    // standalone structured recall payload with no user message; the in-turn
    // helper drops it but it stays pending forever and gets
    // re-evaluated every poll. Drop it here so both paths see a clean view.
    // First remove completed rows, then retain a recall row only when its
    // target is also present in the same eligible snapshot. This drains
    // completed-trigger orphans and also prevents a recall for a not-yet-due
    // target from being promoted into a standalone prompt.
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

    // The host emits the full capabilities/index bootstrap once per provider
    // context. Retain that logical unit even when a cold burst exceeds the
    // normal newest-unit limit; otherwise the first provider prompt could be
    // fresh but under-informed.
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

    // A large tail of trigger=0 context must not hide an older row that just
    // became due. Keep one real wake unit in the bounded selection whenever
    // the eligible snapshot contains one.
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
 * Host-authored notices (ceiling-kill accountability, host-restart warnings,
 * provider-heal, self-mod on_wake, create-agent notices — see
 * src/host-sweep.ts, src/host-restart-warn.ts, src/modules/self-mod/apply.ts,
 * src/modules/agent-to-agent/create-agent.ts) all share one content
 * convention: `senderId: 'system'` (src/caller-identity.ts documents the
 * same marker for the same reason). That convention, not channel_type, is
 * the real signal — a genuine agent-to-agent message (agent-route.ts) is
 * ALSO written with channel_type='agent', since that's how the host marks
 * "this row is agent-routed, not from a real external channel" for both
 * cases. Checking channel_type first would misclassify every host notice as
 * `agent`.
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
 * Classify what caused a turn, from the batch of MessageInRow about to reach
 * the provider. `ceiling_respawn` gets its own bucket (not folded into
 * `on_wake`) because those turns are dominated by "recover from a mid-work
 * kill" rather than ordinary work — the two have different cost shapes.
 * Every other host notice (host-restart, provider-heal, self-mod, create-agent)
 * collapses into `on_wake`: nothing here distinguishes them further, and
 * guessing a split the data can't support would be worse than merging.
 * `continuation` (a durable `continue_work` resume) is NOT classified here:
 * that call site has no representative inbound row to classify (the resumed
 * task's original trigger predates this turn), so poll-loop.ts hardcodes it.
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

/**
 * Return an admitted batch to pending ownership without completing it.
 * Used when a host repository fence becomes visible between a failed provider
 * turn and an in-turn recovery: the fresh post-transition container must retry
 * the original inbound instead of losing it or deadlocking on a stale claim.
 */
export function releaseProcessingClaims(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare("DELETE FROM processing_ack WHERE message_id = ? AND status = 'processing'");
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}
