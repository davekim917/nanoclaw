/**
 * NanoclawAgentMailbox — the fork's implementation of upstream's agent-mailbox
 * seam. See README.md; `../../mailbox/` is upstream's and is never edited.
 *
 * Every fork-only session-DB operation is exported from here under the name it
 * had in db/*.ts, so the 25 caller files changed import paths and nothing else.
 * The class exposes the same operations through `operations` for callers that
 * hold the mailbox rather than the module.
 */
import type { Database } from 'bun:sqlite';

import { registerAdmissionGate } from '../../admission-gate.js';
import { getConfig } from '../../config.js';
import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { SqliteAgentMailbox } from '../../mailbox/sqlite/index.js';
import {
  sqliteMarkCompleted,
  sqliteMarkFailed,
  sqliteMarkProcessing,
  sqliteTimestamp,
} from '../../mailbox/sqlite/operations.js';
import { parseInboundRecord } from '../../mailbox/model.generated.js';
import type { InboundMessage, MailboxOperations, MailboxSessionKey, ProcessingStatus } from '../../mailbox/types.js';
import type { MessageInRow } from '../../db/messages-in.js';
import { ensureNanoclawOutboundSchema, prepareOutboundFile } from './schema.js';
import {
  classifyTrigger,
  getActiveRepositoryMountBarrier,
  releaseProcessingClaims,
  retainCompleteRecallUnits,
  selectPendingRows,
  type PendingSelectionDiagnostics,
} from './selection.js';
import {
  beginProviderBusyScope,
  clearProviderHealthState,
  clearStaleProcessingAcks,
  endProviderBusyScope,
  resetProviderExecuting,
  setProviderHealthState,
  setProviderTurnExecuting,
  writeResourceTelemetry,
  type ProviderHealthState,
} from './container-state.js';
import { getSessionId, getSessionSpawnTaskId } from './routing.js';
import { getTurnUsageRows, recordTurnUsage, type TurnMeta, type TurnUsageRow } from './turn-usage.js';
import {
  getRateLimitSampleRows,
  recordRateLimitSamples,
  type RateLimitSample,
  type RateLimitSampleRow,
} from './rate-limit-samples.js';
import { acknowledgeRepositoryMountBarrier } from './session-state.js';
import { repositoryFenceAdmissionGate } from './admission.js';
import { isMailboxTestMode } from './test-mode.js';

export * from './admission.js';
export * from './schema.js';
export * from './selection.js';
export * from './container-state.js';
export * from './routing.js';
export * from './reads.js';
export * from './session-state.js';
export * from './turn-usage.js';
export * from './rate-limit-samples.js';
export * from './wiki-lint.js';
export { isMailboxTestMode, setMailboxTestMode } from './test-mode.js';
export { INBOUND_KINDS, type InboundKind } from './inbound-kinds.js';

/* ─── Admission ────────────────────────────────────────────────────────────── */

// The one runner lifecycle seam the storage seam cannot express (plan §4.5).
// Registering here — the module the singular composition slot already imports —
// keeps the fence out of poll-loop.ts without patching any upstream barrel.
registerAdmissionGate(repositoryFenceAdmissionGate);

/* ─── Chat budget ──────────────────────────────────────────────────────────── */

/**
 * Chat mute — physical send suppression for tasks created with muteChat
 * (e.g. a watcher task whose contract is "never post"). Set per-turn by the
 * poll loop from the task row's content; when active, chat-kind writes are
 * dropped at this choke point — every send path (final <message> blocks,
 * send_message MCP tool) funnels through the mailbox's writeMessageOut, so no
 * instruction drift can reach the channel. Non-chat kinds (system actions,
 * processing acks) pass through untouched.
 */
// null = unlimited; 0 = fully muted; N>0 = at most N new chat posts this turn
// (e.g. a standup task whose contract is ONE digest post — the trailing
// "summary for the work log" message gets dropped here instead of relying
// on instructions, which demonstrably do not hold).
// Edits and reactions (content carries an `operation` field) are exempt: the
// budget caps how many messages land in the channel, and amending an
// already-sent message is the sanctioned way to add essential detail after
// the budget is spent.
let chatBudget: number | null = null;
let chatLimitInitial: number | null = null;

export function setChatMute(muted: boolean): void {
  setChatLimit(muted ? 0 : null);
}

export function setChatLimit(limit: number | null): void {
  chatBudget = limit;
  chatLimitInitial = limit;
}

export function isChatMuted(): boolean {
  return chatLimitInitial === 0;
}

export function chatBudgetExhausted(): boolean {
  return chatBudget !== null && chatBudget <= 0;
}

/** Returns false when the budget swallows this write. */
function admitChatWrite(id: string, kind: string, content: string): boolean {
  if (kind !== 'chat' || chatBudget === null) return true;
  let operation: string | undefined;
  try {
    operation = (JSON.parse(content) as { operation?: string }).operation;
  } catch {
    // non-JSON content — treat as a new post
  }
  if (operation) return true;
  if (chatBudget <= 0) {
    console.error(`[messages-out] chat budget exhausted for this task — dropped outbound message ${id}`);
    return false;
  }
  chatBudget -= 1;
  return true;
}

/* ─── Inbound record mapping ───────────────────────────────────────────────── */

// Mirrors upstream's private inboundMessage()/parseInboundMessage() in
// mailbox/sqlite/index.ts — the fork's selection returns rows, so the same
// row→record mapping (and the same skip-and-log on a row that fails the
// canonical parse) has to run here. M-1 (inbound-kinds.ts) proved the fork
// writes only upstream's five kinds, so upstream's parser is sufficient.
/**
 * Upstream's inbound record plus the fork-only columns it does not model.
 *
 * `scheduled_for` is the host's; upstream's `InboundRecord` has no field for
 * it and `mailbox/types.ts` is upstream's file, so the value would be dropped
 * by the row→record mapping below and never reach the formatter. Carried here
 * instead, and read back in `db/messages-in.ts`'s `messageRow`.
 */
export interface NanoclawInboundMessage extends InboundMessage {
  /** Which scheduled slot a task occurrence is FOR. NULL on non-task rows. */
  scheduledFor: string | null;
}

function inboundMessage(row: MessageInRow): NanoclawInboundMessage {
  const record = parseInboundRecord({
    id: row.id,
    sequence: row.seq,
    kind: row.kind,
    timestamp: sqliteTimestamp(row.timestamp),
    status: row.status,
    processAfter: row.process_after === null ? null : sqliteTimestamp(row.process_after),
    recurrence: row.recurrence,
    seriesId: row.series_id ?? null,
    tries: row.tries,
    trigger: row.trigger === 1,
    platformId: row.platform_id,
    channelType: row.channel_type,
    threadId: row.thread_id,
    content: row.content,
    sourceSessionId: row.source_session_id ?? null,
    onWake: row.on_wake === 1,
  });
  return {
    ...record,
    // Through sqliteTimestamp for the same reason `process_after` is: the
    // host's one-time backfill copies `process_after` verbatim, so a row
    // migrated on an install whose older writers used SQLite's naive
    // `YYYY-MM-DD HH:MM:SS` shape carries that shape here. `new Date()` reads
    // it as LOCAL time, which would shift the announced slot by the install's
    // offset and, near midnight, onto the wrong day.
    scheduledFor: row.scheduled_for == null ? null : sqliteTimestamp(row.scheduled_for),
  };
}

function parseInboundMessage(row: MessageInRow): NanoclawInboundMessage | undefined {
  try {
    return inboundMessage(row);
  } catch (error) {
    console.error(`[agent-runner] Skipping invalid inbound mailbox row ${row.id}: ${String(error)}`);
    return undefined;
  }
}

/** Cap on how many messages reach the agent in one prompt (container.json). */
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

/**
 * The selection path for callers that want the bounded-read diagnostics.
 * `db/messages-in.ts`'s compat `getPendingMessages(isFirstPoll)` remains the
 * default path and goes through the mailbox.
 */
export function getPendingMessagesWithDiagnostics(
  isFirstPoll = false,
  diagnostics?: PendingSelectionDiagnostics,
): MessageInRow[] {
  return selectPendingRows(getMaxMessagesPerPrompt(), isFirstPoll, diagnostics);
}

/* ─── The mailbox ──────────────────────────────────────────────────────────── */

export interface NanoclawMailboxOperations extends MailboxOperations {
  /** JSON `[epoch, generation]` while the host holds a repository ingress fence. */
  getActiveRepositoryMountBarrier(): string | null;
  acknowledgeRepositoryMountBarrier(epoch: string): void;
  releaseProcessingClaims(ids: string[]): void;
  retainCompleteRecallUnits(rows: MessageInRow[]): MessageInRow[];
  classifyTrigger(rows: MessageInRow[]): ReturnType<typeof classifyTrigger>;
  getSessionSpawnTaskId(): string | null;
  getSessionId(): string | null;
  setProviderHealthState(state: ProviderHealthState, outbound?: Database): void;
  clearProviderHealthState(outbound?: Database): void;
  /**
   * The host-visible "busy right now" flag (`container_state.provider_executing`),
   * read by the sweep's idle reapers. The turn level and the bracketed windows
   * are separate scopes whose union is published — see container-state.ts.
   */
  setProviderTurnExecuting(executing: boolean, outbound?: Database): void;
  beginProviderBusyScope(outbound?: Database): void;
  endProviderBusyScope(outbound?: Database): void;
  resetProviderExecuting(outbound?: Database): void;
  writeResourceTelemetry(snapshot: Parameters<typeof writeResourceTelemetry>[0], outbound?: Database): void;
  /** Per-turn token/cost accounting (outbound `turn_usage`). Never throws. */
  recordTurnUsage(
    provider: string,
    usage?: Parameters<typeof recordTurnUsage>[1],
    meta?: TurnMeta,
    scope?: string,
  ): void;
  getTurnUsageRows(): TurnUsageRow[];
  /** Account-level rate-limit utilization samples (outbound `rate_limit_samples`). Never throws. */
  recordRateLimitSamples(samples: RateLimitSample[]): void;
  getRateLimitSampleRows(): RateLimitSampleRow[];
}

export class NanoclawAgentMailbox extends SqliteAgentMailbox {
  override readonly operations: NanoclawMailboxOperations = this;

  /**
   * Upstream's start() is a no-op; the fork's adds the schema this install's
   * tables need on top of upstream's baseline, once per process, on the
   * outbound singleton. `key` stays optional (I-1): a host that predates the
   * seam writes no context file and passes null.
   */
  override async start(key: MailboxSessionKey | null): Promise<void> {
    await super.start(key);
    if (!isMailboxTestMode()) prepareOutboundFile();
    ensureNanoclawOutboundSchema(getOutboundDb());
  }

  override getPendingMessages(limit: number, isFirstPoll: boolean): NanoclawInboundMessage[] {
    return selectPendingRows(limit, isFirstPoll).flatMap((row) => {
      const message = parseInboundMessage(row);
      return message ? [message] : [];
    });
  }

  /**
   * `blocked` (a destructive pre-task script the classifier refused) acks as a
   * failed run exactly like `error`, so the host's recurrence back-off sees the
   * failed streak. Upstream maps only `error`.
   */
  override markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
    if (skips.length === 0) return;
    const db = getOutboundDb();
    const stmt = db.prepare(
      'INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (const s of skips)
        stmt.run(
          s.id,
          s.reason === 'error' || s.reason === 'blocked' ? 'script-skip:error' : 'completed',
          new Date().toISOString(),
        );
    })();
  }

  override markMessages(ids: string[], status: ProcessingStatus): void {
    if (status === 'processing') sqliteMarkProcessing(ids);
    else if (status === 'completed') sqliteMarkCompleted(ids);
    else if (status === 'failed') ids.forEach(sqliteMarkFailed);
    else this.markScriptSkipped(ids.map((id) => ({ id, reason: 'error' })));
  }

  /** Applies the per-turn chat budget before upstream's insert. */
  override async writeMessageOut(message: Parameters<MailboxOperations['writeMessageOut']>[0]): Promise<number> {
    if (!admitChatWrite(message.id, message.kind, message.content)) return -1;
    return super.writeMessageOut(message);
  }

  // Upstream declares these two as instance FIELDS, so a prototype method here
  // would be shadowed by the base constructor's assignment — override as fields.
  override clearStaleProcessingAcks = clearStaleProcessingAcks;

  getActiveRepositoryMountBarrier = getActiveRepositoryMountBarrier;
  acknowledgeRepositoryMountBarrier = acknowledgeRepositoryMountBarrier;
  releaseProcessingClaims = releaseProcessingClaims;
  retainCompleteRecallUnits = retainCompleteRecallUnits;
  classifyTrigger = classifyTrigger;
  getSessionSpawnTaskId = getSessionSpawnTaskId;
  getSessionId = getSessionId;
  setProviderHealthState = setProviderHealthState;
  clearProviderHealthState = clearProviderHealthState;
  setProviderTurnExecuting = setProviderTurnExecuting;
  beginProviderBusyScope = beginProviderBusyScope;
  endProviderBusyScope = endProviderBusyScope;
  resetProviderExecuting = resetProviderExecuting;
  writeResourceTelemetry = writeResourceTelemetry;
  recordTurnUsage = recordTurnUsage;
  getTurnUsageRows = getTurnUsageRows;
  recordRateLimitSamples = recordRateLimitSamples;
  getRateLimitSampleRows = getRateLimitSampleRows;
}
