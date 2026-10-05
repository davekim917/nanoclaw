/** The fork's implementation of upstream's agent-mailbox seam. `../../mailbox/` is upstream's and is never edited. */
import type { Database } from 'bun:sqlite';

import { registerAdmissionGate } from '../../admission-gate.js';
import { getConfig } from '../../config.js';
import { getOutboundDb } from '../../mailbox/sqlite/connection.js';
import { inboundMessage as upstreamInboundMessage, SqliteAgentMailbox } from '../../mailbox/sqlite/index.js';
import {
  sqliteMarkCompleted,
  sqliteMarkFailed,
  sqliteMarkProcessing,
  sqliteTimestamp,
} from '../../mailbox/sqlite/operations.js';
import type { InboundMessage, MailboxOperations, MailboxSessionKey, ProcessingStatus } from '../../mailbox/types.js';
import type { MessageInRow } from '../../db/messages-in.js';
import { ensureNanoclawOutboundSchema } from './schema.js';
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
export { setMailboxTestMode } from './test-mode.js';

// Registered here so the fence stays out of poll-loop.ts without patching an upstream barrel.
registerAdmissionGate(repositoryFenceAdmissionGate);

/**
 * Per-turn chat budget for tasks (null = unlimited, 0 = muted, N = at most N new posts). Enforced at this choke
 * point because every send path funnels through writeMessageOut, and instructions demonstrably do not hold.
 * Non-chat kinds, edits and reactions pass through.
 */
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

/**
 * Upstream's inbound record plus fork-only columns: upstream's mapping would drop `scheduled_for`, and
 * mailbox/types.ts is upstream's file.
 */
export interface NanoclawInboundMessage extends InboundMessage {
  /** Which scheduled slot a task occurrence is FOR. NULL on non-task rows. */
  scheduledFor: string | null;
}

function inboundMessage(row: MessageInRow): NanoclawInboundMessage {
  return {
    ...upstreamInboundMessage(row),
    // Through sqliteTimestamp: backfilled rows may carry SQLite's naive shape, which `new Date()` reads as LOCAL time.
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

/** The selection path with bounded-read diagnostics; `getPendingMessages` stays the default. */
export function getPendingMessagesWithDiagnostics(
  isFirstPoll = false,
  diagnostics?: PendingSelectionDiagnostics,
): MessageInRow[] {
  return selectPendingRows(getMaxMessagesPerPrompt(), isFirstPoll, diagnostics);
}

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
  /** Host-visible busy flag read by the idle reapers; the published value is the union of both scopes (container-state.ts). */
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

  /** Adds the fork schema on top of upstream's baseline once per process. `key` stays optional: an older host passes null. */
  override async start(key: MailboxSessionKey | null): Promise<void> {
    await super.start(key);
    ensureNanoclawOutboundSchema(getOutboundDb());
  }

  override getPendingMessages(limit: number, isFirstPoll: boolean): NanoclawInboundMessage[] {
    return selectPendingRows(limit, isFirstPoll).flatMap((row) => {
      const message = parseInboundMessage(row);
      return message ? [message] : [];
    });
  }

  /** `blocked` acks as a failed run like `error`, so the host's recurrence back-off sees the streak. */
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
